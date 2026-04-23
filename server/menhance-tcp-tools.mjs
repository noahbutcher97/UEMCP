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

  // ── PARTIAL-RC group (CP4 remainder, Session 3) ─────────────────
  // Hybrid dispatch per FA-ε §Q6: agent-facing signature is TCP-external
  // while internal substrate is plugin-reflection for full flag fidelity
  // (RC's SanitizeMetadata allowlist can't cover Category/Replicated/etc.).
  // RC augmentation is a future optimization — Session 3 ships plugin-primary.

  get_blueprint_info: {
    description: 'Parent class, interfaces, component list, variable count, function count. Overview without loading full graph.',
    schema: {
      asset_path: z.string().describe('/Game/... BP path (BP_C class path or Blueprint asset path)'),
    },
    isReadOp: true,
    // Internal: dispatches to reflection_walk then extracts summary fields client-side.
    partialRc: { tcpWireType: 'reflection_walk', transform: 'blueprint_info' },
  },

  get_blueprint_variables: {
    description: 'All variables with types, default values, categories, replication flags, tooltips (full flag set — RC allowlist bypassed)',
    schema: {
      asset_path: z.string().describe('/Game/... BP path'),
    },
    isReadOp: true,
    partialRc: { tcpWireType: 'reflection_walk', transform: 'blueprint_variables' },
  },

  get_blueprint_functions: {
    description: 'All functions with full signatures — params, return, static/const/pure/net flags',
    schema: {
      asset_path: z.string().describe('/Game/... BP path'),
    },
    isReadOp: true,
    partialRc: { tcpWireType: 'reflection_walk', transform: 'blueprint_functions' },
  },

  get_blueprint_components: {
    description: 'Component hierarchy — class references declared as UActorComponent-subclassed UPROPERTIES',
    schema: {
      asset_path: z.string().describe('/Game/... BP path'),
    },
    isReadOp: true,
    partialRc: { tcpWireType: 'reflection_walk', transform: 'blueprint_components' },
  },

  get_niagara_system_info: {
    description: 'UNiagaraSystem metadata — emitter names, user-exposed parameters, fixed bounds (reflection)',
    schema: {
      asset_path: z.string().describe('/Game/... UNiagaraSystem path'),
    },
    isReadOp: true,
    partialRc: { tcpWireType: 'reflection_walk', transform: 'identity' },
  },

  get_montage_full: {
    description: 'Deep montage read — sections, notifies, slots, blend settings (reflection schema; values via read_asset_properties)',
    schema: {
      asset_path: z.string().describe('/Game/... UAnimMontage path'),
    },
    isReadOp: true,
    partialRc: { tcpWireType: 'reflection_walk', transform: 'identity' },
  },

  get_anim_sequence_info: {
    description: 'AnimSequence metadata — skeleton, notify tracks, curves, sync markers (reflection schema)',
    schema: {
      asset_path: z.string().describe('/Game/... UAnimSequence path'),
    },
    isReadOp: true,
    partialRc: { tcpWireType: 'reflection_walk', transform: 'identity' },
  },

  get_blend_space: {
    description: 'Blend axes, sample points, interpolation mode (reflection schema) — covers BlendSpace and BlendSpace1D',
    schema: {
      asset_path: z.string().describe('/Game/... UBlendSpace or UBlendSpace1D path'),
    },
    isReadOp: true,
    partialRc: { tcpWireType: 'reflection_walk', transform: 'identity' },
  },

  get_anim_curve_data: {
    description: 'Float/vector/transform curve UPROPERTY schema from any animation asset',
    schema: {
      asset_path: z.string().describe('/Game/... animation asset path'),
    },
    isReadOp: true,
    partialRc: { tcpWireType: 'reflection_walk', transform: 'identity' },
  },

  get_struct_definition: {
    description: 'Read UUserDefinedStruct / UScriptStruct members with full metadata and flag surface',
    schema: {
      asset_path: z.string().describe('/Game/... UUserDefinedStruct path or native /Script/... struct path'),
    },
    isReadOp: true,
    partialRc: { tcpWireType: 'get_struct_reflection', transform: 'identity' },
  },

  get_datatable_contents: {
    description: 'Read all rows from a UDataTable — CSV + row names + row struct reflection',
    schema: {
      asset_path: z.string().describe('/Game/... UDataTable path'),
    },
    isReadOp: true,
    partialRc: { tcpWireType: 'get_datatable_contents', transform: 'identity' },
  },

  get_string_table: {
    description: 'Read UStringTable key/source pairs with namespace',
    schema: {
      asset_path: z.string().describe('/Game/... UStringTable path'),
    },
    isReadOp: true,
    partialRc: { tcpWireType: 'get_string_table_contents', transform: 'identity' },
  },

  list_data_asset_types: {
    description: 'Enumerate UDataAsset subclasses loaded in memory — surface for create_data_asset subclass param',
    schema: {},
    isReadOp: true,
    partialRc: { tcpWireType: 'list_data_asset_types', transform: 'identity' },
  },
};

// ── PARTIAL-RC response transforms ────────────────────────────
//
// Plugin reflection_walk returns full class reflection; caller-facing tools
// want semantically-filtered subsets. Transforms run client-side on the raw
// plugin response before returning to the caller — no extra wire round-trip.

/**
 * `blueprint_info` transform — summary fields from a UClass reflection walk.
 * Callers wanting full variables list use get_blueprint_variables instead.
 */
function transformBlueprintInfo(raw) {
  const inner = raw?.result || raw;
  return {
    name:        inner?.name,
    path:        inner?.path,
    super_class: inner?.super_class,
    interfaces:  inner?.interfaces || [],
    class_flags: inner?.class_flags || [],
    property_count: (inner?.properties || []).length,
    function_count: (inner?.functions || []).length,
  };
}

/** `blueprint_variables` transform — extract properties[]. */
function transformBlueprintVariables(raw) {
  const inner = raw?.result || raw;
  return {
    asset_path: inner?.path,
    variables:  inner?.properties || [],
    count:      (inner?.properties || []).length,
  };
}

/** `blueprint_functions` transform — extract functions[]. */
function transformBlueprintFunctions(raw) {
  const inner = raw?.result || raw;
  return {
    asset_path: inner?.path,
    functions:  inner?.functions || [],
    count:      (inner?.functions || []).length,
  };
}

/**
 * `blueprint_components` transform — filter properties for types that look
 * like ActorComponent subclasses. We match by property_class suffix (since
 * the walker emits /Script/Engine.ActorComponent-style paths) plus the
 * "Component" name-suffix heuristic for BP-declared component variables.
 */
function transformBlueprintComponents(raw) {
  const inner = raw?.result || raw;
  const all = inner?.properties || [];
  const components = all.filter(p => {
    // Object/SoftObject properties pointing at component classes
    const cls = (p?.property_class || '').toLowerCase();
    if (cls.includes('component')) return true;
    // SCS-generated names usually end in _GEN_VARIABLE for Blueprint-declared components.
    // Use a conservative name-suffix heuristic as fallback.
    if (typeof p?.name === 'string' && p.name.endsWith('_GEN_VARIABLE')) return true;
    return false;
  });
  return {
    asset_path: inner?.path,
    components,
    count:      components.length,
  };
}

const TRANSFORMS = {
  identity:               (raw) => raw?.result || raw,
  blueprint_info:         transformBlueprintInfo,
  blueprint_variables:    transformBlueprintVariables,
  blueprint_functions:    transformBlueprintFunctions,
  blueprint_components:   transformBlueprintComponents,
};

/**
 * Dispatch an M-enhance TCP tool call.
 *
 * For FULL-TCP tools (no `partialRc` field): dispatches to tools.yaml
 * wire_type on tcp-55558 directly.
 *
 * For PARTIAL-RC tools (has `partialRc` field): dispatches to the
 * `partialRc.tcpWireType` command then runs the named transform over
 * the plugin response to shape it for the agent-facing surface.
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

  // PARTIAL-RC path: internal substrate + client transform.
  if (def.partialRc) {
    const { tcpWireType, transform } = def.partialRc;
    const raw = await connectionManager.send(
      'tcp-55558', tcpWireType, validated, { skipCache: !def.isReadOp },
    );
    const transformFn = TRANSFORMS[transform] || TRANSFORMS.identity;
    return transformFn(raw);
  }

  // FULL-TCP path: wire_type translation + direct dispatch.
  const wireType = MENHANCE_WIRE_MAP[toolName] || toolName;
  return connectionManager.send('tcp-55558', wireType, validated, { skipCache: !def.isReadOp });
}

/** Export tool-def shape for server.mjs registration. */
export function getMenhanceToolDefs() {
  return MENHANCE_SCHEMAS;
}
