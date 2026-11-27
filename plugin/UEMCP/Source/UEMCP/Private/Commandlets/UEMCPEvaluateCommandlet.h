// Copyright Noah Butcher. All Rights Reserved.
#pragma once

#include "Commandlets/Commandlet.h"
#include "UEMCPEvaluateCommandlet.generated.h"

UCLASS()
class UUEMCPEvaluateCommandlet : public UCommandlet
{
	GENERATED_BODY()
public:
	UUEMCPEvaluateCommandlet();
	virtual int32 Main(const FString& Params) override;
};
