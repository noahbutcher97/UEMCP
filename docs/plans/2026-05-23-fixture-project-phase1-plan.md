# Fixture Project Phase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic, NDA-safe text fixture UE project so the test rotation exercises the project-gated *offline* tools (project_info, gameplay-tags, list_plugins, list_data_sources, get_build_config, list_config_values) with no private project — identically locally and in CI.

**Architecture:** A committed `server/fixtures/uemcp-fixture/` (text-only: `.uproject` + `Config/*.ini` + `Source/*.Target.cs`). A shared `resolveProjectRoot()` in `test-helpers.mjs` returns `UNREAL_PROJECT_ROOT` if set, else the fixture path. Only the two fixture-*satisfied* test files (`test-phase1`, `test-mcp-wire`) adopt it; `test-phase1`'s binary-asset block gates on a real asset existing so it skips against the fixture.

**Tech Stack:** Node.js ESM (`.mjs`), the existing `run-rotation.mjs` harness, `test-helpers.mjs`.

**Spec:** `docs/specs/2026-05-23-generic-fixture-project-design.md`

**Branch:** `claude-automations-ci-fixture-spec` (already checked out; the spec + earlier work are committed there).

> **Design note (matches spec §2/§3 as of 2026-05-23):** Only `test-phase1` + `test-mcp-wire`
> adopt `resolveProjectRoot()` — the two files the fixture *satisfies*. The six pure-asset files
> keep reading `process.env.UNREAL_PROJECT_ROOT` directly and keep their skip-when-unset behavior
> (the fixture ships no binary assets for them). There is **no** runner-side env injection (the
> offline tools take `projectRoot` as a parameter and never read `process.env`). Net: structural
> gating work is `test-phase1`'s asset block only.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `server/fixtures/uemcp-fixture/UEMCPFixture.uproject` | makes `checkOfflineAvailable` true; feeds `project_info` / `list_plugins` | Create |
| `server/fixtures/uemcp-fixture/Config/DefaultGameplayTags.ini` | feeds `list_gameplay_tags` / `search_gameplay_tags` | Create |
| `server/fixtures/uemcp-fixture/Config/DefaultEngine.ini` | feeds `list_config_values` | Create |
| `server/fixtures/uemcp-fixture/Source/UEMCPFixture.Target.cs` | feeds `get_build_config` (real parse path) | Create |
| `server/test-helpers.mjs` | add `resolveProjectRoot()` | Modify |
| `server/test-phase1.mjs` | adopt resolver; gate asset block | Modify |
| `server/test-mcp-wire.mjs` | adopt resolver | Modify |
| `.gitignore` | ignore fixture's future generated dirs | Modify |
| `.githooks/pre-commit` | allow-list `UEMCPFixture` (quiet pattern-warning) | Modify |
| `CLAUDE.md` | Testing-section update | Modify |

---

## Task 1: Create the text fixture

**Files:**
- Create: `server/fixtures/uemcp-fixture/UEMCPFixture.uproject`
- Create: `server/fixtures/uemcp-fixture/Config/DefaultGameplayTags.ini`
- Create: `server/fixtures/uemcp-fixture/Config/DefaultEngine.ini`
- Create: `server/fixtures/uemcp-fixture/Source/UEMCPFixture.Target.cs`

- [ ] **Step 1: Create the `.uproject`**

`server/fixtures/uemcp-fixture/UEMCPFixture.uproject`:
```json
{
	"FileVersion": 3,
	"EngineAssociation": "5.6",
	"Category": "",
	"Description": "Generic NDA-safe fixture project for UEMCP offline-tool tests.",
	"Plugins": [
		{ "Name": "RemoteControl", "Enabled": true },
		{ "Name": "PythonScriptPlugin", "Enabled": true }
	]
}
```

- [ ] **Step 2: Create `Config/DefaultGameplayTags.ini`**

The first tag's first segment is `Fixture`; three tags start with `Fixture.`, so the glob test (`Fixture.**` matchCount must equal 3) is deterministic.
```ini
[/Script/GameplayTags.GameplayTagsSettings]
+GameplayTagList=(Tag="Fixture.Combat.Block",DevComment="synthetic fixture tag")
+GameplayTagList=(Tag="Fixture.Combat.Parry",DevComment="synthetic fixture tag")
+GameplayTagList=(Tag="Fixture.State.Stunned",DevComment="synthetic fixture tag")
+GameplayTagList=(Tag="Audio.SFX.Footstep",DevComment="synthetic fixture tag")
```

- [ ] **Step 3: Create `Config/DefaultEngine.ini`**

```ini
[/Script/EngineSettings.GeneralProjectSettings]
ProjectName=UEMCPFixture
ProjectVersion=1.0.0

[/Script/Engine.Engine]
bSmoothFrameRate=true
```

- [ ] **Step 4: Create `Source/UEMCPFixture.Target.cs`**

`get_build_config` extracts `Type = TargetType.<X>`; this gives it a real parse target.
```csharp
using UnrealBuildTool;
using System.Collections.Generic;

public class UEMCPFixtureTarget : TargetRules
{
	public UEMCPFixtureTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.V5;
		ExtraModuleNames.Add("UEMCPFixture");
	}
}
```

- [ ] **Step 5: Verify the fixture parses as a project**

Run: `cd server && UNREAL_PROJECT_ROOT="$(pwd)/fixtures/uemcp-fixture" node -e "import('./offline-tools.mjs').then(async m => { console.log(JSON.stringify(await m.executeOfflineTool('project_info', {}, process.env.UNREAL_PROJECT_ROOT))) })"`
Expected: JSON with a non-empty `projectName` (e.g. `"UEMCPFixture"`), exit 0.

- [ ] **Step 6: Commit**

```bash
git add server/fixtures/uemcp-fixture/
git commit -m "Add generic NDA-safe text fixture project (uemcp-fixture)"
```

---

## Task 2: Add `resolveProjectRoot()` to `test-helpers.mjs`

**Files:**
- Modify: `server/test-helpers.mjs`

- [ ] **Step 1: Add the imports (if not already present at the top of the file)**

```js
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
```

- [ ] **Step 2: Add the helper (export, near the other exports)**

```js
// Absolute path to the committed text fixture (resolved from THIS file's
// location, not cwd), used as the default project root for tests when
// UNREAL_PROJECT_ROOT is unset. A real project always wins.
const FIXTURE_PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'uemcp-fixture');

/**
 * Resolve the project root for tests: a non-empty UNREAL_PROJECT_ROOT, else the
 * committed fixture. Mirrors the trim() the test files used to apply inline.
 * @returns {string}
 */
export function resolveProjectRoot() {
  const env = (process.env.UNREAL_PROJECT_ROOT || '').trim();
  return env || FIXTURE_PROJECT_ROOT;
}
```

- [ ] **Step 3: Write a failing unit test**

Add to `server/test-mock-seam.mjs` (a non-project-gated file already in the primary rotation) near its other helper tests:
```js
// resolveProjectRoot: env wins; fixture is the fallback
{
  const { resolveProjectRoot } = await import('./test-helpers.mjs');
  const saved = process.env.UNREAL_PROJECT_ROOT;
  process.env.UNREAL_PROJECT_ROOT = '';
  assert(resolveProjectRoot().endsWith('uemcp-fixture'), 'resolveProjectRoot falls back to fixture when unset');
  process.env.UNREAL_PROJECT_ROOT = '/some/real/proj';
  assert(resolveProjectRoot() === '/some/real/proj', 'resolveProjectRoot returns env when set');
  if (saved === undefined) delete process.env.UNREAL_PROJECT_ROOT; else process.env.UNREAL_PROJECT_ROOT = saved;
}
```
(Use whatever `assert` helper that file already uses; match its style.)

- [ ] **Step 4: Run it**

Run: `cd server && node test-mock-seam.mjs`
Expected: PASS (the 2 new assertions included), exit 0.

- [ ] **Step 5: Commit**

```bash
git add server/test-helpers.mjs server/test-mock-seam.mjs
git commit -m "Add resolveProjectRoot() test helper (env or committed fixture)"
```

---

## Task 3: Adopt `resolveProjectRoot()` in `test-mcp-wire` (no asset block)

`test-mcp-wire` has no binary-asset block, so adopting the resolver makes it green against the
fixture immediately — it is its own commit.

**Files:**
- Modify: `server/test-mcp-wire.mjs`

- [ ] **Step 1: Import and use the resolver**

Change the line-33 import from:
```js
import { TestRunner } from './test-helpers.mjs';
```
to:
```js
import { TestRunner, resolveProjectRoot } from './test-helpers.mjs';
```
Replace line 38 (`const PROJECT_ROOT = process.env.UNREAL_PROJECT_ROOT || '';`):
```js
const PROJECT_ROOT = resolveProjectRoot();
```

- [ ] **Step 2: Run with NO env**

Run: `cd server && node test-mcp-wire.mjs`
Expected: PASS, exit 0 — the happy-path else-branch now runs `project_info` against the fixture
(`projectName` = `"UEMCPFixture"`, valid shape).

- [ ] **Step 3: Commit**

```bash
git add server/test-mcp-wire.mjs
git commit -m "Adopt resolveProjectRoot() in test-mcp-wire"
```

---

## Task 4: Adopt the resolver in `test-phase1` AND gate its asset blocks (one commit)

`test-phase1` adopts the resolver *and* contains binary-asset blocks. Both changes must land in the
**same commit** so the file is never committed in a broken state (resolver pointing at the fixture
while asset blocks still run unconditionally).

**Files:**
- Modify: `server/test-phase1.mjs`

- [ ] **Step 1: Adopt the resolver**

Change the line-38 import from:
```js
import { ErrorTcpResponder } from './test-helpers.mjs';
```
to:
```js
import { ErrorTcpResponder, resolveProjectRoot } from './test-helpers.mjs';
```
Replace line 54 (`const PROJECT_ROOT = (process.env.UNREAL_PROJECT_ROOT || '').trim();`):
```js
const PROJECT_ROOT = resolveProjectRoot();
```

- [ ] **Step 2: Add `stat` to the `node:fs/promises` import (line 22)**

Change line 22 from:
```js
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
```
to:
```js
import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
```

- [ ] **Step 3: Add the `HAS_REAL_ASSETS` probe immediately after the `PROJECT_ROOT` line (54)**

```js
// The byte-accurate / inspect_blueprint / level-actor / find-nodes blocks need real binary
// assets, which the text fixture does not ship. Probe one representative asset on disk; when
// absent (fixture, or any project lacking it) those blocks skip. A real project supplying the
// asset runs them unchanged. (Phase 2 adds generic assets + their own assertions — see
// docs/specs/2026-05-23-generic-fixture-project-design.md.)
const HAS_REAL_ASSETS = await (async () => {
  try {
    // GAS_ABILITY_BP.path is a /Game/... path; map to <root>/Content/<rest>.uasset
    const rel = GAS_ABILITY_BP.path.replace(/^\/Game\//, 'Content/') + '.uasset';
    await stat(join(PROJECT_ROOT, rel));
    return true;
  } catch { return false; }
})();
```
(`join` is imported at line 23; `GAS_ABILITY_BP` at lines 40–42.)

- [ ] **Step 4: Convert the six asset-block guards (leave the structural one)**

`grep -n "if (!\?PROJECT_ROOT)" test-phase1.mjs` lists seven guards. Convert by category. **Line
numbers shift after the Step-3 insertion — match on the adjacent Test-header comment shown, not the
absolute number:**

| Guard (pre-edit line) | Block | Current | Change to |
|---|---|---|---|
| 550 | structural (project_info … dropped-tools) | `if (!PROJECT_ROOT) {` | **unchanged** (runs against fixture) |
| 668 | Test 9 — get_asset_info / inspect_blueprint | `if (PROJECT_ROOT) {` | `if (HAS_REAL_ASSETS) {` |
| 763 | Test 10 — list_level_actors (.umap) | `if (PROJECT_ROOT) {` | `if (HAS_REAL_ASSETS) {` |
| 981 | find_blueprint_nodes (BP asset) | `if (!PROJECT_ROOT) { …; return; }` | `if (!HAS_REAL_ASSETS) { …; return; }` |
| 1101 | Test 12 — response-shape ergonomics | `if (PROJECT_ROOT) {` | `if (HAS_REAL_ASSETS) {` |
| 1261 | Test 13 — find_blueprint_nodes_bulk | `if (PROJECT_ROOT) {` | `if (HAS_REAL_ASSETS) {` |
| 1546 | M-spatial — PLAYER_BP | `if (!PROJECT_ROOT) {` | `if (!HAS_REAL_ASSETS) {` |

Keep line 550's `!PROJECT_ROOT` exactly — that block (project_info, gameplay-tags, list_plugins,
list_data_sources, get_build_config, list_config_values, datatable/stringtable validation,
dropped-tools) is all structural and MUST run against the fixture.

- [ ] **Step 5: Run `test-phase1` with NO env (fixture path)**

Run: `cd server && node test-phase1.mjs`
Expected: PASS, exit 0. The structural offline assertions run against the fixture (offline
auto-enable, project_info=`UEMCPFixture`, gameplay-tags incl. the `Fixture.**` glob == 3,
list_plugins, list_data_sources `fileCount` 0, get_build_config, list_config_values); the six asset
blocks log a SKIP and contribute no failures.

- [ ] **Step 6: Commit**

```bash
git add server/test-phase1.mjs
git commit -m "Adopt resolveProjectRoot() + gate asset blocks in test-phase1"
```

---

## Task 5: `.gitignore` guard for the fixture's future generated dirs

**Files:**
- Modify: `.gitignore`

- [ ] **Step 1: Append the fixture-scoped ignores**

The existing `Binaries/Intermediate/DerivedDataCache` rules are `plugin/**`-scoped only. Add (near those rules):
```
# Fixture project generated output (text fixture is committed; build output is not)
server/fixtures/**/Binaries/
server/fixtures/**/Intermediate/
server/fixtures/**/Saved/
server/fixtures/**/DerivedDataCache/
```

- [ ] **Step 2: Verify the committed fixture text is still tracked, generated dirs ignored**

Run: `git check-ignore server/fixtures/uemcp-fixture/UEMCPFixture.uproject server/fixtures/uemcp-fixture/Binaries/x.dll`
Expected: only the second path prints (ignored); the `.uproject` does not.

- [ ] **Step 3: Commit**

```bash
git add .gitignore
git commit -m "Gitignore fixture-project generated dirs (server/fixtures/**)"
```

---

## Task 6: Allow-list `UEMCPFixture` in the pre-commit pattern-warning

**Files:**
- Modify: `.githooks/pre-commit`

- [ ] **Step 1: Add `UEMCPFixture` to `phase3_allow_pattern`**

In the `phase3_allow_pattern` regex (the alternation of known-generic names ending `…|UnrealMCP|NodeToCode)$`), add `UEMCPFixture`:
```
…|UEMCP|UEMCPFixture|YourProject|MyProject|…
```
(Insert `UEMCPFixture|` immediately after `UEMCP|`.)

- [ ] **Step 2: Verify no pattern-warning fires for the fixture name**

Run: stage a no-op touch of a doc mentioning `UEMCPFixture.uproject` and run the hook in isolation:
`echo "see UEMCPFixture.uproject" >> /tmp/x.md; git --no-pager diff --no-index /dev/null /tmp/x.md | head; bash .githooks/pre-commit` is not representative (it scans staged). Instead, on the next real commit touching the spec/fixture, confirm the `⚠ Pattern-warning … UEMCPFixture` line no longer appears.
Expected: no `UEMCPFixture` pattern-warning.

- [ ] **Step 3: Commit**

```bash
git add .githooks/pre-commit
git commit -m "Allow-list UEMCPFixture in pre-commit codename pattern-warning"
```

---

## Task 7: Update CLAUDE.md Testing section

**Files:**
- Modify: `CLAUDE.md` (Testing section)

- [ ] **Step 1: Document the fixture default**

In the Testing section, after the rotation-runner description, add a subsection:
```markdown
### Fixture project default (D-fixture)

`server/test-helpers.mjs resolveProjectRoot()` returns `UNREAL_PROJECT_ROOT` when set,
else the committed text fixture `server/fixtures/uemcp-fixture/`. `test-phase1` and
`test-mcp-wire` adopt it, so their project-gated *offline* assertions (project_info,
gameplay-tags, list_plugins, list_data_sources, get_build_config, list_config_values)
run everywhere — locally and on a project-less CI runner — against the generic fixture.
Binary-asset assertions gate on a real asset existing (`HAS_REAL_ASSETS`) and skip
against the fixture; a real `UNREAL_PROJECT_ROOT` runs them. The pure-asset supplementary
files still skip when no project is set. Binary-asset CI coverage is deferred to Phase 2.
```

- [ ] **Step 2: Correct the stale "primary = no env" framing**

In the Primary/Supplementary rotation tables, update the note that `test-phase1` needs no env: it now exercises project-gated tools against the fixture by default. Adjust the assertion-count phrasing to "counts vary with project presence (fixture vs real)".

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md
git commit -m "Document fixture-project default in CLAUDE.md Testing section"
```

---

## Task 8: Full validation (the spec's 6-point plan)

**Files:** none (verification only)

- [ ] **Step 1: No-env rotation is green and exercises the fixture**

Run: `cd server && node run-rotation.mjs`
Expected: exit 0, `0 failed`. `test-phase1` and `test-mcp-wire` PASS with a HIGHER assertion count than before this work (project-gated offline asserts now run, not skipped). The 4 pure-asset files still show `⊘ skipped`.

- [ ] **Step 2: Direct-invocation parity**

Run: `cd server && node test-phase1.mjs`
Expected: PASS, exit 0 — same project-gated offline assertions run as under the runner (proves the resolver works for single-file iteration).

- [ ] **Step 3: Explicit fixture path on the adopting files**

Run: `cd server && UNREAL_PROJECT_ROOT="$(pwd)/fixtures/uemcp-fixture" node test-phase1.mjs`
Expected: 140/0, same as the no-env run (resolver returns the explicit path → same fixture).
**NOTE:** the *full* `run-rotation.mjs` with `UNREAL_PROJECT_ROOT` pointed at the fixture is NOT
green — the pure-asset files (`test-query-asset-registry`, `test-inspect-and-level-actors`,
`test-verb-surface`) read the env directly and fail trying to read binary assets the fixture lacks.
That is correct per spec §2 (no runner-side env injection): the fixture is the default for the
*adopting* files, not a whole-suite stand-in project.

- [ ] **Step 4: Real-project precedence (resolver does not clobber a set value)**

Run: `cd server && node -e "process.env.UNREAL_PROJECT_ROOT='/real/x'; import('./test-helpers.mjs').then(m=>{ if(m.resolveProjectRoot()!=='/real/x') process.exit(1); console.log('ok') })"`
Expected: prints `ok`, exit 0.

- [ ] **Step 5: CI parity** — confirm `.github/workflows/rotation.yml`'s command (`npm ci` + `node run-rotation.mjs`) is exactly what Step 1 runs. No workflow change needed (it inherits the fixture default via the resolver).

- [ ] **Step 6: Assertion-count sanity** — confirm the aggregate `total` grew vs the pre-fixture baseline (project-gated offline asserts moved from skipped to passed), and no file dropped to `0/0` unexpectedly (FAIL-LOUD silent-zero guard).

- [ ] **Step 7: Final commit (if any validation tweaks were needed)**

```bash
git add -A && git commit -m "Phase 1 fixture project: validation pass"
```

---

## Self-review note

Spec coverage: fixture (Task 1), resolveProjectRoot + unit test (Task 2), test-mcp-wire adoption
(Task 3), test-phase1 adopt+gate (Task 4), .gitignore (Task 5), pre-commit allow-list (Task 6),
CLAUDE.md (Task 7), 6-point validation (Task 8) — matches spec §1–§6 and the validation plan.

Consistency notes resolved this pass:
- Structural gating is `test-phase1` only (spec §3a); the pure-asset files don't adopt the resolver
  and need no change (spec §3c) — confirmed by the Task 8 no-env rotation.
- Task 4 converts **six** guards (not the four `if (PROJECT_ROOT)` blocks alone): the two
  asset-backed `if (!PROJECT_ROOT){…return}` guards (981, 1546) also flip to `!HAS_REAL_ASSETS`;
  the structural `!PROJECT_ROOT` at 550 stays.
- test-phase1's adopt + gate land in one commit (Task 4) so it is never committed broken;
  test-mcp-wire (no asset block) is a separate commit (Task 3).
- Verified ground-truth: `project_info.projectName` = `.uproject` filename → `UEMCPFixture`;
  `list_plugins` hasPlugins true for any parsed `.uproject`; `list_data_sources` returns
  `fileCount:0` (no Content/ needed); `get_build_config` truthy even without Source/ (Target.cs
  included for real parse coverage); gameplay-glob `Fixture.**` == 3 is deterministic.
