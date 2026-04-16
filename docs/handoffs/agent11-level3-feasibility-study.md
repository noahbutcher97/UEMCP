# Agent 11 Handoff — Level 3 Feasibility Study (Revisit)

> **Dispatch**: Parallel with Agent 10 (Level 1+2 parser implementation). Research-only, no file conflicts with Agent 10.
> **Depends on**: Agent 7 parser survey, Agent 8 parser audit, Agent 9 tool surface design (all delivered)
> **Type**: Forward-looking research — NO code changes, NO design authorship, NO decisions
> **Deliverable**: `docs/research/level3-feasibility-study.md`
> **Scope question**: The original "stop at Level 2" decision was calibrated against solo-human effort estimates and a "Phase 3 plugin gives us this for free" argument. **Does that decision hold up now given (a) our multi-agent AI-assisted workflow, which changes the cost side of cost/benefit, and (b) the empirical position Level 1+2 leaves us in after Agent 10 ships?**

---

## Mission

"Level 3" was historically defined (informally) as the grab-bag bucket of parser capability **beyond** Level 1 (scalar FPropertyTag iteration) and Level 2 (10 hardcoded engine struct handlers). It was never shipped because the original cost/benefit analysis said:

- The candidates were too heterogeneous to form a coherent tier.
- The Phase 3 C++ editor plugin gets all of this "for free" via UE's reflection system.
- Solo-human effort estimates for a pure-JS implementation were punishing, especially for UEdGraph.

Both sides of that equation have changed:

- **Cost side**: we now operate a multi-agent workflow where well-specified mechanical porting (e.g., implementing a known-shape serialization routine from a reference project like CUE4Parse) is dramatically cheaper per unit of work than the solo-dev estimate assumed. Dispatched agents can consume a reference implementation's source and produce a JS port in a single session for work that would have been 1-2 human days.
- **Benefit side**: Level 1+2 + D32 scope reductions + Agent 9's Option C will displace ~13 Phase 3 TCP tools. The remaining Phase 3 surface is more clearly editor-dependent. Any Level 3 work further shrinks the plugin — which is still deferred per D39. **If Level 3 is feasible, the plugin itself might become unnecessary.** That's a decision-level shift, not a scope tweak.

Your job is to re-run the cost/benefit with these updated inputs, per category. Recommend: does the "stop at Level 2" cutoff still hold, or has one or more Level 3 category crossed the threshold?

**You are NOT**:
- Designing a Level 3 parser. If a category crosses the threshold, a future agent designs it.
- Writing code — not even throwaway. Pure research against existing references.
- Revisiting the D39 "Phase 3 deferred until Level 1+2 ships" decision. That's still in effect; your study may *inform* when it's revisited but doesn't override it.

**You ARE**:
- Re-evaluating three historical Level 3 categories (L3A/L3B/L3C below) against updated cost and benefit inputs.
- Applying the multi-agent effort lens honestly — which means calibrating against what an agent can actually do (mechanical porting from specs: fast; specification-writing for 200+ heterogeneous cases: not much faster than human).
- Producing a recommendation per category: PURSUE / FOLD-INTO-L2.5 / KEEP-DEFERRED / EDITOR-ONLY.

---

## Critical context — what Level 3 actually means here

The three historical Level 3 categories, verbatim from the orchestrator's framing:

### L3A — UEdGraph full deserialization

> Reading Blueprint function graphs from .uasset bytes: the actual node network (K2Nodes, their pins, pin connections, execution wires, data wires). This would let the offline parser understand not just "what are this Blueprint's default variable values" (Level 1+2) but "what does this Blueprint's logic actually do" — function flow, event bindings, state machines.

**Original blocker**: UEdGraph is a complex linked-node structure with 200+ K2Node class types, each with its own serialization. Fundamentally different from the flat FPropertyTag iteration that Level 1+2 uses. The Phase 3 C++ plugin can do this trivially via UEngine's reflection.

### L3B — Container types (Array / Map / Set)

> ArrayProperty, MapProperty, SetProperty. These sit in an awkward middle ground. Agent 8 originally called them "Phase 2.5" — they use the same FPropertyTag format but require recursive parsing (an array of structs means you need struct handlers inside array handlers). Simple-element arrays (array of ints, array of floats) were estimated at 1-2 days, but full container support (arrays of structs, maps with struct keys) was 3-5 days.

**Original blocker**: Cost/benefit didn't justify in solo-human effort; deferred as "Phase 2.5" revisitable later.

### L3C — Delegate properties and other complex types

> DelegateProperty, MulticastDelegateProperty (which functions are bound to which events), custom UUserDefinedStruct deserialization (project-specific structs requiring a two-pass parse + struct registry), cross-package reference resolution, FInstancedStruct / polymorphic containers.

**Original blocker**: Heterogeneous grab-bag; no unifying theme. Phase 3 plugin handles each natively via reflection.

---

## The question you're actually answering

For each of L3A / L3B / L3C, answer:

1. **Has the cost side changed?** The multi-agent workflow lens: mechanical porting from a well-documented reference (CUE4Parse, UAssetAPI) goes fast. Specification-writing for a sprawling heterogeneous surface doesn't. Where does each category fall?
2. **Has the benefit side changed?** Given Agent 9's Option C displacement of 13 Phase 3 tools, what additional plugin scope does each Level 3 category eliminate? Is the plugin itself the marginal decision?
3. **Does the original "Phase 3 plugin gives this for free" argument still hold?** The plugin is still deferred. Every month it's not shipped, the offline tier does more work. What's the crossover point?
4. **Final call**: PURSUE / FOLD-INTO-L2.5 / KEEP-DEFERRED / EDITOR-ONLY.

### Recommendation categories

- **PURSUE** — updated cost/benefit crosses the threshold; should be scoped as a distinct workstream.
- **FOLD-INTO-L2.5** — belongs with Agent 8's "Phase 2.5" containers as a single extension of Agent 10's work rather than a distinct Level 3 tier.
- **KEEP-DEFERRED** — original "stop at Level 2" logic still holds; revisit only if a concrete workflow forces the question.
- **EDITOR-ONLY** — not realistic offline at any cost; Phase 3 plugin scope or nothing.

---

## Evaluation criteria (per category)

Score each 1-5, justify every score. Present as a grounded estimate, not a vibe.

1. **Technical feasibility from .uasset bytes alone** — can a pure-JS parser solve this at all? Cite reference projects (CUE4Parse, UAssetAPI, FModel) that demonstrate the technique. If no reference project handles it, that's a 1.
2. **Multi-agent implementation cost** — calibrate against agent-session units, not human-days. A well-specified port from a reference with known scope = 1 agent session. A spec-writing task against a heterogeneous surface (like L3A's 200+ K2Node types) = N agent sessions per surface class, potentially many sessions of orchestration. Don't inflate to the old human estimate; don't deflate to "agents make everything free" — be honest.
3. **Unlock value** — what concrete workflows does it enable that Level 1+2 + deferred Phase 3 plugin don't? Cite workflows from `docs/research/level12-tool-surface-design.md` §1 and anything in `tools.yaml` Phase 3 that would become offline-solvable.
4. **Response-size risk** — if implemented, does it amplify F0/F3 class size problems on real ProjectA assets? Container properties specifically have this risk.
5. **Stability against UE version drift** — how brittle is the implementation across UE 5.6 → 5.7 (ProjectA vs ProjectB) and beyond? Level 2's 10 engine structs are ABI-stable; K2Node serialization is known to drift. Score brittleness honestly.

Add a **crossover analysis** paragraph per category: given the scores, at what point does offline beat the Phase-3-plugin-alternative? Is the crossover already past (PURSUE now), imminent (PURSUE after Level 1+2 ships), or distant (KEEP-DEFERRED)?

---

## Inputs

Read first:
1. `docs/research/uasset-parser-audit-and-recommendation.md` — Agent 8's audit. Establishes what's parseable, deferrals, reference recommendations.
2. `docs/research/uasset-property-parsing-references.md` — Agent 7's 14-project survey. Primary source for feasibility evidence across all three categories.
3. `docs/research/level12-tool-surface-design.md` — Agent 9's design. §1 "Opaque / unsupported surface" lists what Level 1+2 won't read and why. §3 Phase 3 scope table lists what Level 1+2 already displaces.
4. `docs/specs/phase3-plugin-design-inputs.md` — current Phase 3 plugin scope. Understand what Phase 3 planned to handle per toolset; Level 3 moves some of this offline.
5. `docs/specs/blueprints-as-picture-amendment.md` — 3F sidecar scope. Some L3A-adjacent work (BP graph introspection) belongs there, not Level 3. Disambiguate.
6. `docs/tracking/risks-and-decisions.md` D32, D37, D39, D40, D44 — current scope policies.
7. `server/uasset-parser.mjs` — the parser foundation any Level 3 work builds on.
8. `tools.yaml` Phase 3 toolsets (`layer: tcp-55558`) — reference scope for overlap analysis.

Optional but valuable:
- Skim CUE4Parse source (GitHub: `FortniteGame/CUE4Parse`) specifically for:
  - `FScriptArray`/`FScriptMap`/`FScriptSet` readers (L3B grounding)
  - `UEdGraph`/`UK2Node*` serialization (L3A grounding — look for which K2Node types have bespoke readers vs default)
  - `FDelegateProperty` / `FMulticastDelegateProperty` readers (L3C grounding)
  - `UUserDefinedStruct` handling (L3C grounding)
- UAssetAPI docs on "Unversioned Properties" — version-skew risk factor for L3A/L3C.

---

## The multi-agent-effort lens (read this before scoring cost)

The original Level 2 cutoff assumed a solo developer spending direct hours on each category. Your cost estimates should reflect what the actual workflow can do:

**Fast with agents** (calibrate down from old estimates):
- Porting a well-specified reader from CUE4Parse's C# to our JS parser. E.g., FScriptArray (L3B simple-element): Agent 8's 1-2 human-day estimate → probably 1 agent session including tests.
- Spec-driven ports where the shape is known in advance and agent work is mostly mechanical transliteration.
- Per-tool wiring once the parser capability exists (yaml entry + schema + switch case in executeOfflineTool).

**Not much faster with agents** (old estimates still apply or get worse):
- Specification-writing for a heterogeneous surface where the "spec" is "go figure out what 200+ class types look like and decide which matter." L3A sits here.
- Version-skew adaptation work: if a category's serialization shifts between UE versions, you need per-version branches plus fixture testing per version. No automation speedup.
- Cross-asset behavior (e.g., L3C's two-pass custom-struct resolver requires a cache, invalidation strategy, cycle detection). These are small-but-subtle eng problems, not mechanical ports.

**Agent-workflow-specific costs that didn't exist in the original estimates**:
- Verification agents (Agent 9.5-style) become load-bearing for L3 work because the failure modes are subtle.
- Orchestration cost of coordinating multi-agent passes — not zero.

Honest framing: for L3B simple-element containers, multi-agent cost is 30-50% of the old estimate. For L3A UEdGraph full parsing, it's probably 80-90% — the bottleneck is spec-writing, not typing. For L3C delegates + custom structs, it's category-dependent (simple delegates are mechanical; UUserDefinedStruct resolution is design work).

**Score cost with this calibration, not with "agents make everything trivially cheap."** If your cost estimate for L3A falls below 2 weeks of multi-agent work, you've almost certainly underestimated the spec-writing burden.

---

## The "Phase 3 plugin alternative" framing

For every category, the fallback is "Phase 3 C++ plugin does this natively via UE reflection." That's cheap in plugin-land but has costs too:

- Plugin is still deferred (D39). Schedule risk is real.
- Plugin requires editor running. Offline tier works with editor closed (a significant workflow advantage for CI, docs generation, agent automation).
- Plugin distribution adds friction (D15 — P4 copy-in, team comms).
- Once the plugin ships, editor-run becomes the expected mode. Offline is strictly a superset workflow.

When offline beats plugin-alternative:
- When the workflow has to work with editor closed.
- When the data is cheap to extract from bytes (e.g., L3B simple arrays) and the plugin buys nothing extra.
- When agent-driven automation needs a fast in-process answer without TCP round-trip latency.

When plugin wins:
- When the data structure is genuinely reflection-dependent (e.g., live reflection flags on properties — EditAnywhere, BlueprintReadWrite).
- When the spec is prohibitive to reverse-engineer offline (L3A strong candidate here).
- When version-skew makes offline brittle and editor runtime gives it for free.

Use this framing when scoring Unlock value (criterion 3).

---

## Output format

Write `docs/research/level3-feasibility-study.md` with:

### §1 Verdict
One paragraph top-line per category:
- L3A UEdGraph: [PURSUE / FOLD / KEEP-DEFERRED / EDITOR-ONLY]
- L3B Containers: [PURSUE / FOLD / KEEP-DEFERRED / EDITOR-ONLY]
- L3C Delegates + complex: [PURSUE / FOLD / KEEP-DEFERRED / EDITOR-ONLY]

Plus an aggregate statement: "The 'stop at Level 2' decision [still holds / needs revision on N categories / should be replaced]."

### §2 Category deep-dives
One section per category (~150-250 lines total across all three). For each:
- Reference projects that solve it + source-line-count evidence
- Feasibility score (1-5) with citation
- Multi-agent cost estimate in agent-sessions + the specific work breakdown
- Specific unlock value — which workflows / tools.yaml entries
- Size risk + version-skew assessment
- Crossover analysis: when does offline beat plugin?
- Recommendation with rationale

### §3 If any category is PURSUE
Only write if §1 has at least one PURSUE:
- Implementation order across PURSUE categories (which go first, which depend on which)
- Rough effort estimate (agent-sessions × orchestration overhead)
- What it does to the Phase 3 plugin scope — is the plugin still necessary at all?
- Proposed sequencing relative to Agent 10 (Level 1+2) and Agent 9.5 verification

### §4 If none are PURSUE
Only write if §1 has zero PURSUE:
- Why the original Level 2 cutoff still holds despite updated inputs
- What specific workflow demand would reopen the question
- Whether L3B simple-element containers should still land as Level 2.5 (Agent 8's original framing) — this is a lesser ask than "Level 3" and may be worth doing even if the tier isn't.

### §5 Open questions for Noah
Can't-answer-from-references questions. E.g.:
- Does ProjectA/ProjectB heavily use L3C targets like FInstancedStruct or custom UUserDefinedStructs? Spot-check asset-path suggestions.
- Is there a specific workflow (agent automation, CI docs, etc.) that's blocked today on a Level 3 capability?
- What's the current mental model for Phase 3 plugin ship date — "soon after Level 1+2" or "after several more offline increments"?

### §6 Confidence
HIGH / MEDIUM / LOW self-assessment with reasoning. Specifically flag anywhere the multi-agent cost estimate is speculative vs. grounded.

---

## Constraints

- **No design authorship** — if a category is PURSUE, recommend scope but do not spec. That's a future agent's job.
- **Reference-backed only** — every feasibility score cites a reference project (file + rough line range if possible). Cost estimates grounded in reference source-line counts × porting-overhead factor, not vibes.
- **Honest multi-agent calibration** — neither inflate to the old solo-human estimate nor deflate to "agents are free." Show your work on the calibration.
- **No D-number allocation** — this is research. A future D-log entry will cite your findings when a Level 3 decision is actually made.
- **No scope creep** — the three categories are L3A/L3B/L3C as defined above. If you find additional candidates that don't fit those buckets, flag them in §5 as open questions, don't add them to the evaluation.
- **Parallel with Agent 10** — your work doesn't touch any file Agent 10 touches. If you discover something that would change Agent 10's scope, flag it in §5 for orchestrator attention; don't act on it.
- **No AI attribution** anywhere.

---

## Final Report format

```
Agent 11 Final Report — Level 3 Feasibility Study (Revisit)

Original decision: "Stop at Level 2" (circa 2026-04)
Re-evaluation verdict:
  L3A UEdGraph:            [PURSUE / FOLD / KEEP-DEFERRED / EDITOR-ONLY]
  L3B Containers:          [PURSUE / FOLD / KEEP-DEFERRED / EDITOR-ONLY]
  L3C Delegates + complex: [PURSUE / FOLD / KEEP-DEFERRED / EDITOR-ONLY]

Aggregate: "The 'stop at Level 2' decision [still holds / needs revision].
  Reason: [one sentence]."

If any PURSUE:
  Proposed sequencing: [Agent 10 → L3X → L3Y, etc.]
  Estimated effort: [N agent-sessions + M orchestration passes]
  Phase 3 plugin scope impact: [shrinks by N tools / plugin becomes optional / plugin still needed for Y reasons]

If none PURSUE:
  L2.5 (containers) still recommended? [Yes/No, with rationale]

Open questions for Noah: [N]
Confidence: [HIGH / MEDIUM / LOW]
Deliverable: docs/research/level3-feasibility-study.md ([N] lines)
```
