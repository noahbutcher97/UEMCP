// Copyright Optimum Athena. All Rights Reserved.
#include "VisualCaptureHandler.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

#include "AssetRegistry/AssetData.h"
#include "Misc/Base64.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "ObjectTools.h"
#include "Misc/ObjectThumbnail.h"
#include "ThumbnailRendering/ThumbnailManager.h"
#include "UObject/Object.h"
#include "UObject/SoftObjectPath.h"

namespace UEMCP
{
	namespace
	{
		void HandleGetAssetPreviewRender(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			if (!Params.IsValid())
			{
				BuildErrorResponse(OutResponse, TEXT("get_asset_preview_render requires params.asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}
			FString AssetPath;
			if (!Params->TryGetStringField(TEXT("asset_path"), AssetPath) || AssetPath.IsEmpty())
			{
				BuildErrorResponse(OutResponse, TEXT("get_asset_preview_render requires non-empty asset_path"), TEXT("MISSING_PARAMS"));
				return;
			}

			// Optional knobs.
			bool bReturnBase64 = true;   // Default — inline base64 PNG in response.
			bool bReturnBase64Tmp = false;
			if (Params->TryGetBoolField(TEXT("return_base64"), bReturnBase64Tmp))
			{
				bReturnBase64 = bReturnBase64Tmp;
			}
			FString OutputFilePath;
			Params->TryGetStringField(TEXT("output_path"), OutputFilePath);  // optional

			int32 Width = 256;  Params->TryGetNumberField(TEXT("width"),  Width);
			int32 Height = 256; Params->TryGetNumberField(TEXT("height"), Height);

			// Load the asset.
			const FSoftObjectPath Soft(AssetPath);
			UObject* Asset = Soft.TryLoad();
			if (!Asset)
			{
				Asset = LoadObject<UObject>(nullptr, *AssetPath);
			}
			if (!Asset)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Could not load asset at '%s'"), *AssetPath),
					TEXT("ASSET_NOT_FOUND"));
				return;
			}

			// Use ThumbnailTools to render into a FObjectThumbnail. This reuses the
			// editor's existing UThumbnailRenderer registration — static meshes,
			// textures, materials, blueprints, etc. all get their native preview.
			FObjectThumbnail Thumbnail;
			ThumbnailTools::RenderThumbnail(Asset, Width, Height, ThumbnailTools::EThumbnailTextureFlushMode::AlwaysFlush, nullptr, &Thumbnail);

			// FObjectThumbnail has two independent buffers: ImageData (raw BGRA,
			// populated by RenderThumbnail above) and CompressedImageData (JPEG —
			// despite the field name suggesting PNG, UE's CompressImageData() uses
			// JPEG encoding internally; bytes start with FFD8 FFE0 SOI+JFIF). The
			// buffer is populated only by an explicit CompressImageData() call or
			// by Serialize-from-disk. AccessCompressedImageData() below has NO
			// lazy-encode fallback — without this explicit compression step it
			// returns empty bytes even when the renderer ran successfully.
			Thumbnail.CompressImageData();

			const TArray<uint8>& JpegBytes = Thumbnail.AccessCompressedImageData();
			if (JpegBytes.Num() == 0)
			{
				// Distinguish "no renderer registered for this class" (lookup
				// returned null) from "renderer ran but produced 0 bytes" (real
				// renderer pathology — e.g., asset-state issue, unsupported
				// subclass). Same outcome, very different debug story.
				const FThumbnailRenderingInfo* RenderInfo =
					UThumbnailManager::Get().GetRenderingInfo(Asset);
				const bool bHasRenderer = (RenderInfo != nullptr) && (RenderInfo->Renderer != nullptr);
				const FString Detail = bHasRenderer
					? FString(TEXT("renderer ran but produced 0 bytes (asset state may not support thumbnail rendering)"))
					: FString::Printf(TEXT("no UThumbnailRenderer registered for class %s"), *Asset->GetClass()->GetName());
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Thumbnail rendered empty for '%s' — %s"), *AssetPath, *Detail),
					TEXT("RENDER_FAILED"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), Asset->GetPathName());
			Result->SetStringField(TEXT("asset_class"), Asset->GetClass()->GetName());
			Result->SetNumberField(TEXT("width"),  Thumbnail.GetImageWidth());
			Result->SetNumberField(TEXT("height"), Thumbnail.GetImageHeight());
			Result->SetStringField(TEXT("mime"),   TEXT("image/jpeg"));
			Result->SetNumberField(TEXT("byte_length"), JpegBytes.Num());

			// Optional write to disk — useful for chat clients that can't render base64
			// JPEG inline but can preview file paths.
			if (!OutputFilePath.IsEmpty())
			{
				if (FPaths::IsRelative(OutputFilePath))
				{
					OutputFilePath = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir(), OutputFilePath);
				}
				if (!FFileHelper::SaveArrayToFile(JpegBytes, *OutputFilePath))
				{
					UE_LOG(LogTemp, Warning, TEXT("get_asset_preview_render: failed to write JPEG to '%s'"), *OutputFilePath);
				}
				else
				{
					Result->SetStringField(TEXT("file_path"), OutputFilePath);
				}
			}

			if (bReturnBase64)
			{
				// Base64 payload size: ~4/3 × byte_length. For a 256×256 thumbnail that's
				// typically 20-60 KB base64-encoded — well under stdio frame limits but
				// worth flagging so callers can opt out when streaming many thumbnails.
				Result->SetStringField(TEXT("base64"), FBase64::Encode(JpegBytes));
			}

			BuildSuccessResponse(OutResponse, Result);
		}
	}

	void RegisterVisualCaptureHandler(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("get_asset_preview_render"), &HandleGetAssetPreviewRender);
	}
}
