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
 * whole parse — no silent coercion. See docs/specs/phase3-plugin-design-inputs.md P0-10.
 */
namespace UEMCP
{
	/** Returns true on success. On false, OutError contains a diagnostic suitable for the error envelope. */
	bool BuildTransformFromJson(const TSharedPtr<FJsonObject>& Params, FTransform& OutTransform, FString& OutError);

	bool ParseVector3(const TSharedPtr<FJsonObject>& Obj, const FString& FieldName, FVector& OutVec, FString& OutError);
	bool ParseRotator(const TSharedPtr<FJsonObject>& Obj, const FString& FieldName, FRotator& OutRot, FString& OutError);
}
