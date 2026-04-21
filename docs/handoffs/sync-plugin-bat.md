# sync-plugin.bat Worker — micro-handoff

> **Dispatch**: Fresh Claude Code session. **No dependencies** — runs inline or parallel with any worker.
> **Type**: Implementation — new CMD script at repo root, no code changes elsewhere.
> **Duration**: 20-30 min.
> **D-log anchors**: D61 (deferred follow-on action from gate-verification session — physical plugin copy is the dev workflow; this script automates the copy).
> **Deliverable**: `sync-plugin.bat` at `D:\DevTools\UEMCP\sync-plugin.bat` that copies plugin source-of-truth to a target project's Plugins directory, with editor-lock detection + optional nuke-rebuild guidance.

---

## Mission

D61 captured that physical xcopy (not symlink/junction/AdditionalPluginDirectories) is the working dev workflow for propagating plugin source changes from `D:\DevTools\UEMCP\plugin\UEMCP\` (source of truth) to each target project's `Plugins\UEMCP\` directory. This script automates that one operation — nothing more — so every subsequent plugin worker (Oracle-A, S-B-base-unrelated, M-enhance, M3, M5 with plugin deps) doesn't re-hit the manual-xcopy friction.

**Scope is deliberately narrow**: one script, one job. No interactive onboarding (that's `setup-uemcp.bat`'s scope). No build invocation (user runs that after sync). No plugin-version pinning (git handles that).

---

## Scope — in

### §1 Script behavior

Create `D:\DevTools\UEMCP\sync-plugin.bat`. Expected invocations:

```cmd
rem Usage 1 — explicit .uproject path
sync-plugin.bat "D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject"

rem Usage 2 — no args, prompts via PowerShell GUI (reuse setup-uemcp.bat pattern)
sync-plugin.bat
```

Steps the script performs:

1. **Resolve target .uproject** — accept first arg, or invoke PowerShell `OpenFileDialog` filtered to `*.uproject` (reuse the helper pattern already in `setup-uemcp.bat`).
2. **Validate** — `.uproject` exists, parent dir exists, has `Content\` (smoke check it's a real UE project directory).
3. **Compute paths** —
   - Source: `D:\DevTools\UEMCP\plugin\UEMCP\` (hardcode the repo-relative path; script lives at repo root so `%~dp0plugin\UEMCP\` works cleanly).
   - Target: `<uproject parent>\Plugins\UEMCP\`.
4. **Editor-lock detection** — check if `<target>\Binaries\Win64\UnrealEditor-UEMCP.dll` is write-locked (editor running). If yes, emit a warning instructing user to close the editor before re-running; exit 1. (Reuse the existing lock-detection pattern from `setup-uemcp.bat` if present; otherwise a simple `echo > ...dll 2>nul` attempt + check `ERRORLEVEL`.)
5. **Confirm before destructive write** — if target dir exists, prompt "Overwrite existing plugin at <target>? (Y/N)". Default N on blank input. Skip the prompt if `-y` / `--yes` flag passed.
6. **xcopy with exclusions** — copy source tree to target, EXCLUDING `Binaries\` and `Intermediate\` (those live on the target per-project). Use `xcopy` with `/E /I /Y /EXCLUDE:<tempfile>` pattern; exclusion file can be written to `%TEMP%` on the fly.
7. **Emit nuke-rebuild hint** — after successful copy, echo the D61 nuke recipe:
   ```
   If plugin source structure changed (new .cpp/.h files, Build.cs dep changes),
   run this from an elevated cmd before rebuilding:
     rmdir /s /q "<target>\Binaries"
     rmdir /s /q "<target>\Intermediate"
     "<UE install>\Build\BatchFiles\Build.bat" <ProjectName>Editor Win64 Development -project="<uproject>" -WaitMutex
   ```
   Don't execute the nuke/rebuild — just print the command. User decides whether to run.

### §2 Exit codes

- 0 — success
- 1 — bad arg / validation fail / editor locked
- 2 — xcopy failure (capture errorlevel, print diagnostic)
- 3 — user declined overwrite prompt

### §3 Non-requirements

- **No plugin-version validation**. Don't check `.uplugin` VersionName vs anything.
- **No .mcp.json generation** — that's `setup-uemcp.bat`.
- **No GUI beyond the .uproject browse prompt** — keep the script minimal.
- **No P4 integration** — target projects may be P4-checked-in but sync handling is user's concern.
- **No cross-platform** — Windows-only .bat. Mac/Linux users can write their own shell variant later if needed.

---

## Scope — out

- Any plugin source modification.
- Any git operations.
- Automatic rebuild invocation.
- `setup-uemcp.bat` integration (could be a follow-on but not this handoff's scope — keep sync-plugin.bat standalone).
- MCP server changes.

---

## Reference files

### Tier 1 — Scope sources
1. `docs/tracking/risks-and-decisions.md` D61 (UBT-stale-DLL recipe + physical-copy dev workflow).
2. This handoff's §1 spec.

### Tier 2 — Pattern reuse
3. `setup-uemcp.bat` — has the PowerShell `OpenFileDialog` helper + editor-lock detection + prompt-before-overwrite patterns. Reuse those; don't reinvent.
4. `test-uemcp-gate.bat` at repo root — another reference for CMD script conventions in this repo (`%~dp0`, `setlocal`, error reporting style).

### Tier 3 — Validation
5. After writing, dry-run against ProjectA: `sync-plugin.bat "D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject"` — should detect the existing `ProjectA\Plugins\UEMCP\` dir and prompt for overwrite.

---

## Success criteria

1. Script exists at `D:\DevTools\UEMCP\sync-plugin.bat`.
2. Accepts `.uproject` path as positional arg OR prompts via GUI when no args.
3. Copies plugin source to `<target>\Plugins\UEMCP\` excluding `Binaries\` + `Intermediate\`.
4. Detects editor lock and aborts gracefully.
5. Prompts before overwriting existing target directory (suppress with `-y` / `--yes`).
6. Emits D61 nuke-rebuild hint after successful copy.
7. Exit codes documented in script header.
8. Tested by running against ProjectA once (user smoke test).
9. Path-limited commit: only `sync-plugin.bat` added; no other files touched.

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **CMD, not PowerShell** as the script language — PS is invoked only for the GUI dialog. CMD is the dispatch language (matches `setup-uemcp.bat` + `test-uemcp-gate.bat` convention).
- **No AI attribution**.
- **Single commit**.
- **Don't touch plugin source, docs, or server files** — micro-scope.

---

## Final report to orchestrator

Report (keep under 150 words):
1. Commit SHA.
2. Smoke-test result against ProjectA — did the sync complete cleanly? What was the wall-clock duration?
3. Any edge cases uncovered (e.g., ProjectA's existing `Binaries\` symlinks, read-only attributes from P4, etc.).
4. Suggestion for whether `setup-uemcp.bat` should chain-call `sync-plugin.bat` for consistency, or leave independent.
5. Next action: no blocker; makes future plugin worker dispatch cleaner.
