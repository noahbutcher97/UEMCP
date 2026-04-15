# Handoff: Research Phase 3 plugin architecture and offline consumption design

**From**: Orchestrator (Noah's seat)
**Date opened**: 2026-04-15
**Worker type**: Research (read-only investigation; no code, no commits, no doc edits outside the deliverable)
**Deliverable**: A single markdown report at `docs/research/phase3-design-research.md` answering the questions in §Questions to answer below. Prose and tables only — no implementation, no pseudocode beyond what's needed to illustrate a design point.
**Scope**: All of Phase 3 — buckets 3A (Core Infrastructure), 3B (Actor Commands), 3C (Blueprint Write Commands), 3D (UMG Commands), 3E (Protocol), 3F (Blueprint Introspection / blueprints-as-picture). Also: the offline-side ergonomics of how the MCP server consumes whatever the plugin exposes.
**Out of scope**: Writing code. Modifying `phase3-plugin-design-inputs.md` or any spec. Phase 4 (Remote Control API). Phase 5+ (distribution, per-project tuning). Track 2a's offline asset-registry parser (see §Interaction with Track 2a below — you do NOT block on or redesign it).

**Relationship to prior narrower handoff**: A narrower handoff (`docs/handoffs/research-blueprints-as-picture-plugin-and-offline-design.md`) was dispatched separately and has already produced its deliverable at `docs/research/blueprints-as-picture-design-research.md` (234 lines, sections Q1–Q6 with subsections). **Treat that research as ground truth for bucket 3F** — do NOT redo Q1–Q6 from that doc. Q10 below is rescoped to *integration* questions between 3F findings and the other Phase 3 buckets; read the narrower research first, then answer only the follow-ups in Q10. After the broader research is written, the narrower handoff file can be deleted (its output has been consumed).

---

## Why this handoff exists

We're about to begin Phase 3 — the custom UEMCP C++ editor plugin on TCP:55558 that absorbs all tooling post-D23. The existing artifacts that inform this build are:

1. `docs/specs/phase3-plugin-design-inputs.md` — 11 P0 residue items across buckets 3A-3E, each phrased as "current behavior / required behavior / wire implications / test case / bucket." Good for individual defect-driven requirements. **Not** a coherent architectural design — each item was written in isolation against the conformance-oracle audit.
2. `docs/specs/plugin-design.md` — older architectural sketch. May be partially stale post-D35.
3. `docs/specs/blueprints-as-picture-amendment.md` — just-landed design for the introspection-read layer (bucket 3F), itself an amendment to the older `blueprint-introspection.md`.
4. `docs/specs/conformance-oracle-contracts.md` — 36 command contracts reverse-engineered from the legacy UnrealMCP plugin. Tells us what behaviors we must match-or-beat.

What's missing is the connective tissue: given all of that, *what is the right shape of the Phase 3 plugin*? That's a design question, not a P0-list question, and before we commit 6-10 weeks of C++ we want an independent research pass to surface the choices that aren't obvious, the pitfalls the P0 list doesn't cover, and the places where our current assumptions are load-bearing but undefended.

Research, not design. The output informs design; it is not the design.

---

## Context you need (inlined — do not rely on external memory)

### The four-layer connection model

```
Layer 1: Offline            — disk reads (Source/, Config/, .uproject)       Phase 1 DONE
Layer 2: TCP:55557          — existing UnrealMCP plugin (conformance oracle) Phase 2 DONE
Layer 3: TCP:55558          — custom UEMCP C++ plugin                         Phase 3 THIS
Layer 4: HTTP:30010         — Remote Control API                              Phase 4
```

**D23**: TCP:55558 will absorb ALL tools post-Phase 3. The 55557 oracle gets deprecated. This means **the Phase 3 plugin is the long-lived artifact** — it owns the whole TCP surface, not just the "new" commands. Actor, blueprint-write, and widget commands currently living on 55557 will be reimplemented on 55558. Tool `layer:` values in `tools.yaml` are transitional.

### D33 freshness model

`assetCache` keys by `.uasset` mtime+size. `shouldRescan()` invalidates when source moves. 60s sweep TTL. `indexDirty` flag governs re-indexing. Relevant wherever plugin output is consumed offline with a cache in front of it.

### The legacy plugin structure (what we're replacing)

At `ProjectA\Plugins\UnrealMCP\`:
- `MCPServerRunnable` — `FRunnable`-based TCP listener on port 55557
- `UnrealMCPBlueprintCommands.cpp` — BP creation, nodes, variables, compile
- `UnrealMCPEditorCommands.cpp` — Editor operations, asset management
- `UnrealMCPActorCommands.cpp` — Actor spawn, transform, properties
- `UnrealMCPUMGCommands.cpp` — UMG widget creation

Wire format: `{"type": "<cmd>", "params": {...}}`, no length framing, connect-per-command, three different error-response shapes mixed across files.

Known weaknesses from the audit at `docs/audits/unrealmcp-comprehensive-audit-2026-04-12.md`:
- Three different error envelopes (Bridge / CommonUtils / UMG ad-hoc)
- `GetAllActorsOfClass(GWorld,...)` misses sublevels and WP-streamed levels
- FName-only lookup, no Outliner-label support
- `SetObjectProperty` handles only primitives — no FVector / FRotator / FColor / FObject / FArray
- `compile_blueprint` returns `{compiled:true}` always, discards `FCompilerResultsLog`
- No `FScopedTransaction` wrapping — Ctrl+Z broken, partial mutations leak
- Widget path doubling (`Name.Name`) inconsistent across 6 UMG handlers
- `Request->GetObjectField("params")` crashes editor on missing field (no null check)
- Transform parsers silently zero on bad input, no bool return
- `MakeLinkTo` without pin schema check — creates nonsense connections

The Phase 3 plugin must fix all of that while adding new capability (3F introspection, better protocol).

### Existing P0 items (summarized from design-inputs doc)

| P0 | Fixes | Bucket |
|----|----|----|
| P0-1 | Error envelope unification | 3A |
| P0-2 | Level-traversing actor lookup (INF-1) | 3A+3B |
| P0-3 | FName-or-label resolution (D29) | 3A+3B |
| P0-4 | Property-type handler registry (INF-6) | 3A+3B+3C |
| P0-5 | Compile error reporting | 3C |
| P0-6 | FScopedTransaction wrapping | 3C+3B+3D |
| P0-7 | Widget path standardization | 3D |
| P0-8 | Valid binding-graph construction | 3D (depends on P0-11) |
| P0-9 | Malformed-request null check | 3E |
| P0-10 | Transform parser bool return (INF-2) | 3A |
| P0-11 | Pin-type compatibility via schema | 3C |

**Infrastructure cluster (3A)** — P0-1 envelope + INF-1 actor lookup + INF-2 transform parser + INF-6 property registry — must land first. That sequencing is uncontroversial. What's *not* settled is: what else lives in 3A that the P0 list didn't catch?

### The blueprints-as-picture amendment (bucket 3F) — now with research answers

`docs/specs/blueprints-as-picture-amendment.md` defines the introspection-read spec (spatial fields on nodes, `comments[]` with pre-computed `contains[]`, nine read-only traversal verbs).

**The narrower research (`docs/research/blueprints-as-picture-design-research.md`) has already settled** most of the 3F design space. Key verdicts to treat as ground truth:

- **Extraction path**: Path C (sidecar via Save-hook) is the recommendation, with Path A (editor-mediated TCP) as live-extraction fallback for the dirty-editor case. Path B (offline UProperty parser) is permanently ruled out.
- **Sidecar location**: `Saved/UEMCP/BPCache/` mirror tree — NOT next-to-asset. Three reasons: UE `Saved/` convention, P4 safety (categorical — `Saved/` is never checked in), per-developer cache correctness.
- **Save-hook delegate**: `UPackage::PackageSavedEvent` / `OnPackageSavedWithContext`. Filter for BP packages; game thread; hard-cap handler execution time. Table rules out `OnObjectSaved`, `UBlueprint::OnChanged()`, `OnBlueprintCompiled`, `AssetUpdatedEvent`.
- **Prime-on-empty**: `prime_bp_cache` auto-runs on first editor load when cache is empty (`bAutoPrimeBlueprintCache` default-on setting).
- **Dirty-editor handling**: explicit `bp_is_dirty` TCP probe command — not a best-effort heuristic.
- **Freshness key**: mtime + size + schema_version. Atomic rename writes (`.bp.json.tmp` → move).
- **Verb shipping**: 8 of 9 verbs ship in v1; `bp_paths_between` deferred to v1.1 (most expensive, least-used per scenario walks). Scenario 3 (tag lifecycle) surfaces a cross-BP reasoning gap documented as a caveat, not a new verb.

Remaining open (not in narrower research): knot-collapse semantics, AnimBP state machine traversal, Material graph traversal, CDO defaults — all explicitly deferred by the amendment and by this handoff.

### NodeToCode reference

Third-party plugin at `ProjectA\Plugins\NodeToCode-main\`. Not part of UEMCP. Extracts BP graphs to token-efficient JSON (short IDs, omit-defaults, separated flows). Read its source for ground-truth on what graph extraction at this fidelity looks like.

### Sibling MCP servers (convention reference)

`jira-bridge`, `perforce-bridge`, `miro-bridge` at `~/.claude/mcp-servers/*/server.mjs` — single file, Node ES modules, stdio, per-project prefixes (`jira-projecta` vs `jira-projectb`). The UEMCP *server* follows this pattern. The plugin is a different beast (C++ UE module) — no sibling precedent.

---

## Questions to answer

Structure the report with these exact top-level section headers. Each section should have a decision or a "design space" verdict — not just a description. Be concrete: cite UE sources (classes, delegates, macros) where they matter.

### Q1: Plugin module architecture

How should the UEMCP editor plugin be organized as a UE module?

- **Single module vs split modules.** Runtime/Editor split? Do we need a UEMCPCore runtime module + UEMCPEditor editor-only module, or can everything live in one editor-only module given the plugin is editor-tool territory? What does `.Build.cs` look like?
- **Subsystem type.** `UEditorSubsystem` for lifecycle? `FRunnable` for TCP listener? `UGameInstanceSubsystem` for nothing because we're not in PIE? Spell out the subsystems, what owns the TCP socket, what owns the dispatch registry, what owns long-lived caches.
- **Module dependencies.** Minimum set of `PublicDependencyModuleNames` / `PrivateDependencyModuleNames`. Call out anything editor-only (UnrealEd, Kismet, BlueprintGraph, EditorSubsystem, KismetCompiler, UMGEditor, Sockets, Networking, Json, JsonUtilities).
- **Hot-reload / Live-Coding behavior.** What breaks when a dev Ctrl+Alt+F11's? TCP listener — does it re-bind, leak the port, or survive? Command registry — does it re-register or duplicate? If any of these are broken, what's the mitigation (explicit shutdown in `ShutdownModule`, reinit on first request, etc.)?

Deliverable: a module-layout sketch, dependency list, and a short rationale for each structural choice.

### Q2: Command dispatch and registration

The legacy plugin has 36+ command handlers in four .cpp files, each checking `type` string against hardcoded if/else. What's the right shape for ours, given we'll have 60-120 commands on 55558?

- **Registry pattern.** Macro-registered? Auto-registered via UCLASS reflection? Plain `TMap<FName, FCommandHandler>` populated in `StartupModule`? Each has tradeoffs on discoverability, test-surface, and addition cost.
- **Handler signature.** `TSharedPtr<FJsonObject>` in, `TSharedPtr<FJsonObject>` out, synchronous? Async via TFuture for long-running commands (compile, prime_bp_cache)? If async, how does the TCP listener serialize responses back to the right client?
- **Request ID and response envelope.** Every request carries `request_id`. Every response echoes it. What's the shape — top-level or inside `result`? Does an async handler need to reserve a pending-response slot on the socket?
- **Per-command registration metadata.** Should handlers self-declare their schema (for a `list_commands` introspection command), or is that server-side `tools.yaml` only? Consider: if the plugin publishes schemas, the server-side YAML becomes derived data.

Deliverable: a dispatch-flow diagram (text is fine), a proposed handler signature, a verdict on sync-vs-async split.

### Q3: Error envelope, error codes, and structured logging

The audit nailed the three observed error formats. Solve them for good.

- **Canonical response shape.** Propose the single envelope. Should `status` be `"success"|"error"` or something richer (e.g., `"warnings"`)? How does `code` namespace — `INF.INVALID_TRANSFORM`, `BP.INCOMPATIBLE_PINS`, `UMG.BINDING_TYPE_MISMATCH`? What goes in `details` vs top-level?
- **Error code taxonomy.** The P0 list mentions `AMBIGUOUS_LABEL`, `MALFORMED_REQUEST`, `INVALID_TRANSFORM`, `INCOMPATIBLE_PINS`. What's the full set across all buckets? Group them and give a registration rule ("each new error code requires a test-case line in the spec").
- **Logging discipline.** How should the plugin log? `UE_LOG(LogUEMCP, ...)` with what categories? Should every request/response round-trip leave a structured log line (req_id, type, duration, status)? Is there a logging-subsystem thing UE already provides we should lean on?
- **Crash containment.** C++ in the editor process — one bad handler taking down the editor is unacceptable. `try`/`catch` in the dispatch loop? `FPlatformMisc::SetCrashHandlingType`? `AssertionMacros.h`? Research what UE idiomatically does for editor-tool code that must not crash the host.

Deliverable: envelope spec, error-code namespace plan, logging convention, crash-containment rule.

### Q4: Transaction and undo model across command types

P0-6 says "one MCP command = one undo step" via `FScopedTransaction`. That's correct for blueprint-write and UMG-structural. Extend it properly:

- Actor-spawn / actor-delete — are they transactable? What's the `FScopedTransaction` pattern for an `AActor*` lifecycle?
- Actor property set via INF-6 handler — does each handler open its own transaction, or does the dispatcher wrap the whole request? Nested transactions?
- Blueprint compile — should auto-compile after a mutation be inside the same transaction as the mutation, or a separate step the caller can opt out of?
- Introspection reads (3F) — no transaction needed, obviously. But `prime_bp_cache` iterates and touches many BPs — does it need a single batch transaction, per-BP, or none?
- What about commands that have no UE-side side effect but write to disk (sidecar writer)? Those can't participate in Undo. Document this as an explicit non-guarantee.

Deliverable: a matrix of (command category × transactable? × nesting rules).

### Q5: Property-type handler registry (INF-6 deep design)

P0-4 calls for a registry with a `REGISTER_PROPERTY_HANDLER` macro. Think through it:

- What's the interface? Given a `FProperty*` + JSON value + target UObject, set the value and return a resolved-value echo. What's the error path?
- Built-in handlers needed on day 1: FBool, FInt, FFloat, FStr, FByte, FEnum, FVector, FRotator, FColor, FLinearColor, FTransform, FText, FName, FObject (asset path), FClass, FArray-of-primitive, FMap-of-primitive, FSet-of-primitive. What about FStruct-with-arbitrary-USTRUCT? Do we recurse, or fail with `UNSUPPORTED_STRUCT` and require an explicit handler?
- Registration ordering — StaticStruct lookups at module startup vs lazy on first use?
- Extensibility story — can a downstream project (e.g., ProjectA) register a game-specific struct handler without forking UEMCP? If so, what does that API look like?

Deliverable: interface sketch, day-1 handler list, extensibility verdict.

### Q6: Protocol evolution on TCP:55558

The legacy protocol (no length framing, JSON-parse-until-valid, connect-per-command) works but has failure modes (large responses, streaming outputs, connection churn). Decide what to change:

- **Length framing**: 4-byte BE length prefix on requests and responses? Or stay with parse-until-valid for backward-familiarity? If we add framing, the server-side `connection-manager.mjs` grows a framing layer on the 55558 code path — is that worth it?
- **Connection model**: keep connect-per-command, or move to persistent connections with request-response multiplexing? Persistent helps latency (no TCP handshake per read) but complicates command serialization (the `CommandQueue` in ConnectionManager already serializes per-layer; persistent might enable parallel in-flight).
- **Streaming responses**: `prime_bp_cache` over 200 BPs naturally wants progress updates. Is that a streaming response (multiple JSON messages for one request)? A polling pattern (command returns a job_id, separate command polls)? A callback URL (server exposes an HTTP receiver)?
- **Timeouts**: current server-side is per-command with fallback default. Plugin-side — should handlers self-declare their expected max runtime so the server can match? Does the protocol carry a timeout hint?
- **Backward-compat bridge**: during the 55557→55558 migration, both are live. Is there a migration-facilitator — e.g., 55558 accepts 55557-format requests and transparently upgrades them — or do we hard-cut?

Deliverable: a verdict on each of the five sub-questions with reasoning, and a migration plan for 55557→55558.

### Q7: Bucket 3B — Actor commands architecture

Beyond the P0 items (level traversal, label resolution):

- **Actor-targeting parameter shape.** Current P0-2 / P0-3 propose `name` + optional `label` + optional `level_name`. Is there a unified `actor_ref: {name?, label?, level_name?, fname?}` object that every handler consumes via one helper? What's the helper's ambiguity-resolution rule?
- **Batch commands**: spawn-many, transform-many. Do we need them Phase 3, or do we ship one-at-a-time and add batch later? What's the cost of retrofitting batch later — wire-protocol breaking, or additive?
- **Blueprint actor vs native actor**: spawning a BP-derived actor class goes through `StaticLoadObject` — the path differs. Does the spawn command handle this transparently, or does it have BP-aware spawn + native-aware spawn as separate verbs?
- **Actor component commands**: add/remove/set-property on components of an actor. How do they scope? By component FName, component class, or both? Component hierarchies (parented scene components) — flat list or tree in responses?

Deliverable: a commands-and-params inventory for 3B with open questions flagged.

### Q8: Bucket 3C — Blueprint write command architecture

Beyond the P0 items (compile results, transactions, pin validation):

- **Graph-mutation grammar**: the legacy plugin has add_node, connect_nodes, etc. Is there a richer grammar worth investing in (e.g., `apply_patch` that takes a JSON diff against the dump format)? Pro: Claude composes one patch; Con: engine does diff-and-apply work we'd otherwise not need.
- **Variable / function / event creation**: currently separate commands. Should they unify under a `declare_member` primitive? What about `delete_member` — does it safely handle all references?
- **Event bindings (BP) and delegate bindings**: what does the create/modify/delete surface look like? The legacy plugin punts on most of this.
- **Compile autopilot**: after every mutation, compile? Only on explicit command? Batched? Consider cost — a 20-node construction followed by 20 auto-compiles is pathological.
- **Asset lifecycle**: create_blueprint, duplicate_blueprint, rename_blueprint, delete_blueprint — transaction behavior? P4/Git integration (should we offer a `mark_for_add` hint, or stay strictly out of source control)?

Deliverable: a 3C commands-and-params inventory + stance on graph-mutation grammar.

### Q9: Bucket 3D — UMG command architecture

Beyond the P0 items (widget paths, binding graphs):

- **Widget hierarchy commands**: add/remove/reparent widgets inside a UMG tree. Existing legacy limited to specific widget classes (TextBlock, Button). Phase 3 — generic add-any-widget-class with a `widget_class: string` parameter?
- **Binding model**: legacy plugin constructs function-bound bindings. Is property-bound (direct UPROPERTY binding) also in scope? What does the response envelope look like for each?
- **Named-slot / overridden-slot handling**: do commands need to understand slots? Slot properties (size, alignment, padding) as structured params?
- **Widget animation (UMG animations, track manipulation)**: in scope Phase 3 or deferred?

Deliverable: a 3D commands-and-params inventory with scope verdict on animation and slots.

### Q10: Bucket 3F — Blueprint introspection (blueprints-as-picture) design research

This is the section the original narrower handoff covered. Subdivide:

#### Q10.1 — Plugin-side extraction path (A vs B vs C)

- **Path A, editor-mediated TCP only.** `dump_graph` walks `UEdGraph` live on each request. Latency per BP order of magnitude? What happens when editor isn't running?
- **Path B, offline UProperty parser.** Read `.uasset` directly. What's state of the art in 2026 (CUE4Parse, UnrealPak, Epic-blessed readers)? What specifically breaks (BP-generated classes, struct versioning, C++ components embedded in BPs)? Is "just positions and flows" a smaller parser than "everything"?
- **Path C, sidecar via Save-hook.** Plugin registers on a `UBlueprint`-save delegate, writes `<bp>.bp.json`. Multi-editor hazards? Auto-save / compile-on-save firing behavior? Write-failure isolation (must not block asset save)?

Deliverable: a table rows A/B/C, columns (impl cost person-weeks, latency, edge-case correctness, maintenance across UE versions, editor dependency, recommendation with reasoning).

#### Q10.2 — Save-hook delegate selection

Which delegate fires exactly once per user-meaningful "BP saved and persisted"? Candidates: `FCoreUObjectDelegates::OnObjectSaved`, `UPackage::PackageSavedEvent`, `UBlueprint::OnChanged()`, `FKismetEditorUtilities::OnBlueprintCompiled`, `FAssetRegistryModule::AssetUpdatedEvent`. For each — firing conditions (transient? rename? auto-save? compile-only?), payload, thread context, safe for ~10ms I/O in handler?

Deliverable: a comparison table and a recommendation.

#### Q10.3 — Sidecar correctness under adversarial conditions

Decision table: rows = failure mode, columns = detected-how / resolution / user-visible behavior. Modes: sidecar older than asset, sidecar newer (P4/Git revert), schema-majors-mismatch, BP open with unsaved changes, two editor instances, read-only asset (P4 locked), user-deleted sidecar, mtime granularity on network/WSL mounts.

#### Q10.4 — Verb composition dry-runs

Walk three real scenarios end-to-end, listing exact verb calls and approximate token costs:
1. "What happens when the player presses attack in GA_OSComboAttack?"
2. "Why is the HitReaction montage not playing?"
3. "Is the 'IsStunned' tag ever removed in this ability?"

Verdict: are the nine amendment verbs sufficient / excessive / missing something? Which verbs ship Phase 3 vs defer?

#### Q10.5 — No-sidecar steelman

Argue "TCP-only v1, sidecars v1.1." What's the UX when editor isn't running in v1? Phased rollout cost? What rework does v1.1 incur if we pick this?

### Q11: Offline-side consumption — where the server and plugin meet

The MCP server consumes the plugin. Research the boundary:

- **Cache architecture server-side.** Where do sidecars get parsed and held? Memory-resident with D33 invalidation, or parse-per-request? How does this interact with the `ResultCache` already in `connection-manager.mjs`?
- **Graceful degradation.** When the plugin is unreachable, what can the server still do? Current Phase 1 tools (offline file reads, config drill) work. Post-Phase 3, how much of the previously TCP-only surface can fall back to offline sidecars + disk reads?
- **Tool visibility.** Should `tools.yaml` layer assignments flip based on plugin availability (health check result)? Or should every tool stay visible and fail at call time with a clear error?
- **Write-op deduplication (L3 deferred)**: now that we control the plugin, can we implement request_id based dedup on the plugin side as well? Does it belong server-side, plugin-side, or both?
- **Conformance oracle retirement.** Per D23, 55557 oracle gets deprecated post-Phase 3. What's the test strategy for validating 55558 matches oracle behavior before the cutover? Run both in parallel and diff responses? Capture-and-replay?

Deliverable: a server↔plugin boundary diagram (text form), caching architecture, fallback matrix, oracle retirement plan.

### Q12: Interaction with Track 2a (offline asset-registry parser)

Agent 3 is currently building a hybrid `.uasset` parser for the FAssetRegistryData tag block (Track 2a). That parser does NOT extract graphs — only asset-registry-level tags. Research questions:

- **Cross-check value.** The sidecar reader (3F consumer) could cross-check sidecar-claimed asset identity (name, class, package) against AssetRegistry ground truth from Track 2a. Does this add value worth the coupling?
- **Offline-tool composability.** If the server has both (a) AssetRegistry tags via Track 2a and (b) BP graph dumps via 3F sidecars, does a new class of offline queries open up? Examples of queries that need both?
- **Shared parse infrastructure.** Track 2a's .uasset parser may have primitives (magic-number check, header-version parse) that a hypothetical offline BP parser (Path B in Q10.1) could reuse. Even if we don't pick Path B, flag the reuse opportunity.

Deliverable: 3-paragraph section. Do not block on Agent 3's final report — write provisionally based on Track 2a scope as described above.

### Q13: Cross-cutting — testability, distribution, risk

- **C++ test infrastructure.** UE's automation testing framework — do we use it? Gauntlet? Pure unit tests with no UE dependency? The legacy plugin has no tests. What does a testable command handler look like (e.g., does it take an interface for UEdGraph access so we can mock)?
- **Distribution.** Plugin source vs binary `.uplugin`? P4 for ProjectA, Git for UEMCP — how does the plugin reach ProjectA? Does ProjectB get the plugin too (they're on UE 5.7, we're on 5.6 for ProjectA — version skew)?
- **Risk register additions.** Based on the research, what new risks should go in `docs/tracking/risks-and-decisions.md`? Phrase each as "R-N: <risk>, impact, mitigation."

---

## What NOT to do

- Don't write code. Not even pseudocode beyond the minimum needed to illustrate a design point.
- Don't edit `docs/specs/phase3-plugin-design-inputs.md`, the blueprints-as-picture amendment, or any existing spec. Findings that invalidate existing specs go in your report with a clear flag.
- Don't block on Agent 3's Track 2a. Q12 is provisional. If Agent 3's report lands before you finish, great — incorporate. If not, ship without it.
- Don't design AnimBP or Material graph traversal (deferred per amendment).
- Don't get into CDO defaults (Phase 4 territory).
- Don't design the distribution mechanism beyond flagging the skew risk in Q13 — that's Phase 5.
- Don't consult memory for "past decisions" that aren't inlined above — this handoff is self-contained by design. If you need something, ask Noah.

## Termination criteria

You are done when:
1. `docs/handoffs/research-blueprints-as-picture-plugin-and-offline-design.md` is deleted (superseded).
2. `docs/research/phase3-design-research.md` exists with sections Q1 through Q13 populated with the deliverables specified.
3. You've sent a ≤400 word final report summarizing:
   - Your top-line recommendation on plugin module structure (Q1) and dispatch pattern (Q2)
   - Your verdict on the A/B/C extraction path decision (Q10.1)
   - Whether the nine amendment verbs survive Q10.4 as-is or need changes
   - The 3-5 findings you consider highest-leverage for Noah's design-decision calendar
   - Open questions you hit that you couldn't resolve without Noah's input

No tests to run. No commits. No state file to update. No memory writes. This is pure research.
