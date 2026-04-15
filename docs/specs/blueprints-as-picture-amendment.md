# Blueprints-as-Picture — Amendment to Blueprint Introspection

> **Parent spec**: [blueprint-introspection.md](./blueprint-introspection.md). This document amends it; it does not replace it.
> **Driver**: Noah, 2026-04-15 — "I want to look at a Blueprint and traverse it like we are looking at a picture of it without taking screenshots."
> **Status**: Design draft. Implementation lands in Phase 3 (custom plugin). Nothing here blocks Track 2a.
> **Relationship to existing spec**: The parent spec defines the **dump format** (full BP → JSON, NodeToCode-style). This amendment adds the **spatial layer** (positions, comment-box grouping, knot/reroute) and the **traversal surface** (verb-driven walks of the graph as if reading a picture).

---

## Why this amendment exists

The parent spec optimizes for "give Claude the whole BP as a token-efficient JSON dump." That solves *comprehension at the asset level* — list nodes, list pins, list flows. It explicitly punts spatial layout to Tier 4 screenshots and frames text vs. visual as alternatives ("text first, visual second").

Noah's ask flips that: read the picture *as text*, no screenshots, but with the picture's structure preserved enough to traverse the way a human reads a graph — start at an event, follow the white exec wire forward, peek at the data wires feeding each node, see what's grouped under the yellow "Damage Handling" comment, jump 2 hops out from a specific node.

That requires two things the parent spec does not provide:

1. **Spatial fields** on every node — `pos`, `size`, `comment_id`, plus first-class handling of comment-box nodes and knot/reroute nodes (which are *only* meaningful spatially).
2. **Traversal verbs** — read-only tools that walk the graph by relationship, not by index. "Trace from this entry point." "Show me the subgraph inside this comment." "What feeds this pin?" "Path from node A to node B."

The dump format and the traversal verbs are complementary: the dump is what gets cached; the verbs are how Claude consumes it incrementally without reading the whole dump every time.

---

## Schema additions to the dump format

Three additions to the per-node JSON in [parent §UEMCP Blueprint Serialization Format](./blueprint-introspection.md):

```jsonc
{
  "id": "N1",
  "type": "event",
  "name": "ReceiveBeginPlay",
  // ... existing fields per parent spec ...

  // NEW — spatial:
  "pos": [320, 80],                    // [NodePosX, NodePosY] from UEdGraphNode
  "size": [240, 96],                   // [NodeWidth, NodeHeight] — present for resizable nodes only (most K2Nodes omit)
  "comment_id": "C2",                  // ID of the enclosing comment box, if any. Computed by point-in-rect at parse time.
  "enabled": "DevelopmentOnly"         // EnabledState — omit if "Enabled" (default)
}
```

One new top-level section, parallel to `nodes` / `flows`:

```jsonc
"comments": [
  {
    "id": "C1",
    "text": "Damage Handling",
    "pos": [200, 0],
    "size": [800, 600],
    "color": [1.0, 0.85, 0.0, 0.25],   // RGBA — useful for distinguishing comment boxes when a graph has many
    "contains": ["N3", "N4", "N5"]      // Pre-computed point-in-rect; populated at parse time so traversal doesn't re-walk geometry
  }
]
```

**Knot / reroute nodes** keep the standard node shape but get a distinct `type: "knot"` and only one input pin + one output pin of the same type. They're spatial-only — the dump format keeps them as nodes (so positions remain faithful) but traversal verbs collapse them by default (an option re-exposes them).

**Position units**: UE editor pixel coordinates as stored in `UEdGraphNode::NodePosX` / `NodePosY`. No normalization, no transform. A reader can render the layout 1:1 if they want, but the canonical use is relative comparison ("N3 is to the right of N1, which means it executes after").

**Comment containment is pre-computed.** Parsing once and storing `contains[]` per comment costs nothing at write time and removes O(N×M) point-in-rect work from every traversal call.

---

## Traversal verb surface

These are new tools, separate from the existing `get_blueprint_graph` / `get_blueprint_summary` / `get_blueprint_variables` / `get_blueprint_components` family in the parent spec. They are **read-only** and operate on the cached dump (see §Cache model).

| Tool | Inputs | Returns |
|------|--------|---------|
| `bp_list_graphs` | `bp_path` | Per-graph: `{name, type, entry_node_ids, node_count}`. Cheap orientation tool — answers "what graphs does this BP have, and where do I start." |
| `bp_list_entry_points` | `bp_path`, `graph_name` | Nodes with no exec-in pins: `Event*`, `Function Entry`, `Custom Event`, `Macro Input`. Each entry includes `pos` and `comment_id` so Claude can pick a starting point spatially. |
| `bp_trace_exec` | `bp_path`, `graph_name`, `start_node_id`, `max_depth?` (default 20), `collapse_knots?` (default true) | Forward execution walk from a node. Returns a tree (not a flat list) preserving branch/sequence/multi-output topology. Each node entry includes `pos`, `comment_id`, immediate data inputs (one hop back), and exec-out children. Cycles broken with `cycle_to: "<id>"` markers. |
| `bp_trace_data` | `bp_path`, `graph_name`, `pin_id`, `direction`, `max_depth?` | Walk data wires from a pin. `direction: "back"` shows what feeds the pin; `direction: "forward"` shows what consumes its value. Returns a tree. |
| `bp_show_node` | `bp_path`, `graph_name`, `node_id` | One node, full detail: position, comment containment, all pins (with `linked_to` resolved to `{node_id, pin_id, node_name}` triples), default values, comment text, `enabled` state. |
| `bp_neighbors` | `bp_path`, `graph_name`, `node_id`, `radius?` (default 1), `edge_types?` (`["exec", "data"]`) | All nodes within `radius` hops along the chosen edge types. Returns flat node list + edges, suitable for "what's near this." |
| `bp_subgraph_in_comment` | `bp_path`, `graph_name`, `comment_id` | All nodes inside a comment box, plus the exec/data flows entirely contained within it (cross-boundary edges flagged). The "show me what 'Damage Handling' actually does" verb. |
| `bp_paths_between` | `bp_path`, `graph_name`, `from_node_id`, `to_node_id`, `edge_types?`, `max_paths?` (default 5) | All distinct exec or data paths from one node to another. Useful for "is X reachable from Y" and "how does this value get used over there." |
| `bp_find_in_graph` | `bp_path`, `graph_name`, `predicate` | Filter nodes by predicate: `{type: "call_function", member_name: "ApplyGameplayEffectToTarget"}` etc. The grep-equivalent scoped to one graph. |

Verbs are deliberately small and composable. Expensive operations (`bp_trace_exec` over a 200-node graph, `bp_paths_between` with no max) are bounded by required `max_depth` / `max_paths` parameters with sensible defaults rather than left unbounded.

**Why verbs and not "just read the dump":** a 200-node BP graph dumps to 8-15K tokens. Loading the whole dump for every question wastes context. Verbs let Claude pull only the slice it needs — start at the entry, follow exec for 5 hops, peek at data on one node — using a tiny fraction of the tokens. The full dump remains available via the parent spec's `get_blueprint_graph` when Claude actually needs everything.

---

## Cache model — sidecars + D33 freshness

Editor-mediated extraction (writing this data accurately requires UProperty deserialization at a depth our offline parser does not attempt) but offline-tool ergonomics (we want `bp_show_node` to feel as fast as `Read`).

The reconciliation is sidecar JSON files written by an editor Save hook:

- **Format**: `BP_OSPlayer.bp.json` next to `BP_OSPlayer.uasset`. JSON exactly matches the dump schema in [parent spec](./blueprint-introspection.md) plus the spatial additions in this amendment.
- **Generation**: Phase 3 plugin registers a `FCoreUObjectDelegates::OnObjectSaved` hook (or equivalent post-save delegate) for `UBlueprint` assets. On save, serialize and write the sidecar. Cost: ~10ms per BP, hidden inside the editor Save flow.
- **Freshness**: D33 model. `assetCache` keys sidecar by `.uasset` mtime+size; `shouldRescan()` invalidates when the source moves. Stale sidecars trigger a TCP `dump_graph` call that re-emits the sidecar on the spot, unblocking the read.
- **Repo policy**: sidecars are caches, not source. Add `*.bp.json` to `.gitignore` (and `.p4ignore` on the UE-project side). The cache rebuilds the first time anyone opens an unsaved BP. We do not require team-wide sidecar coverage to ship.
- **Bulk priming**: a one-time `prime_bp_cache` editor command iterates all BPs and writes sidecars. Useful after a fresh checkout or after a UE upgrade invalidates the format. Not a per-asset-load cost.
- **Schema version**: every sidecar carries `"version": "1.x.y"`. Reader rejects mismatched majors and falls back to TCP. Future schema migrations don't strand caches.

The sidecar approach gives offline-tool latency (bp tools never wait for an editor round-trip when the editor isn't running and the BP hasn't changed) without the full-UProperty parser cost (we don't try to compete with the editor's serializer).

**Fallback path when no sidecar exists and no editor is running**: tools return `{available: false, reason: "no_sidecar_and_editor_offline", hint: "open the BP in editor once to prime"}`. Clear failure beats fabricated data.

---

## Phase 3 plugin requirements

This amendment adds three discrete requirements to `docs/specs/phase3-plugin-design-inputs.md`. They belong in a new bucket — call it **3F: Blueprint Introspection** — distinct from 3C (blueprint write commands).

**3F-1: `dump_graph` TCP command.** Inputs: `bp_path`, `graph_name?` (default: all graphs). Output: full JSON per amended schema (parent §UEMCP Blueprint Serialization Format + spatial additions in this amendment + comments[] section). Walks the editor's already-deserialized `UEdGraph` for the named graphs; for each `UEdGraphNode` emit base fields + `pos`/`size`/`comment_id`/`enabled`; for each `UEdGraphNode_Comment` emit a `comments[]` entry with pre-computed `contains[]`. Errors: BP not found, BP fails to load, named graph not found.

**3F-2: Save-hook sidecar writer.** Plugin registers a delegate fired on `UBlueprint` save. Delegate calls the same serializer as 3F-1 and writes `<bp_name>.bp.json` next to the asset. Errors during sidecar write must not block the actual asset save — log and move on. Optional plugin setting to disable the hook for users who don't want sidecar generation.

**3F-3: `prime_bp_cache` editor command.** One-shot iteration over all `UBlueprint` assets in `Content/`. Writes sidecars for each. Reports progress every 10% or 100 BPs (whichever larger). Idempotent — skips BPs whose sidecar mtime is newer than the asset mtime.

These three plus the read-side verbs in the §Traversal verb surface are the full Phase 3 deliverable for "Blueprints as picture."

---

## What this means for current work

- **Track 2a (Agent 3, in flight)**: unchanged. Class-level introspection (`query_asset_registry`, `inspect_blueprint`, `list_level_actors`) remains the right offline ambition. None of those need spatial data.
- **Phase 3 plugin scope**: grows by one bucket (3F, three commands). Updates to `docs/specs/phase3-plugin-design-inputs.md` follow this amendment landing.
- **No conflict with parent spec**: the parent spec's `get_blueprint_graph` family stays. This amendment adds fields to its output and adds parallel traversal verbs. The verbs *consume* the cached dump; they don't replace the dump.
- **No code in this amendment**: this is design only. Implementation is sequenced for Phase 3.

---

## Open questions for resolution before Phase 3 build

1. **Sidecar location** — next to the `.uasset` (default in this draft) or in a parallel `Saved/UEMCP/BPCache/` mirror tree? Next-to-asset is simplest for tooling but pollutes Content/ visually in the Content Browser. Parallel-mirror is cleaner but adds path translation logic.
2. **Knot collapse semantics** — when `collapse_knots: true`, do we want the wire to report the original knot path (so positional comparison still works) or the collapsed direct edge only? Default to collapsed-only with a `via_knots: ["N17", "N23"]` annotation.
3. **AnimBP state machines** — parent spec already covers AnimGraph nodes, but state machines are intrinsically spatial. Do they need their own traversal verbs (`anim_trace_transitions`) or do `bp_trace_exec` and friends adapt? Defer to Phase 3 design pass.
4. **Material graphs** — same question, same defer. Material expressions have positions and benefit from spatial traversal, but they're a different node hierarchy entirely.
5. **CDO defaults** — out of scope for this amendment. Reading the *current values* of a BP's variables (vs the variable definitions) needs Remote Control API (Phase 4) or a TCP CDO-read command. Tracked separately.
