// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * Command dispatch table for TCP:55558.
 *
 * Handlers are registered by command type string (matching the wire 'type' field).
 * Dispatch null-checks the Params object (P0-9) and routes unknown types through
 * a single "unknown command" error envelope.
 *
 * M1 ships only the `ping` handler. M3+ registers real handlers (actor commands,
 * blueprint commands, UMG commands, etc.).
 *
 * **Thread-safety invariant**: `Register` is not mutex-protected. It must run before the
 * TCP server thread is created (i.e., from module-startup code paths that execute before
 * `FRunnableThread::Create(...)`). Default handlers are registered in the singleton's
 * constructor, which runs lazily on first `Get()` — safe because the module's StartupModule
 * calls `Get()` indirectly via `FMCPServerRunnable` creation. M3+ workers adding `Register`
 * calls outside module startup must either ensure they run pre-thread-create or add a
 * mutex here.
 */
namespace UEMCP
{
	/**
	 * Handler signature. Handler is responsible for populating OutResponse via
	 * BuildSuccessResponse / BuildErrorResponse — never leaves OutResponse unset.
	 * Params MAY be null (some commands take no arguments); handlers validate first.
	 */
	using FCommandHandler = TFunction<void(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)>;

	class FMCPCommandRegistry
	{
	public:
		static FMCPCommandRegistry& Get();

		void Register(const FString& CommandType, FCommandHandler Handler);
		bool HasHandler(const FString& CommandType) const;

		/**
		 * Dispatch a command. Populates OutResponse with either a success or error envelope.
		 * Never throws. Null Params is tolerated (handlers that need params must check).
		 * Unknown CommandType yields BuildErrorResponse(..., "unknown command: <type>", "UNKNOWN_COMMAND").
		 */
		void Dispatch(const FString& CommandType, const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse) const;

	private:
		FMCPCommandRegistry();
		void RegisterDefaultHandlers();

		TMap<FString, FCommandHandler> Handlers;
	};
}
