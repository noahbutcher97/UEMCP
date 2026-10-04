import assert from 'node:assert/strict';
import { cpSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeOfflineTool } from './offline-tools.mjs';
import { sha256, verifyOwnedFixture } from './owned-serialization.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const t = new TestRunner('Owned Blueprint discovery and inspection');
const version = 'ue5.6-owned-v1';
const root = fileURLToPath(new URL(`./fixtures/serialization/${version}/`, import.meta.url));
async function check(name, run) {
  try { await run(); t.assert(true, name); }
  catch (error) { t.assert(false, name, error.message); }
}
// Prerequisites must fail closed before any query or negative control runs.
try { await verifyOwnedFixture(root, version); }
catch (error) { t.assert(false, 'owned query: corpus prerequisite', error.message); process.exit(t.summary()); }
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const oracle = JSON.parse(readFileSync(join(root, 'oracle.json'), 'utf8').replace(/^\uFEFF/, ''));
const graphName = 'OwnedGraph';
const oracleNodes = oracle.graphs[graphName].nodes;
const eventGuid = '00000001ABCDEF1280000000FFFFFFFF';
const callGuid = '12345678000000020000000300000004';
// Public spatial GUIDs contain four little-endian words; do not use the
// production conversion helper to validate production output.
const spatialGuid = guid => Buffer.from(guid, 'hex').swap32().toString('hex');
const expected = [
  { node_name: 'OwnedPrint', class_name: oracleNodes[callGuid].class_name, node_guid: spatialGuid(callGuid), member_name: 'PrintString', target_class: '/Script/Engine.KismetSystemLibrary', node_pos_x: 300, node_pos_y: 0 },
  { node_name: 'OwnedEvent', class_name: oracleNodes[eventGuid].class_name, node_guid: spatialGuid(eventGuid), member_name: 'OwnedSignal', target_class: null, node_pos_x: 0, node_pos_y: 0 },
];
const query = (name, params = {}) => executeOfflineTool(name, { asset_path: oracle.asset_path, ...params }, root);
const find = params => query('bp_find_in_graph', { graph_name: graphName, ...params });
const identity = node => Object.fromEntries(Object.keys(expected[0]).map(key => [key, node[key]]));
function assertDiscovery(result, rows = expected, { offset = 0, limit = 100, total = rows.length } = {}) {
  assert.equal(result.asset_path, oracle.asset_path);
  assert.equal(result.graph_name, graphName);
  assert.equal(result.total_nodes_in_graph, 2);
  assert.equal(result.total_matched, total);
  assert.equal(result.offset, offset);
  assert.equal(result.limit, limit);
  assert.equal(result.truncated, offset + limit < total);
  assert.deepEqual(result.nodes.map(identity), rows);
  assert.equal(new Set(result.nodes.map(node => node.node_id)).size, rows.length);
  for (const node of result.nodes) {
    assert.ok(Number.isInteger(node.node_id) && node.node_id > 0);
    assert.equal(node.node_class, node.class_name);
    assert.equal(node.graph_name, graphName);
    assert.equal(node.macro_path, null);
  }
  // graph_type is deliberately excluded: see docs/owned-blueprint-query.md.
}
function assertInspection(result, row, guid, discoveredId) {
  assert.equal(result.asset_path, oracle.asset_path);
  assert.deepEqual(identity(result.node), row);
  assert.equal(result.node.node_id, discoveredId);
  assert.equal(result.node.outer_graph_name, graphName);
  assert.equal(result.node.macro_path, null);
  for (const field of ['pin_block', 'pin_defaults']) {
    assert.ok(result.available_fields.includes(field));
    assert.ok(!result.not_available.includes(field));
  }
  const pins = result.node.pins;
  assert.equal(new Set(pins.map(pin => pin.pin_id)).size, pins.length);
  // Exact IDs are bound to this immutable save and its independent UE oracle.
  // Sort only pin/link order; retain every name, direction and endpoint.
  const projectPin = pin => ({ name: pin.name, direction: pin.direction,
    linked_to: [...pin.linked_to].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
  assert.deepEqual(Object.fromEntries(pins.map(pin => [pin.pin_id, projectPin(pin)])),
    Object.fromEntries(Object.entries(oracleNodes[guid].pins).map(([id, pin]) => [id, projectPin(pin)])));
}
function assertLiteral(result) {
  const pins = result.node.pins.filter(pin => pin.name === 'InString');
  assert.equal(pins.length, 1);
  assert.equal(pins[0].default_value, 'UEMCP owned serialization fixture');
}

await check('owned query: exact graph discovery excluding graph classification', async () => {
  const result = await query('bp_list_graphs');
  assert.equal(result.asset_path, oracle.asset_path);
  assert.equal(result.graph_count, 1);
  assert.deepEqual(result.graphs.map(({ name, node_count, comment_count, comment_ids }) => ({ name, node_count, comment_count, comment_ids })),
    [{ name: graphName, node_count: 2, comment_count: 0, comment_ids: [] }]);
});
await check('owned query: exact node discovery', async () => assertDiscovery(await find()));
for (const [label, params, rows] of [
  ['call class', { node_class: 'K2Node_CallFunction' }, [expected[0]]],
  ['event class', { node_class: 'K2Node_CustomEvent' }, [expected[1]]],
  ['call member', { member_name: 'PrintString' }, [expected[0]]],
  ['event member', { member_name: 'OwnedSignal' }, [expected[1]]],
  ['target path', { target_class: '/Script/Engine.KismetSystemLibrary' }, [expected[0]]],
  ['target suffix', { target_class: 'KismetSystemLibrary' }, [expected[0]]],
  ['combined filters', { node_class: 'K2Node_CallFunction', member_name: 'PrintString', target_class: 'KismetSystemLibrary' }, [expected[0]]],
  ['conflicting filters', { node_class: 'K2Node_CustomEvent', member_name: 'PrintString' }, []],
  ['unknown class', { node_class: 'MissingOwnedClass' }, []],
  ['unknown member', { member_name: 'MissingOwnedMember' }, []],
  ['unknown target', { target_class: 'MissingOwnedTarget' }, []],
  ['case-sensitive member', { member_name: 'printstring' }, []],
]) await check(`owned query: ${label}`, async () => assertDiscovery(await find(params), rows));
for (const [offset, rows] of [[0, [expected[0]]], [1, [expected[1]]], [2, []]]) {
  await check(`owned query: page offset ${offset}`, async () => assertDiscovery(await find({ offset, limit: 1 }), rows, { offset, limit: 1, total: 2 }));
}
await check('owned query: filtering precedes pagination', async () => assertDiscovery(
  await find({ node_class: 'K2Node_CustomEvent', offset: 0, limit: 1 }), [expected[1]], { limit: 1, total: 1 }));
await check('owned query: exact entry point discovery', async () => {
  const result = await query('bp_list_entry_points');
  assert.equal(result.asset_path, oracle.asset_path);
  assert.equal(result.entry_point_count, 1);
  assert.deepEqual(result.entry_points.map(identity), [expected[1]]);
  const entry = result.entry_points[0];
  assert.equal(entry.graph_name, graphName);
  assert.equal(entry.node_class, expected[1].class_name);
  assert.equal(entry.has_no_exec_in, true);
  assert.ok(result.available_fields.includes('exec_connectivity'));
  const found = await find({ node_class: 'K2Node_CustomEvent' });
  assertDiscovery(found, [expected[1]]);
  assert.equal(entry.node_id, found.nodes[0].node_id);
  assertInspection(await query('bp_show_node', { node_id: entry.node_id }), expected[1], eventGuid, entry.node_id);
});
for (const [index, guid] of [[0, callGuid], [1, eventGuid]]) {
  for (const mode of ['name', 'discovered ID']) {
    await check(`owned query: inspect ${expected[index].node_name} by ${mode}`, async () => {
      const found = await find();
      assertDiscovery(found);
      const id = found.nodes[index].node_id;
      assertInspection(await query('bp_show_node', { node_id: mode === 'name' ? expected[index].node_name : id }), expected[index], guid, id);
    });
  }
}
const sourcePath = 'server/fixtures/uemcp-fixture/Source/UEMCPFixture/AuthorSerializationFixtureCommandlet.cpp';
function assertAuthoringSource(source) {
  // Git may convert this text source to CRLF on Windows. The manifest retains
  // the original LF authoring-byte hash; only checkout newline equivalence is
  // accepted here. Immutable package/oracle hashes remain byte-exact.
  const normalized = source.toString('utf8').replace(/\r\n/g, '\n');
  assert.equal(sha256(normalized), manifest.sourceHashes[sourcePath], 'authoring source must match recorded provenance after checkout newline normalization');
  assert.ok(normalized.includes('Call->FindPinChecked(TEXT("InString"))->DefaultValue = TEXT("UEMCP owned serialization fixture");'));
}
await check('owned query: source-bound authored literal', async () => {
  assertAuthoringSource(readFileSync(new URL(`../${sourcePath}`, import.meta.url)));
  assertLiteral(await query('bp_show_node', { node_id: 'OwnedPrint' }));
});
await check('owned query: authoring source accepts LF and CRLF checkouts', () => {
  const source = readFileSync(new URL(`../${sourcePath}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assertAuthoringSource(source);
  assertAuthoringSource(source.replace(/\n/g, '\r\n'));
});
await check('owned query controls: rejects edited authoring source', () => {
  const source = readFileSync(new URL(`../${sourcePath}`, import.meta.url), 'utf8');
  assertAuthoringSource(source);
  assert.throws(() => assertAuthoringSource(source.replace('UEMCP owned serialization fixture', 'Changed authored literal')), assert.AssertionError);
});
await check('owned query: unknown graph rejected', async () => assert.rejects(() => find({ graph_name: 'MissingOwnedGraph' }), /Graph not found: MissingOwnedGraph/));
await check('owned query: unknown node rejected', async () => assert.rejects(() => query('bp_show_node', { node_id: 'MissingOwnedNode' }), /Node not found: MissingOwnedNode/));

// Every mutation first passes its positive comparator; a broken baseline cannot
// make a negative control green. Only response clones and scratch copies change.
for (const [label, mutate] of [
  ['dropped discovery node', row => { row.nodes.pop(); }],
  ['wrong discovery GUID', row => { row.nodes[0].node_guid = spatialGuid(eventGuid); }],
  ['wrong pagination total', row => { row.total_matched++; }],
]) await check(`owned query controls: rejects ${label}`, async () => {
  const result = await find();
  assertDiscovery(result);
  const changed = structuredClone(result);
  mutate(changed);
  assert.throws(() => assertDiscovery(changed), assert.AssertionError);
});
for (const [label, mutate] of [
  ['dropped pin', node => { node.pins.pop(); }],
  ['renamed pin', node => { node.pins[0].name = 'WrongOwnedPin'; }],
  ['reversed pin direction', node => { node.pins[0].direction = 'EGPD_Output'; }],
  ['dropped link', node => { node.pins[0].linked_to = []; }],
  ['wrong linked node', node => { node.pins[0].linked_to[0].node_guid = callGuid; }],
  ['wrong linked pin', node => { node.pins[0].linked_to[0].pin_id = node.pins[0].pin_id; }],
]) await check(`owned query controls: rejects ${label}`, async () => {
  const found = await find();
  assertDiscovery(found);
  const result = await query('bp_show_node', { node_id: found.nodes[0].node_id });
  assertInspection(result, expected[0], callGuid, found.nodes[0].node_id);
  const changed = structuredClone(result);
  mutate(changed.node);
  assert.throws(() => assertInspection(changed, expected[0], callGuid, found.nodes[0].node_id), assert.AssertionError);
});
await check('owned query controls: rejects changed literal', async () => {
  const result = await query('bp_show_node', { node_id: 'OwnedPrint' });
  assertLiteral(result);
  const changed = structuredClone(result);
  changed.node.pins.find(pin => pin.name === 'InString').default_value = 'Hello';
  assert.throws(() => assertLiteral(changed), assert.AssertionError);
});
for (const mutation of ['missing corpus', 'changed oracle hash', 'changed provenance']) {
  await check(`owned query controls: rejects ${mutation}`, async () => {
    await verifyOwnedFixture(root, version);
    const prefix = 'uemcp-owned-query-';
    const scratch = createCanonicalScratchRoot(prefix);
    try {
      if (mutation !== 'missing corpus') {
        cpSync(root, scratch, { recursive: true });
        await verifyOwnedFixture(scratch, version);
        if (mutation === 'changed oracle hash') writeFileSync(join(scratch, 'oracle.json'), readFileSync(join(scratch, 'oracle.json'), 'utf8') + ' ');
        else {
          const changed = structuredClone(manifest);
          changed.ownership = 'Unverified replacement';
          writeFileSync(join(scratch, 'manifest.json'), JSON.stringify(changed));
        }
      }
      await assert.rejects(() => verifyOwnedFixture(scratch, version), mutation === 'missing corpus' ? { code: 'ENOENT' } : assert.AssertionError);
    } finally { cleanupCanonicalScratchRoot(scratch, prefix); }
  });
}
process.exit(t.summary());
