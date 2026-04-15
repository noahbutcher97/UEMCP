// test-uasset-parser.mjs — format-correctness tests for the .uasset parser.
//
// Runs against real fixtures pulled from the ProjectA Content directory. The
// ProjectA path is read from UNREAL_PROJECT_ROOT; fixtures are skipped when the
// path doesn't resolve (so CI without a mounted depot still reports clean).
//
// Run: cd server && node test-uasset-parser.mjs

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  Cursor,
  parseSummary,
  readNameTable,
  readExportTable,
  readAssetRegistryData,
  PACKAGE_FILE_TAG,
} from './uasset-parser.mjs';
import { TestRunner } from './test-helpers.mjs';

const runner = new TestRunner('uasset-parser format tests');

const ROOT = process.env.UNREAL_PROJECT_ROOT
  || 'D:/UnrealProjects/5.6/ProjectA/ProjectA';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// ── Fixture 1: Footstep anim-notify Blueprint (hex-dump-verified) ───
async function testFootstepFixture() {
  const path = join(ROOT, 'Content/Animations/AN_OSAnimNotify_Footstep.uasset');
  if (!(await exists(path))) {
    console.log('  · skipped Footstep fixture (no file at ' + path + ')');
    return;
  }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);

  runner.assert(s.tag === PACKAGE_FILE_TAG, 'Footstep: magic tag');
  runner.assert(s.legacyFileVersion === -9, 'Footstep: legacyFileVersion=-9');
  runner.assert(s.fileVersionUE5 === 1017, 'Footstep: fileVersionUE5=1017');
  runner.assert(s.nameCount === 33, 'Footstep: nameCount=33');
  runner.assert(s.nameOffset === 511, 'Footstep: nameOffset=511');
  runner.assert(s.exportCount === 3, 'Footstep: exportCount=3');
  runner.assert(s.exportOffset === 1859, 'Footstep: exportOffset=1859');
  runner.assert(s.importCount === 8, 'Footstep: importCount=8');
  runner.assert(s.assetRegistryDataOffset === 2357, 'Footstep: arDataOffset=2357');
  runner.assert(s.packageName === '/Game/Animations/AN_OSAnimNotify_Footstep',
                'Footstep: packageName');

  const names = readNameTable(cur, s);
  runner.assert(names.length === 33, 'Footstep: name table size');
  runner.assert(cur.tell() === s.softObjectPathsOffset,
                'Footstep: name table ends at softObjectPathsOffset');

  const exports = readExportTable(cur, s, names);
  runner.assert(exports.length === 3, 'Footstep: 3 exports parsed');
  runner.assert(cur.tell() === s.exportOffset + 3 * 112,
                'Footstep: export stride = 112 bytes (UE 5.6)');
  runner.assert(exports[0].objectName === 'Default__AN_OSAnimNotify_Footstep_C',
                'Footstep: export[0] objectName');
  runner.assert(exports[0].classIndex === 3,
                'Footstep: export[0] classIndex=3');
  runner.assert(exports[0].serialSize === 13, 'Footstep: export[0] serialSize=13');
  runner.assert(exports[0].serialOffset === 3678,
                'Footstep: export[0] serialOffset=3678');

  const ar = readAssetRegistryData(cur, s);
  runner.assert(ar.objects.length === 2, 'Footstep: 2 AR objects');
  runner.assert(cur.tell() === ar.dependencyDataOffset,
                'Footstep: AR block ends at dependencyDataOffset');
  runner.assert(ar.objects[0].objectPath === 'AN_OSAnimNotify_Footstep',
                'Footstep: AR[0] objectPath');
  runner.assert(ar.objects[0].objectClassName === '/Script/Engine.Blueprint',
                'Footstep: AR[0] objectClassName');
  runner.assert(ar.objects[0].tags.BlueprintType === 'BPTYPE_Const',
                'Footstep: AR[0] tags.BlueprintType');
  runner.assert(ar.objects[0].tags.ClassFlags === '4532224',
                'Footstep: AR[0] tags.ClassFlags');
}

// ── Fixture 2: large .umap (454 exports) — stride regression ────────
async function testLevelMap() {
  const path = join(ROOT, 'Content/Developers/steve/Steve_TestMap.umap');
  if (!(await exists(path))) {
    console.log('  · skipped Steve_TestMap (no file)');
    return;
  }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const exports = readExportTable(cur, s, names);
  const posAfterExports = cur.tell();
  const ar = readAssetRegistryData(cur, s);

  runner.assert(s.exportCount > 100, 'Level: many exports (>100)');
  runner.assert(exports.length === s.exportCount, 'Level: all exports parsed');
  runner.assert(posAfterExports === s.exportOffset + s.exportCount * 112,
                'Level: cursor at end-of-export-table');
  runner.assert(ar.objects.length >= 1, 'Level: >=1 AR object');
  runner.assert(ar.objects[0].objectClassName === '/Script/Engine.World',
                'Level: AR[0] class = World');
  const unresolved = exports.filter(e => e.objectName.startsWith('[name '));
  runner.assert(unresolved.length === 0,
                'Level: all export names resolve via name table',
                unresolved.length + ' unresolved');
}

// ── Fixture 3: GA_Sprint Blueprint — 2 AR entries (BP + BPGC) ───────
async function testAbilityBlueprint() {
  const path = join(ROOT, 'Content/GAS/Abilities/GA_Sprint.uasset');
  if (!(await exists(path))) {
    console.log('  · skipped GA_Sprint (no file)');
    return;
  }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const exports = readExportTable(cur, s, names);
  const ar = readAssetRegistryData(cur, s);

  runner.assert(ar.objects.length === 2, 'GA_Sprint: BP emits 2 AR entries');
  const bp = ar.objects.find(o => /Blueprint$/.test(o.objectClassName));
  const bpgc = ar.objects.find(o => /BlueprintGeneratedClass$/.test(o.objectClassName));
  runner.assert(bp !== undefined, 'GA_Sprint: Blueprint AR entry found');
  runner.assert(bpgc !== undefined, 'GA_Sprint: BPGC AR entry found');
  runner.assert(bpgc && bpgc.objectPath.endsWith('_C'),
                'GA_Sprint: BPGC path ends with _C');
  runner.assert(exports.length === s.exportCount,
                'GA_Sprint: export count matches summary');
  runner.assert(cur.tell() === ar.dependencyDataOffset,
                'GA_Sprint: AR ends at dependencyDataOffset');
}

// ── Fixture 4: DataTable — simple single-export case ────────────────
async function testDataTable() {
  const path = join(ROOT, 'Content/Art/Character/BaseCharacter/DT_Mutable_MeshAssets.uasset');
  if (!(await exists(path))) {
    console.log('  · skipped DT_Mutable_MeshAssets (no file)');
    return;
  }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const exports = readExportTable(cur, s, names);
  const ar = readAssetRegistryData(cur, s);

  runner.assert(ar.objects.length === 1, 'DataTable: single AR entry');
  runner.assert(ar.objects[0].objectClassName === '/Script/Engine.DataTable',
                'DataTable: class = /Script/Engine.DataTable');
  runner.assert(exports.length >= 1, 'DataTable: >=1 export');
  runner.assert(cur.tell() === ar.dependencyDataOffset,
                'DataTable: cursor at depDataOffset');
}

// ── Negative test: bad magic throws ─────────────────────────────────
function testBadMagic() {
  const buf = Buffer.alloc(16);
  buf.writeUInt32LE(0xDEADBEEF, 0);
  const cur = new Cursor(buf);
  try {
    parseSummary(cur);
    runner.assert(false, 'bad magic throws');
  } catch (e) {
    runner.assert(/bad magic/.test(e.message),
                  'bad magic throws with bad-magic message');
  }
}

// ── Negative test: truncated buffer throws meaningful error ─────────
function testTruncated() {
  const buf = Buffer.alloc(8);
  buf.writeUInt32LE(PACKAGE_FILE_TAG, 0);
  buf.writeInt32LE(-9, 4);
  const cur = new Cursor(buf);
  try {
    parseSummary(cur);
    runner.assert(false, 'truncated buffer throws');
  } catch (e) {
    runner.assert(/truncated read/.test(e.message),
                  'truncated buffer throws "truncated read"',
                  e.message);
  }
}

async function main() {
  await testFootstepFixture();
  await testLevelMap();
  await testAbilityBlueprint();
  await testDataTable();
  testBadMagic();
  testTruncated();
  process.exit(runner.summary());
}

main().catch(e => { console.error(e); process.exit(1); });
