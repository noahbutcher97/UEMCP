#pragma once
#include "Commandlets/Commandlet.h"
#include "AuthorSerializationFixtureCommandlet.generated.h"

UCLASS()
class UAuthorSerializationFixtureCommandlet : public UCommandlet
{
	GENERATED_BODY()
public:
	UAuthorSerializationFixtureCommandlet();
	virtual int32 Main(const FString& Params) override;
};
