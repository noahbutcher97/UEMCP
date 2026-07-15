import { TOOL_REQUIREMENT_KINDS } from './tool-requirements.mjs';

export const MANAGEMENT_SESSION_STATE_TOOLS = Object.freeze(new Set([
  'connection_info',
  'detect_project',
  'find_tools',
  'enable_toolset',
  'disable_toolset',
  'attach_project',
  'detach_project',
  'refresh_project_context',
]));

export function getToolAnnotations(toolName, requirement) {
  let annotations;

  switch (requirement) {
    case TOOL_REQUIREMENT_KINDS.OFFLINE_READ:
    case TOOL_REQUIREMENT_KINDS.LIVE_READ:
    case TOOL_REQUIREMENT_KINDS.RC_READ:
      annotations = { readOnlyHint: true };
      break;
    case TOOL_REQUIREMENT_KINDS.LIVE_MUTATION:
    case TOOL_REQUIREMENT_KINDS.RC_MUTATION:
    case TOOL_REQUIREMENT_KINDS.PYTHON_EXEC:
      annotations = { readOnlyHint: false, destructiveHint: true };
      break;
    case TOOL_REQUIREMENT_KINDS.MANAGEMENT:
      annotations = MANAGEMENT_SESSION_STATE_TOOLS.has(toolName)
        ? { readOnlyHint: false, destructiveHint: false }
        : { readOnlyHint: true };
      break;
    default:
      throw new Error(`Unknown tool requirement kind: ${requirement}`);
  }

  return Object.freeze(annotations);
}
