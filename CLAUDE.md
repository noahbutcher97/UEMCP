# CLAUDE.md

This file provides guidance to Claude when working with code in this repository.

## Project Overview

**UEMCP** (Unreal Engine MCP) is a monorepo containing a Node.js MCP server and a C++ UE5 editor plugin that together give Claude full read/write access to Unreal Engine 5.6 projects. Built for two projects: **ProjectA** (combat game) and **ProjectB** (BreakoutWeek).

- **MCP Server**: `server/` — Node.js, ES modules (.mjs), MCP SDK 1.29.0, Zod 3
- **UE5 Plugin**: `plugin/` — C++ editor plugin (Phase 3, not yet implemented)
- **Tool Definitions**: `tools.yaml` — **single source of truth** for all 114 tools
- **Repo Root**: `D:\DevTools\UEMCP\`
- **Version Control**: Git (NOT Perforce — unlike the UE projects themselves)

## Architecture — 4-Layer Connection Model

```
Claude ↔ MCP Server (stdio) ↔ 4 layers:
  Layer 1: Offline     — disk reads (Source/, Config/, .uproject)     ✅ Phase 1 DONE
  Layer 2: TCP:55557   — existing UnrealMCP plugin (actors, BP write) Phase 2
  Layer 3: TCP:55558   — custom UEMCP C++ plugin (GAS, introspection) Phase 3
  Layer 4: HTTP:30010  — Remote Control API (property get/set)        Phase 4
```

**D23 (key decision)**: UEMCP will absorb ALL tools onto TCP:55558 post-Phase 3. The existing UnrealMCP plugin (TCP:55557) is used as a **conformance oracle** during Phase 2 to validate TCP transport patterns, then deprecated. Layer assignments for `actors`, `blueprints-write`, `widgets` in tools.yaml are **transitional** — they'll flip from `tcp-55557` to `tcp-55558` when the custom plugin reimplements them.

## Dynamic Toolset System

114 tools across 15 toolsets + 6 always-loaded management tools. Toolsets are enabled/disabled dynamically to stay under the ~40 tool accuracy threshold.

- `find_tools(query)` — keyword search, auto-enables top 3 matching toolsets
- `enable_toolset` / `disable_toolset` — explicit control
- `list_toolsets` — orientation tool, warns when >40 active tools
- Tools use SDK `handle.enable()`/`.disable()` for `tools/list` visibility — disabled tools are completely invisible to Claude, not just guarded at runtime

### ToolIndex Search (tool-index.mjs)

6-tier weighted scoring: FULL_NAME(100) > NAME_EXACT(10) > NAME_PREFIX(6) > NAME_SUBSTR(4) > DESC_EXACT(2) > DESC_PREFIX(1). Coverage bonus: `score × (0.5 + 0.5 × matched_token_ratio)`. Aliases loaded from tools.yaml `aliases:` section + hardcoded supplements.

## TCP Wire Protocol (Conformance Oracle Reference)

The existing UnrealMCP plugin (TCP:55557) uses a connect-per-command pattern that our ConnectionManager mirrors:

- **Connect → Send → Read → Close** per command (no persistent connection)
- **Request format**: `{"type": "<command_name>", "params": {...}}` — note the field is `type`, NOT `command`
- **No newline terminator** on request (matches the Python server's behavior)
- **Response**: JSON object, parsed by accumulating chunks until valid JSON. No length framing.
- **Error responses**: Two formats exist — `{"status": "error", "error": "msg"}` and `{"success": false, "message": "msg"}`. ConnectionManager normalizes both.
- **Serialized per-layer**: CommandQueue ensures one in-flight command per TCP layer; different layers execute in parallel.
- **Health check**: Sends `ping` command with 3s timeout. Results cached for 30s.
- **Read-op caching**: ResultCache (SHA-256 keyed, 5min TTL) for repeat queries. Write-ops should set `skipCache: true`.

The UEMCP custom plugin (TCP:55558, Phase 3) will use the same wire protocol initially but may evolve it (e.g., adding length framing) once we control both ends.

## Sibling MCP Servers

UEMCP follows conventions established by existing MCP servers at `~/.claude/mcp-servers/`:

| Server | Path | Purpose |
|--------|------|---------|
| `jira-bridge` | `~/.claude/mcp-servers/jira-bridge/server.mjs` | Jira + Confluence (Atlassian) |
| `perforce` | `~/.claude/mcp-servers/perforce/server.mjs` | P4 read operations |
| `miro-bridge` | `~/.claude/mcp-servers/miro-bridge/server.mjs` | Miro board access |

All are single `server.mjs` files, Node.js ES modules, stdio transport — same pattern UEMCP follows (D1, D17). In Cowork mode, these run with project-specific prefixes (e.g., `jira-projecta`, `jira-projectb`, `perforce-projecta`, `miro-projecta`).

## Existing UnrealMCP C++ Plugin Structure

The conformance oracle at `ProjectA\Plugins\UnrealMCP\` has this structure (relevant for Phase 2/3):

- `MCPServerRunnable` — `FRunnable`-based TCP listener on port 55557
- Command files (the pattern we'll replicate/improve on 55558):
  - `UnrealMCPBlueprintCommands.cpp` — BP creation, nodes, variables, compile
  - `UnrealMCPEditorCommands.cpp` — Editor operations, asset management
  - `UnrealMCPActorCommands.cpp` — Actor spawn, transform, properties
  - `UnrealMCPUMGCommands.cpp` — UMG widget creation and manipulation
- Each command file registers handlers keyed by the `type` field from incoming JSON
- **Known issues** to fix in our reimplementation: no error normalization, limited introspection, no batch support

Also note: `unreal-mcp-main` (Python MCP server) exists at `ProjectA\unreal-mcp-main\` — this is a third-party reference implementation, NOT used in production. The `NodeToCode-main` plugin at `ProjectA\Plugins\NodeToCode-main\` is a separate BP-to-code tool, also not part of UEMCP.

## Current State — Phase 1 Complete

### What's implemented:
- MCP server with stdio transport (`server/server.mjs`)
- 10 offline tools fully functional (`server/offline-tools.mjs`): `project_info`, `list_gameplay_tags`, `search_gameplay_tags`, `list_config_values`, `browse_content`, `get_asset_info`, `search_source`, `read_source_file`, `list_plugins`, `get_build_config`
- ToolIndex with 6-tier scoring + coverage bonus (`server/tool-index.mjs`)
- ToolsetManager with SDK handle integration (`server/toolset-manager.mjs`)
- ConnectionManager with 4-layer architecture (`server/connection-manager.mjs`)
- 3-channel instructions: SERVER_INSTRUCTIONS (init), TOOLSET_TIPS (per-activation), tool descriptions (tools.yaml)
- Phase 1 audit completed — see `docs/audits/phase1-audit-2026-04-12.md`

### What's NOT implemented yet:
- TCP client for editor communication (Phase 2)
- C++ editor plugin (Phase 3)
- HTTP client for Remote Control API (Phase 4)
- Distribution to ProjectB via P4 (Phase 5)
- Per-project tuning (Phase 6)

## File Layout

```
UEMCP/
├── CLAUDE.md              ← you are here
├── tools.yaml             ← SINGLE SOURCE OF TRUTH for all 114 tools
├── .mcp.json.example      ← template Claude Desktop config
├── server/
│   ├── package.json       ← deps: @modelcontextprotocol/sdk, js-yaml, zod
│   ├── server.mjs         ← MCP server entry, management tools, tool registration
│   ├── offline-tools.mjs  ← 10 offline tools (project_info, search_source, etc.)
│   ├── tool-index.mjs     ← ToolIndex search with scoring + alias expansion
│   ├── toolset-manager.mjs ← enable/disable state, SDK handle integration
│   └── connection-manager.mjs ← 4-layer connection management
├── plugin/                ← C++ UE5 plugin (Phase 3 — empty scaffold)
├── docs/
│   ├── README.md          ← directory map + reading orders
│   ├── specs/             ← architecture, protocols, design (7 files)
│   ├── plans/             ← implementation phases, test strategy (2 files)
│   ├── audits/            ← point-in-time audit reports (never edit after creation)
│   └── tracking/          ← living docs: risks-and-decisions.md (D1-D23)
└── .claude/               ← project-level Claude settings
```

## Code Standards

- **ES Modules** (.mjs) — `import/export`, no CommonJS
- **No TypeScript** — plain JS with JSDoc comments (decision D17: iteration speed with AI-assisted dev)
- **Zod for validation** — tool params validated via Zod schemas built from tools.yaml definitions
- Functions under 50 lines where possible
- Early returns for validation
- Comment **intent**, not implementation
- **NEVER add AI attribution** — no `Co-Authored-By: Claude`, no "generated with AI" in commits

## Key Design Rules

1. **tools.yaml is the single source of truth** — tool names, descriptions, toolset membership, aliases, params all defined there. Code loads from YAML at startup. Never hardcode tool definitions in server.mjs.

2. **SDK handles control visibility** — `server.tool()` returns a handle with `.enable()/.disable()`. ToolsetManager stores handles and toggles them when toolsets change. Disabled tools don't appear in `tools/list` at all (SDK filters at line 68-69 of mcp.js). Never use runtime guards to check toolset state in tool handlers.

3. **Offline tips go in SERVER_INSTRUCTIONS** — the offline toolset is always-on, so TOOLSET_TIPS never fires for it. Offline constraints (50 match cap, file type restrictions, progressive config drill-down) live in the init instructions string.

4. **TOOLSET_TIPS for dynamic toolsets only** — `{core, workflows[]}` structure. `workflows[]` entries have `requires[]` arrays for cross-toolset tips that only fire when all required toolsets are active.

5. **Aliases merge at build time** — tools.yaml `aliases:` section is canonical. tool-index.mjs has supplementary defaults. `build()` merges YAML over defaults (YAML wins on conflict).

6. **Auto-enable capped at 3** — `find_tools` enables top 3 toolsets by highest-scoring tool per query. Prevents accidentally loading too many toolsets.

## Common Tasks

### Running the server locally
```bash
cd D:\DevTools\UEMCP\server
UNREAL_PROJECT_ROOT="D:/UnrealProjects/5.6/ProjectA/ProjectA" node server.mjs
```

### Adding a tool to an existing toolset
1. Add the tool entry in `tools.yaml` under the appropriate toolset
2. If offline: implement handler in `offline-tools.mjs`, add case to `executeOfflineTool` switch
3. If TCP/HTTP: implement in the appropriate handler file (Phase 2+)
4. Register in `server.mjs` with `server.tool()`, capture handle, call `handle.disable()`, register with ToolsetManager

### Adding a new toolset
1. Define in `tools.yaml` with `layer:` and `tools:` block
2. ToolIndex picks it up automatically at `build()` time
3. Add TOOLSET_TIPS entry if cross-toolset workflows exist
4. Register all tools in server.mjs following the offline pattern (capture handles, start disabled)

### Adding an alias
Add to `tools.yaml` `aliases:` section. Merged into ToolIndex at build time.

## Known Issues & Deferred Work

- **M4**: `searchGameplayTags` rebuilds full hierarchy just to get flat tag list (perf only)
- **L1**: No TCP reconnection retry (Phase 2 scope)
- **L2**: No graceful fallback across layers (Phase 4 scope)
- **L3**: Write-op deduplication not implemented (Phase 2 scope)
- **L4**: MCP Resources deferred (D21)

See `docs/tracking/risks-and-decisions.md` for full risk table and decision log (D1-D23).
See `docs/audits/phase1-audit-2026-04-12.md` for the complete Phase 1 audit.

## Testing

Test cases defined in `docs/plans/testing-strategy.md` (Tests 1-43, organized by phase).
Phase 1 tests (2-8) have not yet been formally executed — next priority after current fixes.

## MCP Configuration Files

UEMCP is referenced from `.mcp.json` files in each UE project root. These need updating when UEMCP server args or env vars change:

- **ProjectA**: `D:\UnrealProjects\5.6\ProjectA\.mcp.json` — `UNREAL_PROJECT_ROOT` → `D:/UnrealProjects/5.6/ProjectA/ProjectA`
- **ProjectB**: `D:\UnrealProjects\5.6\BreakoutWeek\.mcp.json` — `UNREAL_PROJECT_ROOT` → `D:/UnrealProjects/5.6/BreakoutWeek/ProjectB`
- **Template**: `D:\DevTools\UEMCP\.mcp.json.example` — copy and customize per project

In Cowork mode (Claude Desktop), the config lives in `claude_desktop_config.json` and servers get project-specific names (e.g., the Jira bridge runs as `jira-projecta` for ProjectA and `jira-projectb` for ProjectB).

## Related Projects

- **ProjectA**: `D:\UnrealProjects\5.6\ProjectA\ProjectA\` — primary target project (Perforce: `//DepotA/ProjectA`)
- **ProjectB**: `D:\UnrealProjects\5.6\BreakoutWeek\ProjectB\` — secondary target (Perforce: separate depot)
- **Existing UnrealMCP**: Plugin at `ProjectA\Plugins\UnrealMCP\` (TCP:55557) — conformance oracle for Phase 2, deprecated post-Phase 3
- **unreal-mcp-main**: Python MCP server at `ProjectA\unreal-mcp-main\` — third-party reference, not used in production
- **NodeToCode-main**: BP-to-code plugin at `ProjectA\Plugins\NodeToCode-main\` — separate tool, not part of UEMCP

## Documentation Reading Order

**First read**: `docs/specs/architecture.md` → `docs/specs/plugin-design.md` → `docs/specs/dynamic-toolsets.md` → `tools.yaml` → `docs/plans/implementation.md`

**Quick reference**: `tools.yaml` → `docs/specs/dynamic-toolsets.md` → `docs/tracking/risks-and-decisions.md`
