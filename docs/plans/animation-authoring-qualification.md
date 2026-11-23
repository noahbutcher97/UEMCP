# Animation authoring findings and qualification

This record follows the playable character from input through the evaluated pose. It also tracks the Blueprint write and inspection defects encountered along the way. A passing authoring check requires a read of the resulting Unreal object or an observation of its behavior. Each client result belongs to its actual prompt, engine and tool responses.

## Findings from the baseline

| Finding | Reproduction and consequence | Qualification target |
| --- | --- | --- |
| Misspelled function input | On UE 5.3.2, 5.6.1 and 5.8.4, `NewScale3` was silently dropped. The function compiled and scaled its actor to zero. The valid `NewScale3D` control scaled the actor to (2,3,4). | Reject the invalid input before creating a graph node. Retain valid literals and show available input names. |
| Misspelled variable setter input | On UE 5.8.4 the integer setter accepted `Amount:27` and `Amoun:27`. It compiled and saved both nodes. Executing the functions from a fresh editor set the member to 27 and 0 respectively. | Exercise the same validation through `add_variable_set` and verify the resulting member value. |
| Explicit function owner silently replaced | On all three engines, asking for an inherited actor function on a nonexistent class compiled and executed on self. | Distinguish omitted and unresolved owners. Refuse the latter and preserve legitimate self calls. |
| Non-function graph reported as reusable | On all three engines, asking for a function named `EventGraph` returned successful reuse. The generated class had no such callable function. | Require a function graph and its entry. Verify a real repeated function returns the original entry. |
| Offline node identity could not be used for live reads | On 5.6.1 and 5.8.4 the four GUID words were individually byte-reversed. On 5.3.2 the offline response omitted both GUIDs. Direct live lookup with Unreal's own GUID returned the correct pin values on all three engines. | Pass the saved reader's GUID unchanged into the live inspection tool, including the 5.3.2 fixture. Recover explicitly where a pin block or identity is unavailable. |
| Montage writers accepted unreachable times | All three engines saved a section and notify at 3.833333 s in a 1.833333 s montage. Native export showed neither was linked to a segment. In-range entries retained their sequence links. | Check actual section traversal and notify delivery. Keep timeline validation and its boundary conditions visible as a distinct repair. |
| Inspection produced an unrequested sidecar write | In the 5.8.4 OpenCode trial, `regenerate_sidecar` returned `written=true` during a read-only request. The Blueprint and montage package hashes matched their pretrial values. Some agents also reported intended arguments without proving them. | Rerun the original prompt and compare files as well as the final answer and tool responses. |

The [initial cross-engine checks](asset-backed-graph-actions.md#engine-and-cli-qualification) describe the controlled cases. The [character brief](gameplay-driven-character-animation.md#first-playable-task) defines the gameplay and motion acceptance criteria.

## Additional findings from review and execution

| Input or lookup | What the baseline did | Disposition |
| --- | --- | --- |
| Vector text `(X=2,Y=garbage,Z=4)` | On UE 5.3.2 the MCP write succeeded, the pin read back as `2,0,4`, and invoking the compiled function produced that scale. | Validate complete finite numeric components before calling Unreal’s vector parser. Native controls cover array, positional and named input. |
| Integer text `"0x10"` and `"2147483648"` | On UE 5.6.1 the actual generated setters produced 0 and 2147483647. The decimal control produced 16. | Normalize supported hexadecimal int32 values to decimal and reject overflow before graph mutation. |
| Floating-point JSON number `1e-7` | On UE 5.3.2 the setter stored zero. The text `"0.0000001"` stored the nearest float, 1.0000000116860974e-7. The 1.0 control stayed one. | Retain the original readable spelling when it round-trips at the declared precision. Use sufficient digits otherwise. |
| Bare saved node name shared by three function graphs | `K2Node_CallFunction_0` selected the first export on all three fixtures. | Refuse the ambiguous name, return qualified candidates and accept an exact export index. Graph-scoped live lookup accepts the Unreal GUID or the exact node object name. |
| Text and mount recovery | Inspection read the ordinary string and object slots but omitted Unreal’s separate FText slot. The saved reader also constructed live calls for paths the live Blueprint resolver could not address. | The native test seeds a localized Text default directly on a real K2 pin and reads its display text. The server normalizes project Content paths, returns explicit unavailability for unsupported live mounts, and retains offline inspection. The public attempt to set `Conv_TextToString.InText` in the premise probe returned a literal-input refusal. |
| UE 5.3.2 native fixture teardown | The original combined run crashed with an access violation during garbage collection after the graph inspection assertions. Symbolization located the fixture teardown. | Construct the read fixture directly with Unreal’s graph node creator and contain successful placement transactions within test-owned Undo buffers. The crash and reruns are distinct receipts. |
| Numeric export index at the MCP boundary | All three editor fixtures returned an integer from discovery. Passing it directly to `bp_show_node` failed with MCP error −32602 before the offline handler ran. Direct JavaScript tests accepted the same value. | Both saved node detail and comment selection must accept a positive integer or the existing string selector. The public wire regression uses the discovery result unchanged. |

## Engineering qualification

Each UEMCP-owned project compiled for Win64 Development Editor and ran the `native-blueprint` profile. The profile includes function-graph identity, pin defaults and structure, localized Text inspection, edge behavior and Undo. On each engine the public authoring run made three successful graph writes for explicit scale, inherited self scale and integer assignment, plus the hexadecimal and small-number controls. It reused an existing function entry without duplicating it. The six refused public requests covered misspelled setter and function inputs, a missing explicit owner, a non-function graph collision, int32 overflow and a malformed vector component. The target graph revision was unchanged and the package was clean.

| Engine | Native cases | Public write and independent fresh-editor actor | Discovery → readback on the older saved Blueprint |
| --- | --- | --- | --- |
| UE 5.3.2 CL29314046 | 23/23, two with warnings | Explicit scale (2,3,4), inherited self (5,6,7), integer 27, hexadecimal 16, float 1.0000000116860974e-7 | Both saved literals, numeric export selectors, scoped live name lookup and live GUIDs agreed. |
| UE 5.6.1 CL44394996 | 23/23, one with a warning | Same five observed values, including after restart | Both saved literals, numeric export selectors, scoped live name lookup and live GUIDs agreed. |
| UE 5.8.4 CL58902052 | 23/23, one with a warning | Same five observed values, including after restart | Both native GUIDs matched. The saved reader identified its missing pin data. Live name and GUID reads returned the valid scale and the zero default. |

The warning shared by all three came from the deliberate missing-owner test. UE 5.3.2 also logged a missing optional PCG class during an existing assignment test. The installed engines were 5.3.2, 5.6.1 and 5.8.4. UE 5.7, listed in the packaging matrix, had no editor installation here.

The final default server rotation on source `8c54d2f` passed **9,557 assertions** across 129 files. Nine environment-gated suites were skipped. The three native modules came from `2574451`. The final integration changed the server schema and its public wire test. For each engine, verification compared all 107 deployed source files with the checkout and confirmed the recorded module hash against the installed binary.

## Agent-operated writer

On UE 5.8.4, Codex CLI 0.171.0 first inspected the correct actor but its unattended permissions blocked the edit wrapper. The generated class had no requested function and the monitored files matched their pretrial hashes. With the same task and the UEMCP edit wrapper allowed, Codex tried `Amoun`, read the suggested `Amount` input, connected the setter, compiled and saved. The trial took about 69 seconds and 34 UEMCP requests. Independent actor calls changed 27 to 41 both immediately and after restart. The only monitored file changes were the named Blueprint and its save-generated sidecar. This authoring trial ran on one client and one engine.

## Read-only diagnosis through a real CLI

The prompt named the saved Actor Blueprint, two functions called Valid and Typo, and their intended scale. A complete answer required reading the actual arguments, delivering both values, observing the UEMCP-only instruction and explaining what the evidence established. The correct pair was (2,3,4) and (0,0,0). Each cell below is the final normal-prompt trial on that engine. Provider configuration and project identity recovery count as part of the task.

| Client | UE 5.3.2 | UE 5.6.1 | UE 5.8.4 |
| --- | --- | --- | --- |
| Codex CLI 0.171.0 | Passed, saved pins | Passed, saved pins | Passed, live pins |
| Claude Code 2.1.329 | Stated both in progress, timed out before final answer | Read both values offline and live, timed out without naming the pair | Read both live pins, timed out without stating the pair |
| GitHub Copilot CLI 0.0.369 | Passed after attachment recovery, visual-effect wording imprecise | Passed, caveat about overriding an unlinked literal | Incomplete after 27 calls, stopped before live identity recovery |
| Grok CLI 1.0.70 | Passed, saved pins | Passed, saved pins, overstated the compile evidence | Incorrect, zero calls to the scoped UEMCP server, used native file search |
| OpenCode 2.3.2, GitHub Copilot Claude Haiku 4.5 | Both saved values correct, asserted successful execution without running either function | Passed, saved pins | Incorrect, attributed vectors from search metadata to the two functions |

Full-task passes were **3/5 on 5.3.2**, **4/5 on 5.6.1** and **1/5 on the final 5.8.4 pass**. On 5.3.2 all five communicated both numbers, four in final answers. OpenCode overstated runtime evidence and Claude timed out. On 5.6.1 four clients delivered the pair in final answers. On the final 5.8.4 pass only Codex delivered the correct pair.

The first repaired 5.8.4 pass had two complete, evidence-backed answers, Codex and Copilot. Claude read the values and timed out, OpenCode withheld the values, and Grok bypassed UEMCP. The final pass on that engine had one complete answer, Codex. The per-session variation matters when planning an agent workflow; the missing offline 5.8.4 pin block still requires the client to reach live inspection.

Four further CLIs were attempted on 5.8.4. Gemini CLI 0.68.0 hit an account-tier rejection. Cursor Agent 2026.11.13-eacade1 required login. Kimi 0.76 had no configured model. Antigravity 1.5.9 opened an ACP session and exited with no answer. None issued a UEMCP call. These cases have no engine-specific outcome on 5.3.2 or 5.6.1.

The monitored Blueprint packages and UEMCP JSON sidecars were unchanged across each read-only cohort. A baseline run had produced a sidecar during this task. No participant observed human usability in these trials. [Agent workflow protocol](../agent-workflow-usability.md)

## Playable workflow and outstanding work

A fresh Codex session on UE 5.8.4 created a pawn that could move and acquire a handle. A new PIE session confirmed Idle → Walk at 600 cm/s and cleared interaction when the handle was destroyed. The agent’s character reacquired the handle after stagger while E remained held. Its foot sample did not establish visible gait, and the release sample was taken after the pawn left the floor. The agent reached a concrete placement limit at the upper-body layer, the two pose-space conversions and the configured arm solver. [Playable trial, controls and reproduction](../audits/2026-11-21-playable-animation.md)

On a separately seeded character, the overlay preserved phase-matched lower-body motion, hand tracking below 1 cm/s measured 0.106 cm against 36.03 cm with the solver disabled, and the walking hand missed by 68.02 cm. The 20° turn missed by 3.20 cm, and the sub-centimeter sample arrived after yaw returned to zero. A late montage section extended observed playback to 2.583 s on a 1.833 s source. A late notify never delivered its callback. The agent-authored character, seeded controls and manually advanced montage each have separate acceptance results. [Control measurements](../audits/2026-11-21-playable-animation.md#downstream-controls-on-the-same-engine)

1. **Montage authoring.** Reject unreachable times and qualify exact-end behavior, section linkage, save/reopen and actual delivery of in-range cues. The four playback controls ran on 5.8.4. The saved-asset defect was observed on all three installed engines.
2. **Gameplay-driven pose assembly.** Implement the contextual action probe for asset-backed input and animation nodes. Exercise configured layers, conversions and solver placement through public tools. Replay sustained yaw, reachable moving targets, a grounded stop and stagger with E held on the agent’s character. Then vary the character and reaching hand. [Design and first experiment](asset-backed-graph-actions.md#first-experiment-and-acceptance)
3. **Additional Blueprint surfaces.** Inspect the separate `add_variable_assignment` integer-rounding and vector-formatting paths. Source inspection also found permissive Event Graph substring lookup for unusual multi-page layouts and a function-creation branch that assumes Unreal created the standard entry. Each needs an owned failing control before changing behavior. [Writer boundary and controls](asset-backed-graph-actions.md)
4. **Qualification gaps.** Repeat each agent task on remaining available clients after resolving its recorded blocker. UE 5.7 qualification is deferred until the team revisits that installation. Current animation milestones use UE 5.3.2, 5.6.1 and 5.8.4. Human observation follows agent-driven animation authoring. Each provider result below describes one task and invocation.

The [inspection and montage decision record](animation-inspection-and-montage-decisions.md) follows up on these results with an unsaved graph change, a one-call disk/editor reader, segment bounds, persisted section routing, real callback delivery and fresh agent trials. The subsequent native placement result is recorded in the [graph action experiment](graph-action-experiment.md).

## Float literal range

The integration review reproduced a second precision issue on UE 5.8.4 CL58902052. For a single-precision Blueprint variable, the public setter rejected the JSON numbers `1e39` and `1e-46`, but accepted the same values as strings. Calling the compiled functions on a fresh actor produced positive infinity and zero. The numeric and string controls for `1e-7` both produced 1.0000000116860974e-7. The unit control produced one. The test used a new unsaved Actor Blueprint and independently observed the variable after executing each function.

The repaired writer validates numeric text at the declared pin precision. A nonzero mantissa that underflows the initial double conversion is also rejected. Representable text retains its spelling. The native regression checks rejection before the graph, dirty flag or Undo history changes. It accepts `"1e39"` on a double pin and `"1e-7"` on a single pin.

A separate OpenCode gameplay trial supplied `target_graph` and `value` at the top level of `add_variable_set`. The previous schema discarded those arguments and allowed a different edit. The corrected schema rejects them and names the supported `graph_name` and `params` fields. Its server regression covers the direct tool and mutation dispatcher and checks that rejected calls generate no editor request. The local `2026-11-21-graph-placement` receipt retains the original actor Blueprint, both agent sessions and the failing and passing controls.

Independent review of the first repair identified a compatibility issue at the largest finite float. Both `3.4028235e38` and its negative round to finite float32 limits under the Windows conversion used by Unreal. The UE 5.8.4 public setter rejected both as numbers and as text in that intermediate build. The revised predicate checks whether the narrowed value is finite. The adjacent decimal magnitude `3.4028236e38` rounds to infinity and must still be rejected for both signs.

| Engine | Native and public writer | Codex CLI 0.171.0 through public MCP |
| --- | --- | --- |
| UE 5.3.2 CL29314046 | WriterPinDefaults passed. Eight public overflow and underflow cases refused. Seven executed controls included ±3.4028234663852886e38 in the intended single-precision property | 23 tool calls. Recovered, wired, compiled and left the Blueprint unsaved. Independent invocation produced 1.0000000116860974e-7 |
| UE 5.6.1 CL44394996 | WriterPinDefaults passed. Eight public refusals and seven executed controls matched 5.3.2. The installed engine built the owned fixture using a private build profile | 19 tool calls. Recovered, wired and compiled. Independent invocation produced the same float with no saves |
| UE 5.8.4 CL58902052 | WriterPinDefaults failed on the original baseline and passed on the final repair. The eight public refusals and seven execution controls matched 5.3.2 | 32 tool calls. Recovered, wired and compiled. Independent invocation produced the same float with no saves |

On all three engines, Codex first chose `add_variable_assignment`, which expects a JSON number for this pin. This was a type refusal. On 5.6.1 it tried the second string through that helper as well. All three clients discovered `add_variable_set` and used it to author the valid text. The scripted MCP controls exercised the repaired setter directly. Each installation also rejected the misspelled top-level fields through both public routes and retained the intended graph revision. A discovery follow-up should make the two accepted input forms visible and rerun the same prompt to measure avoidable retries. Raw wire calls, process identities, native results and independent actor observations are retained under `2026-11-21-integration-check`.

The combined server rotation passed 9,610 assertions across 129 files. Nine environment-gated files skipped. UE 5.7 was deferred. A second reviewer checked the finite boundary fix against independent numeric controls, deployed source hashes, native regression results and actor observations on UE 5.3.2 and 5.8.4.
