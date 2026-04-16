# Manual Testing Handoff — Phase 2 Handler Fixes (F0/F1/F2/F4/F6)

> **Dispatch**: 2026-04-16
> **Depends on**: Handler fixes commit `d365b05` landed on main
> **Type**: Manual integration testing via Claude Code against live MCP server
> **Tester**: Noah (in Claude Code session with `uemcp-projecta` tools)

---

## Purpose

Unit tests (54 assertions in test-phase1.mjs) passed, but those run offline against raw function calls. This manual testing exercises the fixes **through the live MCP server** — validating that Zod schemas, tool registration, param passing, and response shaping all work end-to-end as Claude would actually use them.

---

## Pre-flight

**IMPORTANT**: The MCP server must be restarted after the handler fixes commit. The old running instance has stale tool schemas (missing `verbose`, `offset` params). In Claude Desktop / Cowork, restart the `uemcp-projecta` server. In Claude Code, restart the MCP server process.

After restart, verify with `connection_info` — should show offline layer available.

---

## Test Plan

### Test A: F0 — Verbose blob stripping on `get_asset_info`

**What changed**: Tags whose string value exceeds 1KB are stripped by default. `heavyTagsOmitted` array lists what was stripped. `verbose:true` returns everything.

**Test A1** — Default (verbose=false) on a complex Blueprint:
```
get_asset_info({ asset_path: "/Game/GAS/Abilities/BPGA_Block" })
```
- [ ] Response has `tags` field
- [ ] `tags` does NOT contain `FiBData` (or if it does, its value is ≤1KB)
- [ ] If any tags were stripped, `heavyTagsOmitted` array is present and lists them
- [ ] Response is reasonably sized (not 100KB+)

**Test A2** — Verbose on the same asset:
```
get_asset_info({ asset_path: "/Game/GAS/Abilities/BPGA_Block", verbose: true })
```
- [ ] Response has `tags` field with ALL tags (including FiBData if present)
- [ ] `heavyTagsOmitted` is NOT present
- [ ] Compare: verbose response should be noticeably larger

**Test A3** — Default on a simple asset (DataTable or similar):
```
get_asset_info({ asset_path: "/Game/Data/DT_CombatTypes" })
```
(Use any DataTable that exists. Find one with `query_asset_registry class_name:DataTable limit:1`)
- [ ] If the asset has no heavy tags, `heavyTagsOmitted` should be absent (not an empty array)
- [ ] Tags should all be present since none exceed 1KB

**Test A4** — Verbose blob stripping also works on `query_asset_registry`:
```
query_asset_registry({ class_name: "Blueprint", path_prefix: "/Game/GAS/Abilities", limit: 3 })
```
- [ ] Each result's `tags` should have heavy blobs stripped
- [ ] Results with stripped tags should have `heavyTagsOmitted` array

---

### Test B: F2 — Tags removed from `inspect_blueprint`

**What changed**: `inspect_blueprint` no longer returns a `tags` field. Its job is structural (exports, imports, SCS nodes, parent class). For AR metadata, use `get_asset_info`.

**Test B1** — Structural data preserved:
```
inspect_blueprint({ asset_path: "/Game/GAS/Abilities/BPGA_Block" })
```
- [ ] Response has `exports` array
- [ ] Response has `parentClass` field
- [ ] Response has `generatedClass` field  
- [ ] Response has `exportCount` and `importCount`
- [ ] Response does NOT have a `tags` field
- [ ] Response is significantly smaller than it used to be (no 85KB tag payload)

**Test B2** — Cross-tool workflow still works:
```
# Step 1: structural view
inspect_blueprint({ asset_path: "/Game/Characters/Player/BP_OSPlayer" })
# Step 2: metadata view (separate call)
get_asset_info({ asset_path: "/Game/Characters/Player/BP_OSPlayer" })
```
(Use whatever BP paths actually exist — find with `query_asset_registry class_name:Blueprint limit:5`)
- [ ] inspect_blueprint gives the class hierarchy and export table
- [ ] get_asset_info gives the AR tags
- [ ] Together they provide the same info as the old single call, without redundancy

---

### Test C: F4 — Placed actor filter on `list_level_actors`

**What changed**: Only returns actors whose `outerIndex` resolves to PersistentLevel/Level, plus WorldSettings. Excludes component subobjects, K2Nodes, Functions, editor metadata, landscape internals.

**Test C1** — Filtered results on a real map:
```
list_level_actors({ asset_path: "/Game/Maps/Deployable/MarketPlace/MarketPlace_P" })
```
- [ ] Response has `placedActorCount` field
- [ ] `placedActorCount` is MUCH smaller than `exportCount` (unit tests showed 12 vs 572)
- [ ] `actors` array contains recognizable placed actors (PlayerStart, BP instances, WorldSettings, Landscape, volumes)
- [ ] No entries with className containing `K2Node_`, `Function`, `EdGraph`, `Texture2D`, `BodySetup`
- [ ] No component subobjects (things with outer = another non-Level actor)

**Test C2** — Try a smaller map:
```
list_level_actors({ asset_path: "/Game/Maps/Deployable/MultiplayerMenu/TestMap" })
```
- [ ] Same filtering behavior
- [ ] WorldSettings should always be present

**Test C3** — Try a level instance or sub-level:
```
list_level_actors({ asset_path: "/Game/Maps/Non-Deployable/Instances/L-Inst_Bushes" })
```
- [ ] Should still work on sub-levels
- [ ] Placed actors should be landscape/foliage actors or whatever's in the instance

---

### Test D: F6 — Short class names in `query_asset_registry`

**What changed**: `class_name` filter now accepts short names (e.g., `DataTable`) that match against the last segment after `.` in the full class path (`/Script/Engine.DataTable`).

**Test D1** — Short name:
```
query_asset_registry({ class_name: "DataTable", limit: 5 })
```
- [ ] Returns results (not 0)
- [ ] All results have `objectClassName` ending in `.DataTable`

**Test D2** — Full path (backwards compatible):
```
query_asset_registry({ class_name: "/Script/Engine.DataTable", limit: 5 })
```
- [ ] Returns same results as D1

**Test D3** — Other short names:
```
query_asset_registry({ class_name: "Blueprint", limit: 5 })
query_asset_registry({ class_name: "World", limit: 5 })
query_asset_registry({ class_name: "WidgetBlueprint", limit: 3 })
```
- [ ] Each returns appropriate results
- [ ] `objectClassName` matches the expected full path

**Test D4** — Nonsense name:
```
query_asset_registry({ class_name: "FooBarBaz123", limit: 5 })
```
- [ ] Returns 0 results
- [ ] Check if there's a `hint` field suggesting the full path format

---

### Test E: F1 — Truncation signalling and pagination on `query_asset_registry`

**What changed**: Response now includes `truncated`, `total_scanned`, `total_matched`, `offset`. New `offset` param enables pagination.

**Test E1** — Small limit triggers truncation:
```
query_asset_registry({ limit: 3 })
```
- [ ] Response has `total_scanned` (number of files walked)
- [ ] Response has `total_matched` (files passing filters — should be >> 3)
- [ ] Response has `truncated: true`
- [ ] Response has `offset: 0`
- [ ] `results` array has exactly 3 entries

**Test E2** — Pagination:
```
query_asset_registry({ limit: 3, offset: 3 })
```
- [ ] `offset: 3` echoed back
- [ ] Results are DIFFERENT from E1 (not the same 3 assets)
- [ ] `total_matched` should be the same as E1 (same query, different page)

**Test E3** — No truncation when all results fit:
```
query_asset_registry({ class_name: "DataTable", path_prefix: "/Game/Data", limit: 200 })
```
(Pick a narrow path that has fewer than 200 DataTables)
- [ ] `truncated: false` (if fewer than 200 matches)
- [ ] `total_matched` equals `results.length`

**Test E4** — Large offset past all results:
```
query_asset_registry({ limit: 5, offset: 99999 })
```
- [ ] Returns 0 results
- [ ] `total_matched` should still report the real count
- [ ] No crash or error

---

### Test F: Regression — Existing tools still work

Quick smoke test that the fixes didn't break anything unrelated.

**Test F1**:
```
project_info()
list_gameplay_tags()
search_gameplay_tags({ pattern: "Attack" })
list_plugins()
get_build_config()
```
- [ ] All return valid data, no errors

**Test F2** — `list_toolsets` still shows correct counts:
```
list_toolsets()
```
- [ ] Offline toolset shows 13 tools
- [ ] Total tool count is still ~120

---

## Severity Guide

- **Blocker**: Wrong data returned, crash, or data loss
- **High**: Missing field that was promised (e.g., `total_matched` absent), broken pagination
- **Medium**: Cosmetic issues, slightly wrong counts, suboptimal filtering edge case
- **Low**: Documentation mismatch, minor response shape preference

---

## Reporting

After testing, report findings as:
```
Test [ID]: [PASS/FAIL] — [one-line description]
```

Group by severity if any failures found. Include the actual response snippet for any FAIL.

If the MCP server schemas don't reflect the new params (verbose, offset), that means the server wasn't restarted — note this and test what you can without those params.

---

## Known Gotchas

1. **Server restart required** — old server process won't have new Zod schemas for `verbose`/`offset` params. If you see "unrecognized key" errors, the server is stale.
2. **Asset paths are project-specific** — the paths in this handoff are for ProjectA. If testing against ProjectB, use `query_asset_registry` to discover valid paths first.
3. **The `verbose` param may not appear in MCP tool schema** until server restart — but the handler code accepts it. If the schema blocks it, test everything else and note the schema issue.
4. **MarketPlace_P is nested** — `/Game/Maps/Deployable/MarketPlace/MarketPlace_P`, not `/Game/Maps/MarketPlace_P`.
