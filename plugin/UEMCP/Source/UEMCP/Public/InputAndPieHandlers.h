// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

/**
 * M5-PREP scaffold for the input-and-pie toolset (D101 + verifier audit).
 *
 * Stubs the 3 not-yet-shipped Enhanced Input asset-creation tools from
 * tools.yaml `input-and-pie:`:
 *   - create_input_action
 *   - create_mapping_context
 *   - add_mapping
 *
 * IMPORTANT — the 4 shipped PIE-control + console tools (start_pie / stop_pie
 * / is_pie_running / execute_console_command) live in EdgeCaseHandlers.cpp
 * under M-enhance (D77). The InputAndPieHandlers.cpp file in this stub set
 * is named for symmetry with the toolset name, but should ONLY hold the
 * 3 Enhanced Input asset-creation handlers — do NOT duplicate the PIE
 * handlers here, that would conflict with the EdgeCaseHandlers registration.
 *
 * Sub-worker M5-input+geometry replaces the lambda stubs in
 * InputAndPieHandlers.cpp with real handlers. UInputAction /
 * UInputMappingContext live in the EnhancedInput module — sub-worker will
 * need to add EnhancedInput to UEMCP.Build.cs PrivateDependencyModuleNames.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/** Adds the not-shipped Enhanced Input handlers to the registry. Call pre-thread-create. */
	void RegisterInputAndPieHandlers(FMCPCommandRegistry& Registry);
}
