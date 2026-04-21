// Copyright Optimum Athena. All Rights Reserved.
#include "MCPResponseBuilder.h"
#include "Serialization/JsonSerializer.h"
#include "Serialization/JsonWriter.h"

namespace UEMCP
{
	void BuildSuccessResponse(TSharedPtr<FJsonObject>& OutResponse, const TSharedPtr<FJsonObject>& Data)
	{
		OutResponse = MakeShared<FJsonObject>();
		OutResponse->SetStringField(TEXT("status"), TEXT("success"));
		OutResponse->SetObjectField(TEXT("result"), Data.IsValid() ? Data : MakeShared<FJsonObject>());
	}

	void BuildErrorResponse(TSharedPtr<FJsonObject>& OutResponse, const FString& Message, const FString& Code)
	{
		OutResponse = MakeShared<FJsonObject>();
		OutResponse->SetStringField(TEXT("status"), TEXT("error"));
		OutResponse->SetStringField(TEXT("error"), Message);
		OutResponse->SetStringField(TEXT("code"), Code.IsEmpty() ? TEXT("ERROR") : Code);
	}

	FString SerializeResponse(const TSharedPtr<FJsonObject>& Response)
	{
		if (!Response.IsValid())
		{
			// Defensive — shouldn't happen if all handlers route through Build*Response.
			return TEXT("{\"status\":\"error\",\"error\":\"internal: null response object\",\"code\":\"INTERNAL\"}");
		}

		FString Out;
		TSharedRef<TJsonWriter<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>> Writer =
			TJsonWriterFactory<TCHAR, TCondensedJsonPrintPolicy<TCHAR>>::Create(&Out);
		FJsonSerializer::Serialize(Response.ToSharedRef(), Writer);
		return Out;
	}
}
