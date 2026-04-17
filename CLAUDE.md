# CLAUDE.md

This file provides guidance to Claude when working with code in this repository.

## Project Overview

**UEMCP** (Unreal Engine MCP) is a monorepo containing a Node.js MCP server and a C++ UE5 editor plugin that together give Claude full read/write access to Unreal Engine 5.6 projects. Built for two projects: **ProjectA** (combat game) and **ProjectB** (BreakoutWeek).

- **MCP Server**: `server/` — Node.js, ES modules (.mjs), MCP SDK 1.29.0, Zod 3
- **UE5 Plugin**: `plugin/` — C++ editor plugin (Phase 3, not yet implemented)
- **Tool Definitions**: `tools.yaml` — **single source of truth** for all 120 tools
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

120 tools across 15 toolsets + 6 always-loaded management tools. Toolsets are enabled/disabled dynamically to stay under the ~40 tool accuracy threshold.

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
| `perforce-bridge` | `~/.claude/mcp-servers/perforce-bridge/server.mjs` | P4 read operations |
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

## Current State — Phase 2 Complete + Level 1+2+2.5 + Option C + L3A S-A Shipped

### What's implemented:
- MCP server with stdio transport (`server/server.mjs`)
- 15 offline tools fully functional (`server/offline-tools.mjs`): `project_info`, `list_gameplay_tags`, `search_gameplay_tags`, `list_config_values`, `get_asset_info` (AR-metadata reader with verbose blob stripping, D31/D38), `query_asset_registry` (bulk scan with short class name matching, pagination via offset, truncation signalling, D33/D38), `inspect_blueprint` (BP export-table walk + CDO property defaults via `include_defaults`, D38/Option C), `list_level_actors` (placed actors with transforms + pagination + summary_by_class, D38/Option C), `read_asset_properties` (Option C, FPropertyTag iteration on any asset), `find_blueprint_nodes` (L3A S-A skeletal K2Node surface, D48), `list_data_sources`, `read_datatable_source`, `read_string_table_source`, `list_plugins`, `get_build_config`
- `.uasset`/`.umap` binary parser (`server/uasset-parser.mjs`): FPackageFileSummary → name table → FObjectImport (40-byte UE 5.0+ stride) → FObjectExport (112-byte stride) → FPackageIndex resolver → FAssetRegistryData tag block → **Level 1+2+2.5 property decode**: FPropertyTag iteration with UE 5.6 `FPropertyTypeName` + `EPropertyTagFlags` extensions; 12 engine struct handlers (FVector/FRotator/FTransform/FLinearColor/FColor/FGuid/FGameplayTag/FGameplayTagContainer/FSoftObjectPath/FBox/FVector4/FIntPoint/FBodyInstance/FExpressionInput); simple-element + complex-element `TArray`/`TSet` containers; `TMap<K,V>` (scalar keys, struct keys emit `struct_key_map` marker); **tagged-fallback for unknown structs** (D50: self-describing FPropertyTag streams decode 601 unique struct names including UUserDefinedStruct, FTimerHandle, FMaterialParameterInfo without loading referenced asset — supersedes D47 two-pass design). Pure JS, no UE dependency. Production-grade (zero errors on 19K+ files).
- ToolIndex with 6-tier scoring + coverage bonus (`server/tool-index.mjs`)
- ToolsetManager with SDK handle integration + `getToolsData()` getter (`server/toolset-manager.mjs`)
- ConnectionManager with 4-layer architecture + D24 UMG ad-hoc error detection (`server/connection-manager.mjs`)
- 3-channel instructions: SERVER_INSTRUCTIONS (init), TOOLSET_TIPS (per-activation), tool descriptions (tools.yaml)
- Phase 1 audit completed — see `docs/audits/phase1-audit-2026-04-12.md`
- Phase 2 tier-2 audit completed — see `docs/audits/phase2-tier2-parser-validation-2026-04-15.md`
- Test infrastructure: mock seam in ConnectionManager, FakeTcpResponder/ErrorTcpResponder, **612 total assertions passing** — 399 primary (120 phase1 + 45 mock-seam + 234 TCP) + 213 supplementary (152 parser + 15 asset-info + 16 registry + 30 inspect/level-actors). Pre-Agent-10 baseline was 436; Agent 10 added 125; Agent 10.5 added 51.
- Conformance oracle research complete — all 36 UnrealMCP C++ command contracts documented in `docs/specs/conformance-oracle-contracts.md`
- **Phase 2 actors toolset** (`server/tcp-tools.mjs`): 10 tools with name translation, Zod schemas, read/write caching
- **Phase 2 blueprints-write toolset** (`server/tcp-tools.mjs`): 15 tools (including 6 orphan BP node handlers)
- **Phase 2 widgets toolset** (`server/tcp-tools.mjs`): 7 tools with KNOWN ISSUE flags on 2 broken handlers
- **tools.yaml fully populated**: all 122 tools have params with types, required flags, descriptions; 11 `wire_type:` fields for name translation; `buildWireTypeMap()` parses YAML at startup
- **TOOLSET_TIPS populated**: core gotchas + cross-toolset workflows for all 3 TCP toolsets
- **Handler fixes landed (D38)**: F0 (verbose blob stripping), F1 (truncation signalling + pagination), F2 (tags removed from inspect_blueprint), F4 (placed actor filter), F6 (short class name matching)
- **D44 landed**: `server.mjs:offlineToolDefs` eliminated; `tools.yaml` is the single source of truth for all 15 offline tool descriptions and params (enforces CLAUDE.md Key Design Rule 1). `tools/list` + `find_tools` now report identical metadata. D44 invariant verified for `find_blueprint_nodes` at Agent 10.5 landing.
- **Agent 10 shipped (D39)**: Level 1+2+2.5 parser + Option C tools (`list_level_actors` transforms + pagination + summary_by_class; `inspect_blueprint` with `include_defaults`; new `read_asset_properties`). Agent 9.5's 4 implementation-critical corrections applied — transform chain via `outerIndex` reverse scan, UE 5.6 FPropertyTag extensions, sparse-transform tolerance, mandatory pagination.
- **Agent 10.5 shipped (D46/D47/D48/D50)**: complex-element containers (TMap + tagged TArray/TSet of custom structs); tagged-fallback for unknown structs (D47 pivot per D50 — 71% total marker reduction, 251K → 22K unknown_struct, 24K → 0 container_deferred); L3A S-A skeletal K2Node surface via `find_blueprint_nodes` (13 node types + 2 delegate-presence types, covers find/grep workflows offline without editor). Performance: 1.06× Agent 10 baseline bulk parse.

### Follow-on queue (post-Agent-10.5):
- **Polish worker** — 7 response-shape ergonomic items on the new offline surface
- **Parser extensions** — FExpressionInput native binary layout (~21K relabeled markers, deferred per D50); nested FieldPathProperty (pre-existing L1 edge case)
- **Cleanup worker** — int64 VFX parse bug + semgrep deep refactor
- **Manual testing** — Agent 10.5's offline surface (docs/testing/ scope)
- **3F sidecar writer** (editor plugin) — spec at `docs/specs/blueprints-as-picture-amendment.md`; now critical path since Agent 10.5's name-level floor is in place (D45)

### What's NOT implemented yet:
- 3F sidecar writer (editor plugin)
- C++ editor plugin (Phase 3 — deferred per D39; scope has shrunk progressively via D32/D35/D45/D48)
- HTTP client for Remote Control API (Phase 4)
- Distribution to ProjectB via P4 (Phase 5)
- Per-project tuning (Phase 6)

## File Layout

```
UEMCP/
├── CLAUDE.md              ← you are here
├── tools.yaml             ← SINGLE SOURCE OF TRUTH for all 122 tools
├── .mcp.json.example      ← template Claude Desktop config
├── server/
│   ├── package.json       ← deps: @modelcontextprotocol/sdk, js-yaml, zod
│   ├── server.mjs         ← MCP server entry, management tools, tool registration
│   ├── offline-tools.mjs  ← 15 offline tools incl. query_asset_registry, inspect_blueprint (+include_defaults), list_level_actors (+transforms), read_asset_properties, find_blueprint_nodes
│   ├── uasset-parser.mjs  ← binary .uasset/.umap parser: headers + FPropertyTag iteration + 12 engine struct handlers + TArray/TSet/TMap containers + tagged-fallback for unknown structs (Level 1+2+2.5, D50)
│   ├── tcp-tools.mjs      ← Phase 2 TCP tool handlers (actors: 10 tools, name translation, Zod schemas)
│   ├── tool-index.mjs     ← ToolIndex search with scoring + alias expansion
│   ├── toolset-manager.mjs ← enable/disable state, SDK handle integration
│   ├── connection-manager.mjs ← 4-layer connection management (has tcpCommandFn mock seam)
│   ├── test-phase1.mjs    ← Phase 1 + Agent 10/10.5 offline tool tests (120 assertions)
│   ├── test-mock-seam.mjs ← Mock seam + ConnectionManager tests (45 assertions)
│   ├── test-tcp-tools.mjs ← Phase 2 TCP tool tests (234 assertions)
│   ├── test-uasset-parser.mjs ← Parser format + Level 1+2+2.5 + tagged-fallback (152 assertions)
│   ├── test-offline-asset-info.mjs ← get_asset_info shape + cache (15 assertions)
│   ├── test-query-asset-registry.mjs ← bulk scan + pagination + tag filtering (16 assertions)
│   ├── test-inspect-and-level-actors.mjs ← inspect_blueprint + list_level_actors (30 assertions)
│   └── test-helpers.mjs   ← Shared test infra (FakeTcpResponder, ErrorTcpResponder, etc.)
├── plugin/                ← C++ UE5 plugin (Phase 3 — empty scaffold)
├── docs/
│   ├── README.md          ← directory map + reading orders
│   ├── specs/             ← architecture, protocols, design (8 files incl. conformance oracle)
│   ├── plans/             ← implementation phases, test strategy (2 files)
│   ├── audits/            ← point-in-time audit reports (never edit after creation)
│   ├── research/          ← parser survey, audit, design options (5 files)
│   ├── handoffs/          ← agent dispatch documents (self-contained task briefs)
│   └── tracking/          ← living docs: risks-and-decisions.md (D1-D50)
└── .claude/               ← project-level Claude settings
```

## Shell & Tooling Requirements

**Desktop Commander is MANDATORY for git and filesystem write operations.** The Cowork sandbox bash (`mcp__workspace__bash`) mounts the repo via a FUSE-like layer that cannot acquire `.git/index.lock` or `.git/HEAD.lock` files, causing git commits to fail or leave stale locks. All agents, workers, and conversations working in this repo MUST use Desktop Commander (`mcp__Desktop_Commander__start_process` with `shell: "cmd"`) for:

- Git operations (add, commit, status, diff, log, etc.)
- Any filesystem writes that need to persist reliably

Read operations (grep, glob, file reads) can use sandbox bash or Claude's built-in tools — those work fine through the mount.

**CMD, not PowerShell** — git and node are not in PATH on PowerShell. Always pass `shell: "cmd"` to Desktop Commander.

**Commit message workaround** — CMD mangles quoted strings. For multi-line commit messages, write to a temp file in the repo root and use `git commit -F file.txt && del file.txt`.

**Handoff documents must include this guidance** — any handoff that involves git operations should note the Desktop Commander requirement.

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

See `docs/tracking/risks-and-decisions.md` for full risk table and decision log (D1-D50).
See `docs/audits/phase1-audit-2026-04-12.md` for the Phase 1 audit.
See `docs/audits/phase2-tier2-parser-validation-2026-04-15.md` for the Phase 2 tier-2 audit (parser production-grade, 7 handler findings).

## Testing

Test cases defined in `docs/plans/testing-strategy.md` (Tests 1-43, organized by phase).
**Primary rotation**: 399 assertions (120 phase1 + 45 mock seam + 234 TCP tools).
**Supplementary rotation**: 213 assertions (152 parser + 15 asset-info + 16 asset-registry + 30 inspect/level-actors). Wired into rotation 2026-04-16 (M6 fix); grew substantially through Agent 10 + Agent 10.5.
**Total: 612 assertions across 7 test files.** Pre-Agent-10 baseline was 436 (+125 Agent 10, +51 Agent 10.5).

### Test Files — Primary Rotation

| File | Purpose | Run command |
|------|---------|-------------|
| `server/test-phase1.mjs` | Offline tools, ToolIndex search, toolset enable/disable, handler fixes, Option C + L3A S-A coverage (120 assertions) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA&& node test-phase1.mjs` |
| `server/test-mock-seam.mjs` | Mock seam wiring, cache, error normalization, queue serialization (45 assertions) | `cd /d D:\DevTools\UEMCP\server && node test-mock-seam.mjs` |
| `server/test-tcp-tools.mjs` | Phase 2 TCP tools: actors (10), blueprints-write (15), widgets (7) — name translation, param pass-through, caching, port routing, wire map building (234 assertions) | `cd /d D:\DevTools\UEMCP\server && node test-tcp-tools.mjs` |
| `server/test-helpers.mjs` | Shared infrastructure — not a runner. Exports: `FakeTcpResponder`, `ErrorTcpResponder`, `TestRunner`, `createTestConfig` |

### Test Files — Supplementary Rotation

These exercise real ProjectA fixtures (`.uasset`/`.umap` bytes on disk) and require `UNREAL_PROJECT_ROOT`. Wired into rotation 2026-04-16 after M6 fix propagated F1/F2 changes.

| File | Purpose | Run command |
|------|---------|-------------|
| `server/test-uasset-parser.mjs` | Parser format + Level 1+2+2.5 property decode + tagged-fallback (D50) + synthetic container coverage (152 assertions) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA&& node test-uasset-parser.mjs` |
| `server/test-offline-asset-info.mjs` | `get_asset_info` shape + cache + indexDirty invariants (15 assertions) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA&& node test-offline-asset-info.mjs` |
| `server/test-query-asset-registry.mjs` | `query_asset_registry` bulk scan, pagination, truncation, tag filtering (16 assertions) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA&& node test-query-asset-registry.mjs` |
| `server/test-inspect-and-level-actors.mjs` | `inspect_blueprint` + `list_level_actors` export-table walking (30 assertions, includes F2 tags-removed regression guard) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA&& node test-inspect-and-level-actors.mjs` |

**Note**: The `set` command must have NO space before `&&` or CMD adds a trailing space to the env var. The mock seam tests don't need `UNREAL_PROJECT_ROOT` (they use fake paths).

### Mock Seam Pattern

`ConnectionManager` accepts `config.tcpCommandFn` — a `(port, type, params, timeoutMs) => Promise<object>` that replaces real TCP. This enables unit-testing TCP tool handlers without a running editor. `FakeTcpResponder` provides canned responses; `ErrorTcpResponder` simulates failure modes (timeout, ECONNREFUSED, error_status, success:false, invalid_json).

### API Gotchas for Test Authors

- `toolIndex.getToolsetTools(name)` returns `{toolName, description, layer}[]` — NOT strings
- `ToolsetManager` constructor: `(connectionManager, toolIndex)` — order matters
- `enable()` returns `{enabled, alreadyEnabled, unavailable, unknown}`; `disable()` returns `{disabled, wasNotEnabled, unknown}`
- No `getState()` — use `getEnabledNames()`
- Offline tool params are snake_case: `file_path`, `file_filter`, `config_file` (full filename with `.ini`)

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

**Phase 2 (TCP client)**: `docs/specs/conformance-oracle-contracts.md` → `docs/specs/tcp-protocol.md` → `docs/plans/testing-strategy.md` (Tests 9-13 + Lessons Learned)
