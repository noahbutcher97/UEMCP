// Copyright Optimum Athena. All Rights Reserved.
#include "UEMCPModule.h"
#include "MCPCommandRegistry.h"
#include "MCPServerRunnable.h"

#include "Misc/App.h"
#include "Modules/ModuleManager.h"
#include "Sockets.h"
#include "SocketSubsystem.h"
#include "Interfaces/IPv4/IPv4Address.h"
#include "Interfaces/IPv4/IPv4Endpoint.h"
#include "HAL/RunnableThread.h"

DEFINE_LOG_CATEGORY(LogUEMCP);

namespace
{
	constexpr int32 UEMCPPort = 55558;

	FSocket* GListenerSocket = nullptr;
	FMCPServerRunnable* GServerRunnable = nullptr;
	FRunnableThread* GServerThread = nullptr;

	bool StartTcpServer()
	{
		ISocketSubsystem* SocketSubsystem = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM);
		if (!SocketSubsystem)
		{
			UE_LOG(LogUEMCP, Error, TEXT("UEMCP: failed to get socket subsystem"));
			return false;
		}

		FSocket* RawSocket = SocketSubsystem->CreateSocket(NAME_Stream, TEXT("UEMCPListener"), false);
		if (!RawSocket)
		{
			UE_LOG(LogUEMCP, Error, TEXT("UEMCP: failed to create listener socket"));
			return false;
		}
		RawSocket->SetReuseAddr(true);
		RawSocket->SetNonBlocking(true);

		const FIPv4Endpoint Endpoint(FIPv4Address::Any, UEMCPPort);
		if (!RawSocket->Bind(*Endpoint.ToInternetAddr()))
		{
			UE_LOG(LogUEMCP, Error, TEXT("UEMCP: failed to bind port %d (another process may be listening)"), UEMCPPort);
			SocketSubsystem->DestroySocket(RawSocket);
			return false;
		}
		if (!RawSocket->Listen(5))
		{
			UE_LOG(LogUEMCP, Error, TEXT("UEMCP: failed to begin listening on port %d"), UEMCPPort);
			SocketSubsystem->DestroySocket(RawSocket);
			return false;
		}

		GListenerSocket = RawSocket;

		// Force registry singleton construction (default handlers) BEFORE the server thread
		// is created — honors the Register-before-start invariant documented in MCPCommandRegistry.h.
		UEMCP::FMCPCommandRegistry::Get();

		GServerRunnable = new FMCPServerRunnable(GListenerSocket);
		GServerThread = FRunnableThread::Create(GServerRunnable, TEXT("UEMCPServerThread"), 0, TPri_Normal);

		if (!GServerThread)
		{
			UE_LOG(LogUEMCP, Error, TEXT("UEMCP: failed to create server thread"));
			delete GServerRunnable;
			GServerRunnable = nullptr;
			SocketSubsystem->DestroySocket(GListenerSocket);
			GListenerSocket = nullptr;
			return false;
		}

		UE_LOG(LogUEMCP, Log, TEXT("UEMCP: TCP server listening on port %d"), UEMCPPort);
		return true;
	}

	void StopTcpServer()
	{
		if (GServerRunnable)
		{
			GServerRunnable->Stop();
		}
		if (GServerThread)
		{
			GServerThread->Kill(/*bShouldWait=*/ true);
			delete GServerThread;
			GServerThread = nullptr;
		}
		if (GServerRunnable)
		{
			delete GServerRunnable;
			GServerRunnable = nullptr;
		}
		if (GListenerSocket)
		{
			if (ISocketSubsystem* SocketSubsystem = ISocketSubsystem::Get(PLATFORM_SOCKETSUBSYSTEM))
			{
				SocketSubsystem->DestroySocket(GListenerSocket);
			}
			GListenerSocket = nullptr;
		}
	}
}

void FUEMCPModule::StartupModule()
{
	// D57 gate: commandlet processes (e.g., M-new Oracle-A DumpBPGraphCommandlet)
	// load the module to access UEMCP types but must NOT bind TCP:55558 — otherwise
	// concurrent interactive-editor + commandlet runs contend for the port.
	// IsRunningCommandlet is a global free function in CoreGlobals.h (transitively
	// available via CoreMinimal.h); it's NOT a member of FApp on UE 5.6.
	if (IsRunningCommandlet())
	{
		UE_LOG(LogUEMCP, Log, TEXT("UEMCP: commandlet detected — TCP server suppressed (D57 gate)"));
		return;
	}

	if (!StartTcpServer())
	{
		UE_LOG(LogUEMCP, Warning, TEXT("UEMCP: TCP server failed to start; module loaded but inactive"));
	}
}

void FUEMCPModule::ShutdownModule()
{
	StopTcpServer();
	UE_LOG(LogUEMCP, Log, TEXT("UEMCP: module shutdown"));
}

IMPLEMENT_MODULE(FUEMCPModule, UEMCP)
