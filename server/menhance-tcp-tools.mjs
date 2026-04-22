// M-enhance TCP tool handlers — Session 2 CP4 (FULL-TCP subset).
//
// 10 tools shipped against CP3's plugin-C++ handlers on TCP:55558:
//   bp_compile_and_report          — blueprint-read
//   get_blueprint_event_dispatchers — blueprint-read (wire_type: get_event_dispatchers)
//   get_widget_blueprint           — blueprint-read
//   get_material_graph             — materials
//   get_editor_state               — editor-utility
//   start_pie / stop_pie           — input-and-pie
//   is_pie_running                 — input-and-pie
//   execute_console_command        — input-and-pie
//   get_asset_references           — asset-registry
//
// The 13 PARTIAL-RC tools (hybrid RC-primary with plugin-TCP fallback for
// fields outside RC's SanitizeMetadata allowlist) ship in Session 3 — they
// need a compound dispatch pattern that warrants its own file section.
//
// Convention matches tcp-tools.mjs: {description, schema, isReadOp} per tool,
// wire_type translation via tools.yaml, ConnectionManager.send dispatching.

import { z } from 'zod';

// ── Wire-type map (populated by initMenhanceTools from tools.yaml) ──
let MENHANCE_WIRE_MAP = {};

/**
 * Build wire-type map for this M-enhance subset.
 * Reads wire_type fields from the relevant toolsets (blueprint-read +
 * materials + editor-utility + input-and-pie + asset-registry). Only
 * non-identity mappings are stored — identity fallback via toolName.
 */
export function initMenhanceTools(toolsData) {
  MENHANCE_WIRE_MAP = {};
  const toolsets = toolsData?.toolsets || {};
  for (const toolsetName of ['blueprint-read', 'materials', 'editor-utility', 'input-and-pie', 'asset-registry']) {
    const toolset = toolsets[toolsetName];
    if (!toolset?.tools) continue;
    for (const [name, def] of Object.entries(toolset.tools)) {
      if (def.wire_type) {
        MENHANCE_WIRE_MAP[name] = def.wire_type;
      }
    }
  }
}

// ── Schemas (name → {description, schema, isReadOp}) ──────────────

export const MENHANCE_SCHEMAS = {
  bp_compile_and_report: {
    description: 'Compile a Blueprint and capture full FCompilerResultsLog — errors, warnings, notes, info with per-entry node_guid',
    schema: {
      asset_path: z.string().describe('/Game/... path to the Blueprint'),
    },
    // Compile mutates editor state (regenerates generated class) — skipCache.
    isReadOp: false,
  },

  get_blueprint_event_dispatchers: {
    description: 'All event dispatchers with parameter signatures + binding-site K2Nodes',
    schema: {
      asset_path: z.string().describe('/Game/... path to the Blueprint'),
    },
    isReadOp: true,
  },

  get_widget_blueprint: {
    description: 'Widget hierarchy tree (designer view), property bindings, standard EventGraph and functions',
    schema: {
      asset_path: z.string().describe('/Game/... path to the Widget Blueprint'),
    },
    isReadOp: true,
  },

  get_material_graph: {
    description: 'Full material expression node graph — nodes, pins, edges, parameters. UMaterial only (material instances share the parent graph).',
    schema: {
      asset_path: z.string().describe('/Game/... path to UMaterial'),
    },
    isReadOp: true,
  },

  get_editor_state: {
    description: 'Current level, selected actors, viewport camera transform, PIE status',
    schema: {},
    // Editor state snapshots shouldn't cache — viewport/selection change frequently.
    isReadOp: false,
  },

  start_pie: {
    description: 'Launch Play In Editor (viewport, standalone, new_window)',
    schema: {
      mode: z.string().optional().describe('viewport | standalone | new_window (default viewport)'),
    },
    isReadOp: false,
  },

  stop_pie: {
    description: 'End current PIE session',
    schema: {},
    isReadOp: false,
  },

  is_pie_running: {
    description: 'Check whether a PIE session is currently active',
    schema: {},
    // State query, but volatile — skip cache.
    isReadOp: false,
  },

  execute_console_command: {
    description: 'Run a console command in PIE or editor context',
    schema: {
      command: z.string().describe('Full console command line'),
    },
    isReadOp: false,
  },

  get_asset_references: {
    description: 'Dependency graph — what this asset references (deps) and what references it (referencers)',
    schema: {
      asset_path: z.string().describe('/Game/... path — object path or package name'),
    },
    isReadOp: true,
  },
};

/**
 * Dispatch an M-enhance TCP tool call.
 *
 * @param {string} toolName                            tools.yaml name
 * @param {object} args                                raw args (validated here)
 * @param {import('./connection-manager.mjs').ConnectionManager} connectionManager
 * @returns {Promise<object>}
 */
export async function executeMenhanceTool(toolName, args, connectionManager) {
  const def = MENHANCE_SCHEMAS[toolName];
  if (!def) throw new Error(`menhance-tcp-tools: unknown tool "${toolName}"`);

  const validated = z.object(def.schema).parse(args);
  const wireType = MENHANCE_WIRE_MAP[toolName] || toolName;

  return connectionManager.send('tcp-55558', wireType, validated, { skipCache: !def.isReadOp });
}

/** Export tool-def shape for server.mjs registration. */
export function getMenhanceToolDefs() {
  return MENHANCE_SCHEMAS;
}
