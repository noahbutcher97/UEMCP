// Project attachment error helpers shared by ProjectContext and management tools.

export const PROJECT_ERROR_CODES = Object.freeze({
  PROJECT_NOT_ATTACHED: 'PROJECT_NOT_ATTACHED',
  PROJECT_AMBIGUOUS: 'PROJECT_AMBIGUOUS',
  PROJECT_PATH_INVALID: 'PROJECT_PATH_INVALID',
  PROJECT_PATH_UNSUPPORTED: 'PROJECT_PATH_UNSUPPORTED',
  PROJECT_OUTSIDE_CLIENT_ROOT: 'PROJECT_OUTSIDE_CLIENT_ROOT',
  PROJECT_ATTACH_MODE_INVALID: 'PROJECT_ATTACH_MODE_INVALID',
  PROJECT_CONTEXT_CHANGED: 'PROJECT_CONTEXT_CHANGED',
  GENERATION_STALE: 'GENERATION_STALE',
  ROOTS_UNSUPPORTED: 'ROOTS_UNSUPPORTED',
  ELICITATION_UNAVAILABLE: 'ELICITATION_UNAVAILABLE',
  EDITOR_UNAVAILABLE: 'EDITOR_UNAVAILABLE',
  EDITOR_IDENTITY_UNKNOWN: 'EDITOR_IDENTITY_UNKNOWN',
  EDITOR_PROJECT_MISMATCH: 'EDITOR_PROJECT_MISMATCH',
  TRANSPORT_OWNER_UNKNOWN: 'TRANSPORT_OWNER_UNKNOWN',
  DEPLOY_STALE: 'DEPLOY_STALE',
  BLOCKED_CONFIG: 'BLOCKED_CONFIG',
  IN_FLIGHT_MUTATION_BLOCKED: 'IN_FLIGHT_MUTATION_BLOCKED',
  TARGET_ALIAS_AMBIGUOUS: 'TARGET_ALIAS_AMBIGUOUS',
  TARGET_ENTRY_INVALID: 'TARGET_ENTRY_INVALID',
});

export class ProjectContextError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ProjectContextError';
    this.code = code;
    this.details = details;
  }
}

export function makeProjectError(code, message, details = {}) {
  return {
    ok: false,
    code,
    message,
    ...details,
  };
}

export function makeProjectToolResult(payload) {
  const structuredContent = payload instanceof Error
    ? makeProjectError(payload.code || 'PROJECT_PATH_INVALID', payload.message, payload.details || {})
    : payload;

  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
    ...(structuredContent?.ok === false ? { isError: true } : {}),
  };
}
