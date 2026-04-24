# Human Integration Smoke + Manual Verification Checklist — 2026-04-24

> **Context**: M-enhance ship-complete per D77; 36 agent-facing tools + 16 plugin handlers + save-hook + Content Browser menu + batch commandlet all landed. Wire-mock tests pass (1203 assertions green). **Live-editor validation is the gap** — this document is the human-action plan.
>
> **Executor**: Noah (or delegate with editor + P4 + Claude Code access). Not dispatchable to an AI agent — requires live editor interaction, visual/UX judgment, and P4-workflow decisions.
>
> **Duration**: 30-45 min first pass. Repeat as targeted spot-checks when questions surface.

---

## §Prerequisites

Before starting:
- [ ] **No editor instance running** (sync + rebuild requires editor closed)
- [ ] **`git pull` in `D:\DevTools\UEMCP\`** — latest code per `origin/main`
- [ ] **Comfortable with potential UBT friction** (D69 PCH VM retry pattern; D61 stale-DLL nuke recipe)
- [ ] **Claude Code workspace set to ProjectA** with `.mcp.json` pointing at UEMCP

If any prereq is unclear: stop and ask orchestrator to clarify before proceeding.

---

## §Part 1 — Plugin sync + rebuild (5-10 min)

### Step 1.1: Propagate plugin source to ProjectA

```cmd
cd /d D:\DevTools\UEMCP
sync-plugin.bat "D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject" -y
```

**Expected**: byte-identical sync completes in ~0.5-1s. If anything else happens, note + continue.

### Step 1.2: Clean rebuild

```cmd
rmdir /s /q "D:\UnrealProjects\5.6\ProjectA\ProjectA\Plugins\UEMCP\Binaries"
rmdir /s /q "D:\UnrealProjects\5.6\ProjectA\ProjectA\Plugins\UEMCP\Intermediate"
"C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" ProjectAEditor Win64 Development -project="D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject" -WaitMutex
```

**Expected**: `Result: Succeeded`. Build time 2-5 min (first clean rebuild).

**If D69 PCH VM error fires** (C1076 / C3859 on first Build.bat): retry once without changes. If second attempt also fails: stop, ping orchestrator.

**If `FUObjectToken` / missing-include errors**: that shouldn't recur (fixed in commit `a503372`). If it does, pull latest + retry.

### Step 1.3: Gate test regression check

Without opening editor, run:

```cmd
D:\DevTools\UEMCP\test-uemcp-gate.bat
```

**Expected**: `[PASS] D57 gate fired. TCP server was suppressed.`

**If [FAIL]**: stop, ping orchestrator with `%TEMP%\uemcp-gate-test.log` contents.

---

## §Part 2 — Editor launch + module verification (5 min)

### Step 2.1: Launch editor

Open `D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject` in UE 5.6.

### Step 2.2: Output Log verification

Open Window → Developer Tools → Output Log. Search for:

- [ ] `LogUEMCP: UEMCP: StartupModule entered`
- [ ] `LogUEMCP: UEMCP: TCP server listening on port 55558`
- [ ] **NO** `LogUEMCP: Error:` lines
- [ ] **NO** `LogUEMCP: Warning:` lines (other than startup diagnostic)

Record any unexpected output.

### Step 2.3: Remote Control plugin status

Edit → Plugins → search "Remote Control" → confirm:

- [ ] **Remote Control API** plugin is **Enabled**
- [ ] **Remote Control Web** plugin (if present) is **Enabled**

**If NOT enabled** (despite UEMCP.uplugin dep chain): tick enabled box → editor prompts for restart → restart. If after restart RC is still NOT enabled on next launch, **add `{"Name": "RemoteControl", "Enabled": true}`** to ProjectA.uproject Plugins[] array (P4 change — coordinate with teammates before submitting).

### Step 2.4: RC web server responding

In a browser: `http://localhost:30010/remote/info`

- [ ] Returns JSON with UE version info
- [ ] Non-empty body (not just `{}`)

**If connection refused**: Project Settings → Plugins → Remote Control → Web Remote Control → ensure "Start Web Server At Startup" is checked + "Web Server Port" is 30010. Restart editor if you changed either.

### Step 2.5: UEMCP TCP listening on 55558

In a separate cmd:

```cmd
netstat -ano | findstr :55558
```

- [ ] Shows LISTENING on the editor's PID (match via Task Manager)

**If nothing**: Output Log should have shown `UEMCP: failed to bind port 55558` — report that.

---

## §Part 3 — MCP tool verification via Claude Code (10-15 min)

Open Claude Code in your ProjectA workspace (`D:\UnrealProjects\5.6\ProjectA\` or wherever your `.mcp.json` lives).

### Step 3.1: Always-loaded sanity

Ask Claude:
```
list_toolsets
```

- [ ] Returns ~15 toolsets including offline, actors, blueprint-read, animation, materials, etc.
- [ ] No error envelopes

Then:
```
project_info
```

- [ ] Returns ProjectA info with UE version, project name, etc.

### Step 3.2: Pick ONE offline verb (S-B-base / Verb-surface territory)

```
enable_toolset blueprint-read
bp_list_entry_points asset_path:/Game/Blueprints/Character/BP_OSPlayerR graph_name:EventGraph
```

- [ ] Returns entries for ReceiveBeginPlay, ReceiveTick, etc.
- [ ] Each entry has `has_no_exec_in: true` (M-new precision)

### Step 3.3: Pick ONE M-enhance TCP handler (CP3 plugin)

```
is_pie_running
```

- [ ] Returns `{running: false}`
- [ ] No TCP error

### Step 3.4: Compile-and-report (CP3 flagship handler)

```
bp_compile_and_report asset_path:/Game/Blueprints/Character/BP_OSPlayerR
```

- [ ] Returns `{errors: [], warnings: [...], notes: [...], info: [...]}` shape
- [ ] Response includes compile status (success / error)
- [ ] Note any warnings reported (not a bug — just content state)

### Step 3.5: Pick ONE RC-backed tool (CP2 FULL-RC)

```
enable_toolset remote-control
rc_list_objects class_pattern:UWorld
```

- [ ] Returns array of UWorld instances (PIE world + editor world + loaded-level worlds)
- [ ] Each with an object path like `/Game/Levels/.../Map_Test.Map_Test:PersistentLevel.Map_Test`

### Step 3.6: Reflection walker (CP3 reflection_walk)

```
get_blueprint_variables asset_path:/Game/Blueprints/Character/BP_OSPlayerR
```

- [ ] Returns variables with full flag set: `Category`, `Replicated`, `EditAnywhere`, `BlueprintReadWrite` (etc.)
- [ ] More flags than RC's sanitize allowlist would permit (this validates the reflection-walk plugin handler specifically)

---

## §Part 4 — M-enhance Session 3+4 features (10 min)

### Step 4.1: Save-hook auto-sidecar write

Open any BP in the editor (e.g., `BP_OSPlayerR`). Make a trivial change (move a node 1 pixel), Ctrl+S.

Then in Windows Explorer: `D:\UnrealProjects\5.6\ProjectA\ProjectA\Saved\UEMCP\`

- [ ] Directory exists (created on first save-hook fire)
- [ ] Contains a `.sidecar.json` file for the BP you just saved
- [ ] Open the file; it contains `{schema_version: "narrow-sidecar-v1", ...}`

**If no file appears**: Output Log should have `LogUEMCP` entry about save-hook firing. Check Output Log for any save-hook error.

### Step 4.2: Content Browser context menu

Right-click BP_OSPlayerR in Content Browser:

- [ ] "Regenerate UEMCP Sidecar" menu item appears
- [ ] Clicking it shows a confirmation dialog
- [ ] Confirming triggers sidecar regen (check `Saved/UEMCP/` mtime updates)

### Step 4.3: Batch commandlet

Close editor first. Then:

```cmd
"C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject" -run=DumpBPSidecar -PathRoot=/Game/Blueprints/Character -Recursive -unattended -nop4 -nosplash
```

- [ ] Exits 0
- [ ] Multiple sidecar JSONs emitted under `Saved/UEMCP/` — one per BP under the path root
- [ ] No crash or unhandled error in the log tail

### Step 4.4: Visual capture (thumbnail render)

Reopen editor. Ask Claude:

```
enable_toolset visual-capture
get_asset_preview_render asset_path:/Game/Meshes/SM_Cube
```

(Use any known mesh path in your project if SM_Cube doesn't exist.)

- [ ] Returns an object with a base64-encoded PNG field
- [ ] Claude Code renders the PNG inline — should look like a thumbnail of the mesh

---

## §Part 5 — Negative-path sanity (5 min)

These should all return **FA-β graceful envelopes** — NOT raw errors.

### Step 5.1: Invalid asset_path

```
bp_compile_and_report asset_path:/Game/NonExistent/Fake
```

- [ ] Returns `{available: false, reason: "asset_not_found", ...}` or similar graceful envelope
- [ ] **NOT** a raw ENOENT or TCP error

### Step 5.2: Invalid node_guid

```
bp_trace_exec asset_path:/Game/Blueprints/Character/BP_OSPlayerR graph_name:EventGraph start_node_id:00000000000000000000000000000000
```

- [ ] Returns graceful envelope indicating node not found
- [ ] **NOT** a crash or unhelpful error

### Step 5.3: Non-existent RC object

```
rc_get_property object_path:/Game/Fake/DoesNotExist.Fake property_name:SomeProperty
```

- [ ] Returns graceful envelope with RC error context
- [ ] **NOT** raw HTTP 404

---

## §Part 6 — Stress-test spot checks (5 min, optional)

### Step 6.1: Large-BP exec trace

```
bp_trace_exec asset_path:/Game/Blueprints/Character/BP_OSPlayerR graph_name:EventGraph start_node_id:<valid-guid> max_depth:50
```

- [ ] Doesn't hang
- [ ] Returns within ~5s
- [ ] If chain >50 hops, stops at max_depth with truncation marker

### Step 6.2: Full BP compile

```
bp_compile_and_report asset_path:/Game/Blueprints/Level/BP_OSControlPoint
```

- [ ] Completes within ~5-15s (BP with 223 nodes; heavier compile)
- [ ] Returns diagnostic log

### Step 6.3: Large asset-registry scan

```
enable_toolset asset-registry
query_asset_registry class_names:Blueprint limit:50
```

- [ ] Returns up to 50 entries with pagination cursor
- [ ] Response size stays under MCP's token cap

---

## §Reporting back

After running through this checklist, report findings to orchestrator as:

**If everything green**: brief confirmation. Orchestrator marks smoke-test item shipped; M3/M4/M5 dispatchable.

**If anything red**:
- Which step failed
- What was expected vs what happened
- Any relevant Output Log / console output
- Severity impression (blocker vs annoyance vs cosmetic)

Orchestrator triages findings into follow-on dispatches or inline fixes.

**Specifically worth calling out for cross-transport transaction semantics / PIE teardown race** (FA-ε §Open 3, M-enhance §Biggest-unknowns 4):

- If you ran start_pie → stop_pie rapidly, note whether TCP responses arrived in order
- If you ran rc_set_property followed by a TCP edit on the same asset, note whether both appear in undo stack

These are the two "unknown" items the audit worker can't analyze without live editor.

---

## §Notes for future smokers

Keep this document as living reference for future M3/M4/M5 smoke cycles. When those waves ship, add §Part-X sections for each new wave's handlers + save-hook-like invariants.

The cadence: land code → audit workers find bugs → this human smoke finds integration bugs → fixes queue → next wave dispatches.
