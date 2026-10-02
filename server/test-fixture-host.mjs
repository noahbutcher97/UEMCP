import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { prepareFixtureHost, validateFixtureHost, runFixtureHostNative, main, ownedHostEngineArgs, prepareOwnedHostRuntime } from './prepare-fixture-host.mjs';
import { createCanonicalScratchRoot, cleanupCanonicalScratchRoot, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('fixture host');
const scratch = createCanonicalScratchRoot('uemcp-host-stage-');
const repoRoot = join(scratch, 'repo');
const engineRoot = join(scratch, 'engine');
const host = 'server/fixtures/uemcp-fixture/UEMCPFixture.uproject';
const resource = 'plugin/UEMCP/Resources/data.bin';
const files = [host, resource].sort();
const put = (path, bytes) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, bytes); };
let sourceDigest = 'initial';
let counter = 0;
const options = () => ({ repoRoot, engineRoot, outputRoot: join(scratch, `stage-${counter++}`), sourceIdentityImpl: () => ({ digest: sourceDigest }) });
async function check(name, fn) { try { await fn(); t.assert(true, name); } catch (error) { t.assert(false, name, error.stack); } }
try {
  put(join(repoRoot, host), '{}');
  put(join(repoRoot, resource), Buffer.from([0, 13, 10, 255]));
  put(join(repoRoot, 'server/fixtures/host-source-files.json'), JSON.stringify({ schemaVersion: 1, files }));
  put(join(engineRoot, 'Engine/Build/Build.version'), JSON.stringify({ MajorVersion: 5, MinorVersion: 6, PatchVersion: 1, Changelist: 42 }));
  await check('fresh stage preserves raw bytes and validates', async () => {
    const opts = options(); const stage = await prepareFixtureHost(opts);
    assert.equal(stage.manifest.files.length, 2);
    assert.deepEqual(readFileSync(join(opts.outputRoot, 'host/Plugins/UEMCP/Resources/data.bin')), Buffer.from([0, 13, 10, 255]));
    await validateFixtureHost(opts);
    await assert.rejects(prepareFixtureHost(opts), /fresh/);
  });
  await check('unexpected source addition fails reviewed membership', async () => {
    const path = join(repoRoot, 'plugin/UEMCP/new.cpp'); put(path, 'new');
    await assert.rejects(prepareFixtureHost(options()), /membership/); unlinkSync(path);
  });
  await check('missing resource fails reviewed membership', async () => {
    unlinkSync(join(repoRoot, resource));
    await assert.rejects(prepareFixtureHost(options()), /membership/); put(join(repoRoot, resource), Buffer.from([0, 13, 10, 255]));
  });
  await check('raw binary CRLF mutation fails attestation', async () => {
    const opts = options(); await prepareFixtureHost(opts);
    put(join(opts.outputRoot, 'host/Plugins/UEMCP/Resources/data.bin'), Buffer.from([0, 10, 255]));
    await assert.rejects(validateFixtureHost(opts), /Staged bytes/);
  });
  await check('staged source addition fails exact membership', async () => {
    const opts = options(); await prepareFixtureHost(opts); put(join(opts.outputRoot, 'host/extra.cpp'), 'x');
    await assert.rejects(validateFixtureHost(opts), /membership/);
  });
  await check('source edit after staging fails', async () => {
    const opts = options(); await prepareFixtureHost(opts); put(join(repoRoot, host), '{"changed":true}');
    await assert.rejects(validateFixtureHost(opts), /Source bytes/); put(join(repoRoot, host), '{}');
  });
  await check('dirty checkout identity change fails', async () => {
    const opts = options(); await prepareFixtureHost(opts); sourceDigest = 'changed';
    await assert.rejects(validateFixtureHost(opts), /Checkout identity/); sourceDigest = 'initial';
  });
  await check('engine identity change fails', async () => {
    const opts = options(); await prepareFixtureHost(opts);
    const path = join(engineRoot, 'Engine/Build/Build.version'); const before = readFileSync(path); put(path, before.toString().replace('42', '43'));
    await assert.rejects(validateFixtureHost(opts), /Engine identity/); put(path, before);
  });
  await check('case-insensitive allowlist collisions fail', async () => {
    const path = join(repoRoot, 'server/fixtures/host-source-files.json');
    put(path, JSON.stringify({ schemaVersion: 1, files: [...files, resource.replace('data.bin', 'DATA.bin')] }));
    await assert.rejects(prepareFixtureHost(options()), /collision/); put(path, JSON.stringify({ schemaVersion: 1, files }));
  });
  await check('junction source escape fails', async () => {
    const path = join(repoRoot, 'plugin/UEMCP/escape'); symlinkSync(engineRoot, path, 'junction');
    await assert.rejects(prepareFixtureHost(options()), /Symlink|alias/); unlinkSync(path);
  });
  await check('output inside checkout is refused', async () => {
    await assert.rejects(prepareFixtureHost({ ...options(), outputRoot: join(repoRoot, 'stage') }), /outside source/);
  });
  await check('native timeout remains failure and delegates bounded lifecycle', async () => {
    const opts = options(); await prepareFixtureHost(opts);
    const code = await runFixtureHostNative({ ...opts, testProfile: 'native-smoke', timeoutMs: 123 }, { nativeMain: async argv => {
      assert.equal(argv[argv.indexOf('--timeout-ms') + 1], '123');
      assert.equal(argv[argv.indexOf('--test-profile') + 1], 'native-smoke');
      const extras = argv.filter((_, index) => argv[index - 1] === '--extra-arg');
      assert.deepEqual(extras.slice(0, ownedHostEngineArgs.length), [...ownedHostEngineArgs]);
      assert.ok(extras.some(arg => arg.startsWith('-UserDir=') && arg.includes(opts.outputRoot)));
      assert.ok(extras.some(arg => arg.startsWith('-ShaderWorkingDir=') && arg.includes(opts.outputRoot)));
      assert.equal(argv[argv.indexOf('--extra-arg') + 1], '-nowrite');
      return 3;
    } });
    assert.equal(code, 3); await validateFixtureHost(opts);
  });
  await check('owned host DDC graph and both fallbacks reach only invocation-local filesystem cache', async () => {
    const config = readFileSync(new URL('./fixtures/uemcp-fixture/Config/DefaultEngine.ini', import.meta.url), 'utf8');
    for (const section of ['UEMCPOwnedDDC', 'DerivedDataBackendGraph', 'InstalledDerivedDataBackendGraph']) {
      const body = config.split(`[${section}]`)[1]?.split(/\r?\n\[/)[0];
      assert.ok(body, section);
      assert.match(body, /Root=\(Type=Hierarchical, Inner=UEMCPOwnedLocal\)/);
      assert.match(body, /UEMCPOwnedLocal=\(Type=FileSystem, ReadOnly=false, Clean=false, Flush=false, DeleteUnused=false, Path="%GAMEDIR%DerivedDataCache"\)/);
      assert.doesNotMatch(body, /EnvPathOverride|EditorOverrideSetting|CommandLineOverride|Type=Zen|Inner=Shared|Inner=Cloud/);
    }
    assert.match(config, /\[Zen\]\r?\nAutoLaunch=false/);
    assert.match(config, /\[Zen.ConnectExisting\]\r?\nHostName=127.0.0.1\r?\nPort=0/);
    assert.ok(ownedHostEngineArgs.includes('-ddc=UEMCPOwnedDDC'));
    assert.ok(ownedHostEngineArgs.includes('-NoDDCCleanup'));
    assert.ok(ownedHostEngineArgs.includes('-ini:Engine:[Zen]:AutoLaunch=False,[Zen.ConnectExisting]:HostName=127.0.0.1,[Zen.ConnectExisting]:Port=0'));
  });
  await check('runtime scratch is fresh, owned and child environment does not mutate parent', async () => {
    const opts = options(); await prepareFixtureHost(opts);
    const env = { TEMP: 'outside', tmp: 'outside-too', OTHER: 'kept' };
    const first = prepareOwnedHostRuntime({ outputRoot: opts.outputRoot, env });
    const second = prepareOwnedHostRuntime({ outputRoot: opts.outputRoot, env });
    assert.notEqual(first.runtimeRoot, second.runtimeRoot);
    assert.ok(first.env.TEMP.startsWith(first.runtimeRoot));
    assert.equal(first.env.TEMP, first.env.TMP); assert.equal(first.env.tmp, undefined);
    assert.deepEqual(env, { TEMP: 'outside', tmp: 'outside-too', OTHER: 'kept' });
    assert.equal(first.env.OTHER, 'kept');
    await validateFixtureHost(opts);
  });
  await check('native cleanup exception remains failure with retained stage', async () => {
    const opts = options(); await prepareFixtureHost(opts);
    await assert.rejects(runFixtureHostNative({ ...opts, testProfile: 'native-smoke' }, { nativeMain: async () => { throw new Error('cleanup uncertain'); } }), /cleanup uncertain/);
    await validateFixtureHost(opts);
  });
  await check('native success cannot hide source modification', async () => {
    const opts = options(); await prepareFixtureHost(opts);
    await assert.rejects(runFixtureHostNative({ ...opts, testProfile: 'native-smoke' }, { nativeMain: async () => { sourceDigest = 'changed'; return 0; } }), /Checkout identity/);
    sourceDigest = 'initial';
  });
  const version = 'ue5.6-owned-v1';
  const corpusRoot = join(repoRoot, 'server/fixtures/serialization', version);
  const asset = 'Content/Serialization/BP_OwnedLink.uasset';
  const corpusBytes = Buffer.from([0, 13, 10, 255, 42]);
  const digest = bytes => createHash('sha256').update(bytes).digest('hex');
  const corpusManifest = {
    files: { [asset]: { size: corpusBytes.length, sha256: digest(corpusBytes) }, 'oracle.json': { size: 2, sha256: digest('{}') } },
    provenance: { invocationId: '00000000-0000-0000-0000-000000000000', sourceHead: 'a'.repeat(40), sourceDirty: true,
      hostManifestSha256: 'a'.repeat(64), sourcePatchSha256: 'b'.repeat(64), engineBuildSha256: 'c'.repeat(64), allowlistSha256: 'd'.repeat(64) },
  };
  put(join(corpusRoot, asset), corpusBytes); put(join(corpusRoot, 'oracle.json'), '{}');
  const resetManifest = () => put(join(corpusRoot, 'manifest.json'), JSON.stringify(corpusManifest));
  resetManifest();
  let verified = 0;
  const corpusOptions = () => ({ ...options(), fixtureVersion: version, verifyOwnedFixtureImpl: async (directory, requested) => {
    assert.equal(directory, corpusRoot); assert.equal(requested, version); verified++;
    const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json')));
    for (const [path, info] of Object.entries(manifest.files)) assert.equal(digest(readFileSync(join(directory, path))), info.sha256, 'corpus hash mismatch');
  } });
  await check('requested owned corpus is verified and copied as exact raw bytes', async () => {
    const opts = corpusOptions(); const result = await prepareFixtureHost(opts);
    assert.ok(verified >= 2); assert.equal(result.manifest.corpus.version, version);
    assert.equal(result.manifest.corpus.files.length, 3);
    assert.deepEqual(readFileSync(join(opts.outputRoot, 'host', asset)), corpusBytes);
    await validateFixtureHost(opts);
  });
  await check('canonical corpus verification failure prevents staging', async () => {
    await assert.rejects(prepareFixtureHost({ ...corpusOptions(), verifyOwnedFixtureImpl: async () => { throw new Error('oracle mismatch'); } }), /oracle mismatch/);
  });
  await check('unknown or multiple requested fixture versions are refused', async () => {
    await assert.rejects(prepareFixtureHost({ ...corpusOptions(), fixtureVersion: '../escape' }), /Unsupported/);
    await assert.rejects(prepareFixtureHost({ ...corpusOptions(), fixtureVersion: [version, version] }), /Unsupported/);
    await assert.rejects(main(['--fixture-version', version, '--fixture-version', version]), /Only one/);
  });
  await check('unclassified corpus additions are refused', async () => {
    const path = join(corpusRoot, 'extra.uasset'); put(path, 'unowned');
    await assert.rejects(prepareFixtureHost(corpusOptions()), /membership/); unlinkSync(path);
  });
  await check('corpus provenance is required before staging', async () => {
    put(join(corpusRoot, 'manifest.json'), JSON.stringify({ files: corpusManifest.files }));
    await assert.rejects(prepareFixtureHost(corpusOptions()), /provenance/); resetManifest();
  });
  await check('corpus asset collisions with reviewed host sources are refused', async () => {
    const path = join(repoRoot, 'server/fixtures/uemcp-fixture', asset); put(path, corpusBytes);
    const allow = join(repoRoot, 'server/fixtures/host-source-files.json');
    put(allow, JSON.stringify({ schemaVersion: 1, files: [...files, `server/fixtures/uemcp-fixture/${asset}`] }));
    await assert.rejects(prepareFixtureHost(corpusOptions()), /collision/);
    unlinkSync(path); put(allow, JSON.stringify({ schemaVersion: 1, files }));
  });
  await check('post-stage corpus oracle changes invalidate identity', async () => {
    const opts = corpusOptions(); await prepareFixtureHost(opts);
    put(join(corpusRoot, 'oracle.json'), '{"changed":true}');
    await assert.rejects(validateFixtureHost(opts), /corpus hash/); put(join(corpusRoot, 'oracle.json'), '{}');
  });
  await check('staged owned asset modification and deletion are rejected', async () => {
    const opts = corpusOptions(); await prepareFixtureHost(opts);
    put(join(opts.outputRoot, 'host', asset), 'changed');
    await assert.rejects(validateFixtureHost(opts), /Staged bytes/);
    unlinkSync(join(opts.outputRoot, 'host', asset));
    await assert.rejects(validateFixtureHost(opts), /membership/);
  });
} finally { cleanupCanonicalScratchRoot(scratch, 'uemcp-host-stage-'); }
t.summary();
