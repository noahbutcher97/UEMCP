# EN-8 + EN-9 Bundle Worker — offline enhancement micro-handoff

> **Dispatch**: Fresh Claude Code session. **No dependencies** — runs inline or parallel with any other worker.
> **Type**: Implementation — pure offline JS, two small enhancements bundled to share the test-rotation cost.
> **Duration**: 45 min - 1 session.
> **D-log anchors**: D59 (both gaps surfaced in M-spatial manual testing 2026-04-21, commit `8ad69bd`).
> **Deliverable**: EN-8 adds `comment_ids[]` to `bp_list_graphs` per-graph rows; EN-9 adds graceful-degradation envelope to all 5 M-spatial verbs (and extends cleanly to future M-new verbs).

---

## Mission

Close two real workflow gaps that S-B-base's Verb-surface worker will immediately hit if left unresolved:

**EN-8 gap**: no verb enumerates comment node_ids. `bp_find_in_graph({node_class: "UEdGraphNode_Comment"})` returns 0 because comments aren't K2Nodes. Current workaround uses `inspect_blueprint`, which triggers MCP token cap on larger BPs (85KB / 275 exports on BP_OSPlayerR → auto-saved to tool-results file, breaking natural composition).

**EN-9 gap**: `bp_list_graphs({asset_path: "/Game/Nonexistent/BP_Fake"})` surfaces raw ENOENT through the MCP error channel instead of the FA-β graceful-degradation idiom (`{available: false, reason: "asset_not_found"}`). Breaks the "plugin-absent state is first-class" contract that D58 made load-bearing.

Both fixes are small and bundle naturally because they live in the same file + need matching test additions.

---

## Scope — in

### §1 EN-8 — `comment_ids[]` on `bp_list_graphs`

Current shape per-graph row (from `offline-tools.mjs` handler):
```json
{ "name": "EventGraph", "type": "ubergraph", "node_count": 53, ... }
```

Extended shape:
```json
{ "name": "EventGraph", "type": "ubergraph", "node_count": 53,
  "comment_ids": ["<NodeGuid>", "<NodeGuid>", ...], ... }
```

Implementation: extend the graph-enumeration handler in `offline-tools.mjs` to scan each graph's exports for `class_name === "UEdGraphNode_Comment"` (canonical — NOT `K2Node_*` per D59 finding) and collect their `NodeGuid`s into `comment_ids[]` per-graph.

Empty array (`comment_ids: []`) for graphs with no comments — don't omit the field. Callers then skip `inspect_blueprint` entirely and call `bp_subgraph_in_comment(comment_node_id)` directly.

### §2 EN-9 — Graceful ENOENT envelope

Current behavior — all 5 M-spatial verbs (`bp_list_graphs`, `bp_find_in_graph`, `bp_subgraph_in_comment`, `bp_list_entry_points`, `bp_show_node`) surface ENOENT via MCP error channel when given an invalid asset_path.

Desired behavior — catch ENOENT at handler edge (file-read boundary in `offline-tools.mjs`) and return:

```json
{ "available": false, "reason": "asset_not_found", "asset_path": "<what was passed>" }
```

Match existing FA-β idioms used elsewhere in `offline-tools.mjs`. ENOENT is the only error that degrades gracefully — genuine parser errors (corrupt bytes, unknown class) still throw.

**Design the helper so M-new verbs adopt it with zero friction**. Expose as shared utility:

```js
// Wraps a handler to catch ENOENT on asset_path inputs
export function withAssetExistenceCheck(handler) { ... }
```

Apply to all 5 M-spatial verbs. Verb-surface worker will wrap M-new verbs with the same helper when they ship.

### §3 Tests

Extend `server/test-phase1.mjs` with the BP-spatial tests section:

**EN-8 assertions** (2-3):
- Call `bp_list_graphs` on BP_OSPlayerR; assert at least one graph row has non-empty `comment_ids[]`.
- Assert each ID returned is a valid NodeGuid (FGuid format).
- Optional: spot-check that a known BP_OSPlayerR comment appears in the list (cross-ref with M-spatial manual test results at commit `8ad69bd`).

**EN-9 assertions** (5 — one per verb):
- For each of the 5 M-spatial verbs, call with `asset_path: "/Game/Nonexistent/BP_Fake"` and assert response shape `{available: false, reason: "asset_not_found", asset_path: "..."}`.

Expected assertion delta: +7-8 assertions. Test baseline 899 → ~906-907.

### §4 yaml updates

Update `tools.yaml` for `bp_list_graphs` to document `comment_ids[]` as a returned field. Keep D44 single-source-of-truth invariant — any response-shape change needs yaml documentation.

No yaml changes needed for EN-9 (envelope change isn't a new param/return field; it's an error-shape normalization).

---

## Scope — out

- **M-new verbs**. Verb-surface worker applies `withAssetExistenceCheck` to those when they ship; don't pre-wire verbs that don't exist yet.
- **Other error types** (corrupt bytes, unknown export class, parser crash). Only ENOENT degrades gracefully; genuine errors still throw.
- **Response-shape refactors beyond EN-8**. Don't expand scope to "while I'm in here, also add X."
- **Plugin code**. You touch zero files under `plugin/UEMCP/`.
- **EN-6** (bulk sort by match_count). Similar bundle candidate but different file (and different rationale — EN-6 is caller ergonomics, EN-8/EN-9 are gap closers). Leave for future bundle.

---

## Reference files

### Tier 1 — Scope sources
1. `docs/tracking/backlog.md` EN-8 + EN-9 entries.
2. `docs/tracking/risks-and-decisions.md` D59 (both gaps surfaced via M-spatial manual testing).
3. M-spatial manual testing results: commit `8ad69bd`, see §workflow observations + §1.3 in `docs/testing/m-spatial-manual-testing-2026-04-20.md`.

### Tier 2 — Implementation anchors
4. `server/offline-tools.mjs` — the 5 M-spatial verbs live in `executeOfflineTool` switch cases. Grep for `bp_list_graphs`, `bp_find_in_graph`, `bp_subgraph_in_comment`, `bp_list_entry_points`, `bp_show_node`.
5. `server/uasset-parser.mjs` — export-iteration helpers for comment-class scan in §1 (reuse existing walker; don't rewrite).
6. `tools.yaml` — `bp_list_graphs` entry for §4 documentation.

### Tier 3 — Test reference
7. `server/test-phase1.mjs` — existing M-spatial tests show the call pattern; add new assertions alongside.

### Tier 4 — D-log
8. `docs/tracking/risks-and-decisions.md` D58 (FA-β graceful-degradation contract, D59 wire validation).

---

## Success criteria

1. `bp_list_graphs` returns `comment_ids[]` on every graph row (empty array if none).
2. All 5 M-spatial verbs return `{available: false, reason: "asset_not_found", ...}` on bogus asset_path (caught ENOENT, not thrown).
3. `withAssetExistenceCheck` helper exported from `offline-tools.mjs` (or equivalent shared utility) for Verb-surface reuse.
4. Full test rotation (899 + ~7-8 new) green.
5. `tools.yaml` documents `comment_ids[]` for `bp_list_graphs`.
6. Path-limited commits: `server/offline-tools.mjs`, `server/test-phase1.mjs`, `tools.yaml`.

---

## Constraints

- **Desktop Commander for git** (shell: "cmd").
- **Path-limited commits per D49** — scope to 3 files listed above. If you touch uasset-parser.mjs or any plugin/docs file, surface.
- **No AI attribution**.
- **Single commit OK or split EN-8/EN-9** — your call; both are small enough either works.

---

## Final report to orchestrator

Report (keep under 200 words):
1. Commit SHA(s).
2. Test baseline: old → new assertion count.
3. Confirmation that `withAssetExistenceCheck` helper signature matches what Verb-surface worker should call.
4. Any surprises in comment-node class name (handoff says `UEdGraphNode_Comment` — confirm it's correct on BP_OSPlayerR fixture; D59 M-spatial manual testing reported this but verify).
5. Whether EN-6 (`find_blueprint_nodes_bulk` sort by match_count) makes sense to bundle next or hold as separate enhancement.
6. Next action: no blocker; Verb-surface worker inherits cleaner envelope when they dispatch.
