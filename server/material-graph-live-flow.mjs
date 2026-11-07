import assert from 'node:assert/strict';
import { hostControl } from './material-live-flow.mjs';

export const graphAssets = ['MF_Scale', 'MF_Nested', 'M_Consumer', 'M_Invalid'];
const path = name => `/Game/MaterialGraphVerification/${name}`;
const clean = graph => ({ ...graph, dirty: undefined, created_expression_id: undefined, saved: undefined, creation_undo_supported: undefined });

export async function exerciseMaterialGraphFlow({ call, phase }) {
  const request = call;
  // TCP tools preserve the plugin envelope; the RC host controls return raw
  // UFUNCTION results. Unwrap only an explicit native success envelope.
  call = async (name, args) => {
    const response = await request(name, args);
    return response?.status === 'success' ? response.result : response;
  };
  const read = asset_path => call('get_material_graph', { asset_path, representation: 'source' });
  const revision = async asset => (await read(asset)).revision;
  const command = async (tool, asset_path, args = {}) => call(tool, { asset_path, expected_revision: await revision(asset_path), ...args });
  const rejected = async (tool, args, code) => {
    await assert.rejects(() => call(tool, args), error => String(error).includes(code));
  };
  const undoable = async (tool, asset, args) => {
    await hostControl(call, 'reset');
    const before = clean(await read(asset));
    const result = await command(tool, asset, args);
    const after = clean(await read(asset));
    assert.notDeepEqual(after, before);
    await hostControl(call, 'undo'); assert.deepEqual(clean(await read(asset)), before);
    await hostControl(call, 'redo'); assert.deepEqual(clean(await read(asset)), after);
    return result;
  };
  const add = async (asset, kind, args = {}) => (await undoable('create_material_expression', asset, { kind, ...args })).created_expression_id;
  const connect = (asset, from, to, input_name) => undoable('connect_material_expressions', asset,
    { from_expression_id: from, output_index: 0, to_expression_id: to, input_name });
  const waitCompile = async (asset, state) => {
    const deadline = Date.now() + 120000;
    let result;
    do {
      result = await call('get_material_compile_status', { asset_path: asset });
      if (result.compile_state === state) {
        if (state === 'complete') {
          assert.equal(result.compilation_finished, true);
          assert.equal(result.shader_map_present, true);
          assert.equal(result.shader_map_complete, true);
          assert.ok(result.shader_count > 0, 'consumer must contain compiled shaders');
          assert.deepEqual(result.errors, []);
        }
        return result;
      }
      if (result.compile_state === 'error' && state !== 'error') throw new Error(JSON.stringify(result));
      await new Promise(resolve => setTimeout(resolve, 250));
    } while (Date.now() < deadline);
    throw new Error(`Compile expected ${state}: ${JSON.stringify(result)}`);
  };
  const scale = path('MF_Scale'), nested = path('MF_Nested'), material = path('M_Consumer'), invalid = path('M_Invalid');
  if (phase === 'write') {
    for (const asset_path of [scale, nested]) await call('create_material_function', { asset_path });
    for (const name of ['M_Consumer', 'M_Invalid']) await call('create_material', { name, path: '/Game/MaterialGraphVerification' });
    await rejected('create_material_function', { asset_path: scale }, 'ASSET_EXISTS');
    const input = await add(scale, 'FunctionInput', { name: 'Value' });
    await rejected('create_material_expression', { asset_path: scale, expected_revision: await revision(scale), kind: 'FunctionInput', name: 'value' }, 'DUPLICATE_NAME');
    const stale = await revision(scale);
    const multiply = await add(scale, 'Multiply', { const_b: 2 });
    await rejected('create_material_expression', { asset_path: scale, expected_revision: stale, kind: 'Constant' }, 'STALE_GRAPH');
    const output = await add(scale, 'FunctionOutput', { name: 'Result' });
    await connect(scale, input, multiply, 'a');
    await connect(scale, multiply, output, 'None');
    const beforeNegative = clean(await read(scale));
    await rejected('connect_material_expressions', { asset_path: scale, expected_revision: await revision(scale), from_expression_id: multiply, output_index: 0, to_expression_id: multiply, input_name: 'B' }, 'GRAPH_CYCLE');
    await rejected('connect_material_expressions', { asset_path: scale, expected_revision: await revision(scale), from_expression_id: input, output_index: 0, to_expression_id: multiply, input_name: 'Missing' }, 'INVALID_PIN');
    await rejected('connect_material_expressions', { asset_path: scale, expected_revision: await revision(scale), from_expression_id: input, output_index: 0, to_expression_id: multiply, input_name: 'A' }, 'INPUT_CONNECTED');
    await rejected('create_material_expression', { asset_path: scale, expected_revision: await revision(scale), kind: 'FunctionCall', function_path: scale }, 'GRAPH_CYCLE');
    assert.deepEqual(clean(await read(scale)), beforeNegative);
    await command('update_material_graph', scale);
    const nestedCall = await add(nested, 'FunctionCall', { function_path: scale });
    const nestedValue = await add(nested, 'Constant', { value: .25 });
    const nestedOutput = await add(nested, 'FunctionOutput', { name: 'Result' });
    await connect(nested, nestedValue, nestedCall, 'value');
    await connect(nested, nestedCall, nestedOutput, 'None');
    await rejected('create_material_expression', { asset_path: scale, expected_revision: await revision(scale), kind: 'FunctionCall', function_path: nested }, 'GRAPH_CYCLE');
    await command('update_material_graph', nested);
    const consumer = await add(material, 'FunctionCall', { function_path: nested });
    await undoable('connect_material_property', material, { from_expression_id: consumer, output_index: 0, property: 'EmissiveColor' });
    const bad = await add(invalid, 'FunctionCall', { function_path: scale });
    await undoable('connect_material_property', invalid, { from_expression_id: bad, output_index: 0, property: 'EmissiveColor' });
    // Open-editor refusal preserves graph and editor working-copy state.
    await hostControl(call, 'graph_open');
    await rejected('create_material_expression', { asset_path: scale, expected_revision: await revision(scale), kind: 'Constant' }, 'ASSET_EDITOR_OPEN');
    await hostControl(call, 'graph_close');
    for (const asset of [material, invalid]) await command('update_material_graph', asset);
    await waitCompile(material, 'complete');
    const failure = await waitCompile(invalid, 'error'); assert.ok(failure.errors.length > 0);
    await hostControl(call, 'reset');
    await command('create_material_expression', scale, { kind: 'Constant', value: 9 });
    assert.equal((await call('get_material_compile_status', { asset_path: material })).compile_state, 'stale');
    await command('update_material_graph', scale);
    await hostControl(call, 'undo');
    assert.equal((await call('get_material_compile_status', { asset_path: material })).compile_state, 'not_requested');
    await command('update_material_graph', material);
    await waitCompile(material, 'complete');
    await hostControl(call, 'graph_oracle');
    for (const name of graphAssets) await call('save_asset', { asset_path: path(name) });
  } else if (phase === 'reload') {
    await hostControl(call, 'graph_oracle');
    await command('update_material_graph', material);
    await waitCompile(material, 'complete');
  } else throw new Error('Unknown phase');
  const graphs = {};
  for (const name of graphAssets) graphs[name] = clean(await read(path(name)));
  return { phase, passed: true, graphs };
}
