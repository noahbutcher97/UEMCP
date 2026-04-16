# Manual Testing Results — Phase 2 Handler Fixes (F0/F1/F2/F4/F6)

> **Executed**: 2026-04-16
> **Tester**: Claude Code (Opus 4.7) in ProjectA project
> **Plan**: `docs/handoffs/testing-handler-fixes-manual.md`
> **Commit under test**: `d365b05` on main
> **Server state**: Restarted — Zod schemas include `verbose` and `offset` params
> **Outcome**: **25/25 assertions PASS** — zero Blockers, Highs, or Mediums. One Low-severity observation.

---

## Pre-flight

```
connection_info →
  project: ProjectA
  offline: available
  toolCount: 123
  enabledToolsets: ["offline"]
```

Tool schemas confirmed via ToolSearch: `get_asset_info`, `inspect_blueprint`, `query_asset_registry` all expose `verbose` and/or `offset`. Server restart was effective.

---

## Test A — F0 Verbose blob stripping on `get_asset_info`

| ID | Result | Evidence |
|----|--------|----------|
| A1 | PASS | `/Game/Blueprints/Character/BP_OSPlayerR` default → `heavyTagsOmitted: ["FiBData"]`, FiBData absent from `tags`, response ~2 KB |
| A2 | PASS | Same asset with `verbose:true` → 280,688-char response, FiBData present, `heavyTagsOmitted` absent |
| A3 | PASS | `/Game/Art/Character/BaseCharacter/DT_Mutable_MeshAssets` → `heavyTagsOmitted` field absent (not empty array), all tags present |
| A4 | PASS | `query_asset_registry class_name:Blueprint limit:10` → results with heavy blobs report `heavyTagsOmitted: ["FiBData"]`; results with inline tiny FiBData (e.g. AN_OSAnimNotify_Footstep at 4 KB) correctly skipped |

**Note on path substitution**: The plan's original asset `/Game/GAS/Abilities/BPGA_Block` turned out to have no FiBData blob (FiBData lives on `UBlueprint` object path and BPGA_Block only has its `BlueprintGeneratedClass` object in AR). Substituted `BP_OSPlayerR` (600 KB BP with heavy FiBData) to exercise the stripping path.

---

## Test B — F2 Tags removed from `inspect_blueprint`

| ID | Result | Evidence |
|----|--------|----------|
| B1 | PASS | BPGA_Block: response has `exports` (19 entries), `parentClass: "GA_OSBlock"`, `generatedClass: "BPGA_Block_C"`, `exportCount: 19`, `importCount: 51`. **No `tags` field** |
| B2 | PASS | BP_OSPlayerR: `inspect_blueprint` = 85 KB structural data with 275 exports, zero occurrences of `"tags"` or `"FiBData"` in response; `get_asset_info` returns AR tags separately. Clean separation of concerns |

Verified B1/B2 via `grep` against the saved tool-result files: `parentClass` and `exportCount` each appeared once; `tags` and `FiBData` appeared zero times.

---

## Test C — F4 Placed actor filter on `list_level_actors`

| ID | Map | placedActorCount | exportCount | Result |
|----|-----|------------------|-------------|--------|
| C1 | MarketPlace_P | 12 | 572 | PASS |
| C2 | TestMap | 21 | 118 | PASS |
| C3 | L-Inst_Bushes (sub-level) | 2 | 11 | PASS |

All returned actors have `outer: "PersistentLevel"`. No K2Node_*, Function, EdGraph, Texture2D, or BodySetup entries. WorldSettings present in all three. C2 correctly retained multiple PStart_TDM_C spawns plus lighting actors.

---

## Test D — F6 Short class names on `query_asset_registry`

| ID | Input | Result | Evidence |
|----|-------|--------|----------|
| D1 | `class_name:"DataTable"` | PASS | 1 match within 5000 scan; `objectClassName: "/Script/Engine.DataTable"` |
| D2 | `class_name:"/Script/Engine.DataTable"` | PASS | Same 1 match — backwards compatible |
| D3a | `class_name:"World"` | PASS | 10 matches; all `/Script/Engine.World` |
| D3b | `class_name:"WidgetBlueprint"` | PASS | 65 matches with `max_scan:20000`; `/Script/UMGEditor.WidgetBlueprint` — matcher handles non-Engine module prefix correctly |
| D3c | `class_name:"Blueprint"` | PASS | 127 matches; `/Script/Engine.Blueprint` |
| D4 | `class_name:"FooBarBaz123"` | PASS (Low note) | 0 results, no crash. **No `hint` field** — the plan listed this as optional "check if", so not a fail, but a polish opportunity |

**D3b note**: At default `max_scan:5000`, WidgetBlueprint returned 0 because all 65 WidgetBlueprints live past file 5000 in walk order (under `/Game/ImportedAssets/...`). Raising `max_scan` confirmed the short-name matcher itself works on non-Engine module classes.

---

## Test E — F1 Truncation signalling and pagination

| ID | Call | Result | Key response fields |
|----|------|--------|---------------------|
| E1 | `limit:3` | PASS | `total_scanned:5000`, `total_matched:5000`, `truncated:true`, `offset:0`, `matches:3` |
| E2 | `limit:3, offset:3` | PASS | `offset:3` echoed; results differ from E1 (AM_FrostPunch/AM_Groundslam/AM_HeavyAttackCombo vs. AN_Footstep/AM_Dodge_B/AM_Dodge_F); `total_matched:5000` stable |
| E3 | `class_name:DataTable, path_prefix:/Game/Art, limit:200, max_scan:20000` | PASS | `truncated:false`, `total_matched:1 == results.length` |
| E4 | `limit:5, offset:99999` | PASS | 0 results, `total_matched:5000` preserved, `offset:99999` echoed, no crash |

Pagination semantics correct. Note that `total_matched == total_scanned == 5000` in E1/E2 is because no filters were applied — every scanned file matched. This is expected, not a bug.

---

## Test F — Regression smoke

| ID | Call | Result |
|----|------|--------|
| F1a | `project_info` | PASS — 15 plugins, 1 runtime module |
| F1b | `list_gameplay_tags` | PASS — 171 tags returned with full hierarchy |
| F1c | `search_gameplay_tags pattern:"Attack"` | PASS — 0 matches (expected: globs require `*` wildcards per server instructions; `Gameplay.Ability.Attack.*` returns the 2 expected hits) |
| F1d | `list_plugins` | PASS — project + local plugins listed |
| F1e | `get_build_config` | PASS — Build.cs + Target.cs parsed |
| F2 | `list_toolsets` | PASS — offline toolset = 13 tools; 15 toolsets total summing to 117 tools + 6 orchestration = 123, matches `connection_info.toolCount` |

---

## Severity-grouped Findings

### Blocker / High / Medium
None.

### Low
- **D4**: `query_asset_registry` with an unrecognized short class name returns `{ matches:0, results:[] }` with no `hint` field. The plan listed this as an optional check ("Check if there's a `hint` field..."). Considering adding one when `class_name` is present, `total_matched:0`, and `max_scan` hasn't been exhausted by class match — would guide users toward `/Script/Module.ClassName` form. Optional polish.

### Observations (not findings)
- **A1 asset substitution**: The plan's `/Game/GAS/Abilities/BPGA_Block` doesn't surface FiBData via `get_asset_info` because the AR primary-object row points at `BlueprintGeneratedClass`. For future test plans, prefer BP paths where `objectClassName` is `/Script/Engine.Blueprint` (e.g., BP_OSPlayerR) when validating FiBData stripping.
- **D3b scan cap**: Default `max_scan:5000` masked WidgetBlueprint matches under `/Game/ImportedAssets/`. Consider raising the default or surfacing "scanned N of M files" in the response when `truncated:true` so users know to widen the scan.

---

## Conclusion

All five handler fixes (F0/F1/F2/F4/F6) behave correctly end-to-end through the live MCP server, matching the 333-assertion unit-test baseline. Response shapes, Zod schemas, param routing, and filter logic are all consistent with the intended design. Ready to declare the Phase 2 handler fix work done.

---

## Appendix — Saved tool-result files

Two oversized responses were saved to the tool-result cache and read back via `grep`:

- `mcp-uemcp-get_asset_info-1776370208041.txt` — BP_OSPlayerR verbose (280,688 chars, confirmed FiBData present, heavyTagsOmitted absent)
- `mcp-uemcp-inspect_blueprint-1776370260323.txt` — BP_OSPlayerR (85,137 chars, confirmed tags/FiBData absent, parentClass/exportCount present)
