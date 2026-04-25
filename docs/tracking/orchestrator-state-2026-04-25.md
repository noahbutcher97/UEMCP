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

### In flight

- **None currently dispatched.** CLEANUP-MICRO + D81-SANITIZATION-AUDIT both shipped per D90 + D89. D81-SANITIZATION-FIXES gate cleared; ready for next dispatch.

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
3. **D81-SANITIZATION-FIXES dispatch decision** — audit landed with 10 findings (D89). Recommended fix order F-1 → F-5 → batch (F-2/3/4/7) → batch (F-6/8/9) → F-10. Single-commit feasible. Whether to dispatch immediately vs batch with M3/M4 wave is a Noah call; orchestrator default = dispatch immediately since it's small + clears the audit-tracked drift.
4. **S-B-overrides scope decision** — D91 surfaced that Project B is on UE 5.7 AND in active use AND the offline parser breaks at header walk on every 5.7 BP. Was previously "lower priority until secondary target materializes." Materialized. Whether to bump ahead of Wave 4 (M3/M4/M5), run S-B-overrides parallel, or accept Project-B-via-sidecar-only-for-now is an open call.
5. **D87 deployment-cycle pattern**: any audit-fix landing C++ code requires editor close + sync-plugin.bat + Build.bat + relaunch + MCP-server restart. Don't trust "code committed" as "live."

---

## Recent D-log highlights (D77 → D91)

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
| D81-SANITIZATION-FIXES | ⏸ Dispatchable now — audit gate cleared (10 findings: 1 high · 4 medium · 5 low) | 0.5-1.5 sessions |
| S-B-overrides scope amendment | ⏸ Decision pending — Project B on UE 5.7 + parser breaks at header walk per D91; Noah call whether to bump ahead of Wave 4 | — |
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
