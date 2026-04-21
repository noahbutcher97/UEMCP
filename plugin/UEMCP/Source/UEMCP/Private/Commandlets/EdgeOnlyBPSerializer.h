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
 *     "schema_version": "oracle-a-v1",
 *     "engine_version": "<FEngineVersion::Current().ToString()>",
 *     "asset_path": "/Game/...",
 *     "graphs": {
 *       "<graph_name>": {
 *         "nodes": {
 *           "<NodeGuid>": {
 *             "class_name": "K2Node_CallFunction",
 *             "pins": {
 *               "<PinId>": {
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
 * Returns true on success; OutJson is populated unconditionally but is only
 * guaranteed well-formed when the return is true.
 */
bool SerializeBlueprintEdges(UBlueprint* Blueprint, const FString& AssetPath, bool bPretty, FString& OutJson);
}
