// M5 editor-utility toolset stubs (M5-PREP scaffold).
//
// Placeholder for the 6 not-yet-shipped editor-utility tools:
//   run_python_command, get_editor_utility_blueprint, run_editor_utility,
//   duplicate_asset, rename_asset, delete_asset_safe
//
// The 1 shipped tool (get_editor_state via menhance-tcp-tools.mjs under
// M-enhance D77) is NOT in scope here — do NOT duplicate it.
//
// Highest security review burden of the 5 M5 toolsets:
//   - run_python_command must enforce D14 deny-list (os, subprocess, eval,
//     exec, open, __import__) AND may gate on a startup flag per D101 (iv).
//   - delete_asset_safe must call IAssetRegistry::GetReferencers() and refuse
//     if hard refs exist unless force=true (D14 risk).
//
// Sub-worker M5-editor-utility populates M5_EDITOR_UTILITY_SCHEMAS and the
// execute body. Mirror actors-tcp-tools.mjs for the reference shape.

let M5_EDITOR_UTILITY_WIRE_MAP = {};

export function initM5EditorUtilityTools(toolsData) {
  M5_EDITOR_UTILITY_WIRE_MAP = {};
  const toolset = toolsData?.toolsets?.['editor-utility'];
  if (!toolset?.tools) return;
  for (const [name, def] of Object.entries(toolset.tools)) {
    if (def.wire_type) {
      M5_EDITOR_UTILITY_WIRE_MAP[name] = def.wire_type;
    }
  }
}

export const M5_EDITOR_UTILITY_SCHEMAS = {};

export async function executeM5EditorUtilityTool(toolName, _args, _connectionManager) {
  const def = M5_EDITOR_UTILITY_SCHEMAS[toolName];
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

export function getM5EditorUtilityToolDefs() {
  return M5_EDITOR_UTILITY_SCHEMAS;
}
