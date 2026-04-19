# MCP-Wire Integration Test Harness Worker

> **Dispatch**: AFTER Pre-Phase-3 Fixes Worker lands (needs z.coerce fix to produce a stable test baseline).
> **Type**: Infrastructure — builds a new test layer that exercises tools through the real MCP protocol path.
> **Duration**: 2-3 sessions (~3-5 hr).
> **Driver**: Manual-tester Flag #1 (MCP Zod-coerce blocker) — demonstrated that unit tests ≠ agent-facing usability. Historical: Agent 9 Q2/Q3, Agent 9.5 F0-class risk flagging.

---

## Mission

UEMCP's 709+ assertions all call handlers DIRECTLY with pre-typed params. This bypasses the MCP wire path entirely — the Zod schema, the SDK's type coercion (or lack thereof), the JSON stringification/parsing, the response wrapping. The Zod-coerce blocker (z.number/z.boolean rejecting stringified values) shipped undetected because every test bypassed the layer where it manifests.

Build an MCP-wire integration test harness that exercises a representative sample of tools through the actual MCP protocol — JSON-RPC request/response, including the string-stringification the Claude Code wrapper does to typed params.

This harness becomes the structural fix for an entire class of F0-level regressions.

---

## Critical context

- **Not a replacement for unit tests** — complement. Unit tests still cover per-handler logic fast; harness covers wire-layer contracts slowly.
- **Target the common offenders** — focus on the classes of regressions unit tests can't catch:
  1. Zod schema accepting/rejecting wire-format values (coerce behavior)
  2. yaml ↔ registered schema ↔ live tools/list response agreement (D44 invariant at runtime, not just at registration time)
  3. MCP error-response shape when tool throws
  4. Response content-type wrapping + JSON.stringify round-trip on large responses (truncation, BigInt edge cases)
  5. tools/list_changed notification timing when toolsets toggle
- **Keep it lightweight** — building a full MCP client is overkill. Enough harness to post JSON-RPC to the server and assert on response.

---

## Implementation approach

### Option A — In-process McpServer instance + direct transport mock

Spin up `McpServer` in-process. Build a minimal fake transport that captures outbound responses + lets test code post inbound JSON-RPC messages. Assert on response shapes.

**Pros**: no subprocess, no stdio, fast. Can run in same test runner as existing tests.
**Cons**: doesn't exercise stdio specifically; potential gap if stdio transport has quirks (probably fine in practice).

### Option B — Subprocess `server.mjs` + actual stdio pipe

Spawn `server.mjs` as a subprocess. Write JSON-RPC to its stdin. Read from stdout.

**Pros**: exercises the real production path end-to-end.
**Cons**: slow (subprocess spawn cost). Harder to integrate into test runner. Makes test runtime >100ms per assertion.

### Recommendation

**Start with Option A.** Covers ~90% of the defect surface at 1/10 the overhead. Option B becomes worth it only if a specific stdio-level defect surfaces that A couldn't catch — defer as a follow-on.

---

## Scope — what to cover

**Phase 1 (must-have)**:
- Test each offline tool's Zod schema accepts stringified versions of typed params (the z.coerce blocker test). Validates F-1 from the Pre-Phase-3 Fixes Worker end-to-end.
- Test `tools/list` response contains all shipped offline tools with matching descriptions against yaml (runtime D44 invariant).
- Test a few representative tools' happy-path tool/call response shapes.

**Phase 2 (should-have)**:
- Test tool/call error-response shape when handler throws
- Test `tools/list_changed` notification timing (enable/disable toolset → verify notification)
- Test response-size truncation path (max_bytes in read_asset_properties)

**Phase 3 (nice-to-have, defer if time budget hit)**:
- TCP tool mock-seam equivalents through MCP wire
- Management-tools path

Target: Phase 1 complete in session 1; Phase 2 in session 2; Phase 3 ONLY if time remains.

---

## File scope

| File | Action |
|---|---|
| `server/test-mcp-wire.mjs` | **NEW** — the harness itself + its assertions |
| `server/test-helpers.mjs` | Extend if needed with MCP-wire-specific factory helpers |
| CLAUDE.md | Add `test-mcp-wire.mjs` to the test rotation table (both primary + supplementary rotations — depends on where it fits; likely primary given it's a structural invariant check) |
| (possibly) `server.mjs` | Only if server.mjs needs a testability shim that lets the harness mount McpServer cleanly |

**Do NOT touch**: `uasset-parser.mjs`, `uasset-structs.mjs`, `offline-tools.mjs` (handler code is correct; your job is testing the wire path around them), `tools.yaml`, `docs/tracking/`.

---

## Constraints

- **Path-limited commits per D49**.
- Desktop Commander for git (shell: "cmd").
- No AI attribution.
- Tests must stay green — your additions count as NEW assertions.
- Target: harness adds ≥20 assertions covering Phase 1 scope at minimum.
- Performance budget: test-mcp-wire.mjs runtime ≤5s (Phase 1); ≤15s total (all phases).

---

## Final report

```
MCP-Wire Integration Test Harness Worker Final Report

Phase 1 (must-have): [shipped/partial]
  - Zod coerce wire-layer assertions: [N]
  - tools/list runtime D44 invariant: [yes]
  - Happy-path tool/call shapes: [N tools covered]
Phase 2 (should-have): [shipped/partial/skipped]
  - Error-response shape: [yes/no]
  - tools/list_changed timing: [yes/no]
  - Truncation-path coverage: [yes/no]
Phase 3 (nice-to-have): [shipped/partial/skipped]

Harness implementation: [Option A / Option B / Hybrid]
New test file: server/test-mcp-wire.mjs ([N] lines)
New assertions: [N]
Total test baseline after: [X] (was [baseline])
Performance: test-mcp-wire.mjs runs in [N ms/s]
Commits: [list SHAs]
Time spent: [N min]
Items deferred: [list]
```
