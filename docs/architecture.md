# Architecture & Auto-Detection

> Source of truth for tool definitions: [tools.yaml](../tools.yaml)

## Problem Statement (unchanged from v1)

Two identical copies of a third-party Unreal MCP server exist across ProjectA and ProjectB. The current system:
1. Crashes if editor isn't running (no Cowork support)
2. Duplicated code with one-line difference (5s vs 30s timeout)
3. Limited to 35 TCP commands — no Remote Control API, no offline tools
4. No auto-detection of which project is open
5. No asset creation beyond Blueprints and UMG widgets
6. Fragile connection with no graceful degradation

### Constraints
- **Existing UnrealMCP C++ plugin**: Shared via Perforce with ProjectB team. **Do not modify.**
- **Existing Python MCP server**: May be tracked in Perforce for ProjectB. **Leave in place.** New server runs alongside.
- **One editor at a time**: Typical usage. Auto-detection handles rare simultaneous case.

---

## Architecture Overview

```
┌───────────────────────────────────────────────────────────────────────────┐
│                   Centralized MCP Server (Node.js)                        │
│                ~/.claude/mcp-servers/unreal/server.mjs                    │
│                                                                           │
│  ┌─────────────────────────────────────────────────────────────────────┐  │
│  │                     Dynamic Toolset Manager                         │  │
│  │  Always-loaded: connection_info, detect_project, find_tools,        │  │
│  │                 list_toolsets, enable_toolset, disable_toolset       │  │
│  │                                                                     │  │
│  │  15 toolsets (~114 tools) loaded on demand via find_tools or        │  │
│  │  enable_toolset. tools/list only returns active toolset tools.      │  │
│  │  ToolIndex: keyword search + alias expansion + stemming.            │  │
│  │  Auto-enable: find_tools enables matching toolsets automatically.   │  │
│  └────────────────────────────┬────────────────────────────────────────┘  │
│                               │                                           │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌────────────┐   │
│  │ TCP Layer    │  │ TCP Layer    │  │ HTTP Layer   │  │ Offline    │   │
│  │ (port 55557) │  │ (port 55558) │  │ (port 30010) │  │ Layer      │   │
│  │              │  │              │  │              │  │            │   │
│  │ EXISTING     │  │ NEW CUSTOM   │  │ Remote Ctrl  │  │ No editor  │   │
│  │ UnrealMCP    │  │ UEMCP plugin │  │ API proxy    │  │ needed     │   │
│  │              │  │              │  │              │  │            │   │
│  │ actors       │  │ gas          │  │ remote-      │  │ offline    │   │
│  │ blueprints-  │  │ materials    │  │ control      │  │            │   │
│  │   write      │  │ animation    │  │              │  │            │   │
│  │ widgets      │  │ data-assets  │  │              │  │            │   │
│  │              │  │ blueprint-   │  │              │  │            │   │
│  │              │  │   read       │  │              │  │            │   │
│  │              │  │ + 5 more     │  │              │  │            │   │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘  └─────┬──────┘   │
│         │                 │                  │                │          │
│  ┌──────┴─────────────────┴──────────────────┴────────────────┴──────┐   │
│  │                    Connection Manager                             │   │
│  │  - Auto-detect running project (PowerShell process inspection)    │   │
│  │  - Lazy connect (don't connect until first tool call)             │   │
│  │  - Graceful fallback (TCP55557 → TCP55558 → HTTP → offline)      │   │
│  │  - Health check caching with 30s TTL                              │   │
│  │  - Layer status feeds into list_toolsets availability              │   │
│  └───────────────────────────────────────────────────────────────────┘   │
└───────────────────────────────────────────────────────────────────────────┘
         │ stdio                              ▲
         ▼                                    │
┌─────────────────┐          ┌────────────────┴────────────────────────┐
│ Claude Code     │          │ Unreal Editor (when running)            │
│ or Cowork       │          │                                         │
│                 │          │ ┌─────────────┐  ┌────────────────────┐ │
│ .mcp.json or    │          │ │ UnrealMCP   │  │ UEMCP Plugin       │ │
│ desktop config  │          │ │ (existing)  │  │ (new, ours)        │ │
│                 │          │ │ TCP:55557   │  │ TCP:55558          │ │
│                 │          │ └─────────────┘  └────────────────────┘ │
│                 │          │ ┌─────────────┐  ┌────────────────────┐ │
│                 │          │ │ Remote Ctrl │  │ RC Components      │ │
│                 │          │ │ API :30010  │  │ (presets)          │ │
│                 │          │ └─────────────┘  └────────────────────┘ │
└─────────────────┘          └─────────────────────────────────────────┘
```

### Key Design Decisions

**D1: Node.js with `zod/v3`** — Matches jira-bridge, perforce, miro servers. Same SDK. Avoids Zod 4 crash.

**D2: Four connection layers with lazy initialization**
- **TCP:55557** (existing plugin): Blueprint graph, UMG, actors, viewports
- **TCP:55558** (new plugin): GAS assets, materials, animations, PIE, data assets
- **HTTP:30010** (Remote Control API): Reflection-based property/function access on any UObject
- **Offline**: Project file analysis — always works, no editor needed

**D3: Auto-detection via process inspection** — PowerShell `Get-CimInstance` extracts `.uproject` path from running `UnrealEditor.exe`. No manual port configuration needed. Falls back to TCP handshake → RC API query → offline-only mode.

**D4: Two C++ plugins coexist** — Existing UnrealMCP stays untouched (team-safe). New custom plugin adds capabilities on a separate port. Both can run simultaneously without conflict.

**D5: Dynamic toolsets with progressive disclosure** — 114 tools across 15 toolsets, loaded on demand. Only 6 discovery/management tools are always visible. Claude discovers tools via `find_tools` (keyword search with alias expansion and stemming) or `enable_toolset` (explicit). `tools/list` response only includes active toolset tools. This keeps active tool count at 15-30 per task (well within MCP safe limits of ~40). Pattern follows GitHub MCP Server's dynamic toolsets approach, adapted with hybrid search from Speakeasy's progressive disclosure model.

**D6: Leave old Python servers in place** — `unreal-mcp-main/` directories stay. They don't conflict with the new centralized server (different MCP server name in `.mcp.json`). Can be cleaned up later with team coordination.

---

## Auto-Detection System

### Detection Chain (ordered by reliability)

```
Layer 1: Process Inspection (PRIMARY — 95%+ reliability)
  │  PowerShell Get-CimInstance Win32_Process
  │  Extracts .uproject path from UnrealEditor.exe command line
  │  Falls back to WMIC on older Windows
  │
  ├─ Found ProjectA.uproject → route to ProjectA ports
  ├─ Found ProjectB.uproject → route to ProjectB ports  
  ├─ Found both → use UNREAL_PROJECT_ROOT env to disambiguate
  └─ Found none → offline mode only

Layer 2: TCP Handshake (SECONDARY — 90% reliability)
  │  Scan ports 55557-55566 for responsive MCP plugin
  │  Send lightweight command to identify project
  │
  └─ Verifies process inspection result; discovers actual port if shifted

Layer 3: RC API Query (TERTIARY — 85% reliability)
  │  GET http://127.0.0.1:30010/remote/info
  │  Returns world name, can infer project
  │
  └─ Additional verification if TCP layers unavailable

Layer 4: Offline Fallback
  │  No editor detected
  │  All offline tools work using UNREAL_PROJECT_ROOT
  │
  └─ Tools clearly report "Editor not connected" for online-only features
```

### Caching
- Detection results cached for **30 seconds**
- Cache invalidated on any connection failure
- Re-detection is automatic and transparent

### Multi-Instance Edge Case
When both editors are running (rare), the server uses `UNREAL_PROJECT_ROOT` from env to determine which project THIS server instance is responsible for. Process inspection finds both, filters to the matching one.

---

