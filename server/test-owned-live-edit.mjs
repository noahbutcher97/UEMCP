// Offline routing and registration evidence only; no UE state or undo claim.
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import yaml from 'js-yaml';
import { TestRunner } from './test-helpers.mjs';
import { executeBlueprintsWriteTool, initBlueprintsWriteTools } from './blueprints-write-tcp-tools.mjs';
import { loadTestProfile, collectSourceState, collectFixtureIdentity, validateExecution, sha256, REPOSITORY_ROOT } from './execution-manifest.mjs';

const t = new TestRunner('Owned live-edit offline contract');
const check = async (name, run) => {
  try { await run(); t.assert(true, name); }
  catch (error) { t.assert(false, name, error.stack); }
};
initBlueprintsWriteTools(yaml.load(readFileSync(new URL('../tools.yaml', import.meta.url), 'utf8')));
const blueprint_name = '/Game/__UEMCPTests/BP_OfflineRouting';
const nativeCases = ['LiveValuesAndErrors', 'ExternalTransactionUndoRedo', 'RejectedEditPreservesPriorUndo'].map(name => `UEMCP.OwnedComponentEdit.${name}`);
const nativeSource = 'plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPOwnedComponentEditTests.cpp';
const handlerSource = 'plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp';

for (const [label, tool, args, wire, expected] of [
  ['component vector', 'set_component_property', { blueprint_name, component_name: 'OwnedScene', property_name: 'RelativeLocation', property_value: [12, -23, 34] }, 'set_component_property'],
  ['component scalar', 'set_component_property', { blueprint_name, component_name: 'OwnedScene', property_name: 'RelativeScale3D', property_value: 2.5 }, 'set_component_property'],
  ['CDO property', 'set_blueprint_property', { blueprint_name, property_name: 'InitialLifeSpan', property_value: 4.5 }, 'set_blueprint_property'],
  ['variable default', 'set_variable_default', { blueprint_name, variable_name: 'OwnedFloat', value: 3.25 }, 'set_blueprint_variable_default', { blueprint_name, variable_name: 'OwnedFloat', value: 3.25, compile: false }],
]) {
  await check(`owned live edit: ${label} exact uncached wire routing`, async () => {
    const calls = [];
    const response = { status: 'success', result: { sentinel: label } };
    const connection = { send: async (...call) => { calls.push(call); return response; } };
    assert.strictEqual(await executeBlueprintsWriteTool(tool, args, connection), response);
    assert.strictEqual(await executeBlueprintsWriteTool(tool, args, connection), response);
    assert.deepEqual(calls, Array(2).fill(['tcp-55558', wire, expected ?? args, { skipCache: true }]));
  });
}
await check('owned live edit: invalid vector reaches native validation unchanged', async () => {
  const args = { blueprint_name, component_name: 'OwnedScene', property_name: 'RelativeLocation', property_value: [1, 2] };
  const response = { status: 'error', code: 'PROPERTY_SET_FAILED', message: 'Vector property requires 3 values, got 2' };
  let observed;
  const result = await executeBlueprintsWriteTool('set_component_property', args, { send: async (...call) => { observed = call; return response; } });
  assert.deepEqual(observed, ['tcp-55558', 'set_component_property', args, { skipCache: true }]);
  assert.strictEqual(result, response);
});
await check('owned live edit: missing required identity fails before transport', async () => {
  let calls = 0;
  for (const key of ['blueprint_name', 'component_name', 'property_name']) {
    const args = { blueprint_name, component_name: 'OwnedScene', property_name: 'RelativeLocation', property_value: [1, 2, 3] };
    delete args[key];
    await assert.rejects(() => executeBlueprintsWriteTool('set_component_property', args, { send: async () => { calls++; } }));
  }
  assert.equal(calls, 0);
});
await check('owned live edit: native errors preserve exact envelopes', async () => {
  for (const code of ['MISSING_PARAMS', 'COMPONENT_NOT_FOUND', 'PROPERTY_NOT_FOUND', 'PROPERTY_SET_FAILED']) {
    const response = { status: 'error', code, message: `native ${code}`, result: { retained: true } };
    const result = await executeBlueprintsWriteTool('set_component_property', { blueprint_name, component_name: 'OwnedScene', property_name: 'RelativeLocation', property_value: null }, { send: async () => response });
    assert.strictEqual(result, response);
  }
});
const native = loadTestProfile('native-owned-component-edit');
await check('owned live edit: native profile requires exact source registrations', () => {
  assert.equal(native.runner, 'native');
  assert.deepEqual(native.capabilities, ['engine', 'nullrhi']);
  assert.deepEqual(native.suites, [{ name: 'native', cases: nativeCases }]);
  assert.deepEqual(native.fixturePaths, [nativeSource, handlerSource]);
  const source = readFileSync(new URL(`../${nativeSource}`, import.meta.url), 'utf8');
  const registrations = [...source.matchAll(/IMPLEMENT_SIMPLE_AUTOMATION_TEST\s*\(\s*\w+\s*,\s*"(UEMCP\.OwnedComponentEdit\.[A-Za-z]+)"/g)].map(match => match[1]);
  assert.deepEqual(registrations, nativeCases);
});
// Synthetic report controls validate the evidence gate, never count as native execution.
const state = collectSourceState(REPOSITORY_ROOT);
const evidence = {
  schemaVersion: 1, profile: native.name, manifestDigest: native.manifestDigest,
  sourceState: state, fixtureIdentity: collectFixtureIdentity(REPOSITORY_ROOT, native.fixturePaths),
  suites: [{ name: 'native', state: 'passed', cases: nativeCases.map(name => ({ name, state: 'passed' })) }],
};
await check('owned live edit: synthetic exact native evidence accepted', () => assert.deepEqual(validateExecution(evidence, native, state), []));
for (const [label, mutate] of [
  ['missing', value => value.suites[0].cases.pop()],
  ['duplicate', value => { value.suites[0].cases[1] = value.suites[0].cases[0]; }],
  ['skipped', value => { value.suites[0].cases[0].state = 'skipped'; }],
  ['failed', value => { value.suites[0].cases[0].state = 'failed'; }],
  ['extra', value => value.suites[0].cases.push({ name: 'Unrelated', state: 'passed' })],
  ['wrong source', value => {
    const { digest: _digest, ...raw } = value.sourceState;
    raw.head = '0'.repeat(40);
    value.sourceState = { ...raw, digest: sha256(JSON.stringify(raw)) };
  }],
]) {
  await check(`owned live edit: synthetic ${label} native evidence rejected`, () => {
    const altered = structuredClone(evidence);
    mutate(altered);
    assert.ok(validateExecution(altered, native, state).length > 0);
  });
}
t.summary();
process.exitCode = t.failed > 0 ? 1 : 0;
