# TCP Receive And Intake Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TCP `55558` request and response intake deterministic, bounded, strict, and diagnosable across fragmentation, malformed framing, invalid UTF-8, slow or reset peers, and mixed framed/legacy deployments.

**Architecture:** Put the language-neutral wire contract in one shared fixture corpus. Implement one incremental decoder per runtime: private Node response/request helpers in `server/tcp-transport.mjs`, and private Unreal request/receive policy in `MCPServerTransportPolicy.h/.cpp`. Integrate typed outcomes at the existing `ConnectionManager` and `FMCPServerRunnable` boundaries, centralize warning/response policy there, then prove the same contract through Node unit/real-socket tests, C++ automation, Win64 builds, deployment checks, and live fault injection.

**Tech Stack:** Node.js 22 ES modules, `node:net`, `node:buffer`, Unreal Engine 5.3/5.6/5.7 C++, UE Sockets and JSON APIs, UE Automation Tests, JSON fixture resources, PowerShell/Windows batch deployment helpers.

## Global Constraints

- Follow `docs/superpowers/specs/2026-07-13-tcp-receive-and-intake-hardening-design.md` as the approved behavioral contract. Do not reopen its decisions during implementation.
- Preserve connect-per-command behavior, framed responses, and legacy unframed request/response compatibility.
- Do not add a response-body cap. Do not reserve or preallocate response storage from an untrusted declared length.
- Enforce an 8 MiB request-body limit for framed and legacy requests. Exactly 8 MiB is valid; one byte over is not.
- Enforce a 512-byte framed-header limit including `\r\n\r\n`. At 512 bytes without the complete terminator, return malformed immediately.
- Parse framing over bytes, validate RFC 3629 UTF-8 before conversion, accept at most one leading BOM, require one root JSON object, and invoke the real JSON parser exactly once per complete candidate.
- Never log, throw, or record raw request/response payload previews. Diagnostics may contain only direction, framing, byte counts, declared length, timeout kind/value, parser category, port, and sanitized native socket code.
- `GetConnectionState()` is not an EOF oracle for receive intake. Receive classification uses the captured result, byte count, and exact error from that `Recv` attempt.
- `SendAll` remains the sole owner of detailed response-write failure warnings; its caller must not add a second generic warning.
- Do not edit `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs`; installed UE 5.3/5.6/5.7 baselines already provide `ws2_32` linkage.
- Compile and runtime proof is required on Win64. Mac/Linux must remain correctly guarded but are explicitly declared-unverified in this slice.
- Keep `docs/specs/tcp-protocol.md` archival. Update current architecture documentation instead.
- Close the Unreal Editor before plugin sync/build/commandlet steps. Relaunch it only for the final live smoke, then restart the MCP client.

Before each target-project command block, set `UEMCP_TEST_UPROJECT` to the intended UE 5.6 test project's absolute `.uproject` path and run this fail-fast preamble. It derives the editor target without committing a machine/project codename:

```powershell
if ([string]::IsNullOrWhiteSpace($env:UEMCP_TEST_UPROJECT)) { throw 'UEMCP_TEST_UPROJECT is required' }
$uproject = [IO.Path]::GetFullPath($env:UEMCP_TEST_UPROJECT)
if (-not (Test-Path -LiteralPath $uproject -PathType Leaf)) { throw "Missing test project: $uproject" }
$projectRoot = Split-Path -Parent $uproject
$editorTargets = @(Get-ChildItem -LiteralPath (Join-Path $projectRoot 'Source') -Filter '*Editor.Target.cs' -File)
if ($editorTargets.Count -ne 1) { throw "Expected one Editor target, found $($editorTargets.Count)" }
$editorTarget = $editorTargets[0].BaseName -replace '\.Target$', ''
```

---

## File Structure

- Create `plugin/UEMCP/Resources/Tests/tcp-transport-cases.json`: language-neutral framing, UTF-8, BOM, JSON-root, fragmentation, trailing-byte, and small-limit vectors.
- Create `server/tcp-transport.mjs`: private request encoder, strict response decoder, legacy boundary scanner, and typed transport error.
- Create `server/test-tcp-transport.mjs`: fixture schema tests, pure decoder tests, request preflight tests, real-socket lifecycle tests, parser-count checks, and C++ source guards.
- Modify `server/connection-manager.mjs`: preflight requests before connecting, consume responses incrementally, enforce an absolute deadline, and map stable error codes.
- Modify `server/test-mock-seam.mjs`: remove `_detectResponseFraming` as a second parser and retain only integration/source assertions not owned by the focused transport suite.
- Create `plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.h`: private constants, receive/decode/read enums, result records, decoder, and reader declarations.
- Create `plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.cpp`: exact socket-error capture, receive classifier, strict header/body decoder, legacy scanner, UTF-8 validator, one-shot JSON parse, and deadline-aware read loop.
- Create `plugin/UEMCP/Source/UEMCP/Private/Tests/MCPServerTransportPolicyTests.cpp`: classifier, fixture, fragmentation, limits, parse-count, and deadline-policy automation tests.
- Modify `plugin/UEMCP/Source/UEMCP/Private/MCPServerRunnable.cpp`: replace anonymous receive parsers/flag coordination with the typed reader and centralized response/log mapping.
- Modify `plugin/UEMCP/Source/UEMCP/Public/MCPServerRunnable.h`: document the actual framed/legacy intake and framed response lifecycle.
- Create `server/live-smoke-tcp-transport.mjs`: direct framed/legacy/fault probes and appended-log-only assertions.
- Modify `server/live-smoke-animation-readback.mjs`: retain the large AnimGraph proof and report response bytes plus elapsed time against the unchanged timeout.
- Modify `manifest.json` and `plugin/UEMCP/UEMCP.uplugin`: bump in lockstep to `1.0.17` / integer version `18`.
- Modify `CLAUDE.md` and `docs/specs/architecture.md`: document strict bidirectional intake, limits, deadlines, compatibility, and proof boundaries.

---

### Task 1: Establish The Shared Transport Contract Corpus

**Files:**
- Create: `plugin/UEMCP/Resources/Tests/tcp-transport-cases.json`
- Create: `server/test-tcp-transport.mjs`

**Fixture schema:**

Each case has `id`, a non-empty `targets` array containing `request` and/or `response`, exactly one of `data_ascii`/`data_base64`, optional `policy` (`max_header_bytes`, `max_body_bytes`), `chunk_plans` (positive byte lengths totaling the decoded input), optional `all_split_points`, and `expected` (`status`, `framing`, optional `declared_body_length`, `reason_code`, and `json`). Status strings are `pending`, `complete`, `malformed`, or `too_large`; framing strings are `undecided`, `legacy`, or `framed`. Terminal reason codes are shared strings: `invalid_header`, `header_too_large`, `invalid_content_length`, `content_length_overflow`, `body_too_large`, `trailing_bytes`, `invalid_utf8`, `invalid_bom`, `root_not_object`, `invalid_json`, and `mismatched_delimiter`. Pending and complete cases omit `reason_code`.

- [ ] **Step 1: Write a failing fixture loader/schema test**

In `server/test-tcp-transport.mjs`, use `TestRunner`, resolve the fixture with `new URL('../plugin/UEMCP/Resources/Tests/tcp-transport-cases.json', import.meta.url)`, and assert:

- schema version is exactly `1`;
- IDs are unique;
- each case has one encoding only;
- decoded bytes are non-empty;
- every explicit chunk plan contains positive integers and sums exactly to input length;
- target/status/framing values are from the allowed sets;
- all required case IDs below exist.

Run:

```powershell
cd D:\DevTools\UEMCP\.worktrees\anim-graph-pin-serialization\server
node test-tcp-transport.mjs
```

Expected: fail with `ENOENT` for `tcp-transport-cases.json`.

- [ ] **Step 2: Add the fixture corpus**

Add these exact case families. Use `all_split_points: true` on `framed-basic`, `framed-bom-multibyte`, `legacy-nested-escaped`, and `legacy-bom-multibyte` so both runtimes test every two-chunk split around the framing prefix, terminator, BOM, multibyte sequence, escape, and root close.

| IDs | Required bytes/expectation |
| --- | --- |
| `framed-basic`, `framed-case-insensitive`, `framed-extra-header`, `framed-colon-in-extra-value` | Valid `Content-Length` frames; first line only owns length; legal extra names/values are ignored; complete object returned. |
| `framed-bom-multibyte`, `legacy-bom-multibyte` | One leading BOM and an object containing a four-byte Unicode scalar; BOM stripped; object completes at every split. |
| `legacy-basic`, `legacy-leading-trailing-whitespace`, `legacy-nested-escaped` | Root object with nested arrays/objects, braces inside strings, and odd/even backslash runs; scanner completes once and ignores structural string bytes. |
| `partial-prefix`, `partial-header`, `partial-framed-body`, `partial-legacy-object` | Decoder remains pending before socket lifecycle finalization. |
| `header-empty-length`, `header-signed-length`, `header-suffixed-length`, `header-embedded-space`, `header-duplicate-length`, `header-bad-extra-name`, `header-missing-extra-colon`, `header-folded-line`, `header-control-value`, `header-non-ascii`, `header-integer-overflow`, `request-huge-length`, `header-cap-no-terminator` | Framing is confirmed and never falls back to legacy. Unsafe response length is malformed/`content_length_overflow`; a syntactically valid arbitrarily large request declaration is `too_large`/`body_too_large`; `header-cap-no-terminator` is exactly the policy cap and malformed/`header_too_large`. |
| `framed-exact-small-limit`, `framed-over-small-limit`, `legacy-exact-small-limit`, `legacy-over-small-limit` | Per-case `max_body_bytes: 16`; 16 is accepted, 17 is `too_large` for request targets. |
| `framed-trailing-byte`, `legacy-trailing-byte`, `legacy-mismatched-close` | Terminal malformed with `trailing_bytes` or `mismatched_delimiter`; never dispatch a second object/frame. |
| `json-root-array`, `json-root-scalar`, `json-invalid-object` | Root array/scalar rejected; syntactically invalid completed object rejected by the real parser. |
| `utf8-overlong`, `utf8-surrogate`, `utf8-above-max`, `utf8-forbidden-lead`, `utf8-lone-continuation`, `utf8-malformed-continuation`, `utf8-truncated-framed` | Terminal malformed strict UTF-8. For legacy EOF-only truncation, keep decoder pending and assert EOF diagnostics in lifecycle tests. |
| `bom-duplicate`, `bom-after-whitespace`, `bom-partial-framed` | Terminal malformed; no replacement decoding or BOM normalization beyond one leading BOM. |

Use these exact base64 payloads for the invalid legacy UTF-8/BOM bodies:

```text
utf8-overlong             eyJ4IjoiwK8ifQ==
utf8-surrogate            eyJ4Ijoi7aCAIn0=
utf8-above-max            eyJ4Ijoi9JCAgCJ9
utf8-forbidden-lead       eyJ4Ijoi9YCAgCJ9
utf8-lone-continuation    eyJ4IjoigCJ9
utf8-malformed-continuation eyJ4Ijoi4iihIn0=
bom-valid-object          77u/e30=
bom-duplicate             77u/77u/e30=
bom-after-whitespace      IO+7v3t9
bom-partial               77s=
```

For framed invalid-body vectors, construct the fixture byte string using the exact decimal byte length of the decoded body, then base64-encode the complete header plus body. Do not use character counts.

- [ ] **Step 3: Verify the fixture schema test turns green**

Run `node test-tcp-transport.mjs` again. Expected: all fixture schema assertions pass and the process exits `0`.

- [ ] **Step 4: Commit Task 1**

```powershell
git add plugin/UEMCP/Resources/Tests/tcp-transport-cases.json server/test-tcp-transport.mjs
git commit -m "Add shared TCP transport contract fixtures"
```

---

### Task 2: Implement The Incremental Node Transport Decoder

**Files:**
- Create: `server/tcp-transport.mjs`
- Modify: `server/test-tcp-transport.mjs`

**Interfaces:**

```js
export const TCP_MAX_HEADER_BYTES = 512;
export const TCP_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

export class TcpTransportError extends Error {
  constructor(code, port, details = {});
}

export function encodeTcpRequest(type, params, { port, maxBodyBytes = TCP_MAX_REQUEST_BODY_BYTES } = {});
// -> { body, frame, bodyBytes }; throws REQUEST_TOO_LARGE before socket creation

export class TcpResponseDecoder {
  constructor({ maxHeaderBytes = 512, parseJson = JSON.parse } = {});
  consume(chunk); // -> immutable snapshot
  finish();       // terminal EOF diagnostics without reparsing
  snapshot();
  debugStatsForTests(); // -> { legacyBytesScanned, bodyAssemblyCount, jsonParseCount }
}
```

Decoder snapshots contain `status`, `framing`, `bytesReceived`, `declaredBodyLength`, and only on terminal states `value` or `reasonCode`. `status` is `pending`, `complete`, or `malformed`. No snapshot contains body text.

- [ ] **Step 1: Add failing pure decoder tests**

Import the missing interfaces, execute every response-target fixture under its whole-buffer plan, explicit plans, and generated split points, and assert the expected status/framing/length/value. Add focused assertions that:

- `debugStatsForTests()` reports each legacy byte scanned once, zero body assemblies/parses while pending, and exactly one body assembly plus one parse on a complete candidate, valid or invalid JSON;
- the decoder accepts only `Buffer`/`Uint8Array` chunks and rejects calls after terminal completion;
- an unsafe response length is malformed without allocating that length;
- bytes beyond a complete framed body are malformed when already buffered;
- `finish()` distinguishes zero bytes, incomplete prefix/header/body/legacy, partial BOM, and truncated UTF-8 using metadata only;
- source text contains no payload slicing in errors and no `Buffer.alloc(declaredBodyLength)`-style allocation.

Run `node test-tcp-transport.mjs`. Expected: fail with `ERR_MODULE_NOT_FOUND` for `tcp-transport.mjs`.

- [ ] **Step 2: Implement byte-level framing and the legacy scanner**

Implement a fixed 512-byte header scratch buffer and a byte-by-byte case-insensitive prefix matcher. On first prefix mismatch, switch once to legacy. After prefix confirmation, malformed headers stay framed/malformed.

Parse header lines as raw ASCII and checked decimal arithmetic. The first line must be `Content-Length:` case-insensitively, with one or more digits after trimming only ASCII space/tab around the value. Permit optional headers only when names match `[A-Za-z0-9-]+`, a colon exists, values contain tab or printable ASCII only, and no line folding/control byte occurs. Reject duplicate `Content-Length` case-insensitively. For Node responses, require a non-negative `Number.isSafeInteger` result and never allocate from it.

The legacy scanner tracks optional BOM, pre-root RFC JSON whitespace, required `{`, a delimiter stack, string state, and backslash escape state. It scans only newly arrived bytes. It does not validate JSON tokens, numbers, literals, or escape grammar.

- [ ] **Step 3: Implement strict body finalization**

Retain body segments after framing is known. At a complete boundary, concatenate exactly once, validate with `isUtf8` from `node:buffer`, enforce one leading BOM, decode only after validation, run the injected parser once, and require a non-null non-array object. Maintain the test-only counters inside the decoder and return a copy from `debugStatsForTests()`; production flow must never branch on or consume those counters.

For framed input, parse exactly the declared body. For legacy input, parse the root-object candidate plus allowed buffered trailing whitespace. Never resolve a second object.

- [ ] **Step 4: Implement request encoding and typed errors**

`encodeTcpRequest` must `JSON.stringify({ type, params })`, encode to a UTF-8 `Buffer`, compare `body.length` against `maxBodyBytes`, and create one atomic `Buffer.concat([header, body])` frame only after the limit passes. `tcpCommand` passes its actual `port`; production uses `TCP_MAX_REQUEST_BODY_BYTES`. `TcpTransportError` must remain an `Error`, expose a stable `code`, prefix its message with `TCP:<port>`, and construct/freeze `details` from an explicit safe-field allowlist. Never spread arbitrary errors, params, request objects, or decoder snapshots into `details`; retain a native Node socket code as `details.nativeCode` while the top-level stable code remains `SOCKET_ERROR`.

- [ ] **Step 5: Verify Task 2**

Run:

```powershell
cd D:\DevTools\UEMCP\.worktrees\anim-graph-pin-serialization\server
node test-tcp-transport.mjs
```

Expected: all fixture permutations, parser-count checks, malformed inputs, and encoder boundary tests pass.

- [ ] **Step 6: Commit Task 2**

```powershell
git add server/tcp-transport.mjs server/test-tcp-transport.mjs
git commit -m "Add strict incremental Node TCP decoder"
```

---

### Task 3: Integrate Node Preflight, Lifecycle Errors, And Absolute Deadlines

**Files:**
- Modify: `server/connection-manager.mjs`
- Modify: `server/test-tcp-transport.mjs`
- Modify: `server/test-mock-seam.mjs`

- [ ] **Step 1: Add failing real-socket lifecycle tests**

Use ephemeral `net.Server` instances and production `ConnectionManager.send('tcp-55558', type, params, { skipCache: true })`. Add tests for:

- exactly 8 MiB request body connects and writes a valid frame;
- 8 MiB plus one throws `REQUEST_TOO_LARGE` and the server observes zero connections;
- fragmented framed and legacy responses complete across all critical split points;
- a close with zero response bytes maps to `NO_RESPONSE`;
- close during prefix/header/framed body/legacy object maps to `INCOMPLETE_RESPONSE`;
- malformed header, invalid UTF-8, invalid JSON, root array, and buffered trailing bytes map to `MALFORMED_RESPONSE`;
- `socket.resetAndDestroy()` before completion maps to `SOCKET_ERROR` and preserves the native socket code when Node supplies one;
- connection refusal and request-write failure map to `SOCKET_ERROR`, with the native code only in `details.nativeCode`;
- a server sending one byte often enough to defeat inactivity timeout still fails with `RESPONSE_TIMEOUT` at the absolute `timeoutMs` deadline;
- a 4 MiB topology/base64-shaped framed response, fragmented into 4096-byte chunks, remains uncapped, parses once, and resolves without per-chunk whole-buffer assembly;
- delayed success preserves the existing finite elapsed timing metric, and sanitized failures preserve error accounting without storing payload text;
- every failure is an `Error`, has the exact stable `code`, includes `TCP:<port>`, and contains no body preview;
- a parser counter proves one parse, and a source guard proves the `data` handler does not run whole-body `Buffer.concat`/`JSON.parse` work.

Construct the exact request-limit bodies without trial-and-error Unicode sizing: compute `baseBytes = Buffer.byteLength(JSON.stringify({ type: 'sized', params: { padding: '' } }))`, then use an ASCII `padding` string of `limit - baseBytes` or `limit + 1 - baseBytes` bytes. The local server must read the declared body and return framed success for the exact-limit case; for the over-limit case it only counts accepted connections and must remain at zero after the rejection settles.

Expected red state: current code connects before size validation, reparses/concatenates on every chunk, leaks response previews, and lets activity reset its only effective timeout.

- [ ] **Step 2: Replace `_detectResponseFraming` and integrate the decoder**

Import `encodeTcpRequest`, `TcpResponseDecoder`, and `TcpTransportError`. Remove `_detectResponseFraming` from `connection-manager.mjs` exports and production use. In `tcpCommand`:

1. Run request encoding before constructing the Promise and before `net.createConnection`.
2. Start one absolute timer immediately before connection initiation.
3. Create one decoder per command and feed each `data` chunk once.
4. Resolve only on decoder `complete`; reject decoder `malformed` as `MALFORMED_RESPONSE`.
5. On `end`/`close`, query `finish()` and map zero/incomplete/malformed progress without parsing again.
6. Map absolute and inactivity timeout to `RESPONSE_TIMEOUT`, and socket events to `SOCKET_ERROR` unless a more specific terminal outcome already won.
7. Use one idempotent settle/cleanup helper to clear timers and listeners exactly once.

Preserve the caller-supplied `timeoutMs`, existing metrics timing, request serialization, layer availability, cache behavior, and legacy responses. Ensure `metrics.err` receives only the sanitized error message/code.

- [ ] **Step 3: Retire duplicate parser tests from the mock seam**

In `server/test-mock-seam.mjs`, remove the `_detectResponseFraming` import and old Test 17 pure framing block. Replace the Test 22b helper's parser with either `TcpResponseDecoder` or an exact-length request-frame helper from `tcp-transport.mjs`; do not keep a local framing parser. Keep the existing `SendAll` source assertions until Task 6 sharpens them.

- [ ] **Step 4: Verify focused and full Node tests**

```powershell
cd D:\DevTools\UEMCP\.worktrees\anim-graph-pin-serialization\server
node test-tcp-transport.mjs
node test-mock-seam.mjs
npm test
```

Expected: all commands exit `0`; the rotation reports zero failures and only its documented gated skips.

- [ ] **Step 5: Commit Task 3**

```powershell
git add server/connection-manager.mjs server/test-tcp-transport.mjs server/test-mock-seam.mjs
git commit -m "Integrate bounded Node TCP intake lifecycle"
```

---

### Task 4: Add Exact Native Receive Classification

**Files:**
- Create: `plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.h`
- Create: `plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.cpp`
- Create: `plugin/UEMCP/Source/UEMCP/Private/Tests/MCPServerTransportPolicyTests.cpp`

**Native interfaces:**

```cpp
namespace UEMCP::Transport
{
inline constexpr int32 MaxHeaderBytes = 512;
inline constexpr int64 MaxRequestBodyBytes = 8ll * 1024ll * 1024ll;
inline constexpr double ReceiveIdleTimeoutSec = 2.0;
inline constexpr double ReceiveTotalTimeoutSec = 10.0;

enum class EMCPReceiveAction : uint8 { ConsumeData, Wait, PeerClosed, SocketError };

struct FMCPReceiveAttempt
{
    bool bSucceeded = false;
    int32 BytesRead = 0;
    ESocketErrors Error = SE_NO_ERROR;
};

FMCPReceiveAttempt ReceiveWithCapturedError(FSocket* Socket, uint8* Buffer, int32 BufferSize);
EMCPReceiveAction ClassifyReceiveAttempt(const FMCPReceiveAttempt& Attempt);
}
```

- [ ] **Step 1: Write failing receive-classifier automation tests**

Register `UEMCP.Transport.ReceiveClassifier` under `WITH_DEV_AUTOMATION_TESTS`. Cover every approved row plus negative byte counts:

- `true/>0` -> `ConsumeData` regardless of stale error;
- `true/0` -> `Wait`;
- `false/0/SE_NO_ERROR` -> `PeerClosed`;
- `false/0/SE_EWOULDBLOCK` and `SE_EINTR` -> `Wait`;
- `false/0/SE_ECONNRESET` and another hard error -> `SocketError`;
- negative bytes -> `Wait` only for retryable errors, otherwise `SocketError`.

Run the reset case immediately before a separate explicitly cleared `false/0/SE_NO_ERROR` case and assert the latter is `PeerClosed`; this is the regression proof that stale reset state cannot leak across attempts.

Sync the red test and run the UE 5.6 build:

```powershell
cd D:\DevTools\UEMCP\.worktrees\anim-graph-pin-serialization
.\sync-plugin.bat "$uproject" -y
& "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" $editorTarget Win64 Development "-Project=$uproject" -WaitMutex -NoHotReload
```

Expected: compilation fails because the policy header/implementation is absent or incomplete.

- [ ] **Step 2: Implement exact error capture and classification**

In the private `.cpp`, use this include shape on Windows, matching Engine `IcmpWindows.cpp`:

```cpp
#if PLATFORM_WINDOWS
#include "Windows/AllowWindowsPlatformTypes.h"
THIRD_PARTY_INCLUDES_START
#include "WinSock2.h"
THIRD_PARTY_INCLUDES_END
#include "Windows/HideWindowsPlatformTypes.h"
#elif PLATFORM_UNIX
#include <cerrno>
#endif
```

For Windows: call `WSASetLastError(0)`, call `FSocket::Recv` exactly once, capture `WSAGetLastError()` immediately only when it returns false, then translate through `ISocketSubsystem::TranslateErrorCode`. For Unix: clear `errno`, call once, capture `errno` immediately on false, and translate it. A null socket or socket subsystem returns a hard `SE_SYSTEM` attempt. Never consult `GetConnectionState()`.

- [ ] **Step 3: Add source guards and verify green**

In `server/test-tcp-transport.mjs`, assert the policy source contains the platform guards, clear/capture calls, `TranslateErrorCode`, and no `GetConnectionState`. Re-sync, rebuild, then run:

```powershell
& "C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "$uproject" -run=RunTests -testfilter=UEMCP.Transport.ReceiveClassifier -unattended -nop4 -nosplash -NullRHI -stdout
```

Expected: build succeeds and the focused automation test reports success.

- [ ] **Step 4: Commit Task 4**

```powershell
git add plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.h plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.cpp plugin/UEMCP/Source/UEMCP/Private/Tests/MCPServerTransportPolicyTests.cpp server/test-tcp-transport.mjs
git commit -m "Add native TCP receive classification policy"
```

---

### Task 5: Implement The Native Request Decoder And Shared Fixtures

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.h`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.cpp`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/Tests/MCPServerTransportPolicyTests.cpp`

**Decoder interfaces:**

```cpp
enum class EMCPFramingMode : uint8 { Undecided, Legacy, Framed };
enum class EMCPDecodeStatus : uint8 { Pending, Complete, Malformed, TooLarge };

struct FMCPDecoderPolicy
{
    int32 MaxHeader = MaxHeaderBytes;
    int64 MaxBody = MaxRequestBodyBytes;
};

struct FMCPDecodeSnapshot
{
    EMCPDecodeStatus Status = EMCPDecodeStatus::Pending;
    EMCPFramingMode Framing = EMCPFramingMode::Undecided;
    TSharedPtr<FJsonObject> Object;
    FString ReasonCode;
    int64 BytesReceived = 0;
    int64 DeclaredBodyLength = -1;
};

class FMCPRequestDecoder
{
public:
    explicit FMCPRequestDecoder(FMCPDecoderPolicy InPolicy = {});
    const FMCPDecodeSnapshot& Consume(const uint8* Data, int32 NumBytes);
    const FMCPDecodeSnapshot& Snapshot() const;
    FString DescribeTerminalEof() const;
#if WITH_DEV_AUTOMATION_TESTS
    int32 GetJsonParseCountForTests() const;
    int64 GetLegacyBytesScannedForTests() const;
#endif
};
```

- [ ] **Step 1: Write failing shared-fixture and decoder tests**

Add `UEMCP.Transport.SharedFixtures`. Resolve only:

```cpp
IPluginManager::Get().FindPlugin(TEXT("UEMCP"))->GetBaseDir()
```

then append `Resources/Tests/tcp-transport-cases.json`. Fail loudly if the plugin or file is missing; do not search repository-relative fallbacks. Decode ASCII/base64 vectors, validate chunk plans, generate all split points, and run every request-target case against a fresh decoder. Add direct production-constant assertions for 512 and 8 MiB without embedding an 8 MiB fixture.

Assert parser count is exactly one for completed valid and invalid JSON candidates, and zero while pending, too-large, header-malformed, or invalid UTF-8. For every legacy chunk plan, assert `GetLegacyBytesScannedForTests()` equals the number of bytes fed through the boundary scanner, with no rescans after later chunks. Generate valid `{"padding":"<ASCII x bytes>"}` framed and legacy request bodies in memory at exactly `MaxRequestBodyBytes`, then generate the same shape at `MaxRequestBodyBytes + 1`; assert the decoder completes the exact boundary and returns `TooLarge` for the first byte over. Keep these generated payloads out of the fixture file.

Expected red state: missing decoder types and fixture behavior.

- [ ] **Step 2: Implement strict framing, limits, scanner, UTF-8, and JSON finalization**

Use raw bytes for prefix/header offsets and checked decimal accumulation. Check limits before append/reserve and use overflow-safe `bodyOffset + bodyLength` arithmetic. A valid framed declaration over policy becomes `TooLarge`; a legacy stream becomes `TooLarge` before appending byte 17 under a 16-byte test policy.

Implement the same incremental legacy delimiter/string/backslash state machine as Node. Validate complete bodies with a small RFC 3629 validator before `FUTF8ToTCHAR`; reject overlongs, surrogates, >U+10FFFF, forbidden leads, lone/malformed/truncated continuations. Strip exactly one leading BOM, allow RFC JSON whitespace around the root, deserialize once with `FJsonSerializer`, and require an object.

`DescribeTerminalEof()` may identify a partial BOM/UTF-8/prefix/header/body/object for diagnostics, but it must not run JSON parsing or convert a pending decoder into a dispatchable result.

- [ ] **Step 3: Rebuild and run focused automation**

Re-run `sync-plugin.bat` and the UE 5.6 `Build.bat` command from Task 4, then:

```powershell
& "C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "$uproject" -run=RunTests -testfilter=UEMCP.Transport. -unattended -nop4 -nosplash -NullRHI -stdout
```

Expected: classifier and every shared fixture/split permutation pass; fixture path is the deployed plugin `Resources` path.

- [ ] **Step 4: Commit Task 5**

```powershell
git add plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.h plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.cpp plugin/UEMCP/Source/UEMCP/Private/Tests/MCPServerTransportPolicyTests.cpp
git commit -m "Add strict native TCP request decoder"
```

---

### Task 6: Integrate Typed Native Read Outcomes And One-Owner Logging

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.h`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.cpp`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/MCPServerRunnable.cpp`
- Modify: `plugin/UEMCP/Source/UEMCP/Public/MCPServerRunnable.h`
- Modify: `server/test-tcp-transport.mjs`
- Modify: `server/test-mock-seam.mjs`

**Reader interfaces:**

```cpp
enum class EMCPRequestReadOutcome : uint8
{
    Complete, Malformed, TooLarge, IdleTimeout, TotalTimeout,
    PeerClosed, SocketError, ServerStopping
};

struct FMCPRequestReadResult
{
    EMCPRequestReadOutcome Outcome = EMCPRequestReadOutcome::SocketError;
    TSharedPtr<FJsonObject> Object;
    FString ReasonCode;
    EMCPFramingMode Framing = EMCPFramingMode::Undecided;
    int64 BytesReceived = 0;
    int64 DeclaredBodyLength = -1;
    double ElapsedMs = 0.0;
    ESocketErrors SocketError = SE_NO_ERROR;
};

enum class EMCPReceiveDeadline : uint8 { None, IdleTimeout, TotalTimeout };

struct FMCPReceiveWaitDecision
{
    EMCPReceiveDeadline Deadline = EMCPReceiveDeadline::None;
    double WaitSeconds = 0.0;
};

FMCPReceiveWaitDecision EvaluateReceiveDeadlines(
    double AcceptedAtSeconds,
    double LastPositiveByteAtSeconds,
    double NowSeconds);

FMCPRequestReadResult ReadOneRequest(
    FSocket* Socket,
    double AcceptedAtSeconds,
    TFunctionRef<bool()> IsServerRunning);
```

- [ ] **Step 1: Add failing timeout/outcome and source-contract tests**

Add pure `EvaluateReceiveDeadlines` tests proving: idle starts at accept, only positive bytes reset idle, total never resets, total wins if both limits are expired, and wait duration is `min(50 ms, idle remaining, total remaining)`. Call `ReadOneRequest(nullptr, acceptedAt, [] { return false; })` and assert `ServerStopping` is returned quietly before socket validation. Add Node source guards that fail while `MCPServerRunnable.cpp` still contains `TryParseAccumulated`, `DetectFraming`, `FCString::Atoi`, direct `Recv` calls, duplicate parser flags, and caller-level `failed to send response` warnings. Require the production header/request constants to appear in the policy read/decoder path. The send loop may retain its send-side `GetConnectionState`; the receive policy source must contain none.

- [ ] **Step 2: Implement `ReadOneRequest`**

Capture `AcceptedAtSeconds = FPlatformTime::Seconds()` immediately after `Accept()` succeeds in `Run`, pass it through `ServeOneConnection(FSocket*, double)` to `ReadOneRequest`, and initialize last progress to that timestamp. Before and after each receive, prefer `ServerStopping`, then decoder terminal state, then total timeout, then idle timeout. Positive bytes alone reset idle. Retry/readiness/zero bytes do not.

For `Wait`, call `Socket->Wait(WaitForRead, Remaining)` with at most the minimum approved duration. Map `false/0/SE_NO_ERROR` to `PeerClosed`; retain pending `DescribeTerminalEof()` only as a diagnostic reason. Do not parse a partial frame at EOF. Null subsystem/socket paths become `SocketError`.

- [ ] **Step 3: Replace `ServeOneConnection` flag coordination**

Delete `TryParseAccumulated`, `DetectFraming`, receive accumulator flags, and receive-side connection-state polling. Call `ReadOneRequest` once, then use one `switch` to enforce:

| Outcome | Action |
| --- | --- |
| `Complete` | Dispatch normally; no intake warning. |
| `Malformed` | One sanitized `event=tcp_intake_malformed` warning; build `MALFORMED_REQUEST`; attempt send. |
| `TooLarge` | One sanitized `event=tcp_intake_too_large` warning; build `REQUEST_TOO_LARGE`; attempt send. |
| `IdleTimeout` / `TotalTimeout` | One `event=tcp_intake_idle_timeout` or `event=tcp_intake_total_timeout` warning; build `REQUEST_TIMEOUT`; attempt send. |
| `PeerClosed`, zero bytes | Verbose `event=tcp_peer_closed_empty` only; return without send. |
| `PeerClosed`, partial bytes | One `event=tcp_peer_closed_partial` warning; return without send. |
| `SocketError` | One `event=tcp_intake_socket_error` warning with translated error/progress; return without send. |
| `ServerStopping` | Return quietly. |

Keep missing/empty `type` as `MALFORMED_REQUEST` after a complete transport object. Every event log includes only framing, byte counts, declared length, elapsed time, timeout kind, reason code, and translated/native socket code as applicable. Keep framed response serialization and a distinct 10-second response-send constant rather than reusing a receive-deadline name. Make `SendAll` capture/translate its own send error with `SocketSubsystem->GetSocketError(Error)` and emit one detailed `event=tcp_send_failure` warning; remove the caller's generic warning.

- [ ] **Step 4: Verify Node guards, build, and C++ automation**

```powershell
cd D:\DevTools\UEMCP\.worktrees\anim-graph-pin-serialization\server
node test-tcp-transport.mjs
node test-mock-seam.mjs
cd ..
.\sync-plugin.bat "$uproject" -y
& "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" $editorTarget Win64 Development "-Project=$uproject" -WaitMutex -NoHotReload
& "C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "$uproject" -run=RunTests -testfilter=UEMCP.Transport. -unattended -nop4 -nosplash -NullRHI -stdout
```

Expected: Node guards pass, Win64 compile succeeds, and all `UEMCP.Transport.*` tests pass.

- [ ] **Step 5: Commit Task 6**

```powershell
git add plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.h plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.cpp plugin/UEMCP/Source/UEMCP/Private/MCPServerRunnable.cpp plugin/UEMCP/Source/UEMCP/Public/MCPServerRunnable.h server/test-tcp-transport.mjs server/test-mock-seam.mjs
git commit -m "Integrate typed native TCP request lifecycle"
```

---

### Task 7: Add Live Fault Injection And Large AnimGraph Proof

**Files:**
- Create: `server/live-smoke-tcp-transport.mjs`
- Modify: `server/live-smoke-animation-readback.mjs`
- Modify: `server/test-tcp-transport.mjs`

- [ ] **Step 1: Add failing static smoke-contract tests**

Assert the new smoke is discovered by `run-live-smoke.mjs`, uses `prepareLiveSmoke`, binds only to the selected target/port, reads only the log segment appended after its starting byte offset, and contains all probe IDs listed below. Assert it never mutates assets or invokes Python.

- [ ] **Step 2: Implement direct raw-socket probe helpers**

Use `node:net` and `TcpResponseDecoder`. Require exactly one top-level `.uproject` under `projectRoot`, derive `projectName = basename(uprojectPath, '.uproject')`, and resolve the active log with `join(projectRoot, 'Saved', 'Logs', projectName + '.log')`; record size and timestamp before probes, fail if it truncates/rotates, and inspect only newly appended bytes after a short flush delay.

Implement these deterministic probes:

1. valid framed `ping`;
2. valid legacy `ping`;
3. close with zero request bytes;
4. partial prefix/header/body then clean close;
5. client reset during partial request via `resetAndDestroy()`;
6. clean connect/close with zero bytes immediately after reset, proving no stale reset error;
7. clean framed `ping` immediately after the reset pair;
8. complete framed invalid JSON containing the unique string `UEMCP_SECRET_PAYLOAD_SENTINEL`;
9. complete framed invalid UTF-8;
10. invalid/duplicate `Content-Length`;
11. declared request length `8 MiB + 1` without allocating/sending that body;
12. idle connection held past 2 seconds;
13. one-byte trickle that resets idle but crosses the 10-second total deadline;
14. valid large `{ type: 'get_anim_graph', params: { asset_path, include_transitions: true, include_node_properties: true, include_pin_topology: true, include_pin_defaults: true } }` request using `asset_path = UEMCP_LIVE_ANIM_BLUEPRINT`; reset on receipt of the first response chunk so the non-blocking `SendAll` path still has outstanding bytes and must exercise one response-send failure;
15. final framed `ping` proving server recovery.

For active parser/limit/timeout probes, decode and assert `MALFORMED_REQUEST`, `REQUEST_TOO_LARGE`, or `REQUEST_TIMEOUT`. Peer-close/reset probes expect no response. In the appended log segment, filter on the exact `event=tcp_*` tokens from Task 6 so unrelated editor background output cannot create false failures. Assert the partial reset logs exactly one `event=tcp_intake_socket_error` with translated `SE_ECONNRESET` (numeric `26`), the following clean close logs no warning or inherited reset, every other applicable probe owns exactly one warning event, probe 14 owns exactly one `event=tcp_send_failure`, and neither `UEMCP_SECRET_PAYLOAD_SENTINEL` nor any raw request/body preview appears.

- [ ] **Step 3: Sharpen the existing AnimGraph smoke**

Keep `get_anim_graph` read-only. Measure serialized UTF-8 response bytes and wall time, assert pin topology remains complete, and assert elapsed time is below the existing caller timeout without adding an AnimGraph-specific override. Print only counts, bytes, and elapsed milliseconds.

- [ ] **Step 4: Verify static/offline tests**

```powershell
cd D:\DevTools\UEMCP\.worktrees\anim-graph-pin-serialization\server
node test-tcp-transport.mjs
npm test
```

Expected: zero failures; live scripts skip cleanly because live opt-in is not part of the offline rotation.

- [ ] **Step 5: Commit Task 7**

```powershell
git add server/live-smoke-tcp-transport.mjs server/live-smoke-animation-readback.mjs server/test-tcp-transport.mjs
git commit -m "Add live TCP transport fault smoke"
```

---

### Task 8: Version And Document The Hardened Contract

**Files:**
- Modify: `manifest.json`
- Modify: `plugin/UEMCP/UEMCP.uplugin`
- Modify: `plugin/UEMCP/Source/UEMCP/Public/MCPServerRunnable.h`
- Modify: `CLAUDE.md`
- Modify: `docs/specs/architecture.md`

- [ ] **Step 1: Add/confirm version and documentation guards**

Extend `server/test-plugin-manifest.mjs` only if existing lockstep assertions do not already catch the intended values. In `server/test-tcp-transport.mjs`, assert current docs name strict UTF-8, 512-byte header, 8 MiB request limit, 2-second idle/10-second total server deadlines, absolute Node deadline, legacy compatibility, no response cap, and Win64-only runtime proof.

- [ ] **Step 2: Apply lockstep version bump and current docs**

- `manifest.json`: `1.0.16` -> `1.0.17`.
- `UEMCP.uplugin`: `Version` `17` -> `18`; `VersionName` `1.0.16` -> `1.0.17`.
- `MCPServerRunnable.h`: describe typed strict request intake and framed response send; remove “parse until JSON” and unframed-response claims.
- `CLAUDE.md` and `docs/specs/architecture.md`: document the bidirectional contract, stable Node error codes, response/log policy, fixture location, and Mac/Linux declared-unverified boundary.
- Do not edit archival `docs/specs/tcp-protocol.md`.

- [ ] **Step 3: Verify and commit Task 8**

```powershell
cd D:\DevTools\UEMCP\.worktrees\anim-graph-pin-serialization\server
node test-plugin-manifest.mjs
node test-tcp-transport.mjs
npm test
cd ..
git diff --check
git diff -- docs/specs/tcp-protocol.md
```

Expected: all tests pass, `git diff --check` is empty, and archival protocol diff is empty.

```powershell
git add manifest.json plugin/UEMCP/UEMCP.uplugin plugin/UEMCP/Source/UEMCP/Public/MCPServerRunnable.h CLAUDE.md docs/specs/architecture.md server/test-plugin-manifest.mjs server/test-tcp-transport.mjs
git commit -m "Document and version TCP intake hardening"
```

---

### Task 9: Run The Full Build, Deployment, And Live Acceptance Gate

**Files:**
- Create after all gates pass: `docs/audits/2026-07-13-tcp-receive-and-intake-hardening-verification.md`
- Fix implementation failures in the owning task and rerun this entire gate; do not hide them in the evidence report.

- [ ] **Step 1: Run the complete Node rotation**

```powershell
cd D:\DevTools\UEMCP\.worktrees\anim-graph-pin-serialization\server
npm test
```

Expected: exit `0`, zero failures, only documented gated skips.

- [ ] **Step 2: Package-compile all supported Win64 baselines and prove Resources packaging**

```powershell
cd D:\DevTools\UEMCP\.worktrees\anim-graph-pin-serialization
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$plugin = "$PWD\plugin\UEMCP\UEMCP.uplugin"
foreach ($version in @('5.3', '5.6', '5.7')) {
  $uat = "C:\Program Files\Epic Games\UE_$version\Engine\Build\BatchFiles\RunUAT.bat"
  $package = Join-Path $env:TEMP "UEMCP-BuildPlugin-$version-$stamp"
  & $uat BuildPlugin "-Plugin=$plugin" "-Package=$package" -TargetPlatforms=Win64 -Rocket
  if ($LASTEXITCODE -ne 0) { throw "UE $version BuildPlugin failed" }
  if (-not (Test-Path (Join-Path $package 'Resources\Tests\tcp-transport-cases.json'))) {
    throw "UE $version package omitted TCP fixtures"
  }
}
```

Expected: UE 5.3, 5.6, and 5.7 each report `BUILD SUCCESSFUL`; every package contains the shared fixture. This proves Win64 compile/package only, not Mac/Linux runtime.

- [ ] **Step 3: Sync, build, run C++ automation, and commandlet gate against the selected target**

With the editor closed:

```powershell
.\sync-plugin.bat "$uproject" -y
& "C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" $editorTarget Win64 Development "-Project=$uproject" -WaitMutex -NoHotReload
& "C:\Program Files\Epic Games\UE_5.6\Engine\Binaries\Win64\UnrealEditor-Cmd.exe" "$uproject" -run=RunTests -testfilter=UEMCP.Transport. -unattended -nop4 -nosplash -NullRHI -stdout
.\test-uemcp-gate.bat "$uproject"
$verifyTarget = Join-Path $env:TEMP 'uemcp-selected-target.txt'
Set-Content -LiteralPath $verifyTarget -Value $uproject -Encoding ascii
.\verify-deploy.bat --targets "$verifyTarget" --no-pause
```

Expected: build success, all focused transport automation tests pass, the D57 commandlet gate reports `PASS`, and the isolated selected-target deploy check reports `SYNC`/`ALL-SYNC`. The temporary target file is machine-local evidence and must not be committed.

- [ ] **Step 4: Relaunch editor/MCP and run live transport plus AnimGraph smoke**

After launching the selected editor target and restarting the MCP client, require the live AnimBlueprint asset path from the session environment:

```powershell
$env:UEMCP_LIVE_SMOKE = '1'
if ([string]::IsNullOrWhiteSpace($env:UEMCP_LIVE_ANIM_BLUEPRINT)) { throw 'UEMCP_LIVE_ANIM_BLUEPRINT is required' }
$env:UEMCP_LIVE_PROJECT_ROOT = $projectRoot
cd D:\DevTools\UEMCP\.worktrees\anim-graph-pin-serialization\server
node run-live-smoke.mjs --project "$projectRoot"
```

Expected: `live-smoke-tcp-transport.mjs` passes all fault/recovery/log assertions; `live-smoke-animation-readback.mjs` returns complete pin topology, reports response bytes/timing, and remains under the unchanged timeout; the overall live suite exits `0`.

- [ ] **Step 5: Record durable verification evidence**

Create `docs/audits/2026-07-13-tcp-receive-and-intake-hardening-verification.md` with these headings and actual results only: `Scope And Commits`, `Node Rotation`, `C++ Automation`, `UE 5.3/5.6/5.7 Win64 BuildPlugin`, `Fixture Packaging`, `Selected Target Deploy`, `Live Fault Matrix`, `AnimGraph Baseline`, `Fresh Log Segment`, `Platform Boundary`, and `Residual Follow-Ons`. Record command/exit status, test totals, package paths and fixture checks, deployed versions/hashes, live probe outcomes, appended log byte offsets, response bytes/timing, and explicit Mac/Linux non-execution. Do not paste request/response bodies or machine secrets.

```powershell
git add docs/audits/2026-07-13-tcp-receive-and-intake-hardening-verification.md
git commit -m "Record TCP hardening verification evidence"
```

- [ ] **Step 6: Inspect the final working tree**

Confirm the smoke's captured segment has one-owner warnings, no payload body previews, and no crash/assert/ensure. Then run:

```powershell
git status --short
git diff --check HEAD
git log --oneline -10
```

Expected: the worktree is clean, whitespace check is clean, and task plus evidence commits are present. Do not commit generated logs, packaged plugins, target-project binaries, or machine-local target configuration.

---

## Acceptance Traceability

| Approved requirement | Proof task |
| --- | --- |
| Exact `Recv` result/error classification; no receive `GetConnectionState` | Tasks 4 and 6 |
| Strict 512-byte raw-ASCII framing in both runtimes | Tasks 1, 2, and 5 |
| 8 MiB request limits and pre-connect Node rejection | Tasks 2, 3, 5, and 7 |
| Strict RFC 3629 UTF-8, one BOM, one root object, one parse | Tasks 1, 2, and 5 |
| Linear legacy scanning and one completion concat | Tasks 2, 3, and 5 |
| Server 2-second idle / 10-second total deadlines | Tasks 6 and 7 |
| Node absolute caller deadline and stable payload-free errors | Tasks 3 and 7 |
| Centralized response/log policy and one-owner `SendAll` warning | Tasks 6 and 7 |
| Shared fixtures survive sync and BuildPlugin packaging | Tasks 5 and 9 |
| Large AnimGraph response remains supported without a response cap/override | Tasks 7 and 9 |
| UE 5.3/5.6/5.7 Win64 compile; Mac/Linux boundary honest | Tasks 8 and 9 |
| Lockstep `1.0.17` / version `18` deployment bust | Tasks 8 and 9 |

## Deferred Follow-Ons

Do not absorb response-size telemetry/capping, concurrent client handling, legacy-framing removal, generic headless MCP execution, HTTP body-policy unification, Mac/Linux build/runtime proof, or persistent headless service work into this implementation. Record any evidence discovered for those lanes without changing this slice's acceptance gate.

## Post-Approval Implementation Erratum

This is a post-approval implementation correction, not a retroactive planning input. Installed UE 5.3, 5.6, and 5.7 readers share permissive handling of unescaped C0 string controls, case-variant literals, object close after a colon, and array close after a comma; audit found no portable strict flag or parser across those engines. Unreal already rejected an object trailing comma.

The implemented bounded lexical compatibility guard rejects those documented permissive forms before acceptance and uniformly treats a comma before either closer as invalid while retaining one FJsonSerializer::Deserialize call for every parser-eligible completed candidate. Unreal still owns escaping, number grammar, nesting, and DOM materialization. This guard is not the retired handwritten grammar parser. The shared corpus preserves `{"x":}` as the known differential and records separate parser-invalid, raw-NUL, case-variant-literal, and trailing-comma cases for both runtimes.
