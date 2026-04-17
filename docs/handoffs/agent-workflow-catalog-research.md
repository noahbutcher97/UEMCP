# Agent Workflow Catalog Research Handoff

> **Dispatch**: Parallel with Agent 10.5 (no file conflicts — research-only in docs/research/).
> **Type**: Research — catalog agent queries against UE projects, cross-reference with current tool coverage
> **Deliverable**: `docs/research/agent-workflow-catalog.md`
> **Driver**: Noah 2026-04-16 — "offline reads are first-class; we want to answer questions that would have required direct editor checks from CLI agent context." No existing document enumerates what those questions are; this closes the gap.

---

## Mission

Produce a catalog of realistic queries a code-writing agent (Claude Code or similar CLI agent) wants to run against a UE 5.x project. For each query, cross-reference whether current UEMCP tooling serves it, serves it partially, or doesn't cover it.

The catalog feeds:
- Future tool surface decisions (Phase 3 plugin scope refresh, downstream research).
- Validation that the "offline reads are first-class" principle (D45/D48) is honored in practice.
- A concrete test corpus — "does this actually answer the questions agents ask?"

**You are NOT**:
- Designing new tools. Surface gaps are flagged for future decision, not spec'd.
- Evaluating implementation cost. That's scoping work, not catalog work.
- Re-litigating decisions in the D-log.

**You ARE**:
- Brainstorming + categorizing realistic agent queries, grounded in the workflows this project is designed to serve.
- Cross-referencing each query against `tools.yaml` + current offline tool coverage (post-Agent-10 shipping).
- Flagging gaps + over-served areas for future attention.

---

## Critical context

- UEMCP at `D:\DevTools\UEMCP\`, git on `main`.
- Agent 10 shipped Level 1+2+2.5 + Option C tools (HEAD should be post-`9144664`). 561/561 tests green.
- Agent 10.5 is starting/in-flight with the bundled D46+D47+D48+5-engine-struct follow-on.
- Design principles in play (MUST anchor your analysis to these):
  - **Offline reads are first-class** (Noah 2026-04-16). Plugin is for writes + genuinely-offline-infeasible reads, NOT a substitute for reads the offline tier could reasonably handle.
  - **3F sidecar has soft editor dependency** (D45). It's editor-dependent-to-produce; not equivalent to pure offline parsing.
  - **Three-layer offline BP stack** (D48): L0 structural (`inspect_blueprint`), L1 semantic name-only (S-A), L2 spatial + trace (3F sidecar).
- The two target projects:
  - **ProjectA** (UE 5.6 combat game). Primary fixture source.
  - **ProjectB** (UE 5.7 BreakoutWeek). Secondary fixture source, less mature.

---

## Method

### 1. Brainstorm queries (first pass)

Enumerate across workflow categories. Don't filter; capture everything plausible. Categories to cover at minimum:

- **Introspection** ("why does this BP do X?") — find events, trace back to variables, find what calls what.
- **Impact analysis** ("what depends on this asset?") — references, referrers, dependency graph.
- **Scan / grep** ("which BPs / actors / assets use component Y?") — project-wide searches.
- **Debug context** ("why is this actor failing?") — read component config, check gameplay tags, find relevant BPs.
- **Refactoring prep** ("is it safe to rename this variable?") — find all uses + assignments.
- **Documentation generation** ("generate docs for this BP") — full BP surface read.
- **Project orientation** ("what's in this project?") — asset counts, toolset summaries, gameplay tag hierarchy.
- **Configuration** ("what are this game's input bindings / config values?") — `.ini` reads, DataTables.
- **Asset audit** ("which assets exceed 5 MB? which BPs have no references?") — metadata queries with filters.
- **Comparison / diff** ("what changed between these two BPs?") — rarer but real.
- **Generation / scaffolding prep** ("what's a typical BP structure I should mirror?") — sample reads.

Aim for ~40-80 queries total across categories. Concrete phrasing, not abstract.

### 2. Classify each query

For each query, tag:

- **Answer surface** — what would an ideal answer look like? (Asset list? Graph? Property values? Structural map?)
- **Tool coverage today** — one of:
  - `SERVED_OFFLINE` — current offline tool answers it directly.
  - `SERVED_PARTIAL` — offline gives some of the answer; full answer needs plugin/sidecar.
  - `SERVED_PLUGIN_ONLY` — realistic offline coverage isn't possible; plugin is right answer.
  - `NOT_SERVED` — no current tool covers this, even via plugin.
- **Which tool(s) if served** — cite tool names from `tools.yaml`.
- **Frequency estimate** — `HIGH` (probably 10x/day in active agent work), `MEDIUM` (once/day), `LOW` (occasional).
- **Blocks what** — if NOT_SERVED, does this gap actually block a workflow Noah cares about, or is it theoretical?

### 3. Aggregate + report

After classifying, produce the analysis sections (see output format below).

---

## Inputs

Read first:
1. `tools.yaml` — the authoritative tool catalog. Scan all 120 tools + the 6 management tools. This is the surface you're cross-referencing.
2. `CLAUDE.md` — project overview, architecture, current state (lists shipped tools + their semantics).
3. `docs/research/level12-tool-surface-design.md` (Agent 9) — §1 workflows Level 1+2 unlocks; §3 Phase 3 scope table (what's covered vs plugin-only).
4. `docs/research/level3a-skeletal-parse-study.md` (Agent 11.5) — §4.3 workflow table (find/grep vs trace/spatial split).
5. `docs/tracking/risks-and-decisions.md` — D30 offline-first sequencing, D32/D37 Phase 3 scope reductions, D45 editor dependency, D48 S-A split.
6. `docs/specs/blueprints-as-picture-amendment.md` — 3F sidecar traversal verbs, for "what does sidecar give us vs not" reference.
7. `docs/specs/architecture.md` if present — project architecture + phase plan.

Optional but useful:
- Scan a few actual ProjectA BPs (via `inspect_blueprint`) to understand what a realistic target looks like. Helps concretize query phrasings.
- Look at the conformance-oracle contracts doc (`docs/specs/conformance-oracle-contracts.md`) for what UnrealMCP was designed for — signals what other agents/users have asked for historically.

---

## Output format

Write `docs/research/agent-workflow-catalog.md`:

### §1 Purpose + method
One paragraph. Frame what the catalog is for.

### §2 Query catalog
Main table. One row per query. Columns:

| # | Category | Query (plain language) | Ideal answer shape | Current coverage | Tool(s) | Frequency | Gap notes |

Aim for 40-80 rows. Concrete query phrasings. Real examples of how an agent would actually ask.

### §3 Category summary
For each category (introspection, impact analysis, etc.), aggregate:
- Total queries in category.
- Fully served: N
- Partially served: N
- Plugin-only: N
- Not served: N
- Headline gap (if any).

### §4 Coverage gaps — ranked
List `NOT_SERVED` and `SERVED_PARTIAL` rows, ranked by (frequency × workflow importance). For each:
- What the gap is.
- Whether offline coverage is theoretically possible or would require plugin.
- Downstream implications (would serving this obviate a Phase 3 tool? Shrink a toolset?).

### §5 Over-served areas (optional)
Are there tools in `tools.yaml` that cover queries no agent actually runs? Candidates for deprecation. If any jump out, flag.

### §6 Informing future work
What does the catalog tell us about:
- Phase 3 plugin scope (what must stay plugin-only vs what could move offline with more research)?
- 3F sidecar writer scope (what find/grep belongs to S-A vs trace/spatial belongs to sidecar)?
- Tool surface conventions (any patterns that suggest new consolidated tools)?

### §7 Open questions for Noah
Anything that can't be resolved from the references alone — e.g., "is this query actually common in your workflow, or theoretical?"

### §8 Confidence
HIGH / MEDIUM / LOW. Reasoning — you're generating examples, so confidence is about query realism, not measurement precision.

---

## Constraints

- **No design authorship** — gaps get flagged, not spec'd. Propose "should be served" not "here's the tool I'd build."
- **Query realism matters** — ground in what Noah actually does with Claude Code in UE projects, not in academic completeness. If a query phrasing feels forced, cut it.
- **No new D-log entries** — this is research feeding future decisions.
- **Parallel with Agent 10.5** — stay out of their file scope entirely. Your work is in `docs/research/` only.
- **No code changes**, not even throwaway.
- **No AI attribution** anywhere.

---

## Final report format

```
Agent Workflow Catalog — Final Report

Queries catalogued: [N] across [M] categories
Coverage distribution:
  SERVED_OFFLINE:       [N] ([%])
  SERVED_PARTIAL:       [N] ([%])
  SERVED_PLUGIN_ONLY:   [N] ([%])
  NOT_SERVED:           [N] ([%])

Top 3 gaps (by frequency × importance): [list]
Top 3 over-served areas if any: [list or "none identified"]

Offline-reads-first-class principle honored? [yes / partial / gaps exist]
  Evidence: [one-paragraph summary]

Phase 3 plugin scope implications: [list 2-3 specific items]
Open questions for Noah: [N]
Confidence: [HIGH / MEDIUM / LOW]
Deliverable: docs/research/agent-workflow-catalog.md ([N] lines)
Time spent: [N minutes]
```
