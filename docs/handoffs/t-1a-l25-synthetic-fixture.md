# T-1a Worker — test-uasset-parser L2.5 synthetic fixture

> **Dispatch**: Fresh Claude Code session. **Zero file-level collision** with in-flight M-enhance worker (M-enhance touches many files but NOT `server/test-uasset-parser.mjs`). Dispatch NOW.
> **Type**: Cleanup — replace live-fixture dependency with hand-constructed synthetic bytes. Pure test-file edit; no parser/tool changes.
> **Duration**: 30-45 min.
> **D-log anchors**: D71 (CL-1 fixture swap BP_OSPlayerR → BP_OSPlayerR_VikramProto as tactical fix), Noah orchestrator feedback 2026-04-22 (fixture philosophy: UEMCP shouldn't rely on static project).
> **Deliverable**: `test-uasset-parser.mjs` L2.5 TArray<ObjectProperty> decode test rebuilt on synthetic byte fixtures; Vikram proto dependency removed.

---

## Mission

Per Noah's 2026-04-22 orchestrator feedback: **UEMCP tool tests shouldn't rely on a static ProjectA project snapshot.** Project-specific fixtures drift as gameplay teams refactor (proven empirically when CL-1 had to swap from `BP_OSPlayerR` → `BP_OSPlayerR_VikramProto` after the former lost `DefaultAbilities`/`DefaultEffects` in a loadouts-system refactor).

L2.5 in `test-uasset-parser.mjs` is **pure byte-level decode testing** for `TArray<ObjectProperty>` decoding. Its intent is exercising the parser's TArray-of-soft-object-path code path — NOT validating ProjectA content. Ideal candidate for synthetic fixtures.

Build a hand-constructed byte buffer representing a minimal UObject CDO with `TArray<ObjectProperty>` fields. Parse it with the same parser functions used against live `.uasset` files. Assert decode correctness. Zero external dependency.

---

## Scope — in

### §1 Identify current L2.5 shape

Read `server/test-uasset-parser.mjs` around the L2.5 section (look for "Level 2.5" or "L2.5" comments; these mark the test group). CL-1 (commit `1f0dd69`) updated it to reference:
- Fixture path: `Content/WwiseAudio/Blueprints/BP_OSPlayerR_VikramProto.uasset`
- Expected `DefaultAbilities.length`: 10
- Expected `DefaultEffects.length`: 3
- CDO export name: `Default__BP_OSPlayerR_VikramProto_C`

### §2 Construct synthetic bytes

Build a minimal `.uasset`-shaped byte buffer sufficient to exercise the `TArray<ObjectProperty>` code path. You have two reasonable approaches:

**Approach A — Pre-existing synthetic infrastructure**:
`test-uasset-parser.mjs` already has "synthetic container coverage" per CLAUDE.md §Testing. Check if existing helpers (`buildSyntheticPackage`, `buildSyntheticExport`, or similar — grep the file) can be extended with a UObject whose FProperty stream includes `TArray<ObjectProperty>`. Reuse over reinvent.

**Approach B — Hand-roll from scratch**:
If no reusable synthetic helper exists, construct from primitives:
- FPackageFileSummary header (minimal valid — name count, import/export counts, offsets)
- NameMap with names for: `Default__MyTestObject_C`, `DefaultAbilities`, `DefaultEffects`, `ArrayProperty`, `ObjectProperty`, `SoftObjectProperty` (whatever the real objects use)
- One UObject export
- UObject's tagged UPROPERTY stream:
  - `DefaultAbilities` FPropertyTag with Type=`ArrayProperty`, InnerType=`ObjectProperty`, ArrayDim=1, Size=X
  - Array count (int32), then N × FPackageIndex (soft-obj) entries
  - `DefaultEffects` same pattern
  - `None` terminator

Reference existing parser internals via `server/uasset-parser.mjs` for exact byte offsets. The D50 tagged-fallback iterator is the decode path you're feeding.

Keep the synthetic buffer in-source as a `Uint8Array` hex literal OR construct via `Buffer.concat` from sub-builders. Whichever reads cleaner.

### §3 Assertions

Replace the live-fixture asserts with synthetic-equivalent:
- `DefaultAbilities` returns `TArray` with expected count
- `DefaultAbilities` elements are `ObjectProperty` / `SoftObjectProperty` shape
- `DefaultEffects` returns TArray with expected count
- Error paths (zero-length array, invalid tag type) optionally covered — nice-to-have, not required

Keep total assertion count equivalent (currently L2.5 produces 4 asserts; maintain ~4 with synthetic or document if count changes).

### §4 Remove Vikram proto dependency

After synthetic asserts pass, delete any remaining reference to `BP_OSPlayerR_VikramProto` in L2.5. The sibling fixture is no longer needed for this test.

**Do NOT delete Vikram proto from ProjectA** — it's a P4-tracked game asset, not yours to remove. Only remove the JS test's reference to it.

### §5 Regression check

Run full test rotation — all 9 files should stay green. L2.5 count may shift slightly ±2 assertions; document the delta in your commit message.

---

## Scope — out

- **Other test files** — T-1b audits those separately. Don't touch `test-phase1.mjs`, `test-offline-asset-info.mjs`, etc.
- **Parser changes** — your job is replacing a fixture; parser code stays as-is. If the synthetic bytes expose a real parser bug, surface to orchestrator rather than fixing inline.
- **Oracle-A regeneration** — different worker, different scope (T-1c, deferred).
- **M-enhance scope** — do NOT edit `server/tcp-tools.mjs`, `server/connection-manager.mjs`, `plugin/*`, `tools.yaml`, or any M-enhance-owned file.
- **Fixture binary files** — do not delete, move, or modify any `.uasset` or `.oracle.json` on disk.

---

## Reference files

### Tier 1 — Scope sources
1. `docs/tracking/risks-and-decisions.md` D71 (CL-1 fixture swap context) + orchestrator 2026-04-22 feedback in D72 section (principle statement).
2. `docs/tracking/backlog.md` T-1 entry (three-tier fixture philosophy: synthetic / engine-stable / project-specific).

### Tier 2 — Code
3. `server/test-uasset-parser.mjs` — the file you edit. Read L2.5 + existing synthetic helpers.
4. `server/uasset-parser.mjs` — parser internals for byte-offset reference. Do not modify.

### Tier 3 — UE 5.6 byte-format reference (if hand-rolling)
5. Existing parser's `readFObjectExport`, `readPropertyTag`, `readName` — understand the shape you're constructing.
6. CUE4Parse / UAssetAPI `FPropertyTag.cs` — reference for tag layout if ambiguity.

---

## Success criteria

1. L2.5 tests no longer reference `BP_OSPlayerR_VikramProto` or any ProjectA path.
2. Synthetic fixture exercises the `TArray<ObjectProperty>` decode path equivalently.
3. All L2.5 assertions pass against synthetic bytes.
4. Full test rotation stays green: 1052 passing / 0 failing (or the new count with your minor ± delta).
5. Path-limited commit per D49: `server/test-uasset-parser.mjs` only.
6. Commit message documents assertion-count delta + the specific synthetic-fixture technique (approach A or B).

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **Path-limited commits per D49** — scope strictly to `server/test-uasset-parser.mjs`.
- **No AI attribution**.
- **`UNREAL_PROJECT_ROOT` env var** — synthetic test shouldn't need it for the L2.5 path specifically, but the rest of test-uasset-parser.mjs does. Rotation expects the env var set.
- **Single commit preferred**.

---

## Final report to orchestrator

Report (under 150 words):
1. Commit SHA.
2. Which synthetic-construction approach chosen (A — extend existing helper / B — hand-roll) + rationale.
3. L2.5 assertion count delta: pre → post (4 asserts currently; expected similar post-fix).
4. Full test count pre → post.
5. Any parser-side bug surfaced by the synthetic bytes (expected: none; surface if found).
6. Does T-1b (other live-fixture tests) seem like a clear-cut similar pattern, or do those tests have harder-to-synthesize shapes (AR-scan bytes, level-actor parsing)? Note for future T-1b worker.
