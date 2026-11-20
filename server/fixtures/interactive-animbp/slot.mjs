import assert from 'node:assert/strict';

export async function qualifyMontageSlot({
  asset, mesh, reload, call, probeValue, select, verify, read, fixture, history, same, compile, contentHashes, savedSlots,
}) {
  const load = (path) => 'unreal.load_asset(' + JSON.stringify(path) + ')';
  const clip = asset.slice(0, asset.lastIndexOf('/')) + '/PoseB';
  const skeleton = (label) => probeValue('json.loads(unreal.AnimBlendProbe.skeleton_slots(' + load(asset) + '))', label);
  const skeletonBefore = await skeleton('slot-skeleton-before');
  assert.ok(skeletonBefore.some((group) => group.slots.includes('FixtureMontage')));
  async function sample(label, expected) {
    const args = [load(asset), load(mesh), load(clip), '"FixtureMontage"'].join(', ');
    const observation = await probeValue('json.loads(unreal.AnimBlendProbe.sample_slot(' + args + '))', label);
    assert.equal(observation.bone, 'pelvis');
    assert.equal(observation.active, true);
    assert.ok(observation.class.includes(asset + '.ABP_Blend_C'));
    for (const [key, x] of [['before', 10], ['playing', expected], ['stopped', 10]]) {
      const xyz = observation[key];
      assert.equal(xyz.length, 3);
      assert.ok(xyz.every((v, i) => Math.abs(v - [x, 3, 7][i]) < 0.01), JSON.stringify(observation));
    }
  }
  if (reload) {
    assert.deepEqual(skeletonBefore, savedSlots);
    await sample('slot-reloaded-montage', 50);
    return;
  }

  const before = await verify('slot-before');
  const target = select(before, 'AnimGraphNode_Root', 'Result');
  const source = before.find((p) => p.pin === target.links[0]);
  assert.deepEqual(source.links, [target.pin]);
  const revision = async () => Object.values((await read()).pin_topology.graphs).find((g) => g.graph_guid === target.graphId).topology_revision;
  const args = {
    asset_path: asset, graph_guid: target.graphId, source_node_id: source.node, source_pin_id: source.pin,
    target_node_id: target.node, target_pin_id: target.pin, slot_name: 'fixturemontage', expected_revision: await revision(),
    node_position: [-144, 128],
  };
  const insert = (mode, extra = {}) => call('insert_anim_slot', { ...args, mode, ...extra });
  await sample('slot-unrouted-montage', 10);
  const dirtyBefore = await fixture('dirty', 'slot-dirty-before');
  const preview = await insert('preview');
  assert.equal(preview.applied, false);
  assert.equal(preview.saved, false);
  assert.equal(preview.compiled, false);
  assert.equal(preview.topology_revision, args.expected_revision);
  assert.deepEqual(preview.removed_edges, [{ source_pin_id: source.pin, target_pin_id: target.pin }]);
  assert.deepEqual(preview.planned_edges, [
    { source_pin_id: source.pin, target_pin_id: '$slot.Source' },
    { source_pin_id: '$slot.Pose', target_pin_id: target.pin },
  ]);
  await assert.rejects(insert('apply', { slot_name: 'FixtureMissingSlot' }), /already exist/i);
  await assert.rejects(insert('apply', { expected_revision: 'stale' }), /current graph/i);
  await assert.rejects(insert('apply', { graph_guid: before.find((p) => p.graph === 'EventGraph').graphId }), /top-level/i);
  await assert.rejects(insert('apply', { source_pin_id: target.pin }), /sole reciprocal/i);
  same(await verify('slot-preview-rejections'), before);
  assert.deepEqual(await fixture('dirty', 'slot-preview-dirty'), dirtyBefore);
  assert.deepEqual(await skeleton('slot-preview-skeleton'), skeletonBefore);

  // Compile a broken graph through the public insertion operation, then Undo that insertion alone.
  const fault = await fixture('compile-error', 'slot-planted-error');
  const broken = await verify('slot-broken');
  async function compileAndCheckDisk(label, revision) {
    const files = contentHashes();
    const policy = await fixture('enable-save-on-compile', label + '-policy');
    assert.match(policy, /always/i);
    try {
      const result = await insert('apply', { compile: true, expected_revision: revision });
      assert.deepEqual(contentHashes(), files, 'Slot insertion with compilation saved content under Always');
      return result;
    } finally {
      await fixture('restore-save-on-compile', label + '-original-policy');
    }
  }
  const failed = await compileAndCheckDisk('slot-failure', await revision());
  assert.equal(failed.outcome, 'applied_compile_failed');
  assert.equal(failed.applied, true);
  assert.equal(failed.saved, false);
  assert.equal(failed.compiled, false);
  assert.equal(failed.compilation.compiled_ok, false);
  assert.ok(failed.compilation.num_errors > 0 && JSON.stringify(failed.compilation.errors).includes('UEMCPMissingFixtureFunction'));
  assert.ok((await verify('slot-failed-compile')).some((p) => p.node === failed.node_id));
  assert.equal(await history('undo', 'slot-undo-failed'), true);
  same(await verify('slot-failed-undone'), broken);
  await call('delete_nodes', { blueprint_name: asset, graph_name: 'EventGraph', node_ids: [fault], compile: false });
  await compile();
  same(await verify('slot-repaired'), before);
  args.expected_revision = await revision();

  const applied = await compileAndCheckDisk('slot-success', args.expected_revision);
  assert.equal(applied.outcome, 'applied_and_compiled');
  assert.equal(applied.applied, true);
  assert.equal(applied.saved, false);
  assert.equal(applied.compiled, true);
  assert.equal(applied.compilation.compiled_ok, true);
  assert.equal(applied.compilation.num_errors, 0);
  assert.equal(applied.compilation.num_warnings, 0);
  const routed = await verify('slot-routed');
  const descriptor = (await read()).slot_nodes.find((n) => n.node_guid.replaceAll('-', '') === applied.node_id.replaceAll('-', ''));
  assert.equal(descriptor.slot_name.toLowerCase(), 'fixturemontage');
  const slotPins = routed.filter((p) => p.node === applied.node_id);
  const input = select(slotPins, 'AnimGraphNode_Slot', 'Source');
  const output = select(slotPins, 'AnimGraphNode_Slot', 'Pose');
  assert.ok(slotPins.every((p) => p.slot.toLowerCase() === 'fixturemontage' && p.x === -144 && p.y === 128));
  assert.deepEqual(input.links, [source.pin]);
  assert.deepEqual(output.links, [target.pin]);
  same(routed.filter((p) => p.node !== applied.node_id), before.map((p) => {
    if (p.pin === source.pin) return { ...p, links: [input.pin] };
    if (p.pin === target.pin) return { ...p, links: [output.pin] };
    return p;
  }));
  assert.deepEqual(applied.removed_edges, preview.removed_edges);
  assert.deepEqual(applied.added_edges, [
    { source_pin_id: source.pin, target_pin_id: input.pin }, { source_pin_id: output.pin, target_pin_id: target.pin },
  ]);
  assert.equal(applied.topology_revision, await revision());
  await assert.rejects(insert('apply'), /current graph/i);
  await sample('slot-routed-montage', 50);
  assert.equal(await history('undo', 'slot-undo'), true);
  same(await verify('slot-undone'), before);
  assert.equal(await history('redo', 'slot-redo'), true);
  same(await verify('slot-redone'), routed);
  await compile();
  await sample('slot-redone-montage', 50);
  assert.deepEqual(await skeleton('slot-skeleton-final'), skeletonBefore);
  assert.deepEqual(await fixture('dirty', 'slot-dirty-applied'), [asset]);
  await call('save_asset', { asset_path: asset });
  same(await verify('slot-saved'), routed);
}
