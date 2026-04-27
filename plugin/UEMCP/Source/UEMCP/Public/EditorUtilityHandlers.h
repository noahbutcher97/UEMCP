// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

/**
 * M5-editor-utility — 6 security-sensitive editor-utility tools (D101 + D103 scaffold).
 *
 * Tools shipped:
 *   - run_python_command       — defense-in-depth (4 layers per D101 (iv) decision):
 *                                  Layer 1 (server-side, JS): --enable-python-exec
 *                                    flag gate emits PYTHON_EXEC_DISABLED before
 *                                    any wire dispatch.
 *                                  Layer 0 (plugin-side): IPythonScriptPlugin::Get()
 *                                    runtime check emits PYTHON_PLUGIN_NOT_AVAILABLE.
 *                                  Layer 2 (plugin-side): D14 deny-list scan
 *                                    (`os`, `subprocess`, `eval`, `exec`, `open(`,
 *                                    `__import__`) emits PYTHON_EXEC_DENY_LIST.
 *                                  Layer 3: per-call audit log to <ProjectName>.log
 *                                    via LogUEMCPSecurity.
 *   - get_editor_utility_blueprint — EUB / EUW introspection (parent class +
 *                                    interfaces + Run-method signature + editor-
 *                                    menu registration data).
 *   - run_editor_utility       — invokes a `Run` UFunction on a transient EUB CDO.
 *   - duplicate_asset          — UEditorAssetLibrary::DuplicateAsset; refuses
 *                                pre-existing destination unless overwrite:true.
 *   - rename_asset             — UEditorAssetLibrary::RenameAsset (reference fixup).
 *   - delete_asset_safe        — D14 risk: IAssetRegistry::GetReferencers pre-check
 *                                emits ASSET_HAS_DEPENDENCIES unless force:true;
 *                                soft-delete (default) moves to /Game/_Deleted/;
 *                                permanent:true requires force:true sentinel.
 *                                Per-call audit log via LogUEMCPSecurity.
 *
 * The 1 shipped tool (get_editor_state via menhance-tcp-tools.mjs / EdgeCaseHandlers.cpp
 * under M-enhance D77) is NOT touched here.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/** Registers the 6 editor-utility handlers on the dispatch registry. */
	void RegisterEditorUtilityHandlers(FMCPCommandRegistry& Registry);
}
