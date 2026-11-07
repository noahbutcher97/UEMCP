import { z } from 'zod';

export const PROJECT_MANAGEMENT_TOOL_NAMES = Object.freeze([
  'connection_info',
  'detect_project',
  'find_tools',
  'list_toolsets',
  'enable_toolset',
  'disable_toolset',
  'list_project_targets',
  'attach_project',
  'detach_project',
  'refresh_project_context',
]);

export const ATTACH_PROJECT_INPUT_SHAPE = {
  project_root: z.string().optional(),
  uproject_path: z.string().optional(),
  target: z.string().optional(),
  target_profile: z.string().optional(),
  from_running_editor: z.string().optional(),
  allow_outside_client_roots: z.boolean().optional().default(false),
  force_generation_change: z.boolean().optional().default(false),
  prompt: z.boolean().optional().default(false),
};

export const LIST_PROJECT_TARGETS_INPUT_SHAPE = {
  profile: z.string().optional(),
};

export const CONNECTION_INFO_INPUT_SHAPE = {
  force_reconnect: z.boolean().optional().default(false),
};

export const WAIT_FOR_EDITOR_INPUT_SHAPE = {
  timeout_ms: z.number().optional(),
};

export const FIND_TOOLS_INPUT_SHAPE = {
  query: z.string(),
  max_results: z.number().int().optional().default(15),
};

export const DESCRIBE_TOOL_INPUT_SHAPE = {
  tool: z.string(),
};

export const CALL_TOOL_INPUT_SHAPE = {
  tool: z.string(),
  arguments: z.record(z.any()).optional(),
};

export const PROJECT_CONTEXT_OUTPUT_SHAPE = {
  ok: z.boolean().optional(),
  projectContext: z.any().optional(),
  project: z.string().optional(),
  projectRoot: z.string().optional(),
  readiness: z.any().optional(),
  layers: z.any().optional(),
  enabledToolsets: z.array(z.string()).optional(),
  toolCount: z.number().optional(),
};

export const PROJECT_ERROR_OUTPUT_SHAPE = {
  ok: z.boolean().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  projectContext: z.any().optional(),
  next: z.any().optional(),
  // Attachment failures retain their diagnostic details in structuredContent.
  sources: z.array(z.string()).optional(),
  path: z.string().optional(),
  reason: z.string().optional(),
  directUprojects: z.array(z.string()).optional(),
  workspaceRoots: z.array(z.string()).optional(),
  inFlightMutations: z.number().int().nonnegative().optional(),
  target: z.string().optional(),
  targetProfile: z.string().optional(),
  status: z.string().optional(),
  collisions: z.array(z.object({
    alias: z.string(),
    candidates: z.array(z.string()),
  })).optional(),
  uri: z.string().optional(),
  authority: z.string().optional(),
};

export const WAIT_FOR_EDITOR_OUTPUT_SHAPE = {
  ok: z.boolean(),
  ready: z.boolean(),
  phase: z.enum(['no_editor_process', 'wrong_project', 'ready', 'identity_mismatch', 'initializing', 'transport_ready']),
  effective_timeout_ms: z.number().int().nonnegative(),
  elapsed_ms: z.number().nonnegative(),
  attempts: z.number().int().nonnegative(),
  editor: z.object({
    project_name: z.string().nullable(),
    world_path: z.string().nullable(),
  }).nullable(),
  last_error: z.object({
    code: z.string().nullable(),
    nativeCode: z.string().nullable(),
    message: z.string(),
  }).nullable(),
  hint: z.string(),
  code: z.string().nullable().optional(),
  mismatch: z.object({
    attached_uproject: z.string(),
    editor_uproject: z.string(),
  }).nullable().optional(),
};

export const TOOLSET_RESULT_OUTPUT_SHAPE = {
  ok: z.boolean().optional(),
  toolsets: z.any().optional(),
  summary: z.any().optional(),
  enabled: z.array(z.string()).optional(),
  alreadyEnabled: z.array(z.string()).optional(),
  unavailable: z.array(z.string()).optional(),
  unknown: z.array(z.string()).optional(),
  disabled: z.array(z.string()).optional(),
  wasNotEnabled: z.array(z.string()).optional(),
  blocked: z.any().optional(),
  projectContext: z.any().optional(),
};

export const MANAGEMENT_OUTPUT_SHAPE = {
  ...PROJECT_CONTEXT_OUTPUT_SHAPE,
  ...PROJECT_ERROR_OUTPUT_SHAPE,
  ...TOOLSET_RESULT_OUTPUT_SHAPE,
  targets: z.any().optional(),
  query: z.string().optional(),
  resultCount: z.number().optional(),
  results: z.any().optional(),
  autoEnabled: z.array(z.string()).optional(),
  selectedBundle: z.object({ name: z.string(), toolsets: z.array(z.string()) }).optional(),
  directToolsets: z.array(z.string()).optional(),
  bundleToolsets: z.array(z.string()).optional(),
  unavailableBundlePieces: z.array(z.string()).optional(),
  tips: z.array(z.string()).optional(),
  targetAttachment: z.any().optional(),
  transportConfiguration: z.object({
    ports: z.object({ tcpPortCustom: z.number().int(), rcPort: z.number().int() }),
    source: z.enum(['project', 'session', 'invalid']),
    configured: z.object({ tcp: z.number().nullable(), http: z.number().nullable() }).optional(),
    error: z.string().optional(),
  }).optional(),
  editor: z.any().optional(),
  deploy: z.any().optional(),
  // EN-25: connection_info's answer to "is the listener on 55558 actually the
  // project I am attached to?"
  identityMismatch: z.boolean().optional(),
  identityMismatchPaths: z.any().optional(),
  // D202: describe_tool's schema-on-demand answer.
  tool: z.string().optional(),
  toolset: z.string().optional(),
  description: z.string().optional(),
  inputSchema: z.any().optional(),
  annotations: z.any().optional(),
  requirement: z.string().optional(),
  dispatcher: z.string().optional(),
};
