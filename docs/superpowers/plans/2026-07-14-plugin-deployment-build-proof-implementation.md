# Plugin Deployment And Build Proof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace copy/mtime/marker claims with one atomic managed-payload deployer, immutable build/artifact evidence, and compiled loaded-module identity that works offline and strengthens live editor verification.

**Architecture:** Compute canonical managed and build-relevant manifests, stage a complete destination beside the target plugin, and commit through guarded same-volume renames with rollback. Store generated deployment/build evidence under the project's ignored `Saved/UEMCP` tree; inject the exact build-input and target context into the C++ module at compile time; compare that loaded identity and actual loaded DLL hash during live verification.

**Tech Stack:** Node.js 22 ES modules, SHA-256 manifests, JSONC `.uproject` edits, Windows filesystem/process APIs, UnrealBuildTool, Unreal Engine 5.3/5.6/5.7 C++, UE Automation Tests, TCP `get_editor_state` handshake.

## Global Constraints

- Execute only after the multi-client-adapter PR is merged and branch from that merged `origin/main` through `superpowers:using-git-worktrees`.
- Setup and sync must eventually call the exact implementation created here; do not preserve a second copy policy.
- Managed payload is the descriptor plus every classified versioned source/resource/content/config/shader/build/localization/third-party file. `Binaries`, `Intermediate`, `Saved`, `DerivedDataCache`, exact repository-local files, and the legacy root `.uemcp-deploy-marker.json` are not managed; no wildcard `.uemcp-*` exclusion is permitted.
- Build-relevant hash includes the full module source, Build.cs, public/private headers, and build-affecting plugin descriptor content. Conservative rebuilds are acceptable; false-current builds are not.
- Validate canonical source/target roots, target `.uproject`, target `Plugins` parent, real paths, and matching-editor lock before staging and immediately before replacement.
- Stage and backup directories are verified siblings of the destination on the same volume. Never recursively move/delete an unchecked computed path.
- Preserve a prior destination until managed manifest, project plugin dependencies, generated artifact policy, and receipt writes verify. Restore it on failure.
- Remove stale managed destination files by replacing the managed payload; copy-over behavior is not acceptable.
- Carry `Binaries` only when current evidence matches the exact build-input hash, target project, engine, platform, target, configuration, toolchain record, and every artifact hash. Default to dropping `Intermediate`; retention requires an explicit future policy.
- Timestamps, DLL existence, and legacy `.uemcp-deploy-marker.json` can explain history but cannot establish source/build currentness.
- Keep deployment/build evidence under `<Project>/Saved/UEMCP/Deployment/UEMCP/`, which is machine/project-local generated state. Verification recomputes hashes and never trusts a copied receipt alone.
- The orchestrated build launches absolute `UnrealBuildTool.exe` with argument arrays and `shell: false`; it does not invoke `Build.bat` through a command shell.
- An external IDE build without finalized UEMCP evidence remains `UNKNOWN`. A live loaded identity may prove editor state separately but does not invent a successful external process exit.
- The loaded editor is current only when project identity, compiled build identity, loaded module path, and loaded module SHA-256 all match expected build evidence.
- Preserve legacy editor-state fields for compatibility, but mark deploy-marker data legacy and never use it for loaded-binary proof.
- Regenerate and freshness-test the standalone deployment bundle after plugin-domain integration; fresh setup must have the same plugin/build classifiers as the source CLI.
- Close the matching Unreal Editor before fixture-to-project deploy/build gates. Relaunch only for the final live proof and restart the MCP client afterward.

---

## File Structure

- Create `server/deployment/plugin-manifest.mjs`: managed/build-relevant/generated manifests, inclusion policy, descriptor build projection, and hash comparison.
- Create `server/deployment/uproject-plugins.mjs`: JSONC-preserving plan/apply for required built-in plugin entries.
- Create `server/deployment/plugin-deploy.mjs`: preflight, stage, drift recheck, same-volume swap, verification, rollback, and cleanup.
- Create `server/deployment/unreal-build.mjs`: engine/target resolution, UBT launch, bounded toolchain parsing, and artifact discovery.
- Create `server/deployment/build-evidence.mjs`: build-input/context/artifact schema, state classifier, receipt verification, and compatibility decisions.
- Create `server/deployment/plugin-live-verifier.mjs`: matching-editor handshake, loaded identity comparison, module path validation, and module hashing.
- Create `server/deployment/plugin-domain.mjs`: orchestrator plugin plan/apply/verify stages and operations.
- Create `server/fixtures/plugin-deployment/`: managed-source, stale target, generated artifact, forged marker, failure, and evidence fixtures.
- Create `server/test-plugin-deployment.mjs`: manifest, `.uproject`, stage/swap/rollback/drift/no-op tests.
- Create `server/test-plugin-build-evidence.mjs`: build context, artifact, external build, classifier, and live comparison tests.
- Modify `server/deployment/orchestrator.mjs`: register plugin domain through the existing interface.
- Modify `server/deploy-uemcp.mjs`: add planned build/engine/target options without apply-time widening.
- Modify generated `dist/deploy-uemcp.mjs`, `dist/deploy-uemcp.manifest.json`, and `dist/THIRD_PARTY_NOTICES.txt` through the existing bundle builder.
- Modify `server/project-context.mjs`: retain loaded build identity from `get_editor_state` and stop treating legacy marker fields as build proof.
- Modify `server/test-deploy-awareness-source.mjs`, `server/test-plugin-get-editor-state-source.mjs`, and `server/test-project-server-wire.mjs`: require loaded identity wiring and legacy-marker demotion.
- Create `plugin/UEMCP/Source/UEMCP/Public/UEMCPBuildIdentity.h`: immutable runtime build identity data and accessor.
- Create `plugin/UEMCP/Source/UEMCP/Private/UEMCPBuildIdentity.cpp`: macro-backed identity construction.
- Create `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBuildIdentityTests.cpp`: compiled identity and editor response automation.
- Modify `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs`: read build-input state, declare external dependency, and emit escaped compile definitions.
- Modify `plugin/UEMCP/Source/UEMCP/Private/EdgeCaseHandlers.cpp`: return `loaded_build_identity` and `loaded_module_path` from compiled/runtime facts.
- Modify `plugin/UEMCP/UEMCP.uplugin`, `manifest.json`, and `server/test-plugin-manifest.mjs`: bump in lockstep to `1.0.18` / integer plugin version `19`.
- Modify `docs/specs/plugin-design.md` and `docs/specs/deployment-machine-interface.md`: managed/generated boundaries, states, receipts, build proof, and live/offline evidence.

---

### Task 1: Define Canonical Managed And Build-Relevant Plugin Manifests

**Files:**
- Create: `server/deployment/plugin-manifest.mjs`
- Create: `server/deployment/uproject-plugins.mjs`
- Create: `server/fixtures/plugin-deployment/`
- Create: `server/test-plugin-deployment.mjs`

**Interfaces:**

```js
export const MANAGED_TOP_LEVEL = Object.freeze([
  'UEMCP.uplugin', 'Source', 'Resources', 'Content', 'Config', 'Shaders', 'Build',
  'Localization', 'ThirdParty',
]);
export const GENERATED_TOP_LEVEL = Object.freeze([
  'Binaries', 'Intermediate', 'Saved', 'DerivedDataCache',
]);
export const ARTIFACT_TOP_LEVEL = Object.freeze(['Binaries', 'Intermediate']);
export const REPOSITORY_LOCAL_TOP_LEVEL = Object.freeze([
  '.gitignore', 'README.md', 'LICENSE', 'LICENSE.txt', 'LICENSE.md',
]);
export const TRANSIENT_TOP_LEVEL = Object.freeze(['.uemcp-deploy-marker.json']);

export async function computeManagedPluginManifest(pluginRoot, { fsImpl });
// -> { entries: [{ path, size, sha256 }], manifest_sha256, build_relevant_sha256, descriptor }
export async function computeGeneratedArtifactManifest(pluginRoot, { platform, fsImpl });
// -> { entries, manifest_sha256, module_manifest, module_binary }
export function compareManagedManifests(source, destination);

export async function inspectRequiredProjectPlugins(uprojectPath, { fsImpl });
export function planRequiredProjectPluginPatch(document);
export async function applyRequiredProjectPluginPatch(plan, { fsImpl });
```

`deploy-receipt-v1.json` has this minimum schema and is written only after destination verification:

```js
{
  schema_version: '1.0',
  producer: { orchestrator_version, node_executable_sha256, node_version, dependency_lock_sha256 },
  source: {
    kind: 'git_checkout' | 'pinned_archive',
    repository,
    repo_root,
    plugin_root,
    git_commit,
    dirty,
    archive: null | {
      archive_sha256,
      baseline_manifest_sha256,
      current_manifest_sha256,
      provenance_sha256,
    },
    managed_manifest_sha256,
    build_relevant_sha256,
  },
  target: { uproject_path, plugin_root, descriptor_version, descriptor_version_name, managed_manifest_sha256 },
  generated: { retained, manifest_sha256, build_evidence_sha256 },
  transaction: { plan_digest, synced_at, project_plugin_patch_sha256 },
  receipt_sha256: '<canonical self-hash>'
}
```

The receipt contains hashes and identities only, not source/config bytes. `git_commit` is always a full lowercase 40- or 64-hex Git object ID: checkouts derive it from Git, while AI-Tools archives carry downloader-written pinned provenance verified by the core source-provenance helper. A dirty source is allowed only when visibly planned and records `dirty: true`; verification still compares current content directly.

Required project plugins are `RemoteControl`, `PythonScriptPlugin`, and `GeometryScripting`, enabled `true`. Remove the invalid project plugin entry `Blutility` if present. Preserve every unrelated entry and unknown field.

- [ ] **Step 1: Add failing manifest and `.uproject` fixtures**

Build source fixtures with nested source/resources, every optional managed directory including `Localization`/`ThirdParty`, repository-local files, Binaries/Intermediate, stale generated marker files, unknown source and target top-level files/directories, symlink escape, multiply linked managed file, case collision, extra target managed file, changed source, resource-only change, descriptor-only build-affecting change, clean/dirty Git source identity, clean/dirty pinned-archive source identity, missing provenance, and copied/tampered deploy receipts. Assert ordinal slash-normalized ordering, exact SHA-256, generated/repository-local exclusion, `UNCLASSIFIED_PLUGIN_CONTENT` for unknown source content, `UNCLASSIFIED_TARGET_CONTENT` before any target replacement, extra managed detection, conservative build-relevant hash changes, complete redacted receipt fields, and receipt non-authority.

Build `.uproject` fixtures with absent `Plugins`, existing required entries, disabled required entry, invalid `Blutility`, unrelated objects/fields, CRLF/comments/trailing commas, malformed JSONC, duplicate required entries, and a read-only file. Require targeted preservation and no write for already-correct content.

Run `node test-plugin-deployment.mjs`.

Expected: fail on missing modules.

- [ ] **Step 2: Implement explicit managed classification**

Classify every source top-level entry before walking. Include recognized managed roots, exclude only the exact generated, repository-local, and transient sets above, and return `UNCLASSIFIED_PLUGIN_CONTENT` for anything else; future payload cannot disappear merely because the allowlist was not updated. Reject an unexpected symlink/junction or multiply linked managed file anywhere in classified content. Do not apply a wildcard `.uemcp-*` exclusion at any depth. Hash all managed bytes for `manifest_sha256`; derive `build_relevant_sha256` from `Source/**`, `Build/**`, `ThirdParty/**`, and a canonical projection of `UEMCP.uplugin` fields that affect modules, dependencies, platforms, loading, and plugin requirements.

Target comparison reports `missing`, `extra`, and `changed` relative paths; it does not consult mtimes or receipts.

- [ ] **Step 3: Implement structured project plugin edits**

Use the merged JSONC helper. Normalize duplicate names case-insensitively as `MALFORMED_PROJECT_PLUGIN_LIST` instead of guessing. Modify only the `Plugins` array, preserving unrelated objects and fields. Planning returns exact before hash, after bytes/hash, and a concise `+`, `~`, `-`, `=` action list; apply rechecks before hash.

- [ ] **Step 4: Run and commit**

```powershell
node test-plugin-deployment.mjs
git add server/deployment/plugin-manifest.mjs server/deployment/uproject-plugins.mjs server/fixtures/plugin-deployment server/test-plugin-deployment.mjs
git commit -m "Add canonical UEMCP plugin manifests"
```

---

### Task 2: Implement Atomic Staging, Replacement, And Rollback

**Files:**
- Create: `server/deployment/plugin-deploy.mjs`
- Modify: `server/test-plugin-deployment.mjs`
- Reuse: `server/editor-processes.mjs`

**Interfaces:**

```js
export async function planPluginDeployment({ repoRoot, uprojectPath, sourcePluginRoot, fsImpl, processInspector, evidence });
// -> operation with source/destination/project fingerprints, manifests, generated policy, touched paths

export async function applyPluginDeployment(operation, {
  fsImpl,
  processInspector,
  windowsNative,
  clock,
  faultInjector,
});
// -> { status, changed, source_manifest, deployed_manifest, generated_manifest, rollback }
```

Sibling names are `.UEMCP.stage-<transaction-id>`, `.UEMCP.backup-<transaction-id>`, and rollback-only `.UEMCP.failed-<transaction-id>` under the verified target `Plugins` directory. The random transaction ID is fixed by the approved operation, contains only lowercase hex, and every create/rename/delete revalidates the exact canonical parent and expected basename.

- [ ] **Step 1: Add failure injection at every state transition**

Test invalid source/target, target outside project, source equals destination, missing core apply lease, matching editor, unrelated editor, unclassified or multiply linked target managed content, stage create/copy/hash failure, source drift during stage, destination drift or link-count drift during stage, editor starts before replacement, `.uproject` content/metadata drift, hard-linked `.uproject`, first rename failure, second rename failure, metadata-preserving project patch failure, generated-state write failure, post-swap verification failure, rollback failure, stale stage/backup/failed sibling, cross-volume path, and cleanup failure. Verify original plugin, `.uproject` bytes/DACL/alternate streams, deploy receipt, build input, and build evidence exact bytes/manifests survive every pre-commit or rolled-back failure. A retained rollback quarantine must be visible as action-required evidence and may never be mistaken for the active plugin.

Test deleted source file removes stale target file, resource-only change can carry compatible Binaries, build-relevant change cannot, Intermediate is omitted, and a healthy identical rerun makes no directory/file write.

Run `node test-plugin-deployment.mjs`.

Expected: fail on missing deploy module.

- [ ] **Step 2: Implement preflight and stage**

Require the core orchestrator's apply lease. Canonicalize `.uproject`, project root, `Plugins`, source, destination, stage, backup, and failed-quarantine paths. Require all transaction siblings and destination to share the exact parent and volume root. Inventory the existing target with the same top-level classifier; unknown or multiply linked managed target content returns `UNCLASSIFIED_TARGET_CONTENT` before staging so an atomic replacement cannot silently delete or alias user/tool-owned bytes. Match editor processes by canonical full `.uproject` through `canonicalEditorProjectPath`; any matching editor returns `EDITOR_LOCKED` before staging.

Create a fresh stage directory with exclusive semantics. Copy only managed manifest entries and verify every staged hash. If generated artifact evidence is compatible, copy its exact manifest entries and verify; otherwise do not create `Binaries`/`Intermediate` in stage. Prepare the project plugin patch but do not write it yet. Capture exact prior bytes/absence and hashes for all three `Saved/UEMCP/Deployment/UEMCP` state files; include them in the operation's touched paths and rollback record.

- [ ] **Step 3: Recheck TOCTOU state and commit**

Immediately before replacement, recompute source manifest, destination manifest/absence, `.uproject` composite content/metadata fingerprint, process list, and all real/link identities. Any drift returns `PLAN_STALE` and deletes stage without touching destination.

Commit order:

1. rename existing destination to backup when present;
2. rename stage to destination;
3. flush an exclusive same-directory `.uproject` replacement and commit it with core `replaceFilePreservingMetadata`;
4. recompute deployed managed/generated manifests;
5. atomically write the new deploy receipt and build-input under `Saved/UEMCP`; retain compatible build evidence or remove stale build evidence only as the approved operation specifies;
6. delete backup only after all verification succeeds.

On failure after step 1, restore `.uproject` exact bytes through the same metadata-preserving primitive and restore generated-state exact bytes/absence if written, move the failed destination to the exact failed-quarantine sibling, restore backup, verify every content/metadata restoration, then delete only the verified transaction-owned quarantine. A quarantine cleanup failure is retained and reported; it does not invalidate a verified restoration or trigger deletion by wildcard. Never recursively delete a path unless its canonical parent/name match the transaction's verified stage/backup/failed identifier and its creation token matches the active operation.

- [ ] **Step 4: Run and commit**

```powershell
node test-plugin-deployment.mjs
git add server/deployment/plugin-deploy.mjs server/test-plugin-deployment.mjs
git commit -m "Add atomic UEMCP plugin deployment"
```

---

### Task 3: Define Build Input, UBT Invocation, Artifact Evidence, And States

**Files:**
- Create: `server/deployment/unreal-build.mjs`
- Create: `server/deployment/build-evidence.mjs`
- Create: `server/test-plugin-build-evidence.mjs`

**Generated state paths:**

```text
<Project>/Saved/UEMCP/Deployment/UEMCP/deploy-receipt-v1.json
<Project>/Saved/UEMCP/Deployment/UEMCP/build-input-v1.sha256
<Project>/Saved/UEMCP/Deployment/UEMCP/build-evidence-v1.json
```

**Interfaces:**

```js
export function deploymentStatePaths(uprojectPath);
export function createBuildInput({ buildRelevantSha256, projectIdentity });
export async function inspectBuildEvidence({ uprojectPath, deployedPluginRoot, expectedBuildInput, fsImpl });
export function classifyPluginState({ sourceManifest, deployedManifest, buildEvidence, editorEvidence });
export async function runUnrealBuild(operation, { runner, fsImpl, clock });

export async function resolveUnrealEngine({ uprojectPath, explicitEngineRoot, runner, fsImpl });
export async function resolveEditorTarget({ projectRoot, explicitTarget, fsImpl });
export function parseUbtToolchainEvidence(stdout, stderr);
export async function discoverPluginArtifacts(pluginRoot, platform, { fsImpl });
```

- [ ] **Step 1: Write failing evidence and classifier tests**

Cover missing/corrupt/copied receipt, source mismatch, target project mismatch, engine/platform/target/config/toolchain mismatch, build exit nonzero, missing `.modules`, missing declared DLL, extra/changed artifact, artifact hash mismatch, valid evidence, legacy marker forgery, newer mtime forgery, and external build that changed the DLL without finalized evidence. Require `UNKNOWN` rather than current for unproven external builds.

Lock states `NOT_DEPLOYED`, `DEPLOYED_STALE`, `DEPLOYED_SOURCE_CURRENT`, `DEPLOYED_BUILD_REQUIRED`, `DEPLOYED_BUILD_CURRENT`, and `EDITOR_RESTART_REQUIRED` with separate `source`, `build`, and `editor` stage results.

Run `node test-plugin-build-evidence.mjs`.

Expected: fail on missing modules.

- [ ] **Step 2: Implement engine/target resolution and direct UBT launch**

Resolve an explicit engine root first. Otherwise read `.uproject` `EngineAssociation`, use the per-user registered-build map through bounded `reg.exe query`, and support standard launcher roots only when the association matches. Validate:

```text
<EngineRoot>/Engine/Binaries/DotNET/UnrealBuildTool/UnrealBuildTool.exe
```

Resolve exactly one `Source/*Editor.Target.cs` unless `--target` is supplied and verified. Planned UBT arguments are:

```text
<EditorTarget> Win64 Development -Project=<absolute .uproject> -WaitMutex -NoHotReloadFromIDE
```

Platform/configuration are explicit planned values; defaults are `Win64`/`Development`. Run the absolute UBT executable through the bounded process runner. Parse only stable compiler/toolchain/Windows SDK summary lines into structured evidence and retain no full build log in the receipt.

- [ ] **Step 3: Implement artifact discovery and evidence finalization**

After UBT exits `0`, parse the plugin's platform `.modules` JSON, require a `UEMCP` module entry, canonicalize the declared module binary under plugin `Binaries/<Platform>`, and hash every generated file retained as evidence. Final build evidence includes schema/producer, exact build-input hash, engine identity, platform, target, configuration, target type, structured toolchain observation, absolute invocation executable hash plus argument array, exit code `0`, artifact manifest, and timestamp.

Write build evidence only after all checks pass. A failed/missing toolchain parse returns `UNKNOWN_TOOLCHAIN` and cannot produce `DEPLOYED_BUILD_CURRENT` even on exit `0`.

- [ ] **Step 4: Implement conservative generated carry-forward**

Generated Binaries may be staged only when evidence self-validates, current artifact hashes match, target project identity is unchanged, and expected build-input hash equals evidence. A build-relevant hash change always yields `BUILD_REQUIRED`. Intermediate retention is hard-coded `false` in this slice and tested.

- [ ] **Step 5: Run and commit**

```powershell
node test-plugin-build-evidence.mjs
node test-plugin-deployment.mjs
git add server/deployment/unreal-build.mjs server/deployment/build-evidence.mjs server/test-plugin-build-evidence.mjs
git commit -m "Add immutable UEMCP build and artifact evidence"
```

---

### Task 4: Compile Immutable Build Identity Into The UEMCP Module

**Files:**
- Create: `plugin/UEMCP/Source/UEMCP/Public/UEMCPBuildIdentity.h`
- Create: `plugin/UEMCP/Source/UEMCP/Private/UEMCPBuildIdentity.cpp`
- Create: `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBuildIdentityTests.cpp`
- Modify: `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs`
- Modify: `server/test-plugin-build-evidence.mjs`

**C++ interface:**

```cpp
struct UEMCP_API FUEMCPBuildIdentity
{
	FString SchemaVersion;
	FString BuildInputSha256;
	FString EngineVersion;
	FString TargetName;
	FString TargetPlatform;
	FString TargetConfiguration;
	FString TargetType;
	FString Compiler;
	FString CompilerVersionRequest;
	FString WindowsSdkVersionRequest;
	FString Architecture;
	bool IsProven() const;
};

UEMCP_API const FUEMCPBuildIdentity& GetUEMCPBuildIdentity();
```

- [ ] **Step 1: Add failing Node source guards and C++ automation**

Source guards require `ExternalDependencies`, `Target.ProjectFile`, `Saved/UEMCP/Deployment/UEMCP/build-input-v1.sha256`, all identity macros, 64-lowercase-hex validation, and an `unproven` fallback when no project/evidence exists. C++ automation asserts schema `1.0`, non-empty target/engine fields, and `IsProven()` iff the build-input is 64 lowercase hex and not all zeroes.

Run:

```powershell
cd D:\DevTools\UEMCP\server
node test-plugin-build-evidence.mjs
```

Expected: source guards fail before files exist.

- [ ] **Step 2: Add Build.cs identity generation with UE-version-safe APIs**

In `UEMCP.Build.cs`, resolve the build-input file from `Target.ProjectFile?.Directory/Saved/UEMCP/Deployment/UEMCP/build-input-v1.sha256`. Add it to `ExternalDependencies` when present. Read one trimmed line and accept only `^[0-9a-f]{64}$`; otherwise use `unproven`.

Emit escaped string-literal definitions for build input, `Target.Version` engine fields, `Target.Name`, `Target.Platform`, `Target.Configuration`, `Target.Type`, and on Win64 `Target.WindowsPlatform.Compiler`, `CompilerVersion`, `WindowsSdkVersion`, and `Architecture`. Use only APIs verified in UE 5.3/5.6/5.7 source; an unavailable optional value is the literal `unspecified`, not an invented actual version.

- [ ] **Step 3: Implement the immutable C++ accessor**

Construct one function-local static `FUEMCPBuildIdentity` entirely from compile definitions. Do not read a marker, receipt, environment variable, or disk file at runtime. `IsProven()` validates the compiled hash shape.

- [ ] **Step 4: Run source tests and multi-version BuildPlugin matrix**

```powershell
cd D:\DevTools\UEMCP\server
node test-plugin-build-evidence.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .\test-plugin-build-matrix.ps1
```

Expected: Node source guards pass and UE 5.3/5.6/5.7 plugin builds compile. Standalone BuildPlugin identity is intentionally `unproven` because it has no target project build-input file.

- [ ] **Step 5: Commit Task 4**

```powershell
git add plugin/UEMCP/Source/UEMCP/Public/UEMCPBuildIdentity.h plugin/UEMCP/Source/UEMCP/Private/UEMCPBuildIdentity.cpp plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPBuildIdentityTests.cpp plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs server/test-plugin-build-evidence.mjs
git commit -m "Compile immutable UEMCP build identity"
```

---

### Task 5: Return And Verify Loaded Module Identity

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/EdgeCaseHandlers.cpp`
- Create: `server/deployment/plugin-live-verifier.mjs`
- Modify: `server/project-context.mjs`
- Modify: `server/test-plugin-get-editor-state-source.mjs`
- Modify: `server/test-deploy-awareness-source.mjs`
- Modify: `server/test-project-server-wire.mjs`
- Modify: `server/test-plugin-build-evidence.mjs`

**Editor response fields:**

```json
{
  "loaded_build_identity": {
    "schema_version": "1.0",
    "build_input_sha256": "...",
    "engine_version": "...",
    "target_name": "...",
    "target_platform": "Win64",
    "target_configuration": "Development",
    "target_type": "Editor",
    "compiler": "...",
    "compiler_version_request": "...",
    "windows_sdk_version_request": "...",
    "architecture": "...",
    "proven": true
  },
  "loaded_module_path": "<actual module filename>"
}
```

- [ ] **Step 1: Add failing source/wire/live-comparison tests**

Require `FModuleManager::Get().GetModuleFilename(FName(TEXT("UEMCP")))`, the compiled identity accessor, all response fields, and no use of `.uemcp-deploy-marker.json` to populate `loaded_build_identity`. Update fake wire payloads and `ProjectContext` snapshots to retain loaded identity separately from legacy `deployMarker`.

In Node live-verifier tests, cover editor closed, unrelated editor, project mismatch, plugin not loaded, empty/outside module path, unproven identity, build-input mismatch, target/engine mismatch, artifact hash mismatch, exact current identity, and stale loaded DLL after a successful on-disk rebuild. Port reachability alone must never return verified.

- [ ] **Step 2: Extend `get_editor_state` from compiled/runtime facts**

Serialize `GetUEMCPBuildIdentity()` under `loaded_build_identity`. Resolve `loaded_module_path` from `FModuleManager`, canonicalize to a full path when non-empty, and add a warning when unavailable. Keep legacy deploy-marker fields for callers that still display them, but rename internal comments and docs to make them historical diagnostics only.

- [ ] **Step 3: Implement live verification**

Require a process-list match for the canonical target `.uproject`, then call `get_editor_state` over the normal TCP path. Require the returned canonical `.uproject` to match again. Validate loaded identity fields against build evidence, require module path beneath the target plugin's `Binaries` tree, hash that actual file, and compare with evidence's UEMCP module artifact hash.

Map exact match to editor `VERIFIED`; expected on-disk build with a different loaded hash/identity to `EDITOR_RESTART_REQUIRED`; absent editor to `EDITOR_CLOSED`; absent module to `PLUGIN_NOT_LOADED`; and project mismatch to `PROJECT_MISMATCH`.

- [ ] **Step 4: Run Node and C++-source gates**

```powershell
node test-plugin-get-editor-state-source.mjs
node test-deploy-awareness-source.mjs
node test-project-server-wire.mjs
node test-plugin-build-evidence.mjs
```

Expected: all tests pass with legacy marker and loaded-build evidence represented separately.

- [ ] **Step 5: Commit Task 5**

```powershell
git add plugin/UEMCP/Source/UEMCP/Private/EdgeCaseHandlers.cpp server/deployment/plugin-live-verifier.mjs server/project-context.mjs server/test-plugin-get-editor-state-source.mjs server/test-deploy-awareness-source.mjs server/test-project-server-wire.mjs server/test-plugin-build-evidence.mjs
git commit -m "Verify the loaded UEMCP module identity"
```

---

### Task 6: Integrate Plugin Copy, Build, And Editor Stages Into The Orchestrator

**Files:**
- Create: `server/deployment/plugin-domain.mjs`
- Modify: `server/deployment/orchestrator.mjs`
- Modify: `server/deploy-uemcp.mjs`
- Modify: `server/test-deployment-bundle.mjs`
- Modify generated: `dist/deploy-uemcp.mjs`
- Modify generated: `dist/deploy-uemcp.manifest.json`
- Modify generated: `dist/THIRD_PARTY_NOTICES.txt`
- Modify: `server/test-plugin-deployment.mjs`
- Modify: `server/test-deployment-plan.mjs`

**Interfaces:**

```js
export function createPluginDomain({ repoRoot, fsImpl, processInspector, runner, tcpCommand });
// domain.name === 'plugin'; domain.order === 40
```

Planned operation types are `DEPLOY_PLUGIN`, `PATCH_PROJECT_PLUGINS`, and optional `BUILD_PLUGIN`. `PATCH_PROJECT_PLUGINS` is committed/rolled back inside the plugin transaction, not dispatched independently.

- [ ] **Step 1: Add failing aggregate stage/no-op tests**

Assert separate `plugin_source`, `plugin_build`, and `editor` stages for missing, stale, source-current/build-unknown, build-required, build-current/editor-closed, and build-current/editor-restart cases. A plan without `--build` may deploy source and finish `ACTION_REQUIRED/BUILD_REQUIRED`; a plan with `--build` contains exact engine/target/platform/configuration preconditions and invokes UBT only after successful deployment.

Assert a healthy rerun has no plugin/config operation and no write. Assert a client-domain failure does not roll back a committed plugin transaction and a plugin failure does not roll back a committed client transaction; aggregate result is `PARTIAL` with both stage histories.

- [ ] **Step 2: Implement plugin planning and apply**

Planning always recomputes source/destination/build evidence. Add `BUILD_PLUGIN` only when explicitly requested and all engine/target values resolve during planning. Apply deploys first, then runs UBT and finalizes build evidence. Verification recomputes manifests/evidence and performs live verification only when an editor is visible or explicitly requested.

- [ ] **Step 3: Add CLI build controls**

Add `--build`, `--engine-root <path>`, `--target <name>`, `--platform <name>`, and `--configuration <name>` to plan/verify/doctor. Apply cannot accept or override them; it consumes the exact saved operation. Initial automatic build support is `Win64 Development Editor`; other combinations inspect/report but require a separately release-gated build test.

- [ ] **Step 4: Run focused integration tests and commit**

```powershell
npm run build:deployment
node test-deployment-bundle.mjs
node test-plugin-deployment.mjs
node test-plugin-build-evidence.mjs
node test-deployment-plan.mjs
git add server/deployment/plugin-domain.mjs server/deployment/orchestrator.mjs server/deploy-uemcp.mjs server/test-plugin-deployment.mjs server/test-deployment-plan.mjs server/test-deployment-bundle.mjs dist
git commit -m "Integrate plugin deployment and build proof"
```

---

### Task 7: Run Real Build, Live Identity, Version, And Documentation Gates

**Files:**
- Modify: `plugin/UEMCP/UEMCP.uplugin`
- Modify: `manifest.json`
- Modify: `server/test-plugin-manifest.mjs`
- Modify: `docs/specs/plugin-design.md`
- Modify: `docs/specs/deployment-machine-interface.md`
- Verify all files from prior tasks.

- [ ] **Step 1: Bump plugin/bundle version in lockstep**

Set `plugin/UEMCP/UEMCP.uplugin` to integer `Version: 19`, `VersionName: "1.0.18"`, set `manifest.json.version` to `1.0.18`, and update the exact expected pair in `server/test-plugin-manifest.mjs`. Do not change manifest setup fields; entrypoint cleanup belongs to the next plan.

- [ ] **Step 2: Document evidence and state boundaries**

Document managed/generated manifests, `Saved/UEMCP` paths, atomic swap/rollback, build-relevant input, direct UBT command, actual toolchain evidence, artifact manifest, external-build `UNKNOWN`, compiled loaded identity, module hash, legacy marker non-authority, and all source/build/editor statuses. Include repair commands and state what can be verified with the editor closed.

- [ ] **Step 3: Run all offline/default gates**

```powershell
cd D:\DevTools\UEMCP\server
node test-plugin-deployment.mjs
node test-plugin-build-evidence.mjs
node test-plugin-get-editor-state-source.mjs
node test-deploy-awareness-source.mjs
node test-plugin-manifest.mjs
powershell -NoProfile -ExecutionPolicy Bypass -File .\test-plugin-build-matrix.ps1
node test-deployment-bundle.mjs
node run-rotation.mjs --json
```

Expected: all non-live assertions pass and UE 5.3/5.6/5.7 BuildPlugin matrix is green.

- [ ] **Step 4: Deploy and build one real UE 5.6 target with the editor closed**

Set explicit test paths without committing them:

```powershell
$env:UEMCP_TEST_UPROJECT='D:\Path\Project.uproject'
$env:UEMCP_TEST_ENGINE_ROOT='C:\Program Files\Epic Games\UE_5.6'
node ..\dist\deploy-uemcp.mjs plan --operation setup --project $env:UEMCP_TEST_UPROJECT --build --engine-root $env:UEMCP_TEST_ENGINE_ROOT --json | Set-Content -Encoding utf8NoBOM "$env:TMP\uemcp-plugin-plan.json"
$plan = Get-Content -Raw "$env:TMP\uemcp-plugin-plan.json" | ConvertFrom-Json
node ..\dist\deploy-uemcp.mjs apply --plan-file "$env:TMP\uemcp-plugin-plan.json" --approve-digest $plan.digest --non-interactive --json
node ..\dist\deploy-uemcp.mjs verify --project $env:UEMCP_TEST_UPROJECT --engine-root $env:UEMCP_TEST_ENGINE_ROOT --json
```

Expected: source and build are current, editor is `EDITOR_CLOSED`, evidence includes exact build-input/toolchain/artifact hashes, and a second plan has no plugin write.

- [ ] **Step 5: Relaunch the exact project and prove loaded identity**

After the editor fully loads and the MCP client restarts:

```powershell
$env:UEMCP_LIVE_SMOKE='1'
node ..\dist\deploy-uemcp.mjs verify --project $env:UEMCP_TEST_UPROJECT --json
node run-live-smoke.mjs
```

Expected: editor stage `VERIFIED`; returned `.uproject`, compiled build-input/context, loaded module path, and loaded DLL hash match evidence. Rebuilding on disk without restarting the editor in a controlled follow-up fixture must produce `EDITOR_RESTART_REQUIRED`, then return `VERIFIED` after restart.

- [ ] **Step 6: Commit and request review**

```powershell
git add plugin/UEMCP/UEMCP.uplugin manifest.json server/test-plugin-manifest.mjs docs/specs/plugin-design.md docs/specs/deployment-machine-interface.md
git commit -m "Document and version plugin deployment proof"
git diff --check origin/main...HEAD
```

The PR must include fixture totals, multi-engine BuildPlugin matrix, exact UBT command/exit, source/deployed/build/artifact hashes, live identity/module hash, no-op rerun proof, and explicit offline versus live claims. Merge before entrypoint cutover.
