// Distinct inspection relationships only. Query pin/node tests and parser tuples stay retained.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeOfflineTool } from './offline-tools.mjs';
import { sha256, verifyOwnedFixture } from './owned-serialization.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Owned Blueprint inspection relationships');
const root = fileURLToPath(new URL('./fixtures/serialization/ue5.6-owned-v1/', import.meta.url));
const sourcePath = 'server/fixtures/uemcp-fixture/Source/UEMCPFixture/AuthorSerializationFixtureCommandlet.cpp';
try {
  await verifyOwnedFixture(root, 'ue5.6-owned-v1');
  assert.equal(sha256(readFileSync(join(root, 'Content/Serialization/BP_OwnedLink.uasset'))),
    '9f4e00c0d98409f42a689cab204bb10d140452b3586af0e741e23852309e56e6');
  const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
  const source = readFileSync(new URL(`../${sourcePath}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(sha256(source), manifest.sourceHashes[sourcePath]);
  assert.ok(source.includes('CreateBlueprint(UObject::StaticClass(), Package,'));
  assert.ok(source.includes('TEXT("BP_OwnedLink"), BPTYPE_Normal, UBlueprint::StaticClass(), UBlueprintGeneratedClass::StaticClass()'));
} catch (error) {
  t.assert(false, 'owned inspect: immutable corpus and authored parent prerequisites', error.stack);
  process.exit(t.summary());
}
const inspect = () => executeOfflineTool('inspect_blueprint', { asset_path: '/Game/Serialization/BP_OwnedLink' }, root);
async function check(name, run) {
  try { await run(); t.assert(true, `owned inspect: ${name}`); }
  catch (error) { t.assert(false, `owned inspect: ${name}`, error.stack); }
}
function row(result, name) {
  const matches = result.exports.filter(e => e.objectName === name);
  assert.equal(matches.length, 1, `unique export ${name}`);
  return matches[0];
}
// Frozen independent Python struct audit of the hash above, not inspect output:
// import table at 2550, 17 records of 40 bytes; exports at 3230, 8 records of 112.
// FPackageIndex fields at offsets 0 (class), 4 (super), 12 (outer); asset bool at 68.
// Zero-based rows: generated row 1 super=-5 => import 4 Object;
// CDO row 2 class=+2 => export 1 BP_OwnedLink_C.
// Graph row 3 outer=+1 => BP; functions rows 4/5 outer=+2 => generated class.
// Exact record identities and raw bytes are retained in the external audit evidence.
function assertGenerated(result) {
  assert.equal(result.generatedClass, 'BP_OwnedLink_C');
  assert.equal(result.parentClass, 'Object');
  const generated = result.exports.filter(e => e.className === 'BlueprintGeneratedClass');
  assert.equal(generated.length, 1);
  assert.equal(generated[0].objectName, 'BP_OwnedLink_C');
  assert.equal(generated[0].superClass, 'Object');
  assert.equal(generated[0].outerName, null);
}
function assertCdo(result) {
  assert.equal(result.generatedClass, 'BP_OwnedLink_C');
  const cdo = row(result, 'Default__BP_OwnedLink_C');
  assert.equal(cdo.className, result.generatedClass);
  assert.equal(cdo.superClass, null);
  assert.equal(cdo.outerName, null);
}
function assertOwnership(result) {
  assert.equal(row(result, 'OwnedGraph').outerName, 'BP_OwnedLink');
  for (const name of ['ExecuteUbergraph_BP_OwnedLink', 'OwnedSignal']) {
    const fn = row(result, name);
    assert.equal(fn.className, 'Function');
    assert.equal(fn.outerName, 'BP_OwnedLink_C');
  }
}
const assetFlags = [
  ['BP_OwnedLink', true], ['BP_OwnedLink_C', true], ['Default__BP_OwnedLink_C', false],
  ['OwnedGraph', false], ['ExecuteUbergraph_BP_OwnedLink', false], ['OwnedSignal', false],
  ['OwnedPrint', false], ['OwnedEvent', false],
].sort(([a], [b]) => a.localeCompare(b));
function assertAssetFlags(result) {
  assert.deepEqual(result.exports.map(e => [e.objectName, e.bIsAsset])
    .sort(([a], [b]) => a.localeCompare(b)), assetFlags);
}
for (const [name, compare] of [
  ['generated-class selection resolves the authored Object parent', assertGenerated],
  ['CDO resolves its positive package index to the local generated class', assertCdo],
  ['graph and compiled functions retain distinct Blueprint and generated-class owners', assertOwnership],
  ['only Blueprint and generated class have the saved asset flag', assertAssetFlags],
]) await check(name, async () => compare(await inspect()));

// Baseline-first controls modify public response clones only, not package bytes.
async function rejectsChanges(compare, mutations) {
  const baseline = await inspect();
  compare(baseline);
  for (const mutate of mutations) {
    const changed = structuredClone(baseline);
    mutate(changed);
    assert.throws(() => compare(changed), assert.AssertionError);
  }
}
await check('controls reject missing or inconsistent generated-class and parent selection', () => rejectsChanges(assertGenerated, [
  r => { r.generatedClass = 'BP_OwnedLink'; },
  r => { r.parentClass = 'Actor'; },
  r => { row(r, 'BP_OwnedLink_C').superClass = null; },
  r => { r.exports = r.exports.filter(e => e.objectName !== 'BP_OwnedLink_C'); },
  r => { r.exports.push({ ...row(r, 'BP_OwnedLink_C'), objectName: 'Other_C' }); },
]));
await check('controls reject unresolved or misdirected CDO class identity', () => rejectsChanges(assertCdo, [
  r => { row(r, 'Default__BP_OwnedLink_C').className = 'unresolved(2)'; },
  r => { row(r, 'Default__BP_OwnedLink_C').className = 'BlueprintGeneratedClass'; },
  r => { row(r, 'Default__BP_OwnedLink_C').outerName = 'BP_OwnedLink_C'; },
  r => { r.exports = r.exports.filter(e => e.objectName !== 'Default__BP_OwnedLink_C'); },
]));
await check('controls reject collapsed or swapped graph and function ownership', () => rejectsChanges(assertOwnership, [
  r => { row(r, 'OwnedGraph').outerName = 'BP_OwnedLink_C'; },
  r => { row(r, 'ExecuteUbergraph_BP_OwnedLink').outerName = 'BP_OwnedLink'; },
  r => { row(r, 'OwnedSignal').outerName = null; },
  r => { r.exports = r.exports.filter(e => e.objectName !== 'OwnedSignal'); },
]));
await check('controls reject an inverted asset flag on every saved export', () => rejectsChanges(assertAssetFlags,
  assetFlags.map(([name]) => r => { const value = row(r, name); value.bIsAsset = !value.bIsAsset; })));
process.exit(t.summary());
