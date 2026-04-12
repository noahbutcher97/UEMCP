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

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ConnectionManager } from './connection-manager.mjs';
import { ToolIndex } from './tool-index.mjs';
import { ToolsetManager } from './toolset-manager.mjs';
import { executeOfflineTool } from './offline-tools.mjs';
import {
  initTcpTools,
  getActorsToolDefs, executeActorsTool,
  getBlueprintsWriteToolDefs, executeBlueprintsWriteTool,
  getWidgetsToolDefs, executeWidgetsTool,
} from './tcp-tools.mjs';

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
  'Offline constraints: search_source → read_source_file (50 match cap, regex, .h/.cpp/.cs/.ini/.txt/.md only).',
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
  // Phase 2+ toolsets add entries here. Example shape:
  //
  // 'blueprint-read': {
  //   core: 'get_blueprint_info returns overview without loading full graph. ...',
  //   workflows: [
  //     { requires: ['offline'], tip: 'Use search_source to find C++ base classes behind Blueprint subclasses.' },
  //   ],
  // },
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
          projectRoot: config.projectRoot || '(not set)',
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

// Build Zod schemas from tools.yaml param definitions
function buildZodSchema(params) {
  if (!params || Object.keys(params).length === 0) {
    return {};
  }

  const schema = {};
  for (const [name, def] of Object.entries(params)) {
    let field;
    switch (def.type) {
      case 'string':
        field = z.string();
        break;
      case 'integer':
      case 'number':
        field = z.number();
        break;
      case 'boolean':
        field = z.boolean();
        break;
      case 'array':
        field = z.array(def.items === 'string' ? z.string() : z.any());
        break;
      case 'object':
        field = z.record(z.any());
        break;
      default:
        field = z.any();
    }

    if (def.describe || def.description) {
      field = field.describe(def.describe || def.description || '');
    }

    if (!def.required) {
      field = field.optional();
      if (def.default !== undefined) {
        field = field.default(def.default);
      }
    }

    schema[name] = field;
  }
  return schema;
}

// Register offline tools
const offlineToolDefs = {
  project_info: { description: 'Read .uproject, list plugins, engine version, build config', params: {} },
  list_gameplay_tags: { description: 'Parse DefaultGameplayTags.ini, return full tag hierarchy with comments', params: {} },
  search_gameplay_tags: {
    description: 'Search tags by pattern (e.g., "Gameplay.State.*")',
    params: { pattern: { type: 'string', required: true, description: 'Glob pattern to match tags (supports * and **)' } },
  },
  list_config_values: {
    description: 'Read any .ini config file, search for keys/sections',
    params: {
      config_file: { type: 'string', required: false, description: 'Config file name (e.g., DefaultEngine.ini). Omit to list available files.' },
      section: { type: 'string', required: false, description: 'Section name to filter' },
      key: { type: 'string', required: false, description: 'Key name to filter' },
    },
  },
  browse_content: {
    description: 'List content directories, filter by asset type (Blueprint, Material, etc.)',
    params: {
      path: { type: 'string', required: false, description: 'Subdirectory under Content/ (e.g., "GAS/Effects")' },
      type_filter: { type: 'string', required: false, description: 'Filter by type: blueprint, material, texture, map' },
    },
  },
  get_asset_info: {
    description: 'Read .uasset metadata (type, size, class, references)',
    params: { asset_path: { type: 'string', required: true, description: 'Asset path (/Game/... or relative to project)' } },
  },
  search_source: {
    description: 'Grep project Source/ directory for patterns',
    params: {
      pattern: { type: 'string', required: true, description: 'Regex pattern to search for' },
      file_filter: { type: 'string', required: false, description: 'Filter to files containing this string in name' },
    },
  },
  read_source_file: {
    description: 'Read a specific .h or .cpp file from Source/',
    params: { file_path: { type: 'string', required: true, description: 'Relative path from project root (e.g., Source/ProjectA/Public/GAS/Abilities/GA_OSAttack.h)' } },
  },
  list_plugins: { description: 'List installed plugins with enabled/disabled status and version', params: {} },
  get_build_config: { description: 'Parse .Build.cs, .Target.cs — show module dependencies and build settings', params: {} },
};

for (const [name, def] of Object.entries(offlineToolDefs)) {
  const schema = buildZodSchema(def.params);

  const handle = server.tool(
    name,
    def.description,
    schema,
    async (args, ctx) => {
      try {
        log('info', `Executing offline tool: ${name}`);
        const result = await executeOfflineTool(name, args, config.projectRoot);
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

// ── Register actors tools (TCP:55557) ─────────────────────────────
// Phase 2: actors toolset — 10 tools that talk to the existing UnrealMCP plugin.
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

// ── Register blueprints-write tools (TCP:55557) ─────────────────────
// Phase 2: blueprints-write toolset — 15 tools for BP creation, components, graph nodes.

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

// ── Register widgets tools (TCP:55557) ──────────────────────────────
// Phase 2: widgets toolset — 7 tools for UMG widget creation and binding.

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
  initTcpTools(toolsetManager.getToolsData());

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
