// TCP toolset handlers — Phase 2
//
// Each toolset gets a section with:
//   - Name translation table (tools.yaml name → C++ type string)
//   - Zod param schemas (matching contracts doc, not tools.yaml stubs)
//   - Handler function that validates, translates, and dispatches via ConnectionManager
//
// Reference: docs/specs/conformance-oracle-contracts.md Sections 1, 6, 7

import { z } from 'zod';

// ── Common Zod shapes ──────────────────────────────────────────

const Vec3 = z.array(z.number()).length(3).describe('[x, y, z]');
const Vec3Optional = Vec3.optional();
const Vec2Optional = z.array(z.number()).length(2).optional().describe('[x, y] position');

// ── Actors toolset (tcp-55557) ────────────────────────────────
// 10 tools — contracts: conformance-oracle-contracts.md Sections 1.1–1.11
// Name mapping: conformance-oracle-contracts.md Section 7.1

/**
 * Map from tools.yaml tool name → C++ type string on the wire.
 * Direct matches omitted (identity mapping).
 */
const ACTORS_NAME_MAP = {
  'get_actors':  'get_actors_in_level',
  'find_actors': 'find_actors_by_name',
  // spawn_actor, delete_actor, set_actor_transform, get_actor_properties,
  // set_actor_property, spawn_blueprint_actor, focus_viewport, take_screenshot
  // are all identity mappings (tools.yaml name === C++ type string)
};

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
  // Translate tools.yaml name → C++ type string
  const typeString = ACTORS_NAME_MAP[toolName] || toolName;

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


// ── Tool definition export ────────────────────────────────────
// server.mjs imports this to register tools with the MCP server.
// Returns { name → { description, schema, isReadOp } } for each tool.

export function getActorsToolDefs() {
  return ACTORS_SCHEMAS;
}
