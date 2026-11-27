#pragma once
#include "Engine/DataAsset.h"
#include "Kismet/BlueprintFunctionLibrary.h"
#if __has_include("StructUtils/InstancedStruct.h")
#include "StructUtils/InstancedStruct.h"
#else
#include "InstancedStruct.h"
#endif
#include "ChooserFixtureLibrary.generated.h"

USTRUCT()
struct FUEMCPChooserInput
{
	GENERATED_BODY()

	UPROPERTY()
	FName Key;
};

USTRUCT()
struct FUEMCPFixturePayload
{
	GENERATED_BODY()

	UPROPERTY()
	int32 Count = 0;

	UPROPERTY()
	FInstancedStruct Nested;
};

UCLASS()
class UUEMCPFixtureInstancedAsset : public UDataAsset
{
	GENERATED_BODY()
public:
	UPROPERTY()
	FInstancedStruct Value;

	UPROPERTY()
	TArray<FInstancedStruct> Values;
};

// Test-only author and independent UE evaluator for an owned editor fixture.
UCLASS()
class UChooserFixtureLibrary : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()
public:
	UFUNCTION(BlueprintCallable, Category = "Fixture")
	static bool CreateChooserFixture();

	UFUNCTION(BlueprintCallable, Category = "Fixture")
	static bool CreateInstancedStructFixture();

	UFUNCTION(BlueprintCallable, Category = "Fixture")
	static bool SwapChooserFixtureResults();

	UFUNCTION(BlueprintCallable, Category = "Fixture")
	static bool SetChooserFixtureComparisons();

	UFUNCTION(BlueprintCallable, Category = "Fixture")
	static bool AddUnsupportedChooserColumn();

	UFUNCTION(BlueprintCallable, Category = "Fixture")
	static FString EvaluateChooserFixture(FName Key, bool bProvideInput = true);
};
