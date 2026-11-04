# Separate projects and editor sessions

Run `setup-uemcp.bat "path\to\Project.uproject"` once for each project or working copy. Setup assigns a persistent TCP/HTTP port pair, registers the project, and preserves unrelated configuration. A copied project receives new ports when its copied pair overlaps another registered project. Allocation is serialized across setup processes sharing the registry.

Launch each editor normally. Start each Codex or Claude MCP server from its own project workspace, or use `attach_project` with the project's path or registered alias. Each server has its own attachment, connection configuration and caches. Project settings take priority over template/session port environment variables:

| File | Section and setting |
| --- | --- |
| `Config/DefaultUEMCP.ini` | `[UEMCP]` / `TcpPort` |
| `Config/DefaultRemoteControl.ini` | `[/Script/RemoteControlCommon.RemoteControlSettings]` / `RemoteControlHttpServerPort` |

An existing WindowsEditor saved Remote Control port override is read too; setup updates it to match. Restart the editor and MCP client after setup or changing ports. An occupied TCP port fails to bind; UEMCP does not reuse another editor's listener. Invalid or duplicate settings block live requests. Projects without these settings retain the legacy session/default ports, so configure each project before using concurrent editors. Independently managed registries must coordinate port assignments themselves; port ownership checks reject mismatches.

HTTP requests require the rebuilt UEMCP **1.0.23+** plugin. Before each attached-project HTTP request, including cached reads, the server compares read-only HTTP identity metadata against a fresh TCP identity: project file, process ID and TCP port must agree. Rebuild/deploy the plugin and restart both editor and MCP client when upgrading. This adds identity requests to HTTP traffic and shares the existing rate/recycle controls.

Separate projects or working copies isolate asset files. Two sessions attached to the same project directory still share its files and editor state. Port isolation does not provide file locking or merge concurrent edits to the same assets.

## Owned two-editor verification

From `server/`, set `UEMCP_ISOLATION_ROOT` to a fresh, nonexistent directory outside the checkout and `UEMCP_ISOLATION_ENGINE` to the installed engine root, then run `npm run test:project-isolation`.

The opt-in runner compiles and authors two canonical UEMCP host copies, configures them through the normal port allocator, and opens independent stdio MCP clients from those workspaces. Both editors run concurrently without port command-line overrides or client port environment variables. It enables toolsets, checks direct `tools/list`, writes distinct global scalar values, rejects deliberate HTTP and TCP crosswires, saves, restarts both editors, and checks persistence. Evidence and process receipts remain in the output root. It only closes processes it launched. No external projects are used.

This qualifies protocol clients and offscreen UE host instances. Actual Codex/Claude desktop tool discovery, rendered editor UI and shared-directory concurrent editing require separate acceptance checks.
