# UEMCP — Unreal Engine MCP bridge for Claude

A monorepo that gives Claude (via MCP) read + write access to Unreal Engine 5.6 projects. Ships a **Node.js MCP server** (`server/`) and a **C++ UE5 editor plugin** (`plugin/UEMCP/`).

Built for Unreal Engine 5 projects; the tool itself is project-agnostic. In normal MCP sessions it attaches from the client workspace roots when there is exactly one unambiguous `.uproject`, or by an explicit `attach_project` call.

---

## Quick start — onboard a new machine

**Prerequisite**: Windows 10 1809+ or Windows 11. (Node.js not required up front — the setup script will offer to install it.)

1. Clone this repo anywhere — e.g. `D:\DevTools\UEMCP\`.
2. Double-click `setup-uemcp.bat` (or run from cmd).
3. If prompted about installing Node → hit Enter to accept (uses winget with user-scope, no admin needed; falls back to direct MSI if winget isn't present).
4. If Node was just installed → **close that cmd window** and re-run `setup-uemcp.bat` in a fresh cmd (Windows PATH doesn't refresh mid-session).
5. Pick your Claude workspace folder (where `.mcp.json` lands).
6. Pick your target `.uproject` (the plugin gets copied into its `Plugins/` dir).
7. Done. Open the project in Unreal Editor once to compile the plugin, then start Claude Code in your workspace — UEMCP attaches automatically.

### Arg mode (scripted / repeat-run)

```cmd
setup-uemcp.bat "path/to/YourProject/YourProject.uproject"
```

Auto-detects the workspace root: if the `.uproject`'s parent directory contains `.claude\` or `CLAUDE.md`, that parent is used; otherwise the `.uproject`'s own directory.

### Re-running to sync plugin updates

When the plugin source changes (e.g. after a `git pull` that updates `plugin/UEMCP/`), re-copy it into the target project:

```cmd
sync-plugin.bat "path/to/YourProject/YourProject.uproject"
```

Source of truth is `D:\DevTools\UEMCP\plugin\UEMCP\`; the script xcopies it into `<project>\Plugins\UEMCP\`, excluding `Binaries\` and `Intermediate\` so UBT cache stays intact.

Pass `-y` / `--yes` to suppress the overwrite prompt for scripted use.

### Dev-workflow: auto-deploy + verify (D136)

For active plugin development (when you're frequently editing `plugin/UEMCP/Source/`):

```cmd
verify-deploy.bat              :: profile-scoped SYNC/STALE report incl. editor-lock detection
setup-watcher.bat              :: long-running file-watcher; auto-syncs on every source change
migrate-targets.bat            :: convert legacy .uemcp-targets.txt into structured profiles
```

`verify-deploy` and `setup-watcher` read local `.uemcp-targets.json` profiles by default, falling back to legacy `.uemcp-targets.txt` when no structured file exists. `verify-deploy` is a fast pre-flight that catches the "DLL stale because editor was running during Build.bat" silent no-op. `setup-watcher` is the optional always-on counterpart that prevents drift from accumulating. Use `.uemcp-targets.json.example` as the template for new profile files, or `migrate-targets.bat` to convert an existing legacy list; real paths stay gitignored.

### Verifying the install

After re-opening cmd in the workspace root:

```cmd
claude
```

Then inside Claude: `project_info` should return the detected UE project + version.

---

## Manual setup (if setup script fails)

1. Install Node.js LTS (v20+): `winget install OpenJS.NodeJS.LTS` or https://nodejs.org/.
2. `cd <UEMCP_REPO_PATH>/server && npm install`.
3. Copy `.mcp.json.example` to your workspace root as `.mcp.json`; substitute `<UEMCP_REPO_PATH>` with this repo path.
4. Add your `.uproject` paths to repo-local `.uemcp-targets.json` profiles or call `attach_project` from the MCP session when needed; target aliases can be scoped with `target_profile`, and `list_project_targets({ profile: "all" })` shows every structured target.
5. Copy `plugin/UEMCP/` into `<your-project>/Plugins/UEMCP/` (or run `sync-plugin.bat <uproject>`).
6. Open the project in Unreal Editor once to compile the plugin.
7. Restart Claude Code.

Legacy `.uemcp-targets.txt` remains compatibility-only; migrate existing lists with `migrate-targets.bat`, or register a new target with `setup-uemcp.bat "<path-to-project.uproject>"`. Legacy env-authoritative attachment remains available for CLI compatibility by setting `UEMCP_PROJECT_ATTACH_MODE=env` together with `UNREAL_PROJECT_ROOT`, but it is not the default MCP setup.

---

## Running the server locally (dev only)

```cmd
cd <UEMCP_REPO_PATH>/server
node server.mjs
```

Ctrl+C to stop. Server talks MCP over stdio; use a client like Claude Code's `.mcp.json` or `npx @modelcontextprotocol/inspector` to interact. For a project-less terminal session, use `attach_project` after startup or run with explicit env mode for compatibility tests.

---

## Architecture — Active Runtime Layers

```
Claude ↔ MCP server (stdio) ↔ active runtime layers:
  offline      — project-file reads after attachment
  tcp-55558    — UEMCP editor plugin commands
  http-30010   — Unreal Remote Control HTTP
```

`tools.yaml` is the registry source of truth. The current registry exposes 10 always-loaded management tools plus project-scoped dynamic toolsets. Project-scoped tools stay hidden or blocked until a session project is attached. Dated conformance-oracle documents are archival provenance only; they are not setup or runtime guidance.

---

## Repo layout

```
UEMCP/
├── README.md                ← you are here
├── CLAUDE.md                ← project instructions for AI agents (read this if contributing)
├── tools.yaml               ← single source of truth for all tool registry entries
├── .mcp.json.example        ← template Claude Desktop / Code config
├── .uemcp-targets.json.example ← template local deploy/smoke target profiles
├── setup-uemcp.bat          ← new-machine onboarding (GUI or arg)
├── migrate-targets.bat      ← convert legacy target lists to JSON profiles
├── sync-plugin.bat          ← propagate plugin source changes to target projects
├── verify-deploy.bat        ← Q3-A pre-dispatch SYNC/STALE/editor-lock report (D136)
├── setup-watcher.bat        ← Q3-C auto-deploy file-watcher (D136)
├── smoke-live.bat           ← opt-in live-editor smoke runner wrapper
├── test-uemcp-gate.bat      ← verify D57 commandlet gate (smoke test)
├── server/                  ← Node.js MCP server (ES modules .mjs)
├── plugin/UEMCP/            ← C++ UE5 editor plugin
└── docs/                    ← architecture, plans, decisions — see docs/README.md
```

---

## Current state + contributing

See [`CLAUDE.md`](CLAUDE.md) for the authoritative project-state snapshot (Phase 3 progress, test baseline, what's shipped, what's in-flight).

See [`docs/README.md`](docs/README.md) for the full documentation index and reading order.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| `setup-uemcp.bat` opens and closes instantly | Already fixed — pull latest. Script now pauses on error so you can read the message. |
| `node --version` not recognized after install | Close the cmd window and open a fresh one; Windows PATH doesn't refresh mid-session. |
| Plugin doesn't appear in Unreal Editor | Verify `<project>\Plugins\UEMCP\UEMCP.uplugin` exists. Re-run `sync-plugin.bat`. |
| Port 55558 conflict in editor | Another UEMCP editor is running. Close it first. |
| `test-uemcp-gate.bat` reports `[FAIL]` | Likely stale DLL from UBT cache — `rmdir /s /q <project>\Plugins\UEMCP\Binaries <project>\Plugins\UEMCP\Intermediate` then rebuild via `Build.bat`. See D61 in `docs/tracking/risks-and-decisions.md`. |
