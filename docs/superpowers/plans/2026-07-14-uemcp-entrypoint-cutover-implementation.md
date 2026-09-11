# UEMCP Entrypoint Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every supported setup, sync, watcher, verify, doctor, and migration entry point delegate to the merged deployment orchestrator without overwriting universal `.mcp.json` configuration or duplicating deployment policy.

**Architecture:** Keep a narrow PowerShell runtime resolver for the pre-Node boundary and move all discovery, planning, confirmation, apply, verification, and rendering into one Node workflow runner over the machine contract. Batch files become path-picker/bootstrap/argument-forwarding conveniences; legacy verify exports and flags remain compatibility facades while canonical classification comes from orchestrator doctor results.

**Tech Stack:** Windows batch, PowerShell 5.1+, Node.js 22 ES modules, merged deployment orchestrator/client/plugin domains, existing target profiles and rotation tests.

## Global Constraints

- Execute after the plugin/build-proof PR and the backward-compatible AI-Tools consumer PR are merged. Branch UEMCP from that fresh merged `origin/main` through `superpowers:using-git-worktrees`.
- Updating AI-Tools before removing legacy manifest assumptions prevents a latest-main compatibility window in which the central installer misinterprets UEMCP.
- A pre-Node launcher may locate/validate Node or, only from setup, explicitly install allowlisted Node LTS. It may not mutate dependencies, targets, plugin content, client config, or receipts.
- Treat a required Node install confirmation as a separate runtime-only exception. After re-probe, the orchestrator still performs full discovery and one exact plan confirmation.
- Require Node `>=22`. Do not describe Node 20 as supported.
- No batch or PowerShell wrapper may contain plugin copy/delete, `.uproject` JSON editing, client config editing, npm dependency policy, target-profile merge logic, deploy classification, or marker writing.
- Every batch wrapper invokes exact `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`; bare `powershell`, `pwsh`, and PATH-discovered PowerShell are forbidden. Security/AppX cmdlets are imported from exact system module manifests and called module-qualified so user modules/functions cannot shadow them.
- No wrapper may write or overwrite `.mcp.json`. `.mcp.json.example` is manual/project-scope documentation only.
- Every fresh-install wrapper invokes tracked `dist/deploy-uemcp.mjs`, not source modules that require `node_modules`. Regenerate and freshness-test the bundle after adding guided workflow commands.
- `--yes` approves only the fully rendered current plan digest. It cannot authorize an unplanned conflict, unknown version write, trust bypass, or stale plan.
- Setup selects every detected release-gated client by default. Plugin-only sync/watcher workflows list detected clients as `NOT_SELECTED` instead of hiding them.
- Preserve file-picker/no-argument usability for double-clicked Windows workflows.
- Keep legacy batch names and `verify-deploy.mjs` public exports during migration. Compatibility output may map new states to old labels, but it cannot use old mtime/marker classifiers as authority.
- `--regenerate-mcp-json` becomes a non-destructive deprecation path that emits a client-aware repair plan. It must never restore provider-specific overwrite behavior.
- Do not enable Python execution by default or require project environment variables in the normal manifest/config path.
- Run setup/sync end-to-end tests only against temporary projects, isolated client homes, an injected local-state root, and repository/cache copies under hostile-but-valid path names. Real project rollout is a separate final gate with editor/build actions reported truthfully.

---

## File Structure

- Create `Resolve-UemcpNode.ps1`: probe/validate an absolute Node runtime and optional explicitly confirmed winget bootstrap.
- Create `server/deployment/workflow-runner.mjs`: interactive plan rendering, one confirmation, pending-plan storage, exact-digest apply, and final rendering.
- Create `server/run-deployment-workflow.mjs`: CLI for `setup`, `sync`, `watch-sync`, and compatibility workflow modes.
- Modify `server/deploy-uemcp.mjs`: expose guided `setup`, `sync`, and `watch-sync` commands in the standalone bundle while preserving machine JSON commands.
- Modify `server/test-deployment-bundle.mjs` and generated `dist/*`: bundle and prove the guided entrypoints.
- Create `server/test-deployment-entrypoints.mjs`: runtime boundary, wrapper source, guided flow, confirmation, no-op, deprecated flag, and manifest tests.
- Reduce `setup-uemcp.bat`: resolve Node, preserve `.uproject` picker/argument UX, and forward to `dist/deploy-uemcp.mjs setup`.
- Reduce `sync-plugin.bat`: resolve Node, preserve `.uproject` picker/legacy flags, and forward to `dist/deploy-uemcp.mjs sync`.
- Reduce `setup-watcher.bat`: resolve Node and forward to `dist/deploy-uemcp.mjs watch-sync`.
- Update `migrate-targets.bat`, `verify-deploy.bat`, `smoke-live.bat`, and `test-uemcp-gate.bat`: use the shared runtime resolver and absolute Node executable while preserving each tool's own behavior.
- Modify `server/verify-deploy.mjs`: compatibility facade over orchestrator verify/doctor/sync; preserve imported exports and legacy text mapping.
- Modify `server/test-verify-deploy.mjs` and `server/test-verify-deploy-profiles.mjs`: canonical doctor mappings and compatibility behavior.
- Modify `server/project-hygiene.mjs` and `server/test-project-hygiene.mjs`: move setup/sync codename registration to one injectable planned helper instead of batch inline scripts.
- Modify `manifest.json`: declare deployment machine interface, remove required project-env/Python-default/postSetup assumptions, and retain version lockstep.
- Modify `.mcp.json.example`: label as manual project-scope example and use explicit canonical descriptor replacement tokens without project pinning.
- Modify `README.md`, `docs/README.md`, `docs/specs/configuration.md`, `docs/specs/deployment-machine-interface.md`, `AGENTS.md`, and `CLAUDE.md`: current setup, adapters, enablement/trust/restart/build states, wrappers, and migration.
- Modify existing setup/sync/source tests: `server/test-setup-uemcp-target-profile.mjs`, `server/test-sync-plugin-bat-safety.mjs`, `server/test-sync-plugin-helper.mjs`, `server/test-project-hygiene.mjs`, `server/test-plugin-manifest.mjs`, and `server/test-retired-legacy-surface.mjs`.

---

### Task 1: Implement The Narrow Node Bootstrap And Shared Workflow Runner

**Files:**
- Create: `Resolve-UemcpNode.ps1`
- Create: `server/deployment/workflow-runner.mjs`
- Create: `server/run-deployment-workflow.mjs`
- Modify: `server/deploy-uemcp.mjs`
- Modify: `server/test-deployment-bundle.mjs`
- Modify generated: `dist/deploy-uemcp.mjs`
- Modify generated: `dist/deploy-uemcp.manifest.json`
- Modify generated: `dist/THIRD_PARTY_NOTICES.txt`
- Create: `server/test-deployment-entrypoints.mjs`

**PowerShell interface:**

```powershell
Resolve-UemcpNode.ps1 [-NodeExe <absolute path>] [-AllowInstall] [-StateRoot <absolute path>] [-NonInteractive]
```

On success stdout contains exactly one canonical absolute `node.exe` path and exit is `0`. Stable failures: `10` missing, `11` unsupported, `12` install declined/noninteractive, `13` winget unavailable/install failed, `14` re-probe failed. Diagnostics go to stderr.

**Node interface:**

```js
export async function runDeploymentWorkflow({
  workflow: 'setup' | 'sync' | 'watch-sync',
  request,
  yes = false,
  orchestrator,
  localState,
  prompt,
  render,
});
```

- [ ] **Step 1: Write failing runtime-boundary and workflow tests**

Invoke the PowerShell script with fake `node.exe`, AppX package metadata, signature results, and `winget.exe` runner fixtures for missing, Node 20, Node 22, Node 24, declined install, failed install, successful install then stale PATH, supplied absolute runtime, untrusted PATH shadowing, unsigned/wrong-signer implicit Node, and noninteractive missing runtime. Cover a valid signed `Microsoft.DesktopAppInstaller` package, the normal zero-byte WindowsApps execution alias, wrong package family/publisher, non-OK package state, install-location escape, linked or missing payload executable, invalid Authenticode signature, version-probe failure, and user-defined `Get-AppxPackage`/`Get-AuthenticodeSignature` shadow canaries. Inject these through internal resolver/process seams rather than a production environment override or arbitrary executable parameter. Inject a temporary state root; require the script to choose its own receipt path beneath that root, reject a linked/escaping state root, and prove no path outside that fixed receipt changes before Node 22 is re-probed.

For the Node runner, fake plans for no-op, multi-client changes, conflict, expired-on-confirmation, apply failure, partial, and action-required. Assert all discovery completes before the prompt, plan digest and every detected client are rendered, one `yes` applies that exact saved plan, stale apply triggers replan and a new confirmation, and `--yes` never auto-resolves an unplanned conflict.

Run `node test-deployment-entrypoints.mjs`.

Expected: fail on missing bootstrap/runner files.

- [ ] **Step 2: Implement Node probe and allowlisted bootstrap**

Probe an explicit path first. For implicit discovery, inspect fixed regular-file candidates beneath `%ProgramFiles%\nodejs`, `%ProgramFiles(x86)%\nodejs`, and `%LOCALAPPDATA%\Programs\nodejs`; `Get-Command node.exe` may identify one of those exact canonical candidates but cannot authorize another location. Canonicalize paths, reject links/non-files, and require a valid Authenticode signature whose simple signer name is `OpenJS Foundation` before executing an implicit candidate. Run the exact executable with `--version`, parse numeric major/minor/patch, and require major at least 22. A valid nonstandard runtime remains usable only through the explicit `-NodeExe` parameter, which is fingerprinted and shown in the plan rather than treated as implicitly trusted discovery.

When `-AllowInstall` is present and interactive, print the exact proposed action and prompt once:

```text
Install the current Node.js LTS runtime with winget package OpenJS.NodeJS.LTS? [y/N]
```

Do not execute the zero-byte `%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe` App Execution Alias or any PATH candidate. Import exact system AppX and Security module manifests, then call module-qualified cmdlets to query the current-user `Microsoft.DesktopAppInstaller` package and inspect signatures. Require the exact package family/publisher and healthy package state, canonicalize its install location beneath `%ProgramFiles%\WindowsApps`, require its payload `winget.exe` to be a regular non-link file with a valid Microsoft Authenticode signature, and version-probe that exact executable. Run it with separate arguments `install`, `--id`, `OpenJS.NodeJS.LTS`, `--exact`, `--source`, `winget`, `--accept-source-agreements`, and `--accept-package-agreements`. Re-probe the fixed Node install locations; do not assume the current process PATH refreshed. Atomically write a redacted record beneath `<state-root>/receipts/` containing package ID/source, prior state, resolved runtime path/version, package identity, timestamp, and exit result; callers cannot choose an arbitrary receipt file.

- [ ] **Step 3: Implement the interactive workflow over machine APIs**

Call `orchestrator.plan`, render project/plugin/dependency/client/touched-path/trust/build/restart operations and digest, then prompt `Apply exactly plan <digest>? [y/N]`. Save the exact plan under local pending-plan storage, call `orchestrator.apply({ plan, approvedDigest })`, delete pending state after terminal result, and render every stage/client/action. In `yes` mode render the plan but skip only this installer confirmation.

`setup` selects detected release-gated clients. `sync` plans target/plugin only and includes detected clients as `NOT_SELECTED`. `watch-sync` generates a fresh sync plan per debounced target event and applies only when it has no conflict/policy/unknown-version operation; it logs the exact digest for each automatic apply.

- [ ] **Step 4: Implement strict workflow CLI parsing and bundle it**

Forward project/profile/build/client flags to planning. Support a no-project file-picker callback supplied by wrappers, not a workspace picker. Add `setup`, `sync`, and `watch-sync` top-level human commands to source `deploy-uemcp.mjs`; retain `plan`, `apply`, `verify`, `doctor`, and `repair` as the JSON machine contract. Regenerate `dist/deploy-uemcp.mjs` and require the bundle test to execute a declined guided setup by absolute bundle path from an unrelated directory with no `node_modules` and observe zero writes. Repeat from a valid pinned-release fixture, including downloader provenance, shaped like `<cache root>/bridges/UEMCP/<commit>/` whose absolute path contains spaces, Unicode, and shell metacharacters; source-root discovery, manifest verification, descriptor paths, and planned actions must be identical except for the tagged checkout/archive source identity and canonical root labels.

- [ ] **Step 5: Run and commit**

```powershell
npm run build:deployment
node test-deployment-bundle.mjs
node test-deployment-entrypoints.mjs
git add Resolve-UemcpNode.ps1 server/deployment/workflow-runner.mjs server/run-deployment-workflow.mjs server/deploy-uemcp.mjs server/test-deployment-entrypoints.mjs server/test-deployment-bundle.mjs dist
git commit -m "Add guided UEMCP deployment workflow"
```

---

### Task 2: Cut Setup Over To One Orchestrated Confirmation

**Files:**
- Modify: `setup-uemcp.bat`
- Modify: `server/project-hygiene.mjs`
- Modify: `server/test-setup-uemcp-target-profile.mjs`
- Modify: `server/test-project-hygiene.mjs`
- Modify: `server/test-deployment-entrypoints.mjs`

- [ ] **Step 1: Add failing setup-wrapper source and integration guards**

Require `setup-uemcp.bat` to contain the shared runtime resolver, one optional `.uproject` picker, absolute workflow runner, and argument forwarding. Require the exact system Windows PowerShell path for both resolver and picker and reject any bare `powershell`/`pwsh` token. Forbid `xcopy`, `robocopy`, `rmdir`, `.mcp.json`, `.uproject` JSON mutation, `node -e`, `npm install`, `node_modules` existence checks, deploy marker writes, and inline forbidden-token editing.

Run the wrapper in a temporary project with fake Node/workflow entry and assert path/quotes/exit codes forward exactly. Add integration tests using the real runner plus temporary project/client homes for dependency install plan, target registration, project codename registration, plugin plan, all-client plan, one confirmation, exact digest, action-required summary, and healthy no-op rerun.

- [ ] **Step 2: Reduce setup batch to bootstrap/picker/forwarding**

The batch derives repo root from `%~dp0`, invokes `Resolve-UemcpNode.ps1 -AllowInstall` through exact `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`, opens an Unreal `.uproject` file picker through that same executable only when no project argument is supplied, and invokes:

```text
<absolute node.exe> <repo>\dist\deploy-uemcp.mjs setup --project <absolute uproject> <forwarded flags>
```

Forward `--yes`, `--build`, `--engine-root`, `--target`, `--targets-file`, client include/exclude, and profile options as separate batch arguments. Preserve final outcome exit codes `0/10/20/30/64` and pause only for interactive double-click failures, not CI/noninteractive calls.

- [ ] **Step 3: Move codename hygiene into the planned target operation**

Refactor `registerProjectCodenames` to accept injected filesystem/Windows-native operations, plan exact additions to `.git/info/known-test-targets.txt`, reject links/hardlinks, recheck composite content/metadata evidence before apply, and use metadata-preserving replacement for an existing file or guarded rename for an absent file. Add it to the target-domain operation rather than invoking it from batch. Preserve skip literals/version handling, unrelated lines, DACLs, and alternate streams; metadata merge failure makes the target operation fail without a weaker fallback.

- [ ] **Step 4: Run and commit**

```powershell
node test-deployment-entrypoints.mjs
node test-setup-uemcp-target-profile.mjs
node test-project-hygiene.mjs
git add setup-uemcp.bat server/project-hygiene.mjs server/test-setup-uemcp-target-profile.mjs server/test-project-hygiene.mjs server/test-deployment-entrypoints.mjs
git commit -m "Route UEMCP setup through the orchestrator"
```

---

### Task 3: Cut Sync And Watcher Over To The Same Plugin Transaction

**Files:**
- Modify: `sync-plugin.bat`
- Modify: `setup-watcher.bat`
- Modify: `server/test-sync-plugin-bat-safety.mjs`
- Modify: `server/test-sync-plugin-helper.mjs`
- Modify: `server/test-deployment-entrypoints.mjs`

- [ ] **Step 1: Add failing sync/watcher source and parity tests**

Forbid copy/delete/marker/project-edit logic in both wrappers. Require shared runtime resolution and the same standalone deployment bundle. Execute setup and sync against identical source/temporary targets and compare resulting managed manifest, project plugin entries, deploy receipt schema, and plugin state; they must be identical.

Test `-y`/`--yes`, no-argument picker, quoted project path, `--force-clean`, `--no-marker`, profile target expansion, watcher debounce, matching editor, unrelated editor, plan conflict, and partial target failure. Deprecated flags must print actionable non-destructive messages: managed replacement already removes stale files; legacy marker suppression has no effect on proof.

- [ ] **Step 2: Reduce `sync-plugin.bat`**

Resolve Node without automatic install; when absent/unsupported, direct the user to setup. Preserve picker and legacy flag parsing only long enough to map flags to the Node workflow. Invoke `dist/deploy-uemcp.mjs sync`; do not call `sync-plugin-helper.mjs` for policy or marker state.

- [ ] **Step 3: Route watcher events through fresh digest-bound sync plans**

Keep debounce/profile enumeration in the Node workflow or a focused watcher helper. For each target, replan from current source/destination/editor state, print digest/status, and apply only the exact conflict-free plugin plan. Never reuse a plan across source changes or targets. A locked target is reported and skipped, not partially copied.

- [ ] **Step 4: Retire marker helper authority without breaking imports**

Keep `sync-plugin-helper.mjs` exports required by legacy tests/callers, label marker APIs deprecated, and remove them from all current wrappers/orchestrator paths. Add source guards proving canonical deploy and verify modules do not call `writeDeployMarker`, `compareDeployMarker`, or mtime classifiers.

- [ ] **Step 5: Run and commit**

```powershell
node test-sync-plugin-bat-safety.mjs
node test-sync-plugin-helper.mjs
node test-deployment-entrypoints.mjs
node test-plugin-deployment.mjs
git add sync-plugin.bat setup-watcher.bat server/sync-plugin-helper.mjs server/test-sync-plugin-bat-safety.mjs server/test-sync-plugin-helper.mjs server/test-deployment-entrypoints.mjs
git commit -m "Route sync and watcher through atomic deployment"
```

---

### Task 4: Make Verify-Deploy A Compatibility Facade Over Doctor Truth

**Files:**
- Modify: `server/verify-deploy.mjs`
- Modify: `verify-deploy.bat`
- Modify: `migrate-targets.bat`
- Modify: `server/migrate-targets.mjs`
- Modify: `smoke-live.bat`
- Modify: `test-uemcp-gate.bat`
- Modify: `server/test-verify-deploy.mjs`
- Modify: `server/test-verify-deploy-profiles.mjs`
- Modify: `server/test-migrate-targets.mjs`
- Modify: `server/test-deployment-entrypoints.mjs`

**Legacy text mapping:**

| Canonical doctor state | Legacy display label |
| --- | --- |
| Plugin absent | `MISSING` |
| Managed source mismatch | `NEEDS-SYNC` |
| Source current, build absent/stale/unknown | `NEEDS-BUILD` |
| Source and build current | `SYNC` |
| Every selected target source/build current | `ALL-SYNC` |

Client/protocol/editor action states appear in additional lines and are never folded into `SYNC`.

- [ ] **Step 1: Add failing compatibility tests**

Inject canonical doctor results for every plugin/client/protocol/editor state and assert mapping, profile selection, JSON passthrough, exit outcomes, and human actions. Cover repo-root checkout targets, stable pinned-archive targets across cache commits, explicit `--targets-file`, and legacy text migration into the source-aware structured default. Forge markers/mtimes while changing content and require `NEEDS-SYNC`. Preserve existing exported utility signatures used by tests, but assert the CLI path does not call legacy classifiers.

Test `--auto-sync` as a fresh plugin-only plan/digest apply, `--watch` forwarding to watch-sync, and `--regenerate-mcp-json` returning a deprecation notice plus client-aware repair plan without writing any config.

- [ ] **Step 2: Rebuild CLI behavior over orchestrator results**

`verify-deploy.mjs` reads targets/profiles through `resolveDefaultTargetsPath`, calls orchestrator verify/doctor per target, renders canonical stages plus legacy labels, and uses canonical outcomes for exit. `migrate-targets.bat` and its Node entry write the same source-aware structured default or an explicit `--targets-file`; a pinned archive never writes profiles into a commit cache. Keep old pure exports in a clearly marked compatibility section; no current state decision may depend on newest mtime or marker version.

- [ ] **Step 3: Update all thin batch launchers to use the shared Node resolver**

Replace bare `node` probes/calls with `Resolve-UemcpNode.ps1` output and absolute executable forwarding. Deployment verify/doctor calls use `dist/deploy-uemcp.mjs`; focused migration/live-smoke/commandlet scripts may continue to launch their source entry only after the resolver confirms dependencies, and must report dependency action rather than crash. Do not add runtime installation outside setup.

- [ ] **Step 4: Run and commit**

```powershell
node test-verify-deploy.mjs
node test-verify-deploy-profiles.mjs
node test-deployment-entrypoints.mjs
node test-migrate-targets.mjs
node test-run-live-smoke.mjs
git add server/verify-deploy.mjs verify-deploy.bat migrate-targets.bat server/migrate-targets.mjs smoke-live.bat test-uemcp-gate.bat server/test-verify-deploy.mjs server/test-verify-deploy-profiles.mjs server/test-migrate-targets.mjs server/test-deployment-entrypoints.mjs
git commit -m "Unify verify and doctor deployment truth"
```

---

### Task 5: Publish The Provider-Neutral Manifest, Manual Example, And Current Docs

**Files:**
- Modify: `manifest.json`
- Modify: `.mcp.json.example`
- Modify: `README.md`
- Modify: `docs/README.md`
- Modify: `docs/specs/configuration.md`
- Modify: `docs/specs/deployment-machine-interface.md`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `server/test-plugin-manifest.mjs`
- Modify: `server/test-deployment-entrypoints.mjs`

- [ ] **Step 1: Add failing manifest/example/doc source tests**

Require normal launch metadata to have absolute-descriptor replacement tokens, no required `UNREAL_PROJECT_ROOT`/`UNREAL_PROJECT_NAME`, no Python default `1`, no generic `postSetup` sync hook, and a versioned deployment interface pointing to `dist/deploy-uemcp.mjs`. Require `.mcp.json.example` to say manual/project-scope, omit project env/Python flags, and preserve replacement-token command/args arrays.

Scan current onboarding docs for claims that setup writes `.mcp.json`, Node 20 is accepted, markers/mtimes prove currentness, Claude is the only host, or copy success means ready. Archive-only history may retain old text when clearly labeled.

- [ ] **Step 2: Update `manifest.json` without breaking version lockstep**

Keep version `1.0.18` from the plugin plan. Replace project-env field requirements and `postSetup` with:

```json
"deploymentInterface": {
  "schemaVersion": "1.0",
  "entry": "dist/deploy-uemcp.mjs",
  "planCommand": "plan",
  "applyCommand": "apply",
  "doctorCommand": "doctor"
}
```

Retain only optional advanced runtime fields that the canonical descriptor can intentionally carry; set Python execution absent/off by default. The already-merged AI-Tools consumer must prefer this interface and reject unsupported schema versions.

- [ ] **Step 3: Rewrite the manual config example**

Use:

```json
{
  "mcpServers": {
    "uemcp": {
      "command": "<ABSOLUTE_NODE_EXE>",
      "args": ["<ABSOLUTE_UEMCP_REPO>/server/server.mjs"]
    }
  }
}
```

Add adjacent text that this is a manual project-scope example for hosts that consume this shape, not the automatic multi-client installation contract.

- [ ] **Step 4: Update onboarding and operational docs**

Document setup/sync/verify commands, Node 22/bootstrap exception, all four exact release-gated clients, generic manual descriptor, user-scope default, project attachment, enablement/trust/restart/build/editor states, editor-closed proof, explicit build option, machine JSON commands/exits, no-op behavior, and AI-Tools delegation. Update AGENTS/CLAUDE commands without embedding machine-local paths.

- [ ] **Step 5: Run and commit**

```powershell
node test-plugin-manifest.mjs
node test-deployment-entrypoints.mjs
node test-deployment-bundle.mjs
node test-provider-conformance.mjs
git add manifest.json .mcp.json.example README.md docs/README.md docs/specs/configuration.md docs/specs/deployment-machine-interface.md AGENTS.md CLAUDE.md server/test-plugin-manifest.mjs server/test-deployment-entrypoints.mjs
git commit -m "Publish provider-neutral UEMCP installation guidance"
```

---

### Task 6: Run End-To-End Migration, No-Op, Deployment-Tool, And Rollout Gates

**Files:**
- Verify all files named in this plan; fix only within plan scope.

- [ ] **Step 1: Run focused entrypoint and deployment suites**

```powershell
cd D:\DevTools\UEMCP\server
node test-deployment-entrypoints.mjs
node test-deployment-contracts.mjs
node test-deployment-prerequisites.mjs
node test-deployment-plan.mjs
node test-client-config-formats.mjs
node test-client-transaction.mjs
node test-client-adapters.mjs
node test-plugin-deployment.mjs
node test-plugin-build-evidence.mjs
node test-verify-deploy.mjs
node test-verify-deploy-profiles.mjs
node test-project-targets.mjs
node test-project-hygiene.mjs
node test-sync-plugin-bat-safety.mjs
node test-plugin-manifest.mjs
node test-deployment-bundle.mjs
```

Expected: every focused assertion passes.

- [ ] **Step 2: Run an isolated legacy migration scenario**

Create a temporary repo/project plus isolated Claude/Codex/Gemini/VS Code homes. Invoke the absolute setup entry from outside the checkout, then repeat against a valid pinned AI-Tools-cache-shaped release fixture containing spaces and Unicode. Seed a legacy project `.mcp.json` with UEMCP plus unrelated server, structured target profile, stale target plugin, and one unowned conflicting user entry. Run setup without `--yes`; assert the plan shows migration, all clients, conflict, plugin/build actions, and one confirmation. Decline and prove no writes. Replan with explicit conflict choice, apply exact digest, verify unrelated bytes/fields, rerun setup, and prove zero plugin/client writes. The checkout and cache-path runs must differ only in tagged source provenance/canonical source-root identity, not in operations or status classification.

- [ ] **Step 3: Run all batch wrapper smoke/source checks on Windows**

Exercise no-argument cancellation, quoted `.uproject`, Node 20 rejection, Node 22 forwarding, `--yes`, sync deprecated flags, migrate, verify, watcher startup/cancel, smoke-live clean skip, and commandlet-gate argument forwarding with fake targets. No test may install Node, touch real client homes, or invoke a real editor.

- [ ] **Step 4: Run installed-client contracts and default rotation**

```powershell
$env:UEMCP_INSTALLED_CLIENT_CONTRACT='1'
node test-installed-client-contracts.mjs
Remove-Item Env:UEMCP_INSTALLED_CLIENT_CONTRACT
node run-rotation.mjs --json
```

Expected: exact gated installed versions pass in isolated homes; version drift is explicit inspect-only. Default non-live rotation passes.

- [ ] **Step 5: Run real registered-target doctor before any rollout write**

```powershell
cd D:\DevTools\UEMCP
verify-deploy.bat
```

Review every registered target's source/build/client/protocol/editor stages. Close matching editors before selecting sync/build actions. Apply only reviewed target plans; do not bulk-write projects merely because they are listed.

- [ ] **Step 6: Verify changed real targets and live claims**

For each approved target, run setup/sync plan and exact-digest apply, build only when selected, then `verify-deploy.bat` again. Relaunch editors and run `smoke-live.bat` only for targets where editor health is claimed. Record `ACTION_REQUIRED` states rather than forcing success.

- [ ] **Step 7: Final diff, commit, and review**

```powershell
git diff --check origin/main...HEAD
git status --short
```

Commit any final in-scope correction with a focused subject; do not create an empty commit. The PR must list every wrapper audited, isolated migration/no-op evidence, installed-client versions, default rotation total, real target doctor/sync/build/live results, and any remaining human actions.
