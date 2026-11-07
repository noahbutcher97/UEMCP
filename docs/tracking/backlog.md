# UEMCP backlog and triage

Reconciled 2026-11-07 against main through PR #64 (`1c61c24`), current source,
and the archived recovery evidence. This file is the active index; old checklists are not
completion evidence. Preserve IDs when moving work into a handoff or PR, and
replace the row with a completion link when it ships.

Status meanings: **verified** identifies inspected implementation or recorded
runtime evidence; **needs reproduction** preserves an older report without
claiming it was reproduced today; **advanced recovery candidate** means historical
implementation/execution evidence exists but current-main readiness is not yet
established; **deferred** requires the stated trigger.
All new runtime tests use UEMCP-owned hosts. Do not plant fixtures in external
projects. Historical rationale is retained in the [September notes preserved at PR #62](https://github.com/noahbutcher97/UEMCP/blob/15de65d5b04c717309fb4aaff228b0f8385d9791/docs/tracking/backlog.md).

## Current work and next qualification

| ID | Status | Work / acceptance |
|---|---|---|
| QA-1 | Open qualification | Exercise existing live tools after PR #62's game-thread scheduling change. Existing graph/MCP and parameter-host gates pass, but they do not qualify every tool. |
| QA-2 | Open qualification | Run the supported-engine compilation/runtime matrix for the new material graph surface. UE 5.8.3 Win64 D3D12/SM5 is verified; other versions/platforms and rendered appearance are not. |
| QA-3 | Open qualification | Desktop client/editor UI acceptance remains separate from the completed terminal-client and transport-isolation proof. Shared-directory concurrent asset edits are not made safe by port isolation. See [session isolation](../project-session-isolation.md). |
| EN-32 | Deferred capability | Extend scalar material functions with typed vector/texture inputs and nodes, more math, function instances, layer/blend functions and safe interface edits. Choose one workflow-driven slice with its own host oracle, Undo and persistence gate. |
| OPS-1 | Pending explicit target selection | Select intended consumer targets and deploy an explicitly verified source revision, with deployment verification and editor/client restart. PR #62 and PR #64 verification used disposable owned hosts; a version label alone does not identify the tested source. |

PR #62's graph edits/connections have verified Undo/Redo and save/restart
persistence. Function asset allocation is explicitly not undoable, propagation
is not one atomic reversible transaction, and transport timeouts leave unknown
outcomes. These are documented contract boundaries, not unreported passing tests.
See [the material-function contract](../specs/material-function-authoring.md).

## Product use versus test infrastructure

Normal-use priorities are reliable editor attachment, truthful mutation results,
PIE start/stop boundaries, useful asset/graph inspection and screenshots. QA-1,
BUG-3 and the relevant F-14/EN-28 reproductions directly protect those workflows.
Archived OWN fixture work is enabling coverage, not a prerequisite for every
normal session and not automatically more valuable than a requested feature.

For animation work, start by exercising the shipped `get_anim_graph` read on an
owned AnimBP with `include_node_properties`, `include_pin_topology` and
`include_pin_defaults`. The July 8 readback and July 12 pin-serialization plans
have implementations; their unchecked historical items are not proof of absence.
Create/rewire AnimGraph nodes is a separate potential authoring slice, explicitly
outside those read-only plans. Define a concrete user workflow before scheduling
it, with graph identity, schema validation, Undo, compile diagnostics and
save/restart verification. Keep Chooser row/result inspection separate.

The sequence below is a reliability/recovery track, not a requirement to finish
all archived fixture proposals before developing user-facing animation tools.

## Recommended follow-up sequence

This is the proposed execution order, not authorization to deploy to consumer
projects or a claim that historical evidence qualifies current source. Build and
live-editor phases run serially in UEMCP-owned hosts; do not overlap port-using
Node suites with native runs.

| Order | Slice | Concrete completion gate |
|---|---|---|
| 1 | Recover provenance for OWN-3a and OWN-1a (engine-free) | Match archived source to the data-flow manifest and frozen-v11 PIE receipt; identify which referenced artifacts still exist, current-main differences, runner dependencies and exact missing checks. Produce one bounded integration/test plan for each. A manifest referencing an unavailable report is not equivalent to having that report. |
| 2 | QA-1 live regression smoke, including F-14 reproduction | On current UE 5.8.3, verify editor/project identity, representative read/write commands, PIE start, actual stop completion before the next operation, and PIE screenshot output. Preserve native, MCP, rendered and UI proof separately. Use recovered ordinary PIE machinery only after it is reconciled; late-callback injection is a separate slice. |
| 3 | BUG-3 timer result correctness | Reproduce compile-failure and ghost-event link-failure paths in an owned fixture, fix inaccurate result fields, and add failure-sensitive native regressions. Source still sets timer `compiled` from the request flag; do not close this from unrelated Blueprint passes. |
| 4 | OWN-3a data-flow integration | Port the smallest useful fixture/runner changes onto current main, qualify author and separate-process reload, verify the graph oracle and input hashes, and run parser consumers. Start with historical UE 5.6.1 compatibility where needed; explicitly qualify UE 5.8.3 rather than assuming it. |
| 5 | OWN-1a ordinary PIE integration, then OWN-1b late-callback proof | Requalify the ordinary two-cycle workflow first. Only then add the separate injected timeout/fence/drain test with its own fresh process and evidence. |

QA-2 engine/platform qualification becomes a release gate before claiming broader
support. QA-3 rendered/desktop acceptance and OPS-1 target selection precede
consumer rollout. EN-28 confinement and EN-8 unknown-parameter reports should be
reproduced during the relevant smoke checks; a confirmed unsafe write or silently
widened mutation takes priority over fixture expansion. EN-32, broader GAS/data-
asset authoring, telemetry and transport redesign remain workflow-driven rather
than automatic next work.

## Archived fixture recovery readiness

The 39 archived states are overlapping iterations, not 39 independent features.
Keep parent IDs OWN-1 through OWN-4; the suffixes below separate different gates.

| ID | Readiness and historical evidence | Remaining work before integration |
|---|---|---|
| OWN-1a | Advanced recovery candidate: archived late-callback notes reference an accepted frozen-v11 ordinary two-cycle PIE receipt. This pass read that reference, not a complete independently verified receipt chain. | Locate and match the exact source/build/live receipt, reconcile current transport and game-thread scheduling, then qualify owned author/fresh verify and two ordinary PIE cycles on the intended engine. |
| OWN-1b | Implemented proposal with offline controls: late-callback injection is explicitly separate from the accepted ordinary PIE run. Its notes require fresh native validation. | Review the serial supervisor, compile the exact integrated source and prove real timeout, receipt-thread fencing, callback exclusion and post-editor drainage in a fresh process. Ordinary PIE success does not discharge this gate. |
| OWN-2 | Engine-specific World reader/authority proposal, with historical evidence references and UE 5.6 package-layout assumptions. | Reconcile the exact source and receipts, review engine compatibility and exact-request discovery, then qualify author/separate-reload behavior. No completion percentage assigned. |
| OWN-3a | Advanced recovery candidate: the archived data-flow qualification manifest records UE 5.6.1 author and separate-process reload passing with exit 0, source/asset/oracle hashes and cleanup results. | Verify referenced artifact availability and bindings (the manifest contains references outside the archive), reconcile the fixture and runner with main, and rerun on the integrated source. Historical success is stronger than an unexecuted proposal, but is not current-main qualification. |
| OWN-3b | Blueprint persistence fixture iterations retained; this review has not established a complete accepted execution chain for them. | Audit their source and receipts independently, choose the missing save/reload witness, and qualify its multi-process runner. Data-flow or material persistence proof must not be substituted. |
| OWN-4 | Details paging fixture: eight mocked API controls passed; the receipt explicitly says `nativeExecution: false`. | Qualify the Python-enabled owned-host fixture and actual editor/rendered paging behavior before treating it as usable runtime coverage. |

Local recovery index: `docs/audits/worktree-cleanup-2026-11-07/RECONCILIATION.md`.
The ignored `legacy-evidence.zip` contains the data-flow
`actual-byte-corpus/qualification-manifest.json` and Details
`fixture-controls-v2.json`; `retained-source/native-window-late-20261008-v1.zip`
contains `files/docs/owned-pie-late-callback.md`. The verified history bundle and
per-worktree patches preserve source recovery. These are local evidence pointers,
not public links or a substitute for checking the underlying receipts.

## Retained correctness and workflow reports

These entries are not all freshly reproduced. Reproduce the named behavior in
an owned fixture before implementing or declaring closure.

| ID | Status | Remaining scope |
|---|---|---|
| BUG-3 | Source-confirmed; runtime reproduction pending | Blueprint timer result uses the requested compile flag even on compilation failure; its ghost-event link-failure path needs consistent `enabled_ghost` reporting. See `BlueprintHandlers.cpp`, `HandleAddBlueprintTimer`, and its native tests. |
| F-14 | Needs reproduction | PIE teardown completion can lag `RequestEndPlayMap`; verify the stop/next-operation boundary rather than treating request acceptance as completed teardown. |
| FText histories | Source-confirmed limitation | `uasset-parser.mjs` still rejects unsupported FText HistoryType values beyond the supported cases. Add representative fixtures before extending decoding. |
| EN-28 residual | Needs reproduction | Check output-path confinement for `take_screenshot` and `get_asset_preview_render`; the dedicated editor-capture tools already confine their output. |
| EN-8 P1/P6 | Needs reproduction | Unknown-parameter rejection, ergonomic aliases and bounded asset-registry output. Historical report: a misspelled path filter silently widened the query. |
| EN-8 P3 | Needs reproduction / capability design | Project-wide reverse references and call-site search, with discoverable tools and explicit offline fidelity. |
| EN-8 P2/P4 | Partly implemented | Subobject traversal exists. Remaining report asks for GameplayEffect cue/component decoding and a runtime spawn/reference summary or documented recipe. |
| EN-8 P5 / EN-4 | Deferred capability | Graduate MakeStruct/BreakStruct and selected math/comparison K2Nodes into supported inspection; demand and fixtures determine the subset. |
| EN-8 P7 | Needs re-triage | Editor-requirement metadata exists. Define and add useful per-tool offline-fidelity hints rather than claiming the old request is wholly absent. |
| Animation/Chooser residual | Product workflow validation / remaining readback design | `get_anim_graph` is shipped with state machines, states, transitions, slot names, layered-blend settings/branch filters and optional visual pin topology/defaults. Validate those existing reads on an owned AnimBP before defining missing fields. Chooser row-to-result mapping and any additional static blend fields remain separate gaps to reproduce. Runtime-evaluated blend output is not static graph readback. |

Sources: [original animation audit](limitations-from-project-a-animation-audit-2026-06-18.md),
[follow-on queue with scope-to-commit correspondence](../superpowers/plans/2026-06-18-live-usage-follow-on-queue.md),
and [decision log](risks-and-decisions.md). Their old unchecked boxes do not
establish that an item is still open.

## Maintenance and enhancements awaiting a trigger

| ID | Remaining work | Trigger |
|---|---|---|
| EN-1 | Asset-registry min/max size filtering | Asset-size audit workflow. |
| EN-3 | Compare agent configuration/tool coverage between projects | Recurring infrastructure drift. |
| EN-5 | Automated YAML parameter declarations versus handler reads | Next schema-drift recurrence or focused maintenance slice. |
| EN-30 | Purpose-built data-asset writers and GAS authoring with explicit dirty/save/Undo guarantees | Concrete authoring workflow; existing generic live mutation is not equivalent qualification. |
| T-1b/c | Migrate remaining project-dependent tests/oracles to synthetic, engine or owned-host fixtures | CI portability or fixture drift. Existing owned runners are progress, not proof that all legacy dependencies are gone. |
| OWN-1 | Ordinary PIE recovery (OWN-1a) and separate late-callback proposal (OWN-1b) | Follow the readiness and execution gates above; ordinary historical success must not be described as an entirely untested proposal. |
| OWN-2 | Archived World map reader/authority proposals | Review the UE 5.6 package-layout assumptions, engine matrix and exact-request discovery before integrating author/separate-reload coverage. |
| OWN-3 | Advanced data-flow recovery (OWN-3a) and separately audited Blueprint persistence (OWN-3b) | Recover exact evidence first, then qualify the smallest current-source owned author/reload slice. |
| OWN-4 | Archived Python Details-paging fixture | Explicit Python-enabled owned-host workflow and rendered paging acceptance; pure PIE pixel normalization does not qualify it. |
| FX-1 | TMap Blueprint CDO owned-host fixture | A parser regression that synthetic coverage cannot represent. |
| EN-23 | Structured native duration reporting, per-tool cache metrics, connection/error lifecycle metrics, memory/rotation costs and final metric flush | Before a transport/cache performance decision. Wire timings and native hitch-duration logging already exist. |
| EN-22 | Supplemental editor event push over WebSocket | Measured cache/readiness/progress need; no transport rewrite scheduled. |
| DR-1 | Offline pin tracing beyond the current supported reader | Workflow pressure with a reliable sidecar/native oracle. |
| DR-2 | Full-fidelity graph-byte parsing | Architectural change; otherwise explicitly deferred, with editor/sidecar paths preferred. |
| Legacy follow-on proposals | Reassess FExpressionInput/FieldPath parsing, int64 VFX report, broad refactor and full 3F scope | Reproduce/define the remaining gap first. A narrow sidecar writer and save hook already exist. |

## Completed items removed from the active queue

| Work | Completion / qualification |
|---|---|
| HY-1: fixture metadata isolation | Fixture-only stdio launcher; production registration remains enabled. Full rotation preserved both codename ledgers and the target registry byte-for-byte. |
| HY-2: Windows test shell selection | Explicit Git Bash resolution passes with the WSL launcher first on PATH; no environment workaround. |
| HY-3: CRLF hook token lists | Both hooks accept clean content and reject protected names with CRLF token files. See [test hygiene](../specs/test-hygiene.md). |
| OPS-2: historical worktree reconciliation | Four missing fixes recovered; 14 superseded snapshots identified; 39 proposal/evidence states preserved for OWN-1 through OWN-4. Local recovery bundle, per-worktree patches and decisions are in ignored `docs/audits/worktree-cleanup-2026-11-07/`. No existing test lane was removed. |
| Recovered Blueprint parents, PIE pixel alpha, management responses and mutation classification | [PR #64](https://github.com/noahbutcher97/UEMCP/pull/64). UE 5.8.3 build, 2/2 focused native cases and 15/15 Blueprint cases passed; rendered screenshots and consumer deployment remain unverified. |
| Extensionless map paths | [PR #56](https://github.com/noahbutcher97/UEMCP/pull/56). |
| UE material parameter APIs, override verification and FName casing | [PR #57](https://github.com/noahbutcher97/UEMCP/pull/57). |
| Full material parameter identities and layer/blend writes | [PR #58](https://github.com/noahbutcher97/UEMCP/pull/58). Names-only/global-only is not the current limitation. |
| Global parameter Undo and owned lifecycle runner | [PR #59](https://github.com/noahbutcher97/UEMCP/pull/59). |
| Owned MCP/HTTP material verification | [PR #60](https://github.com/noahbutcher97/UEMCP/pull/60). |
| EN-31: project/editor transport isolation | [PR #61](https://github.com/noahbutcher97/UEMCP/pull/61). Project ports and exclusive socket binding exist; the old claim of no configuration surface is retired. |
| Scalar material-function authoring and clean frame-context dispatch | [PR #62](https://github.com/noahbutcher97/UEMCP/pull/62). UE 5.8.3 host: Undo/Redo, positive compiled shaders, independent topology oracle, persistence, clean editor logs. |

Older shipped EN/BUG items remain in the historical snapshot and Git history.
Do not carry them forward as active work merely because an old plan has an
unticked checkbox.
