// M-new Verb-surface tests (D58)
//
// Covers the 5 MCP verbs that wrap S-B-base topology into end-user queries:
//   - bp_trace_exec: BFS walk of outgoing exec pins from a node
//   - bp_trace_data: BFS walk of outgoing non-exec pins
//   - bp_neighbors:  immediate-neighbor edge query
//   - bp_show_node:  pin-block completion extension (M-spatial base + M-new pins)
//   - bp_list_entry_points: has_no_exec_in precision extension
//
// Test strategy:
//   - Happy path + empty + graceful-ENOENT per verb
//   - Oracle-A-v2 cross-check on 3 fixtures: BP_OSPlayerR (dense), BP_OSControlPoint
//     (dense alternative), TestCharacter (small for fast iteration)
//   - D70 invariants: NodeGuid scoped (graph, guid) tuple uniqueness;
//     self-loops preserved; exec/data classification by name-convention
//
// Run: cd D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA && node test-verb-surface.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { executeOfflineTool } from './offline-tools.mjs';

const PROJECT_ROOT = (process.env.UNREAL_PROJECT_ROOT || '').trim();
if (!PROJECT_ROOT) {
  console.error('UNREAL_PROJECT_ROOT not set — cannot exercise fixtures.');
  process.exit(1);
}

let passed = 0;
let failed = 0;
function assert(condition, name, detail) {
  if (condition) { console.log(`  ✓ ${name}`); passed++; }
  else { console.error(`  ✗ ${name}${detail ? ': ' + detail : ''}`); failed++; }
}

// Fixture assets. BP_OSPlayerR is the dense topology (900+ edges across
// several graphs). BP_OSControlPoint has a different graph vocabulary and
// shared exec patterns. TestCharacter is tiny for fast invariant checks.
const BP_DENSE = '/Game/Blueprints/Character/BP_OSPlayerR';
const BP_SECOND = '/Game/Blueprints/Level/BP_OSControlPoint';
const BP_SMALL = '/Game/Blueprints/Character/TestCharacter';
const BOGUS = '/Game/Nonexistent/BP_Fake_MNew_Probe';

const FIX_DIR = join('..', 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'Commandlets', 'fixtures');

async function loadOracle(name) {
  const raw = await readFile(join(FIX_DIR, `${name}.oracle.json`), 'utf-8');
  return JSON.parse(raw);
}

// ── graceful-ENOENT envelope per verb ────────────────────────────────
console.log('\n═══ FA-β graceful-ENOENT on bogus asset paths ═══');
{
  for (const tool of ['bp_trace_exec', 'bp_trace_data', 'bp_neighbors']) {
    const params = tool === 'bp_neighbors'
      ? { asset_path: BOGUS, graph_name: 'EventGraph', node_id: '0'.repeat(32) }
      : { asset_path: BOGUS, graph_name: 'EventGraph', start_node_id: '0'.repeat(32) };
    const r = await executeOfflineTool(tool, params, PROJECT_ROOT);
    assert(r && r.available === false && r.reason === 'asset_not_found',
      `${tool}: ENOENT → {available:false, reason:"asset_not_found"}`,
      JSON.stringify(r));
    assert(r && r.asset_path === BOGUS,
      `${tool}: ENOENT envelope echoes asset_path`);
  }
}

// ── load oracle + enumerate first entry point per graph ──────────────
const oracle = await loadOracle('BP_OSPlayerR');
const eventGraph = oracle.graphs.EventGraph;
const eventGraphNodeGuids = Object.keys(eventGraph.nodes);
// Pick a node with outgoing exec connectivity — canonical test seed:
// walk until we find a node whose pin set contains an exec output pin
// with a non-empty linked_to. Depends on oracle contents, not our
// classifier.
const EXEC_NAMES = new Set(['execute', 'exec', 'then', 'else', 'completed', 'castfailed', 'loopbody', 'throw']);
function looksExec(name) {
  if (!name) return false;
  if (/^then_\d+$/i.test(name)) return true;
  if (/^out( \d+)?$/i.test(name)) return true;
  return EXEC_NAMES.has(name.toLowerCase());
}
function pickExecSource(graph) {
  for (const [guid, node] of Object.entries(graph.nodes)) {
    for (const pin of Object.values(node.pins)) {
      if (pin.direction === 'EGPD_Output' && looksExec(pin.name) && pin.linked_to.length > 0) {
        return { node_guid: guid, class_name: node.class_name, via_pin: pin.name };
      }
    }
  }
  return null;
}
function pickDataSource(graph) {
  for (const [guid, node] of Object.entries(graph.nodes)) {
    for (const pin of Object.values(node.pins)) {
      if (pin.direction === 'EGPD_Output' && !looksExec(pin.name) && pin.linked_to.length > 0) {
        return { node_guid: guid, class_name: node.class_name, via_pin: pin.name };
      }
    }
  }
  return null;
}
function pickTerminal(graph) {
  // A "terminal" has no outgoing exec links at all — good for empty-chain
  // test. Prefer pure-data nodes (VariableGet style).
  for (const [guid, node] of Object.entries(graph.nodes)) {
    const hasExecOut = Object.values(node.pins).some(
      p => p.direction === 'EGPD_Output' && looksExec(p.name) && p.linked_to.length > 0);
    if (!hasExecOut) return { node_guid: guid, class_name: node.class_name };
  }
  return null;
}

const execSource = pickExecSource(eventGraph);
const dataSource = pickDataSource(eventGraph);
const terminal = pickTerminal(eventGraph);

// ── bp_trace_exec happy path ─────────────────────────────────────────
console.log('\n═══ bp_trace_exec: BP_OSPlayerR happy path ═══');
{
  assert(execSource !== null, 'seed: found an exec source node in oracle EventGraph');
  const r = await executeOfflineTool('bp_trace_exec', {
    asset_path: BP_DENSE,
    graph_name: 'EventGraph',
    start_node_id: execSource.node_guid,
  }, PROJECT_ROOT);
  assert(Array.isArray(r.chain) && r.chain.length >= 1,
    'bp_trace_exec: chain[] non-empty (at minimum start node)');
  assert(r.chain[0].node_guid === execSource.node_guid && r.chain[0].depth === 0,
    'bp_trace_exec: chain[0] is the start node at depth 0');
  assert(r.chain[0].via_pin === null && r.chain[0].from_node_guid === null,
    'bp_trace_exec: start node has via_pin=null, from_node_guid=null');
  assert(r.chain.every(c => typeof c.class_name === 'string'),
    'bp_trace_exec: every chain entry has class_name');
  assert(r.chain.length >= 2,
    'bp_trace_exec: BP_OSPlayerR entry-point chain reaches 2+ nodes');
  assert(new Set(r.chain.map(c => c.node_guid)).size === r.chain.length,
    'bp_trace_exec: cycle-safe (no duplicate nodes in chain)');
  assert(r.chain.every(c => c.depth <= r.max_depth),
    'bp_trace_exec: every chain entry depth <= max_depth');
  assert(Array.isArray(r.available_fields) && r.available_fields.includes('pin_block'),
    'bp_trace_exec: FA-β manifest advertises pin_block available');
  assert(r.plugin_enhancement_available === false,
    'bp_trace_exec: plugin_enhancement_available=false (offline-primary)');
}

// bp_trace_exec: max_depth cap
{
  const r = await executeOfflineTool('bp_trace_exec', {
    asset_path: BP_DENSE,
    graph_name: 'EventGraph',
    start_node_id: execSource.node_guid,
    max_depth: 1,
  }, PROJECT_ROOT);
  assert(r.chain.every(c => c.depth <= 1),
    'bp_trace_exec: max_depth=1 bounds depth strictly');
  assert(r.max_depth === 1, 'bp_trace_exec: max_depth echoed in response');
}

// bp_trace_exec: pin_name filter
{
  // Find an IfThenElse or Branch node to test pin_name filtering.
  const branchEntry = Object.entries(eventGraph.nodes).find(
    ([, n]) => n.class_name === 'K2Node_IfThenElse');
  if (branchEntry) {
    const [guid] = branchEntry;
    const rAll = await executeOfflineTool('bp_trace_exec', {
      asset_path: BP_DENSE, graph_name: 'EventGraph',
      start_node_id: guid, max_depth: 3,
    }, PROJECT_ROOT);
    const rThen = await executeOfflineTool('bp_trace_exec', {
      asset_path: BP_DENSE, graph_name: 'EventGraph',
      start_node_id: guid, max_depth: 3, pin_name: 'then',
    }, PROJECT_ROOT);
    assert(rThen.pin_name_filter === 'then',
      'bp_trace_exec: pin_name_filter echoed');
    assert(rThen.chain.length <= rAll.chain.length,
      'bp_trace_exec: pin_name filter narrows or equals unfiltered chain');
    // Every non-start chain entry was reached via the filtered pin.
    const viaPins = new Set(rThen.chain.slice(1).map(c => c.via_pin_name));
    assert(viaPins.size === 0 || (viaPins.size === 1 && viaPins.has('then')),
      'bp_trace_exec: filter=then yields only via_pin_name="then" descendants');
  } else {
    console.log('  (skipped pin_name filter: no K2Node_IfThenElse in EventGraph)');
  }
}

// bp_trace_exec: graph_not_found + node_not_found
console.log('\n═══ bp_trace_exec: error envelopes ═══');
{
  const badGraph = await executeOfflineTool('bp_trace_exec', {
    asset_path: BP_DENSE, graph_name: 'NoSuchGraph', start_node_id: execSource.node_guid,
  }, PROJECT_ROOT);
  assert(badGraph.available === false && badGraph.reason === 'graph_not_found',
    'bp_trace_exec: unknown graph → reason:graph_not_found');
  assert(Array.isArray(badGraph.available_graphs) && badGraph.available_graphs.length > 0,
    'bp_trace_exec: graph_not_found envelope lists available_graphs');

  const badNode = await executeOfflineTool('bp_trace_exec', {
    asset_path: BP_DENSE, graph_name: 'EventGraph', start_node_id: '0'.repeat(32),
  }, PROJECT_ROOT);
  assert(badNode.available === false && badNode.reason === 'node_not_found',
    'bp_trace_exec: unknown node → reason:node_not_found');
}

// bp_trace_exec: empty chain (terminal node)
console.log('\n═══ bp_trace_exec: terminal/empty chain ═══');
{
  if (terminal) {
    const r = await executeOfflineTool('bp_trace_exec', {
      asset_path: BP_DENSE, graph_name: 'EventGraph', start_node_id: terminal.node_guid,
    }, PROJECT_ROOT);
    assert(r.chain.length === 1 && r.chain[0].node_guid === terminal.node_guid,
      'bp_trace_exec: terminal node chain is just the start node');
  } else {
    console.log('  (skipped terminal: every node in BP_OSPlayerR EventGraph has exec out)');
  }
}

// ── bp_trace_data ────────────────────────────────────────────────────
console.log('\n═══ bp_trace_data: happy path + error envelopes ═══');
{
  assert(dataSource !== null, 'seed: found a data source node in oracle EventGraph');
  const r = await executeOfflineTool('bp_trace_data', {
    asset_path: BP_DENSE, graph_name: 'EventGraph',
    start_node_id: dataSource.node_guid,
  }, PROJECT_ROOT);
  assert(Array.isArray(r.sinks), 'bp_trace_data: sinks[] is array');
  assert(r.sinks.length >= 1, 'bp_trace_data: at least one data edge from seed');
  assert(r.sinks.every(s => typeof s.source_pin === 'string' && typeof s.sink_pin === 'string'),
    'bp_trace_data: every sink has source_pin + sink_pin');
  assert(r.sinks.every(s => typeof s.depth === 'number' && s.depth >= 0),
    'bp_trace_data: every sink has numeric depth');
  assert(r.sinks.every(s => typeof s.from_node_guid === 'string' && typeof s.to_node_guid === 'string'),
    'bp_trace_data: every sink has from/to node guids');
  assert(r.sink_count === r.sinks.length,
    'bp_trace_data: sink_count matches sinks[] length');

  // Error envelopes
  const badGraph = await executeOfflineTool('bp_trace_data', {
    asset_path: BP_DENSE, graph_name: 'NoSuchGraph', start_node_id: dataSource.node_guid,
  }, PROJECT_ROOT);
  assert(badGraph.available === false && badGraph.reason === 'graph_not_found',
    'bp_trace_data: unknown graph → reason:graph_not_found');

  const badNode = await executeOfflineTool('bp_trace_data', {
    asset_path: BP_DENSE, graph_name: 'EventGraph', start_node_id: 'F'.repeat(32),
  }, PROJECT_ROOT);
  assert(badNode.available === false && badNode.reason === 'node_not_found',
    'bp_trace_data: unknown node → reason:node_not_found');

  // max_depth cap
  const rDepth1 = await executeOfflineTool('bp_trace_data', {
    asset_path: BP_DENSE, graph_name: 'EventGraph',
    start_node_id: dataSource.node_guid, max_depth: 1,
  }, PROJECT_ROOT);
  assert(rDepth1.sinks.every(s => s.depth <= 1),
    'bp_trace_data: max_depth=1 bounds sink depth');
}

// ── bp_neighbors ─────────────────────────────────────────────────────
console.log('\n═══ bp_neighbors: both/in/out/self-loop ═══');
{
  const r = await executeOfflineTool('bp_neighbors', {
    asset_path: BP_DENSE, graph_name: 'EventGraph',
    node_id: execSource.node_guid,
  }, PROJECT_ROOT);
  assert(r.direction === 'both', 'bp_neighbors: default direction=both');
  assert(Array.isArray(r.incoming) && Array.isArray(r.outgoing),
    'bp_neighbors: incoming[] and outgoing[] both present');
  assert(r.outgoing.length >= 1,
    'bp_neighbors: exec source has at least one outgoing edge');
  assert(r.outgoing.every(e => e.edge_kind === 'exec' || e.edge_kind === 'data'),
    'bp_neighbors: edge_kind is exec|data');
  assert(r.outgoing.every(e => typeof e.local_pin === 'string' && typeof e.remote_pin === 'string'),
    'bp_neighbors: every outgoing edge has local_pin + remote_pin');

  // direction=outgoing only
  const rOut = await executeOfflineTool('bp_neighbors', {
    asset_path: BP_DENSE, graph_name: 'EventGraph',
    node_id: execSource.node_guid, direction: 'outgoing',
  }, PROJECT_ROOT);
  assert(rOut.incoming.length === 0 && rOut.outgoing.length === r.outgoing.length,
    'bp_neighbors: direction=outgoing yields empty incoming, same outgoing count');

  // direction=incoming only
  const rIn = await executeOfflineTool('bp_neighbors', {
    asset_path: BP_DENSE, graph_name: 'EventGraph',
    node_id: execSource.node_guid, direction: 'incoming',
  }, PROJECT_ROOT);
  assert(rIn.outgoing.length === 0,
    'bp_neighbors: direction=incoming yields empty outgoing');

  // direction=both incoming equals direction=incoming incoming (idempotence)
  assert(rIn.incoming.length === r.incoming.length,
    'bp_neighbors: incoming count is consistent across direction modes');

  // Exec+data edge kinds reflect name-convention classification.
  const allEdges = [...r.incoming, ...r.outgoing];
  const execEdges = allEdges.filter(e => e.edge_kind === 'exec');
  assert(execEdges.length === 0 || execEdges.every(e => looksExec(e.local_pin_name) || looksExec(e.remote_pin_name)),
    'bp_neighbors: exec-classified edges have an exec-named pin at one end');

  // Bad direction → throws
  let threwBadDir = false;
  try {
    await executeOfflineTool('bp_neighbors', {
      asset_path: BP_DENSE, graph_name: 'EventGraph',
      node_id: execSource.node_guid, direction: 'sideways',
    }, PROJECT_ROOT);
  } catch (err) {
    threwBadDir = /Invalid direction/.test(err.message);
  }
  assert(threwBadDir, 'bp_neighbors: rejects invalid direction with clear message');

  // node_not_found envelope
  const badNode = await executeOfflineTool('bp_neighbors', {
    asset_path: BP_DENSE, graph_name: 'EventGraph', node_id: '0'.repeat(32),
  }, PROJECT_ROOT);
  assert(badNode.available === false && badNode.reason === 'node_not_found',
    'bp_neighbors: unknown node → reason:node_not_found');
}

// ── bp_show_node pin-block completion ────────────────────────────────
console.log('\n═══ bp_show_node: M-new pin-block extension ═══');
{
  // Pick any graph-node export — use bp_list_entry_points for a stable seed.
  const ep = await executeOfflineTool('bp_list_entry_points',
    { asset_path: BP_DENSE }, PROJECT_ROOT);
  assert(ep.entry_points.length > 0, 'bp_show_node seed: bp_list_entry_points returns at least one entry');
  const seed = ep.entry_points[0];
  const r = await executeOfflineTool('bp_show_node',
    { asset_path: BP_DENSE, node_id: String(seed.node_id) }, PROJECT_ROOT);
  assert(Array.isArray(r.node.pins) && r.node.pins.length > 0,
    'bp_show_node: entry-point pins[] is populated');
  assert(r.node.pins.every(p => typeof p.pin_id === 'string' && p.pin_id.length === 32),
    'bp_show_node: every pin has 32-char pin_id');
  assert(r.node.pins.every(p => p.direction === 'EGPD_Input' || p.direction === 'EGPD_Output'),
    'bp_show_node: every pin direction is EGPD_Input/Output');
  assert(r.node.pins.every(p => p.pin_kind === 'exec' || p.pin_kind === 'data'),
    'bp_show_node: every pin is exec|data classified');
  assert(r.node.pins.every(p => Array.isArray(p.linked_to)),
    'bp_show_node: every pin has linked_to[] array');
  assert(r.available_fields.includes('pin_block'),
    'bp_show_node: pin_block now in available_fields');
  assert(!r.not_available.includes('pin_block'),
    'bp_show_node: pin_block absent from not_available when resolved');
}

// ── bp_list_entry_points has_no_exec_in precision ────────────────────
console.log('\n═══ bp_list_entry_points: has_no_exec_in precision ═══');
{
  const r = await executeOfflineTool('bp_list_entry_points',
    { asset_path: BP_DENSE }, PROJECT_ROOT);
  assert(r.entry_points.every(e =>
    e.has_no_exec_in === true || e.has_no_exec_in === false || e.has_no_exec_in === null),
    'bp_list_entry_points: every entry has boolean|null has_no_exec_in');
  assert(r.entry_points.some(e => e.has_no_exec_in === true),
    'bp_list_entry_points: at least one true-entry (has_no_exec_in=true) on BP_OSPlayerR');
  assert(r.available_fields.includes('exec_connectivity'),
    'bp_list_entry_points: exec_connectivity now in available_fields');
  assert(!r.not_available.includes('exec_connectivity'),
    'bp_list_entry_points: exec_connectivity absent from not_available');
}

// ── Oracle cross-check: BP_OSPlayerR ─────────────────────────────────
console.log('\n═══ Oracle-A cross-check: BP_OSPlayerR EventGraph ═══');
{
  // Walk every node in oracle EventGraph, check that bp_neighbors outgoing
  // edges match oracle's linked_to for that node (for at least the seed
  // sample — don't iterate 100s of nodes at test time).
  const sampleGuids = eventGraphNodeGuids.slice(0, 5);
  for (const guid of sampleGuids) {
    const oracleNode = eventGraph.nodes[guid];
    const oracleOut = [];
    for (const [pinId, pin] of Object.entries(oracleNode.pins)) {
      if (pin.direction !== 'EGPD_Output') continue;
      for (const link of pin.linked_to) {
        oracleOut.push(`${pinId}->${link.node_guid}:${link.pin_id}`);
      }
    }
    const r = await executeOfflineTool('bp_neighbors', {
      asset_path: BP_DENSE, graph_name: 'EventGraph',
      node_id: guid, direction: 'outgoing',
    }, PROJECT_ROOT);
    const parsedOut = r.outgoing.map(e => `${e.local_pin}->${e.node_guid}:${e.remote_pin}`);
    assert(parsedOut.length === oracleOut.length,
      `oracle-xcheck BP_OSPlayerR ${guid.slice(0, 8)}: outgoing edge count matches (${parsedOut.length} vs oracle ${oracleOut.length})`);
    // Order-independent match
    const parsedSet = new Set(parsedOut);
    const allPresent = oracleOut.every(e => parsedSet.has(e));
    assert(allPresent,
      `oracle-xcheck BP_OSPlayerR ${guid.slice(0, 8)}: every oracle edge present in parsed outgoing`);
  }
}

// ── Oracle cross-check: BP_OSControlPoint ────────────────────────────
console.log('\n═══ Oracle-A cross-check: BP_OSControlPoint ═══');
{
  const oracle2 = await loadOracle('BP_OSControlPoint');
  // Prefer EventGraph; fall back to any graph with ≥2 nodes.
  const graphs2 = Object.keys(oracle2.graphs);
  const pickGraph = oracle2.graphs.EventGraph
    ? 'EventGraph'
    : graphs2.find(g => Object.keys(oracle2.graphs[g].nodes).length >= 2);
  assert(pickGraph !== undefined, 'BP_OSControlPoint: at least one oracle graph has nodes');
  const g = oracle2.graphs[pickGraph];
  const seed2 = pickExecSource(g) ?? pickDataSource(g);
  assert(seed2 !== null, `BP_OSControlPoint ${pickGraph}: seed node found`);

  const r = await executeOfflineTool('bp_neighbors', {
    asset_path: BP_SECOND, graph_name: pickGraph,
    node_id: seed2.node_guid, direction: 'both',
  }, PROJECT_ROOT);
  assert(r.available !== false, 'bp_neighbors on BP_OSControlPoint succeeds');
  const oracleNode = g.nodes[seed2.node_guid];
  const oracleOutCount = Object.values(oracleNode.pins)
    .filter(p => p.direction === 'EGPD_Output')
    .reduce((n, p) => n + p.linked_to.length, 0);
  assert(r.outgoing.length === oracleOutCount,
    `BP_OSControlPoint seed outgoing edge count matches oracle (${r.outgoing.length} vs ${oracleOutCount})`);
}

// ── Oracle cross-check: TestCharacter (small fixture) ────────────────
console.log('\n═══ Oracle-A cross-check: TestCharacter (small) ═══');
{
  const oracle3 = await loadOracle('TestCharacter');
  const graphs3 = Object.keys(oracle3.graphs);
  if (graphs3.length === 0) {
    console.log('  (skipped TestCharacter: oracle has zero graphs)');
  } else {
    // Pick any graph with nodes.
    const pick = graphs3.find(g => Object.keys(oracle3.graphs[g].nodes).length >= 1);
    if (!pick) {
      console.log('  (skipped TestCharacter: no graph has nodes)');
    } else {
      const g = oracle3.graphs[pick];
      const [anyGuid] = Object.keys(g.nodes);
      const r = await executeOfflineTool('bp_neighbors', {
        asset_path: BP_SMALL, graph_name: pick, node_id: anyGuid, direction: 'both',
      }, PROJECT_ROOT);
      assert(r.available !== false,
        `bp_neighbors on TestCharacter ${pick} succeeds`);
      // Test the small fixture mainly for "doesn't crash + shape sanity".
      assert(typeof r.incoming_count === 'number' && typeof r.outgoing_count === 'number',
        'TestCharacter: neighbor counts are numeric');
    }
  }
}

// ── Cycle safety (synthetic — ensure visited-set guards infinite loops) ───
console.log('\n═══ bp_trace_exec: cycle safety invariant ═══');
{
  // Walk from an exec source; even on a graph with cycles, chain length
  // must be ≤ total nodes in the graph (bounded by visited set).
  const graphSize = eventGraphNodeGuids.length;
  const r = await executeOfflineTool('bp_trace_exec', {
    asset_path: BP_DENSE,
    graph_name: 'EventGraph',
    start_node_id: execSource.node_guid,
    max_depth: 500,
  }, PROJECT_ROOT);
  assert(r.chain.length <= graphSize,
    `bp_trace_exec: chain length ≤ graph node count (${r.chain.length} ≤ ${graphSize})`);
}

// ── FA-β invariant: all verbs advertise schema_version + manifest ────
console.log('\n═══ FA-β manifest shape across all 5 verbs ═══');
{
  const showNode = await executeOfflineTool('bp_show_node',
    { asset_path: BP_DENSE, node_id: '1' }, PROJECT_ROOT);
  assert(typeof showNode.schema_version === 'string',
    'bp_show_node: schema_version emitted');
  const entryPoints = await executeOfflineTool('bp_list_entry_points',
    { asset_path: BP_DENSE }, PROJECT_ROOT);
  assert(typeof entryPoints.schema_version === 'string',
    'bp_list_entry_points: schema_version emitted');
  const traceExec = await executeOfflineTool('bp_trace_exec', {
    asset_path: BP_DENSE, graph_name: 'EventGraph',
    start_node_id: execSource.node_guid,
  }, PROJECT_ROOT);
  assert(typeof traceExec.schema_version === 'string',
    'bp_trace_exec: schema_version emitted');
  const traceData = await executeOfflineTool('bp_trace_data', {
    asset_path: BP_DENSE, graph_name: 'EventGraph',
    start_node_id: dataSource.node_guid,
  }, PROJECT_ROOT);
  assert(typeof traceData.schema_version === 'string',
    'bp_trace_data: schema_version emitted');
  const neighbors = await executeOfflineTool('bp_neighbors', {
    asset_path: BP_DENSE, graph_name: 'EventGraph',
    node_id: execSource.node_guid,
  }, PROJECT_ROOT);
  assert(typeof neighbors.schema_version === 'string',
    'bp_neighbors: schema_version emitted');
}

// ── yaml registration ────────────────────────────────────────────────
console.log('\n═══ tools.yaml registration for M-new verbs ═══');
{
  const raw = await readFile(join('..', 'tools.yaml'), 'utf-8');
  for (const verb of ['bp_trace_exec', 'bp_trace_data', 'bp_neighbors']) {
    assert(raw.includes(`${verb}:`),
      `tools.yaml: ${verb} declared`);
  }
}

// ── Summary ──────────────────────────────────────────────────────────
console.log('\n═══ Summary ═══');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);
process.exit(failed > 0 ? 1 : 0);
