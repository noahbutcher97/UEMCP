# Dynamic Toolset Design

> Source of truth for tool definitions: [tools.yaml](../tools.yaml)
> Toolset registry, tool counts, and alias map are defined in tools.yaml. This document covers the design rationale, search algorithm, and typical workflows.

## Why Dynamic Toolsets

With 114 tools across 4 connection layers, a static tool list would consume 30,000-60,000 tokens (~25-30% of context) in tool schema overhead alone. Empirical data from the MCP ecosystem shows model tool-selection accuracy degrades beyond ~30 simultaneously visible tools, with hard failures around 46. GitHub's MCP Server hit the same wall at 101 tools and solved it with dynamic toolsets.

UEMCP uses a hybrid of GitHub's explicit toolsets and Speakeasy's progressive disclosure: 6 always-visible management tools + 15 on-demand toolsets + keyword search with auto-enable. Claude typically activates 2-3 toolsets per task (15-25 active tools), well within safe limits.

## Always-Loaded Tools — 6 tools

These are always visible to Claude regardless of which toolsets are enabled:

| # | Tool | Description |
|---|------|-------------|
| 1 | `connection_info` | Show status of all 4 layers (TCP:55557, TCP:55558, HTTP:30010, Offline). Reports which project is detected, what's available, and which toolsets are currently enabled. |
| 2 | `detect_project` | Run auto-detection chain and report which project's editor is open, with confidence score. |
| 3 | `find_tools` | Keyword search across all 114 tools. Returns matching tool names + one-line descriptions + parent toolset. Auto-enables parent toolsets of matches. Uses weighted scoring: exact name > name token > name prefix > name substring > description match. Supports alias expansion (e.g., "GE" → "gameplay effect") and plural stemming. |
| 4 | `list_toolsets` | Show all 15 toolsets with: tool count, required layer, layer availability status (connected/unavailable), and enabled/disabled state. This is Claude's orientation tool — call it first to understand what's available. |
| 5 | `enable_toolset` | Explicitly enable one or more toolsets by name. Fires `tools/list_changed` notification so Claude receives updated tool list. Use when Claude already knows what category it needs. |
| 6 | `disable_toolset` | Disable one or more toolsets to free context. Use when switching tasks or when active tool count is getting high. |

## Toolset Registry

| Toolset | Tools | Layer | Description |
|---------|-------|-------|-------------|
| `offline` | 10 | Offline | Project files, configs, gameplay tags, source code, plugins |
| `actors` | 10 | TCP:55557 | Spawn, delete, transform, properties, viewport, screenshot |
| `blueprints-write` | 9 | TCP:55557 | Create BP, add components, nodes, variables, compile |
| `widgets` | 7 | TCP:55557 | Create UMG widgets, add elements, bind events |
| `blueprint-read` | 10 | TCP:55558 | BP introspection (info, variables, functions, graph, components, dispatchers), expanded graphs (AnimBP, Widget BP, material graph, all-graphs) |
| `asset-registry` | 5 | TCP:55558 | Search assets, references, class hierarchy, DataTable contents, asset metadata |
| `gas` | 5 | TCP:55558 | Create/modify GE, create GA, runtime tags, create AttributeSet |
| `materials` | 5 | TCP:55558 | Create material/instance, set parameters, list parameters, material graph read |
| `animation` | 8 | TCP:55558 | Create montage, sections, notifies, anim sequence info, montage full read, blend space, anim curve data |
| `data-assets` | 7 | TCP:55558 | Create/set/list data assets, read data asset properties, curve assets, string tables, struct definitions |
| `geometry` | 4 | TCP:55558 | Procedural mesh, CSG boolean, UV generation, mesh info |
| `input-and-pie` | 7 | TCP:55558 | Input actions, mapping contexts, PIE start/stop/status, console commands |
| `visual-capture` | 5 | TCP:55558 | Asset thumbnails, viewport screenshot, asset preview render, editor tab capture, visual summary |
| `editor-utility` | 8 | TCP:55558 | Editor state, run Python, EUB introspection/run, asset create/duplicate/rename/delete |
| `remote-control` | 8 | HTTP:30010 | RC get/set property, call function, list/describe objects, batch, presets, passthrough |

**Subtotals**: 6 always-loaded + 108 in toolsets = **114 registered tools** (down from 120 — see Section 7.0.3 for deduplication).

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

This removes 6 redundant tools: 120 → 114. The 6 always-loaded management tools (connection_info, detect_project, find_tools, list_toolsets, enable_toolset, disable_toolset) sit outside toolsets. Grand total: **114 registered tools** across 15 toolsets + 6 always-loaded.

## ToolIndex — Search Implementation

`find_tools` uses a `ToolIndex` class that scores all 114 tools against a query string. Built at server startup, no external dependencies.

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

**Auto-enable behavior**: `find_tools` returns up to 15 matching tools. All parent toolsets of matches are automatically enabled. The response includes `toolsets_enabled: ["materials", "animation"]` so Claude knows what was activated. Server fires `tools/list_changed` notification.

## Typical Workflows

**GAS debugging session**:
```
Claude: find_tools("gameplay ability effects combat")
→ Enables: gas, blueprint-read, animation
→ Active tools: 6 always + 5 + 10 + 8 = 29 tools
```

**Level design session**:
```
Claude: enable_toolset("actors")
Claude: enable_toolset("materials")
Claude: enable_toolset("visual-capture")
→ Active tools: 6 always + 10 + 5 + 5 = 26 tools
```

**Quick asset lookup (offline, no editor)**:
```
Claude: find_tools("gameplay tags config")
→ Enables: offline
→ Active tools: 6 always + 10 = 16 tools
```

**Context budget recovery** (mid-session):
```
Claude: disable_toolset("animation")  // done with anim work
Claude: enable_toolset("visual-capture")  // now need screenshots
→ Swaps 8 tools out, 5 in
```

---

