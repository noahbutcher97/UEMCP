// M5 input-and-pie toolset — Enhanced Input asset creation (3 not-yet-shipped tools).
//
// PIE control (start_pie / stop_pie / is_pie_running / execute_console_command)
// already lives in menhance-tcp-tools.mjs and EdgeCaseHandlers.cpp under
// M-enhance D77 — they are NOT registered here (would double-register their
// wire-types).
//
// Convention matches actors-tcp-tools.mjs / blueprints-write-tcp-tools.mjs:
// {description, schema, isReadOp} per tool, wire_type translation via
// tools.yaml (`input-and-pie:` toolset, currently identity for all 3),
// ConnectionManager.send dispatch on TCP:55558.

import { z } from 'zod';

// ── Wire-type map (populated by initM5InputPieTools from tools.yaml) ──
// All 3 Enhanced Input tools are identity-routed (no wire_type override in
// tools.yaml), so the map stays empty and the handler falls through to
// `toolName` as the wire type.

let M5_INPUT_PIE_WIRE_MAP = {};

export function initM5InputPieTools(toolsData) {
  M5_INPUT_PIE_WIRE_MAP = {};
  const toolset = toolsData?.toolsets?.['input-and-pie'];
  if (!toolset?.tools) return;
  for (const [name, def] of Object.entries(toolset.tools)) {
    if (def.wire_type) {
      M5_INPUT_PIE_WIRE_MAP[name] = def.wire_type;
    }
  }
}

// ── Schemas ────────────────────────────────────────────────────
//
// Field names must match the C++ handler params exactly (params pass through).
// value_type accepts the canonical Enhanced Input names plus convenience
// aliases — the plugin parses string-tolerantly (Bool/Boolean/Digital,
// Axis1D/Float, Axis2D/Vector2D, Axis3D/Vector). The Zod enum here keeps the
// surface predictable; the plugin's loose parser is a safety net for the live
// editor where typos are common.

const VALUE_TYPES = ['Bool', 'Boolean', 'Digital', 'Axis1D', 'Float', 'Axis2D', 'Vector2D', 'Axis3D', 'Vector'];

export const M5_INPUT_PIE_SCHEMAS = {

  create_input_action: {
    description: 'Create UInputAction asset with value type (Bool / Axis1D / Axis2D / Axis3D)',
    schema: {
      name:       z.string().min(1).describe('Asset name (e.g., "IA_Move")'),
      value_type: z.enum(VALUE_TYPES).describe('Value-type token; case-tolerant on wire'),
      path:       z.string().optional().describe('Package directory (default: /Game/Input/Actions)'),
    },
    isReadOp: false,
  },

  create_mapping_context: {
    description: 'Create UInputMappingContext asset (empty mappings; populate with add_mapping)',
    schema: {
      name: z.string().min(1).describe('Asset name (e.g., "IMC_Default")'),
      path: z.string().optional().describe('Package directory (default: /Game/Input)'),
    },
    isReadOp: false,
  },

  add_mapping: {
    description: 'Add key-to-action binding to an existing UInputMappingContext',
    schema: {
      context_path: z.string().min(1).describe('Full asset path of the UInputMappingContext'),
      action_path:  z.string().min(1).describe('Full asset path of the UInputAction'),
      key:          z.string().min(1).describe('FKey name (e.g., "W", "Gamepad_LeftThumbstick_X")'),
    },
    isReadOp: false,
  },
};

/**
 * Execute an input-and-pie M5 tool against TCP:55558.
 *
 * @param {string} toolName — tools.yaml name (e.g., 'create_input_action')
 * @param {object} args — raw args (validated here via Zod)
 * @param {import('./connection-manager.mjs').ConnectionManager} connectionManager
 * @returns {Promise<object>}
 */
export async function executeM5InputPieTool(toolName, args, connectionManager) {
  const def = M5_INPUT_PIE_SCHEMAS[toolName];
  if (!def) throw new Error(`m5-input-pie-tools: unknown tool "${toolName}"`);

  // P0-9 / P0-10 defense-in-depth — bad shapes never reach the wire.
  const validated = z.object(def.schema).parse(args);

  const typeString = M5_INPUT_PIE_WIRE_MAP[toolName] || toolName;
  return connectionManager.send('tcp-55558', typeString, validated, { skipCache: !def.isReadOp });
}

export function getM5InputPieToolDefs() {
  return M5_INPUT_PIE_SCHEMAS;
}
