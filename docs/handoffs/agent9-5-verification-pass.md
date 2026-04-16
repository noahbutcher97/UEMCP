# Agent 9.5 Handoff — Level 1+2 Design Verification Pass

> **Dispatch**: Before Agent 10 (Level 1+2 parser implementation)
> **Depends on**: Agent 9 — delivered (`docs/research/level12-tool-surface-design.md`, Option C hybrid)
> **Type**: Empirical verification of Agent 9's claims — NO design changes, NO code changes, NO yaml changes
> **Deliverable**: `docs/research/level12-verification-pass.md`
> **Time budget**: ~90-120 min session. If a check blows past its estimate, document current state and stop — don't chase depth past the time budget.

---

## Mission

Agent 9 produced a hybrid design (Option C) that leans on four empirical claims about UE 5.6 serialization behaviour on real ProjectA fixtures. Your job is to verify those claims against the actual project on disk, **before** Agent 10 codifies them into parser and tool-handler code. This is independent verification: fresh eyes, empirical method, no design authorship.

**You are NOT**:
- Re-evaluating Agent 9's shape-level decisions (Option C vs A/B, yaml locations, budget math). That's decided.
- Designing anything. If a claim fails, document the failure and its implications — do NOT propose a fix.
- Writing production code. Throwaway scripts under `/tmp/` or inline Node `-e` are fine; do not commit them.

**You ARE**:
- Testing 4 specific claims against ProjectA fixtures via the existing `server/uasset-parser.mjs`.
- Reporting `CONFIRMED` / `AMENDED` / `REFUTED` per claim, with file:line or fixture-path evidence.
- Listing the specific Agent 10 handoff changes required if any claim fails.

---

## Critical context

- UEMCP monorepo at `D:\DevTools\UEMCP\`. Git on `main`, HEAD at commit `f517f96` (D44 refactor landed).
- 436/436 tests green across 7 suites (333 primary + 103 supplementary).
- ProjectA fixtures at `D:\UnrealProjects\5.6\ProjectA\ProjectA\` (set `UNREAL_PROJECT_ROOT` accordingly).
- The existing `uasset-parser.mjs` already reads FPackageFileSummary → name table → import table (40-byte stride, UE 5.0+) → export table (112-byte stride) → FPackageIndex resolver → AR tag block. It does NOT yet walk serialized property data — that's Agent 10's scope.
- For V1 (transform chain), you'll hand-trace the property bytes by reading `FObjectExport::SerialOffset` + `SerialSize` from the parser and manually decoding a handful of FPropertyTag records. You do not need to build a full property reader — just prove the chain resolves on 2-3 real actors.
- **Shell**: native Windows bash works for reads. Desktop Commander only needed for git writes (you won't write git).

---

## Input files

Read first:
1. `docs/research/level12-tool-surface-design.md` — **the target of this verification**. Pay special attention to §1 (what Level 1+2 surfaces), §2 Option C signatures, §3 Phase 3 scope table, §4 transform resolution note.
2. `docs/research/uasset-parser-audit-and-recommendation.md` — Agent 8's research. Establishes what's parseable.
3. `docs/audits/uemcp-server-codebase-audit-2026-04-16.md` — §3 offline-tools section has the `genClassNames` limitation relevant to V2.
4. `server/uasset-parser.mjs` — the parser you'll use for hand-tracing.
5. `server/offline-tools.mjs` — `inspectBlueprint` (line ~1117) and `listLevelActors` (line ~1205) — existing handlers you can call to gather data.
6. `tools.yaml` — Phase 3 toolsets (everything under `toolsets:` with `layer: tcp-55558`) for V4.
7. `docs/specs/phase3-plugin-design-inputs.md` — Phase 3 scope expectations.

---

## The 4 verification targets

### V1 — Transform resolution chain

**Claim**: Agent 9 §4 "Transform resolution (Agent 10 note)" asserts that actor transforms are readable offline via a two-hop chain:
> placed actor export → resolve `RootComponent` ObjectProperty → follow to component export → read `RelativeLocation` (FVector), `RelativeRotation` (FRotator), `RelativeScale3D` (FVector) on that component.

**Verification method**:
1. Pick 2-3 actors from a small ProjectA `.umap` (use `list_level_actors` to find candidates — prefer a PlayerStart + 1 StaticMeshActor + 1 BP instance).
2. For each candidate, locate its export in the parser output (use `inspect_blueprint` or direct parser calls — you can `import { parseBuffer, readExportTable, readImportTable, resolvePackageIndex } from './uasset-parser.mjs'`).
3. Open a Node REPL or one-off `-e` script. Read the raw bytes from `SerialOffset` to `SerialOffset + SerialSize` for the actor's export.
4. Walk FPropertyTag records manually (per CUE4Parse reference documented in Agent 8's audit) until you find either `RootComponent` (ObjectProperty → FPackageIndex) or a direct `RelativeLocation` field. If `RootComponent` is an ObjectProperty with value > 0, follow to the export at index `N-1` and repeat.
5. At the component export, confirm the FVector/FRotator/FVector3D serialization is physically present at readable offsets.

**Evidence format**: per actor, report the export chain (names + package indices), whether the transform is reachable, and any surprises. If the two-hop model is wrong (e.g., transform is inlined on the actor export itself rather than via RootComponent), document the actual structure.

**Success criteria**: ≥2 of 3 actors successfully resolve. Document exceptions (e.g., `WorldSettings` has no RootComponent).

**Stop rule**: if you cannot resolve the first actor after 40 minutes of hand-tracing, that itself is evidence — report `REFUTED` with "empirical complexity exceeds time budget; Agent 10 should prototype before committing to this design" and stop V1.

---

### V2 — CDO export naming convention

**Claim**: Agent 9 §5 Q4 recommends defaulting `read_asset_properties.export_name` to `Default__<AssetName>_C` for BP-subclass assets. The audit flagged that `inspectBlueprint`'s `genClassNames` set only covers 3 BP subclasses; `GameplayAbilityBlueprintGeneratedClass` not recognized.

**Verification method**:
1. Pick 5 BP types from ProjectA: one each of `BP_*`, `BPGA_*` (GameplayAbility), `BPGE_*` (GameplayEffect), `WBP_*` (Widget), `ABP_*` (AnimBP). Use `query_asset_registry` or `Content/` glob to find candidates.
2. For each, call `inspect_blueprint` and record:
   - The `objectClassName` (e.g., `/Script/Engine.BlueprintGeneratedClass`, `/Script/GameplayAbilities.GameplayAbilityBlueprintGeneratedClass`)
   - Whether `generatedClass` and `parentClass` resolve correctly (non-null)
   - The actual CDO-looking export names in the `exports` array (search for `Default__*` pattern)
3. Build a table: asset path → `objectClassName` → whether `Default__<Name>_C` export exists → actual CDO export name if different.

**Evidence format**: markdown table with 5 rows. Flag any BP subclass where `Default__<Name>_C` is absent or names don't match the pattern.

**Success criteria**: pattern holds for all 5 → `CONFIRMED`. Any exception → `AMENDED` with specific mitigation note for Agent 10 (e.g., "Agent 10 must extend genClassNames to include `/Script/GameplayAbilities.GameplayAbilityBlueprintGeneratedClass`").

---

### V3 — Row size projection for `list_level_actors` + transforms

**Claim**: Agent 9 §4 "F3 mitigation decision" asserts ~60 B/row transform overhead, making total row size delta ~13 KB on the 223-row F3 whitebox case.

**Verification method**:
1. Find an ProjectA dense level. The F3 post-F4 whitebox case was referenced in `docs/audits/phase2-tier2-parser-validation-2026-04-15.md` — check that audit for the actual fixture path. If Bridges2 fixture is accessible, note its placed-actor count.
2. Run current `list_level_actors` on the chosen map. Measure:
   - Total placed actors (post-F4 filter)
   - Current response size (stringify the JSON)
   - Estimated per-row byte cost (size / row count)
3. Estimate the transform payload size per row:
   - `transform: { location: [x,y,z], rotation: [p,y,r], scale: [x,y,z] }` — JSON.stringify this with realistic numbers (e.g., `[1234.56, 789.01, -234.56]`). Count bytes.
   - Project: (current rows × current per-row) + (current rows × transform bytes) = new total
4. Decision rule: if projected total exceeds 200 KB for any real ProjectA level at `limit=100` default, note that the pagination default may be too high.

**Evidence format**: measured row counts + current vs projected response sizes for ≥1 dense level. If you can measure against 2 (e.g., a small test map + a dense one), better.

**Success criteria**: transform row overhead is within 2x of Agent 9's 60 B/row claim AND projected sizes at `limit=100` are under the implicit MCP payload cap. Deviation → `AMENDED` with specific pagination-default recommendation for Agent 10.

---

### V4 — Phase 3 scope classification audit

**Claim**: Agent 9 §3 table lists 13 Phase 3 tools as eliminated (1) or reduced (12) by Level 1+2 + Option C.

**Verification method**:
1. Read current `tools.yaml` for Phase 3 toolsets (`layer: tcp-55558`). Cross-reference `docs/specs/phase3-plugin-design-inputs.md` where it describes planned surface for each.
2. Spot-check 3-4 of Agent 9's "reduced" classifications — recommended picks:
   - `blueprint-read.get_blueprint_variables` (reduced — CDO defaults cover static, reflection flags don't)
   - `asset-registry.get_asset_references` (reduced — hard refs via property walk, soft refs still need registry)
   - `remote-control.rc_get_property` static case (reduced — saved CDO reads go offline, live UObject reads stay)
   - `actors.get_actor_transform` static case (reduced — static-saved transforms via `list_level_actors`, runtime stays TCP)
3. For each, verify: does Agent 9's description of what moves offline vs what stays accurately match the tool's planned surface in tools.yaml / phase3-plugin-design-inputs.md?

**Evidence format**: per-tool table with columns: Agent 9 classification | what Agent 9 says moves offline | what tools.yaml says the tool was planned to do | match (✅/⚠️/❌) | note.

**Success criteria**: all 3-4 spot-checks align. Misclassifications → `AMENDED` with the corrected status; note which downstream D-log / tools.yaml update the orchestrator needs to adjust.

---

## Output format

Write `docs/research/level12-verification-pass.md` with:

### §1 Summary
Top-line result: N confirmed / N amended / N refuted. Agent 10 handoff changes required (or "none").

### §2 V1 — Transform resolution chain
Per-actor evidence table. Chain structure actually observed. CONFIRMED/AMENDED/REFUTED with rationale.

### §3 V2 — CDO export naming
5-row BP table. Pattern assessment. CONFIRMED/AMENDED with specific genClassNames extension list if needed.

### §4 V3 — Row size projection
Measured data. Projected sizes. CONFIRMED/AMENDED with pagination-default recommendation if needed.

### §5 V4 — Phase 3 scope audit
Per-tool spot-check table. CONFIRMED/AMENDED with D-log-update needs if needed.

### §6 Agent 10 handoff changes required
Specific list. Each entry: "In the Agent 10 handoff, change X to Y because V-whatever showed Z." If no changes required, say so explicitly.

### §7 Confidence
Self-assessment: HIGH / MEDIUM / LOW. Reasoning. Anything you couldn't verify within the time budget that's worth flagging.

---

## Constraints

- **Empirical only** — every CONFIRMED requires file:line or fixture-path citation. Reasoning-only confirmations are not acceptable.
- **No design changes** — if a claim fails, document the failure and its implications; do NOT propose alternative designs. Agent 10 handoff adjustments are listed mechanically (what field to change), not redesigned.
- **No code changes** — no edits to `.mjs`, `.yaml`, or any production file. Throwaway scripts at `/tmp/` are fine and should be deleted after use.
- **Time-boxed** — 90-120 min target. If a check blows budget, document progress-so-far and move on. Partial verification is better than skipped verification.
- **No AI attribution** — no `Co-Authored-By: Claude`, no "generated with AI" anywhere.
- **No D-number** — this is a research verification doc; no decisions to log.

---

## Final Report format

```
Agent 9.5 Final Report — Level 1+2 Design Verification

V1 Transform chain:     [CONFIRMED / AMENDED / REFUTED] — [one-line summary]
V2 CDO export naming:   [CONFIRMED / AMENDED / REFUTED] — [one-line summary]
V3 Row size projection: [CONFIRMED / AMENDED / REFUTED] — [one-line summary]
V4 Phase 3 classifications: [CONFIRMED / AMENDED / REFUTED] — [one-line summary]

Agent 10 handoff changes required: [N items or "none"]
Confidence: [HIGH / MEDIUM / LOW]
Deliverable: docs/research/level12-verification-pass.md ([N] lines)
Time spent: [N minutes]
```
