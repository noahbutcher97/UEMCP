// Test helpers for UEMCP server testing
//
// Provides guarded scratch roots and mock responders for tests without an editor.
// Injected via config.tcpCommandFn into ConnectionManager.

import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { readdir } from 'node:fs/promises';

function validateScratchPrefix(prefix) {
  if (typeof prefix !== 'string' || !/^uemcp[A-Za-z0-9 ._-]{0,96}$/i.test(prefix)) {
    throw new Error('canonical scratch root prefix must be a bounded UEMCP label');
  }
}

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function canonicalFixturePath(path) {
  return resolve(realpathSync.native(resolve(path)));
}

export function createCanonicalScratchRoot(prefix, { parentRoot = tmpdir() } = {}) {
  validateScratchPrefix(prefix);
  const canonicalParent = canonicalFixturePath(parentRoot);
  const root = join(canonicalParent, `${prefix}${randomUUID()}`);
  mkdirSync(root);
  return canonicalFixturePath(root);
}

export function cleanupCanonicalScratchRoot(root, prefix, { parentRoot = tmpdir() } = {}) {
  validateScratchPrefix(prefix);
  const canonicalParent = canonicalFixturePath(parentRoot);
  const requested = resolve(root);
  let requestedStat;
  try {
    requestedStat = lstatSync(requested);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const lexicalParent = resolve(parentRoot);
    if (!basename(requested).startsWith(prefix)
      || (!contained(lexicalParent, requested) && !contained(canonicalParent, requested))) {
      throw new Error(`refusing to clean unexpected path: ${root}`);
    }
    return;
  }
  if (!requestedStat.isDirectory() || requestedStat.isSymbolicLink()) {
    throw new Error(`refusing to clean unexpected path: ${root}`);
  }
  const canonicalRoot = canonicalFixturePath(requested);
  if (!contained(canonicalParent, canonicalRoot) || !basename(canonicalRoot).startsWith(prefix)) {
    throw new Error(`refusing to clean unexpected path: ${root}`);
  }
  rmSync(canonicalRoot, { recursive: true, force: true });
}

// Unit fixtures using this helper must not exercise coordinator contention.
export async function uncontendedTestLeaseCoordinator(callback) {
  if (typeof callback !== 'function') throw new TypeError('test lease callback is required');
  return callback();
}

/**
 * FakeTcpResponder — queues canned responses and records all calls.
 *
 * Usage:
 *   const fake = new FakeTcpResponder();
 *   fake.on('list_actors', { status: 'success', actors: ['Cube', 'Light'] });
 *   fake.on('ping', { status: 'success' });
 *
 *   const connMgr = new ConnectionManager({ ...config, tcpCommandFn: fake.handler() });
 *   await connMgr.send('tcp-55558', 'list_actors', {});
 *
 *   console.log(fake.calls);  // [{ port: 55558, type: 'list_actors', params: {}, ts: ... }]
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
 *   const errResp = new ErrorTcpResponder('timeout', 55558);
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

export function createAnimGraphTopologyFixture({ includePinDefaults = false } = {}) {
  const nodeGuid = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const inputPinId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
  const outputPinId = 'cccccccccccccccccccccccccccccccc';
  const parentPinId = 'dddddddddddddddddddddddddddddddd';
  const childPinId = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
  const pin = ({ id, name, direction, linkedTo = [], parentId = null, subpinIds = [] }) => {
    const value = {
      pin_id: id,
      name,
      direction,
      pin_category: 'pose',
      pin_subcategory: '',
      pin_type: { category: 'pose', subcategory: '', container: 'None' },
      type: { category: 'pose', subcategory: '', container: 'None' },
      is_subpin: parentId !== null,
      parent_pin_id: parentId,
      subpin_ids: subpinIds,
      sub_pin_ids: subpinIds,
      orphaned: false,
      linked_to: linkedTo,
      link_count: linkedTo.length,
    };
    if (includePinDefaults) {
      value.defaults = {
        default_value: '',
        autogenerated_default_value: '',
        default_object: null,
        default_text_value: '',
      };
    }
    return value;
  };
  const dropped = {
    null_graph_count: 0,
    null_referenced_graph_count: 0,
    null_node_count: 0,
    null_node_graph_count: 0,
    mismatched_node_graph_count: 0,
    null_pin_count: 0,
    null_pin_owner_count: 0,
    mismatched_pin_owner_count: 0,
    dangling_parent_pin_count: 0,
    dangling_subpin_count: 0,
    null_linked_pin_count: 0,
    null_linked_owner_count: 0,
    dangling_link_count: 0,
    orphan_pin_count: 0,
    duplicate_graph_key_count: 0,
    duplicate_node_key_count: 0,
    duplicate_pin_key_count: 0,
    invalid_node_guid_count: 0,
    invalid_pin_guid_count: 0,
    null_nodes: 0,
    null_pins: 0,
    null_linked_pins: 0,
    dangling_links: 0,
    orphaned_pins: 0,
    duplicate_graph_keys: 0,
    duplicate_node_guids: 0,
    duplicate_pin_ids: 0,
  };

  return {
    schema_version: 'anim-uedgraph-pin-topology-v1',
    id_format: 'digits',
    complete: true,
    truncated: false,
    includes_pin_defaults: includePinDefaults,
    graph_count: 1,
    node_count: 1,
    pin_count: 4,
    link_entry_count: 1,
    edge_count: 1,
    graphs: {
      AnimGraph: {
        graph_key: 'AnimGraph',
        graph_guid: '11111111111111111111111111111111',
        name: 'AnimGraph',
        path: '/Game/Anim/ABP_Test.ABP_Test:AnimGraph',
        class_name: 'AnimationGraph',
        schema_class: 'AnimationGraphSchema',
        graph_type: 'anim_graph',
        sources: ['get_all_graphs'],
        node_count: 1,
        nodes: {
          [nodeGuid]: {
            graph_key: 'AnimGraph',
            node_guid: nodeGuid,
            class_name: 'AnimGraphNode_Root',
            title: 'Output Pose',
            x: 0,
            y: 0,
            pin_count: 4,
            pins: {
              [inputPinId]: pin({
                id: inputPinId,
                name: 'Result',
                direction: 'EGPD_Input',
                linkedTo: [{
                  graph_key: 'AnimGraph',
                  node_guid: nodeGuid,
                  pin_id: outputPinId,
                  pin_name: 'Source',
                }],
              }),
              [outputPinId]: pin({ id: outputPinId, name: 'Source', direction: 'EGPD_Output' }),
              [parentPinId]: pin({
                id: parentPinId,
                name: 'Transform',
                direction: 'EGPD_Input',
                subpinIds: [childPinId],
              }),
              [childPinId]: pin({
                id: childPinId,
                name: 'Location',
                direction: 'EGPD_Input',
                parentId: parentPinId,
              }),
            },
          },
        },
      },
    },
    dropped,
  };
}

// Absolute path to the committed text fixture (resolved from THIS file's
// location, not cwd), used as the default project root for tests when
// UNREAL_PROJECT_ROOT is unset. A real project always wins.
const FIXTURE_PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'uemcp-fixture');

/**
 * Resolve the project root for tests: a non-empty UNREAL_PROJECT_ROOT, else the
 * committed fixture. Mirrors the trim() the test files used to apply inline.
 * @returns {string}
 */
export function resolveProjectRoot() {
  const env = (process.env.UNREAL_PROJECT_ROOT || '').trim();
  return env || FIXTURE_PROJECT_ROOT;
}

// Directories that are either not real content (UE's per-user scratch space)
// or generated mirror trees for actor/object instances — walking into them
// wastes time and can never contain the hand-authored probe assets tests key
// off of.
const SKIPPED_CONTENT_DIRS = new Set(['Developers', '__ExternalActors__', '__ExternalObjects__']);

// Upper bound on directories visited during a findContentAsset() walk. Real
// projects (post-exclusions) run in the low thousands; this is a generous
// multiple so a pathological corpus fails fast instead of hanging test
// startup rather than silently under-searching a normal one.
const MAX_CONTENT_DIR_VISITS = 20000;

/**
 * Locate a file by exact name anywhere under `<projectRoot>/Content/`, so
 * tests can resolve a probe asset's current location instead of hardcoding
 * a path that goes stale when content gets reorganized.
 *
 * Skips Developers/, __ExternalActors__/, __ExternalObjects__/ at any depth
 * and stops after MAX_CONTENT_DIR_VISITS directories (bounded cost). Returns
 * the first match found (directory-walk order — callers should only rely on
 * this for filenames expected to be unique in the project).
 *
 * @param {string} projectRoot
 * @param {string} fileName — e.g. 'BP_OSPlayerR.uasset'
 * @returns {Promise<{gamePath: string, diskPath: string, gameDir: string}|null>} null when
 *   Content/ is missing or the file isn't found (e.g. the committed fixture,
 *   which ships no Content/ tree at all). gameDir is gamePath's parent
 *   /Game/ directory (no trailing slash) — e.g. corpus-scan callers that
 *   need "wherever this probe's folder currently is" instead of the file's
 *   own path.
 */
export async function findContentAsset(projectRoot, fileName) {
  const contentRoot = join(projectRoot, 'Content');
  let dirVisits = 0;
  let warnedCap = false;
  let warnedReaddirError = false;

  async function walk(dir) {
    if (dirVisits++ >= MAX_CONTENT_DIR_VISITS) {
      if (!warnedCap) {
        warnedCap = true;
        console.warn(
          `findContentAsset: hit MAX_CONTENT_DIR_VISITS (${MAX_CONTENT_DIR_VISITS}) while searching for "${fileName}" — search may be incomplete`
        );
      }
      return null;
    }
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (err) {
      if (err && err.code !== 'ENOENT' && !warnedReaddirError) {
        warnedReaddirError = true;
        console.warn(`findContentAsset: readdir failed for "${dir}" (${err.code})`);
      }
      return null; // missing/unreadable — treat as empty
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIPPED_CONTENT_DIRS.has(entry.name)) continue;
        const found = await walk(join(dir, entry.name));
        if (found) return found;
      } else if (entry.name === fileName) {
        return join(dir, entry.name);
      }
    }
    return null;
  }

  const diskPath = await walk(contentRoot);
  if (!diskPath) return null;

  const relFromContent = relative(contentRoot, diskPath).split(sep).join('/');
  const gamePath = '/Game/' + relFromContent.replace(/\.[^./]+$/, '');
  const gameDir = gamePath.slice(0, gamePath.lastIndexOf('/'));
  return { gamePath, diskPath, gameDir };
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
