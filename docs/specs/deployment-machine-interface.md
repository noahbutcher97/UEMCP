# Deployment Machine Interface

UEMCP deployment is exposed as a versioned plan/apply machine contract. The
tracked standalone entry is `dist/deploy-uemcp.mjs`; developers may run the
source entry at `server/deploy-uemcp.mjs`.

## Commands

Run the release entry with Node 22 or newer:

```powershell
node dist/deploy-uemcp.mjs plan --operation setup --project "D:\Path\Game.uproject" --json
node dist/deploy-uemcp.mjs apply --plan-file "D:\Path\uemcp-plan.json" --approve-digest "<64-lowercase-hex>" --non-interactive --json
node dist/deploy-uemcp.mjs verify --project "D:\Path\Game.uproject" --json
node dist/deploy-uemcp.mjs doctor --project "D:\Path\Game.uproject" --json
node dist/deploy-uemcp.mjs repair --project "D:\Path\Game.uproject" --json
```

`plan`, `verify`, `doctor`, and `repair` accept `--project`, `--profile`, and
`--targets-file <absolute.json>`. A direct project and a profile are mutually
exclusive. Direct projects must be absolute `.uproject` paths. An explicit
targets file is path-validated by the target domain and its composite
fingerprint is bound into a plan even when no direct project registration is
requested. When registration is planned, the canonical registry path is also
sealed into the operation so a later apply process does not depend on its own
default target-path selection.

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
2. The exclusive apply lease and replay ledger.
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
    selected_clients
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
Structural registration, enablement/policy, and activation/trust are independent
state fields.

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
deployment-specific working directory. Protocol smoke launches this exact
descriptor and verifies MCP initialize plus the first `tools/list` request.
Protocol health does not imply that a native client is configured, enabled,
trusted, or restarted.

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
input_manifest_sha256, bundle_sha256
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
`node_modules` directory as proof of readiness.

## Security And Compatibility

Source must be an attributable signed-Git checkout or a verified pinned archive.
Plans and receipts reject secret-bearing fields. Child processes use absolute
executables, argument arrays, bounded output, deadlines, and `shell: false`.
Path checks reject device paths, unsafe links, and real-path escape before any
write. Snapshot creation and rollback reject linked files and linked ancestor
paths. The Windows apply lease checks both PID and process-start evidence, so a
reused PID cannot impersonate a crashed owner.

CLI failures emit only closed error codes and fixed diagnostic text. Arbitrary
provider, parser, child-process, command, flag, and exception text is never
echoed to stderr.

Schema 1.0 is closed for required fields, status values, and action codes. A
future additive field is backward-compatible only when it is optional and old
consumers can safely ignore it. A major schema mismatch is
`UNSUPPORTED_INTERFACE` and exits `64`; consumers must not reinterpret it as a
healthy or partially compatible result.

## Current Boundary

This core enables prerequisite inspection/install, structured project-target
registration, deterministic plans, apply leases, replay protection, receipts,
and generic MCP protocol smoke. Automatic Claude, Codex, Gemini, and VS Code
configuration is not enabled yet. Plugin copy/build/load proof is also not
enabled yet. Those capabilities join the same orchestrator as later client and
plugin domains; until then generic clients truthfully report
`MANUAL_REGISTRATION_REQUIRED`.
