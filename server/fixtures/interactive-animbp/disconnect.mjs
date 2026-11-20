import assert from 'node:assert/strict';

export async function qualifyDisconnect({ asset, reload, call, verify, read, select, history, same, compile }) {
  const before = await verify('format-argument');
  const arg = select(before, 'K2Node_FormatText', 'User');
  if (reload) {
    assert.equal(arg.category, 'wildcard');
    assert.deepEqual(arg.links, []);
    return;
  }
  assert.equal(arg.category, 'text');
  assert.equal(arg.links.length, 1);
  const source = before.find((row) => row.pin === arg.links[0]);
  const state = await read();
  const graph = Object.values(state.pin_topology.graphs).find((g) => g.graph_guid === arg.graphId);
  const params = {
    blueprint_name: asset, graph_name: graph.name,
    node_id: source.node, pin: source.name, pin_id: source.pin,
    target_node_id: arg.node, target_pin: arg.name, target_pin_id: arg.pin,
    expected_revision: graph.topology_revision,
  };
  const preview = await call('disconnect_pin', { ...params, dry_run: true });
  assert.equal(preview.links_matched, 1);
  same(await verify('after-preview'), before);
  const result = await call('disconnect_pin', params);
  assert.equal(result.links_broken, 1);
  assert.equal(result.target_pin_info.category, 'wildcard');
  const after = before.map((p) => {
    if (p.pin === arg.pin) return { ...p, category: 'wildcard', links: [] };
    if (p.pin === source.pin) return { ...p, links: p.links.filter((link) => link !== arg.pin) };
    return p;
  });
  same(await verify('disconnected'), after);
  assert.equal(await history('undo', 'undo-format-argument'), true);
  same(await verify('restored-format-argument'), before);
  assert.equal(await history('redo', 'redo-format-argument'), true);
  same(await verify('redone-format-argument'), after);
  await compile();
  await call('save_asset', { asset_path: asset });
  same(await verify('disconnect-saved'), after);
}
