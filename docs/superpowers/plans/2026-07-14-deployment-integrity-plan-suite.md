# Deployment Integrity Plan Suite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver one truthful, transactional UEMCP installation and verification system that deploys the Unreal plugin, configures every detected release-gated MCP host, remains provider-neutral, and integrates with AI-Tools without duplicating deployment truth.

**Architecture:** Execute six independently reviewable plans in dependency order. UEMCP owns the machine contract and all deployment classifiers; client adapters and plugin deployment plug into that contract, existing entry points become compatibility wrappers, and AI-Tools consumes the released machine interface from its own repository.

**Tech Stack:** Node.js 22 ES modules, MCP TypeScript SDK 1.29.x, Zod 3, JSON/JSONC/TOML structured parsers, esbuild 0.28.1 standalone deployment bundle, SHA-256, Windows process and filesystem APIs, Unreal Engine 5.3/5.6/5.7 C++, UE Automation Tests, PowerShell/batch wrappers, Node `node:test` in AI-Tools.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-14-deployment-integrity-and-multi-client-installation-design.md` as the approved behavioral authority. Do not reopen its decisions while executing a task.
- Require Node `>=22` using semantic parsing. A launcher may bootstrap only Node, with a separate explicit confirmation, before the orchestrator starts.
- Ship and freshness-test `dist/deploy-uemcp.mjs` as a self-contained planning/apply entry so a fresh checkout can review and install `server/node_modules` in the same approved plan. Source-only `server/deploy-uemcp.mjs` is the development entry, not the fresh-install bootstrap.
- Keep the canonical descriptor provider-neutral: absolute `node.exe`, absolute `server/server.mjs`, stdio transport, empty environment, and no working directory or project pin.
- Keep project registration separate from client configuration and preserve the existing structured `.uemcp-targets.json` API.
- Never overwrite an unowned same-name client entry, malformed config, managed policy, or concurrent external edit.
- Never use name-only ownership. Re-read current config and require a matching machine-local ownership record before replacing owned fields.
- Never pass generated command strings through a shell. Spawn allowlisted executables with argument arrays, `shell: false`, timeouts, output caps, and process-tree termination.
- Never persist secrets, complete client configs, or unrelated settings in plans, logs, receipts, or durable rollback metadata.
- Preserve exact pre-change client-config bytes for rollback. If the applied hash no longer matches, retain bounded recovery evidence and return `ROLLBACK_CONFLICT` without overwriting the newer edit.
- Serialize every UEMCP apply through one user-local cross-process lease. Acquire it before final precondition validation, hold it through receipts/replay bookkeeping and rollback, and never break a live owner's lease merely because a timeout elapsed.
- Treat plugin managed payload, generated binaries, and intermediates as separate lifecycles. Timestamps and mutable marker files are not deployment or build proof.
- Only compiled-in loaded-module identity plus the loaded module's artifact hash may prove which editor binary is running.
- Every detected release-gated client is selected by default or appears as `NOT_SELECTED`; unknown versions are inspect-only unless a tested compatibility rule explicitly permits writes.
- Do not bypass host trust, workspace approval, OS elevation, or UEMCP mutation guards.
- Keep server instructions below 2,048 UTF-8 bytes, make the first 512 bytes self-contained, and keep every tool description at or below 1,800 UTF-8 bytes.
- Keep `idempotentHint` and `openWorldHint` omitted in this slice. MCP annotations are untrusted hints, not enforcement.
- Use a new isolated worktree, created through `superpowers:using-git-worktrees`, for every plan. Branch each UEMCP plan from freshly merged `origin/main`; use a separate AI-Tools worktree for the final plan.
- Do not combine plans into one pull request. A later plan begins only after its dependency PR is merged and the new worktree is rebased on that merged main.

---

## Plan Files And Merge Order

| Order | Plan | Repository / branch | Depends on | Independently reviewable result |
| --- | --- | --- | --- | --- |
| 1 | `2026-07-14-provider-neutral-tool-metadata-implementation.md` | UEMCP / `feat/provider-neutral-tool-metadata` | Approved spec only | Provider-neutral instructions, bounded descriptions, supported SDK registration, requirement-derived annotations, brand-invariant protocol fixture. |
| 2 | `2026-07-14-deployment-core-implementation.md` | UEMCP / `feat/deployment-core` | Plan 1 merged | Versioned machine plan/apply/verify/doctor contract, prerequisites, descriptors, fingerprints, receipts, generic support, protocol smoke. |
| 3 | `2026-07-14-multi-client-adapters-implementation.md` | UEMCP / `feat/multi-client-adapters` | Plan 2 merged | Transactional Claude, Codex, Gemini CLI, and VS Code user-scope adapters with ownership and installed-client gates. |
| 4 | `2026-07-14-plugin-deployment-build-proof-implementation.md` | UEMCP / `feat/plugin-deployment-build-proof` | Plan 3 merged | One atomic content-hash plugin deployer, immutable build evidence, compiled loaded identity, truthful plugin/editor states. |
| 5 | `2026-07-14-ai-tools-uemcp-integration-implementation.md` | AI-Tools / `feat/uemcp-orchestrator-integration` | Plan 4 merged and standalone schema 1.0 available | AI-Tools previews, approves, applies, and diagnoses UEMCP through the exact machine digest and never converts partial state to success. |
| 6 | `2026-07-14-uemcp-entrypoint-cutover-implementation.md` | UEMCP / `feat/installation-cutover` | Plans 4 and 5 merged | Setup, sync, verify, manifest, examples, and docs delegate to the orchestrator without universal `.mcp.json` writes; the updated consumer is already compatible when legacy manifest assumptions are removed. |

Plans 3 and 4 both conceptually consume the core contract, but they must run sequentially because both integrate new domains into the same orchestrator and result schema. This avoids parallel edits to contract-bearing files and gives each PR a stable merged baseline.

## Locked Cross-Plan Machine Contract

The core plan owns these names. Later plans consume them exactly rather than creating aliases.

### CLI

```powershell
node dist/deploy-uemcp.mjs plan --operation setup --project "D:\Path\Project.uproject" --json
node dist/deploy-uemcp.mjs apply --plan-file "D:\Scratch\uemcp-plan.json" --approve-digest "<64-lowercase-hex>" --non-interactive --json
node dist/deploy-uemcp.mjs verify --project "D:\Path\Project.uproject" --json
node dist/deploy-uemcp.mjs doctor --project "D:\Path\Project.uproject" --json
node dist/deploy-uemcp.mjs repair --project "D:\Path\Project.uproject" --json
```

`plan`, `verify`, `doctor`, and `repair` also accept `--targets-file <absolute .json>`; `apply` never accepts a target/profile override because those choices are sealed into the saved plan.

`plan` writes one complete plan document to stdout. `repair` is a read-only convenience that writes a complete plan document with `operation: "repair"`; it never applies. `apply` consumes the exact saved plan plus its digest and never replans or widens operations. In `--json` mode stdout contains JSON only; diagnostics go to stderr. Interactive wrappers may render human summaries from the same result object.

`dist/deploy-uemcp.mjs` is generated from the source CLI and all deployment-only dependencies with built-in Node modules externalized. Its adjacent manifest records the exact input and bundle hashes. CI rebuilds and compares it byte-for-byte; stale generated output blocks merge. It does not contain or replace the normal MCP server, whose canonical descriptor remains `server/server.mjs` after dependency readiness is established.

### Schema And Outcomes

```js
export const DEPLOYMENT_SCHEMA_VERSION = '1.0';
export const OUTCOMES = Object.freeze({
  HEALTHY: 'HEALTHY',
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
});
export const EXIT_CODES = Object.freeze({
  HEALTHY: 0,
  ACTION_REQUIRED: 10,
  PARTIAL: 20,
  FAILED: 30,
  USAGE: 64,
});
```

Every non-plan machine result has this top-level shape:

```js
{
  schema_version: '1.0',
  kind: 'uemcp.deployment.result',
  operation: 'apply' | 'verify' | 'doctor',
  outcome: 'HEALTHY' | 'ACTION_REQUIRED' | 'PARTIAL' | 'FAILED',
  timestamp: '<ISO-8601>',
  source: {
    kind: 'git_checkout' | 'pinned_archive',
    repository,
    repo_root,
    git_commit,
    dirty,
    archive: null | {
      archive_sha256,
      baseline_manifest_sha256,
      current_manifest_sha256,
      provenance_sha256,
    },
    orchestrator_version,
  },
  request: { requested_project, requested_profile, selected_clients },
  descriptor: { name, transport, command, args, env: {}, cwd: null },
  plan: null | { digest, created_at, expires_at, preconditions_valid },
  stages: [{ name, status, mandatory, changed, evidence, actions }],
  clients: [{ adapter, version, compatibility, write_supported, selected, scope, status, enablement, activation, actions }],
  receipts: [{ kind, path_label, sha256 }],
  actions: [{ code, message, command: null | { executable, args } }],
}
```

`plan` is non-null only for an `apply` result and identifies the exact consumed plan. Standalone `verify` and `doctor` results set it to `null`; a prior receipt digest belongs in receipt evidence, not a fabricated current plan. Client `compatibility` is exactly `release_gated`, `known_unsupported`, `unknown_newer`, or `not_installed`; `write_supported` is true only for `release_gated`. Client `status` is structural registration/transaction state, `enablement` is host enable/policy state, and `activation` is connection/trust/restart state. `NOT_SELECTED` and `NOT_INSTALLED` populate all three state fields consistently; an unsupported version remains structurally inspectable and exposes `UNSUPPORTED_VERSION` as an action/domain status rather than erasing config truth. Action commands are argument arrays for display or explicit caller handling, never shell command strings and never implicit authorization to execute. Paths exposed to humans use stable labels and canonical paths only when needed for remediation. `evidence` never contains secret values or full config bytes. `PLAN_STALE`, `PLAN_DIGEST_MISMATCH`, `PLAN_EXPIRED`, `PLAN_REPLAYED`, `ROLLBACK_CONFLICT`, and every stage status in the spec are stable action/status codes, not prose-only distinctions.

### Canonical Plan Digest

- The plan document has `kind: "uemcp.deployment.plan"`, `schema_version: "1.0"`, `operation` (`setup`, `sync`, or `repair`), `outcome`, `created_at`, `expires_at`, `source` (the same tagged provenance shape as machine results), `request`, `descriptor`, `stages`, `clients`, `operations`, `preconditions`, `actions`, and `digest`.
- `expires_at` is exactly 30 minutes after `created_at` unless tests inject another duration.
- Canonical JSON recursively sorts object keys, preserves array order, emits no insignificant whitespace, and rejects non-finite numbers, `undefined`, functions, symbols, and cycles.
- Digest input is the entire plan except its `digest` member. The stored digest is lowercase SHA-256 hex. The plan command exits with the numeric code for its own `outcome`; consumers validate the plan kind/schema/digest before interpreting that nonzero code.
- Preconditions include existence, canonical target, content hash, link type, and version probe for every path or executable that can affect the reviewed operations.
- Apply verifies schema, digest, expiry, one-time receipt/replay state, and every precondition before taking a snapshot or writing.

### Local State

Use `%LOCALAPPDATA%\UEMCP` by default, injectable in every test:

```text
%LOCALAPPDATA%\UEMCP\state\ownership-v1.json
%LOCALAPPDATA%\UEMCP\state\dependency-stamp-v1.json
%LOCALAPPDATA%\UEMCP\state\.uemcp-targets.json
%LOCALAPPDATA%\UEMCP\state\deployment-apply-v1.lock
%LOCALAPPDATA%\UEMCP\plans\applied-v1.json
%LOCALAPPDATA%\UEMCP\receipts\<timestamp>-<operation>-<digest>.json
%LOCALAPPDATA%\UEMCP\snapshots\<transaction-id>\
```

Snapshot directories are user-restricted, are deleted after successful apply or verified rollback, and expire after seven days only when retained for `ROLLBACK_CONFLICT`. The lease file is exclusively created, records a random owner token plus PID/process-start observation, and is released only by that owner. A stale lease is reclaimable only after the owner is proven absent and a bounded grace period passes. Receipts contain hashes and statuses, never snapshot contents.

Checkout-based workflows keep the existing repo-root `.uemcp-targets.json` default. A pinned archive defaults to the stable local-state `.uemcp-targets.json`, so a commit-keyed AI-Tools cache update cannot hide registered projects. An explicit canonical `--targets-file` overrides either default and uses the same structured target API.

### Domain And Transaction Boundaries

1. The prerequisite/domain planner is read-only.
2. Project target registration is a distinct planned operation.
3. Plugin deployment is one transaction and does not share rollback with client config.
4. All selected client writes are one deterministic transaction ordered `claude`, `codex`, `gemini`, `vscode`.
5. Verification and receipts run after each committed domain.
6. A client rollback does not undo a valid plugin deployment; the aggregate result becomes `PARTIAL` and identifies both outcomes.

### Release Gates

| Host surface | Evidence baseline | Default scope | Unknown newer version behavior |
| --- | --- | --- | --- |
| Claude Code | `2.1.209` and `2.1.210` isolated CLI round trips plus official scope/managed-policy/approval docs | User registration; read-only user/project/local/managed approval and disable settings | Inspect-only and `UNSUPPORTED_VERSION` until compatibility is expanded; never approve or enable automatically. |
| Codex host config shared by Codex CLI/IDE/ChatGPT desktop | `0.144.4` isolated CLI round trip plus official config and managed-policy docs | User `$CODEX_HOME/config.toml`; trusted root-to-leaf project layers; read-only `%ProgramData%\OpenAI\Codex\requirements.toml`; host-reported cloud policy | Inspect-only for policy layers; never repeat same-name `mcp add` or rewrite client-owned `enabled`. Cloud cache internals and desktop UI activation remain unproven. |
| Gemini CLI | `0.41.2` isolated CLI round trip plus official user/project/system/enablement docs and installed-source path verification | User `<GEMINI_CLI_HOME or user home>\.gemini\settings.json`; separate enablement file is read-only | Inspect-only; never set workspace trust or persistent/session enablement. |
| VS Code | `1.128.1` isolated native `Code.exe + cli.js` contract, profile-resource fixtures, and official MCP/profile docs | Default or one explicitly selected existing user profile; honor `useDefaultFlags.mcp` | Inspect-only; never invoke the GUI/profile creation, mutate separate enablement state, or claim window activation headlessly. |
| Unknown standards-compatible host | MCP protocol smoke only | Manual | Emit `MANUAL_REGISTRATION_REQUIRED` plus the canonical descriptor. |

The implementation documents exact tested versions and may widen ranges only after isolated contract evidence is added in the same PR.

## Execution Checklist

- [ ] **Plan 1:** Create the UEMCP metadata worktree, execute `2026-07-14-provider-neutral-tool-metadata-implementation.md`, pass its focused and full rotation gates, merge its PR, and remove the worktree/branch.
- [ ] **Plan 2:** Fetch merged `origin/main`, create the deployment-core worktree, execute `2026-07-14-deployment-core-implementation.md`, merge only after machine-schema fixtures and the full rotation pass, then remove the worktree/branch.
- [ ] **Plan 3:** Create the client-adapter worktree from merged core, execute `2026-07-14-multi-client-adapters-implementation.md`, run isolated installed-client tests without touching real homes, merge, and clean up.
- [ ] **Plan 4:** Create the plugin/build-proof worktree from merged adapters, execute `2026-07-14-plugin-deployment-build-proof-implementation.md`, close the editor for deployment/build gates, run live loaded-identity proof after relaunch, merge, and clean up.
- [ ] **Plan 5:** In `D:\DevTools\AI-Tools`, reconcile its intended main/remote tip, create a separate worktree, execute `2026-07-14-ai-tools-uemcp-integration-implementation.md` against merged UEMCP schema 1.0, merge, and clean up.
- [ ] **Plan 6:** Create the UEMCP cutover worktree from merged build proof after the AI-Tools consumer is live, execute `2026-07-14-uemcp-entrypoint-cutover-implementation.md`, prove no-op and migration behavior against isolated homes/projects, merge, and clean up.
- [ ] **Rollout:** From merged UEMCP main, run `verify-deploy.bat`, sync selected registered projects through the new planner, build where reported, and run opt-in live smoke only for projects whose editors are relaunched.

## Acceptance-Criteria Coverage Matrix

| Spec criterion | Owning plan and task(s) | Required proof |
| --- | --- | --- |
| 1 | Cutover Tasks 1-5 | Setup fixtures and source guard prove no universal `.mcp.json` write. |
| 2 | Core Tasks 1, 5-7; Clients Task 9; Cutover Task 2 | One plan/digest/confirmation fixture with explicit bootstrap/trust exceptions. |
| 3 | Clients Tasks 5-9 | Fixture tests plus opt-in isolated installed CLI/profile tests at gated versions. |
| 4 | Clients Tasks 3-4, 9; Plugin Tasks 1-2; Cutover Task 6 | Before/after hashes and write spies prove zero writes on a healthy rerun. |
| 5 | Clients Tasks 1, 4-8 | Golden exact-byte and AST-aware preservation fixtures. |
| 6 | Clients Tasks 3-9 | Unowned mismatch returns `CONFLICT`; applied bytes remain unchanged. |
| 7 | Clients Task 4 | Failure injection after every adapter, exact rollback, and concurrent-edit `ROLLBACK_CONFLICT`. |
| 8 | Clients Tasks 5-8 | Scope lattice fixtures classify matching shadowed, conflict effective, and policy blocked. |
| 9 | Clients Tasks 5-9; Plugin Tasks 3-6 | Distinct enablement/trust/restart/build/editor-restart action states. |
| 10 | Core Task 6; Clients Task 9 | Effective descriptor initializes and completes initial `tools/list`. |
| 11 | Metadata Tasks 4-5 | Brand-name/native-tool scan over instructions and runtime tips. |
| 12 | Metadata Tasks 4-5 | UTF-8 byte budget tests at 512, 1,800, and 2,048 boundaries. |
| 13 | Metadata Tasks 1-3 | Every listed tool's annotations equal the requirement-derived mapping. |
| 14 | Plugin Tasks 1-2; Cutover Tasks 2-3 | Setup/sync destination manifests are identical. |
| 15 | Plugin Tasks 1-3, 6 | Forged marker/mtime fixtures cannot hide managed-payload hash drift. |
| 16 | Plugin Tasks 1-3 | Deleted managed files disappear; generated artifacts require compatible evidence. |
| 17 | Plugin Tasks 3-6 | Build-input/context/artifact hashes drive currentness; existence/mtime do not. |
| 18 | Plugin Tasks 4-7 | Live handshake identity and loaded-module hash match expected evidence. |
| 19 | Core Task 1; Plugin Task 6; Clients Task 9 | Result schema keeps copy, build, client registration, client enablement, activation, protocol, and editor health in separate stages/fields. |
| 20 | Clients Tasks 2, 9 | Detection result includes every release-gated host as selected or `NOT_SELECTED`. |
| 21 | Core Tasks 2, 5; Clients Task 4; Plugin Task 2 | Digest, expiry, replay, exclusive apply lease, executable/path drift, and TOCTOU tests prove zero writes or concurrent UEMCP overwrite. |
| 22 | AI-Tools Tasks 1-7 | Pinned-cache and fake-UEMCP contract tests prove exact source provenance, digest approval, hostile manifest-command non-execution, checkout/cache-path independence, and truthful outcome mapping. |
| 23 | Core Tasks 2, 5, 7; Clients Tasks 3-4; Plugin Task 3 | Secret canary scan over plans, stderr, receipts, ledgers, and recovery records. |
| 24 | Every plan's final task | Focused suites, default UEMCP rotation, C++/build proof where applicable, and AI-Tools test suite. |
| 25 | Clients Task 9; Cutover Task 5 | Version matrix, scope behavior, unknown/manual support, trust, and restart docs. |
| 26 | Core Task 3; Cutover Task 1 | Missing/Node 20/bootstrap fixtures prove only allowlisted runtime mutation precedes planning. |
| 27 | Clients Tasks 3-9 | Ledger absence/tamper/stale/copied-config/name-only tests cannot authorize replacement. |

No acceptance criterion is owned only by the AI-Tools plan except criterion 22. UEMCP must be independently correct before the external installer consumes it.

## Final Release Evidence

After all six PRs are merged, collect one release evidence bundle containing:

```text
UEMCP commit and clean status
AI-Tools commit and clean status
Node and npm versions
default UEMCP rotation JSON
focused deployment/client/plugin test results
installed-client versions and isolated-home roots
Unreal Build.bat command and exit result
plugin source, deployed, build-input, and artifact hashes
live get_editor_state loaded identity and module hash
AI-Tools installer/doctor result fixtures
post-rollout per-project verify/doctor results
```

Do not call the release fully healthy when a selected project still reports build, editor restart, client trust, or host restart action. Preserve those states in the final receipt and rollout report.
