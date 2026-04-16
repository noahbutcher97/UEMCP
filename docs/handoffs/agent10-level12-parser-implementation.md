# Agent 10 Handoff — Level 1+2+2.5 Property Parser Implementation

> **Dispatch**: After Agent 8 (research audit), Agent 9 (tool surface design), **Agent 9.5 (verification pass)**, and Agent 11 (Level 3 feasibility) deliver. All delivered as of 2026-04-16.
> **Depends on**:
> - Agent 8 (`docs/research/uasset-parser-audit-and-recommendation.md`) — implementation approach + reference code (CUE4Parse port source, UAssetAPI validation oracle).
> - Agent 9 (`docs/research/level12-tool-surface-design.md`) — **Option C hybrid** decided. Three tool changes (see §Tool wiring).
> - **Agent 9.5** (`docs/research/level12-verification-pass.md`) — **4 implementation-critical corrections** verified against ProjectA fixtures. READ §6 of that doc before starting.
> - Agent 11 (`docs/research/level3-feasibility-study.md`) — Level 3 scope boundaries; your L2.5 simple-element container scope is authorized here.
> - D44 (yaml-as-truth): all tool description + param changes land in `tools.yaml` only; `server.mjs:offlineToolDefs` was eliminated.
> - **D45/D46/D47**: logged decisions framing your scope. D46 specifically authorizes L3B simple-element containers in *your* scope (not a follow-on agent).

> **D-log**: D39 (Level 1+2 before Phase 3), D44 (yaml-as-truth), D45 (L3A permanently editor-only), **D46 (L3B simple-element containers ship with you as L2.5)**, D47 (UUserDefinedStruct deferred to Agent 10.5+).

---

## Mission

Extend `server/uasset-parser.mjs` with:
- **Level 1**: FPropertyTag iteration — read tagged properties from export serialized data
- **Level 2**: Struct deserialization — handlers for ~10 common UE structs
- **Level 2.5 (per D46)**: Simple-element `TArray` and `TSet` properties — arrays/sets of scalars, Level 2 engine structs, enums, and gameplay tags

Then wire the property data into the three Option C tools per Agent 9's design.

**Explicit non-scope (do NOT attempt)**:
- `TMap<K,V>` container types — deferred to Agent 10.5 follow-on.
- `TArray<FMyCustomStruct>` complex-element containers — deferred (depends on D47 custom-struct resolver).
- Custom `UUserDefinedStruct` resolution — D47, deferred to Agent 10.5+.
- UEdGraph / K2Node parsing — permanently editor-only per D45; Agent 11.5 is studying a skeletal subset in parallel.

---

## File scope (strict)

| File | Action |
|------|--------|
| `server/uasset-parser.mjs` | **Primary** — add property reading + L3B container functions |
| `server/uasset-structs.mjs` | **New** — Level 2 struct handlers as a separate module (per Agent 8 §4 recommendation; keeps parser's dep graph clean) |
| `server/offline-tools.mjs` | Wire property data into tool responses; modify `listLevelActors` + `inspectBlueprint`; add `readAssetProperties` handler |
| `server/test-phase1.mjs` | Extend Test 9 pattern for the 3 tool changes |
| `server/test-uasset-parser.mjs` | Add parser-level property/struct/container correctness assertions (supplementary rotation — see CLAUDE.md) |
| `tools.yaml` | Per Option C: modify `list_level_actors` + `inspect_blueprint`; add new `read_asset_properties` entry. D44 contract — all params declared in yaml, no duplication in server.mjs |
| `server/server.mjs` | Add one registration block for `read_asset_properties` in the offline loop |

**Do NOT touch**: `tcp-tools.mjs`, `connection-manager.mjs`, `test-tcp-tools.mjs`, `test-mock-seam.mjs`, `plugin/`, `docs/specs/`, `docs/tracking/`. (D-log updates happen after your final report, via orchestrator.)

---

## Implementation guide

**Read these in order before writing code**:
1. Agent 8's recommendation §4 — reference projects, struct handlers, implementation order.
2. **Agent 9.5's verification pass §2 and §6** — the 4 implementation-critical corrections, cited inline below.
3. Agent 9's Option C design §4 "Recommendation" — tool signatures and response shapes.
4. Agent 11's L3B analysis — simple-element container scope.

### ⚠ Critical V9.5 corrections to absorb before coding

These are measured against ProjectA fixtures; do not dismiss them as nit-picks.

1. **Transform chain resolves via outerIndex reverse scan, NOT RootComponent ObjectProperty.** Agent 9 §4 described the chain as "placed actor → RootComponent ObjectProperty → component → transform." Empirical finding: only ~10% of placed actors serialize a `RootComponent` tag. The dominant path (90% of actors that have overridden transforms at all) is: scan the export table forward for entries whose `outerIndex` resolves to the actor's FPackageIndex; those are the actor's component subobjects. Read `RelativeLocation` / `RelativeRotation` / `RelativeScale3D` on those children. See V9.5 §2 for the 3-actor hand-trace + whole-map statistics.

2. **UE 5.6 FPropertyTag layout is NOT pre-5.4 CUE4Parse.** V9.5 §2 secondary finding: the tag header between `Type=StructProperty` and the value bytes has extra fields consistent with UE 5.4+ `FPropertyTypeName` + `EPropertyTagFlags` extensions. A straight port from older CUE4Parse will mis-parse 5.6 headers. **Reference CUE4Parse master branch (post-5.4)** and/or UAssetAPI 5.6 source. Plan to hand-trace 1-2 tag headers from ProjectA fixtures before committing the parse routine.

3. **Sparse transforms are intended behaviour — ~63% of placed actors have `transform: null`.** UE only serializes transform fields when they're overridden from the class default. This is not a parser bug. `list_level_actors` responses should return `transform: null` for these actors without flagging them as unsupported. Only flag as `unsupported` when a component structure is physically unresolvable (WorldSettings, some Brush actors, HISM per-instance transforms).

4. **Corrected size numbers for pagination reasoning**: Metric_Geo (Agent 9's F3 whitebox case) is 29.4 KB post-F4, NOT 320 KB (Agent 9 quoted a pre-F4 number). Bridges2 has 2,519 placed actors at 346 KB unpaginated — pagination is mandatory, not precautionary. Transform overhead measured at ~89 B/row (not ~60). Default `limit=100` pagination: ~23 KB per page. Cap `limit=500`: ~115 KB per page. Both safe.

### Level 1 — FPropertyTag iteration

Core function: `readExportProperties(buffer, exportEntry, nameTable)` → `Map<string, {type, value, size}>`

Algorithm:
1. Seek to `exportEntry.serialOffset` in the buffer
2. Read FPropertyTag header: name (FName → nameTable lookup), type string, size, arrayIndex, special flags
3. If name is `None` → stop (end of property list)
4. Based on type string, read value:
   - `IntProperty` → int32
   - `FloatProperty` → float32 (or double — check UE5)
   - `DoubleProperty` → float64
   - `BoolProperty` → bool (from tag flags, not from data stream)
   - `StrProperty` → FString (int32 length + UTF-16 or UTF-8 chars + null terminator)
   - `NameProperty` → FName (index into name table)
   - `EnumProperty` → FName
   - `ByteProperty` → uint8 or FName (depends on size)
   - `ObjectProperty` → FPackageIndex (int32, resolve via import/export tables)
   - `SoftObjectProperty` → FSoftObjectPath (Level 2 struct)
   - `TextProperty` → FText (complex — may want to skip in v1)
   - `StructProperty` → dispatch to Level 2 struct handler
   - `ArrayProperty` → **see §Level 2.5 below** — supported for simple-element types, skip-by-size for complex
   - `SetProperty` → **see §Level 2.5 below** — same scope as arrays
   - `MapProperty` → deferred per D46; return `{unsupported: true, reason: "container_deferred", size_bytes}` marker
   - Unknown type → emit `{unsupported: true, reason: "unknown_property_type", type, size_bytes}` marker, skip `size` bytes, continue. **Rule from Agent 9 §1**: never silently skip. Every unsupported property gets a marker entry by name.
5. Store in result map: `propertyName → {type, value, arrayIndex}`
6. Continue to next FPropertyTag

**Critical safety**: always respect the `size` field. If a handler reads fewer bytes than `size`, seek forward to `offset + size` before the next tag. This prevents cascading parse failures on unrecognized sub-formats.

### Level 2 — Struct handlers

Registry pattern: `const structHandlers = new Map<string, (buffer, offset, size) => value>()`

Target structs (from Agent 8's §3 matrix — use their confirmed layouts):
- `Vector` → `{x, y, z}` (3 × float64 in UE5)
- `Rotator` → `{pitch, yaw, roll}` (3 × float64 in UE5)
- `Quat` → `{x, y, z, w}` (4 × float64)
- `Transform` → `{rotation: Quat, translation: Vector, scale: Vector}`
- `LinearColor` → `{r, g, b, a}` (4 × float32)
- `Color` → `{r, g, b, a}` (4 × uint8)
- `GameplayTag` → `{tagName: string}` (FName)
- `GameplayTagContainer` → `{tags: string[]}` (array of FName)
- `SoftObjectPath` → `{assetPath: string, subPath: string}`
- `Guid` → `{a, b, c, d}` (4 × uint32) or hex string

Unknown struct → return `{unsupported: true, reason: "unknown_struct", struct_name, size_bytes}`, skip bytes. **Do not use `_raw` markers** — Agent 9 §1 specifies the `{unsupported, reason}` contract.

### Level 2.5 — Simple-element container properties (per D46)

Scope authorized by D46: `TArray` and `TSet` of simple elements. NOT `TMap`, NOT `TArray<FMyCustomStruct>`.

Simple-element types supported:
- Scalars: `TArray<int32>`, `TArray<float>`, `TArray<double>`, `TArray<bool>`, `TArray<FString>`, `TArray<FName>`
- Engine structs (Level 2): `TArray<FVector>`, `TArray<FRotator>`, `TArray<FTransform>`, `TArray<FQuat>`, `TArray<FLinearColor>`, `TArray<FColor>`, `TArray<FGuid>`, `TArray<FSoftObjectPath>`, `TArray<FGameplayTag>`
- Enums: `TArray<EMyEnum>` (byte or integer enum values; render as enum name if FName encoding detected)
- `TSet<>` of any of the above (same encoding + distinct-value semantics)

Reference ports: CUE4Parse `FScriptArray` + `FScriptSet` readers (master branch).

Algorithm per Agent 11 §L3B:
1. Read ArrayProperty/SetProperty inner-type tag (it's an FPropertyTag with `arrayIndex` semantics differing from the wrapper).
2. Read element count (int32 or packed — verify against CUE4Parse 5.4+ for UE 5.6 encoding).
3. Dispatch element reader by inner type. For struct elements, call the Level 2 struct handler; for scalars, read inline.
4. If inner type is NOT in the simple-element set (e.g., another StructProperty whose struct isn't a Level 2 engine struct, or a NameProperty referencing a UserDefinedStruct), emit `{unsupported: true, reason: "complex_element_container", inner_type, size_bytes}` marker for the *whole container*, skip by size.

**Critical safety**: if the element reader under-consumes its claimed per-element bytes, the cursor desyncs and the rest of the property list is garbage. Prefer to compute `expected_bytes_per_element` from the element type and advance to `start + count × expected_bytes` explicitly after the loop. Log any mismatch.

### Struct byte sizes (reference)

| Struct | Bytes | Notes |
|--------|-------|-------|
| FVector | 24 | 3 × float64 (UE5 uses doubles, not floats) |
| FRotator | 24 | 3 × float64 |
| FQuat | 32 | 4 × float64 |
| FTransform | 80 | FQuat(32) + FVector(24) Translation + FVector(24) Scale3D |
| FLinearColor | 16 | 4 × float32 |
| FColor | 4 | 4 × uint8 |
| FGameplayTag | 8 (5.6+) or varies (<5.6) | See version-gating below |
| FGameplayTagContainer | 4 + 8×N | uint32 count + N × FGameplayTag |
| FSoftObjectPath | varies | FName + FString (5.1+) |
| FGuid | 16 | 4 × uint32 |

### Version-gating details

Two struct formats changed across UE versions. The implementer MUST handle both:

**FGameplayTag (changed in UE 5.6)**:
- **Before 5.6**: Stored as FString (int32 length + UTF-8/UTF-16 chars)
- **5.6+**: Stored as FName (4-byte name index + 4-byte number suffix)
- **Detection**: Check UE version from file header or CustomVersions block

**FSoftObjectPath (changed in UE 5.1)**:
- **Before 5.1**: Older encoding (needs investigation if we ever parse pre-5.1 assets)
- **5.1+**: FName (asset path) + FString (sub-object path)
- **For UEMCP**: Both ProjectA (5.6) and ProjectB (5.7) are post-5.1, so the new format is sufficient. Add a version guard that logs a warning on pre-5.1 files rather than silently misreading.

### Known unknowns

1. **EnumProperty inner encoding**: May require reading an enum name FName prefix in addition to the uint8 value byte. If the first pass reads wrong values for enums, investigate whether the tag header contains an extra FName for the enum type.
2. **Custom Version GUIDs**: Verify that the existing parser's header data (CustomVersions from FPackageFileSummary) is accessible to the property reading functions. If not, thread it through.
3. **Custom GAS property types**: ProjectA/ProjectB may use custom property types not in the standard handler set. The bulk validation pass (see Testing below) will surface these — handle as skip-by-size initially with `{unsupported, reason: "unknown_property_type"}` markers.
4. **`TMap` and `TArray<FMyCustomStruct>`**: Explicitly deferred per D46 (not your scope). Emit `{unsupported: true, reason: "container_deferred"}` for maps and `{unsupported: true, reason: "complex_element_container"}` for complex arrays. Do not attempt partial parsing — cursor desync risk.
5. **`UUserDefinedStruct` references**: Deferred per D47. When a StructProperty names a UserDefinedStruct (rather than an engine struct), emit `{unsupported: true, reason: "unknown_struct"}`. A future Agent 10.5+ adds the two-pass custom-struct resolver.

---

## Tool wiring — Option C (decided; see Agent 9 §4)

Three tool changes. All yaml entries land in `tools.yaml:toolsets.offline.tools` per D44; `server.mjs:offlineToolDefs` no longer exists.

### 1. `list_level_actors` — MODIFIED (transforms always-on + pagination + summary)

**Yaml changes** (exact snippet in Agent 9 §4):
- Add params: `limit` (number, default 100, cap 500), `offset` (number, default 0), `summarize_by_class` (boolean, default false).
- Description must note pagination + "follow up with read_asset_properties for deeper values."

**Response shape additions**:
- `actors[].transform: {location:[x,y,z], rotation:[p,y,r], scale:[x,y,z]} | null` — transforms always present, `null` when the actor is at class default (this is intended per V9.5 correction #3, NOT an error).
- `actors[].unsupported?: [{name, reason}]` — per-row markers if resolution failed (rare).
- Top-level: `total_placed_actors`, `truncated`, `offset`, `limit`.
- `summary: {className: count}` when `summarize_by_class=true`.

**Transform resolution mechanism** (V9.5 correction #1):
Forward scan + outerIndex reverse lookup, not RootComponent ObjectProperty.

```
for each placed_actor_export A (already filtered by isPlacedActor):
  children = exports.filter(E => E.outerIndex resolves to A's FPackageIndex)
  if children is empty:
    transform = null  // native actor with compile-time root, no overrides
    continue
  // Pick the "root" component among children
  root = children.find(c => c.objectName in KNOWN_ROOT_NAMES)
         || children.find(c => c.className matches scene-component and not in AUX_COMPONENT_CLASSES)
         || null
  if root is null:
    transform = null  // unresolvable; annotate unsupported
    continue
  props = readExportProperties(root)
  transform = {
    location: props['RelativeLocation'] ?? null,
    rotation: props['RelativeRotation'] ?? null,
    scale: props['RelativeScale3D'] ?? null
  }
  // If all three are null, the whole transform is null (all at class default)
```

`KNOWN_ROOT_NAMES` starter set (refine empirically): `DefaultSceneRoot`, `LightComponent0`, `CollisionCapsule`, `CollisionCylinder`, `CollisionBox`, `StaticMeshComponent0`, `SkeletalMeshComponent0`, `CapsuleComponent`. AUX_COMPONENT_CLASSES: `ArrowComponent`, `BillboardComponent`, sprite components, editor-only gizmo classes.

### 2. `inspect_blueprint` — MODIFIED (include_defaults opt-in)

**Yaml changes** (per Q1 decision: rename `verbose` → `include_defaults`):
- Replace the dead `verbose` param with `include_defaults` (boolean, default false).
- Description must note this gates `variable_defaults` inclusion.
- **Important**: removing `verbose` is a param rename, not a silent removal. Add a note in the description that `verbose` is no longer accepted. Any existing caller passing `verbose:true` will now get a Zod validation error — acceptable per D44/M3 context since `verbose` was dead code with no real behavior.

**Response shape additions when `include_defaults=true`**:
- `variable_defaults: {varName: value | {unsupported, reason}}` — from the CDO export's UPROPERTY values.
- `unsupported_defaults: [{name, reason}]` — parallel list for scan tooling.

**Default export detection**: `Default__<AssetName>_C` for BP-subclass assets (V2 CONFIRMED on all 5 ProjectA BP types). For non-BP assets, fall through to the main `bIsAsset=true` export. V9.5 §3 notes the current 3-entry `genClassNames` set is sufficient on ProjectA; add defensive support for `/Script/GameplayAbilities.GameplayAbilityBlueprintGeneratedClass` anyway (per Agent 9 Q4).

### 3. `read_asset_properties` — NEW

**Yaml entry** (per Agent 9 §4):
- `asset_path` (string, required)
- `export_name` (string, optional — default: CDO for BP assets, main export otherwise)
- `property_names` (array of string, optional — filter)
- `max_bytes` (number, optional, default 65536 — response size budget)

**Response shape**:
```
{
  path, diskPath, export_name, export_index, struct_type,
  properties: {name: value | {unsupported, reason}},
  unsupported: [{name, reason, size_bytes?}],
  truncated: bool,
  property_count_returned, property_count_total
}
```

**Truncation semantics (Q5 decision: omit, mark unsupported)**: When `max_bytes` runs out mid-property, emit `{unsupported: true, reason: "size_budget_exceeded"}` for that property and subsequent unread properties — do NOT include partial values. Set top-level `truncated: true`.

**Handler registration**: one new block in `server.mjs` following the existing offline registration pattern. Since offline registration reads from yaml per D44, the description and params come automatically from your yaml entry.

### Scope table impact (V9.5 correction #4)

Agent 9 §3 references `actors.get_actor_transform` — this tool does not exist in `tools.yaml`. The actual displaced tool is `actors.get_actor_properties` (static case). For `asset-registry.get_asset_references`, only the outgoing hard-ref walk moves offline; the reverse-reference direction (what references this asset) stays editor-dependent. Don't let these mislabels propagate into your commit messages or docs.

---

## Testing

### Parser tests (Level 1)
- Read a known actor export from a `.umap` fixture → verify property names, types, values match expected
- Read a known BP export → verify variable defaults
- Read an export with unknown property types → verify skip-by-size works, no crash
- Verify `None` terminator is handled

### Parser tests (Level 2)
- FVector values match expected coordinates (compare against editor for a known placed actor)
- FRotator values match
- FGameplayTagContainer on an actor with tags → verify tag strings
- Unknown struct → returns `{unsupported: true, reason: "unknown_struct", ...}` per Option C contract, no crash

### Parser tests (Level 2.5 containers, per D46)
- `TArray<FVector>` round-trip → correct element count + values
- `TArray<FGameplayTag>` → tag name array
- `TArray<int32>` / `TArray<FString>` → scalar values
- `TSet<FName>` → distinct-value array
- Empty array → returns `[]`, no crash
- `TMap<K,V>` → returns `{unsupported: true, reason: "container_deferred", ...}`
- `TArray<FMyCustomStruct>` (find a real one in ProjectA — e.g., any asset holding `TArray<FBlendStackInputs>`) → returns `{unsupported: true, reason: "complex_element_container", ...}`

### Tool integration tests
- `list_level_actors` on Metric_Geo → 219 placed actors, pagination fields present. Transforms resolve for actors with overrides; `null` for the ~63% at class default (V9.5 §2 stat).
- `list_level_actors` on Bridges2 with default limit=100 → `total_placed_actors: 2519`, `truncated: true`, first 100 actors returned, response ≤ 100 KB.
- `list_level_actors ... summarize_by_class: true` on Bridges2 → summary dict only, small response.
- `inspect_blueprint ... include_defaults: true` on `BPGA_Block` → `variable_defaults` present with FGameplayTag etc.
- `read_asset_properties` on `/Game/Blueprints/Character/BP_OSPlayerR` (CDO default) → properties dict, `export_name: Default__BP_OSPlayerR_C`.
- `read_asset_properties ... property_names: ["AbilityTags"]` filter → single-property response.
- `read_asset_properties ... max_bytes: 500` on a large CDO → truncation kicks in with `size_budget_exceeded` markers.
- Response sizes stay under MCP cap (~1MB stdio limit) after property addition. Default pagination keeps `list_level_actors` bounded even on dense maps.
- **D44 invariant check**: `tools/list` and `find_tools` must show identical descriptions for the 3 modified/new tools post-landing.

### Bulk validation pass
- After Level 1+2 are implemented, run property parsing on ALL 19,062 ProjectA + ProjectB .uasset/.umap files
- Collect property type frequency distribution (which types appear, how often) — this surfaces any custom types we missed
- Log any parse errors (unknown type, struct handler failure, bounds violation) — target zero errors
- Measure per-file parse time — target <50ms per file on SSD (full corpus should complete in <16 minutes)

### Regression
- All existing test-phase1.mjs assertions still pass
- All Agent 6 assertions still pass
- test-mock-seam.mjs and test-tcp-tools.mjs unchanged

---

## Performance target

- <50ms per file on SSD for full property parse (header + tables + properties)
- Bulk validation of 19K+ files should complete in <16 minutes
- Include timing in the final report

## Commit convention

- Commit 1: Level 1 FPropertyTag iteration + tests. Reference Agent 9.5 V9.5-#2 (UE 5.6 FPropertyTag layout) in the commit message.
- Commit 2: Level 2 struct handlers (new `uasset-structs.mjs` module) + tests.
- Commit 3: Level 2.5 simple-element container support (per D46) + tests.
- Commit 4: Tool wiring — `list_level_actors` transforms + pagination, `inspect_blueprint` include_defaults rename, new `read_asset_properties`. Reference Option C and V9.5-#1 (outerIndex reverse scan) in the commit message.
- Commit 5: Bulk validation pass + any fixes discovered.
- **Desktop Commander for git ops** per CLAUDE.md (cmd shell, not PowerShell).
- No AI attribution.

---

## Parallel work (informational, no coordination needed)

- **Agent 11.5 — L3A skeletal UEdGraph parse feasibility** is running in parallel. Research-only; no file conflicts with your scope. If Agent 11.5's verdict is PURSUE, a future agent (Agent 10.6 or similar) ships the skeletal K2Node parser as an additional offline capability. Your scope is unchanged either way.

---

## Out of scope

- Level 3A full-fidelity UEdGraph (permanently EDITOR-ONLY per D45; 3F sidecar is the canonical offline path).
- Level 3A skeletal K2Node name-only surface (Tier S-A per D48) — deferred to bundled Agent 10.5. Not Agent 10's scope.
- Level 3B complex-element containers (`TMap`, `TArray<FMyCustomStruct>`) — deferred to Agent 10.5 per D46.
- Level 3C UUserDefinedStruct resolution — deferred to Agent 10.5 per D47.
- Level 3C DelegateProperty, FInstancedStruct, cross-package ref walks — KEEP-DEFERRED per Agent 11.
- Phase 3 C++ plugin code (D39).
- D-log edits — orchestrator writes D49+ after you land.
- `server.mjs:offlineToolDefs` — that const was eliminated in D44. Do not re-introduce it.
- Custom Serialize() overrides for class-specific formats (e.g., Blueprint's UClass::Serialize).
- FText deserialization with localization tables (complex; skip and emit `{unsupported, reason: "localized_text"}` marker per Agent 9 §1).

**Post-Agent-10 follow-on** (informational — not your concern): a single bundled Agent 10.5 session will handle D46 complex containers + D47 UUserDefinedStruct resolver + D48 S-A skeletal K2Node surface. All three share the same struct-registry extension pattern. Your Level 1+2+2.5 foundation is the prerequisite; you don't need to design for them.

---

## Final report format

```
Agent 10 Final Report — Level 1+2+2.5 Property Parser (Option C)

Level 1 (FPropertyTag iteration): [status]
  UE 5.6 layout verified via hand-trace: [yes / no + details]
  Property types handled: [list]
  Property types emitting unsupported markers: [list + reason codes]
Level 2 (struct handlers): [status]
  Structs handled: [N of 10]
  Structs emitting unsupported markers: [list + reason]
Level 2.5 (D46 containers): [status]
  Array/Set element types handled: [list]
  Complex-element containers emitting markers: [verified]
Tool wiring (Option C):
  list_level_actors: transforms always-on, pagination, summary_by_class — [status]
  inspect_blueprint: verbose → include_defaults rename, variable_defaults — [status]
  read_asset_properties: new tool, CDO default export, max_bytes truncation — [status]
  V9.5 corrections absorbed: [transform chain via outerIndex, FPropertyTag 5.6 layout, corrected size numbers] — [verified]
  D44 invariant (tools/list == find_tools descriptions): [verified]
Test results: [X]/[Y] assertions (primary + supplementary)
  Primary (phase1 + mock-seam + tcp-tools): [X/333 baseline + N new = total]
  Supplementary (parser + asset-info + registry + inspect/level-actors + any new): [X/103 baseline + N new = total]
Commits: [list with SHAs]
Performance: [per-export property parse time, bulk scan of 19K+ files]
Phase 3 scope impact: [what the 13 Agent 9 §3 tools now look like — any further reduction beyond what Agent 9 projected?]
Known issues / deferred: [any — e.g., custom property types surfaced in bulk validation that need follow-up]
```
