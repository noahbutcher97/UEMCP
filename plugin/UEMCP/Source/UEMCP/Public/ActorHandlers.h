// Copyright Optimum Athena. All Rights Reserved.
#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * M3-actors: 10 actor-toolset handlers reimplemented on TCP:55558.
 *
 * Replaces the conformance oracle (UnrealMCP plugin, TCP:55557) per D23.
 * Wire-shape parity preserved for migrated callers (same `result` field
 * names/types) — the only client-visible delta is the P0-1 envelope
 * (every error now carries a structured `code`).
 *
 * Handlers shipped (matching tools.yaml `actors:` toolset):
 *   - get_actors_in_level    (List all actors in level)
 *   - find_actors_by_name    (Substring match on actor name)
 *   - spawn_actor            (Primitive types: StaticMeshActor, lights, camera)
 *   - delete_actor
 *   - set_actor_transform    (Partial-update: any of location/rotation/scale)
 *   - get_actor_properties
 *   - set_actor_property     (bool/int/float/string/enum coercion via shared helper)
 *   - spawn_blueprint_actor  (Looks up under /Game/Blueprints/<name>)
 *   - focus_viewport         (Move editor camera to actor or world position)
 *   - take_screenshot        (Capture editor viewport to PNG file)
 *
 * All handlers run on the game thread (D83 — central marshal at
 * MCPCommandRegistry::Dispatch). They use `ActorLookupHelper::FindActorInAllLevels`
 * for name-or-label resolution across persistent + streaming levels (P0-2/P0-3),
 * a quality lift over the oracle's GWorld-only single-shot lookup.
 */
namespace UEMCP
{
	class FMCPCommandRegistry;

	/** Adds the 10 actor-toolset handlers to the registry. Call pre-thread-create. */
	void RegisterActorHandlers(FMCPCommandRegistry& Registry);
}
