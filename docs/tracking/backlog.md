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

In-flight as of 2026-04-20 (post-scope-refresh):

- EN-2 manual testing (`find_blueprint_nodes_bulk` + F-1.5 belt-and-braces) → `docs/handoffs/manual-testing-en2-2026-04-20.md` (queued; optional-belt-and-braces)

Queued for post-D-log dispatch:

- **M0** — Phase 3 yaml grooming (0.5 session) — drops 6 per §Q1 of `docs/research/phase3-scope-refresh-2026-04-20.md`, annotates KEEP (reduced) entries, marks MOVE-TO-SIDECAR consolidations; no handler changes
- **M1** — 3A TCP scaffolding (3-5 sessions) — first real C++ plugin work; parallelizes with M2-Phase-A. **M1 constraint per D57**: `MCPServerRunnable` must gate on `!FApp::IsRunningCommandlet()` to avoid TCP port contention when the plugin loads in the commandlet process. Existing UnrealMCP plugin lacks this gate (silent failure mode); fixing it in UEMCP's scaffold is part of M1 scope.
- **M2-Phase-A** — sidecar save-hook + offline reader + 9 traversal verbs + **3F-4 DumpBPGraphCommandlet** (3.5-6 sessions post-D57, 2-3 parallel sub-workers) — no TCP dependency. Commandlet adds CI / fresh-checkout / stale-sidecar priming path; shares JSON serializer with 3F-2 save-hook. Per D57.
- **M2-Phase-B** — dump_graph TCP + invocable prime (1-2 sessions) — post-M1
- **M3** — oracle retirement (6-10 sessions, 3 sub-workers) — rebuilds 32 transitional tools on 55558 with P0-1 through P0-11 upgrades; absorbs TS-1 + TS-2 (per D53/D54)
- **M4** — reduced-scope reads (3-5 sessions) — 12 tools from blueprint-read/asset-registry/data-assets hitting only their retained D52 surface
- **M5** — remaining Phase 3 toolsets (6-10 sessions, 3-4 sub-workers) — animation + materials + geometry + input-and-pie + editor-utility + visual-capture
- **M6** — optional S-B (6-9 sessions) — only if D52 trigger fires; oracle-gated on M2

When any dispatched handoff completes and residual items surface, consolidate them here if they're not immediately dispatchable. When a handoff fully ships, **remove it from this section** — completed work belongs in git history, not in the backlog index.
