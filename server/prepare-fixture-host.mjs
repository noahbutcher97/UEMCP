#!/usr/bin/env node
// Source-only, invocation-owned host staging. Build/runtime tools own generated output.
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = 'server/fixtures/uemcp-fixture';
const PLUGIN = 'plugin/UEMCP';
const ALLOWLIST = 'server/fixtures/host-source-files.json';
const GENERATED = new Set(['Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', '.vs']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

// Shared with explicit author/export commands. Source-verified for UE 5.3/5.6;
// the canonical host config defines the isolated graph and safe fallback roots.
export const ownedHostEngineArgs = Object.freeze([
  '-nowrite', '-ddc=UEMCPOwnedDDC', '-NoDDCCleanup',
  '-ini:Engine:[Zen]:AutoLaunch=False,[Zen.ConnectExisting]:HostName=127.0.0.1,[Zen.ConnectExisting]:Port=0',
]);

// Creates only invocation-owned scratch paths. This is launch policy, not proof
// of an OS sandbox: Windows known-folder APIs do not obey UserDir/TEMP.
export function prepareOwnedHostRuntime({ outputRoot, env = process.env }) {
  outputRoot = safePath(outputRoot);
  const manifest = json(safePath(join(outputRoot, 'host-manifest.json')));
  if (manifest.outputRoot !== outputRoot || !manifest.invocationId) throw new Error('Host ownership mismatch');
  const hostRoot = safePath(join(outputRoot, 'host'));
  const ddcRoot = safePath(join(hostRoot, 'DerivedDataCache'));
  if (process.platform === 'win32' && ddcRoot.length >= 119) throw new Error('Owned DDC path exceeds conservative UE Windows path limit; use a shorter stage root');
  const runtimeRoot = safePath(join(hostRoot, 'Saved', `runtime-${randomUUID()}`));
  const paths = Object.fromEntries(['User', 'Shaders', 'Temp'].map(name => [name, join(runtimeRoot, name)]));
  for (const path of [ddcRoot, ...Object.values(paths)]) mkdirSync(path, { recursive: true });
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) if (['TEMP', 'TMP'].includes(key.toUpperCase())) delete childEnv[key];
  childEnv.TEMP = paths.Temp;
  childEnv.TMP = paths.Temp;
  const args = [...ownedHostEngineArgs, `-UserDir=${paths.User}`, `-ShaderWorkingDir=${paths.Shaders}`];
  const record = { invocationId: manifest.invocationId, runtimeRoot, ddcRoot, args, environmentOverrides: { TEMP: paths.Temp, TMP: paths.Temp }, isolationStatus: 'source-reviewed; runtime validation required; not an OS sandbox' };
  writeFileSync(join(runtimeRoot, 'isolation.json'), JSON.stringify(record, null, 2), { flag: 'wx' });
  return { ...record, env: childEnv };
}

function safePath(path) {
  const absolute = resolve(path);
  let cursor = absolute;
  while (true) {
    if (existsSync(cursor) || (() => { try { lstatSync(cursor); return true; } catch { return false; } })()) {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error(`Symlink/reparse path refused: ${cursor}`);
      if (resolve(realpathSync(cursor)).toLowerCase() !== cursor.toLowerCase()) throw new Error(`Path alias refused: ${cursor}`);
    }
    const parent = dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  return absolute;
}

function walk(root, { generated = false } = {}) {
  safePath(root);
  const files = [];
  function visit(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const path = join(dir, entry.name);
      safePath(path);
      if (entry.isDirectory()) {
        if (generated && GENERATED.has(entry.name) && (prefix === '' || prefix === 'Plugins/UEMCP/')) continue;
        visit(path, name + '/');
      } else if (entry.isFile()) files.push(name);
      else throw new Error(`Nonregular staging input: ${path}`);
    }
  }
  visit(root);
  return files.sort();
}

function expectedFiles(repoRoot) {
  safePath(join(repoRoot, ALLOWLIST));
  const allow = json(join(repoRoot, ALLOWLIST));
  if (allow.schemaVersion !== 1 || !Array.isArray(allow.files)) throw new Error('Invalid host allowlist');
  const seen = new Set();
  for (const name of allow.files) {
    if (typeof name !== 'string' || name.includes('\\') || name.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':')) || !(name.startsWith(HOST + '/') || name.startsWith(PLUGIN + '/'))) throw new Error(`Invalid allowed path: ${name}`);
    if (seen.has(name.toLowerCase())) throw new Error(`Path collision: ${name}`);
    seen.add(name.toLowerCase());
  }
  const actual = [HOST, PLUGIN].flatMap(root => walk(join(repoRoot, root)).map(name => root + '/' + name)).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...allow.files].sort())) throw new Error('Source membership differs from reviewed host allowlist');
  return actual.map(source => ({ source, destination: source.startsWith(HOST + '/') ? source.slice(HOST.length + 1) : 'Plugins/UEMCP/' + source.slice(PLUGIN.length + 1), sha256: hash(readFileSync(join(repoRoot, source))) }));
}

function engineIdentity(engineRoot) {
  const root = safePath(engineRoot);
  const path = safePath(join(root, 'Engine/Build/Build.version'));
  const build = json(path);
  for (const key of ['MajorVersion', 'MinorVersion', 'PatchVersion', 'Changelist']) if (!Number.isSafeInteger(build[key])) throw new Error(`Invalid engine identity: ${key}`);
  return { root, build, sha256: hash(readFileSync(path)) };
}

async function sourceIdentity(repoRoot) {
  const { collectSourceState } = await import('./execution-manifest.mjs');
  return collectSourceState(repoRoot);
}

async function requestedCorpus(repoRoot, version, verifyOwnedFixtureImpl) {
  if (version === null || version === undefined) return null;
  const { fixtureVersions, verifyOwnedFixture } = await import('./owned-serialization.mjs');
  if (typeof version !== 'string' || !fixtureVersions.includes(version)) throw new Error('Unsupported owned fixture version');
  const root = `server/fixtures/serialization/${version}`;
  const directory = safePath(join(repoRoot, root));
  // The canonical verifier proves saved-package layout, ownership, hashes and
  // independent UE oracle agreement. Staging additionally locks the whole corpus.
  const before = walk(directory).map(path => ({ path, sha256: hash(readFileSync(join(directory, path))) }));
  await (verifyOwnedFixtureImpl ?? verifyOwnedFixture)(directory, version);
  const manifest = json(join(directory, 'manifest.json'));
  const paths = ['manifest.json', ...Object.keys(manifest.files)].sort();
  if (JSON.stringify(before.map(f => f.path)) !== JSON.stringify(paths)) throw new Error('Owned corpus membership mismatch');
  const provenance = manifest.provenance;
  if (!provenance || !/^[a-f0-9-]{36}$/.test(provenance.invocationId) || !/^[a-f0-9]{40}$/.test(provenance.sourceHead) || typeof provenance.sourceDirty !== 'boolean') throw new Error('Owned corpus provenance missing');
  for (const key of ['hostManifestSha256', 'sourcePatchSha256', 'engineBuildSha256', 'allowlistSha256']) if (!/^[a-f0-9]{64}$/.test(provenance[key])) throw new Error(`Owned corpus provenance invalid: ${key}`);
  const after = walk(directory).map(path => ({ path, sha256: hash(readFileSync(join(directory, path))) }));
  if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Owned corpus changed during verification');
  // One bounded first-generation asset, not an arbitrary content-copy facility.
  const destination = 'Content/Serialization/BP_OwnedLink.uasset';
  if (!manifest.files[destination]) throw new Error('Owned corpus asset missing');
  const asset = after.find(file => file.path === destination);
  return { version, files: after, stagedFiles: [{ source: `${root}/${destination}`, destination, sha256: asset.sha256 }] };
}

function combinedFiles(sourceFiles, corpus) {
  const files = [...sourceFiles, ...(corpus?.stagedFiles ?? [])];
  const destinations = new Set();
  for (const file of files) {
    if (destinations.has(file.destination.toLowerCase())) throw new Error(`Staged destination collision: ${file.destination}`);
    destinations.add(file.destination.toLowerCase());
  }
  return files;
}

export async function prepareFixtureHost({ repoRoot = ROOT, outputRoot, engineRoot, fixtureVersion, sourceIdentityImpl = sourceIdentity, verifyOwnedFixtureImpl }) {
  if (!outputRoot || !engineRoot) throw new Error('Explicit outputRoot and engineRoot required');
  repoRoot = safePath(repoRoot);
  outputRoot = safePath(outputRoot);
  const rel = relative(repoRoot, outputRoot);
  if (!rel || (!rel.startsWith('..' + sep) && rel !== '..' && !rel.includes(':'))) throw new Error('Output must be outside source checkout');
  if (existsSync(outputRoot)) throw new Error('Output root must be fresh and absent');
  const corpus = await requestedCorpus(repoRoot, fixtureVersion, verifyOwnedFixtureImpl);
  const files = combinedFiles(expectedFiles(repoRoot), corpus);
  const engine = engineIdentity(engineRoot);
  const source = await sourceIdentityImpl(repoRoot);
  mkdirSync(outputRoot); // Deliberately no recursive creation of unowned parents.
  const manifest = { schemaVersion: 1, invocationId: randomUUID(), repoRoot, outputRoot, engine, source, corpus, files, allowlistSha256: hash(readFileSync(join(repoRoot, ALLOWLIST))), createdAt: new Date().toISOString() };
  writeFileSync(join(outputRoot, 'host-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  for (const file of files) {
    const destination = join(outputRoot, 'host', file.destination);
    mkdirSync(dirname(destination), { recursive: true });
    const bytes = readFileSync(safePath(join(repoRoot, file.source)));
    if (hash(bytes) !== file.sha256) throw new Error(`Source changed while staging: ${file.source}`);
    writeFileSync(destination, bytes, { flag: 'wx' });
  }
  await validateFixtureHost({ repoRoot, outputRoot, sourceIdentityImpl, verifyOwnedFixtureImpl });
  return { manifestPath: join(outputRoot, 'host-manifest.json'), uprojectPath: join(outputRoot, 'host/UEMCPFixture.uproject'), manifest };
}

export async function validateFixtureHost({ repoRoot = ROOT, outputRoot, fixtureVersion, sourceIdentityImpl = sourceIdentity, verifyOwnedFixtureImpl }) {
  outputRoot = safePath(outputRoot);
  const manifest = json(safePath(join(outputRoot, 'host-manifest.json')));
  if (manifest.schemaVersion !== 1 || manifest.outputRoot !== outputRoot || manifest.repoRoot !== resolve(repoRoot) || !manifest.invocationId) throw new Error('Host ownership mismatch');
  if (hash(readFileSync(join(repoRoot, ALLOWLIST))) !== manifest.allowlistSha256) throw new Error('Host allowlist changed');
  if (fixtureVersion !== undefined && fixtureVersion !== manifest.corpus?.version) throw new Error('Requested fixture version differs from stage');
  const corpus = await requestedCorpus(repoRoot, manifest.corpus?.version, verifyOwnedFixtureImpl);
  if (JSON.stringify(corpus) !== JSON.stringify(manifest.corpus ?? null)) throw new Error('Owned corpus identity changed since staging');
  if (JSON.stringify(combinedFiles(expectedFiles(repoRoot), corpus)) !== JSON.stringify(manifest.files)) throw new Error('Source bytes changed since staging');
  if (JSON.stringify(await sourceIdentityImpl(repoRoot)) !== JSON.stringify(manifest.source)) throw new Error('Checkout identity changed since staging');
  if (JSON.stringify(engineIdentity(manifest.engine.root)) !== JSON.stringify(manifest.engine)) throw new Error('Engine identity changed since staging');
  const actual = walk(join(outputRoot, 'host'), { generated: true });
  const expected = manifest.files.map(f => f.destination).sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('Staged source membership mismatch');
  for (const file of manifest.files) if (hash(readFileSync(join(outputRoot, 'host', file.destination))) !== file.sha256) throw new Error(`Staged bytes changed: ${file.destination}`);
  return manifest;
}

// Delegate process ownership, timeout/tree cleanup and report evaluation to the
// existing native runner. Never remove retained staging or evidence on failure.
export async function runFixtureHostNative({ repoRoot = ROOT, outputRoot, testProfile, timeoutMs = 900000, sourceIdentityImpl = sourceIdentity, fixtureVersion, verifyOwnedFixtureImpl }, { nativeMain } = {}) {
  if (!testProfile || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('Native host requires testProfile and positive bounded timeout');
  const manifest = await validateFixtureHost({ repoRoot, outputRoot, sourceIdentityImpl, fixtureVersion, verifyOwnedFixtureImpl });
  const reportDir = join(outputRoot, `native-${randomUUID()}`);
  const runtime = prepareOwnedHostRuntime({ outputRoot });
  const { createProcessRunner } = await import('./deployment/process-runner.mjs');
  const processRunner = createProcessRunner({ defaultOutputLimitBytes: 8 * 1024 * 1024 });
  const run = nativeMain ?? (await import('./run-native-tests.mjs')).main;
  let code;
  let failure;
  try {
    code = await run(['--uproject', join(outputRoot, 'host/UEMCPFixture.uproject'), '--engine-root', manifest.engine.root,
      '--test-profile', testProfile, '--timeout-ms', String(timeoutMs), '--report-dir', reportDir,
      ...runtime.args.flatMap(arg => ['--extra-arg', arg])], {
      runner: { run: (file, args, options) => processRunner.run(file, args, { ...options, env: runtime.env }) },
    });
  } catch (error) { failure = error; }
  try { await validateFixtureHost({ repoRoot, outputRoot, sourceIdentityImpl, fixtureVersion, verifyOwnedFixtureImpl }); }
  catch (error) { failure = error; }
  writeFileSync(join(outputRoot, `lifecycle-${randomUUID()}.json`), JSON.stringify({ invocationId: manifest.invocationId, reportDir, testProfile, timeoutMs, exitCode: code ?? null, failure: failure?.message ?? null, completedAt: new Date().toISOString() }, null, 2));
  if (failure) throw failure;
  return code;
}

export async function main(argv) {
  const options = {};
  let validate = false;
  let native = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--validate') { validate = true; continue; }
    if (argv[i] === '--native') { native = true; continue; }
    const key = { '--repo-root': 'repoRoot', '--output-root': 'outputRoot', '--engine-root': 'engineRoot', '--test-profile': 'testProfile', '--timeout-ms': 'timeoutMs', '--fixture-version': 'fixtureVersion' }[argv[i]];
    if (!key || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error(`Invalid argument: ${argv[i]}`);
    if (key === 'fixtureVersion' && options.fixtureVersion !== undefined) throw new Error('Only one --fixture-version may be staged');
    options[key] = argv[++i];
  }
  if (!options.outputRoot) throw new Error('--output-root required');
  if (options.timeoutMs) options.timeoutMs = Number(options.timeoutMs);
  if (native) { process.exitCode = await runFixtureHostNative(options); return; }
  const result = validate ? await validateFixtureHost(options) : await prepareFixtureHost(options);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
