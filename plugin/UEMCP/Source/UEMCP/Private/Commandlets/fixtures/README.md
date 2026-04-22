# M-new Oracle-A fixtures

Ground-truth edge-topology oracles for Blueprint pin resolution.

**Produced by**: `UDumpBPGraphCommandlet` (this plugin)
**Consumed by**: `M-new S-B-base` JS byte-parser — differential tests diff the
parser's `LinkedTo` resolution against these golden JSONs.

## Oracle contract for S-B-base

Each `*.oracle.json` file is the output of `UnrealEditor-Cmd.exe -run=DumpBPGraph`
against a single ProjectA Blueprint asset. The commandlet loads the BP through
UE's own `LoadObject<UBlueprint>`, walks every authored `UEdGraph` (ubergraph
pages, function graphs, macro graphs, delegate-signature graphs, plus any
collapsed-node sub-graphs), and emits node + pin + edge topology.

### Top-level shape

```json
{
  "schema_version": "oracle-a-v2",
  "engine_version": "5.6.1-44394996+++UE5+Release-5.6",
  "asset_path": "/Game/...",
  "graphs": { ... }
}
```

### graphs[name].nodes[node_guid]

Keyed by `UEdGraphNode::NodeGuid` (FGuid, 32 hex chars, no dashes —
`FGuid::ToString()` default `Digits` format).

```json
"<NodeGuid>": {
  "class_name": "K2Node_CallFunction",
  "pins": { "<PinId>": { ... } }
}
```

`class_name` is `UEdGraphNode::GetClass()->GetName()` — e.g. `K2Node_CallFunction`,
`K2Node_IfThenElse`, `K2Node_ExecutionSequence`, `K2Node_CustomEvent`,
`K2Node_VariableGet`, `K2Node_VariableSet`, `K2Node_Composite`, etc.

### graphs[name].nodes[...].pins[pin_id]

Keyed by `UEdGraphPin::PinId` (FGuid, same format).

```json
"<PinId>": {
  "name": "<UEdGraphPin::PinName>",  // v2: e.g. "then", "Target", "ReturnValue"
  "direction": "EGPD_Input",         // or "EGPD_Output"
  "linked_to": [
    { "node_guid": "<FGuid>", "pin_id": "<FGuid>" },
    ...
  ]
}
```

`linked_to[]` entries come from walking `UEdGraphPin::LinkedTo` (a
`TArray<UEdGraphPin*>`) and resolving each target to its owning node's
`NodeGuid` + the target pin's `PinId`. Empty array when the pin is
unconnected.

### v2 — pin name field (D68)

`name` is added alongside `pin_id` (the dict key) because post-load pin IDs
for `K2Node_EditablePinBase` subclasses (`FunctionEntry`, `FunctionResult`,
`CustomEvent`) and `K2Node_PromotableOperator` are deterministically-derived
from node context rather than read from disk — they're stable run-to-run but
don't match disk IDs. Pin names ARE stable across this divergence because
they're declared by the node type.

S-B-base's differential harness uses **hybrid ID+name matching**:

1. **Primary pass**: match by `pin_id` (strong identity when it matches — covers
   ~96.5% of pins across the ProjectA corpus).
2. **Fallback pass**: for entries unmatched by ID, match by `(node_guid, name)`
   tuple (covers the ~3.5% K2Node_EditablePinBase + K2Node_PromotableOperator
   divergence).

`pin_id` remains the primary dict key; `name` is a field inside each pin object.

### Sub-graph nesting

Collapsed nodes (`K2Node_Composite`) own child `UEdGraph`s via
`UEdGraph::SubGraphs`. The serializer recurses and flattens them into the
top-level `graphs` map with dotted names — e.g. `EventGraph.Collapsed`
holds the inner content of a collapsed node inside `EventGraph`.

This means S-B-base must also recurse into sub-graphs of collapsed nodes
(or expect the same flat key layout) — otherwise whole sub-graph edges
will be marked as false-negatives in the diff.

## Differential-test pattern (reference for S-B-base worker)

Pseudocode for the JS-side diff:

```js
import { readFileSync } from 'node:fs';

const oracle = JSON.parse(readFileSync(
  'plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/BP_OSPlayerR.oracle.json',
  'utf8'
));

// S-B-base produces the same top-level shape from raw bytes:
const parsed = parseSBEdges(readAssetBytes('/Game/Blueprints/Character/BP_OSPlayerR'));

// The diff is an edge-set comparison, not a structural equality:
//   oracleEdges  = Set of "<src_node>:<src_pin>->..<dst_node>:<dst_pin>"
//   parsedEdges  = same derivation from S-B output
//   missing      = oracleEdges  \ parsedEdges   // S-B failed to resolve
//   extra        = parsedEdges  \ oracleEdges   // S-B invented edges (worse)
assertEdgeSetMatches(oracle, parsed, { allowUnknownNodeClasses: true });
```

Deliberate narrowness of the oracle:
- **No pin default values** — different serializers normalize defaults differently
- **No pin type** — Oracle-A is edge-topology-only; type fidelity is a separate differential target
- **No node position / comment** — cosmetic, not semantic
- **No UPROPERTY payload** — S-B-base already has byte-level parse tests for UPROPERTY via `read_asset_properties`

If you need any of those, they come from a different oracle (forthcoming
from M-enhance's production `DumpBPGraphCommandlet` which emits the full
narrow-sidecar schema — compile errors, reflection flags, runtime/compiled
derivatives). Oracle-A and M-enhance's commandlet are **separate
artifacts with different output shapes**; don't conflate.

## Edge cases the S-B-base author should expect

1. **GUIDs with hex leading zeros** — `FGuid::ToString()` default format is
   32 hex digits, no hyphens, fixed-width. Parse as strings, compare as strings —
   don't try to normalize to RFC 4122 dashed form before diffing.
2. **Self-loops allowed** — a pin can technically be in its own LinkedTo list
   (rare but permitted by UE). Oracle preserves them.
3. **SubPins not emitted** — `UEdGraphPin::SubPins` (split-pin children) are not
   serialized separately; only the parent pin's `LinkedTo` is walked. If
   S-B-base emits sub-pin rows, it will produce "extra" false-positives
   under the current oracle. Either suppress sub-pin rows or extend
   Oracle-A v2 to include them.
4. **Orphaned pins** — UE sometimes produces pins with `LinkedTo` referencing
   a now-deleted node. The serializer's `Linked->GetOwningNodeUnchecked()`
   null-check handles this — dangling refs are silently dropped.
5. **Recursion depth** — deeply-nested collapsed nodes produce dotted keys
   like `EventGraph.Collapsed.Collapsed_0`. ProjectA BPs tested so far nest
   at most 2 levels; no depth limit is enforced in the serializer.

See `fixtures.txt` for the corpus manifest and per-BP rationale.
