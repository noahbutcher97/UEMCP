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
- **Enables**: "which ProjectA assets > 5 MB?", "audit size-optimization candidates"
- **Cost**: ~15-min enhancement worker
- **Trigger**: next enhancement round, fold into M0 yaml grooming, or bundle with whatever post-scope-refresh worker next touches `offline-tools.mjs`

### EN-3 — Agent-infra parity audit workflow
- **Source**: Workflow Catalog §7a amendment (2026-04-16), Noah Q3 — surfaced as a missed workflow category
- **Scope**: tool(s) comparing CLAUDE.md / plugin config / tool coverage / toolset setup between ProjectA and ProjectB, reporting drift
- **NOT game-content diff** — about agent-infrastructure symmetry
- **Cost**: open-ended; design work needed before scoping
- **Trigger**: agent-config drift between the two projects starts causing workflow confusion, OR ProjectB matures enough that parity auditing becomes routine

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

Test-coverage gaps requiring artificial fixtures in ProjectA/ProjectB.

### FX-1 — TMap BP CDO micro-fixture
- **Source**: Agent 10.5 manual tester Item #1 (2026-04-16)
- **Gap**: no ProjectA BP CDO holds a `TMap<K,V>`; manual §2.1/§2.3 had to skip live-fixture testing. Synthetic unit tests cover both paths.
- **Disposition**: optional; small maintenance burden for marginal value
- **Trigger**: ProjectB naturally introduces TMap usage, OR TMap-parse regression surfaces that synthetic tests missed

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

In-flight as of 2026-04-20 (post-re-sequence D58):

- (none currently in flight)

Queued for dispatch per D58 re-sequenced plan (`docs/research/phase3-resequence-mcp-first-2026-04-20.md` §Q5):

**Wave 1 — parallel kickoff** (after tiny scaffold commit lands, per §Q5.7 amendment):

- **Plugin scaffold commit** (~0.25 session) — `plugin/UEMCP/UEMCP.uplugin` + `UEMCP.Build.cs` + `UEMCPModule.{h,cpp}` with `!FApp::IsRunningCommandlet()` gate in `StartupModule`. Can fold into M1's first commit OR dispatch separately. Orchestrator call.
- **M1** — 3A TCP scaffolding (3-5 sessions) — `MCPServerRunnable` + command registry + P0-1/2/3/4/9/10 helpers. Ships `ping` smoke test only; real tool handlers are M3+. Writes-gated; independent of M-new. Handoff already drafted at `docs/handoffs/m1-3a-tcp-scaffolding.md` (commit `2ab0969`) — needs minor amendment to reference D58 scaffold-first ordering.
- **M-spatial** (1-2 sessions, pure JS, NEW milestone per FA-γ) — extract `NodePosX/Y`, `NodeWidth/Height`, `NodeComment`, `EnabledState` UPROPERTYs via existing L1+L2 tag iteration + `UEdGraphNode_Comment` handler + `contains[]` point-in-rect computation. Ships 5 of 9 traversal verbs on today's infra: `bp_list_graphs`, `bp_find_in_graph`, `bp_subgraph_in_comment`, `bp_list_entry_points` (partial), `bp_show_node` (partial without pin block). No TCP, no plugin dependency. Additive to `server/uasset-parser.mjs` + `server/offline-tools.mjs`.
- **M-new Oracle-A** (0.5-1 session) — minimal `UDumpBPGraphCommandlet` dev-only stub emitting `{nodeId: [linkedToPinIds]}` for 5-10 ProjectA fixture BPs. Differential-test oracle for S-B development; ships as test fixture under `plugin/Source/UEMCP/TestFixtures/` (or equivalent). ~120-180 LOC commandlet + ~40 LOC narrow serializer. Dispatches AFTER plugin scaffold lands; parallel with M1 (different subdirectory) and M-spatial (different file tree).

**Wave 2 — S-B core** (post-Oracle-A):

- **M-new S-B-base** (4-6 sessions) — reverse-engineer `UEdGraphNode::Serialize()` pin-block trailer + `FEdGraphPin` LinkedTo walker. Uses Oracle-A output for differential validation. Critical-path for D52 edge-topology offline near-parity.
- **M-new S-B-overrides** (1.5-2 sessions, parallelizes with Verb-surface) — CallFunction backcompat + Switch-variant pin-regeneration + UE 5.6↔5.7 delta buffer.
- **M-new Verb-surface** (1-1.5 sessions) — 5 S-B-dependent verbs (`bp_trace_exec`, `bp_trace_data`, `bp_neighbors` edge mode, `bp_show_node` pin completion, `bp_list_entry_points` precision) in `offline-tools.mjs` + yaml entries + tests.

**Wave 3 — enhancement + writes** (post-M1 + post-M-new):

- **M-enhance** (3-5 sessions) — narrow sidecar (plugin-only fields: compile errors, reflection flags, runtime/compiled derivatives) + save-hook + 3F-4 production commandlet + editor-menu prime + runtime/compile/reflection TCP brokers. Parallelizes with M3/M4/M5. Dispatches in parallel with M-new Wave 2 if M1 + plugin scaffold landed.
- **M3** — oracle retirement (6-10 sessions, 3 sub-workers) — rebuilds 32 transitional tools on 55558 with P0-1 through P0-11 upgrades; absorbs TS-1 + TS-2.
- **M4** — reduced reads (3-5 sessions) — 12 tools from blueprint-read/asset-registry/data-assets. **Under D58**: 3 of the previously-M4 tools (`get_blueprint_graphs`, `get_animbp_graph`, `get_widget_blueprint` EventGraph subset) move to offline-primary via M-new/M-spatial; they stay in M-enhance as enrichment only. M4's reduced-reads list drops to 12 from scope-refresh §Q5.3's 15.
- **M5** — remaining Phase 3 toolsets (6-10 sessions, 3-4 sub-workers) — animation + materials + geometry + input-and-pie + editor-utility + visual-capture. Unchanged from scope-refresh §Q5.3.

**Aggregate**: 28.5-47 sessions; wall-clock ~14-22 with parallelism.

**Open orchestrator calls** (per D58 follow-on items):

- **FA-ε**: M-enhance's TCP brokers for runtime/compile/reflection queries vs deferring those to Phase 4 Remote Control API — decide when M-enhance handoff drafts.
- **Scaffold commit timing**: fold into M1 vs separate 0.25-session dispatch — decide when M1 amendment lands.

When any dispatched handoff completes and residual items surface, consolidate them here if they're not immediately dispatchable. When a handoff fully ships, **remove it from this section** — completed work belongs in git history, not in the backlog index.
