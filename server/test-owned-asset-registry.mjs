// One real owned package: scan/filter/path witnesses, not bulk-scale or consumer equivalence.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeOfflineTool, resetOfflineAssetCache } from './offline-tools.mjs';
import { sha256, verifyOwnedFixture } from './owned-serialization.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Owned asset registry');
const root = fileURLToPath(new URL('./fixtures/serialization/ue5.6-owned-v1/', import.meta.url));
const packageName = '/Game/Serialization/BP_OwnedLink';
const assetFile = 'Content/Serialization/BP_OwnedLink.uasset';
const sourcePath = 'server/fixtures/uemcp-fixture/Source/UEMCPFixture/AuthorSerializationFixtureCommandlet.cpp';
let manifest;
try {
  await verifyOwnedFixture(root, 'ue5.6-owned-v1');
  manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  // Ground class/type/identity in the recorded authoring source, not a sampled query result.
  const source = readFileSync(new URL(`../${sourcePath}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(sha256(source), manifest.sourceHashes[sourcePath]);
  assert.ok(source.includes('const FString PackageName = TEXT("/Game/Serialization/BP_OwnedLink");'));
  assert.ok(source.includes('TEXT("BP_OwnedLink"), BPTYPE_Normal, UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass()'));
  // Independent filesystem inventory makes single-file scan counts nonvacuous.
  const files = readdirSync(join(root, 'Content'), { recursive: true })
    .filter(path => /\.(uasset|umap)$/.test(path)).map(path => path.replace(/\\/g, '/')).sort();
  assert.deepEqual(files, ['Serialization/BP_OwnedLink.uasset']);
} catch (error) {
  t.assert(false, 'owned registry: corpus, source and file inventory prerequisites', error.stack);
  process.exit(t.summary());
}
const query = (params = {}) => executeOfflineTool('query_asset_registry', params, root);
async function check(name, run) {
  resetOfflineAssetCache();
  try { await run(); t.assert(true, `owned registry: ${name}`); }
  catch (error) { t.assert(false, `owned registry: ${name}`, error.stack); }
  finally { resetOfflineAssetCache(); }
}
function assertEnvelope(result, { scanRoot = 'Content', scanned = 1, total = 1, matches = 1, offset = 0 } = {}) {
  assert.equal(result.scanRoot, scanRoot);
  assert.equal(result.total_scanned, scanned);
  assert.equal(result.total_matched, total);
  assert.equal(result.matches, matches);
  assert.equal(result.offset, offset);
  assert.equal(result.truncated, false);
  assert.equal(result.errors, undefined);
  assert.equal(result.results.length, matches);
}
function assertMatch(result, options) {
  assertEnvelope(result, options);
  assert.equal(result.results.length, 1);
  const row = result.results[0];
  assert.equal(row.path, `${packageName}.uasset`);
  assert.equal(row.packageName, packageName);
  assert.equal(row.objectPath, 'BP_OwnedLink');
  assert.equal(row.objectClassName, '/Script/Engine.Blueprint');
  assert.ok(Object.hasOwn(row.tags, 'BlueprintType'));
  assert.equal(row.tags.BlueprintType, 'BPTYPE_Normal');
  assert.equal(row.sizeBytes, manifest.files[assetFile].size);
}
function assertEmpty(result, options = {}) {
  assertEnvelope(result, { total: 0, matches: 0, ...options });
  assert.deepEqual(result.results, []);
}
for (const [prefix, scanRoot] of [['/Game', 'Content'], ['/Game/', 'Content'],
  ['/Game/Serialization', 'Content/Serialization']]) {
  await check(`${prefix} scans the expected root and finds the authored package`, async () => {
    assertMatch(await query({ path_prefix: prefix }), { scanRoot });
  });
}
await check('full and short primary class filters retain the real match', async () => {
  assertMatch(await query());
  for (const class_name of ['/Script/Engine.Blueprint', 'Blueprint']) assertMatch(await query({ class_name }));
});
await check('unknown, wrong full path and secondary class do not match', async () => {
  assertMatch(await query({ class_name: 'Blueprint' }));
  // tools.yaml specifies the primary class: a secondary BPGC AR record is not a second asset.
  for (const class_name of ['UnknownOwnedClass', '/Script/Other.Blueprint', '/Script/Engine.BlueprintGeneratedClass']) {
    assertEmpty(await query({ class_name }));
  }
});
await check('tag presence and independently authored exact value retain the match', async () => {
  assertMatch(await query());
  assertMatch(await query({ tag_key: 'BlueprintType' }));
  assertMatch(await query({ tag_key: 'BlueprintType', tag_value: 'BPTYPE_Normal' }));
});
await check('absent or inherited tag keys and wrong values reject a scanned package', async () => {
  assertMatch(await query({ tag_key: 'BlueprintType', tag_value: 'BPTYPE_Normal' }));
  for (const params of [{ tag_key: 'MissingOwnedTag' }, { tag_key: 'toString' },
    { tag_key: 'BlueprintType', tag_value: 'BPTYPE_Const' }]) assertEmpty(await query(params));
});
await check('first page and exhausted offset retain the filtered total', async () => {
  assertMatch(await query({ class_name: 'Blueprint', offset: 0, limit: 1 }));
  assertEmpty(await query({ class_name: 'Blueprint', offset: 1, limit: 1 }), { total: 1, offset: 1 });
});
await check('combined filters determine total before exhausted pagination', async () => {
  assertMatch(await query({ class_name: 'Blueprint', tag_key: 'BlueprintType', tag_value: 'BPTYPE_Normal' }));
  assertEmpty(await query({ class_name: 'Blueprint', tag_key: 'BlueprintType', tag_value: 'BPTYPE_Const', offset: 1, limit: 1 }), { offset: 1 });
});
await check('absent directory scans zero files rather than reporting a filtered match', async () => {
  assertMatch(await query());
  assertEmpty(await query({ path_prefix: '/Game/MissingOwnedDirectory' }), { scanRoot: 'Content/MissingOwnedDirectory', scanned: 0 });
});
await check('invalid mount and escaping traversal paths reject after a valid scan', async () => {
  assertMatch(await query({ path_prefix: '/Game/Serialization' }), { scanRoot: 'Content/Serialization' });
  for (const path_prefix of ['Content/Serialization', '/GameSibling/Serialization']) {
    await assert.rejects(() => query({ path_prefix }), /path_prefix must be \/Game/);
  }
  await assert.rejects(() => query({ path_prefix: '/Game/../../outside' }), /traversal/i);
});
// Comparator controls change cloned responses only; never corpus files or cache payloads.
await check('positive comparator rejects dropped identity, filters and scan metadata', async () => {
  const baseline = await query();
  assertMatch(baseline);
  for (const mutate of [
    r => { r.results = []; r.matches = 0; r.total_matched = 0; },
    r => { r.results[0].objectClassName = '/Script/Engine.World'; },
    r => { r.results[0].packageName = '/Game/Other'; },
    r => { r.results[0].tags.BlueprintType = 'BPTYPE_Const'; },
    r => { r.scanRoot = '../outside'; },
    r => { r.total_scanned = 0; },
    r => { r.total_matched = 0; },
    r => { r.truncated = true; },
  ]) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.throws(() => assertMatch(changed), assert.AssertionError);
  }
});
await check('empty comparator rejects a leaked match and confused scan or pagination counts', async () => {
  const positive = await query();
  assertMatch(positive);
  const empty = await query({ class_name: 'UnknownOwnedClass' });
  assertEmpty(empty);
  for (const mutate of [
    r => { r.results = positive.results; r.matches = 1; r.total_matched = 1; },
    r => { r.total_scanned = 0; },
    r => { r.total_matched = 1; },
    r => { r.offset = 1; },
  ]) {
    const changed = structuredClone(empty);
    mutate(changed);
    assert.throws(() => assertEmpty(changed), assert.AssertionError);
  }
});
await check('corpus remains verified after all registry queries', async () => {
  await verifyOwnedFixture(root, 'ue5.6-owned-v1');
});
process.exit(t.summary());
