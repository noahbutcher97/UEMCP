# M1 Worker — 3A TCP scaffolding (UEMCP plugin foundation)

> **Dispatch**: Fresh Claude Code session. Parallelizes with M2-Phase-A-offline (different file scope — `plugin/` C++ vs `server/` JS).
> **Type**: Implementation — first serious C++ plugin work. The `plugin/` directory is currently empty scaffold.
> **Duration**: 3-5 agent sessions.
> **D-log anchors**: D54 (SHIP-SIDECAR-PHASE-A-FIRST), D57 (M1 commandlet gate), D23/D40 (oracle retirement — M1 is the target plane).
> **Deliverable**: A loadable UEMCP plugin on TCP:55558 that responds to `ping` with clean request/response envelope. Scaffold only — tool commands are M3+.

---

## Mission

Establish the UEMCP C++ plugin foundation on TCP:55558. The plugin must:

1. Load into UE 5.6 editor alongside the existing UnrealMCP plugin (TCP:55557) without conflict.
2. Start `MCPServerRunnable` on port 55558 when editor launches — **except** when running as a commandlet (D57 constraint).
3. Provide the shared infrastructure for all subsequent TCP tool work: command registry, response envelope, validation, actor lookup, property handlers, transform parsing, structured logging.
4. Respond to `ping` command with a canned success response (smoke test — no real tool handlers in scope for M1).

**You are NOT** implementing any tool commands beyond `ping`. Every real tool (`actors.spawn_actor`, `blueprints-write.create_blueprint`, etc.) is M3+. M1's job is to make those future workers drop their tool handlers into a shipped infrastructure rather than bootstrap their own.

---

## Why this isn't deferred — a clarification for context

The M-alt spike (commit `44b080e`, D57) evaluated whether headless commandlet could defer M1 entirely. Verdict: **no.** M1 is writes-gated (35 tools in D52 category (w) — create_gameplay_effect, create_material, create_data_asset, etc.) plus the 32 transitional oracle-retirement tools. Commandlet serves reads, not writes. Reads coverage was 55% FULL / 36% PARTIAL via commandlet — below the threshold that would have justified deferring M1. The plan stands: M1 ships the writes foundation; M2-Phase-A's sidecar ships the reads foundation.

---

## Scope — in

### §1 Plugin structure

Create under `D:\DevTools\UEMCP\plugin\UEMCP\`:

```
plugin/UEMCP/
├── UEMCP.uplugin                 ← plugin manifest
└── Source/
    └── UEMCP/
        ├── UEMCP.Build.cs         ← module build rules
        ├── Public/
        │   ├── UEMCPModule.h      ← IModuleInterface
        │   └── Logging.h          ← LOG macros (UE_LOG wrappers)
        └── Private/
            ├── UEMCPModule.cpp
            ├── MCPServerRunnable.h/.cpp      ← TCP listener on 55558
            ├── MCPCommandRegistry.h/.cpp     ← handler registration + dispatch
            ├── MCPResponseBuilder.h/.cpp     ← P0-1 envelope helpers
            ├── ActorLookupHelper.h/.cpp      ← P0-2 + P0-3
            ├── PropertyHandlerRegistry.h/.cpp ← P0-4 macro + base handlers
            └── TransformParser.h/.cpp        ← P0-10
```

### §2 P0 quality upgrades (vs existing UnrealMCP reference)

Per `docs/specs/phase3-plugin-design-inputs.md`:

- **P0-1** — `BuildSuccessResponse(TSharedPtr<FJsonObject>&, const FJsonObject& data)` and `BuildErrorResponse(TSharedPtr<FJsonObject>&, const FString& message)`. Never emit ad-hoc `{"success":false,"message":...}` — always route through these.
- **P0-2** — `FindActorInAllLevels(const FString& Name, UWorld* World)` returns the actor across sublevels/world composition. UnrealMCP searches only the persistent level.
- **P0-3** — Actor name-or-label resolver: the same helper accepts either the actor's `GetName()` or `GetActorLabel()`. Ambiguity resolved by preferring Name.
- **P0-4** — `REGISTER_PROPERTY_HANDLER(PropertyType, HandlerFn)` macro + registry. M1 ships the macro + registry + scalar handlers (int/float/bool/string). Struct/vector/object handlers are empty placeholders M3+ fills per-command.
- **P0-9** — All command dispatchers null-check `params` before property access. If `params == nullptr`, return `BuildErrorResponse(..., "missing params object")`.
- **P0-10** — `TransformParser::Parse(const FJsonObject&, FTransform& OutTransform)` returns `bool` (true on success, false on malformed). No exceptions, no silent defaults.

Skipped for M1, deferred to M3+ where each tool's scope tells us what's needed:
- P0-5 (compile error reporting) — M3b blueprints-write scope
- P0-6 (FScopedTransaction) — M3 write-op scope
- P0-7 (widget path standardization) — M3c widgets scope
- P0-8 (valid binding function graph) — M3c widgets scope
- P0-11 (pin type validation) — M3b blueprints-write scope

### §3 D57 commandlet gate

**Critical constraint** per D57, discovered during M-alt spike:

`MCPServerRunnable` must start iff `!FApp::IsRunningCommandlet()`. The `FApp::IsRunningCommandlet()` check runs in `FUEMCPModule::StartupModule()` before binding the TCP listener. If true (we're running as a commandlet — e.g., the 3F-4 DumpBPGraphCommandlet), the module still loads but does NOT bind to port 55558. This prevents port contention when the same plugin loads in both interactive-editor and commandlet processes concurrently.

Existing UnrealMCP plugin lacks this gate (confirmed by M-alt spike log review). UEMCP ships it from day one.

### §4 Wire protocol

Per `docs/specs/tcp-protocol.md` + CLAUDE.md "TCP Wire Protocol":

- Connect-per-command pattern (no persistent connection). `MCPServerRunnable`'s accept loop handles one command per connection.
- Request JSON: `{"type": "<command_name>", "params": {...}}`. Field is `type`, not `command` (matches existing UnrealMCP for oracle compatibility during M3 transition; M3 handlers operate on the same wire).
- No length framing. Read until valid JSON parses (handled by UE's `FJsonSerializer`).
- Response: JSON object. Normalize error/success per §2 P0-1.
- Per-layer serialization handled by the MCP server's `CommandQueue` — M1 doesn't need to add cross-command locking, just a mutex on the command-registry dispatch if handlers share state.

### §5 Commands implemented in M1

**Only `ping`**. Returns `{"success":true,"data":{"message":"pong","server":"uemcp","port":55558,"version":"0.1.0"}}`. Smoke test for the MCP server's ConnectionManager to verify TCP:55558 connectivity.

Every other command returns via `BuildErrorResponse(..., "unknown command: <type>")`. M3+ fills in real handlers.

### §6 Testing

Two test layers:

**UE automation framework tests** (under `plugin/UEMCP/Source/UEMCP/Private/Tests/`):
- `ActorLookupHelper` — finding actors in persistent vs streaming levels (synthetic test map)
- `TransformParser` — valid/invalid JSON input cases
- `MCPResponseBuilder` — envelope shape invariants (success/error both have `success` field)
- `PropertyHandlerRegistry` — scalar type round-trips

Run via `UE Editor → Tools → Session Frontend → Automation` or headless via `UnrealEditor-Cmd.exe ... -run=RunTests -testfilter=UEMCP.`

**MCP server-side integration test** (in `server/`):
- New test file `server/test-m1-ping.mjs` (or extend `test-mcp-wire.mjs` if cleaner) — connects to TCP:55558, sends `ping`, asserts pong response shape.
- Gated on plugin being compiled + editor running. Skip gracefully if connection fails (not a test failure — just skip, log "M1 plugin not running").
- Baseline target: +~5-10 assertions over 825. Mark clearly as integration (not unit) — CI would skip unless the editor is running.

### §7 MCP server side

Update `server/connection-manager.mjs` layer table to add TCP:55558 if not already present:

```js
// Verify and add if missing:
LAYER_PORTS = {
  'tcp-55557': 55557,  // oracle / transitional
  'tcp-55558': 55558,  // UEMCP custom (M1+)
  // ...
};
```

Health check on 55558 should route through the same connect-per-command mechanism as 55557.

No tool registrations yet — those dispatch per-toolset when M3+ lands.

---

## Scope — out

- NO real tool command handlers (actor spawn, BP create, etc.) — that's M3a/M3b/M3c.
- NO save-hook, BP serializer, or DumpBPGraph commandlet — that's M2-Phase-A-plugin (dispatches after M1 lands).
- NO editor commands or UI (no toolbar buttons, no menus) — not in M1 scope.
- NO HTTP / Remote Control — Phase 4.
- NO deprecation of existing UnrealMCP (TCP:55557) — that happens at M3 oracle retirement.
- NO plugin dependency on UnrealMCP — UEMCP is standalone.
- NO Perforce integration — dev workflow only uses git for this repo.

---

## Reference files (required reading)

### Specs

1. `docs/specs/phase3-plugin-design-inputs.md` — P0-1 through P0-11 definitions. **Required reading** — M1 implements 6 of the 11; read them in full.
2. `docs/specs/conformance-oracle-contracts.md` — 36 existing UnrealMCP command contracts. M1 doesn't implement these, but understanding them shapes the registry design. Skim to understand the dispatch pattern M3 will use.
3. `docs/specs/tcp-protocol.md` — wire protocol.
4. `docs/specs/plugin-design.md` — overall plugin architecture decisions.

### Decision anchors

5. `docs/tracking/risks-and-decisions.md` — D23 (oracle as conformance source), D40 (post-oracle rebuild target), D54 (M-sequence anchor), D57 (commandlet gate constraint).

### Reference plugin (don't copy — rebuild with P0 fixes)

6. `ProjectA\Plugins\UnrealMCP\Source\UnrealMCP\` — reference for structure. Files with known P0 issues:
   - `MCPServerRunnable.cpp` — missing commandlet gate, no structured logging, ad-hoc error response
   - `UnrealMCPBlueprintCommands.cpp` — ad-hoc error envelopes, no pin-type validation, no transaction wrapping
   - `UnrealMCPActorCommands.cpp` — persistent-level-only actor lookup, no label resolution
   - `UnrealMCPUMGCommands.cpp` — 2 broken handlers flagged in tools.yaml

   **Don't import UnrealMCP source code directly** — UEMCP is a clean rebuild. Read for pattern-extraction only.

### CLAUDE.md (for project conventions)

7. CLAUDE.md §Shell & Tooling Requirements — Desktop Commander for git (shell: "cmd"), CMD not PowerShell, commit message workaround for multi-line.
8. CLAUDE.md §Code Standards — applies to server JS, but plugin C++ follows UE Coding Standard.

---

## UE 5.6 API references worth confirming

Use `mcp__context7__query-docs` or check UE source directly:

- `FRunnable` / `FRunnableThread` — async TCP accept loop pattern
- `ISocketSubsystem` / `FSocket` — TCP socket API on 5.6 (may have changed from 5.5)
- `FJsonSerializer` / `FJsonObject` — UE's built-in JSON
- `FApp::IsRunningCommandlet()` — check signature + early-availability (module startup phase)
- `IMPLEMENT_MODULE` macro — module-registration pattern on 5.6
- Automation framework — `IMPLEMENT_SIMPLE_AUTOMATION_TEST` vs `IMPLEMENT_COMPLEX_AUTOMATION_TEST` for M1's test coverage

Don't pre-verify every API before starting — verify inline as you write code.

---

## Success criteria

1. Plugin compiles cleanly in the ProjectA project without modifying UnrealMCP or any existing plugin.
2. Editor loads with both plugins active; TCP:55557 (UnrealMCP) and TCP:55558 (UEMCP) both listening, no port conflict.
3. `ping` roundtrip through MCP server's ConnectionManager on port 55558 returns the expected pong envelope.
4. All P0-1/2/3/4/9/10 helpers have automation tests with at least one positive + one negative case each.
5. Commandlet gate verified: run `UnrealEditor-Cmd.exe -run=NullCommandlet` (per M-alt spike Q1.2), confirm plugin module loads but does NOT bind port 55558. Log line for confirmation.
6. Server-side integration test skips gracefully when the editor is not running (no spurious test failures).
7. Test baseline on primary rotation stays ≥ 825 (integration test is supplementary, gated on editor).

---

## Constraints

- **Desktop Commander for git** (shell: "cmd") — `.git/index.lock` can't be acquired by sandbox bash.
- **Path-limited commit per D49** — commits must specify exactly the files touched. Example:
  ```cmd
  git commit plugin/UEMCP/UEMCP.uplugin plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs ... -m "M1: plugin scaffold + UEMCPModule"
  ```
- **Multiple commits OK** — split into logical units (scaffold commit, helpers commit, MCPServerRunnable commit, tests commit). Path-limited each.
- **No AI attribution** in commits.
- **Parallel with M2-Phase-A-offline** — that worker touches `server/sidecar-reader.mjs`, `server/test-sidecar-verbs.mjs`, `server/offline-tools.mjs`, `tools.yaml`. Your scope is entirely `plugin/UEMCP/` + possibly `server/connection-manager.mjs` + `server/test-m1-ping.mjs`. No collision.
- **No scope creep into M2-Phase-A-plugin** — save-hook, BP serializer, commandlet are NOT yours. Their handoff writes after M1 lands against the scaffold you ship.

---

## Final report to orchestrator

Report (keep under 400 words):
1. Commit SHAs (probably multiple — path-limited per unit of work).
2. What shipped: uplugin, Build.cs, module files, TCP runnable, command registry, all 6 P0 helpers.
3. Test baseline: primary rotation (825 or slightly higher with new integration test).
4. Editor compile-and-load status: both UnrealMCP and UEMCP plugins active simultaneously? port 55558 listening? ping roundtrip via MCP server?
5. Commandlet gate verified? (one `-run=NullCommandlet` invocation with log confirmation)
6. Any API surprises in UE 5.6 that required adjustment from UnrealMCP's pattern.
7. Scope items deferred/pushed to M2-Phase-A-plugin or M3 (things you noticed were needed but out of M1 scope).
8. Next action for orchestrator: M2-Phase-A-plugin handoff becomes dispatchable post-M1 landing.

If you hit a blocker (plugin won't compile, port won't bind, UE API changed), surface it immediately — don't spend more than a session fighting a single issue. Orchestrator can re-scope if needed.
