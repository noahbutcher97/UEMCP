// Partial INV-158/168: this saved graph has an exec edge but no positive data wires.
// Positive sinks, fan-out, multi-hop traversal and depth truncation remain unqualified.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { executeOfflineTool } from './offline-tools.mjs';
import { verifyOwnedFixture } from './owned-serialization.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Owned Blueprint empty data traversal');
const root = fileURLToPath(new URL('./fixtures/serialization/ue5.6-owned-v1/', import.meta.url));
const eventId = '00000001ABCDEF1280000000FFFFFFFF';
const callId = '12345678000000020000000300000004';
const graphName = 'OwnedGraph';
let oracle;
let eventPinId;
let callPinId;
try {
  await verifyOwnedFixture(root, 'ue5.6-owned-v1');
  oracle = JSON.parse(readFileSync(new URL('./fixtures/serialization/ue5.6-owned-v1/oracle.json', import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
  const nodes = oracle.graphs[graphName].nodes;
  [eventPinId] = Object.entries(nodes[eventId].pins).find(([, p]) => p.name === 'then');
  [callPinId] = Object.entries(nodes[callId].pins).find(([, p]) => p.name === 'execute');
  // Establish every actual linked pin independently of bp_trace_data's empty result.
  // Only this reciprocal exec connection exists; all other pins are unlinked.
  const links = Object.entries(nodes).flatMap(([node, value]) => Object.entries(value.pins)
    .filter(([, pin]) => pin.linked_to.length)
    .map(([pinId, pin]) => ({ node, pinId, ...pin })));
  assert.deepEqual(links, [
    { node: eventId, pinId: eventPinId, name: 'then', direction: 'EGPD_Output',
      linked_to: [{ node_guid: callId, pin_id: callPinId }] },
    { node: callId, pinId: callPinId, name: 'execute', direction: 'EGPD_Input',
      linked_to: [{ node_guid: eventId, pin_id: eventPinId }] },
  ]);
} catch (error) {
  t.assert(false, 'owned data: corpus and exec-only topology prerequisites', error.stack);
  process.exit(t.summary());
}
const base = { asset_path: oracle.asset_path, graph_name: graphName };
const query = (tool, params = {}) => executeOfflineTool(tool, { ...base, ...params }, root);
const trace = (params = {}) => query('bp_trace_data', { start_node_id: eventId, ...params });
// Independent four-word byte conversion; never call the production GUID bridge.
const rawGuid = canonical => Buffer.from(canonical, 'hex').swap32().toString('hex');
async function check(name, run) {
  try { await run(); t.assert(true, `owned data: ${name}`); }
  catch (error) { t.assert(false, `owned data: ${name}`, error.stack); }
}
function assertEmpty(result, id = eventId, maxDepth = 50) {
  assert.notEqual(result.available, false);
  assert.equal(result.asset_path, oracle.asset_path);
  assert.equal(result.graph_name, graphName);
  assert.equal(result.start_node_id, id);
  assert.equal(result.max_depth, maxDepth);
  assert.equal(result.max_depth_reached, 0);
  assert.equal(result.truncated_at_depth, false);
  assert.equal(result.sink_count, 0);
  assert.deepEqual(result.sinks, []);
  assert.equal(result.schema_version, 'm-spatial-v1');
  assert.ok(result.available_fields.includes('exec_connectivity'));
  assert.ok(result.available_fields.includes('pin_block'));
}
await check('known positive exec edge is excluded from data sinks', async () => {
  const exec = await query('bp_trace_exec', { start_node_id: eventId });
  assert.deepEqual(exec.chain.map(n => n.node_guid), [eventId, callId]);
  assert.equal(exec.chain[1].via_pin, eventPinId);
  assertEmpty(await trace());
});
await check('terminal call has no outgoing data sinks', async () => {
  assertEmpty(await trace({ start_node_id: callId }), callId);
});
// This checks clamp/empty-walk metadata, not traversal of a path reaching the cap.
for (const [input, expected] of [[-1, 1], [0, 1], [1, 1], [500, 500], [501, 500]]) {
  await check(`empty traversal at requested depth ${input} reports cap ${expected}`, async () => {
    assertEmpty(await trace({ max_depth: input }), eventId, expected);
  });
}
await check('raw entry-point GUID feeds data query and echoes oracle canonical identity', async () => {
  const entries = await query('bp_list_entry_points');
  assert.equal(entries.entry_points.length, 1);
  const seed = entries.entry_points[0];
  assert.equal(seed.graph_name, graphName);
  assert.equal(seed.node_guid, rawGuid(eventId));
  assert.notEqual(seed.node_guid, eventId, 'fixture must exercise nontrivial byte order');
  const canonical = await trace();
  assertEmpty(canonical);
  const fromEntry = await trace({ graph_name: seed.graph_name, start_node_id: seed.node_guid });
  assertEmpty(fromEntry);
  assert.deepEqual(fromEntry, canonical);
});
await check('raw inspected call GUID echoes its distinct oracle canonical identity', async () => {
  const shown = await query('bp_show_node', { node_id: 'OwnedPrint' });
  assert.equal(shown.node.node_guid, rawGuid(callId));
  assert.notEqual(shown.node.node_guid, callId);
  const canonical = await trace({ start_node_id: callId });
  assertEmpty(canonical, callId);
  const fromInspection = await trace({ start_node_id: shown.node.node_guid });
  assertEmpty(fromInspection, callId);
  assert.deepEqual(fromInspection, canonical);
});
await check('unknown graph returns exact unavailable envelope', async () => {
  assertEmpty(await trace());
  assert.deepEqual(await trace({ graph_name: 'MissingOwnedGraph' }), {
    available: false, reason: 'graph_not_found', asset_path: oracle.asset_path,
    graph_name: 'MissingOwnedGraph', available_graphs: [graphName],
  });
});
await check('unknown node returns exact unavailable envelope', async () => {
  assertEmpty(await trace());
  const missing = '00000000000000000000000000000000';
  assert.deepEqual(await trace({ start_node_id: missing }), {
    available: false, reason: 'node_not_found', ...base, start_node_id: missing,
  });
});
for (const field of ['asset_path', 'graph_name', 'start_node_id']) {
  await check(`missing ${field} is rejected after valid baseline`, async () => {
    assertEmpty(await trace());
    const params = { ...base, start_node_id: eventId };
    delete params[field];
    await assert.rejects(() => executeOfflineTool('bp_trace_data', params, root),
      new RegExp(`Missing required parameter: ${field}`));
  });
}
// Response mutations are negative comparator controls, never positive data fixtures.
const leakedExec = { from_node_guid: eventId, to_node_guid: callId,
  class_name: 'K2Node_CallFunction', source_pin: eventPinId, source_pin_name: 'then',
  sink_pin: callPinId, sink_pin_name: 'execute', depth: 0 };
for (const [label, mutate] of [
  ['exec edge leaked with consistent count', r => { r.sinks = [leakedExec]; r.sink_count = 1; }],
  ['invented sink despite zero count', r => { r.sinks = [leakedExec]; }],
  ['nonzero count despite empty sinks', r => { r.sink_count = 1; }],
  ['raw rather than canonical echo', r => { r.start_node_id = rawGuid(eventId); }],
  ['wrong asset identity', r => { r.asset_path = '/Game/Other'; }],
  ['wrong graph identity', r => { r.graph_name = 'OtherGraph'; }],
  ['incorrect depth cap', r => { r.max_depth = 0; }],
  ['false reached depth', r => { r.max_depth_reached = 1; }],
  ['false truncation', r => { r.truncated_at_depth = true; }],
  ['unavailable success-shaped response', r => { r.available = false; }],
]) {
  await check(`controls reject ${label}`, async () => {
    const result = await trace();
    assertEmpty(result);
    const changed = structuredClone(result);
    mutate(changed);
    assert.throws(() => assertEmpty(changed), assert.AssertionError);
  });
}
process.exit(t.summary());
