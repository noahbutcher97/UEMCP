# Blueprint Authoring Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a reliable Blueprint authoring stack in priority order: lifecycle truth, variable/default ergonomics, timer authoring, PIE verification hardening, and a live timer-mover acceptance smoke.

**Architecture:** Keep core authoring primitives in `blueprints-write` on TCP:55558. Put generic asset save behavior in `editor-utility`. Keep wait/sampling behavior in Node so Unreal can keep ticking during PIE. Each task must add failing tests first, then production code, then registry/docs updates, then verification.

**Tech Stack:** Node.js ES modules, Zod schemas, `tools.yaml`, UE 5.6 C++ editor plugin handlers, PowerShell verification commands, live editor smoke scripts.

---

## File Structure

- `server/blueprints-write-tcp-tools.mjs`: Blueprint write schemas, including lifecycle, variable, and timer tool definitions.
- `server/m5-editor-utility-tools.mjs`: editor utility schemas, including the new generic `save_asset` tool.
- `server/menhance-tcp-tools.mjs`: PIE runtime sampling stays here; avoid C++ wait loops.
- `server/test-m3-blueprints-write.mjs`: Blueprint write routing, schema, response, and cache tests.
- `server/test-m5-editor-utility.mjs`: editor utility routing and save tests.
- `server/test-blueprint-workflow-variables.mjs`: focused variable workflow coverage.
- `server/test-pie-runtime-tools.mjs`: runtime sampler and stable-state helper tests.
- `server/live-smoke-d147-blueprint-pie.mjs`: existing general live smoke; keep passing.
- `server/live-smoke-blueprint-timer-mover.mjs`: new final opt-in live acceptance smoke.
- `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp`: Blueprint lifecycle, variable, and timer C++ handlers.
- `plugin/UEMCP/Source/UEMCP/Private/EditorUtilityHandlers.cpp`: generic asset save handler.
- `plugin/UEMCP/Source/UEMCP/Public/*.h`: only update comments or declarations when a cross-file interface changes.
- `tools.yaml`: user-facing registry entries, metadata, and descriptions.
- `manifest.json` and `plugin/UEMCP/UEMCP.uplugin`: bump for every deploy-visible plugin C++ change.

## Execution Rules

Core tasks are sequential. Do not run Tasks 1-5 in parallel because each task depends on the previous API surface. Parallel-safe side work is limited to docs/count updates, fixture-only tests, and read-only audits that do not modify production code.

Each task must end with a focused commit. If plugin C++ changed, run `node test-verify-deploy.mjs`, bump both version files, sync/rebuild the target project before live verification, and finish with `verify-deploy.bat --no-pause`.

---

### Task 1: Blueprint Lifecycle And Save Surfaces

**Files:**
- Modify: `server/blueprints-write-tcp-tools.mjs`
- Modify: `server/m5-editor-utility-tools.mjs`
- Modify: `server/test-m3-blueprints-write.mjs`
- Modify: `server/test-m5-editor-utility.mjs`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/EditorUtilityHandlers.cpp`
- Modify: `tools.yaml`
- Modify: `manifest.json`
- Modify: `plugin/UEMCP/UEMCP.uplugin`

- [ ] **Step 1: Write failing schema tests for lifecycle tools**

Add assertions in `server/test-m3-blueprints-write.mjs` that `compile_and_save_blueprint` exists, routes to TCP:55558, bypasses cache, and forwards these params:

```js
fake.on('compile_and_save_blueprint', {
  status: 'success',
  result: {
    compiled_ok: true,
    saved: true,
    save: { saved: true, dirty_before: true, dirty_after: false },
    compile: compileDiagnosticResult('BP_Player'),
  },
});

await executeBlueprintsWriteTool('compile_and_save_blueprint', {
  blueprint_name: 'BP_Player',
  fail_on_compile_error: true,
}, cm);
const call = fake.lastCall('compile_and_save_blueprint');
t.assert(call && call.port === 55558, 'compile_and_save_blueprint routes to tcp-55558');
t.assert(call.params.fail_on_compile_error === true, 'compile_and_save_blueprint forwards fail_on_compile_error');
```

- [ ] **Step 2: Write failing schema tests for generic save**

Add assertions in `server/test-m5-editor-utility.mjs`:

```js
fake.on('save_asset', {
  status: 'success',
  result: {
    asset_path: '/Game/UEMCP/BP_Test',
    saved: true,
    dirty_before: true,
    dirty_after: false,
  },
});

const response = await executeM5EditorUtilityTool('save_asset', {
  asset_path: '/Game/UEMCP/BP_Test',
}, cm);
t.assert(response.result.saved === true, 'save_asset reports saved:true');
t.assert(fake.lastCall('save_asset').port === 55558, 'save_asset routes to tcp-55558');
```

- [ ] **Step 3: Run the focused tests and verify they fail**

Run:

```powershell
cd server
node test-m3-blueprints-write.mjs
node test-m5-editor-utility.mjs
```

Expected: both tests fail because `compile_and_save_blueprint` and `save_asset` are not defined.

- [ ] **Step 4: Add Node schemas**

In `server/blueprints-write-tcp-tools.mjs`, add:

```js
compile_and_save_blueprint: {
  description: 'Compile a Blueprint with diagnostic output and save it when compilation succeeds.',
  schema: {
    blueprint_name: z.string().describe('Blueprint asset name or /Game/... path'),
    fail_on_compile_error: z.boolean().optional().default(true)
      .describe('When true, do not save if compile diagnostics contain errors. Default true.'),
  },
  isReadOp: false,
},
```

In `server/m5-editor-utility-tools.mjs`, add:

```js
save_asset: {
  description: 'Save an editor asset by /Game/... path and report dirty-state before and after save.',
  schema: {
    asset_path: z.string().describe('/Game/... asset path to save'),
  },
  isReadOp: false,
},
```

- [ ] **Step 5: Implement C++ save helper**

In `EditorUtilityHandlers.cpp`, add a handler that validates `asset_path`, checks existence, reads dirty state from the package, calls `UEditorAssetLibrary::SaveAsset(AssetPath, false)`, then returns:

```json
{
  "asset_path": "/Game/UEMCP/BP_Test",
  "saved": true,
  "dirty_before": true,
  "dirty_after": false,
  "package_path": "/Game/UEMCP/BP_Test"
}
```

Register it:

```cpp
Registry.Register(TEXT("save_asset"), &HandleSaveAsset);
```

- [ ] **Step 6: Implement compile-and-save**

In `BlueprintHandlers.cpp`, add `HandleCompileAndSaveBlueprint`. It must call `BuildBlueprintCompileDiagnosticResult(Blueprint, BPName)`, inspect `compiled_ok`, skip save with `COMPILE_FAILED` when `fail_on_compile_error` is true and errors exist, and save the Blueprint package when compile succeeds.

Register it:

```cpp
Registry.Register(TEXT("compile_and_save_blueprint"), &HandleCompileAndSaveBlueprint);
```

- [ ] **Step 7: Update registry metadata**

Add `compile_and_save_blueprint` under `blueprints-write` and `save_asset` under `editor-utility` in `tools.yaml`. Mark both as shipped, `availability_layer: tcp-55558`, `transport_layer: tcp-55558`, `requires_editor: true`, `mutates_asset: true`, `saves_asset: true`, `compiles_asset: true` only for `compile_and_save_blueprint`.

- [ ] **Step 8: Bump deploy versions**

Increment `manifest.json` package version and `plugin/UEMCP/UEMCP.uplugin` `Version` / `VersionName` in the same commit.

- [ ] **Step 9: Verify**

Run:

```powershell
cd server
node test-m3-blueprints-write.mjs
node test-m5-editor-utility.mjs
node test-tool-registry-truth.mjs
npm test
```

Expected: all pass when `UNREAL_PROJECT_ROOT` is set to a real target project root.

- [ ] **Step 10: Commit**

```powershell
git add server/blueprints-write-tcp-tools.mjs server/m5-editor-utility-tools.mjs server/test-m3-blueprints-write.mjs server/test-m5-editor-utility.mjs plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp plugin/UEMCP/Source/UEMCP/Private/EditorUtilityHandlers.cpp tools.yaml manifest.json plugin/UEMCP/UEMCP.uplugin
git commit -m "D156 Add Blueprint lifecycle save surfaces"
```

---

### Task 2: Variable Defaults And Assignment Ergonomics

**Files:**
- Modify: `server/blueprints-write-tcp-tools.mjs`
- Modify: `server/test-blueprint-workflow-variables.mjs`
- Modify: `server/test-m3-blueprints-write.mjs`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp`
- Modify: `tools.yaml`
- Modify: `manifest.json`
- Modify: `plugin/UEMCP/UEMCP.uplugin`

- [ ] **Step 1: Write failing tests for variable default support**

In `server/test-blueprint-workflow-variables.mjs`, add:

```js
fake.on('set_blueprint_variable_default', {
  status: 'success',
  result: {
    variable_name: 'Speed',
    default_value: 350,
    dirty: true,
    requires_compile: true,
  },
});

const response = await executeBlueprintsWriteTool('set_variable_default', {
  blueprint_name: '/Game/UEMCP/BP_TimerMover',
  variable_name: 'Speed',
  value: 350,
}, cm);
t.assert(response.result.variable_name === 'Speed', 'set_variable_default returns variable name');
t.assert(fake.lastCall('set_blueprint_variable_default').params.value === 350, 'set_variable_default forwards scalar value');
```

- [ ] **Step 2: Write failing tests for supported default shapes**

Add assertions for Boolean, Integer, Float, String, and Vector:

```js
for (const [variable_name, value] of [
  ['bEnabled', true],
  ['Count', 3],
  ['Speed', 350.5],
  ['Label', 'Mover'],
  ['Axis', [1, 0, 0]],
]) {
  await executeBlueprintsWriteTool('set_variable_default', {
    blueprint_name: '/Game/UEMCP/BP_TimerMover',
    variable_name,
    value,
  }, cm);
}
t.assert(fake.callsFor('set_blueprint_variable_default').length === 5,
  'set_variable_default accepts scalar and vector defaults');
```

- [ ] **Step 3: Run tests and verify failure**

Run:

```powershell
cd server
node test-blueprint-workflow-variables.mjs
```

Expected: failure because `set_variable_default` is not defined.

- [ ] **Step 4: Add Node schema and wire mapping**

In `BLUEPRINTS_WRITE_INTERNAL_WIRE_MAP`, add:

```js
set_variable_default: 'set_blueprint_variable_default',
```

In `BLUEPRINTS_WRITE_SCHEMAS`, add:

```js
set_variable_default: {
  description: 'Set a Blueprint member variable default value on the generated CDO and mark the Blueprint modified.',
  schema: {
    blueprint_name: z.string().describe('Blueprint asset name or /Game/... path'),
    variable_name: z.string().describe('Member variable name'),
    value: z.union([z.number(), z.boolean(), z.string(), Vec3])
      .describe('Default value. Supports Number, Boolean, String, and Vector [x,y,z].'),
    compile: z.boolean().optional().describe('If true, compile after setting the default. Default false.'),
  },
  isReadOp: false,
},
```

- [ ] **Step 5: Implement C++ default setter**

In `BlueprintHandlers.cpp`, implement `HandleSetBlueprintVariableDefault`. Reuse existing `SetUProperty` against the Blueprint CDO. On success, call `PostEditChangeProperty`, mark the Blueprint modified, optionally compile if `compile:true`, and return:

```json
{
  "variable_name": "Speed",
  "default_value": 350,
  "dirty": true,
  "requires_compile": true
}
```

For unsupported property shape or missing variable, return structured errors:

```json
{ "status": "error", "code": "VARIABLE_NOT_FOUND", "error": "Variable not found: Speed" }
```

- [ ] **Step 6: Keep graph assignment behavior compatible**

Do not change `add_variable_assignment` parameter names. Add tests only for response additive fields if the C++ handler is improved:

```js
t.assert(Array.isArray(response.result.links), 'add_variable_assignment returns link metadata');
t.assert(response.result.requires_compile === true, 'add_variable_assignment reports requires_compile');
```

- [ ] **Step 7: Update registry metadata and version**

Add `set_variable_default` to `tools.yaml` under `blueprints-write`, mark it shipped and write-oriented, then bump both deploy version files.

- [ ] **Step 8: Verify**

Run:

```powershell
cd server
node test-blueprint-workflow-variables.mjs
node test-m3-blueprints-write.mjs
node test-tool-registry-truth.mjs
npm test
```

Expected: all pass with a target project root exported.

- [ ] **Step 9: Commit**

```powershell
git add server/blueprints-write-tcp-tools.mjs server/test-blueprint-workflow-variables.mjs server/test-m3-blueprints-write.mjs plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp tools.yaml manifest.json plugin/UEMCP/UEMCP.uplugin
git commit -m "D157 Add Blueprint variable default workflow"
```

---

### Task 3: Timer Callback Authoring Helper

**Files:**
- Modify: `server/blueprints-write-tcp-tools.mjs`
- Modify: `server/test-m3-blueprints-write.mjs`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp`
- Modify: `tools.yaml`
- Modify: `manifest.json`
- Modify: `plugin/UEMCP/UEMCP.uplugin`

- [ ] **Step 1: Write failing timer helper tests**

In `server/test-m3-blueprints-write.mjs`, add:

```js
fake.on('add_blueprint_timer', {
  status: 'success',
  result: {
    blueprint_name: '/Game/UEMCP/BP_TimerMover',
    callback_function: 'MoveStep',
    begin_play_node_id: 'BEGIN',
    timer_node_id: 'TIMER',
    function_graph_created: true,
    requires_compile: true,
    links: [{ source_node_id: 'BEGIN', target_node_id: 'TIMER' }],
  },
});

const response = await executeBlueprintsWriteTool('add_timer', {
  blueprint_name: '/Game/UEMCP/BP_TimerMover',
  callback_function: 'MoveStep',
  interval: 0.05,
  looping: true,
  create_callback_graph: true,
  insert_on_begin_play: true,
});
t.assert(response.result.timer_node_id === 'TIMER', 'add_timer returns timer node id');
t.assert(fake.lastCall('add_blueprint_timer').params.looping === true, 'add_timer forwards looping');
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
cd server
node test-m3-blueprints-write.mjs
```

Expected: failure because `add_timer` is not defined.

- [ ] **Step 3: Add Node schema**

Add internal wire mapping:

```js
add_timer: 'add_blueprint_timer',
```

Add schema:

```js
add_timer: {
  description: 'Create a Blueprint SetTimerByFunctionName setup, optionally inserted from BeginPlay and optionally creating the callback function graph.',
  schema: {
    blueprint_name: z.string().describe('Blueprint asset name or /Game/... path'),
    callback_function: z.string().describe('Function graph called by the timer'),
    interval: z.number().positive().describe('Timer interval in seconds'),
    looping: z.boolean().optional().default(true).describe('Whether the timer loops. Default true.'),
    create_callback_graph: z.boolean().optional().default(true).describe('Create the callback function graph if missing. Default true.'),
    insert_on_begin_play: z.boolean().optional().default(true).describe('Wire timer setup from ReceiveBeginPlay. Default true.'),
    compile: z.boolean().optional().describe('If true, compile after authoring. Default false.'),
  },
  isReadOp: false,
},
```

- [ ] **Step 4: Implement C++ timer helper**

In `BlueprintHandlers.cpp`, implement `HandleAddBlueprintTimer` using existing graph helpers:

- Resolve Blueprint.
- Resolve or create EventGraph.
- Create callback function graph when requested.
- Find or create `ReceiveBeginPlay` when insertion is requested.
- Create a K2 call node for `UKismetSystemLibrary::K2_SetTimer`.
- Set function name, interval, and looping defaults.
- Validate and create exec links using `UEdGraphSchema_K2::CanCreateConnection`.
- Return node IDs, graph names, link metadata, and `requires_compile:true`.

If `create_callback_graph:false` and the function graph is missing, return:

```json
{ "status": "error", "code": "CALLBACK_GRAPH_NOT_FOUND", "error": "Callback function graph not found: MoveStep" }
```

- [ ] **Step 5: Update registry and version**

Add `add_timer` to `tools.yaml` under `blueprints-write`, mark it shipped, `mutates_asset:true`, `compiles_asset:false`, `saves_asset:false`, and bump version files.

- [ ] **Step 6: Verify**

Run:

```powershell
cd server
node test-m3-blueprints-write.mjs
node test-tool-registry-truth.mjs
npm test
```

Expected: all pass with a target project root exported.

- [ ] **Step 7: Commit**

```powershell
git add server/blueprints-write-tcp-tools.mjs server/test-m3-blueprints-write.mjs plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp tools.yaml manifest.json plugin/UEMCP/UEMCP.uplugin
git commit -m "D158 Add Blueprint timer authoring helper"
```

---

### Task 4: PIE Stable Sampling Helper

**Files:**
- Modify: `server/menhance-tcp-tools.mjs`
- Modify: `server/test-pie-runtime-tools.mjs`
- Modify: `tools.yaml`

- [ ] **Step 1: Write failing stable-state tests**

Add a Node-composed tool named `wait_for_pie_actor_stable` to `server/test-pie-runtime-tools.mjs`:

```js
let calls = 0;
fake.on('get_pie_actor_state', () => {
  calls++;
  const z = calls < 3 ? 0 : 120;
  return {
    status: 'success',
    result: {
      transform: { location: [0, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] },
      resolved: { name: 'Mover' },
    },
  };
});

const stable = await executeMenhanceTool('wait_for_pie_actor_stable', {
  actor_ref: { name: 'Mover' },
  interval_ms: 1,
  stable_samples: 2,
  tolerance: 0.01,
  timeout_ms: 20,
}, cm);
t.assert(stable.stable === true, 'wait_for_pie_actor_stable reports stable:true');
t.assert(stable.final.result.transform.location[2] === 120, 'wait_for_pie_actor_stable returns final stable state');
```

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
cd server
node test-pie-runtime-tools.mjs
```

Expected: failure because `wait_for_pie_actor_stable` is not defined.

- [ ] **Step 3: Implement Node composite**

In `server/menhance-tcp-tools.mjs`, add a schema mirroring `sample_pie_actor_state` with `stable_samples`, `tolerance`, `timeout_ms`, and `interval_ms`. Implement it by repeatedly calling `get_pie_actor_state` with `skipCache:true`, comparing `transform.location`, `rotation`, and `scale` deltas. Return:

```json
{
  "stable": true,
  "sample_count": 4,
  "elapsed_ms": 18,
  "final": { "status": "success", "result": { "transform": { "location": [0, 0, 120] } } }
}
```

If timeout expires, return an error response with code `PIE_ACTOR_NOT_STABLE`.

- [ ] **Step 4: Update registry**

Add `wait_for_pie_actor_stable` under `input-and-pie` in `tools.yaml`. Mark it shipped, read-style runtime observation, `requires_editor:true`, `requires_pie:true`, `mutates_asset:false`, and `mutates_level:false`.

- [ ] **Step 5: Verify**

Run:

```powershell
cd server
node test-pie-runtime-tools.mjs
node test-tool-registry-truth.mjs
npm test
```

Expected: all pass with a target project root exported. No plugin rebuild is required because this task is Node-only.

- [ ] **Step 6: Commit**

```powershell
git add server/menhance-tcp-tools.mjs server/test-pie-runtime-tools.mjs tools.yaml
git commit -m "D159 Add PIE actor stable-state helper"
```

---

### Task 5: Timer-Mover Live Acceptance Smoke

**Files:**
- Create: `server/live-smoke-blueprint-timer-mover.mjs`

- [ ] **Step 1: Create the live smoke script skeleton**

Create `server/live-smoke-blueprint-timer-mover.mjs` with the same safety gates as the existing live smoke:

```js
if (process.env.UEMCP_LIVE_SMOKE !== '1') {
  console.error('Refusing to run: set UEMCP_LIVE_SMOKE=1 to allow live editor mutations.');
  process.exit(2);
}
if (!process.env.UNREAL_PROJECT_ROOT) {
  console.error('Refusing to run: UNREAL_PROJECT_ROOT is required.');
  process.exit(2);
}
```

- [ ] **Step 2: Author the temporary Blueprint**

The script must create `/Game/UEMCP/BP_UEMCP_TimerMover_<stamp>`, add a static mesh component for visibility, add exposed variables `MoveAxis`, `MoveSpeed`, `MoveDistance`, and `Direction`, set their defaults through `set_variable_default`, add timer setup through `add_timer`, and compile/save through `compile_and_save_blueprint`.

- [ ] **Step 3: Implement movement graph with existing graph primitives**

Use existing node tools to author a conservative movement callback:

- read current actor location
- compute `MoveAxis * MoveSpeed * Direction`
- add to current location
- call `SetActorLocation`

If a missing K2 factory blocks this graph, stop with a report line that names the exact missing node/function support. Do not hide the failure by switching to a one-off C++ movement helper.

- [ ] **Step 4: Spawn, start PIE, stabilize, and sample**

The live smoke must:

```js
await executeMenhanceTool('stop_pie', {}, cm).catch(() => null);
await executeActorsTool('spawn_blueprint_actor', { blueprint_name: bpPath, name: actorName, location: [0, 0, 120] }, cm);
await executeMenhanceTool('start_pie', { mode: 'viewport' }, cm);
await executeMenhanceTool('wait_for_pie_actor_stable', { actor_ref: { name: actorName }, stable_samples: 2 }, cm);
const sample = await executeMenhanceTool('sample_pie_actor_state', {
  actor_ref: { name: actorName },
  duration_ms: 1000,
  interval_ms: 250,
  max_samples: 5,
}, cm);
```

Assert that `sample.delta.location` has nonzero movement on the configured axis and minimal movement on the other axes.

- [ ] **Step 5: Cleanup must always run**

Use `finally` cleanup:

- stop PIE
- verify `get_pie_session_state` returns `pie_running:false`
- delete spawned actor
- delete the temporary Blueprint asset with `delete_asset_safe force:true permanent:true`

- [ ] **Step 6: Run live smoke**

Run with an open editor:

```powershell
cd server
$env:UEMCP_LIVE_SMOKE='1'
node live-smoke-blueprint-timer-mover.mjs
```

Expected: PASS lines for create, defaults, timer, compile/save, spawn, PIE state, stable wait, sample delta, stop PIE, actor delete, and asset delete.

- [ ] **Step 7: Verify non-live tests**

Run:

```powershell
cd server
npm test
```

Expected: full rotation passes with a target project root exported.

- [ ] **Step 8: Commit**

```powershell
git add server/live-smoke-blueprint-timer-mover.mjs
git commit -m "D160 Add Blueprint timer mover live smoke"
```

---

## Parallel-Safe Side Tasks

These can be delegated while the core sequence waits for builds or live editor availability. They must not edit `BlueprintHandlers.cpp`, `EditorUtilityHandlers.cpp`, `blueprints-write-tcp-tools.mjs`, `menhance-tcp-tools.mjs`, or `tools.yaml`.

### Side Task A: Documentation Count Refresh

Update tracked docs that list total registry counts after each shipped tool batch. Verify with:

```powershell
cd server
node test-tool-registry-truth.mjs
```

### Side Task B: Read-Only Blueprint Write Audit

Read current Blueprint write handlers and produce a tracked report under `docs/reports/` listing which K2 function factories are still missing for movement workflows. Do not change production code.

### Side Task C: Live Evidence Report

After Task 5 passes, write a tracked report under `docs/reports/` with command output summary, cleanup confirmation, positives, negatives, and follow-up recommendations.

---

## Final Verification Gate

Before declaring the batch complete:

```powershell
cd server
node test-tool-registry-truth.mjs
node test-tool-metadata.mjs
npm test
```

If plugin C++ changed:

```powershell
cd ..
.\verify-deploy.bat --no-pause
```

With an open editor, run:

```powershell
cd server
$env:UEMCP_LIVE_SMOKE='1'
node live-smoke-d147-blueprint-pie.mjs
node live-smoke-blueprint-timer-mover.mjs
```

Success requires both live smoke scripts to clean up and leave PIE stopped.
