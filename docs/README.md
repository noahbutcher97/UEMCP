# UEMCP Documentation

**Source of truth for tool definitions**: [tools.yaml](../tools.yaml)
**Working conventions and implementation overview**: [CLAUDE.md](../CLAUDE.md)
**Current triage and proof boundaries**: [backlog.md](tracking/backlog.md)

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

**Quick reference during work**:
- `tools.yaml` for tool lookup
- `tracking/backlog.md` for current triage, retained reports and completion links
- `tracking/risks-and-decisions.md` for decision rationale

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
| [architecture.md](specs/architecture.md) | Current transport architecture, auto-detection chain, caching |
| [plugin-design.md](specs/plugin-design.md) | Custom C++ plugin design, TCP protocol, command routing |
| [dynamic-toolsets.md](specs/dynamic-toolsets.md) | Always-loaded tools, ToolIndex scoring, alias expansion |
| [tool-surface.md](specs/tool-surface.md) | Tool count summary, toolset registry |
| [blueprint-introspection.md](specs/blueprint-introspection.md) | Graph serialization design, visual capture |
| [configuration.md](specs/configuration.md) | `.mcp.json` config, env vars, ConnectionManager |
| [deployment-machine-interface.md](specs/deployment-machine-interface.md) | Transactional deployment CLI, plan/apply contract, receipts, and outcomes |
| [client-adapters.md](specs/client-adapters.md) | Claude, Codex, Gemini, and VS Code support gates and proof boundaries |
| [conformance-oracle-contracts.md](specs/conformance-oracle-contracts.md) | Archival Phase 2 conformance reference; not a current setup or runtime guide |
| [tcp-protocol.md](specs/tcp-protocol.md) | Archival retired-bridge wire-format reference; not a current setup or runtime guide |
| [phase3-plugin-design-inputs.md](specs/phase3-plugin-design-inputs.md) | Phase 3 plugin-layer design inputs (P0 helpers, envelope) |

### plans/ — implementation
| File | Covers |
|---|---|
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
