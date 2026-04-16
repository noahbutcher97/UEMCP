# Orchestrator State — 2026-04-16

> **Purpose**: Bootstrap a fresh orchestrator session. Read this file, then CLAUDE.md, then pick up where we left off.
> **Last updated**: 2026-04-16T18:00Z

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

**333 assertions passing**: 54 phase1 + 45 mock-seam + 234 TCP.

---

## Manual Testing — COMPLETE

**Result**: 18/19 PASS, 1 HIGH failure found and fixed.
**Report**: `docs/testing/2026-04-16-handler-fixes-manual-results.md`

Ship-ready: F1 (pagination), F2 (inspect_blueprint tag removal), F4 (placed-actor filter), F6 (short class names).

**F0 bug found and fixed** (commit `5aaa290`): `verbose:true` on `get_asset_info` was silently ignored. Root cause: the `executeOfflineTool` switch case called `getAssetInfo(projectRoot, params.asset_path)` — dropping the `params` object so `verbose` never reached the function. Fix: pass `params` as third arg. Integration test added to catch regression.

Minor: Test D4 — no `hint` field on unrecognized class names (UX polish, not blocking).

---

## What's Next (in order)

1. ~~Manual testing~~ → **DONE** (F0 bug fixed in `5aaa290`)
2. **Codebase Audit** (`docs/handoffs/pre-agent9-codebase-audit.md`) ← **NEXT**
   - Read-only audit of all UEMCP server source. Produces `docs/audits/uemcp-server-codebase-audit-2026-04-16.md`.
   - Covers: architecture summary, module dependencies, code quality, handler audit table, test coverage, risks.
   - Purpose: ground the orchestrator and catch issues before more features land.
   - **Read the audit deliverable before dispatching Agent 9.**
3. **Agent 9 — Tool Surface Design** (`docs/handoffs/agent9-tool-surface-design.md`)
   - Design research only, no code. Decides how Level 1+2 property data reaches callers (fold into existing tools vs new tool vs hybrid).
   - Deliverable: `docs/research/level12-tool-surface-design.md`
   - Dispatch in Claude Code, Agent 9 reads the handoff.
3. **Agent 10 — Level 1+2 Parser Implementation** (`docs/handoffs/agent10-level12-parser-implementation.md`)
   - Depends on Agent 9's design decision.
   - Extends `uasset-parser.mjs` with FPropertyTag iteration + 10 struct handlers.
   - Recently patched with: struct byte table, version-gating details, known unknowns, bulk validation pass, perf targets (<50ms/file).
4. **Phase 3 C++ plugin** — deferred until Level 1+2 reveals what the plugin actually needs (D39).

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

---

## Key Files

| File | Role |
|------|------|
| `CLAUDE.md` | Project overview, architecture, current state, code standards |
| `tools.yaml` | Single source of truth for all 120 tools |
| `docs/tracking/risks-and-decisions.md` | D-log (D1-D43) |
| `docs/handoffs/` | All agent handoff docs |
| `docs/research/` | Parser survey, audit, design options |
| `docs/audits/phase2-tier2-parser-validation-2026-04-15.md` | Sealed audit with 7 findings (all fixed) |
