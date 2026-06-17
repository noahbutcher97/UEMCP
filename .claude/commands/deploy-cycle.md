---
description: Deploy cycle walkthrough — verify-deploy → sync-plugin (auto) → Build.bat (manual) → relaunch (manual) → MCP restart (manual) → live smoke (optional)
argument-hint: [--target <stem>] [--targets <config-file>] [--profile <name>]
---

Walk the user through the UEMCP deploy cycle. Auto-run the automatable scripts; stop-gate at manual steps (Build.bat, editor relaunch, MCP restart). Reference: CLAUDE.md §"Q3 dev-workflow scripts — verify-deploy + setup-watcher (D136)".

## Parse arguments

Parse `$ARGUMENTS` for:
- `--target <stem|full-path>` (optional): limit to one target
- `--targets <path>` (optional): override `.uemcp-targets.json` / legacy `.txt` location
- `--profile <name>` (optional): select a structured target profile (`all` is built in)
- (no args): process the `default` structured profile, or legacy `.uemcp-targets.txt` if no JSON file exists

## Render initial checkbox list

Print:
```
☐ Step 1 — verify-deploy
☐ Step 2 — sync-plugin
☐ Step 3 — Build.bat (manual)
☐ Step 4 — Editor relaunch (manual)
☐ Step 5 — MCP restart (manual)
☐ Step 6 — live smoke (optional)
```

Update the relevant box to ☑ after each completed step. Re-print the full list at each transition so progress is visible.

## Step 1 — verify-deploy (auto)

Run:
```bash
node server/verify-deploy.mjs <forwarded-args>
```

Forward `--target` / `--targets` / `--profile` if provided. Capture stdout.

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

Mark Step 5 ☑ when user replies (`done` OR `skip`). Continue to Step 6.

## Step 6 — live smoke (optional)

Print:

```
Optional but recommended after plugin or server tool-surface changes:

set UEMCP_LIVE_SMOKE=1
set UNREAL_PROJECT_ROOT=<full-project-root>
smoke-live.bat

Without UEMCP_LIVE_SMOKE=1 this skips cleanly, so it is safe to run as a no-op check.
If the editor is down, the runner also skips cleanly instead of reporting a feature failure.

Reply `done` after the live smoke passes, `skip` if you are deferring the live run, or paste any failure output.
```

**Wait for user response.**

If user pastes `done`: mark Step 6 ☑ and continue to Final summary.

If user pastes `skip`: mark Step 6 ⊘, note "live smoke deferred", and continue to Final summary.

If user pastes a failure: stop the cycle. Summarize what succeeded (verify-deploy, sync, build, relaunch, MCP restart) and the live-smoke failure. Do not call the deploy cycle complete.

## Final summary

Print:
```
✅ Deploy cycle complete.
- Targets synced: <list>
- Targets built: <list>
- Cache-bust triggered: <yes/no per target>
- Live smoke: <passed / skipped / deferred>
```

## Errors

- `.uemcp-targets.json` and legacy `.uemcp-targets.txt` missing → print "No UEMCP target config found at repo root; copy `.uemcp-targets.json.example` to `.uemcp-targets.json` and fill local `.uproject` paths." Exit.
- `server/verify-deploy.mjs` missing → print "UEMCP install appears broken: `server/verify-deploy.mjs` not found. Suggest re-running `setup-uemcp.bat`." Exit.
- `--target <stem>` / `--profile <name>` not in target config → print available targets/profiles + abort (no silent fallback).
