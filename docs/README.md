# UEMCP Documentation

**Source of truth for tool definitions**: [tools.yaml](../tools.yaml)

---

## Directory Structure

```
docs/
├── README.md              ← you are here
├── specs/                 — what the system IS (architecture, protocols, design)
│   ├── architecture.md        4-layer architecture, design decisions D1-D6, auto-detection
│   ├── blueprint-introspection.md  Graph serialization, NodeToCode comparison, visual capture
│   ├── configuration.md       .mcp.json configs, env vars, ConnectionManager design
│   ├── dynamic-toolsets.md    ToolIndex search algorithm, scoring tiers, alias expansion
│   ├── plugin-design.md       UE5 plugins, custom C++ plugin, TCP protocol, command routing
│   ├── conformance-oracle-contracts.md  All 36 UnrealMCP C++ command contracts (Phase 2 reference)
│   ├── tcp-protocol.md        Wire format, command/response schema, connection lifecycle
│   └── tool-surface.md        Tool count summary, toolset registry (points to tools.yaml)
├── plans/                 — what we're DOING (phases, testing)
│   ├── implementation.md      6-phase build sequence with step-by-step instructions
│   └── testing-strategy.md    Test cases 1-43 organized by phase
├── audits/                — what we FOUND (point-in-time snapshots, never edited after)
│   └── (audit reports go here)
└── tracking/              — living state (updated continuously across sessions)
    └── risks-and-decisions.md  Risk table, decision log D1-D23, future enhancements
```

## Reading Order

**First read**: specs/architecture.md → specs/plugin-design.md → specs/dynamic-toolsets.md → tools.yaml → plans/implementation.md

**Quick reference**: tools.yaml (tool lookup) → specs/dynamic-toolsets.md (search algorithm) → tracking/risks-and-decisions.md (decision rationale)

**Implementation**: plans/implementation.md (phases) → specs/configuration.md (setup) → specs/plugin-design.md (C++ details) → specs/blueprint-introspection.md (serialization)

**Phase 2 (TCP client)**: specs/conformance-oracle-contracts.md → specs/tcp-protocol.md → plans/testing-strategy.md (Tests 9-13) → audits/phase1-audit-2026-04-12.md (for context on what's already been verified)

## File Index

### specs/ — System Design

| File | Covers |
|------|--------|
| [architecture.md](specs/architecture.md) | Problem statement, 4-layer architecture diagram, design decisions D1-D6, auto-detection chain, caching strategy |
| [plugin-design.md](specs/plugin-design.md) | Recommended editor plugins (RC, Python, Geometry Script), custom UEMCP C++ plugin design, TCP protocol, command routing |
| [dynamic-toolsets.md](specs/dynamic-toolsets.md) | Why dynamic toolsets, always-loaded tools, toolset registry, ToolIndex search algorithm, scoring tiers, alias expansion, typical workflows |
| [tool-surface.md](specs/tool-surface.md) | Lightweight summary pointing to tools.yaml. Quick-reference count table, notes on existing plugin tools |
| [blueprint-introspection.md](specs/blueprint-introspection.md) | NodeToCode comparison, serialization design for all graph types (AnimBP, Widget, Material), visual capture architecture |
| [configuration.md](specs/configuration.md) | `.mcp.json` configs for both projects, environment variables, ConnectionManager class design, health check caching |
| [conformance-oracle-contracts.md](specs/conformance-oracle-contracts.md) | All 36 UnrealMCP C++ command handlers: params, result schemas, error conditions, gotchas. Phase 2 ground truth. |
| [tcp-protocol.md](specs/tcp-protocol.md) | Wire format, command/response schema, connection lifecycle, error handling |

### plans/ — Implementation

| File | Covers |
|------|--------|
| [implementation.md](plans/implementation.md) | New/modified file manifest, 6-phase implementation sequence with step-by-step instructions |
| [testing-strategy.md](plans/testing-strategy.md) | Phase-by-phase test cases (Tests 1-43), acceptance criteria |

### audits/ — Point-in-Time Reports

Audit reports are snapshots — they record what was found at a specific time and are never edited after creation.

| File | Covers |
|------|--------|
| [phase1-audit-2026-04-12.md](audits/phase1-audit-2026-04-12.md) | Phase 1 implementation audit: 3 critical, 5 high, 5 medium, 4 low findings. All critical/high fixed. |

### tracking/ — Living Documents

| File | Covers |
|------|--------|
| [risks-and-decisions.md](tracking/risks-and-decisions.md) | Risk analysis table (20+ rows), audit-discovered risks with dispositions, UE5 API verification, future enhancements (17 items), decision log D1-D23 |
