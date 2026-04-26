// M5 animation toolset stubs (M5-PREP scaffold).
//
// Placeholder for the 4 not-yet-shipped animation tools:
//   create_montage, add_montage_section, add_montage_notify, get_audio_asset_info
//
// The 4 shipped reads (get_montage_full / get_anim_sequence_info / get_blend_space /
// get_anim_curve_data) live in menhance-tcp-tools.mjs under M-enhance D77 — do NOT
// duplicate them here.
//
// Sub-worker M5-animation+materials populates M5_ANIMATION_SCHEMAS with Zod
// schemas + isReadOp flags, and replaces executeM5AnimationTool's body with
// connectionManager.send('tcp-55558', wireType, args, ...). Mirror
// actors-tcp-tools.mjs for the reference shape. After populating, the existing
// for-loop in server.mjs (already wired by M5-PREP) registers the new MCP tools
// at next startup — no edit to server.mjs needed.

// ── Wire-type map (populated by initM5AnimationTools from tools.yaml) ──
let M5_ANIMATION_WIRE_MAP = {};

/**
 * Initialize wire_type map from parsed tools.yaml. Called once from server.mjs
 * after toolsetManager.load(). No-op until sub-worker populates schemas + yaml
 * wire_type fields.
 */
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

// ── Schemas ────────────────────────────────────────────────────────
// Sub-worker fills entries here. Empty = no MCP tools register, no executes
// reach the wire. Shape per entry:
//   <toolName>: { description, schema: { paramName: zodField, ... }, isReadOp }
export const M5_ANIMATION_SCHEMAS = {};

/**
 * Execute an M5 animation tool against TCP:55558. Sub-worker replaces the body
 * with `return connectionManager.send('tcp-55558', wireType, validated, {...})`.
 */
export async function executeM5AnimationTool(toolName, _args, _connectionManager) {
  const def = M5_ANIMATION_SCHEMAS[toolName];
  if (!def) {
    return {
      status: 'error',
      code: 'not_implemented',
      error: `M5 tool '${toolName}' not yet shipped (stub from M5-PREP)`,
    };
  }
  // Sub-worker: replace this with real Zod validation + connectionManager.send.
  return {
    status: 'error',
    code: 'not_implemented',
    error: `M5 tool '${toolName}' has a schema but no execute body (sub-worker incomplete)`,
  };
}

/** Export tool-def shape for server.mjs registration. */
export function getM5AnimationToolDefs() {
  return M5_ANIMATION_SCHEMAS;
}
