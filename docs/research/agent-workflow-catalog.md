# Agent Workflow Catalog — UE Project Queries vs UEMCP Coverage

> **Author**: Agent Workflow Catalog researcher
> **Date**: 2026-04-16
> **Type**: Research — query catalog + coverage cross-reference; no design authorship, no code, no D-log allocation
> **Inputs**: `tools.yaml` (shipped + planned), `CLAUDE.md` (current state), Agent 9 (`docs/research/level12-tool-surface-design.md`), Agent 11.5 (`docs/research/level3a-skeletal-parse-study.md`), D30/D32/D37/D45/D46/D47/D48, `docs/specs/blueprints-as-picture-amendment.md`, `docs/specs/conformance-oracle-contracts.md`
> **Scope question**: Noah articulated the "offline reads are first-class" principle (2026-04-16). No document enumerates which questions CLI-agent work against a UE project actually asks. This catalog closes that gap. It is **not** a design doc.

---

## §1 Purpose and method

This catalog enumerates ~90 realistic queries a code-writing CLI agent (Claude Code or similar) wants to run against a UE 5.x project during normal development. For each query, it cites what the ideal answer shape looks like and whether current UEMCP tooling — as shipped through Agent 10 (HEAD `9144664`) — serves it. Coverage is classified **strictly by shipped state** (see §2.0 classification rules). Gaps feed future tool-surface decisions (Phase 3 plugin scope refresh, sidecar write discipline, consolidation opportunities). Queries are grounded in two concrete workflow corpora:

- **Agent 9 §1 anchors**: three workflows Level 1+2 was built to solve (level placement, CDO defaults, hard-ref walk). Rows 1/6/17 in §2 exercise these directly — they validate that SERVED_OFFLINE classifications are real.
- **Agent 11.5 §4.3 anchors**: seven workflow rows splitting find/grep vs trace/spatial. Rows 26–32 in §2 mirror those. They are the demand signal that gates S-A (scheduled in Agent 10.5) and 3F sidecar (Phase 3).

Per Noah's constraint, this document does not propose tools. It flags what works, what partially works, what belongs to the plugin, and what nobody has solved yet.

---

## §2 Query catalog

### §2.0 Classification rules

- **SERVED_OFFLINE** — a shipped offline tool answers the query directly today (13 offline tools + 6 management). Read/Grep/Glob via Claude Code count here per D31, flagged in the tool cell.
- **SERVED_PARTIAL** — offline tooling answers part of the query; the remainder needs plugin or sidecar. Example: `inspect_blueprint` gives AnimBP exports but not state-machine transitions.
- **SERVED_PLUGIN_ONLY** — the query is genuinely editor-dependent (runtime state, reflection-only metadata, UEdGraph edges). Subdivided by note: `[oracle]` = currently served by UnrealMCP TCP:55557 as transitional oracle (D23); `[phase3]` = scheduled for custom plugin on TCP:55558; `[sidecar]` = needs 3F sidecar (D45 soft editor dependency); `[RC]` = Remote Control HTTP:30010.
- **NOT_SERVED** — no current or planned tool covers this. Gap note describes why and, if relevant, whether offline coverage is theoretically reachable.

Frequency (HIGH/MEDIUM/LOW) reflects my estimate of how often an active agent session against an ProjectA-shaped UE project hits the query. Estimates are subjective; see §8.

### §2.1 Introspection — "why does this BP do X?"

| #  | Query                                                                       | Ideal answer shape                                                  | Coverage           | Tool(s)                                                                                        | Freq | Gap notes                                                                                                                                             |
|----|-----------------------------------------------------------------------------|---------------------------------------------------------------------|--------------------|------------------------------------------------------------------------------------------------|------|-------------------------------------------------------------------------------------------------------------------------------------------------------|
| 1  | List placed actors in `Level_Combat.umap` with their world positions        | `[{name, className, transform: {location, rotation, scale}}, ...]`  | SERVED_OFFLINE     | `list_level_actors`                                                                            | HIGH | Agent 9 §1 anchor #1. Verified by Agent 10 ship.                                                                                                      |
| 2  | What's the parent class of `BP_OSControlPoint`?                              | Class name string                                                   | SERVED_OFFLINE     | `inspect_blueprint` (parent_class field)                                                       | HIGH |                                                                                                                                                       |
| 3  | What events does `BP_OSPlayerR` handle? (BeginPlay, Tick, custom events)    | Event list with names                                               | NOT_SERVED         | —                                                                                              | HIGH | Needs per-K2Node UPROPERTY read of `UK2Node_Event.EventReference`. Scheduled in Agent 10.5 as S-A (D48 Tier S-A).                                      |
| 4  | What functions does `BPGA_Block` define, with signatures?                    | `[{name, params, return_type, flags}, ...]`                         | SERVED_PARTIAL     | `inspect_blueprint` (gives Function export names)                                              | HIGH | Function exports are structural only — no parameter/return-type signatures offline. Full signatures need editor reflection: `blueprint-read.get_blueprint_functions` [phase3]. |
| 5  | What variables does `BP_OSPlayer` have and their default values?             | `{varName: value}` per UPROPERTY                                    | SERVED_OFFLINE     | `inspect_blueprint` with `include_defaults=true`, or `read_asset_properties` on CDO            | HIGH | Scalars, 10 engine structs, simple-element TArray/TSet supported. Custom structs + TMap + complex containers return `{unsupported}` markers — Agent 10.5 extends. |
| 6  | What's the default Damage/Cooldown on ability `BPGA_Fireball`?               | Scalar values from CDO                                              | SERVED_OFFLINE     | `read_asset_properties` or `inspect_blueprint include_defaults`                                | HIGH | Agent 9 §1 anchor #2. Verified.                                                                                                                        |
| 7  | What components are attached to `BP_OSPlayerR`?                              | SCS hierarchy tree                                                  | SERVED_PARTIAL     | `inspect_blueprint` (component exports) + `read_asset_properties` on SCS nodes                 | HIGH | Component exports + default property values readable offline. Live attach-via-script components still need `blueprint-read.get_blueprint_components` [phase3]. |
| 8  | What gameplay tags does `BPGA_Block` grant?                                  | Tag list (e.g., `[Gameplay.State.Blocking]`)                        | SERVED_OFFLINE     | `read_asset_properties` on CDO, filter `AbilityTags` / `GrantedTags`                           | HIGH | Level 2 FGameplayTagContainer handler covers this.                                                                                                    |
| 9  | What does `ReceiveDamage` do on `BP_OSPlayerR`? (trace exec chain)          | Tree of exec-connected nodes                                        | SERVED_PLUGIN_ONLY [sidecar] | `bp_trace_exec` (3F amendment)                                                      | HIGH | Agent 11.5 §4.3 row "trace chain." Pin edges needed; zero-reference for offline per D48 Tier S-B.                                                     |
| 10 | Show me the function body of `OnTakeDamage`                                  | Node+edge dump or rendered sequence                                 | SERVED_PLUGIN_ONLY [sidecar] | `get_blueprint_graphs`, `bp_trace_exec`, `dump_graph`                                | MEDIUM | Graph-edge territory; L2 sidecar.                                                                                                                     |
| 11 | What interfaces does `BP_OSPlayerR` implement?                               | Interface class name list                                           | SERVED_PARTIAL     | `inspect_blueprint` (interfaces via AR tag `ImplementedInterfaces`)                            | MEDIUM | AR tag gives names; full interface descriptor (functions expected) needs `blueprint-read.get_blueprint_info` [phase3].                                 |
| 12 | Does `BP_Fireball` override `CanActivateAbility`?                            | Boolean + function body                                             | SERVED_PARTIAL     | `inspect_blueprint` lists Function exports                                                     | HIGH | Agent 11.5 §4.3 row. Name-only override detection (presence of Function export) works structurally; confirming the override is non-trivial + semantic matching is S-A territory. |
| 13 | What's inside the "Damage Handling" yellow comment box in `BP_OSPlayerR`?   | Node list contained by comment                                      | SERVED_PLUGIN_ONLY [sidecar] | `bp_subgraph_in_comment`                                                             | MEDIUM | Agent 11.5 §4.3 row "spatial." Point-in-rect on positions = sidecar-only.                                                                             |
| 14 | What mesh/material does `BP_Sword` reference?                                | `/Game/...` path set                                                | SERVED_OFFLINE     | `read_asset_properties` (FSoftObjectPath / ObjectProperty walk on CDO)                         | HIGH | Agent 9 §1 anchor #3. Hard-ref subset covered.                                                                                                        |
| 15 | What attribute set does `BP_Character` use?                                  | AttributeSet class name + initial values                            | SERVED_OFFLINE     | `read_asset_properties` on CDO — scans AttributeSet ObjectProperty                             | MEDIUM | Initial values on the referenced AttributeSet require a second `read_asset_properties` call.                                                          |
| 16 | Show me event graph of `W_MainMenu` (UMG widget)                             | Full node+edge dump                                                 | SERVED_PLUGIN_ONLY [sidecar] | `get_widget_blueprint` [phase3] + sidecar                                            | LOW | Widget-tree spatial layout = sidecar territory.                                                                                                       |
| 17 | What animations are in `AM_Combat_Combo`?                                    | Sections, notifies, slot names, lengths                             | SERVED_PARTIAL     | `read_asset_properties` (scalar section times, notify names)                                   | MEDIUM | Structural data readable offline. Slot machinery + evaluated blend settings want `animation.get_montage_full` [phase3].                                |
| 18 | What input action does `IA_Jump` map to in the default mapping context?      | Key list per context                                                | SERVED_PARTIAL     | `read_asset_properties` on IMC asset                                                           | MEDIUM | Enhanced Input mapping data exists as TArray<FEnhancedActionKeyMapping> — complex struct in container, partially readable via Agent 10.5 D46+D47 scope. |
| 19 | What's the starting montage section of `AM_BowAttack`?                       | String section name                                                 | SERVED_OFFLINE     | `read_asset_properties`                                                                        | LOW  |                                                                                                                                                       |
| 20 | What's the value of `GravityZ` in the DefaultGame.ini?                       | Float value                                                          | SERVED_OFFLINE     | `list_config_values`                                                                            | MEDIUM | Progressive drill-down: `list_config_values()` → files → sections → values.                                                                           |

### §2.2 Impact analysis — "what depends on this?"

| #  | Query                                                                       | Ideal answer shape                             | Coverage           | Tool(s)                                                                 | Freq | Gap notes                                                                                                                                                 |
|----|-----------------------------------------------------------------------------|------------------------------------------------|--------------------|-------------------------------------------------------------------------|------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| 21 | What references `/Game/Meshes/Sword.uasset`?                                | List of referencing asset paths                | NOT_SERVED         | —                                                                       | HIGH | Reverse-reference query. Offline forward walks are cheap (`read_asset_properties`); reverse requires either full-project scan or the editor's `IAssetRegistry::GetReferencers`. Planned: `asset-registry.get_asset_references` [phase3]. |
| 22 | What does `BP_Sword` reference? (forward dependency list)                   | List of `/Game/...` referenced                 | SERVED_OFFLINE     | `read_asset_properties` walking FSoftObjectPath + ObjectProperty        | HIGH | Agent 9 §1 anchor #3. Hard-ref subset.                                                                                                                     |
| 23 | Which BPs inherit from `UOSGameplayAbility`?                                | Class-child list                               | SERVED_OFFLINE     | `query_asset_registry class_name:Blueprint tag_key:ParentClass tag_value:...` | HIGH | AR tag walk. Eliminated Phase 3 `asset-registry.get_class_hierarchy` per D37.                                                                              |
| 24 | What abilities grant the gameplay tag `State.Stunned`?                      | Ability asset list                             | SERVED_PARTIAL     | `query_asset_registry class_name:Blueprint` then `read_asset_properties` loop | MEDIUM | AR tags index class/parent — not tag membership on CDO. Requires per-asset CDO read loop offline. Pattern works; throughput modest (~500 BPs × 20ms parse). |
| 25 | Is `BP_UnusedAbility` safe to delete? (any references?)                     | List of referrers; empty if safe               | NOT_SERVED         | —                                                                       | MEDIUM | Reverse-ref problem per #21.                                                                                                                               |
| 26 | Which BPs call `ApplyGameplayEffectToTarget`?                                | BP asset list + call-site node IDs             | NOT_SERVED         | —                                                                       | HIGH | Agent 11.5 §4.3 row 1. Scheduled as S-A in Agent 10.5. Today must scan 3F sidecars if present, or fall through to editor.                                 |
| 27 | List BPs that handle `ReceiveBeginPlay`                                     | BP asset list                                  | NOT_SERVED         | —                                                                       | HIGH | Agent 11.5 §4.3 row 2. S-A territory.                                                                                                                      |
| 28 | Which BPs read variable `bIsInCombat`?                                       | BP asset list + node IDs                       | NOT_SERVED         | —                                                                       | MEDIUM | Agent 11.5 §4.3 row 3. S-A territory.                                                                                                                      |
| 29 | CI: audit which BPs override `CanActivateAbility`                           | BP asset list                                  | SERVED_PARTIAL     | `query_asset_registry class_name:Blueprint` + `inspect_blueprint` per asset | MEDIUM | Agent 11.5 §4.3 row 4. Name-only override (Function export named CanActivateAbility) works today by scanning export tables. Semantic override confirmation wants S-A. |
| 30 | Trace variable `CurrentHealth` backward to every defining write             | Write-site graph                               | SERVED_PLUGIN_ONLY [sidecar] | `bp_trace_data` direction=back                                 | MEDIUM | Agent 11.5 §4.3 row 7. Pin edges required.                                                                                                                |
| 31 | Which levels contain `AEnemyPawn` instances?                                | `.umap` paths + actor counts                   | SERVED_PARTIAL     | `query_asset_registry class_name:Blueprint path_prefix:/Game/Maps` + `list_level_actors summarize_by_class` loop | MEDIUM | Two-step workflow. Works but clunky. Could consolidate.                                                                                                   |
| 32 | What skeletal meshes does the project use across all BPs?                   | Referenced SK path set                         | SERVED_PARTIAL     | Forward-walk aggregation via `read_asset_properties` across BP CDOs     | LOW  | Works as a scan; no consolidated tool.                                                                                                                     |
| 33 | Before I rename variable `MaxHealth`, find readers + writers                | Call-site list with read/write flag            | NOT_SERVED         | —                                                                       | MEDIUM | S-A covers find; distinguishing get vs set needs S-A per-node-class dispatch (UK2Node_VariableGet vs VariableSet). In S-A scope.                           |
| 34 | Which BPs implement interface `BPI_Damageable`?                              | BP asset list                                  | SERVED_OFFLINE     | `query_asset_registry` tag filter on `ImplementedInterfaces` AR tag     | MEDIUM | AR tag is populated by the cooker/editor — presence-only. Works for most cases.                                                                           |
| 35 | Which assets reference material `M_Stone`?                                  | Asset list                                     | NOT_SERVED         | —                                                                       | MEDIUM | Reverse-ref per #21.                                                                                                                                      |

### §2.3 Scan / grep — "which BPs use component Y?"

| #  | Query                                                                       | Ideal answer shape                   | Coverage           | Tool(s)                                                                                   | Freq | Gap notes                                                                                                                                                 |
|----|-----------------------------------------------------------------------------|--------------------------------------|--------------------|-------------------------------------------------------------------------------------------|------|-----------------------------------------------------------------------------------------------------------------------------------------------------------|
| 36 | Find all BPs under `/Game/GAS/Abilities/`                                   | Asset path list                      | SERVED_OFFLINE     | `query_asset_registry class_name:Blueprint path_prefix:/Game/GAS/Abilities`                | HIGH |                                                                                                                                                           |
| 37 | List all DataTables in the project                                          | Asset path list                      | SERVED_OFFLINE     | `query_asset_registry class_name:DataTable` (short-name match per D38/F6)                  | MEDIUM |                                                                                                                                                           |
| 38 | Find all Widget Blueprints                                                  | Asset path list                      | SERVED_OFFLINE     | `query_asset_registry class_name:WidgetBlueprint`                                          | MEDIUM |                                                                                                                                                           |
| 39 | Find all UStructs used by DataTables                                        | Unique struct-class set              | SERVED_PARTIAL     | `query_asset_registry class_name:DataTable` + AR tag `RowStructure`                        | LOW  | Likely readable from AR tags; needs verification on ProjectA fixtures.                                                                                     |
| 40 | List every gameplay tag under `Gameplay.State.*`                            | Tag hierarchy slice                  | SERVED_OFFLINE     | `search_gameplay_tags pattern:"Gameplay.State.*"`                                          | HIGH |                                                                                                                                                           |
| 41 | Find all actors in the project of class `AEnemyPawn`                        | Per-level actor list                 | SERVED_PARTIAL     | `query_asset_registry class_name:World` + `list_level_actors` loop                         | LOW  | Multi-step; no consolidated tool. Live-state lookup = `actors.find_actors` [oracle/phase3] but only current level.                                        |
| 42 | Which BPs override `ReceiveBeginPlay`?                                       | BP asset list                        | NOT_SERVED         | —                                                                                         | HIGH | Same shape as #27.                                                                                                                                        |
| 43 | Grep source: find every `UCLASS` in a module                                 | C++ class list                       | SERVED_OFFLINE     | `Grep` (Claude Code built-in per D31)                                                      | HIGH | Source-code search is already first-class via native tools.                                                                                               |
| 44 | Find all `.uasset` files larger than 5 MB                                    | Path + size list                     | NOT_SERVED         | —                                                                                         | LOW  | `query_asset_registry` does not surface file size. Potential small expansion: add `size_bytes` to each row (already tracked by parser) + filter param.    |
| 45 | Which BPs have zero references? (orphan audit)                              | Asset list                           | NOT_SERVED         | —                                                                                         | LOW  | Full-project reverse-ref graph; see #21.                                                                                                                  |
| 46 | List every enum defined in the project                                      | Enum asset list                      | SERVED_OFFLINE     | `query_asset_registry class_name:UserDefinedEnum`                                          | LOW  |                                                                                                                                                           |
| 47 | Find all animations using skeleton `SK_PlayerSkeleton`                       | Anim asset list                      | SERVED_PARTIAL     | `query_asset_registry` tag filter `Skeleton` (AR tag)                                      | LOW  | Likely works via AR tag; verify on fixtures.                                                                                                              |
| 48 | List all components under `/Game/ProjectA/Components/`                       | Path list                            | SERVED_OFFLINE     | `Glob` or `query_asset_registry path_prefix:`                                              | LOW  |                                                                                                                                                           |

### §2.4 Debug context — "why is this actor failing?"

| #  | Query                                                                       | Ideal answer shape                               | Coverage           | Tool(s)                                                                                     | Freq | Gap notes                                                                                                                                           |
|----|-----------------------------------------------------------------------------|--------------------------------------------------|--------------------|---------------------------------------------------------------------------------------------|------|-----------------------------------------------------------------------------------------------------------------------------------------------------|
| 49 | Why isn't this ability dealing damage? (read effect modifiers + tags)       | GE modifiers + ability activation tags           | SERVED_OFFLINE     | `read_asset_properties` on GA + GE CDOs                                                     | HIGH |                                                                                                                                                     |
| 50 | What's the collision preset on this mesh?                                    | Preset name + profile flags                      | SERVED_PARTIAL     | `read_asset_properties` on the component                                                    | MEDIUM | Collision profile is a struct; simple fields land in Level 2, complex TEnumAsByte of custom channels may degrade to `unsupported` marker today.      |
| 51 | What's the blend mode of material `M_Glass`?                                 | Enum value                                       | SERVED_OFFLINE     | `read_asset_properties`                                                                     | LOW  | Simple enum on UMaterial CDO.                                                                                                                       |
| 52 | What's the HUD class set on `BP_GameMode`?                                   | Class reference                                  | SERVED_OFFLINE     | `read_asset_properties` on CDO                                                              | LOW  |                                                                                                                                                     |
| 53 | Is VFX plugin enabled?                                                       | Boolean                                          | SERVED_OFFLINE     | `list_plugins`                                                                              | LOW  |                                                                                                                                                     |
| 54 | What's actually happening in the level right now? (live PIE state)           | Runtime actor state                              | SERVED_PLUGIN_ONLY [oracle/phase3/RC] | `get_actors` + `get_editor_state` + `rc_list_objects`                          | MEDIUM | Runtime state is intrinsically editor-dependent. Static offline `list_level_actors` doesn't replace this.                                           |
| 55 | Spawn a test pawn to see if physics works                                    | Spawn confirmation + actor name                  | SERVED_PLUGIN_ONLY [oracle] | `actors.spawn_actor` / `actors.spawn_blueprint_actor`                              | MEDIUM | Write-side, genuinely editor-only.                                                                                                                  |
| 56 | What's the currently selected actor in the editor?                           | Actor name + class                               | SERVED_PLUGIN_ONLY [phase3] | `editor-utility.get_editor_state`                                                  | LOW  |                                                                                                                                                     |
| 57 | Take a screenshot of the current viewport to see what's wrong                | PNG bytes                                        | SERVED_PLUGIN_ONLY [phase3] | `visual-capture.get_viewport_screenshot`                                           | LOW  | Visual inspection needs live editor.                                                                                                                |
| 58 | Get a thumbnail of mesh asset `SM_Torch` to verify import                   | PNG bytes                                        | SERVED_PLUGIN_ONLY [phase3] | `visual-capture.get_asset_thumbnail`                                               | LOW  | Thumbnails are cached by editor; offline `.uasset` holds them as a binary blob but surfacing that blob would duplicate visual-capture scope.        |

### §2.5 Refactoring prep — "is it safe to rename X?"

| #  | Query                                                                       | Ideal answer shape                      | Coverage     | Tool(s)                                                                                     | Freq | Gap notes                                                                                                                                     |
|----|-----------------------------------------------------------------------------|-----------------------------------------|--------------|---------------------------------------------------------------------------------------------|------|-----------------------------------------------------------------------------------------------------------------------------------------------|
| 59 | Is it safe to rename variable `MaxHealth` on `BP_Character`? (call sites)   | Read + write site list                  | NOT_SERVED   | —                                                                                           | MEDIUM | Same as #33. S-A scope.                                                                                                                        |
| 60 | Before deleting `GE_OldBurn`, find every GA referencing it                  | GA asset list                           | NOT_SERVED   | —                                                                                           | MEDIUM | Reverse-ref per #21.                                                                                                                           |
| 61 | Can I change `FItemData.Weight` from float to int? Who reads `Weight`?      | BP + C++ use sites                      | SERVED_PARTIAL | `Grep` for C++ sites + NOT_SERVED for BP sites                                            | LOW  | Source-grep covers C++; BP-side uses S-A (scheduled).                                                                                          |
| 62 | List every BP that calls deprecated function `OldApplyDamage`               | BP + call-site list                     | NOT_SERVED   | —                                                                                           | LOW  | S-A scope.                                                                                                                                     |
| 63 | If I rename `AttributeSet.Health` → `HP`, who breaks?                       | Break-site list                         | NOT_SERVED   | —                                                                                           | LOW  | Same class as #59.                                                                                                                             |

### §2.6 Documentation generation

| #  | Query                                                                       | Ideal answer shape                             | Coverage           | Tool(s)                                                                 | Freq | Gap notes                                                                                                                    |
|----|-----------------------------------------------------------------------------|------------------------------------------------|--------------------|-------------------------------------------------------------------------|------|------------------------------------------------------------------------------------------------------------------------------|
| 64 | Generate README for `BP_OSPlayerR` (interface, variables, functions)        | Markdown-ready summary                         | SERVED_PARTIAL     | `inspect_blueprint include_defaults` + `read_asset_properties`          | MEDIUM | Structural + CDO defaults work. Function signatures + node graph summaries need phase3 + sidecar.                             |
| 65 | Summarize `GA_Fireball`: activation tags, cost, cooldown, GE refs           | Structured summary                             | SERVED_OFFLINE     | `read_asset_properties` on CDO                                          | HIGH |                                                                                                                              |
| 66 | Dump all gameplay tags with comments for a design doc                       | Tag + comment table                            | SERVED_OFFLINE     | `list_gameplay_tags`                                                    | MEDIUM |                                                                                                                              |
| 67 | Write changelog — what assets changed between HEAD and HEAD~10              | Asset diff                                     | SERVED_OFFLINE     | `git diff` via Bash (non-UEMCP)                                         | MEDIUM | Native git covers it. UEMCP not needed.                                                                                      |
| 68 | Generate docs for all DataTables in `/Game/ProjectA/Data/`                   | Per-table schema + row count                   | SERVED_PARTIAL     | `list_data_sources` + `read_datatable_source`                           | MEDIUM | **Gap: binary DataTables.** `read_datatable_source` handles CSV only. ProjectA binary DataTables (saved in `.uasset`) need `asset-registry.get_datatable_contents` [phase3]. |
| 69 | Document all localization strings used in `W_MainMenu`                      | String table entries                           | SERVED_PARTIAL     | `read_string_table_source` (CSV only)                                   | LOW  | Binary UStringTable needs phase3 `data-assets.get_string_table`. CSV-only, same gap pattern as #68.                          |

### §2.7 Project orientation

| #  | Query                                                                       | Ideal answer shape                      | Coverage     | Tool(s)                                                                                  | Freq | Gap notes                                                                                                     |
|----|-----------------------------------------------------------------------------|-----------------------------------------|--------------|------------------------------------------------------------------------------------------|------|---------------------------------------------------------------------------------------------------------------|
| 70 | What's in this project? (engine, plugins, modules, build config)            | Rollup summary                          | SERVED_OFFLINE | `project_info` + `list_plugins` + `get_build_config`                                   | HIGH |                                                                                                              |
| 71 | How many Blueprints does this project have?                                 | Count                                   | SERVED_OFFLINE | `query_asset_registry class_name:Blueprint limit:1` returns truncated + count           | MEDIUM | `total_matches` field in response; covers the count case.                                                    |
| 72 | Which UEMCP toolsets are available right now?                               | Toolset list with tool counts           | SERVED_OFFLINE | `list_toolsets`                                                                          | HIGH | Always-loaded management tool.                                                                               |
| 73 | What's the full gameplay tag hierarchy?                                     | Tree                                    | SERVED_OFFLINE | `list_gameplay_tags`                                                                     | HIGH |                                                                                                              |
| 74 | What's the starting map?                                                    | Map path                                | SERVED_OFFLINE | `list_config_values` on `DefaultEngine.ini` → `[/Script/EngineSettings.GameMapsSettings]` | MEDIUM |                                                                                                              |
| 75 | What's the engine version and build target?                                 | Version string + target info            | SERVED_OFFLINE | `project_info` + `get_build_config`                                                      | MEDIUM |                                                                                                              |
| 76 | Give me the DataTable catalog                                               | CSV + binary DataTable paths            | SERVED_PARTIAL | `list_data_sources` (CSV) + `query_asset_registry class_name:DataTable` (binary)         | MEDIUM | No single tool covers both sides.                                                                           |
| 77 | Show me which UEMCP tools are currently enabled                             | Tool + toolset list                     | SERVED_OFFLINE | `list_toolsets`                                                                          | MEDIUM |                                                                                                              |

### §2.8 Configuration reads

| #  | Query                                                                       | Ideal answer shape                    | Coverage         | Tool(s)                                                                                     | Freq | Gap notes                                                                                                       |
|----|-----------------------------------------------------------------------------|---------------------------------------|------------------|---------------------------------------------------------------------------------------------|------|-----------------------------------------------------------------------------------------------------------------|
| 78 | What's in `DefaultGame.ini`?                                                | Section + key dump                    | SERVED_OFFLINE   | `list_config_values`                                                                         | MEDIUM |                                                                                                                 |
| 79 | What are the input bindings for action "Jump"?                              | Key list per context                  | SERVED_PARTIAL   | `read_asset_properties` on IMC + IA assets                                                   | MEDIUM | Enhanced Input mapping uses TArray<FEnhancedActionKeyMapping> (complex struct). Agent 10.5 D46+D47 extends.     |
| 80 | What's the physics engine config?                                           | Substance of `[Physics]` section      | SERVED_OFFLINE   | `list_config_values`                                                                         | LOW  |                                                                                                                 |
| 81 | Which `.ini` files exist under Config/                                      | File list                             | SERVED_OFFLINE   | `list_config_values()` (no args → lists files)                                               | LOW  |                                                                                                                 |
| 82 | ProjectA vs ProjectB: do they share any gameplay tags?                     | Tag intersection set                  | SERVED_OFFLINE   | Run `list_gameplay_tags` against each project root; diff client-side                         | LOW  | Cross-project comparison requires two server invocations with different `UNREAL_PROJECT_ROOT`. Doable but ad hoc. |

### §2.9 Asset audit

| #  | Query                                                                       | Ideal answer shape                    | Coverage         | Tool(s)                                                                                    | Freq | Gap notes                                                                                                     |
|----|-----------------------------------------------------------------------------|---------------------------------------|------------------|--------------------------------------------------------------------------------------------|------|---------------------------------------------------------------------------------------------------------------|
| 83 | Which BPs are over 500 KB?                                                  | Path + size list                      | NOT_SERVED       | —                                                                                          | LOW  | Parser has `sizeBytes`. Not surfaced through a filterable tool yet.                                            |
| 84 | Find DataTables whose row struct is `FItemData`                             | Asset list                            | SERVED_PARTIAL   | `query_asset_registry class_name:DataTable tag_key:RowStructure tag_value:...`             | LOW  | Depends on AR tag population; verify fixture.                                                                 |
| 85 | Count BPs per parent class                                                  | Histogram                             | SERVED_PARTIAL   | `query_asset_registry class_name:Blueprint` + client-side group-by `ParentClass`           | LOW  | Doable via AR tag aggregation; no built-in histogram.                                                         |
| 86 | Which assets are tagged `PrimaryAssetType=GameItem`?                        | Asset list                            | SERVED_OFFLINE   | `query_asset_registry tag_key:PrimaryAssetType tag_value:GameItem`                          | LOW  |                                                                                                               |
| 87 | What's the largest `.umap`?                                                 | Path + size                           | NOT_SERVED       | —                                                                                          | LOW  | Same as #83.                                                                                                  |
| 88 | ProjectA ↔ ProjectB: assets with same path, different size                | Diff list                             | NOT_SERVED       | —                                                                                          | LOW  | Cross-project diff. Theoretically possible with two `query_asset_registry` runs + join; no tool today.         |

### §2.10 Comparison / diff

| #  | Query                                                                       | Ideal answer shape                    | Coverage         | Tool(s)                                                                | Freq | Gap notes                                                                                                                       |
|----|-----------------------------------------------------------------------------|---------------------------------------|------------------|------------------------------------------------------------------------|------|---------------------------------------------------------------------------------------------------------------------------------|
| 89 | What changed in `BP_OSPlayerR` between HEAD and HEAD~5?                     | Property + export diff                | NOT_SERVED       | —                                                                      | LOW  | `.uasset` is binary; `git diff` not useful. Two `read_asset_properties` calls + client-side diff works but no helper tool.       |
| 90 | What variables does `BP_Fire` have that `BP_Water` doesn't?                 | Variable-set diff                     | SERVED_PARTIAL   | Two `inspect_blueprint include_defaults` calls + client-side diff      | LOW  | Works; clunky.                                                                                                                 |
| 91 | Diff the tags on `GE_Stun` vs `GE_Slow`                                     | Tag-set diff                          | SERVED_PARTIAL   | Two `read_asset_properties` calls + client-side diff                   | LOW  | Same pattern.                                                                                                                  |

### §2.11 Generation / scaffolding prep

| #  | Query                                                                       | Ideal answer shape                    | Coverage         | Tool(s)                                                                | Freq | Gap notes                                                                                                                       |
|----|-----------------------------------------------------------------------------|---------------------------------------|------------------|------------------------------------------------------------------------|------|---------------------------------------------------------------------------------------------------------------------------------|
| 92 | Show me a typical GAS ability BP to use as a template                       | Structural dump of a reference BP     | SERVED_OFFLINE   | `inspect_blueprint include_defaults` on a canonical BPGA             | LOW  |                                                                                                                                |
| 93 | What's the canonical AnimMontage section layout in this project?            | Sample data                           | SERVED_OFFLINE   | `read_asset_properties` on a known AM                                  | LOW  |                                                                                                                                |
| 94 | What pattern do existing DataTables use for weapon stats?                   | Sample row struct + data              | SERVED_PARTIAL   | `read_datatable_source` (CSV) or `read_asset_properties` (binary)      | LOW  | CSV path works; binary DataTable gap per #68.                                                                                   |

### §2.12 Visual / runtime / cross-project extras

| #  | Query                                                                       | Ideal answer shape                    | Coverage                 | Tool(s)                                                                                    | Freq | Gap notes                                                                                                            |
|----|-----------------------------------------------------------------------------|---------------------------------------|--------------------------|--------------------------------------------------------------------------------------------|------|----------------------------------------------------------------------------------------------------------------------|
| 95 | Render `BP_Sword` as a preview image                                         | PNG bytes                             | SERVED_PLUGIN_ONLY [phase3] | `visual-capture.get_asset_preview_render`                                          | LOW  |                                                                                                                      |
| 96 | Start PIE, run console command `stat fps`, stop PIE                         | Console output                        | SERVED_PLUGIN_ONLY [phase3] | `input-and-pie.start_pie` + `execute_console_command` + `stop_pie`                 | LOW  | Intrinsically editor-only.                                                                                           |
| 97 | What actors currently exist in the PIE world?                               | Actor list with live transforms       | SERVED_PLUGIN_ONLY [oracle/phase3] | `actors.get_actors` via TCP:55557 (or phase3 TCP:55558)                      | LOW  | Runtime state. `list_level_actors` reads static `.umap` only.                                                        |
| 98 | What Niagara emitters fire on ability `GA_FireBlast`?                       | Emitter list + trigger events         | SERVED_PARTIAL           | `read_asset_properties` for user-exposed params; graph data not offline                    | LOW  | Runtime VM + graph edges = editor-only. Scalar/struct params offline.                                                |
| 99 | Does ProjectB have a plugin that ProjectA doesn't?                         | Plugin diff                           | SERVED_OFFLINE           | `list_plugins` twice with different `UNREAL_PROJECT_ROOT`                                  | LOW  | Cross-project diff pattern (see §2.8 #82).                                                                            |
| 100| Dump the current editor's open asset tab list                               | Tab list                              | SERVED_PLUGIN_ONLY [phase3] | `visual-capture.capture_active_editor_tab`                                         | LOW  |                                                                                                                      |

---

## §3 Category summary

Counts are for the 100 rows above. Frequency-weighted analysis in §4.

| Category                       | Total | SERVED_OFFLINE | SERVED_PARTIAL | SERVED_PLUGIN_ONLY | NOT_SERVED | Headline gap                                               |
|--------------------------------|-------|----------------|----------------|---------------------|------------|------------------------------------------------------------|
| §2.1 Introspection             | 20    | 9              | 6              | 4                   | 1          | Per-BP event/function/call detection (S-A; row 3).        |
| §2.2 Impact analysis           | 15    | 3              | 4              | 1                   | 7          | Reverse references + per-K2Node find (rows 21/26–28/33). |
| §2.3 Scan / grep               | 13    | 7              | 3              | 0                   | 3          | BP-internal grep (S-A; rows 42/44/45).                    |
| §2.4 Debug context             | 10    | 4              | 1              | 5                   | 0          | None offline-reachable beyond current scope.              |
| §2.5 Refactoring prep          | 5     | 0              | 1              | 0                   | 4          | Call-site enumeration (S-A).                              |
| §2.6 Documentation gen         | 6     | 3              | 3              | 0                   | 0          | Binary DataTables (row 68).                               |
| §2.7 Project orientation       | 8     | 7              | 1              | 0                   | 0          | Best-served category. Near-complete.                      |
| §2.8 Configuration             | 5     | 4              | 1              | 0                   | 0          | Enhanced Input IMC structs partial.                       |
| §2.9 Asset audit               | 6     | 1              | 2              | 0                   | 3          | Size-filtered queries (rows 83/87).                       |
| §2.10 Comparison / diff        | 3     | 0              | 2              | 0                   | 1          | No binary-asset diff helper.                              |
| §2.11 Generation scaffolding   | 3     | 2              | 1              | 0                   | 0          | Binary DataTables again.                                  |
| §2.12 Visual/runtime/cross     | 6     | 1              | 1              | 4                   | 0          | Mostly legitimately plugin-only.                          |
| **Total**                      | **100** | **41**       | **26**         | **14**              | **19**     |                                                            |

Coverage distribution:

- SERVED_OFFLINE:       41 (41%)
- SERVED_PARTIAL:       26 (26%)
- SERVED_PLUGIN_ONLY:   14 (14%)
- NOT_SERVED:           19 (19%)

---

## §4 Coverage gaps — ranked

Ranking: frequency × workflow importance. High-priority gaps first. Each notes whether offline coverage is theoretically reachable or plugin-dependent.

### Rank 1 — BP-internal name-level find/grep (rows 3, 26, 27, 28, 33, 42, 59, 62, 63)

**What the gap is**: 9 NOT_SERVED rows all shape the same way — "which K2Node of type X calls / references / handles Y, across this BP or N BPs." Noah's "offline reads first-class" principle is load-bearing on this; these are the dominant agent workflows per Agent 11.5 §4.3 rows 1–4.

**Offline reachability**: YES. This is exactly the D48 Tier S-A scope scheduled for Agent 10.5. ~1.5-2 incremental agent sessions on top of Agent 10's L1+L2+L2.5 infrastructure. Reference coverage is 100% (FPropertyTag iteration + FMemberReference as tagged struct, CUE4Parse-backed).

**Downstream implications**: S-A landing closes roughly 9 rows (9% of the catalog) from NOT_SERVED to SERVED_OFFLINE. It also eliminates or shrinks the Phase 3 rationale for 2–3 `blueprint-read.*` tools shaped around name-level finds (`get_blueprint_functions` name-presence case; `get_blueprint_variables` write-sites). Agent 11.5 §6.4 estimated "minor — maybe 2-3 additional tools move from Phase 3 required to offline sufficient." This catalog confirms the demand signal.

### Rank 2 — Reverse-reference / referrer queries (rows 21, 25, 35, 45, 60)

**What the gap is**: "what references asset X?" — the inverse of forward dependency walks. Five rows, multiple categories (impact analysis, refactor prep, asset audit). HIGH-frequency when doing refactoring or cleanup work.

**Offline reachability**: PARTIAL. A reverse-ref graph can be built by scanning every `.uasset` in `Content/` with `read_asset_properties` and inverting the forward-ref list. Cost: ~19K files × ~20ms parse ≈ 6 minutes per full-project scan. Cacheable with D33 `assetCache` freshness. Not impossible; but not trivial. **Editor-side `IAssetRegistry::GetReferencers` is strictly faster** (uses the cooked registry or an in-memory graph kept by the editor).

**Downstream implications**: Realistic outcome is hybrid — a plugin tool `asset-registry.get_asset_references` [phase3] is the fast path; an offline fallback tool (full-scan) could exist as a slow path for when the editor is closed, but the complexity isn't obviously worth it given the plugin alternative. Consolidation opportunity: reverse-ref is a single tool in the Phase 3 plan, no need for multiple entry points.

### Rank 3 — Binary DataTable / StringTable contents (rows 68, 69, 94)

**What the gap is**: `read_datatable_source` and `read_string_table_source` are CSV-only. Most ProjectA DataTables are binary (saved as `.uasset`, not authored from CSV). Three rows hit this directly; it's also the silent partial in row 76.

**Offline reachability**: PARTIAL. A binary DataTable's row data is a serialized `TArray<FTableRowBase-subclass>` inside the `.uasset`. Agent 10 handles simple-element TArray via D46. Complex-element TArray (array of user structs) needs D47 UUserDefinedStruct two-pass resolver — scheduled for Agent 10.5. So **binary DataTable row access arrives with Agent 10.5** for the UserDefinedStruct row case. DataTables keyed on engine-internal structs remain a harder problem.

**Downstream implications**: Row 68 and 76 flip to SERVED_OFFLINE after Agent 10.5. Phase 3 `asset-registry.get_datatable_contents` remains relevant for DataTables with engine-internal row structs or when compiled data is required.

### Rank 4 — Per-node trace / spatial queries (rows 9, 10, 13, 16, 30)

**What the gap is**: "trace exec from this event," "what's inside this comment box," "show me the function body as a graph." Five rows; Agent 11.5 §4.3 rows 5–7 anchor this class.

**Offline reachability**: NO (per D48 Tier S-B FOLD-INTO-3F verdict). UEdGraphPin binary block has zero reference coverage; pin-trace parsing would duplicate 3F sidecar capability at 4–8× cost without 3F's editor-mediated version-correctness.

**Downstream implications**: 3F sidecar (Phase 3, editor save-hook + `dump_graph` TCP verb) is the right answer. S-A lands the find/grep floor; 3F handles trace/spatial. The two complement cleanly per Agent 11.5 §7.1. Catalog validates the Agent 11.5 recommendation as having real workflow demand.

### Rank 5 — Size-filtered / aggregation queries (rows 44, 83, 85, 87)

**What the gap is**: "which BPs exceed 500 KB," "count BPs per parent class," "largest `.umap`." Low frequency individually; cumulative value for project-hygiene audits.

**Offline reachability**: YES. The parser already tracks `sizeBytes` per asset. `query_asset_registry` doesn't currently surface it or allow size-filter/size-sort. A modest extension (add `size_bytes` to each row + `min_size_bytes` / `sort_by:size` params) would close rows 44, 83, 87 without a new tool.

**Downstream implications**: No new tool needed — `query_asset_registry` surface extension. Low priority but high ROI if a hygiene audit agent ever materializes.

### Rank 6 — Cross-project comparison (rows 82, 88, 99)

**What the gap is**: "ProjectA vs ProjectB: do they share tag X?" Requires running offline tools against two different project roots and diffing. The single-project `UNREAL_PROJECT_ROOT` model means these are two separate server invocations today.

**Offline reachability**: Fully, but clunky — cross-project is an orchestration-layer concern, not a tool-layer concern. No server change warranted; CLI-agent pattern is to invoke twice + diff client-side. Worth noting in docs/tool descriptions that cross-project diffing is a first-class pattern.

---

## §5 Over-served areas

After cross-referencing `tools.yaml` against the catalog, three candidates jump out:

1. **`actors.take_screenshot` / `visual-capture.get_viewport_screenshot` overlap** — two ways to get a viewport screenshot, one PNG-to-file, one inline base64. Only row 57 asks this and only once. `take_screenshot` is already marked Legacy in yaml; consolidation already implied.

2. **`widgets.add_widget_to_viewport`** — yaml already flags this as a NO-OP per D27. Confirmed over-served; it doesn't serve any row in the catalog because it doesn't actually do anything.

3. **`editor-utility.create_asset`** — generic UFactory-based asset creation. The catalog doesn't have a single query asking for generic creation — every creation query in categories §2.11 and §2.1 is domain-specific (montage, GE, BP). Suggests `create_asset` is aspirational coverage rather than real-workflow coverage. Not a deletion candidate necessarily; flag for Phase 3 scope review.

No strong deprecation candidates beyond what's already flagged in the D-log.

---

## §6 Informing future work

### §6.1 Phase 3 plugin scope implications

The catalog supports the Phase 3 scope reductions D32/D37/D48 already made and suggests further:

- **Blueprint-read toolset** (9 tools in yaml): Agent 9's §3 already flagged 5 reduced + 1 eliminated. Rows 3/12/29/42/62 in this catalog map to `get_blueprint_functions`/`get_blueprint_info`/`get_blueprint_variables` name-level cases — S-A covers these offline. That means `get_blueprint_functions` shrinks to "full signature reflection only" and the name-level find case moves offline. Similarly for `get_blueprint_variables` (CDO defaults offline, only live-reflection flags stay).
- **Asset-registry toolset**: 4 of 5 tools already eliminated pre-L12 per D37. Remaining `get_asset_references` (rank 2 gap) stays plugin for speed reasons. No further reduction indicated by the catalog.
- **Data-assets toolset** (7 tools): `get_data_asset_properties` already eliminated per Agent 9 §3. Rows 68/69/94 suggest `get_datatable_contents` and `get_string_table` keep their places for binary cases (CSV covered offline). `get_struct_definition` partially covered by Agent 10.5 D47; reflection-rich metadata (member `EditAnywhere` flags etc.) stays plugin.
- **Actors toolset** (10 tools, TCP:55557 oracle today): Rows 54/55/97 validate the live-state / write-op scope. `get_actors` + transforms in static case is already covered offline by `list_level_actors`. Rows 1/31/41 use static; rows 54/55/97 use live. Static case reducible per Agent 9 §3 — `get_actors` stays for live, static subset moves offline entirely.

### §6.2 3F sidecar scope validation

Rank 4 (rows 9/10/13/16/30) is the signal that 3F sidecar has real workflow demand, not just theoretical. Agent 11.5 §7.1's three-layer stack (L0 inspect_blueprint, L1 S-A, L2 sidecar) maps cleanly:

- Rows answered by L0 today: 2, 4 partial, 7 partial, 11 partial — structural introspection.
- Rows answered by L1 S-A post-Agent-10.5: 3, 26, 27, 28, 29 (name-only), 33, 42, 59, 60, 62, 63.
- Rows answered by L2 sidecar only: 9, 10, 13, 16, 30.

Corollary: 3F sidecar's find-grep verbs (`bp_find_in_graph`, `bp_find_global` per D41) become *less* critical once S-A ships, since S-A handles that class offline. Sidecar scope can focus on what only sidecar does well: trace, spatial, comment containment. `bp_find_global` deferral to v1.2+ (D41) is consistent with this.

### §6.3 Tool surface conventions / consolidation

Three weak consolidation signals, none urgent:

1. **DataTable access is bifurcated** (rows 68/76/84): `list_data_sources` + `read_datatable_source` (CSV) vs `query_asset_registry class_name:DataTable` (binary, metadata only). A unified entry point could merge these. Not urgent — the two paths are self-documenting. Revisit after Agent 10.5 UserDefinedStruct resolver makes binary DT row content readable.
2. **Project-level diff is absent** (rows 82/88/99): the pattern of "invoke twice against two roots and diff" is supported but ad hoc. A small helper tool (`compare_projects`) could formalize it. Low priority.
3. **Size-aware asset audit** (rows 44/83/87): extend `query_asset_registry` with size fields + filter params rather than adding a new tool. Single-row yaml change once demand signal strengthens.

### §6.4 Offline-reads-first-class principle — is it honored?

Counting the 41 SERVED_OFFLINE + 26 SERVED_PARTIAL rows against the 19 NOT_SERVED rows, **67% of catalog queries get at least partial offline answers today**. Post-Agent-10.5 (S-A rank-1 closes 9 rows; D47 resolver rank-3 closes ~3 partials to full offline), the fully-offline floor rises to ~53% and the partial-or-full offline reach climbs to ~76%.

Remaining NOT_SERVED clusters are structurally editor-dependent (runtime state, reflection-only metadata, UEdGraph edges, reverse-reference graph) — these are the right edges of the "first-class" principle, not contradictions to it. The gap rank in §4 maps cleanly to the research docs' priorities.

Offline-reads-first-class is **honored** for the find/grep/introspection/config/orientation workflow majority. It is **partial** on impact analysis (reverse refs) and refactoring prep (both gated on S-A). It is **appropriately deferred** for trace/spatial/runtime cases.

---

## §7 Open questions for Noah

**Q1**: Rows 54/55/57/97/100 (runtime/PIE/visual) are classified LOW frequency based on my priors. If a significant fraction of your actual agent sessions involve PIE-driven debugging or visual verification, those gap priorities shift. Can you confirm live-editor work is truly a minority use case vs. static file reads?

**Q2**: Rank 2 (reverse references) is frequency-ranked HIGH on assumption that refactoring / cleanup work is a sizeable chunk. If your agent work is heavier on greenfield (new abilities, new widgets) than refactoring, the rank drops materially. Which mix is realistic?

**Q3**: Cross-project diff pattern (rows 82/88/99) — is ProjectA ↔ ProjectB comparison a real workflow you run, or is each project agent-audited in isolation today? If isolated, rows 82/88/99 drop from LOW to essentially zero demand.

**Q4**: `query_asset_registry` size-field extension (rank 5) — one yaml change + parser already tracks `sizeBytes`. Low cost; low-to-medium demand. Worth queuing, or YAGNI?

**Q5**: Row 98 (Niagara emitters / VFX) is flagged LOW frequency. If VFX scripting is a regular ProjectA workflow, this might deserve a dedicated toolset slot. Currently only `animation.get_audio_asset_info` and the plugin-scheduled `blueprint-read.get_niagara_system_info` serve anything VFX-adjacent.

**Q6**: Binary DataTable / StringTable coverage (rank 3) — confirmation that ProjectA's DataTables are primarily binary (not CSV-authored)? My classification assumes binary dominates; if CSV dominates, row 68/69/94 drop to SERVED_OFFLINE today.

---

## §8 Confidence

**Split confidence**:

- **Query realism**: HIGH. Queries are grounded in: (a) Agent 9 §1's three workflows Level 1+2 was built for; (b) Agent 11.5 §4.3's seven find/grep vs trace/spatial rows; (c) the conformance-oracle-contracts.md dispatch table (36 commands — each represents historical agent demand for the UnrealMCP predecessor); (d) the ProjectA/ProjectB project character (GAS combat + breakout). A few queries (rows 82/88/95/99/100) are conservative extrapolations rather than observed demand — flagged in §7.
- **Coverage classification**: HIGH on OFFLINE and PLUGIN_ONLY rows (derived from tools.yaml + shipped offline tool semantics). MEDIUM on PARTIAL rows — partials depend on whether a given UPROPERTY actually lands in Level 2's 10-struct registry vs degrades to `{unsupported}` marker; sampling on real ProjectA fixtures wasn't part of this catalog's scope.
- **Frequency estimates**: MEDIUM. Subjective; based on typical CLI-agent patterns against a UE project rather than observed logs. Noah's Q1–Q6 answers in §7 can re-rank several gaps.
- **Gap ranking**: MEDIUM. Ranks 1–4 are robust (cross-anchor with Agent 9 / Agent 11.5 corpora). Ranks 5–6 are low-confidence extrapolations.

**Overall**: MEDIUM-HIGH. The catalog's structure and anchoring should be durable; specific frequency tags and the rank 5/6 items may shift under Noah's answers to §7.

---

## Final Report

```
Agent Workflow Catalog — Final Report

Queries catalogued: 100 across 12 categories
Coverage distribution:
  SERVED_OFFLINE:       41 (41%)
  SERVED_PARTIAL:       26 (26%)
  SERVED_PLUGIN_ONLY:   14 (14%)
  NOT_SERVED:           19 (19%)

Top 3 gaps (by frequency × importance):
  1. BP-internal name-level find/grep (rows 3/26/27/28/33/42/59/62/63 — 9 rows, S-A scope in Agent 10.5)
  2. Reverse-reference queries (rows 21/25/35/45/60 — 5 rows, plugin-path optimal; offline possible but slow)
  3. Binary DataTable / StringTable contents (rows 68/69/94 — 3 partials, covered by Agent 10.5 D47 UserDefinedStruct resolver)

Top 3 over-served areas:
  1. Duplicate viewport screenshot tools (actors.take_screenshot ↔ visual-capture.get_viewport_screenshot) — consolidation already flagged in yaml
  2. widgets.add_widget_to_viewport (NO-OP per D27 — already flagged for removal)
  3. editor-utility.create_asset (generic UFactory — no catalog query asks generic creation; revisit Phase 3 scope)

Offline-reads-first-class principle honored? Partial — gaps exist but map cleanly to research priorities.
  Evidence: 67% of queries have at least partial offline coverage today; post-Agent-10.5 S-A + D47 raises this to ~76%. Remaining NOT_SERVED clusters are structurally editor-dependent (runtime state, UEdGraph edges, reverse-reference graph). Rank-1 find/grep gap closes when S-A ships; rank-3 binary DT gap closes when D47 resolver ships. Rank 4 (trace/spatial) is permanently sidecar territory per D48. No surprising gaps.

Phase 3 plugin scope implications:
  1. blueprint-read.get_blueprint_functions + get_blueprint_variables shrink to reflection-only cases after S-A lands (name-level finds move offline)
  2. actors.get_actors reduces to live-state cases; static subset already covered by list_level_actors
  3. bp_find_global (D41) deferral further validated — S-A closes that workflow class offline

Open questions for Noah: 6
Confidence: MEDIUM-HIGH (HIGH on query realism + shipped-state classification; MEDIUM on frequency + gap ranking)
Deliverable: docs/research/agent-workflow-catalog.md (~460 lines)
Time spent: ~50 minutes
```
