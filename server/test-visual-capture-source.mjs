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
t.assert(viewportScreenshotBody.includes('OutputFilePath.EndsWith(TEXT(".png"))') &&
  viewportScreenshotBody.includes('OutputFilePath += TEXT(".png")'),
  'viewport screenshot appends .png to output_path when missing');
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

process.exit(t.summary());
