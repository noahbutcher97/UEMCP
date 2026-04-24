# Blueprint Introspection Design

> Source of truth for tool definitions: [tools.yaml](../../tools.yaml)

### Why This Section Exists

Blueprint introspection is the single most important capability for Claude Code/Cowork integration. Without it, Claude can read C++ source code but is blind to Blueprint logic — which in the primary target project contains event graphs, combo state machines, GAS ability graphs, and UI widget trees. NodeToCode solves this for its LLM code-generation use case. UEMCP must match that fidelity and surpass it for Claude's analysis use case.

### NodeToCode Analysis Summary

NodeToCode's data model (from `N2CBlueprint.h`, `N2CNode.h`, `N2CPin.h`, `N2CSerializer.cpp`):

```
FN2CBlueprint
├── FN2CVersion ("1.0.0")
├── FN2CMetadata (name, BlueprintType, BlueprintClass)
├── FN2CGraph[] (name, GraphType, Nodes[], Flows)
│   ├── FN2CNodeDefinition[] (ID, NodeType, Name, MemberParent, MemberName, bPure, bLatent, InputPins[], OutputPins[])
│   │   └── FN2CPinDefinition[] (ID, Name, Type, SubType, DefaultValue, bConnected, bIsReference, bIsConst, bIsArray, bIsMap, bIsSet)
│   └── FN2CFlows
│       ├── Execution: ["N1->N2->N3", "N4->N5"]  (chain strings)
│       └── Data: {"N1.P4": "N2.P3", ...}          (source→target map)
├── FN2CStruct[] (name, members with types)
└── FN2CEnum[] (name, values)
```

**Token Reduction Techniques** (from `N2CSerializer.cpp`):
1. **Short IDs**: Nodes get "N1", "N2"; pins get "P1", "P2". Drastically cuts JSON size.
2. **Omit defaults**: Pins omit `type` if Exec (default), omit `connected`/`reference`/`const`/`array`/`map`/`set` if false, omit `sub_type`/`default_value` if empty. Nodes omit `member_parent`/`member_name`/`comment` if empty, omit `pure`/`latent` if false.
3. **Flows separation**: Instead of embedding connection data in each pin, a top-level `flows` object holds execution chains as compact strings and data connections as a flat map.

**Critical Limitation**: `FN2CNodeCollector` includes `BlueprintEditor.h` — it can ONLY serialize the Blueprint currently open in an editor tab. Cannot load arbitrary Blueprints from disk. Cannot do project-wide queries.

### Comparison: Where UEMCP Matches NodeToCode

| Capability | NodeToCode | UEMCP |
|------------|-----------|-------|
| Graph traversal (UEdGraph → nodes → pins) | ✅ via FN2CNodeCollector | ✅ via LoadObject + UEdGraph iteration |
| Node type classification (80+ types) | ✅ EN2CNodeType enum | ✅ Same K2Node class hierarchy inspection |
| Pin type classification (60+ types) | ✅ EN2CPinType enum | ✅ Same FEdGraphPinType inspection |
| Execution flow chains | ✅ "N1->N2->N3" strings | ✅ Same approach — follow exec pin links |
| Data flow connections | ✅ {"N1.P4": "N2.P3"} map | ✅ Same approach — follow data pin links |
| Pin metadata (ref, const, array, map, set) | ✅ bool flags | ✅ Same source: FEdGraphPinType flags |
| Default values | ✅ Pin.DefaultValue | ✅ Same source: UEdGraphPin::DefaultValue |
| SubType (struct name, class name) | ✅ Pin.SubType | ✅ Same source: PinType.PinSubCategoryObject |
| Graph types (EventGraph, Function, Macro, etc.) | ✅ EN2CGraphType | ✅ Same source: UEdGraph schema + name heuristics |
| Struct/Enum definitions | ✅ FN2CStruct, FN2CEnum | ✅ Same source: Blueprint UserDefinedStructs/Enums |
| Token-efficient JSON | ✅ Short IDs, omit defaults | ✅ We adopt the same techniques |

### Where UEMCP Surpasses NodeToCode

| Capability | NodeToCode | UEMCP |
|------------|-----------|-------|
| **Load any Blueprint from disk** | ❌ Requires open editor tab | ✅ `LoadObject<UBlueprint>(path)` — any asset path |
| **Project-wide queries** | ❌ One BP at a time | ✅ AssetRegistry: "all GA_ Blueprints", "all widgets under /UI/" |
| **Cross-Blueprint references** | ❌ No dependency tracking | ✅ `IAssetRegistry::GetDependencies/Referencers` |
| **UPROPERTY metadata** | ❌ Not serialized | ✅ Replication flags (Replicated, ReplicatedUsing), EditCondition, Categories, Tooltips |
| **Component hierarchy** | ❌ Not serialized | ✅ SCS tree: component classes, attachment, default property overrides |
| **DataTable contents** | ❌ Not supported | ✅ Row struct, all rows as typed JSON |
| **Selective detail levels** | ❌ Always full graph | ✅ `get_blueprint_info` (overview) vs `get_blueprint_graph` (full detail) |
| **Event dispatchers** | ❌ Not explicitly extracted | ✅ Dedicated `get_blueprint_event_dispatchers` with signatures |
| **Class hierarchy queries** | ❌ Not supported | ✅ "All subclasses of UOSGameplayAbility" via AssetRegistry |
| **Asset metadata without loading** | ❌ Not supported | ✅ `get_asset_metadata` reads registry tags without loading UObject |
| **Orphan function discovery** | ❌ Only functions called from focused graph | ✅ Iterates ALL `FunctionGraphs` on UBlueprint — 100% coverage |
| **AnimBP state machines** | ❌ Wrong node class (UK2Node only) | ✅ Traverses `UAnimGraphNode_Base` hierarchy, states, transitions |
| **Widget BP designer tree** | ❌ Not supported | ✅ `UWidgetBlueprint::WidgetTree` + property bindings |
| **All graphs in one call** | ❌ Focused graph + reachable only | ✅ `get_all_blueprint_graphs` returns everything |

### UEMCP Blueprint Serialization Format

UEMCP adopts NodeToCode's proven token reduction techniques and extends them. The JSON format below is what `get_blueprint_graph` returns:

```jsonc
{
  "version": "1.0.0",
  "metadata": {
    "name": "GA_OSComboAttack",
    "type": "Blueprint Class",           // Normal, Const, MacroLibrary, Interface, LevelScript, FunctionLibrary
    "class": "OSGameplayAbility",        // Parent class (cleaned: no SKEL_ prefix, no _C suffix)
    "interfaces": ["AbilityDistanceInterface"],
    "path": "/Game/GAS/Abilities/GA_OSComboAttack"
  },

  // --- Component tree (UEMCP-only, not in NodeToCode) ---
  "components": [
    {
      "name": "DefaultSceneRoot",
      "class": "USceneComponent",
      "parent": null,
      "properties": {}                   // Only non-default UPROPERTY values
    }
  ],

  // --- Variables with replication metadata (UEMCP-only) ---
  "variables": [
    {
      "name": "ComboIndex",
      "type": "Integer",
      "default": "0",
      "category": "Combat",
      "replication": "Replicated",       // None, Replicated, ReplicatedUsing=OnRep_X
      "flags": ["BlueprintReadWrite", "EditAnywhere"]
    }
  ],

  // --- Graphs: matches NodeToCode structure, with enhancements ---
  "graphs": [
    {
      "name": "EventGraph",
      "type": "EventGraph",              // EventGraph, Function, Composite, Macro, Construction, Animation
      "nodes": [
        {
          "id": "N1",
          "type": "event",               // EN2CNodeType-equivalent string
          "name": "ReceiveBeginPlay",
          // Only present if non-empty:
          "member_parent": "Actor",
          "member_name": "ReceiveBeginPlay",
          "comment": "Initialize combo state",
          // Only present if true:
          "pure": true,
          "latent": true,
          "inputs": [
            {
              "id": "P1",
              "name": "Target",
              // "type" omitted if Exec (default, matching NodeToCode)
              "type": "Object",
              "sub_type": "OSGameplayAbility",
              // Only present if non-empty/true:
              "default": "self",
              "connected": true,
              "ref": true,
              "const": true,
              "array": true,
              "map": true,
              "set": true
            }
          ],
          "outputs": [
            { "id": "P2", "name": "Exec" }
            // Exec pin: type omitted (default)
          ]
        }
      ],

      "flows": {
        "exec": ["N1->N2->N3", "N4->N5->N6"],
        "data": {
          "N1.P3": "N2.P1",
          "N3.P2": "N5.P4"
        }
      }
    }
  ],

  // --- User-defined structs and enums (matches NodeToCode) ---
  "structs": [
    {
      "name": "FComboData",
      "members": [
        { "name": "Damage", "type": "Float", "default": "10.0" },
        { "name": "HitReaction", "type": "Enum", "type_name": "EHitReactionType" }
      ]
    }
  ],
  "enums": [
    {
      "name": "EHitReactionType",
      "values": ["None", "Light", "Heavy", "Knockdown"]
    }
  ],

  // --- Event dispatchers (UEMCP-only) ---
  "event_dispatchers": [
    {
      "name": "OnComboEnded",
      "params": [
        { "name": "FinalIndex", "type": "Integer" },
        { "name": "WasInterrupted", "type": "Boolean" }
      ]
    }
  ]
}
```

**Format design rationale**:
- Field names use `snake_case` to match NodeToCode and be JSON-idiomatic
- Short IDs (N1, P1) for nodes and pins — proven by NodeToCode to cut token count significantly
- Omit-defaults pattern: pins omit `type` if Exec, omit all bool flags if false, omit strings if empty
- `flows` separation: execution chains as compact strings, data connections as flat map — avoids embedding connection info redundantly on each pin
- New `components`, `variables`, `event_dispatchers` top-level sections provide the metadata NodeToCode doesn't capture
- `variables` section includes `replication` field — critical for multiplayer code review in the primary target
- `metadata.interfaces` list — needed to understand ability interface contracts

### Detail Levels

Not every use case needs the full graph. UEMCP provides 4 tools at increasing detail:

| Tool | What it returns | When to use |
|------|----------------|-------------|
| `get_blueprint_info` | Metadata + component count + variable count + function list (names only) | Quick overview: "what does this Blueprint do?" |
| `get_blueprint_variables` | Full variable list with types, defaults, replication, categories | Reviewing data layout or replication setup |
| `get_blueprint_functions` | Function signatures with params, return types, flags | Understanding the API surface |
| `get_blueprint_graph` | Full graph JSON (above format) with all nodes, pins, flows | Deep logic analysis, debugging, porting to C++ |

The first three tools use `UBlueprint` metadata and `FBlueprintEditorUtils` — they don't need to traverse `UEdGraph` nodes. Only `get_blueprint_graph` does the expensive full-graph walk.

### Implementation: LoadObject vs NodeCollector

NodeToCode uses `FN2CNodeCollector` which requires `BlueprintEditor.h` and operates on the graph view of the currently open Blueprint. UEMCP takes a different approach:

```cpp
// UEMCP approach — load any Blueprint by path
UBlueprint* BP = LoadObject<UBlueprint>(nullptr, *AssetPath);
if (!BP) { /* return error */ }

// For metadata (get_blueprint_info, get_blueprint_variables, get_blueprint_functions):
// Use BP->GeneratedClass, BP->SimpleConstructionScript, BP->NewVariables, etc.
// No graph traversal needed — fast.

// For full graph (get_blueprint_graph):
for (UEdGraph* Graph : BP->UbergraphPages)  // Event graphs
{
    for (UEdGraphNode* Node : Graph->Nodes)
    {
        UK2Node* K2 = Cast<UK2Node>(Node);
        // Serialize same data as NodeToCode's FN2CNodeCollector
        // but without requiring BlueprintEditor.h
    }
}
for (UEdGraph* Graph : BP->FunctionGraphs)  // Functions
{ /* same traversal */ }
for (UEdGraph* Graph : BP->MacroGraphs)     // Macros
{ /* same traversal */ }
```

**Key advantage**: `LoadObject` works on any Blueprint asset path. No editor tab required. Combined with `IAssetRegistry::GetAssetsByClass`, UEMCP can enumerate and inspect every Blueprint in the project — something NodeToCode fundamentally cannot do.

**Compile dependency note**: UEMCP includes `BlueprintGraph` and `Kismet` modules (see Build.cs in section 6) which provide `UK2Node` and pin type classes. It does NOT include `BlueprintEditor` — that's the module NodeToCode depends on that binds it to the editor tab.

### Node Type Mapping

UEMCP classifies nodes using the same categories as NodeToCode's `EN2CNodeType` (80+ types). Instead of maintaining a parallel enum, UEMCP maps `UK2Node` subclasses to type strings at runtime:

```cpp
FString ClassifyNode(UK2Node* Node)
{
    if (Cast<UK2Node_CallFunction>(Node))           return "call_function";
    if (Cast<UK2Node_VariableGet>(Node))             return "variable_get";
    if (Cast<UK2Node_VariableSet>(Node))             return "variable_set";
    if (Cast<UK2Node_Event>(Node))                   return "event";
    if (Cast<UK2Node_CustomEvent>(Node))             return "custom_event";
    if (Cast<UK2Node_IfThenElse>(Node))              return "branch";
    if (Cast<UK2Node_MacroInstance>(Node))            return "macro_instance";
    if (Cast<UK2Node_DynamicCast>(Node))              return "dynamic_cast";
    if (Cast<UK2Node_MakeStruct>(Node))               return "make_struct";
    if (Cast<UK2Node_BreakStruct>(Node))              return "break_struct";
    if (Cast<UK2Node_Timeline>(Node))                 return "timeline";
    if (Cast<UK2Node_ForEachElementInEnum>(Node))     return "for_each_element_in_enum";
    // ... 70+ more, matching NodeToCode's full taxonomy
    return Node->GetClass()->GetName();  // Fallback: raw class name
}
```

This runtime approach avoids the maintenance burden of keeping a C++ enum in sync with engine changes between UE versions. It also automatically handles any custom `UK2Node` subclasses that project-specific plugins register.

### Pin Type Mapping

Same approach for pin types — map `FEdGraphPinType` fields to strings matching NodeToCode's `EN2CPinType`:

```cpp
FString ClassifyPinType(const FEdGraphPinType& PinType)
{
    FName Category = PinType.PinCategory;
    if (Category == UEdGraphSchema_K2::PC_Exec)     return "Exec";
    if (Category == UEdGraphSchema_K2::PC_Boolean)   return "Boolean";
    if (Category == UEdGraphSchema_K2::PC_Float)     return "Float";
    if (Category == UEdGraphSchema_K2::PC_Int)       return "Integer";
    if (Category == UEdGraphSchema_K2::PC_Int64)     return "Integer64";
    if (Category == UEdGraphSchema_K2::PC_String)    return "String";
    if (Category == UEdGraphSchema_K2::PC_Object)    return "Object";
    if (Category == UEdGraphSchema_K2::PC_Struct)    return "Struct";
    if (Category == UEdGraphSchema_K2::PC_Enum)      return "Enum";
    if (Category == UEdGraphSchema_K2::PC_Delegate)  return "Delegate";
    // ... all 60+ types from NodeToCode's EN2CPinType
    return Category.ToString();  // Fallback: raw category name
}
```

### Token Budget Estimates

Based on NodeToCode's production output patterns:

| Blueprint Complexity | NodeToCode JSON | UEMCP `get_blueprint_graph` | UEMCP `get_blueprint_info` |
|---------------------|----------------|---------------------------|---------------------------|
| Simple (10 nodes) | ~800 tokens | ~900 tokens (+variables/components) | ~150 tokens |
| Medium (30 nodes) | ~2,400 tokens | ~2,700 tokens | ~200 tokens |
| Complex (100+ nodes) | ~8,000 tokens | ~9,000 tokens | ~300 tokens |

The overhead for UEMCP's additions (variables, components, event dispatchers) is ~10-15% over NodeToCode's output. The `get_blueprint_info` lightweight endpoint keeps quick lookups under 300 tokens regardless of Blueprint complexity.

### Orphan Function Coverage (NodeToCode Limitation Fix)

**The problem**: NodeToCode's `ExecuteCopyJsonForEditor` calls `Editor->GetFocusedGraph()` — it only processes the graph tab currently in view. Functions reachable from that graph are discovered via `AddGraphToProcess` (following `UK2Node_CallFunction` and `UK2Node_CreateDelegate` links). But functions that exist in the Blueprint but are NOT called from the focused graph are completely invisible.

**Example**: A Blueprint has EventGraph + 5 custom functions. The designer is viewing EventGraph, which calls Function_A and Function_B. Functions C, D, E exist but are only called from other Blueprints (or are under development). NodeToCode's output contains zero information about C, D, E.

**UEMCP fix**: We iterate ALL graph arrays on the UBlueprint object:

```cpp
// ALL event graphs (typically one, but can be multiple)
for (UEdGraph* Graph : BP->UbergraphPages) { SerializeGraph(Graph); }

// ALL function graphs — regardless of whether they're called from EventGraph
for (UEdGraph* Graph : BP->FunctionGraphs) { SerializeGraph(Graph); }

// ALL macro graphs
for (UEdGraph* Graph : BP->MacroGraphs) { SerializeGraph(Graph); }

// Delegate signature graphs
for (UEdGraph* Graph : BP->DelegateSignatureGraphs) { SerializeGraph(Graph); }

// Construction script (if present, from SimpleConstructionScript)
if (BP->SimpleConstructionScript)
{
    // SCS doesn't have a UEdGraph — instead we traverse the component tree
    SerializeComponentHierarchy(BP->SimpleConstructionScript);
}
```

This guarantees 100% coverage of all graphs in a Blueprint, not just the visible one.

### Additional Graph Types Beyond NodeToCode

NodeToCode only handles `UK2Node`-based graphs (Kismet scripting nodes). UE5 has several other graph types that use different node base classes. Here's what UEMCP can additionally cover:

#### Animation Blueprint Graphs (High Priority for the primary target)

The primary target has a `UOSAnimInstance` (420+ line C++ class) with extensive combat state, locomotion, stance tracking, and foot IK. The AnimBP content assets built on this class contain:

| AnimBP Graph Type | Node Base Class | NodeToCode | UEMCP |
|-------------------|----------------|-----------|-------|
| EventGraph (AnimBP) | `UK2Node` (standard Kismet) | ❌ Can't load AnimBP | ✅ `LoadObject<UAnimBlueprint>` works |
| AnimGraph (state machines) | `UAnimGraphNode_Base` | ❌ Wrong node class | ✅ Traverse `UAnimStateMachine` nodes |
| Transition rules | `UAnimGraphNode_TransitionResult` | ❌ Not handled | ✅ Serialize condition graph per transition |
| Blend trees | `UAnimGraphNode_BlendSpace*` | ❌ Not handled | ✅ Read blend parameters and axes |

**AnimBP serialization format** (new tool: `get_animbp_graph`):

```jsonc
{
  "metadata": {
    "name": "ABP_OSCharacter",
    "parent_class": "OSAnimInstance",
    "skeleton": "SK_Mannequin",
    "path": "/Game/Animations/ABP_OSCharacter"
  },
  "state_machines": [
    {
      "name": "Locomotion",
      "states": [
        {
          "name": "Idle",
          "animation": "AS_Idle",               // or blend tree root
          "is_blend_tree": false
        },
        {
          "name": "MovementBlend",
          "is_blend_tree": true,
          "blend_type": "BlendSpace2D",
          "blend_params": ["Speed", "LocomotionAngle"]
        }
      ],
      "transitions": [
        {
          "from": "Idle",
          "to": "MovementBlend",
          "rule_summary": "Speed > 10.0",       // Simplified condition (best-effort)
          "blend_time": 0.2,
          "blend_mode": "Standard"
        }
      ]
    }
  ],
  "event_graph": { /* standard graph format, same as regular BP */ }
}
```

**Implementation note**: `UAnimBlueprint` extends `UBlueprint`. Its `UbergraphPages` contain the standard EventGraph (with UK2Node). The AnimGraph lives in a separate array — `UAnimBlueprint` has anim-specific graph pages that contain `UAnimGraphNode_Base` subclasses instead of `UK2Node`. We need the `AnimGraph` module dependency for this.

#### Widget Blueprint Graphs (High Priority — 169 Widget BPs in the primary target)

Widget Blueprints (`UWidgetBlueprint`) extend `UBlueprint` and add a designer hierarchy:

| Widget BP Data | NodeToCode | UEMCP |
|----------------|-----------|-------|
| EventGraph / Functions | ❌ Can't load Widget BP | ✅ Standard graph traversal |
| Widget hierarchy (designer tree) | ❌ Not handled | ✅ `UWidgetBlueprint::WidgetTree` traversal |
| Bindings (property→function) | ❌ Not handled | ✅ `UWidgetBlueprint::Bindings` array |
| Animations (sequencer tracks) | ❌ Not handled | ⚠️ Limited — can list names/durations |

**Widget BP serialization format** (new tool: `get_widget_blueprint`):

```jsonc
{
  "metadata": {
    "name": "WBP_HUD",
    "parent_class": "OSHUDWidget",
    "path": "/Game/UI/WBP_HUD"
  },
  "widget_tree": [
    {
      "name": "RootCanvas",
      "class": "CanvasPanel",
      "children": [
        {
          "name": "HealthBar",
          "class": "ProgressBar",
          "slot": { "anchors": "TopLeft", "position": [20, 20] },
          "properties": { "Percent": 1.0, "FillColor": "(R=0.2,G=0.8,B=0.2)" }
        },
        {
          "name": "KillFeedOverlay",
          "class": "Overlay",
          "children": [ /* ... */ ]
        }
      ]
    }
  ],
  "bindings": [
    { "property": "HealthBar.Percent", "function": "GetHealthPercent" }
  ],
  "event_graph": { /* standard graph format */ },
  "functions": [ /* standard function list */ ]
}
```

**Implementation note**: `UWidgetBlueprint::WidgetTree` is a `UWidgetTree*` containing `UWidget*` hierarchy. Each widget has a name, class, slot properties (anchors/alignment), and child widgets. The `Bindings` array maps widget properties to Blueprint functions.

#### Material Graphs (Medium Priority — Now In Scope)

Materials use `UMaterialExpression` nodes, not `UK2Node`:

| Material Data | NodeToCode | UEMCP |
|--------------|-----------|-------|
| Expression node graph | ❌ Wrong node class | ✅ `UMaterial::Expressions` array |
| Parameter names/types | ❌ Not handled | ✅ `list_material_parameters` + `get_material_graph` |
| Material instances | ❌ Not handled | ✅ Parent chain + parameter overrides |
| Material functions | ❌ Not handled | ✅ `UMaterialFunction` expression traversal |

Material graphs are structurally simpler than Blueprint graphs (no execution flow — pure data flow). Each `UMaterialExpression` has typed inputs and one output, forming a DAG that feeds into material output pins (BaseColor, Normal, Roughness, etc.).

**Material graph serialization format** (tool: `get_material_graph`):

```jsonc
{
  "metadata": {
    "name": "M_OSCharacter_Base",
    "domain": "Surface",                      // Surface, PostProcess, UI, etc.
    "blend_mode": "Opaque",
    "shading_model": "DefaultLit",
    "path": "/Game/Materials/M_OSCharacter_Base",
    "is_two_sided": false
  },
  "parameters": [
    { "name": "BaseColorTint", "type": "Vector", "default": "(1,1,1,1)", "group": "Color" },
    { "name": "Roughness", "type": "Scalar", "default": "0.5", "group": "Surface" },
    { "name": "DiffuseTexture", "type": "Texture2D", "default": "/Game/Textures/T_Default" }
  ],
  "expressions": [
    { "id": "E1", "class": "TextureSample", "texture": "/Game/Textures/T_CharDiffuse" },
    { "id": "E2", "class": "VectorParameter", "name": "BaseColorTint" },
    { "id": "E3", "class": "Multiply" },
    { "id": "E4", "class": "ScalarParameter", "name": "Roughness" }
  ],
  "connections": {
    "E1.RGB": "E3.A",
    "E2.RGB": "E3.B",
    "E3.Result": "Material.BaseColor",
    "E4.Result": "Material.Roughness"
  },
  "material_functions": ["MF_WindAnimation"]     // Referenced material functions
}
```

**Implementation**: Iterate `UMaterial::Expressions` (TArray of `UMaterialExpression*`). Each expression has `GetInputs()` / `GetOutputs()` and class-specific properties. Connections are stored as `FExpressionInput` structs on each expression's input pins.

#### Animation Asset Introspection (High Priority for the primary target)

Combat timing in the primary target is entirely driven by AnimNotifies on AnimSequences and Montages. The project uses 8 custom AnimNotify classes including `OSAnimNotifyState_GASAttackTrace` (hit detection windows), `OSAnimNotify_ActionComboBuffer` (combo input windows), and `OSAnimNotifyState_OSTrackMotionWarpTarget` (motion warping). Being able to read notify placements and timestamps is critical for debugging combat.

**Anim Sequence serialization format** (tool: `get_anim_sequence_info`):

```jsonc
{
  "metadata": {
    "name": "AS_LightAttack_01",
    "skeleton": "SK_Mannequin",
    "duration": 1.2,
    "num_frames": 36,
    "rate": 30.0,
    "path": "/Game/Animations/Combat/AS_LightAttack_01"
  },
  "notifies": [
    {
      "name": "AttackTrace",
      "class": "OSAnimNotifyState_GASAttackTrace",
      "start_time": 0.15,
      "end_time": 0.45,
      "is_state": true,
      "params": { "TraceChannel": "WeaponTrace", "Radius": 30.0 }
    },
    {
      "name": "ComboWindow",
      "class": "OSAnimNotify_ActionComboBuffer",
      "start_time": 0.3,
      "end_time": 0.8,
      "is_state": true
    },
    {
      "name": "Footstep",
      "class": "OSAnimNotify_Footstep",
      "time": 0.6,
      "is_state": false
    }
  ],
  "curves": [
    { "name": "RootMotionScale", "type": "Float", "num_keys": 5 },
    { "name": "Enable_OrientationWarping", "type": "Float", "num_keys": 2 }
  ],
  "sync_markers": [
    { "name": "LeftFoot", "time": 0.0 },
    { "name": "RightFoot", "time": 0.5 }
  ]
}
```

**Curve asset serialization format** (tool: `get_curve_asset`):

```jsonc
{
  "metadata": {
    "name": "C_CameraBlend_Combat",
    "type": "CurveFloat",
    "path": "/Game/Data/Curves/C_CameraBlend_Combat"
  },
  "keys": [
    { "time": 0.0, "value": 0.0, "interp": "Cubic", "arrive_tangent": 0.0, "leave_tangent": 2.5 },
    { "time": 0.5, "value": 1.0, "interp": "Cubic", "arrive_tangent": 2.5, "leave_tangent": 0.0 },
    { "time": 1.0, "value": 1.0, "interp": "Constant" }
  ]
}
```

#### Editor Utility Blueprints

`UEditorUtilityBlueprint` and `UEditorUtilityWidgetBlueprint` extend `UBlueprint`, so all standard Blueprint introspection (graphs, variables, functions, components) works automatically. UEMCP adds awareness of:
- Whether the utility is a widget (opens a tab) or a simple run action
- Registered editor menu entries
- The `Run` function that can be invoked via `run_editor_utility`

Not found in our target project's C++ source, but Content assets may exist. These are useful for project tooling — custom batch operations, asset validators, etc.

### Updated Tool List — New Tools from Expanded Graph Coverage

Adding 16 new tools to the UEMCP plugin (TCP:55558) across 6 categories:

| # | Tool | Description |
|---|------|-------------|
| 92 | `get_animbp_graph` | AnimBP state machines, transitions, blend trees + EventGraph |
| 93 | `get_widget_blueprint` | Widget hierarchy tree, property bindings + EventGraph |
| 94 | `get_material_graph` | Material expression node graph, connections, parameters |
| 95 | `get_all_blueprint_graphs` | ALL graphs including orphan functions, macros, delegates |
| 96 | `get_anim_sequence_info` | AnimSequence notifies, curves, sync markers with timestamps |
| 97 | `get_montage_full` | Deep montage read: all sections, notifies, slots, blend settings |
| 98 | `get_blend_space` | Blend axes, sample points, interpolation mode |
| 99 | `get_anim_curve_data` | Float/vector/transform curve keyframes from any anim asset |
| 100 | `get_curve_asset` | UCurveFloat/Vector/Color keyframes + UCurveTable |
| 101 | `get_data_asset_properties` | Read all UPROPERTY values from any UDataAsset subclass |
| 102 | `get_string_table` | StringTable key→value entries |
| 103 | `get_struct_definition` | UserDefinedStruct members + UserDefinedEnum values |
| 104 | `get_editor_utility_blueprint` | Editor Utility BP/Widget introspection |
| 105 | `run_editor_utility` | Execute an Editor Utility Blueprint's Run action |
| 106 | `get_niagara_system_info` | NiagaraSystem emitters, user parameters, bounds |
| 107 | `get_audio_asset_info` | SoundCue/SoundWave/AkAudioEvent metadata |

This brings the **New Plugin (TCP:55558) tool count to 64** (after deduplication — see Section 7.0.3) and the **total to 114** (6 always-loaded + 108 in toolsets).

### Updated Plugin Dependencies

```cpp
// Additional module dependencies for expanded graph + visual capture support
PublicDependencyModuleNames.AddRange(new string[] {
    // ... existing deps from section 6 ...
    "AnimGraph",                      // UAnimGraphNode_Base, state machine traversal
    "UMGEditor",                      // UWidgetBlueprint, UWidgetTree access
    "ContentBrowser",                 // UThumbnailManager for asset thumbnails
    "Slate", "SlateCore",            // FWidgetRenderer for editor panel capture
    "RenderCore", "RHI",             // Render targets + ReadPixels for preview renders
});
```

### Visual Capture Design

#### Why Visual Capture Matters

Claude is multimodal — it processes images natively. A screenshot of a Blueprint graph, material node layout, or AnimBP state machine gives Claude spatial/structural understanding that JSON alone cannot convey. For example, a material graph JSON tells Claude "E1 connects to E3.A" but a visual shows the entire data flow topology at a glance.

MCP SDK tool results support **inline image content**: `{ type: "image", data: "<base64 PNG>", mimeType: "image/png" }`. This means UEMCP tools can return images directly in the response without writing temp files. Claude processes them as visual inputs alongside any text/JSON in the same response.

#### Four Tiers of Visual Capture

| Tier | Method | Quality | Speed | Requires |
|------|--------|---------|-------|----------|
| 1. Thumbnails | `UThumbnailManager` → `FObjectThumbnail` → pixels | 256×256, Content Browser quality | Fast (<100ms) | Nothing open |
| 2. Viewport | `FViewport::ReadPixels` | Full resolution, 3D scene | Fast | Editor viewport visible |
| 3. Asset Preview | `FPreviewScene` + offscreen render | High quality, configurable camera | Medium (~500ms) | Asset loaded, no window needed |
| 4. Editor Panel | `FWidgetRenderer::DrawWidget` on Slate panel | Exact editor view (graph, nodes, etc.) | Slow (~1s) | Asset open in editor tab |

#### Tier 1: Asset Thumbnails (tool: `get_asset_thumbnail`)

```cpp
// Get thumbnail for any asset
FAssetData AssetData = AssetRegistry.GetAssetByObjectPath(AssetPath);
FObjectThumbnail* Thumb = ThumbnailTools::GenerateThumbnailForObjectToSaveTo(Asset);
// Thumb->GetImageWidth(), Thumb->GetImageHeight(), Thumb->AccessImageData()
// → FImageUtils::CompressImageArray → base64 encode → return in MCP response
```

Supports batch mode: pass an array of asset paths, get an array of thumbnails. Useful for "show me all GA_ abilities" visual overview.

#### Tier 2: Viewport Screenshot (tool: `get_viewport_screenshot`)

Same as existing plugin's approach but returns base64 inline instead of saving to disk. Also adds:
- Configurable resolution (default: viewport native, max: 4096×4096)
- Optional: specific viewport index (for multi-viewport layouts)

#### Tier 3: Asset Preview Render (tool: `get_asset_preview_render`)

```cpp
// Create offscreen preview scene
FPreviewScene PreviewScene;
PreviewScene.SetLightDirection(FRotator(-45, 30, 0));

// Add asset to scene
UStaticMeshComponent* MeshComp = NewObject<UStaticMeshComponent>();
MeshComp->SetStaticMesh(LoadedMesh);
PreviewScene.AddComponent(MeshComp);

// Render to offscreen target
UTextureRenderTarget2D* RT = NewObject<UTextureRenderTarget2D>();
RT->InitAutoFormat(512, 512);
FCanvas Canvas(RT->GameThread_GetRenderTargetResource(), nullptr, ...);
PreviewScene.GetScene()->GetWorld()->SendAllEndOfFrameUpdates();
// ... render + read back pixels
```

Works for: Static Meshes, Skeletal Meshes (with optional animation pose), Materials (applied to sphere/plane), Particle Systems.

#### Tier 4: Editor Panel Capture (tool: `capture_active_editor_tab`)

```cpp
// Find active editor tab's Slate widget
TSharedPtr<SDockTab> ActiveTab = FGlobalTabmanager::Get()->GetActiveTab();
TSharedPtr<SWidget> Content = ActiveTab->GetContent();

// Render the widget to a render target
FWidgetRenderer WidgetRenderer(true);
UTextureRenderTarget2D* RT = NewObject<UTextureRenderTarget2D>();
RT->InitCustomFormat(Width, Height, PF_B8G8R8A8, false);
WidgetRenderer.DrawWidget(RT, Content.ToSharedRef(), FVector2D(Width, Height), 0.0f);
// Read pixels back
```

**Fragility warning**: This depends on Slate internals which can change between UE versions. The `FWidgetRenderer` API has been stable since UE4.27 but the way editor tabs organize their content widgets varies. We should add version guards and graceful fallback (return error message suggesting computer-use MCP screenshot instead).

#### `get_asset_visual_summary` — Combined Text + Visual

This is a convenience tool that dispatches to the right introspection tool AND the right visual capture tier:

| Asset Type | Text Source | Visual Source |
|------------|-------------|---------------|
| Blueprint | `get_blueprint_info` | Tier 1 thumbnail |
| Material | `get_material_graph` | Tier 3 preview (sphere render) |
| Static Mesh | `get_asset_metadata` | Tier 3 preview (3D render) |
| AnimMontage | `get_montage_full` | Tier 1 thumbnail |
| AnimBP | `get_animbp_graph` | Tier 1 thumbnail (or Tier 4 if open) |
| Widget BP | `get_widget_blueprint` | Tier 1 thumbnail |
| Niagara | `get_niagara_system_info` | Tier 3 preview (particle render) |

Returns a single MCP response containing both the JSON text content and the image content.

#### Relationship with Computer-Use MCP

The user already has the computer-use MCP which can screenshot the entire desktop. The visual capture tools in UEMCP complement it rather than replace it:

| Scenario | Best Tool |
|----------|-----------|
| "What does the level look like?" | UEMCP `get_viewport_screenshot` or computer-use `screenshot` |
| "Show me this asset's thumbnail" | UEMCP `get_asset_thumbnail` (no need to navigate Content Browser) |
| "What does this mesh look like?" | UEMCP `get_asset_preview_render` (offscreen, no window needed) |
| "Show me the Blueprint graph" | Computer-use `screenshot` if editor is open, or UEMCP `capture_active_editor_tab` |
| "Show me the Unreal Editor UI" | Computer-use `screenshot` (full desktop context) |
| "What does the widget look like in-game?" | UEMCP `get_viewport_screenshot` during PIE |

#### Token Budget & Resolution Strategy

**The problem**: Images consume context window tokens. Uncontrolled image capture can burn 5-25% of the context budget, leaving less room for actual code analysis and conversation. Every visual tool must be token-aware by default.

**Resolution defaults** (enforced in Node.js server, not C++ plugin):

| Tool | Default Resolution | Max Resolution | Estimated Tokens |
|------|-------------------|----------------|-----------------|
| `get_asset_thumbnail` | 256×256 | 256×256 | ~200 per image |
| `get_viewport_screenshot` | 768×432 | 1920×1080 | ~400 (default), ~1,600 (max) |
| `get_asset_preview_render` | 512×512 | 1024×1024 | ~400 (default), ~800 (max) |
| `capture_active_editor_tab` | 1024×614 | 2048×1228 | ~800 (default), ~2,000 (max) |
| `get_asset_visual_summary` | Thumbnail (256×256) | Preview (512×512) | ~200-400 |

**Key design decision**: The C++ plugin always renders at the maximum resolution it can. The Node.js server **downscales before base64 encoding** using a fast bilinear resize. This means the C++ plugin doesn't need resolution parameters — the server handles the token budget.

**Downscaling pipeline** (in Node.js server):

```javascript
// After receiving raw PNG bytes from C++ plugin via TCP:
const sharp = require('sharp');  // or manual PNG resize

async function budgetImage(pngBuffer, tool, userMaxWidth) {
  const defaults = {
    get_asset_thumbnail:      { w: 256,  h: 256  },
    get_viewport_screenshot:  { w: 768,  h: 432  },
    get_asset_preview_render: { w: 512,  h: 512  },
    capture_active_editor_tab:{ w: 1024, h: 614  },
    get_asset_visual_summary: { w: 256,  h: 256  },
  };
  const { w, h } = defaults[tool];
  const maxW = userMaxWidth || w;
  
  // Downscale, convert to JPEG for screenshots (lossy but ~60% smaller than PNG)
  const isScreenshot = tool.includes('viewport') || tool.includes('editor_tab');
  const output = await sharp(pngBuffer)
    .resize(maxW, null, { fit: 'inside', withoutEnlargement: true })
    .toFormat(isScreenshot ? 'jpeg' : 'png', { quality: 80 })
    .toBuffer();
  
  return { data: output.toString('base64'), mimeType: isScreenshot ? 'image/jpeg' : 'image/png' };
}
```

**JPEG vs PNG**: Viewport screenshots and editor captures are photographic/complex images — JPEG at quality 80 saves ~60% size over PNG with minimal visual loss. Thumbnails and preview renders with transparency or sharp edges stay as PNG.

**Batch limits**: `get_asset_thumbnail` in batch mode is capped at **20 thumbnails per call** (~4,000 tokens). If the user requests more, the tool returns the first 20 with a message indicating how many were truncated.

**Optional `resolution` parameter**: All visual tools accept an optional `resolution` parameter (`"low"`, `"medium"`, `"high"`) that overrides defaults:

| Level | Thumbnail | Viewport | Preview | Editor |
|-------|-----------|----------|---------|--------|
| `low` | 128×128 | 512×288 | 256×256 | 768×460 |
| `medium` (default) | 256×256 | 768×432 | 512×512 | 1024×614 |
| `high` | 256×256 | 1920×1080 | 1024×1024 | 2048×1228 |

**"Text first, visual second" principle**: The JSON introspection tools (`get_blueprint_graph`, `get_material_graph`, etc.) are the primary interface. They convey complete structural information in ~200-2,000 tokens. Visual tools are supplementary — used when spatial layout, visual appearance, or "does this look right?" matters. The `get_asset_visual_summary` tool embodies this by including the lightweight thumbnail (~200 tokens) alongside the full text introspection, rather than a high-res render.

**Usage guidance for Claude** (to be included in tool descriptions):
- Prefer `get_asset_thumbnail` over `get_asset_preview_render` unless 3D perspective matters
- Never use `capture_active_editor_tab` for information that JSON tools can provide
- Use `resolution: "low"` for quick checks, `"high"` only when explicitly debugging visual issues
- Prefer text introspection + single thumbnail over multiple high-res captures
- When reviewing multiple assets, use batch thumbnails rather than individual preview renders

--