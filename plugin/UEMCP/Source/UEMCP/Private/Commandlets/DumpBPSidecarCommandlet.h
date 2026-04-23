// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"
#include "DumpBPSidecarCommandlet.generated.h"

/**
 * 3F-4 production commandlet — batches narrow-sidecar generation across a
 * BP path-list or asset-registry query. Reuses CP5's WriteNarrowSidecar,
 * so the on-disk shape matches the save-hook output byte-for-byte.
 *
 * Two invocation modes:
 *
 *   1) Explicit BP list:
 *      UnrealEditor-Cmd.exe <project.uproject> -run=DumpBPSidecar
 *        -BPs=/Game/A.A,/Game/B.B,/Game/C.C
 *        [-unattended -nop4 -nosplash -stdout]
 *
 *   2) Path glob:
 *      UnrealEditor-Cmd.exe <project.uproject> -run=DumpBPSidecar
 *        -PathRoot=/Game/Blueprints
 *        [-Recursive]
 *
 * Either -BPs or -PathRoot is required (not both).
 *
 * Exit codes:
 *   0 success, 1 arg parse error, 2 asset-registry unavailable,
 *   3 any sidecar write failed (partial success still writes what it can).
 */
UCLASS()
class UDumpBPSidecarCommandlet : public UCommandlet
{
	GENERATED_BODY()
public:
	UDumpBPSidecarCommandlet();
	virtual int32 Main(const FString& Params) override;
};
