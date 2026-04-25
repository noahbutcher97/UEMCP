# UEMCP Backlog

> Tracks future-consideration items that aren't currently dispatched as handoffs and aren't load-bearing enough to live in the D-log. Distinct from `risks-and-decisions.md` (which logs decisions) and from `docs/handoffs/` (active dispatches). Without this file, these items would exist only in orchestrator conversation context and evaporate between sessions.
>
> **Maintenance rule**: when an item here gets dispatched as a handoff or folded into a committed plan, **remove it from this file** — it migrates to a real artifact. This file only holds *currently-not-dispatched* items.

---

## Enhancements

New capability proposals not yet scoped. Each has a workflow trigger that would justify prioritization.

### EN-1 — `query_asset_registry.size_field` filter (`min_size_bytes` / `max_size_bytes`)
- **Source**: Agent Workflow Catalog Q4; Noah accepted as "worth queuing" (2026-04-16)
- **Scope**: one yaml param addition; parser already tracks `sizeBytes` — no parser work
- **Enables**: "which assets > 5 MB?", "audit size-optimization candidates"
- **Cost**: ~15-min enhancement worker
- **Trigger**: next enhancement round, fold into M0 yaml grooming, or bundle with whatever post-scope-refresh worker next touches `offline-tools.mjs`

### EN-3 — Agent-infra parity audit workflow
- **Source**: Workflow Catalog §7a amendment (2026-04-16), Noah Q3 — surfaced as a missed workflow category
- **Scope**: tool(s) comparing CLAUDE.md / plugin config / tool coverage / toolset setup between Project A and Project B, reporting drift
- **NOT game-content diff** — about agent-infrastructure symmetry
- **Cost**: open-ended; design work needed before scoping
- **Trigger**: agent-config drift between the two projects starts causing workflow confusion, OR Project B matures enough that parity auditing becomes routine

### EN-4 — Math/comparison K2Node graduations for S-A skeletal
- **Source**: Agent 11.5 Q-2, D48 — explicitly deferred
- **Candidates**: `UK2Node_PromotableOperator`, `UK2Node_CommutativeAssociativeBinaryOperator`, `UK2Node_EnumEquality`, `UK2Node_Select`, `UK2Node_MultiGate`
- **Scope**: extend `find_blueprint_nodes` skeletal set from 13 to ~18 node classes
- **Cost**: per-node UPROPERTY extraction pattern similar to existing skeletal 13
- **Trigger (D48-defined)**: workflow demand for math-operator introspection in BPs


### EN-6 — `find_blueprint_nodes_bulk` results[] sort by `match_count` descending
- **Source**: EN-2 manual testing 2026-04-20 §6 observation (results commit `7758c85`)
- **Current behavior**: `results[]` sorted by path alphabetically. For "which BPs call X most" top-N workflows, callers sort client-side.
- **Scope**: ~1 line change in `offline-tools.mjs` bulk handler — sort `results.sort((a,b) => b.match_count - a.match_count)` before applying pagination
- **Cost**: ~5-10 min enhancement worker; bundle with any future `offline-tools.mjs` pass
- **Trigger**: next enhancement round, or fold into M-cmd/M-alt worker if they touch bulk tool

### EN-5 — Reflection-based lint: yaml params ↔ handler param reads
- **Source**: Audit A (post-Agent-10.5 codebase health) §3 insight 2026-04-19
- **Scope**: automated lint that, for each offline tool's handler case in `executeOfflineTool`, verifies every `params.<X>` read has a matching declaration in the tool's yaml `params:` block. Generalizes D44's structural invariant from a one-time-refactor into a maintained guarantee. Would have caught F-2 + F-3 (Pre-Phase-3 Fixes Worker items) automatically.
- **Implementation sketch**: parse `offline-tools.mjs` via a lightweight JS AST walk; per switch-case, grep for `params.X` accesses; cross-reference against the tool's yaml entry. Lint fails if any read is undeclared. Run as part of test rotation.
- **Cost**: 1-2 agent sessions. Most of the cost is AST walking + handling edge cases (destructuring, alias chains).
- **Trigger**: after the next time a yaml↔handler param drift is caught by manual testing or audit. If F-2/F-3 class issues recur, promote.

---

## Fixture planting

Test-coverage gaps requiring artificial fixtures in Project A / Project B.

### T-1 — Fixture philosophy migration: live project → synthetic / engine fixtures
- **Source**: orchestrator feedback 2026-04-22 after CL-1 fixture-swap surfaced that project-specific fixtures drift as the primary target evolves
- **Principle**: UEMCP is a general UE 5.6 tool; tests shouldn't rely on a static project snapshot. Three fixture tiers apply: (a) **synthetic** — byte-constructed in source, zero drift; (b) **engine-stable** — Engine/Content/*.uasset bytes, stable within UE point release; (c) **project-specific** — dev-time sanity only, not ship-gate.
- ~~**T-1a**~~ — SHIPPED 2026-04-22 per D73 (commit `525d7843`). Approach A (extend existing synthetic helpers) validated.
- **T-1b — engine-fixture audit / migration** (~2-3 sessions per T-1a worker's feasibility assessment, D73). **Priority bumped per D75**: BP_OSControlPoint drift in M-enhance Session 2 is the second such drift event in two cycles (BP_OSPlayerR drifted in D71's CL-1 cycle). Every future session that runs tests against target-project fixtures risks another drift encounter. Scope: `test-phase1.mjs`, `test-query-asset-registry.mjs`, `test-inspect-and-level-actors.mjs`, plus the remaining project-coupled tests in `test-uasset-parser.mjs` (beyond L2.5 which T-1a migrated) and `test-s-b-base-differential.mjs`. Hand-rolling synthetic packages requires ~300-500 bytes of scaffolding per test — **3-5× the effort of T-1a**. Per-test decision: synthetic (tight unit-level) vs engine-stable tier-2 (UE 5.6 Engine/Content/*.uasset as cross-project stable fixture) vs keep project-specific with explicit dev-time-only framing.
- **T-1c — Oracle-A v3 against engine BPs** (larger, deferred): regenerate Oracle-A corpus against Engine/Content/*.uasset for cross-project portability. Only if Project B integration or agent-onboarding friction surfaces pressure. Oracle-A bytes DO benefit from real-world BP complexity; this is a portability-vs-realism tradeoff.
- **Trigger**: any future fixture drift causing test failures, OR Project B onboarding, OR CI enablement for contributors without target-project access.
- **Priority**: T-1a immediate-dispatchable (independent of M-enhance file-wise); T-1b/c deferred.
- **Out of scope**: test-s-b-base-differential.mjs (Oracle-A is inherently commandlet-generated project-specific; acceptable as-is); BP_OSPlayerR sanity references (kept as dev-time specific-knowledge testing per orchestrator guidance).

### FX-1 — TMap BP CDO micro-fixture
- **Source**: Agent 10.5 manual tester Item #1 (2026-04-16)
- **Gap**: no target-project BP CDO holds a `TMap<K,V>`; manual §2.1/§2.3 had to skip live-fixture testing. Synthetic unit tests cover both paths.
- **Disposition**: optional; small maintenance burden for marginal value
- **Trigger**: Project B naturally introduces TMap usage, OR TMap-parse regression surfaces that synthetic tests missed

---

## Deferred research triggers

Research questions explicitly deferred with named reopening conditions. Watch-for items.

### DR-1 — Tier S-B pin tracing offline parser
- **Source**: Agent 11.5 + D48 (original FOLD-INTO-3F verdict) → D55 (updated to PURSUE-AFTER-SIDECAR)
- **Cost**: ~6-9 agent sessions at honest estimate (supersedes Agent 11.5's 8-13; collapsed per D55 FA-1 analysis of 19-type restriction, but with irreducible fixed-cost floors — base pin-block RE + LinkedTo + version-skew buffer)
- **Status**: scheduled as **optional M6** in Phase 3 dispatch sequencing; commissioned only if D52 near-parity goal is under-served by sidecar alone OR agent-automation workflows surface pin-trace pressure
- **Oracle dependency**: sidecar's known-correct `LinkedTo` JSON becomes S-B's validation oracle — commission AFTER M2 ships for ground-truth signal
- **Reopening (per D52)**: workflow pressure accumulates OR 3F sidecar slips (weakened from D48's AND requirement)
- **State**: not in current dispatch window; M6 stays optional unless signal emerges

### DR-2 — L3A full-fidelity UEdGraph byte parsing
- **Source**: Agent 11, D45 — permanently EDITOR-ONLY
- **State**: locked by D45; 3F sidecar is the canonical offline-read path
- **Reopening**: architectural shift — CUE4Parse ports K2Node readers, OR UE editor-side serialization stabilizes enough to reverse-engineer at reasonable cost
- **State today**: no action expected

---

## Currently-known-issues not in this file

These items ARE dispatched (handoffs exist) so they're NOT tracked here. Per the maintenance rule above, completed handoffs are removed once they ship — this section only lists in-flight or actively-pending dispatches.

In-flight as of 2026-04-25 (SMOKE-FIX shipped; M3 + M4 dispatchable; M5 waits on Bug 4 follow-up):

- (none currently in flight)

**Wave 4 dispatch readiness updated post-D87**:
- **M3 + M4 dispatchable NOW** — neither depends on visual-capture; deployment cycle (sync-plugin.bat + Build.bat + relaunch) needed for Bugs 1 / 3-thread / 4-crash to close end-to-end (those are deployment gaps, not code defects per D87).
- **M5 WAIT** — includes visual-capture toolset; depends on Bug 4 follow-up (thumbnail empty post-marshal) landing first.

**D81 sanitization-regression audit + fix queue** (dispatchable now; parallel-safe with deployment-cycle work):
- **D81-SANITIZATION-AUDIT** — handoff `docs/handoffs/d81-sanitization-regression-audit.md` (session-local per gitignore). 0.5-1 session. Read-only audit producing findings doc at `docs/audits/d81-sanitization-regressions-2026-04-25.md`. Triggered by user-flagged test-uemcp-gate.bat regression (commit `66bf214` was a targeted-tactical fix; this audit scans for the rest).
- **D81-SANITIZATION-FIXES** — handoff `docs/handoffs/d81-sanitization-fixes-worker.md` (session-local). 0.5-1.5 sessions. Hard-gated on audit landing. Implements per-finding fixes + verifies all repo-root `.bat` scripts comply with CLAUDE.md §.bat convention. Must not re-introduce codenames (D82 gate blocks).

**Pending micro-fix candidates** (size-of-finding doesn't justify own audit-batch wave; queue for next plugin C++ pass):
- **Thumbnail empty-result follow-up**: `ThumbnailTools::RenderThumbnail` returns empty bytes post-marshal for both StaticMesh + Blueprint. Worker theory: UE 5.6 render commands queue async; `AccessCompressedImageData` reads before pixels written. Fix sketch: `FlushRenderingCommands()` after RenderThumbnail OR `EThumbnailTextureFlushMode::ConditionallyFlush` mode. ~30 min worker scope.
- **MCPThreadMarshal use-after-free latent defect**: `RunOnGameThread` captures `handler/Params/OutResponse` by reference; on 30s GT_TIMEOUT path the worker thread unwinds while the queued AsyncTask can still fire, dereferencing freed stack memory. Doesn't trigger in steady-state but is a real hazard. Fix: capture by value or shared_ptr. ~30-45 min.
- **rc_passthrough body Zod-validation**: structured-object body param arrives stringified via MCP wire. Either schema accepts both shapes (`z.union([z.record(z.any()), z.string()])` with parse-on-string), OR description warns callers to pre-stringify. ~15 min.

**HIGH-PRIORITY SMOKE-FIX dispatchable** — handoff `docs/handoffs/smoke-fix-thread-and-identifier-bugs.md`. **Blocks Wave 4 dispatch.** 5 plugin bugs from human-integration-smoke 2026-04-25 (D86):
- **Bug 1 BLOCKER**: `bp_compile_and_report` editor crash (IsInAsyncLoadingThread assert)
- **Bug 2 MEDIUM**: `rc_list_objects` HTTP 404 (UE 5.6 removed `/remote/object/list`)
- **Bug 3 LOW-MED**: `get_blueprint_*` log spam + partial results on cold BPs (same thread-class as Bug 1 + missing `_C` suffix)
- **Bug 4 BLOCKER**: `get_asset_preview_render` editor crash (IsInGameThread assert)
- **Bug 5 MEDIUM**: `bp_trace_exec` node_not_found from `bp_list_entry_points` output

**3 of 5 are RECURRENCES** of audit findings believed shipped (D83 AUDIT-FIX-1 thread marshaling — Bugs 1+3+4; D85 AUDIT-FIX-3 NodeGuid bridge — Bug 5). SMOKE-FIX worker's first task: root-cause why marshaling/bridge didn't catch these handlers' code paths. 1-2 sessions expected.

**Two §Reporting-back items deferred** (FA-ε §Open 3 cross-transport transaction + M-enhance §Biggest-unknowns 4 PIE teardown race) — pending follow-up smoke pass after SMOKE-FIX lands.

**Audit-triage follow-on history**:
- ~~**AUDIT-FIX-1**~~ — SHIPPED 2026-04-24 per D83. **PARTIALLY EFFECTIVE per D86 smoke** — Bugs 1+3+4 prove marshaling didn't cover all handler code paths.
- ~~**AUDIT-FIX-2**~~ — SHIPPED 2026-04-24 per D84. Bug 2 is a separate UE-5.6-API drift, not an AUDIT-FIX-2 regression.
- ~~**AUDIT-FIX-3**~~ — SHIPPED 2026-04-24 per D85. **PARTIALLY EFFECTIVE per D86 smoke** — Bug 5 proves bridge didn't catch the live `bp_list_entry_points → bp_trace_exec` composition path.

**F-14 PIE teardown race upgraded from open-item → first-class follow-on**: per D81 hint, AUDIT-FIX-1's game-thread marshaling fixes the REQUEST side but `UEditorEngine::RequestEndPlayMap` is engine-internal async — post-request teardown lag remains a real race. Flag for future PIE-adjacent tool work. Not blocking Wave 4 but queue if PIE workflows become important.

**New institutional-memory hazard captured in D81**: Edit tool drops multi-line edits silently on CRLF-encoded files in plugin/UEMCP/ tree. Every future C++ plugin worker must `git diff` after each Edit OR use Write for full rewrites. Will surface in next audit pass if any plugin worker hits it again.

File-collision analysis: zero overlap across the three. All three dispatchable in parallel.

**Remaining user-action item**: integration smoke test resume at Step 2 (editor launch) per `docs/testing/human-integration-smoke-2026-04-24.md`. Plugin compile now clean post-D78.

**Remaining audit findings** (22 not in the top-3 batch): queued for post-fix audit-fix second wave. Categories: D44 yaml-RC drift (F-9), SidecarWriter atomic-write (F-3), heuristic-filter refinement, response-size cap on reflection_walk, PARTIAL-RC commit/collapse decision, cross-transport transaction semantics untested, PIE teardown race root-cause, UE 5.7 drift candidates. None blocking Wave 4.

**Phase 3 milestone**: **Wave 3 (M-enhance) ship-complete** per D77 — 4 sessions, 9 commits, 36 agent-facing MCP tools + 16 plugin C++ handlers + HTTP:30010 RC transport + save-hook + Content Browser menu + batch commandlet. Test baseline 1037 → 1203 passing. Waves 1 + 2 + 3 all shipped; Phase 3 ~60-70% complete by session count (M3 + M4 + M5 remain, ~15-25 sessions estimated).

**User-action: integration smoke test** (orthogonal to next dispatch; all paths ready per D77):
1. Close editor → `sync-plugin.bat "path\to\YourProject\YourProject.uproject"` → `Build.bat YourProjectEditor Win64 Development -project=...`
2. Open editor → save a BP → verify `<Project>/Saved/UEMCP/<pkg>.sidecar.json` materializes with `narrow-sidecar-v1` schema
3. Right-click BP in Content Browser → see "Regenerate UEMCP Sidecar" item → click shows confirmation dialog
4. `UnrealEditor-Cmd.exe <uproject> -run=DumpBPSidecar -PathRoot=/Game/Blueprints -Recursive -unattended -nop4` → batch-emits sidecars
5. MCP `get_asset_preview_render` against `/Game/Meshes/SM_Cube` → returns inline base64 PNG thumbnail
6. Naturally verifies FA-ε §Open 3 (cross-transport transaction semantics) + M-enhance handoff §Biggest-unknowns 4 (PIE teardown race)

**Pre-drafted, NOT yet dispatched**:
- **M-enhance** — full handoff at `docs/handoffs/m-enhance-hybrid-transport.md` (commit `d315f4b`). HYBRID transport scope per D66 (RC HTTP + plugin TCP split rule). 3-5 sessions, 6 prescriptive checkpoints. Phase 4 absorbed into this worker (8 rc_* primitives ship inside). Content-wise independent of S-B-base; dispatches after Verb-surface completes (`server/offline-tools.mjs` collision). Test baseline: 1034 per D71.
- **S-B-overrides** (not drafted) — 1.5-2 session worker per D58. UE 5.6↔5.7 delta buffer (hints from D70 §7: watch `FEdGraphPinType.Serialize`'s trailing bool `bSerializeAsSinglePrecisionFloat`; verify FText HistoryType enum additions). Touches `server/uasset-parser.mjs`. Lower priority until the secondary target materializes on 5.7.

Recently shipped (most recent first):

- **SMOKE-FIX** (commit `151ae4d`, 2026-04-25) — D87. 4/5 smoke-surfaced bugs CLOSED end-to-end. Critical finding: 3 "recurrences" in D86 weren't recurrences — they were deployment gaps (project-local plugin tree + MCP server process never picked up D83/D85 code). AUDIT-FIX-1 + AUDIT-FIX-3 were always correct. Real code fixes shipped: ReflectionWalker `_C` suffix normalization (Bug 3 path-half), rc_list_objects via `/remote/search/assets` (Bug 2), exhaustive 8-entry-point Bug 5 regression. Test rotation 1338 → 1381 passing across 12 files. New follow-up: thumbnail-empty post-marshal (Bug 4 second-order finding). New latent defect flagged: MCPThreadMarshal use-after-free on GT_TIMEOUT path.
- **AUDIT-FIX-3 NodeGuid input bridge** (commit `7edd55d`, 2026-04-24) — D85. 3 handlers normalized via lookup-by-success pattern (bp_trace_exec, bp_trace_data, bp_neighbors). bp_show_node + bp_subgraph_in_comment correctly disambiguated as not-applicable (export_index / objectName, not NodeGuid). F-21 fallback removed in bpShowNode (D70 invariant: cross-graph NodeGuid scan can return wrong-graph node; degrades to FA-β not_available envelope). Behavior change: handler responses now echo canonical form, not raw input. Test rotation 1338 passing / 0 failing.
- **AUDIT-FIX-2 RC semantic delegate expansion + toCdoPath fix** (commit `c512df2`, 2026-04-24) — D84. F-4 get_curve_asset (Float/Vector/LinearColor curve dispatch via describe-probe), F-5 get_mesh_info (5 UFUNCTIONs batched), F-6 list_material_parameters (scalar/vector/texture info-only), F-7 toCdoPath heuristic (only append `:Default__<>` when path ends in `_C`). test-rc-wire.mjs 72 → 110 (+38). Yaml descriptions narrowed to match implementation per D44 invariant.
- **AUDIT-FIX-1 plugin thread-safety marshaling** (commit `4cc6275`+`67f8efb`, 2026-04-24) — D83 (was D81 before deconflict). — D81. All 18 plugin C++ handlers game-thread-marshaled via new MCPThreadMarshal helper. `RunOnGameThread` + 30s timeout + GT_TIMEOUT envelope + per-call wall-clock instrumentation. Test baseline unchanged (C++-only). Three worker hints captured: F-14 PIE teardown race still UNRESOLVED (engine-internal async beyond request-side marshaling); Edit tool silently drops multi-line edits on CRLF files in plugin/UEMCP/ tree (verify via git diff); Async/Future.h canonical UE 5.6 path (not Templates/Future.h).
- **T-1b fixture-philosophy migration** (commit `3c7d4a9`, 2026-04-24) — D80. 4 test files migrated via shared `server/test-fixtures.mjs` module; ~80% drift-surface reduction (10 → 2 centralised named constants). test-phase1.mjs 316 → 318 (+2 bootstrap-probe assertions). `offline-tools.resolveAssetDiskPath` `/Engine/` path support flagged as T-1c prereq. No CL-1-style follow-ons.
- **Phase 3 post-M-enhance audit** (commit `a9f5f0d`, 2026-04-24) — D79. 29 findings (7 high / 11 medium / 11 low). Top 3 high: F-1 plugin thread-safety marshaling, F-2+F-21 NodeGuid input bridge, F-4+F-5+F-6+F-7 RC semantic-delegate placeholder bodies. Follow-on queue: 3 parallel-safe fix workers dispatchable now.
- **Integration-smoke compile fixes** (commit `15b97f9`, 2026-04-24) — D78. 3 UE 5.6 API drifts patched in CP3 + S4-3 plugin C++: `UUserDefinedStruct` moved Engine→CoreUObject/StructUtils; `FObjectThumbnail` in Misc/ not UObject/; `AccessCompressedImageData` not `GetCompressedImageData`. Plugin compile clean post-fix.
- **M-enhance ship-complete across 4 sessions** (commits `12b1a13` → `7e91e1d` → `ca479f7` → `1e811b7` → `0964cd9` → `576d69b` → `dc41193` → `a503372` → `69496a9`, 2026-04-22 / 2026-04-23) — D74 / D75 / D76 / D77. **36 agent-facing MCP tools** (11 FULL-RC + 10 FULL-TCP + 13 PARTIAL-RC + 1 sidecar + 1 visual-capture), **16 plugin C++ command handlers** on TCP:55558, HTTP:30010 RC transport (Phase 4 fully absorbed per D66), OnObjectPreSave save-hook, Content Browser "Regenerate UEMCP Sidecar" context menu, `DumpBPSidecarCommandlet` batch emitter, `narrow-sidecar-v1` schema, 8 TOOLSET_TIPS entries. Test baseline 1037 → **1203 passing / 0 failing** across 10 files (+166). Pragmatic visual-capture shortcut via ThumbnailTools (full FPreviewScene deferred — noted in tool description). UE 5.6 API findings preserved: OnObjectPreSave vs deprecated OnObjectSaved; FContentBrowserMenuExtender_SelectedAssets handle via Extenders.Last().GetHandle(); FUObjectToken in Misc/UObjectToken.h (not TokenizedMessage.h).
- **T-1a L2.5 synthetic fixture migration** (commit `525d7843`, 2026-04-22) — D73. Vikram proto live-fixture dependency removed from `test-uasset-parser.mjs` L2.5; replaced via Approach A (extended existing synthetic helpers). 7→7 assertion count (zero shift). Test rotation 1037 passing / 0 failing. First validated fixture-philosophy migration; T-1b+ feasibility note captured in T-1 entry below.
- **M-new Verb-surface** (commits `aa131cd` core + `8acd0b9` test-phase1 placeholder refresh, 2026-04-22) — D72. 5 verbs ship offline-primary: bp_trace_exec, bp_trace_data, bp_neighbors edge mode, plus M-new extensions to bp_show_node (pins populated) and bp_list_entry_points (has_no_exec_in precision). Test baseline 1034 → **1052 passing / 0 failing**. +83 assertions in new test-verb-surface.mjs suite; net +3 in test-phase1.mjs (−4 M-spatial placeholders + 7 M-new confirmations). Oracle-cross-check on 3 fixtures (BP_OSPlayerR, BP_OSControlPoint, TestCharacter). Two format gotchas discovered + handled: PinCategory not captured in pin-block (name-convention classifier with documented Default false-positive risk); NodeGuid format mismatch M-spatial LE-lowercase vs topology BE-uppercase-per-uint32 (bridged via `toOracleHexGuid` helper at verb handler edge). Scope-deviation flagged + landed-correctly (touched test-phase1.mjs post-CL-1 for placeholder refresh; zero collision risk; separate commit for reversibility). BP-subclass variance gap flagged for S-B-overrides: UWidgetBlueprint/UAnimBP not in corpus yet.
- **CL-1 test-drift refresh** (commit `1f0dd69`, 2026-04-22) — D71. Pre-existing drift failures on `test-phase1.mjs` (3) + `test-uasset-parser.mjs` (4) cleared: threshold drop 500→300 on P2 (size_budget_exceeded marker) cascaded 3 asserts; fixture swap to sibling `BP_OSPlayerR_VikramProto` for L2.5 TArray<ObjectProperty> decode (BP_OSPlayerR lost DefaultAbilities/DefaultEffects in gameplay refactor — content-side observation, not UEMCP regression). Test count 1027→1034 passing, 0 failing across 9 files. CL-2 CLAUDE.md bookkeeping also folded inline this session.
- **M-new S-B-base offline edge-topology parser** (commits `cdf951b`+`e35f431`+`3c355fe`+`9250121`, 2026-04-22) — D70. Critical path for D52 edge-topology offline near-parity **complete**. 962/962 edges match (100%) via pure ID-match on all 6 Oracle-A-v2 fixtures. Shipped in 3 sessions (under 4-6 estimate). `extractBPEdgeTopologySafe()` exported from `offline-tools.mjs` for Verb-surface consumption. Test baseline **914 → ~1034** (+120: 36 CP1 + 16 CP2 + 68 differential). Corrects D67/D68 root-cause framing — the Session 1 "blocker" was worker's own test-harness map-collision bug using lossy NodeGuid-only keys; corrected to (graph_name, node_guid, pin_id) triple keying. Name-fallback architecturally present (Oracle-A-v2 emit) but unused at runtime — safety net for future format drifts. **Critical invariants for downstream consumers**: NodeGuids non-unique across sibling UEdGraphs; self-loops preserved; bNullPtr/bOrphanedPin pins pre-filtered; 4-byte int32 sentinel=0 between UPROPERTY terminator and pin trailer (undocumented).
- **M-new Oracle-A-v2 pin-name amendment** (commit `b8ea754`, 2026-04-22) — D69. 9 files, 1603+/14− (fixture-regen dominated). Plugin compile clean after transient PCH-VM retry. All 6 fixtures regenerated with `name` field populated per pin; `pin_id` preserved as primary key; schema bumped `oracle-a-v1` → `oracle-a-v2`. Pin names for BP_OSPlayerR ApplyVFX_Niagara FunctionEntry empirically validated D68 theory: 13 names emitted match current function signature (`then, AuraSystem, Lifetime, SpawnRate, SpawnRate2, SpawnCount, ManualScale, Emissive, Opacity, MaterialInterface1-4`); parser's 23 disk pins include 10 stale-signature entries. D57 gate [PASS] preserved.
- **FA-ε M-enhance transport research** (commit `56ff6f6`, 2026-04-21) — 404-line decision document at `docs/research/fa-epsilon-tcp-vs-rc-2026-04-21.md`. Verdict: HYBRID (RC HTTP for flat reflection + metadata allowlist subset; TCP for compile diagnostics / UEdGraph walks / compiled-state / editor-static). **Phase 4 as a scheduled milestone absorbed into M-enhance**; D23 Layer 4 semantic allocation persists. Aggregate Phase 3 delta: −2 to −4 sessions. Full context in D66.
- **UEMCPModule log-demotion** (commit `60bb94a`, 2026-04-21) — D61 follow-on closed. Warning → Log demote at `UEMCPModule.cpp` StartupModule. Clean rebuild via D61 nuke recipe (12.19s, 16 actions); DLL mtime post source mtime confirmed no UBT cache staleness; D57 gate re-run [PASS]. Baseline unchanged. D65 for full report.
- **sync-plugin.bat** (commit `117b7d9`, 2026-04-21) — D61 follow-on closed. 0.59s wall-clock smoke test against the primary target; byte-identical sync; Binaries/Intermediate preserved. Three CMD-parser gotchas patched during implementation (same class as setup-uemcp.bat debug arc; documented in D64). Future plugin workers use `sync-plugin.bat "<uproject>" -y`. D64 for full report.
- **EN-8 + EN-9 bundle** (commit `1bc3e8b`, 2026-04-21) — workflow gaps from M-spatial manual testing closed. `bp_list_graphs` emits `comment_ids: []` per-graph row; all 5 M-spatial verbs return FA-β `{available: false, reason: "asset_not_found"}` on ENOENT. `withAssetExistenceCheck` helper exported for Verb-surface reuse. **Test baseline 899 → 914** (+15 assertions including full-contract helper coverage). Comment class-name confirmed as `EdGraphNode_Comment` (no U prefix — UE strips at serialization). D63 for full report.
- **M-new Oracle-A** (commits `b8e64a5` + `b1fb2e7`, 2026-04-21) — 6-BP fixture corpus seeded (BP_OSPlayerR 204/596 edges densest; TestCharacter 11/24 smallest; BP_OSPlayerR_Child triple for inheritance). 280 LOC commandlet + serializer; 20.66s clean build; 9s cold BP_OSPlayerR invocation; D57 gate regression-tested PASS. **Critical API correction captured in D62**: `UEdGraphPin::LinkedTo` is `TArray<UEdGraphPin*>` runtime / `TArray<FEdGraphPinReference>` bytes — propagated to S-B-base handoff.
- **M1 3A TCP scaffolding** (commits `2b86369` / `8030930` / `be282c0` / `510c5bb` / `d7a2192` / `1d3f6cf`) — plugin/UEMCP/ scaffold with D57 commandlet gate + 6 P0 helpers (P0-1/2/3/4/9/10) + MCPServerRunnable on TCP:55558 + MCPCommandRegistry + ping handler + 8 automation tests + server-side integration test. Unblocks M-new Oracle-A. Response envelope is single-shape `{status, result}` / `{status, error, code}` — deliberate P0-1 break from UnrealMCP (55557)'s two-format legacy. **Pending user verification**: plugin visibility in the target project (mklink /D or AdditionalPluginDirectories), UBT compile, commandlet-gate log line. Test baseline unchanged at 899.
- **M-spatial manual testing** (commit `8ad69bd`) — 18/18 PASS through live MCP wire. FA-β manifest + FA-δ plugin-absent first-class both held. Exact numeric match with unit tests (10 graphs, 53→7 events, 11 contained nodes, 17 entry points, 1424×544 rect) → second independent verification of D50 tagged-fallback UPROPERTY coverage. Workflow gap surfaced: comment-ids not enumerable → EN-8 queued.
- **M-spatial** (commits `08be682` / `4105fa0` / `4938248`) — 5 BP traversal verbs + FA-β/FA-δ test invariants. Zero parser code needed — D50 tagged-fallback already decoded every required UPROPERTY (verified empirically on BP_OSPlayerR). Test baseline 825 → 899 (+74). Notable finding: `EnabledState` absent on nearly all fixture nodes because UE omits class-default values; spatial extraction treats missing positions as 0.

Queued for dispatch per D58 re-sequenced plan (`docs/research/phase3-resequence-mcp-first-2026-04-20.md` §Q5):

**Wave 1** — SHIPPED in full per D59 + D61 + D62. Oracle-A fixtures form the differential-test contract for S-B-base.
- ~~M1 scaffolding~~ — SHIPPED (plugin-compile + D57 gate verified end-to-end per D61, commit `a5b8917`)
- ~~M-spatial + wire validation~~ — SHIPPED
- ~~M-new Oracle-A~~ — SHIPPED (D62, commits `b8e64a5` + `b1fb2e7`). 6-BP fixture corpus at `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/`.

**Wave 2 — S-B core** (post-Oracle-A):

- **M-new S-B-base** (4-6 sessions) — reverse-engineer `UEdGraphNode::Serialize()` pin-block trailer + `FEdGraphPin` LinkedTo walker. Uses Oracle-A output for differential validation. Critical-path for D52 edge-topology offline near-parity.
- **M-new S-B-overrides** (1.5-2 sessions, parallelizes with Verb-surface) — CallFunction backcompat + Switch-variant pin-regeneration + UE 5.6↔5.7 delta buffer.
- **M-new Verb-surface** (1-1.5 sessions) — 5 S-B-dependent verbs (`bp_trace_exec`, `bp_trace_data`, `bp_neighbors` edge mode, `bp_show_node` pin completion, `bp_list_entry_points` precision) in `offline-tools.mjs` + yaml entries + tests.

**Wave 3 — enhancement + writes** (post-M1 + post-M-new):

- **M-enhance** (3-5 sessions) — HYBRID transport per D66/FA-ε verdict: RC HTTP (30010) for flat UPROPERTY/UFUNCTION reads + metadata allowlist subset; TCP (55558) for compile diagnostics / UEdGraph walks / compiled-state / editor-static. Includes narrow sidecar (plugin-only fields), save-hook, 3F-4 production commandlet, editor-menu prime. **Absorbs what was Phase 4** (RC HTTP client infrastructure folds into M-enhance). Parallelizes with M3/M4/M5. Dispatches after S-B-base completes (server/* file-collision constraint; content-wise independent of S-B-base).
- **M3** — oracle retirement (6-10 sessions, 3 sub-workers) — rebuilds 32 transitional tools on 55558 with P0-1 through P0-11 upgrades; absorbs TS-1 + TS-2.
- **M4** — reduced reads (3-5 sessions) — 12 tools from blueprint-read/asset-registry/data-assets. **Under D58**: 3 of the previously-M4 tools (`get_blueprint_graphs`, `get_animbp_graph`, `get_widget_blueprint` EventGraph subset) move to offline-primary via M-new/M-spatial; they stay in M-enhance as enrichment only. M4's reduced-reads list drops to 12 from scope-refresh §Q5.3's 15.
- **M5** — remaining Phase 3 toolsets (6-10 sessions, 3-4 sub-workers) — animation + materials + geometry + input-and-pie + editor-utility + visual-capture. Unchanged from scope-refresh §Q5.3.

**Aggregate**: 26.5-43 sessions post-D66 (original 28.5-47 reduced by 2-4 from Phase 4 absorption into M-enhance); wall-clock ~13-21 with parallelism.

**Open orchestrator calls** (per D58 follow-on items):

- ~~**FA-ε**~~ — RESOLVED by D66 HYBRID verdict 2026-04-21 (commit `56ff6f6`).
- **Scaffold commit timing**: fold into M1 vs separate 0.25-session dispatch — decide when M1 amendment lands.

When any dispatched handoff completes and residual items surface, consolidate them here if they're not immediately dispatchable. When a handoff fully ships, **remove it from this section** — completed work belongs in git history, not in the backlog index.
