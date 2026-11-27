import { TestRunner } from './test-helpers.mjs';
import { executeMenhanceTool } from './menhance-tcp-tools.mjs';

const t = new TestRunner('PhysicsAsset editor tool contracts');
const calls = [];
const manager = { send: async (...args) => { calls.push(args); return { status: 'success' }; } };
const asset_path = '/Game/Fixtures/PA_Joint';
const base = { asset_path };
for (const [tool, args] of [
  ['get_physics_asset', base],
  ['get_physics_asset', base],
  ['set_physics_constraint_limit', { ...base, joint: 'hip', twist_limit_degrees: 35 }],
  ['add_physics_sphere_body', { ...base, bone: 'tip', radius_cm: 4 }],
  ['add_physics_constraint', { ...base, joint: 'tip_hinge', child_bone: 'tip', parent_bone: 'hip', twist_limit_degrees: 18 }],
]) {
  await executeMenhanceTool(tool, args, manager);
  const [transport, command, params, opts] = calls.at(-1);
  t.assert(transport === 'tcp-55558' && command === tool && JSON.stringify(params) === JSON.stringify(args),
    tool + ' preserves the explicit body or constraint identity');
  t.assert(opts.skipCache === true, tool + ' observes the current editor transaction state');
}
for (const [tool, args] of [
  ['get_physics_asset', { asset_path: '/Engine/Fixtures/PA_Joint' }],
  ['set_physics_constraint_limit', { ...base, joint: 'hip', twist_limit_degrees: 180 }],
  ['set_physics_constraint_limit', { ...base, joint: 'hip', twist_limit_degrees: 30, save: true }],
  ['add_physics_sphere_body', { ...base, bone: 'tip', radius_cm: 0 }],
  ['add_physics_constraint', { ...base, joint: 'tip_hinge', child_bone: 'tip', twist_limit_degrees: 18 }],
]) {
  await t.assertRejects(() => executeMenhanceTool(tool, args, manager), /./, tool + ' rejects unsupported parameters');
}
t.assert(calls.length === 5, 'invalid arguments never reach the editor');
process.exit(t.summary() === 0 ? 0 : 1);
