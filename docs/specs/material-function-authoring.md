# Material-function authoring

UEMCP 1.0.24 adds a bounded native TCP workflow for regular material functions.
It does not require Python or Remote Control permissions for graph operations.
The first supported expressions are scalar FunctionInput, FunctionOutput,
Constant, Multiply, and FunctionCall. Texture nodes, custom HLSL, layer/blend
functions, interface deletion/rename and arbitrary property editing are not
part of this surface.

## Workflow

1. `create_material_function({asset_path:"/Game/Materials/MF_Scale"})` creates an
   unsaved asset. Existing disk and in-memory destinations are rejected.
2. `get_material_graph({asset_path,representation:"source"})` returns uncached
   source expressions and a `revision`, without requiring an editor tab.
3. Pass that revision as `expected_revision` to `create_material_expression`.
   Use `kind:"FunctionInput",name:"Value"`, `kind:"Multiply",const_b:2`, and
   `kind:"FunctionOutput",name:"Result"`. Each mutation returns the new graph;
   creation also returns `created_expression_id`. Use its revision for the next
   edit, or read again. Stale revisions are rejected before mutation.
4. `connect_material_expressions` takes `from_expression_id`, `output_index`,
   `to_expression_id`, and `input_name`. Use returned pin names/indices. Names
   use Unreal FName comparisons. Replacing a connection requires `replace:true`.
5. Call `update_material_graph` on the function. Add a FunctionCall to a material
   with `function_path` referencing the function, then wire it with
   `connect_material_property` to EmissiveColor, BaseColor or Roughness. The
   property must be active on a Surface material. Supply the function's required
   inputs through connections; an unconnected required input is a compile error.
6. Call `update_material_graph` on the consumer material. Poll
   `get_material_compile_status` until complete or error, with a caller deadline.
7. Save each intended asset explicitly with `save_asset`.

The default `get_material_graph` representation remains the legacy editor graph.
Source responses identify nodes by `expression_id` (MaterialExpressionGuid),
not the legacy wrapper NodeGuid. Function interfaces have separate
`interface_id` values. `material_inputs` keys are Unreal EMaterialProperty numeric
values. Unsupported expression settings are marked incomplete; readback is not
an arbitrary graph cloning format.

## Mutation and compilation boundaries

Expression creation and connection commands record Undo transactions. Creating
the asset itself follows existing material creation semantics and explicitly
reports `creation_undo_supported:false`. Use explicit asset deletion if needed;
do not assume editor Undo deletes a newly allocated function asset.

Graph edits do not compile or save. Updating/propagating a function is an
explicit operation that can affect dependent materials and is not promised to
be one reversible transaction. Close material/function editors before updating;
external graph mutations reject an open editor for the target. Preserve any
unsaved editor changes before closing it. PIE mutations are rejected.

The engine's update helper can synchronously build texture-streaming data. The
update tool has a 30-second TCP deadline; it is not guaranteed to return
immediately. A timeout does not cancel Unreal's work or authorize an automatic
retry. Inspect the source and compilation status before deciding what to do next.

Compilation status reports `not_requested`, `stale`, `pending`, `complete`,
`error`, or `unavailable` for the current engine shader platform and feature
level. A request is associated with source and regular-function dependency
revisions for the supported expression settings. Editing those graphs makes the
old status stale. Requests are process-local, so request compilation again after
restarting. Function updates return `consumer_required`: they do not prove shader
compilation. Missing resources or shader maps never report complete. This is not
proof for every shader permutation, target platform, or rendered appearance.

Consumer updates explicitly request background shader jobs, including when no
renderer is using the material. Completion requires finished compilation, no
errors, and a map containing all shaders required by the material. The reported
`shader_map_finalized` flag is diagnostic: UE 5.8's shader-job cache path can
publish a complete ordinary-material clone without setting its finalization
flag. `global_remaining_shader_jobs` describes the
editor-wide queue, not just this material.

Every multi-call workflow can partially complete. A transport timeout leaves an
unknown outcome; read the source graph before retrying. Do not replay mutations
automatically or infer that a destination collision proves the prior call worked.
Revision checks concern the serialized source fields, not every asset property.

## Deployment and verification

Sync the plugin, build with the editor closed, relaunch, and restart the MCP
client. New commands require 1.0.24; older plugins reject unknown commands. Server
schemas alone do not deploy C++ changes. Runtime verification targets the owned
UEMCPFixture host, never an external project.

From `server/`, the opt-in gate uses a fresh output directory outside the checkout:

```powershell
$env:UEMCP_MATERIAL_GRAPH_ROOT = '<fresh-owned-output-root>'
$env:UEMCP_MATERIAL_GRAPH_ENGINE = '<UE-5.8-engine-root>'
node run-rotation.mjs --test-profile material-graph-live
```

The runner compiles the host, runs existing parameter lifecycle regressions, then
uses a normal MCP client in two editor processes in sequence. It checks scalar
and nested function graphs, per-edit Undo/Redo, rejected edits, compile success
and deliberate failure, stale dependency compile evidence, open-editor refusal,
an independent native topology oracle, and graph identity/settings persistence.
Both editor logs must also be free of ensures and crashes. TCP dispatch uses
Unreal's one-shot game-thread ticker helper, preserving the editor frame's time
context for renderer tasks spawned by material compilation. Calls made directly
on the game thread still execute inline; timeout/lifetime behavior is unchanged.
Its test-only Remote Control permissions allow host Undo/Redo and shutdown;
authoring itself uses TCP. The output root is retained for diagnosis and must be
removed after retaining needed compact evidence and stopping owned processes.

Cross-version qualification, texture/layer workflows, interface changes and visual
shader acceptance require their own qualification. Passing this gate does not
qualify them.

## Engine references

- [MaterialEditingLibrary](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Editor/MaterialEditor/UMaterialEditingLibrary)
- [Material functions and propagation](https://dev.epicgames.com/documentation/en-us/unreal-engine/unreal-engine-material-functions-overview)
- [UObject::Modify](https://dev.epicgames.com/documentation/en-us/unreal-engine/API/Runtime/CoreUObject/UObject/Modify)

Implementation was checked against installed UE 5.8.3 source. Cancellation of an
FScopedTransaction discards its record; it is not rollback. Function expression
creation explicitly sets Function ownership because the inspected engine helper
does not set that field before PostLoad.
