# Implementation Plan

> Source of truth for tool definitions: [tools.yaml](../tools.yaml)
> Handler filenames derived by convention: `UEMCP${PascalCase(toolsetName)}Commands.h/.cpp`

## File Changes

### New Files

**MCP Server (Node.js)**:

| File | Description |
|------|-------------|
| `~/.claude/mcp-servers/unreal/server.mjs` | MCP server entry point: stdio transport, connection manager, tool routing, `tools/list` dynamic response |
| `~/.claude/mcp-servers/unreal/toolset-manager.mjs` | ToolsetManager: toolset registry, enable/disable state, `tools/list_changed` notifications |
| `~/.claude/mcp-servers/unreal/tool-index.mjs` | ToolIndex: weighted keyword search with tokenization, stemming, alias expansion |
| `~/.claude/mcp-servers/unreal/package.json` | Dependencies: @modelcontextprotocol/sdk |

**Unreal Plugin (C++)**:

| File | Description |
|------|-------------|
| `ProjectA/Plugins/UEMCP/UEMCP.uplugin` | New C++ plugin descriptor |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/UEMCP.Build.cs` | Build configuration |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Public/UEMCPModule.h` | Module header |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/UEMCPModule.cpp` | Module implementation |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Public/UEMCPSubsystem.h` | Editor subsystem header |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/UEMCPSubsystem.cpp` | Editor subsystem with TCP server on :55558, JSON command dispatch |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/Commands/UEMCPGASCommands.h/.cpp` | `gas` toolset: GE/GA creation, modification, live tag queries, AttributeSet generation (5 tools) |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/Commands/UEMCPMaterialCommands.h/.cpp` | `materials` toolset: material/MID creation, parameter access, material graph read (5 tools) |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/Commands/UEMCPAnimationCommands.h/.cpp` | `animation` toolset: montage creation/edit, deep montage read, anim sequences, blend spaces, curves, audio metadata (8 tools) |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/Commands/UEMCPDataAssetCommands.h/.cpp` | `data-assets` toolset: data asset CRUD, curve/string table/struct read (7 tools) |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/Commands/UEMCPPIECommands.h/.cpp` | `input-and-pie` toolset (PIE half): start/stop PIE, console commands, status check (4 tools) |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/Commands/UEMCPInputCommands.h/.cpp` | `input-and-pie` toolset (Input half): input action/mapping context creation, key binding (3 tools) |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/Commands/UEMCPBlueprintReadCommands.h/.cpp` | `blueprint-read` toolset: BP info, variables, functions, graphs, components, dispatchers, AnimBP, Widget BP, Niagara (10 tools) |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/Commands/UEMCPAssetRegistryCommands.h/.cpp` | `asset-registry` toolset: asset search, references, class hierarchy, DataTable read, metadata (5 tools) |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/Commands/UEMCPGeometryCommands.h/.cpp` | `geometry` toolset: procedural mesh, CSG booleans, UV generation, mesh info (4 tools) |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/Commands/UEMCPEditorUtilityCommands.h/.cpp` | `editor-utility` toolset: editor state, Python exec, EUB introspection/run, asset create/duplicate/rename/delete (8 tools) |
| `ProjectA/Plugins/UEMCP/Source/UEMCP/Private/Commands/UEMCPVisualCaptureCommands.h/.cpp` | `visual-capture` toolset: thumbnails, viewport screenshots, 3D preview renders, editor tab capture, visual summary (5 tools) |
| `ProjectB/Plugins/UEMCP/` | Copy of above (or symlink, depending on Perforce strategy) |

### Modified Files

| File | Change |
|------|--------|
| `ProjectA/.mcp.json` | Replace `unreal` server entry |
| `ProjectB/.mcp.json` | Replace `unreal` server entry |
| `claude_desktop_config.json` | Add `unreal-projecta` and `unreal-projectb` entries |
| `ProjectA/CLAUDE.md` | Update Unreal MCP documentation |
| `ProjectA/ProjectA.uproject` | Add UEMCP plugin reference + enable RC API, RC Components, Python Editor Script, Geometry Script, Sequencer Scripting |
| `ProjectB/ProjectB.uproject` | Same plugin additions |

### Files NOT Changed

| File | Reason |
|------|--------|
| `ProjectA/Plugins/UnrealMCP/*` | Team-shared, do not modify |
| `ProjectB/Plugins/UnrealMCP/*` | Team-shared, do not modify |
| `ProjectA/unreal-mcp-main/*` | Leave in place, new server is separate |
| `ProjectB/unreal-mcp-main/*` | Leave in place, may be tracked in P4 |
| `NodeToCode-main/*` | Separate plugin, potential future integration |

---


---

## Implementation Sequence

### Phase 1: Core Server + Dynamic Toolset Infrastructure (Node.js)
1. Create `~/.claude/mcp-servers/unreal/` directory
2. Write `package.json` (deps: `@modelcontextprotocol/sdk`, `zod`, `sharp`), run `npm install`
3. Implement `server.mjs` skeleton with ConnectionManager
4. Implement ToolIndex class (keyword search, alias map, stemmer, scoring)
5. Implement ToolsetManager (enable/disable, `tools/list_changed` notifications, active tool tracking)
6. Register 6 always-loaded tools: `connection_info`, `detect_project`, `find_tools`, `list_toolsets`, `enable_toolset`, `disable_toolset`
7. Implement auto-detection (process inspection via PowerShell)
8. Implement `offline` toolset — all 10 offline tools
9. **Test**: Run without editor — verify offline tools, `find_tools` search, `list_toolsets` output
10. **Test**: Run with editor — verify detection reports correct project and layer availability

### Phase 2: TCP Layer — Existing Plugin (port 55557)
11. Implement TCP send/receive (same JSON protocol as Python server)
12. Register 3 existing plugin toolsets with Zod schemas:
    - `actors` (10 tools)
    - `blueprints-write` (9 tools + BP node tools — see Section 8.2 note)
    - `widgets` (7 tools)
13. **Test**: Compare output against Python server — verify parity
14. **Test**: `find_tools("spawn actor viewport")` auto-enables `actors`, tools become callable

### Phase 3: TCP Layer — New Custom Plugin (port 55558)
15. Create UEMCP C++ plugin project structure (`.uplugin`, `Build.cs`, module files)
16. Implement UEMCPSubsystem with TCP server on 55558 + command dispatch
17. **Priority 1 — GAS + Blueprint Read** (highest value for ProjectA):
    - `gas` toolset: 5 commands (GE create/modify, GA create, runtime tags, AttributeSet)
    - `blueprint-read` toolset: 10 commands (info, variables, functions, graphs, components, dispatchers, AnimBP, Widget BP, Niagara)
18. **Priority 2 — Animation + Materials** (combat workflow):
    - `animation` toolset: 8 commands (montage CRUD, sequence info, blend space, curves, audio metadata)
    - `materials` toolset: 5 commands (create, instances, parameters, material graph)
19. **Priority 3 — Data + Asset Registry** (project-wide queries):
    - `data-assets` toolset: 7 commands (data asset CRUD, properties, curves, string tables, structs)
    - `asset-registry` toolset: 5 commands (search, references, hierarchy, DataTable, metadata)
20. **Priority 4 — Remaining toolsets**:
    - `input-and-pie` toolset: 7 commands (Enhanced Input + PIE control)
    - `geometry` toolset: 4 commands (procedural mesh, CSG, UVs, mesh info)
    - `editor-utility` toolset: 8 commands (editor state, Python, EUB, asset management)
    - `visual-capture` toolset: 5 commands (thumbnails, viewport, preview, panel capture, visual summary)
21. Register all 10 UEMCP toolsets (64 tools) in Node.js server with Zod schemas
22. **Test**: Each toolset individually with editor running
23. **Test**: `find_tools` correctly discovers and auto-enables UEMCP toolsets
24. **Test**: Image tools return valid base64 within stdio payload limits

### Phase 4: Remote Control API Layer (HTTP:30010)
25. Implement HTTP client for RC API
26. Register `remote-control` toolset (8 tools)
27. **Test**: Property get/set, function calls, object queries, batch ops

### Phase 5: Integration & Config
28. Update `ProjectA/.mcp.json` — swap unreal entry
29. Update `ProjectB/.mcp.json` — swap unreal entry
30. Update `claude_desktop_config.json` — add `unreal-projecta` and `unreal-projectb` entries
31. Enable plugins in both .uproject files (RC API, RC Components, Python Editor Script, Geometry Script, Sequencer Scripting)
32. Copy UEMCP plugin to ProjectB
33. **Test**: Claude Code — both projects, verify `list_toolsets` shows correct layer availability
34. **Test**: Cowork — with and without editor, verify offline fallback
35. **Test**: Auto-detection with each project, verify toolset enable/disable persists within session

### Phase 6: Documentation & Cleanup
36. Update `ProjectA/CLAUDE.md` with dynamic toolset documentation (toolset names, typical workflows)
37. Create `ProjectB/CLAUDE.md` if needed
38. Document plugin installation for ProjectB team (Confluence page)
39. Verify old Python servers can coexist (no port conflicts)
40. Optional: Remove old `unreal` entry from .mcp.json (keep Python servers on disk)
41. Add project-specific aliases to ToolIndex based on team feedback

---

