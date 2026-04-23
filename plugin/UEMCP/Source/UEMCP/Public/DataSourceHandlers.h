// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * Data-source handlers (PARTIAL-RC, CP4 remainder):
 *   - get_datatable_contents   — UDataTable rows as CSV + structured per-row map
 *   - get_string_table_contents — UStringTable namespace/key/source triples
 *   - list_data_asset_types     — enumerate UDataAsset subclasses loaded in memory
 *
 * These are tools RC's /remote/object/describe cannot cover end-to-end —
 * either the surface is UClass-iteration (DataAsset subclasses, no object path)
 * or the values are struct-keyed maps that RC doesn't serialize well.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	void RegisterDataSourceHandlers(FMCPCommandRegistry& Registry);
}
