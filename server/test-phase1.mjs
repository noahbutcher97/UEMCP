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
  try {
    const lvl = await executeOfflineTool('list_level_actors',
      { asset_path: '/Game/Maps/Deployable/MarketPlace/MarketPlace_P' }, PROJECT_ROOT);
    assert(lvl.placedActorCount !== undefined, 'F4: response has placedActorCount');
    assert(lvl.placedActorCount < lvl.exportCount,
      `F4: placed actors (${lvl.placedActorCount}) < total exports (${lvl.exportCount})`);
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

// ── Summary ──────────────────────────────────────────────
console.log(`\n═══ Summary ═══`);
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
