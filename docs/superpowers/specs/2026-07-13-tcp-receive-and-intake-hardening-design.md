# TCP Receive And Request Intake Hardening Design

## Status

Approved design boundary: combine receive-state hardening and full request-intake hardening. This document is the pre-implementation specification. Production code must not change until this spec is reviewed and approved.

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

The intake path also has these adjacent weaknesses:

- `FCString::Atoi` accepts signs, trailing junk, and ambiguous overflow behavior for `Content-Length`.
- `MaxHeaderBytes` limits only the search span; it does not reject an unterminated oversized header.
- No request-body or legacy-request size cap is enforced.
- A malformed or trickled connection can monopolize the single serial accept/dispatch loop for the full 10-second timeout.
- Complete malformed JSON cannot reach the code path that reports `failed to parse request JSON` because `bRequestComplete` is set only after a successful parse.
- Shutdown can fall through the same incomplete-request path unless it is represented as a distinct outcome.

## Goals

- Classify data, temporary no-data, graceful peer close, interrupted receive, and hard socket failure without stale-error misattribution.
- Make framing decisions strict, bounded, overflow-safe, and independently testable.
- Bound memory use and head-of-line blocking in the connect-per-command server.
- Return accurate structured errors when the peer is still available to receive them.
- Emit at most one actionable warning for each failed receive or send lifecycle.
- Preserve valid framed requests, legacy unframed JSON requests, response framing, and all command-registry behavior.

## Non-Goals

- Persistent connections or multiple requests per connection.
- Authentication, encryption, or non-loopback exposure changes.
- A concurrent worker pool or asynchronous command dispatch.
- Handler execution timeouts or cancellation after a valid request has dispatched.
- A response payload cap. Large read responses such as AnimGraph topology remain valid.
- Removal of legacy unframed request compatibility.
- Generic headless MCP execution.

## Design Decision

Extract request intake from the current boolean-heavy loop into a private transport-policy seam. The seam owns native socket-attempt classification and byte-oriented framing policy; `ServeOneConnection` owns command dispatch and maps one terminal read result to one response/log action.

The implementation should use a private helper such as:

`plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.h`

A matching `.cpp` is preferred for platform-specific error capture and non-trivial parsing. Pure types and functions remain in the private namespace `UEMCP::Private` so C++ automation tests in the same module can exercise behavior without opening a real socket.

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

Replace `DetectFraming`'s output booleans with a result that can represent:

- `Pending`: more bytes are required to decide or finish the header.
- `Legacy`: the bytes do not begin with the framing prefix.
- `Framed`: a complete valid header declares a bounded body length.
- `Malformed`: the framing prefix is present but the header is invalid.
- `TooLarge`: the header or declared body exceeds policy.

Parse framing directly over raw bytes. Do not convert the header to `TCHAR` and then reuse character offsets as byte offsets.

### Header Grammar

- A framed request begins with `Content-Length:` at byte zero, matched case-insensitively.
- A partial byte-for-byte prefix remains `Pending`; the first mismatch selects `Legacy`.
- The complete header, including `\r\n\r\n`, must fit within 512 bytes.
- If no complete terminator exists when the accumulator reaches 512 bytes, the header is already `Malformed`; waiting for another byte would necessarily violate the cap.
- Header lines use ASCII and CRLF termination.
- The first line contains exactly one `Content-Length` field.
- After trimming optional ASCII space or tab around the value, the value contains one or more decimal digits only.
- Signs, empty values, suffixes, embedded whitespace, duplicate `Content-Length` fields, malformed additional lines, non-ASCII header bytes, and integer overflow are rejected.
- Well-formed additional header fields may be ignored for LSP/DAP compatibility, but they remain subject to the total header cap and cannot redefine `Content-Length`.

Length parsing must accumulate digits with a cap-aware checked operation. A syntactically valid decimal value above the body limit is `TooLarge`, not wrapped or truncated.

### Size Limits

- Maximum framed header: 512 bytes including its terminator.
- Maximum framed body: 8 MiB.
- Maximum legacy unframed request: 8 MiB.

Check limits before appending or reserving additional accumulator storage. Use overflow-safe arithmetic for `bodyOffset + bodyLength`.

Once the declared framed body is present:

- Parse exactly the declared body bytes as one JSON object.
- Reject bytes already accumulated beyond the declared body as `MALFORMED_REQUEST`.
- Never dispatch a second frame on the same connection.

The server may complete a frame before later network bytes arrive. Because the protocol closes after one response, such later bytes are not dispatched and cannot become a second request.

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

These limits bound a silent connection to about 2 seconds and a slow trickle connection to 10 seconds in the current serial server.

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

- The Node client continues to send `Content-Length: <bytes>\r\n\r\n<body>` and requires no change.
- Header-name matching remains case-insensitive.
- Legacy unframed JSON remains accepted within the new size and timeout limits.
- Successful responses remain Content-Length framed.
- One request per connection remains the protocol.
- Public tools, command names, request envelopes, and handler semantics do not change.
- The shorter idle timeout applies only while reading an incomplete request; it does not constrain handler execution.

## Test Strategy

### C++ Automation Tests

Add focused tests under `plugin/UEMCP/Source/UEMCP/Private/Tests/UEMCPTests.cpp` for the pure policy seam:

- positive-byte data, true/zero wait, false/no-error EOF, retryable errors, reset, and another hard error;
- proof that an explicitly cleared/captured no-error result cannot inherit an earlier reset in the classifier;
- pending prefix, legacy mismatch, valid case-insensitive framed header, and optional well-formed additional header;
- empty, signed, suffixed, whitespace-corrupted, duplicate, non-ASCII, and overflowed lengths;
- unterminated and terminated headers at the 512-byte boundary;
- framed and legacy payloads at and above 8 MiB;
- exact body completion, incomplete body, invalid JSON, and already-buffered trailing bytes;
- idle timeout, total timeout, progress reset, and total-timeout dominance;
- server stop as a quiet terminal outcome.

Tests must be written red-first before implementation.

### Node And Source Contract Tests

Extend `server/test-mock-seam.mjs` only where it verifies the C++ integration boundary:

- `ServeOneConnection` consumes explicit read outcomes.
- the old `FCString::Atoi` framing parse is absent;
- header and request limits are wired to the read path;
- the caller does not duplicate `SendAll`'s failure warning.

Behavioral parser assertions belong in compiled C++ tests, not regex-only source guards.

### Live Editor Smoke

Add or extend an opt-in transport smoke that records only the new `LogUEMCP` segment while issuing sequential localhost probes:

1. Clean connect/close: no warning and no `socket error 0`.
2. Partial framed close: exactly one incomplete-request warning and no send attempt.
3. Reset: exactly one receive-error warning with `SE_ECONNRESET`/26.
4. Clean connect/close immediately after the reset: no warning and no inherited reset code.
5. Complete invalid framed JSON: one accurate `MALFORMED_REQUEST` response and one warning.
6. Invalid length and oversized declaration: typed errors without dispatch.
7. Response-side reset: one detailed send warning, not two.
8. Valid framed `ping`: success after every failure probe.
9. Existing AnimGraph live smoke: no transport regression on a large valid response.

The log assertion must inspect bytes appended after the smoke starts so historical warnings cannot create false failures.

## Deployment And Versioning

This is a plugin C++ behavior change. Implementation must:

- bump `manifest.json` from `1.0.16` to `1.0.17`;
- bump `plugin/UEMCP/UEMCP.uplugin` from Version 17 / `1.0.16` to Version 18 / `1.0.17`;
- update the stale public `MCPServerRunnable.h` protocol comment to describe framed responses, framed and legacy requests, bounded intake, and connect-per-command behavior;
- update the current TCP wire description in `CLAUDE.md` and `docs/specs/architecture.md` with the header, request-size, idle-timeout, and total-timeout contracts; do not rewrite the archival port-55557 `docs/specs/tcp-protocol.md` as though it described UEMCP;
- run `npm test` from `server/`;
- build and run focused UEMCP automation tests against a synced project with the editor closed;
- compile the transport change on the supported local UE 5.3, 5.6, and 5.7 Win64 baselines; keep Windows and POSIX includes fully platform-guarded, and record Mac/Linux runtime verification as unavailable unless those hosts are actually exercised;
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

### A Slow Sender Can Still Hold The Serial Server

Severity: High.

Mitigation: Use both a 2-second progress-based idle timeout and an absolute 10-second receive deadline. Concurrency is a separate architectural follow-on.

### Error Responses Can Cause Secondary Noise

Severity: Medium.

Mitigation: Never respond after EOF or receive error. For active parser/limit/timeout rejection, let `SendAll` exclusively own any failed-write warning.

### Strict Parsing Can Break Existing Clients

Severity: Medium.

Mitigation: Preserve the emitted Node framing exactly, retain case-insensitive header names, allow bounded well-formed additional headers, and keep bounded legacy JSON. Verify both client forms live.

### A Large Response Can Be Mistaken For A Large Request

Severity: Medium.

Mitigation: Apply 8 MiB only to request intake. Do not cap response payloads in this slice; prove AnimGraph topology still returns successfully.

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
- Response-size telemetry or streaming if large read surfaces outgrow the current send-all model.
- Fuzz/property testing of the byte parser beyond the deterministic malformed-input matrix.
- Authentication and bind-address policy if UEMCP is ever exposed beyond localhost.

## Evidence And References

- `plugin/UEMCP/Source/UEMCP/Private/MCPServerRunnable.cpp` contains the current receive loop, loose framing parser, timeout, and duplicate send warning.
- `plugin/UEMCP/Source/UEMCP/Public/MCPServerRunnable.h` contains the stale protocol description.
- UE 5.6 `Runtime/Sockets/Private/BSDSockets/SocketsBSD.cpp`, `FSocketBSD::Recv`, confirms stream EOF returns false and native `would block` is normalized to true/zero.
- Installed UE 5.3, 5.6, and 5.7 `FSocketBSD::Recv` implementations use the same EOF, retry, and byte-normalization logic, so the receive classifier addresses the repo's full local engine baseline rather than one version only.
- UE 5.6 `Runtime/Sockets/Public/Sockets.h`, `FSocket::Recv`, documents that true/zero can mean no data and false means closed or unrecoverable error.
- UE 5.6 `Runtime/Sockets/Private/Windows/SocketSubsystemWindows.cpp` maps native zero to `SE_NO_ERROR` and `WSAECONNRESET` to `SE_ECONNRESET`.
- Microsoft `recv` documentation confirms zero means graceful close and `SOCKET_ERROR` requires immediate last-error inspection: https://learn.microsoft.com/en-us/windows/win32/api/winsock/nf-winsock-recv
- Microsoft `WSAGetLastError` documentation confirms the value is thread-local, should follow the failing call immediately, and can remain unchanged by successful calls: https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-wsagetlasterror
- Microsoft `WSASetLastError` documentation confirms the calling thread's Winsock error can be explicitly reset before the receive attempt: https://learn.microsoft.com/en-us/windows/win32/api/winsock/nf-winsock-wsasetlasterror
- Epic `FSocket::Recv` API reference: https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Sockets/FSocket/Recv
