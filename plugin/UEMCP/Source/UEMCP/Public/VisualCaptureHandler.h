// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * get_asset_preview_render — capture an asset's thumbnail as JPEG.
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
 *     mime: "image/jpeg",
 *     base64: "...",         // optional — only if request had return_base64 = true
 *     file_path: "...",      // optional — only if request had output_path set
 *   }
 *
 * Note: offscreen render via FPreviewScene + FWidgetRenderer (handoff §2.5)
 * is NOT implemented here — the thumbnail path covers 90% of use cases at
 * a fraction of the complexity. A full offscreen render is future scope.
 *
 * get_viewport_screenshot — capture the active editor viewport as PNG.
 *
 * Uses GEditor->GetActiveViewport(), FViewport::ReadPixels, optional
 * FImageUtils::ImageResize, and FImageUtils::CompressImage. This is the
 * inline visual-capture counterpart to the legacy actors.take_screenshot
 * file-output command.
 *
 * Response shape:
 *   {
 *     source_width: 1920, source_height: 1080,
 *     width: 768, height: 432,
 *     mime: "image/png",
 *     byte_length: 123456,
 *     base64: "...",         // optional — omitted when return_base64 = false
 *     file_path: "...",      // optional — output_path with .png appended if missing
 *   }
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	void RegisterVisualCaptureHandler(FMCPCommandRegistry& Registry);
}
