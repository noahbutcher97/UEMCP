# Agent 11.5 Handoff — L3A Skeletal UEdGraph Parse Feasibility

> **Dispatch**: After Agent 11 (Level 3 feasibility study) delivered. Parallel with Agent 10 + Agent 9.5.
> **Depends on**: Agent 7 parser survey, Agent 8 parser audit, Agent 9 tool surface design, **Agent 11 Level 3 feasibility study** — all delivered.
> **Type**: Follow-up research with corrected framing — NO code changes, NO design authorship, NO decisions
> **Deliverable**: `docs/research/level3a-skeletal-parse-study.md`
> **Scope question**: Agent 11 verdict'd L3A EDITOR-ONLY based on 200+ K2Node types making full-fidelity byte parsing infeasible, and assumed the 3F sidecar covers the offline-read use case. **Agent 11 did not evaluate a skeletal byte parse** — restricted to 10-20 K2Node types covering common BP-introspection workflows. Given the corrected framing (offline reads are first-class goals; the 3F sidecar is editor-dependent-to-produce and thus not equivalent to pure offline), is a skeletal offline parser worth pursuing?

---

## Critical framing correction

The orchestrator and Agent 11 both initially treated "Phase 3 C++ plugin handles this" as equivalent to "offline not needed." That framing was wrong. The corrected framing, from Noah 2026-04-16:

> The plugin goal and the offline goal are not one and the same. The plugin is to allow for blueprint operations and to assist the code agent with anything that can't be accomplished offline, but **ideally we don't need to use the editor to introspect blueprints** and get full info about blueprints from the CLI agent context. We want to be able to read blueprints from the agent CLI seamlessly like there is no disconnect and easily answer questions that would have required direct editor checks. Then the plugin is meant to facilitate write ops and mutation ops that we can't do offline. But we would still like to be able to look at and reason about blueprints offline even though we don't have the ability to write to them without the plugin.

**Key consequence**: the 3F "blueprints-as-picture" sidecar design (`docs/specs/blueprints-as-picture-amendment.md`) is **editor-dependent-to-produce**. The plugin writes the sidecar on BP save; if the editor isn't running when a BP is modified, the sidecar goes stale. It's a pragmatic offline-read path but not equivalent to parsing the canonical bytes.

A skeletal offline parser would give a **robust floor**: even with stale/missing sidecars and editor closed, basic BP logic introspection works. Full fidelity (knots, comments, timelines, animation nodes, dialogue nodes, 3F spatial) still goes through the sidecar when available. The two are complementary, not substitutes.

This handoff asks whether that robust-floor capability is achievable at reasonable cost.

---

## Mission

Evaluate whether a **skeletal UEdGraph byte parser** — covering a bounded, carefully chosen subset of K2Node types — is feasible and worth pursuing as offline infrastructure.

**You are NOT**:
- Rescoping Agent 11's L3B or L3C verdicts. L3A is the subject; other categories are settled.
- Evaluating full-fidelity UEdGraph parsing. Agent 11's EDITOR-ONLY verdict on that stands.
- Designing the 3F sidecar or commenting on its scope. It's orthogonal; both can coexist.
- Writing parser code. Pure research.

**You ARE**:
- Defining what a "skeletal" K2Node subset should cover (10-20 types) based on common BP-introspection workflows.
- Assessing reference-project coverage for that specific subset (CUE4Parse, UAssetAPI) — feasibility per node type, not across all 200+.
- Estimating multi-agent cost under the calibration Agent 11 established (mechanical porting fast; spec-writing slow).
- Comparing against the 3F-sidecar-only alternative with the corrected framing in mind.
- Producing a recommendation: **PURSUE** (ship skeletal parser as L3A) / **FOLD-INTO-3F** (commit to sidecar-only + editor dependency) / **DEFER** (skeletal feasibility unclear, park until a workflow forces it).

---

## What "skeletal" means — starting proposal

You may revise based on research, but here's a draft K2Node subset that would cover the common BP-logic introspection cases Noah described ("answer questions that would have required direct editor checks"):

**Entry / event nodes** (graph starting points):
1. `UK2Node_Event` — base class for all events (BeginPlay, Tick, ReceiveDamage, etc.)
2. `UK2Node_CustomEvent` — user-defined events
3. `UK2Node_FunctionEntry` / `UK2Node_FunctionResult` — function graph entry/exit

**Variable access**:
4. `UK2Node_VariableGet` — read a BP variable
5. `UK2Node_VariableSet` — write a BP variable

**Function calls** (the dominant node type in most BPs):
6. `UK2Node_CallFunction` — call a UFUNCTION (the target class + function name are typically readable)

**Control flow**:
7. `UK2Node_IfThenElse` — Branch
8. `UK2Node_ExecutionSequence` — Sequence node
9. `UK2Node_Switch` variants (enum, int, string) — Switch statement

**Basic data**:
10. `UK2Node_Literal` / `UK2Node_Self` — literal values and self-reference

**Optional stretch** (if feasibility allows):
11. `UK2Node_MacroInstance` — macro calls (opaque wrt internals, but knowing the call is there is useful)
12. `UK2Node_DynamicCast` — cast-to nodes
13. `UK2Node_CreateDelegate` — delegate binding (useful even partial)

Everything else (timelines, math expressions, struct members, array nodes, spawn actors, animation state nodes, dialogue nodes, material graph nodes, Niagara nodes) is out-of-skeletal-scope and falls back to 3F sidecar when available or reports unsupported.

**Coverage test**: does this subset answer the common workflows Noah described? Specifically:
- "What happens when this BP takes damage?" → find `UK2Node_Event` named `ReceiveAnyDamage` → trace the exec chain → see `UK2Node_CallFunction` targets (TakeDamage, ApplyDamage, etc.) and `UK2Node_VariableSet` on HP. ✅ covered by skeletal.
- "What does this BP do on BeginPlay?" → similar pattern. ✅
- "Does this BP call `StartMontage` anywhere?" → search all `UK2Node_CallFunction` for target `StartMontage`. ✅
- "What state machine does this AnimBP run?" → AnimBP-specific state nodes are NOT in skeletal. ❌ — goes to sidecar.
- "Where does this variable get read from?" → search `UK2Node_VariableGet` for the variable name. ✅

**Coverage gap you should specifically evaluate**: does skeletal coverage meaningfully serve the agent workflow, or does it stop short of useful? If it stops short, the skeletal approach has a problem.

---

## Evaluation criteria (per-subset decision)

Produce per-node-type assessment. For each candidate in the 10-13 above:

1. **Reference-project coverage**: does CUE4Parse (or UAssetAPI) have a reader for this specific node type? Cite file paths. If yes → low feasibility risk. If no → high risk (may need reverse-engineering).
2. **Serialization stability**: is this node type's serialization stable across UE 5.6 → 5.7? Core flow-control nodes (Branch, Sequence) are more stable than, say, animation state nodes. Score 1-5.
3. **Per-node agent-session cost**: mechanical port from reference = ~0.5 sessions; reverse-engineer from engine source = 2-4 sessions.
4. **Value density**: how much common-workflow coverage does this one node type buy?

Then aggregate:

5. **Skeletal coverage ratio**: of a representative ProjectA BP (pick 2-3 common ones — `BP_OSPlayerR` + a GA + a WBP), what fraction of exec-chain nodes are in the skeletal subset? Do hand-count against `inspect_blueprint` export tables.
6. **Total cost**: sum of per-node-type costs + shared infra (FPropertyTag extension for UEdGraphPin serialization, execution-edge following, graph traversal helpers).
7. **Coverage adequacy**: does ~10-13 node types serve the "answer questions from CLI seamlessly" goal, or does it stop short?

---

## Decision framework

**PURSUE** if all of:
- Reference-project coverage exists for ≥70% of the skeletal subset.
- Total cost estimate ≤ 6-8 agent sessions (including test fixtures + version-skew buffer).
- Skeletal coverage ratio ≥ 60% of nodes in a representative BP's exec chains.
- The skeletal-covered workflows map to real questions Noah described (event-chain tracing, function-call finding, variable access patterns).

**FOLD-INTO-3F** if:
- Reference coverage is thin (<40% of subset) — too much reverse-engineering.
- OR cost estimate > 10 agent sessions — approaches "just build the plugin and be done."
- OR skeletal coverage adequacy is <40% of representative BP nodes — stops short, agents keep hitting gaps.

**DEFER** if:
- The feasibility/cost picture is genuinely mixed and a real workflow blocker hasn't surfaced yet.
- Recommendation should then specify: what signal would reopen the question.

---

## Inputs

Read first:
1. `docs/research/level3-feasibility-study.md` — Agent 11's deliverable. Understand their L3A full-fidelity reasoning you are NOT re-evaluating.
2. `docs/specs/blueprints-as-picture-amendment.md` — 3F sidecar design. Know what you're complementing.
3. `docs/specs/blueprint-introspection.md` — parent spec for 3F. The BP dump format for context.
4. `docs/research/uasset-property-parsing-references.md` — Agent 7's 14-project survey. Primary source for per-node-type reference coverage.
5. `docs/research/uasset-parser-audit-and-recommendation.md` — Agent 8's audit. Establishes FPropertyTag parsing foundation that a skeletal UEdGraph parser builds on.
6. `server/uasset-parser.mjs` — the existing parser foundation.
7. `server/offline-tools.mjs` — `inspectBlueprint` handler. Use it to collect export tables from real ProjectA BPs for the coverage-ratio analysis.
8. `docs/tracking/risks-and-decisions.md` D30, D32, D37, D39, D44, D45 (just logged) — current offline-first scope policies.

ProjectA BP samples to use for coverage-ratio analysis (spot-check):
- `/Game/Blueprints/Character/BP_OSPlayerR.uasset` (or similar canonical player BP — find via `query_asset_registry class_name:Blueprint path_prefix:/Game/Blueprints`)
- One GA (GameplayAbility) BP — e.g., anything under `/Game/ProjectA/GAS/Abilities/`
- One Widget BP — find via `query_asset_registry class_name:WidgetBlueprint`

Optional but valuable:
- Look at CUE4Parse `UE4/Objects/Engine/K2Node*.cs` (or equivalent path in C#). Count which K2Node readers exist. That's your reference-coverage baseline.

---

## Output format

Write `docs/research/level3a-skeletal-parse-study.md`:

### §1 Skeletal subset definition
The refined 10-13 K2Node type list. May differ from the starting proposal above if research surfaces better candidates or identifies gaps.

### §2 Per-node-type evaluation table
For each candidate: reference coverage (yes/no + citation), stability score, cost estimate, value density. Aggregated total.

### §3 Coverage-ratio analysis
Representative BPs + hand-counted node coverage. Show work.

### §4 Comparison against 3F-sidecar-only
Under the corrected framing (offline reads are first-class + sidecar has soft editor dependency), what does skeletal-parser+sidecar buy that sidecar-only doesn't? Be concrete — cite specific workflow robustness scenarios (editor closed during CI, collaborator lacks plugin, BP modified without save-sidecar hook firing).

### §5 Recommendation
PURSUE / FOLD-INTO-3F / DEFER with one-paragraph rationale citing the decision framework thresholds.

### §6 If PURSUE — proposed scope
- Final K2Node subset
- Implementation order (FPropertyTag-for-pins first, then entry nodes, then function-call, then control flow, etc.)
- Agent sequencing (is this one agent, or sequential/parallel agents for subsets?)
- How does it slot relative to Agent 10 (Level 1+2) and Agent 10.5 (container follow-on) and the UUserDefinedStruct PURSUE work (D47)?
- Does it eliminate or further reduce any tools in tools.yaml Phase 3 `blueprint-read` toolset beyond what Agent 9's Option C already did?

### §7 If FOLD-INTO-3F or DEFER — what the final offline-BP story looks like
- Honest description of the robustness floor without skeletal parse
- What workflows remain editor-dependent vs. sidecar-dependent
- What signal or workflow demand would reopen the skeletal question

### §8 Open questions for Noah
Anything not resolvable from references alone.

### §9 Confidence
HIGH / MEDIUM / LOW with reasoning.

---

## Constraints

- **No design authorship for an implementation** — recommend scope if PURSUE, but do not specify the parser interface, APIs, or per-node-type struct layouts. A future agent designs if commissioned.
- **Reference-backed only** — every per-node-type feasibility claim cites a reference project path or explicit "no coverage found." No inference-only claims.
- **Honest multi-agent calibration** — per Agent 11's framing, mechanical ports are cheap, spec-writing and version-skew work are not. Score cost with this calibration visible.
- **No D-number allocation** — research doc. A future D-log will cite your findings when a skeletal decision is actually made.
- **No scope creep** — you are NOT rescoping L3B, L3C, the 3F sidecar, or Agent 10. Stay bounded to skeletal L3A.
- **No code changes**, not even throwaway — existing offline tools are fine for collecting fixture data.
- **No AI attribution** anywhere.

---

## Final Report format

```
Agent 11.5 Final Report — L3A Skeletal Parse Feasibility

Verdict: [PURSUE / FOLD-INTO-3F / DEFER]

Skeletal subset: [N node types — list IDs]
Reference-project coverage: [X of N have reference ports — list gaps]
Total estimated cost: [N agent sessions]
Coverage ratio on representative BPs: [X%]

If PURSUE:
  Proposed sequencing relative to Agent 10 / 10.5 / L3C-UDS: [description]
  Phase 3 blueprint-read scope impact: [further reduction / no change]

If FOLD-INTO-3F or DEFER:
  Workflow signal that would reopen: [specific trigger]

Open questions for Noah: [N]
Confidence: [HIGH / MEDIUM / LOW]
Deliverable: docs/research/level3a-skeletal-parse-study.md ([N] lines)
```
