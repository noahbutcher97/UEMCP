// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Commandlets/Commandlet.h"
#include "DumpBPGraphCommandlet.generated.h"

/**
 * M-new Oracle-A dev-infra commandlet: dumps pin-edge topology for a single
 * Blueprint asset as JSON. Ground-truth oracle for M-new S-B-base differential
 * tests (NOT an end-user tool; no tools.yaml entry).
 *
 * Invocation:
 *   UnrealEditor-Cmd.exe <project.uproject> -run=DumpBPGraph
 *     -BP=/Game/Path/To/BP_Asset -Out=<abs-or-project-rel>.oracle.json
 *     [-Pretty] -unattended -nop4 -nosplash -stdout
 *
 * Exit codes: 0 success, 1 arg parse error, 2 BP load failure, 3 JSON write failure.
 */
UCLASS()
class UDumpBPGraphCommandlet : public UCommandlet
{
	GENERATED_BODY()
public:
	UDumpBPGraphCommandlet();
	virtual int32 Main(const FString& Params) override;
};
