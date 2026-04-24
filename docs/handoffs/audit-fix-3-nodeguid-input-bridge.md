# AUDIT-FIX-3 Worker — NodeGuid format bridge at Verb-surface input (F-2+F-21)

> **Dispatch**: Fresh Claude Code session. Parallel-safe with AUDIT-FIX-1 (plugin/UEMCP/*) + AUDIT-FIX-2 (server/rc-tools.mjs + tools.yaml); this worker is `server/offline-tools.mjs` + `server/test-verb-surface.mjs` only.
> **Type**: Implementation — apply `toOracleHexGuid` normalization at the INPUT side of Verb-surface handlers, mirroring D72's output-side bridge.
> **Duration**: 0.5 session.
> **D-log anchors**: D79 audit findings F-2 + F-21, D72 (Verb-surface NodeGuid format mismatch OUTPUT bridge — this worker completes the bridge on INPUT), D70 (S-B-base (graph_name, node_guid, pin_id) triple-keying invariant).
> **Deliverable**: Verb-surface handlers accept BOTH M-spatial LE-lowercase NodeGuid hex + S-B-base BE-uppercase-per-uint32 NodeGuid hex as input; composition of `bp_list_entry_points → bp_trace_exec` stops silently returning `node_not_found`.

---

## Mission

Audit F-2: D72 bridged NodeGuid format mismatch on OUTPUT emission (worker added `toOracleHexGuid` helper at handler edges so verbs emit S-B-base/Oracle-A-v2-aligned format). But INPUT side was missed — agents piping `bp_list_entry_points` output into `bp_trace_exec start_node_id:<guid>` pass M-spatial LE-lowercase format; Verb-surface handlers expect BE-uppercase-per-uint32 S-B-base format; lookup fails silently (`node_not_found`).

Test harness seeds node_ids from Oracle JSON directly, so automation never exercises this path. Agent composition breaks at runtime invisibly.

F-21 audit flag (related): fallback paths in some handlers violate D70 (graph_name, node_guid, pin_id) triple-keying — scope likely overlaps with the input bridge work.

---

## Scope — in

### §1 Read audit §F-2 and §F-21
Authoritative: `docs/audits/phase3-post-m-enhance-audit-2026-04-24.md`. Identify which specific handlers need input-side normalization + which fallback paths violate triple-keying.

Expected affected handlers (verify against audit):
- `bp_trace_exec` — accepts `start_node_id`
- `bp_trace_data` — accepts `start_node_id` (same shape)
- `bp_neighbors` — accepts `node_id`
- `bp_show_node` — accepts `node_id`
- `bp_subgraph_in_comment` — accepts `comment_node_id` (M-spatial territory; probably fine but verify)

### §2 Apply input normalization

Pattern:
```js
function normalizeNodeGuid(input) {
  // Accept both formats; emit canonical BE-uppercase-per-uint32 form.
  // If input is 32-hex (regardless of case), convert to canonical.
  // If input is already canonical, return as-is.
}
```

Reuse `toOracleHexGuid` if it can accept either format OR extend it. Audit may flag the helper design; respect audit's recommendation if given.

Apply at the handler edge, BEFORE the triple-keying lookup. Don't normalize deep in the walk — one normalization at entry, then downstream code sees canonical form only.

### §3 Fallback-path audit (F-21)

Per audit: some handlers have fallback paths that violate D70 triple-keying (likely use `node_guid` alone when primary lookup fails). Identify + fix:
- Find any `.find(n => n.guid === x)` or similar that doesn't include `graph_name` in the key
- Fix by using the proper `(graph_name, node_guid, pin_id)` triple

If the fallback was added for a real reason (e.g., agent passes node_id without graph_name), EITHER require graph_name in the signature (breaking change, update yaml) OR implement an explicit search-all-graphs fallback with clear semantics.

### §4 Tests

Extend `server/test-verb-surface.mjs` with:

**Composition tests** (the specific gap audit flagged):
```js
// Seed a node_id via M-spatial-output format
const listResult = await bp_list_entry_points({ asset_path });  // emits M-spatial format
const lcNodeId = listResult.entries[0].node_id;  // LE-lowercase hex

// Use it as Verb-surface input WITHOUT reformatting
const traceResult = await bp_trace_exec({
  asset_path,
  graph_name: 'EventGraph',
  start_node_id: lcNodeId  // LE-lowercase input
});

assert(traceResult.chain.length > 0);  // should NOT silently be node_not_found
```

**Both-formats tests**: one assertion per verb confirming BE-uppercase AND LE-lowercase inputs both resolve.

Expected +8-15 new assertions.

### §5 Optional tools.yaml doc update

If signature semantics change (e.g., you made graph_name required for node lookup), update yaml `params` descriptions to reflect. D44 invariant.

---

## Scope — out

- **AUDIT-FIX-1 / AUDIT-FIX-2 scopes** — parallel workers. DO NOT touch plugin/* or rc-tools.mjs.
- **S-B-base parser internals** — don't change how parser emits GUIDs; just normalize at Verb-surface input edge.
- **M-spatial verbs** — they already emit LE-lowercase (canonical for their scope); don't touch.
- **Oracle-A fixture regen** — fixture JSONs stay authoritative in their current format.

---

## Reference files

### Tier 1
1. `docs/audits/phase3-post-m-enhance-audit-2026-04-24.md` F-2, F-21.
2. `docs/tracking/risks-and-decisions.md` D79 (audit summary), D72 (original bridge OUTPUT work), D70 (triple-keying invariant).

### Tier 2
3. `server/offline-tools.mjs` — Verb-surface handlers + `toOracleHexGuid` helper (from Verb-surface commit `aa131cd`).
4. `server/test-verb-surface.mjs` — extend with composition tests.
5. `tools.yaml` — optional signature doc refresh.

---

## Success criteria

1. All 5 Verb-surface handlers normalize NodeGuid input to canonical form at entry.
2. Agent composition `bp_list_entry_points → bp_trace_exec` works without manual reformatting.
3. Fallback paths violating D70 triple-keying fixed OR documented if fallback is intentional.
4. `test-verb-surface.mjs` has composition tests that seed input from `bp_list_entry_points` output.
5. Full rotation stays green.
6. Path-limited commit per D49: `server/offline-tools.mjs` + `server/test-verb-surface.mjs` + optional `tools.yaml`.

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **D49 path-limited**: scope above.
- **No AI attribution**.
- **Single commit preferred**.
- **Report via standard Final Report template** (under 150 words given small scope).

---

## Final report

1. Commit SHA.
2. Handlers normalized (list).
3. Fallback paths fixed for F-21 (count + brief rationale).
4. Composition test example (one-liner showing the before-fails → after-passes scenario).
5. Yaml changes (if any).
6. Assertion delta + rotation status.
