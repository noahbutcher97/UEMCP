// Copyright Optimum Athena. All Rights Reserved.
#include "SidecarMenuHook.h"
#include "SidecarWriter.h"

#include "AssetRegistry/AssetData.h"
#include "ContentBrowserDelegates.h"
#include "ContentBrowserModule.h"
#include "Engine/Blueprint.h"
#include "Framework/MultiBox/MultiBoxBuilder.h"
#include "Logging/LogMacros.h"
#include "Misc/MessageDialog.h"
#include "Modules/ModuleManager.h"

DECLARE_LOG_CATEGORY_EXTERN(LogUEMCPSidecarMenu, Log, All);
DEFINE_LOG_CATEGORY(LogUEMCPSidecarMenu);

namespace UEMCP
{
	namespace
	{
		FDelegateHandle GExtenderHandle;

		void OnRegenerateSidecarClicked(TArray<FAssetData> SelectedAssets)
		{
			int32 WriteOk = 0, WriteFail = 0;
			for (const FAssetData& AD : SelectedAssets)
			{
				UBlueprint* BP = Cast<UBlueprint>(AD.GetAsset());
				if (!BP) continue;  // non-BP selections silently skipped

				FString Error;
				if (WriteNarrowSidecar(BP, Error))
				{
					++WriteOk;
				}
				else
				{
					UE_LOG(LogUEMCPSidecarMenu, Warning,
						TEXT("Sidecar write failed for %s: %s"),
						*BP->GetPathName(), *Error);
					++WriteFail;
				}
			}

			// Surface a confirmation dialog — users picking this from the menu
			// expect explicit feedback. Success-without-acknowledgement on
			// editor menu operations creates "did it work?" ambiguity.
			const FText Msg = FText::FromString(FString::Printf(
				TEXT("Narrow sidecar regeneration: %d succeeded, %d failed."),
				WriteOk, WriteFail));
			FMessageDialog::Open(EAppMsgType::Ok, Msg);
		}

		void AddMenuEntry(FMenuBuilder& MenuBuilder, TArray<FAssetData> SelectedAssets)
		{
			MenuBuilder.AddMenuEntry(
				FText::FromString(TEXT("Regenerate UEMCP Sidecar")),
				FText::FromString(TEXT("Force-writes narrow-sidecar-v1 JSON under <Project>/Saved/UEMCP/ for the selected Blueprints.")),
				FSlateIcon(),
				FUIAction(FExecuteAction::CreateLambda([SelectedAssets]()
				{
					OnRegenerateSidecarClicked(SelectedAssets);
				}))
			);
		}

		TSharedRef<FExtender> OnExtendContentBrowserAssetSelectionMenu(const TArray<FAssetData>& SelectedAssets)
		{
			TSharedRef<FExtender> Extender = MakeShared<FExtender>();

			// Only extend when at least one Blueprint is in the selection. Non-BP
			// assets don't have sidecars; no point cluttering their menu.
			bool bHasBlueprint = false;
			for (const FAssetData& AD : SelectedAssets)
			{
				if (AD.AssetClassPath == UBlueprint::StaticClass()->GetClassPathName())
				{
					bHasBlueprint = true;
					break;
				}
			}
			if (!bHasBlueprint) return Extender;

			Extender->AddMenuExtension(
				TEXT("GetAssetActions"),
				EExtensionHook::After,
				nullptr,
				FMenuExtensionDelegate::CreateLambda([SelectedAssets](FMenuBuilder& MenuBuilder)
				{
					AddMenuEntry(MenuBuilder, SelectedAssets);
				})
			);

			return Extender;
		}
	}

	void RegisterSidecarMenuHook()
	{
		if (GExtenderHandle.IsValid())
		{
			return;  // idempotent — hot-reload safety
		}
		FContentBrowserModule& CBModule = FModuleManager::LoadModuleChecked<FContentBrowserModule>(TEXT("ContentBrowser"));
		TArray<FContentBrowserMenuExtender_SelectedAssets>& Extenders =
			CBModule.GetAllAssetViewContextMenuExtenders();

		FContentBrowserMenuExtender_SelectedAssets Extender;
		Extender.BindStatic(&OnExtendContentBrowserAssetSelectionMenu);
		Extenders.Add(Extender);
		GExtenderHandle = Extenders.Last().GetHandle();

		UE_LOG(LogUEMCPSidecarMenu, Log,
			TEXT("UEMCP sidecar Content Browser extender registered"));
	}

	void UnregisterSidecarMenuHook()
	{
		if (!GExtenderHandle.IsValid()) return;

		if (FContentBrowserModule* CBModule = FModuleManager::GetModulePtr<FContentBrowserModule>(TEXT("ContentBrowser")))
		{
			TArray<FContentBrowserMenuExtender_SelectedAssets>& Extenders =
				CBModule->GetAllAssetViewContextMenuExtenders();
			Extenders.RemoveAll([](const FContentBrowserMenuExtender_SelectedAssets& Candidate)
			{
				return Candidate.GetHandle() == GExtenderHandle;
			});
		}
		GExtenderHandle.Reset();

		UE_LOG(LogUEMCPSidecarMenu, Log,
			TEXT("UEMCP sidecar Content Browser extender unregistered"));
	}
}
