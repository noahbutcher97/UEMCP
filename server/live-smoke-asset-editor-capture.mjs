// Opt-in live smoke for EN-24/EN-25 asset-editor, details-panel and PIE capture.
//
// This is the only proof of pixels. The native suite proves addressing and
// error handling; it runs under -nullrhi, where every capture is correctly
// refused as CAPTURE_UNSUPPORTED.
//
// Preconditions:
//   - Unreal Editor is open on the sample 5.6 target with UEMCP loaded.
//   - ONE asset editor is already open for the asset named below. These tools
//     never open an editor, by design — a capture must not reorder the user's
//     tabs or steal focus.
//   - This script runs on the same machine as the editor: it stats the PNG
//     files the plugin writes.
//   - UEMCP_LIVE_SMOKE=1, and an explicit project (smoke-live.bat --project,
//     or UEMCP_LIVE_PROJECT_ROOT).
//   - UEMCP_SMOKE_ASSET_PATH=/Game/... naming the open asset.
//
// Run:
//   $env:UEMCP_LIVE_SMOKE='1'
//   $env:UEMCP_SMOKE_ASSET_PATH='/Game/Some/Open/Asset'
//   ..\smoke-live.bat --project "path\to\YourProject.uproject"

import { statSync } from 'node:fs';

import { executeMenhanceTool } from './menhance-tcp-tools.mjs';
import {
  createLiveSmokeCall,
  prepareLiveSmoke,
  sleep,
  stopPIEAndWaitForStopped,
  unwrapLiveSmokeResponse,
} from './live-smoke-harness.mjs';

const assetPath = (process.env.UEMCP_SMOKE_ASSET_PATH || '').trim();
if (!assetPath) {
  console.error('[live-smoke-asset-editor-capture] BLOCKED_CONFIG: set UEMCP_SMOKE_ASSET_PATH to the /Game/... path of an asset whose editor is already open.');
  process.exit(2);
}

const smoke = await prepareLiveSmoke({ name: 'live-smoke-asset-editor-capture' });
if (!smoke.ready) process.exit(smoke.exitCode);
const { cm } = smoke;

// createLiveSmokeCall's real contract is call(label, fn) where fn is a
// zero-arg function returning the wire promise — it does not take an
// `execute` option. Wrap it so call sites still read as call(name, args).
const rawCall = createLiveSmokeCall({ unwrap: unwrapLiveSmokeResponse });
const call = (name, args) => rawCall(name, () => executeMenhanceTool(name, args, cm));

/** Size on disk, or -1 when the file is not there. A path with no bytes behind
 *  it is the failure this smoke exists to catch. */
function pngBytes(path) {
  try {
    return statSync(path).size;
  } catch {
    return -1;
  }
}

function reportCapture(label, result) {
  const bytes = pngBytes(result.png_path);
  console.log(`[${label}] ${result.width}x${result.height} -> ${result.png_path} (${bytes} bytes on disk, ${result.byte_length} reported)`);
  if (bytes <= 0) {
    throw new Error(`${label}: ${result.png_path} is missing or empty on disk`);
  }
  return bytes;
}

const failures = [];

try {
  // ── 1. tabs ────────────────────────────────────────────────
  const tabs = await call('list_asset_editor_tabs', { asset_path: assetPath });
  console.log(`[tabs] ${tabs.editor_class} for ${tabs.asset_path}`);
  for (const tab of tabs.tabs) {
    console.log(`[tabs]   ${tab.tab_id} — "${tab.display_name}" active=${tab.is_active} viewport=${tab.has_viewport}`);
  }
  if (!Array.isArray(tabs.tabs) || tabs.tabs.length === 0) {
    throw new Error('list_asset_editor_tabs returned no tabs for an open editor');
  }

  // ── 2. capture the active tab ──────────────────────────────
  const activeCapture = await call('capture_asset_editor', { asset_path: assetPath });
  reportCapture('capture-active', activeCapture);

  // ── 3. details paging, then a capture of the paged panel ───
  // The Details tab is found by trying each tab: a tab with no details view
  // answers NOT_A_DETAILS_PANEL, which is information, not a failure.
  let detailsTabId = null;
  for (const tab of tabs.tabs) {
    try {
      const expanded = await call('details_panel_expand_all', { asset_path: assetPath, tab_id: tab.tab_id });
      detailsTabId = tab.tab_id;
      console.log(`[details] ${tab.tab_id} expanded rows ${expanded.rows_before} -> ${expanded.rows_after}`);
      break;
    } catch (err) {
      if (err.code !== 'NOT_A_DETAILS_PANEL') throw err;
    }
  }
  if (!detailsTabId) {
    failures.push('no tab in this editor holds a details view — open an asset whose editor has a Details tab');
  } else {
    const scrolled = await call('details_panel_scroll',
      { asset_path: assetPath, tab_id: detailsTabId, row_offset: 20 });
    console.log(`[details] scrolled to row ${scrolled.row_offset} of ${scrolled.max_row_offset} (requested ${scrolled.requested_row_offset})`);
    const detailsCapture = await call('capture_asset_editor',
      { asset_path: assetPath, tab_id: detailsTabId });
    reportCapture('capture-details', detailsCapture);
    // EN-29 (b): the inline arm has never run outside this smoke. Decode it and
    // hold it to byte_length.
    const inlineCapture = await call('capture_asset_editor',
      { asset_path: assetPath, tab_id: detailsTabId, inline: true });
    reportCapture('capture-details-inline', inlineCapture);
    if (inlineCapture.inline_omitted) {
      console.log(`[inline] omitted: ${inlineCapture.inline_omitted} (${inlineCapture.byte_length} bytes)`);
    } else {
      const decoded = Buffer.from(inlineCapture.png_base64 || '', 'base64');
      if (decoded.length !== inlineCapture.byte_length) {
        throw new Error(`inline PNG decoded to ${decoded.length} bytes but byte_length says ${inlineCapture.byte_length}`);
      }
      console.log(`[inline] png_base64 decodes to ${decoded.length} bytes, matching byte_length`);
    }
    // EN-29 (c): an over-range scroll clamps and says whether it landed on a
    // property row. Whether the last row is a property row depends on the panel,
    // so scrolled is logged and type-checked rather than asserted false.
    const overRange = await call('details_panel_scroll',
      { asset_path: assetPath, tab_id: detailsTabId, row_offset: 100000 });
    console.log(`[details] over-range scroll: scrolled=${overRange.scrolled} row_offset=${overRange.row_offset} max=${overRange.max_row_offset}`);
    if (typeof overRange.scrolled !== 'boolean') throw new Error('details_panel_scroll response carries no scrolled boolean');
    if (overRange.row_offset > overRange.max_row_offset) throw new Error('over-range scroll reported a row beyond max_row_offset');
  }

  // ── 4. PIE in its own window ───────────────────────────────
  // new_window is the case get_viewport_screenshot cannot see: it keeps
  // returning the level-editor viewport while the game runs elsewhere.
  await call('start_pie', { mode: 'new_window' });
  console.log('[pie] started in a new window; waiting for the first frames');
  await sleep(5000);
  try {
    const pieCapture = await call('capture_pie_viewport', {});
    reportCapture('capture-pie', pieCapture);
  } finally {
    await stopPIEAndWaitForStopped({
      stop: () => executeMenhanceTool('stop_pie', {}, cm),
      getState: () => executeMenhanceTool('get_pie_session_state', {}, cm),
    });
    console.log('[pie] stopped');
  }
} catch (err) {
  failures.push(`${err.code || 'ERROR'}: ${err.message}`);
}

if (failures.length > 0) {
  console.error('\n[live-smoke-asset-editor-capture] FAIL');
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('\n[live-smoke-asset-editor-capture] PASS — 4 PNGs written with non-zero size');
process.exit(0);
