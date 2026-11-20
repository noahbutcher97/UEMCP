// Copyright Noah Butcher. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

class FJsonObject;
class UEdGraphPin;
class UEdGraphSchema;

namespace UEMCP
{
	void HandleInsertAnimSlot(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& Response);
	void InsertAnimSlot(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& Response,
		TFunctionRef<bool(const UEdGraphSchema*, UEdGraphPin*, UEdGraphPin*)> Connect);
}
