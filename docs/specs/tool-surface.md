# Tool Surface

> **This section is fully defined in [tools.yaml](../../tools.yaml).**
> All tool names, descriptions, toolset membership, layer assignments, and parameter stubs live there.
> The YAML is the single source of truth — do not duplicate tool tables in markdown.

## Quick Reference

See `tools.yaml` for the complete registry. Summary:

| Category | Toolsets | Layer |
|----------|---------|-------|
| Always loaded | — (6 management tools) | All |
| Offline | `offline` | Offline |
| UEMCP Plugin | `actors`, `blueprints-write`, `widgets`, `gas`, `blueprint-read`, `asset-registry`, `animation`, `data-assets`, `input-and-pie`, `geometry`, `materials`, `editor-utility`, `visual-capture`, `sidecar` | TCP:55558 |
| Remote Control | `remote-control` | HTTP:30010 |

Tool counts are derived from `tools.yaml` — never hardcode them in documentation.

## Historical Notes on Existing Plugin Tools

The old UnrealMCP plugin on TCP:55557 is preserved only as conformance-oracle history. Active toolset membership and layer assignment come from `tools.yaml`.

> **Note**: `blueprints-write` now includes graph-targeted node authoring plus `add_variable_assignment`, bringing the toolset to 21 tools. If selection quality degrades, split the graph-authoring subset into a narrower Blueprint graph toolset rather than exposing all Blueprint writes by default.

**`widgets` toolset (7)** — UMG widget creation and binding:

| Tool | Description |
|------|-------------|
| `create_widget` | Create UMG Widget Blueprint |
| `add_text_block` | Add text block to widget |
| `add_button` | Add button to widget |
| `bind_widget_event` | Bind widget event to function |
| `set_text_block_binding` | Set text block data binding |
| `add_widget_to_viewport` | Show widget in game viewport |
| `add_input_action_node` | Add input action event node (shared with blueprint editing) |

**Not carried forward to UEMCP**: `create_input_mapping` (legacy input system — handler still exists in UnrealMCP source but superseded by `create_input_action` + `creat
