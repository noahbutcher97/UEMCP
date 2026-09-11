# AI-Tools UEMCP Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the AI-Tools MCP-Suite installer consume UEMCP's exact machine plan/apply/doctor contract, include it in one aggregate confirmation, and preserve every non-healthy UEMCP state without workspace-config or marker/mtime assumptions.

**Architecture:** Pin each downloaded UEMCP release to an exact Git commit and atomically materialize a verified cache provenance record, then add a strict UEMCP subprocess adapter and aggregate install-plan layer inside AI-Tools. UEMCP remains owner of its prerequisites, project/plugin/client/protocol/editor truth; AI-Tools invokes the standalone deployment entry with a compatible absolute Node runtime, embeds the returned digest in the aggregate preview, applies UEMCP first with that digest, then commits unrelated bridge config, and maps results/receipts without reinterpretation.

**Tech Stack:** AI-Tools Node 18+ ES modules and `node:test`, UEMCP standalone Node 22 deployment bundle/schema 1.0, `spawnSync` with `shell: false`, SHA-256 aggregate plans, existing AI-Tools bridge results/receipts/config helpers.

## Global Constraints

- Work in `D:\DevTools\AI-Tools`, not the UEMCP worktree. Read and follow that repository's `AGENTS.md`.
- Planning observed AI-Tools `main` ahead of `origin/main` by four commits. Before creating a worktree, fetch and reconcile those commits with the intended remote main without reset/revert; branch from the confirmed authoritative tip through `superpowers:using-git-worktrees`.
- Execute after the UEMCP plugin/build-proof PR is merged, so `dist/deploy-uemcp.mjs` exposes final schema `1.0` domains. Merge this consumer before UEMCP removes legacy manifest/postSetup assumptions in the entrypoint-cutover PR.
- AI-Tools may continue running on Node 18 for other bridges, but UEMCP machine commands require an absolute Node `>=22`. Probe and report; do not launch UEMCP with an unsupported installer runtime.
- Invoke only `<uemcp-root>/dist/deploy-uemcp.mjs`; verify its bundle freshness manifest/source identity and reject absent or unsupported schema rather than falling back to weaker logic.
- Treat the selected UEMCP source root as explicit data, never as `process.cwd()`. A repository checkout, downloaded AI-Tools cache directory, and path containing spaces, Unicode, or shell metacharacters must resolve the same verified bundle contract.
- Use argument arrays, `shell: false`, explicit cwd, bounded timeout/maxBuffer, and exact executable paths. Do not invoke UEMCP `.bat`/`.cmd` files through `cmd.exe`.
- Downloaded UEMCP catalog/release manifests never select validation, setup, or post-setup commands. The adapter may launch only the resolved absolute Node 22+ executable with the verified deployment bundle; UEMCP owns its own explicit client-executable probes.
- Resolve a GitHub release/tag to an immutable full 40- or 64-hex commit before download, fetch that exact commit archive, and atomically cache downloader-written source provenance. A mutable `latest`, tag, branch, directory name, or downloaded manifest is never commit evidence.
- Pin the UEMCP source repository in installer code to exact `noahbutcher97/UEMCP`. Catalog or downloaded manifest data may choose a supported human ref but cannot redirect repository owner/name.
- Do not generically install UEMCP dependencies before planning. The standalone UEMCP bundle plans and applies deterministic dependencies itself.
- Do not read, write, or require workspace `.mcp.json` for UEMCP. Other AI-Tools bridges may keep their existing workspace-config flow.
- Do not infer UEMCP success from process exit alone. Parse schema, operation, outcome, digest, stages, clients, actions, and receipts; accept only documented exit/outcome pairs.
- One aggregate preview includes the exact UEMCP plan digest and every other planned AI-Tools write. Interactive apply has one aggregate confirmation. Noninteractive apply requires an explicit aggregate approval digest/`--yes` and cannot broaden operations.
- Apply UEMCP before unrelated workspace-config writes so a stale UEMCP plan can return to confirmation without partially applying other bridges. Independent failures after a committed UEMCP apply produce a truthful aggregate partial result; they do not roll UEMCP back.
- Map UEMCP `HEALTHY`, `ACTION_REQUIRED`, `PARTIAL`, and `FAILED` distinctly. Only `HEALTHY` can become AI-Tools success.
- UEMCP doctor output is authoritative for UEMCP. Delete marker/version/mtime/DLL heuristics from AI-Tools rather than maintaining two classifiers.
- Remove the generic Claude-only SessionStart update-hook behavior. Explicit provider-specific hooks are deferred; `Update-MCP-Suite.bat` remains the portable update entry point.
- Tests use fake UEMCP bundle scripts, temporary workspaces/caches/state, and fake runtimes. They must never touch real client homes, Unreal projects, workspace configs, or network resources.

---

## File Structure

- Create `Installers/MCP-Suite/Scripts/lib/bridge-source.mjs`: exact GitHub-ref pinning, staged archive materialization, payload manifest, provenance, and cache validation.
- Create `Installers/MCP-Suite/Scripts/bridge-source.test.mjs`: fake-network/archive/cache tests with traversal, partial extraction, stale cache, and provenance tampering.
- Modify `Installers/MCP-Suite/Scripts/lib/github.mjs`: resolve a tag/ref to an exact commit and download only the commit-addressed archive.
- Modify `Installers/MCP-Suite/Scripts/lib/cache.mjs`: commit-keyed UEMCP cache paths and verified-cache enumeration without changing other bridge cache behavior.
- Create `Installers/MCP-Suite/Scripts/lib/uemcp-orchestrator.mjs`: bundle/runtime validation, strict subprocess invocation, schema/exit validation, plan-file handling, result mapping, and redaction.
- Create `Installers/MCP-Suite/Scripts/lib/windows-native.mjs`: fixed-script Authenticode/metadata inspection and metadata-preserving replacement used by the UEMCP adapter and aggregate config writer on Windows.
- Create `Installers/MCP-Suite/Scripts/lib/install-plan.mjs`: canonical aggregate plan/digest, workspace-config preconditions, UEMCP embedded plan, rendering, approval, and apply order.
- Create `Installers/MCP-Suite/Scripts/uemcp-orchestrator.test.mjs`: fake-runtime/bundle/schema/exit/stale/redaction tests, following the installer's existing root-level test layout.
- Create `Installers/MCP-Suite/Scripts/install-plan.test.mjs`: aggregate preview, digest, confirmation, ordering, stale replan, and partial tests.
- Create `Installers/MCP-Suite/Scripts/fixtures/fake-uemcp/`: standalone fake deployment entry and versioned response fixtures.
- Modify `Installers/MCP-Suite/Scripts/install.mjs`: special-case UEMCP through the machine adapter, two-phase plan/apply, strict project/profile/build/client/approval args, no UEMCP workspace config/postSetup, and no generic update hook.
- Modify `Installers/MCP-Suite/Scripts/install-cli.test.mjs` and `Installers/MCP-Suite/Scripts/install.test.mjs`: CLI and full-flow behavior.
- Modify `Installers/MCP-Suite/Scripts/lib/install-results.mjs` and `Installers/MCP-Suite/Scripts/install-results.test.mjs`: explicit action-required status and UEMCP stage/result preservation.
- Modify `Installers/MCP-Suite/Scripts/lib/doctor.mjs` and `Installers/MCP-Suite/Scripts/doctor.test.mjs`: delegate UEMCP health and stop requiring public config for UEMCP.
- Delete `Installers/MCP-Suite/Scripts/lib/uemcp-doctor.mjs` and replace `Installers/MCP-Suite/Scripts/uemcp-doctor.test.mjs` with machine-adapter tests, or retain only a deprecated re-export with no classification logic if an external import is proven.
- Modify `MCP-Servers/manifest.json`: provider-neutral suite description and UEMCP machine-interface/dependency ownership metadata.
- Modify `Installers/MCP-Suite/README.md`, `MCP-Servers/README.md`, `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md`, and `README.md`: multi-host behavior, runtime requirement, aggregate digest, result mapping, and proof limits. Existing `_handoffs/` files are historical evidence and remain unchanged.

---

### Task 1: Pin And Atomically Materialize Downloaded UEMCP Source

**Files:**
- Create: `Installers/MCP-Suite/Scripts/lib/bridge-source.mjs`
- Create: `Installers/MCP-Suite/Scripts/bridge-source.test.mjs`
- Modify: `Installers/MCP-Suite/Scripts/lib/github.mjs`
- Modify: `Installers/MCP-Suite/Scripts/lib/cache.mjs`
- Modify: `Installers/MCP-Suite/Scripts/install.mjs`

**Interfaces:**

```js
export const UEMCP_SOURCE_REPOSITORY = 'noahbutcher97/UEMCP';

export async function resolvePinnedGithubSource({ repository, requestedRef, githubClient });
// -> { repository, requested_ref, git_commit:<40-or-64-lowercase-hex>, archive_url }

export async function materializePinnedBridge({
  bridgeName,
  pinnedSource,
  cacheRoot,
  download,
  tarExecutable,
  runner,
  fsImpl,
  clock,
});
// -> { dir, provenance }

export async function inspectPinnedBridgeCache({ bridgeRoot, expectedSource, fsImpl });
// -> { status:'verified'|'missing'|'invalid', provenance, reason_code }
```

Downloader-owned root `.uemcp-source-provenance.json` has this canonical self-hashed schema:

```js
{
  schema_version: '1.0',
  kind: 'pinned_github_archive',
  repository: 'noahbutcher97/UEMCP',
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

- [ ] **Step 1: Add failing pinning, extraction, cache, and provenance tests**

Use fake GitHub responses for a lightweight tag, annotated tag, branch fallback, moved tag, malformed SHA, wrong catalog/manifest repository, case/Unicode-confusable owner or repository text, API timeout, archive timeout, and exact commit URL. The UEMCP acquisition caller must supply exact `UEMCP_SOURCE_REPOSITORY`; any conflicting metadata is rejected before network/cache lookup. The download request must use the resolved commit, never `latest`, `HEAD`, or a mutable tag. Hash archive bytes before extraction.

Use temporary cache roots and a fake absolute `tar.exe` runner for success, nonzero exit, timeout, output overflow, partial extraction, compressed download over 256 MiB, more than 100,000 payload files, declared or actual payload over 2 GiB, no/multiple common archive roots, absolute/traversal/UNC/device entry, backslash separator, NTFS alternate-data-stream colon, trailing-dot/space alias, Windows reserved device segment, invalid Windows character, overlong segment/path, Unicode-normalization collision, case collision, file/directory prefix collision, symlink/junction, hardlink/path escape, preexisting/concurrently-published final cache, rename failure, hostile archive-supplied provenance, tampered payload, tampered self-hash, wrong bundle manifest, legacy `remote` cache, and a valid offline cache hit. Require rejected preflight cases never to invoke extraction, staging/failed output cleanup, no partial final cache, ordinal payload ordering, exact-byte hashes, and no dependency/setup/validation child process.

Run from AI-Tools root:

```powershell
node Installers/MCP-Suite/Scripts/bridge-source.test.mjs
```

Expected: fail on missing bridge-source module.

- [ ] **Step 2: Resolve immutable GitHub source identity**

Extend the GitHub helper to resolve the selected latest-release tag or fallback default branch through the commits API to one full lowercase 40- or 64-hex object ID. Construct the archive request with that ID. Preserve the human ref separately; never treat `target_commitish`, tag text, a redirect basename, or a cache directory as commit proof.

- [ ] **Step 3: Stage, verify, and atomically publish the cache**

Resolve and version-probe absolute `%SystemRoot%\System32\tar.exe`; do not use a PATH command. Stream-download at most 256 MiB into a sibling temporary directory while hashing. Before extraction, run fixed bounded list/verbose commands and parse only the characterized Windows bsdtar format. Bound each member path to 1,024 UTF-8 bytes and listing output to 128 MiB. Require exactly one common top-level directory and at most 100,000 regular-file/directory members; sum declared regular-file sizes and reject above 2 GiB before extraction. Reject ambiguous/control-character names, absolute/drive/UNC/device/rooted paths, backslashes, `..` or empty segments, colons/alternate streams, Windows-invalid characters or reserved device names, trailing dots/spaces, overlong segments, case/Unicode-normalization aliases, file/directory prefix collisions, and every member type except regular file or directory. A rejected listing must prove extraction was never invoked.

Extract with that single verified prefix removed via fixed `--strip-components 1`, an argument array, `shell: false`, a 120-second timeout, a 1 MiB output cap, process-tree termination, and a fresh exclusive stage. Then recursively `lstat`/`realpath` the stage and independently re-enforce member count, actual-byte total at most 2 GiB, regular-file/directory-only content, path/alias rules, and containment. Reject links, non-regular payload entries, path escape, missing root `dist/deploy-uemcp.mjs`/freshness manifest, and an archive that already contains `.uemcp-source-provenance.json`.

Build `payload_entries` from every extracted regular file before dependencies exist, write provenance atomically, verify it by reread, and rename the stage to a repository-and-commit-keyed final cache directory on the same volume. On failure delete only the new stage. If another process publishes the same final directory first, verify that directory against the same pinned source and discard only the private stage; an invalid winner is a cache conflict, never overwrite permission. The downloader treats verified archive payload bytes as immutable; an approved UEMCP apply may create only core-allowlisted generated state such as `server/node_modules`, which provenance comparison excludes explicitly. An invalid or legacy unproven cache is never executed and is not silently deleted.

- [ ] **Step 4: Route only UEMCP through pinned-source acquisition**

Keep other bridge behavior unchanged. For UEMCP, replace the generic `remote` cache/dependency-recursion path with `resolvePinnedGithubSource` plus `materializePinnedBridge`, always pass exact `UEMCP_SOURCE_REPOSITORY`, return provenance with `bridgeDir`, and skip generic npm/setup/validation work. Offline use may select only a previously verified pinned cache for that exact repository and must visibly report its recorded ref/commit; no verified cache returns action-required instead of falling back to legacy content.

- [ ] **Step 5: Run and commit**

```powershell
node Installers/MCP-Suite/Scripts/bridge-source.test.mjs
node Installers/MCP-Suite/Scripts/install-cli.test.mjs
node Installers/MCP-Suite/Scripts/install.test.mjs
git add Installers/MCP-Suite/Scripts/lib/bridge-source.mjs Installers/MCP-Suite/Scripts/bridge-source.test.mjs Installers/MCP-Suite/Scripts/lib/github.mjs Installers/MCP-Suite/Scripts/lib/cache.mjs Installers/MCP-Suite/Scripts/install.mjs
git commit -m "installer: pin UEMCP cache provenance"
```

---

### Task 2: Build A Strict UEMCP Machine-Interface Adapter

**Files:**
- Create: `Installers/MCP-Suite/Scripts/lib/uemcp-orchestrator.mjs`
- Create: `Installers/MCP-Suite/Scripts/lib/windows-native.mjs`
- Create: `Installers/MCP-Suite/Scripts/uemcp-orchestrator.test.mjs`
- Create: `Installers/MCP-Suite/Scripts/fixtures/fake-uemcp/`

**Interfaces:**

```js
export const UEMCP_SCHEMA_VERSION = '1.0';
export const UEMCP_OUTCOME_EXITS = Object.freeze({
  HEALTHY: 0,
  ACTION_REQUIRED: 10,
  PARTIAL: 20,
  FAILED: 30,
});
export const UEMCP_ENV_ALLOWLIST = Object.freeze([
  'SystemRoot', 'WINDIR', 'PATH', 'PATHEXT', 'LOCALAPPDATA', 'APPDATA',
  'USERPROFILE', 'HOME', 'HOMEDRIVE', 'HOMEPATH', 'temporary', 'TMP',
  'ProgramFiles', 'ProgramFiles(x86)', 'ProgramData',
  'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'GEMINI_CLI_HOME', 'VSCODE_PORTABLE',
]);

export function resolveUemcpBundle(uemcpRoot, { sourceKind, expectedProvenance });
// -> absolute dist/deploy-uemcp.mjs plus verified bundle manifest
export function resolveUemcpRuntime({ explicitNode, processExecPath, env, spawnSyncImpl });
// -> absolute node >=22 or typed NODE_MISSING/NODE_UNSUPPORTED
export function inspectAuthenticode(executable, context);
export function fingerprintWindowsFileMetadata(path, context);
export function replaceFilePreservingMetadata({ replacementPath, destinationPath }, context);
export function invokeUemcp({ nodeExecutable, bundlePath, args, timeoutMs, spawnSyncImpl, env });
export function planUemcp(request, context);
export function applyUemcp({ plan, approvedDigest }, context);
export function doctorUemcp(request, context);
export function mapUemcpBridgeResult(machineResult, bridgeResult);
```

- [ ] **Step 1: Create fake bundle cases and failing adapter tests**

The fake bundle accepts `plan`, `apply`, and `doctor`, writes one JSON document to stdout, diagnostics to stderr, and supports flags for outcomes/exits, malformed JSON, extra stdout, wrong schema, wrong operation, missing digest, secret canary, timeout, output overflow, stale plan, and spawn failure. Fixture plans include all four clients, touched-path labels, enablement/trust/restart/build actions, expiry, and digest. Build checkout, AI-Tools-cache, and path-with-spaces/Unicode/metacharacters roots; invoke from an unrelated working directory and assert every launch uses the explicit UEMCP root and exact absolute bundle path.

Test Node 18 rejection, Node 22/24 acceptance, an explicitly supplied nonstandard absolute runtime, signed standard-root implicit discovery, hostile PATH/`where.exe` shadowing rejection, linked/non-file candidates, unsigned/wrong-signer implicit candidates, absent/stale bundle freshness manifest, missing/mismatched pinned provenance for a cached source, machine-result source commit/archive mismatch, checkout mode without archive provenance, unsupported schema, valid exit/outcome pairs, mismatched pair rejection, environment allowlist preservation/case-insensitivity, secret and `UEMCP_ENABLE_PYTHON_EXEC` environment exclusion, redaction, and cleanup of exact plan temporary files. Unit-test the Windows helper contract for fixed scripts, minimal environment, no path interpolation, user-module shadow rejection, bounded metadata hashing, metadata-preserving replacement, and no weaker fallback. Seed hostile downloaded UEMCP metadata with `validation.command`, `setup.command`, and `postSetup.command` canaries and a spawn spy; the only permitted child process is a fixed Windows helper, fixed version probe, or `<absolute node.exe> <absolute deploy-uemcp.mjs> ...` invocation.

Run from AI-Tools root:

```powershell
node Installers/MCP-Suite/Scripts/uemcp-orchestrator.test.mjs
```

Expected: fail on missing adapter.

- [ ] **Step 2: Implement runtime and bundle validation**

Resolve an explicitly supplied runtime first, then the already-running `process.execPath`, then fixed regular-file candidates beneath `%ProgramFiles%\nodejs`, `%ProgramFiles(x86)%\nodejs`, and `%LOCALAPPDATA%\Programs\nodejs`. Absolute `%SystemRoot%\System32\where.exe node` may identify one of those exact canonical candidates but cannot authorize another path. Reject links/non-files; require a valid Authenticode signature whose simple signer name is `OpenJS Foundation` for an implicit not-already-running candidate; version-probe each accepted exact candidate; and select the first `>=22`. Implement the signature probe inside this adapter with the same absolute system-PowerShell, fixed-stdin-script, environment-passed target, minimal environment, exact system security-module import, module-qualified command, and bounded-JSON contract as UEMCP core; never interpolate the candidate into script text or arguments and prove user-module/function shadows cannot run. Fingerprint and surface an explicit override, but do not impose the implicit signer rule on the already-running process or the caller's explicit path. Do not bootstrap Node here. Resolve only `dist/deploy-uemcp.mjs` beneath the canonical explicit `uemcpRoot`, reject a link escape, recompute its bundle hash, every first-party `source_inputs` hash, and `server/package-lock.json` hash from the adjacent freshness manifest, and require schema/source identity to match. In pinned-archive mode, also require the downloader-returned provenance object, root provenance file, payload/bundle hashes, and selected cache commit to agree before launch. Checkout mode verifies the bundle and lets UEMCP derive Git state itself. Do not require unpacked third-party source or `node_modules`. Missing compatible runtime maps to a UEMCP `ACTION_REQUIRED/NODE_INSTALL_REQUIRED` bridge result without attempting plan.

- [ ] **Step 3: Implement strict bounded invocation**

Use `spawnSync(nodeExecutable, [bundlePath, ...args], { cwd: uemcpRoot, shell: false, encoding: 'utf8', timeout, maxBuffer, env })`. Default plan/doctor timeout is 120 seconds; apply timeout is 45 minutes. Build the child environment case-insensitively from `UEMCP_ENV_ALLOWLIST` only; tests inject state/home paths through those names or explicit CLI context. Do not forward arbitrary `UEMCP_*`, `UNREAL_*`, credentials, or `UEMCP_ENABLE_PYTHON_EXEC`, and never echo environment. Require one JSON value and no non-whitespace stdout outside it.

For `plan`, require `kind: "uemcp.deployment.plan"`, schema `1.0`, complete preview fields, valid structured actions, and a valid stored digest. For apply/doctor, require `kind: "uemcp.deployment.result"` and the requested operation; apply requires a non-null consumed-plan summary matching the approved digest, while doctor requires `plan: null`. Validate every action command as `null` or `{ executable:<absolute path>, args:<string[]> }` and never execute it. In pinned mode, require every returned source identity to match the downloader's repository, commit, archive hash, baseline manifest, and canonical source root. Accept nonzero `10/20/30` when and only when the parsed plan/result outcome matches. Exit `64`, signal, timeout, overflow, invalid JSON/schema/operation, source mismatch, or exit/outcome mismatch is adapter `FAILED` with stable diagnostic code.

- [ ] **Step 4: Implement exact plan-file apply and result mapping**

Write the returned plan's exact UTF-8 JSON to a user-restricted temporary file, pass `apply --plan-file <path> --approve-digest <digest> --non-interactive --json`, and delete it after terminal success/failure except when UEMCP explicitly reports retained recovery evidence. Never reconstruct the plan from displayed fields.

Map outcomes exactly:

```text
HEALTHY         -> AI-Tools ok
ACTION_REQUIRED -> AI-Tools action_required
PARTIAL         -> AI-Tools partial
FAILED          -> AI-Tools failed
```

Copy redacted stage/client/action codes into the bridge result without interpreting plugin currentness.

- [ ] **Step 5: Run and commit**

```powershell
node Installers/MCP-Suite/Scripts/uemcp-orchestrator.test.mjs
git add Installers/MCP-Suite/Scripts/lib/uemcp-orchestrator.mjs Installers/MCP-Suite/Scripts/lib/windows-native.mjs Installers/MCP-Suite/Scripts/uemcp-orchestrator.test.mjs Installers/MCP-Suite/Scripts/fixtures/fake-uemcp
git commit -m "installer: add strict UEMCP machine adapter"
```

---

### Task 3: Add One Digest-Bound Aggregate Install Preview

**Files:**
- Create: `Installers/MCP-Suite/Scripts/lib/install-plan.mjs`
- Create: `Installers/MCP-Suite/Scripts/install-plan.test.mjs`
- Modify: `Installers/MCP-Suite/Scripts/install.mjs`

**Interfaces:**

```js
export function createAggregateInstallPlan({
  workspace,
  workspaceConfigBefore,
  workspaceConfigAfter,
  bridgePlans,
  uemcpPlan,
  now,
});
// -> { schemaVersion:'1.0', createdAt, preconditions, operations, uemcp, digest }

export function verifyAggregatePreconditions(plan, current);
export function formatAggregateInstallPlan(plan);
export async function applyAggregateInstallPlan(plan, context);
export async function acquireAggregateInstallLease({ cacheRoot, processInspector, clock, fsImpl });
```

- [ ] **Step 1: Write failing aggregate digest/confirmation tests**

Assert canonical digest changes for workspace content/metadata fingerprint, selected bridge, UEMCP digest, operation, exclusion, and expiry; does not change for object insertion order; includes no secret values; and rejects changed workspace config bytes, DACL, attributes, or alternate streams before apply. Cover a linked or multiply linked workspace config, explicit project, explicit profile, exactly one root `.uproject`, zero candidates, multiple candidates, directory/symlink masquerading as `.uproject`, and project drift before apply. Exercise two concurrent aggregate applies, live/dead/PID-reused lease owners, stale reclaim, owner-token release, bounded wait returning stable `INSTALL_IN_PROGRESS` without writes, metadata-inspection overflow/failure, metadata-preserving replacement failure, and a successful Windows replacement preserving DACL/alternate-stream canaries. The preview must show every selected bridge, every file touched, UEMCP project/plugin/dependency/client actions, all detected UEMCP hosts including `NOT_SELECTED`, trust/build/restart actions, and both aggregate/UEMCP digests.

Interactive flow prompts once after all bridge/UEMCP planning. Decline produces no config/UEMCP apply. Noninteractive without `--yes`/approved digest returns action-required without writes.

- [ ] **Step 2: Refactor install into plan then apply phases**

Keep source download/cache preparation and credential collection/validation before the final plan, but defer bridge own setup, workspace config writes, postSetup, and UEMCP apply until after aggregate confirmation. Represent every deferred mutation as an aggregate operation. UEMCP is planned immediately after its source bundle is available. Pass `--uemcp-project` or `--uemcp-profile` when supplied; otherwise use the installer workspace only when its root contains exactly one regular `.uproject` and pass that canonical file explicitly. Zero or multiple root candidates remain a visible project-selection action and never trigger a recursive or first-match guess.

Do not add UEMCP through `setBridgeInConfig`; its adapters own host config and its machine receipt owns install tracking. Existing `.mcp.json` UEMCP entries remain migration input to the UEMCP plan.

- [ ] **Step 3: Implement apply ordering and stale behavior**

After immutable aggregate schema/digest/approval checks, acquire an exclusive lease at `<cacheRoot>/locks/install-v1.lock` using the same live-owner/token/stale-reclaim rules as the UEMCP lease, then recheck aggregate expiry and every precondition. Hold it through UEMCP apply, non-UEMCP config/post-setup work, receipt writing, and rollback/finalization. Apply UEMCP first with its embedded exact digest. If it returns `PLAN_STALE`, `PLAN_EXPIRED`, or `PLAN_DIGEST_MISMATCH`, make no workspace config write, release the lease, re-run UEMCP planning, rebuild the aggregate digest, and return to interactive confirmation. In noninteractive mode return action-required with the new digest; never auto-approve it.

After UEMCP commits or when UEMCP is not selected, recheck the workspace config composite content/metadata fingerprint and write the already-planned non-UEMCP config through an exclusive same-directory replacement. Reject linked or multiply linked writable files. On Windows use `replaceFilePreservingMetadata` for an existing regular single-link file and guarded rename for an absent file; metadata merge failure aborts without fallback. Run only post-setup actions listed in the aggregate plan. Independent later failure makes aggregate partial and preserves each stage.

- [ ] **Step 4: Add strict approval and UEMCP request CLI behavior**

Extend the parser with `--yes`, `--approve-plan=<64-hex>`, `--uemcp-node-exe=<absolute node.exe>`, `--uemcp-project=<absolute .uproject>`, `--uemcp-profile=<name>`, `--uemcp-targets-file=<absolute .json>`, `--uemcp-build`, `--uemcp-engine-root=<absolute path>`, `--uemcp-target=<name>`, `--uemcp-platform=<name>`, `--uemcp-configuration=<name>`, `--uemcp-include-clients=<comma-list>`, `--uemcp-exclude-clients=<comma-list>`, and `--uemcp-vscode-profile=<name>`. Pass `--uemcp-node-exe` only to the adapter's explicit-runtime field. Map the remaining options to UEMCP argument-array elements `--project`, `--profile`, `--targets-file`, `--build`, `--engine-root`, `--target`, `--platform`, `--configuration`, repeated `--include-client`, repeated `--exclude-client`, and `--vscode-profile`; never interpolate a command string. Without an explicit targets file, pinned UEMCP source uses the stable `%LOCALAPPDATA%\UEMCP\state\.uemcp-targets.json`, not a commit cache directory.

`--non-interactive` controls prompts but does not imply approval. A supplied digest must equal the printed aggregate digest. Reject an empty value, malformed digest/list, duplicate/unknown argument, missing project file, or build-only option without `--uemcp-build` before source/config mutation. Preserve existing bridge selection/field override semantics and add an explicit error for every otherwise unknown CLI argument instead of silently ignoring it.

- [ ] **Step 5: Run and commit**

```powershell
node Installers/MCP-Suite/Scripts/install-plan.test.mjs
node Installers/MCP-Suite/Scripts/install-cli.test.mjs
node Installers/MCP-Suite/Scripts/install.test.mjs
git add Installers/MCP-Suite/Scripts/lib/install-plan.mjs Installers/MCP-Suite/Scripts/lib/windows-native.mjs Installers/MCP-Suite/Scripts/install-plan.test.mjs Installers/MCP-Suite/Scripts/install.mjs Installers/MCP-Suite/Scripts/install-cli.test.mjs Installers/MCP-Suite/Scripts/install.test.mjs
git commit -m "installer: add digest-bound aggregate preview"
```

---

### Task 4: Preserve UEMCP Outcomes, Stages, And Receipts Without False Success

**Files:**
- Modify: `Installers/MCP-Suite/Scripts/lib/install-results.mjs`
- Modify: `Installers/MCP-Suite/Scripts/install-results.test.mjs`
- Modify: `Installers/MCP-Suite/Scripts/lib/receipt.mjs`
- Modify: `Installers/MCP-Suite/Scripts/receipt.test.mjs`
- Modify: `Installers/MCP-Suite/Scripts/install.mjs`

- [ ] **Step 1: Add failing action-required and receipt tests**

Add `RESULT_STATUS.ACTION_REQUIRED = "action_required"` with warning severity and nonzero aggregate exit. Test UEMCP results for healthy/editor closed, configured/pending trust, plugin build required, mixed client rollback, failed transaction, unknown version, and manual registration. Assert exact status mapping, stage/client preservation, actions, and no conversion to `ok` because process launched or config was written.

Seed token/password/authorization/env canaries in fake results and assert install summaries/receipts contain only redacted markers. Receipts must contain aggregate digest, UEMCP plan digest, machine schema/source identity, stage/client statuses, path labels/hashes, and action codes, but no full plan config bytes or environment values.

- [ ] **Step 2: Extend result status and exit reduction**

Treat requested/previously-enabled `ACTION_REQUIRED`, `PARTIAL`, and `FAILED` as nonzero. Keep disabled/skipped/absent behavior for other bridges. Format the exact UEMCP action code/message rather than replacing it with generic postSetup guidance.

- [ ] **Step 3: Write truthful aggregate receipts**

Pass the redacted UEMCP machine result and both digests into the existing receipt writer. Record whether UEMCP applied before another bridge failed. Do not use `version: "external"` or write a fake enabled UEMCP workspace record.

- [ ] **Step 4: Run and commit**

```powershell
node Installers/MCP-Suite/Scripts/install-results.test.mjs
node Installers/MCP-Suite/Scripts/receipt.test.mjs
node Installers/MCP-Suite/Scripts/install.test.mjs
git add Installers/MCP-Suite/Scripts/lib/install-results.mjs Installers/MCP-Suite/Scripts/install-results.test.mjs Installers/MCP-Suite/Scripts/lib/receipt.mjs Installers/MCP-Suite/Scripts/receipt.test.mjs Installers/MCP-Suite/Scripts/install.mjs
git commit -m "installer: preserve UEMCP machine outcomes"
```

---

### Task 5: Delegate UEMCP Doctor And Remove The Weaker Classifier

**Files:**
- Modify: `Installers/MCP-Suite/Scripts/lib/doctor.mjs`
- Modify: `Installers/MCP-Suite/Scripts/doctor.test.mjs`
- Delete or reduce: `Installers/MCP-Suite/Scripts/lib/uemcp-doctor.mjs`
- Replace: `Installers/MCP-Suite/Scripts/uemcp-doctor.test.mjs`

- [ ] **Step 1: Write failing delegated-doctor tests**

Use fake machine doctor results for source/build/client/protocol/editor states, unsupported schema/runtime, missing cached UEMCP source, timeout, and redaction. Assert doctor can report UEMCP healthy when workspace `.mcp.json` is absent, can report non-UEMCP workspace config errors independently, and maps UEMCP outcomes/actions exactly.

Add source guards forbidding UEMCP-specific DLL mtime, `.uemcp-deploy-marker.json`, source-newer-than-DLL, project env requirement, and local plugin-version comparison in AI-Tools.

- [ ] **Step 2: Route UEMCP doctor through the machine adapter**

When UEMCP source is cached/selected, resolve Node 22 and call `doctor --project/--profile ... --json`. Store the returned machine result under the UEMCP bridge facts and transform each action into AI-Tools issue rows without reclassification. Missing runtime/source/schema is a direct actionable issue.

Do not add global `.mcp.json is missing` when the relevant bridge is UEMCP. Continue existing workspace-config checks for bridges that actually use that file.

- [ ] **Step 3: Remove marker/mtime implementation**

Delete `evaluateUemcpHealth` and its weak parser/stat logic. If repository search proves a compatibility import outside doctor, retain a thin `uemcp-doctor.mjs` adapter that calls `doctorUemcp`; it may not inspect project/plugin files itself.

- [ ] **Step 4: Run and commit**

```powershell
node Installers/MCP-Suite/Scripts/doctor.test.mjs
node Installers/MCP-Suite/Scripts/uemcp-orchestrator.test.mjs
node Installers/MCP-Suite/Scripts/uemcp-doctor.test.mjs
git add Installers/MCP-Suite/Scripts/lib/doctor.mjs Installers/MCP-Suite/Scripts/doctor.test.mjs Installers/MCP-Suite/Scripts/lib/uemcp-doctor.mjs Installers/MCP-Suite/Scripts/uemcp-doctor.test.mjs
git commit -m "installer: delegate UEMCP doctor truth"
```

If `uemcp-doctor.mjs` is deleted, stage deletion with `git add -u` instead of naming a nonexistent file.

---

### Task 6: Remove UEMCP Workspace/PostSetup Assumptions And Provider-Biased Update Hooks

**Files:**
- Modify: `Installers/MCP-Suite/Scripts/install.mjs`
- Modify: `Installers/MCP-Suite/Scripts/install-cli.test.mjs`
- Modify: `Installers/MCP-Suite/Scripts/install.test.mjs`
- Modify: `MCP-Servers/manifest.json`
- Modify: `Installers/MCP-Suite/README.md`
- Modify: `MCP-Servers/README.md`
- Modify: `MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md`
- Modify: `README.md`

- [ ] **Step 1: Add failing source/manifest/documentation guards**

Require the UEMCP path to skip generic dependency recursion, credential fields, generic manifest validation, `setBridgeInConfig`, own setup, postSetup, `.mcp.json` success claims, and `enableSessionStartHook`. Seed both root-catalog and downloaded UEMCP manifests with hostile `validation.command`, `setup.command`, and `postSetup.command` canaries and assert a spawn spy never sees them. Require the legacy non-UEMCP `VALIDATE_COMMAND_ALLOWLIST` to remain an exact finite set and reject paths/shell metacharacters; do not add `codex`, `gemini`, `code`, `cmd`, `powershell`, or `bash` merely because UEMCP supports those clients. UEMCP client probes occur only inside the verified bundle's own explicit allowlist.

Require root manifest description to be host/provider-neutral and UEMCP metadata to declare that deployment dependencies/config are bridge-owned through machine schema `1.0`.

Scan current docs for claims that the installer is Claude-only, UEMCP needs workspace env fields, postSetup sync proves readiness, or update checks use a portable generic hook.

- [ ] **Step 2: Mark UEMCP as machine-interface-owned in the catalog**

Update the UEMCP catalog entry with:

```json
"deployment": {
  "owner": "bridge",
  "schemaVersion": "1.0",
  "entry": "dist/deploy-uemcp.mjs"
}
```

Keep remote-repo/source/fallback data needed to fetch older releases, but once the entry exists, do not run generic recursive dependency installation or manifest-driven workspace config for UEMCP.

- [ ] **Step 3: Retire the generic SessionStart hook**

Remove `enableSessionStartHook` and the POSIX `2>/dev/null | grep` payload. Keep `--enable-update-checks` as one-release non-destructive deprecation that prints `Use Update-MCP-Suite.bat; provider-specific session hooks are not installed automatically` and writes no hook. Do not silently replace it with a Claude, Codex, Gemini, or VS Code-specific mechanism.

- [ ] **Step 4: Document exact scope**

State that UEMCP automatically configures release-gated Claude Code, Codex host, Gemini CLI, and VS Code adapters and emits a generic descriptor for other standards-compatible hosts. Clarify that this does not make every other AI-Tools bridge automatically multi-host; their workspace-config migration is a separate follow-on. Document Node 22 for UEMCP, aggregate approval, enablement/trust/restart/build states, doctor delegation, and no `.mcp.json` dependency.

- [ ] **Step 5: Run and commit**

```powershell
node Installers/MCP-Suite/Scripts/install-cli.test.mjs
node Installers/MCP-Suite/Scripts/install.test.mjs
git add MCP-Servers/manifest.json MCP-Servers/README.md MCP-Servers/docs/UEMCP-MANIFEST-SPEC.md README.md Installers/MCP-Suite/Scripts/install.mjs Installers/MCP-Suite/Scripts/install-cli.test.mjs Installers/MCP-Suite/Scripts/install.test.mjs Installers/MCP-Suite/README.md
git add -u
git commit -m "installer: use provider-neutral UEMCP deployment"
```

---

### Task 7: Run Full AI-Tools Integration And Compatibility Gates

**Files:**
- Verify all files named in this plan; fix only in-scope integration gaps.

- [ ] **Step 1: Run every installer test**

```powershell
Get-ChildItem 'Installers/MCP-Suite/Scripts' -Recurse -Filter '*.test.mjs' | Sort-Object FullName | ForEach-Object { node $_.FullName; if ($LASTEXITCODE -ne 0) { throw "Failed: $($_.FullName)" } }
```

Expected: every test exits `0`.

- [ ] **Step 2: Run tracked JavaScript syntax checks**

```powershell
git ls-files '*.mjs' | ForEach-Object { node --check $_; if ($LASTEXITCODE -ne 0) { throw "Syntax failed: $_" } }
```

Expected: every tracked module parses.

- [ ] **Step 3: Run isolated end-to-end fake-UEMCP scenarios**

Exercise healthy, action-required, partial, failed, stale-plan reapproval, missing Node 22, unsupported schema, absent `.mcp.json`, UEMCP plus another bridge, other-bridge write failure after UEMCP success, noninteractive no approval, exact approved digest, and doctor. Stage two fake pinned commits beneath an injected AI-Tools cache root containing spaces and Unicode, launch the installer by absolute path from an unrelated working directory, and seed hostile downloaded validation/setup/postSetup declarations. Register a project through the first commit and prove plan/doctor through the second commit use the same injected `%LOCALAPPDATA%\UEMCP\state\.uemcp-targets.json`. Assert resolution remains cache-root-relative, the hostile commands are never spawned, no real home/workspace paths change, and all receipts are redacted.

- [ ] **Step 4: Smoke against the merged local UEMCP bundle without applying**

Point the AI-Tools adapter at the local merged UEMCP checkout and a temporary Unreal fixture path, invoke UEMCP `plan` and `doctor` only, and validate schema/digest/result parsing. Do not invoke `apply` against a real project/client home from this plan.

- [ ] **Step 5: Review backward and forward compatibility**

Prove an older UEMCP bundle without `dist/deploy-uemcp.mjs` returns a clear `UNSUPPORTED_INTERFACE` and preserves legacy config without claiming success. Prove the current bundle works before and after the later UEMCP manifest cutover because AI-Tools detects the catalog deployment entry and standalone bundle directly.

- [ ] **Step 6: Final diff, commit correction if needed, and request review**

```powershell
git diff --check origin/main...HEAD
git status --short
```

The PR must include the reconciled AI-Tools base commit, test/syntax totals, fake scenario matrix, local UEMCP schema/digest smoke, no-real-config proof, exact UEMCP outcome mapping, and a statement that generic provider-specific update hooks are no longer installed.
