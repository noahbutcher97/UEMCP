# Compile Gate: Content Verdicts and a JSON Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `verify-deploy` decide staleness by plugin-tree content rather than file timestamps, and give `.githooks/pre-push` a JSON document to read instead of human prose.

**Architecture:** A new leaf module `server/plugin-content-hash.mjs` produces a SHA-256 digest over a plugin tree's `Source/**` plus `UEMCP.uplugin`, with an injectable `fsImpl` so it is unit-testable with no disk. `sync-plugin-helper.mjs` records that digest in the deploy marker at sync time. `classifyDeployState` gains four optional inputs and one rule that fires ahead of every mtime rule: byte-identical content plus a DLL newer than the last sync is `SYNC`, whatever the timestamps say. `verify-deploy.mjs --json` prints one machine-readable document built by a pure `buildJsonReport`, and the hook consumes it through a small `node -e` reader whose three exit codes (pass / block / could-not-evaluate) replace the four prose greps it uses today.

**Tech Stack:** Node 22 ES modules (`.mjs`); `node:crypto` `createHash`; bash for the hook; the repo rotation runner. No new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-09-13-compile-gate-content-verdicts-design.md`

Two deviations from the spec, both deliberate, both recorded again at the point of use:

1. **§3.2 `syncedAt`.** The marker already carries `syncTime` (an ISO string, written by `writeDeployMarker` since W-L/D138) meaning exactly "when this sync happened". Adding a second field with the same meaning would create a second source of truth, and every marker already on disk would lack it — so the "DLL after last sync" rule would stay dark until each target was re-synced. The marker therefore gains **only `sourceHash`**, and the reader `markerSyncedAtMs(marker)` prefers `marker.syncedAt` when present and falls back to `marker.syncTime`, so a future writer can still adopt the spec's name without a reader change.
2. **§3.3 `markerSourceHash`.** The spec names the input but states no rule for it, and an unused destructured binding fails this repo's import check. The rule implemented here: a marker's recorded time is only trustworthy when the marker describes the content actually on disk, so when `markerSourceHash` is present and differs from `deployedSourceHash` the marker time is ignored and the deployed files' own mtime is used instead. In the common ordering — marker time at or after the deployed mtime — that fallback is actually the MORE permissive choice, not a conservative one: it can read SYNC where trusting the marker would have called the target stale. It is acceptable only because this fallback is reached after content identity has already been established by hash; it resolves a timing detail, never whether the deployed bytes match the repo's.

Two behaviours that look like bugs and are not — do not "fix" them without a new spec:

- **No DLL, content identical → the never-built rules still apply** (so a content-identical target with no DLL and older deployed mtimes still reads `NEEDS-DEPLOY`). Spec §3.3 and §4 both say so explicitly, and the hook ignores every `dllExists:false` target anyway.
- **Re-syncing identical content after a build reads `NEEDS-BUILD`.** The marker time advances on every sync, including a no-op one, and nothing records which content the DLL was built from. Spec §3.3 prescribes `dllMtime >= markerSyncedAtMs`; it fails safe.

## Global Constraints

- **Scratch files:** set `SCRATCH="$(mktemp -d)"` once per shell before the first task; every `$SCRATCH/...` path below refers to it. Never write scratch output into the repo.
- **Never modify `.uemcp-targets.json`.** Read it if you need a profile name; never add, remove, or edit a target, not even to make a probe pass.
- **Rotation baselines** (measured 2026-09-13, `node run-rotation.mjs --json` → `aggregate`): **7,580 passed / 0 failed across 79 files.** Per-file: `test-verify-deploy.mjs` 50, `test-sync-plugin-helper.mjs` 36, `test-pre-push-gate.mjs` 11. Each task states the expected total after it. **A mismatch means recount this plan's assertion list against what you actually wrote — never adjust the number and continue.**
- ES modules only, no TypeScript, JSDoc comments. Functions under 50 lines. Comment **intent**, not implementation.
- Every test file prints the `Passed:` / `Failed:` / `Total:` lines the rotation parses. New suites use `TestRunner` from `test-helpers.mjs`; `test-verify-deploy.mjs` and `test-sync-plugin-helper.mjs` keep their existing hand-rolled `eq` / `assertTrue` counters — match the file you are editing.
- No new runtime dependencies.
- Tracked files carry placeholder vocabulary only: `path/to/YourProject.uproject`, `Project A` / `Project B`, `<UEMCP_REPO_PATH>`. Never a real project name or a machine-local absolute path in a committed file or a commit message.
- Never write the bare word "temp" into a tracked file (the per-checkout forbidden-tokens regex matches it). Use `$SCRATCH` and the word "scratch".
- **No AI attribution** in commit messages — no `Co-Authored-By`, no "generated with".
- One commit per task, single-line commit messages.
- **The import check** (run from `D:/DevTools/UEMCP/server`; substitute the files under test):

```bash
G="process,Buffer,console,URL,TextDecoder,TextEncoder,setTimeout,clearTimeout,setImmediate,structuredClone,performance,AbortController,queueMicrotask"
npx eslint --no-config-lookup --rule "no-undef: 2" --rule "no-unused-vars: [2, {argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none'}]" --global "$G" plugin-content-hash.mjs verify-deploy.mjs sync-plugin-helper.mjs
```

Zero `no-undef` and zero `no-unused-vars` are required on every file this plan touches.

## File Structure

| File | Responsibility |
|---|---|
| `server/plugin-content-hash.mjs` (new, ~70 lines) | Leaf. `collectPluginContentFiles(pluginRoot, fsImpl)` → sorted forward-slash relative paths or `null`; `hashPluginTree(pluginRoot, fsImpl)` → SHA-256 hex or `null`. Imports `node:crypto`, `node:fs`, `node:path` and nothing local, so it can be imported from both `verify-deploy.mjs` and `sync-plugin-helper.mjs` without touching their existing mutual import. |
| `server/test-plugin-content-hash.mjs` (new) | 17 assertions against an in-memory `fsImpl`. No disk, no project. |
| `server/sync-plugin-helper.mjs` (modify) | `computeIncomingState` gains `sourceHash`; new exported reader `markerSyncedAtMs(marker)`. |
| `server/test-sync-plugin-helper.mjs` (modify) | +12 assertions. |
| `server/verify-deploy.mjs` (modify) | `classifyDeployState` splits into a thin wrapper plus `classifyVerdict`, gains the content rule; `applyMarkerVerdictOverlay` carries `contentIdentical` through its overrides; `gatherTargetMetrics` takes `(target, ctx)`; `main` splits into `gatherAllTargets` + `runTextMode` + `runJsonMode`; new pure exports `buildJsonReport`, `buildJsonErrorReport`, `selectionErrorMessage`, `exitCodeForResults`. |
| `server/test-verify-deploy.mjs` (modify) | −5 prose pins, +50 assertions (content rules, overlay pass-through, JSON shapes, three spawned CLI probes). |
| `.githooks/pre-push` (modify) | The compile-gate block reads `--json` through a `gate_parser` one-liner; three prose greps retire. |
| `server/test-pre-push-gate.mjs` (rewrite the gate pins) | 19 assertions, five of which actually execute the extracted parser. |
| `CLAUDE.md`, `docs/tracking/backlog.md` (modify) | Gate sentence, flags list, rotation counts, EN-26/EN-27 marked done. |

---

### Task 1: `plugin-content-hash.mjs` — content identity for a plugin tree

**Files:**
- Create: `server/plugin-content-hash.mjs`
- Test: `server/test-plugin-content-hash.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `collectPluginContentFiles(pluginRoot: string, fsImpl?: {readdirSync, readFileSync}) => string[] | null` — relative paths with `/` separators, sorted by byte order; `null` when any directory read failed.
  - `hashPluginTree(pluginRoot: string, fsImpl?: {readdirSync, readFileSync}) => string | null` — 64-char lowercase hex SHA-256, or `null` when any read failed.
  - `fsImpl` contract: `readdirSync(dir, { withFileTypes: true })` returning entries with `.name`, `.isDirectory()`, `.isFile()`; `readFileSync(path)` returning a Buffer or string. **No `statSync`** — the module must never consult a timestamp.

- [ ] **Step 1: Record the baseline**

```bash
cd D:/DevTools/UEMCP/server
node run-rotation.mjs --json > "$SCRATCH/gate-base.json"
node -e "const j=require('node:fs').readFileSync(process.argv[1],'utf8');console.log(JSON.stringify(JSON.parse(j).aggregate))" "$SCRATCH/gate-base.json"
```

Expected: `{"passed":7580,"failed":0,"total":7580}`. Anything else: stop and report — every total below is derived from it.

- [ ] **Step 2: Write the failing test**

Create `server/test-plugin-content-hash.mjs`:

```js
// test-plugin-content-hash.mjs — unit tests for the plugin content digest.
//
// The digest is what makes a deploy verdict survive a merge or a checkout, so
// these tests pin the two properties that matter: the digest depends on every
// source byte and path, and on nothing else — not on readdir order, and not on
// any timestamp (the fake fs exposes no stat call at all).
//
// Run: cd server && node test-plugin-content-hash.mjs

import { collectPluginContentFiles, hashPluginTree } from './plugin-content-hash.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('plugin content hash Tests');

const ROOT = 'X:/fake/Plugins/UEMCP';
const norm = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '');

/**
 * In-memory fs standing in for node:fs. `files` maps absolute forward-slash
 * paths to their text content; directories are inferred from the keys.
 * `entryOrder: 'desc'` reverses each readdir result so the digest's
 * order-independence is observable.
 */
function createFakeFs(files, { unreadable = [], readdirFails = [], entryOrder = 'asc' } = {}) {
  const map = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const unreadableSet = new Set(unreadable.map(norm));
  const readdirFailSet = new Set(readdirFails.map(norm));
  return {
    readdirSync(dir) {
      const d = norm(dir);
      if (readdirFailSet.has(d)) throw new Error(`EACCES: ${d}`);
      const names = new Map();
      for (const p of map.keys()) {
        if (!p.startsWith(`${d}/`)) continue;
        const rest = p.slice(d.length + 1);
        const slash = rest.indexOf('/');
        if (slash === -1) names.set(rest, false);
        else names.set(rest.slice(0, slash), true);
      }
      if (names.size === 0) throw new Error(`ENOENT: ${d}`);
      const out = [...names].map(([name, isDir]) => ({
        name,
        isDirectory: () => isDir,
        isFile: () => !isDir,
      }));
      return entryOrder === 'desc' ? out.reverse() : out;
    },
    readFileSync(path) {
      const p = norm(path);
      if (unreadableSet.has(p)) throw new Error(`EBUSY: ${p}`);
      if (!map.has(p)) throw new Error(`ENOENT: ${p}`);
      return Buffer.from(map.get(p), 'utf8');
    },
  };
}

const BASE_FILES = {
  [`${ROOT}/UEMCP.uplugin`]: '{"Version":2}',
  [`${ROOT}/Source/UEMCP/UEMCP.Build.cs`]: 'public class UEMCP {}',
  [`${ROOT}/Source/UEMCP/Private/ActorHandlers.cpp`]: 'void Spawn() {}',
  [`${ROOT}/Source/UEMCP/Public/HandlerCommon.h`]: '#pragma once',
};
const withFiles = (extra) => ({ ...BASE_FILES, ...extra });

const baseHash = hashPluginTree(ROOT, createFakeFs(BASE_FILES));

// 1-3: the digest is a digest, it is stable, and readdir order cannot move it.
t.assert(/^[0-9a-f]{64}$/.test(String(baseHash)), 'digest is 64 lowercase hex characters');
t.assert(hashPluginTree(ROOT, createFakeFs(BASE_FILES)) === baseHash, 'digest is deterministic across calls');
t.assert(
  hashPluginTree(ROOT, createFakeFs(BASE_FILES, { entryOrder: 'desc' })) === baseHash,
  'digest is independent of readdir entry order',
);

// 4: the file list is the sorted, forward-slash relative surface.
t.assert(
  JSON.stringify(collectPluginContentFiles(ROOT, createFakeFs(BASE_FILES))) === JSON.stringify([
    'Source/UEMCP/Private/ActorHandlers.cpp',
    'Source/UEMCP/Public/HandlerCommon.h',
    'Source/UEMCP/UEMCP.Build.cs',
    'UEMCP.uplugin',
  ]),
  'collectPluginContentFiles returns sorted forward-slash relative paths',
);

// 5-8: build output and deploy bookkeeping are not content.
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/Binaries/Win64/UnrealEditor-UEMCP.dll`]: 'MZbinary',
  }))) === baseHash,
  'a root Binaries/ file does not change the digest',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/Source/UEMCP/Intermediate/Build.obj`]: 'objbytes',
  }))) === baseHash,
  'a nested Intermediate/ directory does not change the digest',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/.uemcp-deploy-marker.json`]: '{"schemaVersion":"1.0"}',
  }))) === baseHash,
  'the root deploy marker does not change the digest',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/Source/.uemcp-deploy-marker.json.uemcp-tmp`]: 'staging',
  }))) === baseHash,
  'a nested .uemcp- staging file does not change the digest',
);

// 9-12: every source byte and every path is in the digest.
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/Source/UEMCP/Private/ActorHandlers.cpp`]: 'void Spawn() {};',
  }))) !== baseHash,
  'a one-byte change in a Source file changes the digest',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/UEMCP.uplugin`]: '{"Version":3}',
  }))) !== baseHash,
  'a change to UEMCP.uplugin changes the digest',
);
const renamed = { ...BASE_FILES };
delete renamed[`${ROOT}/Source/UEMCP/Private/ActorHandlers.cpp`];
renamed[`${ROOT}/Source/UEMCP/Private/ActorHandlers2.cpp`] = 'void Spawn() {}';
t.assert(
  hashPluginTree(ROOT, createFakeFs(renamed)) !== baseHash,
  'renaming a file with identical bytes changes the digest',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(withFiles({
    [`${ROOT}/Source/UEMCP/Private/NewHandlers.cpp`]: '',
  }))) !== baseHash,
  'adding a Source file changes the digest',
);

// 13-16: an unanswerable question returns null, never a partial digest.
t.assert(
  hashPluginTree(ROOT, createFakeFs(BASE_FILES, {
    unreadable: [`${ROOT}/Source/UEMCP/Private/ActorHandlers.cpp`],
  })) === null,
  'a file that cannot be read yields null, not a partial digest',
);
t.assert(
  collectPluginContentFiles(ROOT, createFakeFs(BASE_FILES, { readdirFails: [`${ROOT}/Source`] })) === null,
  'an unreadable Source/ makes collectPluginContentFiles return null',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs(BASE_FILES, { readdirFails: [`${ROOT}/Source`] })) === null,
  'an unreadable Source/ makes hashPluginTree return null',
);
t.assert(
  hashPluginTree(ROOT, createFakeFs({ [`${ROOT}/UEMCP.uplugin`]: '{}' })) === null,
  'a plugin root with no Source/ yields null',
);

// 17: the fake exposes no stat call, so no timestamp can have entered the digest.
const strictFs = createFakeFs(BASE_FILES);
t.assert(
  Object.keys(strictFs).sort().join(',') === 'readFileSync,readdirSync' && baseHash !== null,
  'the digest is produced from an fsImpl with no stat call — mtimes cannot enter it',
);

process.exit(t.summary());
```

- [ ] **Step 3: Run it to verify it fails**

Run: `cd D:/DevTools/UEMCP/server && node test-plugin-content-hash.mjs`
Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `./plugin-content-hash.mjs`.

- [ ] **Step 4: Write the implementation**

Create `server/plugin-content-hash.mjs`:

```js
// plugin-content-hash.mjs — content identity for a UEMCP plugin tree.
//
// Deploy verdicts used to rest on file mtimes alone, so a merge, checkout or
// stash-pop that rewrote plugin source made byte-identical deployments look
// stale and the pre-push gate refused the push (EN-27). This module answers
// "is this deployed tree the same content as the repo's" without consulting a
// single timestamp: the digest covers the source tree and the descriptor, in
// sorted path order, and nothing else.
//
// fsImpl is injectable so the unit tests can run against an in-memory tree.
// Deliberately absent from that contract: any stat call.

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_FS = { readdirSync, readFileSync };

/** Build outputs: regenerated from content, never part of it. */
const EXCLUDED_DIRS = new Set(['Binaries', 'Intermediate']);

/** Files the deploy tooling writes into the tree; they describe a sync, not the source. */
const EXCLUDED_FILE_PREFIX = '.uemcp-';

/** The two root entries that define plugin content. */
const ROOT_DIRS = ['Source'];
const ROOT_FILES = ['UEMCP.uplugin'];

/** Byte-order comparison; localeCompare would make the digest locale-dependent. */
function byPath(a, b) {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/**
 * Every content-bearing file under a plugin root, as sorted relative paths with
 * forward slashes. Returns null when any directory could not be listed — a
 * partial list would produce a confident wrong digest, and "unknown" is a
 * verdict the classifier can express.
 */
export function collectPluginContentFiles(pluginRoot, fsImpl = DEFAULT_FS) {
  const files = [];
  let ok = true;

  const walk = (absDir, relPrefix) => {
    let entries;
    try {
      entries = fsImpl.readdirSync(absDir, { withFileTypes: true });
    } catch {
      ok = false;
      return;
    }
    for (const entry of entries) {
      if (!ok) return;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) continue;
        walk(join(absDir, entry.name), `${relPrefix}${entry.name}/`);
      } else if (entry.isFile()) {
        if (entry.name.startsWith(EXCLUDED_FILE_PREFIX)) continue;
        files.push(`${relPrefix}${entry.name}`);
      }
    }
  };

  for (const dir of ROOT_DIRS) walk(join(pluginRoot, dir), `${dir}/`);
  if (!ok) return null;
  for (const file of ROOT_FILES) files.push(file);
  return files.sort(byPath);
}

/**
 * SHA-256 over `relativePath + NUL + fileBytes` for every content file, in
 * sorted path order. Equal digests mean byte-identical trees. Returns null when
 * any file could not be read — an editor holding a file open must not be able
 * to turn a stale deployment into a confident match.
 */
export function hashPluginTree(pluginRoot, fsImpl = DEFAULT_FS) {
  const files = collectPluginContentFiles(pluginRoot, fsImpl);
  if (files === null) return null;
  const hash = createHash('sha256');
  for (const rel of files) {
    let bytes;
    try {
      bytes = fsImpl.readFileSync(join(pluginRoot, ...rel.split('/')));
    } catch {
      return null;
    }
    hash.update(`${rel}\0`, 'utf8');
    hash.update(bytes);
  }
  return hash.digest('hex');
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd D:/DevTools/UEMCP/server && node test-plugin-content-hash.mjs`
Expected: `Passed: 17`, `Failed: 0`, `Total:  17`.

- [ ] **Step 6: Import check**

Run the import check from Global Constraints on `plugin-content-hash.mjs test-plugin-content-hash.mjs`.
Expected: no output.

- [ ] **Step 7: Sanity-check the digest against the real repo tree**

```bash
cd D:/DevTools/UEMCP/server
node -e "import('./plugin-content-hash.mjs').then(m=>{const t0=Date.now();const h=m.hashPluginTree('../plugin/UEMCP');console.log(h, (Date.now()-t0)+'ms', m.collectPluginContentFiles('../plugin/UEMCP').length+' files')})"
```

Expected: a 64-hex digest, a file count in the dozens-to-low-hundreds, and an elapsed time well under 1000 ms (spec §6 budgets about 100 ms). Record the number; if it exceeds 1000 ms, report it before continuing — the classifier calls this once per target per run.

- [ ] **Step 8: Rotation and commit**

```bash
cd D:/DevTools/UEMCP/server
node run-rotation.mjs --json > "$SCRATCH/gate-t1.json"
node -e "const j=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify(j.aggregate),'files',j.files.length,'importErrors',j.importErrorCount)" "$SCRATCH/gate-t1.json"
```

Expected: `{"passed":7597,"failed":0,"total":7597} files 80 importErrors 0`.

```bash
cd D:/DevTools/UEMCP
git add server/plugin-content-hash.mjs server/test-plugin-content-hash.mjs
git commit -m "Add plugin-content-hash: SHA-256 content identity for a plugin tree, mtime-free"
```

---

### Task 2: The deploy marker records the content it deployed

**Files:**
- Modify: `server/sync-plugin-helper.mjs` (imports; `computeIncomingState` ~lines 173-195; new `markerSyncedAtMs` after `readDeployMarker` ~line 92)
- Test: `server/test-sync-plugin-helper.mjs`

**Interfaces:**
- Consumes: `hashPluginTree(pluginRoot, fsImpl?)` from `plugin-content-hash.mjs`.
- Produces:
  - `computeIncomingState(repoRoot)` return value gains `sourceHash: string | null` alongside the existing `manifestVersion`, `upluginVersion`, `upluginVersionName`, `sourceCommitSha`, `headPluginCommitSha`. Because `cliWrite` spreads this object into the marker, the marker gains `sourceHash` with no other change.
  - `markerSyncedAtMs(marker) => number | null` — epoch milliseconds of the marker's sync, read from `syncedAt` then `syncTime`.
- Unchanged on purpose: `compareDeployMarker`'s verdicts. It compares `manifestVersion` and `upluginVersion` only, so a differing `sourceHash` must not change a nuke decision.

- [ ] **Step 1: Write the failing tests**

In `server/test-sync-plugin-helper.mjs`, extend the import block at lines 9-16 to add `markerSyncedAtMs`:

```js
import {
  readDeployMarker,
  writeDeployMarker,
  compareDeployMarker,
  computeIncomingState,
  markerSyncedAtMs,
  MARKER_FILENAME,
  MARKER_SCHEMA_VERSION,
} from './sync-plugin-helper.mjs';
```

Immediately after the existing `schemaVerdict` block (the two `eq` calls ending `'schema-version mismatch → reason'`, ~line 116), insert:

```js
// A content hash in the marker must not move the nuke decision: that decision
// is about plugin metadata versions, not about source bytes.
const hashOnlyChangedPrior = {
  schemaVersion: MARKER_SCHEMA_VERSION,
  manifestVersion: '1.0.1',
  upluginVersion: 2,
  upluginVersionName: '1.0.1',
  sourceHash: 'f'.repeat(64),
};
eq(
  compareDeployMarker(hashOnlyChangedPrior, incomingV1),
  { nukeRecommended: false, reason: 'version-match' },
  'a differing sourceHash alone does not recommend a nuke'
);

// ─── markerSyncedAtMs — the classifier's "when was this deployed" input ──
eq(markerSyncedAtMs(null), null, 'markerSyncedAtMs(null) → null');
eq(markerSyncedAtMs({}), null, 'marker with no time field → null');
eq(markerSyncedAtMs({ syncTime: 'not-a-date' }), null, 'unparseable time → null');
eq(
  markerSyncedAtMs({ syncTime: '2026-05-05T20:34:11.000Z' }),
  Date.parse('2026-05-05T20:34:11.000Z'),
  'legacy syncTime is read'
);
eq(
  markerSyncedAtMs({ syncTime: '2026-05-05T20:34:11.000Z', syncedAt: '2026-09-13T10:00:00.000Z' }),
  Date.parse('2026-09-13T10:00:00.000Z'),
  'syncedAt wins over syncTime when both are present'
);
```

Inside the existing `try { ... } finally { rmSync(tmpRoot ...) }` block, immediately after the `assertTrue(typeof written.syncTime === 'string' ...)` line (~line 146), insert:

```js
  // The marker carries the content it deployed, so a later verify-deploy can
  // tell "the DLL predates this sync" from "the DLL predates a different sync".
  const hashed = writeDeployMarker(tmpRoot, { ...fields, sourceHash: 'a'.repeat(64) });
  eq(hashed.sourceHash, 'a'.repeat(64), 'writeDeployMarker keeps the caller sourceHash');
  eq(readDeployMarker(tmpRoot).sourceHash, 'a'.repeat(64), 'sourceHash round-trips through disk');

  // A marker written before this field existed must still read cleanly.
  const legacy = writeDeployMarker(tmpRoot, fields);
  assertTrue(readDeployMarker(tmpRoot) !== null, 'a marker without sourceHash still reads');
  eq(legacy.sourceHash, undefined, 'a marker without sourceHash reports it as undefined');
  eq(readDeployMarker(tmpRoot).manifestVersion, '1.0.1', 'the other fields survive a hash-less marker');
```

Finally, after the existing `computeIncomingState` assertions (after `assertTrue(typeof incoming.headPluginCommitSha === 'string', ...)`, ~line 192), insert:

```js
assertTrue(/^[0-9a-f]{64}$/.test(String(incoming.sourceHash)),
  'computeIncomingState hashes the repo plugin tree');
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd D:/DevTools/UEMCP/server && node test-sync-plugin-helper.mjs`
Expected: FAIL — `SyntaxError`/`does not provide an export named 'markerSyncedAtMs'`.

- [ ] **Step 3: Implement the helper changes**

In `server/sync-plugin-helper.mjs`, add to the import block after the `./verify-deploy.mjs` import (line 57-61):

```js
import { hashPluginTree } from './plugin-content-hash.mjs';
```

Immediately after `readDeployMarker` (after its closing brace, ~line 92), add:

```js
/**
 * The moment this marker's sync happened, in epoch milliseconds, or null when
 * the marker records none. `syncedAt` is read first so a future writer can
 * adopt that name; `syncTime` is what every marker on disk carries today.
 */
export function markerSyncedAtMs(marker) {
  if (!marker) return null;
  const raw = marker.syncedAt ?? marker.syncTime ?? null;
  if (typeof raw !== 'string') return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}
```

In `computeIncomingState`, extend the returned object (lines 188-194) with one field:

```js
  return {
    manifestVersion: String(manifest.version ?? ''),
    upluginVersion: typeof uplugin.Version === 'number' ? uplugin.Version : Number(uplugin.Version ?? 0),
    upluginVersionName: String(uplugin.VersionName ?? ''),
    sourceCommitSha,
    headPluginCommitSha,
    // Content identity of the tree being deployed. cliWrite spreads this into
    // the marker, so the marker records what was synced, not only when.
    sourceHash: hashPluginTree(join(repoRoot, 'plugin', 'UEMCP')),
  };
```

Also extend the `computeIncomingState` JSDoc's "Returns" sentence (line 164) to name `sourceHash`, and the module header's marker description (line 8-9) to say the marker captures manifest version, uplugin Version, commit SHAs **and the source-tree content hash**.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd D:/DevTools/UEMCP/server && node test-sync-plugin-helper.mjs`
Expected: `Passed: 48`, `Failed: 0`, `Total: 48` (36 + 12).

- [ ] **Step 5: Confirm no pre-existing assertion drifted**

The deep-equal `compareDeployMarker(matchingPrior, incomingV1)` assertion at line ~67 asserts on the *result*, not the inputs, so a richer `incoming` must not touch it. Confirm the run above reports zero `FAIL [` lines:

Run: `node test-sync-plugin-helper.mjs 2>&1 | grep -c "^FAIL \["`
Expected: `0`.

- [ ] **Step 6: Import check**

Run the import check on `sync-plugin-helper.mjs test-sync-plugin-helper.mjs`.
Expected: no output.

- [ ] **Step 7: Rotation and commit**

```bash
cd D:/DevTools/UEMCP/server
node run-rotation.mjs --json > "$SCRATCH/gate-t2.json"
node -e "const j=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify(j.aggregate),'importErrors',j.importErrorCount)" "$SCRATCH/gate-t2.json"
```

Expected: `{"passed":7609,"failed":0,"total":7609} importErrors 0`.

```bash
cd D:/DevTools/UEMCP
git add server/sync-plugin-helper.mjs server/test-sync-plugin-helper.mjs
git commit -m "Record the deployed source hash in the deploy marker and expose its sync time"
```

---

### Task 3: Content-based verdicts and a `--json` document

**Files:**
- Modify: `server/verify-deploy.mjs` (header flag list ~lines 19-30; imports ~lines 35-62; `classifyDeployState` 103-133; `applyMarkerVerdictOverlay` 173-205; `gatherTargetMetrics` 311-369; `parseArgs` 449-474; `printHelp` 476-505; `main` 672-805)
- Modify: `server/test-verify-deploy.mjs`

**Interfaces:**
- Consumes: `hashPluginTree` from `plugin-content-hash.mjs`; `markerSyncedAtMs` from `sync-plugin-helper.mjs`.
- Produces (all pure, all exported, all consumed by `test-verify-deploy.mjs` and by the hook in Task 4):
  - `classifyDeployState(input)` — `input` gains optional `repoSourceHash`, `deployedSourceHash`, `markerSourceHash` (strings or null) and `markerSyncedAtMs` (number or null). Every returned verdict object now carries `contentIdentical: true | false | null` alongside `verdict` and `reason`.
  - `buildJsonReport(targets, { profile, exitCode })` — `targets` are `gatherTargetMetrics` results; returns `{ version: 1, profile, targets: [{ uprojectPath, alias, verdict, reason, contentIdentical, dllExists, editors, mcpPointsHere }], exitCode }`.
  - `buildJsonErrorReport(message)` — `{ version: 1, error, exitCode: 2 }`.
  - `selectionErrorMessage(selection)` — one-line string for a target-selection failure.
  - `exitCodeForResults(results)` — `0` when every verdict is `SYNC`, else `1`. Both printers call it, so text and JSON exit codes cannot drift.

- [ ] **Step 1: Remove the five prose pins**

In `server/test-verify-deploy.mjs`, delete the whole block from the comment `// ─── Pinned strings that .githooks/pre-push greps out of this file's output ─` through the closing `);` of the `bold('Verdict:')` assertion (lines 98-137), **except** keep the `includesStr` helper — the new assertions use it. Replace that block with exactly:

```js
// ─── Assertion helpers shared by the reason, JSON and CLI checks ─────
const includesStr = (str, substr, label) => {
  if (typeof str === 'string' && str.includes(substr)) { passed++; }
  else { failed++; console.error(`FAIL [${label}]: expected to contain "${substr}", got ${JSON.stringify(str)}`); }
};
const assertOk = (cond, label) => {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL [${label}]: expected truthy`); }
};
```

Then delete the now-unused `readFileSync` import on line 8 (`import { readFileSync } from 'node:fs';`).

Net: five assertions removed (`DLL missing`, `not built`, the two `includesNeither` calls, and the `bold('Verdict:')` source pin). They existed only so a reword could not silently disarm the hook's prose greps; Task 4 removes those greps.

- [ ] **Step 2: Write the failing tests — content rules**

Extend the import block at the top of `server/test-verify-deploy.mjs`:

```js
import {
  parseTargetsFile,
  classifyDeployState,
  formatAge,
  formatMarkerSyncTime,
  normalizePath,
  extractUprojectFromCommandLine,
  parseEditorProcessLines,
  applyMarkerVerdictOverlay,
  buildJsonReport,
  buildJsonErrorReport,
  selectionErrorMessage,
  exitCodeForResults,
} from './verify-deploy.mjs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
```

Append this block after the existing `applyMarkerVerdictOverlay` section (after the `r8` assertions, ~line 293):

```js
// ─── Content-based verdicts (EN-27) ─────────────────────────────────
// The whole point: a deployment whose bytes match the repo is not stale, no
// matter what a merge or checkout did to the repo's file mtimes.
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const secToMs = (s) => s * 1000;
const built = (over) => ({
  pluginDirExists: true,
  deployedSrcFileCount: 5,
  dllExists: true,
  deployedSrcMtime: repoSrc,
  dllMtime: repoSrc,
  repoSrcMtime: repoSrc,
  repoSourceHash: HASH_A,
  deployedSourceHash: HASH_A,
  ...over,
});

const c1 = classifyDeployState(built({ markerSyncedAtMs: secToMs(older), dllMtime: newer }));
eq(c1.verdict, 'SYNC', 'content identical + DLL after last sync → SYNC');
includesStr(c1.reason, 'content-identical', 'content-identical SYNC reason says so');
eq(c1.contentIdentical, true, 'content-identical SYNC carries contentIdentical true');

const c2 = classifyDeployState(built({ markerSyncedAtMs: secToMs(newer), dllMtime: older }));
eq(c2.verdict, 'NEEDS-BUILD', 'content identical + DLL before last sync → NEEDS-BUILD');
includesStr(c2.reason, 'predates the last sync', 'content-identical NEEDS-BUILD reason says so');

eq(
  classifyDeployState(built({ markerSyncedAtMs: null, deployedSrcMtime: older, dllMtime: newer })).verdict,
  'SYNC',
  'no marker time → deployed source mtime is the sync reference (DLL newer → SYNC)',
);
eq(
  classifyDeployState(built({ markerSyncedAtMs: null, deployedSrcMtime: newer, dllMtime: older })).verdict,
  'NEEDS-BUILD',
  'no marker time → deployed source mtime is the sync reference (DLL older → NEEDS-BUILD)',
);

// The EN-27 shape itself: a merge rewrote repo source, so repoSrcMtime jumped
// ahead of both the deployed source and the DLL, but nothing actually changed.
const en27 = {
  pluginDirExists: true, deployedSrcFileCount: 5, dllExists: true,
  deployedSrcMtime: older, dllMtime: older + 10, repoSrcMtime: repoSrc + 5000,
  markerSyncedAtMs: secToMs(older),
};
eq(
  classifyDeployState({ ...en27, repoSourceHash: HASH_A, deployedSourceHash: HASH_A }).verdict,
  'SYNC',
  'EN-27: touched repo source with identical content still reads SYNC',
);
eq(
  classifyDeployState(en27).verdict,
  'NEEDS-DEPLOY',
  'EN-27: the same inputs without hashes still read NEEDS-DEPLOY (the mtime fallback)',
);

// A marker whose recorded hash no longer matches the disk describes a
// different sync, so its timestamp must not be trusted.
eq(
  classifyDeployState(built({
    markerSyncedAtMs: secToMs(older - 100), markerSourceHash: HASH_A,
    deployedSrcMtime: newer, dllMtime: older,
  })).verdict,
  'SYNC',
  'marker hash matches the disk → the marker time is used',
);
eq(
  classifyDeployState(built({
    markerSyncedAtMs: secToMs(older - 100), markerSourceHash: HASH_B,
    deployedSrcMtime: newer, dllMtime: older,
  })).verdict,
  'NEEDS-BUILD',
  'marker hash does not match the disk → the marker time is ignored',
);

// Never-built targets keep the pre-content rules (design §3.3): content
// identity cannot make a missing DLL fresh.
eq(
  classifyDeployState(built({ dllExists: false, dllMtime: 0, deployedSrcMtime: older })).verdict,
  'NEEDS-DEPLOY',
  'content identical + no DLL + stale deployed mtime → never-built rules unchanged',
);
eq(
  classifyDeployState(built({ dllExists: false, dllMtime: 0, deployedSrcMtime: newer })).verdict,
  'NEEDS-BUILD',
  'content identical + no DLL + fresh deployed mtime → never-built rules unchanged',
);

// Differing or absent hashes leave the mtime rules exactly as they were.
const differ = classifyDeployState(built({ deployedSourceHash: HASH_B, deployedSrcMtime: newer, dllMtime: newer }));
eq(differ.verdict, 'SYNC', 'hashes differ → mtime rules decide (all fresh → SYNC)');
eq(differ.contentIdentical, false, 'hashes differ → contentIdentical false');
const differStale = classifyDeployState(built({ deployedSourceHash: HASH_B, deployedSrcMtime: older, dllMtime: older }));
eq(differStale.verdict, 'NEEDS-DEPLOY', 'hashes differ + both stale → NEEDS-DEPLOY');
includesStr(differStale.reason, 'DLL predates HEAD source', 'the mtime NEEDS-DEPLOY reason is unchanged');
const noHash = classifyDeployState(built({ repoSourceHash: null, deployedSourceHash: null, deployedSrcMtime: newer, dllMtime: newer }));
eq(noHash.contentIdentical, null, 'no hashes → contentIdentical null');
eq(noHash.verdict, 'SYNC', 'no hashes → mtime rules decide, unchanged');

// The structural verdicts still win: content rules never precede them.
const missing = classifyDeployState(built({ pluginDirExists: false }));
eq(missing.verdict, 'MISSING', 'MISSING still wins over the content rule');
eq(
  Object.prototype.hasOwnProperty.call(missing, 'contentIdentical'),
  true,
  'every verdict object carries a contentIdentical key',
);

// The marker overlay replaces the verdict object; it must not drop the field.
const baseIdentical = { verdict: 'SYNC', reason: 'content-identical to repo; DLL built after the last sync', contentIdentical: true };
eq(
  applyMarkerVerdictOverlay(baseIdentical, null, { reason: 'no-prior-marker', nukeRecommended: false }, incoming, true, 5).contentIdentical,
  true,
  'no-marker overlay preserves contentIdentical',
);
eq(
  applyMarkerVerdictOverlay(
    baseIdentical, stalePrior,
    { reason: 'version-changed', nukeRecommended: true, detail: { prior: stalePrior, incoming } },
    incoming, true, 5,
  ).contentIdentical,
  true,
  'version-changed overlay preserves contentIdentical',
);
```

- [ ] **Step 3: Write the failing tests — the JSON contract**

Append after the block from Step 2:

```js
// ─── The JSON contract the pre-push gate consumes (EN-26) ───────────
const sampleTargets = [
  {
    uprojectPath: 'path/to/YourProject.uproject', alias: 'primary', dllExists: true,
    matchedEditors: [{ pid: 42 }], mcpPointsHere: true,
    verdict: { verdict: 'SYNC', reason: 'content-identical to repo; DLL built after the last sync', contentIdentical: true },
  },
  {
    uprojectPath: 'path/to/SecondProject.uproject', alias: null, dllExists: false,
    matchedEditors: [], mcpPointsHere: false,
    verdict: { verdict: 'NEEDS-BUILD', reason: 'Source synced but DLL not built', contentIdentical: null },
  },
];
const report = buildJsonReport(sampleTargets, { profile: 'smoke', exitCode: 1 });
eq(report.version, 1, 'report carries the schema version');
eq(report.profile, 'smoke', 'report carries the profile name');
eq(report.exitCode, 1, 'report carries the exit code');
eq(report.targets.length, 2, 'report carries one row per target');
eq(
  Object.keys(report.targets[0]),
  ['uprojectPath', 'alias', 'verdict', 'reason', 'contentIdentical', 'dllExists', 'editors', 'mcpPointsHere'],
  'a target row has exactly the contract keys',
);
eq(
  [report.targets[0].verdict, report.targets[0].reason, report.targets[0].contentIdentical],
  ['SYNC', 'content-identical to repo; DLL built after the last sync', true],
  'row 0 verdict, reason and contentIdentical',
);
eq(
  [report.targets[0].dllExists, report.targets[0].editors, report.targets[0].mcpPointsHere],
  [true, [42], true],
  'row 0 dllExists, editor pids and mcpPointsHere',
);
eq(
  [report.targets[1].alias, report.targets[1].dllExists, report.targets[1].editors],
  [null, false, []],
  'row 1 null alias, no DLL, no editors',
);
eq(report.targets[1].contentIdentical, null, 'an unknown content verdict serialises as null');
eq(
  buildJsonReport([], {}),
  { version: 1, profile: null, targets: [], exitCode: 0 },
  'an empty report has a null profile and exit 0',
);
assertOk(
  report.targets.every((row) => Object.values(row).every((v) => v !== undefined)),
  'no target row field is undefined — an undefined would vanish from the serialised document',
);

eq(buildJsonErrorReport('boom'), { version: 1, error: 'boom', exitCode: 2 }, 'the error document shape');
eq(buildJsonErrorReport(new Error('bad')).error, 'Error: bad', 'a non-string message is coerced');

eq(exitCodeForResults([{ verdict: { verdict: 'SYNC' } }, { verdict: { verdict: 'SYNC' } }]), 0, 'all SYNC → exit 0');
eq(exitCodeForResults([{ verdict: { verdict: 'SYNC' } }, { verdict: { verdict: 'NEEDS-BUILD' } }]), 1, 'any non-SYNC → exit 1');

includesStr(
  selectionErrorMessage({ status: 'absent', targetsPath: 'path/to/.uemcp-targets.json', candidates: [] }),
  'Targets file not found',
  'selectionErrorMessage: absent targets file',
);
includesStr(
  selectionErrorMessage({ status: 'profile_not_found', targetsPath: 'x', candidates: [], profile: { name: 'nope', availableProfiles: ['default', 'smoke'] } }),
  'nope',
  'selectionErrorMessage: unknown profile names it',
);
includesStr(
  selectionErrorMessage({ status: 'valid', targetsPath: 'x', candidates: [] }),
  'No targets selected',
  'selectionErrorMessage: valid config selecting nothing',
);
includesStr(
  selectionErrorMessage({ status: 'invalid_config', targetsPath: 'x', candidates: [] }),
  'Invalid targets config',
  'selectionErrorMessage: invalid config',
);

// ─── The CLI actually emits those documents ─────────────────────────
// Runs against a targets path that cannot exist, so this is deterministic on
// any machine and never touches .uemcp-targets.json.
const VERIFY_DEPLOY = join(dirname(fileURLToPath(import.meta.url)), 'verify-deploy.mjs');
const MISSING_TARGETS = join(dirname(fileURLToPath(import.meta.url)), 'no-such-targets-file.json');

const jsonRun = spawnSync(process.execPath, [VERIFY_DEPLOY, '--json', '--targets', MISSING_TARGETS], { encoding: 'utf8' });
eq(jsonRun.status, 2, '--json with an absent targets file exits 2');
let jsonDoc = null;
try { jsonDoc = JSON.parse(jsonRun.stdout); } catch { jsonDoc = null; }
assertOk(jsonDoc !== null, '--json stdout parses as JSON');
eq([jsonDoc && jsonDoc.version, jsonDoc && jsonDoc.exitCode, typeof (jsonDoc && jsonDoc.error)], [1, 2, 'string'],
  'the error document carries version, exitCode and a message');
assertOk(jsonRun.stdout.trim().startsWith('{') && jsonRun.stdout.trim().endsWith('}'),
  '--json prints one document to stdout and nothing else');

const badFlagRun = spawnSync(process.execPath, [VERIFY_DEPLOY, '--json', '--not-a-flag'], { encoding: 'utf8' });
eq(badFlagRun.status, 2, '--json with an unknown flag exits 2');
includesStr(badFlagRun.stdout, '"error"', 'an unknown flag under --json still produces the error document');

const textRun = spawnSync(process.execPath, [VERIFY_DEPLOY, '--no-color', '--targets', MISSING_TARGETS], { encoding: 'utf8' });
eq(textRun.status, 2, 'text mode with an absent targets file still exits 2');
includesStr(textRun.stderr, '[ERROR]', 'text mode still reports the failure to a human');
```

Both helpers this block uses — `includesStr` and `assertOk` — were written once in Step 1; do not redeclare them here.

- [ ] **Step 4: Run the tests to verify they fail**

Run: `cd D:/DevTools/UEMCP/server && node test-verify-deploy.mjs`
Expected: FAIL — `does not provide an export named 'buildJsonReport'`.

- [ ] **Step 5: Implement the classifier rules**

In `server/verify-deploy.mjs`, extend the existing `./sync-plugin-helper.mjs` import (lines 58-62) with one name and add one new import line after it:

```js
import {
  readDeployMarker,
  compareDeployMarker,
  computeIncomingState,
  markerSyncedAtMs,
} from './sync-plugin-helper.mjs';
import { hashPluginTree } from './plugin-content-hash.mjs';
```

Add the repo plugin root next to `PLUGIN_SRC_DIR` (line 66):

```js
const REPO_PLUGIN_DIR = join(REPO_ROOT, 'plugin', 'UEMCP');
```

Replace `classifyDeployState` (lines 102-133) with:

```js
/**
 * Content identity between the deployed tree and the repo tree. null means
 * "unknown" — one of the hashes could not be computed — and must never be
 * read as "differs".
 */
function compareSourceHashes(repoSourceHash, deployedSourceHash) {
  if (!repoSourceHash || !deployedSourceHash) return null;
  return repoSourceHash === deployedSourceHash;
}

/**
 * When the deployed content was last put in place, in epoch seconds. The
 * marker's own time is only usable when the marker describes the content that
 * is actually on disk; a marker recording a different hash was written for a
 * different tree, so fall back to the deployed files' mtime.
 */
function lastSyncRefSec({ markerSyncedAtMs: syncedMs, markerSourceHash, deployedSourceHash, deployedSrcMtime }) {
  const markerDescribesDisk = !markerSourceHash || markerSourceHash === deployedSourceHash;
  if (syncedMs && markerDescribesDisk) return Math.floor(syncedMs / 1000);
  return deployedSrcMtime;
}

/** Classify a target's deploy state given gathered metrics. Pure function. */
export function classifyDeployState(input) {
  const contentIdentical = compareSourceHashes(
    input.repoSourceHash ?? null,
    input.deployedSourceHash ?? null,
  );
  return { ...classifyVerdict(input, contentIdentical), contentIdentical };
}

function classifyVerdict(input, contentIdentical) {
  const { pluginDirExists, deployedSrcMtime, deployedSrcFileCount, dllExists, dllMtime, repoSrcMtime } = input;
  if (!pluginDirExists) return { verdict: 'MISSING', reason: 'No Plugins\\UEMCP at target' };
  if (deployedSrcFileCount === 0) return { verdict: 'MISSING-PARTIAL', reason: 'Plugin dir exists but Source/ is empty' };
  if (!dllExists) {
    // Never built here. Content identity cannot make a missing DLL fresh, so
    // the pre-content rules stand unchanged (design §3.3).
    if (deployedSrcMtime + MTIME_SLOP_SEC < repoSrcMtime) {
      return { verdict: 'NEEDS-DEPLOY', reason: 'Source stale AND DLL missing — full sync + Build needed' };
    }
    return { verdict: 'NEEDS-BUILD', reason: 'Source synced but DLL not built' };
  }
  if (contentIdentical === true) {
    // Byte-identical deployment: a merge or checkout cannot make it stale. The
    // only question left is whether the DLL predates the sync that placed it.
    if (dllMtime + MTIME_SLOP_SEC < lastSyncRefSec(input)) {
      return { verdict: 'NEEDS-BUILD', reason: 'content-identical to repo; DLL predates the last sync' };
    }
    return { verdict: 'SYNC', reason: 'content-identical to repo; DLL built after the last sync' };
  }
  // Content differs or is unknown — the timestamp rules are still right.
  const sourceStale = deployedSrcMtime + MTIME_SLOP_SEC < repoSrcMtime;
  const dllStale = dllMtime + MTIME_SLOP_SEC < repoSrcMtime;
  if (sourceStale && dllStale) {
    return { verdict: 'NEEDS-DEPLOY', reason: 'DLL predates HEAD source — full sync + Build needed' };
  }
  if (sourceStale) {
    return { verdict: 'NEEDS-SYNC', reason: 'Deployed source older than repo source' };
  }
  if (dllMtime + MTIME_SLOP_SEC < deployedSrcMtime) {
    return { verdict: 'NEEDS-BUILD', reason: 'Deployed source synced but DLL older than source — Build needed' };
  }
  return { verdict: 'SYNC', reason: 'DLL ≥ deployed source ≥ repo source' };
}
```

In `applyMarkerVerdictOverlay`, both override branches build a fresh object and would otherwise drop the new field. Add one line to each:

```js
    return {
      verdict: 'NEEDS-SYNC',
      reason: 'No deploy marker — run sync-plugin.bat once to seed',
      contentIdentical: baseVerdict.contentIdentical ?? null,
    };
```

```js
    return {
      verdict: 'NEEDS-SYNC',
      reason: `Marker shows manifest=${p.manifestVersion ?? '?'} uplugin=${p.upluginVersion ?? '?'}, repo has manifest=${i.manifestVersion ?? '?'} uplugin=${i.upluginVersion ?? '?'}`,
      contentIdentical: baseVerdict.contentIdentical ?? null,
    };
```

- [ ] **Step 6: Feed the classifier its new inputs**

Replace `gatherTargetMetrics` (lines 311-369) with a `(target, ctx)` form — one call site, in `main`:

```js
/**
 * Everything known about one target: deployed content, DLL, marker, editors.
 * `target` is { uprojectPath, alias }; `ctx` carries the per-run values that
 * are identical for every target.
 */
function gatherTargetMetrics(target, ctx) {
  const { uprojectPath, alias } = target;
  const { repoSrcMtime, repoSourceHash, editorProcs, activeMcpRoot, incomingState } = ctx;
  const targetDir = dirname(uprojectPath);
  const pluginDir = join(targetDir, 'Plugins', 'UEMCP');
  const deployedSrcDir = join(pluginDir, 'Source');
  const dllPath = join(pluginDir, 'Binaries', 'Win64', 'UnrealEditor-UEMCP.dll');

  const pluginDirExists = existsSync(pluginDir);
  const deployedSrcInfo = pluginDirExists ? newestMtimeSec(deployedSrcDir) : { mtimeSec: 0, fileCount: 0 };
  const dllExists = existsSync(dllPath);
  const dllMtime = dllExists ? Math.floor(statSync(dllPath).mtimeMs / 1000) : 0;
  const marker = pluginDirExists ? readDeployMarker(pluginDir) : null;
  const deployedSourceHash = pluginDirExists ? hashPluginTree(pluginDir) : null;

  const baseVerdict = classifyDeployState({
    pluginDirExists,
    deployedSrcMtime: deployedSrcInfo.mtimeSec,
    deployedSrcFileCount: deployedSrcInfo.fileCount,
    dllExists,
    dllMtime,
    repoSrcMtime,
    repoSourceHash,
    deployedSourceHash,
    markerSourceHash: marker?.sourceHash ?? null,
    markerSyncedAtMs: markerSyncedAtMs(marker),
  });

  // W-L marker overlay: stale or absent uplugin/manifest metadata still calls
  // for a sync even when the source bytes match.
  const markerVerdict = incomingState ? compareDeployMarker(marker, incomingState) : null;
  const verdict = applyMarkerVerdictOverlay(
    baseVerdict, marker, markerVerdict, incomingState,
    pluginDirExists, deployedSrcInfo.fileCount,
  );

  const targetUprojNorm = normalizePath(uprojectPath);
  const matchedEditors = editorProcs.filter((p) =>
    p.uprojectPath && normalizePath(p.uprojectPath) === targetUprojNorm
  );
  const mcpPointsHere = activeMcpRoot && normalizePath(activeMcpRoot) === normalizePath(targetDir);

  return {
    uprojectPath, alias, targetDir, pluginDir,
    deployedSrcMtime: deployedSrcInfo.mtimeSec,
    deployedSrcFileCount: deployedSrcInfo.fileCount,
    dllExists, dllMtime, deployedSourceHash,
    verdict, baseVerdict, marker, markerVerdict,
    matchedEditors, mcpPointsHere, repoSrcMtime,
  };
}
```

- [ ] **Step 7: Add the pure document builders**

Insert after `applyMarkerVerdictOverlay` (before the `normalizePath` re-export, ~line 207):

```js
/** 0 when every target is SYNC, 1 when any needs attention. Both printers use it. */
export function exitCodeForResults(results) {
  return results.some((r) => r.verdict.verdict !== 'SYNC') ? 1 : 0;
}

/**
 * One-line rendering of a target-selection failure, for the JSON error
 * document. The text printer keeps its multi-line guidance.
 */
export function selectionErrorMessage(selection) {
  const path = selection.targetsPath;
  if (selection.status === 'valid' && selection.candidates.length === 0) {
    return `No targets selected in ${path}`;
  }
  switch (selection.status) {
    case 'profile_not_found': {
      const available = selection.profile?.availableProfiles || [];
      const suffix = available.length > 0 ? ` (available: ${available.join(', ')})` : '';
      return `Profile not found: ${selection.profile?.name || '(none)'}${suffix}`;
    }
    case 'absent': return `Targets file not found: ${path}`;
    case 'empty': return `No targets selected in ${path}`;
    case 'invalid_config': return `Invalid targets config: ${path}`;
    case 'invalid_profile': return `Invalid profile: ${selection.profile?.name || '(none)'}`;
    default: return `Invalid targets: ${path}`;
  }
}

/**
 * The machine-readable verdict document. The pre-push gate's contract is this
 * shape — never the human printer's wording — so a reword cannot disarm it.
 */
export function buildJsonReport(targets, { profile = null, exitCode = 0 } = {}) {
  return {
    version: 1,
    profile: profile || null,
    targets: targets.map((t) => ({
      uprojectPath: t.uprojectPath,
      alias: t.alias ?? null,
      verdict: t.verdict.verdict,
      reason: t.verdict.reason,
      contentIdentical: t.verdict.contentIdentical ?? null,
      dllExists: !!t.dllExists,
      editors: (t.matchedEditors || []).map((e) => e.pid),
      mcpPointsHere: !!t.mcpPointsHere,
    })),
    exitCode,
  };
}

/** The document emitted when verify-deploy could not evaluate at all. */
export function buildJsonErrorReport(message) {
  return { version: 1, error: String(message), exitCode: 2 };
}
```

- [ ] **Step 8: Split `main` into a gatherer and two printers**

Replace `main` (lines 672-805) with the following. The text branch is a **pure move** of the existing body — relocate the lines, do not reword any output:

```js
/**
 * Resolve targets and gather every per-target metric. Shared by both printers
 * so text and JSON always report the same verdicts from the same inputs.
 * Returns { error, targetSelection } on a config failure.
 */
function gatherAllTargets(flags) {
  const targetSelection = resolveTargetSelection(flags);
  if (!targetSelectionIsUsable(targetSelection)) {
    return { error: selectionErrorMessage(targetSelection), targetSelection };
  }

  const repoSrcInfo = newestMtimeSec(PLUGIN_SRC_DIR);
  const headInfo = getHeadPluginCommitInfo();
  // Filesystem newest mtime is the comparison reference: xcopy preserves source
  // mtimes, so deployed files carry the repo file's mtime. See D138-FIX2 for
  // why the old Math.max with the commit time produced false staleness.
  const repoSrcMtime = repoSrcInfo.mtimeSec;
  const repoSrcLabel = `${repoSrcInfo.fileCount} files; HEAD plugin/Source commit ${headInfo.sha}`;
  const editorProcs = listEditorProcesses();
  const activeMcpRoot = readActiveMcpProjectRoot();

  let incomingState = null;
  let markerWarning = null;
  try {
    incomingState = computeIncomingState(REPO_ROOT);
  } catch (e) {
    markerWarning = `Marker comparison disabled: ${e.message}`;
  }
  // computeIncomingState already hashed the repo tree for the marker contract;
  // reuse it so a run pays for one walk, and only hash again if that failed.
  const repoSourceHash = incomingState?.sourceHash ?? hashPluginTree(REPO_PLUGIN_DIR);

  const ctx = { repoSrcMtime, repoSourceHash, editorProcs, activeMcpRoot, incomingState };
  const results = targetSelection.candidates.map((candidate) => gatherTargetMetrics(
    { uprojectPath: candidate.uprojectPath, alias: candidate.targetAlias || null },
    ctx,
  ));

  return { targetSelection, results, repoSrcMtime, repoSrcLabel, headInfo, editorProcs, activeMcpRoot, markerWarning };
}

/** Print exactly one JSON document to stdout and nothing else. */
function runJsonMode(flags) {
  if (flags.autoSync || flags.regenIdx !== null) {
    return emitJsonError('--auto-sync and --regenerate-mcp-json are not available with --json');
  }
  const gathered = gatherAllTargets(flags);
  if (gathered.error) return emitJsonError(gathered.error);
  const exitCode = exitCodeForResults(gathered.results);
  const report = buildJsonReport(gathered.results, {
    profile: gathered.targetSelection.profile?.name || null,
    exitCode,
  });
  console.log(JSON.stringify(report, null, 2));
  return exitCode;
}

function emitJsonError(message) {
  const doc = buildJsonErrorReport(message);
  console.log(JSON.stringify(doc, null, 2));
  return doc.exitCode;
}

function runTextMode(flags) {
  const gathered = gatherAllTargets(flags);
  if (gathered.error) {
    printTargetSelectionError(gathered.targetSelection);
    return 2;
  }
  const { targetSelection, results, repoSrcMtime, repoSrcLabel, headInfo, editorProcs, activeMcpRoot, markerWarning } = gathered;
  if (markerWarning) console.error(yellow('[WARN]') + ` ${markerWarning}`);

  console.log(bold('=== UEMCP verify-deploy ==='));
  console.log(`Repo                : ${REPO_ROOT}`);
  console.log(`Repo plugin source  : ${formatTime(repoSrcMtime)} ${dim('(' + repoSrcLabel + ')')}`);
  console.log(`HEAD plugin/Source  : ${headInfo.sha} ${dim(headInfo.subject)}`);
  printTargetSelectionHeader(targetSelection);
  printTargetSelectionWarnings(targetSelection);
  console.log(`Active .mcp.json    : ${activeMcpRoot ? activeMcpRoot : '(none / not found)'}`);
  console.log(`Editor processes    : ${editorProcs.length}${editorProcs.length > 0 ? dim(' — ' + editorProcs.map((e) => `pid ${e.pid}`).join(', ')) : ''}`);
  const targetUprojNorms = new Set(results.map((r) => normalizePath(r.uprojectPath)));
  const orphanEditors = editorProcs.filter((p) =>
    p.uprojectPath && !targetUprojNorms.has(normalizePath(p.uprojectPath))
  );
  if (orphanEditors.length > 0) {
    console.log(yellow('[WARN]') + ` Editor running against workspace not in targets list:`);
    for (const e of orphanEditors) console.log(`        pid ${e.pid} → ${e.uprojectPath}`);
    console.log(`        Add it to ${targetSelection.targetsPath} to track its deploy state.`);
  }
  console.log('');
  console.log(bold('Targets:'));
  for (let i = 0; i < results.length; i++) printSummaryLine(i, results[i], repoSrcMtime);

  if (!flags.quiet) {
    const nonSync = results.filter((r) => r.verdict.verdict !== 'SYNC' || r.matchedEditors.length > 0);
    if (nonSync.length > 0 || results.length <= 3) {
      console.log('');
      console.log(bold('Details:'));
      for (let i = 0; i < results.length; i++) {
        if (results[i].verdict.verdict !== 'SYNC' || results.length <= 3) {
          printTargetDetail(i, results[i], repoSrcMtime, repoSrcLabel);
        }
      }
    }
  }

  const actionCode = runTextActions(flags, results);
  if (actionCode !== 0) return actionCode;

  const exitCode = exitCodeForResults(results);
  console.log('');
  if (exitCode !== 0) {
    console.log(red(bold('VERDICT: NOT-SYNC')) + ` — ${results.filter((r) => r.verdict.verdict !== 'SYNC').length} of ${results.length} target(s) need attention.`);
    return 1;
  }
  console.log(green(bold('VERDICT: ALL-SYNC')) + ` — ${results.length} target(s) match repo source.`);
  return 0;
}

/** --auto-sync and --regenerate-mcp-json. Returns a non-zero code only on failure. */
function runTextActions(flags, results) {
  if (flags.autoSync) {
    console.log('');
    console.log(bold('--auto-sync: running sync-plugin.bat for stale targets...'));
    const stale = results.filter((r) => ['NEEDS-SYNC', 'NEEDS-DEPLOY'].includes(r.verdict.verdict));
    if (stale.length === 0) console.log(dim('  (no targets need sync)'));
    for (const t of stale) {
      if (t.matchedEditors.length > 0) {
        console.log(yellow('  [SKIP]') + ` ${t.uprojectPath} — editor locked (close it first)`);
        continue;
      }
      const code = runSyncPlugin(t.uprojectPath);
      if (code === 0) console.log(green('  [OK]') + ` Synced: ${t.uprojectPath}`);
      else console.log(red('  [FAIL]') + ` sync-plugin.bat exited ${code}: ${t.uprojectPath}`);
    }
    console.log(dim('  Note: sync-plugin.bat propagates source only. Run Build.bat next to rebuild the DLL.'));
  }

  if (flags.regenIdx !== null) {
    console.log('');
    console.log(bold(`--regenerate-mcp-json ${flags.regenIdx}:`));
    if (!Number.isInteger(flags.regenIdx) || flags.regenIdx < 1 || flags.regenIdx > results.length) {
      console.error(red('[ERROR]') + ` Index out of range (1..${results.length}): ${flags.regenIdx}`);
      return 2;
    }
    const rc = regenerateMcpJson(results[flags.regenIdx - 1].uprojectPath);
    if (rc !== 0) return rc;
  }
  return 0;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { printHelp(); return 0; }
  if (flags.watch) return runWatchMode(flags);
  if (flags.json) return runJsonMode(flags);
  return runTextMode(flags);
}
```

- [ ] **Step 9: Wire the `--json` flag**

In `parseArgs`, add `json: false,` to the `flags` object, add the branch, and make the unknown-arg branch honour the flag even though it has not been parsed yet:

```js
    else if (a === '--json') { flags.json = true; useColor = false; }
```

```js
    else {
      // --json may not have been reached yet; the caller still gets a document.
      if (argv.includes('--json')) {
        console.log(JSON.stringify(buildJsonErrorReport(`Unknown arg: ${a}`), null, 2));
        process.exit(2);
      }
      console.error(red('[ERROR]') + ` Unknown arg: ${a}`);
      process.exit(2);
    }
```

In `printHelp`, add to the flags list after `--no-color`:

```
  --json                     print one JSON verdict document to stdout and
                             nothing else. Implies --no-color; ignores --quiet;
                             not combinable with --auto-sync or
                             --regenerate-mcp-json; ignored in --watch mode.
                             Consumed by .githooks/pre-push.
```

Add the same line to the module header's flag list (lines 19-30), and extend the header's "Pure functions ... are exported for testing" note (line 32) to mention `buildJsonReport` / `buildJsonErrorReport` / `selectionErrorMessage` / `exitCodeForResults`.

- [ ] **Step 10: Run the tests to verify they pass**

Run: `cd D:/DevTools/UEMCP/server && node test-verify-deploy.mjs`
Expected: `Passed: 95`, `Failed: 0`, `Total: 95` (50 − 5 + 50).

- [ ] **Step 11: Import check and a text-mode eyeball**

Run the import check on `verify-deploy.mjs test-verify-deploy.mjs`. Expected: no output.

Then confirm the human output is byte-for-byte the same shape as before the split (read the profile names from `.uemcp-targets.json` without editing it):

Never stash to get the "before" side — the working tree holds uncommitted work at this point. Read the previous version out of git instead, which cannot touch the working tree:

```bash
cd D:/DevTools/UEMCP
node -e "const c=JSON.parse(require('node:fs').readFileSync('.uemcp-targets.json','utf8'));console.log(Object.keys(c.profiles||{}).join(' '))"
git show HEAD:server/verify-deploy.mjs > "$SCRATCH/vd-before.mjs"
node "$SCRATCH/vd-before.mjs" --no-color > "$SCRATCH/text-before.txt" 2>&1; echo "before rc=$?"
node server/verify-deploy.mjs --no-color > "$SCRATCH/text-after.txt" 2>&1; echo "after rc=$?"
diff "$SCRATCH/text-before.txt" "$SCRATCH/text-after.txt"
```

Expected: the only differences are verdict/reason lines that changed **because** of the content rule (a `NEEDS-DEPLOY — DLL predates HEAD source` becoming `SYNC — content-identical to repo; DLL built after the last sync`) and the timestamps in the header. Any change to the *layout* — a missing line, a reordered block, a different label — is a regression in the move; fix it before continuing.

`$SCRATCH/vd-before.mjs` resolves its own `REPO_ROOT` from its location, so run it only to compare layout; ignore any path it prints. If it fails to start for that reason, drop the "before" side and instead read `$SCRATCH/text-after.txt` directly, confirming all four blocks are present and in order: the header (`=== UEMCP verify-deploy ===` through `Editor processes`), `Targets:`, `Details:`, and the final `VERDICT:` line.

- [ ] **Step 12: Confirm the JSON document against real targets**

```bash
cd D:/DevTools/UEMCP
node server/verify-deploy.mjs --json > "$SCRATCH/gate.json"; echo "rc=$?"
node -e "const d=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));console.log(d.version,d.profile,d.exitCode,d.targets.map(t=>[t.alias,t.verdict,t.contentIdentical,t.dllExists].join('/')).join(' | '))" "$SCRATCH/gate.json"
```

Expected: parses; `rc` equals the document's `exitCode`; every target row has a boolean `dllExists` and a `contentIdentical` of `true`, `false` or `null`. `$SCRATCH/gate.json` contains machine-local absolute paths — it stays in scratch and is never committed or pasted into a tracked file.

- [ ] **Step 13: Rotation and commit**

```bash
cd D:/DevTools/UEMCP/server
node run-rotation.mjs --json > "$SCRATCH/gate-t3.json"
node -e "const j=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify(j.aggregate),'importErrors',j.importErrorCount,'crashes',j.crashCount)" "$SCRATCH/gate-t3.json"
```

Expected: `{"passed":7654,"failed":0,"total":7654} importErrors 0 crashes 0`.

```bash
cd D:/DevTools/UEMCP
git add server/verify-deploy.mjs server/test-verify-deploy.mjs
git commit -m "Decide deploy verdicts by plugin content and emit a --json verdict document"
```

---

### Task 4: The hook reads JSON; docs record it

**Files:**
- Modify: `.githooks/pre-push` (add `gate_parser` near line 80; replace the gate body, lines 119-155)
- Modify: `server/test-pre-push-gate.mjs`
- Modify: `CLAUDE.md` (lines 73, 323, 419, 421)
- Modify: `docs/tracking/backlog.md` (EN-26 and EN-27 headings)

**Interfaces:**
- Consumes: `verify-deploy.mjs --json`'s document — `targets[].verdict`, `targets[].dllExists`, `targets[].alias`, `targets[].reason`, and a top-level `error` on failure.
- Produces: `gate_parser`, a bash variable holding a single-line `node -e` program whose exit codes are the hook's contract — **0** nothing blocking, **1** at least one blocking target (printed one per line on stdout), **2** the document is unusable and the gate must warn rather than block.

- [ ] **Step 1: Write the failing test**

Replace `server/test-pre-push-gate.mjs` entirely:

```js
// test-pre-push-gate.mjs — structural and behavioural guard for the compile
// gate in .githooks/pre-push. The rotation cannot perform a push, so this
// pins two things instead: the shape of the hook (bypass vars, the --json
// invocation, the branches on the reader's exit codes) and the behaviour of
// the reader itself — the gate_parser program is extracted from the hook and
// executed against canned documents, because bash -n checks shell syntax and
// would not notice a typo inside that single-quoted JavaScript.
//
// Modelled on test-sync-plugin-bat-safety.mjs.
// Run: cd server && node test-pre-push-gate.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('pre-push compile gate Tests');

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hookPath = join(repoRoot, '.githooks', 'pre-push');
const hookText = readFileSync(hookPath, 'utf8');
const lines = hookText.split('\n');

t.assert(hookText.includes('UEMCP_SKIP_COMPILE_GATE'), 'hook names the UEMCP_SKIP_COMPILE_GATE bypass');
t.assert(hookText.includes('UEMCP_PUSH_GATE_PROFILE'), 'hook names the UEMCP_PUSH_GATE_PROFILE override');

const verifyDeployLine = lines.find((line) => line.includes('verify-deploy.mjs'));
t.assert(!!verifyDeployLine, 'hook contains a line invoking verify-deploy.mjs');
t.assert(!!verifyDeployLine && verifyDeployLine.includes('--json'), 'verify-deploy invocation passes --json');
t.assert(!!verifyDeployLine && verifyDeployLine.includes('< /dev/null'), 'verify-deploy invocation redirects stdin from /dev/null');

// The prose contract is retired: a reword of verify-deploy's printer must no
// longer be able to change what the gate decides.
t.assert(!hookText.includes('Verdict: (NEEDS-SYNC'), 'hook no longer greps the human Verdict prefix');
t.assert(
  !hookText.includes('DLL missing') && !hookText.includes('not built'),
  'hook no longer greps the never-built reason substrings',
);

const parserMatch = hookText.match(/^gate_parser='(.*)'$/m);
t.assert(!!parserMatch, 'hook defines gate_parser on one single-quoted line');
const parser = parserMatch ? parserMatch[1] : '';
t.assert(
  ['NEEDS-SYNC', 'NEEDS-BUILD', 'NEEDS-DEPLOY'].every((v) => parser.includes(v)),
  'gate_parser names all three blocking verdicts',
);
t.assert(parser.includes('t.dllExists===true'), 'gate_parser blocks only on targets whose DLL exists');
t.assert(hookText.includes('"$gate_parse_rc" == "1"'), 'hook blocks the push on reader exit 1');
t.assert(hookText.includes('"$gate_parse_rc" != "0"'), 'hook warns without blocking on any other reader exit');
t.assert(hookText.includes('compile gate could not evaluate'), 'hook contains the could-not-evaluate warning phrase');

const bashCheck = spawnSync('bash', ['-n', hookPath], { encoding: 'utf8' });
if (bashCheck.error && bashCheck.error.code === 'ENOENT') {
  t.assert(true, 'bash -n .githooks/pre-push — SKIPPED (bash not on PATH on this machine)');
} else {
  t.assert(bashCheck.status === 0, 'bash -n .githooks/pre-push exits 0', bashCheck.stderr);
}

// ─── The reader actually runs ───────────────────────────────────────
const runParser = (doc) => spawnSync(process.execPath, ['-e', parser], { input: doc, encoding: 'utf8' });

const allSync = JSON.stringify({
  version: 1, profile: 'smoke', exitCode: 0,
  targets: [{ uprojectPath: 'path/to/YourProject.uproject', alias: 'primary', verdict: 'SYNC', reason: 'content-identical to repo; DLL built after the last sync', contentIdentical: true, dllExists: true, editors: [], mcpPointsHere: false }],
});
t.assert(runParser(allSync).status === 0, 'reader exits 0 for an all-SYNC document');

const blocking = JSON.stringify({
  version: 1, profile: 'smoke', exitCode: 1,
  targets: [{ uprojectPath: 'path/to/YourProject.uproject', alias: 'primary', verdict: 'NEEDS-BUILD', reason: 'content-identical to repo; DLL predates the last sync', contentIdentical: true, dllExists: true, editors: [], mcpPointsHere: false }],
});
const blockingRun = runParser(blocking);
t.assert(
  blockingRun.status === 1 && blockingRun.stdout.includes('primary') && blockingRun.stdout.includes('NEEDS-BUILD'),
  'reader exits 1 and names the blocking target',
  blockingRun.stdout,
);

const neverBuilt = JSON.stringify({
  version: 1, profile: 'smoke', exitCode: 1,
  targets: [{ uprojectPath: 'path/to/SecondProject.uproject', alias: 'second', verdict: 'NEEDS-BUILD', reason: 'Source synced but DLL not built', contentIdentical: null, dllExists: false, editors: [], mcpPointsHere: false }],
});
t.assert(runParser(neverBuilt).status === 0, 'reader ignores a never-built target (dllExists false)');

t.assert(
  runParser(JSON.stringify({ version: 1, error: 'Profile not found: nope', exitCode: 2 })).status === 2,
  'reader exits 2 for an error document',
);
t.assert(runParser('not json at all').status === 2, 'reader exits 2 for unparseable input');

process.exit(t.summary());
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd D:/DevTools/UEMCP/server && node test-pre-push-gate.mjs`
Expected: FAIL on `hook defines gate_parser on one single-quoted line`, on the `--json` assertion, and on the prose-retirement assertions.

- [ ] **Step 3: Add the reader to the hook**

In `.githooks/pre-push`, immediately after `gate_checked=0` (line 80), insert:

```bash
# The compile gate's verdict reader. Consumes a verify-deploy --json document
# on stdin and exits 0 (nothing blocking), 1 (blocking targets, one per line on
# stdout) or 2 (document unusable — the caller warns instead of blocking).
# Kept on one single-quoted line so it carries no shell-special characters and
# so server/test-pre-push-gate.mjs can extract and execute it.
gate_parser='let s="";process.stdin.on("data",d=>{s+=d}).on("end",()=>{let j;try{j=JSON.parse(s)}catch{process.exit(2)}if(!j||j.error||!Array.isArray(j.targets)){process.exit(2)}const blocking=["NEEDS-SYNC","NEEDS-BUILD","NEEDS-DEPLOY"];const bad=j.targets.filter(t=>t.dllExists===true&&blocking.indexOf(t.verdict)!==-1);for(const t of bad){console.log("      "+(t.alias||t.uprojectPath)+": "+t.verdict+" - "+t.reason)}process.exit(bad.length?1:0)})'
```

- [ ] **Step 4: Replace the gate body**

Step 3 inserted lines, so match on text rather than line numbers. In `.githooks/pre-push`, replace the block that starts at the line `        gate_rc=0` and ends at the `        fi` closing the `elif [[ -n "$stale" ]]` branch — five statements plus that `if`/`elif`/`fi` — with:

```bash
        gate_rc=0
        gate_json="$(node server/verify-deploy.mjs --json ${gate_profile:+--profile "$gate_profile"} < /dev/null 2>/dev/null)" || gate_rc=$?
        gate_parse_rc=0
        stale="$(printf '%s' "$gate_json" | node -e "$gate_parser" 2>/dev/null)" || gate_parse_rc=$?
        if [[ "$gate_parse_rc" == "1" ]]; then
          {
            echo ""
            echo "✗ Push blocked: plugin source changed but a target has not been rebuilt ($range_label)"
            echo ""
            printf '%s\n' "$stale"
            echo ""
            echo "  Run sync-plugin.bat / Build.bat for the target, or bypass with 'git push --no-verify'"
            echo "  (or UEMCP_SKIP_COMPILE_GATE=1). Gate profile: ${gate_profile:-default}."
            echo ""
          } >&2
          exit 1
        elif [[ "$gate_parse_rc" != "0" ]]; then
          # The document was unusable — a bad --profile, a missing node, a
          # crash. That is a config problem on this machine, not evidence of a
          # stale build. Warn, never block.
          echo "  (compile gate could not evaluate: verify-deploy exited $gate_rc; profile: ${gate_profile:-default})" >&2
        fi
```

Update the block comment above the gate — the paragraph beginning `# Plugin compile gate (WS2):` — so it describes the JSON contract:

```bash
  # Plugin compile gate (WS2): refuse to publish plugin source that a local
  # target has built before but not since. Reads verify-deploy's --json
  # document, never its human output: a target blocks when its verdict is
  # NEEDS-SYNC, NEEDS-BUILD or NEEDS-DEPLOY *and* dllExists is true. Targets
  # that were never built here have no stale build to report and are ignored,
  # as are MISSING ones. Bypass: git push --no-verify or
  # UEMCP_SKIP_COMPILE_GATE=1.
```

Keep the two paragraphs after it (fail-closed ordering, once-per-push evaluation) unchanged.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd D:/DevTools/UEMCP/server && node test-pre-push-gate.mjs`
Expected: `Passed: 19`, `Failed: 0`, `Total:  19`.

- [ ] **Step 6: Probe the live hook — a plugin-touching range that should pass**

The gate is live on this machine, so exercise it before pushing anything.

```bash
cd D:/DevTools/UEMCP
SHA="$(git log --format=%H -1 -- plugin/UEMCP/Source)"
LINE="refs/heads/probe $(git rev-parse "$SHA") refs/heads/probe $(git rev-parse "$SHA~1")"
printf '%s\n' "$LINE" | bash .githooks/pre-push origin https://example.invalid/x.git; echo "probe1 rc=$?"
```

Expected: `probe1 rc=0` with no gate output, when every built target in the gate profile is SYNC. If a target genuinely needs a rebuild the hook blocks with `✗ Push blocked` and names it — that is the gate working; record it and move on. **Do not edit `.uemcp-targets.json` to make this probe pass.**

- [ ] **Step 7: Probe — a profile that does not exist**

Shell state does not survive between commands, so recompute `LINE` in every probe.

```bash
cd D:/DevTools/UEMCP
SHA="$(git log --format=%H -1 -- plugin/UEMCP/Source)"
LINE="refs/heads/probe $(git rev-parse "$SHA") refs/heads/probe $(git rev-parse "$SHA~1")"
printf '%s\n' "$LINE" | UEMCP_PUSH_GATE_PROFILE=nope bash .githooks/pre-push origin https://example.invalid/x.git; echo "probe2 rc=$?"
```

Expected: `probe2 rc=0` and one line on stderr containing `(compile gate could not evaluate:` with `profile: nope`. A bad profile must warn, never block.

- [ ] **Step 8: Probe — the bypass**

```bash
cd D:/DevTools/UEMCP
SHA="$(git log --format=%H -1 -- plugin/UEMCP/Source)"
LINE="refs/heads/probe $(git rev-parse "$SHA") refs/heads/probe $(git rev-parse "$SHA~1")"
printf '%s\n' "$LINE" | UEMCP_SKIP_COMPILE_GATE=1 bash .githooks/pre-push origin https://example.invalid/x.git; echo "probe3 rc=$?"
```

Expected: `probe3 rc=0` and no gate output at all — neither a block nor the could-not-evaluate line.

- [ ] **Step 9: The EN-27 live proof**

```bash
cd D:/DevTools/UEMCP
node server/verify-deploy.mjs --no-color | grep -A1 'Verdict:'
touch plugin/UEMCP/Source/UEMCP/Private/MCPServerRunnable.cpp
node server/verify-deploy.mjs --no-color | grep -A1 'Verdict:'
```

Expected: a target that was `SYNC` before the `touch` is still `SYNC` after it, with the reason `content-identical to repo; DLL built after the last sync`. Before this branch the second run reported `NEEDS-DEPLOY — DLL predates HEAD source` for every built target.

`touch` changes no bytes, so there is nothing to restore; the advanced mtime is harmless and is exactly the condition being proved. If `setup-watcher.bat` is running it will see the change and sync — stop it first if so. Record this proof as **not run** if no target in the profile has a built DLL; do not add or build one for the probe.

- [ ] **Step 10: Update the docs**

In `CLAUDE.md`, replace the final sentence of the Native-plugin-tests paragraph (line 421, beginning `The pre-push hook refuses to publish plugin source`) with:

```
The pre-push hook refuses to publish plugin source while any built target in the gate profile (`smoke` when present, else default; `UEMCP_PUSH_GATE_PROFILE` overrides) reports NEEDS-SYNC / NEEDS-BUILD / NEEDS-DEPLOY. It reads `node server/verify-deploy.mjs --json` and blocks on `verdict` plus `dllExists`, never on the human output, so never-built targets are ignored and a reformat of the printer cannot disarm the gate; a target whose deployed plugin tree is byte-identical to the repo reads SYNC whatever the file timestamps say (EN-27), so a merge or checkout no longer forces a rebuild. Bypass with `--no-verify` or `UEMCP_SKIP_COMPILE_GATE=1`.
```

In the `verify-deploy.bat` bullet (line 323), extend the flags list:

```
Flags: `--profile <name>`, `--auto-sync`, `--regenerate-mcp-json N`, `--quiet`, `--targets <path>`, `--no-color`, `--json` (one machine-readable verdict document to stdout; what `.githooks/pre-push` consumes).
```

Update both rotation-count sentences (line 73 and line 419) from `**7580 unit-runnable assertions project-less ... across 79 rotation test files**` to `**7662 unit-runnable assertions project-less ... across 80 rotation test files**`, leaving the rest of each sentence untouched.

In `docs/tracking/backlog.md`, append ` — **DONE 2026-09**` to both headings:

```
### EN-26 — Machine-readable verify-deploy output for the pre-push compile gate — **DONE 2026-09**
```

```
### EN-27 — Pre-push compile gate: false NEEDS-DEPLOY after a checkout or merge — **DONE 2026-09**
```

- [ ] **Step 11: Rotation, codename scan, commit**

```bash
cd D:/DevTools/UEMCP/server
node run-rotation.mjs --json > "$SCRATCH/gate-t4.json"
node -e "const j=JSON.parse(require('node:fs').readFileSync(process.argv[1],'utf8'));console.log(JSON.stringify(j.aggregate),'files',j.files.length,'importErrors',j.importErrorCount,'noSummary',j.noSummaryCount)" "$SCRATCH/gate-t4.json"
npx eslint .
```

Expected: `{"passed":7662,"failed":0,"total":7662} files 80 importErrors 0 noSummary 0`; eslint prints nothing.

```bash
cd D:/DevTools/UEMCP
export LC_ALL=C.UTF-8
grep -v '^#' .git/info/forbidden-tokens | grep -v '^regex:' | grep -v '^\s*$' > "$SCRATCH/tokens.txt"
git diff -- . | grep -i -F -f "$SCRATCH/tokens.txt"; echo "literal grep exit=$? (1 means clean)"
grep '^regex:' .git/info/forbidden-tokens | sed 's/^regex://' > "$SCRATCH/token-res.txt"
git diff -- . | grep -i -E -f "$SCRATCH/token-res.txt"; echo "regex grep exit=$? (1 means clean)"
```

Expected: both `exit=1`. The regex list includes a pattern that matches the bare word "temp" — if it fires, a scratch path leaked into a tracked file; rewrite it as `$SCRATCH/...` before committing.

```bash
cd D:/DevTools/UEMCP
git add .githooks/pre-push server/test-pre-push-gate.mjs CLAUDE.md docs/tracking/backlog.md
git commit -m "Pre-push compile gate reads the verify-deploy JSON document instead of its prose"
git status --short
```

Expected: `git status --short` prints nothing. Note the gate does not evaluate this branch's own push: none of these four commits touches `plugin/UEMCP/Source/` or the `.uplugin`.

---

## Verification summary

| After | Rotation total | Files | New/changed suites |
|---|---|---|---|
| Baseline | 7,580 | 79 | — |
| Task 1 | **7,597** | 80 | `test-plugin-content-hash.mjs` 17 (new) |
| Task 2 | **7,609** | 80 | `test-sync-plugin-helper.mjs` 36 → 48 |
| Task 3 | **7,654** | 80 | `test-verify-deploy.mjs` 50 → 95 |
| Task 4 | **7,662** | 80 | `test-pre-push-gate.mjs` 11 → 19 |

Manual proofs, all in Task 4: three hook probes (pass silently / could-not-evaluate on a bogus profile / silent under the bypass) and the EN-27 `touch` proof. None of them may modify `.uemcp-targets.json`.
