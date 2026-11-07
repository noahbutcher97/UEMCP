// M5 materials toolset — material creation on TCP:55558.
//
// Ships 2 not-shipped tools per docs/handoffs/m5-animation-materials.md:
//   create_material, create_material_instance
//
// set_material_parameter is RC-routed per D101 (ii) — see rc-tools.mjs
// (DELEGATE_EXECS) for that handler. The 2 shipped reads
// (list_material_parameters via rc-tools.mjs FULL-RC, get_material_graph
// via menhance-tcp-tools.mjs FULL-TCP under M-enhance D77) are NOT
// duplicated here.

import { z } from 'zod';

// ── Wire-type map (populated by initM5MaterialsTools from tools.yaml) ──
let M5_MATERIALS_WIRE_MAP = {};

export function initM5MaterialsTools(toolsData) {
  M5_MATERIALS_WIRE_MAP = {};
  const toolset = toolsData?.toolsets?.materials;
  if (!toolset?.tools) return;
  for (const [name, def] of Object.entries(toolset.tools)) {
    if (def.wire_type) {
      M5_MATERIALS_WIRE_MAP[name] = def.wire_type;
    }
  }
}

// ── Schemas ────────────────────────────────────────────────────
export const M5_MATERIALS_SCHEMAS = {

  create_material_function: {
    description: 'Create an unsaved regular material function. UEMCP 1.0.24+. Rejects existing destinations. Asset allocation is not undoable; subsequent expression edits are transactional.',
    schema: { asset_path: z.string().regex(/^\/Game\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+$/) },
    isReadOp: false,
  },
  create_material_expression: {
    description: 'Add a typed expression to a closed material/function graph. FunctionInput is scalar. Read get_material_graph with representation:source for expected_revision and pins. No compile/save. UEMCP 1.0.24+.',
    schema: {
      asset_path: z.string().min(1), expected_revision: z.string().regex(/^[a-fA-F0-9]{40}$/),
      kind: z.enum(['Constant', 'Multiply', 'FunctionInput', 'FunctionOutput', 'FunctionCall']),
      name: z.string().min(1).max(128).optional(), function_path: z.string().min(1).optional(),
      value: z.number().finite().min(-3.402823466e38).max(3.402823466e38).optional(),
      const_a: z.number().finite().min(-3.402823466e38).max(3.402823466e38).optional(),
      const_b: z.number().finite().min(-3.402823466e38).max(3.402823466e38).optional(),
    }, isReadOp: false,
  },
  connect_material_expressions: {
    description: 'Connect same-owner expression GUIDs with explicit output index and input name from source readback. Names use FName matching. Existing connection requires replace:true. Undoable; no compile/save.',
    schema: {
      asset_path: z.string().min(1), expected_revision: z.string().regex(/^[a-fA-F0-9]{40}$/),
      from_expression_id: z.string().uuid(), output_index: z.number().int().min(0),
      to_expression_id: z.string().uuid(), input_name: z.string().min(1), replace: z.boolean().optional(),
    }, isReadOp: false,
  },
  connect_material_property: {
    description: 'Connect an expression to an active Surface material property. Explicit replacement; Undoable, no compile/save. Requires fresh source expected_revision.',
    schema: {
      asset_path: z.string().min(1), expected_revision: z.string().regex(/^[a-fA-F0-9]{40}$/),
      from_expression_id: z.string().uuid(), output_index: z.number().int().min(0),
      property: z.enum(['EmissiveColor', 'BaseColor', 'Roughness']), replace: z.boolean().optional(),
    }, isReadOp: false,
  },
  update_material_graph: {
    description: 'Propagate function changes or request material compilation. No save. Not an Undo boundary: propagation can affect dependents. Close material/function editors first. Poll get_material_compile_status on consumer; consumer_required is not compilation success.',
    schema: { asset_path: z.string().min(1), expected_revision: z.string().regex(/^[a-fA-F0-9]{40}$/) }, isReadOp: false,
  },
  get_material_compile_status: {
    description: 'Uncached current consumer material compilation state: not_requested, stale, pending, complete, error, unavailable. Reports feature level, shader platform and errors. Functions require a consumer; absence of errors alone is not success.',
    schema: { asset_path: z.string().min(1) }, isReadOp: true,
  },

  create_material: {
    description: 'Create a UMaterial asset with specified domain and blend mode. Domain: Surface|DeferredDecal|LightFunction|Volume|PostProcess|UI|RuntimeVirtualTexture. BlendMode: Opaque|Masked|Translucent|Additive|Modulate|AlphaComposite|AlphaHoldout. Unknown values return UNKNOWN_DOMAIN / UNKNOWN_BLEND_MODE.',
    schema: {
      name:       z.string().describe('New material asset name'),
      path:       z.string().optional().describe('Package path (default /Game/Materials)'),
      domain:     z.string().optional().describe('Material domain (default Surface)'),
      blend_mode: z.string().optional().describe('Blend mode (default Opaque)'),
    },
    isReadOp: false,
  },

  create_material_instance: {
    description: 'Create a UMaterialInstanceConstant from a parent UMaterial or UMaterialInstanceConstant. Parent path accepts either bare /Game/... or doubled object-path form.',
    schema: {
      name:        z.string().describe('New MIC asset name'),
      parent_path: z.string().describe('Parent material/MIC path'),
      path:        z.string().optional().describe('Package path (default /Game/Materials)'),
    },
    isReadOp: false,
  },
};

/**
 * Execute an M5 materials tool against TCP:55558.
 * set_material_parameter is NOT here — it's an RC delegate in rc-tools.mjs.
 */
export async function executeM5MaterialsTool(toolName, args, connectionManager) {
  const def = M5_MATERIALS_SCHEMAS[toolName];
  if (!def) {
    return {
      status: 'error',
      code: 'not_implemented',
      error: `M5 tool '${toolName}' not yet shipped (stub from M5-PREP)`,
    };
  }

  const validated = z.object(def.schema).parse(args);
  const typeString = M5_MATERIALS_WIRE_MAP[toolName] || toolName;

  try {
    return await connectionManager.send('tcp-55558', typeString, validated,
      { skipCache: true, ...(toolName === 'update_material_graph' ? { timeoutMs: 30000 } : {}) });
  } catch (error) {
    // The MCP registration boundary renders Error.message. Preserve native
    // rejection codes there as well as on the Error object for recovery.
    if (typeof error.code === 'string') error.message = `[${error.code}] ${error.message}`;
    throw error;
  }
}

export function getM5MaterialsToolDefs() {
  return M5_MATERIALS_SCHEMAS;
}
