// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * P0-1: Single response envelope for every command handler.
 *
 * Success format: {"status":"success","result":{...}}
 * Error format:   {"status":"error","error":"<message>","code":"<ERROR_CODE>"}
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

	/** Serializes a response object to a string for TCP transmission (no trailing newline per protocol). */
	FString SerializeResponse(const TSharedPtr<FJsonObject>& Response);
}
