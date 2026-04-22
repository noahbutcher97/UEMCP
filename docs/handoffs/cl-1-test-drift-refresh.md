# CL-1 Worker — test-phase1 + test-uasset-parser drift refresh

> **Dispatch**: Fresh Claude Code session. **Zero file-level collision** with in-flight Verb-surface worker (they touch `offline-tools.mjs` + NEW `test-verb-surface.mjs` + `tools.yaml` + `server.mjs`; you own `test-phase1.mjs` + `test-uasset-parser.mjs`).
> **Type**: Cleanup — refresh stale expected values in existing tests against current on-disk BP bytes.
> **Duration**: 20-45 min.
> **D-log anchors**: D70 (S-B-base worker final report flagged 7 pre-existing drift failures caused by Noah's BP_OSPlayerR/Player CDO re-saves during Path A experiment + Oracle-A-v2 rebuild cycle).
> **Deliverable**: 7 drifted test assertions updated to match current on-disk state; full test rotation green at ~1041 passing (1034 currently passing + 7 previously-failing now passing).

---

## Mission

7 test assertions currently fail because Noah re-saved BP_OSPlayerR + Player CDO during the Path A experiment (before D70 confirmed Path A wasn't needed). The re-saves changed property-layout bytes on disk without changing semantic content. Tests that hardcode expected byte-level values or property counts drifted.

S-B-base worker verified via git-stash that these failures are **pre-existing before S-B-base's commits** (not caused by their parser additions). Fixing them is out of S-B-base's D49 scope; this handoff owns the cleanup.

**Key invariant**: do NOT refresh fixture `.uasset` bytes. Those are P4-tracked in ProjectA and may be checked out by teammates. Only refresh expected values in JS test files to match what the parser currently reads from the unchanged-by-us disk state.

---

## Scope — in

### §1 Diagnose + refresh

1. **Run the 2 failing suites individually to see exact failures**:
   ```cmd
   cd /d D:\DevTools\UEMCP\server
   set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA
   node test-phase1.mjs 2>&1 | findstr /C:"FAIL" /C:"AssertionError"
   node test-uasset-parser.mjs 2>&1 | findstr /C:"FAIL" /C:"AssertionError"
   ```
2. For each failure, read the assertion context — what value did the test expect? What value does the parser actually return now?
3. Update the hardcoded expected value to match current parser output, **ONLY IF** the value is the kind that drifts naturally from BP re-saves (property counts, byte offsets, asset-registry tag counts, export indices, etc.). If an assertion fails for a reason that looks genuinely semantic (e.g., a BP structural assertion changed meaning), surface to orchestrator — don't silently rubber-stamp.
4. Re-run both suites; confirm 0 failures.
5. Run full test rotation to confirm no regression elsewhere.

### §2 Optional: CL-2 piggyback

If you're in `CLAUDE.md` or `package.json` anyway for other reasons:
- Add `test-s-b-base-differential.mjs` to CLAUDE.md's test-file rotation table (already exists on disk per S-B-base worker commit `9250121`)
- Update test-count references from **914** to the post-fix new baseline
- If no test-count update is obvious, skip — bundle cleanly or defer

Minor scope creep welcome if it's literally 1-2 lines in the same file you're already editing. Don't widen further.

### §3 Not-scope reminders

- **Do NOT refresh fixture `.uasset` or `.oracle.json` bytes** — those are authoritative per their respective workflows.
- **Do NOT touch `test-verb-surface.mjs`** — Verb-surface worker is shipping it in parallel.
- **Do NOT touch `test-s-b-base-differential.mjs`** — that's S-B-base's already-shipped suite; you only REFERENCE it from CLAUDE.md/package.json if CL-2 piggyback lands.
- **Do NOT touch `server/offline-tools.mjs`, `server/uasset-parser.mjs`, or `tools.yaml`** — Verb-surface owns those file-wise.

---

## Reference files

1. `docs/tracking/risks-and-decisions.md` D70 — context for drift cause + why this is safe cleanup work.
2. `server/test-phase1.mjs` — 3 failures here (per D70).
3. `server/test-uasset-parser.mjs` — 4 failures here (per D70).
4. `CLAUDE.md` Testing section — test-count references + test-file table (CL-2 optional piggyback).
5. `server/package.json` — test rotation script (CL-2 optional piggyback).

---

## Success criteria

1. 7 previously-failing assertions now pass.
2. Full test rotation green at **~1041 passing** (1034 + 7 restored; or wherever the actual baseline lands).
3. No new failures introduced.
4. Path-limited commit(s) per D49: `server/test-phase1.mjs` + `server/test-uasset-parser.mjs` (plus optional `CLAUDE.md` / `server/package.json` for CL-2 piggyback).
5. If any failure was semantic (not drift), it's surfaced rather than rubber-stamped.

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **Path-limited commits per D49** — server/test-phase1.mjs + server/test-uasset-parser.mjs primary; CLAUDE.md + package.json optional CL-2 piggyback.
- **No AI attribution**.
- **Single commit OK** — 7 small assertion updates fit one commit comfortably.
- **`UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA`** env var required for fixture-exercising tests.
- **DO NOT touch fixture binaries** — `.uasset` + `.oracle.json` files are authoritative per their respective workflows.

---

## Final report to orchestrator

Report (under 150 words):
1. Commit SHA.
2. Per-failure summary: which assertion was failing, what value was expected → what it is now, what kind of drift (byte offset, property count, etc.).
3. Any assertion that looked SEMANTIC (not drift) and was surfaced vs rubber-stamped.
4. Final test count pre vs post-fix.
5. CL-2 piggyback status (yes/no/deferred).
6. Next action: orchestrator can update CLAUDE.md test-rotation references with clean number; parallel Verb-surface worker continues unaffected.
