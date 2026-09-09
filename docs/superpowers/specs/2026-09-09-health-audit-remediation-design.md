# Health-audit remediation design

**Date:** 2026-09-09
**Source:** the 2026-09-09 repository health audit (`docs/audits/uemcp-health-audit-2026-09-09.md`, gitignored) measured at HEAD `5028954`.
**Status:** approved design; implementation plan follows via the writing-plans skill.

## 1. Purpose

The audit found a green, well-tested Node server next to a plugin whose handler C++ has no automated check between commit and deploy, plus three maintainability hot spots (a 3,684-line `offline-tools.mjs`, an uncommented 17.5K-line `server/deployment/` subsystem, and a 632-line request reader) and a stale CLAUDE.md file layout. This document turns the audit's eight recommendations into five workstreams with fixed scope, verification, and dispatch shape.

Recommendation 6 (bundle policy) is resolved without a workstream: `docs/specs/deployment-machine-interface.md` names `dist/deploy-uemcp.mjs` as the tracked standalone entry for external consumers, so the committed bundle stays. The only action is documenting the regeneration rule (workstream 1). Recommendation 8 (monitoring) needs no plan.

## 2. Facts the design rests on

- No script, doc, or CI step runs the plugin's 16 native automation tests. They are flagged `EditorContext | EngineFilter` behind `WITH_DEV_AUTOMATION_TESTS`, which is the shape a headless `UnrealEditor-Cmd` automation run handles.
- `server/verify-deploy.mjs` already computes a `NEEDS-BUILD` verdict from DLL age versus source age per target profile.
- `offline-tools.mjs` has no internal section structure. Its `executeOfflineTool` switch has 25 cases in three families: eight `bp_*` verbs, a project/config group, and an asset-registry group. It exports twelve names that eleven rotation suites import.
- `createClientTransaction` in `server/deployment/client-transaction.mjs` is roughly thirty closures over one state object in four clusters: leases and pinning, staged writes, snapshot and restore, apply and rollback. Three suites cover it.
- `BlueprintHandlers.cpp` (3,704 lines, 543 decision points, 58 functions) was last touched three days before the audit by the UE 5.8 compatibility stream; whether that stream is closed is unknown.
- `AnimationHandlers.cpp` has had no commits since mid-July. It is a coverage gap, not active work.
- A team target project pins UEMCP at public commit `6195715` and re-applies the compile fix in local commit `5028954` as a patch because that commit is not yet pushed. Its setup helper installs plugin source and generates client configuration; it does not run the deployment CLI or consume the `dist/` bundle.

## 3. Prerequisite: publish the audit HEAD

`main` is one commit ahead of `origin/main`. Pushing it makes `5028954` public so the team pin can move forward and their patch step can be removed. This is the user's action; every handoff below states that the audit HEAD is public before dispatch.

## 4. Workstreams

### WS1. CLAUDE.md file-layout refresh

- **Shape:** in-session, bounded, one commit.
- **Scope:** in the File Layout and Testing sections of `CLAUDE.md`: add `server/deployment/` with its adapter group (Claude, Codex, Gemini, VS Code), `server/create-uemcp-server.mjs` as the real entry, `server/tcp-transport.mjs`, `server/menhance-tcp-tools.mjs`, the `server/live-smoke-*.mjs` scripts and `run-live-smoke.mjs`, `dist/deploy-uemcp.mjs` with its regeneration rule (`npm run build:deployment`, guarded by `test-deployment-bundle.mjs`), and `plugin/.../MCPServerTransportPolicy.cpp` with its native test file. Correct the `server.mjs` line (a 19-line stdio shim). Update the assertion count to 7,532. Add a one-line native-tests note that points at the WS2 runner once it exists and says "not yet scripted" until then.
- **Non-goals:** no restructuring of other CLAUDE.md sections; no D-log entry.
- **Verification:** full rotation green, including `test-slash-command-anchors.mjs` and any other suite that reads CLAUDE.md.

### WS2. Native test runner and compile gate

- **Shape:** heavyweight handoff (`docs/handoffs/native-test-runner-and-compile-gate.md`), one worker session, dispatched when a target profile with a built editor exists.
- **Empirical claim to validate first:** the plugin's editor-context automation tests execute and report under `-nullrhi` for this plugin. If they do not, record the working flag set (for example without `-nullrhi`) and proceed with it. The runner ships against whichever flag set works.
- **Deliverable A, runner:** `run-native-tests.bat` (following the repo's pause-on-exit `.bat` convention) over `server/run-native-tests.mjs`. The helper resolves a target profile the way `verify-deploy.mjs` does, invokes `UnrealEditor-Cmd.exe <uproject> -ExecCmds="Automation RunTests UEMCP;Quit" -unattended -nullrhi -nosplash -NoSound -log -ReportExportPath=<dir>`, applies a timeout, parses the exported JSON report, prints one line per test with pass/fail, and exits non-zero on any failure, on a timeout, or on zero tests found. A pure report-parser module gets a rotation suite (`test-native-runner.mjs`) with fixture reports; the process-spawning part is live-gated like `test-m1-ping.mjs`.
- **Deliverable B, baseline:** the worker's report states whether the existing 16 tests pass and attaches the per-test lines.
- **Deliverable C, gate:** a step in `.githooks/pre-push` that, when the outgoing range touches `plugin/UEMCP/Source/`, runs `node server/verify-deploy.mjs --quiet` and blocks on any `NEEDS-BUILD` or `NEEDS-SYNC` verdict. When no `.uemcp-targets.json` or legacy targets file exists it prints a one-line skip and allows the push. `--no-verify` remains the bypass and is documented next to the existing NDA-gate bypass.
- **Non-goals:** no CI change (hosted runners cannot build Unreal); no test-writing beyond the parser suite.
- **Verification:** runner exits 0 on the baseline (or the report explains which tests fail); rotation grows by the parser suite; a dry run of the hook on a synthetic plugin change shows the block and the skip paths.

### WS3. `offline-tools.mjs` split

- **Shape:** in-session, subagent-driven, one extraction per task with review between tasks.
- **Target structure:**
  - `server/offline-project-tools.mjs`: `project_info`, config listing and drill-down, build config, plugins, data sources, gameplay-tag search and hierarchy.
  - `server/offline-asset-tools.mjs`: asset-registry query, asset info, export and property reads, level-actor listing, the asset cache and rescan logic, `resolveAssetDiskPath`, `parseAssetHeader`, and the subobject helpers.
  - `server/offline-blueprint-tools.mjs`: the eight `bp_*` verbs, edge-topology extraction, comment containment, `withAssetExistenceCheck`.
  - `server/offline-tools.mjs` remains the façade: it keeps `executeOfflineTool` and its switch, and re-exports all twelve current exports from the new modules, so no suite changes.
- **Rules:** pure moves with no behavior change; every moved function keeps its name and signature; the one-line sort-before-paginate backlog item is applied in the asset module and covered by an assertion; the parameter-read lint from the backlog is not in scope.
- **Verification:** rotation exactly 7,532 passing plus the sort-fix assertion, no import errors, lint clean, `test-tool-registry-truth.mjs` unchanged.

### WS4. `server/deployment/` intent pass and transaction decomposition

- **Shape:** in-session, subagent-driven; the comment pass and the decomposition are separate tasks.
- **Comment pass:** every module under `server/deployment/` gets a head comment (what it does, why it exists, what it depends on; three to six lines) and every closure factory (`create*`) gets a boundary comment stating the state it closes over and the invariants it maintains. Comment intent, not implementation, per Code Standards.
- **Decomposition:** split `createClientTransaction` into `server/deployment/transaction-pins.mjs` (leases, pinned directories and records, parent revalidation), `server/deployment/transaction-stage.mjs` (staged writes, stage inspection and cleanup), and `server/deployment/transaction-snapshot.mjs` (snapshot, restore, deferred deletes, created-directory cleanup). `client-transaction.mjs` keeps `apply` and `rollback` and composes the three over an explicit `state` object passed in, replacing closure capture. Public exports of `client-transaction.mjs` are unchanged.
- **Rules:** behavior-preserving; no change to the machine-interface contract; the bundle is regenerated with `npm run build:deployment` in the same commit as the source change.
- **Verification:** `test-client-transaction.mjs`, `test-deployment-contracts.mjs`, `test-installed-client-contracts.mjs`, and `test-deployment-bundle.mjs` pass unchanged; rotation green; lint clean.

### WS5. Handler tests and `ReadOneRequest`

Two heavyweight handoffs, drafted after WS2 reports and gated on the runner.

- **WS5a, `BlueprintHandlers.cpp` (`docs/handoffs/blueprint-handler-tests.md`):**
  - Pre-start check: `git status` and `git log` on the file for uncommitted or in-flight UE 5.8 work; if found, stop and report rather than build on it.
  - Extract pure logic into `plugin/UEMCP/Source/UEMCP/Public/BlueprintHandlerHelpers.h` (pin-type to JSON mapping, parameter validation shared by the handlers, the variable-default resolution behind `SetSupportedVariableDefault`) with native unit tests in `Private/Tests/UEMCPBlueprintHelperTests.cpp`. Shared helpers live in `Public/` per the anonymous-namespace rule (W-K guard applies).
  - Add three handler-level tests on a transient Blueprint created in a test package, invoking `HandleAddBlueprintVariableAssignment`, `HandleAddBlueprintTimer`, and `HandleDisconnectBlueprintPin` with JSON params and asserting the response envelope and resulting graph state.
  - Verification: `run-native-tests.bat` green; `Build.bat` clean; rotation unchanged; the anon-namespace audit passes.
- **WS5b, `MCPServerTransportPolicy.cpp` (`docs/handoffs/read-one-request-refactor.md`):**
  - Split `ReadOneRequest` into static functions for header read, body read, boundary validation, and result mapping in the same translation unit; no change to the public policy interface or to `tcp-transport-cases.json`.
  - Verification: the seven existing native transport tests and the shared fixture pass unchanged; `run-native-tests.bat` green; `_bench-transport-spike.mjs` shows no regression against a pre-change run.
- **Team-project constraint:** both handoffs add plugin files, so the team target project's pin and version record must be bumped after merge. The handoffs say so in placeholder vocabulary.

## 5. Sequencing

1. User pushes `main` (section 3).
2. WS1 in-session.
3. WS3 and WS4 in-session; their files are disjoint, so they may interleave.
4. WS2 handoff drafted immediately after WS1; dispatched when a built target exists.
5. WS5a and WS5b handoffs drafted after the WS2 report; dispatched in either order.

## 6. Constraints that apply to every workstream

- **Codename hygiene:** the team target project and the private UE projects are never named in committed files. Handoffs use `path/to/YourProject` and "the team target project".
- **No AI attribution** in commits.
- **Single-commit preference** per worker session; the bundle regeneration for WS4 lands in the same commit as its source change.
- **Fail-loud verification:** every workstream's proof is a rotation count or a runner exit code, never a narrative claim.
- **Worker reports** go to `docs/reports/`; the orchestrator reconciles against repo state before drafting the next handoff.

## 7. Out of scope

- Rewriting the other deployment closure factories (`createLocalState`, the four adapters).
- Native tests for handler files other than `BlueprintHandlers.cpp`.
- Any CI change requiring an Unreal build on hosted runners.
- Changing the bundle policy.
