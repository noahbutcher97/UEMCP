// Copyright Optimum Athena. All Rights Reserved.
#include "ActorLookupHelper.h"
#include "Engine/World.h"
#include "Engine/Level.h"
#include "GameFramework/Actor.h"
#include "Misc/PackageName.h"
#include "UObject/Package.h"

namespace UEMCP
{
	FActorLookupResult FindActorInAllLevels(const FString& NameOrLabel, UWorld* World, const FString& LevelName)
	{
		FActorLookupResult Result;

		if (!World || NameOrLabel.IsEmpty())
		{
			return Result;
		}

		TArray<AActor*> NameMatches;
		TArray<AActor*> LabelMatches;

		const TArray<ULevel*>& Levels = World->GetLevels();
		for (ULevel* Level : Levels)
		{
			if (!Level)
			{
				continue;
			}

			// Level name is derived from the outer package (e.g., "L_Main" from "/Game/Maps/L_Main").
			const FString LvlName = Level->GetOutermost()->GetName();
			const FString LvlShortName = FPackageName::GetShortName(LvlName);

			// Apply LevelName filter if specified (match against either full path or short name).
			if (!LevelName.IsEmpty() && LvlName != LevelName && LvlShortName != LevelName)
			{
				continue;
			}
			Result.SearchedLevels.Add(LvlShortName);

			for (AActor* Actor : Level->Actors)
			{
				if (!IsValid(Actor))
				{
					continue;
				}
				if (Actor->GetName() == NameOrLabel)
				{
					NameMatches.Add(Actor);
				}
				else if (Actor->GetActorLabel() == NameOrLabel)
				{
					LabelMatches.Add(Actor);
				}
			}
		}

		// P0-3 resolution order: FName first.
		if (NameMatches.Num() == 1)
		{
			Result.Actor = NameMatches[0];
			Result.bMatchedByName = true;
			return Result;
		}
		if (NameMatches.Num() > 1)
		{
			// FName collision across streaming levels — flag as ambiguous.
			Result.AmbiguousCandidates = NameMatches;
			return Result;
		}

		// Fall back to label.
		if (LabelMatches.Num() == 1)
		{
			Result.Actor = LabelMatches[0];
			Result.bMatchedByName = false;
			return Result;
		}
		if (LabelMatches.Num() > 1)
		{
			Result.AmbiguousCandidates = LabelMatches;
			return Result;
		}

		// Not found — Result.Actor stays nullptr, SearchedLevels populated for caller's diagnostic.
		return Result;
	}
}
