# Sidecar Design Session — Resolve 5 Open Questions in blueprints-as-picture-amendment.md

> **Dispatch**: Immediately. Parallel-safe with Pre-Phase-3 Fixes Worker and EN-2 Worker (docs-only scope).
> **Type**: Design research — RESOLVE 5 open questions to stable positions that can feed Phase 3 scope refresh. NO code changes. NO new designs invented.
> **Duration**: 1-2 hours.
> **Deliverable**: `docs/research/sidecar-design-resolutions-2026-04-19.md` OR in-place amendments to the amendment file (blockquote convention).

---

## Mission

`docs/specs/blueprints-as-picture-amendment.md:131-138` has 5 open questions about the 3F sidecar design that have been outstanding since 2026-04-15. Audit B §4 flagged resolving these as a Phase 3 readiness unblocker (YELLOW → GREEN).

Under **D52 (near-plugin-parity)** and **DR-3 (3F sidecar writer as potential standalone early milestone)**, these questions have sharpened stakes: the sidecar writer may ship EARLIER than the rest of Phase 3, meaning these answers feed a sooner milestone.

Your job is to RESOLVE each question to a stable position (or explicitly flag as "still open, needs Noah design session") so Phase 3 scope refresh can proceed.

---

## Critical context

- Read `docs/specs/blueprints-as-picture-amendment.md` in full — parent spec at `docs/specs/blueprint-introspection.md` too.
- The 5 open questions are at lines 131-138 of the amendment.
- D45 locks 3F sidecar as canonical offline BP-read path (soft editor dependency).
- D48 locks S-A (name-only skeletal) as PURSUE; S-B (full pin trace) as FOLD-INTO-3F.
- DR-3 flags the "ship sidecar writer as standalone early milestone" decision point.
- D52 (pending D-log entry) formalizes near-plugin-parity for offline reads as explicit goal — affects how aggressively we pursue sidecar replacements.

---

## Method

For each of the 5 questions:

1. **State the question verbatim** (from the amendment file).
2. **Identify the decision axis** — what are the viable answers? What's the key trade-off?
3. **Recommend a position** with rationale grounded in D45/D48/D52/DR-3 context.
4. **Implementation implications** — how does this answer feed the sidecar-writer-plugin scope? How does it feed downstream offline-tool response shapes?
5. **Still-open flag** — if the question genuinely needs Noah's design input beyond research, explicitly flag with "RESOLUTION REQUIRED FROM NOAH."

---

## Inputs

1. `docs/specs/blueprints-as-picture-amendment.md` — the 5 questions + surrounding design context
2. `docs/specs/blueprint-introspection.md` — parent spec (dump format, related tool surface)
3. `docs/tracking/risks-and-decisions.md` — D44-D50 (and D51/D52 if logged by dispatch time)
4. `docs/tracking/backlog.md` — DR-3 for sidecar-writer scheduling context
5. `docs/research/level3a-skeletal-parse-study.md` (Agent 11.5) — offline pin-trace alternative cost analysis
6. `docs/research/level12-tool-surface-design.md` (Agent 9) — tool surface patterns to inherit

---

## Output format

### Recommended: `docs/research/sidecar-design-resolutions-2026-04-19.md`

For each of 5 questions:

### Q1 / Q2 / Q3 / Q4 / Q5 — [short title]

**Question (verbatim)**: [from amendment file]
**Decision axis**: [what's being decided]
**Options considered**: [2-3 options with trade-offs]
**Recommended resolution**: [specific answer]
**Rationale**: [grounded in D45/D48/D52/DR-3]
**Implementation implications**:
  - Sidecar writer scope: [how this shapes the plugin component]
  - Offline tool response: [how this shapes how reads consume the sidecar]
  - Amendment file update needed: [yes/no, what to amend]
**Still-open flag**: [yes/no — if yes, explicitly list what Noah needs to design]

Plus:

### Summary table
One-line per question: Question | Resolution | Still-open?

### §2 Downstream impact on Phase 3 scope refresh
How the 5 resolutions reshape Phase 3 plugin scope, specifically:
- What belongs in the sidecar writer (plugin component) — parameters, trigger points, output shape
- What belongs in offline tools (consumer side — already partly shipped per 3F amendment)
- Any resolution that calls for a new tool / spec we didn't have before

### §3 Confidence
HIGH/MEDIUM/LOW with reasoning.

---

## Constraints

- **Don't invent new design ground.** Your job is to resolve EXISTING open questions using the principles in the D-log. If an answer requires net-new design thinking (e.g., "we need a new spec to define X"), flag as still-open for Noah.
- No code changes. No yaml changes. No D-log edits.
- Amendment file edits via blockquote convention only (if you recommend any).
- Path-limited commits per D49. Desktop Commander for git.
- No AI attribution.
- Keep the deliverable tight — 5 resolutions × ~30-50 lines each + summary tables. Target ~300-400 lines max.

---

## Time budget

1-2 hours. If a specific question turns out to need genuine new design work, time-box the resolution attempt at 20 min, flag as still-open, and move on.
