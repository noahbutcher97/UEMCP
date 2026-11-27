#pragma once

#include "Engine/DataAsset.h"
#include "UEMCPFixtureEvaluationConfig.generated.h"

USTRUCT(BlueprintType)
struct FUEMCPFixtureEvaluationSettings
{
	GENERATED_BODY()

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Evaluation")
	float Threshold = 0.5f;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Evaluation")
	int32 Seed = 17;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Evaluation")
	FVector Offset = FVector(1.0, 2.0, 3.0);

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Evaluation")
	TArray<float> Weights = {1.0f, 2.0f, 3.0f};
};

UCLASS(BlueprintType)
class UEMCPFIXTURE_API UUEMCPFixtureEvaluationConfig : public UDataAsset
{
	GENERATED_BODY()

public:
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Evaluation")
	FUEMCPFixtureEvaluationSettings Settings;

	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Evaluation")
	TObjectPtr<UUEMCPFixtureEvaluationConfig> Reference;
};
