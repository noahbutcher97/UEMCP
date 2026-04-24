# T-1b Worker — Fixture-philosophy migration for full-package tests

> **Dispatch**: Fresh Claude Code session. **Parallel-safe** with Phase 3 audit worker (both read server/*, audit writes docs/audits/* only). Zero collision.
> **Type**: Implementation — per-test decision + migration from live ProjectA fixtures to synthetic or engine-stable fixtures where feasible.
> **Duration**: 2-3 sessions per T-1a worker's feasibility estimate (D73).
> **D-log anchors**: D73 (T-1a landed; feasibility notes for T-1b), D71 (CL-1 drift trigger), D75 (second drift recurrence on BP_OSControlPoint), Noah orchestrator feedback 2026-04-22 (fixture philosophy principle).
> **Deliverable**: per-test migration to drift-proof fixtures where effort vs value justifies; documented rationale where project-specific fixtures are retained; updated test files + potentially new `test-fixtures.mjs` synthetic helper module.

---

## Mission

Per Noah's 2026-04-22 feedback + two recurrent drift incidents (D71 + D75), project-specific ProjectA fixtures are a maintenance tax. T-1a validated the synthetic approach for the easiest tier (L2.5 TArray<ObjectProperty>). T-1b extends the migration to the remaining project-coupled tests, each requiring a per-test call on:

- **Synthetic** — hand-construct bytes; zero external dependency; 3-5× T-1a effort per test for full-package tests (name tables + import/export tables + AR blobs).
- **Engine-stable** — UE 5.6 `Engine/Content/*.uasset` files; stable across UE point release; requires UE install but not project-specific.
- **Keep project-specific** (explicit dev-time-only framing) — document in test file header that assertions against ProjectA paths are intentional and may drift; not for CI / onboarding reproducibility.

Per-test decision matrix: whatever's cheapest for the test's actual intent. Don't force synthetic where engine-stable works; don't force engine-stable where project-specific is semantically necessary.

---

## Scope — in

### §1 Target files

Three test files identified by T-1a worker as candidates (D73):

1. **`server/test-phase1.mjs`** — broad offline-tool smoke test; 316 assertions. Mixed fixture dependencies; survey each failing-on-edit assertion.
2. **`server/test-query-asset-registry.mjs`** — bulk AR scan + pagination + tag filtering (16 assertions). Reads full ProjectA AR.
3. **`server/test-inspect-and-level-actors.mjs`** — inspect_blueprint + list_level_actors export-table walking (30 assertions).

Optional stretch: **`server/test-offline-asset-info.mjs`** (15 assertions) if it fits in session budget.

### §2 Per-test decision methodology

For each test file:

1. **Inventory live-fixture dependencies**: grep for ProjectA paths (`Content/Blueprints/`, `Content/Core/`, `/Game/`), asset-registry bytes reads, specific BP node counts, specific actor counts.
2. **Classify each assertion**:
   - **Byte-level decode** (e.g., "parses FProperty of type X correctly") → **synthetic** (byte-construct just enough shape to exercise the code path)
   - **Catalog / scan behavior** (e.g., "AR returns >0 BP entries with tag X") → **engine-stable** (use engine fixtures which have some BPs with common tags) OR **structural-only** (assert `>= N`, not `== N`)
   - **Project-specific semantic** (e.g., "BP_OSPlayerR has an exec chain from BeginPlay to TakeDamage") → **keep project-specific**, document intent in test-file header
3. **Execute migration** per classification. Target: reduce drift-prone hardcoded values by ≥70% across the three files.

### §3 Synthetic helper extraction

If multiple tests end up hand-rolling similar minimal package shapes (FPackageFileSummary + name table + 1 export + AR blob), factor into a shared helper in a new `server/test-fixtures.mjs` module. Pattern T-1a established in `test-uasset-parser.mjs` helpers (pseudo-tags + pseudo-resolvers) is the reference.

Keep helpers scoped to test infra only — do NOT expose from production modules. Shared helper file can export:
- `buildSyntheticPackage({ name, exports, importPaths, arTags })` → returns Uint8Array
- `buildSyntheticARRegistry({ packagesByClass })` → returns AR-shaped JSON
- `buildSyntheticLevelMap({ actors })` → returns Uint8Array for .umap

Keep synthetic helpers simple. If a test needs fidelity beyond the helpers, that's a signal the test isn't a good synthetic candidate — fall back to engine-stable or project-specific-documented.

### §4 Engine-stable-fixture survey

For tests that don't fit synthetic cleanly, check if UE 5.6 `Engine/Content/*.uasset` provides usable alternatives:

- `Engine/Content/EditorBlueprintResources/*.uasset` — editor BP samples
- `Engine/Content/FunctionalTesting/*.uasset` — testing BPs designed for UE validation
- `Engine/Plugins/*/Content/*.uasset` — plugin content BPs
- `Engine/Content/Characters/Mannequin/*.uasset` — typically has AnimBP samples (if shipped with 5.6)

Test expected values against these become stable-across-UE-point-release. Document the UE version in test-file header.

### §5 Project-specific retention — document intent

For assertions you keep project-specific (e.g., "BP_OSPlayerR exists"), update the test-file header comment to explicitly state:

```js
// PROJECT-SPECIFIC FIXTURE DEPENDENCY:
// This suite references ProjectA-specific assets (BP_OSPlayerR, etc.). Expected
// values may drift when ProjectA content is refactored. Drift symptoms: assertion
// count/value mismatches that reproduce on clean HEAD.
// Fix pattern: regenerate oracle via DumpBPSidecarCommandlet or update hardcoded
// expected values. See D71 / D75 for prior drift incident handling.
```

This is the Tier-3 "keep but frame honestly" option from Noah's 2026-04-22 guidance.

---

## Scope — out

- **test-s-b-base-differential.mjs** — D77-confirmed keep-project-specific (Oracle-A bytes inherently want real-world BP complexity; this is differential-truth territory).
- **test-verb-surface.mjs** — Verb-surface already uses Oracle fixtures + synthetic patterns appropriately per D72; don't regress.
- **test-rc-wire.mjs** — pure wire-mock; no fixture dependency.
- **test-uasset-parser.mjs** L2.5 — T-1a already migrated (D73).
- **test-mcp-wire.mjs**, **test-mock-seam.mjs**, **test-tcp-tools.mjs** — no project-specific fixtures; out of scope.
- **Oracle-A-v3 against engine BPs** — that's T-1c, separate larger scope.
- **Fixture binary refresh / regen** — not T-1b scope (no `.uasset` or `.oracle.json` edits).

---

## Reference files

### Tier 1 — Scope sources
1. `docs/tracking/risks-and-decisions.md` D73 (T-1a landing + feasibility notes) + D71 + D75 (drift incidents).
2. `docs/tracking/backlog.md` T-1 section (three-tier fixture philosophy documented).

### Tier 2 — T-1a pattern reference
3. `server/test-uasset-parser.mjs` lines 1238-1292 — synthetic container helpers pattern T-1a extended.
4. T-1a commit `525d7843` — the L2.5 synthetic migration; read for approach patterns.

### Tier 3 — Migration target files
5. `server/test-phase1.mjs` (316 assertions)
6. `server/test-query-asset-registry.mjs` (16 assertions)
7. `server/test-inspect-and-level-actors.mjs` (30 assertions)
8. Optional: `server/test-offline-asset-info.mjs` (15 assertions)

### Tier 4 — Parser internals (for hand-roll reference)
9. `server/uasset-parser.mjs` — FPackageFileSummary + AR blob shapes.

---

## Success criteria

1. Per-test decision documented for every currently-project-specific assertion.
2. Migrated to synthetic / engine-stable where effort/value justifies; target ≥70% drift-prone assertions drift-proofed.
3. Retained project-specific assertions have explicit header comment stating intent + drift-fix pattern.
4. Full test rotation stays green: 1203 passing / 0 failing (± small assertion count drift, document in commit).
5. New `server/test-fixtures.mjs` helper module if multiple tests share synthetic package shape (optional — don't force if one test suffices).
6. Path-limited commits per D49: `server/test-*.mjs` + optional new `server/test-fixtures.mjs` only.

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **Path-limited commits per D49** — `server/test-*.mjs` + optional `server/test-fixtures.mjs`.
- **No changes to production modules**: uasset-parser.mjs, offline-tools.mjs, tcp-tools.mjs, etc.
- **No fixture binary edits**: `.uasset`, `.oracle.json`, `.umap`.
- **No AI attribution**.
- **Checkpoint commits OK** — one per target test file or one per synthetic helper extraction is fine.
- **2-3 sessions expected** per D73 feasibility; if running long, ship partial migration Session 1, finish Session 2.

---

## Final report to orchestrator

Report (under 200 words):
1. Commit SHA(s).
2. Per-file migration summary table: test file → pre-count project-specific / post-count / approach used (synthetic / engine / kept-specific).
3. Drift-surface reduction metric: how many hardcoded project-specific expected values did you eliminate? (As a proxy for future-drift-prevention.)
4. Synthetic helper module extracted yes/no; if yes, brief API summary.
5. Any test that surprised you (harder to migrate than expected, easier than expected, or exposed a genuine parser bug).
6. Recommended T-1c status: does moving Oracle-A to engine BPs still look valuable, or is current fixture health post-T-1b sufficient?
7. Next action: orchestrator folds T-1b shipped into backlog; any M-enhance CL-1-style cleanup follow-ons needed.
