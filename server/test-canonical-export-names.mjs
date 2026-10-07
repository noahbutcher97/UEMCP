// Public export names must preserve the FName already decoded by the parser.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Cursor, parseSummary, readNameTable, readExportTable } from './uasset-parser.mjs';
import { listAssetExports } from './offline-asset-tools.mjs';
import { createCanonicalScratchRoot, cleanupCanonicalScratchRoot, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Canonical export names');
const prefix = 'uemcp-canonical-export-';
const root = createCanonicalScratchRoot(prefix);
const i32 = value => { const b = Buffer.alloc(4); b.writeInt32LE(value); return b; };
const fstr = value => Buffer.concat([i32(value.length + 1), Buffer.from(value + '\0', 'latin1')]);

// UE 5.6 summary and 112-byte export rows, authored from primitives only.
function summary(nameOffset, exportOffset) {
  const parts = [];
  const put = value => parts.push(i32(value));
  const zero = bytes => parts.push(Buffer.alloc(bytes));
  const version = () => { zero(10); put(0); };
  parts.push(Buffer.from([0xc1, 0x83, 0x2a, 0x9e]));
  put(-9); put(0); put(522); put(1016); put(0);
  zero(20); put(0); put(0); put(0); put(0);
  put(3); put(nameOffset); put(0); put(0); put(0); put(0); put(0);
  put(3); put(exportOffset); put(0); put(0);
  zero(16); put(0); put(0); put(0); put(0); put(0); put(0);
  zero(16); put(0); version(); version();
  put(0); put(0); put(0); put(0); put(0); zero(8); put(0); put(0);
  put(0); put(0); put(3); zero(8); put(0);
  return Buffer.concat(parts);
}
function exportRow(index, number, asset) {
  const row = Buffer.alloc(112);
  row.writeInt32LE(index, 16);
  row.writeInt32LE(number, 20);
  row.writeInt32LE(asset ? 1 : 0, 72);
  return row;
}
try {
  const names = Buffer.concat(['Fixture', 'Model', 'Literal_0'].map(name => Buffer.concat([fstr(name), Buffer.alloc(4)])));
  const head = summary(0, 0);
  const bytes = Buffer.concat([
    summary(head.length, head.length + names.length), names,
    exportRow(0, 3, true), exportRow(1, 1, false), exportRow(2, 0, false),
  ]);
  mkdirSync(join(root, 'Content'));
  writeFileSync(join(root, 'Content/Fixture_2.uasset'), bytes);
  const cur = new Cursor(bytes);
  const header = parseSummary(cur);
  const table = readExportTable(cur, header, readNameTable(cur, header));
  assert.deepEqual(table.map(row => [row.objectNameBase, row.objectNameNumber, row.objectName]), [
    ['Fixture', 3, 'Fixture_2'], ['Model', 1, 'Model_0'], ['Literal_0', 0, 'Literal_0'],
  ]);
  t.assert(true, 'byte parser resolves numbered and literal-suffix names');
  const page = await listAssetExports(root, { asset_path: '/Game/Fixture_2' });
  for (const [index, expected] of ['Fixture_2', 'Model_0', 'Literal_0'].entries()) {
    t.assert(page.exports[index].canonical_name === expected,
      `public canonical name preserves ${expected}`, page.exports[index].canonical_name);
    t.assert(page.exports[index].object_name === expected,
      `public object name preserves ${expected}`);
  }
  t.assert(page.default_export.canonical_name === 'Fixture_2', 'selected numbered export has one suffix');
  t.assert(page.default_export.selection_reason === 'package_root_name_match', 'numbered package root selection retained');
} catch (error) {
  t.assert(false, 'parser-backed export listing', error.stack);
} finally {
  cleanupCanonicalScratchRoot(root, prefix);
}
t.summary();
process.exitCode = t.failed ? 1 : 0;
