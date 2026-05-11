// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * Blueprints-write handlers on TCP:55558.
 *
 * Replaces the conformance oracle (UnrealMCP plugin BlueprintCommands +
 * BlueprintNodeCommands, TCP:55557) per D23. Wire-shape parity preserved
 * for migrated callers — only the response envelope is upgraded to P0-1
 * (every error now carries a structured `code`).
 *
 * Per conformance-oracle-contracts.md §8.1, the 6 BlueprintNodeCommands
 * "orphans" (function_node, variable, self_reference, component_reference,
 * connect_nodes, find_nodes) were already absorbed into the blueprints-write
 * toolset, giving 15 total endpoints — NOT 21 as the M3 handoff prose
 * suggested. The orphan-handler "dispatch shape" is one named handler per
 * command type (mirrors oracle + M3-actors precedent), not a single
 * dispatched-by-node-type handler.
 *
 * Handlers shipped (matching tools.yaml `blueprints-write:` toolset):
 *   - create_blueprint                            (UBlueprint at /Game/Blueprints/<name>)
 *   - add_component_to_blueprint                  (SCS node + auto-compile)
 *   - set_component_property                      (Component template UProperty setter)
 *   - compile_blueprint                           (FKismetEditorUtilities::CompileBlueprint)
 *   - set_blueprint_property                      (CDO UProperty setter)
 *   - set_static_mesh_properties                  (Mesh + slot-0 material on UStaticMeshComponent)
 *   - set_physics_properties                      (UPrimitiveComponent physics tunables)
 *   - set_pawn_properties                         (Per-property results — partial-success aware)
 *   - add_blueprint_event_node                    (UK2Node_Event with dedup)
 *   - add_blueprint_function_node                 (UK2Node_CallFunction; graph_name + pin-default coercion)
 *   - add_blueprint_variable                      (5 simple types: Bool/Int/Float/String/Vector)
 *   - add_blueprint_function_graph                (Function graph + FunctionEntry metadata)
 *   - add_blueprint_variable_get_node             (UK2Node_VariableGet for member variable)
 *   - add_blueprint_variable_set_node             (UK2Node_VariableSet for member variable)
 *   - add_blueprint_variable_assignment           (literal/source variable assignment helper)
 *   - add_blueprint_control_node                  (Branch, Sequence, Return)
 *   - add_blueprint_math_node                     (KismetMathLibrary math/vector wrapper)
 *   - add_blueprint_self_reference                (UK2Node_Self)
 *   - add_blueprint_get_self_component_reference  (UK2Node_VariableGet for component)
 *   - connect_blueprint_nodes                     (NodeGuid → validated pin link)
 *   - find_blueprint_nodes                        (Read-only; graph_name + node_type=Event only)
 *
 * All handlers run on the game thread (D83 — central marshal at
 * MCPCommandRegistry::Dispatch). BP compile / SCS mutations / FKismet utilities
 * are all game-thread-only, and the compile pipeline can hitch >100ms on cold
 * BPs (P0-11 instrumentation flags it via `hitch:` log line).
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/** Adds the blueprints-write handlers to the registry. Call pre-thread-create. */
	void RegisterBlueprintHandlers(FMCPCommandRegistry& Registry);
}
