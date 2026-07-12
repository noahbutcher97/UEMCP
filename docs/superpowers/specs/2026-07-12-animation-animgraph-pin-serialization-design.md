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
        "name": "AnimGraph",
        "path": "/Game/Characters/ABP_Example.ABP_Example:AnimGraph",
        "graph_type": "anim_graph",
        "class_name": "AnimationGraph",
        "sources": ["get_all_graphs"],
        "nodes": {
          "<node_guid>": {
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
                  "container": "pose"
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
- Graph entries include `graph_key`, `name`, `path`, `class_name`, `graph_type`, and `sources[]`.
- `nodes` is an object keyed by `UEdGraphNode::NodeGuid`.
- `pins` is an object keyed by `UEdGraphPin::PinId`.
- `linked_to[]` entries use target `graph_key`, target `node_guid`, and target `pin_id`.
- Pin directions use Unreal enum strings: `EGPD_Input`, `EGPD_Output`, or `EGPD_Unknown`.
- Node GUIDs and pin IDs must use one explicit format consistently across the topology object. Prefer `EGuidFormats::Digits` for Oracle parity unless implementation proves hyphenated IDs are needed for compatibility with existing `get_anim_graph` summaries. If the implementation keeps summary IDs hyphenated, topology IDs still need a clear `id_format` field.
- `id_format` is required and applies to node GUIDs, pin IDs, and linked-to targets inside `pin_topology`.
- Serialize top-level pins and recursive `SubPins` into the same `pins` map. Subpins include `is_subpin: true`, `parent_pin_id`, and an empty or populated `subpin_ids` array.
- Parent pins include `subpin_ids[]` when split pins are present.
- `link_entry_count` counts every serialized `linked_to[]` entry. `edge_count` counts unique visual connections after canonicalizing reciprocal pin links. The per-pin `linked_to[]` arrays remain authoritative.
- `complete` and `truncated` are required. The implementation must not silently truncate. If a defensive cap is introduced during implementation, the response must either fail with a structured error or set `complete: false`, `truncated: true`, and include omitted counts.
- The topology object includes graph metadata, node title, node class, and node position because these are part of visual graph serialization.
- The topology object must not duplicate the entire existing semantic arrays unless needed for usability. Semantic arrays remain as current siblings.

### Graph Coverage

Use `UAnimBlueprint::GetAllGraphs` as the primary graph collection source because the existing implementation already uses it and it includes Blueprint-owned graphs. The implementation must verify that this covers:

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
- Recurse `UEdGraph::SubGraphs` for collapsed, composite, or nested editor graph content when present, using the same visited set.
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

- Unknown params must follow the existing tool schema policy; do not add broad aliases.
- `include_pin_defaults: true` with `include_pin_topology: false` must fail validation or return a clear structured error. It must not silently imply topology, and it must not produce defaults in the lightweight response.
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
- Fake TCP response with `pin_topology` round-trips unchanged.
- Fake TCP response includes `graph_key` on linked-to entries and verifies callers can disambiguate graph-scoped node IDs.
- `test-m5-animation.mjs` source guard proves `HandleGetAnimGraph` reads `UEdGraphPin`, `LinkedTo`, `PinId`, `PinName`, `PinType`, `SubPins`, `ParentPin`, and owner node GUID.
- Source guard proves topology generation is gated by `include_pin_topology`.
- Source guard proves no Python execution, no save, no compile, and no PIE dependency.
- Source guard proves no pin allocation or mutation calls are introduced in the topology read path.
- Source guard proves graph traversal uses a visited set and includes `UEdGraph::SubGraphs` or explicitly records why subgraphs are absent.
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
- graph entries contain `nodes`;
- if nodes exist, node entries contain `pins`;
- if pin links exist, each linked-to entry contains `graph_key`, `node_guid`, and `pin_id`;
- `link_entry_count` is a number;
- `edge_count` is a number;
- `complete === true` and `truncated === false` for the smoke asset;
- existing `graphs[]`, `state_machines[]`, `slot_nodes[]`, and `layered_blend_nodes[]` remain arrays.

The live smoke must stay skipped unless the live smoke env gates are set.

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
- `UEdGraphNode` exposes `NodeGuid`, `NodePosX`, `NodePosY`, and `Pins`. This supports including node GUID and visual position in a visual graph serialization response. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UEdGraphNode>
- `UBlueprint::GetAllGraphs` returns all graphs in a Blueprint. This supports the existing `get_anim_graph` graph collection strategy, with explicit verification for bound graph references. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UBlueprint>
- `UAnimBlueprint` is a specialized Blueprint whose graphs control a skeletal mesh animation and derives from `UBlueprint`. This supports extending a Blueprint graph serializer pattern to AnimBlueprint editor graphs. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Runtime/Engine/UAnimBlueprint>
- `UAnimGraphNode_Base` derives through `UEdGraphNode` and is the base class for editor animation graph nodes that generate or consume animation pose. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Editor/AnimGraph/UAnimGraphNode_Base>
- `UAnimGraphNode_StateMachineBase` derives through `UEdGraphNode` and owns an editor state machine graph. This supports walking state machine graph references, not just summary node counts. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Editor/AnimGraph/UAnimGraphNode_StateMachineBase>
- Epic's state machine docs describe state machines as AnimBlueprint systems with states, transitions, and subgraphs inside the Anim Graph. This supports requiring state and transition bound graphs, not just root AnimGraph nodes. Source: <https://dev.epicgames.com/documentation/unreal-engine/state-machines-in-unreal-engine>
- `FEdGraphUtilities::CloneGraph` documentation explicitly mentions deep copies of graphs including nodes, pins, and their links. This reinforces that nodes, pins, and links are the natural unit of editor graph fidelity. Source: <https://dev.epicgames.com/documentation/unreal-engine/API/Editor/UnrealEd/FEdGraphUtilities>

Research conclusion: the recommended design follows the Unreal editor graph model. A per-pin `linked_to[]` topology is more faithful and more discoverable than raw command dispatch, Python probes, or counts-only summaries.

### API Audit

Local source confirms the required APIs already compile in this repo baseline:

- `AnimationHandlers.cpp` includes `Animation/AnimBlueprint.h`, `EdGraph/EdGraph.h`, and `EdGraph/EdGraphNode.h`, loads `UAnimBlueprint`, and calls `GetAllGraphs`.
- `AnimationHandlers.cpp` already depends on `AnimGraph`, `AnimGraphRuntime`, and concrete editor node types for state machines, state nodes, transition nodes, slot nodes, and layered bone blend nodes.
- `BlueprintHandlers.cpp` already serializes `PinId`, `PinName`, direction, pin type summary, defaults, and `LinkedTo`-derived link objects.
- `GraphTraversalHandlers.cpp` already serializes material graph `UEdGraphNode` pins and `linked_to[]`.
- `EdgeOnlyBPSerializer.cpp` walks `UEdGraphNode::Pins` and serializes `Pin->LinkedTo` into Oracle-A-v2 graph maps.
- `server/uasset-parser.mjs` and `offline-tools.mjs` already consume the same `graphs -> nodes -> pins -> linked_to` shape for offline Blueprint edge topology.

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

Mitigation: Keep `include_pin_topology` default false. Add response counts plus `complete` and `truncated`. No silent truncation is allowed. Consider `graph_filter` or `max_nodes` as a follow-on only if real assets exceed practical payload limits.

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

## Follow-On Boundaries

These are intentionally not part of this slice:

- AnimGraph node authoring or rewiring.
- Schema-compatible `connect_anim_graph_nodes`.
- Offline `.uasset` parser parity for AnimGraph pin topology.
- Sidecar generation for AnimGraph topology.
- Inherited parent AnimBlueprint graph traversal and external linked anim layer asset traversal, unless those graphs are owned by the requested asset and exposed through its graph set.
- Control Rig, StateTree, Sequencer, linked asset, or external graph serialization from nodes referenced by the AnimBlueprint.
- Special rendering metadata for split pins beyond ID, parent, and child relationships.
- Payload filtering such as `graph_filter`, `node_class_filter`, or `max_nodes`.
- Derived convenience `edges[]` if the primary per-pin contract is enough.
- Runtime pose, evaluated state, blend weights, active state, or PIE instance data.
- Visual screenshot/canvas capture of the graph editor.
- Detailed node property decoding beyond existing semantic buckets and safe pin metadata.

## Verification Gates

Spec-phase verification:

- Web research audit records official API evidence for `UEdGraphPin`, `UEdGraphNode`, `UBlueprint`, `UAnimBlueprint`, AnimGraph node inheritance, and state machine graph semantics.
- Source/API audit records local source support and implementation seams.
- Adversarial audit records graph coverage, payload, ID format, graph key, cross-graph link, subpin, read-purity, and scope risks.

Implementation-phase verification:

- Focused JS tests for schema/dispatch.
- Focused source tests for C++ topology traversal.
- Focused source tests for graph key generation, linked-to target graph identity, subpin recursion, no silent truncation, and read-only purity.
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
- Graph entries include graph key, display name, path, class, type, and sources.
- Each graph entry serializes nodes keyed by node GUID.
- Each node entry serializes pins keyed by pin ID.
- Each pin entry serializes direction, name, type summary, subpin metadata, and `linked_to[]`.
- Link targets include target graph key, target node GUID, and target pin ID.
- Visual node metadata includes class, title, and position.
- Dropped/dangling/orphan/duplicate counters are emitted.
- Implementation remains read-only: no compile, save, mutation, pin allocation, PIE, Python, or generic raw dispatch.
- Static and live verification boundaries are documented and enforced.
