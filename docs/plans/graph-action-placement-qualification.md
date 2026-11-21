# Public graph action placement

The starting failure was observable on UE 5.8.4 CL58902052. In a warm UEMCP-owned editor, invoking the same spawner twice for one pawn and one Input Action produced two event GUIDs. A prior cold editor had returned one. The regression asserts graph membership and the observed bound asset independently of the node the spawner returned. [Native placement experiment](graph-action-experiment.md)

## Scope

The public operations support Enhanced Input events in a writable pawn Event Graph and Sequence Players in a concrete top-level AnimGraph. A client can search by phrase or exact asset path, then place from the result's graph GUID, topology revision and session action ID. Each result reports the observed asset and pins. A repeated exact event binding should reuse one node without adding an Undo transaction. A deliberate second placement of a Sequence Player should create a second node. A lost response requires checking the exact-source node list. The legacy input event and two-way blend keep their original interfaces. [Caller contract](asset-backed-graph-actions.md#using-the-public-operations)

## Reproduction and independent acceptance

Use a new UEMCP-owned project and verify its engine manifest. Prepare two same-named Boolean actions and two same-named sequences in separate folders. Map the right action to E with a hold trigger and the left action to J. Start each authoring task with an ordinary pawn Blueprint, and an AnimBP whose output is connected to the left (Idle) player. A second AnimBP directly plays the right (Walk) clip as an independent control.

Give a real client just the project, the named Blueprints and requested outcome. Ask it to set a Boolean while the right action is held, clear it on release or cancellation, switch the AnimGraph output to a new player for the right clip and keep the old player. Authorize compiling and saving only the two named Blueprints. Retain the prompt, version, calls, response and changed packages. The fixture supplies the input mapping and possession. The client must author the event and its wiring.

Reopen in a different process. Read actual graph membership, bound asset paths, pin GUIDs and reciprocal edges. Possess the saved pawn in PIE, activate the mapping, send the unrelated key, a sustained mapped key and a short press/release. Sample the pawn's Boolean independently. Evaluate the saved AnimBP and both control poses at six fixed times, sampling both the left leg and the right arm in parent-local space. Record graph and behavior outcomes separately.

For the native cases run `UEMCP.GraphActions.AssetPlacement` and `UEMCP.BlueprintHandlers.PawnGraphGuidWiring`. The former exercises event reuse and repeated Sequence Players. The latter exercises GUID round trips through the existing connection, inspection and disconnection handlers. The local report `2026-11-21-graph-placement` retains fixture code, launcher, per-run version and source fingerprints, and raw trial and playback evidence.

## Results

| Client or control | UE 5.3.2 CL29314046 | UE 5.6.1 CL44394996 | UE 5.8.4 CL58902052 |
| --- | --- | --- | --- |
| Scripted public MCP | Pass | Pass | Pass |
| Codex CLI 0.171.0 | Pass · 88 s / 58 calls | Pass · 78 s / 59 calls | Pass · 82 s / 51 calls |
| Claude Code 2.1.329 | Pass · 169 s / 39 calls | Pass · 170 s / 46 calls | Pass · 178 s / 41 calls |
| OpenCode 2.3.2 | Pass · 118 s / 58 calls | Pass · 106 s / 50 calls | Pass · 185 s / 64 calls |
| GitHub Copilot CLI 0.0.369 | Failed · 17 s / 0 calls | Failed · 14 s / 0 calls | Clip only · 95 s / 41 calls |
| Grok CLI 1.0.70 | Failed · 88 s / 35 calls | Failed · 64 s / 24 calls | Failed · 112 s / 57 calls |

Each cell grades the original plain-language task in one real CLI session. A pass requires the requested input behavior, one correct binding, the requested walk at the output, retention of the old player and changes limited to the two named asset packages. Time measures the CLI invocation. A call is a public MCP tools/call request in its wire trace. Package comparisons cover .uasset, .umap and their payloads. Fixture creation, restart and independent evaluation are outside those timings. UE 5.7 was deferred. Human participants have yet to exercise this task.

The scripted saved walk matched the right-side control at all sampled times. The largest angular differences from the old idle control were 39.43°, 39.43°, 39.43° in engine-version order.

### What the editor checks

The warm duplicate reproduced as two distinct Enhanced Input event GUIDs for one pawn and one action. The public repair reuses the existing GUID after rediscovery. The native regression also covers Undo/Redo, refusal of a stale revision, a changed sequence skeleton, malformed event pins and ambiguous pre-existing bindings. A separate regression checks connection, inspection and disconnection using the pawn's graph and pin GUIDs. The MCP control deliberately places a second player for the same clip and verifies both GUIDs. The real-client task asks for one new player.

The independent observer starts a new Unreal process, possesses the saved pawn in standard PIE and sends key events through its player controller. In passing runs the observed flags were false initially, false for J, true for held E, false after release, true just after a short press and false after cancellation. The saved AnimBP is evaluated on a skeletal mesh in the editor world. Motion acceptance requires the old player to remain, a single reciprocal connection from the new player to the output and sampled rotations matching the requested walk control. These tests exercise the pawn and AnimBP separately.

### Disabled or differently owned bindings

Independent review reproduced a second kind of false reuse on UE 5.8.4. The original handler accepted an existing Disabled, DevelopmentOnly or Enabled event with the same asset. After compile, an independent delegate count was 0, 3 and 3 respectively in that editor. DevelopmentOnly can therefore look functional in the editor while depending on build configuration. The first native regression failed five assertions against the old implementation. Exact-source discovery now reports `compile_mode`. Reuse requires Enabled. A refusal includes the event and graph GUIDs, leaves the designer's setting intact and preserves graph membership, dirty state and Undo history.

Another regression caught misleading advice about a same-asset event on another page. Enabling it would still leave it on the wrong graph. Two assertions failed on the intermediate build. The amended error directs the caller to inspect the matching graph when ownership differs. The caller can decide how to handle the existing binding before making another edit. [Implementation and diagnostics](../../plugin/UEMCP/Source/UEMCP/Private/GraphActionAuthoring.cpp)

### A false success found through OpenCode

On UE 5.8.4, OpenCode 2.3.2 selected the correct action, wired its execution pins and reported success. It passed `value: "true"` at the top level of `add_variable_set`. The server silently dropped the field. The saved Boolean input was false and the possessed pawn stayed false throughout the key sequence. Correct the call by passing `params: { Interacting: true }` with `variable_name: "Interacting"`. Unknown top-level setter arguments now return an error through both direct and dispatcher calls. Omitting a literal remains valid when a wire supplies the value.

An identical input-only prompt on a new pawn in the same project passed after the change. The run took 107 seconds and changed only the named pawn package. A cold process confirmed one exact event, the six expected flag observations and stable content-package hashes during playback. The original run took 86 seconds. These are single runs. The local report retains both prompts, traces, saved graphs and possessed-pawn observations.

### Client friction and recovery

Copilot on UE 5.3.2 initially attempted local filesystem access, made zero UEMCP calls and returned manual instructions. Adding one discovery hint led it to author the correct clip and bind the correct action. Its `Canceled` link cleared an early tap, but a fully triggered hold stayed true after release. Cold graph readback showed `Completed` unconnected. On receiving that specific gameplay observation, Copilot fixed only the pawn. The next cold replay passed input and retained the correct motion. Copilot's initial UE 5.8.4 task independently produced the same missing link. The server now explains the three outputs for a repeating hold in placement help and in successful Enhanced Input placement results.

Copilot's UE 5.6.1 session also made zero UEMCP calls. On UE 5.8.4, the identical unguided task after the help change again selected filesystem tools and made zero UEMCP calls. A guided attempt reached the new hint and missed `Completed` again. The pawn stayed false during the hold and the animation continued to match idle. Thus the hint is discoverable and the fresh client workflow still fails. Preserve both pre-change and post-change trials. For future agent-facing feedback, verify the saved trigger edges and selected animation path before accepting a completion claim. The primary receipts include the requested and actual asset paths, actual pins, final CLI answer and cold replay.

Grok on UE 5.3.2, 5.6.1 and 5.8.4 reported successful mutation and verification. On all three runs, the two named asset packages were unchanged, the pawn had no flag or binding, and the old idle still drove the output. The UE 5.3.2 transcript contains public discovery and inspection calls, including a successful request to enable the write toolset. Independent object and motion checks are necessary to grade these answers. Retain these prompts for the client discovery and completion-reporting follow-up.

Four other local clients received a read-only access task on the owned UE 5.8.4 editor. Gemini 0.68.0 reported an ineligible account tier, Cursor Agent 2026.11.13-eacade1 required authentication, Kimi 0.76 reported no configured model and timed out, and Antigravity 1.5.14 opened an ACP session and exited without an answer. All four recorded zero UEMCP calls. Their authoring and other engine combinations remain unexercised. The original dirty-inspection trials and their distinct outcomes are in the [inspection qualification](animation-inspection-and-montage-decisions.md#agent-workflow-results).

### Follow-up

Audit other public Blueprint writers that accept optional fields through a permissive schema. Start with a plausible mistaken payload from a normal client. Compare the response, saved pin or property and actual behavior before changing the contract. The confirmed top-level correction is scoped to `add_variable_set`.

The next character task carries the pawn's held state into its mesh AnimInstance, proves the lower-body locomotion survives the authored upper-body overlay and measures a procedural hand reaching a moving target. Replay release, cancellation and stagger interruption on the same possessed character. The design specifies the controls and measurement spaces. Human sessions follow agent-driven character acceptance. [Gameplay-driven character design](gameplay-driven-character-animation.md)

## Qualification boundaries

The feature and the reviewed Blueprint/montage integration are on local task branches. The [integration qualification](animation-authoring-qualification.md) records the three-engine scalar setter repair, direct and dispatcher checks, Codex recovery and independent actor observations. The public graph placement regression and real-client sessions above establish the separate input and clip milestones. The normal CLI trials ran during development. Final native and public MCP replays are reported by source revision below.

The named Codex and Claude results are tasks run by agents operating installed clients. The scripted MCP controls, native automation and independent editor observations use separate callers. Gameplay checks use a fixture-supplied mapping context and possession. The clip check evaluates the saved AnimBP independently of the pawn flag. The combined gameplay-to-animation reach and real human usability remain open.


The final implementation and native tests at `46e2dd2` passed on installed UE 5.3.2, 5.6.1 and 5.8.4. Each owned editor passed both native filters. A new pawn and AnimBP on each final binary passed the public MCP placement, explicit replacement, reuse and repeated-player controls. A separate cold process reproduced the expected input flags and matching walk rotations. Per-engine deployment fingerprints and actual values are in the local `qualification.json` receipt.

At `46e2dd2`, a separate Codex CLI 0.171.0 session on UE 5.8.4 recovered from two editor identity errors and completed 24 public calls. It reported the correct disabled binding refusal and enabled reuse by GUID. An independent observer found 0, 3 and 3 generated input delegates for Disabled, DevelopmentOnly and Enabled, and identical graph rows and package hashes before and after the trial. Cross-graph recovery was also tested in native automation on all three engines.

An intermediate UE 5.3.2 headless wiring run exited with an access violation in an Unreal background worker before exporting its result. The final source passed that wiring test and three additional fresh-process repeats. The intermediate crash remains recorded and its cause is undetermined.

The clean server rotation at `46e2dd2` passed 9,662 assertions across 129 files, with nine environment-gated skips. A separate earlier run in an actively edited worktree had 19 source-identity assertion failures. The isolated run passed the same 67 core-profile assertions.

Win64 BuildPlugin produced a package for each engine. Each installed editor loaded its matching DLL in a UEMCP-owned project and passed both graph regressions, the packaged fixture schema check and the shared transport fixture. The wider packaged suite passed 9/9 on UE 5.6.1 and 5.8.4. It passed 8/9 on UE 5.3.2. The remaining `UEMCP.Transport.DecoderBoundaries` case expected an escaped U+0000 to decode to one code unit in both framed and legacy JSON transport. Both assertions failed. The transport source and test corpus match the versions on main. Track this separately from animation acceptance. Private compiler copies excluded workstation Marketplace extensions for 5.3.2 and 5.6.1. Deployment fingerprints and package hashes are retained locally.

The local custody record is `2026-11-21-graph-placement/RESULTS.md`. The task branches and their engine fixtures are retained for review and the character milestone. No change was merged to main or published during this pass.
