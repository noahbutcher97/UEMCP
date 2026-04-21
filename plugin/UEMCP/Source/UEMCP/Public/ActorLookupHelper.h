// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

class AActor;
class UWorld;

/**
 * P0-2 + P0-3: Actor lookup across all loaded levels with name-or-label resolution.
 *
 * P0-2 — searches persistent level + all streaming sublevels via UWorld::GetLevels().
 * P0-3 — accepts either FName (Actor->GetName()) or Outliner label (Actor->GetActorLabel()).
 *         FName match is tried first; label match only if FName finds nothing.
 *
 * Ambiguity (multiple actors sharing the same label, or FNames across streaming levels)
 * is flagged in AmbiguousCandidates so callers can report AMBIGUOUS_LABEL / AMBIGUOUS_NAME.
 *
 * See docs/specs/phase3-plugin-design-inputs.md P0-2 and P0-3.
 */
namespace UEMCP
{
	struct FActorLookupResult
	{
		/** Resolved actor, or nullptr if not found / ambiguous. */
		AActor* Actor = nullptr;

		/** Levels that were walked (for the error payload's `searched_levels` field). */
		TArray<FString> SearchedLevels;

		/** If multiple actors match the given label (or FName across streaming), all are listed here. */
		TArray<AActor*> AmbiguousCandidates;

		/** True if the match was by FName (false if by label, or not found). */
		bool bMatchedByName = false;
	};

	/**
	 * Find an actor by FName or ActorLabel across all loaded levels of World.
	 * If LevelName is non-empty, restricts search to that level only (and includes
	 * it in SearchedLevels so missing actors still get a diagnostic trail).
	 */
	FActorLookupResult FindActorInAllLevels(const FString& NameOrLabel, UWorld* World, const FString& LevelName = TEXT(""));
}
