# M-new Verb-surface Worker — 5 S-B-dependent traversal verbs

> **Dispatch**: Fresh Claude Code session. **S-B-base SHIPPED 2026-04-22** (commits `cdf951b` + `e35f431` + `3c355fe` + `9250121`, D70). Dispatch NOW. `extractBPEdgeTopologySafe()` exported from `offline-tools.mjs` is your caller surface.
> **Type**: Implementation — yaml tool definitions + offline-tools.mjs handlers + tests for 5 verbs that depend on S-B-base's pin-topology parser.
> **Duration**: 1-1.5 sessions (per D58 §Q5.3 sub-worker split).
> **D-log anchors**: D58 (re-sequence, Verb-surface post-S-B-base), D52 (edge-topology offline near-parity), D50 (tagged-fallback — reused via S-B-base). Reference Oracle-A fixtures README for shape contracts.
> **Deliverable**: 5 MCP tools shipping S-B-dependent graph-traversal verbs, wrapped with FA-β graceful-degradation via `withAssetExistenceCheck`, tested against Oracle-A fixture corpus.

---

## Mission

Ship the 5 verbs that depend on pin-topology parsing. S-B-base provides the data; you wire it to the MCP tool surface.

**The 5 verbs** (per research doc §Q3 + §Q5.3):
1. `bp_trace_exec` — walk outgoing exec (`then`, `else`, completed, etc.) pin chains from a source node; returns ordered node list.
2. `bp_trace_data` — walk outgoing data pins; returns node + pin pairs that receive data from the source.
3. `bp_neighbors` (edge mode) — immediate-neighbor graph query; "what nodes connect to this node via pins X/Y/Z."
4. `bp_show_node` (pin-block completion) — existing M-spatial `bp_show_node` extended with full pin+linked_to data (M-spatial shipped the spatial/metadata portion).
5. `bp_list_entry_points` (precision pass) — existing M-spatial `bp_list_entry_points` extended with "no-exec-in-pin" verification (M-spatial shipped the class-identity heuristic).

Under D58's "MCP-first, plugin-enhances" framing, these ship as offline-primary first-class tools, not plugin-gated.

---

## Scope — in

### §1 Prerequisites

Verify before doing anything else:

1. **S-B-base shipped (D70)** — `extractBPEdgeTopologySafe()` exported from `server/offline-tools.mjs`. Note `Safe` suffix: already wrapped with `withAssetExistenceCheck`.
2. **Oracle-A-v2 fixture corpus at `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/`** — 6 fixtures, all with pin_name fields per schema v2.
3. **Test baseline ~1034 passing** (914 + 120 S-B-base additions per D70). Verify via `npm test` before your first commit. **Also aware**: 7 pre-existing drift failures on test-phase1 (3) + test-uasset-parser (4) from Noah's BP_OSPlayerR/Player CDO re-saves changing property layouts. **Out of your D49 scope** — do NOT attempt to fix. Separate fixture-refresh worker candidate tracked in backlog.
4. **withAssetExistenceCheck** helper working in offline-tools.mjs (from EN-9). S-B-base already consumed it; you wrap M-new verbs the same way for consistency.

### Filled from S-B-base final report (D70)

**Exact caller surface**:
```js
import { extractBPEdgeTopologySafe } from './offline-tools.mjs';

// ENOENT: returns { available: false, reason: 'asset_not_found' } (FA-β).
// Present asset: returns
//   {
//     schema_version: 'sb-base-v1',
//     asset_path: '/Game/...',
//     graphs: { <graph_name>: { nodes: { <node_guid>: { class_name, pins: { <pin_id>: {direction, name, linked_to: [...]} } } } } },
//     stats: { edgesEmitted, danglingEdges }
//   }
// Oracle-A-v2 aligned — walk directly, no shape adapters needed.
```

**Critical S-B-base gotchas to honor** (from D70):
- **NodeGuids are NOT unique across graphs in one BP** — key lookups MUST use `(graph_name, node_guid, pin_id)` triples, never `node_guid` alone. Sibling UEdGraphs can share guids; lossy maps drop data silently. This bug in the worker's own test harness is what caused S-B-base's Session 1 "blocker" — don't repeat it in your verbs.
- **Self-loops are preserved** — a pin linking to itself is semantically valid; don't filter.
- **`bNullPtr` / `bOrphanedPin` pins are already dropped upstream** — parser handles it. You don't need to filter; just walk.
- **Name-fallback was architecturally present but unused** in S-B-base's harness — all 962/962 edges matched by pin_id alone. Name is available for fuzzy matches or cross-version compat if your verbs need it.

**K2Node coverage** (from D70): 15 format-verified classes (CallFunction, VariableGet, Knot, FunctionEntry, Event, IfThenElse, VariableSet, MacroInstance, CallParentFunction, SwitchEnum, CustomEvent, BreakStruct, AddComponent, PromotableOperator, ExecutionSequence) + EdGraphNode_Comment. Format-extrapolated (not exercised): Timeline, CreateDelegate, Composite, Tunnel, Return, InputAction. For verb scope, treat any `startsWith('K2Node_')` or `=== 'EdGraphNode_Comment'` class as walkable.

**Format-variance status**: no BP-subclass divergence (UWidgetBlueprint / UAnimBlueprint) yet tested — corpus is UBlueprint only. If your verbs run against UWidgetBlueprint fixtures and behavior differs, surface it.

### §2 Verb implementations

Each verb lives in `offline-tools.mjs`'s `executeOfflineTool` switch + a yaml entry in `tools.yaml`. Match the M-spatial verb pattern (already shipped) for consistency.

#### `bp_trace_exec`

**Intent**: "Starting at node X in graph Y, walk outgoing exec-type pins; return ordered list of nodes along that exec chain."

**Params** (yaml):
- `asset_path` (required) — BP asset path like `/Game/Blueprints/Character/BP_OSPlayerR`
- `graph_name` (required) — top-level graph key (e.g., `EventGraph`, `ExecuteAbility`)
- `start_node_id` (required) — 32-hex-no-dashes NodeGuid
- `max_depth` (optional, default 50) — cycle-safety cap
- `pin_name` (optional) — limit to specific exec pin (`then`, `else`, `completed`, etc.); if omitted, follows all exec-type outputs

**Output**: `{ chain: [{node_guid, class_name, via_pin}, ...] }` + standard FA-β envelope.

**Exec-pin classification**: an exec pin has `PinCategory = "exec"` in its PinType (S-B-base emits pin-type if available; if not, infer via name convention: `then`, `else`, `completed`, `exec`, `throw`, etc.).

#### `bp_trace_data`

**Intent**: "Starting at node X, walk outgoing data pins (non-exec); return sink nodes + the pins receiving data."

**Params**: same as `bp_trace_exec` but without `pin_name` filter; walks ALL non-exec output pins.

**Output**: `{ sinks: [{node_guid, class_name, source_pin, sink_pin, data_category}, ...] }`.

#### `bp_neighbors` (edge mode)

**Intent**: immediate-neighbor query. "Which nodes are directly linked to node X?"

**Params**:
- `asset_path` (required)
- `graph_name` (required)
- `node_id` (required)
- `direction` (optional) — `incoming` / `outgoing` / `both` (default `both`)

**Output**: `{ incoming: [...], outgoing: [...] }` with per-edge `{node_guid, class_name, local_pin, remote_pin}` entries.

M-spatial shipped `bp_neighbors` in spatial mode (positions); extend the existing tool with `mode: "edge"` param, OR ship as separate `bp_neighbors_edge` if mode-merging is messy. **[LATE-BINDING — decide based on M-spatial's existing schema after reading current offline-tools.mjs]**

#### `bp_show_node` (pin completion)

**Intent**: M-spatial shipped `bp_show_node` with class + position + comment_id + available-fields manifest. Extend the `available_fields` to include `pins` (list of pin records) when S-B-base has parsed the BP.

**Params**: unchanged from M-spatial's shipped surface.

**Output delta**: add `pins: [{pin_id, name, direction, linked_to: [...], pin_category}]` when available; populate `available_fields` and remove from `not_available[]`.

**FA-β forward-compat rule from D59**: do NOT rename `pin_block` or `exec_connectivity` tokens. Add `pins: []` as the extension point; M-spatial's tokens stay valid.

#### `bp_list_entry_points` (precision pass)

**Intent**: M-spatial shipped `bp_list_entry_points` with class-identity heuristic (K2Node_Event / K2Node_CustomEvent / K2Node_FunctionEntry). Extend with pin-precision check: a true entry point has NO incoming exec pins.

**Output delta**: add `has_no_exec_in: true/false` per entry; deprecate the heuristic-only mode (keep backward-compat by retaining the class-identity check but annotating each row with the pin-verified flag).

### §3 Test coverage

Create a **NEW** file `server/test-verb-surface.mjs` (matches S-B-base's `test-s-b-base-differential.mjs` precedent — dedicated suite per worker scope). **DO NOT edit `server/test-phase1.mjs`** — that file has 3 pre-existing drift failures being fixed in parallel by CL-1 worker; file-collision avoidance per D49.

Structure the new file to cover:

**Per-verb unit tests** (10-15 assertions per verb = ~50-75 new):
- Happy path against BP_OSPlayerR (dense, known-topology fixture).
- Empty-chain case (starting node with no outgoing exec — terminal node).
- Cycle case (if corpus has any self-loops per README §Edge cases #2).
- Graceful-degradation: bogus asset_path → `{available: false, reason: "asset_not_found"}`.
- Invalid start_node_id → `{available: false, reason: "node_not_found"}` or similar.

**Oracle-cross-check tests**: for each verb, verify output is consistent with Oracle-A's fixture JSON edge set (not a full differential like S-B-base, but a spot-check that the verb's walk traverses Oracle-defined edges correctly).

### §4 yaml updates

`tools.yaml` gets 5 new entries under the appropriate toolset (likely `blueprint-read`; confirm with `list_toolsets` + existing placement of M-spatial verbs). Each entry needs:
- `name`, `description`, `layer: offline`
- `params` block with types, required flags, descriptions
- `returns` block documenting FA-β envelope + success shape

Register in `server.mjs` following the offline-tool registration pattern: capture SDK handle, call `handle.disable()`, register with ToolsetManager.

### §5 withAssetExistenceCheck wrap

All 5 verbs wrap through EN-9's `withAssetExistenceCheck` helper at the handler edge. Pattern:

```js
const bpTraceExec = withAssetExistenceCheck(async (projectRoot, params) => {
  // handler body
});
```

Error contract: ENOENT → `{available: false, reason: "asset_not_found", asset_path}`. Everything else re-throws.

### §6 Test baseline + regression

- Test baseline per D70: **~1034 passing** (with 7 pre-existing drift failures out of scope).
- Verb-surface additions: estimate +50-75 assertions.
- Full rotation must stay green.
- D50 tagged-fallback + S-B-base pin parser + existing skeletal + M-spatial — zero regressions.

---

## Scope — out

- **S-B-overrides** (UE 5.6↔5.7 delta). Next sub-worker after S-B-base; Verb-surface must not touch version-skew logic.
- **v1.1 verbs** (`bp_paths_between`, cycle detection). D41-deferred.
- **Plugin code**. You touch zero files under `plugin/UEMCP/`.
- **Parser primitives** (`parsePinBlock`, `resolveLinkedToEdges`). S-B-base owns those; you call `extractBPEdgeTopologySafe()` only.
- **Oracle fixture regeneration**. Oracle-A / corpus changes are separate scope.
- **withAssetExistenceCheck modifications**. EN-9 shipped the helper; use as-is.

---

## Reference files

### Tier 1 — Scope sources
1. `docs/research/phase3-resequence-mcp-first-2026-04-20.md` §Q3 (5 verb contracts), §Q5.3 (Verb-surface sub-worker scope).
2. `docs/tracking/risks-and-decisions.md` D58, D59 (FA-β forward-compat rule for M-new).

### Tier 2 — S-B-base deliverables (post-landing)
3. `server/offline-tools.mjs` — where `extractBPEdgeTopologySafe()` is exported.
4. `server/uasset-parser.mjs` — parser primitives (context only; don't modify).
5. S-B-base worker's final report — for API signatures + gotchas.

### Tier 3 — M-spatial precedent (already shipped)
6. `server/offline-tools.mjs` — M-spatial handlers (`bp_list_graphs`, `bp_find_in_graph`, `bp_subgraph_in_comment`, `bp_list_entry_points` heuristic, `bp_show_node`). Match style + FA-β envelope pattern.
7. `server/test-phase1.mjs` — M-spatial test section shows assertion style.

### Tier 4 — Oracle-A contract
8. `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/README.md` — edge cases + output shape.
9. `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/*.oracle.json` — cross-check data.

### Tier 5 — Existing infrastructure
10. `tools.yaml` — single source of truth; add 5 entries (D44).
11. `server/server.mjs` — toolset registration pattern.

---

## Success criteria

1. 5 new MCP tools functional via `tools/list` after toolset activation.
2. Each verb passes happy-path + empty + graceful-ENOENT assertions.
3. Oracle-cross-check: verb output agrees with Oracle-A's fixture edges for at least 3 of the 6 fixtures (BP_OSPlayerR mandatory; BP_OSControlPoint recommended for density; one small fixture for fast iteration).
4. `withAssetExistenceCheck` wraps all 5 verbs.
5. Full test rotation green: baseline (S-B-base post-landing) + your ~50-75 additions.
6. `tools.yaml` entries complete with params, returns, descriptions.
7. TOOLSET_TIPS updated if cross-toolset workflows surface during dev.
8. D50 tagged-fallback + S-B-base parser untouched (path-limited to `offline-tools.mjs`, NEW `test-verb-surface.mjs`, `tools.yaml`, `server.mjs` for registration — explicitly NOT `test-phase1.mjs`).

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **Path-limited commits per D49** — scope: `server/offline-tools.mjs`, NEW `server/test-verb-surface.mjs`, `tools.yaml`, `server/server.mjs` (toolset registration). **Explicitly do NOT touch** `server/test-phase1.mjs` (CL-1 worker in flight there), `server/uasset-parser.mjs`, or any plugin file.
- **UNREAL_PROJECT_ROOT env var required** for fixture-exercising tests.
- **No AI attribution**.
- **Checkpoint commits OK** — per-verb or yaml-first-then-handlers can each land separately.
- **FA-β forward-compat**: do not rename existing tokens from M-spatial (`pin_block`, `exec_connectivity`, etc.); extend in place.

---

## Final report to orchestrator

Report (keep under 250 words):
1. Commit SHA(s).
2. 5 verbs shipped + tool names as they appear in `tools/list`.
3. Per-verb test count + any Oracle-cross-check fixture coverage gaps.
4. Test baseline delta: pre → post.
5. yaml deltas: new entries added, any TOOLSET_TIPS updates.
6. Any S-B-base output-shape surprises encountered (would indicate S-B-base final-report docs drift from reality).
7. Hint for S-B-overrides worker: whether any verb behavior differs across BP subclasses (UWidgetBlueprint EventGraph, UAnimBlueprint graphs) in ways that would motivate version-skew work.
8. Next action: M-enhance dispatchable once FA-ε verdict lands (parallel, no Verb-surface dependency).

If you hit a blocker (S-B-base output shape doesn't match handoff expectations, Oracle-cross-check fails unexpectedly, yaml toolset placement ambiguous), surface within the first session — this is a 1-1.5 session worker, don't burn past 1 session on a single unknown.
