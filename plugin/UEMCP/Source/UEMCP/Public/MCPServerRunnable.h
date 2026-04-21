// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "HAL/Runnable.h"
#include "HAL/ThreadSafeBool.h"

class FSocket;

/**
 * TCP accept loop for UEMCP on port 55558.
 *
 * Connect-per-command protocol (no persistent connection — matches 55557 wire format):
 *   1. Accept client on the listener socket (non-blocking poll).
 *   2. Read bytes into an accumulator until a full JSON object parses.
 *   3. Extract 'type' + 'params', dispatch via FMCPCommandRegistry.
 *   4. Serialize response, send (UTF-8, no newline terminator).
 *   5. Close client socket. Loop.
 *
 * Malformed requests (missing 'type', unparseable JSON) return MALFORMED_REQUEST errors.
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
	void ServeOneConnection(FSocket* ClientSocket);

	FSocket* ListenerSocket = nullptr;
	FThreadSafeBool bRunning;
};
