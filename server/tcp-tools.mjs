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

let ACTORS_WIRE_MAP = {};
let BLUEPRINTS_WRITE_WIRE_MAP = {};
let WIDGETS_WIRE_MAP = {};

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
  ACTORS_WIRE_MAP = buildWireTypeMap(toolsData, 'actors');
  BLUEPRINTS_WRITE_WIRE_MAP = buildWireTypeMap(toolsData, 'blueprints-write');
  WIDGETS_WIRE_MAP = buildWireTypeMap(toolsData, 'widgets');
}

// ── Actors toolset (tcp-55557) ────────────────────────────────
// 10 tools — contracts: conformance-oracle-contracts.md Sections 1.1–1.11

/**
 * Zod schemas for each actors tool.
 * Derived from conformance-oracle-contracts.md, NOT from tools.yaml stubs.
 *
 * The C++ param name is the key (e.g., "pattern" not "name_pattern").
 * We pass params straight through to the wire, so the Zod field names
 * must match what the C++ handler expects.
 */
export const ACTORS_SCHEMAS = {

  get_actors: {
    description: 'List all actors in current level (with optional class filter)',
    schema: {
      class_filter: z.string().optional().describe('Filter actors by class name (not in C++ handler — reserved for UEMCP Phase 3)'),
    },
    isReadOp: true,
  },

  find_actors: {
    description: 'Find actors by name pattern (case-sensitive substring match)',
    schema: {
      pattern: z.string().describe('Substring to match against actor names'),
    },
    isReadOp: true,
  },

  spawn_actor: {
    description: 'Spawn primitive actor (StaticMeshActor, PointLight, SpotLight, DirectionalLight, CameraActor)',
    schema: {
      type: z.string().describe('Actor type: StaticMeshActor, PointLight, SpotLight, DirectionalLight, CameraActor'),
      name: z.string().describe('Actor name (must be unique in level)'),
      location: Vec3Optional,
      rotation: Vec3Optional,
      scale: Vec3Optional,
    },
    isReadOp: false,
  },

  delete_actor: {
    description: 'Delete actor by exact name',
    schema: {
      name: z.string().describe('Exact actor name'),
    },
    isReadOp: false,
  },

  set_actor_transform: {
    description: 'Set location/rotation/scale on an actor (partial updates OK)',
    schema: {
      name: z.string().describe('Exact actor name'),
      location: Vec3Optional,
      rotation: Vec3Optional,
      scale: Vec3Optional,
    },
    isReadOp: false,
  },

  get_actor_properties: {
    description: 'Get all properties of an actor (detailed JSON)',
    schema: {
      name: z.string().describe('Exact actor name'),
    },
    isReadOp: true,
  },

  set_actor_property: {
    description: 'Set a specific property by name (supports bool, int, float, string, enum)',
    schema: {
      name: z.string().describe('Exact actor name'),
      property_name: z.string().describe('UProperty name on the actor'),
      property_value: z.any().describe('Value to set (JSON type must match UProperty type)'),
    },
    isReadOp: false,
  },

  spawn_blueprint_actor: {
    description: 'Spawn instance of a Blueprint class in the level',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name (looked up under /Game/Blueprints/)'),
      actor_name: z.string().describe('Name for the spawned actor'),
      location: Vec3Optional,
      rotation: Vec3Optional,
      scale: Vec3Optional,
    },
    isReadOp: false,
  },

  focus_viewport: {
    description: 'Move editor camera to a location or actor',
    schema: {
      target: z.string().optional().describe('Actor name to focus on'),
      location: Vec3Optional.describe('World position to focus on (alternative to target)'),
      distance: z.number().optional().describe('Camera offset distance (default 1000)'),
      orientation: Vec3Optional.describe('Camera rotation [pitch, yaw, roll]'),
    },
    isReadOp: false,
  },

  take_screenshot: {
    description: 'Capture editor viewport to PNG file',
    schema: {
      filepath: z.string().describe('Output file path (.png appended if missing)'),
      resolution_x: z.number().int().optional().describe('Screenshot width'),
      resolution_y: z.number().int().optional().describe('Screenshot height'),
    },
    isReadOp: false,
  },
};

/**
 * Execute an actors toolset tool.
 *
 * @param {string} toolName — tools.yaml name (e.g., 'get_actors')
 * @param {object} args — validated params (already through Zod)
 * @param {import('./connection-manager.mjs').ConnectionManager} connectionManager
 * @returns {Promise<object>} — result from the editor (Bridge-unwrapped by ConnectionManager)
 */
export async function executeActorsTool(toolName, args, connectionManager) {
  // Translate tools.yaml name → C++ type string via wire_type map
  const typeString = ACTORS_WIRE_MAP[toolName] || toolName;

  // Determine if this is a read op (cacheable) or write op (skip cache)
  const def = ACTORS_SCHEMAS[toolName];
  const skipCache = def ? !def.isReadOp : true;

  // The C++ handler for get_actors_in_level takes no params,
  // but tools.yaml adds class_filter for future UEMCP Phase 3.
  // Strip it out so the existing plugin doesn't choke on unknown fields.
  let wireParams = { ...args };
  if (toolName === 'get_actors') {
    delete wireParams.class_filter;
  }

  // Send via ConnectionManager (handles queue serialization, caching, error normalization)
  const result = await connectionManager.send('tcp-55557', typeString, wireParams, { skipCache });

  return result;
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

  const result = await connectionManager.send('tcp-55557', typeString, { ...args }, { skipCache });
  return result;
}


// ── Widgets toolset (tcp-55557) ───────────────────────────────
// 7 tools — contracts: conformance-oracle-contracts.md Sections 4, 8
// Known issues: set_text_block_binding BROKEN, add_widget_to_viewport NO-OP

export const WIDGETS_SCHEMAS = {

  create_widget: {
    description: 'Create UMG Widget Blueprint at /Game/Widgets/<name> with root CanvasPanel',
    schema: {
      name: z.string().describe('Widget blueprint name'),
    },
    isReadOp: false,
  },

  add_text_block: {
    description: 'Add text block to widget (requires root CanvasPanel)',
    schema: {
      blueprint_name: z.string().describe('Widget blueprint name'),
      widget_name: z.string().describe('Name for the TextBlock'),
      text: z.string().optional().describe("Initial text, default 'New Text Block'"),
      position: Vec2Optional,
    },
    isReadOp: false,
  },

  add_button: {
    description: 'Add button with child TextBlock to widget (requires root CanvasPanel)',
    schema: {
      blueprint_name: z.string().describe('Widget blueprint name'),
      widget_name: z.string().describe('Button widget name'),
      text: z.string().describe('Button label text'),
      position: Vec2Optional,
    },
    isReadOp: false,
  },

  bind_widget_event: {
    description: 'Bind widget event (e.g. OnClicked) to function in event graph',
    schema: {
      blueprint_name: z.string().describe('Widget blueprint name'),
      widget_name: z.string().describe('Widget to bind event on'),
      event_name: z.string().describe('Event name e.g. OnClicked'),
    },
    isReadOp: false,
  },

  set_text_block_binding: {
    description: 'Set text block data binding (BROKEN — exec pin connection is invalid)',
    schema: {
      blueprint_name: z.string().describe('Widget blueprint name'),
      widget_name: z.string().describe('TextBlock widget to bind'),
      binding_name: z.string().describe('Variable name for the binding'),
    },
    isReadOp: false,
  },

  add_widget_to_viewport: {
    description: 'Show widget in game viewport (NO-OP — returns class path only)',
    schema: {
      blueprint_name: z.string().describe('Widget blueprint name'),
      z_order: z.number().int().optional().describe('Z-order, default 0 (unused — handler is a no-op)'),
    },
    isReadOp: false,
  },

  add_input_action_node: {
    description: 'Add input action event node (legacy Input Actions, NOT Enhanced Input)',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name (works on any BP, not just widgets)'),
      action_name: z.string().describe('Input action name'),
      node_position: Vec2Optional,
    },
    isReadOp: false,
  },
};

export async function executeWidgetsTool(toolName, args, connectionManager) {
  const typeString = WIDGETS_WIRE_MAP[toolName] || toolName;
  const def = WIDGETS_SCHEMAS[toolName];
  const skipCache = def ? !def.isReadOp : true;

  const result = await connectionManager.send('tcp-55557', typeString, { ...args }, { skipCache });
  return result;
}


// ── Tool definition exports ──────────────────────────────────
// server.mjs imports these to register tools with the MCP server.
// Returns { name -> { description, schema, isReadOp } } for each tool.

export function getActorsToolDefs() {
  return ACTORS_SCHEMAS;
}

export function getBlueprintsWriteToolDefs() {
  return BLUEPRINTS_WRITE_SCHEMAS;
}

export function getWidgetsToolDefs() {
  return WIDGETS_SCHEMAS;
}
