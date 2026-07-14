// Copyright Optimum Athena. All Rights Reserved.

#include "MCPServerTransportPolicy.h"

#if PLATFORM_WINDOWS
#include "Windows/AllowWindowsPlatformTypes.h"
THIRD_PARTY_INCLUDES_START
#include "WinSock2.h"
THIRD_PARTY_INCLUDES_END
#include "Windows/HideWindowsPlatformTypes.h"
#elif PLATFORM_UNIX
#include <cerrno>
#endif

namespace UEMCP::Transport
{
FMCPReceiveAttempt ReceiveWithCapturedError(FSocket* Socket, uint8* Buffer, int32 BufferSize)
{
	ISocketSubsystem* SocketSubsystem = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
	if (Socket == nullptr || SocketSubsystem == nullptr)
	{
		return {false, 0, SE_SYSTEM};
	}

	FMCPReceiveAttempt Attempt;

#if PLATFORM_WINDOWS
	WSASetLastError(0);
	Attempt.bSucceeded = Socket->Recv(Buffer, BufferSize, Attempt.BytesRead);
	if (!Attempt.bSucceeded)
	{
		const int32 NativeErrorCode = WSAGetLastError();
		Attempt.Error = SocketSubsystem->TranslateErrorCode(NativeErrorCode);
	}
#elif PLATFORM_UNIX
	errno = 0;
	Attempt.bSucceeded = Socket->Recv(Buffer, BufferSize, Attempt.BytesRead);
	if (!Attempt.bSucceeded)
	{
		const int32 NativeErrorCode = errno;
		Attempt.Error = SocketSubsystem->TranslateErrorCode(NativeErrorCode);
	}
#else
	Attempt.bSucceeded = Socket->Recv(Buffer, BufferSize, Attempt.BytesRead);
	if (!Attempt.bSucceeded)
	{
		Attempt.Error = SE_SYSTEM;
	}
#endif

	return Attempt;
}

EMCPReceiveAction ClassifyReceiveAttempt(const FMCPReceiveAttempt& Attempt)
{
	const bool bRetryable = Attempt.Error == SE_EWOULDBLOCK || Attempt.Error == SE_EINTR;
	if (Attempt.BytesRead < 0)
	{
		return bRetryable ? EMCPReceiveAction::Wait : EMCPReceiveAction::SocketError;
	}

	if (Attempt.bSucceeded)
	{
		return Attempt.BytesRead > 0
			? EMCPReceiveAction::ConsumeData
			: EMCPReceiveAction::Wait;
	}

	if (bRetryable)
	{
		return EMCPReceiveAction::Wait;
	}

	return Attempt.BytesRead == 0 && Attempt.Error == SE_NO_ERROR
		? EMCPReceiveAction::PeerClosed
		: EMCPReceiveAction::SocketError;
}
}
