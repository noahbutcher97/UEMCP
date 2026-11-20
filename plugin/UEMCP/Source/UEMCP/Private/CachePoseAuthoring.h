// Copyright Noah Butcher. All Rights Reserved.
#pragma once
#include "CoreMinimal.h"
class FJsonObject;
class FJsonValue;
class UEdGraph;
class UEdGraphNode;
class UEdGraphPin;
class UAnimGraphNode_SaveCachedPose;
namespace UEMCP
{
	void HandleEditAnimCachedPose(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& Response);
	TArray<TSharedPtr<FJsonValue>> ReadCachedPoseNodes(const UEdGraph* Graph);
	FString CachedPoseRevision(const UEdGraphNode* Node);
	// Includes implicit Use -> Save dependencies, and a proposed replacement input edge.
	bool ValidateCachedPoseGraph(UEdGraph* Graph, FString& Error, UEdGraphPin* Source = nullptr, UEdGraphPin* Target = nullptr,
		const UAnimGraphNode_SaveCachedPose* RenamedSave = nullptr, const FString& RenameName = FString());
}
