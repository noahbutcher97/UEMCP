// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * P0-1: Single response envelope for every command handler.
 *
 * Success format: {"status":"success","result":{...}}
 * Error format:   {"status":"error","error":"<message>","code":"<ERROR_CODE>"}
 *                 — with optional "detail":{...} object via the W-D overload
 *                   (D144) for handlers that need to surface structured
 *                   context (allowed_values, matched_paths, etc.) to clients.
 *
 * Breaking change vs. legacy UnrealMCP (port 55557) which used three coexisting
 * shapes. Clients on port 55558 can key off `status` alone. See
 * docs/specs/phase3-plugin-design-inputs.md P0-1.
 */
namespace UEMCP
{
	/** Writes {"status":"success","result":<Data>} into OutResponse (allocated in-place). */
	void BuildSuccessResponse(TSharedPtr<FJsonObject>& OutResponse, const TSharedPtr<FJsonObject>& Data);

	/**
	 * Writes {"status":"error","error":<Message>,"code":<Code>} into OutResponse.
	 * If Code is empty, defaults to "ERROR" so the field is always present.
	 */
	void BuildErrorResponse(TSharedPtr<FJsonObject>& OutResponse, const FString& Message, const FString& Code = TEXT(""));

	/**
	 * W-D (D144) overload: writes
	 *   {"status":"error","error":<Message>,"code":<Code>,"detail":<Detail>}
	 * Detail is attached as a `detail` field on the envelope, alongside `error`/
	 * `code`, so clients can introspect structured context (e.g.
	 * `detail.allowed_values: [...]` from validation paths,
	 * `detail.matched_paths: [...]` from ambiguity resolvers).
	 *
	 * Detail must be non-null; passing null falls back to the no-detail overload.
	 * Existing callers stay backwards-compat — they continue to pick the
	 * single-arg overload above without recompilation.
	 */
	void BuildErrorResponse(TSharedPtr<FJsonObject>& OutResponse, const FString& Message, const FString& Code, const TSharedPtr<FJsonObject>& Detail);

	/** Serializes a response object to a string for TCP transmission (no trailing newline per protocol). */
	FString SerializeResponse(const TSharedPtr<FJsonObject>& Response);
}
