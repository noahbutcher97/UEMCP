# Manual Testing Handoff — M-spatial 5 BP traversal verbs

> **Dispatch**: Fresh Claude Code session with restarted MCP server (loads post-`4938248` code).
> **Type**: Focused manual test — 5 new verbs through live MCP wire.
> **Duration**: 30-40 minutes.
> **Output**: Fill pass/fail + notes inline; save as `docs/testing/2026-04-20-m-spatial-results.md`.
> **D-log anchors**: D58 (re-sequence, M-spatial Wave 1), D44 (yaml source of truth — verify tools/list matches).

---

## Mission

M-spatial Worker shipped 5 offline BP traversal verbs (commits `08be682`/`4105fa0`/`4938248`). 74 new unit assertions pass structurally. **What remains unverified**:

1. The verbs actually work through a live MCP wire with a fresh Claude Code session.
2. The FA-β manifest shape (`{schema_version, available_fields, not_available, plugin_enhancement_available}`) surfaces correctly in real responses.
3. The FA-δ invariant (plugin-absent first-class functionality) holds end-to-end, not just in the unit test.
4. The partial verbs (`bp_list_entry_points`, `bp_show_node`) correctly flag missing fields so callers know what to expect from M-new.
5. Real ProjectA BPs produce useful, non-empty output in realistic workflows.

**Notable finding from M-spatial worker** to validate: *zero parser code was added* — D50's tagged-fallback already decoded every required UPROPERTY. If this ships through the wire cleanly, it confirms D50's coverage breadth empirically through a second independent channel (M-spatial unit tests = channel 1; this manual test = channel 2).

---

## Pre-flight

- [ ] Close any existing Claude Code session connected to UEMCP.
- [ ] Restart the UEMCP MCP server (reopen IDE window or equivalent).
- [ ] Verify new server loads post-`4938248`: `git log --oneline -5` should show the M-spatial commits at top.
- [ ] `UNREAL_PROJECT_ROOT = D:/UnrealProjects/5.6/ProjectA/ProjectA`.
- [ ] Confirm server responsive: call `project_info({})`.
- [ ] Confirm verbs registered: call `find_tools({ query: "bp_list_graphs" })`. Should return `bp_list_graphs` with offline toolset already active. Repeat for `bp_subgraph_in_comment` (expect to see all 5 bp_* verbs surface).
- [ ] Confirm baseline: `tools/list` should now show 20 offline user-facing tools (was 15 pre-M-spatial) + 6 management.

---

## §1 — bp_list_graphs

### 1.1 Real BP with multiple graphs

Call `bp_list_graphs({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR" })`.

Expected per M-spatial final report:
- SUCCESS.
- `graphs` array with **~10 entries** (EventGraph → type `ubergraph`, UserConstructionScript → `construction_script`, 8 function graphs → `function`).
- Each graph has `name`, `type`, and `node_count`.
- Response carries `schema_version: "m-spatial-v1"` + `available_fields` non-empty + `not_available` empty (this verb is full).
- `plugin_enhancement_available: false`.

**PASS/FAIL**:  **Notes** (record actual graph count + 2-3 graph names):

### 1.2 BP with minimal graphs

Pick a smaller BP — try `/Game/Blueprints/Character/BP_OSPlayerR_Child1` or similar. If unsure which BPs have minimal structure, start with `query_asset_registry({ class_name: "Blueprint", path_prefix: "/Game/Blueprints/Character/", limit: 5 })` and pick one.

Expected: SUCCESS. Smaller `graphs` count.

**PASS/FAIL**:  **Notes**:

### 1.3 Invalid asset path

Call `bp_list_graphs({ asset_path: "/Game/Nonexistent/BP_Fake" })`.

Expected: graceful failure. Either `{available: false, reason: "asset_not_found"}` OR a structured error response. Should NOT crash or return a server error.

**PASS/FAIL**:  **Notes**:

---

## §2 — bp_find_in_graph

### 2.1 Scope filter — events in EventGraph

Call `bp_find_in_graph({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", graph_name: "EventGraph", node_class: "K2Node_Event" })`.

Expected per M-spatial report: narrows 53 → 7 events (exact count may vary on fresh run).

**PASS/FAIL**:  **Notes** (record actual count + 2-3 member_names):

### 2.2 Scope filter — function calls in UserConstructionScript

Call `bp_find_in_graph({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", graph_name: "UserConstructionScript", node_class: "K2Node_CallFunction" })`.

Expected: SUCCESS, returns construction-script calls only (e.g., `K2_SetActorRelativeLocation`, `SetCustomizableObjectInstance`, component spawning — use canonical BP-callable names per `feedback_bp_query_handoff_names`).

**PASS/FAIL**:  **Notes**:

### 2.3 Nonexistent graph

Call `bp_find_in_graph({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", graph_name: "NonExistentGraphName" })`.

Expected: error response naming the graph as not found. Not a crash.

**PASS/FAIL**:  **Notes**:

---

## §3 — bp_subgraph_in_comment

### 3.1 Known comment on BP_OSPlayerR

First, use `bp_find_in_graph` or `find_blueprint_nodes` with `node_class: "UEdGraphNode_Comment"` on BP_OSPlayerR to get a comment's `node_id`. Record it.

Then call `bp_subgraph_in_comment({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", comment_node_id: "<the id>" })`.

Expected per M-spatial report: first EventGraph comment contains **11 real nodes**, rect **1424×544** at **(-1296, 160)**. (Exact content may differ across comments; pick any.)

Response includes:
- `comment`: { `text`, `color`, `rect: {x, y, width, height}` }
- `contained`: array of node records (node_id, class_name, position, etc.)

**PASS/FAIL**:  **Notes** (record comment text excerpt + contained count):

### 3.2 Non-comment node_id

Pass a K2Node's node_id instead of a comment's. Expected: precise error "not a comment" (not "not found" — per M-spatial's two-phase resolver).

**PASS/FAIL**:  **Notes**:

### 3.3 Nonexistent node_id

Pass `comment_node_id: "definitely_not_a_real_id"`. Expected: precise error "not found".

**PASS/FAIL**:  **Notes**:

---

## §4 — bp_list_entry_points (partial)

### 4.1 Entry points on BP_OSPlayerR

Call `bp_list_entry_points({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR" })`.

Expected per M-spatial report: **17 entries**. Classes include `K2Node_Event`, `K2Node_CustomEvent`, `K2Node_FunctionEntry`. Each entry has member_name + graph_name + position + enabled_state.

**Critical FA-β check**: response MUST include `not_available: ["exec_connectivity"]` — signals that M-new S-B will add full precision (knowing which entries have exec connections).

**PASS/FAIL**:  **Notes** (record count + 3 sample entries + verify `not_available` payload):

### 4.2 BP with no custom events

Pick a BP unlikely to have custom events (a simple data-only BP or a Parent BP you know is light on event logic). Call `bp_list_entry_points` on it.

Expected: entries reduced to only FunctionEntry nodes + auto-generated events like ReceiveBeginPlay (if present). `not_available: ["exec_connectivity"]` still present.

**PASS/FAIL**:  **Notes**:

---

## §5 — bp_show_node (partial)

### 5.1 Show a known K2Node_Event by node_id

Use §2.1's output to get an event node's node_id. Then call:

`bp_show_node({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", node_id: "<id>" })`.

Expected:
- Full node record: class_name, member_name (for events), position (x, y), width/height (may be 0 per M-spatial edge-case note), comment (if any), enabled_state, node_guid.
- **Critical FA-β check**: response MUST include `not_available: ["pin_block"]` + `pins: []` as placeholder.

**PASS/FAIL**:  **Notes** (record the full shape — paste 10-15 lines of response):

### 5.2 Show a comment node

Use §3.1's comment node_id. Call `bp_show_node({ asset_path: ..., node_id: "<comment id>" })`.

Expected: comment-specific fields present (color, font_size, text, rect). `pins: []`. `not_available: ["pin_block"]` still present (graceful degradation — comments don't have pins but the manifest stays consistent).

**PASS/FAIL**:  **Notes**:

### 5.3 Show a K2Node_CallFunction

Use §2.2's output to get a call function node. Call `bp_show_node`.

Expected: function-call-specific fields — member_name, target_class (if readable), position, etc. `pins: []`, `not_available: ["pin_block"]`.

**PASS/FAIL**:  **Notes**:

---

## §6 — FA-β manifest shape (contract validation)

### 6.1 Every response carries the manifest

For each verb (5 calls, one per verb), verify the response contains all of:
- `schema_version: "m-spatial-v1"`
- `available_fields`: non-empty array of strings
- `not_available`: array (may be empty for full verbs, populated for partials)
- `plugin_enhancement_available: false`

**PASS/FAIL** (must pass all 5):  **Notes**:

### 6.2 `available_fields` content makes sense

Sanity-check that each verb's `available_fields` actually reflects what the response contains. E.g., `bp_subgraph_in_comment` should list `["comment_text", "comment_rect", "contained_nodes", "positions"]` or similar.

**PASS/FAIL**:  **Notes**:

---

## §7 — FA-δ invariant: plugin-absent first-class functional

### 7.1 No plugin, no editor, no sidecar — correct data

Verify environment:
- No UnrealMCP plugin attached (OR UnrealMCP plugin is on port 55557 and does NOT influence the offline verbs' behavior).
- No UE editor window open.
- No sidecar JSON files at `D:\UnrealProjects\5.6\ProjectA\ProjectA\Saved\UEMCP\BPCache\*` (expected since M-enhance hasn't shipped).

Run all 5 verbs against BP_OSPlayerR. Each should return non-empty correct data without any fallback to `{available: false}`.

Expected: **5/5 PASS with non-empty payload**. This is the FA-δ invariant — the verb set is genuinely plugin-absent first-class.

**PASS/FAIL**:  **Notes** (confirm all 5 verbs ship data):

---

## §8 — Cross-verb workflow (golden path)

### 8.1 "Explore BP_OSPlayerR's EventGraph structure"

Use the 5 verbs in combination to answer: "what events does BP_OSPlayerR's EventGraph have, and what comment boxes group them?"

Steps:
1. `bp_list_graphs` → confirm EventGraph exists + its node count.
2. `bp_find_in_graph` with `graph_name: "EventGraph"` + `node_class: "UEdGraphNode_Comment"` → list comments in that graph.
3. For each comment, `bp_subgraph_in_comment` → get contained nodes.
4. `bp_list_entry_points` → cross-reference which entries fall inside which comments.
5. `bp_show_node` on a specific entry → get full record.

**Workflow observations**: how many tool calls did it take? Did the response shapes compose naturally? Any friction?

---

## Results summary

- **Total PASS**:  / 18 (across §1-§5 + §6-§7 contract checks)
- **Regressions detected**:
- **FA-β manifest shape confirmed on all 5 verbs?**: **YES / NO**
- **FA-δ invariant (plugin-absent first-class) confirmed?**: **YES / NO**
- **Unexpected behaviors**:
- **Workflow observations from §8**:

---

## Save + commit

Save filled results as `docs/testing/2026-04-20-m-spatial-results.md`. Path-limited commit per D49:

```cmd
git commit docs/testing/2026-04-20-m-spatial-results.md -m "M-spatial manual testing results"
```

Desktop Commander for git if sandbox bash can't acquire `.git/index.lock`. Native Git Bash fine. No AI attribution.

---

## Report back to orchestrator

Report:
1. Results commit SHA.
2. PASS/FAIL count.
3. Any regression or FA-β/FA-δ contract violations.
4. Workflow observations — did the 5 verbs compose naturally or is there missing glue?
5. Anything M-new S-B-base should know about (e.g., "the `not_available` manifest naming convention matters — don't rename `pin_block` when M-new fills it in; just remove it from the array").
