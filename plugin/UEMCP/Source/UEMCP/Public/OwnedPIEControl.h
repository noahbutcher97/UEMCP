// Copyright Noah Butcher. All Rights Reserved.
#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
struct FRequestPlaySessionParams;
namespace UEMCP
{
	class FMCPCommandRegistry;
	// Nonzero tickets finish at actual GameThread callback completion, including late callbacks.
	struct FOwnedPIEAdmission { uint64 Ticket = 0; };
	bool AdmitOwnedPIECommand(const FString& Command, const TSharedPtr<FJsonObject>& Params,
		FOwnedPIEAdmission& Admission, TSharedPtr<FJsonObject>& OutResponse);
	bool BeginOwnedPIECallback(const FOwnedPIEAdmission& Admission, TSharedPtr<FJsonObject>& OutResponse);
	void CompleteOwnedPIECallback(const FOwnedPIEAdmission& Admission);
	bool ConfigureOwnedPIEStart(FRequestPlaySessionParams& Request, TSharedPtr<FJsonObject>& OutResponse);
	void RegisterOwnedPIEHandlers(FMCPCommandRegistry& Registry);
	void ShutdownOwnedPIEControl();
}
