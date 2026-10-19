import { lifecycleCases } from './run-material-lifecycle.mjs';

export const MATERIAL_INSTANCE = '/Game/MaterialVerification/MI_Parameters.MI_Parameters';
export const HOST_CONTROL = '/Script/UEMCPFixture.Default__VerifyMaterialLifecycleCommandlet';
export const requestedMaterialValue = type => type === 'scalar' ? .67 : type === 'vector'
  ? { R: .24, G: .46, B: .68, A: 1 } : '/Engine/EngineMaterials/T_DefaultTexture2_D.T_DefaultTexture2_D';
const identity = row => `${row.Name}|${row.Association}|${row.Index}`;
function equal(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) < 1e-6;
  if (a && b && typeof a === 'object' && typeof b === 'object') return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(key => equal(a[key], b[key]));
  return a === b;
}
export async function hostControl(call, Operation) {
  const response = await call('rc_call_function', { object_path: HOST_CONTROL, function_name: 'LiveControl', args: { Operation }, generate_transaction: false });
  const result = JSON.parse(response.ReturnValue);
  if (result.success !== true) throw new Error(`Host control rejected ${Operation}`);
  return result;
}

export async function exerciseMaterialLiveFlow({ call, phase }) {
  if (!['write', 'reload'].includes(phase)) throw new Error('Explicit live flow phase required');
  const snapshot = async () => {
    const data = await call('list_material_parameters', { asset_path: MATERIAL_INSTANCE });
    const rows = ['scalar', 'vector', 'texture'].flatMap(type => {
      if (!Array.isArray(data[type])) throw new Error('Listing mismatch: missing typed rows');
      return data[type].map(row => ({ ...row, type }));
    }).sort((a, b) => identity(a).localeCompare(identity(b)));
    if (rows.length !== 12 || new Set(rows.map(identity)).size !== 12 || rows.some(row => !row.ValueFound || typeof row.Id !== 'string' || !row.Id)) throw new Error('Listing mismatch: incomplete parameter identities or values');
    for (const c of lifecycleCases) if (!rows.some(row => row.Name === c.name && row.Association === c.association && row.Index === c.index)) throw new Error(`Listing mismatch: ${c.name}`);
    return rows;
  };
  const assertState = async expected => {
    if (!equal(await snapshot(), expected)) throw new Error('Material state mismatch: requested or unrelated parameter changed');
  };
  let expected = await snapshot();
  const cases = [];
  for (const c of lifecycleCases) {
    const type = c.name.endsWith('Scalar') ? 'scalar' : c.name.endsWith('Vector') ? 'vector' : 'texture';
    const value = requestedMaterialValue(type);
    const current = expected.find(row => row.Name === c.name && row.Association === c.association && row.Index === c.index);
    if (phase === 'reload') {
      if (!equal(current.Value, value)) throw new Error(`Reload mismatch: ${c.name}`);
    } else {
      if (equal(current.Value, value)) throw new Error(`Fixture mismatch: ${c.name} already equals requested value`);
      await hostControl(call, 'reset');
      const before = structuredClone(expected);
      const result = await call('set_material_parameter', { asset_path: MATERIAL_INSTANCE, parameter_name: c.name.toLowerCase(),
        parameter_type: type, association: c.association, index: c.index, value });
      if (result.verified !== true) throw new Error('Write was not verified');
      current.Value = value;
      await assertState(expected);
      await hostControl(call, 'undo'); await assertState(before);
      await hostControl(call, 'redo'); await assertState(expected);
    }
    cases.push({ ...c, type, passed: true });
  }
  if (phase === 'write') {
    for (const args of [
      { parameter_name: 'SharedScalar', association: 'GlobalParameter', index: -1 },
      { parameter_name: 'SharedScalar', association: 'LayerParameter', index: 99 },
    ]) {
      let rejected = false;
      try { await call('set_material_parameter', { asset_path: MATERIAL_INSTANCE, parameter_type: 'scalar', value: .9, ...args }); }
      catch (error) {
        if (!/definition.*not found/.test(error.message)) throw error;
        rejected = true;
      }
      if (!rejected) throw new Error('Invalid parameter write was not rejected');
      await assertState(expected);
    }
    await hostControl(call, 'save');
  }
  return { phase, cases, snapshot: expected };
}
