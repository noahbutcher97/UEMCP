# Audit B — Goal-Alignment / Trajectory

> **Dispatch**: AFTER wave 4 (Cleanup Worker) lands. Can run parallel with Audit A (codebase health) — different file reads, different deliverable.
> **Type**: Research/audit hybrid. NO code changes, NO design authorship, NO decisions.
> **Deliverable**: `docs/audits/goal-alignment-audit-<date>.md` — sealed after creation; amendments via blockquote convention.

---

## Mission

Noah's question: "ensure the trajectory of our work aligns with the goal functionality." Translate that into a structured audit answering three specific sub-questions:

1. **Goal adherence**: for each stated UEMCP design principle (from CLAUDE.md, D-log, Noah's corrections), does the shipped state structurally honor it?
2. **Workflow coverage**: Agent Workflow Catalog projected 67% → 76% offline coverage post-Agent-10.5. Verify the projection empirically against current state. What's the actual coverage now?
3. **Phase 3 readiness**: given what's shipped, is the Phase 3 C++ plugin scope now well-defined? Or are there surprises that would reshape Phase 3?

This audit is NOT about finding bugs (Audit A does that). It's about answering whether we're building what we set out to build.

**You ARE**:
- Mapping each stated goal/principle to shipped evidence at file:line
- Re-running the Workflow Catalog's 100 queries (conceptually) against current tool coverage and measuring actual status
- Identifying trajectory drift: places where shipped state diverges from stated intent
- Flagging the Phase 3 readiness implications

**You are NOT**:
- Designing fixes (Audit A flags code-level issues; you flag intent-vs-execution gaps)
- Writing production code
- Modifying tool definitions

---

## Critical context

- Noah's stated principles (anchor your adherence check to these):
  1. **Offline reads are first-class** (D45/D48 context, Noah 2026-04-16 correction) — plugin is for writes + genuinely-offline-infeasible, not a substitute for reads.
  2. **yaml is single source of truth** for tool descriptions/params (D44)
  3. **Markers never silently drop** — every unsupported case emits an explicit marker (Agent 9 §1 rule)
  4. **3F sidecar has soft editor dependency** (D45) — not equivalent to pure offline
  5. **Three-layer offline BP stack** (D48): L0 structural + L1 semantic name-only + L2 spatial+trace-sidecar
  6. **Path-limited commits in parallel sessions** (D49)
  7. **Bundle related follow-on work** (D48 Mode A decision)
  8. **Deferred-with-trigger pattern** — D48 S-B, D45 L3A skeletal, D47 custom-struct resolver (before supersession) all have explicit reopening conditions

- The Workflow Catalog (`docs/research/agent-workflow-catalog.md`) has 100 queries. Each classified as SERVED_OFFLINE / SERVED_PARTIAL / SERVED_PLUGIN_ONLY / NOT_SERVED at time-of-writing. Re-measure against current shipped state.

- Test baseline will be 649+ when you run (Parser Extensions + Cleanup add ~10-15 assertions).

---

## Input files

1. `CLAUDE.md` — stated principles, current-state summary
2. `docs/research/agent-workflow-catalog.md` — 100-query catalog + §7a calibration amendment
3. `docs/tracking/risks-and-decisions.md` — D1-D50 (D44-D50 primary focus)
4. `docs/tracking/backlog.md` — deferred items with named triggers
5. `docs/specs/architecture.md` — original architecture + goal statement (read to re-anchor on vision)
6. `docs/specs/blueprints-as-picture-amendment.md` — 3F sidecar design
7. `docs/specs/phase3-plugin-design-inputs.md` — Phase 3 scope reference
8. `docs/research/level12-tool-surface-design.md` (Agent 9) — Option C intent
9. `docs/research/level3-feasibility-study.md` (Agent 11) — L3 categorization
10. `docs/research/level3a-skeletal-parse-study.md` (Agent 11.5) — S-A split verdict
11. `docs/research/level12-verification-pass.md` (Agent 9.5) — V9.5 corrections absorbed into shipped code
12. `tools.yaml` — canonical tool surface
13. `server/offline-tools.mjs` + `server/uasset-structs.mjs` — shipped handlers (for spot-check that principles hold)
14. Most-recent codebase audit (Audit A if it's landed) for cross-reference

---

## Method

### §1 Principle adherence scorecard

Produce a table: Principle | Stated where | Shipped evidence | Status | Notes

For each of the 8 principles above, cite file:line where principle is honored or flag violation. Status = HONORED / PARTIAL / VIOLATED.

Example check for Principle 2 (yaml-as-truth):
- Is `server.mjs:offlineToolDefs` gone? (Per D44 it was eliminated.)
- Does offline registration read yaml via `toolsetManager.getToolsData()`? (Verify at file:line.)
- Does `tools/list` === `find_tools` for all offline tools? (Prior audit had a Test 10 D44 invariant check — does it still pass?)

Each principle gets similar treatment.

### §2 Workflow coverage re-measurement

For the 100 queries in the catalog:
- Don't re-classify every one (too expensive). Instead, sample:
  - All 19 NOT_SERVED rows — has any been SERVED since catalog was written?
  - All 14 SERVED_PLUGIN_ONLY rows — any moved offline?
  - All 26 SERVED_PARTIAL rows — any upgraded to SERVED_OFFLINE via D46/D47/D48 shipping?
  - Random sample of 10 SERVED_OFFLINE rows — still served correctly?
- Build an updated coverage matrix vs the original
- Report: actual coverage % now vs catalog's 67% baseline + 76% projected

### §3 Trajectory drift check

For each major research deliverable (Agent 9, 9.5, 11, 11.5, Workflow Catalog):
- What did the research recommend?
- What actually shipped?
- Any divergence? (e.g., D47 two-pass recommended; tagged-fallback shipped per D50 pivot — documented, but are there others less-documented?)

### §4 Phase 3 readiness

Given shipped state, what's Phase 3's actual scope?
- What Phase 3 tools were planned and still needed (write ops + runtime state + reflection-only)?
- What's been absorbed offline (per D32/D37/D45/D48/D50)?
- Any Phase 3 tools that now have ambiguous status (e.g., a tool whose scope was 80% absorbed — is it still worth shipping the remaining 20%?)?
- Readiness assessment: green (ready to dispatch Phase 3 research/design), yellow (some ambiguities to resolve first), red (significant research needed before Phase 3)

### §5 Backlog accuracy (cross-reference to Audit A §7)

Audit A checks this; here just spot-check: is the backlog still capturing the right items? Anything accumulated in orchestrator conversation since the backlog was created that didn't make it in?

### §6 Open questions surfaced

Any trajectory question that can't be resolved from the evidence alone — e.g., "is this principle actually still desired, or was it superseded by a conversation I can't see?" Flag for Noah.

### §7 Confidence

HIGH / MEDIUM / LOW. Reasoning. Be honest about what's grounded vs inferred.

### §8 Final report

```
Audit B Final Report — Goal-Alignment / Trajectory

Principles honored:           N / 8
Principles partial:           N / 8
Principles violated:          N / 8
Workflow coverage actual:     [N%] (catalog claimed 67% baseline / 76% projected)
Phase 3 readiness:            [GREEN / YELLOW / RED]
Trajectory drift items:       [N flagged — summary]
Net assessment:               [trajectory-correct / minor-drift / significant-drift]
Open questions for Noah:      N
Confidence:                   HIGH/MEDIUM/LOW
Deliverable:                  docs/audits/goal-alignment-audit-<date>.md
```

---

## Constraints

- Deliverable is SEALED. Amendments via blockquote convention only.
- Every finding cites file:line or specific D-log / research-doc section.
- No new principles invented during audit. If you think a new principle SHOULD be added, flag as open question, don't bake it in.
- No code changes. No yaml changes. No D-log edits. No backlog edits.
- No AI attribution.
- Path-limited single commit at the end (your audit file only).

---

## Parallelization note

Audit A (codebase health) may be running in parallel. Different file scope (they're in server/, you're in docs/), different deliverables. D49 path-limited commits on both sides prevents shared-index collisions.

---

## Final commit

```
git commit docs/audits/goal-alignment-audit-<date>.md -m "Audit B: goal-alignment + trajectory ..."
```

Desktop Commander for git, shell: "cmd".

Time budget: 2-3 hours. Principle adherence (§1) is the scannable bulk; workflow re-measurement (§2) can be deeper. Phase 3 readiness (§4) is the load-bearing conclusion — give it room.
