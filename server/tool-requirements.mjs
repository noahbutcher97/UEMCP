export const TOOL_REQUIREMENT_KINDS = Object.freeze({
  MANAGEMENT: 'management',
  OFFLINE_READ: 'offline_read',
  LIVE_READ: 'live_read',
  LIVE_MUTATION: 'live_mutation',
  RC_READ: 'rc_read',
  RC_MUTATION: 'rc_mutation',
  PYTHON_EXEC: 'python_exec',
});

const LIVE_MUTATION_OVERRIDES = new Set([
  'create_blueprint',
  'add_component',
  'set_component_property',
  'set_blueprint_property',
  'compile_blueprint',
  'save_blueprint',
  'create_widget',
  'add_text_block',
  'add_button',
  'bind_widget_event',
  'set_text_block_binding',
  'create_material',
  'create_material_instance',
  'create_input_action',
  'create_mapping_context',
  'add_mapping',
  'create_montage',
  'add_montage_section',
  'add_montage_notify',
  'rename_asset',
  'duplicate_asset',
  'delete_asset_safe',
  'generate_static_mesh',
  'generate_procedural_mesh',
  'start_pie',
  'stop_pie',
  'send_input',
  'send_input_action',
  'execute_console_command',
]);

const RC_MUTATION_OVERRIDES = new Set([
  'rc_set_property',
  'rc_call_function',
  'rc_batch',
  'rc_passthrough',
  'set_material_parameter',
]);

function declaredLayer(toolDef = {}) {
  return toolDef.transport_layer || toolDef.availability_layer || '';
}

function metadataImpliesMutation(toolDef = {}) {
  return toolDef.mutates_asset === true ||
    toolDef.mutates_level === true ||
    toolDef.saves_asset === true ||
    toolDef.compiles_asset === true;
}

export function getToolRequirement(toolName, toolsetName, toolDef = {}) {
  if (toolsetName === 'management') return TOOL_REQUIREMENT_KINDS.MANAGEMENT;
  if (toolName === 'run_python_command') return TOOL_REQUIREMENT_KINDS.PYTHON_EXEC;
  if (toolsetName === 'offline') return TOOL_REQUIREMENT_KINDS.OFFLINE_READ;

  const layer = declaredLayer(toolDef);
  const mutates = metadataImpliesMutation(toolDef);

  if (layer === 'http-30010' || toolsetName === 'remote-control') {
    return mutates || RC_MUTATION_OVERRIDES.has(toolName)
      ? TOOL_REQUIREMENT_KINDS.RC_MUTATION
      : TOOL_REQUIREMENT_KINDS.RC_READ;
  }

  return mutates || LIVE_MUTATION_OVERRIDES.has(toolName)
    ? TOOL_REQUIREMENT_KINDS.LIVE_MUTATION
    : TOOL_REQUIREMENT_KINDS.LIVE_READ;
}
