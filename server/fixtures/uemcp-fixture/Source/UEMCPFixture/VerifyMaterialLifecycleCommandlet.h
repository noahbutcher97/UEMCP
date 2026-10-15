#pragma once
#include "Commandlets/Commandlet.h"
#include "VerifyMaterialLifecycleCommandlet.generated.h"

/** Owned host only: verify material Undo, then saved values in a fresh process. */
UCLASS()
class UVerifyMaterialLifecycleCommandlet : public UCommandlet
{
	GENERATED_BODY()
public:
	UVerifyMaterialLifecycleCommandlet();
	virtual int32 Main(const FString& Params) override;
};
