# CLAUDE.md

This file provides guidance to Claude when working with code in this repository.

## Project Overview

**UEMCP** (Unreal Engine MCP) is a monorepo containing a Node.js MCP server and a C++ UE5 editor plugin that together give Claude full read/write access to Unreal Engine 5.6 projects. Built for a pair of private UE5 projects (referred to internally as **Project A** — the primary/combat-game target — and **Project B** — secondary); the tool itself is project-agnostic.

- **MCP Server**: `server/` — Node.js, ES modules (.mjs), MCP SDK 1.29.0, Zod 3
- **UE5 Plugin**: `plugin/` — C++ editor plugin (Phase 3, not yet implemented)
- **Tool Definitions**: `tools.yaml` — **single source of truth** for all 127 tools (6 mgmt + 121 across 16 toolsets; per Gauntlet V40)
- **Repo Root**: `D:\DevTools\UEMCP\`
- **Version Control**: Git (NOT Perforce — unlike the UE projects themselves)

## Architecture — 4-Layer Connection Model

```
Claude ↔ MCP Server (stdio) ↔ 4 layers:
  Layer 1: Offline     — disk reads (Source/, Config/, .uproject)     ✅ Phase 1 DONE
  Layer 2: TCP:55557   — existing UnrealMCP plugin (actors, BP write) Phase 2
  Layer 3: TCP:55558   — custom UEMCP C++ plugin (GAS, introspection) Phase 3
  Layer 4: HTTP:30010  — Remote Control API (property get/set)        Phase 4
```

**D23 (key decision)**: UEMCP will absorb ALL tools onto TCP:55558 post-Phase 3. The existing UnrealMCP plugin (TCP:55557) is used as a **conformance oracle** during Phase 2 to validate TCP transport patterns, then deprecated. Layer assignments for `actors`, `blueprints-write`, `widgets` in tools.yaml are **transitional** — they'll flip from `tcp-55557` to `tcp-55558` when the custom plugin reimplements them.

## Dynamic Toolset System

127 tools across 16 toolsets + 6 always-loaded management tools. Toolsets are enabled/disabled dynamically to stay under the ~40 tool accuracy threshold.

- `find_tools(query)` — keyword search, auto-enables top 3 matching toolsets
- `enable_toolset` / `disable_toolset` — explicit control
- `list_toolsets` — orientation tool, warns when >40 active tools
- Tools use SDK `handle.enable()`/`.disable()` for `tools/list` visibility — disabled tools are completely invisible to Claude, not just guarded at runtime

### ToolIndex Search (tool-index.mjs)

6-tier weighted scoring: FULL_NAME(100) > NAME_EXACT(10) > NAME_PREFIX(6) > NAME_SUBSTR(4) > DESC_EXACT(2) > DESC_PREFIX(1). Coverage bonus: `score × (0.5 + 0.5 × matched_token_ratio)`. Aliases loaded from tools.yaml `aliases:` section + hardcoded supplements.

## TCP Wire Protocol (Conformance Oracle Reference)

The existing UnrealMCP plugin (TCP:55557) uses a connect-per-command pattern that our ConnectionManager mirrors:

- **Connect → Send → Read → Close** per command (no persistent connection)
- **Request format**: `{"type": "<command_name>", "params": {...}}` — note the field is `type`, NOT `command`
- **No newline terminator** on request (matches the Python server's behavior)
- **Response**: JSON object, parsed by accumulating chunks until valid JSON. No length framing.
- **Error responses**: Two formats exist — `{"status": "error", "error": "msg"}` and `{"success": false, "message": "msg"}`. ConnectionManager normalizes both.
- **Serialized per-layer**: CommandQueue ensures one in-flight command per TCP layer; different layers execute in parallel.
- **Health check**: Sends `ping` command with 3s timeout. Results cached for 30s.
- **Read-op caching**: ResultCache (SHA-256 keyed, 5min TTL) for repeat queries. Write-ops should set `skipCache: true`.

The UEMCP custom plugin (TCP:55558, Phase 3) will use the same wire protocol initially but may evolve it (e.g., adding length framing) once we control both ends.

## Sibling MCP Servers

UEMCP follows conventions established by existing MCP servers at `~/.claude/mcp-servers/`:

| Server | Path | Purpose |
|--------|------|---------|
| `jira-bridge` | `~/.claude/mcp-servers/jira-bridge/server.mjs` | Jira + Confluence (Atlassian) |
| `perforce-bridge` | `~/.claude/mcp-servers/perforce-bridge/server.mjs` | P4 read operations |
| `miro-bridge` | `~/.claude/mcp-servers/miro-bridge/server.mjs` | Miro board access |

All are single `server.mjs` files, Node.js ES modules, stdio transport — same pattern UEMCP follows (D1, D17). In Cowork mode, these run with project-specific prefixes (e.g., `jira-<project>`, `perforce-<project>`).

## Existing UnrealMCP C++ Plugin Structure

The conformance oracle (at `<PROJECT_ROOT>\Plugins\UnrealMCP\` in our development environment) has this structure (relevant for Phase 2/3):

- `MCPServerRunnable` — `FRunnable`-based TCP listener on port 55557
- Command files (the pattern we'll replicate/improve on 55558):
  - `UnrealMCPBlueprintCommands.cpp` — BP creation, nodes, variables, compile
  - `UnrealMCPEditorCommands.cpp` — Editor operations, asset management
  - `UnrealMCPActorCommands.cpp` — Actor spawn, transform, properties
  - `UnrealMCPUMGCommands.cpp` — UMG widget creation and manipulation
- Each command file registers handlers keyed by the `type` field from incoming JSON
- **Known issues** to fix in our reimplementation: no error normalization, limited introspection, no batch support

Also note: `unreal-mcp-main` (Python MCP server) exists alongside the target project — this is a third-party reference implementation, NOT used in production. The `NodeToCode-main` plugin (found at `<PROJECT_ROOT>\Plugins\NodeToCode-main\`) is a separate BP-to-code tool, also not part of UEMCP.

## Current State — Phase 2 Complete + Level 1+2+2.5 + Option C + L3A S-A Shipped

### What's implemented:
- MCP server with stdio transport (`server/server.mjs`)
- 16 offline tools fully functional (`server/offline-tools.mjs`): `project_info`, `list_gameplay_tags`, `search_gameplay_tags`, `list_config_values`, `get_asset_info` (AR-metadata reader with verbose blob stripping, D31/D38), `query_asset_registry` (bulk scan with short class name matching, pagination via offset, truncation signalling, D33/D38), `inspect_blueprint` (BP export-table walk + CDO property defaults via `include_defaults`, D38/Option C), `list_level_actors` (placed actors with transforms + pagination + summary_by_class, D38/Option C), `read_asset_properties` (Option C, FPropertyTag iteration on any asset), `find_blueprint_nodes` (L3A S-A skeletal K2Node surface, D48), `find_blueprint_nodes_bulk` (EN-2: corpus-wide variant; closes SERVED_PARTIAL rows 26/27/28/42/62/63), `list_data_sources`, `read_datatable_source`, `read_string_table_source`, `list_plugins`, `get_build_config`
- `.uasset`/`.umap` binary parser (`server/uasset-parser.mjs`): FPackageFileSummary → name table → FObjectImport (40-byte UE 5.0+ stride) → FObjectExport (112-byte stride) → FPackageIndex resolver → FAssetRegistryData tag block → **Level 1+2+2.5 property decode**: FPropertyTag iteration with UE 5.6 `FPropertyTypeName` + `EPropertyTagFlags` extensions; 12 engine struct handlers (FVector/FRotator/FTransform/FLinearColor/FColor/FGuid/FGameplayTag/FGameplayTagContainer/FSoftObjectPath/FBox/FVector4/FIntPoint/FBodyInstance/FExpressionInput); simple-element + complex-element `TArray`/`TSet` containers; `TMap<K,V>` (scalar keys, struct keys emit `struct_key_map` marker); **tagged-fallback for unknown structs** (D50: self-describing FPropertyTag streams decode 601 unique struct names including UUserDefinedStruct, FTimerHandle, FMaterialParameterInfo without loading referenced asset — supersedes D47 two-pass design). Pure JS, no UE dependency. Production-grade (zero errors on 19K+ files).
- ToolIndex with 6-tier scoring + coverage bonus (`server/tool-index.mjs`)
- ToolsetManager with SDK handle integration + `getToolsData()` getter (`server/toolset-manager.mjs`)
- ConnectionManager with 4-layer architecture + D24 UMG ad-hoc error detection (`server/connection-manager.mjs`)
- 3-channel instructions: SERVER_INSTRUCTIONS (init), TOOLSET_TIPS (per-activation), tool descriptions (tools.yaml)
- Phase 1 audit completed 2026-04-12 (session-local artifact; findings folded into the D-log)
- Phase 2 tier-2 parser-validation audit completed 2026-04-15 (session-local artifact; findings folded into the D-log)
- Test infrastructure: mock seam in ConnectionManager, FakeTcpResponder/ErrorTcpResponder, **~1993 unit-runnable assertions** (post-D123 baseline; varies ±N by fixture availability — see T-1b synthetic-fixture migration status) across 20 test files. Growth cadence since pre-Agent-10 baseline of 436: Agent 10 +125; Agent 10.5 +51; Polish +37; Parser Extensions +34; Cleanup +26; Pre-Phase-3 Fixes +8; MCP-Wire +50; F-1.5 +16; EN-2 +42; M-spatial +74; EN-8/9 +15; S-B-base +120; Verb-surface +83; M-enhance +166; AUDIT-FIX-3 +17 (D85); SMOKE-FIX +43 (D87); CLEANUP-MICRO +4 (D90); M3-actors split +117 (D93, new test-m3-actors.mjs); M3-widgets +88 (D96, new test-m3-widgets.mjs); M3-blueprints-write +162 (D97, new test-m3-blueprints-write.mjs); CLEANUP-M3-FIXES +24 (D102); TEST-IMPORTS-FIX +197 restored from silent-zero (D104, see `feedback_silent_zero_test_drift.md`); M5-animation+materials +93 (D105, new test-m5-animation.mjs + test-m5-materials.mjs); M5-input+geometry +109 (D106, new test-m5-input-pie.mjs + test-m5-geometry.mjs); M5-editor-utility +94 (D107, new test-m5-editor-utility.mjs); BLUEPRINT-ASSET-PATH-RESOLUTION-FIX +16 (D112); NEW-2-UEMCP-SIDE-MITIGATION +38 (D123, new test-new-2-mitigation.mjs).
- Conformance oracle research complete — all 36 UnrealMCP C++ command contracts documented in `docs/specs/conformance-oracle-contracts.md`
- **Phase 2 actors toolset** (`server/tcp-tools.mjs`): 10 tools with name translation, Zod schemas, read/write caching
- **Phase 2 blueprints-write toolset** (`server/tcp-tools.mjs`): 15 tools (including 6 orphan BP node handlers)
- **Phase 2 widgets toolset** (`server/tcp-tools.mjs`): 7 tools with KNOWN ISSUE flags on 2 broken handlers
- **tools.yaml fully populated**: all 122 tools have params with types, required flags, descriptions; 11 `wire_type:` fields for name translation; `buildWireTypeMap()` parses YAML at startup
- **TOOLSET_TIPS populated**: core gotchas + cross-toolset workflows for all 3 TCP toolsets
- **Handler fixes landed (D38)**: F0 (verbose blob stripping), F1 (truncation signalling + pagination), F2 (tags removed from inspect_blueprint), F4 (placed actor filter), F6 (short class name matching)
- **D44 landed**: `server.mjs:offlineToolDefs` eliminated; `tools.yaml` is the single source of truth for all 15 offline tool descriptions and params (enforces CLAUDE.md Key Design Rule 1). `tools/list` + `find_tools` now report identical metadata. D44 invariant verified for `find_blueprint_nodes` at Agent 10.5 landing.
- **Agent 10 shipped (D39)**: Level 1+2+2.5 parser + Option C tools (`list_level_actors` transforms + pagination + summary_by_class; `inspect_blueprint` with `include_defaults`; new `read_asset_properties`). Agent 9.5's 4 implementation-critical corrections applied — transform chain via `outerIndex` reverse scan, UE 5.6 FPropertyTag extensions, sparse-transform tolerance, mandatory pagination.
- **Agent 10.5 shipped (D46/D47/D48/D50)**: complex-element containers (TMap + tagged TArray/TSet of custom structs); tagged-fallback for unknown structs (D47 pivot per D50 — 71% total marker reduction, 251K → 22K unknown_struct, 24K → 0 container_deferred); L3A S-A skeletal K2Node surface via `find_blueprint_nodes` (13 node types + 2 delegate-presence types, covers find/grep workflows offline without editor). Performance: 1.06× Agent 10 baseline bulk parse.

### Follow-on queue (post-Agent-10.5):
- **Polish worker** — 7 response-shape ergonomic items on the new offline surface
- **Parser extensions** — FExpressionInput native binary layout (~21K relabeled markers, deferred per D50); nested FieldPathProperty (pre-existing L1 edge case)
- **Cleanup worker** — int64 VFX parse bug + semgrep deep refactor
- **Manual testing** — Agent 10.5's offline surface (docs/testing/ scope)
- **3F sidecar writer** (editor plugin) — spec at `docs/specs/blueprints-as-picture-amendment.md`; now critical path since Agent 10.5's name-level floor is in place (D45)

**Future-consideration items** (not dispatched; tracked for session continuity): see `docs/tracking/backlog.md` — tool-surface cleanup, enhancements, fixture planting, deferred research triggers.

### What's NOT implemented yet:
- 3F sidecar writer (editor plugin)
- C++ editor plugin (Phase 3 — deferred per D39; scope has shrunk progressively via D32/D35/D45/D48)
- HTTP client for Remote Control API (Phase 4)
- Distribution to Project B via P4 (Phase 5)
- Per-project tuning (Phase 6)

## File Layout

```
UEMCP/
├── CLAUDE.md              ← you are here
├── tools.yaml             ← SINGLE SOURCE OF TRUTH for all 122 tools
├── .mcp.json.example      ← template Claude Desktop config
├── server/
│   ├── package.json       ← deps: @modelcontextprotocol/sdk, js-yaml, zod
│   ├── server.mjs         ← MCP server entry, management tools, tool registration
│   ├── offline-tools.mjs  ← 16 offline tools incl. query_asset_registry, inspect_blueprint (+include_defaults), list_level_actors (+transforms), read_asset_properties, find_blueprint_nodes, find_blueprint_nodes_bulk (EN-2)
│   ├── uasset-parser.mjs  ← binary .uasset/.umap parser: headers + FPropertyTag iteration + 12 engine struct handlers + TArray/TSet/TMap containers + tagged-fallback for unknown structs (Level 1+2+2.5, D50)
│   ├── tcp-tools.mjs      ← Phase 2 TCP tool handlers (actors: 10 tools, name translation, Zod schemas)
│   ├── tool-index.mjs     ← ToolIndex search with scoring + alias expansion
│   ├── toolset-manager.mjs ← enable/disable state, SDK handle integration
│   ├── connection-manager.mjs ← 4-layer connection management (has tcpCommandFn mock seam)
│   ├── test-phase1.mjs    ← Phase 1 + Agent 10/10.5 + EN-2 offline tool tests (224 assertions)
│   ├── test-mock-seam.mjs ← Mock seam + ConnectionManager tests (45 assertions)
│   ├── test-tcp-tools.mjs ← Phase 2 TCP tool tests — blueprints-write only post M3-bpw split (197 assertions)
│   ├── test-uasset-parser.mjs ← Parser format + Level 1+2+2.5 + tagged-fallback (152 assertions)
│   ├── test-offline-asset-info.mjs ← get_asset_info shape + cache (15 assertions)
│   ├── test-query-asset-registry.mjs ← bulk scan + pagination + tag filtering (16 assertions)
│   ├── test-inspect-and-level-actors.mjs ← inspect_blueprint + list_level_actors (30 assertions)
│   ├── test-s-b-base-differential.mjs ← S-B-base pin-block parser differential vs Oracle-A-v2 (68 assertions, D70)
│   ├── test-verb-surface.mjs ← M-new Verb-surface 5 verbs (bp_trace_exec/data/neighbors/show_node/list_entry_points) + oracle cross-check (83 assertions, D72)
│   ├── test-rc-wire.mjs   ← M-enhance RC HTTP wire-mock + 11 FULL-RC tools + cross-transport consistency (72 assertions, D74+D76)
│   └── test-helpers.mjs   ← Shared test infra (FakeTcpResponder, ErrorTcpResponder, etc.)
├── plugin/                ← C++ UE5 plugin (Phase 3 — empty scaffold)
├── docs/
│   ├── README.md          ← directory map + reading orders
│   ├── specs/             ← architecture, protocols, design (8 files incl. conformance oracle)
│   ├── plans/             ← implementation phases, test strategy (2 files)
│   ├── audits/            ← point-in-time audit reports (never edit after creation)
│   ├── research/          ← parser survey, audit, design options (5 files)
│   ├── handoffs/          ← agent dispatch documents (self-contained task briefs)
│   └── tracking/          ← living docs: risks-and-decisions.md (D1-D112, growing)
└── .claude/               ← project-level Claude settings
```

## Public-Repo Hygiene

This is a public repository. The target projects are private under NDA.
**Don't commit project codenames into tracked content.** Use generic
labels: `Project A` / `Project B` / `the primary target` /
`path/to/YourProject` / `${UNREAL_PROJECT_ROOT}`.

**NDA-gate scope is repo-write-only.** The forbidden-tokens block-list,
codename scrubbing, placeholder vocabulary, pre-commit grep, and
pre-push hook all govern what flows OUT of this repo to github.com in
committed content. They do **NOT** restrict tool execution at runtime.
UEMCP tools may operate at full capability against the user's own UE
projects — spawn actors, create assets, mutate Blueprints, run editor
utilities, etc. If a worker declines a tool call citing "shared
project," "NDA," or "proprietary" reasons WITHOUT a server-side gate
(e.g., `--enable-python-exec` per D101 (iv), or a similar future
`UEMCP_*` env flag), treat that as an opener-template defect, not a
worker error — the opener didn't communicate scope clearly enough.
Test artifacts created during smoke / live-fire should be cleaned up
via the `§Test artifacts pending manual delete` discipline; that's the
safety contract for scratch work, not an NDA constraint.

**Placeholder vocabulary by file type** (pick one, stay consistent):
- **Config templates** that get programmatically substituted (e.g.,
  `.mcp.json.example`): angle-bracket placeholders — `<UEMCP_REPO_PATH>`,
  `<UNREAL_PROJECT_ROOT>`, `<UNREAL_PROJECT_NAME>`. The setup script
  string-replaces these at install time.
- **Shell command examples** in tracked docs (CLAUDE.md, README.md,
  spec/plan docs): `path/to/YourProject` with forward slashes (works in
  cmd, bash, PowerShell), or `${UNREAL_PROJECT_ROOT}` for env-var-style.
- **Narrative mentions** of the target projects: `Project A` / `Project B` /
  `the primary target` / `the secondary target`.

**Asset-name namespace trade-off**: target-project-specific Blueprint /
anim-notify / gameplay-tag prefixes (e.g., `BP_*` for Blueprint
conventions plus other project-specific prefixes scattered through
`docs/tracking/backlog.md` and `server/test-*.mjs` fixtures) are
**intentionally retained** as dev-time sanity references — they're NOT
in the pre-push gate's `forbidden-tokens` list. If asset-namespace
classification ever changes (e.g., a publisher decides specific prefixes
qualify as confidential), add them to `.git/info/forbidden-tokens` per
checkout. Absence of a name from that list does NOT mean it's
contractually safe to commit; it means the maintainer judged it
non-NDA at the time the gate was configured.

**Project-specific session content** (handoffs, audits, testing logs,
research notes) lives in **gitignored** doc trees: `docs/handoffs/`,
`docs/audits/`, `docs/testing/`, `docs/research/`. Write freely there with
full project specificity — those directories never enter the index.

**Two hooks** in `.githooks/` scan content against
`.git/info/forbidden-tokens` (per-checkout, untracked):

- **`.githooks/pre-commit`** — scans staged diff at commit time. Catches
  leaks one cycle earlier so the operator doesn't have to grep manually
  before each commit.
- **`.githooks/pre-push`** — scans the outgoing commit range (file diff +
  commit messages) at push time. Final gate before content goes public.

Both block on match; bypass in genuine emergencies with
`git commit --no-verify` or `git push --no-verify` (rare).

One-time setup on a fresh clone:

```cmd
git config core.hooksPath .githooks
```

Then create `.git/info/forbidden-tokens` with one codename per line (use
`regex:<pattern>` lines for regex matches).

### Multi-agent orchestration handoff convention

This codifies how UEMCP runs orchestrator + worker sessions in practice.

**Dispatch mechanism — orchestrator drafts openers, user dispatches.** The orchestrator session does NOT invoke the `Agent` tool to spawn workers from inside its own conversation. Instead, the orchestrator drafts a self-contained **conversation opener** for each worker, and the user (Noah) opens a fresh Claude Code conversation and pastes the opener as that conversation's first message. This applies equally to:

- **Worker dispatches** (CLEANUP-MICRO, audit-fix workers, M-* implementation workers, audit workers, etc.)
- **Orchestrator-state migrations** (when the current orchestrator hits context limits and needs to hand off to a successor — same pattern: write the state doc, draft the inline opener, user opens fresh session and pastes).

Why human-in-the-loop dispatch and not subagents:
- **Clean context windows per worker** — each worker gets a fresh conversation, no inherited orchestrator context bloat, full ~200k available for the actual task.
- **Human gate at dispatch boundary** — Noah reviews the opener before dispatching; catches scope drift, codename leaks, or stale assumptions before a worker burns budget.
- **Deployment cycle ownership** (per D87) — workers ship code commits; Noah runs `sync-plugin.bat` + `Build.bat` + relaunches editor + restarts MCP server. The dispatch handoff is also where Noah picks up the deployment baton; an in-process subagent would blur that ownership.
- **Parallelism without context contention** — multiple workers run as independent conversation forks, not as competing tool calls in one session.

**Two-channel codename pattern** (established alongside the dispatch convention so codenames flow safely through openers):

- **Committed channel** (handoff docs in `docs/tracking/`, commit messages, D-log entries, README, CLAUDE.md, and the standing handoff docs at `docs/handoffs/*.md` — even though those are gitignored, they're treated as committed-channel for hygiene and `Edit`/`Read` predictability): use placeholder vocabulary only (`<target-project>`, `Project A`, `Project B`, `<your-project>`, `${UNREAL_PROJECT_ROOT}`). Never include codenames. The pre-push hook will block them anyway.
- **Ephemeral channel** (the inline opener / dispatch message that gets pasted into a new orchestrator session OR into a worker session at dispatch time, plus chat history within any session): may include codenames so the receiving session can fill placeholders when invoking tools, reading paths, or writing local-only inputs.

**The receiving session translates codenames → placeholders before writing to disk.** Codenames stay in chat history; placeholders go to committed files. Same rule for worker openers that need codename info: pass codenames in the dispatch message, NOT in the worker's handoff doc on disk.

**Opener content checklist** (what every worker opener must include):
1. Worker role + 1-line mission.
2. Explicit pointer to the worker's handoff doc at `docs/handoffs/<name>.md` (which uses placeholder vocabulary).
3. Required pre-reads: D-log anchors, related handoff docs, prior-art commits.
4. Codenames (if needed for live-editor invocations or absolute paths) — clearly delimited as ephemeral, with a "translate to placeholders for disk writes" reminder.
5. Constraints: D49 path-limit, D82 NDA-gate, no AI attribution, Desktop Commander for git, single-commit preference, report-length cap.
6. Final-report format the orchestrator expects back.

**Validation discipline before drafting major implementation handoffs** (D129 codification):

Before drafting a handoff for a workstream that depends on an empirical claim ("X is bugged" / "Y doesn't work" / "Z is too slow") + costs >3 worker sessions, the orchestrator MUST verify the claim is empirically validated, not just correlated. Triggers that REQUIRE a validation audit before drafting:

- Two or more prior hypotheses on the same problem have been falsified (each falsification weakens the next hypothesis's prior).
- The claim rests on `n=N correlated observations` rather than on source-reading + standalone reproduction.
- The proposed workstream involves migration / retirement / rewrite (not a targeted fix to a specific bug).
- The orchestrator finds itself hedging across multiple dispatch options (A/A+/B etc.) without empirical disambiguation.

When any trigger fires: dispatch a 1-session validation audit BEFORE drafting the implementation handoff. The audit's verdict (validated / refuted / mixed) gates the implementation work. The cost asymmetry strongly favors validation: a 1-session audit vs N sessions of potentially-misdirected implementation. The D128 → D129 walk-back saved ~2.25 sessions and is the worked example.

**Handoff draft pre-flight checklist** (before sending an implementation worker handoff to user dispatch):

1. **§0 prior-art search**: grep the codebase for capabilities the implementation duplicates. Many supposedly-greenfield tasks have unused or partially-used helpers in our own source (per `feedback_orchestrator_codebase_state_drift.md`).
2. **Empirical-claim status check**: if the handoff rests on an empirical claim, is it source-confirmed + reproduction-confirmed? If only correlation: dispatch validation audit first.
3. **Build-system workaround check**: does the codebase have `bUseUnity = false`, `IWYU.MinSourceFiles = 0`, `PrivateDefinitions[]` fixes, or other workarounds? If yes, ask why — they're often diagnostic of a structural issue worth understanding before implementing on top of.
4. **Worker-session estimate calibration**: per `feedback_ai_worker_time_estimates.md`, ~500 lines per worker session. Don't anchor estimates on human-time; don't pre-defer architectural cleanup based on stale "this is too big" framing.

These checks are cheap (~10 minutes total per handoff draft) and prevent the failure modes that produced D128's misdirection.

This convention is what makes D82 NDA-gate operationally workable AND keeps the orchestration-as-conversation-fork pattern consistent. Without the chat-side codename channel, every orchestrator migration would either lose project context (forcing rediscovery) or leak codenames into commits (forcing recovery cycles). Without the human-in-the-loop dispatch rule, the orchestrator would silently spawn subagents inside its own context, defeating the parallelism + clean-context-per-worker design that drove the multi-conversation pattern in the first place.

Established 2026-04-25 alongside D88-era orchestrator-state migration; codifies the chat-vs-disk separation that D82 sanitization implies but didn't previously make explicit. Dispatch-mechanism rule (orchestrator drafts openers; user dispatches) added later same day after a fresh-orchestrator session attempted to invoke `Agent` tool directly — clarification was missing from the original convention.

## Shell & Tooling Requirements

**Desktop Commander is MANDATORY for git and filesystem write operations.** The Cowork sandbox bash (`mcp__workspace__bash`) mounts the repo via a FUSE-like layer that cannot acquire `.git/index.lock` or `.git/HEAD.lock` files, causing git commits to fail or leave stale locks. All agents, workers, and conversations working in this repo MUST use Desktop Commander (`mcp__Desktop_Commander__start_process` with `shell: "cmd"`) for:

- Git operations (add, commit, status, diff, log, etc.)
- Any filesystem writes that need to persist reliably

Read operations (grep, glob, file reads) can use sandbox bash or Claude's built-in tools — those work fine through the mount.

**CMD, not PowerShell** — git and node are not in PATH on PowerShell. Always pass `shell: "cmd"` to Desktop Commander.

**Commit message workaround** — CMD mangles quoted strings. For multi-line commit messages, write to a temp file in the repo root and use `git commit -F file.txt && del file.txt`.

**Handoff documents must include this guidance** — any handoff that involves git operations should note the Desktop Commander requirement.

### .bat script convention — pause-on-exit so users can read output

**Every `.bat` script in this repo must route all exits through a single `:end` label that pauses before exiting unless an explicit auto-yes / scripted-mode flag is set.** When users double-click a script from Explorer (no persistent terminal), the console closes instantly on `exit /b` regardless of success/failure. Without an explicit pause, error messages disappear before the user can read them — and silent success looks identical to silent failure.

**Required pattern**:

```cmd
@echo off
setlocal EnableDelayedExpansion

set "EXIT_CODE=0"
set "AUTO_YES=0"
REM ...arg parsing; if user passes -y / --yes, set AUTO_YES=1...

REM Replace every `exit /b N` with:
REM   set "EXIT_CODE=N" & goto :end

REM ...script body...

set "EXIT_CODE=0"
goto :end

:end
echo.
if "!AUTO_YES!"=="0" (
  echo [<script-name> exit code: !EXIT_CODE!]
  pause
)
endlocal & exit /b %EXIT_CODE%
```

**Why this exact shape**:
- Single point-of-exit means error messages always print before the pause
- `AUTO_YES` flag lets CI / scripted callers skip the pause without code changes
- `endlocal & exit /b %EXIT_CODE%` propagates the EXIT_CODE past `endlocal` (immediate-expansion idiom; `%` substitutes before `endlocal` runs)
- Echo the exit code in interactive mode so users can distinguish success (0) from specific failure modes

**Convention applies to all repo-root `.bat` files**: `setup-uemcp.bat`, `sync-plugin.bat`, `test-uemcp-gate.bat`, and any future scripts. Established 2026-04-25 (D87 era) after sync-plugin.bat exhibited the bug; setup-uemcp.bat had been patched the same way previously.

**Source of the convention**: integration smoke test 2026-04-24/25 surfaced that sync-plugin.bat closed before user could verify success. Same class as setup-uemcp.bat's earlier "opens and closes immediately" issue.

## Code Standards

- **ES Modules** (.mjs) — `import/export`, no CommonJS
- **No TypeScript** — plain JS with JSDoc comments (decision D17: iteration speed with AI-assisted dev)
- **Zod for validation** — tool params validated via Zod schemas built from tools.yaml definitions
- Functions under 50 lines where possible
- Early returns for validation
- Comment **intent**, not implementation
- **NEVER add AI attribution** — no `Co-Authored-By: Claude`, no "generated with AI" in commits

## Key Design Rules

1. **tools.yaml is the single source of truth** — tool names, descriptions, toolset membership, aliases, params all defined there. Code loads from YAML at startup. Never hardcode tool definitions in server.mjs.

2. **SDK handles control visibility** — `server.tool()` returns a handle with `.enable()/.disable()`. ToolsetManager stores handles and toggles them when toolsets change. Disabled tools don't appear in `tools/list` at all (SDK filters at line 68-69 of mcp.js). Never use runtime guards to check toolset state in tool handlers.

3. **Offline tips go in SERVER_INSTRUCTIONS** — the offline toolset is always-on, so TOOLSET_TIPS never fires for it. Offline constraints (50 match cap, file type restrictions, progressive config drill-down) live in the init instructions string.

4. **TOOLSET_TIPS for dynamic toolsets only** — `{core, workflows[]}` structure. `workflows[]` entries have `requires[]` arrays for cross-toolset tips that only fire when all required toolsets are active.

5. **Aliases merge at build time** — tools.yaml `aliases:` section is canonical. tool-index.mjs has supplementary defaults. `build()` merges YAML over defaults (YAML wins on conflict).

6. **Auto-enable capped at 3** — `find_tools` enables top 3 toolsets by highest-scoring tool per query. Prevents accidentally loading too many toolsets.

7. **Validate empirical claims before committing workstreams (D129)** — when a major workstream (>3 worker sessions) rests on an empirical claim ("X is bugged" / "Y doesn't work" / "Z is too slow"), validate the claim empirically BEFORE committing to the workstream. **Triggers that require a 1-session validation audit**: (a) prior hypotheses on the same problem have been falsified — each falsification is signal that the next hypothesis might also be wrong; (b) the claim is inferred from symptom + handler-side error message rather than from reading source code or running standalone reproduction; (c) the proposed workstream cost is large; (d) cheaper alternative explanations exist that haven't been ruled out. **Gold-standard empirical validation techniques** (in order of cost): source-reading + grep verification (~15-30 min); standalone reproduction harness via curl/postman (~30-60 min); cross-test on minimal config (fresh install or plugin-disabled state); comparative dispatch (try same operation via different paths to isolate). **`n=N` correlated observations are not root-cause** — they're triggers for investigation, not substitutes. The D129 walk-back of D128's RC retirement workstream (saved ~2.25 worker sessions of misdirected work after a 1-session validation audit + 10 minutes of curl tests) is the worked example. See `feedback_validate_claims_before_commitment.md` + `feedback_ufunction_decoration_precondition.md` (the specific UE 5.6 lesson) + `feedback_orchestrator_codebase_state_drift.md` (own-codebase prior-art awareness).

8. **Transport choice — RC delegates are valid; correct UFUNCTION targeting is mandatory (D127 walked back; D129 corrects)** — UEMCP uses both **TCP:55558** (UEMCP plugin C++ handlers for productized tools that wrap specific UE APIs) AND **HTTP:30010** (Remote Control plugin for reflection-by-name primitives + a small set of HYBRID delegates per D66/D74/D76). **D128's "retire RC entirely" framing is walked back** per D129 / Audit 7 V4-PRIME finding: the bug-claim foundation (RC is engine-bugged) was empirically wrong. RC works correctly when targeted at real UFUNCTION-decorated methods; it correctly returns "Function does not exist" when targeted at non-UFUNCTION C++ methods. The historical NEW-2 + NEW-4 bugs were **UEMCP-induced** (calling `Set*ParameterValueEditorOnly` / `GetAll*ParameterInfo` — which are `ENGINE_API void`, not UFUNCTIONs — via UFUNCTION-dispatch path). **Standing rule for new tool development**: when adding an RC delegate, verify the target C++ method has the `UFUNCTION` macro before shipping. If only a non-UFUNCTION C++ method exists, find the UFUNCTION-decorated wrapper (e.g., `UMaterialEditingLibrary::SetMaterialInstance*ParameterValue` wraps the editor-only methods); if no wrapper exists, write a TCP:55558 C++ handler instead. **D23's TCP:55558 absorption**: stays as a long-term backlog candidate (post-D129 walk-back), no longer urgent. **Foot-gun caveat**: `rc_call_function` with non-UFUNCTION target name still returns "Function does not exist" — that's correct RC behavior, agent-side responsibility to target real UFUNCTIONs. `rc_batch` with sub-requests targeting non-UFUNCTIONs may trigger the latent V1 race in WebRemoteControl error-handling — the same UEMCP-side discipline applies (target real UFUNCTIONs only).

## Common Tasks

### Onboarding a new machine

Run `setup-uemcp.bat` from the UEMCP repo root (no arg = GUI mode with
folder/file browse; arg = `.uproject` path for scripted / repeat use).
The script:

- Validates Node.js on PATH. If missing, offers install via winget
  (Tier 1, user-scope, no admin) → direct MSI download from nodejs.org
  (Tier 2, UAC prompt). After successful install, user must close cmd
  and re-run in a fresh window (PATH doesn't refresh mid-session).
- `npm install` in `server/` (idempotent; skips if `node_modules` exists).
- Generates `.mcp.json` at the Claude workspace root (auto-detected —
  parent of `.uproject` dir if it contains `.claude\` or `CLAUDE.md`,
  otherwise the `.uproject` dir itself). GUI mode lets user override
  via folder-browse dialog.
- Physical-copies `plugin/UEMCP/` into `<project>\Plugins\UEMCP\`
  (D61 established physical copy as the working dev workflow over
  symlink/junction approaches). Prompts before overwriting existing.
- Enables UEMCP's required built-in plugin dependencies in the target
  `.uproject`'s `Plugins[]` array: `RemoteControl` (per D66/D77),
  `PythonScriptPlugin` (per D107), `GeometryScripting` (per D106).
  All three are real `.uplugin` files shipped with UE 5.6 at
  `Engine/Plugins/{VirtualProduction,Experimental,Runtime}/`.
  **Note:** `Blutility` is *not* a plugin — it's an engine-built-in
  *module* at `Engine/Source/Editor/Blutility/` providing the
  `UEditorUtilityBlueprint` / `UEditorUtilityWidgetBlueprint` headers
  used by UEMCP's editor-utility handlers. The module dep is satisfied
  by `Blutility` in `UEMCP.Build.cs PrivateDependencyModuleNames`;
  adding it to `.uproject Plugins[]` triggers UE's "Missing Plugin"
  dialog at editor startup. An earlier version of this script
  incorrectly added it; the script now self-heals by REMOVING any
  stale `Blutility` entry from `.uproject Plugins[]` on every run.
  Idempotent overall: skips plugins already enabled, flips
  `Enabled: false` to `true`, appends missing entries, removes
  stale-cleanup entries. Writes atomically (PowerShell to
  `<file>.uemcp-tmp` then `Move-Item -Force`) so a partial-write
  failure can't corrupt the project. Layered explicit enablement on
  top of `UEMCP.uplugin`'s declared deps as defense-in-depth —
  D106/D107 confirmed `.uproject Plugins[]` gating is the empirical
  contract for full toolset coverage; transitive auto-enable from the
  parent plugin alone is not load-bearing for these. Note:
  `PythonScriptPlugin` enables `run_python_command` which is itself
  gated by the `--enable-python-exec` startup flag per D101 (iv) — the
  plugin being available does NOT expose the tool.
- Pauses before exit on interactive launch so errors stay visible
  (fixed 2026-04-21 per friend-machine repro where double-click
  launches closed the window on the Node-missing check).
- **Auto-registers project codenames into `.git/info/forbidden-tokens`**
  (D124): extracts the `.uproject` filename stem + parent-dir name,
  appends idempotently with sort+dedup, deny-list, and version-folder
  filters (skip `\d+\.\d+`, Engine, Plugins, Source, etc.). Closes the
  D109/D118 codename-leak class structurally — registration is now
  bound to the universal entry points where new projects enter the
  test-target set, not orchestrator memory. Inline `node -e` helper
  shared with `sync-plugin.bat`.

Exit codes: 0 success, 1 bad args / cancelled / missing deps,
2 npm install failure, 3 .mcp.json write failure, 4 plugin copy failure,
5 plugin-deps update failure (.uproject read/write/JSON-parse error).

Env var `SETUP_AUTO_YES=1` auto-accepts Node-install prompts (CI use).

For propagating plugin source-of-truth changes to a target project
without re-running full onboarding, use `sync-plugin.bat <uproject>`
(D64). This xcopies `D:\DevTools\UEMCP\plugin\UEMCP\` → target,
excluding `Binaries\` + `Intermediate\` so UBT cache stays intact.
Also auto-registers project codenames into `.git/info/forbidden-tokens`
per D124 (same shared helper as setup-uemcp.bat).

Manual setup (skip the script): copy `.mcp.json.example` to your Claude
workspace root as `.mcp.json`, substitute `<UEMCP_REPO_PATH>` +
`<UNREAL_PROJECT_ROOT>` + `<UNREAL_PROJECT_NAME>` with real paths (use
forward slashes), run `npm install` in `server/`, then restart Claude Code.

### Running the server locally
```bash
cd D:\DevTools\UEMCP\server
UNREAL_PROJECT_ROOT="path/to/YourProject" node server.mjs
```

### Security flag — `--enable-python-exec` (M5-editor-utility, D101 (iv))

`run_python_command` is the only tool that can execute arbitrary code in
the editor. Per D101 (iv) the security model is defense-in-depth: Layer 1
is a server-side opt-in flag, Layer 2 is a plugin-side deny-list scan,
Layer 3 is a per-call audit log. The Layer 1 flag is **off by default**;
without it `run_python_command` returns `PYTHON_EXEC_DISABLED` before any
wire dispatch (it never even reaches the editor). Enable with either:

```bash
node server.mjs --enable-python-exec
# or
UEMCP_ENABLE_PYTHON_EXEC=1 node server.mjs
```

When enabled, scripts are still scanned at the plugin layer for
`os` / `subprocess` / `eval(` / `exec(` / `open(` / `__import__` and
rejected with `PYTHON_EXEC_DENY_LIST` + matched-pattern detail. Every
executed call is logged to `<UNREAL_PROJECT_NAME>.log` under the
`[UEMCP-PYTHON-EXEC]` prefix (alongside `[UEMCP-DELETE-ASSET]` for
asset-delete audit). The flag is the per-session opt-in; deny-list +
audit-log run regardless. To enable in the .mcp.json env block, add
`"UEMCP_ENABLE_PYTHON_EXEC": "1"` rather than mutating argv.

### Adding a tool to an existing toolset
1. Add the tool entry in `tools.yaml` under the appropriate toolset
2. If offline: implement handler in `offline-tools.mjs`, add case to `executeOfflineTool` switch
3. If TCP/HTTP: implement in the appropriate handler file (Phase 2+)
4. Register in `server.mjs` with `server.tool()`, capture handle, call `handle.disable()`, register with ToolsetManager

### Adding a new toolset
1. Define in `tools.yaml` with `layer:` and `tools:` block
2. ToolIndex picks it up automatically at `build()` time
3. Add TOOLSET_TIPS entry if cross-toolset workflows exist
4. Register all tools in server.mjs following the offline pattern (capture handles, start disabled)

### Adding an alias
Add to `tools.yaml` `aliases:` section. Merged into ToolIndex at build time.

## Known Issues & Deferred Work

- **M4**: `searchGameplayTags` rebuilds full hierarchy just to get flat tag list (perf only)
- **L1**: No TCP reconnection retry (Phase 2 scope)
- **L2**: No graceful fallback across layers (Phase 4 scope)
- **L3**: Write-op deduplication not implemented (Phase 2 scope)
- **L4**: MCP Resources deferred (D21)

See `docs/tracking/risks-and-decisions.md` for full risk table and decision log (D1-D112, growing). D-log entries D78-D112 collectively catalog 30+ UE 5.6 plugin-development institutional-memory items (module-vs-plugin distinctions per D110, deprecation paths per D93/D102, link-time module deps per D111, parameter-association struct gotchas per D105, Python plugin runtime gates per D107, and more) — search `(extends D78/...)` in the D-log to follow the chain.

## Operational Limits

### WebRemoteControl operational limits (D120 / D122 / D125 / D128 / D129 / D130 / NEW-2 / NEW-4)

> **FINAL ROOT CAUSE (D130, 2026-05-03)**: `WebRemoteControl.cpp:930` single-line UE 5.6.1 engine bug — missing `Passphrase` HTTP header triggers `TMap::operator[]` auto-insertion → downstream `FindChecked` assertion → editor crash. **One-line workaround in `server/connection-manager.mjs`**: send `Passphrase: <any-value>` header on `/remote/batch` (or all `/remote/*` for defense-in-depth). RC permissive auth in editor accepts any non-empty string. Empirically validated n=4 vs n=4 controlled experiment (Audit 7 Iteration 3); editor stayed alive 620+ sec after the experiment. **Pivot-W0' ships the fix in 0.25 sessions; saves ~4.75 worker sessions vs D128 retirement.** V4-PRIME (UEMCP calling non-UFUNCTION methods like `Set*ParameterValueEditorOnly`) remains a separate quality issue addressable by Pivot-W1/W2/W3 as routine cleanup; no longer urgent post-W0'. See `feedback_passphrase_header_gotcha.md` for full mechanism + workaround details.

> **Historical framings (D129 / D128 / D125 / etc.)**: preserved below for context but superseded by D130. Audit 7's three-iteration verdict arc (V4 PIVOT → V1 RETIRE → V1 + ONE-LINE WORKAROUND) is the canonical worked example for `feedback_validate_claims_before_commitment.md` — even validation audits can produce premature verdicts when scope-of-verdict outruns scope-of-evidence; continued iteration until the two match is part of the discipline.

#### Transitional pre-pivot constraints (only relevant until Pivot-W1/W2/W3 ship)

UE 5.6's `WebRemoteControl` plugin asserts in `Map.h:716` (`Pair != nullptr`) on the GameThread when the `/remote/batch` HTTP endpoint is invoked with `GetAll*ParameterInfo` enumerator function calls. The crash terminates the editor (`Assertion failed: Pair != nullptr` in `TMap::FindChecked` inside the per-request `FRC*Request::StructParameters` map). Engine-code crash; UEMCP cannot patch.

**Refined trigger** (D125, n=3 empirical evidence): the crash is **endpoint-and-function-specific**, NOT sustained-traffic-volume-driven. Two UEMCP tools currently route through `/remote/batch` and trigger the crash on call #1:

- **`list_material_parameters`** — issues 3 batch sub-requests (`GetAllScalarParameterInfo` + `GetAllVectorParameterInfo` + `GetAllTextureParameterInfo`)
- **`get_mesh_info`** — issues 5 batch sub-requests across the dynamic-mesh surface

All other tested RC tools (`rc_get_property`, `rc_set_property`, `set_material_parameter`, `rc_describe_object` — all single `/remote/object/*` calls) executed 9+ times per session across D118+D122+D125 with **NO** crash. The "~25-call ceiling" from D118+D122 was a red herring: those sessions happened to call `list_material_parameters` early, and call-volume correlation was incidental. **D120 hypothesis (broken-asset GameThread stall) confirmed-falsified by D122; D122 hypothesis (sustained-traffic universal-engine race) ALSO falsified by D125** — the trigger is a thread-safety / lifecycle bug in the `/remote/batch` handler's `FRC*Request::StructParameters` TMap, surfaced when batch sub-requests fan out to enumerator function calls.

**Operational guidance**:

1. **Avoid the two trigger tools entirely until NEW-2 fix ships.** `list_material_parameters` and `get_mesh_info` are annotated CRASH-TRIGGER in tools.yaml. Workers should not call them.
2. **Other RC tools are empirically safe at any volume the smoke exercised** — `rc_get_property` / `rc_set_property` / `set_material_parameter` (write-path NEW-4 issue notwithstanding) / `rc_describe_object` do not touch `/remote/batch` and do not trigger the crash.
3. **Per-section editor relaunch convention** (~15 RC HTTP calls OR ~15 min editor wall-clock per section, with relaunches between sections in smoke / gauntlet handoffs) is now **operational hygiene**, NOT crash-prevention. The crash-prevention value of the convention is empirically zero post-D125 since the trigger fires on call #1 of either trigger tool. The hygiene value remains: editor state stays fresh, asset-registry cache stays warm, hitch profile stays predictable. Smoke and gauntlet handoffs may relax the relaunch frequency for workflows that don't touch the trigger tools.

**Remediation paths** (UEMCP-self-contained — see `feedback_self_contained_scope.md`):

- **NEW-2 batch-endpoint fix worker** (highest priority post-D125): two design options under evaluation, both UEMCP-self-contained — (i) reroute `list_material_parameters` + `get_mesh_info` from `/remote/batch` to per-call `/remote/object/call` with synthetic aggregation in JS (we control the wrapper end-to-end), vs (ii) vendor a patched copy of the `FRC*Request::StructParameters` handler as a UEMCP plugin override (we control the vendoring; no external approval needed). Option (i) is faster + lower maintenance burden. Worker picks after evidence; see `docs/handoffs/new-2-batch-endpoint-fix.md`.

**Parked / not-recommended paths** (require waiting on external parties; not load-bearing):

- Epic UDN bug-report filing — ready-to-submit body at `docs/audits/new-2-udn-bug-report-2026-04-29.md` (gitignored, stale framing pre-D125-narrowing). Parked per user preference 2026-05-02 — UEMCP-side fixes are the path forward, not upstream-Epic engagement.
- WinDbg + symbols-resolved minidump walk — would only be useful as input to a UDN body; parked alongside.

### Editor-readiness probe (D125 / D126 / NEW-9)

The TCP plugin (port 55558) accepts connections **~5-10 minutes before the editor world fully initializes** after a fresh launch. During this pre-init window, spawn / create calls return success responses, but actors land in a discarded partial-world context — they are visible in the outliner but invisible to subsequent `find_actors` / `mesh_boolean` / `set_actor_property` / `get_actor_properties` calls (which use the fully-initialized `GetEditorWorld()` context).

**D126 audit cross-class implications**: NEW-9 is the **load-bearing root cause for 5 of 9 audit classes** (A spawn-label gap is amplified, C TCP-timeout is amplified, H is the bug itself, I.6 `delete_asset_safe` AR-pre-init silent corruption, I.7 spawn `NAME_COLLISION` false-positive against discarded partial-world actors). A single fix — gate TCP `Listen()` behind `FCoreDelegates::OnFEngineLoopInitComplete` — collapses readiness-window bugs structurally. Worker handoff at `docs/handoffs/new-9-readiness-probe.md`; **dispatched FIRST in the post-D126 worker order**.

**Until W1 ships — operational guidance**:

- `get_editor_state` returns a non-null `world_path` only after full initialization completes. Smoke / gauntlet / live-fire workflows should poll `get_editor_state.world_path` before issuing any spawn or asset-creation calls after a fresh editor launch (or post-relaunch). Workers that skip the readiness check and operate during the pre-init window will see "calls succeed but actors invisible" symptoms across an entire section.
- **`delete_asset_safe` is unsafe during pre-init** (audit I.6 HIGH): AR-referencer-block check returns 0 referencers because AR isn't scanned → silent unsafe delete. Only call after `world_path` is non-null.

**Post-W1**: connections during pre-init get `ECONNREFUSED`; clients retry per-command. The readiness-probe convention becomes redundant for the trigger tools (because the wire itself is now late-init), but `get_editor_state` polling remains useful as an explicit signal for sustained sessions.

Related sub-issue (NEW-9b): `create_procedural_mesh` sets `SpawnParams.Name` (the internal UObject FName) but never calls `SetActorLabel()`, so DynamicMeshActors appear in the outliner with the class name `"DynamicMeshActor"` instead of the specified actor name. The internal FName IS set correctly (handler returns `MeshActor->GetName()`), but the outliner display name is wrong. **D126 audit confirmed this is universal: ALL 7 SpawnActor sites in the plugin lack `SetActorLabel`** (5 in `ActorHandlers.cpp` for `spawn_actor` variants, 1 for `spawn_blueprint_actor`, 1 in `GeometryHandlers.cpp`). Fix queued in W2 (CLEANUP-M5-RESIDUE §3 expanded to all 7 sites).

### Cache-invalidation gap pre-W6 (D126 / audit I.2)

`ResultCache` (in `server/connection-manager.mjs`) keys cache entries by SHA-256 of `(type, params)` with 5-minute TTL. Read-ops cache; write-ops set `skipCache: true` so they don't pollute the cache. **But write-ops do NOT invalidate related read-op cache entries.** Agents that read-modify-read see stale data for up to 5 minutes after any mutation.

Failure pattern: `inspect_blueprint(BP_X)` cached, `add_event_node(BP_X)` mutates, subsequent `inspect_blueprint(BP_X)` returns stale cached state without the new node.

**Operational guidance until W6 ships**: agents that need post-write read-coherence should call write-ops with `skipCache: true` AND wait at least 5 minutes before re-reading the same asset — OR restart the MCP server (cache empties on process restart). For interactive workflows where this matters, prefer routing reads through TCP wire calls that don't go through the cache layer (e.g., `get_actor_properties` which is per-call). W6 worker handoff at `docs/handoffs/w6-cache-invalidation.md` ships the structural fix (`tools.yaml invalidates:` field + connection-manager bust logic).

### `get_mesh_info` live-fire status (D126 audit Class D — pending resolution)

D125 narrowed the NEW-2 trigger to `/remote/batch` calls with `GetAll*ParameterInfo` enumerator UFUNCTIONs specifically. The D126 audit observed that **`get_mesh_info` uses 5 SCALAR UFUNCTIONs** (`GetNumVertices` / `GetNumTriangles` / `GetNumLODs` / `GetBounds` / `GetStaticMaterials`) — NOT GetAll*-class enumerators. Smoke deferred it defensively without empirical reproduction.

**Status: live-fire pending.** Tools.yaml description softened from "DO NOT CALL" to "LIVE-FIRE PENDING." A single-call live-fire test would resolve. The W2 / W5 smoke verification will exercise this as a side-effect; orchestrator updates the annotation post-resolution. Until then: treat get_mesh_info as cautiously available — prefer alternatives where possible; if calling, do so as the first RC call of a fresh editor session and watch for crash.

### Mitigation flags (UEMCP-side defense-in-depth)

Three additive opt-in env flags shipped with D123 as defense against the
then-presumed sustained-traffic NEW-2 hypothesis. **D125 narrowed the
trigger to two specific batch-using tools, so these flags' empirical
crash-prevention value is now near-zero** (the crash fires at batch
call #1, before any of the three flags' counters / rate-caps / hint
thresholds engage). Their remaining value is operational hygiene —
keeping editor state fresh and providing a stderr signal for sustained
sessions. All three default OFF; with no flags set, sendHttp behaves
identically to the pre-mitigation baseline. Operator can enable any
subset; flags are independent.

- `UEMCP_RC_RECYCLE_AFTER_N=N` — every N un-cached RC HTTP calls,
  destroy and recreate an explicit `http.Agent`, severing the connection
  boundary. **Side effect:** enabling this flag also flips ON keep-alive
  socket pooling for RC HTTP within each recycle window (the default-OFF
  path uses Node's globalAgent with `keepAlive:false`). The recycle
  resets the connection-level state Unreal sees; whether that clears
  the editor-side `StructParameters` TMap corruption hypothesized in
  D118 is empirically uncertain — this is defense-in-depth, not a
  proven fix.
- `UEMCP_RC_RATE_CAP=R` — token-bucket rate-cap of R RC HTTP calls/sec
  (e.g. `0.5/sec` or `2`). Bucket capacity = R (1 second of headroom),
  refills at R tokens/sec. When empty, sendHttp blocks via setTimeout
  until enough tokens have accumulated for the next call. Caller-side
  throttling reduces the sustained-traffic intensity that may trigger
  the race; doesn't bound the total call count, only the rate.
- `UEMCP_RC_RELAUNCH_HINT_AFTER_N=N` — after N un-cached RC HTTP calls
  in a single server process, emit one stderr warning telling the
  operator to relaunch the editor + restart the MCP server before the
  NEW-2 ceiling hits. Idempotent within a session (fires exactly once).
  Counter resets on server restart, which correlates with editor
  relaunch.

**Counters track un-cached calls only.** Cached reads do not hit the
editor and do not increment any of the three counters; only calls that
actually round-trip to RC count toward the ceiling.

**Recommended layering** (post-D125, scaled back from D123 framing):

1. **`UEMCP_RC_RELAUNCH_HINT_AFTER_N=15`** is still cheap to enable and
   gives a single stderr line at the threshold — useful as a session-
   length signal even though it doesn't prevent the crash. Operator
   discretion; orchestrator no longer recommends it as a default.
2. **`UEMCP_RC_RECYCLE_AFTER_N` and `UEMCP_RC_RATE_CAP` are now
   explicitly NOT recommended** for general use. They were designed
   against the falsified sustained-traffic hypothesis. Flipping
   `RECYCLE_AFTER_N` also turns ON keep-alive socket pooling within
   each recycle window, which changes the connection-level shape of
   every RC call — measurable HYBRID-transport regression risk for
   zero crash-prevention benefit. Only enable if a future n=4+
   reproduction shape suggests connection-state corruption is involved.

The actual mitigation post-D125 is **don't call `list_material_parameters`
or `get_mesh_info`** until the NEW-2 batch-endpoint fix worker ships.
See `docs/handoffs/new-2-batch-endpoint-fix.md`.

In `.mcp.json`, add the desired flags to the `env` block (e.g.
`"UEMCP_RC_RELAUNCH_HINT_AFTER_N": "15"`). The startup banner on
stderr confirms which mitigations are active. Tests in
`server/test-new-2-mitigation.mjs` verify each flag's wire-mock
behavior plus the no-flags baseline.

## Testing

Test cases defined in `docs/plans/testing-strategy.md` (Tests 1-43, organized by phase).
**Total: ~1993 unit-runnable assertions across 20 test files** (post-D123 baseline; varies ±N by fixture availability — see T-1b synthetic-fixture migration status). Growth cadence since 436 baseline: +125 Agent 10, +51 Agent 10.5, +37 Polish, +34 Parser Extensions, +26 Cleanup, +8 Pre-Phase-3, +50 MCP-Wire, +16 F-1.5, +42 EN-2, +74 M-spatial, +15 EN-8/9, +120 S-B-base, +83 Verb-surface, +166 M-enhance, +17 AUDIT-FIX-3 (D85), +43 SMOKE-FIX (D87), +4 CLEANUP-MICRO (D90), +117 M3-actors split (D93), +88 M3-widgets (D96), +162 M3-blueprints-write (D97), +24 CLEANUP-M3-FIXES (D102), +197 TEST-IMPORTS-FIX restored from silent-zero (D104; see `feedback_silent_zero_test_drift.md`), +93 M5-animation+materials (D105), +109 M5-input+geometry (D106), +94 M5-editor-utility (D107), +16 BLUEPRINT-ASSET-PATH-RESOLUTION-FIX (D112), +38 NEW-2-UEMCP-SIDE-MITIGATION (D123). test-m1-ping live-editor-gated and excluded from rotation count.

### Rotation Runner — Single Authoritative Count + FAIL-LOUD on Import Errors

`server/run-rotation.mjs` enumerates every `server/test-*.mjs` (excluding the
two library helpers and the live-gated `test-m1-ping`), spawns each as an
isolated `node` subprocess, parses the `Passed/Failed/Total` summary from
stdout, and produces a single authoritative aggregate count. It is the
canonical way to run the rotation; per-file commands in the tables below remain
useful for narrow iteration but no longer set the rotation count.

**Run**:

```bash
cd D:\DevTools\UEMCP\server
node run-rotation.mjs           # standard
node run-rotation.mjs --json    # machine-readable
node run-rotation.mjs --snapshot  # writes server/.test-rotation-snapshot.json
npm test                        # equivalent to `node run-rotation.mjs`
```

For full coverage of the supplementary rotation set (the fixture-backed tests
listed below), prefix with `set UNREAL_PROJECT_ROOT=path/to/YourProject&& `
(no space before `&&`) — without it, those tests legitimately skip.

**FAIL-LOUD on import errors (closes D104 silent-zero meta-finding)**: the
runner classifies each subprocess outcome into one of `PASS`, `SKIPPED` (live-
or env-gated), `ASSERTION_FAILED`, `IMPORT_ERROR` (stderr matches Node module-
resolution patterns AND no summary parsed), `CRASHED_NO_SUMMARY` (exit ≠ 0,
no summary, not an import error — top-level throw), or `NO_SUMMARY_PARSED`
(exit 0 but no Pass/Fail/Total — silent-zero shape, investigate). Any non-PASS,
non-SKIPPED bucket exits non-zero with file-name attribution. The historic
silent-zero failure mode where a deleted-barrel import error masqueraded as
0/0 is structurally impossible to reproduce against this runner.

The runner does NOT replace per-file invocation for narrow debugging — those
commands still work and are documented in the tables below for that purpose.

### Test Files — Primary Rotation

| File | Purpose | Run command |
|------|---------|-------------|
| `server/test-phase1.mjs` | Offline tools, ToolIndex search, toolset enable/disable, handler fixes, Option C + L3A S-A coverage + EN-2 bulk-scan coverage (224 assertions) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=path/to/YourProject&& node test-phase1.mjs` |
| `server/test-mock-seam.mjs` | Mock seam wiring, cache, error normalization, queue serialization (45 assertions) | `cd /d D:\DevTools\UEMCP\server && node test-mock-seam.mjs` |
| `server/test-tcp-tools.mjs` | Phase 2 TCP tools: blueprints-write only (15 tools) — name translation, param pass-through, caching, port routing (tcp-55558 post M3-bpw D97), wire map building. Actors moved to test-m3-actors.mjs (D93), widgets to test-m3-widgets.mjs (D96). (197 assertions) | `cd /d D:\DevTools\UEMCP\server && node test-tcp-tools.mjs` |
| `server/test-mcp-wire.mjs` | MCP-wire integration — in-process McpServer + FakeTransport. Covers F-1 Zod-coerce (bool+number) through the real JSON-RPC path, runtime D44 invariant (tools/list matches yaml), happy-path + error response shapes, tools/list_changed timing on enable/disable, truncation/large-response wire round-trip + EN-2 bulk-tool entry (64 assertions, <1s runtime) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=path/to/YourProject&& node test-mcp-wire.mjs` |
| `server/test-helpers.mjs` | Shared infrastructure — not a runner. Exports: `FakeTcpResponder`, `ErrorTcpResponder`, `TestRunner`, `createTestConfig` |

### Test Files — Supplementary Rotation

These exercise real Project-A fixtures (`.uasset`/`.umap` bytes on disk) and require `UNREAL_PROJECT_ROOT`. Wired into rotation 2026-04-16 after M6 fix propagated F1/F2 changes.

| File | Purpose | Run command |
|------|---------|-------------|
| `server/test-uasset-parser.mjs` | Parser format + Level 1+2+2.5 property decode + tagged-fallback (D50) + synthetic container coverage (152 assertions) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=path/to/YourProject&& set UEMCP_VFX_FIXTURE_RELPATH=Content/<your-vfx-dir>/SM_auraHousya.uasset&& node test-uasset-parser.mjs` (the `UEMCP_VFX_FIXTURE_RELPATH` env var points at a real VFX mesh whose export row carries int64-overflow values; without it the int64 salvage test skips with `[SKIP-NEED-ENV]`) |
| `server/test-offline-asset-info.mjs` | `get_asset_info` shape + cache + indexDirty invariants (15 assertions) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=path/to/YourProject&& node test-offline-asset-info.mjs` |
| `server/test-query-asset-registry.mjs` | `query_asset_registry` bulk scan, pagination, truncation, tag filtering (16 assertions) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=path/to/YourProject&& node test-query-asset-registry.mjs` |
| `server/test-inspect-and-level-actors.mjs` | `inspect_blueprint` + `list_level_actors` export-table walking (30 assertions, includes F2 tags-removed regression guard) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=path/to/YourProject&& node test-inspect-and-level-actors.mjs` |
| `server/test-s-b-base-differential.mjs` | S-B-base pin-block parser differential vs Oracle-A-v2 fixtures — 6 fixtures × per-graph edge-set hybrid match (68 assertions, D70) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=path/to/YourProject&& node test-s-b-base-differential.mjs` |
| `server/test-verb-surface.mjs` | M-new Verb-surface — 5 offline traversal verbs (bp_trace_exec, bp_trace_data, bp_neighbors edge mode, bp_show_node pin completion, bp_list_entry_points precision) + oracle cross-check on 3 fixtures (83 assertions, D72) | `cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=path/to/YourProject&& node test-verb-surface.mjs` |
| `server/test-rc-wire.mjs` | M-enhance RC HTTP wire-mock — 11 FULL-RC tools (rc_* primitives + material/curve/mesh delegates) + cross-transport consistency checks (72 assertions, D74+D76) | `cd /d D:\DevTools\UEMCP\server && node test-rc-wire.mjs` |

**Note**: The `set` command must have NO space before `&&` or CMD adds a trailing space to the env var. The mock seam tests don't need `UNREAL_PROJECT_ROOT` (they use fake paths).

### Mock Seam Pattern

`ConnectionManager` accepts `config.tcpCommandFn` — a `(port, type, params, timeoutMs) => Promise<object>` that replaces real TCP. This enables unit-testing TCP tool handlers without a running editor. `FakeTcpResponder` provides canned responses; `ErrorTcpResponder` simulates failure modes (timeout, ECONNREFUSED, error_status, success:false, invalid_json).

### API Gotchas for Test Authors

- `toolIndex.getToolsetTools(name)` returns `{toolName, description, layer}[]` — NOT strings
- `ToolsetManager` constructor: `(connectionManager, toolIndex)` — order matters
- `enable()` returns `{enabled, alreadyEnabled, unavailable, unknown}`; `disable()` returns `{disabled, wasNotEnabled, unknown}`
- No `getState()` — use `getEnabledNames()`
- Offline tool params are snake_case: `file_path`, `file_filter`, `config_file` (full filename with `.ini`)

## MCP Configuration Files

UEMCP is referenced from `.mcp.json` files in each UE project root. These need updating when UEMCP server args or env vars change:

- **Project A**: per-project `.mcp.json` with `UNREAL_PROJECT_ROOT` pointing at the local `.uproject` root.
- **Project B**: same pattern, different local path.
- **Template**: `D:\DevTools\UEMCP\.mcp.json.example` — copy and customize per project.

In Cowork mode (Claude Desktop), the config lives in `claude_desktop_config.json` and servers get project-specific name prefixes (e.g., the Jira bridge runs as `jira-<project>`).

## Related Projects

- **Project A**: primary target (combat game) — tracked in Perforce in our dev environment.
- **Project B**: secondary target (BreakOut-style entry) — separate Perforce depot.
- **Existing UnrealMCP**: Plugin at `<PROJECT_ROOT>\Plugins\UnrealMCP\` (TCP:55557) — conformance oracle for Phase 2, deprecated post-Phase 3.
- **unreal-mcp-main**: Python MCP server co-located with Project A — third-party reference, not used in production.
- **NodeToCode-main**: BP-to-code plugin at `<PROJECT_ROOT>\Plugins\NodeToCode-main\` — separate tool, not part of UEMCP.

## Documentation Reading Order

**First read**: `docs/specs/architecture.md` → `docs/specs/plugin-design.md` → `docs/specs/dynamic-toolsets.md` → `tools.yaml` → `docs/plans/implementation.md`

**Quick reference**: `tools.yaml` → `docs/specs/dynamic-toolsets.md` → `docs/tracking/risks-and-decisions.md`

**Phase 2 (TCP client)**: `docs/specs/conformance-oracle-contracts.md` → `docs/specs/tcp-protocol.md` → `docs/plans/testing-strategy.md` (Tests 9-13 + Lessons Learned)
