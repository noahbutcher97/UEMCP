# Client Adapter Support

The deployment client domain discovers every closed client ID on every run.
Detected release-gated clients are selected by default; absent, excluded, and
unsupported clients remain visible. Writes are allowed only at the exact
versions below.

| Client | Write gate | Writable target | Read-only precedence evidence | Native verification |
| --- | --- | --- | --- | --- |
| Claude Code | `2.1.209`, `2.1.210` | Private user state under `CLAUDE_CONFIG_DIR` or the default home | managed, local, project, user, plugin plus approval/settings policy | `mcp list`, `mcp get uemcp` |
| Codex CLI | `0.144.4` | User `config.toml` under `CODEX_HOME` or the default home | trusted project layers, user config, system requirements | `mcp list --json`, `mcp get uemcp --json` |
| Gemini CLI | `0.41.2` | User `settings.json` under the effective Gemini home | system defaults, user, trusted project, system override, extensions, enablement policy | `mcp list` |
| VS Code | `1.128.1` | Default or selected existing profile `mcp.json` | workspace, selected/default user resource, other profiles and profile metadata | no native registration mutation or status query |

Claude and VS Code own `/type`, `/command`, and `/args`. Codex and Gemini own
`/command` and `/args`. Adoption of an exact unowned registration writes only
the UEMCP ownership ledger. Updates preserve environment, working directory,
timeouts, enablement, policy, comments, unrelated servers, and other
client-owned fields. A conflicting unowned registration is never replaced
implicitly.

## Selection And Workspace

Repeatable `--include-client` values are recorded in the public
`request.selected_clients` field and also drive exact selection. Exclusions
remain visible as `NOT_SELECTED`. Apply accepts no selection override and
replays only the selected rows and operations in the approved plan.
An explicitly requested unavailable client remains a valid targeted
`NOT_INSTALLED` or version-probe remediation row; `request.selected_clients`
records the request, while `client.selected` records whether an installed row
can participate in apply. The plan validator binds that distinction to matching
discovery evidence rather than inferring availability from a null version.
Every client write operation is also bound to the matching selected,
release-gated client row and its inspection evidence. Its exact physical paths
must equal that row's reviewed `touched_paths`; a missing launch contract,
blocked inspection, duplicate adapter row, or operation attached to an absent
or inspect-only row invalidates the plan before apply.

Provider workspace inspection is rooted at the directory from which the
deployment CLI was invoked. `--project` and `--profile` select Unreal target
registration; they do not silently redefine provider project/workspace scope
or authorize a shared project config write. Adapter writes default to private
user scope. Project/workspace registrations are precedence evidence unless a
future explicit project-scope operation is specified and approved.

Every inspected config, policy, profile-metadata, client executable, and server
launch path is fingerprinted into plan preconditions, including configured
no-op clients. The plan also retains a secret-safe launch tuple and a hash of
discovery-relevant homes, PATH inputs, workspace, trust inputs, and selected
profile roots. Apply validates those facts, reuses the reviewed launch tuple,
and returns `PLAN_STALE` before child execution when the context changed. It
does not rediscover a replacement same-version executable after approval.
Malformed, over-limit, or unsafe selected-client inspection cannot produce an
applicable plan because complete path preconditions cannot be proven. During
apply, read-only and no-op preconditions are checked again immediately before
every client-native query and protocol launch. Once the central transaction
owns a writable path, that path is guarded by the transaction's applied-byte
checks while executable, server, policy, profile, and other read-only evidence
continues to be rechecked before active execution.
After the transaction returns, every committed writable path is rechecked
against the exact applied content hash before post-commit native or protocol
launch. Each launch also rechecks the inspection fingerprints that produced its
private environment and working-directory capability. A concurrent edit cannot
cause UEMCP to execute an unreviewed registration or report stale health.
Some provider read commands create one-time state. If an inspection detects
that its own evidence changed while the native query ran, UEMCP reruns the full
inspection once and requires the second result to remain stable. Repeated drift
or any unsafe fingerprint failure still stops before protocol launch; apply-time
plan preconditions are never relaxed by this settlement retry.

Transaction results use a closed schema. Client rows, touched paths and hashes,
rollback rows, hook errors, retained snapshots, and cleanup actions must all be
well formed and refer only to approved writable paths. Nominal success without
complete touched-file evidence becomes committed `SYNC_FAILED`. A transaction
that commits configuration but still needs provider action or snapshot cleanup
returns `CLIENT_APPLY_ACTION_REQUIRED`; it never aggregates as healthy.
Rollback cleanup failures retain path-only, bounded snapshot evidence even when
the original bytes were restored successfully.

## Client Boundaries

Claude managed policy is authoritative. Local and project registrations can
require trust or approval even when user registration is exact. Native list/get
evidence can report connected, pending approval, rejected, absent, or unknown;
it does not replace structural or protocol proof. Native mutation is disabled.

Codex project layers are inspected root-to-leaf only for trusted workspaces; the
deepest active layer wins over user configuration. The host CLI's MCP registry
is shared state, while desktop activation is not proven by the CLI. A fresh
absent user file may use release-gated `mcp add` only against transaction-owned
staging, followed by exact-byte replacement. Existing files use parser-backed
targeted edits. Other native mutation is disabled.

Gemini precedence is system defaults, user, trusted project, then system
override; enabled extension declarations remain separate provenance. Persistent
disable, administrative policy, session connection, and pending trust are
independent. The adapter never mutates enablement or invokes native add/remove.
Protocol smoke uses the fully deep-merged effective settings entry, including
inherited environment and working-directory fields, rather than the physical
occurrence that contributed the highest-precedence fragment.

VS Code is version-probed only through `Code.exe` plus its same-install
`resources/app/out/cli.js` and exact `ELECTRON_RUN_AS_NODE`/`VSCODE_DEV`
overlay. It never launches the GUI and never invokes `--add-mcp`. Profile
metadata must authorize an existing named profile. Static verification requires
restart and leaves enablement and activation `UNKNOWN`.

## Protocol And Secrets

Public inspection retains environment names and SHA-256 values as
`{ name, value_sha256 }` rows. Raw values and custom names as object keys are
forbidden in plans, results, and receipts. The adapter retains effective
environment and working-directory values only in a private in-memory capability.
Sensitive launch review is case-insensitive and shared across adapters for
`NODE_OPTIONS`, `NODE_PATH`, `PATH`, `PATHEXT`, `COMSPEC`, `HOME`,
`USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
`GEMINI_CLI_HOME`, and every `UEMCP_` or `UNREAL_` prefix.

Standalone verify and doctor do not protocol-smoke a registration carrying
`CUSTOM_ENV_REVIEW_REQUIRED` or `CUSTOM_LAUNCH_REVIEW_REQUIRED`. Structural and
native facts remain visible and protocol status remains unknown. Approved apply
may smoke the exact in-memory launch only when those actions were present in the
saved plan. The canonical machine descriptor remains provider-neutral with an
empty environment and null working directory.

## Unsupported Clients

Newer and older releases are inspect-only and cannot emit write operations.
Deferred client IDs are not accepted by selection. Other MCP hosts receive the
generic canonical descriptor and `MANUAL_REGISTRATION_REQUIRED`; generic
support never substitutes for a detected supported client.

## Widening A Gate

1. Add release-specific characterization tests for discovery, parser behavior,
   config precedence, native read commands, mutation side effects, and
   enablement/trust/restart semantics.
2. Run the adapter and central transaction suites with hostile paths, links,
   malformed input, exact-byte rollback, and secret-redaction cases.
3. Run the opt-in installed contract against isolated provider homes. Prove
   plan/apply/no-op behavior and unchanged hashes for every real default config,
   profile, extension-state, and enablement path.
4. Update `RELEASE_GATES` only after that evidence passes. Never use a range,
   nearest-version assumption, or automatic newer-version widening.
5. Rebuild the deployment bundle, run lint and the complete default rotation,
   and report the installed version and proof boundary.

The deployment bundle includes `jsonc-parser` 3.3.1 and
`toml-eslint-parser` 0.12.0 for structured, metadata-preserving edits.

The opt-in installed contract runs each detected exact gate in isolated homes,
requires plan/apply/no-op behavior, and hashes real default client config,
profile, extension, and enablement paths before and after every provider.
Installed versions outside the table report an explicit inspect-only skip and
must emit no write operation.
