// ConnectionManager — manages connections to current UEMCP layers
//
// Layers:
//   offline    — always available if projectRoot is set
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
import { PROJECT_ERROR_CODES } from './project-errors.mjs';

// ── Layer status ────────────────────────────────────────────

/** @enum {string} */
const LayerStatus = {
  UNKNOWN:      'unknown',       // never probed
  AVAILABLE:    'available',     // last health check passed
  UNAVAILABLE:  'unavailable',   // last health check failed
  CONNECTING:   'connecting',    // probe in progress
};

const ACTIVE_LAYER_KEYS = Object.freeze(['offline', 'tcp-55558', 'http-30010']);

// ── TCP Client (connect-per-command) ────────────────────────

/**
 * Detect length-framed response. Sniffs first bytes for "Content-Length:" prefix
 * (case-insensitive). When framed, returns { framed: true, headerLen, bodyLen }.
 * When unframed (legacy parse-loop path), returns { framed: false }.
 * Used for backwards-compat: an old plugin still emitting unframed JSON parses
 * via the legacy path; a new plugin with framing parses via the framed path.
 *
 * @param {Buffer} buf - accumulated bytes
 * @returns {{framed: true, headerLen: number, bodyLen: number} | {framed: false} | {framed: 'pending'}}
 */
function _detectResponseFraming(buf) {
  if (buf.length < 'Content-Length:'.length) {
    return { framed: 'pending' };  // not enough bytes to decide
  }
  const prefix = buf.slice(0, 'Content-Length:'.length).toString('utf-8').toLowerCase();
  if (!prefix.startsWith('content-length:')) {
    return { framed: false };
  }
  // Search for "\r\n\r\n" terminator within first 512 bytes.
  const headerSearch = buf.slice(0, Math.min(buf.length, 512)).toString('utf-8');
  const terminatorIdx = headerSearch.indexOf('\r\n\r\n');
  if (terminatorIdx === -1) {
    return { framed: 'pending' };  // header not yet complete
  }
  const headerBlock = headerSearch.slice(0, terminatorIdx);
  const colonIdx = headerBlock.indexOf(':');
  if (colonIdx === -1) {
    return { framed: false };  // malformed; fall back to legacy parse
  }
  const lenStr = headerBlock.slice(colonIdx + 1).trim();
  const bodyLen = parseInt(lenStr, 10);
  if (!Number.isFinite(bodyLen) || bodyLen < 0) {
    return { framed: false };
  }
  return { framed: true, headerLen: terminatorIdx + 4, bodyLen };
}

/**
 * Send a single command over TCP using the UEMCP protocol.
 * Opens socket → sends JSON → reads until valid JSON → closes socket.
 *
 * E-1 §1: outgoing requests are length-framed. Incoming response framing is
 * auto-detected so older deployed UEMCP builds
 * that emit plain JSON continue to parse during upgrade windows.
 *
 * E-1 §6 (EN-23): if `metrics` is provided, per-phase timings are recorded.
 *
 * @param {number} port
 * @param {string} type    - command name (the "type" field, NOT "command")
 * @param {object} params
 * @param {number} timeoutMs
 * @param {{record: (entry: object) => void} | null} [metrics] - optional metrics sink
 * @returns {Promise<object>} parsed JSON response
 */
function tcpCommand(port, type, params, timeoutMs, metrics = null) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    let tConnected = 0n;
    let tSent = 0n;
    let tFirstByte = 0n;
    let tParsed = 0n;

    const socket = net.createConnection({ port, host: '127.0.0.1' });
    /** @type {Buffer[]} */
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    /** @type {{framed: boolean | 'pending', headerLen?: number, bodyLen?: number}} */
    let framing = { framed: 'pending' };

    const finish = (err, result) => {
      if (settled) return;
      settled = true;
      socket.destroy();

      // E-1 §6 (EN-23): emit metrics if a sink was provided. Done at finish time
      // so timeouts / errors get recorded too (with whichever phase timings are valid).
      if (metrics && typeof metrics.record === 'function') {
        const tEnd = process.hrtime.bigint();
        const ns = (a, b) => (a && b ? Number(b - a) / 1e6 : null);  // ns→ms
        metrics.record({
          port,
          type,
          ok: !err,
          err: err ? err.message : null,
          framed: framing.framed === true,
          bytes: totalBytes,
          connect_ms: ns(t0, tConnected),
          send_ms: ns(tConnected, tSent),
          first_byte_ms: ns(tSent, tFirstByte),
          response_ms: ns(tFirstByte, tParsed),
          total_ms: ns(t0, tEnd),
        });
      }

      if (err) reject(err);
      else resolve(result);
    };

    socket.setTimeout(timeoutMs);

    socket.on('connect', () => {
      tConnected = process.hrtime.bigint();
      const body = JSON.stringify({ type, params: params || {} });
      // E-1 §1: emit Content-Length-framed request to the UEMCP plugin.
      const bodyBuf = Buffer.from(body, 'utf-8');
      const headerBuf = Buffer.from(`Content-Length: ${bodyBuf.length}\r\n\r\n`, 'utf-8');
      socket.write(Buffer.concat([headerBuf, bodyBuf]));
      tSent = process.hrtime.bigint();
    });

    socket.on('data', (chunk) => {
      if (tFirstByte === 0n) tFirstByte = process.hrtime.bigint();
      chunks.push(chunk);
      totalBytes += chunk.length;
      const buf = Buffer.concat(chunks);

      if (framing.framed === 'pending') {
        framing = _detectResponseFraming(buf);
      }

      if (framing.framed === true) {
        // Framed path: wait until we have header + full body, then parse body only.
        if (buf.length >= framing.headerLen + framing.bodyLen) {
          const body = buf.slice(framing.headerLen, framing.headerLen + framing.bodyLen).toString('utf-8');
          try {
            const parsed = JSON.parse(body);
            tParsed = process.hrtime.bigint();
            finish(null, parsed);
          } catch (e) {
            finish(new Error(`TCP:${port} — invalid JSON in framed body (Content-Length=${framing.bodyLen}): ${body.slice(0, 200)}`));
          }
        }
        // else: keep reading.
        return;
      }

      if (framing.framed === false) {
        // Legacy path: try to parse whatever's accumulated.
        const raw = buf.toString('utf-8');
        try {
          const parsed = JSON.parse(raw);
          tParsed = process.hrtime.bigint();
          finish(null, parsed);
        } catch {
          // Incomplete JSON, keep reading
        }
      }
      // framing === 'pending' — keep reading until we can decide.
    });

    socket.on('end', () => {
      if (!settled) {
        const buf = Buffer.concat(chunks);
        if (buf.length === 0) {
          finish(new Error(`TCP:${port} — connection closed with no response`));
          return;
        }
        // If still pending or framed but incomplete, treat as malformed.
        if (framing.framed === true && buf.length < framing.headerLen + framing.bodyLen) {
          finish(new Error(`TCP:${port} — connection closed with incomplete framed body (got ${buf.length}, expected ${framing.headerLen + framing.bodyLen})`));
          return;
        }
        // Last-resort parse for legacy/unknown shape.
        const raw = framing.framed === true
          ? buf.slice(framing.headerLen, framing.headerLen + framing.bodyLen).toString('utf-8')
          : buf.toString('utf-8');
        try {
          tParsed = process.hrtime.bigint();
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

// E-1 §1: export the framing detector for focused response-parser tests.
export { _detectResponseFraming };

// ── HTTP Client (Remote Control, connect-per-request) ──────

/**
 * Build the headers object for a Remote Control HTTP request.
 *
 * The `Passphrase` header is mandatory under D130: UE 5.6.1's WebRemoteControl
 * plugin has a single-line bug at WebRemoteControl.cpp:930 that uses
 * `TMap::operator[]` on the request-headers map without a prior `.Find()`. When
 * the Passphrase key is absent, operator[] auto-inserts it; a downstream
 * `FindChecked()` at Map.h:716 then asserts and crashes the editor on
 * /remote/batch. RC's permissive-auth mode in editor accepts any non-empty
 * string, so the value is irrelevant — we just need the key present. Applied
 * uniformly to all /remote/* paths as defense-in-depth (audit memory:
 * feedback_passphrase_header_gotcha.md).
 *
 * Exported for unit tests so the contract can be asserted without intercepting
 * node:http. Not used elsewhere; httpCommand is the only production caller.
 *
 * @param {number} [contentLength] - byte length of the JSON payload, if any
 * @returns {Record<string, string|number>}
 */
export function _buildRcHeaders(contentLength) {
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
    'Passphrase': 'uemcp',
  };
  if (contentLength != null) headers['Content-Length'] = contentLength;
  return headers;
}

/**
 * Send a single HTTP request to Unreal's Remote Control endpoint.
 * Mirrors tcpCommand's contract — connect → send → read JSON → close.
 *
 * Remote Control endpoints accept POST/PUT with JSON body; a GET is used
 * for read-only inventory (/remote/presets). We accept an explicit method
 * to let the URL translator (rc-url-translator.mjs) drive shape.
 *
 * Optional `agent` is used by the NEW-2 mitigation flag UEMCP_RC_RECYCLE_AFTER_N
 * (see ConnectionManager). When `undefined` the call goes through Node's default
 * globalAgent (keepAlive:false) — this is the historic / default-OFF behavior.
 *
 * @param {number} port
 * @param {string} method  - "GET" | "POST" | "PUT" | "DELETE"
 * @param {string} path    - e.g. "/remote/object/property"
 * @param {object|null} body
 * @param {number} timeoutMs
 * @param {http.Agent} [agent] - optional explicit http.Agent (NEW-2 recycle path)
 * @returns {Promise<object>} parsed JSON response
 */
function httpCommand(port, method, path, body, timeoutMs, agent) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf-8');
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method,
      headers: _buildRcHeaders(payload ? payload.length : undefined),
      timeout: timeoutMs,
      ...(agent ? { agent } : {}),
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

// ── Metrics aggregator (EN-23) ──────────────────────────────

/**
 * MetricsAggregator — EN-23 instrumentation collector.
 *
 * Records per-call wire-phase timings + cache layer + error rates. Default-OFF:
 * if `emitEveryN` is 0 AND `logPath` is empty, every record() call is a no-op
 * cheap-counter bump (no allocation, no formatting). Operator enables via env
 * vars `UEMCP_METRICS_EMIT_EVERY_N` (stderr) and `UEMCP_METRICS_LOG` (JSONL file).
 *
 * Schema per record(): { port, type, ok, err, framed, bytes, connect_ms, send_ms,
 *   first_byte_ms, response_ms, total_ms } — phases may be null if the call
 *   short-circuited before reaching that phase.
 *
 * Aggregated stderr summary shape:
 *   { window_n, total_n, avg_total_ms, p50_total_ms, p95_total_ms, max_total_ms,
 *     framed_count, error_count, by_type: { [type]: { n, avg_ms, errors } } }
 *
 * This is the single sink that both `tcpCommand` (per-call timings) and
 * ConnectionManager (cache hits/misses) feed into. Tests pass a mock aggregator
 * with a synchronous flush() to assert shape without timing dependencies.
 */
export class MetricsAggregator {
  constructor({ emitEveryN = 0, logPath = '' } = {}) {
    this.emitEveryN = emitEveryN | 0;
    this.logPath = logPath;
    this._enabled = this.emitEveryN > 0 || !!this.logPath;
    /** @type {Array<object>} per-call records since last flush */
    this._window = [];
    this._totalN = 0;
    this._cacheHits = 0;
    this._cacheMisses = 0;
    /** @type {import('node:fs').WriteStream | null} */
    this._logStream = null;
  }

  /**
   * Whether instrumentation is active. tcpCommand short-circuits its hrtime
   * captures when this returns false, eliminating per-call overhead in the
   * default-OFF case.
   */
  isEnabled() {
    return this._enabled;
  }

  /** Record a per-call metrics row. Cheap when disabled. */
  record(entry) {
    if (!this._enabled) return;
    this._totalN++;
    this._window.push(entry);

    // Append to JSONL log file if configured (best-effort; no throw on write error).
    if (this.logPath) {
      this._lazyOpenLog();
      try {
        if (this._logStream) this._logStream.write(JSON.stringify(entry) + '\n');
      } catch { /* swallow — telemetry must never crash the server */ }
    }

    // Emit aggregate summary every N records.
    if (this.emitEveryN > 0 && this._window.length >= this.emitEveryN) {
      this.flush();
    }
  }

  recordCacheHit() { if (this._enabled) this._cacheHits++; }
  recordCacheMiss() { if (this._enabled) this._cacheMisses++; }

  /** Compute + emit aggregate summary; clears window. Synchronous. */
  flush() {
    if (!this._enabled || this._window.length === 0) return null;
    const summary = this._computeSummary();
    process.stderr.write(`[uemcp-metrics] ${JSON.stringify(summary)}\n`);
    this._window = [];
    return summary;
  }

  _computeSummary() {
    const totals = this._window.map((r) => r.total_ms).filter((x) => x != null).sort((a, b) => a - b);
    const errors = this._window.filter((r) => !r.ok).length;
    const framedCount = this._window.filter((r) => r.framed).length;
    const byType = {};
    for (const r of this._window) {
      if (!byType[r.type]) byType[r.type] = { n: 0, sum_ms: 0, errors: 0 };
      byType[r.type].n++;
      if (r.total_ms != null) byType[r.type].sum_ms += r.total_ms;
      if (!r.ok) byType[r.type].errors++;
    }
    for (const t of Object.keys(byType)) {
      byType[t].avg_ms = byType[t].n > 0 ? byType[t].sum_ms / byType[t].n : 0;
      delete byType[t].sum_ms;
    }
    const pct = (xs, p) => (xs.length === 0 ? null : xs[Math.min(xs.length - 1, Math.floor(xs.length * p))]);
    return {
      window_n: this._window.length,
      total_n: this._totalN,
      cache_hits: this._cacheHits,
      cache_misses: this._cacheMisses,
      avg_total_ms: totals.length > 0 ? totals.reduce((a, b) => a + b, 0) / totals.length : null,
      p50_total_ms: pct(totals, 0.5),
      p95_total_ms: pct(totals, 0.95),
      max_total_ms: totals.length > 0 ? totals[totals.length - 1] : null,
      framed_count: framedCount,
      error_count: errors,
      by_type: byType,
    };
  }

  _lazyOpenLog() {
    if (this._logStream || !this.logPath) return;
    // Lazy import keeps startup cost zero when metrics are disabled.
    import('node:fs').then((fs) => {
      try { this._logStream = fs.createWriteStream(this.logPath, { flags: 'a' }); }
      catch { this._logStream = null; }
    }).catch(() => { this._logStream = null; });
  }
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
 * Normalize the supported error-response formats. Returns error metadata if
 * the response indicates failure, or null if it represents success.
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
 * @returns {{message: string, code?: string, detail?: any, raw?: object} | null}
 */
function extractWireError(result) {
  if (!result || typeof result !== 'object') return null;

  const metadataKeys = new Set(['error', 'message', 'code', 'error_code', 'errorCode', 'detail', 'details', 'data']);
  const buildWireError = (o) => {
    const wireError = {
      message:
        (typeof o.error === 'string' && o.error) ||
        (typeof o.message === 'string' && o.message) ||
        'Unknown error from Unreal',
      raw: o,
    };
    const code = (
      (typeof o.code === 'string' && o.code) ||
      (typeof o.error_code === 'string' && o.error_code) ||
      (typeof o.errorCode === 'string' && o.errorCode) ||
      null
    );
    if (code) {
      wireError.code = code;
    }
    if ('detail' in o) {
      wireError.detail = o.detail;
    } else if ('details' in o) {
      wireError.detail = o.details;
    } else if ('data' in o) {
      wireError.detail = o.data;
    }
    return wireError;
  };
  const isMetadataOnlyErrorObject = (o) =>
    o &&
    typeof o === 'object' &&
    ((typeof o.error === 'string' && o.error) || (typeof o.message === 'string' && o.message)) &&
    Object.keys(o).every((key) => metadataKeys.has(key));

  // Format 1: explicit error status
  if (result.status === 'error') return buildWireError(result);

  // Format 2: success flag false
  if (result.success === false) return buildWireError(result);

  // Format 3: Bridge-wrapped ad-hoc — status:"success" with an error-only inner result.
  // Only one known shape in the wild (inner object has a single "error" key), but
  // we also accept any inner object whose only string-error value is "error" — this
  // matches D24's existing heuristic without over-matching legitimate payloads that
  // happen to carry an `error` field alongside real data.
  if (result.status === 'success' && result.result && typeof result.result === 'object') {
    const inner = result.result;
    if (isMetadataOnlyErrorObject(inner)) {
      return buildWireError(inner);
    }
  }

  // Defensive: sibling error at envelope level (status:"success" with a top-level error)
  if (result.status === 'success' && typeof result.error === 'string' && result.error) {
    return buildWireError(result);
  }

  // Defensive: raw ad-hoc with no envelope at all — only trigger when there is
  // literally nothing else indicating success. Avoids false positives on payloads
  // that legitimately include an `error` field as data.
  if (
    !('status' in result) &&
    !('success' in result) &&
    typeof result.error === 'string' &&
    result.error &&
    isMetadataOnlyErrorObject(result)
  ) {
    return buildWireError(result);
  }

  return null;
}

function unknownCommandHint(wireError) {
  if (wireError.code !== 'UNKNOWN_COMMAND') return '';
  return ' Next action: call find_tools to locate the public wrapper, or inspect tools.yaml wire_type mappings; do not use raw TCP command names as the primary workflow.';
}

function makeLayerWireError(layerKey, wireError, wireResponse) {
  const err = new Error(`${layerKey}: ${wireError.message}${unknownCommandHint(wireError)}`);
  err.layer = layerKey;
  err.wireError = wireError;
  err.wireResponse = wireResponse;
  if (wireError.code) {
    err.code = wireError.code;
  }
  if ('detail' in wireError) {
    err.detail = wireError.detail;
  }
  return err;
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
      'tcp-55558':  { status: LayerStatus.UNKNOWN, lastCheck: 0 },
      'http-30010': { status: LayerStatus.UNKNOWN, lastCheck: 0 },
    };

    this._cache = new ResultCache();
    this._queue = new CommandQueue();
    this._healthTtlMs = 30_000;

    // E-1 §6 (EN-23): metrics aggregator. Default-OFF — no overhead unless
    // operator sets UEMCP_METRICS_EMIT_EVERY_N or UEMCP_METRICS_LOG.
    this._metrics = new MetricsAggregator({
      emitEveryN: config.metricsEmitEveryN || 0,
      logPath: config.metricsLogPath || '',
    });

    // ── NEW-2 RC HTTP mitigation flags (D118 / D122) ──────────
    // All three mitigations are additive and OFF-by-default. With every flag
    // unset the sendHttp path is observationally identical to pre-NEW-2-mitigation
    // behavior (no agent, no rate-cap wait, no warning). Flags are honored only
    // for un-cached, actually-dispatched HTTP calls — cached reads do not count
    // toward the NEW-2 ceiling because they never hit the editor.
    //
    // Mitigation #1 — UEMCP_RC_RECYCLE_AFTER_N: force-fresh socket every N RC
    // calls. Implemented by attaching an explicit http.Agent({keepAlive:true})
    // and destroying / re-creating it every N calls. NOTE: enabling this flag
    // ALSO flips on keep-alive socket pooling for RC HTTP — historic default
    // (no agent, no keep-alive) only applies when the flag is unset.
    /** @type {number} 0 = disabled */
    this._rcRecycleAfterN = config.rcRecycleAfterN || 0;
    /** @type {http.Agent | null} */
    this._rcAgent = null;
    /** @type {number} resets to 0 on each recycle */
    this._rcCallsSinceRecycle = 0;
    /** @type {number} cumulative count of recycle events; getter is the test observable */
    this._rcRecycleCount = 0;

    // Mitigation #2 — UEMCP_RC_RATE_CAP: token-bucket rate-cap (calls/sec).
    // Bucket capacity = rate (1 second of headroom). sendHttp blocks via
    // setTimeout when the bucket is empty until enough tokens have refilled.
    /** @type {number} calls per second; 0 = disabled */
    this._rcRateCap = config.rcRateCap || 0;
    /** @type {number} */
    this._rcTokens = this._rcRateCap;
    /** @type {number} */
    this._rcLastRefillTs = Date.now();

    // Mitigation #3 — UEMCP_RC_RELAUNCH_HINT_AFTER_N: stderr warning at N RC
    // calls. Once-per-session (idempotent within the server process). The
    // counter is cumulative and never resets — server restart correlates with
    // editor relaunch and is the natural reset boundary.
    /** @type {number} 0 = disabled */
    this._rcRelaunchHintAfterN = config.rcRelaunchHintAfterN || 0;
    /** @type {boolean} */
    this._rcRelaunchHintFired = false;
    /** @type {number} cumulative dispatched (un-cached) RC HTTP call count */
    this._rcCallCount = 0;

    this._detectedProject = null;
    this._attachedProjectIdentity = null;

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
   * Update the session's active Unreal project root and clear cached layer
   * state. ProjectContext owns when this is called; ConnectionManager owns
   * transport/cache state for the active attachment.
   * @param {string} projectRoot
   */
  resetForProjectRoot(projectRoot = '') {
    this.setAttachedProject(projectRoot ? { projectRoot } : null);
    this.resetProjectScopedState({ reason: 'resetForProjectRoot' });
  }

  /**
   * Set the active ProjectContext identity for transport/file operations.
   * @param {object|null} identityOrNull
   */
  setAttachedProject(identityOrNull) {
    this._attachedProjectIdentity = identityOrNull || null;
    const projectRoot = this._attachedProjectIdentity?.projectRoot || '';
    this.config.projectRoot = projectRoot;
    this.resolvedProjectRoot = projectRoot;
    this.projectRootWarning = null;
  }

  /**
   * @returns {string}
   */
  getAttachedProjectRoot() {
    return this._attachedProjectIdentity?.projectRoot || this.resolvedProjectRoot || this.config.projectRoot || '';
  }

  /**
   * Clear project-scoped connection state after an attachment generation change.
   * @param {{generation?: number, reason?: string, resetMetrics?: boolean}} _options
   */
  resetProjectScopedState(_options = {}) {
    this._cache.clear();
    for (const layer of Object.values(this.layers)) {
      layer.status = LayerStatus.UNKNOWN;
      layer.lastCheck = 0;
      delete layer.error;
    }
    this._detectedProject = null;
    if (this._rcAgent) {
      this._rcAgent.destroy();
      this._rcAgent = null;
    }
    this._rcCallsSinceRecycle = 0;
    this._rcTokens = this._rcRateCap;
    this._rcLastRefillTs = Date.now();
    this._rcRelaunchHintFired = false;
    if (_options.resetMetrics && this._metrics?.reset) {
      this._metrics.reset();
    }
  }

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
    return this._statusSnapshot(Object.keys(this.layers));
  }

  /**
   * @returns {object} Status snapshot of current active UEMCP layers.
   */
  getActiveStatus() {
    return this._statusSnapshot(ACTIVE_LAYER_KEYS);
  }

  /**
   * Force-probe only current active UEMCP layers.
   */
  async probeActiveLayers() {
    await Promise.all(ACTIVE_LAYER_KEYS.map(layerKey => this.isLayerAvailable(layerKey, true)));
  }

  _statusSnapshot(layerKeys) {
    const out = {};
    for (const key of layerKeys) {
      const info = this.layers[key];
      if (!info) continue;
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
   * @param {string} layerKey  — 'tcp-55558', 'http-30010'
   * @param {string} type      — command name
   * @param {object} params    — command parameters
   * @param {object} [opts]
   * @param {boolean} [opts.skipCache=false]
   * @param {number} [opts.timeoutMs] — per-call wire timeout override; defaults to config.tcpTimeoutMs
   * @returns {Promise<object>}
   */
  async send(layerKey, type, params = {}, opts = {}) {
    // Check cache first (read-ops only — write-ops should set skipCache)
    if (!opts.skipCache) {
      const cached = this._cache.get(type, params);
      if (cached) {
        this._metrics.recordCacheHit();
        return cached;
      }
      this._metrics.recordCacheMiss();
    }

    // Per-call timeout override (D118 sharpening #1 — bind_widget_event /
    // set_text_block_binding need 10s under PIE because their self-compile
    // path runs ~5.6s wall-clock; the default 5s wire timeout fires before
    // the handler returns).
    const timeoutMs = opts.timeoutMs ?? this.config.tcpTimeoutMs;

    return this._queue.enqueue(layerKey, async () => {
      let result;

      const tcpFn = this._tcpCommandFn || tcpCommand;
      // E-1 §6 (EN-23): pass the metrics sink only when enabled. Mock seam
      // (config.tcpCommandFn) ignores extra args so test fixtures don't break.
      const metrics = this._metrics.isEnabled() ? this._metrics : null;

      if (layerKey === 'tcp-55558') {
        result = await tcpFn(
          this.config.tcpPortCustom,
          type,
          params,
          timeoutMs,
          metrics
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
      // wire; the bridge catches two and leaks the third as a success-wrapped payload.
      //
      //   Format 1 (Bridge envelope): { status: "error", error|message: "msg" }
      //     → handler signaled error, Bridge rewrapped; direct status check
      //   Format 2 (CommonUtils):     { success: false, error|message: "msg" }
      //     → status absent but success=false; direct success check
      //   Format 3 (UMG ad-hoc):      { error: "msg" } (no status, no success)
      //     → Bridge wraps as: { status: "success", result: { error: "msg" } }
      //     → Also defend against the raw form escaping Bridge entirely and against
      //       status:"success" with a sibling error (belt-and-braces for format drift).
      const wireError = extractWireError(result);
      if (wireError !== null) {
        throw makeLayerWireError(layerKey, wireError, result);
      }

      // Cache successful results
      if (!opts.skipCache) {
        this._cache.set(type, params, result);
      }
      this._invalidateReadCacheOnWrite(opts);

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

      // NEW-2 mitigation #2 — rate-cap (wait for a token before dispatch).
      if (this._rcRateCap > 0) {
        await this._rcConsumeToken();
      }

      // NEW-2 mitigation #1 — recycle agent every N un-cached calls.
      // First call lazily creates the agent; subsequent recycles destroy + recreate.
      if (this._rcRecycleAfterN > 0) {
        if (this._rcAgent === null || this._rcCallsSinceRecycle >= this._rcRecycleAfterN) {
          this._recycleRcAgent();
        }
        this._rcCallsSinceRecycle++;
      }

      // NEW-2 mitigation #3 — fire relaunch hint once when cumulative count crosses N.
      this._rcCallCount++;
      if (
        !this._rcRelaunchHintFired &&
        this._rcRelaunchHintAfterN > 0 &&
        this._rcCallCount >= this._rcRelaunchHintAfterN
      ) {
        process.stderr.write(
          `[uemcp] WARNING: ${this._rcCallCount} RC HTTP calls accumulated since last editor relaunch — NEW-2 ceiling approaching. Consider relaunching editor + restarting MCP server. Per CLAUDE.md §Operational Limits.\n`
        );
        this._rcRelaunchHintFired = true;
      }

      // Pass the agent only when the recycle flag is on. When the mock seam
      // (config.httpCommandFn) is in use, the agent argument is ignored.
      const result = await httpFn(port, method, path, body, timeoutMs, this._rcAgent || undefined);

      const wireError = extractWireError(result);
      if (wireError !== null) {
        throw makeLayerWireError('http-30010', wireError, result);
      }

      if (!opts.skipCache) {
        this._cache.set(cacheType, body || {}, result);
      }
      this._invalidateReadCacheOnWrite(opts);
      this.layers['http-30010'].status = LayerStatus.AVAILABLE;
      this.layers['http-30010'].lastCheck = Date.now();
      this.layers['http-30010'].error = undefined;
      return result;
    });
  }

  /**
   * W6 (D165): clear the read cache after a successful write-op.
   *
   * A write-op (skipCache:true, set from `!def.isReadOp`) may have mutated
   * editor state that cached read-ops now misrepresent — e.g. inspect_blueprint
   * cached, add_event_node mutates the BP, inspect_blueprint then returns the
   * stale pre-mutation cache (D126 audit Class I.2). Clearing makes the next
   * read re-fetch.
   *
   * Broad by design: clears ALL read entries (TCP + RC share `_cache`), not just
   * related ones. The surgical per-tool declarative `invalidates:` refinement is
   * deferred (docs/handoffs/w6-cache-invalidation.md); EN-23 metrics will reveal
   * if the hit-rate cost ever warrants it. Fires only on success (after the
   * wire-error check), so a failed write does not churn the cache.
   */
  _invalidateReadCacheOnWrite(opts) {
    if (opts && opts.skipCache) this._cache.clear();
  }

  // ── NEW-2 mitigation helpers ────────────────────────────

  /**
   * Destroy the current keep-alive agent (if any) and create a fresh one.
   * Resets the per-recycle call counter. The fresh agent has keepAlive:true
   * so socket reuse within a recycle window is fast.
   */
  _recycleRcAgent() {
    if (this._rcAgent) {
      try { this._rcAgent.destroy(); } catch { /* defensive — Agent.destroy never throws but be safe */ }
    }
    this._rcAgent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    this._rcCallsSinceRecycle = 0;
    this._rcRecycleCount++;
  }

  /**
   * Token-bucket consumer for mitigation #2. Refills at config.rcRateCap
   * tokens/sec, capacity = rcRateCap (1 second of headroom). When the bucket
   * is empty, waits via setTimeout for the time required to refill 1 token.
   * Bucket math is run inside the per-layer command queue so concurrent
   * sendHttp callers do not race; this method is only called when rcRateCap > 0.
   */
  async _rcConsumeToken() {
    const rate = this._rcRateCap;
    const now = Date.now();
    const elapsedSec = (now - this._rcLastRefillTs) / 1000;
    this._rcTokens = Math.min(rate, this._rcTokens + elapsedSec * rate);
    this._rcLastRefillTs = now;

    if (this._rcTokens < 1) {
      const waitMs = Math.ceil(((1 - this._rcTokens) / rate) * 1000);
      await new Promise((r) => setTimeout(r, waitMs));
      const now2 = Date.now();
      const elapsed2 = (now2 - this._rcLastRefillTs) / 1000;
      this._rcTokens = Math.min(rate, this._rcTokens + elapsed2 * rate);
      this._rcLastRefillTs = now2;
    }
    this._rcTokens -= 1;
  }

  /**
   * NEW-2 observability — number of RC agent recycle events since process start.
   * 0 means either the flag is disabled or no calls have been dispatched yet.
   * Used by tests; production code may consume for diagnostics.
   * @returns {number}
   */
  getRcRecycleCount() {
    return this._rcRecycleCount;
  }

  /**
   * NEW-2 observability — cumulative un-cached RC HTTP call count since process start.
   * Cached reads do not increment. Reset only by server restart.
   * @returns {number}
   */
  getRcCallCount() {
    return this._rcCallCount;
  }

  /**
   * E-1 §6 (EN-23) observability — metrics aggregator handle. Tests use this to
   * assert per-call shape + flush() behavior; production code may consume for
   * diagnostics. Always present (default-OFF aggregator is a no-op cheap counter).
   * @returns {MetricsAggregator}
   */
  getMetrics() {
    return this._metrics;
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
  async checkOfflineAvailable(projectRoot = this.getAttachedProjectRoot()) {
    if (projectRoot) {
      this.setAttachedProject({ ...(this._attachedProjectIdentity || {}), projectRoot });
    }

    if (!projectRoot) {
      this.layers['offline'].status = LayerStatus.UNAVAILABLE;
      this.layers['offline'].error = PROJECT_ERROR_CODES.PROJECT_NOT_ATTACHED;
      this.layers['offline'].lastCheck = Date.now();
      return false;
    }

    const fs = await import('node:fs/promises');
    const path = await import('node:path');

    // Check if the configured root exists
    try {
      await fs.access(projectRoot);
    } catch {
      this.layers['offline'].status = LayerStatus.UNAVAILABLE;
      this.layers['offline'].error = `Path not found: ${projectRoot}`;
      this.layers['offline'].lastCheck = Date.now();
      return false;
    }

    // Look for .uproject at the configured root
    const hasUproject = await this._findUprojectIn(fs, projectRoot);

    if (hasUproject) {
      // Configured root is correct
      this.setAttachedProject({ ...(this._attachedProjectIdentity || {}), projectRoot });
      this.projectRootWarning = null;
      this.layers['offline'].status = LayerStatus.AVAILABLE;
      this.layers['offline'].lastCheck = Date.now();
      this.layers['offline'].error = undefined;
      return true;
    }

    // No .uproject at configured root — scan immediate children
    const resolved = await this._resolveProjectRoot(fs, path, projectRoot);

    if (resolved) {
      this.setAttachedProject({ ...(this._attachedProjectIdentity || {}), projectRoot: resolved.root });
      this.projectRootWarning =
        `Attached project root has no .uproject file. ` +
        `Auto-resolved to "${resolved.root}" (found ${resolved.uproject}). ` +
        `Attach the direct project root or add the .uproject path to .uemcp-targets.json for future sessions.`;
      process.stderr.write(`[uemcp] WARNING: ${this.projectRootWarning}\n`);
      this.layers['offline'].status = LayerStatus.AVAILABLE;
      this.layers['offline'].lastCheck = Date.now();
      this.layers['offline'].error = undefined;
      return true;
    }

    // No .uproject anywhere — fail with helpful error
    this.layers['offline'].status = LayerStatus.UNAVAILABLE;
    this.layers['offline'].error =
      `No .uproject file found at "${projectRoot}" or in immediate subdirectories. ` +
      `Attach a directory containing exactly one .uproject file, or attach the .uproject path directly.`;
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
