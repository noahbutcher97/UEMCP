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

## Follow-up: Bounded JSON.parse Compatibility Guard

### Scope and Source Audit

The deployed reader accepts several inputs that Node `JSON.parse` rejects. The corrective policy remains one authoritative Unreal parse per complete parser-eligible candidate; it adds no DOM parser, grammar parser, second deserialize, or error-string matching.

- Installed 5.3, 5.6, and 5.7 `FJsonSerializer` exposes only `None` and `StoreNumbersAsStrings`; there is no reusable strict-mode flag.
- Their installed `JsonReader` sources share the permissive paths: raw C0 bytes append inside `ParseStringToken`, literal handling accepts case variants, `ReadNextObjectValue` accepts a close after a colon, and `ReadNextArrayValue` accepts a close after a comma.
- The 5.3 installation has no RapidJSON source; 5.6 and 5.7 do. Switching parser implementations would therefore be nonportable and would require vendoring, which is outside this correction.
- The installed number FSM and RFC whitespace handling are otherwise strict. The existing non-finite DOM rejection remains in place. Uppercase `E` remains valid in number exponents and is explicitly covered.

### Correction

- Added `HasNodeJsonCompatibilityViolation`, a bounded byte-level scan that tracks only string escaping and the previous significant punctuation byte.
- It marks as incompatible only raw U+0000 through U+001F inside an unescaped string, case-variant literal letters outside strings (while preserving numeric `E` exponents), a close immediately after an object-value colon, and a comma immediately before either closer.
- The scan result is retained until after the single `FJsonSerializer::Deserialize` and truthful `JsonParseCount` increment. It then contributes to `invalid_json`; the platform parser still decides normal JSON validity and materializes the DOM.
- Added C++ and Node regressions for every raw and escaped C0 byte, missing object value, capitalized `true`/`false`/`null`, object and array trailing commas, and valid `1E3`. The Node source contract still requires exactly one deserialize and one counter increment, and rejects the retired handwritten-parser symbols.

Production and test commit: `95d54bd2e7ea92db49f821d88c51fd0bef824390`

### RED Evidence

The first compiled reproduction was intentionally run on the older 5.6 project path. It is non-gating evidence only; it had the temporary test source deployed before the approved target was selected.

```powershell
UnrealEditor-Cmd.exe <older non-gating .uproject> '-ExecCmds=Automation RunTests UEMCP.Transport.DecoderBoundaries;Quit' ...
```

Exit code: `-1`; the one decoder test failed. All 64 raw C0-in-string assertions (U+0000 through U+001F in both legacy and framed bodies) completed instead of `invalid_json`. `{"x":}`, capitalized `True`/`False`/`Null`, and `{"x":[1,]}` also completed. Their exact-one-parse assertions did not fail. `{"x":1,}` was already rejected by the platform parser, but remains covered by the bounded guard.

The first approved-target full run after adding the guard also produced useful RED evidence:

```powershell
UnrealEditor-Cmd.exe <approved .uproject> '-ExecCmds=Automation RunTests UEMCP.Transport.;Quit' ...
```

Exit code: `-1`; valid escaped/nested string fixtures and exact-limit object fixtures became `invalid_json`. The scan had retained the preceding colon after a string value. The correction records the closing quote as the previous significant token; the deployed regression run below confirms the fix.

### GREEN Evidence

Focused Node source and decoder suite:

```powershell
node server/test-tcp-transport.mjs
```

Exit code: `0`; `2139 passed / 0 failed / 2139 total`.

Approved-target deployment and build:

```powershell
.\sync-plugin.bat "<approved .uproject>" -y
& "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" <approved editor target> Win64 Development "-Project=<approved .uproject>" -WaitMutex -NoHotReload
```

Exit code: `0`; `UnrealEditor-UEMCP.dll` rebuilt successfully. The unrelated 5.3 editor remained running and untouched.

Approved-target deployed automation:

```powershell
& "C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "<approved .uproject>" '-ExecCmds=Automation RunTests UEMCP.Transport.;Quit' -unattended -nop4 -NoSourceControl -nosplash -NullRHI -NoSound '-ddc=InstalledNoZenLocalFallback' -stdout -log
```

Exit code: `0`; found `7` tests; `7 passed / 0 failed`.

Full Node rotation:

```powershell
npm test
```

Exit code: `0`; `60` files, `5068 passed / 0 failed / 5068 total`; `4` documented environment/live-gated skips.

### Residual Concerns

- The guard deliberately covers the installed cross-version extension set established by the audit, not general JSON grammar. A future engine reader extension needs a new differential reproduction and bounded guard amendment before treating Node parity as complete.
- The commandlet emitted unrelated invalid-workspace source-control diagnostics despite `-nop4 -NoSourceControl`; all seven transport tests completed successfully.
- Mac and Linux compile/runtime verification remains unrun.

Full Node rotation:

```powershell
npm test
```

Exit code: `0`; `60` files, `4996 passed / 0 failed / 4996 total`; `4` documented environment/live-gated skips.

### Follow-up Concerns

- The commandlet emitted unrelated existing invalid-workspace source-control diagnostics despite `-nop4 -NoSourceControl`; all seven selected tests completed successfully.
- Mac and Linux compile/runtime verification remains unrun.

## Follow-up: Empty Candidate and Raw-NUL Intake Hardening

### Correction

- Complete framed empty and RFC-whitespace-only bodies now remain on the one authoritative Unreal parser path. `bMissingRoot` records the absent token but does not return before `++JsonParseCount` and the single `FJsonSerializer::Deserialize`; the completed candidate is then `invalid_json`.
- `StartsWithBom` now uses a non-underflowing bounds check, allowing an empty complete body to reach that parser path safely.
- Scalar wrapping uses `FString::Reserve`, `AppendChar`, and counted `FString` append operations. It no longer uses `%s` formatting.
- UTF-8-to-`TCHAR` conversion now uses explicit source and destination lengths before appending the counted character range. This preserves a trailing raw U+0000 instead of treating it as a C-string terminator.
- The one parser reads from a bounded memory stream built from the exact `FString` length, and finalization requires that the stream be consumed. No handwritten JSON grammar validator, second parse, or parser-error matching was added.
- Added C++ regressions for empty, whitespace-only, and raw-NUL scalar-like framed bodies, all asserting `invalid_json` and exactly one parse. Node coverage now injects the corresponding framed raw-NUL body and asserts `invalid_json` with one parse. The scalar test wording now names the Unreal parser.

Production and test commit: `acb9669`

### RED Evidence

Initial source-contract RED after adding the new tests, before production edits:

```powershell
node test-tcp-transport.mjs
```

Exit code: `1`; `2067 passed / 1 failed / 2068 total`. The failing assertion was `source guard: finalization has one authoritative Unreal parse with length-aware scalar wrapper classification`.

The first deployed automation after the missing-root change was valid RED evidence:

```powershell
UnrealEditor-Cmd.exe <selected .uproject> "-ExecCmds=Automation RunTests UEMCP.Transport.;Quit" ...
```

Exit code: `3`. `DecoderBoundaries` asserted in `StartsWithBom` because its former `Body.Num() - 3` check underflowed for a complete empty body and indexed the empty array before parsing.

After that bounds correction, the second deployed RED was:

```powershell
UnrealEditor-Cmd.exe <selected .uproject> "-ExecCmds=Automation RunTests UEMCP.Transport.;Quit" ...
```

Exit code: `-1`; `6 passed / 1 failed / 7 total`. `DecoderBoundaries` reported `framed scalar-like raw NUL is rejected as invalid_json` as false. Investigation of the installed platform conversion showed that the previous UTF-8 conversion helper treats a final zero byte as a C-string terminator, so the wrapper received only `1` and classified it as `root_not_object`.

### GREEN Evidence

Focused Node source and decoder coverage:

```powershell
node test-tcp-transport.mjs
```

Exit code: `0`; `2068 passed / 0 failed / 2068 total`.

Selected-target sync and build:

```powershell
.\sync-plugin.bat "<selected .uproject>" -y
& "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" <selected editor target> Win64 Development "-Project=<selected .uproject>" -WaitMutex -NoHotReload
```

Exit code: `0`; the selected editor target rebuilt `UnrealEditor-UEMCP.dll`.

Focused deployed automation:

```powershell
& "C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "<selected .uproject>" '-ExecCmds=Automation RunTests UEMCP.Transport.;Quit' -unattended -nop4 -NoSourceControl -nosplash -NullRHI -NoSound '-ddc=InstalledNoZenLocalFallback' -stdout -log
```

Exit code: `0`; found `7` tests; `7 passed / 0 failed`.

Full Node rotation:

```powershell
npm test
```

Exit code: `0`; `60` files, `4997 passed / 0 failed / 4997 total`; `4` documented environment/live-gated skips.

### Follow-up Concerns

- The commandlet continued to emit unrelated invalid-workspace source-control diagnostics; they did not affect the seven transport tests.
- Mac and Linux compile/runtime verification remains unrun.

### Final Reverification

After the final status check, the clean committed worktree was reverified without modifying source:

```powershell
node test-tcp-transport.mjs
```

Exit code: `0`; `2068 passed / 0 failed / 2068 total`.

```powershell
.\sync-plugin.bat "<selected .uproject>" -y
& "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" <selected editor target> Win64 Development "-Project=<selected .uproject>" -WaitMutex -NoHotReload
```

Both exit code `0`; the target was already up to date.

```powershell
& "C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "<selected .uproject>" '-ExecCmds=Automation RunTests UEMCP.Transport.;Quit' -unattended -nop4 -NoSourceControl -nosplash -NullRHI -NoSound '-ddc=InstalledNoZenLocalFallback' -stdout -log
```

Exit code: `0`; found `7` tests; `7 passed / 0 failed`.
