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
  parsePinBlock,
  PACKAGE_FILE_TAG,
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
import { TestRunner } from './test-helpers.mjs';

const runner = new TestRunner('uasset-parser format tests');

const ROOT = process.env.UNREAL_PROJECT_ROOT || '';

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
                  ['serialSize', 'serialOffset', 'publicExportHash',
                   'scriptSerializationStartOffset', 'scriptSerializationEndOffset'].includes(f)),
                'SM_auraHousya: overflow fields are from the six int64 export fields');

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
  const path = join(ROOT, 'Content/GAS/Abilities/BPGA_Block.uasset');
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

  // The CDO has 9 tagged properties — commit 1 handles scalars + object refs
  // and emits markers for the 6 struct / container properties.
  runner.assert(r.propertyCount === 9, 'BPGA_Block: 9 properties walked', `got=${r.propertyCount}`);
  runner.assert(r.bytesConsumed === 765, 'BPGA_Block: bytesConsumed matches serialSize minus None+trailer',
                `got=${r.bytesConsumed}, expected 769-4=765`);

  // Scalars + refs resolve cleanly.
  runner.assert(r.properties.DrainCheckInterval === 0.5,
                'BPGA_Block: FloatProperty DrainCheckInterval = 0.5',
                `got=${r.properties.DrainCheckInterval}`);
  runner.assert(r.properties.GuardBreakEffectClass &&
                r.properties.GuardBreakEffectClass.packagePath ===
                '/Game/GAS/Effects/BPGE_OSGuardBreak.BPGE_OSGuardBreak_C',
                'BPGA_Block: ObjectProperty GuardBreakEffectClass resolves to /Game path via outer-chain walk');
  runner.assert(r.properties.ChooserTable?.packagePath ===
                '/Game/Data/ChooserTable/CT_OSBlocks.CT_OSBlocks',
                'BPGA_Block: ObjectProperty ChooserTable resolves');

  // Structs without a registered handler but with tagged serialization
  // (flag 0x00) decode via tier-3 tagged fallback even without structHandlers.
  // IsBlocking/IsBroken are FGameplayTag — tagged sub-stream with TagName FName.
  runner.assert(r.properties.IsBlocking?.TagName === 'Gameplay.State.Guard.IsActive',
                'BPGA_Block T3: IsBlocking decodes via tagged fallback (TagName field)',
                `got=${JSON.stringify(r.properties.IsBlocking)}`);
  runner.assert(r.properties.IsBroken?.TagName === 'Gameplay.State.Guard.IsBroken',
                'BPGA_Block T3: IsBroken decodes via tagged fallback');

  // Container properties → container_deferred marker (no containerHandlers passed).
  runner.assert(r.properties.DrainPerSecond?.reason === 'container_deferred',
                'BPGA_Block: ArrayProperty DrainPerSecond emits container_deferred marker');

  // Native-binary unknown structs (flag 0x08) stay unsupported — fallback is
  // tagged-only. FGameplayTagContainer writes its count + names as native binary.
  const namedUnsupported = r.unsupported.map(u => u.name);
  for (const n of ['DrainPerSecond', 'CancelAbilitiesWithTag',
                    'ActivationOwnedTags', 'ActivationBlockedTags']) {
    runner.assert(namedUnsupported.includes(n),
                  `BPGA_Block: unsupported list still names ${n} (native binary / deferred container)`);
  }
}

// ── Fixture 6: Level 1 property stream — BP_OSPlayerR CDO ─────────────
//
// Larger CDO (25 tagged properties) with a mix of scalar, bool, object-ref,
// and struct types. Verifies the flag-byte logic (BoolTrue encoding) and
// exercise the resolver against both export-local and imported refs.
async function testPlayerCdoProperties() {
  const path = join(ROOT, 'Content/Blueprints/Character/BP_OSPlayerR.uasset');
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
  const path = join(ROOT, 'Content/Animations/AN_OSAnimNotify_Footstep.uasset');
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
  const resolve = makePackageIndexResolver(exports, imports);

  const cdo = exports.find(e => e.objectName.startsWith('Default__'));
  const r = readExportProperties(buf, cdo, names, { resolve });

  runner.assert(r.propertyCount === 0, 'Footstep: empty CDO has 0 properties');
  runner.assert(r.unsupported.length === 0, 'Footstep: no unsupported markers for empty CDO');
  runner.assert(r.bytesConsumed === 9, 'Footstep: consumed preamble(1) + None FName(8) = 9 bytes');
}

// ── Size-budget truncation — synthetic budget below stream size ─────
async function testSizeBudgetTruncation() {
  const path = join(ROOT, 'Content/Blueprints/Character/BP_OSPlayerR.uasset');
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
  const path = join(ROOT, 'Content/GAS/Abilities/BPGA_Block.uasset');
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

  // FGameplayTag (tagged sub-stream) — value decodes to a TagName string.
  runner.assert(r.properties.IsBlocking?.tagName === 'Gameplay.State.Guard.IsActive',
                'L2: FGameplayTag IsBlocking resolves to tag name',
                `got=${JSON.stringify(r.properties.IsBlocking)}`);
  runner.assert(r.properties.IsBroken?.tagName === 'Gameplay.State.Guard.IsBroken',
                'L2: FGameplayTag IsBroken resolves');

  // FGameplayTagContainer (native binary) — int32 count + N × FName.
  runner.assert(Array.isArray(r.properties.CancelAbilitiesWithTag?.tags),
                'L2: FGameplayTagContainer returns tags array');
  runner.assert(r.properties.CancelAbilitiesWithTag.tags[0] === 'Gameplay.Ability',
                'L2: single-tag container resolves correctly');
  runner.assert(r.properties.ActivationBlockedTags.tags.length === 5,
                'L2: 5-tag container resolves all 5 tags');
  runner.assert(r.properties.ActivationBlockedTags.tags.includes('Gameplay.State.IsDead'),
                'L2: tag names match expected values');

  // Full unsupported list should now be short — only the ArrayProperty (deferred to L2.5).
  const nonBudgetUnsupported = r.unsupported.filter(u => u.reason !== 'size_budget_exceeded');
  runner.assert(nonBudgetUnsupported.length === 1,
                'L2: BPGA_Block CDO has only 1 unsupported property (DrainPerSecond array, pending L2.5)',
                `got=${nonBudgetUnsupported.length}: ${nonBudgetUnsupported.map(u => u.name).join(',')}`);
  runner.assert(nonBudgetUnsupported[0]?.name === 'DrainPerSecond',
                'L2: remaining unsupported is DrainPerSecond');
}

// ── Fixture 9: Level 2 FVector + FRotator on level component exports ──
//
// V9.5 §2 hand-traced CollisionCapsule [503] and LightComponent0 [518] in
// Main_MenuVersion.umap as components with native-binary FVector/FRotator
// transform overrides. This test pins specific coordinates so regressions
// that flip endian or swap field order fail loudly.
async function testTransformStructsOnLevel() {
  const path = join(ROOT, 'Content/Maps/Non-Deployable/Main_MenuVersion.umap');
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

// ── Tagged-stream synthesizers (used by tier 1 + later tests) ──────
function writeFName(name, names) {
  // Returns Buffer (8B): int32 idx + int32 number. Expects name to exist
  // already in the names array (caller owns the table).
  const idx = names.indexOf(name);
  if (idx < 0) throw new Error(`FName ${name} not in names[]`);
  const b = Buffer.alloc(8); b.writeInt32LE(idx, 0); b.writeInt32LE(0, 4); return b;
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
  const path = join(ROOT, 'Content/Blueprints/Character/BP_OSPlayerR.uasset');
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
  const path = join(ROOT, 'Content/GAS/Abilities/BPGA_Block.uasset');
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
  runner.assert(Array.isArray(drain) && drain.length >= 1,
                'T2: TArray<FOSResource> decodes as array of struct entries');
  runner.assert(drain?.[0]?.Attribute && 'AttributeName' in drain[0].Attribute,
                'T2: FOSResource.Attribute (FGameplayAttribute) decodes with AttributeName field');
  runner.assert('Amount' in (drain?.[0] ?? {}),
                'T2: FOSResource.Amount scalar preserved in decoded entry');

  // Parser-Extensions Item 2: FieldPathProperty L1 dispatcher. FGameplayAttribute
  // carries a TFieldPath<FProperty> Attribute member that previously emitted
  // `unknown_property_type` markers. It now decodes to {path: [FName...], owner: resolved}.
  const fp = drain?.[0]?.Attribute?.Attribute;
  runner.assert(fp && Array.isArray(fp.path),
                'FieldPath Item 2: FGameplayAttribute.Attribute decodes to {path, owner}',
                `got=${JSON.stringify(fp)}`);
  runner.assert(fp?.path?.length >= 1 && typeof fp.path[0] === 'string',
                'FieldPath Item 2: path array contains FName strings',
                `got path=${JSON.stringify(fp?.path)}`);
  // No leftover unknown_property_type markers for FieldPathProperty in this CDO.
  const fpMarkers = r.unsupported.filter(u => u.reason === 'unknown_property_type' && u.detail === 'FieldPathProperty');
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
  const path = join(ROOT, 'Content/ImportedAssets/SoStylized/Materials/M_StylizedBasic.uasset');
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
  runner.assert(bc && bc.expression && bc.expression.objectName === 'MaterialExpressionNamedRerouteUsage',
                'ExprInput: BaseColor.Expression resolves to MaterialExpressionNamedRerouteUsage export',
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
}

// ── CP2 (S-B-base, M-new): pin-body parse — PinId + Direction ──────
//
// Validates parsePinBlock's pin body walker. For every pin whose PinId
// appears in BOTH parser output and Oracle, the direction MUST match.
// The cross-set mismatch is structural (UE PostLoad pin regeneration in
// K2Node_FunctionEntry / K2Node_PromotableOperator) and is asserted as
// a known finding, not a regression.
async function testPinBodyParseCP2() {
  const FIXTURES_DIR = 'D:/DevTools/UEMCP/plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures';
  const FIXTURES = [
    ['BP_OSPlayerR_Child',  'Content/Blueprints/Character/BP_OSPlayerR_Child.uasset',  'BP_OSPlayerR_Child.oracle.json'],
    ['BP_OSPlayerR_Child1', 'Content/Blueprints/Character/BP_OSPlayerR_Child1.uasset', 'BP_OSPlayerR_Child1.oracle.json'],
    ['BP_OSPlayerR_Child2', 'Content/Blueprints/Character/BP_OSPlayerR_Child2.uasset', 'BP_OSPlayerR_Child2.oracle.json'],
    ['TestCharacter',       'Content/Blueprints/Character/TestCharacter.uasset',       'TestCharacter.oracle.json'],
  ];

  for (const [fxName, relPath, oracleName] of FIXTURES) {
    const assetPath = join(ROOT, relPath);
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
async function testPinBlockOffsetCP1() {
  const FIXTURES_DIR = 'D:/DevTools/UEMCP/plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures';
  const FIXTURES = [
    { name: 'BP_OSPlayerR',       relPath: 'Content/Blueprints/Character/BP_OSPlayerR.uasset',       oracle: 'BP_OSPlayerR.oracle.json',       expectedGraphNodes: 204 },
    { name: 'BP_OSPlayerR_Child', relPath: 'Content/Blueprints/Character/BP_OSPlayerR_Child.uasset', oracle: 'BP_OSPlayerR_Child.oracle.json', expectedGraphNodes: 6 },
    { name: 'BP_OSPlayerR_Child1', relPath: 'Content/Blueprints/Character/BP_OSPlayerR_Child1.uasset', oracle: 'BP_OSPlayerR_Child1.oracle.json', expectedGraphNodes: 6 },
    { name: 'BP_OSPlayerR_Child2', relPath: 'Content/Blueprints/Character/BP_OSPlayerR_Child2.uasset', oracle: 'BP_OSPlayerR_Child2.oracle.json', expectedGraphNodes: 6 },
    { name: 'TestCharacter',      relPath: 'Content/Blueprints/Character/TestCharacter.uasset',      oracle: 'TestCharacter.oracle.json',      expectedGraphNodes: 11 },
    { name: 'BP_OSControlPoint',  relPath: 'Content/Blueprints/Level/BP_OSControlPoint.uasset',      oracle: 'BP_OSControlPoint.oracle.json',  expectedGraphNodes: 223 },
  ];

  for (const fx of FIXTURES) {
    const assetPath = join(ROOT, fx.relPath);
    const oraclePath = join(FIXTURES_DIR, fx.oracle);
    if (!(await exists(assetPath)) || !(await exists(oraclePath))) {
      console.log(`  · skipped CP1/${fx.name} (missing asset or oracle)`);
      continue;
    }
    const buf = await readFile(assetPath);
    const oracle = JSON.parse((await readFile(oraclePath)).toString('utf8'));

    const cur = new Cursor(buf);
    const s = parseSummary(cur);
    const names = readNameTable(cur, s);
    const imports = readImportTable(cur, s, names);
    const exports = readExportTable(cur, s, names);
    const resolver = makePackageIndexResolver(exports, imports);
    const parseOpts = { resolve: resolver, structHandlers: buildStructHandlers() };

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
  runner.assert(isGraphNodeExportClass(null) === false,
    'CP1/predicate: null className handled');
  runner.assert(isGraphNodeExportClass(undefined) === false,
    'CP1/predicate: undefined className handled');
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
  await testPinBlockOffsetCP1();
  await testPinBodyParseCP2();
  process.exit(runner.summary());
}

main().catch(e => { console.error(e); process.exit(1); });
