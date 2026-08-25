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
};

export const TOOLSET_RESULT_OUTPUT_SHAPE = {
  ok: z.boolean().optional(),
  toolsets: z.any().optional(),
  summary: z.any().optional(),
  enabled: z.array(z.string()).optional(),
  alreadyEnabled: z.array(z.string()).optional(),
  unavailable: z.array(z.string()).optional(),
  unknown: z.array(z.string()).optional(),
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
  targetAttachment: z.any().optional(),
};
