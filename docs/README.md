# UEMCP Documentation

**Source of truth for tool definitions**: [tools.yaml](../tools.yaml)
**Authoritative project-state snapshot**: [CLAUDE.md](../CLAUDE.md) at repo root

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
├── audits/                — point-in-time reports (never edited after creation)
├── testing/               — manual-test deliverables tied to specific milestones
└── tracking/              — living docs (risks-and-decisions.md, backlog.md)
```

## Reading order

**New contributor / agent onboarding**:
1. `../CLAUDE.md` — current project state, test baseline, in-flight dispatches, design rules
2. `specs/architecture.md` — 4-layer model
3. `specs/dynamic-toolsets.md` — how the tool-surface loads
4. `../tools.yaml` — tool definitions (single source of truth per D44)
5. `tracking/risks-and-decisions.md` — D1-D65 decision log (load-bearing context)

**Quick reference during work**:
- `tools.yaml` for tool lookup
- `tracking/backlog.md` for in-flight + queued dispatches
- `tracking/risks-and-decisions.md` for decision rationale

**Phase 3 context** (current phase):
- See `tracking/risks-and-decisions.md` D58/D77/D87 for the current Phase 3 wave structure; session-local research and handoffs (in `research/`, `handoffs/`) are not tracked.

---

## File index

### specs/ — system design
| File | Covers |
|---|---|
| [architecture.md](specs/architecture.md) | 4-layer architecture, auto-detection chain, caching |
| [plugin-design.md](specs/plugin-design.md) | Custom C++ plugin design, TCP protocol, command routing |
| [dynamic-toolsets.md](specs/dynamic-toolsets.md) | Always-loaded tools, ToolIndex scoring, alias expansion |
| [tool-surface.md](specs/tool-surface.md) | Tool count summary, toolset registry |
| [blueprint-introspection.md](specs/blueprint-introspection.md) | Graph serialization design, visual capture |
| [configuration.md](specs/configuration.md) | `.mcp.json` config, env vars, ConnectionManager |
| [conformance-oracle-contracts.md](specs/conformance-oracle-contracts.md) | All 36 UnrealMCP command contracts (Phase 2 reference) |
| [tcp-protocol.md](specs/tcp-protocol.md) | Wire format, command/response schema |
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
Self-contained task specs for individual workers. Each handoff has its own lifecycle — active briefs dispatch, complete, and remain as historical record.

Recent in-flight / recently-shipped handoffs are tracked in [tracking/backlog.md](tracking/backlog.md).

### audits/ — point-in-time reports
Snapshots — never edited after creation. Audit findings are folded into the D-log entries in [tracking/risks-and-decisions.md](tracking/risks-and-decisions.md); the audit files themselves are session-local artifacts kept on the maintainer's local checkout (matching how `handoffs/`, `research/`, `testing/` are described above).

### testing/ — manual verification reports
Manual-test deliverables tied to specific milestones. Tracks what humans verified vs what automation covers.

### tracking/ — living documents
Updated continuously across sessions.
| File | Covers |
|---|---|
| [risks-and-decisions.md](tracking/risks-and-decisions.md) | Decision log D1-D65 + risk table |
| [backlog.md](tracking/backlog.md) | In-flight dispatches, queued waves, recently-shipped items, enhancement candidates |
