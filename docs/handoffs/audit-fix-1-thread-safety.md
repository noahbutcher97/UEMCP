# AUDIT-FIX-1 Worker — Plugin C++ handler thread-safety marshaling (F-1)

> **Dispatch**: Fresh Claude Code session. Parallel-safe with AUDIT-FIX-2 (server/rc-tools.mjs) + AUDIT-FIX-3 (server/offline-tools.mjs); this worker is plugin C++ only.
> **Type**: Implementation — game-thread marshaling infrastructure in MCPServerRunnable + per-handler dispatch updates.
> **Duration**: 1-2 sessions.
> **D-log anchors**: D79 audit finding F-1 (single highest-severity), D77 (M-enhance ship-complete; inherits MCPServerRunnable threading model from M1 which inherited from UnrealMCP oracle).
> **Deliverable**: all plugin command handlers run their GEditor / UObject / FCompilerResultsLog / PIE / viewport / thumbnail access on the game thread via AsyncTask or FFunctionGraphTask; response still returned on the original socket thread via TPromise or equivalent.

---

## Mission

Audit F-1: 12+ plugin C++ handlers inherit MCPServerRunnable's FRunnable background-thread dispatch model and touch thread-unsafe UE editor APIs (`GEditor->PlayInEditor`, `FKismetEditorUtilities::CompileBlueprint`, `UObject` reflection reads, `UThumbnailManager::RenderThumbnail`, `FEditorViewportClient` access, etc.) WITHOUT marshaling to `ENamedThreads::GameThread`. This is inherited from UnrealMCP oracle precedent (D79 §systemic pattern a), not a design choice — it compiles, runs without crashes in light-load smoke, but risks races / data corruption / crashes under concurrent load OR when M3 writes rebuild on 55558.

Your deliverable: one uniform marshaling pattern applied across all affected handlers, with response flow preserved.

---

## Scope — in

### §1 Read audit §F-1 first
`docs/audits/phase3-post-m-enhance-audit-2026-04-24.md` F-1 should detail which handlers need marshaling. Cross-check against your own survey — audit worker may have missed edge cases or overscoped.

### §2 Pick a marshaling pattern
Two reasonable approaches:

**A — AsyncTask(GameThread) + TPromise**:
```cpp
TPromise<TSharedPtr<FJsonObject>> Promise;
TFuture<TSharedPtr<FJsonObject>> Future = Promise.GetFuture();
AsyncTask(ENamedThreads::GameThread, [&Promise, Params, CommandType]() {
    TSharedPtr<FJsonObject> Response;
    HandlerImpl(Params, Response);  // runs on game thread
    Promise.SetValue(Response);
});
Future.Wait();
return Future.Get();
```
Socket thread blocks until game thread completes. Simple; clean response flow; may hitch if handler is slow.

**B — FFunctionGraphTask + condition variable**:
More explicit cross-thread signaling; harder to get right; slightly faster under load. Not worth the complexity for this scope.

Recommend **A** unless profiling during integration smoke reveals A's hitches are problematic.

### §3 Extract helper
Factor into `MCPCommandRegistry` or a new `MCPThreadMarshal.h`:
```cpp
/** Dispatch a handler onto the game thread and wait for its response. */
TSharedPtr<FJsonObject> RunOnGameThread(
    TFunction<void(const TSharedPtr<FJsonObject>&, TSharedPtr<FJsonObject>&)> Handler,
    const TSharedPtr<FJsonObject>& Params);
```

All callers wrap their existing handler bodies. Migration is then a mechanical change: `Handler(Params, Response)` → `Response = RunOnGameThread(&Handler, Params)`.

### §4 Per-handler migration
Apply helper to every handler the audit's F-1 lists as affected. Check each handler body for:
- `GEditor->*` access
- `UObject` method calls (reflection, property iteration)
- `FKismetEditorUtilities::*` (compile)
- `PlayInEditor` / `EndPlayMap`
- `UThumbnailManager::RenderThumbnail`
- `FEditorViewportClient*` access
- Any `F*CompilerResultsLog` interaction
- Any asset registry scan that may touch cache state

Pure-data handlers (e.g., a handler that just echoes params or reads a constant) don't need marshaling — spot check.

### §5 Regression test
- `test-uemcp-gate.bat` [PASS] preserved (D57 gate path).
- Build clean (no UE 5.6 API drift — see D78 for pre-existing include patterns).
- No test rotation change expected (tests are wire-mock; don't exercise real game thread).
- Manual integration smoke at minimum: fire one handler via MCP (`is_pie_running`, `bp_compile_and_report` on a tiny BP) and confirm response returns within reasonable latency (< 2s for simple ops).

### §6 Measure hitch risk
If any handler runs for > 100ms on game thread, it visibly hitches the editor. Document such handlers' wall-clock in your final report so future optimizers know where to refactor to async patterns. Don't optimize now — just measure and report.

---

## Scope — out

- **Server-side JS** — doesn't run on game thread; not affected.
- **AUDIT-FIX-2 / AUDIT-FIX-3 concerns** — parallel workers own those fixes. Don't touch `server/*`.
- **SidecarWriter atomic-write (F-3)** — different finding, separate follow-on.
- **PIE teardown race** (M-enhance §Biggest-unknowns 4) — related but scope-separate; if your marshaling incidentally resolves it, note in final report.
- **Performance optimization of slow handlers** — measure only; optimize in a follow-on if needed.

---

## Reference files

### Tier 1
1. `docs/audits/phase3-post-m-enhance-audit-2026-04-24.md` — F-1 authoritative scope + affected-handler list.
2. `docs/tracking/risks-and-decisions.md` D79 (audit summary).

### Tier 2 — Code
3. `plugin/UEMCP/Source/UEMCP/Private/MCPServerRunnable.cpp` — current FRunnable::Run loop.
4. `plugin/UEMCP/Source/UEMCP/Public/MCPCommandRegistry.h` + `.cpp` — handler dispatch site.
5. Plugin handler source files (~15 in `plugin/UEMCP/Source/UEMCP/Private/*Handler.cpp`).

### Tier 3 — UE 5.6 threading refs
6. `Engine/Source/Runtime/Core/Public/Async/Async.h` — `AsyncTask`, `ENamedThreads`.
7. `Engine/Source/Runtime/Core/Public/Async/TaskGraphInterfaces.h` — `FFunctionGraphTask` if needed.
8. `Engine/Source/Runtime/Core/Public/Templates/Future.h` — `TPromise`/`TFuture` for cross-thread response return.

---

## Success criteria

1. `RunOnGameThread` helper exported from `MCPCommandRegistry` (or new header).
2. All F-1-listed handlers migrated to game-thread dispatch.
3. Plugin compiles clean (Build.bat succeeds first try post-sync).
4. `test-uemcp-gate.bat` [PASS] preserved.
5. Per-handler wall-clock measurements documented in final report for any handler > 100ms.
6. Path-limited commit per D49: `plugin/UEMCP/Source/UEMCP/*` only.
7. No server/* edits (AUDIT-FIX-2/3 own that territory).

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **D49 path-limited**: `plugin/UEMCP/*` only.
- **Editor must be closed** for plugin rebuilds. `sync-plugin.bat` + `Build.bat` sequence per D61.
- **No AI attribution**.
- **D78 UE 5.6 include gotchas**: watch for 5.5→5.6 drift (e.g., `UUserDefinedStruct` moved to `StructUtils/`; `FObjectThumbnail` in `Misc/`; method rename `GetCompressedImageData` → `AccessCompressedImageData`). Check engine source for canonical paths.
- **Report via standard Final Report template** (under 250 words given scope).

---

## Final report

1. Commit SHA.
2. Handlers migrated (count + list).
3. Any handler whose wall-clock exceeds 100ms on game thread (hitch candidates).
4. Any handler you determined did NOT need marshaling (pure-data handlers).
5. Regression check: gate test + one live-editor handler fire result.
6. Hints for AUDIT-FIX-2/3 workers or future C++ workers that emerged from the marshaling work.
