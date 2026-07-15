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

const SERVER_INSTRUCTIONS = [
  'Unreal Engine project tools organized into dynamic toolsets.',
  'Call find_tools(query) to discover and auto-enable relevant toolsets.',
  'Disable unneeded toolsets to free context.',
  'Some toolsets require the editor; offline tools work against project files on disk.',
  'For source file reading use `Read`; for source search use `Grep`; for content tree browsing use `Glob`. UEMCP offline tools cover UE-specific parsing that native tools cannot do.',
  'list_config_values is progressive: () -> files, (file) -> sections, (file, section, key) -> values.',
  'search_gameplay_tags globs: * = one level, ** = across levels.',
].join(' ');

const MANAGEMENT_TOOL_COUNT = 10;

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
    const requirement = getToolRequirement(name, toolsetName, def);
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
            { requirement, toolName: name, toolsetName },
            async () => {
              let mutationId = null;
              if (isMutationRequirement(requirement)) {
                mutationId = projectContext.beginMutation({ toolName: name, toolsetName, requirement });
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

const TOOLSET_TIPS = {
  'actors': {
    core: [
      'spawn_actor supports only 5 types: StaticMeshActor, PointLight, SpotLight, DirectionalLight, CameraActor.',
      'Actor names are exact-match lookups (case-sensitive). Use find_actors(pattern) for substring search, get_actors() for full list.',
      'set_actor_property supports bool/int/float/string/enum only - no Vector, Rotator, or struct types. Use set_actor_transform for position/rotation/scale.',
      'focus_viewport needs either target (actor name) OR location - not both. Camera offsets on X axis at the given distance.',
      'spawn_blueprint_actor accepts a fully-qualified `/Game/...` path (preferred, unambiguous) or a bare asset name (resolved via /Game/Blueprints/ first, then AssetRegistry project-wide; ambiguous bare names error explicitly with all candidates listed).',
      'take_screenshot saves to the editor machine filesystem. For inline base64, use get_viewport_screenshot (visual-capture toolset).',
    ].join(' '),
    workflows: [
      {
        requires: ['blueprints-write'],
        tip: 'Typical actor workflow: create_blueprint -> add_component -> set_component_property -> compile_blueprint -> spawn_blueprint_actor. Always compile before spawning.',
      },
      {
        requires: ['offline'],
        tip: 'Use Grep against Source/ to find C++ class names behind actors, then get_actor_properties to inspect instances in the level.',
      },
    ],
  },

  'blueprints-write': {
    core: [
      'blueprint_name accepts a fully-qualified `/Game/...` path or a bare asset name. Bare names check `/Game/Blueprints/<Name>` first (back-compat), then fall back to project-wide AssetRegistry lookup. Pass a full path to disambiguate when multiple BPs share a name.',
      'add_component auto-compiles the blueprint. Other mutations (set_component_property, set_blueprint_property) do NOT - call compile_blueprint explicitly.',
      'compile_blueprint returns diagnostic-quality lifecycle output: succeeded/compiled/compiled_ok, error and warning counts, messages, generated-class status, dirty status, and package path.',
      'add_variable_assignment authors target_variable = literal or target_variable = source_variable in a target graph, returning node/pin/link metadata and requires_compile.',
      'set_pawn_props returns per-property results - partial success is possible. Check the results object.',
      'Node graph commands return node GUIDs. Use connect_nodes with source/target GUIDs + pin names to wire them together.',
      'find_nodes currently supports only node_type="Event". Other types are not yet searchable.',
      'add_function_node has complex resolution: specify target class (e.g., "GameplayStatics") to find library functions, or omit for BP-local functions.',
      'add_variable supports only 5 types: Boolean, Integer/Int, Float, String, Vector.',
    ].join(' '),
    workflows: [
      {
        requires: ['actors'],
        tip: 'After modifying a blueprint (add_component, set_component_property, etc.), compile_blueprint then re-spawn_blueprint_actor to see changes in the level.',
      },
      {
        requires: ['offline'],
        tip: 'Use Grep against Source/ to find C++ base class signatures before adding function/event nodes. Confirm event names match exactly (e.g., ReceiveBeginPlay, not BeginPlay).',
      },
    ],
  },

  'widgets': {
    core: [
      'Widget blueprints live under /Game/Widgets/ - pass name only to create_widget / add_text_block / add_button / bind_widget_event / set_text_block_binding / add_widget_to_viewport. add_input_action_node operates on a regular UBlueprint and accepts a fully-qualified `/Game/...` path or a bare name (same resolution chain as the blueprints-write toolset).',
      'create_widget auto-adds a root CanvasPanel. add_text_block and add_button require this root - they fail if the root is not a CanvasPanel.',
      'add_button creates a child TextBlock named <widget_name>_Text automatically.',
      'add_widget_to_viewport requires PIE running (engine restriction - AddToViewport needs a live game world). Returns NOT_IN_PIE error if PIE is not active; start_pie first then re-call.',
      'set_text_block_binding creates a pure FText getter function and registers FDelegateEditorBinding on the TextBlock\'s Text property - fully wired, ready to evaluate at runtime.',
      'bind_widget_event checks for existing events first - safe to call multiple times without creating duplicates.',
    ].join(' '),
    workflows: [
      {
        requires: ['blueprints-write'],
        tip: 'add_input_action_node (in this toolset) uses legacy Input Actions, NOT Enhanced Input. For Enhanced Input, use the input-and-pie toolset instead.',
      },
    ],
  },

  'remote-control': {
    core: [
      'Uses HTTP:30010 (Remote Control API) - editor must be running AND have RemoteControl engine plugin enabled (UEMCP\'s uplugin transitively requests it; verify your .uproject Plugins[] if RC calls fail).',
      'rc_get_property / rc_set_property / rc_call_function operate on ANY UObject by object path. CDO form: /Game/Path/<AssetName>.Default__<AssetName>_C for class-default-object reads (single-dot separator; the doubled "BP_C:Default__BP_C" form does NOT resolve).',
      'rc_set_property wraps value in a propertyName-keyed object automatically (do not pre-wrap). generateTransaction:true records in editor Undo stack - leave on unless you have a reason.',
      'SanitizeMetadata allowlist (D66) caps RC metadata to {UIMin, UIMax, ClampMin, ClampMax, ToolTip}. For Category/Replicated/EditAnywhere flag surface, use blueprint-read tools (plugin-backed) instead - they bypass the allowlist.',
      'rc_passthrough accepts any /remote/* endpoint - escape hatch for RC calls the structured helpers do not cover. Paths not starting with /remote/ are rejected.',
    ].join(' '),
    workflows: [
      {
        requires: ['blueprint-read'],
        tip: 'For Blueprint variable inspection: prefer blueprint-read.get_blueprint_variables over rc_describe_object - it returns the full flag set (Category, Replicated, EditAnywhere) that RC\'s allowlist cannot expose.',
      },
      {
        requires: ['actors'],
        tip: 'To write a property on a live actor (not CDO), get the actor path via get_actor_properties first, then rc_set_property with that object_path. For CDO edits, use set_blueprint_property (blueprints-write toolset) - it is the transactional editor path.',
      },
      {
        requires: ['blueprints-write'],
        tip: 'D100 contract - after PIE start/stop cycles, newly-created BP CDOs may be GC\'d. If rc_get_property returns "object not found" on a path the AssetRegistry confirms exists on disk, call compile_blueprint on that BP first to force-reload the GeneratedClass + CDO, then retry the read.',
      },
    ],
  },

  'blueprint-read': {
    core: [
      'Plugin-backed (tcp-55558) - full flag surface including Category/Replicated/EditAnywhere that RC\'s SanitizeMetadata allowlist strips out. Prefer these over rc_describe_object when you need reflection fidelity.',
      'get_blueprint_info returns summary {super_class, interfaces, property_count, function_count}. Follow up with get_blueprint_variables or get_blueprint_functions for the full lists.',
      'get_blueprint_components filters get_blueprint_variables down to component-class properties (heuristic: property_class contains "Component" OR name ends _GEN_VARIABLE SCS suffix). Conservative - may miss exotic cases.',
      'bp_compile_and_report triggers a fresh compile and captures FCompilerResultsLog with node_guid attribution. blueprints-write.compile_blueprint now also returns diagnostic counts/messages, but bp_compile_and_report remains the richer read-focused graph diagnostic surface.',
      'get_widget_blueprint walks UWidgetTree root recursively. Empty widget trees return root_widget:null (valid, not an error).',
    ].join(' '),
    workflows: [
      {
        requires: ['offline'],
        tip: 'For asset-file-level reads without editor running, use inspect_blueprint + read_asset_properties (offline). blueprint-read tools require the editor loaded - they give LIVE reflection, offline tools give on-disk state.',
      },
      {
        requires: ['sidecar'],
        tip: 'If sidecar files exist at <Project>/Saved/UEMCP/..., their narrow-sidecar-v1 shape carries the same reflection surface these tools return - useful as a cache when editor is closed. regenerate_sidecar backfills missing ones.',
      },
    ],
  },

  'sidecar': {
    core: [
      'Narrow-sidecar = plugin-only fields (compile status + full reflection surface) written to <Project>/Saved/UEMCP/<package-path>.sidecar.json.',
      'Save-hook auto-writes on every Blueprint save (FCoreUObjectDelegates::OnObjectPreSave). regenerate_sidecar is for backfill - assets that exist but have not been re-saved since save-hook shipped.',
      'Sidecar does NOT contain edge topology (use S-B-base offline tools like bp_list_graphs / bp_trace_exec), positions (M-spatial), or via_knots (offline post-pass). Those layers are offline-primary by design (phase3-resequence section L).',
      'schema_version "narrow-sidecar-v1" - future bumps change the marker. Consumers should check before trusting fields.',
    ].join(' '),
    workflows: [
      {
        requires: ['offline'],
        tip: 'For fully offline BP introspection, combine: S-B-base edge tools (offline) + sidecar files on disk (plugin-only reflection). Save-hook keeps sidecars fresh; regenerate_sidecar backfills untouched assets.',
      },
    ],
  },

  'animation': {
    core: [
      'get_montage_full, get_anim_sequence_info, and get_anim_graph are full tcp-55558 asset-instance reads - they load UAnimMontage/UAnimSequence/UAnimBlueprint and return montage sections, notifies, slot tracks, sequence skeleton/rate data, and static AnimGraph topology. Use get_anim_graph include_pin_topology=true when you need visual UEdGraph node/pin/LinkedTo wiring. get_blend_space and get_anim_curve_data remain reflection-backed reads; pair with read_asset_properties (offline) for batch file-level inspection.',
      'Mutation tools (create_montage, add_montage_section, add_montage_notify) live on tcp-55558 (UEMCP plugin, M5-anim+mat per D105). create_montage emits a single DefaultSlot (D119 NEW-1 fix); section_name in add_montage_section must not collide with existing sections - API silently overwrites.',
    ].join(' '),
    workflows: [
      {
        requires: ['offline'],
        tip: 'For montage sections / notifies / curve keyframes without editor, use read_asset_properties - D50 tagged-fallback covers their struct-typed fields via FPropertyTag iteration.',
      },
    ],
  },

  'data-assets': {
    core: [
      'get_struct_definition / get_datatable_contents / get_string_table / list_data_asset_types all PARTIAL-RC - plugin reflection walk for schema + engine APIs for row data (UDataTable::GetTableAsCSV, UStringTable::EnumerateSourceStrings).',
      'get_datatable_contents returns {csv, row_names, row_struct_properties}. For per-row structured values, parse the CSV OR use offline read_asset_properties - both give the same data, the latter is editor-optional.',
      'list_data_asset_types walks TObjectIterator<UClass> in-memory - only modules currently loaded appear. If you expect a class to show but it is missing, the owning module has not been loaded yet.',
      'set_data_asset_property accepts a fully-qualified `/Game/...` path or a bare asset name (resolved via AssetRegistry). Type coercion on struct-typed fields can be quirky - verify with read_asset_properties (offline) after a write.',
    ].join(' '),
    workflows: [
      {
        requires: ['offline'],
        tip: 'read_asset_properties (offline) + tagged-fallback D50 covers 601 unique struct names without loading the owning module - preferred for batch analysis that does not need the editor.',
      },
    ],
  },

  'input-and-pie': {
    core: [
      'Enhanced Input tools (create_input_action, create_mapping_context, add_mapping) are asset-creation only - they do NOT bind runtime input. Binding happens in BP graph or C++.',
      'start_pie accepts mode: "viewport" (default), "standalone" (new process), "new_window" (in-process). Async request - IsPlaySessionInProgress may not flip immediately.',
      'stop_pie returns {was_running, requested_stop} - success means the request was issued, not that teardown completed. PIE teardown is async and may leave references briefly.',
      'execute_console_command runs against PlayWorld if PIE is active, else editor world. Commands like "stat fps" need PIE; "listassets *" works editor-side.',
      'is_pie_running is a snapshot query - volatile across calls (skip cache).',
    ].join(' '),
    workflows: [
      {
        requires: ['actors'],
        tip: 'Test loop: spawn_blueprint_actor -> start_pie -> observe -> stop_pie. For hot-reload without full PIE cycle, compile_blueprint reliably hot-reloads CDO changes into the open editor.',
      },
    ],
  },

  'editor-utility': {
    core: [
      'get_editor_state returns {selected_actors, viewport: {location, rotation, fov}, pie_running, world_path}. Useful as a cheap snapshot before a complex multi-tool operation.',
      'run_python_command - SECURITY-SENSITIVE. Two layers must both pass: (1) MCP server must be launched with --enable-python-exec flag (or UEMCP_ENABLE_PYTHON_EXEC=1 env var); without it every call returns PYTHON_EXEC_DISABLED. (2) The script is scanned against a deny-list (os, subprocess, eval, exec, open, __import__) and refused with PYTHON_EXEC_DENY_LIST + matched_pattern. Every executed call is audit-logged to <ProjectName>.log under [UEMCP-PYTHON-EXEC]. Prefer structured tools when possible.',
      'delete_asset_safe defaults to soft-delete: asset is renamed into /Game/_Deleted/<name>_<hash> with reference fixup (recoverable by renaming back). Hard delete requires permanent:true AND force:true; passing permanent:true alone yields BAD_PARAMS. Referencers block the delete unless force:true; the response detail.referencers field lists them. Every successful delete is audit-logged under [UEMCP-DELETE-ASSET].',
      'duplicate_asset refuses pre-existing destinations unless overwrite:true - pass it explicitly when you intend to replace.',
      'rename_asset accepts a bare new_name (target package directory inferred from source) OR a full /Game/... destination path.',
      'get_editor_utility_blueprint surfaces EUB-specific run_method.{present, name, num_params, has_return} + editor_menu.{registered, custom_tab_name} fields beyond the standard parent_class/generated_class. For reflection-deep BP fields use get_blueprint_info instead.',
      'Many tools here have been displaced by offline equivalents (inspect_blueprint, read_asset_properties) - prefer those when editor-closed is viable.',
    ].join(' '),
    workflows: [
      {
        requires: ['actors'],
        tip: 'Before spawning or modifying actors, get_editor_state confirms which level is current + which actors are selected - lets you scope operations without ambiguity.',
      },
      {
        requires: ['asset-registry'],
        tip: 'Before delete_asset_safe with force:true, run get_asset_references to see exactly which assets will have broken references. Soft-delete with force:true preserves references via rename-fixup; hard-delete with force:true breaks them.',
      },
    ],
  },

  'asset-registry': {
    core: [
      'get_asset_references returns {referencers, dependencies, num_*}. The referencers list answers "who uses this asset"; dependencies answers "what does this asset use". Use it for reverse-dependency checks, impact analysis, and delete planning.',
      'Package-name normalization is automatic: accepts both object path (/Game/X.X_C) and package path (/Game/X); strips the object suffix internally.',
      'For broad queries (all assets of class X, path pattern globs), use offline query_asset_registry - it reads AssetRegistry.bin directly without editor.',
    ].join(' '),
    workflows: [
      {
        requires: ['offline'],
        tip: 'Combine: query_asset_registry (offline bulk scan) -> get_asset_references (editor-side reverse-deps) for a full impact-analysis workflow without round-tripping asset-by-asset.',
      },
    ],
  },
};

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

  const registeredManagementToolNames = new Set();

  function registerManagementTool(name, configObject, handler) {
    registeredManagementToolNames.add(name);
    return server.registerTool(
      name,
      {
        ...configObject,
        outputSchema: MANAGEMENT_OUTPUT_SHAPE,
        annotations: getToolAnnotations(name, TOOL_REQUIREMENT_KINDS.MANAGEMENT),
      },
      handler
    );
  }

  function assertManagementAnnotationPolicies() {
    const unregisteredSessionStateTools = [...MANAGEMENT_SESSION_STATE_TOOLS]
      .filter(name => !registeredManagementToolNames.has(name));
    if (unregisteredSessionStateTools.length > 0) {
      throw new Error(
        `Management session-state tools must be registered: ${unregisteredSessionStateTools.join(', ')}`
      );
    }

    for (const name of registeredManagementToolNames) {
      const annotations = getToolAnnotations(name, TOOL_REQUIREMENT_KINDS.MANAGEMENT);
      const isInspectionPolicy = annotations.readOnlyHint === true && !('destructiveHint' in annotations);
      const isSessionStatePolicy = annotations.readOnlyHint === false && annotations.destructiveHint === false;
      if (!isInspectionPolicy && !isSessionStatePolicy) {
        throw new Error(`Management tool ${name} has an unsupported annotation policy`);
      }
      if (isSessionStatePolicy !== MANAGEMENT_SESSION_STATE_TOOLS.has(name)) {
        throw new Error(`Management tool ${name} does not match its session-state policy`);
      }
    }
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

  assertManagementAnnotationPolicies();

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
