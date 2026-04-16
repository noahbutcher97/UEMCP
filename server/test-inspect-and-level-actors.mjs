// Tests for inspect_blueprint + list_level_actors on real ProjectA fixtures.
// Gated on UNREAL_PROJECT_ROOT. Exits 1 on any failure.

import { executeOfflineTool, assetCache } from './offline-tools.mjs';

const projectRoot = process.env.UNREAL_PROJECT_ROOT;
if (!projectRoot) {
  console.error('UNREAL_PROJECT_ROOT not set — skipping');
  process.exit(0);
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { console.log(`  \u2713 ${name}`); pass++; }
  else { console.log(`  \u2717 ${name}${detail ? ' \u2014 ' + detail : ''}`); fail++; }
}

function reset() {
  assetCache.entries.clear();
  assetCache.indexDirty = false;
}

async function run() {
  console.log('\n=== inspect_blueprint + list_level_actors tests ===\n');

  // --- inspect_blueprint: BPGA_Block ---
  reset();
  const bp = await executeOfflineTool(
    'inspect_blueprint',
    { asset_path: '/Game/GAS/Abilities/BPGA_Block' },
    projectRoot,
  );

  check('inspect: path echoed',            bp.path === '/Game/GAS/Abilities/BPGA_Block');
  check('inspect: diskPath includes Content', bp.diskPath.includes('/Content/'), bp.diskPath);
  check('inspect: sizeBytes > 0',          bp.sizeBytes > 0);
  check('inspect: modified is ISO',        /^\d{4}-\d{2}-\d{2}T/.test(bp.modified || ''));
  check('inspect: objectClassName is BPGC', bp.objectClassName === '/Script/Engine.BlueprintGeneratedClass', bp.objectClassName);
  check('inspect: generatedClass matches name', bp.generatedClass === 'BPGA_Block_C', bp.generatedClass);
  check('inspect: parentClass is GA_OSBlock', bp.parentClass === 'GA_OSBlock', bp.parentClass);
  check('inspect: exportCount > 0',        bp.exportCount > 0, `exports=${bp.exportCount}`);
  check('inspect: importCount > 0',        bp.importCount > 0, `imports=${bp.importCount}`);
  check('inspect: tags field removed (F2)', bp.tags === undefined);
  check('inspect: exports is array',       Array.isArray(bp.exports));
  check('inspect: exports have className',  bp.exports.every(e => typeof e.className === 'string'));
  check('inspect: exports have objectName', bp.exports.every(e => typeof e.objectName === 'string'));
  check('inspect: exports have bIsAsset',   bp.exports.every(e => typeof e.bIsAsset === 'boolean'));
  check('inspect: exactly one BPGC export', bp.exports.filter(e => e.className === 'BlueprintGeneratedClass').length === 1);

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

  // --- list_level_actors: Beautiful_Corner.umap ---
  reset();
  const lvl = await executeOfflineTool(
    'list_level_actors',
    { asset_path: '/Game/Maps/Deployable/MarketPlace/Beautiful_Corner' },
    projectRoot,
  );

  check('level: path echoed',       lvl.path === '/Game/Maps/Deployable/MarketPlace/Beautiful_Corner');
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
    { asset_path: '/Game/Maps/Deployable/MarketPlace/Beautiful_Corner.umap' },
    projectRoot,
  );
  check('level: explicit .umap path accepted', lvl2.actors.length === lvl.actors.length);

  // --- list_level_actors: missing param rejects ---
  caught = null;
  try { await executeOfflineTool('list_level_actors', {}, projectRoot); }
  catch (err) { caught = err; }
  check('level: missing asset_path throws', caught !== null && /asset_path/.test(caught.message));

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
}

run().catch(err => { console.error(err); process.exit(1); });
