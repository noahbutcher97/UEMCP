# Pre-Agent 9 — UEMCP Server Codebase Audit

> **Dispatch**: Before Agent 9 (tool surface design)
> **Type**: Audit — read-only, no code changes
> **Deliverable**: `docs/audits/uemcp-server-codebase-audit-2026-04-16.md`

---

## Mission

Read the entire UEMCP MCP server codebase and produce a comprehensive audit covering architecture verification, code quality, consistency, and anything a future orchestrator or implementation agent needs to know. This is the grounding document — future agents and orchestrators reference it instead of reading all source files themselves.

---

## Files to read (in order)

### Primary source (read every line)

| File | Purpose |
|------|---------|
| `server/server.mjs` | MCP server entry, tool registration, management tools, SERVER_INSTRUCTIONS |
| `server/offline-tools.mjs` | 13 offline tool handlers + executeOfflineTool dispatch |
| `server/uasset-parser.mjs` | Binary .uasset/.umap parser (headers, tables, AR tags) |
| `server/tcp-tools.mjs` | Phase 2 TCP tool handlers (actors, blueprints-write, widgets) |
| `server/tool-index.mjs` | ToolIndex search with 6-tier scoring + alias expansion |
| `server/toolset-manager.mjs` | Enable/disable state, SDK handle integration |
| `server/connection-manager.mjs` | 4-layer connection management, TCP wire protocol, caching |
| `tools.yaml` | Single source of truth for all 120 tools |

### Test files (read for coverage understanding)

| File | Purpose |
|------|---------|
| `server/test-phase1.mjs` | Offline tools + handler fixes (54 assertions) |
| `server/test-mock-seam.mjs` | Mock seam + ConnectionManager (45 assertions) |
| `server/test-tcp-tools.mjs` | TCP tools: actors, blueprints-write, widgets (234 assertions) |
| `server/test-helpers.mjs` | Shared test infra (FakeTcpResponder, ErrorTcpResponder, TestRunner) |

### Context (skim for cross-references)

| File | Purpose |
|------|---------|
| `CLAUDE.md` | Project overview, architecture, current state |
| `docs/tracking/risks-and-decisions.md` | D-log (D1-D43), decisions and rationale |
| `docs/audits/phase2-tier2-parser-validation-2026-04-15.md` | Most recent audit (parser + handler findings) |
| `docs/testing/2026-04-16-handler-fixes-manual-results.md` | Manual integration test results |

---

## Audit sections (required in deliverable)

### §1 Architecture Summary

Concise description of the server's runtime architecture: how tools are registered, how requests flow from MCP protocol → tool dispatch → handler → response. Include the 4-layer model, toolset system, and how offline vs TCP tools differ in their execution path. This section should give a reader who has never seen the code a working mental model in under 500 words.

### §2 Module Dependency Map

Which module imports what. Identify any circular dependencies, tight coupling, or modules that know too much about each other's internals. Note the mock seam pattern and how it enables testing.

### §3 Code Quality Review

For each source file, assess:
- **Consistency**: naming conventions, error handling patterns, code style
- **Correctness**: any bugs, logic errors, edge cases not handled, or dead code
- **Robustness**: error handling coverage, graceful degradation, input validation
- **Maintainability**: function sizes, complexity, clarity of intent
- **Test coverage gaps**: handlers or code paths not exercised by existing tests

Use a severity scale: CRITICAL (will cause production failures), HIGH (likely to cause issues), MEDIUM (code smell / tech debt), LOW (style / polish).

### §4 Handler Audit Table

For each of the 13 offline tools AND the 32 TCP tools, verify:
- Tool name in `tools.yaml` matches the handler's switch case / registration
- Params defined in `tools.yaml` match what the handler reads from `params`
- Any params that exist in yaml but aren't used by the handler (or vice versa)
- Return shape consistency (do similar tools return similar structures?)

Present as a table: `| tool_name | yaml_params | handler_params | match? | notes |`

Focus on mismatches — don't list every tool if they all match. Group by toolset.

### §5 Test Coverage Assessment

Map which code paths are tested vs untested. Specifically:
- Which offline tool handlers have direct test assertions?
- Which TCP tool handlers have direct test assertions?
- Which error paths are tested?
- Which params have test coverage for their edge cases?
- Any critical paths with zero test coverage?

The F0 verbose bug (fixed in `5aaa290`) was a param-passthrough bug that unit tests missed because `executeOfflineTool` was called directly with the right params, but the MCP wire path dropped the param. Flag any similar patterns where test coverage might be giving false confidence.

### §6 Risks and Recommendations

- Any architectural concerns for the upcoming Level 1+2 parser work (Agent 10)
- Any code quality issues that should be fixed before more features land
- Any test infrastructure gaps that should be addressed
- Suggestions for the orchestrator on sequencing or prerequisites

### §7 Quick Reference

Compact tables for orchestrator/agent use:
- File → line count → last-modified purpose
- Exported function index (name → file → brief description)
- Tool registration map (tool_name → handler_function → file:line)

---

## Constraints

- **Read-only** — no code changes, no git commits
- **No AI attribution**
- **Be specific** — cite file:line for any finding. "There might be issues" is useless; "offline-tools.mjs:1260 drops the params object" is useful.
- **Be honest** — if the code is solid, say so. Don't manufacture findings for completeness.
- **Length target**: 400-600 lines. Enough detail to be useful, concise enough to fit in an orchestrator's context alongside other docs.

---

## Final report format

```
Pre-Agent 9 Codebase Audit — Final Report

Files read: [N source + N test + N context]
Total lines reviewed: [N]
Findings: [N] CRITICAL, [N] HIGH, [N] MEDIUM, [N] LOW
Test coverage assessment: [summary]
Param-passthrough mismatches found: [N]
Architecture concerns for Level 1+2: [summary]
Deliverable: docs/audits/uemcp-server-codebase-audit-2026-04-16.md ([N] lines)
```
