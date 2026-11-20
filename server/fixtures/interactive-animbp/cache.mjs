import assert from 'node:assert/strict';

export async function qualifyCachedPose({ asset, mesh, reload, call, read, verify, select, history, same, compile, probeValue, getSaved }) {
  const bp = { blueprint_name: asset, graph_name: 'AnimGraph' };
  const load = (value) => 'unreal.load_asset(' + JSON.stringify(value) + ')';
  const revision = async () => Object.values((await read()).pin_topology.graphs).find((g) => g.name === 'AnimGraph').topology_revision;
  const cacheRows = (rows) => rows.filter((p) => p.cache_save_guid !== undefined);
  async function checked(label) {
    const rows = await verify(label);
    const descriptors = (await read()).cache_nodes;
    assert.equal(descriptors.length, new Set(cacheRows(rows).map((p) => p.node)).size);
    for (const row of cacheRows(rows)) {
      const descriptor = descriptors.find((d) => d.node_id === row.node);
      assert.ok(descriptor);
      assert.equal(descriptor.cache_name, row.cache_name);
      assert.equal(descriptor.cache_node_id, row.cache_save_guid);
      assert.equal(descriptor.reference_valid, row.cache_reference_valid);
    }
    return rows;
  }
  async function sample(label, x) {
    const result = await probeValue('json.loads(unreal.AnimBlendProbe.sample_cached_pose(' + load(asset) + ', ' + load(mesh) + '))', label);
    assert.equal(result.bone, 'pelvis');
    assert.equal(result.space, 'parent-local');
    assert.ok(result.class.includes(asset + '.ABP_Blend_C'));
    assert.ok(result.instance);
    assert.equal(result.ticks, 3);
    assert.equal(result.dt, 1 / 30);
    for (const [key, expected] of [['x', x], ['y', 3], ['z', 7]]) {
      assert.ok(Math.abs(result[key] - expected) < 0.01, JSON.stringify(result));
    }
  }
  if (reload) {
    const rows = await checked('cache-reloaded');
    same(rows, getSaved('cache-saved-oracle'));
    const uses = cacheRows(rows).filter((p) => p.class === 'AnimGraphNode_UseCachedPose');
    assert.equal(uses.length, 2);
    assert.ok(uses.every((p) => p.cache_name === 'RenamedFixtureCache'));
    assert.equal(new Set(uses.map((p) => p.cache_save_guid)).size, 1);
    await sample('cache-reloaded-both-users', 50);
    return;
  }
  let rows = await checked('cache-before');
  const graphId = rows.find((p) => p.graph === 'AnimGraph').graphId;
  const edit = async (operation, extra) => call('edit_anim_cached_pose', {
    asset_path: asset, graph_guid: graphId, expected_revision: await revision(), operation, ...extra,
  });
  const nodePin = (state, node, direction) => {
    const pins = state.filter((p) => p.node === node);
    assert.equal(pins.length, 1, direction);
    return pins[0];
  };
  const root = select(rows, 'AnimGraphNode_Root', 'Result');
  const a = select(rows, 'AnimGraphNode_SequencePlayer', 'Pose', (p) => p.sequence.endsWith('.PoseA'));
  const b = select(rows, 'AnimGraphNode_SequencePlayer', 'Pose', (p) => p.sequence.endsWith('.PoseB'));
  async function connect(from, to, replaced = null) {
    return call('connect_nodes', {
      ...bp, source_node_id: from.node, source_pin: from.name, source_pin_id: from.pin,
      target_node_id: to.node, target_pin: to.name, target_pin_id: to.pin,
      ...(replaced ? { expected_revision: await revision(), replace_source_pin_id: replaced.pin } : {}),
    });
  }
  const created = await edit('create_save', { cache_name: 'FixtureCache', node_position: [-400, 420] });
  assert.equal(created.compiled, false);
  assert.equal(created.saved, false);
  const saveId = created.cache_node_id;
  const savedNode = await checked('cache-save-created');
  assert.equal(await history('undo', 'cache-create-undo'), true);
  same(await checked('cache-create-undone'), rows);
  assert.equal(await history('redo', 'cache-create-redo'), true);
  same(await checked('cache-create-redone'), savedNode);
  const use1 = await edit('create_use', { cache_node_id: saveId, node_position: [-220, 0] });
  const use2 = await edit('create_use', { cache_node_id: saveId, node_position: [-220, 240] });
  rows = await checked('cache-users-created');
  const savePin = nodePin(rows, saveId, 'input');
  const one = nodePin(rows, use1.node_id, 'output');
  const two = nodePin(rows, use2.node_id, 'output');
  const beforeReject = rows;
  await assert.rejects(edit('create_use', { cache_node_id: '00000000000000000000000000000001' }), /stale|another graph/i);
  await assert.rejects(edit('create_save', { cache_name: 'fixturecache' }), /unique/i);
  await assert.rejects(connect(one, savePin), /cycle/i);
  same(await checked('cache-rejections'), beforeReject);
  await call('disconnect_pin', { ...bp, node_id: root.node, pin: root.name, direction: 'input', target_node_id: a.node, target_pin: a.name, compile: false });
  await connect(a, savePin);
  await connect(one, root);
  await compile();
  await sample('cache-user-one-pose-a', 10);
  await connect(two, root, one);
  await compile();
  await sample('cache-user-two-pose-a', 10);
  await connect(b, savePin, a);
  await compile();
  await sample('cache-user-two-pose-b', 50);
  await connect(one, root, two);
  await compile();
  await sample('cache-user-one-pose-b', 50);
  const wired = await checked('cache-before-rename');
  const oldRevision = await revision();
  await edit('rename', { cache_node_id: saveId, cache_name: 'RenamedFixtureCache' });
  const renamed = await checked('cache-renamed');
  assert.ok(cacheRows(renamed).every((p) => p.cache_name === 'RenamedFixtureCache' && p.cache_save_guid === saveId));
  await assert.rejects(call('edit_anim_cached_pose', { asset_path: asset, graph_guid: graphId, expected_revision: oldRevision,
    operation: 'rename', cache_node_id: saveId, cache_name: 'Stale' }), /current topology/i);
  assert.equal(await history('undo', 'cache-rename-undo'), true);
  same(await checked('cache-rename-undone'), wired);
  assert.equal(await history('redo', 'cache-rename-redo'), true);
  same(await checked('cache-rename-redone'), renamed);
  const setReference = async (save) => {
    const result = await probeValue('unreal.AnimBlendProbe.set_cache_reference(' + load(asset) + ', ' + JSON.stringify(one.node) + ', ' + JSON.stringify(save) + ')', save ? 'cache-reference-restored' : 'cache-reference-broken');
    assert.equal(result, true);
  };
  await setReference('');
  const broken = await checked('cache-broken-reference');
  await assert.rejects(edit('rename', { cache_node_id: saveId, cache_name: 'MustNotApply' }), /broken/i);
  same(await checked('cache-broken-rejected'), broken);
  await setReference(saveId);
  same(await checked('cache-reference-repaired'), renamed);
  // Both users are live inputs of one blend, rather than leaving a disconnected
  // second user that the compiler could prune from evaluation.
  const graph = (await read()).graphs.find((g) => g.name === 'AnimGraph');
  const blend = await call('place_anim_graph_node', { asset_path: asset, graph_guid: graphId,
    action: graph.actions[0], alpha: 0.5, node_position: [0, 120] });
  rows = await checked('cache-combined-created');
  const blendPin = (name) => select(rows, 'AnimGraphNode_TwoWayBlend', name, (p) => p.node === blend.node_id);
  await call('disconnect_pin', { ...bp, node_id: root.node, pin: root.name, direction: 'input', target_node_id: one.node, target_pin: one.name, compile: false });
  await connect(one, blendPin('A'));
  await connect(two, blendPin('B'));
  await connect(blendPin('Pose'), root);
  await compile();
  await sample('cache-both-users', 50);
  await call('save_asset', { asset_path: asset });
  await checked('cache-saved');
}
