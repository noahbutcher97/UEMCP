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
import { PROJECT_ERROR_CODES } from './project-errors.mjs';

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
  constructor(connectionManager, toolIndex, options = {}) {
    this.connectionManager = connectionManager;
    this.toolIndex = toolIndex;
    this._sendToolListChanged = options.sendToolListChanged || null;

    /** @type {object} raw parsed tools.yaml */
    this._toolsData = null;

    /** @type {Set<string>} currently enabled toolset names */
    this._enabled = new Set();

    /** @type {(() => void)|null} callback to fire tools/list_changed notification */
    this._onListChanged = null;

    /** @type {Map<string, {enable: () => void, disable: () => void}>} SDK tool handles */
    this._toolHandles = new Map();

    /** @type {Map<string, string>} initially visible tool name → parent toolset */
    this._initiallyVisibleTools = new Map();

    /** @type {boolean} whether ProjectContext has an attached identity */
    this._projectAttached = false;

    /** @type {object|null} last ProjectContext snapshot applied */
    this._projectContextSnapshot = null;
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

    this._enabled.clear();
    this._initiallyVisibleTools.clear();
  }

  /**
   * Register a callback for tools/list_changed notifications.
   * server.mjs wires this to the MCP server's notification system.
   * @param {() => void} fn
   */
  onListChanged(fn) {
    this._onListChanged = fn;
  }

  /**
   * Store an SDK tool handle so we can toggle its visibility in tools/list.
   * Called by server.mjs after each server.registerTool() registration.
   * @param {string} toolName
   * @param {{enable: () => void, disable: () => void}} handle — return value of server.registerTool()
   */
  registerToolHandle(toolName, handle) {
    this._toolHandles.set(toolName, handle);
  }

  /**
   * Set initial SDK visibility for all tools in a toolset.
   * Called after all tools are registered but before server.connect().
   * @param {string} toolsetName
   * @param {boolean} visible
   */
  setToolsetVisibility(toolsetName, visible) {
    const tools = this.toolIndex.getToolsetTools(toolsetName);
    for (const tool of tools) {
      const handle = this._toolHandles.get(tool.toolName);
      if (handle) {
        visible ? handle.enable() : handle.disable();
      }
      if (!visible) {
        this._initiallyVisibleTools.delete(tool.toolName);
      }
    }
  }

  /**
   * Batch visibility changes by mutating the SDK RegisteredTool.enabled field
   * directly when available, then emitting one list-changed notification.
   * @param {string[]} toolsetNames
   * @param {boolean} visible
   * @returns {boolean} true when any handle visibility changed
   */
  setToolsetVisibilityBatch(toolsetNames, visible) {
    let changed = false;
    for (const toolsetName of toolsetNames) {
      const tools = this.toolIndex.getToolsetTools(toolsetName);
      for (const tool of tools) {
        const handle = this._toolHandles.get(tool.toolName);
        if (!handle) continue;

        if (Object.prototype.hasOwnProperty.call(handle, 'enabled')) {
          if (handle.enabled !== visible) {
            handle.enabled = visible;
            changed = true;
          }
        } else {
          visible ? handle.enable() : handle.disable();
          changed = true;
        }

        if (visible) {
          this._initiallyVisibleTools.delete(tool.toolName);
        } else {
          this._initiallyVisibleTools.delete(tool.toolName);
        }
      }
    }
    if (changed) this._fireListChanged();
    return changed;
  }

  // ── Enable / Disable ──────────────────────────────────────

  /**
   * Enable one or more toolsets.
   * @param {string[]} names
   * @returns {{enabled: string[], alreadyEnabled: string[], unavailable: string[], unknown: string[]}}
   */
  async enable(names, { source = 'manual' } = {}) {
    const result = { enabled: [], alreadyEnabled: [], unavailable: [], unknown: [], blocked: [] };
    for (const name of names) {
      if (!TOOLSET_LAYERS[name]) {
        result.unknown.push(name);
        continue;
      }
      if (this._enabled.has(name)) {
        result.alreadyEnabled.push(name);
        continue;
      }

      if (this.isProjectScopedToolset(name) && !this._projectAttached && source !== 'project_context') {
        result.unavailable.push(name);
        result.blocked.push({
          toolset: name,
          code: PROJECT_ERROR_CODES.PROJECT_NOT_ATTACHED,
          message: 'No Unreal project is attached for this UEMCP session.',
        });
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
      this.setToolsetVisibilityBatch([name], true);
      result.enabled.push(name);
    }

    return result;
  }

  /**
   * Disable one or more toolsets.
   * @param {string[]} names
   * @returns {{disabled: string[], wasNotEnabled: string[], unknown: string[]}}
   */
  disable(names) {
    const result = { disabled: [], wasNotEnabled: [], unknown: [] };
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
      this.setToolsetVisibilityBatch([name], false);
      result.disabled.push(name);
    }
    return result;
  }

  /**
   * Auto-enable toolsets that contain matching tools (called by find_tools).
   * @param {string[]} toolsetNames
   * @returns {Promise<{enabled: string[], alreadyEnabled: string[], unavailable: string[], unknown: string[]}>}
   */
  async autoEnable(toolsetNames, options = {}) {
    const toEnable = toolsetNames.filter(n => !this._enabled.has(n) && TOOLSET_LAYERS[n]);
    if (toEnable.length > 0) {
      return await this.enable(toEnable, { source: options.source || 'find_tools' });
    }
    return { enabled: [], alreadyEnabled: [], unavailable: [], unknown: [], blocked: [] };
  }

  /**
   * Whether a toolset requires a session project attachment.
   * @param {string} name
   * @returns {boolean}
   */
  isProjectScopedToolset(name) {
    const layer = TOOLSET_LAYERS[name];
    return layer === 'offline' || layer === 'tcp-55558' || layer === 'http-30010';
  }

  /**
   * Apply ProjectContext visibility policy after attach/detach/root changes.
   * @param {object} snapshot
   */
  async applyProjectContext(snapshot) {
    this._projectContextSnapshot = snapshot;
    this._projectAttached = !!snapshot?.identity;

    if (this._projectAttached) {
      const offline = await this.enable(['offline'], { source: 'project_context' });
      const initiallyVisible = await this._enableInitiallyVisibleTools();
      return { ...offline, initiallyVisible };
    }

    const initiallyHidden = this._disableInitiallyVisibleTools();
    const toDisable = this.getEnabledNames().filter(name => this.isProjectScopedToolset(name));
    const disabled = toDisable.length > 0 ? this.disable(toDisable) : { disabled: [], wasNotEnabled: [], unknown: [] };
    return {
      enabled: [],
      alreadyEnabled: [],
      unavailable: [],
      unknown: [],
      blocked: [],
      disabled: disabled.disabled,
      initiallyHidden,
    };
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
   * Get the raw parsed tools.yaml data (for wire_type map building, etc.).
   * @returns {object|null}
   */
  getToolsData() {
    return this._toolsData;
  }

  /**
   * Get the set of currently enabled toolset names.
   * @returns {string[]}
   */
  getEnabledNames() {
    return [...this._enabled];
  }

  /**
   * Count tools visible outside enabled toolsets. Used for active-count
   * summaries when selected tools are visible in the initial schema.
   * @returns {number}
   */
  getAdditionalVisibleToolCount() {
    let count = 0;
    for (const toolsetName of this._initiallyVisibleTools.values()) {
      if (!this._enabled.has(toolsetName)) count++;
    }
    return count;
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
    if (layer === 'tcp-55558') return await this.connectionManager.isLayerAvailable('tcp-55558');
    if (layer === 'http-30010') return await this.connectionManager.isLayerAvailable('http-30010');
    return false;
  }

  async _enableInitiallyVisibleTools() {
    const tools = typeof this.toolIndex.getInitiallyVisibleTools === 'function'
      ? this.toolIndex.getInitiallyVisibleTools()
      : [];
    const availability = new Map();
    let changed = false;
    const visible = [];
    const unavailable = [];

    for (const tool of tools) {
      if (tool.toolsetName === 'management' || this._enabled.has(tool.toolsetName)) continue;

      const handle = this._toolHandles.get(tool.toolName);
      if (!handle) continue;

      let available = availability.get(tool.toolsetName);
      if (available === undefined) {
        available = await this._isToolsetAvailable(tool.toolsetName);
        availability.set(tool.toolsetName, available);
      }
      if (!available) {
        unavailable.push(tool.toolName);
        continue;
      }

      if (this._initiallyVisibleTools.has(tool.toolName)) continue;
      handle.enable();
      this._initiallyVisibleTools.set(tool.toolName, tool.toolsetName);
      visible.push(tool.toolName);
      changed = true;
    }

    if (changed) this._fireListChanged();
    return { visible, unavailable };
  }

  _disableInitiallyVisibleTools() {
    const hidden = [];
    let changed = false;

    for (const toolName of this._initiallyVisibleTools.keys()) {
      const handle = this._toolHandles.get(toolName);
      if (handle) {
        handle.disable();
        changed = true;
      }
      hidden.push(toolName);
    }

    this._initiallyVisibleTools.clear();
    if (changed) this._fireListChanged();
    return hidden;
  }

  _unavailableReason(name) {
    const layer = TOOLSET_LAYERS[name];
    const layerInfo = this.connectionManager.layers[layer];
    if (!layerInfo) return `Unknown layer: ${layer}`;

    if (layer === 'offline') {
      return layerInfo.error || 'No project attached or project path not readable. Fix: use attach_project, select a .uemcp-targets entry, or use explicit UEMCP_PROJECT_ATTACH_MODE=env compatibility mode.';
    }
    if (layer === 'tcp-55558') {
      return layerInfo.error || 'Unreal Editor not running or UEMCP plugin not installed. Fix: build and enable the UEMCP C++ plugin (see Phase 3 docs).';
    }
    if (layer === 'http-30010') {
      return layerInfo.error || 'Remote Control API not enabled. Fix: enable the "Remote Control API" plugin in Edit → Plugins and restart the editor.';
    }
    return 'Unknown';
  }

  _fireListChanged() {
    if (this._sendToolListChanged) {
      this._sendToolListChanged();
      return;
    }
    if (this._onListChanged) {
      try { this._onListChanged(); } catch { /* swallow */ }
    }
  }
}

// ── Response-shape helpers (W-O, D142) ──────────────────────────
// Pure functions — exported separately from the class for unit testability.

/**
 * Summarize an autoEnable() result into the shape exposed by find_tools.
 *
 * W-O / D142: closes the diagnostic-clarity bug Pivot-W3's audit (D141)
 * uncovered. Pre-fix, find_tools reported `autoEnabled: [...attempted]` —
 * listing toolsets it ATTEMPTED to enable, not those that actually
 * transitioned. When a toolset's underlying layer was unavailable,
 * autoEnable() silently skipped it but the response still claimed success.
 *
 * Post-fix (Option C, backward-compat preserving):
 *   - `autoEnabled` retains its name but only contains toolsets that
 *     actually transitioned from disabled → enabled in this call.
 *   - `unavailable` (parallel field, present only when non-empty) lists
 *     toolsets whose layer health-check failed.
 *   - `alreadyEnabled` (parallel field, present only when non-empty) lists
 *     toolsets that were already enabled before the call (autoEnable's
 *     own pre-filter strips these before reaching enable(), so we recover
 *     them by intersecting `attempted` with the pre-call enabled set).
 *
 * @param {string[]} attempted - toolsets passed to autoEnable
 * @param {{enabled: string[], unavailable: string[], alreadyEnabled: string[], unknown: string[]}} result
 *        - return value of autoEnable()
 * @param {Set<string>} previouslyEnabled - getEnabledNames() captured before the call
 * @returns {{autoEnabled: string[], unavailable: string[], alreadyEnabled: string[]}}
 */
export function summarizeAutoEnable(attempted, result, previouslyEnabled) {
  const alreadyEnabled = attempted.filter(n => previouslyEnabled.has(n));
  return {
    autoEnabled: [...result.enabled],
    unavailable: [...result.unavailable],
    alreadyEnabled,
  };
}
