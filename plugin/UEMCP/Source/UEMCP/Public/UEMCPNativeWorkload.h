// Copyright Noah Butcher. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "UEMCPNativeWorkload.generated.h"

class FJsonObject;

// Implement on a native class installed in the project or an enabled editor plugin.
// Kind and version are checked against the catalog before invoking Evaluate.
UCLASS(Abstract)
class UEMCP_API UUEMCPNativeWorkload : public UObject
{
	GENERATED_BODY()
public:
	virtual FString WorkloadKind() const { return {}; }
	virtual int32 WorkloadVersion() const { return 0; }
	virtual bool Evaluate(const FJsonObject& Inputs, FJsonObject& Output, FString& Error) const { return false; }
};
