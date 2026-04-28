// Copyright Optimum Athena. All Rights Reserved.
#include "BlueprintLookupHelper.h"

#include "AssetRegistry/AssetRegistryModule.h"
#include "AssetRegistry/IAssetRegistry.h"
#include "AssetRegistry/ARFilter.h"
#include "AssetRegistry/AssetData.h"
#include "Engine/Blueprint.h"
#include "Misc/PackageName.h"

namespace UEMCP
{
	bool ResolveBlueprintAssetPath(
		const FString& Input,
		FString& OutPackagePath,
		FString& OutError,
		FString& OutErrorCode)
	{
		if (Input.IsEmpty())
		{
			OutError = TEXT("Blueprint name is empty");
			OutErrorCode = TEXT("BLUEPRINT_NOT_FOUND");
			return false;
		}

		// Case 1: fully-qualified /Game/... path — accept both package form
		// (/Game/Path/BP_X) and object form (/Game/Path/BP_X.BP_X). Strip the
		// .Asset suffix to obtain the package path that DoesPackageExist + the
		// caller's LoadObject expect.
		if (Input.StartsWith(TEXT("/Game/")))
		{
			FString PackageOnly = Input;
			int32 DotIdx;
			if (Input.FindChar(TEXT('.'), DotIdx))
			{
				PackageOnly = Input.Left(DotIdx);
			}
			if (FPackageName::DoesPackageExist(PackageOnly))
			{
				OutPackagePath = PackageOnly;
				return true;
			}
			OutError = FString::Printf(TEXT("Blueprint package not found: %s"), *PackageOnly);
			OutErrorCode = TEXT("BLUEPRINT_NOT_FOUND");
			return false;
		}

		// Case 2: bare name — legacy /Game/Blueprints/<Name> back-compat probe.
		// Epic-template-derived projects keep working without code change.
		const FString LegacyPath = FString::Printf(TEXT("/Game/Blueprints/%s"), *Input);
		if (FPackageName::DoesPackageExist(LegacyPath))
		{
			OutPackagePath = LegacyPath;
			return true;
		}

		// Case 3: AssetRegistry fallback — bare-name search project-wide.
		// Mirrors DumpBPSidecarCommandlet.cpp:36-50 enumeration pattern.
		FAssetRegistryModule& ARM = FModuleManager::LoadModuleChecked<FAssetRegistryModule>(
			TEXT("AssetRegistry"));
		IAssetRegistry& AR = ARM.Get();

		FARFilter Filter;
		Filter.bRecursiveClasses = true;
		Filter.ClassPaths.Add(UBlueprint::StaticClass()->GetClassPathName());

		TArray<FAssetData> Hits;
		AR.GetAssets(Filter, Hits);

		TArray<FString> Matches;
		for (const FAssetData& Hit : Hits)
		{
			if (Hit.AssetName.ToString() == Input)
			{
				Matches.Add(Hit.PackageName.ToString());
			}
		}

		if (Matches.Num() == 1)
		{
			OutPackagePath = Matches[0];
			return true;
		}
		if (Matches.Num() > 1)
		{
			OutError = FString::Printf(
				TEXT("Ambiguous Blueprint name '%s' (%d matches: %s) — pass a fully-qualified /Game/... path to disambiguate"),
				*Input, Matches.Num(), *FString::Join(Matches, TEXT(", ")));
			OutErrorCode = TEXT("BLUEPRINT_AMBIGUOUS");
			return false;
		}

		OutError = FString::Printf(
			TEXT("Blueprint '%s' not found (checked %s, then AssetRegistry project-wide)"),
			*Input, *LegacyPath);
		OutErrorCode = TEXT("BLUEPRINT_NOT_FOUND");
		return false;
	}
}
