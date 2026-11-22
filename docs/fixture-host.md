# Local owned fixture host

`server/fixtures/uemcp-fixture` is the canonical source-only host. Its Runtime
module supports the retained Game target and the Editor target. UEMCP is enabled
explicitly; its descriptor declares required engine plugin dependencies.

## Locate an owned host by engine

For an existing host, check the checkout's local `docs/audits/local-owned-hosts.md`
if available. It gives the path to each retained host and the engine build from its
`host-manifest.json`. The deployment profiles in `.uemcp-targets.json` list
deployment targets and can omit owned fixture stages. Machine-specific paths belong
in the local inventory.

Open the stage manifest and check `engine.root`, `engine.build`, `source` and the
project under `host/`. A copied `.uproject` can retain a different engine association.
For a retained evidence stage, take a verified source copy and sync the plugin
under test into the new stage. Record the host and plugin revisions separately.

## Stage a fresh host

From the repository root, allocate the task directory once. Enter the coordinator
and revision in its `RUN.md` and share the returned path with the workers. The
example uses a checkout at `\src\UEMCP` and a separate `\Scratch\UEMCP`
directory on the same drive. If the checkout contains that scratch directory,
run this example from a checkout outside it. Additional engines use sibling
directories inside the same task directory.

```powershell
$taskRoot = ./new-task-root.ps1 -Task graph-placement -ExternalFixture
$engineRun = New-Item -ItemType Directory -Path (Join-Path $taskRoot 'ue56')
$stage = Join-Path $engineRun.FullName 'stage'
node server/prepare-fixture-host.mjs --output-root $stage --engine-root 'C:/Program Files/Epic Games/UE_5.6'
```

The external-fixture switch places the task under `<checkout drive>:\Scratch\UEMCP`.
For a package-only run, omit the switch to use the primary checkout's
ignored `.scratch/runs/`. Retained issue fixtures live in `.scratch/retained/`.
If a task
directory already exists, inspect its run record and use the coordinator's path.
The staging command needs a fresh, absent leaf outside the source checkout.
Use `Join-Path $stage 'host/UEMCPFixture.uproject'` to locate the project. Build its
`UEMCPFixtureEditor Win64 Development` target with the selected engine's existing
`Engine/Build/BatchFiles/Build.bat`, using a bounded process runner. No build or
editor starts during staging. Do not use a live consumer project.

### Retire an output from a completed run step

After the last consumer exits, keep the log, manifest and verification receipt
outside the retired output. In PowerShell 7.2 or newer (`pwsh`), preview one
literal path relative to the run. This version can enumerate NTFS streams on
directories as well as files.

```powershell
$preview = ./clear-task-output.ps1 -RunRoot $taskRoot -Output 'ue56/pkg-1'
$preview
```

Check its resolved path, byte count and run identity against the run's
`RUN.md`. Supply the preview ID to apply this retirement:

```powershell
./clear-task-output.ps1 -RunRoot $taskRoot -Output 'ue56/pkg-1' -Apply $preview.PreviewId
```

Pass any still-recorded owner PIDs with `-OwnerProcessId`. The command checks
visible process paths and opens files exclusively while reading their hashes.
During apply it keeps each checked file locked until Windows marks that same
file handle for deletion. Windows also refuses removal of a directory if a new
child appears after the preview.
The coordinator also checks the run ledger for callers that use indirect paths.
Entries with named streams, links or read-only, hidden or system attributes
are left for review. If an output changes or a
removal is interrupted, inspect the remaining entries and generate a new preview.
Only runs created with the allocator's identity marker support this command.
The run record, retained fixtures, and Git worktrees have separate closeout steps.

For a packaging run, pass a fresh output leaf to the existing matrix command.
Keep subsequent attempts in this task, for example `pkg-2`. Put CLI trials or
private tool profiles under the same engine directory when they are needed.

```powershell
./test-plugin-build-matrix.ps1 -VersionsCsv '5.6' -OutputRoot (Join-Path $engineRun.FullName 'pkg-1')
```

For a multi-engine matrix invocation, use a single fresh child of `$taskRoot`;
the matrix already creates its per-engine layout. A retained stage manifest
records an absolute root. Keep runnable stages at that path until retired.
When archiving an inactive attempt, record its original and archive paths and
verify its contents after the move.

```powershell
node server/prepare-fixture-host.mjs --output-root $stage --validate
node server/prepare-fixture-host.mjs --output-root $stage --native --test-profile native-smoke --timeout-ms 900000
```

The `native-transport` profile selects the seven existing `UEMCP.Transport.*`
cases: ReceiveClassifier, ReceiveDeadlines, ReadOneRequestStopping,
RequestReadResultMapping, FixtureSchema, SharedFixtures, and DecoderBoundaries.
It requires their exact names once each and binds the raw hash of
`plugin/UEMCP/Resources/Tests/tcp-transport-cases.json` to the execution evidence.
After building the staged host, run:

```powershell
node server/prepare-fixture-host.mjs --output-root $stage --native --test-profile native-transport --timeout-ms 900000
```

These tests exercise native transport policy and decoder behavior under NullRHI.
SharedFixtures loads the staged plugin resource and checks 50 request cases,
270 decoder executions (including 25 legacy byte-at-a-time proofs). FixtureSchema also
checks malformed fixture controls. Missing resources, missing/duplicate test
results, skipped/NotRun cases, error-bearing Success records, or a nonzero editor
exit cannot qualify the required profile. Retain the report, execution evidence,
host manifest, lifecycle outcome, and scoped owned-process cleanup checks.
This does not qualify live socket/MCP sessions, renderer/UI behavior, all native
tests, or BuildPlugin packaging. The one-case `native-smoke` profile remains
available separately; neither profile replaces retained consumer coverage.

The `native-blueprint` profile runs 26 cases in one editor. Its three Blueprint
helper tests, 22 Blueprint handler tests and `UEMCP.GraphActions.AssetPlacement`
are listed in the [profile manifest](../server/fixtures/test-profiles.json).
It covers GUID wiring on a pawn Event Graph and retrying an asset-backed placement
through the native command registry. `PawnGraphGuidWiring` checks that the pawn's
edits stay in its private Undo history and its Blueprint is collected at teardown.
`PawnFixtureEarlyReturn` interrupts an edit with a missing graph and checks that
an unrelated edit can still be redone. To replay the profile, build a fresh owned stage and run

```powershell
node server/prepare-fixture-host.mjs --output-root $stage --native --test-profile native-blueprint --timeout-ms 900000
```

The helpers exercise native pin/default conversion. Handler cases dispatch through
`FMCPCommandRegistry` and inspect real in-memory graph mutations and compilation
outcomes under NullRHI. An expected compilation failure asserted by a successful
native test remains valid; an Automation Error event on a Success record fails
the required profile. Each listed full name must run exactly once, with fresh
source-bound evidence and a successful process exit.

The profile has no repository-owned saved fixture (`fixturePaths: []`). Asset
placement uses the editor installation's `Tutorial_Walk_Fwd` sequence and
`SkeletalCube_Skeleton` for its compatible and incompatible controls. The handlers create unsaved
packages under `/Game/__UEMCPTests/`; their teardown is best effort within a
disposable process, not a guarantee of complete object reclamation after every
early return. Use a fresh owned host/process, retain source and lifecycle checks,
and inspect the staged host for unexpected `.uasset` or sidecar saves after the
run. This profile qualifies native helper/registry/graph behavior only; it does
not qualify socket/MCP transport, persistence, PIE, rendering, or consumer projects.
Existing smoke, transport, and owned serialization profiles remain separate.

The `native-core` profile requires eight existing cases from `UEMCPTests.cpp`:
`MCPResponseBuilder.BuildError`, `TransformParser.Valid`, `TransformParser.Invalid`,
`ActorLookupHelper.Guards`, `PropertyHandlerRegistry.Scalars`,
`PropertyHandlerRegistry.Invalid`, `MCPCommandRegistry.Dispatch`, and
`MCPCommandRegistry.CustomRegister` (each prefixed `UEMCP.`).

```powershell
node server/prepare-fixture-host.mjs --output-root $stage --native --test-profile native-core --timeout-ms 900000
```

All eight full names must succeed exactly once, without labelled skips or Error
events, in a fresh report from a successful process. This profile uses no saved
assets (`fixturePaths: []`). Its actor case checks null-world guards, not populated
world lookup; the scalar case assigns int, float, bool and string values and only
checks NameProperty registration. CustomRegister leaves a transient registry entry,
so run in a fresh disposable owned process. BuildSuccess remains in native-smoke;
transport and Blueprint profiles remain separate. This does not qualify socket/MCP
transport, persistence, PIE, rendering, consumer projects or other native tests.
Native qualification requires a fresh build and run for each engine. Offline
validation is
`node server/test-native-core-profile.mjs`; its injected process reports are
controls for orchestration and must never be presented as native runtime proof.

Native execution delegates to `run-native-tests.mjs` and its process runner,
including conflict checks and bounded process-tree shutdown. The wrapper checks
the stage before and after execution and retains reports and lifecycle outcomes.
It never stops unrelated editors or removes retained outputs. A timeout, runner
failure, cleanup exception or changed source cannot become a passing outcome.

The canonical host uses an owned filesystem DDC graph (including safe default
graph fallbacks), disables DDC cleanup and Zen auto-launch, and does not reference
workstation or shared cache nodes. Native execution uses
`prepareOwnedHostRuntime` from the staging helper for common engine arguments,
fresh user/shader scratch and child-only TEMP/TMP overrides. Explicit author and
export commands must use the same returned `args` and `env`. These controls are
not an OS sandbox: Windows known-folder APIs remain outside the UserDir override.
Runtime isolation needs independent review and observed logs before qualification;
source/config checks alone cannot prove that every engine service is isolated.
Native host runs pass UE's `-nowrite` config flag to prevent editor startup from
creating or rewriting DefaultInput.ini in the immutable staged source.

Explicit author/export execution uses the `runOwnedAuthoring` API in
`server/run-owned-authoring.mjs`; it adds no CLI. Before launch it checks actual
staged runtime isolation independently of historical fixture provenance, matches
the requested engine root and Build.version to the stage, and refuses conflicting
editors. The isolation check pins the reviewed complete
DefaultEngine.ini policy by SHA-256 (normalizing only CRLF to LF), including both
fallback graphs and disabled Zen. Changing that policy requires reviewing and
updating the pinned digest. Generated host or plugin Saved/Config overrides are
refused. Historical `verifyAuthoringHost` remains a provenance check, not launch
authorization; an old valid fixture can come from a stage that is unsafe to run.

The API uses the shared runtime arguments/environment and bounded process runner.
It validates current checkout and staged sources after success, nonzero exit,
timeout, or runner exception, retaining both execution and validation failures.
Only the single intended authored asset may be added; failed authoring may leave
it absent or partial. Export requires that asset, preserves its hash, and refuses
a preexisting oracle output. Failed output is retained for inspection. These
source checks do not claim absolute filesystem confinement. Author/export runtime
qualification remains held until independent review clears controlled validation.

These fixed `-run=AuthorSerializationFixture` and `-run=DumpBPGraph` commandlets
disable the UEMCP TCP server and use NullRHI, so their preflight does not reserve
TCP 55558. Native/live execution retains its existing port checks. Positively
identified unrelated editor projects may continue running, including editors
using shared installed-engine binaries. Inspection remains strict: unknown or
inaccessible project identities, overlapping project/source/output paths,
junction targets, plugin directories, or runtime redirects block launch. The
bounded filesystem inspection reads directory identities and project descriptors,
not asset contents; exhausting its budget fails closed.
The 10,000-directory budget counts unique canonical directories per editor;
repeated aliases and cycles do not consume extra entries. Explicit redirects are
checked before crawling. Returned diagnostics (also attached to rejected checks)
contain only counts of unique directories, repeated aliases, reparses and distinct
external targets, plus a fixed category and reason. Large unrelated projects can
still exceed the bound; diagnostics do not authorize skipping directories.

An atomic per-stage `.owned-authoring.lock` covers preflight, execution, source
validation and retained evidence. Sequential author then export is supported;
concurrent callers cannot use the same stage. Only the matching invocation token
can release the lock. Stale or changed locks are retained for manual inspection,
never automatically stolen or recursively removed. Timeout cleanup remains scoped
to the bounded runner's child process tree, not every Unreal process. Controlled
runtime qualification must inspect its owned child identity and descendants;
unrelated editor survival is expected, not a cleanup failure.

`server/fixtures/host-source-files.json` is the independently maintained complete
input list. Source additions/deletions require reviewing this list. Staging
checks exact membership, case collisions and symlink/junction aliases, and hashes
raw bytes (including resources). The manifest binds the Git HEAD, dirty patch and
file identities from `execution-manifest.mjs`, plus exact engine Build.version.
Any checkout edit invalidates a retained stage for qualifying execution; restage
after work is frozen. Generated Binaries/Intermediate/Saved/DerivedDataCache/.vs
directories may be present after a build at the host or plugin root; all staged
source membership and bytes remain checked. Generated build outputs are not
claimed to be source artifacts.

To request the initial verified owned corpus when staging, add
`--fixture-version ue5.6-owned-v1`. Legacy authoring is currently blocked;
the planned UE 5.3 corpus is not available for staging or qualification.
The canonical serialization verifier must pass before any copy occurs. Only its
bounded owned asset is copied into Content; the manifest, oracle and saved bytes
are all bound in the host manifest and reverified before and after execution.
Versions share an asset destination and cannot be combined. Arbitrary asset paths
are not accepted. The default stage remains source-only.

Retain failed outputs for inspection. This helper deliberately provides no
recursive cleanup command. The initial host carries no serialized content;
owned authoring remains a separate explicit step.
Manual inspection of a retained host does not count as automated test evidence.

The initial execution profiles are deliberately bounded. From `server`, run
`node run-rotation.mjs --test-profile node-foundation --json` for ten reporting
witnesses or `node run-rotation.mjs --test-profile owned-serialization --json`
for four mandatory modern corpus checks. The native smoke profile requires
exactly `UEMCP.MCPResponseBuilder.BuildSuccess`. Existing default rotation
discovery, synthetic legacy tests and consumer compatibility tests are retained.
These profiles do not qualify the full native, live, rendered or engine matrix.
Capability labels describe requirements; they are not proof of a rendered run.

Required evidence records exact suite/case names, profile digest, fixture hashes,
Git HEAD, raw source file hashes and any dirty patch. Missing, duplicate, skipped
or unsuccessful required cases fail. Native Success records with error events,
missing full test paths or unsuccessful process exits also fail. Required native
runs retain failure evidence and refuse unavailable process inspection, conflicting
editors and an occupied TCP port. The port check is a preflight, not a reservation;
serialize native host runs on a machine. Verify owned-process absence after a
timeout before reusing the machine: the existing process runner's timeout return
alone is not proof that every descendant has terminated.

No CI workflow, required-check policy or runner provisioning changes are part of
this foundation. The new portable test files are discovered by the existing
rotation. UE 5.3 host qualification is blocked by existing plugin calls to
`IDetailsView::ScrollPropertyIntoView`, unavailable in that engine; no legacy
binary was fabricated or substituted with a modern save.

## Owned component edit coverage

`node run-rotation.mjs --test-profile owned-live-edit-offline --json` checks
15 offline routing, native registration and synthetic evidence-gate witnesses.
It does not run Unreal. Existing profiles and coverage remain unchanged.

The separate `native-owned-component-edit` profile requires exactly:

- `UEMCP.OwnedComponentEdit.LiveValuesAndErrors`
- `UEMCP.OwnedComponentEdit.ExternalTransactionUndoRedo`
- `UEMCP.OwnedComponentEdit.RejectedEditPreservesPriorUndo`

Each case creates a unique unsaved Actor Blueprint under `/Game/__UEMCPTests/`
with an `OwnedScene` component template, dispatches the real registry command,
and reads the live template again. Error coverage checks missing fields, missing
component/property, short vectors and wrong vector JSON type against prior state.
The fixture is unregistered and released on scope exit, without saving a package.
A private scoped transactor preserves the editor's previous undo/redo history;
only the private buffer is reset. Tests refuse an already active transaction.

Undo/redo is explicitly an **external test transaction** guarantee for component
edits. The component handler calls template `Modify()` but opens no transaction;
the variable-default handler calls CDO `Modify()` but opens no transaction;
`set_blueprint_property` has neither an explicit CDO `Modify()` nor an owned
transaction. The latter two are routing-only in this slice. Rejection preservation
means rejection outside a transaction leaves a prior valid external edit undoable.
Rejection within an external transaction, mixed-type vector elements, persistence,
CDO undo, transport integration, PIE and rendering remain unqualified.

After a coordinator stages and builds the exact source in an isolated fixture host,
run from the repository root through the source-validating host wrapper:

```text
node server/prepare-fixture-host.mjs --output-root <fresh-owned-stage> --validate
node server/prepare-fixture-host.mjs --output-root <fresh-owned-stage> --native --test-profile native-owned-component-edit --timeout-ms 900000
```

The wrapper supplies the owned runtime/DDC configuration and delegates to
`run-native-tests.mjs`; do not bypass those staging and lifecycle checks.

All three full paths must succeed with zero errors and a successful process exit.
Retain the source identity, build evidence and exported native report together.
Offline success or C++ source registration alone is not native execution evidence.

## Recovered worktree regressions

The `native-worktree-regressions` profile requires exactly
`UEMCP.BlueprintHandlers.CreateBlueprintParents` and
`UEMCP.Capture.PieViewportOpaquePixels`. Use the same owned-host staging, build
and native invocation above with this profile name. It checks parent class
identity/refusals through the real handler and alpha-only pixel normalization.
It does not prove a rendered PIE screenshot or consumer-project deployment.

On 2026-11-07 the UE 5.8.3 Win64 owned host compiled successfully; both focused
cases and all 15 native-blueprint cases passed. The first attempted focused run
was refused by port preflight while the Node rotation was active; the serial
rerun passed. Keep port-using Node suites and native execution sequential.

## Request key identity and pawn teardown qualification (2026-11-22)

| Installed engine (Win64) | Blueprint and transport native tests | Live framed and legacy request checks |
| --- | --- | --- |
| UE 5.3.2 CL29314046 | 33/33 | 18/18 |
| UE 5.6.1 CL44394996 | 33/33 | 18/18 |
| UE 5.8.4 CL58902052 | 33/33 | 18/18 |

All three engines previously collapsed distinct sibling names such as `Ax` and
`ax`. The live client received an actionable `MALFORMED_REQUEST` for those
names and for an embedded NUL in a member name. The next corrected request
succeeded. Exact duplicates retain their last value. Separate objects can use
different spellings. The raw and Unicode-escaped pair `Äx` and `äx` remained
distinct on all three engines. [Request contract](specs/architecture.md)

On UE 5.3.2 the old pawn wiring test added four entries to the editor Undo queue
and left the source node referenced. The new tests verified private transaction
ownership, Blueprint collection on success and early return, and preservation
of an unrelated redo. Five fresh content-only editor processes each passed the
original nine-case suite using the same verified project-built plugin DLL.
The earlier packaged crash's exact UObject remains unidentified. The retained
minidump lacks full process memory and the matching engine debug symbols were
unavailable. A new UAT package was outside this replay.

Codex CLI 0.171.0 also edited one owned Actor Blueprint on
UE 5.3.2. It corrected the imported pin name before sending it and recovered
from an editor identity refusal. A fresh editor found exactly one new integer
addition node with input defaults 4 and 7. Only the requested package changed.
The wire checks exercised the key refusal directly. UE 5.7, other providers
and human sessions were unexercised in this pass.
