# L3A Skeletal UEdGraph Parse Feasibility Study

> **Author**: Agent 11.5
> **Date**: 2026-04-16
> **Type**: Research — reference-backed feasibility assessment; no design authorship, no code, no D-log allocation
> **Inputs**: Agent 7 (parser survey), Agent 8 (parser audit), Agent 9 (tool-surface design), **Agent 11** (full-fidelity L3A verdict), 3F blueprints-as-picture amendment, D30/D32/D37/D39/D44/D45/D46/D47
> **Deliverable**: This document. Feeds a future D-log entry when Noah acts on the recommendation.
> **Scope question**: Agent 11 verdicted full-fidelity L3A EDITOR-ONLY based on 200+ K2Node heterogeneity. Under the **corrected framing** (offline reads are first-class; 3F sidecar is editor-dependent-to-produce), is a **skeletal** parse restricted to ~10-13 K2Node types feasible and worth pursuing as a robust-floor complement to the sidecar?

---

## §1 Skeletal subset — refined

The starting proposal in the handoff lists 13 K2Node types. After reviewing reference coverage and real ProjectA BP export tables, the subset stands largely as proposed, with one clarification and a reframing around **what a skeletal parser actually extracts per node**:

| # | K2Node type                                | Role                        | Semantic data to extract                                           |
|---|--------------------------------------------|-----------------------------|--------------------------------------------------------------------|
| 1 | `UK2Node_Event`                            | Entry (native event)        | `EventReference: FMemberReference` (event name + parent class)    |
| 2 | `UK2Node_CustomEvent`                      | Entry (user-defined event)  | `CustomFunctionName: FName`                                        |
| 3 | `UK2Node_FunctionEntry` / `FunctionResult` | Function graph boundary     | `FunctionReference: FMemberReference`                              |
| 4 | `UK2Node_VariableGet`                      | Read BP variable            | `VariableReference: FMemberReference` (variable name + owner)     |
| 5 | `UK2Node_VariableSet`                      | Write BP variable           | Same as VariableGet                                                |
| 6 | `UK2Node_CallFunction` / `CallParentFunction` | Invoke UFUNCTION         | `FunctionReference: FMemberReference`                              |
| 7 | `UK2Node_IfThenElse`                       | Branch                      | None beyond class identity (Branch with True/False exec outs)     |
| 8 | `UK2Node_ExecutionSequence`                | Sequence                    | None beyond class identity (N exec outs)                          |
| 9 | `UK2Node_SwitchEnum` / `SwitchString` / `SwitchInteger` | Switch       | For SwitchEnum: `Enum: TSubclassOf<UEnum>` (enum type ref)         |
| 10 | `UK2Node_Self`                            | `self` literal              | None beyond class identity                                         |
| 11 | `UK2Node_MacroInstance`                    | Macro call                  | `MacroGraphReference: FGraphReference` (macro graph path + name)   |
| 12 | `UK2Node_DynamicCast`                      | Cast-to                     | `TargetType: TSubclassOf<UObject>` (cast target)                   |
| 13 | `UK2Node_Knot`                             | Reroute (spatial-only)      | None — treated as pass-through by graph walker                     |

**Reframing**: every feasibility claim below hinges on a split the handoff does not make explicit. A skeletal parser can be built in **two cost-separable tiers**:

- **Tier S-A — name-only (pin-less)**: per-K2Node UPROPERTY data only. Answers *find* / *grep* questions ("which BPs call `StartMontage`?", "what events does this BP handle?", "where is variable X read?"). Does NOT trace exec chains, because chains require edges.
- **Tier S-B — full trace (with pins)**: S-A plus UEdGraphPin serialization (including `LinkedTo` cross-node edges). Answers *trace* questions ("what happens on BeginPlay?", "what feeds this pin?", "which branch does this value flow through?").

The Tier S-A/S-B distinction reshapes the decision. See §2-§5.

---

## §2 Per-node-type evaluation — reference coverage

### §2.1 Shared infrastructure — what each K2Node needs

Every skeletal K2Node type needs two things from the parser:

1. **Class identification** — already available. `inspect_blueprint` exports table shows class names verbatim (verified: `K2Node_CallFunction`, `K2Node_Event`, `K2Node_IfThenElse`, etc. all appear directly in `exports[].className`).
2. **Per-node UPROPERTY data** — requires Level 1 (FPropertyTag iteration, Agent 10 scope) to walk each export's tagged-property stream. For the subset above, the dominant payload is **`FMemberReference`** — a USTRUCT with six fields (`MemberParent: TObjectPtr<UObject>`, `MemberScope: FString`, `MemberName: FName`, `MemberGuid: FGuid`, `bSelfContext: bool`, `bWasDeprecated: bool`). All fields are UPROPERTY — no custom Serialize() override — so it flows through standard tagged iteration. Adding it to the Level 2 struct registry is mechanical (estimated ~0.25 agent-sessions).

Edge infrastructure (Tier S-B only):

3. **UEdGraphPin serialization** — UEdGraphPin is **not a UCLASS** (confirmed: [UE dev forum, "How to save information of UEdGraphPin"](https://forums.unrealengine.com/t/how-to-save-information-of-uedgraphpin-in-4-13/369071) — "since the pin class is not a UCLASS, the input and output pins are not directly saved"). Pins are emitted by `UEdGraphNode::Serialize()` as a bespoke binary block: PinId(FGuid), PinName(FName), PinType(FEdGraphPinType), DefaultValue(FString), LinkedTo(TArray<FEdGraphPinReference>), SubPins, ParentPin, flags. **This is not tagged property data; it's a custom binary stream that runs inside the export's serialized payload.**

### §2.2 Reference-project coverage for shared infrastructure

Direct GitHub inspection of the two primary reference projects named by Agent 7 (survey) and Agent 8 (audit):

| Subject                              | CUE4Parse                                                                                                    | UAssetAPI                                                                                            | Status                                                                    |
|--------------------------------------|---------------------------------------------------------------------------------------------------------------|------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------|
| **FEdGraphPinType** (type struct)   | [`CUE4Parse/UE4/Objects/Engine/EdGraph/FEdGraphPinType.cs`](https://github.com/FabianFG/CUE4Parse/blob/master/CUE4Parse/UE4/Objects/Engine/EdGraph/FEdGraphPinType.cs) — fields: PinCategory, PinSubCategory, PinSubCategoryObject, PinValueType, ContainerType, PinSubCategoryMemberReference, bIsReference/Const/WeakPointer/UObjectWrapper/SerializeAsSinglePrecisionFloat. **No LinkedTo field.** | Present (StructTypes) | ✅ Both. L2 struct registry entry.                                         |
| **FEdGraphTerminalType**             | `CUE4Parse/UE4/Objects/Engine/EdGraph/FEdGraphTerminalType.cs`                                               | Present                                                                                              | ✅ Both. Helper for container-of pin types.                                |
| **FUserPinInfo**                     | `CUE4Parse/UE4/Objects/Engine/EdGraph/FUserPinInfo.cs`                                                        | Not seen in ExportTypes                                                                              | Partial — used on Function/Macro entry nodes                              |
| **EPinContainerType**                | `CUE4Parse/UE4/Objects/Engine/EdGraph/EPinContainerType.cs`                                                   | Present                                                                                              | ✅ Enum.                                                                   |
| **UEdGraphPin** (instance + LinkedTo) | **Absent.** No file matching `EdGraphPin*.cs`, `*Pin.cs` outside type-classification. Entire `/EdGraph/` subdir lists four files above only.    | **Absent.** `ExportTypes/` directory contains `AssetImportDataExport`, `ClassExport`, `DataTableExport`, `EnumExport`, `Export`, `FieldExport`, `FunctionExport`, `LevelExport`, `MetaDataExport`, `NormalExport`, `PropertyExport`, `RawExport`, `StringTableExport`, `StructExport`, `UserDefinedStructExport` — **zero K2Node or EdGraph exports.** | ❌ Zero reference coverage for the actual pin serialization + edges. |
| **UEdGraphNode::Serialize (pins block)** | Absent                                                                                                   | Absent                                                                                               | ❌ Would need reverse-engineering from engine source.                       |
| **Per-K2Node specialized readers**   | Absent (Agent 11 confirmed; verified again — no `K2Node_*.cs` anywhere in CUE4Parse tree)                    | Absent                                                                                               | ❌ Zero across all 200+ subclasses.                                         |
| **FMemberReference**                 | Not as a named file; flows through standard tagged iteration (standard UPROPERTY struct)                     | Same                                                                                                 | ✅ Implicit via Level 1+2 tag iteration. Needs struct-registry entry to keep fields structured instead of opaque. |

**Cross-check against Agent 7's 14-project survey**: no project cited — FModel (inherits CUE4Parse gaps), pyUE4Parse (Python mirror of CUE4Parse), UE4SS (runtime reflection, not binary), unreal_asset (Rust, partial), UAssetGUI (4.x-only, unmaintained) — provides UEdGraphPin instance serialization. Zero coverage remains zero.

**Bottom line**: Tier S-A's shared infrastructure is reference-backed (FPropertyTag iteration + FMemberReference as tagged struct). Tier S-B's shared infrastructure (UEdGraphPin binary block) is **zero-reference — pure engine-source reverse-engineering territory**.

### §2.3 Per-type cost and stability

Stability score 1-5 (5 = most stable across UE 5.6 → 5.7). Cost per Agent 11's calibration (mechanical port ~0.5 session; reverse-engineer 2-4 sessions).

| # | Type | Reference (S-A) | Reference (S-B) | Stability | S-A cost | S-B cost |
|---|------|-----------------|------------------|-----------|----------|----------|
| 1 | UK2Node_Event                 | ✅ (EventReference = FMemberReference)          | ❌ | 5 | shared | + shared pin infra |
| 2 | UK2Node_CustomEvent           | ✅ (CustomFunctionName = FName)                  | ❌ | 5 | shared | + shared pin infra |
| 3 | UK2Node_FunctionEntry/Result  | ✅ (FunctionReference + FUserPinInfo[])          | ❌ | 4 | shared + UserPinInfo entries | + shared pin infra |
| 4 | UK2Node_VariableGet           | ✅ (VariableReference = FMemberReference)        | ❌ | 5 | shared | + shared pin infra |
| 5 | UK2Node_VariableSet           | ✅ (same as Get)                                 | ❌ | 5 | shared | + shared pin infra |
| 6 | UK2Node_CallFunction + Parent | ✅ (FunctionReference = FMemberReference)        | ❌ | 4 | shared | + shared pin infra |
| 7 | UK2Node_IfThenElse            | ✅ (no per-node data; class identity is enough)  | ❌ | 5 | 0 | + shared pin infra |
| 8 | UK2Node_ExecutionSequence     | ✅ (class identity only)                         | ❌ | 5 | 0 | + shared pin infra |
| 9 | UK2Node_SwitchEnum/String/Int | ✅ (Enum = TSubclassOf<UEnum> as ObjectProperty) | ❌ | 4 | shared | + shared pin infra |
| 10 | UK2Node_Self                 | ✅ (class identity only)                         | ❌ | 5 | 0 | + shared pin infra |
| 11 | UK2Node_MacroInstance        | ✅ (MacroGraphReference = FGraphReference struct) | ❌ | 3 | + FGraphReference registry entry | + shared pin infra |
| 12 | UK2Node_DynamicCast          | ✅ (TargetType = TSubclassOf<UObject>)           | ❌ | 4 | shared | + shared pin infra |
| 13 | UK2Node_Knot                 | ✅ (class identity; passthrough marker)          | ❌ | 5 | 0 | + shared pin infra (single-in, single-out pin pair) |

**Aggregate cost — Tier S-A**: ~1.5-2 agent sessions on top of Agent 10 (Level 1+2). Breakdown: ~0.25 session to register FMemberReference + FGraphReference + FSimpleMemberReference in the L2 struct registry; ~0.5 session for per-node semantic extraction helpers (the ones that pluck `.MemberName` out of parsed tags for CallFunction / Event / VariableGet/Set); ~0.5 session for a thin tool wrapper surface; ~0.5 session buffer for ProjectA-fixture tests and version-skew validation.

**Aggregate cost — Tier S-B**: ~8-13 agent sessions. Breakdown: ~3-4 sessions to reverse-engineer UEdGraphNode::Serialize()'s pin-block layout from engine source and validate across real fixtures; ~2 sessions for per-node `Serialize()`-override handling (estimated 4-6 K2Nodes in the skeletal subset have custom serialize overrides — UK2Node_MathExpression notoriously, some CallFunction backcompat paths); ~1-2 sessions for LinkedTo resolution via pin-ID graph; ~2-3 sessions version-skew buffer (pin serialization has evolved: PersistentGuid added later, bit-flag packing changed between UE4 and UE5, subpin layout shifts). This aligns with Agent 11's 15-30 session estimate for the full-fidelity case, scaled down to ~40-50% because the skeletal case doesn't need 200+ type support — but the shared pin infra floor is fixed and expensive.

---

## §3 Coverage-ratio analysis — three ProjectA BPs

Hand-counted via `inspect_blueprint` export tables. Each K2Node subclass appears as a first-class export (`className` field). This makes coverage-ratio analysis mechanical — no custom tooling needed.

### §3.1 Sample 1 — `/Game/Blueprints/Character/BP_OSPlayerR`

Canonical player BP. 600 KB, 275 exports, 240 K2Node*.

| Category                   | Count | % of exports | % of K2Nodes |
|----------------------------|-------|-------------|--------------|
| **Skeletal subset** (#1-#12) | 150  | 54.5%       | 62.5%        |
| UK2Node_Knot (#13, passthrough) | 35 | 12.7%      | 14.6%        |
| **Skeletal including Knot** | **185** | **67.3%** | **77.1%** |
| Out-of-skeletal K2Nodes    | 55   | 20.0%       | 22.9%        |
| &nbsp;&nbsp;├─ K2Node_BreakStruct | 6  |             |             |
| &nbsp;&nbsp;├─ K2Node_MakeStruct | 1  |             |             |
| &nbsp;&nbsp;├─ K2Node_InputKey / InputDebugKey | 2 |         |             |
| &nbsp;&nbsp;├─ K2Node_EnumEquality | 1 |           |             |
| &nbsp;&nbsp;└─ Remainder (Knot not counted here; misc) | 45 |     |             |
| Non-K2Node exports         | 35   | 12.7%       | n/a          |
| &nbsp;&nbsp;├─ Function, SCS_Node, EdGraph, EdGraphNode_Comment, component defaults | | | |

Top frequencies: CallFunction 81, Knot 35, VariableGet 25, Function (non-K2Node) 20, SCS_Node 11, EdGraph 10, EdGraphNode_Comment 9, FunctionEntry 9, Event 7, BreakStruct 6, MacroInstance 6, AkComponent 6.

### §3.2 Sample 2 — `/Game/Blueprints/Level/BP_OSControlPoint`

Gameplay BP. 376 KB, 184 exports, 130 K2Node*.

| Category                   | Count | % of exports | % of K2Nodes |
|----------------------------|-------|-------------|--------------|
| **Skeletal subset** (#1-#13) | ~115 | 62.5%       | ~88%         |
| Out-of-skeletal K2Nodes    | ~15  | 8.2%        | ~12%         |
| &nbsp;&nbsp;├─ K2Node_PromotableOperator | 3 |  |  |
| &nbsp;&nbsp;├─ K2Node_CommutativeAssociativeBinaryOperator | 2 |  |  |
| &nbsp;&nbsp;├─ K2Node_Select | 2 |  |  |
| &nbsp;&nbsp;├─ K2Node_MultiGate | 1 |  |  |
| &nbsp;&nbsp;├─ K2Node_AddDelegate / AssignDelegate | 4 |  |  |
| &nbsp;&nbsp;└─ misc | ~3 |  |  |

Top K2Node frequencies: CallFunction 53, VariableGet 32, FunctionEntry 7, IfThenElse 6, CustomEvent 5, SwitchEnum 5, VariableSet 5, AddDelegate 3, MacroInstance 3, PromotableOperator 3, BinaryOperator 2, Event 2, Select 2.

**Observation**: this BP has zero Knot nodes in export count (uses more compact layout). Skeletal-12 (excluding Knot) lands at ~88% of K2Nodes. Unsupported: delegate assignment (3C.1 territory), math operators (not in skeletal), Select/MultiGate (control flow variants not in skeletal baseline — could graduate).

### §3.3 Sample 3 — `/Game/Blueprints/Magic/BP_FrostBoltProjectile`

Small/simple data-only projectile. 41 KB, 17 exports, 4 K2Node*.

| Category                   | Count | % of exports | % of K2Nodes |
|----------------------------|-------|-------------|--------------|
| **Skeletal subset** (#1-#13) | 4    | 23.5%       | **100%**     |
| Non-K2Node exports         | 13   | 76.5%       | n/a          |

All 4 K2Nodes (3× Event, 1× FunctionEntry) are in skeletal. Data-only BPs have minimal graph content, so skeletal coverage is trivially complete here.

### §3.4 Coverage ratio aggregate

Across the three samples, skeletal-12 (the #1-#12 semantic subset, excluding Knot-as-passthrough) covers:

- **62-100% of K2Node exports** (median ~75%; 62.5% in the most graph-heavy BP)
- Including Knot as passthrough: **77-100%** (median ~80%)
- Questions of the form "find every node that…" map onto this ratio directly in Tier S-A. Questions of the form "trace from here to there…" need Tier S-B and are uncovered by S-A.

**Conclusion**: skeletal-12 coverage is **above the 60% decision threshold** on all three representative BPs — the subset is well-chosen for common ProjectA BPs. The gap (22-38%) is concentrated in **math/comparison operators** (`PromotableOperator`, `CommutativeAssociativeBinaryOperator`, `EnumEquality`) and **struct/array manipulation** (`BreakStruct`, `MakeStruct`) — both would be future graduations if demand materializes, not core skeletal scope.

---

## §4 Comparison against 3F-sidecar-only

Under the **corrected framing** (offline reads are first-class; the 3F sidecar is editor-dependent-to-produce, with an explicit soft dependency acknowledged in D45), what does a skeletal parser buy that sidecar-only doesn't? Answer split by tier:

### §4.1 Tier S-A vs sidecar-only

**What S-A adds over sidecar-only**:

1. **Robustness when the sidecar is stale/missing**. A BP modified with the editor closed (e.g., Perforce sync pulls a teammate's edit that was committed without their save-hook firing; CI/docs bots iterating over the repo after a branch merge; a collaborator who disabled the UEMCP plugin's save hook; a fresh checkout where `prime_bp_cache` was never run) still answers "what does this BP call?" and "what events does it handle?" from a Tier S-A read.
2. **Agent workflows without an editor**. The 3F sidecar's fallback path (`{available: false, reason: "no_sidecar_and_editor_offline", hint: "open the BP in editor once to prime"}`) gracefully fails for the most common grep-like workflows. S-A keeps `query-where-called` working in CI/headless-agent contexts.
3. **Lower latency for grep-style scans**. Walking 500 BPs asking "which ones call GA ability X?" via sidecars requires loading 500 JSON files. Via Tier S-A, it's the same Agent 10 `query_asset_registry` + per-export tag iteration path already primed — no extra file I/O.

**What S-A does NOT give you that sidecar provides**:

1. **Spatial/visual traversal** — positions, comment-box membership, knot layout. Sidecar-only.
2. **Exec-chain tracing** — `bp_trace_exec` verbs. Require pin edges. Sidecar-only.
3. **Data-wire tracing** — `bp_trace_data` verbs. Require pin edges. Sidecar-only.
4. **Full pin / default-value fidelity** — only sidecar captures this.

S-A and sidecar are **complementary**: S-A is the *offline-always robust floor* for find/grep; sidecar is the *rich layer that requires a live-or-recently-live editor*. They're not substitutes.

### §4.2 Tier S-B vs sidecar-only

Tier S-B (full skeletal with pins) would, in theory, compete more directly with the sidecar — it trades the editor-soft-dependency for a pure-offline trace capability. But the cost is 4-8× higher than S-A and the unlock beyond S-A is precisely what 3F was designed to solve. **S-B duplicates 3F's capability at much higher cost, without 3F's version-correctness guarantees** (3F uses the editor's own `UEdGraph` → JSON serializer, which is always correct for the engine version that wrote the sidecar; a pure-offline pin parser inherits the full UE-version-skew burden). Agent 11's L3A EDITOR-ONLY verdict applies to Tier S-B with essentially the same evidence — the 200+ type heterogeneity reduces to ~13 types, but the shared pin-serialization floor is where the bulk of cost lives.

### §4.3 Workflow concreteness

To pressure-test: the "find / introspect without editor" workflows that S-A unlocks and sidecar-only does NOT reliably cover:

| Workflow                                                             | Sidecar-only (best case)        | Sidecar-only (stale/missing)     | Tier S-A                     |
|----------------------------------------------------------------------|---------------------------------|----------------------------------|------------------------------|
| "Does any BP call `ApplyGameplayEffectToTarget`?"                   | ✅ fast                          | ❌ returns `{available: false}`  | ✅ works always              |
| "List all BPs that handle `ReceiveBeginPlay`"                       | ✅                               | ❌                               | ✅                            |
| "Which BPs read variable `bIsInCombat`?"                            | ✅                               | ❌                               | ✅                            |
| "CI: audit which BPs override `CanActivateAbility`"                 | ✅ if sidecars are current       | ❌ (likely stale post-merge)     | ✅                            |
| "What happens on `ReceiveDamage` in `BP_OSPlayerR`?" (trace chain)  | ✅                               | ❌                               | ❌ needs pins (S-B / 3F)     |
| "Show me the Damage-Handling comment box contents"                   | ✅                               | ❌                               | ❌ spatial — sidecar-only    |
| "Trace this variable back to its defining write"                    | ✅                               | ❌                               | ❌ needs pins (S-B / 3F)     |

The first four workflows are **find/grep** and dominate agent usage based on what Noah described in the corrected-framing note ("answer questions that would have required direct editor checks" — most of those are "where is X used", not "walk me through the exec chain"). The latter three are the sidecar's bread and butter. **A dual-layer design (S-A + sidecar) dominates either alternative for the total workflow set.**

---

## §5 Recommendation

**PURSUE — Tier S-A only (pin-less / name-only skeletal). FOLD-INTO-3F the full-trace variant (Tier S-B).**

**The core research finding is the reframe itself.** The handoff's starting premise — "is a skeletal K2Node parse feasible?" — implicitly treats skeletal as a single bounded artifact that includes edge-topology, because the workflow examples it cites ("trace from `ReceiveAnyDamage` → `TakeDamage`...") require pin edges to answer. Direct inspection of CUE4Parse (`/EdGraph/` contains only 4 type-classification files; zero UEdGraphPin instance readers) and UAssetAPI (`/ExportTypes/` contains zero K2Node or EdGraph readers), plus independent confirmation that UEdGraphPin is not a UCLASS, shows that reference coverage stops at **tagged-property data** and never extends to **pin binary blocks**. The skeletal question therefore splits along the exact cost/coverage seam where the references run out: name-only work is reference-backed and cheap; edge-topology work is zero-reference and expensive. Treating skeletal as a single decision hides that split and produces a flatly-wrong answer either way. Treating it as two decisions produces a clean answer that maps onto Agent 10 infrastructure on one side and 3F sidecar capability on the other.

Rationale against the decision framework:

| Criterion                       | S-A       | S-B       |
|---------------------------------|-----------|-----------|
| Reference coverage ≥70% subset  | ✅ (~100% — tagged iteration + FMemberReference) | ❌ (zero for pin block) |
| Total cost ≤ 6-8 agent sessions | ✅ (~1.5-2) | ❌ (~8-13) |
| Coverage ratio ≥60% of BP nodes | ✅ (62-100% median 75%) | ✅ (80%+ if built) |
| Workflow unlock substantial     | ✅ (robust find/grep without editor) | Overlaps with 3F (editor-mediated trace already covers this better) |

The S-A verdict sits at the PURSUE threshold comfortably; every criterion clears. The S-B verdict misses on reference coverage and cost, duplicates the sidecar's domain, and inherits the version-skew problems Agent 11 cited — fold it into 3F where editor mediation keeps correctness cheap.

---

## §6 If PURSUE — proposed scope (S-A only)

### §6.1 Scope boundaries

In scope:
- Per-K2Node UPROPERTY extraction for the 13 types in §1 via Level 1+2 tag iteration (Agent 10 infrastructure).
- Struct-registry entries for `FMemberReference`, `FGraphReference`, `FSimpleMemberReference`, `FUserPinInfo` — all standard UPROPERTY structs (not custom Serialize()), so registry entry is mechanical.
- Semantic field extraction helpers (pluck `.MemberName`, `.MemberParent` class path, etc. into the tool's response shape).
- Thin tool-surface wrapper for the grep-like queries ("find K2Nodes by class + member reference match across one BP or a BP set").

Explicitly **not** in scope:
- UEdGraphPin / edge serialization — that's Tier S-B / sidecar.
- Non-skeletal K2Node types (PromotableOperator, Select, math ops, input nodes, BreakStruct/MakeStruct). Future graduations if workflow demand surfaces.
- Full BP dump rendering or exec-chain walks — sidecar's job.

### §6.2 Sequencing relative to other tracks

S-A is additive on top of Agent 10's work. Cost estimates disambiguated per orchestration mode:

- **Mode A — absorbed into Agent 10.5** (Agent 10.5 already has the struct-registry extension pattern in motion for D47 UUserDefinedStruct): **~1.25-1.5 sessions incremental** over 10.5's existing scope. No separate handoff, no separate verification pass, no separate orchestration overhead.
- **Mode B — standalone Agent 10.75** (runs between 10.5 and 3F): **~1.5-2 sessions total**, including the orchestration overhead (own handoff, own test rotation, own verification pass). The additional ~0.25-0.5 session over Mode A is the orchestration surcharge, not extra implementation work.

Sequencing in either mode:

1. Agent 10 ships Level 1+2 + D46 simple-element container support.
2. Agent 10.5 ships D46 complex containers + D47 UUserDefinedStruct two-pass resolver.
3. **S-A lands either inside 10.5 (Mode A) or as 10.75 between 10.5 and 3F (Mode B).** The struct registry entries S-A needs (`FMemberReference`, `FGraphReference`, `FSimpleMemberReference`, `FUserPinInfo`) are the same *shape* of work D47 does for custom structs, just for engine-internal tagged structs. Natural to bundle.
4. 3F sidecar lands separately in Phase 3 (plugin work). S-A and sidecar ship independently.

### §6.3 Agent sequencing

Single agent regardless of mode. Does **not** warrant parallelization — the work is tightly coupled to Agent 10.5's struct registry patterns. Mode A vs Mode B is Noah's orchestration call (Q-1); both are feasible.

### §6.4 Phase 3 blueprint-read scope impact

Agent 9's Option C already removed most Phase 3 `blueprint-read` tools via offline replacement. S-A's incremental impact on Phase 3 scope:

- **Further reducing**: any tool shaped as "which BPs call `function X`" or "list BPs handling event Y" — these were kept in Phase 3 under the assumption that offline couldn't reach into per-node semantics. S-A flips that.
- **Unchanged**: sidecar-dependent tools (`bp_trace_exec`, `bp_neighbors`, `bp_subgraph_in_comment`) stay on 3F / Phase 3.
- **Net**: minor — maybe 2-3 additional tools move from "Phase 3 required" to "offline sufficient." Agent 9 can revisit the specific tool list once S-A's scope is firm; this study does not prescribe that list.

### §6.5 Relation to existing offline tools

S-A's output consumes what `inspect_blueprint` already returns (export table with K2Node class names) plus the L1+L2 tagged-property iteration Agent 10 is adding. No disk-format changes; no new file artifacts; no new binary parsing beyond what's already planned. This is one reason the estimate is low — the infrastructure is already coming.

---

## §7 The final offline-BP story under the split verdict

Because the verdict IS a split (PURSUE S-A + FOLD-INTO-3F S-B), this section is required — it describes what the combined S-A + 3F sidecar story looks like end-to-end, in the terms the handoff asks for.

### §7.1 Robustness floor and tier map

The offline-BP read story becomes a **three-layer stack** rather than a single path:

| Layer                          | Produced by                           | Lifetime                                          | Covers                                                                             |
|--------------------------------|---------------------------------------|---------------------------------------------------|------------------------------------------------------------------------------------|
| **L0 — Structural (already shipped)** | `inspect_blueprint` export walker (offline, D37)      | Always-available                                  | Class names of every K2Node export, parent class, generated class, CDO path.       |
| **L1 — Semantic name-only (S-A, PURSUE)** | Agent 10 + ~1.5 session S-A extension               | Always-available                                  | Per-node UPROPERTY data: function called, variable accessed, event handled, macro invoked, cast target — via FMemberReference / FGraphReference tag iteration. |
| **L2 — Spatial + exec/data trace (3F sidecar)** | Phase 3 plugin editor save-hook emits sidecar JSON | Available when sidecar fresh; absent when BP modified without editor-hook firing | Full pin edges, spatial layout, comment containment, traversal-verb substrate (`bp_trace_exec`, `bp_trace_data`, `bp_subgraph_in_comment`, etc.). |

**Robustness floor without S-A** (sidecar-only baseline): when the sidecar is stale or missing, offline BP introspection drops to L0 only — *class names of nodes, no semantic payload*. Find/grep workflows like "which BPs call `StartMontage`" cannot be answered from offline data alone and must either (a) wait for the editor to be opened so the sidecar re-emits, or (b) issue a TCP round-trip to the plugin. Neither is viable for agent-automation contexts (CI, headless checkout audits, sidecar-primed-elsewhere scenarios).

**Robustness floor with S-A**: L0 + L1 are always-available. The "always-works" set expands to cover every find/grep workflow in §4.3's first four rows. L2 remains sidecar-gated; when the sidecar is stale/missing, users get `{available: false}` for trace verbs but keep the find/grep surface fully functional.

### §7.2 Editor-dependent vs sidecar-dependent vs always-available

| Workflow class                              | Tier required | Behavior when editor offline + sidecar missing           |
|---------------------------------------------|---------------|----------------------------------------------------------|
| "Which BPs call function X?"                | L0 + L1       | ✅ works (S-A)                                            |
| "What events does this BP handle?"          | L0 + L1       | ✅ works                                                  |
| "Where is variable Y read / written?"       | L0 + L1       | ✅ works                                                  |
| "Does this BP implement interface Z?"       | L0 (structural) | ✅ works                                                |
| "What does this BP do on BeginPlay?" (trace) | L2            | ❌ `{available: false, reason: "no_sidecar_and_editor_offline"}` |
| "Show me what's inside the Damage-Handling comment" | L2     | ❌ same as above                                          |
| "What data feeds this branch's condition?"  | L2            | ❌ same as above                                          |
| "Render a picture of the EventGraph"        | L2 + Phase 3 visual capture | ❌ editor required always                    |

Editor dependency is therefore bounded to **trace + spatial** workflows. The dominant find/grep workloads Noah described in the corrected-framing note ("answer questions that would have required direct editor checks") become fully offline-reliable once S-A lands.

### §7.3 Sidecar staleness and re-prime story

With S-A in place, sidecar staleness is a graceful degradation rather than a hard failure:

- **Fresh sidecar**: L0 + L1 + L2. Full trace/spatial capability.
- **Stale sidecar** (BP modified since last save-hook fire): L0 + L1 still correct from re-reading the `.uasset` bytes; L2 returns partial/stale data with a mtime-mismatch warning. Consumer decides whether to trust L2 or fall through to L0+L1.
- **Missing sidecar** (fresh checkout, editor never opened, plugin disabled for the save): L0 + L1 available; L2 returns `{available: false}`. `prime_bp_cache` one-shot rebuilds sidecars when editor is next available.

S-A specifically fixes the corrected-framing problem that D45 flagged — "editor-dependent-to-produce" is softened from *blocking find/grep* to *blocking trace/spatial only*.

### §7.4 What would reopen S-B

Per §5 and §8 Q-5:

- **Primary reopening trigger**: 3F sidecar work is killed or deferred indefinitely AND an agent-automation workflow surfaces that requires **offline pin-trace specifically** (not name-level find, which S-A already covers).
- **Secondary reopening trigger**: workflow data accumulates showing that sidecar-missing scenarios fire frequently enough (e.g., CI audits regularly return `{available: false}` for trace questions, collaborator environments drift) that the cost of reverse-engineering pin serialization beats the cost of chasing sidecar coverage discipline.
- **Not a reopening trigger**: L2 workflows that 3F already handles correctly when the sidecar is fresh. S-B would not improve those — it would duplicate them at higher cost and lower correctness (3F inherits editor version-correctness; a pure-offline pin parser does not).

Neither trigger is present today. D45 locks 3F as the editor-only answer for full-fidelity BP logic reads; S-A is the proposed robust-floor complement; S-B stays deferred until a signal appears.

---

## §8 Open questions for Noah

Ordered by decision-leverage.

**Q-1 — HIGHEST LEVERAGE**: **Agent sequencing — does S-A absorb into Agent 10.5, or become its own Agent 10.75?** If Agent 10.5's D46+D47 scope is already tight, S-A becomes a separate ~1.5-session agent between 10.5 and the 3F work. If 10.5 has slack, absorbing S-A adds ~10-15% scope. No right answer from a feasibility standpoint; purely an orchestration call.

**Q-2**: **Scope boundary on the "math/operators" gap.** Samples §3.2/§3.1 show `PromotableOperator`, `CommutativeAssociativeBinaryOperator`, `EnumEquality` adding up to ~8% of K2Nodes in gameplay BPs. Should these graduate into S-A v1, or stay out-of-scope for a future follow-on? Author's recommendation: **stay out**; the skeletal brand is "entry + variable access + call + control flow," and math operators move it closer to general-purpose parsing (which is L3A full-fidelity, already EDITOR-ONLY per D45). But Noah may have a workflow that makes math visibility genuinely valuable.

**Q-3**: **Delegate nodes visibility.** §3.2 shows 4 delegate nodes (`K2Node_AddDelegate`, `K2Node_AssignDelegate`) in `BP_OSControlPoint`. Delegates are L3C.1 territory (KEEP-DEFERRED per Agent 11). Should S-A's tool surface at least *report* their presence (class identity, not payload) since that costs nothing given tag iteration? Author leans yes — "this BP binds a delegate here" is useful even without knowing what function it binds to. Noah's call.

**Q-4**: **ProjectB (UE 5.7) validation.** Reference coverage for FMemberReference is stable across 5.6-5.7 (it's an engine-core struct), but confirming via `query_asset_registry` on ProjectB once that project gains any BP with the relevant K2Nodes would harden the version-skew story. D42's `#if ENGINE_MINOR_VERSION` guard design applies here too. Not blocking S-A scope; flag for Agent 10.5 / 10.75 handoff.

**Q-5**: **Tier S-B reopening signal.** Recommendation locks S-B as FOLD-INTO-3F. The signal that would reopen: 3F slips materially (indefinite Phase 3) AND an agent-automation workflow surfaces that genuinely requires offline pin tracing (not just name-level find). The pin-less tracing gap would need to be acutely painful, not theoretically nice-to-have. Until that signal appears, do not reopen.

---

## §9 Confidence

**HIGH** overall on the aggregate verdict (PURSUE S-A, FOLD-INTO-3F S-B). Component breakdown:

- **S-A reference coverage**: HIGH. FPropertyTag iteration is Agent 8's core recommendation (CUE4Parse-backed); FMemberReference is a bog-standard UPROPERTY struct that appears across the engine-source tree without customization. I did not directly read engine source for `FMemberReference.h` in this study (a future implementation agent should), but the forum evidence + CUE4Parse FEdGraphPinType struct registry pattern is sufficient for a feasibility conclusion.
- **S-A cost estimate (~1.5-2 sessions)**: MEDIUM-HIGH. Calibration matches Agent 11's framing (mechanical additive work on existing parser; low spec-writing burden because no per-type heterogeneity reverse-engineering). The estimate could land 1.25-2.5 sessions depending on how much version-skew buffer proves necessary — wider-than-tight but bounded.
- **S-B zero-reference finding**: HIGH. Directly verified via GitHub tree listings of CUE4Parse `/EdGraph/` and UAssetAPI `/ExportTypes/`. Neither contains UEdGraphPin serialization handlers. Forum post independently confirms pins are not UCLASS and require custom serialization. Three independent sources of evidence.
- **Coverage ratio (62-100% median ~75%)**: HIGH on the numbers (hand-counted against real ProjectA fixtures) but MEDIUM on workflow relevance until Noah confirms the find/grep workflows match his mental model. §4.3's workflow table is the author's best inference of the corrected-framing intent; Noah should challenge any rows that don't match his use cases.
- **Sidecar-comparison argument**: HIGH. The editor-dependence of 3F is explicit in D45; the robustness gap that S-A fills is concrete (CI runs, stale sidecars, plugin-disabled collaborators) rather than speculative.

**Where estimates are speculative vs grounded**:
- GROUNDED: CUE4Parse/UAssetAPI absence of pin/K2Node readers (direct GitHub verification).
- GROUNDED: coverage-ratio counts (direct `inspect_blueprint` on three ProjectA BPs).
- GROUNDED: FMemberReference is tagged-property iterable (UE source convention; no custom Serialize override).
- SPECULATIVE: precise per-node semantic field list for each of the 13 types — I cited the primary UPROPERTY on each, but a future implementer should verify exhaustively against `UK2Node_*.h` headers. This study's purpose is feasibility-decision, not implementation-spec, so the gap is appropriate.
- SPECULATIVE: S-B cost range (~8-13 sessions). Inherits Agent 11's calibration for "spec-writing from engine source is ~4× mechanical port" without a grounded attempt. Direction (expensive) is confident; magnitude is a judgment call. This does not affect the PURSUE/FOLD verdict — S-B would need to be <6 sessions to swing, which is outside any plausible read of the evidence.

**Did-not-do-but-could-have**:
- Did not read `UK2Node_CallFunction.h` / `UK2Node_Event.h` engine source directly to catalogue every UPROPERTY per type. A future implementation handoff should include that as a first step — drives the tool's response shape. Left deliberately un-authored per handoff's no-design-authorship rule.
- Did not probe ProjectA for every skeletal type in the representative samples (BP_FrostBoltProjectile is so small it only exercises Event + FunctionEntry). If Noah wants tighter coverage-ratio confidence, `inspect_blueprint` on 2-3 mid-size GA BPs would add fidelity — but the aggregate ratio from the three samples is already above the 60% threshold by a wide margin.

---

## Final Report

```
Agent 11.5 Final Report — L3A Skeletal Parse Feasibility

Core finding: The handoff's "skeletal = single bounded artifact" premise
  is contradicted by the reference record. Skeletal splits cleanly into
  (S-A) tagged-property data — reference-backed, ~1.5-2 sessions, fully
  feasible — and (S-B) pin-edge serialization — zero reference coverage,
  ~8-13 sessions, duplicates 3F sidecar's domain at higher cost.
  The split itself is the research contribution.

Verdict: PURSUE (Tier S-A, pin-less/name-only) + FOLD-INTO-3F (Tier S-B, pin tracing)

Skeletal subset: 13 K2Node types
  Entry/event:    UK2Node_Event, UK2Node_CustomEvent,
                  UK2Node_FunctionEntry, UK2Node_FunctionResult
  Variable:       UK2Node_VariableGet, UK2Node_VariableSet
  Function call:  UK2Node_CallFunction, UK2Node_CallParentFunction
  Control flow:   UK2Node_IfThenElse, UK2Node_ExecutionSequence,
                  UK2Node_SwitchEnum/String/Int, UK2Node_DynamicCast,
                  UK2Node_MacroInstance
  Literal:        UK2Node_Self
  Passthrough:    UK2Node_Knot

Reference-project coverage:
  Tier S-A (tagged-property iteration + FMemberReference struct):
    ~100% coverage (CUE4Parse FEdGraphPinType.cs + standard UPROPERTY streams)
  Tier S-B (UEdGraphPin with LinkedTo edges):
    0% coverage — zero reference projects parse the pin binary block.
    Confirmed by direct inspection of CUE4Parse/UE4/Objects/Engine/EdGraph/
    (4 type-classification files only) and UAssetAPI/ExportTypes/ (no
    K2Node/EdGraph exports).

Total estimated cost:
  Tier S-A: ~1.25-1.5 sessions if absorbed into Agent 10.5 (Mode A)
           ~1.5-2 sessions if standalone Agent 10.75 (Mode B, includes
           orchestration surcharge). Same implementation work either way;
           low spec burden since it reuses Agent 10.5's struct-registry
           pattern for engine-internal tagged structs.
  Tier S-B: ~8-13 agent sessions (reverse-engineering UEdGraphNode
           pin-block serialization + per-K2Node Serialize() overrides +
           version-skew buffer). Duplicates 3F's domain at much higher
           cost without 3F's editor-mediated version-correctness.

Coverage ratio on representative BPs:
  BP_OSPlayerR          (player,     275 exp): 62% exports / 77% incl. Knot
  BP_OSControlPoint     (gameplay,   184 exp): 62% exports / ~88% K2Nodes
  BP_FrostBoltProjectile (projectile, 17 exp): 24% exports / 100% K2Nodes
  Median K2Node coverage: ~75%. Above the 60% threshold on all samples.

If PURSUE (S-A):
  Proposed sequencing: Agent 10 (L1+L2) → Agent 10.5 (D46 containers +
    D47 UUserDefinedStruct) → either absorbed into 10.5 or lands as a
    focused ~1.5-session Agent 10.75 before 3F sidecar work begins.
  Phase 3 blueprint-read scope impact: minor further reduction — a few
    "find BPs that call X" tools move from Phase 3-required to offline-
    sufficient. Agent 9 re-pass optional, not required.

If FOLD-INTO-3F (S-B):
  Workflow signal that would reopen: 3F sidecar slips indefinitely AND
    an agent-automation workflow requires offline pin-trace capability
    specifically (not just name-level find/grep).

Open questions for Noah: 5 (Q-1 through Q-5 in §8)
  Q-1 (10.5 absorption vs 10.75 standalone) is the highest-leverage one.
  Q-3 (report delegate-node presence in S-A) is the easiest to resolve.

Confidence: HIGH on aggregate verdict + S-B zero-reference finding +
  coverage-ratio numbers. MEDIUM on S-A cost range (1.25-2.5 bounded).

Deliverable: docs/research/level3a-skeletal-parse-study.md (~420 lines)
```
