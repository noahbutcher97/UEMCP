# Phase 3 Plugin and Offline Consumption — Design Research

> **Status**: Research (read-only). Informs Phase 3 C++ plugin design across buckets 3A–3F and the server-side consumption boundary. No code, no commits, no spec edits.
> **Ground-truth dependency**: `docs/research/blueprints-as-picture-design-research.md` is treated as settled for bucket 3F fundamentals (extraction path, delegate, sidecar location, verb list, failure modes, auto-prime). Q10 below is integration-only.
> **Date**: 2026-04-15. Author: research pass on Noah's handoff.

---

## Framing

Phase 3 replaces the legacy UnrealMCP plugin (TCP:55557) with UEMCP's long-lived plugin on TCP:55558. The 11 P0 items and the 3F amendment give us a defect-driven requirements list, but they do not answer the architectural question: what *shape* do we build? That shape is load-bearing because post-D23 the plugin owns the entire TCP surface for the life of the project. Every decision here compounds for the rest of UEMCP's life.

Two meta-observations drive what follows. First, the legacy plugin's worst flaws (inconsistent error envelopes, no transactions, crash-on-missing-field, silent-zero parsers) are process flaws, not knowledge flaws — we know how to avoid them; we need an architecture that makes the *right* thing automatic and the *wrong* thing require deliberate effort. Second, the plugin is an editor tool in a live developer's editor. Its failure modes are *their* failure modes. That constraint — "a broken handler must not crash or hang the editor" — is the single most important design input and it's not in the P0 list.

---

## Q1 — Plugin module architecture

### Verdict: split into two modules — `UEMCPCore` (editor-only Runtime-type) + `UEMCPEditor` (editor-only Editor-type)

A single monolithic module is tempting because the plugin is editor-only end to end (no runtime gameplay code). But two modules pay for themselves because:

1. **Testability.** `UEMCPCore` holds protocol, dispatch registry, error envelope, property handler registry, and pure-logic helpers — all UE-editor-agnostic enough to be covered by UE Automation tests without standing up the full editor shell. `UEMCPEditor` holds the handlers that actually touch `UEdGraph`, `UBlueprint`, `UWidgetBlueprint`, `GEditor`, and the Save-hook delegate. Handlers in the editor module can be thin wrappers that delegate to Core for parsing and response shaping.
2. **Dependency hygiene.** Core depends on `Core`, `CoreUObject`, `Json`, `JsonUtilities`, `Sockets`, `Networking`. Editor depends additionally on `UnrealEd`, `Kismet`, `BlueprintGraph`, `KismetCompiler`, `UMG`, `UMGEditor`, `EditorSubsystem`, `AssetRegistry`, `AssetTools`, `Slate`, `SlateCore`. This is not cosmetic: several editor-only headers (e.g., `KismetCompiler.h`) transitively break Win64 non-editor builds if pulled into a runtime module. Keeping them out of Core means Core can be consumed by offline CLI utilities later (a test harness, a CI lint pass) without dragging the editor.
3. **Hot-reload blast radius.** Live Coding reliably reloads Core-like modules with no UObjects in flight; modules that touch editor UObjects (subsystems, delegates, CDO state) are where Live Coding breaks. Keeping the subsystem and delegate registration in Editor contains the damage to the module that already has Live Coding problems.

### Module layout sketch

```
Plugins/UEMCP/
├── UEMCP.uplugin
└── Source/
    ├── UEMCPCore/
    │   ├── UEMCPCore.Build.cs        # Type=Runtime, LoadingPhase=Default (editor-only via WhitelistPlatforms)
    │   ├── Public/
    │   │   ├── Protocol/             # Envelope, error codes, framing
    │   │   ├── Dispatch/             # Registry, handler interface, request context
    │   │   ├── Properties/           # INF-6 property-type handler registry
    │   │   └── Log/                  # LogUEMCP category, structured log helpers
    │   └── Private/                  # Implementations
    └── UEMCPEditor/
        ├── UEMCPEditor.Build.cs      # Type=Editor, LoadingPhase=PostEngineInit
        ├── Public/
        │   ├── Subsystems/           # FUEMCPEditorSubsystem (UEditorSubsystem)
        │   ├── Transport/            # FMCPServerRunnable (FRunnable-based listener)
        │   ├── Handlers/             # ActorHandlers.cpp, BlueprintHandlers.cpp, UMGHandlers.cpp, IntrospectionHandlers.cpp
        │   └── Introspection/        # Save hook, sidecar writer, graph serializer
        └── Private/                  # Implementations, handler REGISTER_COMMAND()s
```

`UEMCP.uplugin` marks both modules `"Type": "Editor"` and `"LoadingPhase": "PostEngineInit"` (editor) / `"Default"` (core). The Core-is-Runtime-Type-but-editor-only pattern is idiomatic in UE (see `ToolMenus`, `EditorStyle` variants) — it lets other editor modules depend on Core without a cycle.

### Subsystem ownership

- **`FUEMCPEditorSubsystem` (extends `UEditorSubsystem`)** — lifecycle anchor. `Initialize()` constructs the dispatch registry, instantiates the `FMCPServerRunnable`, subscribes to `FCoreUObjectDelegates::OnPackageSavedWithContext` for the Save hook. `Deinitialize()` tears everything down in reverse. `UEditorSubsystem` is correct over `UGameInstanceSubsystem` because we never run in PIE; we run in the editor shell.
- **`FMCPServerRunnable` (extends `FRunnable`)** — owns the `FSocket` listener, accepts connections, hands each request off to the dispatcher on the game thread via `Async(EAsyncExecution::TaskGraphMainThread, ...)`. Owns nothing else; it's a thin transport layer.
- **Dispatch registry** — owned by the subsystem, a `TMap<FName, TUniquePtr<ICommandHandler>>`. Populated by `REGISTER_COMMAND` macros at module startup (see Q2).
- **Property handler registry** — owned by the subsystem, a `TMap<FFieldClass*, TSharedPtr<IPropertyHandler>>`. Lives for the subsystem's lifetime. See Q5.
- **Sidecar cache coordinator** — the Save-hook handler + `prime_bp_cache` implementation. Owned by the subsystem. Does not hold long-lived in-memory caches (sidecars ARE the cache); holds only a schema-version constant and a throttle state for hot-save sequences.

### Module dependencies (minimum set)

Core public: `Core`, `CoreUObject`. Core private: `Json`, `JsonUtilities`, `Sockets`, `Networking`.

Editor public: `Core`, `CoreUObject`, `UEMCPCore`. Editor private: `Engine`, `UnrealEd`, `EditorSubsystem`, `Kismet`, `BlueprintGraph`, `KismetCompiler`, `GraphEditor`, `UMG`, `UMGEditor`, `AssetRegistry`, `AssetTools`, `Slate`, `SlateCore`, `PropertyEditor`, `EditorStyle`, `DesktopPlatform` (for path helpers).

### Hot-reload / Live Coding behavior

This is the one area where UE 5.6 reliably bites us. Empirical behavior:

- `FRunnable` thread survives Live Coding (it's OS-level; UE doesn't own it). Fine.
- `FSocket` listener survives — the pointer in `FMCPServerRunnable` is still valid across hot-reload.
- `TMap<FName, TUniquePtr<ICommandHandler>>` populated by static `REGISTER_COMMAND` macros IS the risk: on hot-reload the static initializers run again, and depending on how we write the macro we either (a) double-register (map entries leak old handler pointers with dangling vtables) or (b) re-register cleanly (new handler replaces old).
- `FCoreUObjectDelegates::OnPackageSavedWithContext` delegate handle: the old bound lambda holds a captured `this` that may be a reloaded subsystem. Leaks a stale binding that fires on every save.

**Mitigation (mandatory, not optional):**

1. `REGISTER_COMMAND` macro writes to an `FUEMCPCommandRegistrar` static that is cleared in `ShutdownModule`. On reload, Shutdown runs first, the map empties, then static init repopulates.
2. Delegate bindings use `FDelegateHandle`; the subsystem stores the handle as a member and `Deinitialize` calls `Remove(Handle)`. `UEditorSubsystem::Deinitialize` is called by the engine during hot-reload module teardown — this is the one we can trust.
3. `FMCPServerRunnable::Stop()` called in `ShutdownModule` with a short wait (500 ms) for the thread to exit. If it doesn't exit, log a warning and leak the thread — letting the OS clean up at editor shutdown is strictly better than blocking the hot-reload.
4. Document: "Live Coding is supported for handler body changes only. Changes to the dispatch registry, delegate bindings, or subsystem construction require a full editor restart." This is the same constraint the legacy plugin has; we just name it.

---

## Q2 — Command dispatch and registration

### Verdict: macro-registered `TMap<FName, TUniquePtr<ICommandHandler>>` with synchronous-by-default handlers and explicit-opt-in async

No UCLASS reflection for handlers. Reflection would buy auto-discovery at a cost of tying every handler to a `UObject` lifecycle, which is wrong for stateless command logic and awkward under hot-reload. Plain static registration is both simpler and more test-friendly.

### Handler interface

```cpp
// UEMCPCore/Public/Dispatch/ICommandHandler.h — SKETCH, not code
class ICommandHandler {
public:
    virtual ~ICommandHandler() = default;
    virtual FName GetCommandType() const = 0;
    virtual FCommandSchema GetSchema() const = 0;   // for list_commands introspection
    virtual bool IsAsync() const { return false; }
    virtual void Execute(const FCommandContext& Ctx, FCommandResponse& Response) = 0;
};
```

`FCommandContext` carries the parsed JSON params, the request_id, the originating socket handle (so async handlers can route the response back), and a logger-scoped `FUEMCPRequestLog`. `FCommandResponse` is a builder wrapping the canonical envelope (see Q3) — handlers call `Response.Ok(Payload)` or `Response.Error(Code, Message, Details)` and never touch the wire directly.

`REGISTER_COMMAND(FSpawnActorHandler)` expands to a static `FCommandRegistrar` whose constructor inserts the handler into a global registry, consumed by the subsystem at `Initialize()`. Registration happens at module load, teardown at `ShutdownModule()` (see Q1 hot-reload notes).

### Sync vs async split

**Sync by default.** Every handler runs on the game thread in the dispatcher's execution slot. Simple, predictable, matches UE's threading model (editor UObject access must be game-thread).

**Async only when the command has a known long latency:**
- `prime_bp_cache` (iterates over every BP in the project; 1–5s typical)
- `compile_blueprint` (can be seconds on a large BP; must not block the socket)
- Any future "batch" command (spawn-many, transform-many) if the batch size exceeds a threshold

Async handlers return a `TFuture<FCommandResponse>` and the dispatcher holds the socket handle + request_id in a `TMap<uint64, FPendingResponse>` until the future resolves. When it does, the response is written back with the original request_id. Client-side, this is transparent — the server still matches response to request via request_id.

**Streaming** (progress updates during a long command) is a protocol-level concern, not a handler-level one. See Q6.

### Request ID and response envelope

Every request carries a `request_id` (caller-supplied; server-side `connection-manager.mjs` generates monotonic IDs). Every response echoes it at the top level:

```
{
  "request_id": "...",
  "status": "success" | "error" | "warning",
  "type": "<command_name>",   // echo for log correlation
  "result": { ... },           // on success/warning
  "error": { "code": "...", "message": "...", "details": {...} },  // on error
  "warnings": [ ... ],         // optional, can coexist with success or error
  "schema_version": "1.0.0"    // envelope version, independent of payload versions
}
```

Top-level `request_id` and `status` are hoisted (not buried in `result`) so the server-side log/correlation layer can parse them without fully parsing the payload.

### Per-command metadata and `list_commands`

**Verdict: plugin publishes schemas; `tools.yaml` stays the source of truth for UEMCP server-side organization.**

Every handler's `GetSchema()` returns a param+response description. A built-in `list_commands` handler dumps the registry as JSON. This gives us:
- A runtime introspection capability (Claude can ask the plugin what it supports)
- A self-test surface (a CI check that every tool in `tools.yaml` targeting layer `tcp-55558` has a matching plugin-side handler)
- A migration safety net during the 55557→55558 flip (see Q6)

`tools.yaml` does not become derived data. The plugin's schema is the *implementation contract*; `tools.yaml` is the *surface presentation* (toolset membership, aliases, descriptions tuned for Claude). They serve different masters. But they can be cross-checked, and drift between them is a test failure.

### Dispatch flow

```
Socket accept → FMCPServerRunnable reads framed JSON request
  → Validate envelope shape (request_id, type, params present) → reject with MALFORMED_REQUEST if not
  → Async(TaskGraphMainThread) to hop to game thread
  → Look up handler by FName(type) → UNKNOWN_COMMAND if missing
  → Validate params against handler's schema → MALFORMED_PARAMS if invalid
  → Construct FCommandContext, call handler.Execute()
  → Handler populates FCommandResponse (sync) or returns TFuture (async)
  → Serialize response, frame, write back to socket
  → Log structured line (see Q3)
```

Critical: the schema validation step runs *before* the handler executes. This closes P0-9 (malformed request crash) categorically — no handler body ever sees a missing `params` field because validation would have rejected it first.

---

## Q3 — Error envelope, error codes, structured logging, crash containment

### Canonical envelope

See Q2 for the shape. Three observations worth calling out:

1. **Three-valued status**, not boolean. `"success"`, `"error"`, `"warning"`. Warning is for commands that completed but surfaced a concern (e.g., a property was set but a dependent property would need updating manually; a sidecar was written but an orphan at the old path was not cleaned up). Warning responses can carry both `result` and `warnings[]`.
2. **`code` is required on every error**; `message` is human-readable but not machine-parsed; `details` is a free-form object for context (the offending field name, the expected type, the ambiguous-match list). Rule: if `details` would be empty, omit it.
3. **`schema_version` at the envelope level** is distinct from any payload-level `version`. The envelope version changes when we change the shape of the envelope itself; payload versions (e.g., the BP dump schema version) are internal to `result`.

### Error code taxonomy

Dotted namespaces, SCREAMING_SNAKE_CASE leaf. Groups by bucket:

| Namespace | Codes (day-1 set) |
|---|---|
| `INF` (3A infrastructure) | `MALFORMED_REQUEST`, `MALFORMED_PARAMS`, `UNKNOWN_COMMAND`, `INVALID_TRANSFORM`, `INTERNAL_ERROR`, `TIMEOUT`, `UNSUPPORTED_STRUCT` |
| `ACTOR` (3B) | `ACTOR_NOT_FOUND`, `AMBIGUOUS_LABEL`, `LEVEL_NOT_FOUND`, `CLASS_NOT_FOUND`, `SPAWN_FAILED` |
| `PROP` (INF-6 property registry, cross-bucket) | `PROP_NOT_FOUND`, `PROP_TYPE_MISMATCH`, `PROP_READ_ONLY` |
| `BP` (3C + 3F) | `BP_NOT_FOUND`, `BP_COMPILE_FAILED`, `BP_INCOMPATIBLE_PINS`, `BP_NODE_NOT_FOUND`, `BP_GRAPH_NOT_FOUND`, `BP_MEMBER_EXISTS`, `BP_SIDECAR_STALE`, `BP_SIDECAR_SCHEMA_MISMATCH`, `BP_DIRTY_EDITOR`, `BP_CACHE_MISS` |
| `UMG` (3D) | `WIDGET_NOT_FOUND`, `WIDGET_CLASS_INVALID`, `BINDING_TYPE_MISMATCH`, `SLOT_NOT_FOUND` |
| `ASSET` (cross-bucket write) | `ASSET_EXISTS`, `ASSET_READ_ONLY`, `ASSET_PATH_INVALID`, `ASSET_LOCKED_BY_SCM` |

**Registration rule** (cite in the spec): every new error code lands with (a) a test case that provokes it, (b) a one-line description in a central `docs/specs/error-codes.md` registry, (c) its home namespace. If a handler wants to emit a code not in the registry, the PR adds the code to the registry in the same change. This prevents the "three envelopes" regression mechanically.

### Logging discipline

Single category `LogUEMCP` with sub-categories via log verbosity discipline, not multiple categories (simpler; UE's `DEFINE_LOG_CATEGORY_STATIC` is per-module and we already have two modules).

- `LogUEMCP` in Core for protocol/dispatch/envelope.
- `LogUEMCPEditor` in Editor for handler execution.

Every request leaves **one structured log line** on completion:

```
[LogUEMCPEditor] req=<id> type=<cmd> dur=<ms> status=<ok|err> code=<err_code?> bytes_in=<n> bytes_out=<n>
```

This is enough for `grep`-based triage without a logging subsystem. Avoid dumping full request/response payloads by default — gate full-payload logging behind a console variable `uemcp.LogFullPayloads 1` for debugging sessions.

Handlers log *intent* at Verbose, *outcomes* via the dispatcher's single completion line, *anomalies* (recoverable edge cases) at Warning. Never `Log` at `Display` inside a handler; that's noise in the editor output log.

### Crash containment

This is where the legacy plugin is least defensible and where Phase 3 has to be deliberate. UE's editor is not exception-safe; a C++ `throw` from a handler propagating into the task graph will crash the editor. Rules:

1. **No `throw` in handler code.** Error path is `Response.Error(...)`, nothing else. This is a coding standard, enforced by code review plus a CI grep for `throw` in the handlers directory.
2. **The dispatcher wraps every handler call in a `try { handler.Execute(...); } catch (...) { Response.Error("INF.INTERNAL_ERROR", ...); }`.** UE does not ship with C++ exceptions enabled by default, but `/EHsc` is on for editor modules, so this works on Win64. The catch is a last-resort safety net, not an API — handlers still shouldn't throw.
3. **Null-pointer access is the realistic crash source, not exceptions.** `UObject*` pointers that were valid at dispatch time may be GC'd if a prior handler triggered a load/unload. Rule: every handler that holds a `UObject*` across any function call that might trigger GC holds it as a `TStrongObjectPtr<>` or a `FGCObjectScopeGuard`. Documented in the handler-authoring guide.
4. **`check()` is banned in handler code.** `check()` hard-crashes the editor; handlers use `ensureMsgf()` (logs but continues) paired with a defensive early return. `check()` is acceptable only in invariant-verification code that is truly impossible to reach with a valid input — and the dispatcher has already validated the input by then.
5. **Timebox async handlers.** A `prime_bp_cache` that hangs on a pathological BP must not hold the socket forever. Each async handler declares a max-runtime; the dispatcher starts a `FTimerHandle` at dispatch and forcibly fails the pending response on timeout (the handler itself may still be running; we log a WARNING and let UE carry it to completion, because killing a game-thread task from outside is not safe).

---

## Q4 — Transaction and undo model

### Verdict: dispatcher-owned transaction wrapper with per-command opt-in, never nested

One `FScopedTransaction` per incoming write request, opened by the dispatcher *before* invoking the handler and committed when the handler returns success. Handlers do NOT open their own transactions. Nested transactions in UE (`FScopedTransaction` inside another `FScopedTransaction`) collapse to the outermost, making the inner no-ops — this is safe but means per-handler transactions would silently do nothing in batch contexts we might add later. Dispatcher-owned is cleaner.

Transactability is declared in the handler schema (`FCommandSchema::bTransactable`). The dispatcher inspects the flag and wraps or doesn't.

### Matrix

| Command category | Transactable | Notes |
|---|---|---|
| Actor spawn | Yes | `AActor*` registered via `Modify()` before `SpawnActor` — actually, `SpawnActor` self-registers with the transaction if one is open. Deletion via Undo destroys the actor, which is what we want. |
| Actor delete | Yes | `Actor->Modify()` then `World->DestroyActor(Actor)`. Undo re-spawns. |
| Actor property set (via INF-6) | Yes | `Actor->Modify()` inside the property-handler registry's set path, before mutation. Every property handler's `Set()` method takes a `bTransactable` hint; dispatcher sets it true when the outer transaction is open. |
| Blueprint graph mutation (add node, connect pins, delete node) | Yes | `Blueprint->Modify()` + `Graph->Modify()` before the mutation. `UEdGraph` Undo support is mature. |
| Blueprint compile | Conditional | If paired with a mutation in the same request, the compile runs *inside* the same transaction, so Undo reverts the mutation AND re-compiles. Stand-alone `compile_blueprint` opens no transaction (nothing to undo). |
| Blueprint member declare/delete (variable, function, event) | Yes | `FBlueprintEditorUtils::AddMemberVariable` and siblings respect transactions. `delete_member` with references present: fail with `BP_HAS_REFERENCES` and list the referencers (do not silently orphan). |
| Asset lifecycle (create/duplicate/rename/delete Blueprint) | Yes for rename; No for create/duplicate/delete | `IAssetTools::RenameAssets` is transactable. Asset *creation* and *deletion* are not cleanly undoable in UE (package files on disk), and forcing Undo to delete a just-created asset silently is a footgun. Explicit `delete_blueprint` always requires a confirmation param. |
| Widget (UMG) add/remove/reparent | Yes | `WidgetBlueprint->Modify()` + `WidgetTree->Modify()`. |
| Widget binding add/modify/remove | Yes | Same as above; bindings live in the widget blueprint's graph. |
| Introspection reads (3F verbs: `bp_trace_exec`, `bp_show_node`, etc.) | No | Pure reads; no state change. |
| `bp_is_dirty` | No | Probe. |
| `prime_bp_cache` | No (and documented as such) | Disk writes to `Saved/UEMCP/BPCache/`. The *loads* it triggers to read BP content are incidentally transactable (UE loads objects into the transient transaction buffer), but we suppress Undo integration by calling `GEditor->Trans->Reset(...)` scoping it — **actually, don't do that; it resets the user's undo stack**. Instead: load BPs with `LOAD_NoWarn | LOAD_Quiet` and accept that a load may leave a no-op transaction entry. Document as a minor non-guarantee. |
| Sidecar writes (Save hook) | No | File I/O outside the UObject system. No transaction possible; documented as an explicit non-guarantee in the bucket 3F spec. |

**Non-guarantees to document:**
- Sidecar writes do not participate in Undo. If a user wants to "undo" a sidecar write, they delete the file; the next Save rewrites it.
- `prime_bp_cache` does not wrap its per-BP loads in transactions. Pathological case: priming may leave placeholder Undo entries that resolve to no-op. Users can `Edit → Undo` through them harmlessly.

---

## Q5 — Property-type handler registry (INF-6 deep design)

### Interface sketch

```cpp
// UEMCPCore/Public/Properties/IPropertyHandler.h — SKETCH
class IPropertyHandler {
public:
    virtual ~IPropertyHandler() = default;
    virtual FFieldClass* GetSupportedField() const = 0;      // FBoolProperty::StaticClass(), etc.
    virtual bool CanHandle(const FProperty* Prop) const;     // default: field-class match
    virtual FPropertyResult Set(UObject* Target, FProperty* Prop, void* Addr,
                                const TSharedPtr<FJsonValue>& Value) = 0;
    virtual FPropertyResult Get(const UObject* Target, const FProperty* Prop, const void* Addr,
                                TSharedPtr<FJsonValue>& OutValue) const = 0;
};

struct FPropertyResult {
    bool bSuccess;
    FName ErrorCode;           // PROP.TYPE_MISMATCH, PROP.UNSUPPORTED_STRUCT, etc.
    FString ErrorMessage;
    TSharedPtr<FJsonValue> ResolvedEcho;  // what we actually set, for response
};
```

Registration via `REGISTER_PROPERTY_HANDLER(FVectorHandler, FStructProperty, /*struct-name=*/TEXT("Vector"))` — macro populates a multi-key map (field class + optional struct name for struct properties). Lookup by `FFieldClass*` first, then by struct's `FName` for `FStructProperty`.

### Day-1 handlers

| Group | Handlers | Notes |
|---|---|---|
| Primitive | FBool, FInt8/16/32/64, FUint8/16/32/64, FFloat, FDouble, FStr, FName, FText | FText needs localization-aware set/get (StringTable-lookup support) |
| Enum | FByte-with-enum, FEnum | Read by name or int; write by name preferred, int accepted |
| Core structs | FVector, FVector2D, FRotator, FQuat, FTransform, FColor, FLinearColor, FIntPoint, FIntVector, FBox, FPlane | Recursive-set with per-field ("x","y","z") or array ([x,y,z]) forms |
| Object references | FObject (hard), FSoftObject, FClass, FSoftClass | By asset path `/Game/...`; resolve via `StaticLoadObject`; `NULL` explicitly allowed |
| Collections | FArray (of any supported element), FMap (of supported K/V), FSet (of supported element) | Recurse into element handler |
| Structs (user-defined) | FStruct (generic fallback) | Recurse into member FProperties using registered handlers; fail with `UNSUPPORTED_STRUCT` if any member has no handler AND no subordinate handler can be found |
| Delegates | FDelegate, FMulticastDelegate | **Explicit failure with `UNSUPPORTED_DELEGATE_WRITE`**. Delegate binding via property-set is not how UE works; it's the blueprint graph's job. Reads return a structural summary (bound count, signature) but writes are refused. |

**The generic FStruct fallback** is the correct answer, not a failure. Walk child properties, delegate to their handlers. If a child has no handler AND is not itself a recursable struct, fail the whole set with `UNSUPPORTED_STRUCT` naming the offending path (e.g., `MyStruct.Inner.Unknown`). This gives us broad coverage without enumerating every user struct, and the error message tells Claude exactly what's missing.

### Registration ordering

Eager at module `StartupModule()`. All built-in handlers register in `UEMCPCore`. Registration is idempotent (re-registering the same field-class replaces the entry, with a `Warning` log) so hot-reload is survivable.

### Extensibility

**Verdict: downstream projects CAN register handlers without forking.** ProjectA-specific struct (`FOSCombatPayload`) needs a custom handler? ProjectA ships a small editor module `ProjectAUEMCPExtensions` that depends on `UEMCPCore` and calls `FUEMCPPropertyRegistry::Get().Register(...)` from its `StartupModule`. The registry API is public.

This is non-negotiable because ProjectA and ProjectB have project-specific USTRUCTs, and telling those teams "fork UEMCP and add your struct handler" is the kind of decision that kills adoption.

---

## Q6 — Protocol evolution on TCP:55558

Sub-verdicts:

### Length framing: YES — 4-byte BE length prefix on both directions

The legacy parse-until-valid approach works only because responses are small and single-JSON. For bucket 3F, a `dump_graph` on a 2000-node combat controller could push 200 KB+ of JSON. Parse-until-valid under TCP fragmentation gets increasingly hazardous as payloads grow (incremental JSON parsers have corner cases with escaped strings containing `}`). Length framing is 4 bytes and a parser simplification.

Server-side impact: `connection-manager.mjs` grows a small `FrameReader` on the 55558 code path. 55557 stays unchanged (it's being deprecated). The framing layer is ~30 LOC of Node.js. Worth it.

### Connection model: persistent connections with multiplexed request/response

Legacy connect-per-command burns a TCP handshake per read. For 3F verb composition (Claude calling `bp_show_node` on 10 nodes to understand a scene), that's 10 handshakes where 1 would do. Persistent connections with request_id-based response routing are worth the complexity:

- Plugin-side: connection struct holds `request_id → socket` mapping (though in a single persistent connection it's just "this socket"); async handlers write back when ready.
- Server-side: `ConnectionManager` already serializes per-layer via `CommandQueue`. With persistent connections we can relax this to "in-flight concurrent reads, serialized writes" — parallel `bp_show_node` calls can be in flight simultaneously.

Fallback: the protocol supports connect-per-command too, for simple clients and for the test harness. Persistent is the default; single-shot works.

### Streaming responses: YES for async commands, via progress messages

Async handlers that declare `bSupportsProgress` can emit intermediate messages with `status: "progress"`, carrying `{percent, message}` in `result`. Final response has `status: "success"` or `"error"`. Messages share the `request_id`.

Server-side: consumer can subscribe to progress (pass through to Claude as tool-call hints) or ignore it (wait for final). `prime_bp_cache` is the motivating use case; no other v1 handler needs it.

Not a polling pattern (more protocol), not callback URLs (requires server-side HTTP receiver — overkill).

### Timeouts: handler-declared hints, server-side enforcement

Each handler declares `MaxRuntimeMs` in its schema. `list_commands` exposes it. Server-side reads the hint and uses it as the default timeout for that command (overrideable per-call). If the handler declares 30000 ms for `prime_bp_cache`, the server gives it 30s before considering the request failed.

This is better than one-size-fits-all because `bp_is_dirty` can be 500 ms (fast-fail) while `prime_bp_cache` can be 30s — both configured from one source.

### Backward-compat bridge: NO — hard cut, phased per-toolset

55557 and 55558 run in parallel during Phase 3, but they speak different protocols. Each `tools.yaml` entry has a `layer:` field; we flip tools from `tcp-55557` to `tcp-55558` one toolset at a time as the 55558 handlers land and pass conformance. When all three transitional toolsets are flipped, 55557 is shut off entirely.

A "55558 accepts 55557 requests" bridge would require us to carry legacy protocol quirks into the new plugin — specifically the three error envelopes and connect-per-command semantics. That's exactly the technical debt we're leaving behind.

### Migration plan for 55557→55558

1. **Phase 3 land**: 55558 online, 55557 still online. `tools.yaml` entries untouched (still target 55557). `list_commands` on 55558 shows the new surface.
2. **Conformance pass per toolset**: for `actors`, `blueprints-write`, `widgets`, run a capture-replay suite that calls every tool against 55557 and 55558 and diffs responses. See Q11 for the test strategy.
3. **Flip toolset**: when a toolset passes conformance, change `layer:` in `tools.yaml` to `tcp-55558`, run the full test suite, ship.
4. **Deprecation window**: 55557 stays online for one milestone post-flip. If no regressions, 55557 is removed from ProjectA's plugin manifest and the `UnrealMCP` plugin directory is deleted.
5. **Oracle retirement**: `docs/specs/conformance-oracle-contracts.md` becomes historical. Replaced by `docs/specs/uemcp-plugin-contracts.md` generated from the plugin's `list_commands` output.

---

## Q7 — Bucket 3B: Actor commands architecture

### Unified actor-ref parameter shape

**Verdict: yes, define `FActorRef` as a shared param schema.**

```
actor_ref: {
  name?: string,          // FName (exact match, fast path)
  label?: string,         // Outliner label (fuzzy-resolvable, slower)
  fname?: string,          // Explicit FName (alias for name, for clarity in logs)
  level_name?: string,     // Optional scope for multi-level worlds
  class?: string           // Optional class filter to disambiguate
}
```

Resolution rule (consumed by a shared `ResolveActorRef` helper in `UEMCPCore`):
1. If `name` (or `fname`) is set: exact FName lookup across all loaded levels (fix for INF-1). One result: win. Zero: `ACTOR_NOT_FOUND`. Multiple (across sublevels): use `level_name` to disambiguate; if missing, `AMBIGUOUS_NAME` with the list.
2. Else if `label` is set: Outliner-label match. Case-sensitive by default. If `class` is set, filter by it. One match: win. Zero: `ACTOR_NOT_FOUND`. Multiple: `AMBIGUOUS_LABEL` with list.
3. Else: `MALFORMED_PARAMS` ("actor_ref must specify name or label").

The helper returns `{Actor, LevelName, ResolvedName, ResolvedLabel}` for echo in the response. Every handler that targets an actor uses this helper; no handler re-implements lookup.

### Batch commands: defer to v1.1, but reserve the wire shape

**Verdict: ship singular commands in v1 (`spawn_actor`, `set_actor_transform`); add `batch` as an additive wrapper in v1.1.**

Batch design: `batch` takes an array of sub-requests, returns an array of sub-responses keyed by an index. Additive — doesn't break singular. No wire-protocol change (each sub-request is a full command envelope sans transport). Cost of retrofit: low, because the dispatcher already routes by `type`.

What we buy by deferring: handler implementations stay simple in v1, transaction semantics stay one-request-one-undo. When we add batch, we decide per-command whether batch wraps in a single transaction or keeps per-sub-request transactions.

### BP actor vs native actor

**Verdict: single `spawn_actor` handler with BP-aware path.**

Handler resolves `class` param by trying in order: (a) `FindObject<UClass>(ANY_PACKAGE, ClassName)` for native, (b) `LoadClass<AActor>(nullptr, *ClassPath)` for BP assets. The legacy plugin had this bifurcated; merging is cleaner and matches user expectation ("I just want to spawn this thing").

### Actor component commands

**Verdict: component ref is a sub-object of actor ref — `{actor_ref, component_name}` where component_name is the FName.**

Commands: `add_component`, `remove_component`, `get_component_property`, `set_component_property` (delegates to INF-6 property registry). Component hierarchy in responses: flat list with `parent_component` field per component (not a tree — flat is easier for Claude to reason about and avoids recursive JSON).

Scope to v1: `add_component` supports adding by class name. Moving components between parents (reparenting scene components) is a v1.1 thing — it's rare and has edge cases around transform preservation.

### 3B commands-and-params inventory (v1)

| Command | Params | Notes |
|---|---|---|
| `spawn_actor` | `class`, `location?`, `rotation?`, `scale?`, `label?`, `level_name?` | Returns `{actor_ref, spawned_name}` |
| `destroy_actor` | `actor_ref` | Transactable |
| `set_actor_transform` | `actor_ref`, `location?`, `rotation?`, `scale?` | Partial updates allowed; INF-2 bool-returning parser |
| `get_actor_transform` | `actor_ref` | Read |
| `set_actor_property` | `actor_ref`, `property_name`, `value` | Delegates to INF-6 |
| `get_actor_property` | `actor_ref`, `property_name` | Read |
| `list_actors` | `level_name?`, `class_filter?`, `label_pattern?` | Level-traversing; paginated if >N |
| `add_component` | `actor_ref`, `component_class`, `component_name?`, `parent_component?` | Transactable |
| `remove_component` | `actor_ref`, `component_name` | Transactable |
| `list_components` | `actor_ref` | Flat list w/ parent_component field |
| `set_component_property` | `actor_ref`, `component_name`, `property_name`, `value` | Delegates to INF-6 |
| `get_component_property` | `actor_ref`, `component_name`, `property_name` | Read |

Open questions: how to address actors in unloaded World Partition cells (defer — WP awareness is a v1.1 concern; for v1, document that actors in unloaded cells aren't visible to `list_actors`).

---

## Q8 — Bucket 3C: Blueprint write command architecture

### Graph-mutation grammar: verbose primitives in v1, consider patch-format in v1.1

**Verdict: ship the primitives (`bp_add_node`, `bp_connect_pins`, `bp_delete_node`, `bp_set_pin_default`, `bp_move_node`). Do NOT build `apply_patch` in v1.**

Patch-format is attractive on paper (one command = one round-trip) but has three problems:
1. Diff-and-apply requires the plugin to compare a proposed graph to the current graph at node-ID granularity, which means the patch format must match the dump format from 3F exactly. That coupling is real and fragile.
2. Atomicity: either the patch applies entirely or nothing; partial application leaves BP in an undefined state. Implementing this correctly requires staging the patch against a cloned graph and swapping — UE's graph infrastructure doesn't support clean graph cloning.
3. Claude can already compose primitives into a coherent change. The token cost is real but not dominant; we have bigger wins available (streaming, caching).

Reconsider in v1.1 once we see the actual call patterns in production. If Claude is emitting 50-primitive sequences for routine changes, patch-format becomes worth it.

### Member declaration: unify under `bp_declare_member` and `bp_delete_member`

Legacy has separate `AddMemberVariable`, `CreateFunction`, `CreateEvent`. Unify under:
- `bp_declare_member` with `kind: "variable" | "function" | "event" | "macro"` and kind-specific params in `details`.
- `bp_delete_member` with the same shape.

`delete_member` with existing references: fail with `BP_HAS_REFERENCES` listing the referencers by node-id-and-graph. Do NOT auto-orphan. If the caller really wants to delete-anyway, they pass `force: true` and take the consequences (refs become compile errors; compile result reports them).

### Event and delegate bindings

Scope for v1: `bp_bind_event` (add an event-dispatch binding via graph node composition — this is just `bp_add_node` with a specific node type; not a new primitive). `bp_bind_delegate` similarly. No new command surface needed if the primitives are right.

### Compile autopilot

**Verdict: on-explicit-command, not automatic.**

Post-mutation auto-compile seems helpful but is pathological for multi-step compositions (20 node adds = 20 compiles, each 100–500 ms). Instead:
- Every mutation command returns a `bp_dirty: true` flag in the response when the BP now needs compile.
- Caller (server-side) knows to issue `bp_compile` when done.
- `bp_compile` returns `FCompilerResultsLog` (closes P0-5) with errors and warnings as structured entries, not just `{compiled: true}`.
- Optional `auto_compile_after: true` param on any mutation command for single-shot cases.

### Asset lifecycle

| Command | Transactable | Confirmation required | Notes |
|---|---|---|---|
| `create_blueprint` | No | No | `class`, `path`, `parent_class`. Returns new asset path. |
| `duplicate_blueprint` | No | No | `source`, `dest_path`. |
| `rename_blueprint` | Yes | No | Via `IAssetTools::RenameAssets`. Updates all references. |
| `delete_blueprint` | No | Yes (`confirm: true`) | Refuses to delete if referenced; `force: true` to override. |

**No SCM integration in v1.** Plugin stays strictly out of P4/Git operations. A user workflow of "create BP, submit to P4" requires two steps: call `create_blueprint`, then the user runs `p4 add` themselves (or an SCM-aware UEMCP tool on a separate layer does it). Baking SCM into the plugin couples us to repo-specific behavior we don't want to own.

### 3C inventory (v1)

| Command | Purpose |
|---|---|
| `bp_add_node`, `bp_delete_node`, `bp_move_node`, `bp_connect_pins`, `bp_disconnect_pins`, `bp_set_pin_default` | Graph primitives |
| `bp_declare_member`, `bp_delete_member` | Members |
| `bp_compile` | Explicit compile, full results |
| `create_blueprint`, `duplicate_blueprint`, `rename_blueprint`, `delete_blueprint` | Asset lifecycle |
| `bp_set_variable_default` | CDO-independent (metadata default, not instance default) |

---

## Q9 — Bucket 3D: UMG command architecture

### Widget hierarchy: generic `widget_class` parameter in v1

**Verdict: single `umg_add_widget` handler taking `widget_class: string` (resolves to `UWidget` subclass), not per-class handlers.**

Legacy had `AddTextBlock`, `AddButton`, specific per-class. Generic resolves via `FindObject<UClass>` or `LoadClass<UWidget>` and calls `WidgetTree->ConstructWidget<UWidget>(Class, Name)`. Standardizes P0-7 path handling in one place.

### Binding model

**Verdict: support both function-bound and property-bound in v1; explicit kind param.**

```
umg_bind_property:
  widget_ref, property_name, binding_kind: "function" | "property",
  source_function?: string,      // for function binding
  source_property?: string       // for property binding
```

Response includes the generated binding node/graph IDs so follow-up queries can inspect. Validates the binding type against the property's expected type (fixes the "accepts any signature" legacy bug) via pin-type compatibility checks (piggybacks on P0-11).

### Named slots and slot properties

**Verdict: slots as structured params, fully in scope for v1.**

UMG's slot model is non-trivial: every child-of-panel has a `Slot` property of a panel-specific type (`UCanvasPanelSlot`, `UHorizontalBoxSlot`, etc.) with panel-specific layout properties (anchors, padding, alignment, fill). Legacy plugin ignored this, which is why so many UMG scenes positioned via UEMCP look broken.

Handler: `umg_set_slot_property` takes `{widget_ref, property_name, value}`. Delegates to the INF-6 property registry — the slot's layout properties are just FProperties on the `UPanelSlot` subclass. The registry reuse here (per Q10.2) means we get FVector2D / FAnchors / FMargin handling for free.

Named-slot override (a child widget occupying a named slot in a parent widget blueprint) is a separate command: `umg_set_named_slot_content`. Scope in v1; it's a small surface and essential for widget composition.

### Widget animation

**Verdict: defer to v1.1.**

UMG animations (`UWidgetAnimation`, `UMovieScene` tracks) are a separate graph infrastructure. In-scope reads (list animations, get track summary) are feasible in v1 if needed; writes (add tracks, key frames) are a substantial new surface we shouldn't take on concurrent with the rest of 3D landing. Reserve the `umg_anim_*` command prefix in the schema but don't ship handlers.

### 3D inventory (v1)

| Command | Purpose |
|---|---|
| `umg_add_widget`, `umg_remove_widget`, `umg_reparent_widget`, `umg_rename_widget` | Tree mutation |
| `umg_set_widget_property`, `umg_get_widget_property` | Property read/write (via INF-6) |
| `umg_set_slot_property`, `umg_get_slot_property` | Layout |
| `umg_set_named_slot_content` | Slot composition |
| `umg_bind_property`, `umg_unbind_property` | Bindings |
| `umg_list_widgets` | Tree dump |
| `umg_list_animations` | Read-only anim introspection |

Open: widget blueprint *inheritance* (child WBP adjusting inherited widgets) — handle on demand; document as "supported but may have edge cases."

---

## Q10 — Bucket 3F integration

Prior research at `docs/research/blueprints-as-picture-design-research.md` (Q1–Q6) is ground truth. Below are the integration findings only.

### Q10.1 — Error envelope alignment

**Verdict: 3F adds to the `BP.*` namespace; dirty-editor is a `warning` when serving stale, an `error` when caller explicitly required fresh; sidecar schema version rides the envelope.**

Codes to add: `BP.SIDECAR_STALE`, `BP.SIDECAR_SCHEMA_MISMATCH`, `BP.DIRTY_EDITOR`, `BP.CACHE_MISS`, `BP.NO_SIDECAR_AND_EDITOR_OFFLINE` (the amendment's named error stays; promoted to the registry under `BP.`).

Dirty-editor semantics (fix ambiguity in narrower research §Q3 row 4): `bp_is_dirty` is always a success-status response with `result: {dirty: bool, dirty_hash?: string}`. Other verbs (`dump_graph`, `bp_trace_exec`, etc.) take an optional `require_fresh: bool` param:
- `require_fresh: true` + dirty + editor reachable: handler routes to live extraction (TCP path), success.
- `require_fresh: true` + dirty + editor unreachable: error `BP.DIRTY_EDITOR`.
- `require_fresh: false` (default) + dirty: warning `BP.SIDECAR_STALE` in `warnings[]`, result served from sidecar with `staleness` metadata. Caller decides.
- Fresh sidecar: success, no warning.

**Sidecar schema version** goes in the envelope (top-level `schema_version` for the payload format — rename or dedicated field `bp_schema_version` to avoid conflict with the envelope version). Reader on the server can fast-reject mismatched versions without fully parsing `result`. Minor versions coexist; major mismatch triggers `BP.SIDECAR_SCHEMA_MISMATCH`.

### Q10.2 — Property-type registry reuse

**Verdict: shared. Sidecar writer and INF-6 handlers use the same `IPropertyHandler::Get()` path to serialize values.**

The pin-default serialization in a BP dump needs FVector/FRotator/FObject (asset path) support — exactly what INF-6 already provides in the `Get()` direction (UObject → JSON). Reusing the registry means:
- Adding a property handler (e.g., for a new game-specific struct) automatically extends both the INF-6 property surface AND the BP dump format. One place to add, two surfaces improved.
- The "resolved form" in `FPropertyResult::ResolvedEcho` is identical to what appears in a sidecar. Claude sees one value format across all UEMCP tools.
- Module dependency: `IPropertyHandler` lives in `UEMCPCore`, consumed by the TCP dispatcher's `set_*_property` handlers AND by the sidecar writer in `UEMCPEditor/Introspection/`. Clean.

Drift prevention: a single integration test asserts that a BP dump and an equivalent `get_actor_property` response agree on FVector/FRotator/FObject rendering for the same input. If they diverge, CI fails.

### Q10.3 — Transaction semantics for `prime_bp_cache`

**Verdict: non-transactable, with the caveat documented.**

Sidecar writes are disk I/O, not UObject mutation — no transaction possible. The per-BP loads `prime_bp_cache` triggers *may* create no-op Undo entries in the user's transaction buffer (UE loads objects into the buffer opportunistically). This is documented in the 3F spec as an explicit non-guarantee:

> `prime_bp_cache` may add no-op entries to the editor Undo stack during the priming sweep. These are harmless and can be cleared by any substantive edit.

Mitigation considered but rejected: calling `GEditor->Trans->Reset()` around priming. Rejected because it wipes the user's real Undo history — the cure is worse than the disease.

### Q10.4 — Protocol support

The Q6 decisions cover 3F correctly:
- **Streaming**: `prime_bp_cache` is the canonical use case; the `status: "progress"` messages from Q6 are exactly what the amendment needs (progress every 10%/100 BPs).
- **Length framing**: `dump_graph` on large BPs pushes 200 KB+ payloads. Framing is mandatory at this scale, not optional. 3F is the reason framing is not-negotiable in Q6.
- **`bp_is_dirty` fast-path**: no special protocol support needed; it's a regular sync command with `MaxRuntimeMs: 500`. Persistent connections (Q6) mean repeated `bp_is_dirty` calls don't churn TCP handshakes. Adequate.

### Q10.5 — Server-side cache composition

**Verdict: 3F verbs get their own cache layer on the server; `tools.yaml` gains a `fallback_layer` field.**

Two cache layers, not one:
1. `ResultCache` (existing, SHA-256 keyed, 5 min TTL) for TCP command responses — covers live 3F reads via `dump_graph` when sidecar is stale/dirty.
2. `SidecarCache` (new, `{path, mtime, size, schema_version}` keyed, D33 invalidation model) for parsed sidecar content. Memory-resident parsed JSON, invalidated when disk mtime/size changes.

The two cooperate: a `bp_show_node` call first checks SidecarCache (fast, no network); miss or stale → checks editor-reachable via cached `bp_is_dirty` result (30s TTL) → either TCP fetch (populates ResultCache) or returns sidecar-is-authoritative.

**Empty-cache detection**: `connection-manager.mjs` on init checks if `Saved/UEMCP/BPCache/` exists and is non-empty. If the plugin is also reachable, it issues a `prime_bp_cache` at low priority. The auto-prime behavior from narrower research §Q1b is the plugin's *own* response to empty cache; the server just observes and logs. No handshake needed.

**`tools.yaml` schema addition**: 3F verbs get `layer: tcp-55558` AND `fallback_layer: offline-sidecar`. The tool runner tries primary layer first; on unreachable, tries fallback. Other tools (write ops) have no fallback and just fail. This is a small `tools.yaml` schema extension: add optional `fallback_layer` field, parse it in `toolset-manager.mjs`, wire it through.

### Q10.6 — Cross-BP reasoning caveat

**Verdict: genuine v1.1 gap; reserve `bp_find_global` as a named placeholder.**

Nothing in 3B/3C/3D closes the gap (they're all single-BP surfaces, and 3B actor commands operate on live world state not BP static analysis). Track 2a's asset-registry parser gets us closer — it can answer "which BPs reference class X" at the registry level — but not "which BP graphs contain a node calling `RemoveLooseGameplayTag`."

Reserve `bp_find_global` in the spec:
- Signature: `{predicate: NodeSearchPredicate, scope: "project" | "plugin" | "path-prefix"}`
- Behavior: walk the SidecarCache (requires prime to be complete), apply predicate, return list of `{blueprint_path, graph_name, node_id}` hits.
- Deferred because it requires thinking about predicate language richness, scope controls (performance; scanning 500 sidecars per query), and probably pagination.

Document in tool descriptions for the v1 nine verbs that they are single-graph — prevents Claude from silently hitting the gap mid-reasoning.

---

## Q11 — Offline-side consumption: server/plugin boundary

### Cache architecture server-side

Two cache layers (reiterating Q10.5 in a fuller frame):

```
┌──────────── Claude ────────────┐
              │ (MCP stdio)
┌──────────── server.mjs ────────────────────────────┐
│  ToolsetManager → handler dispatch                 │
│     │                                              │
│     ├── Offline tools  ─────────── disk reads     │
│     ├── TCP tools (55558) ─────┐                   │
│     └── Sidecar-backed tools ──┼── SidecarCache   │
│                                │   (mtime+size+   │
│                                │    schema_ver)   │
│                                │                   │
│                           ResultCache              │
│                          (5min, SHA-256)           │
└─────────────────────────────┬──────────────────────┘
                              │ (framed TCP)
┌─────────── UEMCP Plugin ────▼──────────────────────┐
│  FMCPServerRunnable → Dispatch                     │
│     │                                              │
│     ├── Handlers (actor/bp/umg/introspection)     │
│     └── Sidecar Save-hook writer ─── Saved/UEMCP/ │
└────────────────────────────────────────────────────┘
                                 │
                         ┌───────▼───────┐
                         │  .bp.json     │  ← disk,
                         │   sidecars    │    also readable
                         │               │    by offline-mode
                         └───────────────┘
```

The SidecarCache layer is new Node.js infrastructure (~100 LOC). Parses sidecars lazily on first access; caches parsed JSON; watches via mtime/size checks on every access with a 60s-TTL'd `fs.stat` call to avoid per-call filesystem hits. Invalidation is pull-based (no `fs.watch` — fragile under WSL / network mounts).

### Graceful degradation / fallback matrix

| Tool category | Plugin up | Plugin down (editor closed) | Plugin down + sidecar present | Plugin down + sidecar absent |
|---|---|---|---|---|
| Offline (disk reads, AR tags) | Works | Works | Works | Works |
| 3F reads | TCP or sidecar | Sidecar-only | Works (stale-tolerant) | `NO_SIDECAR_AND_EDITOR_OFFLINE` |
| Actor commands | Works | Fails (TOOL_UNAVAILABLE) | Same | Same |
| BP write commands | Works | Fails | Same | Same |
| UMG commands | Works | Fails | Same | Same |
| Asset registry queries (Track 2a) | Works (offline tool) | Works | Works | Works |

**Tool visibility policy**: tools stay visible in `tools/list` always; failing at call time with `TOOL_UNAVAILABLE` is better than the surface shape changing based on editor state. Claude can try any tool; a failed call with a clear error code is more informative than "tool doesn't exist."

Exception: 3F tools with `fallback_layer: offline-sidecar` silently try the fallback first when the primary layer is unreachable. No user-visible error on the reachable-cache path.

### Write-op deduplication

**Verdict: plugin-side, keyed by request_id, 5-minute TTL ring buffer.**

Server-side dedup is also fine but the plugin is the terminal enforcement point — if a server bug double-dispatches the same request_id, plugin-side dedup catches it. Implementation: `TCircularQueue<FRequestDedupEntry>` holding (request_id, response_hash) pairs. On incoming request, check ring; match → return cached response with `warnings[]: [{code: "INF.DEDUPED"}]`; miss → proceed. 5 min TTL keeps the buffer small.

Server-side ALSO dedups as a latency optimization (avoid TCP round-trip on a retry), but the plugin is the safety net. L3 is now implementable.

### Conformance oracle retirement

**Verdict: parallel-run with response diffing per toolset, cut over per toolset, retire 55557 one milestone after the last flip.**

Test strategy:
1. **Capture suite**: take the existing `test-tcp-tools.mjs` FakeTcpResponder tests and extend them to run against BOTH 55557 and 55558 in integration mode (flag-gated, not default — requires a running editor). Assertions target 55557 behavior; 55558 must match.
2. **Golden-response corpus**: for each of the 36 oracle commands, capture 3–5 representative request/response pairs from 55557 in a `tests/corpus/` directory. 55558 handler-under-test must produce byte-equivalent responses modulo allowed differences (error code rename, envelope schema_version).
3. **Allowed-diff allowlist**: each error-envelope normalization that 55558 introduces goes in a `tests/corpus/normalized-diffs.md` with the justification. CI fails if 55558 produces a diff not in the allowlist.
4. **Per-toolset flip gate**: a toolset flips from 55557 to 55558 only when (a) all oracle contracts pass conformance, (b) all P0 items in that bucket are closed, (c) allowed-diff list is reviewed by Noah.
5. **Retirement**: one milestone after the last flip with no production regressions, remove `UnrealMCP/` from ProjectA's plugin manifest. Archive `docs/specs/conformance-oracle-contracts.md` to `docs/audits/` with a dated header noting retirement.

---

## Q12 — Interaction with Track 2a (offline asset-registry parser)

The sidecar reader can cheaply cross-check sidecar-claimed identity against Track 2a's AssetRegistry extraction. Both read from the same `.uasset` but at different depths — Track 2a parses the registry tag block (class, parent, interfaces, tags), the sidecar carries the full graph dump. Running both and comparing `{name, class, path, parent}` catches the sidecar-stranded-at-old-path case (narrower research §Q3 row 8) and the rare but real "sidecar was copy-pasted next to the wrong `.uasset`" failure. Cost: ~10 LOC of field comparison and a warning log. Recommend doing it, not gating on it — a mismatch logs and falls back to TCP, doesn't fail the read.

New offline queries become possible when both are present. Examples: "show every BP that derives from `AOSCharacter` AND contains a call to `RemoveLooseGameplayTag`" — Track 2a answers the derivation side, SidecarCache answers the node-containment side, composition happens server-side. Or: "list all BPs tagged with interface `IZKAbilitySystemInterface` and dump their EventGraphs in summary form." These compositions are a strong argument for keeping both layers as first-class offline citizens in `tools.yaml` — 3F tools with `fallback_layer: offline-sidecar` become fully independent of the editor once Track 2a and the sidecar cache are both warm.

Shared parse infrastructure: Track 2a's `.uasset` parser has primitives (magic-number check, `FPackageFileSummary` parse, name-table reader) that a hypothetical Path B offline BP extractor would reuse. We've ruled Path B out permanently, but the reuse opportunity is real: Track 2a's header-parser should live in a module or file structured for reuse (even though nothing else in Phase 3 uses it) so that future tools needing `.uasset` header data — perhaps a lightweight `is_this_file_a_blueprint` check before attempting sidecar lookup — can consume it. Flag this as a note for Agent 3's final report; not a blocker.

---

## Q13 — Cross-cutting: testability, distribution, risk

### C++ test infrastructure

**Verdict: UE Automation Testing Framework for integration tests, plain C++ unit tests for Core-module logic.**

UE Automation (tests declared via `IMPLEMENT_SIMPLE_AUTOMATION_TEST`) runs inside a headless editor and is the only honest way to test handlers that touch `UBlueprint`, `UEdGraph`, `UWidget`. Slow (10s+ per test for editor startup), but necessary for the editor-dependent surface. Scope: one integration test per command category (spawn, compile, widget add, dump_graph), not per command.

Pure C++ unit tests (no UE dependency) for `UEMCPCore` internals — envelope parsing, error code registration, property-handler registry lookup, dispatch registry. Run in CI on every PR. Fast (milliseconds). Caught-early feedback loop.

Testable handler shape: every handler takes its dependencies through `FCommandContext` (logger, property registry, world-or-asset-finder). For unit tests, we pass a mock context with fake dependencies. The `FActorRef` resolver (Q7) is a good example — it's a pure function over a world-finder interface, so it's testable without spinning up a world.

The legacy plugin has zero tests. That's the wrong baseline; we ship with at least one integration test per command category and unit coverage ≥80% on Core.

### Distribution

Plugin ships as C++ source in the `D:\DevTools\UEMCP\plugin\` directory. ProjectA syncs via Perforce (copy-in-on-submit by a maintainer), ProjectB via Perforce too. Both build from source — binary `.uplugin` isn't viable because engine version / platform skew would require a binary per (engine version, platform, config) combination and we don't have the CI for that.

**Version skew risk**: ProjectA is UE 5.6, ProjectB is UE 5.7. API differences between 5.6 and 5.7:
- `FCoreUObjectDelegates::OnPackageSavedWithContext` — present in 5.1+, stable.
- `UEdGraph` / `UEdGraphNode` — stable.
- `FBlueprintEditorUtils` — minor churn in function signatures between 5.6 and 5.7 (confirmed by context7 lookup of recent release notes).
- `IAssetTools::RenameAssets` — stable.

Plan: compile-test against both engine versions in CI. For functions that changed signature, `#if ENGINE_MAJOR_VERSION == 5 && ENGINE_MINOR_VERSION >= 7` wrappers in the handlers directory. Document the supported engine range in `UEMCP.uplugin`.

Distribution mechanism beyond source copy-in: deferred to Phase 5.

### New risks for the register

| ID | Risk | Impact | Mitigation |
|---|---|---|---|
| R-P3-1 | Live Coding breaks dispatch registry on hot-reload, double-dispatching commands | Editor instability during dev | `REGISTER_COMMAND` macro writes to a registrar cleared in `ShutdownModule`; document Live Coding constraints |
| R-P3-2 | `UPackage::PackageSavedEvent` handler stalls editor save flow | Developer-visible save hangs | Hard time cap on handler body (bp-2000-node test); bool-return file I/O; skip-on-failure; integration test suite for adverse save conditions |
| R-P3-3 | Property handler registry doesn't cover a user USTRUCT, command fails opaquely | Broken set_property on ProjectA/ProjectB types | Extensibility API; `UNSUPPORTED_STRUCT` error names the offending field path; downstream projects register their own |
| R-P3-4 | Sidecar schema bump invalidates every cache project-wide mid-sprint | Dev confusion, perceived broken tools | Auto-prime on empty cache detection; schema version in freshness key; schema bumps gated to minor releases |
| R-P3-5 | Engine version skew (5.6 vs 5.7) leaks into handler source and fails to compile on the other | Plugin broken for one project | `#if ENGINE_MAJOR_VERSION/MINOR_VERSION` wrappers; CI builds both versions |
| R-P3-6 | Oracle response diffing reveals non-trivial behavioral differences late in Phase 3, blocking cutover | 55557→55558 flip slips | Capture golden corpus early (in parallel with handler work); allowed-diff allowlist reviewed per-flip |
| R-P3-7 | `prime_bp_cache` on a 500+ BP project takes 30s+, blocks first editor launch perceptibly | Bad first-impression | Auto-prime is background task (non-blocking); progress reporting to editor output log; document expected cost |
| R-P3-8 | Cross-BP queries hit the `bp_find_global` gap mid-conversation, Claude gives wrong answer confidently | Silent correctness failure | Tool descriptions explicitly scope 3F verbs to single-graph; track `bp_find_global` as v1.1 top priority |
| R-P3-9 | Persistent connection model has a reconnect race under editor restart | Server sees stale connection, requests silently drop | Keepalive ping every 30s; reconnect with backoff; log state transitions |
| R-P3-10 | UE 5.7 deprecates `UPackage::PackageSavedEvent` in a patch release | 3F Save hook breaks silently | Use `OnPackageSavedWithContext` (newer name); regression test in CI on each 5.x patch release |

---

## Summary of recommendations

The Phase 3 plugin is a two-module editor plugin (`UEMCPCore` + `UEMCPEditor`) with a `UEditorSubsystem` lifecycle anchor, a macro-registered `TMap<FName, TUniquePtr<ICommandHandler>>` dispatch table, a canonical tri-status envelope with a dotted error-code namespace, dispatcher-owned per-request `FScopedTransaction` wrapping, a property-type handler registry reused by both the TCP set-property surface and the sidecar graph writer, 4-byte-length-framed persistent connections with streaming progress responses, and a sidecar-first bucket 3F that integrates into the server via a second cache layer and a `fallback_layer` extension to `tools.yaml`. The 55557 oracle retires one milestone after the last toolset flip, with a capture-and-replay conformance suite gating each flip. Ten new risks for the register.

Open questions requiring Noah's decision are surfaced inline and summarized in the final report.
