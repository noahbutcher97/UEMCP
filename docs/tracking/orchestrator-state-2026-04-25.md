# Orchestrator State — 2026-04-25

> **Living doc**: succeeds previous orchestrator-state snapshots. Superseded when next orchestrator-state snapshot lands. **Read this first if you're a new orchestrator session inheriting Phase 3.**
>
> **Quick reading path** (15 min total):
> 1. This doc (5 min) — current state, dispatch queue, conventions
> 2. `CLAUDE.md` — project-state snapshot + design rules
> 3. `docs/tracking/risks-and-decisions.md` D77-D88 entries (last 11 entries; ~10 min)
> 4. `docs/tracking/backlog.md` — in-flight + queued items

---

## TL;DR

Phase 3 is **~85% complete**. Wave 1 + 2 + 3 shipped (M1, M-spatial, Oracle-A/v2, S-B-base, Verb-surface, M-enhance HYBRID transport with Phase 4 absorbed). Validation cycle (audit + T-1b + smoke + audit-fixes 1/2/3 + SMOKE-FIX + deployment) is complete. **Three audit-fixes deployed live + verified** in editor 2026-04-25 (Bugs 1 + 3 closed end-to-end). One follow-up bug remains: **Bug 4 thumbnail-empty post-render** (corrected root cause identified in D88: missing explicit `CompressImageData()` call, not async — 1-line fix queued in CLEANUP-MICRO).

**Test baseline**: **1381 passing / 0 failing** across 12 test files.

**Wave 4 (M3 + M4 + M5)** is dispatchable. M5 gated on CLEANUP-MICRO landing first.

---

## Active state (as of 2026-04-25)

### In flight (5 parallel workers — maximum-parallel dispatch shape)

All 5 dispatched 2026-04-28 via conversation openers per the §Multi-agent orchestration handoff convention:

- **Post-M5 deployment smoke** — `docs/handoffs/post-m5-deployment-smoke.md`. Bundled scope: 19 M5 tools + 6 CLEANUP-M3-FIXES patches + M3-bpw hotfix + D110 SETUP-BAT-PLUGIN-DEPS + D111 compile fixes + **D112 5-case smoke (§1.0)** + streamlined gauntlet at smoke-tail. **Pre-flight gated on Noah's deploy cycle being complete** (sync + Build + relaunch + Claude restart). FINAL gate for Phase 3 primary dispatch surface — clears TCP:55557 retirement gate.
- **WIDGETS-PERF investigation** — `docs/handoffs/widgets-perf-investigation.md`. Profile-then-fix worker for D99 #5 (M3-widgets 2-4s mutation hitches). Touches `WidgetHandlers.cpp` instrumentation possibly + `test-m3-widgets.mjs` perf-regression test.
- **FA-ε write-side audit** — `docs/handoffs/fa-epsilon-write-side-audit.md`. Investigation worker for D99 #6 (TCP write / RC read inconsistency) + D100 enrichment (BP CDO PIE-unload). Audit deliverable to `docs/audits/`; possible structural fix or documented limitation. May touch `BlueprintHandlers.cpp` / `rc-tools.mjs` / `tools.yaml`.
- **ROTATION-RUNNER-FAIL-LOUD** — `docs/handoffs/rotation-runner-fail-loud.md`. Closes D104 silent-zero meta-finding. Adds `server/run-rotation.mjs` (or extends `test-helpers.mjs`); touches `package.json` + CLAUDE.md §Testing.
- **CLAUDE.md/README/yaml grooming** — `docs/handoffs/claude-md-readme-yaml-grooming.md`. Closes D94→D112 accumulated drift items. Touches CLAUDE.md + tools.yaml + README + testing-strategy.md.

**Coordination risks across the 5**:
- **CLAUDE.md collision**: ROTATION-RUNNER-FAIL-LOUD updates §Testing with new run command; grooming refreshes test-assertion count. Handoff §2 of grooming explicitly tells worker to "use ROTATION-RUNNER's number if it landed first" — sequential awareness exists. Worst case: small merge conflict to resolve at fold time.
- **tools.yaml collision**: FA-ε audit may update tools.yaml descriptions; grooming may too. FA-ε's scope is structural-fix-or-documentation per finding, so likely-low yaml touches; grooming handoff §4 already says "coordinate with in-flight workers" — should be fine.
- **Plugin C++ collision**: only WIDGETS-PERF + FA-ε audit may touch plugin C++. WIDGETS-PERF touches `WidgetHandlers.cpp`; FA-ε may touch `BlueprintHandlers.cpp` (TCP write side) — file-disjoint.

**Maximum parallel capacity used**: 5 workers; ceiling per orchestration retrospective is 3-4 with clean parallelism. Exceeding by 1-2 is feasible because: (a) the BLUEPRINT-ASSET-PATH-RESOLUTION-FIX worker shipped + freed M3-handler-file capacity; (b) 3 of the 5 are JS / docs (no plugin C++ shared-file pressure); (c) Post-M5 smoke is read-only on plugin source.

Recently shipped (since prior in-flight snapshot): SETUP-BAT-PLUGIN-DEPS per D110; M5 deployment compile-fix wave per D111; .githooks warn-on-missing per D110 §6; BLUEPRINT-ASSET-PATH-RESOLUTION-FIX per D112.

### Test baseline

**1381 passing / 0 failing** across 12 test files. No drift, no skips. Ground-truth verified empirically in user's deployment cycle.

### Live deployment status

User completed full deployment cycle (sync-plugin.bat + Build.bat + editor relaunch + Claude Code restart) post-D87 + D88. Verified live:
- D83 thread marshaling (AUDIT-FIX-1) — `is_pie_running` clean response, `bp_compile_and_report` returns `compiled cleanly` envelope, no crashes
- D85 NodeGuid input bridge (AUDIT-FIX-3) — `bp_list_entry_points → bp_trace_exec` composition works
- D87 SMOKE-FIX (path-suffix + RC endpoint) — `get_blueprint_variables` returns 27 vars with full flag surface

Outstanding: **Bug 4 thumbnail empty** — crash closed (marshaling deployed), but `get_asset_preview_render` still returns empty PNG. Root cause confirmed via in-session investigation: missing `Thumbnail.CompressImageData()` call between `RenderThumbnail()` and `AccessCompressedImageData()`. CLEANUP-MICRO worker fix is one line.

---

## Dispatch-ready queue

Four worker handoffs drafted (session-local; gitignored per D81). Recommended dispatch order + parallel-safety:

| # | Handoff | Path (session-local) | Scope | Sessions | Parallel-safe with |
|---|---|---|---|---|---|
| 1 | **CLEANUP-MICRO** | `docs/handoffs/cleanup-micro-worker.md` | `VisualCaptureHandler.cpp` + `MCPThreadMarshal.{h,cpp}` + `rc-tools.mjs` + `test-rc-wire.mjs` | 1-1.5 hr | All |
| 2 | **D81-SANITIZATION-AUDIT** | `docs/handoffs/d81-sanitization-regression-audit.md` | `docs/audits/*` only (read-only) | 0.5-1 | All |
| 3 | **D81-SANITIZATION-FIXES** | `docs/handoffs/d81-sanitization-fixes-worker.md` | Per-finding from #2's output | 0.5-1.5 | All except #2 (gated) |
| 4 | **M3** | not yet drafted | plugin C++ writes + `tcp-tools.mjs` writes-side | 6-10 sessions, 3 sub-workers | M4 |
| 5 | **M4** | not yet drafted | reduced reads (12 tools); server JS + maybe plugin C++ reads | 3-5 sessions | M3 |
| 6 | **M5** | not yet drafted | animation + materials + visual-capture + etc.; 3-4 sub-workers | 6-10 sessions | **GATED on CLEANUP-MICRO** (visual-capture toolset) |

**Recommended next dispatch**: CLEANUP-MICRO + D81-SANITIZATION-AUDIT + (eventually) M3 + M4 in parallel. M5 follows once CLEANUP-MICRO lands.

**M3/M4/M5 handoffs not yet drafted** — orchestrator drafts when user says go. Reference: D58 §Q5 + D66 + D77 for scope. Each is 3-4 sub-workers per their worker breakdown.

---

## Pending user actions (orthogonal to dispatch)

1. **Bug 4 follow-up smoke** — CLEANUP-MICRO commit `c95c2bb` shipped the 1-line `Thumbnail.CompressImageData()` fix per D88 corrected root cause; once Noah sync-plugin.bat + Build.bat + relaunches editor + restarts Claude Code, live-fire `get_asset_preview_render` against StaticMesh + Blueprint to confirm PNG bytes return. M5 visual-capture toolset gate clears empirically here. CLEANUP-MICRO §2 use-after-free fix also requires this same deployment cycle to verify no-crash on timeout path.
2. **FA-ε §Open 3 + M-enhance §Biggest-unknowns 4** still unverified (cross-transport transaction semantics + PIE teardown race). Naturally exercised during the Bug 4 follow-up smoke pass — bundle for free.
3. ~~**D81-SANITIZATION-FIXES dispatch decision**~~ — RESOLVED via D92 ship. Audit Open Items §2-§5 (CLAUDE.md/README drift held out-of-scope per dispatch) now queued as a small grooming pass — orchestrator default = bundle into next CLAUDE.md-touching commit, but standalone is fine if no near-term commit is touching it.
4. **S-B-overrides scope decision** — D91 surfaced that Project B is on UE 5.7 AND in active use AND the offline parser breaks at header walk on every 5.7 BP. Was previously "lower priority until secondary target materializes." Materialized. Whether to bump ahead of Wave 4 (M3/M4/M5), run S-B-overrides parallel, or accept Project-B-via-sidecar-only-for-now is an open call.
5. **D87 deployment-cycle pattern**: any audit-fix landing C++ code requires editor close + sync-plugin.bat + Build.bat + relaunch + MCP-server restart. Don't trust "code committed" as "live."

---

## Recent D-log highlights (D77 → D112)

Read full entries at `docs/tracking/risks-and-decisions.md`. Skimmable summaries:

- **D77** M-enhance ship-complete (4 sessions, 36 tools, Phase 4 absorbed). Aggregate Phase 3 estimate dropped to ~26.5-43 sessions.
- **D78** Integration-smoke compile fixes (3 UE 5.6 API drifts: `UUserDefinedStruct` moved Engine→CoreUObject/StructUtils; `FObjectThumbnail` in Misc/ not UObject/; `AccessCompressedImageData` not `GetCompressedImageData`).
- **D79** Phase 3 post-M-enhance audit landed (29 findings: 7 high / 11 medium / 11 low).
- **D80** T-1b fixture-philosophy migration (~80% drift-surface reduction; 4 test files migrated).
- **D81** Public-repo sanitization (history rewrite; codenames replaced with placeholder vocabulary).
- **D82** NDA-codename push gate (single pre-push hook; minimal slim-down).
- **D83** AUDIT-FIX-1 thread marshaling (18 plugin handlers via `MCPThreadMarshal::RunOnGameThread<T>`).
- **D84** AUDIT-FIX-2 RC delegate expansion + toCdoPath fix.
- **D85** AUDIT-FIX-3 NodeGuid input bridge (3 verbs normalized; F-21 fallback drop).
- **D86** Smoke surfaced 5 plugin bugs (initial framing as "recurrences" of D83/D85; SUPERSEDED by D87).
- **D87** SMOKE-FIX shipped + **CRITICAL FINDING**: 3 of 5 "recurrences" were DEPLOYMENT GAPS not code defects. AUDIT-FIX-1/3 were always correct; just never sync-plugin.bat'd to live editor + MCP server process. New rule: "code committed + tests green ≠ fix is live."
- **D88** Deployment cycle complete + Bug 4 corrected root cause. `Thumbnail.CompressImageData()` is the missing 1-line fix. **D87 deployment-gap framing empirically validated**: 3 audit-fixes verified live post-deployment.
- **D89** D81-SANITIZATION-AUDIT shipped (10 findings: 1 high · 4 medium · 5 low; gitignored deliverable; meta-finding about handoff template's SHA-requirement for post-D81 audits).
- **D90** CLEANUP-MICRO shipped (commit `c95c2bb`, 5 files, 3 fixes). §2 use-after-free actually lived at the `Dispatch` call site, not the helper named in handoff — legitimate D72 scope deviation. Audit-batch-2 hint: orphan AsyncTasks invisible to wallclock instrumentation post-timeout.
- **D91** Project B on UE 5.7 + offline parser breaks at header walk on every 5.7 .uasset attempted. Sidecar artifacts reliable cross-version (engine-generated); binary parser is broken. S-B-overrides scope amended to include header-layer delta, not just K2Node-layer drift.
- **D92** D81-SANITIZATION-FIXES shipped (commit `5c48718`, 7 files, all 10 audit findings closed). All 3 repo-root .bat scripts now §.bat-convention compliant. Test rotation 1372/0 (4-assertion fixture-noise delta vs CLEANUP-MICRO baseline; no regression). D81 sanitization saga officially closed. Audit Open Items §2-§5 (CLAUDE.md/README drift) queued as a small grooming pass.
- **D93** M3-actors shipped (commits `916a688` + `c161aec`, 10 actors tools live on TCP:55558). Pattern decisions captured for M3-blueprints-write + M3-widgets siblings: flat-file layout (single `<Toolset>Handlers.cpp` pair, NOT subdir); no per-handler MCPThreadMarshal (central marshal at Dispatch covers all); wire-type strings identical to oracle; per-toolset test files. Test rotation 1376 → 1401. UE 5.6 deprecation flag: `FImageUtils::CompressImageArray` (still works in 5.6 but deprecated-since-5.0).
- **D94** DOCS-GROOMING shipped (commit `1a65d0f`, 6/6 audit Open Items + .githooks/pre-commit hook). **CRITICAL safety finding**: pre-existing UTF-8 locale bug in .githooks/pre-push silently missed multi-byte char lines for years. Orchestrator inline-fixed in this D-log commit (added `export LC_ALL=C.UTF-8` to pre-push). Pattern lesson: locale assumptions in shell scripts are silent failures.
- **D95** M4 scope-empty redirect — all 12 M4-scoped reads-side tools were already shipped under M-enhance (D77). Worker correctly stopped before any implementation; provided 12-row evidence table. Orchestrator drafting error: M4 handoff drafted by analogy to M3 without verifying tools.yaml `layer:` empirically. Saved to memory at `feedback_orchestrator_handoff_starting_state_check.md`. Wave 4 remaining drops to M3-blueprints-write + M3-widgets + M5 (~10-15 sessions, down from ~13-20).
- **D96** M3-widgets shipped (commit `315efb2`, 7 tools live on TCP:55558, both KNOWN-ISSUE handlers fixed during rebuild). Bug-1 fix: pure function graph + `FDelegateEditorBinding` registration. Bug-2 fix: PIE-gated CreateWidget+AddToViewport. UMG institutional-memory additions captured. Test 1401 → 1435. **CRITICAL parallel-worker shared-file collision finding** codified in `feedback_parallel_subworker_shared_config_collision.md` — handler-file disjointness alone insufficient; M3-widgets+M3-bpw needed 3 stash cycles to land cleanly. M3 umbrella overview amended post-hoc.
- **D97** M3-blueprints-write shipped (commit `0c7448c`, 15 BP-write tools live; NOT 21 — 6 BP-node "orphans" already absorbed in oracle's 15-tool toolset). Landed atop M3-widgets via shared-file re-application. UE 5.6 API findings: `PC_Float` deprecated → `PC_Real` with subcategory; `FindOrCreateEventGraph` reimplemented via `FBlueprintEditorUtils::FindEventGraph`. Test rotation post-both-ships: 1563 / 0. 2 stale stashes safe to drop.
- **D98** M3 milestone complete — all 32 transitional tools live on TCP:55558. tools.yaml grep confirms ZERO toolsets remain on `tcp-55557`. D23 oracle retirement now empirically actionable. Phase 3 ~95% complete; M5 is the only remaining Wave 4 milestone. TCP:55557 formal retirement queued for ~1 deploy-cycle post-smoke.
- **D99** Post-M3 deployment smoke complete — Bug 4 CLOSED LIVE (M5 gate clears); M3 hotfix verified live; M3-bpw §7 full pass 7/7. **8 new findings surfaced** that wire-mock + tests couldn't catch: M3-actors handler gaps (Mobility traversal + screenshot silent-fail); M3-widgets gaps (PIE lookup + bind chain + 2-4s perf hitches); FA-ε write-side cross-transport inconsistency; RC CDO-path tip wrong; Bug 4 mime label JPEG-not-PNG. **TCP:55557 retirement gate PARTIAL** — needs CLEANUP-M3-FIXES + re-smoke before formal deprecation. M-enhance §Biggest-unknowns 4 (PIE teardown race) closed (NO-RACE-OBSERVED). Three new follow-on workers queued (CLEANUP-M3-FIXES + WIDGETS-PERF + FA-ε WRITE-SIDE AUDIT).
- **D100** Streamlined gauntlet shipped (combined session with post-M3 smoke). 30-call gauntlet at smoke-tail; sharpened 3 D99 findings + surfaced 3 new ones. **Key sharpenings**: ALL 3 widgets-toolset asset-lookup tools fail under PIE (not just 1); subobject traversal pattern is universal (not just Mobility — also Visibility + Intensity on different subobjects); BP CDOs unload from memory after PIE cycles. New full-gauntlet handoff at `docs/handoffs/post-milestone-gauntlet.md` (~250 calls, for major milestone boundaries). Streamlined-gauntlet pattern (~30 calls, ~30 min) recommended as routine smoke-tail "dessert course" — codify into next post-deployment-smoke handoff.
- **D101** M5 scope-verifier shipped. Verdict: PARTIALLY-REMAINING. Empirical scope = 19 tools across 5 toolsets (not 31). M-enhance D77 absorbed 12/31 tools as reads-side coverage. **3 sub-workers, ~4-5.5 sessions** (down from 6-10): M5-animation+materials (7 tools) + M5-input+geometry (6 tools) + M5-editor-utility (6 tools, security-sensitive). File-collision-safety: shard-upfront via M5-PREP scaffolding worker before sub-workers dispatch. **5 open decisions resolved**: defer M-enhance reads audit to audit-batch-2; ship `set_material_parameter` as RC delegate; verify Geometry Script plugin enabled (Noah action); `run_python_command` gets deny-list + startup flag + per-call logging; verify `get_audio_asset_info` offline-displaced (drop from M5 if confirmed).
- **D102** CLEANUP-M3-FIXES shipped (commit `78032c4`, 5 fixes + 1 doc, +421/-66). Worker PROACTIVELY covered D100 gauntlet's broader patterns (subobject-traversal-universal in §1; all-3-widgets-PIE-lookup in §3) — CLEANUP-M3-FIXES-2 NOT NEEDED. Bonus: closed D93's FImageUtils 5.7-deprecation note via §2 migration. **NEW DRIFT FINDING**: `server/test-tcp-tools.mjs` has been broken at HEAD since D97 (M3-bpw deleted barrel `tcp-tools.mjs` but test imports never re-pointed). CLAUDE.md "1563/0" rotation count is stale by however many assertions test-tcp-tools contributed (likely 100+). Tiny TEST-IMPORTS-FIX worker queued (~0.25-0.5 session). **Pattern lesson** for future M5 sub-workers: when deleting from a barrel file, grep for imports of the barrel + re-point or flag for orchestrator. **6 UE 5.6 institutional-memory additions** captured (FImageUtils::CompressImage signature, FKismetEditorUtilities silent-nullptr, UK2Node_ComponentBoundEvent canonical fields, LoadObject vs LoadAsset under PIE, FObjectThumbnail JPEG-not-PNG naming, AActor::GetComponents SCS recursion).
- **D103** M5-PREP shipped (commit `a5b565f`). All 19 stubs match D101 verifier audit exactly. Empty-loop scaffold via `m5ToolsetGroups[]` array + `NotImplemented(TEXT(...))` lambda factory = sub-workers ship with ZERO file-collision (D96's expensive lesson empirically vindicated). 3 worker findings: get_audio_asset_info SUPERSEDED-vs-implement decision deferred to M5-animation+materials sub-worker; .git/info/forbidden-tokens absent in worker's checkout (gate degraded — main checkout file present + correct; fresh-clone risk noted, mitigation queued); shell-history codename leak (lower priority). M5 sub-workers dispatchable now in clean parallel.
- **D104** TEST-IMPORTS-FIX shipped (commit `5028c47`). D102 drift closed: 197 assertions restored to rotation (silent-0 → 197/0; net +197). Group 21 kept-with-symbol-rename. CLAUDE.md lines 140 + 412 updated. Bonus fixes: Group 16 stale port assertion (55557→55558) + lying header comment line 12. **CRITICAL META-FINDING worth queuing**: silent-zero test failures are the worst regression class — broken-on-import test files drop all their assertions silently because rotation tooling treats them as 0/0 not failure. 234 assertions vanished for ~5 days (D97→D102) before CLEANUP-M3-FIXES worker ran the full rotation. Recommendation: rotation-runner harness improvement to fail-loud on import errors (queued as standalone tiny improvement).
- **D105** M5-animation+materials shipped (commit `24cb115`, 6 tools incl. RC delegate). get_audio_asset_info SUPERSEDED-as-offline per D101 (v); set_material_parameter ships as RC HTTP delegate per D101 (ii). +93 assertions. 5 UE 5.6 institutional-memory items added.
- **D106** M5-input+geometry shipped (commit `112b749`, 6 tools). Geometry Script plugin pre-flight PASSED. +109 assertions. **M5-PREP scaffold parallel-safety EMPIRICALLY VINDICATED**: 0 merge conflicts vs M3-era 3-stash-cycle thrash. D96 expensive lesson + D101 verifier shard-upfront recommendation + D103 M5-PREP empty-loop scaffold = end-to-end structural fix verified across 3 sub-workers.
- **D107** M5-editor-utility shipped (commit `f36e4e1`, 6 tools with 4-layer security defense-in-depth). Layer 1 (server flag) + Layer 0 (plugin runtime) + Layer 2 (deny-list) + Layer 3 (audit log). +94 assertions including security-path coverage. **CRITICAL CROSS-WORKER CONFIRMATION**: `.git/info/forbidden-tokens` absent in this worker's checkout TOO (D103 §2 reproduction across 2 worker sessions in 2 days). Promoting `.githooks` warn-on-missing fix from "queue alongside grooming" to **SHIP SOON**.
- **D108** M5 milestone complete — all 19/19 not-shipped tools landed across 3 parallel sub-workers (~3.5 sessions actual vs 6-10 estimate). **Phase 3 ~99% complete**; M5 was the last primary dispatch milestone. Remaining items are entirely optional follow-ons (live-fire smoke + TCP:55557 retirement + WIDGETS-PERF + FA-ε write-side audit + audit-batch-2 + various small improvements). The Phase 3 scope-refresh sequence (D58 §Q5) is empirically closed.
- **D109** BLUEPRINT-ASSET-PATH-RESOLUTION bug surfaced 2026-04-28 by a third UEMCP-deployed test target (non-`/Game/Blueprints/` content layout). `ActorHandlers.cpp:630` + `BlueprintHandlers.cpp:46` `LegacyPath()` helper (cascades to 15 BP-write tools) + `WidgetHandlers.cpp:734-736` + tip text all hardcode `/Game/Blueprints/` prefix → 17 tools silently broken on non-standard layouts. Fix: `ResolveBlueprintAssetPath()` 3-case chain (full-path → legacy back-compat → AssetRegistry fallback w/ ambiguity errors). Standalone fix worker queued (~1-2 sessions); D49-clean across 5 plugin C++ + tools.yaml + 3 test files.
- **D110** SETUP-BAT-PLUGIN-DEPS shipped (3 commits — main + Blutility-fix + .uplugin cleanup). Setup script now enables RemoteControl + PythonScriptPlugin + GeometryScripting in target .uproject (idempotent, atomic-write, EXIT_CODE 5). **Blutility is NOT a plugin — it's an engine MODULE** (Build.cs only, NOT .uproject Plugins[] or .uplugin Plugins[]); UE 5.6 institutional-memory item. **§6 .githooks warn-on-missing BUNDLED** — closes D103+D107 cross-worker reproduction.
- **D111** M5 deployment compile-fix wave (3 commits). 5 build errors + LogObj symbol-collision rename + InputCore/Projects link deps. **Wire-mock vs build-time gap empirically demonstrated**: M5 wire-mock-green code surfaced build errors only when Noah ran Build.bat against real UE 5.6 module graph. D87 framing reinforced: "code committed + tests green ≠ build clean against real UE." Future M-* sub-worker handoffs should include "build-on-real-UE final verification before final-report" in the success criteria.
- **D112** BLUEPRINT-ASSET-PATH-RESOLUTION-FIX shipped (commit `3a5b600`, 12 files, +427/-39, +16 assertions). New `BlueprintLookupHelper.{h,cpp}` exports `ResolveBlueprintAssetPath` 3-case chain (full-path / legacy back-compat / AssetRegistry fallback with explicit ambiguity errors). 14 BP-write handlers cascade through single `ResolveBlueprint()` chokepoint in BlueprintHandlers.cpp. 17 tools previously broken on non-standard layouts now work. 3 new UE 5.6 institutional-memory items (AR canonical BP enumerator pattern; FAssetData::PackageName as lightest accessor; editor AR is always populated post-startup, no caching needed). 5-case live-smoke folded into Post-M5 deployment-smoke handoff §1.0; D109 saga closes empirically when Noah's smoke runs.

---

## Active conventions (orchestrator MUST enforce)

### Commits + writes
- **D49 path-limited commits**: each worker has explicit file scope. Surface scope deviations via separate-commit pattern (D72 lesson) — don't reject; document.
- **D82 NDA-gate active**: NDA-protected project codenames are blocked by `.githooks/pre-push`. The literal block-list lives at `.git/info/forbidden-tokens` (per-checkout, untracked) — read it locally to know what NOT to commit. **Orchestrator MUST use placeholder vocabulary** in commits + D-log entries: `Project A`, `Project B`, `target-project`, `<target-project>`, `<your-project>`. If a commit gets blocked at push time, soft-reset + sed-replace the codenames + recommit. (Pattern at D86 commit recovery.)
- **Multi-agent orchestration handoff convention** (CLAUDE.md §Public-Repo Hygiene §Multi-agent orchestration handoff convention, established 2026-04-25): two-channel pattern. Codenames may flow through the **ephemeral channel** (chat / inline opener / dispatch message) so the receiving session can fill placeholders when invoking tools or reading paths. Codenames must NOT flow through the **committed channel** (handoff docs, commit messages, D-log, README, CLAUDE.md). When a new orchestrator inherits via this doc, the inline message that delivers the codenames is the ephemeral hand-off; once the new session knows the codenames, it translates back to placeholders for any disk writes. This is what makes the NDA-gate operationally workable across context migrations.
- **D81 Edit-tool CRLF hazard**: `Edit` tool silently drops multi-line edits on CRLF-encoded `.bat` and possibly `plugin/UEMCP/` C++ files. Always `git diff` after Edit on those files; use `Write` for full rewrites if multi-line Edit lands incomplete.

### Scripts (.bat in repo root)
**Required convention** per CLAUDE.md §Shell & Tooling Requirements §.bat convention:
- Single point-of-exit through `:end` label
- `EXIT_CODE` + `AUTO_YES` sentinels
- `pause` in interactive mode (when `AUTO_YES=0`)
- `endlocal & exit /b %EXIT_CODE%` (immediate-expansion idiom propagates value past `endlocal`)

Verified compliant: `setup-uemcp.bat`, `sync-plugin.bat`, `test-uemcp-gate.bat` (all three as of commit `66bf214`+).

### Deployment cycle (D87 + D88)
After any audit-fix landing C++ plugin code OR ESM JS server code, user must:
1. Close editor (UE 5.6)
2. Run `sync-plugin.bat "<path-to-uproject>"` to propagate plugin source
3. Run `Build.bat <ProjectName>Editor Win64 Development -project="<path-to-uproject>" -WaitMutex` (where `<ProjectName>` is the basename of the `.uproject`)
4. Relaunch editor
5. Restart Claude Code (close + reopen) so MCP server reloads ESM modules

Without this, fix exists in git but doesn't run. **D87 framing**: "code committed + tests green ≠ fix is live." Orchestrator should bake deployment-cycle confirmation into success criteria for any C++ or server-JS audit-fix dispatch.

### UE 5.6 API gotchas (institutional memory)
For C++ plugin workers — verify against engine source before assuming pre-5.6 paths/methods:
- **D60**: `IsRunningCommandlet()` is global free function in `CoreGlobals.h`, NOT `FApp::` member.
- **D61**: UBT cache may serve stale DLL. If post-rebuild behavior doesn't match source: nuke `Binaries/` + `Intermediate/` + fresh `Build.bat`.
- **D69**: Transient PCH-VM exhaustion (C1076/C3859) on first `Build.bat` — retry once before escalating.
- **D78**: `UUserDefinedStruct` moved to `StructUtils/UserDefinedStruct.h`; `FObjectThumbnail` in `Misc/ObjectThumbnail.h`; `AccessCompressedImageData()` not `GetCompressedImageData()`.
- **D81**: `Async/Future.h` is canonical UE 5.6 path (not `Templates/Future.h`).
- **D87**: `FCoreUObjectDelegates::OnObjectSaved` is `UE_DEPRECATED(5.0)` — use `OnObjectPreSave`.
- **D87**: `FContentBrowserMenuExtender_SelectedAssets` handle retrieval via `Extenders.Last().GetHandle()` (not returned from `Add` call).
- **D88**: `FObjectThumbnail` has TWO independent buffer fields — `ImageData` (raw BGRA from `RenderThumbnail`) and `CompressedImageData` (PNG, only from explicit `CompressImageData()` OR `Serialize` from disk). `AccessCompressedImageData()` has NO lazy-encode fallback.

---

## Open orchestrator calls (decisions deferred)

| Item | Anchor | Trigger to revisit |
|---|---|---|
| **PARTIAL-RC commit-or-collapse**: 13 PARTIAL-RC tools currently dispatch all-TCP (D76 pragmatic simplification). Audit §F-18 flags `list_data_asset_types` as canonical code-smell instance. | D66 §Q6 / D76 / D86 audit | When workflow pressure surfaces RC-augmentation latency wins, OR when M3 writes-rebuild reveals a related decision |
| **F-14 PIE teardown race** (engine-internal `RequestEndPlayMap` async): D81/D83 marshaling fixes request-side; engine-internal completion lag persists. | D81 / D87 | When PIE workflows become important, OR when an agent task hits the race observably |
| **Audit-batch-2 timing**: 22 medium/low findings from D79 audit pending. CLEANUP-MICRO covers 3 specific items; rest queued. | D79 §5 | After CLEANUP-MICRO + Wave 4 dispatch settles |
| **T-1c engine-BP Oracle-A retargeting**: would eliminate fixture-drift entirely; gated on production-tool `/Engine/` path support per T-1b worker finding. | D80 / T-1 backlog | When Project B integration / agent-onboarding friction surfaces |
| **Phase 5 distribution + Phase 6 per-project tuning**: long-term scope. | CLAUDE.md / D58 | After Wave 4 completes |

---

## Verification layers (what each catches)

Each layer surfaces a different bug class. Together they close the "automated-tests green but agent-UX broken" gap.

| Layer | Catches | Misses | Cost |
|---|---|---|---|
| **Wire-mock automation** (1381 assertions) | shape contracts, name translation, error normalization, scalar response paths | live-editor APIs, real RC endpoint existence, cross-endpoint composition, deployment gaps | ~10-30s per rotation |
| **Audit** (D79 pattern) | code review findings, invariant violations, edge cases, ergonomic gaps | runtime correctness, deployment state | 1-2 sessions per audit |
| **Integration smoke** (D77/D86) | game-thread asserts, render-thread issues, UE API drift, deployment gaps, real composition | obscure non-flagrant bugs (need targeted user diagnostic) | 30-60 min human time |
| **User-driven diagnostic** (D88 pattern) | wrong-root-cause theories from earlier layers (worker theory was structurally wrong about Bug 4 — only deep buffer-vs-pipeline trace surfaced the truth) | nothing (highest fidelity) | Variable; high cognitive cost |

**Rule** for orchestrator: don't trust worker self-reports as final word on live correctness. Wire-mock + commit ≠ deployed + working. The validation cycle is load-bearing precisely BECAUSE worker reports get the diagnosis wrong sometimes.

---

## Phase 3 progress + remaining

| Wave | Status | Remaining |
|---|---|---|
| Wave 1 (M1 + M-spatial + Oracle-A/v2) | ✅ Shipped | — |
| Wave 2 (M-new S-B-base + Verb-surface) | ✅ Shipped | — |
| Wave 3 (M-enhance HYBRID + Phase 4 absorbed) | ✅ Shipped | — |
| Validation cycle (audit + T-1b + smoke + audit-fixes 1/2/3 + SMOKE-FIX + deployment) | ✅ Complete | — |
| CLEANUP-MICRO (Bug 4 PNG + use-after-free + Zod) | ✅ Shipped 2026-04-25 (commit `c95c2bb`, see D90) | — |
| D81-SANITIZATION-AUDIT | ✅ Shipped 2026-04-25 (audit doc at `docs/audits/d81-sanitization-regressions-2026-04-25.md`, see D89) | — |
| D81-SANITIZATION-FIXES | ✅ Shipped 2026-04-26 (commit `5c48718`, see D92 — all 10 audit findings closed) | — |
| DOCS-GROOMING (Open Items §2-§5 + pre-commit hook) | ✅ Shipped 2026-04-26 (commit `1a65d0f`, see D94 — also surfaced UTF-8 locale bug in pre-push hook; orchestrator inline-fixed in same D-log commit) | — |
| M3-actors | ✅ Shipped 2026-04-26 (commits `916a688` + `c161aec`, see D93 — pattern decisions captured for siblings) | — |
| M3-widgets | ✅ Shipped 2026-04-26 (commit `315efb2`, see D96 — both KNOWN-ISSUE handlers fixed in rebuild; UMG institutional memory extended) | — |
| M3-blueprints-write | ✅ Shipped 2026-04-26 (commit `0c7448c`, see D97 — landed atop M3-widgets via shared-file re-application) | — |
| **M3 milestone** | ✅ COMPLETE 2026-04-26 (D98) — all 32 tools live on TCP:55558; D23 oracle retirement now empirically actionable | — |
| M4 reduced reads | ❌ SUPERSEDED 2026-04-26 (see D95) | 0 sessions remaining |
| M-enhance reads conformance audit (M4 redirect option 2) | ⏸ Optional follow-on — bundle with audit-batch-2 when that fires | TBD |
| S-B-overrides scope amendment | ⏸ Orchestrator recommends (c) defer with switch-to-(a) trigger; awaiting Noah call | — |
| **M5 — animation/materials/visual-capture/etc.** | ⏸ Operative Wave 4 dispatch surface; awaiting Noah signal. **Per D96 lesson, draft umbrella overview with shared-file integration strategy explicit before drafting sub-worker handoffs** — recommend option (b) shard-upfront for clean parallelism with 3-4 sub-workers | 6-10 sessions |
| TCP:55557 formal retirement | ⏸ Queued — PARTIAL gate per D99 smoke: BP-write CLEAR; actors + widgets need CLEANUP-M3-FIXES first then re-smoke. Then strip 55557 client code + remove `<project>/Plugins/UnrealMCP/` | 0.5-1 session post-CLEANUP-M3-FIXES + re-smoke |
| Bug 4 (M5 visual-capture gate) | ✅ CLOSED LIVE 2026-04-26 (D99 — get_asset_preview_render returns thumbnail bytes for StaticMesh + BP) | — |
| **CLEANUP-M3-FIXES** | ⏸ Drafting recommended — bundles 5 D99 findings (set_actor_property Mobility traversal, take_screenshot silent fail, M3-widgets PIE-lookup, bind_widget_event chain, Bug 4 mime label, RC CDO path tip). File-disjoint across ActorHandlers.cpp + WidgetHandlers.cpp + VisualCaptureHandler.cpp + tools.yaml | 1-2 sessions |
| **WIDGETS-PERF investigation** | 🚀 In flight (dispatched 2026-04-28) — profile-then-fix for D99 #5 | 1-2 sessions |
| **FA-ε write-side audit** | 🚀 In flight (dispatched 2026-04-28) — D99 #6 + D100 enrichment | 1-2 sessions |
| **M5-PREP** (shard-upfront infrastructure) | ✅ Shipped 2026-04-26 (commit `a5b565f`, see D103 — 19 stubs, m5ToolsetGroups[] empty-loop scaffold + NotImplemented lambda factory; sub-workers can fan out with zero collision) | — |
| **M5-animation+materials** | ✅ Shipped 2026-04-26 (commit `24cb115`, see D105 — 6 tools incl. RC delegate; get_audio_asset_info SUPERSEDED-as-offline; +93 assertions) | — |
| **M5-input+geometry** | ✅ Shipped 2026-04-26 (commit `112b749`, see D106 — 6 tools; Geometry Script plugin pre-flight PASSED; +109 assertions; M5-PREP scaffold parallel-safety EMPIRICALLY VINDICATED — 0 collisions vs M3-era 3 stash cycles) | — |
| **M5-editor-utility** | ✅ Shipped 2026-04-26 (commit `f36e4e1`, see D107 — 6 tools with 4-layer security defense-in-depth; +94 assertions; CLAUDE.md §Security flag + tools.yaml + smoke plan handoff at `docs/handoffs/m5-editor-utility-smoke-plan.md`) | — |
| **M5 milestone** | ✅ COMPLETE 2026-04-26 (D108) — 19/19 not-shipped tools shipped across 3 parallel sub-workers; D101 verifier verdict empirically closed; ~3.5 sessions actual vs 6-10 estimate | — |
| **.githooks pre-commit/pre-push missing-file warning** | ✅ Shipped 2026-04-27 (bundled into SETUP-BAT-PLUGIN-DEPS commit `d45ca29` §6, see D110) — both hooks print loud WARNING when `.git/info/forbidden-tokens` absent |
| **BLUEPRINT-ASSET-PATH-RESOLUTION-FIX** | ✅ Shipped 2026-04-28 (commit `3a5b600`, see D112 — 12 files, +427/-39; 17 tools fixed via single chokepoint; 5-case live-smoke folded into Post-M5 deploy smoke §1.0) |
| **SETUP-BAT-PLUGIN-DEPS** | ✅ Shipped 2026-04-27 (commits `d45ca29` + `43fc722` Blutility-fix + `3b705de` .uplugin cleanup, see D110) — script enables RemoteControl + PythonScriptPlugin + GeometryScripting in target .uproject; Blutility correctly identified as engine module not plugin |
| **M5 deployment compile-fix wave** | ✅ Shipped 2026-04-27 (commits `59d7c63` + `6059d4c` + `f42c04e`, see D111) — 5 build errors + LogObj symbol-collision rename + InputCore/Projects link deps |
| ~~CLEANUP-M3-FIXES-2~~ | ❌ NOT NEEDED — D102 worker proactively covered gauntlet's broader patterns (subobject-traversal-universal in §1, all-3-widgets-PIE-lookup in §3) within CLEANUP-M3-FIXES scope | — |
| **CLEANUP-M3-FIXES** | ✅ Shipped 2026-04-26 (commit `78032c4`, see D102 — 5 fixes + 1 doc + gauntlet-broader patterns covered + 6 UE 5.6 institutional-memory additions) | — |
| **TEST-IMPORTS-FIX** | ✅ Shipped 2026-04-26 (commit `5028c47`, see D104) — 197 assertions restored to rotation; bonus fixes for Group 16 stale port + lying header comment |
| **ROTATION-RUNNER-FAIL-LOUD** | 🚀 In flight (dispatched 2026-04-28) — closes D104 silent-zero meta-finding | 0.25-0.5 session |
| **CLAUDE.md/README/yaml grooming** | 🚀 In flight (dispatched 2026-04-28) — closes D94→D112 accumulated drift items | 0.25-0.5 session |
| **Post-M5 deployment smoke** | 🚀 In flight (dispatched 2026-04-28) — bundled M5 + CLEANUP-M3-FIXES + D110 + D111 + **D112 5-case smoke** + streamlined gauntlet | 60-90 min |
| **CLAUDE.md/README grooming pass** | ✅ Shipped 2026-04-26 (commit `1a65d0f`, see D94) — keeping for visibility | — |
| Wave 4 — M3 + M4 + M5 | ⏸ Dispatchable (M5 gated on CLEANUP-MICRO) | ~15-25 sessions |
| Phase 5 + Phase 6 | Long-term | Out of current planning window |

---

## What worked / what didn't (orchestration retrospective)

### Patterns that worked
- **4-worker parallel dispatch with D49 path-limits**: zero merge conflicts across Wave 1's 4 simultaneous workers (Oracle-A + EN-8/9 + sync-plugin + log-demote). Validates the parallelism ceiling at 3-4 workers when scopes are file-disjoint.
- **Audit handoff → audit-fix handoff pattern**: D79 produced 29 findings; D83/D84/D85 closed top-3 batch surgically. Read-only audit + targeted fix is cheap insurance.
- **Smoke catches what wire-mock can't**: D86's 5 bugs were all invisible to 1338-assertion rotation. Smoke is load-bearing for plugin C++ + cross-subsystem composition.
- **Pre-drafted handoffs unblock zero-latency dispatch**: drafting S-B-base / Verb-surface / M-enhance handoffs before Oracle-A/S-B-base/Verb-surface landed eliminated dispatch-latency for downstream waves.

### Patterns that didn't (lessons learned)
- **Worker self-reports + wire-mock-green ≠ live correctness**: D86 framing called 3 bugs "recurrences" of audit-fix defects when they were actually deployment gaps. AUDIT-FIX-1 + AUDIT-FIX-3 were always correct; just never reached the live editor + MCP server process. **Rule**: smoke verification is the canonical "shipped + working" gate, not "commit landed."
- **Theory-first diagnostic is risky**: SMOKE-FIX worker theorized Bug 4 thumbnail-empty was an async/render-thread issue. D88 in-session investigation found the real cause was structural (missing CompressImageData call). When a "render returned empty" symptom appears, **first investigation step is "did data flow into the buffer I'm reading from?"** not "is timing wrong?"
- **Codename leak attempts during commits** are caught by D82 gate but require recovery flow (soft-reset + sed-replace + recommit). Orchestrator should pre-scan commit content for codenames BEFORE first push attempt — saves the recovery cycle.

---

## Quick-start checklist for new orchestrator session

1. Read this doc (you are here).
2. `git log --oneline -20` — last 20 commits ground you in recent flow.
3. Read CLAUDE.md §Current State + §Onboarding + §Shell & Tooling.
4. Read `docs/tracking/risks-and-decisions.md` D77-D88 (last 11 entries).
5. Read `docs/tracking/backlog.md` (in-flight + dispatch queue).
6. List session-local handoffs: `ls docs/handoffs/*.md | head -20` (gitignored — only present in your local checkout if you cloned recently OR a worker just produced one; primary source-of-truth is what each handoff path documents in this doc above).
7. Default first action: confirm test baseline (`cd server && npm test` per file rotation in CLAUDE.md §Testing). Should be 1381 / 0 failing. If different: investigate before dispatching.
8. Default first dispatch: CLEANUP-MICRO (closes Bug 4 + clears M5 gating). Then D81-SANITIZATION-AUDIT in parallel. Then M3/M4 when user signals Wave 4 readiness.

---

## Conversation tone + posture (cosmetic but useful)

- User (Noah) prefers tight, structured responses. Short lists > long prose.
- Code blocks for any commands user copy-pastes. Tables for option-comparisons.
- `★ Insight ─────────────────────────────────────` blocks for educational content (orchestrator may be in Learning + Explanatory mode).
- Don't over-invoke advisor on every turn — call out front of substantive decisions.
- Workers are referenced by their role + commit, not by codename or worker ID.
- D-log entries cite root cause + fix + impact, not narrative. Pipe-table format with bold key-finding callouts.

---

## File pointers (where things are)

```
D:\DevTools\UEMCP\
├── README.md                        ← public-facing onboarding
├── CLAUDE.md                        ← project-state snapshot + design rules
├── tools.yaml                       ← single source of truth for ~122 tools (D44)
├── setup-uemcp.bat                  ← new-machine onboarding (GUI/arg)
├── sync-plugin.bat                  ← propagate plugin to target project
├── test-uemcp-gate.bat              ← D57 commandlet gate verifier
├── server/                          ← Node.js MCP server (.mjs)
│   ├── server.mjs
│   ├── offline-tools.mjs            ← Verb-surface verbs, S-B-base extractBPEdgeTopology
│   ├── uasset-parser.mjs            ← byte-level .uasset/.umap parser
│   ├── connection-manager.mjs       ← 4-layer transport + Layer 4 RC HTTP client
│   ├── tcp-tools.mjs                ← Phase 2 TCP tool handlers
│   ├── menhance-tcp-tools.mjs       ← M-enhance FULL-TCP handlers (10 tools)
│   ├── rc-tools.mjs                 ← M-enhance FULL-RC + PARTIAL-RC handlers
│   ├── rc-url-translator.mjs        ← RC URL scheme builder
│   ├── tool-index.mjs
│   ├── toolset-manager.mjs
│   ├── test-fixtures.mjs            ← T-1b shared synthetic-fixture helpers
│   └── test-*.mjs                   ← 12 test files
├── plugin/UEMCP/                    ← C++ UE5 editor plugin
│   └── Source/UEMCP/
│       ├── Public/                  ← exported headers
│       │   ├── MCPCommandRegistry.h
│       │   └── MCPThreadMarshal.h   ← AUDIT-FIX-1 marshaling helper (D83)
│       └── Private/                 ← implementations
│           ├── UEMCPModule.cpp      ← StartupModule + D57 commandlet gate
│           ├── MCPServerRunnable.cpp ← TCP:55558 listener
│           ├── MCPCommandRegistry.cpp ← handler dispatch
│           ├── MCPThreadMarshal.cpp ← RunOnGameThread<T> + GT_TIMEOUT envelope
│           ├── CompileDiagnosticHandler.cpp
│           ├── ReflectionWalker.cpp
│           ├── VisualCaptureHandler.cpp ← Bug 4 fix target (D88)
│           ├── SidecarWriter.cpp + SidecarSaveHook.cpp + SidecarMenuHook.cpp
│           ├── DataSourceHandlers.cpp
│           └── Commandlets/
│               ├── DumpBPGraphCommandlet.cpp (Oracle-A)
│               ├── DumpBPSidecarCommandlet.cpp (3F-4 production)
│               ├── EdgeOnlyBPSerializer.cpp
│               └── fixtures/         ← Oracle-A-v2 fixture corpus (6 BPs)
└── docs/
    ├── README.md
    ├── specs/                       ← design docs
    ├── plans/                       ← phase plans
    ├── audits/                      ← read-only audit findings
    ├── research/                    ← scope-refresh + feasibility deliverables
    ├── handoffs/                    ← SESSION-LOCAL (gitignored per D81)
    ├── testing/                     ← manual smoke results
    └── tracking/
        ├── risks-and-decisions.md   ← D-log (currently D1-D88)
        ├── backlog.md               ← in-flight + queued + recently-shipped
        └── orchestrator-state-2026-04-25.md  ← THIS DOC
```

---

## Sign-off

This doc is current as of commit `b7c6dca` (D88: deployment cycle complete + Bug 4 corrected root cause; CLEANUP-MICRO drafted). When you supersede it, drop a successor doc + delete this one in the same commit (preserves single-source-of-truth for orchestrator state).
