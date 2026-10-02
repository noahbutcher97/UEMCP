// Explicit author/export execution API. Importing this module never starts UE.
import { createHash, randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createProcessRunner } from './deployment/process-runner.mjs';
import { listEditorProcesses } from './editor-processes.mjs';
import { assertNoOwnedAuthoringConflicts } from './owned-authoring-conflicts.mjs';
import { prepareOwnedHostRuntime, validateFixtureHost, validateOwnedHostIsolation } from './prepare-fixture-host.mjs';

const assetName = 'Content/Serialization/BP_OwnedLink.uasset';
const digest = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function oracleStat(path) {
  try { return lstatSync(path); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function runOwnedAuthoring(options, dependencies = {}) {
  const { outputRoot, engineRoot } = options;
  if (!outputRoot || !engineRoot) throw new Error('Explicit owned stage and engine required');
  validateOwnedHostIsolation({ outputRoot, engineRoot });
  const lockRoot = join(resolve(outputRoot), '.owned-authoring.lock');
  const ownerPath = join(lockRoot, 'owner.json');
  const token = randomUUID();
  try { mkdirSync(lockRoot); }
  catch (error) { throw new Error(`Owned authoring stage lock unavailable: ${error.code}`); }
  // If recording ownership fails, retain the lock rather than guessing it is safe
  // to remove. No stale lock is ever automatically reclaimed.
  writeFileSync(ownerPath, JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx' });
  let result;
  let failure;
  try { result = await runLockedOwnedAuthoring(options, dependencies); }
  catch (error) { failure = error; }
  try {
    if (lstatSync(lockRoot).isSymbolicLink() || lstatSync(ownerPath).isSymbolicLink() || JSON.parse(readFileSync(ownerPath, 'utf8')).token !== token) throw new Error('Owned authoring lock ownership changed; retained');
    unlinkSync(ownerPath);
    rmdirSync(lockRoot);
  } catch (error) {
    if (failure) throw new AggregateError([failure, error], `${failure.message}; lock release failed: ${error.message}`);
    throw error;
  }
  if (failure) throw failure;
  return result;
}

async function runLockedOwnedAuthoring({ repoRoot, outputRoot, engineRoot, mode, timeoutMs = 300000, sourceIdentityImpl, env = process.env }, {
  runner = createProcessRunner({ defaultOutputLimitBytes: 16 * 1024 * 1024 }),
  listEditors = listEditorProcesses,
} = {}) {
  if (!outputRoot || !engineRoot || !['author', 'export'].includes(mode) || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Explicit owned stage, engine, author/export mode and positive bounded timeout required');
  outputRoot = resolve(outputRoot);
  // Historical provenance does not authorize a new launch. Verify actual staged
  // configuration and requested engine before even running process inspection.
  const manifest = validateOwnedHostIsolation({ outputRoot, engineRoot });
  if (manifest.corpus) throw new Error('Author/export requires a source-only host');
  const validation = { repoRoot, outputRoot, sourceIdentityImpl };
  await validateFixtureHost({ ...validation, ...(mode === 'export' ? { authoredAsset: 'required' } : {}) });
  const hostRoot = join(outputRoot, 'host');
  const assetPath = join(hostRoot, assetName);
  const oraclePath = join(outputRoot, 'oracle.json');
  if (oracleStat(oraclePath)) throw new Error('Refusing preexisting author/export oracle output');
  const assetBefore = mode === 'export' ? digest(assetPath) : null;
  assertNoOwnedAuthoringConflicts(await listEditors({ strict: true }), { outputRoot, repoRoot: manifest.repoRoot });
  // These two fixed -run commandlets suppress UEMCP TCP and use NullRHI. They
  // do not consume the native/live listener ports; native preflight is unchanged.
  await validateFixtureHost({ ...validation, ...(mode === 'export' ? { authoredAsset: 'required' } : {}) });
  if (mode === 'export' && digest(assetPath) !== assetBefore) throw new Error('Export asset changed during preflight');
  if (oracleStat(oraclePath)) throw new Error('Refusing preexisting author/export oracle output');
  const runtime = prepareOwnedHostRuntime({ outputRoot, engineRoot, env });
  const args = [join(hostRoot, 'UEMCPFixture.uproject'),
    ...(mode === 'author' ? ['-run=AuthorSerializationFixture'] : ['-run=DumpBPGraph', '-BP=/Game/Serialization/BP_OwnedLink', `-Out=${oraclePath}`, '-Pretty']),
    '-unattended', '-NullRHI', '-nosplash', '-nop4', '-stdout', '-FullStdOutLogOutput', ...runtime.args];
  let result;
  let processFailure;
  let validationFailure;
  try {
    result = await runner.run(join(manifest.engine.root, 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'), args, {
      cwd: hostRoot, env: runtime.env, timeoutMs, outputLimitBytes: 16 * 1024 * 1024,
    });
  } catch (error) { processFailure = error; }
  // A failed author may leave no package or a partial package. Neither permits
  // unrelated source drift to escape validation. Export may never alter its input.
  try {
    const succeeded = result?.status === 'exited' && result.exitCode === 0;
    await validateFixtureHost({ ...validation, authoredAsset: succeeded || mode === 'export' ? 'required' : 'optional' });
    validateOwnedHostIsolation({ outputRoot, engineRoot });
    if (mode === 'export' && digest(assetPath) !== assetBefore) throw new Error('Export changed its authored asset input');
    if (succeeded && mode === 'export' && !oracleStat(oraclePath)?.isFile()) throw new Error('Successful export did not produce regular oracle output');
  } catch (error) { validationFailure = error; }
  writeFileSync(join(outputRoot, `authoring-lifecycle-${randomUUID()}.json`), JSON.stringify({
    invocationId: manifest.invocationId, mode, engine: manifest.engine, args, timeoutMs,
    runtimeRoot: runtime.runtimeRoot, result: result ?? null,
    processFailure: processFailure?.message ?? null, validationFailure: validationFailure?.message ?? null,
    completedAt: new Date().toISOString(),
  }, null, 2) + '\n', { flag: 'wx' });
  if (validationFailure) throw validationFailure;
  if (processFailure) throw processFailure;
  return result;
}
