# Repository Guidelines

## Project Structure & Module Organization

UEMCP is a Windows-focused monorepo for an Unreal Engine MCP bridge. The Node.js MCP server lives in `server/` and uses ES modules (`*.mjs`). The Unreal Engine editor plugin lives in `plugin/UEMCP/`, with public headers in `Source/UEMCP/Public/`, implementation files in `Source/UEMCP/Private/`, and C++ automation tests in `Source/UEMCP/Private/Tests/`. Project documentation is under `docs/`; start with `docs/README.md`, `docs/specs/architecture.md`, and `tools.yaml`, the source of truth for tool definitions.

## Build, Test, and Development Commands

Run server commands from `server/` unless noted.

```cmd
npm install
npm test
node run-rotation.mjs --json
node server.mjs
```

`npm install` installs server dependencies. `npm test` runs the default rotation via `run-rotation.mjs`. Use `--json` for machine-readable output. `node server.mjs` starts the MCP server over stdio; set `UNREAL_PROJECT_ROOT` first when testing against a project.

Root-level Windows helpers:

```cmd
setup-uemcp.bat "path\to\Project.uproject"
sync-plugin.bat "path\to\Project.uproject" -y
verify-deploy.bat
test-uemcp-gate.bat
```

Use `sync-plugin.bat` to copy `plugin/UEMCP/` into a target project. After plugin C++ changes, close the editor, sync, run Unreal `Build.bat`, relaunch the editor, and restart the MCP client.

## Coding Style & Naming Conventions

Keep JavaScript as ES modules and follow the existing `*.mjs` style: two-space indentation, semicolons, `const`/`let`, and focused helpers. Test files are named `server/test-*.mjs`; shared utilities stay in `test-helpers.mjs` or `test-fixtures.mjs`.

For Unreal C++, follow the existing UE style: tabs for indentation, PascalCase types/functions, UE-prefixed types where applicable, and headers in `Public/` only for cross-file interfaces. Prefer shared helpers such as `HandlerCommon` over duplicated anonymous-namespace utilities.

## Testing Guidelines

Before submitting server or tool-surface changes, run `npm test`. Use `node run-rotation.mjs --include-live-gated` only when Unreal Editor is running and reachable on the expected TCP port. For plugin deployment checks, run `verify-deploy.bat` before and after syncing. Use `test-uemcp-gate.bat` as a commandlet-gate smoke test.

## Commit & Pull Request Guidelines

Recent history uses short, scoped subjects with a decision or dispatch prefix, for example `D144 W-B Zod enum sharpening - 4 sites + invalid-enum tests`. Keep commits focused, mention the affected area, and include test or verification results in the body when useful.

Pull requests should describe the behavioral change, list commands run, call out plugin deployment requirements, and link relevant docs or decision-log entries. Include screenshots only for visual or editor-facing changes.

## Security & Configuration Tips

Do not commit machine-local configuration or sensitive paths. `.mcp.json`, `.uemcp-targets.txt`, logs, `node_modules/`, UE `Binaries/`, and `Intermediate/` are intentionally ignored. Use `.mcp.json.example` as the template for client configuration.
