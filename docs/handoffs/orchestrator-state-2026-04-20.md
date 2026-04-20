# Orchestrator State — 2026-04-20 (Pre-Compaction Handoff)

> **Purpose**: Bootstrap a fresh orchestrator session with maximum context retention across a context-window compaction or session clear. Written while EN-2 Worker is in flight; post-compaction orchestrator should pick up from here without re-deriving state from chat scratch.
> **Read order**: this file → CLAUDE.md → current `docs/tracking/risks-and-decisions.md` D51-D52 → `docs/tracking/backlog.md` → any in-flight agent's handoff if unclear what they're doing.

---

## Git state

- HEAD: `b617306` on main (or later if EN-2 lands before compaction).
- Test baseline: **783 assertions** (525 primary + 258 supplementary). EN-2 will add ~15-25 on return.
- Recent commit chain highlights:
  - `b617306` — baseline sync 767→783 after F-1.5
  - `2789ef1` / `b936585` — F-1.5 Worker (array/object preprocess)
  - `f73ded2` — F-1.5 handoff + baseline sync 717→767
  - `bee5bd2` — MCP-Wire Integration Test Harness (50 new assertions)
  - `149c8e4` — F-1 Zod coerce for booleans/numbers (Pre-Phase-3 Fixes)
  - `5c47e00` / `d9bec19` — Sidecar Design Session resolutions

---

## Active dispatches

### EN-2 Worker (wave C) — in flight as of 2026-04-20

**Scope**: ships `find_blueprint_nodes_bulk(path_prefix)` — corpus-wide variant of `find_blueprint_nodes`. Closes Workflow Catalog rows 26/27/28/42/62/63 (SERVED_PARTIAL → SERVED_OFFLINE).

**Handoff**: `docs/handoffs/en2-find-blueprint-nodes-bulk.md`
**Expected time**: ~1 agent session (~45-90 min)
**Expected deliverables**: new tool in `offline-tools.mjs`, yaml entry, ~15-25 test assertions (unit + ideally MCP-wire), final report.

**When EN-2 returns**:
1. Sync baseline 783 → ~800 across CLAUDE.md + queued handoffs that still reference 783
2. Update CLAUDE.md attribution chain (add "EN-2 Worker added N")
3. Draft Phase 3 scope-refresh research handoff (see "Next orchestrator moves" below)

---

## Queue state

| Agent | State | Notes |
|---|---|---|
| EN-2 Worker | **In flight** | ~45-90 min |
| Phase 3 scope-refresh research | **Draft post-EN-2** | Load-bearing next piece |
| F-1.5 end-to-end verification | Optional | MCP-Wire harness covers it structurally; fresh-session check is belt-and-braces only |
| TS-1/2/3 yaml cleanup (over-served tools) | Backlog / optional | Could run parallel with EN-2 but Phase 3 scope-refresh may consolidate |
| Skeletal-subset S-B research (new) | **Folded into Phase 3 scope-refresh** — see "Key decisions this session" |

---

## Key decisions made this session (preserve across compaction)

### 1. D52 — near-plugin-parity for offline reads as explicit project goal (committed as D52 in risks-and-decisions.md)

Under D52, the plugin's READ-side scope reduces to: runtime/PIE state, UEdGraph pin topology (via sidecar), compiled derived data, reflection-only metadata. Everything else should be offline-capable. Translation: when designing new tools or triaging research questions, default to offline-first unless editor-mediated is structurally necessary.

### 2. Layered-parity framing for 3F sidecar (not identical-parity)

Full parity between sidecar-path and pure-bytes-path is silly (duplicated effort + version-skew burden + opportunity cost). Layered parity is the right shape:
- **Sidecar = full fidelity when editor has run** (spatial, comment containment, pin-trace, exec flow)
- **Pure bytes = robust floor always available** (name-level find/grep via `find_blueprint_nodes` shipped S-A)
- Sidecar becomes validation oracle for eventual pure-bytes S-B work

This framing was folded into the Sidecar Design Session via mid-session prompt (commit `d9bec19`). Phase 3 scope-refresh research must carry it forward.

### 3. Skeletal-subset S-B as new research angle (not yet commissioned)

Agent 11.5 (2026-04-16) evaluated full S-B at ~8-13 agent sessions. Today's conversation surfaced a refinement: **pin-block parser is ONE thing in `UEdGraphNode::Serialize()` base class, not 200+ things**. Per-node Serialize() overrides are where 200+ types vary (4-6 have bespoke overrides per Agent 11.5). If we only need pin data for the 19 shipped skeletal K2Node types (most using base-class Serialize), **cost could collapse to ~4-6 sessions**.

This is a genuinely new research question Agent 11.5 didn't evaluate. Decision: **fold into Phase 3 scope-refresh research** rather than standalone spike (cleaner decision space; scope-refresh has fuller picture). If Phase 3 scope-refresh concludes skeletal-subset S-B is 4-6 sessions and worth pursuing, commission separately at that point.

### 4. MCP-Wire harness validates F-1.5 structurally

F-1.5 shipped with the MCP-Wire harness in place — 8 of its new assertions are end-to-end via real McpServer + FakeTransport, exercising the exact JSON-RPC path Claude Code uses. The "does this work over the real wire?" risk F-1 carried is now structurally covered. Future Zod-related fixes don't need blocking manual verification — harness catches the class. This validates the MCP-Wire harness investment.

### 5. Array-stringification gap (F-1.5) was discovered by F-1 Verifier, not by Pre-Phase-3 Fixes worker

F-1 only targeted booleans/numbers. F-1 Verifier's §4.2 found that `z.array()` has the same wire-stringification pathology — `["AbilityTags"]` stringifies to `"[\"AbilityTags\"]"` on the wire. F-1.5 fixed this with `z.preprocess` + JSON-parse-or-passthrough pattern. **Lesson for future schema work**: the coerce/preprocess pattern should cover all non-string types on the wire. If a new param type surfaces (e.g., nested object schemas), it's the same pattern again.

---

## Phase 3 scope-refresh research — drafting requirements

When EN-2 lands, draft the handoff. Required content:

### Must evaluate
- **Current Phase 3 scope** in `tools.yaml` (toolsets with `layer: tcp-55558` + unpopulated stubs per D51 yaml dual-role)
- **What's been displaced** by Agent 10+10.5+EN-2 offline shipments (Agent 9 §3 projected 13 tools reduced/eliminated; verify current)
- **DR-3 decision**: should 3F sidecar writer ship as standalone early milestone (before rest of Phase 3)? Decision input from Sidecar Design Session (commits `5c47e00`/`d9bec19`) — 3F v1 scope is ~6-10 agent sessions
- **D52 near-plugin-parity implications**: every remaining Phase 3 tool should justify why it isn't offline-capable
- **Skeletal-subset S-B tractability** (the folded research from today): is pin-trace for only the 19 skeletal K2Node types at ~4-6 sessions viable? If yes, that further shrinks Phase 3 scope

### Must produce
- Updated Phase 3 tool list (what's still in scope, what moved offline, what was dropped)
- DR-3 recommendation (ship sidecar early vs bundle with rest of Phase 3)
- Answer on skeletal-subset S-B viability
- Dispatch sequencing recommendation for actual Phase 3 implementation work

### Input files
- `docs/research/sidecar-design-resolutions-2026-04-19.md` (Sidecar Design Session)
- `docs/research/level3a-skeletal-parse-study.md` (Agent 11.5 — S-A/S-B split)
- `docs/research/level3-feasibility-study.md` (Agent 11 — L3 categorization)
- `docs/research/agent-workflow-catalog.md` + §7a (100-query baseline)
- `docs/specs/phase3-plugin-design-inputs.md`
- `docs/specs/blueprints-as-picture-amendment.md`
- `docs/tracking/risks-and-decisions.md` D32/D37/D39/D45/D48/D50/D51/D52
- `docs/tracking/backlog.md` especially DR-1/DR-3
- `tools.yaml` Phase 3 toolsets
- Audit A (`docs/audits/post-agent10-5-codebase-audit-2026-04-19.md`)
- Audit B (`docs/audits/goal-alignment-audit-2026-04-17.md`)
- Post-EN-2 final state (commit + test baseline)

### Time budget
~2-3 hour research session. Deliverable: `docs/research/phase3-scope-refresh-2026-04-<date>.md`.

---

## Pending Noah decisions (none blocking right now)

- EN-2 return disposition: standard baseline sync + next-handoff draft. No decisions expected.
- F-1.5 end-to-end verification: optional; orchestrator recommends skip unless Noah wants belt-and-braces.

---

## Orchestration principles (memory, auto-loaded but list here for quick reference)

Four feedback memories saved to `C:\Users\user\.claude\projects\D--DevTools-UEMCP\memory\`:
1. **Orchestrator context cleanliness** — delegate non-orchestration work even when inline would be faster
2. **Agent scope bundling** — bundle related follow-on work when code patterns are shared (D48 Mode A)
3. **Framing audit on agent research** — proactively flag framing assumptions; user pushes back on flawed framing
4. **Verify handoff claims empirically** — handoff numbers go stale; workers should re-verify before pivoting design

Plus key operational rules in CLAUDE.md + D-log:
- **Path-limited git commits** (D49) when parallel sessions share the repo: `git commit <path> -m` not `git add && git commit`
- **Desktop Commander for git** (shell: "cmd") — sandbox bash can't acquire .git/index.lock
- **tools.yaml is single source of truth** (D44); no `offlineToolDefs` const in server.mjs
- **yaml dual-role** (D51): shipped-state + Phase 3 planning table; don't delete stub entries for un-shipped toolsets

---

## Recent state snapshots worth preserving

### Test suites (as of 783 baseline)

```
test-phase1.mjs:                    188  (phase1; D44 invariant + F-1 coerce + F-1.5 array coerce + Test blocks)
test-mock-seam.mjs:                  45  (mock-seam infrastructure tests)
test-tcp-tools.mjs:                 234  (Phase 2 TCP tools: actors/bp-write/widgets)
test-mcp-wire.mjs:                   58  (NEW — MCP-Wire harness Phase 1+2 + F-1.5 extensions)
test-uasset-parser.mjs:             197  (parser correctness; supplementary rotation)
test-offline-asset-info.mjs:         15  (supplementary)
test-query-asset-registry.mjs:       16  (supplementary)
test-inspect-and-level-actors.mjs:   30  (supplementary)
───────────────────────────────────────
Total:                              783
```

### Shipped offline tools (15 user-facing + 6 management = 21)

Offline: `project_info`, `list_gameplay_tags`, `search_gameplay_tags`, `list_config_values`, `get_asset_info`, `query_asset_registry`, `inspect_blueprint`, `list_level_actors`, `read_asset_properties`, `find_blueprint_nodes`, `list_data_sources`, `read_datatable_source`, `read_string_table_source`, `list_plugins`, `get_build_config`.

Management (always-loaded): `connection_info`, `detect_project`, `find_tools`, `list_toolsets`, `enable_toolset`, `disable_toolset`.

### Parser capabilities

`server/uasset-parser.mjs` + `server/uasset-structs.mjs`:
- Binary parser: FPackageFileSummary → name table → imports (40B stride) → exports (112B stride) → FPackageIndex resolver → FAssetRegistryData
- **Level 1+2+2.5 property decode**: FPropertyTag iteration (UE 5.6 FPropertyTypeName + EPropertyTagFlags), 12+ engine struct handlers, simple-element + complex-element TArray/TSet, TMap with scalar keys (struct keys emit marker)
- **Tagged-fallback for unknown structs (D50)**: 601 unique struct names decode via self-describing tag streams
- **FExpressionInput + 7 MaterialInput variants** (Parser Extensions)
- **FieldPathProperty** in L1 scalar dispatcher
- **int64 overflow salvage** at `readExportTable` (Cleanup Worker — 127 VFX files now parse)

### Zod schema infrastructure

`server/zod-builder.mjs` (extracted from server.mjs by Pre-Phase-3 Fixes Worker):
- `z.coerce.boolean()` / `z.coerce.number()` for wire-stringified primitives (F-1)
- `z.preprocess` + `jsonPreprocessOrPassthrough` for wire-stringified arrays/objects (F-1.5)
- Full MCP-wire resilience: client can stringify any typed value; server coerces/parses at the schema boundary

---

## Final note for fresh orchestrator session

You have enough in this doc + CLAUDE.md + D-log + backlog.md to resume orchestration without re-deriving from chat history. Start by:

1. `git log --oneline -15` — see what actually shipped
2. Check if EN-2 Worker's final report landed (look for `find_blueprint_nodes_bulk` in recent commits)
3. If EN-2 shipped: sync baseline, draft Phase 3 scope-refresh research per "Phase 3 scope-refresh research" section above
4. If EN-2 still in flight: ping Noah for status; standing by
5. When in doubt about project principles, re-read D45/D48/D49/D50/D51/D52 in `docs/tracking/risks-and-decisions.md`
