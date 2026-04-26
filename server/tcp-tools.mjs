// TCP toolset handlers — Phase 2
//
// Each toolset gets a section with:
//   - Zod param schemas (matching contracts doc, not tools.yaml stubs)
//   - Handler function that validates, translates, and dispatches via ConnectionManager
//   - Tool-def export for server.mjs registration
//
// Name translation (tools.yaml name → C++ type string) is driven by
// wire_type fields in tools.yaml, loaded once via initTcpTools().
//
// Reference: docs/specs/conformance-oracle-contracts.md Sections 1, 3, 4, 6, 7, 8

import { z } from 'zod';

// ── Common Zod shapes ──────────────────────────────────────────

const Vec3 = z.array(z.number()).length(3).describe('[x, y, z]');
const Vec3Optional = Vec3.optional();
const Vec2Optional = z.array(z.number()).length(2).optional().describe('[x, y] position');

// ── Wire-type name maps (populated by initTcpTools) ────────────
// Each maps tools.yaml name → C++ type string. Only entries where
// the two differ are stored; identity mappings use fallback.

// M3 (D23): the actors-toolset and widgets-toolset wire maps moved to
// server/actors-tcp-tools.mjs and server/widgets-tcp-tools.mjs when those
// toolsets flipped to TCP:55558. blueprints-write remains here until the
// M3-blueprints-write sub-worker ships.
let BLUEPRINTS_WRITE_WIRE_MAP = {};

/**
 * Build a wire_type map for a single toolset from parsed tools.yaml.
 * @param {object} toolsData — parsed tools.yaml root
 * @param {string} toolsetName
 * @returns {Record<string, string>} toolName → wireType (non-identity only)
 */
function buildWireTypeMap(toolsData, toolsetName) {
  const map = {};
  const toolset = toolsData?.toolsets?.[toolsetName];
  if (!toolset?.tools) return map;
  for (const [name, def] of Object.entries(toolset.tools)) {
    if (def.wire_type) {
      map[name] = def.wire_type;
    }
  }
  return map;
}

/**
 * Initialize wire_type maps from parsed tools.yaml data.
 * Call once from server.mjs after toolsetManager.load().
 * @param {object} toolsData — parsed tools.yaml root object
 */
export function initTcpTools(toolsData) {
  // actors moved to actors-tcp-tools.mjs (M3, D23). initActorsTools handles its map.
  // widgets moved to widgets-tcp-tools.mjs (M3, D23). initWidgetsTools handles its map.
  BLUEPRINTS_WRITE_WIRE_MAP = buildWireTypeMap(toolsData, 'blueprints-write');
}

// ── Blueprints-write toolset (tcp-55557) ──────────────────────
// 15 tools — contracts: conformance-oracle-contracts.md Sections 3, 6, 8

export const BLUEPRINTS_WRITE_SCHEMAS = {

  create_blueprint: {
    description: 'Create new Blueprint class at /Game/Blueprints/<name>',
    schema: {
      name: z.string().describe('Blueprint asset name'),
      parent_class: z.string().optional().describe('Parent class name, default AActor. Supports Pawn/Actor shorthand.'),
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
      property_value: z.any().describe('Value — special SpringArm handling for Vector/Rotator'),
    },
    isReadOp: false,
  },

  compile_blueprint: {
    description: 'Compile a Blueprint (does not report compile errors)',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
    },
    isReadOp: false,
  },

  set_blueprint_property: {
    description: 'Set Blueprint Class Default Object property',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      property_name: z.string().describe('UProperty name on the CDO'),
      property_value: z.any().describe('Value — type coerced via SetObjectProperty'),
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
    description: 'Add event node (BeginPlay, Tick, etc.) — deduplicates, returns existing GUID if event already exists',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      event_name: z.string().describe('e.g. ReceiveBeginPlay, ReceiveTick'),
      node_position: Vec2Optional,
    },
    isReadOp: false,
  },

  add_function_node: {
    description: 'Add function call node to event graph. Complex resolution — supports target class, default pin values.',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      function_name: z.string().describe('Function name to call'),
      target: z.string().optional().describe('Target class (e.g. GameplayStatics, KismetMathLibrary). Omit to search BP own class.'),
      node_position: Vec2Optional,
      params: z.record(z.any()).optional().describe('Default values for function input pins'),
    },
    isReadOp: false,
  },

  add_variable: {
    description: 'Add member variable to Blueprint (5 types supported)',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      variable_name: z.string().describe('Variable name'),
      variable_type: z.string().describe('One of: Boolean, Integer/Int, Float, String, Vector'),
      is_exposed: z.boolean().optional().describe('If true, adds EditAnywhere flag. Default false.'),
    },
    isReadOp: false,
  },

  add_self_reference: {
    description: 'Add Self reference node (UK2Node_Self) to event graph',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      node_position: Vec2Optional,
    },
    isReadOp: false,
  },

  add_component_reference: {
    description: 'Add VariableGet node for a named component in event graph',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      component_name: z.string().describe('Component variable name'),
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
    },
    isReadOp: false,
  },

  find_nodes: {
    description: 'Find nodes in event graph by type (currently only Event type supported)',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name'),
      node_type: z.string().describe("Currently only 'Event' supported"),
      event_name: z.string().optional().describe('Required when node_type=Event'),
    },
    isReadOp: true,  // read operation — cacheable
  },
};

export async function executeBlueprintsWriteTool(toolName, args, connectionManager) {
  const typeString = BLUEPRINTS_WRITE_WIRE_MAP[toolName] || toolName;
  const def = BLUEPRINTS_WRITE_SCHEMAS[toolName];
  const skipCache = def ? !def.isReadOp : true;

  // P0-9 / P0-10 defense-in-depth parse — see executeActorsTool for rationale.
  const validated = def ? z.object(def.schema).parse(args) : args;

  const result = await connectionManager.send('tcp-55557', typeString, { ...validated }, { skipCache });
  return result;
}


// ── Tool definition exports ──────────────────────────────────
// server.mjs imports these to register tools with the MCP server.
// Returns { name -> { description, schema, isReadOp } } for each tool.
// Note: getActorsToolDefs  lives in actors-tcp-tools.mjs  (M3, D23).
// Note: getWidgetsToolDefs lives in widgets-tcp-tools.mjs (M3, D23).

export function getBlueprintsWriteToolDefs() {
  return BLUEPRINTS_WRITE_SCHEMAS;
}
