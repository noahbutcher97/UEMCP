# U5: bounded AnimGraph authoring

Status: proposed first implementation slice, scoped 2026-11-07. No authoring
tool has been implemented or live-qualified by this scoping pass.
Parent: [roadmap U5](../../tasks/plan.md). Existing readback remains shipped.

## User outcome

Insert a named Slot node into an existing AnimBP pose edge, preserving the base
pose route so montage playback can use the slot. This is a useful first edit
without requiring state-machine construction, animation import or arbitrary
graph rewriting. It prepares montage routing; it does not create or play a
montage, configure gameplay triggers or promise a particular visual result.

Before: `existing pose source -> existing destination`.
After: `existing pose source -> Slot(existing slot name) -> existing destination`.

First supported scope: an existing, writable, non-template AnimBlueprint with
an existing Skeleton, in its top-level AnimationGraph, on one direct local-space
pose edge. Reject child/inherited graphs, linked layers, state/transition graphs,
reroute nodes, bound pins and component-space conversions in this slice.
The selected slot must already exist on the Skeleton; use FName-compatible
comparison. Creating slots/groups or changing the Skeleton is separate scope.

## Proposed tool contract

Working name: `insert_anim_slot`. Final naming follows `tools.yaml` conventions;
do not advertise a tool until its implementation and qualification land.

- Required identity: asset path, graph GUID, source node GUID/pin ID,
  destination node GUID/pin ID, expected graph revision and existing slot name.
  Use identities from a complete current `get_anim_graph` topology read.
- Optional node position affects layout only. No implicit asset creation,
  automatic saving, fuzzy title lookup, arbitrary class path or Python escape.
- Support a non-mutating preview of the exact removed edge, two proposed edges,
  slot and affected asset. Apply rechecks all conditions in the same game-thread
  operation; preview alone never authorizes stale topology.
- Define an opaque revision token over the relevant graph topology, slot
  properties and binding state. Re-read/re-resolve IDs after compilation or
  reconstruction; do not promise pin-ID stability that has not been tested.
- Return separate mutation, compilation and persistence outcomes, changed node
  identity, before/after revision and compile diagnostics. A requested compile
  is not evidence it passed. Saving is explicit through the existing save path.
- A stale/repeated request fails without another insertion. Following a timeout,
  inspect the graph before retrying; transport failure is not proof of rollback.

## Implementation constraints discovered from source

`AnimationHandlers.cpp` already serializes graph GUIDs, node GUIDs, pin IDs and
topology completeness. Reuse that vocabulary and scoped readback verification;
do not build a second graph identity scheme. A revision token is additional work.

The installed UE 5.8 engine source shows:

- `Editor/AnimGraph/Private/AnimationGraphSchema.cpp`,
  `TryCreateConnection` and `DetermineConnectionResponseOfCompatibleTypedPins`:
  pose connections can replace existing links; connection also removes input
  bindings. Therefore reject bindings and require the selected edge to be the
  only connection at both endpoints. Verify the complete resulting edge delta.
- `Editor/AnimGraph/Private/AnimGraphNode_Slot.cpp`,
  `BakeDataDuringCompilation`: compilation calls Skeleton `RegisterSlotNode`.
  Require an existing slot and prove Skeleton data/dirty state is unchanged.
- `Editor/AnimGraph/Public/AnimGraphNode_Slot.h`: Slot has a typed
  `FAnimNode_Slot` payload; use the typed editor node and animation schema.

The public [animation-schema API](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Editor/AnimGraph/UAnimationGraphSchema)
confirms the dedicated schema. Generic K2 helpers are reusable only after their
assumptions are checked against animation-specific behavior.

Use one editor transaction with `Modify` on every affected existing object and
transactional new-node creation. Preflight before opening it. Treat rollback as
an explicit implementation requirement: cancelling a transaction alone is not
proof that object mutations were restored. Inject failure between connections
and verify restoration without consuming an unrelated user Undo entry.

On compile failure, never report completed success or save. Return explicit
applied-but-compile-failed state with diagnostics if the graph remains changed,
and preserve one-step Undo. Do not promise compile-side-effect rollback until
proven; unexpected extra-asset mutation blocks release of this bounded contract.

## Delivery slices and gates

| Slice | Deliverable | Required evidence |
|---|---|---|
| U5.1: fixture and preflight | Owned minimal Skeleton/AnimBP, existing slot and direct pose route; identity/revision validation and preview | Independent graph oracle; invalid/stale IDs, unknown slot, bound pins, unsupported graph/type and ambiguous links cause no mutation or dirty-state changes. |
| U5.2: insertion and results | Typed Slot insertion with exact edge replacement, transaction and truthful compile result | Exactly one new node, one removed edge, two new edges; unrelated graph/Skeleton unchanged; injected second-link failure restores baseline; real compile-failure result tested. |
| U5.3: public surface and lifecycle | Tool schema/registration, documentation, MCP runner and fresh-process verification | MCP-to-native operation, successful compile, Undo removes node/restores edge, Redo restores edit; explicit save/restart retains exact result; invalid/repeated request creates no duplicate. |

These slices form one feature dependency chain. Keep incomplete internal work
unadvertised until U5.3 passes. Likely areas: animation handlers and shared graph
identity helper, native animation tests/owned fixture, `tools.yaml`, generated
registration and server tests, owned lifecycle runner. Avoid unrelated Blueprint
handler refactoring. Use the established generator rather than hand-editing its
outputs; identify the exact focused commands in the implementation handoff.

Run `npm test` for the server/tool surface, compile the plugin and run focused
native positive/negative cases, then run the owned MCP lifecycle runner serially.
Start qualification on UE 5.8.3; other engine/client combinations remain explicit
gaps until tested. No external projects. Fixture creation must not require
consumer animation content or silently enable Python. Clean owned outputs after
preserving concise source-bound receipts.

## Next choices, not bundled requirements

After this workflow: update an existing Slot property; insert a selected blend
node; sequence-player assignment; then state/transition authoring if requested.
Each has different typing, Skeleton compatibility and persistence requirements.
Control Rig, retargeting, arbitrary node creation, bulk graph import and runtime
pose evaluation are separate units of scope. U4 Chooser support is not a blocker.

Before implementing, inspect Epic's current toolset and the most relevant peer
implementation for a reusable equivalent. Compare validation, identity,
transactions, failures and lifecycle proof, not advertised tool counts. A native
API or adapter that satisfies this contract is preferable to duplicating it;
the current research pass does not establish that such an equivalent exists.
See [ecosystem watch](../tracking/ecosystem-watch.md).
