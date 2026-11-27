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
};

UCLASS(BlueprintType)
class UEMCPFIXTURE_API UUEMCPFixtureEvaluationConfig : public UDataAsset
{
	GENERATED_BODY()

public:
	UPROPERTY(EditAnywhere, BlueprintReadWrite, Category = "Evaluation")
	FUEMCPFixtureEvaluationSettings Settings;
};
