// Copyright Optimum Athena. All Rights Reserved.
#include "HandlerCommon.h"

#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "UObject/SoftObjectPath.h"

namespace UEMCP
{
	UWorld* GetEditorWorld()
	{
		if (GEditor)
		{
			if (FWorldContext* Ctx = &GEditor->GetEditorWorldContext())
			{
				return Ctx->World();
			}
		}
		return GWorld;
	}

	UBlueprint* ResolveBlueprint(const FString& AssetPath)
	{
		// Full object path first — handles both `/Game/Path/BP_Name` and
		// `/Game/Path/BP_Name.BP_Name` doubled-object-path forms.
		if (UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *AssetPath))
		{
			return BP;
		}
		// Soft-path fallback — tolerates package-only inputs that LoadObject
		// rejected, and survives some PIE-state edge cases where direct
		// LoadObject misses an asset that StaticLoadObject still resolves.
		const FSoftObjectPath SoftPath(AssetPath);
		if (UObject* Obj = SoftPath.TryLoad())
		{
			return Cast<UBlueprint>(Obj);
		}
		return nullptr;
	}

	FString ToObjectPath(const FString& AssetPath)
	{
		if (AssetPath.Contains(TEXT(".")))
		{
			return AssetPath;
		}
		const int32 SlashIdx = AssetPath.Find(TEXT("/"), ESearchCase::IgnoreCase, ESearchDir::FromEnd);
		if (SlashIdx < 0)
		{
			return AssetPath;
		}
		const FString AssetName = AssetPath.Mid(SlashIdx + 1);
		return FString::Printf(TEXT("%s.%s"), *AssetPath, *AssetName);
	}

	FString GetStringOr(const TSharedPtr<FJsonObject>& Params, const TCHAR* Field, const FString& Default)
	{
		// Verbatim from AnimationHandlers / MaterialsHandlers (W-F extraction). Callers
		// always validate Params before calling — preserved exactly to keep behavior
		// invariant across the refactor.
		FString Out;
		return Params->TryGetStringField(Field, Out) ? Out : Default;
	}
}
