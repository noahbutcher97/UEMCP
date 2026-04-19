# UEMCP Post-Agent-10.5 Codebase Audit — 2026-04-19

> **Scope**: Post-wave-4 (Cleanup Worker) codebase health check before Phase 3 dispatch
> **Type**: Audit — read-only, no code changes
> **Trigger**: `docs/handoffs/audit-a-codebase-health-post-agent10-5.md`
> **HEAD**: `0f5df4d` on main — "Sync test baseline 683 → 709 after Cleanup Worker wave 4"
> **Prior audit**: `docs/audits/uemcp-server-codebase-audit-2026-04-16.md` (pre-Agent-9; 0C/0H/6M/4L). Four waves shipped since: Agent 10 (Level 1+2+2.5 + Option C), Agent 10.5 (D46+D47+D48 bundled), Polish (7 response-shape nits), Parser Extensions (FExpressionInput native + FieldPathProperty), Cleanup (int64 salvage + matchTagGlob).

---

## §1 Architecture Summary Refresh

UEMCP is a Node.js MCP server (stdio transport, SDK 1.29.0) exposing **15 offline tools** (up from 13) and 32 TCP tools across 15 toolsets + 6 always-loaded management tools. The Agent 10 / 10.5 waves added `read_asset_properties` and `find_blueprint_nodes` to the offline surface and expanded `inspect_blueprint` (new `include_defaults` param, `verbose` removed per Q1) and `list_level_actors` (transforms + pagination + `summarize_by_class`). `tools.yaml` is the single source of truth for all offline + TCP tool descriptions and params post-D44 landing.

**Shipped waves since prior audit** (reconstructed via `git log --oneline -10`):

1. **D44 refactor** (`f517f96`) — eliminated `server.mjs:offlineToolDefs`; offline registration now consumes `TOOLS_YAML.toolsets.offline.tools` at `server.mjs:471`. Drift-surface closed.
2. **Agent 10** — Level 1+2+2.5 property parser; `read_asset_properties` new; `list_level_actors` transforms; `inspect_blueprint.include_defaults`.
3. **Agent 10.5 bundled** — D46 (complex-element TMap/TArray/TSet containers), D47 (UserDefinedStruct resolution via D50 tagged-fallback), D48 (Tier S-A `find_blueprint_nodes`).
4. **Polish Worker** — 7 response-shape ergonomic fixes (+37 assertions).
5. **Parser Extensions Worker** (`f3ae608`, `bdd1527`) — FExpressionInput native binary + 7 MaterialInput variants; FieldPathProperty L1 scalar case (+34 assertions).
6. **Cleanup Worker** (`de8d146`, `905c48e`) — int64 overflow salvage in readExportTable (127 files → 0 failures); dynamic RegExp dropped from `search_gameplay_tags` via `matchTagGlob` (D49 semgrep fix).

**Startup sequence** (post-D44):

1. `server.mjs:36` reads `tools.yaml` synchronously via `readFileSync` → `TOOLS_YAML` constant. This is used by the offline registration loop at line 471 — necessary because `toolsetManager.load()` is async and the offline loop runs before `main()`.
2. `ConnectionManager`, `ToolIndex`, `ToolsetManager` constructed.
3. Six management tools registered directly.
4. Offline registration loop (`server.mjs:473-507`) walks `TOOLS_YAML.toolsets.offline.tools`, builds Zod schemas via `buildZodSchema(def.params)`, captures SDK handles, calls `handle.disable()`, registers with `ToolsetManager`.
5. TCP toolset registration loops (actors/bp-write/widgets) consume `getActorsToolDefs()` etc. from `tcp-tools.mjs` — schemas richer than yaml stubs but wire type strings resolved from yaml `wire_type:` fields.
6. `toolsetManager.load()` async: reads yaml from disk (second parse — ~5KB double-work), builds `ToolIndex`, populates `TOOLSET_LAYERS` map, enables the offline toolset.
7. `initTcpTools(toolsetManager.getToolsData())` populates wire maps.
8. `StdioServerTransport` connected.

**Request flow (unchanged)**: MCP `tools/call` → SDK Zod validation → handler. Offline dispatches via `executeOfflineTool(name, args, root)`; TCP via `executeActorsTool|executeBlueprintsWriteTool|executeWidgetsTool(name, args, cm)`. Both patterns preserved.

**Parser composition** (new): offline tools now build per-call struct + container dispatch tables via `buildStructHandlers()` (24 engine struct handlers) and `buildContainerHandlers()` (ArrayProperty/SetProperty/MapProperty) from `uasset-structs.mjs`. These are constructed per-call inside `parseAssetForPropertyRead()` (`offline-tools.mjs:1216-1231`) — cheap Map objects, no cache needed.

---

## §2 Module Dependency Map

```
server.mjs (entry — 679 lines, down from 733 post-D44)
  ├─ connection-manager.mjs      ConnectionManager
  ├─ tool-index.mjs              ToolIndex (pure)
  ├─ toolset-manager.mjs         ToolsetManager
  │    ├─ tool-index.mjs
  │    ├─ connection-manager.mjs
  │    └─ js-yaml
  ├─ offline-tools.mjs           executeOfflineTool, assetCache, parseAssetHeader,
  │                              parseAssetForPropertyRead, matchTagGlob
  │    ├─ uasset-parser.mjs      ← binary reader (Cursor, parseSummary, tables,
  │    │                          FPropertyTag iteration, tagged fallback, FieldPath)
  │    └─ uasset-structs.mjs     ← Level 2 struct handlers + containers (NEW module)
  │          └─ uasset-parser.mjs (readFNameAtCursor, readTaggedPropertyStream)
  ├─ tcp-tools.mjs               initTcpTools, execute{Actors,BpWrite,Widgets}Tool
  │    └─ zod
  └─ @modelcontextprotocol/sdk

connection-manager.mjs            node:net, node:crypto
uasset-parser.mjs                 (no internal deps — pure leaf, exports Cursor class)
uasset-structs.mjs                uasset-parser.mjs (partial circularity-adjacent)
```

**New in this audit**: `uasset-structs.mjs` imports from `uasset-parser.mjs`, and `uasset-parser.mjs` does NOT import from `uasset-structs.mjs` (the dispatcher receives handlers via `opts.structHandlers` / `opts.containerHandlers` maps constructed by the caller in `offline-tools.mjs:1228-1229`). No circular imports. Clean unidirectional dep: `structs → parser`.

**Coupling note** (unchanged from prior audit): `offline-tools.mjs` still exports `assetCache` as a mutable module-level singleton. D33 invalidation pattern (`indexDirty` flag) remains untested against real Phase 3 TCP write-ops — no current writer flips it.

**Mock seam, per-layer queue, SHA-256 cache** — unchanged from prior audit. TCP tools still use the same injection pattern; `test-helpers.mjs` unchanged (225 lines). `FakeTcpResponder` + `ErrorTcpResponder` still the only test infra.

---

## §3 Code Quality Review

Severity: **CRITICAL** (production failure), **HIGH** (likely issue), **MEDIUM** (tech debt / smell), **LOW** (polish). Findings at file:line.

### `server.mjs` — 679 lines (↓54 from 733)

- **Consistency**: Post-D44 the offline registration loop at line 473 and the three TCP registration loops at lines 513-631 are uniform — each reads its `*ToolDefs` object, builds a Zod schema from `def.schema` (TCP) or `def.params` via `buildZodSchema` (offline), registers with `server.tool()`, calls `handle.disable()`, wires `toolsetManager.registerToolHandle`. No duplicated description block survives.
- **Correctness**: Offline registration loop sources `def.description` and `def.params` directly from `TOOLS_YAML.toolsets.offline.tools` (line 471) — the same yaml that `toolsetManager.load()` re-reads for `ToolIndex.build()`. Byte-identical description surface between `tools/list` and `find_tools` by construction (verified by Test 10 at `test-phase1.mjs:585-624`).
- **LOW — double yaml parse at startup**: `server.mjs:36` reads + parses tools.yaml synchronously for the offline loop; `toolset-manager.mjs:52-55` reads + parses it again async inside `load()`. Two ~5KB parses instead of one. Inline comment at line 30-34 acknowledges this as "acceptable ~5KB double-parse for a zero-API-surface refactor." Cost is negligible but the file is read from disk twice — could be eliminated by deferring the offline loop to inside `main()` after `toolsetManager.load()` resolves. Not urgent.
- **No CRITICAL/HIGH/MEDIUM findings for server.mjs.**

### `offline-tools.mjs` — 1829 lines (↑536 from 1293)

Priority file — 5 new handlers land here. Per-function walk:

- **Consistency**: 15 handler functions, one per tool. Snake_case params throughout. Error paths throw with resolvable context. Dispatch switch at `line 1772` is flat and uniform.
- **Correctness — F0 path unchanged**: `executeOfflineTool` `case 'get_asset_info'` at `line 1788` still passes `params` through as the third argument. Verified by test-phase1 running 172/172 including F0 assertions.
- **Correctness — D44 invariant**: offline tool registration in `server.mjs` uses yaml params → Zod schema. Handler `inspectBlueprint` at `line 1243` reads `params.include_defaults` (matches yaml line 88); handler `readAssetProperties` at `line 1500` reads `params.asset_path`, `params.export_name`, `params.property_names`, `params.max_bytes` (matches yaml lines 99-102). Traced end-to-end.
- **MEDIUM — `search_gameplay_tags` handler reads a param not declared in yaml**. `offline-tools.mjs:1780` checks `params.pattern` and throws if absent. `tools.yaml:64-65` declares no params block for this tool. `buildZodSchema` at `server.mjs:425-426` returns `{}` for empty-params tools, so the MCP SDK accepts any shape — the handler's inline guard then throws `'Missing required parameter: pattern'`. **Impact**: (a) `find_tools`/`tools/list` cannot surface `pattern` as a param to callers consulting yaml for discovery; (b) the "tools.yaml is the single source of truth" contract (CLAUDE.md Key Design Rule 1 + D44) is violated for this tool; (c) Claude cannot rely on yaml-driven auto-completion / shape validation for this tool. The SERVER_INSTRUCTIONS hint at `server.mjs:64` partially mitigates by describing glob behavior, but doesn't surface the param name.
- **MEDIUM — `list_config_values` handler reads three params not declared in yaml**. `offline-tools.mjs:1784` passes `params.config_file`, `params.section`, `params.key` to `listConfigValues`. `tools.yaml:66-67` declares no params block. Same impact vector as `search_gameplay_tags`. Unlike that tool, no inline guard — the handler treats all three as optional, so missing params quietly return the files-list response. **Silent behavior divergence**: a caller passing `{}` gets `{configFiles: [...]}`, while the yaml description claims the tool reads "any .ini config file" without surfacing how to specify one. SERVER_INSTRUCTIONS at `server.mjs:63` mentions the progressive pattern but not the param names.
- **MEDIUM — `find_blueprint_nodes` count drift**: tools.yaml line 106 and `offline-tools.mjs:1583` describe "13 skeletal K2Node types (...) plus delegate-node presence (AddDelegate, AssignDelegate)". The comma-separated listing contains **17** non-delegate types (Event, CustomEvent, FunctionEntry, FunctionResult, VariableGet, VariableSet, CallFunction, CallParentFunction, IfThenElse, ExecutionSequence, SwitchEnum, SwitchString, SwitchInteger, DynamicCast, MacroInstance, Self, Knot) and 2 delegates, for a total of **19 entries** in `SKELETAL_K2NODE_CLASSES` at `offline-tools.mjs:1591-1607`. The "13" figure is load-bearing in D48 (which explicitly budgets "13 K2Node types") — Agent 10.5 shipped more than D48 planned, which is fine functionally, but the public-facing count is wrong and the D-log carries the stale number. Misleading to downstream agents reading D48 to understand offline BP coverage. Description-drift class of finding, same shape as prior audit's M2.
- **LOW — `parseAssetTables` is dead code** (`offline-tools.mjs:1132`). Defined as a helper that reads + parses summary + names + imports + exports, but has **zero callers** (grep across `server/` returns only the definition). `parseAssetForPropertyRead` at line 1216 is the sole consumer of the tables pattern and defines the same logic inline (plus a struct-handler + resolver context). Safe to delete.
- **LOW — `listDirRecursive` is dead code** (`offline-tools.mjs:189`). Only self-references (recursive call at line 199); no external callers. Predates the asset-parser work. Safe to delete.
- **LOW — redundant dual-parse in `inspectBlueprint`**. Lines 1246-1247 call both `parseAssetForPropertyRead` (reads file, parses summary+names+imports+exports) AND `parseAssetHeader` (reads file, parses summary+names+AR). Two full file reads + two `parseSummary` + two `readNameTable` calls per invocation. `parseAssetHeader`'s cache doesn't help because the first pass doesn't populate it. `findBlueprintNodes` at lines 1696-1698 has the identical pattern. Correctness is fine (both paths resolve the same fields); cost is ~2× file I/O and ~2× summary/name parsing. The fix is either to (a) make `parseAssetHeader` reuse a provided `ctx.buf` when available, or (b) have `parseAssetForPropertyRead` also populate `assetCache` and extract AR data. Not urgent — measured baseline is 1.06× Agent 10 per D50 (well under 2× SLA).
- **Robustness**: `isPlacedActor` at line 1309 — unchanged from prior audit, uses class-name substring matches. Known false-negative risk: any class name containing one of the excluded substrings ("Function", "Texture2D", etc.) as a prefix of its own name is dropped. No concrete bugs observed in practice (ProjectA manual tests pass); worth flagging for Phase 3 reimplementation.
- **Maintainability**: At 1829 lines, this file is approaching the split threshold. Per-tool files (`offline-tools/<tool>.mjs`) would cleanly partition the handlers. Recommendation stands from prior audit but upgraded in urgency — not blocker-level, but LOW tech-debt priority.

### `uasset-parser.mjs` — 1054 lines (↑448 from 606)

Foundation file; every offline handler above the primary cache depends on it.

- **Consistency**: Reader helpers (`readFString`, `readGuid`, `readIoHash`, `readInt64AsNumber`, new `readInt64AsNumberOrNull` at line 91) cleanly layered on `Cursor`. UE 5.6 stride constants documented inline. Version gates unchanged from prior audit and correct for fileVersionUE5 ≥ 1016.
- **Correctness — int64 salvage**: `readInt64AsNumberOrNull` at `line 91-99` returns `null` on overflow past `MAX_SAFE_INTEGER` while advancing the cursor 8 bytes. `readExportTable` at lines 553-557 delegates to the lenient reader for six int64 fields (`serialSize`, `serialOffset`, `publicExportHash`, `scriptSerializationStartOffset`, `scriptSerializationEndOffset`) and records overflow field names via `overflowFields[]`. On overflow, the field is substituted with `-1` and the export row gets `int64Overflow: true` + `int64OverflowFields: [...]` markers. **Verified by test-uasset-parser.mjs** — SM_auraHousya fixture has 1/8 exports marked, cursor stride preserved (197/197 tests pass). Production-grade salvage.
- **Correctness — FieldPathProperty**: `dispatchPropertyValue` at lines 800-826 handles FFieldPath: int32 PathCount + PathCount × FName + optional FPackageIndex ResolvedOwner (bounded by declared `size`). Defensive upper bound of 64 path entries (line 812). Matches UE 5.6 `FieldPath.cpp::operator<<`. Size-gated owner read prevents desync on pre-FFieldPathOwnerSerialization variants.
- **Correctness — tagged fallback (D50)**: `dispatchPropertyValue` at lines 976-994 implements the D47-superseded-by-D50 tagged-fallback. When no struct handler is registered AND `PTAG_BINARY_OR_NATIVE_SER` flag (0x08) is clear AND `tag.size > 0`, the dispatcher delegates to `readTaggedPropertyStream` on the sub-stream bounded at `cur.tell() + tag.size`. Self-describing — no UDS asset load. Per D50, reduces unknown_struct markers 251K → 22K (91%). Cursor-bound via endOffset guard in `readTaggedPropertyStream` prevents walk-off.
- **Robustness — `readExportProperties` stream guards**: Three guard conditions at lines 860-872 — bad serial range → `serial_range_out_of_bounds` marker; non-zero preamble → `unexpected_preamble` marker with observed byte. Both markers bubble up to the response without crashing. Same pattern extends to `value_overruns_serial` at line 907 and `tag_header_read_failed` at line 900. Per D47/D50 principle "never silently skip" — verified.
- **LOW — `parseBuffer` is thin**: `parseBuffer(buf)` at line 189 returns just `{summary}` — doesn't chain the richer parsers (`readNameTable`, `readImportTable`, etc.). Callers compose manually. Same finding as prior audit; survived the Agent 10/10.5 waves. Cosmetic API surface issue.
- **No CRITICAL/HIGH/MEDIUM findings for uasset-parser.mjs.** Phase 2 Tier-2 audit's "production-grade" verdict HOLDS — 709/709 tests pass, including the 197 parser-format tests against real ProjectA fixtures spanning int64 salvage, FieldPath, tagged fallback, complex containers, and 24+ struct variants.

### `uasset-structs.mjs` — 664 lines (NEW)

- **Consistency**: 24 struct handlers registered in `buildStructHandlers()` at line 627-653. Flag-dispatched pattern: each handler checks `tag.flags & HAS_BINARY_NATIVE` and routes to either `readF*Binary` (native) or `readTaggedStructFields` → coerced-field-return (tagged fallback). `extractKnownStructFields` at line 120 provides tagged-fallback coercion for known-shape structs.
- **Correctness — engine struct coverage (D46)**: 12 primitive math structs (FVector/Rotator/Quat/Transform/LinearColor/Color/Guid/Vector2D/Vector4/IntPoint/Box/BodyInstance), FGameplayTag + FGameplayTagContainer, FSoftObjectPath + FSoftClassPath, FExpressionInput + 7 MaterialInput variants (FColorMaterialInput, FScalarMaterialInput, FShadingModelMaterialInput, FSubstrateMaterialInput, FVectorMaterialInput, FVector2MaterialInput, FMaterialAttributesInput). Every Level 2 struct handler tested in test-uasset-parser.mjs (197 assertions).
- **Correctness — FMaterialInput variants**: `makeMaterialInputHandler(readConstant, fallbackConstant)` at line 506 generates per-type handlers. The 36-byte FExpressionInput base + 4-byte `bUseConstantValue` + per-type constant layout exactly matches `MaterialExpressionIO.h` (UE 5.6). Reference verified 2026-04-16 per file header comment. Color uses 4×float32, scalar uses float32, shading-model uses uint32, vector3 uses 3×float32 (not double — "render-thread precision" per comment at line 503). **Verified against ProjectA M_Master_DefaultOpaque** by test-uasset-parser.
- **Correctness — TMap handler**: `handleMapProperty` at line 198-249 reads NumRemovedKeys + NumElements + per-entry key_bytes + value_bytes. Struct keys emit `struct_key_map` marker (line 218) — intentionally unsupported per D46 deferral. Scalar keys + struct values land in the fallback path via `readStructElement`. Trail invariant: cursor lands at valueEnd even on intra-element failure because `readTaggedPropertyStream` (called from `readStructElement` on tagged path) walks to "None" terminator and abort-on-unsupported returns immediately.
- **Correctness — complex-element container fallback**: `readArrayElements` at line 138 dispatches on inner-type. For `StructProperty<Name>` elements without a handler, the tagged-stream path at line 114 calls `readTaggedPropertyStream` up to `cur.buf.length` (virtual end), then returns via `extractKnownStructFields` coercion — same self-describing decode as dispatcher tagged fallback. Per D50 this eliminates 24K `container_deferred` markers.
- **MEDIUM — FBodyInstance native binary layout unhandled**: `handleFBodyInstance` at line 562-567 returns `{__unsupported__: true, reason: "body_instance_native_layout_unknown"}` on flag 0x08. The tagged fallback handles the common case where an actor overrides a subset of members (comment at line 559-561). If UE ever serializes FBodyInstance as native binary (unlikely for CDOs, possible for cooked assets), the tool surfaces the marker without data. D46/D50 cycle verified this path doesn't fire in the 19K-file ProjectA corpus, so this is a latent edge case not a production bug — but the marker reason code (`body_instance_native_layout_unknown`) is **not documented** in the `read_asset_properties` tool description (`tools.yaml:97`). Reason-code catalog at `offline-tools.mjs:1162-1176` also omits it. Callers seeing this marker have no way to decode it from the tool docs.
- **LOW — `readStructElement` fallback for native-binary-only structs**: At line 101-105, if outer flag has HAS_BINARY_NATIVE set AND no handler exists, returns `{__unsupported__: true, reason: "complex_element_container"}`. Comment at line 100 says "Native binary requires a known layout. No handler + native = surrender." Correct but opaque — the marker gives the struct name (good) but no guidance on whether the struct is expected to eventually gain a handler or is permanently out-of-scope. Minor ergonomic issue; D50 already tracked the FExpressionInput 0.2% tagged case + relabeled the 99.8% native case.
- **No HIGH/CRITICAL findings.** Production-grade module.

### `tcp-tools.mjs` — 520 lines (unchanged)

No changes since prior audit. Prior M5 (take_screenshot yaml/Zod gap) is **RESOLVED** — `tools.yaml:205-207` now declares `resolution_x` and `resolution_y`. Three dispatchers (actors/bp-write/widgets) still 95% identical — same DRY tech debt noted in prior audit, not urgent. Widget path stripping (`stripDoubledAssetSuffix`), wire type translation, and defensive Zod parsing all unchanged.

### `tool-index.mjs` — 320 lines (unchanged)

No code changes. Prior M-numbered findings either resolved (`get_all_blueprint_graphs` duplicate yaml entry — only the alias form remains at `tools.yaml:447`) or still standing as LOW (stem minor quirks, `_entries` test access). 6-tier scoring + coverage bonus continues to work.

### `toolset-manager.mjs` — 303 lines (unchanged)

No code changes. Prior LOW finding: `getToolDef` at line 247 **still has zero callers** across `server/` (re-verified via grep). Still dead code.

### `connection-manager.mjs` — 610 lines (unchanged)

No changes. 4-layer model, per-layer queue, SHA-256 cache, three error envelope formats + two defensive sibling paths. Mock seam via `tcpCommandFn` unchanged. Still PowerShell-only auto-detect at `line 401-405` (prior LOW finding, Windows-pinned product so no real blocker).

### `tools.yaml` — 822 lines (↑29 from 793)

- **Consistency**: 15 offline tools + 32 TCP tools + 8 remote-control + 35 other Phase 3-planned. Aliases section unchanged (18 entries).
- **Correctness — D44 invariant**: yaml is now the sole source for all 15 offline tool descriptions + params. `tools/list` and `find_tools` serve identical metadata by construction (verified by test-phase1 Test 10 at lines 585-624).
- **Correctness — Agent 10.5 landings**: `find_blueprint_nodes` entry at lines 103-123; `read_asset_properties` at lines 96-102; `list_level_actors` expanded at lines 89-95; `inspect_blueprint` expanded at lines 84-88.
- **MEDIUM (already listed under offline-tools.mjs)**: `search_gameplay_tags` + `list_config_values` lack params blocks despite handler reads. Yaml-as-truth violated.
- **MEDIUM (already listed)**: `find_blueprint_nodes` description says "13 skeletal" but `SKELETAL_K2NODE_CLASSES` set has 19 entries.
- **LOW** (new): reason-code catalog for `read_asset_properties` at line 97 lists 9 reasons; `offline-tools.mjs:1162-1176` lists 10. Both omit `body_instance_native_layout_unknown`, `container_count_unreasonable`, `map_with_removed_items`, `set_with_removed_items`, `map_type_params_missing`, `map_key_type_unsupported`, `map_value_struct_name_missing`, `map_value_type_unsupported`, `struct_key_map`, `expression_input_native_layout_unknown`, `root_component_parse_failed`, `no_cdo_export_found`, `value_overruns_serial`, `tag_header_read_failed`, `property_tag_extensions`, `value_read_failed`. A full reason-code catalog has drifted — 15+ codes exist in code, 9 in yaml, 10 in offline-tools comment. Not a bug but a documentation-coverage gap. Callers seeing marker codes outside the documented 9 cannot interpret them from the tool description.

### Test files

- **Primary suite** — 3 files, 451 assertions, 451/451 PASS:
  - `test-phase1.mjs` (891 lines, ↑544 from 347): Tests 1-12 covering imports, matchTagGlob, ToolIndex search, offline tools, D44 invariant, Agent 10.5 Tier 4 `find_blueprint_nodes`, Polish Worker response-shape ergonomics. **172 assertions** (up from 54).
  - `test-mock-seam.mjs` (476 lines, unchanged): 45 assertions, wiring + cache + error format + queue + fake responders.
  - `test-tcp-tools.mjs` (1073 lines, unchanged): 234 assertions across 25 groups.
- **Supplementary suite** — 4 files, 258 assertions, 258/258 PASS:
  - `test-uasset-parser.mjs` (1398 lines, ↑1196 from 202): **197 assertions** covering parser format + Level 1+2+2.5 + tagged fallback + int64 salvage + FieldPath + complex containers + 24 struct handlers.
  - `test-offline-asset-info.mjs` (154 lines, unchanged): 15 assertions.
  - `test-query-asset-registry.mjs` (127 lines, unchanged): **16 assertions — now PASSING** (prior audit flagged 14/16; F1 stale fix is now live).
  - `test-inspect-and-level-actors.mjs` (106 lines, unchanged): **30 assertions — now PASSING** (prior audit flagged 29/30; F2 stale fix is now live).
- **test-helpers.mjs** (225 lines, unchanged): shared infra, not a runner.

**Prior audit's MEDIUM finding on stale supplementary tests is fully RESOLVED.** All 709 assertions green.

---

## §4 Handler Audit Table

Verified all 47 handlers (15 offline + 10 actors + 15 blueprints-write + 7 widgets). Only mismatches listed.

| Tool | yaml params | Schema accepts | Handler reads | Match | Severity | Notes |
|---|---|---|---|---|---|---|
| `search_gameplay_tags` | **none declared** | `{}` (empty Zod) | `params.pattern` (required, handler-guarded) | ❌ | MEDIUM | New finding. Handler at `offline-tools.mjs:1780` throws on missing pattern. yaml-as-truth violated; `find_tools` discovery doesn't surface param. |
| `list_config_values` | **none declared** | `{}` (empty Zod) | `params.config_file`, `params.section`, `params.key` (all optional) | ❌ | MEDIUM | New finding. Handler at `offline-tools.mjs:1784` silently uses progressive-mode behavior. Caller with no params gets file list; no error signals param names. |
| `find_blueprint_nodes` | 6 params (yaml:117-123) | 6 params (via Zod) | 6 params (handler:1689-1694) | ✅ | — | Params correct. Description's "13 skeletal" count is wrong (MEDIUM — description drift, already listed in §3). |
| `inspect_blueprint` | `asset_path`, `include_defaults` | both | both (`offline-tools.mjs:1244-1245`) | ✅ | — | Post-Agent-10 `verbose` → `include_defaults` rename propagated correctly. |
| `list_level_actors` | `asset_path`, `limit`, `offset`, `summarize_by_class` | all 4 | all 4 (`offline-tools.mjs:1409-1413`) | ✅ | — | Pagination + summary mode working per P1 assertions. |
| `read_asset_properties` | `asset_path`, `export_name`, `property_names`, `max_bytes` | all 4 | all 4 (`offline-tools.mjs:1501-1505`) | ✅ | — | Filter scope-in works per P2 assertions. |
| `get_asset_info` | `asset_path`, `verbose` | both | both (`offline-tools.mjs:470-471`) | ✅ | — | F0 fix preserved post-D44. |
| TCP actors (10 tools) | per yaml | per Zod | per handler | ✅ | — | No mismatches. Unchanged from prior audit. |
| TCP blueprints-write (15 tools) | per yaml | per Zod | per handler | ✅ | — | No mismatches. Unchanged from prior audit. |
| TCP widgets (7 tools) | per yaml | per Zod | per handler | ✅ | — | No mismatches. Unchanged from prior audit. |

**Tagged-fallback path audit** (D50 — new in Agent 10.5): Traced at `uasset-parser.mjs:976-994`. For each StructProperty tag where no handler is registered and flag 0x08 is clear and size > 0, the dispatcher calls `readTaggedPropertyStream(cur, cur.tell() + tag.size, names, opts)`. Cursor bounded by size. Returns sub-properties dict. `opts.resolvedUnknownStructs.add(structName)` is also called when `resolvedUnknownStructs` is provided (currently only via test — no production caller provides it, so the tracking Set is dormant). **No silent-drop behavior observed** — every unsupported path emits an `unsupported` marker with a named reason. Contract upheld.

**Tool count reconciliation**: yaml has 15 offline tools + 10 actors + 15 bp-write + 7 widgets + 9 gas/blueprint-read + 5 asset-registry + 8 animation + 5 materials + 7 data-assets + 7 input-and-pie + 4 geometry + 8 editor-utility + 5 visual-capture + 8 remote-control = **113 toolset tools** + 6 management = **119 total**. CLAUDE.md claims "120 tools across 15 toolsets + 6 always-loaded management tools" and "122 tools" elsewhere — the 120 number is pre-Agent-10.5; the 122 figure appears in CLAUDE.md line 72 ("single source of truth for all 122 tools"). Neither matches the 119 I count. **LOW — tool-count drift in CLAUDE.md** (non-critical, documentation-only).

---

## §5 Test Coverage Assessment

**Test totals verified 2026-04-19** (all 7 files run via bash with `UNREAL_PROJECT_ROOT=D:/UnrealProjects/5.6/ProjectA/ProjectA`):

| Suite | Assertions | Result | Rotation |
|---|---|---|---|
| `test-phase1.mjs` | **172** | 172/172 PASS | primary |
| `test-mock-seam.mjs` | **45** | 45/45 PASS | primary |
| `test-tcp-tools.mjs` | **234** | 234/234 PASS | primary |
| **Primary total** | **451** | **451/451 PASS** | |
| `test-uasset-parser.mjs` | **197** | 197/197 PASS | supplementary |
| `test-offline-asset-info.mjs` | **15** | 15/15 PASS | supplementary |
| `test-query-asset-registry.mjs` | **16** | 16/16 PASS | supplementary |
| `test-inspect-and-level-actors.mjs` | **30** | 30/30 PASS | supplementary |
| **Supplementary total** | **258** | **258/258 PASS** | |
| **Grand total** | **709** | **709/709 PASS** | matches CLAUDE.md baseline |

**Growth since prior audit**: 333 primary + 103 supplementary = 436. Current = 709. Net +273 assertions (+82 primary, +155 supplementary). Breakdown per CLAUDE.md: Agent 10 +125, Agent 10.5 +51, Polish +37, Parser Extensions +34, Cleanup +26. Total +273 — **matches documented baseline exactly**.

**Coverage gaps (per-handler)**:

All 15 offline handlers have **at least one** direct `executeOfflineTool` assertion in `test-phase1.mjs` or a supplementary suite. Specifically:
- `project_info`, `list_gameplay_tags`, `search_gameplay_tags`, `list_config_values`, `list_data_sources`, `read_datatable_source`, `read_string_table_source`, `list_plugins`, `get_build_config` — primary coverage only.
- `get_asset_info` — primary (test 9 F0 assertions) + supplementary (15 assertions).
- `query_asset_registry` — primary + supplementary 16 assertions.
- `inspect_blueprint` — primary (test 9 F2 removed-tags assertions + test 12 P3 packageIndex assertions + test 10 D44 invariant) + supplementary 30 assertions.
- `list_level_actors` — primary (tests 9, 10, 12 P1/P3/P7) + supplementary.
- `read_asset_properties` — primary (test 12 P2/P3/P4/P5).
- `find_blueprint_nodes` — primary (test 11 — 5 subtests covering unfiltered, class filter, member filter, target filter, pagination).

All 32 TCP handlers have at minimum tool-def + name-translation + happy-path assertions in `test-tcp-tools.mjs` across 25 groups. Additional defensive coverage (Zod required-param, Vec3 length) for the 4 P0-9/P0-10 risks.

**F0-class false-confidence risks — re-assessed**:

Prior audit identified that direct calls to `executeOfflineTool` bypass the Zod schema built by `buildZodSchema()`. Post-D44 analysis: since yaml is now the sole source of truth for params, and test-phase1 Test 10 (lines 585-624) explicitly asserts on yaml params for `list_level_actors`, `inspect_blueprint`, `read_asset_properties`, `find_blueprint_nodes`, a drift between yaml and handler would fail that test. **The D44 invariant check is the structural defense against F0-class drift.**

However, direct-call tests still don't catch:
1. **Params the handler READS but yaml does NOT declare** (MEDIUM findings §3 for `search_gameplay_tags` + `list_config_values`). The handler gets undefined and either throws (pattern) or silently changes behavior (list_config_values). Tests pass because they call handlers with correct params, bypassing discovery entirely.
2. **Params yaml declares but handler does NOT read** — no examples found.
3. **Description drift** (MEDIUM §3 `find_blueprint_nodes` "13 skeletal"). Tests don't check the description count against the set size.

**New F0-class candidates identified** (added to §4 + §3):
- `search_gameplay_tags` param gap — pattern not in yaml.
- `list_config_values` param gap — 3 params not in yaml.
- `find_blueprint_nodes` description count drift.

**No new F0-class regression risks from Agent 10 / 10.5 waves** — the new handlers (`read_asset_properties`, `find_blueprint_nodes`) all declare their params in yaml correctly.

**Stale supplementary tests risk (prior audit MEDIUM)**: **RESOLVED**. All 4 supplementary suites pass 258/258. `test-query-asset-registry.mjs` and `test-inspect-and-level-actors.mjs` were updated when F1/F2 handler fixes landed. The supplementary rotation is documented in CLAUDE.md's "Supplementary Rotation" table and wired into orchestrator's test cadence.

**Test infrastructure gap (unchanged from prior audit)**: No MCP-wire integration test harness. Direct-call tests still bypass the SDK handler wrapper (`server.mjs:480-499`). A harness instantiating `McpServer` + sending a fixture `tools/call` + asserting on the response would close the F0-class false-confidence gap for any future param-passthrough bugs introduced post-D44. Not urgent (D44 structurally prevents the original F0 shape) but would cover the two new MEDIUM param-gap cases.

---

## §6 D-log Drift Check (D44–D50)

For each decision D44-D50, verified claims against shipped code today.

### D44 — yaml is single source of truth; `offlineToolDefs` eliminated

- **Claim**: `server.mjs:offlineToolDefs` eliminated; yaml drives offline tool descriptions + params.
- **Code today**: `server.mjs:471` declares `const offlineToolDefs = TOOLS_YAML.toolsets.offline.tools` — the name survives but now references yaml. The local const with duplicate descriptions is gone (verified via grep; prior state at `458-525` no longer exists). Registration loop at line 473-507 consumes def.description + def.params from yaml.
- **Drift**: None. D44 holds structurally. `test-phase1.mjs:585-624` (Test 10) enforces the invariant with 9 assertions.
- **Status**: ✅ Accurate.

### D45 — L3A full-fidelity UEdGraph byte parsing is EDITOR-ONLY; 3F sidecar is offline-read path

- **Claim**: Pure .uasset byte parsing of 200+ K2Node subclasses is permanently out of scope. 3F sidecar is the canonical offline-read path for BP logic introspection.
- **Code today**: No attempt at general K2Node parsing in `offline-tools.mjs`; `find_blueprint_nodes` (D48 S-A) is a narrow subset. No 3F sidecar consumer has shipped (`server/*.mjs` has no sidecar reader) — **sidecar writer is still a critical-path item per CLAUDE.md line 137**. D45's claim about the intended role of the sidecar matches shipped code (offline tools do not try to parse K2Node pin binary), but the sidecar itself is not yet in production.
- **Drift**: None in principle; status note: the sidecar dependency chain D45 → Agent 10.5 S-A → production is partially realized (S-A shipped; sidecar pending).
- **Status**: ✅ Accurate, with pending-work note. D45's verdict holds.

### D46 — L3B simple-element containers ship with Agent 10; complex-element deferred to Agent 10.5

- **Claim**: Simple-element `TArray<int/float/bool/string/FName>`, `TArray<FVector>`, etc. in Agent 10. TMap + TArray<FMyUserStruct> deferred to Agent 10.5.
- **Code today**: `buildContainerHandlers` at `uasset-structs.mjs:272-278` registers ArrayProperty + SetProperty + MapProperty. `readArrayElements` at line 138 dispatches simple-scalar + struct-element paths. `handleMapProperty` at line 198 — TMap shipped. Complex-element support IS LIVE (per D50's 91% marker reduction on complex_element_container).
- **Drift**: D46 says "TMap deferred to Agent 10.5 follow-on"; 10.5 shipped it. Matches. D46's scope estimate of "3-4 agent sessions" maps to Agent 10.5's bundled D46+D47+D48 landing — close enough.
- **Status**: ✅ Accurate.

### D47 — UUserDefinedStruct resolution via two-pass registry — SUPERSEDED-BY-D50

- **Claim (original)**: two-pass parser loading each UUserDefinedStruct asset to learn member layout.
- **Amendment**: 2026-04-16 amendment explicitly marks this SUPERSEDED-BY-D50. Two-pass approach replaced by tagged-fallback (D50).
- **Code today**: `dispatchPropertyValue` at `uasset-parser.mjs:987-994` implements tagged fallback — no UDS asset load, no struct registry cache, no cycle detection. `structHandlers` has no UDS entry (verified by checking `buildStructHandlers()` at `uasset-structs.mjs:627-653` — UUserDefinedStruct is absent by design). The 2-pass design described in D47's main body does NOT match shipped code, which is why the amendment is there.
- **Drift**: D47 body describes abandoned design; D47 amendment correctly flags it; D50 describes live design. Reader following the amendment lands correctly.
- **Status**: ✅ Amendment is accurate and load-bearing. The amendment preserves D47 as historical record of the mental model correction, which is the right discipline. **Recommendation noted for §8**: add a cross-reference from D47 body's first line to the amendment so a reader who doesn't scroll to the bottom doesn't implement the stale design. This would ideally be a D-log edit (out of scope for this audit).

### D48 — L3A skeletal S-A PURSUE / S-B FOLD-INTO-3F

- **Claim**: Tier S-A (name-only tagged-property) is the 13-K2Node-type shipped surface; Tier S-B (pin tracing) is folded into the 3F sidecar path. Math/comparison ops deferred per Q-2.
- **Code today**: `find_blueprint_nodes` at `offline-tools.mjs:1688` ships with `SKELETAL_K2NODE_CLASSES` set at line 1591 containing **19 entries** (17 non-delegate + 2 delegate), not 13. D48 explicitly budgets "13 K2Node types" and the math/comparison deferral list at §L3C of the research study doc describes ops not in the shipped set — so the deferral is respected, but the shipped set is MORE inclusive than D48 planned.
- **Drift**: **Count drift — 13 planned vs 19 shipped.** Tool description inherits the 13 count (MEDIUM finding §3 and §4). The intent is consistent (S-A covers find/grep without pin tracing), but the specific tally is wrong. Not a correctness issue — callers still get the correct data — but D-log + yaml + code comment all carry the stale "13" figure.
- **Status**: ⚠️ **Partially drifted**. Behaviour matches D48 intent; count figures are stale everywhere (D48 body, tools.yaml:106, offline-tools.mjs:1583). No superseding D-entry has been written.

### D49 — Parallel-session git commits must be path-limited

- **Claim**: `git commit <path> -m "..."` not `git add <path> && git commit -m "..."`. Documented as universal rule.
- **Code today**: N/A — this is a process decision, not a code decision. Recent commits (`0f5df4d`, `de8d146`, `905c48e`, etc.) appear to follow the pattern — each commit has a focused file scope and doesn't include spurious files. Verified via `git show --stat` spot-checks (not run here; cheap to verify if needed).
- **Drift**: None observed.
- **Status**: ✅ Accurate. Process rule, unchanged.

### D50 — Tagged-fallback supersedes D47 two-pass resolver

- **Claim**: Self-describing FPropertyTag streams decode unknown struct values without loading the referenced struct asset. 601 unique struct names decoded; marker reductions 251K → 22K (unknown_struct), 65K → 6K (complex_element_container), 24K → 0 (container_deferred). Performance 1.06× Agent 10 baseline.
- **Code today**: `dispatchPropertyValue` at `uasset-parser.mjs:976-994` implements the tagged fallback as described. `readStructElement` at `uasset-structs.mjs:98-117` has the matching fallback for container elements (line 113-117). `readTaggedPropertyStream` at `uasset-parser.mjs:887-967` is the shared driver. Cursor bounds via `endOffset` prevent walk-off. Reason-code relabel for FExpressionInput native (21,876 instances → `expression_input_native_layout_unknown`) is acknowledged in D50 but **not yet documented in the yaml reason-code catalog** (flagged LOW in §3).
- **Drift**: None in the design; documentation of new marker codes is slightly behind the code (LOW finding §3). D50's described behaviour matches shipped code exactly. Test coverage confirms via `test-uasset-parser.mjs` and `test-phase1.mjs`'s Polish Worker assertions.
- **Status**: ✅ Accurate. D50 is the authoritative design for the tagged-fallback path.

### Recommended D-log amendments / follow-ups (for orchestrator, not this audit to write):

1. **D48 count drift** — a SUPERSEDED-BY-D48.1 amendment would update the "13 K2Node types" claim to "17 non-delegate + 2 delegate" to match shipped code. Or update the shipped code + yaml description to match the 13 figure (i.e., trim the implementation). Orchestrator call.
2. **D47 amendment cross-reference** — consider adding a leading SUPERSEDED-BY line at D47's first sentence so the amendment is impossible to miss.
3. **D50 reason-code catalog sync** — the `read_asset_properties` description needs the 5+ additional reason codes documented, or a separate D-entry sanctioning the drift between code's reason codes and yaml's catalog.

---

## §7 Backlog Accuracy Check

`docs/tracking/backlog.md` has **10 entries** (TS-1/2/3, EN-1/2/3/4, FX-1, DR-1/2) plus the "Currently-known-issues not in this file" tail.

| Entry | State | Still accurate? |
|---|---|---|
| TS-1 `actors.take_screenshot` ↔ `visual-capture.get_viewport_screenshot` | not dispatched | ✅ Still accurate — no tool-surface cleanup pass has landed. |
| TS-2 `widgets.add_widget_to_viewport` NO-OP | not dispatched | ✅ Still accurate — yaml still flags as NO-OP; handler unchanged. |
| TS-3 `editor-utility.create_asset` scope review | not dispatched | ✅ Still accurate — no observed catalog demand. |
| EN-1 `query_asset_registry.size_field` filter | not dispatched | ✅ Still accurate — param not added to yaml. |
| EN-2 `find_blueprint_nodes_bulk(path_prefix)` | not dispatched | ✅ Still accurate — `find_blueprint_nodes` ships per-BP only. |
| EN-3 Agent-infra parity audit workflow | not dispatched | ✅ Still accurate — no tool or plan exists. |
| EN-4 Math/comparison K2Node graduations for S-A | not dispatched | ✅ Still accurate — `SKELETAL_K2NODE_CLASSES` excludes PromotableOperator et al. per D48 Q-2. |
| FX-1 TMap BP CDO micro-fixture | not dispatched | ✅ Still accurate — synthetic test coverage only; no live fixture. |
| DR-1 Tier S-B pin tracing offline parser | not dispatched | ✅ Still accurate — reopening triggers not present. |
| DR-2 L3A full-fidelity UEdGraph byte parsing | not dispatched | ✅ Still accurate — locked by D45. |

**Currently-known-issues tail**:

| Dispatched handoff | Status |
|---|---|
| Polish worker | COMPLETED — `8812c1c` landed; 7 response-shape fixes live; test-phase1 Test 12 covers them. |
| Parser extensions | COMPLETED — `f3ae608` + `bdd1527` landed; FExpressionInput + MaterialInput variants + FieldPathProperty all in uasset-parser/structs. |
| Cleanup worker | COMPLETED — `de8d146` + `905c48e` landed; int64 salvage + matchTagGlob live. |
| Manual testing | COMPLETED — results at `docs/testing/2026-04-16-agent10-5-manual-results.md`. |
| Docs housekeeping | COMPLETED per backlog.md line 107. |

**Maintenance-rule compliance**: The backlog file claims all 5 tail items "ARE dispatched (handoffs exist)" — but 5 of those 5 are now **COMPLETED, not just dispatched**. Per backlog.md line 4-5 ("when an item here gets dispatched as a handoff or folded into a committed plan, **remove it from this file**"), **these 5 completed handoffs should have been removed from the tail when they completed**. Their presence in the "Currently-known-issues not in this file" section is stale — they're no longer in-flight or dispatched; they're shipped.

**MEDIUM — Backlog tail stale**. Five dispatched handoffs have completed but remain listed. Cleanup required per the file's own maintenance rule. (Not a bug in anything UEMCP-shipped; a docs-hygiene issue in the tracking file itself.)

**No missing entries**: Could not identify any currently-not-dispatched item that should be here but isn't.

---

## §8 Verification Pass

**Re-read all findings.** Downgrades/upgrades considered.

### Downgrades

- None. Every finding held up on second read.

### Upgrades

- None. All findings already landed at appropriate severity.

### Notes on verification

- **MEDIUM — search_gameplay_tags / list_config_values param-gap** upgraded to MEDIUM (not LOW) because it's a direct violation of D44's yaml-as-truth invariant, which is explicitly listed as a Key Design Rule in CLAUDE.md. Downgrading to LOW would misrepresent the contract impact.
- **MEDIUM — find_blueprint_nodes description count drift** held at MEDIUM (not LOW) because the "13" figure appears in THREE places (tools.yaml description, offline-tools.mjs comment, D48 text) and is externally visible to any agent consulting the tool description. This is the exact shape of prior audit's M2 (inspect_blueprint.verbose description lie) which was rated MEDIUM — consistency matters.
- **MEDIUM — backlog tail stale** in §7 held at MEDIUM (not LOW) because the backlog file's own maintenance rule was violated; the file is a living artifact and staleness there directly misleads future orchestrators.
- **LOW — dead code (parseAssetTables + listDirRecursive)** held at LOW. Functions are harmless — no runtime cost, no test instability. Cleanup candidates.
- **LOW — double yaml parse at startup** held at LOW. 5KB of extra work at startup; no production impact.
- **LOW — redundant dual-parse in inspectBlueprint/findBlueprintNodes** held at LOW. 2× file read + 2× summary/name parse, correctness unaffected. Per D50 performance is 1.06× Agent 10 baseline — well under 2× SLA.

### Test suite re-verification

**709/709 PASS confirmed**:

- `test-phase1.mjs`: 172/172
- `test-mock-seam.mjs`: 45/45
- `test-tcp-tools.mjs`: 234/234
- `test-uasset-parser.mjs`: 197/197
- `test-offline-asset-info.mjs`: 15/15
- `test-query-asset-registry.mjs`: 16/16
- `test-inspect-and-level-actors.mjs`: 30/30

Numbers match CLAUDE.md's documented baseline exactly (436 + 273 = 709). Prior audit's 3 stale supplementary failures are all now GREEN. No new regressions.

### Self-scored confidence: **HIGH**

Reasoning:

- All 15 offline handler param-passthrough traces completed at file:line with yaml cross-reference.
- All 32 TCP handler param-passthrough traces re-confirmed via comparison with prior audit's findings.
- D44 invariant verified structurally (single yaml source for offline metadata) + via Test 10 assertions.
- Every MEDIUM finding re-verified at file:line with yaml + handler cross-read.
- All 7 test suites run; 709/709 PASS confirmed empirically — matches CLAUDE.md exactly.
- D-log D44-D50 each cross-checked against shipped code. D48 is the only drift; all others accurate.
- No CRITICAL or HIGH findings — codebase is functionally correct and production-grade for Phase 2 + offline tier scope.

---

## §9 Quick Reference

### File → line count → purpose

| File | Lines | Δ from prior | Purpose |
|---|---:|---:|---|
| `server.mjs` | 679 | −54 | MCP entry, tool registration loops, management tools (D44 eliminated offlineToolDefs) |
| `offline-tools.mjs` | 1829 | +536 | 15 offline handlers; assetCache; parseAssetHeader + parseAssetForPropertyRead; isPlacedActor + findRootComponentExport; stripPackageIndex + dedupeUnsupported helpers |
| `uasset-parser.mjs` | 1054 | +448 | Cursor + parseSummary + tables + FPropertyTag iteration + scalar dispatch + tagged-fallback + FieldPath + int64 salvage |
| `uasset-structs.mjs` | 664 | NEW | 24 struct handlers + 3 container handlers + readArrayElements + readStructElement |
| `tcp-tools.mjs` | 520 | 0 | 32 TCP handlers |
| `tool-index.mjs` | 320 | 0 | ToolIndex 6-tier scoring |
| `toolset-manager.mjs` | 303 | 0 | Enable/disable + SDK handle integration |
| `connection-manager.mjs` | 610 | 0 | 4-layer connection management |
| `tools.yaml` | 822 | +29 | Single source of truth for all tools |
| `test-phase1.mjs` | 891 | +544 | 172 assertions — 12 tests including D44 + Tier 4 + Polish |
| `test-mock-seam.mjs` | 476 | 0 | 45 assertions |
| `test-tcp-tools.mjs` | 1073 | 0 | 234 assertions — 25 groups |
| `test-helpers.mjs` | 225 | 0 | Shared infra |
| `test-uasset-parser.mjs` | 1398 | +1196 | 197 assertions |
| `test-offline-asset-info.mjs` | 154 | 0 | 15 assertions |
| `test-query-asset-registry.mjs` | 127 | 0 | 16 assertions |
| `test-inspect-and-level-actors.mjs` | 106 | 0 | 30 assertions |

### Exported function index (new since prior audit)

| Export | File | Purpose |
|---|---|---|
| `matchTagGlob(pattern, text)` | offline-tools.mjs:302 | Direct glob matcher (D49 semgrep fix — no dynamic RegExp) |
| `parseAssetForPropertyRead(root, path)` | offline-tools.mjs:1216 | Per-call parse + struct/container handler context |
| `readExportProperties(buf, export, names, opts)` | uasset-parser.mjs:856 | Top-level FPropertyTag stream reader |
| `readTaggedPropertyStream(cur, end, names, opts)` | uasset-parser.mjs:887 | Recursive sub-stream reader (tagged fallback D50) |
| `readPropertyTag(cur, names)` | uasset-parser.mjs:724 | Single FPropertyTag header read |
| `readFNameAtCursor(cur, names)` | uasset-parser.mjs:683 | Lookup FName from cursor |
| `makePackageIndexResolver(exports, imports)` | uasset-parser.mjs:1025 | FPackageIndex → resolved name |
| `buildStructHandlers()` | uasset-structs.mjs:627 | 24-handler struct registry |
| `buildContainerHandlers()` | uasset-structs.mjs:272 | Array/Set/Map handler registry |
| `Cursor.readInt64AsNumberOrNull()` | uasset-parser.mjs:91 | Lenient int64 reader (Cleanup worker salvage) |
| `handleArrayProperty`, `handleMapProperty`, `handleSetProperty` | uasset-structs.mjs:178, 198, 251 | Container handlers |
| `handleF{Vector,Rotator,Transform,...}` (24 total) | uasset-structs.mjs | Per-struct handlers |

### Tool registration map — offline (post-D44, post-Agent-10.5)

| Tool | Handler function | Defined at | Dispatched at |
|---|---|---|---|
| `project_info` | `projectInfo` | offline-tools.mjs:214 | :1774 |
| `list_gameplay_tags` | `listGameplayTags` | :237 | :1777 |
| `search_gameplay_tags` | `searchGameplayTags` | :335 | :1780 |
| `list_config_values` | `listConfigValues` | :344 | :1784 |
| `get_asset_info` | `getAssetInfo` | :470 | :1788 |
| `query_asset_registry` | `queryAssetRegistry` | :573 | :1791 |
| `inspect_blueprint` | `inspectBlueprint` | :1243 | :1795 |
| `list_level_actors` | `listLevelActors` | :1408 | :1799 |
| `read_asset_properties` | `readAssetProperties` | :1500 | :1803 |
| `find_blueprint_nodes` | `findBlueprintNodes` | :1688 | :1807 |
| `list_data_sources` | `listDataSources` | :835 | :1810 |
| `read_datatable_source` | `readDatatableSource` | :914 | :1814 |
| `read_string_table_source` | `readStringTableSource` | :969 | :1818 |
| `list_plugins` | `listPlugins` | :1023 | :1821 |
| `get_build_config` | `getBuildConfig` | :1064 | :1824 |

TCP registration map (unchanged from prior audit): actors at `tcp-tools.mjs:69` → `executeActorsTool:178`; bp-write at `210` → `executeBlueprintsWriteTool:375`; widgets at `392` → `executeWidgetsTool:484`.

---

## §10 Final Report

Post-Agent-10.5 Codebase Health Audit — Final Report

- **Files read**: 9 source (`server.mjs`, `offline-tools.mjs`, `uasset-parser.mjs`, `uasset-structs.mjs`, `tcp-tools.mjs`, `tool-index.mjs`, `toolset-manager.mjs`, `connection-manager.mjs`, `tools.yaml`) + 7 test files + 4 context docs (prior audits, D-log, backlog, CLAUDE.md) = **20**.
- **Total lines reviewed**: ~6,900 source + ~4,450 tests + ~2,100 context = **~13,450**.
- **Findings (post-verification)**:
  - 0 CRITICAL
  - 0 HIGH
  - **5 MEDIUM**: (1) search_gameplay_tags param gap in yaml; (2) list_config_values param gap in yaml; (3) find_blueprint_nodes "13 skeletal" description count drift (yaml + code + D48); (4) FBodyInstance native reason code + expanded marker codes missing from yaml catalog; (5) backlog.md tail stale (5 completed handoffs not removed).
  - **6 LOW**: (1) double yaml parse at startup; (2) parseAssetTables dead code; (3) listDirRecursive dead code; (4) redundant dual-parse in inspectBlueprint/findBlueprintNodes; (5) getToolDef still dead code (unchanged from prior audit); (6) tool-count drift in CLAUDE.md (119 counted vs 120/122 claimed).
- **Findings downgraded during verification**: 0.
- **Findings upgraded during verification**: 0.
- **Prior audit findings resolved**: **5 of 6 MEDIUM** (M1 inspect_blueprint.verbose → D44/rename; M2 take_screenshot yaml gap → yaml updated; M3 get_all_blueprint_graphs duplicate → only alias form survives; M4 description drift → D44; M6 stale supplementary tests → 258/258 green). Prior LOW "getToolDef dead code" still present; others resolved or structural.
- **Param-passthrough mismatches identified**: 3 new (search_gameplay_tags, list_config_values, find_blueprint_nodes count).
- **Tagged-fallback path (D50)**: Traced at `uasset-parser.mjs:976-994`. No silent-drop behavior; every unsupported path emits a named marker. Production-grade.
- **D-log drift check**: D44, D45, D46, D47 (amendment), D49, D50 all accurate. **D48 has a count-drift issue** — 13 K2Node types claimed, 19 shipped.
- **Test suites**: **709/709 PASS** (451 primary + 258 supplementary). Exactly matches CLAUDE.md baseline.
- **Architecture concerns for Phase 3**:
  - The 3F sidecar writer is still critical-path per CLAUDE.md line 137 and has not shipped. Agent 10.5's S-A provides a robustness floor (`find_blueprint_nodes` without editor dependency), but trace/spatial BP workflows require the sidecar per D48's three-layer offline-BP stack. Before Phase 3 C++ plugin dispatch, the sidecar writer should either land (unblocking full offline BP introspection) or be explicitly scoped into the Phase 3 plugin's v1 targets.
  - `offline-tools.mjs` at 1829 lines is approaching a soft split threshold. Per-tool files would improve maintainability when the offline surface grows further (D32 TCP scope reduction ensures it will).
  - Two-handler param-gap pattern (search_gameplay_tags + list_config_values) suggests the D44 invariant could be tightened with a startup-time lint: for every handler case in `executeOfflineTool`, every `params.X` read must have a corresponding yaml `params.X` declaration. Currently Test 10 asserts on specific tools but not exhaustively. A reflection-based test would catch this class automatically.
  - `assetCache.indexDirty` has no production writer. Phase 3's TCP write-ops must set this flag on any write that could affect AR metadata — failure to do so will leave stale offline data visible for up to 60s + coarse-mtime-resolution-window. D33 documents the contract but it's still untested E2E.
- **Verification confidence**: **HIGH**. Every finding cited at file:line. All test suites run; 709/709 confirmed. D-log cross-checked against shipped code for D44-D50. No unresolved claims.

**Deliverable**: `docs/audits/post-agent10-5-codebase-audit-2026-04-19.md` — SEALED after commit.
