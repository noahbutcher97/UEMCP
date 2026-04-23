// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * get_asset_preview_render — capture an asset's thumbnail as PNG.
 *
 * Uses UThumbnailManager's rendered thumbnail path (RenderThumbnail into
 * a FObjectThumbnail cache entry) which reuses the editor's existing
 * thumbnail-generation pipeline. Supports any UObject asset that has a
 * UThumbnailRenderer registered — static meshes, textures, materials,
 * blueprints, skeletal meshes, animation sequences, data assets, etc.
 *
 * Response shape:
 *   {
 *     asset_path: "...",
 *     width: 256, height: 256,
 *     mime: "image/png",
 *     base64: "...",         // optional — only if request had return_base64 = true
 *     file_path: "...",      // optional — only if request had output_path set
 *   }
 *
 * Note: offscreen render via FPreviewScene + FWidgetRenderer (handoff §2.5)
 * is NOT implemented here — the thumbnail path covers 90% of use cases at
 * a fraction of the complexity. A full offscreen render is future scope.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	void RegisterVisualCaptureHandler(FMCPCommandRegistry& Registry);
}
