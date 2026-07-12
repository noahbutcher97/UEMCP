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
const topologyGraphs = Object.values(result.pin_topology.graphs);
if (topologyGraphs.length === 0) {
  throw new Error('get_anim_graph pin_topology.graphs is empty');
}
if (result.pin_topology.graph_count !== topologyGraphs.length) {
  throw new Error('get_anim_graph pin_topology.graph_count does not match graphs map');
}
let serializedNodeCount = 0;
let serializedPinCount = 0;
for (const graph of topologyGraphs) {
  for (const field of ['name', 'path', 'class_name', 'schema_class', 'graph_type', 'sources', 'nodes']) {
    if (!(field in graph)) throw new Error(`pin_topology graph missing ${field}`);
  }
  const nodes = Object.values(graph.nodes);
  if (graph.node_count !== nodes.length) throw new Error(`pin_topology graph ${graph.graph_key} node_count mismatch`);
  serializedNodeCount += nodes.length;
  for (const node of nodes) {
    if (!node.pins || typeof node.pins !== 'object') throw new Error(`pin_topology node ${node.node_guid} missing pins map`);
    const pins = Object.values(node.pins);
    if (node.pin_count !== pins.length) throw new Error(`pin_topology node ${node.node_guid} pin_count mismatch`);
    serializedPinCount += pins.length;
    for (const pin of pins) {
      for (const endpoint of pin.linked_to || []) {
        for (const field of ['graph_key', 'node_guid', 'pin_id']) {
          if (typeof endpoint[field] !== 'string' || !endpoint[field]) throw new Error(`pin_topology link endpoint missing ${field}`);
        }
      }
    }
  }
}
if (result.pin_topology.node_count !== serializedNodeCount || result.pin_topology.pin_count !== serializedPinCount) {
  throw new Error('get_anim_graph pin_topology aggregate count mismatch');
}
