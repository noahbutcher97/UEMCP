// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

class UBlueprint;
class UWorld;

/**
 * W-F (D137): shared handler-side helpers extracted out of per-file anonymous
 * namespaces. D133's W-E refactor restored bUseUnity = true on this module;
 * Unity bundling then surfaced 4 duplicate-symbol pairs across handler files
 * that had been silently coexisting under non-Unity (TU-local anonymous
 * namespace mangling). This header is the structural fix promised in the
 * UEMCP.Build.cs comment block: "Future workers must add new shared helpers
 * to a Public/ header rather than per-file anonymous namespaces."
 *
 * Helpers in scope:
 *   - GetEditorWorld()     — editor-context world resolver, PIE-aware
 *   - ResolveBlueprint()   — /Game/... path → UBlueprint* (LoadObject + soft-path fallback)
 *   - ToObjectPath()       — package-only path → doubled object-path form
 *   - GetStringOr()        — JSON string field with fallback default
 *
 * Production callers (post W-F adoption, 2026-05-05):
 *   - GetEditorWorld:    ActorHandlers.cpp, GeometryHandlers.cpp
 *   - ResolveBlueprint:  CompileDiagnosticHandler.cpp, GraphTraversalHandlers.cpp
 *   - ToObjectPath:      AnimationHandlers.cpp, MaterialsHandlers.cpp
 *   - GetStringOr:       AnimationHandlers.cpp, MaterialsHandlers.cpp
 *
 * NOT in scope: BlueprintHandlers.cpp::ResolveBlueprint (different signature —
 * `(JsonObject Params, OutResponse, FString* OutName)` is a presentation-layer
 * helper that emits error envelopes inline; intentionally retained as
 * file-local). C++ overload resolution would handle co-existence safely if
 * BlueprintHandlers ever needs UEMCP::ResolveBlueprint(FString); not extracted
 * because the semantic surface area differs.
 *
 * See docs/tracking/risks-and-decisions.md D133 (cause) + D137 (this fix).
 */
namespace UEMCP
{
	/**
	 * Returns the active editor's world (PIE-aware). Falls back to GWorld if
	 * GEditor's FWorldContext is unavailable. Identical implementation
	 * pre-extraction in ActorHandlers.cpp (canonical) + GeometryHandlers.cpp.
	 */
	UWorld* GetEditorWorld();

	/**
	 * Resolve `/Game/Path/BP_Name` (or doubled object-path) → UBlueprint*.
	 * Returns nullptr if the path doesn't load or doesn't resolve to a
	 * UBlueprint. LoadObject is tried first (handles both package-only and
	 * doubled forms); FSoftObjectPath::TryLoad is the soft fallback.
	 *
	 * NOTE — this is the pure resolver. BlueprintHandlers.cpp's
	 * file-local ResolveBlueprint(JsonObject, OutResponse, OutName) is a
	 * different presentation-layer helper that wraps this kind of resolution
	 * with error-envelope emission; it is NOT this function.
	 */
	UBlueprint* ResolveBlueprint(const FString& AssetPath);

	/**
	 * `/Game/Foo/Bar` → `/Game/Foo/Bar.Bar` (canonical doubled object-path
	 * form). Pass-through if AssetPath already contains `.`. Used by handlers
	 * that pass paths to LoadObject<T> — the doubled form survives PIE state
	 * (D102 institutional memory).
	 */
	FString ToObjectPath(const FString& AssetPath);

	/**
	 * Read a string field from a JSON params object with a default fallback.
	 * Returns Default if Params is null, the field is absent, or the field
	 * is not a string. Convenience wrapper around TryGetStringField.
	 */
	FString GetStringOr(const TSharedPtr<FJsonObject>& Params, const TCHAR* Field, const FString& Default);
}
