// Saved UE 5.6 package witnesses; synthetic, consumer and legacy coverage stays retained.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sha256, verifyOwnedFixture } from './owned-serialization.mjs';
import { TestRunner } from './test-helpers.mjs';
import { Cursor, parseSummary, readNameTable, readImportTable, readExportTable,
  readAssetRegistryData } from './uasset-parser.mjs';

const t = new TestRunner('Owned package parser');
const root = new URL('./fixtures/serialization/ue5.6-owned-v1/', import.meta.url);
const digest = '9f4e00c0d98409f42a689cab204bb10d140452b3586af0e741e23852309e56e6';
let bytes;
try {
  await verifyOwnedFixture(fileURLToPath(root), 'ue5.6-owned-v1');
  bytes = readFileSync(new URL('Content/Serialization/BP_OwnedLink.uasset', root));
  assert.equal(sha256(bytes), digest);
} catch (error) {
  t.assert(false, 'owned parser: corpus prerequisite', error.message);
  process.exit(t.summary());
}

// Frozen raw-byte audit of the hash above, independently decoded with Python struct,
// not harvested from parseBuffer. Offsets are decimal, little-endian: summary
// descriptors at 253/257 (names), 314/318 (exports), 322/326 (imports), 478 (AR).
// Imports occupy [2550,3230), exports [3230,4126); export fields below are at
// row offsets 16/20/0/12/28/36/96/104, with 112 bytes per saved record.
// This is one saved 1017 layout, not independent engine qualification of other versions.
const descriptors = {
  nameCount: 85, nameOffset: 522, softObjectPathsOffset: 2356,
  exportCount: 8, exportOffset: 3230, importCount: 17, importOffset: 2550,
  dependsOffset: 4126, assetRegistryDataOffset: 4202, totalHeaderSize: 13406,
};
const exportRows = [
  ['BP_OwnedLink', 0, -6, 0, 235, 13406, 0, 231],
  ['BP_OwnedLink_C', 0, -7, 0, 197, 13641, 0, 38],
  ['Default__BP_OwnedLink_C', 0, 2, 0, 70, 13838, 0, 66],
  ['OwnedGraph', 0, -8, 1, 156, 13908, 0, 152],
  ['ExecuteUbergraph_BP_OwnedLink', 0, -4, 2, 215, 14064, 0, 9],
  ['OwnedSignal', 0, -4, 2, 59, 14279, 0, 9],
  ['OwnedPrint', 0, -2, 4, 2480, 14338, 0, 279],
  ['OwnedEvent', 0, -3, 4, 535, 16818, 0, 107],
];
const tuple = e => [e.objectName, e.objectNameNumber, e.classIndex, e.outerIndex,
  e.serialSize, e.serialOffset, e.scriptSerializationStartOffset, e.scriptSerializationEndOffset];
function check(name, run) {
  try { run(); t.assert(true, `owned parser: ${name}`); }
  catch (error) { t.assert(false, `owned parser: ${name}`, error.stack); }
}
// Obtain table inputs only after independently checking their source descriptors.
let summary;
let names;
try {
  const cur = new Cursor(bytes);
  summary = parseSummary(cur);
  assert.equal(cur.tell(), 522);
  for (const [key, value] of Object.entries(descriptors)) assert.equal(summary[key], value, key);
  names = readNameTable(cur, summary);
  assert.equal(names.length, 85);
  assert.equal(cur.tell(), 2356);
  t.assert(true, 'owned parser: saved summary descriptors and name-table boundary');
} catch (error) {
  t.assert(false, 'owned parser: saved summary descriptors and name-table boundary', error.stack);
  process.exit(t.summary());
}

check('saved import stride and class references', () => {
  const cur = new Cursor(bytes);
  const imports = readImportTable(cur, summary, names);
  assert.equal(imports.length, 17);
  assert.equal(cur.tell(), 3230);
  for (const [index, name, outer] of [[1, 'K2Node_CallFunction', -13],
    [2, 'K2Node_CustomEvent', -13], [5, 'Blueprint', -15], [6, 'BlueprintGeneratedClass', -15]]) {
    assert.equal(imports[index].objectName, name);
    assert.equal(imports[index].className, 'Class');
    assert.equal(imports[index].outerIndex, outer);
  }
  assert.equal(imports[12].objectName, '/Script/BlueprintGraph');
  assert.equal(imports[14].objectName, '/Script/Engine');
});
function savedExports(buffer = bytes, input = summary) {
  const cur = new Cursor(buffer);
  const rows = readExportTable(cur, input, names);
  return { rows, end: cur.tell() };
}
check('all saved export tuples and 112-byte stride', () => {
  const { rows, end } = savedExports();
  assert.deepEqual(rows.map(tuple), exportRows);
  assert.equal(end, 4126);
  for (const row of rows) {
    assert.equal(Object.hasOwn(row, 'int64Overflow'), false);
    assert.equal(Object.hasOwn(row, 'int64OverflowFields'), false);
  }
});
check('Blueprint and generated-class registry records end at dependency data', () => {
  const cur = new Cursor(bytes);
  const ar = readAssetRegistryData(cur, summary);
  // Raw int64 at 4202 is 13386; FString records independently audited through that boundary.
  assert.equal(ar.dependencyDataOffset, 13386);
  assert.equal(cur.tell(), 13386);
  assert.deepEqual(ar.objects.map(o => [o.objectPath, o.objectClassName, Object.keys(o.tags).length]), [
    ['BP_OwnedLink', '/Script/Engine.Blueprint', 17],
    ['BP_OwnedLink_C', '/Script/Engine.BlueprintGeneratedClass', 7],
  ]);
});
check('saved package with corrupted magic rejects', () => {
  assert.equal(parseSummary(new Cursor(bytes)).nameOffset, 522);
  const changed = Buffer.from(bytes);
  changed.writeUInt32LE(0, 0);
  assert.throws(() => parseSummary(new Cursor(changed)), /bad magic/);
});
for (const [label, end, read] of [
  ['summary', 522, cur => parseSummary(cur)],
  ['names', 2356, cur => readNameTable(cur, summary)],
  ['imports', 3230, cur => readImportTable(cur, summary, names)],
  ['exports', 4126, cur => readExportTable(cur, summary, names)],
  ['registry', 13386, cur => readAssetRegistryData(cur, summary)],
]) {
  check(`${label} accepts exact saved boundary and rejects one-byte truncation`, () => {
    const baseline = new Cursor(bytes.subarray(0, end));
    read(baseline);
    assert.equal(baseline.tell(), end);
    assert.throws(() => read(new Cursor(bytes.subarray(0, end - 1))), /truncated read/);
  });
}
check('wrong export version desynchronizes the saved second record', () => {
  assert.deepEqual(savedExports().rows.map(tuple), exportRows);
  // Counterfactual metadata only: this does not turn the saved bytes into an older package.
  const wrong = savedExports(bytes, { ...summary, fileVersionUE5: 1009 });
  assert.notEqual(wrong.end, 4126);
  assert.notDeepEqual(tuple(wrong.rows[1]), exportRows[1]);
});
for (const [field, offset] of [['serialSize', 28], ['serialOffset', 36],
  ['scriptSerializationStartOffset', 96], ['scriptSerializationEndOffset', 104]]) {
  check(`injected ${field} overflow marks only its export and preserves later records`, () => {
    const baseline = savedExports();
    assert.deepEqual(baseline.rows.map(tuple), exportRows);
    const changed = Buffer.from(bytes);
    changed.writeBigInt64LE(1n << 62n, 3230 + offset);
    const result = savedExports(changed);
    assert.equal(result.end, 4126);
    assert.deepEqual(result.rows[0], { ...baseline.rows[0], [field]: -1,
      int64Overflow: true, int64OverflowFields: [field] });
    assert.deepEqual(result.rows.slice(1), baseline.rows.slice(1));
  });
}
check('source buffer and on-disk package remain byte-identical', () => {
  assert.equal(sha256(bytes), digest);
  assert.equal(sha256(readFileSync(new URL('Content/Serialization/BP_OwnedLink.uasset', root))), digest);
});
process.exit(t.summary());
