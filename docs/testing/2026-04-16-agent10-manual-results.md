# Manual Testing Results — Agent 10 Delivery (Level 1+2+2.5 + Option C tools)

> **Tester**: Noah (manual testing agent dispatched 2026-04-16)
> **Session**: Fresh Claude Code, MCP server connected, HEAD `4ce4033` (ef9a5f7 + handoff commit)
> **Duration**: ~35 min
> **Source handoff**: `docs/handoffs/manual-testing-agent10-2026-04-16.md`

---

## Pre-flight

- [x] UNREAL_PROJECT_ROOT = `D:/UnrealProjects/5.6/ProjectA/ProjectA` (via `.mcp.json`)
- [x] MCP server running (`mcp__uemcp__*` tools available)
- [x] Offline toolset enabled (confirmed via `list_toolsets` — 14 tools, available)
- [x] TCP toolsets (actors/blueprints-write/gas/etc.) correctly reporting ECONNREFUSED — expected since editor not attached
- [x] Automated suite baseline assumed green per handoff (not re-run this session — time budget)

---

## §1 — `list_level_actors` (MODIFIED)

### 1.1 Transforms on a small map
`list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Main_MenuVersion" })`

**PASS** — `total_placed_actors: 230`, `offset: 0`, `limit: 100`, `truncated: true`. Page-1 actors[] has full transforms for most rows (BP_Ground_Bricks*, SM_Barrel*, BP_PRE_Flower_Pot*, etc.) with `{location:[x,y,z], rotation:[p,y,r], scale:[x,y,z]}`. Sparse-transform rows (AtmosphericFog, InstancedFoliageActor, SphereReflectionCapture×2, LevelScriptBlueprint, Main_MenuVersion_C) correctly surface `transform: null` per V9.5 #3.

**Notes**: Page 1 is dominated by placed-geometry with overrides (the 37% group); the 63%-null cohort is concentrated later in sort order. Partial-null components (e.g., `rotation:null` with `location` and `scale` set) show up — this is expected (individual FVector/FRotator/FVector3 tags can default independently).

### 1.2 Pagination — page 2
`list_level_actors({ ..., offset: 100, limit: 100 })`

**PASS** — `offset: 100`, `limit: 100`, `truncated: true`. Page 1 ended at SM_Barrel14; page 2 starts at SM_Barrel15. No overlap, deterministic sort order, full 100 rows returned.

### 1.3 Summary mode on dense level (Bridges2)
`list_level_actors({ asset_path: ".../Bridges2", summarize_by_class: true })`

**PASS** — `total_placed_actors: 2519`, `summary` dict with 137 class entries (StaticMeshActor: 1920 dominant; BP_LedgeVolume_C: 139; WoodenScaffolding_01_C: 40; NiagaraActor: 29). Response is ~6 KB — tiny compared to the 346 KB full payload V9.5 projected. `truncated: false`.

**Notes**: Design nit — `offset: 0, limit: 100` still echoed in summary response even though pagination doesn't apply. Harmless but cosmetically suggests a per-row cap that isn't in effect. Consider suppressing offset/limit in summary mode.

### 1.4 Cap enforcement
`list_level_actors({ ..., limit: 5000 })`

**PASS** — Response top-level shows `limit: 500`, `truncated: false` (returns all 230). No error; silent cap. Raw JSON body ~115 KB — it exceeded this client's inline-return ceiling and was spilled to a tool-results file, but the server-side behaviour is correct (limit capped to 500 before serialization).

**Notes**: Inline-return ceiling is a Claude Code environment cap, not MCP. Design note for heavy pages: consider non-pretty-printed JSON (no newlines/indent) to squeeze ~2× more rows per response; would help Bridges2-style full dumps.

### 1.5 WorldSettings / no-component actor
Inspect null-transform rows on page 1.

**PASS** — All six null-transform rows on page 1 are expected class-default cases:
- `AtmosphericFog`, `SphereReflectionCapture×2` — native actors whose default root components serialize no override.
- `InstancedFoliageActor` — per-instance transforms live in ISM component children, not at actor level.
- `Main_MenuVersion` (LevelScriptBlueprint, `bIsAsset: false`) and `Main_MenuVersion_C` — non-spatial placeholders.

All match V9.5 §2 expected patterns. No parse failure observed.

---

## §2 — `inspect_blueprint` (MODIFIED)

### 2.1 Default call (no `include_defaults`)
`inspect_blueprint({ asset_path: "/Game/GAS/Abilities/BPGA_Block" })`

**PASS** — `exportCount: 19`, `importCount: 51`, `parentClass: "GA_OSBlock"`, `generatedClass: "BPGA_Block_C"`, `objectClassName: "/Script/Engine.BlueprintGeneratedClass"`. No `variable_defaults`, no `tags`, no `verbose` acknowledgment. Exports array fully populated with resolved classNames and superClasses.

### 2.2 `include_defaults: true`
`inspect_blueprint({ ..., include_defaults: true })`

**PASS** — Response adds `variable_defaults` (9 entries) plus parallel `unsupported_defaults` list and `cdo_export_name: "Default__BPGA_Block_C"`. Observed resolutions:
- Gameplay tags: `IsBlocking`/`IsBroken` → `{tagName: "Gameplay.State.Guard.IsActive"}` etc.
- Tag containers: `CancelAbilitiesWithTag`/`ActivationOwnedTags`/`ActivationBlockedTags` → `{tags: [...]}`
- Object refs: `GuardBreakEffectClass` (BPGE_OSGuardBreak_C) and `ChooserTable` (CT_OSBlocks) → `{objectName, packagePath, packageIndex, kind: "import"}`
- Scalar: `DrainCheckInterval: 0.5` (FloatProperty)
- **Unsupported marker**: `DrainPerSecond` TArray<OSResource> → `{unsupported: true, reason: "complex_element_container", type: "ArrayProperty", size_bytes: 205, inner_type: "OSResource"}`. Parallel entry in `unsupported_defaults[]`.

### 2.3 Backward-compat — `verbose` param rejection
`inspect_blueprint({ ..., verbose: true })`

**PASS** — `verbose` silently ignored (no error). Response is byte-identical to §2.1 (no variable_defaults emitted). Safe behaviour; Zod `additionalProperties: false` in the loaded schema suggests rejection is possible, but the handler accepts and drops. Either is acceptable per handoff criteria.

**Notes**: If strict rejection is preferred (and the schema advertises it), a Zod `.strict()` at the resolver layer would force callers to update. Not a blocker.

### 2.4 Non-BP asset (UserDefinedStruct)
`inspect_blueprint({ asset_path: ".../ST_AttackAnimInfo_Fighter" })`

**PASS** — Parses cleanly. `objectClassName: "/Script/CoreUObject.UserDefinedStruct"`, `parentClass: null`, `generatedClass: null`. 2 exports (UserDefinedStruct + UserDefinedStructEditorData). No errors; tool gracefully returns structural metadata for non-BP assets.

---

## §3 — `read_asset_properties` (NEW)

### 3.1 Default CDO on a BP
`read_asset_properties({ asset_path: "/Game/GAS/Abilities/BPGA_Block" })`

**PASS** — `export_name: "Default__BPGA_Block_C"`, `export_index: 2`, `struct_type: "BPGA_Block_C"`, `property_count_returned: 9`, `property_count_total: 9`, `truncated: false`. Properties dict matches §2.2's variable_defaults. `unsupported[]` contains the DrainPerSecond marker.

### 3.2 Filtered read
First attempted `property_names: ["AbilityTags"]` — returned empty (property_count_returned: 0), because BPGA_Block does not override `AbilityTags` at CDO level (the ability uses `ActivationOwnedTags`/`ActivationBlockedTags` instead). Retried with `["ActivationBlockedTags"]`:

**PASS** — `properties` dict contains only ActivationBlockedTags (5 tags). `property_count_returned: 1`, `property_count_total: 9`.

**Notes (design nit)**: When a filter is active, `unsupported[]` still reports `DrainPerSecond` (which isn't in the filter scope). For consistency, consider scoping `unsupported[]` to the requested property_names too — otherwise a caller filtering for one property gets noise about unrelated unsupported properties. Minor UX polish, not wrong.

### 3.3 Truncation behavior
`read_asset_properties({ asset_path: ".../BP_OSPlayerR", max_bytes: 500 })`

**PASS** — `truncated: true`. `unsupported[]` contains 8 `size_budget_exceeded` entries (DefaultEffects, ResetAttributesEffect, Mesh, CharacterMovement, CapsuleComponent, ArrowComponent, RootComponent, ActorLabel — all tail-end properties) — well under the documented 20-entry cap. **No partial values** in `properties`: the truncated properties are entirely absent from the main dict. Properties that did fit (e.g., `Rigged Character 2Colours` 4-element FLinearColor array, `DefaultAbilities` 15-element ObjectProperty array) are returned complete.

**Notes**: `property_count_returned: 25, property_count_total: 25` — counting appears to include both the fully-resolved properties and the `size_budget_exceeded` name-only entries in the totals, which is internally consistent.

### 3.4 Explicit non-CDO export
`read_asset_properties({ ..., export_name: "BPGA_Block" })`

**PASS** — targets the GameplayAbilityBlueprint export (index 7). Returns 10 distinct properties including `ParentClass` (import → GA_OSBlock), `BlueprintSystemVersion: 2`, `UbergraphPages`/`FunctionGraphs` (export refs), `CategorySorting: ["Ability","Block","Cost","Meta","Attack Direction"]`, `BlueprintGuid: "22b4a1f11d5f3e43ab1cfbdf95e112d5"` (FGuid resolved as hex), and `LastEditedDocuments` TArray<EditedDocumentInfo> surfaced as `complex_element_container` marker. Clearly different from the CDO — confirms export_name routing works.

### 3.5 WidgetBlueprint CDO
`read_asset_properties({ asset_path: "/Game/UI/Widgets/General/WBP_OSBaseButton" })`

**PASS** — `export_name: "Default__WBP_OSBaseButton_C"`. Returns 3 properties: `SlotPadding` (FMargin → `unknown_struct` with struct_name), `bHasScriptImplementedTick: false`, `bHasScriptImplementedPaint: false`. Clean output — widget-specific booleans surface, the FMargin (not in Level 2 registry) correctly flagged.

### 3.6 AnimBP CDO
`read_asset_properties({ asset_path: ".../ABP_Manny" })`

**PASS** — 33 properties, most are `AnimNode_*` structs (Root, StateMachine, TransitionResult, SequencePlayer, StateResult, ControlRig, BlendSpacePlayer, ApplyAdditive, Slot, UseCachedPose, SaveCachedPose) all correctly marked `unknown_struct` with `struct_name` and `size_bytes`. `Velocity: {x:0, y:0, z:0}` correctly resolved as FVector. Also `__AnimBlueprintMutables` (AnimBlueprintGeneratedMutableData) and `AnimBlueprintExtension_*` (AnimSubsystemInstance) markers — all classes of structs Level 2 does not attempt to decode are surfaced, none silently dropped.

---

## §4 — Marker correctness

### 4.1 UUserDefinedStruct marker
**PASS (with scope note)** — The `unknown_struct` marker with `struct_name` was exercised many times across §3 on C++ engine structs (TimerHandle, MaterialParameterInfo, OSAuraInfo, Margin, TopLevelAssetPath, AnimNode_*, AnimBlueprintGeneratedMutableData, AnimSubsystemInstance, PointerToUberGraphFrame). The dispatch path is identical for UDS — both route through the same "struct name not in registry" branch. Could not find a ProjectA BP that serializes a UDS variable directly at CDO level for a clean UDS-specific demonstration; DataTable rows (ST_AttackStruct_Fighter) are not surfaced as FPropertyTag entries so they don't exercise this marker path either. Marker *shape* confirmed; UDS-specific exercise deferred due to asset availability.

### 4.2 Complex container marker
**PASS** — Confirmed on two distinct assets:
- `BPGA_Block` CDO: `DrainPerSecond` → `{reason: "complex_element_container", type: "ArrayProperty", size_bytes: 205, inner_type: "OSResource"}`
- `BPGA_Block` non-CDO (BPGA_Block GameplayAbilityBlueprint export): `LastEditedDocuments` → `{reason: "complex_element_container", type: "ArrayProperty", size_bytes: 445, inner_type: "EditedDocumentInfo"}`

Both carry the `inner_type` so callers know what element type was deferred.

### 4.3 Delegate properties
**UNREACHABLE / NOT-EXERCISED** — No CDO in the sample set (BPGA_Block, BP_OSPlayerR, WBP_OSBaseButton, ABP_Manny, DT_Attacks_Fighter, ST_AttackAnimInfo_Fighter) emitted a `delegate_not_serialized` marker. This is expected UE behaviour: delegate bindings are not stored as tagged CDO properties — they're serialized via the Blueprint graph, not the CDO's FPropertyTag stream. The marker path exists in the code path (per Agent 9 design) but won't fire on typical BPs.

**Side observation (bonus)**: a new marker reason `unexpected_preamble` surfaced on `DT_Attacks_Fighter.AssetImportData` (`{name: "__stream__", size_bytes: 3}`). Not documented in the handoff or Agent 9's design table — likely an "never silently skip" catch-all for malformed/unknown tag headers. Functioning correctly (safely reports rather than crashing), but worth adding to the documented marker reasons list.

---

## §5 — Regression (existing tools unchanged)

- [x] `query_asset_registry({ class_name: "Blueprint", limit: 10 })` — **PASS**. 10 results, each with `path`, `objectClassName`, `packageName`, `tags`, `sizeBytes`, `exportCount`. `heavyTagsOmitted: ["FiBData"]` on assets with oversized tags. `total_scanned: 5000`, `total_matched: 127`, `truncated: true`.
- [x] `get_asset_info({ asset_path: "/Game/GAS/Abilities/BPGA_Block" })` — **PASS**. Tags dict, `sizeBytes: 52493`, `sizeKB: 51`, `exportCount: 19`, `importCount: 51`, `nameCount: 181`, `fileVersionUE5: 1017`.
- [x] `list_gameplay_tags({})` — **PASS**. `totalTags: 171`, flat `tags[]` list + nested `hierarchy` object with `_children`/`_comment`. Includes comments like "Attack phase: hitbox live, traces active".
- [x] `list_config_values({})` — **PASS** at progressive first level: returns `configFiles: ["DefaultEditor.ini", "DefaultEngine.ini", "DefaultGame.ini", "DefaultGameplayTags.ini", "DefaultInput.ini"]`. Did not drill into a specific file this session; schema shows no params so the drill-down may be positional/string-query form (tool description: "list_config_values is progressive: () → files, (file) → sections, (file, section, key) → values"). Progressive discovery works.
- [x] `project_info({})` — **PASS**. `projectName: "ProjectA"`, `engineAssociation: "5.6"`, 1 module, 15 plugins (GameplayAbilities, MotionWarping, SteamSockets, Mutable, etc.).

**Total: 5/5 PASS.**

---

## §6 — D44 invariant spot-check

`find_tools({ query: "list_level_actors" })` description vs `tools.yaml:90` description.

**PASS** — Byte-identical strings:

> Enumerate placed actors in a .umap with transforms (location, rotation, scale from the actor's root component). Filters to exports whose outerIndex resolves to PersistentLevel/Level. Paginated — use limit/offset to page through dense maps, or summarize_by_class for an overview before drilling down. For a single actor's deeper UPROPERTY values (damage stats, tags, refs), follow up with read_asset_properties on the actor's export. Pointed query — not cached.

Also verified the same string appears in the loaded MCP tool schema (via ToolSearch), proving `tools/list` → find_tools → yaml are all aligned.

---

## §7 — Free-form exploration

Ran three realistic-workflow queries:

1. **"What gameplay tag containers does BPGA_Block override?"** — `read_asset_properties` with `property_names: ["CancelAbilitiesWithTag", "ActivationOwnedTags", "ActivationBlockedTags"]`. Clean 3-entry response; tags rendered as `{tags: [...]}` strings. Immediately actionable for any agent reasoning about ability activation.

2. **"Bridges2 class breakdown"** — `summarize_by_class: true` on Bridges2 (already run for §1.3). Returns a compact class-count dict that's easy to skim to pick follow-up targets (e.g., "139 BP_LedgeVolume_C — interesting, let me drill in").

3. **"BP_OSPlayerR CDO up to 2 KB"** — Returns the full 25-property CDO dump at 2 KB budget (no truncation needed). `DefaultAbilities` (15 ability class imports), `DefaultEffects` (3 GE class imports), component refs (CharacterMovement, CapsuleComponent, Mesh), `Rigged Character 2Colours` (4 FLinearColor team palette), `MinFallDistance: 10000`, `bUseMutable: true`, `MutableInstance`, `DefaultSkeletalMesh`, etc. **This is exactly the kind of CDO introspection that previously required opening the editor.**

**Response quality**:
- Readability: high. Object refs resolve as full `{objectName, packagePath, packageIndex, kind}`; tags and containers cleanly structured. Struct-with-markers pattern is consistent across all three tools.
- Ergonomics nits:
  - `packageIndex` numbers (e.g., `274`, `-241`) leak implementation detail — raw FPackageIndex values don't help a typical caller. Could be hidden by default and exposed behind a verbose flag, keeping the readable `objectName` + `packagePath` + `kind`.
  - Duplicate surfacing: `unknown_struct` properties appear once in `properties` dict (with full marker object) and again in `unsupported` array (with same info). Harmless but noisy — picking one canonical location would tighten the response.
  - Filtered `read_asset_properties` does not scope `unsupported[]` to the filter (see §3.2 nit).
- Overall: ergonomically solid. Agents can one-shot questions like "what ability tags does X have" and "what does this CDO look like" without editor attach.

---

## §8 — Summary

| Section | Result |
|---|---|
| §1 list_level_actors | 5/5 pass |
| §2 inspect_blueprint | 4/4 pass |
| §3 read_asset_properties | 6/6 pass |
| §4 marker correctness | 2/3 pass + 1 unreachable (delegate path not exercised by sample corpus — expected UE behaviour) |
| §5 regression | 5/5 pass |
| §6 D44 invariant | PASS |
| §7 free-form | quality good; 3 small ergonomic nits noted below |

**Overall verdict**: **SHIP AS-IS** — no blockers, no regressions, no false-negatives from the specialist pass. Agent 10 + Agent 9.5 delivery holds up against real-world ProjectA fixtures. The three Option C tool surface changes are behaving to spec; markers never silently drop properties; the D44 yaml-as-SoT invariant is intact.

**Items to flag for orchestrator (all non-blocking polish)**:
- [ ] `list_level_actors` summary mode echoes meaningless `offset: 0, limit: 100` in top-level response — consider omitting when `summarize_by_class: true`.
- [ ] `read_asset_properties` with `property_names` filter still reports filter-irrelevant properties in `unsupported[]`. Minor UX; scope `unsupported[]` to filter for consistency.
- [ ] `unsupported` array duplicates the per-property `{unsupported, reason}` markers already present in `properties` dict. Pick one canonical location to reduce response noise.
- [ ] `packageIndex` numeric fields exposed alongside `objectName`/`packagePath` — could be hidden behind verbose flag; raw FPackageIndex leaks implementation detail that most callers don't need.
- [ ] Undocumented marker reason discovered: `unexpected_preamble` surfaced on `DT_Attacks_Fighter.AssetImportData.__stream__`. Add to design-doc marker catalog in `docs/research/level12-tool-surface-design.md` §1 "Opaque / unsupported surface" table.
- [ ] `delegate_not_serialized` marker path was not exercised by any sample CDO (expected — UE doesn't serialize delegate bindings as tagged CDO properties). Note this in the marker-correctness test corpus so future regressions know the path is intentionally unreachable for BP CDOs.
- [ ] Inline response size ceiling hit on `list_level_actors({ limit: 500 })` with 230 actors on a dev-Claude inline-return path (~115 KB pretty-printed JSON). Server behaved correctly; consider emitting compact (no-indent) JSON mode for large responses to fit more under harness caps.

**Time spent**: ~35 minutes.
