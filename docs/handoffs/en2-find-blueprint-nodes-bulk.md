# EN-2 Worker — `find_blueprint_nodes_bulk(path_prefix)`

> **Dispatch**: AFTER Pre-Phase-3 Fixes Worker lands (shares offline-tools.mjs + tools.yaml file scope).
> **Type**: Implementation — new offline tool. Corpus-wide variant of `find_blueprint_nodes`.
> **Duration**: 1-2 sessions (~2-3 hr).
> **D-log drive**: D52 (near-plugin-parity for offline reads).

---

## Mission

Ship `find_blueprint_nodes_bulk` — a corpus-wide variant of `find_blueprint_nodes` that scans all BPs under a path prefix, runs the filter per-BP, returns aggregated per-BP match counts.

Closes Workflow Catalog SERVED_PARTIAL rows 26/27/28/42/62/63 — the 6 queries where today's single-BP tool forces client-side N-round-trip iteration.

### Example workflow unlocked

"Which ProjectA BPs call `ApplyGameplayEffectToTarget` anywhere?" — today a ~30-minute manual iteration; post-EN-2 a single tool call.

---

## Scope

Tool signature (yaml-declared; D44 invariant):

```yaml
find_blueprint_nodes_bulk:
  description: >
    Corpus-wide scan for K2Nodes across all Blueprints under a path_prefix.
    Returns aggregated per-BP match counts + per-BP node details. Filters by
    node_class, member_name, target_class. Use for "which BPs call X" /
    "which BPs handle event Y" / "where is variable Z accessed across the
    project" workflows. Single-BP variant: find_blueprint_nodes.
  params:
    path_prefix:    { type: string, required: true,  description: "/Game/... path prefix to scan" }
    node_class:     { type: string, required: false, description: "Filter: K2Node class (e.g., K2Node_CallFunction)" }
    member_name:    { type: string, required: false, description: "Filter: FMemberReference.MemberName exact match" }
    target_class:   { type: string, required: false, description: "Filter: MemberParent class path (suffix match supported)" }
    limit:          { type: number, required: false, description: "Max BPs in response (default 50, cap 200)" }
    offset:         { type: number, required: false, description: "Pagination offset (default 0)" }
    max_scan:       { type: number, required: false, description: "Max BPs walked (default 500, cap 5000)" }
    include_nodes:  { type: boolean, required: false, description: "When true, include per-BP node details. When false (default), return counts only." }
```

Response shape:
```
{
  path_prefix, filter: {node_class, member_name, target_class},
  total_bps_scanned, total_bps_matched, truncated,
  results: [
    {
      path,           // /Game/.../BP_Foo
      match_count,
      nodes: [...]    // only when include_nodes=true
    }
  ],
  offset, limit
}
```

---

## Implementation approach

1. **Reuse `find_blueprint_nodes` handler internally.** Bulk tool walks the asset registry (`queryAssetRegistry` with `class_name: Blueprint, path_prefix`), invokes the single-BP handler per result, aggregates.
2. **Cache awareness**: use the existing `assetCache` from `offline-tools.mjs` for per-BP parsing; the cache absorbs repeat scans cheaply.
3. **Performance budget**: bulk scan over 500 BPs should complete in <5s warm cache. Benchmark against ProjectA's BP corpus (query_asset_registry `class_name:Blueprint` returns ~300-500 BPs in ProjectA).
4. **Default pagination**: conservative — `limit: 50`, `max_scan: 500`. Higher caps require explicit opt-in.
5. **include_nodes: false default** keeps the common "how many BPs match?" case small. Callers asking "which specific nodes in which BPs" opt into the larger payload.

---

## File scope

| File | Action |
|---|---|
| `tools.yaml` | Add `find_blueprint_nodes_bulk` entry under `offline.tools` |
| `server/offline-tools.mjs` | Add `findBlueprintNodesBulk` handler; register in switch |
| `server/server.mjs` | Auto-registers via yaml loop per D44 — no code change needed here |
| `server/test-phase1.mjs` | New Test block (~10-15 assertions) covering bulk scan behavior |

**Do NOT touch**: `uasset-parser.mjs`, `uasset-structs.mjs`, `tcp-tools.mjs`, `plugin/`, `docs/tracking/`.

---

## Constraints

- **Path-limited commits per D49.**
- Desktop Commander for git (shell: "cmd").
- D44 invariant: tools/list ↔ find_tools ↔ yaml must show identical description. Add a Test 12-style assertion.
- Tests must stay green (783 baseline post-MCP-Wire-Harness + whatever F-1.5 adds; verify actual count via `node test-phase1.mjs` + run all 7 suites).
- Performance budget: <5s warm-cache scan over ProjectA's BP corpus.
- No AI attribution.

---

## Final report

```
EN-2 Worker Final Report — find_blueprint_nodes_bulk

Shipped: yes
Yaml entry added: yes (tools.yaml:162 — new find_blueprint_nodes_bulk block)
Handler registered: yes (offline-tools.mjs:1770 findBlueprintNodesBulk + switch case)
Test assertions: +42 new (36 test-phase1 Test 13 + 6 test-mcp-wire Tests 2/5)
D44 invariant verified: yes (yaml-level in Test 13 + runtime in test-mcp-wire Test 2)

Shape deviation from handoff spec (advisor-approved):
  Handoff specced a single `truncated: bool`. Ship split it into
  `scan_truncated` (matched-BP set incomplete — widen max_scan or
  narrow path_prefix) + `page_truncated` (more BPs matched than
  this page — advance offset). Reason: callers couldn't otherwise
  distinguish "widen scan" from "paginate forward." Yaml description
  documents both flags.

Semantic correction on max_scan:
  Handoff advertised "Max BPs walked (default 500, cap 5000)" but
  the pass-through to queryAssetRegistry.max_scan walks FILES, not
  Blueprints. With ProjectA's ~2.5% BP density, max_scan=5000
  surfaced only ~130 BPs — far short of the 469-BP corpus the same
  handoff benchmarked against. Fix (advisor Option B): walk full
  prefix subtree at the registry layer (limit=2000, max_scan=20000
  internally), cap BP count at max_scan post-filter. max_scan now
  means what the parameter name says. Test 13 has an assertion
  (max_scan=2 → total_bps_scanned=2) locking the contract.

Performance (ProjectA 469-BP corpus):
  BPs scanned (full /Game/, default max_scan=500): 469 (scan_truncated=false)
  Warm-cache time: 1133ms
  Cold-cache time: 12887ms
  (handoff budget: <5s warm — met. Cold-cache time reflects disk I/O
  on 469 .uasset files; not budgeted by the handoff.)

  Narrow /Game/Blueprints/Character (8 BPs):
    Cold: 3ms   Warm: 2ms

Workflow spot-check: "Which ProjectA BPs call ReceiveBeginPlay?"
  (StartMontage, handoff's example, has 0 callers in ProjectA — not
  a stable fixture. ReceiveBeginPlay is a more representative
  corpus-wide query.)
  Result: 304 of 469 BPs matched in a single call.
  Sample matched paths:
    /Game/Blueprints/Character/BP_OSPlayerR.uasset (match_count=2)
    /Game/Blueprints/Character/BP_OSPlayerR_Child.uasset (match_count=2)
    /Game/Blueprints/Character/BP_OSPlayerR_Child1.uasset (match_count=2)
    /Game/Blueprints/Character/BP_OSPlayerR_Child2.uasset (match_count=2)
    /Game/Blueprints/Character/BP_OSTestPlayer.uasset (match_count=1)

Tests: 825/825 passing — delta +42 vs 783 baseline.
  test-phase1.mjs:             188 → 224 (+36)
  test-mock-seam.mjs:           45 → 45
  test-tcp-tools.mjs:          234 → 234
  test-mcp-wire.mjs:            58 → 64 (+6)
  test-uasset-parser.mjs:      197 → 197
  test-offline-asset-info.mjs:  15 → 15
  test-query-asset-registry.mjs:16 → 16
  test-inspect-and-level-actors.mjs: 30 → 30

Commits (path-limited per D49):
  125a62c — EN-2: find_blueprint_nodes_bulk — corpus-wide K2Node scan
             (tools.yaml, server/offline-tools.mjs, server/test-phase1.mjs,
              server/test-mcp-wire.mjs)
  53daaed — Sync test baseline 783 -> 825 after EN-2 Worker (CLAUDE.md)
  <pending> — EN-2 final report fill-in (docs/handoffs/en2-find-blueprint-nodes-bulk.md)

Non-blocking lurking edge case:
  queryAssetRegistry's internal limit=2000 caps the matched-BP set
  before max_scan slicing sees it. If a future project has >2000
  BPs under one prefix, scan_truncated fires correctly (via
  registry.truncated) but total_bps_scanned will report 2000 even
  if the caller requested max_scan=5000. ProjectA at 469 BPs never
  hits it. Not fixed; documented here for future reference.

Time spent: ~60 min.
```
