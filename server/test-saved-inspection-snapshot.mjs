import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';
import { exportInspection, readSavedInspection } from './saved-inspection-snapshot.mjs';

const t = new TestRunner('Saved editor inspection');
const prefix = 'uemcp-saved-inspection-';
const root = createCanonicalScratchRoot(prefix);
try {
  const args = { asset_path: '/Game/Rig', kind: 'rigvm' };
  const payload = { asset_path: args.asset_path, schema_version: 1, dirty: false, saved_source_verified: true,
    engine_version: 'fixture', complete: true, issues: [], graphs: [{ path: 'RigVMModel::', nodes: [], links: [] }] };
  const inspect = async (name, input) => {
    assert.equal(name, 'get_rigvm_graph');
    assert.deepEqual(input, { asset_path: args.asset_path, verify_saved_source: true });
    return { result: payload };
  };
  const source = join(root, 'Content', 'Rig.uasset');
  await mkdir(join(root, 'Content'));
  await writeFile(source, 'original');
  const exported = await exportInspection(root, args, inspect, () => {});
  const read = await readSavedInspection(root, args);
  t.assert(exported.source_sha256 === read.source_sha256 && read.origin === 'saved_editor_snapshot' &&
    JSON.stringify(read.graphs) === JSON.stringify(payload.graphs), 'round trip retains source identity and actual graph');
  const reject = async (fn, pattern, label) => {
    await assert.rejects(fn, pattern);
    t.assert(true, label);
  };
  await reject(() => exportInspection(root, args, async () => ({ result: { ...payload, dirty: true } }), () => {}), /unsaved/i, 'dirty editor refuses export');
  await reject(() => exportInspection(root, args, async () => ({ result: { ...payload, saved_source_verified: false } }), () => {}), /verify/, 'unverified engine source refuses export');
  await reject(() => exportInspection(root, args, inspect, () => { throw Error('attachment changed'); }), /attachment changed/, 'attachment change preserves previous snapshot');
  await reject(() => exportInspection(root, args, async (...a) => { await writeFile(source, 'changed'); return inspect(...a); }, () => {}),
    /changed during export/, 'a save during capture rejects the new snapshot');
  await reject(() => readSavedInspection(root, args), /[Ss]tale/, 'same-size changed package rejects previous snapshot');
  await writeFile(source, 'original');
  t.assert((await readSavedInspection(root, args)).source_sha256 === read.source_sha256, 'failed exports retain the last complete snapshot');
  const dir = join(root, 'Saved', 'UEMCP', 'Inspections');
  const entries = await readdir(dir);
  t.assert(entries.length === 1, 'failed exports clean their private temporary files');
  const path = join(dir, entries[0]);
  const stored = JSON.parse(await readFile(path, 'utf8'));
  await writeFile(path, JSON.stringify({ ...stored, schema_version: 2 }));
  await reject(() => readSavedInspection(root, args), /unsupported/, 'unknown snapshot schema rejects');
  await writeFile(path, JSON.stringify({ ...stored, inspection: { ...stored.inspection, graphs: [] } }));
  await reject(() => readSavedInspection(root, args), /Invalid/, 'changed inspection payload rejects');
  await reject(() => readSavedInspection(root, { ...args, asset_path: '/Game/../Rig' }), /exact/, 'outside package names reject before file access');
} finally { cleanupCanonicalScratchRoot(root, prefix); }
process.exit(t.summary() === 0 ? 0 : 1);
