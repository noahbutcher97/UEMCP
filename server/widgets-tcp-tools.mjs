// Widgets toolset TCP handlers — M3 (D23 oracle retirement).
//
// 7 tools dispatching to the UEMCP custom plugin on TCP:55558. Replaces the
// legacy widgets section of tcp-tools.mjs, which routed to the conformance
// oracle (UnrealMCP plugin, TCP:55557).
//
// Wire-shape parity preserved against the oracle for the 5 working handlers
// (per docs/specs/conformance-oracle-contracts.md §4); the 2 previously-
// broken handlers (set_text_block_binding, add_widget_to_viewport) ship
// CORRECTED behavior — their oracle responses don't match the new shape
// because the rebuild fixes the bug. See plugin/.../WidgetHandlers.cpp
// for the bug-fix details.
//
// Convention matches actors-tcp-tools.mjs (M3-actors precedent, D93):
// {description, schema, isReadOp} per tool, wire_type translation via
// tools.yaml (`widgets:` toolset), ConnectionManager.send dispatch,
// stripDoubledAssetSuffix P0-7 normalization preserved.

import { z } from 'zod';

// ── Common Zod shapes ──────────────────────────────────────────

const Vec2Optional = z.array(z.number()).length(2).optional().describe('[x, y] position');

// ── Wire-type map (populated by initWidgetsTools from tools.yaml) ──

let WIDGETS_WIRE_MAP = {};

/**
 * Initialize wire_type map from parsed tools.yaml.
 * Call once from server.mjs after toolsetManager.load().
 * @param {object} toolsData — parsed tools.yaml root object
 */
export function initWidgetsTools(toolsData) {
  WIDGETS_WIRE_MAP = {};
  const toolset = toolsData?.toolsets?.widgets;
  if (!toolset?.tools) return;
  for (const [name, def] of Object.entries(toolset.tools)) {
    if (def.wire_type) {
      WIDGETS_WIRE_MAP[name] = def.wire_type;
    }
  }
}

// ── Schemas ────────────────────────────────────────────────────
//
// Field names match the C++ handler param names so params pass straight
// through. Derived from conformance-oracle-contracts.md §4. P0-9 / P0-10
// defense-in-depth Zod validation runs in executeWidgetsTool so bad shapes
// never reach the wire.

export const WIDGETS_SCHEMAS = {

  create_widget: {
    description: 'Create UMG Widget Blueprint at /Game/Widgets/<name> with root CanvasPanel',
    schema: {
      name: z.string().describe('Widget blueprint name'),
    },
    isReadOp: false,
  },

  add_text_block: {
    description: 'Add text block to widget (requires root CanvasPanel)',
    schema: {
      blueprint_name: z.string().describe('Widget blueprint name'),
      widget_name:    z.string().describe('Name for the TextBlock'),
      text:           z.string().optional().describe("Initial text, default 'New Text Block'"),
      position:       Vec2Optional,
    },
    isReadOp: false,
  },

  add_button: {
    description: 'Add button with child TextBlock to widget (requires root CanvasPanel)',
    schema: {
      blueprint_name: z.string().describe('Widget blueprint name'),
      widget_name:    z.string().describe('Button widget name'),
      text:           z.string().describe('Button label text'),
      position:       Vec2Optional,
    },
    isReadOp: false,
  },

  bind_widget_event: {
    description: 'Bind widget event (e.g. OnClicked) to function in event graph',
    schema: {
      blueprint_name: z.string().describe('Widget blueprint name'),
      widget_name:    z.string().describe('Widget to bind event on'),
      event_name:     z.string().describe('Event name e.g. OnClicked'),
    },
    isReadOp: false,
  },

  set_text_block_binding: {
    description: 'Set text block data binding — creates pure FText getter and registers FDelegateEditorBinding',
    schema: {
      blueprint_name: z.string().describe('Widget blueprint name'),
      widget_name:    z.string().describe('TextBlock widget to bind'),
      binding_name:   z.string().describe('Variable name for the binding'),
    },
    isReadOp: false,
  },

  add_widget_to_viewport: {
    description: 'Show widget in PIE game viewport (requires PIE running — returns NOT_IN_PIE error otherwise)',
    schema: {
      blueprint_name: z.string().describe('Widget blueprint name'),
      z_order:        z.number().int().optional().describe('Z-order, default 0'),
    },
    isReadOp: false,
  },

  add_input_action_node: {
    description: 'Add input action event node (legacy Input Actions, NOT Enhanced Input)',
    schema: {
      blueprint_name: z.string().describe('Blueprint asset name (works on any BP, not just widgets)'),
      action_name:    z.string().describe('Input action name'),
      node_position:  Vec2Optional,
    },
    isReadOp: false,
  },
};

/**
 * Strip a self-doubled asset suffix like "MyWidget.MyWidget" → "MyWidget" (P0-7).
 * The oracle's UMG handlers split into two groups: some expect
 * "/Game/Widgets/<name>" while others append ".<name>" internally. Users who
 * read plugin source and pre-double their name now hit the latter group with
 * "<name>.<name>.<name>" and load fails. The new TCP:55558 handlers all use
 * the single-form path, but we keep this normalization so callers that already
 * pre-double (defensively) still hit the right asset path.
 *
 * @param {string} value
 * @returns {string}
 */
function stripDoubledAssetSuffix(value) {
  if (typeof value !== 'string') return value;
  const dotIdx = value.indexOf('.');
  if (dotIdx <= 0) return value;
  const left = value.slice(0, dotIdx);
  const right = value.slice(dotIdx + 1);
  return left === right ? left : value;
}

/**
 * Execute a widgets toolset tool against TCP:55558.
 *
 * @param {string} toolName — tools.yaml name (e.g., 'create_widget')
 * @param {object} args — raw args (validated here via Zod)
 * @param {import('./connection-manager.mjs').ConnectionManager} connectionManager
 * @returns {Promise<object>} — wire response (Bridge envelope, normalized by ConnectionManager)
 */
export async function executeWidgetsTool(toolName, args, connectionManager) {
  const def = WIDGETS_SCHEMAS[toolName];
  if (!def) throw new Error(`widgets-tcp-tools: unknown tool "${toolName}"`);

  // P0-9 (required-param) / P0-10 (vector shape) defense-in-depth.
  const validated = z.object(def.schema).parse(args);

  // Wire-type translation: tools.yaml name → C++ type string.
  const typeString = WIDGETS_WIRE_MAP[toolName] || toolName;

  // P0-7: normalize "Name.Name" → "Name" on widget blueprint params so the
  // plugin's WidgetAssetPath helper builds the right /Game/Widgets/<name> path.
  const wireParams = { ...validated };
  if (typeof wireParams.blueprint_name === 'string') {
    wireParams.blueprint_name = stripDoubledAssetSuffix(wireParams.blueprint_name);
  }
  if (toolName === 'create_widget' && typeof wireParams.name === 'string') {
    wireParams.name = stripDoubledAssetSuffix(wireParams.name);
  }

  return connectionManager.send('tcp-55558', typeString, wireParams, { skipCache: !def.isReadOp });
}

/** Export tool-def shape for server.mjs registration. */
export function getWidgetsToolDefs() {
  return WIDGETS_SCHEMAS;
}
