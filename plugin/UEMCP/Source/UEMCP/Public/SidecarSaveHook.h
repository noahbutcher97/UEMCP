// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

/**
 * Save-hook that writes a narrow sidecar (SidecarWriter) when a Blueprint
 * is saved. Wired via FCoreUObjectDelegates::OnObjectPreSave — we pre-save
 * because the sidecar reflects in-memory derived state (compile status +
 * reflection), which is equivalent pre- and post-save, and OnObjectPreSave
 * is the non-deprecated surface in UE 5.6.
 *
 * Registration guarantees:
 *   - Registered from FUEMCPModule::StartupModule under the non-commandlet
 *     gate (D57) — no commandlet should auto-write sidecars; that's the
 *     3F-4 production commandlet's explicit job (Session 4).
 *   - Unregistered from FUEMCPModule::ShutdownModule to avoid dangling
 *     delegate bindings during module hot-reload.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	void RegisterSidecarSaveHook();
	void UnregisterSidecarSaveHook();

	/** MCP command handler — exposes WriteNarrowSidecar as `regenerate_sidecar`. */
	void RegisterSidecarCommands(FMCPCommandRegistry& Registry);
}
