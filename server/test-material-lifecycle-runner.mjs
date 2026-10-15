import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { runMaterialLifecycle, lifecycleCases } from './run-material-lifecycle.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const t = new TestRunner('Material lifecycle runner');
const prefix = 'uemcp-ml-';
const scratch = createCanonicalScratchRoot(prefix);
const put = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes); };
let sequence = 0;
async function exercise(fault) {
  const root = join(scratch, String(sequence++));
  const repoRoot = join(root, 'repo'), engineRoot = join(root, 'engine'), outputRoot = join(root, 'stage');
  const inputs = {
    'plugin/UEMCP/Resources/source.txt': 'fixture',
    'server/fixtures/uemcp-fixture/UEMCPFixture.uproject': '{}',
    'server/fixtures/uemcp-fixture/Config/DefaultEngine.ini': readFileSync(new URL('./fixtures/uemcp-fixture/Config/DefaultEngine.ini', import.meta.url)),
  };
  for (const [path, bytes] of Object.entries(inputs)) put(join(repoRoot, path), bytes);
  execFileSync('git', ['init', '-q', repoRoot]);
  execFileSync('git', ['-C', repoRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'fixture']);
  put(join(repoRoot, 'server/fixtures/host-source-files.json'), JSON.stringify({ schemaVersion: 1, files: Object.keys(inputs).sort() }));
  put(join(engineRoot, 'Engine/Build/Build.version'), JSON.stringify({ MajorVersion: 5, MinorVersion: 8, PatchVersion: 3, Changelist: 42 }));
  const options = { repoRoot, engineRoot, outputRoot, sourceIdentityImpl: () => ({ head: 'fixture' }) };
  const starts = [];
  const runner = { run: async (file, args, opts) => {
    starts.push({ file, args });
    const phase = args.find(arg => arg.startsWith('-Phase='))?.slice(7);
    if (!phase) return { status: 'exited', exitCode: fault === 'build' ? 1 : 0 };
    assert.equal(opts.timeoutMs, 300000);
    assert.ok(opts.env.TEMP.startsWith(outputRoot));
    const project = join(outputRoot, 'host/UEMCPFixture.uproject');
    const cases = lifecycleCases.map(row => ({ ...row, passed: true, writeVerified: true, undoAvailable: true }));
    if (fault === 'missing') cases.pop();
    if (fault === 'duplicate') cases[1] = cases[0];
    if (fault === 'undo') cases[0].undoAvailable = false;
    const report = { phase, project: fault === 'foreign' ? join(root, 'Other.uproject') : project, cases, saved: true, failures: 0 };
    const user = args.find(arg => arg.startsWith('-UserDir=')).slice(9);
    if (fault !== 'report') put(join(user, `Saved/MaterialLifecycle/${phase}.json`), JSON.stringify(report));
    for (const name of ['M_Parameters', 'MI_Parameters']) {
      if (phase === 'author' || fault === 'mutation') put(join(outputRoot, `host/Content/MaterialVerification/${name}.uasset`), phase);
    }
    return { status: fault === 'timeout' ? 'timed-out' : 'exited', exitCode: fault === 'exit' ? 1 : 0 };
  } };
  const records = await runMaterialLifecycle(options, { runner, listEditors: async () => [] });
  assert.equal(records.length, 2);
  assert.equal(starts.length, 3);
  assert.notEqual(starts[1].args.find(arg => arg.startsWith('-UserDir=')), starts[2].args.find(arg => arg.startsWith('-UserDir=')));
  assert.equal(JSON.parse(readFileSync(join(outputRoot, 'lifecycle-evidence.json'))).passed, true);
}
try {
  for (const fault of [null, 'build', 'missing', 'duplicate', 'undo', 'foreign', 'report', 'mutation', 'timeout', 'exit']) {
    const name = fault ? `lifecycle gate rejects ${fault}` : 'lifecycle gate compiles and runs isolated author and verify phases';
    try {
      if (fault) {
        const errors = { build: /build failed/, missing: /Invalid author/, duplicate: /Missing or failed/, undo: /Missing or failed/, foreign: /Invalid author/, report: /ENOENT/, mutation: /Reload changed/, timeout: /author failed/, exit: /author failed/ };
        await assert.rejects(exercise(fault), errors[fault]);
      } else await exercise(null);
      t.assert(true, name);
    } catch (error) { t.assert(false, name, error.stack); }
  }
} finally { cleanupCanonicalScratchRoot(scratch, prefix); }
process.exit(t.summary());
