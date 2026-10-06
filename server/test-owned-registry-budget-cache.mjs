// Owned scanner-budget and registry-cache witnesses only. Each disk file is a
// verified copy of ONE saved package; these are not distinct UE asset identities.
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetCache, executeOfflineTool, resetOfflineAssetCache } from './offline-tools.mjs';
import { sha256, verifyOwnedFixture } from './owned-serialization.mjs';
import { TestRunner, REPO_ROOT, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';
import { collectFixtureIdentity } from './execution-manifest.mjs';

const t = new TestRunner('Owned registry budget and cache');
const fixtureRelative = 'server/fixtures/serialization/ue5.6-owned-v1';
const corpus = fileURLToPath(new URL('./fixtures/serialization/ue5.6-owned-v1/', import.meta.url));
const sourcePath = 'server/fixtures/uemcp-fixture/Source/UEMCPFixture/AuthorSerializationFixtureCommandlet.cpp';
const asset = 'Content/Serialization/BP_OwnedLink.uasset';
const corpusPaths = ['manifest.json', 'oracle.json', asset].map(path => `${fixtureRelative}/${path}`);
const before = collectFixtureIdentity(REPO_ROOT, corpusPaths);
const manifest = JSON.parse(readFileSync(join(corpus, 'manifest.json'), 'utf8'));
const packageName = '/Game/Serialization/BP_OwnedLink';
const copies = {
  Below: ['Scan01.uasset', 'Scan02.uasset', 'Scan03.uasset', 'Scan04.uasset'],
  Exact: ['Scan01.uasset', 'Scan02.uasset', 'Scan03.uasset', 'Scan04.uasset', 'Scan05.uasset'],
  Above: ['Scan01.uasset', 'Scan02.uasset', 'Scan03.uasset', 'Scan04.uasset', 'Scan05.uasset', 'Scan06.uasset'],
};
async function check(name, fn) {
  resetOfflineAssetCache();
  try { await fn(); t.assert(true, `owned registry budget: ${name}`); }
  catch (error) { t.assert(false, `owned registry budget: ${name}`, error.stack); }
  finally { resetOfflineAssetCache(); }
}
await check('corpus and authored package metadata prerequisites', async () => {
  await verifyOwnedFixture(corpus, 'ue5.6-owned-v1');
  const source = readFileSync(join(REPO_ROOT, sourcePath), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(sha256(source), manifest.sourceHashes[sourcePath]);
  assert.ok(source.includes('const FString PackageName = TEXT("/Game/Serialization/BP_OwnedLink");'));
  assert.ok(source.includes('TEXT("BP_OwnedLink"), BPTYPE_Normal, UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass()'));
});
if (t.failed) process.exit(t.summary());
const scratch = createCanonicalScratchRoot('uemcp-registry-budget-');
const project = join(scratch, 'project');
const otherProject = join(scratch, 'other-project');
const diskPaths = (group, root = project) => copies[group].map(name => join(root, 'Content', group, name));
const gamePaths = group => copies[group].map(name => `/Game/${group}/${name}`);
const query = (group = 'Above', params = {}, root = project) => executeOfflineTool('query_asset_registry',
  { path_prefix: `/Game/${group}`, max_scan: 10, limit: 100, ...params }, root);
function assertRegistry(result, { group = 'Above', scanned = 6, matched = 6, returned = 6, truncated = false, offset = 0 } = {}) {
  assert.equal(result.scanRoot, `Content/${group}`);
  assert.equal(result.total_scanned, scanned);
  assert.equal(result.total_matched, matched);
  assert.equal(result.matches, returned);
  assert.equal(result.offset, offset);
  assert.equal(result.truncated, truncated);
  assert.equal(result.errors, undefined);
  assert.equal(result.results.length, returned);
  const paths = result.results.map(row => row.path);
  assert.equal(new Set(paths).size, paths.length, 'unique disk paths, not package-name deduplication');
  for (const row of result.results) {
    assert.ok(gamePaths(group).includes(row.path), `unowned result path ${row.path}`);
    assert.equal(row.packageName, packageName, 'copied bytes keep their original internal package identity');
    assert.equal(row.objectPath, 'BP_OwnedLink');
    assert.equal(row.objectClassName, '/Script/Engine.Blueprint');
    assert.equal(row.tags.BlueprintType, 'BPTYPE_Normal');
    assert.equal(row.sizeBytes, manifest.files[asset].size);
  }
  if (returned === copies[group].length) assert.deepEqual([...paths].sort(), gamePaths(group).sort());
}
function assertCache(expected, entries = assetCache.entries) {
  assert.deepEqual([...entries.keys()].sort(), [...expected].sort(), 'exact absolute disk cache keys');
  for (const path of expected) {
    const entry = entries.get(path);
    assert.equal(entry.path, path);
    assert.equal(entry.sizeBytes, manifest.files[asset].size);
    assert.equal(entry.mtimeMs, statSync(path).mtimeMs);
    assert.equal(entry.data.summary.packageName, packageName);
    assert.equal(entry.data.assetRegistry.objects[0].objectClassName, '/Script/Engine.Blueprint');
  }
}
function assertReused(beforeEntries, afterEntries = assetCache.entries) {
  assertCache([...beforeEntries.keys()], afterEntries);
  for (const [path, entry] of beforeEntries) {
    assert.strictEqual(afterEntries.get(path), entry, `warm entry reuse: ${path}`);
    assert.strictEqual(afterEntries.get(path).data, entry.data, `warm payload reuse: ${path}`);
  }
}
try {
  for (const [group, names] of Object.entries(copies)) {
    mkdirSync(join(project, 'Content', group), { recursive: true });
    for (const name of names) copyFileSync(join(corpus, asset), join(project, 'Content', group, name));
  }
  mkdirSync(join(otherProject, 'Content', 'Above'), { recursive: true });
  for (const path of diskPaths('Above', otherProject)) copyFileSync(join(corpus, asset), path);
  await check('bounded scratch inventory contains only independently enumerated byte copies', () => {
    assert.equal(Object.values(copies).flat().length, 15);
    const actual = readdirSync(join(project, 'Content'), { recursive: true }).filter(path => path.endsWith('.uasset'))
      .map(path => path.replace(/\\/g, '/')).sort();
    assert.deepEqual(actual, Object.entries(copies).flatMap(([group, names]) => names.map(name => `${group}/${name}`)).sort());
    for (const paths of [...Object.keys(copies).map(group => diskPaths(group)), diskPaths('Above', otherProject)]) {
      for (const path of paths) assert.equal(sha256(readFileSync(path)), manifest.files[asset].sha256);
    }
  });
  for (const [group, scanned, truncated] of [['Below', 4, false], ['Exact', 5, true], ['Above', 5, true]]) {
    await check(`${group.toLowerCase()} five-file cap scans ${scanned} and truncated is ${truncated}`, async () => {
      assert.equal(assetCache.entries.size, 0);
      const result = await query(group, { max_scan: 5 });
      assertRegistry(result, { group, scanned, matched: scanned, returned: scanned, truncated });
      // Over-cap membership is a unique five-of-six set, not an undocumented
      // filesystem ordering promise. The uncapped cases bind all exact paths.
      const parsedPaths = result.results.map(row => join(project, 'Content', row.path.slice('/Game/'.length)));
      assertCache(parsedPaths);
    });
  }
  await check('result limit caps returned rows without capping scanned files or cache population', async () => {
    const result = await query('Above', { limit: 2 });
    assertRegistry(result, { returned: 2, truncated: true });
    assertCache(diskPaths('Above'));
  });
  await check('exact result limit does not truncate below the scan cap', async () => {
    assertRegistry(await query('Above', { limit: 6 }));
    assertCache(diskPaths('Above'));
  });
  await check('scan cap and result limit remain separate budgets', async () => {
    const result = await query('Above', { max_scan: 3, limit: 2 });
    assertRegistry(result, { scanned: 3, matched: 3, returned: 2, truncated: true });
    const keys = [...assetCache.entries.keys()];
    assert.equal(keys.length, 3);
    assert.ok(keys.every(key => diskPaths('Above').includes(key)));
    for (const row of result.results) assert.ok(keys.includes(join(project, 'Content', row.path.slice('/Game/'.length))));
    assertCache(keys);
  });
  await check('no-match filter still scans and caches all six exact paths', async () => {
    assertRegistry(await query());
    resetOfflineAssetCache();
    assert.equal(assetCache.entries.size, 0);
    assertRegistry(await query('Above', { class_name: 'MissingOwnedRegistryClass' }), { matched: 0, returned: 0 });
    assertCache(diskPaths('Above'));
  });
  await check('no-match scan reaching the cap still reports truncation', async () => {
    assertRegistry(await query('Exact', { max_scan: 5, class_name: 'MissingOwnedRegistryClass' }),
      { group: 'Exact', scanned: 5, matched: 0, returned: 0, truncated: true });
    assertCache(diskPaths('Exact'));
  });
  await check('exhausted result offset does not manufacture scan-cap truncation', async () => {
    assertRegistry(await query('Above', { offset: 6, limit: 2 }), { offset: 6, returned: 0 });
    assertCache(diskPaths('Above'));
  });
  await check('exhausted offset cannot clear a reached scan cap', async () => {
    assertRegistry(await query('Exact', { max_scan: 5, offset: 5, limit: 2 }),
      { group: 'Exact', scanned: 5, matched: 5, returned: 0, offset: 5, truncated: true });
    assertCache(diskPaths('Exact'));
  });
  await check('cold and warm registry queries preserve exact keys and reuse each payload', async () => {
    assert.equal(assetCache.entries.size, 0);
    const cold = await query(); assertRegistry(cold); assertCache(diskPaths('Above'));
    const entries = new Map(assetCache.entries);
    const warm = await query(); assertRegistry(warm); assert.deepEqual(warm, cold);
    assertReused(entries);
  });
  await check('warm no-match queries reuse parsed entries rather than clear the cache', async () => {
    assertRegistry(await query()); assertCache(diskPaths('Above'));
    const entries = new Map(assetCache.entries);
    assertRegistry(await query('Above', { tag_key: 'BlueprintType', tag_value: 'BPTYPE_Const' }), { matched: 0, returned: 0 });
    assertReused(entries);
  });
  await check('switching the registry prefix adds only that prefix to existing cached paths', async () => {
    assertRegistry(await query()); assertCache(diskPaths('Above'));
    const aboveEntries = new Map(assetCache.entries);
    assertRegistry(await query('Below'), { group: 'Below', scanned: 4, matched: 4, returned: 4 });
    assertCache([...diskPaths('Above'), ...diskPaths('Below')]);
    for (const [path, entry] of aboveEntries) assert.strictEqual(assetCache.entries.get(path), entry);
  });
  await check('identical internal package identities from another project get distinct absolute cache keys', async () => {
    assertRegistry(await query()); const originalEntries = new Map(assetCache.entries);
    assertRegistry(await query('Above', {}, otherProject));
    assertCache([...diskPaths('Above'), ...diskPaths('Above', otherProject)]);
    for (const [path, entry] of originalEntries) assert.strictEqual(assetCache.entries.get(path), entry);
  });
  await check('dirty index causes registry queries to replace all scanned cache payloads', async () => {
    assertRegistry(await query()); const entries = new Map(assetCache.entries);
    assetCache.indexDirty = true;
    assertRegistry(await query()); assertCache(diskPaths('Above'));
    for (const [path, entry] of entries) assert.notStrictEqual(assetCache.entries.get(path).data, entry.data);
  });
  await check('newer mtime refreshes only the changed registry path', async () => {
    assertRegistry(await query()); const entries = new Map(assetCache.entries);
    const changed = diskPaths('Above')[2];
    const time = new Date(entries.get(changed).mtimeMs + 5000);
    utimesSync(changed, time, time);
    assertRegistry(await query()); assertCache(diskPaths('Above'));
    for (const [path, entry] of entries) {
      if (path === changed) assert.notStrictEqual(assetCache.entries.get(path).data, entry.data);
      else assert.strictEqual(assetCache.entries.get(path), entry);
    }
  });
  await check('response controls reject incorrect cap metadata and copied identity assumptions', async () => {
    const baseline = await query('Exact', { max_scan: 5 });
    const expected = { group: 'Exact', scanned: 5, matched: 5, returned: 5, truncated: true };
    assertRegistry(baseline, expected);
    for (const mutate of [r => { r.total_scanned = 4; }, r => { r.total_scanned = 6; },
      r => { r.total_matched = 6; }, r => { r.truncated = false; }, r => { r.matches = 4; },
      r => { r.results.pop(); }, r => { r.results[1] = structuredClone(r.results[0]); },
      r => { r.results[0].path = '/Game/Unowned.uasset'; },
      r => { r.results[0].packageName = r.results[0].path.replace('.uasset', ''); }]) {
      const changed = structuredClone(baseline); mutate(changed);
      assert.throws(() => assertRegistry(changed, expected), assert.AssertionError);
    }
  });
  await check('response controls reject conflating result limits with scan or match counts', async () => {
    const baseline = await query('Above', { limit: 2 });
    const expected = { returned: 2, truncated: true };
    assertRegistry(baseline, expected);
    for (const field of ['total_scanned', 'total_matched']) {
      assert.throws(() => assertRegistry({ ...baseline, [field]: 2 }, expected), assert.AssertionError);
    }
  });
  await check('cache controls reject missing extra relative or foreign-project entries', async () => {
    assertRegistry(await query()); assertCache(diskPaths('Above'));
    const baseline = new Map(assetCache.entries); const first = diskPaths('Above')[0];
    for (const mutate of [m => m.delete(first), m => m.set(diskPaths('Below')[0], baseline.get(first)),
      m => { m.delete(first); m.set('Content/Above/Scan01.uasset', baseline.get(first)); },
      m => { m.delete(first); m.set(diskPaths('Above', otherProject)[0], baseline.get(first)); }]) {
      const changed = new Map(baseline); mutate(changed);
      assert.throws(() => assertCache(diskPaths('Above'), changed), assert.AssertionError);
    }
  });
  await check('warm-cache control rejects a replaced payload even when its values are equal', async () => {
    assertRegistry(await query()); const baseline = new Map(assetCache.entries);
    assertRegistry(await query()); assertReused(baseline);
    const changed = new Map(assetCache.entries); const first = diskPaths('Above')[0];
    changed.set(first, structuredClone(changed.get(first)));
    assert.throws(() => assertReused(baseline, changed), assert.AssertionError);
  });
  await check('all copied bytes and committed corpus remain immutable after queries', async () => {
    for (const paths of [...Object.keys(copies).map(group => diskPaths(group)), diskPaths('Above', otherProject)]) {
      for (const path of paths) assert.equal(sha256(readFileSync(path)), manifest.files[asset].sha256);
    }
    assert.deepEqual(collectFixtureIdentity(REPO_ROOT, corpusPaths), before);
    await verifyOwnedFixture(corpus, 'ue5.6-owned-v1');
  });
} finally { resetOfflineAssetCache(); cleanupCanonicalScratchRoot(scratch, 'uemcp-registry-budget-'); }
process.exit(t.summary());
