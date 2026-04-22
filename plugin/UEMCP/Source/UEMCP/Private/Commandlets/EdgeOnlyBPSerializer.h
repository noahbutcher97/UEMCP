// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"

class UBlueprint;

namespace UEMCP
{
/**
 * Narrow edge-only BP serializer. Output shape:
 *
 *   {
 *     "schema_version": "oracle-a-v2",
 *     "engine_version": "<FEngineVersion::Current().ToString()>",
 *     "asset_path": "/Game/...",
 *     "graphs": {
 *       "<graph_name>": {
 *         "nodes": {
 *           "<NodeGuid>": {
 *             "class_name": "K2Node_CallFunction",
 *             "pins": {
 *               "<PinId>": {
 *                 "name": "<FName PinName>",
 *                 "direction": "EGPD_Input",
 *                 "linked_to": [ { "node_guid": "...", "pin_id": "..." } ]
 *               }
 *             }
 *           }
 *         }
 *       }
 *     }
 *   }
 *
 * Deliberate narrowness: no pin defaults, no pin types, no UPROPERTY payload.
 * S-B-base diffs edge sets, nothing else.
 *
 * v2 (D68): added "name" field inside each pin dict alongside the pin_id key.
 * Post-load pin IDs for K2Node_EditablePinBase subclasses + K2Node_PromotableOperator
 * are deterministically-derived from node context rather than read from disk, so
 * they don't match disk IDs. Pin names ARE stable across this divergence because
 * they're declared by the node type. S-B-base's differential harness uses hybrid
 * matching: primary pass by pin_id (~96.5%), fallback by (node_guid, name) tuple
 * (~3.5%). pin_id remains the dict key; name is a new field within the pin object.
 *
 * Returns true on success; OutJson is populated unconditionally but is only
 * guaranteed well-formed when the return is true.
 */
bool SerializeBlueprintEdges(UBlueprint* Blueprint, const FString& AssetPath, bool bPretty, FString& OutJson);
}
