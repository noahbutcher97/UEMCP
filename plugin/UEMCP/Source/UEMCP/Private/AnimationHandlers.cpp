// Copyright Optimum Athena. All Rights Reserved.
#include "AnimationHandlers.h"

#include "MCPCommandRegistry.h"
#include "MCPResponseBuilder.h"

namespace UEMCP
{
	void RegisterAnimationHandlers(FMCPCommandRegistry& Registry)
	{
		// Stubs — M5-animation+materials sub-worker fills these in. Each registration
		// returns a typed `not_implemented` error envelope so live editor calls fail
		// loudly rather than silently. To find every stub to replace: grep this file
		// for `NotImplemented(TEXT(`.
		auto NotImplemented = [](const TCHAR* ToolName)
		{
			return [ToolName](const TSharedPtr<FJsonObject>& /*Params*/, TSharedPtr<FJsonObject>& OutResponse)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("M5 tool '%s' not yet shipped (stub from M5-PREP)"), ToolName),
					TEXT("not_implemented"));
			};
		};

		Registry.Register(TEXT("create_montage"),       NotImplemented(TEXT("create_montage")));
		Registry.Register(TEXT("add_montage_section"),  NotImplemented(TEXT("add_montage_section")));
		Registry.Register(TEXT("add_montage_notify"),   NotImplemented(TEXT("add_montage_notify")));
		// get_audio_asset_info: per D101 (v), sub-worker should evaluate whether to
		// implement via reflection_walk OR mark SUPERSEDED (offline read_asset_properties
		// already covers SoundCue / SoundWave CDO metadata per D50 tagged-fallback).
		Registry.Register(TEXT("get_audio_asset_info"), NotImplemented(TEXT("get_audio_asset_info")));
	}
}
