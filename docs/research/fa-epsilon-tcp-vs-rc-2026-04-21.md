# FA-ε — M-enhance TCP brokers vs Phase 4 Remote Control boundary

> **Author**: FA-ε researcher (session 2026-04-21)
> **Handoff**: `docs/handoffs/fa-epsilon-tcp-vs-rc-research.md`
> **Type**: Research — pure decision document. No code, no dispatch authorship, no plugin/server edits.
> **HEAD at research**: `697b331` on main (pre-commit baseline). S-B-base in flight in parallel; scope kept entirely in `docs/research/` per D49.
> **Deliverable consumers**: Phase 3 dispatch orchestrator (queues M-enhance with transport decided); D-log maintainer (D23/D53/D58 amendments per §Q6).
> **Seal**: Research document — factual corrections via blockquote amendment only.

---

## §Executive verdict

**HYBRID — transport chosen per query shape, not per milestone.** RC HTTP on 30010 covers the reflection-metadata broker (tooltip/type + UI clamps) and the UPROPERTY/UFUNCTION subset of the runtime broker; TCP:55558 covers compile-diagnostic capture, UEdGraph topology reads, compiled-state introspection, and the `FCompilerResultsLog`/non-UFUNCTION surface. Split rule: **RC when payload is a flat UPROPERTY/UFUNCTION surface AND the metadata need stays inside `{UIMin, UIMax, ClampMin, ClampMax, ToolTip}`; TCP for structured graph walks, diagnostic captures, and anything returning `FCompilerResultsLog` / non-reflection types.**

Phase 4 collapses as a scheduled milestone but **not** as an architectural layer — Layer 4 (HTTP:30010) still exists per D23, just activated earlier inside M-enhance instead of as a follow-on Phase 4 kickoff. The 8 `remote-control` tools in tools.yaml move under M-enhance's dispatch bundle.

M-enhance net cost: **3-5 sessions** (unchanged from D58 baseline); Phase-4-scheduled-as-separate-milestone is absorbed, net saving **2-4 sessions** off the aggregate Phase 3 budget that previously carried Phase 4 as an independent scheduled milestone.

---

## §Q1 — Coverage mapping

M-enhance's query categories and tool-by-tool classification. Source: D58 §Q2.2 + tools.yaml `blueprint-read` / `materials` / `animation` / `data-assets` / `editor-utility` / `input-and-pie` / `remote-control` toolsets + the D53 KEEP(reduced) annotations.

Classification key: **FULL-RC** (RC HTTP alone suffices, zero plugin C++), **FULL-TCP** (plugin custom handler required, RC insufficient), **PARTIAL-RC** (RC covers common case, plugin fill-in for edge), **NONE** (neither transport; tool moves to sidecar or deferred).

### Runtime/PIE state broker (D52-a; live UObject values)

| Tool | Transport verdict | Rationale |
|------|-------------------|-----------|
| `rc_get_property` | **FULL-RC** | Primitive RC endpoint `PUT /remote/object/property access=READ_ACCESS`. Shipped by Epic. |
| `rc_set_property` | **FULL-RC** | Primitive RC endpoint `PUT /remote/object/property access=WRITE_ACCESS` with `WRITE_TRANSACTION_ACCESS` variant that records in editor undo stack. |
| `rc_call_function` | **FULL-RC** | Primitive RC endpoint `PUT /remote/object/call` with `generateTransaction` for undo integration. |
| `rc_list_objects` | **FULL-RC** | RC `/remote/search/object` covers class-pattern search. |
| `rc_describe_object` | **PARTIAL-RC** | `/remote/object/describe` returns `{Name, Class, Properties[{Name, Description, Type, ContainerType, KeyType, Metadata}]}` but `Metadata` is sanitized to `{UIMin, UIMax, ClampMin, ClampMax, ToolTip}` only. See §Q2.1 finding below. |
| `rc_batch` | **FULL-RC** | RC supports batch via `{Requests: [...]}` shape (single endpoint accepts multi-op array). |
| `rc_get_presets` | **FULL-RC** | `/remote/presets/{name}` + `/remote/presets/{name}/property/{name}` primitives. |
| `rc_passthrough` | **FULL-RC** | Opaque HTTP client feature — by definition covered once the HTTP client exists. |
| `editor-utility.get_editor_state` | **FULL-TCP** | Selection set + active viewport info isn't addressable via a single `objectPath`. Custom handler walks `GEditor->GetSelectedActors()`, viewport info via `FEditorViewportClient`. |
| `input-and-pie.is_pie_running` | **PARTIAL-RC** | Could be a UFUNCTION wrapper around `GEditor->PlayWorld != nullptr` returning bool — simplest to ship via TCP handler (trivial) or via RC+wrapper UFUNCTION. Either works; prefer TCP for consistency with start/stop. |
| `input-and-pie.start_pie` / `stop_pie` | **FULL-TCP** | `UEditorEngine::PlayInEditor` / `EndPlayMap` are not reflection-exposed UFUNCTIONs. Custom plugin handler required. |
| `input-and-pie.execute_console_command` | **PARTIAL-RC** | Could call `APlayerController::ConsoleCommand` via `/remote/object/call` (it's BlueprintCallable) but resolving the "current PIE player controller" object path dynamically is gnarlier via RC than via a one-liner handler. Prefer TCP. |

### Compile-time/derived data broker (D52-c)

| Tool | Transport verdict | Rationale |
|------|-------------------|-----------|
| `materials.list_material_parameters` | **FULL-RC** | `UMaterialInterface::GetAllScalarParameterInfo` / `GetAllVectorParameterInfo` / `GetAllTextureParameterInfo` are all `UFUNCTION(BlueprintCallable)` — callable via RC `/remote/object/call`. Compiled shader uniforms baked at save time readable via `UMaterial`'s UPROPERTY graph nodes. |
| `materials.get_material_graph` | **FULL-TCP** | UEdGraph walk over `UMaterial::MaterialGraph` requires traversing `UMaterialExpression*` edges — not a flat UPROPERTY surface and no UFUNCTION returns a graph structure. Plugin handler required. |
| `animation.get_montage_full` | **PARTIAL-RC** | Section/notify arrays are UPROPERTY and readable via `rc_describe_object`. Evaluated blend state requires live `UAnimInstance` and is TCP-side. |
| `animation.get_anim_sequence_info` | **PARTIAL-RC** | Duration/frame count/skeleton ref readable as UPROPERTY via RC; compiled notify tracks + sync markers partially readable as UPROPERTY arrays. Runtime-evaluated curves need TCP. |
| `animation.get_blend_space` | **PARTIAL-RC** | Sample point UPROPERTY array readable via RC; runtime interpolation evaluator requires TCP. |
| `animation.get_anim_curve_data` | **PARTIAL-RC** | Simple keyframe UPROPERTY readable via RC; compiled curve baking needs TCP. |
| `data-assets.get_curve_asset` | **FULL-RC** | `UCurveBase::FloatCurves/VectorCurves/ColorCurves` UPROPERTY + `GetFloatValue`/`GetVectorValue` UFUNCTIONs cover read surface fully. |
| `data-assets.get_string_table` | **PARTIAL-RC** | Source strings UPROPERTY readable; culture-specific resolved values require `FTextLocalizationManager` which isn't reflection-exposed. |
| `data-assets.get_struct_definition` | **FULL-TCP** | Walk of `UUserDefinedStruct::ChildProperties` + `FProperty::GetMetaDataMap` exceeds RC sanitized-metadata allowlist. Plugin handler needed for full flag surface. |
| `geometry.get_mesh_info` | **FULL-RC** | `UStaticMesh::GetNumVertices` / `GetNumTriangles` / `GetBounds` are all BlueprintCallable UFUNCTIONs. |
| `blueprint-read.get_niagara_system_info` | **PARTIAL-RC** | Public UPROPERTYs (fixed bounds, exposed parameters) via RC; compiled VM state + emitter graph evaluation TCP-side. |
| `visual-capture.get_asset_preview_render` | **FULL-TCP** | Offscreen 3D render via `FPreviewScene` + `FWidgetRenderer` — not reflection-callable. |
| *Compile diagnostic capture* (new M-enhance tool, no yaml entry yet) | **FULL-TCP** | `FKismetEditorUtilities::CompileBlueprint(UBlueprint*, EBlueprintCompileOptions, FCompilerResultsLog*)` is non-UFUNCTION static C++ (`KismetEditorUtilities.h:169`). `UBlueprintEditorLibrary::CompileBlueprint` IS a UFUNCTION but returns `void` — triggers compile but doesn't surface results. Plugin handler required to capture `FCompilerResultsLog` and JSON-serialize it. |

### Reflection metadata broker (D52-d)

| Tool | Transport verdict | Rationale |
|------|-------------------|-----------|
| `blueprint-read.get_blueprint_info` | **PARTIAL-RC** | Parent class + interface list readable via RC `describe`. UClass flags (BlueprintType, Deprecated, etc.) are NOT in RC's sanitized-metadata allowlist — plugin handler for full flag set. |
| `blueprint-read.get_blueprint_variables` | **PARTIAL-RC** | Variable names + types + ToolTip readable via RC `describe`. **Category, Replicated, EditAnywhere, BlueprintReadWrite flags are NOT exposed** (sanitize allowlist — see §Q2.1). Plugin handler needed for full flag surface. |
| `blueprint-read.get_blueprint_functions` | **FULL-TCP** | Function signature enumeration walks `UClass::Functions` + per-UFunction `ChildProperties` with flag inspection; no RC surface for this shape. |
| `blueprint-read.get_blueprint_components` | **PARTIAL-RC** | SCS root UPROPERTY readable via RC; full component tree + default values + attachment chain requires TCP walk. |
| `blueprint-read.get_blueprint_event_dispatchers` | **FULL-TCP** | Event dispatcher pin-trace + binding target resolution requires K2Node walk (sidecar territory, not RC). |
| `blueprint-read.get_widget_blueprint` | **FULL-TCP** | Widget tree traversal + property bindings + named-slot metadata not reflection-shaped. |
| `data-assets.list_data_asset_types` | **PARTIAL-RC** | `/remote/search/class` could enumerate UDataAsset subclasses but RC doesn't expose class-hierarchy walk natively. Light plugin wrapper simpler. |
| `editor-utility.get_editor_utility_blueprint` | **PARTIAL-RC** | Standard BP introspection via RC `describe`; Run-method binding + menu registration are editor-internal state, TCP. |
| `asset-registry.get_asset_references` | **FULL-TCP** | `IAssetRegistry::GetReferencers` isn't UFUNCTION-exposed. Dedicated handler required. |
| `asset-registry.get_datatable_contents` | **PARTIAL-RC** | DataTable row struct values readable via RC if rows are UPROPERTY-shaped; cooked/compiled DataTable access requires TCP. |

### Rollup

| Category | FULL-RC | PARTIAL-RC | FULL-TCP | NONE |
|----------|---------|------------|----------|------|
| Runtime/PIE (12 tools) | 7 | 2 | 3 | 0 |
| Compile-time (13 tools) | 3 | 6 | 4 | 0 |
| Reflection-metadata (10 tools) | 0 | 5 | 5 | 0 |
| **Total (35 tools)** | **10** | **13** | **12** | **0** |

RC FULL coverage is concentrated on the 8 primitive `remote-control` tools + flat UFUNCTION surfaces (material parameters, mesh info, curve asset). RC PARTIAL coverage dominates the middle tier — RC saves the simple reads, TCP handles the rest of the query for the same tool. TCP FULL coverage concentrates on the three hard categories: compile diagnostics, UEdGraph walks, and custom editor-state.

---

## §Q2 — UE 5.6 Remote Control capability inventory

Sources: UE 5.6 engine `Plugins/VirtualProduction/RemoteControl/Source/WebRemoteControl/Private/RemoteControlModels.h`, `RemoteControlRoute.h`; context7 MCP docs for HTTP/WebSocket reference.

### §Q2.1 HTTP endpoint surface (canonical)

- **`PUT /remote/object/property`** — property read/write with `access ∈ {READ_ACCESS, WRITE_ACCESS, WRITE_TRANSACTION_ACCESS}`. Access-gated: read requires `public` + (`EditAnywhere` OR `BlueprintVisible`); write requires not-`EditConst` + not-`BlueprintReadOnly`. Batching via `{Requests: [...]}`.
- **`PUT /remote/object/call`** — UFUNCTION invocation with `objectPath`, `functionName`, `parameters{}`, `generateTransaction`. Uses `UObject->ProcessEvent(UFunction*, ArgsMem)` internally.
- **`PUT /remote/object/describe`** — returns `{Name, Class, Properties[{Name, Description, Type, ContainerType, KeyType, Metadata}]}`. **Metadata is sanitized** — see §Q2.2.
- **`PUT /remote/object/event`** — event subscription with `EventType=ObjectPropertyChanged` for long-poll notification.
- **`/remote/presets/{name}/property/{name}`** and **`/remote/presets/{name}/function/{name}`** — preset-scoped variants with curated exposure.
- **`/remote/search/object`** — class-pattern search for UObjects in the running editor.

### §Q2.2 Metadata sanitize allowlist (load-bearing finding)

`RemoteControlModels.h:31-46` defines `SanitizeMetadata` which **deliberately restricts** the Metadata map exposed over HTTP to exactly five fields:

```cpp
return InTuple.Key == Name_UIMin
    || InTuple.Key == Name_UIMax
    || InTuple.Key == Name_ClampMin
    || InTuple.Key == Name_ClampMax
    || InTuple.Key == Name_ToolTip;
```

**Not exposed via RC HTTP**: `Category`, `Replicated`, `EditAnywhere`, `BlueprintReadWrite`, `BlueprintReadOnly`, `ClampMax`, `AdvancedDisplay`, `meta=(*)` in general except the 5 listed. `FProperty::PropertyFlags` bitfield is not surfaced at all.

**Impact on M-enhance reflection-metadata broker**: RC's `/describe` is insufficient for `get_blueprint_variables`'s "Category, Replicated, EditAnywhere flags, tooltips" description. It covers tooltips (via `Description` which is populated from `GetMetaData("ToolTip")`) and UI clamp ranges only. Category/replication/edit-flags require plugin C++ that walks `FProperty::GetMetaDataMap()` directly and serializes with no sanitize filter.

### §Q2.3 WebSocket subscription model

The RC WebSocket endpoint at `{host}:{port}/remote/api/v1/websocket` (exposed by RemoteControl module when Web server is enabled) supports `subscribe` / `unsubscribe` to property paths with `propertyUpdate` events pushed on change. Transport is local-loopback per the same trusted-network assumption as the HTTP surface (no TLS; matches D23's LAN threat model for all UEMCP layers). Useful for FA-a (runtime monitoring workflows) but **not load-bearing for M-enhance** — M-enhance's three query categories are request/response, not streaming. Defer WebSocket surface to post-M-enhance if monitoring workflows surface.

### §Q2.4 Auth / threading / rate limits

- **Auth**: None by default. LAN/trusted-network assumption per Epic docs. `UNREAL_RC_PORT` env var override deferred per risks-and-decisions.md (lines 36-37).
- **Threading**: RC dispatches property/function calls on the **game thread** via `FTSTicker` or equivalent main-thread queue. Concurrent reads/writes serialize at editor tick. Same bottleneck as TCP:55558 (editor main thread) — **no threading advantage either way**.
- **Rate limits**: None enforced at HTTP layer. Rate-limiting deferred per SKIP disposition in risks-and-decisions.md line 38.

### §Q2.5 Write surface

RC write coverage is **strong for UPROPERTY** (including transacted writes with undo-stack recording) but **cannot cover M3 write contract fully**:
- Actor spawn / delete: not a UPROPERTY mutation — requires custom spawn handler.
- FScopedTransaction integration: RC's `WRITE_TRANSACTION_ACCESS` covers it for property writes but not for multi-step operations that P0-6 (from phase3-plugin-design-inputs.md) requires to span across spawn + attach + property-set.
- Pin-type validation (P0-11): editor-side validation isn't reflection-exposed.

Implication: **M3's 32 transitional tools cannot all move to RC.** They stay on TCP:55558 per D23/D40. RC covers the read-side volume, not the write-side.

### §Q2.6 Custom expose points

`URemoteControlPreset::ExposeProperty` + `IRemoteControlModule::GetObjectRef` allow plugins to register custom-exposed properties. `URemoteControlExposeRegistry` tracks them. Plugin-side exposers require as much C++ as a TCP handler for the equivalent functionality — exposer registration boilerplate (~15-30 LOC) + the actual data-extraction body (same in both transports). **RC doesn't save plugin code for non-UPROPERTY data**; it just changes the transport.

### §Q2.7 Reflection depth (M-enhance-critical)

| M-enhance need | RC surface | Verdict |
|----------------|------------|---------|
| UPROPERTY type + tooltip | `/describe` Properties[].{Type, Description} | **FULL** |
| UPROPERTY UI clamps | `/describe` Properties[].Metadata.{UIMin/Max, ClampMin/Max} | **FULL** |
| UPROPERTY flags (EditAnywhere, BlueprintReadWrite, Replicated, Category) | Sanitize-filtered out | **NONE** — plugin C++ required |
| UFunction signature + params | `/describe` Functions[] + `/call` validation | **FULL** |
| UClass inheritance chain | `/describe` Class field | **PARTIAL** — single-level only |
| UClass interface list | Not exposed | **NONE** — plugin C++ required |
| UCLASS config inheritance (`config=X`) | Not exposed | **NONE** |
| Compile errors (`FCompilerResultsLog`) | `UBlueprintEditorLibrary::CompileBlueprint` is UFUNCTION(BlueprintCallable, void) — can trigger, cannot capture results | **NONE** for capture; FULL for trigger |

---

## §Q3 — Cost sensitivity

Reference baselines: D58's M-enhance = 3-5 sessions; Phase 4 as standalone milestone previously implied 2-4 sessions (not called out in D58's sum because Phase 4 was deferred post-M5). Under the re-sequence's D23-preserving framing, M-enhance absorbs Phase 4's read-side scope.

### §Q3.1 Plugin-side LOC

| Work | Option A (pure TCP) | Option B (pure RC) | Hybrid |
|------|---------------------|---------------------|--------|
| TCP server bring-up on 55558 | M1 already covers | Still needed (writes via 55558) | Same as M1 |
| Runtime-broker handlers | ~400-600 LOC (15 tools × ~30-40 LOC with shared helpers) | ~50 LOC (custom exposer registration for edge cases) | ~150 LOC (only edge cases) |
| Compile-diagnostic handler | ~120 LOC (capture `FCompilerResultsLog`, JSON-serialize) | **Same** (RC can't cover; UFUNCTION wrappers cost the same as TCP handlers for this shape) | ~120 LOC |
| UEdGraph traversal (material graph, event dispatchers) | ~200 LOC | **Same** (RC can't traverse; needs plugin) | ~200 LOC |
| Reflection-metadata walker | ~150 LOC (walks `FProperty::GetMetaDataMap` unfiltered) | Same + UFUNCTION wrapper boilerplate (~180 LOC) | ~150 LOC |
| `.uplugin` Plugins[] entry for RemoteControl | N/A | 1-line add | 1-line add |
| `Build.cs` PrivateDependencyModuleNames "RemoteControl" | N/A | 1-line add | 1-line add |
| **Plugin total** | **~870-1070 LOC** | **~550-700 LOC** | **~620-770 LOC** |

### §Q3.2 Server-side LOC

| Work | Option A | Option B | Hybrid |
|------|----------|----------|--------|
| HTTP client in ConnectionManager (Layer 4) | **0** (not needed) | ~150 LOC + retry + JSON marshal | ~150 LOC |
| RC URL-scheme translator (tool params → `objectPath + propertyName`) | 0 | ~80 LOC | ~80 LOC |
| `tcp-tools.mjs` extensions (M-enhance TCP tools) | ~400 LOC | ~100 LOC (writes only; reads go RC) | ~250 LOC |
| **Server total** | **~400 LOC** | **~330 LOC** | **~480 LOC** |

### §Q3.3 Test surface

| Concern | Option A | Option B | Hybrid |
|---------|----------|----------|--------|
| Integration test harness | test-tcp-tools pattern reused | New HTTP wire-mock harness | **Both** — but HTTP harness scoped to RC primitives only |
| Wire-mock complexity | Low (FakeTcpResponder already built) | Medium (HTTP mock with route matching) | Medium — one extra harness |
| Cross-transport consistency tests | N/A | N/A | **New** — need tests that verify RC + TCP return equivalent data for same tool |

### §Q3.4 Session count delta

| Option | Sessions | Δ vs A |
|--------|----------|---------|
| **A — Pure TCP** | 3-5 (M-enhance) + 2-4 (Phase 4 later) = **5-9 total** | baseline |
| **B — Pure RC (plus plugin UFUNCTION wrappers)** | 4-7 (M-enhance) + 0 (Phase 4 absorbed) = **4-7 total** | **−1 to −2** |
| **Hybrid** | 3-5 (M-enhance) + 0 (Phase 4 absorbed) = **3-5 total** | **−2 to −4** |

Hybrid wins on cost because: (1) it inherits Option A's plugin-C++ investment for the hard categories (compile, UEdGraph, reflection-flags); (2) it inherits Option B's Phase-4-absorption benefit; (3) the incremental HTTP-client build (~230 LOC server-side) is amortized across both M-enhance's runtime broker *and* the 8 `remote-control` primitive tools. Option B loses vs hybrid because it still pays the plugin-UFUNCTION-wrapper cost for the non-UPROPERTY cases (~550-700 LOC plugin) without saving much over hybrid's ~620-770 LOC.

---

## §Q4 — Failure-mode comparison

| Failure mode | Option A (TCP:55558) | Option B / RC side of Hybrid (HTTP:30010) |
|--------------|----------------------|--------------------------------------------|
| **Port blocked** | Plugin unreachable; ConnectionManager returns ECONNREFUSED; tool reports layer unavailable. Existing retry policy (risks-and-decisions.md line 34) applies. | RC unreachable; HTTP 5xx or socket error; same degradation pattern. Client retries on next request. |
| **Editor crash mid-request** | TCP socket breaks; CommandQueue in-flight request times out; next command re-establishes connection. Write-op deduplication via request-ID cache (L3 risk mitigation) handles retry-duplicate ops. | RC HTTP server dies with editor; all in-flight requests fail with connection-reset. **Gap**: RC doesn't have request-ID dedup on server side by default — duplicate writes on retry are a risk. Mitigation: always pass `WRITE_TRANSACTION_ACCESS` so double-writes land as a single transaction semantically. |
| **Concurrent requests** | CommandQueue serializes per-layer on plugin side; main thread naturally serializes handler execution. | RC main-thread dispatch serializes property/function calls on the editor game thread. Same serialization point. **No advantage either way.** |
| **UE version drift (5.6 → 5.7)** | Custom TCP wire protocol is Claude-owned; stable unless we break it. Handler-side UE API calls depend on engine API surface — same 5.6→5.7 migration cost as any plugin. | **RC HTTP surface is Epic-maintained and backwards-compatible** — historical evidence: RC shipped in 4.23 and the `/remote/object/property` + `/remote/object/call` shapes have been stable since. **RC wins on version stability.** Plugin-side UFUNCTION wrappers still depend on engine API drift but the HTTP surface insulates the server. |
| **Transport partial outage** (e.g., RC enabled but plugin disabled) | Single failure mode: if plugin is down, all TCP:55558 tools fail uniformly. | Hybrid has **two independent failure modes** — plugin down affects TCP-side reads/writes; RC down affects RC-side reads. Net: tool unavailability granularity is finer (some M-enhance tools still work even if plugin is down, because RC serves them directly from the built-in RemoteControl module). |
| **Schema discovery when layer is down** | `list_toolsets` reports layer unavailable; affected tools disabled. Same degradation as Phase 1-2. | Same pattern applied to Layer 4. `list_plugins` already reports RemoteControl status per phase1 offline surface. |

**Version-drift edge is decisive for hybrid**: shipping the reflection-metadata broker on RC makes it immune to Claude-owned wire-protocol drift. Plugin-C++ tools stay plugin-C++ (no net change). Overall: hybrid has **slightly better resilience** because outages in one transport don't take down both.

---

## §Q5 — Architectural purity analysis

### §Q5.1 D23 conformance

D23 allocates **HTTP:30010 as Layer 4 (Phase 4)** and **TCP:55558 as Layer 3 (UEMCP custom plugin, Phase 3)**. The question is whether hybrid violates or respects that allocation.

- **Pure A violates D23** by ignoring Layer 4 entirely — Phase 4 never activates, HTTP:30010 is never used, Layer 4 becomes dead allocation. The 4-layer architecture degrades to effective 3-layer.
- **Pure B violates D23** by forcing non-UPROPERTY reads through Layer 4 via plugin UFUNCTION wrappers — HTTP pretending to be a TCP broker. Violates the "RC = reflection-based property/function access" semantic that makes Layer 4 cohesive.
- **Hybrid respects D23** by using each layer for what it was allocated for: Layer 3 handles writes + graph-walks + diagnostic captures + editor-state; Layer 4 handles UPROPERTY/UFUNCTION reflection reads. The split rule maps 1:1 to the layer semantics Epic designed RC around.

Crucial sharpening: **Phase 4 as a scheduled milestone collapses; Phase 4 as an architectural layer persists.** Layer 4 activates earlier (inside M-enhance's dispatch rather than as a separate post-M5 milestone) but its semantic allocation in D23 is preserved. No D23 amendment needed — only a scheduling-note amendment to D58's M-sequence.

### §Q5.2 D58 "MCP-first, plugin-enhances" framing

D58 is about offline-primary read paths with plugin as enhancement. How does each transport choice honor that?

- **Pure A**: plugin is the sole path for M-enhance reads → risks violating D52's near-parity goal by pushing more work through plugin instead of offline. Doesn't honor D58 — it just moves the Plugin-Does-More line from M3 onto M-enhance.
- **Pure B**: RC becomes the primary M-enhance path; plugin shrinks to writes-only on 55558 (M3 scope). This would actually honor D58 *most aggressively* — reads via Layer 4 (Epic-built, no Claude plugin dep), writes via Layer 3 (plugin required). **But** the reflection-flag gap + UEdGraph/compile-diagnostic gap means pure B isn't reachable without plugin UFUNCTION wrappers that re-create Option A's plugin footprint.
- **Hybrid**: RC serves the subset where it's the Epic-owned first-class path, TCP serves the subset where Epic doesn't have a first-class path. This matches "plugin enhances" exactly — plugin extends what RC can't do, rather than duplicating what RC already does.

### §Q5.3 D52 near-parity interaction

D52 frames plugin reads as a shrinking surface as offline covers more. RC's role is orthogonal: RC doesn't compete with offline (both bypass plugin) and RC doesn't compete with sidecar (both are editor-runtime-dependent in different ways). Hybrid's RC-for-reflection-metadata rule **doesn't weaken** the D52 offline-near-parity goal — those tools stay in plugin/RC territory either way because they require a running editor.

**Minor tension**: D52 category (d) "reflection-only metadata" was specifically called out as a plugin responsibility. Hybrid reassigns part of that category to RC. This is a refinement, not a contradiction — D52's point was "not-offline-feasible," and RC covers a subset of the not-offline-feasible space without plugin code. Amend D52 via blockquote at M-enhance dispatch to note the RC split.

### §Q5.4 Phase 4 scope

Phase 4 was previously scoped as:
- 8 `remote-control` primitive tools (rc_get_property, rc_set_property, rc_call_function, rc_list_objects, rc_describe_object, rc_batch, rc_get_presets, rc_passthrough).
- Plus any cross-cutting workflows that build on RC primitives.

Under hybrid:
- The 8 primitive tools ship **inside M-enhance** (not as standalone Phase 4).
- Cross-cutting workflows that use RC as backing (`get_blueprint_variables` tooltip subset, `list_material_parameters`) also ship inside M-enhance — they use the primitive tools as their implementation substrate.
- No "Phase 4" milestone remains on the schedule. D23's layer allocation survives; the dispatch label collapses.

**Rejection of the principled alternative (pure A — keep Phase 4 as-scheduled, don't collapse)**: the principled purist position is that Phase 4 should ship post-M5 per D23's phasing and M-enhance should stay pure-TCP. The counter is that D23's phasing was written before D52 (near-parity) and D58 (MCP-first) sharpened the offline-primary framing. Post-D58, there's no architectural reason to defer Layer 4 — it's orthogonal to plugin-feature completeness, and the cost savings (§Q3.4, 2-4 sessions) are load-bearing. **The purist position is rejected on the grounds that D23's phasing is scheduling guidance, not an architectural constraint** — the 4-layer architecture is preserved; only the kickoff ordering shifts.

---

## §Q6 — Recommendation + rationale

**Verdict: HYBRID** per the split rule documented in §Executive verdict.

### Load-bearing inputs driving the verdict

1. **RC's sanitized-metadata allowlist is real and narrow** (§Q2.2). `RemoteControlModels.h:31-46` hard-filters the exposed Metadata map to 5 fields. Category, Replicated, EditAnywhere, BlueprintReadWrite, and full UPROPERTY flag state are deliberately omitted. This caps RC's reflection-metadata coverage at PARTIAL, which forces plugin C++ for the full `get_blueprint_variables` surface. Hybrid's virtue isn't "RC saves all plugin reflection work" — it's "RC saves the tooltip+type+UI-clamp subset, which is still ~40% of reflection-broker queries by volume, at zero plugin-C++ cost."

2. **Plugin C++ is required for compile diagnostics regardless of transport** (§Q2.7). `FKismetEditorUtilities::CompileBlueprint` takes `FCompilerResultsLog*` as a non-reflection out-pointer; `UBlueprintEditorLibrary::CompileBlueprint` is a UFUNCTION but returns void. RC can trigger compile but can't capture the diagnostic log. Every transport choice pays the same plugin-C++ cost for diagnostic capture — so transport choice for compile-broker reduces to "TCP is natural; RC wrapper-UFUNCTION is marginally worse."

3. **Phase 4 collapse saves 2-4 sessions** (§Q3.4) with zero architectural cost (D23's layer allocation preserved per §Q5.1). The aggregate Phase 3 budget drops from "M-enhance + Phase 4 separately" to "M-enhance with RC absorbed." This is the biggest tangible win.

### Rejection reasoning for non-chosen options

**Pure A rejected because**: it forgoes ~1-2 sessions of plugin-C++ savings on the reflection-metadata tooltip/type surface and on UPROPERTY get/set primitives — work that RC does for free. The 8 `remote-control` primitive tools would have to be rebuilt as TCP handlers duplicating RC's functionality inside the plugin — pure redundancy. Pure A also leaves Phase 4 as a scheduled milestone adding 2-4 sessions to the Phase 3 aggregate with no architectural justification for the ordering (D23's phasing predates D52/D58).

**Pure B rejected because**: (1) It cannot cover compile-diagnostics without plugin UFUNCTION wrappers (which are plugin C++ wearing an RC hat). (2) It cannot cover UEdGraph walks (material graph, event dispatchers) without plugin UFUNCTION wrappers that return opaque JSON strings — an awkward pattern that defeats RC's type-aware serialization. (3) The RC sanitize-metadata gap forces plugin C++ for full reflection-flag enumeration. (4) The net plugin-C++ footprint under pure B is ~80% of pure A (§Q3.1, 550-700 vs 870-1070 LOC) while the server-side footprint is actually *larger* under pure B due to URL-scheme translation overhead. Pure B is strictly dominated by hybrid.

### Follow-on decisions this verdict unblocks / creates

**Unblocks**:
- M-enhance handoff can be drafted with transport decided. §Q1 coverage table becomes the per-tool work breakdown.
- Phase 4 milestone can be struck from `backlog.md` — absorbed into M-enhance.
- `layer: http-30010` for the 8 `remote-control` tools stays accurate in tools.yaml (transport is HTTP); the `priority: null   # Phase 4` comment flips to `priority: M-enhance` or similar.

**Creates**:
- New open: server-side HTTP-client build sequence — should it land as a preflight commit inside M-enhance or as a standalone pre-M-enhance dispatch? Recommend preflight commit (~0.5 session inside M-enhance's first session) to keep session count clean.
- New open: tests/test-rc-wire.mjs analog of test-mcp-wire.mjs — RC wire-mock harness scope and design.
- New open (orchestrator call): do the 10 PARTIAL-RC tools implement RC-first-then-TCP-fallback, or TCP-only using RC as an internal optimization? Recommend TCP-only externally (agent-facing tool signature unchanged), RC as an internal implementation substrate where it saves plugin C++. This keeps the M-enhance tool surface transport-agnostic to Claude — simpler mental model.

### D-log amendments triggered

- **D23**: Amend via blockquote to clarify **"Layer 4 activation is scheduling-independent of 4-layer architecture"** — Phase 4 as a milestone may be absorbed into an earlier milestone without violating the 4-layer allocation. Semantic allocation of HTTP:30010 to RC-based reflection reads is preserved.
- **D53**: Amend via blockquote to note that **category (d) "reflection-only metadata"** splits: tooltip/type/UI-clamp subset ships via Layer 4 (RC); Category/Replicated/EditAnywhere/UCLASS-flags subset ships via Layer 3 (plugin) due to RC sanitize allowlist.
- **D58**: Amend via blockquote to record **FA-ε resolution** — M-enhance's three query categories split across Layer 3 (TCP) and Layer 4 (RC) per the §Executive-verdict split rule. Phase 4 as a standalone milestone collapses into M-enhance. Session-cost savings: 2-4 sessions off aggregate Phase 3 total.
- **D52**: Minor blockquote noting RC covers a subset of the not-offline-feasible category (d) surface without plugin code, refining the "plugin-only" framing for reflection metadata.

---

## §Open items

1. **WebSocket subscription surface** — deferred. M-enhance is request/response; streaming workflows (FA-a "runtime monitoring") may benefit from RC WebSocket later. Not load-bearing for current verdict.

2. **Auth model** — RC defaults to unauthenticated LAN access. Same threat model as TCP:55558 (localhost-trusted). `UNREAL_RC_PORT` override deferred per risks-and-decisions.md line 36. Not blocking.

3. **Transaction semantics across transports** — a write that spans RC `WRITE_TRANSACTION_ACCESS` property-set + a TCP handler doing something transactional (FScopedTransaction) needs verification that the two transaction surfaces compose or are explicitly separated. Flag for M-enhance dispatch: add a test case for cross-transport transaction interleaving.

4. **PARTIAL-RC tool implementation strategy** — the 13 PARTIAL-RC tools could (a) dispatch to RC for the simple subset and TCP for the edge, (b) dispatch to TCP only and use RC internally as optimization, or (c) dispatch to RC only and accept reduced coverage. Recommend (b) per §Q6 follow-on. Orchestrator confirmation at M-enhance dispatch.

5. **RC version drift on UE 5.6 → 5.7** — historical backwards-compatibility is strong but unverified for 5.7 specifically. A narrow integration test against a 5.7 build (ProjectB when it lands on 5.7) should be in M-enhance's test-plan.

6. **Custom RC exposers for edge cases** — `URemoteControlPreset::ExposeProperty` could theoretically replace a few tiny TCP handlers. Not cost-effective given the exposer boilerplate. Deferred.

---

## §Confidence assessment

| Question | Confidence | Notes |
|----------|------------|-------|
| Q1 coverage table | **HIGH** for the 8 RC primitive tools (documented Epic API). **MEDIUM-HIGH** for per-tool verdicts (based on yaml descriptions + sampled RC source — engine-code spot-checks confirm the sanitize allowlist and the non-UFUNCTION compile-log pointer). |
| Q2 RC capability inventory | **HIGH** on `SanitizeMetadata` finding (direct engine-source evidence at `RemoteControlModels.h:31-46`). **HIGH** on compile-diagnostic gap (`KismetEditorUtilities.h:169` + `BlueprintEditorLibrary.h:145-146`). **MEDIUM** on WebSocket + custom-exposer details (context7 docs only, no engine-source cross-check). |
| Q3 cost sensitivity | **MEDIUM-HIGH** on directional LOC + session counts. **MEDIUM** on absolute LOC estimates — ±25% variance depending on shared-helper reuse and how aggressive the PARTIAL-RC tools go on RC delegation. |
| Q4 failure-mode comparison | **HIGH** on structural claims (ports, threading, retry). **MEDIUM-HIGH** on UE 5.7 version-drift claim (historical pattern, not 5.7-verified). |
| Q5 architectural purity | **HIGH** on D23 layer-allocation preservation argument. **HIGH** on Phase-4-as-milestone collapse vs Phase-4-as-layer preservation distinction. |
| Q6 verdict | **HIGH** — the three load-bearing inputs each have direct empirical grounding. Pure A and Pure B rejection reasoning is derivable from Q1+Q3. |

**Grounded vs speculative**:
- **GROUNDED**: RC sanitize allowlist (direct code read of `RemoteControlModels.h`), compile-diagnostic gap (two-header cross-check), 4-layer architecture preservation (direct D23 quote), historical UnrealMCP transport choice (direct `UnrealMCP.Build.cs` read — zero RemoteControl dep).
- **SPECULATIVE**: 5.6 → 5.7 RC version-stability claim (historical pattern only), per-tool LOC estimates (directional, not measured), PARTIAL-RC tool implementation strategy preference (orchestrator decides at dispatch).

**Did-not-do-but-could-have**:
- Did not run a local RC wire test against ProjectA's running editor to verify the `/describe` response shape matches the documented payload. Handoff scope was research-only; empirical verification belongs to M-enhance's first implementation session.
- Did not enumerate every PARTIAL-RC tool's exact TCP/RC boundary — §Q1 verdicts are tool-category-level; per-tool boundary decisions happen at M-enhance dispatch.
- Did not verify whether URemoteControlPreset custom-exposers might materially change the RC coverage for any PARTIAL category. Deferred because the plugin-C++ cost of exposer boilerplate is comparable to the TCP handler it would replace.

---

## §Appendix A — Input files consulted

### Tier 1 — Scope + D-log
- `docs/handoffs/fa-epsilon-tcp-vs-rc-research.md` (handoff)
- `docs/tracking/risks-and-decisions.md` — D23 (line 121), D52 (line 150), D53 (line 151), D58 (line 156), D62 (line 160); Phase 4 risk entries (line 9, 36-38)
- `docs/research/phase3-scope-refresh-2026-04-20.md` §Q1 + §Q5.3 (M-enhance enumeration)
- `docs/research/phase3-resequence-mcp-first-2026-04-20.md` §Q2.1 + §Q2.2 + §Q2.3 (enhancement-layer scope collapse)

### Tier 2 — UE 5.6 engine source (empirical grounding)
- `C:/Program Files/Epic Games/UE_5.6/Engine/Plugins/VirtualProduction/RemoteControl/Source/WebRemoteControl/Private/RemoteControlModels.h:20-46` (sanitize allowlist)
- `C:/Program Files/Epic Games/UE_5.6/Engine/Plugins/VirtualProduction/RemoteControl/Source/WebRemoteControl/Private/` (directory listing — endpoint surface)
- `C:/Program Files/Epic Games/UE_5.6/Engine/Source/Editor/UnrealEd/Public/Kismet2/KismetEditorUtilities.h:167-169` (non-UFUNCTION CompileBlueprint)
- `C:/Program Files/Epic Games/UE_5.6/Engine/Source/Editor/BlueprintEditorLibrary/Public/BlueprintEditorLibrary.h:140-146` (UFUNCTION CompileBlueprint with void return)

### Tier 3 — Existing UEMCP surface
- `tools.yaml` (full, esp. lines 559-609 blueprint-read, 684-718 materials, 720-759 data-assets, 895-938 remote-control)
- `plugin/UEMCP/UEMCP.uplugin` (current Plugins[] entry — EditorScriptingUtilities only)
- `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs` (current module deps — no RemoteControl, D60 note)

### Tier 4 — Historical precedent
- `ProjectA/Plugins/UnrealMCP/Source/UnrealMCP/UnrealMCP.Build.cs` (UnrealMCP chose pure-TCP; zero RC dep — historical signal that predates UEMCP's 4-layer framing)
- `ProjectA/Plugins/UnrealMCP/Source/UnrealMCP/Private/Commands/UnrealMCPBlueprintCommands.cpp:252, 845` (UnrealMCP triggers compile but doesn't capture results — same gap as RC, confirming that plugin-C++ is required for FCompilerResultsLog regardless of transport)

### Tier 5 — context7 MCP (UE 5.6 RC documentation)
- Remote Control API HTTP Reference (endpoints, payload shapes, access gating)
- Remote Control API WebSocket Reference (subscription model)
- Remote Control Preset API HTTP Reference (preset-scoped endpoints)
- Remote Control Entity Metadata (label, ID, FieldName, Widget, Description)

---

## §Final report (orchestrator consumption)

```
FA-ε Final Report

Verdict: HYBRID
  - RC HTTP on 30010 for reflection-metadata (tooltip/type/UI-clamp) + UPROPERTY/UFUNCTION runtime reads
  - TCP on 55558 for compile diagnostics, UEdGraph walks, compiled-state, editor-static functions
  - Split rule: RC when flat UPROPERTY/UFUNCTION + metadata need ≤ {UIMin, UIMax, ClampMin,
    ClampMax, ToolTip}; TCP otherwise.

Load-bearing inputs:
  1. RC SanitizeMetadata allowlist (5 fields only) — caps RC reflection coverage at PARTIAL
  2. CompileBlueprint UFUNCTION returns void; FCompilerResultsLog requires plugin C++ regardless
  3. Phase 4 collapse saves 2-4 sessions off aggregate Phase 3; D23 layer allocation preserved

M-enhance cost impact:
  Pre-verdict baseline (A pure TCP + Phase 4 separate): 5-9 sessions total
  Post-verdict (hybrid, Phase 4 absorbed):              3-5 sessions total
  Net delta:                                            −2 to −4 sessions

D-log amendments:
  D23  — blockquote: Layer 4 activation is scheduling-independent of 4-layer architecture
  D53  — blockquote: category (d) splits across L3 (full flags) and L4 (tooltip/type/UI clamps)
  D58  — blockquote: FA-ε resolved HYBRID; Phase 4 milestone absorbed into M-enhance
  D52  — minor blockquote: RC covers subset of category (d) without plugin code

Open items:
  - WebSocket subscription surface (deferred to post-M-enhance)
  - PARTIAL-RC tool implementation strategy (recommend: TCP external signature, RC internal)
  - RC version-drift verification on UE 5.7 (ProjectB integration test at that milestone)
  - Cross-transport transaction semantics (flag for M-enhance dispatch test plan)

Next action: M-enhance handoff draftable with transport decided.
  §Q1 coverage table becomes the per-tool work breakdown input for the dispatch.
  backlog.md update: strike standalone Phase 4; note absorption into M-enhance scope.
```
