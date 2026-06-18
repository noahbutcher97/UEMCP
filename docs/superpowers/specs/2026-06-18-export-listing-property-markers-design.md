# D185 Export Listing And Requested Property Markers Design

## Goal

Make offline asset property reads truthful and actionable when an asset has multiple exports or when callers request properties that are not serialized on the selected export.

This design covers two related problems reported from live project usage:

- Agents cannot reliably discover which export to read before calling `read_asset_properties`.
- `read_asset_properties({ property_names: [...] })` silently omits requested names when those names are absent from the serialized property stream.

## Non-Goals

- Do not implement nested subobject recursion.
- Do not decode montage `SlotAnimTracks` or animation-specific nested structs in this change.
- Do not claim offline bytes prove that a class property does not exist.
- Do not add editor-only declaration introspection to this offline tool pass.
- Do not alter unfiltered `read_asset_properties` property payload behavior except for additive metadata; the default export selection change is explicitly in scope.

## Empirical Inputs

The design is based on observed repo reports and local parser behavior:

- `BPGC_OSHitImpact` returns only `ImpactVfx` for a filtered request that also asks for `HitAkEvent` and `DefaultSocketName`.
- Several montage assets currently default to notify or `AnimDataModel` exports before the package-root `AnimMontage` export.
- Montage export tables include duplicate notify names, so selecting by `export_name` alone is not sufficient.
- Offline property reads expose serialized export tags; they do not prove inherited native or Blueprint defaults.

## Recommended Approach

Add a dedicated `list_asset_exports` offline tool and strengthen `read_asset_properties` with export-index selection, default-export reasons, and requested-property markers.

This keeps discovery separate from property reading and avoids a multi-mode `read_asset_properties` response.

The new tool belongs in the existing `offline` toolset. It should be discoverable through `find_tools` for phrases such as "list exports", "export table", "choose export", and "asset export names"; it must not be implemented as an unregistered private helper only.

## Tool Contract: list_asset_exports

`list_asset_exports` is an offline tool that reads a resolved `.uasset` file and returns export-table metadata.

Parameters:

- `asset_path`: Unreal asset path.
- `limit`: optional positive integer, default `200`, capped at `2000`.
- `offset`: optional non-negative integer, default `0`.

Response fields:

- `path`: requested asset path.
- `diskPath`: resolved disk path.
- `total_exports`: total export count.
- `offset`: applied offset.
- `limit`: applied limit.
- `truncated`: true when additional exports exist after the returned window.
- `default_export`: selected default export summary.
- `exports`: export rows.

Each export row contains:

- `export_index`: one-based export index.
- `object_name`: raw object name.
- `object_name_number`: raw object name number.
- `canonical_name`: stable display name that disambiguates numbered duplicate names.
- `class_name`: resolved export class name when available.
- `super_name`: resolved super name when available.
- `outer_index`: raw outer package index.
- `outer_name`: resolved outer object name when available.
- `outer_class_name`: resolved outer class name when available.
- `b_is_asset`: export asset flag.
- `serial_size`: serialized export payload size.

The first version should not expose `serial_offset` by default. It is useful for parser work, but ordinary tool callers need export identity, class, outer, and size.

## Tool Contract: read_asset_properties

`read_asset_properties` keeps its current behavior and adds:

- Optional `export_index`.
- Top-level `export_selection_reason`.
- Top-level `requested_properties` when `property_names` is supplied.

`export_name` remains supported. `export_index` is preferred when callers need to select among duplicate names.

Validation:

- Reject calls that provide both `export_name` and `export_index`.
- Reject `export_index` values outside `1..exports.length`.
- Preserve the existing unknown `export_name` error behavior.
- Return `export_selection_reason: "explicit_export_name"` for explicit name selection.
- Return `export_selection_reason: "explicit_export_index"` for explicit index selection.

## Default Export Selection

Both tools use the same default-export selector:

1. Blueprint generated class CDO, preserving current Blueprint behavior.
2. Root export whose object name matches the package leaf.
3. First root export marked `bIsAsset`.
4. First export marked `bIsAsset`.
5. First export.

Selection reasons:

- `explicit_export_name`
- `explicit_export_index`
- `blueprint_cdo`
- `package_root_name_match`
- `root_asset_export`
- `first_asset_export`
- `first_export_fallback`

This fixes montage assets empirically observed to select notify or `AnimDataModel` exports before the root `AnimMontage` export, without adding montage-specific special cases.

## Requested Property Markers

When `property_names` is supplied, `read_asset_properties` returns one `requested_properties` row per requested name, in request order.

Statuses:

- `serialized`: the property was found and decoded from the selected export stream.
- `unsupported`: the property was found but the parser could not decode the value.
- `not_serialized_default`: the stream was fully parsed and the requested name was absent from serialized tags.
- `unknown_due_to_truncation`: parser truncation means absence cannot be trusted.

The `properties` map remains a decoded-value map. It should not be filled with marker objects for absent names because existing clients may expect `properties[name]` to be a value.

`property_not_found` is intentionally not emitted in this pass. Offline export bytes can prove that a property was not serialized in the selected stream; they generally cannot prove that the class does not declare it.

## Documentation Updates

`tools.yaml` should document:

- `list_asset_exports`.
- `list_asset_exports` aliases and description terms that make export discovery findable before property reads.
- `read_asset_properties.export_index`.
- `read_asset_properties.requested_properties`.
- Default export selection behavior and `export_selection_reason`.
- The offline-default limitation: serialized overrides and parser-supported values are not arbitrary inherited C++ or Blueprint defaults.

The stale `include_defaults` wording under `read_asset_properties` must be removed or moved to the tool that actually supports it.

Parameter names remain snake_case in this pass. Unknown or camelCase arguments should be rejected by the existing schema path, not silently accepted or dropped.

## Error Handling

Errors should be explicit and schema-aligned:

- Missing or invalid `asset_path`: existing resolver behavior.
- `export_index` not an integer: schema validation.
- `export_index` out of range: clear range error.
- Both `export_name` and `export_index`: clear conflict error.
- Unknown `export_name`: preserve existing behavior.
- Pagination arguments out of range: schema validation or explicit range errors.

## Testing Strategy

The implementation must start with RED tests and no production-code edits.

Required RED tests:

- `list_asset_exports` exists in tool metadata and dispatch.
- `list_asset_exports` is in the `offline` toolset and findable through export-listing terminology.
- `list_asset_exports` returns paginated export rows with one-based indexes.
- `list_asset_exports` identifies the package-root montage export as `default_export`.
- Duplicate export-name assets are actionable through `export_index`.
- `read_asset_properties` selects the package-root montage export by default.
- `read_asset_properties` accepts `export_index`.
- `read_asset_properties` rejects calls with both `export_name` and `export_index`.
- `read_asset_properties` rejects out-of-range `export_index`.
- `read_asset_properties` returns a `requested_properties` row for every requested name.
- Missing serialized requested properties return `not_serialized_default` when the stream was fully parsed.
- Truncated reads return `unknown_due_to_truncation` for absent requested names.
- Existing filtered `unsupported[]` scoping remains intact.
- Existing unfiltered property-read behavior remains unchanged.

Each test must fail for the expected missing behavior before implementation starts.

## Verification Gates

Minimum verification before completion:

- Run the targeted test file or test cases after each RED/GREEN cycle.
- Run `npm test` from `server/`.
- Inspect `tools.yaml` metadata for accurate tool names, params, and response descriptions.
- Run a final self-review against this design to confirm no out-of-scope nested decode or property-existence claims were added.

No Unreal Editor or plugin rebuild is required for this offline server change.

## Rollback Boundary

Keep the change in one focused branch and one implementation PR after the spec commit. If the implementation has to be reverted, the revert should remove:

- `list_asset_exports`.
- `export_index` support.
- requested-property markers.
- default-export selection changes.
- associated tests and docs.

The design/spec commit can remain as historical planning context unless the direction itself is rejected.

## Acceptance Criteria

- Agents can enumerate exports before choosing an export to read.
- Assets with duplicate export names can be targeted unambiguously.
- Montage default reads choose the package-root montage export when present.
- Requested property names never disappear silently from filtered reads.
- The tool distinguishes serialized values, unsupported decoded values, not-serialized defaults, and truncation uncertainty.
- The tool does not claim a property is absent from a class unless a future declaration-aware path proves that.
- Existing callers that read `properties` continue receiving decoded serialized values.
