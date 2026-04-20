# M-new Oracle-A Worker — DumpBPGraph differential-test commandlet

> **Dispatch**: Fresh Claude Code session. **Dispatches AFTER M1's scaffold commit lands** — needs `plugin/UEMCP/*` skeleton to exist. Parallelizes with M1's TCP runnable work (different subdirectories in the same plugin tree).
> **Type**: Implementation — plugin C++ commandlet + narrow edge-only serializer. Dev-only test infrastructure, NOT end-user tool.
> **Duration**: 0.5-1 session (~1-2 hours).
> **D-log anchors**: D58 (re-sequence, S-B primary, bootstrap oracle required), D57 (commandlet gate constraint preserved), D45 (L3A full-fidelity EDITOR-ONLY — skeletal subset scope).
> **Deliverable**: A minimal `UDumpBPGraphCommandlet` that emits `{node_id: [linked_to_pin_ids]}` JSON for a curated fixture BP set. This becomes the differential-test oracle validating M-new S-B-base's byte-level pin parser.

---

## Mission

Ship a narrow plugin commandlet that serves ONE purpose: emit pin-edge topology from UE's own deserialized `UEdGraph` pipeline, so M-new S-B-base (JS byte parser) has a ground-truth oracle to diff against during development.

**This is development infrastructure, not product functionality.** The output is consumed by S-B's test harness, not by end-user agents. It ships under `plugin/UEMCP/Source/UEMCP/Private/Commandlets/` (or an even more scoped `TestFixtures/` subdirectory).

**Why this isn't M-enhance** (per D58 amendment of D57): M-enhance will later ship a production `DumpBPGraphCommandlet` that emits the full narrow-sidecar schema (compile errors, reflection flags, runtime/compiled derivatives). Oracle-A's commandlet is deliberately narrower — just `{node_id: [pin_ids]}` — because its job is differential correctness validation, not sidecar production. Both commandlets share the `!FApp::IsRunningCommandlet()` gating concern and the narrow serializer pattern, but they're separate artifacts with different output shapes.

---

## Scope — in

### §1 Plugin prerequisites

This handoff assumes M1's **scaffold commit** has landed. That commit establishes:

- `plugin/UEMCP/UEMCP.uplugin`
- `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs`
- `plugin/UEMCP/Source/UEMCP/Public/UEMCPModule.h`
- `plugin/UEMCP/Source/UEMCP/Private/UEMCPModule.cpp` — with `!FApp::IsRunningCommandlet()` gate in `StartupModule`

If M1's scaffold commit hasn't landed yet, **stop and surface to orchestrator**. Do not scaffold the plugin yourself — that's M1's scope, and dual-scaffolding will collide on Build.cs edits.

Verify scaffold exists: `git log --oneline -20 | grep -i scaffold` or `ls plugin/UEMCP/Source/UEMCP/`.

### §2 Commandlet skeleton

Create `plugin/UEMCP/Source/UEMCP/Private/Commandlets/DumpBPGraphCommandlet.h/.cpp`.

```cpp
// UDumpBPGraphCommandlet — emits {node_id: [linked_to_pin_ids]} for a BP path
UCLASS()
class UDumpBPGraphCommandlet : public UCommandlet
{
  GENERATED_BODY()
public:
  UDumpBPGraphCommandlet();
  virtual int32 Main(const FString& Params) override;
};
```

Expected invocation:

```cmd
UnrealEditor-Cmd.exe ProjectA.uproject -run=DumpBPGraph -BP=/Game/Blueprints/Character/BP_OSPlayerR -Out=<path>.oracle.json -unattended -nop4 -nosplash -stdout 2>&1
```

Parameters (parse from `Params` string):
- `-BP=<path>` — `/Game/...` asset path (required)
- `-Out=<path>` — output JSON file (required; absolute or project-relative)
- `-Pretty` — optional flag for human-readable JSON

Exit codes:
- 0 — success
- 1 — parameter parse error
- 2 — BP load failure
- 3 — JSON write failure

### §3 Narrow edge-only serializer

Create `plugin/UEMCP/Source/UEMCP/Private/Commandlets/EdgeOnlyBPSerializer.h/.cpp` (shared scope — M-enhance's production serializer may later share or derive from this pattern, but not yet).

Serialize logic:

1. Load the BP via `LoadObject<UBlueprint>` — returns `UBlueprint*` or nullptr.
2. Walk graph list: `UbergraphPages`, `FunctionGraphs`, `UserConstructionScript` + any macro graphs. Each graph is `UEdGraph*`.
3. For each node `UEdGraphNode* Node` in `Graph->Nodes`:
   - Record `NodeGuid` as the node identifier (stable across loads per UE convention).
   - For each `UEdGraphPin* Pin` in `Node->Pins`:
     - Record `Pin->PinId` (FGuid).
     - For each `FEdGraphPinReference Ref` in `Pin->LinkedTo`:
       - Resolve to `{owning_node_guid: <guid>, pin_id: <guid>}`.
4. Output format:

```json
{
  "schema_version": "oracle-a-v1",
  "engine_version": "5.6.1-44394996",
  "asset_path": "/Game/Blueprints/Character/BP_OSPlayerR",
  "graphs": {
    "<graph_name>": {
      "nodes": {
        "<NodeGuid>": {
          "class_name": "K2Node_CallFunction",
          "pins": {
            "<PinId>": {
              "direction": "EGPD_Input",
              "linked_to": [
                { "node_guid": "<guid>", "pin_id": "<guid>" }
              ]
            }
          }
        }
      }
    }
  }
}
```

**Deliberate narrowness**: no pin default values, no pin type, no node position, no UPROPERTY payload. Just `{node: {pin: [linked_to]}}`. S-B-base compares its LinkedTo resolution against this output; every other field is out-of-scope for the oracle.

### §4 Fixture corpus

Curate 5-10 ProjectA BPs that cover a range of node types and graph topologies. Candidates:

- `/Game/Blueprints/Character/BP_OSPlayerR` — construction script + event graph + functions (the BP the manual tester + research agents all used)
- `/Game/Blueprints/Character/BP_OSPlayerR_Child1` — inheritance chain
- At least one BP with a lot of `K2Node_CallFunction` nodes (dense edge set)
- At least one BP with `K2Node_IfThenElse` / `K2Node_ExecutionSequence` (control flow)
- At least one BP with custom events + variable gets/sets
- At least one small BP (5-20 nodes) for fast iteration during S-B dev
- At least one large BP (100+ nodes) for performance/edge-density testing

Document the corpus list in a fixture manifest — `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures.txt` or similar. Include rationale per BP.

### §5 Commandlet invocation + output verification

Run the commandlet against the curated corpus, verify:

1. Clean exit code 0 on all fixtures.
2. JSON parses (use `jq` or any JSON validator).
3. `schema_version` + `engine_version` present.
4. Each graph has non-zero nodes.
5. At least one LinkedTo edge present per fixture (spot-check a known call-chain BP).
6. Wall-clock per BP: expect 5-17s cold per M-alt §Q1. Warm invocation (engine cache primed) should be sub-second for `LoadObject` part.

Commit the fixture oracle outputs under `plugin/UEMCP/Source/UEMCP/Private/Commandlets/fixtures/` or similar — they become golden references for S-B-base's differential tests.

### §6 Test harness integration (optional — document, don't implement)

Document how the MCP server's JS tests will consume Oracle-A output for differential validation. Something like:

```js
// In M-new S-B-base tests (future worker):
const oracleJson = readFileSync('plugin/.../fixtures/BP_OSPlayerR.oracle.json');
const sbJson = parseSBEdges(readAssetBytes('/Game/Blueprints/Character/BP_OSPlayerR'));
assertEdgeSetMatches(oracleJson, sbJson);
```

Don't implement the JS side here — that's M-new S-B-base's worker. Just leave a README or comment in the fixtures directory explaining the contract so the S-B-base worker knows the expected interface.

---

## Scope — out

- **No end-user tool**. This commandlet is dev-infra, not a yaml-declared tool. No `tools.yaml` entry.
- **No full sidecar schema**. That's M-enhance's production commandlet.
- **No pin default values, pin type, node position, or UPROPERTY payload**. Just edges.
- **No JS parser**. M-new S-B-base reads the oracle JSON + writes its own parser.
- **No `MCPServerRunnable` or TCP scaffolding**. That's M1.
- **No save-hook delegate**. That's M-enhance.
- **No editor-menu command**. That's M-enhance.
- **No test-mcp-wire.mjs integration**. Leave the JS integration to the S-B-base worker.

---

## Reference files

### Tier 1 — Scope sources
1. `docs/research/phase3-resequence-mcp-first-2026-04-20.md` §Q1 (oracle-candidate analysis), §Q5.3 M-new (Oracle-A scope within sub-worker split).
2. `docs/research/m-alt-commandlet-feasibility-2026-04-20.md` §Q1 (empirical commandlet invocation on ProjectA; verified 5.7-17.5s boot), §Q2 (sizing — 120-180 LOC commandlet + 40 LOC serializer).

### Tier 2 — UE 5.6 reference
3. `Engine/Source/Runtime/Engine/Classes/Commandlets/Commandlet.h` — `UCommandlet` base class.
4. `Engine/Source/Editor/UnrealEd/Private/Commandlets/CompileAllBlueprintsCommandlet.{h,cpp}` — structural reference (359 LOC; ours is narrower). Pattern for arg parsing, BP iteration, error handling.
5. `Engine/Source/Runtime/Engine/Classes/EdGraph/EdGraphNode.h` — `UEdGraphNode::Pins`, `NodeGuid`.
6. `Engine/Source/Runtime/Engine/Classes/EdGraph/EdGraphPin.h` — `UEdGraphPin::PinId`, `LinkedTo`, `FEdGraphPinReference`.

### Tier 3 — Plugin scaffold (from M1)
7. `plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs` — add `"UnrealEd"`, `"Kismet"` to dependencies if not already (commandlet + UBlueprint need them).
8. `plugin/UEMCP/Source/UEMCP/Private/UEMCPModule.cpp` — the `!FApp::IsRunningCommandlet()` gate should already be in `StartupModule` from M1's scaffold; verify.

### Tier 4 — D-log anchors
9. `docs/tracking/risks-and-decisions.md` D57 (commandlet constraint origin), D58 (re-sequence context).

---

## Success criteria

1. Plugin compiles cleanly with commandlet added; `MCPServerRunnable` (if M1 has finished it) still starts in interactive-editor mode; TCP listener does NOT bind when commandlet runs (D57 gate verified).
2. `UnrealEditor-Cmd.exe ... -run=DumpBPGraph -BP=/Game/Blueprints/Character/BP_OSPlayerR -Out=./BP_OSPlayerR.oracle.json` produces valid JSON.
3. Output JSON has non-empty `graphs` + at least one `linked_to` edge.
4. Fixture corpus of 5-10 BPs committed; each BP has its oracle JSON committed alongside (optional but recommended for version-controlled reference).
5. README or comment explains the oracle-consumer contract for M-new S-B-base's worker.
6. Clean exit code 0 on all fixtures.
7. Wall-clock performance in the 5-20s cold band per M-alt §Q1.

---

## Constraints

- **Desktop Commander for git** (shell: "cmd") — `.git/index.lock` can't be acquired by sandbox bash. Native Git Bash fine.
- **Path-limited commits per D49** — e.g., `git commit plugin/UEMCP/Source/UEMCP/Private/Commandlets/*.{h,cpp} -m "..."`. Fixture outputs separately.
- **Multiple commits OK** — scaffold deps, commandlet body, serializer, fixtures can land as separate commits.
- **No AI attribution**.
- **Parallel workers possible**: M1 ongoing in `plugin/UEMCP/Source/UEMCP/Private/` (different files — `MCPServerRunnable`, `MCPCommandRegistry`, etc.). Oracle-A in `plugin/UEMCP/Source/UEMCP/Private/Commandlets/`. Zero file overlap beyond the shared `UEMCP.Build.cs` (which may need a `"UnrealEd"` dep added — coordinate by commenting in the commit message if you touch Build.cs so M1 worker knows).

---

## Final report to orchestrator

Report (keep under 300 words):
1. Commit SHAs.
2. Commandlet compile status + invocation wall-clock on BP_OSPlayerR.
3. Fixture corpus: which BPs selected + rationale per.
4. Output JSON sample (snippet of one BP's oracle — 10-20 lines of the `graphs` object).
5. D57 gate verification: `MCPServerRunnable` does NOT bind port in commandlet mode (if M1's TCP runnable exists) OR N/A if M1 hasn't landed that yet.
6. Any UE 5.6 API surprises in `FEdGraphPinReference` / `LinkedTo` resolution.
7. Any edge cases for S-B-base worker to know about (non-obvious pin-ID resolution quirks, graph-nesting patterns, etc.).
8. Next action for orchestrator: M-new S-B-base dispatchable; oracle JSON is the differential test contract.

If you hit a blocker (BP won't load headless, commandlet arg parsing fails, serializer crashes on specific node type), surface it — oracle scope is intentionally narrow so blockers should be few.
