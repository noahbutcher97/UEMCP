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

			// Extract compressed PNG bytes. FObjectThumbnail's internal format is raw
			// BGRA; AccessCompressedImageData() returns the cached PNG-encoded buffer
			// (lazy-inits from the raw BGRA on first access). Always non-null after
			// RenderThumbnail succeeds with non-zero dimensions.
			const TArray<uint8>& PngBytes = Thumbnail.AccessCompressedImageData();
			if (PngBytes.Num() == 0)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Thumbnail rendered empty for '%s' — no UThumbnailRenderer may be registered for %s"),
						*AssetPath, *Asset->GetClass()->GetName()),
					TEXT("RENDER_FAILED"));
				return;
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), Asset->GetPathName());
			Result->SetStringField(TEXT("asset_class"), Asset->GetClass()->GetName());
			Result->SetNumberField(TEXT("width"),  Thumbnail.GetImageWidth());
			Result->SetNumberField(TEXT("height"), Thumbnail.GetImageHeight());
			Result->SetStringField(TEXT("mime"),   TEXT("image/png"));
			Result->SetNumberField(TEXT("byte_length"), PngBytes.Num());

			// Optional write to disk — useful for chat clients that can't render base64
			// PNG inline but can preview file paths.
			if (!OutputFilePath.IsEmpty())
			{
				if (FPaths::IsRelative(OutputFilePath))
				{
					OutputFilePath = FPaths::ConvertRelativePathToFull(FPaths::ProjectSavedDir(), OutputFilePath);
				}
				if (!FFileHelper::SaveArrayToFile(PngBytes, *OutputFilePath))
				{
					UE_LOG(LogTemp, Warning, TEXT("get_asset_preview_render: failed to write PNG to '%s'"), *OutputFilePath);
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
				Result->SetStringField(TEXT("base64"), FBase64::Encode(PngBytes));
			}

			BuildSuccessResponse(OutResponse, Result);
		}
	}

	void RegisterVisualCaptureHandler(FMCPCommandRegistry& Registry)
	{
		Registry.Register(TEXT("get_asset_preview_render"), &HandleGetAssetPreviewRender);
	}
}
