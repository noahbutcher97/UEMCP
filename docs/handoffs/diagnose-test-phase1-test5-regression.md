# Handoff: Diagnose test-phase1.mjs Test 5 regression + audit recent work for related issues

**From**: Orchestrator (Noah's seat)
**Date opened**: 2026-04-15
**Worker type**: Diagnostic / read-only investigation (no code changes beyond minimal repro; fixes proposed, not applied)
**Deliverable**: A single markdown report at `docs/audits/test-phase1-test5-regression-2026-04-15.md` with: (1) root cause of the two failures, (2) a proposed fix (code diff or test update, your call with reasoning), (3) any *other* issues you surface while tracing — regressions, stale tests, dead code, spec drift — from work that landed since the last clean run.
**Scope**: Investigation. You may run tests. You may read anything. You may write a throwaway minimal-repro file under `/tmp/` or the outputs dir. Do NOT commit. Do NOT modify `server/*.mjs` or `tools.yaml` or production docs.

---

## The failures

Last run of `server/test-phase1.mjs` produced 34 passed / 2 failed. Both failures are in Test 5 ("Accumulation and shedding"):

```
═══ Test 5: Accumulation and shedding ═══
  ✓ offline auto-enabled on load
  ✗ actors correctly reported unavailable (no editor)
  ✓ gas correctly reported unavailable (no plugin)
  ✓ offline disabled successfully
  ✓ offline re-enabled successfully
  ✓ offline in enabled set
  ✗ actors not in enabled set
```

**Pre-regression baseline**: Before Phase 2 TCP work landed, this test was 36/36 green. The `actors` toolset was expected to report *unavailable* when no editor is running (no TCP health check passes on 55557), and therefore should not appear in the enabled set after an enable attempt.

**Run command** (from CLAUDE.md):
```
cd /d D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA&& node test-phase1.mjs
```
Note the CMD quirk — no space before `&&` or the env var gets a trailing space.

---

## Context you need (inlined)

### What changed recently

Phase 2 TCP client work landed across three toolsets:
- `actors` (10 tools) — TCP:55557
- `blueprints-write` (15 tools) — TCP:55557
- `widgets` (7 tools) — TCP:55557

All three are gated behind `ConnectionManager` health checks. The `actors` toolset is the one Test 5 exercises — it's the canonical "unavailable when no editor" fixture.

### Hypothesis hooks (don't anchor on these; verify)

Plausible root causes, in rough order of likelihood:

1. **Availability reporting changed** — `ToolsetManager.isToolsetAvailable(name)` or whatever it's now called may be defaulting to "available" when a health check hasn't been performed yet, vs returning unavailable-until-proven-healthy. The pre-Phase-2 code didn't need a health gate; the new code may short-circuit.
2. **Enable path no longer gated on availability** — `enable('actors')` may be adding to the enabled set before the health check resolves, or the enabled-set is populated regardless of availability outcome.
3. **Mock TCP seam leaking into Test 5** — test-mock-seam.mjs uses `FakeTcpResponder`. If test-phase1.mjs accidentally shares state or a fake responder is installed as a side effect of module load, `actors` would appear available.
4. **Test expectations stale** — the new behavior may actually be *correct* (e.g., optimistic enable with deferred health check) and Test 5's expectations need updating. If so, the fix is in the test, not the code.
5. **Layer routing quirk** — the `actors` toolset now has a `layer: tcp-55557` annotation in tools.yaml. If availability is being derived from "does the layer exist in the config?" rather than "did the TCP health check succeed?", it would falsely report available.

Treat all of these as leads, not conclusions. Walk the actual code.

### Files to trace

- `server/test-phase1.mjs` — the failing test. Start here: understand *what* Test 5 is asserting and how it's calling into ToolsetManager / ConnectionManager.
- `server/toolset-manager.mjs` — `enable()`, `disable()`, `getEnabledNames()`, and whatever availability-check method exists.
- `server/connection-manager.mjs` — `isLayerHealthy()` / `checkHealth()` / cache; 30s health cache mentioned in CLAUDE.md.
- `server/tool-index.mjs` — toolset metadata including `layer` field.
- `tools.yaml` — `actors:` block, layer annotation.
- `server/tcp-tools.mjs` — Phase 2 TCP tool registration; may register in a way that affects availability.
- Git log since the last known-green state (whatever commit tagged Phase 1 complete or the commit preceding the Phase 2 landing).

### Known-good reference

`test-mock-seam.mjs` (45 assertions) and `test-tcp-tools.mjs` (218 assertions) are both passing. That tells you the TCP-tool *handlers* work correctly when given a mock; the regression is specifically in the *availability/enable-set plumbing* that test-phase1.mjs exercises without a mock.

---

## What to produce

`docs/audits/test-phase1-test5-regression-2026-04-15.md` with these sections:

### §1 Root cause

A one-paragraph statement of *the* cause, with citations: file:line references to the specific code that produces the wrong behavior, and a short trace of how Test 5's assertions end up failing (what function returns what, and why that's wrong).

### §2 Proposed fix

Either:
- A code change (show the diff as a fenced block, with file path header), with reasoning for why this is the right layer to fix at — or
- A test update (show the diff), with reasoning for why the new behavior is actually correct and the test expectations are stale.

Pick one. If there's a judgment call, state it plainly and recommend. Don't apply the fix.

### §3 Collateral findings

While tracing, note anything else you notice that looks wrong, stale, or smelly in work that's landed recently. Candidates to look for (non-exhaustive):
- Other tests with stale expectations vs new code paths
- Dead code left behind from the Phase 1 → Phase 2 transition
- Inconsistencies between `tools.yaml` and what's actually registered in server.mjs
- Cache TTL or invalidation logic that looks wrong given the new TCP-tool patterns
- Error normalization in `extractWireError` vs the three error formats documented
- Anything in ConnectionManager that assumes a single in-flight command per layer but doesn't actually enforce it
- Mock seam leaks or shared-state risks between test files

Cap this section at 5 findings. For each: one sentence description, file:line, severity (low/medium/high), recommended action (one sentence).

### §4 Open questions

If anything requires Noah's judgment (e.g., "is the new availability-on-load-rather-than-on-enable behavior intentional?"), list it here. Max 3.

---

## What NOT to do

- Do not modify `server/*.mjs`, `tools.yaml`, or any production doc.
- Do not dispatch sub-agents.
- Do not touch Agent 3's in-flight parser work (`server/uasset-parser.mjs` — currently being extended with name table / export table / AssetRegistryData).
- Do not edit the Phase 3 research handoff or the broader research report — different worker, different lane.
- Do not run `test-tcp-tools.mjs` or `test-mock-seam.mjs` as a regression check — they're known-passing and not the issue. Focus on `test-phase1.mjs` and the code paths it exercises.
- Do not investigate the two finished worker-streams (Agent 2 Phase 2 landing, Agent 3 parser) beyond noticing issues that surface organically while tracing Test 5.

## Termination criteria

You are done when `docs/audits/test-phase1-test5-regression-2026-04-15.md` exists with §1–§4 populated and you've sent a ≤200 word final report summarizing:
- The root cause in one sentence
- Your fix recommendation (code or test) and why
- How many collateral findings you surfaced and their highest severity
- Any open question Noah needs to resolve before the fix can be applied

No commits. No state file update. Pure diagnostic work.
