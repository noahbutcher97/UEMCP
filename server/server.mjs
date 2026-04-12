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
  'This server provides Unreal Engine tools organized into dynamic toolsets.',
  'Only 6 management tools are visible by default — use find_tools with a keyword query to discover capabilities and auto-enable relevant toolsets.',
  'Use list_toolsets for a full overview of available toolsets, their required layers, and enabled state.',
  'When switching tasks, call disable_toolset to free context by hiding toolsets you no longer need.',
  'Some toolsets require the Unreal Editor to be running (TCP layers); others work offline against project files.',
  'Call connection_info to check which layers are connected and detect_project to identify the active project.',
].join(' ');

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

    // Auto-enable toolsets that contain matching tools
    const toolsetNames = [...new Set(results.map(r => r.toolsetName).filter(n => n !== 'management'))];
    if (toolsetNames.length > 0) {
      const enableResult = await toolsetManager.autoEnable(toolsetNames);
      log('info', `Auto-enabled toolsets: ${toolsetNames.join(', ')}`);
    }

    return {
      content: [{
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
      }],
    };
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

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          toolsets,
          summary: {
            total: toolsets.length,
            available: toolsets.filter(t => t.available).length,
            enabled: toolsets.filter(t => t.enabled).length,
          },
        }, null, 2),
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

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
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

  server.tool(
    name,
    def.description,
    schema,
    async (args, ctx) => {
      // Check if offline toolset is enabled
      if (!toolsetManager.getEnabledNames().includes('offline')) {
        return {
          content: [{
            type: 'text',
            text: 'The "offline" toolset is not enabled. Call enable_toolset({"toolsets": ["offline"]}) or find_tools to enable it.',
          }],
          isError: true,
        };
      }

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
}

// ── Wire tools/list_changed notification ───────────────────────────

toolsetManager.onListChanged(() => {
  // The MCP SDK's McpServer handles tools/list_changed via its internal
  // Server instance when tools are registered dynamically. Since we
  // register all tools upfront but filter in tools/list, we need to
  // trigger the notification through the low-level server.
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
