// Live smoke for get_anim_graph. Read-only, but still runs inside the opt-in
// live-smoke suite so the target editor/project is explicit.

import { executeMenhanceTool } from './menhance-tcp-tools.mjs';
import { createLiveSmokeCall, prepareLiveSmoke } from './live-smoke-harness.mjs';
import { validateAnimGraphPinTopology } from './anim-graph-topology-validation.mjs';

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
    pin_topology: validateAnimGraphPinTopology(result.pin_topology, {
      requireNonEmpty: true,
      expectedIncludesPinDefaults: false,
    }),
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
