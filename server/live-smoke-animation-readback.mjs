// Live smoke for get_anim_graph. Read-only, but still runs inside the opt-in
// live-smoke suite so the target editor/project is explicit.

import { executeMenhanceTool } from './menhance-tcp-tools.mjs';
import { createLiveSmokeCall, prepareLiveSmoke } from './live-smoke-harness.mjs';

const assetPath = String(process.env.UEMCP_LIVE_ANIM_BLUEPRINT || '').trim();
if (!assetPath) {
  console.log('⊘ skipped live-smoke-animation-readback: set UEMCP_LIVE_ANIM_BLUEPRINT=/Game/... to exercise get_anim_graph');
  process.exit(0);
}

const smoke = await prepareLiveSmoke({ name: 'live-smoke-animation-readback' });
if (!smoke.ready) process.exit(smoke.exitCode);

const call = createLiveSmokeCall({
  summarize: (_label, result) => ({
    asset_path: result.asset_path,
    graph_count: result.graph_count,
    state_machine_count: result.state_machine_count,
    slot_node_count: result.slot_node_count,
    layered_blend_node_count: result.layered_blend_node_count,
    pin_topology: result.pin_topology ? {
      graph_count: result.pin_topology.graph_count,
      node_count: result.pin_topology.node_count,
      pin_count: result.pin_topology.pin_count,
      link_entry_count: result.pin_topology.link_entry_count,
      edge_count: result.pin_topology.edge_count,
      complete: result.pin_topology.complete,
      truncated: result.pin_topology.truncated,
      bytes: Buffer.byteLength(JSON.stringify(result.pin_topology), 'utf8'),
    } : null,
  }),
});

const result = await call('get_anim_graph', () => executeMenhanceTool('get_anim_graph', {
  asset_path: assetPath,
  include_transitions: true,
  include_node_properties: true,
  include_pin_topology: true,
}, smoke.cm));

if (result.asset_path !== assetPath) {
  throw new Error(`get_anim_graph returned unexpected asset_path ${result.asset_path}`);
}
if (!Array.isArray(result.graphs)) {
  throw new Error('get_anim_graph did not return graphs[]');
}
if (!Array.isArray(result.state_machines)) {
  throw new Error('get_anim_graph did not return state_machines[]');
}
if (!Array.isArray(result.slot_nodes)) {
  throw new Error('get_anim_graph did not return slot_nodes[]');
}
if (!Array.isArray(result.layered_blend_nodes)) {
  throw new Error('get_anim_graph did not return layered_blend_nodes[]');
}
if (!Array.isArray(result.unsupported_runtime_fields)) {
  throw new Error('get_anim_graph did not return unsupported_runtime_fields[]');
}
if (!result.pin_topology || typeof result.pin_topology !== 'object') {
  throw new Error('get_anim_graph did not return pin_topology');
}
for (const field of ['graph_count', 'node_count', 'pin_count', 'link_entry_count', 'edge_count']) {
  if (typeof result.pin_topology[field] !== 'number') {
    throw new Error(`get_anim_graph pin_topology.${field} is not numeric`);
  }
}
if (result.pin_topology.schema_version !== 'anim-uedgraph-pin-topology-v1') {
  throw new Error(`unexpected pin_topology schema_version ${result.pin_topology.schema_version}`);
}
if (result.pin_topology.id_format !== 'digits') {
  throw new Error(`unexpected pin_topology id_format ${result.pin_topology.id_format}`);
}
if (result.pin_topology.complete !== true) {
  throw new Error(`pin_topology should report complete=true: ${JSON.stringify(result.pin_topology.dropped || {})}`);
}
if (result.pin_topology.truncated !== false) {
  throw new Error('pin_topology should report truncated=false in this slice');
}
if (!result.pin_topology.graphs || typeof result.pin_topology.graphs !== 'object') {
  throw new Error('get_anim_graph pin_topology.graphs missing');
}

const GUID_RE = /^[0-9a-f]{32}$/i;
const assertGuid = (label, value, { nullable = false } = {}) => {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || !GUID_RE.test(value)) {
    throw new Error(`${label} should be a 32-character digits GUID`);
  }
};
const endpointKey = (graphKey, nodeGuid, pinId) => JSON.stringify([graphKey, nodeGuid, pinId]);
const canonicalEdgeKey = (a, b) => a <= b ? `${a}<->${b}` : `${b}<->${a}`;

const topologyGraphEntries = Object.entries(result.pin_topology.graphs);
if (topologyGraphEntries.length === 0) {
  throw new Error('get_anim_graph pin_topology.graphs is empty');
}
if (result.pin_topology.graph_count !== topologyGraphEntries.length) {
  throw new Error('get_anim_graph pin_topology.graph_count does not match graphs map');
}
let serializedNodeCount = 0;
let serializedPinCount = 0;
let serializedLinkEntryCount = 0;
const serializedEndpointKeys = new Set();
const serializedEdges = new Set();
for (const [graphKey, graph] of topologyGraphEntries) {
  for (const field of ['graph_key', 'graph_guid', 'name', 'path', 'class_name', 'schema_class', 'graph_type', 'sources', 'nodes']) {
    if (!(field in graph)) throw new Error(`pin_topology graph missing ${field}`);
  }
  if (graphKey !== graph.graph_key) throw new Error(`pin_topology graph map key mismatch for ${graphKey}`);
  assertGuid(`pin_topology graph ${graph.graph_key} graph_guid`, graph.graph_guid, { nullable: true });
  if (!Array.isArray(graph.sources)) throw new Error(`pin_topology graph ${graph.graph_key} sources is not an array`);
  if (!graph.nodes || typeof graph.nodes !== 'object') throw new Error(`pin_topology graph ${graph.graph_key} nodes is not an object`);
  const nodeEntries = Object.entries(graph.nodes);
  if (graph.node_count !== nodeEntries.length) throw new Error(`pin_topology graph ${graph.graph_key} node_count mismatch`);
  serializedNodeCount += nodeEntries.length;
  for (const [nodeKey, node] of nodeEntries) {
    for (const field of ['graph_key', 'node_guid', 'class_name', 'title', 'x', 'y', 'pin_count', 'pins']) {
      if (!(field in node)) throw new Error(`pin_topology node ${nodeKey} missing ${field}`);
    }
    if (nodeKey !== node.node_guid) throw new Error(`pin_topology node map key mismatch for ${nodeKey}`);
    assertGuid(`pin_topology node ${node.node_guid}`, node.node_guid);
    if (node.graph_key !== graph.graph_key) throw new Error(`pin_topology node ${node.node_guid} graph_key mismatch`);
    if (typeof node.class_name !== 'string' || typeof node.title !== 'string') {
      throw new Error(`pin_topology node ${node.node_guid} identity fields should be strings`);
    }
    if (typeof node.x !== 'number' || typeof node.y !== 'number') {
      throw new Error(`pin_topology node ${node.node_guid} position fields should be numeric`);
    }
    if (!node.pins || typeof node.pins !== 'object') throw new Error(`pin_topology node ${node.node_guid} missing pins map`);
    const pinEntries = Object.entries(node.pins);
    if (node.pin_count !== pinEntries.length) throw new Error(`pin_topology node ${node.node_guid} pin_count mismatch`);
    serializedPinCount += pinEntries.length;
    for (const [pinKey, pin] of pinEntries) {
      for (const field of ['pin_id', 'name', 'direction', 'pin_category', 'pin_subcategory', 'pin_type', 'is_subpin', 'parent_pin_id', 'subpin_ids', 'linked_to']) {
        if (!(field in pin)) throw new Error(`pin_topology pin ${pinKey} missing ${field}`);
      }
      if (pinKey !== pin.pin_id) throw new Error(`pin_topology pin map key mismatch for ${pinKey}`);
      assertGuid(`pin_topology pin ${pin.pin_id}`, pin.pin_id);
      if (typeof pin.name !== 'string' || typeof pin.direction !== 'string' ||
          typeof pin.pin_category !== 'string' || typeof pin.pin_subcategory !== 'string') {
        throw new Error(`pin_topology pin ${pin.pin_id} identity fields should be strings`);
      }
      if (!pin.pin_type || typeof pin.pin_type !== 'object') throw new Error(`pin_topology pin ${pin.pin_id} missing pin_type object`);
      if (typeof pin.is_subpin !== 'boolean') throw new Error(`pin_topology pin ${pin.pin_id} is_subpin should be boolean`);
      if (!Array.isArray(pin.subpin_ids)) throw new Error(`pin_topology pin ${pin.pin_id} subpin_ids is not an array`);
      if (!Array.isArray(pin.linked_to)) throw new Error(`pin_topology pin ${pin.pin_id} linked_to is not an array`);
      if (pin.parent_pin_id !== null && !(pin.parent_pin_id in node.pins)) {
        throw new Error(`pin_topology pin ${pin.pin_id} parent_pin_id does not resolve in same node`);
      }
      for (const subpinId of pin.subpin_ids) {
        const child = node.pins[subpinId];
        if (!child) throw new Error(`pin_topology pin ${pin.pin_id} subpin ${subpinId} does not resolve`);
        if (child.parent_pin_id !== pin.pin_id) throw new Error(`pin_topology subpin ${subpinId} parent mismatch`);
      }
      const sourceEndpoint = endpointKey(graph.graph_key, node.node_guid, pin.pin_id);
      serializedEndpointKeys.add(sourceEndpoint);
      serializedLinkEntryCount += pin.linked_to.length;
      for (const endpoint of pin.linked_to) {
        for (const field of ['graph_key', 'node_guid', 'pin_id']) {
          if (typeof endpoint[field] !== 'string' || !endpoint[field]) throw new Error(`pin_topology link endpoint missing ${field}`);
        }
      }
    }
  }
}
for (const [graphKey, graph] of topologyGraphEntries) {
  for (const node of Object.values(graph.nodes)) {
    for (const pin of Object.values(node.pins)) {
      const sourceEndpoint = endpointKey(graphKey, node.node_guid, pin.pin_id);
      for (const endpoint of pin.linked_to) {
        const targetEndpoint = endpointKey(endpoint.graph_key, endpoint.node_guid, endpoint.pin_id);
        if (!serializedEndpointKeys.has(targetEndpoint)) {
          throw new Error(`pin_topology endpoint does not resolve: ${targetEndpoint}`);
        }
        serializedEdges.add(canonicalEdgeKey(sourceEndpoint, targetEndpoint));
      }
    }
  }
}
if (result.pin_topology.node_count !== serializedNodeCount || result.pin_topology.pin_count !== serializedPinCount) {
  throw new Error('get_anim_graph pin_topology aggregate count mismatch');
}
if (result.pin_topology.link_entry_count !== serializedLinkEntryCount) {
  throw new Error('get_anim_graph pin_topology link_entry_count mismatch');
}
if (result.pin_topology.edge_count !== serializedEdges.size) {
  throw new Error(`get_anim_graph pin_topology edge_count mismatch: got ${result.pin_topology.edge_count}, recomputed ${serializedEdges.size}`);
}
