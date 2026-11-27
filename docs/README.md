# UEMCP Documentation

**Source of truth for tool definitions**: [tools.yaml](../tools.yaml)
**Working conventions and implementation overview**: [CLAUDE.md](../CLAUDE.md)
**Current triage and proof boundaries**: [backlog.md](tracking/backlog.md)
**Roadmap work units and available paths**: [work-unit map](../tasks/plan.md)
**Animation authoring priority**: [U5 program](plans/animation-authoring-program.md)
**Animation research and execution modes**: [ad hoc editing, recipes and offline support](plans/animation-authoring-execution.md)
**Interactive animation authoring**: [Event Graph blend](plans/animbp-interactive-authoring.md) and [montage Slot insertion](plans/u5-animation-authoring.md)

To bind an Enhanced Input action or play a named sequence, see the [public graph operations](plans/asset-backed-graph-actions.md#using-the-public-operations) and [engine and agent results](plans/graph-action-placement-qualification.md).
**Organization and research upkeep**: [ecosystem watch and audits](tracking/ecosystem-watch.md)

For local build and editor output, start with the [shared task directory and fixture examples](fixture-host.md#stage-a-fresh-host) and follow the [cleanup protocol](../AGENTS.md#worktree-and-scratch-cleanup).

For new-machine onboarding see the main [README.md](../README.md) at repo root.

---

## Directory Structure

```
docs/
├── README.md              ← you are here
├── specs/                 — what the system IS (architecture, protocols, design)
├── plans/                 — what we're DOING (phases, testing)
├── research/              — scope-refresh / feasibility / re-sequence deliverables
├── handoffs/              — dispatched worker briefs (self-contained task specs)
├── reports/               — worker return reports and recommendations
├── audits/                — point-in-time reports (never edited after creation)
├── testing/               — manual-test deliverables tied to specific milestones
└── tracking/              — living docs (risks-and-decisions.md, backlog.md)
```

## Reading order

**New contributor / agent onboarding**:
1. `../CLAUDE.md` — current project state, test baseline, in-flight dispatches, design rules
2. `specs/architecture.md` — current transport model
3. `specs/dynamic-toolsets.md` — how the tool-surface loads
4. `../tools.yaml` — tool definitions (single source of truth per D44)
5. `tracking/risks-and-decisions.md` — historical decisions (load-bearing context)

## Find information by question

Use the relevant route before answering capability questions or proposing work,
including during planning conversations. Read only the sources needed for the
question; this is not a requirement to audit the whole repository each time.

| Question | Start here | Follow through when needed |
|---|---|---|
| Where is the UEMCP-owned test project for a particular engine? | [Locate an owned fixture host](fixture-host.md#locate-an-owned-host-by-engine) | Check the workstation inventory and the host manifest for its engine, source revision and file hashes before choosing a build target. |
| Is a capability shipped, and what are its limits? | [Tool definitions](../tools.yaml), then the relevant [capability contract](#specs--system-design) | Check [backlog](tracking/backlog.md) qualification gaps and completion links. Inspect the registered server tool and native handler if the contract does not settle the question. A shipped tool name does not imply unrestricted editing. |
| What should we work on next? | [Backlog](tracking/backlog.md) for status, [work units](../tasks/plan.md) for grouping, [starting slices](../tasks/todo.md) for bounded candidates | Check the relevant contract and existing implementation before proposing a new capability or abstraction. Planning choices are not evidence that work is shipped or missing. |
| Where is a tool implemented, and can we reuse it? | [Tool definitions](../tools.yaml) and [dynamic toolsets](specs/dynamic-toolsets.md) | Search the tool name in `server/` and its wire command in `plugin/UEMCP/Source/`; follow registration, handler and focused tests. See [working conventions](../CLAUDE.md) before changing code. |
| What has actually been verified? | The capability contract's verification section and [backlog evidence](tracking/backlog.md) | Follow linked tests, PRs and receipts; check revision, engine, platform and whether evidence is mocked, native, live, persisted or rendered. Source inspection and a passing test on an older build do not establish current runtime behavior. |
| How do attachment, transport, deployment and client support work? | [Architecture](specs/architecture.md), [configuration](specs/configuration.md), [deployment contract](specs/deployment-machine-interface.md), [client support](specs/client-adapters.md) | Use the [root setup guide](../README.md) for commands. Recheck the actual target/deployment when answering a project-specific question. |
| Why was a decision made, or should we revisit peer research? | [Decision history](tracking/risks-and-decisions.md), [research freshness and ecosystem policy](tracking/ecosystem-watch.md) | Follow the underlying source or receipt and check for superseding decisions. Historical research and worker reports are pointers, not current implementation proof. |
| Can a person complete the workflow through an agent CLI? | [Agent workflow usability protocol](agent-workflow-usability.md) | Exercise a plain-language task and verify the editor result independently. |
| How should tests or fixtures change? | [Testing guidance](../AGENTS.md#testing-guidelines), [test hygiene](specs/test-hygiene.md), [test retirement](test-retirement.md) | Use the relevant owned-host workflow and existing tests; distinguish fixture/test changes from verified product behavior. |

In an answer or recommendation, name the relevant sources and distinguish shipped
behavior, shipped limitations, planned work and unverified claims. If documentation
and code disagree, state the discrepancy and inspect the narrow implementation or
evidence needed to resolve it; do not silently select the more convenient account.

For example, material graph support requires both the tool entries and the
[material-function contract](specs/material-function-authoring.md); material
parameter editing has a [separate contract](specs/material-parameter-tools.md).
Animation authoring's [program](plans/animation-authoring-program.md) describes
target scope, not a list of already callable tools.
The [animation qualification record](plans/animation-authoring-qualification.md) lists tested engine and CLI behavior. The [playable character audit](audits/2026-11-21-playable-animation.md) records evaluated motion and remaining authoring gaps. The [inspection and montage decisions](plans/animation-inspection-and-montage-decisions.md) record the subsequent engine and CLI checks.

When a capability or its status changes, update its existing contract and backlog
entry, and add or repair the route here if needed. Keep capability details in their
own contracts rather than copying them into agent instructions or another status
inventory. Session-local research may be absent on another machine; durable
public conclusions should remain discoverable through tracked documentation.

For DataAsset authoring, see [creation and explicit saving](plans/editor-workflow-gaps.md#1-create-a-dataasset) and [editing a numeric field or whole vector](plans/editor-workflow-gaps.md#2-edit-nested-dataasset-properties). To switch the active editor world and preserve unsaved level edits, see [opening a saved map](plans/editor-workflow-gaps.md#3-open-an-editor-map).

**Historical phase-planning context**:
- See `tracking/risks-and-decisions.md` D58/D77/D87 for historical Phase 3 sequencing; session-local research and handoffs (in `research/`, `handoffs/`) are not tracked.

---

## Test migration and retirement

[Test retirement protocol](test-retirement.md) defines required equivalence evidence, independent review, explicit retirement approval, and recovery records before removing existing coverage.

## File index

### specs/ — system design
| File | Covers |
|---|---|
| [material-function-authoring.md](specs/material-function-authoring.md) | Typed scalar function graphs, revisions, Undo and host verification |
| [material-parameter-tools.md](specs/material-parameter-tools.md) | Material parameter identity, values and mutation behavior; separate from expression graph authoring |
| [architecture.md](specs/architecture.md) | Current transport architecture, auto-detection chain, caching |
| [plugin-design.md](specs/plugin-design.md) | Custom C++ plugin design, TCP protocol, command routing |
| [dynamic-toolsets.md](specs/dynamic-toolsets.md) | Always-loaded tools, ToolIndex scoring, alias expansion |
| [tool-surface.md](specs/tool-surface.md) | Tool count summary, toolset registry |
| [blueprint-introspection.md](specs/blueprint-introspection.md) | Graph serialization design, visual capture |
| [configuration.md](specs/configuration.md) | `.mcp.json` config, env vars, ConnectionManager |
| [test-hygiene.md](specs/test-hygiene.md) | Fixture metadata isolation, shell selection and hook regression checks |
| [deployment-machine-interface.md](specs/deployment-machine-interface.md) | Transactional deployment CLI, plan/apply contract, receipts, and outcomes |
| [client-adapters.md](specs/client-adapters.md) | Claude, Codex, Gemini, and VS Code support gates and proof boundaries |
| [conformance-oracle-contracts.md](specs/conformance-oracle-contracts.md) | Archival Phase 2 conformance reference; not a current setup or runtime guide |
| [tcp-protocol.md](specs/tcp-protocol.md) | Archival retired-bridge wire-format reference; not a current setup or runtime guide |
| [phase3-plugin-design-inputs.md](specs/phase3-plugin-design-inputs.md) | Phase 3 plugin-layer design inputs (P0 helpers, envelope) |

### plans/ — implementation
| File | Covers |
|---|---|
| [animation-authoring-program.md](plans/animation-authoring-program.md) | Proposed animation capability scope and delivery boundaries |
| [animation-authoring-execution.md](plans/animation-authoring-execution.md) | Source research and proposed ad hoc, recipe, live and headless workflows |
| [u5-animation-authoring.md](plans/u5-animation-authoring.md) | Montage Slot insertion contract and qualification workflow |
| [implementation.md](plans/implementation.md) | 6-phase build sequence |
| [testing-strategy.md](plans/testing-strategy.md) | Phase-by-phase test cases (Tests 1-43+) |

### research/ — scope + feasibility deliverables
Point-in-time research outputs informing milestone decisions. Append only.
- Phase 3 scope refresh, M-alt commandlet feasibility, MCP-first re-sequence are the load-bearing trio (all 2026-04-20).

### handoffs/ — dispatched worker briefs
Self-contained task specs for individual workers. Handoffs are authored by the orchestrator after reviewing prior work; they are not worker final reports.

Recent in-flight / recently-shipped handoffs are tracked in [tracking/backlog.md](tracking/backlog.md).

### reports/ — worker return reports
Worker-generated final reports, investigation notes, and recommendation docs. The orchestrator reviews these reports, then writes or updates authoritative handoffs in `handoffs/` when follow-up work is ready to dispatch.

### audits/ — point-in-time reports
Snapshots — never edited after creation. Audit findings are folded into the D-log entries in [tracking/risks-and-decisions.md](tracking/risks-and-decisions.md); the audit files themselves are session-local artifacts kept on the maintainer's local checkout (matching how `handoffs/`, `research/`, `testing/` are described above).

### testing/ — manual verification reports
Manual-test deliverables tied to specific milestones. Tracks what humans verified vs what automation covers.

### tracking/ — living documents
Updated continuously across sessions.
| File | Covers |
|---|---|
| [risks-and-decisions.md](tracking/risks-and-decisions.md) | Historical decisions and risk table |
| [backlog.md](tracking/backlog.md) | Active triage, qualification gaps, retained candidates and completion links |

### Test hygiene

See [testing isolation and shell selection](specs/test-hygiene.md) for fixture metadata isolation, Windows Git Bash, and hook token-file regression checks.
