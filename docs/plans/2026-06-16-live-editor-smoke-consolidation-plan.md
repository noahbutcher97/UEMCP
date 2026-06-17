# Live-Editor Smoke Consolidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate duplicated live-smoke scaffold, add a one-command live-smoke runner, and add a small standing breadth smoke that skips cleanly when the editor is unavailable.

**Architecture:** Add `server/live-smoke-harness.mjs` as the shared gate, tool-init, connection, probe, call, unwrap, and cleanup layer. Refactor existing live smokes to use it without changing their scenario logic, then add `server/run-live-smoke.mjs` to spawn all `live-smoke-*.mjs` scripts and aggregate pass/fail/skip results. Add `server/live-smoke-surface.mjs` as the representative breadth smoke and `smoke-live.bat` as the Windows wrapper.

**Tech Stack:** Node.js ES modules, existing UEMCP server tool modules, PowerShell/CMD `.bat` wrapper, existing `run-rotation.mjs` test style.

**Spec:** `docs/specs/2026-05-25-live-editor-smoke-design.md`

---

## File Map

| Path | Responsibility |
| --- | --- |
| `server/test-live-smoke-harness.mjs` | Non-editor tests for gate, unwrap, call, cleanup classification, and probe behavior. |
| `server/test-run-live-smoke.mjs` | Non-editor tests for live-smoke discovery and child-result classification. |
| `server/live-smoke-harness.mjs` | Shared scaffold for opt-in live smoke scripts. |
| `server/run-live-smoke.mjs` | Discovers and runs `live-smoke-*.mjs` scripts, with clean skip behavior and aggregate status. |
| `server/live-smoke-blueprint-timer-mover.mjs` | Existing timer mover smoke; refactor only the duplicated scaffold. |
| `server/live-smoke-d147-blueprint-pie.mjs` | Existing D147/D149 smoke; refactor only the duplicated scaffold. |
| `server/live-smoke-surface.mjs` | New standing breadth smoke. |
| `smoke-live.bat` | Windows wrapper around `server/run-live-smoke.mjs`. |
| `.claude/commands/deploy-cycle.md` | Adds the live smoke as an optional post-restart verification step. |
| `tools.yaml` | Correct stale total-count comment only. |

## Task 1: Harness Tests

**Files:**
- Create: `server/test-live-smoke-harness.mjs`
- Create later: `server/live-smoke-harness.mjs`

- [ ] **Step 1: Write failing tests**

Create tests that import the desired harness API:

```js
import { TestRunner } from './test-helpers.mjs';
import {
  evaluateLiveSmokeGate,
  unwrapLiveSmokeResponse,
  createLiveSmokeCall,
  isNotFoundCleanupError,
  isNonMutatingNameConflict,
} from './live-smoke-harness.mjs';
```

Assert:
- missing `UEMCP_LIVE_SMOKE` returns `{ shouldRun:false, skipped:true }`;
- `UEMCP_LIVE_SMOKE=1` without `UNREAL_PROJECT_ROOT` returns a usage error;
- normal success envelopes unwrap to `result`;
- local synthetic results from `sample_pie_actor_state` unwrap directly;
- `createLiveSmokeCall` logs `PASS <label>` and returns the unwrapped result;
- cleanup classifiers detect not-found and non-mutating name-conflict text.

- [ ] **Step 2: Verify RED**

Run:

```cmd
cd server
node test-live-smoke-harness.mjs
```

Expected: import failure for missing `server/live-smoke-harness.mjs`.

## Task 2: Runner Tests

**Files:**
- Create: `server/test-run-live-smoke.mjs`
- Create later: `server/run-live-smoke.mjs`

- [ ] **Step 1: Write failing tests**

Create tests that import:

```js
import {
  classifySmokeProcessResult,
  discoverLiveSmokeScripts,
  shouldSkipLiveSmokeSuite,
} from './run-live-smoke.mjs';
```

Assert:
- discovery includes `live-smoke-blueprint-timer-mover.mjs` and `live-smoke-d147-blueprint-pie.mjs`;
- discovery excludes `live-smoke-harness.mjs`;
- exit 0 with `⊘ skipped` is classified as `SKIPPED`;
- exit 0 without skip marker is classified as `PASS`;
- nonzero exit is classified as `FAIL`;
- missing `UEMCP_LIVE_SMOKE` causes suite-level skip rather than child process failures.

- [ ] **Step 2: Verify RED**

Run:

```cmd
cd server
node test-run-live-smoke.mjs
```

Expected: import failure for missing `server/run-live-smoke.mjs`.

## Task 3: Implement Harness

**Files:**
- Create: `server/live-smoke-harness.mjs`

- [ ] **Step 1: Implement minimal exports for Task 1 tests**

Implement:
- `evaluateLiveSmokeGate(env)`;
- `loadLiveSmokeTools()`;
- `createLiveSmokeConnectionManager(projectRoot, env)`;
- `probeEditor(cm)`;
- `prepareLiveSmoke({ name })`;
- `unwrapLiveSmokeResponse(label, response)`;
- `createLiveSmokeCall({ summarize })`;
- `cleanupWithBackoff(label, fn, options)`;
- `runCleanup(label, fn, errors, options)`;
- cleanup classifiers.

- [ ] **Step 2: Verify GREEN**

Run:

```cmd
cd server
node test-live-smoke-harness.mjs
```

Expected: `Failed: 0`.

## Task 4: Implement Runner

**Files:**
- Create: `server/run-live-smoke.mjs`

- [ ] **Step 1: Implement minimal exports for Task 2 tests**

Implement:
- `discoverLiveSmokeScripts({ dir })`;
- `shouldSkipLiveSmokeSuite(env)`;
- `classifySmokeProcessResult(result)`;
- `runLiveSmokeSuite({ dir, env })`;
- CLI `main()`.

The runner must skip cleanly with exit 0 when `UEMCP_LIVE_SMOKE` is not `1`, and fail only when a child smoke actually fails.

- [ ] **Step 2: Verify GREEN**

Run:

```cmd
cd server
node test-run-live-smoke.mjs
```

Expected: `Failed: 0`.

## Task 5: Refactor Existing Smokes

**Files:**
- Modify: `server/live-smoke-blueprint-timer-mover.mjs`
- Modify: `server/live-smoke-d147-blueprint-pie.mjs`

- [ ] **Step 1: Replace duplicated scaffold**

Replace each script's env gate, `tools.yaml` loading, tool initialization, `ConnectionManager` construction, `call`, `unwrap`, cleanup backoff, and cleanup classifiers with imports from `live-smoke-harness.mjs`.

- [ ] **Step 2: Preserve scenario code**

Do not change the authored Blueprint graph, PIE sampling assertions, or cleanup order except where the shared cleanup helper is called.

- [ ] **Step 3: Verify skip path**

Run without live env:

```cmd
cd server
node live-smoke-d147-blueprint-pie.mjs
node live-smoke-blueprint-timer-mover.mjs
```

Expected: both print `⊘ skipped` and exit 0.

## Task 6: Add Breadth Smoke and Wrapper

**Files:**
- Create: `server/live-smoke-surface.mjs`
- Create: `smoke-live.bat`

- [ ] **Step 1: Add breadth smoke**

Use the harness to:
- spawn `StaticMeshActor` named `UEMCPSmoke_Actor_<stamp>`;
- read it back with `get_actor_properties` and assert location `[100,200,300]`;
- delete the actor;
- create `/Game/UEMCPSmoke/UEMCPSmoke_BP_<stamp>`;
- compile it with `bp_compile_and_report`;
- assert zero compile errors;
- delete it with `delete_asset_safe`;
- call `get_editor_state` and assert it returns an object.

- [ ] **Step 2: Add wrapper**

Create `smoke-live.bat` as a thin pause-on-exit wrapper:

```bat
@echo off
setlocal
pushd "%~dp0server"
node run-live-smoke.mjs %*
set EXITCODE=%ERRORLEVEL%
popd
echo.
echo smoke-live finished with exit code %EXITCODE%.
pause
exit /b %EXITCODE%
```

- [ ] **Step 3: Verify runner skip path**

Run:

```cmd
cd server
node run-live-smoke.mjs
```

Expected: suite-level `⊘ skipped`, exit 0.

## Task 7: Docs and Count Cleanup

**Files:**
- Modify: `.claude/commands/deploy-cycle.md`
- Modify: `tools.yaml`

- [ ] **Step 1: Update deploy-cycle**

Add Step 6 after MCP restart:

```cmd
smoke-live.bat
```

Explain that it is optional but recommended after plugin/server changes, and that it skips cleanly without `UEMCP_LIVE_SMOKE=1`.

- [ ] **Step 2: Correct stale `tools.yaml` count comment**

Update the comment to 16 toolsets, 138 toolset tools, 144 total.

## Task 8: Final Verification

**Files:**
- All touched files.

- [ ] **Step 1: Focused tests**

Run:

```cmd
cd server
node test-live-smoke-harness.mjs
node test-run-live-smoke.mjs
node run-live-smoke.mjs
```

Expected: both tests pass; runner skips with exit 0 when live env is absent.

- [ ] **Step 2: Full rotation**

Run:

```cmd
cd server
npm test
```

Expected: aggregate `0 failed`.

- [ ] **Step 3: Final report**

Report that live behavior remains operator-pending unless the editor was actually running with `UEMCP_LIVE_SMOKE=1`.
