#pragma once
#include "Commandlets/Commandlet.h"
#include "OwnedPIEFixtureCommandlet.generated.h"

// Explicit coordinator-only authoring or fresh-process verification; never starts PIE.
UCLASS()
class UOwnedPIEFixtureCommandlet : public UCommandlet
{
	GENERATED_BODY()
public:
	UOwnedPIEFixtureCommandlet();
	virtual int32 Main(const FString& Params) override;
};
