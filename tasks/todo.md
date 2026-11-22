# Roadmap starting slices

These are independently selectable tasks from the [work-unit map](plan.md),
not a sequential checklist. The [backlog](../docs/tracking/backlog.md) retains
status and historical evidence. Checkboxes track planning/delivery milestones, not a reset of
already shipped capabilities. Each row is a starting slice, not the entire unit.

## Core correctness execution checklist (2026-11-22)

Follow the [work order and branch bases](plan.md#core-correctness-before-the-next-character-experiment-2026-11-22).

- [x] **Coordinator, before the first bulky output.** Implement and exercise
  the on-demand cleanup helper on a disposable allocator-created run. Prove
  preview leaves files intact, apply removes the selected retired output, and
  repeat apply reports it gone. Verify changed, active, linked and outside-run
  targets are preserved and an unrelated sibling survives. Save the receipt.
- [x] **Coordinator, before staging or building.** Reserve one shared run root.
  Fill in the [cleanup inventory](plan.md#cleanup-ownership-before-the-first-run)
  in its `RUN.md` with both owners. Record the expected artifacts, exact paths,
  peak disk budget, receipt destinations and removal triggers. Identify the
  original reproducer, reused hosts and existing animation worktrees separately
  from disposable working copies.
- [x] **Coordinator, before execution.** Record branch heads, owned host
  manifests, editor/build availability, package fingerprints, process ownership
  and run directory. Pin the original package report and the identical set of
  nine tests for the later comparison.
- [x] **Decoder owner, first editor slot.** Reproduce both 5.3.2 assertions on
  a working copy. For each transport record the parsed string length and code
  units at engine readback and at the UEMCP result. Include an ordinary string
  control. Identify the first divergent boundary and document the expected
  behavior before changing code.
- [x] **Writer owner, in parallel.** Map the existing setter changes and their
  dependencies against main. Review direct and dispatcher argument rejection,
  omitted defaults for wired inputs, numeric limits and the actor readback.
  Mark each repair as already present on main, ready for review, or needing a
  dependency. Preserve the original failing evidence.
- [x] **Writer owner, next editor slot.** On 5.8.4 exercise a representable
  integer that exposes precision loss, a vector with distinguishable components,
  a misspelled argument, two similarly named graph pages and function entry
  creation/reuse. Use exact graph identities and execute the compiled actor.
  For a refusal, compare graph links, defaults, dirty state and Undo history.
  Record observed behavior separately for each case. If an engine invariant
  prevents a proposed fixture, record the evidence and narrow the claim.
- [x] **Each owner, at every retry and engine handoff.** Verify the saved
  receipts, stop owned processes that have finished, reclaim superseded output,
  and record actual paths and sizes still needed by the next consumer.
  Reconcile the same inventory on interruption or cancellation. On a review
  denial, follow the [denial procedure](plan.md#when-removal-is-denied), report
  the surviving paths and size, and remeasure free space before the next build.
- [x] **Each owner, after reproduction.** Add focused regression coverage
  wherever the existing tests miss a confirmed defect. Reuse the decoder
  regression. Verify each repair against its original failing input and a
  valid neighboring input. Record native test names, public call results where
  applicable, independent observations and the tested source and binary.
- [x] **Coordinator, integrated qualification.** Check exact deployed plugin
  and corpus hashes. Require all seven transport tests on the decoder candidate,
  then 9/9 in the original packaged suite on integrated UE 5.3.2 Win64.
  Repeat the decoder regression and affected writer checks on 5.6.1 and 5.8.4,
  and run the affected writers on 5.3.2. Run the server rotation for server or
  tool-surface edits. Have an independent reviewer check the diff, compatibility,
  refusal behavior and readback receipts. Requalify any fixes from review.
- [x] **Coordinator, final agent replay.** Give a fresh real CLI an owned
  Blueprint, a requested assignment and named save scope. Let the agent
  discover tools and recover from an ambiguous target or mistaken argument.
  Record the prompt, client/model, engine, calls, interventions and claimed
  result. Reopen in a fresh editor, identify the graph by GUID, invoke the
  compiled actor and compare its value and unrelated package hashes. Repeat
  the same task for each client/engine combination claimed as supported;
  list unexercised combinations explicitly.
- [x] **Coordinator, closeout.** Publish the per-engine and per-client results
  in the work record. Resume the character experiment when the integrated
  checks pass, the CLI result matches independent readback, and each confirmed
  writer defect in scope has passed its regression. Record any remaining
  source-only concerns with their next check. Close TRANSPORT-53-NUL and remove
  its retained fixture once its verified result is recorded. Check the final
  filesystem inventory against `RUN.md`, verify receipts outside scratch and
  remove the empty run root. Record each surviving path, owner, size and release
  condition in the local report. Capture Git status and the worktree list after
  retiring any merged core worktrees.

## Core correctness results (2026-11-22)

The integrated native code is at `8672b93` on `task/writer-core`.
`a8f61a0` updates a server source-guard assertion on that same plugin tree.
The full rotation passed 9,668 assertions across 129 files with nine
environment-gated skips. UE 5.7 remains deferred.

The retained UE 5.3.2 package reproduced the framed and legacy failures.
The native JSON reader and both transport paths produced zero code units
for leading escaped NUL, including a string with a following printable
character. The ordinary and interior-NUL controls preserved their values.
The repaired decoder passed all seven transport tests on UE 5.3.2, 5.6.1 and
5.8.4 Win64. On all three engines, a separate native object-map observer
showed that distinct equal-length keys can coalesce when they differ after NUL.

The original nine-test suite passed in an installed UE 5.3.2 editor using
the integrated Win64 package. The first process crashed before exporting
results. Symbols matched the game thread to the pawn graph test's scope-exit
cleanup and garbage collection; the specific invalid reference remains unknown.
The passing run used a fresh editor with the same DLL and corpus. Raw local
receipts, including both attempts, live under
`docs/reports/2026-11-22-core-correctness/` in the primary checkout.

| Win64 engine | Integrated native checks | Codex CLI 0.171.0 assignment and fresh-editor actor readback |
| --- | --- | --- |
| UE 5.3.2 CL29314046 | 11/11 | Passed, 33 public calls; recovered from a mistaken tool name and unverified editor identity |
| UE 5.6.1 CL44394996 | 11/11 | Passed, 22 calls; recovered from unverified editor identity |
| UE 5.8.4 CL58902052 | 11/11 | Passed, 33 calls; recovered from unverified editor identity |

The original UE 5.8.4 assignment wrapped overflowing signed integers, reduced
vector precision and accepted a misspelled top-level graph argument. On the
integrated build, both overflow directions were refused, the exact integer
16777217 survived, and Unreal's established fractional rounding was preserved.
The three vector components `[1e-7, -1.23456789012345, 12.5]` survived
compilation, saving, reopening and execution. Tests with reordered graph pages
verified implicit and explicit canonical Event Graph selection and explicit
secondary-page selection by independently checking the actual node GUIDs.
Function creation and reuse preserved the original entry. Each client run
changed one requested asset. Independent review confirmed the observations.
Other client workflows and human sessions remain unexercised for this change.

The cleanup helper on `task/run-cleanup` at `416862d` passed disposable-run
and independent controls on PowerShell 7.6.10, including changed content,
alternate streams, live processes, junctions and idempotent removal. Windows
PowerShell 5.1 refused before accessing the target. The minimum 7.2 runtime
was checked for API compatibility and has no separate runtime trial.

At closeout the coordinator verified removal of all five private build
profiles, the 19.42 GiB compiler copy, the run directory and the original
decoder reproducer. All 55,170 read-only compiler inputs matched the installed
originals before their copied attributes were cleared. The integrated core
and cleanup helper checkouts remain for review and merge.

## Roadmap slices

| Task | Acceptance and verification | Dependency / likely area |
|---|---|---|
| [x] U1a: truthful timer failures (BUG-3) | Reproduced both failures on UE 5.8.4. The fix passed all 15 native Blueprint cases on UE 5.3.2, 5.6.1 and 5.8.4 Win64. | [BUG-3 evidence](../docs/tracking/backlog.md#retained-correctness-and-workflow-reports) |
| [x] U2a: stop/next-operation lifecycle (QA-1, F-14) | Verified identity, actor edits/readback and two ordinary PIE cycles per engine on UE 5.3.2, 5.6.1 and 5.8.4 Win64. All six first MCP queries after stop saw zero worlds, and all six following editor edits succeeded. | [Owned host results](../docs/owned-pie-lifecycle.md#live-stop-and-next-operation-check-2026-11-19) |
| [ ] U3a: capture confinement (EN-28) | Reproduce both screenshot/preview paths; reject invalid output locations and inspect valid rendered output. | None; capture handlers and focused tests. |
| [ ] U4a: shipped AnimGraph read qualification | Owned AnimBP oracle agrees with properties, topology and defaults; document actual missing fields without treating existing tools as absent. | None; animation fixture, runner and read handler only if a defect is found. |
| [x] U5a: scope the first AnimGraph edit | [Slot insertion](../docs/plans/u5-animation-authoring.md) defines the identity, schema, Undo and persistence requirements. | Scoping complete. |
| [x] U5.1–U5.3: insert an existing montage Slot | The [owned workflow](../server/fixtures/interactive-animbp/README.md#montage-slot-run) covers conditional edge replacement, Undo/Redo, compile diagnostics, explicit save/reload and evaluated playback. | Implemented on the interactive task branch. |
| [ ] U6a: define one vector material workflow (EN-32) | Enumerate minimum typed inputs/nodes and expected compiled graph; specify independent oracle and lifecycle tests before implementation. | Workflow selection; material authoring contract. |
| [ ] U7a: registry query reproduction (EN-8 P6) | Known corpus demonstrates filter/alias/output bounds and truncation; split unknown-parameter rejection into U1 if reproduced. | None; registry tools and fixtures. |
| [ ] U8a: select one gameplay asset mutation (EN-30) | Define asset type, validation, write/readback, dirty/save, Undo and restart contract; identify an owned fixture. | Concrete authoring workflow; asset/GAS design. |
| [ ] U9a: data-flow provenance audit (OWN-3a) | Match available source, manifest and receipts; enumerate missing artifacts and exact current-main differences; produce one bounded integration plan. No historical proof carried onto changed bytes. | Local recovery archive access; evidence report, no editor needed. |
| [ ] U10a: support and desktop acceptance scope | Record intended supported combinations and one owned desktop-client/editor acceptance script, with separate transport/UI/rendered checks. | None for scope; native slot for execution; support/test docs. |
| [ ] U11a: performance/fidelity decision brief, when triggered | Identify a user-visible problem, existing measurements and minimum missing experiment; explicitly defer redesign if no need is established. | Measured need; profiling/design docs. |
| [ ] U12a: establish audit baseline | Apply AUD-1 organization reconciliation and capture upstream revisions/activity for the initial AUD-3 watchlist; refresh U5 decision-driving research under AUD-2. Record bounded actions or no relevant change. | [Audit policy](../docs/tracking/ecosystem-watch.md); initial discovery exists, full audit pending. |

## Current selection gate (2026-11-19)

Selected order after triage review: close the documentation checkpoint, then
**U1a / BUG-3**, then the bounded **U2a / QA-1 and F-14** lifecycle check, then
**U5 interactive AnimBP editing with its U4 readback oracle**. These are separate
slices, not one large implementation change. Reproduce failures before fixing
them; qualification gaps are not automatically confirmed defects. General
fixture recovery and a universal graph framework are not prerequisites.

- [x] Scope the [interactive AnimBP experiment and first regression](../docs/plans/animbp-interactive-authoring.md):
  ad hoc node placement and wiring in both AnimGraph and Event Graph, incremental
  compile feedback, Undo and persistence; deliver live qualification first and
  follow with headless replay of the supported operations.
  Recipes supplement these operations rather than gating access to them.

- [ ] Inventory existing support across the [animation program](../docs/plans/animation-authoring-program.md),
  covering AnimBPs, sequences, montages, timelines, supporting assets, rigs and
  authoring feedback; distinguish missing tools from unverified existing tools.
- [x] Qualify the first Event Graph–driven blend and the existing-Slot workflow.
  The fixture seeds the sequence players.
- [x] Qualify sequence-backed states, directed numeric transition rules and shared
  cached poses through MCP, independent graph readback and fresh-editor motion sampling
  on UE 5.3.2, 5.6.1 and 5.8.4. Additional rule expressions and masked montage
  playback remain open.

## Checkpoint for every selected slice

- [ ] Bound the implementation handoff, exact verification commands and resources.
- [ ] Complete applicable tests and review; retain failures, skips and proof limits.
- [ ] Update the backlog with completion evidence or a precise remaining gap.
- [ ] Clean owned temporary outputs/processes and reconcile checkout and linked checkout list.

Follow-ups within each unit are described in the work-unit map and backlog;
promote only the next useful slice into a concrete handoff. This avoids creating
another large inventory of speculative tasks that duplicates the roadmap.
