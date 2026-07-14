// Copyright Optimum Athena. All Rights Reserved.

#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
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

enum class EMCPFramingMode : uint8
{
	Undecided,
	Legacy,
	Framed
};

enum class EMCPDecodeStatus : uint8
{
	Pending,
	Complete,
	Malformed,
	TooLarge
};

enum class EMCPRequestReadOutcome : uint8
{
	Complete,
	Malformed,
	TooLarge,
	IdleTimeout,
	TotalTimeout,
	PeerClosed,
	SocketError,
	ServerStopping
};

enum class EMCPReceiveDeadline : uint8
{
	None,
	IdleTimeout,
	TotalTimeout
};

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

struct FMCPReceiveWaitDecision
{
	EMCPReceiveDeadline Deadline = EMCPReceiveDeadline::None;
	double WaitSeconds = 0.0;
};

class FMCPRequestDecoder
{
public:
	explicit FMCPRequestDecoder(FMCPDecoderPolicy InPolicy = {});
	~FMCPRequestDecoder();

	FMCPRequestDecoder(const FMCPRequestDecoder&) = delete;
	FMCPRequestDecoder& operator=(const FMCPRequestDecoder&) = delete;

	const FMCPDecodeSnapshot& Consume(const uint8* Data, int32 NumBytes);
	const FMCPDecodeSnapshot& Snapshot() const;
	FString DescribeTerminalEof() const;
#if WITH_DEV_AUTOMATION_TESTS
	int32 GetJsonParseCountForTests() const;
	int64 GetLegacyBytesScannedForTests() const;
#endif

private:
	struct FImpl;
	TUniquePtr<FImpl> Impl;
};

struct FMCPReceiveAttempt
{
	bool bSucceeded = false;
	int32 BytesRead = 0;
	ESocketErrors Error = SE_NO_ERROR;
};

FMCPReceiveAttempt ReceiveWithCapturedError(FSocket* Socket, uint8* Buffer, int32 BufferSize);
EMCPReceiveAction ClassifyReceiveAttempt(const FMCPReceiveAttempt& Attempt);
FMCPReceiveWaitDecision EvaluateReceiveDeadlines(
	double AcceptedAtSeconds,
	double LastPositiveByteAtSeconds,
	double NowSeconds);
FMCPRequestReadResult ReadOneRequest(
	FSocket* Socket,
	double AcceptedAtSeconds,
	TFunctionRef<bool()> IsServerRunning);
}
