# Editor workflow gaps

Proposed November 26, 2026 against UEMCP `12db3cb`. The first delivery should let an agent create a configuration asset, change one nested value and open the intended map. The next delivery should let the agent run a short evaluation, reconnect and retrieve the result. PhysicsAsset authoring, RigVM inspection and Chooser inspection can each ship independently. The [task list](../../tasks/todo.md#editor-workflow-gaps) tracks acceptance.

## Delivery order and review

| Start | Units | Dependency and decision |
| --- | --- | --- |
| First | 1 DataAsset creation, 2 nested edits, 3 map opening | Use the existing U8/EN-30 work item for DataAsset authoring. Unit 2 can start on a seeded asset. Unit 3 is independent. Review the configure-and-open workflow when all three pass. |
| Next | 4 headless execution, 5 asynchronous jobs | Prove one real headless evaluation and its output before attaching the job lifecycle to it. Job retry and cancellation tests can start with a controlled worker. Review the combined workflow before scheduling a long training run. |
| Independent | 6 PhysicsAsset, 7 RigVM, 8 Chooser | Each needs its own authored fixture and independent readback. Run whichever the next consumer needs. Unit 8 also serves U4. |
| Throughout | 9 Python guard and tool discovery | Capture the disabled baseline first. Repeat the client task as each structured operation lands. Close this unit after the integrated task passes. |

Each unit below has two review checkpoints. At **design review**, the implementer brings the original client prompt, an owned reproducer, the observed result on current source and the proposed scope. If a shipped operation already meets the acceptance criteria, fix discovery or qualification and rerun the prompt. At **acceptance review**, a reviewer compares the client's result with independent engine, process or saved-file evidence. Record pass, fail or unexercised for each promised mode and engine. A failed case stays open with its reproducer.

For server or tool changes, run `npm test` from `server/`. For native changes, rebuild the owned editor target for each claimed engine. Use one owned Win64 host for first reproduction. Qualify the accepted feature on the claimed engine versions and available provider clients using the [agent workflow protocol](../agent-workflow-usability.md). Record UE 5.9 Preview by exact build in its own row. Keep the prompt, revision, versions, mode, expected and observed result, recovery and unexpected changes with the receipt. Use the [owned fixture and cleanup procedure](../fixture-host.md). All nine units start open.

## 1. Create a DataAsset

**Starting point.** “Create an evaluation config of this class at this package path.” The first supported workflow uses one concrete, project-defined UDataAsset subclass with known defaults. [Tool definitions](../../tools.yaml) · [EN-30](../tracking/backlog.md)

**Creation contract.** Discover a loaded concrete class with `list_data_asset_types`. Pass its exact `path` as `subclass`, a single asset `name` and an optional `path` naming a writable project folder. The folder defaults to `/Game`. Creation returns `asset_path` (package), `object_path`, `class_path` and `dirty`. Use `save_asset` with the package path for persistence. A collision with an in-memory or saved package returns `ASSET_ALREADY_EXISTS`. Invalid destinations and classes return `INVALID_PATH` and `INVALID_ASSET_CLASS`.

**Acceptance on Win64, UE 5.8.4 CL 58902052.** The baseline production server at `12db3cb` returned `TOOL_NOT_FOUND` for creation. With the new handler, Codex CLI 0.172.0 discovered the project-defined class and created `/Game/Evaluation/DA_UnitOne` unsaved. Its first type-listing call needed the editor identity check and succeeded on retry. An independent engine read verified the class, threshold 0.5, seed 17 and dirty package. No asset file existed until a separate MCP save. A fresh editor then loaded the same values with a clean package. Duplicate attempts before saving and after restart, abstract and incompatible classes, and an out-of-project destination were rejected. The saved sibling's hash was unchanged. The fixture uses the [evaluation config class](../../server/fixtures/uemcp-fixture/Source/UEMCPFixture/UEMCPFixtureEvaluationConfig.h) and [staging allowlist](../../server/fixtures/host-source-files.json). For Unit 2, changing the threshold to 0.25 must leave the seed at 17. Other engines and nested edits need their own runs.

- **Design review.** Reproduce discovery from a fresh client. Agree on class and package identity, allowed creation locations, duplicate-name behavior and when a new asset becomes durable.
- **Implementation checkpoints.** Resolve the class and destination and reject invalid input before allocation. Expose creation through normal discovery and mutation dispatch. Return the actual class, object path and dirty state. Exercise explicit saving separately.
- **Acceptance review.** Create an asset and inspect its class and defaults through Unreal. Save it, restart and inspect it again. Retry the same path and try an abstract or incompatible class. Verify one asset exists, the original values survive and unrelated packages have unchanged hashes.

## 2. Edit nested DataAsset properties

**Numeric field contract.** Use `get_data_asset_property` on a loaded or saved project DataAsset. Supply its exact `/Game` package or object path and the reflected `property_name`, such as `Settings.Threshold`. The response contains the current value and package dirty state. `set_data_asset_property` accepts a JSON number for editable int32, float and double leaves, including leaves reached through inline structs. Integers must be integral and within int32 range. Floating-point storage limits and declared clamp bounds apply. Conditional fields, custom accessors, fixed arrays and nontransactional fields are outside the writer's scope. A changed value produces one editor transaction. A no-op or validation failure leaves the transaction history intact. Use `save_asset` for persistence.

**Design review on UE 5.8.4.** Remote Control successfully read `Settings.Threshold`. The original writer returned success and dirtied the package while Unreal still read 0.5. Sending the full dotted address and keying the JSON value by the final field name changed it to 0.25. The RC translator now uses that form for dotted identifiers. The native TCP tools additionally validate the field and value before mutation, report dirty state and work in a NullRHI editor without an HTTP listener.

**Numeric scalar checkpoint, Win64 UE 5.8.4 CL 58902052.** Codex CLI 0.172.0 edited a saved fixture and Claude Code 2.1.332 edited a never-saved fixture using the normal MCP tools. Both reached threshold 0.25 and preserved seed 17, confirmed by an independent editor observer. On the saved fixture, Undo restored 0.5. A typo, a fractional seed and a no-op then preserved Redo, which restored 0.25. The target's file hash changed only after explicit save. A new editor process loaded 0.25 and seed 17 with a clean package. The control asset retained its original hash and values. The exercised leaf types were float and int32. Double, other engines, whole vectors, indexed arrays and typed references remain unqualified. Unit 9 should revisit first-call editor identity guidance: both clients retried after verifying the connection, and Claude also tried a disk read on the never-saved asset.

**Readback follow-up from Unit 1.** Claude Code 2.1.332 created an unsaved asset directly in the default `/Game` folder. It then searched for independent confirmation. A disk lookup and the reference list could not distinguish the new in-memory object from a nonexistent path. The separate engine observer confirmed the new package was dirty and absent from disk. Include a live value read for the loaded, unsaved object in this unit's design comparison.

**Creation and scalar edit on UE 5.9 Preview 2, Win64 CL 60738873.** A fresh Codex CLI client discovered the evaluation class, created the config and changed its threshold from 0.5 to 0.25. An independent editor observer confirmed the unsaved package and seed 17. Undo restored 0.5. A rejected fractional seed, an unknown field and a no-op preserved Redo, which restored 0.25. After explicit save, a different editor process loaded 0.25 and seed 17 with a clean package. The control asset retained its original hash.

**Whole FVector checkpoint.** Pass three finite JSON numbers in X, Y, Z order to `set_data_asset_property`. The editor validates the complete value before opening one transaction. The getter and setter return vectors in the same order. On Win64 UE 5.8.4 CL 58902052 and UE 5.9 Preview 2 CL 60738873, Codex CLI 0.172.0 set `Settings.Offset` to `[11,-22,33]`, saved the config and opened the requested map. Independent checks covered all components, sibling threshold 0.25 and seed 17, Undo, Redo, a malformed vector, a scalar/vector type mismatch and a no-op between Undo and Redo. A fresh process loaded the saved vector on each engine.

**Indexed array checkpoint.** Use a zero-based index in a reflected path such as `Settings.Weights[1]` to edit an existing dynamic-array element. The operation preserves the array length. At commit `6db27cc` the same path returned `INVALID_PROPERTY_PATH` for a populated fixture array. On Win64 UE 5.8.4 CL 58902052 and UE 5.9 Preview 2 CL 60738873, Codex CLI 0.172.0 changed the second weight from 2 to 8.5. An independent Unreal observer verified the full array, seed 17 and threshold 0.5 across Undo, Redo and a fresh editor process. Negative, oversized and out-of-range indices, indexing a scalar and writing the same value all preserved Redo and the package state.

**Starting point.** “Change the evaluation threshold in this config and keep the other settings.” Seed an asset with a nested struct containing a scalar and a sibling with a distinctive value. The shared property registry currently dispatches by property class. The existing actor and Blueprint callers look up a single property name. [Property handlers](../../plugin/UEMCP/Source/UEMCP/Private/PropertyHandlerRegistry.cpp) · [Blueprint caller](../../plugin/UEMCP/Source/UEMCP/Private/BlueprintHandlers.cpp)

- **Design review.** Compare existing Remote Control writes and the native setter against the same fixture. Decide which conversion code to reuse. Specify path segments, editable fields, numeric bounds, value types and the transaction boundary before extending existing callers.
- **Implementation checkpoints.** Ship one nested scalar edit with full validation before mutation, Undo/Redo, dirty-state reporting and explicit save. Add vectors, indexed arrays and typed object references as separately reviewed slices. Give each supported shape a positive case and an invalid-input case.
- **Acceptance review.** Independently read the edited leaf and its siblings before and after Undo, Redo and save/reopen. Try a misspelled path, invalid vector, out-of-range index and incompatible reference as each type lands. Failed calls must preserve values, dirty state and undo history. Rerun the existing scalar, enum, actor and Blueprint cases after any shared conversion change.

## 3. Open an editor map

**Starting point.** “Open the evaluation map and tell me which map is active.” On UE 5.8.4, calling the level subsystem's default loader directly switched maps and lost an unsaved fixture actor. UE 5.9 Preview 2 refused the same call and preserved the actor.

**Tool contract.** Pass a saved package name such as `/Game/Evaluation/MapB` as `map_path` to `open_map`. The result contains the observed package, the full world object path, the previous package and whether the world changed. Requesting the active map preserves its unsaved edits. When a switch would displace dirty level data, the tool returns `UNSAVED_MAP_CHANGES` with the package name. Save the edits explicitly and retry. If the client times out during a load, check `get_editor_state` before issuing another request.

**Acceptance on Win64 UE 5.8.4 and 5.9 Preview 2.** A fresh provider client configured and saved the DataAsset and opened map B. An independent editor read found B's unique actor. Automated checks covered opening B twice, a missing map, a non-map asset, active PIE and unsaved map A edits. The loader refused the unsafe switch, kept the actor, and succeeded after an explicit save. The fixture also exercises a loaded streaming sublevel. World Partition external actors and slow-load timeout recovery require separate live qualification.

- **Design review.** Define the accepted map path, project ownership, PIE behavior and which unsaved packages switching would displace. Choose a recoverable response for unsaved work. Include related level packages in the fixture wherever the implementation claims support.
- **Implementation checkpoints.** Resolve the target and check the current editor world before invoking the level subsystem. Handle reopening the active map. Report the observed world package after loading. On a slow load, let the client reconcile the outcome before retrying.
- **Acceptance review.** Open map B from A and verify the editor-world package and a B-only actor through an independent read. Repeat on B. Try a missing map, a non-map asset, active PIE and an unsaved change on A. Verify the rejected cases preserve the world and edits. Exercise the recovery by explicitly saving A and retrying.

## 4. Run an evaluation headlessly

**Starting point.** With the editor closed, ask the client to evaluate a saved config against a saved map. Commandlet startup skips the TCP listener. Existing owned runners already launch Unreal and collect results. [Plugin startup](../../plugin/UEMCP/Source/UEMCP/Private/UEMCPModule.cpp) · [Owned runner](../../server/run-owned-authoring.mjs) · [Execution modes](animation-authoring-execution.md)

- **Design review.** Run a small evaluation with a known answer. Measure whether it needs a ticking world, physics or rendering. Choose a commandlet for a compatible batch operation or an unattended editor/game process for a workload needing simulation. Test the need for a persistent headless TCP session against this concrete task before adding a listener.
- **Implementation checkpoints.** Define a named evaluation with explicit config, map, seed and result. Share its evaluation logic between the reference run and a project-bound headless adapter. Use bounded process ownership, isolated outputs and a terminal result with the engine build and resolved inputs.
- **Acceptance review.** With no interactive editor, compare the headless result to an independently observed reference within an agreed tolerance. For a simulation, verify actual world steps and state change. Test invalid input, a conflicting package owner and an interrupted child. Verify exit status, output completeness, unrelated package hashes and owned-process cleanup. If persistent TCP is required, also verify independent attach, identity, reconnect and shutdown. Record which headless mode passed.

## 5. Manage long-running evaluation and training jobs

**Starting point.** “Start this evaluation. I will reconnect for the result.” A request can time out while queued game-thread work can still execute. Treat lost acknowledgement as a normal recovery case. [Game-thread dispatch](../../plugin/UEMCP/Source/UEMCP/Private/MCPThreadMarshal.cpp) · [Process runner](../../server/deployment/process-runner.mjs)

- **Design review.** Reproduce lost acknowledgement with a controlled worker that counts starts. Define request identity, allowed job types, ownership, progress, terminal states, cancellation and restart reconciliation. Pick measurable acknowledgement and status budgets below the applicable client deadlines.
- **Implementation checkpoints.** Return a job ID after durable registration. Add status and result lookup. Add worker ownership and cancellation, then restart recovery. Integrate Unit 4's short evaluation before adding one bounded PPO training run with a recorded seed and step budget.
- **Acceptance review.** Disconnect after start, submit the same request concurrently, then restart the MCP server. Verify one worker start and one terminal result. Reuse the request ID with different inputs and verify rejection. Kill a worker and cancel queued and running jobs. Verify terminal states, reported partial artifacts and no surviving owned process. Keep a second client responsive during a job longer than an ordinary request deadline. For PPO, independently verify training steps and a readable checkpoint or terminal training artifact.

## 6. Author PhysicsAsset bodies and constraints

**Starting point.** “Change this joint limit and show that the simulated joint obeys it.” Use an owned skeletal mesh with known bones, bodies and a named constraint. [Physics editing scope](../tracking/risks-and-decisions.md)

- **Design review.** Define body and constraint identity, frames, angular units and physics tolerances. Record the initial joint behavior under fixed-step simulation before choosing the new limit.
- **Implementation checkpoints.** Read bodies and constraints. First ship one existing constraint-limit edit with a transaction and explicit save. Next add body creation for one shape and constraint creation between two named bodies. Review the supported shapes and fields before expanding them.
- **Acceptance review.** Inspect the edited definition after Undo/Redo and save/reopen. Simulate under the same drive and measure the joint angle against baseline and the declared tolerance. For creation, verify topology, frames and simulated response. Try a missing bone, duplicate body and invalid body pair. Verify the whole original topology and unrelated assets survive each rejection.

## 7. Inspect Control Rig and RigVM graphs

**Starting point.** “Which nodes and pins feed this output on the saved rig?” Make an owned rig with known links, pin defaults and one disconnected pin. Capture the authored topology from the engine. The existing AnimBP graph coverage is a separate reference. [Graph qualification context](../plans/animation-authoring-program.md)

- **Design review.** Compare what live RigVM model inspection and existing offline readers return on the same asset. Define graph identity, pin paths, directed links, nested graphs and supported serialization versions. Choose whether “offline” means standalone package parsing or reading an explicitly generated snapshot, and label the route. An engine-free raw-package requirement stays open if only snapshots work.
- **Implementation checkpoints.** Deliver the live native reader first. Qualify saved-package inspection independently against the captured topology. Include source hash and schema version for exported snapshots, and explicit reasons for unsupported formats or incomplete graphs.
- **Acceptance review.** Compare exact node and link identities, endpoint pin paths, defaults and disconnected pins with the fixture. Change one link without saving and verify live versus saved results. Save, close Unreal and repeat the advertised offline route. Reject stale snapshots or unsupported versions explicitly. Verify inspection leaves asset bytes and dirty state unchanged.

## 8. Inspect Chooser rows and results

**Starting point.** “Which row selects this animation, and when does the fallback win?” Author two rows with different keys and results, one disabled row and a fallback. Record native evaluation for inputs that select each enabled row and the fallback. [Observed offline gap](../tracking/limitations-from-project-a-animation-audit-2026-06-18.md) · [U4 scope](../../tasks/plan.md#units-and-their-starting-points)

- **Design review.** Identify the specific column and result types in the fixture, row ordering, disabled state, and which conditions determine selection. Agree how an unsupported instanced struct is reported without losing its row association.
- **Implementation checkpoints.** Produce a native read of ordered rows, typed column values, result identity and fallback. Add saved, engine-free row mapping for the declared types. Review nested choosers and additional column types as separate extensions. If using a snapshot, expose its origin and freshness and track direct package decoding separately.
- **Acceptance review.** Compare every supported row field with the authored table and predicted selections with native evaluations. Swap two results while preserving the same referenced asset set. The reader must report the swap. Close Unreal and repeat the saved read. An unknown column must identify the affected row or column and keep the overall result visibly partial.

## 9. Complete normal workflows with Python disabled

**Starting point.** Give an agent a clean client profile and the configuration, map and evaluation task. Record where it currently asks for Python, custom project C++ or a console command. The Python tool already has an explicit server opt-in and a native policy check. [Server gate](../../server/m5-editor-utility-tools.mjs) · [Native handler](../../plugin/UEMCP/Source/UEMCP/Private/EditorUtilityHandlers.cpp)

- **Design review.** Classify each failed step as a missing operation, poor discovery, or inadequate error feedback. Assign the fix to its owning unit. Keep process launch and artifact handling in the owned runner. Preserve the opt-in, native checks and audit behavior for intentional editor scripting.
- **Implementation checkpoints.** Test disabled-by-default behavior first. As each structured operation lands, repeat the original prompt, repair discovery where needed and check the actual tool trace. Exercise a benign editor read in an explicitly opted-in test session separately.
- **Acceptance review.** Verify the default profile rejects a direct Python call before execution. Verify the opted-in benign case, a policy rejection and the expected audit evidence. On the integrated workflow, require the trace to show structured calls, with zero Python calls, console commands or project-specific JSON wrappers. Check the actual assets and evaluation result independently.

## End-to-end review

Use this prompt from the owned project's root in a fresh provider client with default permissions and Python disabled.

> Create an evaluation config from the supplied class. Set its nested threshold to 0.25, save it, open the evaluation map and run the short seeded evaluation. I need the result after reconnecting.

1. After Units 1–3, stop the prompt after opening the map. A separate observer checks the reopened config, unchanged sibling fields, active world and map-specific actor. Repeat with a misspelled property and with unsaved map edits.
2. After Units 4–5, continue through evaluation. Interrupt the client after submission and retry. Match the single worker execution and result to the saved config digest, map identity, seed and independently measured outcome.
3. At final review, record Unit 9's tool trace and publish the exact engine, client and execution-mode matrix for the accepted slices. Units 6–8 retain their own physics, graph and row-selection evidence. Update the owning capability contracts, tool definitions, discovery guidance and backlog as each operation ships.
