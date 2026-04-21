# M-new S-B-base Worker — Pin-block parser + LinkedTo walker

> **Dispatch**: Fresh Claude Code session. **Hard-gated on Oracle-A landing** — needs the fixture oracle JSONs under `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/` (or wherever Oracle-A committed them) as differential ground truth.
> **Type**: Implementation — JS byte parser extension to `uasset-parser.mjs` + LinkedTo graph walker + differential test harness. Pure offline; zero plugin code touched.
> **Duration**: 4-6 sessions (per D58 §Q5.1 / §Q5.3 sub-worker split). Base pin-block RE is 3-4 sessions; LinkedTo resolution is 1-2 sessions.
> **D-log anchors**: D58 (re-sequence, S-B primary M-new), D55 (S-B cost breakdown, 19-type skeletal scope), D52 (edge-topology offline near-parity goal), D50 (tagged-fallback UPROPERTY coverage — reusable scaffolding), D48 (S-A skeletal shipped + 19-type envelope), D45 (L3A full-fidelity EDITOR-ONLY — you are NOT doing L3A), D59 (M1 scaffold landed), D61 (gate verified).
> **Deliverable**: byte-level `FEdGraphPin` parser emitting `{pins: [{pin_id, direction, linked_to: [{node_guid, pin_id}]}]}` per K2Node, differentially validated against Oracle-A JSONs on all curated fixtures. Unblocks the S-B-dependent verbs (`bp_trace_exec`, `bp_trace_data`, `bp_neighbors` edge mode, `bp_show_node` pin completion, `bp_list_entry_points` precision) that Verb-surface worker ships next.

---

## Mission

You are building the single hardest JS worker in the Phase 3 roadmap. Reverse-engineer the `UEdGraphNode::Serialize()` pin-block binary layout in UE 5.6, implement a pin reader in `server/uasset-parser.mjs`, resolve the LinkedTo pin-ID edge table into a source-node→target-node graph, and prove correctness against Oracle-A's fixture JSONs.

**This is the foundation** for D52 edge-topology offline near-parity. Under D58's "MCP-first, plugin-enhances" framing, offline pin-topology is first-class — the enhancement layer (M-enhance) augments but does not enable your output.

**Scope envelope**: 19-type skeletal K2Node set per D48. You are NOT doing L3A full-fidelity (D45-locked editor-only). You are NOT doing UE 5.7 delta (S-B-overrides, next sub-worker).

---

## Scope — in

### §1 Prerequisites — ALL SATISFIED AS OF 2026-04-21 (commit `70f8369`)

Oracle-A fully shipped. Current on-disk state verified:

- **Commandlet**: `plugin/UEMCP/Source/UEMCP/Private/Commandlets/DumpBPGraphCommandlet.{h,cpp}` + `EdgeOnlyBPSerializer.{h,cpp}` (280 LOC, clean 20.66s build)
- **Fixture corpus** at `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/`:
  - `BP_OSPlayerR.oracle.json` — 204 nodes / 596 edges (primary target, densest)
  - `BP_OSControlPoint.oracle.json` — 182 nodes / 330 edges
  - `TestCharacter.oracle.json` — 11 nodes / 24 edges (smallest with edges)
  - `BP_OSPlayerR_Child.oracle.json` + `_Child1.oracle.json` + `_Child2.oracle.json` — 6 nodes / 4 edges each (inheritance triple)
- **Contract docs**: `fixtures/README.md` (oracle contract + edge cases) and `fixtures.txt` (corpus manifest + rationale + regeneration recipe)
- **M1 scaffold**: `plugin/UEMCP/Source/UEMCP/Private/MCPServerRunnable.{h,cpp}` + D57 commandlet gate verified end-to-end (D61). You don't touch plugin code; listed for orientation.
- **Parser state**: `server/uasset-parser.mjs` has D50 tagged-fallback + 12 engine-struct handlers + TMap/TArray/TSet containers. You extend; do not replace.
- **Helper**: `withAssetExistenceCheck` exported from `offline-tools.mjs` (EN-9 commit `1bc3e8b`) — wrap `extractBPEdgeTopology` with it.

**First action before writing ANY parser code**:

1. Read `fixtures/README.md` end-to-end — the oracle contract + edge cases are load-bearing.
2. Read `fixtures.txt` — understand why each fixture is in the corpus and what 7 BPs were deliberately excluded (and why).
3. Run `grep '"class_name"' plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/*.oracle.json | sort -u` to inventory empirical K2Node class-name coverage across the corpus. Compare against §3's 19-type list — confirm which types your differential surface actually exercises. Any 19-type K2Node absent from the corpus is format-extrapolated, not format-verified.
4. `cat plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/BP_OSPlayerR.oracle.json | head -60` — get a visceral feel for the JSON structure (you'll be diffing against this).

If any of the above is absent, something has regressed since D62 — stop and surface to orchestrator.

### §2 Engine-source RE — pin-block binary layout

**Primary sources** (read these before writing any parser code):
- `C:\Program Files\Epic Games\UE_5.6\Engine\Source\Runtime\Engine\Classes\EdGraph\EdGraphNode.h`
- `C:\Program Files\Epic Games\UE_5.6\Engine\Source\Runtime\Engine\Classes\EdGraph\EdGraphNode.cpp` — look for `UEdGraphNode::Serialize()` implementation; this is the canonical byte layout
- `C:\Program Files\Epic Games\UE_5.6\Engine\Source\Runtime\Engine\Classes\EdGraph\EdGraphPin.h` — `UEdGraphPin::Serialize()` + `FEdGraphPinReference`

**Expected layout** per research doc §Q1 (verify empirically):

Pin block emitted as trailer AFTER tagged UPROPERTY block (the one D50 tagged-fallback already iterates). Per-pin binary layout in UE 5.6:

1. `FGuid PinId` — 16 bytes, little-endian uint32×4
2. `FName PinName` — NameMap index (reuse existing FName reader in parser)
3. `FEdGraphPinType PinType` — reference-backed (Agent 11.5 §2.2 confirms CUE4Parse has a port — `FEdGraphPinType.cs`). Fields: PinCategory (FName), PinSubCategory (FName), PinSubCategoryObject (FPackageIndex — reuse existing resolver), ContainerType (enum uint8), bIsReference (bool), bIsConst (bool), bIsWeakPointer (bool), TerminalCategory + TerminalSubCategory + TerminalSubCategoryObject (nested for container terminals).
4. `FString DefaultValue` — length-prefixed FString (existing helper)
5. `FString AutogeneratedDefaultValue` — same
6. `FString DefaultTextValue` — FText actually (verify against source)
7. `UObject* DefaultObject` — FPackageIndex (reuse resolver)
8. `FName PinFriendlyName` — NameMap index, may be empty
9. `FString PinToolTip`
10. `uint8 Direction` — `EEdGraphPinDirection` enum (EGPD_Input / EGPD_Output)
11. `uint32 PinFlags` — bitmask
12. `TArray<FEdGraphPinReference> LinkedTo` — **on-disk BYTES shape**; this is the edge table you resolve in §3
13. `TArray<FEdGraphPinReference> SubPins`
14. `FEdGraphPinReference ParentPin`
15. `FGuid PersistentGuid` — 16 bytes

**D62 load-bearing correction** (discovered by Oracle-A, `EdGraphPin.h:375`): at runtime in memory, `UEdGraphPin::LinkedTo` is `TArray<UEdGraphPin*>` (raw-pointer), NOT `TArray<FEdGraphPinReference>`. `FEdGraphPinReference` is a separate compile-time serialization helper holding `{OwningNode, PinId}`. The shape you read from BYTES is reference-shaped because raw pointers don't persist; the shape an in-memory walker (like Oracle-A's commandlet) sees is pointer-shaped. You and Oracle-A converge on the same edge set via different shapes — S-B-base from reference-shaped byte entries, Oracle-A from pointer-shaped in-memory entries. Your parser's output must match Oracle-A's regardless of shape delta.

`FEdGraphPinReference` layout (what you read from bytes):
- `TWeakObjectPtr<UEdGraphNode> OwningNode` — serialized as FPackageIndex into the owning export
- `FGuid PinId` — 16 bytes

**Verify**: for each field above, write a ~5-line spike reading it off `BP_OSPlayerR`'s export table and diff the extracted pin data against Oracle-A's fixture JSON at `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/BP_OSPlayerR.oracle.json`. Iterate field-by-field; don't try to parse the whole block in one shot.

**Oracle-A fixture gotchas** — read `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/README.md` §Edge cases BEFORE writing parser code. Summary:
- GUID format is 32-hex-no-dashes (e.g., `2F88AE184911A3A1882F7E869C012FCC`). Your parser's output format MUST match exactly or differential tests will fail on formatting alone.
- Self-loops allowed — a pin linking to itself is valid, not a parser bug.
- Orphaned-pin null-check required — some pins have `linked_to: []` legitimately.
- `SubPins` not emitted by Oracle-A — could false-positive for leaf pins if your parser treats empty SubPins as absent.
- Sub-graph dotted-key flattening for collapsed nodes — Oracle-A flattens graph hierarchy; your parser should match.
- Canonical comment node class-name is `EdGraphNode_Comment` (no U prefix) — UE strips U/A prefixes at serialization (discovered empirically by EN-8/9 worker on BP_OSPlayerR EventGraph, 9/9 comments correctly identified at that class-name). Applies to any byte-level class-name matching S-B-base does.

### §3 Parser extension — `server/uasset-parser.mjs`

**Existing entry points to reuse** (grep them first; don't re-implement):
- `readFPackageFileSummary` — header read, name-map offset, export table offset
- `readNameMap` — FName table; FName reads through here
- `readFObjectImport` + `readFObjectExport` — 40/112-byte strides for UE 5.0+
- `resolvePackageIndex` (or `outerIndex` resolver) — FPackageIndex → export → owning NodeGuid
- Tagged-fallback iterator (the D50 self-describing FPropertyTag loop) — runs over UPROPERTY block BEFORE the pin block

**What to add** — a new function alongside the tagged-fallback iterator:

```js
// Parses pin-block trailer AFTER tagged UPROPERTY block for UEdGraphNode exports.
// Byte layout per §2 (field order matters — UE serializes in declaration order).
// Returns one entry per UEdGraphPin, keyed by pin_id for O(1) lookup during resolution.
// Called by existing export parser when export's class name matches known K2Node types.
//
// Output shape (aligned with Oracle's per-pin JSON):
//   {
//     <pin_id_guid>: {
//       direction: "EGPD_Input" | "EGPD_Output",
//       linked_to_raw: [ { owning_node_package_index: <int>, pin_id: <guid> }, ... ],
//       name: <string>,           // for debug/Verb-surface use; oracle doesn't include
//       pin_type_raw: { ... },    // kept for Verb-surface pin-type queries; oracle doesn't include
//     }
//   }
//
// linked_to_raw is still reference-shaped at this stage — resolveLinkedToEdges() in §4 walks
// the export table to produce the node_guid-scoped edge set that matches Oracle's output.
export function parsePinBlock(buffer, offset, context) { ... }
```

**D50 reuse**: the tagged-fallback iterator gives you self-describing UPROPERTY decode for "everything before the pin block." Your function picks up at the post-tags offset and walks the pin array with the layout from §2. Reuse existing helpers for `FName`, `FString`, `FGuid`, `FPackageIndex`.

**Pin count prefix**: `Pins` is emitted as `TArray<UEdGraphPin*>` on the node — in BYTES this becomes a `TArray<FOwnedPin>` (or similar; verify empirically) with a leading `int32 Count`. Each entry is then the per-pin layout from §2.

**Direction byte width**: `EEdGraphPinDirection` is UE's enum; on-disk it serializes as `uint8` (single byte) with values `0 = EGPD_Input`, `1 = EGPD_Output`. Oracle emits strings — convert the byte to string on your side so the differential compares like-to-like.

**Empty `linked_to` handling**: Oracle emits `"linked_to": []` for unconnected pins (verified in fixture — see BP_OSPlayerR pin `77922777418C5E963AEEFA8530744F03`). Your parser must emit the same — don't omit the key.

**19-type skeletal scope** (from D48) — **class names as they appear in BYTES** (UE strips U/A prefix at serialization per D63 EN-8/9 finding, confirmed empirically in Oracle-A output):

`K2Node_CallFunction`, `K2Node_IfThenElse`, `K2Node_VariableGet`, `K2Node_VariableSet`, `K2Node_Event`, `K2Node_CustomEvent`, `K2Node_FunctionEntry`, `K2Node_FunctionResult`, `K2Node_MacroInstance`, `K2Node_ExecutionSequence`, `K2Node_Knot`, `K2Node_DynamicCast`, `K2Node_CreateDelegate`, `K2Node_Timeline`, `K2Node_Switch*`, `K2Node_Composite`, `K2Node_Tunnel`, `K2Node_Return`, `K2Node_InputAction`.

**In C++ source** (EdGraphNode.h, engine documentation) you'll see the UK2Node_ prefix. **In BYTES** (the wire you're parsing) and **in Oracle-A's output** (the JSON you're diffing) the prefix is stripped. Match against the stripped form.

**Empirical fixture coverage**: 13 of 19 types should be exercised by the corpus. Run the grep command in §1 to see exactly which. Types absent from the corpus are format-extrapolated (code can produce the right shape but no fixture verifies it) — flag these in your final report §2.

### §4 LinkedTo resolution — pin-ID graph

After §3 produces raw reference-shaped pin data, resolve into node-scoped edges:

```js
// Input: parsedExports — map of export_index → { nodeGuid, className, pins: {<pin_id>: {...}} }
//        (built by the main export-table walker from §3's parsePinBlock + existing tag iterator)
// Output: Oracle-aligned shape for direct differential comparison
//   {
//     "graphs": {
//       "<graph_name>": {
//         "nodes": {
//           "<node_guid>": {
//             "class_name": "K2Node_CallFunction",
//             "pins": {
//               "<pin_id>": {
//                 "direction": "EGPD_Input",
//                 "linked_to": [ { "node_guid": "<guid>", "pin_id": "<guid>" }, ... ]
//               }
//             }
//           }
//         }
//       }
//     }
//   }
//
// Resolution steps:
// 1. Walk parsedExports; group nodes by their owning UEdGraph (via outer chain).
// 2. For each pin's linked_to_raw[], resolve owning_node_package_index → target export → NodeGuid.
// 3. Silently drop entries where FPackageIndex points to a deleted/missing export
//    (matches Oracle's GetOwningNodeUnchecked() null-check — see README §Edge cases #4).
// 4. For K2Node_Composite collapsed nodes, recurse into sub-graphs and emit dotted keys
//    ("EventGraph.Collapsed") — matches Oracle's flattening per README §Sub-graph nesting.
export function resolveLinkedToEdges(parsedExports) { ... }
```

**Graph grouping**: Oracle top-level key is graph name (e.g., `EventGraph`, `ExecuteAbility`, `UserConstructionScript`). In BYTES each export has an OuterIndex chain that eventually resolves to its owning `UEdGraph` export — walk the outer chain to identify which graph each node belongs to. If this turns out to be ambiguous (multiple authored graphs sharing an outer), verify empirically against Oracle's grouping.

**Self-loops preserved**: per README §Edge cases #2, pins can reference themselves. Do not filter these — Oracle preserves them.

**Cycle-safe walker**: Verb-surface's `bp_trace_exec` calls into graph traversal; your resolver should produce output that downstream walkers can traverse with a `visited: Set<pin_id>`. You don't need to implement the traversal — just make sure the edge set is well-formed (no dangling refs, no dupes).

### §5 Differential test harness

New test file: `server/test-s-b-base-differential.mjs`. Follow the structural pattern of existing suites (e.g., `test-uasset-parser.mjs` is closest in shape).

**Per-fixture diff pattern** (per `fixtures/README.md` §Differential-test pattern):

```js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { extractBPEdgeTopology } from './offline-tools.mjs';

function edgeSetOf(topology) {
  // Flatten oracle/parser shape into a Set of "graph:src_node:src_pin->dst_node:dst_pin" strings.
  // Graph-level key included because the same node_guid can theoretically appear in different
  // collapsed sub-graphs (shouldn't happen but preserves namespace isolation).
  const edges = new Set();
  for (const [graphName, graph] of Object.entries(topology.graphs)) {
    for (const [srcNode, node] of Object.entries(graph.nodes)) {
      for (const [srcPin, pin] of Object.entries(node.pins)) {
        for (const link of pin.linked_to) {
          edges.add(`${graphName}:${srcNode}:${srcPin}->${link.node_guid}:${link.pin_id}`);
        }
      }
    }
  }
  return edges;
}

for (const fixture of FIXTURES) {
  const oracle = JSON.parse(readFileSync(fixture.oracleJsonPath, 'utf8'));
  const parsed = await extractBPEdgeTopology(fixture.assetPath);

  const oEdges = edgeSetOf(oracle);
  const pEdges = edgeSetOf(parsed);

  const missing = [...oEdges].filter(e => !pEdges.has(e));  // parser failed to resolve
  const extra   = [...pEdges].filter(e => !oEdges.has(e));  // parser invented edges (worse)

  assert.deepEqual(missing, [], `${fixture.name}: missing ${missing.length} edges`);
  assert.deepEqual(extra,   [], `${fixture.name}: extra ${extra.length} edges`);
  assert.equal(pEdges.size, oEdges.size, `${fixture.name}: edge count mismatch`);
}
```

**Acceptance threshold**: 100% edge match on all 6 fixtures. ANY mismatch blocks S-B-base ship. Oracle-A is ground truth; if your parser disagrees, your parser is wrong.

**Expected totals** (from fixtures.txt — cross-check these during harness development):
- BP_OSPlayerR: 596 edges
- BP_OSControlPoint: 330 edges
- TestCharacter: 24 edges
- BP_OSPlayerR_Child / _Child1 / _Child2: 4 edges each

Three children should produce near-identical oracle output (per fixtures.txt rationale — stability check for near-identical inheritance); any deviation between them is a family-specific regression signal.

**Test discovery**: wire the new file into `package.json` test rotation. Full rotation must stay green post-landing (baseline: 914).

**Unknown-class tolerance**: per README pseudocode, differential harness should have an `allowUnknownNodeClasses: true` mode for dev iteration — if S-B-base doesn't yet parse every K2Node class present in oracle but the classes it does parse match exactly, that's a successful partial landing. Ship-gate is `allowUnknownNodeClasses: false` on all 6 fixtures.

### §6 Minimum-viable output surface

The Verb-surface worker consumes your output. Ship:

```js
// Exported from offline-tools.mjs — orchestrates parser (uasset-parser.mjs) + resolver.
// Wrapped with withAssetExistenceCheck (EN-9) so ENOENT returns FA-β graceful envelope.
//
// Returns Oracle-aligned shape (see §4) so the differential harness can diff directly:
//   {
//     schema_version: "sb-base-v1",    // YOUR schema version, not Oracle's — Verb-surface can assert on this
//     asset_path: "/Game/...",
//     graphs: {
//       "<graph_name>": {
//         "nodes": {
//           "<node_guid>": {
//             "class_name": "K2Node_CallFunction",
//             "pins": { "<pin_id>": { "direction": "EGPD_Input", "linked_to": [...] } }
//           }
//         }
//       }
//     }
//   }
export function extractBPEdgeTopology(assetPath) { ... }
```

**Placement**: parser primitives (`parsePinBlock`, `resolveLinkedToEdges`) live in `uasset-parser.mjs` as pure byte-level functions. `extractBPEdgeTopology` lives in `offline-tools.mjs` as the orchestrator that handles asset-path → file-bytes → parser-call → resolver-call → output-shape. This matches the D50/offline-tool separation already established in the codebase.

**Scope boundaries**: don't ship verbs (`bp_trace_exec`, `bp_trace_data`, `bp_show_node` pin completion, `bp_neighbors` edge mode, `bp_list_entry_points` precision) — those are Verb-surface's job. Your deliverable is the data function they'll call.

**Explicit non-emits** (align with Oracle's deliberate narrowness per README §Deliberate narrowness):
- No pin default values — different serializers normalize differently; pin-type-oriented tool comes later
- No pin type — edge-topology-only; pin-type fidelity is a separate differential target
- No node position / comment — those come from M-spatial (already shipped)
- No UPROPERTY payload — `read_asset_properties` already handles that

If Verb-surface needs any of the above, they're separate concerns and DIFFERENT functions. Don't bloat `extractBPEdgeTopology`.

### §7 Test baseline + regression

- Current test baseline: **914 assertions** across 8 files (post-EN-8/9, commit `1bc3e8b` / D63). Pre-EN-8/9 reference of 899 is stale. Confirm empirically via the CLAUDE.md-documented rotation before committing.
- S-B-base additions: estimate +40-80 assertions (per-fixture differential + format-level pin-block tests in `test-uasset-parser.mjs`).
- Run full rotation before commit to confirm no regression in D50 tagged-fallback / existing 19-type skeletal.
- `withAssetExistenceCheck` helper from `offline-tools.mjs` (EN-9, commit `1bc3e8b`) — signature `(handler: (projectRoot, params) => Promise<object>) => same-signature-guarded`. Wrap `extractBPEdgeTopology` with it so graceful-degradation matches M-spatial's pattern (FA-β). Helper only catches `err.code === 'ENOENT'`; other errors re-throw — correct behavior for your case.

### §8 Prescriptive checkpoint structure

4-6 sessions is long enough that landing in one shot is risky. Checkpoint commits let the orchestrator verify progress between sessions without forcing you into all-or-nothing dispatches:

| Commit | Scope | Verification |
|---|---|---|
| 1 | Post-tag offset detection for UEdGraphNode exports (no parser yet; just confirm your walker reaches the right byte position for BP_OSPlayerR) | Spike test: offset matches hand-computed position for one node |
| 2 | `parsePinBlock` reading PinId + Direction only (no LinkedTo yet) on BP_OSPlayerR | Partial diff: per-pin direction matches Oracle on ≥1 fixture |
| 3 | Add LinkedTo raw reads (reference-shaped, not resolved) | Raw dump matches byte-level expectations from `EdGraphPin.h` |
| 4 | `resolveLinkedToEdges` — convert FPackageIndex refs to NodeGuid edges on BP_OSPlayerR | Differential harness: 596 edges match for BP_OSPlayerR |
| 5 | Collapsed-node / sub-graph recursion | Differential harness: 100% match on all 6 fixtures |
| 6 | `extractBPEdgeTopology` orchestrator + `withAssetExistenceCheck` wrap + tools.yaml-adjacent tests | Full test rotation green (914 → 954-994 range expected) |

Between checkpoints 2 and 5, surface status if any fixture produces mismatches you can't explain in 30 minutes — don't burn a session on a single unknown.

---

## Scope — out

- **S-B-overrides** (UE 5.6↔5.7 delta buffer, CallFunction backcompat, Switch-variant pin-regeneration). Next sub-worker; dispatches after you ship.
- **Verb-surface** (`bp_trace_exec` et al.). Next sub-worker; consumes your output.
- **Plugin code**. You touch zero files under `plugin/UEMCP/`.
- **v1.1 verbs** (`bp_paths_between`, cycle detection). D41-deferred.
- **L3A full-fidelity** (200+ K2Node types, full UPROPERTY hydration). D45-locked editor-only.
- **MCP server tool registration**. Your output is a function call; yaml + `tools/list` entries are Verb-surface's scope.

---

## Reference files

### Tier 1 — Scope sources
1. `docs/research/phase3-resequence-mcp-first-2026-04-20.md` §Q1 (S-B re-scope, 6.5-10 sessions), §Q5.3 M-new sub-worker split, §Q6.1 pin-block RE specifics.
2. `docs/tracking/risks-and-decisions.md` D58 (re-sequence framing), D55 (cost breakdown), D50 (tagged-fallback design — reusable), D48 (19-type skeletal envelope), D52 (near-parity goal).

### Tier 2 — UE 5.6 engine source
3. `C:\Program Files\Epic Games\UE_5.6\Engine\Source\Runtime\Engine\Classes\EdGraph\EdGraphNode.h`
4. `C:\Program Files\Epic Games\UE_5.6\Engine\Source\Runtime\Engine\Classes\EdGraph\EdGraphNode.cpp` — `UEdGraphNode::Serialize()` is the canonical pin-block byte layout.
5. `C:\Program Files\Epic Games\UE_5.6\Engine\Source\Runtime\Engine\Classes\EdGraph\EdGraphPin.h` — `UEdGraphPin::Serialize()` + `FEdGraphPinReference`.

### Tier 3 — Reference implementations
6. CUE4Parse port (Agent 11.5 §2.2) — `FEdGraphPinType.cs` — use as cross-check for pin type binary layout.
7. UAssetAPI `/ExportTypes/` — secondary cross-check.

### Tier 4 — Existing parser
8. `server/uasset-parser.mjs` — D50 tagged-fallback iterator; your extension plugs in after tag block completes.
9. `server/test-uasset-parser.mjs` — add format-level pin-block assertions here.

### Tier 5 — Oracle-A output (late-binding)
10. Consult Oracle-A worker's final report for: fixture corpus list, oracle JSON path convention, any UE-API surprises flagged for your attention (§7 of Oracle-A final report template).

---

## Success criteria

1. `parsePinBlock()` exported from `uasset-parser.mjs`; handles the K2Node types present in the fixture corpus (expect ≥13 of 19 empirically exercised).
2. `resolveLinkedToEdges()` produces edge set with node_guid-level resolution, drops dangling refs silently (matches Oracle's null-check behavior), handles self-loops correctly, flattens sub-graphs with dotted keys (`EventGraph.Collapsed`).
3. `test-s-b-base-differential.mjs` passes 100% edge match on all 6 fixtures: BP_OSPlayerR (596 edges), BP_OSControlPoint (330), TestCharacter (24), BP_OSPlayerR_Child × 3 (4 each).
4. `extractBPEdgeTopology()` exported from `offline-tools.mjs` wrapped by `withAssetExistenceCheck`; Oracle-aligned output shape (graphs → nodes → pins MAP keyed by id).
5. Full test rotation green: **914** existing + your additions (estimate +40-80).
6. D50 tagged-fallback + existing 19-type skeletal unchanged — zero regressions in tag-block iterator / existing `find_blueprint_nodes` / M-spatial verbs.
7. No plugin files touched. No yaml entries added (Verb-surface's scope).
8. Commits path-limited per D49 to `server/*`: `uasset-parser.mjs`, `offline-tools.mjs`, `test-uasset-parser.mjs`, `test-s-b-base-differential.mjs` (new), optionally `test-phase1.mjs`.

---

## Constraints

- **Desktop Commander for git** (shell: "cmd") — `.git/index.lock` can't be acquired by sandbox bash.
- **Path-limited commits per D49** — scope git adds to `server/*` only. If you touch anything else, surface.
- **`UNREAL_PROJECT_ROOT` env var** — tests need this pointing to ProjectA (`D:/UnrealProjects/5.6/ProjectA/ProjectA`) to locate fixture BPs' raw bytes via the Content/ tree. Existing test rotation commands in CLAUDE.md show the `set UNREAL_PROJECT_ROOT=... && node test-*.mjs` pattern.
- **No AI attribution**.
- **Checkpoint commits per §8 structure** — don't one-shot the whole parser.
- **If Oracle-A's fixture corpus has gaps** (e.g., missing a K2Node type that matters semantically), flag to orchestrator. Corpus changes are Oracle-A's scope; regeneration recipe at `fixtures/fixtures.txt` §Regenerating oracles.
- **Orientation agents OK** — if you need broad code exploration (e.g., "how does the existing export walker call handlers"), dispatch Explore-type agents rather than reading sequentially. Research dispatch pattern per CLAUDE.md.

---

## Biggest load-bearing unknown

Base pin-block RE cost (3-4 sessions) is the variance driver for 4-6 total. If the binary format is more complex than §2 anticipates (e.g., UE has changed `FEdGraphPinType` serialization in 5.6 and Agent 11.5's CUE4Parse reference is for an older version), you land near the 6 end. If it's closer to reference materials, you land near 4. Report cost basis — future S-B-overrides worker uses your cost signal to scope UE 5.7 delta.

**Early-warning signals** (surface to orchestrator if any appear before checkpoint 2):
- Post-tag offset doesn't land at a recognizable boundary (expected: `int32 PinCount` immediately after tag-block `None`-terminator)
- `FEdGraphPinType`'s nested structure in bytes doesn't match CUE4Parse reference
- FName emissions inside pin block don't resolve via existing name-map reader
- FPackageIndex values resolve to non-UEdGraphNode exports (would indicate wrong offset or wrong export-class filter)

Any of these means you've found a UE 5.6 serialization shift not captured in reference materials — re-scope before proceeding.

---

## Final report to orchestrator

Report (keep under 400 words given the scope):
1. Commit SHAs (multiple expected; separate commits for RE spikes, parser body, resolver, differential harness).
2. Which of the 19 skeletal K2Node types are format-verified (empirical match to oracle) vs format-extrapolated (code emits the expected shape but fixture coverage didn't exercise it).
3. Differential test result summary: fixture-by-fixture pass/fail + edge count per fixture.
4. `FEdGraphPinType` binary layout findings — any delta from CUE4Parse reference.
5. Pin-block format variance within UE 5.6 (if any — e.g., delta between BP subclasses like UWidgetBlueprint, UAnimBlueprint).
6. Cost basis: which sub-scopes took longer than estimated; any structural blockers not in the handoff.
7. Hint for S-B-overrides worker: expected 5.7 delta surface area based on what you learned about 5.6's serialization.
8. Hint for Verb-surface worker: any caller-side gotchas in `extractBPEdgeTopology()` output (e.g., cycle handling conventions, how to handle nodes with no pins, etc.).
9. Next action: Verb-surface + S-B-overrides parallelizable dispatches.

If you hit a blocker (pin-block format doesn't match any reference, LinkedTo resolution ambiguous for specific node types, Oracle-A fixture fails to load), surface early — don't iterate past 1 session on a single unknown without a status check.
