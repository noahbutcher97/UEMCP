# Phase 3 Plugin Design Inputs — P0 Requirements

> **Source audit**: `docs/audits/unrealmcp-comprehensive-audit-2026-04-12.md` (sealed)
> **Scope rationale**: D23 (UnrealMCP plugin deprecated post-Phase 3) + D35 (server defends at wire boundary; plugin-side P0s documented here, C++ untouched).
> **How to read this doc**: Each entry is a requirement for the Phase 3 **UEMCP custom plugin** on TCP:55558 — not a task against the legacy UnrealMCP plugin on TCP:55557. Entries that pair with a server-side partial fix call out the plugin-side residue explicitly.
> **Subsystem buckets** (audit §"Implementation Priority Order"):
> - **3A** Core Infrastructure — command registry, error envelope, actor/transform helpers, property handlers, structured logging, request ID
> - **3B** Actor Commands
> - **3C** Blueprint Commands
> - **3D** UMG Commands
> - **3E** Protocol (framing, timeout, params validation, transport)

---

## P0-1 residue — Plugin-side error format unification

Server-side: `extractWireError()` in `connection-manager.mjs` normalizes all three observed formats before handing results to tool code. Plugin still emits mixed formats.

**(a) Current plugin behavior**: Three response shapes coexist on the wire: Bridge envelope (`{"status":"error","error":"..."}`), CommonUtils (`{"success":false,"error|message":"..."}`), and UMG ad-hoc (`{"error":"..."}` with no status flag, wrapped by Bridge as `{"status":"success","result":{"error":"..."}}`). Ad-hoc escapees and sibling-error leaks have been observed.
**(b) Required Phase 3 behavior**: Single envelope for every response. Errors: `{"status":"error","error":"<msg>","code":"<ERROR_CODE>"}`. Success: `{"status":"success","result":{...}}`. All handlers route through one `BuildErrorResponse()` / `BuildSuccessResponse()` helper (INF-3).
**(c) Wire-protocol implications**: Breaking change relative to 55557. Clients targeting 55558 can drop the 3-way format sniffer and key off `status` alone. Server `extractWireError()` should remain in place as belt-and-suspenders during the 55557→55558 migration window; it becomes dead code only after 55557 is fully retired.
**(d) Test case**: Induce a known failure in every command family (actor/blueprint/UMG/editor). Assert the raw response matches the single envelope shape — no sibling error keys, no ad-hoc bare-`{error}` objects, no mixed-status replies.
**(e) Bucket**: **3A** (INF-3 response envelope + error code taxonomy).

---

## P0-2 — Actor lookup must search all loaded levels

**(a) Current plugin behavior**: Every actor handler calls `UGameplayStatics::GetAllActorsOfClass(GWorld, ...)`. Actors in sublevels or World-Partition streamed levels are invisible — plugin returns "not found" even when the actor is loaded.
**(b) Required Phase 3 behavior**: `FindActorInAllLevels()` helper (INF-1) that iterates persistent + streaming levels via `UWorld::GetLevels()`. Optional `level_name` parameter scopes the search. Error response lists levels actually searched so callers can diagnose streaming state.
**(c) Wire-protocol implications**: New optional `level_name: string` on all actor-targeting commands. Error payload grows a `searched_levels: string[]` field.
**(d) Test case**: Load a level with a streamed sublevel. Spawn `TestCube` in the sublevel. Call `get_actor_properties {name:"TestCube"}` without `level_name` — must succeed. Repeat with `level_name` pointing at the persistent level only — must return not-found with `searched_levels` populated.
**(e) Bucket**: **3A** (INF-1 helper) + **3B** (apply across all 10 actor commands).

---

## P0-3 — Actor name-or-label resolution (D29)

**(a) Current plugin behavior**: All lookups key off `Actor->GetName()` (internal FName, e.g. `BP_OSControlPoint_C_0`). Users see Outliner labels (e.g. `BP_OSControlPoint2`) and have no way to translate. No `label` field in any response.
**(b) Required Phase 3 behavior**: Two-pass lookup — exact FName match first, fall back to exact Outliner label match. Ambiguity guard: if label matches ≥2 actors, return error listing candidates with their FNames. Every actor JSON includes both `name` (FName) and `label` (Outliner display name).
**(c) Wire-protocol implications**: New `label: string` field on all actor response payloads. Error code `AMBIGUOUS_LABEL` with `candidates: [{name,label}]` array.
**(d) Test case**: Spawn two actors both with label `Target` but distinct FNames. Call `delete_actor {name:"Target"}` — must return `AMBIGUOUS_LABEL` with both FNames in candidates. Call `delete_actor {name:"<specific FName>"}` — must succeed.
**(e) Bucket**: **3A** (INF-1) + **3B** (all actor commands return the new field).

---

## P0-4 — SetObjectProperty struct/vector/object support

**(a) Current plugin behavior**: `set_actor_property` / `set_component_property` handle only `FBoolProperty`, `FIntProperty`, `FFloatProperty`, `FStrProperty`, `FByteProperty`, `FEnumProperty`. Anything else returns `"Unsupported property type: StructProperty"`. Blocks FVector, FRotator, FColor, FTransform, and every UObject reference.
**(b) Required Phase 3 behavior**: Property-type handler registry (INF-6). Built-in handlers for FStructProperty (with nested dispatch on `StaticStruct()` — FVector `[x,y,z]`, FRotator `[pitch,yaw,roll]`, FColor `[r,g,b,a]`, FTransform nested object), FObjectProperty (asset path string → `StaticLoadObject`), FArrayProperty (simple-type element loop). Extensible via `REGISTER_PROPERTY_HANDLER(FStructType, Handler)` macro.
**(c) Wire-protocol implications**: `property_value` accepts structured JSON (arrays, nested objects, strings for asset paths) instead of primitives only. Response echoes the resolved value so caller can confirm type coercion.
**(d) Test case**: On a BP_Pickup with `FVector LaunchVelocity` UPROPERTY — call `set_actor_property {name, property_name:"LaunchVelocity", property_value:[100,0,500]}` — must succeed and echo `[100,0,500]`. Same actor with FColor `TintColor` — call with `[255,128,0,255]` — must succeed. Asset reference `StaticMesh` — call with `"/Game/Meshes/SM_Cube.SM_Cube"` — must succeed and resolve via `StaticLoadObject`.
**(e) Bucket**: **3A** (INF-6 registry infrastructure) + **3B**/**3C** (applies to both actor and component property commands).

---

## P0-5 — Compile error reporting

**(a) Current plugin behavior**: `compile_blueprint` always returns `{"compiled":true}` regardless of outcome. `FKismetEditorUtilities::CompileBlueprint()` writes diagnostics into an internal `FCompilerResultsLog` that is discarded. Auto-compile after `add_component`/`add_event_node` silently succeeds even when the graph is broken.
**(b) Required Phase 3 behavior**: Attach a `FCompilerResultsLog` to the compile call and serialize it into the response. Status enum: `success` / `warnings` / `failed`. Payload: `messages: [{severity, message, node_name?, pin_name?, line?}]`.
**(c) Wire-protocol implications**: `compile_blueprint` response replaces `{"compiled":bool}` with `{"status":"success|warnings|failed","messages":[...]}`. Auto-compile callsites fold these messages into their parent response under `compile: {...}`.
**(d) Test case**: Create a BP. Connect a Bool pin to a Float pin via `connect_blueprint_nodes`. Call `compile_blueprint` — must return `status:"failed"` with at least one message pointing at the offending pin connection.
**(e) Bucket**: **3C** (blueprint commands).

---

## P0-6 — Graph edits wrapped in FScopedTransaction

**(a) Current plugin behavior**: All blueprint node commands and component additions mutate the graph/component tree without `FScopedTransaction`. Ctrl+Z in the editor does not undo MCP-driven changes. Partial failures (add node succeeds, connect pins throws) leave the BP in a broken state with no rollback.
**(b) Required Phase 3 behavior**: Each MCP command that mutates a blueprint opens one `FScopedTransaction` at the top of the handler and lets RAII commit on success. On handler error, the transaction auto-cancels, reverting all edits made inside that command. One MCP command = one undo step in the editor.
**(c) Wire-protocol implications**: None direct. Errors become cleaner because partial-mutation states no longer leak out. Consider an optional `transaction_label: string` param for human-readable undo entries.
**(d) Test case**: Call a multi-mutation sequence on a BP (e.g., add 3 nodes + 2 connections). Force failure on the final connection. Verify all prior nodes are gone from the BP asset post-error. Separately: perform a successful multi-edit, Ctrl+Z in the editor once, verify entire command's edits reverted together.
**(e) Bucket**: **3C**. Also applies to **3B** (P2-4 delete_actor undo) and **3D** (UMG structural mutations).

---

## P0-7 residue — Plugin-side widget path standardization

Server-side: `stripDoubledAssetSuffix()` in `tcp-tools.mjs` normalizes `Name.Name` → `Name` on widget params. Plugin still has split load paths.

**(a) Current plugin behavior**: Commands 1-3 (`create_widget`, `add_text_block_to_widget`, `add_button_to_widget`) load from `/Game/Widgets/<name>`. Commands 4-6 (`bind_widget_event`, `set_text_block_binding`, `add_widget_to_viewport`) load from `/Game/Widgets/<name>.<name>`. A widget created by command 1 cannot be found by command 4 unless the caller pre-doubles the name (which then breaks commands 1-3).
**(b) Required Phase 3 behavior**: All UMG commands share one `LoadWidgetBlueprint(FString Name)` helper that resolves consistently. Canonical form is the short name; helper internally constructs the full `/Game/Widgets/<name>.<name>` if the asset registry needs it. Optional `widget_path: string` parameter for non-default paths (mirrors P2-9 for blueprints).
**(b-residue)**: Even after plugin-side standardization, keep the server-side strip for at least one release cycle to handle users with muscle memory from the old API.
**(c) Wire-protocol implications**: `blueprint_name` / `name` on every UMG command always means the short form. Optional `widget_path` added.
**(d) Test case**: `create_widget {name:"HUD_Main"}`, then `bind_widget_event {blueprint_name:"HUD_Main", widget_name:"BtnStart", event_name:"OnClicked"}` — must succeed without any user-visible doubling. Repeat with `name:"HUD_Main.HUD_Main"` — must also succeed (backward compat via server strip).
**(e) Bucket**: **3D** (UMG commands) — leverages helper from **3A**.

---

## P0-8 — `set_text_block_binding` builds a valid function graph

**(a) Current plugin behavior**: Connects the function Entry node's execution output pin directly to `GetVariable`'s data input pin. Missing `UK2Node_FunctionResult`. The blueprint compiles because pin-type checking is absent (see P0-11), but at runtime the binding never fires — TextBlock stays blank.
**(b) Required Phase 3 behavior**: Construct the full binding graph: `UK2Node_FunctionEntry` → exec-wire to → `UK2Node_FunctionResult`; `UK2Node_VariableGet` data-wires to the return node's `ReturnValue` input. Validate pin types match the TextBlock property type before committing. If the bound variable's type isn't `FText`, wrap in a Conv node (or fail with diagnostic).
**(c) Wire-protocol implications**: None — fix is pure plugin-side graph construction. Response may grow an optional `conversion_inserted: bool` field so callers know if a Conv node was auto-added.
**(d) Test case**: Create widget with TextBlock `Title`. Create variable `MyLabel: FText` defaulted to "Hello". Call `set_text_block_binding {blueprint_name, widget_name:"Title", binding_name:"MyLabel"}`. Compile (expect P0-5 success). Add widget to viewport at runtime — TextBlock must display "Hello". Repeat with `MyLabel: int32` — assert `conversion_inserted:true` and runtime display of the int as text.
**(e) Bucket**: **3D** (UMG commands) — depends on **3C** pin-type validation (P0-11).

---

## P0-9 residue — Plugin-side null check on `params`

Server-side: Zod required-param validation in `tcp-tools.mjs` rejects malformed requests before they reach the wire. Plugin still crashes on well-formed JSON that omits `params`.

**(a) Current plugin behavior**: Bridge dispatcher calls `Request->GetObjectField(TEXT("params"))` without a null check. A request like `{"type":"get_actors"}` (no `params`) crashes the editor process via dereference of a null `TSharedPtr<FJsonObject>`.
**(b) Required Phase 3 behavior**: Bridge validates request shape before dispatch. Required fields: `type: string` (non-empty), `params: object` (may be empty `{}` but must be present). Malformed requests return `{"status":"error","code":"MALFORMED_REQUEST","error":"<field>"}` — never crash.
**(b-residue)**: Server-side Zod layer stays as defense-in-depth. Even with plugin hardened, other MCP clients could send malformed requests directly.
**(c) Wire-protocol implications**: Stricter request schema. New error code `MALFORMED_REQUEST`. No successful-path changes.
**(d) Test case**: Send raw TCP `{"type":"get_actors"}` (no `params`). Editor must stay alive and the response must be `{"status":"error","code":"MALFORMED_REQUEST",...}`. Send `{"type":"get_actors","params":{}}` — must succeed.
**(e) Bucket**: **3E** (protocol layer — Bridge request validation).

---

## P0-10 residue — Plugin-side bool-return from transform parsers

Server-side: Vec3 shape validated in Zod schemas (`Vec3 = z.array(z.number()).length(3)`). Plugin still silently zeroes on bad input.

**(a) Current plugin behavior**: `GetVectorFromJson(Params, "location", OutVec)` returns `void` and writes `[0,0,0]` when the field is missing, has the wrong element count, or contains non-numeric values. `GetRotatorFromJson` similarly. Caller has no way to detect the failure — actor silently teleports to world origin.
**(b) Required Phase 3 behavior**: `bool BuildTransformFromJson(...)` returns `false` with an `FString& OutError` reason when parsing fails. All callers check the bool. `GetVector`/`GetRotator` helpers follow the same pattern. Error response on parse failure: `{"status":"error","code":"INVALID_TRANSFORM","error":"location must be array of 3 numbers"}`.
**(b-residue)**: Server-side Zod stays — catches errors earlier and closer to the user (better error messages without a round trip).
**(c) Wire-protocol implications**: Transform-parse errors are now reported as errors instead of silent `[0,0,0]`. New error code `INVALID_TRANSFORM`.
**(d) Test case**: Call `spawn_actor {type:"StaticMeshActor",name:"X",location:[1,2]}` bypassing server validation (raw TCP from a non-UEMCP client). Response must be `{"status":"error","code":"INVALID_TRANSFORM",...}`, no actor spawned, no editor crash.
**(e) Bucket**: **3A** (INF-2 transform parser) — consumed by **3B** (actor commands).

---

## P0-11 — Pin type validation before connection

**(a) Current plugin behavior**: `connect_blueprint_nodes` calls `UEdGraphPin::MakeLinkTo` without consulting the schema. Bool→Float, Exec→Data, and other nonsense connections are silently created. The blueprint compiles (no type check at compile time either in the plugin's path), but behavior at runtime is undefined.
**(b) Required Phase 3 behavior**: Before `MakeLinkTo`, call `Pin->GetSchema()->ArePinsCompatible(PinA, PinB, CallingClass)`. If incompatible, refuse the connection and return `{"status":"error","code":"INCOMPATIBLE_PINS","error":"<diag>","pin_a":{...},"pin_b":{...}}`. Response on success includes resolved pin type info so callers can verify what was actually connected.
**(c) Wire-protocol implications**: New error code `INCOMPATIBLE_PINS`. Success response grows `pin_types: {a: "<type>", b: "<type>"}`.
**(d) Test case**: Create a BP with a `BranchNode` (exec+bool inputs) and a `PrintString` (exec+string inputs). Call `connect_blueprint_nodes` wiring Bool output to String input — must reject with `INCOMPATIBLE_PINS`. Wire Exec to Exec — must succeed and response must echo both pin types.
**(e) Bucket**: **3C** (blueprint commands). Unblocks proper P0-8 UMG binding-graph validation.

---

## Cross-cutting summary

| P0 | Server action (this sprint) | Plugin residue bucket |
|----|----|----|
| P0-1 | `extractWireError()` normalizes 3 formats | 3A |
| P0-2 | — | 3A + 3B |
| P0-3 | — | 3A + 3B |
| P0-4 | — | 3A (INF-6) |
| P0-5 | — | 3C |
| P0-6 | — | 3C |
| P0-7 | `stripDoubledAssetSuffix()` on widget params | 3D |
| P0-8 | — | 3D (depends on 3C P0-11) |
| P0-9 | Zod required-param validation | 3E |
| P0-10 | Vec3 shape validation in schemas | 3A (INF-2) |
| P0-11 | — | 3C |

**Infrastructure cluster (3A) must land first** — P0-1 envelope, INF-1 actor lookup, INF-2 transform parser, INF-6 property registry are upstream dependencies for the 3B/3C/3D handler rewrites.
