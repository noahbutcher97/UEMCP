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

## Owned-host lifecycle regression gate

From `server/` in PowerShell, set an explicit fresh output directory and the
installed engine root, then run the opt-in profile:

```powershell
$env:UEMCP_MATERIAL_LIFECYCLE_ROOT = 'D:/UEMCP-Material-Lifecycle-Run'
$env:UEMCP_MATERIAL_LIFECYCLE_ENGINE = 'C:/Program Files/Epic Games/UE_5.8'
npm.cmd run test:material-lifecycle
```

The runner stages only the repository's UEMCPFixture host, compiles its editor
target, and launches `VerifyMaterialLifecycle` with `author` and `verify` in
separate bounded processes. It checks all nine case identities, Undo success,
save success, process exits, source/engine identity, and unchanged saved asset
hashes after reload. Reports and process output are retained in the stage.
Existing output directories are refused; use a fresh directory for every run.
The engine-free runner failure tests participate in default rotation. The
engine profile requires both environment variables and fails if skipped.
This gate does not exercise HTTP/MCP transport, keyboard Undo, Redo or rendering.

## MCP / HTTP / owned editor verification

The opt-in live profile exercises the actual stdio MCP server, Remote Control
HTTP listener, and material tools against only a fresh UEMCPFixture stage:

```powershell
$env:UEMCP_MATERIAL_LIVE_ROOT = 'D:/UEMCP-Material-Live-Run'
$env:UEMCP_MATERIAL_LIVE_ENGINE = 'C:/Program Files/Epic Games/UE_5.8'
npm.cmd run test:material-live
```

It reuses the native lifecycle gate for staging, compilation, and saved fixture
authoring. The live editor runs offscreen because UE 5.8 disables HTTP under NullRHI.
Each subsequent editor process uses an isolated runtime directory,
a dedicated loopback HTTP port, explicit RC class permissions, and
`-UEMCPTcpPort=<owned-port>` for the real UEMCP ownership handshake. This
new port override (1.0.22+) requires
compiling the current plugin source, as the owned-stage runner does. Normal
editor launches retain their default TCP port. Python execution and Allow Any
Remote Function Call remain disabled for the test listener.

The MCP client uses `describe_tool` and the existing `call_tool` /
`call_mutating_tool` dispatchers. These run the same schemas, project guards,
and executors as direct calls. The runner verifies the owned TCP handshake
through `connection_info` before issuing HTTP mutations. The fixture sets a narrow in-memory function allowlist only for
verification launches; it never saves these settings.

The MCP client attaches only the staged project and checks its editor PID and
project identity before loading or changing assets. All nine typed global,
layer, and blend writes use lowercase names; every write is read back, undone,
and redone. Full listing snapshots also verify unchanged neighboring layers.
Layer-only global names and invalid indices must fail without mutation. A
separate editor process reloads saved values through MCP and verifies unchanged
saved-package hashes. Reports include MCP transcripts and process outcomes.
Required profiles fail on missing evidence; default rotation skips this engine
profile and runs its engine-free failure tests.

Undo/Redo use explicit test-host native editor controls called through MCP, not
keyboard input. This profile does not qualify rendered output or UI acceptance.
