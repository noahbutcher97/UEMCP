// Copyright Optimum Athena. All Rights Reserved.
#include "SidecarWriter.h"
#include "ReflectionWalker.h"

#include "Dom/JsonObject.h"
#include "Engine/Blueprint.h"
#include "Engine/BlueprintGeneratedClass.h"
#include "HAL/PlatformFileManager.h"
#include "Misc/DateTime.h"
#include "Misc/EngineVersion.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace UEMCP
{
	namespace
	{
		/**
		 * Serialize the Blueprint's last-known compile status. We do NOT re-compile
		 * on save — save hooks fire during user flows (post-save in particular) and
		 * triggering another compile would double-cost every save. Instead we read
		 * the persisted Status + any cached Messages; a fresh compile is the
		 * commandlet's job (3F-4 production variant, Session 4).
		 */
		TSharedPtr<FJsonObject> SerializeLastCompileStatus(const UBlueprint* BP)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			if (!BP) return Out;

			const TCHAR* StatusText = TEXT("Unknown");
			switch (BP->Status)
			{
				case BS_Unknown:                 StatusText = TEXT("Unknown"); break;
				case BS_Dirty:                   StatusText = TEXT("Dirty"); break;
				case BS_Error:                   StatusText = TEXT("Error"); break;
				case BS_UpToDate:                StatusText = TEXT("UpToDate"); break;
				case BS_UpToDateWithWarnings:    StatusText = TEXT("UpToDateWithWarnings"); break;
				default: break;
			}
			Out->SetStringField(TEXT("status"), StatusText);
			Out->SetBoolField(TEXT("is_compiled_ok"),
				BP->Status == BS_UpToDate || BP->Status == BS_UpToDateWithWarnings);
			return Out;
		}

		/**
		 * Runtime/compiled derivatives that aren't on disk. At a minimum:
		 *   - generated_class_path   (BP_X_C object path)
		 *   - super_class_path       (reflected from GeneratedClass, not uasset)
		 *   - full reflection surface from SerializeClassReflection
		 */
		TSharedPtr<FJsonObject> SerializeRuntimeDerivatives(const UBlueprint* BP)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			if (!BP || !BP->GeneratedClass) return Out;

			UClass* GenClass = BP->GeneratedClass;
			Out->SetStringField(TEXT("generated_class_path"), GenClass->GetPathName());

			// Full reflection surface — CP3's SerializeClassReflection already bypasses
			// RC's SanitizeMetadata allowlist. Narrow-sidecar carries this so workflows
			// that can't tolerate a TCP round-trip get flags for free on disk.
			if (TSharedPtr<FJsonObject> Reflected = SerializeClassReflection(GenClass))
			{
				Out->SetObjectField(TEXT("reflection"), Reflected);
			}
			return Out;
		}
	}

	FString GetSidecarPathForBlueprint(const UBlueprint* Blueprint)
	{
		if (!Blueprint) return FString();

		// <ProjectDir>/Saved/UEMCP/<package-path>.sidecar.json
		// PackageName looks like "/Game/Blueprints/Character/BP_OSPlayerR" — we strip the
		// leading "/" so it maps cleanly to a relative path beneath Saved/UEMCP/.
		FString PackageName = Blueprint->GetOutermost()->GetName();
		if (PackageName.StartsWith(TEXT("/")))
		{
			PackageName = PackageName.Mid(1);
		}

		const FString OutputDir = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEMCP"));
		return FPaths::Combine(OutputDir, PackageName + TEXT(".sidecar.json"));
	}

	bool WriteNarrowSidecar(UBlueprint* Blueprint, FString& OutError)
	{
		OutError.Reset();
		if (!Blueprint)
		{
			OutError = TEXT("WriteNarrowSidecar: null Blueprint");
			return false;
		}

		TSharedRef<FJsonObject> Root = MakeShared<FJsonObject>();
		Root->SetStringField(TEXT("schema_version"), TEXT("narrow-sidecar-v1"));
		Root->SetStringField(TEXT("engine_version"), FEngineVersion::Current().ToString());
		Root->SetStringField(TEXT("asset_path"),     Blueprint->GetPathName());
		Root->SetStringField(TEXT("written_at"),     FDateTime::UtcNow().ToIso8601());

		// Plugin-only fields (NOT offline derivable):
		Root->SetObjectField(TEXT("compile_status"),       SerializeLastCompileStatus(Blueprint));
		Root->SetObjectField(TEXT("runtime_derivatives"),  SerializeRuntimeDerivatives(Blueprint));

		// Serialize to pretty JSON — sidecar files are read by humans and tooling both.
		FString Body;
		TSharedRef<TJsonWriter<>> Writer = TJsonWriterFactory<>::Create(&Body);
		if (!FJsonSerializer::Serialize(Root, Writer))
		{
			OutError = TEXT("WriteNarrowSidecar: JSON serialize failed");
			return false;
		}

		const FString OutputPath = GetSidecarPathForBlueprint(Blueprint);
		const FString OutputDir  = FPaths::GetPath(OutputPath);

		IPlatformFile& FileManager = FPlatformFileManager::Get().GetPlatformFile();
		if (!FileManager.DirectoryExists(*OutputDir))
		{
			if (!FileManager.CreateDirectoryTree(*OutputDir))
			{
				OutError = FString::Printf(TEXT("WriteNarrowSidecar: failed to create dir %s"), *OutputDir);
				return false;
			}
		}

		if (!FFileHelper::SaveStringToFile(Body, *OutputPath))
		{
			OutError = FString::Printf(TEXT("WriteNarrowSidecar: SaveStringToFile failed for %s"), *OutputPath);
			return false;
		}

		return true;
	}
}
