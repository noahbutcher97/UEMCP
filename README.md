# UEMCP — Unreal Engine MCP Hybrid Server

A monorepo containing a **Node.js MCP server** and a **C++ Unreal Engine plugin** that together give Claude full read/write access to UE5 projects.

## Repository Structure

```
UEMCP/
├── tools.yaml          ← Single source of truth for all 114 tools
├── server/             ← Node.js MCP server (TypeScript)
│   ├── src/
│   ├── package.json
│   └── tsconfig.json
├── plugin/             ← C++ UE5 editor plugin (TCP:55558)
│   ├── UEMCP.uplugin
│   └── Source/UEMCP/
│       ├── Public/Commands/
│       └── Private/Commands/
└── docs/               ← Architecture docs and plan
    └── README.md       ← Table of contents
```

## Quick Start

1. **Plugin**: Copy `plugin/` into your UE project's `Plugins/` directory, rebuild
2. **Server**: `cd server && npm install && npm run build`
3. **Config**: Add server to your `.mcp.json` (see `docs/configuration.md`)

## Architecture

4-layer hybrid: Offline file analysis + existing TCP plugin (55557) + new C++ plugin (55558) + HTTP Remote Control (30010). The server auto-detects which UE project is running and routes tool calls to the appropriate layer.

15 dynamic toolsets (108 tools) loaded on demand + 6 always-loaded management tools = **114 total tools**.

See [docs/](docs/README.md) for the full plan.

## Target Projects

- **ProjectA** — Multiplayer PvP combat game (primary)
- **ProjectB** — BreakoutWeek project (full parity)
