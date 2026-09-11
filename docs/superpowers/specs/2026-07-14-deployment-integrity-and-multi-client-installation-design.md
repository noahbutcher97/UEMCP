# Deployment Integrity and Multi-Client Installation Design

## Status

Approved on 2026-07-14 after source, web, API, isolated client-CLI research, two specification hardening passes, and explicit user review. This remains the behavioral authority for implementation; production work starts only from the separately reviewed implementation-plan suite.

## Problem

UEMCP has several individually useful deployment commands, but no single authority defines or proves an installed system end to end.

The current setup path can report success while one or more of these conditions remain true:

- Node is present but older than the server's `>=22` requirement.
- `server/node_modules` exists but does not match `package-lock.json` or is incomplete.
- Setup copied a plugin through a different path than `sync-plugin.bat`, so setup and later sync do not necessarily enforce the same exclusions, editor-lock checks, cleanup rules, or provenance marker.
- A deploy marker or modification time appears current while deployed files differ from source.
- Plugin source was copied but the target project has not rebuilt the module.
- A client configuration was written but is shadowed by a higher-precedence entry.
- A client configuration was registered but the current client session needs restart or workspace trust.
- `.mcp.json` was generated for Claude while Codex, Gemini CLI, VS Code, or another MCP host remained unconfigured.
- An external installer assumed UEMCP setup wrote the expected client configuration without verifying its effective state.

`setup-uemcp.bat` currently overwrites a workspace `.mcp.json` from a Claude-shaped template. That behavior is not a portable MCP installation contract. MCP standardizes protocol messages and transports, not host configuration files, scopes, trust stores, precedence, or restart behavior.

Client round trips performed in isolated homes on 2026-07-14 confirmed materially different behavior:

| Client | Version tested | Observed behavior |
| --- | --- | --- |
| Codex | `0.144.4` | `codex mcp add` preserved unrelated servers, but a same-name add silently replaced the UEMCP table and removed approval, required, enabled, timeout, and per-tool fields. `mcp get --json` did not report all of those fields. |
| Claude Code | `2.1.209`, `2.1.210` | User-scoped `mcp add-json` connected/registered in isolated config. Project scope remained pending approval. On `2.1.210`, `CLAUDE_CONFIG_DIR` isolated `.claude.json`, a same-name add returned exit `1`, and the existing file hash remained unchanged; `add-json` stayed deterministic. The CLI's variadic `--env` parsing differs from the apparent documented ordering, so the adapter uses `add-json` only for a fresh entry. |
| Gemini CLI | `0.41.2` | A user-scoped entry was visible but disconnected in an untrusted folder. Sequential project-scoped adds in an isolated Git workspace left only the later `mcpServers` entry. Installed source also confirmed separate persistent/session enablement, with persistent state under the effective global `.gemini` directory. |
| VS Code | `1.128.1` | `--add-mcp` preserved unrelated servers, but a same-name add replaced the full server object and discarded custom environment and sandbox fields. Direct `Code.exe` is the GUI; the CLI requires the versioned `cli.js` plus Electron's Node-mode environment. A named-profile add still wrote default `User\mcp.json`, so targeted profile-resource edits cannot delegate to that command. First use and enable/disable state remain separate host decisions. |

These results rule out both one shared config file and blind repeated use of client `add` commands.

## Goals

- Define one authoritative install state machine shared by setup, sync, verification, doctor, and central-installer entry points.
- Configure every detected, supported MCP client through one consolidated orchestrator confirmation, with any pre-orchestrator runtime bootstrap and external trust/authority prompts called out separately.
- Release-gate adapters for Claude Code, Codex, Gemini CLI, and VS Code using installed-client evidence on Windows.
- Remain protocol-compatible with standards-conforming MCP clients that do not yet have an automatic adapter.
- Use one provider-neutral UEMCP launch descriptor and preserve dynamic project attachment.
- Preserve unrelated client configuration and client-owned fields exactly.
- Detect effective scope, precedence, and shadowing instead of checking only whether some file contains an entry named `uemcp`.
- Make repeated setup idempotent: an unchanged healthy installation performs no writes.
- Make client configuration transactional, recover exact prior bytes after a failed multi-client apply when UEMCP still owns the last write, and never overwrite a concurrent external edit during rollback.
- Replace modification-time and marker-only deployment claims with content-based provenance.
- Distinguish source availability, dependency readiness, plugin copy, plugin build, client registration, client enablement, trust/restart state, MCP protocol health, client activation, and editor connectivity.
- Emit machine-readable results and non-secret receipts for automation and diagnosis.
- Improve UEMCP discoverability and approval behavior in different clients through provider-neutral instructions, bounded descriptions, and standard MCP annotations.

## Non-Goals

- Claiming automatic support for every proprietary AI product, model provider, or future MCP host. Installation support is gated by host/configuration surface, not by the model selected inside that host.
- Auto-configuring Cursor, Windsurf, Claude Desktop, or additional VS Code profiles before each adapter satisfies the evidence gate in this specification. ChatGPT desktop may consume the shared Codex host configuration documented by OpenAI, but its UI activation is not separately release-gated in this slice.
- Bypassing workspace trust, granting blanket tool approval, setting Gemini `trust: true`, approving Claude project MCP, or enabling a client-disabled server automatically.
- Writing shared project-scoped client configuration by default.
- Hosting UEMCP as a persistent Streamable HTTP service or local broker.
- Packaging UEMCP into client marketplaces or provider-specific plugin stores.
- Replacing MCP client approval systems with UEMCP policy.
- Adding pagination or output schemas to every existing UEMCP tool. Large-result ergonomics are a follow-on.
- Building every Unreal target automatically on every sync. The design requires a truthful build state and an explicit build gate, not unconditional compilation.
- Implementing the planned generic headless MCP execution layer.

## Terminology

- **MCP client or host:** The process that launches UEMCP and exposes its tools to an agent, such as Claude Code, Codex, Gemini CLI, or VS Code.
- **Model provider:** The service or model used by an agent host. It is not necessarily the owner or format of that host's MCP configuration. UEMCP installs against host surfaces and remains model-neutral at protocol level.
- **Provider-neutral:** Behavior based on MCP capabilities and project roots, not a client brand or model provider.
- **Canonical launch descriptor:** The normalized command, arguments, environment, and working-directory policy used by every client adapter.
- **Adapter:** Client-specific code that detects installations and scopes, inspects effective state, plans changes, applies or rolls them back, and verifies native status.
- **Registration:** A client has a syntactically valid UEMCP entry.
- **Activation:** The client can load that entry in its current trust, scope, and session state.
- **Protocol health:** The configured command completes MCP initialization and returns a valid initial `tools/list` result.
- **Editor health:** UEMCP can reach and identify the intended Unreal Editor/plugin instance. This is separate from protocol health.
- **Owned fields:** Configuration fields created and tracked by the installer. Unknown or user-added fields remain client-owned.
- **Shadowed entry:** A valid UEMCP definition that is not effective because another scope or managed policy has higher precedence.

## Design Decision

Create one Node-based deployment orchestrator owned by UEMCP. It exposes plan, apply, verify, repair, and machine-readable result modes. Existing `.bat` files remain convenient Windows launchers, but they must delegate policy and state classification to shared Node modules instead of reimplementing it.

Because a Node program cannot repair a missing Node runtime before it starts, launchers retain one deliberately narrow bootstrap responsibility: locate a compatible runtime or perform an explicitly confirmed, allowlisted Node installation, then invoke the orchestrator through that runtime. The bootstrap may not mutate project, plugin, dependency, or client state. When installation is required, its preliminary runtime-only confirmation is an explicit exception to the one-confirmation orchestrator flow; the launcher must not imply that still-unknown later changes were approved. The eventual result records that bootstrap occurred, and the orchestrator independently revalidates the runtime before using it as the canonical server executable. AI-Tools may supply its own compatible runtime to launch planning, but that runtime becomes the UEMCP server executable only if it also satisfies the canonical descriptor checks.

The orchestrator has four independent but composable domains:

1. Prerequisite and server dependency readiness.
2. Unreal project registration and plugin deployment.
3. MCP client discovery and transactional registration.
4. Verification, receipts, and repair guidance.

The AI-Tools MCP-Suite installer invokes the UEMCP orchestrator's machine interface and consumes its result. It must not infer success from process exit alone or assume `.mcp.json` was written.

## Canonical Launch Descriptor

Normal installation produces this semantic descriptor:

```json
{
  "name": "uemcp",
  "transport": "stdio",
  "command": "<absolute path to node.exe>",
  "args": ["<absolute path to server/server.mjs>"],
  "env": {},
  "cwd": null
}
```

Requirements:

- Resolve and record the actual `node.exe`; do not assume GUI clients inherit the same `PATH` as a terminal.
- Require Node `>=22` using semantic version parsing.
- Keep `server.mjs` absolute because client config is machine-local by default.
- Omit `cwd` so workspace-aware clients can launch from their active workspace.
- Do not write `UNREAL_PROJECT_ROOT`, `UNREAL_PROJECT_NAME`, or `UEMCP_PROJECT_ATTACH_MODE` in normal mode.
- Preserve explicit env-authoritative compatibility mode as an opt-in target-specific configuration, never as the multi-project default.
- Do not enable Python execution or other security-sensitive flags during general installation.

This descriptor lets UEMCP use MCP `roots/list` where supported and its existing inherited-working-directory fallback otherwise. An ambiguous or non-Unreal workspace must remain management-only until `attach_project` resolves it.

## Prerequisite and Dependency Contract

Setup performs evidence-based checks in this order:

1. Resolve `node.exe` and parse its version.
2. Reject Node below `22`; a successful `node --version` is insufficient.
3. Offer an explicit, confirmed prerequisite installation action when supported. Re-probe after installation before continuing.
4. Compare the current dependency stamp with `package-lock.json` content and Node major version.
5. Validate installed dependencies with the package manager rather than treating the existence of `node_modules` as health.
6. Use the repository lockfile for deterministic installation. Record the lockfile hash and package-manager result.

The dependency stamp is local and ignored. It may permit a fast no-op only when the lock hash, Node major, package manager, and validation result all match. A stale stamp cannot override a failed dependency check.

## Project Registration Contract

Project target registration remains independent from client configuration:

- Validate and canonicalize the `.uproject` path.
- Register the target in `.uemcp-targets.json` through the existing structured target API.
- Preserve aliases and profiles; do not rewrite unrelated targets.
- Treat legacy `.uemcp-targets.txt` as migration input, not the preferred write format.
- Do not infer client workspace scope from the `.uproject` parent solely to decide where a provider config file should be written.

Setup of one Unreal project can therefore update plugin deployment and target profiles without creating duplicate client registrations.

## Plugin Deployment Contract

Setup and `sync-plugin.bat` must call the same deployment implementation.

The shared operation must:

- Validate source and target roots before any delete, move, or replacement.
- Check the target project's editor lock by canonical full `.uproject` path.
- Refuse a normal sync while the matching editor is open.
- Stage the canonical managed plugin payload under a verified sibling temporary directory.
- Apply one shared classification policy that distinguishes managed source files from generated build artifacts, repository-local files, and transient files.
- Verify the staged managed-file manifest and SHA-256 hashes before replacing the destination.
- Replace the destination only after staging succeeds.
- Restore the prior destination if replacement fails.
- Fingerprint source and destination before staging, then recheck the source, destination, and matching-editor lock immediately before replacement. Any drift aborts replacement and requires a new plan.
- Keep the prior destination as a sibling rollback candidate until post-replacement verification succeeds; temporary and backup paths must remain on the same volume as the destination.
- Remove stale managed destination files as part of replacement; a copy-over operation that can leave deleted source files behind is not valid deployment.
- Carry generated artifacts into the staged destination only when their build evidence proves compatibility with the exact staged managed payload and target build identity. Otherwise omit them and report `BUILD_REQUIRED` or `UNKNOWN`.
- Treat `Binaries` and `Intermediate` independently. Runtime binaries require verified artifact hashes; incremental intermediates may be retained only under an explicit compatible-engine/toolchain policy and are never deployment evidence.
- Configure required built-in Unreal plugins through structured `.uproject` JSON editing without disturbing unrelated entries.
- Write a deployment receipt only after the destination manifest matches the canonical source manifest.

The deploy receipt records at least:

- canonical source repository and plugin paths;
- source Git commit and dirty-source indicator;
- canonical target `.uproject` and plugin paths;
- plugin descriptor version;
- source manifest hash and deployed manifest hash;
- build-relevant source hash;
- generated-artifact manifest hash when compatible artifacts were retained or produced;
- dependency and Node fingerprints;
- sync timestamp and orchestrator version.

A receipt is evidence, not authority. Verification recomputes current hashes and does not trust receipt claims without comparison.

The canonical deployment manifest covers only the managed payload. Generated artifacts have a separate manifest and lifecycle so a current binary cannot hide stale source, and current source cannot imply a current binary.

Plugin states are distinct:

| State | Meaning |
| --- | --- |
| `NOT_DEPLOYED` | Target plugin is absent. |
| `DEPLOYED_STALE` | Destination content differs from canonical source. |
| `DEPLOYED_SOURCE_CURRENT` | Content matches, but build state is unknown or stale. |
| `DEPLOYED_BUILD_REQUIRED` | Build-relevant content changed after the last proven build. |
| `DEPLOYED_BUILD_CURRENT` | Content and build evidence match. |
| `EDITOR_RESTART_REQUIRED` | A newly built or changed plugin is not proven loaded in the current editor process. |

Copy success alone must never be reported as full deployment health.

### Build Evidence Contract

`DEPLOYED_BUILD_CURRENT` requires immutable evidence that binds all of the following:

- the exact build-relevant managed-payload hash;
- Unreal Engine identity, platform, target, configuration, and toolchain identity;
- the completed build invocation and successful exit result;
- hashes of the expected produced plugin binaries;
- the build-evidence schema and producer version.

Modification times, the existence of `Binaries`, or a mutable marker by itself cannot establish this state. A build performed outside the orchestrated or integrated evidence-producing path is `UNKNOWN` until the same facts can be independently reconstructed; setup must not guess that an IDE build is current.

Live-editor verification is a separate claim. The plugin build must expose an immutable build identity compiled into the loaded module, and the editor handshake must return it. The verifier compares that loaded identity with the expected on-disk build evidence. Reading a writable disk receipt from inside the editor does not prove which binary is loaded.

## Client Adapter Contract

Each adapter implements the same behavioral interface:

```text
detect()       -> installed client/version/config locations
inspect()      -> all relevant UEMCP entries, effective entry, shadowing, policy blocks
plan(desired)  -> no-op/create/adopt/migrate/conflict/action-required operations
snapshot(plan) -> exact pre-change bytes and metadata for every touched file
apply(plan)    -> bounded client-specific writes without shell interpolation
verify()       -> structural state plus native client status where available
rollback()     -> exact pre-change restoration
```

Adapter implementations may use an official client CLI only when the tested operation preserves required state. A CLI command is not intrinsically safer than structured editing.

Every adapter must:

- use argument arrays with `shell: false` for process execution;
- apply explicit timeouts and output bounds to every child process, terminate its process tree on timeout, and report timeout separately from negative status;
- version-probe before selecting behavior;
- inspect every documented scope that can override the intended entry;
- report managed-policy blocks explicitly;
- preserve unrelated servers and unknown fields;
- distinguish an exact match from a same-name conflict;
- avoid persisting raw secrets in plans, logs, or receipts;
- avoid marking trust or approval complete unless the client reports it;
- return stable machine-readable status and remediation.

Installer ownership is stored in a machine-local ownership ledger rather than injected into provider configuration. A ledger record is keyed by client, canonical config path, scope, and entry name, and records the owned field set plus hashes of the last values written. The ledger is evidence, not authority: current config is always re-read. With no valid ledger record, an entry is unowned. An exact canonical entry may be adopted without rewriting provider config only when adoption is visible in the approved plan; a differing entry cannot be adopted by name or path alone.

## Supported Client Matrix

The initial release-gated adapters are:

| Adapter | Default target | Apply policy | Native verification |
| --- | --- | --- | --- |
| Claude Code | User scope | Use deterministic parser-backed JSON registration; inspect local, project, user, plugin, and managed shadowing; migrate older project/local UEMCP entries only when included in the approved plan. Inspect user/project/local/managed settings approval and disable keys read-only, with workspace trust semantics. | `claude mcp get/list`; classify connected, pending approval, user-disabled/rejected, policy-blocked, or policy-unknown. Never write approval or enablement settings. |
| Codex host | User `config.toml` shared by Codex CLI, the IDE extension, and ChatGPT desktop | Use Codex CLI only for a fresh entry. Parse existing TOML before any same-name action; never repeat `mcp add` over an existing entry. Preserve approval modes, tool overrides, timeouts, required/enabled state, comments, and unrelated tables. Explicit `enabled = false` remains client-owned disablement. Inspect trusted root-to-leaf project layers and read-only system/effective policy separately. | `codex mcp get/list --json` plus config inspection; report disabled and restart separately because list/get is structural, not a connection proof. `%ProgramData%\OpenAI\Codex\requirements.toml` is fixed Windows policy evidence; cloud policy remains host-owned. CLI behavior is release-gated; IDE and desktop activation remain separately unproven. |
| Gemini CLI | User settings under the effective global `.gemini` directory | Use a JSONC-aware targeted merge rather than relying on the tested destructive project-add behavior. Keep `trust` absent/false; inspect project/system shadowing, enabled extension-provided MCP declarations, and policy; read but never rewrite extension or server enablement state. | `gemini mcp list`; persistent/session disable is `DISABLED`, while an untrusted workspace is `PENDING_TRUST`. Neither is healthy or config failure. |
| VS Code | Default or one explicitly selected existing user-profile `mcpResource` | Resolve named profiles from `User/globalStorage/storage.json`, honor `useDefaultFlags.mcp`, and use a JSONC-aware targeted merge. Never use same-name `--add-mcp` or launch `--profile` for discovery. Preserve inputs, sandbox policy, environment, comments, other profiles, and unrelated servers. | Structural verification is separate from restart, trust, and host-owned global/workspace enablement. No headless claim of in-window activation or enabled state. |

Client-specific adapter tests are release gates only for versions or version ranges actually covered. Each client row reports compatibility/write support separately from structural config, enablement, and activation. An unknown newer version may use read-only inspection but must not perform a destructive update unless the adapter's compatibility rule explicitly allows it.

## Generic Client Support

The orchestrator can emit a validated generic stdio descriptor for clients without an adapter. It includes the canonical command, arguments, environment, protocol-smoke result, and manual registration guidance.

Generic support means:

- the UEMCP server follows the negotiated MCP protocol;
- the descriptor is sufficient for a standards-compatible stdio host;
- UEMCP does not branch on a recognized client brand;
- capability absence has a defined fallback.

It does not mean UEMCP knows where an arbitrary product stores configuration or can bypass that product's trust workflow. Unknown clients receive `MANUAL_REGISTRATION_REQUIRED`, not a false automatic-install success.

## Scope, Precedence, and Migration

Private user scope is the default because the canonical descriptor is machine-specific and UEMCP is intended to serve multiple Unreal workspaces.

Project-scoped configuration remains explicit opt-in for teams that want a shared file and can supply portable path variables. Setup must not place absolute machine paths into a version-controlled project config by default.

Before adding a user entry, an adapter computes the effective definition across all relevant scopes. Outcomes include:

- `ABSENT`: no definition exists;
- `MATCHING_EFFECTIVE`: the effective definition matches;
- `MATCHING_SHADOWED`: a matching entry exists but another scope wins;
- `CONFLICT_EFFECTIVE`: the active same-name definition differs;
- `POLICY_BLOCKED`: managed policy prevents use or modification;
- `MALFORMED_CONFIG`: a relevant config cannot be parsed safely.

Existing Claude `.mcp.json` entries created by the old setup path are migration candidates. The approved plan may remove only `mcpServers.uemcp`, preserve every other entry, and add the canonical user entry. Empty project files are removed only if they were installer-created and contain no other data; otherwise they remain valid empty/other-client config files.

Equivalent same-name project or workspace entries for Codex, Gemini, and VS Code must be reported as potential shadowing. Migration is never inferred from name alone.

## Ownership and Conflict Rules

For each effective entry:

1. If absent, create the canonical entry and record owned fields.
2. If the canonical owned fields match, perform no write and preserve all client-owned fields.
3. If an existing unowned entry differs, classify it as a conflict and show the exact non-secret field diff.
4. If an installer-owned entry changed only in client-owned fields, update owned fields while preserving the client changes.
5. If an installer-owned field changed outside the installer, classify it as user-modified and require explicit replacement approval.

The consolidated confirmation can include an explicit conflict resolution. `--yes` approves only operations already present in the printed or machine-readable plan; it must not turn unknown conflicts into replacement permission. This is one installer confirmation for installer-managed changes. It does not suppress a client-owned workspace-trust prompt, OS elevation dialog, or other authority that UEMCP does not control.

## Consolidated Plan and Transaction

Interactive setup performs all discovery before asking for confirmation. The plan shows:

- project and plugin operations;
- prerequisite or dependency operations;
- every detected client and version;
- target scope and effective current scope;
- create, adopt, migrate, no-op, conflict, restart, and trust actions;
- files that will be touched;
- whether plugin build or editor restart remains required.

Every detected release-gated client is selected by default. Explicit include or exclude controls are allowed for scoped automation, but the plan must list every detected client and mark excluded clients `NOT_SELECTED`; a detected client cannot disappear from the result because an adapter was omitted implicitly.

The machine-readable plan contains a canonical SHA-256 plan digest over its schema version, requested operations, owned-field diffs, client selection, and all precondition fingerprints. It also has a bounded `expires_at` value. Apply requires that digest, rejects any changed or expired precondition, and never expands the reviewed operation set. Replanning is required after a rejection.

Client configuration is one transaction:

1. Fingerprint every relevant file during planning.
2. Recheck fingerprints immediately before apply to prevent time-of-check/time-of-use overwrites.
3. Capture exact bytes and metadata for all files that may change.
4. Write through a same-directory temporary file and use the strongest atomic replacement primitive available while preserving required file metadata.
5. Apply adapters in deterministic order.
6. Structurally re-read each result after writing and record the exact applied hash.
7. If any required adapter apply fails, restore every client config changed by the transaction whose current hash still equals the applied hash.
8. If a file changed again after UEMCP wrote it, do not overwrite the concurrent edit. Report `ROLLBACK_CONFLICT`, retain the restricted prior snapshot for explicit recovery, and identify the affected path without exposing contents.
9. Verify every restoration before reporting rollback success.

On Windows, replacement of an existing regular file uses `ReplaceFileW` semantics (directly or through `.NET File.Replace`) without ignore-merge/ignore-ACL flags. DACLs, encryption/compression state, creation metadata, and existing named streams must survive a successful content update; metadata merge failure aborts the operation and cannot fall back to rename-overwrite. A newly created file uses an exclusive same-directory create/rename path because there is no prior metadata to merge.

Apply is serialized by a user-local cross-process lease acquired before final precondition validation and held through verification, receipt/replay bookkeeping, rollback, and cleanup. A live or uninspectable owner is never evicted on age alone; dead-owner recovery requires an owner-token/PID/process-start check and a bounded grace period. This serializes cooperating UEMCP installers while the existing fingerprint/recheck rules still defend against non-cooperating external editors.

Snapshots remain outside the repository, use user-restricted local storage where supported, and are deleted after successful apply or verified rollback. A snapshot involved in `ROLLBACK_CONFLICT` is retained for a bounded documented recovery period and deleted by repair or expiry. Receipts retain hashes and status, not snapshot contents.

Plugin deployment and client registration are separate transactions. A client failure does not silently undo a valid plugin deployment, but the overall setup result is partial and says exactly which domain remains incomplete.

## Install State Model

The orchestrator reports stage results rather than one ambiguous success flag:

| Stage | Representative statuses |
| --- | --- |
| Prerequisite | `READY`, `NODE_MISSING`, `NODE_UNSUPPORTED` |
| Dependencies | `READY`, `LOCK_DRIFT`, `DEPENDENCY_POLICY_BLOCKED`, `INSTALL_FAILED` |
| Target | `REGISTERED`, `ALREADY_REGISTERED`, `INVALID_TARGET` |
| Plugin source | `CURRENT`, `STALE`, `NOT_DEPLOYED`, `SYNC_FAILED` |
| Plugin build | `CURRENT`, `BUILD_REQUIRED`, `BUILD_FAILED`, `UNKNOWN` |
| Client compatibility/write support | `release_gated`, `known_unsupported`, `unknown_newer`, `not_installed`, plus an explicit write-support boolean |
| Client registration | `ABSENT`, `CONFIGURED`, `ALREADY_CONFIGURED`, `SHADOWED`, `CONFLICT`, `INSPECTION_LIMIT_EXCEEDED`, `ROLLED_BACK`, `ROLLBACK_CONFLICT`, `NOT_SELECTED`, `NOT_INSTALLED`, `MANUAL_REGISTRATION_REQUIRED`, `UNKNOWN` |
| Client enablement | `ENABLED`, `DISABLED`, `POLICY_BLOCKED`, `POLICY_UNKNOWN`, `NOT_SELECTED`, `NOT_INSTALLED`, `UNKNOWN` |
| Client activation | `CONNECTED`, `PENDING_TRUST`, `RESTART_REQUIRED`, `NOT_SELECTED`, `NOT_INSTALLED`, `UNKNOWN` |
| MCP protocol | `HEALTHY`, `INITIALIZE_FAILED`, `TOOLS_LIST_FAILED` |
| Editor | `VERIFIED`, `EDITOR_CLOSED`, `PLUGIN_NOT_LOADED`, `PROJECT_MISMATCH`, `NOT_CHECKED` |

Overall outcomes are:

- `HEALTHY`: all requested mandatory stages are proven ready.
- `ACTION_REQUIRED`: changes succeeded, but a human enablement, trust, build, restart, or explicit conflict decision remains.
- `PARTIAL`: independent stages succeeded and failed; no stage is hidden.
- `FAILED`: the requested operation made no useful progress or a required transaction was rolled back.

CLI exit codes must distinguish these outcomes. Only `HEALTHY` exits zero. Stable numeric assignments belong in the implementation plan and must preserve compatibility where existing automation depends on current codes.

## Verification and Doctor Contract

Verification has four evidence levels:

1. **Structural:** Config parses, effective entry is canonical, files exist, Node version is supported, dependency and plugin hashes match.
2. **Native client:** The client's own list/get/status command recognizes the entry and reports its current activation state.
3. **Protocol:** Launch the exact effective descriptor, complete MCP initialization, validate `serverInfo`, inspect instructions, and call initial `tools/list`.
4. **Editor:** Use UEMCP's normal connection path to verify the intended project/plugin identity when the editor is open.

No lower level implies a higher one. In particular:

- a valid file is not proof the client loaded it;
- a generic protocol smoke is not proof a client trusted it;
- an MCP handshake is not proof the Unreal plugin is built or loaded;
- a listening editor port is not proof of project identity.

`verify-deploy`, the central doctor, and setup's final summary must use the same classifiers. Repair commands use the same planner and cannot bypass confirmation or conflict rules.

The old `--regenerate-mcp-json` action is replaced by client-aware inspect/repair behavior. A compatibility alias may emit a deprecation message, but it must not resume provider-specific overwrite behavior.

## Server Discoverability and Approval Metadata

Client installation alone is insufficient if agents cannot discover or safely approve tools.

The server metadata pass in this slice must:

- Rewrite server instructions in provider-neutral language.
- Put the task category, when to use UEMCP, `connection_info`, and `find_tools(query)` workflow within the first 512 UTF-8 bytes.
- Keep total server instructions below 2 KiB.
- Replace runtime tips that name Claude-only `Read`, `Grep`, or `Glob` tools with references to the client's native filesystem and search tools.
- Enforce a conservative tool-description budget below the documented 2 KiB Claude truncation boundary. Use 1,800 UTF-8 bytes as the repository gate.
- Shorten `read_asset_properties` while preserving detailed parser coverage in durable documentation and structured result fields.
- Emit standard MCP `ToolAnnotations` through the SDK's supported registration API.

Annotation mapping derives from the existing requirement classifier rather than duplicating mutation truth in another registry:

| Requirement | `readOnlyHint` | `destructiveHint` |
| --- | --- | --- |
| Offline/live/RC read | `true` | omitted |
| Live/RC mutation and Python execution | `false` | `true` conservatively |
| Pure management inspection | `true` | omitted |
| Management session-state change | `false` | `false` |

`idempotentHint` and `openWorldHint` remain omitted unless each tool has evidence supporting the claim. Annotations are discovery and approval hints, not enforcement; existing runtime guards remain authoritative.

The provider conformance fixture initializes the same server with Claude, Codex, Gemini, VS Code, and unknown `clientInfo` identities. Observable behavior may vary by negotiated capability, but not by brand name.

## Security Requirements

- Do not set blanket trust, automatic write approval, `alwaysLoad`, or equivalent bypass flags.
- Preserve Codex approval and per-tool policy fields.
- Treat tool annotations as hints and keep deterministic mutation guards.
- Never pass generated command lines through a shell.
- Validate executable and config paths against the intended client home/profile before writing.
- Refuse malformed TOML, JSON, or JSONC without rewriting it.
- Preserve comments and unknown fields in formats that support them.
- Redact environment values and secrets from diffs, logs, plans, and receipts.
- Do not retain secret-bearing whole-config backups after a successful transaction.
- Do not follow an unexpected symlink or junction from a planned config path without resolving and revalidating its destination.
- Do not let downloaded bridge manifests request arbitrary validation commands.
- Keep client and prerequisite executable allowlists explicit and version-probed. PATH results and Windows App Execution Aliases are discovery clues, not executable authority. Implicit native candidates whose tested distribution is Authenticode-signed must retain valid expected-signer evidence. An automatic `winget` bootstrap resolves the signed `Microsoft.DesktopAppInstaller` package payload and launches its real regular-file executable.

## AI-Tools Integration

The MCP-Suite installer remains the broader bridge selector, but UEMCP-specific deployment truth stays in UEMCP.

For UEMCP, AI-Tools must:

- invoke the machine-readable UEMCP plan/apply interface;
- include the UEMCP plan in its aggregate preview and record the returned plan digest;
- collect one confirmation for that exact aggregate preview, then invoke non-interactive UEMCP apply with the approved digest rather than nesting a second ambiguous prompt;
- replan and return to confirmation if UEMCP rejects stale fingerprints or a digest mismatch;
- consume per-stage results and receipts;
- stop claiming that an external setup necessarily wrote `.mcp.json`;
- surface `ACTION_REQUIRED`, `PARTIAL`, and `FAILED` without converting them to success;
- use UEMCP's doctor result for UEMCP rather than a separate weaker classifier;
- add only the exact adapter executables required to its validation allowlist;
- keep argument-array and `shell: false` execution;
- avoid installing a Claude-only SessionStart update hook as the general multi-client update mechanism.

Provider-specific update hooks, if retained, become explicit optional adapters and must be valid for the host platform. The current POSIX redirection/`grep` command is not a Windows-generic update contract.

## Machine-Readable Results and Receipts

Plan, apply, verify, and doctor support JSON output with a versioned schema.

Each result includes:

- operation and schema version;
- timestamp and UEMCP source identity;
- requested project/profile;
- canonical launch descriptor with environment values redacted;
- per-stage and per-client status;
- config scope and path labels;
- before/after hashes for touched files;
- plugin source/deploy manifest hashes;
- protocol and editor verification levels reached;
- rollback state;
- for apply, the consumed plan digest, expiry, and precondition result; standalone verify/doctor use an explicit null plan association rather than inventing one;
- stable action codes and human-readable next steps.

Machine action commands, when present, are structured as an absolute executable plus argument array. They are display/remediation data, not shell strings or implicit authority to execute.

Receipts are machine-local and ignored by source control. They must not include authentication tokens, entire config files, or unrelated client settings.

## Testing Strategy

### Pure Unit and Fixture Tests

- Node version semantic parsing, including Node 20 rejection.
- Dependency stamp invalidation for lockfile, Node major, package-manager, and failed validation changes.
- Canonical descriptor generation with paths containing spaces and non-ASCII characters.
- Client detection with missing, duplicated, shimmed, and unsupported-version executables.
- Bootstrap behavior with Node missing, unsupported, newly installed, or supplied by AI-Tools; bootstrap tests must prove no non-runtime state changes occur before orchestration.
- Claude local/project/user/plugin/managed precedence, settings-based approval/disable state with workspace-trust rules, pending approval, exact match, migration, and unrelated-server preservation.
- Codex TOML preservation for comments, unrelated tables, enabled/required flags, disabled classification, timeouts, default approval mode, and per-tool overrides.
- Gemini JSONC preservation, effective `GEMINI_CLI_HOME\.gemini` resolution, project/system/extension shadowing, policy/trust classification, and read-only extension plus persistent/session enablement classification.
- VS Code native `Code.exe + cli.js` launch resolution, JSONC preservation for `inputs`, sandbox policy, profile data, comments, and unrelated servers, profile `mcpResource`/inheritance resolution, and separate opaque enablement classification.
- Malformed, BOM-prefixed, read-only, and concurrently changed config files.
- Installer-owned versus unowned conflict behavior.
- Transaction failure injection after each adapter and exact-byte rollback.
- Config fingerprint change between plan and apply.
- Concurrent config mutation after apply but before rollback, proving UEMCP reports `ROLLBACK_CONFLICT` instead of overwriting the later edit.
- Ownership-ledger absence, tampering, stale value hashes, exact-entry adoption, and copied-config behavior.
- Plan digest tampering, expiry, replay after success, and precondition drift.
- Generic descriptor generation for an unknown client.
- Redaction tests proving secret values cannot enter plans, logs, or receipts.

### Protocol Tests

- Initialize with representative and unknown client identities.
- Validate instructions are provider-neutral, self-contained in the first 512 bytes, and below 2 KiB.
- Enforce the 1,800-byte tool-description budget.
- Assert every registered tool has annotations consistent with its requirement classification.
- Verify clients without roots or elicitation retain current fallbacks.
- Verify roots-capable clients still auto-resolve only unambiguous projects.
- Verify initial management tools and dynamic `tools/list_changed` behavior remain intact.

### Deployment Tests

- Setup and sync produce the same destination manifest from the same source.
- A forged/current-looking marker cannot hide a content mismatch.
- A stale, missing, extra, or modified deployed file is detected by hash.
- Matching-editor lock blocks deployment; an unrelated editor does not.
- Staging/copy/replacement failure restores the prior plugin.
- Source, destination, or editor-lock drift immediately before replacement aborts without changing the destination.
- Generated binaries cannot be carried forward across a mismatched build-input, engine, target, configuration, or toolchain identity.
- External builds without reconstructable evidence remain `UNKNOWN` rather than current.
- Live editor verification compares the compiled-in loaded-module identity with on-disk build evidence.
- Build-relevant changes produce `BUILD_REQUIRED` even after successful copy.
- No-op reruns write neither plugin nor client config.

### Installed-Client Contract Tests

Opt-in tests use isolated client homes/profiles and the installed executables. They must never touch real user config.

- Claude user registration reaches `Connected`; project registration reports pending approval without bypass.
- Codex add/get/remove round trip preserves an unrelated server and demonstrates the guarded same-name behavior.
- Gemini user registration is recognized, an untrusted project is classified as pending trust/disconnected, and persistent/session disable is reported without changing enablement state.
- VS Code isolated user-data registration preserves an unrelated server, uses the validated native CLI tuple only for read-only version/characterization probes, targets the selected profile resource directly, and reports enablement/activation as unverified until a supported host surface proves them.

Client-version drift in these tests blocks claiming that version as release-gated; it does not authorize destructive fallback behavior.

### Existing Regression Gates

The default server rotation remains required. Focused deployment, project attachment, tool metadata, and wire tests must remain green. Live editor smoke remains opt-in and is required only for claims about editor/plugin health.

## Migration and Compatibility

- Existing `.uemcp-targets.json` profiles remain authoritative and compatible.
- Existing `.mcp.json` files are inspected and offered for migration; they are not overwritten.
- `.mcp.json.example` remains a manual/project-scope example only and is labeled accordingly.
- Existing user-scoped canonical client entries are adopted without rewrite.
- Existing user-added approval, timeout, trust, tool-filter, and sandbox fields are preserved.
- Existing batch entry points remain available as wrappers during migration.
- Deprecated provider-specific flags print actionable replacements and remain non-destructive.
- The central installer can consume the new result schema while older callers receive a clear unsupported-interface failure rather than a false success.

## Adversarial Failure Cases

The implementation must explicitly handle:

- a client executable disappears after planning;
- a client updates between inspect and apply;
- two clients share a config file or discover one another's config;
- the same UEMCP entry exists at several scopes with different commands;
- a managed policy rejects a locally valid entry;
- Node is available in the terminal but unavailable to a GUI host;
- a server path contains spaces, Unicode, or shell metacharacters;
- config contains comments, trailing commas, unknown fields, or credentials;
- another process edits config during the transaction;
- another process edits a UEMCP-written config before rollback begins;
- an ownership ledger is missing, stale, copied, or manually edited;
- a reviewed plan is expired, replayed, or has a mismatched digest;
- an adapter succeeds but native verification hangs or times out;
- a client list command reports registration but does not perform a health check;
- trust or restart is required after a successful structural write;
- the editor starts between plugin preflight and replacement;
- plugin source or destination changes between staging and replacement;
- generated binaries match by timestamp but not by build identity;
- target plugin content changes during manifest verification;
- a receipt is stale, copied from another machine, or manually edited;
- setup is launched from outside the repository or through AI-Tools cache paths;
- no supported client is installed;
- only an unknown standards-compatible client is installed.

Every case must terminate with a bounded operation, stable status, no silent overwrite of unplanned or concurrent state, and a concrete next action. Exact prior bytes are restored when UEMCP still owns the last write; otherwise recovery evidence is retained without clobbering the newer state.

## Follow-On Boundaries

These are intentionally deferred, not forgotten:

- Cursor and Windsurf adapters after official-schema review, isolated config tests, and installed-client smoke.
- Automatic targeting and configuration of every VS Code profile; this slice supports default/one explicit profile plus bounded same-name shadow evidence.
- VS Code Insiders, portable/remote user-data roots, and headless reads or writes of VS Code's separate enablement database.
- Automatic support for nonstandard native client install paths; PATH-only candidates remain unexecuted until a separately approved discovery contract exists.
- Claude Desktop and hosted ChatGPT plugin/connector packaging.
- Provider marketplace publication and update channels.
- Persistent local or remote Streamable HTTP hosting.
- Generic headless MCP execution with editor-commandlet parity.
- Structured output and pagination expansion for large topology, visual capture, and offline parser results.
- Per-tool idempotence and open-world annotation audits.
- Team-portable project configs using environment-variable indirection.

## Acceptance Criteria

The slice is complete only when all of the following are true:

1. Normal setup no longer writes or overwrites `.mcp.json` as its universal client action.
2. Once a compatible planning runtime exists, one orchestrator preflight and one orchestrator confirmation configure every detected release-gated client; a required pre-orchestrator Node bootstrap, client trust, and OS authority prompts remain explicit exceptions.
3. Claude Code, Codex, Gemini CLI, and VS Code adapters pass isolated fixture and installed-client contract tests for the supported version range.
4. Re-running setup on a healthy system performs no plugin or client-config writes.
5. Unrelated servers, comments, unknown fields, approvals, enablement/trust settings, timeouts, inputs, and sandbox policy survive every supported update.
6. An unowned mismatch is a visible conflict and is never silently replaced.
7. A multi-client apply failure restores exact prior client-config bytes unless a later external write is detected, in which case it preserves that write and reports `ROLLBACK_CONFLICT` with bounded recovery evidence.
8. User-scope entries are not reported healthy while shadowed by another scope or policy.
9. Enablement, trust, restart, build, and editor-restart requirements remain explicit action states.
10. The effective descriptor completes initialize and initial `tools/list` through the provider-neutral smoke harness.
11. Server instructions and runtime tips contain no client-specific native tool names.
12. Server instructions and tool descriptions satisfy their size budgets.
13. Standard MCP annotations agree with the existing tool requirement classifier.
14. Setup and sync use the same content-manifest deployment path.
15. Verification recomputes plugin hashes and cannot be satisfied by timestamps or a marker alone.
16. Stale managed plugin files are removed, while generated artifacts are retained only with separately verified compatible build evidence.
17. A current on-disk build is based on build-input and artifact identities, not file existence or modification times.
18. A live editor is reported current only when its compiled-in loaded-module identity matches expected build evidence.
19. Copy, build, client registration, client enablement, activation, protocol, and editor health are reported as distinct stages/fields.
20. Every detected release-gated client is selected by default or visibly reported `NOT_SELECTED`.
21. Apply rejects a changed, stale, or mismatched plan digest without making writes and serializes cooperating concurrent applies through the verified user-local lease.
22. AI-Tools consumes UEMCP's machine result and cannot convert partial setup into success or bypass the approved plan.
23. Receipts contain useful provenance and no secrets.
24. Default rotation, focused deployment tests, protocol tests, and client-adapter tests pass.
25. Documentation states exactly which clients and versions are release-gated and which require manual registration.
26. A missing or unsupported Node runtime can reach planning only through the narrow bootstrap, which performs no unrelated mutation and is independently revalidated.
27. Ownership decisions are backed by the current config and ownership ledger; name-only inference cannot authorize replacement.

## Evidence

### Local Source

- `setup-uemcp.bat`: Node bootstrap, target registration, `node_modules` existence check, `.mcp.json` overwrite path, independent plugin copy, built-in plugin edits.
- `sync-plugin.bat` and `server/sync-plugin-helper.mjs`: editor-lock, deploy-marker, cleanup, and copy behavior.
- `server/verify-deploy.mjs`: timestamp/marker classification, auto-sync, and provider-specific `.mcp.json` regeneration.
- `server/create-uemcp-server.mjs`: server instructions, client roots, dynamic toolsets, and current deprecated `server.tool` registration path.
- `server/tool-requirements.mjs`: existing centralized read/mutation classification.
- `plugin/UEMCP/Source/UEMCP/Private/EdgeCaseHandlers.cpp`: existing `get_editor_state` project/plugin identity response and its current mutable deploy-marker fields; this is the live handshake extension point, not sufficient loaded-binary evidence as written.
- `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs`: the existing Unreal module build boundary where a build-generated identity can be compiled into the plugin without relying on runtime disk-marker contents.
- `tools.yaml`: 150 tool definitions; all names satisfy current MCP naming guidance; `read_asset_properties` exceeds Claude's documented 2 KiB description limit.
- `D:/DevTools/AI-Tools/Installers/MCP-Suite/Scripts/install.mjs`: external-setup success assumption, Claude-only validation/update-hook surfaces, receipts, and config handling.

Focused verification during design research passed:

- `node test-project-server-wire.mjs`: 113/113.
- `node test-mcp-wire.mjs`: 64/64.
- `node test-tool-metadata.mjs`: 87/87.

### Primary Documentation

- MCP transports and stdio contract: <https://modelcontextprotocol.io/specification/2025-11-25/basic/transports>
- MCP lifecycle, capability negotiation, and server instructions: <https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle>
- MCP tools, schemas, annotations, and structured content: <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>
- MCP `ToolAnnotations` schema: <https://modelcontextprotocol.io/specification/2025-11-25/schema>
- Codex MCP configuration and shared host config: <https://learn.chatgpt.com/docs/extend/mcp?surface=cli>
- Claude Code MCP scopes, trust, tool search, and output limits: <https://code.claude.com/docs/en/mcp>
- Gemini CLI MCP config, scopes, trust, enablement, and commands: <https://geminicli.com/docs/tools/mcp-server/>
- VS Code MCP configuration, CLI registration, profile resources, separate enablement, trust, and sandbox fields: <https://code.visualstudio.com/docs/agent-customization/mcp-servers>
- VS Code profile storage and CLI behavior: <https://code.visualstudio.com/docs/configure/profiles> and <https://code.visualstudio.com/docs/configure/command-line>
- Windows metadata-preserving atomic file replacement: <https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-replacefilew>

The client-specific conclusions in this design combine those primary contracts with the isolated installed-version round trips listed in the Problem section. Automatic support is intentionally gated on both forms of evidence.
