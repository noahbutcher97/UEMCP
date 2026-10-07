// Shared acceptance checks for the owned editor-capture scenario. No editor access
// occurs here: the caller supplies dispatch and PNG decode/inspection functions.
import assert from 'node:assert/strict';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export const OWNED_CAPTURE_ASSET = '/Game/Serialization/BP_OwnedLink';
export const INLINE_BASE64_CAP = 8 * 1024 * 1024;
const integer = value => Number.isSafeInteger(value) && value >= 0;

export function assertCaptureIdentity(result, assetPath, tabId) {
  // The C++ handler returns UObject::GetPathName, including the object suffix.
  const objectPath = `${assetPath}.${assetPath.slice(assetPath.lastIndexOf('/') + 1)}`;
  assert.equal(result.asset_path, objectPath, 'capture asset identity');
  assert.equal(result.tab_id, tabId, 'capture must be of the requested tab');
  assert.ok(integer(result.width) && result.width > 0, 'positive width');
  assert.ok(integer(result.height) && result.height > 0, 'positive height');
  assert.ok(integer(result.byte_length) && result.byte_length > 0, 'positive byte length');
  assert.equal(result.mime, 'image/png');
}

// Never ask Git to resolve an output path. In particular, neither a .git file's
// gitdir nor a commondir redirect is an allowed way out of the explicit project.
// Reject metadata paths and symlink/junction ancestors before reading PNG bytes.
export function readCapturePng(projectRoot, pngPath) {
  const root = resolve(realpathSync.native(projectRoot));
  assert.ok(typeof pngPath === 'string' && isAbsolute(pngPath), 'absolute PNG path required');
  const candidate = resolve(pngPath);
  const rel = relative(root, candidate);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'PNG path outside project');
  assert.ok(!rel.split(sep).some(part => part.toLowerCase() === '.git'), 'Git metadata is not capture output');
  assert.match(candidate, /\.png$/i);
  let current = candidate;
  // Walk the known number of relative components, not string equality: path
  // identity is case-insensitive on Windows but dirname preserves spelling.
  for (let remaining = rel.split(sep).length; remaining > 0; remaining--) {
    assert.ok(!lstatSync(current).isSymbolicLink(), 'PNG path contains a symlink or junction');
    current = dirname(current);
  }
  assert.ok(lstatSync(candidate).isFile(), 'PNG must be a regular file');
  return readFileSync(candidate);
}

export function assertCaptureBytes(result, bytes, { inline = false } = {}) {
  assert.ok(Buffer.isBuffer(bytes));
  assert.equal(bytes.length, result.byte_length, 'disk/report byte length');
  assert.ok(bytes.length >= 33, 'PNG has IHDR');
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'PNG signature');
  assert.equal(bytes.readUInt32BE(8), 13, 'IHDR size');
  assert.equal(bytes.toString('ascii', 12, 16), 'IHDR');
  assert.equal(bytes.readUInt32BE(16), result.width, 'PNG/report width');
  assert.equal(bytes.readUInt32BE(20), result.height, 'PNG/report height');
  const encodedLength = Math.ceil(bytes.length / 3) * 4;
  if (!inline) {
    assert.equal(result.png_base64, undefined);
    assert.equal(result.inline_omitted, undefined);
  } else if (encodedLength > INLINE_BASE64_CAP) {
    assert.equal(result.inline_omitted, 'too_large');
    assert.equal(result.png_base64, undefined);
  } else {
    assert.equal(result.inline_omitted, undefined, 'under-cap inline must not be omitted');
    assert.equal(result.png_base64, bytes.toString('base64'), 'inline bytes equal disk bytes');
  }
  // Signature/IHDR and base64 checks alone do not prove PNG decoding or pixels.
}

export function assertDetailsScroll(result, requested) {
  assert.ok(integer(result.max_row_offset));
  assert.ok(integer(result.row_offset));
  assert.equal(result.requested_row_offset, requested);
  assert.equal(typeof result.scrolled, 'boolean');
  const clamped = Math.min(requested, result.max_row_offset);
  assert.ok(result.row_offset >= clamped && result.row_offset <= result.max_row_offset);
  if (!result.scrolled) assert.equal(result.row_offset, clamped);
}

export async function runOwnedEditorCaptureScenario({ call, inspectCapture, detailsTabId, nonDetailsTabId, afterExpand = async () => {} }) {
  assert.equal(typeof call, 'function');
  assert.equal(typeof inspectCapture, 'function', 'PNG decode and visual acceptance callback required');
  assert.ok(detailsTabId && nonDetailsTabId && detailsTabId !== nonDetailsTabId);
  const asset_path = OWNED_CAPTURE_ASSET;
  const completed = [];
  const tabs = await call('list_asset_editor_tabs', { asset_path });
  assert.equal(tabs.asset_path, `${asset_path}.BP_OwnedLink`);
  assert.ok(typeof tabs.editor_class === 'string' && tabs.editor_class.length > 0);
  assert.ok(Array.isArray(tabs.tabs) && tabs.tabs.length > 0);
  const ids = tabs.tabs.map(tab => tab.tab_id);
  assert.equal(new Set(ids).size, ids.length);
  for (const tab of tabs.tabs) {
    assert.ok(typeof tab.tab_id === 'string' && tab.tab_id.length > 0);
    assert.equal(typeof tab.display_name, 'string');
    assert.equal(typeof tab.is_active, 'boolean');
    assert.equal(typeof tab.has_viewport, 'boolean');
  }
  assert.ok(ids.includes(detailsTabId) && ids.includes(nonDetailsTabId));
  const active = tabs.tabs.filter(tab => tab.is_active);
  assert.equal(active.length, 1, 'one visibly active owned tab required; no first-tab fallback proof');
  completed.push('tabs');
  const capture = async (label, args, tabId) => {
    const result = await call('capture_asset_editor', { asset_path, ...args });
    assertCaptureIdentity(result, asset_path, tabId);
    await inspectCapture(label, result, { inline: args.inline === true });
    completed.push(label);
  };
  await capture('capture-active', {}, active[0].tab_id);
  const unknown = '__UEMCP_UnknownCaptureTab__';
  assert.ok(!ids.includes(unknown));
  await assert.rejects(() => call('capture_asset_editor', { asset_path, tab_id: unknown }), { code: 'TAB_NOT_FOUND' });
  completed.push('unknown-tab');
  const expanded = await call('details_panel_expand_all', { asset_path, tab_id: detailsTabId });
  assert.equal(expanded.expanded, true);
  assert.ok(integer(expanded.rows_before) && integer(expanded.rows_after));
  completed.push('details-expand');
  await afterExpand(); // The native adapter must allow Slate's deferred refresh.
  await assert.rejects(() => call('details_panel_scroll', { asset_path, tab_id: nonDetailsTabId, row_offset: 0 }), { code: 'NOT_A_DETAILS_PANEL' });
  completed.push('non-details-scroll');
  const scroll = await call('details_panel_scroll', { asset_path, tab_id: detailsTabId, row_offset: 20 });
  assertDetailsScroll(scroll, 20);
  assert.ok(scroll.max_row_offset >= 20, 'populated Details panel required for positive paging');
  assert.equal(scroll.scrolled, true, 'ordinary Details paging must reach a property row');
  completed.push('details-scroll');
  await capture('capture-details', { tab_id: detailsTabId }, detailsTabId);
  await capture('inline-details', { tab_id: detailsTabId, inline: true }, detailsTabId);
  assertDetailsScroll(await call('details_panel_scroll', { asset_path, tab_id: detailsTabId, row_offset: 100000 }), 100000);
  completed.push('over-range-details');
  return completed;
}
