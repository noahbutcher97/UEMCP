// ConnectionManager — manages connections to all 4 layers
//
// Layers:
//   offline    — always available if projectRoot is set
//   tcp-55557  — existing UnrealMCP plugin (Phase 2)
//   tcp-55558  — new UEMCP plugin (Phase 3)
//   http-30010 — Remote Control API (Phase 4)
//
// Design:
//   - Lazy connect: don't probe until first tool call needs a layer
//   - Health check caching with 30s TTL
//   - Connect-per-command for TCP (matches existing plugin behavior)
//   - Command queue: one in-flight command per TCP layer
//   - Test seam: config.tcpCommandFn replaces real TCP for unit tests

import net from 'node:net';
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
        // Phase 4 — HTTP proxy to Remote Control API
        throw new Error(`HTTP layer not implemented yet`);
      } else {
        throw new Error(`Unknown layer: ${layerKey}`);
      }

      // Normalize error responses (three formats exist — see conformance-oracle-contracts.md)
      //
      //   Format 1 (Bridge envelope): { status: "error", error: "msg" }
      //     → Bridge detected the handler error and rewrapped it
      //   Format 2 (CommonUtils):     { success: false, error: "msg" }
      //     → Bridge detects success:false and converts to Format 1
      //   Format 3 (UMG ad-hoc):      { error: "msg" } (no success field)
      //     → Bridge does NOT detect this — it wraps as:
      //       { status: "success", result: { error: "msg" } }
      //
      // Format 1 & 2 are caught by the first two checks.
      // Format 3 arrives as a "success" with error buried in result.
      // We detect it by checking: status is "success", result is an object with
      // ONLY an "error" field and no other data fields.
      if (result && (
        result.status === 'error' ||
        result.success === false
      )) {
        const msg = result.error || result.message || 'Unknown error from Unreal';
        throw new Error(`${layerKey}: ${msg}`);
      }

      // Format 3: ad-hoc error wrapped by Bridge as success
      // { status: "success", result: { error: "msg" } } where result has no other keys
      if (result && result.status === 'success' && result.result &&
          typeof result.result === 'object' && typeof result.result.error === 'string') {
        const resultKeys = Object.keys(result.result);
        if (resultKeys.length === 1 && resultKeys[0] === 'error') {
          throw new Error(`${layerKey}: ${result.result.error}`);
        }
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
   * Check if offline layer is usable (i.e., projectRoot exists on disk).
   * @returns {Promise<boolean>}
   */
  async checkOfflineAvailable() {
    if (!this.config.projectRoot) {
      this.layers['offline'].status = LayerStatus.UNAVAILABLE;
      this.layers['offline'].error = 'UNREAL_PROJECT_ROOT not set';
      this.layers['offline'].lastCheck = Date.now();
      return false;
    }
    try {
      const fs = await import('node:fs/promises');
      await fs.access(this.config.projectRoot);
      this.layers['offline'].status = LayerStatus.AVAILABLE;
      this.layers['offline'].lastCheck = Date.now();
      this.layers['offline'].error = undefined;
      return true;
    } catch {
      this.layers['offline'].status = LayerStatus.UNAVAILABLE;
      this.layers['offline'].error = `Path not found: ${this.config.projectRoot}`;
      this.layers['offline'].lastCheck = Date.now();
      return false;
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
        // Phase 4 — HTTP health check
        layer.status = LayerStatus.UNAVAILABLE;
        layer.error = 'HTTP layer not implemented yet';
        layer.lastCheck = Date.now();
        return false;
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
