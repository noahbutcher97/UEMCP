# Architecture & Auto-Detection

> Source of truth for tool definitions: [tools.yaml](../../tools.yaml)

## Problem Statement (unchanged from v1)

Two identical copies of a third-party Unreal MCP server exist across the two target projects (Project A and Project B). The current system:
1. Crashes if editor isn't running (no Cowork support)
2. Duplicated code with one-line difference (5s vs 30s timeout)
3. Limited to 35 TCP commands — no Remote Control API, no offline tools
4. No auto-detection of which project is open
5. No asset creation beyond Blueprints and UMG widgets
6. Fragile connection with no graceful degradation

### Constraints
- **Existing UnrealMCP C++ plugin**: Shared via Perforce with the Project B team. **Do not modify.**
- **Existing Python MCP server**: May be tracked in Perforce for Project B. **Leave in place.** New server runs alongside.
- **One editor at a time**: Typical usage. Auto-detection handles rare simultaneous case.

---

## Architecture Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│                   Centralized MCP Server (Node.js)                        │
│              UEMCP/server/server.mjs  (D:/DevTools/UEMCP/server/)         │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                     Dynamic Toolset Manager                         │  │
│  │  Always-loaded: connection_info, detect_project, find_tools,        │  │
│  │                 list_toolsets, enable_toolset, disable_toolset,      │  │
│  │                 list_project_targets, attach_project,                │  │
│  │                 detach_project, refresh_project_context              │  │
│  │                                                                     │  │
│  │  16 toolsets (138 toolset tools) loaded on demand via find_tools    │  │
│  │  or enable_toolset. tools/list only returns active toolset tools.   │  │
│  │  ToolIndex: keyword search + alias expansion + stemming.            │  │
│  │  Auto-enable: find_tools enables matching toolsets automatically.   │  │
│  └────────────────────────────┬────────────────────────────────────────┘  │
│                               │                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐   │
│  │ TCP Layer    │  │ HTTP Layer   │  │ Offline    │  │ Historical  │   │
│  │ (port 55558) │  │ (port 30010) │  │ Layer      │  │ References  │   │
│  │              │  │              │  │            │  │             │   │
│  │ UEMCP plugin │  │ Remote Ctrl  │  │ No editor  │  │ TCP:55557   │   │
│  │              │  │ API proxy    │  │ needed     │  │ oracle docs │   │
│  │ actors       │  │ remote-      │  │ offline    │  │ only        │   │
│  │ blueprints-  │  │ control      │  │            │  │             │   │
│  │   write      │  │              │  │            │  │             │   │
│  │ widgets      │  │              │  │            │  │             │   │
│  │ gas/material │  │              │  │            │  │             │   │
│  │ + 10 more    │  │              │  │            │  │             │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘   │
│         │                 │                  │                │          │
│  ┌──────┴─────────────────┴──────────────────┴────────────────┴──────┐   │
│  │                    ProjectContext + Connection Manager            │   │
│  │  - ProjectContext owns session-local .uproject attachment         │   │
│  │  - ConnectionManager owns transport/cache health for attachment   │   │
│  │  - Lazy connect (don't connect until first tool call)             │   │
│  │  - Graceful fallback (TCP55558 → HTTP → offline)                 │   │
│  │  - Health check caching with 30s TTL                              │   │
│  │  - Layer status feeds into list_toolsets availability              │   │
│  └───────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────┘
         │ stdio                              ▲
         ▼                                    │
┌─────────────────┐          ┌────────────────┴────────────────────────┐
│ Claude Code     │          │ Unreal Editor (when running)            │
│ or Cowork       │          │                                         │
│                 │          │ ┌────────────────────┐                  │
│ .mcp.json or    │          │ │ UEMCP Plugin       │                  │
│ desktop config  │          │ │ TCP:55558          │                  │
│                 │          │ └────────────────────┘                  │
│                 │          │ ┌─────────────┐  ┌────────────────────┐ │
│                 │          │ │ Remote Ctrl │  │ RC Components      │ │
│                 │          │ │ API :30010  │  │ (presets)          │ │
│                 │          │ └─────────────┘  └────────────────────┘ │
└─────────────────┘          └─────────────────────────────────────────┘
```

### Key Design Decisions

**D1: Node.js with `zod/v3`** — Matches jira-bridge, perforce, miro servers. Same SDK. Avoids Zod 4 crash.

**D2: Connection layers with lazy initialization**
- **TCP:55558** (UEMCP plugin): editor-backed live reads/writes, Blueprint/widget/actor tools, GAS assets, materials, animations, PIE, data assets
- **HTTP:30010** (Remote Control API): Reflection-based property/function access on any UObject
- **Offline**: Project file analysis — always works, no editor needed
- **TCP:55557**: historical Phase 2 conformance-oracle references only; not an active layer in `tools.yaml`

**D3: Session-local project attachment** — ProjectContext attaches from MCP workspace roots only when the workspace topology is unambiguous. Ambiguous workspaces start management-only and require `attach_project`. Process inspection and plugin handshake are readiness checks, not attachment authority.

**D4: Two C++ plugins coexist** — Existing UnrealMCP stays untouched (team-safe). New custom plugin adds capabilities on a separate port. Both can run simultaneously without conflict.

**D5: Dynamic toolsets with progressive disclosure** — `tools.yaml` declares 10 discovery/management tools plus dynamic project-scoped toolsets. Claude discovers tools via `find_tools` or `enable_toolset`; both block project-scoped toolsets until ProjectContext has an attached project. `tools/list` response only includes management tools plus active toolset tools.

**D6: Leave old Python servers in place** — `unreal-mcp-main/` directories stay. They don't conflict with the new centralized server (different MCP server name in `.mcp.json`). Can be cleaned up later with team coordination.

---

## Project Attachment And Readiness

### Attachment Chain

```
MCP workspace roots
  ├─ exactly one direct .uproject → auto-attach
  ├─ exactly one immediate child project → auto-attach
  ├─ ambiguous/no project → unresolved management-only startup
  └─ user calls attach_project → session-local manual attachment
```

### Readiness Chain

After attachment, `connection_info(force_reconnect=true)` separates:

1. project attachment and offline file availability;
2. plugin deploy freshness;
3. editor process identity from full `.uproject` command-line paths;
4. TCP:55558 and HTTP:30010 reachability;
5. plugin `get_editor_state` identity proving transport ownership.

Live mutators require the attached project, non-stale deploy freshness, verified editor identity, and verified transport ownership. Raw port reachability alone is never enough; when deploy freshness is known stale, guarded live mutators return `DEPLOY_STALE`.

---
