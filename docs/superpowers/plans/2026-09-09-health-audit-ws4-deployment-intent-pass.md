# WS4: `server/deployment/` Intent Pass and Transaction Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every module and closure factory under `server/deployment/` a stated intent, and break the 1,013-line `createClientTransaction` closure into cluster modules over an explicit state object, with no behavior change.

**Architecture:** Two independent halves. The comment pass adds a head comment to all 33 modules and a boundary comment to the 12 true closure factories. The decomposition moves the private helpers at the top of `client-transaction.mjs` into `transaction-common.mjs`, then extracts three cluster factories, `createTransactionPins`, `createTransactionStage`, `createTransactionSnapshot`, each taking the shared `state` object and the closures it depends on, so every moved function body stays byte-identical and only its enclosing scope changes. `client-transaction.mjs` keeps `apply`, `rollback`, the adapter-facing capability object, and its public exports. The bundle is regenerated in every commit that touches the subsystem because the tracked manifest hashes every first-party source file.

**Tech Stack:** Node 22 ES modules; esbuild 0.28.1 (pinned by the bundle test); rotation runner; the ad-hoc ESLint import check.

**Spec:** `docs/superpowers/specs/2026-09-09-health-audit-remediation-design.md` §4 WS4. Deviation recorded: a fourth module, `transaction-common.mjs`, holds the private helpers every cluster shares; the spec's three cluster modules are unchanged.

## Global Constraints
- Scratch files: set `SCRATCH="$(mktemp -d)"` once per shell before the first task; every `$SCRATCH/...` path below refers to it. Never write scratch output into the repo.
- Behavior-preserving. Moved function bodies are pasted verbatim. Only the enclosing factory, its parameter destructuring, imports, and `export` keywords change.
- Public surface of `client-transaction.mjs` is unchanged: `ClientTransactionError`, `captureClientPathFingerprint`, `createClientTransaction` with the same options and the same frozen `{ snapshot, apply, rollback }` return. Adapters and `deploy-uemcp.mjs` import `captureClientPathFingerprint` from it and must keep working untouched.
- No change to the machine-interface contract (`docs/specs/deployment-machine-interface.md`).
- Every commit that changes any file under `server/deployment/` regenerates the bundle first: `cd D:/DevTools/UEMCP/server && npm run build:deployment` (prints `Built 3 deployment artifacts.`), then `git add ../dist`. `test-deployment-bundle.mjs` fails otherwise because `dist/deploy-uemcp.manifest.json` records a hash per source file.
- Verification suites for every decomposition task: `test-client-transaction.mjs` (8-minute rotation budget; run it alone), `test-client-adapters.mjs`, `test-installed-client-contracts.mjs`, `test-deployment-bundle.mjs`. All must print `Failed: 0`.
- Rotation baseline: 7,533 passed after WS3 (7,532 if WS3 has not landed). No task in this plan changes the count.
- Comment intent, not implementation. A head comment says what the module is for, why it exists, and what it depends on; it never restates a function signature.
- Codename hygiene; no AI attribution; one commit per task.
- **The import check** (from `server/`; substitute the files):

```bash
G="process,Buffer,console,URL,TextDecoder,TextEncoder,setTimeout,clearTimeout,setImmediate,structuredClone,performance,AbortController,queueMicrotask"
npx eslint --no-config-lookup --rule "no-undef: 2" --rule "no-unused-vars: [2, {argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none'}]" --global "$G" deployment/client-transaction.mjs deployment/transaction-common.mjs
```

Zero problems is the pass condition for this subsystem (it has no pre-existing dead code).

## File Structure

| File | Responsibility |
|---|---|
| `server/deployment/transaction-common.mjs` (new) | Constants, `ClientTransactionError`, and every module-level helper from lines 27–390 of the pre-split `client-transaction.mjs`, all exported |
| `server/deployment/transaction-pins.mjs` (new) | `createTransactionPins`: fingerprint capture, lease release, pinned directories and records, parent revalidation and creation, metadata-preserving replace, and the two bookkeeping helpers the stage cluster needs |
| `server/deployment/transaction-stage.mjs` (new) | `createTransactionStage`: `writeFile`, staged writes, stage inspection and cleanup, the ownership ledger |
| `server/deployment/transaction-snapshot.mjs` (new) | `createTransactionSnapshot`: `snapshot`, restore, deferred deletes, created-directory cleanup, evidence pinning, pre and post rechecks |
| `server/deployment/client-transaction.mjs` (shrinks) | Option validation, `state`, composition of the three clusters, the adapter capability object, `apply`, `rollbackInternal`, `rollback`, re-exports |

Cluster assignment of every inner function (original line ranges in the pre-split file):

| Cluster | Functions |
|---|---|
| PINS | `capture` 439–446, `releaseLease` 448–455, `withPinnedDirectory` 463–470, `revalidateRecordParents` 472–495, `withPinnedRecord` 497–511, `createMissingParents` 513–543, `replaceExisting` 545–553, `markChanged` 555–563, `currentOperation` 565–569 |
| STAGE | `writeFile` 571–644, `safeStageRelativePath` 646–650, `nativeStagePaths` 652–659, `removeDetachedStage` 661–689, `detachAndRemoveStageParent` 691–711, `cleanupAbandonedStages` 713–735, `inspectStage` 737–761, `removeStage` 763–772, `runStagedWrite` 774–848, `ownershipPath` and `ownershipLedger` 867–883 |
| SNAPSHOT | `deleteSnapshot` 457–461, `deleteFileAfterVerify` 850–865, `snapshot` 887–1025, `recheckBeforeApply` 1027–1036, `recheckAfterVerify` 1038–1050, `withPinnedTransactionEvidence` 1052–1082, `commitDeferredDeletes` 1084–1108, `cleanupCreatedDirectories` 1110–1140, `restoreRecord` 1142–1220 |
| stays in `client-transaction.mjs` | option validation 401–419, `state` 421–437, `transactionCapability` 885, `rollbackInternal` 1222–1293, `apply` 1295–1396, `rollback` 1398–1401, the return 1403 |

Dependency order: pins depends on common only; stage depends on common and pins; snapshot depends on common, pins and stage; `client-transaction.mjs` depends on all four. No other edge is permitted.

---

### Task 1: Module head comments (33 files)

**Files:**
- Modify: every `.mjs` under `server/deployment/` and `server/deployment/adapters/`
- Modify: `dist/deploy-uemcp.mjs`, `dist/deploy-uemcp.manifest.json`, `dist/THIRD_PARTY_NOTICES.txt` (regenerated)

**Interfaces:**
- Consumes: nothing.
- Produces: nothing programmatic.

- [ ] **Step 1: Add a head comment to each module**

Read the module, then insert at line 1 a comment of three to six lines in this shape (the adapter example is real, not a template to copy verbatim):

```js
// adapters/claude.mjs — the Claude Desktop / Claude Code client adapter.
// Why: each client stores its MCP server list in its own file and format; this
// adapter is the only place that knows Claude's paths, JSON shape and native
// mutation behavior, so the orchestrator can treat all clients alike.
// Depends on: client-transaction (writes), client-contract (identities),
// jsonc-config (patching), process-runner (launch checks).
```

Seed first lines per module; expand each into what/why/depends-on after reading the code, and correct the seed if the code says otherwise:

| Module | Seed |
|---|---|
| `adapters/claude.mjs` | Claude Desktop / Claude Code adapter over its JSON settings |
| `adapters/codex.mjs` | Codex adapter over its TOML config |
| `adapters/gemini.mjs` | Gemini CLI adapter over settings and extensions |
| `adapters/vscode.mjs` | VS Code adapter over JSONC settings |
| `bounded-config-file.mjs` | Size-bounded reads of client config files so a huge or corrupt file cannot stall a deploy |
| `bounded-stdio-transport.mjs` | MCP stdio client transport with output limits and close deadlines, for smoke-testing a launched server |
| `bundle-freshness.mjs` | Verifies the tracked `dist/` bundle matches its manifest and first-party sources |
| `canonical-json.mjs` | Canonical JSON serialization and SHA-256 helpers for digests |
| `client-contract.mjs` | The client launch contract: identities, environment overlays, version classification, validators |
| `client-decisions.mjs` | Reads per-client decisions from an apply context |
| `client-discovery.mjs` | Discovers installed clients and selects which ones an operation targets |
| `client-domain.mjs` | The client deployment domain: plans, applies, verifies per-client config through adapters inside one transaction |
| `client-ids.mjs` | The canonical client id list |
| `client-process.mjs` | Runtime fingerprinting and pinned launching of client processes |
| `client-transaction.mjs` | Staged, fingerprinted, rollback-capable config writes shared by every adapter |
| `config-bytes.mjs` | Byte limits and decoding rules for config files |
| `contracts.mjs` | Deployment schema constants, outcomes, exit codes, and contract validators |
| `descriptor.mjs` | The canonical MCP server descriptor (command, args, env) written into client configs |
| `fingerprints.mjs` | File and directory fingerprints that detect concurrent modification |
| `jsonc-config.mjs` | JSONC parse and patch that preserves comments and formatting |
| `local-state.mjs` | The local install-state root: apply leases, snapshots, journals, applied-digest records |
| `orchestrator.mjs` | Top-level plan, apply, verify, doctor and repair across domains |
| `ownership-ledger.mjs` | Records which config entries UEMCP owns so foreign entries are never overwritten |
| `plan-document.mjs` | Plan document construction, digest, and validation for approve-then-apply |
| `prerequisites.mjs` | Node runtime and dependency checks and their install operations |
| `process-runner.mjs` | Bounded child-process runner with timeouts and process-tree kill |
| `protocol-smoke.mjs` | Launches the descriptor and performs an MCP handshake as the protocol smoke test |
| `receipts.mjs` | Receipts of applied operations, written and verified |
| `redaction.mjs` | Secret redaction and canary checks for anything that reaches logs or results |
| `source-provenance.mjs` | Identifies the UEMCP source checkout for provenance |
| `target-domain.mjs` | The target-project domain: registers project targets and profiles |
| `toml-config.mjs` | TOML parse and patch for the Codex config |
| `windows-native.mjs` | Windows-specific pinned file operations and metadata via embedded PowerShell |

- [ ] **Step 2: Confirm every module now starts with a comment**

Run: `cd D:/DevTools/UEMCP/server && for f in deployment/*.mjs deployment/adapters/*.mjs; do head -c 2 "$f" | grep -q '//' || echo "MISSING: $f"; done; echo "(no MISSING lines expected)"`
Expected: no `MISSING` lines.

- [ ] **Step 3: Lint, regenerate the bundle, run the bundle test**

Run: `npx eslint . && npm run build:deployment && node test-deployment-bundle.mjs | tail -5`
Expected: lint silent; `Built 3 deployment artifacts.`; `Failed: 0`.

- [ ] **Step 4: Commit**

```bash
cd D:/DevTools/UEMCP
git add server/deployment dist
git commit -m "Deployment: state each module's intent and dependencies in a head comment"
```

### Task 2: Closure-factory boundary comments (12 factories)

**Files:**
- Modify: `adapters/claude.mjs` (`createClaudeAdapter`), `adapters/codex.mjs` (`createCodexAdapter`), `adapters/gemini.mjs` (`createGeminiAdapter`), `adapters/vscode.mjs` (`createVsCodeAdapter`), `client-domain.mjs` (`createClientDomain`), `client-transaction.mjs` (`createClientTransaction`), `local-state.mjs` (`createApplyLeaseCoordinator`, `createLocalState`), `orchestrator.mjs` (`createDeploymentOrchestrator`), `prerequisites.mjs` (`createPrerequisiteDomain`), `process-runner.mjs` (`createProcessRunner`), `target-domain.mjs` (`createTargetDomain`)
- Modify: `dist/*` (regenerated)

- [ ] **Step 1: Add a boundary comment directly above each factory**

Shape (real example for `createClientTransaction`):

```js
// Factory boundary. Everything below closes over one mutable `state` (phase,
// lease, plan and operation digests, per-path records, changed order, created
// directories, deferred deletes, current client). Invariants: `phase` moves
// new -> snapshotted -> applied|rolled_back and never backwards; every record
// written is fingerprinted before and after; a failed apply always rolls back
// before the lease is released. Injected dependencies exist for tests only.
```

For each factory, state: what it closes over, the invariants it maintains, and which injected parameters are test seams. Read the factory before writing; do not guess invariants.

- [ ] **Step 2: Lint, regenerate, bundle test, commit**

Run: `cd D:/DevTools/UEMCP/server && npx eslint . && npm run build:deployment && node test-deployment-bundle.mjs | tail -5`
Expected: silent lint; `Built 3 deployment artifacts.`; `Failed: 0`.

```bash
cd D:/DevTools/UEMCP
git add server/deployment dist
git commit -m "Deployment: document what each closure factory closes over and guarantees"
```

### Task 3: Extract `transaction-common.mjs`

**Files:**
- Create: `server/deployment/transaction-common.mjs`
- Modify: `server/deployment/client-transaction.mjs`
- Modify: `dist/*` (regenerated)

**Interfaces:**
- Consumes: nothing.
- Produces: exports every declaration from the pre-split lines 27–390 under its existing name: `MAX_CONFIG_BYTES`, `MAX_STAGE_ENTRIES`, `STAGE_QUARANTINE_PATTERN`, `STAGED_WRITE_TOKEN`, `WRITABLE_SCOPES`, `ACTION_STATUSES`, `READY_STATUSES`, `DEFAULT_WINDOWS_NATIVE`, `ClientTransactionError`, `fail`, `pathKey`, `contained`, `safeAbsolutePath`, `isMissing`, `assertWritableAncestry`, `statIdentity`, `metadataFingerprint`, `captureClientPathFingerprint`, `comparableFingerprint`, `fingerprintsEqual`, `snapshotMatchesFingerprint`, `validatePlanDigest`, `adapterMap`, `validateOperations`, `operationDigest`, `pointerOverlap`, `validateSharedRows`, `directoryIdentity`, `identityEqual`, `inspectParentPlan`, `inspectExistingDirectoryAncestry`, `transactionResultBase`.

- [ ] **Step 1: Create the module**

Header:

```js
// transaction-common.mjs — constants, the error type, fingerprint comparison,
// ancestry inspection and validation helpers shared by every part of the client
// transaction (pins, stage, snapshot, apply). Pure functions and frozen data;
// no transaction state lives here.

import { constants } from 'node:fs';
import * as defaultFs from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { canonicalJson, sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { CLIENT_IDS } from './client-contract.mjs';
import { CONFIG_BYTE_LIMIT } from './config-bytes.mjs';
import { fingerprintPath } from './fingerprints.mjs';
import { fingerprintWindowsFileMetadata } from './windows-native.mjs';
```

Then cut lines 27–390 of `client-transaction.mjs` (every top-level declaration before `createClientTransaction`) and paste them verbatim, adding `export` to each declaration that lacks it. The import check in Step 3 prunes this header to what the moved code actually uses.

- [ ] **Step 2: Wire `client-transaction.mjs`**

Replace its import block with:

```js
import { randomBytes } from 'node:crypto';
import * as defaultFs from 'node:fs/promises';
import { resolve } from 'node:path';

import { canonicalJson, sha256Bytes } from './canonical-json.mjs';
import { createProcessRunner } from './process-runner.mjs';
import {
  ACTION_STATUSES,
  DEFAULT_WINDOWS_NATIVE,
  MAX_CONFIG_BYTES,
  MAX_STAGE_ENTRIES,
  READY_STATUSES,
  STAGED_WRITE_TOKEN,
  STAGE_QUARANTINE_PATTERN,
  WRITABLE_SCOPES,
  adapterMap,
  assertWritableAncestry,
  captureClientPathFingerprint,
  contained,
  directoryIdentity,
  fail,
  fingerprintsEqual,
  identityEqual,
  inspectExistingDirectoryAncestry,
  inspectParentPlan,
  isMissing,
  operationDigest,
  pathKey,
  safeAbsolutePath,
  snapshotMatchesFingerprint,
  statIdentity,
  transactionResultBase,
  validateOperations,
  validatePlanDigest,
  validateSharedRows,
} from './transaction-common.mjs';

export { ClientTransactionError, captureClientPathFingerprint } from './transaction-common.mjs';
```

- [ ] **Step 3: Import check**

Run the import check on `deployment/transaction-common.mjs deployment/client-transaction.mjs`.
Expected: prune every `no-unused-vars` it names from either header; zero `no-undef`; re-run until zero problems.

- [ ] **Step 4: Suites, bundle, commit**

Run: `node test-client-transaction.mjs | tail -5 && node test-client-adapters.mjs | tail -5 && node test-installed-client-contracts.mjs | tail -5`
Expected: `Failed: 0` in all three.

Run: `npm run build:deployment && node test-deployment-bundle.mjs | tail -5`
Expected: `Built 3 deployment artifacts.`; `Failed: 0`.

```bash
cd D:/DevTools/UEMCP
git add server/deployment/transaction-common.mjs server/deployment/client-transaction.mjs dist
git commit -m "Extract transaction-common.mjs: the helpers every transaction cluster shares"
```

### Task 4: Extract `transaction-pins.mjs`

**Files:**
- Create: `server/deployment/transaction-pins.mjs`
- Modify: `server/deployment/client-transaction.mjs`
- Modify: `dist/*`

**Interfaces:**
- Consumes: from `transaction-common.mjs`: `captureClientPathFingerprint`, `directoryIdentity`, `fail`, `fingerprintsEqual`, `identityEqual`, `inspectExistingDirectoryAncestry`, `isMissing`, `pathKey`, `statIdentity`.
- Produces: `createTransactionPins({ state, fsImpl, windowsNative, processRunner, systemRoot })` returning `Object.freeze({ capture, releaseLease, withPinnedDirectory, revalidateRecordParents, withPinnedRecord, createMissingParents, replaceExisting, markChanged, currentOperation })`, each with its original signature.

- [ ] **Step 1: Create the module**

```js
// transaction-pins.mjs — the pinning cluster of the client transaction:
// fingerprint capture, lease release, pinned directories and records, parent
// revalidation and creation, metadata-preserving replacement, plus the two
// bookkeeping helpers (markChanged, currentOperation) the stage cluster needs.
// Closes over the transaction's shared `state`; owns no state of its own.

import {
  captureClientPathFingerprint,
  directoryIdentity,
  fail,
  fingerprintsEqual,
  identityEqual,
  inspectExistingDirectoryAncestry,
  isMissing,
  pathKey,
  statIdentity,
} from './transaction-common.mjs';

export function createTransactionPins({ state, fsImpl, windowsNative, processRunner, systemRoot }) {
  // moved bodies go here, verbatim, in original order

  return Object.freeze({
    capture,
    releaseLease,
    withPinnedDirectory,
    revalidateRecordParents,
    withPinnedRecord,
    createMissingParents,
    replaceExisting,
    markChanged,
    currentOperation,
  });
}
```

- [ ] **Step 2: Move the nine PINS functions**

Cut `capture`, `releaseLease`, `withPinnedDirectory`, `revalidateRecordParents`, `withPinnedRecord`, `createMissingParents`, `replaceExisting`, `markChanged`, `currentOperation` out of `createClientTransaction` and paste them, unchanged, into the factory body above the return. They already reference `state`, `fsImpl`, `windowsNative`, `processRunner`, `systemRoot` by those names, which the factory parameters now supply.

- [ ] **Step 3: Wire `createClientTransaction`**

Directly after the `state` initializer, add:

```js
  const pins = createTransactionPins({ state, fsImpl, windowsNative, processRunner, systemRoot });
  const {
    capture,
    releaseLease,
    withPinnedDirectory,
    revalidateRecordParents,
    withPinnedRecord,
    createMissingParents,
    replaceExisting,
    markChanged,
    currentOperation,
  } = pins;
```

and add `import { createTransactionPins } from './transaction-pins.mjs';` to the imports. Remaining inner functions keep calling these names unchanged.

- [ ] **Step 4: Import check, suites, bundle, commit**

Run the import check on `deployment/transaction-pins.mjs deployment/client-transaction.mjs`. Expected: prune unused imports; zero `no-undef`.

Run: `node test-client-transaction.mjs | tail -5 && node test-client-adapters.mjs | tail -5 && node test-installed-client-contracts.mjs | tail -5 && npm run build:deployment && node test-deployment-bundle.mjs | tail -5`
Expected: `Failed: 0` four times.

```bash
cd D:/DevTools/UEMCP
git add server/deployment/transaction-pins.mjs server/deployment/client-transaction.mjs dist
git commit -m "Extract transaction-pins.mjs: pinning, leases and record bookkeeping over the shared state"
```

### Task 5: Extract `transaction-stage.mjs`

**Files:**
- Create: `server/deployment/transaction-stage.mjs`
- Modify: `server/deployment/client-transaction.mjs`
- Modify: `dist/*`

**Interfaces:**
- Consumes: `pins` (Task 4 shape); from common: `MAX_CONFIG_BYTES`, `MAX_STAGE_ENTRIES`, `STAGED_WRITE_TOKEN`, `STAGE_QUARANTINE_PATTERN`, `assertWritableAncestry`, `contained`, `fail`, `fingerprintsEqual`, `isMissing`, `pathKey`; from `canonical-json.mjs`: `canonicalJson`, `sha256Bytes`.
- Produces: `createTransactionStage({ state, fsImpl, windowsNative, localState, clock, pins })` returning `Object.freeze({ writeFile, runStagedWrite, cleanupAbandonedStages, ownershipLedger })`.

- [ ] **Step 1: Create the module**

```js
// transaction-stage.mjs — the staged-write cluster of the client transaction:
// fingerprinted whole-file writes, native staging directories with quarantine
// and cleanup, and the ownership ledger that records what UEMCP wrote. Depends
// on the pins cluster for record pinning and change bookkeeping.

import { randomBytes } from 'node:crypto';
import { join, relative, resolve } from 'node:path';

import { canonicalJson, sha256Bytes } from './canonical-json.mjs';
import {
  MAX_CONFIG_BYTES,
  MAX_STAGE_ENTRIES,
  STAGED_WRITE_TOKEN,
  STAGE_QUARANTINE_PATTERN,
  assertWritableAncestry,
  contained,
  fail,
  fingerprintsEqual,
  isMissing,
  pathKey,
} from './transaction-common.mjs';

export function createTransactionStage({ state, fsImpl, windowsNative, localState, clock, pins }) {
  const {
    capture,
    createMissingParents,
    currentOperation,
    markChanged,
    replaceExisting,
    withPinnedDirectory,
    withPinnedRecord,
  } = pins;

  // moved bodies go here, verbatim, in original order:
  // writeFile, safeStageRelativePath, nativeStagePaths, removeDetachedStage,
  // detachAndRemoveStageParent, cleanupAbandonedStages, inspectStage,
  // removeStage, runStagedWrite, then ownershipPath and ownershipLedger

  return Object.freeze({ writeFile, runStagedWrite, cleanupAbandonedStages, ownershipLedger });
}
```

- [ ] **Step 2: Move the STAGE functions and the ledger**

Cut the nine functions and the two `const` declarations (`ownershipPath`, `ownershipLedger`) listed under STAGE and paste them into the factory body above the return, unchanged.

- [ ] **Step 3: Wire `createClientTransaction`**

After the `pins` destructuring, add:

```js
  const stage = createTransactionStage({ state, fsImpl, windowsNative, localState, clock, pins });
  const { writeFile, runStagedWrite, cleanupAbandonedStages, ownershipLedger } = stage;
```

and import `createTransactionStage`. The `transactionCapability` line keeps its exact text; its four names now resolve through these constants.

- [ ] **Step 4: Import check, suites, bundle, commit**

Same commands as Task 4 Step 4, with `deployment/transaction-stage.mjs` in the import check.

```bash
cd D:/DevTools/UEMCP
git add server/deployment/transaction-stage.mjs server/deployment/client-transaction.mjs dist
git commit -m "Extract transaction-stage.mjs: staged writes and the ownership ledger"
```

### Task 6: Extract `transaction-snapshot.mjs` and finish `client-transaction.mjs`

**Files:**
- Create: `server/deployment/transaction-snapshot.mjs`
- Modify: `server/deployment/client-transaction.mjs`
- Modify: `dist/*`

**Interfaces:**
- Consumes: `pins`, `stage`; from common: `adapterMap`, `assertWritableAncestry`, `fail`, `fingerprintsEqual`, `inspectParentPlan`, `isMissing`, `operationDigest`, `pathKey`, `safeAbsolutePath`, `snapshotMatchesFingerprint`, `validateOperations`, `validatePlanDigest`, `validateSharedRows`, `directoryIdentity`, `identityEqual`; `randomBytes`; `sha256Bytes`.
- Produces: `createTransactionSnapshot({ state, fsImpl, windowsNative, localState, pins, stage })` returning `Object.freeze({ deleteSnapshot, deleteFileAfterVerify, snapshot, recheckBeforeApply, recheckAfterVerify, withPinnedTransactionEvidence, commitDeferredDeletes, cleanupCreatedDirectories, restoreRecord })`.

- [ ] **Step 1: Create the module**

```js
// transaction-snapshot.mjs — the snapshot cluster of the client transaction:
// taking the pre-apply snapshot (and acquiring the lease), pre and post
// rechecks against captured fingerprints, evidence pinning, deferred deletes,
// restoring records and removing created directories on rollback. Depends on
// pins for capture and pinning and on stage for writeFile and stage cleanup.

import { randomBytes } from 'node:crypto';

import { sha256Bytes } from './canonical-json.mjs';
import {
  adapterMap,
  assertWritableAncestry,
  directoryIdentity,
  fail,
  fingerprintsEqual,
  identityEqual,
  inspectParentPlan,
  isMissing,
  operationDigest,
  pathKey,
  safeAbsolutePath,
  snapshotMatchesFingerprint,
  validateOperations,
  validatePlanDigest,
  validateSharedRows,
} from './transaction-common.mjs';

export function createTransactionSnapshot({ state, fsImpl, windowsNative, localState, pins, stage }) {
  const {
    capture,
    releaseLease,
    withPinnedDirectory,
    revalidateRecordParents,
    withPinnedRecord,
    replaceExisting,
    markChanged,
  } = pins;
  const { writeFile, cleanupAbandonedStages } = stage;

  // moved bodies go here, verbatim, in original order:
  // deleteSnapshot, deleteFileAfterVerify, snapshot, recheckBeforeApply,
  // recheckAfterVerify, withPinnedTransactionEvidence, commitDeferredDeletes,
  // cleanupCreatedDirectories, restoreRecord

  return Object.freeze({
    deleteSnapshot,
    deleteFileAfterVerify,
    snapshot,
    recheckBeforeApply,
    recheckAfterVerify,
    withPinnedTransactionEvidence,
    commitDeferredDeletes,
    cleanupCreatedDirectories,
    restoreRecord,
  });
}
```

- [ ] **Step 2: Move the SNAPSHOT functions**

Cut the nine functions listed under SNAPSHOT and paste them into the factory body above the return, unchanged.

- [ ] **Step 3: Finish `createClientTransaction`**

After the `stage` destructuring, add:

```js
  const snap = createTransactionSnapshot({ state, fsImpl, windowsNative, localState, pins, stage });
  const {
    deleteSnapshot,
    deleteFileAfterVerify,
    snapshot,
    recheckBeforeApply,
    recheckAfterVerify,
    withPinnedTransactionEvidence,
    commitDeferredDeletes,
    cleanupCreatedDirectories,
    restoreRecord,
  } = snap;
```

`rollbackInternal` calls `restoreRecord`, `cleanupCreatedDirectories`, `deleteSnapshot` and `releaseLease`; `apply` calls `recheckBeforeApply`, `recheckAfterVerify`, `withPinnedTransactionEvidence`, `commitDeferredDeletes`, `deleteSnapshot` and `releaseLease`. All of those must resolve through the destructurings above. Import `createTransactionSnapshot`. What remains inside the factory, in order: option validation, `state`, the three cluster constructions and destructurings, `transactionCapability`, `rollbackInternal`, `apply`, `rollback`, `return Object.freeze({ snapshot, apply, rollback });`. Remove the now-unused destructured names the import check reports (for example `withPinnedDirectory` if `rollbackInternal` and `apply` no longer reference it directly).

- [ ] **Step 4: Import check on all five files**

Run the import check on `deployment/transaction-common.mjs deployment/transaction-pins.mjs deployment/transaction-stage.mjs deployment/transaction-snapshot.mjs deployment/client-transaction.mjs`.
Expected: zero problems.

- [ ] **Step 5: Size and surface sanity**

Run: `wc -l deployment/client-transaction.mjs deployment/transaction-*.mjs && node -e "import('./deployment/client-transaction.mjs').then(m => console.log(Object.keys(m).sort().join(' ')))"`
Expected: `client-transaction.mjs` under 400 lines; the module prints exactly `ClientTransactionError captureClientPathFingerprint createClientTransaction`.

- [ ] **Step 6: Suites, bundle, lint, full rotation**

Run: `node test-client-transaction.mjs | tail -5 && node test-client-adapters.mjs | tail -5 && node test-installed-client-contracts.mjs | tail -5 && npm run build:deployment && node test-deployment-bundle.mjs | tail -5 && npx eslint .`
Expected: `Failed: 0` four times; lint silent.

Run: `node run-rotation.mjs --json > "$SCRATCH/ws4-final.json"; jq -c '.aggregate, {importErrorCount, noSummaryCount, crashCount}' "$SCRATCH/ws4-final.json"`
Expected: `passed` equals the baseline recorded in Global Constraints, `failed` 0, all counts 0.

- [ ] **Step 7: Codename scan and commit**

```bash
cd D:/DevTools/UEMCP
export LC_ALL=C.UTF-8
grep -v '^#' .git/info/forbidden-tokens | grep -v '^regex:' | grep -v '^\s*$' > "$SCRATCH/tokens.txt"
git diff -- server dist | grep -i -F -f "$SCRATCH/tokens.txt"; echo "grep exit=$? (1 means clean)"
git add server/deployment/transaction-snapshot.mjs server/deployment/client-transaction.mjs dist
git commit -m "Extract transaction-snapshot.mjs; client-transaction.mjs composes pins, stage and snapshot over one state"
```

Expected: `grep exit=1`; `git status --short` empty afterwards.
