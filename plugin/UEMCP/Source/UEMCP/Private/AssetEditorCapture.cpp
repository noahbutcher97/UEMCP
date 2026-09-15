// Copyright Noah Butcher. All Rights Reserved.
#include "AssetEditorCapture.h"

#include "Editor.h"
#include "Framework/Application/SlateApplication.h"
#include "HAL/FileManager.h"
#include "IDetailsView.h"
#include "ImageUtils.h"
#include "Layout/Children.h"
#include "Misc/App.h"
#include "Misc/Base64.h"
#include "Misc/DateTime.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Subsystems/AssetEditorSubsystem.h"
#include "Toolkits/IToolkit.h"
#include "UObject/Object.h"
#include "UObject/SoftObjectPath.h"
#include "Widgets/SWidget.h"

namespace UEMCP
{
	FAssetEditorTarget ResolveAssetEditorTarget(const FString& AssetPath)
	{
		FAssetEditorTarget Target;
		if (AssetPath.IsEmpty())
		{
			Target.ErrorCode = TEXT("MISSING_PARAMS");
			Target.ErrorMessage = TEXT("asset_path is required");
			return Target;
		}

		// Same two-step resolution the other visual-capture handler uses: the
		// soft path handles the doubled object-path form, LoadObject the
		// package-only form.
		const FSoftObjectPath Soft(AssetPath);
		Target.Asset = Soft.TryLoad();
		if (!Target.Asset)
		{
			Target.Asset = LoadObject<UObject>(nullptr, *AssetPath);
		}
		if (!Target.Asset)
		{
			Target.ErrorCode = TEXT("ASSET_NOT_FOUND");
			Target.ErrorMessage = FString::Printf(TEXT("Could not load asset at '%s'"), *AssetPath);
			return Target;
		}

		UAssetEditorSubsystem* Subsystem = GEditor ? GEditor->GetEditorSubsystem<UAssetEditorSubsystem>() : nullptr;
		if (!Subsystem)
		{
			Target.ErrorCode = TEXT("EDITOR_NOT_OPEN");
			Target.ErrorMessage = TEXT("The asset editor subsystem is unavailable");
			return Target;
		}

		// bFocusIfOpen = false: a capture must not steal focus or reorder tabs.
		Target.Editor = Subsystem->FindEditorForAsset(Target.Asset, /*bFocusIfOpen*/ false);
		if (!Target.Editor)
		{
			Target.ErrorCode = TEXT("EDITOR_NOT_OPEN");
			Target.ErrorMessage = FString::Printf(TEXT("No asset editor is open for '%s'"), *AssetPath);
			return Target;
		}

		Target.TabManager = Target.Editor->GetAssociatedTabManager();
		return Target;
	}

	TSharedPtr<SWidget> FindDescendantByType(const TSharedPtr<SWidget>& Root, FName TypeName)
	{
		if (!Root.IsValid())
		{
			return nullptr;
		}
		TArray<TSharedRef<SWidget>> Queue;
		Queue.Add(Root.ToSharedRef());
		const int32 MaxVisited = 8192;
		for (int32 Index = 0; Index < Queue.Num() && Index < MaxVisited; ++Index)
		{
			const TSharedRef<SWidget> Widget = Queue[Index];
			if (Widget->GetType() == TypeName)
			{
				return Widget;
			}
			FChildren* Children = Widget->GetChildren();
			const int32 Count = Children ? Children->Num() : 0;
			for (int32 Child = 0; Child < Count; ++Child)
			{
				Queue.Add(Children->GetChildAt(Child));
			}
		}
		return nullptr;
	}

	void CollectAssetEditorTabs(const TSharedPtr<FTabManager>& TabManager, TArray<FAssetEditorTabInfo>& OutTabs)
	{
		OutTabs.Reset();
		if (!TabManager.IsValid())
		{
			return;
		}
		const TSharedPtr<SDockTab> ActiveTab = FGlobalTabmanager::Get()->GetActiveTab();
		for (const TWeakPtr<FTabSpawnerEntry>& WeakSpawner : TabManager->CollectSpawners())
		{
			const TSharedPtr<FTabSpawnerEntry> Spawner = WeakSpawner.Pin();
			if (!Spawner.IsValid())
			{
				continue;
			}
			// A registered spawner with no live tab is not addressable.
			const TSharedPtr<SDockTab> Tab = TabManager->FindExistingLiveTab(FTabId(Spawner->GetTabType()));
			if (!Tab.IsValid())
			{
				continue;
			}
			FAssetEditorTabInfo Info;
			Info.TabId = Spawner->GetTabType().ToString();
			Info.DisplayName = Tab->GetTabLabel().ToString();
			Info.bIsActive = ActiveTab.IsValid() && ActiveTab == Tab;
			// Every rendered viewport composites through an SViewport, whatever
			// SEditorViewport subclass wraps it, so one core type name answers
			// this for all of them.
			Info.bHasViewport = FindDescendantByType(Tab->GetContent(), TEXT("SViewport")).IsValid();
			OutTabs.Add(Info);
		}
	}

	TSharedPtr<SDockTab> ResolveCaptureTab(const FAssetEditorTarget& Target, const FString& TabId)
	{
		if (!Target.TabManager.IsValid())
		{
			return nullptr;
		}
		if (!TabId.IsEmpty())
		{
			return Target.TabManager->FindExistingLiveTab(FTabId(FName(*TabId)));
		}
		TArray<FAssetEditorTabInfo> Tabs;
		CollectAssetEditorTabs(Target.TabManager, Tabs);
		for (const FAssetEditorTabInfo& Info : Tabs)
		{
			if (Info.bIsActive)
			{
				return Target.TabManager->FindExistingLiveTab(FTabId(FName(*Info.TabId)));
			}
		}
		return Tabs.Num() > 0
			? Target.TabManager->FindExistingLiveTab(FTabId(FName(*Tabs[0].TabId)))
			: nullptr;
	}

	bool CanCaptureSlate()
	{
		return FApp::CanEverRender() && FSlateApplication::IsInitialized();
	}

	FString DefaultCapturePath(const FString& Stem)
	{
		const FDateTime Now = FDateTime::Now();
		const FString FileName = FPaths::MakeValidFileName(FString::Printf(
			TEXT("%s_%s-%03d.png"),
			*Stem,
			*Now.ToString(TEXT("%Y%m%d-%H%M%S")),
			Now.GetMillisecond()));
		return FPaths::ConvertRelativePathToFull(
			FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEMCP"), TEXT("Captures"), FileName));
	}

	bool ResolveCaptureOutputPath(const FString& Requested, const FString& DefaultStem, FString& OutAbsolutePath, FString& OutError)
	{
		FString Candidate;
		if (Requested.IsEmpty())
		{
			Candidate = DefaultCapturePath(DefaultStem);
		}
		else if (FPaths::IsRelative(Requested))
		{
			Candidate = FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("UEMCP"), TEXT("Captures"), Requested);
		}
		else
		{
			Candidate = Requested;
		}
		if (!Candidate.EndsWith(TEXT(".png")))
		{
			Candidate += TEXT(".png");
		}
		FString Full = FPaths::ConvertRelativePathToFull(Candidate);
		FPaths::NormalizeFilename(Full);
		FPaths::CollapseRelativeDirectories(Full);

		FString ProjectRoot = FPaths::ConvertRelativePathToFull(FPaths::ProjectDir());
		FPaths::NormalizeDirectoryName(ProjectRoot);
		if (!ProjectRoot.EndsWith(TEXT("/")))
		{
			ProjectRoot += TEXT("/");
		}
		if (!Full.StartsWith(ProjectRoot, ESearchCase::IgnoreCase))
		{
			OutError = FString::Printf(TEXT("Capture output path '%s' resolves outside the project directory '%s'"), *Full, *ProjectRoot);
			return false;
		}
		OutAbsolutePath = Full;
		return true;
	}

	bool CaptureWidgetToPng(
		const TSharedRef<SWidget>& Widget,
		TArray64<uint8>& OutPng,
		FIntPoint& OutSize,
		FString& OutErrorCode,
		FString& OutErrorMessage)
	{
		if (!CanCaptureSlate())
		{
			OutErrorCode = TEXT("CAPTURE_UNSUPPORTED");
			OutErrorMessage = TEXT("No Slate renderer is available (headless or -nullrhi)");
			return false;
		}
		TArray<FColor> Pixels;
		FIntVector Size(0, 0, 0);
		if (!FSlateApplication::Get().TakeScreenshot(Widget, Pixels, Size) || Size.X <= 0 || Size.Y <= 0)
		{
			OutErrorCode = TEXT("CAPTURE_FAILED");
			OutErrorMessage = TEXT("FSlateApplication::TakeScreenshot produced no pixels for this widget");
			return false;
		}
		if (Pixels.Num() < Size.X * Size.Y)
		{
			OutErrorCode = TEXT("CAPTURE_FAILED");
			OutErrorMessage = FString::Printf(
				TEXT("TakeScreenshot returned %d pixels for a %dx%d widget"), Pixels.Num(), Size.X, Size.Y);
			return false;
		}
		OutSize = FIntPoint(Size.X, Size.Y);
		const FImageView View(Pixels.GetData(), OutSize.X, OutSize.Y);
		FImageUtils::CompressImage(OutPng, TEXT("png"), View, 0);
		if (OutPng.Num() == 0)
		{
			OutErrorCode = TEXT("CAPTURE_FAILED");
			OutErrorMessage = TEXT("PNG compression produced an empty buffer");
			return false;
		}
		return true;
	}

	bool FinishCapture(
		const TArray64<uint8>& Png,
		const FIntPoint& Size,
		const FString& OutputPath,
		bool bInline,
		const TSharedPtr<FJsonObject>& Result,
		FString& OutErrorMessage)
	{
		const FString OutputDir = FPaths::GetPath(OutputPath);
		if (!OutputDir.IsEmpty())
		{
			IFileManager::Get().MakeDirectory(*OutputDir, true);
		}
		if (!FFileHelper::SaveArrayToFile(Png, *OutputPath))
		{
			OutErrorMessage = FString::Printf(TEXT("Failed to write PNG to '%s'"), *OutputPath);
			return false;
		}

		Result->SetNumberField(TEXT("width"), Size.X);
		Result->SetNumberField(TEXT("height"), Size.Y);
		Result->SetNumberField(TEXT("byte_length"), Png.Num());
		Result->SetStringField(TEXT("mime"), TEXT("image/png"));
		Result->SetStringField(TEXT("png_path"), OutputPath);
		if (bInline)
		{
			const int64 Base64Length = ((static_cast<int64>(Png.Num()) + 2) / 3) * 4;
			if (Base64Length > InlineBase64MaxBytes)
			{
				Result->SetStringField(TEXT("inline_omitted"), TEXT("too_large"));
			}
			else
			{
				Result->SetStringField(TEXT("png_base64"),
					FBase64::Encode(Png.GetData(), static_cast<uint32>(Png.Num())));
			}
		}
		return true;
	}

	IDetailsView* FindDetailsViewInTab(const TSharedPtr<SDockTab>& Tab)
	{
		if (!Tab.IsValid())
		{
			return nullptr;
		}
		const TSharedPtr<SWidget> Found = FindDescendantByType(Tab->GetContent(), TEXT("SDetailsView"));
		return Found.IsValid() ? static_cast<IDetailsView*>(Found.Get()) : nullptr;
	}

	bool ResolveDetailsView(
		const FString& AssetPath,
		const FString& TabId,
		IDetailsView*& OutView,
		FString& OutErrorCode,
		FString& OutErrorMessage)
	{
		OutView = nullptr;
		const FAssetEditorTarget Target = ResolveAssetEditorTarget(AssetPath);
		if (!Target.ErrorCode.IsEmpty())
		{
			OutErrorCode = Target.ErrorCode;
			OutErrorMessage = Target.ErrorMessage;
			return false;
		}
		const TSharedPtr<SDockTab> Tab = Target.TabManager.IsValid()
			? Target.TabManager->FindExistingLiveTab(FTabId(FName(*TabId)))
			: nullptr;
		if (!Tab.IsValid())
		{
			OutErrorCode = TEXT("TAB_NOT_FOUND");
			OutErrorMessage = FString::Printf(
				TEXT("No live tab '%s' in the editor for '%s'"), *TabId, *AssetPath);
			return false;
		}
		OutView = FindDetailsViewInTab(Tab);
		if (!OutView)
		{
			OutErrorCode = TEXT("NOT_A_DETAILS_PANEL");
			OutErrorMessage = FString::Printf(TEXT("Tab '%s' contains no SDetailsView"), *TabId);
			return false;
		}
		return true;
	}
}
