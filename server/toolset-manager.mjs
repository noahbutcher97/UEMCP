// ToolsetManager — dynamic toolset enable/disable with tools/list_changed
//
// Responsibilities:
//   - Load tool definitions from tools.yaml
//   - Track enabled/disabled state per toolset
//   - Determine toolset availability based on ConnectionManager layer status
//   - Provide the list of currently active tools (for MCP tools/list response)
//   - Notify clients when the tool list changes

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ── Layer → toolset mapping ─────────────────────────────────
// Which layer a toolset requires. Management tools are always loaded.

/** @type {Record<string, string>} toolsetName → layerKey */
let TOOLSET_LAYERS = {};

// ── ToolsetManager ──────────────────────────────────────────

export class ToolsetManager {
  /**
   * @param {import('./connection-manager.mjs').ConnectionManager} connectionManager
   * @param {import('./tool-index.mjs').ToolIndex} toolIndex
   */
  constructor(connectionManager, toolIndex) {
    this.connectionManager = connectionManager;
    this.toolIndex = toolIndex;

    /** @type {object} raw parsed tools.yaml */
    this._toolsData = null;

    /** @type {Set<string>} currently enabled toolset names */
    this._enabled = new Set();

    /** @type {(() => void)|null} callback to fire tools/list_changed notification */
    this._onListChanged = null;
  }

  /**
   * Load tools.yaml and build the ToolIndex.
   * Call once at startup.
   */
  async load() {
    const yamlPath = join(__dirname, '..', 'tools.yaml');
    const raw = await readFile(yamlPath, 'utf-8');
    this._toolsData = yaml.load(raw);

    // Build the search index
    this.toolIndex.build(this._toolsData);

    // Extract layer requirements for each toolset
    TOOLSET_LAYERS = {};
    if (this._toolsData.toolsets) {
      for (const [name, def] of Object.entries(this._toolsData.toolsets)) {
        TOOLSET_LAYERS[name] = def.layer || 'unknown';
      }
    }

    // Auto-enable 'offline' toolset if its layer is available
    const offlineOk = await this.connectionManager.checkOfflineAvailable();
    if (offlineOk) {
      this._enabled.add('offline');
    }
  }

  /**
   * Register a callback for tools/list_changed notifications.
   * server.mjs wires this to the MCP server's notification system.
   * @param {() => void} fn
   */
  onListChanged(fn) {
    this._onListChanged = fn;
  }

  // ── Enable / Disable ──────────────────────────────────────

  /**
   * Enable one or more toolsets.
   * @param {string[]} names
   * @returns {{enabled: string[], alreadyEnabled: string[], unavailable: string[], unknown: string[]}}
   */
  async enable(names) {
    const result = { enabled: [], alreadyEnabled: [], unavailable: [], unknown: [] };
    let changed = false;

    for (const name of names) {
      if (!TOOLSET_LAYERS[name]) {
        result.unknown.push(name);
        continue;
      }
      if (this._enabled.has(name)) {
        result.alreadyEnabled.push(name);
        continue;
      }

      // Check if the required layer is available
      const layer = TOOLSET_LAYERS[name];
      const available = await this._isToolsetAvailable(name);
      if (!available) {
        result.unavailable.push(name);
        continue;
      }

      this._enabled.add(name);
      result.enabled.push(name);
      changed = true;
    }

    if (changed) this._fireListChanged();
    return result;
  }

  /**
   * Disable one or more toolsets.
   * @param {string[]} names
   * @returns {{disabled: string[], wasNotEnabled: string[], unknown: string[]}}
   */
  disable(names) {
    const result = { disabled: [], wasNotEnabled: [], unknown: [] };
    let changed = false;

    for (const name of names) {
      if (!TOOLSET_LAYERS[name]) {
        result.unknown.push(name);
        continue;
      }
      if (!this._enabled.has(name)) {
        result.wasNotEnabled.push(name);
        continue;
      }

      this._enabled.delete(name);
      result.disabled.push(name);
      changed = true;
    }

    if (changed) this._fireListChanged();
    return result;
  }

  /**
   * Auto-enable toolsets that contain matching tools (called by find_tools).
   * @param {string[]} toolsetNames
   */
  async autoEnable(toolsetNames) {
    const toEnable = toolsetNames.filter(n => !this._enabled.has(n) && TOOLSET_LAYERS[n]);
    if (toEnable.length > 0) {
      await this.enable(toEnable);
    }
  }

  // ── Status queries ────────────────────────────────────────

  /**
   * Get full status of all toolsets.
   * @returns {Promise<{name: string, layer: string, toolCount: number, enabled: boolean, available: boolean, reason?: string}[]>}
   */
  async listToolsets() {
    const result = [];
    const toolsetNames = this.toolIndex.getToolsetNames();

    for (const name of toolsetNames) {
      const layer = TOOLSET_LAYERS[name];
      const tools = this.toolIndex.getToolsetTools(name);
      const enabled = this._enabled.has(name);
      const available = await this._isToolsetAvailable(name);
      const reason = available ? undefined : this._unavailableReason(name);

      result.push({
        name,
        layer,
        toolCount: tools.length,
        enabled,
        available,
        ...(reason && { reason }),
      });
    }

    return result;
  }

  /**
   * Get the set of currently enabled toolset names.
   * @returns {string[]}
   */
  getEnabledNames() {
    return [...this._enabled];
  }

  /**
   * Get the full tool definition for a specific tool from tools.yaml.
   * Includes params schema if defined.
   * @param {string} toolName
   * @returns {{toolName: string, toolsetName: string, description: string, params?: object} | null}
   */
  getToolDef(toolName) {
    // Check management tools
    const mgmt = this._toolsData?.management?.tools?.[toolName];
    if (mgmt) {
      return { toolName, toolsetName: 'management', description: mgmt.description, params: mgmt.params };
    }

    // Check toolset tools
    if (this._toolsData?.toolsets) {
      for (const [tsName, tsDef] of Object.entries(this._toolsData.toolsets)) {
        if (tsDef.tools?.[toolName]) {
          const def = tsDef.tools[toolName];
          return { toolName, toolsetName: tsName, description: def.description, params: def.params };
        }
      }
    }
    return null;
  }

  // ── Private ───────────────────────────────────────────────

  async _isToolsetAvailable(name) {
    const layer = TOOLSET_LAYERS[name];
    if (!layer) return false;
    if (layer === 'offline') return await this.connectionManager.isLayerAvailable('offline');
    if (layer === 'tcp-55557') return await this.connectionManager.isLayerAvailable('tcp-55557');
    if (layer === 'tcp-55558') return await this.connectionManager.isLayerAvailable('tcp-55558');
    if (layer === 'http-30010') return await this.connectionManager.isLayerAvailable('http-30010');
    return false;
  }

  _unavailableReason(name) {
    const layer = TOOLSET_LAYERS[name];
    const layerInfo = this.connectionManager.layers[layer];
    if (!layerInfo) return `Unknown layer: ${layer}`;

    if (layer === 'offline') {
      return layerInfo.error || 'UNREAL_PROJECT_ROOT not set or path not found';
    }
    if (layer === 'tcp-55557') {
      return layerInfo.error || 'Unreal Editor not running or existing UnrealMCP plugin not loaded';
    }
    if (layer === 'tcp-55558') {
      return layerInfo.error || 'Unreal Editor not running or UEMCP plugin not installed (Phase 3)';
    }
    if (layer === 'http-30010') {
      return layerInfo.error || 'Remote Control API not enabled (Phase 4)';
    }
    return 'Unknown';
  }

  _fireListChanged() {
    if (this._onListChanged) {
      try { this._onListChanged(); } catch { /* swallow */ }
    }
  }
}
