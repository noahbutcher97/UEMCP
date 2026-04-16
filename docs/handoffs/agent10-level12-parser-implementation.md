# Agent 10 Handoff — Level 1+2 Property Parser Implementation

> **Dispatch**: After Agent 8 (research audit) AND Agent 9 (tool surface design) deliver
> **Depends on**: Agent 8 deliverable (`docs/research/uasset-parser-audit-and-recommendation.md`) for implementation approach + reference code. Agent 9 deliverable (`docs/research/level12-tool-surface-design.md`) for which tools to wire data into.
> **D-log**: D39 (Level 1+2 before Phase 3)

---

## Mission

Extend `server/uasset-parser.mjs` with:
- **Level 1**: FPropertyTag iteration — read tagged properties from export serialized data
- **Level 2**: Struct deserialization — handlers for ~10 common UE structs

Then wire the property data into tool handlers per Agent 9's approved design.

---

## File scope (strict)

| File | Action |
|------|--------|
| `server/uasset-parser.mjs` | **Primary** — add property reading functions |
| `server/offline-tools.mjs` | Wire property data into tool responses per Agent 9's design |
| `server/test-phase1.mjs` | Add test assertions for property reading |
| `tools.yaml` | Update tool params/descriptions if Agent 9's design requires it |
| `server/server.mjs` | Only if new tools are added (Agent 9 Option B/C) |

**Do NOT touch**: `tcp-tools.mjs`, `connection-manager.mjs`, `test-tcp-tools.mjs`, `test-mock-seam.mjs`, `plugin/`, `docs/specs/`, `docs/tracking/`.

---

## Implementation guide

**Read Agent 8's recommendation (§4) first.** It specifies:
- Which project(s) to reference for FPropertyTag iteration
- Which struct handlers to port vs build
- The recommended implementation order
- Specific source files to study

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
   - `ArrayProperty` → read inner type tag + N elements (container)
   - `MapProperty` → key type + value type + N entries (container)
   - Unknown type → log warning, skip `size` bytes, continue
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

Unknown struct → log warning, return `{_raw: true, _size: N}`, skip bytes.

---

## Tool wiring

Follow Agent 9's approved design. The likely outcomes:

**If Option A** (fold into existing): add `transform` field to `list_level_actors` response for actors that have a transform property. Add `variableDefaults` to `inspect_blueprint`. Add a `properties` field to `get_asset_info` (opt-in via `include_properties: true` param).

**If Option B** (new tool): register `read_asset_properties` in the offline toolset. Params: `asset_path`, `export_name` (optional — defaults to main export). Returns all readable properties.

**If Option C** (hybrid): both of the above.

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
- Unknown struct → returns `_raw: true`, no crash

### Tool integration tests
- `list_level_actors` on MarketPlace_P → actors have `transform` fields (if Option A/C)
- `inspect_blueprint` on a BP → `variableDefaults` present (if Option A/C)
- Response sizes stay under MCP cap after property addition

### Regression
- All existing test-phase1.mjs assertions still pass
- All Agent 6 assertions still pass
- test-mock-seam.mjs and test-tcp-tools.mjs unchanged

---

## Commit convention

- Commit 1: Level 1 FPropertyTag iteration + tests
- Commit 2: Level 2 struct handlers + tests
- Commit 3: Tool wiring (per Agent 9's design) + integration tests
- No AI attribution.

---

## Out of scope

- Level 3 (UEdGraph deserialization) — explicitly excluded per D39
- Phase 3 C++ plugin code
- D-log edits
- Custom Serialize() overrides for class-specific formats
- FText deserialization (complex, low priority — skip and log)

---

## Final report format

```
Agent 10 Final Report — Level 1+2 Property Parser

Level 1 (FPropertyTag iteration): [status]
  Property types handled: [list]
  Property types skipped: [list + reason]
Level 2 (struct handlers): [status]
  Structs handled: [N of 10]
  Structs deferred: [list + reason]
Tool wiring: [status, which option implemented]
Test results: [X]/[Y] assertions (baseline + new)
Commits: [list]
Performance: [time to read properties from 1 export, time for bulk scan]
Phase 3 scope impact: [what TCP read-side tools are now unnecessary]
Issues encountered: [any]
```
