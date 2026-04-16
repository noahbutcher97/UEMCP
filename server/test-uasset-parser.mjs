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
  readImportTable,
  readExportTable,
  readAssetRegistryData,
  readExportProperties,
  makePackageIndexResolver,
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
} from './uasset-structs.mjs';
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

  // Structs not in commit-1 registry → unsupported with struct name.
  runner.assert(r.properties.IsBlocking?.unsupported === true,
                'BPGA_Block: StructProperty IsBlocking emits unsupported marker');
  runner.assert(r.properties.IsBlocking?.reason === 'unknown_struct',
                'BPGA_Block: IsBlocking reason = unknown_struct');
  runner.assert(r.properties.IsBlocking?.size_bytes === 41,
                'BPGA_Block: IsBlocking size_bytes preserved for size-budget reasoning');

  // Container properties → container_deferred marker (will be filled in commit 3).
  runner.assert(r.properties.DrainPerSecond?.reason === 'container_deferred',
                'BPGA_Block: ArrayProperty DrainPerSecond emits container_deferred marker');

  // Every unsupported value has a corresponding entry in the unsupported list.
  const namedUnsupported = r.unsupported.map(u => u.name);
  for (const n of ['IsBlocking', 'IsBroken', 'DrainPerSecond', 'CancelAbilitiesWithTag',
                    'ActivationOwnedTags', 'ActivationBlockedTags']) {
    runner.assert(namedUnsupported.includes(n),
                  `BPGA_Block: unsupported list names ${n}`);
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
}

// ── Struct handler registry coverage ──────────────────────────────
function testStructHandlerRegistry() {
  const h = buildStructHandlers();
  for (const s of ['Vector', 'Vector2D', 'Rotator', 'Quat', 'Transform',
                   'LinearColor', 'Color', 'Guid', 'GameplayTag',
                   'GameplayTagContainer', 'SoftObjectPath']) {
    runner.assert(h.has(s) && typeof h.get(s) === 'function',
                  `L2: struct handler registry contains ${s}`);
  }
}

// ── Fixture 10: Level 2.5 — simple-element containers (D46) ────────
//
// BP_OSPlayerR CDO has three simple-element containers that exercise different
// inner-type paths:
//   - Rigged Character 2Colours: TArray<FLinearColor> (struct, native binary, flag 0x08)
//   - DefaultAbilities:          TArray<ObjectProperty> (scalar, inline raw)
//   - DefaultEffects:            TArray<ObjectProperty> (scalar, inline raw)
// Plus BPGA_Block's DrainPerSecond: TArray<FOSResource> (custom struct →
// complex_element_container marker).
async function testContainerHandlersOnPlayer() {
  const path = join(ROOT, 'Content/Blueprints/Character/BP_OSPlayerR.uasset');
  if (!(await exists(path))) { console.log('  · skipped L2.5 container test (no file)'); return; }
  const buf = await readFile(path);
  const cur = new Cursor(buf);
  const s = parseSummary(cur);
  const names = readNameTable(cur, s);
  const imports = readImportTable(cur, s, names);
  const exports = readExportTable(cur, s, names);
  const resolve = makePackageIndexResolver(exports, imports);
  const structHandlers = buildStructHandlers();
  const containerHandlers = buildContainerHandlers();
  const cdo = exports.find(e => e.objectName === 'Default__BP_OSPlayerR_C');
  const r = readExportProperties(buf, cdo, names, { resolve, structHandlers, containerHandlers });

  // TArray<FLinearColor> — native binary (flag 0x08 on outer). 4 colors.
  const colors = r.properties['Rigged Character 2Colours'];
  runner.assert(Array.isArray(colors),
                'L2.5: Rigged Character 2Colours decodes as array',
                `got=${typeof colors}`);
  runner.assert(colors?.length === 4,
                'L2.5: TArray<FLinearColor> count=4',
                `got=${colors?.length}`);
  runner.assert(colors?.[0]?.r === 1 && colors?.[0]?.g === 0 && colors?.[0]?.b === 0 && colors?.[0]?.a === 1,
                'L2.5: TArray<FLinearColor>[0] = pure red RGBA(1,0,0,1)');

  // TArray<ObjectProperty> — scalar inline raw (4 bytes FPackageIndex each).
  const abilities = r.properties.DefaultAbilities;
  runner.assert(Array.isArray(abilities) && abilities.length === 15,
                'L2.5: TArray<ObjectProperty> DefaultAbilities has 15 entries',
                `got=${abilities?.length}`);
  runner.assert(abilities?.every(a => typeof a.objectName === 'string'),
                'L2.5: each DefaultAbilities entry resolves to a named import/export');
  runner.assert(abilities?.some(a => a.objectName === 'BPGA_Dodge_C'),
                'L2.5: DefaultAbilities includes BPGA_Dodge_C');

  // TArray<ObjectProperty> (GameplayEffects).
  const effects = r.properties.DefaultEffects;
  runner.assert(Array.isArray(effects) && effects.length === 3,
                'L2.5: TArray<ObjectProperty> DefaultEffects has 3 entries',
                `got=${effects?.length}`);
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

  const drain = r.properties.DrainPerSecond;
  runner.assert(drain?.unsupported === true,
                'L2.5: TArray<FOSResource> (custom struct) → unsupported marker');
  runner.assert(drain?.reason === 'complex_element_container',
                'L2.5: reason = complex_element_container (D46 boundary)');
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

  // TMap remains container_deferred (handled in dispatch, not here).
  // Complex-element marker test — TArray<StructProperty<UnknownStruct>>
  {
    const tag = { flags: 0x00, size: 100, type: 'ArrayProperty',
                  typeParams: [{ name: 'StructProperty',
                                 params: [{ name: 'UnknownCustomStruct', params: [] }] }] };
    const buf = Buffer.alloc(100);
    buf.writeInt32LE(1, 0);
    const result = containerHandlers.get('ArrayProperty')(new Cursor(buf), tag, [],
                                                          { structHandlers });
    runner.assert(result && result.__unsupported__ === true,
                  'L2.5 synth: TArray<UnknownStruct> → complex_element_container marker');
    runner.assert(result.reason === 'complex_element_container',
                  'L2.5 synth: marker reason correct');
  }
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
  await testContainerHandlersOnPlayer();
  await testComplexContainerMarker();
  testContainerSyntheticScalars();
  testBadMagic();
  testTruncated();
  process.exit(runner.summary());
}

main().catch(e => { console.error(e); process.exit(1); });
