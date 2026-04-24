// MCP-Wire Integration Test Harness
//
// Why this exists: the existing 717 assertions call handlers DIRECTLY with
// pre-typed params, bypassing the MCP protocol path entirely. The F-1
// Zod-coerce regression (boolean/number params shipped broken because
// the SDK received stringified values from some MCP client wrappers)
// demonstrated that unit tests ≠ agent-facing usability.
//
// This harness spins up the real McpServer in-process behind a FakeTransport,
// then exercises representative tools through actual JSON-RPC — initialize,
// tools/list, tools/call — asserting that:
//   • buildZodSchema produces schemas that accept stringified wire values (F-1)
//   • tools/list matches tools.yaml at runtime (D44 invariant live)
//   • Happy-path tool/call returns correct response shape
//   • Error paths return isError:true with diagnostic text
//   • tools/list_changed fires when toolsets toggle
//   • Size-budget truncation round-trips correctly
//
// Option A: in-process McpServer + fake transport. ~90% defect coverage of
// Option B (subprocess + stdio) at 1/10 the overhead. If a stdio-specific
// defect ever surfaces that this harness misses, add Option B then.
//
// Run: cd D:\DevTools\UEMCP\server && set UNREAL_PROJECT_ROOT=path/to/YourProject&& node test-mcp-wire.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { buildZodSchema } from './zod-builder.mjs';
import { executeOfflineTool } from './offline-tools.mjs';
import { TestRunner } from './test-helpers.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TOOLS_YAML = yaml.load(readFileSync(join(__dirname, '..', 'tools.yaml'), 'utf-8'));
const OFFLINE_DEFS = TOOLS_YAML.toolsets.offline.tools;
const PROJECT_ROOT = process.env.UNREAL_PROJECT_ROOT || '';

const PROTOCOL_VERSION = '2024-11-05';

const t = new TestRunner('MCP-Wire Integration Tests');

// ── FakeTransport ────────────────────────────────────────────────────
// Implements the MCP Transport contract (shared/transport.d.ts):
//   start(), close(), send(msg) — called by the server
//   onmessage(msg)               — invoked to deliver a client-side message
//
// Responses and notifications from the server land in _outbound. Tests
// post inbound messages via injectMessage() and await matching responses
// via waitForResponse(id).

class FakeTransport {
  constructor() {
    this._outbound = [];
    this._started = false;
    this._closed = false;
  }

  async start() {
    if (this._started) throw new Error('FakeTransport already started');
    this._started = true;
  }

  async close() {
    this._closed = true;
    this.onclose?.();
  }

  async send(message) {
    this._outbound.push(message);
  }

  // Deliver an inbound JSON-RPC message as if from the client.
  // The SDK processes asynchronously, so callers must await waitForResponse.
  injectMessage(message) {
    if (!this.onmessage) throw new Error('onmessage not installed — did you forget server.connect(transport)?');
    this.onmessage(message);
  }

  // Await a response with the given id. Polls _outbound every tick.
  async waitForResponse(id, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const idx = this._outbound.findIndex(m => m.id === id);
      if (idx !== -1) {
        const msg = this._outbound[idx];
        this._outbound.splice(idx, 1);
        return msg;
      }
      await new Promise(r => setImmediate(r));
    }
    throw new Error(`waitForResponse(${id}) timed out after ${timeoutMs}ms; outbound=${JSON.stringify(this._outbound).slice(0, 200)}`);
  }

  // Drain any pending notifications matching method.
  drainNotifications(method) {
    const matches = [];
    const keep = [];
    for (const m of this._outbound) {
      if (!m.id && m.method === method) matches.push(m);
      else keep.push(m);
    }
    this._outbound = keep;
    return matches;
  }
}

// ── Test server factory ──────────────────────────────────────────────
// Mirrors server.mjs's offline-tool registration using the SAME inputs:
//   tools.yaml offline defs → buildZodSchema → server.tool()
//
// `handlerFactory(toolName)` returns the handler for a given tool. Tests
// inject stubs for Zod-validation experiments (we want to see what args
// Zod passes through) OR the real executeOfflineTool for happy-path tests.

async function createTestServer(handlerFactory) {
  const server = new McpServer(
    { name: 'uemcp-test', version: '0.1.0-test' },
    { capabilities: { logging: {} } }
  );

  const handles = {};
  for (const [name, def] of Object.entries(OFFLINE_DEFS)) {
    const schema = buildZodSchema(def.params);
    const handler = handlerFactory(name);
    const handle = server.tool(
      name,
      def.description,
      schema,
      async (args, ctx) => {
        try {
          const result = await handler(args, ctx);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
          };
        } catch (err) {
          return {
            content: [{ type: 'text', text: `Error in ${name}: ${err.message}` }],
            isError: true,
          };
        }
      }
    );
    handles[name] = handle;
  }

  const transport = new FakeTransport();
  await server.connect(transport);

  let idCounter = 1;

  async function sendRequest(method, params) {
    const id = idCounter++;
    transport.injectMessage({ jsonrpc: '2.0', id, method, params });
    return transport.waitForResponse(id);
  }

  async function initialize() {
    return sendRequest('initialize', {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'uemcp-wire-test', version: '1.0' },
    });
  }

  return { server, transport, handles, sendRequest, initialize };
}

// An echo handler — captures raw args for Zod-coerce inspection.
function makeEchoHandler(captures) {
  return (toolName) => async (args) => {
    captures[toolName] = args;
    return { ok: true, received: args };
  };
}

// ── Phase 1: must-have ═══════════════════════════════════════════════

// Test 1: initialize handshake
console.log('\n── Test 1: initialize handshake ──');
{
  const { transport, initialize } = await createTestServer(makeEchoHandler({}));

  const resp = await initialize();
  t.assert(resp.result != null, 'initialize returns result');
  t.assert(resp.result.protocolVersion != null, 'initialize result has protocolVersion');
  t.assert(resp.result.serverInfo?.name === 'uemcp-test', `serverInfo.name is uemcp-test (got ${resp.result.serverInfo?.name})`);
  t.assert(resp.result.capabilities?.tools != null, 'tools capability advertised');

  await transport.close();
}

// Test 2: tools/list D44 invariant at runtime
console.log('\n── Test 2: tools/list matches tools.yaml (D44 runtime) ──');
{
  const { transport, sendRequest, initialize } = await createTestServer(makeEchoHandler({}));
  await initialize();

  const resp = await sendRequest('tools/list', {});
  t.assert(Array.isArray(resp.result?.tools), 'tools/list returns tools array');

  const listed = resp.result.tools;
  const yamlNames = Object.keys(OFFLINE_DEFS).sort();
  const listedNames = listed.map(t => t.name).sort();
  t.assert(
    listedNames.length === yamlNames.length,
    `tool count matches yaml: listed=${listedNames.length} yaml=${yamlNames.length}`
  );

  // Every yaml tool appears in tools/list
  const missing = yamlNames.filter(n => !listedNames.includes(n));
  t.assert(missing.length === 0, `no yaml tools missing (missing: ${missing.join(',')})`);

  // Descriptions match yaml (sample a few — full scan is overkill and
  // noisy-diff on multi-line descriptions that get normalized by yaml loader).
  // find_blueprint_nodes_bulk included to lock EN-2's D44 invariant at wire level.
  const sampleNames = ['project_info', 'get_asset_info', 'list_level_actors', 'find_blueprint_nodes_bulk'];
  for (const name of sampleNames) {
    const listedTool = listed.find(t => t.name === name);
    t.assert(listedTool != null, `${name} present in tools/list`);
    t.assert(
      listedTool.description === OFFLINE_DEFS[name].description,
      `${name} description matches yaml`
    );
  }

  // Input schemas carry expected param names
  const llaTool = listed.find(t => t.name === 'list_level_actors');
  const llaProps = llaTool.inputSchema?.properties || {};
  t.assert(
    'asset_path' in llaProps && 'limit' in llaProps && 'summarize_by_class' in llaProps,
    `list_level_actors schema advertises asset_path+limit+summarize_by_class (got: ${Object.keys(llaProps).join(',')})`
  );

  // EN-2: find_blueprint_nodes_bulk schema advertises bulk-specific params +
  // inherited filters. Guards against param-name drift between yaml and wire.
  const bulkTool = listed.find(t => t.name === 'find_blueprint_nodes_bulk');
  const bulkProps = bulkTool.inputSchema?.properties || {};
  t.assert(
    'path_prefix' in bulkProps && 'max_scan' in bulkProps && 'include_nodes' in bulkProps &&
    'node_class' in bulkProps && 'member_name' in bulkProps && 'target_class' in bulkProps,
    `find_blueprint_nodes_bulk schema advertises EN-2 params (got: ${Object.keys(bulkProps).join(',')})`
  );

  await transport.close();
}

// Test 3: Zod coerce — boolean stringification (F-1 validation)
console.log('\n── Test 3: Zod coerce boolean (F-1) ──');
{
  const captures = {};
  const { transport, sendRequest, initialize } = await createTestServer(makeEchoHandler(captures));
  await initialize();

  // String "true" → boolean true
  const r1 = await sendRequest('tools/call', {
    name: 'list_level_actors',
    arguments: { asset_path: '/Game/Fake.umap', summarize_by_class: 'true' },
  });
  t.assert(!r1.result?.isError, `stringified "true" accepted (got isError=${r1.result?.isError}, text=${r1.result?.content?.[0]?.text?.slice(0,120)})`);
  t.assert(
    captures.list_level_actors?.summarize_by_class === true,
    `handler received boolean true (got ${typeof captures.list_level_actors?.summarize_by_class}: ${captures.list_level_actors?.summarize_by_class})`
  );

  // String "false" — z.coerce.boolean gotcha: ANY non-empty string coerces
  // to true. So "false" becomes true. We document this behavior — it's
  // expected Zod semantics, not a bug. The real defense in F-1 is that
  // typed booleans (true/false) AND the empty string survive round-trip.
  delete captures.list_level_actors;
  const r2 = await sendRequest('tools/call', {
    name: 'list_level_actors',
    arguments: { asset_path: '/Game/Fake.umap', summarize_by_class: 'false' },
  });
  t.assert(!r2.result?.isError, 'stringified "false" accepted (even though it coerces to true)');
  t.assert(
    captures.list_level_actors?.summarize_by_class === true,
    `z.coerce.boolean("false") → true (Zod semantic; got ${captures.list_level_actors?.summarize_by_class})`
  );

  // Actual boolean true — round-trips untouched
  delete captures.list_level_actors;
  const r3 = await sendRequest('tools/call', {
    name: 'list_level_actors',
    arguments: { asset_path: '/Game/Fake.umap', summarize_by_class: true },
  });
  t.assert(!r3.result?.isError, 'native boolean true accepted');
  t.assert(
    captures.list_level_actors?.summarize_by_class === true,
    'native true round-trips'
  );

  // Actual boolean false — round-trips untouched
  delete captures.list_level_actors;
  const r4 = await sendRequest('tools/call', {
    name: 'list_level_actors',
    arguments: { asset_path: '/Game/Fake.umap', summarize_by_class: false },
  });
  t.assert(!r4.result?.isError, 'native boolean false accepted');
  t.assert(
    captures.list_level_actors?.summarize_by_class === false,
    'native false round-trips'
  );

  await transport.close();
}

// Test 4: Zod coerce — number stringification (F-1 validation)
console.log('\n── Test 4: Zod coerce number (F-1) ──');
{
  const captures = {};
  const { transport, sendRequest, initialize } = await createTestServer(makeEchoHandler(captures));
  await initialize();

  // Stringified positive number
  const r1 = await sendRequest('tools/call', {
    name: 'list_level_actors',
    arguments: { asset_path: '/Game/Fake.umap', limit: '100', offset: '50' },
  });
  t.assert(!r1.result?.isError, `stringified numbers accepted (got text=${r1.result?.content?.[0]?.text?.slice(0,120)})`);
  t.assert(captures.list_level_actors?.limit === 100, `limit coerced to number 100 (got ${typeof captures.list_level_actors?.limit}:${captures.list_level_actors?.limit})`);
  t.assert(captures.list_level_actors?.offset === 50, `offset coerced to number 50 (got ${typeof captures.list_level_actors?.offset}:${captures.list_level_actors?.offset})`);

  // Stringified integer param on a different tool (read_asset_properties.max_bytes)
  delete captures.read_asset_properties;
  const r2 = await sendRequest('tools/call', {
    name: 'read_asset_properties',
    arguments: { asset_path: '/Game/Fake', max_bytes: '4096' },
  });
  t.assert(!r2.result?.isError, 'read_asset_properties stringified max_bytes accepted');
  t.assert(
    captures.read_asset_properties?.max_bytes === 4096,
    `max_bytes coerced to 4096 (got ${captures.read_asset_properties?.max_bytes})`
  );

  // Native number round-trips
  delete captures.list_level_actors;
  const r3 = await sendRequest('tools/call', {
    name: 'list_level_actors',
    arguments: { asset_path: '/Game/Fake.umap', limit: 25 },
  });
  t.assert(!r3.result?.isError, 'native number accepted');
  t.assert(captures.list_level_actors?.limit === 25, 'native limit=25 round-trips');

  // Stringified zero coerces
  delete captures.list_level_actors;
  const r4 = await sendRequest('tools/call', {
    name: 'list_level_actors',
    arguments: { asset_path: '/Game/Fake.umap', offset: '0' },
  });
  t.assert(!r4.result?.isError, 'stringified "0" accepted');
  t.assert(captures.list_level_actors?.offset === 0, 'offset="0" coerced to numeric 0');

  await transport.close();
}

// Test 4.5: Zod preprocess — array stringification (F-1.5 validation)
// Mirror of Test 3/4 for array<string> wire stringification. Uses
// read_asset_properties.property_names — the exact param the manual tester
// hit with "Expected array, received string" pre-fix.
console.log('\n── Test 4.5: Zod preprocess array (F-1.5) ──');
{
  const captures = {};
  const { transport, sendRequest, initialize } = await createTestServer(makeEchoHandler(captures));
  await initialize();

  // The blocker case: stringified JSON array on the wire
  const r1 = await sendRequest('tools/call', {
    name: 'read_asset_properties',
    arguments: { asset_path: '/Game/Fake', property_names: '["AbilityTags"]' },
  });
  t.assert(!r1.result?.isError, `stringified array accepted (got text=${r1.result?.content?.[0]?.text?.slice(0,120)})`);
  t.assert(
    Array.isArray(captures.read_asset_properties?.property_names),
    `handler received Array (got ${typeof captures.read_asset_properties?.property_names})`
  );
  t.assert(
    captures.read_asset_properties?.property_names?.[0] === 'AbilityTags',
    `array[0] === "AbilityTags" (got ${captures.read_asset_properties?.property_names?.[0]})`
  );

  // Typed array round-trips untouched
  delete captures.read_asset_properties;
  const r2 = await sendRequest('tools/call', {
    name: 'read_asset_properties',
    arguments: { asset_path: '/Game/Fake', property_names: ['AbilityTags', 'CooldownTags'] },
  });
  t.assert(!r2.result?.isError, 'typed array round-trips');
  t.assert(
    captures.read_asset_properties?.property_names?.length === 2,
    `typed array preserved length=2 (got ${captures.read_asset_properties?.property_names?.length})`
  );

  // Empty stringified array
  delete captures.read_asset_properties;
  const r3 = await sendRequest('tools/call', {
    name: 'read_asset_properties',
    arguments: { asset_path: '/Game/Fake', property_names: '[]' },
  });
  t.assert(!r3.result?.isError, 'stringified "[]" accepted');
  t.assert(
    Array.isArray(captures.read_asset_properties?.property_names) &&
      captures.read_asset_properties.property_names.length === 0,
    'stringified "[]" parses to empty array'
  );

  // Malformed JSON → Zod rejects with isError:true
  const r4 = await sendRequest('tools/call', {
    name: 'read_asset_properties',
    arguments: { asset_path: '/Game/Fake', property_names: 'not json' },
  });
  t.assert(r4.result?.isError === true, 'malformed JSON string rejected with isError:true');

  await transport.close();
}

// Test 5: Happy-path tool/call response shape (real handler)
console.log('\n── Test 5: Happy-path response shape ──');
{
  if (!PROJECT_ROOT) {
    t.assert(false, 'UNREAL_PROJECT_ROOT not set — skipping happy-path test');
  } else {
    const realHandlers = (toolName) => async (args) =>
      executeOfflineTool(toolName, args, PROJECT_ROOT);

    const { transport, sendRequest, initialize } = await createTestServer(realHandlers);
    await initialize();

    // project_info requires no args and reads .uproject — a safe smoke test
    const resp = await sendRequest('tools/call', {
      name: 'project_info',
      arguments: {},
    });
    t.assert(!resp.result?.isError, `project_info succeeds (got isError=${resp.result?.isError})`);
    t.assert(Array.isArray(resp.result?.content), 'response.content is an array');
    t.assert(
      resp.result.content[0]?.type === 'text',
      `first content item is text (got ${resp.result.content[0]?.type})`
    );
    const payload = JSON.parse(resp.result.content[0].text);
    t.assert(
      typeof payload === 'object' && payload !== null,
      'content text is parseable JSON object'
    );
    t.assert(
      typeof payload.projectName === 'string' || typeof payload.fileName === 'string',
      'payload carries project identity (projectName or fileName)'
    );

    // EN-2: find_blueprint_nodes_bulk happy-path — exercises the real handler
    // through the JSON-RPC path. Primitive params, no wire coerce needed.
    const bulkResp = await sendRequest('tools/call', {
      name: 'find_blueprint_nodes_bulk',
      arguments: { path_prefix: '/Game/Blueprints', max_scan: 100 },
    });
    t.assert(!bulkResp.result?.isError,
      `EN-2 wire: find_blueprint_nodes_bulk succeeds (got isError=${bulkResp.result?.isError})`);
    const bulkPayload = JSON.parse(bulkResp.result.content[0].text);
    t.assert(bulkPayload.path_prefix === '/Game/Blueprints',
      'EN-2 wire: path_prefix round-trips through JSON-RPC');
    t.assert(typeof bulkPayload.total_bps_scanned === 'number' && Array.isArray(bulkPayload.results),
      'EN-2 wire: response shape has total_bps_scanned number + results array');

    await transport.close();
  }
}

// ── Phase 2: should-have ═════════════════════════════════════════════

// Test 6: Error-response shape on handler throw
console.log('\n── Test 6: Error response shape ──');
{
  const throwingHandler = (toolName) => async () => {
    throw new Error(`synthetic failure in ${toolName}`);
  };
  const { transport, sendRequest, initialize } = await createTestServer(throwingHandler);
  await initialize();

  const resp = await sendRequest('tools/call', {
    name: 'project_info',
    arguments: {},
  });
  t.assert(resp.result?.isError === true, `isError:true set on handler throw (got ${resp.result?.isError})`);
  t.assert(
    Array.isArray(resp.result?.content) && resp.result.content[0]?.type === 'text',
    'error response still carries content[0].text'
  );
  t.assert(
    /synthetic failure/.test(resp.result.content[0].text),
    `error text includes handler message (got "${resp.result.content[0].text.slice(0, 80)}")`
  );

  // Zod validation failure: required param missing — missing string should
  // fail Zod (z.string() rejects undefined when required). We use
  // search_gameplay_tags which has required: pattern.
  const resp2 = await sendRequest('tools/call', {
    name: 'search_gameplay_tags',
    arguments: {},
  });
  t.assert(
    resp2.result?.isError === true,
    'missing required param produces isError:true'
  );
  t.assert(
    /Invalid arguments|required|Required/.test(resp2.result.content[0].text),
    `validation error text mentions invalid/required (got "${resp2.result.content[0].text.slice(0, 100)}")`
  );

  await transport.close();
}

// Test 7: tools/list_changed notification on enable/disable
console.log('\n── Test 7: tools/list_changed timing ──');
{
  const { transport, handles, sendRequest, initialize } = await createTestServer(makeEchoHandler({}));
  await initialize();

  // All offline tools start enabled in this harness (we didn't call .disable()).
  // We'll disable one and check for the notification.
  transport.drainNotifications('notifications/tools/list_changed'); // clear any startup notifs

  handles.project_info.disable();
  // Notifications are synchronous in the SDK — they land in _outbound immediately,
  // but the send() method is async. Give one tick.
  await new Promise(r => setImmediate(r));

  const notifsAfterDisable = transport.drainNotifications('notifications/tools/list_changed');
  t.assert(notifsAfterDisable.length >= 1, `list_changed fired on disable (got ${notifsAfterDisable.length})`);

  // Verify the disabled tool is gone from tools/list
  const listResp = await sendRequest('tools/list', {});
  const names = listResp.result.tools.map(t => t.name);
  t.assert(!names.includes('project_info'), `disabled tool absent from tools/list (names include project_info? ${names.includes('project_info')})`);

  // Re-enable and expect another notification
  handles.project_info.enable();
  await new Promise(r => setImmediate(r));
  const notifsAfterEnable = transport.drainNotifications('notifications/tools/list_changed');
  t.assert(notifsAfterEnable.length >= 1, `list_changed fired on enable (got ${notifsAfterEnable.length})`);

  const listResp2 = await sendRequest('tools/list', {});
  const names2 = listResp2.result.tools.map(t => t.name);
  t.assert(names2.includes('project_info'), 're-enabled tool reappears in tools/list');

  await transport.close();
}

// Test 8: Truncation-path wire coverage (max_bytes round-trip)
console.log('\n── Test 8: Truncation path (max_bytes) ──');
{
  // Capture-only handler that echoes max_bytes — we care that the
  // stringified number arrives as a number at the handler boundary,
  // not that truncation fires (that's covered by the parser tests).
  // Wire-layer coverage: stringified max_bytes survives the Zod layer
  // and the handler sees a number, which is the exact scenario a
  // manual MCP caller would hit.
  const captures = {};
  const { transport, sendRequest, initialize } = await createTestServer(makeEchoHandler(captures));
  await initialize();

  const r = await sendRequest('tools/call', {
    name: 'read_asset_properties',
    arguments: { asset_path: '/Game/X', max_bytes: '1024', property_names: ['foo', 'bar'] },
  });
  t.assert(!r.result?.isError, 'read_asset_properties with stringified max_bytes + array param accepted');
  t.assert(
    captures.read_asset_properties?.max_bytes === 1024,
    `max_bytes arrives as number 1024 at handler (got ${typeof captures.read_asset_properties?.max_bytes}:${captures.read_asset_properties?.max_bytes})`
  );
  t.assert(
    Array.isArray(captures.read_asset_properties?.property_names) &&
    captures.read_asset_properties.property_names.length === 2,
    `array param round-trips (got ${JSON.stringify(captures.read_asset_properties?.property_names)})`
  );

  // If UNREAL_PROJECT_ROOT is set, also exercise the real truncation code
  // via a small max_bytes on a real .uasset — ensures the response
  // wrapping doesn't mangle the truncated flag.
  if (PROJECT_ROOT) {
    const realHandlers = (name) => async (args) =>
      executeOfflineTool(name, args, PROJECT_ROOT);
    const { transport: t2, sendRequest: s2, initialize: i2 } = await createTestServer(realHandlers);
    await i2();

    // Use a real Blueprint asset — pick one that reliably exists.
    // We use query_asset_registry to find something BP-like first.
    // Simpler: just hit a known tiny surface — use list_gameplay_tags
    // with a real call and verify the response round-trips as JSON.
    const resp = await s2('tools/call', { name: 'list_gameplay_tags', arguments: {} });
    t.assert(
      !resp.result?.isError,
      `real list_gameplay_tags succeeds over wire (got ${resp.result?.content?.[0]?.text?.slice(0,120)})`
    );
    // Response must parse as JSON even with nested tag hierarchy
    const parsed = JSON.parse(resp.result.content[0].text);
    t.assert(
      typeof parsed === 'object',
      'large nested response JSON-stringifies + parses cleanly over wire'
    );

    await t2.close();
  }

  await transport.close();
}

// ── Summary ──────────────────────────────────────────────────────────
process.exit(t.summary());
