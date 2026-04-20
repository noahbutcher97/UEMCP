# M-spatial Worker — Position + comment extraction + 5 traversal verbs

> **Dispatch**: Fresh Claude Code session. Parallelizes with M1 (C++ plugin scaffold) and M-new Oracle-A (C++ commandlet) — zero file collision (this is pure JS).
> **Type**: Implementation — offline parser + handler + verb surface.
> **Duration**: 1-2 sessions (~3-4 hours).
> **D-log anchors**: D58 (re-sequence adopted), D52 (near-parity), D44 (yaml source of truth).
> **Deliverable**: 5 of 9 traversal verbs shipping on today's offline parser infrastructure, with no TCP or plugin dependency. Wave 1 of the re-sequenced M-plan per §Q5.1 of `docs/research/phase3-resequence-mcp-first-2026-04-20.md`.

---

## Mission

Extract BP node **spatial data** (positions, sizes, comments, enabled state) from `.uasset` bytes via existing tag iteration + add a lightweight `UEdGraphNode_Comment` export handler. Ship 5 BP traversal verbs on this foundation:

1. `bp_list_graphs` — full list including UbergraphPages, FunctionGraphs, UserConstructionScript
2. `bp_find_in_graph` — per-graph variant of `find_blueprint_nodes` (whole-graph scope filter)
3. `bp_subgraph_in_comment` — which nodes are inside a specific comment box (spatial `contains[]` math)
4. `bp_list_entry_points` — partial (class-identity heuristic via `K2Node_Event`/`K2Node_CustomEvent`/`K2Node_FunctionEntry` class filter; precision-complete version lands with M-new S-B)
5. `bp_show_node` — partial (everything except pin block — pin block lands with M-new S-B)

**Graceful degradation per FA-β**: both partial verbs return `available_fields` + `not_available` manifests so callers can distinguish offline-primary coverage from the full pin-enhanced version. This contract extends to all M-new verbs when they ship.

**Plugin-absent first-class-functional contract per FA-δ**: tests must prove these verbs return non-empty correct data on a real ProjectA BP with **no plugin installed, no editor running, no sidecar present**. This is a test-harness invariant, not prose aspiration.

---

## Scope — in

### §1 Parser extensions (`server/uasset-parser.mjs`)

Extend the existing L1+L2 FPropertyTag iteration to extract these UPROPERTYs on K2Node exports:

| UPROPERTY | Type | UE source | Purpose |
|-----------|------|-----------|---------|
| `NodePosX` | int32 | `UEdGraphNode::NodePosX` | Graph X position |
| `NodePosY` | int32 | `UEdGraphNode::NodePosY` | Graph Y position |
| `NodeWidth` | int32 | `UEdGraphNode_Comment::NodeWidth` (and base on some nodes) | Width in graph units |
| `NodeHeight` | int32 | `UEdGraphNode_Comment::NodeHeight` | Height in graph units |
| `NodeComment` | FString | `UEdGraphNode::NodeComment` | Per-node comment bubble text |
| `EnabledState` | byte/enum | `UEdGraphNode::EnabledState` | Enabled / DevelopmentOnly / Disabled |
| `bCommentBubblePinned` | bool | `UEdGraphNode::bCommentBubblePinned` | Comment bubble pinned-open state |
| `bCommentBubbleVisible` | bool | `UEdGraphNode::bCommentBubbleVisible` | Comment bubble visibility |

All are scalar UPROPERTYs already in the tag stream. No new binary parsing. These become additional fields on the export record returned by `findBlueprintNodes` / related functions.

### §2 `UEdGraphNode_Comment` export handler

Add dedicated handler for the `UEdGraphNode_Comment` class. This isn't a K2Node subclass but IS an `UEdGraphNode` — it has its own shape worth recognizing:

| Field | UE source |
|-------|-----------|
| `CommentColor` | `FLinearColor` — reuse L2 FLinearColor struct handler |
| `NodeComment` (inherited) | FString — per §1 |
| `FontSize` | int32 |
| `bColorCommentBubble` | bool |
| `bCommentBubbleVisible_InDetailsPanel` | bool |

Output shape: add comment nodes to the export list with `className: "UEdGraphNode_Comment"` + the fields above. Positions from §1 apply (NodePosX/Y + NodeWidth/Height define the comment box rectangle).

### §3 `contains[]` computation helper

Add a small function in `server/offline-tools.mjs` (or a new module `server/bp-spatial.mjs` if cleaner):

```js
function computeCommentContainment(nodes, commentNodes) {
  // For each comment node, compute which other nodes sit inside its rect.
  // Point-in-rect on node center (NodePosX + nodeHalfWidth, NodePosY + nodeHalfHeight).
  // Return Map<comment_node_id, Array<contained_node_id>>.
}
```

Edge cases:
- Comment boxes can nest (a comment inside a comment). Handle by containment check per pair; don't infer a hierarchy.
- Nodes with no size — use a default size or center-point-only containment. Document whichever choice you make.
- Zero-size comment boxes — treat as empty container.

Performance: O(N×M) over the graph (N nodes × M comments). On BP_OSPlayerR-sized BPs (~184 nodes, probably 5-15 comments) this is microseconds. No indexing needed for v1.

### §4 Five traversal verbs

Add to `server/offline-tools.mjs` + register in `executeOfflineTool` switch + add yaml entries under `offline.tools` (D44 invariant — yaml source of truth).

Handler signatures:

```js
// bp_list_graphs(asset_path) → {graphs: [{name, type, node_count}], schema_version}
// bp_find_in_graph(asset_path, graph_name, filter) → filter matches nodes within one graph
// bp_subgraph_in_comment(asset_path, comment_node_id) → {comment, contained: [{node_id, className, ...}]}
// bp_list_entry_points(asset_path) → {entry_points: [...], available_fields: [...], not_available: ["pin_linked_to"]}
// bp_show_node(asset_path, node_id) → {node: {...}, available_fields: [...], not_available: ["pin_block"]}
```

**Common response shape** (per FA-β):

```js
{
  asset_path: "...",
  ...verb_specific_fields,
  schema_version: "m-spatial-v1",
  available_fields: ["positions", "comments", "contains", "class_identity", ...],
  not_available: ["pin_linked_to", "pin_defaults"],  // these land with M-new
  plugin_enhancement_available: false  // future M-enhance sets this true when sidecar present
}
```

Concrete verb scopes:

- **`bp_list_graphs(asset_path)`** — enumerate UbergraphPages, FunctionGraphs, UserConstructionScript, Timelines, MacroGraphs subobjects in the UBlueprint export. This extends `inspect_blueprint`'s structural walk but emits per-graph records with node counts. Already-shipped `inspect_blueprint` is the starting point.
- **`bp_find_in_graph(asset_path, graph_name, filter)`** — scope variant of `find_blueprint_nodes`. Filter within one graph rather than corpus or whole-BP. Validates `graph_name` exists; returns filter matches with graph_name echoed per match for disambiguation.
- **`bp_subgraph_in_comment(asset_path, comment_node_id)`** — lookup comment by node_id, return comment text + color + contained nodes via §3 computation. Error if comment_node_id doesn't exist or isn't a comment.
- **`bp_list_entry_points(asset_path)`** — filter K2Nodes by class: `K2Node_Event`, `K2Node_CustomEvent`, `K2Node_FunctionEntry`. Return member_name + position + graph_name + enabled_state per entry. **Partial** — M-spatial doesn't know which entries have exec connections; `not_available: ["exec_connectivity"]` in response.
- **`bp_show_node(asset_path, node_id)`** — return the full export record for a node by node_id (GUID). Include position, comment, enabled_state, class_name, all UPROPERTYs. **Partial** — pin block lands with M-new; `not_available: ["pin_block"]` in response.

### §5 Yaml entries (D44 — add first, then handlers)

Add 5 entries to `tools.yaml` under `offline.tools`. Example shape:

```yaml
  bp_list_graphs:
    description: >
      List all UEdGraph subobjects in a UBlueprint (UbergraphPages, FunctionGraphs,
      UserConstructionScript, Timelines). Offline; no plugin or editor required.
      Returns per-graph node count.
    params:
      asset_path: { type: string, required: true, description: "/Game/... BP path" }
```

Fill param blocks for all 5 verbs per handler signatures in §4. Per memory `feedback_bp_query_handoff_names`: avoid hard-coding BP-callable name examples in descriptions that might not exist on ProjectA/ProjectB — use generic phrasing.

### §6 Tests

Extend `server/test-phase1.mjs` with:

1. **Parser extension tests** — synthetic `.uasset` bytes OR existing ProjectA BP fixtures. Assert `NodePosX`/Y/comment/enabled fields extracted on K2Node exports. `UEdGraphNode_Comment` handler produces expected fields.
2. **Verb scenario tests** — ProjectA BP fixtures. `bp_list_graphs("/Game/Blueprints/Character/BP_OSPlayerR")` returns >= 3 graphs (EventGraph + UserConstructionScript + at least one FunctionGraph). `bp_find_in_graph` scope filter works. `bp_subgraph_in_comment` returns non-empty `contained` on a known comment. `bp_list_entry_points` returns non-empty entries on any BP with events.
3. **FA-δ invariant test** — **explicitly named** assertion: "all 5 verbs return `available_fields` non-empty and correct data on ProjectA BPs with no sidecar and no plugin." This is the plugin-absent first-class-functional guard.
4. **FA-β graceful-degradation test** — `bp_show_node` + `bp_list_entry_points` responses contain `not_available` arrays listing `["pin_block"]` and `["exec_connectivity"]` respectively. Future M-new tests will remove those entries from `not_available` and add to `available_fields` when S-B ships.

Target: +30-50 test assertions. Baseline goes 825 → ~855-875.

### §7 Update existing test if helpful

- `server/test-uasset-parser.mjs` may need +5-10 assertions for parser extension coverage.
- `server/test-inspect-and-level-actors.mjs` may benefit from adding an assertion that `inspect_blueprint` output now exposes `EnabledState` on K2Node exports (if feasible without refactor).

---

## Scope — out

- **Pin block parsing** — M-new S-B. Your response shapes should leave space for `pins: [...]` but not populate it.
- **LinkedTo edge resolution** — M-new S-B.
- **`bp_trace_exec` / `bp_trace_data` / `bp_neighbors` / `bp_paths_between`** — M-new or v1.1.
- **Plugin C++ scaffold** — M1 / Oracle-A (separate workers).
- **Sidecar JSON writer or reader** — M-enhance (much later).
- **via_knots annotation** — produce `{knot: true}` flag when node is a knot; don't trace knot-through-edges (that's M-new).
- **TCP tool or broker** — M-enhance.

---

## Reference files (required reading)

### Tier 1 — Scope sources
1. `docs/research/phase3-resequence-mcp-first-2026-04-20.md` §Q5.3 M-spatial + §Q3 verb-degradation table + §Q7 FA-β/FA-δ.
2. `docs/specs/blueprints-as-picture-amendment.md` — verb names + canonical description patterns.

### Tier 2 — Code to extend
3. `server/uasset-parser.mjs` — L1+L2 tag iteration is already there. Add new field extraction.
4. `server/offline-tools.mjs` — handler pattern for offline tools (see `findBlueprintNodes` / `inspectBlueprint` for reference).
5. `tools.yaml` — D44 source of truth. Add entries to `offline.tools` section.
6. `server/test-phase1.mjs` — test structure + TestRunner pattern.
7. `server/test-uasset-parser.mjs` — format-level test patterns.

### Tier 3 — UE 5.6 source pointers (verify field names + types)
- `Engine/Source/Runtime/Engine/Classes/EdGraph/EdGraphNode.h` — `UEdGraphNode` UPROPERTYs (NodePosX, NodePosY, NodeComment, EnabledState, etc.)
- `Engine/Source/Runtime/Engine/Classes/EdGraph/EdGraphNode_Comment.h` — comment-specific fields

### Tier 4 — D-log anchors
8. `docs/tracking/risks-and-decisions.md` D44 (yaml source of truth), D50 (tagged-fallback — your new fields go through the same pipeline), D58 (re-sequence + FA-β/FA-δ).

---

## Success criteria

1. All 5 verbs registered in yaml, D44 invariant holds (test-mcp-wire.mjs passes — tools/list matches yaml).
2. `bp_list_graphs("/Game/Blueprints/Character/BP_OSPlayerR")` returns at least 3 graphs with accurate node counts.
3. `bp_subgraph_in_comment` on a known ProjectA BP comment returns contained nodes.
4. `bp_list_entry_points` on BP_OSPlayerR returns the construction-script + event-graph entries (partial — no exec connectivity).
5. `bp_show_node` returns a complete record with `not_available: ["pin_block"]` clearly set.
6. FA-δ invariant test explicitly asserts plugin-absent first-class functionality.
7. Test baseline grows 825 → ~855-875. All existing 825 assertions still pass.
8. No TCP, no plugin, no sidecar dependencies anywhere in the code path.

---

## Constraints

- **Desktop Commander for git** (shell: "cmd") — `.git/index.lock` can't be acquired by sandbox bash. Native Git Bash fine.
- **Path-limited commits per D49** — multiple commits OK, each scoped. Example:
  - `git commit server/uasset-parser.mjs -m "M-spatial: extract position + comment UPROPERTYs"`
  - `git commit tools.yaml -m "M-spatial: 5 verb entries"`
  - `git commit server/offline-tools.mjs -m "M-spatial: verb handlers"`
  - `git commit server/test-phase1.mjs -m "M-spatial: +N assertions"`
- **No AI attribution**.
- **Parallel workers**: M1 (`plugin/` C++) and M-new Oracle-A (`plugin/Source/UEMCP/TestFixtures/`) may run concurrently. Your scope is `server/*.mjs` + `tools.yaml`. Zero collision with either.
- **FA-β/FA-δ test-harness requirement is load-bearing** — if you can't write an explicit "plugin-absent first-class-functional" assertion, surface that in the final report and let orchestrator decide on scope adjustment.

---

## Final report to orchestrator

Report (keep under 400 words):
1. Commit SHAs (probably 3-5 path-limited).
2. Parser extension: which UPROPERTYs extracted? Any UE 5.6 names that differed from Tier-3 reading?
3. Verb delivery: which 5 verbs shipped? Partial verbs' `not_available` fields listed?
4. Test baseline delta: 825 → ? (expect 855-875).
5. FA-δ invariant test: explicit assertion included? Show the assertion text.
6. FA-β degradation: `available_fields` + `not_available` manifest shape confirmed in responses?
7. Edge cases flagged (e.g., nested comment boxes, zero-size nodes, missing position UPROPERTYs on certain K2Node subclasses).
8. Next action for orchestrator: M-new S-B-base dispatchable once Oracle-A lands; M-new verb-surface will extend `not_available` manifests to remove `pin_block` and `exec_connectivity` as fields become available.

If you hit a blocker (UE 5.6 UPROPERTY name is different, parser doesn't cleanly extend, ProjectA fixture doesn't have the expected comment), surface it — don't spend more than a session fighting a single issue.
