// Copyright Noah Butcher. All Rights Reserved.
#pragma once
#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

namespace UEMCP
{
	class FMCPCommandRegistry;
	void RegisterMaterialGraphAuthoring(FMCPCommandRegistry& Registry);
	void ReadMaterialSourceGraph(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& Response);
}
