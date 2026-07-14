// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "HAL/Runnable.h"
#include "HAL/ThreadSafeBool.h"

class FSocket;

/**
 * TCP accept loop for UEMCP on port 55558.
 *
 * Connect-per-command protocol (no persistent connection):
 *   1. Accept one client and capture a monotonic acceptance timestamp.
 *   2. Read one strict Content-Length-framed or legacy JSON object with bounded
 *      header/body sizes and independent idle/total receive deadlines.
 *   3. Map the typed intake result once, then dispatch valid 'type' + 'params'.
 *   4. Serialize and send one Content-Length-framed UTF-8 response.
 *   5. Close the client socket and return to the accept loop.
 *
 * Rejected active requests attempt a structured error response.
 * Peer close, receive failure, and server shutdown do not attempt a response.
 * The listener socket is owned by FUEMCPModule; this runnable only holds a non-owning raw pointer.
 */
class FMCPServerRunnable : public FRunnable
{
public:
	explicit FMCPServerRunnable(FSocket* InListenerSocket);
	virtual ~FMCPServerRunnable() override;

	// FRunnable
	virtual bool Init() override;
	virtual uint32 Run() override;
	virtual void Stop() override;
	virtual void Exit() override;

private:
	void ServeOneConnection(FSocket* ClientSocket, double AcceptedAtSeconds);

	FSocket* ListenerSocket = nullptr;
	FThreadSafeBool bRunning;
};
