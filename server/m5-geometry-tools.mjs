// M5 geometry toolset stubs (M5-PREP scaffold).
//
// Placeholder for the 3 not-yet-shipped procedural-mesh tools:
//   create_procedural_mesh, mesh_boolean, generate_uvs
//
// The 1 shipped tool (get_mesh_info via rc-tools.mjs FULL-RC under M-enhance
// D77) is NOT in scope here — do NOT duplicate it.
//
// Geometry Script plugin is required per tools.yaml note. Sub-worker
// M5-input+geometry handles the gating in the plugin C++ handlers (see
// GeometryHandlers.cpp), then populates M5_GEOMETRY_SCHEMAS and the execute
// body. Mirror actors-tcp-tools.mjs for the reference shape.

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

export const M5_GEOMETRY_SCHEMAS = {};

export async function executeM5GeometryTool(toolName, _args, _connectionManager) {
  const def = M5_GEOMETRY_SCHEMAS[toolName];
  if (!def) {
    return {
      status: 'error',
      code: 'not_implemented',
      error: `M5 tool '${toolName}' not yet shipped (stub from M5-PREP)`,
    };
  }
  return {
    status: 'error',
    code: 'not_implemented',
    error: `M5 tool '${toolName}' has a schema but no execute body (sub-worker incomplete)`,
  };
}

export function getM5GeometryToolDefs() {
  return M5_GEOMETRY_SCHEMAS;
}
