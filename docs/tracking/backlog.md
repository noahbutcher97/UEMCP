# UEMCP Backlog

> Tracks future-consideration items that aren't currently dispatched as handoffs and aren't load-bearing enough to live in the D-log. Distinct from `risks-and-decisions.md` (which logs decisions) and from `docs/handoffs/` (active dispatches). Without this file, these items would exist only in orchestrator conversation context and evaporate between sessions.
>
> **Maintenance rule**: when an item here gets dispatched as a handoff or folded into a committed plan, **remove it from this file** — it migrates to a real artifact. This file only holds *currently-not-dispatched* items.

---

## Tool-surface cleanup

Tools already shipped with known redundancies or deprecation candidates. Typically resolved by yaml edits or one-line handler removals.

### TS-1 — `actors.take_screenshot` ↔ `visual-capture.get_viewport_screenshot` duplication
- **Source**: Agent Workflow Catalog, over-served #1 (2026-04-16)
- **State**: already yaml-flagged; no deprecation committed
- **Fix**: one-line yaml removal or informational-only redirect
- **Trigger**: next tool-surface cleanup pass or Phase 3 scope refresh

### TS-2 — `widgets.add_widget_to_viewport` NO-OP
- **Source**: Agent Workflow Catalog, over-served #2 + D27
- **State**: C++ handler returns "use Blueprint nodes instead"; tool surface is misleading
- **Fix**: remove from yaml OR rename to `get_widget_class_path` with informational description per D27
- **Trigger**: next tool-surface cleanup pass or Phase 3 scope refresh

### TS-3 — `editor-utility.create_asset` scope review
- **Source**: Agent Workflow Catalog, over-served #3
- **State**: no observed catalog demand
- **Fix**: drop from yaml if still undemanded at Phase 3 dispatch
- **Trigger**: Phase 3 plugin scope refresh research

---

## Enhancements

New capability proposals not yet scoped. Each has a workflow trigger that would justify prioritization.

### EN-1 — `query_asset_registry.size_field` filter (`min_size_bytes` / `max_size_bytes`)
- **Source**: Agent Workflow Catalog Q4; Noah accepted as "worth queuing" (2026-04-16)
- **Scope**: one yaml param addition; parser already tracks `sizeBytes` — no parser work
- **Enables**: "which ProjectA assets > 5 MB?", "audit size-optimization candidates"
- **Cost**: ~15-min enhancement worker
- **Trigger**: next enhancement round or fold into polish pass

### EN-2 — `find_blueprint_nodes_bulk(path_prefix)` corpus-wide variant
- **Source**: Agent 10.5 manual tester Item #2 (2026-04-16)
- **Scope**: new offline tool scanning all BPs under a path_prefix, running the `find_blueprint_nodes` filter per BP, returning aggregated per-BP match counts
- **Enables**: "find all ProjectA BPs that call `ApplyGameplayEffectToTarget`", "which BPs handle `ReceiveAnyDamage`"
- **Cost**: 1-2 agent sessions (bulk-scan pattern new to offline tier)
- **Trigger**: corpus-wide find/grep workflow becomes routine, or bundled with next enhancement round

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
- **Source**: Agent 11.5, D48 — FOLD-INTO-3F verdict
- **Cost**: ~8-13 agent sessions; zero reference coverage in CUE4Parse / UAssetAPI for UEdGraphPin binary serialization
- **Reopening (per D48)**:
  1. 3F sidecar work slips indefinitely AND an agent-automation workflow requires offline pin-trace specifically (not just name-level find, which S-A covers)
  2. Sidecar-missing scenarios fire frequently enough that sidecar-coverage discipline becomes untenable
- **State**: neither trigger present today

### DR-2 — L3A full-fidelity UEdGraph byte parsing
- **Source**: Agent 11, D45 — permanently EDITOR-ONLY
- **State**: locked by D45; 3F sidecar is the canonical offline-read path
- **Reopening**: architectural shift — CUE4Parse ports K2Node readers, OR UE editor-side serialization stabilizes enough to reverse-engineer at reasonable cost
- **State today**: no action expected

---

## Currently-known-issues not in this file

These items ARE dispatched (handoffs exist) so they're NOT tracked here:

- Polish worker items (7 response-shape nits) → `docs/handoffs/polish-worker-response-ergonomics.md`
- Parser extension items (FExpressionInput native layout + FieldPathProperty) → `docs/handoffs/parser-extensions-expression-fieldpath.md`
- Cleanup worker items (int64 VFX + semgrep deep refactor) → `docs/handoffs/cleanup-worker-int64-semgrep.md`
- Manual testing of Agent 10.5 surface → `docs/handoffs/manual-testing-agent10-5-surface.md` (completed, results at `docs/testing/2026-04-16-agent10-5-manual-results.md`)
- D-log + CLAUDE.md housekeeping → `docs/handoffs/docs-housekeeping-post-10-5.md` (completed)

When any of those dispatched handoffs completes and residual items surface, consolidate them here if they're not immediately dispatchable.
