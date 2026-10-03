import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { executeOfflineTool } from './offline-tools.mjs';
import { verifyOwnedFixture } from './owned-serialization.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const t = new TestRunner('Owned Blueprint exec queries');
const version = 'ue5.6-owned-v1';
const root = fileURLToPath(new URL(`./fixtures/serialization/${version}/`, import.meta.url));
async function check(name, run) {
  try { await run(); t.assert(true, name); }
  catch (error) { t.assert(false, name, error.message); }
}
// Verify raw bytes and provenance before any public query. Missing data fails;
// it cannot turn this required owned contract into an optional consumer canary.
try { await verifyOwnedFixture(root, version); }
catch (error) { t.assert(false, 'owned exec fixture prerequisite', error.message); process.exit(t.summary()); }
const oracle = JSON.parse(readFileSync(new URL(`./fixtures/serialization/${version}/oracle.json`, import.meta.url), 'utf8').replace(/^\uFEFF/, ''));
const graphName = 'OwnedGraph';
const nodes = oracle.graphs[graphName].nodes;
const [eventId, event] = Object.entries(nodes).find(([, node]) => node.class_name === 'K2Node_CustomEvent');
const [eventPinId, eventPin] = Object.entries(event.pins).find(([, pin]) => pin.name === 'then' && pin.direction === 'EGPD_Output');
assert.equal(eventPin.linked_to.length, 1);
const { node_guid: callId, pin_id: callPinId } = eventPin.linked_to[0];
const call = nodes[callId];
const callPin = call.pins[callPinId];
assert.equal(callPin.name, 'execute');
assert.equal(callPin.direction, 'EGPD_Input');
assert.ok(Object.values(call.pins).filter(pin => pin.direction === 'EGPD_Output').every(pin => pin.linked_to.length === 0), 'UE oracle must establish that the call is terminal');
const base = { asset_path: oracle.asset_path, graph_name: graphName };
const query = (name, params = {}) => executeOfflineTool(name, { ...base, ...params }, root);
const trace = params => query('bp_trace_exec', { start_node_id: eventId, ...params });
const neighbors = params => query('bp_neighbors', { node_id: eventId, ...params });
const start = (id, node) => ({ node_guid: id, class_name: node.class_name, via_pin: null, via_pin_name: null, from_node_guid: null, depth: 0 });
const expectedChain = [start(eventId, event), { node_guid: callId, class_name: call.class_name, via_pin: eventPinId, via_pin_name: eventPin.name, from_node_guid: eventId, depth: 1 }];
const outgoing = { node_guid: callId, class_name: call.class_name, local_pin: eventPinId, local_pin_name: eventPin.name, remote_pin: callPinId, remote_pin_name: callPin.name, edge_kind: 'exec' };
const incoming = { node_guid: eventId, class_name: event.class_name, local_pin: callPinId, local_pin_name: callPin.name, remote_pin: eventPinId, remote_pin_name: eventPin.name, edge_kind: 'exec' };
function assertTrace(actual, chain, filter = null) {
  assert.equal(actual.asset_path, base.asset_path);
  assert.equal(actual.graph_name, graphName);
  assert.equal(actual.start_node_id, chain[0].node_guid);
  assert.equal(actual.pin_name_filter, filter);
  assert.equal(actual.chain_length, chain.length);
  assert.equal(actual.max_depth_reached, chain.at(-1).depth);
  assert.equal(actual.truncated_at_depth, false);
  assert.deepEqual(actual.chain, chain);
}
function assertNeighbors(actual, nodeId, direction, expectedIn, expectedOut) {
  assert.equal(actual.asset_path, base.asset_path);
  assert.equal(actual.graph_name, graphName);
  assert.equal(actual.node_id, nodeId);
  assert.equal(actual.direction, direction);
  assert.equal(actual.incoming_count, expectedIn.length);
  assert.equal(actual.outgoing_count, expectedOut.length);
  assert.deepEqual(actual.incoming, expectedIn);
  assert.deepEqual(actual.outgoing, expectedOut);
}
await check('owned exec: exact oracle chain at depths zero and one', async () => assertTrace(await trace(), expectedChain));
await check('owned exec: matching pin filter preserves exact chain', async () => assertTrace(await trace({ pin_name: 'then' }), expectedChain, 'then'));
await check('owned exec: unmatched pin filter yields only start', async () => assertTrace(await trace({ pin_name: 'AbsentOwnedPin' }), [expectedChain[0]], 'AbsentOwnedPin'));
await check('owned exec: terminal node yields only start', async () => assertTrace(await trace({ start_node_id: callId }), [start(callId, call)]));
for (const direction of ['both', 'incoming', 'outgoing']) {
  await check(`owned neighbors: event ${direction} matches oracle`, async () => assertNeighbors(await neighbors({ direction }), eventId, direction, [], direction === 'incoming' ? [] : [outgoing]));
  await check(`owned neighbors: call ${direction} matches oracle`, async () => assertNeighbors(await neighbors({ node_id: callId, direction }), callId, direction, direction === 'outgoing' ? [] : [incoming], []));
}
await check('owned neighbors: default direction is both', async () => assertNeighbors(await neighbors(), eventId, 'both', [], [outgoing]));
await check('owned neighbors: invalid direction is rejected', async () => assert.rejects(() => neighbors({ direction: 'invalid' }), /Invalid direction: invalid/));
for (const verb of ['bp_trace_exec', 'bp_neighbors']) {
  const idParam = verb === 'bp_trace_exec' ? 'start_node_id' : 'node_id';
  await check(`owned errors: ${verb} unknown graph`, async () => assert.deepEqual(await query(verb, { [idParam]: eventId, graph_name: 'MissingOwnedGraph' }), { available: false, reason: 'graph_not_found', asset_path: base.asset_path, graph_name: 'MissingOwnedGraph', available_graphs: [graphName] }));
  await check(`owned errors: ${verb} unknown node`, async () => assert.deepEqual(await query(verb, { [idParam]: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' }), { available: false, reason: 'node_not_found', asset_path: base.asset_path, graph_name: graphName, [idParam]: 'FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF' }));
}
// Mutation controls exercise the same exact comparators as the positive cases.
// They modify in-memory public responses, never corpus bytes or the UE oracle.
for (const [label, mutate] of [
  ['dropped edge', row => { row.outgoing = []; row.outgoing_count = 0; }],
  ['swapped pin endpoints', row => { [row.outgoing[0].local_pin, row.outgoing[0].remote_pin] = [row.outgoing[0].remote_pin, row.outgoing[0].local_pin]; }],
  ['wrong node GUID', row => { row.outgoing[0].node_guid = eventId; }],
  ['wrong edge kind', row => { row.outgoing[0].edge_kind = 'data'; }],
  ['reversed edge direction', row => { row.incoming = row.outgoing; row.incoming_count = 1; row.outgoing = []; row.outgoing_count = 0; }],
]) {
  await check(`owned controls: rejects ${label}`, async () => {
    const actual = await neighbors();
    assertNeighbors(actual, eventId, 'both', [], [outgoing]);
    mutate(actual);
    assert.throws(() => assertNeighbors(actual, eventId, 'both', [], [outgoing]), assert.AssertionError);
  });
}
await check('owned controls: missing fixture is a hard failure', async () => {
  const prefix = 'uemcp-owned-exec-';
  const scratch = createCanonicalScratchRoot(prefix);
  try { await assert.rejects(() => verifyOwnedFixture(scratch, version), { code: 'ENOENT' }); }
  finally { cleanupCanonicalScratchRoot(scratch, prefix); }
});
process.exit(t.summary());
