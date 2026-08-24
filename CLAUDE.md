# CLAUDE.md

This file provides guidance to Claude when working with code in this repository.

## Project Overview

**UEMCP** (Unreal Engine MCP) is a monorepo containing a Node.js MCP server and a C++ UE5 editor plugin that together give Claude full read/write access to Unreal Engine 5.6 projects. Built for a pair of private UE5 projects (**Project A** — primary/combat-game target — and **Project B** — secondary); tool itself is project-agnostic.

- **MCP Server**: `server/` — Node.js, ES modules (.mjs), MCP SDK 1.29.0, Zod 3
- **UE5 Plugin**: `plugin/` — C++ editor plugin for the active TCP:55558 layer
- **Tool Definitions**: `tools.yaml` — **single source of truth** for the registry: 149 YAML-declared tools (10 management + 139 toolset-scoped across 16 toolsets); 10 of the toolset-scoped entries are `status: planned` (hidden, not yet registered), leaving 139 active/callable tools
- **Repo Root**: `D:\DevTools\UEMCP\`
- **Version Control**: Git (NOT Perforce — unlike the UE projects themselves)

## Architecture — Active Runtime Layers

```
Claude ↔ MCP Server (stdio) ↔ active runtime layers:
  offline      — project-file reads after attachment
  tcp-55558    — UEMCP editor plugin commands
  http-30010   — Unreal Remote Control HTTP
```

`tools.yaml` defines active toolset ownership. Dated conformance-oracle documents are archival provenance only; they are not setup or runtime guidance.

## Dynamic Toolset System

149 declared / 139 active tools (see Project Overview above for the full breakdown) across 16 dynamic toolsets. Toolsets are enabled/disabled dynamically to stay under the ~40-tool accuracy threshold.

- `find_tools(query)` — keyword search, auto-enables top 3 matching toolsets
- `enable_toolset` / `disable_toolset` — explicit control
- `list_toolsets` — orientation tool, warns when >40 active tools
- Tools use SDK `handle.enable()`/`.disable()` for `tools/list` visibility — disabled tools are invisible to Claude, not just guarded at runtime

**ToolIndex search** (`tool-index.mjs`): 6-tier weighted scoring — FULL_NAME(100) > NAME_EXACT(10) > NAME_PREFIX(6) > NAME_SUBSTR(4) > DESC_EXACT(2) > DESC_PREFIX(1). Coverage bonus: `score × (0.5 + 0.5 × matched_token_ratio)`. Aliases from tools.yaml `aliases:` + hardcoded supplements.

## TCP Wire Protocol — Current Contract

This section and `docs/specs/architecture.md` describe the current runtime contract. `docs/specs/tcp-protocol.md` is an archival design snapshot, not current setup or runtime guidance.

- **Requests** — Node serializes `{ type, params }` as strict UTF-8 and sends `Content-Length: <bytes>\r\n\r\n<body>`. The plugin maps one typed intake result, accepts the framed form plus legacy unframed JSON for legacy compatibility, and dispatches only complete JSON objects. Node preflight and native intake enforce the same 8 MiB request limit. Framed request intake and framed response decode each enforce a 512-byte header limit.
- **Deadlines** — Server request intake starts at accept and enforces an independent 2-second idle deadline and 10-second total deadline. The Node response path uses the caller's `timeoutMs` as both a socket-inactivity backstop and an absolute Node deadline, so response trickle cannot extend the call indefinitely.
- **Responses** — The plugin emits one strict UTF-8, `Content-Length`-framed JSON response. The Node decoder accepts that current form and legacy unframed JSON during upgrade windows. The protocol imposes no response cap; large responses remain governed by the caller deadline, available memory, and the plugin's framed send deadline.
- **Errors and logs** — Active malformed, oversized, or timed-out request intake attempts a structured response with `MALFORMED_REQUEST`, `REQUEST_TOO_LARGE`, or `REQUEST_TIMEOUT`. Peer close, receive failure, and server shutdown do not attempt a response. Node transport failures use stable `TcpTransportError.code` values: `REQUEST_TOO_LARGE`, `MALFORMED_RESPONSE`, `NO_RESPONSE`, `INCOMPLETE_RESPONSE`, `RESPONSE_TIMEOUT`, and `SOCKET_ERROR`. Transport logs contain structural metadata (event, framing, byte counts, elapsed time, reason, and socket code where applicable), never raw request/response bodies, params, JSON envelopes, or payload previews.
- **Fixtures and platform proof** — `plugin/UEMCP/Resources/Tests/tcp-transport-cases.json` is the shared Node/native conformance fixture. The plugin descriptor declares Win64, Mac, and Linux, but current runtime evidence is Win64-only runtime proof; Mac/Linux support is declared-unverified until those platforms are built and exercised.

The connection manager serializes commands per layer, performs health checks, and caches eligible read operations.

## Sibling MCP Servers

UEMCP follows conventions from `~/.claude/mcp-servers/`:

| Server | Purpose |
|--------|---------|
| `jira-bridge` | Jira + Confluence |
| `perforce-bridge` | P4 read ops |
| `miro-bridge` | Miro boards |

All are single `server.mjs`, ES modules, stdio transport — same pattern UEMCP follows.

## Current State

### Implemented
- MCP server with stdio transport (`server/server.mjs`)
- Offline toolset declares 25 tools in `tools.yaml`
- `.uasset`/`.umap` binary parser (`server/uasset-parser.mjs`): FPackageFileSummary → name table → FObjectImport (40-byte UE 5.0+) → FObjectExport (112-byte) → FPackageIndex resolver → FAssetRegistryData → **Level 1+2+2.5 property decode** with UE 5.6 `FPropertyTypeName`/`EPropertyTagFlags` extensions, 12 engine struct handlers, TArray/TSet/TMap containers, tagged-fallback for unknown structs (D50). Pure JS, no UE dependency. Production-grade (zero errors on 19K+ files). **Multi-version: UE 5.3 / 5.6 / 5.7 / 5.8** — version-gated `EUnrealEngineObjectUE5Version` summary reads (incl. 5.7's `IMPORT_TYPE_HIERARCHIES`, D166). 5.8 needs no new summary gate: its UE5 version enum is identical to 5.7's, still topping out at `IMPORT_TYPE_HIERARCHIES` (1018). Summary + name/import/export table walk verified clean across whole 5.3 / 5.6 / 5.8 project corpora. **Known gap**: `readExportTable` carries no version gates and assumes the newest `FObjectExport` layout, so packages at UE5 version <=1010 desync after the first export (0% property yield; reproduced on 5.3 / 5.6 / 5.8 corpora alike, so this is an old-format gap, not an engine-version regression).
- ToolIndex, ToolsetManager, ConnectionManager (active-layer routing; `tcpCommandFn` mock seam for tests)
- 3-channel instructions: SERVER_INSTRUCTIONS (init), TOOLSET_TIPS (per-activation), tool descriptions
- Phase 2 TCP toolsets: actors (10), blueprints-write (27), widgets (7), plus M3 splits and M5 toolsets (animation, materials, input, geometry, editor-utility)
- RC HTTP toolsets including 11 FULL-RC tools (rc_* primitives + material/curve/mesh delegates per D66/D74/D76)
- D44: `tools.yaml` is the sole source for tool metadata; `tools/list` + `find_tools` report identical data
- Archival conformance research: `docs/specs/conformance-oracle-contracts.md` is not current setup or runtime guidance
- Test infrastructure: mock seam in ConnectionManager, FakeTcpResponder/ErrorTcpResponder, **7206 unit-runnable assertions project-less (higher with a real `UNREAL_PROJECT_ROOT`; see Fixture-project default) across 72 rotation test files** (D-log tracks per-milestone deltas — do not duplicate here)

### Follow-on queue
- **Parser extensions** — FExpressionInput native binary layout (deferred per D50), nested FieldPathProperty
- **Cleanup** — int64 VFX parse bug, semgrep deep refactor
- **3F sidecar writer** (editor plugin) — spec at `docs/specs/blueprints-as-picture-amendment.md`
- See `docs/tracking/backlog.md` for future-consideration items

### Not yet implemented
- 3F sidecar writer
- HTTP client for Remote Control API beyond current delegates (Phase 4)
- Distribution to Project B via P4 (Phase 5)
- Per-project tuning (Phase 6)

## File Layout

```
UEMCP/
├── CLAUDE.md
├── AGENTS.md                   ← generic coding-agent guide (structure/build/test conventions; parallels CLAUDE.md)
├── tools.yaml                  ← single source of truth for registry
├── manifest.json               ← plugin version lockstep source (paired with UEMCP.uplugin Version/VersionName)
├── .mcp.json.example           ← template Claude config
├── setup-uemcp.bat             ← onboarding: Node install + .mcp.json + plugin copy + .uproject deps
├── migrate-targets.bat         ← convert legacy .uemcp-targets.txt to JSON profiles
├── sync-plugin.bat             ← propagate plugin source to a target UE project
├── verify-deploy.bat           ← Q3-A pre-dispatch verification (D136)
├── setup-watcher.bat           ← Q3-C auto-deploy file-watcher (D136)
├── smoke-live.bat              ← opt-in live-editor smoke runner wrapper
├── .uemcp-targets.json.example ← template per-machine target profiles
├── server/
│   ├── server.mjs              ← MCP server entry, management tools
│   ├── offline-tools.mjs       ← offline tool handlers
│   ├── uasset-parser.mjs       ← .uasset/.umap binary parser (Level 1+2+2.5, D50)
│   ├── actors-tcp-tools.mjs    ← actors toolset TCP handlers
│   ├── blueprints-write-tcp-tools.mjs ← blueprints-write toolset TCP handlers
│   ├── widgets-tcp-tools.mjs   ← widgets toolset TCP handlers
│   ├── tool-index.mjs          ← search + scoring + alias expansion
│   ├── toolset-manager.mjs     ← enable/disable, SDK handle integration
│   ├── connection-manager.mjs  ← active routing, mock seam, ResultCache, MetricsAggregator
│   ├── verify-deploy.mjs       ← Q3 verify-deploy + watch helper (D136 + D138)
│   ├── sync-plugin-helper.mjs  ← W-L deploy-marker + per-workspace lock (D138)
│   ├── run-rotation.mjs        ← canonical rotation runner; FAIL-LOUD on import errors
│   ├── test-*.mjs              ← rotation test files (see Testing section for table)
│   └── test-helpers.mjs        ← FakeTcpResponder, ErrorTcpResponder, TestRunner
├── plugin/UEMCP/               ← C++ UE5 plugin
├── docs/
│   ├── specs/                  ← architecture, protocols, design
│   ├── plans/                  ← implementation phases, test strategy
│   ├── audits/                 ← point-in-time audit reports (never edit after creation)
│   ├── research/               ← parser survey, audit, design options
│   ├── handoffs/               ← orchestrator-authored dispatch documents (gitignored)
│   ├── reports/                ← worker return reports (gitignored)
│   └── tracking/               ← living docs: risks-and-decisions.md (D1+, growing)
└── .githooks/                  ← pre-commit + pre-push hooks (see Public-Repo Hygiene)
```

## Public-Repo Hygiene

This is a public repo; target projects are private under NDA. **Don't commit project codenames into tracked content.**

**NDA-gate scope is repo-write-only.** Forbidden-tokens, codename scrubbing, hooks, pre-push gate all govern what flows OUT of this repo to github.com. They do **NOT** restrict tool execution at runtime — UEMCP tools may operate at full capability against the user's own UE projects. If a worker declines a tool call citing "NDA" or "shared project" without a server-side gate (e.g., `--enable-python-exec` per D101), treat that as an opener-template defect.

**Placeholder vocabulary by file type**:

| File type | Use |
|-----------|-----|
| Config templates (`.mcp.json.example`) | Angle-bracket placeholder — `<UEMCP_REPO_PATH>`; setup script substitutes it at install |
| Shell command examples in tracked docs | `path/to/YourProject` (forward slashes, cross-shell) or `${UNREAL_PROJECT_ROOT}` |
| Narrative mentions | `Project A` / `Project B` / `the primary target` / `the secondary target` |

**Asset namespaces** (e.g., `BP_*`): intentionally retained as dev-time sanity references; NOT in the forbidden-tokens list. If asset-namespace classification ever changes, add specific prefixes per checkout.

**Project-specific session content** (handoffs, reports, audits, testing logs, research notes) lives in **gitignored** doc trees: `docs/handoffs/`, `docs/reports/`, `docs/audits/`, `docs/testing/`, `docs/research/`. Write freely there with full project specificity.

**Two hooks** (`.githooks/`, scan against `.git/info/forbidden-tokens` per-checkout, untracked):
- **`pre-commit`** — scans staged diff; also runs W-K anonymous-namespace duplicate-symbol guard (`node server/test-anon-namespace-audit.mjs --hook-mode`) when `plugin/UEMCP/Source/UEMCP/Private/*.cpp` is touched
- **`pre-push`** — scans outgoing commit range (file diff + commit messages)

Both block on match; bypass in emergencies with `--no-verify` (rare).

One-time setup on fresh clone: `git config core.hooksPath .githooks`, then populate `.git/info/forbidden-tokens` (one codename per line; `regex:<pattern>` for regex matches).

### Multi-agent orchestration handoff convention

**Dispatch mechanism — orchestrator drafts openers, user dispatches.** The orchestrator does NOT invoke `Agent` to spawn workers from inside its own conversation. It drafts a self-contained **conversation opener** for each worker; the user opens a fresh Claude Code conversation and pastes it. Applies to worker dispatches AND orchestrator-state migrations.

**Scope — heavyweight dispatches only.** This human-paste convention governs *heavyweight* worker dispatches: fresh ~200k-context sessions that ship commits and own a deployment cycle (`sync-plugin.bat` + `Build.bat` + editor relaunch), plugin C++ work, or anything that could leak codenames across the public boundary. It does NOT govern *lightweight, in-session* execution of a self-contained plan — e.g. local server-side `.mjs` test changes with no plugin/Build/deploy step — where dispatching `Agent`-tool subagents per task (with review between) from within the orchestrator's conversation is fine. The superpowers `subagent-driven-development` skill is the in-session path; `/dispatch-worker` is the heavyweight path.

**Why human-in-the-loop**: clean context per worker (~200k each), human gate at dispatch boundary (catches codename leaks / scope drift), deployment-cycle ownership (workers ship commits; user runs `sync-plugin.bat` + `Build.bat` + relaunches editor), parallelism without context contention.

**Two-channel codename pattern**:
- **Committed channel** (handoff docs in `docs/tracking/`, commit messages, D-log, README, CLAUDE.md, `docs/handoffs/*.md`): placeholder vocabulary only. Pre-push hook blocks codenames anyway.
- **Ephemeral channel** (inline openers, chat history): may include codenames for live-editor invocations and absolute paths.

**Receiving session translates codenames → placeholders before writing to disk.** Codenames stay in chat; placeholders go to committed files.

**Opener content checklist**:
1. Worker role + 1-line mission
2. Pointer to handoff doc at `docs/handoffs/<name>.md` (placeholder vocabulary)
3. Required pre-reads: D-log anchors, related handoff docs, prior-art commits
4. Codenames if needed (clearly delimited as ephemeral, with translate-to-placeholders reminder)
5. Constraints: D49 path-limit, D82 NDA-gate, no AI attribution, Desktop Commander for git, single-commit preference, report-length cap
6. Final-report format; worker-authored reports go to `docs/reports/`, NOT `docs/handoffs/`

Use `/dispatch-worker <doc> [--target <stem>]` to generate an opener following this structure.

**Worker reports are advisory**; orchestrator reconciles against current repo state and authors authoritative follow-up handoffs in `docs/handoffs/`.

**Validation discipline before drafting major handoffs (D129)**: when a workstream depends on an empirical claim AND costs >3 worker sessions, verify the claim is source-confirmed + reproduction-confirmed before drafting. Triggers requiring a 1-session validation audit:
- ≥2 prior hypotheses on the same problem have been falsified
- Claim rests on correlated observations vs source-reading + standalone reproduction
- Workstream involves migration / retirement / rewrite (not targeted fix)
- Orchestrator hedging across multiple dispatch options without empirical disambiguation

**Handoff draft pre-flight** (~10 min total, prevents D128-class misdirection):
1. **§0 prior-art search** — grep codebase for capabilities the implementation duplicates
2. **Empirical-claim status** — source-confirmed + reproduction-confirmed? If only correlation: validation audit first
3. **Build-system workaround check** — `bUseUnity = false`, `IWYU.MinSourceFiles = 0`, etc. are diagnostic; ask why before implementing on top
4. **Worker-session estimate calibration** — ~500 lines per worker session per `feedback_ai_worker_time_estimates.md`

Use `/handoff-preflight <doc>` to run this checklist automatically.

## Shell & Tooling Requirements

**Desktop Commander is MANDATORY for git and filesystem writes.** Cowork sandbox bash mounts the repo via a layer that can't acquire `.git/index.lock`. Use `mcp__Desktop_Commander__start_process` with `shell: "cmd"` for:
- Git operations (add, commit, status, diff, log, etc.)
- Filesystem writes that need to persist

Read operations (grep, glob, file reads) work fine through the sandbox.

**CMD, not PowerShell** — git and node are not in PowerShell's PATH. Always pass `shell: "cmd"`.

**Commit message workaround**: CMD mangles quoted strings. For multi-line commits, write to a temp file: `git commit -F file.txt && del file.txt`.

**Handoff documents must include this guidance** for any worker that does git operations.

### .bat script convention — pause-on-exit

**Every `.bat` script in this repo routes all exits through a single `:end` label that pauses unless `AUTO_YES=1`.** Double-clicking from Explorer closes the console instantly on `exit /b`; without a pause, errors disappear before the user can read them.

```cmd
@echo off
setlocal EnableDelayedExpansion
set "EXIT_CODE=0" & set "AUTO_YES=0"
REM ...arg parsing; -y / --yes → AUTO_YES=1...
REM ...script body; replace every `exit /b N` with `set "EXIT_CODE=N" & goto :end`...
set "EXIT_CODE=0" & goto :end
:end
echo.
if "!AUTO_YES!"=="0" ( echo [<script> exit code: !EXIT_CODE!] & pause )
endlocal & exit /b %EXIT_CODE%
```

`endlocal & exit /b %EXIT_CODE%` propagates EXIT_CODE past `endlocal` (immediate-expansion idiom). **Avoid nested `(...)` blocks with literal parens in echoes** — CMD tokenizes parens at load time, not execution time; an unescaped paren inside a nested block corrupts paren-balance of the whole block even on unreachable paths (D138-FIX worked example; flat `goto :label` only).

## Code Standards

- **ES Modules** (.mjs) — `import/export`, no CommonJS
- **No TypeScript** — plain JS with JSDoc (D17: iteration speed with AI-assisted dev)
- **Zod for validation** — built from tools.yaml at startup
- Functions under 50 lines where possible
- Early returns for validation
- Comment **intent**, not implementation
- **NEVER add AI attribution** — no `Co-Authored-By: Claude`, no "generated with AI" in commits
- **C++ shared helpers go in `Public/HandlerCommon.h` (or `Public/<feature>.h`)** — helpers used by >1 `Private/*.cpp` MUST live in a `Public/` header, not per-file anonymous namespaces. Unity-mode bundling fails with multiple-definition linker errors on duplicate anon-namespace symbols. `server/test-anon-namespace-audit.mjs` + `.githooks/pre-commit` (W-K, D139) block re-introduction. See D133/D135/D137 for worked examples.

## Key Design Rules

1. **tools.yaml is the single source of truth** — tool names, descriptions, toolset membership, aliases, params all defined there. Code loads from YAML at startup. Never hardcode tool definitions in server.mjs.

2. **SDK handles control visibility** — `server.tool()` returns a handle with `.enable()/.disable()`. ToolsetManager stores handles. Disabled tools don't appear in `tools/list` (SDK filters at mcp.js:68-69). Never use runtime guards to check toolset state in tool handlers.

3. **Offline tips go in SERVER_INSTRUCTIONS** — the offline toolset is always-on, so TOOLSET_TIPS never fires for it. Offline constraints (50 match cap, file type restrictions, progressive config drill-down) live in init instructions.

4. **TOOLSET_TIPS for dynamic toolsets only** — `{core, workflows[]}` structure. `workflows[]` entries have `requires[]` arrays for cross-toolset tips that only fire when all required toolsets are active.

5. **Aliases merge at build time** — tools.yaml `aliases:` is canonical. tool-index.mjs has supplementary defaults. `build()` merges YAML over defaults (YAML wins).

6. **Auto-enable capped at 3** — `find_tools` enables top 3 toolsets by highest-scoring tool. Prevents accidentally loading too many.

7. **Validate empirical claims before committing workstreams (D129)** — when a major workstream (>3 worker sessions) rests on an empirical claim, validate it before committing. Triggers requiring a 1-session validation audit: (a) prior hypotheses on same problem falsified, (b) claim from symptom + handler error rather than source/repro, (c) workstream cost large, (d) cheaper alternative explanations not ruled out. **`n=N` correlated observations are not root-cause.** Validation techniques in cost order: source-reading + grep, standalone reproduction harness (curl/postman), cross-test on minimal config, comparative dispatch. D128→D129 walk-back saved ~2.25 sessions. See `feedback_validate_claims_before_commitment.md`, `feedback_ufunction_decoration_precondition.md`, `feedback_orchestrator_codebase_state_drift.md`.

8. **Transport choice — RC delegates are valid; UFUNCTION targeting is mandatory** — UEMCP uses both **TCP:55558** (UEMCP plugin C++ handlers for productized tools) AND **HTTP:30010** (Remote Control for reflection-by-name primitives + HYBRID delegates per D66/D74/D76). RC works correctly when targeted at real UFUNCTION-decorated methods; returns "Function does not exist" for non-UFUNCTION C++ methods. Historical NEW-2/NEW-4 bugs were **UEMCP-induced** (calling `Set*ParameterValueEditorOnly` / `GetAll*ParameterInfo` — `ENGINE_API void`, not UFUNCTIONs — via UFUNCTION-dispatch path). **Standing rule**: verify `UFUNCTION` macro presence on RC delegate targets before shipping. If only a non-UFUNCTION C++ method exists, find the UFUNCTION wrapper (e.g., `UMaterialEditingLibrary::SetMaterialInstance*ParameterValue`); if no wrapper exists, write a TCP:55558 C++ handler.

## Common Tasks

### Canonical dev-cycle commands

Three project-scoped slash commands codify the high-frequency rituals (see `docs/specs/2026-05-19-dev-cycle-slash-commands-design.md`):

- **`/handoff-preflight <doc>`** — runs the 4-point pre-flight checklist (see **Handoff draft pre-flight** above). Soft advisory.
- **`/dispatch-worker <doc> [--target <stem>]`** — generates a worker-conversation opener following the 6-point **Opener content checklist** above. `--target` hydrates local target aliases from `.uemcp-targets.json` profiles or legacy `.uemcp-targets.txt`.
- **`/deploy-cycle [--target <stem>]`** — walks through verify-deploy → sync-plugin (auto) → Build.bat → editor relaunch → MCP restart → optional live smoke. See §Q3 dev-workflow scripts.

### Onboarding a new machine

Run `setup-uemcp.bat` from the repo root (no arg = GUI mode; arg = `.uproject` path for scripted use). The script: validates Node.js (winget → MSI fallback if missing), runs `npm install` in `server/`, generates `.mcp.json` at the Claude workspace root (auto-detected), physical-copies `plugin/UEMCP/` into `<project>\Plugins\UEMCP\`, enables required `.uproject` plugin deps (`RemoteControl`, `PythonScriptPlugin`, `GeometryScripting`; removes stale `Blutility` entries — `Blutility` is a module not a plugin), atomic-writes via PowerShell, auto-registers codenames in `.git/info/forbidden-tokens` (D124).

Exit codes: 0 success / 1 args / 2 npm / 3 .mcp.json / 4 plugin copy / 5 plugin-deps. Env `SETUP_AUTO_YES=1` skips prompts.

`PythonScriptPlugin` enables `run_python_command` which is itself gated by `--enable-python-exec` (D101).

For propagating plugin changes without full onboarding: `sync-plugin.bat <uproject>` (D64). Xcopies `D:\DevTools\UEMCP\plugin\UEMCP\` → target, excluding `Binaries\` + `Intermediate\`. Auto-busts deploy cache (`<dest>/Binaries/` + `<dest>/Intermediate/`) when `manifest.json` or `UEMCP.uplugin` Version changes (W-L deploy-marker, D138). Flags: `--force-clean`, `--no-marker`. Per-workspace editor-lock detection: matches running UnrealEditor CommandLine against `.uproject` full path (not stem) so two workspaces sharing a filename are tracked independently.

**Plugin versioning convention**: when `manifest.json version` bumps, also bump `UEMCP.uplugin Version` (integer; UE-internal rebuild signal) AND `VersionName` (string; aligned with manifest) in lockstep. W-L marker compares both → either triggers auto-bust.

Manual setup: copy `.mcp.json.example` to your Claude workspace root, substitute `<UEMCP_REPO_PATH>`, copy `.uemcp-targets.json.example` to local `.uemcp-targets.json` if repeated deploy/smoke profiles are needed, or run `migrate-targets.bat` to convert an existing `.uemcp-targets.txt`; run `npm install` in `server/`, restart Claude Code. Normal MCP startup attaches from unambiguous workspace roots or by `attach_project`; env-authoritative attachment requires explicit `UEMCP_PROJECT_ATTACH_MODE=env`.

### Q3 dev-workflow scripts — verify-deploy + setup-watcher (D136)

- **`verify-deploy.bat`** — pre-dispatch CLI. Reads `.uemcp-targets.json` profiles by default and falls back to legacy `.uemcp-targets.txt` when no structured config exists, reports per-target verdict (`SYNC` / `NEEDS-SYNC` / `NEEDS-BUILD` / `NEEDS-DEPLOY` / `MISSING`), detects UnrealEditor.exe processes locking each DLL via `Get-CimInstance Win32_Process` CommandLine introspection, flags workspace-resolution drift vs `.mcp.json`. Flags: `--profile <name>`, `--auto-sync`, `--regenerate-mcp-json N`, `--quiet`, `--targets <path>`, `--no-color`. Exit 0/1/2 = all-SYNC / non-SYNC / config-error.

- **`setup-watcher.bat`** — long-running file-watcher (Q3-C). Watches `plugin/UEMCP/Source/`; on change, debounces 500ms then runs `sync-plugin.bat <target> -y` per target. Ctrl+C stops cleanly. Backed by `server/verify-deploy.mjs --watch`.

Both are thin .bat wrappers around `server/verify-deploy.mjs`. The §2.6 D135 failure mode (editor running during Build.bat → DLL locked → silent no-op) surfaces as `[EDITOR-LOCKED]` with a clear "close before Build.bat" recommendation. Multi-workspace drift (MCP server pointing at A while editor runs in B) surfaces as `[MCP]` on the wrong target.

`/deploy-cycle` orchestrates these scripts end-to-end with stop-gates at manual steps (Build.bat, editor relaunch, MCP restart) and an optional `smoke-live.bat` pass after restart.

### Running the server locally
```bash
cd D:\DevTools\UEMCP\server
node server.mjs
```

For CLI compatibility tests that intentionally bypass workspace roots, use `UEMCP_PROJECT_ATTACH_MODE=env` with `UNREAL_PROJECT_ROOT`.

### Security flag — `--enable-python-exec` (D101)

`run_python_command` is the only tool that can execute arbitrary code in the editor. Defense-in-depth: Layer 1 server-side opt-in flag (off by default), Layer 2 plugin-side deny-list scan, Layer 3 per-call audit log. Without Layer 1, the tool returns `PYTHON_EXEC_DISABLED` before any wire dispatch.

```bash
node server.mjs --enable-python-exec
# or
UEMCP_ENABLE_PYTHON_EXEC=1 node server.mjs
```

Plugin layer scans for `os` / `subprocess` / `eval(` / `exec(` / `open(` / `__import__` and rejects with `PYTHON_EXEC_DENY_LIST` + matched pattern. Audit logs to `<UNREAL_PROJECT_NAME>.log` under `[UEMCP-PYTHON-EXEC]`. In `.mcp.json` env block: `"UEMCP_ENABLE_PYTHON_EXEC": "1"`.

### Adding a tool to an existing toolset
1. Add entry in `tools.yaml` under the toolset
2. If offline: implement in `offline-tools.mjs`, add case to `executeOfflineTool` switch
3. If TCP/HTTP: implement in the appropriate handler file
4. Register in `server.mjs` via `server.tool()`, capture handle, `handle.disable()`, register with ToolsetManager

### Adding a new toolset
1. Define in `tools.yaml` with `layer:` and `tools:` block
2. ToolIndex picks it up at `build()` time
3. Add TOOLSET_TIPS entry if cross-toolset workflows exist
4. Register all tools in server.mjs (capture handles, start disabled)

### Adding an alias
Add to `tools.yaml aliases:`. Merged into ToolIndex at build time.

## Known Issues & Deferred Work

- **M4**: `searchGameplayTags` rebuilds full hierarchy for flat list (perf only)
- **L1**: No TCP reconnection retry (Phase 2 scope)
- **L2**: No graceful fallback across layers (Phase 4 scope)
- **L3**: Write-op deduplication not implemented (Phase 2 scope)
- **L4**: MCP Resources deferred (D21)

See `docs/tracking/risks-and-decisions.md` for the full risk table and D-log (D1+, growing). D-log entries D78-D144 catalog 30+ UE 5.6 plugin-development institutional-memory items (module-vs-plugin per D110, deprecation paths per D93/D102, link-time module deps per D111, parameter-association struct gotchas per D105, Python plugin runtime gates per D107). Search `(extends D78/...)` in the D-log to follow chains.

## Operational Limits

### WebRemoteControl — FIXED-AT-SOURCE (D130/D131)

**NEW-2 root cause**: `WebRemoteControl.cpp:930` UE 5.6.1 engine bug — missing `Passphrase` HTTP header triggers `TMap::operator[]` auto-insertion → downstream `FindChecked` assertion → editor crash. **Workaround in `connection-manager.mjs:126`**: send `Passphrase: <any-value>` header on `/remote/batch` (or all `/remote/*` for defense-in-depth). RC permissive auth accepts any non-empty string. Empirically validated n=4 vs n=4. Full forensics in D-log D118-D131 + `feedback_passphrase_header_gotcha.md`.

**NEW-9 (editor-readiness probe) — FIXED-AT-SOURCE (D131)**: TCP plugin's `Listen()` is gated behind `FCoreDelegates::OnFEngineLoopInitComplete` in `UEMCPModule.cpp:139`. Pre-init connections receive ECONNREFUSED from the OS (not a UEMCP handler) until editor finishes init. Connect-per-command pattern in `connection-manager.mjs` makes this transient — `send()` does not mutate `LayerStatus` on rejection, so next command opens a fresh socket and succeeds once init completes. Collapses 5 audit classes structurally. Commandlets (e.g., DumpBPGraphCommandlet) early-return from `StartupModule` before registering the lambda — pre-W1 commandlet behavior preserved.

**Behavior under fresh launch**: during the ~5-30s pre-init window (depending on project size + AR scan), TCP:55558 commands return `connect ECONNREFUSED 127.0.0.1:55558` — this is **expected, not a failure**; retry on the next user prompt and it will succeed once init completes. Don't start a deep diagnosis on the first ECONNREFUSED. `get_editor_state` (`EdgeCaseHandlers.cpp:32`) is the canonical readiness signal: a successful round-trip confirms the listener is bound; also useful mid-session to detect PIE start/stop or level-reload world-context shifts.

**Outliner-display-name (NEW-9b)**: 7 SpawnActor sites in plugin set `SpawnParams.Name` (internal FName) but never call `SetActorLabel()`, so actors appear under class name in outliner. Tracked in W2 (`docs/handoffs/cleanup-m5-residue.md` §3); independent of timing.

### Per-tool TCP timeout overrides — retained (D118/D121/D125/NEW-7)

Three asset-mgmt handlers (`duplicate_asset` / `rename_asset` / `delete_asset_safe`) and two widget-property handlers (`bind_widget_event` / `set_text_block_binding`) routinely run >5s on the GameThread. The default-timeout error was a **silent-success-on-disk trap** — operation completed server-side but JS caller saw timeout and retried, causing double-rename/delete corruption.

**Fix**: per-toolset `*_TIMEOUT_OVERRIDES` tables — 15s ceiling for asset-mgmt (`server/m5-editor-utility-tools.mjs M5_EDITOR_UTILITY_TIMEOUT_OVERRIDES`), 10s for widget-property (`server/widgets-tcp-tools.mjs WIDGETS_TIMEOUT_OVERRIDES`). Flows through `connectionManager.send(layer, type, params, { timeoutMs })`. Default `config.tcpTimeoutMs` is 10s (E-1 §5, D140; was 5s pre-D140).

Deferred: widget compile-on-write candidates (D126 Class C), `tools.yaml timeout_ms:` centralization, async-job model for batch UX.

### Cache-invalidation — W6 Phase 1 shipped (D165)

`ResultCache` (in `connection-manager.mjs`) keys by SHA-256 of `(type, params)` with 5min TTL. Read-ops cache; write-ops `skipCache: true`. **W6 Phase 1 (D165): a successful write-op now clears the read cache** (`_invalidateReadCacheOnWrite`, called from both `send()` and `sendHttp()` after the wire-error check). This closes the D126 audit Class I.2 stale-read-after-write bug — read-modify-read no longer sees pre-mutation data.

The bust is **broad** (clears all read entries; TCP + RC share `_cache`), not per-asset. The surgical per-tool declarative `invalidates:` refinement (hit-rate preserving) is deferred to W6 Phase 2 — `docs/handoffs/w6-cache-invalidation.md`; only worth it if EN-23 metrics show the broad bust hurts hit-rate. Failed writes don't churn the cache (clear fires only on success).

### E-1 connection-layer hygiene + EN-23 metrics (D140)

Five hygiene fixes shipped together:
- **§1 Length-framed wire** (`Content-Length:` LSP/DAP convention) for the UEMCP TCP transport; auto-detect on incoming
- **§2 Event-driven accept loop** — `MCPServerRunnable.cpp` Run() uses `WaitForPendingConnection(500ms)` instead of `Sleep(0.05f)`
- **§3 Event-driven recv** — `ServeOneConnection` uses `Wait(WaitForRead, 50ms)` instead of `Sleep(0.01f)`
- **§4 Loopback-only bind** — listener on `FIPv4Address::InternalLoopback` (127.0.0.1), not 0.0.0.0; bound in `UEMCPModule.cpp:47-50` (not `MCPServerRunnable.cpp`); security hardening
- **§5 Timeout reconciliation (historical and superseded)** — D140 changed `tcpTimeoutMs` from 5000 to 10000ms and plugin `PerConnectionTimeoutSec` from 5.0 to 10.0. That single plugin timeout model is historical and superseded: the current plugin transport enforces an independent 2-second idle deadline and 10-second total request-intake deadline, plus a distinct 10-second response-send deadline.

**EN-23 metrics aggregator** — `MetricsAggregator` in `connection-manager.mjs` collects per-call timings, cache hits, framed counts. Default-OFF (cheap no-op). Opt-in via `.mcp.json` env: `UEMCP_METRICS_EMIT_EVERY_N=100` (stderr summary) or `UEMCP_METRICS_LOG=<path>` (JSONL append, best-effort). `ConnectionManager.getMetrics()` exposes the data.

**Bench script** — `server/_bench-transport-spike.mjs` (underscore = test-only). Direct-TCP probe with per-phase hrtime; bypasses MCP-SDK + ConnectionManager.

### RC mitigation flags (D123) — NOT recommended post-D131

Three opt-in env flags (`UEMCP_RC_RECYCLE_AFTER_N`, `UEMCP_RC_RATE_CAP`, `UEMCP_RC_RELAUNCH_HINT_AFTER_N`) shipped against the then-presumed sustained-traffic NEW-2 hypothesis. Hypothesis was falsified by D125+D131. **Not recommended for general use post-fix**. `RELAUNCH_HINT_AFTER_N=15` retains marginal value as a session-length signal; the other two change connection-level shape with zero crash-prevention benefit. Implementation kept in case a future n=4+ reproduction surfaces a different connection-state corruption.

## Testing

Test cases defined in `docs/plans/testing-strategy.md` (Tests 1-43). **7206 unit-runnable assertions project-less (higher with a real `UNREAL_PROJECT_ROOT`; see Fixture-project default) across 72 rotation test files** (D-log tracks per-milestone deltas; do not duplicate the cadence list here). `test-m1-ping` is live-editor-gated and excluded from rotation count.

### Rotation Runner — FAIL-LOUD on Import Errors

`server/run-rotation.mjs` is the canonical rotation runner. Enumerates `server/test-*.mjs` (excluding library helpers + live-gated `test-m1-ping`), spawns each as an isolated `node` subprocess, parses `Passed/Failed/Total` from stdout, produces single authoritative aggregate.

```bash
cd D:\DevTools\UEMCP\server
node run-rotation.mjs             # standard
node run-rotation.mjs --json      # machine-readable
node run-rotation.mjs --snapshot  # writes .test-rotation-snapshot.json
npm test                          # equivalent
```

For supplementary rotation (fixture-backed tests), prefix with `set UNREAL_PROJECT_ROOT=path/to/YourProject&& ` (no space before `&&`).

**FAIL-LOUD on import errors** (closes D104 silent-zero meta-finding): subprocess outcomes classified as `PASS`, `SKIPPED` (live/env-gated), `ASSERTION_FAILED`, `IMPORT_ERROR`, `CRASHED_NO_SUMMARY`, or `NO_SUMMARY_PARSED`. Any non-PASS/non-SKIPPED bucket exits non-zero with attribution. The historic silent-zero where deleted-barrel import errors masqueraded as 0/0 is structurally impossible against this runner.

### Fixture-project default — `resolveProjectRoot()`

`server/test-helpers.mjs resolveProjectRoot()` returns `UNREAL_PROJECT_ROOT` when set, else the committed text fixture `server/fixtures/uemcp-fixture/` (generic, NDA-safe: `.uproject` + `Config/*.ini` + `Source/*.Target.cs`). `test-phase1` and `test-mcp-wire` adopt it, so their project-gated **offline** assertions (project_info, gameplay-tags, list_plugins, list_data_sources, get_build_config, list_config_values) run everywhere — locally and on a project-less CI runner — against the fixture. `test-phase1` is therefore no longer "needs no env": it exercises offline tools against the fixture by default, so aggregate counts vary with project presence (fixture vs real). Binary-asset assertions gate on a real asset existing (`HAS_REAL_ASSETS` in test-phase1) and skip against the fixture; a real `UNREAL_PROJECT_ROOT` runs them. The other supplementary files keep reading the env directly and skip when unset. Binary-asset CI coverage is deferred to Phase 2 (`docs/specs/2026-05-23-generic-fixture-project-design.md`); the `rotation` GitHub workflow inherits this default.

### Test Files — Primary Rotation

Individually notable files, plus grouped rows for related suites (kept compact — see D-log for per-milestone provenance rather than duplicating it here):

| File | Purpose |
|------|---------|
| `test-phase1.mjs` | Offline tools, ToolIndex, toolset enable/disable, handler fixes, Option C + L3A S-A + EN-2 + W-O autoEnabled |
| `test-mock-seam.mjs` | Mock seam, cache, error normalization, queue serialization, length-framing, MetricsAggregator |
| `test-tcp-tools.mjs` | Phase 2 TCP — blueprints-write only post M3-bpw split; name translation, params, caching, port routing |
| `test-mcp-wire.mjs` | MCP-wire integration; in-process McpServer + FakeTransport; Zod-coerce, D44 invariant, tools/list_changed |
| `test-rc-wire.mjs` | RC HTTP wire-mock; 11 FULL-RC tools + cross-transport consistency (D74+D76) — runs project-less, not gated on `UNREAL_PROJECT_ROOT` |
| `test-verify-deploy.mjs` | Q3-A pure-helper: parseTargetsFile, classifyDeployState 9-case matrix, formatAge, normalizePath, extractUprojectFromCommandLine, applyMarkerVerdictOverlay |
| `test-sync-plugin-helper.mjs` | W-L pure-helper: compareDeployMarker 7 branches, readDeployMarker/writeDeployMarker round-trip, computeIncomingState |
| `test-anon-namespace-audit.mjs` | W-K Layer 3 — heuristic-regex scan asserting 0 anon-namespace duplicate-symbol collisions across `Private/*.cpp`; `--hook-mode` for pre-commit |
| `test-plugin-manifest.mjs` | Plugin static validation (no UE build, D164) — `UEMCP.uplugin` JSON + required fields, `manifest.json`↔`.uplugin` VersionName lockstep, `UEMCP.Build.cs` gross structure; runs in hosted CI |
| `test-m3-actors.mjs`, `test-m3-blueprints-write.mjs`, `test-m3-widgets.mjs` | M3 per-toolset TCP suites mirroring `test-tcp-tools.mjs`'s pattern for the actors/blueprints-write/widgets splits (D96/D97) |
| `test-m5-animation.mjs`, `test-m5-editor-utility.mjs`, `test-m5-geometry.mjs`, `test-m5-input-pie.mjs`, `test-m5-materials.mjs` | M5 toolset suites — one file per M5 toolset |
| `test-project-context.mjs`, `test-project-guard.mjs`, `test-project-hygiene.mjs`, `test-project-identity.mjs`, `test-project-server-wire.mjs`, `test-project-targets.mjs`, `test-project-tools.mjs`, `test-editor-processes.mjs` | D177 project-attachment suite — one file per split attachment module (`project-context.mjs` etc.) |
| `test-live-smoke-harness.mjs`, `test-run-live-smoke.mjs` | D177 reusable live-smoke harness + runner; assertions exercise the harness/runner logic itself (editor optional, unlike live-gated `test-m1-ping.mjs`) |
| `test-oracle-freshness.mjs`, `test-rotation-oracle-freshness.mjs` | D187 oracle-freshness gate — stale-fixture classifier plus rotation-output surfacing of non-strict freshness counts |
| `test-blueprint-workflow-variables.mjs`, `test-class-resolution-audit.mjs`, `test-connection-reset.mjs`, `test-mcp-fake-transport.mjs`, `test-migrate-targets.mjs`, `test-new-2-mitigation.mjs`, `test-pie-runtime-tools.mjs`, `test-plugin-get-editor-state-source.mjs`, `test-setup-uemcp-target-profile.mjs`, `test-slash-command-anchors.mjs`, `test-sync-plugin-bat-safety.mjs`, `test-tool-metadata.mjs`, `test-tool-registry-truth.mjs`, `test-tool-requirements.mjs`, `test-verify-deploy-profiles.mjs`, `test-visual-capture-source.mjs` | 16 focused single-topic suites, one area each (see filename) |
| `test-helpers.mjs` | Shared infra — not a runner. Exports: FakeTcpResponder, ErrorTcpResponder, TestRunner, createTestConfig, resolveProjectRoot |
| `test-fixtures.mjs` | Shared fixture constants — not a runner. Live-project asset-path constants (BP names, montages, maps) for supplementary-rotation tests; see file header for drift/fix guidance |

### Test Files — Supplementary Rotation (require UNREAL_PROJECT_ROOT)

| File | Purpose |
|------|---------|
| `test-uasset-parser.mjs` | Parser format + Level 1+2+2.5 + tagged-fallback (D50) + synthetic containers. Optional `UEMCP_VFX_FIXTURE_RELPATH` for int64 salvage test |
| `test-offline-asset-info.mjs` | `get_asset_info` shape + cache + indexDirty |
| `test-query-asset-registry.mjs` | bulk scan, pagination, truncation, tag filtering |
| `test-inspect-and-level-actors.mjs` | `inspect_blueprint` + `list_level_actors` export-table walking (F2 regression guard) |
| `test-s-b-base-differential.mjs` | S-B-base pin-block parser differential vs Oracle-A-v2 (6 fixtures, D70) |
| `test-verb-surface.mjs` | M-new 5 offline traversal verbs + oracle cross-check (3 fixtures, D72) |

**Note**: `set` command must have NO space before `&&` or CMD adds a trailing space to the env var.

### Mock Seam Pattern

`ConnectionManager` accepts `config.tcpCommandFn` — `(port, type, params, timeoutMs) => Promise<object>` — replacing real TCP. Enables unit-testing TCP handlers without a running editor. `FakeTcpResponder` for canned responses; `ErrorTcpResponder` for failure modes (timeout, ECONNREFUSED, error_status, success:false, invalid_json).

### API Gotchas for Test Authors

- `toolIndex.getToolsetTools(name)` returns `{toolName, description, layer}[]` — NOT strings
- `ToolsetManager` constructor: `(connectionManager, toolIndex)` — order matters
- `enable()` returns `{enabled, alreadyEnabled, unavailable, unknown}`; `disable()` returns `{disabled, wasNotEnabled, unknown}`
- No `getState()` — use `getEnabledNames()`
- Offline tool params are snake_case: `file_path`, `file_filter`, `config_file` (full filename with `.ini`)

## MCP Configuration Files

UEMCP is referenced from `.mcp.json` files in each UE project root; update when UEMCP server args or env vars change.

- **Project A** / **Project B**: per-project workspace roots or session-local `attach_project` target; use env-mode only for compatibility tests
- **Template**: `.mcp.json.example` at the UEMCP repo root

In Cowork mode (Claude Desktop), config lives in `claude_desktop_config.json` and servers get project-specific name prefixes.

## Related Projects

- **Project A**: primary target (combat game) — Perforce
- **Project B**: secondary target (BreakOut-style) — separate Perforce depot
- **NodeToCode-main**: BP-to-code plugin, not part of UEMCP

## Documentation Reading Order

**First read**: `docs/specs/architecture.md` → `docs/specs/plugin-design.md` → `docs/specs/dynamic-toolsets.md` → `tools.yaml` → `docs/plans/implementation.md`

**Quick reference**: `tools.yaml` → `docs/specs/dynamic-toolsets.md` → `docs/tracking/risks-and-decisions.md`

**Archival Phase 2 reference**: `docs/specs/conformance-oracle-contracts.md` -> `docs/specs/tcp-protocol.md` -> `docs/plans/testing-strategy.md` (Tests 9-13 + Lessons Learned; not current runtime guidance)
