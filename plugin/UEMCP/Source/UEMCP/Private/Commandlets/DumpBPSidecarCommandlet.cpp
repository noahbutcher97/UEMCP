// Copyright Optimum Athena. All Rights Reserved.
#include "DumpBPSidecarCommandlet.h"
#include "Logging.h"
#include "SidecarWriter.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "Engine/Blueprint.h"
#include "Modules/ModuleManager.h"
#include "UObject/SoftObjectPath.h"

UDumpBPSidecarCommandlet::UDumpBPSidecarCommandlet()
{
	IsEditor = true;
	IsServer = false;
	IsClient = false;
	LogToConsole = true;
	HelpDescription = TEXT("3F-4: batch writes narrow-sidecar-v1 JSON for Blueprints under <Project>/Saved/UEMCP/.");
	HelpUsage = TEXT("-run=DumpBPSidecar (-BPs=/Game/A.A,/Game/B.B | -PathRoot=/Game/Blueprints [-Recursive])");
}

namespace
{
	UBlueprint* ResolveBlueprint(const FString& Path)
	{
		if (UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *Path)) return BP;
		const FSoftObjectPath Soft(Path);
		if (UObject* Obj = Soft.TryLoad()) return Cast<UBlueprint>(Obj);
		return nullptr;
	}

	/** Query asset registry for all UBlueprint assets under PathRoot. Editor must have
	 *  a populated registry — commandlet launch does this by default. */
	int32 CollectBlueprintsUnderPath(const FString& PathRoot, bool bRecursive, TArray<FString>& OutAssetPaths)
	{
		FAssetRegistryModule& ARModule = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(TEXT("AssetRegistry"));
		IAssetRegistry& AR = ARModule.Get();

		// Ensure the registry is populated — a fresh commandlet may start before the
		// async initial scan completes. SearchAllAssets with bSynchronousSearch=true
		// blocks until ready.
		AR.SearchAllAssets(true);

		FARFilter Filter;
		Filter.bRecursivePaths   = bRecursive;
		Filter.bRecursiveClasses = true;
		Filter.ClassPaths.Add(UBlueprint::StaticClass()->GetClassPathName());
		Filter.PackagePaths.Add(FName(*PathRoot));

		TArray<FAssetData> Found;
		if (!AR.GetAssets(Filter, Found))
		{
			UE_LOG(LogUEMCP, Error, TEXT("DumpBPSidecar: AssetRegistry query failed for '%s'"), *PathRoot);
			return 2;
		}

		for (const FAssetData& AD : Found)
		{
			// Emit the object path (package.asset form) — ResolveBlueprint handles both.
			OutAssetPaths.Add(AD.GetObjectPathString());
		}
		return 0;
	}
}

int32 UDumpBPSidecarCommandlet::Main(const FString& Params)
{
	TArray<FString> Tokens;
	TArray<FString> Switches;
	TMap<FString, FString> SwitchParams;
	UCommandlet::ParseCommandLine(*Params, Tokens, Switches, SwitchParams);

	const FString* BPsPtr      = SwitchParams.Find(TEXT("BPs"));
	const FString* PathRootPtr = SwitchParams.Find(TEXT("PathRoot"));
	const bool     bRecursive  = Switches.Contains(TEXT("Recursive"));

	TArray<FString> AssetPaths;

	if (BPsPtr && !BPsPtr->IsEmpty())
	{
		BPsPtr->ParseIntoArray(AssetPaths, TEXT(","), true);
	}
	else if (PathRootPtr && !PathRootPtr->IsEmpty())
	{
		const int32 Res = CollectBlueprintsUnderPath(*PathRootPtr, bRecursive, AssetPaths);
		if (Res != 0) return Res;
	}
	else
	{
		UE_LOG(LogUEMCP, Error, TEXT("DumpBPSidecar: either -BPs or -PathRoot required. Usage: %s"), *HelpUsage);
		return 1;
	}

	if (AssetPaths.Num() == 0)
	{
		UE_LOG(LogUEMCP, Warning, TEXT("DumpBPSidecar: zero assets resolved — nothing to do"));
		return 0;
	}

	UE_LOG(LogUEMCP, Display, TEXT("DumpBPSidecar: processing %d Blueprint(s)"), AssetPaths.Num());

	int32 SuccessCount = 0;
	int32 FailCount    = 0;

	for (const FString& Path : AssetPaths)
	{
		UBlueprint* BP = ResolveBlueprint(Path);
		if (!BP)
		{
			UE_LOG(LogUEMCP, Warning, TEXT("DumpBPSidecar: could not load UBlueprint at '%s'"), *Path);
			++FailCount;
			continue;
		}

		FString Error;
		if (!UEMCP::WriteNarrowSidecar(BP, Error))
		{
			UE_LOG(LogUEMCP, Warning, TEXT("DumpBPSidecar: write failed for '%s': %s"), *Path, *Error);
			++FailCount;
			continue;
		}
		++SuccessCount;
	}

	UE_LOG(LogUEMCP, Display, TEXT("DumpBPSidecar: %d succeeded, %d failed (of %d total)"),
		SuccessCount, FailCount, AssetPaths.Num());

	return FailCount > 0 ? 3 : 0;
}
