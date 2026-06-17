# Live-editor smoke — consolidate + extend (design)

**Date:** 2026-05-25
**Status:** Design approved (re-scoped after prior-art discovery); awaiting spec review → plan
**Related:** existing `server/live-smoke-blueprint-timer-mover.mjs` + `live-smoke-d147-blueprint-pie.mjs` (the prior art this builds on); `test-m1-ping.mjs` (probe→skip pattern); D86 SMOKE-FIX.

## Problem (corrected)

Live-smoke harnesses **already exist** — `live-smoke-blueprint-timer-mover.mjs` (24KB) and
`live-smoke-d147-blueprint-pie.mjs` (9KB). They run opt-in (`UEMCP_LIVE_SMOKE=1`), require an open
editor, drive tools through the real executors (`executeActorsTool`, `executeBlueprintsWriteTool`,
`executeMenhanceTool`, `executeM5EditorUtilityTool`), and create/clean up scratch content. So the
gap is **not** "no live coverage." It is three smaller things:

1. **Ad-hoc per-topic, not standing breadth.** Smokes are written reactively per feature/bug; no
   smoke exercises a representative slice across the tool surface routinely.
2. **Duplicated scaffold.** `unwrap`, `call`, `cleanupWithBackoff`/`runCleanup`, the
   `UEMCP_LIVE_SMOKE` gate, and the `ConnectionManager` setup are copy-pasted across both files —
   the next smoke copies them again.
3. **No unified runner, no skip-clean probe.** Each is run by hand; there's no one-command "run all
   live smokes," and they error (rather than `⊘ skip`) when the editor is down.

## Goal

Consolidate the duplicated scaffold into a shared module, run all live smokes with one command that
skips cleanly without an editor, and add one standing breadth-smoke across the tool surface — all
built on the existing convention.

## Hard constraint (shapes "done")

Live verification needs a running editor → not hosted CI, and the **author can only verify the
skip-path** (imports clean, skips cleanly with no editor / without `UEMCP_LIVE_SMOKE`). The
behavior-preserving refactor of the two existing smokes and the new breadth-smoke's round-trips are
**operator-verified live** after deploy. "Done" for the author = code written + skip-path verified +
handed off for a live run.

## Components

### 1. `server/live-smoke-harness.mjs` (new — extract shared scaffold)
Extract the common subset of the two existing files (behavior-preserving):
- `UEMCP_LIVE_SMOKE=1` gate (refuse otherwise).
- `ConnectionManager` factory (the shared `new ConnectionManager({...})` setup).
- `unwrap(label, response)`, `call(label, fn)`, `cleanupWithBackoff(label, fn)`, `runCleanup(...)`
  + the not-found / name-conflict cleanup-error predicates.
- **New**: `probeEditor()` → returns reachable/unreachable so smokes `⊘ skip` (exit 0) instead of
  erroring when the editor is down (the `test-m1-ping` convention).
- A small reporter (per-check ✓/✗ + summary + exit code).

### 2. Refactor the two existing smokes onto the harness (DRY)
`live-smoke-blueprint-timer-mover.mjs` + `live-smoke-d147-blueprint-pie.mjs` import the shared
helpers instead of defining their own. **Behavior-preserving** — same checks, same cleanup, same
output shape; only the duplicated scaffold moves to the harness. Operator-verified live.

### 3. `server/run-live-smoke.mjs` (new — unified runner)
Discovers `live-smoke-*.mjs`, runs each (gated on `UEMCP_LIVE_SMOKE` + editor reachability via
`probeEditor`), aggregates pass/fail, and **skips clean** (exit 0) when no editor is up — so it's
safe to invoke unconditionally. Mirrors `run-rotation.mjs`'s aggregator shape but for the live set.
NOT added to the offline rotation.

### 4. `server/live-smoke-surface.mjs` (new — standing breadth-smoke)
One representative check per handler family, on the shared harness, using **round-trip +
self-consistency** oracles (drift-immune — no pinned project-content values):
- **actors** (verified tools): `spawn_actor(type=StaticMeshActor, name=UEMCPSmoke_Actor1,
  location=[100,200,300])` → `get_actor_properties(name=UEMCPSmoke_Actor1)` → assert location ==
  [100,200,300] → `delete_actor`.
- **blueprints-write + m-enhance**: `create_blueprint(name=UEMCPSmoke_BP, path=/Game/UEMCPSmoke)` →
  `bp_compile_and_report(asset_path=/Game/UEMCPSmoke/UEMCPSmoke_BP)` → assert compiled / 0 errors →
  `delete_asset_safe`. (Exercises the D86 crash tool live.)
- **liveness**: `get_editor_state` returns a well-formed level/viewport object.
Additional family round-trips (widgets, m5 materials/geometry/input) are easy follow-on additions to
the same registry once this lands.

### 5. `smoke-live.bat` wrapper + deploy-cycle doc
Thin `.bat` (pause-on-exit per repo convention) wrapping `run-live-smoke.mjs`; referenced in
`/deploy-cycle` as the post-relaunch verification step.

## Oracle model (breadth-smoke)
Round-trip (`write X → live-read → assert == X`) + self-consistency. Live-write/live-read pairing:
read back through a **live** tool, never an offline disk-reader (`list_level_actors`/
`inspect_blueprint` read disk and miss unsaved state). No frozen fixture.

## Scratch / safety model
All mutations in a scratch namespace: assets under `/Game/UEMCPSmoke/`, actors prefixed
`UEMCPSmoke_`. Pre-clean at start (idempotent), teardown in `finally` (reuse harness cleanup
helpers), leak report if teardown fails, never save the level, never touch existing content.

## Verification plan
Author (no editor): harness + runner + breadth-smoke + refactored files import cleanly; each skips
cleanly with no editor and without `UEMCP_LIVE_SMOKE`; `run-live-smoke.mjs` with no editor →
`⊘ skip`, exit 0. Operator (live, after deploy): `run-live-smoke.mjs` → existing smokes still pass
(refactor preserved behavior), breadth-smoke round-trips pass, `/Game/UEMCPSmoke/` empty afterward;
crash-recovery via re-run.

## Risks
- **Refactoring working live-smoke code without live verification.** Mitigate: extract the *exact*
  common subset (minimal, behavior-preserving), keep each file's unique logic untouched, and gate
  the merge on an operator live-run before relying on it.
- **Project mutation** (bounded to scratch namespace, level never saved); **teardown leak** (pre-clean
  + finally + leak report); **scratch-folder collision** (reserved `/Game/UEMCPSmoke/`).

## Out of scope
Hosted CI; `run_python_command`/destructive tools unless enabled; exhaustive per-tool coverage;
pinned-value fixtures; adding live smokes to the offline rotation.
