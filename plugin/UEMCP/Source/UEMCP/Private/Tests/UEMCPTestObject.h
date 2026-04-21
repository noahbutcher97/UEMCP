// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "UEMCPTestObject.generated.h"

/**
 * Tiny UObject with scalar UPROPERTY fields exercised by PropertyHandlerRegistry automation tests.
 * Not used in production — only compiled into the test translation unit.
 */
UCLASS()
class UUEMCPTestObject : public UObject
{
	GENERATED_BODY()

public:
	UPROPERTY()
	int32 IntValue = 0;

	UPROPERTY()
	float FloatValue = 0.f;

	UPROPERTY()
	bool BoolValue = false;

	UPROPERTY()
	FString StringValue;

	UPROPERTY()
	FName NameValue;
};
