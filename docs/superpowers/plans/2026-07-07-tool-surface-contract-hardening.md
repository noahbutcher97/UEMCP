# Tool Surface Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build reusable source-only contract gates that keep UEMCP YAML tools, Node wrappers, plugin wire commands, discovery, requirement classification, schema remediation, and deploy-awareness diagnostics aligned.

**Architecture:** Extract the registry-truth collectors into a focused test helper module, then add small deterministic Node test files around that helper. Keep all checks non-live and avoid importing `server.mjs`; live proof remains `smoke-live.bat` and deploy tooling. Make the current AnimGraph gap explicit in discovery tests without implementing `animation.get_anim_graph`.

**Tech Stack:** Node.js ES modules, `js-yaml`, Zod, existing UEMCP `TestRunner`, PowerShell on Windows, Unreal plugin source scanned as text only.

## Post-Review Hardening Amendments

These amendments supersede the literal snippets below where the implementation intentionally tightened the contract during review:

- `hasStructuredExemption` is stricter than the first draft: bare `status: planned` and bare `discoverable: false` are classifications only, not sufficient exemption metadata.
- Plugin registration scanning is centralized in `collectRegisteredCommandsFromSource`, with fixture coverage for current multiline and spaced `Registry.Register(TEXT(...))` plus `Handlers.Add(TEXT(...))` forms.
- `server/test-tool-surface-helpers.mjs` is a library only. It is explicitly excluded from `run-rotation.mjs` and does not emit a direct-run `0/0` summary.
- `server/test-deploy-awareness-source.mjs` proves source wiring only and also checks the separate `verify-deploy.bat` and opt-in `smoke-live.bat` entrypoints remain present. It does not prove target deploy freshness.
- Historical absolute command examples in this plan remain planning context. The committed test headers use portable `Run from server/: node ...` comments.

## Global Constraints

- Do not implement AnimGraph semantic readback in this pass.
- Do not add a generic public command dispatcher for arbitrary TCP command names.
- Do not accept broad camelCase or alternate parameter aliases without an explicit compatibility decision.
- Do not replace live smoke or deploy verification with static source tests.
- Do not claim static registry coverage proves a rebuilt target editor is running the newest plugin.
- Do not change plugin C++ in the contract-hardening pass unless source verification proves a blocker.
- Do not import `server.mjs` from tests or helpers; it starts the MCP stdio server at module load.
- Keep this pass source-only and editor-free. `npm test` must pass without Unreal Editor running.

---

## File Structure

- `server/test-tool-surface-helpers.mjs`: new pure helper module for YAML, Node definition-map, plugin command, discovery, and source-string contract collectors.
- `server/test-tool-registry-truth.mjs`: existing registry gate, refactored to import helpers without changing its externally visible assertions.
- `server/test-tool-surface-contract.mjs`: new aggregate cross-surface and exemption-quality gate.
- `server/test-tool-discovery-intents.mjs`: new ToolIndex intent-query characterization gate.
- `server/test-tool-requirements.mjs`: existing requirement tests, expanded with metadata aggregate checks.
- `server/test-schema-remediation.mjs`: new direct-executor and connection-manager remediation tests for canonical parameter hints and unknown-command guidance.
- `server/connection-manager.mjs`: small JS-only unknown-command next-action hint in thrown wire errors.
- `server/test-deploy-awareness-source.mjs`: new source-level deploy-awareness wiring guard.

## Task 1: Extract Reusable Tool-Surface Helpers

**Files:**
- Create: `server/test-tool-surface-helpers.mjs`
- Modify: `server/test-tool-registry-truth.mjs`
- Test: `server/test-tool-registry-truth.mjs`

**Interfaces:**
- Consumes: parsed `tools.yaml`, live definition groups shaped as `[toolsetName, defs]`, and a `Set` of management tool names.
- Produces:
  - `isPlannedOrExcluded(def): boolean`
  - `buildCallableToolMap(groups): { map: Map<string,string>, duplicates: string[] }`
  - `findYamlToolDef(toolsData, toolName): object|null`
  - `collectCoveredWireCommands(toolsData, groups): Set<string>`
  - `collectPluginRegisteredCommands({ privateDir, ignoredFragments }): Promise<Set<string>>`
  - `collectYamlTools(toolsData, { groups, managementTools }): object`
  - `names(records): string[]`

- [ ] **Step 1: Write the failing import refactor**

In `server/test-tool-registry-truth.mjs`, replace the `node:fs/promises` import and add helper imports:

```js
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { TestRunner } from './test-helpers.mjs';
import {
  collectCoveredWireCommands,
  collectPluginRegisteredCommands,
  collectYamlTools,
  names,
} from './test-tool-surface-helpers.mjs';
```

Remove these local function declarations from `server/test-tool-registry-truth.mjs` after adding the import:

- `isPlannedOrExcluded`
- `buildCallableToolMap`
- `findYamlToolDef`
- `collectCoveredWireCommands`
- `collectPluginRegisteredCommands`
- `collectYamlTools`
- `names`

Replace the current classification and registered-command construction with:

```js
const classification = collectYamlTools(toolsData, {
  groups: LIVE_DEFINITION_GROUPS,
  managementTools: MANAGEMENT_TOOLS,
});
const registeredPluginCommands = await collectPluginRegisteredCommands({
  privateDir: join('..', 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private'),
});
const coveredWireCommands = collectCoveredWireCommands(toolsData, LIVE_DEFINITION_GROUPS);
```

- [ ] **Step 2: Run the registry test to verify RED**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
node test-tool-registry-truth.mjs
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `test-tool-surface-helpers.mjs`.

- [ ] **Step 3: Add the helper module**

Create `server/test-tool-surface-helpers.mjs` with:

```js
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

const DEFAULT_IGNORED_PLUGIN_SOURCE_FRAGMENTS = [
  'Tests',
  'PropertyHandlerRegistry.cpp',
];

export function isPlannedOrExcluded(def) {
  return def?.status === 'planned' || def?.discoverable === false;
}

export function buildCallableToolMap(groups) {
  const map = new Map();
  const duplicates = [];

  for (const [groupName, defs] of groups) {
    for (const toolName of Object.keys(defs)) {
      if (map.has(toolName)) {
        duplicates.push(`${toolName} (${map.get(toolName)} + ${groupName})`);
      } else {
        map.set(toolName, groupName);
      }
    }
  }

  return { map, duplicates };
}

export function findYamlToolDef(toolsData, toolName) {
  for (const toolset of Object.values(toolsData.toolsets || {})) {
    const def = toolset.tools?.[toolName];
    if (def) return def;
  }
  return null;
}

export function collectCoveredWireCommands(toolsData, groups) {
  const covered = new Set(['ping']);

  for (const [, defs] of groups) {
    for (const [toolName, def] of Object.entries(defs)) {
      if (def.partialRc?.tcpWireType) {
        covered.add(def.partialRc.tcpWireType);
        continue;
      }

      const yamlDef = findYamlToolDef(toolsData, toolName);
      covered.add(yamlDef?.wire_type || toolName);
    }
  }

  return covered;
}

function ignoredPluginSource(rel, ignoredFragments) {
  if (!rel.endsWith('.cpp')) return true;
  return ignoredFragments.some(fragment => rel.includes(fragment));
}

export async function collectPluginRegisteredCommands({
  privateDir,
  ignoredFragments = DEFAULT_IGNORED_PLUGIN_SOURCE_FRAGMENTS,
} = {}) {
  if (!privateDir) throw new Error('collectPluginRegisteredCommands requires privateDir');
  const files = await readdir(privateDir, { recursive: true });
  const commands = new Set();

  for (const rel of files) {
    if (ignoredPluginSource(rel, ignoredFragments)) continue;

    const source = await readFile(join(privateDir, rel), 'utf-8');
    for (const match of source.matchAll(/Registry\.Register\(TEXT\("([^"]+)"\)/g)) {
      commands.add(match[1]);
    }
    for (const match of source.matchAll(/Handlers\.Add\(TEXT\("([^"]+)"\)/g)) {
      commands.add(match[1]);
    }
  }

  return commands;
}

export function collectYamlTools(toolsData, { groups, managementTools }) {
  const management = [];
  const offline = [];
  const implementedLive = [];
  const exempted = [];
  const missingActiveLive = [];

  const { map: callableLiveTools, duplicates } = buildCallableToolMap(groups);

  for (const [toolName, def] of Object.entries(toolsData.management?.tools || {})) {
    management.push({
      name: `management.${toolName}`,
      toolset: 'management',
      toolName,
      def,
      implemented: managementTools.has(toolName),
    });
  }

  for (const [toolsetName, toolset] of Object.entries(toolsData.toolsets || {})) {
    for (const [toolName, def] of Object.entries(toolset.tools || {})) {
      const record = {
        name: `${toolsetName}.${toolName}`,
        toolset: toolsetName,
        toolName,
        layer: toolset.layer,
        def,
      };

      if (toolsetName === 'offline') {
        offline.push(record);
      } else if (isPlannedOrExcluded(def)) {
        exempted.push(record);
      } else if (callableLiveTools.has(toolName)) {
        implementedLive.push({ ...record, definitionGroup: callableLiveTools.get(toolName) });
      } else {
        missingActiveLive.push(record);
      }
    }
  }

  return {
    management,
    offline,
    implementedLive,
    exempted,
    missingActiveLive,
    duplicateCallableNames: duplicates,
    callableLiveTools,
  };
}

export function names(records) {
  return records.map(r => r.name).sort();
}
```

- [ ] **Step 4: Run the registry test to verify GREEN**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
node test-tool-registry-truth.mjs
```

Expected: PASS with `5` passed, `0` failed.

- [ ] **Step 5: Commit the helper extraction**

```cmd
git add server/test-tool-surface-helpers.mjs server/test-tool-registry-truth.mjs
git commit -m "D186 extract tool surface registry helpers"
```

## Task 2: Add Cross-Surface And Exemption-Quality Gate

**Files:**
- Modify: `server/test-tool-surface-helpers.mjs`
- Create: `server/test-tool-surface-contract.mjs`
- Test: `server/test-tool-surface-contract.mjs`, `server/test-tool-registry-truth.mjs`

**Interfaces:**
- Consumes from Task 1: `collectYamlTools`, `collectCoveredWireCommands`, `collectPluginRegisteredCommands`, `findYamlToolDef`, `names`.
- Produces:
  - `hasStructuredExemption(def): boolean`
  - `collectNodeToolsMissingYaml(toolsData, groups, options): string[]`
  - `collectUncoveredPluginCommands(registeredCommands, coveredCommands, options): string[]`

- [ ] **Step 1: Write the failing contract test**

Create `server/test-tool-surface-contract.mjs` with:

```js
// Tool surface contract gate.
// Run: cd D:\DevTools\UEMCP\server && node test-tool-surface-contract.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';

import { TestRunner } from './test-helpers.mjs';
import { getActorsToolDefs } from './actors-tcp-tools.mjs';
import { getBlueprintsWriteToolDefs } from './blueprints-write-tcp-tools.mjs';
import { getWidgetsToolDefs } from './widgets-tcp-tools.mjs';
import { getMenhanceToolDefs } from './menhance-tcp-tools.mjs';
import { getRcToolDefs } from './rc-tools.mjs';
import { getM5AnimationToolDefs } from './m5-animation-tools.mjs';
import { getM5MaterialsToolDefs } from './m5-materials-tools.mjs';
import { getM5InputPieToolDefs } from './m5-input-pie-tools.mjs';
import { getM5GeometryToolDefs } from './m5-geometry-tools.mjs';
import { getM5EditorUtilityToolDefs } from './m5-editor-utility-tools.mjs';
import {
  collectCoveredWireCommands,
  collectNodeToolsMissingYaml,
  collectPluginRegisteredCommands,
  collectUncoveredPluginCommands,
  collectYamlTools,
  hasStructuredExemption,
  names,
} from './test-tool-surface-helpers.mjs';

const MANAGEMENT_TOOLS = new Set([
  'connection_info',
  'detect_project',
  'find_tools',
  'list_toolsets',
  'enable_toolset',
  'disable_toolset',
  'list_project_targets',
  'attach_project',
  'detach_project',
  'refresh_project_context',
]);

const LIVE_DEFINITION_GROUPS = [
  ['actors', getActorsToolDefs()],
  ['blueprints-write', getBlueprintsWriteToolDefs()],
  ['widgets', getWidgetsToolDefs()],
  ['m-enhance', getMenhanceToolDefs()],
  ['remote-control', getRcToolDefs()],
  ['m5-animation', getM5AnimationToolDefs()],
  ['m5-materials', getM5MaterialsToolDefs()],
  ['m5-input-and-pie', getM5InputPieToolDefs()],
  ['m5-geometry', getM5GeometryToolDefs()],
  ['m5-editor-utility', getM5EditorUtilityToolDefs()],
];

const INTERNAL_WIRE_COMMANDS = new Map();

const t = new TestRunner('Tool Surface Contract Gate');
const toolsData = load(await readFile(join('..', 'tools.yaml'), 'utf-8'));
const classification = collectYamlTools(toolsData, {
  groups: LIVE_DEFINITION_GROUPS,
  managementTools: MANAGEMENT_TOOLS,
});

const missingYamlForNodeDefs = collectNodeToolsMissingYaml(toolsData, LIVE_DEFINITION_GROUPS);
t.assert(
  missingYamlForNodeDefs.length === 0,
  'Node definition-map tools all have tools.yaml rows',
  missingYamlForNodeDefs.join(', '),
);

const malformedExemptions = classification.exempted
  .filter(record => !hasStructuredExemption(record.def))
  .map(record => record.name)
  .sort();
t.assert(
  malformedExemptions.length === 0,
  'planned/hidden YAML rows have structured exemption metadata',
  malformedExemptions.join(', '),
);

const registeredCommands = await collectPluginRegisteredCommands({
  privateDir: join('..', 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private'),
});
const coveredCommands = collectCoveredWireCommands(toolsData, LIVE_DEFINITION_GROUPS);
const uncoveredCommands = collectUncoveredPluginCommands(registeredCommands, coveredCommands, {
  allowInternal: INTERNAL_WIRE_COMMANDS,
});
t.assert(
  uncoveredCommands.length === 0,
  'plugin TCP commands are public-wrapper covered or explicitly internal-owned',
  uncoveredCommands.join(', '),
);

const activeMissing = names(classification.missingActiveLive);
t.assert(
  activeMissing.length === 0,
  'active live YAML rows have callable Node definition maps',
  activeMissing.join(', '),
);

process.exit(t.summary());
```

- [ ] **Step 2: Run the new test to verify RED**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
node test-tool-surface-contract.mjs
```

Expected: FAIL with `does not provide an export named 'collectNodeToolsMissingYaml'`.

- [ ] **Step 3: Add the missing helper exports**

Append this code to `server/test-tool-surface-helpers.mjs`:

```js
export function hasStructuredExemption(def) {
  return def?.status === 'planned' ||
    def?.discoverable === false ||
    typeof def?.replaced_by === 'string' ||
    def?.offline_fallback !== undefined ||
    typeof def?.exemption_reason === 'string';
}

export function collectNodeToolsMissingYaml(toolsData, groups, { allowMissing = new Set() } = {}) {
  const missing = [];
  for (const [groupName, defs] of groups) {
    for (const toolName of Object.keys(defs)) {
      if (allowMissing.has(toolName)) continue;
      if (!findYamlToolDef(toolsData, toolName)) {
        missing.push(`${groupName}.${toolName}`);
      }
    }
  }
  return missing.sort();
}

export function collectUncoveredPluginCommands(
  registeredCommands,
  coveredCommands,
  { allowInternal = new Map() } = {},
) {
  return [...registeredCommands]
    .filter(command => !coveredCommands.has(command) && !allowInternal.has(command))
    .sort();
}
```

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
node test-tool-surface-contract.mjs
node test-tool-registry-truth.mjs
```

Expected:

- `test-tool-surface-contract.mjs`: `4` passed, `0` failed.
- `test-tool-registry-truth.mjs`: `5` passed, `0` failed.

- [ ] **Step 5: Commit the contract gate**

```cmd
git add server/test-tool-surface-helpers.mjs server/test-tool-surface-contract.mjs
git commit -m "D186 add tool surface contract gate"
```

## Task 3: Add Discovery Intent Gate

**Files:**
- Modify: `server/test-tool-surface-helpers.mjs`
- Create: `server/test-tool-discovery-intents.mjs`
- Test: `server/test-tool-discovery-intents.mjs`

**Interfaces:**
- Consumes: parsed `tools.yaml`.
- Produces:
  - `buildToolIndex(toolsData): ToolIndex`
  - `topToolNames(index, query, maxResults): string[]`

- [ ] **Step 1: Write the failing discovery test**

Create `server/test-tool-discovery-intents.mjs` with:

```js
// Tool discovery intent tests.
// Run: cd D:\DevTools\UEMCP\server && node test-tool-discovery-intents.mjs

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { load } from 'js-yaml';

import { TestRunner } from './test-helpers.mjs';
import {
  buildToolIndex,
  topToolNames,
} from './test-tool-surface-helpers.mjs';

const t = new TestRunner('Tool Discovery Intent Tests');
const toolsData = load(await readFile(join('..', 'tools.yaml'), 'utf-8'));
const index = buildToolIndex(toolsData);

function assertTopIncludes(query, expected, maxResults = 5) {
  const names = topToolNames(index, query, maxResults);
  t.assert(
    names.includes(expected),
    `find_tools intent "${query}" includes ${expected} in top ${maxResults}`,
    `got ${names.join(', ')}`,
  );
}

function assertTopIncludesAny(query, expectedAny, maxResults = 5) {
  const names = topToolNames(index, query, maxResults);
  const matched = expectedAny.some(name => names.includes(name));
  t.assert(
    matched,
    `find_tools intent "${query}" includes one of ${expectedAny.join(', ')} in top ${maxResults}`,
    `got ${names.join(', ')}`,
  );
}

assertTopIncludes('who references this asset', 'get_asset_references');
assertTopIncludesAny('PIE actor runtime state', ['get_pie_actor_state', 'sample_pie_actor_state']);
assertTopIncludes('Python command', 'run_python_command');
assertTopIncludes('list exports choose export', 'list_asset_exports');

const animGraphNames = topToolNames(index, 'AnimGraph state machine slot layered blend', 8);
t.assert(
  animGraphNames.includes('bp_list_graphs') || animGraphNames.includes('get_anim_sequence_info'),
  'AnimGraph intent currently routes to partial graph/animation surfaces',
  `got ${animGraphNames.join(', ')}`,
);
t.assert(
  !animGraphNames.includes('get_anim_graph'),
  'AnimGraph semantic readback remains an explicit known gap until animation.get_anim_graph ships',
  `got ${animGraphNames.join(', ')}`,
);

process.exit(t.summary());
```

- [ ] **Step 2: Run the new test to verify RED**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
node test-tool-discovery-intents.mjs
```

Expected: FAIL with `does not provide an export named 'buildToolIndex'`.

- [ ] **Step 3: Add ToolIndex helper exports**

Modify `server/test-tool-surface-helpers.mjs` by adding this import at the top:

```js
import { ToolIndex } from './tool-index.mjs';
```

Append these exports:

```js
export function buildToolIndex(toolsData) {
  const index = new ToolIndex();
  index.build(toolsData);
  return index;
}

export function topToolNames(index, query, maxResults = 5) {
  return index.search(query, maxResults).map(row => row.toolName);
}
```

- [ ] **Step 4: Run discovery and registry tests**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
node test-tool-discovery-intents.mjs
node test-tool-registry-truth.mjs
```

Expected:

- `test-tool-discovery-intents.mjs`: `6` passed, `0` failed.
- `test-tool-registry-truth.mjs`: `5` passed, `0` failed.

- [ ] **Step 5: Commit the discovery gate**

```cmd
git add server/test-tool-surface-helpers.mjs server/test-tool-discovery-intents.mjs
git commit -m "D186 add discovery intent contract tests"
```

## Task 4: Add Requirement Metadata Aggregate Gate

**Files:**
- Modify: `server/test-tool-surface-helpers.mjs`
- Modify: `server/test-tool-requirements.mjs`
- Test: `server/test-tool-requirements.mjs`

**Interfaces:**
- Consumes: parsed `tools.yaml` and `getToolRequirement`.
- Produces:
  - `collectRequirementMetadataMismatches(toolsData, getToolRequirement): string[]`
  - `isMutationRequirementKind(requirement): boolean`

- [ ] **Step 1: Write the failing aggregate requirement tests**

In `server/test-tool-requirements.mjs`, add this import:

```js
import {
  collectRequirementMetadataMismatches,
  isMutationRequirementKind,
} from './test-tool-surface-helpers.mjs';
```

Add this block before `process.exit(t.summary());`:

```js
console.log('\n── Aggregate metadata agreement ──');

const metadataMismatches = collectRequirementMetadataMismatches(toolsData, getToolRequirement);
t.assert(
  metadataMismatches.length === 0,
  'YAML mutation metadata agrees with derived requirement kinds',
  metadataMismatches.join('; '),
);

t.assert(
  isMutationRequirementKind(TOOL_REQUIREMENT_KINDS.LIVE_MUTATION) &&
    isMutationRequirementKind(TOOL_REQUIREMENT_KINDS.RC_MUTATION) &&
    isMutationRequirementKind(TOOL_REQUIREMENT_KINDS.PYTHON_EXEC) &&
    !isMutationRequirementKind(TOOL_REQUIREMENT_KINDS.LIVE_READ),
  'mutation requirement helper recognizes live, RC, and Python mutation-risk kinds',
);
```

- [ ] **Step 2: Run requirement tests to verify RED**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
node test-tool-requirements.mjs
```

Expected: FAIL with `does not provide an export named 'collectRequirementMetadataMismatches'`.

- [ ] **Step 3: Add requirement helper exports**

Append this code to `server/test-tool-surface-helpers.mjs`:

```js
export function isMutationRequirementKind(requirement) {
  return requirement === 'live_mutation' ||
    requirement === 'rc_mutation' ||
    requirement === 'python_exec';
}

function yamlRecordEntries(toolsData) {
  const records = [];
  for (const [toolName, def] of Object.entries(toolsData.management?.tools || {})) {
    records.push({ toolsetName: 'management', toolName, def });
  }
  for (const [toolsetName, toolset] of Object.entries(toolsData.toolsets || {})) {
    for (const [toolName, def] of Object.entries(toolset.tools || {})) {
      records.push({ toolsetName, toolName, def });
    }
  }
  return records;
}

function metadataImpliesMutationRisk(def = {}) {
  return def.mutates_asset === true ||
    def.mutates_level === true ||
    def.saves_asset === true ||
    def.compiles_asset === true;
}

export function collectRequirementMetadataMismatches(toolsData, getToolRequirement) {
  const mismatches = [];

  for (const { toolsetName, toolName, def } of yamlRecordEntries(toolsData)) {
    if (toolName === 'run_python_command') {
      const requirement = getToolRequirement(toolName, toolsetName, def);
      if (requirement !== 'python_exec') {
        mismatches.push(`${toolsetName}.${toolName}: expected python_exec, got ${requirement}`);
      }
      continue;
    }

    if (toolsetName === 'offline') {
      const requirement = getToolRequirement(toolName, toolsetName, def);
      if (requirement !== 'offline_read') {
        mismatches.push(`${toolsetName}.${toolName}: expected offline_read, got ${requirement}`);
      }
      continue;
    }

    if (!metadataImpliesMutationRisk(def)) continue;

    const requirement = getToolRequirement(toolName, toolsetName, def);
    if (!isMutationRequirementKind(requirement)) {
      mismatches.push(`${toolsetName}.${toolName}: metadata mutates/saves/compiles but requirement=${requirement}`);
    }
  }

  return mismatches.sort();
}
```

- [ ] **Step 4: Run requirement tests to verify GREEN**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
node test-tool-requirements.mjs
```

Expected: PASS. The exact count should increase by `2` from the current `11`.

- [ ] **Step 5: Commit the requirement gate**

```cmd
git add server/test-tool-surface-helpers.mjs server/test-tool-requirements.mjs
git commit -m "D186 add aggregate requirement metadata gate"
```

## Task 5: Add Schema Remediation And Unknown-Command Guidance

**Files:**
- Create: `server/test-schema-remediation.mjs`
- Modify: `server/connection-manager.mjs`
- Test: `server/test-schema-remediation.mjs`, `server/test-mock-seam.mjs`

**Interfaces:**
- Consumes: direct executors, Zod management shapes, `ConnectionManager`, `FakeTcpResponder`.
- Produces: unknown-command errors that keep `UNKNOWN_COMMAND` and append a next-action hint.

- [ ] **Step 1: Write the failing schema-remediation test**

Create `server/test-schema-remediation.mjs` with:

```js
// Schema remediation and unknown-command guidance tests.
// Run: cd D:\DevTools\UEMCP\server && node test-schema-remediation.mjs

import { z } from 'zod';

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import { executeMenhanceTool, initMenhanceTools } from './menhance-tcp-tools.mjs';

const t = new TestRunner('Schema Remediation Tests');

const fakeToolsYaml = {
  toolsets: {
    animation: {
      tools: {
        get_montage_full: {},
      },
    },
    'asset-registry': {
      tools: {
        get_asset_references: {},
      },
    },
  },
};

initMenhanceTools(fakeToolsYaml);

{
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('get_montage_full', { status: 'success', result: {} });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeMenhanceTool('get_montage_full', { montage_path: '/Game/AM_Test' }, cm),
    /asset_path/i,
    'get_montage_full rejects montage_path and names canonical asset_path',
  );
}

{
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('get_asset_references', { status: 'success', result: {} });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeMenhanceTool('get_asset_references', { assetPath: '/Game/A' }, cm),
    /asset_path/i,
    'get_asset_references rejects assetPath and names canonical asset_path',
  );
}

{
  const enableToolsetInputShape = z.object({
    toolsets: z.array(z.string()),
  });
  const parsed = enableToolsetInputShape.safeParse({ name: 'offline' });
  t.assert(
    parsed.success === false && /toolsets/i.test(String(parsed.error?.message)),
    'enable_toolset-style shape rejects name and names canonical toolsets',
    parsed.success ? 'unexpected success' : String(parsed.error?.message),
  );
}

{
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('bogus_wire_command', {
    status: 'error',
    code: 'UNKNOWN_COMMAND',
    error: 'unknown command: bogus_wire_command',
  });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => cm.send('tcp-55558', 'bogus_wire_command', {}, { skipCache: true }),
    /find_tools|tools\.yaml|public wrapper/i,
    'UNKNOWN_COMMAND errors include next-action guidance',
  );
}

process.exit(t.summary());
```

- [ ] **Step 2: Run the schema test to verify RED**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
node test-schema-remediation.mjs
```

Expected: FAIL on `UNKNOWN_COMMAND errors include next-action guidance`. The schema-name checks may already pass.

- [ ] **Step 3: Add UNKNOWN_COMMAND next-action guidance**

Modify `makeLayerWireError` in `server/connection-manager.mjs` to build the error message through a local hint:

```js
function unknownCommandHint(wireError) {
  if (wireError.code !== 'UNKNOWN_COMMAND') return '';
  return ' Next action: call find_tools to locate the public wrapper, or inspect tools.yaml wire_type mappings; do not use raw TCP command names as the primary workflow.';
}

function makeLayerWireError(layerKey, wireError, wireResponse) {
  const err = new Error(`${layerKey}: ${wireError.message}${unknownCommandHint(wireError)}`);
  err.layer = layerKey;
  err.wireError = wireError;
  err.wireResponse = wireResponse;
  if (wireError.code) {
    err.code = wireError.code;
  }
  if ('detail' in wireError) {
    err.detail = wireError.detail;
  }
  return err;
}
```

- [ ] **Step 4: Run focused tests to verify GREEN**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
node test-schema-remediation.mjs
node test-mock-seam.mjs
```

Expected:

- `test-schema-remediation.mjs`: `4` passed, `0` failed.
- `test-mock-seam.mjs`: current full count passes with `0` failed.

- [ ] **Step 5: Commit schema remediation**

```cmd
git add server/test-schema-remediation.mjs server/connection-manager.mjs
git commit -m "D186 add schema remediation guidance"
```

## Task 6: Add Deploy-Awareness Source Gate And Final Rotation

**Files:**
- Modify: `server/test-tool-surface-helpers.mjs`
- Create: `server/test-deploy-awareness-source.mjs`
- Test: `server/test-deploy-awareness-source.mjs`, `server/test-project-server-wire.mjs`, full rotation

**Interfaces:**
- Consumes: source text from `server/create-uemcp-server.mjs`, `server/project-context.mjs`, and `server/verify-deploy.mjs`.
- Produces:
  - `missingSourceNeedles(source, needles): string[]`

- [ ] **Step 1: Write the failing source-awareness test**

Create `server/test-deploy-awareness-source.mjs` with:

```js
// Deploy-awareness source wiring guard.
// Run: cd D:\DevTools\UEMCP\server && node test-deploy-awareness-source.mjs

import { readFile } from 'node:fs/promises';

import { TestRunner } from './test-helpers.mjs';
import { missingSourceNeedles } from './test-tool-surface-helpers.mjs';

const t = new TestRunner('Deploy Awareness Source Guard');

const serverSource = await readFile('create-uemcp-server.mjs', 'utf-8');
const projectContextSource = await readFile('project-context.mjs', 'utf-8');
const verifyDeploySource = await readFile('verify-deploy.mjs', 'utf-8');

const serverNeedles = [
  'refreshDeployReadinessForConnectionInfo',
  'refreshEditorReadinessForConnectionInfo',
  "'get_editor_state'",
  "{ skipCache: true }",
  'readiness',
  'deployFreshness',
];
t.assert(
  missingSourceNeedles(serverSource, serverNeedles).length === 0,
  'connection_info force reconnect keeps editor identity and deploy freshness wired',
  missingSourceNeedles(serverSource, serverNeedles).join(', '),
);

const projectContextNeedles = [
  'refreshEditorHandshake',
  'plugin_version',
  'deploy_marker_manifest_version',
  'deployMarkerManifestVersion',
  'deployFreshnessState',
];
t.assert(
  missingSourceNeedles(projectContextSource, projectContextNeedles).length === 0,
  'ProjectContext consumes plugin handshake and deploy marker fields',
  missingSourceNeedles(projectContextSource, projectContextNeedles).join(', '),
);

const verifyDeployNeedles = [
  'MISSING',
  'NEEDS-SYNC',
  'NEEDS-BUILD',
  'ALL-SYNC',
];
t.assert(
  missingSourceNeedles(verifyDeploySource, verifyDeployNeedles).length === 0,
  'verify-deploy distinguishes missing, sync, build, and fresh states',
  missingSourceNeedles(verifyDeploySource, verifyDeployNeedles).join(', '),
);

process.exit(t.summary());
```

- [ ] **Step 2: Run the source-awareness test to verify RED**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
node test-deploy-awareness-source.mjs
```

Expected: FAIL with `does not provide an export named 'missingSourceNeedles'`.

- [ ] **Step 3: Add the source-string helper**

Append this code to `server/test-tool-surface-helpers.mjs`:

```js
export function missingSourceNeedles(source, needles) {
  return needles.filter(needle => !source.includes(needle));
}
```

- [ ] **Step 4: Run deploy-awareness tests**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
node test-deploy-awareness-source.mjs
node test-project-server-wire.mjs
```

Expected:

- `test-deploy-awareness-source.mjs`: `3` passed, `0` failed.
- `test-project-server-wire.mjs`: current full count passes with `0` failed.

- [ ] **Step 5: Run the full rotation**

Run:

```cmd
cd /d D:\DevTools\UEMCP\server
npm test
```

Expected: full rotation passes with `0 failed`. Environment/live-gated skips are acceptable when they are explicitly reported by `run-rotation.mjs`.

- [ ] **Step 6: Run diff hygiene**

Run:

```cmd
cd /d D:\DevTools\UEMCP
git diff --check
git status --short --untracked-files=all
```

Expected:

- `git diff --check` reports no whitespace errors.
- `git status` shows only files intentionally changed by this plan.

- [ ] **Step 7: Commit final deploy-awareness gate**

```cmd
git add server/test-tool-surface-helpers.mjs server/test-deploy-awareness-source.mjs
git commit -m "D186 add deploy awareness source gate"
```

## Self-Review Checklist

- [ ] Spec coverage: Requirement 1 maps to Task 1; Requirement 2 maps to Task 2; Requirement 3 maps to Task 2; Requirement 4 maps to Task 3; Requirement 5 maps to Task 4; Requirement 6 maps to Task 5; Requirement 7 maps to Task 6.
- [ ] Non-goals preserved: no `animation.get_anim_graph`, no generic TCP dispatcher, no broad alias acceptance, no live smoke replacement, no deploy-proof overclaim.
- [ ] Type consistency: helper names in task tests match helper exports exactly.
- [ ] Rotation compatibility: every new test file is named `test-*.mjs` so `run-rotation.mjs` discovers it automatically.
- [ ] Editor safety: all new tests are source-only or fake-responder tests; no test requires Unreal Editor.
- [ ] Final verification: `npm test` and `git diff --check` are run before completion.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-07-tool-surface-contract-hardening.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.
