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
