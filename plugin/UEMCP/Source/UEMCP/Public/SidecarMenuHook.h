// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

/**
 * Content Browser asset context menu hook — adds "Regenerate UEMCP sidecar"
 * when a Blueprint is right-clicked. Uses FContentBrowserModule's
 * asset-context-menu extender API, which is lighter than a full
 * FUICommandList + FUICommandInfo + style-set registration.
 *
 * Registration lifecycle mirrors SidecarSaveHook:
 *   - Register at StartupModule (non-commandlet gate).
 *   - Unregister at ShutdownModule to clean up delegate handle.
 */
namespace UEMCP
{
	void RegisterSidecarMenuHook();
	void UnregisterSidecarMenuHook();
}
