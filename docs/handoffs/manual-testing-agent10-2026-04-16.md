# Manual Testing Handoff — Agent 10 Delivery (Level 1+2+2.5 + Option C tools)

> **Purpose**: Hand-verify Agent 10's shipped scope works as expected in real Claude Code usage against ProjectA. Automated tests prove the code is correct; manual testing catches UX issues the test suite can't — response shape ergonomics, description clarity in `tools/list`, realistic workflow coverage.
> **Session type**: Fresh Claude Code session at UEMCP project root, MCP server connected, UEMCP toolset auto-enabled.
> **Duration**: 30-45 minutes.
> **Output**: Fill in pass/fail + notes below each test; save as `docs/testing/2026-04-16-agent10-manual-results.md` when done.

---

## Pre-flight

- [ ] UNREAL_PROJECT_ROOT = `D:/UnrealProjects/5.6/ProjectA/ProjectA`
- [ ] MCP server running (`server/server.mjs`); HEAD at `ef9a5f7` or later
- [ ] Offline toolset enabled (confirm via `list_toolsets`)
- [ ] Primary and supplementary tests green: `test-phase1.mjs` + `test-mock-seam.mjs` + `test-tcp-tools.mjs` + supplementary suite (561/561)

Goal: verify the three Option C tool changes behave well under real queries, the underlying parser delivers on promised surface, and deferred features emit correct markers instead of silent breakage.

---

## §1 — `list_level_actors` (MODIFIED: transforms + pagination + summary)

### 1.1 Transforms on a small map

Call `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion" })`.

Expected:
- Response includes `actors[]` with transforms. About 230 placed actors (per V9.5 measurement).
- ~63% of actor rows should have `transform: null` (class defaults — intended behavior per V9.5 #3, NOT a bug).
- ~37% have `transform: { location: [x,y,z], rotation: [p,y,r], scale: [x,y,z] }`.
- Top-level: `total_placed_actors`, `truncated`, `offset: 0`, `limit: 100`.
- `truncated: true` because 230 > 100 default limit.

**PASS/FAIL**:
**Notes**:

### 1.2 Pagination — page 2

Call `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", offset: 100, limit: 100 })`.

Expected:
- `actors[]` returns the second 100. Actors should not overlap with page 1 results.
- `offset: 100`, `limit: 100`, `truncated: true` still (≥230 total).

**PASS/FAIL**:
**Notes**:

### 1.3 Summary mode on dense level (Bridges2)

Call `list_level_actors({ asset_path: "/Game/Maps/Deployable/PVP_Maps/Bridges2", summarize_by_class: true })`.

Expected:
- Response has `summary: { className: count }` — no per-row `actors[]` payload.
- `total_placed_actors: 2519` (or close).
- Response size should be small (few KB) despite the dense level.
- Agent 9 §4 decision: summary mode avoids the 346 KB unpaginated response problem.

**PASS/FAIL**:
**Notes**:

### 1.4 Cap enforcement

Call `list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion", limit: 5000 })`.

Expected:
- `limit` is capped at 500 (not 5000). Actual returned `limit` field = 500.
- No error; just silent capping.

**PASS/FAIL**:
**Notes**:

### 1.5 WorldSettings / no-component actor

Find an actor in a response that has `transform: null` AND inspect why. Expected: it's either a `WorldSettings`, a class-default case (no transform override serialized), or a Brush. Not a parse failure.

**PASS/FAIL**:
**Notes**:

---

## §2 — `inspect_blueprint` (MODIFIED: verbose → include_defaults)

### 2.1 Default call (no `include_defaults`)

Call `inspect_blueprint({ asset_path: "/Game/GAS/Abilities/BPGA_Block" })`.

Expected:
- Response has `exports[]`, `exportCount`, `importCount`, `parentClass` (`GA_OSBlock`), `generatedClass` (`BPGA_Block_C`).
- Response does NOT contain `variable_defaults` (include_defaults defaults to false).
- Response does NOT contain a `tags` field (F2 removed it; regression guard).
- Response does NOT contain `verbose` acknowledgment anywhere (param is renamed).

**PASS/FAIL**:
**Notes**:

### 2.2 `include_defaults: true`

Call `inspect_blueprint({ asset_path: "/Game/GAS/Abilities/BPGA_Block", include_defaults: true })`.

Expected:
- Everything from 2.1 PLUS `variable_defaults: { varName: value }` dict.
- Likely surfaces `AbilityTags` as a FGameplayTagContainer (array of strings), `CostGameplayEffectClass` as an object ref, etc.
- Any struct types not in Level 2 registry or any UUserDefinedStruct appears as `{ unsupported: true, reason: "unknown_struct", struct_name, size_bytes }` — NOT as a silent omission.
- Optional: top-level `unsupported_defaults: [{name, reason}]` parallel list.

**PASS/FAIL**:
**Notes**:

### 2.3 Backward-compat check — `verbose` param should be rejected

Call `inspect_blueprint({ asset_path: "/Game/GAS/Abilities/BPGA_Block", verbose: true })`.

Expected: Zod validation error or the param is silently dropped and behaves as if omitted. Either is acceptable; what matters is `verbose` is no longer a live param. If Zod strictly rejects unknown params, you get an error message mentioning `verbose`.

**PASS/FAIL** (either rejection OR silent-ignore is PASS; silent-misbehavior is FAIL):
**Notes**:

### 2.4 Non-BP asset (e.g., DataAsset or Material)

Call `inspect_blueprint({ asset_path: "/Game/ProjectA/Data/DataTables_Structs/ST_AttackAnimInfo_Fighter" })`.

Expected: parses; returns exports + structural metadata even though it's not a BlueprintGeneratedClass. `parentClass` may be null or point at a UserDefinedStruct parent.

**PASS/FAIL**:
**Notes**:

---

## §3 — `read_asset_properties` (NEW)

### 3.1 Default CDO on a BP

Call `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block" })`.

Expected:
- `export_name: "Default__BPGA_Block_C"`.
- `export_index` present.
- `struct_type`: the CDO's class name.
- `properties: { ... }` dict with resolved values.
- `property_count_returned`, `property_count_total` counts.
- `truncated: false` for a typical BP CDO.
- `unsupported[]` lists any properties that emitted markers (e.g., `AbilityTags` if it's a UUserDefinedStruct in your project — but for BPGA_Block, should resolve as FGameplayTagContainer).

**PASS/FAIL**:
**Notes**:

### 3.2 Filtered read

Call `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block", property_names: ["AbilityTags"] })`.

Expected:
- Only `AbilityTags` appears in `properties`. `property_count_returned: 1`, `property_count_total` reflects the full CDO count.

**PASS/FAIL**:
**Notes**:

### 3.3 Truncation behavior

Call `read_asset_properties({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", max_bytes: 500 })`.

Expected:
- `truncated: true`.
- `unsupported[]` contains entries with `reason: "size_budget_exceeded"` — capped at 20 entries (per Agent 10 report).
- No partial values in `properties` — any property that hit the budget is omitted, not included partially.

**PASS/FAIL**:
**Notes**:

### 3.4 Explicit non-CDO export

Call `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block", export_name: "BPGA_Block" })` (targets the BP asset export, not the CDO).

Expected: returns that export's properties, which differ from the CDO's. Exports that have no tagged properties return `properties: {}`, `property_count_total: 0`.

**PASS/FAIL**:
**Notes**:

### 3.5 WidgetBlueprint CDO

Call `read_asset_properties({ asset_path: "/Game/UI/Widgets/General/WBP_OSBaseButton" })`.

Expected:
- `export_name: "Default__WBP_OSBaseButton_C"`.
- Likely surfaces widget-specific properties (e.g., `bIsEnabled`, various widget refs).

**PASS/FAIL**:
**Notes**:

### 3.6 AnimBP CDO

Call `read_asset_properties({ asset_path: "/Game/Animations/Retargeted/StreetFighterAnimation/ABP_Manny" })`.

Expected:
- `export_name: "Default__ABP_Manny_C"`.
- Likely has state machine refs, blend space refs, plus any FVariables defaulted on the AnimBP.

**PASS/FAIL**:
**Notes**:

---

## §4 — Marker correctness (deferred features)

### 4.1 UUserDefinedStruct marker

Find a BP CDO that holds a UUserDefinedStruct variable (e.g., any BP using `FBlendStackInputs`, `FTraversalCheckResult`, or one of the ProjectA custom structs). Call `read_asset_properties` on it.

Expected: the UDS property appears in `unsupported[]` with `reason: "unknown_struct"`, and includes `struct_name` (e.g., `S_BlendStackInputs`) so the caller knows what to ask about. NOT silently missing.

**PASS/FAIL**:
**Notes**:

### 4.2 Complex container marker

Find a BP holding `TArray<FMyCustomStruct>` or `TMap<FName, FStruct>`. Call `read_asset_properties`.

Expected: the property appears in `unsupported[]` with `reason: "complex_element_container"` (arrays) or `"container_deferred"` (maps).

**PASS/FAIL**:
**Notes**:

### 4.3 Delegate properties

Expected: any `DelegateProperty` / `MulticastDelegateProperty` emits `{unsupported: true, reason: "delegate_not_serialized"}`.

**PASS/FAIL**:
**Notes**:

---

## §5 — Regression (existing tools unchanged)

Quick smoke test that prior tools still work:

- [ ] `query_asset_registry({ class_name: "Blueprint", limit: 10 })` — returns 10 results, includes `path`, `objectClassName`, `packageName`, `tags`, `sizeBytes`, `exportCount`.
- [ ] `get_asset_info({ asset_path: "/Game/GAS/Abilities/BPGA_Block" })` — returns AR tags.
- [ ] `list_gameplay_tags({})` — returns full tag hierarchy.
- [ ] `list_config_values({ config_file: "DefaultEngine.ini" })` — returns sections.
- [ ] `project_info({})` — returns project + engine + plugin info.

**PASS/FAIL** for each:

---

## §6 — D44 invariant spot-check

Run `find_tools({ query: "list_level_actors" })` and capture the description.
Then look at what `list_level_actors` description shows in the tool's own param introspection (via `tools/list` from a client, or just verify the description Agent 10 wrote in `tools.yaml`).

Expected: identical strings. Per D44, yaml is the single source of truth and both `tools/list` and `find_tools` must match.

**PASS/FAIL**:
**Notes**:

---

## §7 — Free-form exploration

Run 2-3 queries that simulate realistic agent workflows:

1. "What are the default gameplay tags on BPGA_Block?"
   - Suggested: `read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block", property_names: ["AbilityTags"] })`
2. "What transforms do the actors in Main_MenuVersion have? Give me a class summary first."
   - Suggested: `list_level_actors({ asset_path: ".../Main_MenuVersion", summarize_by_class: true })` then follow-up with pagination.
3. "What's in BP_OSPlayerR's CDO, truncated to the first 2 KB?"
   - Suggested: `read_asset_properties({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", max_bytes: 2048 })`

**Response quality assessment**: readable? useful? any response shape that felt awkward? Note anything worth a design nit.

**Notes**:

---

## §8 — Summary

| Section | Result |
|---|---|
| §1 list_level_actors | X/5 pass |
| §2 inspect_blueprint | X/4 pass |
| §3 read_asset_properties | X/6 pass |
| §4 marker correctness | X/3 pass |
| §5 regression | X/5 pass |
| §6 D44 invariant | pass/fail |
| §7 free-form | notes |

**Overall verdict**: [ship as-is / minor issues flagged for Agent 10.5 follow-up / blocker found]

**Items to flag for orchestrator**:
- [ ] (any)

**Time spent**: _ minutes
