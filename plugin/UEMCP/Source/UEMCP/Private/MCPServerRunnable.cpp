// Copyright Optimum Athena. All Rights Reserved.
#include "MCPServerRunnable.h"
#include "Logging.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "Sockets.h"
#include "SocketSubsystem.h"
#include "Dom/JsonObject.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonReader.h"
#include "HAL/PlatformProcess.h"
#include "HAL/PlatformTime.h"

namespace
{
	constexpr int32 RecvBufferSize = 8192;
	constexpr int32 SocketBufferSize = 65536;
	// E-1 §5 hygiene fix: align server-side per-connection timeout with the client-side
	// 10s baseline (D121 widget overrides + D125/NEW-7 asset-mgmt overrides recorded
	// empirical durations >5s). Per-handler overrides on the JS side
	// (WIDGETS_TIMEOUT_OVERRIDES, M5_EDITOR_UTILITY_TIMEOUT_OVERRIDES) still extend
	// further for outliers; raising the server baseline matches the JS default and
	// removes the silent-success-on-disk trap class for handlers that exceed 5s.
	constexpr double PerConnectionTimeoutSec = 10.0;

	// E-1 §1 hygiene fix: wire framing constants. Incoming framed requests start with
	// "Content-Length: <bytes>\r\n\r\n<body>" per LSP/DAP convention. The legacy
	// parse-loop format (no framing) remains supported for backwards-compat during
	// the deploy transition; framing is detected by sniffing the first bytes.
	const FString ContentLengthHeader = TEXT("Content-Length:");
	constexpr int32 MaxHeaderBytes = 512;  // Sanity cap for header search

	/** Parse an accumulated UTF-8 byte buffer into a JSON object; returns true when complete. */
	bool TryParseAccumulated(const TArray<uint8>& Bytes, TSharedPtr<FJsonObject>& OutJson)
	{
		if (Bytes.Num() == 0)
		{
			return false;
		}
		FUTF8ToTCHAR Converter(reinterpret_cast<const ANSICHAR*>(Bytes.GetData()), Bytes.Num());
		const FString Text(Converter.Length(), Converter.Get());
		TSharedRef<TJsonReader<>> Reader = TJsonReaderFactory<>::Create(Text);
		return FJsonSerializer::Deserialize(Reader, OutJson) && OutJson.IsValid();
	}

	/**
	 * Detect length-framing on the accumulated buffer. Returns:
	 *   - Framed=true, BodyOffset=N, BodyLen=M when a complete `Content-Length: M\r\n\r\n` header is present
	 *   - Framed=true, BodyOffset=0, BodyLen=-1 when header is incomplete (need more bytes)
	 *   - Framed=false when the buffer does NOT begin with "Content-Length:" (legacy/parse-loop path)
	 * The framing sniff inspects only the first `MaxHeaderBytes` so a large legacy
	 * JSON payload that happens to contain "Content-Length:" mid-body cannot trigger
	 * a false positive — the prefix must be at byte 0.
	 */
	void DetectFraming(const TArray<uint8>& Bytes, bool& bOutFramed, int32& OutBodyOffset, int32& OutBodyLen)
	{
		bOutFramed = false;
		OutBodyOffset = 0;
		OutBodyLen = -1;

		if (Bytes.Num() < ContentLengthHeader.Len())
		{
			// Too few bytes to decide either way — caller should keep reading.
			// Default-decision: assume framing only when we have enough bytes to confirm.
			return;
		}

		// Sniff just the first ContentLengthHeader.Len() bytes (case-insensitive).
		const FUTF8ToTCHAR Sniff(reinterpret_cast<const ANSICHAR*>(Bytes.GetData()), ContentLengthHeader.Len());
		const FString Prefix(Sniff.Length(), Sniff.Get());
		if (!Prefix.StartsWith(ContentLengthHeader, ESearchCase::IgnoreCase))
		{
			return;  // legacy path (no framing)
		}

		bOutFramed = true;

		// Search for the "\r\n\r\n" header terminator within MaxHeaderBytes.
		const int32 HeaderSearchLen = FMath::Min(Bytes.Num(), MaxHeaderBytes);
		const FUTF8ToTCHAR Conv(reinterpret_cast<const ANSICHAR*>(Bytes.GetData()), HeaderSearchLen);
		const FString HeaderText(Conv.Length(), Conv.Get());

		int32 TerminatorIdx = HeaderText.Find(TEXT("\r\n\r\n"), ESearchCase::CaseSensitive, ESearchDir::FromStart);
		if (TerminatorIdx == INDEX_NONE)
		{
			// Header not yet complete — keep reading.
			return;
		}

		// Parse the integer body length from the header span.
		const FString HeaderBlock = HeaderText.Left(TerminatorIdx);
		const int32 ColonIdx = HeaderBlock.Find(TEXT(":"));
		if (ColonIdx == INDEX_NONE)
		{
			return;
		}
		FString LenStr = HeaderBlock.RightChop(ColonIdx + 1).TrimStartAndEnd();
		OutBodyLen = FCString::Atoi(*LenStr);
		OutBodyOffset = TerminatorIdx + 4;  // past the "\r\n\r\n" terminator (4 bytes)
	}
}

FMCPServerRunnable::FMCPServerRunnable(FSocket* InListenerSocket)
	: ListenerSocket(InListenerSocket)
	, bRunning(true)
{
}

FMCPServerRunnable::~FMCPServerRunnable()
{
	// Listener socket lifetime is owned by FUEMCPModule — do not destroy here.
}

bool FMCPServerRunnable::Init()
{
	return ListenerSocket != nullptr;
}

uint32 FMCPServerRunnable::Run()
{
	UEMCP_LOG("server thread started on port 55558");

	while (bRunning)
	{
		if (!ListenerSocket)
		{
			UEMCP_ERROR("listener socket became null — exiting thread");
			return 1;
		}

		// E-1 §2 hygiene fix: replace the 50ms `Sleep(0.05f)` poll with a kernel-level
		// blocking wait. `WaitForPendingConnection(bPending, FTimespan::FromMilliseconds(500))`
		// delegates to `select()` (or `WSAEventSelect` on Windows) per UE 5.6
		// SocketsBSD.cpp:88-105 — it returns immediately when a connection arrives and
		// after the timeout otherwise. The 500ms ceiling preserves bRunning-flag
		// responsiveness for clean shutdown without burning CPU on poll cycles.
		// Eliminates the 51ms accept-poll floor measured in Audit 6 §1 (n=210 calls).
		bool bPending = false;
		if (ListenerSocket->WaitForPendingConnection(bPending, FTimespan::FromMilliseconds(500)) && bPending)
		{
			FSocket* ClientSocket = ListenerSocket->Accept(TEXT("UEMCPClient"));
			if (ClientSocket)
			{
				UEMCP_VERBOSE("accepted client connection");
				ServeOneConnection(ClientSocket);
				// E-1-FIX (D140 NEEDS-WORK close-out, 2026-05-06): the §1 Listen(128)
				// backlog fix in UEMCPModule.cpp targets the actual empirical RST class
				// (kernel rejects 6th+ concurrent SYN during burst, observed clustering
				// on calls #0-#9 then steady-state per docs/testing/d140-livefire-2026-05-06.md).
				// Defense-in-depth `Wait(WaitForWrite)` was considered but DEFERRED:
				// `Wait(WaitForWrite)` calls `select()` with the write mask — it returns
				// when the socket's send buffer has room for more writes, NOT when the
				// buffer has drained to the network. After a successful Send() the socket
				// is almost always immediately writable, so the call returns within
				// microseconds without flushing anything. The actual "drain before close"
				// idiom is `SetLingerSettings(true, smallTimeout)` (kernel waits for
				// FIN+ACK). If post-deploy bench still shows non-zero error rate after
				// the §1 fix lands, a follow-on adds SetLingerSettings backed by
				// empirical evidence rather than speculative comment-claim.
				if (ISocketSubsystem* Sub = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM))
				{
					Sub->DestroySocket(ClientSocket);
				}
			}
			else
			{
				UEMCP_WARN("Accept returned null");
			}
		}
		// else: WaitForPendingConnection returned false (timeout or error) — loop and re-check bRunning.
	}

	UEMCP_LOG("server thread stopping");
	return 0;
}

void FMCPServerRunnable::Stop()
{
	bRunning = false;
}

void FMCPServerRunnable::Exit()
{
}

void FMCPServerRunnable::ServeOneConnection(FSocket* ClientSocket)
{
	if (!ClientSocket)
	{
		return;
	}

	ClientSocket->SetNoDelay(true);
	// Non-blocking inheritance from the listener is platform-dependent; set explicitly so the
	// EWOULDBLOCK retry loop below works on every platform UE supports.
	ClientSocket->SetNonBlocking(true);
	int32 ActualSendBufSize = 0;
	int32 ActualRecvBufSize = 0;
	ClientSocket->SetSendBufferSize(SocketBufferSize, ActualSendBufSize);
	ClientSocket->SetReceiveBufferSize(SocketBufferSize, ActualRecvBufSize);

	TArray<uint8> Accumulated;
	Accumulated.Reserve(RecvBufferSize);

	TSharedPtr<FJsonObject> RequestJson;
	TSharedPtr<FJsonObject> ResponseJson;
	const double StartTime = FPlatformTime::Seconds();

	uint8 Buffer[RecvBufferSize];

	// E-1 §1 hygiene fix: detect framing on the first bytes received, then read
	// the appropriate amount. Framed path reads exactly Content-Length bytes;
	// unframed path falls back to TryParseAccumulated (legacy behavior, kept for
	// backwards-compat with any unframed client during the deploy transition).
	bool bFramed = false;
	int32 FramingBodyOffset = 0;
	int32 FramingBodyLen = -1;
	bool bFramingDecided = false;
	bool bRequestComplete = false;
	bool bPeerClosed = false;

	// Read until a complete JSON object parses (framed or legacy), client disconnects, or timeout.
	while (bRunning && (FPlatformTime::Seconds() - StartTime) < PerConnectionTimeoutSec)
	{
		int32 BytesRead = 0;
		const bool bRecv = ClientSocket->Recv(Buffer, RecvBufferSize, BytesRead);
		if (bRecv && BytesRead > 0)
		{
			Accumulated.Append(Buffer, BytesRead);
			UEMCP_VERBOSE("recv %d bytes (total=%d)", BytesRead, Accumulated.Num());

			// First, decide framing once we have enough bytes (or unambiguous prefix).
			if (!bFramingDecided)
			{
				DetectFraming(Accumulated, bFramed, FramingBodyOffset, FramingBodyLen);
				if (bFramed && FramingBodyLen >= 0)
				{
					bFramingDecided = true;
					UEMCP_VERBOSE("detected framed request (bodyOffset=%d bodyLen=%d total=%d)", FramingBodyOffset, FramingBodyLen, Accumulated.Num());
				}
				else if (!bFramed && Accumulated.Num() >= ContentLengthHeader.Len())
				{
					// Have enough bytes to confirm legacy (no Content-Length: prefix at byte 0).
					bFramingDecided = true;
					UEMCP_VERBOSE("detected legacy unframed request (total=%d)", Accumulated.Num());
				}
			}

			// Framed path: wait until we have header + full body.
			if (bFramingDecided && bFramed)
			{
				if (FramingBodyLen >= 0 && Accumulated.Num() >= FramingBodyOffset + FramingBodyLen)
				{
					TArray<uint8> Body;
					Body.Append(Accumulated.GetData() + FramingBodyOffset, FramingBodyLen);
					if (TryParseAccumulated(Body, RequestJson))
					{
						bRequestComplete = true;
						UEMCP_VERBOSE("parsed framed request JSON (Content-Length=%d)", FramingBodyLen);
						break;
					}
					UEMCP_WARN("framed body failed to parse as JSON (Content-Length=%d)", FramingBodyLen);
					break;
				}
				// else: header decoded, body not yet complete — continue receiving.
				continue;
			}

			// Legacy path: keep trying to parse the accumulated buffer.
			if (bFramingDecided && !bFramed)
			{
				if (TryParseAccumulated(Accumulated, RequestJson))
				{
					bRequestComplete = true;
					UEMCP_VERBOSE("parsed legacy request JSON (bytes=%d)", Accumulated.Num());
					break;
				}
			}
			// More data might be pending — continue loop.
			continue;
		}

		if (bRecv && BytesRead == 0)
		{
			// On UE's non-blocking sockets, a successful zero-byte Recv can mean
			// "no payload available yet", especially immediately after Accept() or
			// between a client's framed header/body writes. Treat it as a disconnect
			// only when the socket state says the peer is no longer connected.
			const ESocketConnectionState State = ClientSocket->GetConnectionState();
			if (State == SCS_Connected)
			{
				ClientSocket->Wait(ESocketWaitConditions::WaitForRead, FTimespan::FromMilliseconds(50));
				continue;
			}
			bPeerClosed = true;
			UEMCP_VERBOSE("client closed connection cleanly after %d request bytes", Accumulated.Num());
			break;
		}

		// Error path. SE_EWOULDBLOCK on a non-blocking socket means "no data yet" — keep waiting.
		const ESocketErrors Err = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->GetLastErrorCode();
		if (Err == SE_EWOULDBLOCK || Err == SE_EINTR)
		{
			// E-1 §3 hygiene fix: replace the 10ms `Sleep(0.01f)` poll with a kernel-event
			// readiness wait. `Wait(WaitForRead, ...)` returns immediately when bytes
			// arrive at the socket, eliminating the 10ms quantization on multi-chunk
			// receives. Same fix class as the §2 accept-loop: kernel-level select()
			// instead of fixed-interval sleep. Audit 6 advisor flagged this as the
			// second polling site.
			ClientSocket->Wait(ESocketWaitConditions::WaitForRead, FTimespan::FromMilliseconds(50));
			continue;
		}
		UEMCP_WARN("recv failed: socket error %d", static_cast<int32>(Err));
		return;
	}
	if (!RequestJson.IsValid())
	{
		const double ElapsedMs = (FPlatformTime::Seconds() - StartTime) * 1000.0;
		UEMCP_WARN("request incomplete before parse (bytes=%d framed=%s bodyLen=%d peerClosed=%s elapsedMs=%.1f)",
			Accumulated.Num(),
			bFramed ? TEXT("true") : TEXT("false"),
			FramingBodyLen,
			bPeerClosed ? TEXT("true") : TEXT("false"),
			ElapsedMs);
	}

	// --- Build response envelope ---
	if (!RequestJson.IsValid())
	{
		const TCHAR* Reason = bRequestComplete
			? TEXT("failed to parse request JSON")
			: TEXT("incomplete request (no JSON parsed before close/timeout)");
		UEMCP::BuildErrorResponse(ResponseJson, Reason, TEXT("MALFORMED_REQUEST"));
	}
	else
	{
		FString CommandType;
		if (!RequestJson->TryGetStringField(TEXT("type"), CommandType) || CommandType.IsEmpty())
		{
			UEMCP::BuildErrorResponse(ResponseJson, TEXT("missing or empty 'type' field"), TEXT("MALFORMED_REQUEST"));
		}
		else
		{
			// Params may be absent (e.g., ping) — pass null to the registry; handlers that need
			// params will null-check (P0-9).
			TSharedPtr<FJsonObject> Params;
			const TSharedPtr<FJsonObject>* ParamsPtr = nullptr;
			if (RequestJson->TryGetObjectField(TEXT("params"), ParamsPtr) && ParamsPtr && ParamsPtr->IsValid())
			{
				Params = *ParamsPtr;
			}
			UEMCP::FMCPCommandRegistry::Get().Dispatch(CommandType, Params, ResponseJson);
		}
	}

	// --- Serialize + send (UTF-8) ---
	// E-1 §1 hygiene fix: always emit length-framed responses. The JS receiver
	// auto-detects framing on incoming bytes and falls back to the legacy
	// parse-loop if no `Content-Length:` header is present, so this is
	// forwards-compatible for any old client still in flight during transition.
	// Framing eliminates the JSON-parse-completion ambiguity (legacy clients
	// could complete-parse a top-level string response prematurely).
	const FString ResponseText = UEMCP::SerializeResponse(ResponseJson);
	FTCHARToUTF8 BodyUtf8(*ResponseText);
	const int32 BodyLen = BodyUtf8.Length();

	const FString Header = FString::Printf(TEXT("Content-Length: %d\r\n\r\n"), BodyLen);
	FTCHARToUTF8 HeaderUtf8(*Header);
	const int32 HeaderLen = HeaderUtf8.Length();

	TArray<uint8> Framed;
	Framed.Reserve(HeaderLen + BodyLen);
	Framed.Append(reinterpret_cast<const uint8*>(HeaderUtf8.Get()), HeaderLen);
	Framed.Append(reinterpret_cast<const uint8*>(BodyUtf8.Get()), BodyLen);

	int32 BytesSent = 0;
	if (!ClientSocket->Send(Framed.GetData(), Framed.Num(), BytesSent))
	{
		UEMCP_WARN("failed to send response");
	}
	else
	{
		UEMCP_VERBOSE("sent %d bytes (framed: %d header + %d body)", BytesSent, HeaderLen, BodyLen);
	}
}
