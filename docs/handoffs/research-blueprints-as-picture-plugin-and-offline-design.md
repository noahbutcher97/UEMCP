# Handoff: Research the plugin-side and offline-side design for blueprints-as-picture

**From**: Orchestrator (Noah's seat)
**Date opened**: 2026-04-15
**Worker type**: Research (read-only investigation; no code, no commits, no doc edits outside the deliverable)
**Deliverable**: A single markdown report at `docs/research/blueprints-as-picture-design-research.md` answering the questions in §Questions to answer below. Prose and tables only — no implementation.
**Scope**: Blueprints-as-picture, the amendment landed at `docs/specs/blueprints-as-picture-amendment.md`. You may reference the parent spec (`docs/specs/blueprint-introspection.md`) where the two designs interact, but do not redesign the parent.
**Out of scope**: Writing code, modifying `phase3-plugin-design-inputs.md`, committing anything. Track 2a (offline asset-registry parser) is separate work — do not block on it, do not design against it beyond noting cache-integration touchpoints.

---

## Why this handoff exists

The amendment at `docs/specs/blueprints-as-picture-amendment.md` defines *what* we want (spatial fields on every node, a `comments[]` section with pre-computed `contains[]`, nine traversal verbs, a sidecar JSON cache) but punts *how to build it well* to Phase 3. Before we update `docs/specs/phase3-plugin-design-inputs.md` with a new bucket 3F, we need real research on the plugin-side extraction path and the offline-side consumption path, because the wrong architectural call here costs weeks.

Two specific asymmetries make this research-worth-the-time:

1. **The plugin side has three viable paths** — editor-mediated TCP, offline UProperty parser, sidecar-via-Save-hook — and the amendment currently assumes the third without rigorous comparison. If the sidecar approach turns out to be fragile (engine upgrades, BP variants we haven't considered, multi-user workflows), we want to know now.
2. **The offline side has a cache-correctness problem that the amendment hand-waves.** "D33 freshness model" is the stated mechanism but the amendment doesn't work through what happens when (a) the sidecar exists but is schema-version-mismatched, (b) the BP was edited in another editor instance, (c) the BP has unsaved changes in a running editor, (d) the user reverted via P4/Git and the sidecar is newer than the asset on disk. Each of those needs a deterministic answer before the verbs can claim "offline-tool latency."

Research, not design. The output informs design; it is not the design.

---

## Context you need (inlined — do not rely on external memory)

### The amendment in one paragraph

`docs/specs/blueprints-as-picture-amendment.md` adds spatial fields (`pos`, `size`, `comment_id`, `enabled`) to the per-node JSON defined in the parent spec, adds a new top-level `comments[]` section with pre-computed `contains[]` arrays, defines nine read-only traversal verbs (`bp_list_graphs`, `bp_list_entry_points`, `bp_trace_exec`, `bp_trace_data`, `bp_show_node`, `bp_neighbors`, `bp_subgraph_in_comment`, `bp_paths_between`, `bp_find_in_graph`) that operate on a cached dump, and specifies a sidecar JSON file (`<bp>.bp.json` next to `<bp>.uasset`) written by a `UBlueprint` Save-hook. Phase 3 plugin requirements are three commands: `dump_graph` (TCP), Save-hook sidecar writer, `prime_bp_cache` (one-shot iteration).

### The parent spec's position

`docs/specs/blueprint-introspection.md` (771 lines) defines the full-BP JSON dump format, NodeToCode-style token reductions, detail-level tiers, orphan function coverage, AnimBP/Widget/Material graph handling, and a four-tier visual-capture design that explicitly frames "text first, visual second" and punts spatial layout to Tier 4 screenshots. The amendment inverts that framing for the picture-traversal use case but does not replace the dump format.

### The four-layer connection model (relevant constraint)

```
Layer 1: Offline (disk reads, Phase 1 done)
Layer 2: TCP:55557 — existing UnrealMCP plugin (conformance oracle, Phase 2 done)
Layer 3: TCP:55558 — custom UEMCP C++ plugin (Phase 3, not started)
Layer 4: HTTP:30010 — Remote Control API (Phase 4)
```

D23: TCP:55558 will absorb ALL tools post-Phase 3. TCP:55557 is an oracle during Phase 2 and gets deprecated. This means the `dump_graph` command lives on 55558 and is ours to design wire-format and all.

### D33 freshness model (the "cache correctness" primitive)

`assetCache` keys by `.uasset` mtime+size. `shouldRescan()` invalidates when the source moves. A 60s sweep TTL and an `indexDirty` flag govern re-indexing. The amendment asserts sidecars plug into this but doesn't detail the invalidation rules for sidecar-specific states (schema mismatch, editor-open-with-unsaved-changes, sidecar-newer-than-asset). Understanding what D33 actually guarantees vs what the amendment is silently adding on top is part of the research.

### Existing UnrealMCP C++ plugin structure (pattern we can copy or diverge from)

At `ProjectA\Plugins\UnrealMCP\`:
- `MCPServerRunnable` — `FRunnable`-based TCP listener on port 55557
- `UnrealMCPBlueprintCommands.cpp` — BP creation, nodes, variables, compile
- `UnrealMCPEditorCommands.cpp` — Editor operations, asset management
- `UnrealMCPActorCommands.cpp` — Actor spawn, transform, properties
- `UnrealMCPUMGCommands.cpp` — UMG widget creation

The oracle uses `{"type": "<cmd>", "params": {...}}` wire format, no length framing, connect-per-command. Our custom plugin will initially match this and may evolve (length framing, streaming responses) once we control both ends.

### NodeToCode reference (third-party, at `ProjectA\Plugins\NodeToCode-main\`)

Not part of UEMCP but worth inspecting — it extracts BP graphs to a token-efficient JSON format with short IDs, omit-defaults, and separated flows. The parent spec borrows heavily from its approach. For this research, the relevant questions are: how does NodeToCode handle comment boxes and knot nodes? Does it preserve positions? How does it handle the full set of UK2Node subclasses? Its source is the cheapest ground-truth we have on "what does extraction at this fidelity actually look like in code."

---

## Questions to answer

Structure the report with exactly these section headers. Be concrete: cite UE source where possible, name the specific UPROPERTY fields and delegate names, call out the *specific* failure modes.

### Q1: Plugin-side extraction — which of the three paths is actually best, and under what constraints?

The amendment picks Path C (sidecar via Save-hook) as the happy path and Path A (editor-mediated TCP) as the fallback when the sidecar is stale or missing. Evaluate:

- **Path A — editor-mediated TCP only.** `dump_graph` command walks `UEdGraph` live, no sidecar, no Save-hook. Every read waits for an editor round-trip. What's the actual latency per BP (rough order of magnitude)? What happens when the editor isn't running? How does this compare to our current Phase 2 TCP:55557 tool latencies?
- **Path B — offline UProperty parser.** Read `.uasset` directly from disk without the editor. What does the state of the art look like for parsing UE asset binaries in 2026? (UnrealPak, CUE4Parse, any Epic-blessed readers.) What specifically breaks — blueprint-generated-classes, C++ components embedded in BPs, struct versioning? How much code is "just extract node positions" vs "handle every BP variant"? This is the option that if it works buys us true offline introspection; if it doesn't work, we stop considering it forever.
- **Path C — sidecar via Save-hook.** Editor plugin registers on `FCoreUObjectDelegates::OnObjectSaved` (or the more specific `UBlueprint::OnChanged`/`FKismetEditorUtilities::OnBlueprintCompiled` or similar — identify the *correct* delegate for "BP content mutated and persisted"). Serializes via same function as the live TCP command, writes `<bp>.bp.json` next to asset. What are the multi-editor hazards (two people with the BP open, one saves)? What's the delegate firing behavior under Live Coding, under compile-on-save, under the "auto-save" editor preference? What happens if the write fails — does it block the asset save? Does the editor have hooks we're not considering (pre-save, post-compile, asset-registry-tag-updated)?

Deliverable for Q1: a table with rows Path A / Path B / Path C and columns (implementation cost in person-weeks rough, latency, correctness under edge cases, maintenance burden across UE versions, editor-dependency) and a recommendation with *reasoning*. Do not just restate the amendment.

### Q2: Delegate selection and firing semantics

Specifically for Path C (assuming it survives Q1):

- Which Unreal delegate fires *exactly once* per user-meaningful "BP saved and persisted to disk"? List the candidates: `FCoreUObjectDelegates::OnObjectSaved`, `UPackage::PackageSavedEvent`, `UBlueprint::OnChanged()`, `FKismetEditorUtilities::OnBlueprintCompiled`, `FAssetRegistryModule::AssetUpdatedEvent`. For each, document the firing conditions (does it fire for transient saves? for renames? for auto-save? for compile-only-no-save?), the payload, the threading context, and whether it's safe to do ~10ms of file I/O inside the handler.
- Is there a Blueprint-specific delegate that's more appropriate than the generic UObject-level ones? Does UE expose a "BP graph structurally changed" hook distinct from "BP saved"?
- What happens if our handler throws — does the engine swallow it, crash, or re-throw? What's the idiomatic error handling for these delegates?

### Q3: Sidecar correctness under adversarial conditions

Work through each failure mode with a specific before/after state and a proposed rule:

- **Sidecar is older than asset**: obvious — sidecar stale, invalidate. What's the mtime granularity on the platforms we care about (NTFS on Win, and what about WSL or network mounts)? Is mtime enough, or do we need mtime+size (per D33) or a content hash?
- **Sidecar is newer than asset** (e.g., user reverted via P4/Git, asset time went backward): is the sidecar still valid? Argue both sides and pick.
- **Sidecar exists but schema version is majors-behind**: the amendment says "reader rejects and falls back to TCP." What if the editor isn't running? Does the tool fail, or does it try to parse the old schema best-effort? Specify the exact behavior.
- **BP is currently open in editor with unsaved changes**: sidecar on disk reflects pre-edit state. If the tool reads the sidecar, it's wrong. If it round-trips to the editor, we lose the offline advantage. Proposal: TCP command that returns "dirty; editor state at <hash>, on-disk at <hash>" and lets the caller decide. Is that the right shape?
- **Two editor instances have the same BP open** (rare but happens on dual-monitor dev setups): which one's save writes the sidecar? Do we care?
- **Content under P4 lock / read-only**: Save-hook tries to write `.bp.json` next to a read-only `.uasset`. Does the write fail gracefully? Does it try to mark-for-add in P4? (Answer should be: no, never touch source control from the hook — `.bp.json` is .gitignored/.p4ignored, period.)
- **User deletes the sidecar manually**: fall back to TCP when editor running, emit the documented "no_sidecar_and_editor_offline" error when not. Confirm this is right.

Deliverable for Q3: a decision table, rows = failure mode, columns = detected-how, resolution, user-visible behavior.

### Q4: Offline-side tool ergonomics — do the verbs compose the way we think they do?

The amendment's pitch is that Claude uses small verbs instead of loading the whole dump. Validate this by walking three concrete scenarios end-to-end:

1. **"What happens when the player presses the attack button in GA_OSComboAttack?"** — list the exact sequence of verb calls a well-behaved Claude would make, token cost per call (rough), total tokens. Compare to "just dump the whole BP."
2. **"Why is the HitReaction montage not playing?"** — same walkthrough. Does the verb set support this diagnosis flow or does Claude need something we haven't specified?
3. **"Is the 'IsStunned' tag ever removed in this ability?"** — this is a find-then-trace pattern. Does `bp_find_in_graph` + `bp_trace_data` actually do it cleanly, or is there a missing verb?

Deliverable for Q4: three trace transcripts, a verdict on whether the nine verbs are sufficient / excessive / miss something, and a recommendation on which verbs to ship Phase 3 vs defer.

### Q5: Interaction with Track 2a (offline asset-registry parser)

Agent 3 is currently building the hybrid `.uasset` parser for the FAssetRegistryData tag block (Track 2a, D34-ish). That parser is **not** trying to extract graphs — only asset-registry tags. But its existence affects the blueprints-as-picture design in one way: the sidecar reader may want to cross-check sidecar-claimed asset identity against the asset-registry-extracted ground truth (name, class, package). Does that cross-check add value? Does it add coupling we don't want? Short section — three paragraphs max.

### Q6: What changes if we punt the sidecar entirely and go editor-mediated-only for Phase 3?

Steelman the "no sidecar, TCP-only" v1. What's the user experience when the editor isn't running — do we refuse, or do we fail over to a dumber offline mode (maybe just the AssetRegistry-level data from Track 2a + "open the BP to see more")? Is there a phased rollout where v1 is TCP-only, v1.1 adds sidecars? What does that cost us in rework if we pick it?

---

## What NOT to do

- Don't write code. Not even pseudocode beyond the minimum needed to illustrate a design point.
- Don't edit `docs/specs/phase3-plugin-design-inputs.md`. That's a follow-up once the research lands and we decide.
- Don't edit the amendment. If you find the amendment is wrong about something, call it out in your report — I'll revise it.
- Don't block on Agent 3's Track 2a parser. The research into Q1/Q2/Q3/Q4 is independent.
- Don't spec AnimBP / Material graph traversal verbs. The amendment defers those to a later design pass and so do we.
- Don't get into CDO defaults — out of scope, different Phase.
- Don't consult memory for "past project decisions" that aren't already inlined above — this handoff is self-contained by design.

## Termination criteria

You are done when `docs/research/blueprints-as-picture-design-research.md` exists, has sections Q1 through Q6 with the deliverables specified, and you've sent a ≤200 word final report summarizing:
- Your top-line recommendation on the plugin path (A / B / C / hybrid / phased)
- Whether the nine verbs survive Q4 as-is or need changes
- Any finding that you believe invalidates part of the amendment, stated plainly
- Open questions you hit that you couldn't resolve without Noah's input

No tests to run. No commits. No state file to update. This is pure research.
