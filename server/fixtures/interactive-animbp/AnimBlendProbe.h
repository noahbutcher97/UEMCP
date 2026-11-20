#pragma once

#include "Kismet/BlueprintFunctionLibrary.h"
#include "AnimBlendProbe.generated.h"

class UAnimBlueprint;
class UAnimSequence;
class USkeletalMesh;

UCLASS()
class UAnimBlendProbe : public UBlueprintFunctionLibrary
{
	GENERATED_BODY()
public:
	UFUNCTION(BlueprintCallable, Category="Fixture")
	static bool Seed(UAnimBlueprint* Blueprint, USkeletalMesh* Mesh, UAnimSequence* A, UAnimSequence* B, bool bSeedMontageSlot = false);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static FString Inspect(UAnimBlueprint* Blueprint);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static bool SeedFormatArgument(UAnimBlueprint* Blueprint);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static FString Sample(UAnimBlueprint* Blueprint, USkeletalMesh* Mesh, float Input);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static FString SampleCachedPose(UAnimBlueprint* Blueprint, USkeletalMesh* Mesh);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static bool SetCacheReference(UAnimBlueprint* Blueprint, const FString& UseGuid, const FString& SaveGuid);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static bool History(bool Redo);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static FString SampleSlot(UAnimBlueprint* Blueprint, USkeletalMesh* Mesh, UAnimSequence* Clip, FName Slot);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static FString SampleStates(UAnimBlueprint* Blueprint, USkeletalMesh* Mesh);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static FString SkeletonSlots(UAnimBlueprint* Blueprint);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static FString SetCompileSavePolicy(bool bEnable);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static bool IsEditorOpen(UAnimBlueprint* Blueprint);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static FString Members(UAnimBlueprint* Blueprint);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static bool ReconstructAlpha(UAnimBlueprint* Blueprint);

	UFUNCTION(BlueprintCallable, Category="Fixture")
	static FString PlantCompileError(UAnimBlueprint* Blueprint);
};
