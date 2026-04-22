// test-s-b-base-differential.mjs
//
// S-B-base differential test harness — compares extractBPEdgeTopology output
// against Oracle-A-v2's committed golden JSONs on the full 6-fixture corpus.
//
// Hybrid matching per D68:
//   Primary:  match edges by pin_id.
//   Fallback: match unmatched edges by (src_node_guid, src_pin_name) ->
//             (dst_node_guid, dst_pin_name) tuples.
//   Both parser and oracle emit `name` alongside `pin_id` per Oracle-A-v2,
//   so the fallback is a pure JSON property lookup.
//
// Ship gate: 100% coverage via hybrid match on all 6 fixtures, with
// allowUnknownNodeClasses: false (no parser-emitted edges from classes
// not present in oracle).
//
// Run: cd server && set UNREAL_PROJECT_ROOT=... && node test-s-b-base-differential.mjs

import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { extractBPEdgeTopologySafe } from './offline-tools.mjs';
import { TestRunner } from './test-helpers.mjs';

const runner = new TestRunner('S-B-base differential (Oracle-A-v2)');

const ROOT = process.env.UNREAL_PROJECT_ROOT
  || 'D:/UnrealProjects/5.6/ProjectA/ProjectA';
const FIXTURES_DIR = 'D:/DevTools/UEMCP/plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures';

const FIXTURES = [
  { name: 'BP_OSPlayerR',        assetPath: '/Game/Blueprints/Character/BP_OSPlayerR',        oracle: 'BP_OSPlayerR.oracle.json',        expectedEdges: 596 },
  { name: 'BP_OSPlayerR_Child',  assetPath: '/Game/Blueprints/Character/BP_OSPlayerR_Child',  oracle: 'BP_OSPlayerR_Child.oracle.json',  expectedEdges: 4 },
  { name: 'BP_OSPlayerR_Child1', assetPath: '/Game/Blueprints/Character/BP_OSPlayerR_Child1', oracle: 'BP_OSPlayerR_Child1.oracle.json', expectedEdges: 4 },
  { name: 'BP_OSPlayerR_Child2', assetPath: '/Game/Blueprints/Character/BP_OSPlayerR_Child2', oracle: 'BP_OSPlayerR_Child2.oracle.json', expectedEdges: 4 },
  { name: 'TestCharacter',       assetPath: '/Game/Blueprints/Character/TestCharacter',       oracle: 'TestCharacter.oracle.json',       expectedEdges: 24 },
  { name: 'BP_OSControlPoint',   assetPath: '/Game/Blueprints/Level/BP_OSControlPoint',       oracle: 'BP_OSControlPoint.oracle.json',   expectedEdges: 330 },
];

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

// ── Edge-set extraction + hybrid key building ───────────────────

/**
 * Flatten a topology (oracle or parser) into an array of edge records.
 * Each record carries BOTH pin_id and pin_name for src/dst so hybrid
 * matching doesn't need re-lookup passes.
 *
 * Destination pin name is resolved via the top-level graphs index so we
 * handle the same-node-guid-across-graphs case correctly.
 */
function flattenEdges(topology) {
  // Build a (graph, node_guid, pin_id) → name lookup first.
  const nameIndex = new Map();
  for (const [graphName, graph] of Object.entries(topology.graphs)) {
    for (const [nodeGuid, node] of Object.entries(graph.nodes)) {
      for (const [pinId, pin] of Object.entries(node.pins)) {
        nameIndex.set(`${graphName}|${nodeGuid}|${pinId}`, pin.name ?? '');
      }
    }
  }
  const lookupName = (graph, nodeGuid, pinId) => nameIndex.get(`${graph}|${nodeGuid}|${pinId}`) ?? '';

  const edges = [];
  for (const [graphName, graph] of Object.entries(topology.graphs)) {
    for (const [srcNode, node] of Object.entries(graph.nodes)) {
      for (const [srcPinId, pin] of Object.entries(node.pins)) {
        const srcName = pin.name ?? '';
        for (const link of pin.linked_to) {
          // Destination name is found in the SAME graph. Oracle's edges are
          // always intra-graph (no cross-graph LinkedTo refs in UE BP model).
          const dstName = lookupName(graphName, link.node_guid, link.pin_id);
          edges.push({
            graphName, srcNode, srcPinId, srcName,
            dstNode: link.node_guid, dstPinId: link.pin_id, dstName,
          });
        }
      }
    }
  }
  return edges;
}

const idKey = (e) => `${e.graphName}|${e.srcNode}|${e.srcPinId}->${e.dstNode}|${e.dstPinId}`;
const nameKey = (e) => `${e.graphName}|${e.srcNode}|${e.srcName}->${e.dstNode}|${e.dstName}`;

/**
 * Hybrid diff: match by id first, then by (graph, node_guid, pin_name) tuples
 * for any unmatched remainder. Counts are per-pass so final reports can
 * distinguish strong (id) matches from fallback (name) matches.
 */
function hybridDiff(oracleEdges, parserEdges) {
  const oracleById = new Map(oracleEdges.map(e => [idKey(e), e]));
  const parserById = new Map(parserEdges.map(e => [idKey(e), e]));

  let idMatched = 0;
  const oracleUnmatched = [];
  const parserUnmatched = [];

  for (const [k, e] of parserById) {
    if (oracleById.has(k)) { idMatched++; oracleById.delete(k); }
    else parserUnmatched.push(e);
  }
  for (const e of oracleById.values()) oracleUnmatched.push(e);

  // Pass 2: name-key fallback.
  const oracleByName = new Map();
  for (const e of oracleUnmatched) oracleByName.set(nameKey(e), e);

  let nameMatched = 0;
  const parserExtra = [];
  for (const e of parserUnmatched) {
    const nk = nameKey(e);
    if (oracleByName.has(nk)) {
      nameMatched++;
      oracleByName.delete(nk);
    } else {
      parserExtra.push(e);
    }
  }
  const oracleMissing = [...oracleByName.values()];
  return { idMatched, nameMatched, parserExtra, oracleMissing };
}

// ── Fixture runner ────────────────────────────────────────────

async function runFixtureDifferential(fx) {
  const oraclePath = join(FIXTURES_DIR, fx.oracle);
  if (!(await exists(oraclePath))) {
    console.log(`  · skipped ${fx.name} (no oracle at ${oraclePath})`);
    return;
  }
  // Sanity-check disk asset presence; extractBPEdgeTopologySafe will also
  // return an FA-β envelope if missing, but skipping early keeps the test
  // log cleaner on fresh machines.
  const diskPath = join(ROOT, 'Content', fx.assetPath.replace('/Game/', '') + '.uasset');
  if (!(await exists(diskPath))) {
    console.log(`  · skipped ${fx.name} (no asset at ${diskPath})`);
    return;
  }

  const oracle = JSON.parse((await readFile(oraclePath)).toString('utf8'));
  const parsed = await extractBPEdgeTopologySafe(ROOT, { asset_path: fx.assetPath });

  runner.assert(parsed.available !== false,
    `${fx.name}: extractBPEdgeTopology returned a real envelope (not ENOENT)`);
  runner.assert(parsed.schema_version === 'sb-base-v1',
    `${fx.name}: schema_version = sb-base-v1`);
  runner.assert(parsed.asset_path === fx.assetPath,
    `${fx.name}: asset_path round-trips in output`);

  const oracleEdges = flattenEdges(oracle);
  const parserEdges = flattenEdges(parsed);

  runner.assert(oracleEdges.length === fx.expectedEdges,
    `${fx.name}: oracle edge count = ${fx.expectedEdges}`,
    `got ${oracleEdges.length}`);

  const diff = hybridDiff(oracleEdges, parserEdges);
  const hybridCoverage = diff.idMatched + diff.nameMatched;

  runner.assert(parserEdges.length === oracleEdges.length,
    `${fx.name}: parser edge count matches oracle (${oracleEdges.length})`,
    `got ${parserEdges.length}`);
  runner.assert(diff.parserExtra.length === 0,
    `${fx.name}: zero parser-extra edges (allowUnknownNodeClasses: false)`,
    `got ${diff.parserExtra.length} extras — first: ${JSON.stringify(diff.parserExtra[0] ?? null)}`);
  runner.assert(diff.oracleMissing.length === 0,
    `${fx.name}: zero oracle-missing edges`,
    `got ${diff.oracleMissing.length} missing — first: ${JSON.stringify(diff.oracleMissing[0] ?? null)}`);
  runner.assert(hybridCoverage === oracleEdges.length,
    `${fx.name}: hybrid coverage = 100% (${hybridCoverage}/${oracleEdges.length})`);
  runner.assert(diff.idMatched + diff.nameMatched === oracleEdges.length,
    `${fx.name}: every oracle edge matched by id-pass or name-pass`);

  console.log(`  → ${fx.name}: ${oracleEdges.length} edges, id-match=${diff.idMatched}, name-match=${diff.nameMatched}`);
}

// ── FA-β ENOENT envelope check ───────────────────────────────────
async function testEnoentEnvelope() {
  const r = await extractBPEdgeTopologySafe(ROOT, {
    asset_path: '/Game/Nonexistent/BP_DoesNotExist_Differential_Probe',
  });
  runner.assert(r && r.available === false,
    'FA-β: missing asset returns available=false');
  runner.assert(r.reason === 'asset_not_found',
    'FA-β: reason="asset_not_found"');
  runner.assert(r.asset_path === '/Game/Nonexistent/BP_DoesNotExist_Differential_Probe',
    'FA-β: asset_path echoed back');
}

// ── Stats-shape guard ────────────────────────────────────────────
async function testStatsShape() {
  const sample = FIXTURES[1]; // BP_OSPlayerR_Child — small, fast
  const diskPath = join(ROOT, 'Content', sample.assetPath.replace('/Game/', '') + '.uasset');
  if (!(await exists(diskPath))) {
    console.log('  · skipped stats-shape test (no asset)');
    return;
  }
  const r = await extractBPEdgeTopologySafe(ROOT, { asset_path: sample.assetPath });
  runner.assert(r.stats && typeof r.stats === 'object',
    'stats: object emitted alongside graphs');
  for (const key of ['graphNodeExports', 'nodesEmitted', 'pinsEmitted', 'edgesEmitted', 'danglingEdges', 'malformedNodes', 'orphanedPinsDropped', 'nullPinsDropped']) {
    runner.assert(typeof r.stats[key] === 'number',
      `stats.${key} is a number (${r.stats[key]})`);
  }
  runner.assert(r.stats.edgesEmitted === sample.expectedEdges,
    `stats.edgesEmitted = expected ${sample.expectedEdges}`,
    `got ${r.stats.edgesEmitted}`);
  runner.assert(r.stats.malformedNodes === 0,
    'stats.malformedNodes = 0 on a clean fixture');
}

async function main() {
  for (const fx of FIXTURES) {
    await runFixtureDifferential(fx);
  }
  await testEnoentEnvelope();
  await testStatsShape();
  process.exit(runner.summary());
}

main().catch(e => { console.error(e); process.exit(1); });
