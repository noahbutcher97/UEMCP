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


### EN-5 — Reflection-based lint: yaml params ↔ handler param reads
- **Source**: Audit A (post-Agent-10.5 codebase health) §3 insight 2026-04-19
- **Scope**: automated lint that, for each offline tool's handler case in `executeOfflineTool`, verifies every `params.<X>` read has a matching declaration in the tool's yaml `params:` block. Generalizes D44's structural invariant from a one-time-refactor into a maintained guarantee. Would have caught F-2 + F-3 (Pre-Phase-3 Fixes Worker items) automatically.
- **Implementation sketch**: parse `offline-tools.mjs` via a lightweight JS AST walk; per switch-case, grep for `params.X` accesses; cross-reference against the tool's yaml entry. Lint fails if any read is undeclared. Run as part of test rotation.
- **Cost**: 1-2 agent sessions. Most of the cost is AST walking + handling edge cases (destructuring, alias chains).
- **Trigger**: after the next time a yaml↔handler param drift is caught by manual testing or audit. If F-2/F-3 class issues recur, promote.

### EN-8 — External field report (Project A VFX audit): 7 offline-tool friction items
- **Source**: real read-only VFX audit of Project A by an LLM agent, 2026-06-18. Full report + repro + suggested patches + acceptance criteria live in the 2026-06-18 field-report package.
- **Follow-on queue**: executed as D183–D186; the D187–D190 numbers in `docs/superpowers/plans/2026-06-18-live-usage-follow-on-queue.md` were taken by unrelated work — see those D-log rows (`docs/tracking/risks-and-decisions.md`) and the plan's status block for the full correspondence table.
- **Items** (severity in report; status verified 2026-09-14):
  - **P1 (High, OPEN)** `query_asset_registry`: unknown `path` param silently dropped (real param is `path_prefix`) -> whole-project scan; default `limit:200` x full metadata overflows context. Not shipped: no unknown-param rejection or `path`→`path_prefix` alias exists (`server/zod-builder.mjs`, `server/create-uemcp-server.mjs`), `attach_project` still only accepts `project_root`/snake_case (`tools.yaml`, `server/project-tools.mjs` `projectRoot` there is an output field, not an input alias), and `limit` default is still 200 (`tools.yaml`). D183's plan scope covered this hardening but the shipped D183 row only restored montage/sequence reads.
  - **P2 (High, PARTLY)** `read_asset_properties`: nested component/subobject exports returned as opaque `{kind:"export"}` refs; can't reach a GAS GE's GameplayCue/component contents in one call. Shipped: D186's opt-in `include_subobjects` traversal — nested export rows, per-subobject decode status, `present_but_undecoded` marker. Not shipped: the GAS-specific `FGameplayEffectCue`/GEComponent layout decode this item asked for (no `GameplayEffectCue` reference anywhere in `server/` or the plugin).
  - **P3 (High, OPEN)** surface gap: no project-wide reverse-reference / call-site search; "who calls X" forced raw byte-grep over `.uasset`. Not shipped: `get_asset_references` is still not `initially_visible` in `tools.yaml` (unlike `get_datatable_contents` next to it), and no reverse-reference offline path or project-wide `find_blueprint_nodes`-over-`path_prefix` tool exists. The actual D187 row shipped the live-oracle freshness gate instead — a different topic that happened to land under the same number.
  - **P4 (Med, PARTLY)** `read_asset_properties` is CDO-only -> misses SCS NiagaraComponent subobjects + in-graph `SpawnSystem` nodes. Shipped: D186's `include_subobjects` reaches Blueprint generated-class component templates. Not shipped: a union "runtime spawn/reference summary" tool or documented 3-tool recipe for `SpawnSystem*` graph nodes.
  - **P5 (Med, PARTLY)** `find_blueprint_nodes` excludes `MakeStruct`/`BreakStruct` (+ no exec trace). Shipped: D184's pin-default literal readback on `bp_show_node`. Not shipped: `find_blueprint_nodes` still explicitly documents `BreakStruct`/`MakeStruct` as "counted in nodes_out_of_skeletal ... but not returned" (`tools.yaml`) — the graduation never landed.
  - **P6 (Low, OPEN)** param-name inconsistency (`asset_path` vs `path_prefix`; camelCase `assetPath` rejected). No aliases found in `tools.yaml` or the server for either.
  - **P7 (Low, docs, OPEN)** no per-tool `requiresEditor`/`offlineFidelity` hint. `tools.yaml` has zero `offline_fidelity` occurrences; `requires_editor` exists but predates this report by six weeks (added 2026-05-09 per D146), so it isn't evidence this queue shipped the ask.
- **Trigger**: P1, P3, P6, P7 are fully open — next `offline-tools.mjs` / yaml grooming pass for P1/P6/P7; P3 is still the high-value capability gap, prioritize when asset-analysis workflows recur. P2/P4/P5's remaining scope (GAS cue decode, spawn-summary tool, MakeStruct/BreakStruct graduation) share the same trigger.

---

### EN-30 — Data-asset writers and GAS authoring
- **Source**: deferred remainder of EN-7's "defer after this" list. `capture_active_editor_tab` (the first item on that list) shipped as EN-24's `capture_asset_editor` + `list_asset_editor_tabs` (D199), and the older planned `capture_active_editor_tab` entry was deleted from `tools.yaml` (D199).
- **Scope**: data-asset writers with an explicit dirty/save/undo policy, then GAS authoring/codegen — unchanged from EN-7's original ordering (lower destructive surface first).
- **Trigger**: next enhancement round that prioritizes write-surface expansion, or the first workflow that specifically needs data-asset mutation or GAS authoring/codegen.

### EN-31 — Per-project TCP port and the `SetReuseAddr` flag
- **Source**: residual from EN-25, left open when EN-25 closed (D199).
- **Gap**: port 55558 was once answered by a different editor instance on the same machine. EN-25's identity check (`wait_for_editor` refusing a listener whose reported project mismatches the attached one, `EDITOR_PROJECT_MISMATCH`) removes the dangerous outcome of acting on the wrong editor, but there is still no config surface — no per-project port in `.uemcp-targets.json`, `.mcp.json`, or the plugin's `Listen()` — so a second editor (or a headless automation run) still binds the same port and collides.
- **Root cause**: `UEMCPModule.cpp:42` calls `RawSocket->SetReuseAddr(true)` before `Listen()`, so the second bind succeeds instead of failing, and which instance answers a given connection is left up to the OS. Removing the reuse flag would make the second instance fail loudly instead; a per-project port would avoid the collision entirely.
- **Trigger**: when the headless automation runner (WS2, `docs/handoffs/native-test-runner-and-compile-gate.md` step 0.4) needs a port strategy anyway, since it also binds 55558.

### Shipped (see the D-log)
- EN-6b — Dead code in the offline modules — shipped 2026-09 (commit `ce2d8ab`)
- EN-6 — `find_blueprint_nodes_bulk` results[] sort by `match_count` descending — shipped 2026-09 (commit `ef2e964`)
- EN-7 — Next live tool-surface gap: inline viewport screenshot — shipped 2026-06 (D181; `get_viewport_screenshot` is `status: shipped` in `tools.yaml`)
- EN-24 — Asset-editor capture: `capture_asset_editor` + `list_asset_editor_tabs` — shipped 2026-09 (D199)
- EN-25 — PIE-window capture and editor-identity on TCP 55558 — shipped 2026-09 (D199; per-project port residual tracked as EN-31)
- EN-26 — Machine-readable verify-deploy output for the pre-push compile gate — shipped 2026-09 (commit `e07837f`)
- EN-27 — Pre-push compile gate: false NEEDS-DEPLOY after a checkout or merge — shipped 2026-09 (commit `e07837f`; refined by `d42805b`/`1166888`)
- EN-28 — Confine capture output paths to the project directory — shipped 2026-09 (D201)
- EN-29 — Capture tools: close the headless-unreachable coverage — shipped 2026-09 (D201)

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
- ~~**D188 follow-on**~~ — SHIPPED 2026-07-07 per D188 Task 6: `test-s-b-base-differential.mjs` and `test-uasset-parser.mjs` now resolve their real-asset probes via `findContentAsset` discovery at startup instead of hardcoded `/Game/Actors/...` paths, matching `test-phase1.mjs`/`test-verb-surface.mjs`'s prior migration.

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

In flight as of 2026-09-14: nothing dispatched.

The April 2026 dispatches this section tracked have all shipped: M3 (D93 actors, D96 widgets, D97 blueprints-write, D98 milestone complete), M4 (D95 — redirected with no separate implementation once the worker found all 12 scoped reads already shipped via M-enhance/D77), M5 (D101 scope-verifier through D108 milestone complete), D81-SANITIZATION-AUDIT (D89), D81-SANITIZATION-FIXES (D92), CLEANUP-MICRO (D90), SMOKE-FIX (D87), AUDIT-FIX-1/2/3 (D83/D84/D85), and M-enhance (D74-D77).

The 2026-09-09 health-audit remediation design's five workstreams shipped 2026-09-10 through 2026-09-13, mostly via plain commits with no dedicated D-log row: WS1 CLAUDE.md file-layout refresh (commit `9560190`), WS2 native test runner + compile gate (commit `d3928bf`; see EN-26/EN-27 above for the gate follow-ons), WS3 `offline-tools.mjs` split (commits `1162ee4`, `ef2e964`, `7ffc31c`, `ce2d8ab`), WS4 `server/deployment/` intent pass and transaction decomposition (commits `bd5598c`, `67985a9`), and WS5 (D198 WS5a native handler coverage; D197 WS5b closed by measurement with no transport refactor). The separate `editor-capture-and-identity` branch (not part of the health-audit remediation) merged at `1abf12a`, shipping D199 (EN-24/EN-25 above).

Two items from that section were never dispatched and are not recorded as shipped anywhere, so they are kept here rather than dropped: **S-B-overrides** (the UE 5.6↔5.7/5.8 parser-delta follow-on flagged in D70 §7/D91) was never dispatched as a named worker, but its two flagged deltas shipped piecemeal outside that name — the header-layer delta via D166 (5.7 support) and D189 (5.8 export-table gating across 5.3/5.6/5.8), and the K2Node pin-type float-field delta via commit `6195715` (2026-08-28, `FEdGraphPinType`'s trailing `bSerializeAsSinglePrecisionFloat`). The other D91-flagged item, `FText` `HistoryType` additions beyond `None`/`Base`, is still unaddressed — the parser still throws `unsupported FText HistoryType` for anything else (`server/uasset-parser.mjs:1735`). **F-14 (PIE teardown race)** — `UEditorEngine::RequestEndPlayMap` is engine-internal async, so post-request teardown lag past the game-thread-marshaled request path is a real, unresolved race; no D-log row after the April 2026 cluster (D81/D83/D86) revisits it. The other 22 non-top-3 findings from the D79 audit were not individually re-verified in this pass; several of their categories (UE 5.7 drift, PIE teardown) are covered by the two notes above, but the bucket as a whole was not re-audited.

### EN-23 — Baseline measurement instrumentation

- **Source**: 2026-05-03 conversation post-D127. User flagged: "we don't have any measurements for latency or other benchmarks related to our work because we haven't been collecting any."
- **Problem**: orchestrator decisions invoking "no measured bottleneck" arguments are absence-of-evidence, not evidence-of-absence. We've been making transport, caching, and architectural decisions without baseline data.
- **What to instrument** (initial set; status verified 2026-09-14 against `server/connection-manager.mjs`'s `MetricsAggregator`, D140):
  - **SHIPPED** — Per-tool wire latency: TCP request-send → response-received, split into `connect_ms`/`send_ms`/`first_byte_ms`/`response_ms`/`total_ms` — `connection-manager.mjs:362-364`
  - **OPEN** — Editor-side handler duration: dispatch-received → response-built. No C++-side timing exists; the aggregator only sees the wire round-trip.
  - **PARTLY** — Cache layer: aggregate hit/miss counters exist (`connection-manager.mjs:382-383,417-418`); hit rate **by tool**, by-key collision rate, eviction rate, and TTL-vs-actual-stale-time gap do not.
  - **OPEN** — Connection lifecycle: connect-per-command frequency, ECONNREFUSED rate, retry-success rate are not tracked as distinct metrics.
  - **OPEN** — MCP server process: no memory-footprint or tool-toolset-rotation-cost tracking; `total_n`/per-type `n` (`connection-manager.mjs:434-446`, `by_type`) covers cumulative tool-call count only.
- **Where to surface** (status verified 2026-09-14):
  - **OPEN** — Per-call optional `?debug=1` param returning an inline `_metrics` block: not implemented.
  - **SHIPPED** — Aggregate stderr-emit summary every N calls gated by `UEMCP_METRICS_EMIT_EVERY_N`, and JSONL log file gated by `UEMCP_METRICS_LOG` — `connection-manager.mjs:360,404-427`. `getMetrics()` accessor at `connection-manager.mjs:1113`.
  - **OPEN** — On-exit final flush: no `process.on('exit')` handler found in `connection-manager.mjs`; the aggregate only flushes on the N-call cadence.
- **Trigger to dispatch**: (a) before any future "should we change transport / cache strategy / etc." decision, OR (b) when a perf complaint surfaces from agent workflows, OR (c) bundled with the next worker that touches connection-manager.mjs
- **Reference**: `feedback_ai_worker_time_estimates.md` notes that orchestrator estimates have been miscalibrated partly because we lack measurement data to ground them

### EN-22 — Transport architecture revisit (TCP→WebSocket supplement evaluation)

- **Source**: D127-era strategic question on RC plugin retirement (2026-05-02 / 2026-05-03 conversations)
- **Pre-evaluated answer**: hybrid model (option 5) — keep TCP:55558 for synchronous request-response (current model, all 50+ tools unchanged), ADD WebSocket as supplemental layer for editor-initiated event push
- **What event push would buy**:
  - Cache invalidation: editor pushes `BP_X mutated` → connection-manager invalidates cache reactively → W6 worker becomes structurally unnecessary
  - PIE state: editor pushes `pie:running` / `pie:stopped` → no polling between operations
  - Asset registry: editor pushes `asset:created/deleted/renamed` → `query_asset_registry` cache stays coherent
  - Editor readiness: editor pushes `editor:ready` → NEW-9 readiness becomes subscribe-once
  - Long-running ops: editor pushes `op:rename_asset:progress` → NEW-7 silent-success-on-timeout becomes "client knows the call is still running"
- **Cost**: ~600-1200 lines (Node WS client + UE WS server + supplementary mock-seam test infra). Replacement migration would be larger; supplement-only is bounded
- **Why deferred**: don't compound architectural rewrites. RC retirement workstream is active; stacking transport rewrites on top dilutes both efforts. No transport bug currently blocking
- **Triggers for revisit**: (a) cache invalidation worker W6 hits unexpected complexity that push events would dissolve; (b) W1 NEW-9 fix is messier than expected and event-driven readiness would be cleaner; (c) Noah wants real-time push-based agent coordination patterns we can't currently support; (d) UE version upgrade introduces a transport-layer bug that motivates the rewrite anyway
- **Pre-rejected alternatives**: gRPC (competes with `tools.yaml` per D44; UE support limited; solves problems we don't have); named pipes (Windows-only; no measured TCP-latency bottleneck; no forcing function); in-process plugin module (collapses back to "what wire goes between Node MCP-server and editor"; not a real third option)
- **Reference**: 2026-05-03 conversation thread on transport architecture (search `EN-22` in `risks-and-decisions.md` if/when triggered for full design context)
- **2026-09-14**: no trigger has fired. EN-25's identity check (D199, `EDITOR_PROJECT_MISMATCH` in `wait_for_editor`) removed the wrong-editor hazard without push events — it is a refusal rule on the request/response path, not a subscription.

When any dispatched handoff completes and residual items surface, consolidate them here if they're not immediately dispatchable. When a handoff fully ships, **remove it from this section** — completed work belongs in git history, not in the backlog index.

## Bugs / defects

### Fixed
- BUG-1 — `get_datatable_contents` / `get_montage_full` discoverable but not callable through the MCP schema — fixed 2026-05-28 (D173)
- BUG-2 — Four pre-existing quirks surfaced by the WS5a handler tests — fixed 2026-09 (D201): ghost event enabled in place at the two reuse sites that return it unlinked, reported as enabled_ghost (the timer site was never affected: the engine converts a linked ghost); target_pin_info built after the break; vector literal elements validated (LITERAL_TYPE_MISMATCH); add_blueprint_variable_assignment returns COMPILE_FAILED and rolls back
