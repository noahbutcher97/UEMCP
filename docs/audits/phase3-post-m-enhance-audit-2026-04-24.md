# Phase 3 Post-M-enhance Audit

**Audit date**: 2026-04-24
**Scope**: Phase 3 wave 1-3 shipped code (M1 + M-spatial + Oracle-A/v2 + S-B-base + Verb-surface + M-enhance)
**Test baseline at audit**: 1203 passing / 0 failing across 10 test files
**Auditor**: fresh-eyes Claude Code worker (post-M-enhance, pre-Wave-4)
**D-log anchors consulted**: D23, D44, D58, D66, D70, D72, D74, D75, D76, D77

---

## Executive summary

Shipped code is broadly well-structured, comment density is high, and the separation of concerns between S-B-base parser, Verb-surface consumers, M-enhance RC/TCP transports, and plugin C++ handlers is coherent. Five systemic patterns warrant attention before Wave 4 expands the surface by another ~25 sessions:

1. **Game-thread safety** — every plugin-C++ handler runs on the FRunnable background thread with no `AsyncTask(ENamedThreads::GameThread)` marshaling. Compile, PIE, viewport, and reflection-walk APIs are game-thread-only. This is a systemic risk inherited from UnrealMCP's pattern (see D23) and was known but not fixed in M-enhance. Pre-Wave-4 worth fixing before adding more editor-mutating handlers.
2. **NodeGuid hex-format interop hazard** (D72) — bridged at some boundaries but not at Verb-surface input. An agent piping `bp_list_entry_points` output → `bp_trace_exec` input will silently fail with `node_not_found`. Test harness seeds guids directly from Oracle so this gap is invisible.
3. **Semantic delegate tools in `rc-tools.mjs`** (`get_curve_asset`, `get_mesh_info`, `list_material_parameters`) ship hardcoded to the most common sub-case despite descriptions promising wider coverage — agents will hit confusing partial responses.
4. **D44 drift on RC schemas** — 5 RC tool schemas accept Zod-validated optional params not declared in tools.yaml. `tools/list` shows less than `tools/call` accepts.
5. **Non-atomic sidecar write** — partial sidecars on editor crash mid-write, no temp-file-then-rename pattern.

None of the findings require immediate action to keep the 1203-assertion baseline green — tests don't exercise these paths. All are surfacable during smoke-testing or downstream composition.

---

## Findings

### F-1 [high] Plugin command handlers dispatch on background thread

**Location**: `plugin/UEMCP/Source/UEMCP/Private/MCPServerRunnable.cpp:180` → `MCPCommandRegistry.cpp:52`
**Root cause**: `FMCPServerRunnable::Run()` is an `FRunnable` executing on a dedicated socket thread. `ServeOneConnection` calls `FMCPCommandRegistry::Get().Dispatch(...)` inline, which invokes every handler directly on that thread — no `AsyncTask(ENamedThreads::GameThread, ...)` or `FFunctionGraphTask` marshaling. Handlers then call game-thread-only APIs: `FKismetEditorUtilities::CompileBlueprint` (CompileDiagnosticHandler), `GEditor->RequestPlaySession`/`RequestEndPlayMap` (EdgeCaseHandlers PIE), `GEditor->GetEditorWorldContext()`, `GCurrentLevelEditingViewportClient` (EdgeCaseHandlers get_editor_state), `ThumbnailTools::RenderThumbnail` (VisualCaptureHandler), and `LoadObject<>` in every handler.
**Blast radius**: Race conditions between handler code and the editor's game-thread mutations can cause torn reads, crashes in PIE start/stop, or silently wrong compile results. Inherited from UnrealMCP pattern per D23 but M-enhance expanded surface 3× without fixing. UE will often forgive reads; compile + PIE + viewport are the exposure points.
**Recommended fix**: Wrap the `Dispatch` call in `MCPServerRunnable` with `FFunctionGraphTask::CreateAndDispatchWhenReady(..., ENamedThreads::GameThread)` + future synchronization. Or gate per-handler — e.g., mark reflection walks OK on background but PIE/compile must marshal. Orchestrator call.

### F-2 [high] NodeGuid format mismatch at Verb-surface input boundary

**Location**: `server/offline-tools.mjs:2618-2621` (`bpTraceExec` start_node_id), `2706-2711` (`bpTraceData`), `2788-2793` (`bpNeighbors`). Emission site: `2010` (`extractSpatial` sets `out.node_guid = props.NodeGuid` verbatim — LE-lowercase).
**Root cause**: D72 documents that M-spatial emits NodeGuid in LE-lowercase while S-B-base/Oracle-A-v2 use BE-uppercase-per-uint32. `toOracleHexGuid` (line 2567) bridges correctly at `bp_list_entry_points`/`bp_show_node` internal guards, but the exposed `node_guid` field in M-spatial verb outputs (`bp_list_entry_points.entry_points[].node_guid`, `bp_find_in_graph.nodes[].node_guid`, `bp_list_graphs.comment_ids[]`) is the raw M-spatial form. `bp_trace_exec`/`bp_trace_data`/`bp_neighbors` look up `nodes[startGuid]` using topology's BE-uppercase key space — a LE-lowercase guid never matches.
**Blast radius**: Silent composition failure. Agent pipes `bp_list_entry_points.entry_points[0].node_guid` → `bp_trace_exec.start_node_id` → returns `{available: false, reason: "node_not_found"}`. Test harness (`test-verb-surface.mjs:82-115`) seeds from the Oracle dict directly (already BE-uppercase) so this path isn't exercised.
**Recommended fix**: Option A — run `toOracleHexGuid` on the `start_node_id`/`node_id` input in the 3 Verb-surface handlers before lookup; accept either format. Option B — emit `node_guid_oracle` alongside `node_guid` in M-spatial output so callers can pick. A is less breaking.

### F-3 [high] Non-atomic sidecar write leaves partial JSON on editor crash

**Location**: `plugin/UEMCP/Source/UEMCP/Private/SidecarWriter.cpp:131`
**Root cause**: `FFileHelper::SaveStringToFile(Body, *OutputPath)` writes directly to the final path. If the editor crashes mid-write, the sidecar file is truncated to however many bytes made it to disk before the crash. Readers (save-hook consumers, `regenerate_sidecar`, `DumpBPSidecarCommandlet`) have no way to distinguish partial from complete.
**Blast radius**: Sidecar readers may decode truncated JSON as parse error, or (worse) a valid-but-truncated object missing the `reflection` field. Rare — requires mid-write crash — but the narrow-sidecar is meant to be a reliable offline cache.
**Recommended fix**: Write to `OutputPath + ".tmp"`, then rename/replace via `IPlatformFile::MoveFile(*OutputPath, *TempPath)` atomic swap. UE's `IFileManager::Move` is atomic on Windows when target is on the same volume.

### F-4 [high] `get_curve_asset` only handles UCurveFloat despite documentation

**Location**: `server/rc-tools.mjs:213-222`
**Root cause**: The handler hardcodes `propertyName: 'FloatCurves'` for all inputs. UCurveFloat exposes this property; UCurveVector exposes `FloatCurves` as an array of 3 different components but the RC read just returns the whole array; UCurveLinearColor exposes `FloatCurves` as 4 components. The tool description (`rc-tools.mjs:122`) and yaml description (`tools.yaml:806`) both promise "UCurveFloat/Vector/Color".
**Blast radius**: Agent reads a UCurveVector via `get_curve_asset` expecting vector keyframes; gets a semi-opaque 3-entry struct array that needs client-side interpretation. Silent narrowing vs. outright failure.
**Recommended fix**: Branch on asset class at request time — resolve the asset metadata (via AssetRegistry tag) and pick `FloatCurves` vs the correct property per curve type. Or thin out the description to match actual behavior.

### F-5 [high] `get_mesh_info` only returns vertex count despite documentation

**Location**: `server/rc-tools.mjs:224-236`
**Root cause**: Hardcoded `functionName: 'GetNumVertices'`. Tool description promises "vertex count, triangle count, bounds, and material slots". Only the first is returned.
**Blast radius**: Same as F-4 — silent response narrowing. Agent composition relying on `get_mesh_info().triangle_count` will see undefined.
**Recommended fix**: Use `rc_batch` internally to call `GetNumVertices` + `GetNumTriangles` + `GetBounds` + material-slot getter in one round-trip, and aggregate response. Or align description with reality.

### F-6 [high] `list_material_parameters` only returns scalar params

**Location**: `server/rc-tools.mjs:201-211`
**Root cause**: Hardcoded `functionName: 'GetAllScalarParameterInfo'`. Description (`rc-tools.mjs:113`, `tools.yaml:772`) promises "scalar/vector/texture parameters". Additionally, `toCdoPath(args.asset_path)` (line 204) is wrong for materials — see F-7.
**Blast radius**: Agent querying a material with only vector params gets empty list; concludes the material is un-parameterized. Incorrect tooling for material debug workflows.
**Recommended fix**: Batch-call all three `GetAll*ParameterInfo` variants and merge. Fix F-7 simultaneously.

### F-7 [high] `toCdoPath` incorrectly appends `:Default__` to non-class UObject paths

**Location**: `server/rc-url-translator.mjs:172-181`, called from `rc-tools.mjs:204` (`list_material_parameters`).
**Root cause**: `toCdoPath` blindly appends `:Default__<className>` unless `:Default__` is already present. For a UMaterial asset `/Game/Materials/M_Brick.M_Brick` (which is a UObject, not a UClass-generating UBlueprint), this emits `/Game/Materials/M_Brick.M_Brick:Default__M_Brick` — RC will fail to resolve because materials don't have CDOs.
**Blast radius**: `list_material_parameters` fails on every material asset that isn't a Blueprint-generated class. In ProjectA this is essentially every material.
**Recommended fix**: Only apply `:Default__` when the path targets a `*_C` class path. Add a heuristic: `if (!classPath.endsWith('_C') && !classPath.includes('_C:')) return classPath;` before the current logic. Better: split the helper into `toCdoPathForBPClass` used only when caller knows target is a BP-generated class.

### F-8 [medium] `resolveLinkedToEdges` silently merges nodes under `__unknown_graph__` synthetic key

**Location**: `server/uasset-parser.mjs:1542-1549`, `1579`
**Root cause**: When a graph-node export's `outerIndex` doesn't resolve to a valid export (negative index or out of range), `graphNameFor` returns the synthetic key `__unknown_graph__`. Pass 2 then writes `graphs['__unknown_graph__'].nodes[node.nodeGuid] = ...` — violating D70's (graph_name, node_guid, pin_id) triple-keying invariant at this specific fallback since any two nodes with the same guid from different bad outers will collide.
**Blast radius**: Unusual uassets (partially-corrupted or actively-editing during read) can silently drop nodes. Low probability — bad-outer case is rare — but the contract of "preserve all graph-node exports" is violated under that branch.
**Recommended fix**: Include the export index in the synthetic key: `'__unknown_graph__' + '|' + node.exportIdx`. Or log when fallback fires and surface a stat count in `stats`.

### F-9 [medium] RC tool schemas in yaml miss 5+ Zod-accepted optional params (D44 drift)

**Location**: `tools.yaml:976-1014` vs `server/rc-tools.mjs:27-137`
**Root cause**: tools.yaml declares only required params for RC primitives. Zod schemas accept optional params not surfaced: `rc_get_property` has `access`; `rc_set_property` has `generate_transaction`, `access`; `rc_call_function` has `generate_transaction`; `rc_list_objects` has `outer`, `recursive`; `rc_get_presets` has `preset`. D44 single-source-of-truth states yaml is authoritative, but `tools/list` will report less than `tools/call` honors.
**Blast radius**: Agents discovering tools via `tools/list` won't learn about `generate_transaction` (the Undo-stack toggle) or `recursive` (discovery semantics). Hidden functionality.
**Recommended fix**: Add the optional params to `tools.yaml` under each tool with `required: false`. One-shot worker or rolled into EN-5 mechanized lint.

### F-10 [medium] `bp_show_node` cross-graph fallback lookup may match wrong node

**Location**: `server/offline-tools.mjs:2415-2420`
**Root cause**: When the M-spatial-derived `graph` is null (orphan graph case), the fallback iterates every topology graph and returns the first `gEntry.nodes[oracleGuid]` match. Per D70, NodeGuids are non-unique across sibling graphs — the fallback can hit a coincidental collision in the wrong graph and return its pins as this node's pins.
**Blast radius**: Agent querying a particular node's pins via `bp_show_node` receives pins from a different node with the same guid in another graph. Confusing debug output. Low probability; only triggers when M-spatial fails to identify the owning graph.
**Recommended fix**: Drop the fallback; when primary `graph` resolution fails, return `pin_block: not_available` rather than guessing. Or iterate with `Object.entries` and return the LIST of matches (let caller disambiguate).

### F-11 [medium] `transformBlueprintComponents` case-insensitive substring match false-positives

**Location**: `server/menhance-tcp-tools.mjs:322-339`
**Root cause**: `cls.toLowerCase().includes('component')` matches any property whose class path contains "component" — catches `FComponentReference`, `FVectorComponent`, struct types with the word. Fallback `name.endsWith('_GEN_VARIABLE')` catches all SCS-generated variables, not just components (timelines, delegates, structs).
**Blast radius**: `get_blueprint_components` returns extra non-component variables. TOOLSET_TIPS at `server.mjs:175` pre-documents the heuristic limitation, so agents who read the tip will interpret correctly — but the description doesn't warn.
**Recommended fix**: Walk super-class chain to check if `property_class` is `UActorComponent`-derived; fall back to heuristic only when class can't be resolved. OR narrow the substring to `.ActorComponent` / `.SceneComponent`. Better long-term: let the plugin's reflection walker emit a `is_component: bool` flag natively.

### F-12 [medium] `reflection_walk` / `get_material_graph` have no response-size cap

**Location**: `plugin/UEMCP/Source/UEMCP/Private/ReflectionWalker.cpp:201-242` (SerializeClassReflection), `GraphTraversalHandlers.cpp:96-147` (HandleGetMaterialGraph)
**Root cause**: Full enumeration of all declared properties + functions + metadata for a class; full enumeration of all nodes + pins + edges for a material graph. No limit/pagination. A large BP class (200+ vars, 50+ functions, each with ~5 metadata keys) or complex material graph (hundreds of expression nodes) can produce MB-scale JSON responses.
**Blast radius**: MCP stdio frame limits + agent context budgets. Response truncation risk for PARTIAL-RC tools that layer on reflection_walk (get_blueprint_variables, get_blueprint_functions for large BPs).
**Recommended fix**: Add `limit`/`offset` params on reflection_walk; emit a `truncated` marker. Rolled into existing pagination pattern from `query_asset_registry`/`list_level_actors`.

### F-13 [medium] `get_asset_preview_render` writes to user-controlled paths without sandbox

**Location**: `plugin/UEMCP/Source/UEMCP/Private/VisualCaptureHandler.cpp:95-97`
**Root cause**: `output_path` param is accepted verbatim. Absolute paths bypass the intended `FPaths::ProjectSavedDir()` sandbox; relative paths ending in `../` can escape. Though UEMCP is LAN-trusted per D23, this is a documented path-traversal pattern — an agent running with compromised input could write PNGs anywhere the editor process can write.
**Blast radius**: Within LAN threat model, low — but explicit sandbox is cheap insurance.
**Recommended fix**: Resolve the absolute form via `FPaths::ConvertRelativePathToFull` and validate it lies beneath `FPaths::ProjectSavedDir()` before writing. Reject otherwise.

### F-14 [medium] `stop_pie` returns before teardown completes — race with immediate `start_pie`

**Location**: `plugin/UEMCP/Source/UEMCP/Private/EdgeCaseHandlers.cpp:159-167`
**Root cause**: `GEditor->RequestEndPlayMap()` is an async request; the handler returns immediately. Agent receives `{was_running: true, requested_stop: true}` and may immediately call `start_pie` — which checks `IsPlaySessionInProgress()` at the moment of the call, which may still be true mid-teardown. Comment at line 161 flags this explicitly (M-enhance handoff §Biggest-unknowns 4).
**Blast radius**: Agent workflow that toggles PIE rapidly hits intermittent `ALREADY_RUNNING` errors. Not data corruption; retry would recover.
**Recommended fix**: In `start_pie`, if already-running, sleep+poll up to ~1s before returning error (let teardown finish). Or add a separate `wait_for_pie_stopped(timeout_ms)` tool. Low priority — agents can retry manually.

### F-15 [medium] Menu extender restricts to exact `UBlueprint::StaticClass()` match

**Location**: `plugin/UEMCP/Source/UEMCP/Private/SidecarMenuHook.cpp:76-81`
**Root cause**: `AD.AssetClassPath == UBlueprint::StaticClass()->GetClassPathName()` uses exact equality. UBlueprint subclasses (UWidgetBlueprint, UAnimBlueprint, ULevelScriptBlueprint, UControlRigBlueprint) don't match and the menu item doesn't appear, even though `WriteNarrowSidecar` handles them correctly.
**Blast radius**: Content Browser UX — users right-clicking WidgetBP or AnimBP don't see "Regenerate UEMCP Sidecar" even though sidecars WILL be written for those types via the save-hook.
**Recommended fix**: Check class hierarchy: `AD.GetClass()->IsChildOf(UBlueprint::StaticClass())`. Or walk the asset-registry tag for `Blueprint` markers.

### F-16 [medium] `DumpBPSidecarCommandlet` blocks on full asset-registry scan with no progress output

**Location**: `plugin/UEMCP/Source/UEMCP/Private/Commandlets/DumpBPSidecarCommandlet.cpp:42`
**Root cause**: `AR.SearchAllAssets(true)` blocks until the async initial scan completes. On a large project this can take minutes. Commandlet emits nothing during the wait; user can't tell if it's making progress or deadlocked.
**Blast radius**: CI/batch integrations see "commandlet appears stuck". UX only.
**Recommended fix**: Use the async form with a polling log line every ~5 seconds, or emit a `Display`-level log before/after the blocking call so users know the phase.

### F-17 [medium] Binding-site heuristic `"Delegate"` substring in GraphTraversalHandlers over-matches

**Location**: `plugin/UEMCP/Source/UEMCP/Private/GraphTraversalHandlers.cpp:244`
**Root cause**: `ClassName.Contains(TEXT("Delegate"))` matches any node class with "Delegate" in its name. Intended targets are K2Node_{Add,Remove,Clear,Call,Create}Delegate. Any user-defined K2Node subclass with "Delegate" in its name is captured. Also misses function/macro graph delegate usage since the scan only walks `UbergraphPages`.
**Blast radius**: False positives in `binding_sites` output. Over-counting, agent analysis confused.
**Recommended fix**: Enumerate the known Kismet delegate K2Node classes explicitly. Scan `FunctionGraphs` and `MacroGraphs` alongside `UbergraphPages`.

### F-18 [medium] `list_data_asset_types` routed through PARTIAL-RC dispatch for identity transform

**Location**: `server/menhance-tcp-tools.mjs:241-246`
**Root cause**: `partialRc: { tcpWireType: 'list_data_asset_types', transform: 'identity' }` — tool dispatches via PARTIAL-RC pathway but there's no RC primary and no transform. Semantically it's a FULL-TCP tool that should just route through `MENHANCE_WIRE_MAP` + direct `connectionManager.send`. The PARTIAL-RC shape is forward-looking but misleading because the "hybrid" framing in comments implies RC augmentation which doesn't exist.
**Blast radius**: Code-smell only. Future maintainer could mistake the PARTIAL-RC pattern as having RC fallback when only TCP is wired.
**Recommended fix**: Move this tool out of PARTIAL-RC group into FULL-TCP. Or document in the file header that PARTIAL-RC currently means "plugin-primary with placeholder for future RC augmentation".

### F-19 [low] `parsePinBlock` sentinel magic number partially documented

**Location**: `server/uasset-parser.mjs:1025-1028`, `1127-1131`
**Root cause**: The block-comment at L1025 documents the `int32 = 0` sentinel well (with empirical justification). But the early-exit path at L1117-1125 returns a stub when `postTagOffset + 8 > buf.length` without naming the sentinel check; a reader of just the function body must trace back to the class-comment. The second check at L1131 combines sentinel != 0 with arrayCount bounds — if you want to distinguish "sentinel drifted" from "arrayCount is bogus" for a diagnostic message, you can't.
**Blast radius**: Maintainability. Future worker extending the parser for UE 5.7 delta needs to understand which invariant caused the malformed flag.
**Recommended fix**: Split the L1131 check into two; log/stat which check failed. Add inline comment at L1127 naming the `int32 = 0` sentinel per D70.

### F-20 [low] `extractBPEdgeTopologySafe` only catches ENOENT; EACCES/EISDIR escape as thrown errors

**Location**: `server/offline-tools.mjs:2468-2483`
**Root cause**: `withAssetExistenceCheck` only converts `err.code === 'ENOENT'` to graceful-degradation envelope. Permission errors (EACCES), directory-instead-of-file (EISDIR), or I/O errors propagate as thrown exceptions through MCP's error channel — agent sees a crash rather than a graceful `{available: false}`.
**Blast radius**: Uncommon in practice (assets usually accessible), but locked-file scenarios (e.g., asset checked out in Perforce with read-deny) hit the error path.
**Recommended fix**: Expand to catch `EACCES`, `EPERM`, `EISDIR` with distinct `reason` codes (`asset_locked`, `asset_path_not_file`). Non-ENOENT I/O errors still escape intentionally (distinguishes "absent" from "broken").

### F-21 [low] `bp_trace_exec`/`bp_trace_data` descriptions don't document NodeGuid format requirement

**Location**: `tools.yaml` bp_trace_exec/bp_trace_data entries + `server/offline-tools.mjs:2618-2623, 2706-2711`
**Root cause**: Tool schemas accept `start_node_id: string` with no format guidance. Agents need to know this is Oracle-A-v2 BE-uppercase-per-uint32 hex. Related to F-2 — but even after F-2's fix, documentation should clarify.
**Blast radius**: Agent guesses input format, gets `node_not_found`.
**Recommended fix**: Extend description: "start_node_id: 32-char uppercase hex NodeGuid in Oracle-A-v2 format (matches `bp_show_node.node_guid` after `toOracleHexGuid` conversion)".

### F-22 [low] BFS visited set is node-level only — a node reached via 2 different pins only recorded once

**Location**: `server/offline-tools.mjs:2653-2683`
**Root cause**: `visited` set tracks `node_guid`. If pin A and pin B on different source nodes both connect into node X on different input pins, the first reach wins; second reach's `via_pin`/`from_node_guid` metadata is lost.
**Blast radius**: Users tracing multi-inlet nodes (merge-by-pin logic, Sequence inputs) see only one upstream chain. Slightly misleading but documented by the fact that `chain` is a flat deduped BFS.
**Recommended fix**: Either document this trade-off, or switch `visited` to `(node_guid, incoming_pin_id)` tuple to record all distinct routes.

### F-23 [low] `skipFText` throws on unknown HistoryType values

**Location**: `server/uasset-parser.mjs:1298-1315`
**Root cause**: Only `-1` (None) and `0` (Base) handled; any other HistoryType throws. UE 5.7 may add history types (noted in D70 hint). Behavior is correct (bubbles as `malformed` via parsePinBlock's try/catch) but a newer engine's legitimate new HistoryType would disable the entire pin-block parse for affected assets.
**Blast radius**: UE 5.7 upgrade hazard. Pre-Wave 4 only runs 5.6.
**Recommended fix**: When a new HistoryType is encountered, read/skip conservatively (e.g., assume FText is a single FString) and emit a diagnostic marker; don't throw. Deferred until S-B-overrides 5.7 port.

### F-24 [low] D77 D-log claims 16 plugin handlers; actual count is 18 (off by 2)

**Location**: `docs/tracking/risks-and-decisions.md:174-175` (D77 cumulative totals) vs. actual registrations in `MCPCommandRegistry.cpp:82-88` + per-handler files.
**Root cause**: Counting drift. Actual: ping + 17 new handlers = 18. Likely ping + `bp_compile_and_report` + 15 (Session 2 count) + `regenerate_sidecar` + `get_asset_preview_render` = 18, but D77 narrative rolled this up incorrectly.
**Blast radius**: Documentation accuracy only. No code impact.
**Recommended fix**: Bump D77 count to "17 plugin-C++ handlers (M1's ping + 16 new across Sessions 2-4)" OR drop the numeric total (source-of-truth is the code). Housekeeping.

### F-25 [low] TOOLSET_TIPS references stale `set_text_block_binding broken pin` warning

**Location**: `server/server.mjs:140`
**Root cause**: Widgets toolset tip warns about `set_text_block_binding` broken pin (exec→data). Tool is on TCP:55557 (existing UnrealMCP plugin, frozen per D23). Accurate today. But if M3 deprecates TCP:55557 tools, the warning will stick around as stale guidance.
**Blast radius**: Only matters post-M3 — flag for that worker.
**Recommended fix**: When M3 retires TCP:55557 widgets tools, prune the warning.

### F-26 [low] `data-assets` toolset yaml `layer: tcp-55558` but contains tools dispatched via TCP:55557

**Location**: `tools.yaml:781-821`; tip at `server/server.mjs:225`
**Root cause**: Toolset declares `layer: tcp-55558` uniformly, but `set_data_asset_property` is an old UnrealMCP handler on TCP:55557 per the TOOLSET_TIP at server.mjs:225. Per-tool layer is coarse in yaml.
**Blast radius**: `list_toolsets` shows one layer; reality is mixed. Minor doc precision.
**Recommended fix**: Wait for M3 (re-implements TCP:55557 tools on 55558) — then this resolves naturally. No pre-M3 action needed.

### F-27 [low] `bp_neighbors` incoming scan O(N×M) per call, no caching

**Location**: `server/offline-tools.mjs:2839-2864`
**Root cause**: When `direction='incoming'` or `'both'`, the handler scans every node's every pin's every linked_to to find links targeting the query node. For a 500-node graph with ~10 pins avg, that's 5000+ iterations per call. `extractBPEdgeTopologyFromCtx` is called fresh inside the handler (no topology cache).
**Blast radius**: Noticeable on large BPs (>100 nodes); fine for typical ProjectA BPs. Agents calling `bp_neighbors` on many nodes in one workflow pay O(N²) total parse + scan.
**Recommended fix**: Build a reverse-adjacency map once per topology and reuse. Or memoize the parsed topology per asset_path across calls (5-min TTL like ResultCache).

### F-28 [low] HTTP default timeout 5s tight for RC ops that trigger JIT compile

**Location**: `server/connection-manager.mjs:493`
**Root cause**: `httpTimeoutMs || 5000`. RC calls that trigger on-demand compilation or heavy property walks (describe on a 200-property class) can exceed 5s. On timeout, the agent sees a connection error rather than a slow success.
**Blast radius**: Intermittent "HTTP timeout" errors on large assets. User-visible only in that scenario.
**Recommended fix**: Bump default to 15s for HTTP; keep TCP at 5s (plugin handlers are fast because they don't force compile). Or allow per-tool timeout override.

### F-29 [low] `_httpStatus` private-ish field leaks into normalized error envelope

**Location**: `server/connection-manager.mjs:160`
**Root cause**: `httpCommand` returns `{success: false, message, _httpStatus: status}` on non-2xx. `extractWireError` picks up `success: false` and pulls `message`; the error message then flows through `throw new Error(...)`. But `_httpStatus` persists on the result object when `success:true` (not the case here, but documented intent is unclear). No consumer reads `_httpStatus`, but the leading underscore suggests "private" while it's in the response shape.
**Blast radius**: None (no consumer reads it); minor code hygiene.
**Recommended fix**: Either strip `_httpStatus` from the emitted error envelope once extractWireError consumes it, or promote it to a first-class field and document its purpose.

---

## Systemic patterns observed

1. **Game-thread safety** (F-1) — single biggest structural concern; affects 12+ handlers. Pre-existing pattern inherited from UnrealMCP. Worth a dedicated thread-marshaling worker before Wave 4 piles on more editor-mutating tools.

2. **Description-vs-implementation drift on RC semantic delegates** (F-4, F-5, F-6) — the 3 delegate tools in `rc-tools.mjs` were all shipped with placeholder single-function implementations. Descriptions promise more. Likely same session, same worker, same pattern — one follow-on dispatch can fix all three.

3. **D44 drift on optional params** (F-9) — RC schemas in yaml were transcribed from design docs but Zod schemas grew optional fields during implementation. The EN-5 mechanized lint (backlog) is the long-term solution; F-9 is a manual pre-lint cleanup.

4. **NodeGuid format bridging** (F-2, F-21) — D72 correctly flagged this; Verb-surface worker bridged at the M-spatial output sites they controlled but not at the Verb input boundary. Agents composing M-spatial → Verb-surface hit it silently.

5. **Heuristic filters in plugin C++ handlers** (F-11, F-15, F-17) — `component` substring, exact-class equality, `Delegate` substring all over-/under-match. Pattern: heuristics shipped fast with the acknowledgement that they're heuristics. Each individually minor.

6. **Fallback paths violate triple-keying** (F-8, F-10) — when primary lookup fails and code falls back to a broader scan, D70's uniqueness invariant gets bent. Both fallbacks are low-probability branches but they exist to make the "normal" paths cleaner.

---

## Recommended follow-on worker dispatches (priority order)

1. **Thread-safety-marshaling worker** (F-1) — pre-Wave-4. Adds game-thread dispatch at the MCPCommandRegistry boundary; unblocks M3/M4/M5 from inheriting the same risk.
2. **RC semantic-delegate batch fix** (F-4 + F-5 + F-6 + F-7) — single worker, coherent scope. Use `rc_batch` internally for multi-call tools; fix `toCdoPath` scoping.
3. **NodeGuid format bridge at Verb-surface input** (F-2 + F-21) — small worker: add `toOracleHexGuid` normalization at `bp_trace_exec`/`bp_trace_data`/`bp_neighbors` entry + update descriptions.
4. **D44 yaml-RC drift cleanup** (F-9) — mechanical; could bundle with EN-5 lint worker when it lands.
5. **SidecarWriter atomic-write hardening** (F-3) — tiny; temp-file + rename pattern.
6. **Heuristic-filter refinement pass** (F-11 + F-15 + F-17) — lower priority; tighten filters with class-hierarchy checks.
7. **Response-size-cap worker** (F-12) — pagination on reflection_walk + get_material_graph before Wave 4 adds more large-response tools.

---

## Open items flagged but not analyzed deeply (future audit candidates)

- **PARTIAL-RC group maturity**: 13 tools shipped as plugin-primary with a comment placeholder for future RC augmentation. The pattern itself is forward-looking but the current implementation is semantically equivalent to FULL-TCP. Warrants a session to decide: commit to RC-augmentation design (and start implementing) OR collapse PARTIAL-RC back into FULL-TCP and remove the `partialRc` field. Current shape is half-built.
- **Cross-transport transaction semantics (FA-ε §Open 3)**: TCP-side handlers don't wrap edits in `FScopedTransaction`; RC-side uses RC's own transaction. Separate undo entries, no nesting — but this means an agent making a composite edit across both transports sees two separate Ctrl-Z entries. Worth a dedicated test-plan worker when M3 adds TCP-side mutations.
- **PIE teardown race (M-enhance Biggest-unknowns 4)** — F-14 is the surface symptom, but the underlying question (how to expose "PIE fully stopped" as a signal) needs product-level decision before implementation.
- **UE 5.7 format-drift audit** — `skipFText` (F-23), `FEdGraphPinType.Serialize` trailing bool addition (D70 hint), new HistoryTypes. Defer to S-B-overrides 5.7 worker.
- **Reflection-walk response size profiling** — no empirical measurement of how big responses get on ProjectA's largest classes. F-12 flags the risk but doesn't size it.
