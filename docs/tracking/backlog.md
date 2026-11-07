# UEMCP backlog and triage

Reconciled 2026-11-07 against main through PR #62 (`15de65d`), current source,
and the owned-host verification from that change. GitHub had no open issues or
PRs at reconciliation. This file is the active index; old checklists are not
completion evidence. Preserve IDs when moving work into a handoff or PR, and
replace the row with a completion link when it ships.

Status meanings: **verified** identifies inspected implementation or recorded
runtime evidence; **needs reproduction** preserves an older report without
claiming it was reproduced today; **deferred** requires the stated trigger.
All new runtime tests use UEMCP-owned hosts. Do not plant fixtures in external
projects. Historical rationale is retained in the [September notes preserved at PR #62](https://github.com/noahbutcher97/UEMCP/blob/15de65d5b04c717309fb4aaff228b0f8385d9791/docs/tracking/backlog.md).

## Current work and next qualification

| ID | Status | Work / acceptance |
|---|---|---|
| QA-1 | Open qualification | Exercise existing live tools after PR #62's game-thread scheduling change. Existing graph/MCP and parameter-host gates pass, but they do not qualify every tool. |
| QA-2 | Open qualification | Run the supported-engine compilation/runtime matrix for the new material graph surface. UE 5.8.3 Win64 D3D12/SM5 is verified; other versions/platforms and rendered appearance are not. |
| QA-3 | Open qualification | Desktop client/editor UI acceptance remains separate from the completed terminal-client and transport-isolation proof. Shared-directory concurrent asset edits are not made safe by port isolation. See [session isolation](../project-session-isolation.md). |
| EN-32 | Deferred capability | Extend scalar material functions with typed vector/texture inputs and nodes, more math, function instances, layer/blend functions and safe interface edits. Choose one workflow-driven slice with its own host oracle, Undo and persistence gate. |
| OPS-1 | Pending explicit target selection | Roll out plugin 1.0.24 to intended consumer projects, with deployment verification and editor/client restart. The PR #62 run deployed only to a disposable owned host. |

PR #62's graph edits/connections have verified Undo/Redo and save/restart
persistence. Function asset allocation is explicitly not undoable, propagation
is not one atomic reversible transaction, and transport timeouts leave unknown
outcomes. These are documented contract boundaries, not unreported passing tests.
See [the material-function contract](../specs/material-function-authoring.md).

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
| Animation/Chooser residual | Needs reproduction / capability design | Chooser row-to-result mapping and deeper AnimGraph slot/blend properties. Montage/sequence reads and AnimGraph listing already received fixes; do not reopen the entire historical report as broken. |

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
| OWN-1 | Archived native PIE ownership, property witness and late-callback proposals | Reconcile the historical UE 5.6 contracts with current transport; qualify a bounded serial supervisor, author/reload, two live cycles and injected late-callback drainage. Preserve historical receipts without carrying proof across changed source. |
| OWN-2 | Archived World map reader/authority proposals | Review the UE 5.6 package-layout assumptions, engine matrix and exact-request discovery before integrating author/separate-reload coverage. |
| OWN-3 | Archived Blueprint persistence and data-flow fixture iterations | Choose a concrete missing witness, preserve existing coverage, and qualify an owned multi-process author/reload runner. Material persistence does not discharge this gap. |
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
