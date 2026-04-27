// Copyright Optimum Athena. All Rights Reserved.
#include "EditorUtilityHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "EditorAssetLibrary.h"
#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "EditorUtilityBlueprint.h"
#include "EditorUtilityWidgetBlueprint.h"
#include "IPythonScriptPlugin.h"
#include "Logging/LogMacros.h"
#include "Misc/PackageName.h"
#include "Misc/Paths.h"
#include "Misc/SecureHash.h"
#include "Modules/ModuleManager.h"
#include "UObject/Class.h"
#include "UObject/Package.h"
#include "UObject/UObjectGlobals.h"
#include "UObject/UnrealType.h"

// LogUEMCPSecurity is the audit-trail channel for security-sensitive editor-utility
// operations (Python execution + asset deletion). Defaults to Warning verbosity so
// the audit trail lands prominently in <ProjectName>.log without needing a custom
// engine.ini -LogCmds= override; grep `[UEMCP-PYTHON-EXEC]` or `[UEMCP-DELETE-ASSET]`
// to extract the audit stream post-session.
DEFINE_LOG_CATEGORY_STATIC(LogUEMCPSecurity, Log, All);

namespace UEMCP
{
	namespace
	{
		// ── Deny-list (D14 — D101 (iv) accepted run_python_command security model) ─
		//
		// Simple FString::Contains() per pattern, intentionally NOT regex.
		// Defense-in-depth tolerates false positives ("import os" inside a string
		// literal trips the deny-list); regex matching to avoid false positives
		// inevitably misses something — wrong direction.
		//
		// To extend: add to the array. Each entry is the literal substring to scan
		// for. The matched pattern is included verbatim in the typed error response
		// so callers can branch on which rule fired.
		struct FPythonDenyEntry
		{
			const TCHAR* Pattern;
			const TCHAR* Rationale;  // For documentation only — not surfaced to wire
		};

		static const FPythonDenyEntry kPythonDenyList[] =
		{
			{ TEXT("import os"),         TEXT("Filesystem manipulation outside project boundaries") },
			{ TEXT("import subprocess"), TEXT("Shell-out and arbitrary process spawning") },
			{ TEXT("__import__"),        TEXT("Dynamic import bypass for the import-os/subprocess block above") },
			{ TEXT("eval("),             TEXT("Nested arbitrary expression evaluation") },
			{ TEXT("exec("),             TEXT("Nested arbitrary statement execution") },
			{ TEXT("open("),             TEXT("Direct file write — could clobber engine paths or exfiltrate") },
		};

		/** Returns matched pattern as FString if any deny-list entry hit; empty FString if clean. */
		FString MatchPythonDenyList(const FString& Script)
		{
			for (const FPythonDenyEntry& Entry : kPythonDenyList)
			{
				if (Script.Contains(Entry.Pattern, ESearchCase::CaseSensitive))
				{
					return FString(Entry.Pattern);
				}
			}
			return FString();
		}

		/** SHA1 hash of a string, hex-encoded first 8 bytes — for audit log fingerprinting. */
		FString ShortHash(const FString& Source)
		{
			FSHA1 Hasher;
			FTCHARToUTF8 Utf8(*Source);
			Hasher.Update(reinterpret_cast<const uint8*>(Utf8.Get()), Utf8.Length());
			Hasher.Final();
			uint8 Bytes[20];
			Hasher.GetHash(Bytes);
			return BytesToHex(Bytes, 8);
		}

		/** First N chars of a script, with newlines/tabs replaced — for one-line log preview. */
		FString PreviewForLog(const FString& Script, int32 MaxChars = 100)
		{
			FString Trimmed = Script.Left(MaxChars);
			Trimmed.ReplaceInline(TEXT("\r\n"), TEXT("\\n"));
			Trimmed.ReplaceInline(TEXT("\n"),   TEXT("\\n"));
			Trimmed.ReplaceInline(TEXT("\r"),   TEXT("\\n"));
			Trimmed.ReplaceInline(TEXT("\t"),   TEXT("\\t"));
			if (Script.Len() > MaxChars)
			{
				Trimmed += TEXT("...");
			}
			return Trimmed;
		}

		// ── Asset path helpers (oracle-parity package-name normalization) ─────────

		/** Strip object suffix from a /Game/Foo/Bar.Bar-style path → /Game/Foo/Bar. */
		FString PackageNameOnly(const FString& AssetPath)
		{
			FString PackageName = AssetPath;
			int32 DotIdx;
			if (PackageName.FindChar('.', DotIdx))
			{
				PackageName.LeftInline(DotIdx);
			}
			return PackageName;
		}

		/** Default trash-folder destination for a soft-deleted asset. */
		FString TrashPathFor(const FString& AssetPath)
		{
			const FString PackageName = PackageNameOnly(AssetPath);
			const FString BaseName = FPaths::GetBaseFilename(PackageName);
			// Suffix with the short hash so repeat soft-deletes of the same asset
			// don't collide in /Game/_Deleted/ and silently overwrite the prior copy.
			return FString::Printf(TEXT("/Game/_Deleted/%s_%s"), *BaseName, *ShortHash(PackageName));
		}

		// ═══════════════════════════════════════════════════════════════════════
		// run_python_command  (defense-in-depth: PYTHON_PLUGIN_NOT_AVAILABLE →
		//                     PYTHON_EXEC_DENY_LIST → execute + audit log)
		// ═══════════════════════════════════════════════════════════════════════

		void HandleRunPythonCommand(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("run_python_command requires params.command"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Script;
			if (!Params->TryGetStringField(TEXT("command"), Script) || Script.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("run_python_command requires non-empty command"), TEXT("MISSING_PARAMS"));
				return;
			}

			// Layer 0 — runtime plugin availability. The server-side --enable-python-exec
			// flag gate (Layer 1) runs in m5-editor-utility-tools.mjs BEFORE this handler
			// is reached, so by the time we're here, the user has explicitly opted into
			// Python execution at server startup. We still need to verify the plugin is
			// loaded — the user could have launched with the flag but disabled the plugin
			// in the .uproject Plugins[] block.
			IPythonScriptPlugin* Plugin = IPythonScriptPlugin::Get();
			if (!Plugin || !Plugin->IsPythonAvailable())
			{
				BuildErrorResponse(OutResponse,
					TEXT("Python Editor Script Plugin not available — enable in .uproject Plugins[] and restart editor"),
					TEXT("PYTHON_PLUGIN_NOT_AVAILABLE"));
				return;
			}

			// Layer 2 — D14 deny-list scan. Catches `import os`, `import subprocess`,
			// `__import__`, `eval(`, `exec(`, `open(`. Simple substring match;
			// intentionally tolerates false positives (string-literal mentions of
			// these patterns trip the gate) — the security posture is "fail closed".
			const FString MatchedPattern = MatchPythonDenyList(Script);
			if (!MatchedPattern.IsEmpty())
			{
				const FString Hash = ShortHash(Script);
				UE_LOG(LogUEMCPSecurity, Warning,
					TEXT("[UEMCP-PYTHON-EXEC] DENIED hash=%s pattern=\"%s\" preview=\"%s\""),
					*Hash, *MatchedPattern, *PreviewForLog(Script));

				TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
				Detail->SetStringField(TEXT("matched_pattern"), MatchedPattern);
				Detail->SetStringField(TEXT("script_hash"),     Hash);
				OutResponse = MakeShared<FJsonObject>();
				OutResponse->SetStringField(TEXT("status"), TEXT("error"));
				OutResponse->SetStringField(TEXT("error"),
					FString::Printf(TEXT("Script matches deny-list pattern \"%s\" — refusing to execute"), *MatchedPattern));
				OutResponse->SetStringField(TEXT("code"),    TEXT("PYTHON_EXEC_DENY_LIST"));
				OutResponse->SetObjectField(TEXT("detail"), Detail);
				return;
			}

			// Layer 3 — audit log BEFORE execution so the trail survives even a Python
			// exception that aborts mid-script. SHA1 fingerprint + first-100-chars
			// preview gives enough info for forensic review without dumping the full
			// (potentially large) script body into the log.
			const FString Hash = ShortHash(Script);
			UE_LOG(LogUEMCPSecurity, Warning,
				TEXT("[UEMCP-PYTHON-EXEC] EXEC hash=%s preview=\"%s\""),
				*Hash, *PreviewForLog(Script));

			FPythonCommandEx Cmd;
			Cmd.Command       = Script;
			Cmd.ExecutionMode = EPythonCommandExecutionMode::ExecuteStatement;

			const bool bSuccess = Plugin->ExecPythonCommandEx(Cmd);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField  (TEXT("success"),     bSuccess);
			Result->SetStringField(TEXT("script_hash"), Hash);
			Result->SetStringField(TEXT("output"),      Cmd.CommandResult);
			if (Cmd.LogOutput.Num() > 0)
			{
				TArray<TSharedPtr<FJsonValue>> LogArr;
				for (const FPythonLogOutputEntry& Entry : Cmd.LogOutput)
				{
					TSharedPtr<FJsonObject> LogJson = MakeShared<FJsonObject>();
					LogJson->SetStringField(TEXT("type"),
						Entry.Type == EPythonLogOutputType::Error ? TEXT("error") : TEXT("info"));
					LogJson->SetStringField(TEXT("output"), Entry.Output);
					LogArr.Add(MakeShared<FJsonValueObject>(LogJson));
				}
				Result->SetArrayField(TEXT("log_output"), LogArr);
			}

			if (!bSuccess)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Python execution failed: %s"), *Cmd.CommandResult),
					TEXT("PYTHON_EXEC_FAILED"));
				return;
			}
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// get_editor_utility_blueprint — EUB / EUW introspection
		// ═══════════════════════════════════════════════════════════════════════
		//
		// Per handoff §5: BP introspection + EUB-specific fields (run-method
		// signature, editor-menu registration, EUW widget tree). Chosen over the
		// reflection_walk PARTIAL-RC pattern because reflection_walk can't surface
		// EUB-specific fields without a transform layer that effectively duplicates
		// what a direct handler does.

		void HandleGetEditorUtilityBlueprint(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("get_editor_utility_blueprint requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("get_editor_utility_blueprint requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			UObject* Loaded = UEditorAssetLibrary::LoadAsset(AssetPath);
			if (!Loaded)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset not found: %s"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			UBlueprint* BP = Cast<UBlueprint>(Loaded);
			if (!BP)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset at %s is not a Blueprint (got class %s)"),
						*AssetPath, *Loaded->GetClass()->GetName()),
					TEXT("NOT_A_BLUEPRINT"));
				return;
			}

			const bool bIsEUW = Cast<UEditorUtilityWidgetBlueprint>(BP) != nullptr;
			const bool bIsEUB = Cast<UEditorUtilityBlueprint>(BP) != nullptr;
			if (!bIsEUW && !bIsEUB)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset at %s is a Blueprint but not an EditorUtility variant (parent class: %s)"),
						*AssetPath,
						BP->ParentClass ? *BP->ParentClass->GetName() : TEXT("(none)")),
					TEXT("NOT_AN_EDITOR_UTILITY"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"),    AssetPath);
			Result->SetStringField(TEXT("asset_class"),   BP->GetClass()->GetName());
			Result->SetStringField(TEXT("bp_type"),       bIsEUW ? TEXT("EditorUtilityWidget") : TEXT("EditorUtilityBlueprint"));
			Result->SetStringField(TEXT("parent_class"),
				BP->ParentClass ? BP->ParentClass->GetPathName() : TEXT(""));
			Result->SetStringField(TEXT("generated_class"),
				BP->GeneratedClass ? BP->GeneratedClass->GetPathName() : TEXT(""));

			// Run-method discovery — EUBs typically expose a `Run` UFunction either as
			// a Blueprint event override or a custom function. Inspect the generated
			// class function map for either.
			TSharedPtr<FJsonObject> RunMethod = MakeShared<FJsonObject>();
			RunMethod->SetBoolField(TEXT("present"), false);
			if (UClass* GenClass = BP->GeneratedClass)
			{
				static const FName RunNames[] = { FName(TEXT("Run")), FName(TEXT("K2_Run")) };
				for (FName RunName : RunNames)
				{
					if (UFunction* Func = GenClass->FindFunctionByName(RunName))
					{
						RunMethod->SetBoolField  (TEXT("present"),    true);
						RunMethod->SetStringField(TEXT("name"),       Func->GetName());
						RunMethod->SetNumberField(TEXT("num_params"), Func->NumParms);
						RunMethod->SetBoolField  (TEXT("has_return"), Func->GetReturnProperty() != nullptr);
						break;
					}
				}
			}
			Result->SetObjectField(TEXT("run_method"), RunMethod);

			// Editor-menu registration is EUB-only metadata. UEditorUtilityBlueprint
			// stores menu-binding info on the asset itself; UEditorUtilityWidgetBlueprint
			// uses the standard "Run Editor Utility Widget" right-click action.
			TSharedPtr<FJsonObject> EditorMenu = MakeShared<FJsonObject>();
			EditorMenu->SetBoolField(TEXT("registered"), false);
			if (UEditorUtilityBlueprint* EUB = Cast<UEditorUtilityBlueprint>(BP))
			{
				// UEditorUtilityBlueprint exposes a CustomTabName property (bound at
				// instantiation) — its presence is a stronger signal of menu wiring
				// than the generated-class flag alone.
				if (FProperty* TabProp = EUB->GetClass()->FindPropertyByName(FName(TEXT("CustomTabName"))))
				{
					if (FStrProperty* StrProp = CastField<FStrProperty>(TabProp))
					{
						const FString TabName = StrProp->GetPropertyValue_InContainer(EUB);
						if (!TabName.IsEmpty())
						{
							EditorMenu->SetBoolField  (TEXT("registered"),       true);
							EditorMenu->SetStringField(TEXT("custom_tab_name"), TabName);
						}
					}
				}
			}
			else if (bIsEUW)
			{
				// EUWs are surfaced via the Editor Utility menu by default; the
				// presence of an EUW class is itself the registration signal.
				EditorMenu->SetBoolField  (TEXT("registered"),     true);
				EditorMenu->SetStringField(TEXT("registered_via"), TEXT("editor_utility_widget_default"));
			}
			Result->SetObjectField(TEXT("editor_menu"), EditorMenu);

			// Quick BP overview to mirror get_blueprint_info shape — matches the
			// menhance-tcp-tools transform output for blueprint_info so callers can
			// reuse client-side rendering.
			Result->SetNumberField(TEXT("variable_count"),
				BP->NewVariables.Num());
			int32 FunctionCount = 0;
			for (UEdGraph* G : BP->FunctionGraphs)
			{
				if (G) ++FunctionCount;
			}
			Result->SetNumberField(TEXT("function_count"), FunctionCount);

			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// run_editor_utility — invoke a Run UFunction on a transient EUB instance
		// ═══════════════════════════════════════════════════════════════════════

		void HandleRunEditorUtility(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("run_editor_utility requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("run_editor_utility requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			UObject* Loaded = UEditorAssetLibrary::LoadAsset(AssetPath);
			if (!Loaded)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset not found: %s"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}
			UBlueprint* BP = Cast<UBlueprint>(Loaded);
			if (!BP || !BP->GeneratedClass)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset at %s is not a compiled Blueprint"), *AssetPath),
					TEXT("NOT_A_BLUEPRINT"));
				return;
			}

			UFunction* RunFunc = nullptr;
			static const FName RunNames[] = { FName(TEXT("Run")), FName(TEXT("K2_Run")) };
			for (FName RunName : RunNames)
			{
				RunFunc = BP->GeneratedClass->FindFunctionByName(RunName);
				if (RunFunc) break;
			}
			if (!RunFunc)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Editor utility at %s has no Run / K2_Run function"), *AssetPath),
					TEXT("NO_RUN_FUNCTION"));
				return;
			}

			// Construct a transient instance to invoke Run on. We deliberately do NOT
			// use the CDO here: editor-utility BP graphs frequently do per-instance
			// state setup in their constructor scripts (e.g. Spawn UI in OnConstruction)
			// that the CDO never runs. A transient instance gets the full lifecycle.
			UObject* Instance = NewObject<UObject>(GetTransientPackage(), BP->GeneratedClass);
			if (!Instance)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to instantiate editor utility"), TEXT("INSTANTIATE_FAILED"));
				return;
			}

			// ProcessEvent with no params buffer is correct only for Run functions
			// taking no parameters. We don't allow callers to pass args here — if
			// they need parameterized invocation, they should call it from Python.
			if (RunFunc->NumParms != 0)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Run function on %s takes %d parameters; only zero-arg Run is supported"),
						*AssetPath, RunFunc->NumParms),
					TEXT("RUN_FUNC_HAS_PARAMS"));
				return;
			}

			Instance->ProcessEvent(RunFunc, nullptr);

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), AssetPath);
			Result->SetStringField(TEXT("function"),   RunFunc->GetName());
			Result->SetBoolField  (TEXT("invoked"),    true);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// duplicate_asset
		// ═══════════════════════════════════════════════════════════════════════

		void HandleDuplicateAsset(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("duplicate_asset requires params.source_path + dest_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString SourcePath, DestPath;
			if (!Params->TryGetStringField(TEXT("source_path"), SourcePath) || SourcePath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'source_path' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("dest_path"), DestPath) || DestPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'dest_path' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			if (!UEditorAssetLibrary::DoesAssetExist(SourcePath))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Source asset not found: %s"), *SourcePath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			// Refuse pre-existing destination unless overwrite:true. The
			// UEditorAssetLibrary::DuplicateAsset call would silently overwrite —
			// a class of bug we want callers to acknowledge explicitly.
			bool bOverwrite = false;
			if (Params->HasField(TEXT("overwrite")))
			{
				Params->TryGetBoolField(TEXT("overwrite"), bOverwrite);
			}
			if (UEditorAssetLibrary::DoesAssetExist(DestPath) && !bOverwrite)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Destination asset already exists: %s — pass overwrite:true to replace"), *DestPath),
					TEXT("DEST_EXISTS"));
				return;
			}

			UObject* NewAsset = UEditorAssetLibrary::DuplicateAsset(SourcePath, DestPath);
			if (!NewAsset)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Failed to duplicate %s → %s"), *SourcePath, *DestPath),
					TEXT("DUPLICATE_FAILED"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("source_path"), SourcePath);
			Result->SetStringField(TEXT("dest_path"),   DestPath);
			Result->SetStringField(TEXT("new_path"),    NewAsset->GetPathName());
			Result->SetStringField(TEXT("class"),       NewAsset->GetClass()->GetName());
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// rename_asset
		// ═══════════════════════════════════════════════════════════════════════

		void HandleRenameAsset(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("rename_asset requires params.asset_path + new_name"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath, NewName;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'asset_path' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("new_name"), NewName) || NewName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'new_name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			if (!UEditorAssetLibrary::DoesAssetExist(AssetPath))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset not found: %s"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			// Resolve destination — accept either a full /Game/...  path or a bare
			// new name that we splice into the source's package directory.
			FString DestPath;
			if (NewName.StartsWith(TEXT("/")))
			{
				DestPath = NewName;
			}
			else
			{
				const FString PackageName = PackageNameOnly(AssetPath);
				const FString PackageDir  = FPackageName::GetLongPackagePath(PackageName);
				DestPath = FString::Printf(TEXT("%s/%s"), *PackageDir, *NewName);
			}

			if (UEditorAssetLibrary::DoesAssetExist(DestPath))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Rename target already exists: %s"), *DestPath),
					TEXT("DEST_EXISTS"));
				return;
			}

			const bool bRenamed = UEditorAssetLibrary::RenameAsset(AssetPath, DestPath);
			if (!bRenamed)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Failed to rename %s → %s"), *AssetPath, *DestPath),
					TEXT("RENAME_FAILED"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("source_path"), AssetPath);
			Result->SetStringField(TEXT("dest_path"),   DestPath);
			Result->SetBoolField  (TEXT("renamed"),     true);
			BuildSuccessResponse(OutResponse, Result);
		}

		// ═══════════════════════════════════════════════════════════════════════
		// delete_asset_safe — security-sensitive (D14 + D101 (iv))
		// ═══════════════════════════════════════════════════════════════════════
		//
		// Decision matrix (locked before implementation):
		//
		//   force | permanent | move_to_trash (default true) | deps>0 | Result
		//   ──────┼───────────┼───────────────────────────────┼────────┼────────
		//     F   |     F     |             T                 |  yes   | ASSET_HAS_DEPENDENCIES
		//     F   |     F     |             T                 |  no    | move to /Game/_Deleted/
		//     T   |     F     |             T                 | y/n    | move to /Game/_Deleted/ + warning
		//     T   |     T     |          (ignored)            | y/n    | hard delete + warning
		//     F   |     T     |             *                 |  *     | BAD_PARAMS — permanent requires force
		//
		// Every successful delete (soft or hard) is logged via LogUEMCPSecurity for
		// audit trail.

		void HandleDeleteAssetSafe(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("delete_asset_safe requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing 'asset_path' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			bool bForce        = false;
			bool bPermanent    = false;
			bool bMoveToTrash  = true;  // Default: soft-delete to /Game/_Deleted/
			Params->TryGetBoolField(TEXT("force"),         bForce);
			Params->TryGetBoolField(TEXT("permanent"),     bPermanent);
			Params->TryGetBoolField(TEXT("move_to_trash"), bMoveToTrash);

			// Row 5 of the matrix: refuse permanent without explicit force sentinel.
			if (bPermanent && !bForce)
			{
				BuildErrorResponse(OutResponse,
					TEXT("permanent:true delete requires force:true acknowledgement"),
					TEXT("BAD_PARAMS"));
				return;
			}

			if (!UEditorAssetLibrary::DoesAssetExist(AssetPath))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset not found: %s"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			// Dependency check — block on referencers unless force:true.
			FAssetRegistryModule& AssetRegistryModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
			IAssetRegistry& AssetRegistry = AssetRegistryModule.Get();
			const FString PackageName = PackageNameOnly(AssetPath);
			TArray<FName> Referencers;
			AssetRegistry.GetReferencers(FName(*PackageName), Referencers);

			if (Referencers.Num() > 0 && !bForce)
			{
				TArray<TSharedPtr<FJsonValue>> RefArr;
				for (FName R : Referencers)
				{
					RefArr.Add(MakeShared<FJsonValueString>(R.ToString()));
				}
				TSharedPtr<FJsonObject> Detail = MakeShared<FJsonObject>();
				Detail->SetArrayField (TEXT("referencers"),     RefArr);
				Detail->SetNumberField(TEXT("num_referencers"), RefArr.Num());

				OutResponse = MakeShared<FJsonObject>();
				OutResponse->SetStringField(TEXT("status"), TEXT("error"));
				OutResponse->SetStringField(TEXT("error"),
					FString::Printf(TEXT("Asset has %d referencer(s); pass force:true to delete anyway"),
						Referencers.Num()));
				OutResponse->SetStringField(TEXT("code"), TEXT("ASSET_HAS_DEPENDENCIES"));
				OutResponse->SetObjectField(TEXT("detail"), Detail);
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"),     AssetPath);
			Result->SetNumberField(TEXT("num_referencers"), Referencers.Num());

			// Surface a warning string when force:true is overriding referencers OR
			// when the caller chose hard-delete. Both are destructive choices the
			// caller acknowledged, but the response trail makes that explicit.
			TArray<TSharedPtr<FJsonValue>> Warnings;
			if (Referencers.Num() > 0 && bForce)
			{
				Warnings.Add(MakeShared<FJsonValueString>(
					FString::Printf(TEXT("Force-deleted with %d referencer(s); references will become broken"),
						Referencers.Num())));
			}
			if (bPermanent)
			{
				Warnings.Add(MakeShared<FJsonValueString>(
					TEXT("Permanent delete — asset cannot be recovered from /Game/_Deleted/")));
			}

			if (bPermanent)
			{
				// Hard delete via UEditorAssetLibrary. Refuses to delete loaded-in-memory
				// assets that have outstanding references; force:true here means the
				// caller accepts that outcome.
				const bool bDeleted = UEditorAssetLibrary::DeleteAsset(AssetPath);
				if (!bDeleted)
				{
					BuildErrorResponse(OutResponse,
						FString::Printf(TEXT("Hard-delete failed for %s — asset may be loaded or locked"), *AssetPath),
						TEXT("DELETE_FAILED"));
					return;
				}
				UE_LOG(LogUEMCPSecurity, Warning,
					TEXT("[UEMCP-DELETE-ASSET] HARD path=%s referencers=%d force=%d"),
					*AssetPath, Referencers.Num(), bForce ? 1 : 0);
				Result->SetStringField(TEXT("mode"),         TEXT("permanent"));
				Result->SetBoolField  (TEXT("deleted"),      true);
				Result->SetArrayField (TEXT("warnings"),     Warnings);
				BuildSuccessResponse(OutResponse, Result);
				return;
			}

			// Soft-delete path — rename into /Game/_Deleted/ namespace. Recoverable
			// by the caller (just rename back). Reference fixup is automatic via
			// UEditorAssetLibrary::RenameAsset, so referencers continue to resolve.
			if (bMoveToTrash)
			{
				const FString TrashPath = TrashPathFor(AssetPath);
				const bool bRenamed = UEditorAssetLibrary::RenameAsset(AssetPath, TrashPath);
				if (!bRenamed)
				{
					BuildErrorResponse(OutResponse,
						FString::Printf(TEXT("Soft-delete (rename to %s) failed for %s"),
							*TrashPath, *AssetPath),
						TEXT("DELETE_FAILED"));
					return;
				}
				UE_LOG(LogUEMCPSecurity, Warning,
					TEXT("[UEMCP-DELETE-ASSET] SOFT path=%s trash=%s referencers=%d force=%d"),
					*AssetPath, *TrashPath, Referencers.Num(), bForce ? 1 : 0);
				Result->SetStringField(TEXT("mode"),         TEXT("soft"));
				Result->SetStringField(TEXT("trash_path"),   TrashPath);
				Result->SetBoolField  (TEXT("deleted"),      true);
				Result->SetArrayField (TEXT("warnings"),     Warnings);
				BuildSuccessResponse(OutResponse, Result);
				return;
			}

			// move_to_trash:false + permanent:false — caller wants neither soft nor
			// hard delete. Refuse rather than silently succeeding with a no-op.
			BuildErrorResponse(OutResponse,
				TEXT("delete_asset_safe with move_to_trash:false and permanent:false has no defined action"),
				TEXT("BAD_PARAMS"));
		}

	} // anonymous namespace

	void RegisterEditorUtilityHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("run_python_command"),           &HandleRunPythonCommand);
		Registry.Register(TEXT("get_editor_utility_blueprint"), &HandleGetEditorUtilityBlueprint);
		Registry.Register(TEXT("run_editor_utility"),           &HandleRunEditorUtility);
		Registry.Register(TEXT("duplicate_asset"),              &HandleDuplicateAsset);
		Registry.Register(TEXT("rename_asset"),                 &HandleRenameAsset);
		Registry.Register(TEXT("delete_asset_safe"),            &HandleDeleteAssetSafe);
	}
}
