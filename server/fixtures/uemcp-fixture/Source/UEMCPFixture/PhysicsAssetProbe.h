#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "PhysicsAssetProbe.generated.h"

class UPhysicsAsset;
class USkeletalMesh;

UCLASS()
class UEMCPFIXTURE_API UPhysicsAssetProbe : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()
public:
	// Scoped to the disposable qualification asset. No production handler calls this probe.
	UFUNCTION(BlueprintCallable, Category="Fixture")
	static FString Seed(UPhysicsAsset* Asset, USkeletalMesh* PreviewMesh);
	UFUNCTION(BlueprintCallable, Category="Fixture")
	static bool FlipInvalidTopology(UPhysicsAsset* Asset, bool bIntroduce);
	UFUNCTION(BlueprintCallable, Category="Fixture")
	static FString Observe(UPhysicsAsset* Asset, FName SimulateJoint);
};
