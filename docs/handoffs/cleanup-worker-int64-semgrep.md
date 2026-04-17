# Cleanup Worker — int64 VFX Parse Bug + Semgrep Deep Refactor

> **Dispatch**: After Agent 10.5 ships. Sequential with Polish + Parser Extensions workers to avoid collision.
> **Type**: Pre-existing bug fixes. No new features.
> **Duration**: 30-60 min.

---

## Mission

Two pre-existing issues that accumulated before Agent 10 and are independently shippable as a small bounded worker session:

1. **int64 > 2^53 parse failures in VFX mesh files** — 359 files failing `parseSummary.readInt64AsNumber`. Pre-Agent-10.
2. **Semgrep dynamic-regex finding in `searchGameplayTags`** — Agent 10.5 partially mitigated with input whitelist + targeted `nosemgrep`, but the deeper safe-regex library swap remains open per CLAUDE.md security guidance.

---

## Item 1 — int64 parse bug in VFX mesh files

### Context

`server/uasset-parser.mjs` has a `readInt64AsNumber` helper (Cursor class, ~line 78) that throws on int64 values exceeding JavaScript's `Number.MAX_SAFE_INTEGER` (2^53). This fires on 359 ProjectA VFX mesh files whose serialized headers contain bulk-data size fields > 2^53 — specifically offset/size fields on large meshes.

Agent 10 and Agent 10.5 both flagged this; both deferred since it's pre-existing and not in scope.

### Fix options

**Option A — BigInt fast path**: change `readInt64AsNumber` to return `BigInt` when the value exceeds safe integer, `number` otherwise. Callers that can't handle BigInt fail explicitly (typed fail vs silent misread). Risk: callers assume `number` everywhere; introducing BigInt breaks downstream math.

**Option B — Safe-number gate with skip**: check bounds before throw; if out-of-range, return a sentinel (e.g., `Number.MAX_SAFE_INTEGER`) and emit a warning in a side-channel. Caller-visible marker if the value was capped. Doesn't fix the data but prevents parse abort.

**Option C — Recover at parseSummary level**: catch the throw in the specific caller (`parseSummary`), set an `int64_overflow` marker on the file's summary, continue parsing best-effort. Other summary fields still work; file is partially-readable instead of fully-rejected.

**Recommend Option C** — the failure is in summary-reading, not property-reading. Salvaging the rest of the summary is the ergonomically-cleanest response. Option A forces a BigInt contract through the whole parser for one edge case; Option B silently corrupts data.

### Test

Add a test case: parse one of the 359 failing VFX mesh files directly. Before fix: test expects throw. After fix: test expects a partial summary with an `int64_overflow: true` field (or a `skippedFields: [...]` list).

### Bulk validation re-run

Re-run Agent 10.5's 19K-file bulk validation. Expected: 359 file-level failures drop to 0 (files now parse with partial summaries instead of failing outright).

---

## Item 2 — Semgrep dynamic-regex deep refactor

### Context

`server/offline-tools.mjs:searchGameplayTags` constructs a RegExp from a user-supplied pattern string. Agent 10.5 added (a) a strict `^[A-Za-z0-9_.*]+$` input whitelist and (b) a `nosemgrep` annotation on the RegExp construction line. This mitigates the immediate finding but doesn't switch to a safe-regex library per CLAUDE.md's security-defaults guidance.

### Fix approach

**Option A — Replace with safe-regex check + build dynamically**: install `safe-regex` (npm), validate the constructed regex is ReDoS-safe before using. Rejects if unsafe; tool returns a specific error. Preserves dynamic-regex semantic.

**Option B — Replace with static glob-to-regex converter**: the input pattern is glob-style (`*`, `**`). Write a deterministic converter that produces a known-safe regex (no nested alternation, no variable quantifiers). Drop the dynamic RegExp entirely.

**Recommend Option B** — glob-to-regex is a well-understood conversion with bounded complexity. Removes the RegExp construction entirely, which satisfies semgrep without annotation + is structurally safer.

Pseudo-code sketch:
```js
function globToRegex(pattern) {
  // Escape regex metacharacters EXCEPT glob chars, then translate:
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  const regex = escaped
    .replace(/\*\*/g, '<DOUBLESTAR>')
    .replace(/\*/g, '[^.]*')
    .replace(/<DOUBLESTAR>/g, '.*');
  return new RegExp('^' + regex + '$');
}
```

After the conversion: remove the whitelist + `nosemgrep` annotation Agent 10.5 added (no longer needed because there's no user-supplied RegExp content). Semgrep finding disappears.

### Test

Extend `test-phase1.mjs` gameplay-tag tests with glob patterns: `Gameplay.*`, `*.State.*`, `Combat.**`, etc. Verify correct match behaviour matches old dynamic-regex version.

---

## File scope

| File | Action |
|---|---|
| `server/uasset-parser.mjs` | Item 1 — salvage-on-overflow logic in `parseSummary` |
| `server/offline-tools.mjs` | Item 2 — replace dynamic RegExp with glob-to-regex converter in `searchGameplayTags` |
| `server/test-phase1.mjs` | New assertions for both items |
| (optional) `server/test-uasset-parser.mjs` | New assertion for Item 1 parse salvage |

**Do NOT touch**: `uasset-structs.mjs`, `tcp-tools.mjs`, `connection-manager.mjs`, `tools.yaml`, `docs/tracking/`, `plugin/`.

---

## Constraints

- Both items are bounded. If Item 1 requires a deeper parser refactor than described, fall back to Option B (safe-number sentinel + marker) rather than blow scope.
- Path-limited commits per D49. Desktop Commander for git.
- Tests must stay green (683/683 baseline). Target: +5 assertions across the two items.
- Performance regression budget: ≤1% on bulk validation. If Item 2's glob-to-regex adds overhead, note it.
- No AI attribution.
- Order: Item 2 first (smaller, lower-risk); Item 1 second (has bulk-validation re-run step).

---

## Final report

```
Cleanup Worker Final Report

Item 1 (int64 VFX parse bug):         [status]
  Option chosen: [A / B / C]
  Bulk file-level failure reduction:  [N → M] (was 359)
Item 2 (semgrep deep refactor):        [status]
  Approach: [safe-regex library / glob-to-regex converter / other]
  Semgrep finding resolved: [yes / no]
  Agent 10.5's whitelist + nosemgrep annotations removed: [yes / no / kept (why)]

Tests: [X]/[Y] — delta vs 683 baseline
Commits: [list with SHAs]
Time spent: [N min]
```
