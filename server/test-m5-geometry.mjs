// Tests for M5-geometry procedural-mesh + CSG handlers.
//
// Covers the 3 not-shipped tools landed by the M5-input+geometry sub-worker
// (create_procedural_mesh, mesh_boolean, generate_uvs). Wire-mock-driven —
// the live editor smoke plan in the handoff exercises the actual Geometry
// Script library calls; this file pins the wire contract.
//
// get_mesh_info (the only shipped geometry tool) lives in rc-tools.mjs
// FULL-RC delegate under M-enhance D77 — exercised in test-rc-wire.mjs, NOT
// here.
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-m5-geometry.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, ErrorTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import {
  initM5GeometryTools,
  executeM5GeometryTool,
  getM5GeometryToolDefs,
  M5_GEOMETRY_SCHEMAS,
} from './m5-geometry-tools.mjs';

// ── Initialize wire_type map (identity for all 3) ──
const fakeToolsYaml = {
  toolsets: {
    geometry: {
      tools: {
        create_procedural_mesh: {},
        mesh_boolean:           {},
        generate_uvs:           {},
      },
    },
  },
};
initM5GeometryTools(fakeToolsYaml);

const t = new TestRunner('M5 geometry — procedural mesh + CSG');

// ═══════════════════════════════════════════════════════════════
// Group 1: Tool definition completeness
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 1: Tool Definitions ──');

const defs = getM5GeometryToolDefs();
const expectedTools = ['create_procedural_mesh', 'mesh_boolean', 'generate_uvs'];

t.assert(Object.keys(defs).length === 3, '3 geometry M5 tools defined');
t.assert(defs === M5_GEOMETRY_SCHEMAS, 'getM5GeometryToolDefs returns M5_GEOMETRY_SCHEMAS');

for (const name of expectedTools) {
  t.assert(defs[name] !== undefined, `Tool "${name}" is defined`);
  t.assert(typeof defs[name].description === 'string' && defs[name].description.length > 0,
    `Tool "${name}" has a non-empty description`);
  t.assert(typeof defs[name].schema === 'object', `Tool "${name}" has a schema object`);
  t.assert(defs[name].isReadOp === false, `Tool "${name}" is a write op`);
}

// ═══════════════════════════════════════════════════════════════
// Group 2: Port routing → TCP:55558
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 2: Port Routing → 55558 ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_procedural_mesh', { status: 'success', result: { name: 'DynamicMeshActor_0', class: 'DynamicMeshActor', shape: 'box', size: 100, location: [0, 0, 0] } });
  fake.on('mesh_boolean',           { status: 'success', result: { target: 'A', tool: 'B', operation: 'union' } });
  fake.on('generate_uvs',           { status: 'success', result: { target: 'A', uv_channel: 0, method: 'box_projection' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const checks = [
    ['create_procedural_mesh', { shape: 'box' }],
    ['mesh_boolean',           { target: 'A', tool: 'B', operation: 'union' }],
    ['generate_uvs',           { target: 'A' }],
  ];

  for (const [tool, args] of checks) {
    await executeM5GeometryTool(tool, args, cm);
    const call = fake.lastCall(tool);
    t.assert(call !== undefined, `${tool} reaches wire`);
    t.assert(call.port === 55558, `${tool} routed to TCP:55558 — got ${call.port}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Group 3: Param pass-through
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 3: Param Pass-through ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_procedural_mesh', { status: 'success', result: { name: 'M', class: 'DynamicMeshActor', shape: 'sphere', size: 250, location: [10, 20, 30] } });
  fake.on('mesh_boolean',           { status: 'success', result: { target: 'A', tool: 'B', operation: 'difference' } });
  fake.on('generate_uvs',           { status: 'success', result: { target: 'A', uv_channel: 2, method: 'box_projection' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Optional fields all populated
  await executeM5GeometryTool('create_procedural_mesh',
    { shape: 'sphere', location: [10, 20, 30], size: 250, name: 'CustomMesh' }, cm);
  let call = fake.lastCall('create_procedural_mesh');
  t.assert(call.params.shape === 'sphere', 'create_procedural_mesh: shape passes through');
  t.assert(Array.isArray(call.params.location) && call.params.location.length === 3,
    'create_procedural_mesh: location passes through as Vec3');
  t.assert(call.params.location[0] === 10 && call.params.location[1] === 20 && call.params.location[2] === 30,
    'create_procedural_mesh: location values preserved [x,y,z]');
  t.assert(call.params.size === 250, 'create_procedural_mesh: size passes through');
  t.assert(call.params.name === 'CustomMesh', 'create_procedural_mesh: optional name passes through');

  // Optional fields omitted — Zod doesn't add them
  await executeM5GeometryTool('create_procedural_mesh', { shape: 'cone' }, cm);
  call = fake.lastCall('create_procedural_mesh');
  t.assert(call.params.shape === 'cone', 'create_procedural_mesh: bare shape works');
  t.assert(call.params.location === undefined, 'create_procedural_mesh: optional location stays undefined');
  t.assert(call.params.size === undefined, 'create_procedural_mesh: optional size stays undefined');

  await executeM5GeometryTool('mesh_boolean',
    { target: 'TargetActor', tool: 'ToolActor', operation: 'difference' }, cm);
  call = fake.lastCall('mesh_boolean');
  t.assert(call.params.target === 'TargetActor', 'mesh_boolean: target passes through');
  t.assert(call.params.tool === 'ToolActor', 'mesh_boolean: tool passes through');
  t.assert(call.params.operation === 'difference', 'mesh_boolean: operation passes through');

  await executeM5GeometryTool('generate_uvs', { target: 'A', uv_channel: 2 }, cm);
  call = fake.lastCall('generate_uvs');
  t.assert(call.params.target === 'A', 'generate_uvs: target passes through');
  t.assert(call.params.uv_channel === 2, 'generate_uvs: uv_channel passes through');
}

// ═══════════════════════════════════════════════════════════════
// Group 4: P0-9 — required-param validation
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 4: P0-9 Required-Param Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeM5GeometryTool('create_procedural_mesh', {}, cm),
    /shape/i,
    'create_procedural_mesh rejects when shape is missing',
  );
  t.assert(fake.lastCall('create_procedural_mesh') === undefined,
    'create_procedural_mesh: invalid request never reached the wire');

  await t.assertRejects(
    () => executeM5GeometryTool('mesh_boolean', { tool: 'B', operation: 'union' }, cm),
    /target/i,
    'mesh_boolean rejects when target is missing',
  );

  await t.assertRejects(
    () => executeM5GeometryTool('mesh_boolean', { target: 'A', operation: 'union' }, cm),
    /tool/i,
    'mesh_boolean rejects when tool is missing',
  );

  await t.assertRejects(
    () => executeM5GeometryTool('mesh_boolean', { target: 'A', tool: 'B' }, cm),
    /operation/i,
    'mesh_boolean rejects when operation is missing',
  );

  await t.assertRejects(
    () => executeM5GeometryTool('generate_uvs', {}, cm),
    /target/i,
    'generate_uvs rejects when target is missing',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 5: Enum + range validation
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 5: Enum + Range Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_procedural_mesh', { status: 'success', result: { name: 'X', class: 'DynamicMeshActor', shape: 'box', size: 100, location: [0,0,0] } });
  fake.on('mesh_boolean',           { status: 'success', result: { target: 'A', tool: 'B', operation: 'union' } });
  fake.on('generate_uvs',           { status: 'success', result: { target: 'A', uv_channel: 0, method: 'box_projection' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // shape enum — accepts box/sphere/cylinder/cone
  for (const s of ['box', 'sphere', 'cylinder', 'cone']) {
    await executeM5GeometryTool('create_procedural_mesh', { shape: s }, cm);
    const call = fake.lastCall('create_procedural_mesh');
    t.assert(call.params.shape === s, `shape "${s}" accepted`);
  }
  await t.assertRejects(
    () => executeM5GeometryTool('create_procedural_mesh', { shape: 'torus' }, cm),
    /shape/i,
    'shape rejects unknown token "torus"',
  );

  // operation enum — accepts union/difference/subtract/intersection/intersect
  for (const op of ['union', 'difference', 'subtract', 'intersection', 'intersect']) {
    await executeM5GeometryTool('mesh_boolean', { target: 'A', tool: 'B', operation: op }, cm);
    const call = fake.lastCall('mesh_boolean');
    t.assert(call.params.operation === op, `operation "${op}" accepted`);
  }
  await t.assertRejects(
    () => executeM5GeometryTool('mesh_boolean', { target: 'A', tool: 'B', operation: 'xor' }, cm),
    /operation/i,
    'operation rejects unknown token "xor"',
  );

  // size must be positive (Zod .positive())
  await t.assertRejects(
    () => executeM5GeometryTool('create_procedural_mesh', { shape: 'box', size: 0 }, cm),
    /size/i,
    'size rejects 0 (not positive)',
  );
  await t.assertRejects(
    () => executeM5GeometryTool('create_procedural_mesh', { shape: 'box', size: -10 }, cm),
    /size/i,
    'size rejects negative value',
  );

  // uv_channel range 0..7
  await executeM5GeometryTool('generate_uvs', { target: 'A', uv_channel: 0 }, cm);
  await executeM5GeometryTool('generate_uvs', { target: 'A', uv_channel: 7 }, cm);
  await t.assertRejects(
    () => executeM5GeometryTool('generate_uvs', { target: 'A', uv_channel: 8 }, cm),
    /uv_channel/i,
    'uv_channel rejects 8 (out of [0..7])',
  );
  await t.assertRejects(
    () => executeM5GeometryTool('generate_uvs', { target: 'A', uv_channel: -1 }, cm),
    /uv_channel/i,
    'uv_channel rejects -1 (out of [0..7])',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 6: P0-10 — Vec3 shape validation on location
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 6: P0-10 Vec3 Shape Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeM5GeometryTool('create_procedural_mesh', { shape: 'box', location: [1, 2] }, cm),
    /array/i,
    'create_procedural_mesh rejects 2-element location',
  );
  await t.assertRejects(
    () => executeM5GeometryTool('create_procedural_mesh', { shape: 'box', location: [1, 2, 3, 4] }, cm),
    /array/i,
    'create_procedural_mesh rejects 4-element location',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 7: GEOMETRY_SCRIPT_PLUGIN_DISABLED error envelope
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 7: Plugin-Disabled Error Envelope ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  // Belt + suspenders: handler returns this typed error if Geometry Script plugin
  // is disabled in target project at runtime even though Build.cs pulled the modules.
  fake.on('create_procedural_mesh', {
    status: 'error',
    error: 'GeometryScripting plugin is not enabled. Enable it in the target project\'s Edit → Plugins panel and restart the editor before retrying.',
    code: 'GEOMETRY_SCRIPT_PLUGIN_DISABLED',
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeM5GeometryTool('create_procedural_mesh', { shape: 'box' }, cm),
    /not enabled/i,
    'GEOMETRY_SCRIPT_PLUGIN_DISABLED propagates with remediation message',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 8: Other error envelopes propagate
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 8: Error Envelope Propagation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('mesh_boolean', { status: 'error', error: 'DynamicMeshActor not found: GhostActor', code: 'TARGET_NOT_FOUND' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeM5GeometryTool('mesh_boolean',
      { target: 'GhostActor', tool: 'B', operation: 'union' }, cm),
    /not found/i,
    'TARGET_NOT_FOUND error propagates',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 9: Caching — every geometry tool is a write
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 9: Write-op skipCache ──');

{
  let calls = 0;
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_procedural_mesh', () => {
    calls++;
    return { status: 'success', result: { name: 'M', class: 'DynamicMeshActor', shape: 'box', size: 100, location: [0,0,0] } };
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  calls = 0;
  await executeM5GeometryTool('create_procedural_mesh', { shape: 'box' }, cm);
  await executeM5GeometryTool('create_procedural_mesh', { shape: 'box' }, cm);
  t.assert(calls === 2, 'create_procedural_mesh (write) bypasses cache — both calls hit wire');
}

// ═══════════════════════════════════════════════════════════════
// Group 10: Transport errors propagate
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 10: Transport Errors ──');

{
  const errRefused = new ErrorTcpResponder('connection_refused');
  const config = {
    projectRoot: 'D:/FakeProject',
    tcpPortExisting: 55557,
    tcpPortCustom:   55558,
    tcpTimeoutMs:    5000,
    tcpCommandFn:    errRefused.handler(),
  };
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeM5GeometryTool('mesh_boolean', { target: 'A', tool: 'B', operation: 'union' }, cm),
    'ECONNREFUSED',
    'TCP:55558 connection refused propagates through executeM5GeometryTool',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 11: Unknown tool rejection
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 11: Unknown Tool Rejection ──');

{
  const { config } = createTestConfig('D:/FakeProject');
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeM5GeometryTool('not_a_real_geometry_tool', {}, cm),
    /unknown tool/,
    'executeM5GeometryTool rejects unknown tool name with explicit error',
  );
}

const exitCode = t.summary();
process.exit(exitCode);
