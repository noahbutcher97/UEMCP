#pragma once

#include "CoreMinimal.h"
#include "UObject/Object.h"
#include "UEMCPEditorIdentity.generated.h"

USTRUCT(BlueprintType)
struct FUEMCPConnectionIdentity
{
	GENERATED_BODY()
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="UEMCP") FString ProjectFile;
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="UEMCP") int64 ProcessId = 0;
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Category="UEMCP") int32 TcpPort = 0;
};

/** Read-only RC metadata: verifies HTTP and TCP resolve to the same editor. */
UCLASS()
class UEMCP_API UUEMCPEditorIdentity : public UObject
{
	GENERATED_BODY()
public:
	UPROPERTY(VisibleAnywhere, BlueprintReadOnly, Transient, Category="UEMCP") FUEMCPConnectionIdentity Identity;
	static void Publish(int32 TcpPort);
};
