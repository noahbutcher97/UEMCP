// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

/**
 * M5-PREP scaffold for the editor-utility toolset (D101 + verifier audit).
 *
 * Stubs the 6 not-yet-shipped editor-utility tools from tools.yaml `editor-utility:`:
 *   - run_python_command       (D14 deny-list spec applies — os, subprocess,
 *                                eval, exec, open, __import__; per D101 (iv)
 *                                sub-worker may also gate on a startup flag
 *                                like --allow-python-exec for defense in depth)
 *   - get_editor_utility_blueprint  (yaml comment "displaced_by:
 *                                    inspect_blueprint, read_asset_properties"
 *                                    — sub-worker may route via existing
 *                                    reflection_walk PARTIAL-RC pattern)
 *   - run_editor_utility
 *   - duplicate_asset
 *   - rename_asset
 *   - delete_asset_safe        (D14 risk: must call IAssetRegistry::GetReferencers()
 *                                before delete; refuse if hard refs exist
 *                                unless force=true)
 *
 * The 1 shipped tool (get_editor_state via menhance-tcp-tools.mjs under
 * M-enhance D77, EdgeCaseHandlers.cpp:359) is NOT touched here.
 *
 * Sub-worker M5-editor-utility replaces the lambda stubs in
 * EditorUtilityHandlers.cpp. Highest security review burden of the 5 M5
 * toolsets — Python exec + asset delete are CRITICAL/WARNING in the
 * audit-discovered risks table.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/** Adds the not-shipped editor-utility handlers to the registry. Call pre-thread-create. */
	void RegisterEditorUtilityHandlers(FMCPCommandRegistry& Registry);
}
