// Copyright Noah Butcher. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Framework/Docking/TabManager.h"
#include "Widgets/Docking/SDockTab.h"

class IAssetEditorInstance;

/**
 * EN-24/EN-25: capture an open asset editor, page its Details panel, and
 * capture the PIE viewport.
 *
 * get_viewport_screenshot reads GEditor->GetActiveViewport(), which the engine
 * resolves to the level-editor viewport, so no asset editor is reachable
 * through it. These handlers address an editor explicitly by asset path.
 *
 * Nothing here opens anything. FindEditorForAsset is called with
 * bFocusIfOpen = false and tabs are resolved with FindExistingLiveTab, never
 * TryInvokeTab: a capture that reorders the user's tabs or steals focus is a
 * side effect a read-shaped tool must not have.
 *
 * These helpers live in a Public/ header for two reasons. Unity bundling makes
 * a duplicated anonymous-namespace symbol a link error (D133/D137), and
 * Private/Tests/*.cpp can only include Public/ headers, so anything a native
 * test needs to reach has to be declared here.
 *
 * Response shapes:
 *   list_asset_editor_tabs
 *     { asset_path, editor_class, tabs: [{ tab_id, display_name, is_active, has_viewport }] }
 *   capture_asset_editor / capture_pie_viewport
 *     { [asset_path, tab_id,] width, height, byte_length, mime, png_path,
 *       png_base64?, inline_omitted? }
 *   details_panel_expand_all   { expanded, rows_before, rows_after }
 *   details_panel_scroll       { row_offset, requested_row_offset, max_row_offset }
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/**
	 * Ceiling on the inline base64 payload, measured on the encoded string
	 * because that is what actually travels. Above it the capture still writes
	 * its file and the response says inline_omitted = "too_large" — a caller
	 * that asked for inline needs to be told it did not get it.
	 */
	constexpr int64 InlineBase64MaxBytes = 8 * 1024 * 1024;

	/** One live tab of an open asset editor. */
	struct FAssetEditorTabInfo
	{
		FString TabId;
		FString DisplayName;
		bool bIsActive = false;
		bool bHasViewport = false;
	};

	/**
	 * Resolution result shared by every handler here. A non-empty ErrorCode
	 * means the other fields are meaningless; the handler builds the error
	 * envelope from ErrorCode + ErrorMessage and returns.
	 */
	struct FAssetEditorTarget
	{
		UObject* Asset = nullptr;
		IAssetEditorInstance* Editor = nullptr;
		TSharedPtr<FTabManager> TabManager;
		FString ErrorCode;
		FString ErrorMessage;
	};

	/**
	 * Asset path -> already-open editor. Returns ASSET_NOT_FOUND when the path
	 * does not load and EDITOR_NOT_OPEN when no editor is open for it.
	 * Never opens an editor.
	 */
	FAssetEditorTarget ResolveAssetEditorTarget(const FString& AssetPath);

	/**
	 * Live tabs of the toolkit, from its registered spawners.
	 *
	 * FTabManager exposes no "enumerate live tabs" call, so this walks
	 * CollectSpawners() and keeps the ids FindExistingLiveTab answers for.
	 * CollectSpawners is documented as the spawners that get Window-menu
	 * entries, so a toolkit that hides a spawner will not have that tab listed
	 * — capture_asset_editor still accepts such an id, because it resolves
	 * through FindExistingLiveTab rather than through this list.
	 */
	void CollectAssetEditorTabs(const TSharedPtr<FTabManager>& TabManager, TArray<FAssetEditorTabInfo>& OutTabs);

	/**
	 * The tab to capture. A non-empty TabId is looked up directly; an empty one
	 * prefers the globally active tab when it belongs to this editor and
	 * otherwise takes the editor's first live tab. Returns null when nothing
	 * matches, which the caller reports as TAB_NOT_FOUND.
	 */
	TSharedPtr<SDockTab> ResolveCaptureTab(const FAssetEditorTarget& Target, const FString& TabId);

	/**
	 * Breadth-first search of a Slate subtree for an exact widget type name.
	 * SNew stamps the stringized type onto SWidget::TypeOfWidget, so the match
	 * is on the concrete class and nothing else. Bounded so a pathological
	 * layout cannot spin the game thread.
	 */
	TSharedPtr<SWidget> FindDescendantByType(const TSharedPtr<SWidget>& Root, FName TypeName);

	/**
	 * Whether Slate can produce pixels at all. False under -nullrhi, where
	 * TakeScreenshot returns an empty buffer rather than failing — so headless
	 * automation must be told CAPTURE_UNSUPPORTED, not handed a blank PNG.
	 */
	bool CanCaptureSlate();

	/** Saved/UEMCP/Captures/<Stem>_<YYYYMMDD-HHMMSS>-<ms>.png, absolute. */
	FString DefaultCapturePath(const FString& Stem);

	/** Widget -> PNG bytes. Sets CAPTURE_UNSUPPORTED or CAPTURE_FAILED on failure. */
	bool CaptureWidgetToPng(
		const TSharedRef<SWidget>& Widget,
		TArray64<uint8>& OutPng,
		FIntPoint& OutSize,
		FString& OutErrorCode,
		FString& OutErrorMessage);

	/**
	 * Writes the PNG and fills the shared result fields (width, height,
	 * byte_length, mime, png_path, and png_base64 or inline_omitted). The file
	 * is always written: the path is the fallback the inline cap relies on.
	 */
	bool FinishCapture(
		const TArray64<uint8>& Png,
		const FIntPoint& Size,
		const FString& RequestedPath,
		const FString& DefaultStem,
		bool bInline,
		const TSharedPtr<FJsonObject>& Result,
		FString& OutErrorMessage);

	void RegisterAssetEditorCaptureHandlers(FMCPCommandRegistry& Registry);
}
