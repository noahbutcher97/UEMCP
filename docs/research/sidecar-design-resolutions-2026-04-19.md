# 3F Sidecar Design — Open Question Resolutions

> **Author**: Sidecar Design Session researcher
> **Date**: 2026-04-19
> **Type**: Design research — resolves the 5 open questions in `docs/specs/blueprints-as-picture-amendment.md:131-138` to stable positions that feed Phase 3 scope refresh. No code, no yaml, no D-log edits. No new design ground invented.
> **Inputs**: amendment file, parent spec (`blueprint-introspection.md`), D44-D52 + DR-3, `level3a-skeletal-parse-study.md`, `level12-tool-surface-design.md`
> **Deliverable consumer**: Phase 3 scope refresh research handoff (downstream); DR-3 "sidecar writer as standalone early milestone" checkpoint

---

## Context — what changed since the questions were written (2026-04-15)

Four decisions landed between 2026-04-15 and 2026-04-19 that sharpen (and in Q5's case, partially answer) the open questions:

- **D45 (2026-04-16)** — locks 3F sidecar as the canonical offline BP-logic-read path with acknowledged soft editor dependency.
- **D48 (2026-04-16)** — establishes S-A/S-B skeletal split. S-A (name-only, L1 tagged-property) ships in Agent 10.5 as the robust-floor complement to the sidecar; S-B (pin-tracing) FOLD-INTO-3F. S-A shipped 2026-04-17 via `find_blueprint_nodes`.
- **D52 (2026-04-19)** — formalizes near-plugin-parity for offline READs as a first-class project goal. Plugin scope reduces to writes + genuinely-offline-infeasible reads (runtime state, pin topology without sidecar, compiled/derived data, reflection-only metadata).
- **DR-3 (backlog, 2026-04-19)** — flags the "ship sidecar writer as standalone early milestone" evaluation point for Phase 3 dispatch.

Under this context, the 5 questions resolve as follows.

---

## Framing principle — three-layer offline-BP model

The resolutions below all apply a single framing principle. Stating it once here, referenced from each Q:

| Layer | Produced by | Covers | Availability |
|-------|-------------|--------|--------------|
| **L0 — Structural** (shipped D37) | `inspect_blueprint` export walker | Export-table class names, parent class, generated class, CDO path | Always |
| **L1 — Semantic name-only** (shipped 2026-04-17 via `find_blueprint_nodes`, D48 S-A) | Pure `.uasset` byte parse + L1+L2+L2.5 struct registry + D50 tagged-fallback | Per-K2Node UPROPERTY payload: function called, variable accessed, event handled, macro invoked, cast target — find/grep workflows | Always |
| **L2 — Spatial + exec/data trace** (3F sidecar, Phase 3) | Editor save-hook dump via editor's own UEdGraph serializer | Pin edges, spatial layout, comment containment, traversal-verb substrate | When sidecar fresh |

**Design consequence for all 5 resolutions**:

1. **Sidecar should NOT replicate S-A.** Name-level find/grep is already handled by L1 and always-available. Sidecar scope focuses on what's expensive or impossible for the pure-bytes tier — spatial, pin-trace, exec flow, comment containment.
2. **Sidecar may assume strict preconditions** (mtime-aligned, save-hook has fired). Degradation path when sidecar is stale/missing is **graceful fall-back to L1**, not error. Find/grep workflows stay working; trace/spatial verbs return `{available: false}`.
3. **Under D52, sidecar is a transition tool** — plugin-mediated short-term parity toward the long-term goal of full offline parity (which would eventually include pin-trace via D48 S-B reopening). Design sidecar to be "the fast path for L2" rather than "the only path for everything."
4. **When a scope/fidelity/fallback question has two answers, prefer: narrower sidecar + richer fidelity over broader sidecar + shallow coverage.** Scope breadth is cheap to add later (v1.1+) on workflow-demand signals; fidelity gaps are expensive to close retroactively.

Each resolution below applies this principle. Per-Q rationale callouts reference it as **(layered-model)** where it directly drives the verdict.

---

## Q1 — Sidecar location

**Question (verbatim)**: *Sidecar location — next to the `.uasset` (default in this draft) or in a parallel `Saved/UEMCP/BPCache/` mirror tree? Next-to-asset is simplest for tooling but pollutes Content/ visually in the Content Browser. Parallel-mirror is cleaner but adds path translation logic.*

**Decision axis**: where does the save-hook write `<bp_name>.bp.json`, and where does the offline reader look for it?

**Options considered**:
- **(A) Next-to-asset** (amendment draft default): `BP_OSPlayer.bp.json` sits alongside `BP_OSPlayer.uasset`. Simplest reader lookup (derive path by extension swap). Pollutes `Content/` with JSON siblings visible in file explorer and potentially surfaced by UE asset discovery. Adds `.bp.json` to `.p4ignore` / `.gitignore` lives on every asset folder pattern match.
- **(B) Parallel mirror under `Saved/UEMCP/BPCache/`**: `<ProjectDir>/Saved/UEMCP/BPCache/Game/Blueprints/Character/BP_OSPlayer.bp.json` mirrors `Content/Game/Blueprints/Character/BP_OSPlayer.uasset`. Path translation is one helper (swap `Content/` prefix → `Saved/UEMCP/BPCache/` prefix, swap extension). `Saved/` is UE's established convention for ephemeral caches (DDC, Logs, Backup) — already ignored by convention in every UE team workflow.
- **(C) `DerivedDataCache/` analog**: put sidecars in DDC. Rejected on read: DDC files are keyed by content hash in a flat layout; reader cannot map `.uasset` path → DDC key without going through the editor's DDC system. Defeats the "offline readable without editor" property.

**Recommended resolution**: **Option B — `<ProjectDir>/Saved/UEMCP/BPCache/` mirror tree.**

**Rationale**:
- **UE convention alignment**. `Saved/` is the existing "this is per-developer cache, ignore in VCS" boundary. Teams already have `Saved/` as a gitignore/p4ignore entry without per-project effort. One added line (`Saved/UEMCP/`) — or even zero if the project's p4ignore already covers `Saved/*` — versus scattering `*.bp.json` ignore patterns across the asset tree.
- **Content Browser cleanliness**. Option A surfaces `.bp.json` files in OS file explorer next to assets, confusing team members and tooling. In Perforce workflows, accidental add/checkin risk is real. Option B places sidecars in a directory tree already mentally tagged as "cache."
- **Per-developer naturally**. D45 acknowledges sidecar soft-dependency on editor. `Saved/` is per-developer by UE convention — sidecars are "my local cache built from the shared source asset," matching reality.
- **(layered-model)**. Strict precondition — "sidecar must exist in mirror tree, mtime-aligned" — is acceptable because the degradation path is L1 (pure-bytes find/grep via `find_blueprint_nodes`), not failure. A fresh-checkout developer with no sidecars still gets every find/grep workflow working; only L2 trace/spatial verbs return `{available: false}`. Per-developer `Saved/` placement is the sidecar's native home precisely because L1 absorbs the availability cost.
- **D52 near-plugin-parity compatibility**. The reader-side logic that the offline tool uses to locate sidecars is a single path-translation helper. No architectural impact on offline tool surface; does not interact with `assetCache`/`indexDirty` freshness (D33) since sidecar lookup is independent of the source `.uasset` mtime chain (freshness check compares sidecar mtime vs `.uasset` mtime — same logic either location).
- **Path translation cost is negligible**. One helper in both the C++ writer (`FPaths::ProjectSavedDir() / TEXT("UEMCP/BPCache") / AssetRelativePath + TEXT(".bp.json")`) and the JS reader. Reading 500 sidecars during a corpus scan costs the same disk I/O either way; the path-derivation overhead is ~microseconds per call.

**Implementation implications**:
- **Sidecar writer scope (3F-2)**: delegate handler computes target path as `FPaths::ProjectSavedDir() / TEXT("UEMCP") / TEXT("BPCache") / AssetRelativeFromContent + TEXT(".bp.json")`. Creates intermediate directories via `IFileManager::Get().MakeDirectory(Path, /*Tree=*/true)` before write. Error on write (disk full, permissions) must not block asset save — log + swallow per amendment 3F-2.
- **prime_bp_cache (3F-3)**: iterates BPs via Asset Registry, writes sidecars to the mirror tree. Idempotency check compares `Saved/UEMCP/BPCache/.../X.bp.json` mtime vs `Content/.../X.uasset` mtime.
- **Offline tool response**: reader (the consumer-side sidecar fetch in offline tools) takes the `.uasset` path and computes the sidecar path via the same translation. Freshness check: if sidecar mtime < uasset mtime → stale; missing file → `{available: false, reason: "no_sidecar_and_editor_offline"}` per amendment §Fallback path.
- **Amendment file update needed**: **yes**. Amendment §Cache model `Repo policy` bullet and §Phase 3 plugin requirements 3F-2 / 3F-3 need revision. Blockquote convention.
- **CI / fresh-checkout consequence**: the per-developer `Saved/` placement makes "zero sidecars at start" the default for CI pipelines, fresh-checkout audit workflows, and any agent-automation context. These environments MUST run `prime_bp_cache` once before L2 traversal verbs return useful data (L0 + L1 per D48 S-A remain always-available, so find/grep workflows are unaffected). The amendment already mentions `prime_bp_cache`, but Option B elevates this from "usually fine" to a hard precondition for L2 — worth surfacing in the Phase 3 dispatch handoff so CI runbooks include the priming step.

**Still-open flag**: **no**. Grounded in UE convention + D-log principles.

---

## Q2 — Knot collapse semantics

**Question (verbatim)**: *Knot collapse semantics — when `collapse_knots: true`, do we want the wire to report the original knot path (so positional comparison still works) or the collapsed direct edge only? Default to collapsed-only with a `via_knots: ["N17", "N23"]` annotation.*

**Decision axis**: how do `bp_trace_exec` and `bp_trace_data` represent wires that pass through reroute/knot nodes when knot-collapsing is on?

**Options considered**:
- **(A) Full knot path in tree** (collapse off): tree includes knot nodes as distinct entries. Faithful to layout but bloats token count on BPs with heavy reroute discipline.
- **(B) Collapsed-only, no annotation**: edges jump from source to final target silently. Smallest token footprint; loses spatial auditability.
- **(C) Collapsed with `via_knots` annotation** (amendment draft proposal): edges jump source → final target but carry `via_knots: ["N17", "N23"]` listing the collapsed knot IDs in traversal order. Preserves auditability at negligible cost.

**Recommended resolution**: **Option C — confirm the amendment's draft proposal. Default `collapse_knots: true` with `via_knots` edge annotation. `collapse_knots: false` re-exposes knots as tree entries.**

**Rationale**:
- **Token budget grounded in data**. Agent 11.5's coverage analysis measured `BP_OSPlayerR` at 35/240 K2Nodes = 14.6% Knot rate. Uncollapsed, a 20-hop exec trace averages ~3 knot entries adding ~60 tokens of noise per trace. For the dominant "trace from BeginPlay" workflow, that compounds fast.
- **D50 tagged-fallback pattern parallels**. Provide the escape hatch (`collapse_knots: false` / `via_knots` annotation) without paying the cost on the common path. Same principle that shipped in Agent 10.5.
- **D48 S-A consistency**. S-A already treats Knot as a passthrough class-identity marker — no semantic data extracted. Sidecar verbs collapsing knots by default keeps offline-find/grep and sidecar-traverse behavior aligned at the verb surface, even though the underlying data differs (S-A sees export-table knots; sidecar sees layout-positioned knots).
- **Spatial auditability preserved**. `via_knots: ["N17", "N23"]` plus the dump's per-knot `pos` field lets a caller who needs to render the layout reconstruct the wire path exactly. The common-case traversal consumer doesn't pay for that reconstruction.

**Implementation implications**:
- **Sidecar writer scope (3F-1 / 3F-2)**: no change. Sidecar dump keeps knots as full nodes (`{id: "N17", type: "knot", pos: [...], inputs: [...], outputs: [...]}`) per amendment §Knot/reroute nodes — writer emits complete data, verb decides how to present.
- **Offline tool response (traversal verbs)**: `bp_trace_exec` and `bp_trace_data` walker skips knot nodes by default, emits edges of the form `{from: "N3", to: "N8", via_knots: ["N17", "N23"]}` when knots were traversed. When `collapse_knots: false`, knots appear as full tree entries with their standard pos/pin data. `via_knots` is omitted entirely (not empty-array) when zero knots were traversed — matches the amendment's omit-defaults convention.
- **Amendment file update needed**: **no substantive change** — the draft already proposes this answer. Minor clarification in §Open questions to flag it as resolved (or move to a "Resolved questions" section post-Phase-3-refresh).

**Still-open flag**: **no**. Confirming a grounded draft proposal.

---

## Q3 — AnimBP state machines

**Question (verbatim)**: *AnimBP state machines — parent spec already covers AnimGraph nodes, but state machines are intrinsically spatial. Do they need their own traversal verbs (`anim_trace_transitions`) or do `bp_trace_exec` and friends adapt? Defer to Phase 3 design pass.*

**Decision axis**: do we ship dedicated state-machine traversal verbs in 3F v1, generalize `bp_trace_exec` to handle state-transition topology, or defer traversal verbs for state machines entirely (sidecar dump still captures the data, `get_animbp_graph` from parent spec handles text read)?

**Options considered**:
- **(A) Dedicated `anim_trace_transitions` / `anim_show_state` verbs in v1**: first-class state-machine traversal. ~3-5 new verbs, new module dependencies in plugin handler (AnimGraph editor types). Adds meaningful Phase 3 scope.
- **(B) Generalize `bp_trace_exec` to handle state-transition edges**: reuses the existing verb. Requires expanding the verb's contract to non-UEdGraph topologies, which is net-new design ground.
- **(C) v1 ships sidecar data + routes traversal through existing verbs; defer dedicated anim verbs to v1.1+ on workflow-demand signal**: sidecar dump includes state-machine structure (matches parent spec's `get_animbp_graph`). `bp_show_node` on a state-machine node returns its states/transitions as structured data. `bp_trace_data` on a transition rule sub-graph works because the rule graph IS a UEdGraph. No new verbs; no generalization.

**Recommended resolution**: **Option C — defer dedicated anim verbs to v1.1+. v1 ships state-machine structure inside the sidecar dump; existing verbs handle the sub-graph cases they can reach.**

**Rationale**:
- **D48 pattern (ship narrow, defer on demand)**. S-A shipped with 13 K2Node types excluding math operators and delegate payloads — explicit "prove workflow demand before graduating." AnimBP traversal verbs are structurally a larger scope-add (~3-5 verbs + module deps) than S-A was, so the same gating applies more strongly.
- **(layered-model)**. "Which BPs use state machine X?" and "does this AnimBP handle locomotion?" are name-level questions — L1 covers them today via `find_blueprint_nodes` class-filter on state-machine node classes. The genuine sidecar-only cases are (a) transition rule data-flow tracing, which `bp_trace_data` already handles on the rule sub-graph, and (b) state-to-transition topology, which is speculative for ProjectA's current workflows. Narrower sidecar scope + richer fidelity (when it lands) beats broader scope + shallow state-machine-specific verbs in v1.
- **D52 near-plugin-parity compatibility**. Parent spec's `get_animbp_graph` (planned TCP tool) covers the "read the state machine as data" workflow. The sidecar adds nothing new there. The *traversal* use case (walk states, follow transitions) is speculative for ProjectA — the dominant AnimBP workflows Noah has described so far are "what notifies fire on this AS," which is outside state-machine traversal entirely.
- **Option B is net-new design ground** — generalizing `bp_trace_exec` to non-UEdGraph topologies violates the handoff's "don't invent new design ground" rule.
- **Sub-graph reachability with existing verbs**. A transition rule sub-graph is a UEdGraph of UK2Nodes — `bp_trace_data` works on it without modification. A state's EventGraph (if the state has one) is also UEdGraph — `bp_trace_exec` works. The gaps are precisely the state-to-state and state-to-transition topology, which are the speculative bits.

**Implementation implications**:
- **Sidecar writer scope (3F-1)**: `dump_graph` on a `UAnimBlueprint` emits state machines as structured data per parent spec's `get_animbp_graph` format (state machines, states with blend/animation refs, transitions with blend times + rule graph sub-IDs). State-machine nodes appear in the dump's `nodes[]` with `type: "anim_state_machine"` and a `state_machine: {...}` field. No new verb support needed in v1 plugin.
- **Offline tool response**: `bp_show_node` on a state-machine node returns the structured state/transition data (re-exposing the sidecar's `state_machine` field). `bp_trace_data` on a transition rule graph works as-is because rule graphs are UEdGraph. No new verbs ship in v1.
- **Amendment file update needed**: **yes**. §Open questions Q3 rewritten to reflect "v1 = sidecar data + reuse existing verbs; dedicated anim verbs defer to v1.1." Blockquote.

**Still-open flag**: **partial — deferred-with-signal.** Resolution principle is stable (defer to v1.1 pending workflow demand). The *specific* anim-verb shape when v1.1 comes is future design work, not pre-Phase-3 blocking. The decision the handoff asked to resolve (v1 inclusion or not) IS resolved to "not in v1." **RESOLUTION CONFIRMED; ONLY THE FOLLOW-ON TIMING IS OPEN.**

---

## Q4 — Material graphs

**Question (verbatim)**: *Material graphs — same question, same defer. Material expressions have positions and benefit from spatial traversal, but they're a different node hierarchy entirely.*

**Decision axis**: do material graphs get their own traversal verbs in 3F v1, does `bp_trace_data` adapt to UMaterialExpression graphs, or does v1 rely on parent spec's `get_material_graph` for reads and defer traversal?

**Options considered**:
- **(A) Dedicated `material_trace_input` / `material_show_expression` verbs**: first-class material traversal. New verbs + node-hierarchy dispatch. Adds Phase 3 scope.
- **(B) Generalize `bp_trace_data` to UMaterialExpression**: verb becomes graph-type-agnostic. Net-new design ground — material node base class is different (UMaterialExpression vs UEdGraphNode), connections are `FExpressionInput`, not `UEdGraphPin`.
- **(C) Parent spec's `get_material_graph` is the read interface; no traversal verbs in v1; defer on workflow-demand signal**: matches Q3 pattern. `get_material_graph` already planned in Phase 3 TCP toolset (materials toolset per tools.yaml planning stub per D51).

**Recommended resolution**: **Option C — defer material traversal verbs entirely from 3F v1. Parent spec's `get_material_graph` is the material read interface. Revisit on workflow-demand signal.**

**Rationale**:
- **Same pattern as Q3**. D48 ship-narrow-first logic applies identically.
- **Stronger scope-creep argument than Q3**. Materials are a fundamentally different node hierarchy — UMaterialExpression has no UK2Node parent, uses FExpressionInput not UEdGraphPin. Even Option B's "generalize the verb" requires non-trivial design work to unify the two graph models. Not allowed per handoff's "no new design ground" rule.
- **D52 near-plugin-parity check**. Parent spec's `get_material_graph` + Agent 10.5's `read_asset_properties` already cover material read via (i) full text dump when the plugin is online, (ii) tagged-property iteration over UMaterial export data when offline. D50's tagged-fallback handled UMaterialExpression custom structs in aggregate (601 unique struct names parsed automatically per Agent 10.5 report); specific node-layout extraction beyond CDO is the gap. That gap is genuinely editor-mediated (matches D52's "genuinely-offline-infeasible reads" category for deeply-structured non-UEdGraph asset types) — 3F sidecar + traversal is one way to close it, but v1 scope should not include materials.
- **Scope-creep cost**. 3-5 new verbs + dispatch layer + version-skew surface across UE5.6↔5.7 UMaterialExpression changes. Speculative for current workflow patterns.
- **(layered-model)**. Materials don't have an L1 floor today (different node hierarchy — UMaterialExpression, not UK2Node — so `find_blueprint_nodes` doesn't cover them). Closing that gap is a separate track: the queued parser-extensions work (FExpressionInput native layout) improves offline material-CDO reads at L1, which is where investment should land first under D52. Adding material spatial/trace verbs to the sidecar in v1 would be broader-scope-shallower-coverage (spatial without even L1 find/grep), exactly the tradeoff the framing principle rejects.

**Implementation implications**:
- **Sidecar writer scope (3F-1)**: `dump_graph` on `UMaterial` is **out of scope for v1**. The tool signature restricts to `UBlueprint` subclasses; calling on UMaterial returns a clean error (`{error: "material_graphs_not_supported_in_v1", hint: "use get_material_graph"}`). Plugin module dependencies do NOT need to add UMaterialEditor / MaterialEditor unless/until v1.1 ships material support.
- **Offline tool response**: no sidecar for materials. `read_asset_properties` still works (offline, tagged-property level). Traversal verb calls with a material path return the same clean "not supported" error.
- **Amendment file update needed**: **yes**. §Open questions Q4 rewritten to state "v1 = no material traversal verbs; `get_material_graph` is the read interface; defer v1.1+ on workflow-demand signal." Blockquote.

**Still-open flag**: **no for v1 scope.** Same partial-defer as Q3: the v1 decision is resolved (materials out); specific v1.1 verb shape is future work.

---

## Q5 — CDO defaults

**Question (verbatim)**: *CDO defaults — out of scope for this amendment. Reading the current values of a BP's variables (vs the variable definitions) needs Remote Control API (Phase 4) or a TCP CDO-read command. Tracked separately.*

**Decision axis**: does the amendment's "out of scope" text still reflect reality, given what Agent 10/10.5 shipped?

**Options considered**:
- **(A) Leave as-written**. Amendment continues to state CDO defaults need RC API / TCP. Now factually stale.
- **(B) Rewrite to reflect Agent 10/10.5 delivery**. Offline CDO reads SHIPPED via Level 1+2 parser, `inspect_blueprint.include_defaults`, `read_asset_properties`, and D50's tagged-fallback. Clarify the remaining scope boundary as "runtime CDO state only" (live-modified-but-not-saved values, transient properties, construction-script results).

**Recommended resolution**: **Option B — rewrite Q5 to reflect the Agent 10/10.5 delivery of offline CDO reads; clarify remaining scope boundary.**

**Rationale**:
- **D52 near-plugin-parity compatibility + factual reality**. Offline CDO reads ARE offline-parity-complete for serialized-state CDO values. D50's tagged-fallback decoded 601 unique struct names across 19K files without loading referenced assets. `inspect_blueprint.include_defaults` exposes CDO property values offline via export-table walk + FPropertyTag iteration. `read_asset_properties` works on any asset.
- **Amendment text is factually stale**. It was written 2026-04-15 before Agent 10 / Agent 10.5 shipped (2026-04-16 / 2026-04-17). Leaving the text unchanged misleads Phase 3 scope refresh into thinking CDO-defaults is a Phase-3-or-4 gap, which it isn't.
- **Remaining scope is narrow and correctly Phase 4 territory**. What's *not* readable offline:
  1. **Runtime/live-modified CDO state** — editor has the BP open, someone changed a variable default, hasn't saved. Offline sees the on-disk value.
  2. **Transient / DuplicateTransient properties** — not serialized by design. Phase 3 plugin TCP read or Phase 4 RC API.
  3. **Construction-script-computed values** — run-time computed at PIE / editor spawn. Phase 4 RC API.
  4. **Properties set via editor scripting** — e.g., Python Editor Script Plugin modifies `GeneratedClass` CDO at runtime. Phase 4 RC API.
- **Incremental sidecar value over existing offline coverage is thin and not worth the schema-bloat cost**. The save-hook *does* run in-editor with full UProperty reflection, so it *could* close the residual ~9% offline gap that D50 left (22K `unknown_struct` + ~21K `expression_input_native_layout_unknown` markers). But: (a) that gap is already queued for closure via the parser-extensions handoff (`FExpressionInput` native layout + nested `FieldPathProperty`) which targets the offline tier directly, landing the coverage in `read_asset_properties` / `inspect_blueprint.include_defaults` for all consumers — not just sidecar readers; (b) adding CDO to the sidecar dump roughly doubles the schema surface (every BP's CDO-property tree duplicates data already readable from the `.uasset` export); (c) the consumer-side ergonomics are identical — `read_asset_properties` already returns the same shape. Under D52 near-plugin-parity, investment belongs in the offline path that benefits every read, not in a sidecar-only CDO payload.
- **(layered-model)**. CDO serialized-state is the canonical example of "L1 already covers this" — sidecar replicating it would be broadening scope to duplicate existing always-available coverage, exactly the anti-pattern the framing principle rejects. Keeping the sidecar focused on the genuine L2-only cases (spatial + pin-trace + exec flow) IS the resolution.

**Implementation implications**:
- **Sidecar writer scope (3F-1 / 3F-2)**: **no CDO responsibility**. Sidecar focuses on UEdGraph / spatial / pin-edge data — the things offline parsing genuinely can't reach (per D48 S-B FOLD-INTO-3F). CDO defaults stay in `read_asset_properties` / `inspect_blueprint.include_defaults`.
- **Offline tool response**: unchanged. Already shipped per Agent 10/10.5.
- **Amendment file update needed**: **yes — factual correction**. §Open questions Q5 rewritten to: "RESOLVED — offline CDO reads shipped via Agent 10 (Level 1+2 parser) + Agent 10.5 (D47→D50 tagged-fallback). `read_asset_properties` and `inspect_blueprint.include_defaults` cover the CDO-serialized-state read surface. Remaining runtime-CDO state (Transient properties, construction-script results, live-unsaved editor modifications) stays on the Phase 4 RC API / TCP CDO-read roadmap per §original Q5." Blockquote.

**Still-open flag**: **no**. Factual correction grounded in the D-log — Q5's original "out of scope" text simply needs to match what shipped.

---

## Summary table

| # | Question | Resolution | Still-open? |
|---|----------|-----------|-------------|
| Q1 | Sidecar location | **`<ProjectDir>/Saved/UEMCP/BPCache/` mirror tree** (Option B). Aligns with UE `Saved/`-as-cache convention; one-line p4/gitignore; zero Content/ pollution. | No |
| Q2 | Knot collapse semantics | **Confirm amendment draft** (Option C). Default `collapse_knots: true` with `via_knots: [...]` edge annotation; `collapse_knots: false` re-exposes knots as tree entries. | No |
| Q3 | AnimBP state machines | **v1 ships sidecar data; reuse existing verbs; defer dedicated anim verbs to v1.1+** on workflow-demand signal. Sub-graph cases (rule graphs) work via `bp_trace_data` as-is. | No for v1; v1.1 verb shape is future work |
| Q4 | Material graphs | **v1 = no material traversal verbs; `get_material_graph` is the read interface**; defer v1.1+ on workflow-demand signal. Prevents net-new design-ground invention and scope creep. | No for v1; v1.1 verb shape is future work |
| Q5 | CDO defaults | **Factual correction** — offline CDO reads already shipped via Agent 10/10.5. Sidecar has no CDO responsibility. Remaining runtime-CDO state stays Phase 4 RC API. | No |

---

## §2 Downstream impact on Phase 3 scope refresh

### What belongs in the sidecar writer (plugin component — 3F-1 / 3F-2 / 3F-3)

Per the Q1-Q5 resolutions, the sidecar-writer plugin scope crystalizes as:

1. **`dump_graph` TCP command (3F-1)**: restricted to `UBlueprint` subclasses (UBlueprint, UAnimBlueprint, UWidgetBlueprint, UEditorUtilityBlueprint). **Not UMaterial** per Q4.
2. **Output path translation (Q1)**: `FPaths::ProjectSavedDir() / TEXT("UEMCP/BPCache") / AssetRelativeFromContent + TEXT(".bp.json")`. Intermediate directories created on demand. Writer error must not block asset save (log + swallow).
3. **Dump format content** (per parent spec + amendment §Schema additions):
   - UEdGraph nodes with `pos`, `size`, `comment_id`, `enabled` (spatial additions).
   - `comments[]` top-level section with pre-computed `contains[]`.
   - Knot nodes emitted as full entries (consumers collapse at verb time per Q2).
   - AnimBP state-machine structure inline in node entries (Q3): `{type: "anim_state_machine", state_machine: {states[], transitions[]}}`.
   - **No CDO default values** (Q5) — those stay in offline `read_asset_properties` / `inspect_blueprint`.
4. **Save-hook (3F-2)**: delegate fires on `UBlueprint` (and subclass) save. Plugin setting to disable the hook for users who opt out.
5. **`prime_bp_cache` command (3F-3)**: one-shot iteration over project BPs. Writes to the mirror tree. Idempotent by mtime comparison.
6. **Schema version** (amendment §Cache model): `"version": "1.x.y"` on every sidecar. Reader rejects mismatched majors → falls back to TCP `dump_graph`.

### What belongs in offline tools (consumer side)

1. **Sidecar reader** (new in offline-tools.mjs): takes `.uasset` path → computes `Saved/UEMCP/BPCache/` path (Q1 helper) → reads JSON → validates schema version → returns parsed data. Stale/missing handling per amendment §Fallback path.
2. **Traversal verbs** (per amendment §Traversal verb surface + Q2 resolution): `bp_list_graphs`, `bp_list_entry_points`, `bp_trace_exec`, `bp_trace_data`, `bp_show_node`, `bp_neighbors`, `bp_subgraph_in_comment`, `bp_paths_between` (v1.1 per D41), `bp_find_in_graph`. All consume the sidecar; none query the plugin.
3. **Knot-collapse logic** (Q2): implemented in the traversal-verb walker, not in the dump writer. Verb emits edges with `via_knots: [...]` annotation by default.
4. **Existing offline surface unchanged** (Q5): `inspect_blueprint.include_defaults`, `read_asset_properties`, `find_blueprint_nodes` (D48 S-A). These stay canonical for CDO-serialized-state and name-only skeletal reads.

### Resolutions that call for new tools / specs we didn't have before

**None.** All 5 resolutions use existing tool surface or reduce scope against the amendment draft. Specifically:

- Q1 resolution adds **one helper function** (path translation) in both C++ writer and JS reader — not a new tool.
- Q2 resolution adds **one field** (`via_knots`) to traversal-verb edge output — refinement of existing verbs, not a new verb.
- Q3/Q4 resolutions **reduce** v1 scope versus the amendment draft (no new anim/material verbs in v1).
- Q5 resolution documents **existing shipped tools** (no new work).

### Net effect on DR-3 (sidecar writer as standalone early milestone)

The resolutions sharpen the DR-3 evaluation positively: with Q1/Q2/Q5 resolved and Q3/Q4 deferred to v1.1, the standalone-early-milestone scope is the narrowest possible:

- **3F-1 `dump_graph`** (BP-only, one TCP command, one output format).
- **3F-2 Save-hook sidecar writer** (one delegate, one path helper, one error-swallow policy).
- **3F-3 `prime_bp_cache`** (one editor command, mtime idempotency).
- **Offline reader** (one path helper + schema-version check + fallback response).

This is roughly 4-6 agent sessions of plugin work + 1-2 agent sessions of offline-tool-side reader + traversal-verb wiring. The traversal verbs (9 verbs per amendment) are consumer-side of the sidecar and ship with the reader. **Total 3F v1 bundle: ~6-10 agent sessions**, clearly sub-milestone scope and appropriate for DR-3's "ship before rest of Phase 3" framing.

---

## §3 Confidence

**HIGH overall**. Component breakdown:

- **Q1 (sidecar location)**: HIGH. Grounded in UE `Saved/` convention + D-log principles. Noah's call only if he has a hidden reason (e.g., ProjectB-specific filesystem constraint) that inverts the tradeoff. Default should ship.
- **Q2 (knot collapse semantics)**: HIGH. Confirms amendment draft; grounded in Agent 11.5's measured 14.6% Knot density + D50's "escape hatch without common-path cost" pattern.
- **Q3 (AnimBP)**: MEDIUM-HIGH. The defer-to-v1.1 principle is stable; confidence that specific anim workflows won't demand v1 inclusion is MEDIUM. If Noah has an anim-facing workflow in mind that the analysis didn't surface, v1 scope could expand. Author's read of ProjectA's anim workflows (combat timing driven by AnimNotifies, not state-machine traversal) supports the defer verdict.
- **Q4 (material graphs)**: HIGH. D52 near-plugin-parity + parent spec's existing `get_material_graph` + D48 ship-narrow-first all converge on defer. Stronger scope-creep argument than Q3.
- **Q5 (CDO defaults)**: HIGH. Factual correction grounded in what shipped. No judgment call.

**Grounded vs speculative**:
- GROUNDED: Q1 (UE convention), Q2 (coverage-ratio measurements), Q5 (shipped Agent 10/10.5 capability).
- GROUNDED: DR-3 scope math (plugin components enumerated against amendment § Phase 3 plugin requirements).
- SPECULATIVE: Q3/Q4 workflow-demand signal (the author's read of ProjectA's anim/material workflows may miss use cases Noah is tracking). These are framed as **defer-with-signal** explicitly so the assumption is auditable.

**Author did-not-do-but-could-have**: did not inspect the ProjectA plugin distribution / P4 workflow directly for Q1 edge cases (e.g., does ProjectB' P4 typemap treat JSON files specially?). Author's confidence that `Saved/` is safely ignored rests on general UE convention, not project-specific P4 verification. Flag for Phase 3 dispatch-time check if any P4 surprise emerges, though unlikely given the convention strength.

**Author's blind spot**: the 5 questions are resolved individually; didn't stress-test interaction effects. Example: if Q1 changes (sidecar moves to a VCS-tracked location for some future reason), does that affect Q5's "no CDO in sidecar" conclusion? Spot-check: no — Q5 is grounded in offline-tool coverage of CDO, independent of sidecar location. No cross-question interaction flagged.

---

## Amendment file updates needed (summary)

Per-question amendment file updates, applied via blockquote convention if/when the amendment is updated. Changes are documentation-only; no schema or implementation changes beyond what the resolutions imply.

| Location | Change |
|----------|--------|
| §Cache model, `Repo policy` bullet | `sidecars live under <ProjectDir>/Saved/UEMCP/BPCache/ (mirror tree); gitignore/p4ignore add one line under Saved/ (typically already present)` |
| §Phase 3 plugin requirements 3F-2 | path computation helper (ProjectSavedDir → UEMCP/BPCache → asset-relative-from-content) + IFileManager MakeDirectory Tree=true |
| §Phase 3 plugin requirements 3F-3 | idempotency via sidecar-mtime vs uasset-mtime; writes into mirror tree |
| §Open questions Q1 | resolved → Option B; see this doc |
| §Open questions Q2 | resolved → Option C (confirms draft); see this doc |
| §Open questions Q3 | resolved → v1 defer; sidecar captures state-machine data; existing verbs handle rule sub-graphs |
| §Open questions Q4 | resolved → v1 defer; `get_material_graph` is the read interface |
| §Open questions Q5 | RESOLVED — offline CDO reads shipped via Agent 10/10.5; remaining runtime-CDO state stays Phase 4 RC API |

All amendment updates are non-blocking for Phase 3 scope refresh; this research doc is the authoritative resolution record until/unless Noah wants the amendment itself updated for clarity.

---

## Follow-on items surfaced (not dispatched)

Flagged for backlog.md consideration at Phase 3 dispatch:

1. **BL-candidate**: AnimBP dedicated traversal verbs for v1.1 (`anim_trace_transitions`, etc.) — workflow-demand-signal trigger.
2. **BL-candidate**: Material traversal verbs / `bp_trace_data` generalization for v1.1 — workflow-demand-signal trigger.
3. **BL-candidate**: P4 typemap verification for `Saved/UEMCP/BPCache/` across ProjectA + ProjectB — spot-check during Phase 3 dispatch.

These are not urgent; they inherit the same "defer until demand surfaces" pattern the rest of D48's scope-discipline has established.
