# Unreal MCP Hybrid Server — Comprehensive Plan v2

**Date**: 2026-04-11
**Author**: Noah / Claude
**Status**: DRAFT v2 — Updated with clarifications and expanded research
**Supersedes**: `unreal-mcp-hybrid-plan.md` (v1)

> **Source of truth for tool definitions**: [tools.yaml](../tools.yaml)
> All tool names, descriptions, toolset membership, layers, priorities, and param stubs are defined there. Markdown files reference it instead of duplicating tables.

---

## Summary of Changes from v1

| Decision | v1 | v2 |
|----------|----|----|
| ProjectB feature parity | Open question | **Full parity** — both projects get everything |
| Existing C++ plugin | Left untouched | **Still untouched** — new custom plugin alongside it |
| Python MCP server files | Open question | **Leave as-is** in Perforce — new server is separate |
| Multi-project routing | Static port config | **Auto-detection** via process inspection + fallback chain |
| RC Components plugin | Open question | **Yes, enable** in both projects |
| Additional UE5 plugins | Not researched | **Researched** — recommendations below |
| New C++ plugin | Not in scope | **In scope** — separate plugin on port 55558 |
| Implementation order | 5 phases | **6 phases** (added C++ plugin phase) |

---

## Table of Contents

| File | Covers | Description |
|------|--------|-------------|
| [tools.yaml](../tools.yaml) | Tool definitions | **Single source of truth** — 6 management tools + 15 toolsets (108 tools) = 114 total. Includes aliases, params stubs, layer assignments, priorities. |
| [architecture.md](architecture.md) | Architecture & Auto-Detection | Problem statement, 4-layer architecture diagram, design decisions D1-D6, auto-detection chain, caching strategy. |
| [plugin-design.md](plugin-design.md) | UE5 Plugins & C++ Plugin | Recommended editor plugins (RC, Python, Geometry Script), custom UEMCP C++ plugin design, TCP protocol, command routing. |
| [dynamic-toolsets.md](dynamic-toolsets.md) | Dynamic Toolset Design | Why dynamic toolsets, always-loaded tools, toolset registry, ToolIndex search algorithm, scoring tiers, alias expansion, typical workflows. |
| [tool-surface.md](tool-surface.md) | Tool Surface Area | Lightweight summary pointing to tools.yaml. Quick-reference count table, notes on existing plugin tools. |
| [blueprint-introspection.md](blueprint-introspection.md) | Blueprint Introspection & Visual Capture | NodeToCode comparison, serialization design for all graph types (AnimBP, Widget, Material), visual capture architecture. Largest file. |
| [implementation.md](implementation.md) | File Changes & Phases | New/modified file manifest, 6-phase implementation sequence with step-by-step instructions. |
| [configuration.md](configuration.md) | Configuration & Connection | `.mcp.json` configs for both projects, environment variables, ConnectionManager class design, health check caching. |
| [risks-and-decisions.md](risks-and-decisions.md) | Risks, Future & Decisions | Risk analysis table (21 rows), future enhancement ideas, decision log D1-D13. |

---

## Reading Order

For **first read**: architecture.md -> plugin-design.md -> dynamic-toolsets.md -> tools.yaml -> implementation.md

For **quick reference**: tools.yaml (tool lookup) -> dynamic-toolsets.md (how search works) -> risks-and-decisions.md (decision rationale)

For **implementation**: implementation.md (phases) -> configuration.md (setup) -> plugin-design.md (C++ details) -> blueprint-introspection.md (serialization specs)
