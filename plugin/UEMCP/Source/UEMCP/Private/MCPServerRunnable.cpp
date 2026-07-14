// Copyright Optimum Athena. All Rights Reserved.

#include "MCPServerRunnable.h"

#include "Dom/JsonObject.h"
#include "HAL/PlatformTime.h"
#include "Logging.h"
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "MCPServerTransportPolicy.h"
#include "Sockets.h"
#include "SocketSubsystem.h"

namespace
{
constexpr int32 SocketBufferSize = 65536;
constexpr double ResponseSendTimeoutSec = 10.0;

const TCHAR* FramingName(UEMCP::Transport::EMCPFramingMode Framing)
{
	using UEMCP::Transport::EMCPFramingMode;
	switch (Framing)
	{
	case EMCPFramingMode::Undecided:
		return TEXT("undecided");
	case EMCPFramingMode::Legacy:
		return TEXT("legacy");
	case EMCPFramingMode::Framed:
		return TEXT("framed");
	}
	return TEXT("unknown");
}

bool LogSendFailure(
	ISocketSubsystem* SocketSubsystem,
	ESocketErrors Error,
	int32 BytesSent,
	int32 TotalBytes,
	double StartedAtSeconds,
	const TCHAR* Reason)
{
	const double ElapsedMs = FMath::Max(
		0.0,
		(FPlatformTime::Seconds() - StartedAtSeconds) * 1000.0);
	const TCHAR* ErrorText = SocketSubsystem != nullptr
		? SocketSubsystem->GetSocketError(Error)
		: TEXT("socket subsystem unavailable");
	UEMCP_WARN(
		"event=tcp_send_failure bytesSent=%d totalBytes=%d elapsedMs=%.1f reason=%s socketError=%s socketCode=%d",
		BytesSent,
		TotalBytes,
		ElapsedMs,
		Reason,
		ErrorText,
		static_cast<int32>(Error));
	return false;
}

bool SendAll(FSocket* ClientSocket, const TArray<uint8>& Bytes, double TimeoutSec)
{
	const double StartTime = FPlatformTime::Seconds();
	ISocketSubsystem* SocketSubsystem = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
	if (ClientSocket == nullptr)
	{
		return LogSendFailure(
			SocketSubsystem,
			SE_SYSTEM,
			0,
			Bytes.Num(),
			StartTime,
			TEXT("null_socket"));
	}
	if (SocketSubsystem == nullptr)
	{
		return LogSendFailure(
			nullptr,
			SE_SYSTEM,
			0,
			Bytes.Num(),
			StartTime,
			TEXT("socket_subsystem_unavailable"));
	}

	int32 TotalSent = 0;
	while (TotalSent < Bytes.Num()
		&& (FPlatformTime::Seconds() - StartTime) < TimeoutSec)
	{
		int32 BytesSent = 0;
		const int32 Remaining = Bytes.Num() - TotalSent;
		const bool bSent = ClientSocket->Send(
			Bytes.GetData() + TotalSent,
			Remaining,
			BytesSent);
		if (bSent && BytesSent > 0)
		{
			TotalSent += BytesSent;
			continue;
		}

		if (!bSent)
		{
			const ESocketErrors Error = SocketSubsystem->GetLastErrorCode();
			if (Error != SE_EWOULDBLOCK && Error != SE_EINTR)
			{
				return LogSendFailure(
					SocketSubsystem,
					Error,
					TotalSent,
					Bytes.Num(),
					StartTime,
					TEXT("send_error"));
			}
		}
		else if (ClientSocket->GetConnectionState() != SCS_Connected)
		{
			return LogSendFailure(
				SocketSubsystem,
				SE_ECONNABORTED,
				TotalSent,
				Bytes.Num(),
				StartTime,
				TEXT("disconnected"));
		}

		ClientSocket->Wait(
			ESocketWaitConditions::WaitForWrite,
			FTimespan::FromMilliseconds(50));
	}

	if (TotalSent < Bytes.Num())
	{
		return LogSendFailure(
			SocketSubsystem,
			SE_ETIMEDOUT,
			TotalSent,
			Bytes.Num(),
			StartTime,
			TEXT("send_timeout"));
	}
	return true;
}
}

FMCPServerRunnable::FMCPServerRunnable(FSocket* InListenerSocket)
	: ListenerSocket(InListenerSocket)
	, bRunning(true)
{
}

FMCPServerRunnable::~FMCPServerRunnable()
{
	// Listener socket lifetime is owned by FUEMCPModule.
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
		if (ListenerSocket == nullptr)
		{
			UEMCP_ERROR("listener socket became null; exiting thread");
			return 1;
		}

		bool bPending = false;
		if (ListenerSocket->WaitForPendingConnection(
			bPending,
			FTimespan::FromMilliseconds(500)) && bPending)
		{
			FSocket* ClientSocket = ListenerSocket->Accept(TEXT("UEMCPClient"));
			if (ClientSocket != nullptr)
			{
				const double AcceptedAtSeconds = FPlatformTime::Seconds();
				UEMCP_VERBOSE("accepted client connection");
				ServeOneConnection(ClientSocket, AcceptedAtSeconds);
				if (ISocketSubsystem* SocketSubsystem = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM))
				{
					SocketSubsystem->DestroySocket(ClientSocket);
				}
			}
			else
			{
				UEMCP_WARN("Accept returned null");
			}
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

void FMCPServerRunnable::ServeOneConnection(FSocket* ClientSocket, double AcceptedAtSeconds)
{
	using namespace UEMCP::Transport;

	if (ClientSocket == nullptr)
	{
		return;
	}

	ClientSocket->SetNoDelay(true);
	ClientSocket->SetNonBlocking(true);
	int32 ActualSendBufferSize = 0;
	int32 ActualReceiveBufferSize = 0;
	ClientSocket->SetSendBufferSize(SocketBufferSize, ActualSendBufferSize);
	ClientSocket->SetReceiveBufferSize(SocketBufferSize, ActualReceiveBufferSize);

	const FMCPRequestReadResult ReadResult = ReadOneRequest(ClientSocket, AcceptedAtSeconds, [this]
	{
		return bRunning;
	});

	TSharedPtr<FJsonObject> RequestJson;
	TSharedPtr<FJsonObject> ResponseJson;
	switch (ReadResult.Outcome)
	{
	case EMCPRequestReadOutcome::Complete:
		RequestJson = ReadResult.Object;
		break;

	case EMCPRequestReadOutcome::Malformed:
		UEMCP_WARN(
			"event=tcp_intake_malformed framing=%s bytes=%lld declared=%lld elapsedMs=%.1f reason=%s",
			FramingName(ReadResult.Framing),
			ReadResult.BytesReceived,
			ReadResult.DeclaredBodyLength,
			ReadResult.ElapsedMs,
			*ReadResult.ReasonCode);
		UEMCP::BuildErrorResponse(
			ResponseJson,
			TEXT("malformed request transport object"),
			TEXT("MALFORMED_REQUEST"));
		break;

	case EMCPRequestReadOutcome::TooLarge:
		UEMCP_WARN(
			"event=tcp_intake_too_large framing=%s bytes=%lld declared=%lld elapsedMs=%.1f reason=%s",
			FramingName(ReadResult.Framing),
			ReadResult.BytesReceived,
			ReadResult.DeclaredBodyLength,
			ReadResult.ElapsedMs,
			*ReadResult.ReasonCode);
		UEMCP::BuildErrorResponse(
			ResponseJson,
			TEXT("request exceeds transport size limit"),
			TEXT("REQUEST_TOO_LARGE"));
		break;

	case EMCPRequestReadOutcome::IdleTimeout:
		UEMCP_WARN(
			"event=tcp_intake_idle_timeout framing=%s bytes=%lld declared=%lld elapsedMs=%.1f timeout=idle reason=%s",
			FramingName(ReadResult.Framing),
			ReadResult.BytesReceived,
			ReadResult.DeclaredBodyLength,
			ReadResult.ElapsedMs,
			*ReadResult.ReasonCode);
		UEMCP::BuildErrorResponse(
			ResponseJson,
			TEXT("request intake timed out"),
			TEXT("REQUEST_TIMEOUT"));
		break;

	case EMCPRequestReadOutcome::TotalTimeout:
		UEMCP_WARN(
			"event=tcp_intake_total_timeout framing=%s bytes=%lld declared=%lld elapsedMs=%.1f timeout=total reason=%s",
			FramingName(ReadResult.Framing),
			ReadResult.BytesReceived,
			ReadResult.DeclaredBodyLength,
			ReadResult.ElapsedMs,
			*ReadResult.ReasonCode);
		UEMCP::BuildErrorResponse(
			ResponseJson,
			TEXT("request intake timed out"),
			TEXT("REQUEST_TIMEOUT"));
		break;

	case EMCPRequestReadOutcome::PeerClosed:
		if (ReadResult.BytesReceived == 0)
		{
			UEMCP_VERBOSE(
				"event=tcp_peer_closed_empty framing=%s bytes=%lld declared=%lld elapsedMs=%.1f reason=%s",
				FramingName(ReadResult.Framing),
				ReadResult.BytesReceived,
				ReadResult.DeclaredBodyLength,
				ReadResult.ElapsedMs,
				*ReadResult.ReasonCode);
		}
		else
		{
			UEMCP_WARN(
				"event=tcp_peer_closed_partial framing=%s bytes=%lld declared=%lld elapsedMs=%.1f reason=%s",
				FramingName(ReadResult.Framing),
				ReadResult.BytesReceived,
				ReadResult.DeclaredBodyLength,
				ReadResult.ElapsedMs,
				*ReadResult.ReasonCode);
		}
		return;

	case EMCPRequestReadOutcome::SocketError:
	{
		ISocketSubsystem* SocketSubsystem = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
		const TCHAR* ErrorText = SocketSubsystem != nullptr
			? SocketSubsystem->GetSocketError(ReadResult.SocketError)
			: TEXT("socket subsystem unavailable");
		UEMCP_WARN(
			"event=tcp_intake_socket_error framing=%s bytes=%lld declared=%lld elapsedMs=%.1f reason=%s socketError=%s socketCode=%d",
			FramingName(ReadResult.Framing),
			ReadResult.BytesReceived,
			ReadResult.DeclaredBodyLength,
			ReadResult.ElapsedMs,
			*ReadResult.ReasonCode,
			ErrorText,
			static_cast<int32>(ReadResult.SocketError));
		return;
	}

	case EMCPRequestReadOutcome::ServerStopping:
		return;
	}

	if (!ResponseJson.IsValid())
	{
		FString CommandType;
		if (!RequestJson.IsValid()
			|| !RequestJson->TryGetStringField(TEXT("type"), CommandType)
			|| CommandType.IsEmpty())
		{
			UEMCP::BuildErrorResponse(
				ResponseJson,
				TEXT("missing or empty 'type' field"),
				TEXT("MALFORMED_REQUEST"));
		}
		else
		{
			TSharedPtr<FJsonObject> Params;
			const TSharedPtr<FJsonObject>* ParamsPointer = nullptr;
			if (RequestJson->TryGetObjectField(TEXT("params"), ParamsPointer)
				&& ParamsPointer != nullptr
				&& ParamsPointer->IsValid())
			{
				Params = *ParamsPointer;
			}
			UEMCP::FMCPCommandRegistry::Get().Dispatch(
				CommandType,
				Params,
				ResponseJson);
		}
	}

	const FString SerializedResponse = UEMCP::SerializeResponse(ResponseJson);
	FTCHARToUTF8 BodyUtf8(*SerializedResponse);
	const int32 BodyLength = BodyUtf8.Length();

	const FString Header = FString::Printf(
		TEXT("Content-Length: %d\r\n\r\n"),
		BodyLength);
	FTCHARToUTF8 HeaderUtf8(*Header);
	const int32 HeaderLength = HeaderUtf8.Length();

	TArray<uint8> Framed;
	Framed.Reserve(HeaderLength + BodyLength);
	Framed.Append(
		reinterpret_cast<const uint8*>(HeaderUtf8.Get()),
		HeaderLength);
	Framed.Append(
		reinterpret_cast<const uint8*>(BodyUtf8.Get()),
		BodyLength);

	if (SendAll(ClientSocket, Framed, ResponseSendTimeoutSec))
	{
		UEMCP_VERBOSE(
			"sent %d bytes (framed: %d header + %d body)",
			Framed.Num(),
			HeaderLength,
			BodyLength);
	}
}
