// Tests for inspect_blueprint + list_level_actors on real target-project fixtures.
// Gated on UNREAL_PROJECT_ROOT. Exits 1 on any failure.
//
// ─── FIXTURE PHILOSOPHY ──────────────────────────────────────────────────
// PROJECT-SPECIFIC FIXTURE DEPENDENCY:
// This suite references target-project-specific assets via `test-fixtures.mjs`.
// The suite is integration-level — it exercises the full executeOfflineTool
// pipeline on real assets, which inherently couples to project content.
// Structural parser coverage (byte-level decode) lives in test-uasset-parser
// .mjs via synthetic helpers and is unaffected by content drift.
//
// Drift symptoms: assertion failures on clean HEAD that reference an asset
// name, parent class, or specific export. Fix patterns in test-fixtures.mjs.
// See D71 / D75 for prior drift-incident handling.
// ─────────────────────────────────────────────────────────────────────────

import { executeOfflineTool, assetCache } from './offline-tools.mjs';
import { GAS_ABILITY_BP, BEAUTIFUL_CORNER_MAP } from './test-fixtures.mjs';
import { findContentAsset } from './test-helpers.mjs';

const projectRoot = process.env.UNREAL_PROJECT_ROOT;
if (!projectRoot) {
  console.error('UNREAL_PROJECT_ROOT not set — skipping');
  process.exit(0);
}

// Parent class is a genuine semantic target-project dependency (BPGA_Block
// inherits from the GA_OSBlock C++ class). Kept explicit here so drift surfaces
// as a labelled failure rather than a mystery mismatch downstream.
const GAS_ABILITY_BP_PARENT = 'GA_OSBlock';

// D188 discovery pattern: these fixtures are target-project-specific, so a
// project with a different Content layout previously crashed this suite with
// an unhandled ENOENT instead of skipping. Probe for presence first and skip
// the dependent sections with a label when a fixture is absent.
const BP_PROBE = await findContentAsset(projectRoot, GAS_ABILITY_BP.path.split('/').pop() + '.uasset');
const MAP_PROBE = await findContentAsset(projectRoot, BEAUTIFUL_CORNER_MAP.path.split('/').pop() + '.umap');
const HAS_BP = BP_PROBE !== null;
const HAS_MAP = MAP_PROBE !== null;

// Invoke with the DISCOVERED path, not the fixture constant: probing by
// filename while calling by a stale path defeats the guard when an asset
// moves rather than disappears.
const BP_PATH = BP_PROBE?.gamePath ?? GAS_ABILITY_BP.path;
const MAP_PATH = MAP_PROBE?.gamePath ?? BEAUTIFUL_CORNER_MAP.path;

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  ✓ ${name}`); pass++; }
  else { console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); fail++; }
}

function reset() {
  assetCache.entries.clear();
  assetCache.indexDirty = false;
}

async function run() {
  console.log('\n=== inspect_blueprint + list_level_actors tests ===\n');

  if (HAS_BP) {
    // --- inspect_blueprint: GAS ability BP ---
    reset();
    const bp = await executeOfflineTool(
      'inspect_blueprint',
      { asset_path: BP_PATH },
      projectRoot,
    );

    check('inspect: path echoed',            bp.path === BP_PATH);
    check('inspect: diskPath includes Content', bp.diskPath.includes('/Content/'), bp.diskPath);
    check('inspect: sizeBytes > 0',          bp.sizeBytes > 0);
    check('inspect: modified is ISO',        /^\d{4}-\d{2}-\d{2}T/.test(bp.modified || ''));
    check('inspect: objectClassName is BPGC', bp.objectClassName === '/Script/Engine.BlueprintGeneratedClass', bp.objectClassName);
    check('inspect: generatedClass derives from asset name',
          bp.generatedClass === GAS_ABILITY_BP.generatedClassName, bp.generatedClass);
    check('inspect: parentClass is GAS_ABILITY_BP_PARENT (semantic project dep)',
          bp.parentClass === GAS_ABILITY_BP_PARENT, bp.parentClass);
    check('inspect: exportCount > 0',        bp.exportCount > 0, `exports=${bp.exportCount}`);
    check('inspect: importCount > 0',        bp.importCount > 0, `imports=${bp.importCount}`);
    check('inspect: tags field removed (F2)', bp.tags === undefined);
    check('inspect: exports is array',       Array.isArray(bp.exports));
    check('inspect: exports have className',  bp.exports.every(e => typeof e.className === 'string'));
    check('inspect: exports have objectName', bp.exports.every(e => typeof e.objectName === 'string'));
    check('inspect: exports have bIsAsset',   bp.exports.every(e => typeof e.bIsAsset === 'boolean'));
    check('inspect: exactly one BPGC export', bp.exports.filter(e => e.className === 'BlueprintGeneratedClass').length === 1);

  } else {
    console.log('  · skipped inspect_blueprint sections (fixture not present in this project)');
  }

  // --- inspect_blueprint: missing asset rejects ---
  reset();
  let caught = null;
  try {
    await executeOfflineTool('inspect_blueprint', { asset_path: '/Game/DoesNotExist/Nope' }, projectRoot);
  } catch (err) { caught = err; }
  check('inspect: missing asset throws', caught !== null);

  // --- inspect_blueprint: missing param rejects ---
  caught = null;
  try { await executeOfflineTool('inspect_blueprint', {}, projectRoot); }
  catch (err) { caught = err; }
  check('inspect: missing asset_path throws', caught !== null && /asset_path/.test(caught.message));

  if (HAS_MAP) {
    // --- list_level_actors: small map ---
    reset();
    const lvl = await executeOfflineTool(
      'list_level_actors',
      { asset_path: MAP_PATH },
      projectRoot,
    );

    check('level: path echoed',       lvl.path === MAP_PATH);
    check('level: diskPath is .umap', lvl.diskPath.endsWith('.umap'), lvl.diskPath);
    check('level: sizeBytes > 0',     lvl.sizeBytes > 0);
    check('level: modified is ISO',   /^\d{4}-\d{2}-\d{2}T/.test(lvl.modified || ''));
    check('level: exportCount > 0',   lvl.exportCount > 0);
    check('level: importCount > 0',   lvl.importCount > 0);
    check('level: actors array',      Array.isArray(lvl.actors));
    check('level: actors non-empty',  lvl.actors.length > 0);
    check('level: actors all have name/class', lvl.actors.every(a => typeof a.name === 'string' && typeof a.className === 'string'));
    check('level: class names resolved (no unresolved)', lvl.actors.every(a => !/^unresolved\(/.test(a.className)), 'some exports failed import resolution');
    check('level: has LevelScriptActor or similar level root',
      lvl.actors.some(a => /Level|World/i.test(a.className)),
      'no Level/World class found among actors'
    );

    // --- list_level_actors: explicit .umap extension works ---
    reset();
    const lvl2 = await executeOfflineTool(
      'list_level_actors',
      { asset_path: `${MAP_PATH}.umap` },
      projectRoot,
    );
    check('level: explicit .umap path accepted', lvl2.actors.length === lvl.actors.length);

  } else {
    console.log('  · skipped list_level_actors sections (fixture not present in this project)');
  }

  // --- list_level_actors: missing param rejects ---
  caught = null;
  try { await executeOfflineTool('list_level_actors', {}, projectRoot); }
  catch (err) { caught = err; }
  check('level: missing asset_path throws', caught !== null && /asset_path/.test(caught.message));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
