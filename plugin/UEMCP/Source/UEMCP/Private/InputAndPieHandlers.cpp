// Copyright Optimum Athena. All Rights Reserved.
#include "InputAndPieHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "EnhancedActionKeyMapping.h"
#include "InputAction.h"
#include "InputCoreTypes.h"
#include "InputMappingContext.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"
#include "UObject/SavePackage.h"

namespace UEMCP
{
	namespace
	{
		// ── Asset path helpers ──────────────────────────────────────────────
		//
		// Two layers of input:
		//   • `name`: bare asset name like "IA_Move" or "IMC_Default"
		//   • `path`: optional /Game/... package directory (no trailing slash)
		//
		// Defaults follow Enhanced Input convention: actions under /Game/Input/Actions,
		// contexts under /Game/Input. add_mapping takes full asset paths instead because
		// it operates on existing assets — caller already has the path.

		FString DefaultActionDir()  { return TEXT("/Game/Input/Actions"); }
		FString DefaultContextDir() { return TEXT("/Game/Input"); }

		FString NormalizeDir(const FString& InDir)
		{
			FString Dir = InDir;
			while (Dir.EndsWith(TEXT("/"))) Dir.LeftChopInline(1);
			return Dir;
		}

		FString MakeAssetPath(const FString& Dir, const FString& Name)
		{
			return FString::Printf(TEXT("%s/%s"), *NormalizeDir(Dir), *Name);
		}

		// ── value_type → EInputActionValueType (string-tolerant) ────────────
		//
		// Accepts: "Bool"/"Boolean"/"Digital", "Axis1D"/"Float", "Axis2D"/"Vector2D",
		// "Axis3D"/"Vector". Case-insensitive. Returns false on miss so the handler
		// can emit a typed error instead of silently picking a default.

		bool ParseValueType(const FString& Raw, EInputActionValueType& Out)
		{
			const FString S = Raw.ToLower();
			if (S == TEXT("bool") || S == TEXT("boolean") || S == TEXT("digital"))
			{
				Out = EInputActionValueType::Boolean;
				return true;
			}
			if (S == TEXT("axis1d") || S == TEXT("float") || S == TEXT("1d"))
			{
				Out = EInputActionValueType::Axis1D;
				return true;
			}
			if (S == TEXT("axis2d") || S == TEXT("vector2d") || S == TEXT("2d"))
			{
				Out = EInputActionValueType::Axis2D;
				return true;
			}
			if (S == TEXT("axis3d") || S == TEXT("vector") || S == TEXT("3d"))
			{
				Out = EInputActionValueType::Axis3D;
				return true;
			}
			return false;
		}

		const TCHAR* ValueTypeToString(EInputActionValueType V)
		{
			switch (V)
			{
				case EInputActionValueType::Boolean: return TEXT("Boolean");
				case EInputActionValueType::Axis1D:  return TEXT("Axis1D");
				case EInputActionValueType::Axis2D:  return TEXT("Axis2D");
				case EInputActionValueType::Axis3D:  return TEXT("Axis3D");
				default: return TEXT("Unknown");
			}
		}

		// ── Save helper ─────────────────────────────────────────────────────
		//
		// Asset-creation handlers must persist via SavePackage so the .uasset lands on
		// disk before the response goes back. Without this the asset only lives in
		// memory until editor exit — surveyed-as-broken pattern in legacy UnrealMCP.

		bool SaveAssetPackage(UPackage* Package, FString& OutErrorMessage)
		{
			Package->MarkPackageDirty();
			const FString PackageFilename = FPackageName::LongPackageNameToFilename(
				Package->GetName(), FPackageName::GetAssetPackageExtension());
			FSavePackageArgs SaveArgs;
			SaveArgs.TopLevelFlags = RF_Public | RF_Standalone;
			SaveArgs.SaveFlags = SAVE_NoError;
			SaveArgs.Error = GError;
			if (!UPackage::SavePackage(Package, nullptr, *PackageFilename, SaveArgs))
			{
				OutErrorMessage = FString::Printf(TEXT("Failed to save package: %s"), *PackageFilename);
				return false;
			}
			return true;
		}

		// ═══════════════════════════════════════════════════════════════════
		// Handlers
		// ═══════════════════════════════════════════════════════════════════

		void HandleCreateInputAction(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("create_input_action requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Name, ValueTypeStr;
			if (!Params->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("value_type"), ValueTypeStr) || ValueTypeStr.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'value_type' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			EInputActionValueType ValueType;
			if (!ParseValueType(ValueTypeStr, ValueType))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Unknown value_type '%s' (expected: Bool, Axis1D, Axis2D, Axis3D)"), *ValueTypeStr),
					TEXT("BAD_VALUE_TYPE"));
				return;
			}

			FString Dir;
			if (!Params->TryGetStringField(TEXT("path"), Dir) || Dir.IsEmpty())
			{
				Dir = DefaultActionDir();
			}
			const FString AssetPath = MakeAssetPath(Dir, Name);

			if (FPackageName::DoesPackageExist(AssetPath))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("InputAction already exists at '%s'"), *AssetPath),
					TEXT("ASSET_EXISTS"));
				return;
			}

			UPackage* Package = CreatePackage(*AssetPath);
			if (!Package)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create package"), TEXT("PACKAGE_CREATE_FAILED"));
				return;
			}

			UInputAction* NewAction = NewObject<UInputAction>(Package, *Name, RF_Public | RF_Standalone);
			if (!NewAction)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create UInputAction"), TEXT("CREATE_FAILED"));
				return;
			}
			NewAction->ValueType = ValueType;

			FAssetRegistryModule::AssetCreated(NewAction);

			FString SaveError;
			if (!SaveAssetPackage(Package, SaveError))
			{
				BuildErrorResponse(OutResponse, SaveError, TEXT("SAVE_FAILED"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("name"),       Name);
			Result->SetStringField(TEXT("path"),       AssetPath);
			Result->SetStringField(TEXT("value_type"), ValueTypeToString(ValueType));
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleCreateMappingContext(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("create_mapping_context requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString Name;
			if (!Params->TryGetStringField(TEXT("name"), Name) || Name.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'name' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			FString Dir;
			if (!Params->TryGetStringField(TEXT("path"), Dir) || Dir.IsEmpty())
			{
				Dir = DefaultContextDir();
			}
			const FString AssetPath = MakeAssetPath(Dir, Name);

			if (FPackageName::DoesPackageExist(AssetPath))
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("InputMappingContext already exists at '%s'"), *AssetPath),
					TEXT("ASSET_EXISTS"));
				return;
			}

			UPackage* Package = CreatePackage(*AssetPath);
			if (!Package)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create package"), TEXT("PACKAGE_CREATE_FAILED"));
				return;
			}

			UInputMappingContext* NewContext = NewObject<UInputMappingContext>(Package, *Name, RF_Public | RF_Standalone);
			if (!NewContext)
			{
				BuildErrorResponse(OutResponse, TEXT("Failed to create UInputMappingContext"), TEXT("CREATE_FAILED"));
				return;
			}

			FAssetRegistryModule::AssetCreated(NewContext);

			FString SaveError;
			if (!SaveAssetPackage(Package, SaveError))
			{
				BuildErrorResponse(OutResponse, SaveError, TEXT("SAVE_FAILED"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("name"), Name);
			Result->SetStringField(TEXT("path"), AssetPath);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleAddMapping(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("add_mapping requires params"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString ContextPath, ActionPath, KeyName;
			if (!Params->TryGetStringField(TEXT("context_path"), ContextPath) || ContextPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'context_path' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("action_path"), ActionPath) || ActionPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'action_path' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}
			if (!Params->TryGetStringField(TEXT("key"), KeyName) || KeyName.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("Missing or empty 'key' parameter"), TEXT("MISSING_PARAMS"));
				return;
			}

			UInputMappingContext* Context = LoadObject<UInputMappingContext>(nullptr, *ContextPath);
			if (!Context)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("InputMappingContext not found: %s"), *ContextPath),
					TEXT("CONTEXT_NOT_FOUND"));
				return;
			}

			UInputAction* Action = LoadObject<UInputAction>(nullptr, *ActionPath);
			if (!Action)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("InputAction not found: %s"), *ActionPath),
					TEXT("ACTION_NOT_FOUND"));
				return;
			}

			// FKey accepts FName-like input. Validation runs on construction; check
			// IsValid() to reject typos like "WW" or "SpaceBar" (real key is "SpaceBar"
			// → FKey on miss is "None" → IsValid()==false).
			const FKey Key(*KeyName);
			if (!Key.IsValid())
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Unknown key: %s"), *KeyName),
					TEXT("BAD_KEY"));
				return;
			}

			Context->MapKey(Action, Key);

			UPackage* Package = Context->GetOutermost();
			if (Package)
			{
				FString SaveError;
				if (!SaveAssetPackage(Package, SaveError))
				{
					BuildErrorResponse(OutResponse, SaveError, TEXT("SAVE_FAILED"));
					return;
				}
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("context_path"), ContextPath);
			Result->SetStringField(TEXT("action_path"),  ActionPath);
			Result->SetStringField(TEXT("key"),          KeyName);
			Result->SetNumberField(TEXT("mapping_count"), Context->GetMappings().Num());
			BuildSuccessResponse(OutResponse, Result);
		}
	} // anonymous namespace

	void RegisterInputAndPieHandlers(FMCPCommandRegistry& Registry)
	{
		// PIE control (start_pie / stop_pie / is_pie_running / execute_console_command)
		// already lives in EdgeCaseHandlers.cpp under M-enhance D77 — do NOT register
		// them here. M5-PREP scaffold's stub for those was removed when that path
		// shipped; this file owns Enhanced Input asset-creation only.
		Registry.Register(TEXT("create_input_action"),    &HandleCreateInputAction);
		Registry.Register(TEXT("create_mapping_context"), &HandleCreateMappingContext);
		Registry.Register(TEXT("add_mapping"),            &HandleAddMapping);
	}
}
