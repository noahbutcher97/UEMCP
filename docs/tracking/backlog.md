# UEMCP Backlog

> Tracks future-consideration items that aren't currently dispatched as handoffs and aren't load-bearing enough to live in the D-log. Distinct from `risks-and-decisions.md` (which logs decisions) and from `docs/handoffs/` (active dispatches). Without this file, these items would exist only in orchestrator conversation context and evaporate between sessions.
>
> **Maintenance rule**: when an item here gets dispatched as a handoff or folded into a committed plan, **remove it from this file** — it migrates to a real artifact. This file only holds *currently-not-dispatched* items.

---

## Enhancements

New capability proposals not yet scoped. Each has a workflow trigger that would justify prioritization.

### EN-1 — `query_asset_registry.size_field` filter (`min_size_bytes` / `max_size_bytes`)
- **Source**: Agent Workflow Catalog Q4; Noah accepted as "worth queuing" (2026-04-16)
- **Scope**: one yaml param addition; parser already tracks `sizeBytes` — no parser work
- **Enables**: "which ProjectA assets > 5 MB?", "audit size-optimization candidates"
- **Cost**: ~15-min enhancement worker
- **Trigger**: next enhancement round, fold into M0 yaml grooming, or bundle with whatever post-scope-refresh worker next touches `offline-tools.mjs`

### EN-3 — Agent-infra parity audit workflow
- **Source**: Workflow Catalog §7a amendment (2026-04-16), Noah Q3 — surfaced as a missed workflow category
- **Scope**: tool(s) comparing CLAUDE.md / plugin config / tool coverage / toolset setup between ProjectA and ProjectB, reporting drift
- **NOT game-content diff** — about agent-infrastructure symmetry
- **Cost**: open-ended; design work needed before scoping
- **Trigger**: agent-config drift between the two projects starts causing workflow confusion, OR ProjectB matures enough that parity auditing becomes routine

### EN-4 — Math/comparison K2Node graduations for S-A skeletal
- **Source**: Agent 11.5 Q-2, D48 — explicitly deferred
- **Candidates**: `UK2Node_PromotableOperator`, `UK2Node_CommutativeAssociativeBinaryOperator`, `UK2Node_EnumEquality`, `UK2Node_Select`, `UK2Node_MultiGate`
- **Scope**: extend `find_blueprint_nodes` skeletal set from 13 to ~18 node classes
- **Cost**: per-node UPROPERTY extraction pattern similar to existing skeletal 13
- **Trigger (D48-defined)**: workflow demand for math-operator introspection in BPs


### EN-6 — `find_blueprint_nodes_bulk` results[] sort by `match_count` descending
- **Source**: EN-2 manual testing 2026-04-20 §6 observation (results commit `7758c85`)
- **Current behavior**: `results[]` sorted by path alphabetically. For "which BPs call X most" top-N workflows, callers sort client-side.
- **Scope**: ~1 line change in `offline-tools.mjs` bulk handler — sort `results.sort((a,b) => b.match_count - a.match_count)` before applying pagination
- **Cost**: ~5-10 min enhancement worker; bundle with any future `offline-tools.mjs` pass
- **Trigger**: next enhancement round, or fold into M-cmd/M-alt worker if they touch bulk tool

### EN-5 — Reflection-based lint: yaml params ↔ handler param reads
- **Source**: Audit A (post-Agent-10.5 codebase health) §3 insight 2026-04-19
- **Scope**: automated lint that, for each offline tool's handler case in `executeOfflineTool`, verifies every `params.<X>` read has a matching declaration in the tool's yaml `params:` block. Generalizes D44's structural invariant from a one-time-refactor into a maintained guarantee. Would have caught F-2 + F-3 (Pre-Phase-3 Fixes Worker items) automatically.
- **Implementation sketch**: parse `offline-tools.mjs` via a lightweight JS AST walk; per switch-case, grep for `params.X` accesses; cross-reference against the tool's yaml entry. Lint fails if any read is undeclared. Run as part of test rotation.
- **Cost**: 1-2 agent sessions. Most of the cost is AST walking + handling edge cases (destructuring, alias chains).
- **Trigger**: after the next time a yaml↔handler param drift is caught by manual testing or audit. If F-2/F-3 class issues recur, promote.

---

## Fixture planting

Test-coverage gaps requiring artificial fixtures in ProjectA/ProjectB.

### FX-1 — TMap BP CDO micro-fixture
- **Source**: Agent 10.5 manual tester Item #1 (2026-04-16)
- **Gap**: no ProjectA BP CDO holds a `TMap<K,V>`; manual §2.1/§2.3 had to skip live-fixture testing. Synthetic unit tests cover both paths.
- **Disposition**: optional; small maintenance burden for marginal value
- **Trigger**: ProjectB naturally introduces TMap usage, OR TMap-parse regression surfaces that synthetic tests missed

---

## Deferred research triggers

Research questions explicitly deferred with named reopening conditions. Watch-for items.

### DR-1 — Tier S-B pin tracing offline parser
- **Source**: Agent 11.5 + D48 (original FOLD-INTO-3F verdict) → D55 (updated to PURSUE-AFTER-SIDECAR)
- **Cost**: ~6-9 agent sessions at honest estimate (supersedes Agent 11.5's 8-13; collapsed per D55 FA-1 analysis of 19-type restriction, but with irreducible fixed-cost floors — base pin-block RE + LinkedTo + version-skew buffer)
- **Status**: scheduled as **optional M6** in Phase 3 dispatch sequencing; commissioned only if D52 near-parity goal is under-served by sidecar alone OR agent-automation workflows surface pin-trace pressure
- **Oracle dependency**: sidecar's known-correct `LinkedTo` JSON becomes S-B's validation oracle — commission AFTER M2 ships for ground-truth signal
- **Reopening (per D52)**: workflow pressure accumulates OR 3F sidecar slips (weakened from D48's AND requirement)
- **State**: not in current dispatch window; M6 stays optional unless signal emerges

### DR-2 — L3A full-fidelity UEdGraph byte parsing
- **Source**: Agent 11, D45 — permanently EDITOR-ONLY
- **State**: locked by D45; 3F sidecar is the canonical offline-read path
- **Reopening**: architectural shift — CUE4Parse ports K2Node readers, OR UE editor-side serialization stabilizes enough to reverse-engineer at reasonable cost
- **State today**: no action expected

---

## Currently-known-issues not in this file

These items ARE dispatched (handoffs exist) so they're NOT tracked here. Per the maintenance rule above, completed handoffs are removed once they ship — this section only lists in-flight or actively-pending dispatches.

In-flight as of 2026-04-22 (Wave 2 + Path C unblock):

- **M-new S-B-base** — handoff `docs/handoffs/m-new-s-b-base-parser.md` (commit `708e405`). Session 1 CP1+CP2 shipped (`cdf951b`+`e35f431`); baseline 914→966. **Paused pending Oracle-A-v2** per D67 — Path A (re-save) empirically failed; UE regenerates pin IDs load-session-ephemerally for K2Node_EditablePinBase subclasses + K2Node_PromotableOperator. Scope: `server/*`.
- **Oracle-A-v2 pin-name amendment** — handoff `docs/handoffs/oracle-a-v2-pin-names.md`. 30-60 min micro-worker. Plugin-side `EdgeOnlyBPSerializer.cpp` amendment ADDS `name` field alongside `pin_id` (not replacing); schema version bumps v1→v2; all 6 fixtures regenerated. Unblocks S-B-base differential harness to do **hybrid ID+name matching** per D68: primary pass by pin_id (~96.5%), fallback pass by (node_guid, name) for unmatched (~3.5% K2Node_EditablePinBase case). Zero file-level collision with S-B-base (plugin/ vs server/*).

**Pre-drafted, NOT yet dispatched**:
- **Verb-surface** — handoff skeleton at `docs/handoffs/m-new-verb-surface.md` (commit `697b331`). Has `[LATE-BINDING]` markers to be filled from S-B-base's final report. Dispatches sequentially after S-B-base lands.
- **M-enhance** — full handoff at `docs/handoffs/m-enhance-hybrid-transport.md` (commit `d315f4b`). HYBRID transport scope per D66 (RC HTTP + plugin TCP split rule). 3-5 sessions, 6 prescriptive checkpoints. Phase 4 absorbed into this worker (8 rc_* primitives ship inside). Content-wise independent of S-B-base; dispatches sequentially after S-B-base due to `server/*` file-collision only. Test baseline reference is [LATE-BINDING from S-B-base final report].

Recently shipped (most recent first):

- **FA-ε M-enhance transport research** (commit `56ff6f6`, 2026-04-21) — 404-line decision document at `docs/research/fa-epsilon-tcp-vs-rc-2026-04-21.md`. Verdict: HYBRID (RC HTTP for flat reflection + metadata allowlist subset; TCP for compile diagnostics / UEdGraph walks / compiled-state / editor-static). **Phase 4 as a scheduled milestone absorbed into M-enhance**; D23 Layer 4 semantic allocation persists. Aggregate Phase 3 delta: −2 to −4 sessions. Full context in D66.
- **UEMCPModule log-demotion** (commit `60bb94a`, 2026-04-21) — D61 follow-on closed. Warning → Log demote at `UEMCPModule.cpp` StartupModule. Clean rebuild via D61 nuke recipe (12.19s, 16 actions); DLL mtime post source mtime confirmed no UBT cache staleness; D57 gate re-run [PASS]. Baseline unchanged. D65 for full report.
- **sync-plugin.bat** (commit `117b7d9`, 2026-04-21) — D61 follow-on closed. 0.59s wall-clock smoke test against ProjectA; byte-identical sync; Binaries/Intermediate preserved. Three CMD-parser gotchas patched during implementation (same class as setup-uemcp.bat debug arc; documented in D64). Future plugin workers use `sync-plugin.bat "<uproject>" -y`. D64 for full report.
- **EN-8 + EN-9 bundle** (commit `1bc3e8b`, 2026-04-21) — workflow gaps from M-spatial manual testing closed. `bp_list_graphs` emits `comment_ids: []` per-graph row; all 5 M-spatial verbs return FA-β `{available: false, reason: "asset_not_found"}` on ENOENT. `withAssetExistenceCheck` helper exported for Verb-surface reuse. **Test baseline 899 → 914** (+15 assertions including full-contract helper coverage). Comment class-name confirmed as `EdGraphNode_Comment` (no U prefix — UE strips at serialization). D63 for full report.
- **M-new Oracle-A** (commits `b8e64a5` + `b1fb2e7`, 2026-04-21) — 6-BP fixture corpus seeded (BP_OSPlayerR 204/596 edges densest; TestCharacter 11/24 smallest; BP_OSPlayerR_Child triple for inheritance). 280 LOC commandlet + serializer; 20.66s clean build; 9s cold BP_OSPlayerR invocation; D57 gate regression-tested PASS. **Critical API correction captured in D62**: `UEdGraphPin::LinkedTo` is `TArray<UEdGraphPin*>` runtime / `TArray<FEdGraphPinReference>` bytes — propagated to S-B-base handoff.
- **M1 3A TCP scaffolding** (commits `2b86369` / `8030930` / `be282c0` / `510c5bb` / `d7a2192` / `1d3f6cf`) — plugin/UEMCP/ scaffold with D57 commandlet gate + 6 P0 helpers (P0-1/2/3/4/9/10) + MCPServerRunnable on TCP:55558 + MCPCommandRegistry + ping handler + 8 automation tests + server-side integration test. Unblocks M-new Oracle-A. Response envelope is single-shape `{status, result}` / `{status, error, code}` — deliberate P0-1 break from UnrealMCP (55557)'s two-format legacy. **Pending user verification**: plugin visibility in ProjectA (mklink /D or AdditionalPluginDirectories), UBT compile, commandlet-gate log line. Test baseline unchanged at 899.
- **M-spatial manual testing** (commit `8ad69bd`) — 18/18 PASS through live MCP wire. FA-β manifest + FA-δ plugin-absent first-class both held. Exact numeric match with unit tests (10 graphs, 53→7 events, 11 contained nodes, 17 entry points, 1424×544 rect) → second independent verification of D50 tagged-fallback UPROPERTY coverage. Workflow gap surfaced: comment-ids not enumerable → EN-8 queued.
- **M-spatial** (commits `08be682` / `4105fa0` / `4938248`) — 5 BP traversal verbs + FA-β/FA-δ test invariants. Zero parser code needed — D50 tagged-fallback already decoded every required UPROPERTY (verified empirically on BP_OSPlayerR). Test baseline 825 → 899 (+74). Notable finding: `EnabledState` absent on nearly all fixture nodes because UE omits class-default values; spatial extraction treats missing positions as 0.

Queued for dispatch per D58 re-sequenced plan (`docs/research/phase3-resequence-mcp-first-2026-04-20.md` §Q5):

**Wave 1** — SHIPPED in full per D59 + D61 + D62. Oracle-A fixtures form the differential-test contract for S-B-base.
- ~~M1 scaffolding~~ — SHIPPED (plugin-compile + D57 gate verified end-to-end per D61, commit `a5b8917`)
- ~~M-spatial + wire validation~~ — SHIPPED
- ~~M-new Oracle-A~~ — SHIPPED (D62, commits `b8e64a5` + `b1fb2e7`). 6-BP fixture corpus at `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/`.

**Wave 2 — S-B core** (post-Oracle-A):

- **M-new S-B-base** (4-6 sessions) — reverse-engineer `UEdGraphNode::Serialize()` pin-block trailer + `FEdGraphPin` LinkedTo walker. Uses Oracle-A output for differential validation. Critical-path for D52 edge-topology offline near-parity.
- **M-new S-B-overrides** (1.5-2 sessions, parallelizes with Verb-surface) — CallFunction backcompat + Switch-variant pin-regeneration + UE 5.6↔5.7 delta buffer.
- **M-new Verb-surface** (1-1.5 sessions) — 5 S-B-dependent verbs (`bp_trace_exec`, `bp_trace_data`, `bp_neighbors` edge mode, `bp_show_node` pin completion, `bp_list_entry_points` precision) in `offline-tools.mjs` + yaml entries + tests.

**Wave 3 — enhancement + writes** (post-M1 + post-M-new):

- **M-enhance** (3-5 sessions) — HYBRID transport per D66/FA-ε verdict: RC HTTP (30010) for flat UPROPERTY/UFUNCTION reads + metadata allowlist subset; TCP (55558) for compile diagnostics / UEdGraph walks / compiled-state / editor-static. Includes narrow sidecar (plugin-only fields), save-hook, 3F-4 production commandlet, editor-menu prime. **Absorbs what was Phase 4** (RC HTTP client infrastructure folds into M-enhance). Parallelizes with M3/M4/M5. Dispatches after S-B-base completes (server/* file-collision constraint; content-wise independent of S-B-base).
- **M3** — oracle retirement (6-10 sessions, 3 sub-workers) — rebuilds 32 transitional tools on 55558 with P0-1 through P0-11 upgrades; absorbs TS-1 + TS-2.
- **M4** — reduced reads (3-5 sessions) — 12 tools from blueprint-read/asset-registry/data-assets. **Under D58**: 3 of the previously-M4 tools (`get_blueprint_graphs`, `get_animbp_graph`, `get_widget_blueprint` EventGraph subset) move to offline-primary via M-new/M-spatial; they stay in M-enhance as enrichment only. M4's reduced-reads list drops to 12 from scope-refresh §Q5.3's 15.
- **M5** — remaining Phase 3 toolsets (6-10 sessions, 3-4 sub-workers) — animation + materials + geometry + input-and-pie + editor-utility + visual-capture. Unchanged from scope-refresh §Q5.3.

**Aggregate**: 26.5-43 sessions post-D66 (original 28.5-47 reduced by 2-4 from Phase 4 absorption into M-enhance); wall-clock ~13-21 with parallelism.

**Open orchestrator calls** (per D58 follow-on items):

- ~~**FA-ε**~~ — RESOLVED by D66 HYBRID verdict 2026-04-21 (commit `56ff6f6`).
- **Scaffold commit timing**: fold into M1 vs separate 0.25-session dispatch — decide when M1 amendment lands.

When any dispatched handoff completes and residual items surface, consolidate them here if they're not immediately dispatchable. When a handoff fully ships, **remove it from this section** — completed work belongs in git history, not in the backlog index.
