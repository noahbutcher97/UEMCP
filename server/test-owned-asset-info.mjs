// Owned, engine-free asset-info/cache witnesses; consumer and legacy tests remain retained.
import assert from 'node:assert/strict';
import { cpSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetCache, executeOfflineTool, parseAssetHeader, resetOfflineAssetCache } from './offline-tools.mjs';
import { sha256, verifyOwnedFixture } from './owned-serialization.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const t = new TestRunner('Owned asset-info and cache');
const version = 'ue5.6-owned-v1';
const root = fileURLToPath(new URL(`./fixtures/serialization/${version}/`, import.meta.url));
const assetFile = 'Content/Serialization/BP_OwnedLink.uasset';
const sourcePath = 'server/fixtures/uemcp-fixture/Source/UEMCPFixture/AuthorSerializationFixtureCommandlet.cpp';
const prefix = 'uemcp-owned-asset-info-';
let manifest;
let oracle;

function assertAuthoringSource(bytes) {
  // Only historical source text accepts checkout CRLF equivalence; corpus hashes are exact.
  const source = bytes.toString('utf8').replace(/\r\n/g, '\n');
  assert.equal(sha256(source), manifest.sourceHashes[sourcePath]);
  assert.ok(source.includes('const FString PackageName = TEXT("/Game/Serialization/BP_OwnedLink");'));
  assert.ok(source.includes('TEXT("BP_OwnedLink"), BPTYPE_Normal, UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass()'));
}

// A missing or corrupt prerequisite is a failure before positive or negative cases, never a skip.
try {
  await verifyOwnedFixture(root, version);
  manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  oracle = JSON.parse(readFileSync(join(root, 'oracle.json'), 'utf8').replace(/^\uFEFF/, ''));
  assertAuthoringSource(readFileSync(new URL(`../${sourcePath}`, import.meta.url)));
} catch (error) {
  t.assert(false, 'owned asset-info: corpus and authoring prerequisites', error.message);
  process.exit(t.summary());
}

const query = (project = root, params = {}) => executeOfflineTool('get_asset_info', { asset_path: oracle.asset_path, ...params }, project);
const parse = project => parseAssetHeader(project, oracle.asset_path);
function assertInfo(info, project = root) {
  // Authored identity/class/type, manifest byte size and saved version are independent of this response.
  assert.equal(info.path, '/Game/Serialization/BP_OwnedLink');
  assert.equal(info.packageName, '/Game/Serialization/BP_OwnedLink');
  assert.equal(info.objectPath, 'BP_OwnedLink');
  assert.equal(info.objectClassName, '/Script/Engine.Blueprint');
  assert.equal(info.tags.BlueprintType, 'BPTYPE_Normal');
  assert.equal(info.sizeBytes, manifest.files[assetFile].size);
  assert.equal(info.sizeKB, Math.round(manifest.files[assetFile].size / 1024));
  assert.equal(info.fileVersionUE5, manifest.savedPackage.fileVersionUE5);
  assert.equal(info.diskPath, join(project, assetFile).replace(/\\/g, '/'));
}

async function check(name, run) {
  resetOfflineAssetCache();
  try { await run(); t.assert(true, name); }
  catch (error) { t.assert(false, name, error.stack); }
  finally { resetOfflineAssetCache(); }
}

async function withCopy(run) {
  const scratch = createCanonicalScratchRoot(prefix);
  try {
    cpSync(root, scratch, { recursive: true });
    await verifyOwnedFixture(scratch, version);
    await run(scratch, join(scratch, assetFile));
  } finally { cleanupCanonicalScratchRoot(scratch, prefix); }
}

async function warm(project) {
  assertInfo(await query(project), project);
  const entry = await parse(project);
  entry.data.ownedCacheSentinel = 'warm baseline';
  assert.strictEqual((await parse(project)).data, entry.data);
  return entry;
}

await check('owned asset-info: authored identity and manifest metadata', async () => assertInfo(await query()));
await check('owned asset-info: warm dispatcher preserves metadata', async () => {
  assertInfo(await query());
  assertInfo(await query());
});
await check('owned asset-info: unchanged bytes reuse the cached payload', async () => {
  const before = await warm(root);
  assert.equal(assetCache.entries.size, 1);
  const after = await parse(root);
  assert.strictEqual(after.data, before.data);
  assert.equal(after.data.ownedCacheSentinel, 'warm baseline');
});
await check('owned asset-info: dirty index reparses unchanged bytes', async () => {
  const before = await warm(root);
  assetCache.indexDirty = true;
  const after = await parse(root);
  assert.notStrictEqual(after.data, before.data);
  assert.equal(Object.hasOwn(after.data, 'ownedCacheSentinel'), false);
  assertInfo(await query());
});
await check('owned asset-info: newer mtime reparses equal-size bytes', () => withCopy(async (project, path) => {
  const before = await warm(project);
  const changedTime = new Date(before.mtimeMs + 5000);
  utimesSync(path, changedTime, changedTime);
  assert.equal(statSync(path).size, before.sizeBytes);
  assert.ok(statSync(path).mtimeMs > before.mtimeMs);
  const after = await parse(project);
  assert.notStrictEqual(after.data, before.data);
  assert.equal(Object.hasOwn(after.data, 'ownedCacheSentinel'), false);
  assert.equal(after.modified, statSync(path).mtime.toISOString());
  assertInfo(await query(project), project);
}));
await check('owned asset-info: equal-mtime size change cannot serve a stale payload', () => withCopy(async (project, path) => {
  const fixed = new Date('2020-01-02T03:04:05.000Z');
  utimesSync(path, fixed, fixed);
  const before = await warm(project);
  const original = readFileSync(path);
  writeFileSync(path, original.subarray(0, 4));
  utimesSync(path, fixed, fixed);
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  assert.notEqual(statSync(path).size, before.sizeBytes);
  await assert.rejects(() => parse(project), /truncated read/);
  writeFileSync(path, original);
  utimesSync(path, fixed, fixed);
  assetCache.indexDirty = true;
  assertInfo(await query(project), project);
}));
await check('owned asset-info: dirty index detects same-size same-mtime corruption', () => withCopy(async (project, path) => {
  const fixed = new Date('2020-01-02T03:04:05.000Z');
  utimesSync(path, fixed, fixed);
  const before = await warm(project);
  const corrupt = readFileSync(path);
  corrupt.writeUInt32LE(0, 0);
  writeFileSync(path, corrupt);
  utimesSync(path, fixed, fixed);
  assert.equal(statSync(path).size, before.sizeBytes);
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  assetCache.indexDirty = true;
  await assert.rejects(() => parse(project), /bad magic/);
}));
await check('owned asset-info: cached asset deletion reports missing asset', () => withCopy(async (project, path) => {
  await warm(project);
  unlinkSync(path);
  await assert.rejects(() => query(project), /Asset not found/);
}));
await check('owned asset-info: identical asset names in different roots have separate caches', () => withCopy(async firstRoot => {
  const first = await warm(firstRoot);
  await withCopy(async secondRoot => {
    assertInfo(await query(secondRoot), secondRoot);
    const second = await parse(secondRoot);
    assert.notStrictEqual(second.data, first.data);
    assert.equal(Object.hasOwn(second.data, 'ownedCacheSentinel'), false);
    assert.equal((await parse(firstRoot)).data.ownedCacheSentinel, 'warm baseline');
    assert.equal(assetCache.entries.size, 2);
  });
}));
await check('owned asset-info: unknown asset rejects without a cache entry', async () => {
  assertInfo(await query());
  const before = assetCache.entries.size;
  await assert.rejects(() => query(root, { asset_path: '/Game/MissingOwnedAsset' }), /Asset not found/);
  assert.equal(assetCache.entries.size, before);
});
await check('owned asset-info: missing asset parameter rejects before cache population', async () => {
  await assert.rejects(() => executeOfflineTool('get_asset_info', {}, root), /Missing required parameter: asset_path/);
  assert.equal(assetCache.entries.size, 0);
});

for (const [field, value] of [
  ['path', '/Game/Other'], ['packageName', '/Game/Other'], ['objectPath', 'Other'],
  ['objectClassName', '/Script/Engine.World'], ['tags', { BlueprintType: 'BPTYPE_Const' }],
  ['sizeBytes', manifest.files[assetFile].size + 1], ['sizeKB', -1],
  ['fileVersionUE5', -1], ['diskPath', '/wrong/asset.uasset'],
]) {
  await check(`owned asset-info controls: rejects incorrect ${field}`, async () => {
    const baseline = await query();
    assertInfo(baseline);
    const changed = structuredClone(baseline);
    changed[field] = value;
    assert.throws(() => assertInfo(changed), assert.AssertionError);
  });
}
await check('owned asset-info controls: edited authoring source is rejected', () => {
  const source = readFileSync(new URL(`../${sourcePath}`, import.meta.url));
  assertAuthoringSource(source);
  assert.throws(() => assertAuthoringSource(Buffer.concat([source, Buffer.from('\n// changed\n')])), assert.AssertionError);
});
await check('owned asset-info: corpus remains byte-identical after all cases', async () => {
  await verifyOwnedFixture(root, version);
  assert.equal(assetCache.entries.size, 0);
});

process.exit(t.summary());
