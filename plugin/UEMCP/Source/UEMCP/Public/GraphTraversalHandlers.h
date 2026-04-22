// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * UEdGraph traversal handlers — two bespoke walks that RC cannot cover
 * because the graph topology doesn't map to a flat UPROPERTY surface.
 *
 * Shipped command types:
 *   - "get_material_graph"     (tools.yaml: materials.get_material_graph)
 *   - "get_event_dispatchers"  (tools.yaml: blueprint-read.get_blueprint_event_dispatchers)
 *
 * Material graph: shape is Oracle-A-aligned (node_guid-keyed map, pin list,
 * linked_to), with a shape_version marker. Material topology semantics
 * diverge from K2Node (material expressions have typed input/output pins
 * categorized by UMaterialExpression subclass) — the divergence is documented
 * via the shape_version field.
 *
 * Event dispatchers: serialize multicast-delegate UPROPERTY fields plus any
 * binding-site K2Nodes (K2Node_BindDelegate / _UnbindDelegate / _Event).
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	void RegisterGraphTraversalHandlers(FMCPCommandRegistry& Registry);
}
