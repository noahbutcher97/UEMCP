// Copyright Optimum Athena. All Rights Reserved.

#if WITH_DEV_AUTOMATION_TESTS

#include "CoreMinimal.h"
#include "Misc/AutomationTest.h"

#include "MCPServerTransportPolicy.h"

IMPLEMENT_SIMPLE_AUTOMATION_TEST(
	FUEMCPReceiveClassifierTest,
	"UEMCP.Transport.ReceiveClassifier",
	EAutomationTestFlags::EditorContext | EAutomationTestFlags::EngineFilter)

bool FUEMCPReceiveClassifierTest::RunTest(const FString& Parameters)
{
	using namespace UEMCP::Transport;

	auto TestAction = [this](
		const TCHAR* Description,
		bool bSucceeded,
		int32 BytesRead,
		ESocketErrors Error,
		EMCPReceiveAction Expected)
	{
		const FMCPReceiveAttempt Attempt{bSucceeded, BytesRead, Error};
		TestTrue(Description, ClassifyReceiveAttempt(Attempt) == Expected);
	};

	TestAction(TEXT("successful positive read consumes data despite stale error"),
		true, 7, SE_ECONNRESET, EMCPReceiveAction::ConsumeData);
	TestAction(TEXT("successful zero-byte read waits"),
		true, 0, SE_ECONNRESET, EMCPReceiveAction::Wait);
	TestAction(TEXT("failed zero-byte read without error is peer close"),
		false, 0, SE_NO_ERROR, EMCPReceiveAction::PeerClosed);
	TestAction(TEXT("would-block waits"),
		false, 0, SE_EWOULDBLOCK, EMCPReceiveAction::Wait);
	TestAction(TEXT("interrupted read waits"),
		false, 0, SE_EINTR, EMCPReceiveAction::Wait);

	TestAction(TEXT("connection reset is a socket error"),
		false, 0, SE_ECONNRESET, EMCPReceiveAction::SocketError);
	TestAction(TEXT("cleared attempt after reset is peer close"),
		false, 0, SE_NO_ERROR, EMCPReceiveAction::PeerClosed);

	TestAction(TEXT("another hard error is a socket error"),
		false, 0, SE_SYSTEM, EMCPReceiveAction::SocketError);
	TestAction(TEXT("negative bytes with would-block wait"),
		false, -1, SE_EWOULDBLOCK, EMCPReceiveAction::Wait);
	TestAction(TEXT("negative bytes with interruption wait"),
		false, -1, SE_EINTR, EMCPReceiveAction::Wait);
	TestAction(TEXT("negative bytes without error are a socket error"),
		false, -1, SE_NO_ERROR, EMCPReceiveAction::SocketError);
	TestAction(TEXT("negative bytes with hard error are a socket error"),
		false, -1, SE_ECONNRESET, EMCPReceiveAction::SocketError);

	return true;
}

#endif // WITH_DEV_AUTOMATION_TESTS
