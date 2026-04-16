# Agent 9 Handoff — Tool Surface Design: Level 1+2 Property Data

> **Dispatch**: After codebase grounding audit is complete (DONE) and remaining MEDIUM fixes land
> **Depends on**: Agent 8 (research audit) — delivered, Grounding audit — delivered (0C/0H/6M/4L)
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

## Critical context from codebase audit (2026-04-16)

The grounding audit (`docs/audits/uemcp-server-codebase-audit-2026-04-16.md`, ~580 lines) completed with verified findings. Read it in full — it contains architecture details, the module dependency map, handler audit table, and test coverage analysis that directly inform your design.

### Findings relevant to your design:

**MEDIUM — Description drift between `server.mjs` and `tools.yaml` (M4)**. The 13 offline tools have their descriptions and param definitions duplicated in two places: `server.mjs:offlineToolDefs` (lines 458-525) and `tools.yaml:55-108`. These have drifted — `inspect_blueprint`, `query_asset_registry`, and `get_asset_info` have different descriptions in each location. `tools/list` (SDK) shows server.mjs descriptions; `find_tools` (ToolIndex) shows yaml descriptions. **Your design must account for this**: if you modify existing tools or add new ones, ensure the param definitions exist in both places OR recommend eliminating the duplication as a prerequisite. The TCP tools don't have this problem — they use `getActorsToolDefs()` etc. from tcp-tools.mjs, not a duplicated const.

**MEDIUM — `inspect_blueprint.verbose` is dead (M3)**. The handler reads `params.verbose` into a local at line 1119 but never references it. server.mjs:497 claims it controls AR tag inclusion (stale — F2 removed tags entirely). yaml:88 correctly says "Currently unused." If your design folds property data into `inspect_blueprint`, you could repurpose this param — but note the server.mjs description must be fixed first.

**MEDIUM — `take_screenshot` yaml/Zod gap (M1) — FIXED**. tools.yaml now includes `resolution_x`/`resolution_y` matching the Zod schema. This demonstrates the pattern: every param the Zod schema accepts must be declared in yaml.

**MEDIUM — `get_all_blueprint_graphs` duplicate (M2) — FIXED**. Standalone entry removed; alias on `get_blueprint_graphs` remains. This is the correct pattern for aliasing without duplication.

**MEDIUM — Stale supplementary tests (M6)**. 4 supplementary test files exist outside the documented "333 total" rotation (`test-uasset-parser.mjs`, `test-offline-asset-info.mjs`, `test-query-asset-registry.mjs`, `test-inspect-and-level-actors.mjs`). 3 assertions are broken from F1/F2 fixes not propagated. Your design should note whether Agent 10 should incorporate these into the test rotation or update them.

**F0-class false-confidence lesson**: All offline-tool tests call `executeOfflineTool` directly, bypassing the Zod schema + SDK handler wrapper + MCP wire path. The F0 verbose bug passed all unit tests but failed manual testing. Your design should recommend how param passthrough will be tested for any new or modified tools.

**`inspectBlueprint` genClassNames coverage**: Only 3 generated-class types are recognized (BlueprintGeneratedClass, WidgetBlueprintGeneratedClass, AnimBlueprintGeneratedClass). Other BP subclasses (e.g., GameplayAbilityBlueprintGeneratedClass) return `parentClass: null`. If your design folds property data into `inspect_blueprint`, this limitation affects which assets return useful results.

**Current offline tool count**: 13 tools in the always-loaded offline toolset. The 40-tool accuracy threshold applies to the total active across all enabled toolsets.

---

## Input

Read these files before starting:
- `docs/audits/uemcp-server-codebase-audit-2026-04-16.md` (**read in full** — architecture, handler audit table, test coverage, description-drift details)
- `docs/research/uasset-parser-audit-and-recommendation.md` (Agent 8 — what Level 1+2 can actually surface)
- `docs/audits/phase2-tier2-parser-validation-2026-04-15.md` (the findings, especially F0/F2/F3/F4)
- `tools.yaml` (current tool definitions — recently patched: M1+M2 fixed)
- `server/server.mjs` lines 458-525 (the `offlineToolDefs` const — understand the duplication problem)
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
- Should `inspect_blueprint.verbose` be repurposed, removed, or left as-is?
- How should param passthrough be tested for new/modified tools? (F0-class lesson)
- Should the description-drift (M4) be fixed as a prerequisite or accepted as tech debt?
- Should supplementary test files be incorporated into the test rotation or updated/deleted?
- Should the MCP-wire integration test harness be part of Agent 10's scope?

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
