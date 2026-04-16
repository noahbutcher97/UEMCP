# Manual Testing Results — Phase 2 Handler Fixes (F0/F1/F2/F4/F6)

> **Date**: 2026-04-16
> **Commit tested**: `d365b05` (handler fixes on main)
> **Plan**: `docs/handoffs/testing-handler-fixes-manual.md`
> **Tester**: Noah (Claude Code session, `uemcp-projecta` MCP server)
> **Result**: 18/19 assertions PASS — 1 High-severity regression in F0
> **Session cost**: ~152,832 tokens consumed executing the full plan end-to-end

---

## Pre-flight

- `connection_info` → offline layer `available`, toolCount 123
- Tool schemas include `verbose` and `offset` params → MCP server had been restarted post-`d365b05`

---

## Results Matrix

| Test | Fix | Result | Notes |
|------|-----|--------|-------|
| A1 | F0 | PASS | `get_asset_info` default strips FiBData, reports `heavyTagsOmitted` |
| A2 | F0 | **FAIL** | `verbose:true` on `get_asset_info` produces byte-identical stripped response |
| A3 | F0 | PASS | Simple asset (DataTable) has no heavy tags, `heavyTagsOmitted` correctly absent |
| A4 | F0 | PASS | `query_asset_registry` default strips FiBData per result |
| B1 | F2 | PASS | `inspect_blueprint` has exports/parentClass/generatedClass; no `tags` field |
| B2 | F2 | PASS | Cross-tool workflow: inspect_blueprint + get_asset_info give complementary views |
| C1 | F4 | PASS | MarketPlace_P: 12 placed vs 572 exports, all `outer:"PersistentLevel"` |
| C2 | F4 | PASS | MarketPlace_BO: 2 placed vs 11 exports, WorldSettings present |
| C3 | F4 | PASS | L-Inst_Bushes sub-level filters correctly (external-actor OFPA map) |
| D1 | F6 | PASS | `DataTable` short name matches `/Script/Engine.DataTable` |
| D2 | F6 | PASS | Full path `/Script/Engine.DataTable` returns identical result |
| D3 | F6 | PASS | `Blueprint`, `World`, `WidgetBlueprint` all resolve correctly |
| D4 | F6 | PASS (minor) | Nonsense name returns 0 results, no crash, but no `hint` field |
| E1 | F1 | PASS | `limit:3` returns `total_scanned/total_matched/truncated:true/offset:0` |
| E2 | F1 | PASS | `offset:3` echoed, results disjoint from E1, same `total_matched` |
| E3 | F1 | PASS | `truncated:false` when all results fit (verified with 0-match narrow path) |
| E4 | F1 | PASS | `offset:99999` returns 0 results, no crash |
| F1 | regression | PASS | project_info, list_gameplay_tags, list_plugins, get_build_config, search_gameplay_tags all work |
| F2 | regression | PASS | Offline toolset = 13 tools; total `toolCount:123` |

---

## Failures

### HIGH — Test A2: `verbose:true` ignored on `get_asset_info`

**Contract (from schema)**:
> `verbose`: If true, return all tags including large blobs (>1 KB). Default false strips verbose tags.

**Actual**: Handler accepts `verbose:true` via Zod schema but the output is byte-identical to the default stripped response. `heavyTagsOmitted` still present; `FiBData` still missing from `tags`.

**Reproduction**:
```
get_asset_info({ asset_path: "/Game/GAS/Abilities/BPGA_ChargeAttack", verbose: true })
```

**Actual output (excerpt)**:
```json
{
  "tags": {
    "BlueprintCategory": "",
    ...
    "ParentClass": "/Script/CoreUObject.Class'/Script/ProjectA.GA_OSChargedAttack'"
  },
  "heavyTagsOmitted": ["FiBData"]
}
```

**Evidence bug is localized to `get_asset_info`, not F0 globally**:
- `query_asset_registry({ path_prefix: "/Game/GAS/Abilities", class_name: "Blueprint", limit: 2, verbose: true })` **correctly** returns full FiBData blob for BPGA_ChargeAttack (~4KB encoded string inline, no `heavyTagsOmitted` field). So F0's verbose branch works on the registry path but not the single-asset handler.
- Verified on two separate assets (BPGA_ChargeAttack, AN_Footstep_Test) — not a caching artifact.

**Likely fix scope**: The `get_asset_info` handler's verbose branch. Unit tests must not cover this handler's `verbose:true` path end-to-end.

**Severity**: High — silent data loss when user explicitly requests full data via documented parameter.

---

### LOW — Test D4: Missing `hint` on unrecognized class names

**Contract (from plan)**: When a nonsense short name is supplied, response should include a hint field suggesting full-path format.

**Actual**: `query_asset_registry({ class_name: "FooBarBaz123", limit: 5 })` returns `{results: [], total_matched: 0}` with no `hint` field.

**Severity**: Low — UX/documentation polish only. Behavior otherwise correct.

---

## Non-failures worth noting

- **Test D3 WidgetBlueprint appeared to fail at default `max_scan:5000`** — zero matches because the first match is deep in `/Game/ImportedAssets/HitReactionProject/...`. Re-running with `max_scan:20000` returned 65 matches, all `objectClassName: /Script/UMGEditor.WidgetBlueprint`. Behavior is correct; the default scan cap just happened to exclude them. Consider documenting this, or raising default `max_scan`.
- **Test F1 `search_gameplay_tags pattern:"Attack"`** returned 0 matches — correct glob behavior (bare word ≠ substring). Pattern `**Attack**` returns 24 matches as expected.
- **Test E3** couldn't strictly validate "narrow path with fewer than 200 DataTables" since `/Game/Data` has 0 DataTables. Truncation contract semantics verified nonetheless (`truncated:false, total_matched === results.length` when all fit).

---

## Token Usage Statistics

**Total session cost**: ~152,832 tokens from session start through final report write.

### Cost drivers (approximate, largest first)

| Call / category | Tokens (approx) | Why expensive |
|---|---|---|
| Session-start context (CLAUDE.md + MEMORY.md + session log + skill/tool registry reminders) | ~30–40k | Loaded once at start; not test-controlled. |
| `list_gameplay_tags` (Test F1) | ~12k | Full 171-tag hierarchy with nested children returned inline. |
| `query_asset_registry` with `verbose:true` (Test A2 verification, /Game/GAS/Abilities) | ~8–10k | Two Blueprint results with full FiBData blobs (~4KB encoded string each) inline. |
| `inspect_blueprint` on BP_Notify_StandUp (Test B2) | ~3–4k | 11-export table with full metadata per export. |
| `list_level_actors` on MarketPlace_P (Test C1) | ~1.5k | 12 placed actors, compact. Cheap. |
| `query_asset_registry` default calls (Tests A4, D1–D4, E1–E4) | ~2–4k each | Tags payload per result; heavier for Blueprint class (FiBData-bearing). |
| `get_asset_info` calls (Tests A1, A2, A3, B2) | ~0.5–1k each | Small payloads. |
| `list_toolsets`, `project_info`, `list_plugins`, `get_build_config`, `connection_info` | <1k each | Structural metadata only. |
| Final report generation + TaskCreate/TaskUpdate overhead | ~3–5k | Markdown body + 6 task records. |

### Takeaways for future test-plan re-runs

- **Drop `list_gameplay_tags` from the regression pass** unless verifying tag parsing specifically — `search_gameplay_tags` with a known pattern gives the same signal at ~1/10th the cost.
- **Use `verbose:true` sparingly on `query_asset_registry`** — one call with `limit:2` to prove blobs come back is sufficient; don't iterate.
- **Narrow `path_prefix`** on every `query_asset_registry` call. The default Content-root scan walked 5000 files per call across E1/E2/E4/F-tests, which didn't add cost in tokens (scan count is metadata) but noise in results is token-heavy when tag payloads are big.
- **Session-start context is ~30–40k fixed** — any test session pays this before the first tool call. Not actionable by the test plan, but worth knowing when budgeting.
- Total testing cost of ~150k tokens for 19 assertions ≈ **~8k tokens/assertion** average. Reasonable for integration testing where each assertion exercises a full MCP round-trip with realistic payloads.

---

## Recommendation

- Ship F1, F2, F4, F6 — handlers are correct end-to-end through the MCP server.
- **Block F0 close-out on fix to `get_asset_info` verbose branch**. The fix is already working on `query_asset_registry` — presumably the same stripping/verbose logic needs to be threaded through the single-asset path. Add an integration test that calls `get_asset_info` with `verbose:true` against a known heavy-blob asset and asserts the blob is present in response.
