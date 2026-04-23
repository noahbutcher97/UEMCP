// Copyright Optimum Athena. All Rights Reserved.
#include "CompileDiagnosticHandler.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

#include "Engine/Blueprint.h"
#include "EdGraph/EdGraphNode.h"
#include "Kismet2/CompilerResultsLog.h"
#include "Kismet2/KismetEditorUtilities.h"
#include "Logging/TokenizedMessage.h"
#include "Misc/UObjectToken.h"
#include "UObject/SoftObjectPath.h"

namespace UEMCP
{
	namespace
	{
		/** Map EMessageSeverity to our four buckets. */
		const TCHAR* SeverityToString(EMessageSeverity::Type Severity)
		{
			switch (Severity)
			{
				case EMessageSeverity::Error:              return TEXT("Error");
				case EMessageSeverity::PerformanceWarning: return TEXT("PerformanceWarning");
				case EMessageSeverity::Warning:            return TEXT("Warning");
				case EMessageSeverity::Info:               return TEXT("Info");
				default:                                   return TEXT("Info");
			}
		}

		/** Which bucket a message lands in — UI severity only, no new taxonomy. */
		const TCHAR* SeverityBucket(EMessageSeverity::Type Severity)
		{
			switch (Severity)
			{
				case EMessageSeverity::Error:              return TEXT("errors");
				case EMessageSeverity::PerformanceWarning:
				case EMessageSeverity::Warning:            return TEXT("warnings");
				case EMessageSeverity::Info:               return TEXT("info");
				default:                                   return TEXT("info");
			}
		}

		/**
		 * Walk an FTokenizedMessage's FMessageTokens to find a node GUID we can
		 * attribute the message to. Kismet compiler attaches FUObjectToken
		 * pointing at UEdGraphNode when it wants a source location.
		 */
		void ExtractTokenContext(const TSharedRef<FTokenizedMessage>& Msg, FString& OutText, FString& OutNodeGuid, FString& OutAssetPath)
		{
			// Message text: concat all token strings — matches what FCompilerResultsLog.Note() etc. build.
			OutText = Msg->ToText().ToString();

			for (const TSharedRef<IMessageToken>& Token : Msg->GetMessageTokens())
			{
				if (Token->GetType() == EMessageToken::Object)
				{
					const FUObjectToken& ObjToken = static_cast<const FUObjectToken&>(Token.Get());
					if (UObject* Obj = ObjToken.GetObject().Get())
					{
						if (const UEdGraphNode* Node = Cast<UEdGraphNode>(Obj))
						{
							OutNodeGuid = Node->NodeGuid.ToString(EGuidFormats::Digits);
						}
						if (OutAssetPath.IsEmpty())
						{
							// Package of the reported object — stable across asset rename vs node path drift.
							OutAssetPath = Obj->GetPathName();
						}
					}
				}
			}
		}

		/** Resolve /Game/... or short asset name to the loaded UBlueprint. Returns nullptr if unresolved. */
		UBlueprint* ResolveBlueprint(const FString& AssetPath)
		{
			// Full object path first
			if (UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *AssetPath))
			{
				return BP;
			}
			// StaticLoadObject fallback — tolerates `/Game/Path/BP_Name` (missing outer.object suffix)
			const FSoftObjectPath SoftPath(AssetPath);
			if (UObject* Obj = SoftPath.TryLoad())
			{
				return Cast<UBlueprint>(Obj);
			}
			return nullptr;
		}

		void HandleCompileAndReport(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("bp_compile_and_report requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("bp_compile_and_report requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			UBlueprint* BP = ResolveBlueprint(AssetPath);
			if (!BP)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Could not resolve Blueprint at '%s'"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			// Pre-compile: configure results log. bSilentMode=true keeps the compiler from spamming
			// the Message Log UI; we capture what we need programmatically.
			FCompilerResultsLog Results;
			Results.bSilentMode = true;
			Results.bAnnotateMentionedNodes = true;

			// Compile — D66 critical path: this is the signature with the out-param.
			// EBlueprintCompileOptions::SkipGarbageCollection avoids a full GC pass on every tool call.
			FKismetEditorUtilities::CompileBlueprint(
				BP,
				EBlueprintCompileOptions::SkipGarbageCollection,
				&Results);

			// Aggregate into 4 buckets. Unknown severities default to "info".
			TArray<TSharedPtr<FJsonValue>> Errors, Warnings, Notes, Info;
			TMap<FString, TArray<TSharedPtr<FJsonValue>>*> Buckets;
			Buckets.Add(TEXT("errors"),   &Errors);
			Buckets.Add(TEXT("warnings"), &Warnings);
			Buckets.Add(TEXT("notes"),    &Notes);   // currently unused by Kismet compiler but reserved
			Buckets.Add(TEXT("info"),     &Info);

			for (TSharedRef<FTokenizedMessage>& Msg : Results.Messages)
			{
				FString Text, NodeGuid, AssetPathHit;
				ExtractTokenContext(Msg, Text, NodeGuid, AssetPathHit);

				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("message"),  Text);
				Entry->SetStringField(TEXT("severity"), SeverityToString(Msg->GetSeverity()));
				if (!NodeGuid.IsEmpty())     Entry->SetStringField(TEXT("node_guid"),  NodeGuid);
				if (!AssetPathHit.IsEmpty()) Entry->SetStringField(TEXT("asset_path"), AssetPathHit);

				const FString BucketName = SeverityBucket(Msg->GetSeverity());
				if (TArray<TSharedPtr<FJsonValue>>** BucketArr = Buckets.Find(BucketName))
				{
					(**BucketArr).Add(MakeShared<FJsonValueObject>(Entry));
				}
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), BP->GetPathName());
			Result->SetArrayField(TEXT("errors"),      Errors);
			Result->SetArrayField(TEXT("warnings"),    Warnings);
			Result->SetArrayField(TEXT("notes"),       Notes);
			Result->SetArrayField(TEXT("info"),        Info);
			Result->SetNumberField(TEXT("num_errors"),   Errors.Num());
			Result->SetNumberField(TEXT("num_warnings"), Warnings.Num());
			Result->SetBoolField(TEXT("compiled_ok"),    Errors.Num() == 0);

			BuildSuccessResponse(OutResponse, Result);
		}
	} // anonymous namespace

	void RegisterCompileDiagnosticHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("bp_compile_and_report"), &HandleCompileAndReport);
	}
}
