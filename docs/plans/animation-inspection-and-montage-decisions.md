# Blueprint input inspection and montage editing decisions

## Inspecting the graph a player is about to use

A saved Blueprint can compile and still contain the wrong input. Its open graph can also diverge from the file. In the owned control, both call nodes were named `K2Node_CallFunction_0`. A fixture changed only Valid’s unlinked scale input from (2,3,4) to (7,8,9) in memory. An independent native observer read the actual nodes, GUIDs, links and dirty package before and after. The Typo control stayed at (0,0,0). The package hash stayed the same and the initial value returned on cold load.

On UE 5.8.4, the earlier saved-reader → live-reader handoff gave Codex enough evidence to report the open values and the unknown saved literals. In a separate session, OpenCode read both live values but concluded that the file and editor agreed. The saved package reader had not decoded either input. Increasing the verbosity of that handoff would still leave each client to join two observations and decide which source supports each claim.

**Decision.** Provide one discoverable read operation, `inspect_blueprint_inputs`. The client supplies the Blueprint, graph, and optionally the function member and input name. Identify the selected saved call, return alternatives for ambiguous selections, and attach the current editor observation only after verifying project and node identity. Each source reports its own availability, links and stored values. A disk-only request must work without editor contact. Raw graph inspection remains available. A stored default beside a wire cannot establish the value delivered over the wire. Execution and evaluated motion need independent observations. [Inspection contract](../owned-blueprint-query.md)

## Authoring and playing a montage

**Decision.** Define the editable time range from the actual animation segments. A section needs playable time remaining. An instant notify may sit exactly at the end of a covered segment, and Unreal’s trigger offset must be preserved. A notify state needs continuous coverage across its full duration. Adding a section keeps the existing route intact. Change that route explicitly with `set_montage_next_section`. An empty destination makes the section terminal. Repeating a successful link should report that there was no change. Reject invalid edits before recording an Undo step.

The release check is a named save followed by a new editor that reads section links and runs natural playback. It samples section traversal and real notify callbacks. Separate controlled runs exercise default and zero blend-out so an endpoint cue cannot earn a pass solely from a stored timestamp. [Montage experiments](montage-timeline-qualification.md)

## Placing gameplay and animation graph actions

**Decision.** Keep one public discovery/placement design with explicit action-family handling. On UE 5.8.4, the native registry and graph filter could select two input actions or two sequence assets with the same name, but display text and the native action signature did not distinguish those assets. Preserve exact asset identity and re-resolve the current registration owner. Treat the empty player as a separate choice. Check for an existing binding before placing an input event. The cold spawner reused a node while the warm spawner could create another one. Validate the resulting asset reference and pins, and record saved graph identity for retries. The first probe placed these nodes natively and read them back after reopening. Public action placement, held input driving the pawn, and evaluated motion are the next authoring milestone. [Native placement experiment](graph-action-experiment.md)

## Qualification

Three UEMCP-owned fixtures ran the integrated native plugin. For each fixture we checked the engine manifest, editor and build executable, deployed source and module, and observed the saved assets in a fresh editor. The integrated server rotation at `97ec3f4` passed 9,602 assertions in 129 files. Nine environment-gated files skipped. The following editor and client runs were performed separately.

| UE version (changelist) | Blueprint inspection | Montage editing and observed playback | Native action placement |
| --- | --- | --- | --- |
| 5.3.2 (29314046) | Both saved and open inputs read correctly, including the deliberately unsaved edit | Native regression passed. Endpoint cue, section routing, save/reopen and Codex recovery passed | Unexercised |
| 5.6.1 (44394996) | Both saved and open inputs read correctly, including the deliberately unsaved edit | Same native regression, endpoint, routing, save/reopen and Codex recovery passed | Unexercised |
| 5.8.4 (58902052) | Both open inputs read correctly, including the unsaved edit. The reader returned `pin_data_unavailable` for the saved inputs in this package | Same native regression, endpoint, routing, save/reopen and Codex recovery passed. An additional fixture replayed a self-link | Exact source selection, placement, filtering, repeat behavior and cold readback exercised |
| 5.7 | Deferred at the owner's request | Deferred | Deferred |

**Montage observations.** Before the fix, the UE 5.8.4 endpoint cue fired with zero blend-out only. After the fix it fired under both tested blend settings on all three engines. A section just before the endpoint appeared as the currently playing section with zero blend-out only. The native regression exercised section/link Undo and Redo, duplicate starts, endpoint rejection for sections, and uncovered times including a gap between slots during a notify state. On each engine the 1.833333 s montage fired only its 0.458333 s cue when Default was terminal. Linking Default to Within delivered a second callback at 1.210000 s. Clearing the link restored the single callback. A new Codex session per engine recovered from an unknown destination and saved the requested link. Fresh-editor playback delivered both callbacks and only the named asset changed on disk. The integrated observer stepped an editor-world skeletal component at 120 Hz. Possessed gameplay and custom notify creation hooks require separate trials.

**Inspection limits.** The stored call identifies the member used to select the node. The deployed editor reader can confirm the graph, GUID, call-node class and visible inputs. It does not report the current member reference, implicit receiver or live split/default flags. Two-read joins also check pin identity and graph revision. A default, a wire, and a prior successful compile leave the value actually evaluated during play unknown. Saved split/ignored-default regressions use generated packages and simulated wire controls. The native comparison used unsplit pins.

### Agent workflow results

An agent in each installed CLI received an ordinary-language task naming the asset and two graphs. It had to discover the inspection tools and report the inputs, evidence source and limits. A second prompt explicitly requested the saved and current editor values during an unsaved edit. A full pass required evidence for both values, a defensible answer about compile and runtime, and use of the permitted read-only UEMCP workflow. Each cell below represents one final session. No human participant took part.

| Client | Clean 5.3.2 | Clean 5.6.1 | Clean 5.8.4 | Dirty 5.3.2 / 5.6.1 / 5.8.4 |
| --- | --- | --- | --- | --- |
| Codex 0.171.0 | Pass | Pass | Pass | Pass / Pass / Pass |
| Claude Code 2.1.329 | Pass | Pass | Pass | Unexercised |
| GitHub Copilot CLI 0.0.369 | Pass | Pass | Partial, predicted runtime collapse | Unexercised |
| Grok 1.0.70 | Pass | Failed, used local files and guessed | Failed, used local files and guessed | Unexercised |
| OpenCode 2.3.2 (Copilot/Claude Haiku 4.5) | Pass | Pass with an unsupported aside about compiled values | Partial, asserted runtime effect | Partial / Partial / Partial |

On the reviewed code, 13/15 clean sessions reported both numbers from tool evidence and 11/15 completed the full task. All six dirty sessions obtained both live values. Codex qualified the saved/compiled uncertainty in all three. On 5.3.2 and 5.6.1 OpenCode overclaimed compiled state or the effect of saving. On 5.8.4 it inferred a disk mismatch from unreadable input data and suggested saving the dirty asset. No final trial invoked an MCP mutation. All six monitored before/after package and sidecar comparisons were unchanged.

Before the discovery and permission changes, 14/15 clean sessions obtained both numbers and 9/15 completed the task. The dirty results were 6/6 for both numbers and 3/6 for the full answer. Two clean sessions compiled the Blueprint despite the inspection-only prompt. Grok on 5.6.1 retried through the mutating dispatcher after a read-dispatch refusal. OpenCode on 5.8.4 invoked a directly registered compiler. The wire captured both calls even though the monitored files remained unchanged. Discovery now identifies the required dispatcher, and the client guidance describes named read permissions for direct tools as well as dispatchers. OpenCode used that narrower configuration on the final runs.

**Follow-up for provider workflows.** Preserve this dirty fixture as a repeatable agent task. Rerun Copilot and OpenCode against the uncertain saved and runtime cases after changing how the result presents these limits. Grok's empty built-in tool option still allowed local file reads. Two extra UE 5.8.4 sessions confined it to discovery and invocation, and both reported that inspection had failed. In one, a broad read denial blocked search. In the other, discovery returned unrelated or empty results. Resolve UEMCP discovery in that client and require a successful wire read before crediting any conclusion. Four additional 5.8.4 clients reached no UEMCP call. Gemini hit an account-tier restriction, Cursor required authentication, Antigravity ACP exited without an answer, and Kimi had no model configured. Human usability follows agentic qualification.

The local receipt `2026-11-21-inspection-design` retains the independent native reads, source fingerprints, prompts, permissions, client replies, wire traces and per-trial grading in `INSPECTION-CLI.md`. For the next animation milestone, implement the public asset-specific action selection and placement, then verify a held player input through the pawn and independently measure the authored and procedural motion on one character. [Gameplay-driven character animation design](gameplay-driven-character-animation.md)

## Order of work after qualification

1. Review the integration branch. Recheck the supported inspection-only configuration against both direct compile and dispatcher routes. If a supported read path permits an editor mutation or the tool reports an unread value as observed, repair it and rerun the original task before merging the affected change.
2. In parallel, start public graph action placement with the reproduced warm-editor duplicate binding. Make retry, exact asset identity, Undo and cold readback acceptance conditions for that feature. Then run the mapped-input reach on one character and measure authored and procedural motion through release and interruption.
3. Track provider interpretation and discovery failures against the recorded prompts alongside animation development. A failing client/engine combination remains open in the qualification table. A workflow depends on that result when claiming support for that combination. Keep human trials after the agent-driven animation milestone and UE 5.7 deferred.
