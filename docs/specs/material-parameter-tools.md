# Material parameter tools

UEMCP 1.0.21 adds native parameter identities and effective values to
`list_material_parameters`, and layer/blend addressing to
`set_material_parameter`. Rebuild/sync the plugin and restart the editor and MCP
server before using these additions.

## Read, select, write, verify

1. Call `list_material_parameters` with the loaded material or instance's
   `asset_path`. Detailed listing is the default. The `scalar`, `vector`, and
   `texture` arrays contain `Name`, `Id`, `Association`, `Index`, `Value`, and
   `ValueFound`.
2. Select a row using its full `(Name, Association, Index)` identity. A layer and
   blend may reuse a name; separate layers may also reuse the same expression
   GUID. `Id` is the engine's expression GUID, not a unique layer identifier.
3. Pass the row's `Name` as `parameter_name`, `Association` as `association`,
   `Index` as `index`, and the desired `value` to `set_material_parameter` on the
   material instance. Set `parameter_type` when inference is ambiguous.
4. A successful setter returns `verified: true` only after definition preflight,
   effective readback, and verification of the exact typed instance override.
   The setter updates the instance without saving the asset.

Example input for a scalar in the second material layer:

```json
{
  "asset_path": "/Game/Materials/MI_Example.MI_Example",
  "parameter_name": "Roughness",
  "association": "LayerParameter",
  "index": 1,
  "parameter_type": "scalar",
  "value": 0.7
}
```

Association also accepts `global`, `layer`, and `blend`. Name-only writes default
to global association and index -1. Layer/blend writes require an explicit
nonnegative index; the tool does not guess which matching name to edit.

Values are effective values, including inherited defaults. `ValueFound: false`
with `Value: null` reports a failed native lookup. A found null texture also has
`Value: null`, with `ValueFound: true`. IDs come from native enumeration rather
than being synthesized.

## Permissions and compatibility

Allow Remote Control calls to `UEMCPMaterialParameterLibrary.GetParameterDetails`
and `SetParameterValue` for detailed listing and all writes (UEMCP 1.0.21+).
The native setter records the instance in its own Undo transaction; Remote
Control must not add an automatic transaction on the library CDO. Global
writes also use `GetGlobalParameterNames` and MaterialEditingLibrary readback
getters. Restart the MCP server after updating the server write route; an
already deployed 1.0.21 plugin needs no rebuild for this routing fix.
Derived material instance classes require `KismetMathLibrary.ClassIsChildOf`.
Typed override verification reads instance properties. Python and broad
Allow Any Remote Function Call are unnecessary.

`include_details: false` selects the earlier names-only listing through
MaterialEditingLibrary. Partial batch errors remain in `_subErrors`; malformed
successful responses are rejected. Detailed reads bypass caching so immediate
read-after-write calls reflect current editor state.

The tools cover scalar, vector, and texture parameters. They do not create
parameter definitions or alter a material's layer stack. Re-list after changing
the layer stack because indices may move.
