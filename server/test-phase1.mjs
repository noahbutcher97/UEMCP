// Phase 1 Verification Tests
// Run: cd D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA && node test-phase1.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { ToolIndex } from './tool-index.mjs';
import { ToolsetManager } from './toolset-manager.mjs';
import { ConnectionManager } from './connection-manager.mjs';
import { executeOfflineTool } from './offline-tools.mjs';
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

  // search_gameplay_tags for combat
  try {
    const combat = await executeOfflineTool('search_gameplay_tags',
      { pattern: 'Attack' }, PROJECT_ROOT);
    const hasAttack = JSON.stringify(combat).includes('Attack');
    assert(hasAttack, 'search_gameplay_tags("Attack") finds attack tags');
  } catch (e) {
    assert(false, 'search_gameplay_tags', e.message);
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
  // Use max_bytes=500 on BP_OSPlayerR to force size_budget_exceeded markers
  // — a reliable way to exercise the filter-scoping path without depending on
  // fixture-specific complex-container shapes (Agent 10.5's D50 tagged-fallback
  // decodes most former "unsupported" properties).
  try {
    const full = await executeOfflineTool('read_asset_properties',
      { asset_path: '/Game/Blueprints/Character/BP_OSPlayerR', max_bytes: 500 }, PROJECT_ROOT);
    const markerNames = full.unsupported.map(m => m.name);
    assert(markerNames.length >= 2,
      `P2 setup: BP_OSPlayerR with max_bytes=500 emits multiple markers (got ${markerNames.length})`);

    // Pick one marker to keep and one to scope out.
    const keep = markerNames[0];
    const scopeOut = markerNames[1];
    assert(keep !== scopeOut, 'P2 setup: distinct marker names available');

    // Filter for only `keep` — `scopeOut` marker must NOT appear.
    const filtered = await executeOfflineTool('read_asset_properties',
      { asset_path: '/Game/Blueprints/Character/BP_OSPlayerR', max_bytes: 500,
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

// ── Summary ──────────────────────────────────────────────
console.log(`\n═══ Summary ═══`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
