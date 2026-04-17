# Polish Worker — Agent 10 Response Ergonomics (7 items)

> **Dispatch**: After Agent 10.5 ships (done). Sequential with other code-touching workers to avoid collision.
> **Type**: Surgical response-shape cleanup in offline tools. No new functionality.
> **Duration**: 45-60 min.
> **Source**: 7 polish items flagged in `docs/testing/2026-04-16-agent10-manual-results.md` §7 by the Agent 10 manual tester.

---

## Mission

Seven small ergonomic/hygiene fixes in the Option C tools' response shapes. All non-blocking; all identified via manual testing of shipped code. No design changes; just tighter response shapes and documentation.

Each item is independent. Commit per-item (path-limited per D49) or bundle two-three related ones per commit — reviewer's preference.

---

## The 7 items

### P1 — `list_level_actors` summary-mode offset/limit echo

When `summarize_by_class: true` is passed, the response still echoes `offset` and `limit` fields that aren't meaningful in summary mode (summary returns a dict, not a paginated list).

**Fix**: In `offline-tools.mjs`, the `listLevelActors` handler for summary-mode response should omit `offset` and `limit` from the response. Keep `total_placed_actors` + `summary: {className: count}` only.

**Test**: extend `test-phase1.mjs` Test 10 (or the relevant offline-tools test) — assert `summary: true` response does NOT contain `offset`/`limit` keys.

---

### P2 — `read_asset_properties` filter-scoped `unsupported[]`

When `property_names: ["A", "B"]` is passed, the top-level `unsupported[]` currently includes markers for properties outside the filter (anything the parser couldn't decode across the whole CDO). It should be scoped to only the filtered set — callers asking about "A, B" shouldn't see unsupported entries for unrelated "C, D".

**Fix**: `readAssetProperties` handler should filter the `unsupported[]` array to entries whose `name` is in `property_names` when `property_names` is set.

**Test**: filter query with `property_names: [<one known-unsupported>, <one known-supported>]` — response `unsupported[]` contains only the unsupported one, not arbitrary unrelated entries.

---

### P3 — `packageIndex` leakage in response

Some tool responses surface an internal `packageIndex` field (FPackageIndex integer used during parser resolution). It's not useful to callers and shouldn't leak through the MCP wire.

**Fix**: audit `list_level_actors`, `inspect_blueprint`, `read_asset_properties` handlers. Strip `packageIndex` from response objects before returning. Prefer resolved path/name fields only.

**Test**: add assertions that responses do NOT contain `packageIndex` fields at any nesting depth.

---

### P4 — Duplicate marker surfacing

The `unsupported[]` array in `read_asset_properties` responses can contain duplicate entries for the same property when that property is visited twice during iteration (e.g., via array index + main).

**Fix**: dedupe `unsupported[]` by `{name, reason}` tuple before returning. Order-stable dedupe (keep first occurrence).

**Test**: find a case where duplicates currently emerge; assert dedupe works.

---

### P5 — Undocumented `unexpected_preamble` reason

The tester encountered a marker with `reason: "unexpected_preamble"` that isn't documented in tool descriptions or any reason-code catalog. Agent 10 emits it but didn't add to docs.

**Fix**: either (a) if this reason is stable and meaningful, document it in the tool description (yaml) and in any reason-code comment/catalog in offline-tools.mjs. Or (b) if it's an internal diagnostic that shouldn't surface to callers, swap it for the generic `unknown_preamble` or an existing reason code.

**Recommend (a)** — the more markers we expose with meaningful reasons, the more debuggable the tool. Add one-sentence doc entry explaining when it fires.

---

### P6 — Delegate-path test note

The Agent 10 manual test §4 flagged "unreachable (delegate path — expected UE behaviour)" for the delegate marker test — the tester couldn't construct a delegate-property scenario that serialized in a way the test expected. This is a test-completeness gap, not a bug.

**Fix**: update the delegate-property test in `test-phase1.mjs` (or applicable suite) with a note explaining WHY the test is structured this way and WHICH UE behaviour makes some paths unreachable. Either retarget the test to a reachable case or add an explanatory skip with a clear reason.

---

### P7 — Inline response compaction

Agent 10 tool responses have minor whitespace/field-ordering quirks (e.g., `transform: null` at the END of row objects vs. start; inconsistent field ordering across row entries).

**Fix**: normalize field ordering in response builders. Suggested ordering for `list_level_actors` actor rows: `{name, className, classPackage, outer, bIsAsset, transform, unsupported?}`. Apply similar consistency for `read_asset_properties` and `inspect_blueprint`.

Minor aesthetic win; helps caller parse responses deterministically.

**Test**: no new functional test needed. Visual diff against a snapshot fixture is optional.

---

## File scope

Primary: `server/offline-tools.mjs` (all 7 items touch response-shape construction here).
Secondary: `server/test-phase1.mjs` (or the applicable existing suite) for test updates.
Optional: `tools.yaml` for P5 documentation.

**Do NOT touch**: `server/uasset-parser.mjs`, `server/uasset-structs.mjs` — parser internals are correct; only response assembly needs tweaking.

---

## Constraints

- All 7 items are non-blocking; if one proves harder than expected (e.g., P3's `packageIndex` leakage is deeper than the top-level), flag and move on — do not expand scope.
- Tests must stay green (612/612 baseline).
- Path-limited commits per D49.
- Desktop Commander for git ops (shell: "cmd").
- No AI attribution.

---

## Final report

```
Polish Worker Final Report — 7 Response-Ergonomic Items

P1 summary-mode offset/limit echo:   [done / skipped / partial] — commit [SHA]
P2 filter-scoped unsupported[]:      [done / skipped / partial] — commit [SHA]
P3 packageIndex leakage:             [done / skipped / partial] — commit [SHA]
P4 duplicate marker dedup:           [done / skipped / partial] — commit [SHA]
P5 unexpected_preamble docs:         [done / skipped / partial] — commit [SHA]
P6 delegate-path test note:          [done / skipped / partial] — commit [SHA]
P7 response field ordering:          [done / skipped / partial] — commit [SHA]

Tests: [X]/[Y] — delta vs 612 baseline
Commits landed: [N]
Time spent: [N min]
Items deferred (if any): [list + reason]
```
