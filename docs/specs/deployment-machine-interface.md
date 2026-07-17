# Deployment Machine Interface

UEMCP deployment is exposed as a versioned plan/apply machine contract. The
tracked standalone entry is `dist/deploy-uemcp.mjs`; developers may run the
source entry at `server/deploy-uemcp.mjs`.

## Commands

Run the release entry with Node 22 or newer:

```powershell
node dist/deploy-uemcp.mjs plan --operation setup --project "D:\Path\Game.uproject" --output-plan "D:\Path\uemcp-plan.json" --json
node dist/deploy-uemcp.mjs apply --plan-file "D:\Path\uemcp-plan.json" --approve-digest "<64-lowercase-hex>" --non-interactive --json
node dist/deploy-uemcp.mjs verify --project "D:\Path\Game.uproject" --json
node dist/deploy-uemcp.mjs doctor --project "D:\Path\Game.uproject" --json
node dist/deploy-uemcp.mjs repair --project "D:\Path\Game.uproject" --json
```

`plan`, `verify`, `doctor`, and `repair` accept `--project`, `--profile`,
repeatable `--include-client <id>` and `--exclude-client <id>`,
`--vscode-profile <name>`, and `--targets-file <absolute.json>`. Client IDs are
limited to `claude`, `codex`, `gemini`, and `vscode`; include/exclude overlap is
invalid. Explicit includes are also retained in
`request.selected_clients`. Release-gated detected clients are selected by
default. A direct project and a profile are mutually exclusive. Direct projects
must be absolute `.uproject` paths. An explicit
targets file is path-validated by the target domain and its composite
fingerprint is bound into a plan even when no direct project registration is
requested. When registration is planned, the canonical registry path is also
sealed into the operation so a later apply process does not depend on its own
default target-path selection.

`plan` and `repair` additionally accept `--replace-owned-client-fields`,
`--shadow-gemini-extension`, and `--migrate-legacy-claude-project`. These are
narrow repair decisions: they are serialized in `request.client_decisions`,
bound by the plan digest, and cannot be supplied to `verify`, `doctor`, or
`apply`. They do not authorize replacement of unowned client state.

`plan` and `repair` also accept `--output-plan <absolute.json>`. The CLI writes
one UTF-8 JSON document through a flushed sibling scratch file and atomically
publishes it only when the destination does not already exist. It never
replaces a reviewed plan. JSON or human output on stdout is unchanged, and
`apply`, `verify`, and `doctor` reject this flag.

`apply` accepts no target, profile, client, or operation override. It requires
the exact saved plan, its exact digest, and `--non-interactive`. `repair` only
creates a reviewed repair plan; applying it uses the same `apply` command.

In `--json` mode stdout contains one JSON document and nothing else. Diagnostics
use stderr. A nonzero plan exit can still have valid plan JSON and must be parsed
according to the outcome table below.

## Plan And Apply

A plan has `kind: "uemcp.deployment.plan"` and `schema_version: "1.0"`. It
contains:

```text
operation, outcome, created_at, expires_at
source, request, descriptor
stages, clients, operations, preconditions, actions
digest
```

The digest is lowercase SHA-256 over canonical JSON for every plan field except
`digest` itself. Object keys are recursively sorted; array order remains
significant. Plans expire exactly 30 minutes after creation.

Apply validates, in order:

1. Schema, stored digest, approved digest, and initial expiry.
2. The exclusive apply lease and durable apply journal or legacy replay ledger.
3. Every executable version, path identity, link state, and content precondition.
4. Current source provenance and the canonical launch descriptor.
5. Only the operations already present in the approved plan.

Apply never replans. A lease waiter repeats replay and precondition validation
after it acquires the lease. Rejected or no-progress failed plans remain
retryable only until their original expiry and while all preconditions remain
unchanged. A committed or fully rolled-back apply records the digest as
consumed. Receipts are redacted, self-hashed, and stored in machine-local state.
An unresolved prerequisite with no reviewed remediation operation stops
downstream planning. A prerequisite apply failure stops every downstream write.
If a later domain throws after an earlier domain committed progress, the core
emits a fixed `SYNC_FAILED` terminal stage, writes a `PARTIAL` receipt, and
consumes the approved plan rather than losing the earlier mutation.
The same rule applies when client configuration commits but post-commit client
inspection fails. A malformed transaction result, an unknown transaction
status, or nominal success without touched-file hash evidence also becomes a
committed `SYNC_FAILED` stage instead of healthy or replayable output.
The central client transaction receives the orchestrator's already-held apply
lease as an externally owned capability. It neither reacquires nor releases
that lease; only the orchestrator releases it after receipts and replay state
are durable.

Lease publication is a create-only Windows-safe protocol. Each claimant writes
and flushes an owner-token-specific record, then hard-links it to the canonical
lease path. Only one claimant can publish that path. Inspection recognizes and
heals the exact two-link residue left by interruption after publication;
malformed, aliased, multiply linked, or otherwise ambiguous residue fails
closed. Release requires the still-active in-memory owner capability and an
exact on-disk owner-token match.

Mutation-capable apply uses a write-ahead journal keyed by plan digest. The
journal cannot enter `applying` until it contains a prepared, self-hashed
recovery receipt. That receipt reports `APPLY_INTERRUPTED`, marks mutation state
as unknown, and consumes the digest conservatively if execution stops before a
terminal result can be staged. Normal completion replaces the recovery document
with the exact terminal receipt in `receipt_pending` before the receipt file is
written; only the staged receipt can advance the journal to `committed`. On
restart, replay detection reconstructs either missing receipt from the journal
or verifies an existing one before rejecting the digest as consumed. A verified
no-progress failure may clear its still-owned journal and remain retryable. The
prior replay ledger is validated and read for compatibility, but new applies are
committed through the receipt-bearing journal.

Client project/workspace inspection uses the invocation working directory. An
Unreal `--project` or target `--profile` remains a target-registration choice
and cannot silently redirect provider project scope to the `.uproject` parent
or the UEMCP source checkout. Default client writes remain private user-scope
writes.

## Result Schema

`apply`, `verify`, and `doctor` return `kind: "uemcp.deployment.result"` with
`schema_version: "1.0"`:

```js
{
  schema_version,
  kind,
  operation,
  outcome,
  timestamp,
  source: {
    kind,
    repository,
    repo_root,
    git_commit,
    dirty,
    archive,
    orchestrator_version
  },
  request: {
    requested_project,
    requested_profile,
    selected_clients,
    client_decisions: {
      replace_owned_fields,
      shadow_gemini_extension,
      migrate_legacy_claude_project
    }
  },
  descriptor: {
    name,
    transport,
    command,
    args,
    env,
    cwd
  },
  plan,
  stages,
  clients,
  receipts,
  actions
}
```

An apply result has a non-null consumed-plan summary containing `digest`,
`created_at`, `expires_at`, and `preconditions_valid`. Standalone verify and
doctor results always use `plan: null`.

A public stage has exactly:

```js
{ name, status, mandatory, changed, evidence, actions }
```

Internal reduction facts are deliberately not serialized. `status` comes from
the closed schema-1.0 registry in `server/deployment/contracts.mjs`. Unknown
status or action values are contract errors, not forward-compatible guesses.

A client row has exactly:

```js
{
  adapter,
  version,
  compatibility,
  write_supported,
  selected,
  scope,
  status,
  enablement,
  activation,
  actions
}
```

Compatibility is one of `release_gated`, `known_unsupported`, `unknown_newer`,
or `not_installed`. `write_supported` is true only for `release_gated` clients.
Unknown and unsupported releases use structural inspection only: no
release-specific native provider command or protocol smoke is launched.
Structural registration, native-client evidence, protocol health,
enablement/policy, and activation/trust are independent facts. The aggregate
does not promote one fact from another. Client-stage environment evidence uses
an array of fixed-key rows `{ name, value_sha256 }`; environment names are
never dynamic object keys and values are never serialized.

Client plans fingerprint every inspected config, policy, enablement,
profile-metadata, executable, and canonical server path even when the client is
already configured and emits no write. A secret-safe reviewed launch tuple and
discovery-context hash bind the executable choice, client homes, relevant PATH
inputs, invocation workspace, trust inputs, and VS Code profile root. Apply
validates those facts and reuses the reviewed tuple; it does not perform a new
same-version executable discovery after approval. Equivalent launch tuples are
deduplicated; multiple distinct viable installations report
`AMBIGUOUS_CLIENT_INSTALLATION` without launch authority. Selected-client
inspection
that is malformed, over-limit, or unsafe stops plan construction because it
cannot bind complete evidence. Apply repeats the client-path and outer-lease
checks immediately before every native or protocol process. Transaction-owned
writable paths use the transaction's post-write guards; all remaining reviewed
paths retain the immediate prelaunch check.
Client write operations must exactly match the selected release-gated adapter
row and its reviewed `touched_paths`. After commit, writable paths are checked
against the transaction's exact applied hashes, and each protocol launch also
rechecks the inspection fingerprints that produced its private launch values.
Provider read commands that create one-time state receive at most one complete
inspection retry, after which all evidence must be stable. The retry never
overrides approved-plan preconditions or permits repeated drift.
The transaction result itself is closed and path-bound: unknown fields or
statuses, missing or foreign touched paths, null hashes for writes, malformed
rollback evidence, and invalid retained-snapshot or cleanup rows terminalize as
committed `SYNC_FAILED` rather than becoming healthy output.

Npm-package launch tuples additionally bind a deterministic manifest for the
declared installed dependency closure, including nested and hoisted required,
optional, and peer packages. Discovery and every active launch reject links,
multiply linked files, unsupported path types, concurrent read drift, more than
2,048 packages, more than 32,768 traversed entries, more than 16,384 files, or
more than 1 GiB of aggregate file content. The reviewed JavaScript entrypoint
and every resolved package root must remain beneath the same canonical npm
module root.

`ROLLBACK_FAILED` is distinct from `ROLLED_BACK` and `ROLLBACK_CONFLICT`. It is
a committed terminal failure with path-only restoration, hook-error, touched
hash, and retained-snapshot evidence. Affected client rows are downgraded to the
terminal rollback state or `UNKNOWN`; stale pre-commit health is never reused.
Committed and rollback terminal results write receipts and consume the plan.
`ACTION_REQUIRED` after client apply is also non-healthy: the client stage uses
`CLIENT_APPLY_ACTION_REQUIRED`, preserves path-only cleanup evidence, writes a
receipt, and consumes the plan because configuration progress already
committed.

## Outcomes And Exits

| Outcome | Exit | Meaning |
| --- | ---: | --- |
| `HEALTHY` | `0` | All mandatory work is ready. |
| `ACTION_REQUIRED` | `10` | Review, approval, or a human-owned action remains. |
| `PARTIAL` | `20` | Some progress committed and mandatory work failed. |
| `FAILED` | `30` | Required work failed without useful committed progress. |

CLI usage and schema/interface errors exit `64`. Digest mismatch, expiry,
replay, stale preconditions, and runtime deployment failures are failed
operations and exit `30`. Only `HEALTHY` exits zero.

## Canonical Descriptor

The descriptor is provider-neutral and exact:

```js
{
  name: "uemcp",
  transport: "stdio",
  command: "<canonical absolute node.exe>",
  args: ["<canonical absolute server/server.mjs>"],
  env: {},
  cwd: null
}
```

It does not pin an Unreal project, enable Python execution, or inherit a
deployment-specific working directory. Protocol smoke verifies MCP initialize
plus the first `tools/list` request. Generic smoke launches this exact
descriptor. Client smoke uses a private, in-memory effective environment and
working directory from the inspected registration without changing or
serializing the canonical descriptor. Windows environment overlays remove
case-colliding parent aliases. Provider processes inherit only fixed Windows,
provider-home/trust, temporary-directory, VS Code launch, and UEMCP/Unreal
keys; arbitrary parent variables are not forwarded. Standalone verify and
doctor do not launch
registrations requiring custom-environment or custom-launch review; protocol
health remains unknown. Post-approval apply may launch those exact values only
when the saved plan contains the corresponding review action. Protocol health
does not imply that a native client is configured, enabled, trusted, or
restarted.

The bounded stdio transport caps stdout and stderr, terminates the Windows
process tree through the absolute system `taskkill.exe /T /F` before sending
EOF, and waits for the child `close` event. Its independent six-second cleanup
deadline is longer than the bounded tree-termination path and the covered
descendant cases release their configured working directory before return.
Ambient `NODE_OPTIONS` and `NODE_PATH` are removed from provider CLI and
protocol-smoke processes. A registration-provided value is applied only from
the inspected private overlay and remains subject to explicit review.

## Standalone Bundle

`dist/deploy-uemcp.mjs` bundles deployment-only JavaScript and third-party
packages. Node built-ins remain external as `node:*`; the normal MCP server is
referenced at `server/server.mjs` and is not embedded.

The adjacent `deploy-uemcp.manifest.json` records:

```text
schema_version, entry, node_minimum, esbuild_version
source_inputs and exact SHA-256 values
package_lock_sha256
bundled_packages with name, version, and license
notices_sha256, input_manifest_sha256, bundle_sha256
```

The manifest contains no timestamp or absolute build path. Two unchanged builds
must produce byte-identical bundle, manifest, and notices files. CI and release
checks recompute all first-party, lockfile, aggregate, and bundle hashes. The
bundle can inspect and plan before `server/node_modules` exists, but it still
requires Node 22. An outer installer must bootstrap Node when it is absent; the
core reports `NODE_INSTALL_REQUIRED` and never silently installs a runtime.

Every real plan, verify, doctor, and apply source recheck also validates the
manifest, active bundle bytes, package lock, all bundled first-party inputs, and
the adjacent notices file. Missing or stale evidence fails closed with
`BUNDLE_FRESHNESS_FAILED`; `--help` remains available for recovery guidance.

Dependency apply uses the exact discovered Node and npm CLI with:

```text
npm ci --omit=dev --ignore-scripts --no-audit --no-fund
```

It validates the complete production closure rather than treating a
`node_modules` directory as proof of readiness. Npm-installed client CLIs use
the same bounded runtime-tree manifest described above; package version alone
is never execution authority.

## Security And Compatibility

Source must be an attributable signed-Git checkout or a verified pinned archive.
Plans and receipts reject secret-bearing fields. Child processes use absolute
executables, argument arrays, bounded output, deadlines, and `shell: false`.
Path checks reject device paths, unsafe links, and real-path escape before any
write. Snapshot creation and rollback reject linked files and linked ancestor
paths. The Windows apply lease checks both PID and process-start evidence, so a
reused PID cannot impersonate a crashed owner.

Immediately around each config creation, replacement, deferred delete,
rollback restoration, and transaction-owned directory cleanup, the transaction
opens and validates every existing ancestor from the volume root and holds a
delete-denying sentinel in the destination parent. Parent identity is
revalidated after acquisition. Directory substitution therefore becomes a
precondition or rollback conflict rather than redirecting the approved write.

CLI failures emit only closed error codes and fixed diagnostic text. Arbitrary
provider, parser, child-process, command, flag, and exception text is never
echoed to stderr.

Client inspection exposes environment key names and hashes only. Sensitive
launch controls such as `NODE_OPTIONS`, case variants, UEMCP/Unreal prefixes,
and custom working directories require explicit review. They cannot execute
during standalone inspection.

Schema 1.0 is closed for required fields, status values, and action codes. A
future additive field is backward-compatible only when it is optional and old
consumers can safely ignore it. A major schema mismatch is
`UNSUPPORTED_INTERFACE` and exits `64`; consumers must not reinterpret it as a
healthy or partially compatible result.

## Current Boundary

This core enables prerequisite inspection/install, structured project-target
registration, deterministic plans, apply leases, replay protection, receipts,
and transactional Claude, Codex, Gemini, and VS Code configuration at the exact
release gates in `client-contract.mjs`. Unsupported releases remain
inspect-only. Generic hosts still use the canonical manual descriptor and
truthfully report `MANUAL_REGISTRATION_REQUIRED`. Plugin copy/build/load proof
is not enabled yet; it joins the same orchestrator as a later plugin domain.
Npm runtime manifests bind the declared installed dependency closure and detect
plan-to-launch byte drift. They do not authenticate registry provenance or
confine an intentionally undeclared import from a shared module root. Windows
descendant termination uses bounded `taskkill /T`; kernel-enforced Job Object
containment remains a follow-on for hostile early-parent-exit cases.
The deployment surfaces have these intentionally separate boundaries:

| Capability | Current entrypoint | Status |
| --- | --- | --- |
| Claude, Codex, Gemini, and VS Code registration | `dist/deploy-uemcp.mjs` | Implemented through reviewed plan/apply transactions at exact release gates. |
| Structured project-target registration | `dist/deploy-uemcp.mjs` | Implemented and fingerprint-bound. |
| Plugin copy, Unreal build, plugin load, and complete workstation onboarding | `setup-uemcp.bat` and existing sync/build helpers | Legacy workflow remains authoritative until the separate onboarding cutover plan. |
| Uninstall and retirement | None in this machine interface | Deferred to the separate retirement plan. |

The legacy `setup-uemcp.bat` onboarding entrypoint has therefore not been cut
over to this machine interface. `plan --operation setup` does not implicitly
copy, build, load, uninstall, or retire the Unreal plugin.
See `docs/specs/client-adapters.md` for client-specific support and proof
boundaries.
