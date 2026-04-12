# Risks, Future Enhancements & Decision Log

## Risk Analysis

| Risk | Impact | Mitigation |
|------|--------|------------|
| Zod 4 crash | Server won't start | `import { z } from "zod/v3"` from day 1 |
| C++ plugin compile errors | No custom tools | Phase 3 is independent — server works with Phases 1-2 complete |
| RC API not enabled in ProjectB | 8 RC tools fail | RC tools return helpful error; 106 other tools still work |
| TCP 55558 port collision | Custom plugin unreachable | Configurable port via console variable |
| PowerShell blocked by policy | Auto-detection fails | Falls back to WMIC → manual UNREAL_PROJECT_ROOT |
| ProjectB team confused by new plugin | Team friction | Communicate via Confluence before submitting to P4 |
| Large actor lists exceed MCP limits | Truncated data | Pagination/limit params on list tools |
| GAS module not available in ProjectB | GAS tools fail | Conditional compilation: `#if WITH_GAMEPLAY_ABILITIES` |
| Hot reload breaks TCP thread | Plugin crash | FRunnable stop flag + socket cleanup in Deinitialize |
| `find_tools` returns wrong toolset | Claude enables irrelevant tools, wasting context | Weighted scoring with coverage bonus; auto-enable only top-scoring toolsets (not all partial matches). Manual `disable_toolset` as escape hatch. Tunable via alias map updates. |
| `tools/list_changed` not supported by client | Claude doesn't see newly enabled tools | Fallback: `find_tools` response includes full tool schemas for matches, usable even if client ignores notification. Document which MCP clients support dynamic tool lists. |
| Toolset auto-enable confusion | Claude enables too many toolsets, approaching tool limit | `list_toolsets` shows active count and warns when approaching 40-tool threshold. `disable_toolset` available. `find_tools` caps auto-enable at top 3 matching toolsets per query. |
| Alias map gaps | `find_tools` misses obvious queries | Ship with conservative alias set (18 entries). Expand per-project in Phase 6 step 41. Alias map is a flat JS Map — trivial to add entries without code changes. |
| D24 ad-hoc error detection fragile | UMG handler adds extra field to error response → false negative (error looks like success) | Current guard checks `resultKeys.length === 1`. All 18 UMG error sites return `{error: "msg"}` only — safe today. Phase 3 fix: normalize error format in C++ plugin (use CommonUtils::CreateErrorResponse consistently). If relaxing the JS guard, risk false positives on legitimate responses with informational `error` fields. |
| Base64 image exceeds stdio limit | `visual-capture` tools crash server | Enforce max resolution cap (1024×1024 default). JPEG fallback for screenshots. Warn in tool description about ~1MB stdio payload limit. |

### Audit-Discovered Risks (April 2026)

Surfaced during plan audit. Dispositions: **IMPLEMENT** (budgeted), **DEFER** (add if needed), **SKIP** (not worth the cost).

| Risk | Severity | Disposition | Mitigation |
|------|----------|-------------|------------|
| `run_python_command` arbitrary code execution | CRITICAL | **IMPLEMENT Phase 3** | Deny-list (`os.`, `subprocess`, `eval`, `exec`, `open`, `__import__`), confirmation dialog, execution logging. See D14. ~1.5 hrs. |
| ProjectB plugin distribution undefined | CRITICAL | **IMPLEMENT Phase 5** | PowerShell `sync-uemcp-plugins.ps1` copies git plugin → both project Plugins/ folders → P4 submit. Confluence page for team. ~1 hr. |
| `delete_asset` ignores dependency graph | WARNING | **IMPLEMENT Phase 3** | Query `IAssetRegistry::GetReferencers()` before delete. Refuse if hard refs exist unless `force=true`. Return referrer list. ~3 hrs. |
| TCP command race on shared socket | WARNING | **IMPLEMENT Phase 1** | Command queue: TCP thread enqueues (FCriticalSection), game thread dequeues one per tick. Node.js serializes outbound. ~2 hrs. |
| TCP timeout retry causes duplicate ops | WARNING | **IMPLEMENT Phase 1** | Request ID (SHA256 of command+params). Server + plugin cache results 5 min. Write ops deduplicated; reads are naturally idempotent. Included in command queue work. |
| TCP reconnection on editor close/reopen | WARNING | **IMPLEMENT Phase 2** | Simple retry-on-failure in ConnectionManager. Try connect, if fail, retry on next tool call. No exponential backoff needed for localhost. ~1.5 hrs. |
| Plugin dependency failures silent | WARNING | **IMPLEMENT Phase 1** | `list_toolsets` reports unavailable toolsets with reason + fix instruction. Query enabled plugins via TCP handshake. ~1 hr. |
| RC API port hardcoded to 30010 | WARNING | **DEFER** | Add `UNREAL_RC_PORT` env var override in .mcp.json. Default 30010. Port scan and config parsing deferred — not needed for known setups. ~0.5 hrs if triggered. |
| Reflected property writes without type validation | WARNING | **DEFER** | RC API does its own type coercion and returns errors. Wrap errors in clean messages. Full pre-validation cache deferred until RC API errors prove insufficient in practice. |
| No rate limiting on MCP requests | WARNING | **SKIP** | Claude sends one tool call at a time. Game thread naturally serializes. Not a real problem on localhost. Revisit only if editor hangs observed. |
| Concurrent RC API + TCP commands race | INFO | **SKIP** | Different transport layers, different threads. No shared state between HTTP and TCP paths. |
| No undo for property writes | INFO | **DEFER** | Snapshot-before-write undo queue is ~35 hrs for marginal value. Use editor Ctrl+Z instead. Revisit if bulk property writes become common. |

### UE5 API Verification (April 2026)

All 6 critical APIs confirmed present in UE5.6. No plan changes needed.

| API | Status | Notes |
|-----|--------|-------|
| `FTcpListener` | CONFIRMED | FRunnable-based, FTcpSocketBuilder fluent API. Networking module. |
| `IAssetRegistry::GetReferencers/GetDependencies` | CONFIRMED | Multiple overloads with dependency type filtering. AssetRegistry module. |
| `FRemoteControlModule` | CONFIRMED | HTTP + WebSocket, configurable ports. RemoteControl module. |
| `UEdGraph` / `UK2Node` | CONFIRMED | Full graph traversal via Nodes array + pin connections. BlueprintGraph module. |
| `GameplayAbilities` module | CONFIRMED | Plugin-based, enabled via .uproject. Correct module name. |
| `FKismetEditorUtilities::CompileBlueprint` | CONFIRMED | Delegates to FBlueprintCompilationManager. UnrealEd module. |

---

## Future Enhancements (Not in Initial Build)

1. **WebSocket Subscriptions** — RC API supports WebSocket for property change notifications. Could enable "watch" mode for live debugging.

2. **Niagara System Editing** — Create/modify particle systems. Requires Niagara editor module dependency.

3. **Physics Asset Editing** — Create/modify physics bodies and constraints. Requires PhysicsAssetUtils.

4. **Landscape Editing** — Height modification, material layers. Very specialized.

5. **Multi-Editor Port Negotiation** — If both editors bind 55557, the second fails. Could add port negotiation protocol.

6. **Wwise Integration** — Create/manage AkAudioEvent assets. Requires Wwise SDK in plugin dependencies.

7. **Sequencer/Level Sequence Editing** — Create/modify level sequences for cinematics. Requires Sequencer module deep integration.

8. **Behavior Tree Introspection** — Serialize UBehaviorTree assets (BTTask/BTDecorator/BTService nodes). Not currently used in ProjectA but useful for AI-heavy projects.

9. **Control Rig Graph Introspection** — Serialize UControlRig animation rigging graphs. Not currently used in ProjectA.

10. **MCP Resources** — Expose project metadata, asset catalogs, and build outputs as read-only MCP resources with URI-based access and subscriptions. Would enable efficient caching and Claude accessing project data without tool calls. High value, low effort. **Status: Deferred to Phase 1 end as optional polish (D21). Verify client support first.**

11. **MCP Prompts** — Define reusable prompt templates for common Unreal workflows ("create a GAS ability for X", "set up a combo chain with N hits"). Would standardize quality of Claude's output for repeated patterns. **Status: Deferred to Phase 4+ (D22). Depends on working tools.**

12. **MCP Logging** — Stream Unreal Editor diagnostic output (compilation, PIE, packaging) to Claude's UI with severity levels. Better visibility than text-only tool responses. **Status: Basic `logging: {}` capability included in Phase 1 (D19). Editor-specific log streaming deferred.**

13. **Asset Import Pipeline** — `import_static_mesh` and `import_skeletal_mesh` tools wrapping UE's FBX import. Would bridge Blender MCP output → Unreal, enabling model-in-Blender → import-to-UE workflows without manual editor interaction.

14. **Perforce Auto-Checkout** — Wrap `p4 edit` in a UEMCP tool that auto-checks out files before asset creation/modification. Eliminates bash context-switching during create workflows. Could be as simple as the server calling `p4 edit` before sending the create command to the plugin.

15. **Collision & Physics Toolset** — Physics material editing, collision preset management, constraint configuration. ProjectA uses physics extensively but has no dedicated toolset.

16. **Build/Cook/Package Automation** — Editor-side build triggering, cook status monitoring, package configuration. Important for CI/CD but not blocking for daily dev workflow.

17. **Skeletal Mesh & LOD Management** — Bone/socket manipulation, LOD configuration, physics asset bodies. Useful for character pipeline but low priority vs. GAS workflow.

---

## Decision Log

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | Node.js server | Consistency with 3 other MCP servers. Same SDK. Same `zod/v3` import pattern. |
| D2 | New C++ plugin, not modify existing | ProjectB team shares existing via P4. Zero disruption. |
| D3 | Auto-detection via process inspection | 95%+ reliability. No editor dependency. Works even if plugins crashed. |
| D4 | Separate TCP port (55558) | Avoids conflict with existing plugin (55557). Both run simultaneously. |
| D5 | Dynamic toolsets with progressive disclosure | 114 tools across 15 toolsets, loaded on demand. 6 always-loaded management tools. Hybrid of GitHub MCP Server's explicit toolsets and Speakeasy's progressive disclosure. Keeps active tools at 15-30 per task. |
| D6 | Leave old Python servers | May be tracked in P4. No conflicts. Clean up later with team coordination. |
| D7 | Full feature parity both projects | User requirement. Same plugin, same server, same tools. |
| D8 | GAS commands as highest priority | ProjectA is a GAS-heavy combat game. Most impactful for daily workflow. |
| D9 | RC Components plugin enabled | Data-driven preset system. Free capability with no downside. |
| D10 | Python Editor Script Plugin enabled | Enables `run_python_command` tool. Full `unreal` Python module access. Low-cost, high flexibility. |
| D11 | 6-phase implementation | C++ plugin is independent phase. Server works without it (Phases 1-2-4). |
| D12 | Geometry Script plugin enabled | Procedural mesh generation, CSG booleans, UV manipulation. Adds 4 geometry tools. |
| D13 | Slate Scripting not enabled | Read-only editor UI inspection — can't construct UI. UMG tools already handle UI creation. |
| D14 | `run_python_command` ships with deny-list + confirmation | Balances flexibility with safety. Deny-list blocks `os`, `subprocess`, `eval`, `exec`, `open`, `__import__`. Confirmation dialog required. All executions logged. Full sandboxing (Tier 2) deferred — overkill for solo dev on localhost. |
| D15 | ProjectB distribution via P4 (Option A) | Team benefits from expanded tools. Script copies git → P4. Matches existing UnrealMCP distribution pattern. Confluence page documents installation. |
| D16 | Defer RC API port discovery, rate limiting, property pre-validation, undo system | Over-engineered for solo dev on localhost. RC API validates types internally. Claude sends one call at a time. Editor Ctrl+Z covers undo. Revisit if real problems emerge during daily use. |
| D17 | Plain `.mjs` over TypeScript for MCP server | Matches existing MCP servers (jira-bridge, perforce, miro). No build step — edit and restart. Zod provides runtime validation where it matters (tool params). Trade-off: no IDE autocomplete on internal functions. Worth it for iteration speed with AI-assisted development. |
| D18 | Develop in `UEMCP/server/`, point `.mcp.json` at repo path | Avoids copy-to-`~/.claude/` friction during development. `.mcp.json` points directly at `D:/DevTools/UEMCP/server/server.mjs`. Defer copying to `~/.claude/` until distribution (Phase 5) if needed at all. |
| D19 | Include `logging: {}` capability from Phase 1 | Near-zero cost (~30 min). Enables `ctx.mcpReq.log()` in tool handlers for debugging auto-detection, TCP connections, toolset operations. Works with MCP Inspector. If Claude doesn't render logs, costs nothing. |
| D20 | Include server `instructions` string from Phase 1 | 15-minute effort. Guides Claude through `find_tools` → `enable_toolset` → use tools workflow. High value for correct dynamic toolset usage. |
| D21 | Defer MCP Resources to Phase 1 end (optional polish) | Resources duplicate management tools (`list_toolsets`, `detect_project`). Client support uncertain — Claude may not surface resources in UI. ~2 hrs effort. Add only after verifying client consumption. |
| D22 | Defer MCP Prompts to Phase 4+ | Prompt templates depend on working tools existing first. ~3-4 hrs effort for quality templates. Same outcome achievable through tool descriptions and `find_tools` response content. |
| D23 | UEMCP absorbs all tools onto TCP:55558; deprecate UnrealMCP dependency post-Phase 3 | Phase 2 uses existing UnrealMCP (TCP:55557) as a **conformance oracle** — validates TCP transport, command serialization, and tool contracts. Phase 3 reimplements those 26 tools (actors, blueprints-write, widgets) in the custom C++ plugin on TCP:55558, fixing issues found in the existing implementations and adding functionality beyond what UnrealMCP provides. Post-Phase 3: remap layer assignments in tools.yaml from `tcp-55557` to `tcp-55558`, remove TCP:55557 layer from ConnectionManager, drop UnrealMCP dependency entirely. Result: one plugin, one port, one codebase. Layer assignments for `actors`, `blueprints-write`, and `widgets` in tools.yaml are **transitional** — they read `tcp-55557` now because that's what serves them during Phase 2, but will flip to `tcp-55558` when Phase 3 absorbs them. |
| D24 | Handle UMG ad-hoc error format in ConnectionManager.send() | Oracle research (Section 4.4–4.6) found 3 UMG handlers return `{"error": "msg"}` without `"success": false`. The Bridge doesn't catch these — they arrive as `{"status": "success", "result": {"error": "msg"}}`. ConnectionManager.send() must check for `result.error` field even on successful status and throw. This is a universal fix, not per-tool. |
| D25 | Tool name → type string translation lives in TCP tool handlers, not ConnectionManager | tools.yaml uses shortened names (e.g., `get_actors` → `get_actors_in_level`). Translation is tool-layer concern, not transport-layer. Each tool handler maps its name to the C++ type string. ConnectionManager stays name-agnostic. |
| D26 | Drop `create_input_mapping` — legacy input, not worth exposing | Oracle Section 5.1: uses `FInputActionKeyMapping` (legacy input, not Enhanced Input). UEMCP already plans Enhanced Input tools in `input-and-pie` toolset for Phase 3. No tools.yaml entry needed. |
| D27 | Drop `add_widget_to_viewport` or mark as informational | Oracle Section 4.3: the C++ handler is a no-op that returns "use Blueprint nodes instead." Either remove from tools.yaml or rename to `get_widget_class_path` with description noting it's informational only. |
| D28 | `bDetailed` actor serialization is a Phase 3 enhancement | Oracle Section 6.4: `ActorToJsonObject(bDetailed)` never branches on the param — both modes return identical output. Phase 2 passes it through as-is. Phase 3 reimplementation adds component list, tag list, and display label when detailed=true. |
| D29 | Actor name-or-label resolution is a Phase 3 UEMCP plugin feature | Existing UnrealMCP uses `Actor->GetName()` (internal FName like `BP_OSControlPoint_C_0`) for all lookups. Users expect to use Outliner display names (Actor Labels like `BP_OSControlPoint2`). Phase 3 plugin adds: (1) `label` field to all actor JSON responses via `GetActorLabel()`, (2) `FindActorByNameOrLabel()` helper — tries FName first, falls back to label match, (3) `find_actors_by_name` matches against both name and label. Not worth modifying the conformance oracle (UnrealMCP) since it's deprecated post-Phase 3. |
