# Phase 3 Post-M-enhance Audit Worker

> **Dispatch**: Fresh Claude Code session. **Research / code-review deliverable** — read shipped code, write findings. No implementation, no fixes (findings get queued as follow-on workers per orchestrator triage).
> **Type**: Code audit + workflow-composition review + save-hook invariance analysis. Pure docs output at `docs/audits/phase3-post-m-enhance-audit-2026-04-24.md`.
> **Duration**: 2-3 sessions.
> **D-log anchors**: D70 (S-B-base invariants — NodeGuid triple-keying, bytes-vs-runtime format), D72 (Verb-surface NodeGuid-hex format mismatch interop hazard), D74 (M-enhance handoff drift patterns), D77 (M-enhance ship-complete totals).
> **Deliverable**: audit findings document with numbered findings (severity-classified) + per-finding: location + root cause + recommended fix + blast radius estimate.

---

## Mission

Phase 3 has shipped 9 named workers across 4 waves, landing ~36 M-enhance tools + 16 plugin C++ handlers + S-B-base edge-topology parser + 5 Verb-surface traversal verbs + save-hook + Content Browser menu + batch commandlet. Cumulative ~170 LOC/assertion ratio across 10 test files (1203 assertions).

**That's a lot of code landed fast.** Good cadence doesn't mean no bugs — it means inconsistencies, edge-case misses, and invariant drift can compound silently under parallel worker dispatch. This audit gives a cross-cutting fresh-eyes pass BEFORE Wave 4 (M3/M4/M5) adds another ~15-25 sessions of new surface.

Your deliverable is a **findings report**, not fixes. Orchestrator triages findings into follow-on worker dispatches.

---

## Scope — in

### §1 Tier A: Code-level code review

Read the following with fresh eyes, flag anything suspicious:

**S-B-base parser** (`server/uasset-parser.mjs`):
- D70 post-tag 4-byte sentinel: is it documented inline in the parser code? Is the magic number explained?
- FEdGraphPinType parse: bool = int32 (D76) — is this documented at the read site?
- `parsePinBlock` + `resolveLinkedToEdges`: error paths when FPackageIndex doesn't resolve, when pin count is 0, when LinkedTo target is self.
- `extractBPEdgeTopologySafe`: does the Safe suffix's ENOENT handling cover all paths where `readFile` could fail? What about EACCES (permission denied)?
- (graph_name, node_guid, pin_id) triple-keying: confirm every lookup uses triples, not node_guid-only.

**Verb-surface handlers** (`server/offline-tools.mjs` — the 5 verb handlers):
- `toOracleHexGuid` helper: is it applied consistently everywhere a NodeGuid is compared across M-spatial ↔ S-B-base / Oracle-A-v2 boundaries?
- `bp_trace_exec` name-convention classifier (D72): which pin names default to "data" when they're actually exec? List the false-positive risks.
- `bp_neighbors` edge mode: does it deduplicate edges that appear in both directions, or emit twice?
- `bp_show_node` / `bp_list_entry_points` M-new extensions: do they honor M-spatial's existing tokens or rename them (D59 forward-compat rule)?
- All 5 verbs wrapped by `withAssetExistenceCheck`? Spot-check each.

**M-enhance server-side** (`server/rc-tools.mjs`, `server/menhance-tcp-tools.mjs`, `server/connection-manager.mjs`, `server/rc-url-translator.mjs`):
- `connectionManager.httpCall`: retry behavior? Timeout handling? HTTP 4xx vs 5xx vs network error — do they normalize to the same error envelope?
- `buildRcRequest`: URL-injection safety — what if asset_path contains `..` or `%`? Is encoding correct?
- PARTIAL-RC tools (D76): currently all dispatch to plugin-TCP. Is the dispatch code extensible so future RC augmentation is a single-line toggle, or is it baked in?
- Cross-transport error normalization: does an HTTP 500 vs TCP timeout produce the same shape to the agent?

**M-enhance plugin C++** (`plugin/UEMCP/Source/UEMCP/Private/*.cpp` — the 15 new handlers):
- `CompileDiagnosticHandler.cpp`: what if BP is already compiling when request comes in? Thread safety on GEditor access?
- `ReflectionWalker.cpp`: does it handle UClass with null UberGraph, deleted properties in hot-reloaded classes, struct-within-struct cycles?
- PIE handlers (`start_pie`/`stop_pie`): D75 flagged race w/ TCP response; is the handler already game-thread-flushed? If not, does it need to be?
- `SidecarWriter`: what if write path doesn't exist (no Saved/ dir)? What if file is open in another process? What if write succeeds but fsync fails?
- `DumpBPSidecarCommandlet`: `-PathRoot=/Game/...` recursive scan — does it skip non-BP assets? Handle corrupt/un-loadable BPs gracefully?

### §2 Tier B: Workflow composition audit

Survey the tool surface as an agent would compose it:

- Run `list_toolsets` mentally: does every toolset have sensible TOOLSET_TIPS? D77 says 8 tips shipped — spot-check 3-4 of them for accuracy against the tools in that toolset.
- Pick 3 realistic agent workflows and trace them through the tool surface:
  1. "Find BPs calling function X, compile them, extract their exec chains"
  2. "Generate sidecars for all BPs in /Game/Foo, then read property defaults"
  3. "List level actors, get their references, filter by class"
  For each: do the tools compose? Are return shapes pipeline-friendly? Any format mismatches (pin_id hex case, dotted-key graphs, etc.)?
- Check for **ergonomic dead-ends**: tools whose output can't be fed to another tool without manual shape-adaptation.
- Check for **token-budget hazards**: tools whose default response could exceed MCP's response-size cap on large BPs / levels.

### §3 Tier B: Save-hook invariance analysis

Read `SidecarWriter.cpp` + the `OnObjectPreSave` delegate registration. Without running tests, analyze:

- What if editor crashes mid-save (between delegate fire and file-write completion)? Partial sidecar on disk?
- What if two saves fire concurrently (two tabs, asset + referenced-asset both dirty)? Race on file handle?
- What if sidecar write fails (disk full, permission, path too long on Windows)? Does the BP save itself still succeed? Is the failure logged?
- What if BP save is cancelled mid-stream (via editor prompt, via error during cook)?
- What if `OnObjectPreSave` fires for a non-BP object type? (e.g., material, level) — does the handler filter correctly?
- What if BP is being compiled AND saved at the same time? (Auto-compile on save is a common workflow.)

Each edge case: flag if code handles it vs not, with recommended hardening.

### §4 Tier B: Cross-transport transaction semantics (FA-ε §Open 3)

Read the code paths for:
- RC `rc_set_property` with `access=WRITE_TRANSACTION_ACCESS` — enters UE's undo stack.
- TCP handlers that perform edit operations inside `FScopedTransaction`.
- Are the two transaction surfaces independent, or does one nest inside the other when a PARTIAL-RC tool dispatches to plugin TCP?
- If a agent-visible tool runs `rc_set_property` followed immediately by a plugin TCP edit, do both end up in the same undo entry or separate ones?

Analyze + propose test plan. Don't implement test yet — that's M3 scope when it lands.

### §5 Tier C: D44 yaml-matches-code invariant spot-check

`tools.yaml` declares ~122 tools; ~100 are currently live. Each tool entry has `params` + `returns` shape description. Code handlers must match what yaml declares.

Spot-check 10 M-enhance tools (5 RC + 5 TCP). For each:
- yaml `params` section vs `params.X` reads in the handler — every declared param used? Every read param declared?
- yaml `returns` shape vs actual return shape — any drift?

Findings go in audit report as "D44 lint candidates" (EN-5 backlog item is the mechanized solution; this pass is the manual inventory).

### §6 Tier C: CP3 C++ deep-read

1281 LOC landed in commit `ca479f7` across 8 new plugin source files + 2 modified. Do a structural read:
- Are error paths consistent across handlers (null checks, log levels, error-envelope construction)?
- Any copy-paste bugs? (Workers writing 10 handlers often carry typos from one to the next.)
- `MCPCommandRegistry` registration: all 10 handlers registered in the right order, no duplicates, no missing?
- Include graph: any circular includes, unused includes, missing forward declarations?

---

## Scope — out

- **Running tests** — you READ code, you don't run tests (test baseline is already green at 1203).
- **Implementing fixes** — orchestrator triages your findings into follow-on worker dispatches.
- **Re-designing architecture** — flag architectural concerns if you see them, don't propose rewrites.
- **Live-editor smoke testing** — that's a human action (captured separately).
- **Performance profiling** — separate audit if warranted later.
- **Security audit** — UEMCP is localhost-trusted (LAN threat model per D23). Don't chase OWASP-level concerns; flag anything egregious.

---

## Reference files

### Tier 1 — Scope sources
1. `docs/tracking/risks-and-decisions.md` D70 + D72 + D74 + D76 + D77 (recent milestones + gotchas).
2. `docs/handoffs/m-enhance-hybrid-transport.md` (scope reference + §Biggest-unknowns).
3. `docs/research/fa-epsilon-tcp-vs-rc-2026-04-21.md` §Open items (what was deferred for post-ship audit).

### Tier 2 — Code under review
Primary targets (big-LOC recent landings):
4. `server/uasset-parser.mjs` (parser + S-B-base pin-block extensions)
5. `server/offline-tools.mjs` (Verb-surface 5 verbs + extractBPEdgeTopologySafe orchestrator)
6. `server/rc-tools.mjs` (11 FULL-RC tools)
7. `server/menhance-tcp-tools.mjs` (23 TCP-dispatch tools)
8. `server/connection-manager.mjs` (Layer 4 HTTP client + retry + timeout)
9. `server/rc-url-translator.mjs` (URL-scheme builder)
10. `plugin/UEMCP/Source/UEMCP/Private/*.cpp` (15 new plugin handlers + SidecarWriter)
11. `plugin/UEMCP/Source/UEMCP/Private/Commandlets/DumpBPSidecarCommandlet.cpp`
12. `tools.yaml` (yaml declarations for spot-check)

### Tier 3 — Tests (for cross-reference, not modification)
13. `server/test-verb-surface.mjs`, `server/test-rc-wire.mjs`, `server/test-s-b-base-differential.mjs`, `server/test-tcp-tools.mjs`.

---

## Deliverable format

New file: `docs/audits/phase3-post-m-enhance-audit-2026-04-24.md`. Structure:

```markdown
# Phase 3 Post-M-enhance Audit

**Audit date**: 2026-04-24
**Scope**: Phase 3 wave 1-3 shipped code (M1, M-spatial, Oracle-A/v2, S-B-base, Verb-surface, M-enhance)
**Test baseline at audit**: 1203 passing / 0 failing
**Auditor**: [fresh-eyes Claude Code worker]

## Executive summary

[1-paragraph overall health assessment — are the wheels on straight, or is there a systemic pattern of concern?]

## Findings

### F-1 [severity: high/medium/low] [title]

**Location**: file:line
**Root cause**: ...
**Blast radius**: ... (who's affected if unfixed)
**Recommended fix**: ... (1-2 sentences; orchestrator decides dispatch)

### F-2 ...
```

Severity rubric:
- **High**: silent data corruption, security hole, violation of a documented invariant (e.g., D70 NodeGuid triple-keying violated)
- **Medium**: edge case that causes user-visible failure, performance cliff, documented "unknown" that can now be resolved
- **Low**: code smell, missing comment, typo, yaml-code drift in a rarely-used param

Target 15-30 findings total. Fewer is OK if the code's genuinely clean; more is OK if you see a pattern. Don't manufacture findings.

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **Path-limited commits per D49** — `docs/audits/*` only.
- **No AI attribution**.
- **No code changes to server/, plugin/, server/test-*.mjs** — pure read + write findings doc.
- **Single commit preferred**.
- **2-3 sessions expected**; if running long, ship partial findings as Session 1 commit + continue.

---

## Final report to orchestrator

Report (under 250 words):
1. Commit SHA.
2. Total findings count by severity tier.
3. Top 3 highest-severity findings summarized (title + root cause one-liner each).
4. Any systemic patterns observed (e.g., "error-path null-checks are inconsistent across plugin handlers" vs "no pattern; code is clean").
5. Recommended follow-on worker dispatches ordered by priority.
6. Open items you flagged but didn't analyze deeply (warrant their own future audit).
