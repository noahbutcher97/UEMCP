# Repository Guidelines

## Project Structure & Module Organization

UEMCP is a Windows-focused monorepo for an Unreal Engine MCP bridge. The Node.js MCP server lives in `server/` and uses ES modules (`*.mjs`). The Unreal Engine editor plugin lives in `plugin/UEMCP/`, with public headers in `Source/UEMCP/Public/`, implementation files in `Source/UEMCP/Private/`, and C++ automation tests in `Source/UEMCP/Private/Tests/`. Project documentation is under `docs/`; start with `docs/README.md`, `docs/specs/architecture.md`, and `tools.yaml`, the source of truth for tool definitions. Session-local docs are split by purpose: `docs/handoffs/` for orchestrator-authored task specs, `docs/reports/` for worker returns, and `docs/audits/` for point-in-time audit artifacts.

Before making capability claims or recommending roadmap work, use the [question-based documentation routes](docs/README.md#find-information-by-question) to reconcile the relevant tool definition, capability contract and backlog status. Apply the same lookup during discussion as during implementation; do not infer missing functionality from recent conversation alone.

## Build, Test, and Development Commands

Run server commands from `server/` unless noted.

```cmd
npm install
npm test
node run-rotation.mjs --json
node server.mjs
```

`npm install` installs server dependencies. `npm test` runs the default rotation via `run-rotation.mjs`. Use `--json` for machine-readable output. `node server.mjs` starts the MCP server over stdio. Normal MCP sessions attach from workspace roots or `attach_project`; set `UEMCP_PROJECT_ATTACH_MODE=env` with `UNREAL_PROJECT_ROOT` only for explicit compatibility or CLI tests.

Root-level Windows helpers:

```cmd
setup-uemcp.bat "path\to\Project.uproject"
migrate-targets.bat
sync-plugin.bat "path\to\Project.uproject" -y
verify-deploy.bat
test-uemcp-gate.bat
smoke-live.bat
```

Use `sync-plugin.bat` to copy `plugin/UEMCP/` into a target project. Use local `.uemcp-targets.json` profiles, based on `.uemcp-targets.json.example`, for repeated `attach_project`, `verify-deploy`, and live-smoke workflows; run `migrate-targets.bat` to convert an existing legacy `.uemcp-targets.txt`. After plugin C++ changes, close the editor, sync, run Unreal `Build.bat`, relaunch the editor, and restart the MCP client.
For the Win64 BuildPlugin and packaged-fixture gate, follow the
[local matrix example](docs/fixture-host.md#stage-a-fresh-host) and pass a fresh
`-OutputRoot` inside the task directory. The default matrix covers UE 5.3/5.6/5.7.
Use `-VersionsCsv` for a narrower run. Preserve the relevant diagnostic receipt
before removing its staged source and package.

## Coding Style & Naming Conventions

Keep JavaScript as ES modules and follow the existing `*.mjs` style: two-space indentation, semicolons, `const`/`let`, and focused helpers. Test files are named `server/test-*.mjs`; shared utilities stay in `test-helpers.mjs` or `test-fixtures.mjs`.

For Unreal C++, follow the existing UE style: tabs for indentation, PascalCase types/functions, UE-prefixed types where applicable, and headers in `Public/` only for cross-file interfaces. Prefer shared helpers such as `HandlerCommon` over duplicated anonymous-namespace utilities.

## Testing Guidelines

Exercise user-facing changes through a real provider client using the [agent workflow usability protocol](docs/agent-workflow-usability.md). Record the user task, friction and independent editor result. Use the nearest real caller for internal changes that affect a user workflow.

For a real provider attached to a disposable fixture, configure its UEMCP server as `node <absolute checkout path>/server/fixtures/stdio-test-server.mjs`. This uses the production tools and transport while keeping generated project names out of the developer's NDA lists. Real project installations use `server/server.mjs`.

For engine-specific native or live qualification, locate the UEMCP-owned project
through the [fixture host guide](docs/fixture-host.md#locate-an-owned-host-by-engine)
and verify its engine manifest before selecting a deployment target.

Before submitting server or tool-surface changes, run `npm test`. Use `node run-rotation.mjs --include-live-gated` only when Unreal Editor is running and reachable on the expected TCP port. For plugin deployment checks, run `verify-deploy.bat` before and after syncing. Use `test-uemcp-gate.bat` as a commandlet-gate smoke test. Use `smoke-live.bat` for the opt-in live-editor smoke suite after relaunching the editor and restarting the MCP client; it skips cleanly unless `UEMCP_LIVE_SMOKE=1` is set.

## Commit & Pull Request Guidelines

Recent history uses short, scoped subjects with a decision or dispatch prefix, for example `D144 W-B Zod enum sharpening - 4 sites + invalid-enum tests`. Keep commits focused, mention the affected area, and include test or verification results in the body when useful.

Pull requests should describe the behavioral change, list commands run, call out plugin deployment requirements, and link relevant docs or decision-log entries. Include screenshots only for visual or editor-facing changes.

Publish verified changes with the normal Git hooks. Stale local consumer installations are advisory. Sync and rebuild a consumer when it is selected for deployment.

## Security & Configuration Tips

Do not commit machine-local configuration or sensitive paths. `.mcp.json`, `.uemcp-targets.json`, `.uemcp-targets.txt`, logs, `node_modules/`, UE `Binaries/`, and `Intermediate/` are intentionally ignored. Use `.mcp.json.example` as the template for client configuration, `.uemcp-targets.json.example` for new local target profiles, and `migrate-targets.bat` only for local conversion of existing legacy lists.

## Worktree and scratch cleanup

Use `.worktrees/<task-name>` under this repository for new worktrees. The older
sibling worktree directory is legacy; do not create another worktree root. Reuse
an appropriate clean checkout when isolation is unnecessary.

Keep the directory containing the repositories clear of task output. For local
qualification, the coordinator runs `./new-task-root.ps1 -Task <short-name>` once
and gives the returned path to every worker. It creates one task directory under
`.scratch/runs/` in the primary checkout, shared by all engine versions, CLI
clients and retries. Use it for matrix output, private tool profiles and caches.
Pass `-ExternalFixture` for a run that stages a fresh host, since the staging
tool requires a root outside its source checkout. Store an issue's retained
reproducer under `.scratch/retained/<issue>/` with its release condition in the
backlog and its verification receipt outside the disposable tree.
Create child directories only as callers need
them. Attach to the supplied task path when resuming. Ordinary tests that already
use and clean their own temporary directories can continue doing so.

The coordinator owns cleanup across workers. Fill in `RUN.md` at allocation.

For every disposable file or directory inside a run created by
`new-task-root.ps1` (including `-ExternalFixture` runs), **start cleanup with
`clear-task-output.ps1`**. Never try a manual or recursive delete first or
use one to bypass a refusal. In PowerShell 7.2+ from the checkout, set
`$taskRoot` to the allocated run path and `$output` to the literal relative
path of one retired output. Pass any recorded owner PIDs with
`-OwnerProcessId` on both calls.

```powershell
$preview = ./clear-task-output.ps1 -RunRoot $taskRoot -Output $output
$preview
# Check State, RunId, Path and Bytes against the run record before applying.
./clear-task-output.ps1 -RunRoot $taskRoot -Output $output -Apply $preview.PreviewId
```

Apply only a matching `Preview`. Verify the path is absent after removal.
If the output changed or cleanup was interrupted, inspect what remains before
generating a fresh preview.

At final closeout, verify the run identity and copy the closeout receipt outside
the run. Once only `RUN.md` and `.uemcp-run.json` remain, remove those two
reserved records by literal path, remove the empty run directory nonrecursively,
and verify it is absent.

Before a large copy, check free space and the size of the selected files. Prefer
the installed toolchain and a private profile. Record why any engine copy is
needed, what can be excluded, and when it will be removed. Keep only one active
copy per required engine within a task. Apply exclusions before copying and
budget peak space across concurrent workers. Serialize builds when their combined
outputs would exceed available space. For a failed attempt, extract its log,
manifest and relevant hashes before allocating the retry. Retain the smallest
reproducer that still exercises an outstanding defect.

Before staging a toolchain with read-only inputs, copy one representative file
using the intended method. Verify its digest and attributes on both ends and
exercise cleanup on the copy before scaling up.

At task start, record the worktree, branch, owned processes and temporary output
roots. At task completion or merge:

- Check tracked changes, untracked files, ignored evidence/configuration and
  commits not reachable from main. A clean status alone does not prove redundancy.
- Preserve unique work and concise verification receipts before removal. Record
  any retained worktree with its owner/task, reason and next action in a local
  audit; do not discard another session's work or private configuration.
- Stop only processes started for the task. Confirm the exact resolved removal
  path is within the intended worktree/scratch root and that it is inactive.
  Inspect junctions/symlinks and shared dependency targets before recursive
  cleanup; never traverse into another checkout through a shared link.
- Remove retired checkouts with `git worktree remove`; do not force removal to
  bypass unexplained dirty files. Delete merged task branches after verifying
  recovery through the merged commit. Clean owned fixtures and disposable outputs.
- Reconcile the live task directory with `RUN.md` after the last process exits.
  Remove generated files and empty directories as each lane finishes. Copy the
  concise closeout to the primary checkout's local report. For every retained
  path record its owner, size, specific next use and removal trigger. Record the
  exact remaining path and reason if cleanup is blocked. When nothing needs
  retention, remove the task directory itself. See the
  [fixture and packaging examples](docs/fixture-host.md#stage-a-fresh-host).
- When automatic approval review rejects removal, record the exact target,
  attempted action and stated reason. Recheck what remains and report its
  measured size to the user. Respect the denial across tools and workers.
  Use a narrower cleanup only when it addresses the stated objection and falls
  within the approved scope. For an explicit denial on the target itself,
  leave it in place for owner disposition. Budget the next step using measured
  free space and count reclaimed space only after filesystem readback.
- End with `git status --short` and `git worktree list`, and report anything
  intentionally retained. Do not claim the repository is fully cleaned merely
  because the primary checkout is clean.
