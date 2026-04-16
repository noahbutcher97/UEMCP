# Agent 9 Handoff — Tool Surface Design: Level 1+2 Property Data

> **Dispatch**: After Agent 8 delivers `docs/research/uasset-parser-audit-and-recommendation.md`
> **Depends on**: Agent 8 (research audit)
> **Type**: Design research — NO code changes
> **Deliverable**: `docs/research/level12-tool-surface-design.md`

---

## Mission

Given that Level 1+2 property parsing will surface tagged properties and struct values from `.uasset`/`.umap` files offline, decide HOW that data reaches callers. The two poles are:

**Option A — Fold into existing tools**: `list_level_actors` gains `transform` and `properties` fields, `inspect_blueprint` gains `variable_defaults`, `get_asset_info` gains `properties`. No new tools.

**Option B — New dedicated tool**: `read_asset_properties` (or similar) takes an asset path + optional export name and returns all readable properties. Existing tools stay as-is but can reference the new one.

**Option C — Hybrid**: high-value fields (transforms on actors, variable defaults on BPs) fold into existing tools. A new generic tool handles the long-tail.

The decision affects `tools.yaml`, the dynamic toolset budget (40-tool threshold), and which tools callers reach for.

---

## Evaluation criteria

1. **Toolset budget**: UEMCP has 120 tools across 15 toolsets. Adding a new tool to the `offline` toolset (always-loaded, 13 tools currently) costs a permanent slot. Is the new tool worth it?
2. **Discoverability**: will callers know to ask for `read_asset_properties` or will they just call `list_level_actors` and expect transforms to be there?
3. **Response size**: property data can be large. Folding it into `list_level_actors` (many rows) compounds the F0-class size problem. A dedicated tool on a single export is bounded.
4. **Composability**: `get_asset_info` → structural metadata, `inspect_blueprint` → exports/functions, `read_asset_properties` → property values. Clean separation vs overlap (F2 lesson).
5. **Phase 3 scope impact**: which existing Phase 3 TCP read-side tools does this replace or reduce? Document the diff.

---

## Input

Read these files before starting:
- `docs/research/uasset-parser-audit-and-recommendation.md` (Agent 8 — what Level 1+2 can actually surface)
- `docs/audits/phase2-tier2-parser-validation-2026-04-15.md` (the findings, especially F0/F2/F3/F4)
- `tools.yaml` (current tool definitions — understand what exists and toolset membership)
- `docs/specs/dynamic-toolsets.md` (toolset system design — budget constraints)
- `docs/specs/phase3-plugin-design-inputs.md` (Phase 3 scope — what might shrink)
- `docs/specs/blueprints-as-picture-amendment.md` (3F traversal verbs — do they consume property data?)
- `docs/research/phase3-design-research.md` Q7 (actor tool shapes), Q11 (server/plugin boundary)
- `docs/tracking/risks-and-decisions.md` D30 (offline-first), D32 (TCP scope reduction), D39 (Level 1+2 rationale)

---

## Output format

Write `docs/research/level12-tool-surface-design.md` with:

### §1 What Level 1+2 surfaces (summary from Agent 8)
Concrete list of data types and fields now available offline.

### §2 Options analysis
For each option (A/B/C):
- Sketch the tool signatures and response shapes
- Score against the 5 evaluation criteria
- Identify risks

### §3 Phase 3 scope diff
Before/after table: which Phase 3 TCP read-side tools are reduced or eliminated by Level 1+2 + the chosen surface design.

### §4 Recommendation
Pick one option. Justify. Include a draft `tools.yaml` snippet for any new/modified tools.

### §5 Open questions for Noah
Anything that needs a human decision before the parser implementation agent can wire things up.

---

## Constraints

- **Design only** — no code changes.
- **YAGNI lens** — don't add tools "because we can." Add them because a real workflow needs them.
- **F2 lesson** — avoid creating new overlap between tools. Each tool should have a clear, non-overlapping contract.
- **No AI attribution.**

---

## Final report format

```
Agent 9 Final Report — Tool Surface Design

Recommendation: Option [A/B/C]
New tools added: [0 or 1, with name]
Existing tools modified: [list]
Phase 3 read-side tools eliminated: [list]
Phase 3 read-side tools reduced: [list]
Open questions: [N]
Deliverable: docs/research/level12-tool-surface-design.md ([N] lines)
```
