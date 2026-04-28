// Actors toolset TCP handlers — M3 (D23 oracle retirement).
//
// 10 tools dispatching to the UEMCP custom plugin on TCP:55558. Replaces the
// legacy actors section of tcp-tools.mjs, which routed to the conformance
// oracle (UnrealMCP plugin, TCP:55557).
//
// Wire-shape parity preserved against the oracle (per docs/specs/conformance-
// oracle-contracts.md §1) — only the port + P0-1 envelope differ. Wire-type
// strings unchanged so migrated callers see no rename churn.
//
// Convention matches menhance-tcp-tools.mjs (M-enhance precedent):
// {description, schema, isReadOp} per tool, wire_type translation via
// tools.yaml (`actors:` toolset), ConnectionManager.send dispatch.

import { z } from 'zod';

// ── Common Zod shapes ──────────────────────────────────────────

const Vec3 = z.array(z.number()).length(3).describe('[x, y, z]');
const Vec3Optional = Vec3.optional();

// ── Wire-type map (populated by initActorsTools from tools.yaml) ──
// tools.yaml `actors:` is the single source of truth (D44). Only entries
// where the tools.yaml name differs from the C++ type string are stored —
// identity mappings fall through via `toolName`.

let ACTORS_WIRE_MAP = {};

/**
 * Initialize wire_type map from parsed tools.yaml.
 * Call once from server.mjs after toolsetManager.load().
 * @param {object} toolsData — parsed tools.yaml root object
 */
export function initActorsTools(toolsData) {
  ACTORS_WIRE_MAP = {};
  const toolset = toolsData?.toolsets?.actors;
  if (!toolset?.tools) return;
  for (const [name, def] of Object.entries(toolset.tools)) {
    if (def.wire_type) {
      ACTORS_WIRE_MAP[name] = def.wire_type;
    }
  }
}

// ── Schemas ────────────────────────────────────────────────────
//
// Field names match the C++ handler param names (params pass straight
// through). Derived from conformance-oracle-contracts.md §1, NOT the
// tools.yaml `(unstubbed)` placeholders. P0-9 / P0-10 defense-in-depth
// validation runs here so bad shapes never reach the wire (where the
// plugin's TryReadVector3 silently zeros them on shape mismatch).

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
      blueprint_name: z.string().describe('Blueprint asset name (bare — resolved via /Game/Blueprints/ then AssetRegistry) OR fully-qualified /Game/... path'),
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
 * Execute an actors toolset tool against TCP:55558.
 *
 * @param {string} toolName — tools.yaml name (e.g., 'get_actors')
 * @param {object} args — raw args (validated here via Zod)
 * @param {import('./connection-manager.mjs').ConnectionManager} connectionManager
 * @returns {Promise<object>} — wire response (Bridge envelope, normalized by ConnectionManager)
 */
export async function executeActorsTool(toolName, args, connectionManager) {
  const def = ACTORS_SCHEMAS[toolName];
  if (!def) throw new Error(`actors-tcp-tools: unknown tool "${toolName}"`);

  // P0-9 (required-param) / P0-10 (vector shape) — Zod here so bad shapes
  // never hit the wire. The SDK already parses at tools/call, but direct
  // callers (tests, internal reuse) bypass that layer.
  const validated = z.object(def.schema).parse(args);

  // Wire-type translation: tools.yaml name → C++ type string.
  const typeString = ACTORS_WIRE_MAP[toolName] || toolName;

  // get_actors's class_filter is aspirational (Phase 3) — strip before sending
  // so the plugin's TryGetStringField on an unrecognized field doesn't choke.
  let wireParams = { ...validated };
  if (toolName === 'get_actors') {
    delete wireParams.class_filter;
  }

  return connectionManager.send('tcp-55558', typeString, wireParams, { skipCache: !def.isReadOp });
}

/** Export tool-def shape for server.mjs registration. */
export function getActorsToolDefs() {
  return ACTORS_SCHEMAS;
}
