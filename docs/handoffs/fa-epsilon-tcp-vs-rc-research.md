# FA-ε Worker — M-enhance TCP brokers vs Phase 4 Remote Control boundary

> **Dispatch**: Fresh Claude Code session. **No dependencies** — pure research deliverable; independent of in-flight S-B-base worker.
> **Type**: Research — decision document at `docs/research/fa-epsilon-tcp-vs-rc-2026-04-21.md`. No code. No plugin changes.
> **Duration**: 1-2 sessions.
> **D-log anchors**: D58 §Q5 (FA-ε flagged as open orchestrator call), D53 (Phase 3 tool surface scope), D55+D58 M-enhance scope.
> **Deliverable**: decision document recommending whether M-enhance's runtime/compile/reflection queries ship as custom TCP brokers on port 55558, OR as Phase 4 Remote Control HTTP client usage on port 30010. Includes cost, latency, failure-mode, and workflow-compatibility analysis.

---

## Mission

Resolve the FA-ε open orchestrator call from D58: which transport should serve M-enhance's three query categories — **runtime values** (live CDO + world-actor property reads), **compile-time values** (BP compilation-derived data like `GeneratedClass` node/pin maps), and **reflection metadata** (UPROPERTY flags, UFUNCTION meta specifiers, UCLASS config inheritance).

Two candidates:

- **Option A — Custom TCP brokers on 55558**: M-enhance ships C++ command handlers inside the UEMCP plugin. Requests go through the same JSON-over-TCP transport M1 established. Plugin code reads live editor state via UE5 reflection APIs + custom command handlers per query category.
- **Option B — Phase 4 Remote Control HTTP on 30010**: M-enhance uses UE's built-in Remote Control plugin (HTTP + WebSocket endpoints) instead of building custom TCP handlers. Phase 4 Layer 4 of UEMCP's 4-layer architecture already allocates this; M-enhance would promote it forward.

The decision affects: M-enhance LOC/cost, plugin dependency surface (RemoteControl module add-back or not), Phase 4 scope (shrinks if M-enhance absorbs it; stays if not), server-side ConnectionManager complexity (Layer 4 HTTP client must exist either way for Phase 4 in theory, but could be deferred).

---

## Research questions

### Q1 — Coverage mapping

For each of the three query categories, map which specific tools from the Phase 3 tool surface need that query type. Use `docs/research/phase3-scope-refresh-2026-04-20.md` §Q5.3 M-enhance line and `tools.yaml` to enumerate.

For each tool, classify:
- FULL via TCP broker (custom handler required, writes-adjacent behavior or non-RC-exposed API)
- FULL via RC HTTP (property get/set via RC URL scheme covers it)
- PARTIAL (RC handles the common case, TCP broker needed for edge cases)
- NONE (neither transport suffices; tool moves to sidecar or deferred)

Output: table of ~15-25 rows tracking M-enhance's augmentation candidates.

### Q2 — UE Remote Control capability inventory

Empirically catalog what UE 5.6's Remote Control plugin exposes:
- HTTP endpoints: `/remote/object/property` (get/set), `/remote/object/call` (function invocation), `/remote/search/asset`, `/remote/presets`, etc.
- WebSocket subscription model for change notifications
- Auth model (none by default; RC is LAN/trusted-network)
- Rate limits / threading constraints (is editor main thread the bottleneck?)
- **Writes**: does RC HTTP support the full write surface M3 needs, or just property-get?
- **Reflection depth**: can RC enumerate UCLASS config inheritance, UFUNCTION meta, UPROPERTY flags?
- **Custom expose points**: UE plugins can register RC exposers — is this the right mechanism for edge-case reads?

Sources: UE 5.6 `Engine\Plugins\VirtualProduction\RemoteControl\*` + UE docs site (use context7 MCP).

### Q3 — Cost sensitivity

For each option, estimate:
- Plugin-side LOC (custom TCP handlers vs RC registration + exposer glue)
- Server-side LOC (JSON marshalling in tcp-tools.mjs vs HTTP-client infrastructure + URL scheme translation)
- Test surface (integration test harness reach vs wire-mock complexity)
- M-enhance session count impact (base estimate: 3-5 sessions under D58; how does option choice move it?)

Option A expected impact: unchanged or +0.5 (custom handler work is already in M-enhance's scope).
Option B expected impact: +1-2 sessions (HTTP-client infrastructure is new; RC URL scheme learning curve).

### Q4 — Failure-mode comparison

For each option, enumerate:
- Transport-down behavior (how does Option A degrade if port 55558 is blocked vs Option B if 30010 is blocked?)
- Mid-editor-crash recovery
- Concurrent-request safety (main-thread contention, editor-hitch signals)
- Version-drift risk across UE 5.6 → 5.7 (which API surface is more stable?)

### Q5 — Architectural purity vs pragmatism

The 4-layer architecture from D23 explicitly allocates HTTP:30010 as Layer 4. Option A (M-enhance uses 55558) short-circuits that allocation. Is that a principled simplification or a scope leak?

Consider:
- D58's "MCP-first, plugin-enhances" framing — how does each option honor it?
- D52's edge-topology offline near-parity goal — does this decision interact with S-B / Verb-surface work?
- Phase 4 RC scope — if M-enhance absorbs RC use, does Phase 4 still need to exist, or does it collapse to per-tool HTTP-client adds?

### Q6 — Recommendation + rationale

Pick A or B or a hybrid. Document reasoning in a form the orchestrator can challenge. Include:
- The 2-3 most load-bearing inputs driving the decision
- The rejection reasoning for the non-chosen option (not just "it's worse" — what specifically fails)
- Follow-on decisions this verdict unblocks or creates
- Any amendments needed to existing D-log entries (D23, D53, D58)

---

## Scope — out

- No code writing. This is a decision document, not a prototype.
- No plugin additions. Leave the plugin source tree as S-B-base finds it.
- No yaml changes. `tools.yaml` edits are M-enhance's scope post-verdict.
- Don't re-research M-enhance's full tool surface from scratch — use scope-refresh + re-sequence docs as baseline.
- Don't prescribe M-enhance's implementation details — just the transport-layer choice + consequences.

---

## Reference files

### Tier 1 — Scope sources
1. `docs/tracking/risks-and-decisions.md` D23 (4-layer architecture), D53 (Phase 3 tool surface), D55 (M-enhance pre-D58 scope), D58 (re-sequence + FA-ε flag).
2. `docs/research/phase3-scope-refresh-2026-04-20.md` §Q5.3 (M-enhance enumeration).
3. `docs/research/phase3-resequence-mcp-first-2026-04-20.md` §Q5 (M-sequence with M-enhance post-M-new).

### Tier 2 — UE Remote Control reference
4. UE 5.6 engine source: `C:\Program Files\Epic Games\UE_5.6\Engine\Plugins\VirtualProduction\RemoteControl\`.
5. context7 MCP for current UE 5.6 Remote Control API docs.
6. Existing UnrealMCP (`ProjectA\Plugins\UnrealMCP\`) — precedent for what the 55557 oracle covers but intentionally NOT via RC. Historical signal.

### Tier 3 — Phase 3 deliverables (context)
7. `plugin/UEMCP/UEMCP.uplugin` — current plugin module deps (RemoteControl was there briefly during M1 debug arc, removed; would be re-added under Option A).
8. `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs` — module dependency list; RemoteControl add costs an entry + Plugins[] entry in .uplugin (UBT consistency rule from D60).

### Tier 4 — D-log anchors
9. `docs/tracking/risks-and-decisions.md` — full log, D1-D65.

---

## Deliverable

New file: `docs/research/fa-epsilon-tcp-vs-rc-2026-04-21.md`. Structure per other research docs (`phase3-scope-refresh-*`, `m-alt-commandlet-feasibility-*`):

- §Executive verdict (one sentence: A, B, or hybrid)
- §Q1 — coverage mapping table
- §Q2 — RC capability inventory
- §Q3 — cost sensitivity analysis
- §Q4 — failure-mode comparison
- §Q5 — architectural purity analysis
- §Q6 — recommendation + rationale
- §Open items (anything that emerges requiring follow-up)
- §Confidence assessment per question

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **Path-limited commits per D49** — scope git adds to `docs/research/fa-epsilon-tcp-vs-rc-2026-04-21.md` + optional amendments to `docs/tracking/risks-and-decisions.md` (if you surface a D-log entry worth adding) + optional `docs/tracking/backlog.md` edit (if FA-ε verdict reshapes M-enhance's queue position).
- **No AI attribution**.
- **No S-B-base collision** — stay out of `server/*` and `plugin/*` (except reading for context).
- **Use context7 MCP for UE docs** per CLAUDE.md MCP server instructions.

---

## Final report to orchestrator

Report (keep under 300 words):
1. Commit SHA + verdict (A / B / hybrid).
2. The 2-3 load-bearing inputs driving the verdict.
3. M-enhance cost impact delta (session-count change vs pre-verdict baseline).
4. Any D-log amendments (D23, D53, D58) the verdict triggers.
5. Any open items requiring future research.
6. Next action: M-enhance handoff draftable with transport question resolved.
