# Level 1+2 Tool Surface Design

> **Author**: Agent 9 (Tool Surface Design)
> **Date**: 2026-04-16
> **Type**: Design research — no code changes
> **Inputs**: Agent 8 parser audit, 2026-04-16 codebase audit, Phase 2 tier-2 validation (D38), Phase 3 design research Q7/Q11, D30/D32/D39, tools.yaml (post M1/M2/M3 patches)
> **Deliverable**: This document. Agent 10 wires implementation against §4.

---

## §1 What Level 1+2 surfaces

Agent 8's recommendation (CUE4Parse port source + UAssetAPI validation oracle) extends the existing header parser (`server/uasset-parser.mjs`) with two capabilities bolted onto the per-export serialized data path:

- **Level 1 — FPropertyTag iteration**: walk tagged properties at `FObjectExport::SerialOffset`, read `{name, type, size, arrayIndex, value}` per property until the `"None"` terminator.
- **Level 2 — Struct handlers**: dispatch on 10 engine struct types with hardcoded layouts.

### Readable surface (Level 1 scalars + Level 2 structs)

| Category | Types | Rendered as |
|---|---|---|
| Scalars | `IntProperty` (int8/16/32/64), `FloatProperty`, `DoubleProperty`, `BoolProperty`, `ByteProperty`, `StrProperty`, `NameProperty` | JS number/string/bool |
| Enums | `EnumProperty`, `ByteProperty` with enum | String (enum name) preferred; numeric fallback with `enum_type` sibling |
| References | `ObjectProperty` (hard ref), `SoftObjectProperty` | `{path: "/Game/..."}` string |
| Core structs | `FVector`, `FVector2D`, `FRotator`, `FQuat`, `FTransform`, `FLinearColor`, `FColor`, `FGuid` | `{x,y,z}`, `{pitch,yaw,roll}`, `[r,g,b,a]`, composite for `FTransform` |
| Gameplay tags | `FGameplayTag`, `FGameplayTagContainer` | String or string array (UE 5.6 FName encoding — fixture-confirmed) |
| Soft paths | `FSoftObjectPath` | `{asset_path, sub_path}` object (handles UE 5.1+ encoding) |

### Opaque / unsupported surface (returns marker, not value)

Agent 8 explicitly defers containers and custom property types. Agent 10 must surface the boundary instead of hiding it:

| Category | Types | Response shape |
|---|---|---|
| Containers (deferred per Agent 8 §4 Phase 1.3) | `ArrayProperty`, `MapProperty`, `SetProperty` | `{unsupported: true, reason: "container_deferred", size_bytes}` |
| Unknown struct | Any `StructProperty` whose struct name isn't in the Level 2 registry | `{unsupported: true, reason: "unknown_struct", struct_name, size_bytes}` |
| Delegates | `DelegateProperty`, `MulticastDelegateProperty` | `{unsupported: true, reason: "delegate_not_serialized"}` (binding lives in graph, not CDO) |
| Text with complex source | `TextProperty` with localization table ref | `{unsupported: true, reason: "localized_text", cultures_omitted: true}` (plain `TextProperty` string literals are fine and land under scalars) |
| Version-incompatible | Property types flagged by `FPropertyTag.type` but not in dispatch table | `{unsupported: true, reason: "unknown_property_type", type}` |

**Rule Agent 10 must honour**: never silently skip. Every unsupported property gets a marker entry by name; callers can detect the boundary and decide whether to fall back to TCP (Phase 3) or Remote Control (Phase 4).

### What Level 1+2 does *not* give us

- **Blueprint graph data** — nodes, pins, wires, function bodies. Needs `UEdGraph` serialization through the editor. This is bucket 3F's job (sidecar writer + `dump_graph`).
- **Runtime state** — actors spawned dynamically, edited-but-not-saved transforms, live component values. TCP-only.
- **Reflected-only metadata** — UFUNCTION signatures, property metadata (EditAnywhere/BlueprintReadWrite flags), interface lists by UClass walk. Needs live reflection.
- **Cooked-only derived data** — `.uexp` serialized component archetypes beyond `FPropertyTag` scope (e.g., Niagara compiled VM data).

### Three concrete workflows Level 1+2 unlocks

1. **"Where are things placed in this level"** — read `FTransform` on each placed actor's `RootComponent` export (attached via `UActorComponent::AttachParent` chain). Empirically fixes F4's correctness hole — the tool name promises transforms, so it should deliver them.
2. **"What's the default Damage/Cooldown/Tags on this ability BP"** — read CDO property values on `Default__BPGA_Block_C` export. Unblocks GAS introspection workflows without opening the editor.
3. **"What assets does this BP reference"** — walk `FSoftObjectPath` and `ObjectProperty` values across the CDO, returning a set of `/Game/...` paths. Covers a subset of the Phase 3 `get_asset_references` surface for the hard-referenced case.

These three workflows drive the option analysis in §2.

---

## §2 Options analysis

All three options assume D44 is fully landed — `tools.yaml` is the single source of truth, offline registration reads yaml via `toolsetManager.getToolsData()`. New or modified tools declare every param in yaml only.

### Option A — Fold everything into existing tools

**Tool signatures:**

```yaml
# list_level_actors gains transforms + tags per row
list_level_actors:
  params:
    asset_path: { type: string, required: true }
  returns_added: { actors: [{name, className, ..., transform, gameplay_tags}] }

# inspect_blueprint gains CDO defaults (repurpose dead verbose)
inspect_blueprint:
  params:
    asset_path: { type: string, required: true }
    verbose:    { type: boolean, required: false, default: false }
  returns_added: { variable_defaults: {name: value} } when verbose=true

# get_asset_info gains full serialized properties
get_asset_info:
  params: (unchanged)
  returns_added: { properties: {name: value} }
```

**Scoring:**

| Criterion | Score | Notes |
|---|---|---|
| Toolset budget | ✅ Best | 13 tools unchanged; no budget cost |
| Discoverability | ✅ Strong on actors | Transforms arrive where callers already look (`list_level_actors`). Variable defaults on `inspect_blueprint` via opt-in `verbose` is reasonable. |
| Response size | ❌ Worst | Amplifies F0/F3. F3 whitebox map (223 rows × ~80 B row shape) already ~320 KB *after* F4 filtering. Adding transform (~60 B/row) + gameplay_tags (variable) pushes near-cap maps over, and Bridges2 (≥10× more rows) becomes unusable. `get_asset_info` + full properties compounds F0 on BPs: CDO of `BP_OSPlayerR` has ~50-80 UPROPERTYs, many with nested structs — easily another 30-80 KB on top of the already-spilling AR-tag output. |
| Composability | ⚠️ Overlap risk | `get_asset_info.properties` overlaps every other introspection tool that ends up returning property data. Revives the F2 `inspect_blueprint` vs `get_asset_info` tags overlap under a new name. |
| Phase 3 diff | Moderate | Displaces `get_actor_transform`, `get_blueprint_variables`, `get_actor_properties` (static case only). RC static-read use cases reduced but not eliminated. |

**Risks**: size regression is fatal without pagination/opt-in gating, which brings Option A to converge with Option C (see below). `get_asset_info.properties` is a fresh overlap with future `read_asset_properties` / Phase 3 `get_asset_references` — avoid.

**Interaction with M4/D44**: every fold requires yaml updates only (per D44). Low friction.

---

### Option B — New dedicated tool only

**Tool signatures:**

```yaml
read_asset_properties:
  params:
    asset_path:     { type: string, required: true }
    export_name:    { type: string, required: false, description: "Default: primary export (asset's CDO for BPs, main export otherwise)" }
    property_names: { type: array, items: string, required: false, description: "Filter to specific UPROPERTY names; omit for all readable" }
    verbose:        { type: boolean, required: false, default: false, description: "When false, skip struct/container properties exceeding size threshold" }
  returns: { path, export_name, struct_type, properties: {...}, unsupported: [{name, reason}], truncated? }

# list_level_actors, inspect_blueprint, get_asset_info unchanged.
```

**Scoring:**

| Criterion | Score | Notes |
|---|---|---|
| Toolset budget | ⚠️ +1 tool | 13 → 14 offline. Well under 40 threshold, but every permanent slot has a cost. |
| Discoverability | ❌ Weakest for actors | "Where is BP_AICharacter placed" → caller reaches for `list_level_actors` → no transform → must then call `read_asset_properties` with the actor's root component export name (non-obvious lookup chain). Two-hop workflow for the most common question. |
| Response size | ✅ Best | Bounded to one export per call. Callers paginate across actors by calling N times, not by asking one tool for N rows. |
| Composability | ✅ Cleanest | Each tool has one job: `get_asset_info` = AR-tag metadata, `inspect_blueprint` = structure, `list_level_actors` = placed-actor enumeration, `read_asset_properties` = property values. No overlap. |
| Phase 3 diff | Moderate | Same Phase 3 displacement as Option A but via a single tool. No win over C. |

**Risks**: discoverability gap on the actor-transform workflow. Callers will routinely forget to call `read_asset_properties` after `list_level_actors` because "placed actors without transforms" feels incomplete regardless of documentation. F4 correctness problem (tool returns placed actors but no transforms) persists unless a cross-reference note lands in `list_level_actors`'s description.

**Interaction with M4/D44**: purely additive yaml entry.

---

### Option C — Hybrid: high-value fold + new tool for long tail

**Tool signatures:**

```yaml
# list_level_actors: transforms ALWAYS-ON (they fix F4's correctness hole — tool promises placed actors, must deliver positions), + NEW pagination + summary mode.
list_level_actors:
  params:
    asset_path:        { type: string, required: true }
    limit:             { type: number, required: false, default: 100, description: "Max actors returned; cap 500" }
    offset:            { type: number, required: false, default: 0 }
    summarize_by_class: { type: boolean, required: false, default: false, description: "When true, returns {className: count} instead of per-row. Use for dense levels before drilling down." }
  returns_added: { actors: [{..., transform}], truncated, total_placed_actors }

# inspect_blueprint: variable_defaults via opt-in param (repurpose dead verbose — see §5 open question).
inspect_blueprint:
  params:
    asset_path: { type: string, required: true }
    include_defaults: { type: boolean, required: false, default: false }
  returns_added: { variable_defaults: {name: value}, unsupported: [{name, reason}] } when include_defaults=true

# NEW — long tail: arbitrary property reads on any export.
read_asset_properties:
  params:
    asset_path:     { type: string, required: true }
    export_name:    { type: string, required: false }
    property_names: { type: array, items: string, required: false }
    max_bytes:      { type: number, required: false, default: 65536, description: "Response size cap before truncation" }
  returns: { path, export_name, struct_type, properties: {...}, unsupported: [{name, reason}], truncated? }

# get_asset_info: NO CHANGE — stays AR-tag metadata only. See §4 note.
```

**Scoring:**

| Criterion | Score | Notes |
|---|---|---|
| Toolset budget | ⚠️ +1 tool | 13 → 14. Same as B. |
| Discoverability | ✅ Best | Transforms arrive with `list_level_actors` (no two-hop). CDO defaults arrive with `inspect_blueprint` when asked. Arbitrary reads go through a named tool. |
| Response size | ✅ Strong | `list_level_actors` gets pagination + summary mode (addresses F3 root cause, not just transform addition). `inspect_blueprint.include_defaults` is opt-in (no size regression by default). `read_asset_properties` is one-export bounded + `max_bytes` cap. |
| Composability | ✅ Strong | `get_asset_info` = AR-tag scalars. `inspect_blueprint` = BP/Widget/AnimBP structure (+ optional defaults). `list_level_actors` = placed actors with transforms. `read_asset_properties` = property values on arbitrary export. Clear contracts; F2 overlap avoided. |
| Phase 3 diff | Best | Transforms via `list_level_actors` displaces `get_actor_transform` static case. Defaults via `inspect_blueprint` reduces `get_blueprint_variables` surface. `read_asset_properties` subsumes RC static-read for the hard-ref case. See §3 for the full diff. |

**Risks**:

- `list_level_actors` becomes a paginating tool — ONE pagination footprint. Callers who want everything iterate. The `summarize_by_class` mode is essential for dense levels (Bridges2-class).
- Opt-in `include_defaults` leaves the default-off case identical to today (no regression), but callers who don't know to set it miss useful data. Mitigated by tool description clarity.
- `read_asset_properties` needs a well-defined default export rule — see §4.

**Interaction with M4/D44**: `list_level_actors` and `inspect_blueprint` params change in yaml only. New `read_asset_properties` entry added to offline toolset. `get_asset_info` untouched. All consistent with D44.

### F3 convergence note (advisor-flagged)

If Option A's size mitigation is done right — i.e., `list_level_actors` gains pagination and/or opt-in transforms — Option A becomes structurally identical to Option C minus the `read_asset_properties` tool. The choice then reduces to "do we also add a dedicated property-reader for the long tail?" — which is the YAGNI-critical question. §4 argues yes, based on the three concrete workflows in §1.

Option B converges partially (same `read_asset_properties` surface) but pays the discoverability cost on transforms. No reason to prefer it over C.

---

## §3 Phase 3 scope diff

Per D32 and D39, Level 1+2 lets offline tools permanently absorb surfaces originally planned for Phase 3 TCP:55558. This table compares the `tools.yaml` Phase 3 plan *pre-Level-1+2* vs the plan *post-Level-1+2 + Option C*.

| Phase 3 tool (current yaml) | Post-L12 status | Notes |
|---|---|---|
| `blueprint-read.get_blueprint_info` | ⚠️ Reduced | Parent class/interfaces/counts now available via `inspect_blueprint` (already landed). Runtime-reflected interface list still needs editor — keep for live reflection. |
| `blueprint-read.get_blueprint_variables` | ⚠️ Reduced | CDO defaults via `inspect_blueprint.include_defaults` (new). Runtime metadata (replication flags, EditAnywhere, tooltips — reflection-only) still needs editor. |
| `blueprint-read.get_blueprint_functions` | ⏸ Unchanged | Function bodies live in `UEdGraph`; serialization is sidecar-territory (3F). |
| `blueprint-read.get_blueprint_graphs` | ⏸ Unchanged | 3F scope — sidecar + `dump_graph`. Not Level 1+2. |
| `blueprint-read.get_blueprint_components` | ⚠️ Reduced | Component hierarchy tree + default values readable offline via `read_asset_properties` on SCS node exports. Live-attached-via-script components still need editor. |
| `blueprint-read.get_blueprint_event_dispatchers` | ⏸ Unchanged | Graph-node driven; 3F scope. |
| `blueprint-read.get_animbp_graph` | ⏸ Unchanged | State-machine graph; 3F scope. |
| `blueprint-read.get_widget_blueprint` | ⏸ Unchanged | Widget tree + bindings live in widget graph; 3F scope. Offline exports table (already in `inspect_blueprint`) gives node names but not slot properties — property values via `read_asset_properties` on slot exports close most of the gap for static cases. |
| `blueprint-read.get_niagara_system_info` | ⚠️ Reduced | User-exposed params + fixed bounds readable via `read_asset_properties`. Compiled VM state still editor-only. |
| `asset-registry.search_assets` | ❌ Eliminated (pre-L12, D37) | Already covered by offline `query_asset_registry`. |
| `asset-registry.get_asset_references` | ⚠️ Reduced | Hard-ref subset via `read_asset_properties` walk for FSoftObjectPath/ObjectProperty. Soft-ref registry walk still benefits from editor's `IAssetRegistry`. |
| `asset-registry.get_class_hierarchy` | ❌ Eliminated (pre-L12, D37) | Offline via `query_asset_registry class_name:` + parent-class AR tags. |
| `asset-registry.get_datatable_contents` | ⏸ Unchanged | Binary DataTables (ProjectA case) need editor or cooked data. CSV-backed handled by existing `read_datatable_source`. |
| `asset-registry.get_asset_metadata` | ❌ Eliminated (pre-L12, D37) | Offline `get_asset_info` covers this. |
| `actors.*` (10 tools) | ⚠️ Live case only | Static-saved transforms readable via `list_level_actors` (new). Runtime spawn/delete/live-transform stays TCP. `get_actor_properties` static case → `read_asset_properties`. |
| `gas.list_gameplay_tags_runtime` | ⏸ Unchanged | Runtime tag containers need live state. Static CDO `AbilityTags` readable via `read_asset_properties`. |
| `data-assets.get_data_asset_properties` | ❌ Eliminated | Direct subset of `read_asset_properties`. |
| `data-assets.get_curve_asset` | ⚠️ Reduced | Simple curves serialize as scalar/struct properties (readable). Complex compiled curve data still editor-territory. |
| `data-assets.get_string_table` | ⏸ Unchanged | Binary StringTable needs editor; CSV already handled by `read_string_table_source`. |
| `data-assets.get_struct_definition` | ⚠️ Reduced | UUserDefinedStruct members readable as property layout. Enum values readable. Member-metadata still reflection-heavy. |
| `materials.list_material_parameters` | ⚠️ Reduced | Static parameter defaults readable via `read_asset_properties` on the material's CDO. Compiled shader uniforms stay editor. |
| `materials.get_material_graph` | ⏸ Unchanged | Expression graph; 3F scope. |
| `remote-control.rc_get_property` (static case) | ⚠️ Reduced | For saved `.uasset` CDOs/exports, `read_asset_properties` covers the same surface without HTTP round-trip. Live UObject reads (non-saved state) stay RC — the tool itself survives. |

**Rollup**:

- **Eliminated from Phase 3 TCP scope**: 1 new (`data-assets.get_data_asset_properties` — direct, no-remainder overlap with `read_asset_properties`). Plus the 4 already eliminated pre-L12 per D37.
- **Reduced (surface area shrinks, tool stays)**: 12, including `rc_get_property` — the static CDO read path moves offline; live-UObject reads still need RC.
- **Unchanged**: 7. Mostly graph-bearing (`get_*_graph`), runtime-state (`*_runtime`, live actor state), and editor-only compiled derived data.

**Interpretation**: Level 1+2 + Option C closes roughly half the read-side surface of the Phase 3 plan without writing a single C++ line. The remaining Phase 3 TCP read-side is genuinely editor-dependent (UEdGraph, reflection, runtime state) — that's the right scope for the C++ plugin.

---

## §4 Recommendation

**Pick Option C — Hybrid.**

Justification against the 5 criteria, compressed:

1. **Budget**: +1 tool is cheap relative to the three concrete workflows unlocked (§1) and the Phase 3 TCP scope reduction (§3).
2. **Discoverability**: transforms on `list_level_actors` and defaults on `inspect_blueprint` match the mental model callers already have. Fixes F4's correctness hole (tool now *actually* delivers placed actors with positions). `read_asset_properties` handles the named long-tail cases.
3. **Response size**: explicitly mitigated — pagination + summary mode on `list_level_actors`, opt-in defaults on `inspect_blueprint`, bounded-by-export + `max_bytes` on `read_asset_properties`. No F0/F3 amplifier.
4. **Composability**: each tool has a single, non-overlapping contract. `get_asset_info` stays lean (AR tags only). The F2 overlap trap does not recur.
5. **Phase 3 diff**: eliminates or reduces 13 planned Phase 3 tools (§3). Right-sizes the C++ plugin to genuinely editor-dependent work.

### Draft yaml snippet (Agent 10 source)

```yaml
# tools.yaml — offline toolset additions/changes

offline:
  tools:
    # MODIFIED — transforms now returned; pagination + summary mode added.
    list_level_actors:
      description: >
        Enumerate placed actors in a .umap with transforms (location, rotation, scale from the
        actor's RootComponent). Filters to exports whose outerIndex resolves to PersistentLevel.
        Paginated — use limit/offset to page through dense maps, or summarize_by_class for an
        overview. For a single actor's deeper UPROPERTY values (damage stats, tags, refs), follow
        up with read_asset_properties on the actor's export. Pointed query — re-parses export/
        import tables + serialized properties (not cached).
      params:
        asset_path: { type: string, required: true, description: "/Game/... path to a .umap (with or without .umap extension)" }
        limit: { type: number, required: false, description: "Max actors returned (default 100, cap 500)" }
        offset: { type: number, required: false, description: "Result offset for pagination (default 0)" }
        summarize_by_class: { type: boolean, required: false, default: false, description: "When true, returns {className: count} instead of per-row. Use for dense levels before drilling down." }
      # Response shape:
      # { path, diskPath, sizeBytes, modified, exportCount, importCount,
      #   total_placed_actors, truncated, offset, limit,
      #   actors: [{name, className, classPackage, outer, bIsAsset,
      #             transform: {location:[x,y,z], rotation:[p,y,r], scale:[x,y,z]} | null,
      #             unsupported: [{name, reason}] }],
      #   summary: {className: count}  # only when summarize_by_class=true
      # }

    # MODIFIED — variable_defaults opt-in via renamed param (repurpose dead verbose — see §5).
    inspect_blueprint:
      description: >
        Deep introspection of a .uasset (BP, UMG widget, AnimBP, DataAsset). Returns export
        table with resolved class/super/outer names, parent class, generated class.
        With include_defaults=true, also returns CDO UPROPERTY values (scalars, 10 engine
        structs; containers/custom structs marked unsupported). Use this when you want the
        structural view + a convenience CDO dump in one call; use read_asset_properties when
        you need values on a non-CDO export or want a filtered subset. NOTE — tags removed;
        use get_asset_info for asset-registry metadata. Pointed query — not cached.
      params:
        asset_path: { type: string, required: true, description: "/Game/... path (with or without .uasset extension) or project-relative Content/... path" }
        include_defaults: { type: boolean, required: false, default: false, description: "When true, include variable_defaults from the class CDO export." }
      # Response shape additions when include_defaults=true:
      # variable_defaults: {varName: value | {unsupported, reason}}
      # unsupported_defaults: [{name, reason}]  (parallel list for scan tooling)

    # NEW — long-tail property reader.
    read_asset_properties:
      description: >
        Read serialized UPROPERTY values from a specific export in a .uasset/.umap.
        Default export is the asset's primary CDO (Default__<AssetName>_C for BPs,
        the main export otherwise). Supports scalars, enums, object refs, soft refs,
        gameplay tags/containers, and 10 engine structs (FVector, FRotator, FQuat,
        FTransform, FLinearColor, FColor, FVector2D, FGuid, FSoftObjectPath,
        FGameplayTag). Containers (Array/Map/Set) and unknown structs return a marker
        entry, not silently skipped. Response capped at max_bytes with truncated flag.
      params:
        asset_path: { type: string, required: true, description: "/Game/... path (with or without extension)" }
        export_name: { type: string, required: false, description: "Target export objectName. Default: primary CDO (Default__<Name>_C for BPs) or main export for non-BP assets." }
        property_names: { type: array, items: string, required: false, description: "Filter to specific UPROPERTY names; omit for all readable properties." }
        max_bytes: { type: number, required: false, description: "Response size budget before truncation (default 65536)." }
      # Response shape:
      # { path, diskPath, export_name, export_index, struct_type,
      #   properties: {name: value | {unsupported, reason}},
      #   unsupported: [{name, reason, size_bytes?}],
      #   truncated: bool,
      #   property_count_returned, property_count_total }
```

### F3 mitigation decision (advisor-flagged blocker)

`list_level_actors` transforms are **always-on**, not opt-in. Justification:

- Transforms are what `list_level_actors` should have been returning from day one (F4 correctness argument — the tool's name promises placements, positions are part of a placement).
- The F3 size problem is caused primarily by **row count**, not row size. T22 shows 1377 exports → 223 real placed actors after F4 filtering → ~320 KB response. Adding transform at ~60 B/row yields ~13 KB delta — meaningful but not the dominant cost.
- The dominant cost is dense levels — Bridges2 (11,830 exports, 56 MB) would have hundreds or thousands of placed actors even after F4. **Pagination (limit/offset) is mandatory for these**, and once pagination is in, transform cost is amortized across pages rather than compounded.
- `summarize_by_class` gives callers a cheap overview ("this level has 202 StaticMeshActor + 15 BPs + ...") before paging through details.

**Result**: one size story (pagination + summary) covers both F3 row-count and the transform addition. No opt-in `include_transforms` param — keeps the surface tight.

**Transform resolution (Agent 10 note)**: transforms are a two-hop read. For each placed actor export, resolve its `RootComponent` ObjectProperty → follow to the component export → read `RelativeLocation` (FVector), `RelativeRotation` (FRotator), `RelativeScale3D` (FVector) on that component. Edge cases: `WorldSettings` and some `Brush` actors have no `RootComponent` (return `transform: null` + note in per-row `unsupported`); `InstancedFoliageActor`-style HISMs hold transforms in a per-instance array inside the component (also `transform: null` for v1 — instance-level read is deferred with Agent 8's container story).

### Gameplay-tag and asset-reference placement (advisor-flagged gap)

D39 lists tags and refs as in-scope. Decision:

- **Tags and refs on CDOs** (e.g., `BPGA_Block.AbilityTags: [Gameplay.Ability.Block]`, `BP_OSPlayerR.StaticMesh: /Game/Characters/Mesh`) → flow through `read_asset_properties` and (when opt-in) through `inspect_blueprint.include_defaults.variable_defaults`. These tools naturally surface any UPROPERTY value, tag-typed or ref-typed.
- **Tags per placed actor in a level** → **NOT embedded in `list_level_actors` rows**. Callers needing per-actor tags call `read_asset_properties` on the specific actor export. Rationale: F3 amplifier. Actor-level tag containers can be large; per-row inclusion multiplies row size variably across actors. Keep `list_level_actors` rows fixed-shape.

**Consequence**: one consistent rule — "tags and refs are property values; read them through the property-reader tools." Avoids bespoke fields and keeps F3 under control.

### Interaction with D44 and the offline registration refactor

- All three changes (modified `list_level_actors`, modified `inspect_blueprint`, new `read_asset_properties`) are yaml edits only. The in-flight D44 refactor means Agent 10 does not need to touch `server.mjs:offlineToolDefs` — that const will be gone by dispatch time.
- Agent 10 registers `read_asset_properties` in the offline switch in `offline-tools.mjs:executeOfflineTool` following the existing per-tool pattern (`case 'read_asset_properties': ...`).
- Zod schema is built by the generic `buildZodSchema` from the yaml param block (post-D44); no manual schema construction needed.
- `test-phase1.mjs` gets new test-9-style assertions for the three tools; supplementary `test-uasset-parser.mjs` style suites are appropriate for parser-level property/struct correctness (now that M6 is fixed, supplementary suites are in rotation — add new ones beside the existing four).

---

## §5 Open questions for Noah

**Q1 — `inspect_blueprint.verbose` repurposing.** Recommend: rename `verbose` → `include_defaults` in yaml, with the semantic change (gate `variable_defaults` inclusion). Backward-compat note: the current `verbose` param is dead code per M3 — no callers depend on its behavior. The rename is safer than repurposing the same name because tools.yaml consumers (find_tools descriptions, MCP `tools/list`) will show the new semantics cleanly. Alternative: keep the name `verbose`, document new semantics. Alternative: remove it entirely from yaml + Zod + handler, then reintroduce `include_defaults` as a fresh param (cleanest). **Decision needed before Agent 10 starts.**

**Q2 — Param-passthrough test strategy for new/modified tools.** F0-class lesson: direct `executeOfflineTool` tests bypass the Zod schema + SDK handler wrapper, so dropped-param bugs pass unit tests and fail manual testing. Options:
(a) Add `executeOfflineTool`-level tests for each new param that assert the param reaches the handler (a `verbose`-style drop would be caught if the test asserts on handler-observable output that only happens when the param is set).
(b) Build an MCP-wire integration harness that instantiates `McpServer`, calls `tools/call`, and asserts on the response (closes the F0 gap structurally).
(c) Both — (a) is cheap and catches most cases; (b) is the structural fix.
**Recommend (c)**: Agent 10 ships (a) for each new tool; (b) lands as a separate deliverable before the next handoff. **Decision on whether (b) is in Agent 10's scope or a subsequent agent's.**

**Q3 — MCP-wire integration test harness scope.** If the answer to Q2 is "both," where does (b) live? Options:
(a) Agent 10 builds it as part of the Level 1+2 deliverable (expands scope but closes F0-class gaps categorically).
(b) Separate agent after Agent 10 (keeps Agent 10 focused on parser + three tools).
(c) Orchestrator-direct task in parallel with Agent 10 (similar pattern to D44).
**Decision needed at Agent 10 dispatch time.**

**Q4 — `read_asset_properties` default export rule.** Recommend: for assets whose primary AR entry class is `Blueprint`/`BlueprintGeneratedClass`/`WidgetBlueprintGeneratedClass`/`AnimBlueprintGeneratedClass`, default to the CDO export (`Default__<Name>_C`). For other assets, default to the main export whose `bIsAsset=true`. This matches the intuitive "read the thing the asset represents" model. **Confirm before Agent 10 wires the default.** Note: this rule extends the `genClassNames` set from the audit's `inspectBlueprint` finding (currently covers 3 BP-subclass types; `GameplayAbilityBlueprintGeneratedClass` not recognized). Agent 10 should extend the set as part of this work or document that unrecognized classes fall through to "main export."

**Q5 — Response shape for `truncated` when `max_bytes` hits mid-property.** When `read_asset_properties` emits a large struct (e.g., an FTransform nested inside an FArrayProperty that happened to be supported) and the budget runs out mid-serialize, what does the response look like?
(a) Omit the property entirely, add to `unsupported` with `reason: "size_budget_exceeded"`.
(b) Include the partial property with a `partial: true` marker.
**Recommend (a)** — partial values are a silent-truncation source. Clean cutoff is easier to reason about.

**Q6 — Container-property phase 2.5 scheduling.** Agent 8 defers `ArrayProperty`/`MapProperty`/`SetProperty` to a post-Level-2 pass ("Phase 2.5"). Our recommendation ships those as `{unsupported: true, reason: "container_deferred"}` markers. Does that stay deferred, or does Agent 10 attempt simple-element arrays (e.g., `TArray<int32>`, `TArray<FVector>`, `TArray<FGameplayTag>`) in-scope? Agent 8's estimate is 3-5 days extra for full container support. Simple-element arrays alone might be 1-2 days. **Decision affects Agent 10 scope + Level 1+2 ship window.**

---

**Already decided — not re-litigated**:
- D44: yaml is single source of truth. All new/modified tool params declared in yaml only.
- M6: supplementary tests in CLAUDE.md rotation (436 total). Agent 10 keeps new parser-level tests in that pattern.
- M3: `inspect_blueprint.verbose` description already matches yaml ("Currently unused"). Q1 above is specifically about repurposing, not re-describing.

---

## Final Report

```
Agent 9 Final Report — Tool Surface Design

Recommendation: Option C (Hybrid)
New tools added: 1 (read_asset_properties)
Existing tools modified: 2 (list_level_actors gains transforms + pagination + summary mode; inspect_blueprint gains include_defaults opt-in)
Phase 3 read-side tools eliminated: 1 (data-assets.get_data_asset_properties — direct overlap with read_asset_properties)
  — plus 4 already eliminated pre-L12 per D37 (search_assets, get_class_hierarchy, get_asset_metadata, get_asset_info registry-trio already landed)
Phase 3 read-side tools reduced: 12 (get_blueprint_info, get_blueprint_variables, get_blueprint_components,
  get_niagara_system_info, get_asset_references, actors.get_actor_transform static case,
  list_gameplay_tags_runtime static subset, get_curve_asset simple subset,
  get_struct_definition, list_material_parameters static subset, get_widget_blueprint static-slot subset,
  rc_get_property static CDO case)
Open questions: 6 (verbose repurposing, param-passthrough test strategy, MCP-wire harness scope,
  read_asset_properties default export rule, truncation shape, container deferral scheduling)
Deliverable: docs/research/level12-tool-surface-design.md (400 lines)
```
