# Class-resolution consolidation — design

**Date:** 2026-05-25
**Status:** Design (approved); implementation plan to follow.
**Goal:** Eliminate the "class resolution only works if the asset is already loaded this session" quirk by routing all live-editor class resolution through one shared **load-first** resolver, and guard against regression.

## Background — the quirk

Reported on a real 5.3 project (engine 5.3). UEMCP's live editor handlers (TCP:55558) resolve a `UClass` from a user-supplied identifier. Some sites use `FindObject<UClass>` / `TObjectIterator<UClass>`, which only see objects **already in memory**. Native engine classes (`/Script/Engine.*`) are always loaded so they resolve fine, masking the bug — but a `/Game/...` **Blueprint-backed** class only resolves if it happens to be loaded in the session (e.g. opened in the editor). The fix is to load from disk (`LoadClass`/`LoadObject`/`SoftObjectPath::TryLoad`) rather than only find-in-memory. Engine-version-agnostic; 5.3 was just where it was noticed.

## Audit — current resolution sites (`plugin/UEMCP/Source/UEMCP/Private`)

**Correct (load-first) — the templates to converge on:**
- `HandlerCommon::ResolveBlueprint` — `LoadObject` + `SoftObjectPath::TryLoad`.
- `ReflectionWalker::ResolveClass` — `LoadClass` + `_C`-suffix synthesis + `TryLoad`.

**Asset-blind (the quirk):**
- `AnimationHandlers::ResolveNotifyClass` — `FindObject<UClass>`-only, then a `TObjectIterator<UClass>` "fallback" that shares the same loaded-only blind spot. Fails for `/Game` Blueprint notify classes.
- `BlueprintHandlers` add-component (≈1124–1148) — interleaved `LoadClass`/`FindObject`; the suffix/prefix variants use `FindObject` only, so `/Game` component Blueprints are asset-blind.
- `BlueprintHandlers` reparent/target (≈1809–1818) — `FindObject` + `/Script/Engine.` `LoadClass`; no `/Game` `LoadClass`, so `/Game` target classes are asset-blind.

**Load-based but narrow (not the quirk, but inconsistent — route through the shared resolver too):**
- `BlueprintHandlers` class-pin default (≈756–761) — `LoadObject<UClass>` + `/Script/Engine.` only; lacks `_C` synthesis / `SoftObjectPath::TryLoad`, so a package-only or BP-generated-class path can miss.
- `BlueprintHandlers` actor-class resolve (≈1045–1056) — hardcoded `APawn`/`AActor` + `/Script/Engine.` / `/Script/Game.` `LoadClass`; no `/Game` path, so `/Game` actor Blueprints don't resolve.

These two are not `FindObject`-blind, so the Find-only guard would **not** flag them — see the widened guard scope below. Root cause of drift: each site hand-rolls its own `Find`/`Load` chain with different fallbacks.

## Design (layered: load-first core + caller adapters)

### Component 1 — shared load-first resolver
In `HandlerCommon.{h,cpp}`, alongside `ResolveBlueprint`:

```cpp
// Load-first UClass resolution from a flexible identifier. Loads from disk
// (so cold /Game assets resolve without being opened in-session) and falls
// back through path/name variants. Returns nullptr if unresolved, or if
// RequiredBase is set and the resolved class is not a child of it.
UClass* UEMCP::ResolveClass(const FString& Identifier, UClass* RequiredBase = nullptr);
```

Resolution order:
1. Empty → `nullptr`.
2. **Path-shaped** input (contains `/`, e.g. `/Game/...` or `/Script/...`) — **normalize FIRST, then load**:
   a. Normalize: if the path has no `.`, synthesize the Blueprint generated-class path `"<path>.<leaf>_C"`. This must happen *before* the first `LoadClass` — passing a suffix-less package path to `LoadClass` emits a `Class None.<package>` warning + a refused `FlushAsyncLoading`, and on a cold Blueprint can degrade to an empty result (the sibling `ReflectionWalker.cpp` resolver normalizes-first for exactly this reason).
   b. `LoadClass<UObject>(nullptr, Normalized)`.
   c. `FSoftObjectPath(Normalized).TryLoad()` → if `UBlueprint`, return `GeneratedClass`; if `UClass`, return it.
3. **Short name** (no `/`):
   a. `FindFirstObjectSafe<UClass>(*Identifier, EFindFirstObjectOptions::NativeFirst)` (native classes are always loaded — find-in-memory is correct here, not a quirk). The `Safe` variant won't assert during GC / package-save, which matters for handlers that can run at arbitrary editor times. **Verified present in UE 5.3** (`UObjectGlobals.h`), so available across 5.3/5.6/5.7.
   b. If it does not start with `U`, retry with the `U`-prefix.

   **Deliberate behavior change:** today's find-only sites use `FindObject<UClass>(nullptr, *Name)` (an unreliable null-outer search, `ANY_PACKAGE`-era). Switching to `FindFirstObjectSafe<…, NativeFirst>` is the sanctioned modern lookup; in the rare ambiguous-name case it prefers the native class. The live anchor case + clean builds on both engines validate the swap.
4. If `RequiredBase` is set, return the class only if `IsChildOf(RequiredBase)`, else `nullptr`.

This is the single source of truth; it absorbs `ReflectionWalker::ResolveClass`'s `_C` + `TryLoad` logic.

**Precondition:** must run on the game thread (`LoadClass`/`LoadObject`/`TryLoad` require it). All current callers already marshal via `MCPThreadMarshal` before reaching resolution, so the resolver inherits the invariant and does **not** re-marshal — keeping it a pure synchronous helper.

### Component 2 — caller adapters
Each site keeps its domain-specific candidate generation but routes every candidate **through `UEMCP::ResolveClass`**, deleting the direct `FindObject`/`TObjectIterator` calls:
- `ResolveNotifyClass(name)` → try `ResolveClass(name)`, then `ResolveClass("/Script/Engine." + name)`, then `ResolveClass("/Script/Engine." + "AnimNotify_" + name)` to preserve the current short-name reach. Pass `RequiredBase = nullptr` — the current code applies **no** base filter at resolution (the montage handler validates the type afterward); keep that division so behavior is unchanged.
- add-component → candidate list `[type, type+"Component", "U"+type, "U"+type+"Component", "/Script/Engine."+type, "/Script/Engine."+type+"Component"]`, first `ResolveClass(c, UActorComponent::StaticClass())` hit wins.
- reparent/target → `[target, "U"+target, "/Script/Engine."+target]` through `ResolveClass`.
- class-pin default (≈756) → `ResolveClass(className)` (gains `_C`/SoftPath reach over the current `LoadObject`+`/Script/Engine.`-only chain).
- actor-class resolve (≈1045) → keep the `APawn`/`AActor` fast-path, then `ResolveClass(className, AActor::StaticClass())` (gains `/Game` actor-Blueprint support).
- `ReflectionWalker::ResolveClass` → becomes a thin call to `UEMCP::ResolveClass` (keeps its `inspect_blueprint` callers unchanged).

### Component 3 — version tie-in
The short-name native lookup is the historically version-sensitive spot (`ANY_PACKAGE`-era `FindObject` → modern `FindFirstObject`). `FindFirstObjectSafe<UClass>` + `EFindFirstObjectOptions::NativeFirst` were **confirmed present with identical signatures in UE 5.3** (`UObjectGlobals.h`) — so across 5.3/5.6/5.7 no version gate is needed today. If a *future* engine diverges here, the gate goes in `UEMCPCompat.h` (D170) — never a raw version `#if` in the resolver itself.

### Component 4 — regression guard
`server/test-class-resolution-audit.mjs` — a static scan (W-K-anon-namespace-audit-style, FAIL-LOUD via `run-rotation.mjs`) over `plugin/UEMCP/Source/UEMCP/Private/*.cpp`. It flags **all raw `UClass`-resolution primitives** outside the shared resolver — not just the Find-only ones — so the load-but-narrow sites can't silently stay inconsistent:
- `FindObject<UClass>` / `FindFirstObject(Safe)?<UClass>` / `StaticFind*Object(UClass::StaticClass()`
- `LoadClass<` / `LoadObject<UClass>` / `StaticLoadObject(UClass::StaticClass()`

**Excluded:** `HandlerCommon.cpp` (home of `UEMCP::ResolveClass`, the one place these primitives legitimately live) and the `Commandlets/` dir (offline/DumpBP tooling, out of the live-handler scope). A documented `// uemcp-allow-class-resolution: <reason>` line marker permits any future vetted exception (the scan skips the flagged line when the marker is on the preceding line). This keeps the guard from flagging asset (non-`UClass`) loads like `LoadObject<UBlueprint>` / `LoadObject<UAnimSequence>`, which are unaffected.

## Validation
- Build the plugin clean on **UE 5.3** (`Engine/` compat branch) **and UE 5.7** (`StructUtils/` branch) via the throwaway-host / real-project method (D168/D170).
- **Live anchor case:** on the real 5.3 project's editor, reproduce the cold Blueprint-notify-class failure (`add_montage_notify` with a `/Game` BP notify class not yet loaded), confirm it now resolves after the change.
- `node run-rotation.mjs` green, including the new audit test.
- No C++ unit harness exists in-repo; validation is build + live-smoke + the static guard, consistent with the plugin's existing test model.

## Out of scope
- The offline parser (reads disk directly — no "session," no quirk).
- UFunction/struct resolution (separate concern; this is `UClass` resolution only).
- Non-class asset resolution already handled by `ResolveBlueprint` / `LoadAssetPIESafe` (correct already; left as-is).
