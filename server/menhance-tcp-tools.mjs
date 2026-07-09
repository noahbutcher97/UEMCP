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
// The original PARTIAL-RC family ships below. D183 promotes
// get_montage_full/get_anim_sequence_info and D187 promotes get_anim_graph
// to dedicated asset-instance TCP readers; remaining partialRc entries still
// dispatch through plugin helpers such as reflection_walk for fields outside
// RC's SanitizeMetadata allowlist.
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
  for (const toolsetName of ['blueprint-read', 'materials', 'editor-utility', 'input-and-pie', 'asset-registry', 'sidecar', 'visual-capture']) {
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
      // W-B (D142): enum-narrowed; pre-W-B mode was z.string().optional() so
      // typos silently fell through to viewport (Gauntlet Findings 4.3 + 4.7).
      // C++ HandleStartPie (EdgeCaseHandlers.cpp:122-134) recognises the same
      // 3 modes; W-G adds an explicit INVALID_PIE_MODE error path on the
      // C++ side as defense-in-depth.
      mode: z.enum(['viewport', 'standalone', 'new_window']).optional()
        .describe('viewport | standalone | new_window (default viewport)'),
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

  get_pie_session_state: {
    description: 'Report active PIE runtime worlds and context metadata for runtime observation',
    schema: {},
    // PIE session state is volatile — skip cache.
    isReadOp: false,
  },

  get_pie_actor_state: {
    description: 'Read actor transform, optional component transforms, and selected simple properties from a PIE runtime world',
    schema: {
      pie_instance: z.number().int().optional().describe('Optional PIE instance id; required when multiple PIE worlds are active unless world_path selects one'),
      world_path: z.string().optional().describe('Optional PIE world path/name selector'),
      actor_ref: z.object({
        name: z.string().optional(),
        label: z.string().optional(),
        object_path: z.string().optional(),
        editor_object_path: z.string().optional(),
        level_name: z.string().optional(),
      }).refine((ref) => Boolean(ref.name || ref.label || ref.object_path || ref.editor_object_path), {
        message: 'actor_ref requires one of name, label, object_path, or editor_object_path',
      }),
      include_components: z.boolean().optional(),
      component_filter: z.array(z.string()).optional(),
      properties: z.array(z.string()).optional(),
    },
    // Runtime actor state is volatile — skip cache.
    isReadOp: false,
  },

  sample_pie_actor_state: {
    description: 'Sample PIE actor state over a short duration using repeated runtime actor reads without blocking the editor game thread',
    schema: {
      pie_instance: z.number().int().optional().describe('Optional PIE instance id; required when multiple PIE worlds are active unless world_path selects one'),
      world_path: z.string().optional().describe('Optional PIE world path/name selector'),
      actor_ref: z.object({
        name: z.string().optional(),
        label: z.string().optional(),
        object_path: z.string().optional(),
        editor_object_path: z.string().optional(),
        level_name: z.string().optional(),
      }).refine((ref) => Boolean(ref.name || ref.label || ref.object_path || ref.editor_object_path), {
        message: 'actor_ref requires one of name, label, object_path, or editor_object_path',
      }),
      include_components: z.boolean().optional(),
      component_filter: z.array(z.string()).optional(),
      properties: z.array(z.string()).optional(),
      duration_ms: z.number().int().min(0).max(30000).optional()
        .describe('Sampling duration in milliseconds; 0 takes one immediate sample (default 500)'),
      interval_ms: z.number().int().min(1).max(5000).optional()
        .describe('Delay between samples in milliseconds (default 100)'),
      max_samples: z.number().int().min(1).max(100).optional()
        .describe('Upper bound on collected samples (default 25)'),
    },
    // Runtime actor state is volatile — skip cache.
    isReadOp: false,
  },

  wait_for_pie_actor_stable: {
    description: 'Wait until repeated uncached PIE actor runtime reads show a stable transform without blocking the editor game thread',
    schema: {
      pie_instance: z.number().int().optional().describe('Optional PIE instance id; required when multiple PIE worlds are active unless world_path selects one'),
      world_path: z.string().optional().describe('Optional PIE world path/name selector'),
      actor_ref: z.object({
        name: z.string().optional(),
        label: z.string().optional(),
        object_path: z.string().optional(),
        editor_object_path: z.string().optional(),
        level_name: z.string().optional(),
      }).refine((ref) => Boolean(ref.name || ref.label || ref.object_path || ref.editor_object_path), {
        message: 'actor_ref requires one of name, label, object_path, or editor_object_path',
      }),
      include_components: z.boolean().optional(),
      component_filter: z.array(z.string()).optional(),
      properties: z.array(z.string()).optional(),
      interval_ms: z.number().int().min(1).max(5000).optional()
        .describe('Delay between samples in milliseconds (default 100)'),
      stable_samples: z.number().int().min(1).max(100).optional()
        .describe('Consecutive transform samples required within tolerance (default 2)'),
      tolerance: z.number().min(0).max(100000).optional()
        .describe('Maximum absolute component delta for location, rotation, and scale (default 0.01)'),
      timeout_ms: z.number().int().min(1).max(120000).optional()
        .describe('Maximum wait in milliseconds before PIE_ACTOR_NOT_STABLE (default 5000)'),
    },
    // Runtime actor state is volatile — skip cache.
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
    description: 'Deep montage read — sections, notifies, slots, blend settings from the UAnimMontage asset instance',
    schema: {
      asset_path: z.string().describe('/Game/... UAnimMontage path'),
    },
    isReadOp: true,
  },

  get_anim_sequence_info: {
    description: 'AnimSequence metadata — skeleton, duration, frame count/rate, notifies, curves, sync markers from the UAnimSequence asset instance',
    schema: {
      asset_path: z.string().describe('/Game/... UAnimSequence path'),
    },
    isReadOp: true,
  },

  get_anim_graph: {
    description: 'AnimBlueprint static graph read — graphs, state machines, states, transitions, slot nodes, and layered bone blend nodes from the UAnimBlueprint editor asset',
    schema: {
      asset_path: z.string().describe('/Game/... UAnimBlueprint path'),
      include_transitions: z.boolean().optional().describe('Include transition metadata and rule/custom graph names; default true in the plugin'),
      include_node_properties: z.boolean().optional().describe('Include per-graph node summaries; default false'),
    },
    isReadOp: true,
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

  // ── CP5: narrow-sidecar regen ────────────────────────────────
  regenerate_sidecar: {
    description: 'Force-write a narrow sidecar for a Blueprint — backfill for assets not touched by the save-hook',
    schema: {
      asset_path: z.string().describe('/Game/... path to the Blueprint asset'),
    },
    // Writes to disk — mutation, skip cache.
    isReadOp: false,
  },

  // ── S4: visual capture via thumbnail pipeline ────────────────
  get_asset_preview_render: {
    description: 'Render an asset thumbnail as JPEG (inline base64 + optional disk write). Uses UThumbnailManager\'s registered renderer — supports any asset class with one.',
    schema: {
      asset_path:    z.string().describe('/Game/... path to any asset'),
      width:         z.number().int().optional().describe('Output width in pixels (default 256)'),
      height:        z.number().int().optional().describe('Output height in pixels (default 256)'),
      return_base64: z.boolean().optional().describe('Inline base64 JPEG in response (default true)'),
      output_path:   z.string().optional().describe('Optional disk output — absolute path or relative to Saved/'),
    },
    // Reading-style — safe to cache per (asset + dimensions).
    isReadOp: true,
  },

  get_viewport_screenshot: {
    description: 'Capture the active editor viewport as inline PNG, defaulting to bounded 768x432 output.',
    schema: {
      width: z.number().int().min(1).max(1920).optional()
        .describe('Output PNG width in pixels (default 768)'),
      height: z.number().int().min(1).max(1080).optional()
        .describe('Output PNG height in pixels (default 432)'),
      return_base64: z.boolean().optional()
        .describe('Inline base64 PNG in response (default true)'),
      output_path: z.string().optional()
        .describe('Optional disk output; absolute path or relative to Saved/ (.png appended if missing)'),
    },
    isReadOp: false,
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

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function unwrapSampleTransform(response) {
  const body = response?.result || response || {};
  return body.transform || body;
}

function vectorDelta(first, last, key) {
  const a = unwrapSampleTransform(first)?.[key];
  const b = unwrapSampleTransform(last)?.[key];
  if (!Array.isArray(a) || !Array.isArray(b) || a.length < 3 || b.length < 3) return null;
  return [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
}

function transformDelta(first, last) {
  const deltas = {
    location: vectorDelta(first, last, 'location'),
    rotation: vectorDelta(first, last, 'rotation'),
    scale: vectorDelta(first, last, 'scale'),
  };
  const max_abs = {};
  let complete = true;

  for (const [key, delta] of Object.entries(deltas)) {
    if (!Array.isArray(delta)) {
      max_abs[key] = null;
      complete = false;
      continue;
    }
    max_abs[key] = Math.max(...delta.map((v) => Math.abs(v)));
  }

  return { ...deltas, max_abs, complete };
}

function isStableDelta(delta, tolerance) {
  return delta.complete
    && delta.max_abs.location <= tolerance
    && delta.max_abs.rotation <= tolerance
    && delta.max_abs.scale <= tolerance;
}

async function samplePIEActorState(validated, connectionManager) {
  const {
    duration_ms = 500,
    interval_ms = 100,
    max_samples = 25,
    ...actorStateParams
  } = validated;
  const plannedCount = duration_ms === 0
    ? 1
    : Math.floor(duration_ms / interval_ms) + 1;
  const sampleTarget = Math.max(1, Math.min(max_samples, plannedCount));
  const started = Date.now();
  const samples = [];

  for (let i = 0; i < sampleTarget; i++) {
    if (i > 0) {
      const targetTime = started + (i * interval_ms);
      await delay(Math.max(0, targetTime - Date.now()));
    }
    const response = await connectionManager.send(
      'tcp-55558',
      'get_pie_actor_state',
      actorStateParams,
      { skipCache: true },
    );
    samples.push({
      index: i,
      t_ms: i === 0 ? 0 : Date.now() - started,
      response,
    });
  }

  const first = samples[0]?.response || null;
  const last = samples[samples.length - 1]?.response || null;
  return {
    sample_count: samples.length,
    requested_duration_ms: duration_ms,
    requested_interval_ms: interval_ms,
    elapsed_ms: Date.now() - started,
    capped: sampleTarget < plannedCount,
    samples,
    first,
    last,
    delta: {
      location: vectorDelta(first, last, 'location'),
      rotation: vectorDelta(first, last, 'rotation'),
      scale: vectorDelta(first, last, 'scale'),
    },
  };
}

async function waitForPIEActorStable(validated, connectionManager) {
  const {
    interval_ms = 100,
    stable_samples = 2,
    tolerance = 0.01,
    timeout_ms = 5000,
    ...actorStateParams
  } = validated;
  const started = Date.now();
  const deadline = started + timeout_ms;
  let previous = null;
  let last = null;
  let lastDelta = null;
  let stableRun = 0;
  let sampleCount = 0;

  const throwNotStable = () => {
    const detail = {
      sample_count: sampleCount,
      elapsed_ms: Date.now() - started,
      requested_interval_ms: interval_ms,
      requested_stable_samples: stable_samples,
      tolerance,
      timeout_ms,
      last,
      last_delta: lastDelta,
    };
    const error = new Error(`PIE_ACTOR_NOT_STABLE: actor transform did not stabilize within ${timeout_ms}ms`);
    error.code = 'PIE_ACTOR_NOT_STABLE';
    error.detail = detail;
    error.response = {
      status: 'error',
      code: 'PIE_ACTOR_NOT_STABLE',
      error: error.message,
      detail,
    };
    throw error;
  };

  for (;;) {
    if (Date.now() >= deadline) {
      throwNotStable();
    }

    if (sampleCount > 0) {
      const targetTime = started + (sampleCount * interval_ms);
      const sleepMs = Math.max(0, targetTime - Date.now());
      const remainingBeforeSleep = deadline - Date.now();
      if (sleepMs >= remainingBeforeSleep) {
        throwNotStable();
      }
      if (sleepMs > 0) {
        await delay(sleepMs);
      }
      if (Date.now() >= deadline) {
        throwNotStable();
      }
    }

    const remainingForSend = Math.max(1, deadline - Date.now());
    last = await connectionManager.send(
      'tcp-55558',
      'get_pie_actor_state',
      actorStateParams,
      { skipCache: true, timeoutMs: remainingForSend },
    );
    sampleCount++;

    if (previous) {
      lastDelta = transformDelta(previous, last);
      stableRun = isStableDelta(lastDelta, tolerance) ? stableRun + 1 : 1;
    } else {
      stableRun = 1;
    }

    if (stableRun >= stable_samples) {
      return {
        stable: true,
        sample_count: sampleCount,
        elapsed_ms: Date.now() - started,
        final: last,
      };
    }

    previous = last;
  }
}

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

  if (toolName === 'sample_pie_actor_state') {
    return samplePIEActorState(validated, connectionManager);
  }

  if (toolName === 'wait_for_pie_actor_stable') {
    return waitForPIEActorStable(validated, connectionManager);
  }

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
