// Copyright Noah Butcher. All Rights Reserved.
#include "AssetEditorCapture.h"

#include "Engine/Engine.h"
#include "Engine/GameViewportClient.h"
#include "Engine/World.h"
#include "IDetailsView.h"
#include "ImageUtils.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "Misc/App.h"
#include "Misc/Paths.h"
#include "PropertyPath.h"
#include "Toolkits/IToolkit.h"
#include "UnrealClient.h"
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
			bool bInline = false;
			Params->TryGetBoolField(TEXT("inline"), bInline);
			FString RequestedPath;
			Params->TryGetStringField(TEXT("out_png"), RequestedPath);

			// A caller-supplied path is checked before any editor lookup so an
			// escaping path is refused even when nothing is open.
			FString OutputPath;
			FString PathError;
			if (!RequestedPath.IsEmpty() && !ResolveCaptureOutputPath(RequestedPath, TEXT(""), OutputPath, PathError))
			{
				BuildErrorResponse(OutResponse, PathError, TEXT("CAPTURE_PATH_OUTSIDE_PROJECT"));
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

			const FString ResolvedTabId = Tab->GetLayoutIdentifier().TabType.ToString();
			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), Target.Asset->GetPathName());
			Result->SetStringField(TEXT("tab_id"), ResolvedTabId);

			const FString Stem = FString::Printf(TEXT("%s_%s"),
				*FPaths::GetBaseFilename(AssetPath), *ResolvedTabId);
			if (OutputPath.IsEmpty())
			{
				OutputPath = DefaultCapturePath(Stem);
			}
			if (!FinishCapture(Png, Size, OutputPath, bInline, Result, ErrorMessage))
			{
				BuildErrorResponse(OutResponse, ErrorMessage, TEXT("FILE_WRITE_FAILED"));
				return;
			}
			BuildSuccessResponse(OutResponse, Result);
		}

		/** Reads asset_path + tab_id, or emits MISSING_PARAMS. */
		bool ReadDetailsParams(
			const TCHAR* ToolName,
			const TSharedPtr<FJsonObject>& Params,
			FString& OutAssetPath,
			FString& OutTabId,
			TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid()
				|| !Params->TryGetStringField(TEXT("asset_path"), OutAssetPath) || OutAssetPath.IsEmpty()
				|| !Params->TryGetStringField(TEXT("tab_id"), OutTabId) || OutTabId.IsEmpty())
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("%s requires non-empty asset_path and tab_id"), ToolName),
					TEXT("MISSING_PARAMS"));
				return false;
			}
			return true;
		}

		void HandleDetailsPanelExpandAll(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString AssetPath;
			FString TabId;
			if (!ReadDetailsParams(TEXT("details_panel_expand_all"), Params, AssetPath, TabId, OutResponse))
			{
				return;
			}
			IDetailsView* View = nullptr;
			FString ErrorCode;
			FString ErrorMessage;
			if (!ResolveDetailsView(AssetPath, TabId, View, ErrorCode, ErrorMessage))
			{
				BuildErrorResponse(OutResponse, ErrorMessage, ErrorCode);
				return;
			}

			const int32 RowsBefore = View->CountRows();
			// UE 5.6 exposes no public expand-all: SetRootExpansionStates is
			// declared in Editor/PropertyEditor/Private/SDetailsViewBase.h and
			// is not on IDetailsView. ShowAllAdvancedProperties clears the
			// advanced filter, and ScrollPropertyIntoView(Path, true) expands
			// the node and every ancestor (SDetailsViewBase.cpp), so walking
			// the displayed paths reaches the same end state publicly.
			// Advanced rows land on the next editor tick, which the caller's
			// next command is already past.
			View->ShowAllAdvancedProperties();
			View->ForceRefresh();
			for (const FPropertyPath& Path : View->GetPropertiesInOrderDisplayed())
			{
				View->ScrollPropertyIntoView(Path, /*bExpandProperty*/ true);
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetBoolField(TEXT("expanded"), true);
			Result->SetNumberField(TEXT("rows_before"), RowsBefore);
			Result->SetNumberField(TEXT("rows_after"), View->CountRows());
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleDetailsPanelScroll(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString AssetPath;
			FString TabId;
			if (!ReadDetailsParams(TEXT("details_panel_scroll"), Params, AssetPath, TabId, OutResponse))
			{
				return;
			}
			int32 RowOffset = 0;
			if (!Params->TryGetNumberField(TEXT("row_offset"), RowOffset) || RowOffset < 0)
			{
				BuildErrorResponse(OutResponse,
					TEXT("details_panel_scroll requires a non-negative row_offset"), TEXT("MISSING_PARAMS"));
				return;
			}
			IDetailsView* View = nullptr;
			FString ErrorCode;
			FString ErrorMessage;
			if (!ResolveDetailsView(AssetPath, TabId, View, ErrorCode, ErrorMessage))
			{
				BuildErrorResponse(OutResponse, ErrorMessage, ErrorCode);
				return;
			}

			// IDetailsView has no pixel scroll on 5.6: GetScrollWidget returns
			// the details view itself, not the row tree, and SDetailTree is a
			// private type. Rows are addressed instead — GetPropertyRowNumbers
			// maps row number to property path, and one ScrollPropertyIntoView
			// brings the first row at or after the offset into view. That also
			// makes row_offset stable across DPI and panel size.
			const int32 MaxRowOffset = FMath::Max(0, View->CountRows() - 1);
			const int32 Clamped = FMath::Clamp(RowOffset, 0, MaxRowOffset);
			int32 Landed = INDEX_NONE;
			// GetPropertyRowNumbers() returns TArray<TPair<int32, FPropertyPath>>
			// BY VALUE, so the range-for's temporary is torn down at the end of
			// this loop. A pointer into it would dangle the moment the loop
			// exits, so the landed path is copied out instead.
			FPropertyPath LandedPath;
			bool bFoundRow = false;
			for (const TPair<int32, FPropertyPath>& Row : View->GetPropertyRowNumbers())
			{
				if (Row.Key >= Clamped && (Landed == INDEX_NONE || Row.Key < Landed))
				{
					Landed = Row.Key;
					LandedPath = Row.Value;
					bFoundRow = true;
				}
			}
			if (bFoundRow)
			{
				View->ScrollPropertyIntoView(LandedPath, /*bExpandProperty*/ false);
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetNumberField(TEXT("row_offset"), Landed == INDEX_NONE ? Clamped : Landed);
			Result->SetNumberField(TEXT("requested_row_offset"), RowOffset);
			Result->SetNumberField(TEXT("max_row_offset"), MaxRowOffset);
			Result->SetBoolField(TEXT("scrolled"), bFoundRow);
			BuildSuccessResponse(OutResponse, Result);
		}

		void HandleCapturePieViewport(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			bool bInline = false;
			FString RequestedPath;
			if (Params.IsValid())
			{
				Params->TryGetBoolField(TEXT("inline"), bInline);
				Params->TryGetStringField(TEXT("out_png"), RequestedPath);
			}

			// A caller-supplied path is checked before any PIE lookup so an
			// escaping path is refused even when no PIE session is running.
			FString OutputPath;
			FString PathError;
			if (!ResolveCaptureOutputPath(RequestedPath, TEXT("PIE"), OutputPath, PathError))
			{
				BuildErrorResponse(OutResponse, PathError, TEXT("CAPTURE_PATH_OUTSIDE_PROJECT"));
				return;
			}

			// PIE state is checked before the renderer gate for the same reason
			// the asset-editor path resolves addressing first: PIE_NOT_RUNNING
			// must stay reachable under -nullrhi.
			if (!GEditor || !GEditor->PlayWorld)
			{
				BuildErrorResponse(OutResponse, TEXT("No PIE session is running"), TEXT("PIE_NOT_RUNNING"));
				return;
			}
			FViewport* Viewport = (GEngine && GEngine->GameViewport) ? GEngine->GameViewport->Viewport : nullptr;
			if (!Viewport)
			{
				BuildErrorResponse(OutResponse,
					TEXT("PIE is running but has no game viewport"), TEXT("PIE_NOT_RUNNING"));
				return;
			}
			if (!FApp::CanEverRender())
			{
				BuildErrorResponse(OutResponse,
					TEXT("No renderer is available (headless or -nullrhi)"), TEXT("CAPTURE_UNSUPPORTED"));
				return;
			}

			const FIntPoint Size = Viewport->GetSizeXY();
			TArray<FColor> Bitmap;
			if (Size.X <= 0 || Size.Y <= 0
				|| !Viewport->ReadPixels(Bitmap, FReadSurfaceDataFlags(), FIntRect(0, 0, Size.X, Size.Y))
				|| Bitmap.Num() < Size.X * Size.Y)
			{
				BuildErrorResponse(OutResponse, TEXT("PIE viewport ReadPixels failed"), TEXT("CAPTURE_FAILED"));
				return;
			}
			TArray64<uint8> Png;
			const FImageView View(Bitmap.GetData(), Size.X, Size.Y);
			FImageUtils::CompressImage(Png, TEXT("png"), View, 0);
			if (Png.Num() == 0)
			{
				BuildErrorResponse(OutResponse,
					TEXT("PNG compression produced an empty buffer"), TEXT("CAPTURE_FAILED"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			FString ErrorMessage;
			if (!FinishCapture(Png, Size, OutputPath, bInline, Result, ErrorMessage))
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
		Registry.Register(TEXT("details_panel_expand_all"), &HandleDetailsPanelExpandAll);
		Registry.Register(TEXT("details_panel_scroll"), &HandleDetailsPanelScroll);
		Registry.Register(TEXT("capture_pie_viewport"), &HandleCapturePieViewport);
	}
}
