# Orchestrator State — 2026-04-16

> **Purpose**: Bootstrap a fresh orchestrator session. Read this file, then CLAUDE.md, then the codebase audit, then pick up where we left off.
> **Last updated**: 2026-04-16T22:00Z

---

## Git State

All work is on `main`. Key commits this session (chronological):

| Commit | Content |
|--------|---------|
| `7f26260` | D38-D43 D-log entries, 5 handoff docs (Agents 6-10), sealed tier-2 audit |
| `d365b05` | Agent 6 handler fixes (F0/F1/F2/F4/F6) + Agent 7 research + 18 new test assertions (333 total) |
| `236265b` | Agent 8 audit and build recommendation |
| `70c0933` | CLAUDE.md update (Desktop Commander requirement, current state, test counts) |
| `2c17cb0` | Manual testing handoff for handler fixes |
| `b4304b6` | Patch Agent 10 handoff with struct byte sizes, version-gating, known unknowns, bulk validation, perf targets |
| `af32a2d` | Orchestrator state handoff (this file, initial version) |
| `5aaa290` | Fix F0: pass verbose param through to getAssetInfo (bug found by manual testing) |
| `7756270` | Update orchestrator state with testing results |
| `799fd7a` | Add pre-Agent 9 codebase audit handoff + update orchestrator sequencing |
| `937b02c` | Add mandatory verification pass to codebase audit handoff |
| *(pending)* | 2 MEDIUM yaml fixes (take_screenshot params, get_all_blueprint_graphs dupe) + handoff updates |

**333 primary assertions passing**: 54 phase1 + 45 mock-seam + 234 TCP.
**71/74 supplementary assertions**: 3 stale failures in untracked test files (see audit).

---

## Manual Testing — COMPLETE

**Result**: 18/19 PASS on first run, 25/25 PASS on second run (post-fix).
**Report**: `docs/testing/2026-04-16-handler-fixes-manual-results.md`

Ship-ready: F1 (pagination), F2 (inspect_blueprint tag removal), F4 (placed-actor filter), F6 (short class names).

**F0 bug found and fixed** (commit `5aaa290`): `verbose:true` on `get_asset_info` was silently ignored. Root cause: the `executeOfflineTool` switch case called `getAssetInfo(projectRoot, params.asset_path)` — dropping the `params` object so `verbose` never reached the function. Fix: pass `params` as third arg. Integration test added to catch regression.

**F0-class false-confidence lesson**: Unit tests call `executeOfflineTool` directly, bypassing Zod schema + SDK handler wrapper + MCP wire path. Param-passthrough bugs between the switch dispatch and the handler function are invisible to unit tests. The audit found more instances of this pattern.

---

## Codebase Audit — COMPLETE (2nd run, with verification)

**Deliverable**: `docs/audits/uemcp-server-codebase-audit-2026-04-16.md` (~580 lines)
**Confidence**: HIGH (self-verified — all 45 handler param chains traced at file:line, all test suites run)

### Findings: 0 CRITICAL, 0 HIGH, 6 MEDIUM, 4 LOW

| # | Severity | Finding | Status | Fix scope |
|---|----------|---------|--------|-----------|
| M1 | MEDIUM | `take_screenshot` yaml declares only `filepath`; Zod also accepts `resolution_x`/`resolution_y` | **FIXED** in tools.yaml (pending commit) | yaml edit |
| M2 | MEDIUM | `get_all_blueprint_graphs` declared twice in yaml (alias + standalone) | **FIXED** in tools.yaml (pending commit) | yaml edit — removed standalone, kept alias |
| M3 | MEDIUM | `inspect_blueprint.verbose` — handler reads param but never uses it; server.mjs description **lies** ("include full AR tags") while yaml correctly says "Currently unused" | OPEN | Fix server.mjs description to match yaml; optionally remove dead param from handler |
| M4 | MEDIUM | Description drift between `server.mjs:offlineToolDefs` and `tools.yaml` for 13 offline tools — violates "tools.yaml is single source of truth" contract | OPEN | Either make server.mjs read descriptions from yaml, or sync the 13 descriptions manually |
| M5 | MEDIUM | 3 near-identical TCP dispatchers in tcp-tools.mjs | OPEN | DRY into generic dispatcher (post-Phase 3) |
| M6 | MEDIUM | 2 supplementary test files have 3 stale assertions from F1/F2 fixes not propagated | OPEN | Update `test-query-asset-registry.mjs:50,68` (`filesScanned` → `total_scanned`) and `test-inspect-and-level-actors.mjs:43` (remove `bp.tags` assertion) |

### LOW items (4):
- `getToolDef` dead code in toolset-manager.mjs:247
- `SERVER_INSTRUCTIONS` inlined in server.mjs (compact ~6 lines, not the issue previous audit implied)
- `detectProject` uses PowerShell-only auto-detection (Windows-only project, not blocking)
- `parseBuffer` export only returns `{ summary }` — richer parsers must be composed manually

### Supplementary test files discovered by audit (not in CLAUDE.md rotation):
- `test-uasset-parser.mjs` — 42/42 PASS
- `test-offline-asset-info.mjs` — 15/15 PASS
- `test-query-asset-registry.mjs` — **14/16 PASS** (2 stale: `filesScanned` → `total_scanned`)
- `test-inspect-and-level-actors.mjs` — **29/30 PASS** (1 stale: `bp.tags` removed by F2)

### Key audit insight:
The `inspectBlueprint` function's `genClassNames` set only covers 3 generated-class types (BlueprintGeneratedClass, WidgetBlueprintGeneratedClass, AnimBlueprintGeneratedClass). For other BP subclasses (e.g., GameplayAbilityBlueprintGeneratedClass), `parentClass` will be `null`. ProjectA's BPGA_*/BPGE_* happen to use plain BlueprintGeneratedClass so tests pass, but this is a latent issue.

### Audit recommendations:
1. **Before Agent 10 ships new tools**: fix M3 (inspect_blueprint.verbose lie), M4 (description drift), M6 (stale tests)
2. **MCP-wire integration test harness** for Agent 10+ to close the F0-class false-confidence gap
3. **Agent 9 should note** the description-drift issue when designing new tool surfaces — any new Level 1+2 tools must declare every param in yaml AND ensure server.mjs doesn't duplicate definitions

---

## What's Next (in order)

1. ~~Manual testing~~ → **DONE** (25/25 PASS, F0 bug fixed in `5aaa290`)
2. ~~Codebase Audit~~ → **DONE** (0C/0H/6M/4L — 2 MEDIUM fixed, 4 MEDIUM open)
3. ~~MEDIUM yaml fixes (M1, M2)~~ → **DONE** (take_screenshot params, get_all_blueprint_graphs dupe)
4. **Fix remaining MEDIUMs (M3, M4, M6)** — orchestrator should dispatch or fix directly before Agent 9
   - M3: Fix `inspect_blueprint.verbose` lie in server.mjs:497 (one-line description fix)
   - M4: Sync server.mjs offlineToolDefs descriptions with yaml (or refactor to read from yaml)
   - M6: Update 3 stale test assertions in supplementary test files
5. **Agent 9 — Tool Surface Design** (`docs/handoffs/agent9-tool-surface-design.md`)
   - Design research only, no code. Decides how Level 1+2 property data reaches callers.
   - Deliverable: `docs/research/level12-tool-surface-design.md`
   - No D-number needed (design doc, no code or decisions).
   - **Input-file risk**: verify all 9 files listed in the handoff exist before dispatching.
6. **Agent 10 — Level 1+2 Parser Implementation** (`docs/handoffs/agent10-level12-parser-implementation.md`)
   - Depends on Agent 9's design decision.
   - Should add MCP-wire integration test harness (audit recommendation).
7. **Phase 3 C++ plugin** — deferred until Level 1+2 reveals what the plugin actually needs (D39).

---

## Workflow Rules

### Agent Dispatch
- **Orchestrator writes handoffs**, Noah dispatches them as separate Claude Code sessions.
- Handoffs live in `docs/handoffs/` and are self-contained — agents read them, not chat history.
- Each agent's handoff specifies: mission, file scope, input files, deliverables, constraints, final report format.

### D-Number Allocation
- Orchestrator pre-allocates D-numbers to prevent parallel-worker races.
- Current D-log is at D43. Next available: D44.
- D-log lives in `docs/tracking/risks-and-decisions.md`.

### Git Operations
- **Desktop Commander is MANDATORY** for git and filesystem writes. Sandbox bash mount cannot acquire `.git/index.lock`.
- Use `mcp__Desktop_Commander__start_process` with `shell: "cmd"` (not PowerShell — PATH issues).
- **Commit message workaround**: CMD mangles quoted strings. Write to temp file: `echo message> commit-msg.txt && git commit -F commit-msg.txt && del commit-msg.txt`

### Conventions
- **Sealed audits**: never edit after creation. Amendments use blockquote format.
- **D-log**: revised in place (living doc).
- **No AI attribution** in commits, PRs, or review docs.
- **YAGNI** — don't create files for future work unless tasked.

---

## Completed Agents

| Agent | Type | Status | Key Deliverable |
|-------|------|--------|----------------|
| 1-5 | Various (Phase 1-2) | Done | Phase 1+2 complete, 333 assertions |
| 6 | Handler fixes | Done | F0/F1/F2/F4/F6 in offline-tools.mjs |
| 7 | Research collection | Done | `docs/research/uasset-property-parsing-references.md` (14 projects surveyed) |
| 8 | Research audit | Done | `docs/research/uasset-parser-audit-and-recommendation.md` (CUE4Parse + UAssetAPI recommended) |
| Grounding | Codebase audit (2 runs) | Done | `docs/audits/uemcp-server-codebase-audit-2026-04-16.md` (0C/0H/6M/4L) |

---

## Key Files

| File | Role |
|------|------|
| `CLAUDE.md` | Project overview, architecture, current state, code standards |
| `tools.yaml` | Single source of truth for all 120 tools (M1+M2 fixed, pending commit) |
| `docs/tracking/risks-and-decisions.md` | D-log (D1-D43) |
| `docs/handoffs/` | All agent handoff docs |
| `docs/research/` | Parser survey, audit, design options |
| `docs/audits/uemcp-server-codebase-audit-2026-04-16.md` | Codebase grounding audit (0C/0H/6M/4L, verified) |
| `docs/audits/phase2-tier2-parser-validation-2026-04-15.md` | Sealed Phase 2 audit with 7 findings (all fixed) |
| `docs/testing/2026-04-16-handler-fixes-manual-results.md` | Manual testing report (25/25 PASS) |
