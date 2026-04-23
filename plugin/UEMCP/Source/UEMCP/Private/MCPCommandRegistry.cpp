// Copyright Optimum Athena. All Rights Reserved.
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

// M-enhance CP3 handler registration
#include "CompileDiagnosticHandler.h"
#include "DataSourceHandlers.h"
#include "EdgeCaseHandlers.h"
#include "GraphTraversalHandlers.h"
#include "ReflectionWalker.h"
#include "SidecarSaveHook.h"

namespace UEMCP
{
	FMCPCommandRegistry& FMCPCommandRegistry::Get()
	{
		static FMCPCommandRegistry Instance;
		return Instance;
	}

	FMCPCommandRegistry::FMCPCommandRegistry()
	{
		RegisterDefaultHandlers();
	}

	void FMCPCommandRegistry::Register(const FString& CommandType, FCommandHandler Handler)
	{
		Handlers.Add(CommandType, MoveTemp(Handler));
	}

	bool FMCPCommandRegistry::HasHandler(const FString& CommandType) const
	{
		return Handlers.Contains(CommandType);
	}

	void FMCPCommandRegistry::Dispatch(const FString& CommandType, const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse) const
	{
		const FCommandHandler* Handler = Handlers.Find(CommandType);
		if (!Handler)
		{
			BuildErrorResponse(OutResponse,
				FString::Printf(TEXT("unknown command: %s"), *CommandType),
				TEXT("UNKNOWN_COMMAND"));
			return;
		}

		// Handler is responsible for its own null-check on Params if it needs them (P0-9).
		// The protocol-layer null-check for entirely-missing `params` field happens in
		// MCPServerRunnable (malformed-request response), not here — Params may legitimately
		// be null for parameter-less commands like ping.
		(*Handler)(Params, OutResponse);

		// Belt-and-suspenders: if a handler forgot to populate OutResponse, emit an INTERNAL error
		// rather than sending an empty body. M3+ handlers must always route through Build*Response.
		if (!OutResponse.IsValid())
		{
			BuildErrorResponse(OutResponse,
				FString::Printf(TEXT("handler for '%s' did not populate a response"), *CommandType),
				TEXT("INTERNAL"));
		}
	}

	void FMCPCommandRegistry::RegisterDefaultHandlers()
	{
		// ping — smoke test for the TCP transport. No params required; ignores any that are sent.
		Handlers.Add(TEXT("ping"),
			[](const TSharedPtr<FJsonObject>& /*Params*/, TSharedPtr<FJsonObject>& OutResponse)
			{
				TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
				Result->SetStringField(TEXT("message"), TEXT("pong"));
				Result->SetStringField(TEXT("server"), TEXT("uemcp"));
				Result->SetNumberField(TEXT("port"),    55558);
				Result->SetStringField(TEXT("version"), TEXT("0.1.0"));
				BuildSuccessResponse(OutResponse, Result);
			});

		// M-enhance CP3 (D66): wire the HYBRID plugin-C++ tools registered during
		// Session 2. Each RegisterXxx call follows the same convention as `ping`
		// above — they add their handlers to the same map. Order doesn't matter;
		// the map is keyed by command type string.
		RegisterCompileDiagnosticHandlers(*this);
		RegisterReflectionHandlers(*this);
		RegisterGraphTraversalHandlers(*this);
		RegisterEdgeCaseHandlers(*this);
		RegisterDataSourceHandlers(*this);
		RegisterSidecarCommands(*this);
	}
}
