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

Shipped: [yes/no]
Yaml entry added: [yes]
Handler registered: [yes]
Test assertions: [N new]
D44 invariant verified: [yes]

Performance (ProjectA corpus):
  BPs scanned: [N]
  Warm-cache time: [N ms]
  Cold-cache time: [N ms]

Workflow spot-check: "Which ProjectA BPs call StartMontage?"
  Result: [N BPs, example paths]

Tests: [X]/[Y] — delta vs [baseline]
Commits: [list with SHAs]
Time spent: [N min]
```
