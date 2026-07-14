// Opt-in, read-only large AnimGraph response proof.

import { executeMenhanceTool } from './menhance-tcp-tools.mjs';
import { prepareLiveSmoke } from './live-smoke-harness.mjs';
import { validateAnimGraphPinTopology } from './anim-graph-topology-validation.mjs';

const assetPath = String(process.env.UEMCP_LIVE_ANIM_BLUEPRINT || '').trim();
if (!assetPath) {
  console.log('⊘ skipped live-smoke-animation-readback: set UEMCP_LIVE_ANIM_BLUEPRINT=/Game/... to exercise get_anim_graph');
  process.exit(0);
}

const smoke = await prepareLiveSmoke({ name: 'live-smoke-animation-readback' });
if (!smoke.ready) process.exit(smoke.exitCode);

const callerTimeoutMs = smoke.cm.config.tcpTimeoutMs;
if (!Number.isFinite(callerTimeoutMs) || callerTimeoutMs <= 0) {
  throw new Error('get_anim_graph caller timeout is not a positive finite value');
}

const startedAt = performance.now();
const result = await executeMenhanceTool('get_anim_graph', {
  asset_path: assetPath,
  include_transitions: true,
  include_node_properties: true,
  include_pin_topology: true,
  include_pin_defaults: true,
}, smoke.cm);
const elapsedMs = performance.now() - startedAt;
const responseBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
const payload = result?.status === 'success' ? (result.result ?? result) : result;

if (result?.status && result.status !== 'success') {
  throw new Error('get_anim_graph returned a non-success response');
}
if (payload.asset_path !== assetPath) {
  throw new Error('get_anim_graph returned an unexpected asset_path');
}
if (!Array.isArray(payload.graphs)) {
  throw new Error('get_anim_graph did not return graphs[]');
}
if (!Array.isArray(payload.state_machines)) {
  throw new Error('get_anim_graph did not return state_machines[]');
}
if (!Array.isArray(payload.slot_nodes)) {
  throw new Error('get_anim_graph did not return slot_nodes[]');
}
if (!Array.isArray(payload.layered_blend_nodes)) {
  throw new Error('get_anim_graph did not return layered_blend_nodes[]');
}
if (!Array.isArray(payload.unsupported_runtime_fields)) {
  throw new Error('get_anim_graph did not return unsupported_runtime_fields[]');
}

const topology = validateAnimGraphPinTopology(payload.pin_topology, {
  requireComplete: true,
  requireNonEmpty: true,
  expectedIncludesPinDefaults: true,
});
if (elapsedMs >= callerTimeoutMs) {
  throw new Error('get_anim_graph exceeded the unchanged caller timeout boundary');
}

console.log(
  `PASS get_anim_graph: graph_count=${payload.graph_count} state_machine_count=${payload.state_machine_count} slot_node_count=${payload.slot_node_count} layered_blend_node_count=${payload.layered_blend_node_count} topology_graph_count=${topology.graph_count} node_count=${topology.node_count} pin_count=${topology.pin_count} edge_count=${topology.edge_count} response_bytes=${responseBytes} elapsed_ms=${elapsedMs.toFixed(1)}`,
);
