# Export Listing And Property Markers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a first-class offline export-listing tool and make filtered `read_asset_properties` calls return explicit requested-property markers instead of silently dropping absent serialized values.

**Architecture:** Keep export discovery and property reading separate. Add shared export-table helpers in `server/offline-tools.mjs`, register `list_asset_exports` in the existing `offline` toolset, then reuse the same default-export selector from `read_asset_properties`.

**Tech Stack:** Node.js ES modules, existing UEMCP `.uasset` parser helpers, `tools.yaml` metadata, `server/test-phase1.mjs` integration tests, and the existing `npm test` rotation.

## Global Constraints

- Do not implement nested subobject recursion.
- Do not decode montage `SlotAnimTracks` or animation-specific nested structs in this change.
- Do not claim offline bytes prove that a class property does not exist.
- Do not add editor-only declaration introspection to this offline tool pass.
- Do not alter unfiltered `read_asset_properties` property payload behavior except for additive metadata; the default export selection change is explicitly in scope.
- `list_asset_exports` belongs in the existing `offline` toolset and must be discoverable through export-listing terminology.
- Parameter names remain snake_case in this pass.
- Start each implementation task with RED tests and watch them fail for the expected missing behavior before editing production code.
- Leave unrelated untracked files, including `.semgrep/guardian.yml`, untouched.
- No Unreal Editor or plugin rebuild is required for this offline server change.

---

## File Structure

- Modify `server/test-fixtures.mjs`: add D185 project-specific fixture constants for the reported cue and montage assets.
- Modify `server/test-phase1.mjs`: add D185 integration tests that skip cleanly when the empirical assets are absent.
- Modify `server/offline-tools.mjs`: add shared export helpers, `listAssetExports`, `export_index` selection, `export_selection_reason`, and requested-property marker rows.
- Modify `tools.yaml`: register `list_asset_exports`, add `read_asset_properties.export_index`, and update descriptions/reason-code wording.
- Create no new runtime module unless `server/offline-tools.mjs` becomes hard to review after Task 1. If a split becomes necessary, create `server/offline-export-helpers.mjs` and move only pure export-row/default-selection helpers there.

---

### Task 1: Export Listing Tool

**Files:**
- Modify: `server/test-fixtures.mjs`
- Modify: `server/test-phase1.mjs`
- Modify: `server/offline-tools.mjs`
- Modify: `tools.yaml`

**Interfaces:**
- Consumes: `parseAssetForPropertyRead(projectRoot, assetPath)`, `resolvePackageIndex(index, exports, imports, field)`, `BP_GENERATED_CLASSES`.
- Produces: `listAssetExports(projectRoot, params)`, `selectAssetExport(exports, imports, assetPath)`, `formatExportRow(entry, index, exports, imports)`.

- [ ] **Step 1: Add D185 fixture constants**

In `server/test-fixtures.mjs`, add these constants after `ANIM_BLUEPRINT_BP`:

```js
// Gameplay cue Blueprint from the external VFX/audio audits. It has serialized
// ImpactVfx but reported callers also requested HitAkEvent and
// DefaultSocketName, which are not serialized on the selected export.
export const HIT_IMPACT_CUE_BP = deriveBpNames('/Game/GAS/Cues/BPGC_OSHitImpact');

// Montage assets whose export tables empirically exposed the default-selection
// bug: notify / AnimDataModel exports appeared before the root AnimMontage.
export const COMBAT_DODGE_B_MONTAGE = {
  path: '/Game/Animations/Combat/AM_Combat_Dodge_B',
  name: 'AM_Combat_Dodge_B',
};

export const HEAVY_ATTACK_COMBO_MONTAGE = {
  path: '/Game/Animations/Combat/AM_HeavyAttackCombo',
  name: 'AM_HeavyAttackCombo',
};
```

- [ ] **Step 2: Write RED tests for export listing metadata, discovery, pagination, default export, and duplicate names**

In `server/test-phase1.mjs`, extend the fixture import:

```js
import {
  GAS_ABILITY_BP, PLAYER_BP, ANIM_BLUEPRINT_BP, DEV_TEST_MAP, MARKETPLACE_MAP,
  HIT_IMPACT_CUE_BP, COMBAT_DODGE_B_MONTAGE, HEAVY_ATTACK_COMBO_MONTAGE,
  ABILITIES_PREFIX, CHARACTERS_PREFIX, BLUEPRINTS_PREFIX, GAME_ROOT_PREFIX,
} from './test-fixtures.mjs';
```

Add this helper near `HAS_REAL_ASSETS`:

```js
async function assetPathExists(assetPath, extension = '.uasset') {
  try {
    const rel = assetPath.replace(/^\/Game\//, 'Content/') + extension;
    await stat(join(PROJECT_ROOT, rel));
    return true;
  } catch {
    return false;
  }
}

const HAS_D185_ASSETS = HAS_REAL_ASSETS && await (async () => {
  const checks = [
    HIT_IMPACT_CUE_BP.path,
    COMBAT_DODGE_B_MONTAGE.path,
    HEAVY_ATTACK_COMBO_MONTAGE.path,
  ];
  for (const path of checks) {
    if (!await assetPathExists(path)) return false;
  }
  return true;
})();
```

Add this test function near the other real-asset offline property tests:

```js
async function testD185ExportListing() {
  console.log(`\n═══ Test 15: D185 export listing and default export selection ═══`);
  if (!HAS_D185_ASSETS) {
    console.log('  SKIP: D185 empirical assets not found in this project');
    return;
  }

  const offlineTools = toolsData.toolsets.offline.tools;
  assert(offlineTools.list_asset_exports !== undefined,
    'D185: list_asset_exports entry exists in offline toolset');
  assert(offlineTools.list_asset_exports?.params?.asset_path?.required === true,
    'D185: list_asset_exports.asset_path is required');
  assert(offlineTools.list_asset_exports?.params?.limit !== undefined,
    'D185: list_asset_exports.limit is declared');
  assert(offlineTools.list_asset_exports?.params?.offset !== undefined,
    'D185: list_asset_exports.offset is declared');

  const index = new ToolIndex();
  index.build(toolsData);
  const hits = index.search('list exports export table choose export asset export names', 10);
  assert(hits.some(h => h.toolName === 'list_asset_exports' && h.toolsetName === 'offline'),
    'D185: find_tools terminology discovers list_asset_exports');

  const page = await executeOfflineTool('list_asset_exports',
    { asset_path: COMBAT_DODGE_B_MONTAGE.path, limit: 2, offset: 0 },
    PROJECT_ROOT);
  assert(page.path === COMBAT_DODGE_B_MONTAGE.path,
    'D185: list_asset_exports echoes path');
  assert(page.total_exports > 2,
    `D185: montage fixture has more than 2 exports (got ${page.total_exports})`);
  assert(page.exports.length === 2,
    `D185: list_asset_exports respects limit=2 (got ${page.exports.length})`);
  assert(page.offset === 0 && page.limit === 2,
    'D185: list_asset_exports echoes offset and capped limit');
  assert(page.truncated === true,
    'D185: list_asset_exports marks truncated page');
  assert(page.exports[0].export_index === 1,
    'D185: export rows use one-based export_index');
  assert(typeof page.exports[0].canonical_name === 'string',
    'D185: export rows include canonical_name');

  assert(page.default_export.export_name === COMBAT_DODGE_B_MONTAGE.name,
    `D185: default export is package-root montage export (got ${page.default_export.export_name})`);
  assert(page.default_export.class_name === 'AnimMontage',
    `D185: default export class is AnimMontage (got ${page.default_export.class_name})`);
  assert(page.default_export.selection_reason === 'package_root_name_match',
    `D185: default export reason is package_root_name_match (got ${page.default_export.selection_reason})`);

  const heavy = await executeOfflineTool('list_asset_exports',
    { asset_path: HEAVY_ATTACK_COMBO_MONTAGE.path, limit: 200 },
    PROJECT_ROOT);
  const counts = new Map();
  for (const row of heavy.exports) {
    counts.set(row.object_name, (counts.get(row.object_name) || 0) + 1);
  }
  assert([...counts.values()].some(count => count > 1),
    'D185: heavy attack montage fixture exposes duplicate export object names');
  assert(heavy.exports.some(row =>
    row.export_index === heavy.default_export.export_index &&
    row.object_name === HEAVY_ATTACK_COMBO_MONTAGE.name),
    'D185: default_export export_index points at a returned export row');
}
```

Call it after the existing real-asset offline tests:

```js
await testD185ExportListing();
```

- [ ] **Step 3: Run RED tests and confirm expected failures**

Run:

```powershell
cd D:\DevTools\UEMCP\server
$env:UEMCP_PROJECT_ATTACH_MODE='env'
$env:UNREAL_PROJECT_ROOT='<target project root>'
node test-phase1.mjs
```

Expected RED:

```text
D185: list_asset_exports entry exists in offline toolset
Unknown offline tool: list_asset_exports
```

If the test errors before those failures, fix the test harness only and rerun until it fails for missing behavior.

- [ ] **Step 4: Add `list_asset_exports` metadata**

In `tools.yaml`, add this entry in `toolsets.offline.tools`, near `read_asset_properties`:

```yaml
      list_asset_exports:
        aliases: ["list exports", "export table", "choose export", "asset export names", "export index"]
        description: >-
          List export-table rows for a .uasset/.umap so callers can choose the
          correct export before calling read_asset_properties. Returns one-based
          export_index, object/canonical names, class, outer, asset flag,
          serial size, pagination fields, and the same default_export selection
          read_asset_properties uses. Use this when an asset has multiple exports,
          duplicate export names, montage notify subobjects, AnimDataModel exports,
          or when export_name alone is ambiguous. Pointed query - not cached.
        params:
          asset_path: { type: string, required: true, description: "/Game/... path (with or without extension) or project-relative Content/... path" }
          limit:      { type: number, required: false, description: "Max exports returned (default 200, cap 2000)" }
          offset:     { type: number, required: false, description: "Result offset for pagination (default 0)" }
```

- [ ] **Step 5: Add export helper functions and `listAssetExports`**

In `server/offline-tools.mjs`, add these helpers after `parseAssetForPropertyRead` and before `inspectBlueprint`:

```js
function assetPathLeaf(assetPath) {
  const normalized = String(assetPath || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const leaf = normalized.split('/').pop() || '';
  return leaf.replace(/\.(uasset|umap)$/i, '');
}

function canonicalExportName(entry) {
  const number = Number.isInteger(entry.objectNameNumber) ? entry.objectNameNumber : 0;
  return number > 0 ? `${entry.objectName}_${number - 1}` : entry.objectName;
}

function formatExportRow(entry, index, exports, imports) {
  const outerExport = entry.outerIndex > 0 ? exports[entry.outerIndex - 1] : null;
  return {
    export_index: index + 1,
    object_name: entry.objectName,
    object_name_number: Number.isInteger(entry.objectNameNumber) ? entry.objectNameNumber : 0,
    canonical_name: canonicalExportName(entry),
    class_name: resolvePackageIndex(entry.classIndex, exports, imports, 'objectName'),
    super_name: resolvePackageIndex(entry.superIndex, exports, imports, 'objectName'),
    outer_index: entry.outerIndex,
    outer_name: resolvePackageIndex(entry.outerIndex, exports, imports, 'objectName'),
    outer_class_name: outerExport
      ? resolvePackageIndex(outerExport.classIndex, exports, imports, 'objectName')
      : null,
    b_is_asset: entry.bIsAsset,
    serial_size: entry.serialSize,
  };
}

function selectAssetExport(exports, imports, assetPath) {
  const generatedIndex = exports.findIndex(e => {
    const cls = resolvePackageIndex(e.classIndex, exports, imports, 'objectName');
    return cls && BP_GENERATED_CLASSES.has(cls);
  });
  if (generatedIndex >= 0) {
    const cdoName = `Default__${exports[generatedIndex].objectName}`;
    const cdoIndex = exports.findIndex(e => e.objectName === cdoName);
    if (cdoIndex >= 0) {
      return { index: cdoIndex, entry: exports[cdoIndex], reason: 'blueprint_cdo' };
    }
  }

  const packageLeaf = assetPathLeaf(assetPath);
  const rootNameIndex = exports.findIndex(e => e.outerIndex === 0 && e.objectName === packageLeaf);
  if (rootNameIndex >= 0) {
    return { index: rootNameIndex, entry: exports[rootNameIndex], reason: 'package_root_name_match' };
  }

  const rootAssetIndex = exports.findIndex(e => e.outerIndex === 0 && e.bIsAsset);
  if (rootAssetIndex >= 0) {
    return { index: rootAssetIndex, entry: exports[rootAssetIndex], reason: 'root_asset_export' };
  }

  const assetIndex = exports.findIndex(e => e.bIsAsset);
  if (assetIndex >= 0) {
    return { index: assetIndex, entry: exports[assetIndex], reason: 'first_asset_export' };
  }

  if (exports.length > 0) {
    return { index: 0, entry: exports[0], reason: 'first_export_fallback' };
  }

  return null;
}

function normalizeIntegerParam(value, name, { defaultValue, min, cap = null }) {
  const resolved = value ?? defaultValue;
  const n = Number(resolved);
  if (!Number.isInteger(n)) {
    throw new Error(`${name} must be an integer`);
  }
  if (n < min) {
    throw new Error(`${name} must be >= ${min}`);
  }
  return cap === null ? n : Math.min(n, cap);
}

function summarizeSelectedExport(selection, exports, imports) {
  if (!selection) return null;
  const row = formatExportRow(selection.entry, selection.index, exports, imports);
  return {
    export_name: row.object_name,
    export_index: row.export_index,
    canonical_name: row.canonical_name,
    class_name: row.class_name,
    selection_reason: selection.reason,
  };
}
```

Then add `listAssetExports` before `readAssetProperties`:

```js
async function listAssetExports(projectRoot, params) {
  const assetPath = params.asset_path;
  const limit = normalizeIntegerParam(params.limit, 'limit', {
    defaultValue: 200,
    min: 1,
    cap: 2000,
  });
  const offset = normalizeIntegerParam(params.offset, 'offset', {
    defaultValue: 0,
    min: 0,
  });

  const ctx = await parseAssetForPropertyRead(projectRoot, assetPath);
  const { diskPath, exports, imports } = ctx;
  const allRows = exports.map((entry, index) => formatExportRow(entry, index, exports, imports));
  const defaultSelection = selectAssetExport(exports, imports, assetPath);

  return stripPackageIndex({
    path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    total_exports: exports.length,
    offset,
    limit,
    truncated: offset + limit < exports.length,
    default_export: summarizeSelectedExport(defaultSelection, exports, imports),
    exports: allRows.slice(offset, offset + limit),
  });
}
```

- [ ] **Step 6: Register dispatch**

In `executeOfflineTool`, add this case before `read_asset_properties`:

```js
    case 'list_asset_exports':
      if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
      return await listAssetExports(projectRoot, params);
```

- [ ] **Step 7: Run GREEN tests for Task 1**

Run:

```powershell
cd D:\DevTools\UEMCP\server
$env:UEMCP_PROJECT_ATTACH_MODE='env'
$env:UNREAL_PROJECT_ROOT='<target project root>'
node test-phase1.mjs
```

Expected GREEN for the D185 export-listing assertions. Other pre-existing failures must be investigated before continuing.

- [ ] **Step 8: Commit Task 1**

Run:

```powershell
cd D:\DevTools\UEMCP
git add server/test-fixtures.mjs server/test-phase1.mjs server/offline-tools.mjs tools.yaml
git commit -m "D185 add offline asset export listing"
```

---

### Task 2: `read_asset_properties` Export Index And Selection Reasons

**Files:**
- Modify: `server/test-phase1.mjs`
- Modify: `server/offline-tools.mjs`
- Modify: `tools.yaml`

**Interfaces:**
- Consumes: `selectAssetExport(exports, imports, assetPath)`, `summarizeSelectedExport(selection, exports, imports)`.
- Produces: `readAssetProperties(projectRoot, params)` support for `export_index` and `export_selection_reason`.

- [ ] **Step 1: Write RED tests for default montage selection, explicit index selection, and validation**

Extend `testD185ExportListing()` in `server/test-phase1.mjs` with:

```js
  const montageRead = await executeOfflineTool('read_asset_properties',
    { asset_path: COMBAT_DODGE_B_MONTAGE.path },
    PROJECT_ROOT);
  assert(montageRead.export_name === COMBAT_DODGE_B_MONTAGE.name,
    `D185: read_asset_properties defaults to root montage export (got ${montageRead.export_name})`);
  assert(montageRead.struct_type === 'AnimMontage',
    `D185: read_asset_properties root montage struct_type is AnimMontage (got ${montageRead.struct_type})`);
  assert(montageRead.export_selection_reason === 'package_root_name_match',
    `D185: read_asset_properties default reason is package_root_name_match (got ${montageRead.export_selection_reason})`);

  const notifyRow = heavy.exports.find(row =>
    row.object_name !== HEAVY_ATTACK_COMBO_MONTAGE.name &&
    row.class_name &&
    row.export_index !== heavy.default_export.export_index);
  assert(notifyRow !== undefined,
    'D185: fixture exposes a non-default export row for export_index selection');

  const indexed = await executeOfflineTool('read_asset_properties',
    { asset_path: HEAVY_ATTACK_COMBO_MONTAGE.path, export_index: notifyRow.export_index },
    PROJECT_ROOT);
  assert(indexed.export_index === notifyRow.export_index,
    'D185: read_asset_properties targets explicit export_index');
  assert(indexed.export_name === notifyRow.object_name,
    'D185: explicit export_index may target duplicate object names');
  assert(indexed.export_selection_reason === 'explicit_export_index',
    `D185: explicit export_index reason reported (got ${indexed.export_selection_reason})`);

  const byName = await executeOfflineTool('read_asset_properties',
    { asset_path: COMBAT_DODGE_B_MONTAGE.path, export_name: COMBAT_DODGE_B_MONTAGE.name },
    PROJECT_ROOT);
  assert(byName.export_selection_reason === 'explicit_export_name',
    `D185: explicit export_name reason reported (got ${byName.export_selection_reason})`);

  let conflict = null;
  try {
    await executeOfflineTool('read_asset_properties',
      {
        asset_path: COMBAT_DODGE_B_MONTAGE.path,
        export_name: COMBAT_DODGE_B_MONTAGE.name,
        export_index: page.default_export.export_index,
      },
      PROJECT_ROOT);
  } catch (e) { conflict = e; }
  assert(conflict !== null && /export_name.*export_index|export_index.*export_name/.test(conflict.message),
    'D185: read_asset_properties rejects export_name plus export_index');

  let outOfRange = null;
  try {
    await executeOfflineTool('read_asset_properties',
      { asset_path: COMBAT_DODGE_B_MONTAGE.path, export_index: page.total_exports + 1 },
      PROJECT_ROOT);
  } catch (e) { outOfRange = e; }
  assert(outOfRange !== null && /export_index.*range|out of range/.test(outOfRange.message),
    'D185: read_asset_properties rejects out-of-range export_index');
```

- [ ] **Step 2: Run RED tests and confirm expected failures**

Run:

```powershell
cd D:\DevTools\UEMCP\server
$env:UEMCP_PROJECT_ATTACH_MODE='env'
$env:UNREAL_PROJECT_ROOT='<target project root>'
node test-phase1.mjs
```

Expected RED:

```text
D185: read_asset_properties defaults to root montage export
D185: read_asset_properties targets explicit export_index
D185: read_asset_properties rejects export_name plus export_index
```

- [ ] **Step 3: Add `export_index` metadata**

In `tools.yaml`, add `export_index` under `read_asset_properties.params`:

```yaml
          export_index:   { type: number, required: false, description: "One-based export index from list_asset_exports. Mutually exclusive with export_name and preferred when duplicate export names exist." }
```

Update the `export_name` description to:

```yaml
          export_name:    { type: string, required: false, description: "Target export objectName. Mutually exclusive with export_index; ambiguous when duplicate export names exist." }
```

- [ ] **Step 4: Replace target selection in `readAssetProperties`**

In `server/offline-tools.mjs`, replace the existing target-export selection block inside `readAssetProperties` with:

```js
  // Pick the target export.
  let target = null;
  let exportIndex = -1;
  let exportSelectionReason = null;
  const hasExportIndex = params.export_index !== undefined && params.export_index !== null;
  if (requestedExportName && hasExportIndex) {
    throw new Error('Provide only one of export_name or export_index');
  }

  if (hasExportIndex) {
    const n = Number(params.export_index);
    if (!Number.isInteger(n)) {
      throw new Error('export_index must be an integer');
    }
    if (n < 1 || n > exports.length) {
      throw new Error(`export_index out of range: ${n} (valid 1..${exports.length})`);
    }
    exportIndex = n - 1;
    target = exports[exportIndex];
    exportSelectionReason = 'explicit_export_index';
  } else if (requestedExportName) {
    exportIndex = exports.findIndex(e => e.objectName === requestedExportName);
    if (exportIndex < 0) {
      throw new Error(`Export not found: ${requestedExportName}`);
    }
    target = exports[exportIndex];
    exportSelectionReason = 'explicit_export_name';
  } else {
    const selected = selectAssetExport(exports, imports, assetPath);
    if (selected) {
      exportIndex = selected.index;
      target = selected.entry;
      exportSelectionReason = selected.reason;
    }
  }
```

Then add `export_selection_reason: exportSelectionReason` to the returned object immediately after `export_index`.

- [ ] **Step 5: Run GREEN tests for Task 2**

Run:

```powershell
cd D:\DevTools\UEMCP\server
$env:UEMCP_PROJECT_ATTACH_MODE='env'
$env:UNREAL_PROJECT_ROOT='<target project root>'
node test-phase1.mjs
```

Expected GREEN for Task 1 and Task 2 D185 assertions.

- [ ] **Step 6: Commit Task 2**

Run:

```powershell
cd D:\DevTools\UEMCP
git add server/test-phase1.mjs server/offline-tools.mjs tools.yaml
git commit -m "D185 target asset exports by index"
```

---

### Task 3: Requested Property Marker Rows

**Files:**
- Modify: `server/test-phase1.mjs`
- Modify: `server/offline-tools.mjs`
- Modify: `tools.yaml`

**Interfaces:**
- Consumes: `readExportProperties(buf, target, names, opts)` result `{ properties, unsupported, propertyCount, truncated }`.
- Produces: `requested_properties: Array<{ name: string, status: string, value?: any, reason?: string, type?: string, size_bytes?: number }>` when `property_names` is non-empty.

- [ ] **Step 1: Write RED tests for requested-property rows and truncation uncertainty**

Extend `testD185ExportListing()` in `server/test-phase1.mjs` with:

```js
  const requested = await executeOfflineTool('read_asset_properties',
    {
      asset_path: HIT_IMPACT_CUE_BP.path,
      property_names: ['HitAkEvent', 'ImpactVfx', 'DefaultSocketName'],
    },
    PROJECT_ROOT);
  assert(Array.isArray(requested.requested_properties),
    'D185: filtered read returns requested_properties array');
  assert(requested.requested_properties.length === 3,
    `D185: requested_properties has one row per requested name (got ${requested.requested_properties?.length})`);
  const requestedRows = Object.fromEntries(requested.requested_properties.map(row => [row.name, row]));
  assert(requestedRows.ImpactVfx?.status === 'serialized',
    `D185: serialized requested property is marked serialized (got ${requestedRows.ImpactVfx?.status})`);
  assert(requestedRows.ImpactVfx?.value !== undefined,
    'D185: serialized requested property row includes value');
  assert(requestedRows.HitAkEvent?.status === 'not_serialized_default',
    `D185: absent requested HitAkEvent is not_serialized_default (got ${requestedRows.HitAkEvent?.status})`);
  assert(requestedRows.DefaultSocketName?.status === 'not_serialized_default',
    `D185: absent requested DefaultSocketName is not_serialized_default (got ${requestedRows.DefaultSocketName?.status})`);
  assert(requested.properties.ImpactVfx !== undefined,
    'D185: properties map still includes serialized requested value');
  assert(requested.properties.HitAkEvent === undefined,
    'D185: properties map does not gain absent marker objects');

  const truncated = await executeOfflineTool('read_asset_properties',
    {
      asset_path: GAS_ABILITY_BP.path,
      max_bytes: 50,
      property_names: ['D185DefinitelyAbsentAfterBudget'],
    },
    PROJECT_ROOT);
  assert(truncated.truncated === true,
    'D185: truncation setup produced truncated=true');
  assert(truncated.requested_properties?.[0]?.status === 'unknown_due_to_truncation',
    `D185: absent requested name under truncation is unknown_due_to_truncation (got ${truncated.requested_properties?.[0]?.status})`);
```

- [ ] **Step 2: Run RED tests and confirm expected failures**

Run:

```powershell
cd D:\DevTools\UEMCP\server
$env:UEMCP_PROJECT_ATTACH_MODE='env'
$env:UNREAL_PROJECT_ROOT='<target project root>'
node test-phase1.mjs
```

Expected RED:

```text
D185: filtered read returns requested_properties array
D185: absent requested name under truncation is unknown_due_to_truncation
```

- [ ] **Step 3: Add requested-property row helper**

In `server/offline-tools.mjs`, add this helper after `dedupeUnsupported`:

```js
function buildRequestedPropertyRows(requestedNames, parsed) {
  const unsupportedByName = new Map();
  for (const marker of parsed.unsupported || []) {
    if (!marker || !marker.name || marker.name === '__stream__') continue;
    if (!unsupportedByName.has(marker.name)) {
      unsupportedByName.set(marker.name, marker);
    }
  }

  return requestedNames.map(name => {
    if (Object.prototype.hasOwnProperty.call(parsed.properties, name)) {
      const value = parsed.properties[name];
      if (value && typeof value === 'object' && value.unsupported === true) {
        const { unsupported: _unsupported, ...marker } = value;
        return { name, status: 'unsupported', ...stripPackageIndex(marker) };
      }
      return { name, status: 'serialized', value: stripPackageIndex(value) };
    }

    const marker = unsupportedByName.get(name);
    if (marker) {
      const { name: _name, unsupported: _unsupported, ...rest } = marker;
      return { name, status: 'unsupported', ...stripPackageIndex(rest) };
    }

    return {
      name,
      status: parsed.truncated ? 'unknown_due_to_truncation' : 'not_serialized_default',
    };
  });
}
```

- [ ] **Step 4: Preserve request order and add `requested_properties` to the response**

In `readAssetProperties`, replace the current `filterNames` setup with:

```js
  const requestedPropertyNames = Array.isArray(params.property_names)
    ? params.property_names : null;
  const filterNames = requestedPropertyNames && requestedPropertyNames.length
    ? new Set(requestedPropertyNames) : null;
```

Before returning, compute a result object and add `requested_properties` only when the request supplied at least one property name:

```js
  const result = {
    path: assetPath,
    diskPath: diskPath.replace(/\\/g, '/'),
    export_name: target.objectName,
    export_index: exportIndex + 1,
    export_selection_reason: exportSelectionReason,
    struct_type: structType,
    properties,
    unsupported: dedupeUnsupported(unsupported),
    property_count_returned: propertyCountReturned,
    property_count_total: parsed.propertyCount,
    truncated: parsed.truncated,
  };

  if (requestedPropertyNames && requestedPropertyNames.length > 0) {
    result.requested_properties = buildRequestedPropertyRows(requestedPropertyNames, parsed);
  }

  return stripPackageIndex(result);
```

- [ ] **Step 5: Update `tools.yaml` requested-property docs**

In `tools.yaml`, update `read_asset_properties.description` to state:

```text
When property_names is set, properties remains a decoded-value map and
requested_properties returns one row per requested name with status serialized,
unsupported, not_serialized_default, or unknown_due_to_truncation.
```

Update `property_names.description` to:

```yaml
          property_names: { type: array, items: string, required: false, description: "Filter to specific UPROPERTY names. When non-empty, response includes requested_properties[] with one status row per requested name." }
```

- [ ] **Step 6: Run GREEN tests for Task 3**

Run:

```powershell
cd D:\DevTools\UEMCP\server
$env:UEMCP_PROJECT_ATTACH_MODE='env'
$env:UNREAL_PROJECT_ROOT='<target project root>'
node test-phase1.mjs
```

Expected GREEN for all D185 assertions added so far.

- [ ] **Step 7: Commit Task 3**

Run:

```powershell
cd D:\DevTools\UEMCP
git add server/test-phase1.mjs server/offline-tools.mjs tools.yaml
git commit -m "D185 mark requested asset properties"
```

---

### Task 4: Documentation Cleanup, Full Verification, And Review Gate

**Files:**
- Modify: `server/test-phase1.mjs`
- Modify: `tools.yaml`

**Interfaces:**
- Consumes: completed Task 1 through Task 3 behavior.
- Produces: final metadata/documentation parity and verification evidence.

- [ ] **Step 1: Write RED metadata/docs assertions**

Extend the existing `tools.yaml` invariant check or `testD185ExportListing()` with:

```js
  const rapDesc = offlineTools.read_asset_properties.description;
  assert(/export_index/.test(rapDesc),
    'D185: read_asset_properties docs mention export_index');
  assert(/requested_properties/.test(rapDesc),
    'D185: read_asset_properties docs mention requested_properties');
  assert(/not_serialized_default/.test(rapDesc),
    'D185: read_asset_properties docs mention not_serialized_default');
  assert(/unknown_due_to_truncation/.test(rapDesc),
    'D185: read_asset_properties docs mention unknown_due_to_truncation');
  assert(!/no_cdo_export_found/.test(rapDesc),
    'D185: read_asset_properties docs omit inspect_blueprint-only no_cdo_export_found');
  assert(!/root_component_parse_failed/.test(rapDesc),
    'D185: read_asset_properties docs omit list_level_actors-only root_component_parse_failed');
```

- [ ] **Step 2: Run RED tests and confirm expected documentation failures**

Run:

```powershell
cd D:\DevTools\UEMCP\server
$env:UEMCP_PROJECT_ATTACH_MODE='env'
$env:UNREAL_PROJECT_ROOT='<target project root>'
node test-phase1.mjs
```

Expected RED:

```text
D185: read_asset_properties docs mention export_index
D185: read_asset_properties docs omit inspect_blueprint-only no_cdo_export_found
```

- [ ] **Step 3: Clean `read_asset_properties` metadata wording**

In `tools.yaml`, remove `no_cdo_export_found` and `root_component_parse_failed` from `read_asset_properties.description`. Keep parser-core reasons that `read_asset_properties` can emit, including:

```text
unknown_struct
unknown_property_type
unexpected_preamble
serial_range_out_of_bounds
value_overruns_serial
tag_header_read_failed
property_tag_extensions
value_read_failed
delegate_not_serialized
localized_text
size_budget_exceeded
complex_element_container
container_deferred
container_count_unreasonable
set_with_removed_items
map_with_removed_items
map_type_params_missing
map_key_type_unsupported
map_value_type_unsupported
map_value_struct_name_missing
struct_key_map
body_instance_native_layout_unknown
expression_input_native_layout_unknown
```

Also state the offline-default limitation:

```text
This offline reader reports serialized overrides and parser-supported values;
it does not prove inherited native or Blueprint class defaults.
```

- [ ] **Step 4: Run targeted GREEN test**

Run:

```powershell
cd D:\DevTools\UEMCP\server
$env:UEMCP_PROJECT_ATTACH_MODE='env'
$env:UNREAL_PROJECT_ROOT='<target project root>'
node test-phase1.mjs
```

Expected GREEN for Task 4 documentation assertions and all earlier D185 assertions.

- [ ] **Step 5: Run full server rotation**

Run:

```powershell
cd D:\DevTools\UEMCP\server
npm test
```

Expected:

```text
0 failed
```

- [ ] **Step 6: Run final self-review checks**

Run:

```powershell
cd D:\DevTools\UEMCP
git diff --check
rg -n "property_not_found|SlotAnimTracks|nested subobject" server\\offline-tools.mjs server\\test-phase1.mjs tools.yaml
git status --short --branch -uall
```

Expected:

```text
git diff --check emits no whitespace errors
rg may show no matches; any match must be in a rejection/non-goal comment, not implementation behavior
git status shows only intended D185 files plus the pre-existing untracked .semgrep/guardian.yml
```

- [ ] **Step 7: Commit Task 4**

Run:

```powershell
cd D:\DevTools\UEMCP
git add server/test-phase1.mjs tools.yaml
git commit -m "D185 document export property semantics"
```

- [ ] **Step 8: Prepare PR summary**

Use this summary skeleton:

```markdown
## Summary
- added offline `list_asset_exports` for export-table discovery and default-export visibility
- added `read_asset_properties.export_index`, selection reasons, and requested-property marker rows
- clarified that offline property reads expose serialized overrides, not arbitrary inherited defaults

## Tests
- `node test-phase1.mjs`
- `npm test`
- `git diff --check`
```

---

## Completion Checklist

- [ ] Every production-code behavior has a RED test that failed first.
- [ ] `list_asset_exports` is visible in `tools.yaml` under `offline`.
- [ ] `find_tools` terminology finds `list_asset_exports`.
- [ ] `read_asset_properties` supports `export_index`.
- [ ] `read_asset_properties` rejects `export_name` plus `export_index`.
- [ ] `read_asset_properties` returns `export_selection_reason` for default and explicit selection.
- [ ] Filtered `property_names` calls return `requested_properties[]`.
- [ ] Absent requested names use `not_serialized_default` only when the stream was fully parsed.
- [ ] Truncated reads use `unknown_due_to_truncation` for absent requested names.
- [ ] No implementation emits `property_not_found`.
- [ ] `npm test` passes.
- [ ] Unrelated `.semgrep/guardian.yml` remains untracked and untouched.
