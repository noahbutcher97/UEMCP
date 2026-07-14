# Final Review TCP Fix Report

## Status

Implemented the two final whole-branch review corrections on `anim-graph-pin-serialization`.

Production and test commit: `6e23cca3cca087416c6705c8d4d26170dc00c613`

## Finding 1: Authoritative JSON Parse

### Root Cause

`FMCPRequestDecoder::FImpl::FinalizeBody` performed `FJsonSerializer::Deserialize` and then passed the same bytes through `ValidateStrictJsonDocument`. `JsonParseCount` recorded only the Unreal call, so it reported one parse while a second handwritten JSON grammar implementation still executed.

### Correction

- Removed `ValidateStrictJsonDocument` and its strict JSON state, frame, string, literal, number, and value helpers.
- Kept strict UTF-8/BOM validation, `ValidateObjectBoundary`, and iterative `HasNonFiniteJsonNumber` validation.
- `FinalizeBody` now makes one authoritative `FJsonSerializer::Deserialize` call, rejects a failed parse or non-finite DOM value as `invalid_json`, and rejects a non-object parsed root as `root_not_object`.
- Added a Node source-contract guard requiring exactly one finalization deserialize and no retired handwritten-parser symbols.

### Platform-Parser Behavior Change

Removed the broad C++ `rejects complete non-RFC JSON` assertions. Those cases required the retired handwritten grammar to reject values that Unreal's parser may intentionally accept, including case variants of literals. The narrowed C++ coverage retains `NaN` and numeric-overflow inputs so parsed non-finite DOM numbers remain `invalid_json`; other grammar acceptance is delegated to the authoritative Unreal parser as required by the approved design.

## Finding 2: macOS POSIX Error Capture

### Root Cause

The `<cerrno>` include and errno-wrapping `Recv` branch were guarded only by `PLATFORM_UNIX`. Since `PLATFORM_MAC` is separate, macOS reached the generic `SE_SYSTEM` fallback instead of clearing and immediately capturing native errno.

### Correction

- Extended both guards to `PLATFORM_UNIX || PLATFORM_MAC`.
- Kept the Windows `WSASetLastError`/`WSAGetLastError` path unchanged.
- Added source-contract guards proving the Mac-inclusive POSIX branch clears errno, calls `Recv` once, captures errno, and leaves the generic fallback free of errno handling.

## Files Changed

- `plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.cpp`
- `plugin/UEMCP/Source/UEMCP/Private/Tests/MCPServerTransportPolicyTests.cpp`
- `server/test-tcp-transport.mjs`
- `.superpowers/sdd/final-review-tcp-fix-report.md`

## RED Evidence

Command, from `server/`, before production edits:

```powershell
node test-tcp-transport.mjs
```

Exit code: `1`

Observed expected source-contract failures:

- `source guard: native receive error capture has guarded Windows and Unix/Mac includes`
- `source guard: Unix and Mac share errno capture without generic fallback`
- `source guard: native error clear, receive, and capture ordering is explicit`
- `source guard: finalization has one authoritative Unreal parse and no handwritten JSON grammar`

Summary: `2063 passed / 4 failed / 2067 total`.

## GREEN Evidence

Focused source-contract command, from `server/`:

```powershell
node test-tcp-transport.mjs
```

Exit code: `0`; `2067 passed / 0 failed / 2067 total`.

Full Node rotation, from `server/`:

```powershell
npm test
```

Exit code: `0`; `60` files, `4996 passed / 0 failed / 4996 total`; `4` documented environment/live-gated skips.

Isolated UE 5.6 Win64 package build:

```powershell
& "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\RunUAT.bat" BuildPlugin "-Plugin=<temporary source copy>\UEMCP.uplugin" "-Package=<temporary package>" -TargetPlatforms=Win64 -Rocket
```

Exit code: `0`; `BUILD SUCCESSFUL`. The build compiled `MCPServerTransportPolicy.cpp` and `MCPServerTransportPolicyTests.cpp`. Evidence root: `C:\Users\posne\AppData\Local\Temp\UEMCP-final-review-tcp-20260714-082000`.

## Unresolved Concerns

- Focused C++ automation was not run against a synced/rebuilt target; the controller owns target deployment and any editor-backed automation lane.
- Mac and Linux compile/runtime verification was not run. The Mac source path is guarded by the focused source contract and the Win64 build only verifies the Windows compilation path.

## Follow-up: Deployed C++ Root Classification Regression

### Root Cause

The one-parser correction exposed two Unreal JSON reader behaviors that the retired handwritten grammar had hidden:

- Unreal accepts `{"x":}` as an empty object.
- The generic `FJsonSerializer::Deserialize` overload cannot materialize a scalar root, so it reports a parse failure for a valid scalar such as `1`.

The prior finalization logic therefore accepted the first payload and labeled the second `invalid_json`.

### Correction

- Replaced the shared and focused invalid-object payload with Unreal-rejected `{"x":tru}` (nine bytes).
- After strict UTF-8/BOM and boundary handling, finalization identifies only object/array starts versus scalar candidates from the first RFC-whitespace-skipped byte.
- Object and array candidates are parsed unchanged. Scalar candidates are wrapped as `[<exact BOM-stripped JsonText>]` for the one authoritative Unreal parse. A successfully parsed one-element array is `root_not_object`; malformed scalar-like text stays `invalid_json`.
- Empty/whitespace-only input remains `invalid_json` before parsing. Non-finite DOM values remain `invalid_json`.
- Added focused framed C++ coverage for valid scalar `1` as `root_not_object` and malformed scalar-like `tru` as `invalid_json`, each with one parse. The Node source guard requires one deserialize, the scalar wrapper, and scalar classification only after that call.

Follow-up production and fixture commit: `d6797dee4f44dfe9fc458f4a78f0fefd9fb5b369`

### RED Evidence

The independent deployed command was valid RED evidence before this production correction:

```powershell
UnrealEditor-Cmd.exe <selected .uproject> "-ExecCmds=Automation RunTests UEMCP.Transport.;Quit" ...
```

Found `7` tests; `5` passed and `2` failed.

- `DecoderBoundaries`: framed `Content-Length: 6` body `{"x":}` completed instead of `invalid_json`; framed scalar `1` was `invalid_json` instead of `root_not_object`.
- `SharedFixtures`: `json-invalid-object` (`{"x":}`) completed instead of `invalid_json` in both plans.

After adding the focused regressions and source contract, the pre-fix local Node command also failed as expected:

```powershell
node test-tcp-transport.mjs
```

Exit code: `1`; `2065 passed / 2 failed / 2067 total`. The failures were the stale six-byte invalid-object expectation and the missing scalar-wrapper finalization contract.

### GREEN Evidence

Focused Node suite:

```powershell
node test-tcp-transport.mjs
```

Exit code: `0`; `2067 passed / 0 failed / 2067 total`.

Selected-target deployment and build:

```powershell
.\sync-plugin.bat "<selected .uproject>" -y
& "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" <selected editor target> Win64 Development "-Project=<selected .uproject>" -WaitMutex -NoHotReload
```

Both exit code `0`; the selected editor target rebuilt `UnrealEditor-UEMCP.dll`. The unrelated UE 5.3 editor was left running and untouched.

Focused deployed automation:

```powershell
& "C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "<selected .uproject>" '-ExecCmds=Automation RunTests UEMCP.Transport.;Quit' -unattended -nop4 -NoSourceControl -nosplash -NullRHI -NoSound '-ddc=InstalledNoZenLocalFallback' -stdout -log
```

Exit code: `0`; found `7` tests; `7 passed / 0 failed`.

Full Node rotation:

```powershell
npm test
```

Exit code: `0`; `60` files, `4996 passed / 0 failed / 4996 total`; `4` documented environment/live-gated skips.

### Follow-up Concerns

- The commandlet emitted unrelated existing invalid-workspace source-control diagnostics despite `-nop4 -NoSourceControl`; all seven selected tests completed successfully.
- Mac and Linux compile/runtime verification remains unrun.
