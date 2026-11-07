import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import yaml from 'js-yaml';
import { z } from 'zod';
import { TestRunner } from './test-helpers.mjs';
import { M5_MATERIALS_SCHEMAS, executeM5MaterialsTool, initM5MaterialsTools } from './m5-materials-tools.mjs';
import { executeMenhanceTool } from './menhance-tcp-tools.mjs';
import { getToolRequirement } from './tool-requirements.mjs';

const t = new TestRunner('Material graph contracts');
const data = yaml.load(readFileSync(new URL('../tools.yaml', import.meta.url), 'utf8'));
initM5MaterialsTools(data);
const revision = 'a'.repeat(40), id = '12345678-1234-4234-8234-123456789abc';
const inputs = {
  create_material_function: { asset_path: '/Game/Test/MF_Test' },
  create_material_expression: { asset_path: '/Game/Test/MF_Test', expected_revision: revision, kind: 'Multiply', const_b: 2 },
  connect_material_expressions: { asset_path: '/Game/Test/MF_Test', expected_revision: revision, from_expression_id: id, output_index: 0, to_expression_id: id, input_name: 'a' },
  connect_material_property: { asset_path: '/Game/Test/M_Test', expected_revision: revision, from_expression_id: id, output_index: 0, property: 'EmissiveColor' },
  update_material_graph: { asset_path: '/Game/Test/M_Test', expected_revision: revision },
  get_material_compile_status: { asset_path: '/Game/Test/M_Test' },
};
for (const [name, args] of Object.entries(inputs)) {
  try {
    const sent = [];
    await executeM5MaterialsTool(name, args, { send: async (...params) => { sent.push(params); return { ok: true }; } });
    assert.equal(sent[0][0], 'tcp-55558'); assert.equal(sent[0][1], name);
    assert.deepEqual(sent[0][2], args); assert.equal(sent[0][3].skipCache, true);
    if (name === 'update_material_graph') assert.equal(sent[0][3].timeoutMs, 30000);
    assert.equal(getToolRequirement(name, 'materials', data.toolsets.materials.tools[name]), name === 'get_material_compile_status' ? 'live_read' : 'live_mutation');
    t.assert(true, `${name} preserves typed arguments and required transport/mutation classification`);
  } catch (error) { t.assert(false, name, error.stack); }
}
for (const [name, changes] of [
  ['create_material_function', { asset_path: '/Engine/Test' }],
  ['create_material_function', { asset_path: '/Game/../Test' }],
  ['create_material_expression', { value: Infinity }],
  ['create_material_expression', { kind: 'CustomHLSL' }],
  ['create_material_expression', { expected_revision: undefined }],
  ['connect_material_expressions', { output_index: .5 }],
  ['connect_material_expressions', { input_name: '' }],
  ['connect_material_property', { property: 'Unknown' }],
]) {
  t.assert(!z.object(M5_MATERIALS_SCHEMAS[name].schema).safeParse({ ...inputs[name], ...changes }).success,
    `material graph validation rejects ${name} ${JSON.stringify(changes)}`);
}
try {
  const sent = [];
  await executeMenhanceTool('get_material_graph', { asset_path: '/Game/Test/MF_Test', representation: 'source' }, { send: async (...params) => { sent.push(params); return {}; } });
  assert.equal(sent[0][3].skipCache, true);
  t.assert(true, 'source graph bypasses cache after external Undo or another client edit');
} catch (error) { t.assert(false, 'source graph bypasses cache after external Undo or another client edit', error.stack); }
try {
  await assert.rejects(() => executeM5MaterialsTool('create_material_function', inputs.create_material_function, {
    send: async () => { const error = new Error('Destination exists'); error.code = 'ASSET_EXISTS'; throw error; },
  }), error => error.code === 'ASSET_EXISTS' && error.message.includes('[ASSET_EXISTS]'));
  t.assert(true, 'native material rejection codes survive the MCP text error boundary');
} catch (error) { t.assert(false, 'native material rejection codes survive the MCP text error boundary', error.stack); }
process.exit(t.summary());
