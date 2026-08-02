# Client Adapter Support

The deployment client domain discovers every closed client ID on every run.
Detected release-gated clients are selected by default; absent, excluded, and
unsupported clients remain visible. Writes are allowed only at the exact
versions below. Unsupported releases receive structural file inspection only;
UEMCP does not run release-specific native queries or protocol smoke against
them, even when they are explicitly included.

| Client | Write gate | Writable target | Read-only precedence evidence | Native verification |
| --- | --- | --- | --- | --- |
| Claude Code | `2.1.210` | Private user state under `CLAUDE_CONFIG_DIR` or the default home | managed, local, project, user, plugin plus approval/settings policy | `mcp list`, `mcp get uemcp` |
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

Repair decisions are explicit plan inputs, not ambient adapter options.
`--replace-owned-client-fields` permits replacement only when the ownership
ledger proves that UEMCP previously owned the changed fields;
`--shadow-gemini-extension` permits a reviewed user registration to shadow one
conflicting extension registration without modifying the extension; and
`--migrate-legacy-claude-project` permits migration of a legacy Claude project
registration only when no higher-precedence local registration exists. These
booleans are serialized as `request.client_decisions`, covered by the plan
digest, and forbidden as apply-time overrides. They never authorize replacing
an unowned conflict.

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
Discovery canonicalizes equivalent launch tuples before version probing. If
more than one distinct safe installation remains viable, discovery reports
`AMBIGUOUS_CLIENT_INSTALLATION` with no executable authority instead of
selecting candidate order.
Malformed, over-limit, or unsafe selected-client inspection cannot produce an
applicable plan because complete path preconditions cannot be proven. During
apply, read-only and no-op preconditions are checked again immediately before
every client-native query and protocol launch. Once the central transaction
owns writable paths, every existing writable and read-only evidence file is
held by the Windows file-pin helper through each client-native child process.
The transaction rechecks exact approved or applied fingerprints after pin
acquisition and again after child completion; the child receives a composed
guard covering both transaction evidence and its inspected client runtime.
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

For npm-installed Claude, Codex, and Gemini clients, launch evidence also binds
the declared installed dependency closure containing the JavaScript entrypoint.
Nested and hoisted required, optional, and peer packages are resolved beneath
one canonical npm module root. The closure is capped at 2,048 packages, 32,768
traversed entries, 16,384 files, and 1 GiB of aggregate file content; links and
multiply linked files are rejected. Its canonical manifest is recomputed before
every native or protocol launch. A runtime changed after discovery fails closed
even when the package version string did not change.

Transaction results use a closed schema. Client rows, touched paths and hashes,
rollback rows, hook errors, retained snapshots, and cleanup actions must all be
well formed and refer only to approved writable paths. Nominal success without
complete touched-file evidence becomes committed `SYNC_FAILED`. A transaction
result that fails schema validation produces conservative touched-file rows for
every writable precondition, including the ownership ledger, with unknown
applied hashes rather than omitting uncertain state. A transaction
that commits configuration but still needs provider action or snapshot cleanup
returns `CLIENT_APPLY_ACTION_REQUIRED`; it never aggregates as healthy.
Rollback cleanup failures retain path-only, bounded snapshot evidence even when
the original bytes were restored successfully.

Saved client-stage plan evidence is recursively closed. The stage object,
per-client rows, launch contracts and file fingerprints, owned-field diffs,
environment hashes, and status vocabularies reject unknown keys or values
before apply. Public runtime-failure diagnostics likewise expose only a closed
cause-code vocabulary and approved changed-field names; unknown provider or
platform codes normalize to `UNKNOWN`.

## Client Boundaries

Claude managed policy is authoritative. Workspace trust is derived from the
current project's entry in Claude user state, while project approval and
enablement are derived from the effective settings files. Installed plugin
registrations are read only from the bounded installed-plugin registry and
cache, with plugin enablement and `${CLAUDE_PLUGIN_ROOT}` resolution applied.
Local and project registrations can require trust or approval even when user
registration is exact. Native list/get evidence can report connected, pending
approval, rejected, absent, or unknown; it does not replace structural or
protocol proof. Native mutation is disabled.

Codex workspace trust is derived from the exact project entry in the user's
`projects` table. Project layers are inspected root-to-leaf only for trusted
workspaces; the deepest active layer wins over user configuration. The host
CLI's MCP registry is shared state, while desktop activation is not proven by
the CLI. A fresh absent user file may use release-gated `mcp add` only against
transaction-owned staging, followed by exact-byte replacement. Existing files
use parser-backed targeted edits. Other native mutation is disabled.

Gemini workspace trust is derived from its effective folder-trust setting,
trusted-folders rules, and the documented trust override environment. Its
precedence is system defaults, user, trusted project, then system override;
enabled extension declarations remain separate provenance. Persistent disable,
administrative policy, session connection, and pending trust are independent.
When extensions are enabled, malformed or ambiguous extension manifests and
enablement rules make the complete registration `MALFORMED_CONFIG`, even if an
exact settings entry also exists; the malformed file fingerprint remains bound.
The adapter never mutates enablement or invokes native add/remove. Protocol
smoke uses the fully deep-merged effective settings entry, including inherited
environment and working-directory fields, rather than the physical occurrence
that contributed the highest-precedence fragment.

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

Provider CLI probes and native read commands inherit only a fixed operational
allowlist: Windows runtime and path keys, provider home/trust keys, temporary
directories, the fixed VS Code launch keys, and `UEMCP_`/`UNREAL_` prefixes.
Unrelated parent variables and ambient `NODE_OPTIONS`/`NODE_PATH` are omitted.
Protocol smoke starts from that same filtered parent and then applies the exact
inspected registration overlay. An arbitrary registration value can therefore
execute only after its normal custom-environment review is present in the
approved plan.

Standalone verify and doctor do not protocol-smoke a registration carrying
`CUSTOM_ENV_REVIEW_REQUIRED` or `CUSTOM_LAUNCH_REVIEW_REQUIRED`. Structural and
native facts remain visible and protocol status remains unknown. Approved apply
may smoke the exact in-memory launch only when those actions were present in the
saved plan. The canonical machine descriptor remains provider-neutral with an
empty environment and null working directory.

Protocol smoke uses a repo-owned stdio transport rather than the SDK's unbounded
line buffer. Total child stdout is capped at 8 MiB and stderr at 64 KiB; either
overflow terminates the child and fails the active protocol phase. Unterminated
JSON lines are therefore bounded by the same stdout ceiling, and no provider
output is copied into public evidence. On Windows, close invokes the absolute
system `taskkill.exe` with `/T /F` before sending EOF and waits for the child
`close` event. This covers the normal descendant process cases exercised by the
smoke suite. A bounded direct-child fallback remains for failure of the system
tree-termination primitive; kernel-enforced Job Object containment is not part
of this release gate.

The npm closure manifest is execution-drift evidence for the currently
installed bytes, not package-registry authenticity evidence. Files reached only
through an intentionally undeclared import from a shared module root are not in
the declared closure. Enforcing that stronger boundary requires a future
isolated runtime or loader policy rather than a wider filesystem hash.

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
