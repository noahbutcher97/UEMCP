# Native experiment for asset-backed graph actions

On UE 5.8.4 CL58902052, a pawn Event Graph and a top-level AnimGraph could use the same native sequence of operations to filter, select and place a registered action. Source identity and repeat placement require family-specific handling. The experiment supports the public discovery and placement interfaces in the [graph action design](asset-backed-graph-actions.md). The experiment itself used a fixture module.

## What Unreal placed

A UEMCP-owned editor created two Boolean Input Actions named `Interact` and two Animation Sequences named `Locomotion`, each pair in separate packages. The left sequence was a copy of Walk and the right a copy of Idle. The observer passed the actual registry owner and spawner to `FBlueprintActionFilter` with the target Blueprint and graph. It invoked a single unfiltered match. A separate graph traversal read membership, node GUID, asset reference, pins and links. A fresh editor loaded both saved Blueprints and repeated the traversal.

| Selection | Observed result |
| --- | --- |
| Left and right Input Action | The two menu labels and native signatures were identical. Selecting each exact path added one `K2Node_EnhancedInputAction` to the pawn, increasing its graph from three nodes to five. Both references and distinct node GUIDs survived reload. Each event had Triggered, Started, Ongoing, Canceled and Completed exec outputs plus action value, timing and asset outputs. |
| Left and right Sequence Player | The two actions shared the label `Play 'Locomotion'` and a native signature containing only the node class. Both selections created a distinct `AnimGraphNode_SequencePlayer` with the intended reference and a pose output. |
| Empty Sequence Player | A third player had the same native signature, an empty asset reference, and a pose output. The AnimGraph grew from one node to four. All three selections survived reload. |
| Wrong context | Both input events were filtered in the AnimGraph. Both sequences were filtered in the pawn Event Graph and in a second AnimBP using an incompatible skeleton. These queries preserved graph counts and target package dirty state. |

## Registry lifecycle and retries

- **Creation and rename.** Each new source had one unfiltered candidate immediately after creation and after saving. For a separate action and clip, renaming produced zero candidates at the old path and one at the new path on the same editor tick. A targeted refresh and cold reopen agreed. The registry was still loading when the creation experiment began. These exact matches do not establish completeness for broad searches while loading.
- **Loaded and unloaded assets.** Newly created sequences registered under their source asset. At cold start an unreferenced sequence registered under the Sequence Player class with its path in `UBlueprintAssetNodeSpawner::GetAssetData()`. Discovery and class refresh left it unloaded. Invoking it loaded the clip and placed a node whose animation reference matched that path. The empty action was also class-owned and had invalid asset data.
- **Repeated input placement.** A targeted refresh produced a `BlueprintNodeSpawner`. Two invocations for the same action created two event GUIDs. A class refresh in that same editor still exposed a generic spawner for this asset and produced the same duplication on a second pawn. In a fresh editor, an `InputActionEventNodeSpawner` returned the existing GUID on the second call and graph membership stayed at six nodes. Two successive invocations of the same Sequence Player intentionally added two different player GUIDs.

## Implementation decision and acceptance boundary

Resolve a selection by verified editor session, target graph, family, canonical source object and variant. For sequences inspect the spawner's asset data regardless of registry owner, and represent an empty player explicitly. For input events inspect existing event nodes and compare their actual action references before invoking. On a repeat, reuse a single exact match in the intended graph. Report ambiguity or another graph's existing event before editing. After placing either family, check graph membership, observed source reference and required pins. Re-resolve after rename or registry changes.

The three editor processes exited normally. This establishes native placement, lookup and save/reload on UE 5.8.4. The test left the new output pins unconnected. Public MCP discovery and placement, Undo/Redo, same-path asset replacement, actual mapped input and evaluated motion, and UE 5.3.2/5.6.1 execution remain separate acceptance steps. No provider or human used the proposed operations in this experiment.

The local report `2026-11-21-action-experiment` contains the fixture source, launcher, engine identity, three independent raw graph/registry observations, source and module hashes, and two verification scripts.
