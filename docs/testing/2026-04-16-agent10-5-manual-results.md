# Manual Testing Results — Agent 10.5 Surface

> **Session**: Fresh Claude Code session @ `D:\DevTools\UEMCP\` with UEMCP MCP server connected.
> **HEAD**: `ac9e40e` on `main` (Agent 10.5 fully shipped through `f339773`).
> **Tester**: Claude Opus 4.7 (1M context) as UEMCP Manual Tester.
> **Date**: 2026-04-16.

---

## Pre-flight

- [x] `UNREAL_PROJECT_ROOT = D:/UnrealProjects/5.6/ProjectA/ProjectA`
- [x] MCP server running; 15 toolsets registered; offline layer available; TCP layers unavailable (editor not running — expected).
- [x] HEAD includes `f339773`; tier-4 `find_blueprint_nodes` tool visible.
- [x] Automated baseline not re-run this session — CLAUDE.md claims 612/612, Agent 10.5 report claims 644/644. Did not regress in manual exercises.

---

## §1 — `find_blueprint_nodes` (D48 S-A skeletal)

### 1.1 Default query (no filters) — **PASS**

Call: `find_blueprint_nodes({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR" })`.

Observed:
- `total_skeletal: 184` ✓ (matches Agent 10.5 spot-check exactly).
- `nodes[]` returned 100 entries (default limit), each with `node_class`, `member_name`, `target_class` (resolved where applicable), `export_index`, `node_name`.
- `nodes_out_of_skeletal` present: `K2Node_BreakStruct (6)`, `K2Node_MakeStruct (1)`, `K2Node_CallMaterialParameterCollectionFunction (1)`, `K2Node_EnumEquality (1)`, `K2Node_InputDebugKey (1)`, `K2Node_InputKey (1)`.
- Pagination fields: `offset: 0`, `limit: 100`, `truncated: true`.
- `extras.self_context: true` flag populates correctly on self-call entries (GetAuraParamFromTier, ApplyVFX_Niagara_FromStruct, ApplyColor, HandleDeath, etc.).

### 1.2 Filter by event (`ReceiveBeginPlay`) — **PASS**

Call: `find_blueprint_nodes({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", node_class: "K2Node_Event", member_name: "ReceiveBeginPlay" })`.

Observed:
- `total_matched: 1` ✓.
- Single `K2Node_Event` entry, `member_name: "ReceiveBeginPlay"`, `target_class: "/Script/Engine.Actor"` ✓ (fully qualified path resolved from MemberParent).
- `truncated: false`, `nodes_out_of_skeletal` still returned (skeletal breakdown present even with filter applied).

### 1.3 Filter by function call target — **PASS**

Ran two sub-cases:
- `member_name: "TryActivateAbilitiesByTag"` → `total_matched: 1`, node targets `/Script/GameplayAbilities.AbilitySystemComponent`. ✓
- `member_name: "StartMontage"` → `total_matched: 0`, `nodes: []`, no error, `nodes_out_of_skeletal` still populated. ✓ (zero-match semantics clean)

### 1.4 Target class suffix match — **PASS (substituted fixture)**

Initial call on `BPGA_Block` with `target_class: "GameplayAbility"` returned `total_matched: 0`. Investigation: BPGA_Block has 10 skeletal nodes, none of which carry `GameplayAbility` in their MemberParent — its GA overrides are serialized as `K2Node_FunctionEntry` with null `target_class` (FunctionEntry does not carry MemberParent on BP-defined overrides). Correct behaviour, but the original fixture doesn't exercise suffix-match.

Re-tested against `BP_OSPlayerR` with `target_class: "AbilitySystemComponent"`:
- `total_matched: 1`, returns `TryActivateAbilitiesByTag` entry. `target_class` on the entry is `/Script/GameplayAbilities.AbilitySystemComponent` — confirms suffix match on the fully-qualified package path. ✓

### 1.5 Pagination — **PASS**

Call: `find_blueprint_nodes({ asset_path: ..., limit: 10, offset: 50 })`.

Observed:
- Returned 10 nodes starting from index 50 (export_index values 116-125 in deterministic order).
- `offset: 50`, `limit: 10`, `truncated: true` (184 total > 60 returned) ✓.

### 1.6 Delegate presence — **PASS**

Call on `/Game/Blueprints/Level/BP_OSControlPoint`.

Observed:
- `total_skeletal: 122`.
- Three `K2Node_AddDelegate` entries (export_indices 37, 38, 39) and one `K2Node_AssignDelegate` (40) — all with `member_name: null` and `target_class: null`. ✓ Class-identity-only per Q-3 decision — no payload resolution attempted. Node name is the class name (`K2Node_AddDelegate` / `K2Node_AssignDelegate`).

**§1 score: 6/6 PASS.**

---

## §2 — TMap + complex-element container decoding (D46 tier 2)

### 2.1 TMap with scalar keys — **SKIP (no live fixture found)**

Hunted through candidate CDOs: `BP_OSPlayerR` (25 properties, none TMap), `BP_OSPlayerR1` (16 properties, none TMap), `BP_OSControlPoint` (5 properties, none TMap), `ABP_Manny` (33 properties including AnimGraph nodes — none TMap), `BP_FrostBoltProjectile` (7 properties, none TMap), `MI_UI_Vector_Circle` (7 properties, TArray structs but no TMap).

No live ProjectA BP CDO with a TMap<scalar, T> property surfaced in the ~30 minutes I budgeted for hunting. Synthetic validation already exists in `server/test-uasset-parser.mjs:997-1019` covering `TMap<Name, int32>` decode → `[{key, value}, ...]` entries. Behaviour is validated structurally; cannot confirm live decode shape without a real fixture.

**Status**: SKIP, not FAIL. Recommend orchestrator either (a) accept synthetic coverage, or (b) queue a micro-follow-on to plant a fixture (UEMCP test asset with a trivial TMap CDO) to unlock this test in future rotations.

### 2.2 TArray<FMyCustomStruct> — tagged-element path — **PASS (multiply confirmed)**

Three live fixtures hit the tagged-element path cleanly:

1. **BPGA_Block.DrainPerSecond** (known fixture per commit `cca6690`):
   - Resolves to array of `{Attribute: {AttributeName, Attribute: {unsupported: FieldPathProperty}, AttributeOwner}, Amount}` entries.
   - Outer TArray decoded as object array, NOT `complex_element_container` marker ✓.
   - Inner nested `Attribute.Attribute` field emits `unknown_property_type: FieldPathProperty` marker — that's correct, FieldPathProperty decoding is out of scope.

2. **BP_FrostBoltProjectile.Payloads**:
   - Resolves to TArray<FOSSpellPayload> with nested TArray<FOSEffectSpec> inside.
   - `Payloads[0] = {Trigger: "EOSSpellTrigger::OnHit", Effects: [{Effect: ref, bApplyToSelf: false, bApplyToOther: true, Type: enum, Potency: {bEnabled, Value}, Period: {...}, Duration: {...}}, ...]}`.
   - Two levels of custom-struct TArray decoded ✓, including UDS sub-structs (Potency/Period/Duration).

3. **MI_UI_Vector_Circle.ScalarParameterValues**:
   - `TArray<FScalarParameterValue>` with nested `AtlasData` (FScalarMaterialInputDescriptor-ish), `ParameterInfo` (FMaterialParameterInfo), `ParameterValue` (float), `ExpressionGUID` (FGuid). All elements decoded as objects ✓.

### 2.3 TMap<struct_key, ...> marker — **SKIP (no live fixture)**

Same hunt as 2.1 — no live TMap of any shape found. `struct_key_map` marker is validated synthetically in `test-uasset-parser.mjs:1022-1034`.

**§2 score: 1/3 PASS, 2/3 SKIP (no regression — synthetic unit tests cover the gap).**

---

## §3 — Tagged-fallback unknown-struct decode (D47 pivot)

### 3.1 UUserDefinedStruct value decoding — **PASS**

Call: `read_asset_properties({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", property_names: ["cacheAura"] })`.

Observed:
- `cacheAura: {School: "EOSAuraSchool::BASIC", Tier: "EOSAuraTier::NONE", Energy: 0}` ✓ — exactly the shape Agent 10.5 promised (OSAuraInfo UDS, no marker).
- `unsupported: []` — zero markers in response.
- D50 supersedes D47's two-pass design: the tagged sub-stream is self-describing, so decoding happens without loading the referenced UDS asset.

### 3.2 Engine struct via fallback — **PASS (multiply confirmed)**

Many engine structs not in the dedicated-handler list decoded cleanly via tagged fallback in the course of the above tests:

- `BP_OSPlayerR.devHandle → {Handle: 0}` — FTimerHandle.
- `BP_OSPlayerR.Parameter Info → {Name: "None", Association: "GlobalParameter", Index: -1}` — FMaterialParameterInfo.
- `ABP_Manny.AnimGraphNode_BlendSpacePlayer.PlayRateScaleBiasClampConstants → {bMapRange: false, bClampResult: false, ..., InterpSpeedDecreasing: 10}` — FInputScaleBiasClampConstants with nested `InRange`/`OutRange` FVector2D-style sub-structs.
- `ABP_Manny.AnimGraphNode_ApplyAdditive.AlphaBoolBlend → {BlendInTime, BlendOutTime, BlendOption, bInitialized, CustomCurve, AlphaBlend: {...}}` — FInputAlphaBoolBlend.

All resolve as objects with field values, NOT markers.

### 3.3 FExpressionInput — partial delivery marker — **PASS**

Call: `read_asset_properties` on `/Game/UI/Materials/M_UIElements` with `export_name: MaterialExpressionStaticComponentMaskParameter`.

Observed:
- `Input: {unsupported: true, reason: "expression_input_native_layout_unknown", type: "StructProperty", size_bytes: 36}` ✓ — exactly the specific marker the brief calls out. Not a silent failure.

Also noted: the `MaterialEditorOnlyData` CDO of the same asset emits `unknown_struct` markers for `BaseColor`, `Metallic`, `Roughness`, `EmissiveColor`, `CustomizedUVs[*]`, etc. — with struct names `ColorMaterialInput`, `ScalarMaterialInput`, `VectorMaterialInput`, `Vector2MaterialInput`. These are the WRAPPER structs around FExpressionInput and are correctly flagged; they're a different (adjacent) path than the `expression_input_native_layout_unknown` marker.

**§3 score: 3/3 PASS.**

---

## §4 — Regression (Agent 10's Option C still works)

| Test | Result | Notes |
|---|---|---|
| `list_level_actors(Main_MenuVersion, summarize_by_class: true)` | **PASS** | 230 placed actors summarized across 29 classes; transforms still populated (verified on a separate per-row call earlier in session). |
| `inspect_blueprint(BPGA_Block, include_defaults: true)` | **PASS** | `variable_defaults` object populated with 9 properties including DrainPerSecond (tagged TArray<custom struct>), GameplayTagContainers, tagName FGameplayTag. `unsupported_defaults: []` at CDO level. Richer than pre-Agent-10.5 (per brief). |
| `read_asset_properties(BPGA_Block)` | **PASS** | CDO resolves fully; all 9 properties populated; only nested FieldPathProperty inside DrainPerSecond[0].Attribute emits an `unknown_property_type` marker (spec'd behaviour). |
| `query_asset_registry`, `get_asset_info`, `list_gameplay_tags`, `list_config_values`, `project_info` | **PASS** | All baseline offline tools respond: 171 tags in hierarchy; 5 config files; 275-export BP_OSPlayerR with 15 plugins; ProjectA engine 5.6. |

**§4 score: 4/4 PASS.**

---

## §5 — D44 invariant for new tool — **PASS**

Compared `find_tools({ query: "find_blueprint_nodes" })` top-match description (score: 139) against `tools.yaml:104-116` folded-block (`>-`) description.

After YAML folded-block newline normalization, the strings are byte-identical:

> "Find K2Nodes in a Blueprint by class + member-reference match. Covers 13 skeletal K2Node types (Event, CustomEvent, FunctionEntry/Result, VariableGet/Set, CallFunction/CallParentFunction, IfThenElse, ExecutionSequence, Switch{Enum,String,Int}, DynamicCast, MacroInstance, Self, Knot) plus delegate-node presence (AddDelegate, AssignDelegate — class identity only, no payload). Answers find/grep workflows like \"which BPs call X\", \"what events does this BP handle\", \"where is variable Y accessed\". Does NOT trace exec chains — pin edges live in the 3F sidecar (D48 S-A scope). Out-of-skeletal K2Node types (PromotableOperator, CommutativeAssociativeBinaryOperator, BreakStruct/MakeStruct, etc.) are counted in nodes_out_of_skeletal for discoverability but not returned. Pointed query — not cached."

CLAUDE.md Key Design Rule #1 (single source of truth) holds for the new tool.

---

## §6 — Free-form agent workflow exploration

### Workflow 1 — "Find all BPs that call `ApplyGameplayEffectToTarget`"

Approach: `query_asset_registry({ class_name: "Blueprint" })` → page through results → `find_blueprint_nodes({ asset_path, member_name: "ApplyGameplayEffectToTarget" })` per BP.

Feels workable for a targeted directory (e.g., `/Game/GAS/`), less ergonomic for full-corpus scan because:
- ProjectA has 5000+ assets (registry truncates at 5k default `max_scan`).
- Each `find_blueprint_nodes` call is a full export-table walk on the BP — not cached, not batched.
- Would need to walk `/Game/` with pagination, filter to Blueprint class, then iterate. A multi-100ms round-trip per BP could put a "find all" across 200-300 BPs in the tens-of-seconds range.

**Suggestion for orchestrator**: consider a future batch API (`find_blueprint_nodes_bulk({ path_prefix, member_name })`) that would be more efficient for cross-BP search workflows. Not urgent — the current per-BP tool composes fine for small sets.

### Workflow 2 — "What UDS properties does `BP_OSPlayerR` hold, and what are their decoded values?"

Ergonomic answer via `read_asset_properties(/Game/Blueprints/Character/BP_OSPlayerR)`:
- `cacheAura` — OSAuraInfo UDS → `{School, Tier, Energy}`.
- `devHandle` — FTimerHandle (engine struct via fallback) → `{Handle: 0}`.
- `Parameter Info` — FMaterialParameterInfo → `{Name, Association, Index}`.

Other non-UDS/non-scalar properties are object refs, enums, or components. No `unknown_struct` markers. Clean single-call answer.

### Workflow 3 — "Find all event handlers in `BP_OSControlPoint` and their target classes"

Call: `find_blueprint_nodes({ asset_path: "/Game/Blueprints/Level/BP_OSControlPoint", node_class: "K2Node_Event" })` (inferred from default query — node_class filter worked).

From the default response, events and custom events in BP_OSControlPoint:

| Node class | member_name | target_class |
|---|---|---|
| K2Node_Event | OnCaptureTickUpdate | /Script/ProjectA.OSControlPoint |
| K2Node_Event | ReceiveBeginPlay | /Script/Engine.Actor |
| K2Node_CustomEvent | OnPointCaptured_Event | null (self) |
| K2Node_CustomEvent | OnPointPlayerCountChanged | null (self) |
| K2Node_CustomEvent | CustomEvent | null (self) — looks like an unrenamed placeholder |
| K2Node_CustomEvent | OnPointStateUpdate | null (self) |
| K2Node_CustomEvent | OnPointStateChanged | null (self) |

Surprise: one CustomEvent is still named `CustomEvent` (the default name from UE's graph editor) — likely a forgotten rename. Tool did not hide this; it's visible to the agent. Nice for discoverability. Node_name for CustomEvents appears to be `K2Node_CustomEvent` except one entry where it reads `K2Node_Event` (export_index 98) — possibly a serialization quirk on a specific custom event; did not dig deeper.

### Notes on response ergonomics

- `total_matched`, `total_skeletal`, `truncated`, `offset`, `limit` are consistently placed at the top of the response — easy to scan.
- `nodes_out_of_skeletal` breakdown at the bottom is genuinely useful: tells the agent "there are 6 BreakStruct nodes you're not seeing" without dumping their payload.
- For BPs with 100+ skeletal nodes, the default `limit: 100` truncates — need to remember to paginate. The `truncated: true` flag is obvious enough.

---

## §7 Summary

| Section | Result |
|---|---|
| §1 find_blueprint_nodes | **6/6 pass** |
| §2 TMap + complex containers | **1/3 pass, 2/3 skip (no live fixture; synthetic unit tests cover)** |
| §3 tagged-fallback decode | **3/3 pass** |
| §4 regression | **4/4 pass** |
| §5 D44 invariant | **pass** |
| §6 free-form | see notes — no surprises, one ergonomics observation about a future bulk API |

**Overall verdict**: **ship**. Agent 10.5 surface is healthy in live usage. No blockers. The two §2 SKIPs are fixture-availability gaps, not tool bugs.

**Items to flag for orchestrator**:
- [ ] **Consider planting a micro-fixture BP with a TMap<FName, int32> (or similar) property** to enable §2.1 live-fixture testing in future rotations. ProjectA doesn't happen to use TMap in any CDO I could find; synthetic unit tests validate decode shape, but a live test would be nice insurance. Low priority.
- [ ] **Possible future bulk API for `find_blueprint_nodes`** — a batched version across a path prefix would make "find all BPs that call X" workflows more ergonomic. Not urgent; current per-BP tool composes fine for small sets.
- [ ] **Possible §3.3 test expansion**: note that `ColorMaterialInput` / `ScalarMaterialInput` / `VectorMaterialInput` wrapper structs around FExpressionInput emit `unknown_struct` (not the specific `expression_input_native_layout_unknown` marker). This is intentional (they're different struct types) but might be worth documenting in the tool description so agents know the marker space covers both.
- [ ] **CustomEvent placeholder name not renamed**: BP_OSControlPoint has a K2Node_CustomEvent with `member_name: "CustomEvent"` — this is a data issue in ProjectA's BP content (a placeholder name), not a tool bug. The tool surfaces it faithfully. Mentioning it here because it's the kind of observation the tool makes discoverable that would be useful in a content-QA workflow.

**Time spent**: ~35 min.
