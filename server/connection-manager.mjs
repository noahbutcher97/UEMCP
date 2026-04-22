// ConnectionManager — manages connections to all 4 layers
//
// Layers:
//   offline    — always available if projectRoot is set
//   tcp-55557  — existing UnrealMCP plugin (Phase 2)
//   tcp-55558  — new UEMCP plugin (Phase 3 / M1)
//   http-30010 — Remote Control API (D66 HYBRID — activated inside M-enhance)
//
// Design:
//   - Lazy connect: don't probe until first tool call needs a layer
//   - Health check caching with 30s TTL
//   - Connect-per-command for TCP (matches existing plugin behavior)
//   - Command queue: one in-flight command per TCP layer
//   - Test seams: config.tcpCommandFn (TCP) / config.httpCommandFn (HTTP)

import net from 'node:net';
import http from 'node:http';
import { createHash } from 'node:crypto';

// ── Layer status ────────────────────────────────────────────

/** @enum {string} */
const LayerStatus = {
  UNKNOWN:      'unknown',       // never probed
  AVAILABLE:    'available',     // last health check passed
  UNAVAILABLE:  'unavailable',   // last health check failed
  CONNECTING:   'connecting',    // probe in progress
};

// ── TCP Client (connect-per-command) ────────────────────────

/**
 * Send a single command over TCP, following the existing plugin's protocol.
 * Opens socket → sends JSON → reads until valid JSON → closes socket.
 *
 * @param {number} port
 * @param {string} type    - command name (the "type" field, NOT "command")
 * @param {object} params
 * @param {number} timeoutMs
 * @returns {Promise<object>} parsed JSON response
 */
function tcpCommand(port, type, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' });
    const chunks = [];
    let settled = false;

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err);
      else resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      // Send request — no newline terminator (matches Python server behavior)
      const payload = JSON.stringify({ type, params: params || {} });
      socket.write(payload);
    });

    socket.on('data', (chunk) => {
      chunks.push(chunk);
      // Try to parse accumulated data as JSON (no framing — just attempt parse)
      const raw = Buffer.concat(chunks).toString('utf-8');
      try {
        const parsed = JSON.parse(raw);
        finish(null, parsed);
      } catch {
        // Incomplete JSON, keep reading
      }
    });

    socket.on('end', () => {
      if (!settled) {
        const raw = Buffer.concat(chunks).toString('utf-8');
        if (raw.length === 0) {
          finish(new Error(`TCP:${port} — connection closed with no response`));
          return;
        }
        try {
          finish(null, JSON.parse(raw));
        } catch {
          finish(new Error(`TCP:${port} — invalid JSON response: ${raw.slice(0, 200)}`));
        }
      }
    });

    socket.on('timeout', () => {
      finish(new Error(`TCP:${port} — timeout after ${timeoutMs}ms`));
    });

    socket.on('error', (err) => {
      finish(new Error(`TCP:${port} — ${err.message}`));
    });
  });
}

// ── HTTP Client (Remote Control, connect-per-request) ──────

/**
 * Send a single HTTP request to Unreal's Remote Control endpoint.
 * Mirrors tcpCommand's contract — connect → send → read JSON → close.
 *
 * Remote Control endpoints accept POST/PUT with JSON body; a GET is used
 * for read-only inventory (/remote/presets). We accept an explicit method
 * to let the URL translator (rc-url-translator.mjs) drive shape.
 *
 * @param {number} port
 * @param {string} method  - "GET" | "POST" | "PUT" | "DELETE"
 * @param {string} path    - e.g. "/remote/object/property"
 * @param {object|null} body
 * @param {number} timeoutMs
 * @returns {Promise<object>} parsed JSON response
 */
function httpCommand(port, method, path, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf-8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        ...(payload ? { 'Content-Length': payload.length } : {}),
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const status = res.statusCode || 0;
        if (status >= 200 && status < 300) {
          if (raw.length === 0) {
            // RC returns 200 + empty body on some write paths (e.g. PUT property).
            // Surface as success envelope so extractWireError treats it as non-error.
            resolve({ success: true });
            return;
          }
          try { resolve(JSON.parse(raw)); }
          catch { reject(new Error(`HTTP:${port} — invalid JSON response: ${raw.slice(0, 200)}`)); }
          return;
        }
        // Non-2xx → normalize to the error envelope shape the rest of the stack expects.
        // D66 + D24: extractWireError translates {success:false, message} consistently.
        let msg = `HTTP ${status}`;
        try {
          const parsed = JSON.parse(raw);
          if (parsed && (parsed.errorMessage || parsed.message || parsed.error)) {
            msg = parsed.errorMessage || parsed.message || parsed.error;
          }
        } catch {
          if (raw) msg = `HTTP ${status} — ${raw.slice(0, 200)}`;
        }
        resolve({ success: false, message: msg, _httpStatus: status });
      });
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`HTTP:${port} — timeout after ${timeoutMs}ms`));
    });
    req.on('error', (err) => reject(new Error(`HTTP:${port} — ${err.message}`)));
    if (payload) req.write(payload);
    req.end();
  });
}

// ── Result cache ────────────────────────────────────────────

class ResultCache {
  constructor(ttlMs = 5 * 60 * 1000) {
    this._ttlMs = ttlMs;
    /** @type {Map<string, {result: object, ts: number}>} */
    this._cache = new Map();
  }

  /** @param {string} type @param {object} params */
  key(type, params) {
    return createHash('sha256')
      .update(JSON.stringify({ type, params }))
      .digest('hex');
  }

  get(type, params) {
    const k = this.key(type, params);
    const entry = this._cache.get(k);
    if (!entry) return null;
    if (Date.now() - entry.ts > this._ttlMs) {
      this._cache.delete(k);
      return null;
    }
    return entry.result;
  }

  set(type, params, result) {
    this._cache.set(this.key(type, params), { result, ts: Date.now() });
  }

  clear() {
    this._cache.clear();
  }
}

// ── Command queue (serialize per-layer) ─────────────────────

class CommandQueue {
  constructor() {
    /** @type {Map<string, Promise<any>>} */
    this._queues = new Map();
  }

  /**
   * Enqueue a command for a given layer key. Commands on the same
   * layer execute sequentially; different layers execute in parallel.
   * @param {string} layerKey
   * @param {() => Promise<any>} fn
   * @returns {Promise<any>}
   */
  enqueue(layerKey, fn) {
    const prev = this._queues.get(layerKey) || Promise.resolve();
    const next = prev.then(fn, fn); // run even if previous rejected
    this._queues.set(layerKey, next);
    return next;
  }
}

// ── Wire-error extraction (P0-1) ────────────────────────────

/**
 * Normalize the three error-response formats produced by the frozen UnrealMCP
 * plugin (D23: deprecated post-Phase 3, no C++ fixes). Returns the error
 * message if the response indicates failure, or null if it represents success.
 *
 * Format 1 — Bridge envelope:   { status: "error", error|message: "..." }
 * Format 2 — CommonUtils flag:  { success: false, error|message: "..." }
 * Format 3 — UMG ad-hoc, wrapped by Bridge:
 *                               { status: "success", result: { error: "..." } }
 *            where result is effectively just the error payload (no other keys).
 *
 * Defensive extras (not in audit but cheap insurance against format drift):
 *   - Raw ad-hoc escaping Bridge entirely: { error: "..." } with no status/success.
 *   - Sibling error at success envelope:   { status: "success", error: "..." }.
 *
 * @param {any} result
 * @returns {string | null}
 */
function extractWireError(result) {
  if (!result || typeof result !== 'object') return null;

  const pickMsg = (o) =>
    (typeof o.error === 'string' && o.error) ||
    (typeof o.message === 'string' && o.message) ||
    'Unknown error from Unreal';

  // Format 1: explicit error status
  if (result.status === 'error') return pickMsg(result);

  // Format 2: success flag false
  if (result.success === false) return pickMsg(result);

  // Format 3: Bridge-wrapped ad-hoc — status:"success" with an error-only inner result.
  // Only one known shape in the wild (inner object has a single "error" key), but
  // we also accept any inner object whose only string-error value is "error" — this
  // matches D24's existing heuristic without over-matching legitimate payloads that
  // happen to carry an `error` field alongside real data.
  if (result.status === 'success' && result.result && typeof result.result === 'object') {
    const inner = result.result;
    const keys = Object.keys(inner);
    if (keys.length === 1 && keys[0] === 'error' && typeof inner.error === 'string') {
      return inner.error;
    }
  }

  // Defensive: sibling error at envelope level (status:"success" with a top-level error)
  if (result.status === 'success' && typeof result.error === 'string' && result.error) {
    return result.error;
  }

  // Defensive: raw ad-hoc with no envelope at all — only trigger when there is
  // literally nothing else indicating success. Avoids false positives on payloads
  // that legitimately include an `error` field as data.
  if (
    !('status' in result) &&
    !('success' in result) &&
    typeof result.error === 'string' &&
    result.error &&
    Object.keys(result).length === 1
  ) {
    return result.error;
  }

  return null;
}

// ── ConnectionManager ───────────────────────────────────────

export class ConnectionManager {
  /**
   * @param {object} config — from server.mjs config object
   */
  constructor(config) {
    this.config = config;

    /**
     * Test seam: inject a replacement for the real tcpCommand function.
     * Signature: (port, type, params, timeoutMs) => Promise<object>
     * When set, no real TCP connections are made — all TCP calls route here.
     * @type {((port: number, type: string, params: object, timeoutMs: number) => Promise<object>) | null}
     */
    this._tcpCommandFn = config.tcpCommandFn || null;

    /**
     * Test seam for HTTP (Layer 4 / Remote Control).
     * Signature: (port, method, path, body, timeoutMs) => Promise<object>
     * When set, no real HTTP requests are made — all HTTP calls route here.
     * @type {((port: number, method: string, path: string, body: object|null, timeoutMs: number) => Promise<object>) | null}
     */
    this._httpCommandFn = config.httpCommandFn || null;

    /** @type {Record<string, {status: string, lastCheck: number, error?: string}>} */
    this.layers = {
      'offline':    { status: LayerStatus.UNKNOWN, lastCheck: 0 },
      'tcp-55557':  { status: LayerStatus.UNKNOWN, lastCheck: 0 },
      'tcp-55558':  { status: LayerStatus.UNKNOWN, lastCheck: 0 },
      'http-30010': { status: LayerStatus.UNKNOWN, lastCheck: 0 },
    };

    this._cache = new ResultCache();
    this._queue = new CommandQueue();
    this._healthTtlMs = 30_000;

    this._detectedProject = null;

    /**
     * Resolved project root — may differ from config.projectRoot if the
     * configured path was a workspace root (no .uproject) and auto-resolve
     * found exactly one .uproject in a child directory.
     * Set by checkOfflineAvailable(). Consumers should prefer this over
     * config.projectRoot for file operations.
     * @type {string}
     */
    this.resolvedProjectRoot = config.projectRoot || '';

    /** @type {string|null} warning if auto-resolve changed the root */
    this.projectRootWarning = null;
  }

  // ── Layer status ────────────────────────────────────────

  /**
   * Check if a layer is available, using cached status if fresh enough.
   * @param {string} layerKey
   * @param {boolean} [force=false]
   * @returns {Promise<boolean>}
   */
  async isLayerAvailable(layerKey, force = false) {
    const layer = this.layers[layerKey];
    if (!layer) return false;

    const age = Date.now() - layer.lastCheck;
    if (!force && age < this._healthTtlMs && layer.status !== LayerStatus.UNKNOWN) {
      return layer.status === LayerStatus.AVAILABLE;
    }

    return await this._probeLayer(layerKey);
  }

  /**
   * @returns {object} Status snapshot of all layers
   */
  getStatus() {
    const out = {};
    for (const [key, info] of Object.entries(this.layers)) {
      out[key] = {
        status: info.status,
        error: info.error || null,
        lastCheck: info.lastCheck ? new Date(info.lastCheck).toISOString() : null,
      };
    }
    return out;
  }

  // ── Send command ────────────────────────────────────────

  /**
   * Send a command to the appropriate layer.
   * @param {string} layerKey  — 'tcp-55557', 'tcp-55558', 'http-30010'
   * @param {string} type      — command name
   * @param {object} params    — command parameters
   * @param {object} [opts]
   * @param {boolean} [opts.skipCache=false]
   * @returns {Promise<object>}
   */
  async send(layerKey, type, params = {}, opts = {}) {
    // Check cache first (read-ops only — write-ops should set skipCache)
    if (!opts.skipCache) {
      const cached = this._cache.get(type, params);
      if (cached) return cached;
    }

    return this._queue.enqueue(layerKey, async () => {
      let result;

      const tcpFn = this._tcpCommandFn || tcpCommand;

      if (layerKey === 'tcp-55557') {
        result = await tcpFn(
          this.config.tcpPortExisting,
          type,
          params,
          this.config.tcpTimeoutMs
        );
      } else if (layerKey === 'tcp-55558') {
        result = await tcpFn(
          this.config.tcpPortCustom,
          type,
          params,
          this.config.tcpTimeoutMs
        );
      } else if (layerKey === 'http-30010') {
        // D66 HYBRID: HTTP dispatch via `type` encoding {method, path} and params as body.
        // Tool handlers should prefer sendHttp() directly — this branch only exists
        // so the mock-seam wiring pattern (isLayerAvailable/probe) stays uniform.
        throw new Error(
          `send() does not dispatch HTTP — use sendHttp(method, path, body, opts) or the tool-layer rc-url-translator helper`
        );
      } else {
        throw new Error(`Unknown layer: ${layerKey}`);
      }

      // Normalize error responses — P0-1 (audit 2026-04-12). Three formats exist on the
      // wire; Bridge catches two, leaks the third as a success-wrapped payload. We defend
      // here because the plugin is frozen (D23: UnrealMCP deprecated post-Phase 3).
      //
      //   Format 1 (Bridge envelope): { status: "error", error|message: "msg" }
      //     → handler signaled error, Bridge rewrapped; direct status check
      //   Format 2 (CommonUtils):     { success: false, error|message: "msg" }
      //     → status absent but success=false; direct success check
      //   Format 3 (UMG ad-hoc):      { error: "msg" } (no status, no success)
      //     → Bridge wraps as: { status: "success", result: { error: "msg" } }
      //     → Also defend against the raw form escaping Bridge entirely and against
      //       status:"success" with a sibling error (belt-and-braces for format drift).
      const errMessage = extractWireError(result);
      if (errMessage !== null) {
        throw new Error(`${layerKey}: ${errMessage}`);
      }

      // Cache successful results
      if (!opts.skipCache) {
        this._cache.set(type, params, result);
      }

      // Mark layer as available (we just got a good response)
      this.layers[layerKey].status = LayerStatus.AVAILABLE;
      this.layers[layerKey].lastCheck = Date.now();
      this.layers[layerKey].error = undefined;

      return result;
    });
  }

  /**
   * Send an HTTP command to Layer 4 (Remote Control).
   * Shares ResultCache + CommandQueue with the TCP layers so reads cache
   * uniformly and HTTP requests to RC serialize (RC is not fully thread-safe
   * on concurrent writes to the same object per FA-ε §Q2.8).
   *
   * Cache key is derived from (method, path, body) — distinct from the TCP
   * key-shape (type, params) so there's no cross-layer collision.
   *
   * @param {string} method  "GET" | "POST" | "PUT" | "DELETE"
   * @param {string} path    e.g. "/remote/object/property"
   * @param {object|null} body
   * @param {object} [opts]
   * @param {boolean} [opts.skipCache=false]
   * @returns {Promise<object>}
   */
  async sendHttp(method, path, body = null, opts = {}) {
    const cacheType = `HTTP ${method} ${path}`;
    if (!opts.skipCache) {
      const cached = this._cache.get(cacheType, body || {});
      if (cached) return cached;
    }

    return this._queue.enqueue('http-30010', async () => {
      const httpFn = this._httpCommandFn || httpCommand;
      const port = this.config.rcPort || 30010;
      const timeoutMs = this.config.httpTimeoutMs || 5000;
      const result = await httpFn(port, method, path, body, timeoutMs);

      const errMessage = extractWireError(result);
      if (errMessage !== null) {
        throw new Error(`http-30010: ${errMessage}`);
      }

      if (!opts.skipCache) {
        this._cache.set(cacheType, body || {}, result);
      }
      this.layers['http-30010'].status = LayerStatus.AVAILABLE;
      this.layers['http-30010'].lastCheck = Date.now();
      this.layers['http-30010'].error = undefined;
      return result;
    });
  }

  // ── Auto-detection ──────────────────────────────────────

  /**
   * Detect which UE project is open by inspecting running processes.
   * Uses PowerShell on Windows to find UnrealEditor processes and
   * extract the .uproject path from command-line args.
   *
   * @returns {Promise<{project: string|null, pid: number|null, confidence: string}>}
   */
  async detectProject() {
    // TODO(noah): Auto-detection PowerShell command — review and test on your machine.
    // The command below inspects running UnrealEditor processes and extracts
    // the .uproject path. It may need adjustment for your UE install path or
    // if you have multiple editors open.
    try {
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      const execFileAsync = promisify(execFile);

      const { stdout } = await execFileAsync('powershell.exe', [
        '-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='UnrealEditor.exe'" | ` +
        `Select-Object ProcessId, CommandLine | ConvertTo-Json -Compress`
      ], { timeout: 10_000 });

      const raw = stdout.trim();
      if (!raw || raw === '' || raw === 'null') {
        return { project: null, pid: null, confidence: 'none' };
      }

      // PowerShell returns single object (not array) when exactly 1 match
      const procs = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : [JSON.parse(raw)];

      // Extract .uproject path from command line
      const results = [];
      for (const proc of procs) {
        const cmdLine = proc.CommandLine || '';
        // Match quoted or unquoted .uproject path
        const match = cmdLine.match(/["']?([A-Za-z]:[^"']*?\.uproject)["']?/i);
        if (match) {
          results.push({
            project: match[1].replace(/\\/g, '/'),
            pid: proc.ProcessId,
          });
        }
      }

      if (results.length === 0) {
        return { project: null, pid: null, confidence: 'none' };
      }

      // If configured project matches a running instance, prefer it
      if (this.config.projectRoot) {
        const configNorm = this.config.projectRoot.replace(/\\/g, '/').toLowerCase();
        const match = results.find(r =>
          r.project.toLowerCase().includes(configNorm.split('/').pop().replace('.uproject', ''))
        );
        if (match) {
          this._detectedProject = match.project;
          return { ...match, confidence: 'high' };
        }
      }

      // Otherwise return first result
      this._detectedProject = results[0].project;
      return { ...results[0], confidence: results.length === 1 ? 'high' : 'ambiguous' };

    } catch (err) {
      return { project: null, pid: null, confidence: 'error', error: err.message };
    }
  }

  get detectedProject() {
    return this._detectedProject;
  }

  // ── Offline layer ───────────────────────────────────────

  /**
   * Check if offline layer is usable.
   * Validates that resolvedProjectRoot contains a .uproject file.
   * If not, scans one level down to auto-resolve the correct UE project root
   * (handles the common case of pointing to a workspace root instead).
   * @returns {Promise<boolean>}
   */
  async checkOfflineAvailable() {
    if (!this.config.projectRoot) {
      this.layers['offline'].status = LayerStatus.UNAVAILABLE;
      this.layers['offline'].error = 'UNREAL_PROJECT_ROOT not set';
      this.layers['offline'].lastCheck = Date.now();
      return false;
    }

    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    // Check if the configured root exists
    try {
      await fs.access(this.config.projectRoot);
    } catch {
      this.layers['offline'].status = LayerStatus.UNAVAILABLE;
      this.layers['offline'].error = `Path not found: ${this.config.projectRoot}`;
      this.layers['offline'].lastCheck = Date.now();
      return false;
    }

    // Look for .uproject at the configured root
    const hasUproject = await this._findUprojectIn(fs, this.config.projectRoot);

    if (hasUproject) {
      // Configured root is correct
      this.resolvedProjectRoot = this.config.projectRoot;
      this.projectRootWarning = null;
      this.layers['offline'].status = LayerStatus.AVAILABLE;
      this.layers['offline'].lastCheck = Date.now();
      this.layers['offline'].error = undefined;
      return true;
    }

    // No .uproject at configured root — scan immediate children
    const resolved = await this._resolveProjectRoot(fs, path, this.config.projectRoot);

    if (resolved) {
      this.resolvedProjectRoot = resolved.root;
      this.projectRootWarning =
        `UNREAL_PROJECT_ROOT has no .uproject file. ` +
        `Auto-resolved to "${resolved.root}" (found ${resolved.uproject}). ` +
        `Consider updating UNREAL_PROJECT_ROOT in .mcp.json to point directly to the UE project root.`;
      process.stderr.write(`[uemcp] WARNING: ${this.projectRootWarning}\n`);
      this.layers['offline'].status = LayerStatus.AVAILABLE;
      this.layers['offline'].lastCheck = Date.now();
      this.layers['offline'].error = undefined;
      return true;
    }

    // No .uproject anywhere — fail with helpful error
    this.layers['offline'].status = LayerStatus.UNAVAILABLE;
    this.layers['offline'].error =
      `No .uproject file found at "${this.config.projectRoot}" or in immediate subdirectories. ` +
      `UNREAL_PROJECT_ROOT must point to the directory containing the .uproject file.`;
    this.layers['offline'].lastCheck = Date.now();
    return false;
  }

  /**
   * Check if a directory contains a .uproject file.
   * @returns {Promise<string|null>} the .uproject filename, or null
   */
  async _findUprojectIn(fs, dir) {
    try {
      const entries = await fs.readdir(dir);
      return entries.find(e => e.endsWith('.uproject')) || null;
    } catch {
      return null;
    }
  }

  /**
   * Scan immediate child directories for exactly one .uproject file.
   * Returns null if zero or multiple found (ambiguous).
   * @returns {Promise<{root: string, uproject: string}|null>}
   */
  async _resolveProjectRoot(fs, path, parentDir) {
    try {
      const entries = await fs.readdir(parentDir, { withFileTypes: true });
      const candidates = [];

      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const childDir = path.join(parentDir, entry.name);
        const uproject = await this._findUprojectIn(fs, childDir);
        if (uproject) {
          candidates.push({ root: childDir, uproject });
        }
      }

      // Only auto-resolve if exactly one match — ambiguity means user must choose
      return candidates.length === 1 ? candidates[0] : null;
    } catch {
      return null;
    }
  }

  // ── Private ─────────────────────────────────────────────

  async _probeLayer(layerKey) {
    const layer = this.layers[layerKey];
    layer.status = LayerStatus.CONNECTING;

    try {
      if (layerKey === 'offline') {
        return await this.checkOfflineAvailable();
      }

      const tcpFn = this._tcpCommandFn || tcpCommand;

      if (layerKey === 'tcp-55557') {
        await tcpFn(this.config.tcpPortExisting, 'ping', {}, 3000);
        layer.status = LayerStatus.AVAILABLE;
        layer.lastCheck = Date.now();
        layer.error = undefined;
        return true;
      }

      if (layerKey === 'tcp-55558') {
        await tcpFn(this.config.tcpPortCustom, 'ping', {}, 3000);
        layer.status = LayerStatus.AVAILABLE;
        layer.lastCheck = Date.now();
        layer.error = undefined;
        return true;
      }

      if (layerKey === 'http-30010') {
        // RC health check: HEAD/GET against /remote/presets (read-only, fast,
        // available on any RC install). Non-2xx or transport error → unavailable.
        const httpFn = this._httpCommandFn || httpCommand;
        const port = this.config.rcPort || 30010;
        try {
          const res = await httpFn(port, 'GET', '/remote/presets', null, 3000);
          // extractWireError handles the {success:false, _httpStatus} shape from httpCommand.
          if (extractWireError(res) !== null) {
            layer.status = LayerStatus.UNAVAILABLE;
            layer.error = `RC returned error shape: ${JSON.stringify(res).slice(0, 120)}`;
            layer.lastCheck = Date.now();
            return false;
          }
          layer.status = LayerStatus.AVAILABLE;
          layer.lastCheck = Date.now();
          layer.error = undefined;
          return true;
        } catch (err) {
          layer.status = LayerStatus.UNAVAILABLE;
          layer.error = err.message;
          layer.lastCheck = Date.now();
          return false;
        }
      }

      return false;
    } catch (err) {
      layer.status = LayerStatus.UNAVAILABLE;
      layer.error = err.message;
      layer.lastCheck = Date.now();
      return false;
    }
  }
}
