# Conformance Oracle Command Contracts

Reference doc for every command handler in the existing UnrealMCP C++ plugin (TCP:55557). This is the conformance oracle for UEMCP Phase 2 TCP client implementation and Phase 3 reimplementation.

**Source**: `ProjectA\Plugins\UnrealMCP\Source\UnrealMCP\`
**Port**: TCP 55557, localhost only
**Generated**: 2026-04-12 from direct source code reading

---

## Wire Protocol

### Active Path (`MCPServerRunnable::Run`)

The TCP listener accepts one client at a time. The active recv loop uses an 8192-byte buffer.

- **Request format**: `{"type": "<command_name>", "params": {...}}` — note the field is `type`, NOT `command`
- **No newline terminator** on request
- **No length framing** — response is raw JSON, no delimiter
- **Single client** — one connection at a time; new connections replace old
- **Socket options**: `SetNoDelay(true)`, 64KB send/recv buffers

### Bridge Envelope

`UnrealMCPBridge::ExecuteCommand` wraps ALL handler results before sending on the wire:

```
Success: {"status": "success", "result": <handler_result>}
Error:   {"status": "error", "error": "<message>"}
```

The Bridge detects errors by checking if the handler result has `"success": false`. If so, it extracts the `"error"` field and rewraps it. This means the `CommonUtils.CreateErrorResponse` format (`{"success": false, "error": "..."}`) is never seen on the wire — it's always normalized to the Bridge envelope.

### Game Thread Dispatch

All commands execute on the game thread via `AsyncTask(ENamedThreads::GameThread, ...)` with a Promise/Future pattern. The TCP thread blocks waiting for the result.

### Blueprint Lookup Convention

`CommonUtils::FindBlueprint` and `FindBlueprintByName` both hardcode the path `/Game/Blueprints/` prefix. All blueprint commands that accept a `blueprint_name` parameter expect just the asset name (e.g., `"MyBlueprint"`), NOT a full path.

### Actor Serialization Convention

`CommonUtils::ActorToJsonObject` returns:
```json
{
  "name": "ActorName",
  "class": "ClassName",
  "location": [x, y, z],
  "rotation": [pitch, yaw, roll],
  "scale": [x, y, z]
}
```
When `bDetailed = true`, additional properties are included (components, etc.).

### Vector/Rotator JSON Convention

- **Vectors**: JSON array `[x, y, z]`
- **Rotators**: JSON array `[pitch, yaw, roll]`
- **Vector2D**: JSON array `[x, y]`

---

## Bridge Dispatch Table

36 type strings routed to 5 handler classes + 1 inline handler. Listed in if-else evaluation order (first match wins).

| Type String | Handler Class | Notes |
|-------------|---------------|-------|
| `ping` | Inline | Returns `{"message": "pong"}` |
| `get_actors_in_level` | EditorCommands | |
| `find_actors_by_name` | EditorCommands | |
| `spawn_actor` | EditorCommands | |
| `create_actor` | EditorCommands | Deprecated alias for `spawn_actor` |
| `delete_actor` | EditorCommands | |
| `set_actor_transform` | EditorCommands | |
| `get_actor_properties` | EditorCommands | |
| `set_actor_property` | EditorCommands | |
| `spawn_blueprint_actor` | EditorCommands | ⚠️ Also has handler in BlueprintCommands — unreachable there |
| `focus_viewport` | EditorCommands | |
| `take_screenshot` | EditorCommands | |
| `create_blueprint` | BlueprintCommands | |
| `add_component_to_blueprint` | BlueprintCommands | |
| `set_component_property` | BlueprintCommands | |
| `set_physics_properties` | BlueprintCommands | |
| `compile_blueprint` | BlueprintCommands | |
| `set_blueprint_property` | BlueprintCommands | |
| `set_static_mesh_properties` | BlueprintCommands | |
| `set_pawn_properties` | BlueprintCommands | |
| `connect_blueprint_nodes` | BlueprintNodeCommands | |
| `add_blueprint_get_self_component_reference` | BlueprintNodeCommands | |
| `add_blueprint_self_reference` | BlueprintNodeCommands | |
| `find_blueprint_nodes` | BlueprintNodeCommands | |
| `add_blueprint_event_node` | BlueprintNodeCommands | |
| `add_blueprint_input_action_node` | BlueprintNodeCommands | |
| `add_blueprint_function_node` | BlueprintNodeCommands | |
| `add_blueprint_get_component_node` | BlueprintNodeCommands | ⚠️ DEAD ROUTE — not in HandleCommand dispatch |
| `add_blueprint_variable` | BlueprintNodeCommands | |
| `create_input_mapping` | ProjectCommands | |
| `create_umg_widget_blueprint` | UMGCommands | |
| `add_text_block_to_widget` | UMGCommands | |
| `add_button_to_widget` | UMGCommands | |
| `bind_widget_event` | UMGCommands | |
| `set_text_block_binding` | UMGCommands | |
| `add_widget_to_viewport` | UMGCommands | |

**Totals**: 36 type strings → 34 working handlers + 1 deprecated alias + 1 dead route

### Known Bugs in Dispatch

1. **`spawn_blueprint_actor` dual registration**: Registered in BOTH EditorCommands and BlueprintCommands blocks. EditorCommands wins (evaluated first). The BlueprintCommands implementation is dead code — it uses `FindBlueprint` (hardcoded `/Game/Blueprints/`) while EditorCommands uses `FPackageName::DoesPackageExist` (slightly better validation).

2. **`add_blueprint_get_component_node` dead route**: Listed in Bridge dispatch for BlueprintNodeCommands, but `BlueprintNodeCommands::HandleCommand` has no case for it. Sends the type string to the handler, which falls through to the "Unknown blueprint node command" error.

---

## Command Contracts

### Notation

For each command:
- **Type**: the `"type"` string sent in the request
- **Params**: fields expected in the `"params"` object (R = required, O = optional)
- **Result**: the JSON object placed in `{"status": "success", "result": <this>}` on the wire
- **Errors**: conditions that produce `{"status": "error", "error": "<message>"}`
- **Side Effects**: what changes in the editor
- **Gotchas**: implementation quirks relevant to UEMCP reimplementation

---

## 1. EditorCommands (11 type strings → 10 handlers)

Source: `UnrealMCPEditorCommands.cpp` (600 lines)

---

### 1.1 `ping`

Handled inline in Bridge, not routed to any command class.

| Field | Value |
|-------|-------|
| **Params** | None |
| **Result** | `{"message": "pong"}` |
| **Side Effects** | None |

---

### 1.2 `get_actors_in_level`

| Field | Value |
|-------|-------|
| **Params** | None |
| **Result** | `{"actors": [{name, class, location, rotation, scale}, ...]}` |
| **Errors** | None (returns empty array if no actors) |
| **Side Effects** | None (read-only) |
| **Gotchas** | Uses `GWorld` directly. Returns ALL actors including editor-internal ones (WorldSettings, etc.). No filtering, no pagination. |

---

### 1.3 `find_actors_by_name`

| Field | Value |
|-------|-------|
| **Params** | `pattern` (R, string) — substring match against actor name |
| **Result** | `{"actors": [{name, class, location, rotation, scale}, ...]}` |
| **Errors** | Missing `pattern` |
| **Side Effects** | None (read-only) |
| **Gotchas** | Uses `FString::Contains()` — case-sensitive substring match, not regex/glob. Uses `GWorld`. |

---

### 1.4 `spawn_actor` / `create_actor`

`create_actor` is a deprecated alias — logs a deprecation warning then calls the same handler.

| Field | Value |
|-------|-------|
| **Params** | `type` (R, string) — one of: `StaticMeshActor`, `PointLight`, `SpotLight`, `DirectionalLight`, `CameraActor` |
| | `name` (R, string) — actor label/name |
| | `location` (O, `[x,y,z]`) — default `[0,0,0]` |
| | `rotation` (O, `[p,y,r]`) — default `[0,0,0]` |
| | `scale` (O, `[x,y,z]`) — default `[1,1,1]` |
| **Result** | Actor JSON (detailed): `{name, class, location, rotation, scale, ...}` |
| **Errors** | Missing `type` or `name`; unknown actor type; actor with same name already exists; failed to get editor world |
| **Side Effects** | Spawns actor in editor world. Checks for name collision first. |
| **Gotchas** | Only 5 hardcoded actor types supported. Name collision check uses exact `GetName()` match against all actors in level. Uses `GEditor->GetEditorWorldContext().World()`. Scale applied post-spawn via `SetActorTransform`. |

---

### 1.5 `delete_actor`

| Field | Value |
|-------|-------|
| **Params** | `name` (R, string) — exact actor name |
| **Result** | `{"deleted_actor": {name, class, location, rotation, scale}}` |
| **Errors** | Missing `name`; actor not found |
| **Side Effects** | Destroys actor via `Actor->Destroy()` |
| **Gotchas** | Actor info captured BEFORE deletion for the response. Uses `GWorld`. Exact name match only. |

---

### 1.6 `set_actor_transform`

| Field | Value |
|-------|-------|
| **Params** | `name` (R, string) — exact actor name |
| | `location` (O, `[x,y,z]`) — preserves current if omitted |
| | `rotation` (O, `[p,y,r]`) — preserves current if omitted |
| | `scale` (O, `[x,y,z]`) — preserves current if omitted |
| **Result** | Actor JSON (detailed) with updated transform |
| **Errors** | Missing `name`; actor not found |
| **Side Effects** | Sets actor transform. Partial updates OK — only specified fields change. |
| **Gotchas** | Reads current transform first, then applies deltas. Uses `GWorld`. |

---

### 1.7 `get_actor_properties`

| Field | Value |
|-------|-------|
| **Params** | `name` (R, string) — exact actor name |
| **Result** | Actor JSON (detailed) — `{name, class, location, rotation, scale, ...}` |
| **Errors** | Missing `name`; actor not found |
| **Side Effects** | None (read-only) |
| **Gotchas** | Always passes `bDetailed = true` to `ActorToJsonObject`. Uses `GWorld`. |

---

### 1.8 `set_actor_property`

| Field | Value |
|-------|-------|
| **Params** | `name` (R, string) — exact actor name |
| | `property_name` (R, string) — UProperty name on the actor |
| | `property_value` (R, any JSON type) — value to set |
| **Result** | `{"actor": "<name>", "property": "<prop_name>", "success": true, "actor_details": {detailed actor JSON}}` |
| **Errors** | Missing `name`, `property_name`, or `property_value`; actor not found; property set failed |
| **Side Effects** | Modifies actor property via `CommonUtils::SetObjectProperty` |
| **Gotchas** | `SetObjectProperty` supports: bool, int, float, string, byte/enum (with qualified name parsing like `EAutoReceiveInput::Player0`). The result includes `"success": true` at handler level — but the Bridge wraps it regardless. Uses `GWorld`. |

---

### 1.9 `spawn_blueprint_actor`

This is the **EditorCommands** version (the one actually reached via Bridge dispatch).

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) — asset name only (looked up under `/Game/Blueprints/`) |
| | `actor_name` (R, string) — name for spawned actor |
| | `location` (O, `[x,y,z]`) — default `[0,0,0]` |
| | `rotation` (O, `[p,y,r]`) — default `[0,0,0]` |
| | `scale` (O, `[x,y,z]`) — default `[1,1,1]` |
| **Result** | Actor JSON (detailed) |
| **Errors** | Missing `blueprint_name` or `actor_name`; blueprint not found; package doesn't exist; failed to get editor world; spawn failed |
| **Side Effects** | Loads blueprint package, spawns actor instance in editor world |
| **Gotchas** | Validates package existence with `FPackageName::DoesPackageExist` before `LoadObject`. Hardcoded `/Game/Blueprints/` path. Sets actor name via `FActorSpawnParameters::Name` (internal FName), not display label. Scale supported unlike the BlueprintCommands version. |

---

### 1.10 `focus_viewport`

| Field | Value |
|-------|-------|
| **Params** | `target` (O, string) — actor name to focus on |
| | `location` (O, `[x,y,z]`) — world position to focus on |
| | `distance` (O, number) — camera offset distance, default 1000 |
| | `orientation` (O, `[p,y,r]`) — camera rotation |
| **Result** | `{"success": true}` |
| **Errors** | Neither `target` nor `location` provided; actor not found; failed to get viewport |
| **Side Effects** | Moves editor viewport camera. Invalidates viewport for redraw. |
| **Gotchas** | Must provide either `target` OR `location`. Camera placed at `target_location - FVector(distance, 0, 0)` — always offsets on X axis. Orientation is optional overlay. Uses `GWorld` for actor search. |

---

### 1.11 `take_screenshot`

| Field | Value |
|-------|-------|
| **Params** | `filepath` (R, string) — output file path; `.png` appended if missing |
| **Result** | `{"filepath": "<path>"}` |
| **Errors** | Missing `filepath`; failed to take screenshot |
| **Side Effects** | Saves PNG screenshot of active viewport to disk |
| **Gotchas** | Uses `Viewport->ReadPixels` + `FImageUtils::CompressImageArray`. Captures the editor viewport, NOT the game viewport. File path is on the editor machine's filesystem. |

---

## 2. BlueprintCommands (8 type strings → 8 handlers via Bridge)

Source: `UnrealMCPBlueprintCommands.cpp` (1160 lines)

Note: The `spawn_blueprint_actor` handler exists in this class (9th handler) but the Bridge never routes to it — EditorCommands handles that type string. Documented below as dead code for completeness.

---

### 2.1 `create_blueprint`

| Field | Value |
|-------|-------|
| **Params** | `name` (R, string) — blueprint asset name |
| | `parent_class` (O, string) — parent class name, default `AActor`. Supports `Pawn`/`Actor` directly; tries `/Script/Engine.<A+name>` then `/Script/Game.<A+name>` |
| **Result** | `{"name": "<name>", "path": "/Game/Blueprints/<name>"}` |
| **Errors** | Missing `name`; blueprint already exists; creation failed |
| **Side Effects** | Creates Blueprint asset at `/Game/Blueprints/<name>`. Marks package dirty. Registers with AssetRegistry. |
| **Gotchas** | Hardcoded to `/Game/Blueprints/` path. Auto-prepends `A` to parent class name if missing. Falls back to `AActor` if parent class not found (logs warning but doesn't error). Uses `UBlueprintFactory`. |

---

### 2.2 `add_component_to_blueprint`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `component_type` (R, string) — class name, tries: exact → `+Component` suffix → `U+` prefix → `U+name+Component` |
| | `component_name` (R, string) |
| | `location` (O, `[x,y,z]`) |
| | `rotation` (O, `[p,y,r]`) |
| | `scale` (O, `[x,y,z]`) |
| **Result** | `{"component_name": "<name>", "component_type": "<type>"}` |
| **Errors** | Missing required params; blueprint not found; unknown component type (not a UActorComponent subclass); creation failed |
| **Side Effects** | Adds SCS node to blueprint, sets transform on SceneComponent template, **auto-compiles** blueprint |
| **Gotchas** | Auto-compiles after adding! Transform only applied if component is a SceneComponent. Component type resolution is flexible — `StaticMesh`, `UStaticMeshComponent`, `StaticMeshComponent` all work. Uses `FindObject<UClass>(ANY_PACKAGE, ...)`. |

---

### 2.3 `set_component_property`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `component_name` (R, string) — SCS node variable name |
| | `property_name` (R, string) — UProperty name |
| | `property_value` (R, any JSON type) |
| **Result** | `{"component": "<name>", "property": "<prop>", "success": true}` |
| **Errors** | Missing required params; blueprint not found; component not found; property not found; set failed |
| **Side Effects** | Modifies component template property. Marks blueprint as modified. |
| **Gotchas** | **Special SpringArm handling** — extensive debug logging and direct property manipulation for SpringArm components (float, bool, Vector, Rotator struct properties). For non-SpringArm: handles FStruct (Vector with scalar broadcast: single number → all 3 components), FEnum (string name or integer), FNumeric (int/float), and falls back to `CommonUtils::SetObjectProperty`. Calls `Modify()` and `PostEditChange()` on SpringArm component templates. |

---

### 2.4 `set_physics_properties`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `component_name` (R, string) — must be a UPrimitiveComponent |
| | `simulate_physics` (O, bool) |
| | `mass` (O, number) — kg, uses `SetMassOverrideInKg` |
| | `linear_damping` (O, number) |
| | `angular_damping` (O, number) |
| **Result** | `{"component": "<name>"}` |
| **Errors** | Missing required params; blueprint not found; component not found; component is not a primitive component |
| **Side Effects** | Modifies physics properties on component template. Marks blueprint as modified. |
| **Gotchas** | All physics params are optional — can set any subset. Must be a UPrimitiveComponent (not just any SceneComponent). |

---

### 2.5 `compile_blueprint`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| **Result** | `{"name": "<name>", "compiled": true}` |
| **Errors** | Missing `blueprint_name`; blueprint not found |
| **Side Effects** | Compiles blueprint via `FKismetEditorUtilities::CompileBlueprint` |
| **Gotchas** | Always returns `"compiled": true` if blueprint was found — doesn't check for compile errors. No compile error output in response. |

---

### 2.6 `set_blueprint_property`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `property_name` (R, string) — UProperty name on the CDO |
| | `property_value` (R, any JSON type) |
| **Result** | `{"property": "<prop>", "success": true}` |
| **Errors** | Missing required params; blueprint not found; CDO null; property set failed |
| **Side Effects** | Modifies the blueprint's Class Default Object. Marks blueprint as modified. |
| **Gotchas** | Operates on `GeneratedClass->GetDefaultObject()`, not on component templates. Uses `CommonUtils::SetObjectProperty`. |

---

### 2.7 `set_static_mesh_properties`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `component_name` (R, string) — must be a UStaticMeshComponent |
| | `static_mesh` (O, string) — asset path like `/Game/Meshes/Cube` |
| | `material` (O, string) — asset path, applied to slot 0 only |
| **Result** | `{"component": "<name>"}` |
| **Errors** | Missing required params; blueprint not found; component not found; component is not a StaticMeshComponent |
| **Side Effects** | Sets static mesh and/or material on component template. Marks blueprint as modified. |
| **Gotchas** | Mesh/material params are optional. Material only goes to slot 0. Silent failure if mesh or material paths don't resolve (no error, just doesn't set). Uses `UEditorAssetLibrary::LoadAsset`. |

---

### 2.8 `set_pawn_properties`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `auto_possess_player` (O, string) — enum value like `"Player0"`, uses qualified name format `"EAutoReceiveInput::Player0"` internally |
| | `use_controller_rotation_yaw` (O, bool) |
| | `use_controller_rotation_pitch` (O, bool) |
| | `use_controller_rotation_roll` (O, bool) |
| | `can_be_damaged` (O, bool) |
| **Result** | `{"blueprint": "<name>", "success": true/false, "results": {"<UPropertyName>": {"success": bool, "error"?: "msg"}, ...}}` |
| **Errors** | Missing `blueprint_name`; blueprint not found; CDO null; no properties specified |
| **Side Effects** | Modifies pawn-specific CDO properties. Marks blueprint as modified if any succeeded. |
| **Gotchas** | **Per-property results** — can partially succeed. Maps param names to UProperty names (e.g., `use_controller_rotation_yaw` → `bUseControllerRotationYaw`). Uses `CommonUtils::SetObjectProperty` which handles the enum qualified name format. Returns `"success": false` at top level only if ALL properties failed. |

---

### 2.9 `spawn_blueprint_actor` (DEAD CODE — BlueprintCommands version)

Never reached via Bridge dispatch. Included for reference.

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R), `actor_name` (R), `location` (O), `rotation` (O) |
| **Differences from EditorCommands version** | No `scale` support. Uses `FindBlueprint` (no `DoesPackageExist` check). Sets name via `SetActorLabel` instead of `FActorSpawnParameters::Name`. |

---

## 3. BlueprintNodeCommands (9 type strings → 8 handlers)

Source: `UnrealMCPBlueprintNodeCommands.cpp` (~924 lines)

---

### 3.1 `connect_blueprint_nodes`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `source_node_id` (R, string) — GUID string |
| | `target_node_id` (R, string) — GUID string |
| | `source_pin` (R, string) — pin name on source node |
| | `target_pin` (R, string) — pin name on target node |
| **Result** | `{"connected": true}` |
| **Errors** | Missing required params; blueprint not found; event graph not found; source/target node not found (by GUID); connection failed |
| **Side Effects** | Creates pin connection in event graph. Marks blueprint as modified. |
| **Gotchas** | Node lookup by `NodeGuid.ToString()` comparison against provided string. Uses `CommonUtils::ConnectGraphNodes` which uses `FindPin` with fallback (exact → case-insensitive → first data output). |

---

### 3.2 `add_blueprint_get_self_component_reference`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `component_name` (R, string) — component variable name |
| | `node_position` (O, `[x, y]`) — default `[0, 0]` |
| **Result** | `{"node_id": "<GUID>"}` |
| **Errors** | Missing required params; blueprint not found; event graph not found; creation failed |
| **Side Effects** | Creates a VariableGet node for the named component in event graph. Marks blueprint as modified. |
| **Gotchas** | Uses `CommonUtils::CreateVariableGetNode` — creates a `UK2Node_VariableGet` with `VariableReference.SetSelfMember`. |

---

### 3.3 `add_blueprint_event_node`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `event_name` (R, string) — e.g., `"ReceiveBeginPlay"`, `"ReceiveTick"` |
| | `node_position` (O, `[x, y]`) — default `[0, 0]` |
| **Result** | `{"node_id": "<GUID>"}` |
| **Errors** | Missing required params; blueprint not found; event graph not found |
| **Side Effects** | Checks for existing event node first. If exists, returns its GUID without creating a duplicate. Otherwise creates new event node via `CommonUtils::CreateEventNode`. Marks blueprint as modified. |
| **Gotchas** | Dedup check uses `CommonUtils::FindExistingEventNode` — won't create duplicate event nodes for the same event name. |

---

### 3.4 `add_blueprint_function_node`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `function_name` (R, string) — function name to call |
| | `target` (O, string) — target class name (e.g., `"GameplayStatics"`, `"KismetMathLibrary"`). If omitted, searches Blueprint's own class. |
| | `node_position` (O, `[x, y]`) — default `[0, 0]` |
| | `params` (O, object) — default values for function input pins |
| **Result** | `{"node_id": "<GUID>"}` |
| **Errors** | Missing required params; blueprint not found; event graph not found; function not found |
| **Side Effects** | Creates function call node. Sets default pin values from `params`. Marks blueprint as modified. |
| **Gotchas** | Complex function resolution: tries `StaticClass()` on target → `FindFunctionByName` on target class hierarchy → special case for `GameplayStatics::GetActorOfClass` → falls back to blueprint's GeneratedClass. **Pin default value handling** is extensive: supports class references (`PC_Class` — uses `TrySetDefaultObject`), int, float, bool, string, Vector (from `[x,y,z]` array), and Number/Boolean/Array JSON types. Class references require exact UE class name with prefix (e.g., `ACameraActor`). |

---

### 3.5 `add_blueprint_variable`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `variable_name` (R, string) |
| | `variable_type` (R, string) — one of: `Boolean`, `Integer`/`Int`, `Float`, `String`, `Vector` |
| | `is_exposed` (O, bool) — default `false`, adds `CPF_Edit` flag |
| **Result** | `{"variable_name": "<name>", "variable_type": "<type>"}` |
| **Errors** | Missing required params; blueprint not found; unsupported variable type |
| **Side Effects** | Adds member variable to blueprint. Sets EditAnywhere flag if exposed. Marks blueprint as modified. |
| **Gotchas** | Only 5 variable types supported. `Integer` and `Int` both accepted. No default value support. |

---

### 3.6 `add_blueprint_input_action_node`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `action_name` (R, string) — input action name |
| | `node_position` (O, `[x, y]`) — default `[0, 0]` |
| **Result** | `{"node_id": "<GUID>"}` |
| **Errors** | Missing required params; blueprint not found; event graph not found; creation failed |
| **Side Effects** | Creates `UK2Node_InputAction` in event graph. Marks blueprint as modified. |
| **Gotchas** | Uses legacy Input Action system (not Enhanced Input). |

---

### 3.7 `add_blueprint_self_reference`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `node_position` (O, `[x, y]`) — default `[0, 0]` |
| **Result** | `{"node_id": "<GUID>"}` |
| **Errors** | Missing `blueprint_name`; blueprint not found; event graph not found; creation failed |
| **Side Effects** | Creates `UK2Node_Self` in event graph. Marks blueprint as modified. |

---

### 3.8 `find_blueprint_nodes`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `node_type` (R, string) — currently only `"Event"` supported |
| | `event_name` (R if node_type=Event, string) — event name to search for |
| **Result** | `{"node_guids": ["<GUID>", ...]}` |
| **Errors** | Missing required params; blueprint not found; event graph not found; missing `event_name` for Event type |
| **Side Effects** | None (read-only) |
| **Gotchas** | Only `Event` node type implemented. Matches by `EventReference.GetMemberName()`. Returns empty array if no matches. Other node types not yet supported (comment in code says "Add other node types as needed"). |

---

### 3.9 `add_blueprint_get_component_node` (DEAD ROUTE)

Listed in Bridge dispatch but NOT in `BlueprintNodeCommands::HandleCommand`. Calling this type string returns: `{"status": "error", "error": "Unknown blueprint node command: add_blueprint_get_component_node"}`.

---

## 4. UMGCommands (6 type strings → 6 handlers)

Source: `UnrealMCPUMGCommands.cpp` (544 lines)

**Important**: UMG commands use **three different error response patterns** depending on which handler you call. Some use `CommonUtils::CreateErrorResponse`, others construct ad-hoc `{"error": "msg"}` objects. The Bridge envelope normalizes most of these, but the ad-hoc pattern (`{"error": "msg"}` without `"success": false`) may pass through as a "success" with an error field in the result.

---

### 4.1 `create_umg_widget_blueprint`

| Field | Value |
|-------|-------|
| **Params** | `name` (R, string) — widget blueprint name |
| **Result** | `{"name": "<name>", "path": "/Game/Widgets/<name>"}` |
| **Errors** | Missing `name`; widget already exists; package creation failed; blueprint creation failed |
| **Side Effects** | Creates Widget Blueprint at `/Game/Widgets/<name>` with a default CanvasPanel root. Compiles. Marks package dirty. Registers with AssetRegistry. |
| **Gotchas** | Hardcoded to `/Game/Widgets/` path (different from regular blueprints which use `/Game/Blueprints/`). Uses `FKismetEditorUtilities::CreateBlueprint` with `UUserWidget` parent. Auto-adds root CanvasPanel. |

---

### 4.2 `add_text_block_to_widget`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) — widget blueprint name |
| | `widget_name` (R, string) — name for the TextBlock |
| | `text` (O, string) — initial text, default `"New Text Block"` |
| | `position` (O, `[x, y]`) — canvas position |
| **Result** | `{"widget_name": "<name>", "text": "<text>"}` |
| **Errors** | Missing required params; widget blueprint not found; TextBlock creation failed; root is not a CanvasPanel |
| **Side Effects** | Creates TextBlock widget in WidgetTree, adds to root CanvasPanel, sets position. Compiles. |
| **Gotchas** | Loads blueprint from `/Game/Widgets/<name>` path. Requires root widget to be a CanvasPanel. |

---

### 4.3 `add_widget_to_viewport`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `z_order` (O, int) — default 0 |
| **Result** | `{"blueprint_name": "<name>", "class_path": "<path>", "z_order": <n>, "note": "Widget class ready. Use CreateWidget and AddToViewport nodes in Blueprint to display in game."}` |
| **Errors** | Missing `blueprint_name`; widget blueprint not found; generated class null |
| **Side Effects** | None! This is essentially a no-op that returns the widget class path. |
| **Gotchas** | **Does NOT actually add to viewport**. Returns instructions saying to use Blueprint nodes instead. The comment in code says "The actual addition to viewport should be done through Blueprint nodes as it requires a game context." Misleading command name. |

---

### 4.4 `add_button_to_widget`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `widget_name` (R, string) — button widget name |
| | `text` (R, string) — button label text |
| | `position` (O, `[x, y]`) |
| **Result** | `{"success": true, "widget_name": "<name>"}` |
| **Errors** | Missing required params; blueprint not found; button creation failed; root not a CanvasPanel |
| **Side Effects** | Creates Button with child TextBlock in WidgetTree. Adds to root CanvasPanel. Compiles and saves. |
| **Gotchas** | ⚠️ **Uses ad-hoc error format** — returns `{"error": "msg"}` without `"success": false`, which the Bridge may not detect as an error. Loads from `/Game/Widgets/<name>.<name>` (doubled path — different from other UMG commands). Creates a child TextBlock named `<widget_name>_Text`. Saves asset after compile. |

---

### 4.5 `bind_widget_event`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `widget_name` (R, string) — widget to bind event on |
| | `event_name` (R, string) — event name (e.g., `"OnClicked"`) |
| **Result** | `{"success": true, "event_name": "<name>"}` |
| **Errors** | Missing required params; blueprint not found; event graph not found; widget not found; event node creation failed |
| **Side Effects** | Creates bound event node in widget blueprint's event graph. Compiles and saves. |
| **Gotchas** | ⚠️ **Ad-hoc error format** like `add_button_to_widget`. Checks for existing event node before creating. Uses `FKismetEditorUtilities::CreateNewBoundEventForClass` then searches for the created node. Loads from doubled path `/Game/Widgets/<name>.<name>`. |

---

### 4.6 `set_text_block_binding`

| Field | Value |
|-------|-------|
| **Params** | `blueprint_name` (R, string) |
| | `widget_name` (R, string) — TextBlock widget to bind |
| | `binding_name` (R, string) — variable name for the binding |
| **Result** | `{"success": true, "binding_name": "<name>"}` |
| **Errors** | Missing required params; blueprint not found; TextBlock not found |
| **Side Effects** | Creates a member variable (FText type) with the binding name. Creates a getter function graph (`Get<binding_name>`) with entry node and VariableGet node. Compiles and saves. |
| **Gotchas** | ⚠️ **Ad-hoc error format**. Loads from doubled path. The function graph creation is incomplete — connects EntryThenPin (exec) to GetVarOutPin (data), which is an invalid connection. Likely a bug in the binding setup. |

---

## 5. ProjectCommands (1 type string → 1 handler)

Source: `UnrealMCPProjectCommands.cpp` (72 lines)

---

### 5.1 `create_input_mapping`

| Field | Value |
|-------|-------|
| **Params** | `action_name` (R, string) — action mapping name |
| | `key` (R, string) — key name (e.g., `"SpaceBar"`, `"LeftMouseButton"`) |
| | `shift` (O, bool) — modifier |
| | `ctrl` (O, bool) — modifier |
| | `alt` (O, bool) — modifier |
| | `cmd` (O, bool) — modifier |
| **Result** | `{"action_name": "<name>", "key": "<key>"}` |
| **Errors** | Missing `action_name` or `key`; failed to get input settings |
| **Side Effects** | Adds input action key mapping to project InputSettings. Saves config. |
| **Gotchas** | Uses legacy `FInputActionKeyMapping` (not Enhanced Input). Saves config immediately via `InputSettings->SaveConfig()`. Key must be a valid FKey string name. |

---

## Summary Statistics

| Category | Count |
|----------|-------|
| Total type strings in Bridge | 36 |
| Working handlers | 34 |
| Deprecated aliases | 1 (`create_actor` → `spawn_actor`) |
| Dead routes | 1 (`add_blueprint_get_component_node`) |
| Dead handler code | 1 (`spawn_blueprint_actor` in BlueprintCommands) |
| Read-only commands | 5 (`ping`, `get_actors_in_level`, `find_actors_by_name`, `get_actor_properties`, `find_blueprint_nodes`) |
| Write commands | 29 |

### Error Format Summary

| Handler Class | Error Format | Bridge Detects? |
|---------------|-------------|-----------------|
| EditorCommands | `{"success": false, "error": "msg"}` via CommonUtils | ✅ Yes |
| BlueprintCommands | `{"success": false, "error": "msg"}` via CommonUtils | ✅ Yes |
| BlueprintNodeCommands | `{"success": false, "error": "msg"}` via CommonUtils | ✅ Yes |
| ProjectCommands | `{"success": false, "error": "msg"}` via CommonUtils | ✅ Yes |
| UMGCommands (first 3) | `{"success": false, "error": "msg"}` via CommonUtils | ✅ Yes |
| UMGCommands (last 3) | `{"error": "msg"}` ad-hoc (no `"success"` field) | ❌ **No** — passes through as success with error field in result |

### Hardcoded Path Conventions

| Convention | Path | Used By |
|------------|------|---------|
| Blueprint lookup | `/Game/Blueprints/` | All BlueprintCommands, EditorCommands `spawn_blueprint_actor`, all BlueprintNodeCommands |
| Widget blueprint lookup | `/Game/Widgets/` | `create_umg_widget_blueprint`, `add_text_block_to_widget`, `add_widget_to_viewport` |
| Widget blueprint (doubled) | `/Game/Widgets/<name>.<name>` | `add_button_to_widget`, `bind_widget_event`, `set_text_block_binding` |

### Key Reimplementation Concerns for Phase 3

1. **Wire protocol field**: Use `"type"` (not `"command"`) in requests
2. **No response framing**: Raw JSON, no length prefix, no newline delimiter
3. **Error format normalization**: Bridge wraps everything, but UMG ad-hoc errors slip through — UEMCP server should normalize both formats
4. **Hardcoded paths**: `/Game/Blueprints/` and `/Game/Widgets/` — consider making configurable or using `IAssetRegistry` search
5. **Auto-compile side effect**: `add_component_to_blueprint` auto-compiles — document this clearly in tool description
6. **`add_widget_to_viewport` is a no-op**: Consider removing or renaming in UEMCP
7. **`set_text_block_binding` has broken connection**: The exec→data pin connection is invalid
8. **Legacy Input Actions**: `create_input_mapping` and `add_blueprint_input_action_node` use old input system, not Enhanced Input
9. **Game thread blocking**: All commands block the TCP thread via Promise/Future — consider async patterns for long operations
10. **Single client**: Only one TCP connection at a time — matches UEMCP's ConnectionManager design

---

## 6. CommonUtils Reference

Source: `UnrealMCPCommonUtils.h` (59 lines) / `UnrealMCPCommonUtils.cpp` (709 lines)

Static utility class `FUnrealMCPCommonUtils` — used by all 5 handler classes.

---

### 6.1 Response Constructors

#### `CreateErrorResponse(Message) → FJsonObject`

Returns: `{"success": false, "error": "<Message>"}`

This is the **standard** error format. Used by EditorCommands, BlueprintCommands, BlueprintNodeCommands, ProjectCommands, and UMGCommands (first 3 handlers). The Bridge wraps this as `{"status": "error", "error": "<Message>"}` when it detects `"success": false`.

#### `CreateSuccessResponse(Data?) → FJsonObject`

Returns: `{"success": true}` or `{"success": true, "data": {<Data>}}` if Data is non-null.

Note: Most handlers DON'T use this — they construct custom result objects directly and return them to the Bridge. The Bridge wraps any non-error result as `{"status": "success", "result": {<handler output>}}`. So the `"success": true` field from `CreateSuccessResponse` ends up nested inside the Bridge envelope, not at the top level.

---

### 6.2 JSON Deserialization Helpers

All extract from a `FJsonObject` by field name. Return zero-initialized defaults if the field is missing (no errors thrown).

| Helper | Input JSON | Output | Notes |
|--------|-----------|--------|-------|
| `GetVectorFromJson(obj, field)` | `[x, y, z]` array | `FVector` | Requires ≥3 elements. Silently returns `(0,0,0)` if fewer. |
| `GetRotatorFromJson(obj, field)` | `[pitch, yaw, roll]` array | `FRotator` | Order: Pitch, Yaw, Roll — matches UE convention. |
| `GetVector2DFromJson(obj, field)` | `[x, y]` array | `FVector2D` | Used for `node_position` params. |
| `GetIntArrayFromJson(obj, field, &out)` | `[n, ...]` array | `TArray<int32>` | Resets output array first. |
| `GetFloatArrayFromJson(obj, field, &out)` | `[n.n, ...]` array | `TArray<float>` | Resets output array first. |

**Gotcha**: All silently return zero/empty on missing fields. No error propagation — callers get default values without knowing the field was absent. Vectors with <3 elements return `(0,0,0)`, not a partial read.

---

### 6.3 `SetObjectProperty(Object, PropertyName, JsonValue, &OutError) → bool`

Handles 6 UProperty types with the following JSON→UProperty coercion:

| UProperty Type | Accepted JSON | Coercion Logic |
|---------------|--------------|----------------|
| `FBoolProperty` | `true`/`false` | Direct `AsBool()` |
| `FIntProperty` | number | `AsNumber()` → truncate to `int32` |
| `FFloatProperty` | number | Direct `AsNumber()` → `float` |
| `FStrProperty` | string | Direct `AsString()` |
| `FByteProperty` (plain) | number | `AsNumber()` → `uint8` |
| `FByteProperty` (enum via `TEnumAsByte`) | number OR string | See enum resolution below |
| `FEnumProperty` | number OR string | See enum resolution below |

**Enum resolution** (identical for both `FByteProperty+Enum` and `FEnumProperty`):

1. **Numeric JSON** → direct cast to `uint8`/`int64`, set immediately
2. **Numeric string** (e.g., `"2"`) → parse to number, set immediately
3. **Qualified name** (e.g., `"EAutoReceiveInput::Player0"`) → split on `::`, take right side, resolve via `GetValueByNameString`
4. **Unqualified name** (e.g., `"Player0"`) → resolve via `GetValueByNameString`
5. **Fallback** → try original string as-is via `GetValueByNameString`
6. **Failure** → logs all valid enum values as warning, returns false with error message

**Not supported**: `FNameProperty`, `FTextProperty`, `FStructProperty` (no FVector/FRotator/FColor), `FObjectProperty`, `FSoftObjectProperty`, `FArrayProperty`, `FMapProperty`, `FSetProperty`. Attempting any of these returns `"Unsupported property type"` error.

**Phase 3 concern**: The missing `FStructProperty` support means commands like `set_actor_property` can't set Vector/Rotator/Color/LinearColor properties through this helper. Any command that uses `SetObjectProperty` for complex types will silently fail. UEMCP's reimplementation should add struct property handling.

---

### 6.4 `ActorToJsonObject(Actor, bDetailed?) → FJsonObject`

Serializes an actor to JSON. **Both basic and detailed modes produce identical output** — `bDetailed` param exists in the signature but is never branched on.

Output format:
```json
{
  "name": "StaticMeshActor_1",
  "class": "StaticMeshActor",
  "location": [100.0, 200.0, 0.0],
  "rotation": [0.0, 45.0, 0.0],
  "scale": [1.0, 1.0, 1.0]
}
```

- **`location`**: `[X, Y, Z]` from `GetActorLocation()`
- **`rotation`**: `[Pitch, Yaw, Roll]` from `GetActorRotation()`
- **`scale`**: `[X, Y, Z]` from `GetActorScale3D()`
- **`class`**: Short class name (no package path), from `GetClass()->GetName()`

The companion `ActorToJson()` returns the same object wrapped as `FJsonValue` (for use in arrays).

**Phase 3 concern**: `bDetailed` should add component list, tag list, and relevant property values. Also consider adding `label` (display name) vs `name` (internal name) distinction.

---

### 6.5 Blueprint Lookup

#### `FindBlueprintByName(Name) → UBlueprint*`

Hardcodes path: `LoadObject<UBlueprint>(nullptr, "/Game/Blueprints/" + Name)`

Returns `nullptr` if the asset doesn't exist at that path — no error message, no search. `FindBlueprint()` is an alias that delegates directly to `FindBlueprintByName()`.

#### `FindOrCreateEventGraph(Blueprint) → UEdGraph*`

Searches `Blueprint->UbergraphPages` for a graph whose name contains `"EventGraph"`. If none found, creates one. Used by all BlueprintNodeCommands and some BlueprintCommands.

---

### 6.6 Blueprint Graph Node Helpers

All follow the same pattern: create node → set position → add to graph → allocate pins. Return `nullptr` on failure.

| Helper | Creates | Key Behavior |
|--------|---------|-------------|
| `CreateEventNode(Graph, EventName, Pos)` | `UK2Node_Event` | **Dedup**: checks for existing event with same name first, returns it if found. Resolves event via `FindFunctionByName` on `Blueprint->GeneratedClass`. |
| `CreateFunctionCallNode(Graph, Function, Pos)` | `UK2Node_CallFunction` | Takes a resolved `UFunction*` — caller must find the function first. Calls `CreateNewGuid()`. |
| `CreateVariableGetNode(Graph, BP, VarName, Pos)` | `UK2Node_VariableGet` | Resolves property via `FindFProperty<FProperty>` on GeneratedClass. Returns `nullptr` if variable doesn't exist. |
| `CreateVariableSetNode(Graph, BP, VarName, Pos)` | `UK2Node_VariableSet` | Same property resolution as VariableGet. |
| `CreateInputActionNode(Graph, ActionName, Pos)` | `UK2Node_InputAction` | Legacy input system. Just sets `InputActionName`. Calls `CreateNewGuid()`. |
| `CreateSelfReferenceNode(Graph, Pos)` | `UK2Node_Self` | No parameters beyond position. Calls `CreateNewGuid()`. |

**Phase 3 note**: `CreateEventNode` and `CreateFunctionCallNode` don't call `CreateNewGuid()` but the others do. Inconsistent — may cause issues with node identification if GUIDs collide or are default-initialized.

---

### 6.7 `ConnectGraphNodes(Graph, Source, SourcePin, Target, TargetPin) → bool`

Resolves pins via `FindPin()` then calls `SourcePin->MakeLinkTo(TargetPin)`. Returns false if either pin not found.

Does NOT validate pin type compatibility — `MakeLinkTo` will connect any two pins regardless of type. The Blueprint compiler catches type mismatches later, but the connection succeeds at the graph level. This is how `set_text_block_binding` ends up with an exec→data pin connection (Section 4.6).

---

### 6.8 `FindPin(Node, PinName, Direction?) → UEdGraphPin*`

3-tier fallback resolution:

1. **Exact match** — `Pin->PinName.ToString() == PinName` with matching direction
2. **Case-insensitive** — `Equals(PinName, ESearchCase::IgnoreCase)` with matching direction
3. **First data output** — **Only if** direction is `EGPD_Output` AND node is a `UK2Node_VariableGet`: returns the first pin where `PinType.PinCategory != PC_Exec`

Direction param defaults to `EGPD_MAX` (matches any direction) if not specified.

**Gotcha**: Tier 3 fallback is narrow — only triggers for VariableGet output pins. If a function call node has multiple output data pins, you must match by exact name. Extensive debug logging (`UE_LOG`) on every call dumps all available pins.

---

### 6.9 `FindExistingEventNode(Graph, EventName) → UK2Node_Event*`

Iterates `Graph->Nodes`, casts each to `UK2Node_Event`, checks `EventReference.GetMemberName()`. Returns first match or `nullptr`.

Used by `add_blueprint_event_node` for dedup checking and by `CreateEventNode` internally (which duplicates this logic).

---

## 7. tools.yaml ↔ Command Type Mapping

Cross-reference of UEMCP tools.yaml tool names (user-facing API) against C++ type strings (wire protocol). Covers the three existing-plugin toolsets: `actors`, `blueprints-write`, `widgets`.

### Mapping Legend

- **✅ Direct match** — tools.yaml tool maps to a C++ handler
- **⚠️ Name differs** — tool exists in C++ but under a different type string
- **❌ No handler** — tools.yaml defines the tool but no C++ handler exists (needs new implementation in Phase 3)

---

### 7.1 `actors` Toolset (layer: tcp-55557)

| tools.yaml Name | C++ Type String | Param Differences | Status |
|-----------------|----------------|-------------------|--------|
| `get_actors` | `get_actors_in_level` | yaml: (unstubbed) / C++: `class_filter` (O) | ⚠️ Name differs |
| `find_actors` | `find_actors_by_name` | yaml: (unstubbed) / C++: `pattern` (R) | ⚠️ Name differs |
| `spawn_actor` | `spawn_actor` | yaml: (unstubbed) / C++: `actor_type` (R), `name` (R), `location` (O), `rotation` (O) | ✅ Direct match |
| `delete_actor` | `delete_actor` | yaml: (unstubbed) / C++: `actor_name` (R) | ✅ Direct match |
| `set_actor_transform` | `set_actor_transform` | yaml: (unstubbed) / C++: `actor_name` (R), `location` (O), `rotation` (O), `scale` (O) | ✅ Direct match |
| `get_actor_properties` | `get_actor_properties` | yaml: (unstubbed) / C++: `actor_name` (R) | ✅ Direct match |
| `set_actor_property` | `set_actor_property` | yaml: (unstubbed) / C++: `actor_name` (R), `property_name` (R), `property_value` (R) | ✅ Direct match |
| `spawn_blueprint_actor` | `spawn_blueprint_actor` | yaml: (unstubbed) / C++: `blueprint_name` (R), `actor_name` (R), `location` (O), `rotation` (O), `scale` (O) | ✅ Direct match (EditorCommands version) |
| `focus_viewport` | `focus_viewport` | yaml: (unstubbed) / C++: `target` (R), `distance` (O) | ✅ Direct match |
| `take_screenshot` | `take_screenshot` | yaml: (unstubbed) / C++: `filename` (R), `resolution_x`/`_y` (O) | ✅ Direct match |

**Summary**: 10 tools, 8 direct matches, 2 name differences, 0 missing handlers.

---

### 7.2 `blueprints-write` Toolset (layer: tcp-55557)

| tools.yaml Name | C++ Type String | Param Differences | Status |
|-----------------|----------------|-------------------|--------|
| `create_blueprint` | `create_blueprint` | yaml: (unstubbed) / C++: `name` (R), `parent_class` (O) | ✅ Direct match |
| `add_component` | `add_component_to_blueprint` | yaml: (unstubbed) / C++: `blueprint_name` (R), `component_type` (R), `component_name` (O) | ⚠️ Name differs |
| `set_component_property` | `set_component_property` | yaml: (unstubbed) / C++: `blueprint_name` (R), `component_name` (R), `property_name` (R), `property_value` (R) | ✅ Direct match |
| `compile_blueprint` | `compile_blueprint` | yaml: (unstubbed) / C++: `blueprint_name` (R) | ✅ Direct match |
| `set_blueprint_property` | `set_blueprint_property` | yaml: (unstubbed) / C++: `blueprint_name` (R), `property_name` (R), `property_value` (R) | ✅ Direct match |
| `set_static_mesh_props` | `set_static_mesh_properties` | yaml: (unstubbed) / C++: `blueprint_name` (R), `component_name` (R), `static_mesh` (O), `material` (O) | ⚠️ Name differs |
| `set_physics_props` | `set_physics_properties` | yaml: (unstubbed) / C++: `blueprint_name` (R), `component_name` (R), `simulate_physics` (O), etc. | ⚠️ Name differs |
| `set_pawn_props` | `set_pawn_properties` | yaml: (unstubbed) / C++: `blueprint_name` (R), `auto_possess_player` (O), etc. | ⚠️ Name differs |
| `add_event_node` | `add_blueprint_event_node` | yaml: (unstubbed) / C++: `blueprint_name` (R), `event_name` (R), `node_position` (O) | ⚠️ Name differs |

**Note**: tools.yaml mentions 7 more BP node tools in a `note:` field that "may be added here or split into a blueprint-nodes sub-toolset." These correspond to C++ handlers that exist but aren't listed as tools.yaml entries yet:

| C++ Type String | Handler Class | tools.yaml Status |
|----------------|---------------|-------------------|
| `add_blueprint_function_node` | BlueprintNodeCommands | Not in any toolset |
| `add_blueprint_input_action_node` | BlueprintNodeCommands | Listed under `widgets` toolset (see 7.3) |
| `add_blueprint_variable` | BlueprintNodeCommands | Not in any toolset |
| `add_blueprint_self_reference` | BlueprintNodeCommands | Not in any toolset |
| `add_blueprint_get_self_component_reference` | BlueprintNodeCommands | Not in any toolset |
| `connect_blueprint_nodes` | BlueprintNodeCommands | Not in any toolset |
| `find_blueprint_nodes` | BlueprintNodeCommands | Not in any toolset |

**Summary**: 9 tools, 4 direct matches, 5 name differences, 0 missing handlers. 6 C++ handlers have no corresponding tools.yaml entry yet.

---

### 7.3 `widgets` Toolset (layer: tcp-55557)

| tools.yaml Name | C++ Type String | Param Differences | Status |
|-----------------|----------------|-------------------|--------|
| `create_widget` | `create_umg_widget_blueprint` | yaml: (unstubbed) / C++: `name` (R) | ⚠️ Name differs |
| `add_text_block` | `add_text_block_to_widget` | yaml: (unstubbed) / C++: `blueprint_name` (R), `widget_name` (R), `text` (O), `position` (O) | ⚠️ Name differs |
| `add_button` | `add_button_to_widget` | yaml: (unstubbed) / C++: `blueprint_name` (R), `widget_name` (R), `text` (R), `position` (O) | ⚠️ Name differs |
| `bind_widget_event` | `bind_widget_event` | yaml: (unstubbed) / C++: `blueprint_name` (R), `widget_name` (R), `event_name` (R) | ✅ Direct match |
| `set_text_block_binding` | `set_text_block_binding` | yaml: (unstubbed) / C++: `blueprint_name` (R), `widget_name` (R), `binding_name` (R) | ✅ Direct match |
| `add_widget_to_viewport` | `add_widget_to_viewport` | yaml: (unstubbed) / C++: `blueprint_name` (R), `z_order` (O) | ✅ Direct match (but C++ handler is a no-op) |
| `add_input_action_node` | `add_blueprint_input_action_node` | yaml: (unstubbed) / C++: `blueprint_name` (R), `action_name` (R), `node_position` (O) | ⚠️ Name differs + **cross-class** |

**Cross-class note**: `add_input_action_node` is listed under the `widgets` toolset in tools.yaml, but its C++ handler lives in `BlueprintNodeCommands`, not `UMGCommands`. This is a toolset assignment question for UEMCP — the tool works on any Blueprint, not just widgets.

**Summary**: 7 tools, 3 direct matches, 4 name differences, 0 missing handlers.

---

### 7.4 Combined Statistics

| Metric | Count |
|--------|-------|
| Total tools.yaml entries across 3 toolsets | 26 |
| Direct C++ type string match | 15 |
| Name differs (shortened in tools.yaml) | 11 |
| No C++ handler (needs Phase 3 implementation) | 0 |
| C++ handlers with no tools.yaml entry | 7 (6 BP node commands + `create_input_mapping`) |

### 7.5 Name Shortening Pattern

tools.yaml consistently shortens C++ type strings by:

1. **Dropping the subject noun**: `add_component_to_blueprint` → `add_component` (context is implicit from toolset)
2. **Abbreviating "properties"**: `set_static_mesh_properties` → `set_static_mesh_props`
3. **Dropping prefix**: `create_umg_widget_blueprint` → `create_widget`, `add_text_block_to_widget` → `add_text_block`
4. **Dropping "blueprint_" prefix on node commands**: `add_blueprint_event_node` → `add_event_node`

### 7.6 Phase 2 TCP Client Implications

The UEMCP MCP server tools.yaml names are the **user-facing API** — these are what Claude sees and calls. The TCP client must translate between the two:

1. **Tool name → type string mapping** needed in the TCP client layer (e.g., `add_component` → `add_component_to_blueprint`)
2. **Param name pass-through** — tools.yaml params are currently stubs (`(unstubbed)`). When populated, they should match C++ param names exactly to avoid a second translation layer.
3. **The 7 orphan C++ handlers** need toolset assignment decisions before Phase 2 can expose them. The tools.yaml `note:` on `blueprints-write` already anticipates this.
4. **`create_input_mapping`** (ProjectCommands) has no tools.yaml entry at all. It uses legacy input — consider whether UEMCP should expose it or replace it with Enhanced Input tools (already planned in `input-and-pie` toolset).
5. **`add_widget_to_viewport`** maps correctly but the C++ handler is a no-op (Section 4.3). tools.yaml should either flag this or replace it with a functional implementation in Phase 3.
