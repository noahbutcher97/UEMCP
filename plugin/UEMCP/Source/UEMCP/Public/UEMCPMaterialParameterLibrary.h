// Copyright Noah Butcher. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEMCPMaterialParameterLibrary.generated.h"

class UMaterialInterface;
struct FMaterialParameterInfo;

UENUM()
enum class EUEMCPMaterialParameterType : uint8
{
	Scalar,
	Vector,
	Texture
};

namespace UEMCP::Materials
{
	UEMCP_API TArray<FName> FilterGlobalParameterNames(TConstArrayView<FMaterialParameterInfo> Definitions);
}

/** Read-only definition lookup for RC; override arrays cannot prove a parameter exists. */
UCLASS()
class UEMCP_API UUEMCPMaterialParameterLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()
public:
	UFUNCTION(BlueprintCallable, Category = "UEMCP|Materials")
	static TArray<FName> GetGlobalParameterNames(UMaterialInterface* Material, EUEMCPMaterialParameterType ParameterType);
};
