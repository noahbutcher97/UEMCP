# Phase Expectations & Testing Strategy

What to expect after each implementation phase — what works, what you can test, and how to test it.

---

## Phase 1: Core Server + Dynamic Toolset Infrastructure

### What You Get
The Node.js MCP server runs, connects via stdio, and exposes 16 tools (6 management + 10 offline). No editor needed. This is the foundation everything else plugs into.

### What You Can Do
- **`list_toolsets`** — see all 15 toolsets with availability status. Offline shows "available". All TCP/HTTP toolsets show "unavailable — editor not running" (or "unavailable — plugin not loaded" once you're testing with editor later).
- **`find_tools("gameplay tags")`** — searches all 114 tool descriptions, returns matches ranked by relevance. Auto-enables the `offline` toolset and returns `list_gameplay_tags` + `search_gameplay_tags`.
- **`enable_toolset` / `disable_toolset`** — manually toggle toolsets on/off. Fires `tools/list_changed` so Claude sees the updated tool list.
- **`connection_info`** — reports all 4 layers as disconnected (no editor), project root from env var, offline layer available.
- **`detect_project`** — with editor closed, returns "no editor detected, offline mode". With editor open, returns the detected project name + confidence.
- **All 10 offline tools** — `project_info`, `list_gameplay_tags`, `search_gameplay_tags`, `list_config_values`, `browse_content`, `get_asset_info`, `search_source`, `read_source_file`, `list_plugins`, `get_build_config`.

### What You Can't Do Yet
- Anything that touches the editor (actors, blueprints, GAS, materials, etc.)
- TCP or HTTP communication

### Testing Strategy

**Test 1 — Server boots clean (smoke test)**
```bash
# From terminal, run the server directly with env vars
cd ~/.claude/mcp-servers/unreal
UNREAL_PROJECT_ROOT="D:/UnrealProjects/5.6/ProjectA/ProjectA" node server.mjs
# Should start without errors, listen on stdio
# Ctrl+C to exit
```

**Test 2 — Claude Code integration**
1. Open Claude Code in the ProjectA project (which has `.mcp.json` pointing to the new server)
2. Ask: "What tools do you have for Unreal?"
3. Claude should see the 6 management tools and call `list_toolsets`
4. All TCP/HTTP toolsets should show unavailable (editor closed)
5. Offline toolset should show available

**Test 3 — Offline tools work without editor**
1. Editor closed
2. Ask Claude: "What gameplay tags exist for combat?"
3. Claude should call `find_tools("gameplay tags")` → auto-enables `offline` → calls `search_gameplay_tags` with a combat pattern
4. Should return tags from `DefaultGameplayTags.ini` — `Gameplay.Ability.Attack.*`, `Gameplay.State.IsAttacking`, etc.

**Test 4 — ToolIndex search quality**
Verify these queries return sensible results:

| Query | Expected top match(es) |
|-------|----------------------|
| `"spawn actor"` | `spawn_actor` (actors toolset) |
| `"gameplay effect"` | `create_gameplay_effect`, `modify_gameplay_effect` (gas toolset) |
| `"montage"` | `create_montage`, `edit_montage`, `get_montage_info` (animation toolset) |
| `"property"` | `get_property`, `set_property` (remote-control toolset) |
| `"screenshot"` | `capture_viewport`, `capture_editor_panel` (visual-capture toolset) |
| `"PIE"` or `"play"` | `start_pie`, `stop_pie` (input-and-pie toolset) |
| `"delete asset"` | `delete_asset` (editor-utility toolset) |

These searches won't *execute* the tools (layers unavailable), but they should find and rank them correctly.

**Test 5 — Accumulation and shedding**
1. `find_tools("spawn actor")` → enables `actors`
2. `find_tools("gameplay effect")` → enables `gas`
3. `list_toolsets` → both `actors` and `gas` should show enabled
4. `disable_toolset(["actors"])` → actors disabled, gas still enabled
5. `list_toolsets` → verify state

**Test 6 — Auto-detection with editor running**
1. Open Unreal Editor with ProjectA
2. Run `detect_project` — should return "ProjectA" with high confidence
3. `connection_info` — should show TCP:55557 as "unknown" (haven't tried connecting yet), offline as "available"

**Test 7 — [AUDIT] Unavailable toolset reporting**
1. Editor open but without Geometry Script plugin enabled
2. `list_toolsets` should show `geometry` as "unavailable — Geometry Script plugin not enabled. Enable in Edit > Plugins."
3. Toolsets whose layer is connected should show "available"

**Test 8 — Edge cases**
- `find_tools("")` — empty query, should return error or empty results
- `enable_toolset(["nonexistent"])` — should return clear error
- `disable_toolset(["offline"])` — should work (can re-enable later)
- Run server with bad `UNREAL_PROJECT_ROOT` — should start but offline tools should report missing path

---

## Phase 2: TCP Layer — Existing Plugin (port 55557)

### What You Get
The server can now talk to the existing UnrealMCP plugin over TCP. Three toolsets (26 tools) become available: `actors` (10), `blueprints-write` (9+), `widgets` (7).

### What You Can Do
- **Everything from Phase 1** plus:
- **Spawn, move, delete actors** in the level
- **Create Blueprint classes**, add variables, functions, nodes, connect them
- **Create UMG widgets**, add text blocks, buttons, bind events
- **Parity with the current Python MCP server** — anything Claude can do today via the old server, it can now do via the new one

### What You Can't Do Yet
- New plugin tools (GAS, materials, animation, blueprint-read, etc.)
- Remote Control API (property reflection)

### Testing Strategy

**Test 9 — TCP connection and basic command**
1. Editor open with ProjectA loaded
2. `connection_info` — TCP:55557 should show "connected"
3. `enable_toolset(["actors"])` — should succeed
4. Call `list_actors` or `get_actor_properties` — should return level actors

**Test 10 — Parity with Python server**
This is the critical test. Run the same operations through both servers and compare:

| Operation | Old Python server | New Node.js server | Compare |
|-----------|------------------|--------------------|---------| 
| Spawn a cube at 0,0,100 | `spawn_actor` | `spawn_actor` | Same actor created |
| Move it to 500,0,100 | `set_actor_transform` | `set_actor_transform` | Same result |
| Create a BP class | `create_blueprint` | `create_blueprint` | Same asset path |
| Add a variable to BP | `add_variable` | `add_variable` | Same variable appears |
| Delete the actor | `delete_actor` | `delete_actor` | Actor removed |

If any output differs, the Zod schema or parameter mapping is wrong.

**Test 11 — find_tools auto-enable flow (end-to-end)**
1. Start fresh session (no toolsets enabled)
2. Ask Claude: "I want to add a cube to my level"
3. Claude calls `find_tools("spawn actor cube level")` → auto-enables `actors`
4. Claude calls `spawn_actor` with cube parameters
5. Cube appears in viewport
6. This validates the full discovery → enable → execute pipeline

**Test 12 — [AUDIT] Reconnect-on-failure**
1. Editor open, TCP:55557 connected
2. Close editor
3. Call any actors tool — should fail with "Editor not connected" message
4. Reopen editor
5. Call the same tool again — should auto-reconnect and succeed (no manual intervention)

**Test 13 — Graceful degradation**
1. Editor open but UnrealMCP plugin disabled
2. `list_toolsets` should show `actors`, `blueprints-write`, `widgets` as unavailable
3. Offline tools should still work
4. Calling an actors tool should return clean error, not crash

---

## Phase 3: TCP Layer — New Custom Plugin (port 55558)

### What You Get
This is the big phase. The new C++ plugin runs on port 55558, adding 64 tools across 10 new toolsets. This is where UEMCP goes far beyond what the existing setup can do.

### What You Can Do

**GAS toolset (5 tools)** — the highest-value addition for ProjectA:
- Create GameplayEffects (damage, buffs, costs) from Claude
- Create GameplayAbilities with boilerplate
- Modify GE parameters (duration, period, modifiers)
- Query live gameplay tags on actors at runtime
- Generate AttributeSet boilerplate code

**Blueprint-read toolset (10 tools)** — deep introspection:
- Read BP variables, functions, graphs, components without opening the editor
- Inspect AnimBP state machines, Widget BP hierarchies, Niagara systems
- Read event dispatchers and their bindings

**Animation toolset (8 tools)**:
- Create and edit montages (sections, notifies, blend times)
- Read montage structure (the `get_montage_info` deep-read)
- Query anim sequences, blend spaces, curves

**Materials toolset (5 tools)**:
- Create materials and material instances
- Set/get material parameters
- Read material graph node structure

**Plus**: data-assets (7), asset-registry (5), input-and-pie (7), geometry (4), editor-utility (8), visual-capture (5)

### What You Can't Do Yet
- Remote Control API property reflection
- Multi-project config (both ProjectA + ProjectB wired up)

### Testing Strategy

Phase 3 has 4 internal priority tiers. Test each tier before moving to the next.

**Priority 1 Tests — GAS + Blueprint Read**

**Test 14 — GAS: Create a GameplayEffect**
1. Ask Claude: "Create a GameplayEffect that deals 50 damage with a 2-second duration"
2. Claude should call `create_gameplay_effect` with appropriate params
3. Verify in editor: GE asset exists at expected path, has Duration policy, damage modifier set to 50

**Test 15 — GAS: Modify existing GE**
1. Ask Claude: "Change GE_OSApplyDamage to use a 3-second cooldown"
2. Claude should call `modify_gameplay_effect` targeting the existing asset
3. Verify in editor: cooldown tag + duration updated

**Test 16 — GAS: Query runtime tags**
1. PIE running, player character alive
2. Ask Claude: "What gameplay tags does the player have right now?"
3. Should return tags like `Gameplay.State.IsAlive` etc.
4. Trigger a block → re-query → should see `Gameplay.State.Guard.IsActive`

**Test 17 — Blueprint Read: Deep introspection**
1. Ask Claude: "What variables and functions does BP_OSPlayer have?"
2. Should return variable list with types, function list with signatures
3. Compare against what you see in the editor — should match

**Test 18 — Blueprint Read: AnimBP inspection**
1. Ask Claude: "Show me the state machine in the animation blueprint"
2. Should return states, transitions, and blend info

**Priority 2 Tests — Animation + Materials**

**Test 19 — Animation: Create a montage**
1. Ask Claude: "Create a montage from the light attack anim sequence with 3 sections"
2. Verify: montage asset created, sections exist, linked to correct sequence

**Test 20 — Animation: Read montage structure**
1. Ask Claude: "What sections and notifies does the combo attack montage have?"
2. Should return section names, notify classes + timestamps, blend settings
3. Compare against editor — should match

**Test 21 — Materials: Create material instance**
1. Ask Claude: "Create a red material instance from the base character material"
2. Verify: MID created, base color parameter set

**Priority 3 Tests — Data + Asset Registry**

**Test 22 — Asset Registry: Search and references**
1. Ask Claude: "What assets reference GE_OSApplyDamage?"
2. Should call `get_asset_references` and return referencing assets
3. This validates the `IAssetRegistry::GetReferencers()` integration

**Test 23 — Asset Registry: DataTable read**
1. If you have any DataTables, ask Claude to read rows
2. Should return structured row data

**Priority 4 Tests — Remaining toolsets**

**Test 24 — PIE control**
1. Ask Claude: "Start PIE"
2. Editor should enter Play-In-Editor mode
3. Ask Claude: "Run console command `showdebug AbilitySystem`"
4. Should execute in PIE
5. Ask Claude: "Stop PIE"

**Test 25 — [AUDIT] Python safety**
1. Ask Claude to use `run_python_command` with a benign command: `unreal.log("hello")`
2. Should execute, confirmation dialog should appear, log should be written
3. Try a blocked command: `import os; os.listdir("/")`
4. Should be denied by deny-list with clear error message
5. Check `Saved/Logs/PythonExecutionLog.txt` — both attempts should be logged

**Test 26 — [AUDIT] Delete safety**
1. Create a test asset (e.g., a material)
2. Create another asset that references it
3. Ask Claude: "Delete [test asset]"
4. Should refuse with "Asset has N referencers: [list]"
5. Ask Claude: "Delete [test asset] with force=true"
6. Should succeed (or you may want it to still refuse — your call on the force behavior)

**Test 27 — Visual capture**
1. Ask Claude: "Take a screenshot of the viewport"
2. Should return a base64 JPEG image that renders in the chat
3. Verify image is correct resolution and shows the actual viewport

**Test 28 — [AUDIT] TCP command queue stress**
1. Rapidly fire multiple tool calls (e.g., via a script that hits the server)
2. Verify commands are serialized — no interleaving, no duplicate execution
3. Check that request ID deduplication works: same write command sent twice within 5 min should return cached result

---

## Phase 4: Remote Control API Layer (HTTP:30010)

### What You Get
8 tools for reflection-based access to any UObject — get/set properties, call functions, search objects, batch operations. This is the "escape hatch" for anything not covered by dedicated toolsets.

### What You Can Do
- **Get any property** on any UObject by path (e.g., read a character's MaxWalkSpeed)
- **Set any property** (e.g., change gravity scale at runtime)
- **Call any UFUNCTION** exposed to the RC API
- **Search for objects** by class or name
- **Batch operations** — multiple get/set in one call
- **List available presets** (RC API registered objects)

### What You Can't Do Yet
- Multi-project switching (config not wired up yet)

### Testing Strategy

**Test 29 — RC API connection**
1. Ensure Remote Control API plugin is enabled in editor
2. `connection_info` — HTTP:30010 should show "connected"
3. If it shows unavailable, check Edit > Plugins > Remote Control API

**Test 30 — Property get/set round-trip**
1. Select an actor in the level
2. Ask Claude: "What's the transform of [actor]?"
3. Should call `get_property` with the object path + RelativeLocation
4. Returns current transform values
5. Ask Claude: "Move it 500 units up"
6. Should call `set_property` to update Z
7. Verify in viewport — actor moved

**Test 31 — Function call**
1. Ask Claude to call a UFUNCTION on an object
2. Verify the function executed (side effects visible in editor)

**Test 32 — [AUDIT] Error wrapping**
1. Ask Claude to get a property on a nonexistent object
2. Should return clean error: "Object not found: [path]" — not a raw HTTP 404 or RC API JSON blob
3. Ask Claude to set a property with the wrong type (e.g., string where float expected)
4. Should return clean error: "Type mismatch: expected Float, got String for property [name]"

**Test 33 — Batch operations**
1. Ask Claude to read 5 properties from different actors in one call
2. Should use batch endpoint, return all 5 in one response
3. Verify each value is correct

---

## Phase 5: Integration & Config

### What You Get
Both projects fully wired up. Cowork mode works. Auto-detection handles which project you're in. Everything is connected end-to-end.

### What You Can Do
- **Switch between ProjectA and ProjectB** — each has its own server instance with correct paths
- **Cowork mode** — open Cowork, talk to Claude about Unreal, offline tools work immediately, editor tools work when editor is open
- **Claude Code** — same as before but both projects configured
- **ProjectB team** — plugin distributed via P4, they get the same capabilities

### Testing Strategy

**Test 34 — ProjectA end-to-end**
1. Open Claude Code in ProjectA project
2. Open Unreal Editor with ProjectA
3. `list_toolsets` — all layers should show available
4. Exercise one tool from each layer:
   - Offline: `project_info`
   - TCP:55557: `list_actors`
   - TCP:55558: `create_gameplay_effect`
   - HTTP:30010: `get_property`

**Test 35 — ProjectB end-to-end**
1. Same as above but with ProjectB project
2. Verify auto-detection picks up ProjectB (not ProjectA)

**Test 36 — Cowork mode (editor open)**
1. Open Cowork desktop app
2. Editor running with ProjectA
3. Ask: "What actors are in my level?"
4. Should auto-detect ProjectA, connect, return actor list

**Test 37 — Cowork mode (editor closed)**
1. Close Unreal Editor
2. Ask in Cowork: "What gameplay tags exist for dodging?"
3. Should fall back to offline, parse `DefaultGameplayTags.ini`, return results
4. Should NOT show errors about editor not connected — clean fallback

**Test 38 — Auto-detection edge case**
1. Open editor with ProjectA
2. Run `detect_project` from ProjectB Claude Code instance
3. Should detect ProjectA is running but report it's the wrong project
4. Should warn: "Detected ProjectA but expected ProjectB"

**Test 39 — [AUDIT] Plugin distribution**
1. Run `sync-uemcp-plugins.ps1`
2. Verify UEMCP plugin copied to `ProjectB/Plugins/UEMCP/`
3. Open ProjectB in editor — plugin should load, TCP:55558 responsive

**Test 40 — Old server coexistence**
1. Verify old Python server files still on disk
2. Old `.mcp.json` entry removed, but Python servers don't conflict
3. Port 55557 still used by existing C++ plugin (shared, no change)

---

## Phase 6: Documentation & Cleanup

### What You Get
No new functionality. Clean documentation, Confluence page for ProjectB team, verified coexistence.

### What You Can Do
- Everything from Phase 5 — this phase is polish

### Testing Strategy

**Test 41 — CLAUDE.md accuracy**
1. Open Claude Code in ProjectA
2. Start a fresh conversation
3. Ask Claude: "How do I use the Unreal MCP tools?"
4. Claude should reference the updated CLAUDE.md and explain toolsets, `find_tools`, etc.
5. The explanation should match reality — no references to old Python server workflow

**Test 42 — Confluence page (ProjectB)**
1. Verify page exists and is accurate
2. Have a ProjectB team member follow the instructions
3. They should be able to use the plugin without asking you for help

**Test 43 — Project-specific aliases**
1. Test that `find_tools("aura")` returns GAS-related tools (aura = mana/magic system in ProjectA)
2. Test that project-specific terminology maps to correct toolsets

---

## Testing Principles

### 1. Test each phase in isolation before moving on
Don't start Phase 2 until every Phase 1 test passes. Each phase builds on the previous — bugs compound.

### 2. Parity testing (Phase 2 specifically)
The existing Python server is your ground truth for TCP:55557 tools. Any behavior difference is a bug in the new server.

### 3. Error path testing matters more than happy path
The happy path is easy to get right with AI assistance. The failure modes are where bugs hide:
- Editor not running
- Plugin not loaded
- Wrong project detected
- TCP timeout mid-command
- Asset doesn't exist
- Permission denied (locked by P4)

### 4. Test from Claude's perspective
Don't just call tools directly — test via natural language prompts in Claude Code/Cowork. This validates the full chain: Claude reads tool description → decides which tool to call → passes correct params → interprets response.

### 5. Regression after each phase
After completing Phase N, re-run the critical tests from Phase N-1. TCP integration (Phase 2) could break offline behavior (Phase 1) if ConnectionManager initialization has side effects.
