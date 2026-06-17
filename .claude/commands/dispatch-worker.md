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
1. Read repo-local `.uemcp-targets.json` profiles if present; otherwise fall back to legacy `.uemcp-targets.txt`.
2. Find an entry where a configured alias, generated alias, `.uproject` filename stem, or full path matches `<stem-or-path>`.
3. If no match: print "target not found"; list all available targets from the resolved target config; exit (do not silently fall back to placeholders).
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

Emit the opener wrapped in a fenced code block (so the user can copy the entire block in one Ctrl-C). Follow this structure exactly (note: this template uses `<placeholder>` for substitution slots; the inner fenced block represents the actual opener content):

````
You are the <role> for: <mission>

## Handoff doc
Read `<handoff-doc-path>` (uses placeholder vocabulary per CLAUDE.md §"Public-Repo Hygiene").

## Required pre-reads
- D-log: <list of D-numbers, comma-separated>
- Handoff docs: <list of related handoff paths>
- Feedback memory: <list of feedback files>
(omit any sub-bullet whose list is empty)

[IF --target provided, include this block; else omit:]
## Codename context (EPHEMERAL — chat only; translate to placeholders before any disk write)
- <UNREAL_PROJECT_NAME> = <stem>
- <UNREAL_PROJECT_ROOT> = <parent dir>
- <UEMCP_REPO_PATH> = D:/DevTools/UEMCP/

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
- If `--target` was NOT specified AND local target config has entries: list available targets with the hint "re-run with `--target <stem>` to hydrate codenames".

## Errors

- `$ARGUMENTS` empty → usage + `Glob docs/handoffs/*.md`
- handoff doc not found → fuzzy-match suggestions
- `--target` mismatch → list available targets from `.uemcp-targets.json` or legacy `.uemcp-targets.txt` + abort (no silent fallback)
- target config missing when `--target` requested → copy `.uemcp-targets.json.example` to `.uemcp-targets.json` at repo root and fill local `.uproject` paths, or run `setup-uemcp.bat <uproject>` per CLAUDE.md §"Q3 dev-workflow scripts — verify-deploy + setup-watcher (D136)"
