# Animation Get Anim Graph Readback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a read-only `get_anim_graph` tool that loads a `UAnimBlueprint` in the editor and returns static AnimGraph topology: graphs, state machines, states, transitions, slot nodes, and layered bone blend nodes.

**Architecture:** Follow the existing asset-instance read pattern used by `get_montage_full` and `get_anim_sequence_info`: the public tool row lives under `tools.yaml` `animation:`, the Node definition lives in `server/menhance-tcp-tools.mjs`, and the editor command lives in `plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp`. Keep this as a typed read path over TCP:55558; do not expose raw command dispatch, Python probing, or sidecar parsing as the primary workflow.

**Tech Stack:** Node.js ES modules, Zod, `js-yaml`, existing UEMCP `TestRunner`, Unreal Engine 5.6 editor plugin C++ APIs (`UAnimBlueprint`, `UAnimGraphNode_StateMachineBase`, `UAnimStateNode`, `UAnimStateTransitionNode`, `UAnimGraphNode_Slot`, `UAnimGraphNode_LayeredBoneBlend`), Windows PowerShell.

## Global Constraints

- Source-only Node tests must pass without Unreal Editor running.
- The tool is read-only: no asset mutation, no compile, no save, no PIE requirement.
- Do not add a generic public command dispatcher.
- Do not use `run_python_command` as the implementation.
- Do not claim live deploy freshness from static tests; live proof remains `verify-deploy.bat` plus `smoke-live.bat`.
- Plugin C++ changes require a deploy-visible version bump: root `manifest.json` `version`, `plugin/UEMCP/UEMCP.uplugin` `Version`, and `VersionName`.
- Engine-version divergence must go through `Public/UEMCPCompat.h` if needed; do not add raw version guards inline.

---

## File Structure

- `tools.yaml`: add the public `animation.get_anim_graph` row.
- `server/menhance-tcp-tools.mjs`: add the read-only Node definition and TCP dispatch schema.
- `server/test-tcp-tools.mjs`: extend dedicated animation read routing and pass-through tests.
- `server/test-tool-discovery-intents.mjs`: change the AnimGraph known-gap assertion into a positive `get_anim_graph` discovery assertion.
- `server/test-tool-requirements.mjs`: assert `animation.get_anim_graph -> live_read`.
- `server/test-m5-animation.mjs`: add source guards for the C++ handler, registration, and editor API usage.
- `server/live-smoke-animation-readback.mjs`: add opt-in live readback smoke gated by `UEMCP_LIVE_ANIM_BLUEPRINT`.
- `server/test-run-live-smoke.mjs`: assert the new live smoke script is discoverable.
- `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs`: add `AnimGraph` and `AnimGraphRuntime` private dependencies.
- `plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp`: implement `HandleGetAnimGraph` and register `get_anim_graph`.
- `plugin/UEMCP/Source/UEMCP/Public/AnimationHandlers.h`: update stale comments to include the readback tool.
- `manifest.json` and `plugin/UEMCP/UEMCP.uplugin`: bump to `1.0.15` and plugin integer version `16`.

## Task 1: Add The JS/YAML Public Contract

**Files:**
- Modify: `tools.yaml`
- Modify: `server/menhance-tcp-tools.mjs`
- Modify: `server/test-tcp-tools.mjs`
- Modify: `server/test-tool-discovery-intents.mjs`
- Modify: `server/test-tool-requirements.mjs`

**Interfaces:**
- Consumes: existing `executeMenhanceTool(toolName, args, connectionManager)` and `MENHANCE_SCHEMAS`.
- Produces: `get_anim_graph` Node schema with params `{ asset_path, include_transitions?, include_node_properties? }`, `isReadOp: true`, identity wire type `get_anim_graph`.

- [ ] **Step 1: Write the failing TCP routing assertions**

In `server/test-tcp-tools.mjs`, update the dedicated animation asset-instance read list:

```js
for (const name of ['get_montage_full', 'get_anim_sequence_info', 'get_anim_graph']) {
  t.assert(MENHANCE_SCHEMAS[name] !== undefined, `MENHANCE_SCHEMAS has ${name}`);
  t.assert(MENHANCE_SCHEMAS[name].partialRc === undefined,
    `${name} dispatches to its asset-instance TCP handler, not reflection_walk`);
}
```

In the identity pass-through block that already fakes `get_montage_full` and `get_anim_sequence_info`, add:

```js
fake.on('get_anim_graph', {
  status: 'success',
  result: {
    asset_path: '/Game/Anim/ABP_Test',
    graphs: [{ name: 'AnimGraph', graph_type: 'anim_graph', node_count: 3 }],
    state_machines: [{ name: 'Locomotion', states: [], transitions: [] }],
    slot_nodes: [{ graph_name: 'AnimGraph', slot_name: 'DefaultSlot' }],
    layered_blend_nodes: [],
  },
});

const graph = await executeMenhanceTool('get_anim_graph', {
  asset_path: '/Game/Anim/ABP_Test',
  include_transitions: true,
  include_node_properties: true,
}, cm);
t.assert(graph.result?.state_machines?.[0]?.name === 'Locomotion',
  'get_anim_graph pass-through from dedicated handler');
t.assert(fake.lastCall('get_anim_graph')?.params?.asset_path === '/Game/Anim/ABP_Test',
  'get_anim_graph dispatches to get_anim_graph wire type');
t.assert(fake.lastCall('get_anim_graph')?.params?.include_transitions === true,
  'get_anim_graph forwards include_transitions');
t.assert(fake.lastCall('get_anim_graph')?.params?.include_node_properties === true,
  'get_anim_graph forwards include_node_properties');
```

- [ ] **Step 2: Write the failing discovery assertion**

In `server/test-tool-discovery-intents.mjs`, replace the AnimGraph known-gap assertions with:

```js
const animGraphNames = topToolNames(index, 'AnimGraph state machine slot layered blend', 8);
t.assert(
  animGraphNames.includes('get_anim_graph'),
  'AnimGraph semantic readback routes to get_anim_graph',
  `got ${animGraphNames.join(', ')}`,
);
```

- [ ] **Step 3: Write the failing requirement assertion**

In `server/test-tool-requirements.mjs`, add:

```js
assertRequirement('animation', 'get_anim_graph', TOOL_REQUIREMENT_KINDS.LIVE_READ);
```

- [ ] **Step 4: Run focused tests to verify RED**

Run from `server/`:

```cmd
node test-tcp-tools.mjs
node test-tool-discovery-intents.mjs
node test-tool-requirements.mjs
```

Expected failures:

- `test-tcp-tools.mjs`: fails because `MENHANCE_SCHEMAS.get_anim_graph` is missing.
- `test-tool-discovery-intents.mjs`: fails because `tools.yaml` has no `get_anim_graph` row.
- `test-tool-requirements.mjs`: fails because `animation.get_anim_graph` is missing from `tools.yaml`.

- [ ] **Step 5: Add the YAML row**

In `tools.yaml`, under `toolsets.animation.tools`, after `get_anim_sequence_info`, add:

```yaml
      # full_tcp: loads UAnimBlueprint asset instance; returns static AnimGraph topology.
      # offline_pair: bp_list_graphs remains useful for top-level graph presence without editor.
      get_anim_graph:
        initially_visible: true
        status: shipped
        availability_layer: tcp-55558
        transport_layer: tcp-55558
        requires_editor: true
        requires_pie: false
        mutates_asset: false
        mutates_level: false
        saves_asset: false
        compiles_asset: false
        offline_fallback: bp_list_graphs
        aliases: ["AnimGraph state machine", "animation blueprint graph", "animation state machine", "slot node", "layered bone blend"]
        description: AnimBlueprint static graph read — graphs, state machines, states, transitions, slot nodes, and layered bone blend nodes.
        params:
          asset_path: { type: string, required: true }
          include_transitions: { type: boolean, required: false }
          include_node_properties: { type: boolean, required: false }
```

- [ ] **Step 6: Add the Node schema**

In `server/menhance-tcp-tools.mjs`, after `get_anim_sequence_info`, add:

```js
  get_anim_graph: {
    description: 'AnimBlueprint static graph read — graphs, state machines, states, transitions, slot nodes, and layered bone blend nodes from the UAnimBlueprint editor asset',
    schema: {
      asset_path: z.string().describe('/Game/... UAnimBlueprint path'),
      include_transitions: z.boolean().optional().describe('Include transition metadata and rule/custom graph names; default true in the plugin'),
      include_node_properties: z.boolean().optional().describe('Include per-graph node summaries; default false'),
    },
    isReadOp: true,
  },
```

Also update the top file comment and the animation tool tip in `server/create-uemcp-server.mjs` so it names `get_anim_graph` as a dedicated asset-instance read, not a known gap.

- [ ] **Step 7: Run focused tests to verify GREEN**

Run from `server/`:

```cmd
node test-tcp-tools.mjs
node test-tool-discovery-intents.mjs
node test-tool-requirements.mjs
node test-tool-surface-contract.mjs
```

Expected: all pass with `0 failed`. `test-tool-surface-contract.mjs` should remain green because the Node schema, YAML row, and command coverage now agree at the source contract level.

- [ ] **Step 8: Commit the public contract**

```cmd
git add tools.yaml server/menhance-tcp-tools.mjs server/create-uemcp-server.mjs server/test-tcp-tools.mjs server/test-tool-discovery-intents.mjs server/test-tool-requirements.mjs
git commit -m "D187 add anim graph readback contract"
```

## Task 2: Add Failing Plugin Source Guards

**Files:**
- Modify: `server/test-m5-animation.mjs`

**Interfaces:**
- Consumes: `AnimationHandlers.cpp` source text.
- Produces: a source guard that fails until `HandleGetAnimGraph`, editor API includes, and registry registration exist.

- [ ] **Step 1: Add the failing source guard block**

In `server/test-m5-animation.mjs`, after the existing D183 source guard block, add:

```js
// ═══════════════════════════════════════════════════════════════
// Group 10: D187 AnimGraph readback source guard
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 10: D187 AnimGraph Readback Source Guard ──');

{
  const source = readFileSync(
    new URL('../plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp', import.meta.url),
    'utf8'
  );
  const buildSource = readFileSync(
    new URL('../plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs', import.meta.url),
    'utf8'
  );

  const start = source.indexOf('void HandleGetAnimGraph');
  const end = source.indexOf('void RegisterAnimationHandlers', start);
  const graphBlock = start >= 0 && end > start ? source.slice(start, end) : '';

  t.assert(source.includes('#include "Animation/AnimBlueprint.h"'),
    'get_anim_graph includes UAnimBlueprint header');
  t.assert(source.includes('#include "AnimGraphNode_StateMachineBase.h"'),
    'get_anim_graph includes state machine graph node header');
  t.assert(source.includes('#include "AnimStateNode.h"'),
    'get_anim_graph includes state node header');
  t.assert(source.includes('#include "AnimStateTransitionNode.h"'),
    'get_anim_graph includes transition node header');
  t.assert(source.includes('#include "AnimGraphNode_Slot.h"'),
    'get_anim_graph includes slot node header');
  t.assert(source.includes('#include "AnimGraphNode_LayeredBoneBlend.h"'),
    'get_anim_graph includes layered bone blend node header');

  t.assert(buildSource.includes('"AnimGraph"'), 'Build.cs depends on AnimGraph');
  t.assert(buildSource.includes('"AnimGraphRuntime"'), 'Build.cs depends on AnimGraphRuntime');

  t.assert(graphBlock.includes('LoadObject<UObject>'),
    'get_anim_graph loads the asset instance from disk');
  t.assert(graphBlock.includes('Cast<UAnimBlueprint>'),
    'get_anim_graph validates UAnimBlueprint class');
  t.assert(graphBlock.includes('GetAllGraphs'),
    'get_anim_graph walks Blueprint-owned graphs');
  t.assert(graphBlock.includes('UAnimGraphNode_StateMachineBase'),
    'get_anim_graph inspects state machine graph nodes');
  t.assert(graphBlock.includes('UAnimStateNode'),
    'get_anim_graph serializes states');
  t.assert(graphBlock.includes('UAnimStateTransitionNode'),
    'get_anim_graph serializes transitions');
  t.assert(graphBlock.includes('UAnimGraphNode_Slot'),
    'get_anim_graph serializes slot nodes');
  t.assert(graphBlock.includes('UAnimGraphNode_LayeredBoneBlend'),
    'get_anim_graph serializes layered bone blend nodes');
  t.assert(graphBlock.includes('unsupported_runtime_fields'),
    'get_anim_graph explicitly marks runtime-only data unsupported');
  t.assert(!/run_python_command|IPythonScriptPlugin|FPythonCommand/i.test(graphBlock),
    'get_anim_graph does not use Python execution');

  t.assert(/Registry\.Register\(TEXT\("get_anim_graph"\),\s*&HandleGetAnimGraph\)/.test(source),
    'get_anim_graph is registered on the live TCP command registry');
}
```

- [ ] **Step 2: Run the source guard to verify RED**

Run from `server/`:

```cmd
node test-m5-animation.mjs
```

Expected: fails in Group 10 because `HandleGetAnimGraph`, the includes, `Build.cs` dependencies, and registry registration do not exist yet.

- [ ] **Step 3: Commit the failing guard**

Do not commit a permanently failing test by itself. Keep this change staged or uncommitted until Task 3 makes it green, then commit Task 2 and Task 3 together.

## Task 3: Implement The Editor-Side AnimGraph Readback

**Files:**
- Modify: `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs`
- Modify: `plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp`
- Modify: `plugin/UEMCP/Source/UEMCP/Public/AnimationHandlers.h`
- Modify: `manifest.json`
- Modify: `plugin/UEMCP/UEMCP.uplugin`

**Interfaces:**
- Consumes: `asset_path`, optional `include_transitions`, optional `include_node_properties`.
- Produces: TCP response envelope with `result.asset_path`, `object_path`, `asset_class`, `target_skeleton`, `graphs`, `state_machines`, `slot_nodes`, `layered_blend_nodes`, `unsupported_runtime_fields`.

- [ ] **Step 1: Add plugin dependencies**

In `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs`, add these entries to `PrivateDependencyModuleNames` near `BlueprintGraph`:

```csharp
"AnimGraph",        // UAnimGraphNode_* editor nodes and state-machine graph types
"AnimGraphRuntime", // FAnimNode_Slot / FAnimNode_LayeredBoneBlend payload structs
```

- [ ] **Step 2: Add C++ includes**

In `plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp`, add these includes:

```cpp
#include "Animation/AnimBlueprint.h"
#include "Animation/AnimBlueprintGeneratedClass.h"
#include "AnimGraphNode_LayeredBoneBlend.h"
#include "AnimGraphNode_Slot.h"
#include "AnimGraphNode_StateMachineBase.h"
#include "AnimStateNode.h"
#include "AnimStateTransitionNode.h"
#include "AnimationStateMachineGraph.h"
#include "EdGraph/EdGraph.h"
#include "EdGraph/EdGraphNode.h"
```

- [ ] **Step 3: Add shared serialization helpers**

In the anonymous namespace, after `SerializeRuntimeUnsupportedFields()`, add:

```cpp
		bool GetOptionalBool(const TSharedPtr<FJsonObject>& Params, const TCHAR* FieldName, bool DefaultValue)
		{
			bool Value = DefaultValue;
			if (Params.IsValid())
			{
				Params->TryGetBoolField(FieldName, Value);
			}
			return Value;
		}

		FString GraphNameOrNull(const UEdGraph* Graph)
		{
			return Graph ? Graph->GetName() : FString();
		}

		void SetGraphNameOrNull(const TSharedPtr<FJsonObject>& Out, const TCHAR* FieldName, const UEdGraph* Graph)
		{
			if (Graph)
			{
				Out->SetStringField(FieldName, Graph->GetName());
			}
			else
			{
				Out->SetField(FieldName, MakeShared<FJsonValueNull>());
			}
		}

		TSharedPtr<FJsonObject> SerializeEditorGraphNode(const UEdGraphNode* Node, const TCHAR* Kind)
		{
			TSharedPtr<FJsonObject> Out = MakeShared<FJsonObject>();
			Out->SetStringField(TEXT("kind"), Kind);
			if (!Node)
			{
				Out->SetBoolField(TEXT("valid"), false);
				return Out;
			}
			Out->SetBoolField(TEXT("valid"), true);
			Out->SetStringField(TEXT("class"), Node->GetClass()->GetPathName());
			Out->SetStringField(TEXT("title"), Node->GetNodeTitle(ENodeTitleType::ListView).ToString());
			Out->SetStringField(TEXT("node_guid"), Node->NodeGuid.ToString(EGuidFormats::DigitsWithHyphens));
			Out->SetNumberField(TEXT("x"), Node->NodePosX);
			Out->SetNumberField(TEXT("y"), Node->NodePosY);
			if (const UEdGraph* Graph = Node->GetGraph())
			{
				Out->SetStringField(TEXT("graph_name"), Graph->GetName());
			}
			else
			{
				Out->SetField(TEXT("graph_name"), MakeShared<FJsonValueNull>());
			}
			return Out;
		}

		TArray<TSharedPtr<FJsonValue>> SerializeGraphNodeSummaries(const UEdGraph* Graph)
		{
			TArray<TSharedPtr<FJsonValue>> Out;
			if (!Graph)
			{
				return Out;
			}
			Out.Reserve(Graph->Nodes.Num());
			for (const UEdGraphNode* Node : Graph->Nodes)
			{
				if (!Node)
				{
					continue;
				}
				Out.Add(MakeShared<FJsonValueObject>(SerializeEditorGraphNode(Node, TEXT("graph_node"))));
			}
			return Out;
		}
```

- [ ] **Step 4: Add state machine serializers**

Continue after the helpers from Step 3:

```cpp
		TSharedPtr<FJsonObject> SerializeAnimState(const UAnimStateNode* State)
		{
			TSharedPtr<FJsonObject> Out = SerializeEditorGraphNode(State, TEXT("state"));
			if (!State)
			{
				return Out;
			}
			Out->SetStringField(TEXT("name"), State->GetStateName());
			Out->SetNumberField(TEXT("state_type"), static_cast<int32>(State->StateType.GetValue()));
			Out->SetBoolField(TEXT("always_reset_on_entry"), State->bAlwaysResetOnEntry);
			SetGraphNameOrNull(Out, TEXT("bound_graph"), State->GetBoundGraph());
			return Out;
		}

		TSharedPtr<FJsonObject> SerializeAnimTransition(const UAnimStateTransitionNode* Transition)
		{
			TSharedPtr<FJsonObject> Out = SerializeEditorGraphNode(Transition, TEXT("transition"));
			if (!Transition)
			{
				return Out;
			}
			Out->SetStringField(TEXT("name"), Transition->GetStateName());
			if (const UAnimStateNodeBase* Previous = Transition->GetPreviousState())
			{
				Out->SetStringField(TEXT("previous_state"), Previous->GetStateName());
			}
			else
			{
				Out->SetField(TEXT("previous_state"), MakeShared<FJsonValueNull>());
			}
			if (const UAnimStateNodeBase* Next = Transition->GetNextState())
			{
				Out->SetStringField(TEXT("next_state"), Next->GetStateName());
			}
			else
			{
				Out->SetField(TEXT("next_state"), MakeShared<FJsonValueNull>());
			}
			Out->SetNumberField(TEXT("priority_order"), Transition->PriorityOrder);
			Out->SetNumberField(TEXT("crossfade_duration"), Transition->CrossfadeDuration);
			Out->SetNumberField(TEXT("blend_mode"), static_cast<int32>(Transition->BlendMode));
			Out->SetNumberField(TEXT("logic_type"), static_cast<int32>(Transition->LogicType.GetValue()));
			Out->SetBoolField(TEXT("bidirectional"), Transition->Bidirectional);
			Out->SetBoolField(TEXT("disabled"), Transition->bDisabled);
			Out->SetBoolField(TEXT("automatic_rule_based_on_sequence_player"), Transition->bAutomaticRuleBasedOnSequencePlayerInState);
			Out->SetNumberField(TEXT("automatic_rule_trigger_time"), Transition->AutomaticRuleTriggerTime);
			Out->SetStringField(TEXT("sync_group_name_to_require_valid_markers_rule"), Transition->SyncGroupNameToRequireValidMarkersRule.ToString());
			SetGraphNameOrNull(Out, TEXT("rule_graph"), Transition->GetBoundGraph());
			SetGraphNameOrNull(Out, TEXT("custom_transition_graph"), Transition->GetCustomTransitionGraph());
			return Out;
		}

		TSharedPtr<FJsonObject> SerializeStateMachineNode(const UAnimGraphNode_StateMachineBase* MachineNode, bool bIncludeTransitions)
		{
			TSharedPtr<FJsonObject> Out = SerializeEditorGraphNode(MachineNode, TEXT("state_machine"));
			if (!MachineNode)
			{
				return Out;
			}
			Out->SetStringField(TEXT("name"), MachineNode->GetStateMachineName());
			UAnimationStateMachineGraph* MachineGraph = MachineNode->EditorStateMachineGraph;
			SetGraphNameOrNull(Out, TEXT("state_machine_graph"), MachineGraph);

			TArray<TSharedPtr<FJsonValue>> States;
			TArray<TSharedPtr<FJsonValue>> Transitions;
			if (MachineGraph)
			{
				TArray<UAnimStateNode*> StateNodes;
				MachineGraph->GetNodesOfClass<UAnimStateNode>(StateNodes);
				States.Reserve(StateNodes.Num());
				for (const UAnimStateNode* State : StateNodes)
				{
					States.Add(MakeShared<FJsonValueObject>(SerializeAnimState(State)));
				}

				if (bIncludeTransitions)
				{
					TArray<UAnimStateTransitionNode*> TransitionNodes;
					MachineGraph->GetNodesOfClass<UAnimStateTransitionNode>(TransitionNodes);
					Transitions.Reserve(TransitionNodes.Num());
					for (const UAnimStateTransitionNode* Transition : TransitionNodes)
					{
						Transitions.Add(MakeShared<FJsonValueObject>(SerializeAnimTransition(Transition)));
					}
				}
			}
			Out->SetArrayField(TEXT("states"), States);
			Out->SetArrayField(TEXT("transitions"), Transitions);
			Out->SetNumberField(TEXT("state_count"), States.Num());
			Out->SetNumberField(TEXT("transition_count"), Transitions.Num());
			return Out;
		}
```

- [ ] **Step 5: Add slot and layered blend serializers**

Continue after the helpers from Step 4:

```cpp
		TSharedPtr<FJsonObject> SerializeSlotNode(const UAnimGraphNode_Slot* SlotNode)
		{
			TSharedPtr<FJsonObject> Out = SerializeEditorGraphNode(SlotNode, TEXT("slot"));
			if (!SlotNode)
			{
				return Out;
			}
			Out->SetStringField(TEXT("slot_name"), SlotNode->Node.SlotName.ToString());
			return Out;
		}

		TSharedPtr<FJsonObject> SerializeLayeredBlendNode(const UAnimGraphNode_LayeredBoneBlend* LayeredNode)
		{
			TSharedPtr<FJsonObject> Out = SerializeEditorGraphNode(LayeredNode, TEXT("layered_bone_blend"));
			if (!LayeredNode)
			{
				return Out;
			}
			Out->SetNumberField(TEXT("blend_mode"), static_cast<int32>(LayeredNode->Node.BlendMode));
			Out->SetNumberField(TEXT("blend_pose_count"), LayeredNode->Node.BlendPoses.Num());
			Out->SetNumberField(TEXT("layer_setup_count"), LayeredNode->Node.LayerSetup.Num());
			Out->SetBoolField(TEXT("mesh_space_rotation_blend"), LayeredNode->Node.bMeshSpaceRotationBlend);
			Out->SetBoolField(TEXT("mesh_space_scale_blend"), LayeredNode->Node.bMeshSpaceScaleBlend);
			Out->SetBoolField(TEXT("blend_root_motion_based_on_root_bone"), LayeredNode->Node.bBlendRootMotionBasedOnRootBone);

			TArray<TSharedPtr<FJsonValue>> BranchFilters;
			for (int32 PoseIndex = 0; PoseIndex < LayeredNode->Node.LayerSetup.Num(); ++PoseIndex)
			{
				const FInputBlendPose& Pose = LayeredNode->Node.LayerSetup[PoseIndex];
				for (const FBranchFilter& Filter : Pose.BranchFilters)
				{
					TSharedPtr<FJsonObject> FilterJson = MakeShared<FJsonObject>();
					FilterJson->SetNumberField(TEXT("pose_index"), PoseIndex);
					FilterJson->SetStringField(TEXT("bone_name"), Filter.BoneName.ToString());
					FilterJson->SetNumberField(TEXT("blend_depth"), Filter.BlendDepth);
					BranchFilters.Add(MakeShared<FJsonValueObject>(FilterJson));
				}
			}
			Out->SetArrayField(TEXT("branch_filters"), BranchFilters);
			return Out;
		}
```

- [ ] **Step 6: Add `HandleGetAnimGraph`**

Add this handler before `HandleGetMontageFull`:

```cpp
		void HandleGetAnimGraph(const TSharedPtr<FJsonObject>& Params, TSharedPtr<FJsonObject>& OutResponse)
		{
			FString AssetPath;
			if (!RequireAssetPath(Params, TEXT("get_anim_graph"), AssetPath, OutResponse))
			{
				return;
			}

			const bool bIncludeTransitions = GetOptionalBool(Params, TEXT("include_transitions"), true);
			const bool bIncludeNodeProperties = GetOptionalBool(Params, TEXT("include_node_properties"), false);

			const FString ObjectPath = UEMCP::ToObjectPath(AssetPath);
			UObject* Asset = LoadObject<UObject>(nullptr, *ObjectPath);
			if (!Asset)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset not found at '%s'"), *AssetPath),
					TEXT("ANIM_BLUEPRINT_NOT_FOUND"));
				return;
			}

			UAnimBlueprint* AnimBlueprint = Cast<UAnimBlueprint>(Asset);
			if (!AnimBlueprint)
			{
				BuildErrorResponse(OutResponse,
					FString::Printf(TEXT("Asset '%s' is not a UAnimBlueprint"), *AssetPath),
					TEXT("NOT_ANIM_BLUEPRINT"));
				return;
			}

			TArray<UEdGraph*> AllGraphs;
			AnimBlueprint->GetAllGraphs(AllGraphs);

			TArray<TSharedPtr<FJsonValue>> Graphs;
			TArray<TSharedPtr<FJsonValue>> StateMachines;
			TArray<TSharedPtr<FJsonValue>> SlotNodes;
			TArray<TSharedPtr<FJsonValue>> LayeredBlendNodes;

			for (UEdGraph* Graph : AllGraphs)
			{
				if (!Graph)
				{
					continue;
				}

				int32 StateMachineCount = 0;
				int32 SlotNodeCount = 0;
				int32 LayeredBlendNodeCount = 0;

				for (UEdGraphNode* Node : Graph->Nodes)
				{
					if (const UAnimGraphNode_StateMachineBase* MachineNode = Cast<UAnimGraphNode_StateMachineBase>(Node))
					{
						StateMachineCount++;
						StateMachines.Add(MakeShared<FJsonValueObject>(SerializeStateMachineNode(MachineNode, bIncludeTransitions)));
					}
					if (const UAnimGraphNode_Slot* SlotNode = Cast<UAnimGraphNode_Slot>(Node))
					{
						SlotNodeCount++;
						SlotNodes.Add(MakeShared<FJsonValueObject>(SerializeSlotNode(SlotNode)));
					}
					if (const UAnimGraphNode_LayeredBoneBlend* LayeredNode = Cast<UAnimGraphNode_LayeredBoneBlend>(Node))
					{
						LayeredBlendNodeCount++;
						LayeredBlendNodes.Add(MakeShared<FJsonValueObject>(SerializeLayeredBlendNode(LayeredNode)));
					}
				}

				TSharedPtr<FJsonObject> GraphJson = MakeShared<FJsonObject>();
				GraphJson->SetStringField(TEXT("name"), Graph->GetName());
				GraphJson->SetStringField(TEXT("class"), Graph->GetClass()->GetPathName());
				GraphJson->SetNumberField(TEXT("node_count"), Graph->Nodes.Num());
				GraphJson->SetNumberField(TEXT("state_machine_count"), StateMachineCount);
				GraphJson->SetNumberField(TEXT("slot_node_count"), SlotNodeCount);
				GraphJson->SetNumberField(TEXT("layered_blend_node_count"), LayeredBlendNodeCount);
				if (bIncludeNodeProperties)
				{
					GraphJson->SetArrayField(TEXT("nodes"), SerializeGraphNodeSummaries(Graph));
				}
				Graphs.Add(MakeShared<FJsonValueObject>(GraphJson));
			}

			TSharedPtr<FJsonObject> Result = MakeShared<FJsonObject>();
			Result->SetStringField(TEXT("asset_path"), AssetPath);
			Result->SetStringField(TEXT("object_path"), AnimBlueprint->GetPathName());
			Result->SetStringField(TEXT("asset_class"), AnimBlueprint->GetClass()->GetPathName());
			SetObjectPathOrNull(Result, TEXT("target_skeleton"), AnimBlueprint->TargetSkeleton);
			Result->SetNumberField(TEXT("graph_count"), Graphs.Num());
			Result->SetNumberField(TEXT("state_machine_count"), StateMachines.Num());
			Result->SetNumberField(TEXT("slot_node_count"), SlotNodes.Num());
			Result->SetNumberField(TEXT("layered_blend_node_count"), LayeredBlendNodes.Num());
			Result->SetArrayField(TEXT("graphs"), Graphs);
			Result->SetArrayField(TEXT("state_machines"), StateMachines);
			Result->SetArrayField(TEXT("slot_nodes"), SlotNodes);
			Result->SetArrayField(TEXT("layered_blend_nodes"), LayeredBlendNodes);
			Result->SetArrayField(TEXT("unsupported_runtime_fields"), SerializeRuntimeUnsupportedFields());

			BuildSuccessResponse(OutResponse, Result);
		}
```

- [ ] **Step 7: Register the command**

In `RegisterAnimationHandlers`, add:

```cpp
		Registry.Register(TEXT("get_anim_graph"), &HandleGetAnimGraph);
```

Place it beside the other read commands, before `get_montage_full`.

- [ ] **Step 8: Update stale header comments**

In `plugin/UEMCP/Source/UEMCP/Public/AnimationHandlers.h`, replace the paragraph claiming animation reads are already served by ReflectionWalker with:

```cpp
 * AnimationHandlers.cpp owns mutation tools plus dedicated animation asset
 * reads that must load editor asset instances directly:
 *   - get_anim_graph
 *   - get_montage_full
 *   - get_anim_sequence_info
 *
 * Reflection-backed generic reads remain in the Node M-enhance surface for
 * blend spaces and curve data where full editor graph topology is not needed.
```

- [ ] **Step 9: Bump deploy-visible versions**

Set root `manifest.json`:

```json
"version": "1.0.15"
```

Set `plugin/UEMCP/UEMCP.uplugin`:

```json
"Version": 16,
"VersionName": "1.0.15"
```

- [ ] **Step 10: Run focused source and manifest tests to verify GREEN**

Run from `server/`:

```cmd
node test-m5-animation.mjs
node test-plugin-manifest.mjs
node test-tool-surface-contract.mjs
```

Expected: all pass with `0 failed`. `test-m5-animation.mjs` count increases by the Group 10 assertions.

- [ ] **Step 11: Commit the plugin implementation**

```cmd
git add plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp plugin/UEMCP/Source/UEMCP/Public/AnimationHandlers.h manifest.json plugin/UEMCP/UEMCP.uplugin server/test-m5-animation.mjs
git commit -m "D187 implement anim graph readback handler"
```

## Task 4: Add The Opt-In Live Smoke

**Files:**
- Create: `server/live-smoke-animation-readback.mjs`
- Modify: `server/test-run-live-smoke.mjs`

**Interfaces:**
- Consumes: `UEMCP_LIVE_ANIM_BLUEPRINT=/Game/...` in the environment, a running editor, and `executeMenhanceTool('get_anim_graph', ...)`.
- Produces: a live smoke script that skips cleanly when no AnimBlueprint asset path is provided.

- [ ] **Step 1: Add the live smoke script**

Create `server/live-smoke-animation-readback.mjs`:

```js
// Live smoke for get_anim_graph. Read-only, but still runs inside the opt-in
// live-smoke suite so the target editor/project is explicit.

import { executeMenhanceTool } from './menhance-tcp-tools.mjs';
import { createLiveSmokeCall, prepareLiveSmoke } from './live-smoke-harness.mjs';

const assetPath = String(process.env.UEMCP_LIVE_ANIM_BLUEPRINT || '').trim();
if (!assetPath) {
  console.log('⊘ skipped live-smoke-animation-readback: set UEMCP_LIVE_ANIM_BLUEPRINT=/Game/... to exercise get_anim_graph');
  process.exit(0);
}

const smoke = await prepareLiveSmoke({ name: 'live-smoke-animation-readback' });
if (!smoke.ready) process.exit(smoke.exitCode);

const call = createLiveSmokeCall({
  summarize: (label, result) => ({
    asset_path: result.asset_path,
    graph_count: result.graph_count,
    state_machine_count: result.state_machine_count,
    slot_node_count: result.slot_node_count,
    layered_blend_node_count: result.layered_blend_node_count,
  }),
});

const result = await call('get_anim_graph', () => executeMenhanceTool('get_anim_graph', {
  asset_path: assetPath,
  include_transitions: true,
  include_node_properties: true,
}, smoke.cm));

if (result.asset_path !== assetPath) {
  throw new Error(`get_anim_graph returned unexpected asset_path ${result.asset_path}`);
}
if (!Array.isArray(result.graphs)) {
  throw new Error('get_anim_graph did not return graphs[]');
}
if (!Array.isArray(result.state_machines)) {
  throw new Error('get_anim_graph did not return state_machines[]');
}
if (!Array.isArray(result.slot_nodes)) {
  throw new Error('get_anim_graph did not return slot_nodes[]');
}
if (!Array.isArray(result.layered_blend_nodes)) {
  throw new Error('get_anim_graph did not return layered_blend_nodes[]');
}
if (!Array.isArray(result.unsupported_runtime_fields)) {
  throw new Error('get_anim_graph did not return unsupported_runtime_fields[]');
}
```

- [ ] **Step 2: Add discovery coverage for the smoke script**

In `server/test-run-live-smoke.mjs`, add:

```js
runner.assert(discovered.includes('live-smoke-animation-readback.mjs'), 'discovers animation readback smoke');
```

- [ ] **Step 3: Run focused tests**

Run from `server/`:

```cmd
node test-run-live-smoke.mjs
node live-smoke-animation-readback.mjs
```

Expected:

- `test-run-live-smoke.mjs`: passes with `0 failed`.
- `live-smoke-animation-readback.mjs`: exits `0` with the skip marker when `UEMCP_LIVE_ANIM_BLUEPRINT` is unset.

- [ ] **Step 4: Commit the live smoke**

```cmd
git add server/live-smoke-animation-readback.mjs server/test-run-live-smoke.mjs
git commit -m "D187 add anim graph live smoke"
```

## Task 5: Full Verification And Deploy Proof

**Files:**
- No planned source edits.

**Interfaces:**
- Consumes: the completed branch.
- Produces: local source verification, deploy freshness proof, and optional live readback proof.

- [ ] **Step 1: Run the full source rotation**

Run from `server/`:

```cmd
npm test
```

Expected: all non-env-gated tests pass with `0 failed`. The rotation may report the existing explicit env/live skips when no project root is configured.

- [ ] **Step 2: Run diff hygiene**

Run from repo root:

```cmd
git diff --check
git status --short --untracked-files=all
```

Expected:

- `git diff --check` prints no whitespace errors.
- `git status` shows only intentional branch files before final commit, or a clean tree after final commit.

- [ ] **Step 3: Sync the plugin to a target project**

Close the Unreal Editor for the target project, then run from repo root:

```cmd
sync-plugin.bat "path\to\YourProject.uproject" -y
```

Expected: plugin source copies into the target project and deploy marker reflects `manifest.json` `1.0.15` plus `UEMCP.uplugin` version `16`.

- [ ] **Step 4: Rebuild the target editor**

Run the target project editor build with the installed UE 5.6 Build.bat:

```cmd
"C:\Program Files\Epic Games\UE_5.6\Engine\Build\BatchFiles\Build.bat" YourProjectEditor Win64 Development -project="path\to\YourProject.uproject" -WaitMutex
```

Expected: `Result: Succeeded` and a rebuilt target `UnrealEditor-UEMCP.dll`.

- [ ] **Step 5: Verify deploy freshness**

After build, before live smoke, run:

```cmd
verify-deploy.bat --no-pause
```

Expected: target reports `ALL-SYNC`.

- [ ] **Step 6: Run the live AnimGraph smoke**

Relaunch the editor, restart the MCP client, set an AnimBlueprint asset path in the environment, and run:

```cmd
set UEMCP_LIVE_SMOKE=1
set UEMCP_LIVE_ANIM_BLUEPRINT=/Game/path/to/YourAnimBlueprint
smoke-live.bat --project "path\to\YourProject.uproject" --no-pause
```

Expected: `live-smoke-animation-readback.mjs` passes and prints a summary containing `graph_count`, `state_machine_count`, `slot_node_count`, and `layered_blend_node_count`.

- [ ] **Step 7: Commit final verification notes if docs changed**

If a branch report or verification note was added, commit it separately:

```cmd
git add docs/reports/2026-07-08-animation-get-anim-graph-readback-verification.md
git commit -m "D187 document anim graph readback verification"
```

Skip this step when no report file was created.

## Self-Review Checklist

- [ ] Spec coverage: public YAML, Node schema, plugin registration, discovery, requirement classification, source contract, version bump, deploy proof, and live smoke are each covered by a task.
- [ ] Non-goals preserved: no generic dispatcher, no Python implementation, no sidecar-primary implementation, no PIE/runtime-state overclaim.
- [ ] Type consistency: `get_anim_graph`, `asset_path`, `include_transitions`, and `include_node_properties` match across YAML, Node, tests, and C++.
- [ ] Compile-risk check: `AnimGraph` and `AnimGraphRuntime` are in `Build.cs` before including `AnimGraphNode_*` headers.
- [ ] Deploy-risk check: `manifest.json` and `UEMCP.uplugin` versions move together.
- [ ] Live-proof boundary: static tests prove source wiring only; `verify-deploy.bat` and `smoke-live.bat` are still required after C++ changes.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-08-animation-get-anim-graph-readback.md`.

Two execution options:

1. **Subagent-Driven (recommended)** - dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints.
