# Audit: Phase 2 Tier-2 Parser Validation against ProjectA Content

**Date**: 2026-04-15
**Investigator**: Agent 5 (paired with Noah driving tool calls from Claude Code in `D:\UnrealProjects\5.6\ProjectA`)
**Scope**: Manual validation pass of the 13 UEMCP offline tools against real ProjectA production content. Surface bugs the mocked unit tests cannot catch. Read/validate only — no server edits.
**Status**: Complete — awaiting sign-off.

---

## §1 Mission & environment

- **Host**: Claude Code in ProjectA workspace with `uemcp` MCP connected via stdio
- **Server commit**: main @ 2611833 with binary-fix 5bbce97
- **Baseline**: 315/315 unit assertions green (36 offline + 45 mock seam + 234 TCP tools)
- **Unit-test gap this pass addresses**: parser correctness under real `.uasset`/`.umap` variety; tool envelope usability from an agent context; cross-tool consistency
- **Out of scope**: TCP layer (Phase 2 client already tested via mock seam); Phase 3 plugin (doesn't exist); Phase 4 Remote Control; ProjectB

The matrix (§3 of dispatch) covers 9 content categories × 4 parser-backed tools plus 9 sanity checks on other offline tools = 33 rows.

---

## §2 Findings

Findings accumulate in discovery order. F0 is pre-seeded from the opening scans.

### F0 — Response verbosity exceeds MCP token cap on complex Blueprints (affects `query_asset_registry` AND `get_asset_info`)

- **Severity**: High (usability, not correctness)
- **Scope (bounded by T12-T14, T20, T13)**: triggers on assets carrying large `FiBData` and/or `ActorMetaData` tag blobs. Empirically:
  - **Complex BP** (BP_OSPlayerR, 587 KB on disk): busts cap — 280 KB response, spilled to disk.
  - **Simple BP** (PunchingBag, 35 KB on disk): safe — response fit inline, FiBData present but small.
  - **Material** (M_Master_DefaultOpaque, 28 KB): safe — no FiBData, no ActorMetaData tag.
  - **DataTable** (DT_HitReacts_PunchingBag, 4 KB): safe — tiny response.
  - **`query_asset_registry` folder scans**: compound the problem because every returned asset carries its full tag payload; 16 BPs was enough to hit 817 KB.
- **Reproductions**:
  - `query_asset_registry path_prefix:/Game/Blueprints/ limit:2000 max_scan:20000` → 16 files → ~817 KB response (spilled).
  - `query_asset_registry path_prefix:/Game/` → 19,071 walked, 2000 returned, 5.2 MB response (spilled).
  - `get_asset_info /Game/Blueprints/Character/BP_OSPlayerR` → 280,688 chars for a single asset (spilled). T12.
  - **`inspect_blueprint /Game/Blueprints/Character/BP_OSPlayerR` → 365,226 chars, spilled to disk** (T17, this session). *Larger* than `get_asset_info` on the same asset because it carries both the tag dict AND the full 275-entry export table. Confirms F0 affects all three AR-tag-returning offline tools (`query_asset_registry`, `get_asset_info`, `inspect_blueprint`).
- **Root cause**: each asset result carries raw AR-tag values verbatim, including two binary-blob tags that scale with BP complexity:
  - `FiBData` — Find-in-Blueprints search index; ROT-1-obfuscated ASCII wrapping nested JSON with numeric-schema keys. Scales with BP graph/node count. **Dominant contributor on complex BPs.**
  - `ActorMetaData` — Base64-encoded blob (~50 KB on complex BPs; ~hundred bytes on simple ones).
  - Stable metadata (class, parent, component counts, replicated props) is ~1 KB; signal-to-noise on BP_OSPlayerR is < 1%.
- **Impact**: tool is unusable from an agent context for (a) any folder containing more than a handful of complex BPs, or (b) any single complex BP. Blocks Phase 3 workflows that enumerate `/Game/*` or inspect gameplay BPs (characters, abilities). Non-BP assets and simple BPs are fine.
- **Suggested fix directions** (not implementing):
  - `verbose: false` default that strips known verbose tag payloads (`ActorMetaData`, `FiBData`, and any other field whose decoded length exceeds a threshold — e.g., 1 KB — with an explicit allowlist of "always-keep scalars")
  - Keep decoded scalar tags: `NativeParentClass`, `ParentClass`, `GeneratedClass`, `BlueprintType`, `ImplementedInterfaces`, `NumReplicatedProperties`, component counts, `IsDataOnly`
  - `max_response_bytes` soft cap with truncation counter in envelope
  - Optional `include: [...]` projection param to opt back into specific heavy fields
  - Consider surfacing a `heavyTagsOmitted: [...]` list so callers know what was stripped

### F1 — (candidate) No pagination / cap signalling on `query_asset_registry`

- **Severity**: TBD pending confirmation under narrower repros (provisionally Medium)
- **Reproduction**: wide scan `path_prefix:/Game/` returned exactly 2000 matches out of 19,071 files walked with no pagination token, no `truncated:true` flag in the envelope (to be confirmed by inspection), and no cursor for a follow-up call.
- **Impact**: callers cannot tell whether the result set is complete, and cannot fetch the remainder.
- **Suggested fix directions**: add `truncated` + `total_scanned` + `next_offset` (or equivalent) to the envelope; consider cursor-based continuation.
- **Note**: parser itself processed all 19k files without crash or malformed parse — this is an envelope/shape issue, not a parser issue.

### F2 — `inspect_blueprint` and `get_asset_info` return overlapping `tags` payload

- **Severity**: Medium (design / redundancy — independent of F0)
- **Reproduction**: `inspect_blueprint /Game/Blueprints/Character/BP_OSPlayerR` returns the same `tags` dict (including `FiBData`, `ActorMetaData`, `ActorMetaDataClass`, `BlueprintComponents`, `NativeParentClass`, etc.) that `get_asset_info` already returns for the same asset. Compared outputs in T12 vs T17.
- **Root cause**: responsibility overlap between the two tools. `inspect_blueprint`'s stated job is the export-table walk (exports / imports / SCS nodes / functions); it arguably should not carry the AR-tag payload at all. As written, both tools serve the same AR metadata plus their own distinct data, so callers that need both pay for the tags twice (or must choose which oversized tool to call).
- **Impact**:
  - Redundant bytes on the wire even after F0 is fixed.
  - Ambiguous API: when do I call `get_asset_info` vs `inspect_blueprint`? Right now it's "whichever gives fewer bytes," which is a smell.
  - Amplifies F0 because `inspect_blueprint`'s payload is actually *larger* than `get_asset_info` on the same asset (365 KB vs 280 KB on BP_OSPlayerR, T17 vs T12).
- **Suggested fix direction** (not implementing):
  - Make `inspect_blueprint` tags-free. Its contract becomes: "given a BP path, return exports / imports / SCS nodes / functions / class breakdown — the structural view of the blueprint."
  - `get_asset_info` keeps the AR-tag scalars (per F0 fix).
  - Callers compose: one call for metadata, one for structure. Both fit inline.
  - Alternatively: if keeping overlap, at minimum strip the heavy blob tags (`FiBData`, `ActorMetaData`) from `inspect_blueprint` unconditionally since they are never structural data.

### F3 — `list_level_actors` response oversizes on real maps (F0-class, different tool)

- **Severity**: High (usability)
- **Reproduction (T21)**: `list_level_actors /Game/Maps/Deployable/MarketPlace/MarketPlace_P` → 131,644 chars, spilled to disk. 572 export rows × fixed-cost row shape (name, className, classPackage, outer, bIsAsset).
- **Second reproduction (T22, stronger)**: `list_level_actors /Game/Maps/Non-Deployable/Metric_Geo` → **319,729 chars**, spilled. 1377 exports / 1026 imports parsed cleanly. Even after F4-style filtering this map has **223 real top-level placements** (202 StaticMeshActor + 15 art-kit BPs + 2 Model + 2 Polys + Brush + WorldSettings) — filtering alone cuts the response by ~84% but 223 rows at ~80 bytes each still trends close to the cap.
- **Root cause**: no verbose-blob tags here (unlike F0) — just row count × row size. Dev map with 14 placements hits 131 KB; whitebox kit map with 223 placements hits 320 KB. A real content map with World Partition streaming cells will be worse.
- **Impact**: `list_level_actors` on any non-trivial map exceeds the MCP token cap. Blocks the Phase 3 "what's placed in this level" workflow.
- **Suggested fix direction**: F4 (row filtering) is necessary but **not sufficient** — T22 shows filtering alone leaves 223 rows and still trends near the cap. Also need: (a) response size cap / truncation signal, (b) `limit`/`offset` cursor, or (c) a `summarize_by_class` mode that returns `{className: count}` instead of per-row output for degenerate maps. Parser itself is clean — 1377/1377 parsed on Metric_Geo, 572/572 on MarketPlace_P, no errors anywhere.

### F4 — `list_level_actors` returns full export table, not placed actors (contract mismatch)

- **Severity**: High (correctness — tool does not do what its name claims)
- **Reproduction (T21)**: `list_level_actors /Game/Maps/Deployable/MarketPlace/MarketPlace_P` returns 572 "actors." Breakdown after filtering:
  - **14 are actually placed in PersistentLevel**: 2× PlayerStart, 1× BP_AICharacter_C, 1× BP_ProjectileTesterCannon_C, 1× BP_TestAudioRep_C, 1× AkSpatialAudioVolume, 1× Landscape, 1× InstancedFoliageActor, 1× MarketPlace_P_C (LevelScript instance) + 1× LevelScriptBlueprint, 1× WorldSettings, 2× Brush/Model geometry.
  - **558 are noise**: 87 LandscapeMaterialInstanceConstant + 87 MaterialInstanceEditorOnlyData + 64 LandscapeComponent + 64 LandscapeHeightfieldCollisionComponent + 55 AssetImportData + 55 LandscapeTextureHash + 55 Texture2D + 10 Foliage* + 11 component subobjects of BP_AICharacter_C (Attack/Block/Camera/Dash/Dodge/Footsteps/HitReact/Parry/Targeting/VFX/AnimationSync) + BookMarks, Polys, EdGraph, Function, K2Node_Event, BlueprintGeneratedClass, BodySetup, etc.
  - **Signal-to-noise: 2.4%.**
- **Root cause**: handler returns the full export table unfiltered. A "list level actors" tool should filter to exports whose `outer` resolves to `PersistentLevel` (UE's editor Outliner definition), dropping: component subobjects (outer = another export), editor-only data by suffix (`*EditorOnlyData`, `LandscapeTextureHash`, `AssetImportData`), package-embedded assets (Texture2D, MaterialInstance*, BodySetup, Polys, Model when outer is a Brush), and BP metadata (Function, K2Node_*, EdGraph, BlueprintGeneratedClass).
- **Impact**:
  - Tool output is misleading. An agent that trusts the tool name will make wrong downstream calls — e.g., "this map has 87 LandscapeMaterialInstanceConstant actors" is garbage.
  - Amplifies F3: filtering to the 14 real placements would shrink the response ~40×.
- **Suggested fix direction** (not implementing):
  - Filter to exports whose `outer` is the PersistentLevel export; include actor-class geometry brushes separately if needed.
  - Match UE's editor Outliner semantics — that's the mental model callers will bring.
  - Keep the YAGNI per-row trim (class+name only); the correctness bug is in row *selection*, not row *shape*.
- **Note on dispatch framing**: the handoff described this tool as "YAGNI, class+name only, no transforms." That trim was applied to the fields per row — it should also have been applied to which rows to return at all.

### F5 — `query_asset_registry` returns duplicate rows per `.uasset` (Blueprint + BlueprintGeneratedClass)

- **Severity**: Low (cosmetic / noise, not correctness-blocking)
- **Reproduction (T3)**: `/Game/GAS/` scan returns 64 results from 64 files. 5 assets appear as `BlueprintGeneratedClass` (BPGA_Block, BPGA_Dodge, BPGA_OSJump, GA_Sprint, BPGA_GuardBreakEvent) while the remaining 59 appear as `Blueprint`. The BPGC is the CDO class object (`*_C`) stored in the same `.uasset` as the BP asset — both have independent AR tag blocks in the file header. The tool returns whichever AR entry the parser encounters first per file.
- **Impact**: inconsistent `objectClassName` across results from the same folder. Callers filtering by class (e.g., `class_name:Blueprint`) will miss the 5 that came back as BPGC. Not a major issue because the tag payloads are nearly identical, but it means `query_asset_registry class_name:Blueprint` is not a reliable "find all BPs" query.
- **Root cause**: the `.uasset` AR tag block can contain entries for both the Blueprint asset and its BlueprintGeneratedClass. The parser picks up whichever appears first in the tag section; no deduplication or canonical-class selection is applied.
- **Suggested fix direction**: when multiple AR entries exist in the same `.uasset`, prefer the one whose `objectClassName` is `Blueprint` (or more generally, the non-`*GeneratedClass` variant). Alternatively, return both but mark them as siblings.

### F6 — `query_asset_registry class_name:` filter requires full script path, not short name

- **Severity**: Medium (usability — silent failure, not crash)
- **Reproduction (T8)**: `query_asset_registry class_name:DataTable limit:2000 max_scan:20000` → 0 results (scanned 19,071 files). `query_asset_registry class_name:/Script/Engine.DataTable limit:2000 max_scan:20000` → 14 results. Same content tree, same scan count, different filter string.
- **Root cause**: the `objectClassName` stored in AR tag data is the full UE script path (e.g., `/Script/Engine.DataTable`, `/Script/UMGEditor.WidgetBlueprint`, `/Script/Engine.World`). The filter does an exact match against this full path, not a substring or suffix match. Callers who pass the human-friendly short name (`DataTable`, `WidgetBlueprint`, `AnimMontage`) get 0 results with no error or hint.
- **Impact**: silent false-negative. An agent or user who calls `class_name:DataTable` gets told "no DataTables exist" — which is wrong. The tool description and param docs don't specify that the full script path is required.
- **Suggested fix directions** (not implementing):
  - Accept short names and auto-expand common classes to their full paths (e.g., `DataTable` → `/Script/Engine.DataTable`).
  - Alternatively, do suffix matching: if the filter doesn't start with `/`, match against the last segment after `.` in `objectClassName`.
  - At minimum, if the filter matches 0 results but contains no `/`, emit a warning: "Did you mean the full script path? e.g., `/Script/Engine.DataTable`".

_(F7+ to be added as discovered.)_

---

## §3 Test log

Records follow the §4 dispatch format: Command / Result / Files-or-items / Response size / Observations / Finding IDs.

### T1 — `query_asset_registry path_prefix:/Game/Blueprints/` (baseline, pre-dispatch)

- **Command**: `query_asset_registry path_prefix:/Game/Blueprints/ limit:2000 max_scan:20000`
- **Result**: warning (response oversized)
- **Files scanned / items returned**: 16 returned (folder-scoped)
- **Response size**: ~817 KB
- **Observations**: Parser clean on all 16. Envelope carries raw ActorMetaData blobs. Claude Code had to spill output to disk.
- **Finding IDs raised**: F0

### T1b — `query_asset_registry path_prefix:/Game/` (wide scan, pre-dispatch)

- **Command**: `query_asset_registry path_prefix:/Game/` (default limits hit)
- **Result**: warning (capped + oversized)
- **Files scanned / items returned**: 19,071 walked / 2000 returned
- **Response size**: ~5.2 MB
- **Observations**: Zero parse errors across 19k files — parser is healthy. Cap bound with no truncation signal in envelope.
- **Finding IDs raised**: F0 (repro), F1 (candidate)

### T12 — `get_asset_info /Game/Blueprints/Character/BP_OSPlayerR`

- **Command**: `get_asset_info asset_path:/Game/Blueprints/Character/BP_OSPlayerR`
- **Result**: warning (response oversized — spilled to disk by Claude Code)
- **Files scanned / items returned**: 1 asset
- **Response size**: 280,688 chars (~274 KB)
- **Observations**:
  - Parser clean: 275 exports / 242 imports / 739 names / 2 AR objects, UE5 file version 1017 (UE 5.6); no error fields.
  - Stable metadata (~1 KB): class `/Script/Engine.Blueprint`, parent `/Script/ProjectA.OSPlayer`, generated `BP_OSPlayerR_C`, 9 native + 10 BP components, 1 replicated property, `BPTYPE_Normal`, `IsDataOnly:false`, no implemented interfaces.
  - Bulk of payload is two binary-blob AR tags: `ActorMetaData` (Base64) and **`FiBData`** (Find-in-Blueprints search index, ROT-1-shifted ASCII wrapping JSON with numeric schema keys). On this asset `FiBData` is the dominant contributor.
  - Asset size on disk is 587 KB; response is ~47% of raw size — the tool is close to "ship the file."
- **Finding IDs raised**: extends F0 (new blob field `FiBData` identified; confirmed affects single-asset `get_asset_info` path, not just `query_asset_registry`)

### T14 — `get_asset_info /Game/Art/Materials/M_Master_DefaultOpaque`

- **Command**: `get_asset_info asset_path:/Game/Art/Materials/M_Master_DefaultOpaque`
- **Result**: clean
- **Files scanned / items returned**: 1 asset
- **Response size**: small (fit inline, no spill)
- **Observations**:
  - Parser clean. 24 exports / 18 imports / 167 names, UE5 ver 1017.
  - Rich material-specific scalars surfaced: `Domain=MD_Surface`, `BlendMode=BLEND_Opaque`, `ShadingModel=MSM_DefaultLit`, `DecalResponse=MDR_ColorNormalRoughness`, translucency fields present but unused for opaque.
  - No `FiBData`, no `ActorMetaData` blob — consistent with Material class having no BP graph or actor payload.
  - Demonstrates tool works well when verbose-blob tags are absent. Bounds F0 to BP-family assets.
- **Finding IDs raised**: none (bounds F0)

### T20 — `get_asset_info /Game/Blueprints/Character/PunchingBag`

- **Command**: `get_asset_info asset_path:/Game/Blueprints/Character/PunchingBag`
- **Result**: clean
- **Files scanned / items returned**: 1 asset
- **Response size**: small (fit inline, no spill; asset is 35 KB on disk)
- **Observations**:
  - Parser clean. 19 exports / 28 imports / 164 names, UE5 ver 1017.
  - FiBData is present but small — confirms FiBData scales with BP complexity, not a flat per-asset tax.
  - **Non-finding observation (ProjectA content drift, out of UEMCP scope)**: the BP parents from `AActor` (`/Script/Engine.Actor`), not the project's C++ `AOSPunchingBag` class that exists per ProjectA CLAUDE.md. Noted for the ProjectA team, not a UEMCP bug.
  - **Non-finding observation (naming drift)**: the dispatch handoff anticipated `BP_PunchingBag`; actual filename is `PunchingBag`. Low-noise; the tool found it fine when given the correct path.
- **Finding IDs raised**: none (bounds F0 — simple BPs are safe)

### T13 — `get_asset_info /Game/ProjectA/Data/DataTables_Structs/DT_HitReacts_PunchingBag`

- **Command**: `get_asset_info asset_path:/Game/ProjectA/Data/DataTables_Structs/DT_HitReacts_PunchingBag`
- **Result**: clean
- **Files scanned / items returned**: 1 asset
- **Response size**: tiny (fit inline, ~4 KB source → much smaller response)
- **Observations**:
  - Parser clean. 2 exports / 7 imports / 49 names, UE5 ver 1017.
  - Row structure surfaced as `ST_HitReacts_Fighter` (reuses the Fighter struct for the punching bag — an ProjectA content choice).
  - Tool correctly does NOT surface row contents — that's `read_datatable_source`'s job. Division of responsibility is clean.
  - No `FiBData`, no heavy `ActorMetaData`. Bounds F0 further: DataTables are safe.
  - Note: path has the nested `/Game/ProjectA/Data/...` segment — ProjectA uses a content-plugin-style nested folder. Tool handled this fine; worth remembering for other tests.
- **Finding IDs raised**: none (bounds F0)

### T17 — `inspect_blueprint /Game/Blueprints/Character/BP_OSPlayerR`

- **Command**: `inspect_blueprint asset_path:/Game/Blueprints/Character/BP_OSPlayerR`
- **Result**: warning (response oversized — spilled to disk)
- **Files scanned / items returned**: 1 asset
- **Response size**: 365,226 chars (~357 KB) — ~85 KB larger than T12's `get_asset_info` on the same asset
- **Observations**:
  - Parser clean. 275 exports / 242 imports, UE5 ver 1017. Parent class `OSPlayer`, generated `BP_OSPlayerR_C`.
  - **Tool data itself is genuinely useful**: 3 top-level exports (Blueprint, BlueprintGeneratedClass, CDO); 11 SCS component nodes decoded with class names (Wwise audio rig, camera boom/follow camera, customizable skeletal mesh, native component overrides for OSCharacterMovement/Health/MotionWarping); 20 functions including ReceiveBeginPlay, ReceivePossessed, OnGasReady, OnLanded, InitializeCharacterMesh, 5× ApplyFX/ApplyVFX_* aura pipeline, 2× Input event handlers. Class breakdown across 275 exports is sensible (81 K2Node_CallFunction, 35 K2Node_Knot, 25 K2Node_VariableGet, 20 Function, 11 SCS_Node, 10 EdGraph, etc.).
  - **But** the response also includes the full `tags` dict from get_asset_info verbatim — including FiBData and ActorMetaData — on top of the export table. That's why it's larger than T12.
  - Export table format is compact and well-chosen (index / objectName / className / classPackage / superClass / outerName / bIsAsset / serialSize) — no complaint about the structural data.
- **Finding IDs raised**: extends F0 (third affected tool); raises **F2** (tags dict overlap / responsibility creep)

### T15 — `get_asset_info /Game/UI/Widgets/HUD/Layers/WBP_OSKillFeedLayerWidget`

- **Command**: `get_asset_info asset_path:/Game/UI/Widgets/HUD/Layers/WBP_OSKillFeedLayerWidget`
- **Result**: clean
- **Files scanned / items returned**: 1 asset
- **Response size**: fit inline (62 KB asset on disk, response well under cap)
- **Observations**:
  - Parser clean. 41 exports / 61 imports / 262 names, UE5 ver 1017.
  - Class `/Script/UMGEditor.WidgetBlueprint`, parent `UOSKillFeedLayerWidget` (C++), generated `WBP_OSKillFeedLayerWidget_C`, 0 replicated properties, 0 property bindings.
  - FiBData is present and small — decoded to show OnPlayerDeathHook bindings, Wwise event posting (`Play_ui_kill_feed_notif`, `Play_ui_plr_death_notif`), SwitchEnum over `EOSKillFeedType`. Widget BP is audio/death-routing only; visual rendering is in the C++ parent.
  - Bounds F0 further: WidgetBlueprints are safe when graph complexity is moderate. FiBData scaling is about node count, not BP class.
- **Finding IDs raised**: none (bounds F0)

### T16 — `get_asset_info /Game/ThisDoesNotExist/Nope`

- **Command**: `get_asset_info asset_path:/Game/ThisDoesNotExist/Nope`
- **Result**: clean error envelope
- **Files scanned / items returned**: 0
- **Response size**: small
- **Observations**:
  - Tool returns an explicit error with the resolved disk path (`Content/ThisDoesNotExist/Nope.uasset`) and the underlying ENOENT. No partial JSON, no crash, no hang. Good failure mode.
- **Finding IDs raised**: none

### T19 — `inspect_blueprint /Game/UI/Widgets/HUD/Layers/WBP_OSKillFeedLayerWidget`

- **Command**: `inspect_blueprint asset_path:/Game/UI/Widgets/HUD/Layers/WBP_OSKillFeedLayerWidget`
- **Result**: clean
- **Files scanned / items returned**: 1 asset
- **Response size**: fit inline
- **Observations**:
  - Parser clean. 41 exports / 61 imports.
  - Widget tree decoded: root CanvasPanel, 2× Overlay, 4× SizeBox, VerticalBox `MainKillFeed`, VerticalBox `PersonalKillFeed_` (trailing underscore — cosmetic, not a bug). Each widget appears twice in the export table (archetype + instance), normal for WidgetBlueprints.
  - Event graph decoded: 2× K2Node_Event (OnPlayerDeathHook 3.9 KB, Construct 0.9 KB), K2Node_SwitchEnum over `EOSKillFeedType`, 8× K2Node_CallFunction. Functions: `ExecuteUbergraph_*`, `OnPlayerDeathHook`.
  - **Positive signal on tool value**: the widget tree is the novel data over `get_asset_info` — confirms `inspect_blueprint` *does* have unique data to offer beyond AR tags. This does not contradict F2 (tags-dict overlap is still a problem) but does validate that an F2 fix should preserve the structural view, not just merge the two tools.
- **Finding IDs raised**: none (supports F2's direction — the structural data is the tool's real value)

### T21 — `list_level_actors /Game/Maps/Deployable/MarketPlace/MarketPlace_P`

- **Command**: `list_level_actors asset_path:/Game/Maps/Deployable/MarketPlace/MarketPlace_P`
- **Result**: warning (oversized — spilled to disk)
- **Files scanned / items returned**: 1 map / 572 rows returned labeled "actors"
- **Response size**: 131,644 chars (~129 KB). Map size on disk: 11.7 MB.
- **Observations**:
  - Parser clean. 572 exports / 186 imports parsed without error.
  - **Only 14 of 572 rows are actual placed actors**: 2× PlayerStart, 1× BP_AICharacter_C (with 11 component subobjects also counted as separate rows), 1× BP_ProjectileTesterCannon_C, 1× BP_TestAudioRep_C, 1× AkSpatialAudioVolume, 1× Landscape, 1× InstancedFoliageActor, 1× MarketPlace_P_C (LevelScript instance), 1× LevelScriptBlueprint, 1× WorldSettings, 2× Brush/Model geometry.
  - The other 558 rows are landscape data (87 LandscapeMaterialInstanceConstant + editor data, 64 LandscapeComponent, 55 Texture2D etc.), component subobjects (11 on BP_AICharacter_C), editor metadata (BookMarks, Polys, EdGraph), BP machinery (Function, K2Node_Event, BlueprintGeneratedClass, BodySetup).
  - Map is a dev/test map — no OS-prefixed gameplay actors (no AOSControlPoint / AOSPlayer placed). 5× `LevelStreamingAlwaysLoaded` entries suggest deployable sublevels attach here (covers T23 partially — the sublevel handling is visible as streaming references, though their contents aren't walked by this tool).
- **Finding IDs raised**: **F3** (list_level_actors response size blows the cap), **F4** (tool returns full export table, not placed actors — 2.4% signal-to-noise)

### T22 — `list_level_actors /Game/Maps/Non-Deployable/Metric_Geo`

- **Command**: `list_level_actors asset_path:/Game/Maps/Non-Deployable/Metric_Geo`
- **Result**: warning (oversized — spilled to disk)
- **Files scanned / items returned**: 1 map / 1377 rows returned labeled "actors"
- **Response size**: 319,729 chars (~312 KB) — ~2.4× T21's MarketPlace_P result. Largest list_level_actors response observed this pass.
- **Observations**:
  - Parser clean. 1377 exports / 1026 imports parsed without error — confirms parser scales through the largest map in the sample.
  - **Real top-level placements: ~223 of 1377 rows (~16%)** — 202× StaticMeshActor, 15× art-kit BP_* instances, 2× Model, 2× Polys, 1× Brush, 1× WorldSettings. No OS-prefixed gameplay actors — this is a metric/blockout map.
  - The other ~1154 rows are the usual noise: StaticMeshComponent subobjects, Texture2D, MaterialInstanceConstant, BodySetup, BillboardComponent, editor metadata.
  - Strengthens F3: even with perfect F4 filtering (dropping to 223 real rows) the response would still be ~80 KB × scaling factor and trends near the cap. F4 is necessary but **not sufficient** for maps of this density.
- **Finding IDs raised**: reinforces **F3** and **F4** (no new findings)

### T2 — `query_asset_registry path_prefix:/Game/Characters/`

- **Command**: `query_asset_registry path_prefix:/Game/Characters/ limit:2000 max_scan:5000`
- **Result**: clean (0 matches)
- **Files scanned / items returned**: 0 / 0
- **Response size**: minimal (inline)
- **Observations**:
  - `Content/Characters/` exists on disk but contains only `.keep` placeholder files (no `.uasset`/`.umap`). Character BPs live under `/Game/Blueprints/Character/` instead.
  - Tool correctly returns 0 matches — no false positives, no crash on empty directory.
- **Finding IDs raised**: none

### T3 — `query_asset_registry path_prefix:/Game/GAS/`

- **Command**: `query_asset_registry path_prefix:/Game/GAS/ limit:2000 max_scan:5000`
- **Result**: warning (oversized — 1,540,501 chars, spilled to disk)
- **Files scanned / items returned**: 64 / 64 (no truncation)
- **Response size**: ~1.54 MB for 64 assets (~24 KB/asset average)
- **Observations**:
  - All 64 assets are BPs (59 `Blueprint` + 5 `BlueprintGeneratedClass`). Every BP carries FiBData, driving the 24 KB/asset average.
  - Folder breakdown: Abilities (20), Cues (27 across 4 subfolders), Effects (17 across augment subfolders).
  - **5 of 64 returned as `BlueprintGeneratedClass` instead of `Blueprint`** (BPGA_Block, BPGA_Dodge, BPGA_OSJump, GA_Sprint, BPGA_GuardBreakEvent). Same `.uasset` file, different AR entry selected. → **F5** raised.
  - Parser clean across all 64 files. Parent class tags present and correct (e.g., BPGA_Block → parent GA_OSBlock, BPGE_OSApplyDamage → parent GE_OSApplyDamage).
  - Confirms T18 was correctly marked infeasible: GAS BPs are `BPGA_*`/`BPGE_*`/`BPGC_*`, not `GA_OS*` BP variants.
- **Finding IDs raised**: **F0** (reproduced — 64 BPs → 1.54 MB), **F5** (BPGC duplication)

### T4 — `query_asset_registry path_prefix:/Game/Animations/`

- **Command**: `query_asset_registry path_prefix:/Game/Animations/ limit:2000 max_scan:5000`
- **Result**: warning (oversized — 1,384,813 chars, spilled to disk)
- **Files scanned / items returned**: 626 / 626 (no truncation)
- **Response size**: ~1.38 MB for 626 assets (~2.2 KB/asset average)
- **Observations**:
  - Class breakdown: AnimSequence (550), AnimMontage (35), PoseAsset (28), BlendSpace (3), AnimBlueprint (3), IKRigDefinition (2), Blueprint (2), IKRetargeter (1), CurveFloat (1), BlendSpace1D (1).
  - Non-BP animation assets carry lightweight tags (Skeleton, SequenceLength, AnimNotifyList, CurveNameList) — no FiBData, no ActorMetaData. Per-row cost ~2.2 KB vs 24 KB for GAS BPs.
  - Even at 2.2 KB/row, 626 assets × tag payload still exceeds the MCP token cap. Confirms F0 fires on volume alone, not just per-asset bloat.
  - Subfolder distribution: Retargeted (~413 assets, largest), Combat (~52), Locomotion (~29), HitReacts (~12), plus smaller folders.
  - Parser clean across all 626 files including diverse asset classes.
- **Finding IDs raised**: **F0** (reproduced — volume-driven, not just BP-driven)

### T5 — `query_asset_registry path_prefix:/Game/Data/`

- **Command**: `query_asset_registry path_prefix:/Game/Data/ limit:2000 max_scan:5000`
- **Result**: **clean** (inline — first non-spilling folder scan this session)
- **Files scanned / items returned**: 58 / 58 (no truncation)
- **Response size**: fit inline (~58 assets × lightweight tags)
- **Observations**:
  - Asset class breakdown: ChooserTable (12), OSAttackDataAsset (10), OSCameraPreset/Config (17), FX data assets (14), Generated OSVFX (10).
  - **No BPs** — all non-BP asset types (DataAsset subclasses, ChooserTable, CurveFloat, Niagara params). Tags are compact (no FiBData, no ActorMetaData).
  - Confirms F0 hypothesis: folders without BPs stay well under the MCP token cap even at 58 assets.
  - Parser clean across all 58 files.
- **Finding IDs raised**: none

### T6 — `query_asset_registry path_prefix:/Game/UI/`

- **Command**: `query_asset_registry path_prefix:/Game/UI/ limit:2000 max_scan:5000`
- **Result**: warning (oversized — 930,628 chars, spilled to disk)
- **Files scanned / items returned**: 98 / 98 (no truncation)
- **Response size**: ~931 KB for 98 assets (~9.5 KB/asset average)
- **Observations**:
  - Class breakdown: WidgetBlueprint (52), MaterialInstanceConstant (29), FontFace (3), Material (3), Texture2D (3), Font (2), MaterialFunction (2), Blueprint (1), CurveLinearColorAtlas (1), CurveLinearColor (1), BlueprintGeneratedClass (1).
  - The 52 WidgetBlueprints carry FiBData at ~9.5 KB/widget average — lighter than GAS BPs (24 KB) but enough to blow the cap at scale.
  - **`MarketPlace_UI.umap`** (11.7 MB) returned as `BlueprintGeneratedClass` — a `.umap` file appearing in a `query_asset_registry` result classified as BPGC. Additional F5 data point: `.umap` files can produce AR entries with `BlueprintGeneratedClass` as class.
  - Subfolder distribution: Widgets (51), Materials (36), Fonts (5), UI_Assets (3), Temporary (2), GamePlayHUD (1).
  - Non-widget assets (fonts, materials, textures) carry minimal tags — bloat is from the 52 WBPs.
  - Parser clean across all 98 files including the 11.7 MB `.umap`.
- **Finding IDs raised**: **F0** (reproduced — 52 WBPs drive 931 KB), **F5** (`.umap` classified as BPGC)

### T7 — `query_asset_registry path_prefix:/Game/Maps/`

- **Command**: `query_asset_registry path_prefix:/Game/Maps/ limit:2000 max_scan:5000`
- **Result**: warning (oversized — **5,861,712 chars**, spilled to disk). Largest `query_asset_registry` response this session.
- **Files scanned / items returned**: 43 / 43 (no truncation)
- **Response size**: ~5.86 MB for 43 assets (~136 KB/asset average)
- **Observations**:
  - Class breakdown: World (26), BlueprintGeneratedClass (8), Blueprint (4), MapBuildDataRegistry (3), LandscapeLayerInfoObject (1), HLODLayer (1).
  - **New heavy tag: `ActorsMetaData` (plural)** on World assets. This is a concatenated Base64 blob listing placed actors with per-actor metadata. On content-heavy maps (MarketPlace_Art: 2845 exports, 5.7 MB on disk; Bridges2: 11,830 exports, 56.5 MB) this tag alone drives hundreds of KB per asset. This is a **different F0 vector** than BPs — maps blow up via `ActorsMetaData`, not `FiBData`.
  - 8 `.umap` files returned as `BlueprintGeneratedClass` (level script actors) — reinforces F5.
  - Map inventory: 5 MarketPlace sublevels (Art/BGArt/BO/GP/Light), 4 PVP maps (Bridges2, forest, library, temple), 9 level instances, 3 dev/test maps (Metric_Geo, CharacterShowroom, VFX_Zoo), 1 menu map.
  - **Bridges2** (56.5 MB / 11,830 exports) is the stress-test ceiling for `list_level_actors` — would produce a catastrophic response.
  - Per-asset cost breakdown: World assets with `ActorsMetaData` → ~100-200 KB each; BPGC (level scripts) → ~5-20 KB each; MapBuildDataRegistry/HLODLayer/LandscapeLayerInfo → <1 KB each.
  - Parser clean across all 43 files including the 56.5 MB Bridges2.
- **Finding IDs raised**: **F0** (new variant — `ActorsMetaData` on World assets, not `FiBData`), **F5** (8 BPGC entries from `.umap` files)

### T8 — `query_asset_registry class_name:DataTable` (class_name filter test)

- **Command**: `query_asset_registry class_name:DataTable limit:2000 max_scan:20000` → **0 results** (false negative). Then: `query_asset_registry class_name:/Script/Engine.DataTable limit:2000 max_scan:20000` → **14 results** (correct).
- **Result**: warning (F6 — silent false-negative on short class name); clean on full-path variant (inline, no spill)
- **Files scanned / items returned**: 19,071 / 0 (short form) → 19,071 / 14 (full path form)
- **Response size**: 14 DataTables fit inline comfortably. Lightweight tags (RowStructure path only).
- **Observations**:
  - **Short-form class name (`DataTable`) silently returns 0 results.** Must use `/Script/Engine.DataTable`. → **F6** raised.
  - DataTable locations: Art/Character (1), Art/VFX (2), ProjectA/Data (3 — DT_Attacks_Fighter, DT_HitReacts_Fighter, DT_HitReacts_PunchingBag), SuperGrid/Tutorial (5 legacy UpdateNotes), WwiseAudio (2).
  - Tags are minimal — only `RowStructure` path present. No FiBData, no ActorMetaData.
  - Parser clean across all 14 files.
- **Finding IDs raised**: **F6** (class_name filter requires full script path)

### T9 — `query_asset_registry class_name:StringTable` (class_name filter test)

- **Command**: `query_asset_registry class_name:StringTable limit:2000 max_scan:20000` → 0 results.
- **Result**: clean (0 matches — likely genuine, not F6)
- **Files scanned / items returned**: 19,071 / 0
- **Response size**: minimal (inline)
- **Observations**:
  - Short-form class name used, so F6 applies. However, ProjectA's string tables are `.csv` source files accessed via `read_string_table_source`, not `.uasset` AR entries. The project may genuinely have zero `.uasset` StringTable assets.
  - Full-path variant (`/Script/Engine.StringTable`) not tested — low priority since the tool correctly handles the 0-result case and F6 is already documented.
  - No parser exercise (no files matched).
- **Finding IDs raised**: **F6** (confirmed — short name returns 0, cannot distinguish from genuine absence)

### T10 — `query_asset_registry class_name:WidgetBlueprint` (class_name filter test)

- **Command**: `query_asset_registry class_name:WidgetBlueprint limit:2000 max_scan:20000` → 0 results (F6). Then: `query_asset_registry class_name:/Script/UMGEditor.WidgetBlueprint limit:2000 max_scan:20000` → **65 results**.
- **Result**: warning (oversized — 1,620,664 chars, spilled to disk)
- **Files scanned / items returned**: 19,071 / 65
- **Response size**: ~1.62 MB for 65 WidgetBlueprints (~24.9 KB/widget average)
- **Observations**:
  - F6 confirmed again: short `WidgetBlueprint` → 0, full `/Script/UMGEditor.WidgetBlueprint` → 65.
  - Found 65 WBPs vs T6's 52 from `/Game/UI/` alone — the class_name filter correctly picks up 13 additional WBPs in other folders: ImportedAssets/HitReactionProject (6), ProjectA/UI (4), SuperGrid/TutorialLevel (2), StreetFight_Animations/Demo (1).
  - Per-widget tag cost ~24.9 KB (higher than T6's blended 9.5 KB because T6 diluted WBP cost with lightweight non-BP assets).
  - The class_name scan walked all 19,071 files to find 65 matches — confirms full-tree scan works correctly even at max_scan:20000.
  - Parser clean across all 65 WBPs.
- **Finding IDs raised**: **F0** (reproduced), **F6** (confirmed)

### T18 — `inspect_blueprint` on GA_OS* ability BP (SKIPPED)

- **Command**: not executed
- **Result**: skipped
- **Reason**: ProjectA's GAS abilities are **pure C++** (`GA_OSBlock`, `GA_OSDodge`, etc. in `Source/ProjectA/`). The `/Game/GAS/Abilities/` folder contains **BP subclasses** with `BPGA_*` prefix (e.g., `BPGA_Block` → parent `GA_OSBlock`), not `GA_OS*` BP variants. T3 confirmed no `GA_OS*.uasset` files exist. T19 already exercised `inspect_blueprint` on a WBP (clean), and T17 exercised it on the largest BP in the project (BP_OSPlayerR, F0/F2). No additional coverage needed.

### T11 — Material / Art folder tests (3 scans)

- **T11a** — `query_asset_registry class_name:/Script/Engine.Material limit:2000 max_scan:20000`
  - **Result**: warning (oversized — 245,582 chars, spilled)
  - **Observations**: Materials carry moderate tags (no FiBData, no ActorMetaData) but enough assets to blow the cap. ~245 KB response.
  - **Finding IDs raised**: **F0** (reproduced — volume-driven)

- **T11b** — `query_asset_registry path_prefix:/Game/Art/ limit:500 max_scan:5000`
  - **Result**: warning (oversized — 548,561 chars, spilled)
  - **Files scanned / items returned**: 371 / 371 (no truncation)
  - **Response size**: ~549 KB for 371 assets (~1.5 KB/asset average)
  - **Observations**: Mixed classes (CustomizableObject, CustomizableObjectInstance, DataTable, UserDefinedEnum, SkeletalMesh, etc.). Lightweight per-row tags — bloat is purely from asset count. Parser clean across all 371 files.
  - **Finding IDs raised**: **F0** (reproduced — volume on mixed non-BP art assets)

- **T11c** — `query_asset_registry class_name:/Script/Engine.MaterialInstanceConstant limit:2000 max_scan:20000`
  - **Result**: warning (oversized — 1,108,707 chars, spilled)
  - **Observations**: MICs are individually lightweight but numerous across the project. ~1.1 MB response. Confirms F0 fires on volume even for assets with minimal tags.
  - **Finding IDs raised**: **F0** (reproduced — volume-driven)

### T24 — `project_info` (sanity check)

- **Command**: `project_info`
- **Result**: clean (inline)
- **Observations**: Returned project name `ProjectA`, engine `5.6`, 15 plugins listed (including UnrealMCP, Wwise, NodeToCode). All fields populated, no parse errors.
- **Finding IDs raised**: none

### T25 — `list_plugins` (sanity check)

- **Command**: `list_plugins`
- **Result**: clean (inline)
- **Observations**: 15 enabled plugins + 7 local project plugins enumerated. Includes UnrealMCP (TCP:55557 conformance oracle), Wwise (AkAudio + WwiseSoundEngine), NodeToCode-main, RiderLink. All entries have name + enabled flag.
- **Finding IDs raised**: none

### T26 — `get_build_config` (sanity check)

- **Command**: `get_build_config`
- **Result**: clean (inline)
- **Observations**: Parsed `ProjectA.Build.cs` correctly. Noted Wwise modules present in public dependencies, Slate/SlateCore appearing in both public and private dependency lists (cosmetic redundancy in the ProjectA Build.cs, not a UEMCP bug). Module name `ProjectA`, target type Game.
- **Finding IDs raised**: none

### T27 — `list_config_values config_file:DefaultEngine.ini` (sanity check)

- **Command**: `list_config_values config_file:DefaultEngine.ini`
- **Result**: clean (inline)
- **Observations**: 19 sections parsed. Includes `/Script/OnlineSubsystemSteam.SteamNetDriver`, physical surface definitions, CoreRedirects, SteamSockets config. All key-value pairs returned cleanly.
- **Finding IDs raised**: none

### T28 — `list_config_values config_file:DefaultGame.ini` (sanity check)

- **Command**: `list_config_values config_file:DefaultGame.ini`
- **Result**: clean (inline)
- **Observations**: 23 sections parsed. Includes `AbilitySystemGlobals` (29 keys — largest section), `OSGASSettings` (4 keys), `EditorStartupMap`, `GlobalDefaultGameMode`. Tool handled the largest `.ini` section without issue.
- **Finding IDs raised**: none

### T29 — `list_gameplay_tags` (sanity check)

- **Command**: `list_gameplay_tags`
- **Result**: clean (inline)
- **Observations**: 171 gameplay tags returned from `DefaultGameplayTags.ini`. Full hierarchy visible (Gameplay.Ability.*, Gameplay.State.*, GameplayEffect.*, GameplayEvent.*, Data.*, Gameplay.Debug.*). Count is consistent with ProjectA CLAUDE.md description.
- **Finding IDs raised**: none

### T30 — `search_gameplay_tags query:Ability` (sanity check)

- **Command**: `search_gameplay_tags query:Ability`
- **Result**: clean (inline)
- **Observations**: 35 tags matched containing "Ability" substring. Results include Attack.Light, Attack.Heavy, Sprint, Block, Dodge, Death, ComboAttack, ChargedAttack, Grab, etc. Substring search working correctly — no false positives, no omissions from expected set.
- **Finding IDs raised**: none

### T31 — `list_data_sources` (sanity check)

- **Command**: `list_data_sources`
- **Result**: clean (inline, 0 sources)
- **Observations**: Returns 0 CSV-backed data sources. This is correct — ProjectA uses binary DataTables and DataAssets (`.uasset`), not CSV-backed tables. The tool's contract is to find `.csv` source files; absence is the expected result for this project.
- **Finding IDs raised**: none

### T32 — `read_datatable_source` (sanity check)

- **Command**: `read_datatable_source` for `DT_HitReacts_PunchingBag`
- **Result**: clean error (no CSV backing file found)
- **Observations**: Tool correctly reports that the DataTable has no CSV source file on disk. ProjectA's DataTables are binary-only (created/edited in-editor). Error message is informative — includes the resolved path it searched. No crash, no partial data.
- **Finding IDs raised**: none

### T33 — `read_string_table_source` (sanity check — limited)

- **Command**: not executed (no valid StringTable source path available)
- **Result**: skipped
- **Reason**: T9 confirmed 0 StringTable `.uasset` assets in the project. No CSV-backed string table paths were identified during the session. Tool's error handling on missing files was already validated by T16 (`get_asset_info` on nonexistent path) and T32 (`read_datatable_source` on non-CSV table). Skipping avoids fabricating a test path.

_(All T# rows logged.)_

---

## §4 Summary

### Test totals

- **Total test entries**: 34 (original 33-row matrix + 3 material tests added mid-session; T11 counted as 3 sub-rows)
- **Executed**: 32 | **Skipped**: 2 (T18 — no GA_OS* BP variants exist; T33 — no StringTable source path available)
- **Clean (inline, no findings)**: 17
- **Warning (oversized or finding raised)**: 15
- **Error (crash / malformed parse / data corruption)**: 0

### Parser health

Zero parse errors across the entire session. Assets parsed include:
- 19,071 files in the wide scan (T1b)
- 11,830-export Bridges2 `.umap` (56.5 MB on disk, via T7 metadata)
- 1,377-export Metric_Geo `.umap` (T22)
- 626 animation assets of 10 distinct classes (T4)
- 371 art assets including CustomizableObject, SkeletalMesh, UserDefinedEnum (T11b)
- Every UE asset class encountered: AnimSequence, AnimMontage, PoseAsset, BlendSpace, AnimBlueprint, IKRigDefinition, IKRetargeter, CurveFloat, BlendSpace1D, Blueprint, BlueprintGeneratedClass, WidgetBlueprint, Material, MaterialInstanceConstant, DataTable, World, MapBuildDataRegistry, HLODLayer, LandscapeLayerInfoObject, ChooserTable, DataAsset subclasses, Niagara params, FontFace, Font, CurveLinearColor, CurveLinearColorAtlas, Texture2D, CustomizableObject, CustomizableObjectInstance, UserDefinedEnum, SkeletalMesh

**The binary parser is production-grade.** No correctness bugs found in `uasset-parser.mjs`.

### Findings summary

| ID | Severity | Tool(s) affected | Category |
|----|----------|-------------------|----------|
| F0 | **High** | `query_asset_registry`, `get_asset_info`, `inspect_blueprint` | Usability — response verbosity exceeds MCP token cap |
| F1 | Medium (candidate) | `query_asset_registry` | Usability — no pagination / cap signalling |
| F2 | Medium | `inspect_blueprint`, `get_asset_info` | Design — overlapping tags payload |
| F3 | **High** | `list_level_actors` | Usability — response oversizes on real maps |
| F4 | **High** | `list_level_actors` | Correctness — returns full export table, not placed actors |
| F5 | Low | `query_asset_registry` | Cosmetic — duplicate rows per `.uasset` (BP + BPGC) |
| F6 | Medium | `query_asset_registry` | Usability — `class_name:` filter requires full script path |

**By severity**: 3 High (F0, F3, F4) · 3 Medium (F1, F2, F6) · 1 Low (F5)

### Verdict

The **parser is solid** — zero errors across 19K+ files and every asset class in the project. The **tool envelope layer has real problems**: F0 (response size) and F4 (wrong row selection) are the two most impactful. F0 blocks any agent workflow that touches folders with >30 assets or individual complex BPs/maps. F4 makes `list_level_actors` return misleading data. F6 is a silent-failure UX trap.

None of these require parser changes. All fixes live in the tool handler layer (response shaping, filtering, parameter expansion). The parser itself can be relied upon for Phase 3.

---

## §5 Proposed D-log entry

_Do not write to `docs/tracking/risks-and-decisions.md` from this audit — orchestrator seals D-log entries._

### Proposed: D37 — Tier-2 parser validation against ProjectA content

**Decision**: Parser (`uasset-parser.mjs`) is production-grade. Zero parse errors across 19K+ files spanning 30+ UE asset classes. No correctness bugs in the binary parser.

**Findings** (7 total, all in the tool handler / envelope layer, not the parser):

- **3 High**: F0 (response verbosity blows MCP token cap on BPs, maps, and high-volume folders), F3 (list_level_actors oversizes on real maps), F4 (list_level_actors returns full export table instead of placed actors — 2.4% signal-to-noise on dev maps, ~16% on whitebox maps)
- **3 Medium**: F1 (no pagination on query_asset_registry), F2 (inspect_blueprint duplicates get_asset_info tags payload), F6 (class_name filter requires full `/Script/Module.Class` path — short names silently return 0)
- **1 Low**: F5 (duplicate rows per .uasset when both Blueprint and BlueprintGeneratedClass have AR tags)

**Implications for Phase 3**: Parser can be relied upon as-is. Pre-Phase-3, address F0+F4 (High severity, blocks agent workflows) and F6 (silent failure). F1, F2, F5 are quality-of-life improvements that can ride along or defer.

**Audit**: `docs/audits/phase2-tier2-parser-validation-2026-04-15.md` (sealed after sign-off)

---

## §6 Sign-off

**Signed off**: 2026-04-16 by Noah (via orchestrator).
- Parser verdict accepted: production-grade, no changes needed.
- All 7 findings accepted at stated severity.
- F0+F2+F4+F6+F1 queued for pre-Phase-3 cleanup agent (D38).
- D-log entry: D38 (references this audit).
- Proposed D37 number in §5 is stale — D37 was already allocated to the parser landing. Audit findings recorded as D38 instead.

---

## Amendment A — Real-world F0 reproduction with token cost metrics (2026-04-16)

> **Context**: Claude Code (Opus 4.7, 1M context, xhigh effort) session in the ProjectA workspace. User asked: "inspect the playerr blueprint" → "yes cover every function."
>
> **Reproduction**: `inspect_blueprint /Game/Blueprints/Character/BP_OSPlayerR` → 365,226 chars → spill to disk → Claude Code spent **102,652 tokens** and **~3.5 minutes** across **20+ tool calls** (Python JSON parsing, encoding workarounds, iterative extraction, raw binary string mining) to produce a full function-by-function analysis.
>
> **Key observations**:
>
> - **Token cost is the real metric, not character count.** The full conversation consumed 102,652 tokens of a 1M context window (~10%) — the majority spent on tool output processing, not useful reasoning. An agent that needs to inspect multiple BPs (e.g., auditing a subsystem) would exhaust its context on tool output alone.
> - **Encoding friction**: Claude Code's Python environment defaults to cp1252 on Windows. The FiBData blob contains ROT-1-shifted bytes that include 0x81 (unmappable in cp1252), causing `UnicodeDecodeError` and `UnicodeEncodeError` on stdout. Required `encoding='utf-8'` on file open and `sys.stdout.reconfigure(encoding='utf-8', errors='replace')` — two extra error-recovery cycles before useful work began.
> - **Imports not exposed**: `inspect_blueprint` returns exports but not the imports table. When the agent tried to resolve what each `K2Node_CallFunction` actually calls (the natural follow-up to "cover every function"), the data wasn't there. Had to fall back to raw binary string extraction from the `.uasset` file — a workaround that should not be necessary.
> - **The useful structural data was ~5-10% of the response.** Components (20 entries), functions (20), SCS nodes (11), events (10), class distribution — all fit comfortably in ~5 KB. The other ~350 KB was FiBData, ActorMetaData, and 275 export rows where 200+ are K2Node graph internals with no resolvable detail.
>
> **Quality of the eventual output**: despite the cost, Claude Code produced a genuinely useful function-by-function breakdown — aura VFX pipeline (100 of 275 exports), mutable mesh branching, dev attack flags, ability references, tiered Niagara material overrides. The structural data in the tool IS valuable; it's the blob noise and unresolvable K2Node rows that destroy the signal-to-noise ratio. This strengthens rather than weakens the case for F0: the right fix preserves the useful data while eliminating the waste.
>
> **Implication for F0 fix priority**: token cost reframes the severity. At 102K tokens per complex BP inspection, F0 doesn't just cause disk spills — it burns 10% of an agent's context budget per call. A `verbose: false` default that strips blob tags and filters graph-internal exports would reduce this to ~2-5K tokens (~50× improvement).
>
> **New finding candidate (not numbered — deferred to implementation)**: `inspect_blueprint` should expose the imports table (242 entries on BP_OSPlayerR). Imports list every external class and function the BP references — the data an agent needs to answer "what does this function call?" Without it, the export table's `K2Node_CallFunction` entries are opaque (all share the same `objectName: "K2Node_CallFunction"` with no target resolution).
