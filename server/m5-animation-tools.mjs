// M5 animation toolset — montage mutations on TCP:55558.
//
// Ships 3 not-shipped tools per docs/handoffs/m5-animation-materials.md:
//   create_montage, add_montage_section, add_montage_notify
//
// Disposition for the 4th (get_audio_asset_info) per D101 (v):
// SUPERSEDED-as-offline. yaml line 746-747 explicitly marks it
// `displaced_by: read_asset_properties`; D50 tagged-fallback covers
// SoundCue/SoundWave CDO metadata via FPropertyTag iteration. AkAudioEvent
// (Wwise) requires the SDK — neither offline NOR live reflection_walk
// would extend coverage. yaml entry preserved for discovery, no live route.
//
// The 4 shipped reads (get_montage_full / get_anim_sequence_info /
// get_blend_space / get_anim_curve_data) live in menhance-tcp-tools.mjs
// under M-enhance D77 — do NOT duplicate them here.

import { z } from 'zod';

// ── Wire-type map (populated by initM5AnimationTools from tools.yaml) ──
let M5_ANIMATION_WIRE_MAP = {};

export function initM5AnimationTools(toolsData) {
  M5_ANIMATION_WIRE_MAP = {};
  const toolset = toolsData?.toolsets?.animation;
  if (!toolset?.tools) return;
  for (const [name, def] of Object.entries(toolset.tools)) {
    if (def.wire_type) {
      M5_ANIMATION_WIRE_MAP[name] = def.wire_type;
    }
  }
}

// ── Schemas ────────────────────────────────────────────────────
// Field names match the C++ handler param names (params pass straight
// through). Wire-type identity (no `wire_type:` in tools.yaml — toolName ==
// plugin Register key).
export const M5_ANIMATION_SCHEMAS = {

  create_montage: {
    description: 'Create UAnimMontage from a source AnimSequence. Inherits skeleton from the source; builds a single default slot + section spanning the full sequence length.',
    schema: {
      name:          z.string().describe('New montage asset name'),
      anim_sequence: z.string().describe('Source AnimSequence path (/Game/... or doubled object-path form)'),
      path:          z.string().optional().describe('Package path (default /Game/Animations)'),
    },
    isReadOp: false,
  },

  add_montage_section: {
    description: 'Append a named section to an existing UAnimMontage at a specified time. Refuses to overwrite an existing section by name (loud failure preferred over the legacy oracle\'s silent-overwrite).',
    schema: {
      asset_path:   z.string().describe('Montage asset path'),
      section_name: z.string().describe('Section name (must be unique within montage)'),
      time:         z.number().describe('Section start time (seconds)'),
    },
    isReadOp: false,
  },

  add_montage_notify: {
    description: 'Append a UAnimNotify or UAnimNotifyState to a montage at a specified time. Stateful (UAnimNotifyState) gets a default 0.1s duration; UAnimNotify is instantaneous. Resolves notify_class by full path, /Script/Engine prefix, or short-name search across loaded classes.',
    schema: {
      asset_path:    z.string().describe('Montage asset path'),
      notify_class:  z.string().describe('Notify class name — short name (e.g. "AnimNotify_PlaySound") or fully qualified path'),
      time:          z.number().describe('Notify trigger time (seconds)'),
    },
    isReadOp: false,
  },
};

/**
 * Execute an M5 animation tool against TCP:55558.
 *
 * @param {string} toolName — tools.yaml name (e.g., 'create_montage')
 * @param {object} args — raw args (validated here via Zod)
 * @param {import('./connection-manager.mjs').ConnectionManager} connectionManager
 * @returns {Promise<object>} — wire response (P0-1 envelope, normalized by ConnectionManager)
 */
export async function executeM5AnimationTool(toolName, args, connectionManager) {
  const def = M5_ANIMATION_SCHEMAS[toolName];
  if (!def) {
    return {
      status: 'error',
      code: 'not_implemented',
      error: `M5 tool '${toolName}' not yet shipped (stub from M5-PREP)`,
    };
  }

  // Defense-in-depth Zod validation — bypasses SDK parse for direct callers.
  const validated = z.object(def.schema).parse(args);

  // Wire-type translation (identity fallback when not in YAML).
  const typeString = M5_ANIMATION_WIRE_MAP[toolName] || toolName;

  return connectionManager.send('tcp-55558', typeString, validated, { skipCache: !def.isReadOp });
}

/** Export tool-def shape for server.mjs registration. */
export function getM5AnimationToolDefs() {
  return M5_ANIMATION_SCHEMAS;
}
