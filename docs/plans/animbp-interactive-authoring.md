# Interactive Animation Blueprint authoring

Design for the live editor, 2026-11-19. This is one part of the broader
goal of supporting any animation work a user needs to do with Unreal.
An animator should be able to assemble
and revise an AnimBP a node at a time, including incomplete intermediate edits,
and inspect the resulting motion. The requested scope includes blends, montage
Slots, state machines, cached poses, procedural controls, linked animation
layers and their interfaces, Control Rig, sync markers, inertialization and
pose snapshots. These examples exercise different editing and evaluation
requirements. The [animation program](animation-authoring-program.md) describes
how to extend support to new workflows, including ones outside the AnimBP editor.

## The first working edit

Start with an owned AnimBP containing two compatible pose sources, one wired to
the output. Drive a two-way blend between them from a float computed in the
Event Graph. This small workflow exercises node discovery, typed placement,
editing both graphs, explicit rewiring, deferred compilation and evaluation.
It also exposes the distinction between a graph that compiles and a blend
that actually changes a bone.

For acceptance, author two short owned sequences on one Skeleton. Give a
non-root test bone the same rotation and scale in both sequences and different
constant local translations. Use a fixed sample time and a component running
the target AnimInstance. Drive alpha through the Event Graph at 0, 0.5 and 1.
Measure that bone against the two authored endpoints and their midpoint with
a declared tolerance. Record the class, active instance, frame/tick and
coordinate space. The reference-pose fixture used for the design experiment
can check topology but cannot distinguish those three outputs.

## What the owned editor established

On 2026-11-19 two disposable editor runs used UE 5.8.4 Win64, CL 58902052,
and UEMCP plugin tree `f71e84bc2cef`. In the first run, `get_anim_graph`
with topology and defaults matched a separate native traversal of every pin in
both graphs, including identifiers, defaults and linked pin IDs. The baseline
had four nodes and seven pins. Through MCP, `add_variable` created a float,
`add_event_node` enabled the update event, `add_variable_assignment` connected
its execution pin to a setter with literal 0.625, and `add_variable_get`
placed a getter in the AnimGraph. Deferred assignment reported
`requires_compile=true` and `compiled=false`. Explicit compilation succeeded
with zero errors and warnings. Both readers agreed on six nodes and 14 pins.
The getter was still unconnected; the run established no evaluated motion.

The second fixture added a spare local reference pose. `connect_nodes`
rejected a float wired to the output node's pose input; every inspected pin
and link still matched the baseline immediately before that request. Given a
second compatible pose source for the already occupied input, the same tool
returned success. Both independent readback and MCP showed **two source links
on that input**. The call supplied no replacement policy. Source inspection of
`HandleConnectBlueprintNodes` shows a schema check for disallow followed by
`MakeLinkTo`. The probe measured in-memory topology immediately after the
call; compile and save of that graph were not exercised.

**First implementation step:** reproduce that occupied-input case in a native
regression. Specify how existing callers can request replacement and how the
writer reports any removed edge. An unapproved replacement must preserve the
original edge. An approved replacement must leave exactly the new edge and
support Undo. Check existing ordinary K2 callers before changing shared wiring.

## Editing contract

| Operation | What the caller supplies | What the editor returns or guarantees |
|---|---|---|
| Inspect and discover | Target asset, graph and current selection; optional family or pin-type filter | Complete topology when available. Contextual actions carry their supported graphs, initialization arguments, plugin dependencies and engine support. Distinguish an unavailable action from an incomplete read. |
| Place and configure | An action returned for this graph, position, typed settings and any required asset references | Revalidate the action and referenced assets on the game thread. Return node identity, effective values and the current pin set. A setting that reconstructs pins reports lost or changed links before committing a destructive change. |
| Connect, replace and disconnect | Scoped node/pin identities and expected graph state. For replacement, also name the occupied edge. | Ask the actual graph schema. Report the exact edge delta. Reject stale endpoints, incompatible types, unapproved replacement, implicit conversion or removal of a binding. Expose supported space conversions as visible nodes. |
| Compile, inspect and persist | The edited Blueprint, optional explicit compile, and later an explicit list of packages to save | Distinguish applied edits, compile status and diagnostics, dirty packages and saved packages. Return fresh identities after reconstruction. A failed compile can leave an editable graph. |
| Undo and repeat | One editor transaction per advertised edit or grouped operation | A rejected mutation preserves unrelated nodes, links, bindings and layout. Undo/Redo restores the agreed semantic delta. Read back after a timeout before retrying. Reload the explicitly saved packages in a fresh editor to test persistence. |

Use the existing graph GUIDs, node GUIDs and pin IDs from `get_anim_graph`.
Never infer a pin's continued existence from its display name after a compile.
For multi-package work, return expected dirty packages during preflight,
validate them together before mutation, and report each save outcome. Document
recovery if only some packages save. Keep interactive authoring usable with
the AnimBP editor open. A reusable recipe should compose the same operations.

## Workflows and qualification

Each row is a deliverable with its own runtime evidence. A successful test of a
blend node qualifies that node and its exercised settings. Other families can
reuse the editing contract as their initialization and verification are added.

| Workflow | Editing surface and dependencies | Observable acceptance |
|---|---|---|
| Two-way blend and update logic | Place/configure pose sources and blend, create a variable, wire the update event, connect the getter and pose pins | Read the exact topology and defaults, compile, measure the three bone positions above, Undo/Redo and reopen. |
| Montage Slot and skeletal mask | Insert a Slot for an existing Skeleton slot, retain the input pose and route its output. Configure layered blending and bone filters separately. Reuse existing montage creation/section tools where applicable. | Starting a matching montage changes the expected bones. Locomotion continues on excluded bones in the masked variant. Stop playback and verify the base pose. [Slot contract](u5-animation-authoring.md) |
| State machines and cached poses | Create a machine, entry and states, then directed transitions with separately identified rule graphs. Bind Save/Use Cached Pose by reference. Support repeated uses and validate renames. | A controlled input crosses a rule threshold; report active state, transition and sampled pose. Verify both cache users still resolve after rename/reopen. Reject broken references and cycles. |
| Procedural animation nodes | Begin with Transform (Modify) Bone and Two Bone IK. Validate bone chain, control space, effector target and alpha. Place local/component-space conversions explicitly. | Measure a known bone offset and reachable end-effector target. Test zero alpha, an invalid bone, and preservation of unrelated bones. |
| Animation layers and layer interfaces | Create an Animation Layer Interface and its named layer signatures; implement it in compatible AnimBPs, connect pose/data inputs, set a linked implementation, and support signature changes with caller impact reported. | Switch between two owned implementations and measure distinct poses through the same caller. Reject incompatible signatures or Skeletons. Reload all affected packages and recheck bindings. |
| Control Rig in an AnimGraph | Select a compatible existing rig class, configure hierarchy mapping, exposed controls, input/output pose and alpha. Rig graph authoring and baking require separate asset edits. | Change an exposed control, measure the expected driven bone, and verify pass-through at zero influence. An unavailable plugin or missing control gives a specific failure. |
| Sync groups and markers | Author named markers and times on sequences; configure player sync groups, roles and shared marker names in the AnimBP. Sequence metadata readback already includes markers. | Use clips of different lengths and verify leader/follower phase at known shared markers across several ticks. Exercise missing markers and check each changed sequence after reload. |
| Inertialization | Configure a transition or blend that requests inertial blending, duration/profile and a downstream Inertialization node on the active pose route. | On a controlled discontinuity, compare sampled bone motion with and without the request/consumer pair. Verify decay over time and convergence to the destination. |
| Pose snapshots | Capture a distinctive runtime pose; configure named or supplied snapshot playback with a compatible mesh, AnimInstance and LOD. Keep capture lifetime distinct from asset saving. | Capture pose A, drive the live source to B, then select the snapshot and measure return to A. Exercise a missing snapshot; reopen and verify authored configuration, then capture anew. |

## Implementation sequence

1. Qualify the first blend workflow end to end on UE 5.8.4 using a UEMCP-owned
   host. Inventory reuse per operation. Add only the actions or safeguards
   demonstrated missing. Test with the editor open and with an intentional
   compile error. Verify Win64 packaging and exercise the workflow on 5.3.2
   and 5.6.1 before claiming those versions.
2. Extend the same pose-routing operations to Slot insertion, then add nested
   state/rule graph identities and cached-pose references. These are natural
   next uses of the same fixture once it has playable animation.
3. Use focused fixtures for procedural controls and rig inputs, and a
   multi-asset fixture for layer interfaces and linked implementations.
   Sequence marker editing can proceed independently once its timeline and
   player fixtures exist. Add temporal tests for synchronization,
   inertialization and snapshots as each feature lands.
4. Replay supported edits with a headless Unreal adapter and compare fresh-load
   results. Record capability by engine, graph kind, node family and operation.
   Add new node families through action discovery, typed initialization and
   family-specific tests. Preserve ad hoc composition as the catalog grows.

The installed UE 5.8.4 source provides concrete starting points.
`UAnimGraphNode_Base::GetMenuActions` and `UBlueprintNodeSpawner::Invoke`
expose placement APIs. When `UAnimationGraphSchema::TryCreateConnection` accepts
a connection, inspect displaced edges and bindings. Changing a two-way blend setting
can reconstruct pins. `UAnimGraphNode_UseCachedPose` references the save node,
and `UAnimGraphNode_LinkedAnimLayer` tracks interface identity. Control Rig's
graph node lives in its own plugin. These are source findings; the fresh
implementation session must exercise each API in the graph context it advertises.
