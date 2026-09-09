# WS3: `offline-tools.mjs` Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split the 3,684-line `server/offline-tools.mjs` into family modules behind an unchanged façade, with zero behavior change, proven by an unchanged rotation count.

**Architecture:** The structural map showed that the three tool families (project/config, asset registry, blueprint verbs) all depend on one shared leaf: path helpers, the asset cache, `parseAssetHeader`, `parseAssetForPropertyRead`, `stripPackageIndex`, and `withAssetExistenceCheck`. The plan therefore creates **four** modules, not three: `offline-core.mjs` (leaf), `offline-project-tools.mjs` (imports core), `offline-asset-tools.mjs` (imports core), `offline-blueprint-tools.mjs` (imports core and one asset function). `offline-tools.mjs` stays as the façade: it keeps `executeOfflineTool` and re-exports every name the eleven importing suites use, so no test changes. Every task is a pure move: function bodies are cut and pasted, never edited. One backlog item rides along (sort bulk results before pagination) with one new assertion.

**Tech Stack:** Node 22 ES modules; rotation runner; an ad-hoc ESLint invocation as the missing-import detector (the repo's lint config has no `no-undef` rule).

**Spec:** `docs/superpowers/specs/2026-09-09-health-audit-remediation-design.md` §4 WS3. Deviation recorded: four modules instead of three, because the call graph has a shared leaf.

## Global Constraints
n- Scratch files: set `SCRATCH="$(mktemp -d)"` once per shell before the first task; every `$SCRATCH/...` path below refers to it. Never write scratch output into the repo.

- Pure moves. A moved declaration keeps its name, signature, body, and the comment block immediately above it. Only `export` keywords and import lines change.
- No behavior change except the one sort in Task 3.
- `offline-tools.mjs` must keep exporting exactly these 14 names: `buildPropertyReadHandlers`, `resetOfflineAssetCache`, `shouldRescan`, `matchTagGlob`, `resolveAssetDiskPath`, `parseAssetHeader`, `collectSubobjectExportIndexes`, `summarizeCollisionProperties`, `buildSubobjectResponseRow`, `computeCommentContainment`, `withAssetExistenceCheck`, `executeOfflineTool`, `assetCache`, `extractBPEdgeTopologySafe`.
- `assetCache` must remain the same object identity end to end (tests mutate it and `resetOfflineAssetCache` resets it). Re-exporting with `export { assetCache } from` preserves identity; never copy it.
- Import direction is fixed: core imports nothing from the other three; project imports core; asset imports core; blueprint imports core and `queryAssetRegistry` from asset; the façade imports all four. Any other edge is a cycle and a plan failure.
- Rotation baseline before Task 1: 7,532 passed, 0 failed. After Task 3: 7,533. Any other figure stops the task.
- Codename hygiene, no AI attribution, one commit per task.
- **The import check** (run from `D:/DevTools/UEMCP/server`; substitute the files under test):

```bash
G="process,Buffer,console,URL,TextDecoder,TextEncoder,setTimeout,clearTimeout,setImmediate,structuredClone,performance,AbortController,queueMicrotask"
npx eslint --no-config-lookup --rule "no-undef: 2" --rule "no-unused-vars: [2, {argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none'}]" --global "$G" offline-core.mjs offline-tools.mjs
```

It reports `no-undef` for any identifier used without an import (a missing import) and `no-unused-vars` for any import no longer needed. Three `no-unused-vars` hits are pre-existing dead code and are expected wherever they land: `BULK_TTL_MS`, `listDirRecursive`, `parseAssetTables`. Anything else is a defect to fix before moving on. The unused `access` import in the current file is removed in Task 1.

## File Structure

| File | Responsibility | Declarations (original line ranges in the pre-split file, for locating by name) |
|---|---|---|
| `server/offline-core.mjs` (new) | Shared leaf: path resolution, asset cache, header parse, property-read parse, existence guard | `buildPropertyReadHandlers` 37–66, `BULK_TTL_MS` 67, `assetCache` 71–79 (with the cache doc comment above it), `resetOfflineAssetCache` 80–123, `shouldRescan` 124–151, `resolve` 152–161, `resolveAssetDiskPath` 410–463, `parseAssetHeader` 464–522, `resolveSafePath` 934–948, `stripPackageIndex` 1226–1245, `parseAssetForPropertyRead` 1296–1315, `withAssetExistenceCheck` 3111–3150 |
| `server/offline-project-tools.mjs` (new) | Project and config tools | `readUProject` 162–176, `parseIniFile` 177–216, `listDirRecursive` 217–241, `projectInfo` 242–264, `listGameplayTags` 265–329, `matchTagGlob` 330–362, `searchGameplayTags` 363–371, `listConfigValues` 372–409, `parseCsv` 784–858, `collectCsvFiles` 859–882, `classifyCsv` 883–895, `listDataSources` 896–933, `extractRowStructFields` 949–974, `readDatatableSource` 975–1029, `readStringTableSource` 1030–1083, `listPlugins` 1084–1124, `getBuildConfig` 1125–1192 |
| `server/offline-asset-tools.mjs` (new) | Asset registry, asset info, export and property reads, level actors | `BOUNDED_SUBOBJECT_REASONS` 35, `getAssetInfo` 523–576, `walkAssetFiles` 577–625, `queryAssetRegistry` 626–783, `parseAssetTables` 1193–1208, `BP_GENERATED_CLASSES` 1209–1225, `dedupeUnsupported` 1246–1258, `buildRequestedPropertyRows` 1259–1295, `readPropertyExport` 1316–1324, `assetPathLeaf`, `canonicalExportName`, `formatExportRow`, `selectAssetExport`, `normalizeIntegerParam`, `summarizeSelectedExport` 1325–1414, `SUBOBJECT_EXCLUDED_CLASS_PATTERNS` 1415–1427, `isSubobjectCandidate` through `readAssetProperties` 1428–2212 |
| `server/offline-blueprint-tools.mjs` (new) | The eight `bp_*` verbs, node search, edge topology, comment containment | everything from `SKELETAL_K2NODE_CLASSES` 2213 through `bpNeighbors` 3569 **except** `withAssetExistenceCheck` 3111–3150, plus the nine `*Safe` constants 3182 and 3570–3581 |
| `server/offline-tools.mjs` (existing, shrinks) | Façade: `executeOfflineTool` 3582–3683 plus re-exports | unchanged switch body |

---

### Task 1: Extract `offline-core.mjs`

**Files:**
- Create: `server/offline-core.mjs`
- Modify: `server/offline-tools.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `offline-core.mjs` exporting `buildPropertyReadHandlers`, `assetCache`, `resetOfflineAssetCache`, `shouldRescan`, `resolve`, `resolveAssetDiskPath`, `parseAssetHeader`, `resolveSafePath`, `stripPackageIndex`, `parseAssetForPropertyRead`, `withAssetExistenceCheck`. Signatures are unchanged from the originals: `resolve(projectRoot, relativePath)`, `resolveSafePath(projectRoot, filePath)`, `stripPackageIndex(value)`, `parseAssetForPropertyRead(projectRoot, assetPath, opts)`.

- [ ] **Step 1: Record the baseline**

Run: `cd D:/DevTools/UEMCP/server && node run-rotation.mjs --json > "$SCRATCH/ws3-base.json"; jq -c '.aggregate' "$SCRATCH/ws3-base.json"`
Expected: `{"passed":7532,"failed":0,"total":7532}`. If different, stop and report; the plan's counts assume this baseline.

- [ ] **Step 2: Create the module with its import header**

Create `server/offline-core.mjs` with this header, then the moved declarations in the order listed in File Structure:

```js
// offline-core.mjs — shared leaf for the offline toolset: path resolution,
// the parsed-header cache, header and property-read parsing, and the
// asset-existence guard. Imported by offline-project-tools, offline-asset-tools
// and offline-blueprint-tools; imports none of them.

import { getMountTable, resolveMountedAssetPath } from './content-mounts.mjs';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, resolve as pathResolve } from 'node:path';

import {
  Cursor,
  parseSummary,
  readNameTable,
  readImportTable,
  readExportTable,
  readAssetRegistryData,
  makePackageIndexResolver,
  propertyTagLayoutForPackage,
} from './uasset-parser.mjs';
import {
  buildStructHandlers,
  buildContainerHandlers,
} from './uasset-structs.mjs';
import { REQUIRED_CONTAINER_PROPERTY_TYPES } from './property-read-contract.mjs';
```

- [ ] **Step 3: Move the declarations**

Cut each declaration listed for `offline-core.mjs` out of `offline-tools.mjs` (with the comment block directly above it, including the multi-line cache design comment that precedes `BULK_TTL_MS`) and paste it into `offline-core.mjs` after the header, preserving original order. Add `export` to the four that were private: `resolve`, `resolveSafePath`, `stripPackageIndex`, `parseAssetForPropertyRead`. The others already carry `export`.

- [ ] **Step 4: Wire the façade**

In `offline-tools.mjs`, directly after the existing import block, add:

```js
import {
  resolve,
  resolveSafePath,
  stripPackageIndex,
  parseAssetForPropertyRead,
  parseAssetHeader,
  withAssetExistenceCheck,
  buildPropertyReadHandlers,
  shouldRescan,
  resolveAssetDiskPath,
} from './offline-core.mjs';
export {
  buildPropertyReadHandlers,
  resetOfflineAssetCache,
  shouldRescan,
  assetCache,
  resolveAssetDiskPath,
  parseAssetHeader,
  withAssetExistenceCheck,
} from './offline-core.mjs';
```

Remove `access` from the `node:fs/promises` import line (it was never used).

- [ ] **Step 5: Run the import check**

Run the import check from Global Constraints on `offline-core.mjs offline-tools.mjs`.
Expected: `no-unused-vars` only for imports the façade no longer uses (remove each one it names, for example `getMountTable`, `resolveMountedAssetPath`, `stat`, `pathResolve`, `readNameTable`, `readImportTable`, `readAssetRegistryData`, `makePackageIndexResolver`, `propertyTagLayoutForPackage`, `buildStructHandlers`, `buildContainerHandlers`, `REQUIRED_CONTAINER_PROPERTY_TYPES`) and for `BULK_TTL_MS`, which is expected. Zero `no-undef`. Re-run until only `BULK_TTL_MS` remains.

- [ ] **Step 6: Run the suites that import the moved names**

Run: `node test-connection-reset.mjs && node test-engine-fixtures.mjs && node test-offline-asset-info.mjs && node test-tool-metadata.mjs && node test-phase1.mjs | tail -5`
Expected: every summary shows `Failed: 0`. `test-connection-reset.mjs` is the identity check for `assetCache`.

- [ ] **Step 7: Full rotation and commit**

Run: `node run-rotation.mjs --json > "$SCRATCH/ws3-t1.json"; jq -c '.aggregate, {importErrorCount, noSummaryCount}' "$SCRATCH/ws3-t1.json"`
Expected: `{"passed":7532,"failed":0,"total":7532}` and both counts `0`.

```bash
cd D:/DevTools/UEMCP
git add server/offline-core.mjs server/offline-tools.mjs
git commit -m "Extract offline-core.mjs: shared path, cache and parse leaf behind the offline-tools façade"
```

### Task 2: Extract `offline-project-tools.mjs`

**Files:**
- Create: `server/offline-project-tools.mjs`
- Modify: `server/offline-tools.mjs`

**Interfaces:**
- Consumes: `resolveSafePath` from `offline-core.mjs`.
- Produces: exports `projectInfo(projectRoot)`, `listGameplayTags(projectRoot)`, `searchGameplayTags(projectRoot, pattern)`, `listConfigValues(projectRoot, configFile, section, key)`, `listDataSources(projectRoot)`, `readDatatableSource(projectRoot, filePath, rowStructHeader)`, `readStringTableSource(projectRoot, filePath)`, `listPlugins(projectRoot)`, `getBuildConfig(projectRoot)`, `matchTagGlob(pattern, tag)`.

- [ ] **Step 1: Create the module with its import header**

```js
// offline-project-tools.mjs — offline tools that read the project itself:
// .uproject, Config/*.ini, plugins, build targets, CSV data sources, and the
// gameplay-tag hierarchy. No .uasset parsing here.

import { readFile, readdir, stat } from 'node:fs/promises';
import { join, extname, basename, relative } from 'node:path';

import { resolveSafePath } from './offline-core.mjs';
```

- [ ] **Step 2: Move the declarations**

Cut the seventeen declarations listed for this module out of `offline-tools.mjs` (each with its comment block) and paste them in original order. Add `export` to: `projectInfo`, `listGameplayTags`, `searchGameplayTags`, `listConfigValues`, `listDataSources`, `readDatatableSource`, `readStringTableSource`, `listPlugins`, `getBuildConfig`. `matchTagGlob` already has it. Leave `readUProject`, `parseIniFile`, `listDirRecursive`, `parseCsv`, `collectCsvFiles`, `classifyCsv`, `extractRowStructFields` private.

- [ ] **Step 3: Wire the façade**

In `offline-tools.mjs`, after the core import block, add:

```js
import {
  projectInfo,
  listGameplayTags,
  searchGameplayTags,
  listConfigValues,
  listDataSources,
  readDatatableSource,
  readStringTableSource,
  listPlugins,
  getBuildConfig,
} from './offline-project-tools.mjs';
export { matchTagGlob } from './offline-project-tools.mjs';
```

- [ ] **Step 4: Import check**

Run the import check on `offline-project-tools.mjs offline-tools.mjs`.
Expected: `listDirRecursive` unused (expected dead code); remove any façade imports it flags as unused (`extname`, `basename` will be among them); zero `no-undef`.

- [ ] **Step 5: Suites and rotation**

Run: `node test-phase1.mjs | tail -5 && node test-mcp-wire.mjs | tail -5 && node run-rotation.mjs --json > "$SCRATCH/ws3-t2.json"; jq -c '.aggregate' "$SCRATCH/ws3-t2.json"`
Expected: `Failed: 0` twice; aggregate `{"passed":7532,"failed":0,"total":7532}`.

- [ ] **Step 6: Commit**

```bash
cd D:/DevTools/UEMCP
git add server/offline-project-tools.mjs server/offline-tools.mjs
git commit -m "Extract offline-project-tools.mjs: project, config, plugin, data-source and gameplay-tag tools"
```

### Task 3: Extract `offline-asset-tools.mjs` and sort bulk results before pagination

**Files:**
- Create: `server/offline-asset-tools.mjs`
- Modify: `server/offline-tools.mjs`
- Modify: `server/test-phase1.mjs` (Test 13, the `find_blueprint_nodes_bulk` block, near the line `assert(true, 'EN-2: every result row has path + match_count>0');`)

Note: the sort lands in `findBlueprintNodesBulk`, which moves to the blueprint module in Task 4. Apply the sort now while the function is still in `offline-tools.mjs`; Task 4 moves it with the sort in place.

**Interfaces:**
- Consumes: `resolve`, `parseAssetHeader`, `resolveSafePath`, `stripPackageIndex`, `parseAssetForPropertyRead` from `offline-core.mjs`.
- Produces: exports `getAssetInfo(projectRoot, assetPath, params)`, `queryAssetRegistry(projectRoot, params)`, `inspectBlueprint(projectRoot, params)`, `listLevelActors(projectRoot, params)`, `listAssetExports(projectRoot, params)`, `readAssetProperties(projectRoot, params)`, `collectSubobjectExportIndexes`, `summarizeCollisionProperties`, `buildSubobjectResponseRow` (the last three keep their existing exported signatures).

- [ ] **Step 1: Create the module with its import header**

```js
// offline-asset-tools.mjs — offline tools over .uasset/.umap files: registry
// scan and query, asset info, export listing, tagged-property reads with
// subobject budgets, and level-actor extraction. Blueprint graph verbs live in
// offline-blueprint-tools.mjs.

import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import {
  Cursor,
  parseSummary,
  readNameTable,
  readImportTable,
  readExportTable,
  resolvePackageIndex,
  readExportProperties,
} from './uasset-parser.mjs';
import { PROPERTY_READ_REASON_GROUPS } from './property-read-contract.mjs';
import {
  resolve,
  parseAssetHeader,
  resolveSafePath,
  stripPackageIndex,
  parseAssetForPropertyRead,
} from './offline-core.mjs';
```

- [ ] **Step 2: Move the declarations**

Cut every declaration listed for this module (including the three constants `BOUNDED_SUBOBJECT_REASONS`, `BP_GENERATED_CLASSES`, `SUBOBJECT_EXCLUDED_CLASS_PATTERNS`, `KNOWN_ROOT_COMPONENT_NAMES`, `AUX_COMPONENT_CLASS_PATTERNS` and the dead `parseAssetTables`) and paste in original order. Add `export` to `getAssetInfo`, `queryAssetRegistry`, `inspectBlueprint`, `listLevelActors`, `listAssetExports`, `readAssetProperties`. The three already-exported helpers keep `export`.

- [ ] **Step 3: Wire the façade**

In `offline-tools.mjs`, after the project import block, add:

```js
import {
  getAssetInfo,
  queryAssetRegistry,
  inspectBlueprint,
  listLevelActors,
  listAssetExports,
  readAssetProperties,
} from './offline-asset-tools.mjs';
export {
  collectSubobjectExportIndexes,
  summarizeCollisionProperties,
  buildSubobjectResponseRow,
} from './offline-asset-tools.mjs';
```

- [ ] **Step 4: Write the failing test for the sort**

In `server/test-phase1.mjs`, Test 13, immediately after the line `assert(true, 'EN-2: every result row has path + match_count>0');`, add:

```js
    assert(r.results.every((row, i, rows) => i === 0 || rows[i - 1].match_count >= row.match_count),
      'EN-2: bulk results are ordered by match_count descending');
```

- [ ] **Step 5: Run it to confirm it is counted**

Run: `node test-phase1.mjs | tail -5`
Expected: `Total:` is one higher than before this task. Against the fixture project the bulk query returns few or no rows, so the assertion may already pass; against a real `UNREAL_PROJECT_ROOT` it fails until Step 6. Either way the count must have grown by one.

- [ ] **Step 6: Apply the sort**

In `offline-tools.mjs`, in `findBlueprintNodesBulk`, find:

```js
  const totalBpsMatched = perBp.length;
  const pageResults = perBp.slice(offset, offset + limit);
```

and insert directly above it:

```js
  // Rank by match density so page one carries the densest assets. Array.sort is
  // stable, so equal counts keep registry order and pagination stays deterministic.
  perBp.sort((a, b) => b.match_count - a.match_count);
```

- [ ] **Step 7: Import check, suites, rotation**

Run the import check on `offline-asset-tools.mjs offline-tools.mjs`. Expected: `parseAssetTables` unused (expected); remove façade imports it flags; zero `no-undef`.

Run: `node test-phase1.mjs | tail -5 && node test-uasset-parser.mjs | tail -5 && node test-offline-asset-info.mjs | tail -5 && node test-query-asset-registry.mjs | tail -5 && node test-inspect-and-level-actors.mjs | tail -5 && node test-tool-metadata.mjs | tail -5`
Expected: `Failed: 0` in each (the fixture-gated ones may print a labeled skip; that is not a failure).

Run: `node run-rotation.mjs --json > "$SCRATCH/ws3-t3.json"; jq -c '.aggregate' "$SCRATCH/ws3-t3.json"`
Expected: `{"passed":7533,"failed":0,"total":7533}`.

- [ ] **Step 8: Commit**

```bash
cd D:/DevTools/UEMCP
git add server/offline-asset-tools.mjs server/offline-tools.mjs server/test-phase1.mjs
git commit -m "Extract offline-asset-tools.mjs and rank bulk node results by match_count before pagination"
```

### Task 4: Extract `offline-blueprint-tools.mjs` and finish the façade

**Files:**
- Create: `server/offline-blueprint-tools.mjs`
- Modify: `server/offline-tools.mjs`

**Interfaces:**
- Consumes: `resolve`, `parseAssetHeader`, `stripPackageIndex`, `parseAssetForPropertyRead`, `withAssetExistenceCheck` from `offline-core.mjs`; `queryAssetRegistry` from `offline-asset-tools.mjs`.
- Produces: exports `findBlueprintNodes(projectRoot, params)`, `findBlueprintNodesBulk(projectRoot, params)`, the eight wrapped verbs `bpListGraphsSafe`, `bpFindInGraphSafe`, `bpSubgraphInCommentSafe`, `bpListEntryPointsSafe`, `bpShowNodeSafe`, `bpTraceExecSafe`, `bpTraceDataSafe`, `bpNeighborsSafe` (each `(projectRoot, params)`), plus `computeCommentContainment` and `extractBPEdgeTopologySafe` unchanged.

- [ ] **Step 1: Create the module with its import header**

```js
// offline-blueprint-tools.mjs — the offline Blueprint graph verbs: node search
// (single and bulk), graph listing, comment subgraphs, entry points, node
// detail, exec/data tracing and neighbors, all over the S-B-base edge-topology
// parser. Every public verb is wrapped by withAssetExistenceCheck so a missing
// asset returns {available:false} instead of throwing.

import { join } from 'node:path';

import {
  readExportTable,
  resolvePackageIndex,
  readExportProperties,
  pinBlockLayoutForPackage,
  formatFName,
  resolveLinkedToEdges,
} from './uasset-parser.mjs';
import {
  resolve,
  parseAssetHeader,
  stripPackageIndex,
  parseAssetForPropertyRead,
  withAssetExistenceCheck,
} from './offline-core.mjs';
import { queryAssetRegistry } from './offline-asset-tools.mjs';
```

- [ ] **Step 2: Move the declarations**

Cut everything from `SKELETAL_K2NODE_CLASSES` through the nine `*Safe` constants (all of the blueprint range in File Structure) and paste in original order. Add `export` to `findBlueprintNodes`, `findBlueprintNodesBulk`, and the eight `*Safe` constants. `computeCommentContainment` and `extractBPEdgeTopologySafe` already carry `export`.

- [ ] **Step 3: Rewrite the façade header**

`offline-tools.mjs` now contains only import lines, re-export lines, and `executeOfflineTool`. Replace everything above `export async function executeOfflineTool` with exactly:

```js
// offline-tools.mjs — façade for the offline toolset. Owns the tool-name
// dispatch (executeOfflineTool) and re-exports the surface that tests and
// create-uemcp-server.mjs import. Implementation lives in:
//   offline-core.mjs            shared leaf (paths, cache, header/property parse)
//   offline-project-tools.mjs   project, config, plugins, data sources, tags
//   offline-asset-tools.mjs     registry, asset info, exports, properties, actors
//   offline-blueprint-tools.mjs bp_* graph verbs and node search

import {
  projectInfo,
  listGameplayTags,
  searchGameplayTags,
  listConfigValues,
  listDataSources,
  readDatatableSource,
  readStringTableSource,
  listPlugins,
  getBuildConfig,
} from './offline-project-tools.mjs';
import {
  getAssetInfo,
  queryAssetRegistry,
  inspectBlueprint,
  listLevelActors,
  listAssetExports,
  readAssetProperties,
} from './offline-asset-tools.mjs';
import {
  findBlueprintNodes,
  findBlueprintNodesBulk,
  bpListGraphsSafe,
  bpFindInGraphSafe,
  bpSubgraphInCommentSafe,
  bpListEntryPointsSafe,
  bpShowNodeSafe,
  bpTraceExecSafe,
  bpTraceDataSafe,
  bpNeighborsSafe,
} from './offline-blueprint-tools.mjs';

export {
  buildPropertyReadHandlers,
  resetOfflineAssetCache,
  shouldRescan,
  assetCache,
  resolveAssetDiskPath,
  parseAssetHeader,
  withAssetExistenceCheck,
} from './offline-core.mjs';
export { matchTagGlob } from './offline-project-tools.mjs';
export {
  collectSubobjectExportIndexes,
  summarizeCollisionProperties,
  buildSubobjectResponseRow,
} from './offline-asset-tools.mjs';
export {
  computeCommentContainment,
  extractBPEdgeTopologySafe,
} from './offline-blueprint-tools.mjs';
```

The `executeOfflineTool` function body is not edited.

- [ ] **Step 4: Import check on all five files**

Run the import check on `offline-core.mjs offline-project-tools.mjs offline-asset-tools.mjs offline-blueprint-tools.mjs offline-tools.mjs`.
Expected: exactly three `no-unused-vars` (`BULK_TTL_MS`, `listDirRecursive`, `parseAssetTables`), zero `no-undef`.

- [ ] **Step 5: Confirm the export surface**

Run: `node -e "import('./offline-tools.mjs').then(m => console.log(Object.keys(m).sort().join(' ')))"`
Expected, exactly: `assetCache buildPropertyReadHandlers buildSubobjectResponseRow collectSubobjectExportIndexes computeCommentContainment executeOfflineTool extractBPEdgeTopologySafe matchTagGlob parseAssetHeader resetOfflineAssetCache resolveAssetDiskPath shouldRescan summarizeCollisionProperties withAssetExistenceCheck`

- [ ] **Step 6: Line-count sanity**

Run: `wc -l offline-core.mjs offline-project-tools.mjs offline-asset-tools.mjs offline-blueprint-tools.mjs offline-tools.mjs`
Expected: `offline-tools.mjs` under 200 lines; the five totals sum to roughly the original 3,684 plus the added headers (within about 80 lines). A large shortfall means a block was dropped, not moved.

- [ ] **Step 7: Suites, lint, rotation**

Run: `node test-phase1.mjs | tail -5 && node test-verb-surface.mjs | tail -5 && node test-s-b-base-differential.mjs | tail -5 && node test-mcp-wire.mjs | tail -5 && node test-tool-registry-truth.mjs | tail -5`
Expected: `Failed: 0` or a labeled skip in each.

Run: `npx eslint . && node run-rotation.mjs --json > "$SCRATCH/ws3-t4.json"; jq -c '.aggregate, {importErrorCount, noSummaryCount, crashCount}' "$SCRATCH/ws3-t4.json"`
Expected: lint prints nothing; aggregate `{"passed":7533,"failed":0,"total":7533}`; all three counts `0`.

- [ ] **Step 8: Codename scan and commit**

```bash
cd D:/DevTools/UEMCP
export LC_ALL=C.UTF-8
grep -v '^#' .git/info/forbidden-tokens | grep -v '^regex:' | grep -v '^\s*$' > "$SCRATCH/tokens.txt"
git diff -- server | grep -i -F -f "$SCRATCH/tokens.txt"; echo "grep exit=$? (1 means clean)"
git add server/offline-blueprint-tools.mjs server/offline-tools.mjs
git commit -m "Extract offline-blueprint-tools.mjs; offline-tools.mjs becomes the dispatch façade"
```

Expected: `grep exit=1`; commit succeeds; `git status --short` prints nothing.

### Task 5: Record the follow-ons

**Files:**
- Modify: `docs/tracking/backlog.md`

- [ ] **Step 1: Mark the sort item done and add the dead-code note**

In `docs/tracking/backlog.md`, find the entry whose scope line reads `~1 line change in \`offline-tools.mjs\` bulk handler — sort` and append ` — **DONE 2026-09 (WS3)**` to its heading line. Then add, in the same section, one bullet:

```
- **Dead code in the offline modules** — `BULK_TTL_MS` (offline-core.mjs), `listDirRecursive` (offline-project-tools.mjs), `parseAssetTables` (offline-asset-tools.mjs) have no callers; WS3 moved them unchanged by design. Delete in the next offline pass.
```

- [ ] **Step 2: Commit**

```bash
cd D:/DevTools/UEMCP
git add docs/tracking/backlog.md
git commit -m "Backlog: record WS3 sort item done and the three dead offline declarations"
```
