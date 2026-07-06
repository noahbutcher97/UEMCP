# Dynamic Toolset Design

> Source of truth for tool definitions: [tools.yaml](../../tools.yaml)
> Toolset registry, tool counts, and alias map are defined in tools.yaml. This document covers the design rationale, search algorithm, and typical workflows.

## Why Dynamic Toolsets

With 149 YAML-declared tools across the registry (139 active/callable; 10 carry `status: planned` and are hidden), a static tool list would consume a large share of context in tool schema overhead alone. Empirical data from the MCP ecosystem shows model tool-selection accuracy degrades beyond ~30 simultaneously visible tools, with hard failures around 46. GitHub's MCP Server hit the same wall at 101 tools and solved it with dynamic toolsets.

UEMCP uses a hybrid of GitHub's explicit toolsets and Speakeasy's progressive disclosure: 10 always-visible management tools + on-demand project-scoped toolsets + keyword search with guarded auto-enable. Claude typically activates 2-3 toolsets per task instead of the full registry.

## Always-Loaded Tools — 10 tools

These are always visible to Claude regardless of which toolsets are enabled:

| # | Tool | Description |
|---|------|-------------|
| 1 | `connection_info` | Show attachment, editor/deploy/transport readiness dimensions, active layers, and enabled toolsets. |
| 2 | `detect_project` | Report running editor candidates without attaching the session. |
| 3 | `find_tools` | Keyword search across the YAML registry. Auto-enables project-scoped parent toolsets only when a project is attached. |
| 4 | `list_toolsets` | Show all 16 toolsets with: tool count, required layer, layer availability status (connected/unavailable), and enabled/disabled state. This is Claude's orientation tool — call it first to understand what's available. |
| 5 | `enable_toolset` | Explicitly enable one or more toolsets by name. Project-scoped toolsets return `PROJECT_NOT_ATTACHED` while unresolved. |
| 6 | `disable_toolset` | Disable one or more toolsets to free context. Use when switching tasks or when active tool count is getting high. |
| 7 | `list_project_targets` | Read repo-local `.uemcp-targets.json` profiles, or legacy `.uemcp-targets.txt`, and report validated attachment candidates. |
| 8 | `attach_project` | Attach a project for the current MCP session by root, `.uproject`, target alias/profile, running editor, or elicited prompt. |
| 9 | `detach_project` | Clear manual attachment and rerun workspace resolution. |
| 10 | `refresh_project_context` | Re-read roots/candidates and refresh session attachment state. |

## Toolset Registry

| Toolset | Tools | Layer | Description |
|---------|-------|-------|-------------|
| `offline` | 25 | Offline | Project files, configs, gameplay tags, asset/Blueprint static reads, data sources, plugins |
| `actors` | 10 | TCP:55558 | Spawn, delete, transform, properties, viewport, screenshot |
| `blueprints-write` | 27 | TCP:55558 | Create BP, add components, nodes, variables, compile |
| `widgets` | 7 | TCP:55558 | Create UMG widgets, add elements, bind events |
| `gas` | 4 | TCP:55558 | Create/modify GE, create GA, create AttributeSet |
| `blueprint-read` | 8 | TCP:55558 | BP introspection (info, variables, functions, components, dispatchers), Widget BP, Niagara |
| `asset-registry` | 2 | TCP:55558 | Live asset dependencies, referencers, reverse-dependency checks, and DataTable contents |
| `materials` | 5 | TCP:55558 | Create material/instance, set parameters, list parameters, material graph read |
| `animation` | 8 | TCP:55558 | Create montage, sections, notifies, anim sequence info, montage full read, blend space, anim curve data |
| `data-assets` | 6 | TCP:55558 | Create/set/list data assets, curve assets, string tables, struct definitions |
| `geometry` | 4 | TCP:55558 | Procedural mesh, CSG boolean, UV generation, mesh info |
| `input-and-pie` | 11 | TCP:55558 | Input actions, mapping contexts, PIE start/stop/status, console commands, runtime PIE reads |
| `visual-capture` | 5 | TCP:55558 | Asset thumbnails, viewport screenshot, asset preview render, editor tab capture, visual summary |
| `editor-utility` | 8 | TCP:55558 | Editor state, run Python, EUB introspection/run, duplicate/rename/delete assets |
| `sidecar` | 1 | TCP:55558 | Narrow-sidecar regeneration |
| `remote-control` | 8 | HTTP:30010 | RC get/set property, call function, list/describe objects, batch, presets, passthrough |

**Subtotals from `tools.yaml`**: 10 always-loaded management tools plus dynamic project-scoped toolsets. Layer totals are derived from `tools.yaml`; do not hardcode counts outside registry truthfulness tests. There are no active TCP:55557 toolsets in the current registry.

## Tool Deduplication (Audit Fixes)

The v2 tool list had overlapping tools that caused confusion. Resolved as follows:

| Removed | Kept | Reason |
|---------|------|--------|
| `reconnect` (#2 old) | `connection_info` | Reconnect is a parameter on `connection_info` (`force_reconnect: true`). Not worth a separate tool. |
| `get_blueprint_graph` (#81 old) | `get_all_blueprint_graphs` (#95 old, renamed to `get_blueprint_graphs`) | Old #81 returned only EventGraph. #95 returns ALL graphs. Having both confused tool selection. Consolidated into one tool with an optional `graph_name` filter parameter. |
| `list_montage_sections` (#59 old) | `get_montage_full` (#97 old) | Old #59 was a subset of #97. Consolidated — `get_montage_full` returns sections, notifies, slots, blend settings. |
| `get_material_graph` (duplicate in Section 6 + 7.4) | Single `get_material_graph` in `materials` toolset | Was listed in both "Material Commands" and "Expanded Graph Introspection". Now lives only in `materials` toolset. |
| `create_input_mapping` (#46 old) | `create_input_action` + `create_mapping_context` | Legacy input system tool. Enhanced Input tools in `input-and-pie` supersede it. |
| `get_project_info_live` (#91 old) | `project_info` (offline) + `get_editor_state` | Redundant — offline `project_info` covers .uproject data, `get_editor_state` covers live editor info. |

This historical deduplication removed 6 redundant tools from the early v2 design: 120 → 114. That paragraph is preserved as design history; the current registry has since grown to 149 YAML-declared tools across 16 toolsets plus management entries (139 active/callable), with `tools.yaml` as the current source of truth.

## ToolIndex — Search Implementation

`find_tools` uses a `ToolIndex` class that scores tools from `tools.yaml` against a query string. Built at server startup, no external dependencies.

**Normalization pipeline** (applied to both query and index entries):
1. **Tokenization**: Split on `_`, `-`, `.`, camelCase boundaries. Lowercase. Drop single-char tokens.
2. **Stemming**: Conservative plural stripping (`-ies` → `-y`, `-ses` → `-s`, trailing `-s`). No aggressive stemming — "mapping" stays "mapping", not "map".
3. **Alias expansion** (query only): Domain-specific abbreviation map expands before scoring. Examples: `GE` → `gameplay effect`, `ABP` → `animation blueprint`, `BP` → `blueprint`, `PIE` → `play editor`, `RC` → `remote control`, `GAS` → `gameplay ability system`. Map is extensible — add project-specific abbreviations at implementation time.

**Scoring tiers** (per query token, descending weight):
| Tier | Match Type | Score | Example |
|------|-----------|-------|---------|
| 1 | Exact tool name | +100 | query "get_montage_full" matches tool `get_montage_full` |
| 2 | Token in tool name | +10 | query "montage" matches `get_montage_full` |
| 3 | Prefix of name token (≥3 chars) | +6 | query "mont" matches `montage` in `get_montage_full` |
| 4 | Substring of name token (≥3 chars) | +4 | query "anim" matches `animation` in tool names |
| 5 | Token in description | +2 | query "combat" matches description "Critical for debugging combat timing" |
| 6 | Prefix of description token (≥3 chars) | +1 | query "skel" matches "skeletal" in descriptions |

**Coverage bonus**: Final score multiplied by `(0.5 + 0.5 × matched_token_ratio)`. Multi-word queries reward tools that match ALL terms, not just one.

**Tool verb handling**: `get`, `set`, `list`, `create`, `search`, `run` are NOT stop words — they participate in scoring at standard weight. This means `find_tools("create material")` correctly ranks `create_material` above `get_material_graph`.

**Auto-enable behavior**: `find_tools` returns up to 15 matching tools. Parent toolsets of top direct matches are enabled only when ProjectContext has an attached project. While unresolved, matching project-scoped results include `PROJECT_NOT_ATTACHED` guidance and the tool list stays management-only.

**Accumulation**: Multiple `find_tools` calls accumulate enabled toolsets — previously enabled toolsets stay enabled unless explicitly disabled via `disable_toolset`. There is no hard cap on active toolsets, but `list_toolsets` warns when active tool count exceeds 40 (the empirical accuracy degradation threshold). Use `disable_toolset` to shed toolsets no longer needed.

## Typical Workflows

**GAS debugging session**:
```
Claude: find_tools("gameplay ability effects combat")
→ Enables: gas, blueprint-read, animation
→ Active tools: 10 always + 4 + 8 + 8 = 30 tools
```

**Level design session**:
```
Claude: enable_toolset("actors")
Claude: enable_toolset("materials")
Claude: enable_toolset("visual-capture")
→ Active tools: 10 always + 10 + 5 + 5 = 30 tools
```

**Quick asset lookup (offline, no editor)**:
```
Claude: find_tools("gameplay tags config")
→ Enables: offline
→ Active tools: 10 always + 24 = 34 tools
```

**Asset impact analysis**:
```
Claude: find_tools("who uses this asset")
→ Selects bundle: asset-impact-analysis
→ Enables: asset-registry, offline
```

**Asset lifecycle mutation**:
```
Claude: find_tools("find referencers before deleting this asset")
→ Selects bundle: asset-lifecycle
→ Enables: editor-utility, asset-registry, offline
```

**Context budget recovery** (mid-session):
```
Claude: disable_toolset("animation")  // done with anim work
Claude: enable_toolset("visual-capture")  // now need screenshots
→ Swaps 8 tools out, 5 in
```

---
