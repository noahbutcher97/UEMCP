# Extensible headless workloads and direct package inspection

Proposed continuation of [editor workflow units 1–9](editor-workflow-gaps.md), based on local revision `b923432`. Units 10–20 are open. The outcome is that a workload registered once can be discovered and executed from the CLI and MCP, and a supported saved asset can be inspected from its package in a fresh process with Unreal closed and no prior export. Compatibility is recorded per workload, execution mode, asset layout, caller and engine build.

## Starting evidence and decisions

- The durable queue already owns request identity, worker lifetime, cancellation and recovery. Its input validator assumes spacing inputs and its worker always calls the spacing evaluator before optional PPO training. Preserve the queue and move those assumptions into workload definitions. [Job implementation](../../server/evaluation-jobs.mjs) · [Current public contract](../specs/evaluation-jobs.md)
- The package reader already resolves names, imports, exports and tagged properties. It has a struct handler registry. An exploratory read of the installed `CR_PhysCube` sample found five RigVM graph exports, 1,787 pin exports and 133 link exports. Reading the two serialized endpoint strings consumed the exact export span for all 133 links. This establishes a feasible layout for one sample. Graph membership, semantic equality with the editor and other layouts need independent fixtures. [Package reader](../../server/uasset-parser.mjs) · [Struct handlers](../../server/uasset-structs.mjs)
- The existing RigVM and Chooser tools can observe unsaved editor state. A separate tool exports a clean, hash-verified snapshot. Direct inspection gets an explicit raw-package route and origin. Keep the existing snapshot call and its stale-snapshot error for existing clients. The generic property reader should benefit wherever it exposes an affected export or property. [Inspection contract](../specs/tool-surface.md#rigvm-and-chooser-inspections) · [Snapshot reader](../../server/saved-inspection-snapshot.mjs)
- Start on Win64 UE 5.9 Preview 2. Use an owned PhysicsAsset joint-response measurement as the proposed second evaluation domain. It has a different input shape and an existing independent Chaos fixture. Pin the actual simulation mode in Unit 14. Native compilation, commandlet execution, physics-scene steps, ticking game worlds and rendering each require their own evidence.

## Order and ownership

| Unit | Deliverable | Depends on |
|---|---|---|
| 10 | Caller inventory, baseline failures and owned fixtures | Existing units 4–9 |
| 11 | Register existing workloads with a versioned contract | 10 |
| 12 | Execute and recover registered workloads in the durable queue | 11 |
| 13 | Discover and submit workloads from MCP and CLI | 12 |
| 14 | Qualify a second evaluation domain with real simulation | 13 |
| 15 | Read a custom export through the shared package reader | 10 |
| 16 | Decode typed instanced structs through the shared property reader | 15 |
| 17 | Reconstruct saved RigVM models and directed topology | 15 |
| 18 | Reconstruct saved Chooser rows, results and fallback | 16 |
| 19 | Expose direct, live and snapshot inspection consistently | 17, 18 |
| 20 | Qualify the combined workflows and publish measured coverage | 14, 19 |

The jobs and inspection teams can start independently after Unit 10. Units 16 and 17 can overlap once Unit 15's interface is reviewed. Assign one integrator for shared catalog or parser changes. Coordinate exclusive fixture/editor access and run large compilations within the measured disk budget.

**Every unit has four checkpoints.** (1) The implementer records the starting behavior, fixture, expected result and focused test before changing the mechanism. (2) They deliver the unit and its acceptance evidence. (3) A reviewer who did not author that unit inspects the diff and independently runs the challenge specified below, using a separate observation or reference calculation. (4) The implementer fixes each finding at its source and adds a regression for each reproduced defect. The reviewer reruns both the failed case and the positive control on the corrected revision. If no defect is found, record the challenge and its result. Record the reviewed commit, reviewer, fixture hash, engine/client version, commands, findings and retest result before checking off the unit. An open acceptance failure keeps the unit open.

## 10. Establish the caller and fixture inventory

**Deliver.** Trace actual calls from discovery and tool description through direct MCP registration, the generic read/mutation dispatchers, offline dispatch, the spacing CLI, job worker and native entry point. For inspection, trace generic asset and Blueprint property consumers, specialized inspectors, explicit snapshot export/read and existing CLI consumers. Record which caller can meaningfully expose each field. Identify the project attachment, permission, write and engine requirements for each route. Start at the [server registrations](../../server/create-uemcp-server.mjs), [tool requirements](../../server/tool-requirements.mjs), [offline dispatch](../../server/offline-tools.mjs) and [catalog](../../tools.yaml).

**Accept.** On a pinned owned host, reproduce a non-spacing request rejected by the current contract and first-time raw inspection of a saved rig and table with no snapshot. Record exactly what the generic reader recovers and where it stops. Save independent Unreal observations of graph membership, endpoints, defaults and Chooser selections alongside hashes. Retain a pre-change queued record, terminal result and version-1 snapshot for compatibility tests. Re-create an owned fixture from its authoring recipe when needed.

**Type coverage.** Inventory known custom export and instanced-struct families encountered by those callers. Record the qualified type name, container, package/custom version, editor-only data availability and whether the reader can bound the payload. Include ordinary editor packages and representative cooked, stripped, split and unversioned inputs. For each relevant combination assign a fixture, an owner and a status (supported, partial, explicitly unsupported or unexercised). Runtime evaluation and graph authoring have separate contracts.

**Independent review and fix.** The reviewer starts from the two user tasks, discovers the tools through a normal client, and independently searches production imports and registrations for a missed caller or layout. Reconcile omissions and rerun the baselines. Each inventory row ends in an assigned unit, an existing regression, or an evidenced reason the surface is unaffected.

## 11. Define a versioned workload and register spacing and PPO

**Deliver.** Define the registration contract for a stable kind and version, canonical arguments, input and result schemas, supported execution mode, required capabilities, resource limits and trusted handler. Use the shipped spacing and training workloads as the first implementations. Keep the catalog discoverable without starting Unreal. Bind implementations during server/plugin installation or startup. A job request selects a registered kind and typed inputs. Specify how project-specific implementations can register and how duplicate names and unavailable dependencies are reported.

**Accept.** The legacy spacing invocation produces the same canonical inputs, distances and digests. PPO still requires a valid step budget and yields a reproducible policy. Demonstrate an additional test registration with neither a config nor a map. Invalid or ambiguous inputs, duplicate registrations and unsupported versions fail before any worker launches. [Spacing runner](../../server/run-spacing-evaluation.mjs) · [Policy implementation](../../server/spacing-policy.mjs)

**Independent review and fix.** The reviewer adds a small test-only definition from the registration contract and tries an old request, misspelled argument and colliding name. Fix any need to edit the common validator for a workload-specific field. Repeat all four cases.

## 12. Route durable execution and recovery through the registration

**Deliver.** Persist the selected workload version and canonical inputs at acceptance. Dispatch the resolved handler under the existing project-bound supervisor. Give handlers bounded inputs, progress, artifacts, cancellation and terminal result validation. Preserve request IDs, read old records, and specify deterministic handling of a queued version whose handler is absent after upgrade. A finished historical result remains retrievable. [Queue](../../server/evaluation-jobs.mjs) · [Windows supervisor](../../server/evaluation-owner.ps1)

**Accept.** Use two client processes. Lose an acknowledgement, retry concurrently, disconnect, restart the server and recover one execution and one terminal result. Reusing the ID with different effective inputs fails. Check adjacent project files, queued/running cancellation, child or supervisor death and absence of surviving owned PIDs. Reopen the pre-change records from Unit 10. Measure submit and poll latency during work exceeding ten seconds against the client deadline.

**Upgrade check.** Retry a pre-upgrade request ID using reordered fields and explicitly supplied defaults equivalent to the original request. Require the original ID, one execution and the original result. Change one effective value and require a conflict. Use semantic, version-aware comparison for persisted inputs and test both queued and terminal requests.

**Independent review and fix.** The reviewer interrupts the process between durable registration and worker claim, and swaps the available handler version before restart. Count actual starts, inspect terminal artifacts and verify process exit independently. Fix duplicate execution, silent reinterpretation or stranded work and replay each interruption. Run `node server/test-evaluation-jobs.mjs`.

## 13. Make workloads discoverable and executable through MCP and CLI

**Deliver.** Expose workload discovery, typed inputs, available modes and result descriptions from the shared definition. Feed MCP and CLI validation from the same contract. Keep the existing four job tools, legacy spacing arguments and spacing CLI invocation working. Document the synchronous CLI's output/exit behavior and how to submit or reconnect to a durable job. Preserve mutation classification for status and result lookups that may restart queued work.

**Accept.** Starting with only a project and a request in plain language, a provider client discovers a kind and its parameters, submits it and retrieves its result in a new session. A CLI user discovers and runs the same workload. Compare effective arguments, result and errors with the legacy spacing path. Invalid arguments exposed through direct tools and generic dispatchers produce equivalent errors and zero starts. Run the discovery, metadata and requirement suites.

**Independent review and fix.** A reviewer uses only the exposed help/catalog, attempts a read-only dispatch of a recovery-capable lookup, and retries an invalid submission. Compare the actual handler and permissions with the advertised ones. Repair any divergent descriptions, validation or routing and repeat through both clients.

## 14. Prove extensibility with a physics evaluation

**Deliver.** Register a workload that measures a named joint's response for a bounded number of fixed physics steps. Use asset path, joint and step budget as inputs. Return units, initial and peak twist, executed steps, mode and source identity. Select the smallest headless Unreal mode that actually advances the chosen physics scene. The product handler must work with the declared project asset inputs. Keep the [existing fixture probe](../../server/fixtures/uemcp-fixture/Source/UEMCPFixture/PhysicsAssetProbe.cpp) as a separate reference.

**Accept.** From MCP and CLI, evaluate two saved joint limits on an owned asset with the interactive editor closed. Predeclare the reference angles and tolerance, verify the initial state and actual step count, and require the measured response to change when the limit changes. Reject a nonexistent joint, cancel a longer run and verify source hashes and child exit. Adding this workload should require only its registration, implementation and tests plus generated catalog changes.

**Project extension check.** Exercise the installation contract from Unit 11 by registering a workload in owned project A alone. Discover and run it through the public client and a freshly launched supervisor. Attach to adjacent project B and verify it is absent from discovery and refused on direct invocation. Deliberately mismatch A's registered version and its installed native handler. Verify an actionable version error and zero workload executions. Record how the fresh worker resolved the installed handler and canonical project identity.

**Independent review and fix.** The reviewer changes the joint limit, independently measures the reference response and checks the diff for a physics-specific branch in the queue, CLI or MCP dispatcher. Replay the project switch from a clean client. Repair the registration boundary or execution mode and rerun both workloads. This closes the jobs track for the demonstrated modes.

## 15. Decode native export payloads in the shared reader

**Deliver.** Extend existing package tables and bounded cursors with a decoder selected by resolved class identity and applicable package/custom versions. Make decoded export data available to generic and specialized consumers. Begin with RigVM link endpoint strings. Preserve export identity, outer ownership and qualified type names. Reuse existing tagged-property handling for exports it already supports.

**Accept.** Read a freshly authored, saved link directly from package bytes in an engine-free process. Verify both paths and their direction against the engine and account for the complete serialized region for the supported layout. Exercise an empty path, an unsupported version and truncated lengths or offsets. Reject an invalid span before reading adjacent bytes. Preserve the existing tagged-reader results. [Package parser](../../server/uasset-parser.mjs) · [Parser tests](../../server/test-uasset-parser.mjs)

**Independent review and fix.** The reviewer changes an endpoint while retaining the same node and pin names elsewhere, and supplies a truncated export beside a valid one. Compare decoded output with the independent fixture, fix misrouting or overread, and rerun both cases.

## 16. Decode typed instanced structs and containers

**Deliver.** Extend the [struct registry](../../server/uasset-structs.mjs) to read the stored type identity and payload bounds for supported `FInstancedStruct` layouts. Use the same primitive for a standalone property and elements of supported containers, including Chooser column/result arrays. Inherit the package version, name/import context and bounded recursion/count/byte budgets. Preserve the type, field path and reason for an unknown value. Continue to the next element only when its boundary is independently known.

**Accept.** Through the generic property reader, read a known value, an empty instance, an unknown instance between known values, and a nested value. Compare fields and order with an independent Unreal read. Change a type to one with the same short name from a different module. Verify that malformed lengths terminate at the correct boundary and legacy scalar/array fixtures retain their results.

**Reuse check.** Author a non-Chooser fixture DataAsset with a reflected instanced struct and an array containing two distinct concrete types. Decode it through the ordinary property tool and verify the values against the engine. Reuse the same registered decoders under the Chooser reader in Unit 18. Record any host or layout that cannot author the fixture.

**Independent review and fix.** The reviewer changes only the middle instance's type or payload size. Verify that later fields are either correctly aligned or explicitly unreadable, and that partial results cannot report themselves complete. Repair the shared decoder and replay the generic property cases.

## 17. Reconstruct RigVM graphs with no prior export

**Deliver.** Use shared export and property values to assemble root models, contained graphs and local function libraries, including graph-scoped node/pin identity, direction, defaults, subpins, orphans and directed endpoints. Resolve model membership using serialized graph relationships. Preserve the existing topology and text limits. Use the [native model inspector](../../plugin/UEMCP/Source/UEMCP/Private/RigVMInspection.cpp) as an independent observer.

**Accept.** On a saved rig, compare semantic records with Unreal for a nested graph, duplicate local names, a disconnected pin with a nondefault value and a directed link. Repeat after saving a disconnect and a changed default. The raw reader must observe the saved changes with no editor or snapshot. Exercise an unresolved endpoint and an over-budget fixture. Keep exact graph and field identities in the comparison.

**Independent review and fix.** The reviewer authors a second graph with coincident pin names and reverses or reconnects a legal edge. Verify ownership and direction with the engine's model API, then rerun the generic link inspection from Unit 15. Repair shared decoding or graph assembly at the layer where the discrepancy starts.

## 18. Reconstruct Chooser rows with no prior export

**Deliver.** Assemble authored row order, disabled state, column type and binding, supported name comparisons, hard/soft asset result paths and fallback from the same typed values exposed to the generic reader. Make the supported combinations explicit. Unknown column or result types retain their identity and produce a partial result. [Live inspector](../../plugin/UEMCP/Source/UEMCP/Private/ChooserInspection.cpp) · [Owned fixture library](../../server/fixtures/uemcp-fixture/Source/UEMCPFixture/ChooserFixtureLibrary.cpp)

**Accept.** With Unreal closed and no snapshot, read two enabled rows, a disabled row and fallback. Compare the raw mapping with independent native evaluation for matching, unknown and unresolved inputs. Swap two results without changing the set of references, save and repeat. Add an unsupported column and verify unaffected fields, issue location, completeness and stable source hashes. Distinguish a serialized soft reference from runtime object availability.

**Independent review and fix.** The reviewer rearranges authored rows, adds a disabled match and tests a missing binding. Compare both the generic nested property values and the specialized answer to the native evaluator. Correct the first diverging layer and rerun the order, fallback and partial cases.

## 19. Connect direct, live and snapshot reads across callers

**Deliver.** Wire the raw reader to a discoverable, project-bound read-only tool. Use an additive tool or an explicit source option with the previous default preserved. Give callers origin, package identity, digest where applicable, version and completeness. Keep the live route for unsaved state and explicit export for compatibility. Route applicable generic consumers through the shared decoder. Specify diagnostics for missing assets, changed files during reads, unsupported layouts and stale snapshots. Publish the chosen interface in [tool definitions](../../tools.yaml) and the [inspection contract](../specs/tool-surface.md#rigvm-and-chooser-inspections).

**Accept.** Deliberately diverge saved, live and snapshot states. Query all three through ordinary discovery, direct registration where available and the applicable dispatcher. Verify each reports the requested source and behavior, including the old snapshot call on stale bytes. From a fresh client, a first-time raw read succeeds with just the package. Inspect calls, dirty state, source hash and filesystem effects to confirm that a read created no snapshot, launched no editor and performed no save.

**Independent review and fix.** The reviewer tries a stale export, partial package result and project reattachment during a read. Ensure the tool cannot silently return another source or project's data as a complete answer. Run `node server/test-saved-inspection-snapshot.mjs` and the discovery/annotation tests after fixing any discrepancy.

## 20. Qualify the whole caller matrix and close the work

**Deliver.** Reconcile every row from Unit 10 against the final revision. Publish a matrix with operation/type, caller, execution or data source, package/layout version, engine build, expected behavior, observed result and receipt. Record unexercised combinations and the concrete fixture or implementation needed for each. Update the owning contracts, catalog, discovery guidance and [backlog](../tracking/backlog.md).

**Accept.** On one fixed revision run `npm test` in `server/`. Follow the [owned host guide](../fixture-host.md) for native compilation. Run the full live and engine-free workflows first on 5.9 Preview 2, then exercise a separately authored 5.8 package and the advertised workloads on an owned 5.8 host. For 5.3, 5.6, 5.7 and other advertised versions, run the applicable compatibility or unsupported-layout cases where a host exists. Record compilation separately from runtime and raw decoding. Use a clean Codex or Claude session for each user-facing task, include a reconnect or plausible mistake, and replay both final workflows with the second provider. Record approval mode and the independent outcome. [Provider workflow protocol](../agent-workflow-usability.md)

**Independent review and fix.** A release reviewer selects a second saved fixture and a workload from discovery, repeats both flows without implementation hints, and checks the evidence behind every advertised cell. Any failing cell goes back to its owning unit for repair and independent replay. Re-run the affected callers and final rotation on the resulting revision before recording completion.

## Evidence and cleanup

Keep a short per-unit receipt with original and corrected revisions, expected/observed behavior, process ownership, package hashes and remaining limits. Keep authored fixture inputs or a reproducible creation recipe outside disposable build outputs. A compiler success qualifies compilation. A package header or reference list alone cannot establish graph topology or row mapping. Claims about simulation require observed state change.

For execution, allocate one coordinator-owned run with `new-task-root.ps1` and use `-ExternalFixture` when staging a fresh host. Record the worktree, branch, owners, PIDs and output paths in `RUN.md`. Preserve the concise receipts outside the run. For each retired output, use `clear-task-output.ps1` first, check the literal path, run ID and byte count, apply the matching preview and verify absence. Finish with the reserved-record and worktree checks in the [repository cleanup protocol](../../AGENTS.md#worktree-and-scratch-cleanup).
