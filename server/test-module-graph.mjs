// Module Graph Guard — offline and transaction family import direction
// Run: cd D:\DevTools\UEMCP\server && node test-module-graph.mjs
//
// The offline-tools.mjs split (core/project-tools/asset-tools/blueprint-
// tools) and the client-transaction.mjs split (common/pins/stage/snapshot)
// both declared the import direction a hard invariant: core imports no
// sibling, siblings never import the façade back. Nothing in the rotation
// enforced it — a wrong-direction edge is a plan failure, not a style nit,
// since it silently reintroduces the tangled shape the split removed.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Module Graph (offline + transaction families)');
const SERVER_DIR = join(REPO_ROOT, 'server');
const DEPLOYMENT_DIR = join(SERVER_DIR, 'deployment');
const STATIC_RE = /from\s+['"](\.\/[^'"]+\.mjs)['"]/g;
const DYNAMIC_RE = /import\(['"](\.\/[^'"]+\.mjs)['"]\)/g;
// Bare side-effect imports (`import './x.mjs';`) have no `from` clause, so
// STATIC_RE misses them — a back-edge written this way would pass rule 5
// unseen.
const SIDE_EFFECT_RE = /^\s*import\s+['"](\.\/[^'"]+\.mjs)['"]/gm;

/** Local ('./…mjs') import basenames referenced in a file's source. */
function localImports(absPath) {
  const src = readFileSync(absPath, 'utf8');
  const names = new Set();
  for (const re of [STATIC_RE, DYNAMIC_RE, SIDE_EFFECT_RE]) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(src)) !== null) names.add(m[1].replace(/^\.\//, ''));
  }
  return names;
}

const OFFLINE = ['offline-core.mjs', 'offline-project-tools.mjs', 'offline-asset-tools.mjs', 'offline-blueprint-tools.mjs', 'offline-tools.mjs'];
const TRANSACTION = ['transaction-common.mjs', 'transaction-pins.mjs', 'transaction-stage.mjs', 'transaction-snapshot.mjs', 'client-transaction.mjs'];

/** Per-family adjacency map, edges restricted to members of `files`. */
function familyGraph(dir, files) {
  const graph = {};
  for (const f of files) {
    const imports = existsSync(join(dir, f)) ? localImports(join(dir, f)) : new Set();
    graph[f] = files.filter((other) => other !== f && imports.has(other));
  }
  return graph;
}

/** DFS cycle detection over a family's restricted adjacency map. */
function findCycle(graph, files) {
  const color = Object.fromEntries(files.map((f) => [f, 0])); // 0 white, 1 gray, 2 black
  const path = [];
  let cycle = null;
  const dfs = (node) => {
    color[node] = 1;
    path.push(node);
    for (const next of graph[node]) {
      if (cycle) return;
      if (color[next] === 1) { cycle = [...path.slice(path.indexOf(next)), next]; return; }
      if (color[next] === 0) dfs(next);
    }
    path.pop();
    color[node] = 2;
  };
  for (const f of files) { if (color[f] === 0) dfs(f); if (cycle) break; }
  return cycle;
}

/** Assert `graph[file]` imports only names in `allowed`, among family members. */
function assertOnly(graph, file, allowed, label) {
  const bad = graph[file].filter((x) => !allowed.includes(x));
  t.assert(bad.length === 0, label, bad.join(', '));
}

const offline = familyGraph(SERVER_DIR, OFFLINE);
const txn = familyGraph(DEPLOYMENT_DIR, TRANSACTION);

// 1-4: offline layering — core is a leaf; each layer adds one allowed sibling.
assertOnly(offline, 'offline-core.mjs', [], 'offline-core.mjs imports none of the other offline modules');
assertOnly(offline, 'offline-project-tools.mjs', ['offline-core.mjs'], 'offline-project-tools.mjs imports only offline-core.mjs among offline modules');
assertOnly(offline, 'offline-asset-tools.mjs', ['offline-core.mjs'], 'offline-asset-tools.mjs imports only offline-core.mjs among offline modules');
assertOnly(offline, 'offline-blueprint-tools.mjs', ['offline-core.mjs', 'offline-asset-tools.mjs'], 'offline-blueprint-tools.mjs imports only offline-core.mjs and offline-asset-tools.mjs among offline modules');
// 5: façade imports every family member; nothing in the family imports it back.
{
  const missing = OFFLINE.filter((f) => f !== 'offline-tools.mjs' && !offline['offline-tools.mjs'].includes(f));
  const back = OFFLINE.filter((f) => f !== 'offline-tools.mjs' && offline[f].includes('offline-tools.mjs'));
  const detail = [missing.length && `missing: ${missing.join(', ')}`, back.length && `imported back by: ${back.join(', ')}`].filter(Boolean).join('; ');
  t.assert(missing.length === 0 && back.length === 0, 'offline-tools.mjs imports all four family modules and nothing imports the façade back', detail);
}
// 6-7: transaction layering — common is a leaf; pins/stage/snapshot depend only on it.
assertOnly(txn, 'transaction-common.mjs', [], 'transaction-common.mjs imports none of the other transaction modules');
{
  const offenders = ['transaction-pins.mjs', 'transaction-stage.mjs', 'transaction-snapshot.mjs']
    .map((f) => [f, txn[f].filter((x) => x !== 'transaction-common.mjs')])
    .filter(([, bad]) => bad.length > 0)
    .map(([f, bad]) => `${f}: ${bad.join(', ')}`);
  t.assert(offenders.length === 0, 'transaction-pins/stage/snapshot import only transaction-common.mjs among transaction modules', offenders.join('; '));
}
// 8: client-transaction.mjs assembles every transaction module.
{
  const missing = TRANSACTION.filter((f) => f !== 'client-transaction.mjs' && !txn['client-transaction.mjs'].includes(f));
  t.assert(missing.length === 0, 'client-transaction.mjs imports all four transaction modules', missing.join(', '));
}
// 9: generic acyclicity check, once per family.
{
  const cycle = findCycle(offline, OFFLINE);
  t.assert(cycle === null, 'offline family import graph has no cycle', cycle && cycle.join(' -> '));
}
{
  const cycle = findCycle(txn, TRANSACTION);
  t.assert(cycle === null, 'transaction family import graph has no cycle', cycle && cycle.join(' -> '));
}
// 10: sanity — every listed file exists and yielded >= 1 local import, so a
// renamed file fails loudly instead of the rules above passing vacuously.
{
  const files = [...OFFLINE.map((f) => join(SERVER_DIR, f)), ...TRANSACTION.map((f) => join(DEPLOYMENT_DIR, f))];
  const problems = files
    .map((abs) => (!existsSync(abs) ? `${abs}: does not exist` : localImports(abs).size === 0 ? `${abs}: no local imports found` : null))
    .filter(Boolean);
  t.assert(problems.length === 0, 'every listed file exists and yielded at least one local import', problems.join('; '));
}
process.exit(t.summary() === 0 ? 0 : 1);
