// Copyright Noah Butcher. All Rights Reserved.
#include "AssetEditorCapture.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "Misc/Paths.h"
#include "Toolkits/IToolkit.h"
#include "UObject/Object.h"

// No per-handler game-thread marshal: FMCPCommandRegistry::Dispatch already
// wraps every handler in RunOnGameThread (the Audit F-1 fix), so these run on
// the game thread by construction.
namespace UEMCP
{
	namespace
	{
		void HandleListAssetEditorTabs(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString AssetPath;
			if (!Params.IsValid() || !Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse,
					TEXT("list_asset_editor_tabs requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			const FAssetEditorTarget Target = ResolveAssetEditorTarget(AssetPath);
			if (!Target.ErrorCode.IsEmpty())
			{
				BuildErrorResponse(OutResponse, Target.ErrorMessage, Target.ErrorCode);
				return;
			}

			TArray<FAssetEditorTabInfo> Tabs;
			CollectAssetEditorTabs(Target.TabManager, Tabs);

			TArray<TSharedPtr<FJsonValue>> TabValues;
			for (const FAssetEditorTabInfo& Tab : Tabs)
			{
				TSharedPtr<FJsonObject> Entry = MakeShared<FJsonObject>();
				Entry->SetStringField(TEXT("tab_id"), Tab.TabId);
				Entry->SetStringField(TEXT("display_name"), Tab.DisplayName);
				Entry->SetBoolField(TEXT("is_active"), Tab.bIsActive);
				Entry->SetBoolField(TEXT("has_viewport"), Tab.bHasViewport);
				TabValues.Add(MakeShared<FJsonValueObject>(Entry));
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), Target.Asset->GetPathName());
			Result->SetStringField(TEXT("editor_class"), Target.Editor->GetEditorName().ToString());
			Result->SetArrayField(TEXT("tabs"), TabValues);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleCaptureAssetEditor(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString AssetPath;
			if (!Params.IsValid() || !Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse,
					TEXT("capture_asset_editor requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			const FAssetEditorTarget Target = ResolveAssetEditorTarget(AssetPath);
			if (!Target.ErrorCode.IsEmpty())
			{
				BuildErrorResponse(OutResponse, Target.ErrorMessage, Target.ErrorCode);
				return;
			}

			FString TabId;
			Params->TryGetStringField(TEXT("tab_id"), TabId);

			// Addressing is resolved BEFORE the renderer gate. Under -nullrhi
			// every capture is CAPTURE_UNSUPPORTED, so gating first would make
			// ASSET_NOT_FOUND, EDITOR_NOT_OPEN and TAB_NOT_FOUND unreachable
			// headless — and those are exactly the paths the native suite can
			// test. The source assertion in test-visual-capture-source.mjs
			// compares the position of the two calls below, so keep the gate's
			// name out of this comment.
			const TSharedPtr<SDockTab> Tab = ResolveCaptureTab(Target, TabId);
			if (!Tab.IsValid())
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("No live tab '%s' in the editor for '%s'"), *TabId, *AssetPath),
					TEXT("TAB_NOT_FOUND"));
				return;
			}

			TArray64<uint8> Png;
			FIntPoint Size(0, 0);
			FString ErrorCode;
			FString ErrorMessage;
			if (!CaptureWidgetToPng(Tab->GetContent(), Png, Size, ErrorCode, ErrorMessage))
			{
				BuildErrorResponse(OutResponse, ErrorMessage, ErrorCode);
				return;
			}

			bool bInline = false;
			Params->TryGetBoolField(TEXT("inline"), bInline);
			FString RequestedPath;
			Params->TryGetStringField(TEXT("out_png"), RequestedPath);

			const FString ResolvedTabId = Tab->GetLayoutIdentifier().TabType.ToString();
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), Target.Asset->GetPathName());
			Result->SetStringField(TEXT("tab_id"), ResolvedTabId);

			const FString Stem = FString::Printf(TEXT("%s_%s"),
				*FPaths::GetBaseFilename(AssetPath), *ResolvedTabId);
			if (!FinishCapture(Png, Size, RequestedPath, Stem, bInline, Result, ErrorMessage))
			{
				BuildErrorResponse(OutResponse, ErrorMessage, TEXT("FILE_WRITE_FAILED"));
				return;
			}
			BuildSuccessResponse(OutResponse, Result);
		}
	}

	void RegisterAssetEditorCaptureHandlers(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("list_asset_editor_tabs"), &HandleListAssetEditorTabs);
		Registry.Register(TEXT("capture_asset_editor"), &HandleCaptureAssetEditor);
	}
}
