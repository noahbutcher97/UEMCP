# Dev-cycle slash commands — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship three project-scoped slash commands (`/handoff-preflight`, `/dispatch-worker`, `/deploy-cycle`) that codify the dispatch and deploy rituals currently documented as prose in CLAUDE.md.

**Architecture:** Approach A from spec — three independent command files in `.claude/commands/`, composed by convention. Each command body re-reads CLAUDE.md per invocation (Key Design Rule 1 deference). A structural test in the rotation verifies command files reference anchors that still exist in CLAUDE.md, so CLAUDE.md edits can't silently break the commands.

**Tech Stack:** Claude Code slash commands (markdown files with YAML frontmatter), Node.js ES modules for the anchor-check test, existing `server/run-rotation.mjs` for test discovery, existing `.githooks/` for codename + structural pre-commit checks.

**Spec reference:** `docs/specs/2026-05-19-dev-cycle-slash-commands-design.md`

**Anchor reference convention** (refinement of spec §7.1): command bodies reference CLAUDE.md sections using the literal pattern `CLAUDE.md §"<header-text>"` (with double quotes around the header text). The anchor test extracts these refs via regex `CLAUDE\.md §"([^"]+)"` and verifies each `<header-text>` matches either a markdown header (`^#+\s+<text>$`) or a bolded paragraph anchor (`^\*\*<text>\*\*`) in CLAUDE.md. This convention is precise enough for automated checking without over-constraining how CLAUDE.md is structured.

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `.claude/commands/handoff-preflight.md` | Create | Slash command body for the 4-point pre-flight checklist |
| `.claude/commands/dispatch-worker.md` | Create | Slash command body for opener generation following the 6-point checklist |
| `.claude/commands/deploy-cycle.md` | Create | Slash command body for the deploy ritual walkthrough |
| `server/test-slash-command-anchors.mjs` | Create | Structural test: every `CLAUDE.md §"…"` ref in command bodies resolves to a real anchor in CLAUDE.md |
| `CLAUDE.md` | Modify | Add 4 pointers (~400 chars total) per spec §8; introduce `### Canonical dev-cycle commands` subsection |

Each command file is small (50-150 lines markdown). The anchor test is ~80 lines. CLAUDE.md additions are surgical (one-sentence pointers + one new subsection).

---

## Task 1: Scaffold the anchor-check test

**Why first**: Test infrastructure lands before any command files, so we can TDD the command files against it. The test starts as a no-op (zero commands to check) and grows as commands land.

**Files:**
- Create: `D:/DevTools/UEMCP/server/test-slash-command-anchors.mjs`

- [ ] **Step 1.1: Write the test file**

```javascript
// server/test-slash-command-anchors.mjs
// Structural test: every `CLAUDE.md §"…"` reference in a slash-command
// body resolves to a real header or bolded anchor in CLAUDE.md.
//
// Convention: command bodies reference CLAUDE.md sections using the
// literal pattern  CLAUDE.md §"<header-text>"  with double quotes.
// The anchor must match either ^#+\s+<text>$ or ^\*\*<text>\*\*  in CLAUDE.md.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(HERE, '..');
const COMMANDS_DIR = join(REPO_ROOT, '.claude', 'commands');
const CLAUDE_MD = join(REPO_ROOT, 'CLAUDE.md');

const ANCHOR_REF_RE = /CLAUDE\.md §"([^"]+)"/g;

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL: ${msg}`); }
}

function extractAnchors(claudeMdText) {
  const headers = new Set();
  for (const line of claudeMdText.split(/\r?\n/)) {
    const h = line.match(/^#+\s+(.+?)\s*$/);
    if (h) headers.add(h[1].trim());
    const b = line.match(/^\*\*([^*]+)\*\*/);
    if (b) headers.add(b[1].trim());
  }
  return headers;
}

function extractRefs(commandText) {
  const refs = new Set();
  let m;
  while ((m = ANCHOR_REF_RE.exec(commandText)) !== null) {
    refs.add(m[1]);
  }
  return refs;
}

function runTests() {
  if (!existsSync(CLAUDE_MD)) {
    console.error(`FAIL: CLAUDE.md not found at ${CLAUDE_MD}`);
    failed++;
    return;
  }
  if (!existsSync(COMMANDS_DIR)) {
    // No commands dir yet → vacuously pass (zero refs to check)
    console.log('No .claude/commands/ directory yet; nothing to check.');
    return;
  }
  const claudeMd = readFileSync(CLAUDE_MD, 'utf8');
  const anchors = extractAnchors(claudeMd);

  const files = readdirSync(COMMANDS_DIR).filter(f => f.endsWith('.md'));
  if (files.length === 0) {
    console.log('No .claude/commands/*.md files yet; nothing to check.');
    return;
  }

  for (const f of files) {
    const body = readFileSync(join(COMMANDS_DIR, f), 'utf8');
    const refs = extractRefs(body);
    for (const ref of refs) {
      assert(
        anchors.has(ref),
        `${f} references CLAUDE.md §"${ref}" but no matching anchor exists in CLAUDE.md`
      );
    }
  }
}

runTests();
console.log(`Passed: ${passed}  Failed: ${failed}  Total: ${passed + failed}`);
if (failed > 0) process.exit(1);
```

- [ ] **Step 1.2: Run the test**

```bash
cd D:/DevTools/UEMCP/server && node test-slash-command-anchors.mjs
```

Expected output:
```
No .claude/commands/ directory yet; nothing to check.
Passed: 0  Failed: 0  Total: 0
```

Exit code 0 (no failures).

- [ ] **Step 1.3: Verify rotation runner auto-discovers the new test**

```bash
cd D:/DevTools/UEMCP/server && node run-rotation.mjs 2>&1 | grep -i "test-slash-command-anchors"
```

Expected: at least one line mentioning `test-slash-command-anchors.mjs` in the rotation output (it auto-discovers `test-*.mjs`). Verdict should be PASS or SKIPPED.

- [ ] **Step 1.4: Commit**

```bash
cd D:/DevTools/UEMCP && git add server/test-slash-command-anchors.mjs && git commit -m "Add slash-command anchor-check test scaffold"
```

---

## Task 2: Build `/handoff-preflight` (TDD)

**Files:**
- Create: `D:/DevTools/UEMCP/.claude/commands/handoff-preflight.md`

- [ ] **Step 2.1: Add the failing anchor assertion**

The anchor test from Task 1 will catch a broken reference automatically — we don't need to pre-add a test. The TDD pattern here is: write the command file → run the test → see the anchor pass → smoke-test the command behavior manually.

First, verify the test currently passes (no command files exist):

```bash
cd D:/DevTools/UEMCP/server && node test-slash-command-anchors.mjs
```

Expected: `Passed: 0  Failed: 0  Total: 0`, exit 0.

- [ ] **Step 2.2: Write the `/handoff-preflight` command file**

Create `D:/DevTools/UEMCP/.claude/commands/handoff-preflight.md`:

````markdown
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
   - **ATTENTION** — list each finding with `file.Build.cs:line — <pattern>` and remind: "these are diagnostic; ask why before implementing on top per CLAUDE.md §\"Validate empirical claims before committing workstreams (D129)\" sibling concern"

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
````

- [ ] **Step 2.3: Run the anchor test**

```bash
cd D:/DevTools/UEMCP/server && node test-slash-command-anchors.mjs
```

Expected:
```
Passed: 2  Failed: 0  Total: 2
```

(Two anchor refs in the command body: `Multi-agent orchestration handoff convention` and `Handoff draft pre-flight`. Both exist in CLAUDE.md — verified during plan authoring.)

If FAIL: read the FAIL line; it identifies which anchor is broken. Fix the command body to reference an anchor that exists in CLAUDE.md.

- [ ] **Step 2.4: Smoke-test by invoking the command**

In a Claude Code conversation, type `/handoff-preflight` (no args). Expected: usage hint + list of `docs/handoffs/*.md`.

Then type `/handoff-preflight docs/handoffs/new-2-batch-endpoint-fix.md` (or any existing handoff doc). Expected: full 4-section markdown report following the output format.

If the handoff doc doesn't exist, the command should print fuzzy-match suggestions.

- [ ] **Step 2.5: Commit**

```bash
cd D:/DevTools/UEMCP && git add .claude/commands/handoff-preflight.md && git commit -m "Add /handoff-preflight slash command"
```

---

## Task 3: Update CLAUDE.md with `/handoff-preflight` pointer

**Files:**
- Modify: `D:/DevTools/UEMCP/CLAUDE.md`

- [ ] **Step 3.1: Add the pointer sentence to the "Handoff draft pre-flight" bolded anchor**

Edit CLAUDE.md. Find the line:

```
**Handoff draft pre-flight** (~10 min total, prevents D128-class misdirection):
```

After the 4-point list (after the line `4. **Worker-session estimate calibration** — ~500 lines per worker session per ...`), insert a new paragraph:

```

Use `/handoff-preflight <doc>` to run this checklist automatically.
```

- [ ] **Step 3.2: Run the anchor test to confirm CLAUDE.md edit didn't break refs**

```bash
cd D:/DevTools/UEMCP/server && node test-slash-command-anchors.mjs
```

Expected: still `Passed: 2  Failed: 0  Total: 2`. The edit was a paragraph addition, not an anchor change.

- [ ] **Step 3.3: Commit**

```bash
cd D:/DevTools/UEMCP && git add CLAUDE.md && git commit -m "Document /handoff-preflight in CLAUDE.md"
```

---

## Task 4: Build `/dispatch-worker`

**Files:**
- Create: `D:/DevTools/UEMCP/.claude/commands/dispatch-worker.md`

- [ ] **Step 4.1: Write the command file**

Create `D:/DevTools/UEMCP/.claude/commands/dispatch-worker.md`:

````markdown
---
description: Generate a worker-conversation opener from a handoff doc following the 6-point checklist
argument-hint: <handoff-doc-path> [--target <stem>]
---

Generate a worker-conversation opener from `$ARGUMENTS` following the canonical 6-point checklist in CLAUDE.md §"Multi-agent orchestration handoff convention" → bold anchor CLAUDE.md §"Opener content checklist".

## Parse arguments

Parse `$ARGUMENTS` as: `<handoff-doc-path> [--target <stem-or-path>]`.

- Positional `<handoff-doc-path>` (required): path to `docs/handoffs/<name>.md`
- `--target <stem|full-path>` (optional): codename hydration source; default = placeholders only

If `<handoff-doc-path>` is missing: print usage + `Glob docs/handoffs/*.md` list. Exit.

If `<handoff-doc-path>` doesn't exist: print fuzzy-match suggestions from `docs/handoffs/`. Exit.

If `--target` is provided:
1. Read `.uemcp-targets.txt` at repo root.
2. Find an entry where the `.uproject` filename stem matches `<stem>` OR the full path matches `<full-path>`.
3. If no match: print "target not found"; list all entries from `.uemcp-targets.txt`; exit (do not silently fall back to placeholders).
4. Build the substitution map:
   - `<UNREAL_PROJECT_NAME>` ← stem of the matched `.uproject`
   - `<UNREAL_PROJECT_ROOT>` ← parent directory of the matched `.uproject`
   - `<UEMCP_REPO_PATH>` ← `D:/DevTools/UEMCP/` (constant)

## Re-read CLAUDE.md for canonical structure

The 6-point Opener content checklist and the standing constraints list may evolve. Re-read CLAUDE.md §"Multi-agent orchestration handoff convention" before generating the opener so the output matches current convention.

## Extract data from the handoff doc

Read `<handoff-doc-path>` and extract:

1. **Role** — derive from filename prefix:
   - `audit-*` → "audit worker"
   - `cleanup-*` → "cleanup worker"
   - `smoke-*` → "smoke-test worker"
   - `validation-*` → "validation-audit worker"
   - anything else → "implementation worker"
2. **Mission** — pick the first match: a line starting `Mission:`, then the first non-frontmatter paragraph, then a slugified-filename description. Surface in the post-block summary which fallback was used.
3. **Pre-reads** — extract via regex (deduplicate):
   - D-log refs: `D\d{2,3}`
   - Related handoff docs: `docs/handoffs/[a-z0-9-]+\.md`
   - Feedback memory refs: `feedback_[a-z_]+\.md`

## Generate the opener

Emit the opener wrapped in a fenced code block (so the user can copy the entire block in one Ctrl-C). Follow this structure exactly:

````
You are the <role> for: <mission>

## Handoff doc
Read `<handoff-doc-path>` (uses placeholder vocabulary per CLAUDE.md §"Public-Repo Hygiene").

## Required pre-reads
- D-log: <list of D-numbers, comma-separated>
- Handoff docs: <list of related handoff paths>
- Feedback memory: <list of feedback files>
(omit any sub-bullet whose list is empty)

<if --target provided, include this block; else omit>
## Codename context (EPHEMERAL — chat only; translate to placeholders before any disk write)
- <UNREAL_PROJECT_NAME> = <stem>
- <UNREAL_PROJECT_ROOT> = <parent dir>
- <UEMCP_REPO_PATH> = D:/DevTools/UEMCP/
</if>

## Constraints
- D49 path-limit (260-char Windows path ceiling)
- D82 NDA-gate: codenames stay in chat; placeholders go to disk
- No AI attribution in commits (no `Co-Authored-By: Claude`, no "generated with AI")
- Desktop Commander for git + filesystem writes (Cowork sandbox bash can't acquire .git/index.lock)
- CMD shell for git/node (PowerShell PATH doesn't include them)
- Single-commit preference per workstream
- Report-length: keep concise; orchestrator reads the whole report

## Final report
Write your final report to `docs/reports/<descriptive-dated-filename>.md` (NOT `docs/handoffs/`). The orchestrator reconciles the report against current repo state and authors any follow-up handoff.
````

## Post-block summary

After the fenced code block, on new lines:
- 1-line summary: "Generated opener for `<handoff-doc-path>` (role: `<role>`, hydration: `<target-stem | placeholders-only>`, mission-fallback: `<which>`)."
- If `--target` was NOT specified AND `.uemcp-targets.txt` has entries: list available targets with the hint "re-run with `--target <stem>` to hydrate codenames".

## Errors

- `$ARGUMENTS` empty → usage + `Glob docs/handoffs/*.md`
- handoff doc not found → fuzzy-match suggestions
- `--target` mismatch → list available targets from `.uemcp-targets.txt` + abort (no silent fallback)
- `.uemcp-targets.txt` missing when `--target` requested → "create `.uemcp-targets.txt` at repo root per CLAUDE.md §\"Q3 dev-workflow scripts — verify-deploy + setup-watcher (D136)\""
````

- [ ] **Step 4.2: Run the anchor test**

```bash
cd D:/DevTools/UEMCP/server && node test-slash-command-anchors.mjs
```

Expected: `Passed: 6  Failed: 0  Total: 6` (the new file adds 4 anchor refs: `Multi-agent orchestration handoff convention`, `Opener content checklist`, `Public-Repo Hygiene`, `Q3 dev-workflow scripts — verify-deploy + setup-watcher (D136)`. All exist in CLAUDE.md — verified during plan authoring.)

If any FAIL: the FAIL line names the missing anchor. Either fix the command-body reference to use an existing CLAUDE.md anchor, or update CLAUDE.md to add the anchor (preferring the former for surgical changes).

- [ ] **Step 4.3: Smoke-test placeholder mode**

In a Claude Code conversation, type `/dispatch-worker docs/handoffs/<any-existing-handoff>.md`. Expected:
- Fenced code block containing the opener
- Codename context section ABSENT
- Post-block summary mentions "hydration: placeholders-only"
- If `.uemcp-targets.txt` exists with entries, post-block hint lists them

- [ ] **Step 4.4: Smoke-test target hydration**

If `.uemcp-targets.txt` exists with at least one entry, pick a stem from it and run:

```
/dispatch-worker docs/handoffs/<any-existing-handoff>.md --target <stem>
```

Expected:
- Fenced code block includes the Codename context section with the substitution map
- Post-block summary mentions "hydration: `<stem>`"

If `.uemcp-targets.txt` is empty or missing: skip this smoke test; note in the commit message that hydration mode was not smoke-tested locally.

- [ ] **Step 4.5: Smoke-test the strict-on-mismatch path**

```
/dispatch-worker docs/handoffs/<any-existing-handoff>.md --target this-stem-does-not-exist-xyz
```

Expected: error message listing available targets from `.uemcp-targets.txt`, no opener generated, command aborts cleanly.

- [ ] **Step 4.6: Commit**

```bash
cd D:/DevTools/UEMCP && git add .claude/commands/dispatch-worker.md && git commit -m "Add /dispatch-worker slash command"
```

---

## Task 5: Update CLAUDE.md with `/dispatch-worker` pointer

**Files:**
- Modify: `D:/DevTools/UEMCP/CLAUDE.md`

- [ ] **Step 5.1: Add the pointer sentence to the "Opener content checklist" bolded anchor**

Edit CLAUDE.md. Find the line:

```
**Opener content checklist**:
```

After the 6-point list (after the line `6. Final-report format; worker-authored reports go to docs/reports/, NOT docs/handoffs/`), insert a new paragraph:

```

Use `/dispatch-worker <doc> [--target <stem>]` to generate an opener following this structure.
```

- [ ] **Step 5.2: Run the anchor test**

```bash
cd D:/DevTools/UEMCP/server && node test-slash-command-anchors.mjs
```

Expected: still `Passed: 6  Failed: 0  Total: 6`.

- [ ] **Step 5.3: Commit**

```bash
cd D:/DevTools/UEMCP && git add CLAUDE.md && git commit -m "Document /dispatch-worker in CLAUDE.md"
```

---

## Task 6: Build `/deploy-cycle`

**Files:**
- Create: `D:/DevTools/UEMCP/.claude/commands/deploy-cycle.md`

- [ ] **Step 6.1: Write the command file**

Create `D:/DevTools/UEMCP/.claude/commands/deploy-cycle.md`:

````markdown
---
description: Deploy cycle walkthrough — verify-deploy → sync-plugin (auto) → Build.bat (manual) → relaunch (manual) → MCP restart (manual)
argument-hint: [--target <stem>] [--targets <list-file>]
---

Walk the user through the UEMCP deploy cycle. Auto-run the automatable scripts; stop-gate at manual steps (Build.bat, editor relaunch, MCP restart). Reference: CLAUDE.md §"Q3 dev-workflow scripts — verify-deploy + setup-watcher (D136)".

## Parse arguments

Parse `$ARGUMENTS` for:
- `--target <stem|full-path>` (optional): limit to one target
- `--targets <path>` (optional): override `.uemcp-targets.txt` location
- (no args): process all targets in `.uemcp-targets.txt`

## Render initial checkbox list

Print:
```
☐ Step 1 — verify-deploy
☐ Step 2 — sync-plugin
☐ Step 3 — Build.bat (manual)
☐ Step 4 — Editor relaunch (manual)
☐ Step 5 — MCP restart (manual)
```

Update the relevant box to ☑ after each completed step. Re-print the full list at each transition so progress is visible.

## Step 1 — verify-deploy (auto)

Run:
```bash
node server/verify-deploy.mjs <forwarded-args>
```

Forward `--target` / `--targets` if provided. Capture stdout.

Parse the per-target verdict lines. Surface each target's status:
- `SYNC` — no action needed
- `NEEDS-SYNC` / `NEEDS-BUILD` / `NEEDS-DEPLOY` — continue to Step 2
- `MISSING` — note: target dir doesn't exist; cannot sync
- `[EDITOR-LOCKED]` overlay — flag for hard-stop in Step 2
- `[MCP]` overlay — note workspace drift but don't block

If ALL targets are `SYNC` and no overlays: mark Step 1 ☑, print "All targets in sync; deploy cycle complete." Exit.

Otherwise: mark Step 1 ☑, continue to Step 2.

## Step 2 — sync-plugin (auto, per-target)

For each target needing sync:

If the target has `[EDITOR-LOCKED]` overlay:
- Print: "Editor is running against `<target-uproject>`; sync-plugin.bat will refuse while DLL is locked. Close that editor instance, then re-run `/deploy-cycle --target <stem>` to retry just this target."
- Skip this target (do NOT abort other targets — per-workspace lock model, D138 §2)

Else: run
```bash
sync-plugin.bat <target-uproject> -y
```

Capture stdout. Surface:
- "Synced <target-uproject>"
- If output indicates W-L deploy-marker cache-bust (look for "nuke" / "cache-bust" / "version-change" / `Binaries/` deletion): print "**Cache-bust triggered** for `<target>`; next build will be a clean rebuild (significantly slower)."

After all targets processed:
- If any sync failures occurred: stop the cycle, summarize successes + failures, give actionable next step. Don't proceed to Step 3.
- Mark Step 2 ☑ if at least one target was synced (or all were already in sync).

## Step 3 — Build.bat (stop-gate)

Determine which targets need a build. After a successful sync, every synced target needs a build.

For UE_ROOT (path to the UE 5.6 install):
- Check `$env:UE_ROOT` (PowerShell) or `%UE_ROOT%` (CMD).
- If unset: prompt user once: "What is the full path to your UE 5.6 install root (e.g., `D:/Epic/UE_5.6`)? Reply with the path; I'll use it for all targets this session."
- Cache the value for the remainder of this slash-command invocation.

For each target needing build, print the build command verbatim, copy-paste-ready:

```cmd
"<UE_ROOT>\Engine\Build\BatchFiles\Build.bat" UEMCPEditor Win64 Development -Project="<full-uproject-path>" -WaitMutex -FromMsBuild
```

Quote paths with spaces. `-WaitMutex` is mandatory to prevent UBT-mutex clash when processing multiple targets serially.

After printing all build commands, stop and print:

```
Run the build commands above (one at a time or in sequence), then paste:
- `done` if all builds succeeded
- the error output if any build failed
I'll continue when you confirm.
```

**Wait for user response.**

If user pastes `done` (case-insensitive, may include trailing whitespace): mark Step 3 ☑, continue to Step 4.

If user pastes an error: stop the cycle. Summarize what succeeded (verify-deploy verdict, sync results) + the error. Suggest next step (read the error, fix, re-run `/deploy-cycle --target <failing-stem>`).

## Step 4 — Editor relaunch (stop-gate)

Print:

```
Relaunch the UE Editor for each target you just built:
- <target-1-stem>: double-click `<full-uproject-path-1>`
- <target-2-stem>: double-click `<full-uproject-path-2>`
...
Reply `done` when the editor(s) are running.
```

**Wait for user response.**

If user pastes `done`: mark Step 4 ☑, continue to Step 5.

## Step 5 — MCP restart (stop-gate)

Print:

```
Restart the MCP server. In Claude Code, the server is per-conversation under stdio transport,
so the simplest restart is to start a new conversation (Cmd-K or Ctrl-K → New).

Env vars from each target's `.mcp.json` that will re-apply on restart:
- <target-1>: <list of UEMCP_* vars and their values>
- <target-2>: ...
(Surface only the UEMCP_* vars; ignore standard MCP transport vars.)

Reply `done` when restarted (or skip if you'll restart later).
```

Mark Step 5 ☑ when user replies (`done` OR `skip`).

## Final summary

Print:
```
✅ Deploy cycle complete.
- Targets synced: <list>
- Targets built: <list>
- Cache-bust triggered: <yes/no per target>
```

## Errors

- `.uemcp-targets.txt` missing → print "`.uemcp-targets.txt` not found at repo root; see CLAUDE.md §\"Q3 dev-workflow scripts — verify-deploy + setup-watcher (D136)\" for setup." Exit.
- `server/verify-deploy.mjs` missing → print "UEMCP install appears broken: `server/verify-deploy.mjs` not found. Suggest re-running `setup-uemcp.bat`." Exit.
- `--target <stem>` not in `.uemcp-targets.txt` → print available targets + abort (no silent fallback).
````

- [ ] **Step 6.2: Run the anchor test**

```bash
cd D:/DevTools/UEMCP/server && node test-slash-command-anchors.mjs
```

Expected: `Passed: 7  Failed: 0  Total: 7` (the new file adds 1 anchor ref: `Q3 dev-workflow scripts — verify-deploy + setup-watcher (D136)`, which is referenced twice in the body but is the same anchor; uniqueness counts).

If FAIL: anchor name mismatch. The CLAUDE.md header is `### Q3 dev-workflow scripts — verify-deploy + setup-watcher (D136)`; verify the command body uses the same em-dash and parenthetical.

- [ ] **Step 6.3: Smoke-test (partial — Step 1 only)**

In a Claude Code conversation, type `/deploy-cycle` (no args). Expected:
- Checkbox list rendered
- Step 1 runs `node server/verify-deploy.mjs` and surfaces per-target verdicts
- The command stops at Step 2's first action OR reports all SYNC

Do not run a full deploy in the smoke test — that requires an actual editor running and Build.bat. Verify the prompt flow + Step 1 output shape; stop the command (Ctrl-C or "skip" if prompted) before any sync writes.

- [ ] **Step 6.4: Commit**

```bash
cd D:/DevTools/UEMCP && git add .claude/commands/deploy-cycle.md && git commit -m "Add /deploy-cycle slash command"
```

---

## Task 7: Update CLAUDE.md with `/deploy-cycle` pointer + Canonical dev-cycle commands subsection

**Files:**
- Modify: `D:/DevTools/UEMCP/CLAUDE.md`

- [ ] **Step 7.1: Add the pointer sentence to "Q3 dev-workflow scripts"**

Edit CLAUDE.md. Find the `### Q3 dev-workflow scripts — verify-deploy + setup-watcher (D136)` section. At the end of the section (before the next `### ...` header), insert:

```

`/deploy-cycle` orchestrates these scripts end-to-end with stop-gates at manual steps (Build.bat, editor relaunch, MCP restart).
```

- [ ] **Step 7.2: Add the "Canonical dev-cycle commands" subsection under Common Tasks**

Edit CLAUDE.md. Find the `## Common Tasks` header. Insert a new subsection immediately after the `## Common Tasks` line and before the first `### Onboarding a new machine`:

```

### Canonical dev-cycle commands

Three project-scoped slash commands codify the high-frequency rituals (see `docs/specs/2026-05-19-dev-cycle-slash-commands-design.md`):

- **`/handoff-preflight <doc>`** — runs the 4-point pre-flight checklist (see **Handoff draft pre-flight** above). Soft advisory.
- **`/dispatch-worker <doc> [--target <stem>]`** — generates a worker-conversation opener following the 6-point **Opener content checklist** above. `--target` hydrates codenames from `.uemcp-targets.txt`.
- **`/deploy-cycle [--target <stem>]`** — walks through verify-deploy → sync-plugin (auto) → Build.bat → editor relaunch → MCP restart (manual stop-gates). See §Q3 dev-workflow scripts.
```

- [ ] **Step 7.3: Run the anchor test**

```bash
cd D:/DevTools/UEMCP/server && node test-slash-command-anchors.mjs
```

Expected: still `Passed: 7  Failed: 0  Total: 7`. The CLAUDE.md edit was additive (new subsection + sentence); anchors referenced by command bodies are unchanged.

- [ ] **Step 7.4: Confirm CLAUDE.md size stayed under 40k**

```bash
wc -c D:/DevTools/UEMCP/CLAUDE.md
```

Expected: under 40000. (Current ~36837 + ~400 additions ≈ ~37200.) If over: see if any of the existing CLAUDE.md sections can be tightened, but do NOT remove load-bearing content to make room.

- [ ] **Step 7.5: Commit**

```bash
cd D:/DevTools/UEMCP && git add CLAUDE.md && git commit -m "Document /deploy-cycle + add Canonical dev-cycle commands subsection"
```

---

## Task 8: Final integration check

**Files:** (none modified)

- [ ] **Step 8.1: Run the full rotation**

```bash
cd D:/DevTools/UEMCP/server && node run-rotation.mjs
```

Expected: all tests PASS or SKIPPED. The new `test-slash-command-anchors.mjs` shows `Passed: 7  Failed: 0  Total: 7`. Total rotation assertion count grew by 7 (~2196 → ~2203). No file shows IMPORT_ERROR, CRASHED_NO_SUMMARY, or NO_SUMMARY_PARSED.

If any test fails: investigate. The most likely cause is a CLAUDE.md edit that broke an anchor — re-read the FAIL line and fix.

- [ ] **Step 8.2: Verify all 3 commands smoke-test end-to-end**

In a Claude Code conversation (may need a new conversation to pick up the new commands):

1. `/handoff-preflight docs/handoffs/<any-existing-handoff>.md` → expect 4-section report
2. `/dispatch-worker docs/handoffs/<any-existing-handoff>.md` → expect fenced code block + post-summary
3. `/deploy-cycle` → expect checkbox list + Step 1 verify-deploy output

If any command doesn't render properly in Claude Code (e.g., fenced code block escaping issues, frontmatter parse errors): inspect the command file, fix, recommit as a follow-up commit.

- [ ] **Step 8.3: No new commit needed** — Task 8 is a verification step. If Step 8.2 surfaces a bug, that's a fix commit on whichever command file is affected.

---

## Self-review (run after authoring the plan; do not commit anything)

**Spec coverage check** — every section of `docs/specs/2026-05-19-dev-cycle-slash-commands-design.md` maps to a task:

| Spec section | Task |
|--------------|------|
| §1 Motivation | (background; no task needed) |
| §2 Architecture overview | Task 2/4/6 create the three commands per Approach A |
| §3 /handoff-preflight | Task 2 (implementation) + Task 3 (CLAUDE.md pointer) |
| §4 /dispatch-worker | Task 4 (implementation) + Task 5 (CLAUDE.md pointer) |
| §5 /deploy-cycle | Task 6 (implementation) + Task 7 (CLAUDE.md pointer + Canonical subsection) |
| §6 Shared conventions | Embedded in each command body (frontmatter, error patterns, output format) |
| §7 Testing strategy | Task 1 (anchor-check test) + manual smoke steps in Tasks 2, 4, 6 |
| §8 CLAUDE.md updates | Tasks 3, 5, 7 |
| §9 Implementation order | Tasks ordered: preflight → dispatch → deploy + CLAUDE.md updates in between |
| §10 Non-goals | Explicit — out of scope, not in any task |

All sections covered.

**Placeholder scan** — no `TBD`, `TODO`, `implement later`, or "similar to Task N" without repeating the code. All command bodies are fully specified in Step 4.2 / 4.1 / 6.1.

**Type consistency** — `<UNREAL_PROJECT_NAME>`, `<UNREAL_PROJECT_ROOT>`, `<UEMCP_REPO_PATH>` used consistently. The anchor reference convention `CLAUDE.md §"<header-text>"` used identically across all command bodies.

**One identified gap, patched inline above**: Task 7.2's "Canonical dev-cycle commands" subsection text references "see §Q3 dev-workflow scripts" without using the literal `CLAUDE.md §"..."` syntax — that's fine because the reference is in CLAUDE.md itself, not in a command body (the anchor test only checks command bodies). No fix needed.

---

## Execution handoff

After all 8 tasks complete + all commits land, the dev-cycle slash commands ship. Total assertion count grows from ~2196 to ~2203. Total CLAUDE.md size grows from ~36,837 chars to ~37,200 chars (still well under 40k).
