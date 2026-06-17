# Configuration & Project Attachment

> Source of truth for tool definitions: [tools.yaml](../../tools.yaml)

## Normal MCP Configuration

`.mcp.json.example` is project-neutral by default:

```json
{
  "mcpServers": {
    "uemcp": {
      "command": "node",
      "args": ["D:/DevTools/UEMCP/server/server.mjs"],
      "env": {
        "UNREAL_TCP_PORT_CUSTOM": "55558",
        "UNREAL_TCP_TIMEOUT_MS": "5000",
        "UNREAL_RC_PORT": "30010",
        "UNREAL_AUTO_DETECT": "true"
      }
    }
  }
}
```

At session start, UEMCP uses MCP workspace roots:

- If a workspace root directly contains one `.uproject`, attach it.
- If a workspace root has exactly one immediate child project with one `.uproject`, attach it.
- If the workspace is ambiguous or has no project, remain unresolved and expose management tools only.
- Use `attach_project` to attach manually for the current session.

Repeated deploy/smoke workflows should use repo-local `.uemcp-targets.json` profiles. Copy `.uemcp-targets.json.example` to `.uemcp-targets.json` and replace placeholder paths with local `.uproject` paths:

```json
{
  "version": 1,
  "profiles": {
    "default": ["primary"],
    "smoke": ["primary"],
    "release-gate": ["primary", "secondary"]
  },
  "targets": {
    "primary": { "uproject": "D:/UnrealProjects/PrimaryProject/PrimaryProject.uproject" },
    "secondary": { "uproject": "D:/UnrealProjects/SecondaryProject/SecondaryProject.uproject" }
  }
}
```

`verify-deploy --profile smoke` verifies only the named profile. `--profile all` is built in and selects every target in the JSON file. `list_project_targets({ profile: "smoke" })`, `list_project_targets({ profile: "all" })`, and `attach_project({ target: "primary", target_profile: "smoke" })` use the same profile resolver for MCP sessions. When a session attaches by target alias, `connection_info` includes `targetAttachment` with the requested alias, selected profile, target source type, and target config path.

Legacy `.uemcp-targets.txt` remains supported when no JSON file exists, but it is reported as compatibility-only because commented lines are not a production state model. To migrate, run `setup-uemcp.bat "<path-to-project.uproject>"` or copy `.uemcp-targets.json.example` to `.uemcp-targets.json` and fill local `.uproject` paths.

## Compatibility Env Mode

Legacy env attachment is opt-in:

```json
{
  "env": {
    "UEMCP_PROJECT_ATTACH_MODE": "env",
    "UNREAL_PROJECT_ROOT": "path/to/YourProject",
    "UNREAL_PROJECT_NAME": "YourProject"
  }
}
```

Use env mode for CLI compatibility tests, scripted one-off sessions, or old clients that cannot provide workspace roots or call `attach_project`. Without `UEMCP_PROJECT_ATTACH_MODE=env`, `UNREAL_PROJECT_ROOT` is treated as metadata and does not silently attach the session.

## Readiness Dimensions

`connection_info` reports these dimensions separately:

| Dimension | Meaning |
|-----------|---------|
| attachment | Whether a session project is attached |
| offline | Whether project files are readable |
| deployFreshness | Whether the UEMCP plugin copy is fresh for the attached project |
| editorIdentity | Whether the running editor matches the attached `.uproject` |
| tcp-55558 | Whether the UEMCP plugin TCP transport is reachable |
| http-30010 | Whether Remote Control API is reachable |
| transportOwnership | Whether plugin handshake identity proves the transport belongs to the attached project |

A target can be deploy `SYNC` and still be blocked for live mutation if attachment, editor identity, or transport ownership is not verified. A known-stale deploy freshness check blocks live mutators with `DEPLOY_STALE`.

If the project was attached through a configured target alias, `connection_info.targetAttachment` reports the alias/profile/config source used for the current session. Direct workspace or explicit path attachments leave this field `null`.

## Live Smoke Configuration

Live smoke remains opt-in:

```cmd
set UEMCP_LIVE_SMOKE=1
smoke-live.bat --project "path\to\YourProject.uproject"
```

No opt-in means a clean skip. Opt-in without an explicit project source returns `BLOCKED_CONFIG`. Accepted project sources are `--project`, `--target`, `--targets-first` from local target profiles, or explicit env compatibility mode.

## Environment Variables Reference

| Variable | Default | Scope |
|----------|---------|-------|
| `UEMCP_PROJECT_ATTACH_MODE` | `workspace` | `workspace` or explicit `env` compatibility mode |
| `UNREAL_PROJECT_ROOT` | unset | Compatibility/CLI project root; authoritative only in env mode |
| `UNREAL_PROJECT_NAME` | unset | Compatibility display name and log naming |
| `UEMCP_LIVE_SMOKE` | unset | Must be `1` to allow live smoke mutations |
| `UEMCP_LIVE_PROJECT_ROOT` | unset | Internal/runner explicit live-smoke project root |
| `UNREAL_TCP_PORT_CUSTOM` | `55558` | UEMCP plugin TCP port |
| `UNREAL_TCP_TIMEOUT_MS` | `10000` | TCP socket timeout per command unless a tool-specific override applies |
| `UNREAL_RC_PORT` | `30010` | Remote Control API HTTP port |
| `UEMCP_ENABLE_PYTHON_EXEC` | unset | Enables `run_python_command` only when set to `1` |
