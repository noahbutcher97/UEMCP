import { TOOL_REQUIREMENT_KINDS } from './tool-requirements.mjs';

const MANAGEMENT_SESSION_STATE_TOOL_NAMES = Object.freeze([
  'connection_info',
  'detect_project',
  'find_tools',
  'enable_toolset',
  'disable_toolset',
  'attach_project',
  'detach_project',
  'refresh_project_context',
]);
const managementSessionStateToolLookup = new Set(MANAGEMENT_SESSION_STATE_TOOL_NAMES);

const managementSessionStateTools = Object.create(null);
Object.defineProperties(managementSessionStateTools, {
  has: {
    value: (toolName) => managementSessionStateToolLookup.has(toolName),
  },
  [Symbol.iterator]: {
    value: () => MANAGEMENT_SESSION_STATE_TOOL_NAMES[Symbol.iterator](),
  },
});
export const MANAGEMENT_SESSION_STATE_TOOLS = Object.freeze(managementSessionStateTools);

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
      annotations = managementSessionStateToolLookup.has(toolName)
        ? { readOnlyHint: false, destructiveHint: false }
        : { readOnlyHint: true };
      break;
    default:
      throw new Error(`Unknown tool requirement kind: ${requirement}`);
  }

  return Object.freeze(annotations);
}
