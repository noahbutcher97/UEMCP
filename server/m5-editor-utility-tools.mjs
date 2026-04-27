// M5 editor-utility toolset — 6 security-sensitive tools (D101 (iv) decision).
//
// Tools shipped:
//   run_python_command, get_editor_utility_blueprint, run_editor_utility,
//   duplicate_asset, rename_asset, delete_asset_safe
//
// The 1 shipped tool (get_editor_state via menhance-tcp-tools.mjs under
// M-enhance D77) is NOT duplicated here.
//
// ── Defense-in-depth posture (4 layers, 2 server-side + 2 plugin-side) ──
//
// Per D101 (iv): run_python_command + delete_asset_safe both warrant
// extra safety. The defense-in-depth design distributes checks across
// the JS server and the C++ plugin so each layer fails closed independently.
//
// Layer 1 (here, JS): --enable-python-exec startup-flag gate. Off by default;
//   request returns PYTHON_EXEC_DISABLED before any wire dispatch. Means a
//   server launched without the flag never even talks to the plugin about
//   Python — no audit log entry on the plugin side because the call never
//   reaches it (intentional; flag denials are server-policy, not plugin events).
//
// Layer 0 (plugin C++, EditorUtilityHandlers.cpp): runtime IPythonScriptPlugin
//   availability check → PYTHON_PLUGIN_NOT_AVAILABLE if Python plugin disabled
//   in .uproject Plugins[]. Belt-and-suspenders against a server launched WITH
//   the flag but in a project that doesn't have the Python plugin enabled.
//
// Layer 2 (plugin C++): D14 deny-list scan (`os`, `subprocess`, `eval`, `exec`,
//   `open(`, `__import__`) → PYTHON_EXEC_DENY_LIST with matched-pattern detail.
//
// Layer 3 (plugin C++): per-call audit log via LogUEMCPSecurity to
//   <ProjectName>.log with [UEMCP-PYTHON-EXEC] / [UEMCP-DELETE-ASSET] prefixes.

import { z } from 'zod';

// ── Module-scope state (set by initM5EditorUtilityTools) ──────────

let M5_EDITOR_UTILITY_WIRE_MAP = {};

// PYTHON_EXEC_DISABLED gate — flipped on by server.mjs at startup if either
// `--enable-python-exec` argv flag OR `UEMCP_ENABLE_PYTHON_EXEC=1` env var is
// present. Defaults to `false` so that a server launched with no flag refuses
// `run_python_command` calls before they reach the wire. A test harness can
// also call initM5EditorUtilityTools(toolsData, { pythonExecEnabled: true })
// to exercise the success path.
let _pythonExecEnabled = false;

/**
 * Initialize wire_type map + security flags from parsed tools.yaml + options.
 * Call once from server.mjs after toolsetManager.load().
 *
 * @param {object} toolsData — parsed tools.yaml root object
 * @param {object} [options]
 * @param {boolean} [options.pythonExecEnabled=false] — Layer 1 server-side gate
 */
export function initM5EditorUtilityTools(toolsData, options = {}) {
  M5_EDITOR_UTILITY_WIRE_MAP = {};
  _pythonExecEnabled = options.pythonExecEnabled === true;
  const toolset = toolsData?.toolsets?.['editor-utility'];
  if (!toolset?.tools) return;
  for (const [name, def] of Object.entries(toolset.tools)) {
    if (def.wire_type) {
      M5_EDITOR_UTILITY_WIRE_MAP[name] = def.wire_type;
    }
  }
}

// ── Schemas (name → {description, schema, isReadOp}) ──────────────
//
// Field names match the C++ handler param names — params pass straight through
// after Zod validation. Defaults declared on the schema mirror the plugin-side
// defaults so callers see the same behavior whether they pass the field
// explicitly or omit it.

export const M5_EDITOR_UTILITY_SCHEMAS = {

  run_python_command: {
    description: 'Execute Python script via Python Editor Script Plugin. SECURITY-SENSITIVE — requires --enable-python-exec startup flag (Layer 1) AND passes a deny-list scan (Layer 2: rejects scripts containing os/subprocess/eval/exec/open/__import__). Every call audit-logged.',
    schema: {
      command: z.string().describe('Python statement(s) to execute. Multi-line OK.'),
    },
    // Mutates editor state (could spawn / delete assets via Python) — skip cache.
    isReadOp: false,
  },

  get_editor_utility_blueprint: {
    description: 'Read EditorUtilityBlueprint or EditorUtilityWidgetBlueprint — parent class, generated class, Run-method signature, editor-menu registration, variable + function counts.',
    schema: {
      asset_path: z.string().describe('/Game/... path to an EUB or EUW asset'),
    },
    isReadOp: true,
  },

  run_editor_utility: {
    description: 'Invoke an EditorUtilityBlueprint\'s Run (or K2_Run) function on a transient instance. Run function must be zero-arg.',
    schema: {
      asset_path: z.string().describe('/Game/... path to a compiled EUB / EUW'),
    },
    // Side effects depend on what Run() does — cannot cache.
    isReadOp: false,
  },

  duplicate_asset: {
    description: 'Duplicate asset to a new path. Refuses pre-existing destination unless overwrite:true.',
    schema: {
      source_path: z.string().describe('Source /Game/... path'),
      dest_path:   z.string().describe('Destination /Game/... path (must not exist unless overwrite:true)'),
      overwrite:   z.boolean().optional().default(false).describe('Allow replacing an existing destination asset (default false)'),
    },
    isReadOp: false,
  },

  rename_asset: {
    description: 'Rename / move asset with automatic reference fixup. new_name accepts either a bare name (target package directory inferred from source) or a full /Game/... path.',
    schema: {
      asset_path: z.string().describe('Source /Game/... path'),
      new_name:   z.string().describe('Bare new name OR a full /Game/... destination path'),
    },
    isReadOp: false,
  },

  delete_asset_safe: {
    description: 'Delete asset with dependency-check + soft-delete defaults. SECURITY-SENSITIVE: blocks on referencers unless force:true; defaults to soft-delete (rename to /Game/_Deleted/<name>); permanent:true requires force:true acknowledgement. Every successful delete audit-logged.',
    schema: {
      asset_path:    z.string().describe('Asset /Game/... path to delete'),
      force:         z.boolean().optional().default(false).describe('Override referencer-block (default false). Required if asset has dependencies OR if permanent:true.'),
      permanent:     z.boolean().optional().default(false).describe('Hard delete (default false = soft-delete to /Game/_Deleted/). Requires force:true.'),
      move_to_trash: z.boolean().optional().default(true).describe('When permanent:false, move to /Game/_Deleted/ (default true). Setting false with permanent:false yields BAD_PARAMS.'),
    },
    isReadOp: false,
  },
};

/**
 * Layer 1 gate response — Python execution is server-policy disabled.
 * Returned client-side without ever talking to the plugin so flag denials
 * leave no audit footprint on the editor (intentional — flag-policy is a
 * server concern, not an editor event).
 */
function pythonExecDisabledResponse() {
  return {
    status: 'error',
    error:  'run_python_command disabled by server policy — restart the MCP server with --enable-python-exec (or UEMCP_ENABLE_PYTHON_EXEC=1) to enable',
    code:   'PYTHON_EXEC_DISABLED',
  };
}

/**
 * Execute an editor-utility tool against TCP:55558.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {import('./connection-manager.mjs').ConnectionManager} connectionManager
 * @returns {Promise<object>}
 */
export async function executeM5EditorUtilityTool(toolName, args, connectionManager) {
  const def = M5_EDITOR_UTILITY_SCHEMAS[toolName];
  if (!def) {
    return {
      status: 'error',
      code:   'UNKNOWN_TOOL',
      error:  `editor-utility tool "${toolName}" not registered`,
    };
  }

  // Layer 1 — server-side PYTHON_EXEC_DISABLED gate. Runs BEFORE Zod validation
  // so that even a malformed Python request gets the policy denial rather than
  // a generic schema error — the security signal is the response the caller
  // most needs to see.
  if (toolName === 'run_python_command' && !_pythonExecEnabled) {
    return pythonExecDisabledResponse();
  }

  // Defense-in-depth Zod validation — same pattern as actors-tcp-tools.mjs.
  const validated = z.object(def.schema).parse(args);

  const wireType = M5_EDITOR_UTILITY_WIRE_MAP[toolName] || toolName;
  return connectionManager.send(
    'tcp-55558', wireType, validated, { skipCache: !def.isReadOp },
  );
}

export function getM5EditorUtilityToolDefs() {
  return M5_EDITOR_UTILITY_SCHEMAS;
}

// Test-harness escape hatch — lets tests verify what the gate-state was set to
// without exporting the module-scope variable directly. Internal API; avoid
// using outside tests.
export function _isPythonExecEnabledForTests() {
  return _pythonExecEnabled;
}
