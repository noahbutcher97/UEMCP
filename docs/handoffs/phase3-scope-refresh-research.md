# Phase 3 Scope-Refresh Research Handoff

> **Dispatch**: Post-EN-2 (commit `ae7fb96`, test baseline 825). Queued since Sidecar Design Session (2026-04-19); load-bearing next piece.
> **Depends on**: Agent 10 (L1+2+2.5 parser) shipped, Agent 10.5 (L2.5 complex + L3A S-A) shipped, Agent 11 (L3 feasibility) delivered, Agent 11.5 (L3A skeletal study) delivered, Sidecar Design Session delivered, EN-2 shipped.
> **Type**: Research — NO code changes, NO dispatch authorship. Produces a scope document that the orchestrator uses to sequence actual Phase 3 implementation handoffs.
> **Deliverable**: `docs/research/phase3-scope-refresh-2026-04-<date>.md`
> **Time budget**: ~2-3 hour research session.

---

## Why this handoff exists now

Phase 3 is the C++ UE5 editor plugin (TCP:55558). Its original scope was set before Agent 10/10.5/11/11.5 and the Sidecar Design Session reshaped what "offline" can cover. Three forcing functions converged:

1. **D52 (2026-04-19)** — near-plugin-parity for offline READ functionality is a first-class project goal. Plugin read-side scope shrinks to: runtime/PIE state, UEdGraph pin topology, compiled/derived data, reflection-only metadata. **Every remaining Phase 3 read tool now needs to justify why it isn't offline-capable.**
2. **D45 + D48 + D50** — L3A full-fidelity UEdGraph byte parsing is EDITOR-ONLY; L3A S-A skeletal shipped (`find_blueprint_nodes` + `find_blueprint_nodes_bulk`); tagged-fallback (D50) decodes 601 unique unknown structs via FPropertyTag streams. A lot of "has to be plugin" assumptions from the original Phase 3 plan no longer hold.
3. **Sidecar Design Session (commits `5c47e00`, `d9bec19`, `docs/research/sidecar-design-resolutions-2026-04-19.md`)** — 3F sidecar v1 scoped at ~6-10 agent sessions; layered-parity framing adopted (sidecar = full fidelity when editor ran; pure bytes = robust floor always).

The research question: **what is Phase 3's actual scope post-Agent-10.5 + post-sidecar-design, and how should it be sequenced?**

---

## Critical framing — read before evaluating

### Layered parity, not identical parity

From D52 + Sidecar Design Session. Do not evaluate Phase 3 scope as "plugin must match offline byte-for-byte." Evaluate it as:

- **Pure-bytes tier** (always available, no editor dependency): name-level find/grep, CDO property values, asset-registry metadata, config values, gameplay tags, placed actors, struct values via tagged-fallback, skeletal K2Node surface.
- **Sidecar tier** (full fidelity when editor has run — editor-dependent-to-produce): pin topology, spatial layout, comment containment, exec flow, pin-trace.
- **Plugin-TCP tier** (genuinely editor-mediated — requires live editor): runtime/PIE state, compiled/derived data, write ops, reflection-only runtime flags, mutation.

Phase 3's read-side scope = plugin-TCP tier only. Sidecar-tier work belongs to the editor plugin but is a separate milestone (DR-3 question below).

### Skeletal-subset S-B is a new-research angle to evaluate, not re-commission

Agent 11.5 (2026-04-16) evaluated full S-B at ~8-13 agent sessions — FOLD-INTO-3F verdict. Today's conversation surfaced a refinement Agent 11.5 did NOT evaluate:

> The pin-block binary parser is ONE thing in `UEdGraphNode::Serialize()` base class, not 200+ things. Per-node `Serialize()` overrides are where 200+ types vary (only 4-6 have bespoke overrides per Agent 11.5's finding). If pin data is only needed for the 19 shipped skeletal K2Node types — most of which inherit base-class Serialize — **cost could collapse to ~4-6 sessions** instead of 8-13.

This is a genuinely new question. Evaluate it as part of this handoff rather than as a standalone spike. Answer with a verdict (PURSUE-NOW / PURSUE-AFTER-SIDECAR / REMAIN-FOLDED-INTO-3F / DEFER). If "pursue," this further shrinks Phase 3 plugin scope because offline picks up more of the read story.

### tools.yaml is a dual-role document (D51)

Stub entries for un-shipped toolsets (`blueprint-read`, `asset-registry`, `data-assets`, `materials`, `gas`, `input-and-pie`, `visual-capture`, `editor-utility`, `animation`, `cpp-introspection`, `remote-control`) are **planning placeholders**, not dead code. This research will decide which stubs survive, get de-scoped, or get re-assigned to offline. **Do not delete stubs during this research** — your output is a scope recommendation; actual yaml edits happen when Phase 3 implementation dispatches.

---

## Mission

Produce a Phase 3 scope document that answers the following load-bearing questions. Each answer must be defensible from evidence in the input files + D-log.

### Q1 — What's displaced from Phase 3 by shipped offline work?

Agent 9's tool-surface design (`docs/research/level12-tool-surface-design.md`) projected 13 tools would be reduced or eliminated by Level 1+2 + Option C. Post-Agent-10.5 + post-EN-2, the actual shipped offline surface is larger (L2.5 containers + tagged-fallback + L3A S-A + bulk variant). **Re-run the displacement calculation empirically**: which Phase 3 yaml stubs now have an offline equivalent that serves the workflow adequately?

For each displaced tool, record:
- **Yaml stub name + toolset**
- **Offline tool that displaces it** (or "not displaced")
- **Disposition**: DROP (remove from Phase 3), KEEP (still needed for something offline can't do), or MOVE-TO-OFFLINE (should become offline tool, not plugin tool — would require a new offline handoff)
- **Why** (one or two sentences; tie to D52 justification)

### Q2 — What's genuinely plugin-only under D52?

For every remaining Phase 3 stub (post-Q1), justify why it can't be served offline. Acceptable justifications fall into four categories per D52:

1. Runtime/PIE state
2. UEdGraph pin topology (pending DR-1/S-B outcome — see Q4)
3. Compiled/derived data (Niagara VM, baked lighting, shader compilation)
4. Reflection-only metadata (EditAnywhere/BlueprintReadWrite flags, interface lists, UClass walks)

If a stub doesn't fit one of these, it either moves to offline (Q1) or gets dropped.

Write ops and mutation tools are plugin-only by definition — they don't need separate justification under D52. But flag cases where a "write op" is suspiciously read-adjacent (e.g., a tool that writes in order to read back derived state).

### Q3 — DR-3: should 3F sidecar writer ship as a standalone early milestone?

Per backlog.md DR-3:

> Should the 3F sidecar writer ship as its own milestone BEFORE the rest of Phase 3? This would unlock offline BP pin-trace workflows via the sidecar-mediated path earlier than the rest of Phase 3 delivers.

Evaluate. Inputs:
- Sidecar Design Session resolutions (3F v1 = ~6-10 agent sessions)
- D52 near-plugin-parity goal
- Q4 below (skeletal-subset S-B — if S-B is viable, sidecar-urgency drops)
- Rest-of-Phase-3 cost estimate (from this research, Q1+Q2+Q5)

Produce a **recommendation with reasoning**: SHIP-SIDECAR-FIRST (milestone 1: 3F sidecar writer only, then milestone 2: rest of Phase 3) / BUNDLE-WITH-PHASE-3 (sidecar is just one of N concurrent Phase 3 work items) / DEFER-SIDECAR (ship rest of Phase 3 first, sidecar later). State which trade-off dominates.

### Q4 — Skeletal-subset S-B tractability

Re-evaluate S-B with the refined framing: pin-block binary parser for **only the 19 shipped skeletal K2Node types** (17 non-delegate + 2 delegate-presence per D48 as shipped). Key questions:

- Does `UEdGraphNode::Serialize()` base-class emit pin binary in a uniform way, or does every K2Node subclass override?
- Of the 19 shipped types, how many use base Serialize vs override?
- For the override cases, is the pin-block emission shape stable across subclasses (same field order, same encoding) or bespoke?
- Reference coverage — CUE4Parse, UAssetAPI, FModel: any of them handle `UEdGraphPin` binary directly for any K2Node? (Agent 11.5 said zero; re-verify in case anything shifted.)

Produce a verdict: **PURSUE-NOW** (commission S-B as its own handoff — shrinks Phase 3 scope further) / **PURSUE-AFTER-SIDECAR** (sidecar first, S-B validates against sidecar oracle) / **REMAIN-FOLDED-INTO-3F** (Agent 11.5's verdict still holds — 4-6-session estimate doesn't materialize under new analysis) / **DEFER** (tractability unclear without a narrow spike — recommend that spike).

If PURSUE-NOW or PURSUE-AFTER-SIDECAR: estimate cost (sessions) + reference the specific node types most worth starting with.

### Q5 — Dispatch sequencing recommendation

Given Q1-Q4 answers, recommend the actual sequencing of Phase 3 implementation handoffs. Specifically:

- **Milestone ordering** — which work items ship first, second, third?
- **Parallelism opportunities** — which items can dispatch in parallel without collision?
- **Dependency chains** — which items must land before others can start (e.g., TCP scaffolding before any TCP-55558 tool)?
- **Rough cost per milestone** — agent-sessions per dispatch, broken down by confidence.

Frame as "orchestrator-actionable" — the output should be directly usable to queue the first Phase 3 implementation handoff.

### Q6 — Tool-surface cleanup items (TS-1/TS-2/TS-3)

Three backlog items (backlog.md lines 13-28) touch yaml cleanup and over-served tools:

- **TS-1** — `actors.take_screenshot` ↔ `visual-capture.get_viewport_screenshot` duplication
- **TS-2** — `widgets.add_widget_to_viewport` NO-OP (returns "use Blueprint nodes instead")
- **TS-3** — `editor-utility.create_asset` scope review

Each triggered on "next Phase 3 scope refresh." Produce a recommendation: fold into Phase 3 dispatch (resolve at the yaml-edit point) / standalone cleanup pass before Phase 3 / DEFER. One line per item is enough.

---

## You are NOT

- Writing plugin code or TCP scaffolding. Research only.
- Dispatching handoffs. Orchestrator does that.
- Re-opening D45 or D48's closed verdicts — L3A full-fidelity is EDITOR-ONLY (D45); L3A S-A PURSUE and L3A S-B FOLD-INTO-3F were the original Agent 11.5 verdicts. You ARE allowed to update S-B's verdict per Q4 because that's new research, but treat D45 as settled.
- Evaluating Phase 4 (Remote Control / HTTP:30010) or Phase 5/6 (distribution, per-project tuning). Out of scope.
- Designing the 3F sidecar internals. DR-3 evaluates timing, not content — sidecar content design lives in Sidecar Design Session + `docs/specs/blueprints-as-picture-amendment.md`.

---

## You ARE

- Re-reading every input file below and synthesizing across them. The insight comes from connecting Agent 9's projected scope with Agent 10.5's shipped surface with the Sidecar Design Session's v1 scope with D52's near-parity bar.
- Naming specific yaml entries when recommending drop/keep/move. No vague "several tools could be removed" — list them.
- Producing the deliverable at `docs/research/phase3-scope-refresh-2026-04-<date>.md`.
- Flagging framing assumptions if you find them. Per the orchestrator's memory `feedback_framing_audit.md`: if you notice this handoff implies something you think is wrong, surface it.

---

## Input files (required reading)

Read order matters — synthesis is part of the deliverable.

### Tier 1 — Scope inputs (read first)

1. `tools.yaml` — all toolsets, paying attention to Phase 3 layer assignments (`layer: tcp-55558`) and stub `params: {}` markers.
2. `docs/specs/phase3-plugin-design-inputs.md` — original Phase 3 scope definition.
3. `docs/research/sidecar-design-resolutions-2026-04-19.md` — Sidecar Design Session output; 3F v1 scope + layered-parity framing.
4. `docs/specs/blueprints-as-picture-amendment.md` — 3F sidecar spec.

### Tier 2 — Shipped-state inputs (displacement math)

5. `docs/research/level12-tool-surface-design.md` (Agent 9) — projected scope reduction.
6. `docs/research/level3-feasibility-study.md` (Agent 11) — L3 categorization + L3A EDITOR-ONLY verdict.
7. `docs/research/level3a-skeletal-parse-study.md` (Agent 11.5) — S-A PURSUE + S-B FOLD-INTO-3F; foundation for Q4's re-evaluation.
8. `docs/research/agent-workflow-catalog.md` + §7a amendment (100-query baseline with SERVED_OFFLINE / SERVED_PARTIAL / SERVED_VIA_PLUGIN columns).
9. `server/offline-tools.mjs` — actual shipped handler surface (15 offline tools; verify rather than trust CLAUDE.md snapshot).

### Tier 3 — Anchor decisions (D-log)

Read these specific entries in `docs/tracking/risks-and-decisions.md`:
- **D32** — original Phase 3 plugin scope (read for historical-context-only)
- **D37** — `inspect_blueprint` ships offline (first displacement)
- **D39** — Agent 10 defers full Phase 3 dispatch; offline-first trajectory confirmed
- **D45** — L3A full-fidelity EDITOR-ONLY; 3F sidecar = offline-read path with soft editor dependency
- **D48** — L3A S-A PURSUE / S-B FOLD-INTO-3F; 19 K2Node types shipped (17 non-delegate + 2 delegate-presence)
- **D50** — tagged-fallback (supersedes D47 two-pass design); 601 unique structs decode
- **D51** — tools.yaml dual-role (shipped + planning)
- **D52** — near-plugin-parity for offline reads; plugin scope shrinks per four justification categories

### Tier 4 — State audits

10. `docs/audits/post-agent10-5-codebase-audit-2026-04-19.md` (Audit A) — post-Agent-10.5 code health, surfaces EN-5 lint gap.
11. `docs/audits/goal-alignment-audit-2026-04-17.md` (Audit B) — D51 yaml dual-role finding; trajectory review.

### Tier 5 — Backlog + in-flight

12. `docs/tracking/backlog.md` — full backlog, especially DR-1 (S-B reopening conditions), DR-2 (L3A full-fidelity lock), DR-3 (this handoff's Q3).
13. `docs/handoffs/orchestrator-state-2026-04-20.md` — pre-compaction state; reference for current queue + "Phase 3 scope-refresh research" section.

### Tier 6 — Post-EN-2 verification

14. `git log --oneline -10` — confirm post-EN-2 state: HEAD `ae7fb96` (EN-2 final report), baseline 825.
15. Run primary rotation to confirm test baseline: `cd /d D:\DevTools\UEMCP\server && node test-phase1.mjs && node test-mock-seam.mjs && node test-tcp-tools.mjs && set UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA&& node test-mcp-wire.mjs` (optional — empirical verification per `feedback_handoff_empirical_verification.md`).

---

## Deliverable structure

Write `docs/research/phase3-scope-refresh-2026-04-<date>.md` with these sections:

1. **Executive summary** (3-5 bullets) — top-line Q1-Q6 answers, orchestrator-actionable.
2. **Displacement table (Q1)** — yaml stub → shipped offline tool → disposition → rationale. Every Phase 3 stub covered.
3. **Plugin-only justification table (Q2)** — remaining stubs → D52 category → defensibility of plugin placement.
4. **DR-3 recommendation (Q3)** — SHIP-SIDECAR-FIRST / BUNDLE / DEFER + reasoning + dominant trade-off.
5. **Skeletal S-B verdict (Q4)** — PURSUE-NOW / PURSUE-AFTER-SIDECAR / REMAIN-FOLDED / DEFER + reasoning + cost estimate if PURSUE-*.
6. **Dispatch sequencing (Q5)** — milestones, dependency chain, parallelism, per-milestone agent-session estimates.
7. **Tool-surface cleanup (Q6)** — TS-1/TS-2/TS-3 one-line dispositions.
8. **Framing-audit notes** (optional) — anything you pushed back on. If empty, note "no framing concerns."
9. **Appendix: input-file findings** — anything surprising in the input files that informs future research but isn't load-bearing for Q1-Q6.

---

## Expected output size

Target ~2,500-4,000 lines of markdown. Tables, not prose-only. Each table row defensible from at least one cited D-log entry or input file.

Shorter is fine if Q1-Q6 are fully answered. Longer is fine if tables need room to breathe. Don't pad for length; don't compress at the cost of losing a defensibility citation.

---

## Success criteria

- Orchestrator can take deliverable and queue the next Phase 3 implementation handoff without further research. "Ready-to-dispatch" state.
- Every Phase 3 yaml stub has an explicit disposition (keep/move/drop).
- DR-3 and Q4 return concrete verdicts, not "more research needed" (unless "more research needed" is the honest answer — then specify the narrowest possible spike that would resolve it).
- D52 justification chain holds for every "KEEP in Phase 3" decision.
- Handoff template matches the pattern in `docs/handoffs/agent11-5-l3a-skeletal-parse-study.md` for readability.

---

## Git discipline

Per D49: when committing the research document, use path-limited commit:

```cmd
git commit docs/research/phase3-scope-refresh-2026-04-<date>.md -m "Phase 3 scope-refresh research deliverable"
```

Desktop Commander required for git ops (`shell: "cmd"`) — sandbox bash can't acquire `.git/index.lock`.

No AI attribution in commit message or document body.

---

## Deliverable checkpoint

Before writing your research document:

1. Have you read every Tier-1-through-Tier-3 input file?
2. Can you answer Q1 with specific yaml entries (not vague categories)?
3. Have you verified shipped state on disk (not just trusted CLAUDE.md)?
4. Do Q3 and Q4 have concrete verdicts in mind? If not, what single piece of evidence would tip the verdict?

If any "no," continue research before writing. Only the final document belongs in git; scratch work stays in your context.
