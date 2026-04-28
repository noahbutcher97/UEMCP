// Blueprints-write toolset TCP handlers — M3 (D23 oracle retirement).
//
// 15 tools dispatching to the UEMCP custom plugin on TCP:55558. Replaces the
// legacy blueprints-write section of tcp-tools.mjs, which routed to the
// conformance oracle (UnrealMCP plugin BlueprintCommands + BlueprintNodeCommands,
// TCP:55557).
//
// Per conformance-oracle-contracts.md §8.1, the toolset already absorbed the
// 6 BlueprintNodeCommands "orphans" (function_node, variable, self_reference,
// component_reference, connect_nodes, find_nodes) — total 15 endpoints, NOT 21
// as the M3 handoff prose suggested.
//
// Wire-shape parity preserved against the oracle (per docs/specs/conformance-
// oracle-contracts.md §2 + §3) — only the port + P0-1 envelope differ. Wire-
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

// ── Wire-type map (populated by initBlueprintsWriteTools from tools.yaml) ──
// tools.yaml `blueprints-write:` is the single source of truth (D44). Only
// entries where the tools.yaml name differs from the C++ type string are
// stored — identity mappings fall through via `toolName`.

let BLUEPRINTS_WRITE_WIRE_MAP = {};

/**
 * Initialize wire_type map from parsed tools.yaml.
 * Call once from server.mjs after toolsetManager.load().
 * @param {object} toolsData — parsed tools.yaml root object
 */
export function initBlueprintsWriteTools(toolsData) {
  BLUEPRINTS_WRITE_WIRE_MAP = {};
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
    description: 'Create new Blueprint class under /Game/Blueprints/<name>. Other handlers in this toolset accept either a bare asset name or a fully-qualified /Game/... path.',
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
      property_value: z.any().describe('Value — Vector struct accepts [x,y,z] array or scalar broadcast'),
    },
    isReadOp: false,
  },

  compile_blueprint: {
    description: 'Compile a Blueprint (does not report compile errors — see bp_compile_and_report for diagnostics)',
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
      target: z.string().optional().describe('Target class (e.g. GameplayStatics, KismetMathLibrary). Omit to search BP\'s own class.'),
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

  return connectionManager.send('tcp-55558', typeString, { ...validated }, { skipCache: !def.isReadOp });
}

/** Export tool-def shape for server.mjs registration. */
export function getBlueprintsWriteToolDefs() {
  return BLUEPRINTS_WRITE_SCHEMAS;
}
