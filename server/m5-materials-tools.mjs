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

  return connectionManager.send('tcp-55558', typeString, validated, { skipCache: !def.isReadOp });
}

export function getM5MaterialsToolDefs() {
  return M5_MATERIALS_SCHEMAS;
}
