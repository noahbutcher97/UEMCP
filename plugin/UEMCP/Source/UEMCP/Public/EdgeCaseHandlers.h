// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * FULL-TCP edge-case handlers that RC cannot cover (FA-ε §Q1):
 *
 *   get_editor_state     — GEditor->GetSelectedActors() + active viewport info.
 *   start_pie / stop_pie — UEditorEngine::PlayInEditor / RequestEndPlayMap.
 *   is_pie_running       — trivial but consistent with PIE control surface.
 *   get_widget_blueprint — UWidgetBlueprint tree traversal with property bindings.
 *   get_asset_references — IAssetRegistry::GetReferencers + reverse-dep walk.
 *   execute_console_command — FCmd::Exec via editor world.
 *
 * Visual capture (get_asset_preview_render) deferred to a follow-on — requires
 * FPreviewScene + FWidgetRenderer infrastructure (offscreen render) which is
 * substantially heavier than the other handlers in this file.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	void RegisterEdgeCaseHandlers(FMCPCommandRegistry& Registry);
}
