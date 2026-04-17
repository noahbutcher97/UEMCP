# Agent 10.5 Handoff — Bundled Follow-On (D46 complex + D47 UDS + D48 S-A + engine struct extensions)

> **Dispatch**: After Agent 10 lands (done — commits `97a9ba1`, `b5834c0`, `a24043e`, `9144664`). Agent 10.5 is the bundled follow-on per D48 Q-1 Mode A.
> **Depends on**: Agent 10's shipped parser (L1 FPropertyTag iteration + L2 struct handlers + L2.5 simple-element containers + Option C tools) as foundation. Agent 11.5 deliverable for the S-A skeletal scope. D46/D47/D48 for decision rationale.
> **Type**: IMPLEMENTATION. Multi-day. Single bundled session per Mode A.
> **D-log**: D46 (L3B complex containers), D47 (UUserDefinedStruct resolver), D48 (S-A skeletal K2Node name-only surface), plus 5 engine struct handlers from Agent 10's §Known issues #3.

---

## Mission

Extend Agent 10's production parser infrastructure with four related extensions that all share the same struct-registry extension pattern:

1. **D46 complex-element containers**: `TMap<K,V>`, `TArray<FMyCustomStruct>`, `TSet<FMyCustomStruct>`. The simple-element case is already shipped (Agent 10 commit `b5834c0`).
2. **D47 UUserDefinedStruct two-pass resolver**: load the struct asset, cache member layout, resolve `StructProperty` references when encountered.
3. **D48 Tier S-A skeletal K2Node name-only surface**: 13 K2Node types exposing FMemberReference / FGraphReference / FUserPinInfo / FSimpleMemberReference payloads for find/grep workflows. NOT pin tracing (Tier S-B is FOLD-INTO-3F).
4. **5 engine struct handlers** (Agent 10 §Known issues #3): `FBodyInstance`, `FExpressionInput`, `FBox`, `FVector4`, `FIntPoint`. Covers ~60% of the 251K `unknown_struct` markers Agent 10's bulk validation surfaced. Same pattern as existing Level 2 handlers.

All four share infrastructure (add structs to Agent 10's registry; extend FPropertyTag handling where needed for container inner types; wire new tool surface for S-A). Bundling is the right shape per D48 Q-1 Mode A decision.

---

## What Agent 10 shipped (your foundation)

Read these before starting — they define the surface you extend:

- `server/uasset-parser.mjs` — core parser with UE 5.6 FPropertyTag decoder (hand-verified; see Agent 10 final report for the byte layout + flag bits). Handles L1 scalar properties, L2 engine structs (12 shipped), L2.5 simple-element containers.
- `server/uasset-structs.mjs` — Level 2 struct handler registry. Your 5 new engine structs extend this.
- `server/offline-tools.mjs` — Option C handlers: modified `list_level_actors` (transforms always-on + pagination), `inspect_blueprint` (include_defaults), new `read_asset_properties`.
- `tools.yaml` — the 3 Option C tools declared per D44 yaml-as-truth. Your S-A tool surface adds here.
- Agent 10's final report (in commit `9144664` message or in orchestrator chat history) — documents exactly what's handled vs what emits markers. Critical to avoid re-implementing anything.
- `docs/audits/agent10-bulk-validation-2026-04-16.md` — 19K-file validation report. Shows the 251K `unknown_struct` marker distribution that informs your scope prioritization.

**Critical inherited knowledge** — do NOT re-derive:
- UE 5.6 FPropertyTag layout: `1B preamble + FName + FPropertyTypeName (recursive) + int32 Size + byte Flags + optional ArrayIndex/PropertyGuid + value`. Flag bits: `0x01 HasArrayIndex`, `0x02 HasPropertyGuid`, `0x04 HasPropertyExtensions`, `0x08 HasBinaryOrNativeSerialize`, `0x10 BoolTrue`.
- V9.5 corrections #1 (outerIndex reverse scan) + #2 (UE 5.6 layout) are already absorbed in Agent 10's code. Inherit them.

---

## Scope tier 1 — 5 engine struct handlers (warm-up, ~0.5 session)

Add to `server/uasset-structs.mjs` following the existing handler pattern:

| Struct | Likely byte layout | Reference |
|---|---|---|
| `FBodyInstance` | Complex — physics body flags + collision profile + various bool/enum UPROPERTYs. Most members are tagged-property, not custom serialize. Dispatch on flag 0x08 for the complex case; tagged case lands through normal FPropertyTag iteration. | CUE4Parse `UE4/Objects/PhysicsEngine/BodyInstance.cs` |
| `FExpressionInput` | Material graph input — `ExpressionPtr`, `OutputIndex`, `Mask`, mask channels. Mostly tagged. | CUE4Parse `UE4/Objects/Engine/Materials/FExpressionInput.cs` |
| `FBox` | 2 × FVector (min, max) + `bIsValid: uint8` = 49 bytes native | UE core math |
| `FVector4` | 4 × float64 = 32 bytes | UE core math |
| `FIntPoint` | 2 × int32 = 8 bytes | UE core math |

Start with the 3 simple ones (`FBox`, `FVector4`, `FIntPoint`) — they're ~30 minutes each including tests. Then `FExpressionInput` (tagged, medium). Save `FBodyInstance` for last (tagged, many fields).

Verify via bulk validation: re-run Agent 10's 19K-file scan, confirm `unknown_struct` marker count drops by ~60% (from 251K to ~100K).

---

## Scope tier 2 — D46 complex-element containers (~2 sessions)

Agent 10 shipped `TArray`/`TSet` of simple elements. Deferred:

### `TMap<K, V>` — new handler

Reference: CUE4Parse `FScriptMap`. Encoding:
- Leading `NumRemovedKeys: int32` (should be 0 except in save games; emit marker if non-zero).
- `NumElements: int32`.
- Per element: key bytes followed by value bytes, both using FPropertyTag-style dispatch.
- Key types to support: scalar types (Int/Name/Str/Enum), not struct keys. `TMap<Struct, T>` emits `{unsupported: true, reason: "struct_key_map"}`.
- Value types: anything the array machinery already handles (scalars + engine structs + custom structs via D47 once D47 lands).

### `TArray<FMyCustomStruct>` + `TSet<FMyCustomStruct>` — requires D47

The blocker is resolving the custom struct's layout. Agent 10 emits `{unsupported: true, reason: "complex_element_container", inner_type, size_bytes}` for these today. Once D47 lands (next tier), update the container handlers to:
1. Detect the inner type is a UserDefinedStruct.
2. Call the D47 resolver to get the struct's member layout.
3. For each element, apply the layout to read member values.
4. Return the parsed element dict.

Cycle-safe: if a custom struct references itself (rare), bounded recursion with cycle detection.

---

## Scope tier 3 — D47 UUserDefinedStruct two-pass resolver (~2-3 sessions)

The core infrastructure. Everything below depends on this.

### Design

Two-pass parser:
- **Pass 1 — struct layout resolver**: given a StructProperty referencing `/Game/.../ST_Foo`, load the struct's own `.uasset`, walk its export for members (each member is a `UStructProperty`/`UFloatProperty`/etc. export), extract `{name, type, inner_type}` per field. Cache in a registry keyed by the struct's generated-class path.
- **Pass 2 — value resolver**: when a `StructProperty` with that struct name is encountered during normal FPropertyTag iteration, look up the cached layout and apply field-by-field reads.

### Cache lifecycle

Reuse Agent 10's `assetCache.indexDirty` mechanism (D33). When a `.uasset` changes, indexDirty invalidates dependent struct layout entries. Cycle-safe: bounded by package-load depth (typical ≤2-3 hops).

### ProjectA fixtures for testing

Agent 10 identified 30 UserDefinedStructs in ProjectA (spot-check from D47 lookup). Use these as test cases:
- `/Game/ProjectA/Data/DataTables_Structs/ST_AttackAnimInfo_Fighter.uasset` — simple struct, good starting test.
- `/Game/ImportedAssets/AnimGameSample/Blueprints/Data/S_BlendStackInputs.uasset` — nested engine structs.
- `/Game/ImportedAssets/AnimGameSample/Blueprints/Data/S_TraversalCheckResult.uasset` — compound type.

### Graduation path

Once D47 lands:
- `TArray<FMyCustomStruct>` handlers automatically work (via tier 2 above).
- `TMap<FName, FMyCustomStruct>` works.
- 10.5% of the remaining `unknown_struct` markers (after tier 1 lands) resolve.

---

## Scope tier 4 — D48 S-A skeletal K2Node surface (~1.5-2 sessions)

Per Agent 11.5's research:

### Struct registry additions

Add to `uasset-structs.mjs` (same pattern as tier 1):
- `FMemberReference` (`MemberParent: TObjectPtr`, `MemberScope: FString`, `MemberName: FName`, `MemberGuid: FGuid`, `bSelfContext: bool`, `bWasDeprecated: bool`) — used by VariableGet/Set, Event, CallFunction nodes.
- `FGraphReference` (`MacroGraph`, `GraphGuid`, `GraphName`) — used by MacroInstance.
- `FSimpleMemberReference` — variant used in some contexts.
- `FUserPinInfo` — used by FunctionEntry/Result for user-defined pins.

All four are standard UPROPERTY structs (no custom Serialize()) — mechanical registry entries.

### Semantic field extraction helpers

Per Agent 11.5 §6.1, write thin wrappers that pluck the semantically-meaningful fields from parsed tags:
- `extractMemberName(exportProps)` — reads `VariableReference.MemberName` or `FunctionReference.MemberName` or `EventReference.MemberName` depending on node class.
- `extractTargetClass(exportProps)` — for CallFunction, reads `FunctionReference.MemberParent`.
- `extractMacroPath(exportProps)` — for MacroInstance, reads `MacroGraphReference.MacroGraph`.
- etc.

### New tool surface

Per Agent 11.5 §6 + D48:

**`find_blueprint_nodes`** — new tool in offline toolset (or add to existing `inspect_blueprint` as a new param; recommend new tool to keep surface clean):

```yaml
find_blueprint_nodes:
  description: >
    Find K2Nodes in a Blueprint by class + member reference match. Covers 13
    skeletal K2Node types (Event, CustomEvent, FunctionEntry/Result,
    VariableGet/Set, CallFunction/CallParentFunction, IfThenElse,
    ExecutionSequence, Switch{Enum,String,Int}, DynamicCast, MacroInstance,
    Self, Knot). Answers find/grep workflows like "which BPs call X",
    "what events does this BP handle", "where is variable Y accessed".
    Does NOT trace exec chains — pin edges live in the 3F sidecar.
  params:
    asset_path:     { type: string, required: true }
    node_class:     { type: string, required: false, description: "Filter by K2Node class (e.g., K2Node_CallFunction). Omit for all skeletal types." }
    member_name:    { type: string, required: false, description: "Filter by FMemberReference.MemberName match (function name, variable name, event name)." }
    target_class:   { type: string, required: false, description: "Filter by FMemberReference.MemberParent class path (e.g., /Script/GameplayAbilities.GameplayAbility)." }
    limit:          { type: number, required: false, default: 100 }
    offset:         { type: number, required: false, default: 0 }
```

Response shape:
```
{
  path, asset_name,
  nodes: [
    { node_class, member_name, target_class, macro_path?, graph_name?, export_index, extras: {delegate_type?, ...} },
  ],
  total_matched, total_skeletal, truncated, offset, limit,
  nodes_out_of_skeletal: [{node_class, count}]  // for discoverability
}
```

**Delegate-node presence reporting** (Q-3 decision): `K2Node_AddDelegate`, `K2Node_AssignDelegate` report as class identity only (no payload). Free since tag iteration already yields `exports[].className`.

### Out of scope

- Tier S-B pin tracing — FOLD-INTO-3F per D48.
- Math/comparison operators (PromotableOperator, EnumEquality) — Q-2 defer.
- UEdGraph full dump — D45 permanently EDITOR-ONLY.

---

## Implementation order

Recommended:

1. **Tier 1** (5 engine structs) — warm-up, low-risk, immediate bulk-validation win.
2. **Tier 3** (D47 custom-struct resolver) — the infrastructure everything else depends on. Land before tier 2 complex containers so tier 2 can use it.
3. **Tier 2** (D46 complex containers + TMap) — builds on tier 3.
4. **Tier 4** (D48 S-A skeletal) — independent of 2/3, but the struct-registry entries (`FMemberReference` etc.) share the pattern established in tier 1. Natural to do last when the pattern is most practiced.

Alt: if any tier hits unexpected complexity, report and split. Do not silently bloat scope.

---

## Testing

Each tier extends the existing test rotation:
- **Parser-level** (`server/test-uasset-parser.mjs` or new supplementary): per-struct handler correctness, encoding edge cases, cycle safety for D47.
- **Tool-level** (`server/test-phase1.mjs` or new supplementary): `find_blueprint_nodes` queries on ProjectA BPs, result-shape verification.
- **Bulk validation**: re-run Agent 10's 19K-file scan. Expected: `unknown_struct` markers drop from 251K → ~100K (tier 1) → ~25K (tier 3 for top 30 ProjectA UserDefinedStructs) → lower still with tiers 2+4.

D44 invariant check: `tools/list` and `find_tools` must show identical descriptions for `find_blueprint_nodes` post-landing.

Performance target: per-file parse time must stay ≤2× Agent 10's baseline (0.80 ms avg). Full bulk validation ≤32s (2× Agent 10's 16.1s).

---

## File scope

| File | Action |
|---|---|
| `server/uasset-parser.mjs` | Extensions for TMap + container recursion through D47 |
| `server/uasset-structs.mjs` | 5 engine structs + FMemberReference/FGraphReference/FSimpleMemberReference/FUserPinInfo + D47 custom-struct resolver |
| `server/offline-tools.mjs` | `find_blueprint_nodes` handler + CDO property resolution extensions for UserDefinedStructs |
| `tools.yaml` | `find_blueprint_nodes` entry (D44 yaml-as-truth — do NOT reintroduce `server.mjs:offlineToolDefs`) |
| `server/test-phase1.mjs` | Tier 4 tool-level tests |
| `server/test-uasset-parser.mjs` or new supplementary suite | Parser-level correctness + D47 cycle safety |
| `server/server.mjs` | One new registration block for `find_blueprint_nodes` (offline toolset) |

**Do NOT touch**: `tcp-tools.mjs`, `connection-manager.mjs`, `test-tcp-tools.mjs`, `test-mock-seam.mjs`, `plugin/`, `docs/specs/`, `docs/tracking/` (orchestrator writes D50+).

---

## Commit convention

- One commit per tier minimum (4-7 commits expected across the session).
- Path-limited commits per D49: `git commit <path> -m "..."` not `git add && git commit`.
- Reference tier ID in commit message (e.g., "Agent 10.5 tier 1: add FBox/FVector4/FIntPoint handlers").
- No AI attribution.
- Desktop Commander mandatory for git, shell: "cmd".

---

## Out of scope

- Tier S-B pin tracing (D48 FOLD-INTO-3F).
- Additional engine structs beyond the 5 in tier 1 — defer to a future cleanup pass if other `unknown_struct` markers remain high-frequency.
- Math/comparison operator K2Nodes (PromotableOperator etc.) per Q-2.
- Phase 3 plugin work (D39).
- `server.mjs:offlineToolDefs` resurrection.
- Pre-existing int64 VFX mesh parse bug — separate cleanup worker per Agent 10 §Known issues #1.
- Pre-existing semgrep dynamic-regex finding — same cleanup worker.
- Phase 4 HTTP/Remote-Control integration.

---

## Final report format

```
Agent 10.5 Final Report — Bundled Follow-On (D46 complex + D47 UDS + D48 S-A + 5 engine structs)

Tier 1 (5 engine structs): [status]
  Bulk validation unknown_struct marker reduction: [N → M]
Tier 2 (D46 complex containers): [status]
  TMap handling: [status]
  TArray<FMyCustomStruct>: [status — depends on tier 3]
Tier 3 (D47 UserDefinedStruct resolver): [status]
  ProjectA UserDefinedStructs resolved: [N of ~30]
  Cycle safety verified: [yes / N/A]
Tier 4 (D48 S-A skeletal K2Node surface): [status]
  K2Node types surfaced: [N of 13]
  find_blueprint_nodes tool: [shipped / pending]
Test results: [X]/[Y] assertions (baseline 561 + new)
Commits: [list with SHAs]
Performance: [per-file parse, bulk scan time — vs Agent 10 baseline]
D44 invariant (tools/list == find_tools descriptions): [verified]
Phase 3 scope impact: [further reductions beyond Agent 9's 13 tools]
Known issues / deferred: [any]
```
