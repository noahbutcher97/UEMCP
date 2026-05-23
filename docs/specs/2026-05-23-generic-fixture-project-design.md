# Generic NDA-safe fixture project — Phase 1 (text-only)

**Date:** 2026-05-23
**Status:** Design approved; spec finalized (gap-hunt + enumeration pass 2026-05-23) — ready for implementation planning
**Scope:** Phase 1 of a two-phase effort. Phase 2 (binary asset fixtures) is a separate spec.

## Problem

The test rotation (`server/run-rotation.mjs`) is only fully green when `UNREAL_PROJECT_ROOT`
points at a real UE project containing a `.uproject`. On a project-less environment (a bare
GitHub runner, a fresh checkout), project-gated assertions either skip or — until the
skip-normalization shipped 2026-05-23 — hard-failed. We cannot put a real project on a public
CI runner (NDA, licensed engine, binary size), so CI currently can only run the subset of the
suite that needs no project.

We want a **generic, NDA-safe fixture project** committed to the repo so the rotation can
exercise the project-gated *offline* tools without any private project — usable identically
locally and in CI.

### Key constraint (discovered empirically 2026-05-23)

Simply pointing `UNREAL_PROJECT_ROOT` at a text-only fixture is not enough: setting the env var
is the trigger for **all** project-gated assertions, including ones that read **binary** assets
(`get_asset_info`, `inspect_blueprint`, the parser byte-accurate tests). Against a text-only
fixture those activate and fail because no `.uasset` exists. Therefore Phase 1 must also convert
the binary-asset assertions to gate on **asset existence** (skip when the specific asset is
absent) rather than on `UNREAL_PROJECT_ROOT` presence. This is the pattern `test-offline-asset-info`
already uses per-function.

These existing byte-accurate assertions check *specific values from specific real assets* (e.g.
`BPGA_Block`'s `IsBlocking` gameplay-tag CDO default). Gated on their real asset path, they run
only when a real project supplies that asset and skip otherwise — including against the text
fixture. **This is not a literal Phase-2 drop-in**: a generic Phase-2 asset has different values,
so Phase 2 adds *separate* generic-path assets plus new/genericized assertions; it does not simply
re-activate these real-asset assertions. (The real asset paths are already present in committed
`test-fixtures.mjs`, so referencing them in the Phase-1 guards introduces no new project-structure
leak.)

## Non-goals (deferred to Phase 2)

- Binary `.uasset` / `.umap` fixtures (need a UE editor session or a synthetic `.uasset` writer).
- Genericizing `test-fixtures.mjs` pinned expected values (`GAS_ABILITY_BP`, `exportCount=3`,
  tag-path constants) — those pin to real serialized assets and only matter once binary fixtures
  exist.
- Covering live `TCP:55558` tests or the C++ plugin build (out of scope for any offline CI).

## Approach

Reuse `UNREAL_PROJECT_ROOT` pointed at a committed text fixture, with a shared
`resolveProjectRoot()` helper (used by both the test files and `run-rotation.mjs`) defaulting to
the fixture when the env var is unset (a real project always wins). See §2 for why the default
must be shared rather than runner-only.

Alternatives considered and rejected:
- **CI-only wiring** (set the env var only in the workflow): less coverage; local `npm test`
  keeps skipping project-gated tests for no benefit. The asset-existence gating work is identical
  either way, so default-everywhere costs one extra line for strictly more coverage.
- **Separate `UEMCP_FIXTURE_ROOT` env var**: doubles the gating check in every project-gated
  test for no real isolation benefit over reusing the existing var.

## Components

### 1. The fixture — `server/fixtures/uemcp-fixture/`

Generic name, zero NDA tokens (the PreToolUse codename hook + pre-commit gate enforce this).
All text; no binary assets.

- `UEMCPFixture.uproject` — minimal JSON: `FileVersion`, `EngineAssociation: "5.6"`, and a
  `Plugins` array sufficient for `list_plugins`.
- `Config/DefaultGameplayTags.ini` — synthetic tag hierarchy with ≥2 top-level segments and
  nesting, sized to satisfy the *structural* gameplay-tag assertions (list returns tags,
  glob `**` returns all, `firstSegment.**` returns a proper subset).
- `Config/DefaultEngine.ini` — a few synthetic sections/keys for `list_config_values`.
- `Source/UEMCPFixture.Target.cs` — minimal synthetic target so `get_build_config` (Target.cs
  parsing) runs. Text, so authorable now.

The exact tag/config/target contents are tuned during implementation by running the affected
assertions against the fixture until they pass.

### 2. Shared `resolveProjectRoot()` — the default mechanism

The fixture default must apply both to `npm test` (via `run-rotation.mjs`) AND to direct
single-file invocation (`node test-phase1.mjs`), which CLAUDE.md documents as a normal iteration
workflow. If the default lived only in the runner, direct invocation would skip project-gated
tests while `npm test` ran them — defeating the local==CI consistency that motivates this design.

So the default lives in a **shared helper** `resolveProjectRoot()` in `test-helpers.mjs`:

```js
// returns a non-empty UNREAL_PROJECT_ROOT, else the absolute fixture path
// (resolved from test-helpers.mjs's own location, not cwd).
export function resolveProjectRoot() { ... }
```

Every test file that currently reads `process.env.UNREAL_PROJECT_ROOT` adopts it
(`const PROJECT_ROOT = resolveProjectRoot()`), so direct invocation and the runner behave
identically. `run-rotation.mjs` additionally sets `process.env.UNREAL_PROJECT_ROOT` for its
subprocesses as belt-and-suspenders (covers any code path that reads the env var directly). A
real `UNREAL_PROJECT_ROOT` always takes precedence.

**Adoption set** (verified by `grep -lE "process\.env\.UNREAL_PROJECT_ROOT" test-*.mjs`):
`test-phase1`, `test-mcp-wire`, `test-offline-asset-info`, `test-query-asset-registry`,
`test-inspect-and-level-actors`, `test-verb-surface`, `test-uasset-parser`,
`test-s-b-base-differential`. `test-m1-ping` also reads it but is live-editor-gated and excluded
from the rotation — leave it untouched.

### 3. Asset-existence gating normalization

The principle: binary-asset-dependent assertions gate on the **specific asset file existing**, not
on `UNREAL_PROJECT_ROOT` presence — matching the existing `exists(path)` pattern. Under the
fixture (no assets), they skip; under a real project supplying the asset, they run. The adoption
set splits into three categories by how much work each needs:

**(a) Needs structural change — whole-file `!ROOT` skip → per-asset `exists()` gating.** These
currently skip the whole file when `!ROOT`; under a fixture `ROOT` that guard stops firing, so
each asset-reading section must gain its own `exists()` guard (or empty-result tolerance):
- `test-query-asset-registry.mjs`, `test-inspect-and-level-actors.mjs`, `test-verb-surface.mjs`
- `test-phase1.mjs` — the asset-backed block (Tests 3 / 9–14 + M-spatial): F0/F2 `get_asset_info`,
  `inspect_blueprint`, the gameplay-tag-on-CDO assert. (Note: test-phase1's *other* `PROJECT_ROOT`
  block — project_info, gameplay-tags, list_plugins, list_data_sources, get_build_config,
  list_config_values, datatable/stringtable validation, dropped-tools — is all **structural** and
  is *satisfied* by the fixture, not gated. Verified by enumeration 2026-05-23.)

**(b) Already `exists()`-gated — verify only, no structural change.** Every asset section already
guards on `exists(path)`, so a fixture `ROOT` (asset-less) makes them skip cleanly:
- `test-offline-asset-info.mjs` (per-function `exists()`; `testMissingAsset` passes against a real
  `.uproject` root — expected "Asset not found")
- `test-uasset-parser.mjs` (synthetic tests run; fixture-asset sections skip on `exists()`)
- `test-s-b-base-differential.mjs` (all oracle/asset sections skip on `exists()`)

**(c) Newly activates against the fixture — verify it passes.**
- `test-mcp-wire.mjs` — the happy-path else-branch (`project_info` smoke against a real handler)
  now runs against the fixture. Confirm valid shape and that no else-branch assertion pins to a
  value the synthetic fixture cannot satisfy.

**Decision rule for value-pinned assertions:** if any assertion the fixture is *meant* to satisfy
turns out pinned to a real-content value (rather than structural), gate it on real-project
presence (skip against the fixture) — same treatment as the asset assertions. Do **not** contort
the fixture to match a real value. Enumeration on 2026-05-23 found test-phase1's structural block
already clean; this rule covers the gameplay-glob edge case and any surprise during implementation.

### 4. CI workflow

No change required beyond what already exists (`.github/workflows/rotation.yml`). Because
`run-rotation.mjs` defaults to the fixture, the workflow inherits it — no env block needed.

### 5. `.gitignore` guard for future generated dirs

The existing `Binaries/`, `Intermediate/`, `DerivedDataCache/` ignore rules are scoped to
`plugin/**` only. Add fixture-scoped rules now so that if the fixture is ever opened in an
editor (Phase 2), its generated `Binaries/` / `Intermediate/` / `Saved/` / `DerivedDataCache/`
are not accidentally committed:

```
server/fixtures/**/Binaries/
server/fixtures/**/Intermediate/
server/fixtures/**/Saved/
server/fixtures/**/DerivedDataCache/
```

The committed text fixture (`.uproject`, `Config/`, `Source/`) is NOT ignored — only generated
output is.

### 6. Documentation update — CLAUDE.md Testing section

The CLAUDE.md Testing section frames `test-phase1` as "Primary Rotation (no env needed)" and the
supplementary files as requiring `UNREAL_PROJECT_ROOT`. The fixture-default changes that contract:
the project-gated offline assertions now run everywhere against the committed fixture, and the
aggregate assertion counts shift. Update the Testing section to document the fixture project, the
`run-rotation.mjs` env-default behavior (real project wins), and the revised primary/supplementary
framing.

## Coverage delta

Newly exercised everywhere (local + CI), against the generic fixture (all confirmed structural by
enumeration 2026-05-23):
- offline toolset auto-enable / disable / re-enable
- `project_info`, `list_plugins`
- gameplay-tag list / search / glob (structural — count-equality, not value-pinned)
- `list_data_sources` (shape check; `fileCount: 0` / `entries: []` satisfies it)
- `list_config_values`, `get_build_config`
- `read_datatable_source` / `read_string_table_source` traversal/non-csv rejection (validation —
  fixture-root-independent)

Still skipped until Phase 2 (gate on absent binary assets):
- `get_asset_info`, `inspect_blueprint`, parser byte-accurate tests

## Testing / validation plan

1. No-env rotation (`node run-rotation.mjs`) → green, exit 0, with the newly-covered assertions
   running against the fixture (not skipped).
2. Direct-invocation parity (gap-driven): `node test-phase1.mjs` with no env picks up the fixture
   via `resolveProjectRoot()` and runs the same project-gated assertions as the runner — proving
   local==CI consistency holds for single-file iteration, not just `npm test`.
3. Explicit fixture path (`UNREAL_PROJECT_ROOT=<fixture> node run-rotation.mjs`) → identical green.
4. Real-project precedence: a non-empty `UNREAL_PROJECT_ROOT` overrides the default (verify the
   resolver does not clobber a set value).
5. CI scenario parity: confirm the exact workflow command passes on a checkout with no project.
6. Assertion-count sanity: the newly-covered assertions move from skipped to passed; no file
   drops to 0/0 unexpectedly (FAIL-LOUD silent-zero guard stays satisfied).

## Risks

- **Fixture drift vs assertions**: the synthetic tag/config/target content must satisfy the
  structural assertions. Enumeration 2026-05-23 confirmed test-phase1's project-gated structural
  block is all shape/truthy/count-equality (not value-pinned), so generic content suffices. The
  one nuance is the gameplay-glob assert (`firstSegment.**` matchCount must equal the count under
  that segment) — the fixture tag hierarchy is designed to compute correctly, and the §3 decision
  rule covers any residual value-pinning. `get_build_config` may need a minimal `.Build.cs`
  alongside the `Target.cs`; tuned during implementation.
- **Over-skipping**: a too-aggressive asset-existence guard could silently skip an assertion that
  should run. Mitigated by gating on the *specific* asset path each assertion already references,
  and by validation step 5.
- **NDA**: fixture must contain only generic names. Mitigated structurally by the PreToolUse
  codename hook + pre-commit gate.

## Phase 2 preview (separate spec)

Bring asset/parser coverage to CI. This is *additive*, not a relabel of Phase 1's real-asset
assertions (those stay gated on their real asset paths, running only with a real project):

- Author generic binary `.uasset` / `.umap` fixtures at **generic** paths (editor-authored in a
  throwaway generic project, or via a synthetic `.uasset` writer).
- Add new generic-path assertions (or a genericized `test-fixtures.mjs` variant) whose expected
  values match the generic assets — since a generic asset's serialized values differ from the
  real assets', the assertions must be authored against the generic fixture, not inherited.
- Decide the authoring path (editor session on a dev machine vs a synthetic `.uasset` writer) as
  part of that spec.
