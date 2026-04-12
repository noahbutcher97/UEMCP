# UEMCP Manual Test Prompts

**Purpose**: Verify all implemented functionality before Phase 3 work.
**Date**: 2026-04-12 (Phase 2 complete)
**Prerequisites**:
- Claude Code session launched from `D:\UnrealProjects\5.6\ProjectA`
- For TCP tests: Unreal Editor open with ProjectA project, UnrealMCP plugin active on TCP:55557

---

## Group 1: Server Health & Management Tools

These verify the server starts, connects, and the dynamic toolset system works.

### 1.1 — Connection Info (baseline)
```
Call connection_info to show me the status of all UEMCP layers.
```
**Expected**: Shows project "ProjectA", projectRoot pointing to the inner directory with .uproject. Offline layer available. TCP:55557 available if editor is running. TCP:55558 and HTTP:30010 unavailable.

### 1.2 — Project Auto-Detection
```
Run detect_project to see if UEMCP can find my running editor.
```
**Expected**: Returns detected project path, PID, and confidence score. If no editor is open, returns `project: null`.

### 1.3 — List All Toolsets
```
Use list_toolsets to show all available UEMCP toolsets.
```
**Expected**: 15 toolsets. Offline enabled. Actors/blueprints-write/widgets available but disabled (if editor running). Phase 3+ toolsets unavailable. Active tool count shows 16 (6 management + 10 offline).

### 1.4 — Find Tools (auto-enable)
```
Use find_tools with query "spawn actor blueprint"
```
**Expected**: Returns matching tools from actors and blueprints-write toolsets. Auto-enables both toolsets. Response includes TOOLSET_TIPS for newly enabled toolsets.

### 1.5 — Disable Toolset
```
Disable the actors and blueprints-write toolsets.
```
**Expected**: Both disabled. Confirm with list_toolsets — only offline should be enabled.

### 1.6 — Enable + Tip Delivery
```
Enable the actors toolset only.
```
**Expected**: Response includes actors core tips (spawn_actor types, exact-match names, set_actor_property type limits). Should NOT include cross-toolset workflow tips for blueprints-write (not enabled).

### 1.7 — Cross-Toolset Tips
```
Now also enable the blueprints-write toolset.
```
**Expected**: Response includes blueprints-write core tips AND the actors↔blueprints-write workflow tip ("compile before spawn").

### 1.8 — Tool Count Warning
```
Enable actors, blueprints-write, and widgets toolsets all at once.
```
**Expected**: All 3 enabled. Active tool count = 6 + 10 + 15 + 7 + 10 = 48. Should show warning about exceeding the 40-tool accuracy threshold.

---

## Group 2: Offline Tools (no editor required)

These test disk-based project introspection. Work in any session.

### 2.1 — Project Info
```
Use project_info to show me the ProjectA project details.
```
**Expected**: Engine version, module name, plugins list, build config from .uproject file.

### 2.2 — Gameplay Tags (full list)
```
Use list_gameplay_tags to show the full tag hierarchy.
```
**Expected**: All tags from DefaultGameplayTags.ini organized hierarchically. Should include Gameplay.Ability.*, Gameplay.State.*, GameplayEvent.*, Data.*, etc.

### 2.3 — Gameplay Tags (search)
```
Search gameplay tags matching "Gameplay.State.*"
```
**Expected**: Returns only State tags (IsAttacking, IsDead, IsStunned, IsDodging, etc.).

### 2.4 — Gameplay Tags (deep glob)
```
Search gameplay tags matching "Gameplay.Ability.Attack.**"
```
**Expected**: Returns Attack subtree including Light, Heavy, and any deeper children. The ** glob matches across multiple levels.

### 2.5 — Config Progressive Drill-Down (step 1: list files)
```
Use list_config_values with no arguments to list available config files.
```
**Expected**: List of .ini files in Config/ (DefaultEngine.ini, DefaultGame.ini, DefaultGameplayTags.ini, DefaultInput.ini, etc.).

### 2.6 — Config Progressive Drill-Down (step 2: list sections)
```
Use list_config_values with config_file "DefaultEngine.ini"
```
**Expected**: List of [Section] headers from DefaultEngine.ini.

### 2.7 — Config Progressive Drill-Down (step 3: specific key)
```
Use list_config_values with config_file "DefaultGame.ini", section "/Script/EngineSettings.GameMapsSettings", key "GlobalDefaultGameMode"
```
**Expected**: Returns the GameMode class path. Should be the ProjectA game mode.

### 2.8 — Source Search
```
Use search_source to find "UFUNCTION" in files containing "GA_OS"
```
**Expected**: Returns matches from ability files (GA_OSAttack, GA_OSBlock, GA_OSDodge, etc.). Capped at 50 matches.

### 2.9 — Source Search (edge: no results)
```
Use search_source with pattern "ZZZZNONEXISTENT" to verify empty results.
```
**Expected**: Returns empty result set, no error.

### 2.10 — Read Source File
```
Use read_source_file to read "Source/ProjectA/Public/GAS/Abilities/OSGameplayAbility.h"
```
**Expected**: Full file contents of the base ability class header.

### 2.11 — Read Source File (path traversal blocked)
```
Use read_source_file with file_path "../../etc/passwd"
```
**Expected**: Error about path traversal or file type not allowed. Should NOT return file contents.

### 2.12 — Browse Content
```
Use browse_content with no arguments to see the Content root.
```
**Expected**: Top-level directories under Content/.

### 2.13 — Browse Content (subdirectory)
```
Use browse_content with path "GAS/Effects"
```
**Expected**: Lists .uasset files for gameplay effects (if the directory exists).

### 2.14 — List Plugins
```
Use list_plugins to show all installed plugins.
```
**Expected**: Shows UnrealMCP, NodeToCode-main, Wwise/AkAudio, RiderLink, etc. with enabled/disabled status.

### 2.15 — Build Config
```
Use get_build_config to show module dependencies and build settings.
```
**Expected**: Parses ProjectA.Build.cs and Target files. Shows module dependencies (GameplayAbilities, AkAudio, etc.).

---

## Group 3: TCP Actor Tools (requires editor + UnrealMCP on 55557)

Enable the actors toolset first if not already enabled.

### 3.1 — List All Actors
```
Enable the actors toolset, then use get_actors to list all actors in the current level.
```
**Expected**: Returns array of actor names/types in the currently open level.

### 3.2 — Find Actors by Pattern
```
Use find_actors with pattern "Light" to find all light actors.
```
**Expected**: Returns actors with "Light" in their name. Case-sensitive substring match.

### 3.3 — Spawn + Transform + Delete Lifecycle
```
1. Spawn a PointLight named "MCP_TestLight" at location [0, 0, 500]
2. Move it to location [100, 200, 500] using set_actor_transform
3. Get its properties using get_actor_properties
4. Delete it using delete_actor
5. Verify it's gone with find_actors pattern "MCP_TestLight"
```
**Expected**: Each step succeeds. Properties show the updated transform. After delete, find returns empty.

### 3.4 — Get Actor Properties
```
Use get_actor_properties on any actor visible in get_actors output.
```
**Expected**: Detailed JSON of the actor's properties (class, components, transform, etc.).

### 3.5 — Set Actor Property
```
Spawn a PointLight named "MCP_PropTest" then set its "Intensity" property to 5000.0
```
**Expected**: Property set succeeds. Verify with get_actor_properties that Intensity changed. Clean up by deleting the actor.

### 3.6 — Focus Viewport
```
Focus the editor viewport on any actor in the level using focus_viewport.
```
**Expected**: Editor camera moves to the target. Returns success.

### 3.7 — Spawn Blueprint Actor
```
If a Blueprint exists under /Game/Blueprints/, spawn it using spawn_blueprint_actor.
```
**Expected**: Instance appears in the level. If no blueprints exist, this is expected to fail with a clear error — that's valid too.

### 3.8 — Error Handling: Non-existent Actor
```
Try to get_actor_properties on "NonExistentActor12345"
```
**Expected**: Returns an error (either from the editor or wrapped by ConnectionManager). Should NOT crash the server.

---

## Group 4: TCP Blueprint-Write Tools (requires editor + UnrealMCP on 55557)

Enable the blueprints-write toolset first.

### 4.1 — Create + Compile Blueprint
```
Enable blueprints-write, then create a blueprint called "BP_MCPTest" with parent_class "Actor". Then compile it.
```
**Expected**: Blueprint created at /Game/Blueprints/BP_MCPTest. Compile returns success.

### 4.2 — Add Component + Set Property
```
Add a StaticMeshComponent named "TestMesh" to BP_MCPTest. Then set its Mobility to "Movable".
```
**Expected**: Component added (auto-compiles). Property set succeeds.

### 4.3 — Blueprint Property (CDO)
```
Set a Class Default Object property on BP_MCPTest using set_blueprint_property.
```
**Expected**: Property set on the CDO. Compile to apply.

### 4.4 — Graph Nodes: Find Events
```
Use find_nodes on BP_MCPTest with node_type "Event" to find existing event nodes.
```
**Expected**: Returns any Event nodes in the blueprint's event graph (BeginPlay, etc.).

### 4.5 — Cleanup
```
Delete the BP_MCPTest blueprint actor from the level if spawned, but note: there's no delete_blueprint tool — the asset persists in /Game/Blueprints/. Just confirm the tools worked.
```

---

## Group 5: TCP Widget Tools (requires editor + UnrealMCP on 55557)

Enable the widgets toolset first.

### 5.1 — Create Widget + Add Elements
```
Enable widgets, then create a widget blueprint called "WBP_MCPTest". Add a text block and a button to it.
```
**Expected**: Widget created at /Game/Widgets/WBP_MCPTest with root CanvasPanel. Text block and button added.

### 5.2 — Set Text Content
```
Use set_text_block_text to set the text block content to "Hello from MCP"
```
**Expected**: Text updated.

### 5.3 — Bind Widget Event
```
Use bind_widget_event on the button (OnClicked event).
```
**Expected**: Event binding created. Safe to call multiple times without duplicates.

### 5.4 — Known Broken: add_widget_to_viewport
```
Try add_widget_to_viewport on WBP_MCPTest.
```
**Expected**: Returns success-ish but does NOT actually add to viewport. This is a known no-op bug documented in TOOLSET_TIPS.

### 5.5 — Known Broken: set_text_block_binding
```
Try set_text_block_binding on a text block.
```
**Expected**: May return success but the binding has a broken exec→data pin connection. Known bug documented in TOOLSET_TIPS.

---

## Group 6: Auto-Resolve Validation (new feature)

These test the .uproject auto-resolve added today.

### 6.1 — Correct Root (no warning)
```
Call connection_info and verify projectRoot shows no warning.
```
**Expected**: projectRoot = the directory with .uproject. No `projectRootWarning` or `projectRootConfigured` fields.

### 6.2 — Wrong Root (auto-resolve)
To test this, temporarily change UNREAL_PROJECT_ROOT in .mcp.json to `D:/UnrealProjects/5.6/ProjectA` (the outer directory without .uproject), restart Claude Code, then:
```
Call connection_info to see if auto-resolve kicked in.
```
**Expected**: projectRoot = auto-resolved inner path. `projectRootWarning` and `projectRootConfigured` fields present in output. Offline tools still work.

**Don't forget to revert .mcp.json after this test.**

---

## Group 7: Edge Cases & Error Resilience

### 7.1 — Find Tools: No Results
```
Use find_tools with query "quantumfluxcapacitor"
```
**Expected**: Returns "no tools found" message. No toolsets auto-enabled.

### 7.2 — Enable Non-existent Toolset
```
Try to enable a toolset called "nonexistent-toolset"
```
**Expected**: Returns unknown in the result object. No crash.

### 7.3 — Disable Already-Disabled Toolset
```
Disable the actors toolset when it's already disabled.
```
**Expected**: Returns wasNotEnabled in the result. No error.

### 7.4 — TCP Tool When Editor Closed
If the editor is NOT running:
```
Enable actors toolset and try get_actors.
```
**Expected**: Error about connection refused to TCP:55557. Clear error message, server stays healthy.

### 7.5 — Rapid Sequential Calls
```
In quick succession: get_actors, then find_actors with pattern "Player", then get_actors again.
```
**Expected**: All three succeed. The second get_actors may return cached results (5min TTL). CommandQueue serializes per-layer.

---

## Test Results Template

| Test | Status | Notes |
|------|--------|-------|
| 1.1  |        |       |
| 1.2  |        |       |
| ...  |        |       |
