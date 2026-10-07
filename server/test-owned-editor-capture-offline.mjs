// Offline evidence only: real JS dispatch/schema + C++ source contracts and
// synthetic scenario failure controls. No renderer, editor or native execution.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { executeMenhanceTool, initMenhanceTools, getMenhanceToolDefs } from './menhance-tcp-tools.mjs';
import { TestRunner, REPO_ROOT, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';
import { verifyOwnedFixture } from './owned-serialization.mjs';
import { collectFixtureIdentity } from './execution-manifest.mjs';
import { OWNED_CAPTURE_ASSET, INLINE_BASE64_CAP, assertCaptureIdentity, assertCaptureBytes,
  assertDetailsScroll, readCapturePng, runOwnedEditorCaptureScenario } from './owned-editor-capture-checks.mjs';

const t = new TestRunner('Owned editor capture offline');
async function check(name, run) {
  const fullName = `owned capture offline: ${name}`;
  try { await run(); t.assert(true, fullName); }
  catch (error) { t.assert(false, fullName, error.stack); }
}
const fixtureRelative = 'server/fixtures/serialization/ue5.6-owned-v1';
const fixturePaths = ['manifest.json', 'oracle.json', 'Content/Serialization/BP_OwnedLink.uasset'].map(p => `${fixtureRelative}/${p}`);
const before = collectFixtureIdentity(REPO_ROOT, fixturePaths);
await check('owned corpus verifies without editor or ambient project', async () => {
  await verifyOwnedFixture(join(REPO_ROOT, fixtureRelative), 'ue5.6-owned-v1');
});
const yaml = load(readFileSync(join(REPO_ROOT, 'tools.yaml'), 'utf8'));
initMenhanceTools(yaml);
const asset_path = OWNED_CAPTURE_ASSET;
const tools = ['list_asset_editor_tabs', 'capture_asset_editor', 'details_panel_expand_all', 'details_panel_scroll'];
for (const name of tools) {
  await check(`${name} ships with uncached TCP dispatch`, async () => {
    assert.equal(yaml.toolsets['visual-capture'].tools[name].status, 'shipped');
    assert.equal(getMenhanceToolDefs()[name].isReadOp, false);
    const args = { asset_path, ...(name.startsWith('details_') ? { tab_id: 'Details' } : {}),
      ...(name === 'details_panel_scroll' ? { row_offset: 20 } : {}) };
    const calls = [];
    const response = { status: 'success', result: { sentinel: name } };
    const cm = { send: async (...args) => { calls.push(args); return response; } };
    assert.equal(await executeMenhanceTool(name, args, cm), response);
    assert.equal(await executeMenhanceTool(name, args, cm), response);
    assert.deepEqual(calls, Array.from({ length: 2 }, () => ['tcp-55558', name, args, { skipCache: true }]));
  });
}
await check('capture forwards explicit tab output and inline without inventing defaults', async () => {
  const calls = [];
  const cm = { send: async (...args) => { calls.push(args); return {}; } };
  await executeMenhanceTool('capture_asset_editor', { asset_path }, cm);
  const params = { asset_path, tab_id: 'Details', out_png: 'review/details.png', inline: true };
  await executeMenhanceTool('capture_asset_editor', params, cm);
  assert.deepEqual(calls.map(call => call[2]), [{ asset_path }, params]);
});
for (const [label, name, args] of [
  ['missing asset', 'capture_asset_editor', {}],
  ['missing details tab', 'details_panel_expand_all', { asset_path }],
  ['missing row', 'details_panel_scroll', { asset_path, tab_id: 'Details' }],
  ...[-1, 0.5, '20', NaN].map(row_offset => [`invalid row ${String(row_offset)}`, 'details_panel_scroll', { asset_path, tab_id: 'Details', row_offset }]),
  ['nonboolean inline', 'capture_asset_editor', { asset_path, inline: 'true' }],
]) {
  await check(`${label} rejects before transport`, async () => {
    let sends = 0;
    await assert.rejects(() => executeMenhanceTool(name, args, { send: async () => { sends++; } }));
    assert.equal(sends, 0);
  });
}
for (const code of ['ASSET_NOT_FOUND', 'EDITOR_NOT_OPEN', 'TAB_NOT_FOUND', 'NOT_A_DETAILS_PANEL', 'CAPTURE_PATH_OUTSIDE_PROJECT', 'CAPTURE_UNSUPPORTED', 'FILE_WRITE_FAILED']) {
  await check(`dispatch preserves ${code}`, async () => {
    const error = Object.assign(new Error(code), { code });
    await assert.rejects(() => executeMenhanceTool('capture_asset_editor', { asset_path }, { send: async () => { throw error; } }), e => e === error);
  });
}
const readCpp = name => readFileSync(join(REPO_ROOT, 'plugin/UEMCP/Source/UEMCP', name), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
const helper = readCpp('Private/AssetEditorCapture.cpp');
const handler = readCpp('Private/AssetEditorCaptureHandler.cpp');
const native = readCpp('Private/Tests/UEMCPAssetEditorCaptureTests.cpp');
const header = readCpp('Public/AssetEditorCapture.h');
const body = (source, start, end) => {
  const first = source.indexOf(start), last = source.indexOf(end, first + start.length);
  assert.ok(first >= 0 && last > first, `source boundaries ${start}`);
  return source.slice(first, last);
};
await check('source validates output then target then tab before pixel capture', () => {
  const capture = body(handler, 'void HandleCaptureAssetEditor', 'bool ReadDetailsParams');
  const tokens = ['ResolveCaptureOutputPath(', 'ResolveAssetEditorTarget(', 'ResolveCaptureTab(', 'CaptureWidgetToPng(', 'FinishCapture('];
  const positions = tokens.map(token => capture.indexOf(token));
  assert.ok(positions.every((position, index) => position >= 0 && (!index || position > positions[index - 1])));
  assert.ok(capture.includes('Tab->GetLayoutIdentifier().TabType.ToString()'));
  assert.ok(capture.includes('SetStringField(TEXT("tab_id"), ResolvedTabId)'));
});
await check('source resolves existing owned tabs without opening or focusing', () => {
  assert.match(helper, /FindEditorForAsset\(Target.Asset,\s*false\)/);
  assert.ok(!helper.includes('TryInvokeTab') && !helper.includes('OpenEditorForAsset'));
  const resolver = body(helper, 'TSharedPtr<SDockTab> ResolveCaptureTab', 'bool CanCaptureSlate');
  assert.match(resolver, /if \(!TabId.IsEmpty\(\)\)\s*\{\s*return Target.TabManager->FindExistingLiveTab/);
  assert.ok(resolver.includes('Info.bIsActive'));
});
await check('source confines output with normalized project boundary', () => {
  const resolver = body(helper, 'bool ResolveCaptureOutputPath', 'bool CaptureWidgetToPng');
  for (const token of ['FPaths::CollapseRelativeDirectories(Full)', 'ProjectRoot += TEXT("/")', 'Full.StartsWith(ProjectRoot, ESearchCase::IgnoreCase)', 'Candidate += TEXT(".png")']) assert.ok(resolver.includes(token), token);
});
await check('source guards Slate and emits PNG with bounded inline bytes', () => {
  assert.ok(helper.includes('FApp::CanEverRender() && FSlateApplication::IsInitialized()'));
  assert.ok(helper.includes('FSlateApplication::Get().TakeScreenshot('));
  assert.ok(helper.includes('FImageUtils::CompressImage(OutPng, TEXT("png")'));
  assert.ok(helper.includes('Base64Length > MaxBase64Bytes'));
  assert.ok(header.includes('InlineBase64MaxBytes = 8 * 1024 * 1024'));
});
await check('source uses exact Details type public expansion and bounded row paging', () => {
  assert.ok(helper.includes('FindDescendantByType(Tab->GetContent(), TEXT("SDetailsView"))'));
  for (const token of ['ShowAllAdvancedProperties()', 'GetPropertyRowNumbers()', 'FMath::Clamp(RowOffset, 0, MaxRowOffset)', 'SetBoolField(TEXT("scrolled"), bFoundRow)']) assert.ok(handler.includes(token), token);
  assert.match(handler, /ScrollPropertyIntoView\(Path,\s+true\)/);
  assert.ok(!handler.includes('View->SetRootExpansionStates'));
});
await check('all eight queued native names remain registered with skip limits visible', () => {
  for (const name of ['AssetNotFound', 'EditorNotOpen', 'DetailsPanelParams', 'OutputPathConfinement', 'InlinePngCap', 'CaptureUnsupportedHelper', 'OpenEditorTabs', 'DetailsPanelTab']) assert.ok(native.includes(`"UEMCP.AssetEditorCapture.${name}"`));
  assert.ok(native.includes('skipped: UAssetEditorSubsystem declined'));
  assert.ok(native.includes('skipped: this editor exposes no live tab without a details view'));
});

// Canned PNG and responses below are synthetic comparator controls, not a UE
// golden or rendered evidence. The source corpus above remains read-only.
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
const captureResult = (tab_id = 'Graph', inline = false) => ({ asset_path: `${asset_path}.BP_OwnedLink`, tab_id, width: 1, height: 1, byte_length: png.length, mime: 'image/png', png_path: '/synthetic.png', ...(inline ? { png_base64: png.toString('base64') } : {}) });
const scenarioLabels = ['tabs', 'capture-active', 'unknown-tab', 'details-expand', 'non-details-scroll', 'details-scroll', 'capture-details', 'inline-details', 'over-range-details'];
function scenarioCall(mutate = () => {}) {
  return async (name, args) => {
    let result;
    if (name === 'list_asset_editor_tabs') result = { asset_path: `${asset_path}.BP_OwnedLink`, editor_class: 'BlueprintEditor', tabs: [
      { tab_id: 'Graph', display_name: 'Graph', is_active: true, has_viewport: false },
      { tab_id: 'Details', display_name: 'Details', is_active: false, has_viewport: false },
    ] };
    if (name === 'capture_asset_editor') {
      if (args.tab_id === '__UEMCP_UnknownCaptureTab__') throw Object.assign(new Error('unknown tab'), { code: 'TAB_NOT_FOUND' });
      result = captureResult(args.tab_id || 'Graph', args.inline);
    }
    if (name === 'details_panel_expand_all') result = { expanded: true, rows_before: 4, rows_after: 48 };
    if (name === 'details_panel_scroll') {
      if (args.tab_id === 'Graph') throw Object.assign(new Error('not details'), { code: 'NOT_A_DETAILS_PANEL' });
      result = { requested_row_offset: args.row_offset, row_offset: Math.min(args.row_offset, 47), max_row_offset: 47, scrolled: true };
    }
    mutate(name, result, args);
    return result;
  };
}
const runScenario = call => runOwnedEditorCaptureScenario({ call, detailsTabId: 'Details', nonDetailsTabId: 'Graph', inspectCapture: async (label, result, options) => assertCaptureBytes(result, png, options) });
await check('synthetic scenario executes all nine required branches', async () => assert.deepEqual(await runScenario(scenarioCall()), scenarioLabels));
for (const [label, mutate] of [
  ['wrong active tab success', (name, r, args) => { if (name === 'capture_asset_editor' && !args.tab_id) r.tab_id = 'Details'; }],
  ['wrong details tab success', (name, r, args) => { if (name === 'capture_asset_editor' && args.tab_id === 'Details') r.tab_id = 'Graph'; }],
  ['wrong asset success', (name, r) => { if (name === 'capture_asset_editor') r.asset_path = '/Game/Other.Other'; }],
  ['no active tab fallback', (name, r) => { if (name === 'list_asset_editor_tabs') r.tabs[0].is_active = false; }],
  ['duplicate tab', (name, r) => { if (name === 'list_asset_editor_tabs') r.tabs.push(r.tabs[0]); }],
  ['false expansion', (name, r) => { if (name === 'details_panel_expand_all') r.expanded = false; }],
  ['empty Details panel', (name, r) => { if (name === 'details_panel_scroll') { r.max_row_offset = 0; r.row_offset = 0; r.scrolled = false; } }],
  ['ordinary scroll no-op', (name, r) => { if (name === 'details_panel_scroll') r.scrolled = false; }],
  ['missing scroll boolean', (name, r) => { if (name === 'details_panel_scroll') delete r.scrolled; }],
  ['over-range result', (name, r) => { if (name === 'details_panel_scroll') r.row_offset = 100001; }],
  ['wrong requested row', (name, r) => { if (name === 'details_panel_scroll') r.requested_row_offset = 1; }],
  ['under-cap inline omission', (name, r, args) => { if (args.inline) { delete r.png_base64; r.inline_omitted = 'too_large'; } }],
  ['same-length corrupt inline', (name, r, args) => { if (args.inline) r.png_base64 = Buffer.alloc(png.length).toString('base64'); }],
]) {
  await check(`controls reject ${label}`, async () => {
    assert.deepEqual(await runScenario(scenarioCall()), scenarioLabels);
    await assert.rejects(() => runScenario(scenarioCall(mutate)), assert.AssertionError);
  });
}
for (const [tool, code] of [['capture_asset_editor', 'TAB_NOT_FOUND'], ['details_panel_scroll', 'NOT_A_DETAILS_PANEL']]) {
  await check(`controls reject success or wrong error instead of ${code}`, async () => {
    assert.deepEqual(await runScenario(scenarioCall()), scenarioLabels);
    for (const succeeds of [true, false]) {
      const baseline = scenarioCall();
      await assert.rejects(() => runScenario(async (name, args) => {
        try { return await baseline(name, args); }
        catch (error) {
          if (name !== tool) throw error;
          if (succeeds) return {};
          throw Object.assign(new Error('wrong failure'), { code: 'CAPTURE_UNSUPPORTED' });
        }
      }), assert.AssertionError);
    }
  });
}
await check('byte comparator rejects header size mime identity and disk mismatch', () => {
  const valid = captureResult();
  assertCaptureIdentity(valid, asset_path, 'Graph');
  assertCaptureBytes(valid, png);
  for (const field of ['width', 'height', 'byte_length']) assert.throws(() => assertCaptureBytes({ ...valid, [field]: valid[field] + 1 }, png));
  assert.throws(() => assertCaptureIdentity({ ...valid, mime: 'image/jpeg' }, asset_path, 'Graph'));
  assert.throws(() => assertCaptureBytes(valid, Buffer.alloc(png.length)));
});
await check('inline comparator accepts exact base64 cap and requires omission above it', () => {
  const exact = Buffer.alloc(INLINE_BASE64_CAP / 4 * 3); png.copy(exact);
  const r = { ...captureResult(), byte_length: exact.length, png_base64: exact.toString('base64') };
  assertCaptureBytes(r, exact, { inline: true });
  const above = Buffer.concat([exact, Buffer.from([0])]);
  const omitted = { ...captureResult(), byte_length: above.length, inline_omitted: 'too_large' };
  assertCaptureBytes(omitted, above, { inline: true });
  assert.throws(() => assertCaptureBytes({ ...omitted, png_base64: '' }, above, { inline: true }));
});
await check('scroll comparator accepts unscrollable clamped final row only', () => {
  assertDetailsScroll({ row_offset: 47, requested_row_offset: 100000, max_row_offset: 47, scrolled: false }, 100000);
  assert.throws(() => assertDetailsScroll({ row_offset: 46, requested_row_offset: 100000, max_row_offset: 47, scrolled: false }, 100000));
});
const scratch = createCanonicalScratchRoot('uemcp-owned-capture-');
try {
  const project = join(scratch, 'project');
  const outside = join(scratch, 'outside');
  mkdirSync(project); mkdirSync(outside);
  writeFileSync(join(project, 'valid.png'), png);
  writeFileSync(join(outside, 'escape.png'), png);
  await check('capture reader accepts platform-correct path casing without an unbounded walk', () => {
    const path = join(project, 'valid.png');
    assert.deepEqual(readCapturePng(project, process.platform === 'win32' ? path.toLowerCase() : path), png);
  });
  await check('capture reader rejects traversal absolute sibling and Git metadata escapes', () => {
    assert.deepEqual(readCapturePng(project, join(project, 'valid.png')), png);
    for (const path of [join(project, '..', 'outside', 'escape.png'), join(outside, 'escape.png'), 'valid.png']) assert.throws(() => readCapturePng(project, path));
    mkdirSync(join(project, '.git'));
    writeFileSync(join(project, '.git', 'commondir'), '../../outside');
    writeFileSync(join(project, '.git', 'escape.png'), png);
    assert.throws(() => readCapturePng(project, join(project, '.git', 'escape.png')), /Git metadata/);
  });
  await check('capture reader rejects Git file redirects and junction escapes', () => {
    assert.deepEqual(readCapturePng(project, join(project, 'valid.png')), png);
    const linked = join(scratch, 'linked'); mkdirSync(linked);
    writeFileSync(join(linked, '.git'), 'gitdir: ../outside\n');
    assert.throws(() => readCapturePng(linked, join(outside, 'escape.png')), /outside project/);
    symlinkSync(outside, join(project, 'redirect'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => readCapturePng(project, join(project, 'redirect', 'escape.png')), /symlink or junction/);
  });
} finally { cleanupCanonicalScratchRoot(scratch, 'uemcp-owned-capture-'); }
await check('owned corpus bytes remain immutable after offline checks', async () => {
  assert.deepEqual(collectFixtureIdentity(REPO_ROOT, fixturePaths), before);
  await verifyOwnedFixture(join(REPO_ROOT, fixtureRelative), 'ue5.6-owned-v1');
});
process.exit(t.summary());
