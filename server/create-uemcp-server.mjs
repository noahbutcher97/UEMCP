import { readFileSync } from 'node:fs';
import { fileURLToPath, fileURLToPath as decodeFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { RootsListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

import { ConnectionManager } from './connection-manager.mjs';
import { ToolIndex } from './tool-index.mjs';
import { ToolsetManager, summarizeAutoEnable } from './toolset-manager.mjs';
import { buildFindToolsEnablePlan, selectWorkflowBundle, unavailableBundlePieces } from './workflow-bundles.mjs';
import { executeOfflineTool, resetOfflineAssetCache } from './offline-tools.mjs';
import { buildZodSchema } from './zod-builder.mjs';
import { ProjectContext, withProjectContextGuard } from './project-context.mjs';
import { PROJECT_ERROR_CODES, ProjectContextError, makeProjectToolResult } from './project-errors.mjs';
import { readProjectTargets } from './project-targets.mjs';
import { TOOL_REQUIREMENT_KINDS, getToolRequirement } from './tool-requirements.mjs';
import { MANAGEMENT_SESSION_STATE_TOOLS, getToolAnnotations } from './tool-annotations.mjs';
import { listEditorProcesses } from './editor-processes.mjs';
import { registerProjectCodenames } from './project-hygiene.mjs';
import {
  ATTACH_PROJECT_INPUT_SHAPE,
  CONNECTION_INFO_INPUT_SHAPE,
  FIND_TOOLS_INPUT_SHAPE,
  LIST_PROJECT_TARGETS_INPUT_SHAPE,
  MANAGEMENT_OUTPUT_SHAPE,
} from './project-tools.mjs';
import {
  initActorsTools,
  getActorsToolDefs,
  executeActorsTool,
} from './actors-tcp-tools.mjs';
import {
  initBlueprintsWriteTools,
  getBlueprintsWriteToolDefs,
  executeBlueprintsWriteTool,
} from './blueprints-write-tcp-tools.mjs';
import {
  initWidgetsTools,
  getWidgetsToolDefs,
  executeWidgetsTool,
} from './widgets-tcp-tools.mjs';
import { getRcToolDefs, executeRcTool } from './rc-tools.mjs';
import { SERVER_INSTRUCTIONS, TOOLSET_TIPS } from './server-guidance.mjs';
import {
  initMenhanceTools,
  getMenhanceToolDefs,
  executeMenhanceTool,
} from './menhance-tcp-tools.mjs';
import {
  initM5AnimationTools,
  getM5AnimationToolDefs,
  executeM5AnimationTool,
} from './m5-animation-tools.mjs';
import {
  initM5MaterialsTools,
  getM5MaterialsToolDefs,
  executeM5MaterialsTool,
} from './m5-materials-tools.mjs';
import {
  initM5InputPieTools,
  getM5InputPieToolDefs,
  executeM5InputPieTool,
} from './m5-input-pie-tools.mjs';
import {
  initM5GeometryTools,
  getM5GeometryToolDefs,
  executeM5GeometryTool,
} from './m5-geometry-tools.mjs';
import {
  initM5EditorUtilityTools,
  getM5EditorUtilityToolDefs,
  executeM5EditorUtilityTool,
} from './m5-editor-utility-tools.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = dirname(__dirname);
const TOOLS_YAML = yaml.load(readFileSync(join(REPO_ROOT, 'tools.yaml'), 'utf-8'));

function buildCanonicalToolDefinitionIndex(toolsData) {
  const index = new Map();
  for (const [toolsetName, toolset] of Object.entries(toolsData.toolsets || {})) {
    for (const [toolName, def] of Object.entries(toolset.tools || {})) {
      if (index.has(toolName)) {
        throw new Error(`Duplicate dynamic tool name in tools.yaml: ${toolName}`);
      }
      index.set(toolName, Object.freeze({ toolsetName, def }));
    }
  }
  return index;
}

const CANONICAL_TOOL_DEFINITIONS = buildCanonicalToolDefinitionIndex(TOOLS_YAML);

function getCanonicalToolDefinition(toolName, registrationGroupName) {
  const canonical = CANONICAL_TOOL_DEFINITIONS.get(toolName);
  if (!canonical) {
    throw new Error(
      `Dynamic tool registration has no canonical tools.yaml definition: ${registrationGroupName}.${toolName}`,
    );
  }
  return canonical;
}

const MANAGEMENT_PURE_INSPECTION_TOOL_NAMES = Object.freeze([
  'list_toolsets',
  'list_project_targets',
]);
const MANAGEMENT_SESSION_STATE_ANNOTATIONS = Object.freeze({
  readOnlyHint: false,
  destructiveHint: false,
});
const MANAGEMENT_PURE_INSPECTION_ANNOTATIONS = Object.freeze({
  readOnlyHint: true,
});
const MANAGEMENT_TOOL_COUNT = MANAGEMENT_SESSION_STATE_TOOLS.size + MANAGEMENT_PURE_INSPECTION_TOOL_NAMES.length;

function annotationsMatchLiteralPolicy(actual, expected) {
  if (!actual || typeof actual !== 'object') return false;
  const actualKeys = Object.keys(actual).sort();
  const expectedKeys = Object.keys(expected).sort();
  return actualKeys.length === expectedKeys.length &&
    actualKeys.every((key, index) => key === expectedKeys[index] && actual[key] === expected[key]);
}

export function assertManagementAnnotationPolicies(registeredManagementTools) {
  if (!(registeredManagementTools instanceof Map)) {
    throw new Error('Management registrations must be captured in a Map');
  }

  const expectedNames = new Set([
    ...MANAGEMENT_SESSION_STATE_TOOLS,
    ...MANAGEMENT_PURE_INSPECTION_TOOL_NAMES,
  ]);
  const registeredNames = new Set(registeredManagementTools.keys());
  const missing = [...expectedNames].filter(name => !registeredNames.has(name)).sort();
  const unexpected = [...registeredNames].filter(name => !expectedNames.has(name)).sort();
  if (missing.length > 0 || unexpected.length > 0) {
    throw new Error(
      `Management registration inventory mismatch; missing: ${missing.join(', ') || '(none)'}; ` +
      `unexpected: ${unexpected.join(', ') || '(none)'}`
    );
  }

  for (const name of MANAGEMENT_SESSION_STATE_TOOLS) {
    const actual = registeredManagementTools.get(name);
    if (!annotationsMatchLiteralPolicy(actual, MANAGEMENT_SESSION_STATE_ANNOTATIONS)) {
      throw new Error(`Management tool ${name} does not use the literal session-state annotation policy`);
    }
  }

  for (const name of MANAGEMENT_PURE_INSPECTION_TOOL_NAMES) {
    const actual = registeredManagementTools.get(name);
    if (!annotationsMatchLiteralPolicy(actual, MANAGEMENT_PURE_INSPECTION_ANNOTATIONS)) {
      throw new Error(`Management tool ${name} does not use the literal pure-inspection annotation policy`);
    }
  }
}

function createConfig(env = {}) {
  return {
    projectRoot: '',
    projectName: env.UNREAL_PROJECT_NAME || '',
    tcpPortCustom: parseInt(env.UNREAL_TCP_PORT_CUSTOM || '55558', 10),
    tcpTimeoutMs: parseInt(env.UNREAL_TCP_TIMEOUT_MS || '10000', 10),
    rcPort: parseInt(env.UNREAL_RC_PORT || '30010', 10),
    autoDetect: env.UNREAL_AUTO_DETECT !== 'false',
    rcRecycleAfterN: parseInt(env.UEMCP_RC_RECYCLE_AFTER_N || '0', 10) || 0,
    rcRateCap: parseFloat(env.UEMCP_RC_RATE_CAP || '0') || 0,
    rcRelaunchHintAfterN: parseInt(env.UEMCP_RC_RELAUNCH_HINT_AFTER_N || '0', 10) || 0,
    metricsEmitEveryN: parseInt(env.UEMCP_METRICS_EMIT_EVERY_N || '0', 10) || 0,
    metricsLogPath: env.UEMCP_METRICS_LOG || '',
  };
}

function structuredResult(payload) {
  return {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
    ...(payload?.ok === false ? { isError: true } : {}),
  };
}

function projectError(code, message, details = {}) {
  return makeProjectToolResult({
    ok: false,
    code,
    message,
    ...details,
  });
}

function rootUriToPath(uri) {
  if (!uri?.startsWith('file:')) return null;
  return decodeFileURL(uri);
}

function supportsRoots(capabilities) {
  return !!capabilities?.roots;
}

function supportsFormElicitation(capabilities) {
  return !!capabilities?.elicitation?.form;
}

function installToolListBatching(server) {
  const original = server.server.sendToolListChanged.bind(server.server);
  let depth = 0;
  let pending = false;

  server.server.sendToolListChanged = async () => {
    if (depth > 0) {
      pending = true;
      return;
    }
    return original();
  };

  return async function withToolListBatch(fn) {
    depth += 1;
    try {
      return await fn();
    } finally {
      depth -= 1;
      if (depth === 0 && pending) {
        pending = false;
        await original();
      }
    }
  };
}

function makeLogger(server, stderr) {
  return function log(level, message) {
    try {
      server.server.sendLoggingMessage({ level, data: message });
    } catch {
      stderr.write(`[uemcp:${level}] ${message}\n`);
    }
  };
}

function buildOfflineSchemaShape(def) {
  return buildZodSchema(def.params);
}

function buildTcpSchemaShape(def) {
  const shape = {};
  for (const [paramName, zodField] of Object.entries(def.schema)) {
    shape[paramName] = zodField;
  }
  return shape;
}

function isMutationRequirement(requirement) {
  return requirement === TOOL_REQUIREMENT_KINDS.LIVE_MUTATION ||
    requirement === TOOL_REQUIREMENT_KINDS.RC_MUTATION ||
    requirement === TOOL_REQUIREMENT_KINDS.PYTHON_EXEC;
}

function registerToolGroup(server, toolsetManager, projectContext, log, toolsetName, label, defs, schemaBuilder, executor) {
  for (const [name, def] of Object.entries(defs)) {
    const canonical = getCanonicalToolDefinition(name, toolsetName);
    const requirement = getToolRequirement(name, canonical.toolsetName, canonical.def);
    const handle = server.registerTool(
      name,
      {
        description: def.description,
        inputSchema: schemaBuilder(def),
        annotations: getToolAnnotations(name, requirement),
      },
      async (args) => {
        try {
          return await withProjectContextGuard(
            projectContext,
            { requirement, toolName: name, toolsetName: canonical.toolsetName },
            async () => {
              let mutationId = null;
              if (isMutationRequirement(requirement)) {
                mutationId = projectContext.beginMutation({
                  toolName: name,
                  toolsetName: canonical.toolsetName,
                  requirement,
                });
              }
              try {
                log('info', `Executing ${label} tool: ${name}`);
                const result = await executor(name, args);
                return {
                  content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
                };
              } finally {
                if (mutationId !== null) projectContext.endMutation(mutationId);
              }
            }
          );
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error in ${name}: ${err.message}` }],
            isError: true,
          };
        }
      }
    );
    handle.disable();
    toolsetManager.registerToolHandle(name, handle);
  }
}

function collectTips(newlyEnabled, allEnabled) {
  const tips = [];
  for (const name of newlyEnabled) {
    const entry = TOOLSET_TIPS[name];
    if (!entry) continue;

    const parts = [];
    if (entry.core) parts.push(entry.core);
    if (entry.workflows) {
      for (const workflow of entry.workflows) {
        if (workflow.requires.every(required => allEnabled.has(required))) {
          parts.push(workflow.tip);
        }
      }
    }
    if (parts.length > 0) tips.push(`[${name}] ${parts.join(' ')}`);
  }
  return tips;
}

export async function createUemcpServer(options = {}) {
  const env = options.env || process.env;
  const cwd = options.cwd || process.cwd();
  const repoRoot = options.repoRoot || REPO_ROOT;
  const stderr = options.stderr || process.stderr;
  const fallbackWorkspaceRoots = [...(options.workspaceRoots || [])];
  const writeProjectCodenames = options.writeProjectCodenames !== false;
  const config = createConfig(env);

  const server = new McpServer(
    { name: 'uemcp', version: '0.1.0' },
    {
      capabilities: { logging: {} },
      instructions: SERVER_INSTRUCTIONS,
    }
  );
  const withToolListBatch = installToolListBatching(server);
  const log = makeLogger(server, stderr);

  const connectionManager = new ConnectionManager({
    ...config,
    tcpCommandFn: options.tcpCommandFn,
    httpCommandFn: options.httpCommandFn,
  });
  const toolIndex = new ToolIndex();
  const toolsetManager = new ToolsetManager(connectionManager, toolIndex, {
    sendToolListChanged: () => server.server.sendToolListChanged(),
  });
  const projectContext = new ProjectContext({
    cwd,
    repoRoot,
    env,
    workspaceRoots: fallbackWorkspaceRoots,
    sdkServer: server.server,
    fsImpl: options.fsImpl,
    processInspector: options.processInspector,
    deployInspector: options.deployInspector,
  });

  async function applyProjectContextToManagers() {
    await withToolListBatch(async () => {
      const projectRoot = projectContext.identity?.projectRoot || '';
      connectionManager.setAttachedProject(projectContext.identity);
      connectionManager.resetProjectScopedState({ generation: projectContext.generation, reason: 'project_context_reset' });
      resetOfflineAssetCache();

      if (projectRoot) {
        await connectionManager.checkOfflineAvailable(projectRoot);
        if (writeProjectCodenames) {
          registerProjectCodenames({ projectRoot, repoRoot, stderr });
        }
      }
      await toolsetManager.applyProjectContext(projectContext.snapshot());
    });
  }

  projectContext.onReset(applyProjectContextToManagers);

  async function refreshFromRootsSource(reason) {
    const capabilities = server.server.getClientCapabilities();
    if (supportsRoots(capabilities)) {
      try {
        const result = await server.server.listRoots();
        const roots = (result.roots || [])
          .map(root => rootUriToPath(root.uri))
          .filter(Boolean);
        return await projectContext.refreshFromClientRoots({ roots, reason });
      } catch (err) {
        projectContext.warnings.push({
          code: PROJECT_ERROR_CODES.ROOTS_UNSUPPORTED,
          message: `Client roots/list failed: ${err.message}`,
        });
        return await projectContext.refreshFromClientRoots({
          roots: fallbackWorkspaceRoots,
          reason: `${reason}_fallback`,
        });
      }
    }
    return await projectContext.refreshFromClientRoots({
      roots: fallbackWorkspaceRoots,
      reason,
    });
  }

  function managementResult(payload) {
    return structuredResult(payload);
  }

  const registeredManagementTools = new Map();

  function registerManagementTool(name, configObject, handler) {
    const annotations = getToolAnnotations(name, TOOL_REQUIREMENT_KINDS.MANAGEMENT);
    const handle = server.registerTool(
      name,
      {
        ...configObject,
        outputSchema: MANAGEMENT_OUTPUT_SHAPE,
        annotations,
      },
      handler
    );
    registeredManagementTools.set(name, annotations);
    return handle;
  }

  async function inspectEditorProcesses() {
    const inspector = options.processInspector || projectContext.processInspector;
    if (typeof inspector === 'function') {
      return await inspector();
    }
    if (inspector && typeof inspector.listEditorProcesses === 'function') {
      return await inspector.listEditorProcesses();
    }
    return listEditorProcesses();
  }

  function currentEditorDiagnostic() {
    return {
      state: projectContext.editorIdentityState,
      candidates: [...projectContext.editorCandidates],
    };
  }

  function currentDeployDiagnostic() {
    return { ...projectContext.deployFreshness };
  }

  async function inspectDeployReadiness() {
    const inspector = options.deployInspector || projectContext.deployInspector;
    if (typeof inspector === 'function') {
      return await inspector({
        identity: projectContext.identity,
        projectContext: projectContext.snapshot(),
      });
    }
    if (inspector && typeof inspector.inspectDeployReadiness === 'function') {
      return await inspector.inspectDeployReadiness({
        identity: projectContext.identity,
        projectContext: projectContext.snapshot(),
      });
    }
    return null;
  }

  async function refreshDeployReadinessForConnectionInfo(forceReconnect) {
    if (!forceReconnect) return currentDeployDiagnostic();
    if (!projectContext.identity) {
      return projectContext.setDeployReadiness({
        state: 'not_attached',
        code: PROJECT_ERROR_CODES.PROJECT_NOT_ATTACHED,
        message: 'No project is attached for deploy freshness checks.',
      });
    }

    try {
      const diagnostic = await inspectDeployReadiness();
      if (!diagnostic) return projectContext.setDeployReadiness({ state: 'not_checked' });
      return projectContext.setDeployReadiness(diagnostic);
    } catch (err) {
      return projectContext.setDeployReadiness({
        state: 'unknown',
        message: `Deploy freshness check failed: ${err.message}`,
      });
    }
  }

  async function refreshEditorReadinessForConnectionInfo(forceReconnect) {
    if (!forceReconnect) return currentEditorDiagnostic();

    await connectionManager.probeActiveLayers();

    if (projectContext.identity) {
      try {
        const pluginState = await connectionManager.send(
          'tcp-55558',
          'get_editor_state',
          {},
          { skipCache: true }
        );
        const pluginEditor = projectContext.refreshEditorHandshake(pluginState);
        if (
          pluginEditor.source === 'plugin_handshake' &&
          pluginEditor.code !== PROJECT_ERROR_CODES.EDITOR_IDENTITY_UNKNOWN
        ) {
          return pluginEditor;
        }
      } catch (err) {
        // Raw TCP reachability is a separate readiness dimension. If the
        // identity handshake fails, keep probing via process inspection.
      }
    }

    return projectContext.refreshEditorProcesses(await inspectEditorProcesses());
  }

  registerManagementTool(
    'connection_info',
    {
      description: 'Show project attachment, readiness dimensions, active layers, and enabled toolsets.',
      inputSchema: CONNECTION_INFO_INPUT_SHAPE,
    },
    async ({ force_reconnect }) => {
      const editor = await refreshEditorReadinessForConnectionInfo(force_reconnect);
      const deploy = await refreshDeployReadinessForConnectionInfo(force_reconnect);
      const projectSnapshot = projectContext.snapshot();
      return managementResult({
        ok: true,
        project: projectSnapshot.identity?.projectName || config.projectName || connectionManager.detectedProject || '(not detected)',
        projectRoot: connectionManager.resolvedProjectRoot || '(not set)',
        projectContext: projectSnapshot,
        targetAttachment: projectSnapshot.identity?.targetAttachment || null,
        readiness: {
          attachment: projectSnapshot.attachmentState,
          editorIdentity: projectSnapshot.editorIdentityState,
          transportOwnership: projectSnapshot.transportOwnershipState,
          deployFreshness: projectSnapshot.deployFreshnessState,
        },
        editor,
        deploy,
        layers: connectionManager.getActiveStatus(),
        enabledToolsets: toolsetManager.getEnabledNames(),
        toolCount: toolIndex.size,
      });
    }
  );

  registerManagementTool(
    'detect_project',
    {
      description: 'Run editor project detection and report candidates without attaching.',
      inputSchema: {},
    },
    async () => {
      log('info', 'Running editor project detection...');
      const editor = projectContext.refreshEditorProcesses(await inspectEditorProcesses());
      return managementResult({ ok: true, editor, projectContext: projectContext.snapshot() });
    }
  );

  registerManagementTool(
    'find_tools',
    {
      description: 'Keyword search across all tools. Auto-enables matching toolsets only when a project is attached.',
      inputSchema: FIND_TOOLS_INPUT_SHAPE,
    },
    async ({ query, max_results }) => {
      const results = toolIndex.search(query, max_results);
      if (results.length === 0) {
        return managementResult({
          ok: true,
          query,
          resultCount: 0,
          results: [],
          autoEnabled: [],
          message: `No tools found matching "${query}".`,
        });
      }

      const selectedBundle = selectWorkflowBundle(query, results);
      const enablePlan = buildFindToolsEnablePlan(results, selectedBundle, 3);
      const toolsetNames = enablePlan.toolsetNames;
      const previouslyEnabled = new Set(toolsetManager.getEnabledNames());
      let enableResult = { enabled: [], alreadyEnabled: [], unavailable: [], unknown: [] };

      if (projectContext.identity && toolsetNames.length > 0) {
        enableResult = await toolsetManager.autoEnable(toolsetNames);
      } else if (toolsetNames.length > 0) {
        enableResult.unavailable = [...toolsetNames];
      }

      const summary = summarizeAutoEnable(toolsetNames, enableResult, previouslyEnabled);
      const allEnabled = new Set(toolsetManager.getEnabledNames());
      const tips = collectTips(summary.autoEnabled, allEnabled);
      const responseObj = {
        ok: true,
        query,
        resultCount: results.length,
        results: results.map(r => ({
          tool: r.toolName,
          toolset: r.toolsetName,
          description: r.description,
          layer: r.layer,
          score: r.score,
          ...(projectContext.identity ? {} : { blocked: PROJECT_ERROR_CODES.PROJECT_NOT_ATTACHED }),
        })),
        autoEnabled: summary.autoEnabled,
        projectContext: projectContext.snapshot(),
      };
      if (selectedBundle) {
        responseObj.selectedBundle = selectedBundle;
        responseObj.directToolsets = enablePlan.directToolsets;
        responseObj.bundleToolsets = enablePlan.bundleToolsets;
        const unavailablePieces = unavailableBundlePieces(selectedBundle, enableResult);
        if (unavailablePieces.length > 0) responseObj.unavailableBundlePieces = unavailablePieces;
      }
      if (summary.unavailable.length > 0) responseObj.unavailable = summary.unavailable;
      if (summary.alreadyEnabled.length > 0) responseObj.alreadyEnabled = summary.alreadyEnabled;
      if (tips.length > 0) responseObj.tips = tips;
      return managementResult(responseObj);
    }
  );

  registerManagementTool(
    'list_toolsets',
    {
      description: 'Show all toolsets with tool count, required layer, availability, and enabled state.',
      inputSchema: {},
    },
    async () => {
      const toolsets = await toolsetManager.listToolsets();
      const activeToolCount = MANAGEMENT_TOOL_COUNT
        + toolsetManager.getAdditionalVisibleToolCount()
        + toolsets
          .filter(toolset => toolset.enabled)
          .reduce((sum, toolset) => sum + toolset.toolCount, 0);
      const summary = {
        total: toolsets.length,
        available: toolsets.filter(toolset => toolset.available).length,
        enabled: toolsets.filter(toolset => toolset.enabled).length,
        activeToolCount,
      };
      if (activeToolCount > 40) {
        summary.warning = `${activeToolCount} active tools exceeds the recommended 40-tool limit. Use disable_toolset to shed unneeded toolsets.`;
      }
      return managementResult({ ok: true, toolsets, summary, projectContext: projectContext.snapshot() });
    }
  );

  registerManagementTool(
    'enable_toolset',
    {
      description: 'Explicitly enable one or more toolsets by name.',
      inputSchema: {
        toolsets: z.array(z.string()),
      },
    },
    async ({ toolsets: names }) => {
      if (!projectContext.identity) {
        return managementResult({
          ok: true,
          enabled: [],
          alreadyEnabled: [],
          unavailable: names,
          unknown: [],
          code: PROJECT_ERROR_CODES.PROJECT_NOT_ATTACHED,
          projectContext: projectContext.snapshot(),
        });
      }
      const result = await toolsetManager.enable(names);
      return managementResult({ ok: true, ...result, projectContext: projectContext.snapshot() });
    }
  );

  registerManagementTool(
    'disable_toolset',
    {
      description: 'Disable one or more toolsets to free context.',
      inputSchema: {
        toolsets: z.array(z.string()),
      },
    },
    async ({ toolsets: names }) => {
      const result = toolsetManager.disable(names);
      return managementResult({ ok: true, ...result, projectContext: projectContext.snapshot() });
    }
  );

  registerManagementTool(
    'list_project_targets',
    {
      description: 'Read repo-root .uemcp-targets.json profiles or legacy .uemcp-targets.txt and report validated attachment candidates.',
      inputSchema: LIST_PROJECT_TARGETS_INPUT_SHAPE,
    },
    async (args) => {
      const targets = readProjectTargets({
        repoRoot,
        clientRoots: projectContext.workspaceRoots,
        fsImpl: options.fsImpl,
        profile: args.profile,
      });
      return managementResult({ ok: true, targets, projectContext: projectContext.snapshot() });
    }
  );

  registerManagementTool(
    'attach_project',
    {
      description: 'Attach a project for the current MCP session.',
      inputSchema: ATTACH_PROJECT_INPUT_SHAPE,
    },
    async (args) => {
      try {
        const hasExplicitSource = !!(args.project_root || args.uproject_path || args.target || args.from_running_editor);
        if (args.prompt && !hasExplicitSource) {
          const capabilities = server.server.getClientCapabilities();
          if (!supportsFormElicitation(capabilities)) {
            return projectError(
              PROJECT_ERROR_CODES.ELICITATION_UNAVAILABLE,
              'Client did not negotiate form elicitation support.',
              { next: { tool: 'attach_project' }, projectContext: projectContext.snapshot() }
            );
          }

          const elicited = await server.server.elicitInput({
            mode: 'form',
            message: 'Attach a UEMCP Unreal project for this session.',
            requestedSchema: {
              type: 'object',
              properties: {
                project_path: { type: 'string', title: 'Project path' },
                target: { type: 'string', title: 'Target alias' },
                target_profile: { type: 'string', title: 'Target profile' },
                allow_outside_client_roots: { type: 'boolean', title: 'Allow outside client roots' },
              },
            },
          });

          if (elicited.action === 'decline') {
            return projectError(
              PROJECT_ERROR_CODES.ELICITATION_UNAVAILABLE,
              'Project attachment prompt was declined.',
              { next: { tool: 'attach_project' }, projectContext: projectContext.snapshot() }
            );
          }
          if (elicited.action === 'cancel') {
            return projectError(
              PROJECT_ERROR_CODES.PROJECT_NOT_ATTACHED,
              'Project attachment prompt was cancelled.',
              { next: { tool: 'attach_project' }, projectContext: projectContext.snapshot() }
            );
          }

          const content = elicited.content || {};
          const nextArgs = {
            allow_outside_client_roots: content.allow_outside_client_roots === true,
          };
          if (content.target) {
            nextArgs.target = content.target;
            if (content.target_profile) nextArgs.target_profile = content.target_profile;
          } else if (content.project_path && /\.uproject$/i.test(content.project_path)) {
            nextArgs.uproject_path = content.project_path;
          } else if (content.project_path) {
            nextArgs.project_root = content.project_path;
          }
          const snap = await projectContext.attachProject(nextArgs);
          return structuredResult({ ok: true, projectContext: snap });
        }

        const snap = await projectContext.attachProject(args);
        return structuredResult({ ok: true, projectContext: snap });
      } catch (err) {
        if (err instanceof ProjectContextError || err.code) {
          return makeProjectToolResult(err);
        }
        throw err;
      }
    }
  );

  registerManagementTool(
    'detach_project',
    {
      description: 'Clear manual project attachment and rerun workspace resolution.',
      inputSchema: {},
    },
    async () => {
      const snap = await projectContext.detachProject();
      return structuredResult({ ok: true, projectContext: snap });
    }
  );

  registerManagementTool(
    'refresh_project_context',
    {
      description: 'Refresh roots/candidates and re-resolve project attachment.',
      inputSchema: {},
    },
    async () => {
      const snap = await refreshFromRootsSource('refresh_project_context');
      return structuredResult({ ok: true, projectContext: snap });
    }
  );

  assertManagementAnnotationPolicies(registeredManagementTools);

  toolsetManager.onListChanged(() => {
    server.server.sendToolListChanged();
  });

  function registerDynamicTools() {
    registerToolGroup(
      server, toolsetManager, projectContext, log, 'offline', 'offline',
      TOOLS_YAML.toolsets.offline.tools,
      buildOfflineSchemaShape,
      (name, args) => executeOfflineTool(
        name,
        args,
        projectContext.identity?.projectRoot || connectionManager.getAttachedProjectRoot()
      )
    );

    registerToolGroup(
      server, toolsetManager, projectContext, log, 'actors', 'actors',
      getActorsToolDefs(),
      buildTcpSchemaShape,
      (name, args) => executeActorsTool(name, args, connectionManager)
    );

    registerToolGroup(
      server, toolsetManager, projectContext, log, 'blueprints-write', 'blueprints-write',
      getBlueprintsWriteToolDefs(),
      buildTcpSchemaShape,
      (name, args) => executeBlueprintsWriteTool(name, args, connectionManager)
    );

    registerToolGroup(
      server, toolsetManager, projectContext, log, 'widgets', 'widgets',
      getWidgetsToolDefs(),
      buildTcpSchemaShape,
      (name, args) => executeWidgetsTool(name, args, connectionManager)
    );

    registerToolGroup(
      server, toolsetManager, projectContext, log, 'remote-control', 'rc',
      getRcToolDefs(),
      buildTcpSchemaShape,
      (name, args) => executeRcTool(name, args, connectionManager)
    );

    registerToolGroup(
      server, toolsetManager, projectContext, log, 'm-enhance', 'm-enhance',
      getMenhanceToolDefs(),
      buildTcpSchemaShape,
      (name, args) => executeMenhanceTool(name, args, connectionManager)
    );

    const m5ToolsetGroups = [
      { name: 'animation', defs: getM5AnimationToolDefs(), execute: executeM5AnimationTool },
      { name: 'materials', defs: getM5MaterialsToolDefs(), execute: executeM5MaterialsTool },
      { name: 'input-and-pie', defs: getM5InputPieToolDefs(), execute: executeM5InputPieTool },
      { name: 'geometry', defs: getM5GeometryToolDefs(), execute: executeM5GeometryTool },
      { name: 'editor-utility', defs: getM5EditorUtilityToolDefs(), execute: executeM5EditorUtilityTool },
    ];

    for (const group of m5ToolsetGroups) {
      registerToolGroup(
        server, toolsetManager, projectContext, log, group.name, `m5 ${group.name}`,
        group.defs,
        buildTcpSchemaShape,
        (name, args) => group.execute(name, args, connectionManager)
      );
    }
  }

  let prepared = false;
  async function prepare() {
    if (prepared) return;
    prepared = true;

    await toolsetManager.load();
    initActorsTools(toolsetManager.getToolsData());
    initBlueprintsWriteTools(toolsetManager.getToolsData());
    initWidgetsTools(toolsetManager.getToolsData());
    initMenhanceTools(toolsetManager.getToolsData());
    initM5AnimationTools(toolsetManager.getToolsData());
    initM5MaterialsTools(toolsetManager.getToolsData());
    initM5InputPieTools(toolsetManager.getToolsData());
    initM5GeometryTools(toolsetManager.getToolsData());

    const pythonExecEnabled =
      options.argv?.includes('--enable-python-exec') ||
      env.UEMCP_ENABLE_PYTHON_EXEC === '1';
    initM5EditorUtilityTools(toolsetManager.getToolsData(), { pythonExecEnabled });
    if (pythonExecEnabled) {
      stderr.write('[uemcp] Python execution enabled - run_python_command will accept calls (deny-list still applies)\n');
    }

    registerDynamicTools();

    if (projectContext.attachMode === 'env') {
      await projectContext.initializeFromProcessHints({ workspaceRoots: fallbackWorkspaceRoots });
    }
  }

  server.server.oninitialized = async () => {
    await refreshFromRootsSource('initialized');
  };

  server.server.setNotificationHandler(
    RootsListChangedNotificationSchema,
    async () => {
      await refreshFromRootsSource('roots_list_changed');
    }
  );

  async function start(transport) {
    await prepare();
    await server.connect(transport);
    stderr.write(`[uemcp] Server started for project: ${projectContext.identity?.projectName || config.projectName || '(auto-detect)'}\n`);
    stderr.write(`[uemcp] Tools indexed: ${toolIndex.size}\n`);
  }

  return {
    server,
    connectionManager,
    toolsetManager,
    toolIndex,
    projectContext,
    config,
    start,
  };
}
