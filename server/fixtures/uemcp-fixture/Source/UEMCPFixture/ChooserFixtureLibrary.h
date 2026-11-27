#pragma once
#include "Kismet/BlueprintFunctionLibrary.h"
#include "ChooserFixtureLibrary.generated.h"

USTRUCT()
struct FUEMCPChooserInput
{
	GENERATED_BODY()

	UPROPERTY()
	FName Key;
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
	static bool SwapChooserFixtureResults();

	UFUNCTION(BlueprintCallable, Category = "Fixture")
	static bool AddUnsupportedChooserColumn();

	UFUNCTION(BlueprintCallable, Category = "Fixture")
	static FString EvaluateChooserFixture(FName Key, bool bProvideInput = true);
};
