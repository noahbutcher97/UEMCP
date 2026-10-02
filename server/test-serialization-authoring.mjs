import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { verifyAuthoringHost, finalizeOwnedSerialization } from './finalize-owned-serialization.mjs';
import { sha256 } from './owned-serialization.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';
const t = new TestRunner('Serialization authoring provenance');
const prefix = 'uemcp-authoring-provenance-';
const root = createCanonicalScratchRoot(prefix);
try {
  const repoRoot = join(root, 'repo');
  const outputRoot = join(root, 'run');
  const hostRoot = join(outputRoot, 'host');
  const engineRoot = join(root, 'engine');
  const file = { source: 'server/fixtures/uemcp-fixture/Source/Author.cpp', destination: 'Source/Author.cpp', sha256: sha256('original author') };
  const allowBytes = JSON.stringify({ schemaVersion: 1, files: [file.source] });
  const build = { MajorVersion: 5, MinorVersion: 6, PatchVersion: 1, Changelist: 44394996 };
  const buildBytes = JSON.stringify(build);
  for (const dir of [join(repoRoot, 'server/fixtures'), join(hostRoot, 'Source'), join(hostRoot, 'Content/Serialization'), join(engineRoot, 'Engine/Build')]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(repoRoot, 'server/fixtures/host-source-files.json'), allowBytes);
  writeFileSync(join(hostRoot, file.destination), 'original author');
  writeFileSync(join(hostRoot, 'Content/Serialization/BP_OwnedLink.uasset'), 'test-only placeholder, never accepted as package');
  writeFileSync(join(engineRoot, 'Engine/Build/Build.version'), buildBytes);
  const manifest = { schemaVersion: 1, invocationId: '11111111-2222-3333-4444-555555555555', repoRoot, outputRoot, source: { head: 'a'.repeat(40), patchSha256: 'b'.repeat(64), dirty: true, files: [{ path: file.source, sha256: file.sha256 }] }, engine: { root: engineRoot, build, sha256: sha256(buildBytes) }, files: [file], allowlistSha256: sha256(allowBytes) };
  const manifestPath = join(outputRoot, 'host-manifest.json');
  const save = value => writeFileSync(manifestPath, JSON.stringify(value));
  save(manifest);
  const validate = () => verifyAuthoringHost(hostRoot, engineRoot, repoRoot);
  t.assert(validate().host.source.patchSha256 === 'b'.repeat(64), 'retains original staged source identity');
  const reject = (name, action, pattern) => { let error; try { action(); } catch (e) { error = e; } t.assert(error && pattern.test(error.message), name, error?.message); };
  writeFileSync(join(hostRoot, file.destination), 'changed author');
  reject('rejects changed staged author bytes', validate, /Staged source changed/);
  writeFileSync(join(hostRoot, file.destination), 'original author');
  for (const [name, mutate, pattern] of [
    ['rejects redirected destination', m => m.files[0].destination = '../elsewhere', /Destination mapping/],
    ['rejects missing manifest membership', m => m.files = [], /membership/],
    ['rejects wrong invocation ownership', m => m.outputRoot = repoRoot, /ownership/],
    ['rejects false original snapshot hash', m => m.source.files[0].sha256 = 'c'.repeat(64), /snapshot/],
    ['rejects changed engine attestation', m => m.engine.sha256 = 'd'.repeat(64), /Engine build/],
  ]) {
    const bad = structuredClone(manifest); mutate(bad); save(bad); reject(name, validate, pattern); save(manifest);
  }
  reject('rejects different engine root', () => verifyAuthoringHost(hostRoot, repoRoot, repoRoot), /Engine root/);
  const out = join(root, 'never-created');
  let missing;
  try { await finalizeOwnedSerialization({ version: 'ue5.6-owned-v1', hostRoot, engineRoot, oraclePath: join(root, 'missing-oracle.json'), outputDirectory: out, repoRoot }); } catch (error) { missing = error; }
  t.assert(missing?.code === 'ENOENT' && !existsSync(out), 'missing oracle leaves no output directory');
  writeFileSync(join(hostRoot, 'Content/Serialization/Foreign.uasset'), 'foreign');
  reject('rejects undeclared host asset', validate, /Unexpected authored host file/);
} finally {
  cleanupCanonicalScratchRoot(root, prefix);
}
process.exit(t.summary());
