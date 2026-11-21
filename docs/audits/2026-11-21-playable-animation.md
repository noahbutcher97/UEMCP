# Playable character authoring audit, November 21, 2026

A fresh Codex CLI session built a possessable character that responds to W and E and switches between Idle and Walk. It could not author the upper-body overlay or the procedural arm. The combined gameplay brief remains open. Separate Unreal controls exercised those downstream behaviors and exposed two ways an apparent success can mislead an agent: a sampled hand can miss its moving target while IK weight is one, and a saved montage section can advance playback past the source duration.

## What the client received

The [gameplay design](../plans/gameplay-driven-character-animation.md) gives the complete task and tolerances. The normal public stdio client used an isolated, manifest-verified UEMCP project, UE 5.8.4 CL58902052 on Windows, with plugin/server sources identical between `c15aec3` and design commit `82cd4e6`. These observations describe the baseline before the montage timing repair.

The task folder contained a Character Blueprint possessed by player zero, a skeleton-bound AnimBP with a single Idle player, a compatible mesh, Idle and Walk sequences, and a Reach clip prepared by rotating the right upper arm. The map contained a floor and a moving handle. The fixture assigned the mesh and animation class. The character started without movement bindings, interaction logic, a locomotion machine, a layer or a solver. Separate control assets and instrumentation lived outside the task folder. The agent received the project and task folder, W and E, a named-save boundary and this request:

> Let me walk up to it. While I hold Interact, keep walking, play the reach with my upper body and make my right hand follow the handle. Letting go, losing the handle or being staggered should release the hand. After a stagger, return to the right locomotion for my current speed.

Codex CLI 0.171.0 used 205 completed MCP calls over 178 seconds with no clarification turns. This includes 29 tool searches, 43 descriptions, 35 read dispatches, 95 mutation-capable dispatches, two connection checks and one toolset listing. The dispatch count includes rejected requests. The agent reported a partial result, saved the two named Blueprints, and stopped PIE. No time to a complete playable result or verified variation was obtained.

## Agent-authored character

| Requested behavior | Public action and independent observation | Disposition |
| --- | --- | --- |
| Possess and inspect | Fresh PIE resolved the actual player pawn as `BP_Player_C` and its mesh instance as `ABP_Player_C`. Both named Blueprints compiled and saved. | Starting from a supplied character and mesh passed. Empty-folder asset creation and assignment remain separate. |
| Walk and drive locomotion from actual velocity | The agent authored a `Locomotion` state machine with sequence-backed Idle and Walk. The rules used horizontal speed above 5 and below 3 cm/s. A second editor reopened the saved map and packages. On W, horizontal speed reached 600 cm/s and Unreal's active state changed from Idle to Walk. | Input, speed and saved state selection passed. Four Walk samples of the evaluated foot had identical parent-local rotations in NullRHI. Visible gait remains unverified. |
| Stop on the ground and return to Idle | At the post-release sample, the pawn had crossed the finite floor, reached X 2264 cm, fallen to Z −1965 cm and retained 600 cm/s horizontal velocity. | This run cannot judge deceleration on the ground or Walk → Idle. Extend the floor and sample before and after release with the movement mode. |
| Acquire, follow and lose the handle | The agent polled E and target validity/range. Unreal read `ReachRequested` false → true and a target vector matching the actual moving handle. Release cleared the request. On cold replay the observer destroyed the valid handle *while E remained held and the request was true*. The request became false and its target vector cleared. | Gameplay intention and target snapshot passed. This polling route does not establish asset-backed Enhanced Input event authoring. |
| Upper-body reach over locomotion | The live placement list offered only Two Way Blend. Layered Bone Blend placement returned “Action unavailable for this graph.” The agent did not insert an unmasked Slot as a substitute. | No authored layered performance. The agent successfully used `add_anim_state` for Idle/Walk after bare Sequence Player placement failed. |
| Right-hand procedural tracking | Two Bone IK, FABRIK and the two local/component-space conversions all returned the same placement error on the target AnimGraph. | No authored solver, configured target space, fade or constrained hand. Reading an existing layer or connecting existing pins does not place those nodes. |
| Interrupt and recover | The agent exposed callable BeginStagger and EndStagger entry points. Calling them independently in Unreal cleared reach during the stagger, then the same unbroken E hold reacquired it after recovery. | Stagger flag and immediate cancellation passed. The design requires a fresh press, which the trial prompt did not explicitly request. No gameplay stagger trigger or stagger performance was authored. |
| Agent verification | The agent verified the moving handle in PIE and reported that it found no typed way to press W/E. Its public actor function call encountered an unavailable Remote Control HTTP endpoint. The observer subsequently used public `execute_console_command` with Unreal's `Input.+key E true`, `Input.-key E` and corresponding W commands. | Key simulation was available through a generic public command. Record it in client discovery and qualify release/readback. The independent stagger call used fixture-side Unreal reflection. |

The placement allowlist and cast restrict the action selected by the native handler. The same module serializes existing layered blend settings. [Animation graph implementation](../../plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp) · [Public catalog](../../tools.yaml)

## Downstream controls on the same engine

The fixture seeded a **separate** AnimBP with a speed-driven idle/walk blend, a DefaultSlot overlay filtered at `spine_01` (depth 1), local-to-component conversion, a right-hand Two Bone IK solver, component-to-local conversion and a stagger override. Native fixture code supplied input bindings, gameplay, a moving target and bone observers. Only this control used those implementations.

| Control | Measurement | Result |
| --- | --- | --- |
| Authored overlay, IK disabled | Advanced two instances side by side at 60 Hz with the same walking phase. Compared pelvis, right thigh, calf and foot in parent-local space at 0.267, 0.433 and 0.600 s. Maximum translation difference was 0 cm and maximum angle difference 0.00000242°. The base foot rotation advanced. Upper-arm differences were 101.24°, 102.05° and 102.85°. | The seeded overlay changed the arm and preserved lower-body motion within 1 cm and 2°. |
| Mapped input through a possessed control pawn | Public tools created boolean input actions and a mapping context and mapped E and W. The fixture installed the context and bound callbacks. The local controller received simulated key transitions. J produced zero press callbacks. E requested and released the reach. | Mapped gameplay dispatch passed for the fixture-provided bindings. No hardware or human input was sampled. |
| Reachable moving target at low speed | At speeds below 1 cm/s, disabling the solver produced 36.03 cm hand-to-handle error. Enabling it yielded 0.106 cm. After shifting the moving handle, a subsequent sample measured 0.023 cm. | Enabled control met 2 cm and the disabled control diverged. |
| Reach while walking | At 125 cm/s, walk, overlay and solver weights were all one. The actual hand was **68.02 cm** from the target. | Failed the 2 cm criterion on this trajectory. Next record shoulder-to-target distance and arm length, then repeat with a moving handle kept within reach. |
| Turn while constrained | At the commanded 20° yaw the hand missed by 3.20 cm. By the subsequent 0.099 cm sample, pawn yaw had returned to 0°. | No sustained rotated-space pass. Hold controller and actor yaw through settling and sample both transforms with the hand error. |
| Release, target loss, stagger and recovery | Release and target loss cleared the constraint. With E held at 125 cm/s, interrupt set the full-body override to one, stopped the montage and reduced reach and solve weights to zero. Recovery kept Walk weight one and the interaction off until a fresh press. | Control state arbitration passed. The override used the supplied Idle pose. A distinct authored stagger performance and its blend-out motion still need a clip and bone samples. |

## Montage sections and notifies during playback

Through public tools, create four montages from the same 1.833333 s Walk sequence. Append section `Within` at 0.916667 s and real notify objects at 0.458333 and 1.210000 s. Add a 2.833333 s notify, section, both, or neither as shown below. On a separate AnimInstance, advance 180 ticks at 60 Hz, refresh bones, dispatch queued notifies and record real callbacks, current sections and maximum position observed while Unreal reports playing. Repeat with a runtime `Montage_SetNextSection(Default, Within)` control.

| Publicly authored timeline | Default playback | Explicit runtime link, highest sampled playing position | Callbacks with explicit link |
| --- | --- | ---: | --- |
| In-range control only | Default only | 1.583333 s | 0.458333 and 1.210000 s |
| Late notify only | Default only | 1.583333 s | Both in-range cues |
| Late section only | Default only | **2.583332 s** | Both in-range cues |
| Both late entries | Default only | **2.583332 s** | Both in-range cues |

With default routing, all four runs fired only the first cue and peaked at 0.650 s while playing. The append writer sets the new section's next name to None and the default section also starts unlinked. No public section-link writer was found. Adding sections alone therefore did not produce the multi-section route. The linked control isolated a second effect: the late section extended the sampled playback position past the source duration. The late notify never fired. These are gameplay observations on a manually advanced editor-world AnimInstance. Audio, natural automatic section linkage and playback on other engines were not established by this trial. [Native montage writers](../../plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp)

## Follow-up gates

1. Rerun the timing quartet against repaired writers with unchanged in-range controls and fresh reload. Treat a confirmed bound rejection separately from section routing.
2. Implement discoverable, configurable placement for the layer, conversions, solver and asset-backed actions. Then repeat the same gameplay request against an initially unlayered character, including the fresh-press rule explicitly.
3. Calibrate a reachable walking path, held-yaw control, grounded stop and fresh bone updates under the chosen renderer. Record poses and runtime state for the **agent's** character through release, target loss and interruption.
4. Repeat with another character and reaching hand. Verify Undo/redo, retry cardinality, unrelated-package preservation, cold replay and the required engine/provider matrix. This breadth trial exercised only Codex CLI 0.171.0 on UE 5.8.4. No human trial, second provider, second skeleton, or end-to-end variation ran here.

The raw provider transcript, prompt, public MCP requests/responses, Unreal fixture code, native callback and pose samples, cold-editor trace and exit records are retained in the local report directory `2026-11-21-playable-breadth`. Both editor sessions exited zero.
