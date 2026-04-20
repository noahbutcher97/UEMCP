# Phase 3 Re-sequencing — MCP-first, plugin-enhances

> **Author**: Phase 3 Re-sequencing researcher (session 2026-04-20)
> **Handoff**: `docs/handoffs/phase3-resequence-mcp-first.md`
> **Type**: Research — correction of load-bearing framing assumption; produces re-sequenced M-plan. No code, no dispatch authorship, no D-log edits.
> **HEAD at research**: `64bba6c` on main (queue commit for this handoff). Test baseline 825 per CLAUDE.md; not re-run (optional).
> **Deliverable consumers**: Phase 3 dispatch orchestrator (queues the re-sequenced milestones per §Q5). D-log maintainer (amends D48/D54/D55/D57 per §Q6).
> **Seal**: Research document — factual corrections via blockquote amendment only.

---

## §Executive summary

1. **S-B is promoted from optional M6 to primary M-new**. Under the corrected "enhanced by plugin" framing, pure-offline edge-topology parse is the foundation, not an optional acceleration. D55's 6-9 session honest range survives oracle substitution; net **7-10 sessions** accounting for ~0.5-1 session bootstrap oracle cost (hand-fixtures + optional short-running `DumpBPGraphCommandlet` for differential validation). The 19-type skeletal subset per D48 becomes S-B's scope envelope.

2. **Plugin's enhancement role narrows sharply**. Of the 12 data categories the sidecar was planned to carry, **7 become offline-feasible** under the new framing (positions, comment boundaries, contains[], via_knots, enabled-state, default pin values, knot node identity); **5 stay genuinely plugin-only** (PIE/runtime state, compiled shader/VM output, BP compile errors, UClass reflection metadata flags, reflection-gated live-editor deltas). The enhancement layer contract is much thinner than D54's M2-Phase-A scope implied.

3. **9 traversal verbs ship progressively with different dependencies**. `bp_list_graphs` + `bp_find_in_graph` ship on today's infrastructure (L0 + S-A already there). `bp_subgraph_in_comment` ships with a thin spatial extension (positions via tag iteration — zero S-B dependency). `bp_list_entry_points` + `bp_neighbors` (edge mode) + `bp_show_node` + `bp_trace_exec` + `bp_trace_data` ship with S-B. `bp_paths_between` stays v1.1. No verb is blocked by plugin availability; enhancement annotations (via_knots, spatial-neighbors) degrade gracefully.

4. **Updated M-sequence**: M0 shipped → (**M1** 3-5 ∥ **M-spatial** 1-2 ∥ **M-new** 7-10) → (**M-enhance** 3-5 ∥ **M3** 6-10 ∥ **M4** 3-5 ∥ **M5** 6-10). Total ~26-42 sessions, wall-clock ~14-22 with parallelism. **M-new is critical-path for D52's pin-topology near-parity goal.** M-enhance is reduced from D54's scope because the offline layer now does the heavy lifting.

5. **D48, D54, D55, D57 need BLOCKQUOTE-AMENDMENT**. D48's S-B FOLD-INTO-3F is superseded (S-B is now primary, not folded). D54's SHIP-SIDECAR-PHASE-A-FIRST is superseded (foundation moves from sidecar to offline S-B). D55's PURSUE-AFTER-SIDECAR ordering reverses (S-B ships first; cost stays 6-9 + oracle-substitution surface). D57's PRESERVE+AUGMENT substrate (D54) is gone; 3F-4 commandlet retargets to enhancement-layer priming + S-B development-time differential oracle. **D45 + D52 + D53 + D56 stand unchanged** (sharpened in D52's case — edge topology is now an explicit first-class offline goal, not an aspirational trajectory).

**Framing-audit concerns surfaced** (§Q7): (α) the handoff's "skeletal-subset S-B" wording masks that the real floor is *edge topology* specifically, not generic full-fidelity; (β) "plugin enhances" needs to stress-test against workflow categories that currently assume sidecar freshness; (γ) spatial extraction is far cheaper than the handoff implies and could ship as its own intermediate milestone M-spatial; (δ) the "plugin-absent state first-class functional" contract requires edge verbs return **non-empty correct data** in plugin-absent runs — this must be a test-harness assertion, not aspirational wording.

---

## §Q1 — S-B re-scope under new role

Under the corrected framing, S-B's validation oracle is no longer "sidecar JSON produced by save-hook that already shipped." The oracle substitution analysis:

### §Q1.1 Oracle candidates without sidecar-on-disk

| Oracle candidate | How it works | Cost to stand up | Reliability |
|------------------|--------------|------------------|-------------|
| **One-shot differential commandlet** (3F-4 dev-only, not production-critical-path) | Dev worker writes minimal `UDumpBPGraphCommandlet` stub that emits `{nodeId: [linked_to_pin_ids]}` for a fixture set. S-B parse output compared bytewise. | ~0.5-1 session — much smaller than full 3F-4 because scope is "emit pin-ID edges only" not full sidecar schema. Per M-alt §Q2.2 reference sizing, ~120-180 LOC commandlet body + ~40 LOC narrower edge-only serializer (not the full 400-600 LOC shared serializer). | **HIGH** — editor's own pin serializer is ground-truth. Cold-boot 5.7-17.5s per run (M-alt §Q1) is acceptable for dev-time differential testing. |
| **Hand-verified BP corpus** | 5-10 real ProjectA BPs checked against `inspect_blueprint` + eyeballed exec-chain expectations. Sample set already partially exists (Agent 11.5 §3: `BP_OSPlayerR`, `BP_OSControlPoint`, `BP_FrostBoltProjectile`). | ~0.5 session — expand from 3 to 8-10 samples; manually annotate expected pin-ID edges. | **MEDIUM** — catches systematic errors; misses rare-pattern bugs that a broader differential might find. |
| **UE 5.6 source code cross-check** | Read `Engine/Source/Runtime/Engine/Classes/EdGraph/EdGraphNode.{h,cpp}` and implement parse logic against engine source's `UEdGraphNode::Serialize()` + `FEdGraphPin` member layout. No comparison to runtime output. | Already-planned fixed cost — Agent 11.5 §2.1 identified `UEdGraphNode::Serialize()` pin-block as the RE target. This is the 3-4 session base-pin-RE work itself, not additional. | **MEDIUM-LOW** on its own — engine source defines correct behavior but doesn't exercise it. Best used in combination with one of the above. |

**Recommended oracle stack**: commandlet differential (HIGH) as primary + hand-verified corpus (MEDIUM) as unit-test spine + UE source as implementation reference (baseline). Combined incremental cost over base S-B: **~0.5-1 session** (commandlet stand-up + fixture curation); the source reading is already inside the base 3-4 sessions.

### §Q1.2 Cost breakdown — honest refinement

D55 FA-1 analysis of the 19-type restriction's cost impact (reproduced from `docs/research/phase3-scope-refresh-2026-04-20.md` §Q4.1):

| Component | D55 estimate | Under new framing | Change |
|-----------|--------------|-------------------|--------|
| Base pin-block RE (`UEdGraphNode::Serialize()` layout) | 3-4 sessions | 3-4 sessions | **Unchanged** — fixed cost; oracle-source-neutral |
| Per-node Serialize() overrides (skeletal-19 subset) | ~1 session | ~1 session | **Unchanged** — CallFunction backcompat + Switch regeneration still the only override surface; UK2Node_MathExpression still excluded |
| LinkedTo resolution via pin-ID graph | 1-2 sessions | 1-2 sessions | **Unchanged** — fixed pin-ID edge-table walker |
| Version-skew buffer (UE 5.6 ↔ 5.7 format shifts: PersistentGuid, bit-flag packing, subpin layout) | 2-3 sessions | 2-3 sessions | **Unchanged** — partial collapse vs full-fidelity, but pin-level edge cases still format-level |
| **NEW — Bootstrap oracle** (differential commandlet + fixture corpus) | N/A (oracle-free via sidecar) | **0.5-1 session** | **New cost** — replaces sidecar-already-there oracle |

**Honest range — corrected framing**: **6.5-10 sessions**, vs D55's 6-9 session "after-sidecar" range. Midpoint moves ~0.5 session upward because oracle-substitution is non-zero.

**Why cost doesn't collapse further under new framing**: removing the sidecar-existing-first ordering does not reduce S-B's implementation cost; S-B's work was always in the pin-block RE + LinkedTo resolution + version-skew, all of which are oracle-choice-invariant.

### §Q1.3 Minimum viable S-B scope

Target for M-new shipping criterion:

| Dimension | Answer |
|-----------|--------|
| **Edges resolvable?** | YES — pin ID graph from LinkedTo must reconstruct source-node → target-node edge set correctly across all 19 skeletal K2Node classes |
| **Exec flow correct?** | YES — `K2Node_Event`/`CustomEvent` → `CallFunction` → `IfThenElse`/`ExecutionSequence`/`Switch*` → leaf exec chain must round-trip for representative BPs |
| **Data flow correct?** | YES — `VariableGet` → `CallFunction` arg; `CallFunction` return → `VariableSet` input; `DynamicCast` object-in → cast-out type flow |
| **Which subset of K2Node types?** | Shipped D48 skeletal 19 (verified via grep of `server/offline-tools.mjs:1591-1607`): Event, CustomEvent, FunctionEntry, FunctionResult, VariableGet, VariableSet, CallFunction, CallParentFunction, IfThenElse, ExecutionSequence, SwitchEnum, SwitchString, SwitchInteger, DynamicCast, MacroInstance, Self, Knot, AddDelegate, AssignDelegate |
| **Priority order within subset** (per D55 §Q4.5 + reinforced by instance-count evidence) | 1. CallFunction/CallParentFunction (81 instances in `BP_OSPlayerR` per Agent 11.5 §3.1); 2. VariableGet/VariableSet (25-32); 3. Event/CustomEvent (entry points, trace origin); 4. IfThenElse/ExecutionSequence/Switch (control flow); 5. DynamicCast, Knot, MacroInstance, FunctionEntry/Result, Self, delegate-presence |

**Ship criterion**: the 5 S-B-dependent verbs from §Q3 (`bp_list_entry_points`, `bp_trace_exec`, `bp_trace_data`, `bp_show_node`, `bp_neighbors` edge-mode) return **non-empty correct data** on representative ProjectA BPs in a fully-offline context (no editor running, no sidecar on disk). This is a test-harness assertion, not aspirational language — see §Q7 FA-δ.

### §Q1.4 Confidence

**MEDIUM-HIGH** on the 6.5-10 range. The D55 breakdown holds (fixed-cost floors are oracle-invariant); only the oracle-substitution surcharge is new. **MEDIUM** on the 0.5-1 bootstrap-oracle estimate specifically — depends on whether the differential commandlet gets absorbed into base dev-tooling or factored as a separate ~0.5-session spike. The midpoint is ~8 sessions either way.

---

## §Q2 — Plugin enhancement contract

Walk of every data category the sidecar was planned to carry (per amendment schema + Sidecar Design Session Q1-Q5), evaluating offline-feasibility under the corrected framing and plugin's incremental value.

### §Q2.1 Enhancement-data-type × offline-feasibility × plugin-value

| Data category | Offline feasibility | Plugin-value contribution | Verdict |
|---------------|---------------------|---------------------------|---------|
| **Node positions** (`NodePosX`/`NodePosY` per amendment schema) | **FULL** — UPROPERTY int32 fields on `UEdGraphNode`; readable today via existing Level 1+2 tag iteration. Zero new parser work. | Minor — plugin's in-memory UEdGraphNode already has these, but no faster than offline reads. | **Offline-primary**; plugin unnecessary. Ships in M-spatial (§Q5). |
| **Node size** (NodeWidth/NodeHeight for resizable nodes) | **FULL** — same basis as positions; optional field on most K2Nodes | Minor — same as positions | Offline-primary |
| **Comment boundaries** (`UEdGraphNode_Comment.NodePosX/Y/NodeWidth/NodeHeight`) | **FULL** — UEdGraphNode_Comment is a UEdGraphNode subclass; positions + size readable via tag iteration | Minor | Offline-primary |
| **Comment containment** (`contains[]` — which nodes are inside which comment box) | **FULL** — requires point-in-rect math over positions, one pass at query time or pre-compute at parse time. O(N×M) for N nodes × M comments; BP_OSPlayerR has 240 K2Nodes × ~5 comments ≈ 1200 rect tests — microsecond cost. | Plugin could pre-compute; offline recompute cost is trivial | Offline-primary |
| **`via_knots` annotation** (Sidecar Q2 resolution) | **FULL** — post-pass over edge list resolving UK2Node_Knot pin-IDs into collapsed chains. Requires S-B LinkedTo data (M-new) but once that lands, computation is pure algorithm. | Plugin processes at save time; offline does post-hoc — same result | Offline-primary (post-M-new) |
| **`enabled` state** (UEdGraphNode::EnabledState enum: Enabled/Disabled/DevelopmentOnly) | **FULL** — tagged UPROPERTY via L2 enum handler | Minor | Offline-primary |
| **Default pin values** (FString serialized defaults on each pin) | **FULL** — readable as part of S-B pin block (same binary pin structure that carries LinkedTo) | Minor — same data both paths | Offline-primary (post-M-new) |
| **Knot node identity** (distinguishing `UK2Node_Knot` from other classes) | **FULL** — shipped today via export-table `className` field | None | Offline-primary |
| **Runtime/PIE state** (live UObject property values, PIE snapshot, watched variables) | **NONE** — requires live UEngine | Full — only path | **Plugin-only** |
| **Compiled shader/Niagara VM output** (baked uniforms, compiled bytecode) | **NONE** — requires compile pipeline + `-AllowCommandletRendering` | Full | **Plugin-only** |
| **BP compile errors / warnings** (`FCompilerResultsLog` output post-compile) | **NONE** — requires Kismet compiler invocation | Full | **Plugin-only** |
| **UClass reflection metadata flags** (EditAnywhere, BlueprintReadWrite, Replicated, tooltip, Category — per-property flags) | **NONE** — flags live in reflection, not `.uasset` bytes (scope-refresh §Q2.4 Agent 9 §3 note) | Full | **Plugin-only** |
| **Live-editor-modified-unsaved state** (user changed a variable default, hasn't saved) | **NONE** — offline reads the on-disk value | Full (short-window freshness) | **Plugin-only — RC API/Phase 4 better suited** |

**Rollup**: 8 of 13 categories are **offline-primary** (plugin adds marginal value at best). 5 of 13 are **genuinely plugin-only** (no offline substitute possible without re-implementing the UE compiler/reflection/runtime).

### §Q2.2 What the enhancement layer delivers in the new contract

Enhancement layer's shipping scope collapses to the plugin-only set:

1. **Runtime/PIE state broker** — TCP command returning live UObject property values on request. Not a sidecar; query-time dispatch. (Or Phase 4 RC API.)
2. **Compiled/derived data broker** — TCP command returning compiled shader uniforms, baked Niagara VM, per-material compiled params. Query-time.
3. **Compile diagnostic broker** — TCP command triggering `UBlueprint` compile + returning `FCompilerResultsLog` formatted output.
4. **Reflection metadata broker** — TCP command returning per-property flag bundle (EditAnywhere, Category, tooltip, etc.) for a given UClass. Query-time.
5. **Optional pre-compute cache writer** — editor save-hook emits **narrow** sidecar carrying ONLY the plugin-only fields (not positions, not contains[], not via_knots — those are offline). Primary consumer: workflows that can't tolerate TCP latency per query. Under the new contract this is a *latency optimization*, not a correctness path.

**Not shipped in enhancement layer** (moved to offline):
- Positions (tag iteration), contains[] (point-in-rect), via_knots (post-pass over S-B edges), enabled state, comment text/boundaries, default pin values, node identity.

### §Q2.3 Scope collapse estimate for enhancement layer

D54's M2-Phase-A sized at 3-5 sessions + D57's +0.5-1 session for 3F-4 commandlet = 3.5-6 sessions. Under new contract:

| Enhancement component | Old scope (D54+D57) | New scope |
|-----------------------|---------------------|-----------|
| Full BP sidecar serializer + save-hook | 1.5-2 sessions | ~0.5-1 session (narrow sidecar: plugin-only fields only) |
| 9 traversal verbs | 2-3 sessions (offline reader consuming sidecar) | **Moved to M-new** (pure-offline, not enhancement-layer) |
| 3F-4 DumpBPGraphCommandlet | 0.5-1 session | 0.5-1 session (narrowed scope — plugin-only fields + optional edge-dump for S-B dev oracle) |
| Editor-menu prime (3F-3) | 0.5 session | 0.5 session (unchanged; primes the narrow sidecar) |
| Runtime/compile/reflection TCP brokers | Not in D54 — these were plugin-TCP reads | Promoted into enhancement layer explicitly |

Enhancement layer **net cost: 3-5 sessions**, similar magnitude but narrower scope. 9 verbs move to M-new; runtime/compile/reflection brokers move INTO M-enhance from what was M4-plugin-TCP.

---

## §Q3 — Verb degradation modes

Per Sidecar Design Session §Traversal verb surface (9 verbs; `bp_paths_between` v1.1). Under corrected framing, each verb evaluated against: (a) does pure S-B + offline infrastructure ship the verb?; (b) what enhancement data (if any) enriches the response?; (c) graceful degradation shape when enhancement absent.

### §Q3.1 Verb-by-verb table

| Verb | Pure S-B sufficient? | Offline-only shippable before M-new? | Enhancement dependency | Graceful degradation shape |
|------|----------------------|---------------------------------------|------------------------|----------------------------|
| **`bp_list_graphs`** | N/A — doesn't need pin topology | **YES** — ships today via `inspect_blueprint` export walker (shipped D37). Enumerate UEdGraph exports, emit `{name, type, entry_node_ids, node_count}`. | None | No degradation — always works. |
| **`bp_list_entry_points`** | Partial — class-identity alone answers "entry-like" (K2Node_Event, K2Node_CustomEvent, K2Node_FunctionEntry) without pin check | **PARTIAL** ships today via `find_blueprint_nodes` class filter; full "no exec-in pins" verification needs S-B | Spatial (`pos`, `comment_id`) — enhancement-provided but offline-derivable via M-spatial | Without M-spatial: emit entry-point list without `pos`/`comment_id`. Without M-new: class-identity heuristic misses the "entry node with pin edge coming from macro" edge case. |
| **`bp_trace_exec`** | **YES (required)** | Needs M-new | `via_knots` annotation (post-pass); spatial pos per node (M-spatial); per-node `enabled` state (M-spatial) | M-new absent: `{available: false, reason: "edge_parser_not_shipped"}` — only hard-fail case in the new contract. Under target deployment (M-new shipped), plugin absent is fine: trace returns correct topology without `via_knots` annotation; verb emits `{via_knots_available: false}` flag. |
| **`bp_trace_data`** | **YES (required)** | Needs M-new | Same as trace_exec | Same as trace_exec |
| **`bp_show_node`** | Partial — shipping without pin data is a degraded view; full detail needs S-B | Partial today via `find_blueprint_nodes` + `read_asset_properties`; missing pin-edge view | Spatial pos, compiled/runtime values, reflection flags | Always works with today's infrastructure (class + UPROPERTY dump); pin block absent until M-new; spatial absent until M-spatial; live values absent without plugin. Caller gets "what we know" with explicit `{fields_available: [...]}` manifest. |
| **`bp_neighbors`** | **Edge mode YES (S-B); spatial mode needs positions** | Spatial mode ships via M-spatial; edge mode needs M-new | Same as trace_exec | Edge mode M-new absent: `{available: false}` for edge-neighbors. Spatial mode M-spatial absent: same. Default mode is edge per Sidecar Design Session semantics. |
| **`bp_subgraph_in_comment`** | N/A — only needs positions + comment boundaries + point-in-rect math; **zero S-B dependency** | **YES via M-spatial** — ships before M-new if dispatched separately | None (the verb IS the enhancement when M-spatial lands) | M-spatial absent: `{available: false, reason: "spatial_parser_not_shipped"}`. With M-spatial: always works, regardless of plugin availability. |
| **`bp_find_in_graph`** | N/A — predicate filter over class+tagged properties | **YES** — ships today via D48 S-A (`find_blueprint_nodes` class filter) already. Extend to whole-graph scope. | None | Always works. |
| **`bp_paths_between`** (v1.1 per D41) | Requires M-new graph walker + cycle detection | Deferred to v1.1 regardless; lands after `bp_trace_exec` + `bp_trace_data` stabilize | Same as trace_exec | Defer-gated; not a blocker. |

### §Q3.2 Shipping waves implied by the verb table

**Wave 1 — ships today or on M-spatial**: `bp_list_graphs` (today), `bp_list_entry_points` (partial today, full on M-spatial), `bp_find_in_graph` (today extended to whole-graph scope), `bp_subgraph_in_comment` (M-spatial), `bp_show_node` (partial today + M-spatial for positions).

**Wave 2 — ships on M-new**: `bp_trace_exec`, `bp_trace_data`, `bp_neighbors` (edge mode), `bp_show_node` (pin block completion).

**Wave 3 — v1.1**: `bp_paths_between`.

**Wave 4 — enhancement layer (optional)**: all verbs gain plugin-only enhancement fields (runtime values on `bp_show_node`, compile-error annotations on `bp_trace_exec`, live-unsaved-edits if plugin-open).

**Implication for M-sequence**: 6 of 9 verbs ship at least partially before M-new lands. The "offline has no edge-topology verbs at all today" framing is incorrect — the foundation exists; M-new unlocks the 3 trace/edge verbs that genuinely need pin topology.

### §Q3.3 Plugin-absent first-class-functional contract

Per the framing correction ("plugin-absent state is first-class functional"), the contract that must hold after M-new ships:

- `bp_list_graphs` — returns correct graph enumeration ✓
- `bp_list_entry_points` — returns correct entry node list (full precision via S-B) ✓
- `bp_trace_exec` — returns correct exec-chain topology; omits `via_knots` if enhancement absent ✓
- `bp_trace_data` — returns correct data-flow topology; same degradation ✓
- `bp_show_node` — returns pin list + LinkedTo resolved + node semantics; omits compiled/runtime fields if enhancement absent ✓
- `bp_neighbors` — returns edge-neighbors correctly; spatial-neighbors if M-spatial shipped ✓
- `bp_subgraph_in_comment` — returns correct containment (M-spatial fully answers this) ✓
- `bp_find_in_graph` — returns correct predicate-filtered node list ✓
- `bp_paths_between` — v1.1; same correctness bar as trace_exec ✓

**Not covered by plugin-absent contract** (acknowledged gaps the user's framing does not claim to close):
- Runtime UObject property values — plugin-only.
- Compile error messages — plugin-only.
- Live-unsaved edits from an open editor session — plugin-only.
- Per-property EditAnywhere/BlueprintReadWrite flags — plugin-only (reflection, not bytes).

These five are consistent with D52 category assignments (a), (c), (d) and do not contradict the framing correction, which specifically named **edge topology** as the offline floor.

---

## §Q4 — Closure reaffirmation

Per handoff §Q4 — don't re-derive, confirm these stay correctly closed.

### §Q4.1 D45 L3A full-fidelity UEdGraph EDITOR-ONLY — stands

Skeletal-subset S-B (19 K2Node types per D48) is **not** full fidelity. Full-fidelity means 200+ K2Node bespoke serialization paths (L3A per Agent 11 `docs/research/level3-feasibility-study.md` §2.A). D45 covers that — no reference port source, ~15-30 agent-session cost, editor sidecar strictly dominates.

The re-sequencing promotes S-B to foundation, not L3A. S-B covers the 19-type skeletal subset's pin-block layer; per Agent 11.5 §3.4 that's 62-100% of K2Nodes in ProjectA BPs (median ~75%). L3A's 200+ type heterogeneity stays out of scope. **D45 unaffected.**

### §Q4.2 Sidecar-free plugin-absent future — stands with sharpening

The corrected framing does not eliminate the plugin. Per §Q2.1, five data categories remain plugin-only:

- (a) Runtime/PIE state
- (c) Compiled/derived data
- (d) UClass reflection metadata flags
- (w) Write ops (the entire 35-tool category per D52 §"(w) writes")
- (reflection-live-deltas) Unsaved editor modifications

D52's "plugin scope shrinks to writes + genuinely-offline-infeasible reads" formulation survives unchanged. The re-sequencing shrinks the "genuinely-offline-infeasible" subset further — pin topology moves from category (b) plugin-or-sidecar to category (offline) — but doesn't eliminate it.

**Plugin is not optional for**: writes (M1+M3 are critical path; 35 write tools), runtime queries (M-enhance TCP brokers), reflection flag queries (M4-reduced reads), compile diagnostics (M-enhance TCP brokers).

**D52 stays; plugin-free future stays rejected.** The sharpening is that the non-optional plugin scope gets smaller under this framing than under D54's.

---

## §Q5 — Updated M-sequence

Orchestrator-actionable milestones replacing §Q5.3 of `docs/research/phase3-scope-refresh-2026-04-20.md`.

### §Q5.1 Milestone overview

| Milestone | Title | Sessions (range) | Parallelizable with |
|-----------|-------|------------------|---------------------|
| **M0** | Phase 3 yaml grooming | 0.5 (shipped `aa0d966`) | — |
| **M1** | 3A TCP scaffolding + infrastructure | 3-5 | M-spatial, M-new |
| **M-spatial** *(new)* | Position + comment extraction via tag iteration + `bp_subgraph_in_comment`/`bp_list_graphs`/`bp_find_in_graph` verb surface | 1-2 | M1, M-new |
| **M-new** *(replaces D54 M2-Phase-A + D55 M6)* | S-B skeletal edge parser + 5 pin-dependent traversal verbs + bootstrap oracle | 6.5-10 | M1, M-spatial |
| **M-enhance** *(replaces D54 M2-Phase-A sidecar portion + D57 3F-4 commandlet)* | Narrow sidecar (plugin-only fields) + save-hook + 3F-4 commandlet + runtime/compile/reflection TCP brokers | 3-5 | M3, M4, M5 (all post-M1) |
| **M3** | Oracle retirement (actors + bp-write + widgets on 55558) | 6-10 (sub-parallel 3a/3b/3c) | M-enhance, M4, M5 |
| **M4** | Reduced blueprint-read + asset-registry + data-assets reads | 3-5 | M3, M5, M-enhance |
| **M5** | Animation + materials + geometry + input-PIE + editor-utility + visual-capture | 6-10 (3-4 sub-workers) | M3, M4, M-enhance |

**Conservative total** (all milestones): 26.5-43 sessions.
**Wall-clock with parallelism**: ~14-22 sessions.

Comparison to D54/D57 sequence (22-37 sessions + optional M6 6-9):
- **Baseline**: D54+D57 summed 25-43 in the M6-commissioned case; 22-37 without M6.
- **Re-sequenced**: 26.5-43 with S-B integrated as M-new.
- **Net delta**: ~+4 sessions on the low end, 0 on the high end. **No cost regression** — S-B's cost was always on the table; we're surfacing it earlier.

### §Q5.2 Dependency chain

```
M0 (shipped)
    │
    ▼
  ┌─────────────────┬──────────────────┬──────────────────┐
  │                 │                  │                  │
  ▼                 ▼                  ▼                  │
M1              M-spatial           M-new (after         │
3A TCP          positions +         bootstrap            │
scaffolding     comments + 3       oracle, with          │
(writes-gated)  non-S-B verbs      optional              │
                                   parallelism to        │
                                   M-spatial)            │
  │                 │                  │                  │
  │                 │                  │                  │
  └────────┬────────┴──────────────────┘                  │
           │                                              │
           ▼                                              │
         (9 verbs all live; edge-topology                 │
          first-class offline)                            │
           │                                              │
           ├──► M3 (oracle retirement) ◄─────────────────┤
           ├──► M4 (reduced reads) ◄─────────────────────┤
           ├──► M5 (remaining toolsets) ◄────────────────┤
           └──► M-enhance (plugin enhancement layer) ────┘
                    │
                    ▼
               enhancement fields available on verbs;
               runtime/compile/reflection TCP brokers live
```

**Critical path**: M1 → M3 (writes gating). M-new is critical-path for D52's edge-topology offline near-parity goal but NOT for writes.

**M-spatial and M-new are parallelizable** (they share the parser but touch different code paths — M-spatial extends tag iteration + adds verbs that don't need pins; M-new adds pin binary parsing). Sub-worker coordination per D49 path-limited commits.

**M-enhance parallelizes with M3+M4+M5** — different toolsets, different handler files, different sub-workers. M-enhance requires M1 for TCP scaffolding on the broker side.

### §Q5.3 Per-milestone scope

**M0 — Phase 3 yaml grooming** *(SHIPPED at `aa0d966`)*. Historical note: applied §Q1 dispositions from scope-refresh (6 DROP, 3 MOVE-TO-SIDECAR, KEEP-reduced annotations). Under re-sequence the 3 MOVE-TO-SIDECAR annotations need revisiting:

- `get_blueprint_graphs` — was MOVE-TO-SIDECAR (3F-1 dump_graph); under re-sequence, primary path is offline M-new verbs; enhancement-layer dump_graph becomes secondary. Yaml annotation should reflect "offline-primary; enhancement-augmented."
- `get_animbp_graph` — same reframe (Sidecar Q3 ships AnimBP state-machine structure in sidecar; under re-sequence, state-machine **structure** is UPROPERTY data readable offline; only *traversal-with-pin-edges* within transition rules needs M-new).
- `get_widget_blueprint` EventGraph subset — same (UWidgetBlueprint is UBlueprint subclass; EventGraph pin-topology now offline via M-new).

**Action**: M-spatial handoff (or a micro-M0.5 yaml touch-up, orchestrator call) re-annotates these three. Not load-bearing; can fold into M-spatial commit.

**M1 — 3A TCP scaffolding** (3-5 sessions) — unchanged from scope-refresh §Q5.3. D57-added constraint: `MCPServerRunnable` must gate on `!FApp::IsRunningCommandlet()` (per M-alt §Q1.4 — existing UnrealMCP plugin starts TCP server in commandlet mode; UEMCP must not). This is load-bearing for M-enhance (3F-4 commandlet) and for the M-new bootstrap-oracle commandlet. **M1 is independent of M-new and M-spatial** — it builds TCP/C++ infrastructure for writes; no dependency on offline parser extensions.

**M-spatial — position + comment extraction** (1-2 sessions):

- Parser extension: extract `NodePosX`, `NodePosY`, `NodeWidth`, `NodeHeight`, `NodeComment`, `EnabledState`, `bCommentBubblePinned` UPROPERTYs via existing L1+L2 tag iteration. These are additive to the already-shipped `find_blueprint_nodes` export walker; no new binary format parsing.
- `UEdGraphNode_Comment` export handler — extract comment text, color, size.
- `contains[]` computation — point-in-rect over positions at query time; trivial O(N×M) loop with microsecond-scale cost on BP_OSPlayerR-sized BPs.
- Verbs shipped: `bp_list_graphs` (extends `inspect_blueprint`'s UEdGraph export walk), `bp_find_in_graph` (extends `find_blueprint_nodes` from single-BP to whole-graph scope), `bp_subgraph_in_comment` (requires positions + contains computation), `bp_list_entry_points` (class-identity heuristic — full precision lands with M-new), `bp_show_node` partial view (without pin block).
- Tests: extend `test-phase1.mjs` with synthetic-fixture + 1-2 ProjectA BP regression assertions.
- No TCP dependency; no plugin dependency. Pure-JS additions to `server/offline-tools.mjs` + `server/uasset-parser.mjs`.

**Confidence on 1-2 sessions**: HIGH. Positions + comments are UPROPERTY int/float/string fields with clean L1+L2 handlers already shipped. Verb wiring follows the `find_blueprint_nodes` pattern already in the codebase. No reverse-engineering, no version-skew buffer.

**M-new — S-B skeletal edge parser** (6.5-10 sessions):

- **Base pin-block RE** (3-4 sessions): reverse-engineer `UEdGraphNode::Serialize()` pin-block trailer (emitted after tagged properties). Source: `Engine/Source/Runtime/Engine/Classes/EdGraph/EdGraphNode.{h,cpp}` and `Engine/Source/Runtime/Engine/Classes/EdGraph/EdGraphPin.h`. Binary layout: PinId(FGuid), PinName(FName), PinType(FEdGraphPinType — reference-backed via CUE4Parse port per Agent 11.5 §2.2), DefaultValue(FString), LinkedTo(TArray<FEdGraphPinReference> where each ref is NodeIndex+PinIndex), SubPins, ParentPin, flags.
- **Per-node Serialize() overrides** (~1 session): UK2Node_CallFunction backcompat (legacy pin-layout upgrade code) + Switch-variant pin-regeneration path. Other 17 skeletal types use base-class Serialize() per D55 §Q4.2.
- **LinkedTo resolution** (1-2 sessions): pin-ID → pin-ID edge set with node-scope resolution. Cycle-safe walker shared with Wave-2 verbs.
- **Version-skew buffer** (2-3 sessions): UE 5.6 ↔ 5.7 format differences — PersistentGuid introduction, bit-flag packing, subpin layout shifts. Validate ProjectA (5.6) + at least one ProjectB fixture (5.7) per D42.
- **Bootstrap oracle** (0.5-1 session): minimal `UDumpBPGraphCommandlet` dev-only stub emitting `{nodeId: [linkedToPinIds]}` for 5-10 ProjectA fixture BPs. Differential test harness: S-B parse vs commandlet output; any mismatch is a bug. Commandlet development cost is ~120-180 LOC + ~40 LOC narrow serializer (per M-alt §Q2.2 sizing, much smaller than full enhancement-layer sidecar). This commandlet is **dev-tooling**, not end-user — ships as a test fixture under `server/test-fixtures/` or similar, invoked by test-harness only.
- **Verbs shipped**: `bp_trace_exec`, `bp_trace_data`, `bp_neighbors` (edge mode), `bp_show_node` (pin block completion), `bp_list_entry_points` (full precision via no-exec-in-pin check). These are the 5 S-B-dependent verbs from §Q3.
- **Tests**: extend `test-phase1.mjs` with pin-topology assertions on ProjectA fixtures; extend `test-uasset-parser.mjs` with format-level pin-block tests; add `test-bp-traversal-verbs.mjs` for verb-level scenarios (synthetic + ProjectA).

**Sub-worker split** (within M-new, after bootstrap-oracle lands):

| Sub-worker | Scope | Sessions |
|------------|-------|----------|
| Oracle-A | Bootstrap differential commandlet + fixture corpus | 0.5-1 |
| S-B-base | `UEdGraphNode::Serialize()` RE + pin-block reader + LinkedTo walker | 4-6 |
| S-B-overrides | CallFunction backcompat + Switch regeneration path handling + UE 5.6 ↔ 5.7 delta | 1.5-2 |
| Verb-surface | 5 S-B-dependent verbs in `offline-tools.mjs` + yaml entries + integration tests | 1-1.5 |

Oracle-A ships first, unblocking S-B-base validation. S-B-base's minimum-viable output (pin IDs + LinkedTo edge set) unblocks Verb-surface. S-B-overrides parallelizes with Verb-surface. Path-limited commits per D49.

**Confidence on 6.5-10 sessions**: MEDIUM-HIGH. D55 breakdown holds; +0.5-1 session for bootstrap oracle is the new surface area. Base pin-block RE remains the load-bearing unknown — if the format is simpler than feared, low end; if more format shifts between 5.6 ↔ 5.7 than Agent 11.5 §2.2 anticipated, high end. No structural blocker identified in research.

**M-enhance — plugin enhancement layer** (3-5 sessions, post-M1):

- Narrow sidecar serializer (3F-1/3F-2 reduced scope): emits plugin-only fields only — compile errors, reflection flags, runtime/compiled derivatives. No positions, no pin topology, no node semantics (those are offline-primary).
- Save-hook: `FCoreUObjectDelegates::OnObjectSaved` delegate filter to UBlueprint subclasses. Writes to `<ProjectDir>/Saved/UEMCP/BPCache/<asset-relative>.bp.json` per D54 Q1 resolution.
- 3F-4 DumpBPGraphCommandlet (production, not dev-oracle version): CI/fresh-checkout/stale-sidecar priming. Shares narrow serializer with save-hook. `!FApp::IsRunningCommandlet()` gate in module startup.
- Editor-menu prime (3F-3): idempotent iteration.
- Runtime/compile/reflection TCP brokers: new TCP command handlers for live value queries, compile-on-demand, reflection metadata lookups. These were part of the M4 reduced-reads scope in scope-refresh §Q5.3 — under re-sequence they gather into M-enhance for cohesion since they all query the live UEngine state.
- Tests: synthetic sidecar fixtures for offline-reader consumption; TCP integration tests against running editor.

**Confidence on 3-5 sessions**: MEDIUM. Narrow sidecar reduces serializer scope ~40-60%; but adding runtime/compile/reflection TCP brokers expands scope by similar magnitude. Net similar to original M2-Phase-A — tightened to plugin-only fields at the sidecar layer and broadened at the TCP-broker layer.

**M3, M4, M5** — unchanged from scope-refresh §Q5.3:

- M3 oracle retirement (6-10 sessions, 3 sub-workers) — rebuild `actors`/`blueprints-write`/`widgets` on 55558 with P0-1 through P0-11 upgrades.
- M4 reduced reads (3-5 sessions) — `blueprint-read` (6 reduced minus 3 that moved fully offline under re-sequence: `get_blueprint_graphs`, `get_animbp_graph`, `get_widget_blueprint` EventGraph subset per §Q5.3 M0 re-annotation; these three stay in M-enhance as enrichment layer only), `asset-registry` (2 reduced), `data-assets` (4 reduced).
- M5 remaining toolsets (6-10 sessions) — unchanged.

**Net effect on M4 scope**: slightly reduced vs scope-refresh §Q5.3 — 3 tools move from "M4 plugin-TCP reduced" to "offline-primary + M-enhance augmentation." M4's reduced-reads list drops to 12 tools (from scope-refresh §Q5.3's 15 by this accounting).

### §Q5.4 Parallelism opportunities

| Parallel pair | Safe because | Constraint |
|---------------|--------------|------------|
| M1 ↔ M-spatial | M1 is C++ (`plugin/`), M-spatial is JS (`server/*.mjs`) — zero file overlap | Path-limited commits per D49 |
| M1 ↔ M-new | Same rationale as above | Same |
| M-spatial ↔ M-new | Both touch `server/uasset-parser.mjs` and `server/offline-tools.mjs`; scope-wise the parser extensions are additive (different functions) and verb-surface additions are per-verb isolated | Strict path-limited commits; worker coordination via handoff notes |
| M-new Oracle-A ↔ S-B-base | Oracle-A is commandlet/C++; S-B-base is JS — no file overlap | Oracle-A lands first; S-B-base uses its output |
| M-new S-B-base ↔ M-new S-B-overrides ↔ Verb-surface | Parser additions are per-function isolated | Sub-worker path discipline |
| M3a ↔ M3b ↔ M3c | Separate handler files in `plugin/Source/UEMCP/Commands/` | Same |
| M3 ↔ M4 ↔ M5 ↔ M-enhance | Different command-handler files; M-enhance lands TCP brokers in own file | Same |

**D49 discipline**: path-limited `git commit <path> -m "..."` mandatory for all parallel dispatches. CLAUDE.md already encodes this; re-sequence adds no new parallelism primitives, just more concurrent streams.

### §Q5.5 Cost summary

| Scenario | Total sessions (range) | Wall-clock with parallelism |
|----------|------------------------|------------------------------|
| M0-M5 + M-spatial + M-new + M-enhance (full re-sequence) | 26.5-43 | ~14-22 |
| Subset — defer M-enhance (offline-only deployment) | 23.5-38 | ~12-20 |
| Subset — defer M5 (core infra + offline full) | 20.5-33 | ~13-18 |

**Scenario — defer M-enhance**: viable if enhancement fields aren't workflow-blocking in the short term. Offline surface is complete without enhancement; plugin-only categories (runtime, compile, reflection) remain on Phase 4 RC API or future-worker. Reopening trigger: workflow catalog pressure on those specific categories.

### §Q5.6 Confidence

**MEDIUM-HIGH** on M0/M1/M-spatial/M3/M4/M5 cost ranges (well-specified from prior research).
**MEDIUM** on M-new 6.5-10 range (D55 breakdown holds; bootstrap oracle adds modest surface).
**MEDIUM** on M-enhance 3-5 range (narrow-sidecar reduces cost on one axis; TCP-broker addition expands it on another — net similar magnitude).

**Biggest unknown**: pin-block format variance between UE 5.6 (ProjectA) and UE 5.7 (ProjectB) during M-new S-B-overrides. If the delta is larger than Agent 11.5 §2.2 anticipated, M-new lands near the 10-session top; if smaller, near 6.5.

### §Q5.7 Load-bearing output — immediate-dispatch handoff drafting

**The first post-research handoff** (orchestrator can draft from this deliverable alone) is **M-new bootstrap-oracle + parallel M-spatial**:

- **M-spatial** dispatches with scope per §Q5.3 M-spatial; single worker; 1-2 session budget. Deliverable: `server/uasset-parser.mjs` + `server/offline-tools.mjs` extensions + 4 verb entries (`bp_list_graphs`, `bp_list_entry_points` partial, `bp_find_in_graph` whole-graph, `bp_subgraph_in_comment`) + tests.
- **M-new Oracle-A** dispatches in parallel with a plugin-worker; 0.5-1 session budget. Deliverable: minimal `UDumpBPGraphCommandlet` fixture-emit stub under `plugin/Source/UEMCP/TestFixtures/` (or equivalent) that produces `{nodeId: [linkedToPinIds]}` JSON for a curated 5-10 BP corpus. Plugin scaffold bootstrap also part of this (since `plugin/` is empty per CLAUDE.md); gate `MCPServerRunnable` on `!FApp::IsRunningCommandlet()` as first M1 scaffold line per D57.
- **M1** dispatches in parallel; worker separate from M-new Oracle-A to avoid scope confusion (both touch plugin C++ — M1 builds TCP; Oracle-A builds commandlet; path-limit commits per D49).
- **M-new S-B-base** dispatches after Oracle-A lands (oracle required for differential testing) + after M1 lands (plugin scaffold infrastructure shared).

This maps to a 3-worker parallel dispatch at kickoff: one for M1, one for M-spatial, one for M-new Oracle-A. Each is independently scoped; no cross-worker dependencies beyond the shared plugin scaffold.

---

## §Q6 — D-log amendment list

Entries needing BLOCKQUOTE-AMENDMENT, in D-log order. Orchestrator executes; this research identifies only.

| D-entry | Amendment needed | Proposed blockquote text |
|---------|------------------|--------------------------|
| **D48** | S-B FOLD-INTO-3F is superseded; S-B is now primary not folded | `> **Amendment 2026-04-20 (post-re-sequence research)**: The "FOLD-INTO-3F" verdict on S-B is SUPERSEDED-BY-D59-or-subsequent (orchestrator assigns slot). Under the 2026-04-20 "MCP-first, plugin-enhances" framing correction, offline pin-topology parse is first-class foundation rather than an optional complement. S-B is re-sequenced as primary M-new ahead of (not after) the plugin enhancement layer. S-A (name-only skeletal, already shipped) and S-B (edge topology) now form the two-tier offline BP-logic foundation. See docs/research/phase3-resequence-mcp-first-2026-04-20.md §Q5 M-new.` |
| **D54** | SHIP-SIDECAR-PHASE-A-FIRST is superseded; sidecar ships as enhancement, not foundation | `> **Amendment 2026-04-20 (post-re-sequence research)**: The SHIP-SIDECAR-PHASE-A-FIRST verdict is SUPERSEDED. Under the 2026-04-20 framing correction ("traverse event graph edge topology offline without needing access to projects from plugin code"), pin-topology foundation moves from sidecar to offline S-B (M-new in the re-sequenced plan). The 9 traversal verbs still ship but against offline bytes rather than editor-emitted JSON. Sidecar narrows to plugin-only fields (compile errors, reflection metadata, runtime values) and ships as M-enhance in parallel with M3/M4/M5, not as pre-M1 Phase A. Phase A/B sub-split of 3F (noted in original D54) is no longer load-bearing; 3F-1 dump_graph and 3F-3 editor-menu prime become enhancement-layer fast-paths, not foundational. See phase3-resequence-mcp-first-2026-04-20.md §Q5 M-enhance + §Q2.` |
| **D55** | Ordering reversed: S-B BEFORE (not after) enhancement layer; cost range preserved with oracle-substitution surface | `> **Amendment 2026-04-20 (post-re-sequence research)**: The "PURSUE-AFTER-SIDECAR" ordering is REVERSED. Under the 2026-04-20 framing correction, S-B is primary and ships before the enhancement layer (M-new precedes M-enhance in the re-sequenced plan). Honest cost range updates from 6-9 to 6.5-10 sessions, accommodating ~0.5-1 session bootstrap-oracle cost (differential commandlet + fixture corpus replaces sidecar-already-there as validation oracle). M6-optional framing is superseded — S-B becomes critical-path for D52 edge-topology offline near-parity, not an optional follow-on. Priority order within S-B (CallFunction first, then VariableGet/Set, then Event/CustomEvent, then control flow, then remaining 19-type skeletal) preserved from §Q4.5. See phase3-resequence-mcp-first-2026-04-20.md §Q1 + §Q5.3 M-new.` |
| **D57** | M-alt PRESERVE+AUGMENT substrate (D54) is gone; 3F-4 commandlet retargets | `> **Amendment 2026-04-20 (post-re-sequence research)**: The PRESERVE substrate (D54 SHIP-SIDECAR-PHASE-A-FIRST) is superseded (see D54 amendment). The AUGMENT verdict — adding 3F-4 DumpBPGraphCommandlet — retargets under the re-sequenced plan: (1) **bootstrap-oracle** dev variant ships inside M-new as differential-testing infrastructure for S-B development (~0.5-1 session, minimal emit-edges-only scope per M-alt §Q2.2 sizing); (2) **production variant** ships inside M-enhance as CI/fresh-checkout/stale-sidecar priming for the narrow plugin-only-fields sidecar (~0.5-1 session, reuses narrow serializer from save-hook). Total 3F-4 cost remains ~0.5-1 session but splits across two milestones. M1's `!FApp::IsRunningCommandlet()` gate stays load-bearing for both commandlet variants. The framing concerns §FA-a through FA-f from the M-alt deliverable carry forward; FA-a (M1 writes-gated independent of read coverage) is reinforced by the re-sequence (M-new doesn't defer M1). See phase3-resequence-mcp-first-2026-04-20.md §Q5.3 M-new + M-enhance + §Q2.2.` |

**Entries that stay unchanged** (per handoff §Hard constraints):

- **D45** L3A full-fidelity EDITOR-ONLY — stands. Skeletal-subset S-B (19 K2Nodes) is not full-fidelity (200+ K2Nodes). Verified in §Q4.1.
- **D52** near-plugin-parity for offline READs — stands with implicit sharpening. Plugin scope further narrows to plugin-only categories (a)/(c)/(d)/(w) + reflection-live-deltas; edge-topology (b) moves to offline.
- **D53** Phase 3 plugin-TCP surface refinement (86 tools, 6 DROP, 3 MOVE-TO-SIDECAR, etc.) — stands. The 3 MOVE-TO-SIDECAR annotations get implicit reframe via D54 amendment (move to offline-primary + enhancement-augmented rather than sidecar-primary), but D53's tool counts and D52 category assignments hold.
- **D56** get_widget_blueprint SPLIT — stands. EventGraph subset reframe inherits from D54 (offline-primary rather than sidecar-primary); widget-tree KEEP (reduced) plugin-TCP unchanged.

**Orchestrator action**: 4 blockquote amendments on D48/D54/D55/D57; zero amendments on D45/D52/D53/D56. Proposed text is 2-4 sentences each per handoff §Q6; can be shortened at orchestrator's discretion.

---

## §Q7 — Framing-audit notes on this handoff

Per memory `feedback_framing_audit.md`: push back on things the handoff got wrong within the corrected framing (don't re-relitigate the framing correction itself).

### §FA-α — "Skeletal-subset S-B" framing masks which subset matters

**Concern**: handoff §"What's NOT being relitigated" reads: *"The corrected framing asks for **skeletal-subset S-B** — pin-trace on the 19 shipped skeletal K2Node types + a bounded extension set, not full 200+ fidelity."* This wording suggests skeletal-vs-full is the primary axis. The real axis is **edge topology vs full-fidelity**: S-B's load-bearing deliverable is pin-ID → pin-ID edge resolution (for the 19 skeletal types), not a richer semantic payload. A future EN-4-style "graduate math operators to S-A" extension would NOT change S-B's scope — S-B operates on the pin-binary layer beneath semantic extraction.

**Finding**: the 19-type subset is the scope envelope, not the foundational innovation. Even if the skeletal set grows to 24 types (EN-4 math operators graduate), S-B's cost structure doesn't scale linearly — it's the pin-binary RE + LinkedTo resolution + version-skew that dominate, and those are one-time costs regardless of K2Node coverage. Pitching re-sequence as "skeletal S-B" can make orchestrators misunderstand the investment.

**Impact**: low — doesn't change M-new cost or scope — but §Q5.3 M-new phrasing explicitly names "pin-topology foundation" rather than "skeletal parser extension" to avoid this misread.

### §FA-β — "Plugin enhances" needs a workflow stress-test

**Concern**: handoff treats "enhanced by plugin" as clean contract ("offline works; plugin adds enrichment"). In reality, workflow expectations can blur the line. Example: a user runs `bp_show_node` in a plugin-absent context. Without M-enhance, the response has no compiled-shader data, no live UObject property values, no compile errors. The user's mental model might be "plugin adds spatial overlay" (via_knots etc.) not "plugin adds five categories of field that look baseline." If the offline verb response doesn't clearly signal "here's what's available offline vs what needs plugin," the UX suggests plugin-absent is a degraded baseline rather than a first-class functional contract.

**Finding**: the verb response shape needs to carry an explicit `{available: {...}, enhanced: {...}}` manifest so callers distinguish "we have this data" from "plugin could add this." This is a **tool-surface-design consequence** of the framing correction that's not in the handoff's Q1-Q6 structure. Sample shape per verb call:

```jsonc
{
  "node": {...},
  "available_fields": ["id", "type", "class_name", "linked_to", "pos", "enabled"],
  "plugin_augmented_fields": [],   // empty when M-enhance absent or editor offline
  "not_available": {
    "live_value": "plugin_required_or_phase4_rc",
    "compile_errors": "plugin_required",
    "edit_metadata_flags": "plugin_required_or_phase4_rc"
  }
}
```

**Impact**: M-new + M-spatial handoffs should explicitly specify the response-shape manifest convention. Orchestrator flag for drafting.

### §FA-γ — M-spatial is not in the handoff's Q5 skeleton

**Concern**: handoff §Q5 lists M-new (pure-offline edge parser + 9 verbs) as single deliverable. My analysis of the 9 verbs (§Q3) shows 3 of them (`bp_list_graphs`, `bp_find_in_graph`, `bp_subgraph_in_comment`) don't need pin topology at all — they need position extraction + point-in-rect math. Splitting that as a 1-2 session M-spatial milestone ships 3 verbs + partial `bp_list_entry_points` + partial `bp_show_node` **before** M-new lands (which is 6.5-10 sessions). That's useful leverage the handoff's Q5 framing misses.

**Finding**: M-spatial is a defensible intermediate milestone. It:
1. De-risks the 9-verb delivery (3 verbs ship immediately; M-new isn't the only pathway).
2. Unblocks workflows that need `bp_subgraph_in_comment` faster (catalog-demanded workflow per Sidecar Design Q2).
3. Shares no dependencies with M-new beyond the tag-iteration infrastructure already shipped.
4. Doesn't inflate total cost — the 1-2 sessions were implicit in M-new's 9-verb delivery anyway; splitting just surfaces them as a separately-dispatchable unit.

**Impact**: §Q5 includes M-spatial as a first-class milestone. Recommend orchestrator adopts it; if M-spatial is folded into M-new at dispatch time, the cost accounting doesn't shift — worker just ships them sequentially in one larger session batch.

### §FA-δ — "Plugin-absent state first-class functional" must be testable

**Concern**: handoff framing says *"plugin-absent state is first-class functional."* If this contract isn't enforced by test assertions, it will drift under M-new implementation pressure — the worker will naturally reach for "sidecar path + offline fallback" patterns because that's D54's familiar mental model.

**Finding**: M-new's test harness must include an explicit **plugin-absent + sidecar-absent integration test** that runs all 9 verbs against a real BP fixture with `UNREAL_PROJECT_ROOT` set but no editor running and no `Saved/UEMCP/BPCache/` directory present. For S-B-dependent verbs (`bp_trace_exec` et al), the assertion is `response.available == true` + response payload matches a known-correct topology (not `{available: false}`). For enhancement-dependent fields within those verbs (e.g., `via_knots` annotation), the assertion is `fields_not_available.includes("via_knots")` — graceful degradation signal.

**Impact**: M-new handoff must specify this test as a shipping criterion. Without the test, the "first-class functional" contract is prose, not code — drifts under pressure.

### §FA-ε — Enhancement-layer narrowing changes Phase 4 boundary

**Concern**: under D54's M2-Phase-A scope, the sidecar carried rich BP data and Phase 4 RC API was for Phase 3 not covering runtime state. Under re-sequence, M-enhance's runtime/compile/reflection TCP brokers absorb capability that was originally Phase 4 scope. This blurs the Phase 3/Phase 4 boundary more than D54 did.

**Finding**: two plausible framings:
- **(a)** M-enhance TCP brokers stay; Phase 4 RC API becomes marginal (primarily alternative-transport, not new capability).
- **(b)** M-enhance TCP brokers are deferred to Phase 4; M-enhance narrows to just the narrow-sidecar + save-hook + 3F-4 commandlet components. Runtime/compile/reflection queries get served by Phase 4 RC API per current project framing.

My §Q5.3 M-enhance scope implicitly adopts (a) (brokers inside M-enhance). (b) is defensible — in fact cleaner — if orchestrator wants Phase 4 RC API to stay a first-class deliverable rather than a de-scoped remainder.

**Impact**: orchestrator decision. §Q5.3 M-enhance can drop the runtime/compile/reflection brokers if (b) preferred — reduces M-enhance to 2-3 sessions (from 3-5). Downstream: M4 reduced-reads don't shift because the specific tools affected (`get_blueprint_info` interface list, `list_data_asset_types`, `get_editor_utility_blueprint`) remain plugin-TCP either way; only the priming of those responses via cached sidecar shifts between M-enhance scope and M4 scope. Flag for orchestrator; either choice is internally consistent.

### §FA-ζ — 3F-4 commandlet splits into dev-oracle and production variants

**Concern**: handoff §"D-log anchors reopened" flags D57 for amendment but doesn't anticipate that 3F-4 commandlet ends up in TWO milestones (M-new bootstrap-oracle + M-enhance production prime). This is a concrete amendment detail D57 needs.

**Finding**: the dev-oracle variant is minimal (~120-180 LOC + 40 LOC edge-only serializer) vs production variant (shares full narrow-sidecar serializer at 400-600 LOC). They're not the same artifact, but they share the `UCommandlet` skeleton. Sharing the serializer is NOT possible because dev-oracle emits edge-only format for S-B validation; production emits the narrow-sidecar plugin-only-fields format. Different output shape, different consumers.

**Impact**: reflected in D57 amendment text in §Q6. Orchestrator should explicitly dispatch these as separate scopes (dev-oracle inside M-new Oracle-A sub-worker; production inside M-enhance plugin worker) rather than folding them. Separate handoffs.

---

## §Appendix A — Input files consulted

### Tier 1 — Prior scope decisions
1. `docs/research/phase3-scope-refresh-2026-04-20.md` (commit `9e9dbe5`, amended `286fbad`) — current M-sequence ✓
2. `docs/research/m-alt-commandlet-feasibility-2026-04-20.md` (commit `44b080e`) — coverage table + empirical commandlet measurements ✓
3. `docs/research/level3a-skeletal-parse-study.md` (Agent 11.5) — original S-A/S-B split + 8-13 session cost estimate ✓
4. `docs/research/level3-feasibility-study.md` (Agent 11) — L3A EDITOR-ONLY framing ✓
5. `docs/research/sidecar-design-resolutions-2026-04-19.md` — Sidecar Design Session resolving Q1-Q5 ✓
6. `docs/specs/blueprints-as-picture-amendment.md` — sidecar schema + verb surface ✓

### Tier 2 — Shipped offline surface
7. `server/uasset-parser.mjs` (1054 lines) — existing binary parser; S-B extends this ✓
8. `server/offline-tools.mjs` (1935 lines) — shipped offline tool handlers; S-B verbs slot in. Verified skeletal-19 set at lines 1591-1607 ✓
9. `docs/audits/post-agent10-5-codebase-audit-2026-04-19.md` — parser health (not directly re-read; relied on CLAUDE.md summary + referenced sections in scope-refresh / M-alt for current state)

### Tier 3 — D-log anchors
10. `docs/tracking/risks-and-decisions.md` D45, D48, D52, D53, D54, D55, D56, D57 — read full entries ✓

### Tier 4 — UE 5.6 reference (for §Q1 cost re-evaluation)
11. Engine source referenced via Agent 11.5 §2.1-§2.2 findings (CUE4Parse `FEdGraphPinType.cs` + UAssetAPI `/ExportTypes/` + UE forum on UEdGraphPin-not-UCLASS). Direct Engine/Source reading deferred — Agent 11.5 already catalogued reference-absent for the load-bearing pin-binary layer; re-catalogue adds no signal.

### Tier 5 — Current state verification
12. `git log --oneline -15` — confirmed HEAD `64bba6c` (handoff-queue commit). Clean working tree aside from the pre-existing `.claude/settings.local.json` + `.mcp.json` (untracked, inherited from repo state at research start).
13. `docs/tracking/backlog.md` — DR-1 S-B entry + queued M0-M6 list ✓

---

## §Appendix B — Cross-reference tables

### §B.1 Verb → milestone mapping (consolidated)

| Verb | Ships in |
|------|----------|
| `bp_list_graphs` | Today (L0 via `inspect_blueprint`) + M-spatial extension |
| `bp_list_entry_points` | M-spatial (class-identity partial) → M-new (pin-less-entry precision) |
| `bp_trace_exec` | M-new |
| `bp_trace_data` | M-new |
| `bp_show_node` | M-spatial (partial) → M-new (pin block) → M-enhance (compiled/runtime fields) |
| `bp_neighbors` | M-new (edge mode) + M-spatial (spatial mode) |
| `bp_subgraph_in_comment` | M-spatial |
| `bp_find_in_graph` | Today (S-A `find_blueprint_nodes`) + M-spatial (whole-graph scope) |
| `bp_paths_between` | v1.1 (post-M-new stabilization) |

### §B.2 D52 category assignments (unchanged; sharpened on (b))

| Category | What it covers | Plugin-only? | Re-sequence impact |
|----------|----------------|--------------|---------------------|
| (a) runtime/PIE state | Live UObject values, PIE snapshots | YES — always | Served by M-enhance TCP brokers (or Phase 4 RC API per FA-ε) |
| (b) UEdGraph pin topology | Edge topology, pin data | **NO (corrected framing)** — offline via M-new | Category narrows — S-B covers the skeletal 19-type subset offline; pre-re-sequence this was plugin-or-sidecar |
| (c) compiled/derived data | Shader uniforms, Niagara VM, baked anim | YES | Served by M-enhance TCP brokers |
| (d) reflection-only metadata | UPROPERTY flags, UFUNCTION metadata | YES | Served by M-enhance TCP brokers |
| (w) writes | All mutation ops | YES | Served by M1 + M3 + M5 (unchanged) |
| (reflection-live-deltas) | Unsaved editor modifications | YES | Served by plugin-live-TCP query (unchanged from D52 implicit scope) |

### §B.3 Milestone → commit state at dispatch-ready

| Milestone | Pre-dispatch commit SHA | Next-dispatch target |
|-----------|-------------------------|----------------------|
| M0 | Shipped at `aa0d966` | — |
| M1 | Handoff drafted, not dispatched (`2ab0969` handoff-queue) | Dispatch after this research lands |
| M-spatial | Not yet drafted | Draft post-research |
| M-new Oracle-A | Not yet drafted | Draft post-research |
| M-new S-B-base | Blocked on Oracle-A | Draft after Oracle-A lands |
| M-new S-B-overrides + Verb-surface | Blocked on S-B-base | Draft after S-B-base lands |
| M-enhance | Blocked on M1 (TCP scaffolding) | Draft after M1 lands |
| M3/M4/M5 | Blocked on M1 + M-new | Draft progressively |

---

## §Appendix C — Confidence

**Overall: MEDIUM-HIGH**. Component breakdown:

- **§Q1 S-B re-scope (6.5-10 sessions)**: MEDIUM-HIGH. D55 breakdown directly reused; oracle-substitution adds 0.5-1 session. Base pin-block RE cost is the load-bearing unknown; Agent 11.5 §2.2 zero-reference finding means engine-source RE remains the method, oracle choice secondary.
- **§Q2 enhancement contract**: HIGH. Walk of 13 categories × offline-feasibility is mechanical; 7 offline-feasible categories are verifiable (they're UPROPERTY reads or derivatives of same); 5 plugin-only are D52 categories (a)/(c)/(d)/(w)/(reflection-live) from independent justification.
- **§Q3 verb degradation table**: HIGH. 9 verbs each assessed against "what data does this need" + shipped-offline surface inventory. Degradation shapes are specified concretely (`{available: false}` vs `{field_missing: true}` vs full response).
- **§Q4 closure**: HIGH. D45 full-fidelity vs skeletal distinction is crisp; sidecar-free future stays rejected per unchanged D52.
- **§Q5 M-sequence**: MEDIUM. Cost ranges inherit scope-refresh §Q5.3 where unchanged; M-new 6.5-10 + M-spatial 1-2 + M-enhance 3-5 are new estimates. M-spatial confidence HIGH (simple UPROPERTY extension). M-enhance confidence MEDIUM (narrow-sidecar saves cost; TCP-broker adds cost; net uncertain).
- **§Q6 D-log amendments**: HIGH. Which entries need amendment is mechanical from handoff §"reopened" + §"NOT reopened" lists. Proposed blockquote text is 2-4 sentences each; orchestrator can shorten.
- **§Q7 framing audit**: MEDIUM-HIGH on each concern. FA-γ (M-spatial as separate milestone) is the most load-bearing; FA-ε (enhancement vs Phase 4 boundary) is the most discretionary.

**Grounded vs speculative**:
- GROUNDED: D-log entries (direct reads); shipped-code surface (grep of `server/offline-tools.mjs`); cost breakdowns inherited from D55/M-alt.
- GROUNDED: verb-by-verb degradation analysis (mechanical from Sidecar Design Session §Traversal verb surface + shipped offline inventory).
- SPECULATIVE: M-new 6.5-10 range high-end (version-skew buffer is inherently uncertain until 5.7 fixtures exist); M-enhance 3-5 range (TCP-broker scope uncertain — depends on orchestrator FA-ε resolution).

**Did-not-do-but-could-have**:
- Did NOT re-run 825-assertion test baseline (handoff flagged as optional; CLAUDE.md baseline accepted).
- Did NOT directly read Engine/Source `EdGraphNode.{h,cpp}` or `EdGraphPin.h` — relied on Agent 11.5 §2.1-§2.2 catalogued findings. If M-new S-B-base dispatches, worker's first step should be direct engine-source RE; this research's job is scope/sequence, not implementation.
- Did NOT empirically measure per-BP `LoadPackage` time in commandlet mode — M-alt §Q1.6 projections inherited; only matters for M-enhance production 3F-4 commandlet batch-prime timing, not M-new S-B-development dev-oracle.
- Did NOT stress-test the "defer M-enhance" subset scenario (§Q5.5 row 2) against workflow catalog to confirm no catalog row blocks. Spot-check via catalog rows 40/73 (live tag state) + runtime-state rows would tighten.

---

## §Final Report

```
Phase 3 Re-sequencing — Final Report (MCP-first, plugin-enhances)

Framing correction (Noah 2026-04-20):
  "offline-first edge topology; plugin-enhances, not plugin-enables"

S-B re-scope (Q1): ~6.5-10 sessions (was 6-9 under D55 after-sidecar)
  Base pin-block RE:      3-4 (unchanged)
  Per-node overrides:     ~1 (unchanged; 19-type scope envelope)
  LinkedTo resolution:    1-2 (unchanged)
  Version-skew buffer:    2-3 (unchanged; 5.6↔5.7 format delta)
  Bootstrap oracle NEW:   0.5-1 (differential commandlet + corpus)

Plugin enhancement contract (Q2):
  Offline-primary:  8/13 categories (positions, comments, contains,
                    via_knots, enabled, pin defaults, knot identity, etc.)
  Plugin-only:      5/13 categories (runtime/PIE, compiled/VM,
                    compile errors, reflection flags, live-unsaved edits)

Verb degradation modes (Q3):
  Wave 1 (ships today or M-spatial):    5 verbs partial/full
  Wave 2 (ships M-new):                 5 S-B-dependent verbs
  Wave 3 (v1.1):                        bp_paths_between
  First-class-plugin-absent contract:   enforced via test harness (FA-δ)

Closure reaffirmation (Q4):
  D45 (full-fidelity L3A EDITOR-ONLY):       STANDS
  D52 (near-parity; plugin writes + hard-infeasible reads): STANDS
  Plugin still needed for writes (35 tools), runtime, compiled, reflection

Updated M-sequence (Q5):
  M0 yaml grooming:        0.5 (shipped aa0d966)
  M1 TCP scaffolding:      3-5  ∥ M-spatial (1-2)  ∥ M-new (6.5-10)
                                    ↓
                           (9 verbs live; edge topology first-class offline)
                                    ↓
  M-enhance:               3-5  ∥ M3 (6-10)  ∥ M4 (3-5)  ∥ M5 (6-10)
  Total:                   26.5-43 sessions; ~14-22 wall-clock

D-log amendments needed (Q6):
  D48  S-B FOLD-INTO-3F → supersede (primary, not folded)
  D54  SHIP-SIDECAR-PHASE-A-FIRST → supersede (enhancement, not foundation)
  D55  PURSUE-AFTER-SIDECAR → reverse ordering (S-B first, 6.5-10 with oracle)
  D57  PRESERVE+AUGMENT → substrate amendment; 3F-4 splits dev/production
  D45, D52, D53, D56: STAND

Framing-audit (Q7):
  FA-α  "skeletal-subset S-B" phrasing → replace w/ "edge topology foundation"
  FA-β  "plugin enhances" needs response-shape manifest convention
  FA-γ  M-spatial is defensible separate milestone (not in handoff Q5)
  FA-δ  "first-class functional" must be test-harness asserted
  FA-ε  M-enhance TCP brokers vs Phase 4 RC API boundary call needed
  FA-ζ  3F-4 commandlet splits into dev-oracle + production variants

Orchestrator-actionable next dispatches:
  1. M1 (TCP scaffolding, 3-5) — write-gated; !IsRunningCommandlet gate
  2. M-spatial (1-2) — position + comment extraction + 3 non-S-B verbs
  3. M-new Oracle-A (0.5-1) — differential commandlet + corpus
  Parallel kickoff; 3 workers; path-limited commits per D49.

  After Oracle-A: M-new S-B-base (4-6).
  After M1: M-enhance (3-5 per FA-ε resolution).

Confidence: MEDIUM-HIGH.
  HIGH on Q2/Q3/Q4/Q6; MEDIUM-HIGH on Q1/Q7; MEDIUM on Q5 range bounds.

Deliverable: docs/research/phase3-resequence-mcp-first-2026-04-20.md
```
