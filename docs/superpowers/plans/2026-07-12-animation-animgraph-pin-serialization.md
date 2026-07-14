# Animation AnimGraph Pin Serialization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the shipped read-only `animation.get_anim_graph` tool with opt-in full AnimBlueprint visual pin topology.

**Architecture:** Keep `get_anim_graph` as the public tool. Add Node schema/validation for `include_pin_topology` and `include_pin_defaults`, then add a C++ serializer that walks the already-loaded `UAnimBlueprint` editor graphs and emits `UEdGraphNode`, `UEdGraphPin`, and `LinkedTo` wiring only when requested. The implementation stays live-editor TCP only; sidecars, commandlets, offline parser parity, and generic headless MCP execution remain follow-ons.

**Tech Stack:** Node.js ES modules, Zod, `tools.yaml`, UE 5.6 C++ editor plugin code, MCP TCP `55558`, focused Node tests, source-guard tests, opt-in live smoke.

## Global Constraints

- This slice is read-only. Do not compile, save, mark dirty, allocate pins, modify nodes, link pins, break pins, run PIE, execute Python, or dispatch generic raw commands.
- Existing `get_anim_graph` callers must remain backward-compatible when `include_pin_topology` is omitted.
- `include_pin_topology` defaults to `false`.
- `include_pin_defaults` defaults to `false` and requires `include_pin_topology: true` at both Node and C++ layers.
- `pin_topology.id_format` must be explicit. Use `EGuidFormats::Digits` inside `pin_topology`, even though existing summary nodes currently use `DigitsWithHyphens`.
- `pin_topology` must be a sibling object. Do not overload existing `graphs[].nodes` array with map-form topology.
- No silent truncation. Emit `complete`, `truncated`, count fields, and dropped/dangling counters.
- Use `UAnimBlueprint::GetAllGraphs` as the primary graph seed. Do not manually append subgraphs without a visited set.
- Sidecar generation, commandlet generation, offline `.uasset` parser parity, and generic headless MCP execution are out of scope.
- If plugin C++ changes are made, normal deploy verification still requires sync, Unreal build, editor relaunch, MCP restart, `verify-deploy.bat`, and opt-in live smoke.

---

## File Structure

- `tools.yaml`: add the two public optional params and sharpen the `get_anim_graph` description.
- `server/menhance-tcp-tools.mjs`: add Zod params and tool-specific cross-field validation.
- `server/test-tcp-tools.mjs`: prove params are accepted, forwarded, cached as a read, and invalid default-only calls fail before TCP.
- `server/anim-graph-topology-validation.mjs`: centralize topology shape, count, identity, reference, completeness, and dropped-counter validation for tests and live smoke.
- `server/test-animation-topology-validation.mjs`: exercise the shared validator with complete, explained-incomplete, unresolved-reference, and defaults-contract fixtures.
- `server/test-helpers.mjs`: provide the shared synthetic AnimGraph topology fixture.
- `server/create-uemcp-server.mjs`: update animation toolset guidance so users discover pin topology through `get_anim_graph`.
- `plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp`: add read-only pin-topology helpers and attach the topology object only when requested.
- `server/test-m5-animation.mjs`: add source guards for the new C++ read path, payload contract, and non-mutation requirements.
- `server/live-smoke-animation-readback.mjs`: request `include_pin_topology` and report graph/node/pin/link counts plus payload byte size.

---

### Task 1: Node Schema, Validation, And Tool Metadata

**Files:**
- Modify: `server/test-tcp-tools.mjs`
- Modify: `server/menhance-tcp-tools.mjs`
- Modify: `tools.yaml`
- Modify: `server/create-uemcp-server.mjs`

**Interfaces:**
- Consumes: existing `MENHANCE_SCHEMAS.get_anim_graph` and `executeMenhanceTool(toolName, args, connectionManager)`.
- Produces: `get_anim_graph` validated params `{ asset_path, include_transitions?, include_node_properties?, include_pin_topology?, include_pin_defaults? }`.
- Produces: a Node-layer error when `include_pin_defaults === true && include_pin_topology !== true`.

- [ ] **Step 1: Write the failing Node dispatch and validation tests**

In `server/test-tcp-tools.mjs`, update the existing `get_anim_graph` block around the animation asset-instance read section. Replace the call payload with:

```js
const graph = await executeMenhanceTool('get_anim_graph', {
  asset_path: '/Game/Anim/ABP_Test',
  include_transitions: true,
  include_node_properties: true,
  include_pin_topology: true,
  include_pin_defaults: true,
}, cm);
```

Immediately after the existing `include_node_properties` assertion, add:

```js
t.assert(fake.lastCall('get_anim_graph')?.params?.include_pin_topology === true,
  'get_anim_graph forwards include_pin_topology');
t.assert(fake.lastCall('get_anim_graph')?.params?.include_pin_defaults === true,
  'get_anim_graph forwards include_pin_defaults');
```

In the Zod validation section near the existing `start_pie` invalid-mode assertion, add:

```js
await t.assertRejects(
  () => executeMenhanceTool('get_anim_graph', {
    asset_path: '/Game/Anim/ABP_Test',
    include_pin_defaults: true,
  }, cm),
  /include_pin_defaults.*include_pin_topology/i,
  'get_anim_graph rejects include_pin_defaults without include_pin_topology'
);
```

- [ ] **Step 2: Run the focused test to verify it fails**

Run:

```powershell
cd server
node test-tcp-tools.mjs
```

Expected: fails because the new params are stripped or rejected and the dependency error is not implemented.

- [ ] **Step 3: Add Node schema params and tool-specific validation**

In `server/menhance-tcp-tools.mjs`, update the `get_anim_graph` schema:

```js
get_anim_graph: {
  description: 'AnimBlueprint static graph read - graphs, state machines, states, transitions, slot nodes, layered bone blend nodes, and optional visual pin topology from the UAnimBlueprint editor asset',
  schema: {
    asset_path: z.string().describe('/Game/... UAnimBlueprint path'),
    include_transitions: z.boolean().optional().describe('Include transition metadata and rule/custom graph names; default true in the plugin'),
    include_node_properties: z.boolean().optional().describe('Include per-graph node summaries; default false'),
    include_pin_topology: z.boolean().optional().describe('Include full UEdGraph node/pin/LinkedTo visual topology; default false'),
    include_pin_defaults: z.boolean().optional().describe('Include safe UEdGraphPin default fields; requires include_pin_topology=true'),
  },
  isReadOp: true,
},
```

Add this helper above `executeMenhanceTool`:

```js
function applyToolSpecificValidation(toolName, validated) {
  if (
    toolName === 'get_anim_graph'
    && validated.include_pin_defaults === true
    && validated.include_pin_topology !== true
  ) {
    throw new Error('get_anim_graph: include_pin_defaults requires include_pin_topology=true');
  }
  return validated;
}
```

Then change the validation line in `executeMenhanceTool` from:

```js
const validated = z.object(def.schema).parse(args);
```

to:

```js
const validated = applyToolSpecificValidation(toolName, z.object(def.schema).parse(args));
```

- [ ] **Step 4: Update `tools.yaml`**

In `tools.yaml`, update the `get_anim_graph` description and params:

```yaml
        description: AnimBlueprint static graph read - graphs, state machines, states, transitions, slot nodes, layered bone blend nodes, and optional full visual pin topology.
        params:
          asset_path: { type: string, required: true }
          include_transitions: { type: boolean, required: false }
          include_node_properties: { type: boolean, required: false }
          include_pin_topology: { type: boolean, required: false }
          include_pin_defaults: { type: boolean, required: false }
```

- [ ] **Step 5: Update animation discovery guidance**

In `server/create-uemcp-server.mjs`, update the animation toolset `core` string so it names the new opt-in topology:

```js
'get_montage_full, get_anim_sequence_info, and get_anim_graph are full tcp-55558 asset-instance reads - they load UAnimMontage/UAnimSequence/UAnimBlueprint and return montage sections, notifies, slot tracks, sequence skeleton/rate data, and static AnimGraph topology. Use get_anim_graph include_pin_topology=true when you need visual UEdGraph node/pin/LinkedTo wiring. get_blend_space and get_anim_curve_data remain reflection-backed reads; pair with read_asset_properties (offline) for batch file-level inspection.',
```

- [ ] **Step 6: Verify Task 1**

Run:

```powershell
cd server
node test-tcp-tools.mjs
node test-tool-discovery-intents.mjs
node test-tool-requirements.mjs
```

Expected: all pass. `get_anim_graph` forwards both new params, rejects `include_pin_defaults` without topology, and remains `live_read`.

- [ ] **Step 7: Commit Task 1**

```powershell
git add tools.yaml server/menhance-tcp-tools.mjs server/test-tcp-tools.mjs server/create-uemcp-server.mjs
git commit -m "Add AnimGraph pin topology tool params"
```

---

### Task 2: C++ Source Guards And Read-Only Pin Topology Serializer

**Files:**
- Modify: `server/test-m5-animation.mjs`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp`

**Interfaces:**
- Consumes: `include_pin_topology` and `include_pin_defaults` params already forwarded by Task 1.
- Produces: `SerializeAnimGraphPinTopology(const TArray<UEdGraph*>& AllGraphs, bool bIncludePinDefaults) -> TSharedPtr<FJsonObject>`.
- Produces: `pin_topology` object under the existing `get_anim_graph` result only when `include_pin_topology` is true.

- [ ] **Step 1: Write source-guard tests before implementation**

In `server/test-m5-animation.mjs`, extend Group 10 after the existing Python assertion:

```js
t.assert(source.includes('#include "EdGraph/EdGraphPin.h"'),
  'get_anim_graph includes UEdGraphPin header for pin topology');
t.assert(source.includes('#include "EdGraph/EdGraphSchema.h"'),
  'get_anim_graph includes UEdGraphSchema header for schema metadata');
t.assert(source.includes('SerializeAnimGraphPinTopology'),
  'get_anim_graph has a dedicated pin topology serializer');
t.assert(source.includes('SerializeAnimGraphTopologyNode'),
  'get_anim_graph serializes topology nodes separately from summary nodes');
t.assert(source.includes('SerializeAnimGraphPin('),
  'get_anim_graph serializes UEdGraphPin fields');
t.assert(source.includes('BuildAnimGraphTopologyIndex'),
  'get_anim_graph builds a graph-key index before link serialization');
t.assert(graphBlock.includes('include_pin_topology'),
  'get_anim_graph reads include_pin_topology');
t.assert(graphBlock.includes('include_pin_defaults'),
  'get_anim_graph reads include_pin_defaults');
t.assert(graphBlock.includes('PIN_DEFAULTS_REQUIRE_TOPOLOGY'),
  'get_anim_graph rejects pin defaults without topology at C++ layer');
t.assert(graphBlock.includes('SetObjectField(TEXT("pin_topology")'),
  'get_anim_graph attaches pin_topology only when requested');
t.assert(source.includes('EGuidFormats::Digits'),
  'pin topology uses explicit digits GUID format');
t.assert(source.includes('SetBoolField(TEXT("truncated"), false)'),
  'pin topology explicitly reports non-truncated payloads');
t.assert(source.includes('dangling_link_count'),
  'pin topology reports dangling link count');
t.assert(source.includes('duplicate_graph_key_count'),
  'pin topology reports duplicate graph-key count');

const topologyStart = source.indexOf('struct FAnimGraphTopologyIndex');
const topologyEnd = source.indexOf('TSharedPtr<FJsonObject> SerializeEditorGraphNode', topologyStart);
const topologyBlock = topologyStart >= 0 && topologyEnd > topologyStart
  ? source.slice(topologyStart, topologyEnd)
  : '';
t.assert(!/Modify\s*\(|AllocateDefaultPins|MarkPackageDirty|SavePackage|CompileBlueprint|MakeLinkTo|BreakLinkTo|BreakAllPinLinks/.test(topologyBlock),
  'pin topology serializer remains read-only and does not normalize or mutate graph state');
```

- [ ] **Step 2: Run the focused source guard to verify it fails**

Run:

```powershell
cd server
node test-m5-animation.mjs
```

Expected: Group 10 fails because the serializer and param handling do not exist.

- [ ] **Step 3: Add C++ includes**

In `plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp`, add:

```cpp
#include "EdGraph/EdGraphPin.h"
#include "EdGraph/EdGraphSchema.h"
```

Place them next to the existing `EdGraph` includes.

- [ ] **Step 4: Add topology helper structs and scalar helpers**

In the anonymous namespace in `AnimationHandlers.cpp`, place this block after `SetGraphNameOrNull` and before `SerializeEditorGraphNode`:

```cpp
		struct FAnimGraphTopologyIndex
		{
			TArray<UEdGraph*> Graphs;
			TMap<const UEdGraph*, FString> GraphKeys;
			int32 DroppedNullGraphCount = 0;
			int32 DuplicateGraphKeyCount = 0;
			int32 NodeCount = 0;
			int32 PinCount = 0;
			int32 LinkEntryCount = 0;
			int32 DanglingLinkCount = 0;
			int32 OrphanPinCount = 0;
			TSet<FString> UniqueEdges;
		};

		FString GuidToDigits(const FGuid& Guid)
		{
			return Guid.ToString(EGuidFormats::Digits);
		}

		const TCHAR* PinDirectionToString(EEdGraphPinDirection Direction)
		{
			switch (Direction)
			{
				case EGPD_Input: return TEXT("EGPD_Input");
				case EGPD_Output: return TEXT("EGPD_Output");
				default: return TEXT("EGPD_Unknown");
			}
		}

		const TCHAR* PinContainerToString(EPinContainerType ContainerType)
		{
			switch (ContainerType)
			{
				case EPinContainerType::None: return TEXT("None");
				case EPinContainerType::Array: return TEXT("Array");
				case EPinContainerType::Set: return TEXT("Set");
				case EPinContainerType::Map: return TEXT("Map");
				default: return TEXT("Unknown");
			}
		}

		void SetStringOrNull(const TSharedPtr<FJsonObject>& Out, const TCHAR* FieldName, const FString& Value)
		{
			if (Value.IsEmpty())
			{
				Out->SetField(FieldName, MakeShared<FJsonValueNull>());
			}
			else
			{
				Out->SetStringField(FieldName, Value);
			}
		}

		void SetObjectPathOrNullField(const TSharedPtr<FJsonObject>& Out, const TCHAR* FieldName, const UObject* Object)
		{
			if (Object)
			{
				Out->SetStringField(FieldName, Object->GetPathName());
			}
			else
			{
				Out->SetField(FieldName, MakeShared<FJsonValueNull>());
			}
		}
```

This plan intentionally uses a new `SetObjectPathOrNullField` instead of editing the existing `SetObjectPathOrNull`, so other animation response fields keep their current behavior.

- [ ] **Step 5: Add pin type and graph-index helpers**

Add this block immediately after the helpers from Step 4:

```cpp
		TSharedPtr<FJsonObject> SerializeTerminalType(const FEdGraphTerminalType& TerminalType)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			Out->SetStringField(TEXT("category"), TerminalType.TerminalCategory.ToString());
			Out->SetStringField(TEXT("subcategory"), TerminalType.TerminalSubCategory.ToString());
			SetObjectPathOrNullField(Out, TEXT("subcategory_object"), TerminalType.TerminalSubCategoryObject.Get());
			Out->SetBoolField(TEXT("is_const"), TerminalType.bTerminalIsConst);
			Out->SetBoolField(TEXT("is_weak_pointer"), TerminalType.bTerminalIsWeakPointer);
			Out->SetBoolField(TEXT("is_uobject_wrapper"), TerminalType.bTerminalIsUObjectWrapper);
			return Out;
		}

		TSharedPtr<FJsonObject> SerializeAnimGraphPinType(const FEdGraphPinType& PinType)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			Out->SetStringField(TEXT("category"), PinType.PinCategory.ToString());
			Out->SetStringField(TEXT("subcategory"), PinType.PinSubCategory.ToString());
			SetObjectPathOrNullField(Out, TEXT("subcategory_object"), PinType.PinSubCategoryObject.Get());
			Out->SetStringField(TEXT("container"), PinContainerToString(PinType.ContainerType));
			Out->SetBoolField(TEXT("is_reference"), PinType.bIsReference);
			Out->SetBoolField(TEXT("is_const"), PinType.bIsConst);
			Out->SetBoolField(TEXT("is_weak_pointer"), PinType.bIsWeakPointer);
			Out->SetBoolField(TEXT("is_uobject_wrapper"), PinType.bIsUObjectWrapper);
			if (PinType.ContainerType == EPinContainerType::Map)
			{
				Out->SetObjectField(TEXT("value_terminal_type"), SerializeTerminalType(PinType.PinValueType));
			}
			return Out;
		}

		FString MakeGraphBaseKey(const UEdGraph* Graph)
		{
			if (!Graph)
			{
				return TEXT("Graph");
			}
			FString Base = Graph->GetName();
			if (Base.IsEmpty())
			{
				Base = TEXT("Graph");
			}
			return Base;
		}

		FAnimGraphTopologyIndex BuildAnimGraphTopologyIndex(const TArray<UEdGraph*>& AllGraphs)
		{
			FAnimGraphTopologyIndex Index;
			TSet<const UEdGraph*> SeenGraphs;
			TSet<FString> UsedGraphKeys;

			for (UEdGraph* Graph : AllGraphs)
			{
				if (!Graph)
				{
					++Index.DroppedNullGraphCount;
					continue;
				}
				if (SeenGraphs.Contains(Graph))
				{
					continue;
				}
				SeenGraphs.Add(Graph);

				const FString BaseKey = MakeGraphBaseKey(Graph);
				FString GraphKey = BaseKey;
				int32 Suffix = 2;
				while (UsedGraphKeys.Contains(GraphKey))
				{
					GraphKey = FString::Printf(TEXT("%s#%d"), *BaseKey, Suffix++);
				}
				if (GraphKey != BaseKey)
				{
					++Index.DuplicateGraphKeyCount;
				}
				UsedGraphKeys.Add(GraphKey);

				Index.Graphs.Add(Graph);
				Index.GraphKeys.Add(Graph, GraphKey);
			}

			return Index;
		}
```

- [ ] **Step 6: Add link and pin serializers**

Add this block after Step 5:

```cpp
		FString MakeEndpointKey(const FString& GraphKey, const FGuid& NodeGuid, const FGuid& PinId)
		{
			return FString::Printf(TEXT("%s:%s:%s"),
				*GraphKey,
				*GuidToDigits(NodeGuid),
				*GuidToDigits(PinId));
		}

		void AddUniqueEdge(FAnimGraphTopologyIndex& Index, const FString& A, const FString& B)
		{
			if (A.Compare(B) <= 0)
			{
				Index.UniqueEdges.Add(A + TEXT("<->") + B);
			}
			else
			{
				Index.UniqueEdges.Add(B + TEXT("<->") + A);
			}
		}

		TSharedPtr<FJsonObject> SerializeAnimGraphPin(const UEdGraphPin* Pin, const FString& OwningGraphKey, FAnimGraphTopologyIndex& Index, bool bIncludePinDefaults)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			if (!Pin)
			{
				return Out;
			}

			const UEdGraphNode* OwningNode = Pin->GetOwningNodeUnchecked();
			Out->SetStringField(TEXT("pin_id"), GuidToDigits(Pin->PinId));
			Out->SetStringField(TEXT("name"), Pin->PinName.ToString());
			Out->SetStringField(TEXT("direction"), PinDirectionToString(Pin->Direction));
			Out->SetObjectField(TEXT("type"), SerializeAnimGraphPinType(Pin->PinType));
			Out->SetNumberField(TEXT("link_count"), Pin->LinkedTo.Num());

			if (Pin->ParentPin)
			{
				Out->SetStringField(TEXT("parent_pin_id"), GuidToDigits(Pin->ParentPin->PinId));
			}
			else
			{
				Out->SetField(TEXT("parent_pin_id"), MakeShared<FJsonValueNull>());
			}

			TArray<TSharedPtr<FJsonValue>> SubPinIds;
			SubPinIds.Reserve(Pin->SubPins.Num());
			for (const UEdGraphPin* SubPin : Pin->SubPins)
			{
				if (SubPin)
				{
					SubPinIds.Add(MakeShared<FJsonValueString>(GuidToDigits(SubPin->PinId)));
				}
			}
			Out->SetArrayField(TEXT("subpin_ids"), SubPinIds);
			Out->SetArrayField(TEXT("sub_pin_ids"), SubPinIds);

#if WITH_EDITORONLY_DATA
			const bool bOrphaned = Pin->bOrphanedPin != 0;
			Out->SetBoolField(TEXT("orphaned"), bOrphaned);
			if (bOrphaned)
			{
				++Index.OrphanPinCount;
			}
#else
			Out->SetBoolField(TEXT("orphaned"), false);
#endif

			if (bIncludePinDefaults)
			{
				TSharedPtr<FJsonObject> Defaults = MakeShared<FJsonObject>();
				Defaults->SetStringField(TEXT("default_value"), Pin->DefaultValue);
				Defaults->SetStringField(TEXT("autogenerated_default_value"), Pin->AutogeneratedDefaultValue);
				SetObjectPathOrNullField(Defaults, TEXT("default_object"), Pin->DefaultObject.Get());
				Defaults->SetStringField(TEXT("default_text_value"), Pin->DefaultTextValue.ToString());
				Out->SetObjectField(TEXT("defaults"), Defaults);
			}

			TArray<TSharedPtr<FJsonValue>> LinkedTo;
			LinkedTo.Reserve(Pin->LinkedTo.Num());
			for (const UEdGraphPin* LinkedPin : Pin->LinkedTo)
			{
				const UEdGraphNode* LinkedNode = LinkedPin ? LinkedPin->GetOwningNodeUnchecked() : nullptr;
				const UEdGraph* LinkedGraph = LinkedNode ? LinkedNode->GetGraph() : nullptr;
				const FString* LinkedGraphKey = LinkedGraph ? Index.GraphKeys.Find(LinkedGraph) : nullptr;
				if (!LinkedPin || !LinkedNode || !LinkedGraphKey)
				{
					++Index.DanglingLinkCount;
					continue;
				}

				TSharedPtr<FJsonObject> LinkJson = MakeShared<FJsonObject>();
				LinkJson->SetStringField(TEXT("graph_key"), *LinkedGraphKey);
				LinkJson->SetStringField(TEXT("node_guid"), GuidToDigits(LinkedNode->NodeGuid));
				LinkJson->SetStringField(TEXT("pin_id"), GuidToDigits(LinkedPin->PinId));
				LinkJson->SetStringField(TEXT("pin_name"), LinkedPin->PinName.ToString());
				LinkedTo.Add(MakeShared<FJsonValueObject>(LinkJson));

				++Index.LinkEntryCount;
				if (OwningNode)
				{
					AddUniqueEdge(
						Index,
						MakeEndpointKey(OwningGraphKey, OwningNode->NodeGuid, Pin->PinId),
						MakeEndpointKey(*LinkedGraphKey, LinkedNode->NodeGuid, LinkedPin->PinId));
				}
			}
			Out->SetArrayField(TEXT("linked_to"), LinkedTo);

			return Out;
		}
```

- [ ] **Step 7: Add node, graph, and root serializers**

Add this block after Step 6:

```cpp
		TSharedPtr<FJsonObject> SerializeAnimGraphTopologyNode(const UEdGraphNode* Node, const FString& GraphKey, FAnimGraphTopologyIndex& Index, bool bIncludePinDefaults)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			if (!Node)
			{
				return Out;
			}

			Out->SetStringField(TEXT("node_guid"), GuidToDigits(Node->NodeGuid));
			Out->SetStringField(TEXT("graph_key"), GraphKey);
			Out->SetStringField(TEXT("class"), Node->GetClass()->GetPathName());
			Out->SetStringField(TEXT("class_name"), Node->GetClass()->GetName());
			Out->SetStringField(TEXT("title"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
			Out->SetNumberField(TEXT("x"), Node->NodePosX);
			Out->SetNumberField(TEXT("y"), Node->NodePosY);

			TSharedPtr<FJsonObject> Pins = MakeShared<FJsonObject>();
			for (const UEdGraphPin* Pin : Node->Pins)
			{
				if (!Pin)
				{
					continue;
				}
				++Index.PinCount;
				Pins->SetObjectField(GuidToDigits(Pin->PinId), SerializeAnimGraphPin(Pin, GraphKey, Index, bIncludePinDefaults));
			}
			Out->SetObjectField(TEXT("pins"), Pins);
			Out->SetNumberField(TEXT("pin_count"), Node->Pins.Num());

			return Out;
		}

		TSharedPtr<FJsonObject> SerializeAnimGraphTopologyGraph(UEdGraph* Graph, const FString& GraphKey, FAnimGraphTopologyIndex& Index, bool bIncludePinDefaults)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			if (!Graph)
			{
				return Out;
			}

			Out->SetStringField(TEXT("graph_key"), GraphKey);
			Out->SetStringField(TEXT("display_name"), Graph->GetName());
			Out->SetStringField(TEXT("path"), Graph->GetPathName());
			Out->SetStringField(TEXT("class"), Graph->GetClass()->GetPathName());
			Out->SetStringField(TEXT("graph_type"), ClassifyAnimBlueprintGraph(Graph));
			if (Graph->GraphGuid.IsValid())
			{
				Out->SetStringField(TEXT("graph_guid"), GuidToDigits(Graph->GraphGuid));
			}
			else
			{
				Out->SetField(TEXT("graph_guid"), MakeShared<FJsonValueNull>());
			}
			const UEdGraphSchema* Schema = Graph->GetSchema();
			SetObjectPathOrNullField(Out, TEXT("schema_class"), Schema ? Schema->GetClass() : nullptr);

			TArray<TSharedPtr<FJsonValue>> Sources;
			Sources.Add(MakeShared<FJsonValueString>(TEXT("UAnimBlueprint::GetAllGraphs")));
			Out->SetArrayField(TEXT("sources"), Sources);

			TSharedPtr<FJsonObject> Nodes = MakeShared<FJsonObject>();
			for (const UEdGraphNode* Node : Graph->Nodes)
			{
				if (!Node)
				{
					continue;
				}
				++Index.NodeCount;
				Nodes->SetObjectField(GuidToDigits(Node->NodeGuid), SerializeAnimGraphTopologyNode(Node, GraphKey, Index, bIncludePinDefaults));
			}
			Out->SetObjectField(TEXT("nodes"), Nodes);
			Out->SetNumberField(TEXT("node_count"), Graph->Nodes.Num());

			return Out;
		}

		TSharedPtr<FJsonObject> SerializeAnimGraphPinTopology(const TArray<UEdGraph*>& AllGraphs, bool bIncludePinDefaults)
		{
			FAnimGraphTopologyIndex Index = BuildAnimGraphTopologyIndex(AllGraphs);

			TSharedPtr<FJsonObject> Graphs = MakeShared<FJsonObject>();
			for (UEdGraph* Graph : Index.Graphs)
			{
				const FString* GraphKey = Index.GraphKeys.Find(Graph);
				if (!GraphKey)
				{
					++Index.DanglingLinkCount;
					continue;
				}
				Graphs->SetObjectField(*GraphKey, SerializeAnimGraphTopologyGraph(Graph, *GraphKey, Index, bIncludePinDefaults));
			}

			TSharedPtr<FJsonObject> Dropped = MakeShared<FJsonObject>();
			Dropped->SetNumberField(TEXT("null_graph_count"), Index.DroppedNullGraphCount);
			Dropped->SetNumberField(TEXT("dangling_link_count"), Index.DanglingLinkCount);
			Dropped->SetNumberField(TEXT("orphan_pin_count"), Index.OrphanPinCount);
			Dropped->SetNumberField(TEXT("duplicate_graph_key_count"), Index.DuplicateGraphKeyCount);

			TSharedPtr<FJsonObject> Root = MakeShared<FJsonObject>();
			Root->SetStringField(TEXT("schema_version"), TEXT("anim-uedgraph-pin-topology-v1"));
			Root->SetStringField(TEXT("id_format"), TEXT("digits"));
			Root->SetBoolField(TEXT("complete"), !HasAnimGraphTopologyLosses(Index));
			Root->SetBoolField(TEXT("truncated"), false);
			Root->SetBoolField(TEXT("includes_pin_defaults"), bIncludePinDefaults);
			Root->SetNumberField(TEXT("graph_count"), Index.Graphs.Num());
			Root->SetNumberField(TEXT("node_count"), Index.NodeCount);
			Root->SetNumberField(TEXT("pin_count"), Index.PinCount);
			Root->SetNumberField(TEXT("link_entry_count"), Index.LinkEntryCount);
			Root->SetNumberField(TEXT("edge_count"), Index.UniqueEdges.Num());
			Root->SetObjectField(TEXT("dropped"), Dropped);
			Root->SetObjectField(TEXT("graphs"), Graphs);
			return Root;
		}
```

- [ ] **Step 8: Wire params into `HandleGetAnimGraph`**

In `HandleGetAnimGraph`, after the existing optional bools:

```cpp
const bool bIncludePinTopology = GetOptionalBool(Params, TEXT("include_pin_topology"), false);
const bool bIncludePinDefaults = GetOptionalBool(Params, TEXT("include_pin_defaults"), false);
if (bIncludePinDefaults && !bIncludePinTopology)
{
	BuildErrorResponse(OutResponse,
		TEXT("get_anim_graph include_pin_defaults requires include_pin_topology=true"),
		TEXT("PIN_DEFAULTS_REQUIRE_TOPOLOGY"));
	return;
}
```

After the existing result arrays are set and before `unsupported_runtime_fields`:

```cpp
if (bIncludePinTopology)
{
	Result->SetObjectField(TEXT("pin_topology"), SerializeAnimGraphPinTopology(AllGraphs, bIncludePinDefaults));
}
```

Do not add `pin_topology` when `bIncludePinTopology` is false.

- [ ] **Step 9: Verify Task 2**

Run:

```powershell
cd server
node test-m5-animation.mjs
```

Expected: pass. The source guard proves the serializer exists, is gated, uses explicit ID formatting, reports counts, and avoids known mutation calls.

- [ ] **Step 10: Commit Task 2**

```powershell
git add server/test-m5-animation.mjs plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp
git commit -m "Serialize AnimGraph pin topology"
```

---

### Task 3: Live Smoke Payload Proof

**Files:**
- Modify: `server/live-smoke-animation-readback.mjs`

**Interfaces:**
- Consumes: `get_anim_graph` with `include_pin_topology: true`.
- Produces: live smoke failure if `pin_topology` is missing or has invalid count fields.
- Produces: live smoke summary with topology counts and serialized byte size.

- [ ] **Step 1: Write the failing live-smoke expectations**

In `server/live-smoke-animation-readback.mjs`, update the `summarize` function to include topology metrics:

```js
summarize: (_label, result) => ({
  asset_path: result.asset_path,
  graph_count: result.graph_count,
  state_machine_count: result.state_machine_count,
  slot_node_count: result.slot_node_count,
  layered_blend_node_count: result.layered_blend_node_count,
  pin_topology: validateAnimGraphPinTopology(result.pin_topology, {
    requireNonEmpty: true,
    expectedIncludesPinDefaults: false,
  }),
}),
```

Update the call payload:

```js
const result = await call('get_anim_graph', () => executeMenhanceTool('get_anim_graph', {
  asset_path: assetPath,
  include_transitions: true,
  include_node_properties: true,
  include_pin_topology: true,
}, smoke.cm));
```

After the existing array checks, add:

```js
if (!result.pin_topology || typeof result.pin_topology !== 'object') {
  throw new Error('get_anim_graph did not return pin_topology');
}
for (const field of ['graph_count', 'node_count', 'pin_count', 'link_entry_count', 'edge_count']) {
  if (typeof result.pin_topology[field] !== 'number') {
    throw new Error(`get_anim_graph pin_topology.${field} is not numeric`);
  }
}
if (result.pin_topology.schema_version !== 'anim-uedgraph-pin-topology-v1') {
  throw new Error(`unexpected pin_topology schema_version ${result.pin_topology.schema_version}`);
}
if (result.pin_topology.id_format !== 'digits') {
  throw new Error(`unexpected pin_topology id_format ${result.pin_topology.id_format}`);
}
if (result.pin_topology.truncated !== false) {
  throw new Error('pin_topology should report truncated=false in this slice');
}
if (!result.pin_topology.graphs || typeof result.pin_topology.graphs !== 'object') {
  throw new Error('get_anim_graph pin_topology.graphs missing');
}
```

- [ ] **Step 2: Run the smoke in skip mode**

Run without a live env var:

```powershell
cd server
node live-smoke-animation-readback.mjs
```

Expected: skips cleanly with the existing `UEMCP_LIVE_ANIM_BLUEPRINT` message.

- [ ] **Step 3: Run focused non-live tests**

Run:

```powershell
cd server
node test-tcp-tools.mjs
node test-m5-animation.mjs
```

Expected: pass.

- [ ] **Step 4: Commit Task 3**

```powershell
git add server/live-smoke-animation-readback.mjs
git commit -m "Smoke AnimGraph pin topology"
```

---

### Task 4: Full Verification And Deploy-Gated Live Proof

**Files:**
- No planned source edits.

**Interfaces:**
- Consumes: tasks 1-3.
- Produces: static test evidence, plugin deploy evidence, and opt-in live smoke evidence.

- [ ] **Step 1: Run focused tests**

Run:

```powershell
cd server
node test-tcp-tools.mjs
node test-tool-discovery-intents.mjs
node test-tool-requirements.mjs
node test-m5-animation.mjs
node live-smoke-animation-readback.mjs
```

Expected: all pass, with live smoke skipping unless `UEMCP_LIVE_ANIM_BLUEPRINT` is set.

- [ ] **Step 2: Run full server rotation**

Run:

```powershell
cd server
npm test
```

Expected: full rotation passes with zero failures.

- [ ] **Step 3: Deploy plugin changes to the target project**

Only after Task 2 changes C++:

```powershell
.\verify-deploy.bat
.\sync-plugin.bat "<Project.uproject>" -y
```

Then close the editor, build the target project with Unreal `Build.bat`, relaunch the editor, and restart the MCP client. Use the repo's normal target profile if available instead of hardcoding a project path.

- [ ] **Step 4: Run deploy freshness verification**

Run:

```powershell
.\verify-deploy.bat
```

Expected: target reports synced/built/fresh enough. If stale DLL behavior appears, compare source and DLL mtimes, then nuke the deployed plugin `Binaries` and `Intermediate` before rebuilding.

- [ ] **Step 5: Run opt-in live topology smoke**

With the editor open and UEMCP reachable:

```powershell
$env:UEMCP_LIVE_SMOKE='1'
$env:UEMCP_LIVE_ANIM_BLUEPRINT='/Game/Actors/Character/ABP_DroppedCharacter'
.\smoke-live.bat
```

Expected: live smoke reports `pin_topology.graph_count`, `node_count`, `pin_count`, `link_entry_count`, `edge_count`, `complete`, `truncated:false`, and byte size. Record whether `complete` is true or false; false is acceptable only when `dropped.dangling_link_count` or another emitted counter explains it.

- [ ] **Step 6: Commit verification-only doc updates only if needed**

If verification surfaces a durable note that belongs in docs, commit that doc update separately:

```powershell
git add <doc-path>
git commit -m "Document AnimGraph topology verification"
```

If no doc update is needed, do not create a verification-only commit.

---

## Second-Pass Hardening Results

This plan intentionally closes the following brittleness points before implementation:

- **Node-only validation is insufficient.** The dependency between `include_pin_defaults` and `include_pin_topology` is enforced in both Node and C++, so raw TCP callers cannot bypass it.
- **Existing response shape stays stable.** `pin_topology` is a sibling object and is absent by default. The current `graphs[].nodes` summary array remains unchanged.
- **Graph identity is collision-safe.** Graph keys are generated with deterministic suffixes and `duplicate_graph_key_count` is emitted.
- **Final graph keys are globally reserved.** Generated suffixes cannot collide with a real graph name such as `Foo#2` and overwrite a prior JSON map entry.
- **GUID format is explicit.** Topology IDs use `EGuidFormats::Digits` and declare `id_format: "digits"`, while older summary fields can remain hyphenated for compatibility.
- **Cross-graph links are not ambiguous.** Link targets include `graph_key`, `node_guid`, `pin_id`, and `pin_name`.
- **Split pins are represented without deep decoding.** Pins include `parent_pin_id` and canonical `subpin_ids`; `sub_pin_ids` remains a compatibility alias. The serializer does not invent synthetic split-pin edges.
- **Payload risk is measured, not guessed.** Live smoke reports serialized topology byte size and count fields.
- **Topology validation has one implementation.** Fake TCP and live smoke share the same fixture-backed validator for IDs, counts, references, edges, defaults, dropped aliases, and explained incompleteness.
- **Read purity has a guard.** Source tests scan the topology serializer block for mutation and normalization calls.
- **No silent partials.** The response includes `complete`, `truncated:false`, and dropped/dangling counters.
- **Headless scope stays separate.** This plan does not add sidecars, commandlets, generic `UEMCPCommandlet`, `headless_capable`, or a generic dispatcher.

## Self-Review

- **Spec coverage:** Tasks cover Node params, cross-field validation, C++ graph/node/pin/link serialization, graph-key collision handling, subpin metadata, default fields, response counts, live smoke payload measurement, and deploy gates.
- **Placeholder scan:** No placeholder tokens or open-ended implementation instructions remain. Follow-on boundaries are named as exclusions, not unfinished steps.
- **Type consistency:** The plan uses `include_pin_topology`, `include_pin_defaults`, `pin_topology`, `schema_version`, `id_format`, `graph_key`, `node_guid`, `pin_id`, `linked_to`, and `dropped` consistently across Node, C++, tests, and smoke.
- **Compile-risk check:** UE 5.6 headers confirm `UEdGraph::GraphGuid`, `UEdGraph::Schema`, `UEdGraphPin::ParentPin`, `SubPins`, `DefaultValue`, `AutogeneratedDefaultValue`, `DefaultObject`, `DefaultTextValue`, and `FEdGraphTerminalType` field names used by the plan.
- **Scope check:** The plan is one coherent implementation slice. Generic headless MCP execution remains a separate future spec and plan.

## Execution Handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** - Dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints.
