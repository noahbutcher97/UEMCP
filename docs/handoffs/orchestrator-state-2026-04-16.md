# Orchestrator State — 2026-04-16 (v2)

> **Purpose**: Bootstrap a fresh orchestrator session. Read this file, then CLAUDE.md, then pick up where we left off.
> **Last updated**: 2026-04-16 end-of-day (post-Agent-10-dispatch + housekeeping sweep)
> **Revision**: v2 — supersedes pre-dispatch snapshot (see git log for prior content).

---

## Git State

All work is on `main`. HEAD at `00a0a81` (pre-housekeeping-commits). Recent commits (newest first):

| Commit | Content |
|--------|---------|
| `00a0a81` | Add Housekeeping Worker handoff for post-Agent-10-dispatch backlog |
| `e1cfb8b` | Lock Q-1 = Mode A; footnote Agent 10 handoff with 10.5 bundling plan (D48 amendment) |
| `8bd78af` | Land Agent 11.5 deliverable + D48 L3A skeletal split verdict |
| `e1ef570` | Update Agent 10 handoff with Option C + V9.5 corrections + D46 L3B scope |
| `009e435` | Land research deliverables: Agent 9 (design), Agent 11 (L3 feasibility), Agent 9.5 (verification) |
| `bd69e3d` | Add Agent 11.5 handoff + D45/D46/D47 to close L3 categorization |
| `4ba61a2` | Add Agent 11 handoff: Level 3 feasibility study (revisit) |
| `7599131` | Add Agent 9.5 verification pass handoff |
| `f517f96` | D44: eliminate offlineToolDefs duplication; yaml is now source of truth |
| `33a2de5` | Phase A cleanup: M3 fix, M6 rotation, D44 decision, Agent 9 handoff patch |
| `72661b0` | Fix 2 MEDIUM yaml issues (take_screenshot params, get_all_blueprint_graphs dupe) |
| `937b02c` | Add mandatory verification pass to codebase audit handoff |
| `799fd7a` | Add pre-Agent 9 codebase audit handoff, update orchestrator sequencing |

**Tests**: 436/436 total — 333 primary (54 phase1 + 45 mock-seam + 234 TCP) + 103 supplementary (42 parser + 15 asset-info + 16 registry + 30 inspect/level-actors). Supplementary suite wired into rotation 2026-04-16 (M6 fix).

**Pending housekeeping commits** (lands after this rewrite as a separate task series):
- Commit lingering manual-testing result files (`docs/handoffs/testing-handler-fixes-results-2026-04-16.md`, `docs/testing/2026-04-16-handler-fixes-manual-results.md`)
- CLAUDE.md "Current State" refresh
- Agent 9.5 scratch script cleanup (`server/tmp-probe-proptag.mjs`)
- ProjectB 5.7 smoke-test findings note

---

## Manual Testing — COMPLETE (sealed)

**Result**: 25/25 PASS on second run (post-F0 fix at `5aaa290`).
**Reports**:
- `docs/testing/2026-04-16-handler-fixes-manual-results.md` (Noah's first run, 18/19 + F0 regression)
- `docs/handoffs/testing-handler-fixes-results-2026-04-16.md` (second run, 25/25 PASS)

Ship-ready verification complete for F0 (verbose blob stripping), F1 (pagination), F2 (tags removed from inspect_blueprint), F4 (placed-actor filter), F6 (short class-name matching).

**F0-class false-confidence lesson (living)**: Unit tests calling `executeOfflineTool` directly bypass the Zod schema + SDK handler wrapper + MCP wire path. Param-passthrough bugs between switch dispatch and handler function are invisible to unit tests. Agent 10 should add an MCP-wire integration harness per the audit recommendation.

---

## Codebase Audit — SEALED (2nd run, with verification)

**Deliverable**: `docs/audits/uemcp-server-codebase-audit-2026-04-16.md` (~580 lines)
**Confidence**: HIGH (self-verified — all 45 handler param chains traced at file:line, all test suites run)
**Findings**: 0 CRITICAL, 0 HIGH, 6 MEDIUM, 4 LOW

### MEDIUM disposition

| # | Finding | Status | Landing commit |
|---|---------|--------|----------------|
| M1 | `take_screenshot` yaml missing `resolution_x`/`resolution_y` | **FIXED** | `72661b0` |
| M2 | `get_all_blueprint_graphs` declared twice in yaml | **FIXED** | `72661b0` |
| M3 | `inspect_blueprint.verbose` description drift (server.mjs lied, yaml correct) | **FIXED** | `33a2de5` (Phase A) |
| M4 | `server.mjs:offlineToolDefs` vs `tools.yaml` description drift (13 tools) | **FIXED — D44** | `f517f96` (offlineToolDefs eliminated; yaml is single source of truth) |
| M5 | 3 near-identical TCP dispatchers in tcp-tools.mjs | OPEN | Deferred — post-Phase 3 DRY refactor |
| M6 | 2 supplementary test files had 3 stale assertions from F1/F2 fixes | **FIXED** | `33a2de5` (Phase A — tests wired into rotation) |

**5 of 6 MEDIUMs closed; M5 is a post-Phase-3 refactor, not a current blocker.**

### LOW items (all 4 still OPEN, non-blocking):

- `getToolDef` dead code in toolset-manager.mjs:247
- `SERVER_INSTRUCTIONS` inlined in server.mjs (~6 lines — compact, not the issue previous audit implied)
- `detectProject` uses PowerShell-only auto-detection (Windows-only project, not blocking)
- `parseBuffer` export only returns `{ summary }` — richer parsers must be composed manually

---

## What's Next (in order)

1. **Agent 10 in flight** — Level 1+2+2.5 parser + 3 Option C tools
   - File scope: `server/uasset-parser.mjs`, new `server/uasset-structs.mjs`, `server/offline-tools.mjs`, `server/test-phase1.mjs`, `server/test-uasset-parser.mjs`, `tools.yaml`, `server/server.mjs` (one registration block)
   - Handoff: `docs/handoffs/agent10-level12-parser-implementation.md`
   - Absorbed scope: Level 1 (FPropertyTag iteration), Level 2 (~10 struct handlers), Level 2.5 simple-element containers (D46 — `TArray`/`TSet` of scalars/engine structs/enums/gameplay tags)
   - Non-scope (deferred to 10.5): `TMap<K,V>`, `TArray<FMyUserStruct>`, `UUserDefinedStruct` resolution, S-A skeletal K2Node parse
   - Depends on: Agent 8 (research audit), Agent 9 (Option C tool surface), Agent 9.5 (4 V9.5 corrections), Agent 11 (L3 feasibility), Agent 11.5 (L3A split verdict)
   - Estimated multi-day session
2. **Agent 10.5 — bundled follow-on (Q-1 Mode A resolved in D48)** — single session covering:
   - D46 complex containers: `TMap<K,V>`, `TArray<FMyCustomStruct>`
   - D47 UUserDefinedStruct resolution (two-pass struct-registry extension)
   - D48 S-A skeletal K2Node parse — name-only tagged-property coverage of ~10-13 K2Node types (events, variable access, function calls, core control flow)
   - All three share the struct-registry extension pattern → bundling is more coherent than Mode B (standalone 10.75)
   - Handoff: not yet drafted. Orchestrator should write it after Agent 10 ships — foundation known only then.
3. **3F sidecar (spec exists)** — editor plugin dumps JSON on BP save; offline tools read the dump. See `docs/specs/blueprints-as-picture-amendment.md`. Editor-soft-dependency acknowledged per D45. Becomes critical path once Agent 10.5 lands and S-A provides the name-level floor.
4. **Phase 3 C++ plugin** — deferred per D39 until Level 1+2+L2.5+10.5 reveals what the plugin actually needs. Scope has shrunk progressively: D32 (registry-backed tools move offline permanently), D35 (P0-1/7/9/10 absorbed server-side, rest deferred plugin-only), D45 (L3A permanently editor-only → 3F sidecar, not pure parser), D48 (S-A name-only covered offline → 3F covers spatial+trace).
5. **Oracle retirement (single milestone flip, D40)** — post-Phase 3: flip `actors` / `blueprints-write` / `widgets` toolsets from `tcp-55557` to `tcp-55558` in tools.yaml, drop 55557 layer from ConnectionManager. One commit.

---

## Workflow Rules

### Agent Dispatch
- **Orchestrator writes handoffs**, Noah dispatches them as separate Claude Code sessions.
- Handoffs live in `docs/handoffs/` and are self-contained — agents read them, not chat history.
- Each handoff specifies: mission, file scope, input files, deliverables, constraints, final report format.
- Parallel dispatch is supported when scopes don't overlap (D34 pattern: Agents 2 + 3). Housekeeping Worker (this cycle) runs in parallel with Agent 10 on non-overlapping scopes.

### D-Number Allocation
- Orchestrator pre-allocates D-numbers to prevent parallel-worker races.
- **Current D-log is at D48. Next available: D49.**
- D-log lives in `docs/tracking/risks-and-decisions.md`.

### Git Operations
- **Desktop Commander is MANDATORY** for git and filesystem writes from within Cowork sandbox sessions. Sandbox bash mount cannot acquire `.git/index.lock`.
- Use `mcp__Desktop_Commander__start_process` with `shell: "cmd"` (not PowerShell — PATH issues).
- **Commit message workaround**: CMD mangles quoted strings. Write to temp file: `echo message> commit-msg.txt && git commit -F commit-msg.txt && del commit-msg.txt`.
- Native Claude Code CLI sessions outside Cowork can use the built-in `Bash` tool directly; the lock issue is specific to the sandbox mount.

### Conventions
- **Sealed audits**: never edit after creation. Amendments use blockquote format.
- **D-log**: revised in place (living doc).
- **No AI attribution** in commits, PRs, or review docs.
- **YAGNI** — don't create files for future work unless tasked.
- **Single source of truth for tools** (per D44): `tools.yaml` owns descriptions + params; no duplicate registries in server code.

---

## Completed Agents

| Agent | Type | Status | Key Deliverable |
|-------|------|--------|-----------------|
| 1-5 | Various (Phase 1-2) | Done | Phase 1+2 complete, 333 primary assertions |
| 6 | Handler fixes | Done | F0/F1/F2/F4/F6 in offline-tools.mjs |
| 7 | Research collection | Done | `docs/research/uasset-property-parsing-references.md` (14 projects surveyed) |
| 8 | Research audit | Done | `docs/research/uasset-parser-audit-and-recommendation.md` (CUE4Parse + UAssetAPI recommended) |
| Grounding audit (2 runs) | Codebase audit | Done | `docs/audits/uemcp-server-codebase-audit-2026-04-16.md` (0C/0H/6M/4L) |
| 9 | Tool surface design | Done 2026-04-16 | `docs/research/level12-tool-surface-design.md` — Option C hybrid (modify `list_level_actors` + `inspect_blueprint`; add `read_asset_properties`) |
| 9.5 | Verification pass | Done 2026-04-16 | `docs/research/level12-verification-pass.md` — 4 V9.5 corrections: transform chain via outerIndex reverse scan (not RootComponent ObjectProperty); UE 5.6 FPropertyTag layout differs from pre-5.4 CUE4Parse; sparse transforms are intended behaviour (~63% null); corrected size numbers (Metric_Geo 29.4 KB post-F4, Bridges2 346 KB → pagination mandatory) |
| 11 | L3 feasibility | Done 2026-04-16 | `docs/research/level3-feasibility-study.md` — L3A full-fidelity EDITOR-ONLY (D45); L3B simple-element containers bundle with Agent 10 as L2.5 (D46); L3C UserDefinedStruct PURSUE (D47) |
| 11.5 | L3A skeletal split study | Done 2026-04-16 | `docs/research/level3a-skeletal-parse-study.md` — S-A PURSUE (name-only, 62-100% K2Node coverage via tagged-property reference ports); S-B FOLD-INTO-3F (pin-tracing has zero reference coverage; duplicates sidecar at 4-8× cost). D48 locks the split. |
| Housekeeping Worker | Docs/git/smoke | In-flight 2026-04-16 | This cycle — refresh orchestrator state + CLAUDE.md + commit testing results + ProjectB smoke + scratch cleanup |

---

## Key Files

| File | Role |
|------|------|
| `CLAUDE.md` | Project overview, architecture, current state, code standards |
| `tools.yaml` | **Single source of truth (D44)** for all 120 tools — descriptions, params, toolset membership, aliases, wire_type |
| `docs/tracking/risks-and-decisions.md` | D-log (D1-D48) |
| `docs/handoffs/` | All agent handoff docs (self-contained briefs) |
| `docs/handoffs/agent10-level12-parser-implementation.md` | Active agent's brief (multi-day session) |
| `docs/handoffs/housekeeping-worker-2026-04-16.md` | Parallel-session backlog clear |
| `docs/research/` | Parser survey + audit; Level 1+2 tool surface design; L3 + L3A skeletal feasibility |
| `docs/audits/uemcp-server-codebase-audit-2026-04-16.md` | Codebase grounding audit (0C/0H/6M/4L; 5 MEDIUMs closed) |
| `docs/audits/phase2-tier2-parser-validation-2026-04-15.md` | Sealed Phase 2 audit with 7 findings (all fixed) |
| `docs/testing/2026-04-16-handler-fixes-manual-results.md` | Manual testing report, first run (18/19 + F0 regression surfaced) |
| `docs/handoffs/testing-handler-fixes-results-2026-04-16.md` | Manual testing report, second run (25/25 PASS post-F0-fix) |
| `docs/specs/blueprints-as-picture-amendment.md` | 3F sidecar spec (editor-dependent but covers spatial + exec-trace workflows) |
