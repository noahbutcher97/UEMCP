// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "EditorAssetLibrary.h"
#include "UObject/Object.h"
#include "UObject/Package.h"

/**
 * §4.5 — PIE-safe asset loader with LoadObject cascade fallback.
 *
 * UEditorAssetLibrary::LoadAsset is the conventional editor-asset loader but
 * fails to resolve some asset types when PIE is active (D99 finding #3 —
 * empirically observed for UWidgetBlueprint: "Widget Blueprint X not found"
 * under PIE; same path resolves clean PIE-off). The PIE failure mode plausibly
 * affects other LoadAsset callsites that don't have the cascade — D126 audit
 * Class F enumerated 5 such sites + the existing WidgetHandlers cascade.
 *
 * Cascade order:
 *   1. LoadObject<T>(nullptr, *AssetPath) — works for both package-only and
 *      doubled object-path inputs; survives PIE state.
 *   2. If AssetPath looks package-only (no '.'), construct the canonical
 *      doubled form ("/Path/Asset.Asset") and retry LoadObject<T>.
 *   3. Final fallback: Cast<T>(UEditorAssetLibrary::LoadAsset(AssetPath)) —
 *      kept for parity with prior behavior on edge cases that resolve only
 *      through the editor-asset library.
 *
 * Single-call semantics: returns the first non-null result; does not chain
 * further attempts after a successful resolve. Returns nullptr if every step
 * fails — caller is responsible for emitting an ASSET_NOT_FOUND envelope.
 */
namespace UEMCP
{
	template<typename T>
	T* LoadAssetPIESafe(const FString& AssetPath)
	{
		if (AssetPath.IsEmpty())
		{
			return nullptr;
		}

		// Step 1: direct LoadObject — works for both /Path/Asset and
		// /Path/Asset.Asset forms.
		if (T* Direct = LoadObject<T>(nullptr, *AssetPath))
		{
			return Direct;
		}

		// Step 2: if the input is package-only (no dot), build the doubled
		// /Path/Asset.Asset form and retry. Skip when the input already
		// contains a dot — Step 1 would have handled it.
		if (!AssetPath.Contains(TEXT(".")))
		{
			FString LeafName;
			AssetPath.Split(TEXT("/"), nullptr, &LeafName, ESearchCase::IgnoreCase, ESearchDir::FromEnd);
			if (!LeafName.IsEmpty())
			{
				const FString DoubledPath = FString::Printf(TEXT("%s.%s"), *AssetPath, *LeafName);
				if (T* Doubled = LoadObject<T>(nullptr, *DoubledPath))
				{
					return Doubled;
				}
			}
		}

		// Step 3: editor-asset-library fallback (the path that fails under PIE
		// for some asset types but is the only resolver for some edge cases).
		return Cast<T>(UEditorAssetLibrary::LoadAsset(AssetPath));
	}
}
