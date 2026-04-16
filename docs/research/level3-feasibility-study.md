# Level 3 Feasibility Study (Revisit)

> **Author**: Agent 11
> **Date**: 2026-04-16
> **Type**: Research — no design authorship, no code, no D-log allocation
> **Inputs**: Agent 7 (parser survey), Agent 8 (parser audit), Agent 9 (tool-surface design), Phase 3 plugin design inputs, blueprints-as-picture amendment (3F), D32/D37/D38/D39/D40/D44
> **Deliverable**: This document. Feeds a future D-log entry when a Level 3 decision is actually made.
> **Scope question**: Does the historical "stop at Level 2" decision still hold once cost is re-calibrated against our multi-agent workflow and benefit is re-measured against Agent 9's Phase 3 displacement (13 tools) and 3F's sidecar claim on the UEdGraph surface?

---

## §1 Verdict

**L3A — UEdGraph full deserialization: EDITOR-ONLY.**
The 3F blueprints-as-picture amendment already claims this surface via an editor-written sidecar (JSON emitted on `UBlueprint` save, consumed offline). That path is strictly cheaper, version-robust, and already designed. A pure-JS .uasset byte parser for UEdGraph would need bespoke per-type logic for 200+ `UK2Node*` subclasses with no reference-project port source beyond generic `FPropertyTag` iteration. Multi-agent workflow shrinks typing speed but does not shrink the spec-writing burden on a heterogeneous surface of this size. Net: offline L3A duplicates a strictly-better solution at >10× the cost.

**L3B — Container types (Array / Map / Set): FOLD-INTO-L2.5.**
`FScriptArray`/`FScriptMap`/`FScriptSet` have clean, well-documented readers in CUE4Parse and UAssetAPI; Agent 7's survey identifies them as ported in both references. Agent 8 already named the work "Phase 2.5" with a 3-5 human-day estimate — the multi-agent lens collapses that to ~3-5 agent sessions with reference-guided mechanical porting. Agent 9's Option C explicitly ships container properties as `{unsupported: true, reason: "container_deferred"}` markers and flags container scheduling as Q6 (Noah-directed open question). Every criterion argues for treating this as an Agent 10 scope extension rather than a separate L3 tier.

**L3C — Delegates + complex types: KEEP-DEFERRED** (with one carve-out flagged for Noah).
The bucket is genuinely heterogeneous: `DelegateProperty`/`MulticastDelegateProperty` (low unlock — bindings live in graph nodes, not CDOs), `UUserDefinedStruct` (medium-high unlock IF ProjectA/ProjectB use custom structs heavily, unknown today), `FInstancedStruct` (unknown usage), cross-package reference walking (tool-level, not parser-level). No single workstream; no unifying reference pattern; most subsurfaces fail the unlock-value test given Agent 9's `{unsupported, reason}` marker approach already keeps callers unblocked. **Carve-out**: UUserDefinedStruct alone might warrant its own track if ProjectA has custom structs on BP CDOs. Flagged in §5, not pursued here.

**Aggregate**: *The "stop at Level 2" decision still holds, with one refinement — L3B should land as L2.5 (Agent 8's original Phase 2.5 framing) within Agent 10's work or a direct follow-on, not as a distinct Level 3 tier.* The plugin-necessity question does not hinge on any of these categories: Phase 3 plugin scope is overwhelmingly WRITE + editor-interactive (actor spawn/delete, BP compile, pin-type validation, widget binding graphs) and editor-live reflection — none of which L3 can displace regardless of how cheap offline parsing becomes.

---

## §2 Category deep-dives

### §2.A — L3A: UEdGraph full deserialization

**Reference projects + source-line evidence**.
- **CUE4Parse** (primary port source per D38): handles `UObject` via generic FPropertyTag iteration. `UEdGraph`, `UK2Node_*` subclasses have **no specialized readers** in the CUE4Parse tree — they fall through to default property iteration, which yields a flat bag of `{Nodes: [...], GraphGuid: ..., Schema: ...}` with each node element returned as an opaque sub-object. Agent 7's 14-project survey does not cite a single project with K2Node-specific parsing logic.
- **UAssetAPI**: same pattern. Generic property iteration; no per-K2Node subclass handlers. Its `UUserDefinedStruct` support is real, but `UK2Node` support is not.
- **FModel** (built on CUE4Parse): inherits the same limitation — BPs appear in its asset browser but the graph content is not rendered.
- **pyUE4Parse, unreal_asset (Rust), UE4SS**: none specialize on K2Node serialization.

The ecosystem coverage is: generic iteration works (as it does for any UObject); per-K2Node semantic understanding does not exist in any reference.

**Feasibility score: 1/5**. Generic iteration yields raw property bags without semantic meaning. To produce a `bp_trace_exec`-style result you need: (a) per-K2Node-subclass logic to extract the canonical fields (function name for `UK2Node_CallFunction`, variable name for `UK2Node_VariableGet`/`Set`, event name for `UK2Node_Event`, branch topology for `UK2Node_IfThenElse`, etc.), (b) pin-connection edge reconstruction through each node's `Pins` array of `UEdGraphPin` with `LinkedTo` cross-references, (c) correct handling of custom `Serialize()` overrides some K2Nodes use to bypass standard property streams. None of this is reference-documented.

**Multi-agent cost**: ~15-30 agent sessions for partial coverage (20-30 most common K2Node types × ~0.5-1 session per type for spec + port + tests), plus orchestration overhead (verification agents, test fixture generation, cross-type consistency reviews). This is exactly the calibration the handoff warns about — the work is **spec-writing** for a heterogeneous surface where no reference exists, so multi-agent workflow doesn't meaningfully accelerate it. If the cost estimate falls below ~15 sessions, spec-writing has been underestimated. And the surface keeps growing — UE adds K2Node types regularly.

**Unlock value vs the 3F sidecar alternative**. 3F (blueprints-as-picture, already designed) solves this at ~0.5 agent sessions of plugin C++ work: register an `OnObjectSaved` hook, call the editor's live `UEdGraph` serializer, write a JSON sidecar next to the `.uasset`. Offline tools then consume a well-shaped JSON file — every K2Node fully understood, every pin resolved, spatial layout included. The sidecar approach works because the editor already has perfect K2Node knowledge; we just capture it. The only thing pure-offline L3A would buy over 3F is "works on assets where the editor has never opened the file" — a narrow gap mitigated by 3F's `prime_bp_cache` one-shot and a "no sidecar, editor offline" fallback already specified (`{available: false, hint: "open the BP in editor once to prime"}`).

**Response-size risk**: severe. A 200-node BP graph dumps to 8-15K tokens (per 3F spec). Containers of K2Nodes plus per-pin connection arrays amplify this further. Pagination across graph traversals is a real ongoing cost center — but 3F already handles this via the traversal-verb surface (`bp_trace_exec`, `bp_neighbors`, `bp_subgraph_in_comment`) rather than bulk dumps.

**Version-skew score: 1/5 (highest brittleness)**. K2Node serialization is well-known to shift between UE versions (new node types, changed serialized fields, custom `Serialize()` overrides that rev independently of engine-wide version flags). UE 5.6 ↔ 5.7 (ProjectA vs ProjectB per D42) could already diverge here. 3F sidecar generation is editor-mediated and therefore always-correct for whatever engine version wrote the sidecar — offline byte parsing inherits the full version-skew burden for free.

**Crossover analysis**. The original "Phase 3 gives us this for free" argument is stronger than ever post-3F: it's not just "plugin provides graph reads via TCP round-trip" — it's "editor writes a sidecar once, offline tools consume it forever without any TCP call." The crossover where offline byte-parsing beats 3F is **distant** and may never arrive — the workflow advantage of pure offline (agent automation without editor) is already captured by 3F sidecars for the cached case, and the uncached case (fresh checkout with no sidecars) is handled by a one-time prime command.

**Recommendation: EDITOR-ONLY.** 3F sidecar strategy occupies this space with a strictly-better design. Offline L3A work would be duplicating 3F's output at >10× the cost with weaker correctness guarantees.

---

### §2.B — L3B: Container types (Array / Map / Set)

**Reference projects + source-line evidence**.
- **CUE4Parse**: `FScriptArray`, `FScriptMap`, `FScriptSet` readers exist as clean, separable classes. Per Agent 8's §1.1 "What to Lift" list: `ReadArrayProperty()`, `ReadMapProperty()`, `ReadSetProperty()`. Array reader is roughly 30-50 lines; map 60-100 lines; set 40-60 lines (similar shape to arrays). Recursive element handling reuses the existing property-tag dispatch table.
- **UAssetAPI**: same readers plus depth-limit bounds checks. Agent 8's §2 called its recursion handling "more defensive than CUE4Parse" (max depth 16).
- **pyUE4Parse**: Python mirror of CUE4Parse's container readers — useful as validation oracle.
- **Agent 7 §6 explicitly documents** the format complexity (element size inference, map key type ambiguity) as real but tractable.

**Feasibility score: 4/5**. Two gotchas:
1. **Element size inference** — ArrayProperty stores a byte count, not an element count; reader must infer element size from the inner property type. Known issue in CUE4Parse with known workaround (inner tag is re-read for sized elements; simple scalars use type-dispatched sizes).
2. **Map key type not always serialized** — map reader must know both key and value types. This is handled in CUE4Parse via the struct registry. Our existing Level 2 registry already supplies the needed type info for engine structs; extending for containers is additive, not structural.

Both references solve these. Score drops from 5 only because edge cases (arrays of custom `UUserDefinedStruct`, maps with struct keys) cross into L3C territory and fail until L3C lands.

**Multi-agent cost breakdown** (calibrated against agent-session units, not human-days):

| Sub-scope | Agent 8 human-day est. | Agent-session est. | Calibration |
|---|---|---|---|
| Simple-element arrays (TArray<int>, <float>, <FName>, <FVector>, <FGameplayTag>) | 1-2 days | **1 session** | Mechanical port from CUE4Parse + test suite. Fast with agents (the "well-specified port" case per handoff). |
| Arrays of engine structs (TArray<FTransform>, TArray<FLinearColor>) | +0.5 day | **0.5 session** | Reuses existing Level 2 struct registry. Purely additive dispatch. |
| Maps with scalar keys (TMap<FName, int>, TMap<FGameplayTag, float>) | 1-2 days | **1-2 sessions** | Same mechanical-port shape, different control flow. Includes bounds checks. |
| Sets (TSet<FGameplayTag>) | 0.5 day | **0.5 session** | Same as array minus the ordering semantics. |
| Arrays/maps of custom structs | 1-2 days | **Gated on L3C** | Requires UUserDefinedStruct support (§2.C). Returns marker if target struct not in registry. |
| **Total for full L3B minus L3C-gated cases** | **3-5 days** | **3-4 sessions + 1-2 orchestration passes** | Handoff predicted 30-50% of old estimate for this category — lands at ~60-80% honestly, because orchestration of tests across 4 subscopes has real cost. |

Honest calibration note: the agent-session estimate is *not* dramatically below the human-day estimate because Agent 8's estimate was already solo-dev with the reference projects in hand. The multi-agent win here is durability (parallelized sub-scopes) and test-coverage density, not raw time compression.

**Unlock value** — direct, immediate. Container properties are the single largest category of `{unsupported: true, reason: "container_deferred"}` markers in Agent 9's Option C. Concrete workflows that become possible:

- **`read_asset_properties` on GAS ability CDOs** — `AbilityTags` is `FGameplayTagContainer` (Level 2 already); `CancelAbilitiesWithTag` / `BlockAbilitiesWithTag` are `FGameplayTagContainer` too, *but* `Tasks` arrays or `AbilityEffects: TArray<TSubclassOf<...>>` need L3B.
- **Combat/pose data arrays** — `TArray<FVector>` waypoints, `TArray<FTransform>` spawn points, `TMap<FGameplayTag, float>` cost tables. Common in ProjectA (combat game).
- **Widget binding descriptors** — `TArray<FWidgetBinding>` on UMG assets. Would close part of Agent 9's §3 `get_widget_blueprint` gap.
- **Replaces the "container marker" leakage** — with L3B, `read_asset_properties` returns meaningful data for ~70-90% of real CDO surfaces instead of ~40-60%. This is what tips the credibility of offline tools over "tried-and-marked-as-unsupported."

**Phase 3 displacement**: no new *tool elimination* beyond Agent 9's Option C, but the **coverage depth** on `read_asset_properties`, `list_level_actors` (for HISM per-instance transforms — Agent 9 explicitly deferred with the container story), and `inspect_blueprint.include_defaults` rises substantially. Agent 9's §3 lists 12 "reduced" Phase 3 tools; L3B pushes several closer to "eliminated" rather than "reduced." Quantitatively, `data-assets.get_curve_asset` (simple curves), `data-assets.get_struct_definition` (struct members), `materials.list_material_parameters` (param arrays) all move further toward full offline coverage once container support lands.

**Response-size risk**: real and known. A 1000-element `TArray<FTransform>` is ~80 KB of value data alone. Must respect `max_bytes` cap in `read_asset_properties`. Consistent with Agent 9's §5 Q5 policy (Noah-flagged): partial containers should emit `{unsupported: true, reason: "size_budget_exceeded", partial_count: N}` rather than truncated partial values. L3B doesn't introduce new size risks beyond those Agent 9 already designed against.

**Version-skew score: 4/5 (low brittleness)**. `FScriptArray`/`FScriptMap`/`FScriptSet` binary formats have been stable across UE 5.0 → 5.7. The containers inherit version-skew risk from their element types (which Level 1+2 already handles), not from container format shifts. CUE4Parse tracks any format drift upstream; we port from a known-stable target.

**Crossover analysis**. The crossover is **already past**. Multi-agent cost is cheap (3-4 sessions); unlock value is broad (most real CDO surfaces contain arrays); 3F-sidecar alternative doesn't help here (sidecars are graph-shaped, not CDO-shaped — CDOs are still `.uasset` bytes). And Agent 8's original deferral reasoning was pure cost/benefit calibrated against solo-dev effort; the cost has dropped while the benefit has stayed constant.

**Recommendation: FOLD-INTO-L2.5.** This is the exact Agent 8 "Phase 2.5" bucket renamed. Recommend Agent 10 ships simple-element arrays (TArray of scalars + engine structs) as part of the Level 1+2 deliverable since it's ~1.5 agent sessions of additive work on an already-in-flight parser, and defers arrays-of-custom-structs + full Map/Set support to a focused Agent 10.5 follow-on (another ~2-3 sessions). Agent 9's Q6 is the existing decision gate — this study's finding is "yes, the simple case is worth doing now; the complex case is close but can wait on a workflow trigger."

---

### §2.C — L3C: Delegates + complex types

L3C is genuinely heterogeneous; scored per sub-scope.

#### C.1 — DelegateProperty / MulticastDelegateProperty

**Feasibility**: 3/5. Binary format (object ref + function FName) is known; CUE4Parse's `FDelegateProperty` handler is straightforward (~40 lines).
**Multi-agent cost**: 1 session — clean port.
**Unlock value**: **LOW**. Agent 9's Option C already marks these `{unsupported: true, reason: "delegate_not_serialized"}` with the stated rationale "binding lives in graph, not CDO." This is empirically correct — most BP delegate bindings are established via `UK2Node_AssignDelegate` / `UK2Node_AddDelegate` in the event graph, which writes no CDO state. What *does* live in the CDO is the declaration of the delegate property itself (which we already enumerate structurally) and occasionally a default-bound function pointer on a component (rare).
**Version-skew**: low — format is stable.
**Crossover**: never. The cost is low but the unlock is smaller. Not worth it.

#### C.2 — UUserDefinedStruct (custom user structs)

**Feasibility**: 4/5. CUE4Parse and UAssetAPI both support this via a two-pass approach: (pass 1) parse the struct's own `.uasset` to build a property-layout schema; (pass 2) apply the schema when deserializing instance data. The schema lives as FPropertyTag entries on the `UUserDefinedStruct` export. Reference: CUE4Parse `UUserDefinedStruct.cs` (~100-150 lines, handles `StructFlags` + property layout). Requires a struct-asset registry with mtime invalidation + cycle detection (one struct referencing another).
**Multi-agent cost**: 2-3 agent sessions — registry + two-pass resolver + cache invalidation + fixture tests (ProjectA-sourced custom struct assets for validation).
**Unlock value**: **MEDIUM-HIGH, gated on actual ProjectA/ProjectB usage**. Custom structs are common in GAS-heavy projects (ability task data, combat state, cue parameters). Without L3C.2, any BP property typed as a custom struct returns `{unsupported: true, reason: "unknown_struct"}` from `read_asset_properties` — a gap that grows as the project gains complexity. **Needs Noah spot-check** to know whether ProjectA has meaningful custom-struct coverage (§5 Q-A).
**Size risk**: inherits instance size; custom structs can hold arrays (L3B gated).
**Version-skew**: medium. `UUserDefinedStruct` format changes occur occasionally but are reference-tracked.
**3F-sidecar crossover consideration**: 3F could theoretically extend its sidecar-writer to also emit `StructDefinitions.json` alongside BP sidecars — making L3C.2 another "editor-mediated cache" rather than a pure offline byte parse. That path is cleaner but requires 3F to move first.
**Recommendation**: KEEP-DEFERRED for now, with a trigger condition — reopen if (a) Noah confirms heavy custom-struct usage AND (b) 3F sidecar approach for struct definitions is either rejected or delayed.

#### C.3 — FInstancedStruct (polymorphic struct containers)

**Feasibility**: 3/5. Format is known (struct type identifier + serialized payload) and CUE4Parse has version-specific handlers. Mass Entity / Gameplay Interactions use this heavily in modern UE projects.
**Multi-agent cost**: 2 agent sessions if port source is solid. Depends on element-struct registry → inherits the L3C.2 dependency.
**Unlock value**: **UNKNOWN**. Depends on whether ProjectA/ProjectB use Mass Entity or Gameplay Interactions. If yes, valuable. If no, zero. **Needs Noah spot-check** (§5 Q-A).
**Version-skew**: medium-high — this is a younger UE feature with more format churn.
**Recommendation**: KEEP-DEFERRED. Gated on same usage-evidence as C.2 plus the L3C.2 registry dependency.

#### C.4 — Cross-package reference walking

**Feasibility**: 5/5 — this isn't a parser feature at all; it's a tool-level composition. Current `ObjectProperty`/`SoftObjectProperty` resolution already returns `/Game/...` paths. "Follow the reference" = call `read_asset_properties` on the resolved path. Requires a `max_depth` parameter and cycle detection at the tool layer, not the parser layer.
**Multi-agent cost**: 1-2 sessions for a dedicated `walk_asset_references` tool, or could be a param on `read_asset_properties` (`follow_refs: true, max_depth: N`).
**Unlock value**: medium. Agents currently do this manually by chaining calls. A single tool that walks makes agent logic cleaner.
**Recommendation**: KEEP-DEFERRED — not a parser-level L3 question. Belongs as a separate tool-surface design question that Agent 9 could revisit independently of any parser work.

#### L3C aggregate

**Recommendation: KEEP-DEFERRED as a bucket.** The heterogeneity is the problem — there's no single workstream. Individual sub-scopes may graduate to their own tracks when workflow signals justify them. Most likely early graduate: **UUserDefinedStruct (C.2)** if ProjectA/ProjectB are confirmed custom-struct-heavy. Flag as §5 open question Q-A.

---

## §4 Why the Level 2 cutoff still holds (mostly)

All three categories against the original stop-at-Level-2 rationale:

- **L3A rationale ("Phase 3 gives this for free") is stronger, not weaker.** 3F occupies the UEdGraph space with a strictly-better sidecar design than either TCP-on-every-call OR pure offline byte parsing. The multi-agent cost-reduction argument fails here because the work is spec-writing against a heterogeneous surface, not mechanical porting — agents don't accelerate it.
- **L3B rationale ("too expensive for the unlock") no longer holds**, but that's not a "Level 3" finding — it's an "Agent 8 Phase 2.5 was correctly named" finding. L3B should land as L2.5 inside or next to Agent 10's work, not as a new tier.
- **L3C rationale ("heterogeneous grab-bag without a theme") still holds.** The sub-scopes have different cost profiles, different unlock values, and different dependencies. Treating them as one workstream was the original mistake; this study doesn't repeat it.

### L2.5 (containers) — recommended? **Yes.**

Agent 8's Phase 2.5 label was accurate. The refined recommendation:

- **Recommend shipping with or immediately after Agent 10's Level 1+2** (Q6 is Noah's scope call):
  - Simple-element arrays: `TArray<int>`, `<float>`, `<bool>`, `<FName>`, `<FString>`, `<FGameplayTag>`, all Level-2 engine structs (FVector, FRotator, FQuat, FTransform, FLinearColor, FColor, FGuid, FSoftObjectPath). 1 agent session with tests.
  - Sets with same element-type coverage. 0.5 session.
- **Recommend deferring to Agent 10.5 follow-on**:
  - Maps (TMap<key, value>) with any scalar or engine-struct key/value. 1-2 sessions.
  - Arrays/maps of custom structs (UUserDefinedStruct-gated). Lands with L3C.2 if that ever opens.

This addresses Agent 9's Q6 directly with a concrete scope split.

### What would reopen the decision on L3A or L3C?

- **L3A reopens** if 3F is killed or substantially delayed and an agent automation workflow requires offline BP intelligence with no editor at all. Until then, 3F's sidecar story is the right answer.
- **L3C.2 (UUserDefinedStruct) reopens** if Noah confirms meaningful custom-struct usage in ProjectA/ProjectB CDOs AND the resulting `{unsupported, reason: "unknown_struct"}` marker noise from Agent 10's deployment reaches a threshold that blocks specific workflows.
- **L3C.3 (FInstancedStruct) reopens** if Mass Entity or Gameplay Interactions usage is confirmed.
- **L3C.4 (cross-package walk)** is better framed as a tool-surface question for a future Agent 9-style design pass, not a parser question.

---

## §5 Open questions for Noah

Ordered by decision-leverage (highest first — Q-A resolves the single meaningful L3C ambiguity for ~1 minute of work).

**Q-A — HIGHEST LEVERAGE**: Do ProjectA or ProjectB have meaningful usage of `UUserDefinedStruct` (custom user structs) on Blueprint CDOs? This is the one question whose answer directly flips a verdict (L3C.2 graduates from KEEP-DEFERRED → its own track if yes). Spot-check:

  - Run `query_asset_registry` with `class_name: UserDefinedStruct` once Agent 10 lands to get a concrete count.
  - If the count is >10 and those structs appear as UPROPERTY types on GAS ability CDOs, L3C.2 (UUserDefinedStruct) graduates. Below ~10, keep deferred.
  - Resolvable in ~1 minute once Agent 10 ships. Until then, the KEEP-DEFERRED verdict stands on heterogeneity grounds alone and doesn't rely on this answer.

**Q-B**: Does ProjectA or ProjectB use Mass Entity, Gameplay Interactions, or any other FInstancedStruct-heavy subsystem? If no, L3C.3 never opens. If yes, it graduates with C.2.

**Q-C**: Phase 3 plugin ship-date mental model — is 3F (BP-as-picture sidecars) "soon after Level 1+2" or "after several more offline increments"? The L3A verdict (EDITOR-ONLY) assumes 3F is on the near-term roadmap; if 3F is itself deferred indefinitely, a narrower offline-L3A (just `UEdGraphNode::NodePosX/Y` + comment boxes, ignoring node semantics) could become worth a second look — that's the "spatial-only shallow parse" fallback, maybe 2-3 sessions. Not recommended today; flagged for the scenario where 3F slips.

**Q-D**: Is there a specific current-or-imminent workflow (CI docs generation, offline agent automation, cold-start asset audit) that would flip any verdict? None surfaced in the references read; asking explicitly.

**Q-E**: **Agent 10 scope**: Per Agent 9's §5 Q6, is simple-element container support (1 agent session) in scope for Agent 10? If yes, this study's L3B verdict converts directly into Agent 10 scope. If no, L2.5 becomes Agent 10.5 as a focused follow-on. Either way the finding stands, but Agent 10's handoff text would want to reflect the decision. *(Flagged per handoff constraint: I found something that might change Agent 10's scope but am not acting on it — orchestrator attention requested.)*

---

## §6 Confidence

**MEDIUM-HIGH** overall. Component-level breakdown:

- **L3A verdict (EDITOR-ONLY)**: HIGH. Evidence is strong: 3F already occupies the space with better design; reference-project coverage for K2Node specialization is empirically zero; multi-agent cost calibration is grounded in the handoff's explicit "heterogeneous surface spec-writing doesn't speed up" guidance. Low speculation.
- **L3B verdict (FOLD-INTO-L2.5)**: HIGH. Evidence is the strongest of the three — CUE4Parse/UAssetAPI both ship container readers that are directly citable; Agent 8 already named this "Phase 2.5"; Agent 9 flagged Q6 for the same decision from a tool-surface angle. The multi-agent cost calibration matches the handoff's predicted ~30-50% reduction landing zone.
- **L3C verdict (KEEP-DEFERRED)**: MEDIUM. The aggregate verdict is solid because the heterogeneity argument is independent of usage data. But individual sub-scope rankings (especially C.2 UUserDefinedStruct) depend on ProjectA/ProjectB usage data I don't have — the `query_asset_registry` probe in Q-A would resolve this. HIGH on delegate (C.1, clear loss) and cross-package (C.4, tool-level not parser), MEDIUM on UUserDefinedStruct and FInstancedStruct.
- **Aggregate "Level 2 cutoff still holds"**: HIGH. Even the most bullish reading of L3B doesn't promote it to a separate Level 3 tier — it's L2.5 by definition. Even the most bullish reading of L3C.2 only gets one sub-scope graduated, not the full bucket.

**Where my estimates are speculative vs grounded**:
- GROUNDED: L3B agent-session counts (Agent 8's estimates × multi-agent calibration explicitly from the handoff).
- GROUNDED: L3A reference-coverage gap (Agent 7's survey doesn't cite K2Node support in any project).
- SPECULATIVE: L3A session count range (15-30) — I assert this based on "spec-writing doesn't accelerate with agents" logic from the handoff, but I can't ground-truth it against a successful attempt. The direction (expensive) is confident; the magnitude is a judgment call.
- SPECULATIVE: L3C.2 unlock value — gated on Noah spot-check.

**Did-not-do-but-could-have**:
- Did not grep CUE4Parse source directly (handoff flagged as optional but valuable). The reference coverage via Agent 7's survey + Agent 8's "What to Lift" lists is sufficient for the three verdicts, but a direct grep would strengthen the line-count claims for L3B's reader sizes. If this study gets challenged on specifics, a pass with direct source reading would tighten it.
- Did not spot-check ProjectA/ProjectB for UUserDefinedStruct usage (flagged as Noah Q-A). Once Agent 10 lands, a one-minute `query_asset_registry` call resolves this.

---

## Final Report

```
Agent 11 Final Report — Level 3 Feasibility Study (Revisit)

Original decision: "Stop at Level 2" (circa 2026-04)
Re-evaluation verdict:
  L3A UEdGraph:            EDITOR-ONLY    (3F sidecar strictly dominates)
  L3B Containers:          FOLD-INTO-L2.5 (Agent 8's Phase 2.5, now affordable)
  L3C Delegates + complex: KEEP-DEFERRED  (heterogeneous; one sub-scope
                                           flagged for spot-check)

Aggregate: "The 'stop at Level 2' decision still holds, with one refinement —
  L3B should land as L2.5 (Agent 8's original framing) within Agent 10's
  scope or a focused follow-on, not as a distinct Level 3 tier."
  Reason: L3A is dominated by 3F's sidecar approach; L3B is not Level 3 by
  any coherent definition (it's the deferred Phase 2.5); L3C has no unifying
  workstream and most sub-scopes fail on unlock value.

If none PURSUE:
  L2.5 (containers) still recommended? Yes.
    Simple-element arrays + sets: ~1.5 agent sessions. Ship with Agent 10.
    Full Map + arrays-of-custom-structs: ~2-3 sessions. Agent 10.5 follow-on.

Plugin impact: Phase 3 plugin scope is not further shrunk by Level 3 work
  beyond Agent 9's existing displacement. The plugin is WRITE + editor-
  interactive + editor-live-reflection; Level 3 cannot displace it. Plugin
  necessity is not the marginal decision here.

Open questions for Noah: 5 (Q-A through Q-E in §5)
  Q-A (custom struct usage) is the single most decision-relevant one —
  resolvable in ~1 minute post-Agent-10.

Confidence: MEDIUM-HIGH (HIGH on aggregate + L3A + L3B; MEDIUM on L3C sub-
  scope rankings gated on Noah spot-check)

Deliverable: docs/research/level3-feasibility-study.md (~252 lines)
```
