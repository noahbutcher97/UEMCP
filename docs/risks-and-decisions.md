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
