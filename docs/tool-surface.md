# Tool Surface

> **This section is fully defined in [tools.yaml](../tools.yaml).**
> All tool names, descriptions, toolset membership, layer assignments, and parameter stubs live there.
> The YAML is the single source of truth — do not duplicate tool tables in markdown.

## Quick Reference

See `tools.yaml` for the complete registry. Summary:

| Category | Toolsets | Layer |
|----------|---------|-------|
| Always loaded | — (6 management tools) | All |
| Offline | `offline` | Offline |
| Existing Plugin | `actors`, `blueprints-write`, `widgets` | TCP:55557 |
| New Plugin | `gas`, `blueprint-read`, `asset-registry`, `animation`, `data-assets`, `input-and-pie`, `geometry`, `materials`, `editor-utility`, `visual-capture` | TCP:55558 |
| Remote Control | `remote-control` | HTTP:30010 |

Tool counts are derived from `tools.yaml` — never hardcode them in documentation.

## Notes on Existing Plugin Tools

> **Note**: Remaining BP node tools (`add_function_node`, `add_input_action_node`, `add_variable`, `add_self_reference`, `add_component_reference`, `connect_nodes`, `find_nodes`) total 7 more tools. These could stay in `blueprints-write` (making it 16) or split into a `blueprint-nodes` sub-toolset. Decision deferred to implementation — splitting only if 16 tools in one toolset causes selection issues.

**`widgets` toolset (7)** — UMG widget creation and binding:

| Tool | Description |
|------|-------------|
| `create_widget` | Create UMG Widget Blueprint |
| `add_text_block` | Add text block to widget |
| `add_button` | Add button to widget |
| `bind_widget_event` | Bind widget event to function |
| `set_text_binding` | Set text block data binding |
| `add_widget_to_viewport` | Show widget in game viewport |
| `add_input_action_node` | Add input action event node (shared with blueprint editing) |

**Removed from existing plugin tools**: `create_input_mapping` (legacy input system — superseded by `create_input_action` + `create_mapping_context` in `input-and-pie` toolset).
