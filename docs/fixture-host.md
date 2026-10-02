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
