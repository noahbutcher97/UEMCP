// Tests for query_asset_registry — bulk scan + filter on real target-project fixtures.
// Gated on UNREAL_PROJECT_ROOT. Exits 1 on any failure.
//
// ─── FIXTURE PHILOSOPHY ──────────────────────────────────────────────────
// PROJECT-SPECIFIC FIXTURE DEPENDENCY:
// This suite scans target-project-specific asset-registry path prefixes via
// `test-fixtures.mjs`. Assertions are structural (count > 0, filter matches,
// pagination behavior) rather than pinned to specific asset names, so content
// drift within the scanned prefixes is tolerated — only a prefix rename or
// removal would surface here.
//
// Drift symptoms: scan returns 0 results despite a populated prefix (indicates
// the path was renamed or moved). Fix: update the corresponding prefix
// constant in test-fixtures.mjs.
// See D71 / D75 for prior drift-incident handling.
// ─────────────────────────────────────────────────────────────────────────

import { executeOfflineTool, assetCache } from './offline-tools.mjs';
import { ABILITIES_PREFIX, CHARACTERS_PREFIX } from './test-fixtures.mjs';

const projectRoot = process.env.UNREAL_PROJECT_ROOT;
if (!projectRoot) {
  console.error('UNREAL_PROJECT_ROOT not set — skipping');
  process.exit(0);
}

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
  console.log('\n═══ query_asset_registry tests ═══\n');

  // 1. Narrow scan: Abilities directory only
  reset();
  const t0 = Date.now();
  const abilities = await executeOfflineTool(
    'query_asset_registry',
    { path_prefix: ABILITIES_PREFIX, class_name: '/Script/Engine.BlueprintGeneratedClass', limit: 50 },
    projectRoot
  );
  const elapsed = Date.now() - t0;
  check('narrow scan returns results', abilities.results.length > 0, `got ${abilities.results.length}`);
  check('narrow scan honors scanRoot',
        abilities.scanRoot.includes(ABILITIES_PREFIX.replace('/Game/', '').split('/').pop()),
        abilities.scanRoot);
  check('narrow scan class filter exact', abilities.results.every(r => r.objectClassName === '/Script/Engine.BlueprintGeneratedClass'));
  check('narrow scan has tags', abilities.results.some(r => Object.keys(r.tags).length > 0));
  check('narrow scan packageName populated', abilities.results.every(r => r.packageName));
  check('narrow scan performance sane', elapsed < 10000, `${elapsed}ms`);

  // 2. Bogus class returns empty
  reset();
  const empty = await executeOfflineTool(
    'query_asset_registry',
    { class_name: 'ThisClassDoesNotExist_ZZZ', max_scan: 100 },
    projectRoot
  );
  check('bogus class returns 0 matches', empty.results.length === 0);
  check('empty result still reports total_scanned', empty.total_scanned > 0);

  // 3. Limit cap respected
  reset();
  const capped = await executeOfflineTool(
    'query_asset_registry',
    { path_prefix: CHARACTERS_PREFIX, limit: 3 },
    projectRoot
  );
  check('limit cap respected', capped.results.length <= 3, `got ${capped.results.length}`);

  // 4. max_scan truncation flag
  reset();
  const truncated = await executeOfflineTool(
    'query_asset_registry',
    { max_scan: 5, limit: 100 },
    projectRoot
  );
  check('max_scan truncates files list', truncated.total_scanned === 5);
  check('truncated flag set', truncated.truncated === true);

  // 5. Tag filter: BlueprintType presence
  reset();
  const tagged = await executeOfflineTool(
    'query_asset_registry',
    { path_prefix: ABILITIES_PREFIX, tag_key: 'BlueprintType', limit: 20 },
    projectRoot
  );
  check('tag_key presence filter', tagged.results.length > 0);
  check('tag_key presence has tag on each', tagged.results.every(r => 'BlueprintType' in r.tags));

  // 6. Tag value filter: exact match
  reset();
  // Find a known tag value from result #5, then filter on it
  const sampleValue = tagged.results[0]?.tags?.BlueprintType;
  if (sampleValue) {
    const valueFiltered = await executeOfflineTool(
      'query_asset_registry',
      { path_prefix: ABILITIES_PREFIX, tag_key: 'BlueprintType', tag_value: sampleValue, limit: 20 },
      projectRoot
    );
    check('tag_value exact match filters', valueFiltered.results.every(r => r.tags.BlueprintType === sampleValue));
  } else {
    check('tag_value exact match filters (skipped — no sample)', true);
  }

  // 7. Invalid path_prefix rejected
  reset();
  let threw = false;
  try {
    await executeOfflineTool(
      'query_asset_registry',
      { path_prefix: 'Content/NotGameRelative' },
      projectRoot
    );
  } catch (err) {
    threw = err.message.includes('/Game/');
  }
  check('non-/Game/ path_prefix rejected', threw);

  // 8. Cache reuse: second call populates cache
  reset();
  await executeOfflineTool(
    'query_asset_registry',
    { path_prefix: ABILITIES_PREFIX, class_name: '/Script/Engine.BlueprintGeneratedClass', limit: 10 },
    projectRoot
  );
  const cacheSize = assetCache.entries.size;
  check('cache populated after scan', cacheSize > 0, `size=${cacheSize}`);

  console.log(`\n═══ query_asset_registry tests ═══`);
  console.log(`  Passed: ${pass}`);
  console.log(`  Failed: ${fail}`);
  console.log(`  Total:  ${pass + fail}\n`);
  process.exit(fail ? 1 : 0);
}

run().catch((err) => { console.error(err); process.exit(1); });
