// Copyright Optimum Athena. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Sockets.h"
#include "SocketSubsystem.h"

namespace UEMCP::Transport
{
inline constexpr int32 MaxHeaderBytes = 512;
inline constexpr int64 MaxRequestBodyBytes = 8ll * 1024ll * 1024ll;
inline constexpr double ReceiveIdleTimeoutSec = 2.0;
inline constexpr double ReceiveTotalTimeoutSec = 10.0;

enum class EMCPReceiveAction : uint8
{
	ConsumeData,
	Wait,
	PeerClosed,
	SocketError
};

struct FMCPReceiveAttempt
{
	bool bSucceeded = false;
	int32 BytesRead = 0;
	ESocketErrors Error = SE_NO_ERROR;
};

FMCPReceiveAttempt ReceiveWithCapturedError(FSocket* Socket, uint8* Buffer, int32 BufferSize);
EMCPReceiveAction ClassifyReceiveAttempt(const FMCPReceiveAttempt& Attempt);
}
