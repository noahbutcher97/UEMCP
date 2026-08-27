// Blueprints-write toolset TCP handlers.
//
// Blueprints-write tools dispatch to the UEMCP custom plugin on TCP:55558.
//
// The toolset includes six graph-authoring commands (function_node, variable, self_reference,
// component_reference, connect_nodes, find_nodes) — total 15 endpoints, NOT 21
// as the M3 handoff prose suggested.
//
// Wire-type strings remain stable, while the P0-1 envelope provides structured errors. Wire-
// type strings unchanged so migrated callers see no rename churn.
//
// Convention matches actors-tcp-tools.mjs (M3-actors precedent):
// {description, schema, isReadOp} per tool, wire_type translation via
// tools.yaml (`blueprints-write:` toolset), ConnectionManager.send dispatch.

import { z } from 'zod';

// ── Common Zod shapes ──────────────────────────────────────────

const Vec3 = z.array(z.number()).length(3).describe('[x, y, z]');
const Vec3Optional = Vec3.optional();
const Vec2Optional = z.array(z.number()).length(2).optional().describe('[x, y] graph position');
const GraphNameOptional = z.string().optional().describe('Target graph name. Omit for EventGraph; pass a function graph name for function-body edits.');
const AssignmentLiteralValue = z.union([z.number(), z.boolean(), z.string(), Vec3]);
const VariableAssignment = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('literal'),
    value: AssignmentLiteralValue.describe('Literal value for the target variable pin. Supports Number, Boolean, String, and Vector [x,y,z].'),
  }),
  z.object({
    kind: z.literal('variable'),
    source_variable: z.string().describe('Member variable to read and connect into the target variable set node.'),
  }),
]);
const ExecFromOptional = z.object({
  node_id: z.string().describe('Existing source node GUID'),
  pin: z.string().describe('Existing source exec output pin name'),
}).optional();

// ── Wire-type map (populated by initBlueprintsWriteTools from tools.yaml) ──
// tools.yaml `blueprints-write:` is the single source of truth (D44). Only
// entries where the tools.yaml name differs from the C++ type string are
// stored — identity mappings fall through via `toolName`.

let BLUEPRINTS_WRITE_WIRE_MAP = {};
const BLUEPRINTS_WRITE_INTERNAL_WIRE_MAP = {
  add_variable_assignment: 'add_blueprint_variable_assignment',
  set_variable_default: 'set_blueprint_variable_default',
  add_timer: 'add_blueprint_timer',
  show_pin_links: 'show_blueprint_pin_links',
  disconnect_pin: 'disconnect_blueprint_pin',
  delete_nodes: 'delete_blueprint_nodes',
};
const BLUEPRINTS_WRITE_TIMEOUT_OVERRIDES = {
  compile_and_save_blueprint: 15_000,
};

/**
 * Initialize wire_type map from parsed tools.yaml.
 * Call once from server.mjs after toolsetManager.load().
 * @param {object} toolsData — parsed tools.yaml root object
 */
export function initBlueprintsWriteTools(toolsData) {
  BLUEPRINTS_WRITE_WIRE_MAP = { ...BLUEPRINTS_WRITE_INTERNAL_WIRE_MAP };
  const toolset = toolsData?.toolsets?.['blueprints-write'];
  if (!toolset?.tools) return;
  for (const [name, def] of Object.entries(toolset.tools)) {
    if (def.wire_type) {
      BLUEPRINTS_WRITE_WIRE_MAP[name] = def.wire_type;
    }
  }
}

// ── Schemas ────────────────────────────────────────────────────
//
// Field names match the C++ handler param names (params pass straight
// through). Derived from conformance-oracle-contracts.md §2 + §3, NOT
// the tools.yaml `(unstubbed)` placeholders. P0-9 / P0-10 defense-in-
// depth validation runs here so bad shapes never reach the wire (where
// the plugin's TryReadVector3 silently zeros them on shape mismatch).

export const BLUEPRINTS_WRITE_SCHEMAS = {

  create_blueprint: {
    description: 'Create new Blueprint class. Default content path /Game/Blueprints/<name>; pass `path` to override. Other handlers in this toolset accept either a bare asset name or a fully-qualified /Game/... path.',
    schema: {
      name: z.string().describe('Blueprint asset name'),
      parent_class: z.string().optional().describe('Parent class name, default AActor. Supports Pawn/Actor shorthand.'),
      path: z.string().optional().describe('Content package path (e.g. /Game/Custom/Logic). Default /Game/Blueprints/.'),
    },
    isReadOp: false,
  },

  add_component: {
    description: 'Add component to Blueprint (auto-compiles after adding)',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      component_type: z.string().describe('Class name — flexible resolution (StaticMesh, UStaticMeshComponent, etc.)'),
      component_name: z.string().describe('Name for the new component'),
      location: Vec3Optional,
      rotation: Vec3Optional,
      scale: Vec3Optional,
    },
    isReadOp: false,
  },

  set_component_property: {
    description: 'Set property on Blueprint component template',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      component_name: z.string().describe('SCS node variable name'),
      property_name: z.string().describe('UProperty name'),
      property_value: z.any().describe('Value — Vector struct accepts [x,y,z] array or scalar broadcast'),
    },
    isReadOp: false,
  },

  compile_blueprint: {
    description: 'Compile a Blueprint and return diagnostic-quality lifecycle output: succeeded/compiled, error and warning counts, messages, generated-class status, dirty status, and package path.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
    },
    isReadOp: false,
  },

  compile_and_save_blueprint: {
    description: 'Compile a Blueprint with diagnostic output and save it when compilation succeeds.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name or /Game/... path'),
      fail_on_compile_error: z.boolean().optional().default(true)
        .describe('When true, do not save if compile diagnostics contain errors. Default true.'),
    },
    isReadOp: false,
  },

  set_blueprint_property: {
    description: 'Set Blueprint Class Default Object property',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      property_name: z.string().describe('UProperty name on the CDO'),
      property_value: z.any().describe('Value — type coerced via SetUProperty'),
    },
    isReadOp: false,
  },

  set_static_mesh_props: {
    description: 'Configure static mesh and material on component',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      component_name: z.string().describe('Must be a UStaticMeshComponent'),
      static_mesh: z.string().optional().describe('Asset path e.g. /Game/Meshes/Cube'),
      material: z.string().optional().describe('Asset path — applied to slot 0 only'),
    },
    isReadOp: false,
  },

  set_physics_props: {
    description: 'Configure physics simulation on a UPrimitiveComponent',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      component_name: z.string().describe('Must be a UPrimitiveComponent'),
      simulate_physics: z.boolean().optional().describe('Enable/disable physics simulation'),
      mass: z.number().optional().describe('Mass in kg (uses SetMassOverrideInKg)'),
      linear_damping: z.number().optional().describe('Linear damping factor'),
      angular_damping: z.number().optional().describe('Angular damping factor'),
    },
    isReadOp: false,
  },

  set_pawn_props: {
    description: 'Configure pawn settings on CDO (per-property results — can partially succeed)',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      auto_possess_player: z.string().optional().describe('Enum value e.g. Player0 (maps to EAutoReceiveInput::Player0)'),
      use_controller_rotation_yaw: z.boolean().optional().describe('Maps to bUseControllerRotationYaw'),
      use_controller_rotation_pitch: z.boolean().optional().describe('Maps to bUseControllerRotationPitch'),
      use_controller_rotation_roll: z.boolean().optional().describe('Maps to bUseControllerRotationRoll'),
      can_be_damaged: z.boolean().optional().describe('Maps to bCanBeDamaged'),
    },
    isReadOp: false,
  },

  add_event_node: {
    description: 'Add event node (BeginPlay, Tick, etc.) — deduplicates, returns existing GUID if event already exists. Returns pin metadata.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      event_name: z.string().describe('e.g. ReceiveBeginPlay, ReceiveTick'),
      graph_name: GraphNameOptional,
      node_position: Vec2Optional,
    },
    isReadOp: false,
  },

  add_function_node: {
    description: 'Add function call node to a Blueprint graph. Supports graph_name, target class, default pin values, and returns pin metadata. Use KismetMathLibrary/GameplayStatics/etc. for math, vector, comparison, and timer calls.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      function_name: z.string().describe('Function name to call'),
      target: z.string().optional().describe('Target class (e.g. GameplayStatics, KismetMathLibrary). Omit to search BP\'s own class.'),
      graph_name: GraphNameOptional,
      node_position: Vec2Optional,
      params: z.record(z.any()).optional().describe('Default values for function input pins'),
    },
    isReadOp: false,
  },

  add_function_graph: {
    description: 'Create a Blueprint function graph and return the generated FunctionEntry node with pin metadata. Idempotent by graph/function name.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      function_name: z.string().describe('Function graph name to create'),
    },
    isReadOp: false,
  },

  add_variable_get: {
    description: 'Add member variable get node to a target Blueprint graph. Returns pin metadata.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      variable_name: z.string().describe('Member variable name'),
      graph_name: GraphNameOptional,
      node_position: Vec2Optional,
    },
    isReadOp: false,
  },

  add_variable_set: {
    description: 'Add member variable set node to a target Blueprint graph. Returns pin metadata.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      variable_name: z.string().describe('Member variable name'),
      graph_name: GraphNameOptional,
      node_position: Vec2Optional,
      params: z.record(z.any()).optional().describe('Default values for input pins, keyed by pin name'),
    },
    isReadOp: false,
  },

  set_variable_default: {
    description: 'Set a Blueprint member variable default value on the generated CDO and mark the Blueprint modified.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name or /Game/... path'),
      variable_name: z.string().describe('Member variable name'),
      value: AssignmentLiteralValue
        .describe('Default value. Supports Number, Boolean, String, and Vector [x,y,z]. Integer variables require an integral int32 value.'),
      compile: z.boolean().optional().default(false)
        .describe('If true, compile after setting the default. Default false.'),
    },
    isReadOp: false,
  },

  add_variable_assignment: {
    description: 'Add an ergonomic Blueprint variable assignment in a target graph. Supports target_variable = literal and target_variable = source_variable, optional exec wiring, node/pin/link metadata, and requires_compile.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      target_variable: z.string().describe('Member variable written by the assignment set node'),
      assignment: VariableAssignment,
      exec_from: ExecFromOptional,
      graph_name: GraphNameOptional,
      node_position: Vec2Optional,
      compile: z.boolean().optional().describe('If true, compile after authoring. Default false; response still reports requires_compile.'),
    },
    isReadOp: false,
  },

  add_timer: {
    description: 'Create a Blueprint SetTimerByFunctionName setup, optionally inserted from BeginPlay and optionally creating the callback function graph.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name or /Game/... path'),
      callback_function: z.string().describe('Function graph called by the timer'),
      interval: z.number().positive().describe('Timer interval in seconds'),
      looping: z.boolean().optional().default(true).describe('Whether the timer loops. Default true.'),
      create_callback_graph: z.boolean().optional().default(true)
        .describe('Create the callback function graph if missing. Default true.'),
      insert_on_begin_play: z.boolean().optional().default(true)
        .describe('Wire timer setup from ReceiveBeginPlay. Default true.'),
      compile: z.boolean().optional().default(false)
        .describe('If true, compile after authoring. Default false.'),
    },
    isReadOp: false,
  },

  add_control_node: {
    description: 'Add a basic control node to a target Blueprint graph: Branch, Sequence, or Return. Returns pin metadata.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      node_kind: z.enum(['Branch', 'Sequence', 'Return']).describe('Control node kind'),
      graph_name: GraphNameOptional,
      node_position: Vec2Optional,
    },
    isReadOp: false,
  },

  add_cast_node: {
    description: 'Add a Cast node (UK2Node_DynamicCast) to a target Blueprint graph. target_class accepts a bare name (Character), a U/A-prefixed name, or a full object path (/Script/Engine.Character, /Game/Blueprints/BP_Foo.BP_Foo_C). Set pure=true for a cast with no exec pins. Returns pin metadata including the As<Class> output pin.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      target_class: z.string().describe('Class to cast to — bare name, prefixed name, or full object path. Blueprint classes need the _C suffix.'),
      pure: z.boolean().optional().describe('Pure cast (no exec pins, no Cast Failed). Default false.'),
      graph_name: GraphNameOptional,
      node_position: Vec2Optional,
    },
    isReadOp: false,
  },

  add_parent_function_call: {
    description: 'Add a "Call to Parent Function" node (UK2Node_CallParentFunction) — the Super:: call used inside an override. The function must exist on a parent class; calling it on a function the Blueprint declares itself is rejected rather than silently retargeted.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      function_name: z.string().describe('Parent function to call, e.g. ReceiveBeginPlay'),
      graph_name: GraphNameOptional,
      node_position: Vec2Optional,
    },
    isReadOp: false,
  },

  override_parent_member: {
    description: 'Override a member inherited from a parent class. Events (BlueprintImplementableEvent/BlueprintNativeEvent) become an event node in the event graph; overridable functions get a new function graph matching the parent signature. Resolves against the parent chain — never guesses an owning class. Idempotent: returns the existing override if one is already present.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      member_name: z.string().describe('Inherited event or function name to override'),
      node_position: Vec2Optional,
    },
    isReadOp: false,
  },

  add_math_node: {
    description: 'Add a graph-targeted KismetMathLibrary node via stable operation names. Supports numeric add/subtract/multiply/comparisons and vector make/break/add/subtract/multiply/scale/distance. Returns pin metadata.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      operation: z.enum(['Add', 'Subtract', 'Multiply', 'Less', 'Greater', 'LessEqual', 'GreaterEqual', 'MakeVector', 'BreakVector', 'ScaleVector', 'Distance'])
        .describe('Math/vector operation to author'),
      value_type: z.enum(['Float', 'Int', 'Integer', 'Vector']).optional().describe('Operand family. Defaults to Float. Vector comparisons are not supported.'),
      graph_name: GraphNameOptional,
      node_position: Vec2Optional,
      params: z.record(z.any()).optional().describe('Default values for input pins'),
    },
    isReadOp: false,
  },

  add_variable: {
    description: 'Add member variable to Blueprint (5 types supported)',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      variable_name: z.string().describe('Variable name'),
      // W-B (D142): enum-narrowed at the JS layer; BlueprintHandlers.cpp:1008-1029
      // accepts the same closed set with UNSUPPORTED_TYPE on miss. Both
      // 'Integer' and 'Int' are accepted for backward-compat (handler treats
      // them as aliases, line 1012).
      variable_type: z.enum(['Boolean', 'Integer', 'Int', 'Float', 'String', 'Vector'])
        .describe('One of: Boolean, Integer/Int, Float, String, Vector'),
      is_exposed: z.boolean().optional().describe('If true, adds EditAnywhere flag. Default false.'),
    },
    isReadOp: false,
  },

  add_self_reference: {
    description: 'Add Self reference node (UK2Node_Self) to a target graph. Returns pin metadata.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      graph_name: GraphNameOptional,
      node_position: Vec2Optional,
    },
    isReadOp: false,
  },

  add_component_reference: {
    description: 'Add VariableGet node for a named component in a target graph. Returns pin metadata.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      component_name: z.string().describe('Component variable name'),
      graph_name: GraphNameOptional,
      node_position: Vec2Optional,
    },
    isReadOp: false,
  },

  connect_nodes: {
    description: 'Connect two Blueprint graph nodes by pin',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      source_node_id: z.string().describe('Source node GUID string'),
      target_node_id: z.string().describe('Target node GUID string'),
      source_pin: z.string().describe('Pin name on source node'),
      target_pin: z.string().describe('Pin name on target node'),
      graph_name: GraphNameOptional,
    },
    isReadOp: false,
  },

  show_pin_links: {
    description: 'Read link identities from a named Blueprint graph pin. Returns source/target node and pin metadata without mutating the asset.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      node_id: z.string().describe('Node GUID string'),
      pin: z.string().describe('Pin name on node'),
      direction: z.enum(['input', 'output']).optional().describe('Pin direction. Omit to search both directions.'),
      target_node_id: z.string().optional().describe('Optional linked node GUID filter'),
      target_pin: z.string().optional().describe('Optional linked pin name filter'),
      target_direction: z.enum(['input', 'output']).optional().describe('Optional linked pin direction filter. Omit to infer the opposite direction.'),
      graph_name: GraphNameOptional,
    },
    isReadOp: true,
  },

  disconnect_pin: {
    description: 'Disconnect links from a named Blueprint graph pin. Breaks all links on that pin, or a specific target link when target_node_id and target_pin are provided. Reports broken link identities; dry_run reports what would be broken without mutating.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      node_id: z.string().describe('Node GUID string'),
      pin: z.string().describe('Pin name on node'),
      direction: z.enum(['input', 'output']).optional().describe('Pin direction. Omit to search both directions.'),
      target_node_id: z.string().optional().describe('Optional target node GUID for a specific link'),
      target_pin: z.string().optional().describe('Optional target pin name for a specific link'),
      target_direction: z.enum(['input', 'output']).optional().describe('Optional target pin direction. Omit to infer the opposite direction.'),
      graph_name: GraphNameOptional,
      dry_run: z.boolean().optional().default(false)
        .describe('If true, report matching links without disconnecting or compiling. Default false.'),
      compile: z.boolean().optional().default(false)
        .describe('If true, compile after disconnecting. Default false.'),
    },
    isReadOp: false,
  },

  delete_nodes: {
    description: 'Delete one or more Blueprint graph nodes by GUID. Refuses structural nodes such as events and function entry/result nodes unless force=true. Reports node and link preflight details; dry_run reports what would be deleted without mutating.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      node_ids: z.array(z.string()).min(1).describe('Node GUID strings to delete'),
      graph_name: GraphNameOptional,
      force: z.boolean().optional().default(false)
        .describe('Allow deletion of structural event/function entry/result nodes. Default false.'),
      dry_run: z.boolean().optional().default(false)
        .describe('If true, report matching nodes and links without deleting or compiling. Default false.'),
      compile: z.boolean().optional().default(false)
        .describe('If true, compile after deleting nodes. Default false.'),
    },
    isReadOp: false,
  },

  find_nodes: {
    description: 'Find nodes in event graph by type (currently only Event type supported)',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      // W-B (D142): enum-narrowed to the single supported type — pre-W-B
      // unrecognized strings silently returned [] (Gauntlet Finding 4.1
      // silent-success-on-edge-case). Closed-form enum at JS layer + C++
      // dispatch in BlueprintHandlers.cpp:1210-1230 still ships the new
      // UNSUPPORTED_NODE_TYPE error per W-G as defense-in-depth (handler
      // path remains valid for future node_type expansion).
      node_type: z.enum(['Event']).describe("Currently only 'Event' supported"),
      graph_name: GraphNameOptional,
      event_name: z.string().optional().describe('Required when node_type=Event'),
    },
    isReadOp: true,
  },
};

/**
 * Execute a blueprints-write toolset tool against TCP:55558.
 *
 * @param {string} toolName — tools.yaml name (e.g., 'create_blueprint')
 * @param {object} args — raw args (validated here via Zod)
 * @param {import('./connection-manager.mjs').ConnectionManager} connectionManager
 * @returns {Promise<object>} — wire response (Bridge envelope, normalized by ConnectionManager)
 */
export async function executeBlueprintsWriteTool(toolName, args, connectionManager) {
  const def = BLUEPRINTS_WRITE_SCHEMAS[toolName];
  if (!def) throw new Error(`blueprints-write-tcp-tools: unknown tool "${toolName}"`);

  // P0-9 (required-param) / P0-10 (vector shape) — Zod here so bad shapes
  // never hit the wire. The SDK already parses at tools/call, but direct
  // callers (tests, internal reuse) bypass that layer.
  const validated = z.object(def.schema).parse(args);

  // Wire-type translation: tools.yaml name → C++ type string.
  const typeString = BLUEPRINTS_WRITE_WIRE_MAP[toolName] || toolName;

  const sendOpts = { skipCache: !def.isReadOp };
  const timeoutOverride = BLUEPRINTS_WRITE_TIMEOUT_OVERRIDES[toolName];
  if (timeoutOverride !== undefined) {
    sendOpts.timeoutMs = timeoutOverride;
  }

  return connectionManager.send('tcp-55558', typeString, { ...validated }, sendOpts);
}

/** Export tool-def shape for server.mjs registration. */
export function getBlueprintsWriteToolDefs() {
  return BLUEPRINTS_WRITE_SCHEMAS;
}
