# UnrealMCP Comprehensive Audit — Phase 3 Enhancement Strategy

> **Date**: 2026-04-12
> **Scope**: All 36 command handlers across 4 C++ files + Bridge/Protocol architecture
> **Purpose**: Define every improvement the Phase 3 UEMCP plugin must make over the existing UnrealMCP (TCP:55557)
> **Status**: Frozen audit — do not edit after creation

---

## Executive Summary

The existing UnrealMCP plugin is **functionally adequate for basic operations** but has **48 identified issues** across four categories. The Phase 3 UEMCP plugin on TCP:55558 should address all P0/P1 issues and design for P2/P3 items.

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| Editor/Actor Commands | 3 | 2 | 6 | 1 | 12 |
| Blueprint Commands | 2 | 4 | 5 | 2 | 13 |
| UMG Widget Commands | 3 | 2 | 4 | 4 | 13 |
| Protocol/Architecture | 3 | 3 | 4 | 0 | 10 |
| **Total** | **11** | **11** | **19** | **7** | **48** |

---

## P0 — Must Fix (Blocks Production Use)

### P0-1: Error Response Format Inconsistency (3 formats on the wire)
**Affects**: All UMG commands 4-6, Bridge envelope
**Problem**: Three error formats coexist: Bridge envelope (`{"status":"error"}`), CommonUtils (`{"success":false}`), and UMG ad-hoc (`{"error":"msg"}` without status flag). The ad-hoc format passes through Bridge as a "success" response containing an error field.
**Fix**: Single error format — `{"status":"error","error":"<message>","code":"<ERROR_CODE>"}`. All handlers return via unified `CreateErrorResponse()`. Bridge catches all paths.

### P0-2: Actor Lookup Uses GWorld Only — Breaks Multi-Level Workflows
**Affects**: Every actor command (10 handlers)
**Problem**: `UGameplayStatics::GetAllActorsOfClass(GWorld, ...)` misses actors in sublevels or streamed levels. Silent "not found" when actor exists in a different loaded level.
**Fix**: `FindActorInAllLevels()` helper that searches persistent + streaming levels. Optional `level_name` parameter to scope search. Return which levels were searched in error response.

### P0-3: Actor Name-or-Label Resolution (D29)
**Affects**: Every actor-targeting command
**Problem**: All lookups use `Actor->GetName()` (internal FName like `BP_OSControlPoint_C_0`). Users see Outliner labels (like `BP_OSControlPoint2`). No label field in responses.
**Fix**: Two-pass lookup (FName first, label fallback). `label` field in all actor JSON. Ambiguity guard for non-unique labels.

### P0-4: SetObjectProperty Missing Vector/Struct/Object Support
**Affects**: `set_actor_property`, `set_component_property`
**Problem**: Only handles Bool, Int, Float, String, Byte, Enum. Returns "Unsupported property type: StructProperty" for FVector, FRotator, FColor, FTransform, and all UObject references.
**Fix**: Add FStructProperty handler (FVector as `[x,y,z]`, FRotator as `[pitch,yaw,roll]`, FColor as `[r,g,b,a]`). Add FObjectProperty handler (asset path string). Add TArray support for simple types.

### P0-5: No Compile Error Reporting
**Affects**: `compile_blueprint`, auto-compile after component/node adds
**Problem**: Returns `"compiled": true` unconditionally. No error output captured from `FKismetEditorUtilities::CompileBlueprint()`.
**Fix**: Capture `FCompilerResultsLog`. Return status enum (`success`/`failed`/`warnings`) with error messages and line numbers.

### P0-6: Graph Edits Have No Transaction Support
**Affects**: All blueprint node commands, component additions
**Problem**: No `FScopedTransaction` wrapping. Graph modifications can't be undone via Ctrl+Z. Partial failures leave blueprint in broken state.
**Fix**: Wrap all graph mutations in `FScopedTransaction`. One undo step per MCP command.

### P0-7: UMG Blueprint Path Loading Inconsistency
**Affects**: `add_button_to_widget`, `bind_widget_event`, `set_text_block_binding`
**Problem**: Commands 1-3 load from `/Game/Widgets/<name>`, commands 4-6 load from `/Game/Widgets/<name>.<name>` (doubled path). Widget created by command 1 can't be found by command 4.
**Fix**: Standardize all to `/Game/Widgets/<name>`.

### P0-8: `set_text_block_binding` Creates Invalid Graph (exec→data connection)
**Affects**: `set_text_block_binding`
**Problem**: Connects Entry execution pin to GetVariable data pin. Missing `UK2Node_FunctionResult` return node. Blueprint compiles but binding fails at runtime.
**Fix**: Proper function graph: Entry → execution → GetVariable → Return node with data connection.

### P0-9: Missing `params` Field Crashes Plugin
**Affects**: All commands via Bridge
**Problem**: Bridge calls `GetObjectField(TEXT("params"))` without null check. Omitting `params` from request crashes editor.
**Fix**: Validate `params` presence before dispatch. Return error for malformed requests.

### P0-10: GetVectorFromJson / GetRotatorFromJson Silent Failures
**Affects**: All transform operations
**Problem**: Returns `[0,0,0]` silently when array has wrong element count or field is missing. User's rotation/location is silently zeroed.
**Fix**: Return bool success + error message. Callers check return value.

### P0-11: No Pin Type Validation Before Connection
**Affects**: `connect_blueprint_nodes`
**Problem**: Connects pins without checking type compatibility. Bool→Float connections silently created.
**Fix**: Validate via `Pin->GetSchema()->ArePinsCompatible()` before connecting. Return type info in response.

---

## P1 — Important (Significantly Improves UX)

### P1-1: Actor Serialization — Consolidate and Enhance
Two identical functions (`ActorToJson` / `ActorToJsonObject`) with duplicated code. `bDetailed` parameter ignored.
**Fix**: Single function. Detailed mode adds: component list, gameplay tags, folder path, mobility, hidden state, net role.

### P1-2: spawn_actor Limited to 5 Hardcoded Types
Only StaticMeshActor, PointLight, SpotLight, DirectionalLight, CameraActor.
**Fix**: Add `class_path` parameter for arbitrary actor classes via `StaticLoadClass`. Error lists supported types.

### P1-3: spawn_blueprint_actor Hardcoded to /Game/Blueprints/
Cannot spawn from custom paths. Dead code in BlueprintCommands never reached.
**Fix**: Add `blueprint_path` parameter. Fallback to `/Game/Blueprints/` for backward compatibility.

### P1-4: UMG Only Supports TextBlock + Button
No Image, Panel, ScrollBox, Slider, or generic widget creation.
**Fix**: Generic `add_widget` command with `widget_type` parameter. Support VerticalBox, HorizontalBox, Image, ScrollBox, CanvasPanel.

### P1-5: No Widget Property Manipulation Post-Creation
Once created, no way to set text, color, visibility, font via MCP.
**Fix**: `set_widget_property` command mirroring `set_component_property` pattern.

### P1-6: Class Resolution Fallback Chain Is Opaque
`add_blueprint_function_call` tries 4 name variants silently. Error just says "not found" without listing what was tried.
**Fix**: Return resolution diagnostics: attempted names, closest match, hint for correct format.

### P1-7: `add_widget_to_viewport` Is a No-Op
Returns class metadata but doesn't actually add anything to viewport. Misleading command name.
**Fix**: Remove or rename to `get_widget_class_path` with clear description.

### P1-8: Command Dispatch — Replace If-Else with Registry
String-based if-else chain in Bridge. Order-dependent (spawn_blueprint_actor hits EditorCommands, never BlueprintCommands).
**Fix**: Command registry pattern: handlers self-register at startup. Clear error for unregistered commands. Easy unit testing.

### P1-9: Request ID / Correlation
No way to match requests to responses in logs. Makes debugging impossible for multi-command workflows.
**Fix**: Optional `"id"` field echoed in response. All logs include request ID.

### P1-10: Command-Level Timeout from Plugin
If game thread hangs (debugger, blocking load), TCP thread blocks forever. MCP server hangs.
**Fix**: Timeout on game thread dispatch. Send error response on timeout.

### P1-11: SpringArm Special Case Scattered in set_component_property
200+ lines of inline SpringArm handling. Falls through to generic handler after SpringArm, causing double-set bugs.
**Fix**: Extract to `SetSpringArmProperty()` helper with early return.

---

## P2 — Nice to Have (Quality of Life)

### P2-1: focus_viewport Always Offsets on X-Axis Only
Camera placed at `target - FVector(distance, 0, 0)`. Can't view from above or behind.
**Fix**: Add `view_direction` parameter (default `[-1,0,0]`).

### P2-2: take_screenshot — No Resolution/Format Control
Always viewport size, always PNG, no quality setting.
**Fix**: Add `width`, `height`, `format`, `quality` parameters.

### P2-3: find_actors_by_name — Only Substring Match, Case-Sensitive
No glob, regex, or case-insensitive option.
**Fix**: Add `pattern_type` parameter (`exact`/`substring`/`glob`). Search both name and label.

### P2-4: delete_actor Has No Undo
`Actor->Destroy()` without transaction. Can't Ctrl+Z.
**Fix**: Wrap in `GEditor->BeginTransaction()`.

### P2-5: Excessive Debug Logging in Production Code
FindPin logs 8+ messages per call. Blueprint commands log every property type.
**Fix**: Gate behind `#if UE_BUILD_DEVELOPMENT` or custom log category with configurable verbosity.

### P2-6: No Batch Command Support
Each command is a separate TCP round-trip.
**Fix**: Accept array of commands, return array of responses. Design in Phase 3, implement Phase 4.

### P2-7: TCP Fragmentation — 8KB Buffer, Single Recv
Large requests fragment and fail silently.
**Fix**: Length-prefixed framing (`uint32_le` + JSON body) or chunked accumulation.

### P2-8: Inconsistent Response Nesting Across Commands
`get_actors` returns `{"actors":[...]}`, `spawn_actor` returns actor directly, `delete_actor` returns `{"deleted_actor":{...}}`.
**Fix**: Standardize envelope: read ops return `{"data":{...}}`, write ops return `{"result":{...}}`.

### P2-9: Blueprint Path Resolution — All Commands Hardcode /Game/Blueprints/
Cannot work with blueprints in project-specific paths.
**Fix**: Configurable path via console variable or .ini. Asset registry search fallback.

### P2-10: Asset Save Inconsistency in UMG Commands
Some handlers auto-save, others don't.
**Fix**: Standardize: always compile + save for write operations. Optional `skip_save` parameter.

### P2-11: Missing Count/Metadata in List Responses
`get_actors_in_level` returns array without count. No search scope metadata.
**Fix**: Add `count` field to all list operations.

### P2-12: Node Position Not Validated
Positions accepted without bounds checking. Extreme values make nodes invisible.
**Fix**: Validate and clamp to reasonable range `[0, 65536]`.

### P2-13: Structured Logging with Custom Log Categories
Everything uses `LogTemp`. Can't filter MCP logs.
**Fix**: `DEFINE_LOG_CATEGORY_STATIC(LogUEMCP, Log, All)` with subcategories per command group.

### P2-14: Configuration — Port and Paths Should Be Console Variables
Port 55558 should be configurable without recompile.
**Fix**: Console variables: `uemcp.Port`, `uemcp.BlueprintPath`, `uemcp.WidgetPath`.

### P2-15: Button TextBlock Created via NewObject Instead of WidgetTree
`add_button_to_widget` creates child TextBlock directly, not through WidgetTree.
**Fix**: Use `WidgetTree->ConstructWidget()` for proper designer registration.

---

## P3 — Polish (Future Phases)

### P3-1: Widget Name Validation
No checks for empty, invalid characters, or duplicates.

### P3-2: Event Binding Has No Callback Implementation
`bind_widget_event` creates event node but no downstream logic.

### P3-3: Persistent Connections with Multiplexing
Keep-alive connections with request/response ID matching for high throughput.

### P3-4: Progress Reporting for Long Operations
Async flag → immediate "pending" response → poll for completion.

### P3-5: Binary Data Responses
Raw bytes for screenshots/thumbnails instead of base64 JSON.

### P3-6: Command Versioning Strategy
Version field per command for backward-compatible evolution.

### P3-7: JSON Validation Helpers
Reusable `FJsonValidator` with `RequireString()`, `RequireVector()`, `OptionalFloat()`.

---

## Shared Infrastructure Improvements

These cut across all command categories:

### INF-1: `FindActorByNameOrLabel()` — Unified Actor Lookup
Two-pass: FName exact → Label exact. Searches all loaded levels. Returns null with diagnostic info.

### INF-2: `BuildTransformFromJson()` — Reusable Transform Parser
Extracts location/rotation/scale from JSON with validation. Returns bool + error.

### INF-3: Response Envelope Builder
```cpp
TSharedPtr<FJsonObject> BuildSuccessResponse(const TSharedPtr<FJsonObject>& Data);
TSharedPtr<FJsonObject> BuildErrorResponse(const FString& Message, const FString& Code);
```

### INF-4: Command Registry with Self-Registration
Handlers register via macro: `REGISTER_MCP_COMMAND("spawn_actor", HandleSpawnActor)`.

### INF-5: Consolidated Actor Serialization
Single `ActorToJson(AActor*, EDetailLevel)` replacing two duplicated functions.

### INF-6: Property Type Handler Registry
Extensible property setters: register handlers for FVector, FRotator, FColor, FTransform, etc.

---

## Implementation Priority Order

**Phase 3A (Core Infrastructure)**:
1. Command registry (INF-4)
2. Error format unification (P0-1)
3. Response envelope (INF-3)
4. Actor lookup helper (INF-1, P0-2, P0-3)
5. Transform parser (INF-2, P0-10)
6. Property type handlers (INF-6, P0-4)
7. Request ID (P1-9)
8. Structured logging (P2-13)

**Phase 3B (Actor Commands)**:
1. Reimplement all 10 actor commands using new infrastructure
2. `bDetailed` actor serialization (P1-1)
3. Arbitrary actor class spawning (P1-2, P1-3)
4. focus_viewport direction (P2-1)
5. Screenshot enhancements (P2-2)
6. find_actors pattern matching + label search (P2-3, P0-3)
7. Delete with undo (P2-4)

**Phase 3C (Blueprint Commands)**:
1. Reimplement with transaction wrapping (P0-6)
2. Compile error capture (P0-5)
3. Pin type validation (P0-11)
4. Class resolution diagnostics (P1-6)
5. Configurable blueprint paths (P2-9)
6. Node deduplication

**Phase 3D (UMG Commands)**:
1. Fix path loading inconsistency (P0-7)
2. Fix text binding graph (P0-8)
3. Generic widget creation (P1-4)
4. Widget property manipulation (P1-5)
5. Remove/rename viewport no-op (P1-7)

**Phase 3E (Protocol)**:
1. Length-prefixed framing (P2-7)
2. Command timeout (P1-10)
3. params validation (P0-9)
4. Connection queue (multi-client)
5. Console variable configuration (P2-14)
