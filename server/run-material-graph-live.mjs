import { runMaterialLive } from './run-material-live.mjs';
import { exerciseMaterialGraphFlow } from './material-graph-live-flow.mjs';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import assert from 'node:assert/strict';

export async function runMaterialGraphLive(options) {
  const records = await runMaterialLive({ ...options, flow: exerciseMaterialGraphFlow, materialGraphAssets: true });
  assert.equal(records.length, 2);
  assert.deepEqual(records[0].graphs, records[1].graphs, 'saved graph identities/settings/edges survive restart');
  for (const phase of ['write', 'reload']) {
    const log = readFileSync(join(options.outputRoot, `live-${phase}.log`), 'utf8');
    assert.doesNotMatch(log, /Ensure condition failed:|Fatal error:|Unhandled Exception:/i, `${phase} editor log must not contain an ensure or crash`);
  }
  writeFileSync(join(options.outputRoot, 'material-graph-evidence.json'), JSON.stringify({ passed: true, editorLogsFreeOfEnsures: true, records }, null, 2));
  return records;
}
