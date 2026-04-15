// test-offline-asset-info.mjs — verifies the reframed get_asset_info tool
// and the parseAssetHeader cache wrapper.
//
// Run: cd server && node test-offline-asset-info.mjs
// Gated on UNREAL_PROJECT_ROOT; fixtures skip when the path does not resolve.

import { stat } from 'node:fs/promises';
import { join } from 'node:path';

import {
  executeOfflineTool,
  parseAssetHeader,
  assetCache,
} from './offline-tools.mjs';
import { TestRunner } from './test-helpers.mjs';

const runner = new TestRunner('offline get_asset_info + cache tests');

const ROOT = process.env.UNREAL_PROJECT_ROOT
  || 'D:/UnrealProjects/5.6/ProjectA/ProjectA';

async function exists(p) {
  try { await stat(p); return true; } catch { return false; }
}

// ── 1) Parser-backed get_asset_info shape ─────────────────────
async function testAssetInfoShape() {
  const path = join(ROOT, 'Content/Animations/AN_OSAnimNotify_Footstep.uasset');
  if (!(await exists(path))) {
    console.log('  · skipped Footstep (no fixture)');
    return;
  }
  assetCache.entries.clear();
  assetCache.indexDirty = false;

  const info = await executeOfflineTool(
    'get_asset_info',
    { asset_path: '/Game/Animations/AN_OSAnimNotify_Footstep' },
    ROOT,
  );

  runner.assert(info.path === '/Game/Animations/AN_OSAnimNotify_Footstep',
                'Footstep: echoed path');
  runner.assert(info.objectClassName === '/Script/Engine.Blueprint',
                'Footstep: objectClassName',
                `got: ${info.objectClassName}`);
  runner.assert(info.objectPath === 'AN_OSAnimNotify_Footstep',
                'Footstep: objectPath');
  runner.assert(info.tags && info.tags.BlueprintType === 'BPTYPE_Const',
                'Footstep: tags.BlueprintType');
  runner.assert(info.packageName === '/Game/Animations/AN_OSAnimNotify_Footstep',
                'Footstep: packageName');
  runner.assert(info.exportCount === 3, 'Footstep: exportCount=3');
  runner.assert(info.nameCount === 33, 'Footstep: nameCount=33');
  runner.assert(info.assetRegistryObjects === 2, 'Footstep: 2 AR objects');
  runner.assert(typeof info.sizeBytes === 'number' && info.sizeBytes > 0,
                'Footstep: sizeBytes populated');
}

// ── 2) Cache hit on repeat call (same mtime+size) ─────────────
async function testCacheHit() {
  const path = join(ROOT, 'Content/Animations/AN_OSAnimNotify_Footstep.uasset');
  if (!(await exists(path))) {
    console.log('  · skipped cache-hit (no fixture)');
    return;
  }
  assetCache.entries.clear();
  assetCache.indexDirty = false;

  await parseAssetHeader(ROOT, '/Game/Animations/AN_OSAnimNotify_Footstep');
  const sizeAfterFirst = assetCache.entries.size;
  runner.assert(sizeAfterFirst === 1, 'cache: 1 entry after first parse');

  // Mutate the cached payload to prove the second call returned the
  // cached object instead of re-parsing.
  const [entry] = assetCache.entries.values();
  entry.data.sentinel = 'cached-value';

  const second = await parseAssetHeader(
    ROOT, '/Game/Animations/AN_OSAnimNotify_Footstep',
  );
  runner.assert(second.data.sentinel === 'cached-value',
                'cache: second call served from cache (sentinel survived)');
}

// ── 3) indexDirty forces re-parse ─────────────────────────────
async function testIndexDirtyForcesRescan() {
  const path = join(ROOT, 'Content/Animations/AN_OSAnimNotify_Footstep.uasset');
  if (!(await exists(path))) {
    console.log('  · skipped indexDirty (no fixture)');
    return;
  }
  assetCache.entries.clear();
  assetCache.indexDirty = false;

  await parseAssetHeader(ROOT, '/Game/Animations/AN_OSAnimNotify_Footstep');
  const [entry] = assetCache.entries.values();
  entry.data.sentinel = 'should-be-overwritten';

  assetCache.indexDirty = true;
  const next = await parseAssetHeader(
    ROOT, '/Game/Animations/AN_OSAnimNotify_Footstep',
  );
  runner.assert(next.data.sentinel === undefined,
                'indexDirty: forced re-parse replaced cached payload');
}

// ── 4) Unknown asset throws with useful message ───────────────
async function testMissingAsset() {
  assetCache.entries.clear();
  try {
    await executeOfflineTool(
      'get_asset_info',
      { asset_path: '/Game/Definitely/Not/A/Real/Asset_xyz_123' },
      ROOT,
    );
    runner.assert(false, 'missing asset throws');
  } catch (e) {
    runner.assert(/Asset not found/.test(e.message),
                  'missing asset throws "Asset not found"',
                  e.message);
  }
}

// ── 5) .umap works through same path ──────────────────────────
async function testUmap() {
  const path = join(ROOT, 'Content/Developers/steve/Steve_TestMap.umap');
  if (!(await exists(path))) {
    console.log('  · skipped umap (no fixture)');
    return;
  }
  assetCache.entries.clear();
  const info = await executeOfflineTool(
    'get_asset_info',
    { asset_path: '/Game/Developers/steve/Steve_TestMap.umap' },
    ROOT,
  );
  runner.assert(info.objectClassName === '/Script/Engine.World',
                'umap: class = World',
                `got: ${info.objectClassName}`);
  runner.assert(info.exportCount > 100,
                'umap: large export count');
}

async function main() {
  await testAssetInfoShape();
  await testCacheHit();
  await testIndexDirtyForcesRescan();
  await testMissingAsset();
  await testUmap();
  process.exit(runner.summary());
}

main().catch(e => { console.error(e); process.exit(1); });
