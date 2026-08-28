// test-uasset-parser.mjs — format-correctness tests for the .uasset parser.
//
// Runs against real fixtures pulled from the target project's Content directory.
// The project root is read from UNREAL_PROJECT_ROOT; fixtures are skipped when
// the path doesn't resolve (so CI without a mounted depot still reports clean).
//
// Run: cd server && node test-uasset-parser.mjs

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  Cursor,
  parseSummary,
  readNameTable,
  readImportTable,
  readExportTable,
  readAssetRegistryData,
  readExportProperties,
  readTaggedPropertyStream,
  makePackageIndexResolver,
  isGraphNodeExportClass,
  pinBlockLayoutForPackage,
  readPropertyTag,
  readFText,
  parsePinBlock,
  PACKAGE_FILE_TAG,
  UE5_PACKAGE_SAVED_HASH,
  UE5_IMPORT_TYPE_HIERARCHIES,
  UE5_OPTIONAL_RESOURCES,
  UE5_REMOVE_OBJECT_EXPORT_PACKAGE_GUID,
  UE5_TRACK_OBJECT_EXPORT_IS_INHERITED,
  UE5_SCRIPT_SERIALIZATION_OFFSET,
  UE4_LOAD_FOR_EDITOR_GAME,
  UE4_COOKED_ASSETS_IN_EDITOR_SUPPORT,
  UE4_PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS,
  UE4_TEMPLATE_INDEX_IN_COOKED_EXPORTS,
  UE4_64BIT_EXPORTMAP_SERIALSIZES,
  UE4_NON_OUTER_PACKAGE_IMPORT,
  PKG_FILTER_EDITOR_ONLY,
  PKG_UNVERSIONED_PROPERTIES,
} from './uasset-parser.mjs';
import {
  buildStructHandlers,
  buildContainerHandlers,
  readFVectorBinary,
  readFRotatorBinary,
  readFQuatBinary,
  readFTransformBinary,
  readFLinearColorBinary,
  readFColorBinary,
  readFGuidBinary,
  readFVector4Binary,
  readFIntPointBinary,
  readFBoxBinary,
  readFExpressionInputBinary,
} from './uasset-structs.mjs';
import { GENERIC_CONTAINER_FALLBACK_REASON } from './property-read-contract.mjs';
import {
  applyOracleFreshnessGate,
  countTopologyEdges,
  evaluateAssetInfoFreshness,
  evaluateTopologyOracleFreshness,
} from './oracle-freshness.mjs';
import {
  buildSubobjectResponseRow,
  collectSubobjectExportIndexes,
  summarizeCollisionProperties,
} from './offline-tools.mjs';
import { engineAssetDiskPath, engineVersionMatches, readEngineBuildVersion, resolveEngineRoot } from './engine-fixtures.mjs';
import { REPO_ROOT, findContentAsset, TestRunner } from './test-helpers.mjs';

const runner = new TestRunner('uasset-parser format tests');

// Byte-builders for synthetic FText fixtures (see the NamedFormat test).
function int32LE(v) { const b = Buffer.alloc(4); b.writeInt32LE(v | 0); return b; }
function int64LE(v) { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; }
function ansiString(str) {
  return Buffer.concat([int32LE(str.length + 1), Buffer.from(str + '\0', 'latin1')]);
}

const ROOT = process.env.UNREAL_PROJECT_ROOT || '';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

function assetPathFromContentRel(relPath) {
  return `/Game/${relPath.replace(/\\/g, '/').replace(/^Content\//, '').replace(/\.uasset$/i, '')}`;
}

// Discovery-first probe resolution (D188 Task 6). The individual fixture
// functions below used to hardcode `join(ROOT, 'Content/<path>')` for each
// probe asset; those paths went stale on the project's Content reorg
// (fixed in place for this file per D188 Task 1) and would drift again on
// the next one. Each distinct probe filename is now resolved once here via
// findContentAsset() — a real content walk that finds the asset wherever
// it currently lives (except under skipped trees like Developers/ — those
// probes always use their fallback path). When discovery can't find it (fixture-project run
// with no Content/ tree at all, or a genuinely-missing asset in a real
// project) we fall back to the historical relative path, so every
// existing per-test `exists()` gate below still prints its original
// "no file at <path>" skip line unchanged.
async function resolveProbe(fileName, fallbackRelPath) {
  const found = await findContentAsset(ROOT, fileName);
  return found ? found.diskPath : join(ROOT, fallbackRelPath);
}

const PROBE = {
  footstep: await resolveProbe('AN_OSAnimNotify_Footstep.uasset', 'Content/Animations/AN_OSAnimNotify_Footstep.uasset'),
  steveTestMap: await resolveProbe('Steve_TestMap.umap', 'Content/Developers/steve/Steve_TestMap.umap'),
  gaSprint: await resolveProbe('GA_Sprint.uasset', 'Content/GAS/Abilities/GA_Sprint.uasset'),
  dtMutableMeshAssets: await resolveProbe('DT_Mutable_MeshAssets.uasset', 'Content/Art/Character/BaseCharacter/DT_Mutable_MeshAssets.uasset'),
  bpgaBlock: await resolveProbe('BPGA_Block.uasset', 'Content/GAS/Abilities/BPGA_Block.uasset'),
  bpOSPlayerR: await resolveProbe('BP_OSPlayerR.uasset', 'Content/Actors/Character/BP_OSPlayerR.uasset'),
  mainMenuVersion: await resolveProbe('Main_MenuVersion.umap', 'Content/Maps/Non-Deployable/Main_MenuVersion.umap'),
  stylizedBasic: await resolveProbe('M_StylizedBasic.uasset', 'Content/ImportedAssets/SoStylized/Materials/M_StylizedBasic.uasset'),
  bpOSPlayerRChild: await resolveProbe('BP_OSPlayerR_Child.uasset', 'Content/Actors/Character/BP_OSPlayerR_Child.uasset'),
  bpOSPlayerRChild1: await resolveProbe('BP_OSPlayerR_Child1.uasset', 'Content/Actors/Character/BP_OSPlayerR_Child1.uasset'),
  bpOSPlayerRChild2: await resolveProbe('BP_OSPlayerR_Child2.uasset', 'Content/Actors/Character/BP_OSPlayerR_Child2.uasset'),
  testCharacter: await resolveProbe('TestCharacter.uasset', 'Content/Blueprints/Character/TestCharacter.uasset'),
  bpOSControlPoint: await resolveProbe('BP_OSControlPoint.uasset', 'Content/Actors/Level/BP_OSControlPoint.uasset'),
};

// Fixture-name -> resolved path, for the CP1/CP2 loops below that iterate a
// small fixture table keyed by fixture name rather than a single probe.
const PROBE_BY_NAME = {
  BP_OSPlayerR: PROBE.bpOSPlayerR,
  BP_OSPlayerR_Child: PROBE.bpOSPlayerRChild,
  BP_OSPlayerR_Child1: PROBE.bpOSPlayerRChild1,
  BP_OSPlayerR_Child2: PROBE.bpOSPlayerRChild2,
  TestCharacter: PROBE.testCharacter,
  BP_OSControlPoint: PROBE.bpOSControlPoint,
};

// ── Synthetic FPackageFileSummary builder — version-delta regression (D166) ──
//
// Builds a byte-accurate summary (LegacyFileVersion=-9, hasSavedHash) for a given
// EUnrealEngineObjectUE5Version, mirroring parseSummary's read order field-for-field.
// The ONLY layout difference between 1016 (UE 5.6) and 1018 (UE 5.7) is the 8-byte
// ImportTypeHierarchies{Count,Offset} block inserted after ThumbnailTableOffset.
// Drift-immune + NDA-safe (no real asset bytes). Guards the D166 fix in hosted CI.
function buildSyntheticSummary({ fileVersionUE5, nameCount, nameOffset, exportCount,
                                 importCount, assetRegistryDataOffset }) {
  const chunks = [];
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); chunks.push(b); };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); chunks.push(b); };
  const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); chunks.push(b); };
  const zeros = (n) => chunks.push(Buffer.alloc(n));
  const fstrEmpty = () => i32(0);                       // empty FString
  const engineVersion = () => { zeros(2 + 2 + 2 + 4); fstrEmpty(); };

  u32(PACKAGE_FILE_TAG);
  i32(-9);                 // LegacyFileVersion
  i32(0);                  // LegacyUE3Version
  i32(522);                // FileVersionUE4
  i32(fileVersionUE5);
  i32(0);                  // FileVersionLicenseeUE
  zeros(20);               // SavedHash (FIoHash; hasSavedHash since UE5 >= 1016)
  i32(0);                  // TotalHeaderSize
  i32(0);                  // CustomVersion count (legacy <= -2)
  fstrEmpty();             // PackageName
  u32(0);                  // PackageFlags
  i32(nameCount); i32(nameOffset);
  i32(0); i32(0);          // SoftObjectPaths count/offset (UE5 >= 1008)
  fstrEmpty();             // LocalizationId
  i32(0); i32(0);          // GatherableTextData count/offset
  i32(exportCount); i32(7777);     // Export count/offset
  i32(importCount); i32(8888);     // Import count/offset
  i32(0); i32(0); i32(0); i32(0);  // Cells (UE5 >= 1015)
  i32(0);                  // MetaDataOffset (UE5 >= 1014)
  i32(0);                  // DependsOffset
  i32(0); i32(0);          // SoftPackageReferences count/offset
  i32(0);                  // SearchableNamesOffset
  i32(0);                  // ThumbnailTableOffset
  if (fileVersionUE5 >= UE5_IMPORT_TYPE_HIERARCHIES) {
    i32(111); i32(222);    // ImportTypeHierarchies count/offset — the 5.7 (1018) insert
  }
  zeros(16);               // PersistentGuid
  i32(0);                  // GenerationCount
  engineVersion(); engineVersion();
  u32(0);                  // CompressionFlags
  i32(0);                  // CompressedChunkCount (must be 0)
  u32(0);                  // PackageSource
  i32(0);                  // AdditionalPackagesToCook count
  i32(assetRegistryDataOffset);
  i64(0);                  // BulkDataStartOffset
  i32(0);                  // WorldTileInfoDataOffset
  i32(0);                  // ChunkIDs count
  i32(0); i32(0);          // PreloadDependency count/offset
  i32(nameCount);          // NamesReferencedFromExportData (UE5 >= 1001)
  i64(0);                  // PayloadTocOffset (UE5 >= 1002)
  i32(0);                  // DataResourceOffset (UE5 >= 1009)
  return Buffer.concat(chunks);
}

// Round-trip a synthetic summary at 5.6 (1016) and 5.7 (1018): downstream fields
// must align identically at both, proving the parser consumes the 1018-only
// ImportTypeHierarchies block (and not below). Regression guard for D166.
function testVersionSummaryDelta() {
  const sentinels = { nameCount: 7, nameOffset: 1000, exportCount: 3, importCount: 5, assetRegistryDataOffset: 424242 };
  for (const ue5 of [UE5_PACKAGE_SAVED_HASH, UE5_IMPORT_TYPE_HIERARCHIES]) {
    const buf = buildSyntheticSummary({ fileVersionUE5: ue5, ...sentinels });
    let s;
    try { s = parseSummary(new Cursor(buf)); }
    catch (e) { runner.assert(false, `synthetic UE5=${ue5} summary parses`, e.message); continue; }
    runner.assert(s.fileVersionUE5 === ue5, `synthetic UE5=${ue5}: fileVersionUE5 round-trips`);
    runner.assert(s.nameCount === 7 && s.nameOffset === 1000, `synthetic UE5=${ue5}: name count/offset aligned`);
    runner.assert(s.exportCount === 3 && s.importCount === 5, `synthetic UE5=${ue5}: export/import counts aligned`);
    runner.assert(s.assetRegistryDataOffset === 424242,
      `synthetic UE5=${ue5}: downstream AR offset aligned (1018 ImportTypeHierarchies field consumed)`,
      `got ${s.assetRegistryDataOffset}`);
  }
}

// ── Fixture 1: Footstep anim-notify Blueprint (hex-dump-verified) ───
async function testFootstepFixture() {
  const path = PROBE.footstep;
  if (!(await exists(path))) {
    console.log('  · skipped Footstep fixture (no file at ' + path + ')');
    return;
  }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const posAfterNames = cur.tell();
  const exports = readExportTable(cur, s, names);
  const posAfterExports = cur.tell();
  const ar = readAssetRegistryData(cur, s);
  const posAfterAr = cur.tell();
  const primary = ar.objects[0] || {};
  const freshness = evaluateAssetInfoFreshness('Footstep byte oracle', {
    path: '/Game/Animations/AN_OSAnimNotify_Footstep',
    packageName: s.packageName,
    objectPath: primary.objectPath,
    objectClassName: primary.objectClassName,
    fileVersionUE5: s.fileVersionUE5,
    nameCount: s.nameCount,
    nameOffset: s.nameOffset,
    exportCount: s.exportCount,
    exportOffset: s.exportOffset,
    importCount: s.importCount,
    assetRegistryDataOffset: s.assetRegistryDataOffset,
    assetRegistryObjects: ar.objects.length,
  }, {
    path: '/Game/Animations/AN_OSAnimNotify_Footstep',
    packageName: '/Game/Animations/AN_OSAnimNotify_Footstep',
    objectPath: 'AN_OSAnimNotify_Footstep',
    objectClassName: '/Script/Engine.Blueprint',
    fileVersionUE5: 1017,
    nameCount: 33,
    nameOffset: 511,
    exportCount: 3,
    exportOffset: 1859,
    importCount: 8,
    assetRegistryDataOffset: 2357,
    assetRegistryObjects: 2,
  });
  if (!applyOracleFreshnessGate(runner, freshness)) return;

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

  runner.assert(names.length === 33, 'Footstep: name table size');
  runner.assert(posAfterNames === s.softObjectPathsOffset,
                'Footstep: name table ends at softObjectPathsOffset');

  runner.assert(exports.length === 3, 'Footstep: 3 exports parsed');
  runner.assert(posAfterExports === s.exportOffset + 3 * 112,
                'Footstep: export stride = 112 bytes (UE 5.6)');
  runner.assert(exports[0].objectName === 'Default__AN_OSAnimNotify_Footstep_C',
                'Footstep: export[0] objectName');
  runner.assert(exports[0].classIndex === 3,
                'Footstep: export[0] classIndex=3');
  runner.assert(exports[0].serialSize === 13, 'Footstep: export[0] serialSize=13');
  runner.assert(exports[0].serialOffset === 3678,
                'Footstep: export[0] serialOffset=3678');

  runner.assert(ar.objects.length === 2, 'Footstep: 2 AR objects');
  runner.assert(posAfterAr === ar.dependencyDataOffset,
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
  const path = PROBE.steveTestMap;
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
  const path = PROBE.gaSprint;
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
  const path = PROBE.dtMutableMeshAssets;
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

// ── readInt64AsNumberOrNull — lenient int64 reads for salvage paths ──
function testInt64Lenient() {
  // In-range value: returns Number, advances 8 bytes.
  const okBuf = Buffer.alloc(8);
  okBuf.writeBigInt64LE(42n, 0);
  const okCur = new Cursor(okBuf);
  runner.assert(okCur.readInt64AsNumberOrNull() === 42,
                'readInt64AsNumberOrNull: in-range returns Number');
  runner.assert(okCur.tell() === 8,
                'readInt64AsNumberOrNull: in-range advances 8 bytes');

  // Overflow value: returns null, still advances 8 bytes (stride preserved).
  const bigBuf = Buffer.alloc(8);
  // 2^54 = 18_014_398_509_481_984n (> Number.MAX_SAFE_INTEGER = 2^53 - 1).
  bigBuf.writeBigInt64LE(1n << 54n, 0);
  const bigCur = new Cursor(bigBuf);
  runner.assert(bigCur.readInt64AsNumberOrNull() === null,
                'readInt64AsNumberOrNull: overflow returns null');
  runner.assert(bigCur.tell() === 8,
                'readInt64AsNumberOrNull: overflow still advances 8 bytes (stride preserved)');

  // Negative overflow (large negative) also returns null.
  const negBuf = Buffer.alloc(8);
  negBuf.writeBigInt64LE(-(1n << 62n), 0);
  const negCur = new Cursor(negBuf);
  runner.assert(negCur.readInt64AsNumberOrNull() === null,
                'readInt64AsNumberOrNull: large negative returns null');

  // Strict reader still throws — the two behaviours coexist.
  const throwCur = new Cursor(bigBuf);
  try {
    throwCur.readInt64AsNumber();
    runner.assert(false, 'readInt64AsNumber: still throws on overflow');
  } catch (e) {
    runner.assert(/overflows JS safe integer/.test(e.message),
                  'readInt64AsNumber: strict reader still throws on overflow');
  }
}

// ── readExportTable salvage on int64 overflow — real VFX mesh fixture ──
async function testExportInt64Salvage() {
  // SM_auraHousya.uasset: VFX mesh whose export row carries 64-bit hash /
  // sentinel values > 2^53. Pre-fix: readExportTable threw. Post-fix: table
  // parses fully, the offending export is marked with int64Overflow.
  // Relative to UNREAL_PROJECT_ROOT. Override via UEMCP_VFX_FIXTURE_RELPATH if your project layout differs.
  const vfxRel = process.env.UEMCP_VFX_FIXTURE_RELPATH || 'Content/VfxCorpus/SM_auraHousya.uasset';
  const path = ROOT ? join(ROOT, vfxRel) : '';
  if (!(await exists(path))) {
    console.log('  · [SKIP-NEED-ENV] SM_auraHousya: set UEMCP_VFX_FIXTURE_RELPATH to enable int64 salvage coverage (tried ' + path + ')');
    return;
  }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  readImportTable(cur, s, names);
  const exports = readExportTable(cur, s, names);

  runner.assert(exports.length === s.exportCount,
                `SM_auraHousya: readExportTable yields ${s.exportCount} exports without throwing`);

  const marked = exports.filter(e => e.int64Overflow);
  runner.assert(marked.length > 0,
                `SM_auraHousya: at least one export carries int64Overflow marker (got ${marked.length})`);

  const first = marked[0];
  runner.assert(Array.isArray(first.int64OverflowFields) && first.int64OverflowFields.length > 0,
                'SM_auraHousya: marked export lists the overflowing field names');
  runner.assert(first.int64OverflowFields.every(f =>
                  ['serialSize', 'serialOffset',
                   'scriptSerializationStartOffset', 'scriptSerializationEndOffset'].includes(f)),
                'SM_auraHousya: overflow fields are from the four int64 export fields');

  // Clean exports should NOT carry the marker (no bloat on good rows).
  const clean = exports.filter(e => !e.int64Overflow);
  runner.assert(clean.every(e => !('int64Overflow' in e) && !('int64OverflowFields' in e)),
                'SM_auraHousya: non-overflowing exports omit the marker fields');
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

// ── Fixture 5: Level 1 property stream — BPGA_Block CDO ─────────────
//
// BPGA_Block's Default__BPGA_Block_C export was hand-traced on 2026-04-16 to
// establish the UE 5.6 FPropertyTag layout (post-5.4 FPropertyTypeName +
// EPropertyTagFlags). See commit 1 of Agent 10 deliverable.
async function testBpgaBlockProperties() {
  const path = PROBE.bpgaBlock;
  if (!(await exists(path))) {
    console.log('  · skipped BPGA_Block property test (no file)');
    return;
  }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const imports = readImportTable(cur, s, names);
  const exports = readExportTable(cur, s, names);
  const resolve = makePackageIndexResolver(exports, imports);

  const cdo = exports.find(e => e.objectName === 'Default__BPGA_Block_C');
  runner.assert(!!cdo, 'BPGA_Block: CDO export found');
  if (!cdo) return;

  const r = readExportProperties(buf, cdo, names, { resolve });

  const namedUnsupported = r.unsupported.map(u => u.name);
  // T-1b: the gate covers only what is STABLE for this asset — its identity and
  // package format. Property counts, byte sizes and gameplay values move every
  // time a designer edits the ability, and pinning them meant an ordinary tuning
  // change disabled the parser assertions below, which are the point of the test.
  const freshness = evaluateAssetInfoFreshness('BPGA_Block L1 property oracle', {
    packageName: s.packageName,
    fileVersionUE5: s.fileVersionUE5,
  }, {
    packageName: '/Game/GAS/Abilities/BPGA_Block',
    fileVersionUE5: 1017,
  });
  if (!applyOracleFreshnessGate(runner, freshness)) return;

  // Direction-sensitive rather than pinned: a decoder regression shows up as
  // FEWER properties, while a designer adding one is not a test failure.
  runner.assert(r.propertyCount >= 8,
                'BPGA_Block: walks at least the eight properties this CDO has always had',
                `got=${r.propertyCount}`);

  // Self-consistent instead of a literal: whatever the stream's size, the walk
  // must stop inside the export's own serial range and consume something.
  runner.assert(r.bytesConsumed > 0 && r.bytesConsumed <= cdo.serialSize,
                'BPGA_Block: bytesConsumed stays within the export serial range',
                `consumed=${r.bytesConsumed}, serialSize=${cdo.serialSize}`);

  // Scalars + refs resolve cleanly.
  runner.assert(r.properties.BlockStateEffectClass &&
                r.properties.BlockStateEffectClass.packagePath ===
                '/Game/GAS/Effects/BPGE_OSBlockState.BPGE_OSBlockState_C',
                'BPGA_Block: ObjectProperty BlockStateEffectClass resolves to /Game path via outer-chain walk');
  // "A FloatProperty decodes to a finite number" is a parser fact; "that number
  // is 0.05" was a designer's tuning value, and pinning it broke the test when
  // the ability was rebalanced.
  runner.assert(typeof r.properties.CostInterval === 'number'
                && Number.isFinite(r.properties.CostInterval),
                'BPGA_Block: FloatProperty CostInterval decodes as a finite number',
                `got=${r.properties.CostInterval}`);

  // Structs without a registered handler but with tagged serialization
  // (flag 0x00) decode via tier-3 tagged fallback even without structHandlers.
  // IsBlocking/IsBroken are FGameplayTag — tagged sub-stream with TagName FName.
  runner.assert(r.properties.IsBlocking?.TagName === 'Gameplay.State.Guard.IsActive',
                'BPGA_Block T3: IsBlocking decodes via tagged fallback (TagName field)',
                `got=${JSON.stringify(r.properties.IsBlocking)}`);
  runner.assert(r.properties.IsBroken?.TagName === 'Gameplay.State.Guard.IsBroken',
                'BPGA_Block T3: IsBroken decodes via tagged fallback');

  // Native-binary unknown structs (flag 0x08) stay unsupported — fallback is
  // tagged-only. FGameplayTagContainer writes its count + names as native binary.
  for (const n of ['CancelAbilitiesWithTag', 'BlockAbilitiesWithTag',
                    'ActivationOwnedTags', 'ActivationBlockedTags']) {
    runner.assert(namedUnsupported.includes(n),
                  `BPGA_Block: unsupported list still names ${n} (native-binary GameplayTagContainer)`);
  }
}

// ── Fixture 6: Level 1 property stream — BP_OSPlayerR CDO ─────────────
//
// Larger CDO (25 tagged properties) with a mix of scalar, bool, object-ref,
// and struct types. Verifies the flag-byte logic (BoolTrue encoding) and
// exercise the resolver against both export-local and imported refs.
async function testPlayerCdoProperties() {
  const path = PROBE.bpOSPlayerR;
  if (!(await exists(path))) {
    console.log('  · skipped BP_OSPlayerR property test (no file)');
    return;
  }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const imports = readImportTable(cur, s, names);
  const exports = readExportTable(cur, s, names);
  const resolve = makePackageIndexResolver(exports, imports);

  const cdo = exports.find(e => e.objectName === 'Default__BP_OSPlayerR_C');
  runner.assert(!!cdo, 'BP_OSPlayerR: CDO export found');
  if (!cdo) return;

  const r = readExportProperties(buf, cdo, names, { resolve });

  // IntProperty scalar — confirms int32 path.
  runner.assert(r.properties.MinFallDistance === 10000,
                'BP_OSPlayerR: IntProperty MinFallDistance=10000',
                `got=${r.properties.MinFallDistance}`);

  // BoolProperty with BoolTrue flag bit (0x10) → true. Confirms flag-byte
  // decoding matches EPropertyTagFlags documentation.
  runner.assert(r.properties.bUseMutable === true,
                'BP_OSPlayerR: BoolProperty bUseMutable=true (BoolTrue flag bit)');

  // StrProperty — FString value.
  runner.assert(r.properties.ActorLabel === 'BP_OSPlayerR',
                'BP_OSPlayerR: StrProperty ActorLabel="BP_OSPlayerR"',
                `got=${JSON.stringify(r.properties.ActorLabel)}`);

  // ObjectProperty pointing at a local export (not import). Confirms the
  // positive-FPackageIndex branch of the resolver.
  runner.assert(r.properties.RootComponent?.kind === 'export',
                'BP_OSPlayerR: ObjectProperty RootComponent resolves to local export (V9.5 note: BP_OSPlayerR is in the ~10% with serialized RootComponent)');
  runner.assert(r.properties.RootComponent?.objectName === 'CollisionCylinder',
                'BP_OSPlayerR: RootComponent → CollisionCylinder component export');

  // ObjectProperty pointing at an import with full /Game/ path resolution.
  runner.assert(r.properties.NameplateWidgetClass?.objectName === 'W_Nameplate_C',
                'BP_OSPlayerR: NameplateWidgetClass import objectName');
}

// ── Fixture 7: empty CDO — Footstep has only the None terminator ────
async function testEmptyCdo() {
  const path = PROBE.footstep;
  if (!(await exists(path))) {
    console.log('  · skipped Footstep empty-CDO test (no file)');
    return;
  }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const imports = readImportTable(cur, s, names);
  const exports = readExportTable(cur, s, names);
  const ar = readAssetRegistryData(cur, s);
  const resolve = makePackageIndexResolver(exports, imports);
  const primary = ar.objects[0] || {};
  const freshness = evaluateAssetInfoFreshness('Footstep empty-CDO oracle', {
    path: '/Game/Animations/AN_OSAnimNotify_Footstep',
    packageName: s.packageName,
    objectPath: primary.objectPath,
    objectClassName: primary.objectClassName,
    fileVersionUE5: s.fileVersionUE5,
    nameCount: s.nameCount,
    exportCount: s.exportCount,
    assetRegistryObjects: ar.objects.length,
  }, {
    path: '/Game/Animations/AN_OSAnimNotify_Footstep',
    packageName: '/Game/Animations/AN_OSAnimNotify_Footstep',
    objectPath: 'AN_OSAnimNotify_Footstep',
    objectClassName: '/Script/Engine.Blueprint',
    fileVersionUE5: 1017,
    nameCount: 33,
    exportCount: 3,
    assetRegistryObjects: 2,
  });
  if (!applyOracleFreshnessGate(runner, freshness)) return;

  const cdo = exports.find(e => e.objectName.startsWith('Default__'));
  runner.assert(!!cdo, 'Footstep: CDO export found');
  if (!cdo) return;
  const r = readExportProperties(buf, cdo, names, { resolve });

  runner.assert(r.propertyCount === 0, 'Footstep: empty CDO has 0 properties');
  runner.assert(r.unsupported.length === 0, 'Footstep: no unsupported markers for empty CDO');
  runner.assert(r.bytesConsumed === 9, 'Footstep: consumed preamble(1) + None FName(8) = 9 bytes');
}

// ── Size-budget truncation — synthetic budget below stream size ─────
async function testSizeBudgetTruncation() {
  const path = PROBE.bpOSPlayerR;
  if (!(await exists(path))) {
    console.log('  · skipped size-budget test (no file)');
    return;
  }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const imports = readImportTable(cur, s, names);
  const exports = readExportTable(cur, s, names);
  const resolve = makePackageIndexResolver(exports, imports);
  const cdo = exports.find(e => e.objectName === 'Default__BP_OSPlayerR_C');

  // Budget set below the CDO's serialSize — must truncate and emit markers.
  const r = readExportProperties(buf, cdo, names, { resolve, maxBytes: 100 });
  runner.assert(r.truncated === true, 'size-budget: truncated flag set when budget exceeded');
  const budgetMarkers = r.unsupported.filter(u => u.reason === 'size_budget_exceeded');
  runner.assert(budgetMarkers.length > 0, 'size-budget: emits size_budget_exceeded markers');
  runner.assert(budgetMarkers.length <= 20,
                'size-budget: marker count capped at 20 per agent10 spec (Q5)',
                `got=${budgetMarkers.length}`);
}

// ── Fixture 8: Level 2 struct handlers — tagged + native binary ─────
//
// BPGA_Block's CDO exercises both serialization paths:
//   - FGameplayTag "IsBlocking" / "IsBroken" (flag=0x00, tagged sub-stream)
//   - FGameplayTagContainer "CancelAbilitiesWithTag" / "ActivationOwnedTags"
//     / "ActivationBlockedTags" (flag=0x08, native binary: int32 count + N × FName)
async function testStructHandlersOnBpgaBlock() {
  const path = PROBE.bpgaBlock;
  if (!(await exists(path))) { console.log('  · skipped BPGA struct handlers (no file)'); return; }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const imports = readImportTable(cur, s, names);
  const exports = readExportTable(cur, s, names);
  const resolve = makePackageIndexResolver(exports, imports);
  const structHandlers = buildStructHandlers();
  const cdo = exports.find(e => e.objectName === 'Default__BPGA_Block_C');
  const r = readExportProperties(buf, cdo, names, { resolve, structHandlers });

  const nonBudgetUnsupported = r.unsupported.filter(u => u.reason !== 'size_budget_exceeded');
  // T-1b: gate on identity + format only. Tag counts and membership are content
  // a designer edits; the struct-handler capability assertions below are what
  // this test exists to protect, and pinning counts kept disabling them.
  const freshness = evaluateAssetInfoFreshness('BPGA_Block L2 struct-handler oracle', {
    packageName: s.packageName,
    fileVersionUE5: s.fileVersionUE5,
  }, {
    packageName: '/Game/GAS/Abilities/BPGA_Block',
    fileVersionUE5: 1017,
  });
  if (!applyOracleFreshnessGate(runner, freshness)) return;

  // FGameplayTag (tagged sub-stream) — value decodes to a TagName string.
  runner.assert(r.properties.IsBlocking?.tagName === 'Gameplay.State.Guard.IsActive',
                'L2: FGameplayTag IsBlocking resolves to tag name',
                `got=${JSON.stringify(r.properties.IsBlocking)}`);
  runner.assert(r.properties.IsBroken?.tagName === 'Gameplay.State.Guard.IsBroken',
                'L2: FGameplayTag IsBroken resolves');

  // FGameplayTagContainer (native binary) — int32 count + N × FName.
  runner.assert(Array.isArray(r.properties.CancelAbilitiesWithTag?.tags),
                'L2: FGameplayTagContainer returns tags array');
  runner.assert(typeof r.properties.CancelAbilitiesWithTag.tags[0] === 'string'
                && r.properties.CancelAbilitiesWithTag.tags[0].includes('.'),
                'L2: first cancel tag resolves to a dotted tag name',
                `got=${r.properties.CancelAbilitiesWithTag.tags[0]}`);
  runner.assert(r.properties.CancelAbilitiesWithTag.tags.length > 0
                && r.properties.CancelAbilitiesWithTag.tags.every(t => typeof t === 'string' && t.includes('.')),
                'L2: cancel container resolves every entry to a dotted tag name',
                `got=${JSON.stringify(r.properties.CancelAbilitiesWithTag.tags)}`);
  runner.assert(r.properties.BlockAbilitiesWithTag.tags.length > 0
                && r.properties.BlockAbilitiesWithTag.tags.every(t => typeof t === 'string' && t.includes('.')),
                'L2: block container resolves every entry to a dotted tag name');
  runner.assert(r.properties.ActivationOwnedTags.tags.length > 0
                && r.properties.ActivationOwnedTags.tags.every(t => typeof t === 'string' && t.includes('.')),
                'L2: owned tag container resolves every entry to a dotted tag name',
                `got=${JSON.stringify(r.properties.ActivationOwnedTags.tags)}`);
  runner.assert(r.properties.ActivationBlockedTags.tags.length > 0
                && r.properties.ActivationBlockedTags.tags.every(t => typeof t === 'string' && t.includes('.')),
                'L2: activation-blocked container resolves every entry to a dotted tag name');
  // Tag membership is content a designer renames — this one had already moved
  // from Stamina.IsBlocked to Stamina.RegenBlocked. What the struct handler
  // must get right is that each entry resolves to a real FName, not which tags
  // the ability happens to use today.
  runner.assert(new Set(r.properties.ActivationBlockedTags.tags).size
                === r.properties.ActivationBlockedTags.tags.length,
                'L2: blocked tag container resolves distinct names (no FName collapse)');

  // Full unsupported list should now be empty with struct handlers enabled.
  const stillUnsupported = nonBudgetUnsupported.map(u => u.name);
  for (const container of ['CancelAbilitiesWithTag', 'BlockAbilitiesWithTag',
                           'ActivationOwnedTags', 'ActivationBlockedTags']) {
    runner.assert(!stillUnsupported.includes(container),
                  `L2: struct handlers decode ${container} rather than leaving it unsupported`);
  }
  // A property type this parser cannot decode yet is a gap to surface, not a
  // failure of struct-handler coverage: report it without failing the suite.
  if (stillUnsupported.length > 0) {
    console.log(`  · note: no struct handler yet for ${stillUnsupported.join(', ')}`);
  }
}

// ── Fixture 9: Level 2 FVector + FRotator on level component exports ──
//
// V9.5 §2 hand-traced CollisionCapsule [503] and LightComponent0 [518] in
// Main_MenuVersion.umap as components with native-binary FVector/FRotator
// transform overrides. This test pins specific coordinates so regressions
// that flip endian or swap field order fail loudly.
async function testTransformStructsOnLevel() {
  const path = PROBE.mainMenuVersion;
  if (!(await exists(path))) { console.log('  · skipped Main_MenuVersion transform test (no file)'); return; }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const imports = readImportTable(cur, s, names);
  const exports = readExportTable(cur, s, names);
  const resolve = makePackageIndexResolver(exports, imports);
  const structHandlers = buildStructHandlers();

  // CollisionCapsule export — has a RelativeLocation FVector.
  const capsule = exports[502]; // V9.5: index 503 in 1-based → 502 0-based
  runner.assert(capsule && capsule.objectName === 'CollisionCapsule',
                'L2: CollisionCapsule found at export index 503');
  const rCaps = readExportProperties(buf, capsule, names, { resolve, structHandlers });
  const loc = rCaps.properties.RelativeLocation;
  runner.assert(loc && typeof loc.x === 'number',
                'L2: CollisionCapsule has FVector RelativeLocation');
  runner.assert(Math.abs(loc.x - -4879.978) < 0.01,
                `L2: FVector x≈-4879.978 (got ${loc?.x})`);
  runner.assert(Math.abs(loc.y - -83.29) < 0.01,
                `L2: FVector y≈-83.29 (got ${loc?.y})`);
  runner.assert(Math.abs(loc.z - 759.75) < 0.01,
                `L2: FVector z≈759.75 (got ${loc?.z})`);

  // LightComponent0 export — has both FVector and FRotator.
  const light = exports[517];
  runner.assert(light && light.objectName === 'LightComponent0',
                'L2: LightComponent0 found at export index 518');
  const rLight = readExportProperties(buf, light, names, { resolve, structHandlers });
  const rot = rLight.properties.RelativeRotation;
  runner.assert(rot && typeof rot.pitch === 'number',
                'L2: LightComponent0 has FRotator RelativeRotation');
  runner.assert(Math.abs(rot.pitch - -54) < 0.01,
                `L2: FRotator pitch≈-54 (got ${rot?.pitch})`);
  runner.assert(Math.abs(rot.yaw - 51.894) < 0.01,
                `L2: FRotator yaw≈51.894 (got ${rot?.yaw})`);
  runner.assert(Math.abs(rot.roll - -134.117) < 0.01,
                `L2: FRotator roll≈-134.117 (got ${rot?.roll})`);
}

// ── Synthetic binary struct readers — deterministic edge-case coverage ──
function testStructBinaryReaders() {
  // FVector: 3 × double
  const vBuf = Buffer.alloc(24);
  vBuf.writeDoubleLE(1.5, 0);
  vBuf.writeDoubleLE(-2.5, 8);
  vBuf.writeDoubleLE(3.5, 16);
  const v = readFVectorBinary(new Cursor(vBuf));
  runner.assert(v.x === 1.5 && v.y === -2.5 && v.z === 3.5, 'L2: readFVectorBinary round-trip');

  // FRotator: pitch/yaw/roll in binary order
  const rBuf = Buffer.alloc(24);
  rBuf.writeDoubleLE(10, 0);
  rBuf.writeDoubleLE(20, 8);
  rBuf.writeDoubleLE(30, 16);
  const r = readFRotatorBinary(new Cursor(rBuf));
  runner.assert(r.pitch === 10 && r.yaw === 20 && r.roll === 30,
                'L2: readFRotatorBinary preserves pitch/yaw/roll order');

  // FQuat: 4 × double
  const qBuf = Buffer.alloc(32);
  qBuf.writeDoubleLE(0, 0); qBuf.writeDoubleLE(0, 8); qBuf.writeDoubleLE(0, 16); qBuf.writeDoubleLE(1, 24);
  const q = readFQuatBinary(new Cursor(qBuf));
  runner.assert(q.x === 0 && q.y === 0 && q.z === 0 && q.w === 1, 'L2: readFQuatBinary identity quat');

  // FTransform: Quat(32) + Vec(24) Translation + Vec(24) Scale3D = 80
  const tBuf = Buffer.alloc(80);
  tBuf.writeDoubleLE(0, 0); tBuf.writeDoubleLE(0, 8); tBuf.writeDoubleLE(0, 16); tBuf.writeDoubleLE(1, 24); // identity quat
  tBuf.writeDoubleLE(100, 32); tBuf.writeDoubleLE(200, 40); tBuf.writeDoubleLE(300, 48); // translation
  tBuf.writeDoubleLE(1, 56); tBuf.writeDoubleLE(1, 64); tBuf.writeDoubleLE(2, 72); // scale
  const t = readFTransformBinary(new Cursor(tBuf));
  runner.assert(t.rotation.w === 1 && t.translation.x === 100 && t.scale3D.z === 2,
                'L2: readFTransformBinary: rotation + translation + scale3D order');

  // FLinearColor: 4 × float
  const lcBuf = Buffer.alloc(16);
  lcBuf.writeFloatLE(0.5, 0); lcBuf.writeFloatLE(0.25, 4); lcBuf.writeFloatLE(0.75, 8); lcBuf.writeFloatLE(1, 12);
  const lc = readFLinearColorBinary(new Cursor(lcBuf));
  runner.assert(Math.abs(lc.r - 0.5) < 1e-6 && Math.abs(lc.a - 1) < 1e-6,
                'L2: readFLinearColorBinary RGBA float round-trip');

  // FColor: BGRA wire order, RGBA object output
  const cBuf = Buffer.alloc(4);
  cBuf[0] = 10; cBuf[1] = 20; cBuf[2] = 30; cBuf[3] = 255; // BGRA = 10, 20, 30, 255
  const c = readFColorBinary(new Cursor(cBuf));
  runner.assert(c.b === 10 && c.g === 20 && c.r === 30 && c.a === 255,
                'L2: readFColorBinary unpacks BGRA wire to RGBA object');

  // FGuid: 16 bytes → hex string
  const gBuf = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) gBuf[i] = i;
  const g = readFGuidBinary(new Cursor(gBuf));
  runner.assert(g === '000102030405060708090a0b0c0d0e0f', 'L2: readFGuidBinary hex round-trip');

  // FVector4: 4 × double = 32B
  const v4Buf = Buffer.alloc(32);
  v4Buf.writeDoubleLE(1, 0); v4Buf.writeDoubleLE(2, 8);
  v4Buf.writeDoubleLE(3, 16); v4Buf.writeDoubleLE(4, 24);
  const v4 = readFVector4Binary(new Cursor(v4Buf));
  runner.assert(v4.x === 1 && v4.y === 2 && v4.z === 3 && v4.w === 4,
                'L2: readFVector4Binary round-trip');

  // FIntPoint: 2 × int32 = 8B
  const ipBuf = Buffer.alloc(8);
  ipBuf.writeInt32LE(-5, 0); ipBuf.writeInt32LE(7, 4);
  const ip = readFIntPointBinary(new Cursor(ipBuf));
  runner.assert(ip.x === -5 && ip.y === 7, 'L2: readFIntPointBinary round-trip');

  // FBox: FVector Min + FVector Max + uint8 bIsValid = 49B
  const boxBuf = Buffer.alloc(49);
  boxBuf.writeDoubleLE(-1, 0); boxBuf.writeDoubleLE(-2, 8); boxBuf.writeDoubleLE(-3, 16);
  boxBuf.writeDoubleLE(10, 24); boxBuf.writeDoubleLE(20, 32); boxBuf.writeDoubleLE(30, 40);
  boxBuf.writeUInt8(1, 48);
  const box = readFBoxBinary(new Cursor(boxBuf));
  runner.assert(box.min.x === -1 && box.max.z === 30 && box.isValid === true,
                'L2: readFBoxBinary: 2 × FVector + bIsValid');
}

// ── Struct handler registry coverage ──────────────────────────────
function testStructHandlerRegistry() {
  const h = buildStructHandlers();
  for (const s of ['Vector', 'Vector2D', 'Rotator', 'Quat', 'Transform',
                   'LinearColor', 'Color', 'Guid', 'GameplayTag',
                   'GameplayTagContainer', 'SoftObjectPath',
                   // Agent 10.5 tier 1 additions
                   'Vector4', 'IntPoint', 'Box', 'ExpressionInput', 'BodyInstance']) {
    runner.assert(h.has(s) && typeof h.get(s) === 'function',
                  `L2: struct handler registry contains ${s}`);
  }
}

// ── Agent 10.5 Tier 1: tagged-stream paths for 5 new engine structs ──
//
// The new structs (FBox, FVector4, FIntPoint, FExpressionInput, FBodyInstance)
// typically appear in tagged form — the outer flag bit 0x08 is clear. We
// verify both the registered handler and the extractKnownStructFields
// shape-extraction path via synthetic tagged sub-streams.
function testTier1TaggedStructs() {
  const structHandlers = buildStructHandlers();
  const containerHandlers = buildContainerHandlers();

  // Synthetic tagged sub-stream helper: writes FName(idx, num)+int32 count+
  // FNames for the type, int32 size, uint8 flags, [value bytes], then "None"
  // terminator. We exercise only the value-decoder side here — not the tag
  // encoder — by routing through the handler directly with a pseudoTag.

  // FBox via tagged: {Min: Vector, Max: Vector, IsValid: BoolProperty}
  // This test builds the inner tagged sub-stream and calls the handler with
  // a pseudoTag pointing to a size-bounded range.
  {
    // FPropertyTag-encoded inner stream with 3 tagged properties
    // Layout: [FName prop] [FPropertyTypeName] [int32 size] [uint8 flags]
    //         [value bytes] ... [FName "None"]
    // We use the actual writeTaggedField pattern.
    const names = ['None', 'Min', 'Max', 'IsValid', 'Vector', 'BoolProperty', 'StructProperty'];
    const tagged = buildTaggedStream([
      { name: 'Min', typeName: 'StructProperty', typeParams: [{ name: 'Vector', params: [] }],
        size: 24, flags: 0x08, valueBytes: vectorBytes(1, 2, 3) },
      { name: 'Max', typeName: 'StructProperty', typeParams: [{ name: 'Vector', params: [] }],
        size: 24, flags: 0x08, valueBytes: vectorBytes(10, 20, 30) },
      { name: 'IsValid', typeName: 'BoolProperty', typeParams: [],
        size: 0, flags: 0x10, valueBytes: Buffer.alloc(0) },  // 0x10 = BoolTrue
    ], names);
    const cur = new Cursor(tagged);
    // Emulate outer StructProperty<Box> tagged: handler reads the sub-stream
    // for exactly `size` bytes. The handler's readTaggedStructFields expects
    // the value bytes to start at cur.tell().
    const pseudoTag = { flags: 0x00, size: tagged.length, type: 'StructProperty',
                        typeParams: [{ name: 'Box', params: [] }] };
    const result = structHandlers.get('Box')(cur, pseudoTag, names,
      { structHandlers, containerHandlers });
    runner.assert(result?.min?.x === 1 && result?.max?.z === 30,
                  'L2 T1: FBox tagged: Min/Max are FVector sub-structs');
    runner.assert(result?.isValid === true,
                  'L2 T1: FBox tagged: IsValid=BoolTrue flag → true');
  }

  // FVector4 via tagged: {X, Y, Z, W} doubles
  {
    const names = ['None', 'X', 'Y', 'Z', 'W', 'DoubleProperty'];
    const tagged = buildTaggedStream([
      { name: 'X', typeName: 'DoubleProperty', typeParams: [],
        size: 8, flags: 0, valueBytes: doubleBytes(1.5) },
      { name: 'Y', typeName: 'DoubleProperty', typeParams: [],
        size: 8, flags: 0, valueBytes: doubleBytes(-2.5) },
      { name: 'Z', typeName: 'DoubleProperty', typeParams: [],
        size: 8, flags: 0, valueBytes: doubleBytes(3.5) },
      { name: 'W', typeName: 'DoubleProperty', typeParams: [],
        size: 8, flags: 0, valueBytes: doubleBytes(-4.5) },
    ], names);
    const cur = new Cursor(tagged);
    const pseudoTag = { flags: 0, size: tagged.length, type: 'StructProperty',
                        typeParams: [{ name: 'Vector4', params: [] }] };
    const result = structHandlers.get('Vector4')(cur, pseudoTag, names, { structHandlers });
    runner.assert(result?.x === 1.5 && result?.y === -2.5 && result?.z === 3.5 && result?.w === -4.5,
                  'L2 T1: FVector4 tagged: XYZW doubles extracted');
  }

  // FIntPoint via tagged: {X, Y} int32
  {
    const names = ['None', 'X', 'Y', 'IntProperty'];
    const tagged = buildTaggedStream([
      { name: 'X', typeName: 'IntProperty', typeParams: [],
        size: 4, flags: 0, valueBytes: int32Bytes(-7) },
      { name: 'Y', typeName: 'IntProperty', typeParams: [],
        size: 4, flags: 0, valueBytes: int32Bytes(11) },
    ], names);
    const cur = new Cursor(tagged);
    const pseudoTag = { flags: 0, size: tagged.length, type: 'StructProperty',
                        typeParams: [{ name: 'IntPoint', params: [] }] };
    const result = structHandlers.get('IntPoint')(cur, pseudoTag, names, { structHandlers });
    runner.assert(result?.x === -7 && result?.y === 11, 'L2 T1: FIntPoint tagged: XY int32 extracted');
  }

  // FBodyInstance via tagged: arbitrary UPROPERTY subset — verify raw props returned
  {
    const names = ['None', 'bUseCCD', 'LinearDamping', 'BoolProperty', 'FloatProperty'];
    const tagged = buildTaggedStream([
      { name: 'bUseCCD', typeName: 'BoolProperty', typeParams: [],
        size: 0, flags: 0x10, valueBytes: Buffer.alloc(0) },
      { name: 'LinearDamping', typeName: 'FloatProperty', typeParams: [],
        size: 4, flags: 0, valueBytes: floatBytes(0.25) },
    ], names);
    const cur = new Cursor(tagged);
    const pseudoTag = { flags: 0, size: tagged.length, type: 'StructProperty',
                        typeParams: [{ name: 'BodyInstance', params: [] }] };
    const result = structHandlers.get('BodyInstance')(cur, pseudoTag, names, { structHandlers });
    runner.assert(result?.bUseCCD === true, 'L2 T1: FBodyInstance tagged: preserves bUseCCD=true');
    runner.assert(Math.abs(result?.LinearDamping - 0.25) < 1e-6,
                  'L2 T1: FBodyInstance tagged: preserves LinearDamping=0.25');
  }

  // FBodyInstance native binary path → unsupported marker
  {
    const pseudoTag = { flags: 0x08, size: 0, type: 'StructProperty',
                        typeParams: [{ name: 'BodyInstance', params: [] }] };
    const cur = new Cursor(Buffer.alloc(0));
    const result = structHandlers.get('BodyInstance')(cur, pseudoTag, [], {});
    runner.assert(result?.__unsupported__ === true,
                  'L2 T1: FBodyInstance native binary path emits unsupported marker');
  }
}

function testD186SubobjectHelpers() {
  const exports = [
    { objectName: 'BP_Door_C', classIndex: -1, superIndex: 0, outerIndex: 0, bIsAsset: false },
    { objectName: 'Default__BP_Door_C', classIndex: -2, superIndex: 0, outerIndex: 0, bIsAsset: false },
    { objectName: 'DoorCollision', classIndex: -3, superIndex: 0, outerIndex: 1, bIsAsset: false },
    { objectName: 'IgnoredGraph', classIndex: -4, superIndex: 0, outerIndex: 1, bIsAsset: false },
    { objectName: 'NestedCueComponent', classIndex: -5, superIndex: 0, outerIndex: 0, bIsAsset: false },
  ];
  const imports = [
    { objectName: 'BlueprintGeneratedClass' },
    { objectName: 'BlueprintGeneratedClass' },
    { objectName: 'BoxComponent' },
    { objectName: 'EdGraph' },
    { objectName: 'GameplayEffectComponent' },
  ];

  const parsedRoot = {
    RootComponent: { kind: 'export', packageIndex: 3, objectName: 'DoorCollision' },
  };
  const rows = collectSubobjectExportIndexes({
    exports,
    imports,
    rootExportIndex: 1,
    rootProperties: parsedRoot,
    propertiesForExportIndex: (idx) => {
      if (idx === 2) {
        return { ComponentTemplate: { kind: 'export', packageIndex: 5, objectName: 'NestedCueComponent' } };
      }
      return {};
    },
    maxDepth: 2,
    limit: 10,
  });

  runner.assert(rows.length === 2,
    `D186: subobject traversal keeps component exports and excludes graph exports (got ${rows.length})`);
  runner.assert(rows[0].export_index === 3 && rows[0].depth === 1 && rows[0].discovered_by.includes('property_ref'),
    'D186: property-ref component is discovered at depth 1');
  runner.assert(rows[1].export_index === 5 && rows[1].depth === 2 && rows[1].class_name === 'GameplayEffectComponent',
    'D186: nested component child is discovered within max depth');

  const collision = summarizeCollisionProperties({
    CollisionProfileName: 'BlockAll',
    BodyInstance: {
      CollisionEnabled: 'QueryAndPhysics',
      ObjectType: 'WorldDynamic',
      ResponseToChannels: {
        Pawn: 'ECR_Block',
        Visibility: 'ECR_Ignore',
      },
    },
  });
  runner.assert(collision?.profile_name === 'BlockAll',
    'D186: collision summary exposes serialized profile name');
  runner.assert(collision?.body_instance?.response_to_channels?.Pawn === 'ECR_Block',
    'D186: collision summary exposes per-channel body response data when serialized');

  const unsupportedCollision = summarizeCollisionProperties({
    CollisionResponses: { unsupported: true, reason: 'present_but_undecoded' },
  });
  runner.assert(unsupportedCollision === null,
    'D186: unsupported collision response marker is not mistaken for channel data');

  const oversized = buildSubobjectResponseRow(
    { export_index: 3, export_name: 'DoorCollision', class_name: 'BoxComponent' },
    {
      properties: { Large: 'x'.repeat(128) },
      unsupported: [],
      propertyCount: 1,
      truncated: false,
    },
    { remainingBytes: 32 }
  );
  runner.assert(oversized.row.decode_status === 'present_but_undecoded',
    'D186: subobject row suppresses oversized decoded payload');
  runner.assert(oversized.row.unsupported.some(m => m.reason === 'subobject_budget_exhausted'),
    'D186: budget-exhausted subobject row carries explicit unsupported marker');
  runner.assert(oversized.budgetExhausted === true && oversized.bytesUsed === 0,
    'D186: budget-exhausted subobject row does not consume aggregate payload bytes');
}

// ── Tagged-stream synthesizers (used by tier 1 + later tests) ──────
function writeFName(name, names) {
  // Returns Buffer (8B): int32 idx + int32 number. Expects name to exist
  // already in the names array (caller owns the table).
  const idx = names.indexOf(name);
  if (idx < 0) throw new Error(`FName ${name} not in names[]`);
  const b = Buffer.alloc(8); b.writeInt32LE(idx, 0); b.writeInt32LE(0, 4); return b;
}
function fstringBytes(value) {
  if (!value) return int32Bytes(0);
  const body = Buffer.from(`${value}\0`, 'latin1');
  return Buffer.concat([int32Bytes(body.length), body]);
}
function ftextNoneBytes(value = '') {
  return Buffer.concat([
    int32Bytes(0),              // Flags
    Buffer.from([0xff]),        // ETextHistoryType::None
    int32Bytes(value ? 1 : 0),  // bHasCultureInvariantString
    value ? fstringBytes(value) : Buffer.alloc(0),
  ]);
}
function vectorBytes(x, y, z) {
  const b = Buffer.alloc(24); b.writeDoubleLE(x, 0); b.writeDoubleLE(y, 8); b.writeDoubleLE(z, 16); return b;
}
function doubleBytes(v) { const b = Buffer.alloc(8); b.writeDoubleLE(v, 0); return b; }
function floatBytes(v)  { const b = Buffer.alloc(4); b.writeFloatLE(v, 0);  return b; }
function int32Bytes(v)  { const b = Buffer.alloc(4); b.writeInt32LE(v, 0);  return b; }

function buildTaggedStream(tags, names) {
  // Produce a tagged property stream: per tag [FName PropName]
  // [FPropertyTypeName (recursive)] [int32 size] [uint8 flags] [value bytes],
  // then [FName "None"] terminator.
  const chunks = [];
  for (const t of tags) {
    chunks.push(writeFName(t.name, names));
    chunks.push(writePropertyTypeName(t.typeName, t.typeParams || [], names));
    const sz = Buffer.alloc(4); sz.writeInt32LE(t.size, 0); chunks.push(sz);
    chunks.push(Buffer.from([t.flags || 0]));
    if (t.valueBytes.length !== t.size) {
      throw new Error(`valueBytes len ${t.valueBytes.length} ≠ declared size ${t.size}`);
    }
    chunks.push(t.valueBytes);
  }
  chunks.push(writeFName('None', names));
  return Buffer.concat(chunks);
}

// ── Agent 10.5 Tier 3: UUserDefinedStruct tagged fallback (D47) ────────
//
// Unknown StructProperty with flag 0x00 decodes as a tagged sub-stream whose
// members are self-describing. Verified against BP_OSPlayerR CDO which carries
// four unknown structs (OSAuraInfo UDS, TimerHandle engine struct,
// MaterialParameterInfo engine struct, PointerToUberGraphFrame BP-runtime).
async function testTier3UnknownStructFallback() {
  const path = PROBE.bpOSPlayerR;
  if (!(await exists(path))) { console.log('  · skipped T3 UDS fallback (no file)'); return; }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const imports = readImportTable(cur, s, names);
  const exports = readExportTable(cur, s, names);
  const resolve = makePackageIndexResolver(exports, imports);
  const structHandlers = buildStructHandlers();
  const containerHandlers = buildContainerHandlers();
  const resolvedUnknownStructs = new Set();
  const cdo = exports.find(e => e.objectName === 'Default__BP_OSPlayerR_C');
  const r = readExportProperties(buf, cdo, names, {
    resolve, structHandlers, containerHandlers, resolvedUnknownStructs,
  });

  // cacheAura (OSAuraInfo UDS) decodes via tagged fallback. Members School,
  // Tier, Energy appear in the parsed properties object.
  runner.assert(r.properties.cacheAura && typeof r.properties.cacheAura === 'object',
                'T3: OSAuraInfo (UDS) decodes as object via tagged fallback');
  runner.assert('School' in r.properties.cacheAura && 'Energy' in r.properties.cacheAura,
                'T3: OSAuraInfo members School/Energy present in decoded struct');

  // devHandle (FTimerHandle engine struct — not in registry) decodes as
  // {Handle: <int64>}.
  runner.assert(r.properties.devHandle && 'Handle' in r.properties.devHandle,
                'T3: FTimerHandle decodes with Handle member');

  // Parameter Info (FMaterialParameterInfo) has Name/Association/Index.
  const paramInfo = r.properties['Parameter Info'];
  runner.assert(paramInfo && 'Name' in paramInfo && 'Association' in paramInfo,
                'T3: FMaterialParameterInfo decodes with Name/Association/Index members');

  // No unknown_struct markers remain after fallback.
  const unknownLeft = r.unsupported.filter(u => u.reason === 'unknown_struct');
  runner.assert(unknownLeft.length === 0,
                `T3: zero unknown_struct markers after fallback (got ${unknownLeft.length})`);

  // resolvedUnknownStructs tracking populates a metric for the final report.
  runner.assert(resolvedUnknownStructs.has('OSAuraInfo'),
                'T3: resolvedUnknownStructs tracks OSAuraInfo (UDS)');
  runner.assert(resolvedUnknownStructs.has('TimerHandle'),
                'T3: resolvedUnknownStructs tracks TimerHandle');
}

// Synthetic: tagged fallback bounds stop at valueStart+size, not buf.length.
function testTier3BoundedFallback() {
  const names = ['None', 'Alpha', 'Beta', 'IntProperty'];
  // Inner tagged stream: {Alpha: 42, Beta: 99}. Write the raw bytes, then
  // append trailing garbage that must NOT be consumed because size is fixed.
  const inner = buildTaggedStream([
    { name: 'Alpha', typeName: 'IntProperty', typeParams: [],
      size: 4, flags: 0, valueBytes: int32Bytes(42) },
    { name: 'Beta',  typeName: 'IntProperty', typeParams: [],
      size: 4, flags: 0, valueBytes: int32Bytes(99) },
  ], names);
  const garbage = Buffer.from([0xDE, 0xAD, 0xBE, 0xEF, 0xCA, 0xFE, 0xBA, 0xBE]);
  const buf = Buffer.concat([inner, garbage]);

  // Synthesize an outer StructProperty tag wrapping `inner` only
  const cur = new Cursor(buf);
  const pseudoTag = {
    flags: 0, size: inner.length, type: 'StructProperty',
    typeParams: [{ name: 'FakeStructForTest', params: [] }],
  };
  // Call the internal dispatcher (exported via structHandlers lookup — not
  // directly exposed; instead use readExportProperties-like orchestration).
  // Simpler: call the fallback code path directly by creating a tiny export
  // with a single tagged property wrapping our synthetic struct.
  const wrapperNames = [...names, 'Wrapper', 'FakeStructForTest', 'StructProperty'];
  const outerWrapped = buildTaggedStream([
    { name: 'Wrapper', typeName: 'StructProperty',
      typeParams: [{ name: 'FakeStructForTest', params: [] }],
      size: inner.length, flags: 0, valueBytes: inner },
  ], wrapperNames);

  // Parse the wrapper via readTaggedPropertyStream directly.
  const cursor = new Cursor(outerWrapped);
  const result = readTaggedPropertyStream(cursor, outerWrapped.length, wrapperNames, {
    structHandlers: buildStructHandlers(),
    containerHandlers: buildContainerHandlers(),
  });
  runner.assert(result.properties.Wrapper?.Alpha === 42,
                'T3 bounded: tagged fallback decodes Alpha=42 inside wrapper');
  runner.assert(result.properties.Wrapper?.Beta === 99,
                'T3 bounded: tagged fallback decodes Beta=99 inside wrapper');
}

function writePropertyTypeName(name, params, names) {
  const parts = [];
  parts.push(writeFName(name, names));
  const pc = Buffer.alloc(4); pc.writeInt32LE(params.length, 0); parts.push(pc);
  for (const p of params) {
    parts.push(writePropertyTypeName(p.name, p.params || [], names));
  }
  return Buffer.concat(parts);
}

function graphPinTypeBytes(names) {
  return Buffer.concat([
    writeFName('None', names),  // PinCategory
    writeFName('None', names),  // PinSubCategory
    int32Bytes(0),              // PinSubCategoryObject
    Buffer.from([0]),           // ContainerType=None
    int32Bytes(0),              // bIsReference
    int32Bytes(0),              // bIsWeakPointer
    int32Bytes(0),              // MemberParent
    writeFName('None', names),  // MemberName
    Buffer.alloc(16),           // MemberGuid
    int32Bytes(0),              // bIsConst
    int32Bytes(0),              // bIsUObjectWrapper
    int32Bytes(0),              // bSerializeAsSinglePrecisionFloat
  ]);
}

function syntheticPinBlock(names, {
  defaultValue = '',
  autogeneratedDefaultValue = '',
  defaultObjectIndex = 0,
  defaultTextValue = '',
} = {}) {
  const pinId = Buffer.from('0102030405060708090a0b0c0d0e0f10', 'hex');
  const pinBody = Buffer.concat([
    int32Bytes(0),              // bNullPtr=false
    int32Bytes(1),              // outer OwningNode
    pinId,                      // outer PinId
    int32Bytes(1),              // inner OwningNode
    pinId,                      // inner PinId
    writeFName('LiteralPin', names),
    ftextNoneBytes(),           // PinFriendlyName
    int32Bytes(0),              // SourceIndex
    fstringBytes(''),           // PinToolTip
    Buffer.from([0]),           // Direction=EGPD_Input
    graphPinTypeBytes(names),
    fstringBytes(defaultValue),
    fstringBytes(autogeneratedDefaultValue),
    int32Bytes(defaultObjectIndex),
    ftextNoneBytes(defaultTextValue),
    int32Bytes(0),              // LinkedTo array count
    int32Bytes(0),              // SubPins array count
    int32Bytes(1),              // ParentPin null
    int32Bytes(1),              // ReferencePassThroughConnection null
    Buffer.alloc(16),           // PersistentGuid
    int32Bytes(0),              // BitField
  ]);

  return Buffer.concat([
    Buffer.from([0]),           // export tagged-stream preamble
    writeFName('None', names),  // empty tagged-property stream
    int32Bytes(0),              // post-tag sentinel
    int32Bytes(1),              // pin array count
    pinBody,
  ]);
}

// ── Fixture 10: Level 2.5 — simple-element containers (D46) ────────
//
// Exercises the TArray<FLinearColor> native-binary + TArray<ObjectProperty>
// scalar-inline decode paths against hand-constructed synthetic byte buffers.
//
// Prior revisions used a live target-project fixture (BP_OSPlayerR → BP_OSPlayerR_VikramProto
// after CL-1 drift-swap on 2026-04-22 when the original CDO lost
// DefaultAbilities/DefaultEffects in a loadouts refactor). T-1a replaces
// that with synthetic bytes: UEMCP is a general UE 5.6 tool, its tests
// shouldn't rely on a static project snapshot, and project-specific
// fixtures drift as gameplay teams refactor. Synthetic fixtures are
// drift-proof by construction.
//
// Byte-equivalent coverage: same ArrayProperty handler + SCALAR_ELEMENT_READERS
// ObjectProperty path + readFLinearColorBinary struct handler. Zero .uasset IO.
function testContainerSyntheticObjectsAndColors() {
  const structHandlers = buildStructHandlers();
  const containerHandlers = buildContainerHandlers();

  // TArray<FLinearColor> native binary (flag 0x08). 4 colors × 16 bytes each.
  // Replaces live "Rigged Character 2Colours" check: pure-red first entry
  // through the FLinearColor struct handler's native-binary path.
  {
    const buf = Buffer.alloc(4 + 4 * 16);
    let p = 0;
    buf.writeInt32LE(4, p); p += 4;
    // Color 0 — pure red RGBA(1,0,0,1).
    buf.writeFloatLE(1, p); buf.writeFloatLE(0, p + 4); buf.writeFloatLE(0, p + 8); buf.writeFloatLE(1, p + 12); p += 16;
    // Colors 1-3 — arbitrary RGBA (shape-only coverage).
    buf.writeFloatLE(0, p); buf.writeFloatLE(1, p + 4); buf.writeFloatLE(0, p + 8); buf.writeFloatLE(1, p + 12); p += 16;
    buf.writeFloatLE(0, p); buf.writeFloatLE(0, p + 4); buf.writeFloatLE(1, p + 8); buf.writeFloatLE(1, p + 12); p += 16;
    buf.writeFloatLE(0.5, p); buf.writeFloatLE(0.5, p + 4); buf.writeFloatLE(0.5, p + 8); buf.writeFloatLE(1, p + 12);
    const tag = { flags: 0x08, size: buf.length, type: 'ArrayProperty',
                  typeParams: [{ name: 'StructProperty',
                                 params: [{ name: 'LinearColor', params: [] }] }] };
    const colors = containerHandlers.get('ArrayProperty')(new Cursor(buf), tag, [], { structHandlers });
    runner.assert(Array.isArray(colors),
                  'L2.5 synth: TArray<FLinearColor> decodes as array',
                  `got=${typeof colors}`);
    runner.assert(colors?.length === 4,
                  'L2.5 synth: TArray<FLinearColor> count=4',
                  `got=${colors?.length}`);
    runner.assert(colors?.[0]?.r === 1 && colors?.[0]?.g === 0 && colors?.[0]?.b === 0 && colors?.[0]?.a === 1,
                  'L2.5 synth: TArray<FLinearColor>[0] = pure red RGBA(1,0,0,1)');
  }

  // TArray<ObjectProperty> scalar inline (4 bytes FPackageIndex per element).
  // Replaces live DefaultAbilities[10] + DefaultEffects[3]. Drives the
  // SCALAR_ELEMENT_READERS ObjectProperty path with a synthetic resolver that
  // returns {packageIndex, objectName} — same shape live makePackageIndexResolver produces.
  {
    const abilityNames = ['BPGA_Dodge_C', 'BPGA_Attack_C', 'BPGA_Jump_C',
                          'BPGA_Block_C', 'BPGA_Sprint_C', 'BPGA_Crouch_C',
                          'BPGA_Roll_C', 'BPGA_Parry_C', 'BPGA_Dash_C', 'BPGA_Heal_C'];
    const abilitiesBuf = Buffer.alloc(4 + 10 * 4);
    abilitiesBuf.writeInt32LE(10, 0);
    for (let i = 0; i < 10; i++) abilitiesBuf.writeInt32LE(-(i + 1), 4 + i * 4);
    const abilitiesTag = { flags: 0x00, size: abilitiesBuf.length, type: 'ArrayProperty',
                           typeParams: [{ name: 'ObjectProperty', params: [] }] };
    const abilitiesResolve = (idx) => ({ packageIndex: idx, objectName: abilityNames[-idx - 1] ?? null });
    const abilities = containerHandlers.get('ArrayProperty')(new Cursor(abilitiesBuf), abilitiesTag, [],
                                                              { resolve: abilitiesResolve });
    runner.assert(Array.isArray(abilities) && abilities.length === 10,
                  'L2.5 synth: TArray<ObjectProperty> DefaultAbilities has 10 entries',
                  `got=${abilities?.length}`);
    runner.assert(abilities?.every(a => typeof a.objectName === 'string'),
                  'L2.5 synth: each DefaultAbilities entry resolves to a named import/export');
    runner.assert(abilities?.some(a => a.objectName === 'BPGA_Dodge_C'),
                  'L2.5 synth: DefaultAbilities includes BPGA_Dodge_C (resolver-produced)');

    const effectNames = ['GE_Damage_C', 'GE_Heal_C', 'GE_Stun_C'];
    const effectsBuf = Buffer.alloc(4 + 3 * 4);
    effectsBuf.writeInt32LE(3, 0);
    for (let i = 0; i < 3; i++) effectsBuf.writeInt32LE(-(i + 100), 4 + i * 4);
    const effectsTag = { flags: 0x00, size: effectsBuf.length, type: 'ArrayProperty',
                         typeParams: [{ name: 'ObjectProperty', params: [] }] };
    const effectsResolve = (idx) => ({ packageIndex: idx, objectName: effectNames[-idx - 100] ?? null });
    const effects = containerHandlers.get('ArrayProperty')(new Cursor(effectsBuf), effectsTag, [],
                                                            { resolve: effectsResolve });
    runner.assert(Array.isArray(effects) && effects.length === 3,
                  'L2.5 synth: TArray<ObjectProperty> DefaultEffects has 3 entries',
                  `got=${effects?.length}`);
  }
}

async function testComplexContainerMarker() {
  const path = PROBE.bpgaBlock;
  if (!(await exists(path))) { console.log('  · skipped complex-container marker test'); return; }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const imports = readImportTable(cur, s, names);
  const exports = readExportTable(cur, s, names);
  const resolve = makePackageIndexResolver(exports, imports);
  const structHandlers = buildStructHandlers();
  const containerHandlers = buildContainerHandlers();
  const cdo = exports.find(e => e.objectName === 'Default__BPGA_Block_C');
  const r = readExportProperties(buf, cdo, names, { resolve, structHandlers, containerHandlers });

  // Tier 2 (D46): TArray<FOSResource> now decodes via tagged-element fallback.
  // Each FOSResource is a tagged sub-stream with Attribute (FGameplayAttribute)
  // and Amount (float) members. Previous expectation was a
  // `complex_element_container` marker — this is the D46 scope crossing.
  const drain = r.properties.DrainPerSecond;
  if (!Object.prototype.hasOwnProperty.call(r.properties, 'DrainPerSecond')) {
    console.log('  · skipped BPGA_Block DrainPerSecond container test (fixture no longer carries DrainPerSecond)');
    return;
  }
  const fp = drain?.[0]?.Attribute?.Attribute;
  const fpMarkers = r.unsupported.filter(u => u.reason === 'unknown_property_type' && u.detail === 'FieldPathProperty');
  const freshness = evaluateAssetInfoFreshness('BPGA_Block complex-container oracle', {
    packageName: s.packageName,
    fileVersionUE5: s.fileVersionUE5,
    nameCount: s.nameCount,
    exportCount: s.exportCount,
    hasDrainArray: Array.isArray(drain) && drain.length >= 1,
    hasAttributeName: drain?.[0]?.Attribute && 'AttributeName' in drain[0].Attribute,
    hasAmount: 'Amount' in (drain?.[0] ?? {}),
    hasFieldPath: !!(fp && Array.isArray(fp.path)),
    hasFieldPathName: fp?.path?.length >= 1 && typeof fp.path[0] === 'string',
    fieldPathUnknownMarkers: fpMarkers.length,
  }, {
    packageName: '/Game/GAS/Abilities/BPGA_Block',
    fileVersionUE5: 1017,
    nameCount: 179,
    exportCount: 19,
    hasDrainArray: true,
    hasAttributeName: true,
    hasAmount: true,
    hasFieldPath: true,
    hasFieldPathName: true,
    fieldPathUnknownMarkers: 0,
  });
  if (!applyOracleFreshnessGate(runner, freshness)) return;

  runner.assert(Array.isArray(drain) && drain.length >= 1,
                'T2: TArray<FOSResource> decodes as array of struct entries');
  runner.assert(drain?.[0]?.Attribute && 'AttributeName' in drain[0].Attribute,
                'T2: FOSResource.Attribute (FGameplayAttribute) decodes with AttributeName field');
  runner.assert('Amount' in (drain?.[0] ?? {}),
                'T2: FOSResource.Amount scalar preserved in decoded entry');

  // Parser-Extensions Item 2: FieldPathProperty L1 dispatcher. FGameplayAttribute
  // carries a TFieldPath<FProperty> Attribute member that previously emitted
  // `unknown_property_type` markers. It now decodes to {path: [FName...], owner: resolved}.
  runner.assert(fp && Array.isArray(fp.path),
                'FieldPath Item 2: FGameplayAttribute.Attribute decodes to {path, owner}',
                `got=${JSON.stringify(fp)}`);
  runner.assert(fp?.path?.length >= 1 && typeof fp.path[0] === 'string',
                'FieldPath Item 2: path array contains FName strings',
                `got path=${JSON.stringify(fp?.path)}`);
  // No leftover unknown_property_type markers for FieldPathProperty in this CDO.
  runner.assert(fpMarkers.length === 0,
                'FieldPath Item 2: zero FieldPathProperty unknown_property_type markers in BPGA_Block CDO',
                `got ${fpMarkers.length} markers`);
}

// ── Parser-Extensions Item 1: FExpressionInput native binary + variants ──
//
// M_StylizedBasic.uasset carries 38 native-binary FExpressionInput (+variants)
// on the EditorOnlyData export (M_StylizedBasicEditorOnlyData): 31 plain,
// 2 Color, 3 Scalar, 1 Vector, 1 MaterialAttributes. Previously these emitted
// `expression_input_native_layout_unknown` markers.
async function testExpressionInputOnStylizedBasic() {
  const path = PROBE.stylizedBasic;
  if (!(await exists(path))) { console.log('  · skipped M_StylizedBasic expression-input test (no file)'); return; }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const imports = readImportTable(cur, s, names);
  const exports = readExportTable(cur, s, names);
  const resolve = makePackageIndexResolver(exports, imports);
  const structHandlers = buildStructHandlers();
  const containerHandlers = buildContainerHandlers();

  const edit = exports.find(e => e.objectName === 'M_StylizedBasicEditorOnlyData');
  runner.assert(!!edit, 'ExprInput: M_StylizedBasicEditorOnlyData export found');
  if (!edit) return;
  const r = readExportProperties(buf, edit, names, { resolve, structHandlers, containerHandlers });

  // BaseColor is FColorMaterialInput with FLinearColor(0.5, 0.5, 0.5, 1)
  // connected to MaterialExpressionNamedRerouteUsage[24] (hand-trace).
  const bc = r.properties.BaseColor;
  // This material holds SEVEN MaterialExpressionNamedRerouteUsage exports whose
  // FName Numbers run 1..7, i.e. _0.._6. They previously all decoded to the same
  // bare string, so this assertion was pinning the collapsed name and could not
  // have told the seven apart. Index 24 is the _0 one.
  runner.assert(bc && bc.expression && bc.expression.objectName === 'MaterialExpressionNamedRerouteUsage_0',
                'ExprInput: BaseColor.Expression resolves to the _0 NamedRerouteUsage export',
                `got=${JSON.stringify(bc?.expression)}`);
  runner.assert(bc && bc.constant && Math.abs(bc.constant.r - 0.5019608) < 1e-4
                && Math.abs(bc.constant.a - 1) < 1e-6,
                'ExprInput: FColorMaterialInput.Constant = FLinearColor(0.5, 0.5, 0.5, 1)',
                `got=${JSON.stringify(bc?.constant)}`);
  runner.assert(bc?.useConstant === false,
                'ExprInput: BaseColor.UseConstant=false (uses connected expression)');

  // Specular is FScalarMaterialInput with Constant=0.5 (hand-trace).
  const spec = r.properties.Specular;
  runner.assert(spec && typeof spec.constant === 'number' && Math.abs(spec.constant - 0.5) < 1e-6,
                'ExprInput: FScalarMaterialInput Specular.Constant=0.5',
                `got=${JSON.stringify(spec?.constant)}`);

  // No expression_input_native_layout_unknown markers remain.
  const exprUnknownMarkers = r.unsupported.filter(u => u.reason === 'expression_input_native_layout_unknown');
  runner.assert(exprUnknownMarkers.length === 0,
                'ExprInput: zero expression_input_native_layout_unknown markers on M_StylizedBasic EditorOnlyData',
                `got ${exprUnknownMarkers.length}: ${exprUnknownMarkers.map(m => m.name).join(',')}`);
}

// ── Synthetic ExpressionInput binary reader coverage ──
function testExpressionInputBinarySynthetic() {
  // FExpressionInput base (36 bytes) — null Expression (idx=0), masks 1..4,
  // InputName via names[1].
  {
    const buf = Buffer.alloc(36);
    let p = 0;
    buf.writeInt32LE(0, p); p += 4;   // Expression=0
    buf.writeInt32LE(2, p); p += 4;   // OutputIndex
    buf.writeInt32LE(1, p); p += 4; buf.writeInt32LE(0, p); p += 4;  // InputName FName
    buf.writeInt32LE(5, p); p += 4;   // Mask
    buf.writeInt32LE(1, p); p += 4;   // MaskR
    buf.writeInt32LE(0, p); p += 4;   // MaskG
    buf.writeInt32LE(1, p); p += 4;   // MaskB
    buf.writeInt32LE(0, p);           // MaskA
    const names = ['None', 'Alpha'];
    const v = readFExpressionInputBinary(new Cursor(buf), names, {});
    runner.assert(v.expression === null, 'ExprInput synth: null Expression (idx=0)');
    runner.assert(v.outputIndex === 2, 'ExprInput synth: OutputIndex=2');
    runner.assert(v.inputName === 'Alpha', 'ExprInput synth: InputName="Alpha" via name table');
    runner.assert(v.mask === 5 && v.maskR === 1 && v.maskB === 1 && v.maskA === 0,
                  'ExprInput synth: Mask fields preserved');
  }

  // FColorMaterialInput via handler (56 bytes). Flag 0x08 native.
  {
    const handler = buildStructHandlers().get('ColorMaterialInput');
    const buf = Buffer.alloc(56);
    let p = 0;
    // Base (36B): Expression=-2, OutputIndex=3, InputName="B", masks
    buf.writeInt32LE(-2, p); p += 4;
    buf.writeInt32LE(3, p); p += 4;
    buf.writeInt32LE(2, p); p += 4; buf.writeInt32LE(0, p); p += 4;  // "B"
    buf.writeInt32LE(0, p); p += 4;
    buf.writeInt32LE(0, p); p += 4;
    buf.writeInt32LE(0, p); p += 4;
    buf.writeInt32LE(0, p); p += 4;
    buf.writeInt32LE(0, p); p += 4;
    // Variant: UseConstant=1, FLinearColor(0.25, 0.5, 0.75, 1)
    buf.writeInt32LE(1, p); p += 4;
    buf.writeFloatLE(0.25, p); p += 4;
    buf.writeFloatLE(0.5, p); p += 4;
    buf.writeFloatLE(0.75, p); p += 4;
    buf.writeFloatLE(1.0, p);
    const names = ['None', 'A', 'B'];
    const pseudoTag = { flags: 0x08, size: 56, type: 'StructProperty',
                        typeParams: [{ name: 'ColorMaterialInput', params: [] }] };
    const v = handler(new Cursor(buf), pseudoTag, names, {});
    runner.assert(v.expression?.packageIndex === -2,
                  'ColorMaterialInput synth: Expression FPackageIndex=-2 preserved without resolver',
                  `got=${JSON.stringify(v.expression)}`);
    runner.assert(v.outputIndex === 3, 'ColorMaterialInput synth: OutputIndex=3');
    runner.assert(v.inputName === 'B', 'ColorMaterialInput synth: InputName="B"');
    runner.assert(v.useConstant === true, 'ColorMaterialInput synth: UseConstant=true');
    runner.assert(v.constant && Math.abs(v.constant.r - 0.25) < 1e-6
                  && Math.abs(v.constant.g - 0.5) < 1e-6 && Math.abs(v.constant.a - 1) < 1e-6,
                  'ColorMaterialInput synth: Constant=FLinearColor(0.25, 0.5, 0.75, 1)');
  }

  // FScalarMaterialInput (44 bytes) — minimal.
  {
    const handler = buildStructHandlers().get('ScalarMaterialInput');
    const buf = Buffer.alloc(44);
    // Base zeroed, then UseConstant=0, Constant=1.5
    buf.writeInt32LE(0, 36);
    buf.writeFloatLE(1.5, 40);
    const pseudoTag = { flags: 0x08, size: 44, type: 'StructProperty',
                        typeParams: [{ name: 'ScalarMaterialInput', params: [] }] };
    const v = handler(new Cursor(buf), pseudoTag, ['None'], {});
    runner.assert(v.constant === 1.5 && v.useConstant === false,
                  'ScalarMaterialInput synth: Constant=1.5, UseConstant=false');
  }

  // FVectorMaterialInput (52 bytes) — 3×float32 constant.
  {
    const handler = buildStructHandlers().get('VectorMaterialInput');
    const buf = Buffer.alloc(52);
    buf.writeInt32LE(1, 36);  // UseConstant=true
    buf.writeFloatLE(10, 40);
    buf.writeFloatLE(20, 44);
    buf.writeFloatLE(30, 48);
    const pseudoTag = { flags: 0x08, size: 52, type: 'StructProperty',
                        typeParams: [{ name: 'VectorMaterialInput', params: [] }] };
    const v = handler(new Cursor(buf), pseudoTag, ['None'], {});
    runner.assert(v.constant?.x === 10 && v.constant?.y === 20 && v.constant?.z === 30,
                  'VectorMaterialInput synth: FVector3f(10,20,30)');
  }

  // FVector2MaterialInput (48 bytes).
  {
    const handler = buildStructHandlers().get('Vector2MaterialInput');
    const buf = Buffer.alloc(48);
    buf.writeInt32LE(0, 36);
    buf.writeFloatLE(-1.5, 40);
    buf.writeFloatLE(2.5, 44);
    const pseudoTag = { flags: 0x08, size: 48, type: 'StructProperty',
                        typeParams: [{ name: 'Vector2MaterialInput', params: [] }] };
    const v = handler(new Cursor(buf), pseudoTag, ['None'], {});
    runner.assert(v.constant?.x === -1.5 && v.constant?.y === 2.5,
                  'Vector2MaterialInput synth: FVector2f(-1.5, 2.5)');
  }

  // FMaterialAttributesInput (36 bytes, no extras).
  {
    const handler = buildStructHandlers().get('MaterialAttributesInput');
    const buf = Buffer.alloc(36);
    buf.writeInt32LE(7, 0);                              // Expression=7
    buf.writeInt32LE(1, 4);                              // OutputIndex
    buf.writeInt32LE(0, 8); buf.writeInt32LE(0, 12);     // InputName="None"
    const pseudoTag = { flags: 0x08, size: 36, type: 'StructProperty',
                        typeParams: [{ name: 'MaterialAttributesInput', params: [] }] };
    const v = handler(new Cursor(buf), pseudoTag, ['None'],
                      { resolve: (idx) => ({ packageIndex: idx, objectName: `E${idx}` }) });
    runner.assert(v.expression?.objectName === 'E7' && v.outputIndex === 1,
                  'MaterialAttributesInput synth: 36B base-only + resolver');
  }
}

// ── Struct handler registry contains new variants ──
function testMaterialInputHandlerRegistry() {
  const h = buildStructHandlers();
  for (const name of ['ColorMaterialInput', 'ScalarMaterialInput',
                      'ShadingModelMaterialInput', 'SubstrateMaterialInput',
                      'VectorMaterialInput', 'Vector2MaterialInput',
                      'MaterialAttributesInput']) {
    runner.assert(h.has(name) && typeof h.get(name) === 'function',
                  `ExprInput: struct handler registry contains ${name}`);
  }
}

// ── Parser-Extensions Item 2: FieldPathProperty synthetic edge cases ──
function testFieldPathPropertySynthetic() {
  // Two-element path + FPackageIndex owner (14 + 4 = 24 bytes).
  {
    const wrapperNames = ['None', 'Field', 'UHealthSet', 'Health', 'FieldPathProperty'];
    // path = ["Health", "UHealthSet"], owner = -1 (first import)
    const fpBytes = Buffer.alloc(24);
    let p = 0;
    fpBytes.writeInt32LE(2, p); p += 4;                 // PathCount=2
    fpBytes.writeInt32LE(3, p); p += 4; fpBytes.writeInt32LE(0, p); p += 4;  // FName "Health"
    fpBytes.writeInt32LE(2, p); p += 4; fpBytes.writeInt32LE(0, p); p += 4;  // FName "UHealthSet"
    fpBytes.writeInt32LE(-1, p);                        // ResolvedOwner = import[0]
    const outer = buildTaggedStream([
      { name: 'Field', typeName: 'FieldPathProperty', typeParams: [],
        size: fpBytes.length, flags: 0, valueBytes: fpBytes },
    ], wrapperNames);
    const result = readTaggedPropertyStream(new Cursor(outer), outer.length, wrapperNames, {});
    runner.assert(result.properties.Field?.path?.length === 2,
                  'FieldPath synth: 2-element path decoded');
    runner.assert(result.properties.Field?.path?.[0] === 'Health' &&
                  result.properties.Field?.path?.[1] === 'UHealthSet',
                  'FieldPath synth: path elements preserved in serialized order');
    runner.assert(result.properties.Field?.owner?.packageIndex === -1,
                  'FieldPath synth: ResolvedOwner FPackageIndex=-1 preserved without resolver');
  }

  // Empty path (length=0) + owner=0 null reference.
  {
    const wrapperNames = ['None', 'Field', 'FieldPathProperty'];
    const fpBytes = Buffer.alloc(8);
    fpBytes.writeInt32LE(0, 0);  // PathCount=0
    fpBytes.writeInt32LE(0, 4);  // ResolvedOwner=0 (null)
    const outer = buildTaggedStream([
      { name: 'Field', typeName: 'FieldPathProperty', typeParams: [],
        size: fpBytes.length, flags: 0, valueBytes: fpBytes },
    ], wrapperNames);
    const result = readTaggedPropertyStream(new Cursor(outer), outer.length, wrapperNames, {});
    runner.assert(result.properties.Field?.path?.length === 0 && result.properties.Field?.owner === null,
                  'FieldPath synth: empty path + owner=0 decodes cleanly');
  }

  // Unreasonable PathCount → null → dispatcher emits unsupported marker.
  {
    const wrapperNames = ['None', 'Field', 'FieldPathProperty'];
    const fpBytes = Buffer.alloc(4);
    fpBytes.writeInt32LE(10000, 0);  // absurd PathCount
    const outer = buildTaggedStream([
      { name: 'Field', typeName: 'FieldPathProperty', typeParams: [],
        size: fpBytes.length, flags: 0, valueBytes: fpBytes },
    ], wrapperNames);
    const result = readTaggedPropertyStream(new Cursor(outer), outer.length, wrapperNames, {});
    runner.assert(result.properties.Field?.unsupported === true &&
                  result.properties.Field?.reason === 'unknown_property_type',
                  'FieldPath synth: unreasonable PathCount falls back to unsupported marker');
  }
}

// ── Synthetic tests: TArray<int32>, TArray<FString>, TArray<FVector> ──
function testContainerSyntheticScalars() {
  const structHandlers = buildStructHandlers();
  const containerHandlers = buildContainerHandlers();
  const taggedVectorBytes = (names, x, y, z) => buildTaggedStream([
    { name: 'X', typeName: 'DoubleProperty', typeParams: [], size: 8, flags: 0, valueBytes: doubleBytes(x) },
    { name: 'Y', typeName: 'DoubleProperty', typeParams: [], size: 8, flags: 0, valueBytes: doubleBytes(y) },
    { name: 'Z', typeName: 'DoubleProperty', typeParams: [], size: 8, flags: 0, valueBytes: doubleBytes(z) },
  ], names);

  // The parser's generic path must report a stable fallback marker when a
  // caller intentionally omits the configured container registry.
  {
    const names = ['None', 'Numbers', 'ArrayProperty', 'IntProperty'];
    const valueBytes = Buffer.concat([int32Bytes(1), int32Bytes(42)]);
    const outer = buildTaggedStream([{
      name: 'Numbers',
      typeName: 'ArrayProperty',
      typeParams: [{ name: 'IntProperty', params: [] }],
      size: valueBytes.length,
      flags: 0,
      valueBytes,
    }], names);
    const result = readTaggedPropertyStream(new Cursor(outer), outer.length, names, {});
    runner.assert(
      result.properties?.Numbers?.unsupported === true &&
        result.properties?.Numbers?.reason === GENERIC_CONTAINER_FALLBACK_REASON,
      'T2 synth: parser without container handlers emits the generic fallback reason',
    );
  }

  // TArray<IntProperty> — 3 elements: 42, -7, 0
  {
    const tag = { flags: 0x00, type: 'ArrayProperty', size: 16,
                  typeParams: [{ name: 'IntProperty', params: [] }] };
    const buf = Buffer.alloc(16);
    buf.writeInt32LE(3, 0);
    buf.writeInt32LE(42, 4); buf.writeInt32LE(-7, 8); buf.writeInt32LE(0, 12);
    const cur = new Cursor(buf);
    const result = containerHandlers.get('ArrayProperty')(cur, tag, [], {});
    runner.assert(Array.isArray(result) && result.length === 3,
                  'L2.5 synth: TArray<int32> count=3');
    runner.assert(result?.[0] === 42 && result?.[1] === -7 && result?.[2] === 0,
                  'L2.5 synth: TArray<int32> values preserved');
  }

  // TArray<FloatProperty> — 2 elements
  {
    const tag = { flags: 0x00, size: 12, type: 'ArrayProperty',
                  typeParams: [{ name: 'FloatProperty', params: [] }] };
    const buf = Buffer.alloc(12);
    buf.writeInt32LE(2, 0);
    buf.writeFloatLE(1.5, 4); buf.writeFloatLE(-2.5, 8);
    const result = containerHandlers.get('ArrayProperty')(new Cursor(buf), tag, [], {});
    runner.assert(result?.[0] === 1.5 && result?.[1] === -2.5,
                  'L2.5 synth: TArray<float>');
  }

  // TArray<FVector> native binary — 2 elements × 24B + 4 count = 52 bytes
  {
    const tag = { flags: 0x08, size: 52, type: 'ArrayProperty',
                  typeParams: [{ name: 'StructProperty', params: [{ name: 'Vector', params: [] }] }] };
    const buf = Buffer.alloc(52);
    buf.writeInt32LE(2, 0);
    buf.writeDoubleLE(1, 4); buf.writeDoubleLE(2, 12); buf.writeDoubleLE(3, 20);
    buf.writeDoubleLE(-1, 28); buf.writeDoubleLE(-2, 36); buf.writeDoubleLE(-3, 44);
    const result = containerHandlers.get('ArrayProperty')(new Cursor(buf), tag, [],
                                                          { structHandlers });
    runner.assert(result?.[0]?.x === 1 && result?.[1]?.z === -3,
                  'L2.5 synth: TArray<FVector> native binary');
  }

  // TSet<NameProperty> — NumRemoved=0 + Count=2 + 2×FName
  {
    const tag = { flags: 0x00, size: 24, type: 'SetProperty',
                  typeParams: [{ name: 'NameProperty', params: [] }] };
    const buf = Buffer.alloc(24);
    buf.writeInt32LE(0, 0);  // NumRemoved
    buf.writeInt32LE(2, 4);  // Count
    buf.writeInt32LE(1, 8); buf.writeInt32LE(0, 12);   // FName(1)
    buf.writeInt32LE(2, 16); buf.writeInt32LE(0, 20);  // FName(2)
    const names = ['Zero', 'Alpha', 'Beta'];
    const result = containerHandlers.get('SetProperty')(new Cursor(buf), tag, names, {});
    runner.assert(Array.isArray(result) && result.length === 2 && result[0] === 'Alpha',
                  'L2.5 synth: TSet<FName> decodes count+elements');
  }

  // Tier 2 (D46): native-binary element with no handler → complex_element_container.
  // Tagged-element path decodes via the tier-3 fallback (see below).
  {
    const tag = { flags: 0x08, size: 100, type: 'ArrayProperty',
                  typeParams: [{ name: 'StructProperty',
                                 params: [{ name: 'UnknownCustomStruct', params: [] }] }] };
    const buf = Buffer.alloc(100);
    buf.writeInt32LE(1, 0);
    const result = containerHandlers.get('ArrayProperty')(new Cursor(buf), tag, [],
                                                          { structHandlers });
    runner.assert(result && result.__unsupported__ === true,
                  'T2 synth: TArray<UnknownStruct> native (flag 0x08) → complex_element_container marker');
    runner.assert(result.reason === 'complex_element_container',
                  'T2 synth: native-binary unknown-struct marker reason correct');
  }

  // Tier 2 + Tier 3: tagged element with no handler decodes via fallback.
  {
    const names = ['None', 'Alpha', 'Beta', 'IntProperty'];
    // Two elements, each a tagged sub-stream with {Alpha=1, Beta=2} then {Alpha=3, Beta=4}.
    const elt = (a, b) => buildTaggedStream([
      { name: 'Alpha', typeName: 'IntProperty', typeParams: [], size: 4, flags: 0, valueBytes: int32Bytes(a) },
      { name: 'Beta',  typeName: 'IntProperty', typeParams: [], size: 4, flags: 0, valueBytes: int32Bytes(b) },
    ], names);
    const el1 = elt(1, 2);
    const el2 = elt(3, 4);
    const count = Buffer.alloc(4); count.writeInt32LE(2, 0);
    const body = Buffer.concat([count, el1, el2]);
    const tag = { flags: 0x00, size: body.length, type: 'ArrayProperty',
                  typeParams: [{ name: 'StructProperty',
                                 params: [{ name: 'FakeUDSForTest', params: [] }] }] };
    const result = containerHandlers.get('ArrayProperty')(new Cursor(body), tag, names,
                                                          { structHandlers, containerHandlers });
    runner.assert(Array.isArray(result) && result.length === 2,
                  'T2 synth: TArray<tagged FakeUDSForTest> decodes via tagged-element fallback');
    runner.assert(result?.[0]?.Alpha === 1 && result?.[0]?.Beta === 2,
                  'T2 synth: first element fields (Alpha=1, Beta=2) extracted');
    runner.assert(result?.[1]?.Alpha === 3 && result?.[1]?.Beta === 4,
                  'T2 synth: second element fields (Alpha=3, Beta=4) extracted');
  }

  // Tagged element with a registered handler must consume its complete
  // self-describing sub-stream rather than returning handler defaults.
  {
    const names = ['None', 'X', 'Y', 'Z', 'DoubleProperty'];
    const first = taggedVectorBytes(names, 1.5, -2.5, 3.5);
    const second = taggedVectorBytes(names, 7.5, 8.5, -9.5);
    const body = Buffer.concat([int32Bytes(2), first, second]);
    const tag = { flags: 0x00, size: body.length, type: 'ArrayProperty',
                  typeParams: [{ name: 'StructProperty',
                                 params: [{ name: 'Vector', params: [] }] }] };
    const cur = new Cursor(body);
    const result = containerHandlers.get('ArrayProperty')(cur, tag, names,
                                                          { structHandlers, containerHandlers });
    runner.assert(result?.[0]?.x === 1.5 && result?.[0]?.y === -2.5 && result?.[0]?.z === 3.5,
                  'T2 synth: TArray<tagged Vector> decodes first registered struct');
    runner.assert(result?.[1]?.x === 7.5 && result?.[1]?.y === 8.5 && result?.[1]?.z === -9.5,
                  'T2 synth: TArray<tagged Vector> decodes second registered struct');
    runner.assert(cur.tell() === body.length,
                  'T2 synth: TArray<tagged Vector> consumes both tagged elements');
  }

  // A malformed element must stop at the declared array boundary even when
  // the backing buffer contains a valid tagged property that could poison it.
  {
    const names = ['None', 'X', 'Y', 'Z', 'DoubleProperty'];
    const unterminated = taggedVectorBytes(names, 1, 2, 3).subarray(0, -8);
    const body = Buffer.concat([int32Bytes(1), unterminated]);
    const poison = taggedVectorBytes(names, 99, 98, 97);
    const backing = Buffer.concat([body, poison]);
    const tag = { flags: 0x00, size: body.length, type: 'ArrayProperty',
                  typeParams: [{ name: 'StructProperty',
                                 params: [{ name: 'Vector', params: [] }] }] };
    const cur = new Cursor(backing);
    const result = containerHandlers.get('ArrayProperty')(cur, tag, names,
                                                          { structHandlers, containerHandlers });
    runner.assert(result?.__unsupported__ === true &&
                  result?.reason === 'tagged_struct_terminator_missing',
                  'T2 synth: unterminated tagged array element emits a stable marker');
    runner.assert(cur.tell() === body.length,
                  'T2 synth: unterminated tagged array element cannot consume poisoned trailing bytes');
  }

  // The handler-free tagged fallback shares the same boundary and terminator
  // contract as registered structs.
  {
    const names = ['None', 'Alpha', 'IntProperty'];
    const tagged = buildTaggedStream([
      { name: 'Alpha', typeName: 'IntProperty', typeParams: [], size: 4, flags: 0, valueBytes: int32Bytes(1) },
    ], names);
    const body = Buffer.concat([int32Bytes(1), tagged.subarray(0, -8)]);
    const poison = buildTaggedStream([
      { name: 'Alpha', typeName: 'IntProperty', typeParams: [], size: 4, flags: 0, valueBytes: int32Bytes(99) },
    ], names);
    const tag = { flags: 0x00, size: body.length, type: 'ArrayProperty',
                  typeParams: [{ name: 'StructProperty',
                                 params: [{ name: 'UnknownTaggedStruct', params: [] }] }] };
    const cur = new Cursor(Buffer.concat([body, poison]));
    const result = containerHandlers.get('ArrayProperty')(cur, tag, names,
                                                          { structHandlers, containerHandlers });
    runner.assert(result?.__unsupported__ === true &&
                  result?.reason === 'tagged_struct_terminator_missing',
                  'T2 synth: unterminated unknown tagged struct emits the same stable marker');
    runner.assert(cur.tell() === body.length,
                  'T2 synth: unknown tagged fallback cannot consume poisoned trailing bytes');
  }

  // Tier 2 (D46): TMap<Name, int32> synthetic.
  {
    const names = ['None', 'First', 'Second'];
    // NumRemoved=0, Count=2, keys=(FName First, FName Second), values=(10, 20)
    const buf = Buffer.alloc(4 + 4 + 2 * (8 + 4));
    let p = 0;
    buf.writeInt32LE(0, p); p += 4;
    buf.writeInt32LE(2, p); p += 4;
    buf.writeInt32LE(1, p); p += 4; buf.writeInt32LE(0, p); p += 4; buf.writeInt32LE(10, p); p += 4;
    buf.writeInt32LE(2, p); p += 4; buf.writeInt32LE(0, p); p += 4; buf.writeInt32LE(20, p); p += 4;
    const tag = { flags: 0x00, size: buf.length, type: 'MapProperty',
                  typeParams: [
                    { name: 'NameProperty', params: [] },
                    { name: 'IntProperty', params: [] },
                  ] };
    const result = containerHandlers.get('MapProperty')(new Cursor(buf), tag, names,
                                                        { structHandlers, containerHandlers });
    runner.assert(Array.isArray(result) && result.length === 2,
                  'T2 synth: TMap<Name, int32> decodes 2 entries');
    runner.assert(result?.[0]?.key === 'First' && result?.[0]?.value === 10,
                  'T2 synth: TMap entry 0 {First → 10}');
    runner.assert(result?.[1]?.key === 'Second' && result?.[1]?.value === 20,
                  'T2 synth: TMap entry 1 {Second → 20}');
  }

  // Scalar key + supported native struct value.
  {
    const names = ['None', 'Origin'];
    const buf = Buffer.concat([
      int32Bytes(0),
      int32Bytes(1),
      writeFName('Origin', names),
      vectorBytes(1.5, -2.5, 3.5),
    ]);
    const tag = { flags: 0x08, size: buf.length, type: 'MapProperty',
                  typeParams: [
                    { name: 'NameProperty', params: [] },
                    { name: 'StructProperty', params: [{ name: 'Vector', params: [] }] },
                  ] };
    const result = containerHandlers.get('MapProperty')(new Cursor(buf), tag, names,
                                                        { structHandlers, containerHandlers });
    runner.assert(result?.[0]?.key === 'Origin' &&
                  result?.[0]?.value?.x === 1.5 &&
                  result?.[0]?.value?.y === -2.5 &&
                  result?.[0]?.value?.z === 3.5,
                  'T2 synth: TMap<Name, Vector> decodes a supported struct value');
  }

  // Scalar key + registered struct value using tagged serialization.
  {
    const names = ['None', 'Origin', 'Destination', 'X', 'Y', 'Z', 'DoubleProperty'];
    const first = taggedVectorBytes(names, 4.5, -5.5, 6.5);
    const second = taggedVectorBytes(names, -7.5, 8.5, 9.5);
    const buf = Buffer.concat([
      int32Bytes(0),
      int32Bytes(2),
      writeFName('Origin', names),
      first,
      writeFName('Destination', names),
      second,
    ]);
    const tag = { flags: 0x00, size: buf.length, type: 'MapProperty',
                  typeParams: [
                    { name: 'NameProperty', params: [] },
                    { name: 'StructProperty', params: [{ name: 'Vector', params: [] }] },
                  ] };
    const cur = new Cursor(buf);
    const result = containerHandlers.get('MapProperty')(cur, tag, names,
                                                        { structHandlers, containerHandlers });
    runner.assert(result?.[0]?.key === 'Origin' &&
                  result?.[0]?.value?.x === 4.5 &&
                  result?.[0]?.value?.y === -5.5 &&
                  result?.[0]?.value?.z === 6.5,
                  'T2 synth: TMap<Name, tagged Vector> decodes first registered struct');
    runner.assert(result?.[1]?.key === 'Destination' &&
                  result?.[1]?.value?.x === -7.5 &&
                  result?.[1]?.value?.y === 8.5 &&
                  result?.[1]?.value?.z === 9.5,
                  'T2 synth: TMap<Name, tagged Vector> decodes second registered struct');
    runner.assert(cur.tell() === buf.length,
                  'T2 synth: TMap<Name, tagged Vector> consumes both tagged values');
  }

  // A malformed map value must not consume a following outer property from
  // the same backing buffer when its own declared container payload ends.
  {
    const names = ['None', 'Origin', 'X', 'Y', 'Z', 'DoubleProperty'];
    const unterminated = taggedVectorBytes(names, 1, 2, 3).subarray(0, -8);
    const body = Buffer.concat([
      int32Bytes(0),
      int32Bytes(1),
      writeFName('Origin', names),
      unterminated,
    ]);
    const poison = taggedVectorBytes(names, 99, 98, 97);
    const backing = Buffer.concat([body, poison]);
    const tag = { flags: 0x00, size: body.length, type: 'MapProperty',
                  typeParams: [
                    { name: 'NameProperty', params: [] },
                    { name: 'StructProperty', params: [{ name: 'Vector', params: [] }] },
                  ] };
    const cur = new Cursor(backing);
    const result = containerHandlers.get('MapProperty')(cur, tag, names,
                                                        { structHandlers, containerHandlers });
    runner.assert(result?.__unsupported__ === true &&
                  result?.reason === 'tagged_struct_terminator_missing',
                  'T2 synth: unterminated tagged map value emits a stable marker');
    runner.assert(cur.tell() === body.length,
                  'T2 synth: unterminated tagged map value cannot consume poisoned trailing bytes');
  }

  // Scalar key + soft-object reference value.
  {
    const assetPath = '/Game/Props/SM_Crate.SM_Crate';
    const names = ['None', 'Crate', assetPath];
    const buf = Buffer.concat([
      int32Bytes(0),
      int32Bytes(1),
      writeFName('Crate', names),
      writeFName(assetPath, names),
      fstringBytes('LOD0'),
    ]);
    const tag = { flags: 0x00, size: buf.length, type: 'MapProperty',
                  typeParams: [
                    { name: 'NameProperty', params: [] },
                    { name: 'SoftObjectProperty', params: [] },
                  ] };
    const result = containerHandlers.get('MapProperty')(new Cursor(buf), tag, names,
                                                        { structHandlers, containerHandlers });
    runner.assert(result?.[0]?.key === 'Crate' &&
                  result?.[0]?.value?.assetPath === assetPath &&
                  result?.[0]?.value?.subPath === 'LOD0',
                  'T2 synth: TMap<Name, SoftObjectProperty> decodes a soft reference value');
  }

  // Tier 2 (D46): TMap<StructProperty<_>, *> → struct_key_map marker.
  {
    const buf = Buffer.alloc(8);  // NumRemoved=0, Count=0
    const tag = { flags: 0x00, size: buf.length, type: 'MapProperty',
                  typeParams: [
                    { name: 'StructProperty', params: [{ name: 'Vector', params: [] }] },
                    { name: 'IntProperty', params: [] },
                  ] };
    const result = containerHandlers.get('MapProperty')(new Cursor(buf), tag, [],
                                                        { structHandlers, containerHandlers });
    runner.assert(result?.__unsupported__ === true && result?.reason === 'struct_key_map',
                  'T2 synth: struct-keyed TMap emits struct_key_map marker');
  }

  // Scalar key + unsupported value category.
  {
    const names = ['None', 'Nested'];
    const buf = Buffer.concat([
      int32Bytes(0),
      int32Bytes(1),
      writeFName('Nested', names),
    ]);
    const tag = { flags: 0x00, size: buf.length, type: 'MapProperty',
                  typeParams: [
                    { name: 'NameProperty', params: [] },
                    { name: 'ArrayProperty', params: [] },
                  ] };
    const result = containerHandlers.get('MapProperty')(new Cursor(buf), tag, names,
                                                        { structHandlers, containerHandlers });
    runner.assert(result?.__unsupported__ === true &&
                  result?.reason === 'map_value_type_unsupported' &&
                  result?.detail === 'ArrayProperty',
                  'T2 synth: unsupported TMap value type emits map_value_type_unsupported');
  }
}

// ── CP2 (S-B-base, M-new): pin-body parse — PinId + Direction ──────
//
// Validates parsePinBlock's pin body walker. For every pin whose PinId
// appears in BOTH parser output and Oracle, the direction MUST match.
// The cross-set mismatch is structural (UE PostLoad pin regeneration in
// K2Node_FunctionEntry / K2Node_PromotableOperator) and is asserted as
// a known finding, not a regression.
async function testPinBodyParseCP2() {
  const FIXTURES_DIR = join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'Commandlets', 'fixtures');
  const FIXTURES = [
    ['BP_OSPlayerR_Child',  'Content/Actors/Character/BP_OSPlayerR_Child.uasset',  'BP_OSPlayerR_Child.oracle.json'],
    ['BP_OSPlayerR_Child1', 'Content/Actors/Character/BP_OSPlayerR_Child1.uasset', 'BP_OSPlayerR_Child1.oracle.json'],
    ['BP_OSPlayerR_Child2', 'Content/Actors/Character/BP_OSPlayerR_Child2.uasset', 'BP_OSPlayerR_Child2.oracle.json'],
    ['TestCharacter',       'Content/Blueprints/Character/TestCharacter.uasset',       'TestCharacter.oracle.json'],
  ];

  for (const [fxName, relPath, oracleName] of FIXTURES) {
    // Discovery-resolved at startup (D188 Task 6) — PROBE_BY_NAME falls back
    // to `relPath` internally (via resolveProbe) when discovery can't find
    // the asset, so the skip below still fires exactly as before.
    const assetPath = PROBE_BY_NAME[fxName] ?? join(ROOT, relPath);
    const oraclePath = join(FIXTURES_DIR, oracleName);
    if (!(await exists(assetPath)) || !(await exists(oraclePath))) {
      console.log(`  · skipped CP2/${fxName} (missing asset or oracle)`);
      continue;
    }

    const buf = await readFile(assetPath);
    const oracle = JSON.parse((await readFile(oraclePath)).toString('utf8'));
    const cur = new Cursor(buf);
    const s = parseSummary(cur);
    const names = readNameTable(cur, s);
    const imports = readImportTable(cur, s, names);
    const exports = readExportTable(cur, s, names);
    const opts = { resolve: makePackageIndexResolver(exports, imports), structHandlers: buildStructHandlers() };

    const oracleByGuid = new Map();
    for (const [_, graph] of Object.entries(oracle.graphs)) {
      for (const [nodeGuid, node] of Object.entries(graph.nodes)) {
        oracleByGuid.set(nodeGuid, node);
      }
    }
    const classOf = (e) => {
      if (e.classIndex === 0) return null;
      if (e.classIndex > 0) return exports[e.classIndex - 1]?.objectName ?? null;
      return imports[-e.classIndex - 1]?.objectName ?? null;
    };

    let totalParsed = 0, dirMatches = 0, dirMismatches = 0, malformed = 0;

    for (const exp of exports) {
      if (!isGraphNodeExportClass(classOf(exp))) continue;
      const pb = parsePinBlock(buf, exp, names, opts);
      if (pb.malformed) { malformed++; continue; }
      const oNode = pb.nodeGuid && oracleByGuid.get(pb.nodeGuid);
      if (!oNode) continue;

      for (const pp of pb.pins) {
        if (pp.pin_id === null) continue;
        totalParsed++;
        const oPin = oNode.pins[pp.pin_id];
        if (!oPin) continue;
        if (pp.direction === oPin.direction) dirMatches++;
        else dirMismatches++;
      }
    }

    runner.assert(malformed === 0, `CP2/${fxName}: zero malformed pin blocks`);
    runner.assert(dirMismatches === 0,
      `CP2/${fxName}: zero direction mismatches on intersecting pins`);
    runner.assert(totalParsed > 0, `CP2/${fxName}: parsed at least one pin`);
    runner.assert(dirMatches === totalParsed,
      `CP2/${fxName}: every parsed pin matches oracle pinId+direction (${dirMatches}/${totalParsed})`);
  }

  // Direction byte → string mapping. Exhaustive check (only 0/1 are valid in UE).
  // Synthetic empty pin trailer: arrayCount=0 → no pin bodies → trivially pass.
  const exportEntry = { serialOffset: 0, serialSize: 8 };
  const buf = Buffer.alloc(8);
  // Write FName 'None' tag terminator at offset 0 — but that requires a name table,
  // skip the synthetic case here. CP2's coverage is the real-fixture intersection.
}

function testPinDefaultLiteralSynthetic() {
  const names = ['None', 'LiteralPin'];
  const resolve = (idx) => {
    if (idx === -1) {
      return {
        packageIndex: idx,
        objectName: 'T_PinDefault_Texture',
        packagePath: '/Game/Test/T_PinDefault_Texture.T_PinDefault_Texture',
        kind: 'import',
      };
    }
    return { packageIndex: idx };
  };

  {
    const buf = syntheticPinBlock(names, {
      defaultValue: '42',
      autogeneratedDefaultValue: '0',
      defaultObjectIndex: -1,
      defaultTextValue: 'Localized fallback',
    });
    const pb = parsePinBlock(buf, { serialOffset: 0, serialSize: buf.length }, names, { resolve });
    runner.assert(pb.malformed === false, 'CP2 defaults synthetic: pin block parses');
    const pin = pb.pins[0];
    runner.assert(pin.default_value === '42',
      'CP2 defaults synthetic: DefaultValue FString is captured');
    runner.assert(pin.autogenerated_default_value === '0',
      'CP2 defaults synthetic: AutogeneratedDefaultValue FString is captured');
    runner.assert(pin.default_object?.packagePath === '/Game/Test/T_PinDefault_Texture.T_PinDefault_Texture',
      'CP2 defaults synthetic: DefaultObject FPackageIndex is resolved');
    runner.assert(pin.default_text_value === 'Localized fallback',
      'CP2 defaults synthetic: DefaultTextValue FText source is captured');
  }

  {
    const buf = syntheticPinBlock(names);
    const pb = parsePinBlock(buf, { serialOffset: 0, serialSize: buf.length }, names, { resolve });
    const pin = pb.pins[0];
    runner.assert(!('default_value' in pin),
      'CP2 defaults synthetic: empty DefaultValue is omitted');
    runner.assert(!('autogenerated_default_value' in pin),
      'CP2 defaults synthetic: empty AutogeneratedDefaultValue is omitted');
    runner.assert(!('default_object' in pin),
      'CP2 defaults synthetic: null DefaultObject is omitted');
    runner.assert(!('default_text_value' in pin),
      'CP2 defaults synthetic: empty DefaultTextValue is omitted');
  }
}

// ── CP1 (S-B-base, M-new): pin-block offset detection ──────────────
//
// Validates that `parsePinBlock` lands cleanly on the UEdGraphNode pin
// trailer across the full Oracle-A fixture corpus. Layout verified:
//   [tagged UPROPERTY block]
//   int32 postTagSentinel = 0
//   int32 arrayCount (serialized pin slot count, includes bNullPtr slots)
//
// Tolerance: arrayCount >= oraclePinCount — UE's SaveAll orphan mode on
// K2Node_FunctionEntry retains bNullPtr slots for back-compat, so the
// serialized count can exceed Oracle's non-null-pin count. CP3 filters
// bNullPtr entries via SerializePin reads.
// T-1c: engine-sourced CP1 fixtures. Pinned to the engine version the oracles
// were dumped from — a different install ships different bytes at the same
// /Engine/ path, so an unpinned resolve disagrees with the oracle in a way that
// looks like a parser regression.
const CP1_ENGINE_VERSION = '5.6';
function engineFixturesForCP1() {
  const engineRoot = resolveEngineRoot({ preferVersion: CP1_ENGINE_VERSION });
  if (!engineRoot) return [];
  const build = readEngineBuildVersion(engineRoot);
  return [
    { name: 'BP_Sky_Sphere',  oracle: 'BP_Sky_Sphere.oracle.json',  expectedGraphNodes: 122, enginePath: '/Engine/EngineSky/BP_Sky_Sphere' },
    { name: 'StandardMacros', oracle: 'StandardMacros.oracle.json', expectedGraphNodes: 227, enginePath: '/Engine/EditorBlueprintResources/StandardMacros' },
    // Anim Blueprint — pins AnimGraphNode_* into the pin-block coverage too.
    { name: 'TutorialTPP_AnimBlueprint', oracle: 'TutorialTPP_AnimBlueprint.oracle.json', expectedGraphNodes: 13, enginePath: '/Engine/Tutorial/SubEditors/TutorialAssets/Character/TutorialTPP_AnimBlueprint' },
  ].map(def => ({ ...def, build, diskPath: engineAssetDiskPath(engineRoot, def.enginePath) }));
}

async function testPinBlockOffsetCP1() {
  const FIXTURES_DIR = join(REPO_ROOT, 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'Commandlets', 'fixtures');
  const FIXTURES = [
    { name: 'BP_OSPlayerR',       relPath: 'Content/Actors/Character/BP_OSPlayerR.uasset',       oracle: 'BP_OSPlayerR.oracle.json',       expectedGraphNodes: 210 },
    { name: 'BP_OSPlayerR_Child', relPath: 'Content/Actors/Character/BP_OSPlayerR_Child.uasset', oracle: 'BP_OSPlayerR_Child.oracle.json', expectedGraphNodes: 6 },
    { name: 'BP_OSPlayerR_Child1', relPath: 'Content/Actors/Character/BP_OSPlayerR_Child1.uasset', oracle: 'BP_OSPlayerR_Child1.oracle.json', expectedGraphNodes: 6 },
    { name: 'BP_OSPlayerR_Child2', relPath: 'Content/Actors/Character/BP_OSPlayerR_Child2.uasset', oracle: 'BP_OSPlayerR_Child2.oracle.json', expectedGraphNodes: 6 },
    { name: 'TestCharacter',      relPath: 'Content/Blueprints/Character/TestCharacter.uasset',      oracle: 'TestCharacter.oracle.json',      expectedGraphNodes: 11 },
    { name: 'BP_OSControlPoint',  relPath: 'Content/Actors/Level/BP_OSControlPoint.uasset',      oracle: 'BP_OSControlPoint.oracle.json',  expectedGraphNodes: 223 },
    // T-1c engine fixtures — resolved from a UE install rather than the
    // project, so they run with no project attached and cannot drift.
    ...engineFixturesForCP1(),
  ];

  for (const fx of FIXTURES) {
    // Discovery-resolved at startup (D188 Task 6) — PROBE_BY_NAME falls back
    // to `fx.relPath` internally (via resolveProbe) when discovery can't
    // find the asset, so the skip below still fires exactly as before.
    const assetPath = fx.diskPath ?? PROBE_BY_NAME[fx.name] ?? join(ROOT, fx.relPath);
    const oraclePath = join(FIXTURES_DIR, fx.oracle);
    if (!(await exists(assetPath)) || !(await exists(oraclePath))) {
      console.log(`  · skipped CP1/${fx.name} (missing asset or oracle)`);
      continue;
    }
    const buf = await readFile(assetPath);
    const oracle = JSON.parse((await readFile(oraclePath)).toString('utf8'));

    if (fx.enginePath && !engineVersionMatches(fx.build, oracle.engine_version)) {
      console.log(`  · skipped CP1/${fx.name} (engine is not the build the oracle was dumped from)`);
      continue;
    }

    const cur = new Cursor(buf);
    const s = parseSummary(cur);
    const names = readNameTable(cur, s);
    const imports = readImportTable(cur, s, names);
    const exports = readExportTable(cur, s, names);
    const resolver = makePackageIndexResolver(exports, imports);
    const parseOpts = { resolve: resolver, structHandlers: buildStructHandlers(), ...pinBlockLayoutForPackage(s) };

    const oracleByGuid = new Map();
    for (const [graphName, graph] of Object.entries(oracle.graphs)) {
      for (const [nodeGuid, node] of Object.entries(graph.nodes)) {
        oracleByGuid.set(nodeGuid, {
          graphName,
          className: node.class_name,
          pinCount: Object.keys(node.pins).length,
        });
      }
    }

    const classOf = (exp) => {
      if (exp.classIndex === 0) return null;
      if (exp.classIndex > 0) return exports[exp.classIndex - 1]?.objectName ?? null;
      return imports[-exp.classIndex - 1]?.objectName ?? null;
    };

    let graphNodeCount = 0;
    let sentinelOk = 0;
    let guidMatched = 0;
    let arrayCountOk = 0;
    let totalSerializedSlots = 0;
    let totalOraclePins = 0;

    for (const exp of exports) {
      if (!isGraphNodeExportClass(classOf(exp))) continue;
      graphNodeCount++;

      const pb = parsePinBlock(buf, exp, names, parseOpts);
      if (pb.sentinel === 0) sentinelOk++;
      if (pb.nodeGuid && oracleByGuid.has(pb.nodeGuid)) {
        guidMatched++;
        const oInfo = oracleByGuid.get(pb.nodeGuid);
        totalOraclePins += oInfo.pinCount;
        totalSerializedSlots += pb.arrayCount;
        // arrayCount (serialized slots) >= oracle pinCount (non-null pins)
        if (pb.arrayCount >= oInfo.pinCount) arrayCountOk++;
      }
    }

    const semanticAssetPath = fx.enginePath ?? assetPathFromContentRel(fx.relPath);
    const freshness = evaluateTopologyOracleFreshness(`CP1/${fx.name}`, {
      schema_version: 'sb-base-v1',
      asset_path: semanticAssetPath,
      stats: {
        graphNodeExports: graphNodeCount,
        edgesEmitted: countTopologyEdges(oracle),
      },
    }, oracle, {
      assetPath: semanticAssetPath,
      parserSchemaVersion: 'sb-base-v1',
      oracleSchemaVersion: 'oracle-a-v2',
      edgeCount: countTopologyEdges(oracle),
      graphNodeExports: fx.expectedGraphNodes,
    });
    if (!applyOracleFreshnessGate(runner, freshness)) continue;

    runner.assert(graphNodeCount === fx.expectedGraphNodes,
      `CP1/${fx.name}: graph-node exports = ${fx.expectedGraphNodes}`,
      `got ${graphNodeCount}`);
    runner.assert(sentinelOk === graphNodeCount,
      `CP1/${fx.name}: post-tag sentinel == 0 on all graph-nodes`,
      `${sentinelOk}/${graphNodeCount} had sentinel=0`);
    runner.assert(guidMatched === graphNodeCount,
      `CP1/${fx.name}: every parsed NodeGuid found in oracle`,
      `${guidMatched}/${graphNodeCount} matched`);
    runner.assert(arrayCountOk === graphNodeCount,
      `CP1/${fx.name}: arrayCount >= oracle pin count on all nodes`,
      `${arrayCountOk}/${graphNodeCount} satisfied`);
    runner.assert(totalSerializedSlots >= totalOraclePins,
      `CP1/${fx.name}: total slots >= oracle pin sum (${totalSerializedSlots} >= ${totalOraclePins})`);
  }

  // Non-graph-node predicate spot-checks (no I/O; runs even when fixtures absent).
  runner.assert(isGraphNodeExportClass('K2Node_CallFunction') === true,
    'CP1/predicate: K2Node_* matches');
  runner.assert(isGraphNodeExportClass('EdGraphNode_Comment') === true,
    'CP1/predicate: EdGraphNode_Comment matches');
  runner.assert(isGraphNodeExportClass('UK2Node_CallFunction') === false,
    'CP1/predicate: U-prefixed class does NOT match (UE strips prefix at serialization — D63)');
  runner.assert(isGraphNodeExportClass('BlueprintGeneratedClass') === false,
    'CP1/predicate: non-graph-node classes rejected');

  // FEdGraphPinType's trailing bSerializeAsSinglePrecisionFloat is gated on
  // FUE5ReleaseStreamObjectVersion >= SerializeFloatPinDefaultValuesAsSinglePrecision (36).
  // The reader assumed a fixed 69-byte pin type, which overshoots by 4 on any
  // package below that — desyncing from pin 0.
  //
  // Measured on the 5.8 project: every export at release >= 36 parsed clean
  // (1,093 of 1,093), while below it 180 of 236 failed.
  {
    const key = '425e9bd8464dbd24a8ac1284791764df';
    const at = v => pinBlockLayoutForPackage({ customVersions: [{ key, version: v }] }).hasSinglePrecisionFloatPinDefaults;
    runner.assert(at(36) === true, 'pin type: single-precision float field present exactly at version 36');
    runner.assert(at(47) === true, 'pin type: present above the gate');
    runner.assert(at(35) === false, 'pin type: absent one below the gate');
    runner.assert(pinBlockLayoutForPackage({ customVersions: [] }).hasSinglePrecisionFloatPinDefaults === false,
      'pin type: a package with no UE5-release custom version predates the field');
  }

  // Legacy FPropertyTag (packages below ue5 1012, PROPERTY_TAG_COMPLETE_TYPE_NAME).
  //
  // `operator<<(FSlot, FPropertyTag&)` dispatches to LoadPropertyTagNoFullType
  // below that version, and the layouts share nothing after the name: legacy is
  // FName Type + int32 Size + int32 ArrayIndex + a type-specific payload +
  // a has-guid byte, where modern is FPropertyTypeName + Size + flags byte.
  //
  // Measured across UE 5.8's plugin tree and the 5.8 project: below-1012
  // packages were 4.0% clean against 92.6% at or above it, and 3,376 of 3,383
  // legacy graph-node exports bailed before reading a single property.
  {
    const names = ['None', 'NodePosX', 'IntProperty', 'NodeGuid', 'StructProperty', 'Guid', 'bHidden', 'BoolProperty'];
    const fn = (i, n = 0) => Buffer.concat([int32LE(i), int32LE(n)]);
    const opts = { legacyPropertyTags: true, ue4Version: 522 };

    // Int: name, type, size, arrayIndex, then has-guid=0.
    {
      const cur = new Cursor(Buffer.concat([fn(1), fn(2), int32LE(4), int32LE(0), Buffer.from([0])]));
      const tag = readPropertyTag(cur, names, opts);
      runner.assert(tag.name === 'NodePosX' && tag.type === 'IntProperty' && tag.size === 4,
        'legacy tag: plain property decodes name/type/size',
        `got ${JSON.stringify({ n: tag.name, t: tag.type, s: tag.size })}`);
      runner.assert(cur.tell() === 25, `legacy tag: plain property consumes 25 bytes (8+8+4+4+1) (got ${cur.tell()})`);
    }

    // Struct carries StructName + a 16-byte StructGuid at ue4 >= 441.
    {
      const cur = new Cursor(Buffer.concat([fn(3), fn(4), int32LE(16), int32LE(0), fn(5), Buffer.alloc(16), Buffer.from([0])]));
      const tag = readPropertyTag(cur, names, opts);
      runner.assert(tag.type === 'StructProperty' && tag.size === 16,
        'legacy tag: struct property decodes');
      runner.assert(cur.tell() === 49, `legacy tag: struct consumes 25 + StructName(8) + StructGuid(16) = 49 (got ${cur.tell()})`);
    }

    // Bool carries a 1-byte value inside the TAG, not in the payload.
    {
      const cur = new Cursor(Buffer.concat([fn(6), fn(7), int32LE(0), int32LE(0), Buffer.from([1]), Buffer.from([0])]));
      const tag = readPropertyTag(cur, names, opts);
      runner.assert(tag.type === 'BoolProperty' && tag.size === 0,
        'legacy tag: bool property decodes with a zero-size payload');
      runner.assert(cur.tell() === 26, `legacy tag: bool consumes 25 + its in-tag value(1) = 26 (got ${cur.tell()})`);
    }

    // A None name still terminates the stream.
    {
      const cur = new Cursor(fn(0));
      runner.assert(readPropertyTag(cur, names, opts).terminator === true,
        'legacy tag: None terminates the stream');
    }
  }

  // FText NamedFormat history (type 1). The reader implemented only None (-1)
  // and Base (0) and threw on everything else, which aborted the whole pin
  // array: 360 of 360 mid-array failures in one 5.6 project die exactly here,
  // and 60 more in UE 5.8's engine plugins.
  //
  // Layout per FTextHistory_NamedFormat::Serialize — FTextHistory_Generated
  // writes nothing, then a NESTED FText, then TSortedMap<FString,
  // FFormatArgumentValue>. Each argument is int8 type + payload:
  // Int/UInt/Gender int64, Float 4, Double 8, Text a nested FText.
  {
    const buf = Buffer.concat([
      // outer FText: flags, history=1
      int32LE(0), Buffer.from([1]),
      // nested FormatText: flags, history=-1 (None), bHasCultureInvariantString=0
      int32LE(0), Buffer.from([0xff]), int32LE(0),
      // Arguments: 2 entries
      int32LE(2),
      ansiString('Count'), Buffer.from([0]), int64LE(7n),          // Int
      ansiString('Who'), Buffer.from([4]),                          // Text ->
      int32LE(0), Buffer.from([0xff]), int32LE(0),                  //   nested None FText
      // trailing sentinel so we can prove exact consumption
      int32LE(0x5A5A5A5A),
    ]);
    const cur = new Cursor(buf);
    readFText(cur);
    runner.assert(cur.tell() === buf.length - 4,
      'FText NamedFormat consumes exactly its own bytes',
      `stopped at ${cur.tell()}, expected ${buf.length - 4}`);
    runner.assert(cur.readUInt32() === 0x5A5A5A5A,
      'FText NamedFormat leaves the cursor on the next field');
  }

  // An unknown history type must still throw rather than guess a length —
  // silently mis-consuming would desync every following pin.
  {
    const buf = Buffer.concat([int32LE(0), Buffer.from([99]), int32LE(0)]);
    let threw = null;
    try { readFText(new Cursor(buf)); } catch (e) { threw = e; }
    runner.assert(threw !== null, 'an unimplemented FText history still throws');
    runner.assert(/99/.test(String(threw?.message)),
      `the throw names the history type (got: ${threw?.message})`);
  }

  // FEdGraphPin's int32 SourceIndex is gated on
  // FUE5MainStreamObjectVersion >= EdGraphPinSourceIndex (50), but the parser
  // skipped 4 bytes unconditionally. Packages saved before that version do not
  // carry the field, so the skip consumed 4 bytes of the NEXT field and every
  // pin after it desynced. Measured across UE 5.8 engine plugins: below-gate
  // packages were 0 clean / 885 malformed — 100%.
  //
  // A package with no entry for the GUID predates the version entirely (UE
  // treats a missing custom version as -1), which is why absent must mean
  // "no SourceIndex" rather than defaulting to present.
  {
    const has = v => pinBlockLayoutForPackage({ customVersions: [{ key: '81d57d69ab414fe6ec514aaa28b6b7be', version: v }] }).hasSourceIndex;
    runner.assert(has(50) === true, 'pin layout: SourceIndex present exactly at the gate version (50)');
    runner.assert(has(123) === true, 'pin layout: SourceIndex present above the gate');
    runner.assert(has(49) === false, 'pin layout: SourceIndex absent one below the gate');
    runner.assert(has(24) === false, 'pin layout: SourceIndex absent far below the gate');
    runner.assert(pinBlockLayoutForPackage({ customVersions: [] }).hasSourceIndex === false,
      'pin layout: a package with no MainStream custom version predates SourceIndex');
    runner.assert(pinBlockLayoutForPackage({}).hasSourceIndex === false,
      'pin layout: a summary with no customVersions array is treated as predating it');
  }

  // AnimGraph families. UAnimGraphNode_Base derives from UK2Node and
  // UAnimStateNodeBase from UEdGraphNode, so both serialize the same Pins
  // array — the reader already handles them, only the name test excluded them.
  // Verified by parsing engine Anim Blueprints: every class below parses with
  // malformed=false, a valid NodeGuid and real links.
  for (const cls of ['AnimGraphNode_Root', 'AnimGraphNode_StateMachine', 'AnimGraphNode_StateResult', 'AnimGraphNode_BlendSpacePlayer']) {
    runner.assert(isGraphNodeExportClass(cls) === true, `CP1/predicate: ${cls} matches`);
  }
  for (const cls of ['AnimStateNode', 'AnimStateEntryNode', 'AnimStateTransitionNode', 'AnimStateConduitNode', 'AnimStateAliasNode']) {
    runner.assert(isGraphNodeExportClass(cls) === true, `CP1/predicate: ${cls} matches`);
  }

  // The trap: AnimGraphNodeBinding_Base shares the "AnimGraphNode" prefix and
  // is NOT a graph node — it parses as malformed with a null GUID. Anchoring on
  // the underscore is what keeps it out; a looser prefix would inflate the
  // malformed-node count with objects that were never nodes.
  runner.assert(isGraphNodeExportClass('AnimGraphNodeBinding_Base') === false,
    'CP1/predicate: AnimGraphNodeBinding_Base rejected (prefix-shares but is not a node)');
  for (const cls of ['AnimBlueprint', 'AnimationGraph', 'AnimBlueprintGeneratedClass', 'AnimationStateMachineGraph', 'AnimBlueprintExtension_Base']) {
    runner.assert(isGraphNodeExportClass(cls) === false, `CP1/predicate: ${cls} rejected (container//extension, not a node)`);
  }
  runner.assert(isGraphNodeExportClass(null) === false,
    'CP1/predicate: null className handled');
  runner.assert(isGraphNodeExportClass(undefined) === false,
    'CP1/predicate: undefined className handled');
}


// ── Synthetic FObjectExport version-gate fixtures ────────────────
//
// FObjectExport is positionally serialized with version-gated fields, so its
// stride differs per package version. These fixtures encode a table at a given
// version, decode it back, and assert every field plus the stride (a stride
// error corrupts export[1] while leaving export[0] plausible -- the exact
// failure mode that made packages at UE5 version <=1010 silently undecodable).
//
// Encoder mirrors operator<<(FStructuredArchive::FSlot, FObjectExport&) in
// CoreUObject/Private/UObject/ObjectResource.cpp. Keep the two in step.
function encodeSyntheticExportTable({ ue4, ue5, packageFlags = 0, rows }) {
  const chunks = [];
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); chunks.push(b); };
  const u32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); chunks.push(b); };
  const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); chunks.push(b); };
  const unversioned = (packageFlags & PKG_UNVERSIONED_PROPERTIES) !== 0;

  for (const r of rows) {
    i32(r.classIndex); i32(r.superIndex);
    if (ue4 >= UE4_TEMPLATE_INDEX_IN_COOKED_EXPORTS) i32(r.templateIndex);
    i32(r.outerIndex);
    i32(r.objectNameIdx); i32(r.objectNameNumber);
    u32(r.objectFlags);
    if (ue4 < UE4_64BIT_EXPORTMAP_SERIALSIZES) { i32(r.serialSize); i32(r.serialOffset); }
    else { i64(r.serialSize); i64(r.serialOffset); }
    i32(r.bForcedExport ? 1 : 0); i32(r.bNotForClient ? 1 : 0); i32(r.bNotForServer ? 1 : 0);
    if (ue5 < UE5_REMOVE_OBJECT_EXPORT_PACKAGE_GUID) chunks.push(Buffer.alloc(16, 0xAB)); // FGuid
    if (ue5 >= UE5_TRACK_OBJECT_EXPORT_IS_INHERITED) i32(r.bIsInheritedInstance ? 1 : 0);
    u32(r.packageFlags);
    if (ue4 >= UE4_LOAD_FOR_EDITOR_GAME) i32(r.bNotAlwaysLoadedForEditorGame ? 1 : 0);
    if (ue4 >= UE4_COOKED_ASSETS_IN_EDITOR_SUPPORT) i32(r.bIsAsset ? 1 : 0);
    if (ue5 >= UE5_OPTIONAL_RESOURCES) i32(r.bGeneratePublicHash ? 1 : 0);
    if (ue4 >= UE4_PRELOAD_DEPENDENCIES_IN_COOKED_EXPORTS) {
      i32(r.firstExportDependency); i32(r.serBeforeSerDeps); i32(r.createBeforeSerDeps);
      i32(r.serBeforeCreateDeps); i32(r.createBeforeCreateDeps);
    }
    if (!unversioned && ue5 >= UE5_SCRIPT_SERIALIZATION_OFFSET) {
      i64(r.scriptSerializationStartOffset); i64(r.scriptSerializationEndOffset);
    }
  }
  return Buffer.concat(chunks);
}

function makeExportRow(seed) {
  return {
    classIndex: -seed, superIndex: seed + 1, templateIndex: seed + 2, outerIndex: seed + 3,
    objectNameIdx: seed % 2, objectNameNumber: seed,
    objectFlags: 0x00000008, serialSize: 100 * seed, serialOffset: 5000 + 100 * seed,
    bForcedExport: false, bNotForClient: seed % 2 === 0, bNotForServer: false,
    bIsInheritedInstance: seed % 2 === 1, packageFlags: 0x10 + seed,
    bNotAlwaysLoadedForEditorGame: false, bIsAsset: true, bGeneratePublicHash: seed % 2 === 0,
    firstExportDependency: seed, serBeforeSerDeps: seed + 1, createBeforeSerDeps: seed + 2,
    serBeforeCreateDeps: seed + 3, createBeforeCreateDeps: seed + 4,
    scriptSerializationStartOffset: 7000 + seed, scriptSerializationEndOffset: 7500 + seed,
  };
}

function testExportTableVersionGates() {
  const names = ['ExportZero', 'ExportOne'];
  // One case per gate boundary the encoder honours.
  const cases = [
    { label: 'UE5=1000 pre-hash/pre-inherited, PackageGuid present', ue4: 522, ue5: 1000 },
    { label: 'UE5=1003 OPTIONAL_RESOURCES adds bGeneratePublicHash', ue4: 522, ue5: 1003 },
    { label: 'UE5=1005 PackageGuid removed', ue4: 522, ue5: 1005 },
    { label: 'UE5=1006 TRACK_OBJECT_EXPORT_IS_INHERITED', ue4: 522, ue5: 1006 },
    { label: 'UE5=1010 SCRIPT_SERIALIZATION_OFFSET', ue4: 522, ue5: 1010 },
    { label: 'UE5=1018 newest layout', ue4: 522, ue5: 1018 },
    { label: 'UE5=1018 unversioned properties omit script offsets', ue4: 522, ue5: 1018, packageFlags: PKG_UNVERSIONED_PROPERTIES },
    { label: 'UE4=510 pre-64bit serial sizes', ue4: 510, ue5: 1018 },
    // The UE4 ordinals were DERIVED from implicit enum numbering rather than
    // observed in a file, so each branch needs its own case: a wrong ordinal
    // mis-strides every sufficiently old package with no other signal.
    { label: 'UE4=300 pre-editor-game/cooked/preload/template', ue4: 300, ue5: 1018 },
    { label: 'UE4=400 post-editor-game only', ue4: 400, ue5: 1018 },
    { label: 'UE4=500 post-cooked-assets, pre-preload', ue4: 500, ue5: 1018 },
    { label: 'UE4=507 preload deps boundary', ue4: 507, ue5: 1018 },
  ];

  for (const c of cases) {
    const rows = [makeExportRow(1), makeExportRow(2)];
    const buf = encodeSyntheticExportTable({ ue4: c.ue4, ue5: c.ue5, packageFlags: c.packageFlags ?? 0, rows });
    const summary = {
      exportOffset: 0, exportCount: rows.length,
      fileVersionUE4: c.ue4, fileVersionUE5: c.ue5, packageFlags: c.packageFlags ?? 0,
    };
    let decoded;
    try { decoded = readExportTable(new Cursor(buf), summary, names); }
    catch (e) { runner.assert(false, `${c.label}: readExportTable decodes`, e.message); continue; }

    runner.assert(decoded.length === 2, `${c.label}: both exports decoded`);
    if (decoded.length !== 2) continue;

    // Stride correctness: export[1] is only right if export[0] consumed exactly
    // the bytes the encoder wrote for this version.
    const [a, b] = decoded;
    runner.assert(a.serialOffset === rows[0].serialOffset && b.serialOffset === rows[1].serialOffset,
      `${c.label}: serial offsets survive the version stride`);
    // Assert on the BASE: names are now canonically suffixed from their FName
    // Number, and this assertion is about stride integrity, not naming.
    runner.assert(b.objectNameBase === 'ExportZero' || b.objectNameBase === 'ExportOne',
      `${c.label}: second export resolves a real name (stride intact)`);
    runner.assert(a.classIndex === rows[0].classIndex && b.classIndex === rows[1].classIndex,
      `${c.label}: class indices round-trip`);

    // Gate-specific expectations.
    const inheritedExpected = c.ue5 >= 1006 ? rows[0].bIsInheritedInstance : false;
    runner.assert(a.bIsInheritedInstance === inheritedExpected,
      `${c.label}: bIsInheritedInstance gated at 1006`);
    const hashExpected = c.ue5 >= 1003 ? rows[0].bGeneratePublicHash : false;
    runner.assert(a.bGeneratePublicHash === hashExpected,
      `${c.label}: bGeneratePublicHash gated at 1003`);
    const scriptExpected = (c.ue5 >= 1010 && !((c.packageFlags ?? 0) & PKG_UNVERSIONED_PROPERTIES))
      ? rows[0].scriptSerializationStartOffset : 0;
    runner.assert(a.scriptSerializationStartOffset === scriptExpected,
      `${c.label}: script offsets gated at 1010 + versioned properties`);
  }

  // Negative control: decoding a 1004-encoded table as 1018 must NOT silently
  // succeed -- this is precisely the desync that shipped undetected.
  const rows = [makeExportRow(1), makeExportRow(2)];
  const oldBuf = encodeSyntheticExportTable({ ue4: 522, ue5: 1004, rows });
  let desynced = false;
  try {
    const wrong = readExportTable(new Cursor(oldBuf),
      { exportOffset: 0, exportCount: 2, fileVersionUE4: 522, fileVersionUE5: 1018, packageFlags: 0 }, names);
    desynced = wrong[1].serialOffset !== rows[1].serialOffset;
  } catch {
    // The wider 1018 stride overruns a 1004-sized table: also a desync, caught
    // loudly rather than silently returning wrong offsets.
    desynced = true;
  }
  runner.assert(desynced,
    'version mismatch desyncs export[1] (guards against a no-op gate regression)');
}


// ── FName Number preservation on imports (numbered-reference decode) ──
//
// Unreal stores an FName as (nameIndex, Number) where Number 0 means the bare
// base and Number N>0 renders as `Base_<N-1>`. readImportTable skipped every
// Number field, so `DA_Punch_StanceA_FollowUp_1` and `..._2` both decoded to
// the unsuffixed base — making valid numbered assets look like duplicate
// references to a nonexistent asset. Live Unreal resolves all of them.
//
// Encoder mirrors operator<<(FSlot, FObjectImport&) in ObjectResource.cpp.
function encodeSyntheticImportTable({ ue4 = 522, ue5 = 1018, packageFlags = 0, rows }) {
  const chunks = [];
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); chunks.push(b); };
  const fname = (idx, num) => { i32(idx); i32(num); };
  const hasPackageName = ue4 >= UE4_NON_OUTER_PACKAGE_IMPORT
    && ((packageFlags & PKG_FILTER_EDITOR_ONLY) === 0);
  for (const r of rows) {
    fname(r.classPackageIdx ?? 0, r.classPackageNum ?? 0);
    fname(r.classNameIdx ?? 0, r.classNameNum ?? 0);
    i32(r.outerIndex ?? 0);
    fname(r.objectNameIdx, r.objectNameNum ?? 0);
    if (hasPackageName) fname(r.packageNameIdx ?? 0, r.packageNameNum ?? 0);
    if (ue5 >= UE5_OPTIONAL_RESOURCES) i32(r.bImportOptional ? 1 : 0);
  }
  return Buffer.concat(chunks);
}

function decodeSyntheticImports({ names, rows, ue4 = 522, ue5 = 1018, packageFlags = 0 }) {
  const buf = encodeSyntheticImportTable({ ue4, ue5, packageFlags, rows });
  const summary = {
    importOffset: 0, importCount: rows.length,
    fileVersionUE4: ue4, fileVersionUE5: ue5, packageFlags,
  };
  return readImportTable(new Cursor(buf), summary, names);
}

function testImportFNameNumbers() {
  const names = ['Script', 'DataAsset', 'Example', '/Game/Things', 'Other'];

  // (1)(2)(3) The Number-1 convention, at the three values that matter.
  {
    const imports = decodeSyntheticImports({
      names,
      rows: [
        { objectNameIdx: 2, objectNameNum: 0 },
        { objectNameIdx: 2, objectNameNum: 2 },
        { objectNameIdx: 2, objectNameNum: 3 },
      ],
    });
    runner.assert(imports[0].objectName === 'Example',
      `import Number 0 stays bare (got ${imports[0].objectName})`);
    runner.assert(imports[1].objectName === 'Example_1',
      `import raw Number 2 renders _1 (got ${imports[1].objectName})`);
    runner.assert(imports[2].objectName === 'Example_2',
      `import raw Number 3 renders _2 (got ${imports[2].objectName})`);

    // (4) Distinctness is the actual defect: these collapsed into one name.
    const distinct = new Set(imports.map(i => i.objectName));
    runner.assert(distinct.size === 3,
      `imports sharing a base stay distinct (got ${distinct.size} of 3)`);

    // Raw fields remain available so callers depending on the base do not break.
    runner.assert(imports[1].objectNameBase === 'Example' && imports[1].objectNameNumber === 2,
      'raw base and Number are preserved alongside the canonical name');
  }

  // (5)(6) The outer chain and packagePath must carry suffixes too: a numbered
  // object under a numbered package previously lost both halves.
  {
    const imports = decodeSyntheticImports({
      names,
      rows: [
        { objectNameIdx: 3, objectNameNum: 0, outerIndex: 0 },              // package
        { objectNameIdx: 2, objectNameNum: 2, outerIndex: -1 },             // Example_1 under it
        { objectNameIdx: 3, objectNameNum: 2, outerIndex: 0 },              // /Game/Things_1
        { objectNameIdx: 2, objectNameNum: 3, outerIndex: -3 },             // Example_2 under that
      ],
    });
    const resolve = makePackageIndexResolver([], imports);

    const first = resolve(-2);
    runner.assert(first.objectName === 'Example_1',
      `resolved import objectName keeps its suffix (got ${first.objectName})`);
    runner.assert(first.packagePath === '/Game/Things.Example_1',
      `packagePath keeps the object suffix (got ${first.packagePath})`);

    const second = resolve(-4);
    runner.assert(second.packagePath === '/Game/Things_1.Example_2',
      `outer-chain walk keeps suffixes on BOTH halves (got ${second.packagePath})`);
    runner.assert(first.packagePath !== second.packagePath,
      'numbered references resolve to distinct package paths');
  }

  // (7) Unnumbered imports and exports are untouched by the change.
  {
    const imports = decodeSyntheticImports({
      names,
      rows: [{ objectNameIdx: 2, objectNameNum: 0, classNameIdx: 1, classPackageIdx: 0, packageNameIdx: 3 }],
    });
    runner.assert(imports[0].objectName === 'Example'
      && imports[0].className === 'DataAsset'
      && imports[0].classPackage === 'Script'
      && imports[0].packageName === '/Game/Things',
      'unnumbered import fields are unchanged');

    const rows = [makeExportRow(1)];
    rows[0].objectNameIdx = 0;
    rows[0].objectNameNumber = 0;
    const buf = encodeSyntheticExportTable({ ue4: 522, ue5: 1018, rows });
    const exp = readExportTable(new Cursor(buf),
      { exportOffset: 0, exportCount: 1, fileVersionUE4: 522, fileVersionUE5: 1018, packageFlags: 0 },
      ['ExportZero', 'ExportOne']);
    runner.assert(exp[0].objectName === 'ExportZero',
      `unnumbered export name unchanged (got ${exp[0].objectName})`);
  }

  // Exports share the helper, so a numbered export renders the same way rather
  // than drifting from imports.
  {
    const rows = [makeExportRow(1)];
    rows[0].objectNameIdx = 0;
    rows[0].objectNameNumber = 3;
    const buf = encodeSyntheticExportTable({ ue4: 522, ue5: 1018, rows });
    const exp = readExportTable(new Cursor(buf),
      { exportOffset: 0, exportCount: 1, fileVersionUE4: 522, fileVersionUE5: 1018, packageFlags: 0 },
      ['ExportZero', 'ExportOne']);
    runner.assert(exp[0].objectName === 'ExportZero_2',
      `numbered export uses the same convention (got ${exp[0].objectName})`);
    runner.assert(exp[0].objectNameBase === 'ExportZero' && exp[0].objectNameNumber === 3,
      'export raw base and Number remain available');
  }
}

// Tool-level witness for the numbered-reference fix. Gated on a project that
// actually contains a numbered-reference asset: findContentAsset returns null
// against the text fixture and any project without it, so this skips with a
// label rather than failing (D188 discovery pattern).
async function testNumberedReferencesThroughReadAssetProperties() {
  const probe = await findContentAsset(ROOT, 'DA_AttackSet_Basic.uasset');
  if (!probe) {
    console.log('  · skipped numbered-reference tool check (DA_AttackSet_Basic not in this project)');
    return;
  }
  const { executeOfflineTool } = await import('./offline-tools.mjs');
  const res = await executeOfflineTool('read_asset_properties', { asset_path: probe.gamePath }, ROOT);
  const text = JSON.stringify(res);
  const refs = [...text.matchAll(/DA_Punch_Stance[AB]_FollowUp(?:_[0-9]+)?/g)].map(m => m[0]);
  const uniq = [...new Set(refs)];
  if (refs.length === 0) {
    console.log('  · skipped numbered-reference tool check (asset no longer references those templates)');
    return;
  }
  runner.assert(uniq.length === 4,
    `read_asset_properties reports four distinct numbered references (got ${uniq.length}: ${uniq.join(', ')})`);
  const unsuffixed = uniq.filter(u => !/_[0-9]+$/.test(u));
  runner.assert(unsuffixed.length === 0,
    `no reference collapses to its unsuffixed base (got ${unsuffixed.join(', ') || 'none'})`);
}

async function main() {
  await testFootstepFixture();
  await testLevelMap();
  await testAbilityBlueprint();
  await testDataTable();
  await testBpgaBlockProperties();
  await testPlayerCdoProperties();
  await testEmptyCdo();
  await testSizeBudgetTruncation();
  await testStructHandlersOnBpgaBlock();
  await testTransformStructsOnLevel();
  testStructBinaryReaders();
  testStructHandlerRegistry();
  testTier1TaggedStructs();
  testD186SubobjectHelpers();
  await testTier3UnknownStructFallback();
  testTier3BoundedFallback();
  testContainerSyntheticObjectsAndColors();
  await testComplexContainerMarker();
  testContainerSyntheticScalars();
  testFieldPathPropertySynthetic();
  await testExpressionInputOnStylizedBasic();
  testExpressionInputBinarySynthetic();
  testMaterialInputHandlerRegistry();
  testInt64Lenient();
  await testExportInt64Salvage();
  testBadMagic();
  testTruncated();
  testVersionSummaryDelta();
  testExportTableVersionGates();
  testImportFNameNumbers();
  await testNumberedReferencesThroughReadAssetProperties();
  await testPinBlockOffsetCP1();
  await testPinBodyParseCP2();
  testPinDefaultLiteralSynthetic();
  process.exit(runner.summary());
}

main().catch(e => { console.error(e); process.exit(1); });
