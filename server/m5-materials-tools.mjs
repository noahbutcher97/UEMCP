// M5 materials toolset stubs (M5-PREP scaffold).
//
// Placeholder for the 3 not-yet-shipped materials tools:
//   create_material, create_material_instance, set_material_parameter
//
// The 2 shipped tools (list_material_parameters via rc-tools.mjs FULL-RC,
// get_material_graph via menhance-tcp-tools.mjs FULL-TCP under M-enhance D77)
// are NOT in scope here — do NOT duplicate them.
//
// set_material_parameter is RC-eligible per D101 (ii) — sub-worker may instead
// add a 3-line delegate to rc-tools.mjs and drop the entry here.
//
// Sub-worker M5-animation+materials populates M5_MATERIALS_SCHEMAS and the
// execute body. Mirror actors-tcp-tools.mjs for the reference shape.

let M5_MATERIALS_WIRE_MAP = {};

export function initM5MaterialsTools(toolsData) {
  M5_MATERIALS_WIRE_MAP = {};
  const toolset = toolsData?.toolsets?.materials;
  if (!toolset?.tools) return;
  for (const [name, def] of Object.entries(toolset.tools)) {
    if (def.wire_type) {
      M5_MATERIALS_WIRE_MAP[name] = def.wire_type;
    }
  }
}

export const M5_MATERIALS_SCHEMAS = {};

export async function executeM5MaterialsTool(toolName, _args, _connectionManager) {
  const def = M5_MATERIALS_SCHEMAS[toolName];
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

export function getM5MaterialsToolDefs() {
  return M5_MATERIALS_SCHEMAS;
}
