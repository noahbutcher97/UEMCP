// Explicit authoring only. Normal tests never generate or update expectations.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync, realpathSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { authoringVersions, packageIdentity, sha256, verifyOwnedFixture } from './owned-serialization.mjs';
const repo = fileURLToPath(new URL('../', import.meta.url));
const assetFile = 'Content/Serialization/BP_OwnedLink.uasset';
const authorSources = ['server/fixtures/uemcp-fixture/Source/UEMCPFixture/AuthorSerializationFixtureCommandlet.cpp', 'server/fixtures/uemcp-fixture/Source/UEMCPFixture/AuthorSerializationFixtureCommandlet.h', 'plugin/UEMCP/Source/UEMCP/Private/Commandlets/EdgeOnlyBPSerializer.cpp', 'plugin/UEMCP/Source/UEMCP/Private/Commandlets/DumpBPGraphCommandlet.cpp'];
const json = bytes => JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, ''));
function safe(path) {
  let cursor = resolve(path);
  while (true) {
    if (existsSync(cursor)) {
      assert.ok(!lstatSync(cursor).isSymbolicLink(), `Symlink refused: ${cursor}`);
      assert.equal(resolve(realpathSync(cursor)).toLowerCase(), cursor.toLowerCase(), 'Path alias refused');
    }
    if (dirname(cursor) === cursor) break;
    cursor = dirname(cursor);
  }
  return resolve(path);
}
export function verifyAuthoringHost(hostRoot, engineRoot, repoRoot = repo) {
  hostRoot = safe(hostRoot);
  const outputRoot = dirname(hostRoot);
  const manifestBytes = readFileSync(safe(join(outputRoot, 'host-manifest.json')));
  const host = json(manifestBytes);
  assert.equal(host.schemaVersion, 1);
  assert.equal(host.outputRoot, outputRoot, 'Host output ownership mismatch');
  assert.equal(hostRoot, join(outputRoot, 'host'), 'Host directory ownership mismatch');
  assert.equal(host.repoRoot, resolve(repoRoot), 'Host repository ownership mismatch');
  assert.ok(host.corpus == null, 'Authoring requires source-only host; pre-staged corpus refused');
  assert.match(host.invocationId, /^[a-f0-9-]{36}$/);
  assert.match(host.source.head, /^[a-f0-9]{40}$/);
  assert.match(host.source.patchSha256, /^[a-f0-9]{64}$/);
  const allowBytes = readFileSync(join(repoRoot, 'server/fixtures/host-source-files.json'));
  assert.equal(sha256(allowBytes), host.allowlistSha256, 'Reviewed allowlist changed');
  const allow = json(allowBytes);
  assert.equal(allow.schemaVersion, 1);
  assert.deepEqual(host.files.map(f => f.source).sort(), [...allow.files].sort(), 'Manifest source membership mismatch');
  assert.equal(new Set(host.files.map(f => f.source)).size, host.files.length, 'Duplicate source');
  const expected = new Set();
  for (const f of host.files) {
    assert.ok(!f.source.includes('\\') && !f.source.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':')), 'Unsafe source path');
    const prefix = 'server/fixtures/uemcp-fixture/';
    const dest = f.source.startsWith(prefix) ? f.source.slice(prefix.length) : f.source.startsWith('plugin/UEMCP/') ? 'Plugins/UEMCP/' + f.source.slice('plugin/UEMCP/'.length) : null;
    assert.ok(dest, 'Unowned staged source');
    assert.equal(f.destination, dest, 'Destination mapping mismatch');
    assert.ok(!expected.has(dest), 'Duplicate destination');
    expected.add(dest);
    assert.equal(sha256(readFileSync(safe(join(hostRoot, dest)))), f.sha256, `Staged source changed: ${dest}`);
    assert.equal(host.source.files.find(row => row.path === f.source)?.sha256, f.sha256, 'Staged file differs from recorded checkout snapshot');
  }
  expected.add(assetFile);
  function walk(dir, prefix = '') {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const path = safe(join(dir, entry.name));
      if (entry.isDirectory()) {
        if ((prefix === '' || prefix === 'Plugins/UEMCP/') && ['Binaries', 'Intermediate', 'Saved', 'DerivedDataCache', '.vs'].includes(entry.name)) continue;
        walk(path, name + '/');
      } else {
        assert.ok(entry.isFile() && expected.delete(name), `Unexpected authored host file: ${name}`);
      }
    }
  }
  walk(hostRoot);
  assert.equal(expected.size, 0, 'Missing authored host file');
  assert.equal(safe(engineRoot), host.engine.root, 'Engine root differs from staged identity');
  const buildBytes = readFileSync(safe(join(engineRoot, 'Engine/Build/Build.version')));
  assert.equal(sha256(buildBytes), host.engine.sha256, 'Engine build changed');
  assert.deepEqual(json(buildBytes), host.engine.build);
  return { host, hostManifestSha256: sha256(manifestBytes) };
}
export async function finalizeOwnedSerialization({ version, hostRoot, oraclePath, engineRoot, outputDirectory, repoRoot = repo }) {
  assert.ok(authoringVersions.includes(version) && hostRoot && oraclePath && engineRoot, 'Explicit fixture version, owned host, oracle and engine required');
  const out = safe(outputDirectory ?? join(repoRoot, 'server/fixtures/serialization', version));
  assert.ok(!existsSync(out), `Refusing to overwrite ${out}`);
  const { host, hostManifestSha256 } = verifyAuthoringHost(hostRoot, engineRoot, repoRoot);
  // Read and validate every input before creating any output.
  const assetBytes = readFileSync(safe(join(hostRoot, assetFile)));
  const oracleBytes = readFileSync(safe(oraclePath));
  const oracle = json(oracleBytes);
  const build = host.engine.build;
  const engineVersion = `${build.MajorVersion}.${build.MinorVersion}.${build.PatchVersion}-${build.Changelist}+${build.BranchName}`;
  assert.equal(oracle.engine_version, engineVersion, 'Oracle engine differs from staged engine');
  const manifest = {
    schemaVersion: 1, id: version,
    ownership: 'Original UEMCP test graph authored from repository source; no copied content',
    rights: 'Original repository test content; no additional license grant is asserted by this manifest',
    oracleSemantics: 'independent UE reload; exact node GUID and unique pin name/direction topology',
    engineBuild: build, oracleEngineVersion: oracle.engine_version,
    provenance: { invocationId: host.invocationId, hostManifestSha256, sourceHead: host.source.head, sourceDirty: host.source.dirty, sourcePatchSha256: host.source.patchSha256, engineBuildSha256: host.engine.sha256, allowlistSha256: host.allowlistSha256 },
    savedPackage: packageIdentity(assetBytes),
    saveFlags: ['SAVE_NoError'], serialization: 'uncooked editor package; engine default versioned properties',
    dependencies: 'Engine script classes only; no content dependencies',
    sourceHashes: Object.fromEntries(authorSources.map(path => [path, host.files.find(f => f.source === path).sha256])),
    files: Object.fromEntries([[assetFile, assetBytes], ['oracle.json', oracleBytes]].map(([path, bytes]) => [path, { size: bytes.length, sha256: sha256(bytes) }])),
  };
  const scratchRoot = `${out}.authoring-${randomUUID()}`;
  mkdirSync(join(scratchRoot, 'Content/Serialization'), { recursive: true });
  try {
    writeFileSync(join(scratchRoot, assetFile), assetBytes);
    writeFileSync(join(scratchRoot, 'oracle.json'), oracleBytes);
    writeFileSync(join(scratchRoot, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
    const result = await verifyOwnedFixture(scratchRoot, version);
    renameSync(scratchRoot, out);
    return result;
  } finally {
    // Only this invocation's fresh random sibling is removed; output is retained.
    if (existsSync(scratchRoot)) rmSync(scratchRoot, { recursive: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [version, hostRoot, oraclePath, engineRoot] = process.argv.slice(2);
  finalizeOwnedSerialization({ version, hostRoot, oraclePath, engineRoot }).then(result => process.stdout.write(JSON.stringify(result, null, 2) + '\n')).catch(error => { console.error(error.stack); process.exitCode = 1; });
}
