# Discovering and placing asset-backed graph nodes

**Proposed first delivery.** An agent can bind a pawn to a named Enhanced Input action or play a named sequence in an AnimBP by discovering and invoking the same contextual action Unreal offers in the graph editor. The two operations share discovery, placement and Undo. Each family supplies its own compatibility check and verifies the referenced asset on the placed node.

## Why the asset belongs in the action identity

On UE 5.8.4, a CLI agent asked to bind a mapped action through public UEMCP tools could create a generic event that compiled with zero errors. A fresh Unreal process found no Enhanced Input event on the pawn. The legacy writer produced a legacy node. The failure occurred before possession or gameplay dispatch. [Input binding qualification](gameplay-driven-character-animation.md#current-public-authoring-coverage)

The installed engine source identifies a reusable mechanism. In `UK2Node_EnhancedInputAction::GetMenuActions`, Unreal registers a spawner for each input action and sets the new node's `InputAction` reference. For a Sequence Player, `UAnimGraphNode_AssetPlayerBase::GetMenuActionsHelper` registers asset data with a spawner and applies asset-specific initialization. The helper also supports an empty player. An empty player, a player for Walk and a player for Run can share a class. UEMCP's existing two-way-blend discovery returns that class path as the action identifier. [Current discovery and placement](../../plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp)

## Proposed public contract

| Operation | Agent supplies | Agent receives |
| --- | --- | --- |
| `find_graph_actions` (read) | Target Blueprint package and graph name or GUID. Optionally an exact source asset path or a search term such as “Interact”. | Resolved graph GUID and topology revision. A bounded list of supported matches with action ID, family, display name and full source asset path. Indicate truncation and distinguish incomplete registry discovery from a complete search with zero matches. Ambiguous graph names return graph choices. |
| `place_graph_action` (edit) | Target Blueprint package, graph GUID, expected revision, action ID from discovery and node position. | Whether a node was created or reused, its GUID and class, the asset reference read from the node, actual pin IDs/types/directions, resulting revision, and dirty packages. Wiring, compile and save remain explicit steps. |

For example, two results labeled `IA_Interact` in different folders must show both paths. The client can refine by exact path or ask which asset the user intended. A placement request carries the selected ID. The server must never resolve a mutation by taking the first display-name match.

For an exact asset query, also return matching nodes already placed in that graph with their GUIDs, positions and observed references. This gives pawn Event Graph callers the same retry check as AnimGraph callers. After a timeout, compare these GUIDs with the pre-edit set. If concurrent edits leave multiple plausible new nodes, return the candidates for inspection.

The ID is opaque to clients. Resolve it against the current editor session, target graph, action family, canonical source object and action variant. Recheck the context on the editor game thread immediately before invoking. Use the action's actual registration owner when filtering. Reject stale, ambiguous, incompatible and read-only targets before opening a transaction. A graph revision alone cannot detect every source asset change. Re-resolve the asset, check compatibility, and reject an expired selection after rename, replacement or editor restart. A stale response should give the arguments needed to rediscover.

Use the existing editor transaction and graph revision helpers. Verify that the returned node belongs to the target graph's node list, references the exact selected asset and exposes the family's expected pins. Record any unexpected changes if verification fails after invocation, including whether Undo can restore the previous graph. A cancelled transaction alone is insufficient evidence of rollback. If a reply is lost, refresh graph membership and inspect node GUIDs and asset references before retrying. Multiple Sequence Players can legitimately reference the same clip.

Preserve the existing legacy input writer and two-way-blend callers, including their accepted class-path argument. The new interface initially advertises two qualified action families. Discovery and invocation can be reused later for procedural nodes; bone-chain setup, solver space and runtime motion still need family-specific work.

## First experiment and acceptance

Run the first native experiment in a UEMCP-owned editor using UE 5.8.4, with a pawn Event Graph and a top-level AnimGraph. Use two same-named source assets in different packages. Record the registry owner, contextual filter result, graph membership, bound asset and actual pins before and after invoking each selection. Repeat discovery immediately after creating a new source asset, then after renaming it. For Sequence Players include an incompatible Skeleton and distinguish the empty-player entry. This checks the native design premise before committing to an ID format or a particular registry lookup.

| Real CLI request | Independent acceptance |
| --- | --- |
| “While I hold Interact, set this pawn's Interacting flag. Clear it when I release.” | Start with an owned, possessed pawn and activated mapping context. Document that fixture setup. The agent places the event for the exact action and wires the relevant trigger outputs. Drive the mapped key through press and release in PIE and sample the pawn flag before, during and after. Exercise cancellation for a trigger configured to cancel. A different key/action leaves the flag unchanged. |
| “Use the Walk clip from this folder as the character's output. Keep the old player available.” | The agent places a Sequence Player for the named clip and explicitly rewires the occupied output. Read the asset reference and reciprocal pins independently. Compare evaluated bone motion against the two distinguishable source clips and confirm the old player remains. |

For both, verify placement Undo/Redo and named save followed by fresh-editor readback and replay. Exercise a stale selection without creating a duplicate. Record the plain-language prompts, discovery calls, retries, time to completion, editor version and unintended changes. Use the retained legacy/generic event result as the negative control. Report 5.3.2 and 5.6.1 separately when exercised. Observed human sessions come after agent-driven acceptance.

The first implementation decision follows the native probe: if both families can be resolved and placed from the same context, implement the shared resolver and the two readback checks. If either family needs a different registration path, keep the same client contract and document the engine-specific lookup demonstrated by the probe.
