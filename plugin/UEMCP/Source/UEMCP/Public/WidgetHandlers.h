// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * M3-widgets: 7 widgets-toolset handlers reimplemented on TCP:55558.
 *
 * Replaces the conformance oracle (UnrealMCP plugin, TCP:55557) per D23.
 * Wire-shape parity preserved against oracle responses for the 5 working
 * handlers; the 2 previously-broken handlers (set_text_block_binding,
 * add_widget_to_viewport) ship CORRECTED behavior here — the rebuild is
 * the right time to land the fix.
 *
 * Handlers shipped (matching tools.yaml `widgets:` toolset):
 *   - create_umg_widget_blueprint    (Widget Blueprint at /Game/Widgets/<name>)
 *   - add_text_block_to_widget       (TextBlock into root CanvasPanel)
 *   - add_button_to_widget           (Button + child TextBlock)
 *   - bind_widget_event              (CreateNewBoundEventForClass + position)
 *   - set_text_block_binding         (FIXED: pure getter graph + FDelegateEditorBinding)
 *   - add_widget_to_viewport         (FIXED: PIE-aware CreateWidget + AddToViewport)
 *   - add_blueprint_input_action_node (legacy Input Actions — surfaced via widgets toolset
 *                                      for historical UI grouping reasons; semantically a
 *                                      BlueprintNodeCommands op)
 *
 * All handlers run on the game thread (D83 — central marshal at
 * MCPCommandRegistry::Dispatch). Every error envelope carries a structured
 * P0-4 `code` field (NOT_IN_PIE, BLUEPRINT_NOT_FOUND, MISSING_PARAMS, etc.)
 * — additive vs the oracle's plain `error` text.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/** Adds the 7 widgets-toolset handlers to the registry. Call pre-thread-create. */
	void RegisterWidgetHandlers(FMCPCommandRegistry& Registry);
}
