// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

/**
 * M5-PREP scaffold for the animation toolset (D101 + verifier audit).
 *
 * Stubs the 4 not-yet-shipped animation tools from tools.yaml `animation:`:
 *   - create_montage
 *   - add_montage_section
 *   - add_montage_notify
 *   - get_audio_asset_info  (open question — yaml comment "displaced_by:
 *                            read_asset_properties"; sub-worker may mark
 *                            SUPERSEDED instead of implementing per D101 (v))
 *
 * The 4 shipped reads (get_montage_full / get_anim_sequence_info /
 * get_blend_space / get_anim_curve_data) are ALREADY served by
 * ReflectionWalker.cpp under M-enhance (D77) — do NOT duplicate them here.
 *
 * Sub-worker M5-animation+materials replaces the lambda stubs in
 * AnimationHandlers.cpp with real handlers following the ActorHandlers
 * convention (game-thread-safe, BuildSuccessResponse / BuildErrorResponse
 * envelope, oracle-parity wire shapes where applicable).
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/** Adds the not-shipped animation handlers to the registry. Call pre-thread-create. */
	void RegisterAnimationHandlers(FMCPCommandRegistry& Registry);
}
