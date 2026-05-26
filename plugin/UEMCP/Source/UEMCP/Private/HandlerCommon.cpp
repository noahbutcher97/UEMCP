// Copyright Optimum Athena. All Rights Reserved.
#include "HandlerCommon.h"

#include "Editor.h"
#include "Engine/Blueprint.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "UObject/Class.h"            // UClass
#include "UObject/SoftObjectPath.h"
#include "UObject/UObjectGlobals.h"   // LoadClass, FindFirstObjectSafe, EFindFirstObjectOptions

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

	UClass* ResolveClass(const FString& Identifier, UClass* RequiredBase)
	{
		if (Identifier.IsEmpty())
		{
			return nullptr;
		}

		UClass* Resolved = nullptr;

		if (Identifier.Contains(TEXT("/")))
		{
			// Normalize a package-only path to its Blueprint generated-class path
			// BEFORE the first LoadClass. Passing a suffix-less package path to
			// LoadClass emits a "Class None.<package>" warning + a refused
			// FlushAsyncLoading, and on a cold BP can degrade to an empty result
			// (see ReflectionWalker.cpp normalize-first rationale).
			FString Normalized = Identifier;
			if (!Normalized.Contains(TEXT(".")))
			{
				int32 SlashIdx = INDEX_NONE;
				if (Normalized.FindLastChar(TEXT('/'), SlashIdx) && SlashIdx + 1 < Normalized.Len())
				{
					const FString Leaf = Normalized.Mid(SlashIdx + 1);
					Normalized = Normalized + TEXT(".") + Leaf + TEXT("_C");
				}
			}

			Resolved = LoadClass<UObject>(nullptr, *Normalized);

			// Soft-path fallback: resolves a UBlueprint asset → its GeneratedClass,
			// or a UClass object directly.
			if (!Resolved)
			{
				const FSoftObjectPath Soft(Normalized);
				if (UObject* Obj = Soft.TryLoad())
				{
					if (UBlueprint* BP = Cast<UBlueprint>(Obj))
					{
						Resolved = BP->GeneratedClass;
					}
					else if (UClass* AsClass = Cast<UClass>(Obj))
					{
						Resolved = AsClass;
					}
				}
			}
		}
		else
		{
			// Short name → native in-memory lookup (native classes are always loaded;
			// FindFirstObjectSafe won't assert during GC / package-save).
			Resolved = FindFirstObjectSafe<UClass>(*Identifier, EFindFirstObjectOptions::NativeFirst);
			if (!Resolved && !Identifier.StartsWith(TEXT("U")))
			{
				const FString WithPrefix = TEXT("U") + Identifier;
				Resolved = FindFirstObjectSafe<UClass>(*WithPrefix, EFindFirstObjectOptions::NativeFirst);
			}
		}

		if (Resolved && RequiredBase && !Resolved->IsChildOf(RequiredBase))
		{
			return nullptr;
		}
		return Resolved;
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
