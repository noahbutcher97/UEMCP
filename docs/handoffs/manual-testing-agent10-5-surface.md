# Manual Testing Handoff — Agent 10.5 Surface

> **Dispatch**: After Agent 10.5 ships (done — commit `f339773`). Similar pattern to the Agent 10 manual test.
> **Session type**: Fresh Claude Code session at UEMCP project root, MCP server connected, UEMCP toolset auto-enabled.
> **Duration**: 30-45 minutes.
> **Output**: Fill pass/fail + notes inline; save as `docs/testing/2026-04-16-agent10-5-manual-results.md`.

---

## Pre-flight

- [ ] UNREAL_PROJECT_ROOT = `D:/UnrealProjects/5.6/ProjectA/ProjectA`
- [ ] MCP server running; HEAD includes `f339773` (Agent 10.5 tier 4)
- [ ] Baseline tests green: 612/612 expected

Goal: validate Agent 10.5's new surface in real usage — (a) the new `find_blueprint_nodes` tool, (b) TMap + complex-element container handling, (c) the tagged-fallback unknown-struct decode works correctly, (d) no regressions on Agent 10's Option C tools.

---

## §1 — `find_blueprint_nodes` (new tool, D48 S-A skeletal)

### 1.1 Default query (no filters)

Call `find_blueprint_nodes({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR" })`.

Expected:
- `nodes[]` contains K2Node entries with `node_class`, `member_name`, `target_class` (where applicable), `export_index`.
- `total_skeletal: ~184` per Agent 10.5's spot-check.
- `nodes_out_of_skeletal: [{node_class, count}]` breakdown for discoverability.
- `truncated` + `offset: 0` + `limit: 100` pagination fields present.

**PASS/FAIL**:
**Notes**:

### 1.2 Filter by event (find BeginPlay handlers)

Call `find_blueprint_nodes({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", node_class: "K2Node_Event", member_name: "ReceiveBeginPlay" })`.

Expected:
- Filtered result with only ReceiveBeginPlay event node(s).
- `target_class: "/Script/Engine.Actor"` resolved correctly per Agent 10.5's spot-check.
- `total_matched: 1` typical for this filter.

**PASS/FAIL**:
**Notes**:

### 1.3 Filter by function call target

Call `find_blueprint_nodes({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", node_class: "K2Node_CallFunction", member_name: "StartMontage" })` or pick a function name BP_OSPlayerR likely calls.

Expected:
- Returns CallFunction nodes targeting that function name. Zero matches returns `total_matched: 0, nodes: []`, not an error.

**PASS/FAIL**:
**Notes**:

### 1.4 Target class suffix match

Call `find_blueprint_nodes({ asset_path: "/Game/GAS/Abilities/BPGA_Block", target_class: "GameplayAbility" })` — tests suffix-match behaviour (MemberParent often fully qualified).

Expected:
- Returns nodes whose `target_class` resolves to something containing "GameplayAbility" (e.g., `/Script/GameplayAbilities.GameplayAbility`).

**PASS/FAIL**:
**Notes**:

### 1.5 Pagination

Call `find_blueprint_nodes({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", limit: 10, offset: 50 })`.

Expected:
- Returns 10 nodes starting from index 50. `truncated: true` since 184 total > 60 returned.

**PASS/FAIL**:
**Notes**:

### 1.6 Delegate presence (Q-3 decision)

Find a BP with AddDelegate / AssignDelegate (`BP_OSControlPoint` is a known candidate per Agent 11.5 sample §3.2). Call `find_blueprint_nodes({ asset_path: "/Game/Blueprints/Level/BP_OSControlPoint" })`.

Expected:
- Result includes `K2Node_AddDelegate` or `K2Node_AssignDelegate` entries — class identity only, no payload resolution.

**PASS/FAIL**:
**Notes**:

---

## §2 — TMap + complex-element container decoding (D46 tier 2)

### 2.1 TMap with scalar keys

Find a BP CDO holding a `TMap<FName, T>` — try `BP_OSPlayerR` or widget BPs (UMG often uses name-keyed maps). Call `read_asset_properties({ asset_path: "...", property_names: ["<map_property>"] })` where `<map_property>` is the UPROPERTY name.

Expected:
- The map resolves to a JS object `{ "keyName1": value1, "keyName2": value2, ... }`, NOT a `container_deferred` marker.
- Values resolve correctly per their type.

**PASS/FAIL**:
**Notes**:

### 2.2 TArray<FMyCustomStruct> — tagged-element path

Find a BP holding a `TArray<FMyCustomStruct>` where FMyCustomStruct is a UUserDefinedStruct. ProjectA candidates: any BP using `FBlendStackInputs`, `FTraversalCheckResult`, or similar custom structs.

Expected:
- Array elements resolve as objects (not markers). Each element has the struct's fields populated via tagged fallback.
- No `complex_element_container` marker for this property — it should decode cleanly.

**PASS/FAIL**:
**Notes**:

### 2.3 TMap<struct_key, ...> marker

If you find any TMap with a struct key (e.g., `TMap<FGuid, T>` — less common but possible in asset-registry patterns), expected: `struct_key_map` marker, not a silent failure or misdecoded data.

**PASS/FAIL** (can be SKIP if no such TMap found):
**Notes**:

---

## §3 — Tagged-fallback unknown-struct decode (D47 pivot)

### 3.1 UUserDefinedStruct value decoding

Find a BP CDO containing a UUserDefinedStruct property. E.g., `BP_OSPlayerR` per Agent 10.5's spot-check ("OSAuraInfo UDS + 3 engine structs, previously 4 unknown_struct markers, now 0; cacheAura decodes as {School, Tier, Energy}").

Call `read_asset_properties({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", property_names: ["cacheAura"] })` (or similar known UDS property).

Expected:
- Property resolves to a JS object with the UDS's field names + values, not `unknown_struct` marker.
- Agent 10.5 reported the specific `{School, Tier, Energy}` shape — verify.

**PASS/FAIL**:
**Notes**:

### 3.2 Engine struct via fallback

Pick any engine struct that Agent 10.5 noted resolves via tagged fallback (FBox, FVector4, etc.). Call `read_asset_properties` on a BP CDO or actor that holds one. Expected: resolves to object, not marker.

**PASS/FAIL**:
**Notes**:

### 3.3 FExpressionInput — partial delivery

Find a Material or Material Function referencing `FExpressionInput`. Call `read_asset_properties`. Expected: most instances emit the specific `expression_input_native_layout_unknown` marker (21,876 per Agent 10.5 bulk run). NOT a silent failure. Marker is informative.

**PASS/FAIL**:
**Notes**:

---

## §4 — Regression (Agent 10's Option C still works)

Quick smoke-test that Agent 10's Option C tools still function correctly after Agent 10.5's changes:

- [ ] `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion" })` — transforms still populated, pagination still works.
- [ ] `inspect_blueprint({ asset_path: "/Game/GAS/Abilities/BPGA_Block", include_defaults: true })` — `variable_defaults` now includes richer values (fewer markers per Agent 10.5's pivot).
- [ ] `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block" })` — CDO resolves; any previously-unknown-struct properties now yield values.
- [ ] `query_asset_registry`, `get_asset_info`, `list_gameplay_tags`, `list_config_values`, `project_info` — baseline offline tools still work.

**PASS/FAIL** for each:

---

## §5 — D44 invariant for new tool

Run `find_tools({ query: "find_blueprint_nodes" })` and capture the description. Compare against the `tools.yaml` entry for `find_blueprint_nodes`.

Expected: byte-identical strings (Agent 10.5 verified programmatically in their final report — re-confirm in live session).

**PASS/FAIL**:
**Notes**:

---

## §6 — Free-form agent workflow exploration

Simulate 2-3 realistic queries using the new tools:

1. "Find all BPs in ProjectA that call `ApplyGameplayEffectToTarget`." — Would require scanning many BPs; spot-check on a few known ones to see if the tool scales ergonomically for multi-BP workflows.
2. "What UDS properties does `BP_OSPlayerR` hold, and what are their decoded values?"
3. "Find all event handlers (K2Node_Event) in `BP_OSControlPoint` and their target classes."

Notes on response ergonomics, readability, any surprises:

---

## §7 Summary

| Section | Result |
|---|---|
| §1 find_blueprint_nodes | X/6 pass |
| §2 TMap + complex containers | X/3 pass |
| §3 tagged-fallback decode | X/3 pass |
| §4 regression | X/4 pass |
| §5 D44 invariant | pass/fail |
| §6 free-form | notes |

**Overall verdict**: [ship / minor issues flagged / blocker]

**Items to flag for orchestrator**:
- [ ]

**Time spent**: _ min

---

## Constraints

- Read-only testing. If you find a bug, flag it and continue — no code edits.
- Desktop Commander for git commit (single commit at end, path-limited).
- No AI attribution.
- If MCP server crashes or protocol desync, stop and report.
