// M5 input-and-pie toolset stubs (M5-PREP scaffold).
//
// Placeholder for the 3 not-yet-shipped Enhanced Input asset-creation tools:
//   create_input_action, create_mapping_context, add_mapping
//
// The 4 shipped PIE-control + console tools (start_pie / stop_pie /
// is_pie_running / execute_console_command) live in menhance-tcp-tools.mjs and
// EdgeCaseHandlers.cpp under M-enhance D77 — do NOT duplicate them here, that
// would double-register their wire-types.
//
// Sub-worker M5-input+geometry populates M5_INPUT_PIE_SCHEMAS and the execute
// body. Mirror actors-tcp-tools.mjs for the reference shape.

let M5_INPUT_PIE_WIRE_MAP = {};

export function initM5InputPieTools(toolsData) {
  M5_INPUT_PIE_WIRE_MAP = {};
  const toolset = toolsData?.toolsets?.['input-and-pie'];
  if (!toolset?.tools) return;
  for (const [name, def] of Object.entries(toolset.tools)) {
    if (def.wire_type) {
      M5_INPUT_PIE_WIRE_MAP[name] = def.wire_type;
    }
  }
}

export const M5_INPUT_PIE_SCHEMAS = {};

export async function executeM5InputPieTool(toolName, _args, _connectionManager) {
  const def = M5_INPUT_PIE_SCHEMAS[toolName];
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

export function getM5InputPieToolDefs() {
  return M5_INPUT_PIE_SCHEMAS;
}
