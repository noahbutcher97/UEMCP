// UEMCP Server — Entry point
// Phase 1: Core server + dynamic toolset infrastructure
//
// Architecture:
//   stdio transport (MCP SDK) → ToolsetManager → ConnectionManager → 4 layers
//   See docs/architecture.md for full diagram
//
// Usage:
//   Launched by Claude via .mcp.json — not run manually in production.
//   For development: UNREAL_PROJECT_ROOT="D:/path/to/project" node server.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ConnectionManager } from './connection-manager.mjs';
import { ToolIndex } from './tool-index.mjs';
import { ToolsetManager } from './toolset-manager.mjs';
import { executeOfflineTool } from './offline-tools.mjs';
import { buildZodSchema } from './zod-builder.mjs';
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
// M5-PREP scaffold (D101) — 5 toolset stubs covering 19 not-yet-shipped tools.
// Each module exports an empty SCHEMAS object until the sub-worker fills it.
// The for-loops below iterate zero times until then, so no MCP tools register
// — sub-workers ship their toolset by editing ONLY their own m5-*-tools.mjs
// file (no edit to server.mjs required).
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

// ── Synchronous yaml preload (D44) ─────────────────────────────────
// tools.yaml is the single source of truth for tool descriptions and params.
// Offline registration (below) reads from this instead of a duplicated local
// const. ToolsetManager.load() does its own async re-read during main() —
// this is an acceptable ~5KB double-parse for a zero-API-surface refactor.
const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_YAML = yaml.load(readFileSync(join(__dirname, '..', 'tools.yaml'), 'utf-8'));

// ── Config from environment (.mcp.json env block) ──────────────────

const config = Object.freeze({
  projectRoot:     process.env.UNREAL_PROJECT_ROOT || '',
  projectName:     process.env.UNREAL_PROJECT_NAME || '',
  tcpPortExisting: parseInt(process.env.UNREAL_TCP_PORT_EXISTING || '55557', 10),
  tcpPortCustom:   parseInt(process.env.UNREAL_TCP_PORT_CUSTOM   || '55558', 10),
  tcpTimeoutMs:    parseInt(process.env.UNREAL_TCP_TIMEOUT_MS    || '5000',  10),
  rcPort:          parseInt(process.env.UNREAL_RC_PORT           || '30010', 10),
  autoDetect:      process.env.UNREAL_AUTO_DETECT !== 'false',
});

// ── Server instructions ────────────────────────────────────────────
// Sent to Claude during initialization. Describes the dynamic toolset workflow.
//
// TODO(noah): Review and edit this — it shapes how Claude navigates the server.
// See docs/risks-and-decisions.md D20 for context.

const SERVER_INSTRUCTIONS = [
  'Unreal Engine project tools organized into dynamic toolsets.',
  'Call find_tools(query) to discover and auto-enable relevant toolsets.',
  'Disable unneeded toolsets to free context.',
  'Some toolsets require the editor; offline tools work against project files on disk.',
  // Offline toolset is always-on, so its key constraints live here:
  'For source file reading use `Read`; for source search use `Grep`; for content tree browsing use `Glob`. UEMCP offline tools cover UE-specific parsing that native tools cannot do (gameplay tags, config drill-down, Target.cs parsing, binary asset registry).',
  'list_config_values is progressive: () → files, (file) → sections, (file, section, key) → values.',
  'search_gameplay_tags globs: * = one level, ** = across levels.',
].join(' ');

// ── Per-toolset tips ──────────────────────────────────────────
// Delivered in enable_toolset and find_tools responses when a toolset
// is newly activated. These cover cross-tool workflows and constraints
// that individual tool descriptions can't convey.
//
// Structure:
//   core:      string — tips for this toolset in isolation
//   workflows: array  — cross-toolset tips, each with requires[]
//                        (only delivered when all required toolsets are active)
//
// Offline tips live in SERVER_INSTRUCTIONS instead (always-on toolset).
// Future upgrade path (D): extract all workflows[] entries into a flat
// WORKFLOW_TIPS array with query-intent matching via find_tools.

const TOOLSET_TIPS = {

  'actors': {
    core: [
      'spawn_actor supports only 5 types: StaticMeshActor, PointLight, SpotLight, DirectionalLight, CameraActor.',
      'Actor names are exact-match lookups (case-sensitive). Use find_actors(pattern) for substring search, get_actors() for full list.',
      'set_actor_property supports bool/int/float/string/enum only — no Vector, Rotator, or struct types. Use set_actor_transform for position/rotation/scale.',
      'focus_viewport needs either target (actor name) OR location — not both. Camera offsets on X axis at the given distance.',
      'spawn_blueprint_actor looks up blueprints under /Game/Blueprints/ only — pass just the asset name, not a full path.',
      'take_screenshot saves to the editor machine filesystem. For inline base64, use get_viewport_screenshot (visual-capture toolset).',
    ].join(' '),
    workflows: [
      {
        requires: ['blueprints-write'],
        tip: 'Typical actor workflow: create_blueprint → add_component → set_component_property → compile_blueprint → spawn_blueprint_actor. Always compile before spawning.',
      },
      {
        requires: ['offline'],
        tip: 'Use Grep against Source/ to find C++ class names behind actors, then get_actor_properties to inspect instances in the level.',
      },
    ],
  },

  'blueprints-write': {
    core: [
      'All blueprint commands use name-only lookup under /Game/Blueprints/ — pass "MyBP", not "/Game/Blueprints/MyBP".',
      'add_component auto-compiles the blueprint. Other mutations (set_component_property, set_blueprint_property) do NOT — call compile_blueprint explicitly.',
      'compile_blueprint always returns compiled:true even if there are compile errors — no error output in response.',
      'set_pawn_props returns per-property results — partial success is possible. Check the results object.',
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
      'Widget blueprints live under /Game/Widgets/ (not /Game/Blueprints/). Pass name only.',
      'create_widget auto-adds a root CanvasPanel. add_text_block and add_button require this root — they fail if the root is not a CanvasPanel.',
      'add_button creates a child TextBlock named <widget_name>_Text automatically.',
      'add_widget_to_viewport requires PIE running (engine restriction — AddToViewport needs a live game world). Returns NOT_IN_PIE error if PIE is not active; start_pie first then re-call.',
      'set_text_block_binding creates a pure FText getter function and registers FDelegateEditorBinding on the TextBlock\'s Text property — fully wired, ready to evaluate at runtime.',
      'bind_widget_event checks for existing events first — safe to call multiple times without creating duplicates.',
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
      'Uses HTTP:30010 (Remote Control API) — editor must be running AND have RemoteControl engine plugin enabled (UEMCP\'s uplugin transitively requests it; verify your .uproject Plugins[] if RC calls fail).',
      'rc_get_property / rc_set_property / rc_call_function operate on ANY UObject by object path. CDO form: /Game/Path/<AssetName>.Default__<AssetName>_C for class-default-object reads (single-dot separator; the doubled "BP_C:Default__BP_C" form does NOT resolve).',
      'rc_set_property wraps value in a propertyName-keyed object automatically (don\'t pre-wrap). generateTransaction:true records in editor Undo stack — leave on unless you have a reason.',
      'SanitizeMetadata allowlist (D66) caps RC metadata to {UIMin, UIMax, ClampMin, ClampMax, ToolTip}. For Category/Replicated/EditAnywhere flag surface, use blueprint-read tools (plugin-backed) instead — they bypass the allowlist.',
      'rc_passthrough accepts any /remote/* endpoint — escape hatch for RC calls the structured helpers don\'t cover. Paths not starting with /remote/ are rejected.',
    ].join(' '),
    workflows: [
      {
        requires: ['blueprint-read'],
        tip: 'For Blueprint variable inspection: prefer blueprint-read.get_blueprint_variables over rc_describe_object — it returns the full flag set (Category, Replicated, EditAnywhere) that RC\'s allowlist cannot expose.',
      },
      {
        requires: ['actors'],
        tip: 'To write a property on a live actor (not CDO), get the actor path via get_actor_properties first, then rc_set_property with that object_path. For CDO edits, use set_blueprint_property (blueprints-write toolset) — it\'s the transactional editor path.',
      },
    ],
  },

  'blueprint-read': {
    core: [
      'Plugin-backed (tcp-55558) — full flag surface including Category/Replicated/EditAnywhere that RC\'s SanitizeMetadata allowlist strips out. Prefer these over rc_describe_object when you need reflection fidelity.',
      'get_blueprint_info returns summary {super_class, interfaces, property_count, function_count}. Follow up with get_blueprint_variables or get_blueprint_functions for the full lists.',
      'get_blueprint_components filters get_blueprint_variables down to component-class properties (heuristic: property_class contains "Component" OR name ends _GEN_VARIABLE SCS suffix). Conservative — may miss exotic cases.',
      'bp_compile_and_report triggers a fresh compile and captures FCompilerResultsLog. Unlike the blueprints-write.compile_blueprint on tcp-55557 (old UnrealMCP), this returns errors + warnings + node_guid attribution.',
      'get_widget_blueprint walks UWidgetTree root recursively. Empty widget trees return root_widget:null (valid, not an error).',
    ].join(' '),
    workflows: [
      {
        requires: ['offline'],
        tip: 'For asset-file-level reads without editor running, use inspect_blueprint + read_asset_properties (offline). blueprint-read tools require the editor loaded — they give LIVE reflection, offline tools give on-disk state.',
      },
      {
        requires: ['sidecar'],
        tip: 'If sidecar files exist at <Project>/Saved/UEMCP/..., their narrow-sidecar-v1 shape carries the same reflection surface these tools return — useful as a cache when editor is closed. regenerate_sidecar backfills missing ones.',
      },
    ],
  },

  'sidecar': {
    core: [
      'Narrow-sidecar = plugin-only fields (compile status + full reflection surface) written to <Project>/Saved/UEMCP/<package-path>.sidecar.json.',
      'Save-hook auto-writes on every Blueprint save (FCoreUObjectDelegates::OnObjectPreSave). regenerate_sidecar is for backfill — assets that exist but haven\'t been re-saved since save-hook shipped.',
      'Sidecar does NOT contain edge topology (use S-B-base offline tools like bp_list_graphs / bp_trace_exec), positions (M-spatial), or via_knots (offline post-pass). Those layers are offline-primary by design (phase3-resequence §L).',
      'schema_version "narrow-sidecar-v1" — future bumps change the marker. Consumers should check before trusting fields.',
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
      'Read-tools (get_montage_full, get_anim_sequence_info, get_blend_space, get_anim_curve_data) are PARTIAL-RC — they dispatch to plugin reflection_walk and return the UPROPERTY schema. For runtime-evaluated values (baked curve points, compiled blend output), pair with read_asset_properties (offline).',
      'Mutation tools (create_montage, add_montage_section, add_montage_notify) live on tcp-55557 (old UnrealMCP) — they take BP-style name-only lookup (NOT full /Game/ paths). Deprecated post-Phase-3; UEMCP rewrite forthcoming.',
      'section_name + time for add_montage_section must not collide with existing sections — API silently overwrites (known quirk of the UnrealMCP handler).',
    ].join(' '),
    workflows: [
      {
        requires: ['offline'],
        tip: 'For montage sections / notifies / curve keyframes without editor, use read_asset_properties — D50 tagged-fallback covers their struct-typed fields via FPropertyTag iteration.',
      },
    ],
  },

  'data-assets': {
    core: [
      'get_struct_definition / get_datatable_contents / get_string_table / list_data_asset_types all PARTIAL-RC — plugin reflection walk for schema + engine APIs for row data (UDataTable::GetTableAsCSV, UStringTable::EnumerateSourceStrings).',
      'get_datatable_contents returns {csv, row_names, row_struct_properties}. For per-row structured values, parse the CSV OR use offline read_asset_properties — both give the same data, the latter is editor-optional.',
      'list_data_asset_types walks TObjectIterator<UClass> in-memory — only modules currently loaded appear. If you expect a class to show but it\'s missing, the owning module hasn\'t been loaded yet.',
      'set_data_asset_property uses the old TCP:55557 handler — name-only lookup, type coercion quirks on struct-typed fields.',
    ].join(' '),
    workflows: [
      {
        requires: ['offline'],
        tip: 'read_asset_properties (offline) + tagged-fallback D50 covers 601 unique struct names without loading the owning module — preferred for batch analysis that doesn\'t need the editor.',
      },
    ],
  },

  'input-and-pie': {
    core: [
      'Enhanced Input tools (create_input_action, create_mapping_context, add_mapping) are asset-creation only — they do NOT bind runtime input. Binding happens in BP graph or C++.',
      'start_pie accepts mode: "viewport" (default), "standalone" (new process), "new_window" (in-process). Async request — IsPlaySessionInProgress may not flip immediately.',
      'stop_pie returns {was_running, requested_stop} — success means the request was issued, not that teardown completed. PIE teardown is async and may leave references briefly.',
      'execute_console_command runs against PlayWorld if PIE is active, else editor world. Commands like "stat fps" need PIE; "listassets *" works editor-side.',
      'is_pie_running is a snapshot query — volatile across calls (skip cache).',
    ].join(' '),
    workflows: [
      {
        requires: ['actors'],
        tip: 'Test loop: spawn_blueprint_actor → start_pie → observe → stop_pie. For hot-reload without full PIE cycle, compile_blueprint reliably hot-reloads CDO changes into the open editor.',
      },
    ],
  },

  'editor-utility': {
    core: [
      'get_editor_state returns {selected_actors, viewport: {location, rotation, fov}, pie_running, world_path}. Useful as a cheap snapshot before a complex multi-tool operation.',
      'run_python_command has a deny-list for dangerous APIs (os, subprocess, eval, exec, open, __import__) AND requires confirmation. Use sparingly — prefer structured tools.',
      'Many tools here have been displaced by offline equivalents (inspect_blueprint, read_asset_properties) — prefer those when editor-closed is viable.',
    ].join(' '),
    workflows: [
      {
        requires: ['actors'],
        tip: 'Before spawning or modifying actors, get_editor_state confirms which level is current + which actors are selected — lets you scope operations without ambiguity.',
      },
    ],
  },

  'asset-registry': {
    core: [
      'get_asset_references returns {referencers, dependencies, num_*}. The referencers list answers "who uses this asset" — essential before delete_asset.',
      'Package-name normalization is automatic: accepts both object path (/Game/X.X_C) and package path (/Game/X); strips the object suffix internally.',
      'For broad queries (all assets of class X, path pattern globs), use offline query_asset_registry — it reads AssetRegistry.bin directly without editor.',
    ].join(' '),
    workflows: [
      {
        requires: ['offline'],
        tip: 'Combine: query_asset_registry (offline bulk scan) → get_asset_references (editor-side reverse-deps) for a full impact-analysis workflow without round-tripping asset-by-asset.',
      },
    ],
  },

};

/**
 * Collect tips for newly enabled toolsets.
 * Returns formatted tip strings ready to include in MCP response content.
 * @param {string[]} newlyEnabled — toolset names just activated
 * @param {Set<string>} allEnabled — full set of currently enabled toolsets (including newlyEnabled)
 * @returns {string[]}
 */
function collectTips(newlyEnabled, allEnabled) {
  const tips = [];
  for (const name of newlyEnabled) {
    const entry = TOOLSET_TIPS[name];
    if (!entry) continue;

    const parts = [];
    if (entry.core) parts.push(entry.core);
    if (entry.workflows) {
      for (const wf of entry.workflows) {
        if (wf.requires.every(r => allEnabled.has(r))) {
          parts.push(wf.tip);
        }
      }
    }
    if (parts.length > 0) tips.push(`[${name}] ${parts.join(' ')}`);
  }
  return tips;
}

// ── Create MCP server ──────────────────────────────────────────────

const server = new McpServer(
  { name: 'uemcp', version: '0.1.0' },
  {
    capabilities: { logging: {} },
    instructions: SERVER_INSTRUCTIONS,
  }
);

// ── Logging helper ─────────────────────────────────────────────────
// The v1 .tool() API doesn't expose ctx.mcpReq.log(). We log via the
// low-level server's sendLoggingMessage, with stderr fallback.

function log(level, message) {
  try {
    server.sendLoggingMessage({ level, data: message });
  } catch {
    process.stderr.write(`[uemcp:${level}] ${message}\n`);
  }
}

// ── Initialize subsystems ──────────────────────────────────────────

const connectionManager = new ConnectionManager(config);
const toolIndex = new ToolIndex();
const toolsetManager = new ToolsetManager(connectionManager, toolIndex);

// ── Register management tools ──────────────────────────────────────

// 1. connection_info
server.tool(
  'connection_info',
  'Show status of all 4 layers (TCP:55557, TCP:55558, HTTP:30010, Offline). Reports detected project, available layers, and enabled toolsets.',
  { force_reconnect: z.boolean().optional().default(false).describe('Re-probe all layers instead of using cached status') },
  async ({ force_reconnect }, ctx) => {
    if (force_reconnect) {
      log('info', 'Force-reconnecting all layers...');
      await Promise.all([
        connectionManager.isLayerAvailable('offline', true),
        connectionManager.isLayerAvailable('tcp-55557', true),
        connectionManager.isLayerAvailable('tcp-55558', true),
        connectionManager.isLayerAvailable('http-30010', true),
      ]);
    }

    const layers = connectionManager.getStatus();
    const enabled = toolsetManager.getEnabledNames();

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          project: config.projectName || connectionManager.detectedProject || '(not detected)',
          projectRoot: connectionManager.resolvedProjectRoot || '(not set)',
          ...(connectionManager.projectRootWarning
            ? { projectRootConfigured: config.projectRoot, projectRootWarning: connectionManager.projectRootWarning }
            : {}),
          layers,
          enabledToolsets: enabled,
          toolCount: toolIndex.size,
        }, null, 2),
      }],
    };
  }
);

// 2. detect_project
server.tool(
  'detect_project',
  'Run auto-detection chain and report which project\'s editor is open, with confidence score.',
  {},
  async (_args, ctx) => {
    log('info', 'Running project auto-detection via PowerShell...');
    const result = await connectionManager.detectProject();

    if (result.project) {
      log('info', `Detected project: ${result.project} (confidence: ${result.confidence})`);
    } else {
      log('info', 'No running Unreal Editor detected');
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// 3. find_tools
server.tool(
  'find_tools',
  'Keyword search across all tools. Returns matching tool names, descriptions, and parent toolset. Auto-enables parent toolsets of matches.',
  {
    query: z.string().describe('Search query — tool names, descriptions, or abbreviations (e.g., "gas", "blueprint", "spawn actor")'),
    max_results: z.number().int().optional().default(15).describe('Maximum results to return'),
  },
  async ({ query, max_results }, ctx) => {
    log('info', `Searching tools for: "${query}"`);

    const results = toolIndex.search(query, max_results);

    if (results.length === 0) {
      return {
        content: [{
          type: 'text',
          text: `No tools found matching "${query}". Try broader terms or call list_toolsets to see available categories.`,
        }],
      };
    }

    // Auto-enable toolsets that contain matching tools.
    // Cap at top 3 toolsets per query (ranked by their best tool's score)
    // to avoid enabling too many at once. Spec: dynamic-toolsets.md.
    const toolsetBestScore = {};
    for (const r of results) {
      if (r.toolsetName === 'management') continue;
      if (!toolsetBestScore[r.toolsetName] || r.score > toolsetBestScore[r.toolsetName]) {
        toolsetBestScore[r.toolsetName] = r.score;
      }
    }
    const toolsetNames = Object.entries(toolsetBestScore)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name]) => name);

    const previouslyEnabled = new Set(toolsetManager.getEnabledNames());
    if (toolsetNames.length > 0) {
      await toolsetManager.autoEnable(toolsetNames);
      log('info', `Auto-enabled toolsets: ${toolsetNames.join(', ')}`);
    }

    // Collect tips for newly enabled toolsets (not already enabled before this call)
    const newlyEnabled = toolsetNames.filter(n => !previouslyEnabled.has(n));
    const allEnabled = new Set(toolsetManager.getEnabledNames());
    const tips = collectTips(newlyEnabled, allEnabled);

    const content = [{
      type: 'text',
      text: JSON.stringify({
        query,
        resultCount: results.length,
        results: results.map(r => ({
          tool: r.toolName,
          toolset: r.toolsetName,
          description: r.description,
          layer: r.layer,
          score: r.score,
        })),
        autoEnabled: toolsetNames,
      }, null, 2),
    }];
    if (tips.length > 0) {
      content.push({ type: 'text', text: `Tips:\n${tips.join('\n')}` });
    }

    return { content };
  }
);

// 4. list_toolsets
server.tool(
  'list_toolsets',
  'Show all toolsets with tool count, required layer, availability status, and enabled/disabled state. Orientation tool — call first to understand what\'s available.',
  {},
  async (_args, ctx) => {
    log('info', 'Listing all toolsets...');
    const toolsets = await toolsetManager.listToolsets();

    // Count active tools (6 management + enabled toolset tools)
    const activeToolCount = 6 + toolsets
      .filter(t => t.enabled)
      .reduce((sum, t) => sum + t.toolCount, 0);

    const summary = {
      total: toolsets.length,
      available: toolsets.filter(t => t.available).length,
      enabled: toolsets.filter(t => t.enabled).length,
      activeToolCount,
    };

    // Warn when active tools exceed the empirical accuracy threshold
    if (activeToolCount > 40) {
      summary.warning = `${activeToolCount} active tools exceeds the recommended 40-tool limit. Tool selection accuracy degrades beyond this threshold. Use disable_toolset to shed unneeded toolsets.`;
    }

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({ toolsets, summary }, null, 2),
      }],
    };
  }
);

// 5. enable_toolset
server.tool(
  'enable_toolset',
  'Explicitly enable one or more toolsets by name. Fires tools/list_changed notification.',
  {
    toolsets: z.array(z.string()).describe('Toolset names to enable (e.g., ["gas", "blueprints-write"])'),
  },
  async ({ toolsets: names }, ctx) => {
    log('info', `Enabling toolsets: ${names.join(', ')}`);
    const result = await toolsetManager.enable(names);

    const allEnabled = new Set(toolsetManager.getEnabledNames());
    const tips = collectTips(result.enabled, allEnabled);

    const content = [{ type: 'text', text: JSON.stringify(result, null, 2) }];
    if (tips.length > 0) {
      content.push({ type: 'text', text: `Tips:\n${tips.join('\n')}` });
    }

    return { content };
  }
);

// 6. disable_toolset
server.tool(
  'disable_toolset',
  'Disable one or more toolsets to free context. Use when switching tasks or active tool count is high.',
  {
    toolsets: z.array(z.string()).describe('Toolset names to disable'),
  },
  async ({ toolsets: names }, ctx) => {
    log('info', `Disabling toolsets: ${names.join(', ')}`);
    const result = toolsetManager.disable(names);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// ── Register dynamic toolset tools ─────────────────────────────────
// These tools are registered on the MCP server but only appear in
// tools/list when their parent toolset is enabled.
//
// The ToolsetManager tracks enabled state; when tools/list is called,
// we filter to only return tools from enabled toolsets.
//
// For Phase 1, we register all offline tools. TCP tools are registered
// in Phase 2/3 when those layers are implemented.

// Register offline tools — descriptions and params sourced from tools.yaml (D44).
// Previously this was a duplicated const that drifted from yaml over time.
const offlineToolDefs = TOOLS_YAML.toolsets.offline.tools;

for (const [name, def] of Object.entries(offlineToolDefs)) {
  const schema = buildZodSchema(def.params);

  const handle = server.tool(
    name,
    def.description,
    schema,
    async (args, ctx) => {
      try {
        log('info', `Executing offline tool: ${name}`);
        const result = await executeOfflineTool(name, args, connectionManager.resolvedProjectRoot);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Error in ${name}: ${err.message}`,
          }],
          isError: true,
        };
      }
    }
  );

  // Register the SDK handle so ToolsetManager can toggle visibility.
  // Tools start disabled; ToolsetManager.load() enables the offline
  // toolset if its layer is available.
  handle.disable();
  toolsetManager.registerToolHandle(name, handle);
}

// ── Register actors tools (TCP:55558) ─────────────────────────────
// M3 (D23 oracle retirement): actors toolset — 10 tools that talk to the
// UEMCP custom plugin on TCP:55558. Handlers live in server/actors-tcp-tools.mjs.
// Same pattern as offline tools: capture handle, start disabled, register with ToolsetManager.

const actorsToolDefs = getActorsToolDefs();

for (const [name, def] of Object.entries(actorsToolDefs)) {
  const schema = {};
  for (const [paramName, zodField] of Object.entries(def.schema)) {
    schema[paramName] = zodField;
  }

  const handle = server.tool(
    name,
    def.description,
    schema,
    async (args, ctx) => {
      try {
        log('info', `Executing actors tool: ${name}`);
        const result = await executeActorsTool(name, args, connectionManager);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Error in ${name}: ${err.message}`,
          }],
          isError: true,
        };
      }
    }
  );

  handle.disable();
  toolsetManager.registerToolHandle(name, handle);
}

// ── Register blueprints-write tools (TCP:55558) ─────────────────────
// M3 (D23 oracle retirement): blueprints-write toolset — 15 tools for BP
// creation, components, and graph nodes. Handlers live in
// server/blueprints-write-tcp-tools.mjs and dispatch to the UEMCP custom
// plugin on TCP:55558 (replaced the conformance-oracle path post-M3).

const bpWriteToolDefs = getBlueprintsWriteToolDefs();

for (const [name, def] of Object.entries(bpWriteToolDefs)) {
  const schema = {};
  for (const [paramName, zodField] of Object.entries(def.schema)) {
    schema[paramName] = zodField;
  }

  const handle = server.tool(
    name,
    def.description,
    schema,
    async (args, ctx) => {
      try {
        log('info', `Executing blueprints-write tool: ${name}`);
        const result = await executeBlueprintsWriteTool(name, args, connectionManager);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Error in ${name}: ${err.message}`,
          }],
          isError: true,
        };
      }
    }
  );

  handle.disable();
  toolsetManager.registerToolHandle(name, handle);
}

// ── Register widgets tools (TCP:55558) ──────────────────────────────
// M3 (D23 oracle retirement): widgets toolset — 7 tools for UMG widget
// creation and binding. Handlers live in server/widgets-tcp-tools.mjs and
// dispatch to the UEMCP custom plugin on TCP:55558. The 2 previously-broken
// handlers (set_text_block_binding, add_widget_to_viewport) ship CORRECTED
// behavior here — see plugin/.../WidgetHandlers.cpp for bug-fix details.

const widgetsToolDefs = getWidgetsToolDefs();

for (const [name, def] of Object.entries(widgetsToolDefs)) {
  const schema = {};
  for (const [paramName, zodField] of Object.entries(def.schema)) {
    schema[paramName] = zodField;
  }

  const handle = server.tool(
    name,
    def.description,
    schema,
    async (args, ctx) => {
      try {
        log('info', `Executing widgets tool: ${name}`);
        const result = await executeWidgetsTool(name, args, connectionManager);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Error in ${name}: ${err.message}`,
          }],
          isError: true,
        };
      }
    }
  );

  handle.disable();
  toolsetManager.registerToolHandle(name, handle);
}

// ── Register RC tools (HTTP:30010) ────────────────────────────────
// M-enhance CP2 (D66 HYBRID): 11 FULL-RC tools — 8 rc_* primitives from the
// remote-control toolset, plus 3 RC-internal-substrate semantic delegates
// (list_material_parameters, get_curve_asset, get_mesh_info) whose agent-facing
// toolsets are materials/data-assets/geometry. All dispatch via sendHttp.

const rcToolDefs = getRcToolDefs();

for (const [name, def] of Object.entries(rcToolDefs)) {
  const schema = {};
  for (const [paramName, zodField] of Object.entries(def.schema)) {
    schema[paramName] = zodField;
  }

  const handle = server.tool(
    name,
    def.description,
    schema,
    async (args, ctx) => {
      try {
        log('info', `Executing rc tool: ${name}`);
        const result = await executeRcTool(name, args, connectionManager);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Error in ${name}: ${err.message}`,
          }],
          isError: true,
        };
      }
    }
  );

  handle.disable();
  toolsetManager.registerToolHandle(name, handle);
}

// ── Register M-enhance TCP tools (TCP:55558) ──────────────────────
// M-enhance CP4 (D66 HYBRID): 10 FULL-TCP tools backed by CP3 plugin handlers.
// bp_compile_and_report, get_blueprint_event_dispatchers, get_widget_blueprint,
// get_material_graph, get_editor_state, start_pie/stop_pie/is_pie_running,
// execute_console_command, get_asset_references. Wire-type mapping via
// tools.yaml `wire_type:` field (e.g. get_blueprint_event_dispatchers →
// get_event_dispatchers to match CP3's plugin registration).

const menhanceToolDefs = getMenhanceToolDefs();

for (const [name, def] of Object.entries(menhanceToolDefs)) {
  const schema = {};
  for (const [paramName, zodField] of Object.entries(def.schema)) {
    schema[paramName] = zodField;
  }

  const handle = server.tool(
    name,
    def.description,
    schema,
    async (args, ctx) => {
      try {
        log('info', `Executing m-enhance tool: ${name}`);
        const result = await executeMenhanceTool(name, args, connectionManager);
        return {
          content: [{
            type: 'text',
            text: JSON.stringify(result, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: 'text',
            text: `Error in ${name}: ${err.message}`,
          }],
          isError: true,
        };
      }
    }
  );

  handle.disable();
  toolsetManager.registerToolHandle(name, handle);
}

// ── Register M5-PREP scaffold tools (TCP:55558) ────────────────────
// M5-PREP (D101): 5 stub toolsets reserving registration insertion points so
// the 3 M5 sub-workers can each fill in their own m5-*-tools.mjs without
// touching server.mjs. Each loop iterates the (currently empty) SCHEMAS
// object — zero MCP tools register until sub-workers populate them. When a
// sub-worker adds entries, this loop registers them at next startup with
// the same handle.disable() + toolsetManager.registerToolHandle convention
// the other TCP toolsets use.

const m5ToolsetGroups = [
  { name: 'animation',      defs: getM5AnimationToolDefs(),      execute: executeM5AnimationTool      },
  { name: 'materials',      defs: getM5MaterialsToolDefs(),      execute: executeM5MaterialsTool      },
  { name: 'input-and-pie',  defs: getM5InputPieToolDefs(),       execute: executeM5InputPieTool       },
  { name: 'geometry',       defs: getM5GeometryToolDefs(),       execute: executeM5GeometryTool       },
  { name: 'editor-utility', defs: getM5EditorUtilityToolDefs(),  execute: executeM5EditorUtilityTool  },
];

for (const group of m5ToolsetGroups) {
  for (const [name, def] of Object.entries(group.defs)) {
    const schema = {};
    for (const [paramName, zodField] of Object.entries(def.schema)) {
      schema[paramName] = zodField;
    }

    const handle = server.tool(
      name,
      def.description,
      schema,
      async (args, ctx) => {
        try {
          log('info', `Executing m5 ${group.name} tool: ${name}`);
          const result = await group.execute(name, args, connectionManager);
          return {
            content: [{
              type: 'text',
              text: JSON.stringify(result, null, 2),
            }],
          };
        } catch (err) {
          return {
            content: [{
              type: 'text',
              text: `Error in ${name}: ${err.message}`,
            }],
            isError: true,
          };
        }
      }
    );

    handle.disable();
    toolsetManager.registerToolHandle(name, handle);
  }
}

// ── Wire tools/list_changed notification ───────────────────────────

// NOTE: tools/list_changed notifications are now handled automatically by the
// MCP SDK when handle.enable()/handle.disable() are called. We keep the
// onListChanged hook available for future phases where toolsets may not yet
// have registered SDK handles (e.g., TCP tools before Phase 2 implementation).
toolsetManager.onListChanged(() => {
  try {
    server.server.sendNotification({
      method: 'notifications/tools/list_changed',
    });
  } catch {
    // Swallow — client may not support notifications
  }
});

// ── Startup ────────────────────────────────────────────────────────

async function main() {
  // Load tools.yaml and build the search index
  await toolsetManager.load();
  // Initialize TCP wire_type maps from parsed YAML
  initActorsTools(toolsetManager.getToolsData());
  initBlueprintsWriteTools(toolsetManager.getToolsData());
  initWidgetsTools(toolsetManager.getToolsData());
  initMenhanceTools(toolsetManager.getToolsData());
  // M5-PREP scaffold (D101) — wire_type maps for the 5 stub toolsets.
  // No-op until sub-workers add `wire_type:` fields to tools.yaml entries.
  initM5AnimationTools(toolsetManager.getToolsData());
  initM5MaterialsTools(toolsetManager.getToolsData());
  initM5InputPieTools(toolsetManager.getToolsData());
  initM5GeometryTools(toolsetManager.getToolsData());
  initM5EditorUtilityTools(toolsetManager.getToolsData());

  // Check offline layer availability
  await connectionManager.checkOfflineAvailable();

  // Auto-detect project if configured
  if (config.autoDetect) {
    // Non-blocking — don't fail startup if detection fails
    connectionManager.detectProject().catch(() => {});
  }

  // Connect to stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // NOTE: Do NOT use console.log after this point — stdout is the
  // MCP protocol stream. Use log() helper or write to stderr.
  process.stderr.write(`[uemcp] Server started for project: ${config.projectName || '(auto-detect)'}\n`);
  process.stderr.write(`[uemcp] Tools indexed: ${toolIndex.size}\n`);
}

main().catch(err => {
  process.stderr.write(`[uemcp] Fatal: ${err.message}\n${err.stack}\n`);
  process.exit(1);
});
