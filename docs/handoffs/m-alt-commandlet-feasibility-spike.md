# M-alt Feasibility Spike — Commandlet-based BP introspection

> **Dispatch**: Fresh Claude Code session. Can run in parallel with M0 (different file scopes: `docs/research/` vs `tools.yaml`).
> **Type**: Research spike — evaluate whether headless UE commandlet can replace or complement the 3F sidecar save-hook for offline BP pin-topology introspection.
> **Duration**: 1-2 sessions (~3-4 hours).
> **Deliverable**: `docs/research/m-alt-commandlet-feasibility-2026-04-20.md` with a verdict the orchestrator can use to restructure (or preserve) the M1 + M2-Phase-A sequencing.
> **D-log anchors**: D45 (L3A EDITOR-ONLY), D48 (S-A/S-B split), D52 (near-parity), D54 (DR-3 SHIP-SIDECAR-PHASE-A-FIRST), D55 (S-B oracle-gated).

---

## Context & why this spike exists

The Phase 3 scope-refresh (commit `9e9dbe5`, §Q3) recommended SHIP-SIDECAR-PHASE-A-FIRST — the 3F save-hook delegate writes BP graph JSON when the editor saves an asset, offline tools read the JSON. The sequencing was M1 (3A TCP scaffolding) + M2-Phase-A (save-hook + 9 traversal verbs) in parallel.

**The un-evaluated alternative**: a headless UE commandlet invoked via `UnrealEditor-Cmd.exe -run=DumpBPGraph ...` emits the same amended-schema JSON on-demand, without requiring a persistent editor session. Lazy (30s cold / ~instant cached) vs save-hook's proactive (0s warm, but stale when editor wasn't running during save).

Both approaches require plugin C++ (the commandlet IS a `UCommandlet` subclass in the plugin). The question is: **is the commandlet path cheaper or more flexible than save-hook, enough to restructure the M-sequence?**

A secondary question under D52 near-parity: if commandlet covers most of (b) pin topology + portions of (c) compiled data + (d) reflection-only metadata **without requiring any live editor session**, the plugin-TCP surface for reads shrinks further — potentially deferring M1 entirely until a specific write or PIE workflow blocks.

**The spike does NOT write a `DumpBPGraph` commandlet.** It evaluates feasibility + cost + coverage.

---

## Mission

Answer 4 load-bearing questions. Each answer must be defensible from either a targeted experiment, UE source/docs, or prior UEMCP research artifacts.

### Q1 — Is headless commandlet invocation viable on ProjectA today?

Measure empirically. Stock UE commandlets exist out-of-the-box; you don't need to write `DumpBPGraph` to answer Q1. Candidates:
- `-run=ResavePackages -NoUnversioned -PackageFolder=/Game/ProjectA/Blueprints/Character/BP_OSPlayerR` (dry-run) — exists in stock UE
- `-run=NullCommandlet` — stock, no-op; measures raw editor-startup cost
- `-run=DerivedDataCache` — stock, builds DDC

Metrics to record:
- **Cold startup time** from process spawn to first commandlet output
- **Steady-state per-BP time** (if the stock commandlet iterates BPs, measure one BP's work)
- **Exit behavior** (clean exit vs hang vs crash; stdout/stderr capture; exit code reliability)
- **Engine-binary path** (is `UnrealEditor-Cmd.exe` at a predictable location given the installed engine? Does it need the .uproject argument?)
- **Concurrency** (can we run 2+ commandlets in parallel or does engine lock the project?)

Use `/Game/Blueprints/Character/BP_OSPlayerR` as a representative BP (it's large, has construction graph + function graphs + event graphs — from the real workflow conversation that motivated this spike).

**Experiment command skeleton** (adapt as needed — requires Windows CMD or PowerShell):
```cmd
"C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "D:\UnrealProjects\5.6\ProjectA\ProjectA\ProjectA.uproject" -run=NullCommandlet -unattended -nop4 -nosplash -stdout 2>&1
```

Record wall-clock time. **Expected**: 30-60s cold. If it's 5min, the approach is non-viable. If it's 10-20s, it's BETTER than expected.

### Q2 — What's the cost comparison for implementing commandlet-path vs save-hook-path?

Both require C++ plugin work. The spike must honestly compare:

| Cost axis | Save-hook path (M2-Phase-A current) | Commandlet path |
|---|---|---|
| Plugin C++ sessions | ~1-2 (save-hook delegate, JSON writer, editor-menu prime) | ? (UCommandlet subclass, JSON writer, arg parsing) |
| Offline JS sessions (9 verbs) | ~2-3 | ~2-3 (same verbs, different data source) |
| Caching logic | mtime check on sidecar file | mtime check + subprocess invocation |
| Stale-sidecar handling | Fallback to `{available:false}` | Regenerate on-demand (always-fresh) |
| Total sessions | 3-5 | ? |

Evaluate whether writing a `DumpBPGraph` commandlet is materially **smaller** than a save-hook delegate, or **equivalent**, or **larger**. Reference UE's existing commandlets (`UCommandlet` API in `Engine/Source/Runtime/Engine/Classes/Commandlets/Commandlet.h`) — the delta vs a save-hook is mostly iteration/arg handling (commandlet needs `Main(FString Params)` parsing) vs delegate-signature matching.

Hybrid option: **ship both** — save-hook for warm-path fidelity when editor is running, commandlet for regeneration when sidecar is stale or missing. Evaluate the incremental session cost of the hybrid (probably 0.5-1 session over save-hook alone since the C++ classes share most logic).

### Q3 — How much of the (c) / (d) plugin-TCP surface is commandlet-accessible without live editor?

This is the big question. If commandlet can serve not just (b) but also chunks of (c) compiled data and (d) reflection metadata, M1 + subsequent plugin-TCP work compresses dramatically under D52 near-parity.

Walk through the scope-refresh §Q1 tables. For each KEEP (reduced/full) tool under (c) and (d):

| Tool | D52 cat. | Needs live editor? | Commandlet-accessible? | Notes |
|---|---|---|---|---|
| `get_blueprint_info` (reflected interfaces + UClass flags) | (d) | ? | ? | UClass walks work headless — commandlet should reach these. |
| `get_niagara_system_info` (compiled VM + emitter eval) | (c) | ? | ? | Compiled Niagara is serialized to disk post-compile — commandlet loads, walks. |
| `list_material_parameters` (compiled shader uniforms) | (c) | ? | ? | Compiled shaders are serialized — commandlet accesses. |
| `get_anim_sequence_info` (compiled notify tracks + curves) | (c) | ? | ? | Baked data on disk — commandlet reads. |
| `list_data_asset_types` (loaded module class discovery) | (d) | ? | ? | Module-loaded classes visible in commandlet if modules load. |
| `get_blueprint_variables` (reflection-only metadata) | (d) | ? | ? | Metadata is in UClass — commandlet reaches. |
| ... | ... | ... | ... | (continue for all (c)/(d) tools) |

**Expected finding**: a substantial portion of (c) + (d) is commandlet-accessible. The genuinely-live-editor tools collapse to (a) runtime/PIE + (w) writes — both of which have NO current workflow pressure per our orchestrator state.

**Counter-expected** findings worth flagging if they emerge:
- Commandlets can't initialize editor subsystems needed for full reflection → live editor needed after all
- Compiled shader/Niagara data isn't accessible without shader compilation active → commandlet insufficient
- Headless initialization is unstable (asserts, hangs) for the deeper tools

If commandlet covers ~80% of (c) + (d), recommend restructuring. If it covers ~30%, stick with current plan.

### Q4 — Updated M-sequence recommendation

Produce a verdict with one of these shapes:

- **RESTRUCTURE-AGGRESSIVE**: Commandlet-first. Defer M1 entirely. Skip M2-Phase-A save-hook (commandlet is sufficient). Ship `M-cmd` (commandlet + 9 verbs offline) as the next wave. M1 re-enters only when a specific write/PIE workflow blocks.
- **RESTRUCTURE-HYBRID**: Commandlet-first for reads, defer M1 TCP work but ship save-hook as an eventual latency optimization. Sidecar from M2-Phase-A becomes an enhancement, not a blocker.
- **PRESERVE + AUGMENT**: Current M-sequence correct; add commandlet-based priming as a stale-sidecar backstop per my original D57 suggestion. Minimal changes.
- **PRESERVE**: Current plan is right; commandlet isn't viable enough or the coverage delta isn't meaningful.

Verdict must be defensible from Q1-Q3 findings. Don't pick RESTRUCTURE-AGGRESSIVE unless Q1 shows viable latency AND Q3 shows >70% (c)+(d) coverage AND Q2 shows commandlet C++ is ≤ save-hook C++ cost.

---

## You are NOT

- Writing a `DumpBPGraph` commandlet. That's a full implementation, not a spike.
- Writing any C++ plugin code.
- Re-opening D45 (L3A full-fidelity EDITOR-ONLY) or the scope-refresh's Q1 displacement table. Those are settled.
- Designing the commandlet's JSON schema. If the spike verdict recommends commandlet-first, a follow-up design handoff would design the schema (reusing the amendment spec's shape where possible).
- Evaluating Phase 4 (Remote Control) or any write/PIE tool. Out of scope.

---

## You ARE

- Running at least one stock-commandlet experiment (Q1) to measure real startup cost. This is empirical, not theoretical.
- Reading UE source headers to understand `UCommandlet::Main()` signature + editor-subsystem availability in commandlet mode. Locations: `Engine/Source/Runtime/Engine/Classes/Commandlets/Commandlet.h`, `Engine/Source/Editor/UnrealEd/Private/Commandlets/`.
- Walking scope-refresh §Q1 systematically for Q3 — every (c) + (d) tool evaluated.
- Synthesizing vs the current M-sequence. The baseline is §Q5 of `docs/research/phase3-scope-refresh-2026-04-20.md`.
- Flagging framing concerns if you find them. Per memory `feedback_framing_audit.md` — push back if the spike's own framing assumes something you think is wrong.

---

## Input files

### Tier 1 — Direct scope impact (read first)
1. `docs/research/phase3-scope-refresh-2026-04-20.md` (commit `9e9dbe5`) — especially §Q3, §Q5.3 M1/M2 scopes, §Q1.2/1.5/1.4 for (c)/(d) tool list.
2. `docs/research/sidecar-design-resolutions-2026-04-19.md` — save-hook design decisions (Q1 trigger semantics, JSON schema resolutions).
3. `docs/specs/blueprints-as-picture-amendment.md` — sidecar JSON schema (commandlet would produce the same shape).
4. `docs/tracking/risks-and-decisions.md` D45, D48, D52, D54, D55 — the scope-refresh's D-log anchors.

### Tier 2 — UE 5.6 source references
5. `Engine/Source/Runtime/Engine/Classes/Commandlets/Commandlet.h` — UCommandlet base class.
6. `Engine/Source/Editor/UnrealEd/Private/Commandlets/` — existing stock commandlets for reference patterns (ResavePackages, DerivedDataCache, CompileAllBlueprints, etc.).
7. UnrealEd-side BP loading — how does the editor deserialize `UEdGraph` from disk? Where does `UBlueprint::UbergraphPages` get populated? (Answers Q3's "is full BP graph reflection available in commandlet" question.)

### Tier 3 — Plugin reference
8. `ProjectA\Plugins\UnrealMCP\` — existing plugin structure (save-hook exists there? check for `OnObjectSaved` usage).
9. `plugin/` — UEMCP's empty scaffold (reference for what plugin C++ organization looks like).

### Tier 4 — Orchestrator state
10. `docs/handoffs/orchestrator-state-2026-04-20.md` + this handoff's context section — what the project's current M-sequence assumes.
11. `docs/tracking/backlog.md` post-scope-refresh state — M0-M6 queue.

---

## Deliverable structure

Write `docs/research/m-alt-commandlet-feasibility-2026-04-20.md`:

1. **Executive summary** (3-5 bullets) — top-line Q1-Q4 answers. Verdict (RESTRUCTURE-AGGRESSIVE / RESTRUCTURE-HYBRID / PRESERVE+AUGMENT / PRESERVE).
2. **Q1 — commandlet viability** — empirical measurements, commands run, wall-clock timings, failure modes observed.
3. **Q2 — cost comparison** — table of implementation session estimates with rationale. Honest about where commandlet saves work vs where it doesn't.
4. **Q3 — coverage analysis** — tool-by-tool walk through (c) + (d) scope with commandlet-accessible verdict for each. Summary percentages at end.
5. **Q4 — M-sequence recommendation** — chosen verdict with reasoning. If restructure: concrete new M-sequence in table form. If preserve: note what changes (commandlet-as-backstop specifically).
6. **Framing-audit notes** — anything the spike's framing got wrong.
7. **Appendix** — command outputs, file paths, engine-binary discovery notes.

Target ~1,500-2,500 lines. Tables + cited evidence, not prose-only.

---

## Success criteria

- Orchestrator can take the deliverable and (a) preserve the M-sequence with minor augmentation, OR (b) rewrite the M-sequence with confidence that commandlet-path actually works. No "more research needed" unless the honest answer is "we tried X, it was inconclusive, here's the narrowest follow-up that would settle it."
- Q1 has empirical data (at least one real `UnrealEditor-Cmd.exe` invocation with timing).
- Q3's coverage table has ≥ 80% of (c)+(d) tools evaluated (not all, but enough to be representative).
- Verdict is defensible against the steel-man of the losing side.

---

## Git discipline

Path-limited commit per D49:
```cmd
git commit docs/research/m-alt-commandlet-feasibility-2026-04-20.md -m "M-alt feasibility spike — commandlet vs save-hook"
```

Desktop Commander (shell: "cmd") if sandbox bash can't acquire `.git/index.lock`. Native Git Bash fine.

No AI attribution.

---

## Reminder: M0 may be running in parallel

M0 worker may be editing `tools.yaml` during this spike. Your scope is `docs/research/` only — zero collision. Use path-limited commits, ignore the parallel worker's commits appearing in `git log` between your operations.

---

## Final checkpoint before deliverable

Before writing the deliverable:

1. Have you actually run a stock commandlet invocation? (Q1 empirical requirement.)
2. Have you counted how many (c)+(d) tools are commandlet-accessible? (Q3 systematic requirement.)
3. Does your verdict hold against the steel-man? (For RESTRUCTURE-AGGRESSIVE: latency compound on cold corpus is acceptable? For PRESERVE: commandlet really isn't better anywhere?)
4. Have you flagged framing concerns this handoff has?

If any "no," finish research before writing.
