// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

/**
 * Animation handlers for the animation toolset.
 *
 * AnimationHandlers.cpp owns mutation tools:
 *   - create_montage
 *   - add_montage_section
 *   - add_montage_notify
 *
 * It also owns dedicated animation asset reads that must load editor asset
 * instances directly:
 *   - get_anim_graph
 *   - get_montage_full
 *   - get_anim_sequence_info
 *
 * Reflection-backed generic reads remain in the Node M-enhance surface for
 * blend spaces and curve data where full editor graph topology is not needed.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/** Adds the animation handlers to the registry. Call pre-thread-create. */
	void RegisterAnimationHandlers(FMCPCommandRegistry& Registry);
}
