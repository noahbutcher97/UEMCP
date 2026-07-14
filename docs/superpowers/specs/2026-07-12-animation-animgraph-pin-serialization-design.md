# Animation AnimGraph Pin Serialization Design

## Goal

Extend the shipped `animation.get_anim_graph` live read so it can optionally return full editor-side AnimBlueprint visual graph wiring: every relevant `UEdGraphNode`, every serialized `UEdGraphPin`, and every `UEdGraphPin::LinkedTo` connection that the editor exposes for those graphs.

The immediate use case is agent-readable AnimBP diagnosis. The agent should be able to answer questions like:

- Which AnimGraph node feeds this slot, blend, state machine, or output pose?
- What pins are connected between these visual nodes?
- What state, transition rule, or nested graph contains the edge?
- Which node and pin identifiers should a later write or manual handoff reference?

This slice is read-only. It improves observability and planning; it does not author or mutate AnimGraph nodes.

## Current State

`get_anim_graph` already exists as a live TCP read over `tcp-55558`. It loads a `UAnimBlueprint`, calls `GetAllGraphs`, and returns graph summaries plus semantic buckets:

- `graphs`
- `state_machines`
- `states` under state machines
- `transitions` under state machines
- `slot_nodes`
- `layered_blend_nodes`
- `unsupported_runtime_fields`

The current response is useful for counts and major topology, but it does not expose full pin-level wiring. `include_node_properties` currently returns node summaries, not a complete pin map.

The repo already has graph-edge conventions elsewhere:

- `BlueprintHandlers.cpp` serializes Blueprint pins and selected pin links for `show_pin_links`, `disconnect_pin`, and delete-node previews.
- `GraphTraversalHandlers.cpp` serializes material graph nodes with `pins[]` and `linked_to[]`.
- `EdgeOnlyBPSerializer.cpp` and the S-B offline parser use the Oracle-A-v2 shape: `graphs -> nodes -> pins -> linked_to`.
- `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/README.md` documents the edge-only oracle and edge cases.

The new AnimGraph shape must align with those contracts instead of inventing a separate graph model.

## Design Decision

Add opt-in full pin topology to the existing `get_anim_graph` tool.

Do not add a new public tool unless implementation discovers that payload size, caching, or compatibility makes that unavoidable. The existing tool is already discoverable for AnimGraph readback, has a live-read requirement classification, and already loads the correct asset instance.

### Public Parameters

Add these optional params to `get_anim_graph`:

- `include_pin_topology`: boolean, default `false`.
- `include_pin_defaults`: boolean, default `false`.

Keep the existing params:

- `asset_path`: required string.
- `include_transitions`: boolean, default remains plugin-side `true`.
- `include_node_properties`: boolean, default remains `false`.

`include_pin_topology` controls the heavy graph wiring payload. Existing callers that omit it get the current lightweight response.

`include_pin_defaults` is valid only when `include_pin_topology` is true. It includes safe string/object/text default fields already available on `UEdGraphPin`. It must not attempt deep property or struct decoding in this slice.

### Response Shape

When `include_pin_topology` is true, add a sibling object:

```json
{
  "pin_topology": {
    "schema_version": "anim-uedgraph-pin-topology-v1",
    "id_format": "digits",
    "complete": true,
    "truncated": false,
    "graph_count": 3,
    "node_count": 42,
    "pin_count": 180,
    "link_entry_count": 182,
    "edge_count": 91,
    "graphs": {
      "AnimGraph": {
        "graph_key": "AnimGraph",
        "graph_guid": "<graph_guid>",
        "name": "AnimGraph",
        "path": "/Game/Characters/ABP_Example.ABP_Example:AnimGraph",
        "graph_type": "anim_graph",
        "class_name": "AnimationGraph",
        "schema_class": "AnimationGraphSchema",
        "sources": ["get_all_graphs"],
        "nodes": {
          "<node_guid>": {
            "graph_key": "AnimGraph",
            "node_guid": "<node_guid>",
            "class_name": "AnimGraphNode_Slot",
            "title": "DefaultSlot",
            "x": 120,
            "y": 300,
            "pins": {
              "<pin_id>": {
                "pin_id": "<pin_id>",
                "name": "Pose",
                "direction": "EGPD_Output",
                "pin_category": "pose",
                "pin_subcategory": "",
                "pin_type": {
                  "category": "pose",
                  "subcategory": "",
                  "container": "None"
                },
                "linked_to": [
                  {
                    "graph_key": "AnimGraph",
                    "node_guid": "<target_node_guid>",
                    "pin_id": "<target_pin_id>"
                  }
                ],
                "is_subpin": false,
                "parent_pin_id": null,
                "subpin_ids": []
              }
            }
          }
        }
      }
    },
    "dropped": {
      "null_nodes": 0,
      "null_pins": 0,
      "null_linked_pins": 0,
      "dangling_links": 0,
      "orphaned_pins": 0,
      "duplicate_graph_keys": 0,
      "duplicate_node_guids": 0,
      "duplicate_pin_ids": 0
    }
  }
}
```

Shape rules:

- `pin_topology.graphs` is an object keyed by collision-safe graph key, matching the existing Oracle-style graph map.
- Graph key must not be raw graph name alone unless uniqueness has been proven for the response. Prefer a path-like key derived from `UEdGraph::GetPathName()` or a deterministic parent-chain key. Preserve display name separately in `name`.
- Graph entries include `graph_key`, `graph_guid`, `name`, `path`, `class_name`, `schema_class`, `graph_type`, and `sources[]`.
- `graph_guid` is serialized when `UEdGraph::GraphGuid` is valid; otherwise emit `null`. It is metadata, not the map key. Use `graph_key` for map identity because path/context is still needed for collision handling and external references.
- `nodes` is an object keyed by `UEdGraphNode::NodeGuid` within its graph scope. Node GUIDs are not treated as globally unique across the whole AnimBlueprint.
- Node entries include their owning `graph_key` so a node object remains self-contained when copied out of the graph map.
- `pins` is an object keyed by `UEdGraphPin::PinId`.
- `linked_to[]` entries use target `graph_key`, target `node_guid`, and target `pin_id`.
- Pin directions use Unreal enum strings: `EGPD_Input`, `EGPD_Output`, or `EGPD_Unknown`.
- Node GUIDs and pin IDs must use one explicit format consistently across the topology object. Prefer `EGuidFormats::Digits` for Oracle parity unless implementation proves hyphenated IDs are needed for compatibility with existing `get_anim_graph` summaries. If the implementation keeps summary IDs hyphenated, topology IDs still need a clear `id_format` field.
- `id_format` is required and applies to node GUIDs, pin IDs, and linked-to targets inside `pin_topology`.
- Serialize top-level pins and recursive `SubPins` into the same `pins` map. Subpins include `is_subpin: true`, `parent_pin_id`, and an empty or populated `subpin_ids` array.
- Parent pins include `subpin_ids[]` when split pins are present.
- Every emitted `parent_pin_id` and `subpin_ids[]` entry resolves within the owning node. Unresolvable hierarchy references are omitted, counted, and force `complete: false`.
- `link_entry_count` counts every serialized `linked_to[]` entry. `edge_count` counts unique visual connections after canonicalizing reciprocal pin links. The per-pin `linked_to[]` arrays remain authoritative.
- `complete` and `truncated` are required. The implementation must not silently truncate. If a defensive cap is introduced during implementation, the response must either fail with a structured error or set `complete: false`, `truncated: true`, and include omitted counts.
- Canonical loss counters include null or mismatched pin ownership and unresolved parent/subpin relationships in addition to null nodes/pins and dangling links. Documented compatibility aliases must equal their canonical counters.
- The canonical loss-counter fields are `null_graph_count`, `null_referenced_graph_count`, `null_node_count`, `null_node_graph_count`, `mismatched_node_graph_count`, `null_pin_count`, `null_pin_owner_count`, `mismatched_pin_owner_count`, `dangling_parent_pin_count`, `dangling_subpin_count`, `null_linked_pin_count`, `null_linked_owner_count`, `dangling_link_count`, `duplicate_node_key_count`, `duplicate_pin_key_count`, `invalid_node_guid_count`, and `invalid_pin_guid_count`. Any nonzero canonical loss counter requires `complete: false`.
- `orphan_pin_count` and `duplicate_graph_key_count` are diagnostics rather than serialization losses: orphan pins are still serialized, and graph-key collisions are resolved with globally reserved deterministic suffixes.
- The topology object includes graph metadata, node title, node class, and node position because these are part of visual graph serialization.
- The topology object must not duplicate the entire existing semantic arrays unless needed for usability. Semantic arrays remain as current siblings.

### Graph Coverage

Use `UAnimBlueprint::GetAllGraphs` as the primary graph collection source because the existing implementation already uses it and UE 5.6 source verifies that `UBlueprint::GetAllGraphs` adds Blueprint-owned graphs plus child graphs. Specifically, UE 5.6 adds function graphs, macro graphs, ubergraph pages, delegate signature graphs, implemented interface graphs, and extension graphs, and calls `UEdGraph::GetAllChildrenGraphs` for each graph source.

The implementation must verify that the resulting serialized set covers:

- root AnimGraph
- state machine graphs
- state bound graphs
- transition rule graphs
- custom transition graphs where present
- function/event-style graphs owned by the AnimBlueprint

If a graph is present in a state or transition object but absent from `GetAllGraphs`, the implementation must add it explicitly and record the source as `referenced_graph`. It must not silently omit referenced bound graphs.

Graph collection must be cycle-safe and duplicate-safe:

- Use a visited set keyed by graph path or object identity before serialization.
- Preserve all collection sources on a graph via `sources[]`; do not overwrite the first source when the same graph is reached from multiple paths.
- Treat `GetAllGraphs` output as a seed that may already contain `UEdGraph::SubGraphs`. Do not double-count child graphs if both the parent recursion and the seed output reach them.
- If an explicit fallback recursion over `UEdGraph::SubGraphs` is still used, it must share the same visited set as the seed graph walk.
- If two graph objects would produce the same graph key, emit a deterministic suffix and increment `duplicate_graph_keys`; do not overwrite an existing graph entry.
- This slice serializes graphs owned by the requested AnimBlueprint asset. Inherited parent AnimBlueprint graphs, linked anim layer assets, Control Rig graphs, and external assets referenced by nodes are follow-ons unless Unreal exposes the `UEdGraph` object as part of the requested asset's graph set.

### Edge Direction And Deduplication

Serialize `LinkedTo` as Unreal exposes it on every pin. Do not collapse it into a single directed edge list as the primary contract.

Rationale:

- Unreal stores links on pins.
- Existing repo oracles and offline topology use `linked_to[]` on pins.
- Keeping per-pin links preserves self-loops and unusual graph state without inventing semantics.

`LinkedTo` can be reciprocal: both connected pins may list each other. The response must make this explicit:

- `link_entry_count` is the raw total across every serialized `linked_to[]` array.
- `edge_count` is a derived unique visual connection count.
- A unique edge key must include both endpoint graph keys, node GUIDs, and pin IDs, canonicalized so reciprocal entries collapse to one edge.
- Self-loops remain valid and count as one unique edge.
- If one side of a connection exists without a reciprocal link, serialize what Unreal exposes and count one unique edge.

Do not add a derived `edges[]` convenience array unless implementation can do so without ambiguity. If added, it must be explicitly derived and non-authoritative. The authoritative source remains `pins[pin_id].linked_to[]`.

### Compatibility

Existing response fields must remain stable when `include_pin_topology` is omitted:

- no renamed fields;
- no changed default params;
- no different `isReadOp`;
- no new mutation, save, compile, or PIE requirement.

If `include_node_properties` and `include_pin_topology` are both true, `graphs[].nodes` may remain the current summary array while `pin_topology.graphs[*].nodes` carries the map-form detailed topology. Do not overload the existing `graphs[].nodes` array with a second incompatible shape.

## Implementation Requirements

### Requirement 1: Typed Public Contract

Update `tools.yaml` and `server/menhance-tcp-tools.mjs` so `get_anim_graph` exposes `include_pin_topology` and `include_pin_defaults`.

Expected metadata:

- `status: shipped`
- `availability_layer: tcp-55558`
- `transport_layer: tcp-55558`
- `requires_editor: true`
- `requires_pie: false`
- `mutates_asset: false`
- `mutates_level: false`
- `saves_asset: false`
- `compiles_asset: false`
- `offline_fallback` must mention existing offline graph tools as partial, not equivalent.

Also update generated/discovery text that names animation readback, including `server/create-uemcp-server.mjs`, so users discover pin topology through `get_anim_graph` instead of guessing at raw TCP, Python, or sidecar routes.

Validation behavior:

- Unknown params must follow the existing tool schema policy; do not add broad aliases or a global strict-unknown change in this slice.
- Current Node validation uses `z.object(def.schema).parse(args)`, which strips unknown params by default. The implementation must not accidentally represent that behavior as strict rejection in docs or tests.
- `include_pin_defaults: true` with `include_pin_topology: false` must fail validation or return a clear structured error. Because the current schema table is field-only and cannot express cross-field refinement by itself, implement this as a tool-specific preflight after parse or by extending the Menhance schema executor to support custom refinements.
- The dependency error must not silently imply topology, and it must not produce defaults in the lightweight response.
- The Node wrapper must forward both new params exactly and preserve existing params.

### Requirement 2: Shared Editor Graph Serializer

Create or extract a local C++ helper for serializing `UEdGraph` node/pin topology. The helper can live in `AnimationHandlers.cpp` for this implementation if kept small, but the implementation plan must explicitly decide whether to keep it local or move it to a private shared helper because Blueprint, material graph, and AnimGraph code already repeat this pattern.

Minimum helper responsibilities:

- serialize collision-safe graph identity, path, class, type, sources, and visited status;
- serialize node identity, class, title, visual position, owning graph key, and duplicate-GUID diagnostics;
- serialize pin ID, name, direction, category, subcategory, type summary, link count, orphan flag, subpin metadata, and duplicate-pin diagnostics;
- serialize recursive `SubPins` into the same pin map with parent/child relationships preserved;
- serialize `linked_to[]` by resolving linked pin owner graph key, owner node GUID, and linked pin ID;
- use null-safe owner lookup before reading owner graph or node GUID; do not depend on unchecked owner access unless a preceding check proves it safe;
- count null nodes, null pins, null linked pins, dangling links, orphaned pins, duplicate graph keys, duplicate node GUIDs, and duplicate pin IDs;
- compute both `link_entry_count` and `edge_count`;
- include default string/object/text fields when `include_pin_defaults` is true.

Do not reuse the existing `BlueprintHandlers.cpp` helper directly unless it is first moved to a neutral private helper without introducing Blueprint write dependencies into animation reads.

Default value rules:

- Include only serializable editor-safe pin defaults: string default, object path, text value, autogenerated default, and a human-readable display default if available without mutation.
- Do not serialize raw object data, property bags, or resolved asset contents.
- If default strings are capped for payload safety, include a truncation marker and omitted character count. Do not silently cut values.

### Requirement 3: AnimGraph Integration

`HandleGetAnimGraph` must build the new topology only when `include_pin_topology` is true.

The response must:

- include every graph walked for the existing `graphs[]` summary;
- include every graph reached from state machine, state, transition rule, and custom transition references;
- include `UEdGraph::SubGraphs` reachable from those graphs;
- keep existing semantic arrays intact;
- include `pin_topology.id_format`;
- include `pin_topology.complete` and `pin_topology.truncated`;
- include `pin_topology.link_entry_count` and `pin_topology.edge_count`;
- include `pin_topology.dropped` counters;
- include `pin_topology.schema_version`;
- include `unsupported_runtime_fields` unchanged.

The implementation must not call `AllocateDefaultPins`, `Modify`, save, compile, or otherwise normalize the asset while reading. It must snapshot existing editor graph objects only.

### Requirement 4: Source-Only Tests

Add tests that fail before implementation and pass after:

- Node schema forwards `include_pin_topology` and `include_pin_defaults`.
- Node schema rejects or clearly errors on `include_pin_defaults` without `include_pin_topology`.
- Node schema tests document the current unknown-param behavior: unknown params are stripped by the existing Menhance Zod wrapper, not rejected.
- Fake TCP response with `pin_topology` round-trips unchanged.
- Fake TCP response includes `graph_key` on linked-to entries and verifies callers can disambiguate graph-scoped node IDs.
- `test-m5-animation.mjs` source guard proves `HandleGetAnimGraph` reads `UEdGraphPin`, `LinkedTo`, `PinId`, `PinName`, `PinType`, `SubPins`, `ParentPin`, and owner node GUID.
- Source guard proves graph entries serialize `GraphGuid` and schema class when available.
- Source guard proves topology generation is gated by `include_pin_topology`.
- Source guard proves no Python execution, no save, no compile, and no PIE dependency.
- Source guard proves no pin allocation or mutation calls are introduced in the topology read path.
- Source guard proves graph traversal uses a visited set and does not double-count `UEdGraph::SubGraphs` already included by `GetAllGraphs`.
- Source guard proves current semantic arrays remain present.

### Requirement 5: Live Smoke Extension

Extend `server/live-smoke-animation-readback.mjs` behind the existing opt-in live smoke path.

The live smoke must call `get_anim_graph` with:

```js
{
  asset_path: process.env.UEMCP_LIVE_ANIM_BLUEPRINT,
  include_transitions: true,
  include_node_properties: true,
  include_pin_topology: true
}
```

It must assert:

- `pin_topology.schema_version` exists;
- `pin_topology.id_format` exists;
- `pin_topology.graphs` is an object;
- at least one graph exists;
- graph entries contain `graph_key`, `graph_guid`, `name`, `path`, `class_name`, `schema_class`, and `sources[]`;
- graph entries contain `nodes`;
- if nodes exist, node entries contain `pins`;
- if pin links exist, each linked-to entry contains `graph_key`, `node_guid`, and `pin_id`;
- `link_entry_count` is a number;
- `edge_count` is a number;
- `truncated === false` for this slice;
- `complete` agrees with the canonical serialization-loss counters. `complete: false` is valid only when at least one emitted loss counter explains it;
- existing `graphs[]`, `state_machines[]`, `slot_nodes[]`, and `layered_blend_nodes[]` remain arrays.

The live smoke must stay skipped unless the live smoke env gates are set. Fake TCP tests and live smoke must use one shared topology validator so schema and invariant checks cannot drift independently.

### Requirement 6: Deployment Visibility

Because this changes plugin C++ behavior, implementation must bump:

- root `manifest.json` version;
- `plugin/UEMCP/UEMCP.uplugin` `Version`;
- `plugin/UEMCP/UEMCP.uplugin` `VersionName`.

Implementation completion must not claim deployed editor freshness from source tests alone. It must run or explicitly defer:

- `verify-deploy.bat`;
- Unreal `Build.bat` for the target project after sync;
- `smoke-live.bat` with `UEMCP_LIVE_SMOKE=1` and `UEMCP_LIVE_ANIM_BLUEPRINT=/Game/...`.

## Research Audit

### Web Research

Official Epic API documentation supports the core data model. These public docs are research evidence for the editor graph model; the implementation gate remains the target Unreal headers and a plugin build against the deployed project engine version.

- `UEdGraphPin` exposes `Direction`, `LinkedTo`, `PinId`, `PinName`, `PinType`, default values, `ParentPin`, and `SubPins`, which are exactly the fields and boundaries this design serializes or counts. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UEdGraphPin>
- `UEdGraphPin::HasAnyConnections` is documented in terms of the `LinkedTo` array and subpins. This supports treating `LinkedTo` as the authoritative edge source while explicitly counting subpin/orphan boundaries. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UEdGraphPin>
- `UEdGraphNode` exposes `NodeGuid`, `NodePosX`, `NodePosY`, `Pins`, and graph accessors. This supports including node GUID, owning graph, and visual position in a visual graph serialization response. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UEdGraphNode>
- `UEdGraph` exposes `Nodes`, `SubGraphs`, `GraphGuid`, and graph schema access. This supports graph-level identity, child graph coverage, and graph schema metadata. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UEdGraph>
- `UBlueprint::GetAllGraphs` returns all graphs in a Blueprint. This supports the existing `get_anim_graph` graph collection strategy, with explicit verification for bound graph references. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UBlueprint>
- `UBlueprintExtension` can contribute graphs through `GetAllGraphs`; UE 5.6 source shows `UBlueprint::GetAllGraphs` includes extension graphs. This matters for completeness and duplicate-safe traversal. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UBlueprintExtension>
- `UAnimBlueprint` is a specialized Blueprint whose graphs control a skeletal mesh animation and derives from `UBlueprint`. This supports extending a Blueprint graph serializer pattern to AnimBlueprint editor graphs. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UAnimBlueprint>
- `UAnimGraphNode_Base` derives through `UEdGraphNode` and is the base class for editor animation graph nodes that generate or consume animation pose. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Editor/AnimGraph/UAnimGraphNode_Base>
- `UAnimGraphNode_StateMachineBase` derives through `UEdGraphNode` and owns an editor state machine graph. This supports walking state machine graph references, not just summary node counts. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Editor/AnimGraph/UAnimGraphNode_StateMachineBase>
- `UAnimationStateMachineGraph` derives from `UEdGraph`, so state-machine contents can be serialized through the same graph/node/pin model. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Editor/AnimGraph/UAnimationStateMachineGraph>
- `UAnimStateNodeBase` derives from `UEdGraphNode` and exposes `GetBoundGraph`; `UAnimStateNode` has a bound animation graph for the state. Sources: <https://dev.epicgames.com/documentation/unreal-engine/API/Editor/AnimGraph/UAnimStateNodeBase>, <https://dev.epicgames.com/documentation/unreal-engine/API/Editor/AnimGraph/UAnimStateNode>
- `UAnimStateTransitionNode` derives from `UAnimStateNodeBase`, exposes a transition rule `BoundGraph`, and exposes `GetCustomTransitionGraph`. This supports explicit traversal of transition rule and custom transition graphs. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Editor/AnimGraph/UAnimStateTransitionNode>
- Epic's state machine docs describe state machines as AnimBlueprint systems with states, transitions, and subgraphs inside the Anim Graph. This supports requiring state and transition bound graphs, not just root AnimGraph nodes. Source: <https://dev.epicgames.com/documentation/unreal-engine/state-machines-in-unreal-engine>
- `FEdGraphUtilities::CloneGraph` documentation explicitly mentions deep copies of graphs including nodes, pins, and their links. This reinforces that nodes, pins, and links are the natural unit of editor graph fidelity. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Editor/UnrealEd/FEdGraphUtilities>

Research conclusion: the recommended design follows the Unreal editor graph model. A per-pin `linked_to[]` topology is more faithful and more discoverable than raw command dispatch, Python probes, or counts-only summaries.

### Engine Header API Audit

This pass verified the installed UE 5.6 headers under `C:/Program Files/Epic Games/UE_5.6/Engine/Source`, which is the implementation authority for the target engine.

- `Runtime/Engine/Classes/EdGraph/EdGraphPin.h` confirms `UEdGraphPin` exposes `PinId`, `PinName`, `Direction`, `PinType`, `DefaultValue`, `AutogeneratedDefaultValue`, `DefaultObject`, `DefaultTextValue`, `LinkedTo`, `SubPins`, `ParentPin`, `bOrphanedPin`, `GetOwningNode`, `GetOwningNodeUnchecked`, `HasAnyConnections`, `SerializeAsOwningNode`, and `SerializePinArray`.
- `Runtime/Engine/Classes/EdGraph/EdGraphNode.h` confirms `UEdGraphNode` exposes `Pins`, `NodePosX`, `NodePosY`, `NodeWidth`, `NodeHeight`, `NodeComment`, `NodeGuid`, `GetAllPins`, `GetGraph`, `GetNodeTitle`, `GetSchema`, and `AllocateDefaultPins`.
- `Runtime/Engine/Classes/EdGraph/EdGraph.h` confirms `UEdGraph` exposes `Schema`, `Nodes`, `SubGraphs`, `GraphGuid`, `GetNodesOfClass`, and `GetAllChildrenGraphs`.
- `Runtime/Engine/Private/EdGraph/EdGraph.cpp` confirms `GraphGuid` is initialized in `PostInitProperties` for non-template graphs and `GetAllChildrenGraphs` recursively walks `SubGraphs`.
- `Runtime/Engine/Classes/Engine/Blueprint.h` and `Runtime/Engine/Private/Blueprint.cpp` confirm `UBlueprint::GetAllGraphs` adds function graphs, macro graphs, ubergraph pages, delegate signature graphs, implemented interface graphs, extension graphs, and each graph's child graphs.
- `Runtime/Engine/Classes/Animation/AnimBlueprint.h` confirms `UAnimBlueprint` derives from `UBlueprint`.
- `Editor/AnimGraph/Public/AnimGraphNode_Base.h` confirms `UAnimGraphNode_Base` derives from `UK2Node`, so normal editor graph node/pin traversal applies to animation graph nodes.
- `Editor/AnimGraph/Public/AnimGraphNode_StateMachineBase.h` confirms state machine nodes expose `EditorStateMachineGraph`.
- `Editor/AnimGraph/Public/AnimStateNode.h`, `AnimStateConduitNode.h`, `AnimStateTransitionNode.h`, and `AnimStateNodeBase.h` confirm state, conduit, and transition nodes expose bound graphs; transition nodes also expose `CustomTransitionGraph`.

Engine header conclusion: the proposed fields and graph-reference walk are available in the target engine. The spec must guard against over-traversal because `GetAllGraphs` already includes child graphs in UE 5.6.

### Repository API Audit

Local source confirms the required APIs already compile in this repo baseline:

- `AnimationHandlers.cpp` includes `Animation/AnimBlueprint.h`, `EdGraph/EdGraph.h`, and `EdGraph/EdGraphNode.h`, loads `UAnimBlueprint`, and calls `GetAllGraphs`.
- `AnimationHandlers.cpp` already depends on `AnimGraph`, `AnimGraphRuntime`, and concrete editor node types for state machines, state nodes, transition nodes, slot nodes, and layered bone blend nodes.
- `BlueprintHandlers.cpp` already serializes `PinId`, `PinName`, direction, pin type summary, defaults, and `LinkedTo`-derived link objects.
- `GraphTraversalHandlers.cpp` already serializes material graph `UEdGraphNode` pins and `linked_to[]`.
- `EdgeOnlyBPSerializer.cpp` walks `UEdGraphNode::Pins` and serializes `Pin->LinkedTo` into Oracle-A-v2 graph maps.
- `server/uasset-parser.mjs` and `offline-tools.mjs` already consume the same `graphs -> nodes -> pins -> linked_to` shape for offline Blueprint edge topology.
- `server/offline-tools.mjs` and `server/test-verb-surface.mjs` explicitly preserve the D70 invariant that node GUIDs are graph-scoped; they do not treat node GUIDs as unique across sibling graphs.
- `server/menhance-tcp-tools.mjs` validates Menhance tool args with `z.object(def.schema).parse(args)`. A live Node probe confirmed this strips unknown params by default, so this slice must not claim strict unknown-param rejection unless the executor policy changes deliberately.
- `server/create-uemcp-server.mjs`, `tools.yaml`, `server/test-tcp-tools.mjs`, and `server/live-smoke-animation-readback.mjs` are all discoverability/dispatch surfaces that currently mention lightweight `get_anim_graph` only.

API audit conclusion: implementation risk is not API availability. The real risks are graph coverage, stable response shape, payload size, and avoiding duplicate helper drift.

### Second-Pass Gap Audit

The first spec pass had the right direction but left several contracts underspecified. This pass closes them before implementation planning:

- **Graph identity:** raw graph names are not enough. Graph keys must be collision-safe, and graph entries must preserve display name and path separately.
- **Link target identity:** target `node_guid` and `pin_id` are insufficient across multiple graphs. Every `linked_to[]` entry must include target `graph_key`.
- **Reciprocal links:** `UEdGraphPin::LinkedTo` can expose both sides of the same visual connection. The response now distinguishes raw `link_entry_count` from derived unique `edge_count`.
- **Subpins:** because the goal is full pin-level topology, recursive `SubPins` are now in scope for v1, with parent/child metadata.
- **Coverage:** graph traversal must include referenced graphs and `UEdGraph::SubGraphs`, with a visited set and no silent overwrites.
- **Completeness:** no silent truncation. The response must explicitly report `complete` and `truncated`.
- **Read purity:** topology readback must not allocate default pins, normalize nodes, compile, save, or call mutation APIs.
- **Discovery:** `tools.yaml`, the Node schema, and generated/discovery text must all advertise the new opt-in topology route.

### Deep Verification Pass

The third pass added source-backed corrections from UE 5.6 headers, UEMCP source, and current Node validation behavior:

- **Graph GUID and schema metadata:** `UEdGraph` exposes `GraphGuid` and `Schema`, so graph entries must carry `graph_guid` and `schema_class` in addition to the collision-safe `graph_key`.
- **GraphGuid is not enough:** use `graph_guid` as metadata only. The map key still needs graph path/context because repo history already treats node GUIDs as graph-scoped and graph identity must survive duplicate names.
- **Child graph duplication:** UE 5.6 `UBlueprint::GetAllGraphs` already calls `GetAllChildrenGraphs`. The implementation must use a visited set and avoid double-counting when adding referenced graphs or fallback subgraph recursion.
- **Extension graphs:** UE 5.6 `UBlueprint::GetAllGraphs` also includes `UBlueprintExtension` graphs. Do not replace it with a hand-built list of only AnimGraph/state-machine graphs.
- **Cross-field validation:** current Menhance validation strips unknown params by default and has a field-only schema table. The `include_pin_defaults` dependency needs targeted preflight/refinement; it is not expressible by adding one more field to the current schema object alone.
- **Graph-scoped node IDs:** existing offline code and tests already document that node GUIDs are scoped by graph. The AnimGraph response must keep that invariant explicit.

### Pre-Implementation Verification Sweep

This sweep was run before implementation planning to test the highest-risk assumptions against installed engine headers and a live project asset.

- **Cross-version header probe:** UE 5.3, UE 5.6, and UE 5.7 installed headers all expose the required graph, node, pin, Blueprint, AnimBlueprint, state-machine, state, and transition APIs checked by this spec: `UEdGraphPin` IDs/types/defaults/links/subpins, `UEdGraphNode` pins/GUID/position/title/graph access, `UEdGraph` nodes/subgraphs/graph GUID/child traversal, `UBlueprint::GetAllGraphs`, `UAnimBlueprint : UBlueprint`, `UAnimGraphNode_StateMachineBase::EditorStateMachineGraph`, state bound graphs, and transition bound/custom graphs.
- **Live asset shape probe:** a framed `tcp-55558` call through the repo Node dispatch layer successfully read `/Game/Actors/Character/ABP_DroppedCharacter` in an open UE 5.6 project editor. The current response, before pin topology, reported 78 graphs, 440 graph nodes, 8 state machines, 26 states, 35 transitions, 1 slot node, 3 layered blend nodes, and 3 unsupported runtime fields.
- **Baseline payload size:** the current `get_anim_graph` response for that asset with `include_transitions: true` and `include_node_properties: true` serialized to 141,032 UTF-8 JSON bytes before any pin topology is added. This supports keeping `include_pin_topology` default false, but it does not justify a new tool or filters before measuring the actual C++ topology payload.
- **Python boundary:** gated `run_python_command` can load the same AnimBlueprint and exposes `get_animation_graphs`, but it is not a reliable topology source. It returned 68 animation graphs and 151 sampled `AnimGraphNode_Base` nodes, while the C++ live tool saw 78 graphs and 440 total nodes. Unreal Python also blocked `AnimationGraph.nodes` as protected and did not expose pins on sampled nodes. Implementation planning should not route full topology through Python or use Python for authoritative payload sizing.
- **Implementation planning consequence:** the implementation plan must add C++-side live-smoke measurement of `pin_topology.pin_count`, `link_entry_count`, `edge_count`, dropped counters, and total response byte size for `/Game/Actors/Character/ABP_DroppedCharacter`. Treat payload filters such as `graph_filter` or `max_nodes` as follow-ons unless this measured topology payload proves they are needed.

### Discoverability And Usability Audit

The most usable public surface is an opt-in expansion of `get_anim_graph`, not a separate raw graph or Python dispatch tool:

- Agents and users already discover AnimBlueprint topology through `animation.get_anim_graph`; adding `include_pin_topology` keeps the command where users expect it.
- Existing defaults remain lightweight and backward-compatible, so broad tool discovery does not become noisier for users who only need counts or semantic buckets.
- Reusing `graphs -> nodes -> pins -> linked_to` matches the repo's Oracle-A-v2 and offline topology conventions, reducing the number of graph shapes agents must learn.
- Keeping `linked_to[]` on each pin mirrors the Unreal API and preserves exact visual wiring without forcing callers into a lossy derived edge model.
- Emitting `schema_version`, counts, and dropped/dangling/orphan counters makes the result self-describing and audit-friendly.
- Keeping derived `edges[]`, filters, offline parity, and authoring out of this slice keeps the first public addition focused on high-confidence readback.

## Adversarial Audit

### Finding 1: `GetAllGraphs` might not include every bound graph relevant to AnimGraph semantics.

Severity: High.

Mitigation: Cross-check against graph references already reached by state machines, states, transitions, custom transitions, and `UEdGraph::SubGraphs`. Add source tests requiring traversal from those objects. If implementation finds missing bound graphs, append them to the topology graph set with a `sources[]` marker.

### Finding 2: The topology payload could become too large for MCP/stdout use.

Severity: Medium.

Mitigation: Keep `include_pin_topology` default false. Add response counts plus `complete` and `truncated`. No silent truncation is allowed. The current live-project baseline is 141,032 bytes before pin topology for 78 graphs and 440 nodes, so implementation must measure the actual C++ topology payload before adding filters or splitting the tool. Consider `graph_filter` or `max_nodes` as a follow-on only if real assets exceed practical payload limits.

### Finding 3: Two node shapes could confuse callers.

Severity: Medium.

Mitigation: Keep existing `graphs[].nodes` as the lightweight summary array. Put detailed topology only under `pin_topology.graphs[*].nodes`.

### Finding 4: GUID format drift can break cross-tool references.

Severity: Medium.

Mitigation: Pick one explicit topology ID format, document it in `schema_version`, and test it. Prefer Oracle parity (`Digits`) unless existing live tools require hyphenated IDs. Do not mix formats inside `pin_topology`.

### Finding 5: Subpins and orphaned pins could create false confidence.

Severity: Medium.

Mitigation: Serialize recursive `SubPins` into the pin map and include parent/child metadata. Count orphaned pins and null linked pins separately. Do not claim rendering-layout fidelity for split pins unless a later visual capture slice proves it.

### Finding 6: It could drift into AnimGraph authoring.

Severity: High.

Mitigation: Keep this spec read-only. Write operations, compatibility-gated connection creation, and asset mutation are follow-ons.

### Finding 7: Offline parser work could distract from the live API fix.

Severity: Medium.

Mitigation: Do not expand `uasset-parser.mjs` in this slice. Use existing offline shape as contract inspiration only.

### Finding 8: Static tests can overclaim live behavior.

Severity: Medium.

Mitigation: Static tests prove wiring and source contract only. Live smoke and deploy verification remain required for plugin C++ proof.

### Finding 9: Graph-name collisions could silently overwrite topology.

Severity: High.

Mitigation: Use collision-safe graph keys and deterministic suffixing when needed. Emit `duplicate_graph_keys` diagnostics. Never use display name alone as an object-map key unless the response proves uniqueness.

### Finding 10: Cross-graph links could become ambiguous.

Severity: Medium.

Mitigation: Include `graph_key` in every `linked_to[]` entry. If a linked pin's owner graph cannot be resolved into the serialized graph set, count it as a dangling link rather than emitting an ambiguous partial edge.

### Finding 11: Readback code could accidentally mutate or normalize the asset.

Severity: High.

Mitigation: Ban `Modify`, `AllocateDefaultPins`, compile, save, schema connection, and pin-breaking/linking calls in the topology read path. Source tests must check for these calls around the implementation.

### Finding 12: Public docs may be newer than the target engine headers.

Severity: Medium.

Mitigation: Treat Epic web docs as model evidence only. The implementation gate is compilation against the target Unreal version used by deployed projects, followed by live smoke.

### Finding 13: `GetAllGraphs` plus manual subgraph recursion could double-count child graphs.

Severity: High.

Mitigation: Treat `GetAllGraphs` as the primary seed because UE 5.6 source shows it already calls `GetAllChildrenGraphs`. Any referenced-graph or subgraph fallback must share the visited set and update `sources[]` on existing entries instead of appending duplicates.

### Finding 14: `GraphGuid` could be mistaken for the complete graph identity.

Severity: Medium.

Mitigation: Serialize `graph_guid` for diagnostics and cross-reference support, but keep `graph_key` as the map key and include graph path/context. Do not use raw display name or `GraphGuid` alone as the public identity.

### Finding 15: Current Node validation cannot express cross-field dependency in the field-only schema table.

Severity: Medium.

Mitigation: Implement `include_pin_defaults` dependency through tool-specific preflight after parse or extend the Menhance schema executor deliberately. Tests must reflect current unknown-param stripping rather than inventing strict rejection.

## Follow-On Boundaries

These are intentionally not part of this slice:

- AnimGraph node authoring or rewiring.
- Schema-compatible `connect_anim_graph_nodes`.
- Offline `.uasset` parser parity for AnimGraph pin topology.
- Sidecar generation or commandlet generation for AnimGraph topology.
- Generic headless MCP execution. This slice may be designed so its C++ serializer can be reused by a future commandlet, but it must not introduce a one-shot `UEMCPCommandlet`, `headless_capable` routing metadata, long-lived headless service, or generic command dispatcher.
- Inherited parent AnimBlueprint graph traversal and external linked anim layer asset traversal, unless those graphs are owned by the requested asset and exposed through its graph set.
- Control Rig, StateTree, Sequencer, linked asset, or external graph serialization from nodes referenced by the AnimBlueprint.
- Special rendering metadata for split pins beyond ID, parent, and child relationships.
- Payload filtering such as `graph_filter`, `node_class_filter`, or `max_nodes`.
- Derived convenience `edges[]` if the primary per-pin contract is enough.
- Runtime pose, evaluated state, blend weights, active state, or PIE instance data.
- Visual screenshot/canvas capture of the graph editor.
- Detailed node property decoding beyond existing semantic buckets and safe pin metadata.

### Generic Headless MCP Follow-On

The right follow-on is a separate generic headless MCP execution layer with parity expectations comparable to the existing offline, TCP, and Remote Control layers.

That follow-on should start from the already-recorded D175 direction: the MCP server launches a one-shot `UnrealEditor-Cmd.exe -run=UEMCPCommandlet` executor, passes a JSON request, dispatches only allowlisted `headless_capable` handlers, writes a JSON response, and exits. It must preserve the current commandlet gate that suppresses the live TCP listener inside commandlet processes. Removing the gate or making commandlets bind `tcp-55558` is not acceptable because it reintroduces port contention, readiness ambiguity, and lifecycle ambiguity.

The headless layer should define its own transport contract, tool metadata, save/compile postconditions, DDC and source-control flags, timeout/crash handling, response envelope parity, and tests. Good first candidates are asset-scoped editor operations that do not require viewport UI, PIE, or active editor state. PIE/runtime tools, viewport capture, active UI state, and level mutation should remain out of scope until their load/save semantics are specified.

## Verification Gates

Spec-phase verification:

- Web research audit records official API evidence for `UEdGraphPin`, `UEdGraphNode`, `UBlueprint`, `UAnimBlueprint`, AnimGraph node inheritance, and state machine graph semantics.
- Engine header audit records UE 5.3, UE 5.6, and UE 5.7 API evidence for graph, node, pin, Blueprint, and AnimGraph-specific graph-reference APIs.
- Repository API audit records local source support and implementation seams.
- Adversarial audit records graph coverage, payload, ID format, graph key, graph GUID, cross-graph link, subpin, validation, read-purity, and scope risks.
- Live pre-plan probe records current `get_anim_graph` shape and baseline payload size on `/Game/Actors/Character/ABP_DroppedCharacter`, and records that Python is not an authoritative route for complete node/pin topology.

Implementation-phase verification:

- Focused JS tests for schema/dispatch.
- Focused source tests for C++ topology traversal.
- Focused source tests for graph key generation, graph GUID/schema metadata, linked-to target graph identity, subpin recursion, no duplicate child graph counting, no silent truncation, and read-only purity.
- Live smoke records `pin_topology.pin_count`, `link_entry_count`, `edge_count`, dropped counters, and total response byte size for the configured smoke AnimBlueprint.
- `node test-m5-animation.mjs`.
- `node test-tcp-tools.mjs`.
- `node test-tool-discovery-intents.mjs`.
- `node test-tool-requirements.mjs`.
- `npm test` from `server/`.
- Plugin sync, Unreal build, editor relaunch, `verify-deploy.bat`, and live smoke when implementation includes C++ changes.

## Acceptance Criteria

- `get_anim_graph` accepts `include_pin_topology` and `include_pin_defaults`.
- Existing default `get_anim_graph` response remains backward-compatible.
- `pin_topology` uses a documented schema version.
- `pin_topology` emits `id_format`, `complete`, `truncated`, `link_entry_count`, and `edge_count`.
- `pin_topology.graphs` serializes graph entries by collision-safe graph key.
- Graph entries include graph key, graph GUID or null, display name, path, class, schema class, type, and sources.
- Each graph entry serializes nodes keyed by node GUID.
- Each node entry includes owning graph key and serializes pins keyed by pin ID.
- Each pin entry serializes direction, name, type summary, subpin metadata, and `linked_to[]`.
- Link targets include target graph key, target node GUID, and target pin ID.
- Visual node metadata includes class, title, and position.
- Dropped/dangling/orphan/duplicate counters are emitted.
- Implementation remains read-only: no compile, save, mutation, pin allocation, PIE, Python, or generic raw dispatch.
- Static and live verification boundaries are documented and enforced.
