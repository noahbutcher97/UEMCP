# Animation authoring: research and proposed execution model

Source review: 2026-11-19. Proposal only; peer code and tests were inspected,
not compiled or executed. No consumer assets were changed. This supplements the
[U5 program](animation-authoring-program.md), not a new backlog.

## Lessons from peer implementations

| Primary source and inspected revision | Source observation | Decision for UEMCP |
|---|---|---|
| [db-lyon graph operations](https://github.com/db-lyon/ue-mcp/blob/d9f59f8dc097558a01f4f9758c57476dcdd60182/plugin/ue_mcp_bridge/Source/UE_MCP_Bridge/Private/Handlers/Blueprint/BlueprintHandlers_Graph.cpp) (commit dated November 19) | AddNode supports deferred compilation; ConnectPins uses the target graph schema and describes broken links. Placement includes node-specific initialization/reconstruction handling. | Provide granular graph editing, contextual node discovery and deferred compilation. Qualify node families; do not implement placement as unchecked object construction or wiring as raw links. |
| [db-lyon state machines](https://github.com/db-lyon/ue-mcp/blob/d9f59f8dc097558a01f4f9758c57476dcdd60182/plugin/ue_mcp_bridge/Source/UE_MCP_Bridge/Private/Handlers/Animation/AnimationHandlers_StateMachine.cpp) | State/transition operations return transition GUIDs and bound graph identity for subsequent rule editing. | Let users compose state-machine tools with ordinary graph operations; names alone are insufficient for ambiguous transitions. |
| [db-lyon sequence editing](https://github.com/db-lyon/ue-mcp/blob/d9f59f8dc097558a01f4f9758c57476dcdd60182/plugin/ue_mcp_bridge/Source/UE_MCP_Bridge/Private/Handlers/Animation/AnimationHandlers_Sequence.cpp) | Batch key editing uses the animation data controller and checks write results. Earlier bone edits can precede a later failure; inverse payloads explicitly describe limitations. This route also resets editor transaction history. | Return exact partial outcomes. An inverse operation is not full Undo. Preserve live-editor Undo rather than adopting transaction-history reset. |
| [db-lyon montage batch](https://github.com/db-lyon/ue-mcp/blob/d9f59f8dc097558a01f4f9758c57476dcdd60182/plugin/ue_mcp_bridge/Source/UE_MCP_Bridge/Private/Handlers/Animation/AnimationHandlers.cpp) | AuthorMontagesBatch composes creation, slots, properties, sections, notifies and saving; results include per-item failures. Delete inverses cover newly created assets, not restoration of existing assets. | Offer useful composite workflows on the same primitives, with explicit per-asset failure and recovery semantics. |
| [UECortex animation tools](https://github.com/ashd-007/UECortex/blob/f748ebbd84d45c69b8672cb5c0d30e6e006c6cea/Source/UECortexAnim/Private/MCPAnimTools.cpp) (commit dated September 16) | A locomotion setup operation combines variables, state and event graph construction. Inspected compile/save routes call CompileBlueprint and SaveDirtyPackages without inspecting compiler results before their success response. | Reusable workflow templates are valuable. Inspect compile results and save only explicit target packages; do not carry this success-reporting pattern into UEMCP. |

The inspected [peer live tests](https://github.com/db-lyon/ue-mcp/blob/d9f59f8dc097558a01f4f9758c57476dcdd60182/tests/live/animation-authoring-gaps.test.ts)
include animation readback and inverse replay. Their existence is not a passing
runtime receipt. No peer's full CI, release reliability or license suitability
for copying source was established. These are design lessons, not code reuse.

Epic's [animation data controller](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/Engine/IAnimationDataController)
and [editor scripting documentation](https://dev.epicgames.com/documentation/unreal-engine/scripting-the-unreal-editor-using-python)
provide native editing and headless execution reference points. The default
[Unreal MCP documentation](https://dev.epicgames.com/documentation/unreal-engine/unreal-mcp-in-unreal-editor)
resolved to 5.9 during research: do not infer 5.8 tool availability or startup
flags from that page. Qualify against the actual installed engine.

## What a project-side generator teaches us

A locally inspected consumer implementation separates a graph description from
asset bindings, uses stable identities and canonical verification, preserves
unmanaged nodes and manual layout, prepares edits on copies and compares the
planned result before persistence. Its headless apply path explicitly separates
partial-save recovery from in-memory changes and requires external recovery
after process exit. Source inspection does not prove those recovery paths pass.

Adopt the transferable ideas: reusable recipes, bounded patches, separate asset
bindings, readable previews, stable identities and honest persistence receipts.
Do not import project-specific gameplay assumptions or use a dedicated-process
package-replacement mechanism in an interactive editor. Keep exact private
source pointers in ignored local research, not public documentation.

## Two authoring interfaces, shared native operations

1. **Ad hoc editing:** discover graph-compatible node actions; create/configure
   nodes; inspect pins; connect/disconnect or explicitly replace links; set
   defaults and references; move/comment/delete; compile and inspect diagnostics.
   Support AnimGraph pose/data wiring and Event Graph execution/data wiring.
   Discover custom/project node capabilities without claiming universal support.
2. **Recipes and patches:** express a repeatable graph or timeline change using
   those operations. Bind project assets separately, preview intended changes,
   and preserve unrelated authored content. Let a successful experiment become
   a reusable patch; recipes must not be the only authoring entry point.

Use explicit asset and graph identity, node GUIDs, pin identity and an observed
revision. After reconstruction, return fresh pin identities and actual topology.
Preflight against the graph schema, including conversion and link-replacement
effects. Report actual changes rather than assuming every schema call is local.
Keep selection/layout separate from executable semantics where useful.

An edit may succeed while compilation is deferred or fails. Return these as
separate states and preserve diagnostics associated with nodes/pins. Allow
intentional incomplete experiments; never report them as runtime-ready. Saving
is explicit and its policy must distinguish a draft from a validated result.

## Online and offline execution

| Mode | Intended support | Evidence and limits |
|---|---|---|
| Live editor | Inspect and incrementally edit loaded graphs/assets; grouped transactions, Undo/Redo; explicit compile, preview and save | Includes unsaved state. Validate Undo across node creation, reconstruction and link replacement. Runtime/visual preview is separate from compile success. |
| Headless Unreal process | Execute the same supported authoring operations and recipes through a commandlet adapter; compile, inspect and save named packages | Uses disk state, not another editor's unsaved objects. Coordinate package ownership; do not write concurrently with an editor owning those assets. Per-asset receipts and multi-asset partial-save recovery need fresh-process verification. No editor Undo-stack claim. |
| Without Unreal running or installed | Bounded asset inspection, recipe/patch preparation, schema checking and review of captured graph snapshots | Existing offline readers are useful but incomplete. Mark snapshot freshness and missing fields. Do not claim engine schema validation, asset compilation, evaluation or arbitrary safe binary rewriting. Apply later through a qualified Unreal backend. |

Prefer a shared native authoring service with live-editor and commandlet
adapters, plus MCP orchestration. Advertise capabilities by engine, graph/node
family and execution mode. Do not silently launch a costly headless operation
or substitute stale disk results for live state. Long-running jobs need progress,
completion receipts and cancellation semantics that disclose already-saved work.

## Proposed first complete workflow

Inventory existing general Blueprint writers before adding duplicate tools.
Material graph authoring is already shipped in UEMCP 1.0.24; it is an existing
comparison point, not a future prerequisite. The
[material-function contract](../specs/material-function-authoring.md) and
MaterialGraphAuthoring.cpp provide scalar expression creation, connections,
revision checks, explicit replacement, Undo transactions and separate compile
and save operations. Compare these concrete patterns while implementing AnimBP
editing; extract shared code only where useful. Do not delay animation delivery
to build a universal graph framework or reimplement shipped material authoring.
The material surface remains bounded and rejects edits with the target asset
editor open; do not assume its interaction contract fits live AnimBP experiments.

Current tools.yaml already lists animation reads, montage creation, section and
notify addition; this is not a blank-slate animation implementation. Existing
offline graph enumeration is not full live pin-topology parity.

Prioritize a bounded **interactive AnimBP experiment** in the owned host:
discover and place qualified animation nodes, connect a pose chain, create a
variable and Event Graph update logic, wire its value into animation behavior,
compile, observe the result, Undo/Redo and save/restart. Include an intentionally
incomplete graph, rejected incompatible connection, explicit link replacement,
pin reconstruction and preservation of unrelated authored nodes. Use engine
node-spawning/schema APIs and test actual side effects on the target version.

Then replay the supported edits through the headless adapter and compare the
semantic result in a fresh process. Recipe export/replay can build on that
foundation. Sequence/timeline and montage editing remain independently scoped
feature deliveries; do not postpone them until all graph node families work.

Remaining research gates: full UEMCP writer reuse inventory; installed-version
node action/spawner availability; engine compatibility; headless parity; actual
Undo, persistence, recovery and evaluated-motion tests. No implementation or
runtime acceptance is claimed by this document.
