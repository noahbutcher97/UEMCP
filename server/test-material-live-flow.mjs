import assert from 'node:assert/strict';
import { exerciseMaterialLiveFlow } from './material-live-flow.mjs';
import { lifecycleCases } from './run-material-lifecycle.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Material live flow');
const clone = value => structuredClone(value);
async function run(fault) {
  const rows = lifecycleCases.map(row => ({ Name: row.name, Association: row.association, Index: row.index,
    Id: 'fixture-guid', ValueFound: true, Value: row.name.endsWith('Scalar') ? 0.38 : row.name.endsWith('Vector') ? { R: .31, G: .42, B: .53, A: 1 } : '/Engine/EngineResources/WhiteSquareTexture.WhiteSquareTexture' }));
  for (const row of rows.filter(row => row.Association === 'LayerParameter')) rows.push({ ...clone(row), Index: 0 });
  let previous, next, writes = 0, undos = 0, redos = 0;
  const listing = () => Object.fromEntries(['scalar', 'vector', 'texture'].map(type => [type, clone(rows.filter(r => r.Name.endsWith(type[0].toUpperCase() + type.slice(1))))]));
  const call = async (tool, args) => {
    if (tool === 'list_material_parameters') return listing();
    if (tool === 'set_material_parameter') {
      const row = rows.find(r => r.Name.toLowerCase() === args.parameter_name.toLowerCase() && r.Association === args.association && r.Index === args.index);
      if (!row) { if (fault === 'transport-rejection') throw new Error('Connection reset'); if (fault === 'accepted-invalid') return { verified: true }; throw new Error('parameter definition not found'); }
      previous = clone(rows); writes++;
      if (fault !== 'no-write') row.Value = clone(args.value);
      if (fault === 'neighbor') rows.find(r => r.Name === 'SharedScalar' && r.Index === 0).Value = 9;
      next = clone(rows);
      return { verified: true };
    }
    assert.equal(tool, 'rc_call_function');
    const op = args.args.Operation;
    if (op === 'undo') { undos++; if (fault !== 'no-undo') rows.splice(0, rows.length, ...clone(previous)); }
    if (op === 'redo') { redos++; if (fault !== 'no-redo') rows.splice(0, rows.length, ...clone(next)); }
    return { ReturnValue: JSON.stringify({ success: true }) };
  };
  await exerciseMaterialLiveFlow({ call, phase: 'write' });
  assert.equal(writes, 9); assert.ok(undos >= 9); assert.ok(redos >= 9);
}
for (const fault of [null, 'no-write', 'no-undo', 'no-redo', 'neighbor', 'accepted-invalid', 'transport-rejection']) {
  try {
    if (fault) await assert.rejects(run(fault), /mismatch|rejected|changed|verified|Connection reset/i); else await run(null);
    t.assert(true, fault ? `live flow rejects ${fault}` : 'live flow verifies writes Undo Redo and rejected mutations');
  } catch (error) { t.assert(false, fault ?? 'live flow baseline', error.stack); }
}
process.exit(t.summary());
