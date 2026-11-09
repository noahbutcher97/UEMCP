# Roadmap starting slices

These are independently selectable tasks from the [work-unit map](plan.md),
not a sequential checklist. The [backlog](../docs/tracking/backlog.md) retains
status and historical evidence. Checkboxes track planning/delivery milestones, not a reset of
already shipped capabilities. Each row is a starting slice, not the entire unit.

| Task | Acceptance and verification | Dependency / likely area |
|---|---|---|
| [ ] U1a: truthful timer failures (BUG-3) | Owned compile-failure and ghost-link-failure cases report actual results; focused native regressions and plugin compilation pass. | None; Blueprint handler and its tests. |
| [ ] U2a: stop/next-operation lifecycle (QA-1, F-14) | Verify identity, read/write and two ordinary PIE cycles, including actual teardown before the next operation. Retain native/MCP evidence separately. | Reconcile any recovered runner before using it; PIE handler and owned runner. |
| [ ] U3a: capture confinement (EN-28) | Reproduce both screenshot/preview paths; reject invalid output locations and inspect valid rendered output. | None; capture handlers and focused tests. |
| [ ] U4a: shipped AnimGraph read qualification | Owned AnimBP oracle agrees with properties, topology and defaults; document actual missing fields without treating existing tools as absent. | None; animation fixture, runner and read handler only if a defect is found. |
| [x] U5a: scope the first AnimGraph edit | [Slot-insertion contract](../docs/plans/u5-animation-authoring.md) records identity, schema, failure, Undo and persistence requirements with engine-source findings. Runtime feasibility and upstream equivalence remain implementation gates. | Scoping complete; implementation not started. |
| [ ] U5.1-U5.3: deliver the scoped Slot edit | Follow fixture/preflight, mutation and MCP lifecycle gates in the U5 contract; do not expose unfinished authoring. | U5a; upstream-equivalence check, then serial owned-host verification. |
| [ ] U6a: define one vector material workflow (EN-32) | Enumerate minimum typed inputs/nodes and expected compiled graph; specify independent oracle and lifecycle tests before implementation. | Workflow selection; material authoring contract. |
| [ ] U7a: registry query reproduction (EN-8 P6) | Known corpus demonstrates filter/alias/output bounds and truncation; split unknown-parameter rejection into U1 if reproduced. | None; registry tools and fixtures. |
| [ ] U8a: select one gameplay asset mutation (EN-30) | Define asset type, validation, write/readback, dirty/save, Undo and restart contract; identify an owned fixture. | Concrete authoring workflow; asset/GAS design. |
| [ ] U9a: data-flow provenance audit (OWN-3a) | Match available source, manifest and receipts; enumerate missing artifacts and exact current-main differences; produce one bounded integration plan. No historical proof carried onto changed bytes. | Local recovery archive access; evidence report, no editor needed. |
| [ ] U10a: support and desktop acceptance scope | Record intended supported combinations and one owned desktop-client/editor acceptance script, with separate transport/UI/rendered checks. | None for scope; native slot for execution; support/test docs. |
| [ ] U11a: performance/fidelity decision brief, when triggered | Identify a user-visible problem, existing measurements and minimum missing experiment; explicitly defer redesign if no need is established. | Measured need; profiling/design docs. |
| [ ] U12a: establish audit baseline | Apply AUD-1 organization reconciliation and capture upstream revisions/activity for the initial AUD-3 watchlist; refresh U5 decision-driving research under AUD-2. Record bounded actions or no relevant change. | [Audit policy](../docs/tracking/ecosystem-watch.md); initial discovery exists, full audit pending. |

## Checkpoint for every selected slice

- [ ] Bound the implementation handoff, exact verification commands and resources.
- [ ] Complete applicable tests and review; retain failures, skips and proof limits.
- [ ] Update the backlog with completion evidence or a precise remaining gap.
- [ ] Clean owned temporary outputs/processes and reconcile checkout and linked checkout list.

Follow-ups within each unit are described in the work-unit map and backlog;
promote only the next useful slice into a concrete handoff. This avoids creating
another large inventory of speculative tasks that duplicates the roadmap.
