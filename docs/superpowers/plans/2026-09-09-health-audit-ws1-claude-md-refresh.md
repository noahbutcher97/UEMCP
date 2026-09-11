# WS1: CLAUDE.md File-Layout Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the File Layout and Testing sections of `CLAUDE.md` back in line with the code so every later worker reads an accurate map.

**Architecture:** Pure documentation edits to `CLAUDE.md`, made with exact string replacements. Four rotation suites read `CLAUDE.md` (`test-slash-command-anchors`, `test-plugin-manifest`, `test-retired-legacy-surface`, `test-tcp-transport`), so they run after every edit and the full rotation runs before the single commit.

**Tech Stack:** Markdown; Node 20+ rotation runner (`node run-rotation.mjs`).

**Spec:** `docs/superpowers/specs/2026-09-09-health-audit-remediation-design.md` §4 WS1.

## Global Constraints
- Scratch files: set `SCRATCH="$(mktemp -d)"` once per shell before the first task; every `$SCRATCH/...` path below refers to it. Never write scratch output into the repo.
- Codename hygiene: never write a private project name into `CLAUDE.md`; use `Project A` / `Project B` / `path/to/YourProject`.
- No AI attribution in the commit message.
- One commit for the whole workstream.
- Do not restructure any other section of `CLAUDE.md`; do not add a D-log entry.
- The pre-commit hook scans the staged diff against `.git/info/forbidden-tokens`; a block means a codename slipped in, not a hook bug.

---

### Task 1: Rewrite the `server/` and `plugin/` branches of the File Layout tree

**Files:**
- Modify: `CLAUDE.md` (File Layout section, the fenced tree that begins `UEMCP/`)

**Interfaces:**
- Consumes: nothing.
- Produces: the layout text that Task 2's native-tests note and Task 3's bundle rule refer to by path.

- [ ] **Step 1: Confirm the current tree text is present**

Run: `grep -n "server.mjs              ← MCP server entry, management tools" CLAUDE.md`
Expected: exactly one line number printed. If zero, stop: the layout has already changed and this plan must be re-based on the current text.

- [ ] **Step 2: Replace the `server/` branch**

Use the Edit tool on `CLAUDE.md`. `old_string` (verbatim, including the box-drawing characters):

```
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
```

`new_string`:

```
├── dist/
│   ├── deploy-uemcp.mjs        ← committed esbuild bundle of server/deploy-uemcp.mjs; the machine-interface entry (docs/specs/deployment-machine-interface.md)
│   └── deploy-uemcp.manifest.json ← bundle manifest checked by test-deployment-bundle.mjs
├── server/
│   ├── server.mjs              ← 19-line stdio shim; all wiring lives in create-uemcp-server.mjs
│   ├── create-uemcp-server.mjs ← real server entry: tool registration, management tools, project attachment
│   ├── offline-tools.mjs       ← offline tool handlers
│   ├── uasset-parser.mjs       ← .uasset/.umap binary parser (Level 1+2+2.5, D50)
│   ├── uasset-structs.mjs      ← engine struct decoders used by the parser
│   ├── tcp-transport.mjs       ← Content-Length framed TCP client: encode, decode, deadlines (see TCP Wire Protocol)
│   ├── connection-manager.mjs  ← active routing, mock seam, ResultCache, MetricsAggregator
│   ├── actors-tcp-tools.mjs    ← actors toolset TCP handlers
│   ├── blueprints-write-tcp-tools.mjs ← blueprints-write toolset TCP handlers
│   ├── widgets-tcp-tools.mjs   ← widgets toolset TCP handlers
│   ├── menhance-tcp-tools.mjs  ← M-enhance hybrid toolset TCP handlers
│   ├── m5-*-tools.mjs          ← M5 toolsets (animation, materials, input-pie, geometry, editor-utility)
│   ├── rc-tools.mjs            ← Remote Control HTTP primitives + delegates
│   ├── tool-index.mjs          ← search + scoring + alias expansion
│   ├── toolset-manager.mjs     ← enable/disable, SDK handle integration
│   ├── project-*.mjs           ← project attachment: context, identity, targets, hygiene, tools, errors (D177)
│   ├── deployment/             ← deployment CLI subsystem: plan/apply/verify/doctor over per-client adapters
│   │   ├── adapters/           ← claude.mjs, codex.mjs, gemini.mjs, vscode.mjs — one client config format each
│   │   ├── client-transaction.mjs ← staged, fingerprinted, rollback-capable config writes
│   │   ├── local-state.mjs     ← apply leases and local install state
│   │   ├── windows-native.mjs  ← Windows file pinning and ancestry checks (embeds PowerShell)
│   │   └── orchestrator.mjs, plan-document.mjs, contracts.mjs, prerequisites.mjs, … (33 modules)
│   ├── deploy-uemcp.mjs        ← source entry for the deployment CLI (bundled into dist/)
│   ├── build-deployment-cli.mjs ← builds dist/deploy-uemcp.mjs (`npm run build:deployment`)
│   ├── verify-deploy.mjs       ← Q3 verify-deploy + watch helper (D136 + D138)
│   ├── sync-plugin-helper.mjs  ← W-L deploy-marker + per-workspace lock (D138)
│   ├── live-smoke-harness.mjs  ← reusable live-editor smoke harness (D177); run-live-smoke.mjs is its runner
│   ├── live-smoke-*.mjs        ← individual live-editor smoke scripts (editor required, not in rotation)
│   ├── run-rotation.mjs        ← canonical rotation runner; FAIL-LOUD on import errors
│   ├── test-*.mjs              ← rotation test files (see Testing section for table)
│   └── test-helpers.mjs        ← FakeTcpResponder, ErrorTcpResponder, TestRunner
├── plugin/UEMCP/               ← C++ UE5 plugin
│   └── Source/UEMCP/Private/
│       ├── *Handlers.cpp       ← one file per toolset family (Blueprint, Animation, Actor, Widget, …)
│       ├── MCPServerTransportPolicy.cpp ← framed request intake: header/body limits, deadlines, UTF-8 checks
│       ├── MCPServerRunnable.cpp ← TCP:55558 accept loop
│       └── Tests/              ← UE automation tests: UEMCPTests.cpp, MCPServerTransportPolicyTests.cpp
```

- [ ] **Step 3: Run the four CLAUDE.md-reading suites**

Run:

```bash
cd D:/DevTools/UEMCP/server
node test-slash-command-anchors.mjs && node test-plugin-manifest.mjs && node test-retired-legacy-surface.mjs && node test-tcp-transport.mjs
```

Expected: each prints a summary with `Failed: 0`. If `test-slash-command-anchors` fails, a slash command references a `CLAUDE.md §"…"` header that the edit renamed; the edit above does not rename headers, so a failure means the `old_string` matched something other than the tree. Revert with `git checkout CLAUDE.md` and re-check Step 1.

### Task 2: Correct the assertion count and add the native-tests note

**Files:**
- Modify: `CLAUDE.md` (Current State › Implemented bullet "Test infrastructure"; Testing section opening paragraph)

**Interfaces:**
- Consumes: nothing.
- Produces: the sentence "not yet scripted" that WS2's handoff replaces with a pointer to `run-native-tests.bat`.

- [ ] **Step 1: Confirm both occurrences of the stale count**

Run: `grep -c "7511 unit-runnable assertions" CLAUDE.md`
Expected: `2`.

- [ ] **Step 2: Update the Current State bullet**

Edit `CLAUDE.md`. `old_string`:

```
- Test infrastructure: mock seam in ConnectionManager, FakeTcpResponder/ErrorTcpResponder, **7511 unit-runnable assertions project-less (higher with a real `UNREAL_PROJECT_ROOT`; see Fixture-project default) across 76 rotation test files** (D-log tracks per-milestone deltas — do not duplicate here)
```

`new_string`:

```
- Test infrastructure: mock seam in ConnectionManager, FakeTcpResponder/ErrorTcpResponder, **7532 unit-runnable assertions project-less (higher with a real `UNREAL_PROJECT_ROOT`; see Fixture-project default) across 76 rotation test files** (D-log tracks per-milestone deltas — do not duplicate here)
```

- [ ] **Step 3: Update the Testing section paragraph and add the native-tests line**

Edit `CLAUDE.md`. `old_string`:

```
Test cases defined in `docs/plans/testing-strategy.md` (Tests 1-43). **7511 unit-runnable assertions project-less (higher with a real `UNREAL_PROJECT_ROOT`; see Fixture-project default) across 76 rotation test files** (D-log tracks per-milestone deltas; do not duplicate the cadence list here). `test-m1-ping` is live-editor-gated and excluded from rotation count.
```

`new_string`:

```
Test cases defined in `docs/plans/testing-strategy.md` (Tests 1-43). **7532 unit-runnable assertions project-less (higher with a real `UNREAL_PROJECT_ROOT`; see Fixture-project default) across 76 rotation test files** (D-log tracks per-milestone deltas; do not duplicate the cadence list here). `test-m1-ping` is live-editor-gated and excluded from rotation count.

**Native plugin tests**: 16 UE automation tests live in `plugin/UEMCP/Source/UEMCP/Private/Tests/` (`UEMCPTests.cpp`, `MCPServerTransportPolicyTests.cpp`; pretty-name filter `UEMCP.`; flags `EditorContext | EngineFilter`, compiled only when `WITH_DEV_AUTOMATION_TESTS`). They cover transport intake, the command registry, the response builder and the parsers, not the `*Handlers.cpp` bodies. **Not yet scripted**: run them from the editor's Session Frontend until `run-native-tests.bat` lands (WS2 of `docs/superpowers/specs/2026-09-09-health-audit-remediation-design.md`).
```

- [ ] **Step 4: Verify the count is consistent**

Run: `grep -c "7532 unit-runnable assertions" CLAUDE.md && grep -c "7511" CLAUDE.md`
Expected: `2` then `0`.

### Task 3: Add the bundle regeneration rule

**Files:**
- Modify: `CLAUDE.md` (Common Tasks section, directly after the "Plugin versioning convention" paragraph)

**Interfaces:**
- Consumes: nothing.
- Produces: the rule WS4 follows when it regenerates the bundle in the same commit as a source change.

- [ ] **Step 1: Locate the anchor paragraph**

Run: `grep -n "^\*\*Plugin versioning convention\*\*" CLAUDE.md`
Expected: one line number.

- [ ] **Step 2: Insert the rule after that paragraph**

Edit `CLAUDE.md`. `old_string`:

```
**Plugin versioning convention**: when `manifest.json version` bumps, also bump `UEMCP.uplugin Version` (integer; UE-internal rebuild signal) AND `VersionName` (string; aligned with manifest) in lockstep. W-L marker compares both → either triggers auto-bust.
```

`new_string`:

```
**Plugin versioning convention**: when `manifest.json version` bumps, also bump `UEMCP.uplugin Version` (integer; UE-internal rebuild signal) AND `VersionName` (string; aligned with manifest) in lockstep. W-L marker compares both → either triggers auto-bust.

**Deployment bundle convention**: `dist/deploy-uemcp.mjs` is a committed esbuild bundle of `server/deploy-uemcp.mjs` and everything under `server/deployment/`; external consumers run it without `npm install` (`docs/specs/deployment-machine-interface.md`). Any change under `server/deployment/` or to `server/deploy-uemcp.mjs` must regenerate it with `npm run build:deployment` (from `server/`) **in the same commit**; `test-deployment-bundle.mjs` fails the rotation when the bundle is stale. Keeping the bundle in git is a deliberate decision, not drift.
```

- [ ] **Step 3: Run the four CLAUDE.md-reading suites again**

Run:

```bash
cd D:/DevTools/UEMCP/server
node test-slash-command-anchors.mjs && node test-plugin-manifest.mjs && node test-retired-legacy-surface.mjs && node test-tcp-transport.mjs
```

Expected: all four print `Failed: 0`.

### Task 4: Full rotation and commit

**Files:**
- Modify: none beyond `CLAUDE.md`.

- [ ] **Step 1: Run the full rotation**

Run: `cd D:/DevTools/UEMCP/server && node run-rotation.mjs --json > "$SCRATCH/ws1-rotation.json"; echo "exit=$?"`
Expected: `exit=0`. Then run: `jq -c '.aggregate, {importErrorCount, assertionFailureCount, crashCount}' "$SCRATCH/ws1-rotation.json"`
Expected: `{"passed":7532,"failed":0,"total":7532}` and every count `0`. A different `passed` figure means another change landed; report it rather than editing the number in `CLAUDE.md` to match.

- [ ] **Step 2: Scan the diff for codenames**

Run (Git Bash, from the repo root):

```bash
export LC_ALL=C.UTF-8
grep -v '^#' .git/info/forbidden-tokens | grep -v '^regex:' | grep -v '^\s*$' > "$SCRATCH/tokens.txt"
git diff -- CLAUDE.md | grep -i -F -f "$SCRATCH/tokens.txt"; echo "grep exit=$? (1 means clean)"
```

Expected: `grep exit=1`. Any printed line is a codename; replace it with placeholder vocabulary before committing.

- [ ] **Step 3: Commit**

```bash
cd D:/DevTools/UEMCP
git add CLAUDE.md
git commit -m "Refresh CLAUDE.md file layout: deployment subsystem, real server entry, transport, bundle rule, native-tests note"
```

Expected: the pre-commit hook passes; `git status --short` prints nothing.
