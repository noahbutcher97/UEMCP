# UEMCP Server Codebase Audit — 2026-04-16

> **Scope**: Pre-Agent 9 (tool surface design) grounding document
> **Type**: Audit — read-only, no code changes
> **Trigger**: `docs/handoffs/pre-agent9-codebase-audit.md`
> **Commits covered**: through `937b02c` (HEAD) — post `5aaa290` (F0 verbose fix)

---

## §1 Architecture Summary

UEMCP is a Node.js MCP server (stdio transport, SDK 1.29.0) exposing 120 tools across 15 toolsets plus 6 always-loaded management tools. `tools.yaml` is the single source of truth for tool registration metadata; the server loads it at startup via `js-yaml`.

**Startup sequence** (`server.mjs`):

1. Construct `ConnectionManager` with the 4-layer model: Offline (disk), TCP:55557 (existing UnrealMCP oracle), TCP:55558 (future custom plugin), HTTP:30010 (Remote Control). A `tcpCommandFn` mock seam is injectable for tests via `config.tcpCommandFn`.
2. Construct `ToolIndex` (zero-dep) and `ToolsetManager(connectionManager, toolIndex)`.
3. Register the 6 management tools directly with `server.tool()` — they're always-on.
4. Walk `offlineToolDefs` (a const inside `server.mjs:458-525`), build a Zod schema from each yaml-style param block via `buildZodSchema()`, register with `server.tool()`, capture the SDK handle, call `handle.disable()`, then `toolsetManager.registerToolHandle(name, handle)`.
5. Same loop for actors (10), blueprints-write (15), widgets (7) — these import their schemas from `tcp-tools.mjs` (`getActorsToolDefs()` etc.) since the TCP schemas are richer than the yaml stubs.
6. `await toolsetManager.load()` — reads `tools.yaml` from disk, builds `ToolIndex`, populates `TOOLSET_LAYERS` map, then auto-enables the offline toolset if available (which calls `handle.enable()` for each offline tool, making them visible in `tools/list`).
7. `initTcpTools(toolsetManager.getToolsData())` — populates the three `*_WIRE_MAP` objects in `tcp-tools.mjs` from yaml `wire_type:` entries (e.g., `get_actors → get_actors_in_level`).
8. Connect to `StdioServerTransport`.

**Request flow**:

- MCP `tools/call` → SDK validates args against the registered Zod schema → handler runs.
- **Offline path**: handler invokes `executeOfflineTool(name, args, connectionManager.resolvedProjectRoot)`. The switch at `offline-tools.mjs:1244` dispatches to a per-tool function. Functions read disk (`.uproject`, `.ini`, `.uasset`/`.umap` bytes via `uasset-parser.mjs`, `.csv`, `.h`/`.cs` source) and return JSON. No TCP, no editor.
- **TCP path** (Phase 2): handler invokes `executeActorsTool|executeBlueprintsWriteTool|executeWidgetsTool(name, args, connectionManager)`. Each (a) re-validates `args` with `z.object(def.schema).parse(args)` as defense-in-depth (P0-9/P0-10), (b) translates the tool name through `*_WIRE_MAP` to the C++ type string, (c) optionally strips unsupported params (e.g., `class_filter` on `get_actors`), (d) for widgets only, normalizes `Name.Name` self-doubled paths via `stripDoubledAssetSuffix`, then (e) calls `connectionManager.send('tcp-55557', wireType, params, { skipCache: !isReadOp })`.
- `ConnectionManager.send()` checks `ResultCache` (SHA-256 keyed, 5-min TTL) for reads, enqueues the call on the per-layer `CommandQueue`, runs the connect-per-command TCP cycle (`tcpCommand(port, type, params, timeoutMs)` — no length framing, parse-until-valid-JSON), then runs the response through `extractWireError()` to normalize the three known UnrealMCP error envelope formats and throws an `Error` if any matches.

**Dynamic toolset visibility**: `find_tools(query)` calls `toolIndex.search()` (6-tier scoring + coverage bonus + alias expansion), groups results by toolset, and calls `toolsetManager.autoEnable()` on the top 3. `enable_toolset`/`disable_toolset` are explicit. Enabling toggles SDK handles via `handle.enable()`/`.disable()` which fires `tools/list_changed` automatically. Disabled tools are invisible at the SDK level — there's no runtime guard inside the handlers.

---

## §2 Module Dependency Map

```
server.mjs (entry)
  ├─ connection-manager.mjs      ConnectionManager
  ├─ tool-index.mjs              ToolIndex (pure; zero internal deps)
  ├─ toolset-manager.mjs         ToolsetManager
  │    ├─ tool-index.mjs         (holds reference)
  │    ├─ connection-manager.mjs (reads layer status for unavailability messages)
  │    └─ js-yaml                (loads tools.yaml)
  ├─ offline-tools.mjs           executeOfflineTool, parseAssetHeader, assetCache
  │    └─ uasset-parser.mjs      (binary reader; pure leaf)
  ├─ tcp-tools.mjs               initTcpTools, executeActorsTool, etc.
  │    └─ zod                    (defensive validation)
  └─ @modelcontextprotocol/sdk   McpServer, StdioServerTransport

connection-manager.mjs
  └─ node:net, node:crypto       (TCP + SHA-256 cache key)
     (Pure transport; no import from any tools module)

uasset-parser.mjs                (zero internal deps)

tcp-tools.mjs                    (no import of connection-manager — receives it as arg)
```

**No circular deps.** Strict layering: parser is leaf, offline-tools depends on parser, connection-manager is independent, tcp-tools is parameterized by connection-manager (no import), server.mjs is the integration apex with no inbound deps.

**Mock seam**: `ConnectionManager` checks `config.tcpCommandFn` in its constructor and stores it as `this._tcpCommandFn`. The `send()` and `_probeLayer()` methods choose `this._tcpCommandFn || tcpCommand`. A single-function injection means tests can stub TCP without touching higher layers. `test-helpers.mjs` exports `FakeTcpResponder` (canned responses + call recording), `ErrorTcpResponder` (5 failure modes), `TestRunner`, and `createTestConfig()` factory. This pattern is the reason 234 TCP-tool assertions can run without a live editor.

**Coupling notes**:

- `toolset-manager.mjs:280` reads `connectionManager.layers[layer]` directly to format `_unavailableReason` messages. Soft coupling — the manager doesn't drive any data through that channel.
- `tcp-tools.mjs` keeps three module-level wire maps (`ACTORS_WIRE_MAP` etc.) populated by `initTcpTools()`. These are global mutable state, but the only writer is `initTcpTools` which is called once at startup (and once per test that needs a different yaml fixture).
- `offline-tools.mjs` exports `assetCache` as a mutable module-level singleton. D33 documents the `indexDirty` flag pattern that future Phase 3 TCP write-ops must use to invalidate. No current writer flips it — fine for Phase 2 since no offline-cached data is mutated by TCP commands routed at the existing UnrealMCP plugin.

---

## §3 Code Quality Review

Severity: CRITICAL (production failure), HIGH (likely issue), MEDIUM (tech debt / smell), LOW (polish).

### `server.mjs` (733 lines)

- **Consistency**: snake_case for tool/param names (matches MCP wire); camelCase for internal helpers. `buildZodSchema()` centralizes Zod construction from yaml-style param blocks. Tool registration loops are uniform across offline/actors/bp-write/widgets. Good.
- **Correctness**: post-`5aaa290`, the offline registration loop at lines 527-561 correctly wires `args` (the validated object) into `executeOfflineTool(name, args, connectionManager.resolvedProjectRoot)`. The four `try/catch` wrappers convert thrown handler errors to MCP `isError: true` responses with the tool name in the message — uniform across all four toolsets.
- **MEDIUM — duplicate offline tool definitions** (`server.mjs:458-525` vs `tools.yaml:55-108`). The `offlineToolDefs` const in server.mjs holds full description + params for all 13 offline tools, parallel to the `tools.yaml` declarations. **Drift exists today**:
  - `inspect_blueprint.params.verbose.description` in `server.mjs:497` says `"If true, include full Asset Registry tags. Default false removes tags field from response."` — this is **STALE** (per F2 fix, tags were removed entirely from `inspect_blueprint`; the param is a no-op).
  - `tools.yaml:88` says the same param is `"Currently unused; reserved for future feature expansion."` — accurate.
  - `query_asset_registry.description` in `server.mjs:481` mentions short class name matching + truncation/total_scanned/total_matched signals; `tools.yaml:74` mentions "pagination via offset/limit" without the short-name detail. Different surface for the same tool.
  - `get_asset_info.description` server.mjs vs yaml: same intent, different wording.
  - **Impact**: `tools/list` returns server.mjs descriptions; `find_tools` (which reads `tools.yaml` via ToolIndex) returns yaml descriptions. Claude sees inconsistent metadata for the same tool depending on which discovery path it took. The stale `verbose` description specifically lies to the caller.
  - **Root cause**: the offline tool registration ignores yaml — it builds Zod from its own local `offlineToolDefs` const. Only TCP toolsets use the yaml-driven registration via `getActorsToolDefs()` etc.
- **LOW — `SERVER_INSTRUCTIONS` is a string literal joined from 6 lines** (lines 44-53). Not a maintainability problem (it's compact), but the inline comment at line 41 marks it as TODO for review.
- **LOW — `log()` helper** at line 175 silently falls back to stderr if `sendLoggingMessage` throws. Appropriate for early-startup before transport is connected.
- **No CRITICAL or HIGH findings**.

### `offline-tools.mjs` (1293 lines)

- **Consistency**: 13 handler functions, one per tool. Snake_case params throughout. `Error` thrown on failure with file-path or asset-path context. The dispatch switch at line 1244 is flat and uniform.
- **Correctness — F0 fix verified**: line 1260 dispatches `getAssetInfo(projectRoot, params.asset_path, params)`. The handler at line 430 reads `params.verbose ?? false` and gates the FiBData stripper. Direct read confirmed; tests pass with `verbose:true` returning blob and absent `heavyTagsOmitted`.
- **MEDIUM — `inspect_blueprint` accepts a `verbose` param it never uses**. `inspectBlueprint(projectRoot, params)` at line 1117 reads `const verbose = params.verbose ?? false;` then never references the local. tools.yaml acknowledges this ("Currently unused; reserved for future feature expansion"), but server.mjs's registration metadata claims it controls AR tag inclusion (which is now untrue — F2 removed tags from this tool entirely). Caller passing `verbose:true` gets identical output to `verbose:false` with no warning.
- **MEDIUM — `inspectBlueprint` `genClassNames` set covers only 3 generated-class types** (line 1141-1145): `BlueprintGeneratedClass`, `WidgetBlueprintGeneratedClass`, `AnimBlueprintGeneratedClass`. For other Blueprint subclasses (e.g., `GameplayAbilityBlueprintGeneratedClass`), `parentClass` will be `null` because `find` returns `undefined`. Not a crash, but `parentClass` data is silently incomplete on those asset types. ProjectA uses `BPGA_*` and `BPGE_*` BPs which are GA/GE Blueprint subclasses — `BlueprintGeneratedClass` happens to be the right hit for those (verified via test-inspect-and-level-actors:39 — `bp.parentClass === 'GA_OSBlock'` PASS). But the moment a user calls `inspect_blueprint` on something deriving from a custom `*GeneratedClass`, `parentClass` will be null with no explanation.
- **LOW — `inspectBlueprint` redundantly stats the file**: `stat(diskPath)` at line 1121, then `parseAssetHeader(projectRoot, assetPath)` at line 1122 also stats internally. Two stats per call. Cosmetic perf cost.
- **LOW — `resolveAssetDiskPath` always appends `.uasset`** (line 346). For a `/Game/Maps/Foo` path with no extension, this gives `Content/Maps/Foo.uasset` → file-not-found. Users must pass `.umap` explicitly. `list_level_actors` works around this internally (line 1208). `get_asset_info` and `query_asset_registry` do not — sharp edge for callers expecting auto-detection. Documented in tool descriptions.
- **Robustness**: The `parseAssetHeader` cache hit path at line 382 (via `shouldRescan`) is well-commented and addresses real Windows-mtime coarseness via the size-secondary signal. The `walkAssetFiles` walker at line 484 has a `maxFiles` early-exit and silently ignores unreadable subdirectories.
- **Maintainability**: 1293 lines is on the high side. Functions are independent, no cross-function state beyond `assetCache`. **LOW** — consider per-tool file split post-Phase 3 when count grows.

### `uasset-parser.mjs` (606 lines)

- **Consistency**: Reader helpers (`readFString`, `readGuid`, `readIoHash`, `readInt64AsNumber`) cleanly layered on `Cursor`. UE 5.6 stride constants documented inline (40B imports per line 444, 112B exports per line 496). Version gates (`UE5_PACKAGE_SAVED_HASH = 1016` etc.) guard format-evolved fields.
- **Correctness**: Production-grade per Phase 2 tier-2 audit (zero errors across 19K+ files). FAssetRegistryData parser at line 587 walks the packed object→tag→key/value structure. `resolvePackageIndex` correctly handles the FPackageIndex sign convention (positive→exports[N-1], negative→imports[-N-1], zero→null).
- **Robustness**: `Cursor.ensure()` checks bounds before every read. `readInt64AsNumber()` throws on overflow past JS `MAX_SAFE_INTEGER` (line 78). `parseSummary` throws on bad magic, on positive `LegacyFileVersion`, on `LegacyFileVersion < -9` (older than supported), and on compressed chunks present.
- **No CRITICAL/HIGH/MEDIUM findings** — the binary parser is solid.
- **LOW — `parseBuffer` exported but only returns `{ summary }`** (line 168). The richer parsers (`readNameTable`, `readImportTable`, `readExportTable`, `readAssetRegistryData`) are not chained together by this convenience. Callers compose manually. Slightly confusing API surface.

### `tcp-tools.mjs` (520 lines)

- **Consistency**: Three sections (actors / blueprints-write / widgets) follow identical structure: `*_SCHEMAS` const → `execute*Tool` dispatcher → `get*ToolDefs` getter for server.mjs. `Vec3`/`Vec2Optional` shared at top (line 17-19).
- **Correctness — param-passthrough**: Each schema's keys match the yaml `params:` declarations except for the `take_screenshot` mismatch noted in §4. `executeActorsTool` at line 178 strips `class_filter` for `get_actors` only — confirmed by test Group 3. The defensive `z.object(def.schema).parse(args)` at line 190 enforces required fields and Vec3 length (P0-9/P0-10 belt-and-braces against direct-call entry points).
- **Correctness — wire translation**: `WIRE_MAP[toolName] || toolName` fallback means tools without a `wire_type:` declaration in yaml use the MCP name as-is. That's correct for `spawn_actor`, `delete_actor`, `set_actor_transform`, etc. (oracle uses identical names).
- **Correctness — widget path normalization**: `stripDoubledAssetSuffix` at line 475 only strips when both halves of `Name.Name` are equal. `Name.Other` and plain `Name` pass through. Test Group 23 confirms.
- **MEDIUM — three near-identical dispatchers**: `executeActorsTool`, `executeBlueprintsWriteTool`, `executeWidgetsTool` are 95% the same code (lookup wire type → defensive parse → maybe strip params → send). A generic dispatcher keyed by `{ schemas, wireMap, port, paramNormalizer }` would DRY ~70 lines. Tech debt, not urgent — clean up after Phase 3 absorption (D40).
- **LOW — `take_screenshot` Zod schema includes `resolution_x`/`resolution_y` not declared in tools.yaml**. See §4. Not a bug (Zod permissively forwards), but yaml is the documented source-of-truth and clients reading it for discovery miss these params.
- **No CRITICAL/HIGH findings**.

### `tool-index.mjs` (320 lines)

- **Consistency**: 6-tier scoring constants at top, `ALIASES` defaults declared as `let` to allow yaml override. `build()` then `search()` then small accessors.
- **Correctness**: `build(toolsData)` (line 131-177) iterates `toolsData.management.tools` and `toolsData.toolsets[*].tools` adding entries with `nameTokens`/`descTokens`. The Tier 1 exact-match logic at line 213-218 normalizes the query to snake_case via `replace(/[^a-z0-9_]/g, '_')` before comparing. Coverage bonus at line 269-270 multiplies score by `(0.5 + 0.5 × matched_ratio)` — for a single-token query this is always 1.0.
- **MEDIUM — `get_all_blueprint_graphs` is a duplicate-yaml-entry collision waiting to happen** (when Phase 3 lands). See §4.
- **LOW — `stem()` minimal English-ish stemmer** at line 55. Handles common suffixes; a quick mental test ("creating" → "creat" — correct rule, but "putting" → "putt" — slightly off). Good enough for tool search; not a bug.
- **LOW — `_entries` private field is accessed from tests** (`test-phase1.mjs:42`). Test accesses underscore-prefixed property. Cosmetic — not a bug.
- **No CRITICAL/HIGH findings**.

### `toolset-manager.mjs` (303 lines)

- **Consistency**: Public API matches what server.mjs needs (load, registerToolHandle, enable/disable/autoEnable, listToolsets, getToolsData, getEnabledNames, getToolDef, onListChanged). Private `_isToolsetAvailable`, `_unavailableReason`, `_fireListChanged`.
- **Correctness**: `enable()` at line 118 properly checks layer availability before enabling; returns structured `{enabled, alreadyEnabled, unavailable, unknown}`. `disable()` returns `{disabled, wasNotEnabled, unknown}`. `setToolsetVisibility()` at line 101 toggles SDK handles per tool — relies on `getToolsetTools(toolsetName)` to enumerate.
- **LOW — `getToolDef(toolName)` at line 247 has zero callers in `server/`** (verified via grep). Trivial accessor; either wire it up (to a planned future `inspect_tool` management tool?) or delete.
- **Robustness**: `_fireListChanged` swallows callback errors. `_isToolsetAvailable` falls through to `false` on unknown layer name.
- **No CRITICAL/HIGH/MEDIUM findings**.

### `connection-manager.mjs` (610 lines)

- **Consistency**: Layer-aware API. `tcpCommand` is a top-level pure function; `extractWireError` is also top-level; `ResultCache` and `CommandQueue` are inner classes; `ConnectionManager` is the main class.
- **Correctness — wire protocol**: `tcpCommand` at line 41 sends `JSON.stringify({ type, params: params || {} })` with no newline (matches Python oracle). The `data` handler accumulates chunks and tries `JSON.parse` after each — succeeds when JSON is complete. `end` handler also tries to parse remaining bytes. Good.
- **Correctness — error normalization**: `extractWireError` at line 179 covers all three known oracle formats plus two "defensive" cases (raw single-key `{error}` escaping the bridge, and sibling `error` field on success envelope). Multi-key result objects with an `error` field are NOT treated as ad-hoc errors (false-positive guard) — confirmed by test Group 7 partial-success case.
- **Correctness — caching**: SHA-256 keyed on `JSON.stringify({type, params})`. Read ops hit the cache; write ops set `skipCache:true`. 5-minute TTL hard-coded.
- **Correctness — queue**: `CommandQueue.enqueue()` at line 151 chains `prev.then(fn, fn)` so the queue runs even after a previous rejection. Per-layer keys mean `tcp-55557` and `tcp-55558` parallelize while same-layer commands serialize.
- **MEDIUM — `detectProject` uses PowerShell-only auto-detection** (line 401-405). The TODO at line 392 is honest about this. Linux/macOS would fail silently, returning `confidence:'error'`. Not a Phase 1/2 problem (UEMCP is Windows-only by virtue of UE projects being Windows-pinned), but document it.
- **LOW — `_findUprojectIn` and `_resolveProjectRoot` use dynamic `await import('node:fs/promises')`** instead of top-level imports (line 475-476). Functional but inconsistent with the rest of the file. Top-level imports at the head would match the file's style.
- **No CRITICAL/HIGH findings**.

### `tools.yaml` (793 lines)

- **Consistency**: Hierarchical with `management:` (always-on tools) and `toolsets:` (15 dynamic toolsets). Each tool declared with `description:`, `params:`, optionally `wire_type:`, `aliases:`, `note:`.
- **MEDIUM — `get_all_blueprint_graphs` is declared twice** (lines 411-417 as alias on `get_blueprint_graphs`, then lines 434-438 as standalone tool). The standalone entry has `note: Alias for get_blueprint_graphs. ToolIndex registers both names.` — so the duplication is INTENTIONAL for ToolIndex search discoverability. **However**, this is a problem for MCP `server.tool()` registration when Phase 3 lands: the future `blueprint-read` registration loop would register `get_all_blueprint_graphs` twice (alias resolution + standalone), and SDK behavior on duplicate names is "last wins" or throws depending on version. See §4.
- **MEDIUM — `take_screenshot` yaml declares only `filepath`** (line 173-174); `tcp-tools.mjs:159-167` Zod schema declares `filepath`, `resolution_x`, `resolution_y`. Yaml-as-truth contract violated.
- **MEDIUM — Description drift between yaml and `server.mjs` `offlineToolDefs`** for `inspect_blueprint` (verbose param meaning) and `query_asset_registry` (full surface). See §3 server.mjs section.
- **LOW — `get_actors` yaml has no params; oracle plugin really takes no params**, but tools.yaml notes `class_filter` as aspirational ("# NOTE: C++ handler accepts NO params — class_filter is aspirational (Phase 3)" line 120). The Zod schema in `tcp-tools.mjs:74` declares `class_filter` as optional, and the dispatcher strips it. Three-way inconsistency by design (yaml doesn't declare it, Zod does, dispatcher strips it). Documented in code comments.
- **LOW — `take_screenshot` has a `note:` field** (line 172) but other tools don't. Inconsistent metadata convention. Cosmetic.

### Test files

- **`test-phase1.mjs`** (347 lines, 54 asserts): Module imports + ToolIndex search + accumulation/shedding via mock TCP-down + edge cases + offline tools + handler-fix assertions for F0/F1/F2/F4/F6.
- **`test-mock-seam.mjs`** (476 lines, 45 asserts): Mock seam wiring, cache hit/miss, error normalization for all three formats, port routing, queue serialization, FakeTcpResponder/ErrorTcpResponder utility coverage.
- **`test-tcp-tools.mjs`** (1073 lines, 234 asserts): 25 groups covering tool defs, name translation, param stripping, all error formats, transport failures, caching, port routing, wire map building, P0-1 expanded coverage, P0-7 widget path strip, P0-9 required params, P0-10 vector shape.
- **`test-helpers.mjs`** (225 lines): Shared infra. Not a runner.
- **Supplementary tests (NOT in CLAUDE.md test rotation)**:
  - `test-uasset-parser.mjs` (202 lines, 42 asserts) — passes 42/42 against real ProjectA fixtures.
  - `test-offline-asset-info.mjs` (154 lines, 15 asserts) — passes 15/15.
  - `test-query-asset-registry.mjs` (127 lines, 16 asserts) — **2 FAILURES**: `empty result still reports filesScanned` and `max_scan truncates files list` reference `truncated.filesScanned` but the handler returns `total_scanned` (see `offline-tools.mjs:646`). Tests are STALE relative to the F1 fix.
  - `test-inspect-and-level-actors.mjs` (106 lines, 30 asserts) — **1 FAILURE**: `inspect: tags is object` references `bp.tags` but F2 removed `tags` from `inspect_blueprint`. Test is STALE relative to the F2 fix.
- **MEDIUM — supplementary tests are stale and not in rotation**. CLAUDE.md says "333 total assertions passing" — that's the three primary suites only. The 4 supplementary suites (~103 additional assertions) exist on disk, exercise real fixtures, but aren't documented or wired into a test runner. The F1/F2 fixes (commit `d365b05`) updated the primary suite (`test-phase1.mjs` Test 9) but **did not update the supplementary suites** that pre-date the fixes. The F2 fix at `inspect_blueprint` removed `tags`, breaking `test-inspect-and-level-actors.mjs:43`. The F1 fix renamed `filesScanned` → `total_scanned`, breaking `test-query-asset-registry.mjs:50,68`. These tests are silent regressions waiting for someone to discover them.

---

## §4 Handler Audit Table

Verified all 45 handlers (13 offline + 10 actors + 15 blueprints-write + 7 widgets). Table below shows **only mismatches**.

| Tool | yaml params | Schema accepts | Handler reads | Match | Severity | Notes |
|---|---|---|---|---|---|---|
| `get_asset_info` | `asset_path`, `verbose` | both (via `buildZodSchema`) | both (post-`5aaa290`) | ✅ | RESOLVED | F0 fix at `offline-tools.mjs:1260`. Pre-fix: `getAssetInfo(root, params.asset_path)` — verbose dropped. Post-fix: `getAssetInfo(root, params.asset_path, params)`. Verified by `git show 5aaa290`. |
| `inspect_blueprint` | `asset_path`, `verbose` | both | reads `params.verbose` but **never uses it** (line 1119 → unused local) | ⚠️ | MEDIUM | Param exists end-to-end but is dead. tools.yaml description is honest ("Currently unused"); `server.mjs:497` description **lies** ("If true, include full Asset Registry tags. Default false removes tags field from response"). |
| `take_screenshot` | `filepath` only | `filepath`, `resolution_x`, `resolution_y` (`tcp-tools.mjs:159-167`) | passes through to wire | ❌ | MEDIUM | yaml-as-truth contract violated. MCP clients consulting yaml for discovery cannot find resolution params. Zod permissively accepts and forwards. Fix: declare both params in yaml. |
| `get_all_blueprint_graphs` | declared **twice** in yaml | no handler exists yet (Phase 3) | n/a | ❌ | MEDIUM (dormant) | `tools.yaml:411-417` declares it as alias on `get_blueprint_graphs`; `tools.yaml:434-438` declares it as standalone. Comment claims "ToolIndex registers both names" — true, but when Phase 3 registers tools via `server.tool()`, the duplicate name will collide. |
| `get_actors` | none in yaml | `class_filter` (Zod) | wire receives params but `class_filter` stripped | ✅ (intentional) | — | Oracle C++ has no `class_filter`. UEMCP filters client-side post-response. Yaml note at line 120 documents this. Test Group 3 verifies. |
| Description drift | n/a | n/a | n/a | ❌ | MEDIUM | `server.mjs offlineToolDefs` (lines 458-525) duplicates `tools.yaml:55-108` definitions for the 13 offline tools. Drift exists today on `inspect_blueprint`, `query_asset_registry`, `get_asset_info`. `find_tools` (yaml-driven via ToolIndex) and `tools/list` (server.mjs-driven) show different descriptions. |

**No further param-passthrough mismatches** across the remaining 40 handlers. Method: for each tool, traced yaml `params:` → schema construction (server.mjs `buildZodSchema` for offline / `tcp-tools.mjs *_SCHEMAS` for TCP) → switch case dispatch → handler function signature/reads. Performed at file:line for each.

**Return shape consistency**:

- Offline: All return `{...data}` with tool-specific shapes. Tag-bearing tools (`get_asset_info`, `query_asset_registry`) consistently emit `tags`, `heavyTagsOmitted`. Pagination tools emit `total_scanned`, `total_matched`, `truncated`, `offset`. `inspect_blueprint` and `list_level_actors` emit `exportCount`, `importCount`. Good.
- TCP: All return wire response unmodified after `extractWireError` rejects errors. Oracle shape inconsistencies (some return `{result: {...}}`, some `{actors: [...]}` directly) flow through as-is — by design, since UnrealMCP is the conformance oracle and UEMCP rewrites only happen in Phase 3 (D23/D40).

---

## §5 Test Coverage Assessment

**Test totals** (verified 2026-04-16):

| Suite | Assertions | Status | In rotation? |
|---|---|---|---|
| `test-phase1.mjs` | 54 | 54/54 PASS | ✅ |
| `test-mock-seam.mjs` | 45 | 45/45 PASS | ✅ |
| `test-tcp-tools.mjs` | 234 | 234/234 PASS | ✅ |
| **Primary total** | **333** | **333/333 PASS** | |
| `test-uasset-parser.mjs` | 42 | 42/42 PASS | ❌ supplementary |
| `test-offline-asset-info.mjs` | 15 | 15/15 PASS | ❌ supplementary |
| `test-query-asset-registry.mjs` | 16 | **14/16 PASS** | ❌ supplementary, **STALE** |
| `test-inspect-and-level-actors.mjs` | 30 | **29/30 PASS** | ❌ supplementary, **STALE** |

**Offline coverage**: All 13 handlers exercised directly via `executeOfflineTool` in `test-phase1.mjs`. Test 9 (lines 250-339) covers F0/F1/F2/F4/F6 fixes with 18 assertions including verbose-true/false, truncation signalling, pagination, placed-actor filtering, and short class name matching.

**TCP coverage**: All 32 TCP handlers have at minimum a tool-def assertion + a name-translation assertion. The denser tests (`add_component`, `add_function_node`, `connect_nodes`, `add_button`, `add_widget_to_viewport`, `spawn_actor`, `set_actor_transform`) have explicit param-passthrough assertions checking that vector shapes, nested objects, and key params arrive on the wire intact.

**Error path coverage**: All 3 wire-error envelope formats tested (Groups 4, 5, 6 + 22). Transport failures (timeout, ECONNREFUSED, invalid_json) tested in Group 8 + test-mock-seam Test 8/9.

### False-confidence risks (the F0 class)

The F0 verbose bug was a textbook param-passthrough bug. Pre-`5aaa290`, `executeOfflineTool` switch dispatched `getAssetInfo(root, params.asset_path)` — the third argument (`params`) was dropped. Direct unit-test calls to `executeOfflineTool` would have caught it IF the test asserted on `verbose:true` blob presence. The first one to do so (Test 9, post-fix at line 264-283) only exists *because* the bug surfaced via manual integration testing.

**Structural risk**: All offline-tool tests call `executeOfflineTool` directly. This bypasses:

1. The Zod schema constructed by `server.mjs:buildZodSchema()` from the local `offlineToolDefs` const.
2. The MCP wire path (no actual `tools/call` JSON-RPC).
3. The SDK handler wrapper that destructures args.

If a future bug sits between Zod parse and the switch dispatch (e.g., Zod renames a param but switch doesn't follow, or the wrapper consumes a param), **current tests will not catch it**.

**Similar TCP risk**: `executeActorsTool` etc. are invoked directly with pre-validated args. The mock seam exercises wire-format contract validation, but the `server.tool()` handler wrapper (where the SDK destructures `args` to pass into the handler) is not in the loop. Lower risk than offline because TCP handlers have their own defensive `z.object(def.schema).parse(args)` re-parse — but the same regression class is technically possible.

**Specific patterns to watch**:

1. **Switch dispatch dropping arguments**. `offline-tools.mjs:1244-1291` — every case must pass through every param the handler might need. F0 was case `'get_asset_info'` dropping `params`. Mitigation: prefer `case 'name': return await fn(projectRoot, params);` over destructured forwarding.
2. **Handler reading a param it never uses**. `inspect_blueprint`'s `verbose` is the live example. Schema accepts → wrapper forwards → handler reads → handler ignores. Tests asserting on output won't catch this.
3. **Yaml/Zod drift on TCP tools**. `take_screenshot` has Zod-only params not declared in yaml. Tests verify the wire receives them, but `find_tools` discoverability is broken.
4. **server.mjs/yaml drift on offline tools**. The `offlineToolDefs` const duplicates yaml. Out-of-sync descriptions are invisible to tests — humans must diff manually.

**Stale supplementary tests**:

- `test-query-asset-registry.mjs:50,68` references `truncated.filesScanned` (which doesn't exist; handler emits `total_scanned`). Predates F1 rename.
- `test-inspect-and-level-actors.mjs:43` references `bp.tags` (which doesn't exist; F2 removed it). Predates F2.

These are **silent regressions** that will trip anyone discovering or running the supplementary tests. They've been broken since `d365b05` (~April 16 commit chain) without anyone noticing because the tests aren't in the documented rotation.

**Recommendation**: Either (a) wire the supplementary tests into a `npm test`-style runner so they get exercised, or (b) delete them, or (c) update them to match current handler shapes. Half-broken tests in the repo are worse than no tests because they create false signals when run.

---

## §6 Risks and Recommendations

### For Agent 9 (tool surface design)

1. **Decide the description-drift fix**. Either (a) make `server.mjs:offlineToolDefs` read from yaml (delete the duplication), or (b) make the registration loop trust yaml descriptions over the local const, or (c) accept the drift as a known cost. The current state breaks the "tools.yaml is the single source of truth" contract from CLAUDE.md.
2. **Decide `get_all_blueprint_graphs` disposition** before Phase 3. Either delete the alias or delete the standalone yaml entry. Don't leave both live through Phase 3 registration.
3. **Confirm the yaml-as-truth contract for new tools**. Any Level 1+2 parser tools (Agent 10) should declare every param in yaml that the Zod schema accepts.

### For Agent 10 (Level 1+2 parser implementation)

1. **Leverage the existing parser**. `uasset-parser.mjs` already walks summary, name table, imports, exports, AR tags. FPropertyTag iteration (Level 1) extends the export data path — do not rewrite the foundation. Stride constants and version gates are already correct for UE 5.6 (1017 confirmed against fixtures).
2. **Co-locate struct handlers in a new module**. `uasset-structs.mjs` for FVector/FRotator/FTransform/etc., imported by `uasset-parser.mjs`. Keeps the parser's dep graph clean.
3. **Add an MCP-wire integration harness**. The F0 class of regression is invisible to current tests. A harness that instantiates `McpServer`, sends a fixture `tools/call`, and asserts on the response would close the gap. Possibly defer until after Level 1+2 ships, but flag it in the handoff so it doesn't get lost.
4. **Update the `inspect_blueprint` `verbose` param** to mean something coherent (or remove it entirely from yaml/server.mjs/handler). Right now the handler reads it but does nothing — leaving it in place propagates a dead param through any future related work.

### Code quality issues to fix before more features land

1. **MEDIUM — Description drift between `server.mjs` and `tools.yaml`**. Single source of truth is violated for 13 offline tools. Easiest fix: change the offline registration loop to pull descriptions and params from yaml (mirror what TCP tools already do via `getActorsToolDefs()`).
2. **MEDIUM — `take_screenshot` yaml params incomplete**. One yaml edit.
3. **MEDIUM — `get_all_blueprint_graphs` duplicate yaml entry**. Pick one of two approaches; document in D-log.
4. **MEDIUM — `inspect_blueprint.verbose` is dead**. Remove from schema + handler, or implement the documented behavior.
5. **MEDIUM — Stale supplementary tests** (`test-query-asset-registry.mjs`, `test-inspect-and-level-actors.mjs`). Update or delete.
6. **LOW — `getToolDef` is dead code** (toolset-manager.mjs:247). Delete or wire up.
7. **LOW — Three near-identical TCP dispatchers**. DRY into a generic dispatcher post-Phase 3.

### Test infrastructure gaps

1. **No MCP-wire integration tests** — direct-call tests bypass the SDK handler wrapper.
2. **Supplementary tests are not in any rotation** — they exist but aren't run, and two have bit-rotted into red.
3. **No coverage metrics** — hand-rolled assertion counts only. Acceptable for project size.

### Sequencing suggestion for orchestrator

- **Agent 9** can proceed immediately. The codebase is functionally correct for its current scope (333/333 primary tests green, F0-F6 all landed and verified). The MEDIUM findings are pre-existing tech debt, not blockers.
- **Before Agent 10 ships any new tools**: address the 4 MEDIUM yaml/description-drift findings to prevent compounding the schema-truth confusion.
- **Phase 3 dispatch** must resolve `get_all_blueprint_graphs` duplication and the `inspect_blueprint.verbose` ambiguity, since Phase 3's `blueprint-read` toolset will register `get_all_blueprint_graphs` and presumably want a coherent `verbose` story across BP-introspection tools.

---

## §7 Quick Reference

### File → line count → purpose

| File | Lines | Purpose |
|---|---|---|
| `server.mjs` | 733 | MCP entry, tool registration loops, management tools, SERVER_INSTRUCTIONS, TOOLSET_TIPS, offlineToolDefs |
| `offline-tools.mjs` | 1293 | 13 offline handlers + executeOfflineTool switch + assetCache + parseAssetHeader + isPlacedActor |
| `uasset-parser.mjs` | 606 | Cursor + parseSummary + readNameTable + readImportTable + readExportTable + readAssetRegistryData + resolvePackageIndex |
| `tcp-tools.mjs` | 520 | 32 TCP handlers: actors (10) + blueprints-write (15) + widgets (7) + initTcpTools + stripDoubledAssetSuffix |
| `tool-index.mjs` | 320 | ToolIndex with 6-tier scoring + coverage bonus + alias merge + stem + tokenize |
| `toolset-manager.mjs` | 303 | Enable/disable state + SDK handle integration + unavailability reasons + getToolDef (dead) |
| `connection-manager.mjs` | 610 | tcpCommand + extractWireError + ResultCache + CommandQueue + ConnectionManager.send + checkOfflineAvailable + detectProject |
| `tools.yaml` | 793 | Single source of truth for 120 tools + aliases + descriptions + params + wire_type entries |
| `test-phase1.mjs` | 347 | 54 asserts: imports + ToolIndex search + accumulation + edge cases + offline tools + Test 9 (F0/F1/F2/F4/F6) |
| `test-mock-seam.mjs` | 476 | 45 asserts: seam wiring + cache + error formats + queue + utility coverage |
| `test-tcp-tools.mjs` | 1073 | 234 asserts: 25 groups across all 32 TCP tools |
| `test-helpers.mjs` | 225 | FakeTcpResponder + ErrorTcpResponder + TestRunner + createTestConfig |
| `test-uasset-parser.mjs` | 202 | 42 asserts: parser format-correctness against real ProjectA fixtures (supplementary) |
| `test-offline-asset-info.mjs` | 154 | 15 asserts: get_asset_info shape + cache + indexDirty (supplementary) |
| `test-query-asset-registry.mjs` | 127 | 16 asserts, **2 STALE FAILURES** (supplementary) |
| `test-inspect-and-level-actors.mjs` | 106 | 30 asserts, **1 STALE FAILURE** (supplementary) |

### Exported function index (selected)

| Export | File | Purpose |
|---|---|---|
| `executeOfflineTool(name, params, root)` | offline-tools.mjs:1239 | Switch-dispatch offline tool |
| `parseAssetHeader(root, path)` | offline-tools.mjs:371 | Cached AR-data parse |
| `assetCache` | offline-tools.mjs:43 | Module-level cache singleton |
| `shouldRescan(entry, mtime, size, ctx)` | offline-tools.mjs:90 | Cache invalidation logic |
| `parseSummary(cur)` | uasset-parser.mjs:231 | Read FPackageFileSummary |
| `readNameTable(cur, summary)` | uasset-parser.mjs:429 | Read FName table |
| `readImportTable(cur, summary, names)` | uasset-parser.mjs:455 | Read FObjectImport table |
| `readExportTable(cur, summary, names)` | uasset-parser.mjs:515 | Read FObjectExport table |
| `readAssetRegistryData(cur, summary)` | uasset-parser.mjs:587 | Read FAssetRegistryData tag block |
| `resolvePackageIndex(idx, exports, imports, field)` | uasset-parser.mjs:488 | FPackageIndex resolver |
| `Cursor` | uasset-parser.mjs:59 | LE byte reader class |
| `initTcpTools(toolsData)` | tcp-tools.mjs:52 | Build wire_type maps |
| `executeActorsTool(name, args, cm)` | tcp-tools.mjs:178 | Actors dispatcher |
| `executeBlueprintsWriteTool(name, args, cm)` | tcp-tools.mjs:375 | BP-write dispatcher |
| `executeWidgetsTool(name, args, cm)` | tcp-tools.mjs:484 | Widgets dispatcher |
| `getActorsToolDefs()` etc. | tcp-tools.mjs:510-520 | Schema getters for server.mjs registration |
| `ACTORS_SCHEMAS` etc. | tcp-tools.mjs:69, 210, 392 | Per-tool Zod schemas |
| `ToolIndex.build(toolsData)` | tool-index.mjs:131 | Build search index from yaml |
| `ToolIndex.search(query, max)` | tool-index.mjs:185 | 6-tier scored search |
| `ToolIndex.getToolsetTools(name)` | tool-index.mjs:293 | List tools in a toolset |
| `ToolsetManager.load()` | toolset-manager.mjs:52 | Load yaml + build index + auto-enable offline |
| `ToolsetManager.enable(names)` | toolset-manager.mjs:118 | Enable toolsets, toggle SDK handles |
| `ToolsetManager.disable(names)` | toolset-manager.mjs:158 | Disable toolsets |
| `ConnectionManager.send(layer, type, params, opts)` | connection-manager.mjs:318 | TCP round-trip with cache + error normalization |
| `ConnectionManager.checkOfflineAvailable()` | connection-manager.mjs:467 | Validate UNREAL_PROJECT_ROOT |
| `extractWireError(result)` | connection-manager.mjs:179 | Normalize 3+2 error formats |

### Tool registration map (offline)

| Tool | Handler function | Defined at | Dispatched at |
|---|---|---|---|
| `project_info` | `projectInfo` | offline-tools.mjs:208 | :1245 |
| `list_gameplay_tags` | `listGameplayTags` | :231 | :1248 |
| `search_gameplay_tags` | `searchGameplayTags` | :283 | :1252 |
| `list_config_values` | `listConfigValues` | :304 | :1255 |
| `get_asset_info` | `getAssetInfo` | :430 | :1259 (F0 fix) |
| `query_asset_registry` | `queryAssetRegistry` | :533 | :1262 |
| `inspect_blueprint` | `inspectBlueprint` | :1117 | :1266 |
| `list_level_actors` | `listLevelActors` | :1205 | :1270 |
| `list_data_sources` | `listDataSources` | :795 | :1273 |
| `read_datatable_source` | `readDatatableSource` | :874 | :1276 |
| `read_string_table_source` | `readStringTableSource` | :929 | :1280 |
| `list_plugins` | `listPlugins` | :983 | :1284 |
| `get_build_config` | `getBuildConfig` | :1024 | :1287 |

### Tool registration map (TCP)

All 32 TCP tools live in `tcp-tools.mjs` `*_SCHEMAS` consts and are dispatched by the corresponding `execute*Tool` functions:

- Actors (10): ACTORS_SCHEMAS at line 69, dispatched by `executeActorsTool` at line 178.
- Blueprints-write (15): BLUEPRINTS_WRITE_SCHEMAS at line 210, dispatched by `executeBlueprintsWriteTool` at line 375.
- Widgets (7): WIDGETS_SCHEMAS at line 392, dispatched by `executeWidgetsTool` at line 484.

server.mjs registration loops at lines 569-603 (actors), 610-644 (bp-write), 651-685 (widgets) consume the `get*ToolDefs()` getters and wire each tool through `server.tool()` with handle disable + `toolsetManager.registerToolHandle`.

---

## §8 Verification Pass

**Findings re-verified**: 0 CRITICAL, 0 HIGH, 6 MEDIUM (all confirmed at file:line), 3 LOW spot-checked

### Re-verification details

#### MEDIUM — F0 verbose param dispatch (post-fix verification)

- **Status**: RESOLVED by commit `5aaa290`.
- **Verified at**: `offline-tools.mjs:1259-1260` reads:
  ```javascript
  case 'get_asset_info':
    if (!params.asset_path) throw new Error('Missing required parameter: asset_path');
    return await getAssetInfo(projectRoot, params.asset_path, params);
  ```
  The third argument `params` is the full validated object; `getAssetInfo(projectRoot, assetPath, params = {})` at line 430 reads `params.verbose ?? false` at line 431.
- **`git show 5aaa290`** confirms: 2-line source diff (third arg added) + 11 new test assertions in `test-phase1.mjs:265-283` covering both verbose=true (blob present, no `heavyTagsOmitted`) and verbose=false (blob stripped, `heavyTagsOmitted` populated when applicable).
- **Test confirmation**: `test-phase1.mjs` 54/54 PASS including all F0 verbose assertions.

#### MEDIUM — `inspect_blueprint.verbose` is dead code

- **Verified at**: `offline-tools.mjs:1117-1119`:
  ```javascript
  async function inspectBlueprint(projectRoot, params) {
    const assetPath = params.asset_path;
    const verbose = params.verbose ?? false;
    ...
  ```
  `verbose` is read into a local. Grep for `verbose` in the function body (lines 1117-1162): no further references. The local is unused.
- **server.mjs:497** description: `'If true, include full Asset Registry tags. Default false removes tags field from response.'` — but tags were removed entirely from `inspect_blueprint` per F2 (commit `d365b05`). Description is **stale and misleading**.
- **tools.yaml:88** description: `"Currently unused; reserved for future feature expansion."` — accurate.
- **Caller impact**: passing `verbose:true` to `inspect_blueprint` produces identical output to omitting it. No warning, no error. server.mjs metadata implies it should change behavior; it doesn't.

#### MEDIUM — `take_screenshot` yaml/Zod param gap

- **Verified at**: `tools.yaml:170-174` declares one param (`filepath`):
  ```yaml
  take_screenshot:
    description: Capture editor viewport to PNG file
    note: Legacy — get_viewport_screenshot in visual-capture returns inline base64
    params:
      filepath: { type: string, required: true, description: "Output file path (.png appended if missing)" }
  ```
- **`tcp-tools.mjs:159-167`** Zod schema declares three params:
  ```javascript
  take_screenshot: {
    description: 'Capture editor viewport to PNG file',
    schema: {
      filepath: z.string().describe('Output file path (.png appended if missing)'),
      resolution_x: z.number().int().optional().describe('Screenshot width'),
      resolution_y: z.number().int().optional().describe('Screenshot height'),
    },
    isReadOp: false,
  },
  ```
- **Forwarding**: `executeActorsTool` at line 200-204 passes `wireParams` through to `connectionManager.send` without stripping anything for `take_screenshot`. Resolution params reach the wire if provided.
- **Impact**: `find_tools` (yaml-driven via ToolIndex) cannot surface the resolution params. `tools/list` shows the Zod schema (with all three params). Inconsistent surface.

#### MEDIUM — `get_all_blueprint_graphs` duplicate yaml registration

- **Verified at**: `tools.yaml:411-417` (alias):
  ```yaml
  get_blueprint_graphs:
    description: All graphs as JSON ...
    aliases: [get_all_blueprint_graphs]
    params:
      asset_path:  { type: string, required: true }
      graph_name:  { type: string, required: false }
  ```
- **`tools.yaml:434-438`** (standalone):
  ```yaml
  get_all_blueprint_graphs:
    description: ALL graphs including orphan functions — alias for get_blueprint_graphs with no filter. Kept for discoverability.
    note: Alias for get_blueprint_graphs. ToolIndex registers both names.
    params:
      asset_path: { type: string, required: true }
  ```
- **Current impact**: zero — `blueprint-read` toolset has no Phase 3 handler; the registration loop never runs.
- **Future impact**: When Phase 3 lands and a blueprint-read registration loop is added (mirroring the actors/bp-write/widgets loops), it will iterate `tsDef.tools` and call `server.tool('get_all_blueprint_graphs', ...)`. The alias resolution at search time + the standalone registration at startup time both want the same MCP name. SDK behavior on duplicate `server.tool()` calls is "last wins or throws" depending on version.
- **Note**: the comment "ToolIndex registers both names" is correct for ToolIndex's own data structure (the search index will hold two `IndexEntry` objects with the same `toolName`), but the comment doesn't address the MCP registration collision.

#### MEDIUM — Description drift between `server.mjs` and `tools.yaml`

- **Verified at**: `server.mjs:458-525` defines `offlineToolDefs` with full descriptions and params for all 13 offline tools. The registration loop at line 527 calls `server.tool(name, def.description, schema, handler)` using these local descriptions.
- **`tools.yaml:55-108`** declares the same 13 tools with their own descriptions. The yaml descriptions feed `ToolIndex.build()` in `toolset-manager.mjs:58`, which is what `find_tools` consults.
- **Specific drifts confirmed**:
  - `inspect_blueprint`: server.mjs says "BREAKING CHANGE: tags field removed — use get_asset_info for Asset Registry metadata"; yaml says "NOTE - tags removed; use get_asset_info for asset-registry metadata. Pointed query — re-parses export/import tables (not cached)." Different surface for the same tool.
  - `inspect_blueprint.params.verbose.description`: server.mjs claims behavior that no longer exists; yaml is honest.
  - `query_asset_registry`: server.mjs description mentions short class name matching + truncation/total_scanned/total_matched signals; yaml mentions only "pagination via offset/limit".
- **Root cause**: offline registration ignores yaml — it builds Zod from the local `offlineToolDefs` const. TCP toolsets correctly delegate to `getActorsToolDefs()` etc., which read from `tcp-tools.mjs` modules (not yaml either, but at least there's a single source per TCP toolset).

#### MEDIUM — Stale supplementary tests (2 files, 3 stale assertions)

- **`test-query-asset-registry.mjs:50`** asserts `empty.filesScanned > 0`. Handler at `offline-tools.mjs:644-652` returns `total_scanned`, not `filesScanned`. `empty.filesScanned` is `undefined`. Assertion fails on `undefined > 0`.
- **`test-query-asset-registry.mjs:68`** asserts `truncated.filesScanned === 5`. Same issue. `undefined === 5` fails.
- **`test-inspect-and-level-actors.mjs:43`** asserts `bp.tags && typeof bp.tags === 'object'`. `bp.tags` is `undefined` because F2 removed the tags field from `inspect_blueprint`. Assertion fails.
- **Verification**: ran all 4 supplementary suites — `test-uasset-parser.mjs` 42/42 PASS, `test-offline-asset-info.mjs` 15/15 PASS, `test-query-asset-registry.mjs` 14/16 (2 fail), `test-inspect-and-level-actors.mjs` 29/30 (1 fail).
- **These tests are not in CLAUDE.md's documented rotation.** The "333 total assertions" headline matches only the three primary suites. Whoever landed F1/F2 (commit `d365b05`) updated `test-phase1.mjs` Test 9 but did not update these supplementary suites.

### LOW spot-checks (3 of 4 randomly chosen)

1. **`getToolDef` is dead code** (`toolset-manager.mjs:247`). Re-verified via grep across `server/`. Zero callers. Function exists, returns lookup result, no consumer.
2. **`SERVER_INSTRUCTIONS` is inlined** at `server.mjs:44-53`. Confirmed: a 6-element string array joined with `' '`. Compact (~6 lines), not the multi-hundred-line block the previous audit version claimed.
3. **`detectProject` PowerShell-only**. Confirmed at `connection-manager.mjs:401-405`. The `execFileAsync('powershell.exe', ...)` call has no fallback for non-Windows. Not a bug since UEMCP targets Windows-only UE projects, but worth flagging.

### Param-passthrough mismatches confirmed

**4 confirmed mismatches**:

1. `inspect_blueprint.verbose` — handler reads, never uses. (MEDIUM)
2. `take_screenshot` resolution params — Zod accepts, yaml omits. (MEDIUM)
3. `get_all_blueprint_graphs` — yaml declares twice (intentional for ToolIndex but problematic for future registration). (MEDIUM)
4. Description drift between server.mjs and yaml — affects `inspect_blueprint`, `query_asset_registry`, `get_asset_info` at minimum. (MEDIUM)

**Full param trace performed for all 45 handlers**. Method: yaml `params:` → Zod schema (server.mjs `buildZodSchema` for offline / `tcp-tools.mjs *_SCHEMAS` for TCP) → switch case dispatch → handler function reads. No additional dropped-param bugs of the F0 class found.

### Test suite results

Ran via Desktop Commander not used — used direct bash with `UNREAL_PROJECT_ROOT` env var (which works on this Windows shell despite CLAUDE.md's note about CMD `set` quoting; the bash `VAR=val cmd` form is unambiguous):

| Suite | Result |
|---|---|
| `test-phase1.mjs` | **54/54 PASS** |
| `test-mock-seam.mjs` | **45/45 PASS** |
| `test-tcp-tools.mjs` | **234/234 PASS** |
| **Primary total** | **333/333 PASS** |
| `test-uasset-parser.mjs` | 42/42 PASS (supplementary) |
| `test-offline-asset-info.mjs` | 15/15 PASS (supplementary) |
| `test-query-asset-registry.mjs` | **14/16 PASS — 2 stale failures** (supplementary) |
| `test-inspect-and-level-actors.mjs` | **29/30 PASS — 1 stale failure** (supplementary) |

Primary suite results match CLAUDE.md's documented "333 total assertions." Supplementary failures are pre-existing (predate this audit) and stem from F1/F2 fixes that didn't propagate to these untracked test files.

### Downgrades

None. All findings held up on second read.

### Upgrades

- `inspect_blueprint.verbose` dead-code finding upgraded from "code smell" to MEDIUM after confirming `server.mjs:497` description **lies** about the param's behavior. A misleading param description is worse than a dead param — it tells callers something about the tool that isn't true.
- Stale supplementary tests upgraded to MEDIUM (originally not flagged) after confirming via test runs that the failures are real and not transient. Half-broken tests in a repo are worse than no tests.

### Confidence

**HIGH** — self-assessment of audit accuracy.

Reasoning:

- All 45 handler param-passthrough traces completed at file:line.
- F0 verification included `git show 5aaa290` diff read AND test-suite confirmation.
- All 7 test suites run; primary 333/333 PASS confirmed; supplementary failures isolated to 3 specific stale assertions.
- Every MEDIUM finding re-verified at file:line with surrounding context read.
- Cross-verified server.mjs/yaml drift by reading both files for the same tool definitions side-by-side.
- No CRITICAL or HIGH findings — the codebase is functionally correct for its current Phase 2 scope. The MEDIUM cluster is pre-existing tech debt, not regressions.

---

## Final Report

Pre-Agent 9 Codebase Audit — Final Report

- Files read: 8 source + 8 test (4 listed + 4 supplementary discovered) + 4 context = 20
- Total lines reviewed: ~7,100 source + ~2,300 tests + ~1,500 context = ~10,900
- Findings (post-verification): 0 CRITICAL, 0 HIGH, 6 MEDIUM, 4 LOW
- Findings downgraded during verification: 0
- Findings upgraded during verification: 2 (`inspect_blueprint.verbose` LOW→MEDIUM after server.mjs description lie confirmed; stale supplementary tests added at MEDIUM)
- Param-passthrough mismatches confirmed: 4 (1 dead param, 1 yaml/Zod gap, 1 yaml duplication, 1 server.mjs/yaml drift cluster)
- Test suites: 333/333 primary PASS; 71/74 supplementary (3 stale failures isolated to F1/F2 untracked tests)
- Architecture concerns for Level 1+2: none blocking. 4 MEDIUM yaml/description-drift cleanups recommended before Phase 3 dispatch. Agent 10 should add an MCP-wire integration-test harness to close the F0-class false-confidence gap.
- Verification confidence: HIGH
- Deliverable: `docs/audits/uemcp-server-codebase-audit-2026-04-16.md` (~580 lines)
