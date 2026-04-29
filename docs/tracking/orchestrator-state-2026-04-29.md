# Orchestrator State — 2026-04-29

> **Living doc**: succeeds `orchestrator-state-2026-04-25.md` (deleted in the same commit per the single-source-of-truth rule). Superseded when the next snapshot lands.
> **Quick reading path** (15 min total):
> 1. This doc (5 min) — current state, dispatch queue, conventions, recent D-log highlights
> 2. `CLAUDE.md` — project-state snapshot + design rules
> 3. `docs/tracking/risks-and-decisions.md` D119-D121 entries (last 3 entries; the recent history that closes the D118 follow-on triage)
> 4. `docs/tracking/backlog.md` — in-flight + queued items

---

## TL;DR

**Phase 3 close-out is now 2-3 worker dispatches + 2 deploy cycles away** (not one-deploy-away as stated pre-D122). All primary-dispatch milestones complete (Wave 1 + Wave 2 + Wave 3 + M3 + M5; M4 superseded under M-enhance per D95). D118 follow-on triage closed (D119 + D120 + D121). **D122 smoke RE-REDISPATCH partial-cleared**: §0 + §1.0 + §1 PASS (D109/D112 + D102 close empirically; D121 SHARPENING #1 verified live; D114 WIDGETS-PERF measurement confirmed). §2 BLOCKED (`create_montage` denial — opener-template defect, structurally fixed). §3-§6 deferred (NEW-2 crash). **D120 hypothesis EMPIRICALLY FALSIFIED** — NEW-2 reproduced at LOWER call count without broken-asset trigger; race is independent of NEW-1.

**Test rotation baseline**: ~1900 with full fixtures (per D116 ROTATION-RUNNER + D117 grooming refresh; varies ±N per fixture availability).

**Remaining Phase 3 close-out path**: (1) auto-codename worker ships (D3 Phase 1+2+3) → (2) UEMCP-side NEW-2 mitigation worker ships (D2 (b) Option B revival, n=2-justified) → (3) Noah deploys both + files UDN bug-report → (4) re-redispatch smoke with ~15-call/~15-min relaunch + §0.5 instrumentation + §3.5 third-target stress → (5) if §3-§6 clears + NEW-2 doesn't reproduce/extends ceiling → TCP:55557 retirement gate CLEARS.

---

## Active state (as of 2026-04-29)

### In flight

- **None currently dispatched.** D119/D120/D121 deployed + verified-live-at-code-marker (per D122 §0). D122 smoke RE-REDISPATCH closed; comprehensive D2 + D3 plan kicked off this commit.

### Phase 3 close-out path — comprehensive sequence post-D122

1. **Noah dispatches auto-codename worker** (D3 Phase 1+2+3 — see opener in chat). Deliverable: setup-uemcp.bat + sync-plugin.bat auto-extract project + parent-dir codenames; MCP server runtime project-path capture; pre-commit pattern-warning. ~0.5-1 session.
2. **Noah dispatches UEMCP-side NEW-2 mitigation worker** (D2 (b) — see opener in chat). Deliverable: connection recycle + RC-call-rate cap + per-section auto-relaunch hint; additive opt-in via `UEMCP_RC_*` env flags; doesn't break the 80% of cases that work. ~1-2 sessions.
3. **Noah files UDN bug-report** (D2 (a)) when convenient — ready-to-submit body at `docs/audits/new-2-udn-bug-report-2026-04-29.md`. ~30-60 min Noah-time.
4. **Noah deploys** both worker outputs (D87 + D110 4-step sequence). The auto-codename worker may auto-register codenames; the NEW-2 mitigation worker introduces opt-in env flags for callers.
5. **Orchestrator pre-dispatch verify** per `feedback_predispatch_deploy_state_check.md` memory + grep for new-source markers from both workers.
6. **Re-dispatch Post-M5 smoke** with: tightened ~15-call/~15-min relaunch (D2 (c)) + NEW-2 instrumentation §0.5 (D2 (d)) + §3.5 third-target NEW-2 stress (D2 (e)) + standing-policy NDA-scope line (closes NEW-3 dissolution structurally) + UEMCP-side mitigation flags enabled.
7. **If smoke clears §3-§6 + NEW-2 doesn't reproduce / extends ceiling** (or reproduces only past the new operational ceiling): **Phase 3 primary dispatch surface FULLY closed + TCP:55557 retirement gate CLEARS**.

### Live deployment status

D119/D120/D121 deployed + verified-live (per D122 §0 source markers). User-pending: 2-3 worker dispatches + 2 deploy cycles per the comprehensive sequence above. Deploy commands per CLAUDE.md §Onboarding + D87/D110 4-step sequence.

---

## Dispatch-ready queue (post-Phase-3-close-out follow-ons)

**Critical-path items** (top of queue — required for Phase 3 close-out):

| # | Item | Notes |
|---|---|---|
| **A** | **Auto-codename-registration worker (D3 Phase 1+2+3)** | Comprehensive D3 implementation. Phase 1: setup-uemcp.bat + sync-plugin.bat auto-add project + parent-dir codenames. Phase 2: MCP server runtime project-path → state file → pre-commit auto-merge. Phase 3: pre-commit pattern-warning for capitalized words near `D:/UnrealProjects/` paths. Closes D109/D118 leak class structurally. Opener drafted in chat. ~0.5-1 session. |
| **B** | **UEMCP-side NEW-2 mitigation worker (D2 (b))** | Connection recycle (force-fresh socket every N calls) + RC-call-rate cap (token-bucket) + per-section auto-relaunch hint (warn at ~15-call ceiling). Opt-in via `UEMCP_RC_*` env flags; additive; preserves HYBRID-transport reliability for the 80% of cases that work. n=2 + falsified D120 hypothesis justifies dispatch. Opener drafted in chat. ~1-2 sessions. |
| **C** | **UDN bug-report filing (D2 (a))** | Noah-action (UDN account-gated). Ready-to-submit body at `docs/audits/new-2-udn-bug-report-2026-04-29.md` — D120 §5 outline + D122 second-observation falsification. ~30-60 min. |

**Post-Phase-3 follow-ons** (optional; queued behind close-out):

| # | Item | Notes |
|---|---|---|
| 1 | **TCP:55557 client deletion + UnrealMCP plugin removal** | Gated on Post-M5 smoke verdict CLEAR. Strip 55557 client code from `server/connection-manager.mjs` + remove `<project>/Plugins/UnrealMCP/` from project deployments. ~0.5-1 session. |
| 2 | **Audit-batch-2** | 22 medium/low D79 findings + M-enhance reads conformance audit (M4 redirect option 2 per D95) + PartialRC commit-or-collapse decision. Bundle when convenient. ~2-4 sessions. |
| 3 | **PostEditChange-sweep follow-on** | D115 audit §5: 17 other `MarkBlueprintAsModified` callsites need PostEditChangeProperty audit if RC staleness symptoms surface. Triage-only unless empirical signal. |
| 4 | **Path-form drift fix** | D115 audit §5: `rc-url-translator.mjs:toCdoPath` vs `server.mjs` TOOLSET_TIPS path-form mismatch. Pre-existing; fix if smoke fails on path resolution. |
| 5 | **set_static_mesh_properties / set_physics_properties PostEditChange verification** | D115 audit §5: typed setters likely fire internal broadcasts; verify via §FA-ε.3 latent staleness sweep in next smoke. |
| 6 | **save_widget_blueprint tool** | D114 worker open item: caller batches that don't end with a binding op rely on editor's interactive Save All. Future enhancement; not blocking. |
| 7 | **Rotation-runner determinism review** | D121 worker observed 1-run flake in baseline (1312/1320 vs 1299/1307); not reproducible after stash-pop. Investigate if recurs. |
| 8 | **`Visibility` + `take_screenshot` smoke handoff drift fixes** | D122 smoke surfaced 2 minor handoff sharpenings: `Visibility` is not a UProperty on PointLight (test-design); `take_screenshot` returns `filepath` not `absolute_path`. Bundle into next standalone cleanup worker OR include in NEW-2 mitigation worker scope. ~5 min total. |
| 9 | **WinDbg + symbols-resolved minidump walk for NEW-2** | D2 (f) — distinguish `GetAccessValue` vs `DeserializeCall` FindChecked path; enriches UDN body. Optional Noah-time. |
| 10 | **S-B-overrides scope amendment** | D91 surfaced Project B on UE 5.7 + parser breaks at header walk. Orchestrator-default = (c) defer; awaiting Noah call if cross-version pressure surfaces. |
| 11 | **Phase 5 distribution + Phase 6 per-project tuning** | Long-term scope; out of current planning window. |

---

## Active conventions (orchestrator MUST enforce)

### Commits + writes
- **D49 path-limited commits**: each worker has explicit file scope; surface scope deviations via separate-commit pattern (D72 lesson).
- **D82 NDA-gate active**: `.git/info/forbidden-tokens` block-list (per-checkout, untracked). Pre-push hook is UTF-8-safe per D94; pre-commit warn-on-missing per D110 §6. **Use placeholder vocabulary** in committed content. Pre-commit codename grep is mandatory (per `feedback_pre_commit_codename_scrub.md` memory). Recovery if blocked: soft-reset + sed-replace + recommit.
- **Multi-agent orchestration handoff convention** (CLAUDE.md §Public-Repo Hygiene): orchestrator drafts openers; user dispatches in fresh conversations. Two-channel pattern — codenames in chat ephemeral; placeholders for committed content.
- **D81 Edit-tool CRLF hazard**: `git diff` after every Edit on plugin/* C++ + .bat scripts; use `Write` for full rewrites if multi-line Edit lands incomplete.

### Pre-dispatch verification (per `feedback_predispatch_deploy_state_check.md` D113 memory)
For deployment-smoke handoffs in high-velocity batch periods (multiple commits in 1-2 days): grep deployed plugin source for fresh-source markers from recent commits BEFORE dispatching. Skip if deploy state is stale; surface to Noah with deploy-cycle steps needed.

### Project paths (per `project_corrected_deploy_target_path.md` D118 memory)
Project A's actual live deployment is at the **wrapper-codename-prefixed sibling** directory, NOT the project-A-only sibling at `D:/UnrealProjects/5.6/<project-A>/<project-A>/` (which has stale DLL since 2026-04-22). Use the wrapper-prefixed form in ALL future smoke / live-fire openers.

### Scripts (.bat in repo root)
**§.bat convention** per CLAUDE.md §Shell & Tooling Requirements:
- Single point-of-exit through `:end` label
- `EXIT_CODE` + `AUTO_YES` sentinels
- `pause` in interactive mode
- `endlocal & exit /b %EXIT_CODE%` propagation idiom

Verified compliant (post-D92 + D110): setup-uemcp.bat, sync-plugin.bat, test-uemcp-gate.bat.

### Deployment cycle (D87 + D110 4-step sequence)
1. **`setup-uemcp.bat <uproject>`** — lands D110 .uproject Plugins[] gate (RemoteControl + PythonScriptPlugin + GeometryScripting). REQUIRED separately from sync-plugin.bat per D113 (D110 finding empirically verified absent in current Project A).
2. **`sync-plugin.bat <uproject>`** — propagates plugin source.
3. **`Build.bat <ProjectName>Editor Win64 Development -project="<uproject>" -WaitMutex`** — compiles against D111 link-time fixes.
4. **Editor relaunch + Claude Code restart** — picks up new ESM modules + fresh DLL.

Without this: fix exists in git but doesn't run. **D87 framing**: "code committed + tests green ≠ fix is live" — extended per D111 to "+ build clean against real UE."

### Verification cycle split (per D114 advisor #6 framing)
For investigation-style workers: VERIFIED-BY-TEST (wire-mock contract regression-guard) / PENDING-DEPLOYMENT (sync+Build cycle) / PENDING-LIVE-SMOKE (instrumentation IS the regression test). Empirically-cheapest verification chain when no new perf scaffolding is needed.

### Parallel-worker collision patterns (per `feedback_parallel_subworker_shared_config_collision.md` D96/D115 memory)
3 codified patterns for N-parallel-worker dispatches sharing config files:
1. **Shard-upfront** (M5-PREP precedent) — pre-land empty-loop / lambda-factory scaffold.
2. **Sequence-landings** — first-lander owns shared-file infra; second-lander rebases atop.
3. **Skip-when-in-flight** (D117 grooming-worker precedent) — receiving worker explicitly skips shared file if observed in-flight.

For tools.yaml across unrelated workers: option 3 is most pragmatic.

### UE 5.6 institutional memory (~30+ items)
Per D78/D81/D87/D88/D93/D96/D102/D105/D106/D107/D110/D111/D112/D114/D115/D119/D120 D-log entries. Highlights:
- **D88**: `FObjectThumbnail` has TWO buffer fields; `AccessCompressedImageData()` has NO lazy-encode.
- **D107**: `IPythonScriptPlugin::Get()` returns nullptr if module not loaded; `IsPythonAvailable()` further checks runtime init.
- **D110**: **Blutility is NOT a plugin — it's an engine MODULE** (Build.cs only, NOT .uproject Plugins[]).
- **D112**: AR canonical BP enumerator pattern; `FAssetData::PackageName` lightest accessor; editor AR always populated post-startup.
- **D115**: `PostEditChangeProperty(EPropertyChangeType::ValueSet)` REQUIRED after raw `SetPropertyValue` on CDO for RC cache invalidation; subobject-template callsites EXCLUDED to avoid mid-edit archetype propagation.
- **D119**: `UAnimMontage::UAnimMontage` always pre-inserts an empty DefaultSlot; reuse, don't Add same-named.

For full list: grep risks-and-decisions.md for "**UE 5.6 institutional memory**".

---

## Recent D-log highlights (D108 → D121)

**Phase 3 milestone shape**:
- **D98** M3 milestone complete — all 32 tools live on TCP:55558.
- **D108** M5 milestone complete — 19/19 not-shipped tools shipped across 3 parallel sub-workers; D101 verifier verdict empirically closed.
- **D118** Post-M5 smoke RE-DISPATCH partial — D102 (CLEANUP-M3-FIXES 6/6) + D109/D112 (BP-path resolution 5/5) VERIFIED LIVE; §3-§6 DEFERRED due to engine WebRemoteControl crash (NEW-2). 2 new bugs surfaced + 3 sharpenings flagged. **CRITICAL ORCHESTRATION ERROR**: prior openers cited wrong project path (codified in memory).
- **D119** NEW-1 fix shipped (commit `633a862`) — conditional slot reuse + defensive fallback per UE 5.6 AnimMontage.cpp:75 constructor pre-insert.
- **D120** NEW-2 audit shipped (commit `a70830d`) — Option A documented operational ceiling; smoke handoff §0.4/§0.5 per-section editor-relaunch convention; UE bug-report drafted. **Connected insight**: 12-second silent log gap before crash aligns with NEW-1's broken-AM_Smoke warning spam — hypothesis: NEW-1 fix MAY incidentally extend NEW-2 ceiling (free retest in next smoke).
- **D121** D118 SHARPENINGS BUNDLE shipped (commit `c860abc`) — per-tool timeout override + 3 stale tcp-55557 refs cleaned + smoke handoff §3 fixture-seeding. **3-of-3 D118 follow-on triage closed**.
- **D122** Post-M5 smoke RE-REDISPATCH partial — §0 + §1.0 + §1 PASS (D109/D112 + D102 close empirically; D121 SHARPENING #1 + D114 WIDGETS-PERF + D88 JPEG mime verified live); §2 PARTIAL (`create_montage` permission denial — opener-template defect, structurally fixed via NDA-gate scope clarification + new `feedback_nda_gate_scope.md` memory); §3-§6 deferred (NEW-2 crash). **D120 hypothesis EMPIRICALLY FALSIFIED** — NEW-2 reproduced at lower call count (~25 vs ~40) WITHOUT broken-asset trigger. Comprehensive D2 + D3 plan kicked off: UEMCP-side NEW-2 mitigation worker queued; auto-codename worker queued; UDN bug-report doc landed for filing; CLAUDE.md §Public-Repo Hygiene + §Operational Limits revised; forbidden-tokens block-list refreshed (added third-target + Project-A wrapper codenames).

For full D77→D122 narrative: read `docs/tracking/risks-and-decisions.md` directly.

---

## Verification layers (what each catches)

| Layer | Catches | Cost |
|---|---|---|
| **Wire-mock automation** (~1900 assertions per D117) | shape contracts, name translation, error normalization | ~10-30s per rotation |
| **Audit** (D79 pattern) | code review findings, invariant violations, ergonomic gaps | 1-2 sessions per audit |
| **Integration smoke** (D77/D86/D118 patterns) | game-thread asserts, render-thread issues, UE API drift, deployment gaps, real composition | 30-60 min human time |
| **Streamlined gauntlet at smoke-tail** (D100) | scope-aliasing patterns the focused per-§ smoke might miss | ~30 min worker time at smoke-tail |
| **User-driven diagnostic** (D88 / D118 patterns) | wrong-root-cause theories from earlier layers | Variable; high cognitive cost |

**Rule** for orchestrator: don't trust worker self-reports as final word on live correctness. Wire-mock + commit ≠ deployed + working. The validation cycle is load-bearing.

---

## Phase 3 progress + remaining (clean table — supersedes the cluttered table in the prior state doc)

| Wave / Milestone | Status |
|---|---|
| Wave 1 (M1 + M-spatial + Oracle-A/v2) | ✅ Shipped |
| Wave 2 (S-B-base + Verb-surface) | ✅ Shipped |
| Wave 3 (M-enhance HYBRID + Phase 4 absorbed) | ✅ Shipped |
| Validation cycle (audit + T-1b + smoke + audit-fixes 1/2/3 + SMOKE-FIX + deployment) | ✅ Complete |
| M3 milestone (3 sub-workers — actors + BP-write + widgets) | ✅ COMPLETE (D98) |
| M4 reduced reads | ❌ SUPERSEDED (D95) — absorbed under M-enhance |
| M5 milestone (3 sub-workers — animation+materials + input+geometry + editor-utility) | ✅ COMPLETE (D108) |
| Post-M5 smoke (re-dispatch + re-redispatch + re-re-redispatch) | ⏸ PARTIAL per D118 + D122 (§1.0 + §1 PASS empirically; §2 BLOCKED on opener-defect + NEW-2 crash; §3-§6 awaiting next-cycle re-dispatch) |
| TCP:55557 formal retirement | ⏸ Gated on Post-M5 smoke clearing §3-§6 + NEW-2 doesn't reproduce/extends ceiling |

**Phase 3 primary dispatch surface**: ALL milestones complete except final smoke verification + NEW-2 mitigation. **2-3 worker dispatches + 2 deploy cycles away** (was "one deploy cycle" pre-D122).

---

## Quick-start checklist for new orchestrator session

1. Read this doc (you are here).
2. `git -C /d/DevTools/UEMCP log --oneline -20` — last 20 commits ground you in recent flow.
3. Read CLAUDE.md §Current State + §Onboarding + §Shell & Tooling + §Public-Repo Hygiene §Multi-agent orchestration handoff convention + §Operational Limits (D120 added).
4. Read `docs/tracking/risks-and-decisions.md` D119-D121 (last 3 entries — the close-out triage).
5. Read MEMORY.md index + the 13 feedback/project memory files (especially `project_corrected_deploy_target_path.md` for the path-correction + `feedback_predispatch_deploy_state_check.md` for the verification rule + `feedback_pre_commit_codename_scrub.md` for the grep discipline).
6. List session-local handoffs: `ls docs/handoffs/*.md | head -30` (gitignored — primary source-of-truth is what each handoff path documents in this doc above).
7. **Default first action**: confirm test baseline via `cd server && node run-rotation.mjs --include-live-gated` (per D116 runner). Should land ~1900 with full fixtures or ~1280-1320 without UNREAL_PROJECT_ROOT. If different from expected: investigate before dispatching.
8. **Default first dispatch (post-D122)**: drafts of TWO worker openers exist in chat history at the D122 close-out turn — auto-codename-registration (D3) + UEMCP-side NEW-2 mitigation (D2 (b)). Either can dispatch first; auto-codename has lower regression risk (.bat-only). After both ship + Noah deploys + UDN filed: re-dispatch Post-M5 smoke with tightened relaunch + §0.5 instrumentation + §3.5 third-target stress + standing-policy NDA-scope line. After smoke clears: dispatch TCP:55557 client-deletion cleanup worker.

---

## File pointers (where things are)

```
D:\DevTools\UEMCP\
├── README.md                              ← public-facing onboarding
├── CLAUDE.md                              ← project-state snapshot + design rules
├── tools.yaml                             ← single source of truth for ~120 tools (D44)
├── setup-uemcp.bat                        ← new-machine onboarding (GUI/arg + D110 plugin-deps)
├── sync-plugin.bat                        ← propagate plugin to target project
├── test-uemcp-gate.bat                    ← D57 commandlet gate verifier
├── server/                                ← Node.js MCP server (.mjs)
│   ├── server.mjs                         ← entry point; TOOLSET_TIPS; tool registration
│   ├── offline-tools.mjs                  ← Verb-surface + S-B-base + offline read tools
│   ├── uasset-parser.mjs                  ← byte-level .uasset/.umap parser
│   ├── connection-manager.mjs             ← 4-layer transport + per-tool timeout overrides (D121)
│   ├── tcp-tools.mjs                      ← Phase 2 TCP tool handlers (legacy; mostly emptied post-M3)
│   ├── menhance-tcp-tools.mjs             ← M-enhance FULL-TCP handlers (10 tools)
│   ├── rc-tools.mjs + rc-url-translator   ← M-enhance FULL-RC + PARTIAL-RC handlers
│   ├── actors-tcp-tools.mjs               ← M3-actors (10 tools)
│   ├── blueprints-write-tcp-tools.mjs     ← M3-bpw (15 tools)
│   ├── widgets-tcp-tools.mjs              ← M3-widgets (7 tools) + WIDGETS_TIMEOUT_OVERRIDES (D121)
│   ├── m5-{animation,materials,input-pie,geometry,editor-utility}-tools.mjs ← M5 toolsets (D105/D106/D107)
│   ├── tool-index.mjs + toolset-manager.mjs
│   ├── test-fixtures.mjs                  ← T-1b shared synthetic-fixture helpers
│   ├── run-rotation.mjs                   ← D116 ROTATION-RUNNER fail-loud aggregator
│   └── test-*.mjs                         ← ~19 test files, ~1900 assertions with full fixtures
├── plugin/UEMCP/                          ← C++ UE5 editor plugin
│   └── Source/UEMCP/
│       ├── Public/                        ← exported headers (per-toolset *Handlers.h pairs)
│       └── Private/
│           ├── UEMCPModule.cpp            ← StartupModule + D57 commandlet gate
│           ├── MCPServerRunnable.cpp      ← TCP:55558 listener
│           ├── MCPCommandRegistry.cpp     ← handler dispatch (D90 ownership pattern)
│           ├── MCPThreadMarshal.{h,cpp}   ← AUDIT-FIX-1 marshaling helper (D83)
│           ├── BlueprintLookupHelper.{h,cpp} ← D112 ResolveBlueprintAssetPath() 3-case chain
│           ├── ActorHandlers.cpp          ← M3-actors flat-file (D93)
│           ├── BlueprintHandlers.cpp      ← M3-bpw flat-file (D97)
│           ├── WidgetHandlers.cpp         ← M3-widgets flat-file (D96) + D121 timeouts
│           ├── AnimationHandlers.cpp      ← M5-anim+mat (D105) + D119 single-DefaultSlot fix
│           ├── MaterialsHandlers.cpp      ← M5-anim+mat (D105)
│           ├── InputAndPieHandlers.cpp    ← M5-input+geo (D106)
│           ├── GeometryHandlers.cpp       ← M5-input+geo (D106)
│           ├── EditorUtilityHandlers.cpp  ← M5-editor-util (D107) + 4-layer security
│           ├── VisualCaptureHandler.cpp   ← Bug 4 fix (D88) + JPEG mime fix (D102)
│           ├── ReflectionWalker.cpp + EdgeCaseHandlers.cpp + GraphTraversalHandlers.cpp + DataSourceHandlers.cpp + CompileDiagnosticHandler.cpp
│           ├── SidecarWriter.cpp + SidecarSaveHook.cpp + SidecarMenuHook.cpp
│           └── Commandlets/               ← Oracle-A + sidecar batch + fixtures
└── docs/
    ├── README.md
    ├── specs/                             ← architecture, protocols, design
    ├── plans/                             ← phase plans
    ├── audits/                            ← read-only audit findings (gitignored per D81)
    ├── research/                          ← scope-refresh + feasibility deliverables
    ├── handoffs/                          ← SESSION-LOCAL (gitignored per D81)
    ├── testing/                           ← manual smoke results (gitignored per D81)
    └── tracking/
        ├── risks-and-decisions.md         ← D-log (currently D1-D121)
        ├── backlog.md                     ← in-flight + queued + recently-shipped
        └── orchestrator-state-2026-04-29.md  ← THIS DOC (supersedes -04-25.md, deleted in same commit)
```

---

## Conversation tone + posture (cosmetic but useful)

- User (Noah) prefers tight, structured responses. Short lists > long prose.
- Code blocks for any commands user copy-pastes. Tables for option-comparisons.
- `★ Insight ─────────────────────────────────────` blocks for educational content (orchestrator may be in Learning + Explanatory mode).
- Don't over-invoke advisor on every turn — call out front of substantive decisions.
- Workers are referenced by their role + commit, not by codename or worker ID.
- D-log entries cite root cause + fix + impact, not narrative. Pipe-table format with bold key-finding callouts.

---

## Sign-off

This doc is current as of the D122 commit (Post-M5 smoke RE-REDISPATCH closed; D120 hypothesis falsified; comprehensive D2 + D3 plan kicked off). When you supersede it, drop a successor doc + delete this one in the same commit (preserves single-source-of-truth for orchestrator state).
