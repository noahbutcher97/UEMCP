# Phase 3 Re-sequencing — MCP-first, plugin-enhances

> **Dispatch**: Fresh Claude Code session. Research only — NO code, NO dispatch authorship.
> **Type**: Correction of a load-bearing framing assumption that shaped D54/D55 + the Phase 3 scope-refresh deliverable. Produces an updated M-sequence.
> **Duration**: 1-2 sessions (~3-4 hours).
> **Deliverable**: `docs/research/phase3-resequence-mcp-first-2026-04-20.md`.
> **D-log anchors reopened by this re-sequence**: D48 (S-B FOLD-INTO-3F), D54 (SHIP-SIDECAR-PHASE-A-FIRST), D55 (S-B PURSUE-AFTER-SIDECAR), D57 (M-alt AUGMENT preserves D54).
> **D-log anchors NOT reopened**: D45 (L3A full-fidelity EDITOR-ONLY — stands), D52 (near-plugin-parity — stands, actually sharpened), D53 (Q1 displacement table — unchanged), D56 (widget-blueprint SPLIT — unchanged).

---

## The framing correction that motivates this research

Noah, 2026-04-20 (direct quote to capture load-bearing distinction):

> I want to flag that it is very important to me that we be able to traverse event graph edge topology offline without needing access to projects from plugin code. I really would like an MCP first solution that works and is ENHANCED by plugin code rather than enabled by it.

**The distinction restated**:

- **"Enabled by plugin"** (prior framing, D54 + current M-sequence): offline BP edge-topology reader consumes sidecar JSON. Sidecar is produced by plugin save-hook (3F-2) or DumpBPGraphCommandlet (3F-4). Plugin-absent state = `{available: false}`. Plugin is a prerequisite for the read capability.

- **"Enhanced by plugin"** (corrected framing, this research's anchor): offline BP edge-topology reader parses `.uasset` bytes directly — including `FEdGraphPin` LinkedTo edges via the binary approach Agent 11.5 called L3A S-B. Plugin-absent state is first-class functional. Plugin optionally enriches with enhancement data (spatial layout, comment containment, via_knots exec-flow annotations, compiled state, runtime values) but is not gating.

**Why this matters under D52**: D52 states "plugin-absent read functionality is first-class." Prior plan satisfied that for everything EXCEPT edge topology, which would fall back to `{available:false}` without sidecar. Corrected framing makes edge topology a first-class offline capability, bringing the foundation into alignment with D52's stated parity goal.

**What's NOT being relitigated**: D45 L3A full-fidelity EDITOR-ONLY (200+ K2Node heterogeneity is still the cost driver for FULL-FIDELITY). The corrected framing asks for **skeletal-subset S-B** — pin-trace on the 19 shipped skeletal K2Node types + a bounded extension set, not full 200+ fidelity. Spatial/comments/timelines/AnimState stay in enhancement layer. Full-fidelity remains sidecar-backed or plugin-backed.

---

## Mission

Reconstruct the Phase 3 M-sequence under the corrected "enhanced by plugin" framing. Produce an orchestrator-actionable recommendation that re-orders, re-scopes, or re-composes M0-M6 + any new milestones to match the corrected premise.

You must defend each change from evidence in prior research deliverables + the D-log. You are correcting a framing assumption, not inventing new scope.

---

## Load-bearing questions (Q1-Q7)

### Q1 — S-B re-scope under new role

D55 scoped S-B at **6-9 agent sessions** with these cost components:
- Base pin-block RE (3-4 sessions)
- LinkedTo resolution (1-2 sessions)
- Version-skew buffer (2-3 sessions)

That estimate assumed sidecar-oracle available. Under the corrected framing, S-B ships without sidecar-oracle — it must land on its own. Re-evaluate:

- What replaces the sidecar as validation oracle? (Candidates: editor-commandlet-emitted JSON for diff validation; hand-verified BP samples as a bounded corpus; cross-checking against UE 5.6 source code's own pin-reader logic.)
- Is cost still 6-9 sessions, or does the oracle substitution change it?
- What's the minimum viable S-B scope for shipping (must answer: edges resolvable? exec flow correct? data flow correct? which subset of K2Node types?)
- Honest session-count range with the substitute oracle.

### Q2 — What does the plugin still enhance?

Walk the M-alt spike's coverage table (Q3 of `docs/research/m-alt-commandlet-feasibility-2026-04-20.md`). That's 22 (c)+(d) tools with commandlet-accessibility verdicts. Under the new framing, apply the same methodology to the sidecar/enhancement layer: **what does the plugin contribute that offline-bytes-S-B cannot reach?**

Specifically evaluate:
- **Spatial data** (node X/Y positions, comment boundaries) — bytes-accessible or plugin-only?
- **Comment containment** (which nodes are inside which comment box) — requires spatial math over positions; is it offline-bytes-feasible?
- **`via_knots` exec-flow annotation** (Sidecar Design Q2 resolution) — plugin processes knot chains; can offline do this from raw LinkedTo edges with a post-pass?
- **Runtime state** (live UObject property values, PIE snapshot) — plugin-only.
- **Compiled derived data** (Niagara VM, compiled shaders, baked curves) — per M-alt Q3, some bytes-accessible, some plugin-only.
- **BP compile errors / warnings surfaced post-compile** — plugin-only.

Produce a table: enhancement-data-type × offline-feasibility × plugin-value. This becomes the contract for what the plugin's optional enhancement layer delivers.

### Q3 — Which of the 9 traversal verbs are pure-S-B vs enhancement-dependent?

Sidecar Design Session defined 9 offline traversal verbs (+ `bp_paths_between` deferred to v1.1). Under the new framing, each verb ships against S-B first and opts into enhancement data when available:

For each verb — `bp_list_graphs`, `bp_list_entry_points`, `bp_trace_exec`, `bp_trace_data`, `bp_show_node`, `bp_neighbors`, `bp_subgraph_in_comment`, `bp_find_in_graph`, `bp_paths_between` — answer:

- **Works with pure S-B?** (edges + nodes, no enhancement)
- **Needs enhancement?** (e.g., `bp_subgraph_in_comment` needs spatial data for comment containment)
- **Graceful degradation shape?** (e.g., `bp_trace_exec` returns without `via_knots` annotations when enhancement absent; caller gets a partial-but-correct trace)

**Output**: a verb-by-verb table with degradation modes. This clarifies which verbs ship in the S-B milestone vs which are sidecar-gated.

### Q4 — Rejected alternatives to reaffirm closure

Verify these are still correctly closed (don't re-derive; just confirm):

- **DR-2 L3A full-fidelity EDITOR-ONLY (D45)** — the skeletal-subset S-B is NOT full fidelity. 200+ K2Node bespoke serialization is out of scope. Confirm this stays out of scope under the new framing.
- **Sidecar-free plugin-absent future** — was there ever a path where the plugin isn't needed at all for any D52 category? No: writes (w), PIE state (a), live compiled state (c) still need plugin. Corrected framing doesn't eliminate the plugin; it relegates it to enhancement + writes.

### Q5 — Updated M-sequence

Produce a new M-sequence table replacing §Q5.3 of `docs/research/phase3-scope-refresh-2026-04-20.md`. At minimum include:

- **M0** (yaml grooming) — already shipped (`aa0d966`). Retain as historical note.
- **M1** (TCP scaffolding) — unchanged in scope. Verify it still parallelizes with the new S-B milestone.
- **M-new (S-B skeletal edge parser)** — pure .uasset bytes, ships 9 traversal verbs (or subset per Q3), NO plugin dependency.
- **M-sidecar (enhancement)** — save-hook + 3F-4 commandlet + enhancement schema + enhancement consumer. Ships after S-B proves itself. Enriches the existing verbs rather than enabling them.
- **M3, M4, M5** — unchanged where possible (they're plugin-TCP write/read tools, not sidecar-dependent).
- **M6** — collapses into M-new since S-B is now primary, not optional.

Include:
- Dependency chain (what must land before what)
- Parallelism opportunities (respect D49 path-limited-commit discipline)
- Per-milestone session-count range
- Confidence level per milestone

### Q6 — Which prior decisions need D-log amendment?

Identify which D-log entries need BLOCKQUOTE-AMENDMENT entries (using the amendment style already applied to §Q1.12 at commit `286fbad`):

- D48 (S-B FOLD-INTO-3F) — reopened; S-B is primary, not folded
- D54 (SHIP-SIDECAR-PHASE-A-FIRST) — superseded by new M-sequence; sidecar ships as enhancement not foundation
- D55 (S-B PURSUE-AFTER-SIDECAR at 6-9 sessions) — ordering reversed; cost possibly adjusted per Q1
- D57 (M-alt AUGMENT preserves D54) — verdict substrate removed; needs re-examination

List each D-log entry that needs amendment + proposed amendment text (blockquote form, 2-4 sentences each). Don't edit the D-log yourself; the orchestrator does that.

### Q7 — Framing-audit notes on YOUR OWN research

Following the pattern from scope-refresh + M-alt, add a framing-audit section flagging:
- Any assumption this handoff makes that you think is wrong
- Any cost estimate in the deliverable that feels aspirational
- Any priority ordering that fails the steel-man

Per memory `feedback_framing_audit.md`: push back if the handoff gets something wrong. "Enhanced by plugin" IS the corrected framing — don't re-relitigate that. But if within that framing the handoff specifies something poorly, call it out.

---

## You are NOT

- Writing S-B parser code or plugin C++.
- Implementing any tool.
- Relitigating D45 (L3A full-fidelity EDITOR-ONLY), D52 (near-parity), or D53 (Q1 displacement). Those stand.
- Re-designing the 9 traversal verbs — Sidecar Design Session + amendment spec already did that. Your Q3 just tags them with degradation modes.
- Designing the sidecar JSON schema — the amendment spec already covers it.
- Evaluating Phase 4 (Remote Control) or Phase 5/6 (distribution, per-project tuning).

---

## You ARE

- Treating the framing correction as authoritative. Don't evaluate "should we do this" — Noah already did that. Evaluate "how do we do this coherently given everything else shipped/decided."
- Defending every M-sequence change from evidence in input files.
- Producing concrete session-count ranges with confidence levels.
- Naming specific files, tools, and commits when referencing prior work.
- Flagging framing concerns (Q7).

---

## Input files (required reading)

### Tier 1 — Prior scope decisions

1. `docs/research/phase3-scope-refresh-2026-04-20.md` (commit `9e9dbe5`, amended `286fbad`) — current M-sequence.
2. `docs/research/m-alt-commandlet-feasibility-2026-04-20.md` (commit `44b080e`) — coverage table + empirical measurements.
3. `docs/research/level3a-skeletal-parse-study.md` (Agent 11.5) — original S-A/S-B split + 8-13 session cost estimate for full S-B.
4. `docs/research/level3-feasibility-study.md` (Agent 11) — L3A EDITOR-ONLY framing for full fidelity.
5. `docs/research/sidecar-design-resolutions-2026-04-19.md` — Sidecar Design Session (9 verb definitions, Q2 via_knots, Q4 widget/material deferrals).
6. `docs/specs/blueprints-as-picture-amendment.md` — sidecar schema + verb surface.

### Tier 2 — Shipped offline surface (what S-B builds on)

7. `server/uasset-parser.mjs` — existing binary parser (Level 1+2+2.5 + tagged-fallback D50). S-B extends this.
8. `server/offline-tools.mjs` — shipped offline tool handlers. S-B verbs slot in here.
9. `docs/audits/post-agent10-5-codebase-audit-2026-04-19.md` — parser health, extension points.

### Tier 3 — D-log anchors

10. `docs/tracking/risks-and-decisions.md` D45, D48, D52, D53, D54, D55, D56, D57 — full context around what's affected.

### Tier 4 — UE 5.6 reference (for Q1 cost re-evaluation)

11. `Engine/Source/Runtime/Engine/Classes/EdGraph/EdGraphNode.h` — `UEdGraphNode::Serialize()` base.
12. `Engine/Source/Runtime/Engine/Private/EdGraph/EdGraphNode.cpp` — pin serialization reference.
13. `Engine/Source/Runtime/Engine/Classes/EdGraph/EdGraphPin.h` / `FEdGraphPin` — pin-type + LinkedTo structure.
14. `Engine/Source/Developer/BlueprintCompiler/` or similar — K2Node-specific serialization quirks (whatever 11.5 cited as override cases).

---

## Deliverable structure

Write `docs/research/phase3-resequence-mcp-first-2026-04-20.md`:

1. **Executive summary** (3-5 bullets) — top-line Q1-Q7 answers.
2. **Q1 — S-B re-scope** — cost breakdown with substitute oracle; honest session range.
3. **Q2 — plugin enhancement contract** — enhancement-data-type × offline-feasibility × plugin-value table.
4. **Q3 — verb degradation modes** — 9-row table.
5. **Q4 — closure reaffirmation** — 2-3 sentences each for D45 + sidecar-free-future.
6. **Q5 — updated M-sequence** — milestone table + dependency chain + parallelism + costs + confidence.
7. **Q6 — D-log amendment list** — table of entries + proposed blockquote-amendment text.
8. **Q7 — framing-audit notes** — your pushback on this handoff's specifics.
9. **Appendix** — anything surprising in the input files worth preserving for future research.

Target ~2,000-3,500 lines. Tables + citations, not prose-only.

---

## Success criteria

- Orchestrator can take the deliverable and queue the next wave of dispatches without re-deriving. Specifically: the first post-research handoff (likely M-new S-B) should be drafnable from your Q5 + Q3 outputs alone.
- Every M-sequence change is traceable to an input-file citation or D-log entry.
- S-B's cost range is defensible from the oracle-substitution analysis (Q1) — no "still 6-9 sessions because D55 said so" without re-deriving.
- Q3's verb degradation table has all 9 verbs evaluated.
- D-log amendments in Q6 preserve the historical record (blockquote-on-existing, not in-place rewrite).

---

## Constraints

- Path-limited commit per D49 for the deliverable.
- Desktop Commander for git ops (shell: "cmd"). Native Git Bash fine if it works.
- No AI attribution.
- No parallel workers currently in flight (as of handoff write-time, HEAD `2ab0969`). M1 handoff is committed but NOT dispatched pending this re-sequence.

---

## Final checkpoint before deliverable

Before writing:

1. Have you read all Tier-1 files end-to-end?
2. Can you articulate "enhanced by plugin" vs "enabled by plugin" in one sentence without ambiguity?
3. Have you checked Engine/Source for the UE 5.6 pin-serialization pattern (Q1's cost re-evaluation)?
4. Do you have a concrete Q5 M-sequence that preserves D53 (Q1 displacement) + M0's yaml state + M1's TCP scaffolding?
5. Have you identified which D-log entries need amendment (Q6)?

If any "no," finish research before writing.
