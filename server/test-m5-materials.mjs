// Tests for M5-materials — 2 plugin-C++ create tools live on TCP:55558.
//
// Companion to docs/handoffs/m5-animation-materials.md. set_material_parameter
// ships as RC HTTP delegate (D101 (ii)) — its tests live in test-rc-wire.mjs
// Test 12 to keep transport-aligned coverage colocated.
//
// Coverage:
//   - Tool definition completeness (2 plugin-C++ tools — set_material_parameter
//     deliberately absent, RC-routed)
//   - Port routing → 55558
//   - Param pass-through (identity wire types)
//   - Zod validation
//   - isReadOp = false (writes skip cache)
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-m5-materials.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import {
  initM5MaterialsTools,
  executeM5MaterialsTool,
  getM5MaterialsToolDefs,
  M5_MATERIALS_SCHEMAS,
} from './m5-materials-tools.mjs';

const fakeToolsYaml = {
  toolsets: {
    materials: {
      tools: {
        create_material:          {},
        create_material_instance: {},
        // set_material_parameter intentionally listed in yaml/materials but
        // dispatched via rc-tools.mjs — not in M5_MATERIALS_SCHEMAS.
      },
    },
  },
};
initM5MaterialsTools(fakeToolsYaml);

const t = new TestRunner('M5-materials — TCP:55558 material creates (RC for set_material_parameter)');

// ═══════════════════════════════════════════════════════════════
// Group 1: Tool definition completeness
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 1: Tool Definitions ──');

const defs = getM5MaterialsToolDefs();
const expectedTools = ['create_material', 'create_material_instance'];

t.assert(Object.keys(defs).length === 2,
  `2 materials create tools defined (got ${Object.keys(defs).length})`);
t.assert(defs === M5_MATERIALS_SCHEMAS, 'getM5MaterialsToolDefs returns M5_MATERIALS_SCHEMAS');

// set_material_parameter ships RC-only — must NOT appear in M5 schema map
t.assert(defs.set_material_parameter === undefined,
  'set_material_parameter NOT in M5 TCP schemas (RC delegate per D101 (ii))');

for (const name of expectedTools) {
  t.assert(defs[name] !== undefined, `Tool "${name}" is defined`);
  t.assert(typeof defs[name].description === 'string' && defs[name].description.length > 0,
    `Tool "${name}" has non-empty description`);
  t.assert(typeof defs[name].schema === 'object', `Tool "${name}" has schema object`);
  t.assert(typeof defs[name].isReadOp === 'boolean', `Tool "${name}" has isReadOp flag`);
  t.assert(defs[name].isReadOp === false, `Tool "${name}" is a write op`);
}

// ═══════════════════════════════════════════════════════════════
// Group 2: Port routing → TCP:55558
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 2: Port Routing → 55558 ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_material', {
    status: 'success',
    result: { name: 'M_Test', path: '/Game/Materials/M_Test', domain: 'Surface', blend_mode: 'Opaque' },
  });
  fake.on('create_material_instance', {
    status: 'success',
    result: { name: 'MIC_Test', path: '/Game/Materials/MIC_Test', parent: '/Game/Materials/M_Test.M_Test' },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const checks = [
    ['create_material',          { name: 'M_Test' },                                       'create_material'],
    ['create_material_instance', { name: 'MIC_Test', parent_path: '/Game/Materials/M_Test' }, 'create_material_instance'],
  ];

  for (const [tool, args, wireType] of checks) {
    await executeM5MaterialsTool(tool, args, cm);
    const call = fake.lastCall(wireType);
    t.assert(call !== undefined, `${tool} reaches wire (type=${wireType})`);
    t.assert(call.port === 55558, `${tool} routed to TCP:55558 — got ${call.port}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Group 3: Param pass-through with optional fields
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 3: Params Pass Through ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_material', { status: 'success', result: {} });
  fake.on('create_material_instance', { status: 'success', result: {} });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // create_material with all optional fields
  await executeM5MaterialsTool('create_material', {
    name: 'M_UI',
    path: '/Game/UI/Materials',
    domain: 'UI',
    blend_mode: 'Translucent',
  }, cm);
  let call = fake.lastCall('create_material');
  t.assert(call.params.name === 'M_UI', 'create_material forwards name');
  t.assert(call.params.path === '/Game/UI/Materials', 'create_material forwards path');
  t.assert(call.params.domain === 'UI', 'create_material forwards domain');
  t.assert(call.params.blend_mode === 'Translucent', 'create_material forwards blend_mode');

  // Defaults — bare name only
  await executeM5MaterialsTool('create_material', { name: 'M_Bare' }, cm);
  call = fake.lastCall('create_material');
  t.assert(call.params.name === 'M_Bare', 'create_material accepts bare name');
  t.assert(call.params.domain === undefined, 'optional domain absent when not supplied');

  // create_material_instance forwards parent_path
  await executeM5MaterialsTool('create_material_instance', {
    name: 'MIC_FromBase',
    parent_path: '/Game/Materials/M_Base.M_Base',
  }, cm);
  call = fake.lastCall('create_material_instance');
  t.assert(call.params.parent_path === '/Game/Materials/M_Base.M_Base',
    'create_material_instance forwards parent_path verbatim');
}

// ═══════════════════════════════════════════════════════════════
// Group 4: Zod validation rejects malformed args
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 4: Zod Validation Bites ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    async () => executeM5MaterialsTool('create_material', { /* missing name */ }, cm),
    /name|required|invalid_type/i,
    'create_material rejects missing name'
  );

  await t.assertRejects(
    async () => executeM5MaterialsTool('create_material_instance', {
      name: 'MIC_X' /* missing parent_path */,
    }, cm),
    /parent_path|required|invalid_type/i,
    'create_material_instance rejects missing parent_path'
  );

  await t.assertRejects(
    async () => executeM5MaterialsTool('create_material', { name: 123 /* not a string */ }, cm),
    /string|invalid_type/i,
    'create_material rejects non-string name'
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 5: Unknown / SUPERSEDED tool → typed error envelope
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 5: set_material_parameter NOT in M5 dispatch ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // set_material_parameter exists in yaml but is dispatched through rc-tools,
  // not through executeM5MaterialsTool. Calling it through M5 dispatch returns
  // the not_implemented stub — which is the correct outcome.
  const res = await executeM5MaterialsTool('set_material_parameter', {
    asset_path: '/Game/Materials/MIC_X.MIC_X',
    parameter_name: 'Roughness',
    value: 0.5,
  }, cm);
  t.assert(res.status === 'error', 'set_material_parameter via M5 dispatch returns error');
  t.assert(res.code === 'not_implemented',
    'envelope code = not_implemented (RC-routed; M5 TCP dispatch is correctly stubbed)');
}

// ═══════════════════════════════════════════════════════════════
// Group 6: Write-op skipCache discipline
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 6: Write Ops Skip Cache ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_material', { status: 'success', result: { name: 'M_X' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeM5MaterialsTool('create_material', { name: 'M_Cache_Probe' }, cm);
  await executeM5MaterialsTool('create_material', { name: 'M_Cache_Probe' }, cm);
  const calls = fake.callsFor('create_material');
  t.assert(calls.length === 2,
    `create_material skipCache=true (both calls reached wire, got ${calls.length})`);
}

// ═══════════════════════════════════════════════════════════════
// Group 7: Empty wire-map → identity fallback
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 7: Empty Wire Map → Identity Fallback ──');

{
  initM5MaterialsTools({ toolsets: {} });

  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_material', { status: 'success', result: {} });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeM5MaterialsTool('create_material', { name: 'M_NoMap' }, cm);
  t.assert(fake.lastCall('create_material') !== undefined,
    'Empty wire map: tool name used as-is (identity)');

  initM5MaterialsTools(fakeToolsYaml);
}

// ── Done ───────────────────────────────────────────────────────
process.exit(t.summary());
