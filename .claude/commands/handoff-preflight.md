---
description: Run the 4-point handoff pre-flight checklist (prior-art / empirical-claim / build-system / session-estimate)
argument-hint: <handoff-doc-path>
---

Run the 4-point pre-flight checklist from CLAUDE.md §"Multi-agent orchestration handoff convention" → bold anchor CLAUDE.md §"Handoff draft pre-flight" against `$ARGUMENTS`.

**Be terse — one sentence per finding.** Output report as defined at the bottom.

If `$ARGUMENTS` is empty: print usage hint and run `Glob docs/handoffs/*.md` to list available handoff docs. Exit.

If `$ARGUMENTS` is a path that doesn't exist: print "handoff doc not found"; run `Glob docs/handoffs/*.md` and surface fuzzy-match suggestions. Exit.

Otherwise: read `$ARGUMENTS` and execute the 4 checks below.

## §0 Prior art

1. Extract capability names from `$ARGUMENTS`. Look for sections / paragraphs describing work to be built: function names, tool names, file paths mentioned under headings like "Create", "Implement", "Build", "Files to create".
2. For each extracted capability, run `Grep` over `server/`, `plugin/UEMCP/Source/`, and `docs/specs/` for existing implementations.
3. Report findings:
   - **PASS** — no duplicates found across any extracted capability
   - **ATTENTION** — for each capability with grep hits, list `capability → file:line` (top 3 hits per capability max)

## §1 Empirical claims

1. Scan `$ARGUMENTS` for sentences matching any of these claim patterns (case-insensitive): "is bugged", "doesn't work", "is too slow", "we're seeing", "n=\d+ observations", "race condition", "memory leak", "deadlock", "incorrect behavior".
2. For each matched claim, inspect the same paragraph for backing: a source-pointer reference (`<file>:<line>` or `<file>.cpp` / `<file>.mjs` mentioned), a reproduction command (`curl`, `node test-`, `Build.bat`, standalone script invocation), or a D-log reference to an audit (`D\d{2,3}` containing the word "audit", "verified", or "reproduced").
3. Additionally: search `docs/tracking/risks-and-decisions.md` for ≥2 D-log entries on the topic that include the words "falsified" or "walked back". If present, recommend validation audit regardless.
4. Report:
   - **PASS** — every claim is source-backed OR no claim patterns detected
   - **ATTENTION** — list claims lacking backing (one sentence per claim, quoting briefly + reason backing is missing)

## §2 Build-system workarounds

1. Run `Grep` over `**/*.Build.cs` for any of: `bUseUnity\s*=\s*false`, `IWYU\.MinSourceFiles\s*=\s*0`, `PrivateDefinitions\.Add`, `MinFilesUsingPrecompiledHeaderOverride`.
2. Report:
   - **PASS** — no workarounds found
   - **N/A** — handoff doesn't touch the C++ plugin (e.g., server-only work)
   - **ATTENTION** — list each finding with `file.Build.cs:line — <pattern>` and remind: "these are diagnostic; ask why before implementing on top"

## §3 Session estimate

1. From `$ARGUMENTS`, count file paths mentioned under "create", "modify", "implement", or "files to" sections (case-insensitive grep within the doc).
2. Heuristic: estimate `N_files × 50 lines/file ÷ 500 lines/session = N_sessions`.
3. Report `N_sessions` rounded to 1 decimal place with the file count reasoning.
4. If `N_sessions > 3`: flag D129 size trigger ("workstream cost is large; validation audit warranted regardless of claim status").

## Recommended action

Pick one based on findings:
- **PROCEED** — all checks PASS or N/A; orchestrator can draft the opener
- **VALIDATION-AUDIT** — any §1 ATTENTION OR §3 trigger
- **REVISE** — §0 ATTENTION (duplicate work risk) OR §2 ATTENTION (unknown build-system context)
- **DECOMPOSE** — `N_sessions > 5` AND multiple independent subsystems in `$ARGUMENTS`

## Output format

Emit exactly this markdown structure (replace `<…>` placeholders):

```markdown
## /handoff-preflight: <handoff filename>

### §0 Prior art: <PASS | ATTENTION>
<findings or "no duplicates">

### §1 Empirical claims: <PASS | ATTENTION>
<flagged claims or "all claims source-backed">

### §2 Build-system workarounds: <PASS | ATTENTION | N/A>
<findings or "no workarounds">

### §3 Session estimate: <N> sessions
<reasoning>

### Recommended action: <PROCEED | VALIDATION-AUDIT | REVISE | DECOMPOSE>
<one-line reason>
```
