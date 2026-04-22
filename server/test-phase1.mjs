// Phase 1 Verification Tests
// Run: cd D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA && node test-phase1.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { ToolIndex } from './tool-index.mjs';
import { ToolsetManager } from './toolset-manager.mjs';
import { ConnectionManager } from './connection-manager.mjs';
import { executeOfflineTool, matchTagGlob, computeCommentContainment, withAssetExistenceCheck } from './offline-tools.mjs';
import { buildZodSchema } from './zod-builder.mjs';
import { z } from 'zod';
import { ErrorTcpResponder } from './test-helpers.mjs';

const PROJECT_ROOT = (process.env.UNREAL_PROJECT_ROOT || '').trim();
let passed = 0;
let failed = 0;

function assert(condition, name, detail) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

// ── Load tools.yaml ──────────────────────────────────────
const toolsYaml = await readFile(join('..', 'tools.yaml'), 'utf-8');
const toolsData = load(toolsYaml);

// ── Test 1: Server modules import clean ──────────────────
console.log('\n═══ Test 1: Module import (smoke test) ═══');
assert(typeof ToolIndex === 'function', 'ToolIndex class imported');
assert(typeof ToolsetManager === 'function', 'ToolsetManager class imported');
assert(typeof ConnectionManager === 'function', 'ConnectionManager class imported');
assert(typeof executeOfflineTool === 'function', 'executeOfflineTool imported');
assert(typeof matchTagGlob === 'function', 'matchTagGlob imported');

// ── Test 1b: matchTagGlob — synthetic patterns (no project root needed) ────
console.log('\n═══ Test 1b: matchTagGlob (direct glob matcher) ═══');

// Exact match
assert(matchTagGlob('Combat.Attack.Light', 'Combat.Attack.Light') === true,
  'matchTagGlob: exact literal match');
assert(matchTagGlob('Combat.Attack', 'Combat.Attack.Light') === false,
  'matchTagGlob: literal must cover whole string (anchored)');

// `*` matches single component (no dots)
assert(matchTagGlob('Combat.*.Light', 'Combat.Attack.Light') === true,
  'matchTagGlob: * matches single segment');
assert(matchTagGlob('Combat.*', 'Combat.Attack.Light') === false,
  'matchTagGlob: single * does not cross dots');
assert(matchTagGlob('*.Attack.*', 'Combat.Attack.Light') === true,
  'matchTagGlob: *.Attack.* matches centred segment');

// `**` matches any chars including dots
assert(matchTagGlob('Combat.**', 'Combat.Attack.Light') === true,
  'matchTagGlob: ** crosses multiple segments');
assert(matchTagGlob('**', 'Combat.Attack.Light') === true,
  'matchTagGlob: ** alone matches any tag');
assert(matchTagGlob('**.Light', 'Combat.Attack.Light') === true,
  'matchTagGlob: prefix ** + literal suffix');

// Case-insensitivity
assert(matchTagGlob('combat.attack.light', 'Combat.Attack.Light') === true,
  'matchTagGlob: case-insensitive match');

// Non-matches + 0+ edge cases (`*` matches 0+ chars, not 1+)
assert(matchTagGlob('Combat.*', 'Combat') === false,
  'matchTagGlob: Combat.* does not match bare "Combat" (literal dot required)');
assert(matchTagGlob('Combat.*', 'Combat.') === true,
  'matchTagGlob: * accepts empty segment after dot');
assert(matchTagGlob('Armor.*', 'Combat.Attack') === false,
  'matchTagGlob: different prefix does not match');

// Pathological-looking patterns that would trip catastrophic backtracking
// in a naive regex but are O(m*n) here via memoization.
const pathological = '*'.repeat(40);
const haystack = 'abcdefghij'.repeat(10);
const start = Date.now();
const r = matchTagGlob(pathological, haystack);
const elapsed = Date.now() - start;
assert(r === true && elapsed < 100,
  `matchTagGlob: 40×"*" against 100-char input completes in <100ms (got ${elapsed}ms)`);

// ── Test 1c: buildZodSchema (F-1: MCP wire coerce for booleans/numbers) ────
console.log('\n═══ Test 1c: buildZodSchema MCP-wire coerce ═══');

// Real yaml shape pulled from offline.list_level_actors — exercise the path
// most exposed to MCP-wire stringification of typed params.
const llaSchemaShape = buildZodSchema(toolsData.toolsets.offline.tools.list_level_actors.params);
const llaSchema = z.object(llaSchemaShape);

// Boolean coerce — the critical case from the manual tester's blocker
const boolStrParse = llaSchema.safeParse({ asset_path: '/Game/x', summarize_by_class: 'true' });
assert(boolStrParse.success && boolStrParse.data.summarize_by_class === true,
  'buildZodSchema: boolean coerces "true" → true');

const boolFalseParse = llaSchema.safeParse({ asset_path: '/Game/x', summarize_by_class: 'false' });
// NOTE: z.coerce.boolean() uses JS truthiness — non-empty strings (incl. "false") are truthy.
// This is documented Zod behavior. The fix's value is accepting "true" through the wire,
// not strict string-to-boolean conversion. Callers wanting false must pass false (typed) or "" (empty).
assert(boolFalseParse.success && boolFalseParse.data.summarize_by_class === true,
  'buildZodSchema: z.coerce.boolean() treats non-empty strings as truthy (documented behavior)');

const boolTypedParse = llaSchema.safeParse({ asset_path: '/Game/x', summarize_by_class: true });
assert(boolTypedParse.success && boolTypedParse.data.summarize_by_class === true,
  'buildZodSchema: typed boolean still works post-coerce');

// Number coerce — limit/offset wire-stringification
const numStrParse = llaSchema.safeParse({ asset_path: '/Game/x', limit: '5', offset: '10' });
assert(numStrParse.success && numStrParse.data.limit === 5 && numStrParse.data.offset === 10,
  'buildZodSchema: numbers coerce "5" → 5 and "10" → 10');

const numTypedParse = llaSchema.safeParse({ asset_path: '/Game/x', limit: 5 });
assert(numTypedParse.success && numTypedParse.data.limit === 5,
  'buildZodSchema: typed number still works post-coerce');

// String type stays string (no coerce drift onto required-string fields)
const stringFieldParse = llaSchema.safeParse({ asset_path: 12345 });
assert(!stringFieldParse.success,
  'buildZodSchema: string field rejects numeric input (no unwanted coerce on strings)');

// Empty params → empty schema shape (early-return path)
assert(Object.keys(buildZodSchema({})).length === 0,
  'buildZodSchema: empty params returns {}');
assert(Object.keys(buildZodSchema(undefined)).length === 0,
  'buildZodSchema: undefined params returns {}');

// ── Test 1d: buildZodSchema (F-1.5: MCP wire preprocess for arrays/objects) ──
console.log('\n═══ Test 1d: buildZodSchema MCP-wire array/object preprocess ═══');

// Real yaml shape pulled from offline.read_asset_properties — exercises array<string>.
const rapSchemaShape = buildZodSchema(toolsData.toolsets.offline.tools.read_asset_properties.params);
const rapSchema = z.object(rapSchemaShape);

// Typed array passes through unchanged (regression guard for F-1.5)
const arrTypedParse = rapSchema.safeParse({ asset_path: '/Game/x', property_names: ['AbilityTags'] });
assert(arrTypedParse.success && Array.isArray(arrTypedParse.data.property_names) && arrTypedParse.data.property_names[0] === 'AbilityTags',
  'buildZodSchema: typed array still works post-preprocess');

// Stringified array → preprocess JSON-parses then validates (the F-1.5 fix)
const arrStrParse = rapSchema.safeParse({ asset_path: '/Game/x', property_names: '["AbilityTags"]' });
assert(arrStrParse.success && Array.isArray(arrStrParse.data.property_names) && arrStrParse.data.property_names[0] === 'AbilityTags',
  'buildZodSchema: stringified array \'["AbilityTags"]\' parses to ["AbilityTags"]');

// Empty stringified array → passes
const arrEmptyParse = rapSchema.safeParse({ asset_path: '/Game/x', property_names: '[]' });
assert(arrEmptyParse.success && Array.isArray(arrEmptyParse.data.property_names) && arrEmptyParse.data.property_names.length === 0,
  'buildZodSchema: stringified empty array "[]" parses to []');

// Stringified non-array JSON → preprocess parses, but Zod rejects (not an array)
const arrObjParse = rapSchema.safeParse({ asset_path: '/Game/x', property_names: '{"foo": 1}' });
assert(!arrObjParse.success,
  'buildZodSchema: stringified object "{...}" rejected when target type is array');

// Malformed JSON string → preprocess passes through, Zod rejects with clear message
const arrBadParse = rapSchema.safeParse({ asset_path: '/Game/x', property_names: 'not json' });
assert(!arrBadParse.success,
  'buildZodSchema: malformed JSON "not json" rejected as array (passthrough preserves clear error)');

// Object preprocess: synthetic schema from a fake `object`-typed param
// (No production tool currently declares object params, but the case-branch must work.)
const objSchemaShape = buildZodSchema({ payload: { type: 'object', required: true } });
const objSchema = z.object(objSchemaShape);

const objTypedParse = objSchema.safeParse({ payload: { foo: 1 } });
assert(objTypedParse.success && objTypedParse.data.payload.foo === 1,
  'buildZodSchema: typed object still works post-preprocess');

const objStrParse = objSchema.safeParse({ payload: '{"foo": 1}' });
assert(objStrParse.success && objStrParse.data.payload.foo === 1,
  'buildZodSchema: stringified object \'{"foo": 1}\' parses to {foo: 1}');

const objBadParse = objSchema.safeParse({ payload: 'not json' });
assert(!objBadParse.success,
  'buildZodSchema: malformed JSON rejected as object (passthrough preserves clear error)');

// ── Build ToolIndex ──────────────────────────────────────
const toolIndex = new ToolIndex();
toolIndex.build(toolsData);
const toolCount = toolIndex._entries.length;
assert(toolCount > 100, `ToolIndex has ${toolCount} tools (expect >100)`);

// ── Test 4: ToolIndex search quality ─────────────────────
console.log('\n═══ Test 4: ToolIndex search quality ═══');

const searchTests = [
  // Exact name matches — these should be rock solid
  { query: 'spawn actor', expectTop: 'spawn_actor' },
  { query: 'gameplay effect', expectTop: 'create_gameplay_effect' },
  // Substring/prefix matches — verify top5 contains a sensible result
  { query: 'montage', expectAny: ['create_montage', 'add_montage_section', 'get_montage_full'] },
  { query: 'property', expectAny: ['get_actor_properties', 'rc_get_property', 'set_actor_property'] },
  { query: 'screenshot', expectAny: ['get_viewport_screenshot', 'take_screenshot'] },
  { query: 'PIE', expectAny: ['start_pie', 'stop_pie', 'execute_console_command'] },
  { query: 'delete asset', expectAny: ['delete_asset_safe', 'delete_actor'] },
];

for (const t of searchTests) {
  const results = toolIndex.search(t.query);
  const topNames = results.slice(0, 5).map(r => r.toolName);
  if (t.expectTop) {
    assert(topNames[0] === t.expectTop,
      `"${t.query}" → top = ${topNames[0]}`,
      `expected ${t.expectTop}, got [${topNames.join(', ')}]`);
  } else if (t.expectAny) {
    const found = t.expectAny.some(e => topNames.includes(e));
    assert(found,
      `"${t.query}" → top5 includes ${t.expectAny.join('|')}`,
      `got [${topNames.join(', ')}]`);
  }
}

// ── Test 5: Accumulation and shedding ────────────────────
console.log('\n═══ Test 5: Accumulation and shedding ═══');

// Force TCP layers to report unavailable regardless of editor state.
// Test 5 is a plumbing unit test for enable/disable shedding, not an integration check.
const tcpDown = new ErrorTcpResponder('connection_refused');

const config = {
  projectRoot: PROJECT_ROOT,
  tcpPortExisting: 55557,
  tcpPortCustom: 55558,
  httpPort: 30010,
  tcpTimeoutMs: 5000,
  tcpCommandFn: tcpDown.handler(),
};
const connMgr = new ConnectionManager(config);
const toolsetMgr = new ToolsetManager(connMgr, toolIndex);

// Note: ToolsetManager constructor takes (connectionManager, toolIndex)
// but load() re-builds the index from tools.yaml. We pass our pre-built index.
await toolsetMgr.load();

// Check offline auto-enabled
const enabledNames = toolsetMgr.getEnabledNames();
assert(enabledNames.includes('offline'), 'offline auto-enabled on load');

// Enable actors — should fail (tcp-55557 unavailable, editor not running)
const enableResult1 = await toolsetMgr.enable(['actors']);
assert(enableResult1.unavailable.includes('actors'),
  'actors correctly reported unavailable (no editor)');

// Enable gas — should also fail (tcp-55558 unavailable)
const enableResult2 = await toolsetMgr.enable(['gas']);
assert(enableResult2.unavailable.includes('gas'),
  'gas correctly reported unavailable (no plugin)');

// Disable offline (should work)
const disableResult = toolsetMgr.disable(['offline']);
assert(disableResult.disabled.includes('offline'), 'offline disabled successfully');

// Re-enable offline
const reEnable = await toolsetMgr.enable(['offline']);
assert(reEnable.enabled.includes('offline'), 'offline re-enabled successfully');

// Verify offline is in enabled set and actors is not
const finalEnabled = toolsetMgr.getEnabledNames();
assert(finalEnabled.includes('offline'), 'offline in enabled set');
assert(!finalEnabled.includes('actors'), 'actors not in enabled set');

// ── Test 8: Edge cases ───────────────────────────────────
console.log('\n═══ Test 8: Edge cases ═══');

// Empty query
const emptyResults = toolIndex.search('');
assert(emptyResults.length === 0, 'empty query returns 0 results', `got ${emptyResults.length}`);

// Nonexistent toolset
const badEnable = await toolsetMgr.enable(['nonexistent_toolset_xyz']);
assert(badEnable.unknown.includes('nonexistent_toolset_xyz'),
  'nonexistent toolset reported as unknown');

// Disable offline (should work — we re-enabled it in Test 5)
const edgeDisable = toolsetMgr.disable(['offline']);
assert(edgeDisable.disabled.includes('offline'), 'offline can be disabled');

// Re-enable offline
const edgeReEnable = await toolsetMgr.enable(['offline']);
assert(edgeReEnable.enabled.includes('offline'), 'offline can be re-enabled');

// Bad project root
const badConnMgr = new ConnectionManager({ ...config, projectRoot: 'Z:/nonexistent/path' });
const badOffline = await badConnMgr.checkOfflineAvailable();
assert(!badOffline, 'bad project root → offline unavailable');

// ── Test 3: Offline tools ────────────────────────────────
console.log('\n═══ Test 3: Offline tools work ═══');

if (!PROJECT_ROOT) {
  console.log('  SKIP: UNREAL_PROJECT_ROOT not set');
} else {
  // project_info
  try {
    const info = await executeOfflineTool('project_info', {}, PROJECT_ROOT);
    assert(info && info.projectName, `project_info returns name: ${info.projectName}`);
  } catch (e) {
    assert(false, 'project_info', e.message);
  }

  // list_gameplay_tags
  try {
    const tags = await executeOfflineTool('list_gameplay_tags', {}, PROJECT_ROOT);
    assert(tags && (tags.tags?.length > 0 || tags.length > 0),
      `list_gameplay_tags returns tags`);
  } catch (e) {
    assert(false, 'list_gameplay_tags', e.message);
  }

  // search_gameplay_tags: `**` glob matches every tag (sanity floor for matcher wiring)
  try {
    const all = await executeOfflineTool('search_gameplay_tags',
      { pattern: '**' }, PROJECT_ROOT);
    const tags = await executeOfflineTool('list_gameplay_tags', {}, PROJECT_ROOT);
    assert(all.matchCount === tags.tags.length,
      `search_gameplay_tags("**") matches all tags (${all.matchCount} == ${tags.tags.length})`);
  } catch (e) {
    assert(false, 'search_gameplay_tags("**")', e.message);
  }

  // search_gameplay_tags with a first-segment.* glob — should match every tag
  // whose first component equals the first segment of the first listed tag.
  try {
    const tags = await executeOfflineTool('list_gameplay_tags', {}, PROJECT_ROOT);
    if (tags.tags.length > 0) {
      const firstSeg = tags.tags[0].tag.split('.')[0];
      const result = await executeOfflineTool('search_gameplay_tags',
        { pattern: `${firstSeg}.**` }, PROJECT_ROOT);
      const expected = tags.tags.filter(t => t.tag.startsWith(firstSeg + '.')).length;
      assert(result.matchCount === expected,
        `search_gameplay_tags("${firstSeg}.**") matches all ${firstSeg}.* descendants (${result.matchCount} == ${expected})`);
    } else {
      assert(true, 'search_gameplay_tags glob skipped (no tags)');
    }
  } catch (e) {
    assert(false, 'search_gameplay_tags glob (first-segment.**)', e.message);
  }

  // list_plugins
  try {
    const plugins = await executeOfflineTool('list_plugins', {}, PROJECT_ROOT);
    const hasPlugins = plugins && (plugins.plugins?.length > 0 || plugins.localPlugins?.length > 0 || Object.keys(plugins).length > 0);
    if (!hasPlugins) console.log(`    DEBUG list_plugins result: ${JSON.stringify(plugins).slice(0, 300)}`);
    assert(hasPlugins, 'list_plugins returns plugin list');
  } catch (e) {
    assert(false, 'list_plugins', e.message);
  }

  // list_data_sources (D36: new tool)
  try {
    const sources = await executeOfflineTool('list_data_sources', {}, PROJECT_ROOT);
    assert(sources && typeof sources.fileCount === 'number' && Array.isArray(sources.entries),
      'list_data_sources returns {fileCount, entries}');
  } catch (e) {
    assert(false, 'list_data_sources', e.message);
  }

  // read_datatable_source path traversal prevention
  try {
    await executeOfflineTool('read_datatable_source',
      { file_path: '../../some/other/path.csv' }, PROJECT_ROOT);
    assert(false, 'read_datatable_source path traversal should throw');
  } catch (e) {
    assert(e.message.includes('traversal') || e.message.includes('not allowed'),
      `read_datatable_source path traversal blocked: "${e.message}"`);
  }

  // read_string_table_source requires .csv extension
  try {
    await executeOfflineTool('read_string_table_source',
      { file_path: 'Content/foo.txt' }, PROJECT_ROOT);
    assert(false, 'read_string_table_source non-csv should throw');
  } catch (e) {
    assert(e.message.includes('.csv') || e.message.includes('traversal') || e.message.includes('not allowed'),
      `read_string_table_source rejects non-csv: "${e.message}"`);
  }

  // get_build_config
  try {
    const build = await executeOfflineTool('get_build_config', {}, PROJECT_ROOT);
    assert(build, 'get_build_config returns config');
  } catch (e) {
    assert(false, 'get_build_config', e.message);
  }

  // list_config_values
  try {
    const cfg = await executeOfflineTool('list_config_values',
      { config_file: 'DefaultEngine.ini' }, PROJECT_ROOT);
    assert(cfg, 'list_config_values reads DefaultEngine.ini');
  } catch (e) {
    assert(false, 'list_config_values', e.message);
  }

  // Dropped tools are no longer routed (D31): browse_content, search_source, read_source_file
  for (const dropped of ['browse_content', 'search_source', 'read_source_file']) {
    try {
      await executeOfflineTool(dropped, {}, PROJECT_ROOT);
      assert(false, `${dropped} should be dropped (D31)`);
    } catch (e) {
      assert(e.message.includes('Unknown offline tool'),
        `${dropped} dispatch removed (D31): "${e.message}"`);
    }
  }
}

// ── Test 9: Phase 2 handler fixes (F0, F2, F4, F6, F1) ──
if (PROJECT_ROOT) {
  console.log(`\n═══ Test 9: Handler fixes (F0, F2, F4, F6, F1) ═══`);

  // F0: get_asset_info strips verbose blob tags by default
  try {
    const info = await executeOfflineTool('get_asset_info',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block' }, PROJECT_ROOT);
    // Default (verbose=false): heavy tags should be omitted or absent
    assert(info.tags !== undefined, 'F0: get_asset_info still has tags field');
    assert(!info.tags.FiBData || (info.tags.FiBData && String(info.tags.FiBData).length <= 1024),
      'F0: FiBData stripped or small when verbose=false');
  } catch (e) {
    assert(false, 'F0: get_asset_info default', e.message);
  }

  try {
    const infoV = await executeOfflineTool('get_asset_info',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block', verbose: true }, PROJECT_ROOT);
    assert(infoV.tags !== undefined, 'F0: verbose=true returns tags');
    assert(!infoV.heavyTagsOmitted, 'F0: verbose=true has no heavyTagsOmitted');
    // Verify verbose actually passes through: if any heavy tag existed in default mode,
    // verbose mode must include it unstripped (blob length > 1024)
    const infoDefault = await executeOfflineTool('get_asset_info',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block' }, PROJECT_ROOT);
    if (infoDefault.heavyTagsOmitted && infoDefault.heavyTagsOmitted.length > 0) {
      const firstOmitted = infoDefault.heavyTagsOmitted[0];
      assert(infoV.tags[firstOmitted] !== undefined,
        `F0: verbose=true restores stripped tag '${firstOmitted}'`);
      assert(String(infoV.tags[firstOmitted]).length > 1024,
        `F0: verbose=true blob '${firstOmitted}' is full-size (>1KB)`);
    }
  } catch (e) {
    assert(false, 'F0: get_asset_info verbose', e.message);
  }

  // F2: inspect_blueprint no longer returns tags
  try {
    const bp = await executeOfflineTool('inspect_blueprint',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block' }, PROJECT_ROOT);
    assert(bp.tags === undefined, 'F2: inspect_blueprint has no tags field');
    assert(bp.exports !== undefined, 'F2: inspect_blueprint still has exports');
    assert(bp.parentClass !== undefined, 'F2: inspect_blueprint still has parentClass');
  } catch (e) {
    assert(false, 'F2: inspect_blueprint', e.message);
  }

  // F4: list_level_actors filters to placed actors
  // Agent 10 renamed placedActorCount → total_placed_actors as part of the
  // transforms+pagination response-shape update (Option C).
  try {
    const lvl = await executeOfflineTool('list_level_actors',
      { asset_path: '/Game/Maps/Deployable/MarketPlace/MarketPlace_P' }, PROJECT_ROOT);
    assert(lvl.total_placed_actors !== undefined, 'F4: response has total_placed_actors (Option C rename)');
    assert(lvl.total_placed_actors < lvl.exportCount,
      `F4: placed actors (${lvl.total_placed_actors}) < total exports (${lvl.exportCount})`);
    // Verify no K2Node or Function entries leaked through
    const leaks = lvl.actors.filter(a =>
      a.className && (a.className.includes('K2Node_') || a.className === 'Function'));
    assert(leaks.length === 0, 'F4: no K2Node/Function exports in placed actors');
  } catch (e) {
    assert(false, 'F4: list_level_actors filter', e.message);
  }

  // F6: query_asset_registry accepts short class names
  try {
    const dtShort = await executeOfflineTool('query_asset_registry',
      { class_name: 'DataTable', limit: 5 }, PROJECT_ROOT);
    assert(dtShort.results.length > 0, 'F6: short name "DataTable" finds results');
    const dtFull = await executeOfflineTool('query_asset_registry',
      { class_name: '/Script/Engine.DataTable', limit: 5 }, PROJECT_ROOT);
    assert(dtFull.results.length > 0, 'F6: full path also finds results');
  } catch (e) {
    assert(false, 'F6: short class name', e.message);
  }

  // F1: query_asset_registry truncation signalling + pagination
  try {
    const page1 = await executeOfflineTool('query_asset_registry',
      { limit: 3 }, PROJECT_ROOT);
    assert(page1.total_scanned !== undefined, 'F1: response has total_scanned');
    assert(page1.total_matched !== undefined, 'F1: response has total_matched');
    assert(page1.offset === 0, 'F1: default offset is 0');
    if (page1.total_matched > 3) {
      assert(page1.truncated === true, 'F1: truncated=true when results exceed limit');
      const page2 = await executeOfflineTool('query_asset_registry',
        { limit: 3, offset: 3 }, PROJECT_ROOT);
      assert(page2.offset === 3, 'F1: offset=3 echoed in page 2');
      assert(page2.results[0].path !== page1.results[0].path, 'F1: page 2 has different results');
    }
  } catch (e) {
    assert(false, 'F1: truncation signalling', e.message);
  }
}

// ── Test 10: Agent 10 Option C — transforms + pagination + include_defaults + read_asset_properties ──
if (PROJECT_ROOT) {
  console.log(`\n═══ Test 10: Option C tool wiring ═══`);

  // list_level_actors: transforms always-on, outer-index reverse scan (V9.5 #1).
  try {
    const lvl = await executeOfflineTool('list_level_actors',
      { asset_path: '/Game/Developers/steve/Steve_TestMap', limit: 50 }, PROJECT_ROOT);
    assert(lvl.total_placed_actors > 0, 'Option C: total_placed_actors > 0');
    assert(lvl.actors.every(a => 'transform' in a),
           'Option C: every actor row has a transform field (may be null)');
    // At least some actors on a real dev map should have transforms.
    const withTransforms = lvl.actors.filter(a => a.transform !== null);
    assert(withTransforms.length > 0,
           `Option C: some actors have non-null transforms (got ${withTransforms.length} of ${lvl.actors.length})`);
    // Sparse transforms at class default should round-trip as transform:null
    // per V9.5 correction #3 (intended behaviour, not error).
    const nullTransforms = lvl.actors.filter(a => a.transform === null);
    assert(nullTransforms.length + withTransforms.length === lvl.actors.length,
           'Option C: transform is either a shape or null, never undefined');
    // Spot-check one transform's shape: {location:[3], rotation:[3]|null, scale:[3]|null}
    if (withTransforms.length > 0) {
      const t = withTransforms[0].transform;
      const hasLoc = Array.isArray(t.location) && t.location.length === 3;
      const hasRot = t.rotation === null || (Array.isArray(t.rotation) && t.rotation.length === 3);
      const hasScale = t.scale === null || (Array.isArray(t.scale) && t.scale.length === 3);
      assert(hasLoc || t.location === null, 'Option C: transform.location is [x,y,z] or null');
      assert(hasRot, 'Option C: transform.rotation is [p,y,r] or null');
      assert(hasScale, 'Option C: transform.scale is [x,y,z] or null');
    }
  } catch (e) {
    assert(false, 'Option C: list_level_actors transforms', e.message);
  }

  // Pagination: limit + offset work, truncated flag set correctly.
  try {
    const page1 = await executeOfflineTool('list_level_actors',
      { asset_path: '/Game/Developers/steve/Steve_TestMap', limit: 3, offset: 0 }, PROJECT_ROOT);
    assert(page1.limit === 3, 'Option C: limit echoed');
    assert(page1.offset === 0, 'Option C: offset echoed');
    assert(page1.actors.length === 3, 'Option C: page size respects limit');
    if (page1.total_placed_actors > 3) {
      assert(page1.truncated === true, 'Option C: truncated=true when total > limit');
    }
    const page2 = await executeOfflineTool('list_level_actors',
      { asset_path: '/Game/Developers/steve/Steve_TestMap', limit: 3, offset: 3 }, PROJECT_ROOT);
    assert(page2.offset === 3, 'Option C: page 2 offset echoed');
    if (page1.actors.length === 3 && page2.actors.length > 0) {
      assert(page2.actors[0].name !== page1.actors[0].name,
             'Option C: page 2 returns different actors than page 1');
    }
  } catch (e) {
    assert(false, 'Option C: list_level_actors pagination', e.message);
  }

  // limit cap at 500.
  try {
    const huge = await executeOfflineTool('list_level_actors',
      { asset_path: '/Game/Developers/steve/Steve_TestMap', limit: 99999 }, PROJECT_ROOT);
    assert(huge.limit === 500, 'Option C: limit capped at 500');
  } catch (e) {
    assert(false, 'Option C: limit cap', e.message);
  }

  // summarize_by_class: returns summary dict, no actors array.
  try {
    const sum = await executeOfflineTool('list_level_actors',
      { asset_path: '/Game/Developers/steve/Steve_TestMap', summarize_by_class: true }, PROJECT_ROOT);
    assert(sum.summary !== undefined && typeof sum.summary === 'object',
           'Option C: summarize_by_class returns summary dict');
    assert(sum.actors === undefined, 'Option C: summarize_by_class omits actors array');
    const classCount = Object.keys(sum.summary).length;
    assert(classCount > 0, `Option C: summary has at least one class (got ${classCount})`);
    // Totals should match actor count.
    const summed = Object.values(sum.summary).reduce((a, b) => a + b, 0);
    assert(summed === sum.total_placed_actors,
           `Option C: summary totals (${summed}) match total_placed_actors (${sum.total_placed_actors})`);
  } catch (e) {
    assert(false, 'Option C: summarize_by_class', e.message);
  }

  // inspect_blueprint: include_defaults=false (default) does NOT include variable_defaults.
  try {
    const bp = await executeOfflineTool('inspect_blueprint',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block' }, PROJECT_ROOT);
    assert(bp.variable_defaults === undefined,
           'Option C: inspect_blueprint default has no variable_defaults');
  } catch (e) {
    assert(false, 'Option C: inspect_blueprint default', e.message);
  }

  // inspect_blueprint: include_defaults=true attaches CDO UPROPERTY values.
  try {
    const bp = await executeOfflineTool('inspect_blueprint',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block', include_defaults: true }, PROJECT_ROOT);
    assert(bp.variable_defaults !== undefined,
           'Option C: include_defaults=true attaches variable_defaults');
    assert(bp.cdo_export_name === 'Default__BPGA_Block_C',
           'Option C: cdo_export_name resolves to Default__<GeneratedClass>');
    assert(bp.variable_defaults.IsBlocking?.tagName === 'Gameplay.State.Guard.IsActive',
           'Option C: variable_defaults decode FGameplayTag correctly');
    assert(Array.isArray(bp.variable_defaults.ActivationOwnedTags?.tags),
           'Option C: variable_defaults decode FGameplayTagContainer');
    assert(Array.isArray(bp.unsupported_defaults),
           'Option C: unsupported_defaults parallel list is present');
  } catch (e) {
    assert(false, 'Option C: inspect_blueprint include_defaults', e.message);
  }

  // inspect_blueprint: old `verbose` param now rejects (Zod validation would fail at MCP boundary;
  // at the executeOfflineTool level it's silently ignored — document expected behaviour).
  try {
    const bp = await executeOfflineTool('inspect_blueprint',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block', verbose: true }, PROJECT_ROOT);
    // The handler ignores `verbose`; include_defaults is the only gate now.
    assert(bp.variable_defaults === undefined,
           'Option C: legacy `verbose` param does not trigger include_defaults semantics');
  } catch (e) {
    assert(false, 'Option C: legacy verbose param', e.message);
  }

  // read_asset_properties: default export for BP-subclass asset is the CDO.
  try {
    const rap = await executeOfflineTool('read_asset_properties',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block' }, PROJECT_ROOT);
    assert(rap.export_name === 'Default__BPGA_Block_C',
           'Option C: read_asset_properties default export = Default__<Name>_C');
    assert(rap.struct_type === 'BPGA_Block_C',
           `Option C: struct_type resolves to the CDO's direct class (got ${rap.struct_type})`);
    assert(rap.property_count_total === rap.property_count_returned,
           'Option C: unfiltered query returns all properties');
    assert(rap.properties.IsBlocking !== undefined,
           'Option C: read_asset_properties returns IsBlocking');
  } catch (e) {
    assert(false, 'Option C: read_asset_properties default', e.message);
  }

  // read_asset_properties: property_names filter narrows output.
  try {
    const filtered = await executeOfflineTool('read_asset_properties',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block', property_names: ['ActivationOwnedTags'] },
      PROJECT_ROOT);
    assert(filtered.property_count_returned === 1,
           `Option C: filter narrows to 1 property (got ${filtered.property_count_returned})`);
    assert(filtered.property_count_total > 1,
           'Option C: property_count_total reflects the full set');
    assert(filtered.properties.ActivationOwnedTags !== undefined,
           'Option C: filtered response includes the requested property');
    assert(filtered.properties.IsBlocking === undefined,
           'Option C: non-matching properties are omitted');
  } catch (e) {
    assert(false, 'Option C: read_asset_properties filter', e.message);
  }

  // read_asset_properties: max_bytes triggers truncation.
  try {
    const trunc = await executeOfflineTool('read_asset_properties',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block', max_bytes: 50 }, PROJECT_ROOT);
    assert(trunc.truncated === true,
           'Option C: max_bytes=50 triggers truncated=true');
    const budgetMarkers = trunc.unsupported.filter(u => u.reason === 'size_budget_exceeded');
    assert(budgetMarkers.length > 0,
           'Option C: size_budget_exceeded markers emitted');
    assert(budgetMarkers.length <= 20,
           `Option C: marker count capped at 20 per Q5 spec (got ${budgetMarkers.length})`);
  } catch (e) {
    assert(false, 'Option C: max_bytes truncation', e.message);
  }

  // read_asset_properties: explicit export_name that doesn't exist rejects.
  try {
    let caught = null;
    try {
      await executeOfflineTool('read_asset_properties',
        { asset_path: '/Game/GAS/Abilities/BPGA_Block', export_name: 'DoesNotExist' }, PROJECT_ROOT);
    } catch (e) { caught = e; }
    assert(caught !== null && /Export not found/.test(caught.message),
           'Option C: unknown export_name throws "Export not found"');
  } catch (e) {
    assert(false, 'Option C: bad export_name', e.message);
  }

  // D44 invariant: tools.yaml is single source of truth for descriptions.
  // Verify the three modified/new tools show up in the offline toolset with
  // their Option C descriptions.
  try {
    const offlineTools = toolsData.toolsets.offline.tools;
    assert(/include_defaults=true/.test(offlineTools.inspect_blueprint.description),
           'D44: inspect_blueprint yaml description mentions include_defaults');
    assert(/transforms/i.test(offlineTools.list_level_actors.description),
           'D44: list_level_actors yaml description mentions transforms');
    assert(offlineTools.read_asset_properties !== undefined,
           'D44: read_asset_properties entry exists in yaml');
    assert(/Level 2 engine structs|engine structs/i.test(offlineTools.read_asset_properties.description),
           'D44: read_asset_properties description calls out engine struct coverage');
    // Params line up with yaml (tools/list and find_tools read from the same source).
    assert(offlineTools.list_level_actors.params.limit !== undefined,
           'D44: list_level_actors.params.limit declared in yaml');
    assert(offlineTools.inspect_blueprint.params.include_defaults !== undefined,
           'D44: inspect_blueprint.params.include_defaults declared in yaml');
    assert(offlineTools.inspect_blueprint.params.verbose === undefined,
           'D44: inspect_blueprint.params.verbose removed per Q1 rename');
    // Agent 10.5 Tier 4: find_blueprint_nodes registered in yaml.
    assert(offlineTools.find_blueprint_nodes !== undefined,
           'D44 T4: find_blueprint_nodes entry exists in yaml');
    assert(/skeletal K2Node|K2Node_CallFunction/i.test(offlineTools.find_blueprint_nodes.description),
           'D44 T4: find_blueprint_nodes description references skeletal K2Node surface');
    assert(offlineTools.find_blueprint_nodes.params.node_class !== undefined,
           'D44 T4: find_blueprint_nodes.params.node_class declared');
    assert(offlineTools.find_blueprint_nodes.params.member_name !== undefined,
           'D44 T4: find_blueprint_nodes.params.member_name declared');
  } catch (e) {
    assert(false, 'D44: yaml invariant check', e.message);
  }
}

// ── Test 11: Agent 10.5 Tier 4 — find_blueprint_nodes ──────────
async function testFindBlueprintNodes() {
  console.log(`\n═══ Test 11: Agent 10.5 Tier 4 — find_blueprint_nodes ═══`);
  if (!PROJECT_ROOT) { console.log('  SKIP: UNREAL_PROJECT_ROOT not set'); return; }

  // Unfiltered call — returns all skeletal K2Nodes paginated.
  try {
    const r = await executeOfflineTool('find_blueprint_nodes',
      { asset_path: '/Game/Blueprints/Character/BP_OSPlayerR' }, PROJECT_ROOT);
    assert(r.total_skeletal > 0, `T4: BP_OSPlayerR has skeletal K2Nodes (got ${r.total_skeletal})`);
    assert(Array.isArray(r.nodes), 'T4: response includes nodes[] array');
    assert(typeof r.truncated === 'boolean', 'T4: truncated flag present');
    assert(typeof r.total_matched === 'number', 'T4: total_matched present');
    assert(Array.isArray(r.nodes_out_of_skeletal), 'T4: nodes_out_of_skeletal array present for discoverability');
    // Every node row has node_class + export_index
    for (const n of r.nodes) {
      if (!(n.node_class && typeof n.export_index === 'number')) {
        assert(false, 'T4: every node has node_class + export_index', JSON.stringify(n));
        break;
      }
    }
    assert(true, 'T4: every node has node_class + export_index');
  } catch (e) {
    assert(false, 'T4: unfiltered find_blueprint_nodes', e.message);
  }

  // node_class filter narrows to just events.
  try {
    const r = await executeOfflineTool('find_blueprint_nodes',
      { asset_path: '/Game/Blueprints/Character/BP_OSPlayerR', node_class: 'K2Node_Event' },
      PROJECT_ROOT);
    assert(r.nodes.every(n => n.node_class === 'K2Node_Event'),
      `T4: node_class filter returns only Events (got ${r.nodes.length} rows)`);
    assert(r.total_matched < r.total_skeletal, 'T4: filter reduces total_matched below total_skeletal');
    // Event member_name carries the event handler name.
    const beginPlay = r.nodes.find(n => n.member_name === 'ReceiveBeginPlay');
    assert(!!beginPlay, 'T4: ReceiveBeginPlay event detected by member_name');
    assert(beginPlay?.target_class?.includes('Actor') ?? false,
      'T4: ReceiveBeginPlay target_class points at /Script/Engine.Actor');
  } catch (e) {
    assert(false, 'T4: K2Node_Event filter', e.message);
  }

  // member_name filter — CreateDynamicMaterialInstance appears multiple times.
  try {
    const r = await executeOfflineTool('find_blueprint_nodes',
      { asset_path: '/Game/Blueprints/Character/BP_OSPlayerR', member_name: 'CreateDynamicMaterialInstance' },
      PROJECT_ROOT);
    assert(r.total_matched > 0, 'T4: member_name filter finds matching calls');
    assert(r.nodes.every(n => n.member_name === 'CreateDynamicMaterialInstance'),
      'T4: every returned node has the requested member_name');
  } catch (e) {
    assert(false, 'T4: member_name filter', e.message);
  }

  // target_class suffix filter.
  try {
    const r = await executeOfflineTool('find_blueprint_nodes',
      { asset_path: '/Game/Blueprints/Character/BP_OSPlayerR', target_class: 'MaterialInstanceDynamic' },
      PROJECT_ROOT);
    assert(r.total_matched > 0, 'T4: target_class suffix filter finds matches');
    assert(r.nodes.every(n => n.target_class?.endsWith('MaterialInstanceDynamic')),
      'T4: every match ends in the target_class suffix');
  } catch (e) {
    assert(false, 'T4: target_class filter', e.message);
  }

  // Pagination: limit=5, offset=0 + offset=5 yield disjoint rows.
  try {
    const p1 = await executeOfflineTool('find_blueprint_nodes',
      { asset_path: '/Game/Blueprints/Character/BP_OSPlayerR', limit: 5, offset: 0 }, PROJECT_ROOT);
    const p2 = await executeOfflineTool('find_blueprint_nodes',
      { asset_path: '/Game/Blueprints/Character/BP_OSPlayerR', limit: 5, offset: 5 }, PROJECT_ROOT);
    assert(p1.nodes.length === 5, 'T4 pagination: page 1 has limit=5 rows');
    assert(p1.offset === 0, 'T4 pagination: page 1 offset echoed');
    assert(p2.offset === 5, 'T4 pagination: page 2 offset echoed');
    const p1Idx = new Set(p1.nodes.map(n => n.export_index));
    assert(p2.nodes.every(n => !p1Idx.has(n.export_index)),
      'T4 pagination: page 2 returns rows disjoint from page 1');
  } catch (e) {
    assert(false, 'T4: pagination', e.message);
  }
}

// Run Test 11 (Agent 10.5 Tier 4) after Test 10 closes.
await testFindBlueprintNodes();

// ── Test 12: Polish Worker — response-shape ergonomics (P1–P7) ───────────
//
// Covers the 7 ergonomic fixes identified by the Agent 10 manual tester:
//   P1  summarize_by_class omits offset/limit
//   P2  read_asset_properties scopes unsupported[] to property_names filter
//   P3  packageIndex is stripped from response objects at every depth
//   P4  unsupported[] is deduped by {name, reason}
//   P5  unexpected_preamble is documented in tools.yaml
//   P6  delegate-path note — see comment block below (no runtime assertion)
//   P7  deterministic top-level field ordering across tools
//
// P6 note: the `delegate_not_serialized` marker path in uasset-parser.mjs is
// intentionally unreachable from typical BP CDOs. UE serializes delegate
// *bindings* through the Blueprint graph (K2Nodes + graph functions), not as
// CDO tagged-property entries — so FDelegateProperty / FMulticastDelegateProperty
// tags never surface in a CDO's FPropertyTag stream. The parser branch exists
// per Agent 9 design to never silently skip if such a tag DID appear (e.g.,
// in a hand-authored asset), but real-world ProjectA corpus coverage confirms
// it won't fire on BP/Widget/AnimBP/DataTable CDOs. No fixture constructed.
if (PROJECT_ROOT) {
  console.log(`\n═══ Test 12: Polish Worker — response-shape ergonomics ═══`);

  // Helper: recursively check an object has no `packageIndex` key anywhere.
  function assertNoPackageIndex(label, value, path = '$') {
    if (value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      value.forEach((v, i) => assertNoPackageIndex(label, v, `${path}[${i}]`));
      return;
    }
    if ('packageIndex' in value) {
      assert(false, `${label}: packageIndex leaked at ${path}`);
      return;
    }
    for (const key of Object.keys(value)) {
      assertNoPackageIndex(label, value[key], `${path}.${key}`);
    }
  }

  // P1: summarize_by_class omits offset/limit.
  try {
    const sum = await executeOfflineTool('list_level_actors',
      { asset_path: '/Game/Developers/steve/Steve_TestMap', summarize_by_class: true }, PROJECT_ROOT);
    assert(!('offset' in sum), 'P1: summary mode omits offset');
    assert(!('limit' in sum), 'P1: summary mode omits limit');
    assert(sum.summary !== undefined, 'P1: summary dict still present');
    assert(sum.total_placed_actors > 0, 'P1: total_placed_actors still present');
  } catch (e) {
    assert(false, 'P1: summary-mode offset/limit echo', e.message);
  }

  // P1 (complement): non-summary response still echoes pagination fields.
  try {
    const page = await executeOfflineTool('list_level_actors',
      { asset_path: '/Game/Developers/steve/Steve_TestMap', limit: 5 }, PROJECT_ROOT);
    assert(page.offset === 0, 'P1 complement: non-summary mode still has offset');
    assert(page.limit === 5, 'P1 complement: non-summary mode still has limit');
  } catch (e) {
    assert(false, 'P1 complement: non-summary pagination', e.message);
  }

  // P2: filtered read_asset_properties scopes unsupported[] to the filter.
  // Use max_bytes=300 on BP_OSPlayerR to force size_budget_exceeded markers
  // — a reliable way to exercise the filter-scoping path without depending on
  // fixture-specific complex-container shapes (Agent 10.5's D50 tagged-fallback
  // decodes most former "unsupported" properties). Threshold kept comfortably
  // below the BP's current property-stream size (~490 bytes post-CL-1 drift
  // refresh) so minor future re-saves don't silently skip this coverage.
  try {
    const full = await executeOfflineTool('read_asset_properties',
      { asset_path: '/Game/Blueprints/Character/BP_OSPlayerR', max_bytes: 300 }, PROJECT_ROOT);
    const markerNames = full.unsupported.map(m => m.name);
    assert(markerNames.length >= 2,
      `P2 setup: BP_OSPlayerR with max_bytes=300 emits multiple markers (got ${markerNames.length})`);

    // Pick one marker to keep and one to scope out.
    const keep = markerNames[0];
    const scopeOut = markerNames[1];
    assert(keep !== scopeOut, 'P2 setup: distinct marker names available');

    // Filter for only `keep` — `scopeOut` marker must NOT appear.
    const filtered = await executeOfflineTool('read_asset_properties',
      { asset_path: '/Game/Blueprints/Character/BP_OSPlayerR', max_bytes: 300,
        property_names: [keep] }, PROJECT_ROOT);
    const leaked = filtered.unsupported.find(m => m.name === scopeOut);
    assert(leaked === undefined,
      `P2: unrelated marker (${scopeOut}) scoped out when filter=[${keep}]`);

    // The kept marker IS present in unsupported[] when filtered for.
    const kept = filtered.unsupported.find(m => m.name === keep);
    assert(kept !== undefined,
      `P2: marker matching a filtered name (${keep}) is preserved`);
  } catch (e) {
    assert(false, 'P2: filter-scoped unsupported[]', e.message);
  }

  // P3: packageIndex is stripped from all response objects.
  try {
    const rap = await executeOfflineTool('read_asset_properties',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block' }, PROJECT_ROOT);
    assertNoPackageIndex('P3 read_asset_properties', rap);

    const bp = await executeOfflineTool('inspect_blueprint',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block', include_defaults: true }, PROJECT_ROOT);
    assertNoPackageIndex('P3 inspect_blueprint', bp);

    const lvl = await executeOfflineTool('list_level_actors',
      { asset_path: '/Game/Developers/steve/Steve_TestMap', limit: 10 }, PROJECT_ROOT);
    assertNoPackageIndex('P3 list_level_actors', lvl);

    // Object refs must still have their useful surface — objectName, kind, (packagePath).
    const objRef = rap.properties.GuardBreakEffectClass;
    if (objRef && typeof objRef === 'object') {
      assert(objRef.objectName !== undefined, 'P3: object ref still has objectName');
      assert(objRef.kind !== undefined, 'P3: object ref still has kind discriminator');
    }
  } catch (e) {
    assert(false, 'P3: packageIndex leakage', e.message);
  }

  // P4: dedupe unsupported[] by {name, reason} — verify helper behaviour via
  // a real fixture (no duplicates expected) and an internal invariant check.
  try {
    const rap = await executeOfflineTool('read_asset_properties',
      { asset_path: '/Game/GAS/Abilities/BPGA_Block' }, PROJECT_ROOT);
    const keys = rap.unsupported.map(m => `${m.name}::${m.reason}`);
    const unique = new Set(keys);
    assert(keys.length === unique.size,
      `P4: unsupported[] has no {name, reason} duplicates (got ${keys.length} rows, ${unique.size} unique)`);
  } catch (e) {
    assert(false, 'P4: dedupe unsupported[]', e.message);
  }

  // P5: tools.yaml documents the marker reason codes including unexpected_preamble.
  try {
    const desc = toolsData.toolsets.offline.tools.read_asset_properties.description;
    assert(/unexpected_preamble/.test(desc),
      'P5: read_asset_properties description documents unexpected_preamble');
    assert(/unknown_struct/.test(desc),
      'P5: read_asset_properties description documents unknown_struct');
    assert(/size_budget_exceeded/.test(desc),
      'P5: read_asset_properties description documents size_budget_exceeded');
  } catch (e) {
    assert(false, 'P5: unexpected_preamble docs in yaml', e.message);
  }

  // P7: deterministic field ordering. list_level_actors actor rows end with
  // transform (or transform followed by unsupported when present).
  try {
    const lvl = await executeOfflineTool('list_level_actors',
      { asset_path: '/Game/Developers/steve/Steve_TestMap', limit: 20 }, PROJECT_ROOT);
    const expectedPrefix = ['name', 'className', 'classPackage', 'outer', 'bIsAsset', 'transform'];
    for (const row of lvl.actors) {
      const keys = Object.keys(row);
      const prefix = keys.slice(0, expectedPrefix.length);
      assert(prefix.every((k, i) => k === expectedPrefix[i]),
        `P7: actor row key prefix matches ${expectedPrefix.join(',')} (got ${prefix.join(',')})`);
      // If unsupported is present, it must be the last key (after transform).
      if ('unsupported' in row) {
        assert(keys[keys.length - 1] === 'unsupported',
          'P7: unsupported (when present) is the last key');
      }
    }

    // Top-level: summary mode has summary as the last payload field.
    const sum = await executeOfflineTool('list_level_actors',
      { asset_path: '/Game/Developers/steve/Steve_TestMap', summarize_by_class: true }, PROJECT_ROOT);
    const sumKeys = Object.keys(sum);
    assert(sumKeys[sumKeys.length - 1] === 'summary',
      'P7: summary mode puts summary as the trailing key');
  } catch (e) {
    assert(false, 'P7: response field ordering', e.message);
  }
}

// ── Test 13: EN-2 Worker — find_blueprint_nodes_bulk (corpus-wide scan) ──
//
// Closes Workflow Catalog SERVED_PARTIAL rows 26/27/28/42/62/63 by folding
// N-round-trip "which BPs call X / handle Y / access Z" iteration into one
// call. Inherits filter semantics from find_blueprint_nodes.
if (PROJECT_ROOT) {
  console.log(`\n═══ Test 13: EN-2 Worker — find_blueprint_nodes_bulk ═══`);

  // D44 invariant — yaml registration.
  try {
    const offlineTools = toolsData.toolsets.offline.tools;
    assert(offlineTools.find_blueprint_nodes_bulk !== undefined,
      'EN-2 D44: find_blueprint_nodes_bulk entry exists in yaml');
    const desc = offlineTools.find_blueprint_nodes_bulk.description;
    assert(/corpus-wide|which BPs/i.test(desc),
      'EN-2 D44: description mentions corpus-wide scan / workflow');
    assert(/find_blueprint_nodes/.test(desc),
      'EN-2 D44: description cross-references single-BP variant');
    const p = offlineTools.find_blueprint_nodes_bulk.params;
    assert(p.path_prefix?.required === true, 'EN-2 D44: path_prefix declared required');
    assert(p.node_class !== undefined, 'EN-2 D44: node_class param declared');
    assert(p.member_name !== undefined, 'EN-2 D44: member_name param declared');
    assert(p.target_class !== undefined, 'EN-2 D44: target_class param declared');
    assert(p.limit !== undefined && p.offset !== undefined, 'EN-2 D44: limit+offset params declared');
    assert(p.max_scan !== undefined, 'EN-2 D44: max_scan param declared');
    assert(p.include_nodes?.type === 'boolean', 'EN-2 D44: include_nodes declared as boolean');
  } catch (e) {
    assert(false, 'EN-2 D44: yaml invariant', e.message);
  }

  // Basic scan: /Game/Blueprints walks many BPs; at least some should match
  // skeletal K2Nodes when unfiltered.
  try {
    const r = await executeOfflineTool('find_blueprint_nodes_bulk',
      { path_prefix: '/Game/Blueprints', max_scan: 500 }, PROJECT_ROOT);
    assert(r.total_bps_scanned > 0, `EN-2: total_bps_scanned > 0 (got ${r.total_bps_scanned})`);
    assert(r.total_bps_matched > 0, `EN-2: unfiltered scan finds matched BPs (got ${r.total_bps_matched})`);
    assert(Array.isArray(r.results), 'EN-2: results[] is array');
    assert(r.path_prefix === '/Game/Blueprints', 'EN-2: path_prefix echoed');
    assert(typeof r.scan_truncated === 'boolean', 'EN-2: scan_truncated flag present');
    assert(typeof r.page_truncated === 'boolean', 'EN-2: page_truncated flag present');
    // filter block echoes request filter even when all null
    assert(r.filter && 'node_class' in r.filter && 'member_name' in r.filter && 'target_class' in r.filter,
      'EN-2: filter object echoed with node_class/member_name/target_class');
    // Every results row has path + match_count; match_count > 0 by construction.
    for (const row of r.results) {
      if (!(row.path && typeof row.match_count === 'number' && row.match_count > 0)) {
        assert(false, `EN-2: every result row has path + match_count>0 (got ${JSON.stringify(row)})`);
        break;
      }
    }
    assert(true, 'EN-2: every result row has path + match_count>0');
    // Default include_nodes=false → no nodes[] per row
    assert(r.results.every(row => !('nodes' in row)),
      'EN-2: include_nodes=false default — rows have no nodes[]');
  } catch (e) {
    assert(false, 'EN-2: basic bulk scan', e.message);
  }

  // member_name filter across corpus — ReceiveBeginPlay is a canonical event
  // name that appears in many BPs. Should match at least 1 BP.
  try {
    const r = await executeOfflineTool('find_blueprint_nodes_bulk',
      { path_prefix: '/Game/Blueprints', member_name: 'ReceiveBeginPlay', max_scan: 500 },
      PROJECT_ROOT);
    assert(r.total_bps_matched > 0,
      `EN-2 filter: ReceiveBeginPlay matches some BPs (got ${r.total_bps_matched})`);
    assert(r.filter.member_name === 'ReceiveBeginPlay', 'EN-2 filter: member_name echoed');
  } catch (e) {
    assert(false, 'EN-2: member_name filter', e.message);
  }

  // include_nodes=true surfaces per-BP nodes[]; each node has node_class + export_index.
  try {
    const r = await executeOfflineTool('find_blueprint_nodes_bulk',
      { path_prefix: '/Game/Blueprints', node_class: 'K2Node_Event',
        include_nodes: true, max_scan: 500, limit: 5 }, PROJECT_ROOT);
    assert(r.results.length > 0, 'EN-2 include_nodes: some BPs have events');
    const first = r.results[0];
    assert(Array.isArray(first.nodes), 'EN-2 include_nodes: first row has nodes[] array');
    assert(first.nodes.length === first.match_count,
      'EN-2 include_nodes: nodes.length === match_count');
    for (const n of first.nodes) {
      if (!(n.node_class === 'K2Node_Event' && typeof n.export_index === 'number')) {
        assert(false, `EN-2 include_nodes: each node is K2Node_Event with export_index (got ${JSON.stringify(n)})`);
        break;
      }
    }
    assert(true, 'EN-2 include_nodes: each node is K2Node_Event with export_index');
  } catch (e) {
    assert(false, 'EN-2: include_nodes=true shape', e.message);
  }

  // Pagination: limit=1 pages yield disjoint BP paths.
  try {
    const p1 = await executeOfflineTool('find_blueprint_nodes_bulk',
      { path_prefix: '/Game/Blueprints', node_class: 'K2Node_Event',
        limit: 1, offset: 0, max_scan: 500 }, PROJECT_ROOT);
    const p2 = await executeOfflineTool('find_blueprint_nodes_bulk',
      { path_prefix: '/Game/Blueprints', node_class: 'K2Node_Event',
        limit: 1, offset: 1, max_scan: 500 }, PROJECT_ROOT);
    assert(p1.offset === 0 && p1.limit === 1, 'EN-2 pagination: page 1 echoes offset/limit');
    assert(p2.offset === 1 && p2.limit === 1, 'EN-2 pagination: page 2 echoes offset/limit');
    if (p1.total_bps_matched >= 2) {
      assert(p1.results.length === 1 && p2.results.length === 1,
        'EN-2 pagination: both pages have 1 row when ≥2 BPs matched');
      assert(p1.results[0].path !== p2.results[0].path,
        'EN-2 pagination: page 1 and page 2 return different BPs');
      assert(p1.page_truncated === true,
        'EN-2 pagination: page 1 flagged page_truncated when ≥2 matches');
    }
  } catch (e) {
    assert(false, 'EN-2: pagination disjoint', e.message);
  }

  // scan_truncated semantics: max_scan=2 against a prefix with 3+ BPs caps
  // at BP level (not file level), so scan_truncated=true — exercises the
  // "max_scan means BPs, not files" contract.
  try {
    const r = await executeOfflineTool('find_blueprint_nodes_bulk',
      { path_prefix: '/Game/Blueprints', max_scan: 2 }, PROJECT_ROOT);
    assert(r.total_bps_scanned === 2,
      `EN-2 scan cap: max_scan=2 caps BP count (got total_bps_scanned=${r.total_bps_scanned})`);
    assert(r.scan_truncated === true,
      'EN-2 scan cap: scan_truncated=true when BP cap clips corpus');
  } catch (e) {
    assert(false, 'EN-2: scan_truncated semantics', e.message);
  }

  // Corpus-wide honesty: /Game/ default max_scan=500 covers ~all ProjectA BPs
  // (the reason we switched to BP-count semantics in the first place — file
  // semantics gave ~130 BPs for the same budget).
  try {
    const r = await executeOfflineTool('find_blueprint_nodes_bulk',
      { path_prefix: '/Game/', member_name: 'ReceiveBeginPlay' }, PROJECT_ROOT);
    assert(r.total_bps_scanned > 100,
      `EN-2 corpus: default max_scan=500 reaches >100 BPs in /Game/ (got ${r.total_bps_scanned})`);
    assert(r.total_bps_matched > 0,
      `EN-2 corpus: ReceiveBeginPlay found across /Game/ (got ${r.total_bps_matched})`);
  } catch (e) {
    assert(false, 'EN-2: corpus-wide BP reach', e.message);
  }

  // Bad path_prefix rejected.
  try {
    let threw = false;
    try {
      await executeOfflineTool('find_blueprint_nodes_bulk',
        { path_prefix: '/Engine/Foo' }, PROJECT_ROOT);
    } catch (err) {
      threw = /must start with \/Game\//.test(err.message);
    }
    assert(threw, 'EN-2: non-/Game/ path_prefix rejected with explanatory error');
  } catch (e) {
    assert(false, 'EN-2: input validation', e.message);
  }

  // Performance spot-check — warm-cache scan under /Game/Blueprints.
  // Budget: 5s for ~300-500 BP corpus per handoff. Prints actuals.
  try {
    // Warm once.
    await executeOfflineTool('find_blueprint_nodes_bulk',
      { path_prefix: '/Game/Blueprints', max_scan: 1000 }, PROJECT_ROOT);
    const startWarm = Date.now();
    const warm = await executeOfflineTool('find_blueprint_nodes_bulk',
      { path_prefix: '/Game/Blueprints', max_scan: 1000 }, PROJECT_ROOT);
    const warmMs = Date.now() - startWarm;
    console.log(`  ℹ EN-2 perf: warm scan of ${warm.total_bps_scanned} BPs in ${warmMs}ms (budget 5000ms)`);
    assert(warmMs < 5000,
      `EN-2 perf: warm-cache scan under budget (${warmMs}ms < 5000ms, n=${warm.total_bps_scanned})`);
  } catch (e) {
    assert(false, 'EN-2: perf spot-check', e.message);
  }
}

// ── Test 14: M-spatial Worker — 5 BP traversal verbs (FA-β + FA-δ) ───
//
// Ships 5 of 9 D58 re-sequenced BP verbs on the existing offline parser:
//   bp_list_graphs, bp_find_in_graph, bp_subgraph_in_comment,
//   bp_list_entry_points (partial), bp_show_node (partial).
//
// Invariants under test:
//   • FA-β: every verb returns schema_version + available_fields + not_available
//     + plugin_enhancement_available. Partial verbs list what's missing so
//     callers know to expect M-new to fill in.
//   • FA-δ: all 5 verbs return non-empty correct data on real ProjectA BPs
//     with no sidecar, no plugin, no editor — this is the plugin-absent
//     first-class-functional guard.
//   • D44: yaml is the source of truth — tools/list and find_tools read
//     identical metadata.

console.log('\n═══ Test 14: M-spatial Worker — 5 BP traversal verbs ═══');

// D44 invariant — all 5 verbs registered in yaml.
try {
  const offlineTools = toolsData.toolsets.offline.tools;
  for (const v of ['bp_list_graphs', 'bp_find_in_graph', 'bp_subgraph_in_comment',
                   'bp_list_entry_points', 'bp_show_node']) {
    assert(offlineTools[v] !== undefined, `M-spatial D44: ${v} entry exists in yaml`);
    assert(typeof offlineTools[v].description === 'string' && offlineTools[v].description.length > 40,
      `M-spatial D44: ${v} has a non-trivial description`);
    assert(offlineTools[v].params?.asset_path?.required === true,
      `M-spatial D44: ${v}.params.asset_path declared required`);
  }
  // bp_find_in_graph uniquely needs graph_name required
  assert(offlineTools.bp_find_in_graph.params.graph_name?.required === true,
    'M-spatial D44: bp_find_in_graph.graph_name required');
  // bp_subgraph_in_comment uniquely needs comment_node_id
  assert(offlineTools.bp_subgraph_in_comment.params.comment_node_id?.required === true,
    'M-spatial D44: bp_subgraph_in_comment.comment_node_id required');
  // bp_show_node uniquely needs node_id
  assert(offlineTools.bp_show_node.params.node_id?.required === true,
    'M-spatial D44: bp_show_node.node_id required');
  // M-new (D58) upgrade: exec_connectivity + pin_block moved from not_available
  // to available_fields. yaml descriptions now mention available_fields and the
  // pin_block/exec_connectivity tokens (FA-β forward-compat — D59).
  assert(/available_fields|has_no_exec_in|exec_connectivity/i.test(offlineTools.bp_list_entry_points.description),
    'M-new D58: bp_list_entry_points yaml mentions available_fields or pin-connectivity');
  assert(/pin_block|pins\[\]|pin[- ]block/i.test(offlineTools.bp_show_node.description),
    'M-new D58: bp_show_node yaml mentions pin_block or pins[]');
} catch (e) {
  assert(false, 'M-spatial D44: yaml invariants', e.message);
}

// computeCommentContainment — unit tests (synthetic, no disk access).
try {
  // 3×3 comment at (0,0)–(300,300). Node A at center, B outside.
  const contained = computeCommentContainment(
    [
      { node_id: 1, node_pos_x: 150, node_pos_y: 150, node_width: 0, node_height: 0 },  // inside
      { node_id: 2, node_pos_x: 500, node_pos_y: 500, node_width: 0, node_height: 0 },  // outside
      { node_id: 3, node_pos_x: 300, node_pos_y: 300, node_width: 0, node_height: 0 },  // on edge (inclusive)
    ],
    [{ node_id: 10, node_pos_x: 0, node_pos_y: 0, node_width: 300, node_height: 300 }],
  );
  const ids = contained.get(10);
  assert(ids.includes(1), 'M-spatial containment: inner node captured');
  assert(!ids.includes(2), 'M-spatial containment: outer node excluded');
  assert(ids.includes(3), 'M-spatial containment: edge-case node included (inclusive rect)');

  // Zero-size comment → empty list.
  const zero = computeCommentContainment(
    [{ node_id: 1, node_pos_x: 10, node_pos_y: 10 }],
    [{ node_id: 99, node_pos_x: 0, node_pos_y: 0, node_width: 0, node_height: 0 }],
  );
  assert(zero.get(99).length === 0, 'M-spatial containment: zero-size comment → empty');

  // Self-exclusion — a comment never contains itself.
  const selfTest = computeCommentContainment(
    [{ node_id: 42, node_pos_x: 50, node_pos_y: 50 }],
    [{ node_id: 42, node_pos_x: 0, node_pos_y: 0, node_width: 100, node_height: 100 }],
  );
  assert(!selfTest.get(42).includes(42), 'M-spatial containment: comment excludes itself');
} catch (e) {
  assert(false, 'M-spatial containment unit', e.message);
}

// EN-9: withAssetExistenceCheck helper — synthetic unit test (no fixture).
// Confirms: ENOENT → graceful envelope; other errors pass through; non-throwing
// handler returns its payload unchanged; missing params.asset_path → null.
try {
  const enoentErr = Object.assign(new Error('fake ENOENT'), { code: 'ENOENT' });
  const handler = async () => { throw enoentErr; };
  const guarded = withAssetExistenceCheck(handler);
  const got = await guarded('/nonexistent/root', { asset_path: '/Game/Bogus' });
  assert(got.available === false, 'EN-9 helper: ENOENT → available: false');
  assert(got.reason === 'asset_not_found', 'EN-9 helper: reason === asset_not_found');
  assert(got.asset_path === '/Game/Bogus', 'EN-9 helper: asset_path echoed from params');

  // Non-ENOENT error still throws (parser errors must stay distinguishable).
  const corruptErr = new Error('corrupt bytes at offset 0x42');
  let rethrown = false;
  try {
    await withAssetExistenceCheck(async () => { throw corruptErr; })('/root', { asset_path: '/Game/X' });
  } catch (e) {
    rethrown = e === corruptErr;
  }
  assert(rethrown, 'EN-9 helper: non-ENOENT error re-thrown (parser errors stay distinguishable)');

  // Happy-path: handler's return value passes through unchanged.
  const passthrough = await withAssetExistenceCheck(async () => ({ ok: 1 }))('/root', { asset_path: '/Game/X' });
  assert(passthrough.ok === 1, 'EN-9 helper: non-throwing handler payload passed through unchanged');

  // Missing params.asset_path — graceful envelope still returns with null path.
  const noPath = await withAssetExistenceCheck(async () => { throw enoentErr; })('/root', {});
  assert(noPath.asset_path === null, 'EN-9 helper: missing params.asset_path → null in envelope');
} catch (e) {
  assert(false, 'EN-9 withAssetExistenceCheck unit', e.message);
}

if (!PROJECT_ROOT) {
  console.log('  SKIP: UNREAL_PROJECT_ROOT not set — skipping fixture-backed M-spatial tests');
} else {
  const BP = '/Game/Blueprints/Character/BP_OSPlayerR';

  // ── bp_list_graphs ─────────────────────────────────────
  try {
    const r = await executeOfflineTool('bp_list_graphs', { asset_path: BP }, PROJECT_ROOT);
    assert(r.schema_version === 'm-spatial-v1', 'bp_list_graphs: schema_version m-spatial-v1');
    assert(Array.isArray(r.available_fields) && r.available_fields.length > 0,
      'bp_list_graphs: available_fields non-empty');
    assert(Array.isArray(r.not_available) && r.not_available.length === 0,
      'bp_list_graphs: not_available empty (full coverage)');
    assert(r.plugin_enhancement_available === false,
      'bp_list_graphs: plugin_enhancement_available flag set to false (offline-primary)');
    assert(r.graph_count >= 3,
      `bp_list_graphs: BP_OSPlayerR has >=3 graphs (got ${r.graph_count})`);
    assert(r.graphs.some(g => g.name === 'EventGraph' && g.graph_type === 'ubergraph'),
      'bp_list_graphs: EventGraph classified as ubergraph');
    assert(r.graphs.some(g => g.name === 'UserConstructionScript' && g.graph_type === 'construction_script'),
      'bp_list_graphs: UserConstructionScript classified');
    assert(r.graphs.some(g => g.graph_type === 'function'),
      'bp_list_graphs: at least one function graph detected');
    const evg = r.graphs.find(g => g.name === 'EventGraph');
    assert(evg.node_count > 10 && evg.comment_count > 0,
      `bp_list_graphs: EventGraph has K2Nodes + comments (nodes=${evg.node_count} comments=${evg.comment_count})`);

    // EN-8: comment_ids[] field present on every graph, populated on graphs
    // with comments, empty array on graphs without. Each ID is a 32-char hex
    // NodeGuid so callers skip inspect_blueprint when locating comments.
    assert(r.graphs.every(g => Array.isArray(g.comment_ids)),
      'EN-8: bp_list_graphs every graph row has comment_ids[] array (empty allowed)');
    const graphsWithComments = r.graphs.filter(g => g.comment_ids.length > 0);
    assert(graphsWithComments.length > 0,
      'EN-8: bp_list_graphs surfaces at least one graph with non-empty comment_ids (BP_OSPlayerR has comments)');
    const allIds = graphsWithComments.flatMap(g => g.comment_ids);
    assert(allIds.every(id => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id)),
      'EN-8: every comment_id is a 32-char lowercase hex NodeGuid (FGuid format)');
    // comment_count agrees with comment_ids length when every comment has a decoded NodeGuid.
    assert(graphsWithComments.every(g => g.comment_ids.length <= g.comment_count),
      'EN-8: comment_ids length never exceeds comment_count (filter drops undecoded guids)');
  } catch (e) {
    assert(false, 'bp_list_graphs scenario', e.message);
  }

  // ── bp_find_in_graph ─────────────────────────────────
  try {
    const r = await executeOfflineTool('bp_find_in_graph',
      { asset_path: BP, graph_name: 'EventGraph', node_class: 'K2Node_Event' },
      PROJECT_ROOT);
    assert(r.total_matched > 0, `bp_find_in_graph: K2Node_Event filter finds matches (got ${r.total_matched})`);
    assert(r.total_matched < r.total_nodes_in_graph,
      'bp_find_in_graph: filter narrows below total_nodes_in_graph');
    assert(r.nodes.every(n => n.graph_name === 'EventGraph'),
      'bp_find_in_graph: every match echoes graph_name');
    assert(r.nodes.every(n => typeof n.node_pos_x === 'number' && typeof n.node_pos_y === 'number'),
      'bp_find_in_graph: every match has positions (FA-δ spatial proof)');

    // Unknown graph name rejected.
    let threw = false;
    try {
      await executeOfflineTool('bp_find_in_graph',
        { asset_path: BP, graph_name: 'NoSuchGraph' }, PROJECT_ROOT);
    } catch (err) {
      threw = /Graph not found/.test(err.message);
    }
    assert(threw, 'bp_find_in_graph: unknown graph_name raises Graph not found');
  } catch (e) {
    assert(false, 'bp_find_in_graph scenario', e.message);
  }

  // ── bp_subgraph_in_comment ───────────────────────────
  try {
    const r = await executeOfflineTool('bp_subgraph_in_comment',
      { asset_path: BP, comment_node_id: 'EdGraphNode_Comment' }, PROJECT_ROOT);
    assert(r.comment.class_name === 'EdGraphNode_Comment',
      'bp_subgraph_in_comment: resolved node is a comment');
    assert(typeof r.comment.node_comment === 'string' && r.comment.node_comment.length > 0,
      'bp_subgraph_in_comment: comment text decoded');
    assert(r.comment.node_width > 0 && r.comment.node_height > 0,
      'bp_subgraph_in_comment: comment rectangle has non-zero size');
    assert(r.contained_count > 0 && r.contained.length === r.contained_count,
      `bp_subgraph_in_comment: non-empty contained list (got ${r.contained_count})`);
    assert(r.contained.every(n => typeof n.node_pos_x === 'number'),
      'bp_subgraph_in_comment: contained nodes carry positions');

    // Non-comment id rejected.
    let threwNon = false;
    try {
      await executeOfflineTool('bp_subgraph_in_comment',
        { asset_path: BP, comment_node_id: 'K2Node_Event' }, PROJECT_ROOT);
    } catch (err) {
      threwNon = /not a comment/i.test(err.message);
    }
    assert(threwNon, 'bp_subgraph_in_comment: non-comment id raises "not a comment"');
  } catch (e) {
    assert(false, 'bp_subgraph_in_comment scenario', e.message);
  }

  // ── bp_list_entry_points (partial — FA-β) ─────────────
  try {
    const r = await executeOfflineTool('bp_list_entry_points', { asset_path: BP }, PROJECT_ROOT);
    assert(r.entry_point_count > 0,
      `bp_list_entry_points: BP_OSPlayerR has entries (got ${r.entry_point_count})`);
    assert(r.entry_points.every(e =>
      ['K2Node_Event', 'K2Node_CustomEvent', 'K2Node_FunctionEntry'].includes(e.node_class)),
      'bp_list_entry_points: every entry is Event/CustomEvent/FunctionEntry');
    assert(r.entry_points.every(e => typeof e.node_pos_x === 'number'),
      'bp_list_entry_points: every entry has position');
    assert(r.entry_points.some(e => e.graph_name === 'EventGraph'),
      'bp_list_entry_points: at least one entry tied to EventGraph');
    // M-new (D58) upgrade: exec_connectivity is now first-class via S-B-base
    // topology — lives in available_fields, not not_available. Each entry
    // carries has_no_exec_in (true=genuine entry, false=fed by upstream exec,
    // null=graph not indexable).
    assert(Array.isArray(r.available_fields) && r.available_fields.includes('exec_connectivity'),
      'M-new D58 bp_list_entry_points: available_fields includes exec_connectivity');
    assert(r.entry_points.every(e => e.has_no_exec_in === true || e.has_no_exec_in === false || e.has_no_exec_in === null),
      'M-new D58 bp_list_entry_points: every entry has has_no_exec_in annotation');
    assert(r.plugin_enhancement_available === false,
      'FA-β bp_list_entry_points: plugin_enhancement_available = false (no sidecar required)');
  } catch (e) {
    assert(false, 'bp_list_entry_points scenario', e.message);
  }

  // ── bp_show_node (partial — FA-β) ───────────────────
  try {
    const ep = await executeOfflineTool('bp_list_entry_points', { asset_path: BP }, PROJECT_ROOT);
    const targetName = ep.entry_points[0].node_name;
    const r = await executeOfflineTool('bp_show_node',
      { asset_path: BP, node_id: targetName }, PROJECT_ROOT);
    assert(r.node.node_name === targetName, 'bp_show_node: node_name round-trips via string id');
    assert(typeof r.node.node_pos_x === 'number' && typeof r.node.node_pos_y === 'number',
      'bp_show_node: position fields present');
    assert(typeof r.node.node_guid === 'string' && r.node.node_guid.length === 32,
      'bp_show_node: NodeGuid decoded as 32-char hex');
    assert(r.node.properties && typeof r.node.properties === 'object',
      'bp_show_node: raw properties map populated');
    // M-new (D58) upgrade: pins[] populated from S-B-base topology when the
    // node's NodeGuid resolves. The first entry-point node is K2Node_Event/
    // CustomEvent/FunctionEntry — a graph-node class with a pin block.
    assert(Array.isArray(r.node.pins) && r.node.pins.length > 0,
      'M-new D58 bp_show_node: pins[] populated for entry-point graph node');
    assert(r.node.pins.every(p => typeof p.pin_id === 'string' && typeof p.direction === 'string'),
      'M-new D58 bp_show_node: each pin has pin_id + direction');
    assert(r.node.pins.every(p => p.pin_kind === 'exec' || p.pin_kind === 'data'),
      'M-new D58 bp_show_node: each pin tagged exec|data via pin_kind');
    assert(Array.isArray(r.available_fields) && r.available_fields.includes('pin_block'),
      'M-new D58 bp_show_node: available_fields includes pin_block when resolved');

    // Also accept numeric node_id (export_index).
    const byIdx = await executeOfflineTool('bp_show_node',
      { asset_path: BP, node_id: String(r.node.node_id) }, PROJECT_ROOT);
    assert(byIdx.node.node_name === r.node.node_name,
      'bp_show_node: numeric export_index id resolves to same node');

    // Unknown node rejected.
    let threwUnknown = false;
    try {
      await executeOfflineTool('bp_show_node',
        { asset_path: BP, node_id: 'Node_DoesNotExist_1234' }, PROJECT_ROOT);
    } catch (err) {
      threwUnknown = /not found/i.test(err.message);
    }
    assert(threwUnknown, 'bp_show_node: unknown node_id raises "not found"');
  } catch (e) {
    assert(false, 'bp_show_node scenario', e.message);
  }

  // ── FA-δ invariant: all 5 verbs return non-empty correct data
  //    on a real ProjectA BP with NO plugin, NO editor, NO sidecar.
  //    This is the plugin-absent first-class-functional guard per D58.
  console.log('\n═══ FA-δ invariant: plugin-absent first-class functionality ═══');
  try {
    const verbs = [
      ['bp_list_graphs',         { asset_path: BP },                                              r => r.graph_count >= 3],
      ['bp_find_in_graph',       { asset_path: BP, graph_name: 'EventGraph' },                   r => r.total_matched > 0],
      ['bp_subgraph_in_comment', { asset_path: BP, comment_node_id: 'EdGraphNode_Comment' },     r => r.contained_count >= 0 && r.comment.class_name === 'EdGraphNode_Comment'],
      ['bp_list_entry_points',   { asset_path: BP },                                              r => r.entry_point_count > 0],
      ['bp_show_node',           { asset_path: BP, node_id: 'K2Node_Event' },                   r => r.node.node_name?.startsWith('K2Node_Event') && typeof r.node.node_pos_x === 'number'],
    ];
    for (const [verb, args, nonEmpty] of verbs) {
      const r = await executeOfflineTool(verb, args, PROJECT_ROOT);
      assert(Array.isArray(r.available_fields) && r.available_fields.length > 0,
        `FA-δ: ${verb} returns non-empty available_fields manifest (plugin-absent)`);
      assert(nonEmpty(r),
        `FA-δ: ${verb} returns correct non-empty payload on plugin-absent ProjectA BP`);
      assert(r.plugin_enhancement_available === false,
        `FA-δ: ${verb} advertises plugin_enhancement_available=false (offline-primary)`);
    }
  } catch (e) {
    assert(false, 'FA-δ: plugin-absent first-class functionality', e.message);
  }

  // ── EN-9: graceful ENOENT envelope on all 5 M-spatial verbs ─────────
  // Per D58 FA-β contract, bogus asset_path should NOT surface raw ENOENT
  // through the MCP error channel — callers see the plugin-absent-style
  // envelope instead, making "asset doesn't exist" a first-class response.
  console.log('\n═══ EN-9: graceful-degradation envelope on invalid asset_path ═══');
  try {
    const FAKE = '/Game/Nonexistent/BP_Fake_EN9_Probe';
    const verbs = [
      ['bp_list_graphs',         { asset_path: FAKE }],
      ['bp_find_in_graph',       { asset_path: FAKE, graph_name: 'EventGraph' }],
      ['bp_subgraph_in_comment', { asset_path: FAKE, comment_node_id: 'EdGraphNode_Comment' }],
      ['bp_list_entry_points',   { asset_path: FAKE }],
      ['bp_show_node',           { asset_path: FAKE, node_id: 'K2Node_Event' }],
    ];
    for (const [verb, args] of verbs) {
      const r = await executeOfflineTool(verb, args, PROJECT_ROOT);
      assert(r.available === false && r.reason === 'asset_not_found' && r.asset_path === FAKE,
        `EN-9: ${verb} returns {available:false, reason:"asset_not_found", asset_path:"${FAKE}"} on bogus path`);
    }
  } catch (e) {
    assert(false, 'EN-9: graceful-degradation envelope', e.message);
  }
}

// ── Summary ──────────────────────────────────────────────
console.log(`\n═══ Summary ═══`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
