# UEMCP — Unreal Engine MCP bridge for Claude

A monorepo that gives Claude (via MCP) read + write access to Unreal Engine 5.6 projects. Ships a **Node.js MCP server** (`server/`) and a **C++ UE5 editor plugin** (`plugin/UEMCP/`).

Built for a pair of private Unreal Engine 5 projects; the tool itself is project-agnostic (accepts any `.uproject` via `UNREAL_PROJECT_ROOT`).

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
3. Copy `.mcp.json.example` to your workspace root as `.mcp.json`; substitute `<UEMCP_REPO_PATH>`, `<UNREAL_PROJECT_ROOT>`, `<UNREAL_PROJECT_NAME>` with real paths (use forward slashes).
4. Copy `plugin/UEMCP/` into `<your-project>/Plugins/UEMCP/` (or run `sync-plugin.bat <uproject>`).
5. Open the project in Unreal Editor once to compile the plugin.
6. Restart Claude Code.

---

## Running the server locally (dev only)

```cmd
cd <UEMCP_REPO_PATH>/server
set UNREAL_PROJECT_ROOT=path/to/YourProject
node server.mjs
```

Ctrl+C to stop. Server talks MCP over stdio; use a client like Claude Code's `.mcp.json` or `npx @modelcontextprotocol/inspector` to interact.

---

## Architecture — 4 layers

```
Claude ↔ MCP server (stdio) ↔ four layers:
  Layer 1  Offline     — disk reads (Source/, Config/, .uproject bytes)
  Layer 2  TCP:55557   — existing UnrealMCP plugin (conformance oracle during Phase 2)
  Layer 3  TCP:55558   — custom UEMCP C++ plugin (this repo)
  Layer 4  HTTP:30010  — Remote Control API (Phase 4)
```

15 dynamic toolsets (~122 tools) loaded on-demand + 6 always-loaded management tools. `find_tools(query)` auto-enables the top 3 matching toolsets to stay under the tool-count accuracy threshold.

---

## Repo layout

```
UEMCP/
├── README.md                ← you are here
├── CLAUDE.md                ← project instructions for AI agents (read this if contributing)
├── tools.yaml               ← single source of truth for all ~122 tools
├── .mcp.json.example        ← template Claude Desktop / Code config
├── setup-uemcp.bat          ← new-machine onboarding (GUI or arg)
├── sync-plugin.bat          ← propagate plugin source changes to target projects
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
