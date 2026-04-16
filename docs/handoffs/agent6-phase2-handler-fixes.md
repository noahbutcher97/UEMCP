# Agent 6 Handoff — Phase 2 Handler-Layer Fixes

> **Dispatch**: 2026-04-16
> **Depends on**: nothing (can start immediately)
> **D-log**: D38 (tier-2 audit findings)
> **Audit source**: `docs/audits/phase2-tier2-parser-validation-2026-04-15.md` (sealed)

---

## Mission

Fix the 5 highest-priority findings from the tier-2 parser validation audit. All fixes are in the tool handler / response-shaping layer — **do not modify `uasset-parser.mjs`**. The parser is production-grade and stays untouched.

---

## File scope (strict)

| File | Action |
|------|--------|
| `server/offline-tools.mjs` | Primary — all handler fixes here |
| `server/test-phase1.mjs` | Add/update test assertions for each fix |
| `tools.yaml` | Update param definitions if adding new params (`verbose`, `limit`/`offset` on `list_level_actors`, etc.) |
| `server/server.mjs` | Only if tool registration changes (new params require Zod schema updates) |

**Do NOT touch**: `uasset-parser.mjs`, `tcp-tools.mjs`, `connection-manager.mjs`, `test-tcp-tools.mjs`, `test-mock-seam.mjs`, anything in `plugin/`, anything in `docs/` except your final report.

---

## Fixes (in priority order)

### Fix 1: F0 — Strip verbose blob tags by default

**Problem**: `get_asset_info`, `query_asset_registry`, and `inspect_blueprint` return raw `FiBData`, `ActorMetaData`, and `ActorsMetaData` tag values. These blobs scale with BP/map complexity — BP_OSPlayerR alone produces 280 KB. Folder scans of 64 GAS BPs hit 1.54 MB.

**Fix**:
- Add `verbose` param (boolean, default `false`) to all three tools in `tools.yaml`.
- When `verbose: false` (default), strip any tag whose decoded value exceeds 1 KB. Keep all scalar tags: `NativeParentClass`, `ParentClass`, `GeneratedClass`, `BlueprintType`, `ImplementedInterfaces`, `NumReplicatedProperties`, `NumNativeComponents`, `NumBlueprintComponents`, `IsDataOnly`, `BlueprintDescription`, `FiBData` (only if under 1KB), etc.
- Add `heavyTagsOmitted: ["FiBData", "ActorMetaData", ...]` to the response so callers know what was stripped.
- When `verbose: true`, return everything (current behavior).

**Test**: call `get_asset_info` on a complex BP path with default params — response must NOT contain `FiBData` if the asset is complex. Call with `verbose: true` — `FiBData` must be present. Verify `heavyTagsOmitted` array is accurate.

### Fix 2: F2 — Remove tags from `inspect_blueprint`

**Problem**: `inspect_blueprint` returns the full AR tags dict (same payload as `get_asset_info`) on top of its structural data (exports, imports, SCS nodes, functions). This creates redundancy and inflates response by 85 KB+ on complex BPs.

**Fix**:
- Remove the `tags` field from `inspect_blueprint` output entirely. Its contract becomes: "structural view of the blueprint — exports, imports, SCS nodes, functions, class breakdown."
- Callers who want AR metadata call `get_asset_info` separately.
- This is a breaking change to the response shape. Note it clearly in the tool description update.

**Test**: call `inspect_blueprint` on any BP — response must NOT contain a `tags` key. Verify the structural data (exports, imports, scsNodes, functions) is still present and correct.

### Fix 3: F4 — Filter `list_level_actors` to placed actors

**Problem**: tool returns the full export table (572 rows on a dev map, 1377 on a whitebox map). Only 2.4–16% are actual placed actors. The rest are component subobjects, editor metadata, landscape internals, BP machinery.

**Fix**: filter exports to match UE editor Outliner semantics:
- **Include** exports whose `outerIndex` resolves to an export with className containing `PersistentLevel` or `Level`. These are the placed actors.
- **Also include** `WorldSettings` (always one per level).
- **Exclude** everything else: component subobjects (outer is another non-Level export), editor-only data (`*EditorOnlyData`, `AssetImportData`, `LandscapeTextureHash`, `BookMarks`), package-embedded assets (`Texture2D`, `MaterialInstance*`, `BodySetup`, `Model`, `Polys` when outer is `Brush`), BP metadata (`Function`, `K2Node_*`, `EdGraph`, `BlueprintGeneratedClass`).
- The filter logic should be a named function (`isPlacedActor(export, exports)` or similar) for testability.

**Test**: call `list_level_actors` on a map. Count returned rows. Verify they are actual placed actors (PlayerStart, BP instances, WorldSettings, AkSpatialAudioVolume, Landscape, etc.) and NOT component subobjects or editor internals. On the MarketPlace_P map from the audit, expect ~14 rows instead of 572.

### Fix 4: F6 — Accept short class names in `query_asset_registry`

**Problem**: `class_name:DataTable` returns 0 results because the stored class name is `/Script/Engine.DataTable`. Users don't know the full script path.

**Fix**: if the `class_name` filter does not start with `/`, treat it as a suffix match against the last segment after `.` in `objectClassName`. So `DataTable` matches `/Script/Engine.DataTable`, `WidgetBlueprint` matches `/Script/UMGEditor.WidgetBlueprint`, etc.
- If no matches found and the filter doesn't start with `/`, add a hint to the response: `"hint": "No matches. Try the full script path, e.g. /Script/Engine.DataTable"`.
- Full paths (`/Script/Engine.DataTable`) continue to work as exact matches.

**Test**: call `query_asset_registry class_name:DataTable` — must return >0 results. Call `query_asset_registry class_name:/Script/Engine.DataTable` — must return the same results. Call with a nonsense short name — must return 0 with the hint message.

### Fix 5: F1 — Add truncation signalling to `query_asset_registry`

**Problem**: when results hit the `limit` cap, the response gives no indication that more results exist.

**Fix**: add to the response envelope:
- `truncated: true/false` — whether the result set was capped by `limit`
- `total_scanned: number` — files walked
- `total_matched: number` — files that passed filters (may be > `limit`)
- `offset: number` — current offset (0 for first call)
- Add `offset` param to tools.yaml so callers can paginate: `offset:2000 limit:2000` gets the next page.

**Test**: call with `limit:5` on a folder known to have >5 assets. Verify `truncated: true` and `total_matched > 5`. Call with `offset:5 limit:5` — verify different results. Call on a small folder where all results fit — verify `truncated: false`.

---

## Test expectations

- All existing `test-phase1.mjs` assertions must still pass (36 baseline).
- Add at least 2 assertions per fix (10+ new assertions minimum).
- Run the full test suite before declaring done: `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA&& node test-phase1.mjs`
- Also verify mock seam and TCP tests are untouched: `node test-mock-seam.mjs` and `node test-tcp-tools.mjs`.

---

## Out of scope

- F5 (BP/BPGC duplicate rows) — Low severity, defer.
- F3 (list_level_actors oversize) — addressed as side effect of Fix 3 (F4 filtering). If post-filter response is still too large on degenerate maps, add `limit` param, but don't gold-plate.
- Parser changes — `uasset-parser.mjs` is off limits.
- Level 1+2 property parsing — separate agent.
- Phase 3 C++ plugin — separate future work.
- D-log edits — orchestrator handles.

---

## Commit convention

- One commit per fix (5 commits), or group F0+F2 (both response-shaping) into one.
- Messages: `fix(offline): F0 — strip verbose blob tags by default` etc.
- No AI attribution.

---

## Final report format

```
Agent 6 Final Report — Phase 2 Handler Fixes

Fixes landed:
- F0: [status + what changed]
- F2: [status + what changed]
- F4: [status + what changed]
- F6: [status + what changed]
- F1: [status + what changed]

Test results: [X]/[Y] assertions passing (baseline 36 + N new)
Commits: [list]
Issues encountered: [any]
```
