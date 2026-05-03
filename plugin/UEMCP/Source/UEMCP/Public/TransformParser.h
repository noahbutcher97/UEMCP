// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"
#include "Math/Transform.h"

/**
 * P0-10: Transform parsers return bool + OutError instead of silently zeroing.
 *
 * Accepted formats (all optional — missing fields default to identity):
 *   "location": [x, y, z]                (FVector)
 *   "rotation": [pitch, yaw, roll]       (FRotator, matches legacy 55557 convention)
 *   "scale":    [x, y, z]                (FVector)
 *
 * Malformed fields (wrong type, wrong length, non-numeric elements) fail the
 * whole parse — no silent coercion. ParseVector3 / ParseRotator are exact-3-element
 * (>= 3 was the old TryReadVector3 contract; ParseVector3 is stricter — invalid
 * input now produces a typed error instead of partial-read).
 *
 * Production callers (post W-E adoption, 2026-05-03):
 *   - ActorHandlers.cpp (HandleSpawnActor / HandleSetActorTransform / HandleSpawnBlueprintActor /
 *     HandleFocusViewport) — replaced 8 in-place TryReadVector3/TryReadRotator call sites
 *   - BlueprintHandlers.cpp (HandleAddComponentToBlueprint) — replaced 3 call sites
 *   - GeometryHandlers.cpp (HandleCreateProceduralMesh) — replaced 1 call site
 * Adopting the parser eliminated 5 anonymous-namespace duplicate definitions across
 * ActorHandlers + BlueprintHandlers + GeometryHandlers, unblocking bUseUnity = true.
 *
 * See docs/specs/phase3-plugin-design-inputs.md P0-10.
 */
namespace UEMCP
{
	/** Returns true on success. On false, OutError contains a diagnostic suitable for the error envelope. */
	bool BuildTransformFromJson(const TSharedPtr<FJsonObject>& Params, FTransform& OutTransform, FString& OutError);

	bool ParseVector3(const TSharedPtr<FJsonObject>& Obj, const FString& FieldName, FVector& OutVec, FString& OutError);
	bool ParseRotator(const TSharedPtr<FJsonObject>& Obj, const FString& FieldName, FRotator& OutRot, FString& OutError);
}
