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
	constexpr double PerConnectionTimeoutSec = 5.0;

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

		bool bPending = false;
		if (ListenerSocket->HasPendingConnection(bPending) && bPending)
		{
			FSocket* ClientSocket = ListenerSocket->Accept(TEXT("UEMCPClient"));
			if (ClientSocket)
			{
				UEMCP_VERBOSE("accepted client connection");
				ServeOneConnection(ClientSocket);
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
		else
		{
			// No pending connection — short sleep to avoid busy-spin.
			FPlatformProcess::Sleep(0.05f);
		}
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

	// Read until a complete JSON object parses, client disconnects, or timeout.
	while (bRunning && (FPlatformTime::Seconds() - StartTime) < PerConnectionTimeoutSec)
	{
		int32 BytesRead = 0;
		const bool bRecv = ClientSocket->Recv(Buffer, RecvBufferSize, BytesRead);
		if (bRecv && BytesRead > 0)
		{
			Accumulated.Append(Buffer, BytesRead);
			if (TryParseAccumulated(Accumulated, RequestJson))
			{
				break;
			}
			// More data might be pending — continue loop.
			continue;
		}

		if (bRecv && BytesRead == 0)
		{
			UEMCP_VERBOSE("client closed connection cleanly");
			break;
		}

		// Error path. SE_EWOULDBLOCK on a non-blocking socket means "no data yet" — keep waiting.
		const ESocketErrors Err = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM)->GetLastErrorCode();
		if (Err == SE_EWOULDBLOCK || Err == SE_EINTR)
		{
			FPlatformProcess::Sleep(0.01f);
			continue;
		}
		UEMCP_WARN("recv failed: socket error %d", static_cast<int32>(Err));
		return;
	}

	// --- Build response envelope ---
	if (!RequestJson.IsValid())
	{
		UEMCP::BuildErrorResponse(ResponseJson, TEXT("failed to parse request JSON"), TEXT("MALFORMED_REQUEST"));
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

	// --- Serialize + send (UTF-8, no newline terminator per wire protocol) ---
	const FString ResponseText = UEMCP::SerializeResponse(ResponseJson);
	FTCHARToUTF8 Utf8(*ResponseText);
	int32 BytesSent = 0;
	if (!ClientSocket->Send(reinterpret_cast<const uint8*>(Utf8.Get()), Utf8.Length(), BytesSent))
	{
		UEMCP_WARN("failed to send response");
	}
	else
	{
		UEMCP_VERBOSE("sent %d bytes", BytesSent);
	}
}
