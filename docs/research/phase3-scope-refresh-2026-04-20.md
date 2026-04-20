# Phase 3 Scope Refresh — Research Deliverable

> **Author**: Phase 3 Scope-Refresh Research agent
> **Date**: 2026-04-20
> **Type**: Research — orchestrator-actionable scope document. No code changes, no dispatch authorship, no yaml edits.
> **Inputs**: `docs/handoffs/phase3-scope-refresh-research.md` (dispatch), Tier-1 through Tier-5 per handoff (see §Appendix A).
> **HEAD at research**: `66937c0` on main (handoff-queue commit, one past EN-2 final report `ae7fb96`). Test baseline 825 — verified in CLAUDE.md (not re-run; handoff §Tier-6 empirical verification is optional).
> **Deliverable consumers**: Phase 3 dispatch orchestrator (queues M0–M6 per §Q5). Sidecar amendment maintainers (§Framing-audit for widget-tree sharpening).
> **Seal**: Research document — factual corrections via blockquote amendment only.

---

## §Executive summary

1. **Phase 3 plugin-side scope shrinks from 63 tcp-55558 stubs to 54 retained tools** — 6 DROP (`search_assets`, `get_class_hierarchy`, `get_asset_metadata`, `get_data_asset_properties`, `list_gameplay_tags_runtime`, `create_asset`), 3 MOVE-TO-SIDECAR (`get_blueprint_graphs`, `get_animbp_graph`, EventGraph subset of `get_widget_blueprint`), plus the 32 tcp-55557 transitional tools (actors/blueprints-write/widgets) that rebuild on 55558 per D23/D40 oracle retirement with P0-1 through P0-11 quality upgrades. Net plugin-TCP surface ≈ 54 (new 55558 reads/writes) + 32 (transitional rebuild) = **~86 tools on the 55558 plane**, down from the ~95 implied by pre-D45/D48/D50 yaml.
2. **DR-3 verdict: SHIP-SIDECAR-PHASE-A-FIRST**. 3F splits cleanly — Phase A (save-hook + prime_bp_cache-via-editor-menu + offline reader + 9 traversal verbs) has **no 3A TCP dependency** and can parallelize with infrastructure work; Phase B (dump_graph TCP + agent-invocable prime) adds the on-demand path after M1 scaffolding. This collapses the "sidecar first vs last" debate into "sidecar's read surface ships as soon as the save-hook plugin loads."
3. **Skeletal-subset S-B verdict: PURSUE-AFTER-SIDECAR**. The handoff's 4-6 session claim is aspirational; honest range is ~6-9 sessions (3-4 fixed base pin-block RE + ~1 per-node overrides + 1-2 LinkedTo + 1-2 version-skew buffer — the 19-type restriction only collapses the per-node slice). Recommend pursuing **after sidecar ships** because sidecar becomes the oracle for validating S-B's byte-level parse against known-correct editor JSON. D52 explicitly weakens the reopening trigger ("workflow pressure accumulates OR 3F slips") — S-B now aligns even without crisis, but the oracle dependency still orders it after sidecar.
4. **Sequencing: M0 (yaml grooming, ~0.5 session) → M1 (3A TCP scaffolding, 3-5 sessions) + M2-Phase-A (sidecar save-hook + verbs, 3-5 sessions) in parallel → M2-Phase-B (dump_graph, 1-2 sessions) + M3 (oracle retirement, 6-10 sessions) + M4 (reduced blueprint-read + asset-registry + data-assets, 3-5 sessions) in parallel → M5 (animation + materials + geometry + input-PIE + editor-utility + visual-capture, 6-10 sessions, sub-parallelizable) → optional M6 (skeletal S-B, 6-9 sessions, oracle-gated on M2).** Conservative total ~25-37 sessions (excluding optional M6). 
5. **Tool-surface cleanup (Q6)**: TS-1 and TS-2 fold into M3 oracle retirement (single-commit yaml + handler drop). TS-3 resolved as DROP in Q1 (zero catalog demand). No standalone cleanup pass needed.

**Framing concerns surfaced**: (a) handoff's S-B cost collapse estimate underweights fixed-cost floors; (b) widget-tree hierarchy is UMG/Slate, not UEdGraph — `get_widget_blueprint` MOVE-TO-SIDECAR needs sub-scope handling; (c) the 9 sidecar traversal verbs are new **offline** tools (not plugin scope) and are the bulk of workflow unlock from the 3F milestone.

---

## §Q1 Displacement table — every Phase 3 yaml stub

Coverage below: every tool with `layer: tcp-55558` in `tools.yaml` + the 32 `layer: tcp-55557` transitional tools (rebuild on 55558 per D23/D40). Remote-control (HTTP:30010) is Phase 4, out of scope per handoff §You-are-NOT.

**Legend**:
- **DROP** — remove from Phase 3 scope; offline equivalent ships or no catalog demand.
- **KEEP** — stays in Phase 3 TCP scope; may be reduced (some surface absorbed offline, plugin handles the remainder) or full (no offline displacement possible).
- **MOVE-TO-SIDECAR** — satisfied by the 3F sidecar milestone (dump_graph + save-hook + offline reader + traversal verbs); no dedicated TCP tool needed.
- **D52 category** — (a) runtime/PIE state; (b) UEdGraph pin topology; (c) compiled/derived data; (d) reflection-only metadata; (w) write op (self-justifying; no D52 category needed).

### §Q1.1 `gas` toolset (5 tools)

| Yaml stub | Offline displacer | Disposition | D52 cat. | Rationale |
|-----------|-------------------|-------------|----------|-----------|
| `create_gameplay_effect` | — | KEEP (full) | (w) | Asset creation via UFactory; write op. |
| `create_gameplay_ability` | — | KEEP (full) | (w) | Same. |
| `modify_gameplay_effect` | — | KEEP (full) | (w) | Edits existing GE; write op. |
| `list_gameplay_tags_runtime` | `list_gameplay_tags` (offline, parses `DefaultGameplayTags.ini`); `read_asset_properties` covers tag properties on CDOs | **DROP** | — | Offline `list_gameplay_tags` covers project tag hierarchy. "Live editor tag state" case (tag manager mid-edit) is niche — cost/benefit fails under D52. Catalog row 40/73 serve via offline. Runtime case if ever needed can re-enter via RC API (Phase 4). |
| `create_attribute_set` | — | KEEP (full) | (w) | Class-template generation; write op. |

### §Q1.2 `blueprint-read` toolset (9 tools) — post-D48 S-A, post-D50 tagged-fallback

| Yaml stub | Offline displacer | Disposition | D52 cat. | Rationale |
|-----------|-------------------|-------------|----------|-----------|
| `get_blueprint_info` | `inspect_blueprint` (structural); `query_asset_registry` (AR tag `ImplementedInterfaces`); `read_asset_properties` (CDO) | KEEP (reduced) | (d) | Retained surface: runtime-reflected interface list + UClass flags only. Structural fields already offline (D37). |
| `get_blueprint_variables` | `inspect_blueprint include_defaults` (CDO values); `read_asset_properties` | KEEP (reduced) | (d) | Retained surface: reflection-only metadata (replication flags, EditAnywhere, tooltips, Category). CDO values covered offline post-Agent-10. |
| `get_blueprint_functions` | `find_blueprint_nodes` class filter `K2Node_FunctionEntry` (name-level) + `inspect_blueprint` Function exports | KEEP (reduced) | (d) | Retained surface: full function signatures (params, return type, static/const/pure flags). Name-level enumeration moves offline via L3A S-A (D48). |
| `get_blueprint_graphs` | 3F sidecar dump_graph + traversal verbs | **MOVE-TO-SIDECAR** | (b) | This IS the 3F `dump_graph` command (3F-1). Do not list as a separate plugin-TCP tool; implementation is sidecar write + offline reader + verbs. |
| `get_blueprint_components` | `inspect_blueprint` SCS exports + `read_asset_properties` on SCS nodes (defaults via D50 tagged-fallback) | KEEP (reduced) | (a) | Retained surface: live-attached-via-construction-script components (not saved). SCS tree + defaults covered offline. |
| `get_blueprint_event_dispatchers` | `find_blueprint_nodes` class filter on `K2Node_AddDelegate`/`K2Node_AssignDelegate` (presence-only per D48) | KEEP (reduced) | (b) | Retained surface: full delegate binding targets (which function is bound on which object). Requires UEdGraph pin trace — sidecar L2 closes this. Presence-only covered offline. |
| `get_animbp_graph` | 3F sidecar dump_graph on UAnimBlueprint + Sidecar Design Q3 inline state-machine data | **MOVE-TO-SIDECAR** | (b) | Sidecar Design Session Q3 resolved: "v1 ships state-machine structure inside the sidecar dump; existing verbs handle the sub-graph cases." Not a dedicated plugin-TCP tool. |
| `get_widget_blueprint` | Split by sub-scope (see notes) | **SPLIT: MOVE-TO-SIDECAR + KEEP (reduced)** | (b) + (d) | **EventGraph + functions subset**: sidecar (UWidgetBlueprint is UBlueprint subclass — covered by 3F-1 scope). **Widget hierarchy tree + property bindings**: UMG/Slate data, NOT UEdGraph. Sidecar Design Session did not extend dump_graph schema to widget designer data. Plugin-TCP tool retained for the widget-tree sub-scope. See framing note §Framing-audit F-1. |
| `get_niagara_system_info` | `read_asset_properties` on UNiagaraSystem CDO (user-exposed params + FVector bounds via D50) | KEEP (reduced) | (c) | Retained surface: compiled Niagara VM state + emitter graph evaluation. Static params + bounds covered offline. |

### §Q1.3 `asset-registry` toolset (5 tools)

| Yaml stub | Offline displacer | Disposition | D52 cat. | Rationale |
|-----------|-------------------|-------------|----------|-----------|
| `search_assets` | `query_asset_registry` (D32/D37 eliminated) | **DROP** | — | Fully covered offline. Already flagged in Agent 9 §3 + Audit B §4. |
| `get_asset_references` | Forward refs via `read_asset_properties` (FSoftObjectPath/ObjectProperty walk); reverse refs via full-corpus offline scan (~6 min) or `IAssetRegistry::GetReferencers` (plugin fast-path) | KEEP (reduced) | (c) | Retained surface: reverse-reference queries (catalog Rank 2, HIGH frequency). Editor's in-memory reference graph is strictly faster than offline full-scan. Forward-ref subset covered offline. |
| `get_class_hierarchy` | `query_asset_registry class_name:Blueprint tag_key:ParentClass` (D32/D37 eliminated) | **DROP** | — | Fully covered offline. |
| `get_datatable_contents` | `read_asset_properties` via D50 tagged-fallback for UUserDefinedStruct-keyed rows | KEEP (reduced) | (c) | Retained surface: engine-struct-keyed DataTables + cooked/compiled DataTable access. UUserDefinedStruct-keyed rows covered offline post-D50 (Audit B §2.2 inferred SERVED_OFFLINE flip). |
| `get_asset_metadata` | `get_asset_info` (D32/D37 eliminated) | **DROP** | — | Fully covered offline. |

### §Q1.4 `animation` toolset (8 tools)

| Yaml stub | Offline displacer | Disposition | D52 cat. | Rationale |
|-----------|-------------------|-------------|----------|-----------|
| `create_montage` | — | KEEP (full) | (w) | Write. |
| `add_montage_section` | — | KEEP (full) | (w) | Write. |
| `add_montage_notify` | — | KEEP (full) | (w) | Write. |
| `get_montage_full` | `read_asset_properties` on UAnimMontage CDO (sections, notifies, slots) | KEEP (reduced) | (c) | Retained surface: evaluated blend settings + compiled slot machinery. Scalar section/notify data covered offline. |
| `get_anim_sequence_info` | `read_asset_properties` on UAnimSequence metadata | KEEP (reduced) | (c)/(d) | Retained surface: compiled notify tracks + runtime-evaluated curves + sync markers. Duration, frame count, skeleton ref covered offline. |
| `get_blend_space` | `read_asset_properties` on UBlendSpace sample points | KEEP (reduced) | (c) | Retained surface: runtime interpolation evaluation. Sample points + blend axes covered offline. |
| `get_anim_curve_data` | `read_asset_properties` (simple curve keyframes) | KEEP (reduced) | (c) | Retained surface: compiled curve baking + evaluated values. Keyframe data covered offline for simple cases. |
| `get_audio_asset_info` | `read_asset_properties` on SoundCue/SoundWave CDOs | KEEP (reduced) | (a)/(c) | Retained surface: runtime playback state + compiled Wwise/AkAudioEvent metadata (AkAudioEvent needs Wwise SDK reflection). CDO metadata covered offline. |

### §Q1.5 `materials` toolset (5 tools)

| Yaml stub | Offline displacer | Disposition | D52 cat. | Rationale |
|-----------|-------------------|-------------|----------|-----------|
| `create_material` | — | KEEP (full) | (w) | Write. |
| `create_material_instance` | — | KEEP (full) | (w) | Write. |
| `set_material_parameter` | — | KEEP (full) | (w) | Write. |
| `list_material_parameters` | `read_asset_properties` on material CDO (static defaults; D50 tagged-fallback for FMaterialParameterInfo) | KEEP (reduced) | (c) | Retained surface: compiled shader uniforms (compile-time constants baked by the editor material compiler). Static parameter defaults covered offline. |
| `get_material_graph` | — | KEEP (full) | (c) | Full UMaterialExpression graph — different node hierarchy from UEdGraph; Sidecar Design Session Q4 deferred material traversal verbs to v1.1. **This** is the v1 material read interface. |

### §Q1.6 `data-assets` toolset (7 tools)

| Yaml stub | Offline displacer | Disposition | D52 cat. | Rationale |
|-----------|-------------------|-------------|----------|-----------|
| `create_data_asset` | — | KEEP (full) | (w) | Write. |
| `set_data_asset_property` | — | KEEP (full) | (w) | Write. |
| `list_data_asset_types` | `query_asset_registry class_name:DataAsset` (class subset via AR tag) | KEEP (reduced) | (d) | Retained surface: reflection-only "subclasses defined in loaded modules" (discover runtime-registered DataAsset classes). AR-tag-surface covered offline. |
| `get_data_asset_properties` | `read_asset_properties` (direct superset — Agent 9 §3 eliminated) | **DROP** | — | No-remainder subset of `read_asset_properties`. |
| `get_curve_asset` | `read_asset_properties` (simple UCurveFloat/Vector/Color keyframes) | KEEP (reduced) | (c) | Retained surface: compiled/baked curve evaluation + complex UCurveTable joins. Simple keyframes covered offline. |
| `get_string_table` | `read_asset_properties` on UStringTable (D50 tagged-fallback; Audit B §2.2 inferred flip) | KEEP (reduced) | (c) | Retained surface: localization compilation + culture-specific lookups. Binary UStringTable key/value entries covered offline. |
| `get_struct_definition` | `read_asset_properties` on UUserDefinedStruct (member layout via D50 tagged-fallback); UUserDefinedEnum values via tag iteration | KEEP (reduced) | (d) | Retained surface: member metadata (EditAnywhere, BlueprintReadWrite flags, tooltips). Member layout covered offline. |

### §Q1.7 `input-and-pie` toolset (7 tools)

| Yaml stub | Offline displacer | Disposition | D52 cat. | Rationale |
|-----------|-------------------|-------------|----------|-----------|
| `create_input_action` | — | KEEP (full) | (w) | Write. |
| `create_mapping_context` | — | KEEP (full) | (w) | Write. |
| `add_mapping` | — | KEEP (full) | (w) | Write. |
| `start_pie` | — | KEEP (full) | (a) | Runtime control. |
| `stop_pie` | — | KEEP (full) | (a) | Runtime control. |
| `execute_console_command` | — | KEEP (full) | (a) | Runtime control. |
| `is_pie_running` | — | KEEP (full) | (a) | Runtime state. |

### §Q1.8 `geometry` toolset (4 tools)

| Yaml stub | Offline displacer | Disposition | D52 cat. | Rationale |
|-----------|-------------------|-------------|----------|-----------|
| `create_procedural_mesh` | — | KEEP (full) | (w) | Write (actor spawn). |
| `mesh_boolean` | — | KEEP (full) | (w)/(c) | CSG compute — derived data. |
| `generate_uvs` | — | KEEP (full) | (w)/(c) | Compute — derived data. |
| `get_mesh_info` | — | KEEP (reduced) | (c) | Retained surface: compiled vertex buffer evaluation + runtime bounds. Offline parsing of static mesh headers could cover vertex/triangle counts in a future enhancement; deferred. |

### §Q1.9 `editor-utility` toolset (8 tools)

| Yaml stub | Offline displacer | Disposition | D52 cat. | Rationale |
|-----------|-------------------|-------------|----------|-----------|
| `get_editor_state` | — | KEEP (full) | (a) | Current level, selected actors — runtime state. |
| `run_python_command` | — | KEEP (full) | (a)/(w) | Arbitrary compute in editor context. |
| `get_editor_utility_blueprint` | `inspect_blueprint` + `read_asset_properties` for BP structure | KEEP (reduced) | (d) | Retained surface: Run method binding + editor menu registration. Standard BP introspection covered offline. |
| `run_editor_utility` | — | KEEP (full) | (a) | Runtime execute. |
| `create_asset` | — (no offline displacer, zero catalog demand) | **DROP** (per TS-3 in §Q6) | — | Generic UFactory tool; no workflow catalog query maps onto "create arbitrary asset class by name." Domain-specific creators (create_material, create_data_asset, etc.) cover real demand. |
| `duplicate_asset` | — | KEEP (full) | (w) | Write with reference fixup. |
| `rename_asset` | — | KEEP (full) | (w) | Write with reference fixup. |
| `delete_asset_safe` | — | KEEP (full) | (w) | Write with dependency check. |

### §Q1.10 `visual-capture` toolset (5 tools)

| Yaml stub | Offline displacer | Disposition | D52 cat. | Rationale |
|-----------|-------------------|-------------|----------|-----------|
| `get_asset_thumbnail` | — | KEEP (full) | (c) | Editor-rendered thumbnail via UThumbnailManager. |
| `get_viewport_screenshot` | — | KEEP (full) | (a) | Live viewport render. |
| `get_asset_preview_render` | — | KEEP (full) | (c) | Offscreen FPreviewScene render. |
| `capture_active_editor_tab` | — | KEEP (full) | (a) | Editor UI state capture via FWidgetRenderer. |
| `get_asset_visual_summary` | — | KEEP (full) | (c) | Composite of text introspection + inline image. |

### §Q1.11 Transitional (tcp-55557 → tcp-55558 per D23/D40)

Per advisor framing note: these 32 tools are **oracle-retirement targets with P0-1 through P0-11 quality upgrades**, not new TCP API design. Handler contracts already documented in `docs/specs/conformance-oracle-contracts.md` §Sections 2-8 and `docs/specs/phase3-plugin-design-inputs.md` P0-1..11.

| Toolset | Count | Disposition | D52 cat. | Rationale |
|---------|-------|-------------|----------|-----------|
| `actors` | 10 | KEEP (reduced static subset, full live/write subset) — except TS-1 (see §Q6) | (a) + (w) | `list_level_actors` absorbs static-saved transforms per D37/Option C. Live-state enumeration (`get_actors`), mutation (`spawn_actor` etc.), transform write (`set_actor_transform`) all plugin-only. `take_screenshot` duplicates `visual-capture.get_viewport_screenshot` — resolve via TS-1. |
| `blueprints-write` | 15 | KEEP (full) | (w) | All write ops — BP creation, component addition, node addition, pin connection, compile. P0-5 (compile error reporting), P0-6 (FScopedTransaction), P0-11 (pin-type validation) apply here. |
| `widgets` | 7 | KEEP (full, minus TS-2) | (w) | Widget creation/binding write ops. `add_widget_to_viewport` is a NO-OP per D27 — resolve via TS-2. P0-7 (widget path standardization), P0-8 (valid binding function graph) apply. |

### §Q1.12 Rollup

| Disposition | Count | Tools |
|-------------|-------|-------|
| **DROP** | 6 | `search_assets`, `get_class_hierarchy`, `get_asset_metadata`, `get_data_asset_properties`, `list_gameplay_tags_runtime`, `create_asset` (+ TS-1 `take_screenshot` dedupe, TS-2 `add_widget_to_viewport` per §Q6) |
| **MOVE-TO-SIDECAR** (consolidate under 3F-1 dump_graph + offline reader + verbs) | 3 | `get_blueprint_graphs`, `get_animbp_graph`, EventGraph subset of `get_widget_blueprint` |
| **KEEP (reduced)** | 18 | `get_blueprint_info`, `get_blueprint_variables`, `get_blueprint_functions`, `get_blueprint_components`, `get_blueprint_event_dispatchers`, widget-tree subset of `get_widget_blueprint`, `get_niagara_system_info`, `get_asset_references`, `get_datatable_contents`, `get_montage_full`, `get_anim_sequence_info`, `get_blend_space`, `get_anim_curve_data`, `get_audio_asset_info`, `list_material_parameters`, `list_data_asset_types`, `get_curve_asset`, `get_string_table`, `get_struct_definition`, `get_mesh_info`, `get_editor_utility_blueprint` (+ `actors` static subset annotated) |
| **KEEP (full)** | 35 (of 55558 new + visual-capture/geometry/editor-utility/input-PIE that stay unchanged) | All write ops (gas/animation/materials/data-assets/input-and-pie/geometry/editor-utility/visual-capture creators + mutators) + runtime-state tools + `get_material_graph` (v1 material read interface) + visual-capture (5) + editor-utility runtime (4) + geometry (3 write + 1 reduced) |
| **Transitional — oracle rebuild** | 32 | 10 `actors` (TS-1 resolved) + 15 `blueprints-write` + 7 `widgets` (TS-2 resolved) |

**Net**: Phase 3 plugin-TCP surface reduces from `63 + 32 = 95` stubs (pre-refresh yaml) to `(63 - 6 - 3) + 32 = 86` tools. **9 tools removed from plugin scope via displacement/consolidation** (6 DROP + 3 MOVE-TO-SIDECAR). **18 tools keep plugin placement but with reduced scope** (majority of read-side).

Additional work not in the Phase 3 yaml stub list: **9 new offline tools** ship as the 3F consumer surface per §Q3 (see framing note §Framing-audit F-2).

---

## §Q2 Plugin-only justification table — remaining stubs under D52

Every KEEP disposition in §Q1 justified against the four D52 categories. Tools mapped per D52 §"Plugin's read-side scope shrinks to: (a) runtime/PIE state, (b) UEdGraph pin topology, (c) compiled/derived data, (d) reflection-only metadata."

### §Q2.1 Category (a) runtime/PIE state — 11 tools

| Tool | Why plugin-only | Could offline close? |
|------|-----------------|----------------------|
| `get_blueprint_components` (reduced) | Live-attached-via-construction-script components not saved in `.uasset` | No — construction-script components only exist after PIE/editor instantiation |
| `get_audio_asset_info` (reduced subset) | Runtime playback state / live Wwise AkAudioEvent metadata | Partial — Wwise SDK reflection still editor |
| `start_pie` / `stop_pie` / `is_pie_running` | PIE lifecycle control | No — intrinsically editor-mediated |
| `execute_console_command` | Runs in PIE/editor context | No — requires live UEngine |
| `get_editor_state` | Current level, selected actors, viewport info | No — editor session state |
| `run_editor_utility` | Execute editor utility Run action | No — runtime invocation |
| `get_viewport_screenshot` | Live viewport render | No — requires active viewport |
| `capture_active_editor_tab` | Editor UI state | No — FWidgetRenderer requires active Slate tree |
| `actors.*` live subset (spawn/delete/transform etc.) | Runtime actor manipulation | No — write/mutation |

### §Q2.2 Category (b) UEdGraph pin topology — 5 tools (all MOVE-TO-SIDECAR or sidecar-subset)

| Tool | Why plugin/sidecar-only | Could offline close? |
|------|--------------------------|----------------------|
| `get_blueprint_graphs` → MOVE-TO-SIDECAR | Pin edges via `UEdGraphPin.LinkedTo`; sidecar L2 | Per D48 S-B FOLD-INTO-3F; optionally reopened in M6 per §Q4 |
| `get_animbp_graph` → MOVE-TO-SIDECAR | State-machine transitions via UEdGraph pin edges | Same |
| `get_widget_blueprint` EventGraph subset → MOVE-TO-SIDECAR | UWidgetBlueprint EventGraph is UEdGraph | Same |
| `get_blueprint_event_dispatchers` (reduced) | Delegate binding *targets* require UEdGraph pin trace on `K2Node_AddDelegate.CustomFunctionName` pin | Per D48 S-B |
| `get_niagara_system_info` (reduced subset — emitter graph edges) | Niagara graph is custom node hierarchy, editor-only | Per Sidecar Design Q4 defer pattern |

### §Q2.3 Category (c) compiled/derived data — 14 tools

| Tool | Why plugin-only | Could offline close? |
|------|-----------------|----------------------|
| `get_asset_references` (reverse-ref subset) | Editor's `IAssetRegistry::GetReferencers` graph | Yes-but-slow — offline full-scan ~6 min/project; plugin is fast-path |
| `get_datatable_contents` (engine-struct-keyed + cooked) | Compiled DataTable row cache | Partial — UUserDefinedStruct rows close via D50; engine-struct rows need engine-struct registry work |
| `get_montage_full` (evaluated blend + slot machinery) | Runtime-evaluated montage state | No — requires live UAnimInstance |
| `get_anim_sequence_info` (compiled notify/curve eval) | Compiled notify-track lookups + evaluated curves | Partial — keyframe data offline; evaluation editor-only |
| `get_blend_space` (runtime interpolation) | Runtime-evaluated blend | No — live state |
| `get_anim_curve_data` (compiled/baked) | Compiled curve bake | Partial — simple curves offline |
| `list_material_parameters` (compiled shader uniforms) | Shader compiler output | No — compile-time constants baked by editor material compiler |
| `get_material_graph` | Full UMaterialExpression graph walk | Per Sidecar Design Q4 — defer v1.1, `get_material_graph` is the v1 read interface |
| `get_curve_asset` (compiled bake) | Compiled UCurveTable join evaluation | Partial — simple curves offline |
| `get_string_table` (localization compile) | Culture-compiled lookups | Partial — raw entries offline via D50 |
| `get_mesh_info` | Compiled vertex buffer | No — requires engine-side compilation pipeline |
| `get_asset_thumbnail` | Editor-rendered thumbnail cache | No — thumbnail rendering requires live editor |
| `get_asset_preview_render` | FPreviewScene render | No — offscreen editor pipeline |
| `get_asset_visual_summary` | Composite of above | Inherits constraints |

### §Q2.4 Category (d) reflection-only metadata — 8 tools

| Tool | Why plugin-only | Could offline close? |
|------|-----------------|----------------------|
| `get_blueprint_info` (reduced) | Runtime-reflected interface list + UClass flags | No — UClass walks need live CDO hierarchy |
| `get_blueprint_variables` (reduced) | EditAnywhere/BlueprintReadWrite flags + tooltips + Category | No — per-property UPROPERTY flags live in reflection, not `.uasset` bytes (Agent 9 §3 note) |
| `get_blueprint_functions` (reduced) | Full signature reflection (params, return, static/const/pure flags) | Partial — some flags inferable from FPropertyTag types; UFUNCTION flags need reflection |
| `get_blueprint_event_dispatchers` (reduced) | Full parameter signatures for delegate declarations | Partial |
| `get_audio_asset_info` (compiled Wwise metadata) | SDK reflection | No |
| `list_data_asset_types` (runtime-registered subclasses) | UClass registry walk | No |
| `get_struct_definition` (member metadata flags) | UStruct walk | Partial — member layout offline via D50 |
| `get_editor_utility_blueprint` (Run method binding) | UClass method reflection | No |

### §Q2.5 Write ops (w) — 35 tools

Self-justifying per D52 ("Write ops and mutation tools are plugin-only by definition — they don't need separate justification under D52."). Tools: all `create_*`, `add_*`, `set_*`, `modify_*`, `compile_*`, `spawn_*`, `delete_*`, `duplicate_*`, `rename_*`, `run_python_command`.

**Flag per handoff §Q2 instruction** ("flag cases where a 'write op' is suspiciously read-adjacent"): none surfaced. Every write in the Phase 3 scope either mutates an asset, spawns an actor, compiles a graph, or executes a script. No write-to-read-back patterns.

### §Q2.6 Defensibility check

For each KEEP disposition, the D52 category chain holds:
- (a) Every `start_pie` / `stop_pie` / `get_editor_state` requires a live UEngine. Cannot be served from `.uasset` bytes alone.
- (b) UEdGraph pin topology is zero-reference per Agent 11.5 §2.2 (CUE4Parse `/EdGraph/` 4 type-classification files only; no UEdGraphPin instance reader). D48 S-A covers name-level; pin edges are sidecar L2 or S-B M6.
- (c) Compiled/derived data is shader/VM/cooker output. Would require re-implementing the UE compiler offline — far outside scope.
- (d) Reflection-only metadata lives in UClass/UProperty registries, not `.uasset` property blobs. `FPropertyTag` streams carry property names + values, not metadata flags.

Every "KEEP in Phase 3" row has a D52-category ground. 0 rows fail the check.

---

## §Q3 DR-3 recommendation — 3F sidecar as early milestone

**Verdict: SHIP-SIDECAR-PHASE-A-FIRST.** Phase A runs in parallel with M1 scaffolding; Phase B lands after M1.

### §Q3.1 The Phase A / Phase B split (advisor refinement)

The 3F sidecar milestone decomposes by TCP scaffolding dependency:

| Phase | Components | TCP-55558 dependency | Parallelizable with M1? |
|-------|------------|----------------------|-------------------------|
| **Phase A** | 3F-2 save-hook (editor delegate registration); 3F-3 `prime_bp_cache` editor-menu command; offline sidecar reader (`offline-tools.mjs`); 9 traversal verbs (`bp_list_graphs`, `bp_list_entry_points`, `bp_trace_exec`, `bp_trace_data`, `bp_show_node`, `bp_neighbors`, `bp_subgraph_in_comment`, `bp_paths_between` [v1.1 per D41], `bp_find_in_graph`) | None — save-hook is `FCoreUObjectDelegates::OnObjectSaved` registration; prime command is editor-menu invocation; reader + verbs are JS | YES |
| **Phase B** | 3F-1 `dump_graph` TCP command; TCP-invocable `prime_bp_cache` for agent-driven priming | Yes — needs 3A TCP envelope (P0-1 error format, P0-9 null-check, P0-10 transform parsers) | No — sequential after M1 |

### §Q3.2 Why SHIP-SIDECAR-PHASE-A-FIRST wins

1. **Dependency cleanliness**. Phase A has zero TCP dependency. The save-hook can dispatch immediately after the plugin module loads; the prime command runs via editor UI; the offline reader + verbs land in `offline-tools.mjs` as JS additions. No blocking on M1 3A infrastructure.

2. **D52 near-parity trajectory**. D52's goal is "push toward 85-90% fully-offline." The 3F sidecar's offline-reader + 9 verbs land **5 sidecar-gated workflow rows** (catalog rows 9, 10, 13, 16, 30) plus all trace/spatial workflows from Agent 11.5 §4.3 rows 5-7. Shipping Phase A first directly advances the D52 numeric target without waiting on M1.

3. **Minimal Phase 3 scope-creep risk**. Phase A is ~3-5 agent sessions (Sidecar Design Session §DR-3 scope math: "3F-2 Save-hook... 3F-3 `prime_bp_cache`... Offline reader... traversal verbs ship with the reader"). Small, well-scoped, separately verifiable.

4. **Sidecar is oracle for M6 (S-B) per §Q4**. If M6 is ever commissioned, it needs the sidecar as a known-correct editor-JSON reference. Phase A ships that oracle.

5. **D49 parallel-session discipline already validated**. The orchestrator has demonstrated parallel-worker dispatches (EN-2 + orchestrator-state commits at HEAD). Phase A + M1 in parallel is within the established operating envelope.

6. **Sidecar = "transition tool" per D52**. D52's reframe makes explicit that sidecar is "plugin-mediated short-term parity, not the final answer." Ship the transition path sooner so the transition window starts closing.

### §Q3.3 Trade-off analysis

**Dominant trade-off**: agent-productivity-via-early-L2-availability vs Phase 3 cohesion (keep sidecar + plugin work bundled for dispatch simplicity).

Agent-productivity wins because:
- Phase A unblocks offline BP pin-trace + spatial + exec-flow workflows that are currently `NOT_SERVED` or `SERVED_PARTIAL`.
- Phase 3 cohesion is preserved at the **orchestration** level (same phase, same dispatch rhythm) while splitting at the **implementation** level (separate worker sessions with clean scope).

**Rejected alternatives**:
- **BUNDLE-WITH-PHASE-3** (sidecar as one of N concurrent work items): adds dispatch complexity without dependency benefit — Phase A doesn't need to wait for M1, and waiting loses the parallelism win.
- **DEFER-SIDECAR** (rest of Phase 3 first): loses the D52-near-parity trajectory for months and blocks M6 even if commissioned. No defensible reason given Phase A's decoupling.

### §Q3.4 Sequencing within the sidecar milestone

| Step | Component | Cost | Who ships |
|------|-----------|------|-----------|
| 1 | Consumer-side: offline reader + path-translation helper (§Sidecar Q1 = `Saved/UEMCP/BPCache/` mirror tree) | 0.5 session | Offline worker |
| 2 | Consumer-side: 9 traversal verbs in offline-tools.mjs | 1-2 sessions | Offline worker |
| 3 | Plugin Phase A: save-hook + sidecar writer (serializer + `OnObjectSaved` delegate) | 1-2 sessions | Plugin worker |
| 4 | Plugin Phase A: `prime_bp_cache` editor-menu command | 0.5 session | Plugin worker |
| 5 | Plugin Phase B (after M1): `dump_graph` TCP handler + TCP-invocable `prime_bp_cache` | 1-2 sessions | Plugin worker (post-M1) |

Steps 1-4 parallelize with M1 via two workers. Steps 2 + 3 are the longest tails.

---

## §Q4 Skeletal-subset S-B verdict

**Verdict: PURSUE-AFTER-SIDECAR.** Revise Agent 11.5's FOLD-INTO-3F to PURSUE-AFTER-SIDECAR under D52's weakened reopening trigger, at honest cost range ~6-9 sessions (not the handoff's 4-6).

### §Q4.1 Cost refinement — the handoff's 4-6 claim is aspirational

Agent 11.5's 8-13 session S-B estimate breakdown (§2.3 of L3A skeletal study):

| Component | Cost | 19-type restriction collapses? |
|-----------|------|-------------------------------|
| Base pin-block RE (`UEdGraphNode::Serialize()` pin-binary layout) | 3-4 sessions | **No** — fixed cost; one reverse-engineering exercise regardless of how many K2Node types consume the parser |
| Per-node `Serialize()` overrides (~4-6 K2Nodes in Agent 11.5's original scope) | 2 sessions | **Partially** — skeletal 19 excludes UK2Node_MathExpression (the notorious override); ~1 session left for remaining CallFunction backcompat paths + any Event variants |
| LinkedTo resolution via pin-ID graph | 1-2 sessions | **No** — fixed pin-ID edge-table walker |
| Version-skew buffer (UE 5.6 ↔ 5.7 pin serialization format shifts: PersistentGuid, bit-flag packing, subpin layout) | 2-3 sessions | **Partially** — less surface to test across versions, but the core edge cases (bit flags, subpin) are format-level, not type-level |

**Refined honest estimate**: 3-4 (base fixed) + 1 (overrides collapsed) + 1-2 (LinkedTo fixed) + 1-2 (version-skew partially collapsed) = **~6-9 sessions**.

The handoff's 4-6 claim requires every buffer to collapse simultaneously (base down to 2-3, overrides to 0, LinkedTo to 1, version-skew to 1). That's aspirational — nothing in Agent 11.5's reference-coverage analysis (zero-reference on pin binary block) suggests the base RE collapses. Keep the 6-9 range; see §Framing-audit FA-1.

### §Q4.2 Base-class Serialize() analysis for the 19 shipped skeletal types

| K2Node type | Base-class Serialize()? | Known override surface | Coverage impact |
|-------------|-------------------------|------------------------|-----------------|
| UK2Node_Event, UK2Node_CustomEvent | Base | None | Clean |
| UK2Node_FunctionEntry / UK2Node_FunctionResult | Base + FUserPinInfo handling | FUserPinInfo arrays — tagged-property, handled at S-A level | Clean at pin layer |
| UK2Node_VariableGet / UK2Node_VariableSet | Base | None | Clean |
| UK2Node_CallFunction / UK2Node_CallParentFunction | Base + potential backcompat paths (deprecated node-version migrations) | CallFunction sometimes has legacy pin-layout upgrade code in Serialize() — ~1 session buffer | Mostly clean |
| UK2Node_IfThenElse, UK2Node_ExecutionSequence | Base | None | Clean |
| UK2Node_SwitchEnum / UK2Node_SwitchString / UK2Node_SwitchInteger | Base | Switch override on some versions for pin regeneration | Clean at pin-binary layer |
| UK2Node_DynamicCast | Base | None | Clean |
| UK2Node_MacroInstance | Base + FGraphReference | FGraphReference = tagged-property struct, S-A level | Clean at pin layer |
| UK2Node_Self | Base | None | Clean |
| UK2Node_Knot | Base (minimal — single in/out pin pair) | None | Clean |
| UK2Node_AddDelegate / UK2Node_AssignDelegate | Base | None | Clean at class-identity layer (per D48 delegate-presence scope) |

**Bottom line**: of the 19 shipped skeletal types, ~17 use base-class Serialize() at the pin-binary layer; ~2 (CallFunction, Switch variants) have override surface but only for backcompat/migration paths, not core pin layout.

The refined 19-type restriction *does* help, but via per-node overrides collapsing from 2 sessions to ~1, not via base pin-block RE collapsing. The base pin-block RE is irreducible.

### §Q4.3 D52's weakened reopening trigger

D52 entry text (risks-and-decisions.md:150): *"Reopening triggers for S-B (updated per D52): weakens from '3F must slip AND workflow must surface' to just 'workflow pressure accumulates OR 3F slips.' S-B aligns with D52 even without a sidecar crisis."*

This is a material policy shift. Under the old D48 trigger, S-B was DEFERRED pending crisis. Under D52, S-B is ALIGNED with the near-parity goal independent of sidecar status. So "PURSUE" becomes defensible without crisis; the question is only *when*.

### §Q4.4 Why PURSUE-AFTER-SIDECAR (not PURSUE-NOW)

1. **Oracle dependency**. The sidecar is the canonical editor-JSON reference. Without it, S-B implementation is guessing at `UEdGraphNode::Serialize()` format from engine source alone. With it, S-B can validate byte-level parse output against known-correct sidecar JSON for the same BP. Agent 11.5 §9 flagged this: "the magnitude is a judgment call" — oracle access materially tightens the estimate.

2. **Cost parity + coverage overlap**. S-B at ~6-9 sessions is comparable to the 3F sidecar milestone (~6-10 sessions total). Shipping both makes sense if the D52 trajectory justifies it; shipping S-B first loses the oracle.

3. **M1 scaffolding not on S-B's critical path**. S-B is pure offline byte parsing. Independent of TCP.

4. **Offline-first discipline per D30**. S-B's 6-9 sessions beats every other offline-reachable unlock in the current workload.

### §Q4.5 If PURSUE-AFTER-SIDECAR — starting node types

Best starting types for S-B by workflow coverage × parse simplicity:

| Priority | Type | Why first |
|----------|------|-----------|
| 1 | `UK2Node_CallFunction` / `UK2Node_CallParentFunction` | 81 instances in `BP_OSPlayerR` (Agent 11.5 §3.1), 53 in `BP_OSControlPoint`. Highest frequency. Trace verb `bp_trace_exec` needs function-call pin edges to follow. |
| 2 | `UK2Node_VariableGet` / `UK2Node_VariableSet` | 25-32 in samples. Data-flow tracing (catalog row 30 "trace variable back to defining write") needs this. |
| 3 | `UK2Node_Event` / `UK2Node_CustomEvent` | Entry points — every exec trace starts at one of these. |
| 4 | `UK2Node_IfThenElse` / `UK2Node_ExecutionSequence` / `UK2Node_SwitchEnum` | Control flow — needed for full exec trace. |
| 5 | `UK2Node_DynamicCast` | Conditional branches with pin type change. |
| 6 | `UK2Node_Knot` | Reroute collapse (Sidecar Design Q2 knot-collapse semantics apply here too). |
| 7 | `UK2Node_MacroInstance` / `UK2Node_FunctionEntry` / `UK2Node_FunctionResult` / `UK2Node_Self` / delegate-presence nodes | Complete the 19-type set. |

First three priorities cover ~90% of pin-trace value per Agent 11.5 §3.4 coverage ratios. Could ship in a ~3-4 session sub-milestone with S-B remainder following.

### §Q4.6 Verdict card

| Criterion | S-B (post-sidecar) |
|-----------|---------------------|
| Reference coverage ≥70% | ❌ Zero reference — RE against engine source + sidecar oracle |
| Cost (honest range) | **~6-9 sessions** |
| Coverage ratio ≥60% of BP nodes (pin-trace) | ✅ 19 types cover 62-100% of K2Nodes per Agent 11.5 §3.4 |
| Workflow unlock substantial | ✅ Pin-trace without editor-soft-dep — the D52 long-term parity target |
| Reopening trigger present | ✅ D52 weakened trigger: "workflow pressure accumulates OR 3F slips" → aligned with D52 even without crisis |
| Oracle available at dispatch time | Only after M2 (sidecar milestone ships) |

**Verdict: PURSUE-AFTER-SIDECAR as optional M6**, cost 6-9 sessions, gated on sidecar shipping first for oracle access. Skip if D52 near-parity trajectory is satisfied by sidecar alone + agent-automation workflows don't surface pressure for pure-offline pin-trace.

---

## §Q5 Dispatch sequencing — orchestrator-actionable milestones

### §Q5.1 Milestone overview

| Milestone | Title | Agent-sessions (range) | Parallelizable with |
|-----------|-------|------------------------|---------------------|
| **M0** | Phase 3 yaml grooming | 0.5 | (none — lightweight housekeeping) |
| **M1** | 3A TCP scaffolding + infrastructure | 3-5 | M2-Phase-A |
| **M2-Phase-A** | 3F sidecar save-hook + offline reader + 9 traversal verbs | 3-5 (2 parallel workers) | M1 |
| **M2-Phase-B** | 3F `dump_graph` TCP + TCP-invocable prime | 1-2 | M3, M4 |
| **M3** | Oracle retirement: actors + bp-write + widgets on 55558 | 6-10 (sub-parallelizable) | M2-Phase-B, M4, M5 |
| **M4** | Reduced blueprint-read + asset-registry + data-assets reads | 3-5 | M3, M5 |
| **M5** | Animation + materials + geometry + input-PIE + editor-utility + visual-capture | 6-10 (3-4 sub-workers) | M3, M4 |
| **M6** *(optional)* | Skeletal-subset S-B pure-offline pin-trace | 6-9 | M4, M5 (after M2) |

**Conservative total (excluding M6)**: 22-37 sessions; with parallelism, wall-clock ~12-20 sessions.

**With M6**: add 6-9 sessions, oracle-gated on M2 landing.

### §Q5.2 Dependency chain

```
M0 (yaml grooming)
    │
    ▼
M1 (3A TCP scaffolding) ◄──── parallel ────► M2-Phase-A (sidecar save-hook + reader + verbs)
    │                                             │
    ▼                                             ▼
M2-Phase-B (dump_graph TCP)        [sidecar workflows already live on save-hook fires]
    │
    ├──► M3 (oracle retirement: 55557 → 55558)   ◄─ parallel ─► M4 (reduced blueprint-read + AR + data-assets)
    │                                                           │
    │    M3 sub-workers possible:                              ▼
    │      M3a: actors handlers + P0-2/3/4                    [M4 workers can split per toolset]
    │      M3b: blueprints-write + P0-5/6/11
    │      M3c: widgets + P0-7/8                              M5 (animation + materials + geometry + input-PIE + editor-utility + visual-capture)
    │                                                           │
    │                                                           ▼
    │                                                         [M5 sub-workers: animation / materials / input-PIE / etc.]
    │
    ▼
M6 (optional S-B) — gated on M2-Phase-A oracle
```

### §Q5.3 Per-milestone scope

**M0 — Phase 3 yaml grooming** (0.5 session):
- Drop 6 DROP tools per §Q1 table.
- Add `displaced_by:` / `reduced_scope:` annotations on KEEP (reduced) entries so future agents can trace the displacement lineage.
- Annotate MOVE-TO-SIDECAR entries as consolidated under 3F.
- Preserve all planning stubs per D51.
- NO handler changes — yaml-only.
- Not load-bearing for dispatch — could fold into M1 as the first commit if orchestrator prefers.

**M1 — 3A TCP scaffolding** (3-5 sessions):
- C++ plugin scaffold on `plugin/` (currently empty per CLAUDE.md).
- `MCPServerRunnable` on TCP:55558 (mirror of `ProjectA\Plugins\UnrealMCP\` but with P0 quality upgrades).
- Command registry + dispatcher with validation (P0-9 null-check on `params`).
- Error envelope (`BuildErrorResponse` / `BuildSuccessResponse`) — P0-1.
- `FindActorInAllLevels` helper — P0-2.
- Actor name-or-label resolver — P0-3.
- `SetObjectProperty` struct/vector/object handlers via `REGISTER_PROPERTY_HANDLER` — P0-4.
- Transform parser returning `bool` — P0-10.
- Structured logging + request IDs (audit §INF-3 follow-ons).
- Unblocks all subsequent TCP work.

**M2-Phase-A — sidecar save-hook + offline reader + traversal verbs** (3-5 sessions, 2 parallel workers):
- *Plugin worker* (1-2 sessions): 3F-2 save-hook (`FCoreUObjectDelegates::OnObjectSaved` delegate; serializer emits amended-schema JSON to `<ProjectDir>/Saved/UEMCP/BPCache/<asset-path>.bp.json` per Sidecar Design Q1). 3F-3 `prime_bp_cache` editor-menu command (iterates `UBlueprint` subclass assets, idempotent by mtime).
- *Offline worker* (2-3 sessions): sidecar reader with path translation helper; schema-version check; stale/missing fallback (`{available: false, reason: "no_sidecar_and_editor_offline"}`); 9 traversal verbs per amendment §Traversal verb surface — `bp_list_graphs`, `bp_list_entry_points`, `bp_trace_exec` (with Sidecar Design Q2 `via_knots` annotation), `bp_trace_data`, `bp_show_node`, `bp_neighbors`, `bp_subgraph_in_comment`, `bp_find_in_graph`. Deferred to v1.1: `bp_paths_between` per amendment.
- Tests: `test-sidecar-verbs.mjs` suite with synthetic sidecar fixtures + one ProjectA real-sidecar integration test.

**M2-Phase-B — dump_graph TCP + TCP-invocable prime** (1-2 sessions, post-M1):
- 3F-1 `dump_graph` TCP handler — accepts `bp_path`, walks the editor's deserialized `UEdGraph` for named graphs, emits JSON per amended schema. Errors: BP not found, BP fails to load, named graph not found.
- TCP-invocable `prime_bp_cache` for agent-driven priming (same C++ iteration as 3F-3 editor-menu command, exposed as TCP command).
- Tests: TCP integration tests against a running editor with a fixture BP.

**M3 — Oracle retirement** (6-10 sessions, sub-parallelizable into M3a/M3b/M3c):
- All 32 transitional tools (`actors`/`blueprints-write`/`widgets`) rebuilt on TCP:55558 per `docs/specs/phase3-plugin-design-inputs.md` P0-1 through P0-11.
- Per advisor framing: **rebuild with quality upgrades**, not new TCP API design. Handler contracts documented in `docs/specs/conformance-oracle-contracts.md`.
- M3a (actors, 2-3 sessions): 10 tools + P0-2 (FindActorInAllLevels) + P0-3 (label resolution) + P0-4 (struct/vector/object props) applied.
- M3b (blueprints-write, 3-4 sessions): 15 tools + P0-5 (compile error reporting) + P0-6 (FScopedTransaction) + P0-11 (pin type validation).
- M3c (widgets, 2-3 sessions): 7 tools + P0-7 (widget path standardization) + P0-8 (valid binding function graph).
- Landing milestone: D40 oracle retirement — single-commit yaml flip changes `layer: tcp-55557` → `layer: tcp-55558` across all three toolsets.
- TS-1 and TS-2 resolved in the yaml flip (see §Q6).

**M4 — Reduced read tools** (3-5 sessions):
- `blueprint-read` (6 reduced): `get_blueprint_info`, `get_blueprint_variables`, `get_blueprint_functions`, `get_blueprint_components`, `get_blueprint_event_dispatchers`, `get_niagara_system_info`. Plus widget-tree subset of `get_widget_blueprint`.
- `asset-registry` (2 reduced): `get_asset_references` (reverse-ref via `IAssetRegistry::GetReferencers`), `get_datatable_contents` (engine-struct-keyed + cooked cases).
- `data-assets` (4 reduced): `list_data_asset_types`, `get_curve_asset`, `get_string_table`, `get_struct_definition`.
- Each tool hits only the retained (reflection-only / compiled / runtime) surface — offline displacers cover the rest.

**M5 — Remaining Phase 3 toolsets** (6-10 sessions, 3-4 sub-workers):
- Sub-worker 1 (animation, 2-3 sessions): 3 writes + 5 reduced reads per §Q1.4.
- Sub-worker 2 (materials, 2 sessions): 3 writes + 2 reads per §Q1.5.
- Sub-worker 3 (geometry + input-and-pie + editor-utility, 2-3 sessions): write + runtime-control tools per §Q1.7-9.
- Sub-worker 4 (visual-capture, 1-2 sessions): 5 rendering tools per §Q1.10.

**M6 — Optional S-B** (6-9 sessions, oracle-gated on M2):
- Per §Q4 priority order: CallFunction first, then VariableGet/Set, then Event/CustomEvent, then control-flow, then remaining.
- Validation oracle: each K2Node's parsed pin-edge set must match the sidecar JSON's `LinkedTo` data for the same node-ID.
- Commission only if D52 near-parity goal is under-served by sidecar alone OR agent-automation workflows surface pressure for pure-offline pin-trace.

### §Q5.4 Parallelism opportunities

| Parallel pair | Why safe |
|---------------|----------|
| M1 ↔ M2-Phase-A | Phase A has no TCP dependency; M1 is scaffold-only; surfaces don't overlap (M1 in `plugin/` C++; M2-Phase-A splits between `plugin/` save-hook and `server/offline-tools.mjs` JS) |
| M3 ↔ M4 | M3 rebuilds transitional tools; M4 builds new reduced reads. Different `UEMCP*Commands.cpp` files (M3a in `UEMCPActorCommands.cpp`, M4 in `UEMCPBlueprintReadCommands.cpp` etc.). |
| M3 ↔ M5 | Different command-handler files; M3 touches actors/bp-write/widgets; M5 touches animation/materials/etc. |
| M4 ↔ M5 | Different command-handler files. |
| M3a ↔ M3b ↔ M3c | Within M3, separate handler files (`UEMCPActorCommands`, `UEMCPBlueprintCommands`, `UEMCPUMGCommands`); 3A infrastructure already shared via M1. |
| M5 sub-workers | Each toolset has its own `UEMCP<Toolset>Commands.cpp` per yaml naming convention. |

**D49 discipline applies**: path-limited commits mandatory for all parallel dispatches.

### §Q5.5 Cost summary

| Scenario | Total sessions (range) | Wall-clock with parallelism |
|----------|------------------------|------------------------------|
| M0-M5 only (no S-B) | 22-37 | 12-20 sessions |
| M0-M5 + M6 | 28-46 | 18-29 sessions (M6 tail-sequential) |

Confidence: **MEDIUM-HIGH** on M0, M2-Phase-A, M4 cost ranges (well-specified from Sidecar Design Session + §Q1 displacement); **MEDIUM** on M1, M3, M5 (depends on plugin C++ discovery cost — CLAUDE.md notes `plugin/` is "empty scaffold" today); **MEDIUM** on M6 (per §Q4 refinement).

---

## §Q6 Tool-surface cleanup (TS-1/TS-2/TS-3)

Per backlog.md + §Q1:

| Item | Disposition | When |
|------|-------------|------|
| **TS-1** — `actors.take_screenshot` ↔ `visual-capture.get_viewport_screenshot` duplication | **FOLD-INTO M3 oracle retirement**. When the actors toolset rebuilds on 55558, drop `take_screenshot` from yaml. `visual-capture.get_viewport_screenshot` (inline base64 PNG) is the canonical interface. Yaml already flags as Legacy. | M3 |
| **TS-2** — `widgets.add_widget_to_viewport` NO-OP | **FOLD-INTO M3 oracle retirement**. When widgets rebuilds on 55558, remove from yaml entirely (or repurpose as `get_widget_class_path` with informational description per D27). Handler is a no-op; removing it prevents Claude from expecting real viewport-add behavior. | M3 |
| **TS-3** — `editor-utility.create_asset` scope review | **DROP in M0 yaml grooming** per §Q1.9. Zero catalog demand; domain-specific creators cover real workflows. | M0 |

No standalone cleanup pass needed. All three resolve as part of the Phase 3 dispatch.

---

## §Framing-audit notes

### §FA-1 Handoff claim "cost could collapse to ~4-6 sessions" (S-B)

**Concern**: handoff §"Skeletal-subset S-B is a new-research angle" states "If pin data is only needed for the 19 shipped skeletal K2Node types — most of which inherit base-class Serialize — cost could collapse to ~4-6 sessions."

**Finding**: the 19-type restriction collapses per-node override cost (Agent 11.5's 2 sessions → ~1 session since UK2Node_MathExpression is excluded and only CallFunction backcompat + Switch regeneration have override surface in skeletal). It does NOT collapse:
- Base pin-block RE (3-4 fixed sessions reverse-engineering `UEdGraphNode::Serialize()`).
- LinkedTo resolution (1-2 fixed sessions for pin-ID graph walker).
- Version-skew buffer (2-3 sessions for 5.6 ↔ 5.7 format shifts — partially collapsible but not zero).

**Honest range**: 6-9 sessions (§Q4.1 breakdown). The 4-6 claim requires every buffer to simultaneously collapse, which the reference-coverage evidence (zero-reference on pin binary block per Agent 11.5 §2.2) does not support.

**Impact**: §Q4 verdict PURSUE-AFTER-SIDECAR still holds — the refined cost is still competitive under D52. But orchestrator should dispatch M6 (if commissioned) with the 6-9 range budget, not 4-6, or risk blowing session count.

### §FA-2 Widget-tree hierarchy is UMG/Slate, not UEdGraph

**Concern**: my initial read treated `blueprint-read.get_widget_blueprint` as a clean MOVE-TO-SIDECAR. The yaml description says "Widget hierarchy tree (designer view), property bindings, plus standard EventGraph and functions." The **designer view** (widget hierarchy + property bindings) is UMG/Slate data — separate node hierarchy from UEdGraph. Sidecar Design Session Q4 explicitly deferred widget traversal to v1.1+ ("Parent spec's `get_material_graph` is the material read interface; defer v1.1+ on workflow-demand signal" — same pattern applies to widget designer).

**Finding**: `get_widget_blueprint` splits by sub-scope:
- **EventGraph + functions** (UEdGraph, UBlueprint subclass) → **MOVE-TO-SIDECAR** (3F dump_graph on UWidgetBlueprint, covered by 3F-1).
- **Widget hierarchy tree + property bindings** (UMG/Slate) → **KEEP (reduced) plugin-TCP**. Offline can partially cover via `read_asset_properties` on widget slot exports, but the tree-walk + named-binding metadata needs editor reflection (D52 category (d)).

**Impact**: §Q1.2 table updated to SPLIT disposition. M4 scope explicitly carves the widget-tree-only surface into the plugin-TCP tool. Sidecar schema does NOT need to extend to widget-tree in v1 (matches Sidecar Design Q4's defer-on-workflow-signal pattern).

### §FA-3 9 traversal verbs are new **offline** tools, not plugin scope

**Concern**: handoff focuses on plugin-TCP displacement. Easy to lose that the sidecar milestone (§Q3) ships **9 new offline tools** on the consumer side — these are the bulk of workflow unlock from 3F, not the plugin-side save-hook.

**Finding**: per Sidecar Design Session §"What belongs in offline tools (consumer side)", the traversal verbs `bp_list_graphs`, `bp_list_entry_points`, `bp_trace_exec`, `bp_trace_data`, `bp_show_node`, `bp_neighbors`, `bp_subgraph_in_comment`, `bp_paths_between` (v1.1), `bp_find_in_graph` all land in `server/offline-tools.mjs` alongside `find_blueprint_nodes`. They consume sidecar JSON; they don't call TCP.

**Impact**: §Q3 ("Implementation implications") and §Q5 M2-Phase-A explicitly note this. Orchestrator should track these as 9 new yaml entries under `offline:` (not under `layer: tcp-55558` toolsets) when M2-Phase-A dispatches. Workflow catalog rows 9/10/13/16/30 + Agent 11.5 §4.3 rows 5-7 close via these verbs, not via plugin TCP.

### §FA-4 Handoff's "120 tools" count is approximate

**Concern**: CLAUDE.md states "120 tools across 15 toolsets + 6 always-loaded management tools." My audit shows: 16 offline + 32 tcp-55557 + 63 tcp-55558 + 8 http-30010 + 6 management = 125 total. Minor discrepancy.

**Finding**: count drift is consistent with D51 yaml dual-role (stubs counted or not). Not load-bearing for scope decisions.

**Impact**: zero. Flag for CLAUDE.md maintenance pass if/when next grooming happens.

### §FA-5 `list_gameplay_tags_runtime` DROP is a judgment call, not a hard elimination

**Concern**: §Q1.1 drops `list_gameplay_tags_runtime`. Offline `list_gameplay_tags` + `search_gameplay_tags` cover project-config-file-sourced tags. But live-editor tag state (tags added via editor UI mid-session, unsaved) is not covered.

**Finding**: D52 category (a) "runtime/PIE state" could legitimately KEEP this tool. The DROP rationale is workload-based: catalog rows 40/73 (HIGH frequency tag queries) serve via offline; no catalog row asks for live-mid-edit tag state. If a workflow emerges needing live tag state, reopen — cheap to re-add (RC API Phase 4 could cover).

**Impact**: DROP recommendation holds but is orchestrator-reversible. Flag in M0 yaml grooming commit message so future agents can trace the disposition reasoning.

### §FA-6 M6 (S-B) is OPTIONAL, not implicitly-scheduled

**Concern**: D52's weakened reopening trigger creates a reading where S-B is now "expected." That over-reads D52.

**Finding**: D52 makes S-B *defensibly commissionable*, not *default-scheduled*. The decision to commission M6 should be deliberate — trigger is still "workflow pressure accumulates OR 3F slips," both of which are empirical observations post-M2 landing.

**Impact**: §Q5 marks M6 as OPTIONAL. Orchestrator makes the call post-M2.

---

## §Appendix A — Input files consulted

### Tier 1 — Scope inputs
- `tools.yaml` (lines 52-859) — full toolset enumeration, 114 toolset tools + 6 management.
- `docs/specs/phase3-plugin-design-inputs.md` — P0-1 through P0-11 residues + 3A-3E buckets.
- `docs/research/sidecar-design-resolutions-2026-04-19.md` — Sidecar Design Session Q1-Q5 resolutions + §2 downstream impact on Phase 3 scope refresh.
- `docs/specs/blueprints-as-picture-amendment.md` — original 3F spec with 5 open questions.

### Tier 2 — Shipped-state inputs
- `docs/research/level12-tool-surface-design.md` (Agent 9) — Option C hybrid + §3 Phase 3 scope diff (projected 13 tools reduced/eliminated pre-Agent-10-5; this research re-ran against shipped state).
- `docs/research/level3-feasibility-study.md` (Agent 11) — L3A EDITOR-ONLY verdict + L3B FOLD-INTO-L2.5 + L3C KEEP-DEFERRED.
- `docs/research/level3a-skeletal-parse-study.md` (Agent 11.5) — S-A PURSUE (shipped) + S-B FOLD-INTO-3F (reopened per §Q4).
- `docs/research/agent-workflow-catalog.md` + §7a amendment — 100-query catalog with coverage classification.
- `server/offline-tools.mjs` verified via grep — 16 offline tools + 19 K2Node classes (17 non-delegate + 2 delegate-presence per D48 as-shipped) in `find_blueprint_nodes` switch.

### Tier 3 — D-log anchors
- D32 Phase 3 TCP scope reduction (registry tools off TCP).
- D37 `inspect_blueprint` + `list_level_actors` offline shipping (first displacement).
- D39 Level 1+2 parser before Phase 3 C++ plugin (Agent 10 scheduling).
- D45 L3A full-fidelity EDITOR-ONLY; 3F sidecar with soft editor dependency.
- D48 S-A PURSUE + S-B FOLD-INTO-3F; 19 K2Node types shipped (17+2).
- D50 tagged-fallback supersedes D47 two-pass design; 601 unique structs decode.
- D51 tools.yaml dual-role (shipped + planning).
- D52 near-plugin-parity for offline reads; plugin scope shrinks per four justification categories; S-B reopening trigger weakened.

### Tier 4 — State audits
- `docs/audits/post-agent10-5-codebase-audit-2026-04-19.md` (Audit A) — post-wave-4 health; EN-5 lint gap; 709 → 783 → 825 baseline progression.
- `docs/audits/goal-alignment-audit-2026-04-17.md` (Audit B) — D51 yaml dual-role finding; Phase 3 readiness YELLOW; §4 unblockers list; §6 Q2 EN-2 prioritization question.

### Tier 5 — Backlog + in-flight
- `docs/tracking/backlog.md` — DR-1/DR-2/DR-3; TS-1/TS-2/TS-3; EN-1 through EN-5.
- `docs/handoffs/orchestrator-state-2026-04-20.md` — pre-compaction state; D52/layered-parity framing; S-B new-research angle.

### Tier 6 — Post-EN-2 verification
- `git log --oneline -15` — confirmed HEAD `66937c0` (handoff queue commit, one past `ae7fb96` EN-2 final report). Clean working tree.
- Test baseline 825 per CLAUDE.md; not re-run (handoff §Tier-6 optional — feedback_handoff_empirical_verification.md applies to workers pivoting design, not research synthesis).

---

## §Appendix B — Unanswered Sidecar Design open questions reopened here

Sidecar Design Session resolved Q1-Q5 cleanly. Two downstream questions this research surfaces without resolving (non-blocking for Phase 3 dispatch):

- **BL-candidate widget-tree sidecar extension** (per §FA-2): should the sidecar schema extend to UMG designer data in v1.1, parallel to the AnimBP state-machine inline pattern (Sidecar Design Q3)? Defer until widget-traversal workflow demand surfaces.
- **BL-candidate S-B priority node ordering** (per §Q4.5): if M6 commissions, should it ship as sub-milestones (priority 1-3 first as ~3-4 sessions, priority 4-7 as follow-on ~3-5 sessions)? Orchestrator decision at M6 dispatch time.

---

## §Appendix C — Confidence

**Overall: HIGH** on §Q1 DROP/MOVE/KEEP dispositions (each grounded in a named D-log entry or input file), **MEDIUM-HIGH** on §Q2 D52 category assignments (category (a) and (b) are unambiguous; (c) and (d) have some overlap that doesn't affect decisions), **HIGH** on §Q3 SHIP-SIDECAR-PHASE-A-FIRST (advisor-refined into Phase A / Phase B split with clean dependency separation), **MEDIUM-HIGH** on §Q4 PURSUE-AFTER-SIDECAR (verdict defensible; cost range honest per §FA-1), **MEDIUM** on §Q5 cost ranges (M1/M3/M5 depend on plugin C++ discovery cost — `plugin/` is empty scaffold today; M0/M2/M4 well-specified).

**Grounded vs speculative**:
- GROUNDED: §Q1 all dispositions (Agent 9/10/10.5 shipped evidence + D-log anchors + catalog classification + offline tool verification via grep).
- GROUNDED: §Q3 Phase A / Phase B split (advisor confirmation against Sidecar Design Session §2 downstream impact).
- GROUNDED: §Q4 cost-refinement analysis (Agent 11.5 §2.3 breakdown × 19-type restriction analysis).
- SPECULATIVE: §Q5 M1/M3/M5 cost ranges (plugin C++ discovery cost is unmeasured — `plugin/` directory is empty per CLAUDE.md Phase 3 state). Direction (medium-to-large scope) is confident; magnitude has ±30% variance bound.
- SPECULATIVE: §Q5 parallelism benefits (file-surface separation is clean but cross-cutting C++ build/link issues could serialize work in practice).

**Did-not-do-but-could-have**:
- Did not re-run the primary test rotation (handoff §Tier-6 optional). CLAUDE.md 825 baseline accepted as current.
- Did not grep the UE 5.6 `Engine/Source/Editor/BlueprintGraph/Classes/K2Node_*.h` headers directly to enumerate `Serialize()` overrides exactly. §Q4.2 table uses Agent 11.5 §2.3's "estimated 4-6 K2Nodes" plus public UE knowledge. If M6 is commissioned, a narrow spike should verify the override list before budgeting.
- Did not inspect `docs/specs/conformance-oracle-contracts.md` directly — relied on §Q1.11 advisor framing that handler contracts are documented there. If M3 is dispatched, a secondary pass against that doc would tighten the cost estimate.

---

## §Final Report

```
Phase 3 Scope Refresh — Final Report

Dispositions (Q1):
  DROP:            6 tools (search_assets, get_class_hierarchy, get_asset_metadata,
                            get_data_asset_properties, list_gameplay_tags_runtime,
                            create_asset)
  MOVE-TO-SIDECAR: 3 tools (get_blueprint_graphs, get_animbp_graph,
                            EventGraph subset of get_widget_blueprint)
  KEEP (reduced):  18 new-Phase-3 tools + actors static subset annotated
  KEEP (full):     35 write + runtime-control + unique-editor-dependent tools
  Transitional:    32 tools rebuild on 55558 per D23/D40 oracle retirement
  Net plugin-TCP:  ~86 tools (down from ~95)
  New offline:     9 sidecar traversal verbs (M2-Phase-A consumer surface)

Plugin-only justifications (Q2): all 54 new KEEPs map to D52 categories
  (a) runtime/PIE state:          11 tools
  (b) UEdGraph pin topology:       5 tools (all MOVE-TO-SIDECAR or sidecar-subset)
  (c) compiled/derived data:       14 tools
  (d) reflection-only metadata:    8 tools
  (w) write ops:                   35 tools (self-justifying)
  Defensibility: 0 rows fail D52 check

DR-3 verdict (Q3): SHIP-SIDECAR-PHASE-A-FIRST
  Phase A (no 3A dep):    save-hook + prime (editor menu) + offline reader + 9 verbs
  Phase B (post-M1):      dump_graph TCP + TCP-invocable prime
  Dominant trade-off: agent-productivity via early L2 availability

S-B verdict (Q4): PURSUE-AFTER-SIDECAR (optional M6)
  Cost:  6-9 sessions (honest range; handoff's 4-6 claim is aspirational per §FA-1)
  Oracle dependency: sidecar JSON for byte-level validation
  Trigger: D52 weakened — aligned with near-parity goal without crisis
  Start with UK2Node_CallFunction (highest instance count + workflow value)

Sequencing (Q5):
  M0 yaml grooming (0.5 session)
    → M1 3A scaffolding (3-5)  ∥  M2-Phase-A sidecar save-hook + verbs (3-5)
       → M2-Phase-B dump_graph TCP (1-2)
         → M3 oracle retirement (6-10, 3-way sub-parallel)
         ∥ M4 reduced reads (3-5)
         ∥ M5 remaining toolsets (6-10, 3-4 sub-parallel)
    → [optional M6] S-B pin-trace (6-9, oracle-gated on M2)
  Total (excl M6): 22-37 sessions, wall-clock 12-20 with parallelism
  Total (incl M6): 28-46 sessions, wall-clock 18-29

Tool-surface cleanup (Q6):
  TS-1 take_screenshot dedupe:  FOLD-INTO M3
  TS-2 add_widget_to_viewport:  FOLD-INTO M3
  TS-3 create_asset:            DROP in M0

Framing concerns:
  FA-1 S-B cost 4-6 claim is aspirational; honest 6-9
  FA-2 widget-tree ≠ UEdGraph; SPLIT disposition
  FA-3 9 traversal verbs are new OFFLINE tools (not plugin scope)
  FA-4 "120 tools" CLAUDE.md count is approximate (125 actual)
  FA-5 list_gameplay_tags_runtime DROP is judgment call
  FA-6 M6 is OPTIONAL, not default-scheduled

Orchestrator-actionable: YES — M0 can dispatch immediately as yaml-grooming worker
  with §Q1 table as the authoritative disposition sheet.

Confidence: HIGH on Q1/Q3/Q6; MEDIUM-HIGH on Q2/Q4; MEDIUM on Q5 cost ranges
  (plugin C++ discovery cost unmeasured — plugin/ directory empty).

Deliverable: docs/research/phase3-scope-refresh-2026-04-20.md
```
