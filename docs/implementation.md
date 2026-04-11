# Implementation Plan

> Source of truth for tool definitions: [tools.yaml](../tools.yaml)
> Handler filenames derived by convention: `UEMCP${PascalCase(toolsetName)}Commands.h/.cpp`

## File Changes

### New Files

**MCP Server (Node.js)**:

| File | Description |
|------|-------------|
| `UEMCP/server/server.mjs` | MCP server entry point: stdio transport, connection manager, tool routing, `tools/list` dynamic response |
| `UEMCP/server/toolset-manager.mjs` | ToolsetManager: toolset registry, enable/disable state, `tools/list_changed` notifications |
| `UEMCP/server/tool-index.mjs` | ToolIndex: weighted keyword search with tokenization, stemming, alias expansion |
| `UEMCP/server/connection-manager.mjs` | ConnectionManager: TCP clients (55557, 55558), HTTP client (30010), auto-detection, lazy connect |
| `UEMCP/server/package.json` | Dependencies: `@modelcontextprotocol/sdk`, `zod` (plain JS, no build step — matches existing MCP servers) |

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

**Build**:
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

**Testing & Revision** (see `testing-strategy.md` Tests 1–8):
11. Smoke test: server boots clean from terminal with env vars, no crashes
12. Claude Code integration: `list_toolsets` shows 15 toolsets, offline available, rest unavailable
13. Offline tools: `search_gameplay_tags` returns tags from `DefaultGameplayTags.ini` with no editor
14. ToolIndex quality: 7 reference queries (see testing-strategy.md Test 4) return correct top matches
15. Accumulation/shedding: `find_tools` accumulates enabled toolsets, `disable_toolset` sheds them
16. Auto-detection: `detect_project` with editor open returns correct project name
17. Error paths: empty query, bad toolset name, bad project root — all return clean errors
18. **Revision**: Fix any failing tests. If ToolIndex ranking is poor, tune weights/stemmer before proceeding — Phase 2+ depends on search quality.

**Documentation**:
19. Commit server code to git with message describing what was built
20. Update `UEMCP/docs/` if any design decisions changed during implementation (e.g., ToolIndex algorithm differs from plan)
21. Log actual time spent vs. estimate in outcome analysis below

**Outcome Analysis** (fill in after phase completes):
- Estimated time: ~3 hrs (audit steps) + implementation time
- Actual time: ___
- ToolIndex search quality: acceptable / needs tuning? ___
- Offline tool coverage: any tools that turned out harder than expected? ___
- Surprises / deviations from plan: ___
- Carry-forward items for Phase 2: ___

### Phase 2: TCP Layer — Existing Plugin (port 55557)

**Build**:
13. Implement TCP send/receive — see `docs/tcp-protocol.md` for exact wire format (field name is `type` not `command`, no newline on request, connect-per-command pattern)
14. **[AUDIT]** Basic reconnect-on-failure: if TCP send fails, mark layer disconnected, retry connect on next tool call. No backoff needed for localhost. (~1.5 hrs)
15. Register 3 existing plugin toolsets with Zod schemas:
    - `actors` (10 tools)
    - `blueprints-write` (9 tools + BP node tools — see Section 8.2 note)
    - `widgets` (7 tools)

**Testing & Revision** (see `testing-strategy.md` Tests 9–13):
16. TCP connection: `connection_info` shows TCP:55557 connected when editor is running
17. Parity: Run 5 operations (spawn, move, create BP, add variable, delete) through both old Python server and new Node.js server — outputs must match
18. End-to-end discovery flow: natural language prompt → `find_tools` → auto-enable → tool execution → result
19. Reconnect: close editor → tool call fails cleanly → reopen editor → next tool call reconnects
20. Graceful degradation: plugin disabled → `list_toolsets` shows unavailable → offline still works
21. **Regression**: Re-run Phase 1 Tests 2–5 (Claude Code integration, offline tools, ToolIndex, accumulation) — TCP integration must not break offline behavior
22. **Revision**: If parity test fails, diff the JSON protocol between Python and Node.js implementations. Fix schema mismatches before proceeding.

**Documentation**:
23. Commit with message describing TCP layer and toolset registrations
24. If JSON protocol required any adaptation (param naming, response format), document the mapping in a code comment or brief note in `docs/`

**Outcome Analysis**:
- Estimated time: ~1.5 hrs (audit) + implementation time
- Actual time: ___
- Parity result: full match / partial match / issues? ___
- Reconnect behavior: works as planned / needed adjustment? ___
- Any Python server protocol quirks discovered: ___
- Carry-forward items for Phase 3: ___

### Phase 3: TCP Layer — New Custom Plugin (port 55558)

Phase 3 is the largest phase. It has 4 internal priority tiers. **Test each tier before starting the next.** Do not build all 10 toolsets then test — bugs in the subsystem or command dispatch will cascade.

**Build — Plugin foundation**:
18. Create UEMCP C++ plugin project structure (`.uplugin`, `Build.cs`, module files)
19. Implement UEMCPSubsystem with TCP server on 55558 + command dispatch (game-thread dequeue, one command per tick)

**Checkpoint — Plugin compiles and connects**:
19a. Compile plugin in editor — no errors
19b. `connection_info` shows TCP:55558 connected
19c. Send a no-op command over TCP — get a valid JSON response back

**Build — Priority 1 (GAS + Blueprint Read)**:
20. `gas` toolset: 5 commands (GE create/modify, GA create, runtime tags, AttributeSet)
    `blueprint-read` toolset: 10 commands (info, variables, functions, graphs, components, dispatchers, AnimBP, Widget BP, Niagara)

**Checkpoint — Priority 1 verified** (see `testing-strategy.md` Tests 14–18):
20a. GAS: create a GE → verify asset exists in editor with correct parameters
20b. GAS: modify existing GE → verify changes applied
20c. GAS: query runtime tags in PIE → verify tags match game state
20d. Blueprint Read: introspect BP_OSPlayer → verify variables/functions match editor
20e. Blueprint Read: inspect AnimBP → verify state machine data returned

**Build — Priority 2 (Animation + Materials)**:
21. `animation` toolset: 8 commands (montage CRUD, sequence info, blend space, curves, audio metadata)
    `materials` toolset: 5 commands (create, instances, parameters, material graph)

**Checkpoint — Priority 2 verified** (see `testing-strategy.md` Tests 19–21):
21a. Animation: create montage with sections → verify in editor
21b. Animation: read existing combo montage → verify section names/notifies match
21c. Materials: create MID with parameter override → verify in editor

**Build — Priority 3 (Data + Asset Registry)**:
22. `data-assets` toolset: 7 commands (data asset CRUD, properties, curves, string tables, structs)
    `asset-registry` toolset: 5 commands (search, references, hierarchy, DataTable, metadata)

**Checkpoint — Priority 3 verified** (see `testing-strategy.md` Tests 22–23):
22a. Asset Registry: query referencers of GE_OSApplyDamage → verify referrer list
22b. Data Assets: read/write a data asset property → verify round-trip

**Build — Priority 4 (Remaining toolsets)**:
23. `input-and-pie` toolset: 7 commands (Enhanced Input + PIE control)
    `geometry` toolset: 4 commands (procedural mesh, CSG, UVs, mesh info)
    `editor-utility` toolset: 8 commands (editor state, Python, EUB, asset management)
    `visual-capture` toolset: 5 commands (thumbnails, viewport, preview, panel capture, visual summary)
24. **[AUDIT]** `run_python_command` safety: deny-list (`os.`, `subprocess`, `eval`, `exec`, `open`, `__import__`), confirmation dialog via `FMessageDialog::Open`, all executions logged to `Saved/Logs/PythonExecutionLog.txt`. See D14. (~1.5 hrs)
25. **[AUDIT]** `delete_asset` safety: query `IAssetRegistry::GetReferencers()` before delete. If hard refs exist and `force` param is false (default), refuse with referrer list. `rename_asset` uses UE native redirect + warns on unfixable soft refs. (~3 hrs)
26. Register all 10 UEMCP toolsets (64 tools) in Node.js server with Zod schemas

**Testing & Revision** (see `testing-strategy.md` Tests 14–28):
27. Each toolset individually with editor running — every tool called at least once
28. `find_tools` correctly discovers and auto-enables UEMCP toolsets
29. Image tools return valid base64 (1024×1024 JPEG default) within stdio payload limits
30. Python deny-list: benign command executes (with confirmation dialog), blocked command rejected, both logged
31. Delete safety: asset with referencers refused, `force=true` overrides, referrer list returned
32. TCP command queue: rapid sequential calls serialized correctly, no interleaving
33. **Regression**: Re-run Phase 1 Tests 2–5, Phase 2 Tests 16–18 — three TCP layers must not interfere
34. **Revision**: If any toolset consistently fails, check command dispatch routing in UEMCPSubsystem. If a UE API behaves differently than documented, note it in risks-and-decisions.md and adapt.

**Documentation**:
35. Commit plugin code and Node.js toolset registrations
36. For each toolset: verify tool descriptions in `tools.yaml` match actual behavior. Update descriptions if implementation revealed better wording.
37. Document any UE API surprises in `docs/risks-and-decisions.md` (new "Implementation Notes" section)

**Outcome Analysis**:
- Estimated time: ~4.5 hrs (audit) + implementation time
- Actual time per priority tier: P1 ___ / P2 ___ / P3 ___ / P4 ___
- Tools that worked first try vs. needed iteration: ___
- UE APIs that behaved unexpectedly: ___
- Tool descriptions that needed rewording: ___
- Any toolsets that should be split or merged based on usage: ___
- Carry-forward items for Phase 4: ___

### Phase 4: Remote Control API Layer (HTTP:30010)

**Build**:
30. Implement HTTP client for RC API (use `UNREAL_RC_PORT` env var, default 30010)
31. Register `remote-control` toolset (8 tools)
32. **[AUDIT]** Wrap RC API error responses in clean structured messages (type mismatch, object not found, property not found). (~0.5 hrs)

**Testing & Revision** (see `testing-strategy.md` Tests 29–33):
33. RC API connection: `connection_info` shows HTTP:30010 connected
34. Property round-trip: get transform → set transform → verify in viewport
35. Function call: invoke a UFUNCTION → verify side effects
36. Error wrapping: nonexistent object returns clean message (not raw HTTP/JSON blob), wrong type returns type mismatch message
37. Batch: read 5 properties in one call → all values correct
38. **Regression**: Re-run Phase 2 Test 18 (end-to-end discovery flow) and Phase 3 Test 28 (find_tools auto-enable) — HTTP layer must not break TCP flows
39. **Revision**: If RC API returns unexpected formats for certain property types (structs, arrays, maps), add type-specific serialization handling before moving on.

**Documentation**:
40. Commit HTTP client code
41. If RC API required any workarounds (auth headers, non-standard endpoints), document in `docs/configuration.md` error behavior table

**Outcome Analysis**:
- Estimated time: ~0.5 hrs (audit) + implementation time
- Actual time: ___
- RC API coverage: any planned tools that turned out infeasible via RC API? ___
- Property types that needed special handling: ___
- Carry-forward items for Phase 5: ___

### Phase 5: Integration & Config

**Build**:
34. Update `ProjectA/.mcp.json` — swap unreal entry
35. Update `ProjectB/.mcp.json` — swap unreal entry
36. Update `claude_desktop_config.json` — add `unreal-projecta` and `unreal-projectb` entries
37. Enable plugins in both .uproject files (RC API, RC Components, Python Editor Script, Geometry Script, Sequencer Scripting)
38. **[AUDIT]** Run `sync-uemcp-plugins.ps1` to copy plugin to ProjectB. Submit to P4. See D15.

**Testing & Revision** (see `testing-strategy.md` Tests 34–40):
39. ProjectA end-to-end: exercise one tool from each layer (offline, TCP:55557, TCP:55558, HTTP:30010) in a single session
40. ProjectB end-to-end: same as above, verify auto-detection picks up correct project
41. Cowork (editor open): natural language prompt → auto-detect → tool execution → result
42. Cowork (editor closed): prompt → offline fallback → result, no error noise about missing editor
43. Wrong-project detection: ProjectB config but ProjectA editor open → clear warning
44. Plugin distribution: `sync-uemcp-plugins.ps1` copies cleanly, ProjectB editor loads plugin
45. Coexistence: old Python server files on disk, no port conflicts, no stale config references
46. **Regression**: Full regression — run critical tests from all prior phases (Phase 1 Tests 2–5, Phase 2 Tests 17–19, Phase 3 Tests 20a–20d + 28, Phase 4 Tests 34–35). This is the final integration gate.
47. **Revision**: If auto-detection fails for one project, check PowerShell process inspection output. If Cowork config doesn't load, verify `claude_desktop_config.json` key names match expected format.

**Documentation**:
48. Commit config changes and distribution script
49. Document the final config (both `.mcp.json` files, `claude_desktop_config.json`) in a brief setup section so future-you can recreate it
50. If any config values changed from plan (ports, env vars, key names), update `docs/configuration.md`

**Outcome Analysis**:
- Estimated time: ~1 hr (audit) + implementation time
- Actual time: ___
- Auto-detection reliability: worked first try / needed tuning? ___
- Cowork vs. Claude Code differences: any? ___
- ProjectB distribution: clean / required manual fixup? ___
- Old server coexistence: any conflicts? ___
- Carry-forward items for Phase 6: ___

### Phase 6: Documentation & Cleanup

**Build**:
42. Update `ProjectA/CLAUDE.md` with dynamic toolset documentation (toolset names, typical workflows)
43. Create `ProjectB/CLAUDE.md` if needed
44. Publish Confluence page for ProjectB team (plugin overview, zero-action install, FAQ, troubleshooting)
45. Optional: Remove old `unreal` entry from .mcp.json (keep Python servers on disk)
46. Add project-specific aliases to ToolIndex based on team feedback

**Testing & Revision** (see `testing-strategy.md` Tests 41–43):
47. CLAUDE.md accuracy: start fresh Claude Code session, ask "how do I use the Unreal MCP tools?" — Claude's explanation should match reality
48. Confluence page: verify instructions are accurate, walkthrough the setup from a team member's perspective
49. Aliases: `find_tools("aura")` returns GAS tools, `find_tools("combo")` returns animation + GAS tools
50. **Revision**: If Claude's explanation of the toolset system is confusing, rewrite the CLAUDE.md section. The docs are the interface — if they're unclear, the tool is unclear.

**Documentation**:
51. Final git commit for all docs
52. Tag the repo (e.g., `v1.0.0`) — this marks "plan complete, all phases implemented"

**Project-Level Outcome Analysis** (fill in after all phases complete):
- Total estimated time (all phases): ___
- Total actual time (all phases): ___
- Ratio (actual/estimated): ___ — use this to calibrate future estimates
- Tools that shipped as planned: ___ / 114
- Tools cut or deferred during implementation: ___
- Tools added that weren't in the original plan: ___
- Biggest time sink: ___
- What would you do differently: ___
- Deferred items from risks-and-decisions.md that should be promoted to real work: ___
- Deferred items that confirmed YAGNI: ___

---

## Effort Budget (AI-Assisted)

Estimates assume AI code generation for all implementation. Steps marked **[AUDIT]** were added during the April 2026 plan audit and are not in the original plan. Each phase now includes Testing & Revision, Documentation, and Outcome Analysis gates.

| Phase | Build Steps | Audit Steps | Test/Rev Steps | Doc Steps | Audit Hours | Notes |
|-------|------------|-------------|----------------|-----------|-------------|-------|
| Phase 1 | 8 | +2 | 9 | 3 | ~3 hrs | Foundational reliability |
| Phase 2 | 3 | +1 | 8 | 2 | ~1.5 hrs | Parity + reconnect |
| Phase 3 | 9 | +2 | 9 | 3 | ~4.5 hrs | Largest phase, 4 internal tiers |
| Phase 4 | 3 | +1 | 8 | 2 | ~0.5 hrs | Clean error messages |
| Phase 5 | 5 | +1 | 10 | 3 | ~1 hr | Full integration gate |
| Phase 6 | 5 | 0 | 4 | 2 | 0 | Docs + aliases |
| **Total** | **33** | **+7** | **48** | **15** | **~10.5 hrs** | |

Testing and documentation steps add no significant hours — they're verification of work already done, not new implementation. The time cost is in *fixing* what the tests reveal.

**Deferred items** (see risks-and-decisions.md D16): RC port discovery (~0.5 hrs if triggered), property type pre-validation, rate limiting, undo system. Total deferred: ~40+ raw hours of work that is unlikely to be needed for a solo dev on localhost.

---

