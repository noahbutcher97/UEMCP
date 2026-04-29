// Test helpers for UEMCP server testing
//
// Provides mock TCP responders for unit-testing tools without an editor.
// Injected via config.tcpCommandFn into ConnectionManager.

/**
 * FakeTcpResponder — queues canned responses and records all calls.
 *
 * Usage:
 *   const fake = new FakeTcpResponder();
 *   fake.on('list_actors', { status: 'success', actors: ['Cube', 'Light'] });
 *   fake.on('ping', { status: 'success' });
 *
 *   const connMgr = new ConnectionManager({ ...config, tcpCommandFn: fake.handler() });
 *   await connMgr.send('tcp-55557', 'list_actors', {});
 *
 *   console.log(fake.calls);  // [{ port: 55557, type: 'list_actors', params: {}, ts: ... }]
 */
export class FakeTcpResponder {
  constructor() {
    /** @type {Map<string, object|Function>} command type → response or response factory */
    this._responses = new Map();

    /** @type {{port: number, type: string, params: object, timeoutMs: number, ts: number}[]} */
    this.calls = [];

    /** Default response for unregistered commands */
    this._defaultResponse = null;
  }

  /**
   * Register a canned response for a command type.
   * @param {string} type — command name (e.g., 'list_actors', 'ping')
   * @param {object|Function} response — static object or (port, type, params) => object
   */
  on(type, response) {
    this._responses.set(type, response);
    return this; // chainable
  }

  /**
   * Set a default response for any command not explicitly registered.
   * @param {object|Function} response
   */
  onDefault(response) {
    this._defaultResponse = response;
    return this;
  }

  /**
   * Get the last call for a specific command type.
   * @param {string} type
   * @returns {{port: number, type: string, params: object, timeoutMs: number, ts: number}|undefined}
   */
  lastCall(type) {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      if (this.calls[i].type === type) return this.calls[i];
    }
    return undefined;
  }

  /**
   * Get all calls for a specific command type.
   * @param {string} type
   * @returns {{port: number, type: string, params: object, timeoutMs: number, ts: number}[]}
   */
  callsFor(type) {
    return this.calls.filter(c => c.type === type);
  }

  /** Reset recorded calls (but keep registered responses). */
  resetCalls() {
    this.calls = [];
  }

  /** Reset everything — calls and responses. */
  reset() {
    this.calls = [];
    this._responses.clear();
    this._defaultResponse = null;
  }

  /**
   * Returns the function to inject as config.tcpCommandFn.
   * @returns {(port: number, type: string, params: object, timeoutMs: number) => Promise<object>}
   */
  handler() {
    return async (port, type, params, timeoutMs) => {
      this.calls.push({ port, type, params, timeoutMs, ts: Date.now() });

      const response = this._responses.get(type) ?? this._defaultResponse;
      if (response === null || response === undefined) {
        throw new Error(`FakeTcpResponder: no response registered for "${type}"`);
      }

      // Support factory functions for dynamic responses
      if (typeof response === 'function') {
        return response(port, type, params);
      }
      // Return a deep copy so tests can't accidentally share state
      return JSON.parse(JSON.stringify(response));
    };
  }
}

/**
 * ErrorTcpResponder — simulates TCP failure modes.
 *
 * Usage:
 *   const errResp = new ErrorTcpResponder('timeout', 55557);
 *   const connMgr = new ConnectionManager({ ...config, tcpCommandFn: errResp.handler() });
 */
export class ErrorTcpResponder {
  /**
   * @param {'timeout'|'connection_refused'|'error_status'|'error_success_false'|'invalid_json'} mode
   * @param {number} [onlyPort] — if set, only errors on this port (others pass through to real TCP)
   */
  constructor(mode, onlyPort = null) {
    this.mode = mode;
    this.onlyPort = onlyPort;
    this.calls = [];
  }

  handler() {
    return async (port, type, params, timeoutMs) => {
      this.calls.push({ port, type, params, ts: Date.now() });

      if (this.onlyPort && port !== this.onlyPort) {
        // Pass-through: return a generic success (or chain to another handler)
        return { status: 'success' };
      }

      switch (this.mode) {
        case 'timeout':
          throw new Error(`TCP:${port} — timeout after ${timeoutMs}ms`);

        case 'connection_refused':
          throw new Error(`TCP:${port} — connect ECONNREFUSED 127.0.0.1:${port}`);

        case 'error_status':
          // Format 1: { status: "error", error: "msg" }
          return { status: 'error', error: `Simulated error on port ${port}` };

        case 'error_success_false':
          // Format 2: { success: false, message: "msg" }
          return { success: false, message: `Simulated failure on port ${port}` };

        case 'invalid_json':
          throw new Error(`TCP:${port} — invalid JSON response: <html>502 Bad Gateway</html>`);

        default:
          throw new Error(`ErrorTcpResponder: unknown mode "${this.mode}"`);
      }
    };
  }
}

/**
 * Assertion helper — provides better test output than raw if/else.
 */
export class TestRunner {
  constructor(name) {
    this.name = name;
    this.passed = 0;
    this.failed = 0;
    this.failures = [];
  }

  assert(condition, testName, detail) {
    if (condition) {
      console.log(`  ✓ ${testName}`);
      this.passed++;
    } else {
      const msg = detail ? `${testName}: ${detail}` : testName;
      console.error(`  ✗ ${msg}`);
      this.failed++;
      this.failures.push(msg);
    }
  }

  /** Assert that a promise rejects with an error matching the pattern. */
  async assertRejects(fn, pattern, testName) {
    try {
      await fn();
      this.assert(false, testName, 'expected rejection but resolved');
    } catch (e) {
      if (pattern instanceof RegExp) {
        this.assert(pattern.test(e.message), testName, `got: "${e.message}"`);
      } else {
        this.assert(e.message.includes(pattern), testName, `got: "${e.message}"`);
      }
    }
  }

  summary() {
    console.log(`\n═══ ${this.name} ═══`);
    console.log(`  Passed: ${this.passed}`);
    console.log(`  Failed: ${this.failed}`);
    console.log(`  Total:  ${this.passed + this.failed}`);
    if (this.failures.length > 0) {
      console.log(`\n  Failures:`);
      for (const f of this.failures) console.log(`  ✗ ${f}`);
    }
    return this.failed;
  }
}

/**
 * Standard test config factory — creates a config object with a FakeTcpResponder wired in.
 * @param {string} projectRoot
 * @param {FakeTcpResponder} [fakeResponder] — if omitted, creates one with 'ping' registered
 * @returns {{ config: object, fake: FakeTcpResponder }}
 */
export function createTestConfig(projectRoot, fakeResponder) {
  const fake = fakeResponder || new FakeTcpResponder().on('ping', { status: 'success' });
  const config = {
    projectRoot,
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,  // legacy alias — kept so existing tests don't churn
    rcPort: 30010,    // canonical (D66) — matches server.mjs
    tcpTimeoutMs: 5000,
    httpTimeoutMs: 5000,
    tcpCommandFn: fake.handler(),
  };
  return { config, fake };
}

/**
 * FakeHttpResponder — canned responses for Remote Control HTTP calls.
 *
 * Mirrors FakeTcpResponder's contract. Responses are keyed by a string
 * `"${method} ${path}"` (e.g. "GET /remote/presets").
 *
 * Usage:
 *   const rc = new FakeHttpResponder();
 *   rc.on('PUT /remote/object/property', { success: true });
 *   rc.on('GET /remote/presets', { Presets: [] });
 *
 *   const conn = new ConnectionManager({ ...config, httpCommandFn: rc.handler() });
 *   await conn.sendHttp('PUT', '/remote/object/property', {...});
 */
export class FakeHttpResponder {
  constructor() {
    this._responses = new Map();
    /** @type {{port: number, method: string, path: string, body: object|null, ts: number}[]} */
    this.calls = [];
    this._defaultResponse = null;
  }

  /**
   * Register a canned response for a method+path key.
   * @param {string} key — e.g. "PUT /remote/object/property"
   * @param {object|Function} response — static object or (port, method, path, body) => object
   */
  on(key, response) {
    this._responses.set(key, response);
    return this;
  }

  onDefault(response) {
    this._defaultResponse = response;
    return this;
  }

  lastCall(key) {
    for (let i = this.calls.length - 1; i >= 0; i--) {
      const c = this.calls[i];
      if (`${c.method} ${c.path}` === key) return c;
    }
    return undefined;
  }

  callsFor(key) {
    return this.calls.filter(c => `${c.method} ${c.path}` === key);
  }

  resetCalls() {
    this.calls = [];
  }

  reset() {
    this.calls = [];
    this._responses.clear();
    this._defaultResponse = null;
  }

  handler() {
    return async (port, method, path, body, timeoutMs) => {
      this.calls.push({ port, method, path, body, ts: Date.now() });
      const key = `${method} ${path}`;
      const response = this._responses.get(key) ?? this._defaultResponse;
      if (response === null || response === undefined) {
        throw new Error(`FakeHttpResponder: no response registered for "${key}"`);
      }
      if (typeof response === 'function') {
        return response(port, method, path, body);
      }
      return JSON.parse(JSON.stringify(response));
    };
  }
}
