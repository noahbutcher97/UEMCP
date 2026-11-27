// Copyright Noah Butcher. All Rights Reserved.
#pragma once
#include "Commandlets/Commandlet.h"
#include "UEMCPNativeWorkload.h"
#include "UEMCPWorkloadCommandlet.generated.h"

UCLASS()
class UUEMCPWorkloadCommandlet : public UCommandlet
{
	GENERATED_BODY()
public:
	UUEMCPWorkloadCommandlet();
	virtual int32 Main(const FString& Params) override;
};

UCLASS()
class UUEMCPJointResponse : public UUEMCPNativeWorkload
{
	GENERATED_BODY()
public:
	virtual FString WorkloadKind() const override { return TEXT("physics_joint_response"); }
	virtual int32 WorkloadVersion() const override { return 1; }
	virtual bool Evaluate(const FJsonObject& Inputs, FJsonObject& Output, FString& Error) const override;
};
