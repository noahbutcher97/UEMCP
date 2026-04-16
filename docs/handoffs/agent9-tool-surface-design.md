# Agent 9 Handoff — Tool Surface Design: Level 1+2 Property Data

> **Dispatch**: After codebase grounding audit is complete (DONE) and remaining MEDIUM fixes land
> **Depends on**: Agent 8 (research audit) — delivered, Grounding audit — delivered (0C/0H/6M/4L)
> **Type**: Design research — NO code changes
> **Deliverable**: `docs/research/level12-tool-surface-design.md`
> **Concurrent work (orchestrator, 2026-04-16)**: M3/M6 fixed. **D44 decides yaml is single source of truth** for offline tool descriptions/params. M4 root-cause refactor (eliminate `server.mjs:offlineToolDefs` duplication, offline registration reads yaml via `toolsetManager.getToolsData()` like TCP does) is **in-flight in parallel with this agent**. Your design MUST assume the yaml-as-truth end state.

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

## Critical context from codebase audit (2026-04-16)

The grounding audit (`docs/audits/uemcp-server-codebase-audit-2026-04-16.md`, ~580 lines) completed with verified findings. Read it in full — it contains architecture details, the module dependency map, handler audit table, and test coverage analysis that directly inform your design.

### Findings relevant to your design:

**MEDIUM — Description drift between `server.mjs` and `tools.yaml` (M4) — RESOLVED BY D44**. Previously the 13 offline tools had duplicated descriptions/params in `server.mjs:offlineToolDefs` and `tools.yaml:55-108`. **D44 (2026-04-16)** decides yaml is the single source of truth; the `offlineToolDefs` const is being eliminated in parallel with this agent. **Assume the end state**: all tool descriptions/params live in yaml, offline registration reads them via `toolsetManager.getToolsData()` (mirroring how TCP tools already do this via `getActorsToolDefs()`). Your design should reference tool names and yaml entries — **do not cite server.mjs line numbers for `offlineToolDefs`** (they'll be gone). Any new or modified tools declare every param in yaml only.

**MEDIUM — `inspect_blueprint.verbose` (M3) — DESCRIPTION FIXED**. The handler still reads `params.verbose` into a local at line 1119 but never references it (the param is preserved in the Zod schema to avoid breaking callers that pass `verbose:true`). `server.mjs:497` description was corrected to match yaml:88 ("Currently unused; reserved for future feature expansion"). If your design folds property data into `inspect_blueprint`, you can repurpose this reserved param — note the repurposing in §5 open questions.

**MEDIUM — `take_screenshot` yaml/Zod gap (M1) — FIXED**. tools.yaml now includes `resolution_x`/`resolution_y` matching the Zod schema. This demonstrates the pattern: every param the Zod schema accepts must be declared in yaml.

**MEDIUM — `get_all_blueprint_graphs` duplicate (M2) — FIXED**. Standalone entry removed; alias on `get_blueprint_graphs` remains. This is the correct pattern for aliasing without duplication.

**MEDIUM — Stale supplementary tests (M6) — FIXED**. 4 supplementary test files (`test-uasset-parser.mjs`, `test-offline-asset-info.mjs`, `test-query-asset-registry.mjs`, `test-inspect-and-level-actors.mjs`) are now wired into CLAUDE.md's test rotation. 3 stale assertions from F1/F2 fixes were propagated: `filesScanned` → `total_scanned` (F1 rename), and `bp.tags` assertion inverted to a regression guard asserting `tags === undefined` (F2 removal). Test total is now **436 assertions** (333 primary + 103 supplementary), all green. Agent 10 should keep any new property-parser tests in the supplementary rotation pattern.

**F0-class false-confidence lesson**: All offline-tool tests call `executeOfflineTool` directly, bypassing the Zod schema + SDK handler wrapper + MCP wire path. The F0 verbose bug passed all unit tests but failed manual testing. Your design should recommend how param passthrough will be tested for any new or modified tools.

**`inspectBlueprint` genClassNames coverage**: Only 3 generated-class types are recognized (BlueprintGeneratedClass, WidgetBlueprintGeneratedClass, AnimBlueprintGeneratedClass). Other BP subclasses (e.g., GameplayAbilityBlueprintGeneratedClass) return `parentClass: null`. If your design folds property data into `inspect_blueprint`, this limitation affects which assets return useful results.

**Current offline tool count**: 13 tools in the always-loaded offline toolset. The 40-tool accuracy threshold applies to the total active across all enabled toolsets.

---

## Input

Read these files before starting:
- `docs/audits/uemcp-server-codebase-audit-2026-04-16.md` (**read in full** — architecture, handler audit table, test coverage, description-drift details)
- `docs/research/uasset-parser-audit-and-recommendation.md` (Agent 8 — what Level 1+2 can actually surface)
- `docs/audits/phase2-tier2-parser-validation-2026-04-15.md` (the findings, especially F0/F2/F3/F4)
- `tools.yaml` (current tool definitions — recently patched: M1+M2 fixed; yaml is now single source of truth per D44)
- `server/server.mjs` (registration loops — by the time you read this, the M4 refactor may have landed; `offlineToolDefs` is being eliminated. Reference tool definitions via yaml + tool names, not line numbers.)
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
- Address the description-drift problem: how does this option interact with the server.mjs/yaml duplication?

### §3 Phase 3 scope diff
Before/after table: which Phase 3 TCP read-side tools are reduced or eliminated by Level 1+2 + the chosen surface design.

### §4 Recommendation
Pick one option. Justify. Include a draft `tools.yaml` snippet for any new/modified tools. If modifying existing tools, include the corresponding `server.mjs:offlineToolDefs` changes needed to stay in sync (or recommend eliminating the duplication).

### §5 Open questions for Noah
Anything that needs a human decision before the parser implementation agent can wire things up. Must include:
- Should `inspect_blueprint.verbose` be repurposed (e.g., to gate Level 1+2 property data inclusion), removed, or left as-is?
- How should param passthrough be tested for new/modified tools? (F0-class lesson)
- Should the MCP-wire integration test harness be part of Agent 10's scope?

**Already decided — do NOT re-litigate**:
- M4 description drift → **D44**: yaml is single source of truth, offline registration reads yaml (refactor in-flight).
- M6 supplementary tests → already wired into CLAUDE.md rotation (436 total assertions).
- M3 `verbose` description → already matches yaml ("Currently unused").

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
