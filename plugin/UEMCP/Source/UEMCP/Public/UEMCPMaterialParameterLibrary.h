// Copyright Noah Butcher. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#include "UEMCPMaterialParameterLibrary.generated.h"

class UMaterialInterface;
class UMaterialInstanceConstant;
class UTexture;
struct FMaterialParameterInfo;

UENUM()
enum class EUEMCPMaterialParameterType : uint8
{
	Scalar,
	Vector,
	Texture
};

USTRUCT(BlueprintType)
struct FUEMCPMaterialParameterDetails
{
	GENERATED_BODY()
	UPROPERTY(BlueprintReadOnly, Category = "UEMCP|Materials") FName Name;
	UPROPERTY(BlueprintReadOnly, Category = "UEMCP|Materials") FString Id;
	UPROPERTY(BlueprintReadOnly, Category = "UEMCP|Materials") FString Association;
	UPROPERTY(BlueprintReadOnly, Category = "UEMCP|Materials") int32 Index = INDEX_NONE;
	UPROPERTY(BlueprintReadOnly, Category = "UEMCP|Materials") bool bValueFound = false;
	UPROPERTY(BlueprintReadOnly, Category = "UEMCP|Materials") float ScalarValue = 0;
	UPROPERTY(BlueprintReadOnly, Category = "UEMCP|Materials") FLinearColor VectorValue = FLinearColor::Black;
	UPROPERTY(BlueprintReadOnly, Category = "UEMCP|Materials") FString TextureValue;
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
	UFUNCTION(BlueprintCallable, Category = "UEMCP|Materials")
	static TArray<FUEMCPMaterialParameterDetails> GetParameterDetails(UMaterialInterface* Material, EUEMCPMaterialParameterType ParameterType);
	UFUNCTION(BlueprintCallable, Category = "UEMCP|Materials")
	static bool SetParameterValue(UMaterialInstanceConstant* Instance, EUEMCPMaterialParameterType ParameterType, FName ParameterName, FString Association, int32 Index, float ScalarValue, FLinearColor VectorValue, UTexture* TextureValue);
};
