# Dev-cycle slash commands — design spec

**Date**: 2026-05-19
**Status**: Approved (brainstorming session); awaiting implementation plan
**Scope**: Three project-scoped slash commands codifying the dispatch + deploy rituals currently documented as prose in CLAUDE.md.

## 1. Motivation

UEMCP runs a high-velocity orchestrator + worker dev cycle. The same rituals fire many times per day:

- **Pre-dispatch**: orchestrator should run the 4-point pre-flight checklist (`§Multi-agent orchestration → Handoff draft pre-flight checklist`) before sending an implementation worker handoff. Currently this is prose; orchestrator may forget steps (D128 walked back ~2.25 sessions of misdirection because validation discipline didn't fire).
- **Dispatch**: orchestrator drafts a 6-point conversation opener per `§Multi-agent orchestration → Opener content checklist`. Currently artisanal — every dispatch is hand-formatted.
- **Deploy**: after a worker commits, the operator runs `verify-deploy.bat` → `sync-plugin.bat` → `Build.bat` → editor relaunch → MCP restart. The sequence has caused worker-session waste when steps are skipped (D113, D135, D138 worked examples).

Codifying these as slash commands eliminates the "remembered the convention this time" failure mode and produces consistent artifacts.

## 2. Architecture overview

Three commands as project-scoped slash commands in `<repo>/.claude/commands/`:

```
.claude/commands/
├── handoff-preflight.md    ← /handoff-preflight <handoff-doc-path>
├── dispatch-worker.md      ← /dispatch-worker <handoff-doc-path> [--target <stem-or-path>]
└── deploy-cycle.md         ← /deploy-cycle [--target <stem-or-path>] [--targets <list-file>]
```

**Composition by convention, not enforcement** — Approach A from brainstorming. Each command is independent; the orchestrator chains them manually. Rejected alternatives:

- *Approach B (inline preflight inside /dispatch-worker)*: adds latency to every dispatch; the user's soft-advisory choice for preflight means the orchestrator decides regardless, so inline invocation is mostly ceremonial after the first run.
- *Approach C (--skip-preflight escape hatch)*: escape hatches get used reflexively, weakening the safeguard.

**Linkage to existing surfaces**:

- `/handoff-preflight` codifies the 4-point checklist in `CLAUDE.md §Multi-agent orchestration → Handoff draft pre-flight checklist`.
- `/dispatch-worker` codifies the 6-point checklist in `CLAUDE.md §Multi-agent orchestration → Opener content checklist`.
- `/deploy-cycle` wraps the existing `verify-deploy.bat` + `sync-plugin.bat` + Build.bat ritual; doesn't replace any script.

**Source-of-truth deference**: command bodies re-read CLAUDE.md per invocation rather than hardcoding its content. Key Design Rule 1 in spirit — CLAUDE.md remains the canonical source; the commands codify the *workflow*, not the content.

## 3. /handoff-preflight

**Invocation**: `/handoff-preflight <handoff-doc-path>`

**Behavior**: soft advisory — runs 4 checks, reports findings inline, leaves the decision (proceed / validation-audit / revise / decompose) with the orchestrator.

### 3.1 Checks

| Check | Method | Output |
|-------|--------|--------|
| §0 Prior art | Extract capability names (function names, tool names, file paths) from handoff's "create/implement/build" sections. Grep `server/` + `plugin/UEMCP/Source/` + `docs/specs/` for existing implementations. | List of (capability → existing file:line hits) or "no duplicates" |
| §1 Empirical claims | Scan handoff for patterns: "X is bugged" / "Y doesn't work" / "Z is too slow" / "we're seeing" / "n=N observations". For each, check whether same paragraph cites a source `file:line` OR a reproduction command (curl, test invocation, standalone script). | Flagged claims (paragraph + missing-backing reason) or "all claims source-backed" |
| §2 Build-system workarounds | Grep `*.Build.cs` for `bUseUnity = false`, `IWYU.MinSourceFiles = 0`, `PrivateDefinitions[]`, `MinFilesUsingPrecompiledHeaderOverride`. | Findings with one-line context or "no workarounds" |
| §3 Session estimate | Count file paths mentioned in handoff's "create/modify/implement" sections. Heuristic: ~50 lines/file × file count ÷ 500 lines/session. | Estimate "<N> sessions". Flag D129 trigger if >3. |

### 3.2 D129 trigger detection

In addition to §3's size trigger, §1 detects:

- ≥2 prior hypotheses on the same problem appear in the D-log as falsified → recommend validation audit regardless

The detection is heuristic (regex over the handoff + D-log). False positives are acceptable; false negatives are the costly class.

### 3.3 Output format

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

### 3.4 Error handling

- `$ARGUMENTS` empty → usage hint + `Glob docs/handoffs/*.md` for suggestion list
- Handoff doc not found → fuzzy-match suggestions from `docs/handoffs/`

### 3.5 Frontmatter

```yaml
---
description: Run the 4-point handoff pre-flight checklist (prior-art / empirical-claim / build-system / session-estimate)
argument-hint: <handoff-doc-path>
---
```

### 3.6 Non-goals

- Decide whether to proceed (soft advisory; decision is the orchestrator's)
- Write findings to a file (chat output only; no stale-state class)
- Validate empirical claims itself (requires source-reading + repro; that's a separate validation-audit dispatch)

## 4. /dispatch-worker

**Invocation**: `/dispatch-worker <handoff-doc-path> [--target <stem-or-path>]`

**Behavior**: read handoff doc, optionally hydrate codenames from `.uemcp-targets.txt`, generate a complete worker-conversation opener following the 6-point checklist in CLAUDE.md.

### 4.1 Inputs

1. **$1**: handoff doc path (required)
2. **--target <stem|full-path>**: codename hydration (optional; default = placeholders)
3. **CLAUDE.md** (re-read each invocation): canonical 6-point structure + standing constraints list

### 4.2 Codename hydration

Default behavior: render opener with placeholders only (committed-channel safe; can be pasted anywhere).

With `--target <stem>`:
1. Read `.uemcp-targets.txt`
2. Find `.uproject` matching by filename stem or full path
3. Build substitution map:
   - `<UNREAL_PROJECT_NAME>` ← `.uproject` filename stem
   - `<UNREAL_PROJECT_ROOT>` ← parent directory of `.uproject`
   - `<UEMCP_REPO_PATH>` ← `D:/DevTools/UEMCP/` (constant for this repo)
4. Substitute into the opener, marking the codename section as ephemeral

**Strict on mismatch**: `--target <bad-name>` aborts with the list of available targets. Silent fallback to placeholders would be a footgun (user expected hydration; got committed-channel content).

### 4.3 Opener structure

For each of CLAUDE.md's 6 points:

1. **Role + mission** — derive role from handoff filename prefix (audit-fix / cleanup / implementation / smoke / validation); mission from first `Mission:` line, else first non-frontmatter paragraph, else filename slug. Surface the fallback used in the post-block summary so the orchestrator can manually refine if needed.
2. **Handoff doc pointer** — `Read docs/handoffs/<name>.md (uses placeholder vocabulary)`
3. **Pre-reads** — extract from handoff via regex:
   - D-log refs: `D\d{2,3}`
   - Related handoff docs: `docs/handoffs/[a-z0-9-]+\.md`
   - Feedback memory refs: `feedback_[a-z_]+\.md`
   Dedupe + list
4. **Codename context** — only if `--target`. Mark clearly: "Codenames below stay in chat; translate to placeholders before any disk write." Show the substitution map.
5. **Constraints** — pull verbatim from CLAUDE.md (D49 path-limit, D82 NDA-gate, no AI attribution, Desktop Commander for git, single-commit preference, report-length cap). Re-reading ensures freshness.
6. **Final-report format** — `Report to docs/reports/<dated-filename>.md (not docs/handoffs/). Cap report per CLAUDE.md guidance.`

### 4.4 Output

- Full opener wrapped in a fenced code block (copy-paste ready in one Ctrl-C)
- Below the block: 1-line summary of generation + hydration status
- If `--target` not specified AND `.uemcp-targets.txt` has entries: list available targets as hint (`re-run with --target <stem> to hydrate`)

### 4.5 Error handling

- `$1` missing → usage hint + `Glob docs/handoffs/*.md` for suggestion list
- Handoff doc not found → fuzzy-match suggestions
- `--target` not in `.uemcp-targets.txt` → list available + abort

### 4.6 Frontmatter

```yaml
---
description: Generate a worker-conversation opener from a handoff doc following the 6-point checklist
argument-hint: <handoff-doc-path> [--target <stem>]
---
```

### 4.7 Non-goals

- Auto-call `/handoff-preflight` first (Approach A — independent commands)
- Write the opener to a file (no stale-state class)
- Choose a codename based on chat-context heuristic (footgun-prone)
- Validate the handoff doc itself (that's `/handoff-preflight`'s job)

## 5. /deploy-cycle

**Invocation**: `/deploy-cycle [--target <stem-or-path>] [--targets <list-file>]`

**Behavior**: walks through the deploy ritual; auto-runs the automatable scripts; stop-gates at manual steps (Build.bat, editor relaunch, MCP restart).

### 5.1 Steps

| Step | Auto / Manual | What happens |
|------|---------------|--------------|
| 1 — verify-deploy | Auto | Run `node server/verify-deploy.mjs <args>`; surface per-target verdict + flags |
| 2 — sync-plugin | Auto (per-target, with [EDITOR-LOCKED] hard-stop) | For each NEEDS-SYNC target: if [EDITOR-LOCKED], stop with close-editor instruction; else auto-run `sync-plugin.bat <target> -y`; surface W-L marker cache-bust if triggered |
| 3 — Build.bat | **Stop-gate** | Print copy-paste-ready Build.bat command per target; prompt user for UE_ROOT if unknown (session-cache); wait for "done" or error paste |
| 4 — Editor relaunch | **Stop-gate** | Print relaunch instruction + .uproject full path; wait for confirmation |
| 5 — MCP restart | **Stop-gate** | Print restart instruction (new conversation in stdio transport); surface env vars from `.mcp.json` so user knows what re-applies |

### 5.2 Per-target editor-lock handling

Per CLAUDE.md (W-L hardening, D138 §2): only the workspace whose `.uproject` matches a running editor's CommandLine is blocked. Sync against workspace B is not blocked by an editor on workspace A.

When [EDITOR-LOCKED] flag appears in Step 1: that specific target gets a hard-stop in Step 2 with a clear close-editor instruction. Other targets continue.

### 5.3 W-L cache-bust surfacing

When `sync-plugin.bat`'s deploy-marker comparison triggers `Binaries/`+`Intermediate/` nuke (manifest.json version OR UEMCP.uplugin Version changed):

- Surface in Step 2 output: "Cache-bust triggered for <target>; next build will be a clean rebuild (significantly slower than incremental)."
- Sets user expectation before Step 3's stop-gate

### 5.4 Build.bat command template

```
"<UE_ROOT>\Engine\Build\BatchFiles\Build.bat" UEMCPEditor Win64 Development -Project="<full-uproject-path>" -WaitMutex -FromMsBuild
```

- Paths quoted to handle spaces
- `-WaitMutex` prevents parallel-build clash when processing multiple targets
- `UE_ROOT` prompted once per session; cached for subsequent targets

### 5.5 Output format

Checkbox-list rendering, updating in place:

```
☑ Step 1 — verify-deploy: 2/3 targets need sync
☑ Step 2 — sync-plugin: 2 synced, 0 blocked
☐ Step 3 — Build.bat: waiting for user (target: &lt;project-stem&gt;)
☐ Step 4 — Editor relaunch
☐ Step 5 — MCP restart
```

After each stop-gate: summarize current state + what's expected next.

On failure (sync error, persistent editor-lock, Build.bat error pasted by user): stop the cycle; summarize what succeeded + what's blocked; give actionable next step.

### 5.6 Error handling

- `.uemcp-targets.txt` missing → reference CLAUDE.md §Q3 dev-workflow for setup
- `server/verify-deploy.mjs` missing → UEMCP install broken; suggest reinstall
- `--target` not in `.uemcp-targets.txt` → list available + abort

### 5.7 Frontmatter

```yaml
---
description: Deploy cycle walkthrough — verify-deploy → sync-plugin (auto) → Build.bat (manual) → relaunch (manual) → MCP restart (manual)
argument-hint: [--target <stem>] [--targets <list-file>]
---
```

### 5.8 Non-goals

- Auto-close the editor (would corrupt unsaved work)
- Auto-run Build.bat (long-running; output unwieldy in chat)
- Restart its own host MCP server (impossible — the command runs IN the server context; restart requires new conversation)
- Parallelize across targets (sync-plugin.bat assumes serialized invocation)

## 6. Shared conventions

| Aspect | Convention |
|--------|------------|
| **Frontmatter** | `description:` (one-line, shown in `/` autocomplete) + `argument-hint:` (positional + flag shape) |
| **Source-of-truth deference** | Each command re-reads CLAUDE.md for canonical structure. Don't hardcode CLAUDE.md content. |
| **Error pattern** | Terse + one actionable next step. No stack traces. Glob-suggest fuzzy matches when a path arg is wrong. |
| **Output format** | Markdown headings (`##`, `###`); fenced code blocks for copy-paste-ready content; checkbox lists for multi-step progress |
| **Codename handling** | Default placeholders. `--target` opt-in. Strict on mismatch (abort, don't silently fall back). |
| **Path handling** | Accept forward-slash or backslash (Windows). Quote paths with spaces in emitted shell commands. Repo-relative arguments where possible. |
| **NDA-gate scope** | Per CLAUDE.md §Public-Repo Hygiene: NDA-gate is repo-write-only. Commands may execute against the user's UE projects at full capability; the gate is about committed content. |
| **Stop-gate copy** | When stopping for user action, the resume hint is explicit ("paste 'done' or the error output and I'll continue"). Never silently wait. |

## 7. Testing strategy

Slash commands aren't traditional code; testing is structural + smoke.

### 7.1 CLAUDE.md anchor check (automated)

New test file: `server/test-slash-command-anchors.mjs`. Adds ~10 assertions to the rotation. For each `.claude/commands/*.md`:

1. Read the command body
2. Extract referenced CLAUDE.md sections via regex (e.g., `§Multi-agent orchestration → Opener content checklist`)
3. Verify each anchor still exists as a header in CLAUDE.md
4. FAIL-LOUD if a CLAUDE.md edit breaks a referenced anchor

Wires into `run-rotation.mjs` automatically (glob picks up `test-*.mjs`).

### 7.2 Manual smoke (per-command)

| Command | Smoke invocation |
|---------|------------------|
| `/handoff-preflight` | Against `docs/handoffs/new-2-batch-endpoint-fix.md` (or whichever exists). Verify all 4 sections rendered. |
| `/dispatch-worker` | Against `docs/handoffs/<existing>.md` (1) without `--target` → placeholders only; (2) with `--target <stem-from-.uemcp-targets.txt>` → hydrated. |
| `/deploy-cycle` | (1) No args, current `.uemcp-targets.txt` → reaches Step 1 output cleanly; (2) `--target <stem>` → scoped to one target. |

No live UE editor required for smoke tests — verify-deploy.mjs runs offline; the stop-gates exercise the prompt path without needing a build.

### 7.3 What's NOT tested

- The handoff-doc parsing heuristics (regex extraction of file paths / D-log refs). These are best-effort by design; false negatives degrade gracefully (orchestrator notices a missing pre-read).
- Cross-command composition (since Approach A is "compose by convention").

## 8. CLAUDE.md updates

Estimated ~400 chars total addition (well within the 40k budget).

| Location | Addition |
|----------|----------|
| §Common Tasks → new subsection "Canonical dev-cycle commands" | 3-bullet pointer: `/handoff-preflight`, `/dispatch-worker`, `/deploy-cycle` — one-line description each, with `→ §<source-section>` link |
| §Multi-agent orchestration → Handoff draft pre-flight checklist | Final sentence: "Use `/handoff-preflight <doc>` to run this automatically." |
| §Multi-agent orchestration → Opener content checklist | Final sentence: "Use `/dispatch-worker <doc> [--target <stem>]` to generate an opener following this structure." |
| §Q3 dev-workflow scripts | Final sentence: "`/deploy-cycle` orchestrates these scripts end-to-end with stop-gates at manual steps." |

## 9. Implementation order

Suggested for the implementation plan (writing-plans skill will refine):

1. **`/handoff-preflight`** first — highest leverage, lowest implementation risk (it's pure read+report). Validates the slash-command pattern + CLAUDE.md anchor convention before the more complex commands.
2. **`/dispatch-worker`** second — depends on the codename-hydration pattern + `.uemcp-targets.txt` reading; reuses learnings from /handoff-preflight.
3. **`/deploy-cycle`** third — touches shell scripts (largest blast radius); benefits from the smaller commands being already validated.
4. **CLAUDE.md updates** + **test-slash-command-anchors.mjs** in the final commit of each command (so anchors are added alongside the command that references them).

## 10. Non-goals (out of scope for this spec)

Tracked for follow-up brainstorms, NOT this implementation:

- `/d-log-add` — author a properly-formatted D-log entry
- `/d-log-search <topic>` — grep + summarize relevant D-log entries
- `/orchestrator-migrate` — generate state doc + opener for successor orchestrator at context-limit handoff
- `/save-feedback` — formalize feedback memory authoring
- `/validation-audit-spec` — when D129 triggers, draft the 1-session validation audit handoff
- `/codename-scrub <files>` — chat-side pre-commit codename grep mirroring `.githooks/pre-commit`
- `/worker-report-reconcile <report-path>` — reconcile worker report against current repo state, draft next handoff
- `/run-rotation` — wrap `npm test` with FAIL-LOUD output parsing

Each of these is plausible; none is required for the dispatch + deploy chain this spec covers.
