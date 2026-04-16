# Orchestrator State — 2026-04-16

> **Purpose**: Bootstrap a fresh orchestrator session. Read this file, then CLAUDE.md, then pick up where we left off.
> **Last updated**: 2026-04-16T17:30Z

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

**333 assertions passing**: 54 phase1 + 45 mock-seam + 234 TCP.

---

## What's In Flight

### Manual Testing (handler fixes, pre-Agent 9)

Noah is about to dispatch a manual testing session in Claude Code from `D:\DevTools\UEMCP\` (`.mcp.json` was just created there so UEMCP tools are available).

**Handoff**: `docs/handoffs/testing-handler-fixes-manual.md`
**Tests**: A-F covering fixes F0 (verbose blob stripping), F2 (tags removed from inspect_blueprint), F4 (placed actor filter), F6 (short class names), F1 (pagination/truncation), F (regression).
**Success criteria**: All assertions pass through the live MCP wire (not just unit tests).

**Opener for the testing agent** (copy-paste into Claude Code):

```
I need you to execute the manual testing plan at D:\DevTools\UEMCP\docs\handoffs\testing-handler-fixes-manual.md. Read that file first — it contains the full test plan with exact tool calls and expected results.

Pre-flight: Before running any tests, call connection_info to verify the offline layer is available. If verbose or offset params get rejected as unrecognized keys, note it — the server may need a restart for the new Zod schemas.

Run Tests A through F in order, checking each assertion. Report results as Test [ID]: PASS/FAIL — one-line description. Group any failures by severity (Blocker/High/Medium/Low). Include the actual response snippet for any FAIL.

This is testing 5 handler fixes (F0/F1/F2/F4/F6) that landed in commit d365b05 on the offline tools layer. The unit tests pass (333 assertions) but this exercises the fixes through the live MCP server end-to-end.
```

---

## What's Next (in order)

1. **Manual testing passes** → proceed to Agent 9
2. **Agent 9 — Tool Surface Design** (`docs/handoffs/agent9-tool-surface-design.md`)
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
