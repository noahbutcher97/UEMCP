# Local owned fixture host

`server/fixtures/uemcp-fixture` is the canonical source-only host. Its Runtime
module supports the retained Game target and the Editor target. UEMCP is enabled
explicitly; its descriptor declares required engine plugin dependencies.

From the repository root, stage into a new, absent directory whose parent exists:

```powershell
node server/prepare-fixture-host.mjs --output-root ../host-run-001 --engine-root 'C:/Program Files/Epic Games/UE_5.6'
```

The project is `../host-run-001/host/UEMCPFixture.uproject`. Build its
`UEMCPFixtureEditor Win64 Development` target with the selected engine's existing
`Engine/Build/BatchFiles/Build.bat`, using a bounded process runner. No build or
editor starts during staging. Do not use a live consumer project.

```powershell
node server/prepare-fixture-host.mjs --output-root ../host-run-001 --validate
node server/prepare-fixture-host.mjs --output-root ../host-run-001 --native --test-profile native-smoke --timeout-ms 900000
```

The `native-transport` profile selects the seven existing `UEMCP.Transport.*`
cases: ReceiveClassifier, ReceiveDeadlines, ReadOneRequestStopping,
RequestReadResultMapping, FixtureSchema, SharedFixtures, and DecoderBoundaries.
It requires their exact names once each and binds the raw hash of
`plugin/UEMCP/Resources/Tests/tcp-transport-cases.json` to the execution evidence.
After building the staged host, run:

```powershell
node server/prepare-fixture-host.mjs --output-root ../host-run-001 --native --test-profile native-transport --timeout-ms 900000
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
