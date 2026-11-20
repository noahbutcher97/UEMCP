import assert from 'node:assert/strict';

export async function qualifyStates({ asset, mesh, reload, call, read, verify, history, same, compile, probeValue }) {
  const machineName = 'FixtureMovement';
  const cacheName = 'MovementPose';
  const load = (path) => 'unreal.load_asset(' + JSON.stringify(path) + ')';
  async function sample(label) {
    const result = await probeValue('json.loads(unreal.AnimBlendProbe.sample_states(' + load(asset) + ', ' + load(mesh) + '))', label);
    assert.ok(result.class.includes(asset + '.ABP_Blend_C'));
    assert.ok(result.instance);
    assert.equal(result.bone, 'pelvis');
    assert.equal(result.space, 'parent-local');
    assert.equal(result.dt, 1 / 30);
    assert.equal(result.samples.length, 20);
    const close = (a, b) => Math.abs(a - b) < 0.01;
    for (const [i, row] of result.samples.entries()) {
      assert.equal(row.frame, i + 1);
      assert.equal(row.from, 'Idle');
      assert.equal(row.to, 'Moving');
      assert.equal(row.drive, i < 3 ? 0.25 : i < 5 ? 0.5 : 0.75);
      assert.ok(close(row.position[1], 3) && close(row.position[2], 7));
      if (i < 5) {
        assert.equal(row.state, 'Idle');
        assert.equal(row.transition_active, false);
        assert.ok(close(row.position[0], 10));
      }
    }
    assert.ok(result.samples.slice(5).some((row) => row.transition_active && row.position[0] > 10.01 && row.position[0] < 49.99));
    const settled = result.samples.at(-1);
    assert.equal(settled.state, 'Moving');
    assert.equal(settled.transition_active, false);
    assert.ok(close(settled.position[0], 50));
  }
  function machineFrom(state) {
    const matches = state.state_machines.filter((m) => m.name === machineName);
    assert.equal(matches.length, 1);
    return matches[0];
  }
  function verifyMachine(state) {
    const machine = machineFrom(state);
    assert.deepEqual(machine.states.map((s) => s.name).sort(), ['Idle', 'Moving']);
    assert.equal(machine.transitions.length, 1);
    const transition = machine.transitions[0];
    assert.equal(transition.previous_state, 'Idle');
    assert.equal(transition.next_state, 'Moving');
    assert.ok(Math.abs(transition.crossfade_duration - 0.2) < 0.00001);
    return transition;
  }
  function verifyCachedRoute(state, rows) {
    verifyMachine(state);
    const machineId = machineFrom(state).node_guid.replaceAll('-', '');
    const pose = rows.find((p) => p.node === machineId && p.name === 'Pose');
    const root = rows.find((p) => p.graph === 'AnimGraph' && p.class === 'AnimGraphNode_Root' && p.name === 'Result');
    const save = rows.find((p) => p.graph === 'AnimGraph' && p.class === 'AnimGraphNode_SaveCachedPose' && p.cache_name === cacheName);
    const use = rows.find((p) => p.graph === 'AnimGraph' && p.class === 'AnimGraphNode_UseCachedPose' && p.cache_name === cacheName);
    assert.ok(pose && root && save && use);
    assert.deepEqual(pose.links, [save.pin]);
    assert.deepEqual(save.links, [pose.pin]);
    assert.deepEqual(use.links, [root.pin]);
    assert.deepEqual(root.links, [use.pin]);
    assert.equal(use.cache_save_guid, save.node);
    assert.equal(use.cache_reference_valid, true);
    const reported = state.cache_nodes.find((n) => n.node_id === use.node);
    assert.equal(reported.cache_node_id, save.node);
    assert.equal(reported.reference_valid, true);
  }
  if (reload) {
    verifyCachedRoute(await read(), await verify('states-reloaded-cache-route'));
    await sample('states-reloaded-motion');
    return;
  }
  const bp = { blueprint_name: asset };
  await call('add_variable', { ...bp, variable_name: 'StateDrive', variable_type: 'Float' });
  const baseline = await verify('states-before-machine');
  const graph = async (id) => {
    const graphs = Object.values((await read()).pin_topology.graphs);
    const target = graphs.find((g) => id ? g.graph_guid === id : g.name === 'AnimGraph');
    assert.ok(target, 'current graph ' + id);
    return { asset_path: asset, graph_guid: target.graph_guid, expected_revision: target.topology_revision };
  };
  const machineArgs = { ...await graph(), name: machineName, node_position: [-400, 280] };
  const machine = await call('add_anim_state_machine', machineArgs);
  assert.equal(machine.compiled, false);
  const placed = await verify('states-machine');
  assert.ok(placed.some((p) => p.node === machine.entry_node_id && p.graphId === machine.bound_graph_guid));
  await assert.rejects(call('add_anim_state_machine', machineArgs), /current graph topology/i);
  assert.equal(await history('undo', 'states-undo-machine'), true);
  same(await verify('states-undone-machine'), baseline);
  assert.equal(await history('redo', 'states-redo-machine'), true);
  same(await verify('states-redone-machine'), placed);
  const machineGraph = () => graph(machine.bound_graph_guid);
  const folder = asset.slice(0, asset.lastIndexOf('/'));
  const stateArgs = async (name, sequence, initial, x) => ({
    ...await machineGraph(), name, sequence_path: folder + '/' + sequence, initial, node_position: [x, 0],
  });
  const idle = await call('add_anim_state', await stateArgs('Idle', 'PoseA', true, 0));
  const oneState = await verify('states-idle');
  const entry = oneState.find((p) => p.node === machine.entry_node_id);
  assert.ok(entry && entry.links.length === 1 && oneState.some((p) => p.node === idle.node_id && p.pin === entry.links[0]));
  await assert.rejects(call('add_anim_state', await stateArgs('Other', 'PoseB', true, 300)), /available machine entry/i);
  await assert.rejects(call('add_anim_state', await stateArgs('Idle', 'PoseB', false, 300)), /already exists/i);
  await assert.rejects(call('add_anim_state', await stateArgs('Other', 'ABP_Blend', false, 300)), /target Skeleton/i);
  same(await verify('states-invalid-refused'), oneState);
  const moving = await call('add_anim_state', await stateArgs('Moving', 'PoseB', false, 320));
  const both = await verify('states-both');
  for (const [node, sequence] of [[idle, '.PoseA'], [moving, '.PoseB']]) {
    assert.ok(both.some((p) => p.graphId === node.bound_graph_guid && p.node === node.player_node_id && p.sequence.endsWith(sequence) && p.links.length === 1));
  }
  const ruleArgs = { ...await machineGraph(), from_state_id: idle.node_id, to_state_id: moving.node_id,
    variable: 'StateDrive', comparison: 'greater', threshold: 0.5, duration: 0.2, node_position: [160, -30] };
  await assert.rejects(call('add_anim_transition', { ...ruleArgs, variable: 'MissingMember' }), /float or double member/i);
  await assert.rejects(call('add_anim_transition', { ...ruleArgs, to_state_id: idle.node_id }), /distinct source and destination/i);
  same(await verify('states-invalid-rule-refused'), both);
  const transition = await call('add_anim_transition', ruleArgs);
  const withRule = await verify('states-transition');
  const rulePins = withRule.filter((p) => p.graphId === transition.rule_graph_guid);
  const drive = rulePins.find((p) => p.member === 'StateDrive' && p.name === 'StateDrive');
  const operand = rulePins.find((p) => p.class === 'K2Node_CallFunction' && p.name === 'A');
  const limit = rulePins.find((p) => p.node === operand.node && p.name === 'B');
  const comparison = rulePins.find((p) => p.node === operand.node && p.name === 'ReturnValue');
  const result = rulePins.find((p) => p.name === 'bCanEnterTransition');
  assert.deepEqual(drive.links, [operand.pin]);
  assert.deepEqual(operand.links, [drive.pin]);
  assert.deepEqual(limit.links, []);
  assert.equal(Number(limit.value), 0.5);
  assert.deepEqual(comparison.links, [result.pin]);
  assert.deepEqual(result.links, [comparison.pin]);
  const metadata = verifyMachine(await read());
  assert.equal(metadata.rule_graph, transition.bound_graph_name);
  assert.equal(metadata.rule_graph_guid, transition.rule_graph_guid);
  assert.equal(metadata.from_state_id, idle.node_id);
  assert.equal(metadata.to_state_id, moving.node_id);
  await assert.rejects(call('add_anim_transition', { ...ruleArgs, ...await machineGraph() }), /already exists/i);
  assert.equal(await history('undo', 'states-undo-transition'), true);
  same(await verify('states-undone-transition'), both);
  assert.equal(await history('redo', 'states-redo-transition'), true);
  same(await verify('states-redone-transition'), withRule);
  const root = withRule.find((p) => p.class === 'AnimGraphNode_Root' && p.graph === 'AnimGraph' && p.name === 'Result');
  const pose = withRule.find((p) => p.node === machine.node_id && p.name === 'Pose');
  assert.ok(root && pose && root.links.length === 1);
  async function connect(source, target, displaced) {
    await call('connect_nodes', { ...bp, graph_name: 'AnimGraph', source_node_id: source.node, source_pin: source.name, source_pin_id: source.pin,
      target_node_id: target.node, target_pin: target.name, target_pin_id: target.pin, expected_revision: (await graph()).expected_revision,
      ...(displaced ? { replace_source_pin_id: displaced } : {}) });
  }
  await connect(pose, root, root.links[0]);
  await compile();
  await sample('states-motion');
  const save = await call('edit_anim_cached_pose', { ...await graph(), operation: 'create_save', cache_name: cacheName, node_position: [-120, 280] });
  const use = await call('edit_anim_cached_pose', { ...await graph(), operation: 'create_use', cache_node_id: save.cache_node_id, node_position: [-120, 100] });
  const staged = await verify('states-cache-created');
  const savePin = staged.find((p) => p.node === save.cache_node_id);
  const usePin = staged.find((p) => p.node === use.node_id);
  await connect(usePin, root, pose.pin);
  await connect(pose, savePin);
  await compile();
  verifyCachedRoute(await read(), await verify('states-cache-wired'));
  await sample('states-cached-motion');
  await call('save_asset', { asset_path: asset });
  await verify('states-saved');
}
