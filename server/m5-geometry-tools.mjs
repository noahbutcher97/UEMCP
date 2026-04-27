// M5 geometry toolset — procedural mesh + CSG (3 not-yet-shipped tools).
//
// Requires Geometry Script plugin enabled in the consuming project (per
// tools.yaml). The plugin C++ handlers in GeometryHandlers.cpp gate every call
// on IPluginManager::FindPlugin("GeometryScripting")->IsEnabled() and return a
// typed GEOMETRY_SCRIPT_PLUGIN_DISABLED error when missing.
//
// get_mesh_info (the only shipped geometry tool) lives in rc-tools.mjs as a
// FULL-RC delegate under M-enhance D77 — NOT in this file.
//
// Convention matches actors-tcp-tools.mjs: {description, schema, isReadOp}
// per tool, identity wire-type routing (no wire_type override in tools.yaml),
// ConnectionManager.send dispatch on TCP:55558.

import { z } from 'zod';

const Vec3 = z.array(z.number()).length(3).describe('[x, y, z]');

// Operation token accepted by the plugin's ParseBooleanOp (tolerant of
// difference/subtract + intersection/intersect aliases).
const BOOLEAN_OPS = ['union', 'difference', 'subtract', 'intersection', 'intersect'];

// Shape token accepted by the plugin's ParseShape.
const SHAPES = ['box', 'sphere', 'cylinder', 'cone'];

let M5_GEOMETRY_WIRE_MAP = {};

export function initM5GeometryTools(toolsData) {
  M5_GEOMETRY_WIRE_MAP = {};
  const toolset = toolsData?.toolsets?.geometry;
  if (!toolset?.tools) return;
  for (const [name, def] of Object.entries(toolset.tools)) {
    if (def.wire_type) {
      M5_GEOMETRY_WIRE_MAP[name] = def.wire_type;
    }
  }
}

export const M5_GEOMETRY_SCHEMAS = {

  create_procedural_mesh: {
    description: 'Spawn ADynamicMeshActor with primitive shape (box / sphere / cylinder / cone)',
    schema: {
      shape:    z.enum(SHAPES).describe('Primitive shape (case-insensitive on wire)'),
      location: Vec3.optional().describe('World location of the spawned actor (default [0,0,0])'),
      size:     z.number().positive().optional().describe('Linear extent in cm (default 100; must be > 0)'),
      name:     z.string().optional().describe('Optional actor name (auto-generated if omitted)'),
    },
    isReadOp: false,
  },

  mesh_boolean: {
    description: 'CSG operation between two ADynamicMeshActor (target ← op(target, tool); destructive on target)',
    schema: {
      target:    z.string().min(1).describe('Target ADynamicMeshActor name (receives the result)'),
      tool:      z.string().min(1).describe('Tool ADynamicMeshActor name (operand)'),
      operation: z.enum(BOOLEAN_OPS).describe('union / difference / intersection (aliases accepted)'),
    },
    isReadOp: false,
  },

  generate_uvs: {
    description: 'Auto-unwrap UVs on a dynamic mesh via box projection (channel 0 by default)',
    schema: {
      target:     z.string().min(1).describe('Target ADynamicMeshActor name'),
      uv_channel: z.number().int().min(0).max(7).optional().describe('UV channel index (default 0; 0–7)'),
    },
    isReadOp: false,
  },
};

/**
 * Execute an M5 geometry tool against TCP:55558.
 *
 * @param {string} toolName — tools.yaml name (e.g., 'create_procedural_mesh')
 * @param {object} args — raw args (validated here via Zod)
 * @param {import('./connection-manager.mjs').ConnectionManager} connectionManager
 * @returns {Promise<object>}
 */
export async function executeM5GeometryTool(toolName, args, connectionManager) {
  const def = M5_GEOMETRY_SCHEMAS[toolName];
  if (!def) throw new Error(`m5-geometry-tools: unknown tool "${toolName}"`);

  const validated = z.object(def.schema).parse(args);

  const typeString = M5_GEOMETRY_WIRE_MAP[toolName] || toolName;
  return connectionManager.send('tcp-55558', typeString, validated, { skipCache: !def.isReadOp });
}

export function getM5GeometryToolDefs() {
  return M5_GEOMETRY_SCHEMAS;
}
