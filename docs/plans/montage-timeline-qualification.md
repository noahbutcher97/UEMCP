# Montage timing and section routing

## Boundary experiment

The public MCP writers authored six montages from the same 1.833333373 s Walk sequence in an owned UE 5.8.4 editor (CL58902052). Each had an in-range cue at 0.458333343 s. Each variant also had one section or one cue at the source end minus one 60 Hz step, exactly at the end, or plus one step. All six calls succeeded on the original plugin. A new editor loaded the saved montages. The fixture advanced an AnimInstance for 180 steps, refreshed its bones, dispatched queued notifies and recorded callbacks from a real UAnimNotify subclass. It measured native playback first with the authored blend-out and again with a zero blend-out.

| Requested edit | Result on the original plugin |
| --- | --- |
| Cue at 1.8166667 s | Fired with the original blend-out and with zero blend-out. |
| Cue at 1.8333334 s | Fired only with zero blend-out. The earlier control cue fired in both cases. |
| Cue at 1.8500000 s | Writer accepted and saved it. It never fired. |
| Section at 1.8166667 s | An explicit runtime link reached this position. The final section was too short for the 60 Hz sample to establish sustained traversal. |
| Section at 1.8333334 s | It started at the end of the last source segment and had zero playable span. |
| Section at 1.8500000 s | Playback with an explicit runtime link reached 1.85 s on the 1.8333334 s source. |

The earlier [playable animation audit](../audits/2026-11-21-playable-animation.md#montage-sections-and-notifies-during-playback) used a larger overrun and independently demonstrated the missing route with two in-range callbacks.

## Public contract

- `add_montage_section` accepts a unique, non-None name at an unoccupied start in the half-open source animation interval. It links the section to an actual segment and sorts sections by time. Existing routes retain their destinations. A new section initially ends playback.
- `add_montage_notify` accepts an instantaneous cue from zero through the last covered animation time, inclusive. It obtains the trigger offset from the engine. Delivery near the end also depends on montage blending and runtime playback. A notify state retains its 0.1 s duration. Both endpoints must link to real source segments and the interval must have animation coverage. Touching segments may belong to different slots.
- `set_montage_next_section` sets the outgoing destination for one section. The caller supplies the existing source and destination names. A self-link loops. An empty destination ends the route. An unknown name is an error; retrying the current destination reports `changed=false`. The result includes the previous and resulting destination. Real edits participate in Unreal Undo. The caller chooses when to save.
- `get_montage_full` reports the stored section names, times and routes. Its `next_section` field uses Unreal’s `None` spelling for the end of a route.

The writers derive time bounds from the montage slot tracks and verify actual segment coverage. For a section, the time at Unreal float precision must still precede the segment-derived montage end. For instantaneous cues, an exact-end time represents an authored trigger and carries no guarantee that a specific playback will deliver a callback. In particular, an existing interrupted montage, a near-zero final blend weight or a route that skips the cue may suppress delivery.

## Repair qualification

On UE 5.8.4 CL58902052, the repaired writer rejected negative and after-end cues, a section at the exact end, duplicate section times, and a state extending beyond the last source segment. Unreal text export identified the source sequence independently for the section and notify links. One native regression reproduced a second failure on the intermediate writer. The state began on one slot and ended on another with 0.04 s of missing source animation. The earlier writer accepted it. The repair rejected the gap, accepted adjacent cross-slot segments, preserved clean rejected edits, and passed route Undo/Redo and notify Undo.

A new editor replayed the saved montages on the native AnimInstance without an override. With Default linked to Within, the sections played in order and callbacks fired at 0.458333 s and 1.210000 s. Clearing the link left Default terminal and only the first cue fired. A self-linked Within repeated its 1.210000 s cue. The repaired exact-end cue used Unreal’s native trigger adjustment (1.833233 s for the 1.833333 s authored time). It delivered its callback with both tested blend-out settings. These measurements cover an editor-world AnimInstance with a 60 Hz update and the supplied notify subclass. Networked play and other blend policies require their own observations.

A fresh Codex CLI 0.171.0 session received a montage with two cues and a disconnected second section. The task included the misspelling “Withinn”. The client recovered from an initial editor identity refusal, found the real section Within, authored the link and saved only the named montage. It used 22 UEMCP calls in about 65 seconds and accurately distinguished configured cues from runtime delivery. Independent immediate and fresh-editor playback both traversed Default then Within and delivered the two callbacks. Hashes showed one changed montage package and no other monitored file changes.

To reproduce native acceptance, run the exact automation filter `UEMCP.Animation.MontageTimeline` against a UEMCP-owned editor project. The focused MCP server suite is `node server/test-m5-animation.mjs`. The local montage-boundaries report retains public requests, editor identities, exports, real callback observations, CLI receipts and the failing intermediate coverage regression. This experiment qualified UE 5.8.4 and Codex. Further engine and provider runs should identify their own controls and results.

Persona reads each notify class's default trigger weight and calls its editor creation hook in `SAnimNotifyPanel.cpp`. The MCP writer initializes the event directly. The fixture cue and built-in timed state exercised here do not establish how a custom notify that overrides either method behaves. That case needs a custom class and an editor-created control.

The standalone server rotation on the montage branch passed 9,566 assertions across 129 files. Nine environment-gated files skipped. The source inventory included the new native test, and the all-enabled MCP tool inventory included the route writer.
