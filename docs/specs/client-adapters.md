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
