# Asset-editor and PIE capture, and editor identity on the wire (EN-24, EN-25)

Date: 2026-09-13. Status: approved for planning (decided by the orchestrator under the standing "proceed" instruction; assumptions in §7). Source: a cross-session request from a session building an asset-editor plugin in a private UE 5.8 host project, recorded as backlog EN-24 and EN-25 on 2026-09-13; its engine-API claims were verified by the requester on 5.8 and must be re-verified on 5.6 during implementation.

## 1. Problem

`get_viewport_screenshot` reads `GEditor->GetActiveViewport()` (`VisualCaptureHandler.cpp`, around line 182), which the engine resolves to the first active level-editor viewport. Nothing in UEMCP can capture an asset editor (an `FAssetEditorToolkit` with its own `SEditorViewport`, Details tab, or timeline), and when PIE runs in its own window the same tool still returns the level-editor view. `capture_active_editor_tab` sits in `tools.yaml` as `status: planned` behind an `FWidgetRenderer` path that never shipped. Separately, when two editor instances run on one machine, port 55558 can be answered by the wrong one: the plugin sets `SetReuseAddr(true)` before `Listen()` (`UEMCPModule.cpp`, around line 42), so a second instance binds alongside the first and the OS picks who answers.

## 2. Goals

1. Capture any open asset editor, or one of its tabs, to PNG, addressed by asset path and optional tab id.
2. List an open asset editor's tabs so a caller can address them.
3. Page a long Details panel for review captures (expand all, scroll by row offset).
4. Capture the PIE viewport when PIE runs in its own window.
5. Refuse to treat a listener as "the editor" when its identity does not match the attached project.

Non-goals: a per-project TCP port (deferred; recorded in §7), capturing editors that are not open (no auto-open), video, or any change to `get_viewport_screenshot`'s existing behaviour.

## 3. Tools (all TCP:55558, toolset `visual-capture`)

| Tool | Params | Result | Errors |
|---|---|---|---|
| `list_asset_editor_tabs` | `asset_path` | `{ asset_path, editor_class, tabs: [{ tab_id, display_name, is_active, has_viewport }] }` | `ASSET_NOT_FOUND`, `EDITOR_NOT_OPEN` |
| `capture_asset_editor` | `asset_path`, `tab_id?`, `out_png?`, `inline?` (default false) | `{ asset_path, tab_id, width, height, png_path?, png_base64? }` | `ASSET_NOT_FOUND`, `EDITOR_NOT_OPEN`, `TAB_NOT_FOUND`, `CAPTURE_FAILED`, `CAPTURE_UNSUPPORTED` (no renderer, e.g. `-nullrhi`) |
| `details_panel_expand_all` | `asset_path`, `tab_id` | `{ expanded: true }` | as above plus `NOT_A_DETAILS_PANEL` |
| `details_panel_scroll` | `asset_path`, `tab_id`, `row_offset` | `{ row_offset, max_row_offset }` | as above |
| `capture_pie_viewport` | `out_png?`, `inline?` | `{ width, height, png_path?, png_base64? }` | `PIE_NOT_RUNNING`, `CAPTURE_FAILED`, `CAPTURE_UNSUPPORTED` |

`capture_active_editor_tab` is removed from `tools.yaml` (it was never registered) and its intent is superseded by `capture_asset_editor`. `out_png` defaults to a file under the project's `Saved/UEMCP/Captures/` with a timestamped name; `inline: true` adds base64 and is capped at 8 MiB per the wire limit (larger captures return the path only with `inline_omitted: "too_large"`).

## 4. Plugin design

New `Private/AssetEditorCaptureHandler.cpp` (keeps `VisualCaptureHandler.cpp` untouched except for registering the PIE tool if it is simpler there), shared helpers in `Public/AssetEditorCapture.h` per the anonymous-namespace rule:

- Resolve the toolkit: `UAssetEditorSubsystem::FindEditorForAsset(Asset, /*bFocusIfOpen*/ false)`; the asset itself via the existing `ResolveBlueprint`/`LoadObject` conventions (`HandlerCommon.h`), returning `EDITOR_NOT_OPEN` when the subsystem has no editor.
- Tabs: the toolkit's `TabManager` — enumerate live tabs (`FindExistingLiveTab` per known id; the plan decides between walking the tab manager's layout and probing the toolkit's registered tab ids), report `display_name` from the tab's label, `is_active` from the tab manager's active tab, `has_viewport` when the content contains an `SEditorViewport`.
- Capture: `FSlateApplication::Get().TakeScreenshot(Widget, OutColorData, OutSize)` on the toolkit's viewport widget or the tab's content widget; encode with `FImageUtils::PNGCompressImageArray` (or `ThumbnailCompressImageArray`); write with `FFileHelper`. Under `-nullrhi` the call cannot produce pixels: detect (`FSlateApplication::IsInitialized()` and a renderer present) and return `CAPTURE_UNSUPPORTED` rather than an empty image, so headless automation tests can assert the error path.
- Details paging: `IDetailsView::SetRootExpansionStates(true, true)`; scrolling via the `STableViewBase` descendant of the details view (the requester notes `GetScrollWidget()` returns the details view itself, not the tree) using `SetScrollOffset`.
- PIE: `GEngine->GameViewport->Viewport` when `GEditor->PlayWorld` is set; read pixels with `FViewport::ReadPixels` after `Draw`; same PNG path.
- All handlers marshal to the game thread through the existing `MCPThreadMarshal` pattern the other handlers use.

## 5. Editor identity (EN-25, server side)

`wait_for_editor` and `connection_info` already learn the listener's identity through `get_editor_state` (project name and path). Change: `wait_for_editor` treats a reachable listener whose reported project path is not the attached project's path as **not ready**, returning `EDITOR_IDENTITY_MISMATCH` with both paths, instead of `ready`; `connection_info` reports `identity_mismatch: true` in the same case. No plugin change. The per-project port stays deferred: it needs a config surface in `.uemcp-targets.json`, `.mcp.json`, and the plugin's `Listen()`, and the identity check removes the dangerous outcome (acting on the wrong editor) at a fraction of the cost.

## 6. Testing

- Native automation tests (`Private/Tests/AssetEditorCaptureTests.cpp`): every error path reachable headless: `ASSET_NOT_FOUND`, `EDITOR_NOT_OPEN` (a loaded asset with no editor), `TAB_NOT_FOUND` after opening an editor for a transient Blueprint via `UAssetEditorSubsystem::OpenEditorForAsset` (verify this works under `-nullrhi`; if it does not, record the skip and rely on the live smoke), `CAPTURE_UNSUPPORTED` under `-nullrhi`, `PIE_NOT_RUNNING`, and `list_asset_editor_tabs` returning at least the Details tab for an opened Blueprint editor.
- Rotation: `tools.yaml` entries and params, handler wiring in the visual-capture module, error-shape assertions through the mock seam, the `wait_for_editor` identity rule with a fake responder that reports a foreign project path.
- Live smoke (`live-smoke-asset-editor-capture.mjs`, editor optional like the others): with a GUI editor open on the sample 5.6 target and one Blueprint editor open, `list_asset_editor_tabs` returns tabs, `capture_asset_editor` writes a PNG with non-zero size, `details_panel_expand_all` and `details_panel_scroll` succeed on the Details tab, and, with PIE started in a new window, `capture_pie_viewport` writes a PNG. The smoke is the only proof of pixels; the native suite proves addressing and error handling.

## 7. Assumptions and deferrals

- The 5.6 and 5.8 APIs named above match (the requester verified 5.8; `TakeScreenshot`, `FindEditorForAsset`, and `SetRootExpansionStates` exist in 5.6 and are checked in the plan's first task by grepping the engine headers under `<UE_ENGINE_ROOT>/Engine/Source`).
- A GUI editor session on the sample 5.6 target can be opened for the live smoke at the end; the headless target proves everything else.
- The per-project port is deferred to a future entry; EN-25's identity rule is the accepted fix.
- Requester's reference implementation lives in the private 5.8 host project's test module; the plan's author may read it for API details but never copies project names or paths into tracked files.
