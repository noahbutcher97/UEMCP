// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

/**
 * M5-PREP scaffold for the geometry toolset (D101 + verifier audit).
 *
 * Stubs the 3 not-yet-shipped procedural-mesh tools from tools.yaml `geometry:`:
 *   - create_procedural_mesh
 *   - mesh_boolean
 *   - generate_uvs
 *
 * The 1 shipped tool (get_mesh_info via rc-tools.mjs FULL-RC under M-enhance
 * D77) is NOT touched here.
 *
 * Sub-worker M5-input+geometry replaces the lambda stubs in
 * GeometryHandlers.cpp. tools.yaml flags this toolset as "requires Geometry
 * Script plugin" — sub-worker must gate handlers on
 * IPluginManager::FindPlugin("GeometryScript")->IsEnabled() OR return a typed
 * PLUGIN_DISABLED error envelope (per D101 (iii) verifier open question).
 * GeometryScriptingCore module dep would need adding to UEMCP.Build.cs.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/** Adds the not-shipped geometry handlers to the registry. Call pre-thread-create. */
	void RegisterGeometryHandlers(FMCPCommandRegistry& Registry);
}
