# Deployment Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish the versioned, deterministic UEMCP deployment machine contract that every client adapter, plugin operation, wrapper, and external installer will share.

**Architecture:** Build a dependency-injected deployment core under `server/deployment/`. Pure contract, fingerprint, canonicalization, prerequisite, descriptor, plan, and receipt modules feed an orchestrator whose domains can be extended by later PRs; a thin CLI renders the same objects as JSON or human output and never contains deployment policy.

**Tech Stack:** Node.js 22 ES modules, `node:crypto`, `node:fs`, `node:child_process`, MCP SDK client/stdio transport, esbuild 0.28.1, existing project-target APIs and test harness.

## Global Constraints

- Execute only after the provider-neutral metadata PR is merged and branch from that merged `origin/main` through `superpowers:using-git-worktrees`.
- Follow the locked machine contract in `docs/superpowers/plans/2026-07-14-deployment-integrity-plan-suite.md`.
- Require Node `>=22` by semantic numeric comparison; reject Node 20 even when `node --version` succeeds.
- Keep planning/apply runnable before `server/node_modules` exists by producing a tracked self-contained `dist/deploy-uemcp.mjs`. A stale or missing bundle freshness manifest is a release/setup failure.
- Fresh deployment installs only production dependencies with `npm ci --omit=dev --ignore-scripts --no-audit --no-fund` against `server/package-lock.json` and validates with `npm ls --omit=dev --all --json`. A future production dependency that requires lifecycle scripts needs a separate reviewed contract change; setup never silently enables them. Development/CI may continue to use full `npm ci`. Never accept `node_modules` existence as health.
- Use the actual canonical `node.exe` path in the descriptor. Keep absolute `server.mjs`, `env: {}`, and `cwd: null`; do not pin a project or enable Python execution.
- Keep `.uemcp-targets.json` registration independent from client configuration and reuse `registerProjectTargetProfile`. Checkouts default to the existing repo-root file; pinned archives default to stable local state so commit-keyed cache refreshes retain profiles.
- Emit JSON-only stdout in `--json` mode and diagnostics-only stderr. Never log child stdout that may contain config or environment values.
- Use SHA-256 lowercase hex for content, canonical JSON, plans, and receipts.
- Reject symlink/junction or real-path drift outside an explicitly allowed root before any later plan can write.
- Plan expiry is 30 minutes. Apply validates schema, digest, expiry, replay state, executable versions, path identities, and every precondition before snapshots or writes.
- `repair` is a planning operation. It never applies without the same saved plan and approved digest flow.
- Only `HEALTHY` exits `0`; use `10` for `ACTION_REQUIRED`, `20` for `PARTIAL`, `30` for `FAILED`, and `64` for CLI usage/schema errors.
- Store machine state under an injectable `%LOCALAPPDATA%\UEMCP`; tests must use temporary roots and must not inspect or mutate real user state.

---

## File Structure

- Create `server/deployment/contracts.mjs`: schema constants, the complete suite-wide status/action registries, result builders, validation, outcome reduction, and exit-code mapping.
- Create `server/deployment/canonical-json.mjs`: strict recursively sorted JSON serialization and SHA-256 helpers.
- Create `server/deployment/fingerprints.mjs`: exact-byte, directory-manifest, executable-version, path-type, and real-path fingerprints.
- Create `server/deployment/redaction.mjs`: recursive secret-key/value redaction and canary assertion helpers.
- Create `server/deployment/process-runner.mjs`: bounded `shell: false` spawn with timeout, output caps, and Windows process-tree termination.
- Create `server/deployment/windows-native.mjs`: bounded, non-interpolating Authenticode inspection and metadata-preserving existing-file replacement.
- Create `server/deployment/local-state.mjs`: injectable local-state paths, atomic JSON, user-restricted snapshot directories, exclusive apply lease, replay ledger, expiry cleanup, and metadata capture/restore.
- Create `server/deployment/source-provenance.mjs`: checkout-or-pinned-archive Git provenance with content-baseline verification.
- Create `server/deployment/prerequisites.mjs`: Node semantic version and deterministic dependency inspection/plan/apply.
- Create `server/deployment/descriptor.mjs`: canonical stdio descriptor and descriptor equality/redaction.
- Create `server/deployment/target-domain.mjs`: source-aware target-registry resolution, `.uproject` validation, and structured target-registration domain.
- Modify `server/project-targets.mjs`: injectable default path, dry-run/atomic structured writes, and unknown-field preservation without changing the existing profile schema.
- Create `server/deployment/plan-document.mjs`: plan construction, digest, expiry, precondition validation, and replay checks.
- Create `server/deployment/receipts.mjs`: versioned, redacted, machine-local receipt writing and verification.
- Create `server/deployment/protocol-smoke.mjs`: exact-descriptor initialize plus initial `tools/list` proof.
- Create `server/deployment/orchestrator.mjs`: deterministic domain composition for plan/apply/verify/doctor/repair.
- Create `server/deploy-uemcp.mjs`: CLI parser, JSON/human rendering, and exit-code assignment only.
- Create `server/build-deployment-cli.mjs`: deterministic esbuild bundling, input manifest, bundle hash, and third-party notice generation.
- Create `dist/deploy-uemcp.mjs`: tracked self-contained deployment entry; generated, never hand-edited.
- Create `dist/deploy-uemcp.manifest.json`: schema, Node floor, esbuild version, input hashes, aggregate input hash, and bundle hash.
- Create `dist/THIRD_PARTY_NOTICES.txt`: licenses for code included in the deployment bundle.
- Modify `.gitignore`: keep arbitrary `dist` output ignored while explicitly tracking only the three deployment bundle artifacts.
- Create `server/fixtures/deployment/fake-mcp-server.mjs`: isolated stdio fixture for descriptor/protocol tests.
- Create `server/test-deployment-contracts.mjs`: schemas, outcome, canonical JSON, redaction, process, and local-state tests.
- Create `server/test-deployment-prerequisites.mjs`: Node/dependency state and apply tests.
- Create `server/test-deployment-plan.mjs`: digest, expiry, replay, precondition, receipt, and orchestrator tests.
- Create `server/test-protocol-smoke.mjs`: real stdio initialize/tools-list and bounded failure tests.
- Create `server/test-deployment-bundle.mjs`: bundle freshness, no-node_modules launch, schema parity, and deterministic rebuild tests.
- Create `docs/specs/deployment-machine-interface.md`: public machine schema, commands, statuses, exit codes, redaction, and compatibility policy.

---

### Task 1: Define The Versioned Result And Outcome Contract

**Files:**
- Create: `server/deployment/contracts.mjs`
- Create: `server/test-deployment-contracts.mjs`

**Interfaces:**

```js
export const DEPLOYMENT_SCHEMA_VERSION = '1.0';
export const OUTCOMES = Object.freeze({ HEALTHY: 'HEALTHY', ACTION_REQUIRED: 'ACTION_REQUIRED', PARTIAL: 'PARTIAL', FAILED: 'FAILED' });
export const EXIT_CODES = Object.freeze({ HEALTHY: 0, ACTION_REQUIRED: 10, PARTIAL: 20, FAILED: 30, USAGE: 64 });
export const STAGE_STATUSES = Object.freeze({ /* exact suite-wide values below */ });
export const ACTION_CODES = Object.freeze({ /* exact suite-wide values below */ });
export const CLIENT_COMPATIBILITY = Object.freeze(['release_gated', 'known_unsupported', 'unknown_newer', 'not_installed']);
export const CLIENT_STATE_VALUES = Object.freeze({ /* exact field-specific subsets below */ });
export const PLAN_TTL_MS = 30 * 60 * 1000;

export function createStageResult({ name, status, mandatory = true, changed = false, evidence = {}, actions = [] });
export function reduceOutcome(stages);
export function createMachineResult({ operation, source, request, descriptor, plan = null, stages, clients = [], receipts = [], actions = [], now });
export function validateMachineResult(value);
export function exitCodeForOutcome(outcome);
```

`STAGE_STATUSES` is a closed schema-1.0 registry. Its exact values are:

```text
READY NODE_MISSING NODE_UNSUPPORTED LOCK_DRIFT DEPENDENCY_POLICY_BLOCKED INSTALL_FAILED APPLY_IN_PROGRESS
REGISTERED ALREADY_REGISTERED INVALID_TARGET LOCAL_STATE_UNAVAILABLE SOURCE_PROVENANCE_UNKNOWN
CURRENT STALE NOT_DEPLOYED DEPLOYED_STALE DEPLOYED_SOURCE_CURRENT SYNC_FAILED
UNCLASSIFIED_PLUGIN_CONTENT UNCLASSIFIED_TARGET_CONTENT
DEPLOYED_BUILD_REQUIRED DEPLOYED_BUILD_CURRENT BUILD_REQUIRED BUILD_FAILED UNKNOWN_TOOLCHAIN
EDITOR_RESTART_REQUIRED EDITOR_LOCKED
ABSENT CONFIGURED ALREADY_CONFIGURED MATCHING_EFFECTIVE MATCHING_SHADOWED
CONFLICT_EFFECTIVE SHADOWED CONFLICT MALFORMED_CONFIG INSPECTION_LIMIT_EXCEEDED MALFORMED_PROJECT_PLUGIN_LIST
ROLLED_BACK ROLLBACK_CONFLICT UNSUPPORTED_VERSION
ENABLED DISABLED CONNECTED PENDING_TRUST RESTART_REQUIRED POLICY_BLOCKED POLICY_UNKNOWN
NOT_SELECTED NOT_INSTALLED MANUAL_REGISTRATION_REQUIRED UNKNOWN
HEALTHY INITIALIZE_FAILED TOOLS_LIST_FAILED
VERIFIED EDITOR_CLOSED PLUGIN_NOT_LOADED PROJECT_MISMATCH NOT_CHECKED
```

Later plans must use one of these values or explicitly revise the public schema and contract tests; they may not invent an undeclared status during domain implementation.

`CLIENT_STATE_VALUES` is a field-specific closed subset of `STAGE_STATUSES`:

```text
status: ABSENT CONFIGURED ALREADY_CONFIGURED MATCHING_EFFECTIVE MATCHING_SHADOWED
        CONFLICT_EFFECTIVE SHADOWED CONFLICT MALFORMED_CONFIG INSPECTION_LIMIT_EXCEEDED ROLLED_BACK
        ROLLBACK_CONFLICT NOT_SELECTED NOT_INSTALLED MANUAL_REGISTRATION_REQUIRED UNKNOWN
enablement: ENABLED DISABLED POLICY_BLOCKED POLICY_UNKNOWN NOT_SELECTED NOT_INSTALLED UNKNOWN
activation: CONNECTED PENDING_TRUST RESTART_REQUIRED NOT_SELECTED NOT_INSTALLED UNKNOWN
```

Unsupported-version evidence belongs in `compatibility`, `write_supported`, and an `UNSUPPORTED_VERSION` action/domain stage; it cannot replace structural client `status`.

`ACTION_CODES` is likewise closed for schema 1.0. Its exact values are:

```text
NODE_INSTALL_REQUIRED DEPENDENCIES_INSTALL_REQUIRED DEPENDENCY_POLICY_BLOCKED SOURCE_PROVENANCE_UNKNOWN LOCAL_STATE_UNAVAILABLE APPLY_IN_PROGRESS
INSTALL_FAILED SYNC_FAILED BUILD_REQUIRED BUILD_FAILED UNKNOWN_TOOLCHAIN
EDITOR_RESTART_REQUIRED EDITOR_LOCKED EDITOR_CLOSED PLUGIN_NOT_LOADED PROJECT_MISMATCH
PENDING_TRUST RESTART_REQUIRED CLIENT_ENABLEMENT_REQUIRED CLIENT_ENABLEMENT_REVIEW_REQUIRED
CONFLICT MALFORMED_CONFIG INSPECTION_LIMIT_EXCEEDED MALFORMED_PROJECT_PLUGIN_LIST
POLICY_BLOCKED POLICY_UNKNOWN CUSTOM_ENV_REVIEW_REQUIRED CUSTOM_LAUNCH_REVIEW_REQUIRED
UNSUPPORTED_VERSION NOT_INSTALLED MANUAL_REGISTRATION_REQUIRED
UNCLASSIFIED_PLUGIN_CONTENT UNCLASSIFIED_TARGET_CONTENT INITIALIZE_FAILED TOOLS_LIST_FAILED
PLAN_STALE PLAN_DIGEST_MISMATCH PLAN_EXPIRED PLAN_REPLAYED ROLLBACK_CONFLICT
UNSUPPORTED_INTERFACE ELICITATION_UNAVAILABLE
```

An action has exact keys `{ code, message, command }`, where `command` is `null` or `{ executable, args }`; executable/arguments are never a shell string and are never auto-executed merely because they appear in a result.

- [ ] **Step 1: Write failing schema and outcome tests**

In `server/test-deployment-contracts.mjs`, use `TestRunner` and assert:

- all schema/status/action/compatibility/client-state/exit constants are frozen and have the exact values above, with no duplicate values or client-state value outside `STAGE_STATUSES`;
- `createStageResult` rejects unknown fields, empty names/statuses, secret-bearing evidence keys, and non-array actions;
- action validation rejects unknown codes, extra keys, relative executables, non-array arguments, environment/cwd fields, and string commands;
- all mandatory ready stages reduce to `HEALTHY`;
- a human-only trust/build/restart/enablement/dependency-policy action with no failed transaction reduces to `ACTION_REQUIRED`;
- mixed committed success and mandatory failure reduces to `PARTIAL`;
- no useful progress or a fully rolled-back mandatory transaction reduces to `FAILED`;
- only `HEALTHY` maps to exit `0`;
- source accepts only the locked `git_checkout`/`pinned_archive` tagged union, requires a full lowercase 40- or 64-hex `git_commit`, requires `archive: null` for a checkout, and requires all four archive hashes for a pinned archive;
- the top-level machine result exactly matches the suite shape and rejects schema-version drift; every client row requires exact compatibility/write-support consistency and field-specific state values; `apply` requires a non-null consumed-plan summary while `verify`/`doctor` require `plan: null`.

Run `node test-deployment-contracts.mjs` from `server/`.

Expected: fail with `ERR_MODULE_NOT_FOUND` for `deployment/contracts.mjs`.

- [ ] **Step 2: Implement strict constructors and validators**

Use explicit allowed-key sets rather than permissive object spread. Deep-clone returned values, freeze top-level constants, and make unknown status/action values throw `DeploymentContractError` with `code: 'INVALID_CONTRACT'`. Outcome reduction must use stage properties, not status-name substring matching:

```js
// Each stage carries one of these machine facts.
stage.result = 'ready' | 'action_required' | 'failed' | 'rolled_back' | 'skipped';
stage.progress = 'none' | 'committed';
```

`status` remains the domain-specific stable value; `result` and `progress` drive the aggregate outcome deterministically.

- [ ] **Step 3: Run focused tests and commit**

Run `node test-deployment-contracts.mjs`.

Expected: all contract and reducer assertions pass.

```powershell
git add server/deployment/contracts.mjs server/test-deployment-contracts.mjs
git commit -m "Define the UEMCP deployment machine contract"
```

---

### Task 2: Add Canonical Hashing, Provenance, Redaction, Bounded Processes, And Local State

**Files:**
- Create: `server/deployment/canonical-json.mjs`
- Create: `server/deployment/fingerprints.mjs`
- Create: `server/deployment/redaction.mjs`
- Create: `server/deployment/process-runner.mjs`
- Create: `server/deployment/windows-native.mjs`
- Create: `server/deployment/local-state.mjs`
- Create: `server/deployment/source-provenance.mjs`
- Modify: `server/test-deployment-contracts.mjs`

**Interfaces:**

```js
export function canonicalJson(value);                       // compact, sorted keys, UTF-8 stable
export function sha256Bytes(bytes);
export function sha256Canonical(value);

export async function fingerprintPath(path, { allowedRoots, fsImpl } = {});
// -> { requested_path, canonical_path, real_path, exists, kind, link_kind, link_count, size, sha256 }
export async function fingerprintDirectory(root, { include, exclude, allowedRoots, fsImpl } = {});
// -> { root, entries: [{ path, size, sha256 }], manifest_sha256 }

export function redactSecrets(value, { secretKeys = DEFAULT_SECRET_KEYS } = {});
export function assertNoSecretCanaries(value, canaries);

export function createProcessRunner({ spawnImpl, clock, killTree, defaultTimeoutMs = 30_000, defaultOutputLimitBytes = 1024 * 1024 } = {});
// runner.run(executable, args, { cwd, env, timeoutMs, outputLimitBytes, stdin })
// -> { status: 'exited'|'timed_out'|'output_limit'|'spawn_failed', exitCode, signal, stdout, stderr, durationMs }

export async function inspectAuthenticode(executable, { runner, systemRoot, expectedSignerNames = [] });
// -> { status:'valid'|'invalid'|'unavailable', signer_name, thumbprint } with no certificate dump

export async function fingerprintWindowsFileMetadata(path, { runner, systemRoot, maxStreams = 64, maxStreamBytes = 16 * 1024 * 1024 });
// -> { metadata_sha256, stream_count, stream_bytes }; no SDDL, stream name, or stream bytes escape

export async function replaceFilePreservingMetadata({ replacementPath, destinationPath, runner, systemRoot });
// existing same-volume regular files only; atomic ReplaceFile semantics or typed failure

export function createLocalState({ root, fsImpl, aclRestrictor, processInspector, clock });
// -> paths(), readJson(), writeJsonAtomic(), acquireApplyLease(), createSnapshot(), restoreSnapshot(), deleteSnapshot(), cleanupExpired(), markDigestApplied(), wasDigestApplied()

export async function inspectSourceProvenance({ repoRoot, bundleManifestPath, runner, fsImpl });
// -> { kind:'git_checkout'|'pinned_archive', repository, repo_root, git_commit,
//      dirty, archive:null|{ archive_sha256, baseline_manifest_sha256,
//      current_manifest_sha256, provenance_sha256 } }
```

The pinned-archive input contract is root `.uemcp-source-provenance.json` with exact fields:

```js
{
  schema_version: '1.0',
  kind: 'pinned_github_archive',
  repository: '<owner>/<repo>',
  requested_ref: '<release tag or fallback branch>',
  git_commit: '<40-or-64-lowercase-hex>',
  archive_sha256: '<64-lowercase-hex>',
  bundle_manifest_sha256: '<64-lowercase-hex>',
  payload_entries: [{ path: '<slash-relative>', size: 0, sha256: '<64-lowercase-hex>' }],
  payload_manifest_sha256: '<64-lowercase-hex>',
  downloaded_at: '<ISO-8601>',
  provenance_sha256: '<canonical self-hash excluding this field>'
}
```

`inspectSourceProvenance` exposes `payload_manifest_sha256` as `archive.baseline_manifest_sha256`, recomputes `archive.current_manifest_sha256`, and never copies `payload_entries` into a plan or receipt.

- [ ] **Step 1: Add failing adversarial tests**

Cover canonical object key ordering, stable array order, Unicode paths, `-0`, non-finite numbers, `undefined`, cycles, and lower-case 64-hex hashes. Fingerprint regular files, multiply linked regular files, missing files, directories, symlinks/junctions, and a real path escaping `allowedRoots`. Assert exact bytes, not decoded text, determine hashes and that link count participates in later precondition drift.

For the runner, inject child fixtures that exit nonzero, hang, fork a child, exceed stdout, exceed stderr, and print a secret canary. Require timeout/output status to be distinct from negative exit and require the process tree to terminate. Assert `shell: false` is passed by the real implementation and arguments with spaces/metacharacters remain one argument. For Authenticode, fixture valid, invalid, unsigned, missing-certificate, malformed/extra output, timeout, output overflow, signer mismatch, a target containing quotes/metacharacters, and a path outside candidate roots. Assert the target path is never interpolated into PowerShell source/arguments and only bounded status, simple signer name, and thumbprint are returned. For metadata fingerprinting, cover DACL, owner, creation time, attributes, alternate-stream add/change/delete, stream-count/byte overflow, inaccessible metadata, secret stream-name/content canaries, and deterministic repeat; only aggregate hash/count/bytes may cross the helper boundary. For replacement, fixture absent destination, cross-volume paths, non-regular/multiply linked files, ACL/metadata merge failure, locked files, malformed/extra helper output, and success preserving destination DACL, creation time, compression/encryption flags where supported, and a canary alternate data stream. Require failure to leave destination bytes unchanged and never retry with `rename` or an ignore-merge flag.

For local state, use a temporary root and verify atomic temporary cleanup, absent-file snapshots, exact bytes, file mode/timestamps, ACL restrictor invocation, applied-digest replay storage, seven-day conflict snapshot expiry, and no use of the real `%LOCALAPPDATA%`. Exercise exclusive lease acquisition, a second live owner, owner-token mismatch on release, crash residue with a live PID, dead-owner grace-period rejection/reclaim, PID reuse distinguished by process-start observation, malformed/link-escaped lock files, bounded wait returning `APPLY_IN_PROGRESS`, plan expiry while waiting, and release in every success/failure/rollback path.

For source provenance, fixture a clean Git checkout, dirty tracked/untracked checkout, detached checkout, Git-unavailable checkout, signed standard-root Git, hostile PATH/`where.exe` shadowing, invalid Authenticode evidence, linked/path-escaped candidates, HTTPS/SSH/scp/file/no-origin remotes, a credential-bearing remote URL canary, valid AI-Tools pinned archive, copied valid archive, changed/deleted/extra archive files, allowed dependency/local-target generated files, malformed/self-hash-invalid provenance, wrong bundle-manifest hash, 39/41/63/65-hex invalid commits, valid 40/64-hex commits, linked file, and no-Git/no-provenance tree. Require a full lowercase Git object ID for both valid kinds and prove no remote credentials/query/fragment survive the normalized repository identity or any result. A pinned archive verifies every downloader-recorded payload entry and rejects unrecognized extras; current comparison ignores exactly `.uemcp-source-provenance.json`, `server/node_modules/**`, `.uemcp-targets.json`, and `.uemcp-targets.txt`. `dirty` is the comparison with that baseline. Missing verifiable provenance returns stable `SOURCE_PROVENANCE_UNKNOWN` and cannot produce a healthy deployment receipt.

Run `node test-deployment-contracts.mjs`.

Expected: fail on missing modules.

- [ ] **Step 2: Implement canonical JSON and fingerprints**

Reject unsupported JavaScript values instead of coercing them. For paths, call `lstat`, then `realpath`, then validate the real path is equal to or below one canonical allowed root using `path.relative`; reject `..`, rooted relative results, and unexpected link kinds. Directory manifests use slash-normalized relative paths sorted with ordinal comparison and never include timestamps.

- [ ] **Step 3: Implement redaction, bounded process execution, and Windows native primitives**

Redact keys matching `token`, `secret`, `password`, `passphrase`, `authorization`, `cookie`, `api_key`, and `env` values not explicitly public. Preserve key presence with `"<redacted>"`. The process runner keeps bounded byte buffers, reports discarded byte counts, never logs child output itself, and on Windows calls an injected tree killer whose production implementation runs:

```text
%SystemRoot%\System32\taskkill.exe /PID <pid> /T /F
```

through `spawn` with an argument array and `shell: false`.

The Windows-native helpers resolve `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, require that canonical system path, and invoke it with `-NoLogo -NoProfile -NonInteractive -Command -`. Each operation has one fixed script supplied through stdin and a minimal child environment; canonical paths are passed only through dedicated environment keys and are never interpolated into source or command arguments. For Authenticode, set a fixed system-only `PSModulePath`, import the exact system `Microsoft.PowerShell.Security` module manifest, call module-qualified `Microsoft.PowerShell.Security\Get-AuthenticodeSignature -LiteralPath`, and emit one compact JSON object containing normalized status, `SignerCertificate.GetNameInfo(SimpleName, false)`, and thumbprint. For metadata fingerprinting, collect owner/DACL SDDL, creation time, attributes, and sorted non-default named-stream names/sizes/content hashes under strict stream count/aggregate-byte ceilings, canonicalize and SHA-256 them inside the child, and emit only aggregate hash/count/bytes. For existing-file replacement, call `.NET [System.IO.File]::Replace(replacement, destination, $null, $false)`, which maps to Windows replacement semantics without ignoring metadata merge errors, then emit only normalized success/error code. Use the bounded runner, reject stderr/extra stdout, never emit certificates, SDDL, stream names, or file contents, and compare expected signer names ordinal-ignore-case. Test user-module/function shadow canaries and prove they never run. Domain callers must already prove same parent/volume, regular single-link identity, expected content/metadata fingerprints, and an exclusive same-directory replacement file; the helper never relaxes those checks.

- [ ] **Step 4: Implement local state and rollback primitives**

Default to `join(process.env.LOCALAPPDATA, 'UEMCP')`; throw `LOCAL_STATE_UNAVAILABLE` when neither an injected root nor `LOCALAPPDATA` exists. Same-directory temporary writes use `open(..., 'wx')`, `fsync`, close, and rename. Snapshot metadata records `exists`, exact bytes in the restricted snapshot file, mode, atime, mtime, original hash, and canonical path; receipts retain only the snapshot ID/path label/hash. Restore only when the caller supplies the expected current applied hash.

The production ACL restrictor resolves the current user SID through absolute `%SystemRoot%\System32\whoami.exe` with fixed `/user /fo csv /nh` arguments, validates one SID record, then invokes absolute `%SystemRoot%\System32\icacls.exe` with argument arrays to remove inherited access and grant that SID and LocalSystem full control. No localized account name or shell interpolation is used. If ACL restriction cannot be established, snapshot creation fails before any target write.

`acquireApplyLease` exclusively creates `state/deployment-apply-v1.lock` with a cryptographically random owner token, PID, observed process start, and timestamp. A contender never deletes a live or uninspectable owner's lease. Reclaim requires a proven-dead owner and elapsed grace period, uses an atomic rename to a uniquely owned quarantine name, and retries exclusive creation; only the matching owner token may release. Waiting is bounded and injectable; timeout returns `APPLY_IN_PROGRESS` with owner values redacted. The orchestrator acquires this lease before final precondition/replay validation and holds it through apply, verification, receipts, replay marking, rollback, and snapshot cleanup.

- [ ] **Step 5: Implement source provenance without assuming `.git` exists**

For a checkout, inspect fixed regular-file candidates beneath `%ProgramFiles%\Git\cmd`, `%ProgramFiles%\Git\bin`, and `%LOCALAPPDATA%\Programs\Git\cmd`; absolute `%SystemRoot%\System32\where.exe git` is only a clue and cannot authorize another canonical path. Accept a regular file or in-root hard-linked regular file with valid Authenticode evidence, reject symlink/junction/path escape, version-probe the exact `git.exe`, require `rev-parse --show-toplevel` to equal `repoRoot`, read `remote.origin.url` plus `rev-parse HEAD`, and derive `dirty` from porcelain output including untracked files. Normalize the remote to a non-secret host/owner/repository label, stripping userinfo, query, fragment, and `.git`; use `local-checkout` when no safe remote identity exists. For an archive, parse root `.uemcp-source-provenance.json`, verify its canonical self-hash, exact GitHub repository/ref/full commit fields, archive hash, baseline release-file manifest, and current bundle-manifest hash. Accept only lowercase 40- or 64-hex object IDs. Recompute the release-file manifest on every plan/verify so a copied archive remains attributable while modified bytes set `dirty: true`. Never infer a commit from directory names or mutable version text.

- [ ] **Step 6: Run tests and commit**

```powershell
node test-deployment-contracts.mjs
git add server/deployment/canonical-json.mjs server/deployment/fingerprints.mjs server/deployment/redaction.mjs server/deployment/process-runner.mjs server/deployment/windows-native.mjs server/deployment/local-state.mjs server/deployment/source-provenance.mjs server/test-deployment-contracts.mjs
git commit -m "Add deployment hashing process and local-state primitives"
```

Expected: all pure, process, path, ACL-injection, and snapshot tests pass.

---

### Task 3: Make Runtime And Dependency Readiness Evidence-Based

**Files:**
- Create: `server/deployment/prerequisites.mjs`
- Create: `server/test-deployment-prerequisites.mjs`

**Interfaces:**

```js
export function parseNodeVersion(text); // -> { major, minor, patch, raw }; rejects prerelease/garbage
export async function inspectNodeRuntime({ executable = process.execPath, runner, allowedRoots });
export async function inspectDependencies({ serverRoot, nodeRuntime, runner, localState });
export function planPrerequisiteOperations({ node, dependencies });
export async function applyDependencyOperation(operation, context);
```

Dependency stamp schema:

```js
{
  schema_version: '1.0',
  lock_sha256: '<hex>',
  node_major: 22,
  package_manager: { node_executable, npm_cli, version },
  install_mode: 'production-no-scripts',
  validation: { command: 'npm ls --omit=dev --all --json', exit_code: 0 },
  validated_at: '<ISO-8601>'
}
```

- [ ] **Step 1: Write failing Node and dependency tests**

Use fake runner responses for `v20.19.4`, `v22.0.0`, `v22.13.1`, `v24.2.0`, malformed output, missing executable, shim-to-real-path, and version change between plan and apply. Require Node 20 to return `NODE_UNSUPPORTED`, 22+ to return `READY`, and a missing runtime to return `NODE_MISSING` without attempting any other mutation.

Create isolated `serverRoot` fixtures and test stamp invalidation for lock hash, Node major, install mode, npm CLI path/version, failed `npm ls`, missing production package, dev-only absence, a production lock entry with `hasInstallScript`, and tampered stamp. A matching stamp still runs bounded `npm ls --omit=dev --all --json`; a failed validation cannot be overridden by the stamp. Before planning install, traverse the lockfile's production dependency closure and return `DEPENDENCY_POLICY_BLOCKED` for any lifecycle-script package, naming only package/version and never executing it. Applying `INSTALL_DEPENDENCIES` must invoke the absolute selected `node.exe` with `[absoluteNpmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']` in `serverRoot`, then validate and write the stamp only after both commands exit zero. Assert no `.cmd`/`.bat` launcher, lifecycle script, audit request, or funding request is spawned. If a future production dependency needs a lifecycle script, require a separate reviewed contract change rather than retrying without `--ignore-scripts`.

Run `node test-deployment-prerequisites.mjs`.

Expected: fail with missing `prerequisites.mjs`.

- [ ] **Step 2: Implement semantic runtime inspection**

Parse `^v?(\d+)\.(\d+)\.(\d+)$` numerically. Canonicalize `process.execPath`/the supplied executable, execute that exact path with `['--version']`, and fingerprint executable path/version for the later plan precondition. Do not fall back to a bare `node` after an absolute runtime was selected.

- [ ] **Step 3: Implement deterministic dependency inspection and apply**

Resolve the npm package paired with the selected Node installation by locating its `package.json` and declared `bin` entry, canonicalizing `bin/npm-cli.js` beneath that package root, and running it through the selected absolute `node.exe`. A discovered `npm.cmd` is only a location clue and is never executed. Version-probe with `[npmCli, '--version']`. Compute and structurally inspect `package-lock.json` before validation; reject lifecycle scripts in the production closure with `DEPENDENCY_POLICY_BLOCKED`. Use `[npmCli, 'ls', '--omit=dev', '--all', '--json']` as readiness proof and `[npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']` as the only fresh-deployment install operation. Recompute lock and runtime fingerprints immediately before install and again before writing the stamp. Keep full dependency installation in documented contributor/CI commands, outside the setup machine operation.

- [ ] **Step 4: Prove bootstrap boundary by interface**

Add a fake bootstrap caller test that starts with no Node, records one proposed `INSTALL_NODE_RUNTIME` action, and cannot call `applyDependencyOperation`, target registration, config writes, or plugin deployment until a fresh `inspectNodeRuntime` returns 22+. The actual launcher bootstrap is implemented in the cutover plan; this core test locks the boundary it must honor.

- [ ] **Step 5: Run tests and commit**

```powershell
node test-deployment-prerequisites.mjs
git add server/deployment/prerequisites.mjs server/test-deployment-prerequisites.mjs
git commit -m "Make Node and dependency readiness evidence based"
```

---

### Task 4: Add The Canonical Descriptor And Target Domain

**Files:**
- Create: `server/deployment/descriptor.mjs`
- Create: `server/deployment/target-domain.mjs`
- Create: `server/test-deployment-plan.mjs`
- Modify: `server/project-targets.mjs`
- Modify: `server/test-project-targets.mjs`

**Interfaces:**

```js
export async function createCanonicalDescriptor({ nodeExecutable, serverEntry, allowedRoots, fsImpl });
export function descriptorsEqual(actual, expected); // semantic comparison after canonical paths

// Exported from server/project-targets.mjs and reused by target-domain.mjs.
export function resolveDefaultTargetsPath({ repoRoot, stateRoot, sourceKind, explicitTargetsPath, fsImpl });
export function createTargetDomain({ repoRoot, stateRoot, sourceKind, targetsPath, fsImpl, windowsNative });
// domain.name === 'target'; domain.order === 20
// domain.plan(context) -> operations/stages/preconditions
// domain.apply(context, operations) -> target stage
// domain.verify(context) -> target stage
```

- [ ] **Step 1: Add failing descriptor and target tests**

Create `server/test-deployment-plan.mjs`. Assert paths with spaces and non-ASCII characters remain exact array values; `command` and `args[0]` are absolute real paths; `env` is exactly `{}`; `cwd` is exactly `null`; and no `UNREAL_PROJECT_*`, `UEMCP_PROJECT_ATTACH_MODE`, or `UEMCP_ENABLE_PYTHON_EXEC` field appears.

For target registration, use temporary `.uproject` and `.uemcp-targets.json` fixtures. Assert checkout/worktree `.git` directory-or-file default to `<repo>/.uemcp-targets.json`, validated pinned-archive mode defaults to `<state>/.uemcp-targets.json`, identical stable path across two cache commit roots, checkout precedence when both `.git` and a provenance filename exist, explicit `--targets-file` precedence, `LOCAL_STATE_UNAVAILABLE` rather than a cache-local fallback when pinned state has no root, canonical path/link containment, alias/profile/unknown-field preservation, already-registered no-op, invalid JSON failure, hard-linked target rejection, write-race/content-or-metadata-drift rejection, metadata-preserving replacement failure, DACL/alternate-stream preservation, atomic temporary cleanup, legacy input remaining read-only migration input, and no client/workspace config operation inferred from the project parent. Default paths must remain beneath their selected checkout/state root. An explicit targets file may be elsewhere, but must be absolute, non-device, non-linked through every existing ancestor, have a regular single-link JSON file or safely creatable parent, and become its own narrowly approved write root. Exercise `readProjectTargets` without explicit paths from both source kinds so normal server/list/smoke callers inherit the same default.

Run `node test-deployment-plan.mjs`.

Expected: fail on missing modules.

- [ ] **Step 2: Implement the descriptor**

Return exactly:

```js
Object.freeze({
  name: 'uemcp',
  transport: 'stdio',
  command: canonicalNodePath,
  args: Object.freeze([canonicalServerPath]),
  env: Object.freeze({}),
  cwd: null,
});
```

Require the Node executable and server entry to be regular files beneath their expected roots. Descriptor comparison canonicalizes Windows path case and separators but does not ignore extra environment, arguments, or working-directory fields.

- [ ] **Step 3: Implement the target domain through existing APIs**

Resolve the target registry from explicit path, then source kind: `git_checkout` uses `<repo>/.uemcp-targets.json`; `pinned_archive` uses `<state>/.uemcp-targets.json`. Containment under repo/state applies to generated defaults only; validate an explicit absolute path under the user-selected path contract above instead of incorrectly forcing it beneath repo/state. When no source kind is passed by a normal server caller, `resolveDefaultTargetsPath` treats an existing checkout/worktree `.git` file or directory as checkout, otherwise a root provenance file as pinned archive; checkout wins if both names exist. Change `readProjectTargets` defaults to call this helper, with injectable `stateRoot`, so every existing caller obtains the stable archive path without provider env or descriptor changes.

The planner calls `readProjectTargets` and emits either no operation or one `REGISTER_PROJECT_TARGET` operation containing canonical `.uproject`, target config path, expected composite content/metadata fingerprint, and the alias/complete proposed document returned by `registerProjectTargetProfile({ dryRun: true })`. Preserve unknown top-level and target-definition fields while merging aliases/profiles. Apply rechecks the composite fingerprint and uses an exclusive same-directory replacement plus `replaceFilePreservingMetadata` for an existing file, or guarded rename for a still-absent file; no weaker fallback is allowed. Local-state targets receive the same user-only ACL requirement as other state. Never duplicate alias/profile merge logic.

- [ ] **Step 4: Run tests and commit**

```powershell
node test-project-targets.mjs
node test-deployment-plan.mjs
git add server/deployment/descriptor.mjs server/deployment/target-domain.mjs server/test-deployment-plan.mjs server/project-targets.mjs server/test-project-targets.mjs
git commit -m "Add canonical launch descriptor and target domain"
```

---

### Task 5: Implement Signed-Off Plans, Preconditions, Replay Protection, And Receipts

**Files:**
- Create: `server/deployment/plan-document.mjs`
- Create: `server/deployment/receipts.mjs`
- Modify: `server/test-deployment-plan.mjs`

**Interfaces:**

```js
export function createPlanDocument({ operation, outcome, source, request, descriptor, stages, preconditions, operations, clients = [], actions = [], now, ttlMs = PLAN_TTL_MS });
export function computePlanDigest(planWithoutDigest);
export async function validatePlanForApply({ plan, approvedDigest, now, fingerprint, localState });
// -> { ok: true, plan } or throws DeploymentPlanError with stable code before writes

export async function writeReceipt({ localState, result, plan });
export async function readAndVerifyReceipt(path, { fsImpl });
```

- [ ] **Step 1: Add failing tamper, expiry, replay, and precondition tests**

Assert determinism across object insertion order, digest change for source commit/dirty/archive identity, operation/client selection/owned diff/precondition/expiry changes, rejection of an altered stored digest, rejection of a wrong approved digest, exact 30-minute expiry, clock boundary behavior, replay after an apply receipt, executable version drift, missing/created file drift, symlink target drift, and changed config bytes. Install a write spy and require zero snapshot or write calls for every rejection.

Add receipt secret canaries under env/token/password/authorization fields and assert they cannot appear in receipt JSON, path labels, actions, or stderr formatting. Tampered/copy-moved receipts must fail their own canonical hash check and cannot establish current state.

Run `node test-deployment-plan.mjs`.

Expected: fail on missing plan/receipt modules.

- [ ] **Step 2: Implement canonical plan construction**

Include `outcome`, planned `stages`, `clients`, and `actions` in the plan document so the saved/approved bytes are the complete preview contract. Sort preconditions by `(kind, canonical_path, label)` and operations by `(domain_order, operation_id)` before digesting. Preserve adapter order from the locked transaction order. Set `created_at`/`expires_at` from the injected clock. Reject duplicate operation IDs, duplicate precondition labels, unknown domain names, secret-bearing values, and any plan that selects a client without listing its detected version/scope.

- [ ] **Step 3: Implement apply validation in the required order**

Validate immutable JSON/schema, stored digest, approved digest, and initial expiry before acquiring the apply lease. Under the lease, recheck expiry, replay ledger, executable versions, path real/link identity, and exact file/directory fingerprints before any snapshot or domain write. Collect all non-secret precondition failures into one `PLAN_STALE` result, release the lease, and perform no snapshots or writes. Hold the lease through terminal verification/rollback, receipt writing, replay marking, and cleanup. Mark the digest applied only after the operation returns a committed or fully rolled-back terminal result; a rejected plan remains eligible only until its original expiry and unchanged preconditions.

- [ ] **Step 4: Implement redacted receipts**

Write receipts atomically under `receipts/` with a filename derived from timestamp, operation, and digest. Include source identity, requested target/profile, descriptor with only an empty/redacted env, stage/client statuses, before/after hashes, plugin hashes when later supplied, verification levels, rollback state, plan digest/expiry, action codes, and receipt self-hash. Never include full config content, snapshot bytes, raw child output, or unrelated settings.

- [ ] **Step 5: Run tests and commit**

```powershell
node test-deployment-plan.mjs
git add server/deployment/plan-document.mjs server/deployment/receipts.mjs server/test-deployment-plan.mjs
git commit -m "Add digest-bound deployment plans and receipts"
```

---

### Task 6: Add Exact-Descriptor Protocol Smoke And Generic Client Support

**Files:**
- Create: `server/deployment/protocol-smoke.mjs`
- Create: `server/fixtures/deployment/fake-mcp-server.mjs`
- Create: `server/test-protocol-smoke.mjs`

**Interfaces:**

```js
export async function smokeDescriptor(descriptor, {
  clientInfo = { name: 'uemcp-deployment-smoke', version: '1.0.0' },
  timeoutMs = 15_000,
  expectedServerName = 'uemcp',
  transportFactory,
} = {});
// -> { status, initialize, instruction_bytes, tool_count, initial_tool_names, duration_ms }

export function createGenericClientResult({ descriptor, smoke });
// -> MANUAL_REGISTRATION_REQUIRED plus non-secret manual guidance
```

- [ ] **Step 1: Write failing real-stdio protocol tests**

The fixture server must support MCP initialize and initial `tools/list`, expose deterministic instructions/serverInfo, and have flags to hang before initialize, fail initialize, hang tools/list, emit invalid protocol data, or exit early. Tests must launch it with an absolute `process.execPath`, path containing spaces, empty env overlay, no usable `PATH`, and no `cwd` override to model a GUI host that did not inherit the terminal environment. Assert each failure is bounded and classified separately as `INITIALIZE_FAILED` or `TOOLS_LIST_FAILED`.

Against the real UEMCP `server/server.mjs`, perform initialize plus initial `tools/list` with no project and assert serverInfo, instructions, and the ten management tools. Do not require an editor.

Run `node test-protocol-smoke.mjs`.

Expected: fail on missing modules.

- [ ] **Step 2: Implement smoke using the SDK client**

Use `Client` and `StdioClientTransport` from the installed MCP SDK. Launch exactly `descriptor.command` and `descriptor.args`, pass no project env and no working directory, apply a deadline to initialize and list, close the transport in `finally`, and never infer native-client trust from this result. Record instruction byte count and tool names but no tool descriptions or environment.

- [ ] **Step 3: Implement generic manual support**

For an unknown or absent automatic adapter, return `MANUAL_REGISTRATION_REQUIRED`, the canonical descriptor, the protocol-smoke status, and guidance that configuration path/enablement/trust/restart remain host-owned. Never report automatic registration, enablement, or activation.

- [ ] **Step 4: Run tests and commit**

```powershell
node test-protocol-smoke.mjs
git add server/deployment/protocol-smoke.mjs server/fixtures/deployment/fake-mcp-server.mjs server/test-protocol-smoke.mjs
git commit -m "Add provider-neutral descriptor protocol smoke"
```

---

### Task 7: Compose The Core Orchestrator And CLI

**Files:**
- Create: `server/deployment/orchestrator.mjs`
- Create: `server/deploy-uemcp.mjs`
- Create: `server/build-deployment-cli.mjs`
- Create: `server/test-deployment-bundle.mjs`
- Create: `dist/deploy-uemcp.mjs`
- Create: `dist/deploy-uemcp.manifest.json`
- Create: `dist/THIRD_PARTY_NOTICES.txt`
- Modify: `.gitignore`
- Create: `docs/specs/deployment-machine-interface.md`
- Modify: `server/test-deployment-plan.mjs`
- Modify: `server/package.json`
- Modify: `server/package-lock.json`

**Interfaces:**

```js
export function createDeploymentOrchestrator({
  repoRoot,
  stateRoot,
  fsImpl,
  processRunner,
  clock,
  domains = [],
});

// Returned methods:
orchestrator.plan(request);
orchestrator.apply({ plan, approvedDigest });
orchestrator.verify(request);
orchestrator.doctor(request);
orchestrator.repair(request); // returns a repair plan, never applies
```

Domain interface:

```js
{
  name: 'prerequisites' | 'target' | 'clients' | 'plugin',
  order: 10 | 20 | 30 | 40,
  plan(context),   // -> { stages, operations, preconditions, clients? }
  apply(context, operations),
  verify(context),
}
```

- [ ] **Step 1: Add failing composition and CLI tests**

Use fake domains to prove deterministic order, no apply-time replanning, operation filtering by domain, separate domain rollback outcomes, aggregate `PARTIAL`, action propagation, receipt creation, and zero writes on a healthy no-op. Exercise two concurrent applies to prove only one lease owner reaches precondition validation/writes and that the waiter revalidates after acquisition. Spawn the CLI and assert exact commands from the suite index, JSON-only stdout, stderr separation, usage exit `64`, and outcome exit codes `0/10/20/30`. `plan` stdout must be a `uemcp.deployment.plan` document whose exit code matches its embedded outcome; `apply` emits a result with the consumed-plan summary, while standalone `verify`/`doctor` emit results with `plan: null`.

Assert `repair` emits a digest-bound plan and cannot accept `--yes` or mutate state directly. Assert a plan with no supported client includes generic/manual status rather than silently omitting clients.

Run `node test-deployment-plan.mjs`.

Expected: fail on missing orchestrator/CLI.

- [ ] **Step 2: Implement orchestration without domain policy**

The orchestrator builds shared context once, runs domain methods in numeric order, merges their stages/operations/preconditions, creates the plan, validates before apply, dispatches only the plan's operations, verifies committed domains, reduces outcome, writes a receipt, and records replay state. It must not know client file formats or plugin copy rules; later plans register those domains.

- [ ] **Step 3: Implement strict CLI parsing and rendering**

Accept only the commands and flags documented in the suite. Add `--targets-file <absolute .json>` to `plan`, `verify`, `doctor`, and `repair`; include its canonical fingerprint in the request/plan. Reject relative, device, linked, or non-JSON explicit paths; reject generated default paths that escape their source/state root. Reject unknown flags and conflicting project/profile inputs. `apply` accepts no request override and requires `--plan-file`, `--approve-digest`, and `--non-interactive`; interactive approval belongs to wrappers and is never inferred from stdin in machine mode. Add package scripts:

```json
"deploy": "node deploy-uemcp.mjs",
"build:deployment": "node build-deployment-cli.mjs",
"doctor": "node deploy-uemcp.mjs doctor --json"
```

Do not change the existing `test`, `start`, or `lint` scripts.

- [ ] **Step 4: Build and lock the standalone fresh-install entry**

Install exact dev dependency `esbuild@0.28.1`. `build-deployment-cli.mjs` bundles `server/deploy-uemcp.mjs` for Node 22 ESM, externalizes only `node:*` built-ins, emits LF with no source map or absolute source path, and writes the three tracked `dist` files atomically. Use esbuild's metafile to identify all inputs, but record exact hashes only for first-party repo files that remain present in a fresh checkout. Record `server/package-lock.json` hash plus bundled package name/version/license for third-party inputs. Compute `input_manifest_sha256` over the first-party inputs, lock hash, and bundled-package identities. Omit timestamps so two unchanged builds are byte-identical.

The adjacent manifest is:

```js
{
  schema_version: '1.0',
  entry: 'dist/deploy-uemcp.mjs',
  node_minimum: '22.0.0',
  esbuild_version: '0.28.1',
  source_inputs: [{ path, sha256 }],
  package_lock_sha256: '<hex>',
  bundled_packages: [{ name, version, license }],
  input_manifest_sha256: '<hex>',
  bundle_sha256: '<hex>'
}
```

Generate `THIRD_PARTY_NOTICES.txt` from the same explicit bundled-package set and installed license/package metadata; fail on a dependency with missing or non-allowlisted license data. Fresh-checkout verification recomputes bundle hash, first-party source hashes, and package-lock hash without requiring `node_modules`; only the developer/CI deterministic rebuild requires installed dependencies.

`test-deployment-bundle.mjs` rebuilds to a temporary directory and byte-compares bundle, manifest, and notices; launches the temporary bundle with empty `NODE_PATH` and a cwd containing no `node_modules`; and compares `--help`, schema constants, a no-write `plan`, and usage exit `64` with the source CLI. The bundle must not contain the MCP server entry itself or change the canonical descriptor away from `server/server.mjs`.

Replace the broad root ignore with `dist/*` plus exact negations for `dist/deploy-uemcp.mjs`, `dist/deploy-uemcp.manifest.json`, and `dist/THIRD_PARTY_NOTICES.txt`. Add a test that `git check-ignore` reports those three files as trackable while an arbitrary `dist/scratch.txt` remains ignored.

- [ ] **Step 5: Document the public machine interface**

In `docs/specs/deployment-machine-interface.md`, document the five commands through `dist/deploy-uemcp.mjs`, the source development entry, bundle freshness contract, plan/apply split, schema `1.0`, top-level/stage/client fields, stable outcomes/exits, 30-minute expiry, replay behavior, JSON stdout rule, redaction, generic descriptor, Node/bootstrap boundary, and compatibility policy. State that schema additions are backward-compatible only when fields are optional and that a major schema mismatch is a hard unsupported-interface failure.

- [ ] **Step 6: Run focused and full gates**

```powershell
node test-deployment-contracts.mjs
node test-deployment-prerequisites.mjs
node test-deployment-plan.mjs
node test-protocol-smoke.mjs
node test-deployment-bundle.mjs
node test-project-targets.mjs
node run-rotation.mjs --json
```

Expected: all non-live assertions pass. No test may access real client homes, real `%LOCALAPPDATA%\UEMCP`, or an Unreal project.

- [ ] **Step 7: Commit and request review**

```powershell
git add .gitignore server/deployment server/deploy-uemcp.mjs server/build-deployment-cli.mjs server/fixtures/deployment server/test-deployment-contracts.mjs server/test-deployment-prerequisites.mjs server/test-deployment-plan.mjs server/test-protocol-smoke.mjs server/test-deployment-bundle.mjs server/package.json server/package-lock.json dist docs/specs/deployment-machine-interface.md
git commit -m "Add the UEMCP deployment orchestration core"
git diff --check origin/main...HEAD
```

The PR must include the exact schema version, exit-code table, test totals, protocol-smoke evidence, and an explicit statement that automatic client config and plugin copying are not yet enabled. Merge before starting the client-adapter plan.
