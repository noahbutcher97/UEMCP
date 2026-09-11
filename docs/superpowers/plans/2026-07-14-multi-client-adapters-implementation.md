# Multi-Client Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Configure and verify Claude Code, the Codex host, Gemini CLI, and VS Code through one ownership-aware, exact-rollback client transaction while preserving unrelated configuration and host trust boundaries.

**Architecture:** Add format-aware config editors and a common adapter contract on top of the merged deployment core. Discovery reports every supported host and every relevant scope; planning classifies effective state and ownership before mutation; one central transaction snapshots all selected client files, applies adapters in deterministic order, verifies hashes and native status, and rolls back without clobbering concurrent edits.

**Tech Stack:** Node.js 22 ES modules, `jsonc-parser` 3.3.1, `toml-eslint-parser` 0.12.0, SHA-256 ownership ledger, bounded process runner, installed Claude/Codex/Gemini/VS Code CLIs in opt-in isolated-home tests.

## Global Constraints

- Execute only after the deployment-core PR is merged and branch from that merged `origin/main` through `superpowers:using-git-worktrees`.
- Pin `jsonc-parser` to `3.3.1` and `toml-eslint-parser` to `0.12.0`. The latter supports Node 22; do not upgrade to a release whose engine floor exceeds the repository's `>=22` contract without a separate dependency decision.
- Use structured parsers and range edits. Do not use regex or ad hoc line search to parse JSON, JSONC, or TOML.
- Default to private user scope. Project/workspace scope remains explicit opt-in and absolute machine paths are never written to shared config by default.
- Release-gate exact installed versions initially: Claude Code `2.1.209` and `2.1.210`, Codex `0.144.4`, Gemini CLI `0.41.2`, and VS Code `1.128.1`. Unknown versions remain inspect-only and return `UNSUPPORTED_VERSION` for writes.
- Resolve npm shims to an allowlisted package entry and launch it through an absolute `node.exe`; launch native clients through an absolute `.exe` only after canonical standard-root validation. `where.exe`/PATH output is a discovery clue, not authority to execute an arbitrary same-name binary. Do not execute `.cmd`/`.bat` through `cmd.exe` and do not use `shell: true`.
- Preserve unrelated servers, comments, unknown fields, approval modes, per-tool policy, enabled/required state, timeout fields, inputs, sandbox fields, trust fields, and every user-owned environment key/value.
- Never set Gemini trust, VS Code trust, blanket approvals, `alwaysLoad`, or equivalent bypasses.
- Treat registration, persistent enablement, session enablement, trust, restart, protocol health, and in-host activation as separate evidence. Gemini's persistent enablement file and VS Code's host-owned global/workspace enablement state are read-only to UEMCP; a configured but disabled server is never promoted to healthy or silently enabled.
- Preserve custom environment but never normalize it into installer ownership. Report `CUSTOM_ENV_REVIEW_REQUIRED` for any `UEMCP_*` or `UNREAL_*` key and for launch/state-sensitive keys including `NODE_OPTIONS`, `NODE_PATH`, `PATH`, `PATHEXT`, `COMSPEC`, `HOME`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`, and `GEMINI_CLI_HOME`; compare names case-insensitively and expose names/value hashes only. Preserve a custom non-null working directory but report `CUSTOM_LAUNCH_REVIEW_REQUIRED` because it changes workspace/project attachment semantics.
- Never repeat a same-name native `add` operation. A same-name unowned difference is `CONFLICT`; an owned-field external edit requires explicit replacement in the approved plan.
- Ownership is keyed by adapter, canonical config path, scope, and entry name. A copied file/path or missing/tampered/stale ledger cannot authorize replacement.
- Canonicalize every client home/profile and config path before planning. A writable existing config or ownership ledger must remain beneath its selected root after `realpath`, be a regular file with link count one, and retain that file identity through apply; for a missing file, resolve and validate every existing ancestor before planning directory creation. Linked/hard-linked aliases, relative traversal, device paths, and writes to discovered managed/system scopes are hard conflicts.
- Every detected release-gated client is selected unless explicitly excluded; excluded clients remain in the plan/result as `NOT_SELECTED`.
- Bound client-state inspection before decoding: at most 16 MiB per config/metadata file, 64 MiB aggregate per adapter, and 512 profile/extension records, with lower injectable test limits. Exceeding a byte/count/output ceiling returns `INSPECTION_LIMIT_EXCEEDED`, performs no client write or native mutation, and never silently truncates effective-state discovery.
- Snapshot exact bytes for every touched file before the first client write. Capture a bounded Windows metadata fingerprint for each existing writable file. On failure, restore in reverse write order only while the current content-plus-metadata fingerprint equals UEMCP's applied fingerprint.
- For an existing writable config or ownership ledger, write and flush an exclusive same-directory replacement, then use the core metadata-preserving Windows replacement helper. Never fall back to rename-overwrite when ACL/attribute/stream merging fails. Use exclusive rename only for a target proven absent.
- Installed-client tests are opt-in, use isolated homes/profiles, and must prove real user config paths/hashes are unchanged before and after the suite.
- Regenerate and freshness-test `dist/deploy-uemcp.mjs` after adding parser-backed adapters so fresh installs can inspect every client before dependency installation. Never hand-edit `dist` output.

---

## File Structure

- Modify `server/package.json` and `server/package-lock.json`: add exact JSONC and TOML parser dependencies.
- Create `server/deployment/config-bytes.mjs`: bounded fatal UTF-8 decode and BOM preservation shared by client config parsers.
- Create `server/deployment/jsonc-config.mjs`: parse, inspect, targeted set/remove, BOM/newline/indent preservation, and structural verification.
- Create `server/deployment/toml-config.mjs`: parser-backed table/key inspection and range edits preserving comments/unrelated tables.
- Create `server/deployment/client-process.mjs`: allowlisted executable/npm-package resolution and version probing.
- Create `server/deployment/client-contract.mjs`: adapter interface, scope/effective-state enums, normalized entries, field diffs, and supported-version gate.
- Create `server/deployment/ownership-ledger.mjs`: current-config-bound owned-field records and adoption/replacement classification.
- Create `server/deployment/client-transaction.mjs`: exact snapshots, TOCTOU checks, deterministic apply, verify, reverse rollback, conflict retention, and no-op behavior.
- Create `server/deployment/client-discovery.mjs`: aggregate detection, selection, scope enumeration, and unknown/generic result.
- Create `server/deployment/adapters/claude.mjs`: Claude user/local/project/plugin/managed inspection, deterministic fresh registration, migration, and native status.
- Create `server/deployment/adapters/codex.mjs`: user/project TOML inspection, policy preservation, targeted writes, and CLI structural status.
- Create `server/deployment/adapters/gemini.mjs`: user/project/system JSONC inspection, read-only enablement inspection, targeted writes, and trust/enablement-aware native status.
- Create `server/deployment/adapters/vscode.mjs`: default/explicit profile-resource and workspace JSONC inspection, targeted writes, and separate restart/trust/enablement status.
- Create `server/deployment/client-domain.mjs`: orchestrator domain combining discovery, planning, transaction apply, and verification.
- Create `server/fixtures/client-config/`: golden config/scope/ledger/malformed/rollback fixtures for all four adapters.
- Create `server/test-client-config-formats.mjs`: parser/edit preservation tests.
- Create `server/test-client-transaction.mjs`: ownership, TOCTOU, rollback, concurrency, redaction, and aggregate selection tests.
- Create `server/test-client-adapters.mjs`: per-adapter fixture and native-output parser tests.
- Create `server/test-installed-client-contracts.mjs`: opt-in installed-version isolated-home round trips.
- Modify `server/deployment/orchestrator.mjs`: register the client domain through the existing domain interface only.
- Modify `server/deploy-uemcp.mjs`: add client include/exclude and explicit-scope/profile flags without changing machine output shape.
- Modify generated `dist/deploy-uemcp.mjs`, `dist/deploy-uemcp.manifest.json`, and `dist/THIRD_PARTY_NOTICES.txt` through `server/build-deployment-cli.mjs`.
- Modify `docs/specs/deployment-machine-interface.md`: client fields, selection, ownership, rollback, and adapter compatibility.
- Create `docs/specs/client-adapters.md`: exact supported versions, scopes, precedence, enablement/trust/restart limits, and generic/manual support.

---

### Task 1: Add Parser-Backed Exact-Preservation Config Editors

**Files:**
- Modify: `server/package.json`
- Modify: `server/package-lock.json`
- Create: `server/deployment/config-bytes.mjs`
- Create: `server/deployment/jsonc-config.mjs`
- Create: `server/deployment/toml-config.mjs`
- Create: `server/fixtures/client-config/`
- Create: `server/test-client-config-formats.mjs`

**Interfaces:**

```js
export function decodeConfigBytes(bytes, { pathLabel, maxBytes });
// -> { text, had_utf8_bom }; rejects invalid UTF-8, UTF-16 BOM, NUL, and oversize input

export function parseJsoncDocument(bytes, { pathLabel });
export function getJsoncValue(document, jsonPath);
export function setJsoncValue(document, jsonPath, value);
export function removeJsoncValue(document, jsonPath);
// edit result -> { before_bytes, after_bytes, changed, parsed_value, edits }

export function parseTomlDocument(bytes, { pathLabel });
export function getTomlTable(document, dottedPath);
export function patchTomlTable(document, dottedPath, ownedValues);
export function removeTomlTable(document, dottedPath);
// edit result has the same normalized shape
```

- [ ] **Step 1: Install exact parser dependencies and create the failing fixture suite**

From `server/` run:

```powershell
npm install --save-exact jsonc-parser@3.3.1 toml-eslint-parser@0.12.0
```

Create golden fixtures covering UTF-8 BOM, CRLF/LF, tabs/two/four-space indent, comments, trailing commas, empty files, missing parent objects/tables, quoted/dotted TOML keys, arrays, inline tables, multiline strings, duplicate keys/tables, malformed syntax, credentials in unrelated fields, non-ASCII paths, invalid/overlong UTF-8 sequences, UTF-16 LE/BE BOMs, embedded NUL, per-file byte-limit rejection before decode, and aggregate discovery-limit rejection without partial results.

Write tests that change only the intended logical entry and assert byte-for-byte equality for every untouched prefix/range. Parse the resulting document again and assert semantic values. Decode with `TextDecoder('utf-8', { fatal: true })` only after the byte limit passes. Malformed encoding/syntax or duplicate ambiguous input must return `MALFORMED_CONFIG` with no output bytes.

Run `node test-client-config-formats.mjs`.

Expected: fail with missing config modules.

- [ ] **Step 2: Implement JSONC targeted edits**

Use `decodeConfigBytes`, then `jsonc-parser.parseTree`, `findNodeAtLocation`, `modify`, and `applyEdits`. Detect and preserve UTF-8 BOM, dominant newline, and indentation. Reject decode/parse errors before editing. Sort multiple edits in reverse offset order and reject overlap. An unchanged deep-equal owned value returns the original `Buffer` instance and `changed: false`.

- [ ] **Step 3: Implement TOML AST range edits**

Use `decodeConfigBytes`, then `parseTOML` from `toml-eslint-parser@0.12.0`; locate tables and key/value nodes through AST ranges and resolved keys. Update only owned value ranges when a table exists; insert missing owned keys immediately after the table's last key while preserving newline/indent; append a missing `[mcp_servers.uemcp]` table with one separating blank line. Reject duplicate target tables/keys, decode/parser errors, and unsupported target value shapes.

Serialize owned values with deterministic TOML strings and arrays:

```toml
[mcp_servers.uemcp]
command = "C:\\Program Files\\nodejs\\node.exe"
args = ["D:\\DevTools\\UEMCP\\server\\server.mjs"]
```

Do not parse TOML by splitting lines or searching for bracket text.

- [ ] **Step 4: Run parser tests and dependency integrity**

```powershell
node test-client-config-formats.mjs
npm ci --dry-run
```

Expected: all preservation/malformed tests pass and package/lock are consistent.

- [ ] **Step 5: Commit Task 1**

```powershell
git add server/package.json server/package-lock.json server/deployment/config-bytes.mjs server/deployment/jsonc-config.mjs server/deployment/toml-config.mjs server/fixtures/client-config server/test-client-config-formats.mjs
git commit -m "Add exact-preservation JSONC and TOML editors"
```

---

### Task 2: Resolve And Version-Gate Client Executables Without Shell Wrappers

**Files:**
- Create: `server/deployment/client-process.mjs`
- Create: `server/deployment/client-contract.mjs`
- Create: `server/test-client-adapters.mjs`

**Interfaces:**

```js
export const CLIENT_IDS = Object.freeze(['claude', 'codex', 'gemini', 'vscode']);
export const RELEASE_GATES = Object.freeze({
  claude: Object.freeze({ versions: ['2.1.209', '2.1.210'] }),
  codex: Object.freeze({ versions: ['0.144.4'] }),
  gemini: Object.freeze({ versions: ['0.41.2'] }),
  vscode: Object.freeze({ versions: ['1.128.1'] }),
});

export async function resolveClientLaunch(clientId, { env, fsImpl, runner, candidates });
// -> { client_id, command, args_prefix, env_overlay, package_id, source, version, fingerprint, write_supported }
export function classifySupportedVersion(clientId, version);
```

Allowlisted npm packages are `@anthropic-ai/claude-code`, `@openai/codex`, and `@google/gemini-cli`. VS Code must resolve to the native tuple `{ command: <absolute Code.exe>, args_prefix: [<absolute versioned resources/app/out/cli.js>], env_overlay: { ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } }`; direct `Code.exe` is the GUI, not the CLI. A `.cmd` wrapper is only a read-only discovery/characterization clue and is never executed.

- [ ] **Step 1: Write failing resolver tests**

Fixture executable discovery with missing commands, duplicate PATH entries, native `.exe`, npm `.cmd`/`.ps1` shims, a malicious same-name executable earlier on PATH, a native executable outside standard roots, unsigned/wrong-signer Claude and VS Code binaries, a malicious shim pointing outside its package, package `bin` as string/object, missing package manifest, version timeout, extra version text, exact supported versions, older versions, and unknown newer versions. Add VS Code fixtures for a valid official wrapper, wrapper/path escape, missing or multiple versioned `cli.js` candidates, direct-GUI invocation, and a mismatched `Code.exe`/`cli.js` install root. Assert rejected PATH candidates are never spawned, the returned `command` always ends in `.exe` on Windows (`node.exe` for JS packages), every argument remains an array element, environment overlays contain only the fixed allowlisted keys, and no resolver invokes a shell wrapper or GUI process.

Run `node test-client-adapters.mjs`.

Expected: fail on missing modules.

- [ ] **Step 2: Implement allowlisted launch resolution**

Use absolute `%SystemRoot%\System32\where.exe` only for read-only discovery through the bounded runner. Treat PATH results as untrusted candidates until validated. The initial native allowlist is Claude at `%USERPROFILE%\.local\bin\claude.exe` and stable VS Code at `%LOCALAPPDATA%\Programs\Microsoft VS Code\Code.exe` or `%ProgramFiles%\Microsoft VS Code\Code.exe`; canonicalize case, links, file identity, and exact basename before any spawn. Use the merged core `inspectAuthenticode` helper and require valid evidence with simple signer name `Anthropic, PBC` for Claude and `Microsoft Corporation` for VS Code. A nonstandard or invalidly signed native path is reported as a rejected candidate and is never version-probed in this slice. For an npm shim, locate the allowlisted package relative to the shim's canonical npm prefix, parse its `package.json`, resolve the declared `bin` entry beneath the package root, and return `{ command: canonicalNodeExe, args_prefix: [canonicalBinEntry], env_overlay: {} }`. Reject package-ID mismatch, path escape, linked escape, or non-regular entry.

For VS Code, read but never execute a discovered `bin\code.cmd`, validate its relative `Code.exe` and versioned `resources\app\out\cli.js` references beneath one canonical install root, or accept a standard install only when exactly one same-root CLI candidate is proven. Version-probe with the full native tuple, fixed environment overlay, and `args_prefix.concat('--version')`; parse the first semantic-version line. Include the executable, CLI script, and overlay in the launch fingerprint. A direct `Code.exe --version` result is invalid even if it exits, because it can launch the GUI.

The bounded runner merges `env_overlay` into a fresh child-environment object after copying the selected process environment; fixed adapter keys win, the parent environment is never mutated, and no overlay value is serialized into plans or receipts. Tests must prove omission or alteration of either VS Code overlay key fails the contract and that all child processes terminate on timeout.

- [ ] **Step 3: Lock inspect-only unknown-version behavior**

`classifySupportedVersion` returns `release_gated`, `known_unsupported`, or `unknown_newer`. Both unsupported states allow config inspection/native read-only status only and set `write_supported: false`. No `--yes` or conflict choice can override this in the current schema.

- [ ] **Step 4: Run and commit**

```powershell
node test-client-adapters.mjs
git add server/deployment/client-process.mjs server/deployment/client-contract.mjs server/test-client-adapters.mjs
git commit -m "Add bounded release-gated client discovery"
```

---

### Task 3: Implement Current-Config-Bound Ownership

**Files:**
- Create: `server/deployment/ownership-ledger.mjs`
- Create: `server/test-client-transaction.mjs`

**Interfaces:**

```js
export function ownershipKey({ clientId, configPath, scope, entryName = 'uemcp' });
export async function inspectOwnership({ ledger, currentEntry, desiredEntry, location });
// -> { state: 'unowned'|'owned_matching'|'owned_user_modified'|'stale_record', owned_diff, client_diff }
export async function adoptExactEntry({ ledger, location, currentEntry, desiredEntry, approvedOperationId });
export async function recordOwnedWrite({ ledger, location, beforeEntry, afterEntry, ownedPaths, appliedConfigHash, planDigest });
```

Ledger record:

```js
{
  client_id,
  canonical_config_path,
  scope,
  entry_name: 'uemcp',
  owned_paths: ['/type', '/command', '/args'],
  value_hashes: { '/type': '<hex>', '/command': '<hex>', '/args': '<hex>' },
  applied_config_sha256: '<hex>',
  plan_digest: '<hex>',
  written_at: '<ISO-8601>'
}
```

- [ ] **Step 1: Add failing ownership/adoption tests**

Test absent ledger, exact canonical owned projection with absent/empty/custom environment, differing unowned entry, matching record, stale value hash, changed owned path, added/changed user environment key, changed client-owned field, missing field, tampered ledger JSON, copied config at another path, moved home, same name at another physical scope, multiple logical contexts resolving to one physical resource, and name-only match. Cover VS Code `useDefaultFlags.mcp` so a named profile inheriting default `User\mcp.json` reuses the default physical scope/ledger key and produces one operation, while a profile-specific resource has a distinct physical scope. Cover adapter-specific physical projections: Claude/VS Code own `type`/`command`/`args`; Codex/Gemini own only `command`/`args`; semantic `cwd: null` maps to physical omission and never creates ownership of an absent field. Require adoption to be a distinct plan operation, preserve every environment value byte-for-byte, expose only environment key names/value hashes in plans, and require differing owned projections to stay `CONFLICT`.

Run `node test-client-transaction.mjs`.

Expected: fail on missing ownership module.

- [ ] **Step 2: Implement ownership as evidence, not authority**

Always parse current config first. `scope` in an ownership key is the resolved physical write scope after inheritance/alias resolution, never merely the requested logical profile. Preserve requested profiles/contexts as result evidence, deduplicate rows that resolve to the same canonical config path/scope/entry, and plan at most one write/ledger operation for that physical entry. Represent ownership as format-neutral JSON-pointer-like paths and hash each normalized owned value with canonical JSON. Each adapter declares only physical fields it actually writes; omitted optional fields are not owned. The initial canonical descriptor owns no `/env/*` paths; an empty env object in a fresh entry does not grant future ownership of user-added keys. A record is usable only when key, config path, physical scope, entry name, path set, and last written value hashes match the current owned values. Client-owned paths are excluded from replacement and preserved. A self-hash can detect accidental ledger corruption but cannot authorize writes by itself.

- [ ] **Step 3: Implement visible exact-entry adoption**

Adoption writes only the ownership ledger, never provider config, and requires an `ADOPT_EXACT_ENTRY` operation carrying the current entry hash and approved plan digest. Recheck exact equality of the canonical owned projection immediately before adoption. Record user environment key names and redacted value hashes, adoption, and any security-sensitive override action in the receipt/client result without recording values.

- [ ] **Step 4: Run and commit**

```powershell
node test-client-transaction.mjs
git add server/deployment/ownership-ledger.mjs server/test-client-transaction.mjs
git commit -m "Add current-config-bound client ownership"
```

---

### Task 4: Build The Exact-Byte Multi-Client Transaction

**Files:**
- Create: `server/deployment/client-transaction.mjs`
- Modify: `server/test-client-transaction.mjs`

**Interfaces:**

```js
export function createClientTransaction({ localState, fsImpl, clock });

transaction.snapshot(plannedClients);
transaction.apply({ planDigest, adapters, operations, context });
// -> { status, clients, touched_files, rollback, retained_snapshots }
transaction.rollback({ reason });
```

Adapter interface consumed by the transaction:

```js
{
  id,
  detect(context),
  inspect(context, detection),
  plan(context, inspection, desired),
  snapshot(context, plannedOperations), // returns canonical touched paths; central transaction stores bytes
  apply(context, plannedOperations),    // returns applied path/hash records
  verify(context, expected),
  rollback(context, rollbackRecords),   // delegates guarded restore to central transaction
}
```

- [ ] **Step 1: Add exhaustive failure-injection tests**

Create fake adapters in locked order `claude`, `codex`, `gemini`, `vscode`. Inject failure before first write, after each adapter write, during structural reread, during native verify, and during rollback. Assert all potentially writable configs plus the ownership ledger are snapshotted before the first write; read-only policy, approval, enablement, profile-metadata, and executable evidence is fingerprinted/rechecked but never snapshotted as writable state. Require the core apply lease, applied hashes, exact-byte reverse restoration, removal of absent originals, removal of transaction-created parent directories only when still empty/owned, metadata restoration, and snapshot deletion after success/verified rollback.

Simulate concurrent default-stream, DACL, attribute, and alternate-stream edits after UEMCP writes but before rollback. Require every newer state to survive, result `ROLLBACK_CONFLICT`, restricted snapshot retention, path-only remediation, and seven-day expiry. Simulate two adapters sharing one config path and require one snapshot plus deterministic non-overlapping operations or a planning conflict; simulate two logical contexts in one adapter resolving to one physical entry and require exact deduplication. Inject relative traversal, a config or ownership-ledger symlink/junction escaping the selected home, a multiply linked writable file, link-count drift, a Windows device path, a managed/system-scope write request, case aliases, a missing config below a linked ancestor, directory-creation failure, metadata-inspection overflow/failure, metadata-preserving replacement failure, and a concurrent second UEMCP apply; all unsafe/concurrent writes fail before snapshots while a canonical in-root path succeeds after acquiring the lease. Add a Windows integration fixture with an explicit DACL and canary alternate data stream; successful apply and rollback preserve both, while merge failure leaves original bytes/metadata unchanged and never invokes rename-overwrite.

Run `node test-client-transaction.mjs`.

Expected: fail on missing transaction module.

- [ ] **Step 2: Implement preflight and snapshots**

Require the core orchestrator's apply lease before transaction preflight. The plan fingerprints every inspected writable or read-only path, including absence/link identity for policy, approval, enablement, profile metadata, client launch files, and config. Reject any operation not present in the approved plan, any unselected adapter, any unknown version write, any config outside its adapter-declared canonical writable root, any changed path/link-count/file-identity/fingerprint, any non-regular or multiply linked existing writable file, and any read-only target before creating snapshots. For a missing target, record each absent parent the transaction may create and recheck the nearest existing ancestor immediately before creation. Read-only managed/system/host-state roots may contribute effective-state evidence but never writable paths. Snapshot only the sorted union of adapter-reported writable config paths plus the ownership ledger under one transaction ID.

- [ ] **Step 3: Implement deterministic apply and verification**

Apply only planned operations in adapter order. Flush an exclusive same-directory replacement first. For an existing file, call core `replaceFilePreservingMetadata`; for a still-absent file, recheck absence and rename the replacement into place. After each write, reread through the adapter's structured parser, recompute bounded metadata evidence, require existing-file metadata equality, and record the exact composite content/metadata fingerprint. Do not use an ignore-merge flag or weaker fallback. Native verification is bounded and cannot retroactively broaden writes. A structural success plus enablement/trust/restart action commits the transaction with `ACTION_REQUIRED`; it is not an apply failure.

- [ ] **Step 4: Implement guarded reverse rollback**

For each changed path in reverse order, compare the current composite content/metadata fingerprint to UEMCP's applied fingerprint. Restore exact snapshot only on equality, using the same metadata-preserving replacement path for an originally existing file and guarded deletion for an originally absent file. Reapply captured mutable timestamps/mode only after content/ACL/stream-preserving replacement succeeds. On any content or metadata mismatch, skip that path, retain its snapshot, continue safe restorations, and return `ROLLBACK_CONFLICT`. Verify every restored content/metadata fingerprint or absence before claiming rollback. Never include snapshot bytes, SDDL, stream names, or stream contents in the result.

- [ ] **Step 5: Run and commit**

```powershell
node test-client-transaction.mjs
git add server/deployment/client-transaction.mjs server/test-client-transaction.mjs
git commit -m "Add transactional multi-client config apply"
```

---

### Task 5: Implement The Claude Code Adapter

**Files:**
- Create: `server/deployment/adapters/claude.mjs`
- Add: `server/fixtures/client-config/claude-*`
- Modify: `server/test-client-adapters.mjs`

**Scopes and locations:**

- user/local state in `<CLAUDE_CONFIG_DIR>/.claude.json` when set, otherwise `%USERPROFILE%\.claude.json`; local-scope records in that file are keyed by canonical project path;
- user approval/settings `<CLAUDE_CONFIG_DIR>/settings.json` when set, otherwise `%USERPROFILE%\.claude\settings.json`, inspected read-only for `enableAllProjectMcpServers`, `enabledMcpjsonServers`, and `disabledMcpjsonServers`;
- project `.mcp.json` at the active workspace root;
- project approval/settings `.claude/settings.json` and `.claude/settings.local.json`, with tracked/untracked and workspace-trust semantics preserved;
- plugin-provided MCP declarations reported by installed Claude plugin metadata;
- Windows managed policy at `C:\Program Files\ClaudeCode\managed-mcp.json` and managed settings at `C:\Program Files\ClaudeCode\managed-settings.json` when present.

Use native `claude mcp list` and `claude mcp get uemcp` for read-only status. Never run `add`, `add-json`, or `remove` against the real config: `2.1.210` creates an unpredictable full-config file under `backups/` even for a fresh add, outside the transaction's declared touched paths. Fresh and owned writes use the parser-backed transaction.

- [ ] **Step 1: Add failing scope, migration, and native-output tests**

Cover absent, user exact, user conflict, project exact shadowing, project conflict, local entry, plugin entry, managed allow/deny, malformed project/user JSON, pending project approval, connected, rejected, CLI timeout, unknown version, unrelated servers, and old setup `.mcp.json` migration. Add user/project/local/managed settings fixtures for `enableAllProjectMcpServers`, enabled/disabled server lists, conflicting approvals, committed project approval ignored before workspace trust, untracked local approval gated by trust, user approval valid before project trust, managed disable, and native output that disagrees with structural approval. Include the observed `2.1.210` contract: isolated `CLAUDE_CONFIG_DIR` writes `.claude.json` plus a timestamped full-config backup, repeated same-name user `add-json` exits `1`, and existing config bytes remain unchanged. Add a spawn guard forbidding native mutating subcommands in production apply and a write spy proving the planned config/ledger paths are the only writes. Migration may remove only `mcpServers.uemcp`; it removes the file only when installer-created and otherwise empty.

- [ ] **Step 2: Implement normalized inspection and precedence**

Return every discovered occurrence with `scope`, `path_label`, normalized descriptor, ownership, and policy/native status. Classify config, enablement, and activation independently. Parse known settings files structurally but never edit approval/disable keys. A user/project/local disable yields enablement `DISABLED` plus `CLIENT_ENABLEMENT_REQUIRED`; a managed disable yields enablement `POLICY_BLOCKED`; committed project approval in an untrusted workspace yields activation `PENDING_TRUST`. Native status wins for effective activation, and disagreement remains explicit evidence rather than being normalized away.

- [ ] **Step 3: Implement plan/apply/verify**

Create a missing user `.claude.json` or target `mcpServers.uemcp` through `setJsoncValue`; update only owned paths in an existing object. Fresh user registration writes/owns only `type`, `command`, and `args`; semantic `cwd: null` is omission, not a JSON null or owned path, and no environment key is owned by default. Existing entries whose owned projection is exact can be adopted visibly while preserving custom environment/working-directory fields and emitting the applicable review action. Old project migration and user registration are both explicit operations in the same approved client transaction. Never approve or re-enable a project server automatically. Native `get/list` verifies the resulting structure/activation after commit without authoring files; CLI-supplied `--settings` and other unobservable host invocation policy remain `POLICY_UNKNOWN` when they can affect the result.

- [ ] **Step 4: Run and commit**

```powershell
node test-client-adapters.mjs
node test-client-transaction.mjs
git add server/deployment/adapters/claude.mjs server/fixtures/client-config server/test-client-adapters.mjs
git commit -m "Add the Claude Code deployment adapter"
```

---

### Task 6: Implement The Codex Host Adapter

**Files:**
- Create: `server/deployment/adapters/codex.mjs`
- Add: `server/fixtures/client-config/codex-*`
- Modify: `server/test-client-adapters.mjs`

**Scopes and locations:**

- user `$CODEX_HOME/config.toml`, defaulting to the current user's `.codex/config.toml`;
- project `.codex/config.toml` discovered from the active workspace/repository scope;
- Windows system requirements at `%ProgramData%\OpenAI\Codex\requirements.toml` when present; and
- effective enterprise/cloud requirements reported by the installed host. Treat the signed cloud bundle, its cache, and legacy `managed_config.toml` as host-owned policy inputs: do not discover private cache paths heuristically and never edit them.

Project config participates only for a trusted project. Inspect every `.codex/config.toml` from the Git/project root through the active working directory in Codex precedence order, rather than assuming a single root file. The system requirements file is read-only policy evidence. A configured `mcp_servers` allowlist must match both the `uemcp` name and canonical stdio identity; a policy-disabled exact entry is `POLICY_BLOCKED`, not healthy and not a config-write failure.

Canonical table:

```toml
[mcp_servers.uemcp]
command = "<absolute node.exe>"
args = ["<absolute server.mjs>"]
```

Preserve `enabled`, `required`, startup/tool timeouts, approval settings, enabled/disabled tool lists, per-tool policy, comments, and every unrelated table. An absent `enabled` field uses the host default; explicit `enabled = false` is client-owned disablement and is never rewritten. `codex mcp get uemcp --json` and `codex mcp list --json` are native structural evidence only.

- [ ] **Step 1: Add failing TOML, scope, and native-output tests**

Cover table absence/exact/conflict, explicit `enabled = false`, enabled omission/default, trusted nested project precedence, untrusted project layers being ignored, `%ProgramData%\OpenAI\Codex\requirements.toml` absent/allow/deny/identity-mismatch cases, opaque cloud-policy refusal reported by the host, comments around owned fields, the observed `0.144.4` same-name add replacement with exit `0`, fresh-add before/after file-manifest containment, approvals/timeouts/per-tool fields, malformed/duplicate tables, unknown version, list/get omission of client-owned fields, and Codex CLI success that still requires host restart. Tests must prove the adapter never writes `enabled` or any system, cloud, cache, or legacy managed-policy input.

- [ ] **Step 2: Implement parser-backed inspection and planning**

Use the merged TOML AST helper for every user, project, and readable system-policy file. Compare only canonical owned fields; preserve all other table keys. Never use native `mcp add` when the table exists. Resolve trusted project layers root-to-leaf, classify ignored untrusted layers separately, and treat project/managed differences as shadowing/policy rather than user-entry health. Classify an effective exact entry with `enabled = false` as config `CONFIGURED`, enablement `DISABLED`, activation `UNKNOWN`, and `CLIENT_ENABLEMENT_REQUIRED`, not conflict or health. Do not claim that reading the system file enumerates cloud-delivered policy; combine local inspection with native host outcomes and retain enablement `POLICY_UNKNOWN` when effective policy cannot be proven.

- [ ] **Step 3: Implement targeted apply and native verify**

For an absent table on exact release-gated versions, recheck absence and invoke native `codex mcp add uemcp -- <absolute node.exe> <absolute server.mjs>` inside the central transaction; the installed contract must prove only the snapshotted `config.toml` changes. Never invoke it when the name exists because `0.144.4` replaces the table. The Codex adapter owns only physical `command` and `args`. Use `patchTomlTable` only for owned existing updates so comments, `cwd`, environment maps/tables, and unrelated tables survive; preserved non-null `cwd` produces `CUSTOM_LAUNCH_REVIEW_REQUIRED`. A table with an exact owned projection can be adopted without config write. Parse native list/get with explicit missing-field semantics and report `RESTART_REQUIRED` after structural change; do not claim Codex IDE or ChatGPT desktop activation from CLI list/get.

- [ ] **Step 4: Run and commit**

```powershell
node test-client-config-formats.mjs
node test-client-adapters.mjs
node test-client-transaction.mjs
git add server/deployment/adapters/codex.mjs server/fixtures/client-config server/test-client-adapters.mjs
git commit -m "Add the Codex host deployment adapter"
```

---

### Task 7: Implement The Gemini CLI Adapter

**Files:**
- Create: `server/deployment/adapters/gemini.mjs`
- Add: `server/fixtures/client-config/gemini-*`
- Modify: `server/test-client-adapters.mjs`

**Scopes and locations:**

- release-gated global Gemini directory `<canonical GEMINI_CLI_HOME>\.gemini` when `GEMINI_CLI_HOME` is set, otherwise `%USERPROFILE%\.gemini`;
- user `<global Gemini directory>\settings.json`;
- persistent enablement `<global Gemini directory>\mcp-server-enablement.json`, inspected read-only;
- extension declarations `<global Gemini directory>\extensions\<extension>\gemini-extension.json` and path-sensitive extension state `<global Gemini directory>\extensions\extension-enablement.json`, inspected read-only;
- project `<workspace>\.gemini\settings.json`;
- Windows system defaults `C:\ProgramData\gemini-cli\system-defaults.json`;
- Windows system override `C:\ProgramData\gemini-cli\settings.json`.

Canonical user entry is a targeted `mcpServers.uemcp` JSONC object with absolute `command`, `args`, and no trust override. The separate persistent enablement document is a strict JSON map keyed by normalized server ID; absent `uemcp` means enabled and `{ "uemcp": { "enabled": false } }` means disabled. Session disablement exists only in the running client and is accepted only from bounded native output. Native verification uses bounded `gemini mcp list`.

- [ ] **Step 1: Add failing scope, preservation, and trust tests**

Cover user exact/conflict, project/system shadowing, system policy override, `mcp.allowed`/`mcp.excluded` policy, comments/trailing commas, unrelated servers, explicit `trust: false`, existing user trust fields, untrusted workspace disconnected output, connected output, timeout, malformed config, destructive sequential project-add characterization guard, and unknown version. Add extension fixtures for enabled/disabled/path-overridden declarations, user same-name precedence, extension-only `uemcp`, multiple extension declarations, variable-bearing entries whose secret values must not be expanded or emitted, malformed manifests/enablement, link/containment escapes, record-count overflow, and aggregate-byte overflow. Add persistent server-enablement fixtures for missing file, absent key/default enabled, normalized UEMCP disabled, unrelated disabled servers, malformed JSON, linked/path-escaped file, read-only file, and a native session-disabled result. Assert `GEMINI_CLI_HOME=<scratch>\home` resolves config beneath `<scratch>\home\.gemini`, not directly beneath the override.

- [ ] **Step 2: Implement JSONC inspection and planning**

Use precedence from the official scope contract and report every occurrence. Enumerate regular in-root extension manifests and extension enablement without hydrating extension variables or reading secret stores. User/project/system settings take precedence over an extension declaration of the same name; enabled extension declarations fill only absent names before admin filtering. Any extension-provided `uemcp` that would be newly shadowed by a user write is an explicit unowned conflict/override operation, never an incidental side effect. Never set or change `trust`, `mcp.allowed`, `mcp.excluded`, extension state, persistent server enablement, or session enablement; preserve them as client-owned/host-owned evidence. A policy exclusion yields enablement `POLICY_BLOCKED`, a persistent or session disable yields enablement `DISABLED` plus `CLIENT_ENABLEMENT_REQUIRED`, and an untrusted/disconnected native result with canonical structure yields activation `PENDING_TRUST`, not config failure. Malformed/path-escaped extension or enablement evidence yields enablement/policy `UNKNOWN` and cannot be treated as absent or enabled.

- [ ] **Step 3: Implement targeted apply and native verify**

Own only physical `command` and `args`. Use targeted JSONC owned-path edits while preserving unknown entry, working-directory, and environment fields; do not replace the whole `mcpServers.uemcp` object during an owned update. A preserved non-null working directory produces `CUSTOM_LAUNCH_REVIEW_REQUIRED`. Never use the characterized project-add behavior and never write the enablement file. Return structural config, enablement (`ENABLED`, `DISABLED`, `POLICY_BLOCKED`, or `UNKNOWN`), and activation (`CONNECTED`, `PENDING_TRUST`, or `UNKNOWN`) as separate fields based on file/policy/native evidence. A structured `gemini mcp enable uemcp` action may be emitted only for the default Gemini home and exact effective launch environment; otherwise the action command is `null` so it cannot target the wrong home.

- [ ] **Step 4: Run and commit**

```powershell
node test-client-config-formats.mjs
node test-client-adapters.mjs
node test-client-transaction.mjs
git add server/deployment/adapters/gemini.mjs server/fixtures/client-config server/test-client-adapters.mjs
git commit -m "Add the Gemini CLI deployment adapter"
```

---

### Task 8: Implement The VS Code Adapter

**Files:**
- Create: `server/deployment/adapters/vscode.mjs`
- Add: `server/fixtures/client-config/vscode-*`
- Modify: `server/test-client-adapters.mjs`

**Scopes and locations:**

- default user profile `%APPDATA%\Code\User\mcp.json`;
- one explicitly selected profile resolved read-only from `%APPDATA%\Code\User\globalStorage\storage.json` `userDataProfiles` metadata: use `%APPDATA%\Code\User\profiles\<validated location>\mcp.json`, or the default resource when `useDefaultFlags.mcp === true`;
- workspace `<workspace>\.vscode\mcp.json`;
- isolated tests use a dedicated `--user-data-dir`, seeded named-profile metadata, and the release-gated native CLI tuple.

Canonical entry is `servers.uemcp` with `type: "stdio"`, absolute `command`, and `args`. Preserve top-level `inputs`, server environment, sandbox policy, unknown fields, comments, other profiles, and unrelated servers. VS Code's global/workspace enable-disable state is stored separately from `mcp.json`; it remains host-owned and opaque unless a supported read-only host surface proves it.

- [ ] **Step 1: Add failing profile, preservation, and activation tests**

Cover default profile; explicit profile name-to-location mapping; `useDefaultFlags.mcp` inheritance; duplicate names/locations; missing, malformed, traversal, absolute, device, linked, and case-colliding locations; profile-count/metadata-byte overflow; unknown profile; workspace shadowing; exact/conflict; comments/trailing commas; inputs/sandbox/env preservation; unknown version; read-only profile; and structural success that still needs restart/trust/enablement review. Lock the installed `1.128.1` characterization that `--profile` can create a missing profile when opening the editor, while `--add-mcp --profile <existing>` writes the default `User\mcp.json` and same-name add replaces the full object. Assert the adapter never invokes either mutating path.

- [ ] **Step 2: Implement scope/profile inspection and planning**

Resolve only the default or one explicitly requested existing profile in this slice. Parse `User\globalStorage\storage.json` structurally, validate the `userDataProfiles` record and `location` as a single safe relative directory name beneath `User\profiles`, and honor `useDefaultFlags.mcp` without rewriting profile metadata. Reject ambiguous/unknown profiles and every containment escape; never invoke `Code.exe --profile` to discover or create one. Enumerate other profile `mcp.json` occurrences as shadowing evidence without modifying them, and report workspace same-name entries before user writes.

- [ ] **Step 3: Implement targeted apply and bounded verification**

Own only physical `type`, `command`, and `args`. Use JSONC range edits rather than same-name `--add-mcp`. Preserve `inputs`, all client-owned entry fields, and every server environment key; a preserved non-null working directory produces `CUSTOM_LAUNCH_REVIEW_REQUIRED`. Do not parse or mutate opaque VS Code storage databases to infer enablement. Since the release-gated headless CLI has no MCP status/enablement query and cannot prove an open window accepted trust, static verification returns config `CONFIGURED`, enablement `UNKNOWN`, activation `UNKNOWN`, and explicit `RESTART_REQUIRED` plus `CLIENT_ENABLEMENT_REVIEW_REQUIRED`; `ENABLED`, `DISABLED`, `PENDING_TRUST`, or `CONNECTED` require separate live/read-only host evidence and are never inferred from file presence.

- [ ] **Step 4: Run and commit**

```powershell
node test-client-config-formats.mjs
node test-client-adapters.mjs
node test-client-transaction.mjs
git add server/deployment/adapters/vscode.mjs server/fixtures/client-config server/test-client-adapters.mjs
git commit -m "Add the VS Code deployment adapter"
```

---

### Task 9: Integrate Discovery, Selection, Native Verification, And Installed Contracts

**Files:**
- Create: `server/deployment/client-discovery.mjs`
- Create: `server/deployment/client-domain.mjs`
- Create: `server/test-installed-client-contracts.mjs`
- Modify: `server/deployment/orchestrator.mjs`
- Modify: `server/deploy-uemcp.mjs`
- Modify: `server/test-deployment-bundle.mjs`
- Modify generated: `dist/deploy-uemcp.mjs`
- Modify generated: `dist/deploy-uemcp.manifest.json`
- Modify generated: `dist/THIRD_PARTY_NOTICES.txt`
- Modify: `server/test-client-transaction.mjs`
- Modify: `docs/specs/deployment-machine-interface.md`
- Create: `docs/specs/client-adapters.md`

**Interfaces:**

```js
export async function discoverClients({ env, workspaceRoot, requestedProfile, resolvers });
// -> one row per CLIENT_IDS member, including NOT_INSTALLED
export function selectClients(discovered, { include = [], exclude = [] });
// detected release-gated rows default selected; excluded rows remain NOT_SELECTED
export function createClientDomain({ adapters, transaction, discovery });
// domain.name === 'clients'; domain.order === 30
```

- [ ] **Step 1: Add failing aggregate-selection and result tests**

Cover all installed, one installed, none installed, unknown client only, exact include, exact exclude, unknown include name, duplicate executable, unsupported version, one adapter policy block, persistent/session disabled clients, opaque enablement state, harmless custom environment, case variants of every sensitive key/prefix, and custom working directory. Add aggregate cases where native `list/get` reports the entry but protocol initialize fails or times out, and where protocol smoke succeeds but the host still reports pending trust/restart/enablement review. Assert every `CLIENT_IDS` row remains visible, every detected gated client defaults selected, excluded rows are `NOT_SELECTED`, compatibility/write-support pairs are exact, unsupported versions remain structurally inspectable but cannot write, no supported client produces generic `MANUAL_REGISTRATION_REQUIRED`, custom values never enter output, sensitive keys produce `CUSTOM_ENV_REVIEW_REQUIRED`, custom cwd produces `CUSTOM_LAUNCH_REVIEW_REQUIRED`, structural/native/protocol/enablement/activation facts remain separate, and no list command or config file alone yields `HEALTHY`.

- [ ] **Step 2: Implement the client orchestrator domain**

Discovery and inspection run entirely before confirmation. `plan` emits per-client current/effective scope, operation, touched paths, owned diffs, custom environment key names/value hashes, enablement/trust/restart/review action, and selection. `apply` passes only selected planned operations to the central transaction. `verify` launches protocol smoke with the exact effective environment in memory but never serializes its values, then combines structural, native-client, enablement, protocol, and activation levels without promoting one to another.

- [ ] **Step 3: Extend CLI selection without hidden defaults**

Add repeatable `--include-client <id>`, `--exclude-client <id>`, and `--vscode-profile <name>` to `plan`, `verify`, `doctor`, and `repair`. Reject overlap and unknown IDs. Apply still consumes only the saved plan and cannot change selection flags.

- [ ] **Step 4: Add opt-in installed-client contract tests**

Gate with `UEMCP_INSTALLED_CLIENT_CONTRACT=1`. Before each case, hash every real default config path; after the suite, require unchanged hashes. Isolate clients with:

```text
Claude: CLAUDE_CONFIG_DIR=<scratch>\claude
Codex:  CODEX_HOME=<scratch>\codex
Gemini: GEMINI_CLI_HOME=<scratch>\gemini-home (effective config root <scratch>\gemini-home\.gemini)
VS Code: adapter user-data root <scratch>\vscode-data with seeded User\globalStorage\storage.json profile metadata
```

For each exact release-gated installed version, seed an unrelated server and client-owned fields, run plan/apply with exact digest, verify native status where one exists, rerun for no-op, and remove only the isolated home. Claude user registration must reach connected where the CLI permits; project scope must remain pending approval. Codex must preserve unrelated and same-table policy. Gemini must prove the effective override path, extension-only versus user-same-name precedence, and persistent/session disable separately from pending trust. VS Code must version-probe only through `Code.exe + cli.js + env_overlay`, seed an existing named profile without launching the GUI, prove targeted profile-resource preservation, characterize `--add-mcp --profile` only inside the isolated root, and leave activation/enablement unproven. Hash real default config, profile metadata, extension state, and enablement paths before and after the suite.

If the installed version differs, report a clean version-gate skip for that adapter and fail any attempt to write; do not silently widen the release range.

- [ ] **Step 5: Document support and proof boundaries**

Document exact versions, config scopes/precedence, owned fields, native commands, enablement/trust/restart behavior, Codex shared host config versus unproven desktop activation, generic descriptor/manual support, explicit non-support for deferred clients, and the procedure for widening a version gate.

- [ ] **Step 6: Run focused, installed, and full gates**

```powershell
npm run build:deployment
node test-deployment-bundle.mjs
node test-client-config-formats.mjs
node test-client-transaction.mjs
node test-client-adapters.mjs
$env:UEMCP_INSTALLED_CLIENT_CONTRACT='1'; node test-installed-client-contracts.mjs
Remove-Item Env:UEMCP_INSTALLED_CLIENT_CONTRACT
node test-deployment-plan.mjs
node test-protocol-smoke.mjs
node run-rotation.mjs --json
```

Expected: fixture/default rotation passes; installed cases either pass at the exact gated version or report explicit inspect-only version skips. Real config hash guards pass.

- [ ] **Step 7: Commit and request review**

```powershell
git add server/deployment server/deploy-uemcp.mjs server/fixtures/client-config server/test-client-config-formats.mjs server/test-client-transaction.mjs server/test-client-adapters.mjs server/test-installed-client-contracts.mjs server/test-deployment-bundle.mjs server/package.json server/package-lock.json dist docs/specs/deployment-machine-interface.md docs/specs/client-adapters.md
git commit -m "Add transactional multi-client UEMCP installation"
git diff --check origin/main...HEAD
```

The PR must report exact installed versions, isolated home roots, fixture/installed/default totals, parser dependency versions, real-config hash proof, and any adapter held inspect-only. Merge before starting plugin deployment/build proof.
