// Static source and registry checks for visual-capture plugin handlers.
//
// Run: cd server && node test-visual-capture-source.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';

import { REPO_ROOT, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Visual Capture Source Checks');
const source = readFileSync(join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'VisualCaptureHandler.cpp'), 'utf8');
const header = readFileSync(join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Public', 'VisualCaptureHandler.h'), 'utf8');

function functionBody(name, nextName) {
  const start = source.indexOf(name);
  const end = nextName ? source.indexOf(nextName, start + name.length) : source.indexOf('void RegisterVisualCaptureHandler', start + name.length);
  if (start === -1 || end === -1 || end <= start) return '';
  return source.slice(start, end);
}

const assetPreviewBody = functionBody('HandleGetAssetPreviewRender', 'HandleGetViewportScreenshot');
const viewportScreenshotBody = functionBody('HandleGetViewportScreenshot', 'void RegisterVisualCaptureHandler');

t.assert(source.includes('HandleGetViewportScreenshot'),
  'visual capture source defines get_viewport_screenshot handler');
t.assert(source.includes('Registry.Register(TEXT("get_viewport_screenshot")'),
  'visual capture registers get_viewport_screenshot');
t.assert(source.includes('FImageUtils::ImageResize'),
  'viewport screenshot path resizes bounded output');
t.assert(source.includes('FImageUtils::CompressImage'),
  'viewport screenshot path compresses PNG through FImageUtils::CompressImage');
t.assert(source.includes('Viewport->ReadPixels'),
  'viewport screenshot path reads active viewport pixels');
t.assert(source.includes('FPaths::ProjectSavedDir()'),
  'viewport screenshot relative output paths resolve under ProjectSavedDir');
// Task 6: output_path now routes through the shared ResolveCaptureOutputPath
// (AssetEditorCapture.cpp), which appends .png when missing and refuses paths
// outside the project — the inline append/relative-resolve block is gone.
t.assert(viewportScreenshotBody.includes('UEMCP::ResolveCaptureOutputPath(OutputFilePath, TEXT("Viewport")') &&
  viewportScreenshotBody.includes('CAPTURE_PATH_OUTSIDE_PROJECT'),
  'viewport screenshot routes output_path through the shared resolver before any viewport lookup');
const assetEditorCaptureSourceForPngAppend = readFileSync(
  join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'AssetEditorCapture.cpp'), 'utf8');
t.assert(assetEditorCaptureSourceForPngAppend.includes('Candidate.EndsWith(TEXT(".png"))') &&
  assetEditorCaptureSourceForPngAppend.includes('Candidate += TEXT(".png")'),
  'the shared resolver appends .png to a requested output path when missing');
t.assert(!assetPreviewBody.includes('OutputFilePath += TEXT(".png")'),
  'asset preview render does not append .png to JPEG output_path');
t.assert(source.includes('TEXT("image/png")'),
  'viewport screenshot response labels image/png');

t.assert(header.includes('get_viewport_screenshot'),
  'VisualCaptureHandler.h documents get_viewport_screenshot');
t.assert(header.includes('source_width') && header.includes('source_height'),
  'VisualCaptureHandler.h documents source viewport dimensions');

// ── tools.yaml registry: the EN-24/EN-25 entries ──────────────
// The removed capture_active_editor_tab was status: planned and never
// registered; capture_asset_editor supersedes it. Pinning its absence keeps a
// future editor from reviving a tool with no handler behind it.
const toolsYaml = load(readFileSync(join(REPO_ROOT, 'tools.yaml'), 'utf8'));
const visualCapture = toolsYaml.toolsets['visual-capture'].tools;

t.assert(visualCapture.capture_active_editor_tab === undefined,
  'capture_active_editor_tab is removed from the visual-capture toolset');
for (const name of [
  'list_asset_editor_tabs',
  'capture_asset_editor',
  'details_panel_expand_all',
  'details_panel_scroll',
  'capture_pie_viewport',
]) {
  t.assert(visualCapture[name]?.status === 'shipped',
    `${name} is declared shipped in the visual-capture toolset`);
}
t.assert(visualCapture.capture_asset_editor.params.out_png !== undefined &&
  visualCapture.capture_asset_editor.params.inline !== undefined,
  'capture_asset_editor declares the spec param names out_png and inline');
t.assert(visualCapture.details_panel_scroll.params.row_offset?.required === true,
  'details_panel_scroll requires row_offset');
t.assert(visualCapture.capture_pie_viewport.requires_pie === true,
  'capture_pie_viewport declares requires_pie');

// ── EN-24: asset-editor capture handler source ────────────────
const captureHeader = readFileSync(join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Public', 'AssetEditorCapture.h'), 'utf8');
const captureHelpers = readFileSync(join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'AssetEditorCapture.cpp'), 'utf8');
const captureHandlers = readFileSync(join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'AssetEditorCaptureHandler.cpp'), 'utf8');
const commandRegistry = readFileSync(join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'MCPCommandRegistry.cpp'), 'utf8');

t.assert(captureHeader.includes('void RegisterAssetEditorCaptureHandlers(FMCPCommandRegistry& Registry);'),
  'AssetEditorCapture.h declares the registration entry point');
t.assert(captureHandlers.includes('Registry.Register(TEXT("list_asset_editor_tabs")'),
  'asset-editor capture registers list_asset_editor_tabs');
t.assert(captureHandlers.includes('Registry.Register(TEXT("capture_asset_editor")'),
  'asset-editor capture registers capture_asset_editor');
t.assert(commandRegistry.includes('#include "AssetEditorCapture.h"') &&
  commandRegistry.includes('RegisterAssetEditorCaptureHandlers(*this);'),
  'the command registry wires the asset-editor capture family');
t.assert(captureHelpers.includes('FindEditorForAsset(Target.Asset, /*bFocusIfOpen*/ false)'),
  'editor lookup never steals focus');
t.assert(captureHelpers.includes('FindExistingLiveTab') && !captureHelpers.includes('TryInvokeTab'),
  'tabs are resolved, never opened');

// Validation order is load-bearing: under -nullrhi every capture ends in
// CAPTURE_UNSUPPORTED, so gating on the renderer before addressing would make
// ASSET_NOT_FOUND / EDITOR_NOT_OPEN / TAB_NOT_FOUND unreachable headless.
const captureBody = captureHandlers.slice(captureHandlers.indexOf('void HandleCaptureAssetEditor'));
t.assert(captureBody.indexOf('ResolveCaptureTab') < captureBody.indexOf('CaptureWidgetToPng'),
  'capture_asset_editor resolves the tab before it reaches the renderer gate');

t.assert(captureHelpers.includes('FSlateApplication::Get().TakeScreenshot('),
  'asset-editor capture reads pixels through FSlateApplication::TakeScreenshot');
t.assert(captureHelpers.includes('FApp::CanEverRender()'),
  'the renderer gate is FApp::CanEverRender, which is false under -nullrhi');
t.assert(captureHeader.includes('InlineBase64MaxBytes = 8 * 1024 * 1024') &&
  captureHelpers.includes('inline_omitted'),
  'the 8 MiB inline cap is declared and enforced');

// ── EN-24/EN-25: details paging and PIE capture source ────────
const buildCs = readFileSync(join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'UEMCP.Build.cs'), 'utf8');

t.assert(captureHandlers.includes('Registry.Register(TEXT("details_panel_expand_all")'),
  'asset-editor capture registers details_panel_expand_all');
t.assert(captureHandlers.includes('Registry.Register(TEXT("details_panel_scroll")'),
  'asset-editor capture registers details_panel_scroll');
t.assert(captureHandlers.includes('Registry.Register(TEXT("capture_pie_viewport")'),
  'asset-editor capture registers capture_pie_viewport');

// Exact type-name match only: SActorDetails, SStructureDetailsView and
// SSingleProperty all read as details-ish and none is an IDetailsView, so a
// substring match would make the downcast undefined.
t.assert(captureHelpers.includes('FindDescendantByType(Tab->GetContent(), TEXT("SDetailsView"))'),
  'the details view is found by exact widget type name');

// SetRootExpansionStates is private on 5.6 (Editor/PropertyEditor/Private).
t.assert(captureHandlers.includes('ShowAllAdvancedProperties()') &&
  captureHandlers.includes('ScrollPropertyIntoView(Path, /*bExpandProperty*/ true)'),
  'expand-all goes through the public IDetailsView interface');
// Matched as a call through the view pointer, not as a bare name: the handler's
// comment explains why the private API is avoided and names it to do so.
t.assert(!captureHandlers.includes('View->SetRootExpansionStates'),
  'no call into the private SDetailsViewBase expansion API');
t.assert(captureHandlers.includes('GetPropertyRowNumbers()') &&
  !captureHandlers.includes('SetScrollOffset'),
  'details paging scrolls by row, not by pixel offset');

const pieBody = captureHandlers.slice(captureHandlers.indexOf('void HandleCapturePieViewport'));
t.assert(pieBody.indexOf('GEditor->PlayWorld') < pieBody.indexOf('FApp::CanEverRender()'),
  'PIE state is checked before the renderer gate');
t.assert(buildCs.includes('"PropertyEditor"'),
  'PropertyEditor is a module dependency');

process.exit(t.summary());
