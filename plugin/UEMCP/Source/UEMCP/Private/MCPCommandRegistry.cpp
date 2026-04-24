// Copyright Optimum Athena. All Rights Reserved.
#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"
#include "MCPThreadMarshal.h"
#include "Logging/LogMacros.h"

// M-enhance CP3 handler registration
#include "CompileDiagnosticHandler.h"
#include "DataSourceHandlers.h"
#include "EdgeCaseHandlers.h"
#include "GraphTraversalHandlers.h"
#include "ReflectionWalker.h"
#include "SidecarSaveHook.h"
#include "VisualCaptureHandler.h"

DEFINE_LOG_CATEGORY_STATIC(LogUEMCPDispatch, Log, All);

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

		// Audit F-1 fix: every handler runs on the game thread. Most touch UObject
		// reflection / GEditor / FKismetEditorUtilities — game-thread-only APIs that
		// would race the editor tick if invoked from the socket thread. Single-point
		// marshal here covers all 17 non-ping handlers without per-handler edits.
		// Handler is responsible for its own null-check on Params if it needs them (P0-9).
		// The protocol-layer null-check for entirely-missing `params` field happens in
		// MCPServerRunnable (malformed-request response), not here — Params may legitimately
		// be null for parameter-less commands like ping.
		const FCommandHandler& HandlerRef = *Handler;
		TSharedPtr<FJsonObject>* OutPtr = &OutResponse;
		double WallClockSeconds = 0.0;

		const bool bDispatched = RunOnGameThread([&HandlerRef, &Params, OutPtr]()
		{
			HandlerRef(Params, *OutPtr);
		}, /*TimeoutSeconds=*/30.0, &WallClockSeconds);

		if (!bDispatched)
		{
			// 30s timeout — game thread saturated or editor shutting down. Emit a typed
			// error envelope so the caller doesn't trip the belt-and-suspenders branch
			// below with a misleading "did not populate a response".
			BuildErrorResponse(OutResponse,
				FString::Printf(TEXT("handler for '%s' did not complete within 30s on game thread"), *CommandType),
				TEXT("GT_TIMEOUT"));
			UE_LOG(LogUEMCPDispatch, Warning,
				TEXT("dispatch timeout for '%s' (>30s on game thread)"), *CommandType);
			return;
		}

		// Per handoff §6: surface handlers that hitch the editor (>100ms on GT). Verbose
		// always, Warning on hitch — `grep` after a smoke run produces the report list.
		const double WallClockMs = WallClockSeconds * 1000.0;
		if (WallClockMs >= 100.0)
		{
			UE_LOG(LogUEMCPDispatch, Warning,
				TEXT("hitch: '%s' ran %.1fms on game thread"), *CommandType, WallClockMs);
		}
		else
		{
			UE_LOG(LogUEMCPDispatch, Verbose,
				TEXT("dispatch '%s' completed in %.1fms"), *CommandType, WallClockMs);
		}

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
		RegisterVisualCaptureHandler(*this);
	}
}
