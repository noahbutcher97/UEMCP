// Copyright Optimum Athena. All Rights Reserved.
#include "SidecarSaveHook.h"
#include "SidecarWriter.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

#include "Dom/JsonObject.h"
#include "Engine/Blueprint.h"
#include "Logging/LogMacros.h"
#include "UObject/Object.h"
#include "UObject/ObjectSaveContext.h"
#include "UObject/SoftObjectPath.h"
#include "UObject/UObjectGlobals.h"

DECLARE_LOG_CATEGORY_EXTERN(LogUEMCPSidecar, Log, All);
DEFINE_LOG_CATEGORY(LogUEMCPSidecar);

namespace UEMCP
{
	namespace
	{
		FDelegateHandle GPreSaveHandle;

		void OnObjectPreSave(UObject* Object, FObjectPreSaveContext /*Context*/)
		{
			// Fast-path: only Blueprints get sidecars. Most save events are unrelated
			// (textures, maps, materials); bailing early keeps save-path overhead ~0.
			UBlueprint* Blueprint = Cast<UBlueprint>(Object);
			if (!Blueprint) return;

			// Skip transient/temporary Blueprints (e.g. compile-in-place derivatives).
			// The persistent asset save is what we care about.
			if (Blueprint->GetOutermost() == GetTransientPackage()) return;

			FString Error;
			if (!WriteNarrowSidecar(Blueprint, Error))
			{
				UE_LOG(LogUEMCPSidecar, Warning,
					TEXT("UEMCP sidecar write failed for %s: %s"),
					*Blueprint->GetPathName(), *Error);
				return;
			}
			// Success is silent — we don't want to spam the log on every save.
		}
	}

	void RegisterSidecarSaveHook()
	{
		if (GPreSaveHandle.IsValid())
		{
			// Already registered — idempotent. Module hot-reload can re-enter StartupModule.
			return;
		}
		GPreSaveHandle = FCoreUObjectDelegates::OnObjectPreSave.AddStatic(&OnObjectPreSave);
		UE_LOG(LogUEMCPSidecar, Log, TEXT("UEMCP sidecar save-hook registered (OnObjectPreSave)"));
	}

	void UnregisterSidecarSaveHook()
	{
		if (GPreSaveHandle.IsValid())
		{
			FCoreUObjectDelegates::OnObjectPreSave.Remove(GPreSaveHandle);
			GPreSaveHandle.Reset();
			UE_LOG(LogUEMCPSidecar, Log, TEXT("UEMCP sidecar save-hook unregistered"));
		}
	}

	namespace
	{
		void HandleRegenerateSidecar(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("regenerate_sidecar requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("regenerate_sidecar requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			// Resolve the path — accept both BP asset path and BP_C generated-class path.
			UBlueprint* Blueprint = LoadObject<UBlueprint>(nullptr, *AssetPath);
			if (!Blueprint)
			{
				const FSoftObjectPath Soft(AssetPath);
				if (UObject* Obj = Soft.TryLoad())
				{
					Blueprint = Cast<UBlueprint>(Obj);
				}
			}
			if (!Blueprint)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Could not resolve UBlueprint at '%s'"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			FString Error;
			if (!WriteNarrowSidecar(Blueprint, Error))
			{
				BuildErrorResponse(OutResponse, Error, TEXT("WRITE_FAILED"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("written"),    true);
			Result->SetStringField(TEXT("asset_path"), Blueprint->GetPathName());
			Result->SetStringField(TEXT("sidecar_path"), GetSidecarPathForBlueprint(Blueprint));
			BuildSuccessResponse(OutResponse, Result);
		}
	}

	void RegisterSidecarCommands(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("regenerate_sidecar"), &HandleRegenerateSidecar);
	}
}
