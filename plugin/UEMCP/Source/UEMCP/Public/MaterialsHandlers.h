// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

/**
 * M5-PREP scaffold for the materials toolset (D101 + verifier audit).
 *
 * Stubs the 3 not-yet-shipped materials tools from tools.yaml `materials:`:
 *   - create_material
 *   - create_material_instance
 *   - set_material_parameter  (per D101 (ii), sub-worker may instead ship
 *                              this as an RC delegate via rc-tools.mjs and
 *                              drop the plugin C++ stub — RC API exposes
 *                              SetScalar/Vector/TextureParameterValue UFUNCTIONs)
 *
 * The 2 shipped tools (list_material_parameters via rc-tools.mjs FULL-RC,
 * get_material_graph via GraphTraversalHandlers.cpp under M-enhance D77) are
 * NOT touched here — sub-worker should not duplicate them.
 *
 * Sub-worker M5-animation+materials replaces the lambda stubs in
 * MaterialsHandlers.cpp with real handlers.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/** Adds the not-shipped materials handlers to the registry. Call pre-thread-create. */
	void RegisterMaterialsHandlers(FMCPCommandRegistry& Registry);
}
