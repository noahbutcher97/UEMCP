# M-spatial manual testing results — 2026-04-20

> Source: `docs/handoffs/manual-testing-m-spatial-2026-04-20.md`.
> HEAD at test start: `9b507d7` (post-M-spatial 4938248/4105fa0/08be682).
> Environment: Claude Code MCP wire → `mcp__uemcp__*` tools, `UNREAL_PROJECT_ROOT = D:/UnrealProjects/5.6/ProjectA/ProjectA`.
> FA-δ environment: no UE editor running (TCP 55557/55558 both ECONNREFUSED), UnrealMCP plugin absent from `project_info.plugins[]`, `D:/UnrealProjects/5.6/ProjectA/ProjectA/Saved/UEMCP/` dir does not exist (no sidecar).

---

## Pre-flight

- [x] Fresh Claude Code session (this one) — MCP server responds.
- [x] `project_info` → ProjectA 5.6, 15 plugins enumerated (UnrealMCP not among them).
- [x] `find_tools("bp_list_graphs")` — returns `bp_list_graphs` in offline toolset (score 152). Offline toolset auto-enabled.
- [x] `find_tools("bp_subgraph_in_comment")` — returns all 5 bp_* verbs (bp_subgraph_in_comment, bp_find_in_graph, bp_list_graphs, bp_show_node, bp_list_entry_points). Offline toolset auto-enabled.
- [x] `list_toolsets` → offline enabled, toolCount 21 (handoff said 20; pre-M-spatial baseline was 16 per CLAUDE.md header, not 15 — off-by-one in handoff, not a functional fault).
- [x] Git log: top commits `9b507d7`, `130fd0a`, `30283a1`, `4938248`, `4105fa0` — M-spatial code is live.

---

## §1 — bp_list_graphs

### 1.1 Real BP with multiple graphs

Input: `bp_list_graphs({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR" })`.

**PASS.** `graph_count: 10`.
- EventGraph (ubergraph, 53 nodes, 9 comments)
- UserConstructionScript (construction_script, 3 nodes)
- 8 function graphs: ApplyColor (15), ApplyFXFromAuraInfo (14), ApplyFXFromAuraInfoAsset (14), ApplyVFX_Material_Aura (49), ApplyVFX_Niagara (25), ApplyVFX_Niagara_FromStruct (3), GetAuraParamFromTier (6), InitializeCharacterMesh (13).

Manifest: `schema_version: "m-spatial-v1"`, `available_fields` 8 entries, `not_available: []`, `plugin_enhancement_available: false`. Matches M-spatial report (~10 entries). Bonus: each graph row includes `comment_count` not mentioned in handoff.

### 1.2 BP with minimal graphs

Inputs:
- `bp_list_graphs({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR_Child1" })` → `graph_count: 2` (EventGraph 4 nodes, UserConstructionScript 2 nodes).
- `bp_list_graphs({ asset_path: "/Game/Blueprints/Character/PunchingBag" })` → `graph_count: 2` (EventGraph 4 nodes, UserConstructionScript 1 node).

**PASS.** Both return minimal graph sets with manifest intact.

### 1.3 Invalid asset path

Input: `bp_list_graphs({ asset_path: "/Game/Nonexistent/BP_Fake" })`.

**PASS (with observation).** Returns an MCP-level error: `"ENOENT: no such file or directory, stat 'D:\\UnrealProjects\\5.6\\ProjectA\\ProjectA\\Content\\Nonexistent\\BP_Fake.uasset'"`. Server remains responsive (subsequent calls worked). **Not** the idealized `{available: false, reason: "asset_not_found"}` shape — it's a raw ENOENT surfaced via MCP error response. Not a crash, so PASS per handoff guidance, but a polish candidate: catch `ENOENT` at the handler edge and return a structured `{available:false, reason:"asset_not_found"}` to match FA-β graceful-degradation idiom.

---

## §2 — bp_find_in_graph

### 2.1 Scope filter — events in EventGraph

Input: `bp_find_in_graph({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR", graph_name: "EventGraph", node_class: "K2Node_Event" })`.

**PASS.** `total_nodes_in_graph: 53`, `total_matched: 7`. **Exact match to M-spatial's 53 → 7**.

Events returned (member_name + target_class):
- `ReceivePossessed` / `/Script/Engine.Pawn`
- `ReceiveBeginPlay` / `/Script/Engine.Actor`
- `ApplyColorToMesh` / `/Script/ProjectA.OSCharacter`
- `ApplyCharacterType` / `/Script/ProjectA.OSCharacter`
- `OnGasReady` / `/Script/ProjectA.OSCharacter`
- `K2_OnMovementModeChanged` / `/Script/Engine.Character` (canonical K2_ prefix per `feedback_bp_query_handoff_names`)
- `OnLanded` / `/Script/Engine.Character`

### 2.2 Scope filter — function calls in UserConstructionScript

Input: `bp_find_in_graph({ asset_path: ..., graph_name: "UserConstructionScript", node_class: "K2Node_CallFunction" })`.

**PASS.** 2 CallFunction nodes returned: both call `InitializeCharacterMesh` with `extras: { self_context: true }`. (Handoff's `K2_SetActorRelativeLocation` / `SetCustomizableObjectInstance` were illustrative examples; the real graph only calls `InitializeCharacterMesh`.)

### 2.3 Nonexistent graph

Input: `bp_find_in_graph({ ..., graph_name: "NonExistentGraphName" })`.

**PASS.** Error message: `"Graph not found: NonExistentGraphName. Available: ApplyColor, ApplyFXFromAuraInfo, ApplyFXFromAuraInfoAsset, ApplyVFX_Material_Aura, ApplyVFX_Niagara, ApplyVFX_Niagara_FromStruct, EventGraph, GetAuraParamFromTier, InitializeCharacterMesh, UserConstructionScript"`. High-quality UX — lists the available graphs so the caller can correct.

---

## §3 — bp_subgraph_in_comment

### 3.1 Known comment on BP_OSPlayerR

Preparation: bp_find_in_graph with `node_class: "UEdGraphNode_Comment"` returned **0 matches** — comments aren't K2Nodes, so the K2Node-skeletal find verbs can't surface them (see Workflow observations below). Workaround: `inspect_blueprint` + JS parse of `exports[].className === "EdGraphNode_Comment"` → found 9 comment exports at indices 29-37, all in EventGraph.

Input: `bp_subgraph_in_comment({ asset_path: ..., comment_node_id: "29" })`.

**PASS.** Comment rect/text/position EXACT match to M-spatial's report:
- `node_comment: "Component Initialization + Character Type Setup"`
- `node_width: 1424, node_height: 544`
- position `(-1296, 160)`
- `comment_color: { r: 0.15, g: 0.15, b: 0.15, a: 0.5 }`

`contained_count: 11` — **exact match to M-spatial's "11 real nodes"**. Contained node types: 3× K2Node_CallFunction, 2× K2Node_CallParentFunction, 2× K2Node_Event (`ApplyCharacterType`, `OnGasReady`), 2× K2Node_Knot, 1× K2Node_Self, 1× K2Node_VariableGet.

Manifest: full `available_fields`, `not_available: []`, `plugin_enhancement_available: false`.

### 3.2 Non-comment node_id

Input: `bp_subgraph_in_comment({ ..., comment_node_id: "155" })` (an event node from §2.1).

**PASS.** Error: `"Node is not a comment: 155 (className: K2Node_Event)"` — precise two-phase-resolver message (exists, but wrong kind). Distinct from "not found".

### 3.3 Nonexistent node_id

Input: `bp_subgraph_in_comment({ ..., comment_node_id: "definitely_not_a_real_id" })`.

**PASS.** Error: `"Comment node not found: definitely_not_a_real_id"` — distinct "not found" message.

---

## §4 — bp_list_entry_points (partial)

### 4.1 Entry points on BP_OSPlayerR

Input: `bp_list_entry_points({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR" })`.

**PASS.** `entry_point_count: 17` — **exact match to M-spatial's 17**.
- 1× K2Node_CustomEvent: `DevAttack`
- 7× K2Node_Event: `ReceivePossessed`, `ReceiveBeginPlay`, `ApplyColorToMesh`, `ApplyCharacterType`, `OnGasReady`, `K2_OnMovementModeChanged`, `OnLanded`
- 9× K2Node_FunctionEntry: `ApplyColor`, `ApplyFXFromAuraInfo`, `ApplyFXFromAuraInfoAsset`, `ApplyVFX_Material_Aura`, `ApplyVFX_Niagara`, `ApplyVFX_Niagara_FromStruct`, `GetAuraParamFromTier`, `InitializeCharacterMesh`, `UserConstructionScript`

Each entry has `member_name`, `graph_name`, `node_pos_x/y`, `node_guid`, `node_class`. `not_available: ["exec_connectivity"]` ✅ present — FA-β contract held (caller knows M-new S-B will later populate this).

### 4.2 BP with minimal events

Input: `bp_list_entry_points({ asset_path: "/Game/Blueprints/Character/BP_OSPlayerR_Child1" })`.

**PASS.** `entry_point_count: 4`:
- 3 auto-generated Events (`ReceiveBeginPlay`, `ReceiveActorBeginOverlap`, `ReceiveTick`) all with `enabled_state: "ENodeEnabledState::Disabled"` and the default UE "disabled and will not be called" node_comment
- 1 FunctionEntry for `UserConstructionScript`

`not_available: ["exec_connectivity"]` ✅ still present. Bonus: `enabled_state` and `node_comment` surface naturally from the tagged-fallback decode — not called out in handoff but useful data.

---

## §5 — bp_show_node (partial)

### 5.1 Show K2Node_Event

Input: `bp_show_node({ asset_path: ..., node_id: "155" })` (ReceivePossessed from §2.1).

**PASS.** Full shape:
```json
{
  "node_id": 155,
  "node_name": "K2Node_Event_0",
  "class_name": "K2Node_Event",
  "node_pos_x": -1232,
  "node_pos_y": -176,
  "node_guid": "d42961eda138cf4d9a5da1f79ebe33fa",
  "outer_graph_name": "EventGraph",
  "outer_graph_type": "ubergraph",
  "member_name": "ReceivePossessed",
  "target_class": "/Script/Engine.Pawn",
  "macro_path": null,
  "properties": {
    "EventReference": {
      "MemberParent": { "objectName": "Pawn", "packagePath": "/Script/Engine.Pawn", "kind": "import" },
      "MemberName": "ReceivePossessed"
    },
    "bOverrideFunction": true,
    "NodePosX": -1232,
    "NodePosY": -176,
    "NodeGuid": "d42961eda138cf4d9a5da1f79ebe33fa"
  },
  "pins": []
}
```
`not_available: ["pin_block"]` ✅ present. `pins: []` placeholder ✅. Bonus: rich `properties` block with decoded FMemberReference (FA-β fodder for M-new). `outer_graph_name`/`outer_graph_type` not called out in handoff but useful.

### 5.2 Show a comment node

Input: `bp_show_node({ asset_path: ..., node_id: "29" })`.

**PASS.** Comment-specific fields all present:
- `node_width: 1424, node_height: 544`
- `comment_color: { r:0.15, g:0.15, b:0.15, a:0.5 }`
- `node_comment: "Component Initialization + Character Type Setup"`
- `comment_bubble_pinned: false`, `comment_bubble_visible: false`, `comment_bubble_visible_in_details_panel: false`

`properties` block contains CommentColor/NodeWidth/NodeHeight/NodeComment UPROPERTYs. `pins: []` ✅. `not_available: ["pin_block"]` ✅ — graceful degradation: the manifest stays consistent even though comments never have pins.

### 5.3 Show K2Node_CallFunction

Input: `bp_show_node({ asset_path: ..., node_id: "145" })` (InitializeCharacterMesh from §2.2).

**PASS.** Function-call-specific fields present:
- `member_name: "InitializeCharacterMesh"`
- `properties.FunctionReference: { MemberName, MemberGuid, bSelfContext: true }`
- position `(-528, 48)`
- `outer_graph_name: "UserConstructionScript"`

`pins: []`, `not_available: ["pin_block"]` ✅.

---

## §6 — FA-β manifest shape (contract validation)

### 6.1 Every response carries the manifest

**PASS (5/5).** Every one of the 5 verbs' responses carries:
- `schema_version: "m-spatial-v1"`
- `available_fields`: 8-entry array `["positions", "node_size", "comments", "contains", "class_identity", "enabled_state", "node_guid", "member_reference"]`
- `not_available`: array (`[]` for 3 full verbs, `["exec_connectivity"]` for bp_list_entry_points, `["pin_block"]` for bp_show_node — as specified).
- `plugin_enhancement_available: false`

### 6.2 `available_fields` content makes sense

**PASS (with contract interpretation observation).** All 5 verbs advertise the SAME 8-field list — this is M-spatial's **subsystem-level capability advertisement**, not a per-response content breakdown. Handoff §6.2 suggested `bp_subgraph_in_comment` might list `["comment_text", "comment_rect", "contained_nodes", "positions"]` — that's NOT what ships. Each verb's response contains a subset of the 8 advertised fields. Every advertised field is surfaced somewhere across the verb set:
- `positions` → node_pos_x/y on every node
- `node_size` → node_width/height on comments (and available on K2Nodes though often 0)
- `comments` → node_comment on any node that has one (bonus: also surfaces disabled-event reasons)
- `contains` → bp_subgraph_in_comment's `contained` array
- `class_identity` → class_name on every node
- `enabled_state` → "ENodeEnabledState::*" where non-default
- `node_guid` → on every node
- `member_reference` → FMemberReference (member_name + target_class + macro_path)

So the shape is consistent and the contract is coherent. Recommend one-line doc clarification: "available_fields advertises M-spatial subsystem coverage; individual responses contain a subset." Not a test failure.

---

## §7 — FA-δ invariant: plugin-absent first-class

### 7.1 Environment verification

- `project_info.plugins[]` lists 15 plugins; UnrealMCP is **absent**.
- TCP:55557 `connect ECONNREFUSED 127.0.0.1:55557` (per list_toolsets) → no UnrealMCP server running.
- TCP:55558 `connect ECONNREFUSED 127.0.0.1:55558` → no UEMCP plugin running (not even stubbed).
- `D:/UnrealProjects/5.6/ProjectA/ProjectA/Saved/UEMCP/BPCache/` does not exist (neither does the parent `Saved/UEMCP/` dir) → no sidecar.
- No UE editor window open.

### 7.2 All 5 verbs return non-empty correct data

**PASS (5/5).** Re-using §1-§5 calls against BP_OSPlayerR:
- `bp_list_graphs` → 10 graphs ✅
- `bp_find_in_graph` → 7 events matched ✅
- `bp_subgraph_in_comment` → 11 contained nodes ✅
- `bp_list_entry_points` → 17 entries ✅
- `bp_show_node` → full node record ✅

**FA-δ invariant (plugin-absent first-class functional) confirmed empirically.** This is a second independent verification channel (unit tests = channel 1; this manual MCP-wire = channel 2). The M-spatial note that "zero parser code was added" ships cleanly: D50's tagged-fallback already decoded every UPROPERTY needed — confirmed by observing every expected field (FMemberReference.MemberName, CommentColor, NodeWidth/Height, bOverrideFunction, bSelfContext, ENodeEnabledState, NodePosX/Y, NodeGuid) surfacing in the `properties` blocks.

---

## §8 — Cross-verb workflow (golden path)

Task: "what events does BP_OSPlayerR's EventGraph have, and what comment boxes group them?"

Tool calls actually issued:
1. `bp_list_graphs(BP_OSPlayerR)` → EventGraph exists, 53 nodes, comment_count: 9.
2. **Friction**: `bp_find_in_graph(..., node_class: "UEdGraphNode_Comment")` → **0 matches**. Comments aren't K2Nodes, so find verbs skip them. No verb exposes comment export_ids directly.
3. **Workaround**: `inspect_blueprint(BP_OSPlayerR)` (85KB payload, exceeded MCP token cap → auto-saved to tool-results file) + out-of-band JSON parse of `exports[].className === "EdGraphNode_Comment"` → 9 comment indices (29-37).
4. `bp_subgraph_in_comment(29)` → 11 contained (including Events 158, 159).
5. `bp_subgraph_in_comment(30)` → 12 contained (including Event 155, nested child comment 35).
6. `bp_subgraph_in_comment(35)` → 27 contained (including Events 155/156/158/159 and child comments 29/30/31).
7. `bp_list_entry_points(BP_OSPlayerR)` → 17 entries; cross-ref to comments by node_id.
8. `bp_show_node(155)` / `bp_show_node(29)` / `bp_show_node(145)` → full records.

Natural cross-referencing worked: `node_id` is consistent across all 5 verbs + inspect_blueprint's export index. Events 158 (ApplyCharacterType) and 159 (OnGasReady) live under both comment 29 ("Component Initialization…") and its outer comment 35 ("Initialization") — nested pair reported as expected.

### Observations

1. **Missing verb (biggest workflow gap)**: no way to enumerate comments through the new verbs. Options to close:
   - Add a `bp_list_comments({asset_path, graph_name?})` companion verb, OR
   - Extend `bp_find_in_graph` to also accept `UEdGraphNode_Comment` (and other UEdGraphNode subclasses) — i.e., broaden the K2Node-only scope, OR
   - Extend `bp_list_graphs` to return per-graph `comment_ids: [...]` alongside `comment_count` it already returns.
   Without this, users must drop to `inspect_blueprint` which may return >25K tokens on large BPs and require out-of-band JSON parsing.

2. **Response shape consistency is excellent**. `node_id`, `node_pos_x/y`, `node_guid`, `class_name`, `node_name` are uniform across 5 verbs. `properties` block on `bp_show_node` mirrors the decoded UPROPERTY layer directly, which is a strong forward-compatibility signal for M-new S-B (pin block can be added without breaking existing fields).

3. **Bonus data surfacing**: `enabled_state`, `node_comment`, `comment_bubble_*`, `outer_graph_name/type`, and the `extras.self_context` flag on CallFunction ship without being promised — good for caller workflows today.

4. **Manifest naming**: `not_available: ["exec_connectivity"]` / `["pin_block"]` are well-chosen opaque tokens. M-new S-B should simply remove them from the array when implemented, NOT rename them — renaming breaks the forward-compatibility contract callers will code against.

5. **FA-δ design confidence**: the combination of D50 tagged-fallback + class-identity heuristics (M-spatial's "zero parser code" claim) holds end-to-end through a live MCP wire against real ProjectA BPs. This is an empirical second channel confirming the parser's struct-coverage breadth.

---

## Results summary

- **Total PASS**: **18 / 18** across §1-§5 + §6 contract + §7 invariant.
- **Regressions detected**: **none** — all M-spatial unit-test expectations replicated on the MCP wire (53→7 events, 11 contained in comment 29 at (1424×544 / -1296,160), 17 entries).
- **FA-β manifest shape confirmed on all 5 verbs?**: **YES** (all carry schema_version/available_fields/not_available/plugin_enhancement_available).
- **FA-δ invariant (plugin-absent first-class) confirmed?**: **YES** (no plugin, no editor, no sidecar; all 5 verbs ship non-empty correct data).
- **Unexpected behaviors**:
  1. §1.3 returns raw ENOENT instead of structured `{available: false, reason: "asset_not_found"}` — not a crash, but a polish candidate for edge consistency.
  2. All 5 verbs return the *same* 8-entry `available_fields` list (subsystem coverage, not per-response content). Coherent but the handoff's §6.2 illustrative example `["comment_text", "comment_rect", …]` doesn't match shipping shape — clarify in spec doc.
  3. Offline toolset has **21 tools**, not the 20 the handoff predicted (pre-M-spatial baseline was 16 offline per CLAUDE.md header, not 15 — off-by-one in handoff pre-flight count only).
- **Workflow observations from §8**:
  - No verb enumerates comment node_ids — users must fall back to `inspect_blueprint` (large payload) + JSON parsing. Recommend `bp_list_comments` verb OR broadening `bp_find_in_graph` to accept `UEdGraphNode_Comment`.
  - `inspect_blueprint` output (85KB / 275 exports) exceeds MCP token limit — pre-existing ergonomics issue, not M-spatial's, but exacerbates the above gap.
  - Response shapes compose naturally via shared `node_id` key; `properties` block on `bp_show_node` is a clean surface M-new S-B can extend without breaking.

---

## For M-new S-B-base

- **Do NOT rename manifest tokens** `pin_block` or `exec_connectivity` — just remove them from `not_available[]` when the pin-aware + exec-aware implementations land. Callers code against the literal strings per FA-β forward-compatibility.
- The `pins: []` placeholder array in `bp_show_node` is the correct extension point. Populate in-place with the pin records; don't introduce `pins_v2` or move to a new field.
- `available_fields` advertises M-spatial subsystem coverage. When M-new adds pin/exec coverage, expect to append new tokens (`pin_schema`, `exec_graph`, or similar) to `available_fields` — don't reshape the existing 8 tokens.
- The comment-enumeration gap is a real friction point for composition; consider adding `comment_ids: [...]` to `bp_list_graphs` per-graph rows as a low-cost companion, or shipping a `bp_list_comments` verb alongside your changes.
