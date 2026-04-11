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
9. **[AUDIT]** TCP command queue: outbound commands serialized (one in-flight at a time per TCP layer). Request ID generated from SHA256(command+params) for write-op deduplication. Result cache with 5-min TTL on both server and plugin side. (~2 hrs)
10. **[AUDIT]** `list_toolsets` reports unavailable toolsets with reason + fix instruction (e.g., "Geometry Script plugin not enabled — enable in Edit > Plugins"). Query plugin status via TCP handshake on first connect. (~1 hr)
11. **Test**: Run without editor — verify offline tools, `find_tools` search, `list_toolsets` output
12. **Test**: Run with editor — verify detection reports correct project and layer availability

### Phase 2: TCP Layer — Existing Plugin (port 55557)
13. Implement TCP send/receive (same JSON protocol as Python server)
14. **[AUDIT]** Basic reconnect-on-failure: if TCP send fails, mark layer disconnected, retry connect on next tool call. No backoff needed for localhost. (~1.5 hrs)
15. Register 3 existing plugin toolsets with Zod schemas:
    - `actors` (10 tools)
    - `blueprints-write` (9 tools + BP node tools — see Section 8.2 note)
    - `widgets` (7 tools)
16. **Test**: Compare output against Python server — verify parity
17. **Test**: `find_tools("spawn actor viewport")` auto-enables `actors`, tools become callable

### Phase 3: TCP Layer — New Custom Plugin (port 55558)
18. Create UEMCP C++ plugin project structure (`.uplugin`, `Build.cs`, module files)
19. Implement UEMCPSubsystem with TCP server on 55558 + command dispatch (game-thread dequeue, one command per tick)
20. **Priority 1 — GAS + Blueprint Read** (highest value for ProjectA):
    - `gas` toolset: 5 commands (GE create/modify, GA create, runtime tags, AttributeSet)
    - `blueprint-read` toolset: 10 commands (info, variables, functions, graphs, components, dispatchers, AnimBP, Widget BP, Niagara)
21. **Priority 2 — Animation + Materials** (combat workflow):
    - `animation` toolset: 8 commands (montage CRUD, sequence info, blend space, curves, audio metadata)
    - `materials` toolset: 5 commands (create, instances, parameters, material graph)
22. **Priority 3 — Data + Asset Registry** (project-wide queries):
    - `data-assets` toolset: 7 commands (data asset CRUD, properties, curves, string tables, structs)
    - `asset-registry` toolset: 5 commands (search, references, hierarchy, DataTable, metadata)
23. **Priority 4 — Remaining toolsets**:
    - `input-and-pie` toolset: 7 commands (Enhanced Input + PIE control)
    - `geometry` toolset: 4 commands (procedural mesh, CSG, UVs, mesh info)
    - `editor-utility` toolset: 8 commands (editor state, Python, EUB, asset management)
    - `visual-capture` toolset: 5 commands (thumbnails, viewport, preview, panel capture, visual summary)
24. **[AUDIT]** `run_python_command` safety: deny-list (`os.`, `subprocess`, `eval`, `exec`, `open`, `__import__`), confirmation dialog via `FMessageDialog::Open`, all executions logged to `Saved/Logs/PythonExecutionLog.txt`. See D14. (~1.5 hrs)
25. **[AUDIT]** `delete_asset` safety: query `IAssetRegistry::GetReferencers()` before delete. If hard refs exist and `force` param is false (default), refuse with referrer list. `rename_asset` uses UE native redirect + warns on unfixable soft refs. (~3 hrs)
26. Register all 10 UEMCP toolsets (64 tools) in Node.js server with Zod schemas
27. **Test**: Each toolset individually with editor running
28. **Test**: `find_tools` correctly discovers and auto-enables UEMCP toolsets
29. **Test**: Image tools return valid base64 (1024×1024 JPEG default) within stdio payload limits

### Phase 4: Remote Control API Layer (HTTP:30010)
30. Implement HTTP client for RC API (use `UNREAL_RC_PORT` env var, default 30010)
31. Register `remote-control` toolset (8 tools)
32. Wrap RC API error responses in clean structured messages (type mismatch, object not found, property not found)
33. **Test**: Property get/set, function calls, object queries, batch ops

### Phase 5: Integration & Config
34. Update `ProjectA/.mcp.json` — swap unreal entry
35. Update `ProjectB/.mcp.json` — swap unreal entry
36. Update `claude_desktop_config.json` — add `unreal-projecta` and `unreal-projectb` entries
37. Enable plugins in both .uproject files (RC API, RC Components, Python Editor Script, Geometry Script, Sequencer Scripting)
38. **[AUDIT]** Run `sync-uemcp-plugins.ps1` to copy plugin to ProjectB. Submit to P4. See D15.
39. **Test**: Claude Code — both projects, verify `list_toolsets` shows correct layer availability
40. **Test**: Cowork — with and without editor, verify offline fallback
41. **Test**: Auto-detection with each project, verify toolset enable/disable persists within session

### Phase 6: Documentation & Cleanup
42. Update `ProjectA/CLAUDE.md` with dynamic toolset documentation (toolset names, typical workflows)
43. Create `ProjectB/CLAUDE.md` if needed
44. Publish Confluence page for ProjectB team (plugin overview, zero-action install, FAQ, troubleshooting)
45. Verify old Python servers can coexist (no port conflicts)
46. Optional: Remove old `unreal` entry from .mcp.json (keep Python servers on disk)
47. Add project-specific aliases to ToolIndex based on team feedback

---

## Effort Budget (AI-Assisted)

Estimates assume AI code generation for all implementation. Steps marked **[AUDIT]** were added during the April 2026 plan audit and are not in the original plan.

| Phase | Original Steps | Audit Steps | Audit Hours | Notes |
|-------|---------------|-------------|-------------|-------|
| Phase 1 | 8 steps | +2 (command queue, plugin dep reporting) | ~3 hrs | Foundational reliability |
| Phase 2 | 4 steps | +1 (reconnect-on-failure) | ~1.5 hrs | Simple retry logic |
| Phase 3 | 10 steps | +2 (Python safety, delete safety) | ~4.5 hrs | Security + data integrity |
| Phase 4 | 3 steps | +1 (RC error wrapping) | ~0.5 hrs | Clean error messages |
| Phase 5 | 8 steps | +1 (distribution script) | ~1 hr | PowerShell + P4 |
| Phase 6 | 6 steps | 0 | 0 | Confluence page already planned |
| **Total** | **39 steps** | **+8 steps** | **~12 hrs** | |

**Deferred items** (see risks-and-decisions.md D16): RC port discovery (~0.5 hrs if triggered), property type pre-validation, rate limiting, undo system. Total deferred: ~40+ raw hours of work that is unlikely to be needed for a solo dev on localhost.

---

