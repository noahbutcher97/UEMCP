# Tool Surface

> **This section is fully defined in [tools.yaml](../../tools.yaml).**
> All tool names, descriptions, toolset membership, layer assignments, and parameter stubs live there.
> The YAML is the single source of truth — do not duplicate tool tables in markdown.

## Quick Reference

See `tools.yaml` for the complete registry. Summary:

| Category | Toolsets | Layer |
|----------|---------|-------|
| Always loaded | Management tools | All |
| Offline | `offline` | Offline |
| UEMCP Plugin | `actors`, `blueprints-write`, `widgets`, `gas`, `blueprint-read`, `asset-registry`, `animation`, `data-assets`, `input-and-pie`, `geometry`, `materials`, `editor-utility`, `visual-capture`, `sidecar` | TCP:55558 |
| Remote Control | `remote-control` | HTTP:30010 |

Tool counts are derived from `tools.yaml` — never hardcode them in documentation.

## `read_asset_properties` Parser Contract

This is a durable parser reference, not additional tool-wire metadata. The bounded wire description remains in `tools.yaml`; this section preserves the parser semantics required to interpret its response.

### Supported Values And Boundaries

The parser supports scalar values, enums, object and soft references, gameplay tags and tag containers, `FFieldPath`, and simple-element `TArray` and `TSet`.

Normalized map capabilities:

- Map keys: `scalar`.
- Map values: `scalar`, `StructProperty`, `SoftObjectProperty`, `SoftClassProperty`.
- Unsupported map value reason: `map_value_type_unsupported`.

`StructProperty` map values use a configured engine-struct handler or tagged self-describing decoding. Struct-key maps and other non-scalar map keys remain unsupported.

Configured engine structs:

- Engine structs: `FVector`, `FRotator`, `FQuat`, `FTransform`, `FLinearColor`, `FColor`, `FVector2D`, `FVector4`, `FGuid`, `FBox`, `FIntPoint`, `FBodyInstance`, `FSoftObjectPath`, `FSoftClassPath`, `FGameplayTag`, `FGameplayTagContainer`, `FExpressionInput`, `FColorMaterialInput`, `FScalarMaterialInput`, `FShadingModelMaterialInput`, `FSubstrateMaterialInput`, `FVectorMaterialInput`, `FVector2MaterialInput`, `FMaterialAttributesInput`.

Unknown structs use tagged self-describing decoding where possible; unhandled layouts return markers rather than being silently skipped.

### Reason-Code Taxonomy

- Parser core: `unknown_struct`, `unknown_property_type`, `unexpected_preamble`, `serial_range_out_of_bounds`, `value_overruns_serial`, `tag_header_read_failed`, `property_tag_extensions`, `value_read_failed`, `delegate_not_serialized`, `localized_text`, and `size_budget_exceeded`.
- Containers: `complex_element_container`, `container_count_unreasonable`, `set_with_removed_items`, `map_with_removed_items`, `map_type_params_missing`, `map_key_type_unsupported`, `map_value_type_unsupported`, `map_value_struct_name_missing`, `struct_key_map`, and `tagged_struct_terminator_missing`.
- Struct layouts: `body_instance_native_layout_unknown`.
- Bounded subobject output: `subobject_budget_exhausted`.

`unknown_struct` identifies a struct outside the engine registry; `unexpected_preamble` identifies a non-zero export-body preamble, including non-CDO subclass exports and AssetImportData; and `property_tag_extensions` identifies an unhandled UE 5.6 `FPropertyTagExtensions` field. `body_instance_native_layout_unknown` means a `FBodyInstance` native binary layout was not known, although tagged fallback can expose partial overrides.

### Export And Property Selection

The `export_selection_reason` response field reports `blueprint_cdo`, `package_root_name_match`, `root_asset_export`, `first_asset_export`, or `first_export_fallback` for default selection and `explicit_export_name` or `explicit_export_index` for explicit selection. `export_name` and `export_index` are mutually exclusive; `export_index` is one-based and is the durable disambiguator for duplicate export names.

`property_names` leaves `properties` as the decoded-value map and adds exactly one `requested_properties` row per requested name. Row statuses are `serialized`, `unsupported`, `not_serialized_default`, and `unknown_due_to_truncation`. Filtered `unsupported[]` markers are scoped to requested properties, except `__stream__` markers, which apply to the whole parse. A missing property proves only that no serialized value was found; it does not prove inherited native or Blueprint defaults.

### Subobjects, Collision, And Budgets

With `include_subobjects=true`, traversal stays in the selected package and discovers component or subobject exports through outer links, serialized object references, and Blueprint generated-class children. Traversal honors `subobject_depth` (default 1, cap 3) and `subobject_limit` (default 50, cap 200). Each subobject row reports `decode_status` as `serialized`, `empty_or_default`, or `present_but_undecoded`. Ordinary subobject rows also include decoded `properties` and `unsupported` markers.

`max_bytes` bounds decoded output and sets `truncated`; `size_budget_exceeded` markers are capped at 20. Subobjects share the aggregate `subobject_payload_max_bytes` budget, equal to `max_bytes`, with `subobject_payload_bytes_remaining` tracking what remains. A row that would exceed the remaining aggregate budget is returned as `present_but_undecoded` with `subobject_budget_exhausted`, and the response sets `subobjects_truncated` instead of expanding without bound.

Collision summaries are emitted only when collision/profile/`BodyInstance` fields are serialized. An absent collision field means `not_serialized_default`; it does not prove that the component has no collision configuration.

## Toolset Notes

Active toolset membership and layer assignment come from `tools.yaml`.

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

**Input mapping**: `create_input_mapping` is superseded by `create_input_action` and `create_input_mapping_context`.
