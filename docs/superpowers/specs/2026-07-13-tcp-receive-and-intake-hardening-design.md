# TCP Transport Intake Hardening Design

## Status

Third-pass verification revision awaiting approval. The earlier server receive/request boundary is expanded to the matching Node response-intake surface because source verification found the same framing, UTF-8, and repeated-parse weaknesses in both directions. Pre-planning linkage, fixture-packaging, timeout, and platform questions are now resolved below. This document remains a pre-implementation specification. Production code must not change until the revised boundary is reviewed and approved.

## Problem

`FMCPServerRunnable::ServeOneConnection` currently conflates several terminal and non-terminal socket outcomes, and its framing parser leaves declared safety limits unenforced.

Live probes against the UE 5.6 editor server established these distinct cases:

- A client that connects and closes cleanly produces `recv failed: socket error 0`.
- A client that sends a partial frame and closes cleanly produces the same misleading warning.
- A client reset produces socket error 26 (`SE_ECONNRESET`).
- A complete framed body containing invalid JSON is logged twice and returned as an incomplete request rather than a parse failure.
- A valid request followed by a client reset before response receipt emits both a detailed `SendAll` warning and a redundant `failed to send response` warning.
- A valid framed `ping` still succeeds after each probe, so the observed failures are request-lifecycle and diagnostics defects rather than server death.

The receive defect is deeper than one bad log line. UE 5.6 stream sockets normalize native nonblocking `would block` into `Recv(true, 0)`, while both graceful EOF and hard receive errors return `Recv(false, 0)`. Native last-error state is thread-local and may remain stale after a successful zero-byte `recv`, so consulting it after EOF without first establishing a clean capture boundary can attribute an earlier connection's error to a later clean close.

The C++ request-intake path also has these adjacent weaknesses:

- `FCString::Atoi` accepts signs, trailing junk, and ambiguous overflow behavior for `Content-Length`.
- `MaxHeaderBytes` limits only the search span; it does not reject an unterminated oversized header.
- No request-body or legacy-request size cap is enforced.
- A malformed or trickled connection can monopolize the single serial accept/dispatch loop for the full 10-second timeout.
- Complete malformed JSON cannot reach the code path that reports `failed to parse request JSON` because `bRequestComplete` is set only after a successful parse.
- Legacy JSON is converted and reparsed after each received chunk, making fragmented large requests quadratic in bytes copied and parsed.
- `FUTF8ToTCHAR` can substitute invalid input rather than proving the body is well-formed UTF-8 before JSON parsing.
- Shutdown can fall through the same incomplete-request path unless it is represented as a distinct outcome.

Source verification found the symmetric failure surface in `server/connection-manager.mjs`:

- `_detectResponseFraming` uses permissive `parseInt`, does not enforce the 512-byte unterminated-header boundary, and falls back to legacy JSON after malformed framed input.
- The data handler runs `Buffer.concat(chunks)` for every chunk and retries `JSON.parse` over the entire legacy accumulator, producing quadratic copying and parsing.
- A framed response silently ignores bytes already buffered after the declared body.
- `Buffer.toString('utf8')` substitutes replacement characters for malformed UTF-8 instead of rejecting the wire payload explicitly.
- The client does not reject an outgoing serialized request above the server's proposed 8 MiB limit before opening or writing the socket.

Hardening only the server would therefore leave protocol interpretation asymmetric and allow the same malformed-input classes to survive on responses.

## Goals

- Classify data, temporary no-data, graceful peer close, interrupted receive, and hard socket failure without stale-error misattribution.
- Make request and response framing decisions strict, bounded, overflow-safe, and independently testable.
- Validate body UTF-8 before either runtime converts or parses JSON.
- Detect one complete legacy JSON object in linear time and parse it exactly once.
- Bound memory use and head-of-line blocking in the connect-per-command server.
- Reject oversized outgoing requests locally before any socket write.
- Drive both runtime implementations from one language-neutral contract fixture so edge behavior cannot drift silently.
- Return accurate structured errors when the peer is still available to receive them.
- Emit at most one actionable warning for each failed receive or send lifecycle.
- Preserve valid framed requests, legacy unframed JSON requests, response framing, and all command-registry behavior.

## Non-Goals

- Persistent connections or multiple requests per connection.
- Authentication, encryption, or non-loopback exposure changes.
- A concurrent worker pool or asynchronous command dispatch.
- Handler execution timeouts or cancellation after a valid request has dispatched.
- A response body cap. Large read responses such as AnimGraph topology and visual-capture payloads remain valid.
- Removal of legacy unframed request compatibility.
- Removal of legacy unframed response compatibility during mixed-version deployment windows.
- Generic headless MCP execution.

## Design Decision

Treat TCP intake as one bidirectional protocol contract with separate idiomatic implementations:

1. A private C++ receive-attempt shim captures and classifies the exact native result around `FSocket::Recv`.
2. A private C++ `FMCPRequestDecoder`-style helper consumes request chunks and owns framing mode, limits, UTF-8 validation, legacy-object boundary state, and typed terminal outcomes.
3. A focused Node module such as `server/tcp-transport.mjs` consumes response chunks under the same framing, UTF-8, and object-boundary contract.
4. The Node send path preflights the serialized UTF-8 request against the server's request-body limit before connecting or writing.
5. One language-neutral fixture corpus defines the shared protocol cases consumed by C++ automation and Node tests.

`ServeOneConnection` remains responsible for socket waiting, command dispatch, and mapping one terminal request-read result to one response/log action. `tcpCommand` remains responsible for socket lifecycle, timing metrics, and mapping one terminal response-decode result to promise resolution or rejection. Neither orchestrator reparses accumulated transport bytes.

The implementation should use a private helper such as:

`plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.h`

A matching `.cpp` is preferred for platform-specific error capture and non-trivial parsing. Pure types and functions remain in the private namespace `UEMCP::Private` so C++ automation tests in the same module can exercise behavior without opening a real socket. The Node decoder is exported only as a private test seam, not as part of the MCP tool API.

The implementations do not share executable parser code across languages. They share observable policy and test vectors, which avoids a cross-runtime abstraction while still preventing semantic drift.

## Alternatives Rejected

- **Harden only C++ request intake:** smaller, but leaves permissive framing, replacement UTF-8 decoding, trailing-byte acceptance, and quadratic work on Node responses. This fails protocol parity.
- **Share one executable parser across C++ and Node:** removes duplication but introduces a foreign-function or generated-code boundary into a small transport layer. Shared policy vectors provide most of the drift protection without that operational cost.
- **Keep parse-until-success for legacy JSON:** simple but cannot distinguish incomplete from malformed input without repeated whole-buffer parsing. The boundary scanner preserves legacy compatibility with linear work.
- **Remove legacy framing now:** simplifies both decoders but breaks mixed-version deployment and existing compatibility guarantees. Removal requires a separately measured deprecation plan.
- **Add an arbitrary response cap:** bounds client memory but risks breaking large topology and visual-capture responses without production size evidence. This slice removes amplification and adds a total deadline; telemetry precedes any cap.

## Receive Attempt Contract

Represent one receive attempt with an explicit action:

```cpp
enum class EMCPReceiveAction : uint8
{
	ConsumeData,
	Wait,
	PeerClosed,
	SocketError
};
```

The pure classifier consumes `bRecvSucceeded`, `BytesRead`, and the socket error captured for that exact attempt:

| `Recv` result | bytes | captured error | action |
| --- | ---: | --- | --- |
| `true` | `> 0` | any | `ConsumeData` |
| `true` | `0` | any | `Wait` |
| `false` | `0` | `SE_NO_ERROR` | `PeerClosed` |
| `false` | `0` | `SE_EWOULDBLOCK` or `SE_EINTR` | `Wait` |
| `false` | `0` | any other error | `SocketError` |

Negative byte counts are not expected from UE's public `FSocket::Recv` implementation because it normalizes native failures to zero before returning. If a supported engine version exposes a negative count, classify it as `SocketError` unless the captured error is retryable.

### Authoritative Error Capture

Do not call `GetConnectionState()` to distinguish EOF. UE's BSD socket implementation can report a recently closed stream as connected for a grace period, so it is not an immediate FIN oracle.

Do not read an unconstrained last-error value after `Recv(false, 0)`. Isolate native error capture around the receive call:

1. Clear the current thread's native socket error immediately before `FSocket::Recv`.
2. Call `Recv` exactly once.
3. If it returns false, snapshot the native socket error immediately.
4. Translate that captured integer through `ISocketSubsystem::TranslateErrorCode`.
5. Pass the translated value to the pure classifier.

Use `WSASetLastError(0)` / `WSAGetLastError()` on Windows and `errno = 0` / `errno` on POSIX platforms. Keep these APIs behind one small platform shim. Guard a missing socket subsystem and report one `SocketError` result rather than dereferencing null.

This capture boundary is required because UEMCP supports Win64, Mac, and Linux, while the public `FSocket` result alone does not distinguish EOF from an unrecoverable receive error.

## Framing Contract

Replace both `DetectFraming` and `_detectResponseFraming` booleans with incremental decoder results that can represent:

- `Pending`: more bytes are required to decide or finish the header.
- `Legacy`: the bytes do not begin with the framing prefix.
- `Framed`: a complete valid header declares a bounded body length.
- `Malformed`: the framing prefix is present but the header is invalid.
- `TooLarge`: a syntactically valid declared request body exceeds policy.

Parse framing directly over raw bytes in both runtimes. Do not convert the header to text before validating its ASCII grammar, and do not reuse character offsets as byte offsets.

### Header Grammar

- A framed message begins with `Content-Length:` at byte zero, matched case-insensitively.
- A partial byte-for-byte prefix remains `Pending`; the first mismatch selects `Legacy`.
- The complete header, including `\r\n\r\n`, must fit within 512 bytes.
- If no complete terminator exists when the accumulator reaches 512 bytes, the header is already `Malformed`; waiting for another byte would necessarily violate the cap.
- Header lines use ASCII and CRLF termination.
- The first line contains exactly one `Content-Length` field. This preserves the currently emitted UEMCP framing discriminator; optional fields may follow it.
- After trimming optional ASCII space or tab around the value, the value contains one or more decimal digits only.
- Signs, empty values, suffixes, embedded whitespace, duplicate `Content-Length` fields, malformed additional lines, non-ASCII header bytes, and integer overflow are rejected.
- Well-formed additional header fields may be ignored for LSP/DAP compatibility, but they remain subject to the total header cap and cannot redefine `Content-Length`. A well-formed additional line has a non-empty ASCII alphanumeric/hyphen name, a separating colon, optional space/tab before and after a value containing printable ASCII or tab, and no line folding or other control bytes. Colons inside the value are data, not new separators.

Length parsing must accumulate digits with checked arithmetic. On request intake, a syntactically valid decimal value above the body limit is `TooLarge`, not wrapped or truncated. On Node response intake, the value must be a non-negative `Number.isSafeInteger`; an unsafe or overflowed declaration is `Malformed`. The response decoder must not reserve or preallocate the declared body size.

### Size Limits

- Maximum framed header in either direction: 512 bytes including its terminator.
- Maximum framed request body: 8 MiB.
- Maximum legacy unframed request: 8 MiB.

Check limits before appending or reserving additional accumulator storage. Use overflow-safe arithmetic for `bodyOffset + bodyLength`.

The Node client computes request size from the serialized UTF-8 `Buffer`, not JavaScript character count. A body above 8 MiB fails locally with typed `REQUEST_TOO_LARGE` context before `net.createConnection` or `socket.write`. Exactly 8 MiB remains valid.

No response-body cap is introduced in this slice. The Node decoder retains received chunks and never preallocates from an untrusted declaration, while the existing socket deadline bounds a stalled response. Response-size telemetry and a data-backed cap remain follow-ons because current tools can return large topology and base64 capture payloads.

Once a declared framed body is present in either direction:

- Parse exactly the declared body bytes as one JSON object.
- Reject bytes already accumulated beyond the declared body as `MALFORMED_REQUEST` on the server or a typed malformed-response error on the client.
- Never dispatch a second frame on the same connection.

Either decoder may complete a frame before later network bytes arrive. Because the protocol closes after one response, such later bytes are not dispatched or resolved and cannot become a second message.

## JSON Body Contract

UEMCP request and response envelopes are one JSON object, not an arbitrary JSON scalar or root array.

- Validate the complete body as strict UTF-8 before conversion or JSON parsing.
- Strict validation follows RFC 3629: reject overlong encodings, surrogate code points, values above U+10FFFF, forbidden lead bytes, lone continuation bytes, malformed continuations, and truncated sequences.
- Accept at most one leading UTF-8 BOM and remove it before boundary scanning or parsing. This is the same in both runtimes; senders continue to emit no BOM.
- After the optional BOM, permit only RFC 8259 JSON whitespace (`0x20`, `0x09`, `0x0A`, `0x0D`) before and after the root object.
- Reject malformed UTF-8 before `FUTF8ToTCHAR`, `FJsonSerializer`, `Buffer.toString`, or `JSON.parse` sees the payload.
- Parse the complete object exactly once with Unreal's JSON serializer or `JSON.parse`; the transport scanner does not replace either JSON parser.
- Require the parsed root value to be an object before dispatch or promise resolution.
- Do not include raw request or response bodies in logs or thrown error messages. Diagnostics carry direction, framing mode, byte counts, declared length, parser category, and sanitized socket error context only.

The explicit BOM rule follows RFC 8259's interoperability allowance while keeping send behavior strict. Two BOMs, a BOM after leading whitespace, or a partial BOM at terminal EOF are malformed.

### Incremental Legacy Object Boundary

Legacy unframed compatibility must not depend on reparsing the full accumulator after every chunk. Each runtime maintains a small byte-oriented state machine and scans every received byte at most once:

1. Recognize an optional leading UTF-8 BOM, then skip permitted JSON whitespace.
2. Require `{` as the root token.
3. Track a stack of `{` and `[` delimiters, JSON string state, and backslash escape state.
4. Ignore structural bytes while inside a string and reject mismatched closing delimiters.
5. When the root `}` closes, permit only JSON whitespace in bytes already buffered after it; any other trailing byte is malformed.
6. Validate UTF-8 and invoke the real JSON parser once, only after the boundary scanner reports a complete candidate object.

The scanner determines completeness, not full JSON validity. Invalid escape syntax, numbers, literals, and other grammar errors are left to the authoritative JSON parser after the candidate boundary is complete. This preserves compatibility while removing quadratic parse work.

For framed bodies, `Content-Length` supplies the boundary, so the legacy scanner is not required. The same UTF-8, BOM, root-object, exact-body, and one-parse rules still apply.

## Read Lifecycle Contract

Return one terminal request-read outcome rather than coordinating `bFramed`, `bRequestComplete`, and `bPeerClosed` flags:

- `Complete`
- `Malformed`
- `TooLarge`
- `IdleTimeout`
- `TotalTimeout`
- `PeerClosed`
- `SocketError`
- `ServerStopping`

The result carries the parsed object when complete plus diagnostic fields needed by one centralized log: bytes received, framing mode, declared body length when known, elapsed time, and captured socket error when relevant.

### Time Limits

- Receive idle timeout: 2 seconds since the last positive-byte receive.
- Total receive timeout: 10 seconds from connection acceptance.
- Positive bytes reset only the idle clock, never the total clock.
- Readiness notifications, zero-byte receives, and retries do not count as progress.
- Wait for at most the smallest of 50 ms, remaining idle time, and remaining total time so shutdown and timeout checks remain responsive.
- Measure both deadlines with a monotonic clock so wall-clock adjustment cannot extend or prematurely expire intake.

These limits bound a silent connection to about 2 seconds and a slow trickle connection to 10 seconds in the current serial server.

## Node Response Intake Contract

The Node decoder consumes each socket chunk incrementally and returns one of `Pending`, `Complete`, or `Malformed`. Socket close, timeout, and error remain `tcpCommand` lifecycle outcomes, but they query decoder progress to distinguish no response, incomplete header, incomplete framed body, and incomplete legacy object.

Implementation constraints:

- Keep only the bounded undecided/header prefix contiguous while framing is unresolved.
- After framing is known, retain body segments and byte counts without running `Buffer.concat(chunks)` on each `data` event.
- For legacy responses, feed only newly arrived bytes to the boundary state machine.
- Concatenate the exact candidate body at most once, after completion, for UTF-8 validation and JSON parsing.
- Reject malformed framed headers rather than falling back to legacy mode after the `Content-Length:` prefix has been confirmed.
- Reject already-buffered bytes beyond a declared framed body.
- Treat the caller-provided `timeoutMs` as an absolute command deadline from connection initiation; socket activity must not reset it indefinitely. The existing socket inactivity timeout may remain as a backstop. Preserve the configured value and existing timing metrics, but parser failure details must not expose body content through `metrics.err`.
- Preserve legacy unframed responses for mixed-version deployment compatibility.

`_detectResponseFraming` may be replaced by the decoder rather than retained as a second parser. Focused tests should exercise the decoder's public test seam so production and tests use the same implementation.

Node transport failures remain `Error` instances and add stable `code` values: `REQUEST_TOO_LARGE`, `NO_RESPONSE`, `INCOMPLETE_RESPONSE`, `MALFORMED_RESPONSE`, `RESPONSE_TIMEOUT`, and `SOCKET_ERROR`. Messages retain the `TCP:<port>` context but contain no payload preview. Optional structured details are limited to direction, framing mode, byte counts, declared length, timeout, and native socket code.

## Response And Logging Contract

Transport helpers return outcomes; they do not emit warning-level logs. `ServeOneConnection` maps each outcome once:

| outcome | response attempt | warning policy |
| --- | --- | --- |
| `Complete` | dispatch normally | none from intake |
| `Malformed` | `MALFORMED_REQUEST` | one warning with reason and byte counts |
| `TooLarge` | `REQUEST_TOO_LARGE` | one warning with observed/declared limit |
| `IdleTimeout` / `TotalTimeout` | `REQUEST_TIMEOUT` | one warning naming timeout kind and progress |
| `PeerClosed`, zero bytes | none | verbose only |
| `PeerClosed`, partial bytes | none | one incomplete-request warning |
| `SocketError` | none | one warning with translated error and progress |
| `ServerStopping` | none | no warning |

Only parser/limit/timeout outcomes detected while the socket is still active attempt an error response. Peer-close and receive-error outcomes never try to write to a dead or indeterminate peer.

Complete framed invalid JSON must report that parsing failed, not that the request was incomplete. A partial frame that reaches EOF must report closure with partial progress, not a JSON parse failure.

`SendAll` owns the one detailed warning for a failed response write, including bytes sent and translated error. Its caller must not emit the additional generic `failed to send response` warning. Successful and expected lifecycle details remain verbose.

## Compatibility

- The Node client continues to send `Content-Length: <bytes>\r\n\r\n<body>`; only local size preflight and response decoding change.
- Header-name matching remains case-insensitive.
- Legacy unframed request JSON remains accepted within the new size and timeout limits.
- Legacy unframed response JSON remains accepted during mixed-version deployment windows.
- Successful responses remain Content-Length framed.
- One request per connection remains the protocol.
- Public tools, command names, request envelopes, and handler semantics do not change.
- The shorter idle timeout applies only while reading an incomplete request; it does not constrain handler execution.

## Shared Contract Fixture

Add one compact language-neutral corpus at:

`plugin/UEMCP/Resources/Tests/tcp-transport-cases.json`

Keeping the fixture under the plugin base directory makes it available to synced-project C++ tests through `IPluginManager::FindPlugin("UEMCP")->GetBaseDir()` and to Node tests through a repository-relative URL. `sync-plugin.bat` copies the complete plugin tree while excluding only `Binaries` and `Intermediate`. Installed UE 5.3, 5.6, and 5.7 `BuildPluginCommand.Automation.cs` each explicitly include `/Resources/...` in the package filter. This location therefore survives both normal target sync and the supported packaged-plugin path; no fallback relocation is required.

Each case describes encoded input bytes, chunk boundaries, optional small policy overrides, and expected decoder state or terminal result. Use ASCII strings for readable cases and base64 for arbitrary bytes. Small per-case limits exercise boundary behavior without checking an 8 MiB fixture into source; separate constant tests prove the production request limit is exactly 8 MiB.

The shared corpus covers:

- every split point across a partial framing prefix, header terminator, UTF-8 BOM, multibyte code point, escape pair, and closing delimiter;
- case-insensitive `Content-Length`, optional well-formed extra headers, and exact byte offsets;
- empty, signed, suffixed, whitespace-corrupted, duplicate, non-ASCII, and overflowed lengths;
- a terminated header exactly at 512 bytes and an unterminated header reaching 512 bytes;
- exact and over-limit request bodies under a small fixture policy;
- nested arrays/objects, braces inside strings, escaped quotes/backslashes, leading/trailing JSON whitespace, mismatched delimiters, concatenated objects, and trailing junk;
- valid multibyte UTF-8, truncated and malformed UTF-8, one accepted leading BOM, and rejected duplicate/misplaced BOMs;
- overlong sequences, surrogate encodings, out-of-range code points, forbidden lead bytes, and lone continuation bytes;
- exact framed body completion, incomplete body, and already-buffered trailing bytes.

Runtime-specific socket outcomes, clocks, logs, metrics, and production-limit constants remain in native tests. Shared vectors cover only deterministic byte-decoder policy.

## Pre-Planning Verification Resolutions

### Windows Socket Linkage

Do not add `ws2_32.lib` to `UEMCP.Build.cs`. Installed UE 5.3, 5.6, and 5.7 `UEBuildWindows.cs` each add `ws2_32.lib` to the Windows link environment globally. Keep `WinSock2.h` inside the private `.cpp` under `#if PLATFORM_WINDOWS`, wrapped by `Windows/AllowWindowsPlatformTypes.h`, `THIRD_PARTY_INCLUDES_START/END`, and `Windows/HideWindowsPlatformTypes.h`, matching the engine's `IcmpWindows.cpp` pattern. The POSIX branch includes `<cerrno>` only under its platform guard. All three Win64 builds remain required, but library ownership and include shape are resolved.

### Fixture Deployment

Use `plugin/UEMCP/Resources/Tests/tcp-transport-cases.json` without a packaging fallback. Source verification proves normal sync and each supported engine's `BuildPlugin` filter retain the complete `Resources` subtree. Native tests must fail loudly if `IPluginManager` cannot resolve the installed fixture; that is a test or deployment defect, not a reason to search alternate paths silently.

### Response Timeout Headroom

Keep the existing 10-second default and all existing evidence-based per-tool overrides unchanged. Do not add an AnimGraph or visual-capture override in this slice.

Evidence:

- The live `/Game/Actors/Character/ABP_DroppedCharacter` pre-topology response was 141,032 UTF-8 JSON bytes and completed under the current 10-second default.
- A disposable localhost probe through the current, still-quadratic Node parser completed framed responses of 1 MiB in 8.41 ms, 4 MiB in 46.65 ms, 16 MiB in 569.13 ms, and 32 MiB in 2,266.07 ms.
- The proposed decoder removes repeated whole-buffer concatenation and parsing, so response decoding should improve rather than consume the remaining deadline headroom.

The absolute deadline integration test and live AnimGraph smoke remain regression gates, not open timeout-policy decisions. A future override requires a measured legitimate command exceeding 10 seconds.

### Platform Proof Boundary

`UEMCP.uplugin` declares Win64, Mac, and Linux support, but this checkout has only Windows UE 5.3/5.6/5.7 installations and the repository's sole CI workflow runs Node rotation on `windows-latest` without building Unreal. Therefore:

- Win64 compile and runtime verification are required for this slice.
- Mac/Linux source branches must remain fully guarded and POSIX-correct.
- Mac/Linux compile/runtime status is explicitly **declared but unverified**, not an unresolved implementation choice and not a blocker to implementation planning.
- Promoting Mac/Linux to a verified release guarantee requires an Unreal-capable host or CI lane and remains a follow-on infrastructure decision.

## Test Strategy

### C++ Automation Tests

Add a focused `plugin/UEMCP/Source/UEMCP/Private/Tests/MCPServerTransportPolicyTests.cpp` rather than growing the existing general `UEMCPTests.cpp`. Exercise the pure policy seam with:

- positive-byte data, true/zero wait, false/no-error EOF, retryable errors, reset, and another hard error;
- proof that an explicitly cleared/captured no-error result cannot inherit an earlier reset in the classifier;
- every applicable shared fixture case, including all declared chunk boundaries;
- proof that the production framed and legacy request limits are exactly 8 MiB;
- valid UTF-8 reaches Unreal JSON parsing while invalid UTF-8 does not;
- one accepted leading BOM and rejected duplicate/misplaced BOMs;
- exact body completion, incomplete body, invalid complete JSON, and already-buffered trailing bytes;
- legacy candidate parsing occurs once at object completion rather than once per chunk;
- idle timeout, total timeout, progress reset, and total-timeout dominance;
- server stop as a quiet terminal outcome.

Tests must be written red-first before implementation.

### Node Decoder And Integration Tests

Add `server/test-tcp-transport.mjs` for the extracted response decoder and `tcpCommand` integration. The rotation runner auto-discovers `test-*.mjs`, so this file must remain in the default `npm test` lane rather than an opt-in exclusion:

- consume every applicable shared fixture case under every declared chunking pattern;
- prove malformed framed input never falls back to legacy after the framing prefix is confirmed;
- prove response length parsing rejects signs, suffixes, duplicates, and unsafe integers;
- prove invalid UTF-8 is rejected before `JSON.parse` and no raw body is included in the error;
- prove framed and legacy bodies are concatenated and parsed once at completion, not once per chunk;
- prove already-buffered framed trailing bytes are rejected;
- prove clean end distinguishes no response, incomplete header, incomplete body, and incomplete legacy object;
- prove periodic response bytes cannot extend the absolute `timeoutMs` deadline;
- prove an outgoing body exactly at 8 MiB can proceed while one byte above returns `REQUEST_TOO_LARGE` before connect/write;
- retain real-socket framed and legacy round trips, timeout behavior, timing metrics, and large topology/base64-shaped response coverage.

Instrumentation used to assert parse/concatenation counts belongs in the decoder's test seam and must not change production behavior.

### Source Contract Tests

Extend source-contract coverage only where it verifies integration wiring that behavioral tests cannot observe directly:

- `ServeOneConnection` consumes explicit read outcomes.
- The old `FCString::Atoi` framing parse is absent.
- Header and request limits are wired to the read path.
- The caller does not duplicate `SendAll`'s failure warning.
- `connection-manager.mjs` delegates response chunks to the extracted decoder and no longer concatenates/reparses the full response in its `data` handler.
- the outgoing request preflight occurs before socket construction or write.

Behavioral parser assertions belong in compiled C++ and executable Node tests, not regex-only source guards.

### Live Editor Smoke

Add or extend an opt-in transport smoke that records only the new `LogUEMCP` segment while issuing sequential localhost probes:

1. Clean connect/close: no warning and no `socket error 0`.
2. Partial framed close: exactly one incomplete-request warning and no send attempt.
3. Reset: exactly one receive-error warning with `SE_ECONNRESET`/26.
4. Clean connect/close immediately after the reset: no warning and no inherited reset code.
5. Complete invalid framed JSON: one accurate `MALFORMED_REQUEST` response and one warning.
6. Invalid UTF-8 and invalid length: typed errors without dispatch or payload echo.
7. Oversized declaration: `REQUEST_TOO_LARGE` without dispatch.
8. Response-side reset: one detailed send warning, not two.
9. Valid framed and legacy request `ping`: success after failure probes.
10. Existing AnimGraph live smoke: no transport regression on a large valid response or Node response decoding.

The log assertion must inspect bytes appended after the smoke starts so historical warnings cannot create false failures.

## Acceptance Criteria

The implementation slice is complete only when all of these are true:

- C++ and Node decoders pass the same shared fixture corpus for their applicable direction.
- Framing-prefix confirmation is irreversible: malformed framed input never falls back to legacy JSON.
- Header size, request size, and length arithmetic boundaries pass exact-at-limit and first-byte-over tests.
- The Node client rejects an over-8 MiB request before any connection or write side effect.
- Invalid UTF-8 reaches neither runtime's text conversion, JSON parser, command dispatch, nor response resolution.
- Legacy intake scans each byte once and invokes the authoritative JSON parser once per complete candidate.
- The Node `data` hot path does not concatenate or reparse all previously received bytes.
- A trickled response cannot extend the caller's absolute command deadline.
- Already-buffered bytes after a framed body are rejected in both directions.
- Clean close, partial close, reset, timeout, malformed input, and send failure produce the specified single-log behavior.
- Valid framed and legacy compatibility remains green, including a live `ping` and a large AnimGraph response.
- Server rotation, focused automation, supported Win64 builds, deployment verification, and opt-in live smoke all pass with recorded evidence.

## Deployment And Versioning

This is a plugin C++ and Node transport behavior change. Implementation must:

- bump `manifest.json` from `1.0.16` to `1.0.17`;
- bump `plugin/UEMCP/UEMCP.uplugin` from Version 17 / `1.0.16` to Version 18 / `1.0.17`;
- update the stale public `MCPServerRunnable.h` protocol comment to describe framed responses, framed and legacy requests, bounded intake, and connect-per-command behavior;
- update the current TCP wire description in `CLAUDE.md` and `docs/specs/architecture.md` with the shared header/UTF-8 contract, request-size preflight, response compatibility, idle timeout, and total timeout; do not rewrite the archival port-55557 `docs/specs/tcp-protocol.md` as though it described UEMCP;
- run `npm test` from `server/`;
- build and run focused UEMCP automation tests against a synced project with the editor closed;
- verify the shared fixture loads through `IPluginManager` after `sync-plugin.bat`; source verification already proves the supported `BuildPlugin` filters include `/Resources/...`;
- compile the transport change on the supported local UE 5.3, 5.6, and 5.7 Win64 baselines; keep Windows and POSIX includes fully platform-guarded, and record Mac/Linux runtime verification as unavailable unless those hosts are actually exercised;
- keep direct Winsock symbols behind the Windows shim and do not add a redundant `ws2_32.lib` entry to `UEMCP.Build.cs`; UBT already owns that Windows system-library dependency on all three supported engine baselines;
- sync, rebuild, relaunch, run `verify-deploy.bat`, and execute the transport plus AnimGraph live smokes.

## Adversarial Audit

### Stale Last Error Can Survive A Superficial Classifier

Severity: High.

Mitigation: Clear and capture native socket error around the exact `Recv` call. A classifier fed by an unconstrained later `GetLastErrorCode()` is not sufficient.

### Header Cap Can Remain Decorative

Severity: High.

Mitigation: Reject an unterminated framed header as soon as the accumulator reaches 512 bytes. A terminated header whose total length is exactly 512 bytes remains valid. Test both cases and the first byte beyond the boundary.

### Byte And Character Offsets Can Diverge

Severity: High.

Mitigation: Parse the ASCII header as bytes and reject non-ASCII header bytes. Never derive body byte offsets from `FString` character indices.

### One-Sided Hardening Can Preserve The Same Client Defect

Severity: High.

Mitigation: Apply the framing, exact-body, UTF-8, and legacy-boundary contract to C++ request intake and Node response intake in the same slice. Drive both from one shared fixture corpus.

### Replacement Decoding Can Hide Invalid Wire Bytes

Severity: High.

Mitigation: Validate UTF-8 over exact body bytes before either runtime converts to text. Fixture-test malformed, truncated, multibyte, and BOM cases. Do not infer validity from a successful replacement-tolerant conversion.

### Fragmentation Can Create Quadratic Work

Severity: High.

Mitigation: Scan each new legacy byte once, retain chunk segments, concatenate once at completion, and invoke the real JSON parser once. Add test-seam counters that fail if chunk count controls whole-buffer parse or concatenation count.

### A Slow Sender Can Still Hold The Serial Server

Severity: High.

Mitigation: Use both a 2-second progress-based idle timeout and an absolute 10-second receive deadline. Concurrency is a separate architectural follow-on.

### A Trickle Response Can Evade Node's Inactivity Timer

Severity: High.

Mitigation: Enforce `timeoutMs` as an absolute deadline from connection initiation in addition to any socket inactivity timer. Fixture the decoder separately and use a real-socket integration test for deadline behavior.

### An Absolute Deadline Can Reject A Legitimate Large Response

Severity: Medium.

Mitigation: Keep the existing 10-second default and evidence-based overrides. Current live and synthetic evidence provides substantial headroom, so add no speculative override. Retain the absolute-deadline and live AnimGraph regression tests; a future override requires a measured legitimate overrun. Do not revert to activity-reset semantics.

### Error Responses Can Cause Secondary Noise

Severity: Medium.

Mitigation: Never respond after EOF or receive error. For active parser/limit/timeout rejection, let `SendAll` exclusively own any failed-write warning.

### Strict Parsing Can Break Existing Clients

Severity: Medium.

Mitigation: Preserve the emitted Node framing exactly, retain case-insensitive header names, allow bounded well-formed additional headers, and keep bounded legacy JSON. Verify both client forms live.

### A Large Response Can Be Mistaken For A Large Request

Severity: Medium.

Mitigation: Apply 8 MiB only to request intake and Node request preflight. Do not cap response bodies in this slice; avoid declaration-based preallocation and prove AnimGraph topology still returns successfully.

### No Response Cap Can Still Allow Memory Growth

Severity: Medium.

Mitigation: Retain the existing socket deadline, avoid quadratic copies and declared-size preallocation, and add response-byte telemetry as a follow-on. A cap requires observed production distributions because topology and base64 capture responses are intentionally large.

### Shared Fixtures Can Become A Packaging-Only Failure

Severity: Medium.

Mitigation: Store the corpus under the plugin base directory and verify both sync and packaging preserve it. Fail tests with the resolved fixture path when it is missing; never skip the shared cases silently.

### Boundary Scanning Can Accidentally Become A Second JSON Parser

Severity: Medium.

Mitigation: Limit the scanner to root-object completion, delimiter/string/escape state, and trailing-byte detection. Delegate JSON grammar and root-object materialization to the platform parser exactly once.

### Diagnostics Can Leak Or Inject Payload Text

Severity: Medium.

Mitigation: Remove body previews from TCP parser errors and exclude raw TCP wire bytes from C++ logs, Node errors, and metrics. Emit bounded structural metadata only. Keep Remote Control HTTP error-body policy outside this slice because it has different caller-facing diagnostics.

### Direct Native Error Capture Can Break Non-Windows Builds

Severity: Medium.

Mitigation: Isolate platform headers and calls in one guarded translation unit and verify all local Win64 engine baselines. UBT already links `ws2_32.lib` globally, so do not duplicate it in the module. Record Mac/Linux as declared but unverified until an Unreal-capable host or CI lane exists.

### Shutdown Can Be Misreported As Client Failure

Severity: Medium.

Mitigation: Represent `ServerStopping` explicitly and exit without response or warning.

### Source Guards Can Give False Confidence

Severity: Medium.

Mitigation: Put parser and classifier behavior in compiled C++ automation tests and retain live socket/log probes. Source guards verify wiring only.

## Follow-Ons

- Connection identifiers or structured transport metrics if concurrent log correlation becomes necessary.
- Concurrent intake or a bounded worker queue if measured head-of-line blocking remains material after the new limits.
- Per-tool request-size metadata if a future command legitimately needs more than 8 MiB of input.
- Response-size telemetry, a data-backed cap, or streaming if large read surfaces outgrow the current send-all model.
- Fuzz/property testing of both byte decoders beyond the deterministic malformed-input matrix.
- Reuse of the contract-fixture pattern for other incremental intake surfaces, including Remote Control HTTP, if profiling or fault injection exposes equivalent drift.
- A separate Remote Control HTTP error-body/redaction audit. `httpCommand` intentionally surfaces bounded non-2xx bodies and also previews invalid-JSON bodies, so changing that diagnostic contract requires HTTP-specific usability and sensitivity tests rather than an incidental TCP edit.
- A generic headless MCP execution layer with transport parity after the live TCP contract is stable.
- Unreal-capable Mac/Linux CI or dedicated hosts if cross-platform compile/runtime verification becomes a release guarantee rather than a declared support target.
- Authentication and bind-address policy if UEMCP is ever exposed beyond localhost.

## Post-Approval Implementation Erratum

This records implementation evidence discovered after approval; it does not rewrite the decision record or imply the original approval knew these details. Installed UE 5.3, 5.6, and 5.7 readers share permissive extensions: unescaped C0 controls in strings, case-variant literals, an object close after a colon, and an array close after a comma. Unreal already rejected an object trailing comma. Source audit found no portable strict flag or parser across that engine baseline.

The accepted implementation therefore retains one FJsonSerializer::Deserialize call for each parser-eligible completed candidate and adds a bounded lexical compatibility guard for those documented permissive forms, with uniform rejection of a comma before either closer. It preserves escape, number, nesting, and DOM materialization in Unreal. The guard is not the retired handwritten grammar parser; it is a small platform-compatibility rejection layer required for Node parity. Shared fixtures retain `{"x":}` as the known differential and separately cover a parser-invalid object, raw NUL in a string, a case-variant literal, and an array trailing comma.

Live execution on 2026-07-14 also invalidated probe 14's first response chunk timing premise. On Windows loopback, kernel send buffering could accept the complete 1.21 MB AnimGraph response before Node observed its first chunk, so resetting at that point produced no `tcp_send_failure`. The corrected fixture holds the final request byte after the request prefix has settled, sends that byte, and resets on the next timer turn. On the verified Windows loopback runs this schedule produced a zero-byte `tcp_send_failure` before a successful final ping; the smoke now pins `bytesSent=0`, a response larger than 64 KiB, `reason=send_error`, and `SE_ECONNRESET`/26. This is not a platform-independent scheduling guarantee, so Mac/Linux and materially different TCP stacks remain explicit verification boundaries.

## Evidence And References

- `plugin/UEMCP/Source/UEMCP/Private/MCPServerRunnable.cpp` contains the current receive loop, loose framing parser, timeout, and duplicate send warning.
- `plugin/UEMCP/Source/UEMCP/Public/MCPServerRunnable.h` contains the stale protocol description.
- `server/connection-manager.mjs`, `_detectResponseFraming` and `tcpCommand`, contain permissive response-length parsing, per-chunk `Buffer.concat`, repeated legacy `JSON.parse`, replacement-tolerant UTF-8 conversion, body previews in errors, and no outgoing request-size preflight.
- `server/package.json` requires Node 22 or newer, so the implementation can use the official `node:buffer` `isUtf8` validator without widening the runtime baseline.
- `sync-plugin.bat` copies the full plugin tree and excludes only `Binaries` and `Intermediate`, so a plugin `Resources/Tests` fixture is retained by normal target sync.
- Installed UE 5.3, 5.6, and 5.7 `Engine/Source/Programs/AutomationTool/Scripts/BuildPluginCommand.Automation.cs` include `Filter.Include("/Resources/...")`, proving the shared fixture path is retained by supported plugin packaging.
- Installed UE 5.3, 5.6, and 5.7 `Engine/Source/Programs/UnrealBuildTool/Platform/Windows/UEBuildWindows.cs` add `ws2_32.lib` to every Windows link environment, so UEMCP does not need a duplicate module rule.
- `.github/workflows/rotation.yml` is Windows-only and explicitly does not build the Unreal plugin; no local Mac/Linux Unreal installation or CI proof lane exists.
- The prior live AnimGraph probe serialized 141,032 UTF-8 JSON bytes before pin topology under the 10-second default. A 2026-07-13 disposable localhost probe through current `ConnectionManager` measured 1/4/16/32 MiB framed responses at 8.41/46.65/569.13/2,266.07 ms respectively.
- UE 5.6 `Runtime/Sockets/Private/BSDSockets/SocketsBSD.cpp`, `FSocketBSD::Recv`, confirms stream EOF returns false and native `would block` is normalized to true/zero.
- Installed UE 5.3, 5.6, and 5.7 `FSocketBSD::Recv` implementations use the same EOF, retry, and byte-normalization logic, so the receive classifier addresses the repo's full local engine baseline rather than one version only.
- UE 5.6 `Runtime/Sockets/Public/Sockets.h`, `FSocket::Recv`, documents that true/zero can mean no data and false means closed or unrecoverable error.
- UE 5.6 `Runtime/Sockets/Private/Windows/SocketSubsystemWindows.cpp` maps native zero to `SE_NO_ERROR` and `WSAECONNRESET` to `SE_ECONNRESET`.
- UE 5.6 `Runtime/Core/Private/GenericPlatform/GenericPlatformString.cpp` confirms malformed UTF-8 conversion can emit a replacement code point, so conversion success is not strict validation.
- UE 5.6 `Runtime/Json/Public/Serialization/JsonReader.h` confirms the JSON reader rejects premature EOF and non-whitespace after a root value, supporting one authoritative parse after transport-level boundary detection.
- Microsoft `recv` documentation confirms zero means graceful close and `SOCKET_ERROR` requires immediate last-error inspection: https://learn.microsoft.com/en-us/windows/win32/api/winsock/nf-winsock-recv
- Microsoft `WSAGetLastError` documentation confirms the value is thread-local, should follow the failing call immediately, and can remain unchanged by successful calls: https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-wsagetlasterror
- Microsoft `WSASetLastError` documentation confirms the calling thread's Winsock error can be explicitly reset before the receive attempt: https://learn.microsoft.com/en-us/windows/win32/api/winsock/nf-winsock-wsasetlasterror
- Epic `FSocket::Recv` API reference: https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Sockets/FSocket/Recv
- Language Server Protocol 3.17 defines ASCII `name: value` headers with required `Content-Length`, optional `Content-Type`, CRLF separation, and UTF-8 content: https://microsoft.github.io/language-server-protocol/specifications/lsp/3.17/specification/
- RFC 8259 defines JSON text whitespace, requires UTF-8 for interoperable network exchange, permits parsers to ignore one leading BOM, and permits implementation size limits: https://www.rfc-editor.org/rfc/rfc8259
- Node's `buffer.isUtf8(input)` performs strict UTF-8 validation and is available before the repo's Node 22 minimum: https://nodejs.org/api/buffer.html#bufferisutf8input
- Node's `net.Socket.setTimeout` is explicitly an inactivity timeout, which supports adding a separate absolute `timeoutMs` deadline against trickle responses: https://nodejs.org/api/net.html#socketsettimeouttimeout-callback
- RFC 3629 defines valid one-to-four-byte UTF-8 sequences and explicitly excludes overlong forms, surrogate code points, and values beyond U+10FFFF: https://www.rfc-editor.org/rfc/rfc3629
