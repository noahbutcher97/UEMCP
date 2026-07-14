# TCP Receive And Intake Hardening Verification

Date: 2026-07-14

Audience: Internal verification. Machine-local package paths are retained because the approved acceptance gate requires exact provenance. The selected project/editor/log identifiers are redacted by the repository NDA gate; their exact values remain in the ignored local Task 9 report. Sanitize the remaining machine paths before unrestricted publication.

## Scope And Commits

- Repository: `D:\DevTools\UEMCP`
- Worktree: `D:\DevTools\UEMCP\.worktrees\anim-graph-pin-serialization`
- Branch: `anim-graph-pin-serialization`
- Selected project: `<SELECTED_PROJECT_ROOT>\<PROJECT_NAME>.uproject` (NDA-redacted)
- Live AnimBlueprint: `/Game/Actors/Character/ABP_DroppedCharacter`
- Approved TCP design/plan commits: `4cc2ddb` through `93eb842`
- Implementation and hardening commits: `b425247` through `13ca30e`
- Latest plugin-source commit: `3d8e77b`
- Final live-fixture review fixes: `e62df39` and `13ca30e`
- Final adversarial re-review: no Critical, Important, or Minor findings; explicit `Ready to merge: Yes` verdict.

Before publication, one NDA-sensitive editor-target name was removed from the unpublished `85fe0e3` commit message. Its descendants were replayed without conflicts, and the pre/post-rewrite tip trees were byte-identical. Commit identifiers in this report are the sanitized post-rewrite identifiers.

This report covers the TCP receive/intake work only. Earlier AnimGraph topology commits on the same branch are outside this acceptance record except where the AnimGraph full-read response is used as the large live response fixture.

## Node Rotation

Commands from `server\`:

```powershell
node test-tcp-transport.mjs
npm test
npm run lint
```

- Focused transport suite: exit `0`, `2254 passed / 0 failed / 2254 total`.
- Full rotation: exit `0`, `60` files, `5183 passed / 0 failed / 5183 total`.
- Full-rotation skips: `4`, all documented environment/live-gated skips with no contributing assertions.
- ESLint: exit `0`.
- `git diff --check`: exit `0` at `13ca30e` before adding this evidence artifact.
- Mutation proof: temporarily removing the production `await` from the post-final-byte timer turn produced exit `4`, `2250 passed / 4 failed / 2254 total`. The four failures covered reset-before-turn-settlement, loss of the post-final-byte observation window, failure to reject data in that window, and incorrect final settlement. Restoring the `await` returned the focused suite to `2254/2254`.

## C++ Automation

The selected target was synced and built with the editor closed:

```powershell
sync-plugin.bat "$uproject" -y
& "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" $editorTarget Win64 Development "-Project=$uproject" -WaitMutex -NoHotReload
```

- Selected editor-target build: exit `0`, `Succeeded`; `UnrealEditor-UEMCP.dll` was linked.

Focused native automation command:

```powershell
& "C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "$uproject" '-ExecCmds=Automation RunTests UEMCP.Transport.;Quit' -unattended -nop4 -NoSourceControl -nosplash -NullRHI -NoSound '-ddc=InstalledNoZenLocalFallback' -stdout -log
```

- Exit `0`; `7` tests found and `7` succeeded.
- Passed groups: `DecoderBoundaries`, `FixtureSchema`, `ReadOneRequestStopping`, `ReceiveClassifier`, `ReceiveDeadlines`, `RequestReadResultMapping`, and `SharedFixtures`.
- The project emitted unrelated invalid-Perforce-workspace initialization diagnostics despite `-nop4 -NoSourceControl`; no source-control action occurred and the selected automation completed.

D57 commandlet gate:

- `test-uemcp-gate.bat` wrapper: exit `0`, `PASS`.
- Required line observed: `UEMCP: commandlet detected - TCP server suppressed (D57 gate)`.
- The underlying `NullCommandlet` exited `1`; the wrapper correctly evaluated the suppression gate rather than treating the commandlet's unrelated exit as a TCP-listener failure.
- The wrapper reported a port warning caused by a `TIME_WAIT` entry, not an active listener. No commandlet-owned listener was created.

## UE 5.3/5.6/5.7 Win64 BuildPlugin

All final package runs used the repository `test-plugin-build-matrix.ps1` flow, which stages a retained source copy under an invocation-owned output root and calls stock `RunUAT.bat BuildPlugin -TargetPlatforms=Win64 -Rocket`.

| Engine | Final package | Exit | Result |
| --- | --- | ---: | --- |
| UE 5.3 | `C:\Users\posne\AppData\Local\Temp\UEMCP-BuildPlugin-Matrix-UE53-20260714-105302\UE-5.3` | `0` | `BUILD SUCCESSFUL` |
| UE 5.6 | `C:\Users\posne\AppData\Local\Temp\UEMCP-Matrix-ParityFinal-20260714-095914\UE-5.6` | `0` | `BUILD SUCCESSFUL` |
| UE 5.7 | `C:\Users\posne\AppData\Local\Temp\UEMCP-Matrix-ParityFinal-20260714-095914\UE-5.7` | `0` | `BUILD SUCCESSFUL` |

The first UE 5.3 stock attempt failed during generated HostProject UHT discovery before UEMCP compiled. The installed `SolusComboSystem_5.3` and `ComboGraph_5.3` marketplace plugins expose colliding `ComboGraphSchema.h` and `ComboGraph.h` basenames. For the final UE 5.3 UEMCP baseline, all UE 5.3 processes were closed, the exact `SolusComboSystem_5.3` directory was temporarily held with native PowerShell `Move-Item`, and restoration ran in `finally`. Post-run checks confirmed the plugin was restored at its exact source path, the hold root was removed, no UE 5.3 editor remained, and ports `55558`/`30010` had no listener.

Between those runs, an isolated UE 5.3 UBT compile bypassed the unrelated HostProject inventory collision and reached UEMCP source. It exposed cross-version API differences that were fixed in `85fe0e3`: transition `bDisabled` became an optional reflected property, `MaterialDomain.h` was included explicitly, and non-shrinking `TArray::Pop` uses `false` before UE 5.4 and `EAllowShrinking::No` afterward. The isolated UE 5.3 compile then passed before the final BuildPlugin package run.

This UE 5.3 result proves UEMCP Win64 compile/package against UE 5.3 after isolating an unrelated installed-plugin collision. It does not claim that the unchanged local marketplace-plugin inventory packages successfully as a whole.

## Fixture Packaging

The repository fixture, deployed selected-target fixture, and all three packaged fixtures are each `11838` bytes with SHA-256:

`A0125D929774AC5A08BDFD24C15AA715116B189049148B0A1ECFEDAA55BEBFD4`

The repository, deployed, and all three packaged `MCPServerTransportPolicy.cpp` files are each `30110` bytes with SHA-256:

`8D6F3ABEC84AB2DBE13FB8538199FB1203E635D2B9CFD528771D6A1B519435B9`

Every package contains `Resources\Tests\tcp-transport-cases.json`. The retained staged source and packaged output are under their caller-owned temporary roots; the matrix helper does not recursively delete them.

## Selected Target Deploy

Final selected-target commands ran with no Unreal Editor process:

```powershell
sync-plugin.bat "$uproject" -y
verify-deploy.bat --targets <one-target-temp-file> --no-pause
```

- Sync result: success; version match `manifest=1.0.17`, `uplugin=18`, `versionName=1.0.17`.
- The live-tested deployed content maps after the message-only rewrite to live-fixture commit `e62df39` and plugin-source commit `3d8e77b`. The selected-target marker was refreshed without changing plugin source bytes; refreshed source mtimes required a new editor-target build, after which isolated deployment verification returned `SYNC`/`ALL-SYNC`.
- Verification scope: exactly one selected target; the temporary target file was removed.
- Source comparison: repository and deployed plugin source each contain `78` files with no content diff.
- Verdict: `SYNC - DLL >= deployed source >= repo source` and `ALL-SYNC - 1 target(s) match repo source`.
- Deployed `UEMCP.uplugin`: `990` bytes, SHA-256 `A2D25A32B39F9DF4E8859A6ED6CC211FA69EADCB11D1858D091C236E4C6F70CE`.
- Deployed `UnrealEditor-UEMCP.dll`: `1469952` bytes, SHA-256 `31F46F137EDDC82196E972154797BE7128D751C799DE399D39AD9E69D6E1F85F`.
- The rebuilt DLL timestamp was `156` seconds newer than repository/deployed source. Editor active: `NO`.

## Live Fault Matrix

The selected UE 5.6 editor was launched hidden as the sole owner of `127.0.0.1:55558`. The direct transport smoke passed `15/15`; the aggregate `run-live-smoke.mjs` run passed `5/5`, with zero skips and zero failures. The editor then returned success for `execute_console_command` with `QUIT_EDITOR`, exited, and left no listener on `55558` or `30010`.

| Probe | Expected result | Observed |
| --- | --- | --- |
| 01 framed ping | success response | pass |
| 02 legacy ping | success response | pass |
| 03 empty close | no response/event | pass |
| 04 partial framed close | one partial-close event | pass |
| 05 partial reset | one socket-error event | pass |
| 06 empty close after reset | no response/event | pass |
| 07 ping after reset | success response | pass |
| 08 invalid JSON sentinel | `MALFORMED_REQUEST` | pass |
| 09 invalid UTF-8 | `MALFORMED_REQUEST` | pass |
| 10 duplicate content length | `MALFORMED_REQUEST` | pass |
| 11 oversized declaration | `REQUEST_TOO_LARGE` | pass |
| 12 idle timeout | `REQUEST_TIMEOUT` | pass |
| 13 total timeout trickle | `REQUEST_TIMEOUT` | pass |
| 14 AnimGraph response reset | one send-failure event, no response | pass |
| 15 recovery ping | success response | pass |

The clean transport window contained exactly:

- `tcp_peer_closed_partial=1`
- `tcp_intake_socket_error=1`
- `tcp_intake_malformed=3`
- `tcp_intake_too_large=1`
- `tcp_intake_idle_timeout=1`
- `tcp_intake_total_timeout=1`
- `tcp_send_failure=1`

Probe 14 observed `request_bytes=232`, `response_bytes=0`, and one payload-free event with `bytesSent=0`, `totalBytes=1211171`, `reason=send_error`, `socketError=SE_ECONNRESET`, and `socketCode=26`. Probe 15 succeeded immediately afterward.

The first live probe-14 design reset after Node received the first response chunk. Windows kernel buffering had already accepted the complete `1211171`-byte response before that callback, so no server send failure remained to observe. The corrected fixture holds the final request byte after the prefix settle, sends it, awaits the next timer turn, and resets. Offline deferred-scheduler tests prove that exact ordering, pre-reset data rejection, timeout cleanup, and single settlement.

## AnimGraph Baseline

The full-read request for `/Game/Actors/Character/ABP_DroppedCharacter` enabled all four topology/default-value flags and returned complete topology under the unchanged caller timeout:

- `graph_count=70`
- `state_machine_count=8`
- `slot_node_count=1`
- `layered_blend_node_count=3`
- `topology_graph_count=70`
- `node_count=439`
- `pin_count=1012`
- `edge_count=346`
- Serialized response: `1211142` UTF-8 bytes
- Wall time: `104.9 ms`

The live readback reports counts, serialized bytes, and timing only; it does not print the response body.

## Fresh Log Segment

Dedicated transport window in `<SELECTED_PROJECT_ROOT>\Saved\Logs\<PROJECT_NAME>.log`:

- UTC: `2026-07-14T15:32:14.5393659Z` through `2026-07-14T15:32:34.2718035Z`
- Byte offsets: `2130879` through `2132895`
- Appended bytes: `2016`
- Strict UTF-8 decode: pass
- Exact event vector: `1/1/3/1/1/1/1` in the order listed under Live Fault Matrix
- Secret-sentinel and raw request/response/body preview checks: pass
- Tokenless/duplicate transport warning checks: pass
- `Fatal error`, `Assertion failed`, `Ensure condition failed`, `Unhandled Exception`, and `Critical error`: all `0`

The full five-script aggregate window (`197598..2128206`, `1930608` bytes) passed `5/5` but also captured one handled selected-project ensure before the TCP smoke: `APCM_OSBase::BeginPlay` found a null `PCOwner` at `PCM_OSBase.cpp:59` during PIE startup. It is not a UEMCP transport event and did not occur in the dedicated transport segment. It is preserved below as a project/harness follow-on rather than being hidden by a second-run one-shot ensure suppression.

## Platform Boundary

- Runtime, BuildPlugin, project build, native automation, and live fault evidence were executed on Windows/Win64 only.
- UE 5.3, 5.6, and 5.7 Win64 compile/package passed within the UE 5.3 installed-plugin caveat above.
- Mac and Linux compile/runtime were not executed. Source guards and offline tests cover guarded Unix/Mac error capture, but that is not runtime proof.
- The final-byte timer schedule is an observed verified-Windows-loopback fixture. It is not a platform-independent TCP scheduling guarantee.
- Unreal retains one authoritative `FJsonSerializer::Deserialize` call for parser-eligible completed candidates. A bounded lexical compatibility guard rejects documented forms Unreal accepts but Node rejects; it is not a second handwritten JSON parser.

## Residual Follow-Ons

- Run the same compile/runtime fault matrix on Mac and Linux before claiming cross-platform parity.
- Repair or explicitly waive the selected project's `APCM_OSBase::BeginPlay` null-`PCOwner` ensure, and consider a generic aggregate live-smoke log gate so project-level fatal/assert/ensure output cannot pass silently.
- Distinguish active listeners from `TIME_WAIT` entries in `test-uemcp-gate.bat` diagnostics so a passing D57 gate does not emit a misleading port warning.
- Use a clean UE 5.3 installation or isolate unrelated marketplace plugins in a dedicated engine baseline to remove the local `SolusComboSystem_5.3`/`ComboGraph_5.3` collision from future package runs.
- Add connection identifiers or structured transport metrics if future concurrent dispatch makes per-connection log correlation necessary; concurrency itself remains outside this slice.
- Collect response-size telemetry before adding a data-backed cap, and consider streaming only if large topology or visual-capture responses outgrow the current send-all model.
- The generic headless MCP execution layer remains a separately scoped follow-on. This work hardens transport intake and commandlet suppression; it does not add full editor/headless command parity.
