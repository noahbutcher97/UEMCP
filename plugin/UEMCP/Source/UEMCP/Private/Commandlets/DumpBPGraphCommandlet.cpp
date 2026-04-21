// Copyright Optimum Athena. All Rights Reserved.
#include "DumpBPGraphCommandlet.h"
#include "EdgeOnlyBPSerializer.h"
#include "Logging.h"

#include "Engine/Blueprint.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "UObject/Package.h"

UDumpBPGraphCommandlet::UDumpBPGraphCommandlet()
{
	IsEditor = true;
	IsServer = false;
	IsClient = false;
	LogToConsole = true;
	HelpDescription = TEXT("Dumps a Blueprint's pin-edge topology as JSON (M-new Oracle-A dev-infra).");
	HelpUsage = TEXT("-run=DumpBPGraph -BP=/Game/Path/To/BP -Out=path/to/out.json [-Pretty]");
}

int32 UDumpBPGraphCommandlet::Main(const FString& Params)
{
	TArray<FString> Tokens;
	TArray<FString> Switches;
	TMap<FString, FString> SwitchParams;
	UCommandlet::ParseCommandLine(*Params, Tokens, Switches, SwitchParams);

	const FString* BPPathPtr = SwitchParams.Find(TEXT("BP"));
	const FString* OutPathPtr = SwitchParams.Find(TEXT("Out"));
	const bool bPretty = Switches.Contains(TEXT("Pretty"));

	if (!BPPathPtr || BPPathPtr->IsEmpty() || !OutPathPtr || OutPathPtr->IsEmpty())
	{
		UE_LOG(LogUEMCP, Error, TEXT("DumpBPGraph: required switches missing. Usage: %s"), *HelpUsage);
		return 1;
	}

	const FString BPPath = *BPPathPtr;
	FString OutPath = *OutPathPtr;
	if (FPaths::IsRelative(OutPath))
	{
		OutPath = FPaths::ConvertRelativePathToFull(OutPath);
	}

	UE_LOG(LogUEMCP, Display, TEXT("DumpBPGraph: loading BP '%s'"), *BPPath);
	UBlueprint* Blueprint = LoadObject<UBlueprint>(nullptr, *BPPath);
	if (!Blueprint)
	{
		UE_LOG(LogUEMCP, Error, TEXT("DumpBPGraph: failed to load UBlueprint at '%s'"), *BPPath);
		return 2;
	}

	FString Json;
	if (!UEMCP::SerializeBlueprintEdges(Blueprint, BPPath, bPretty, Json))
	{
		UE_LOG(LogUEMCP, Error, TEXT("DumpBPGraph: JSON serialization failed"));
		return 3;
	}

	if (!FFileHelper::SaveStringToFile(Json, *OutPath))
	{
		UE_LOG(LogUEMCP, Error, TEXT("DumpBPGraph: failed to write JSON to '%s'"), *OutPath);
		return 3;
	}

	UE_LOG(LogUEMCP, Display, TEXT("DumpBPGraph: wrote %d bytes to '%s'"), Json.Len(), *OutPath);
	return 0;
}
