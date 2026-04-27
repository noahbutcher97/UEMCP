// Tests for M5-input-and-pie Enhanced Input asset-creation handlers.
//
// Covers the 3 not-shipped tools landed by the M5-input+geometry sub-worker
// (create_input_action, create_mapping_context, add_mapping). Companion to
// test-m3-actors.mjs — same wire-mock pattern, FakeTcpResponder-driven.
//
// PIE control + console (start_pie / stop_pie / is_pie_running /
// execute_console_command) live in EdgeCaseHandlers.cpp under M-enhance D77
// and are exercised in the menhance test surface — NOT here.
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-m5-input-pie.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, ErrorTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import {
  initM5InputPieTools,
  executeM5InputPieTool,
  getM5InputPieToolDefs,
  M5_INPUT_PIE_SCHEMAS,
} from './m5-input-pie-tools.mjs';

// ── Initialize wire_type map (identity for all 3 — no override in yaml) ──
const fakeToolsYaml = {
  toolsets: {
    'input-and-pie': {
      tools: {
        create_input_action:    {},
        create_mapping_context: {},
        add_mapping:            {},
      },
    },
  },
};
initM5InputPieTools(fakeToolsYaml);

const t = new TestRunner('M5 input-and-pie — Enhanced Input asset creation');

// ═══════════════════════════════════════════════════════════════
// Group 1: Tool definition completeness
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 1: Tool Definitions ──');

const defs = getM5InputPieToolDefs();
const expectedTools = ['create_input_action', 'create_mapping_context', 'add_mapping'];

t.assert(Object.keys(defs).length === 3, '3 input-and-pie M5 tools defined');
t.assert(defs === M5_INPUT_PIE_SCHEMAS, 'getM5InputPieToolDefs returns M5_INPUT_PIE_SCHEMAS');

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
  fake.on('create_input_action',    { status: 'success', result: { name: 'IA_Move',    path: '/Game/Input/Actions/IA_Move',    value_type: 'Axis2D' } });
  fake.on('create_mapping_context', { status: 'success', result: { name: 'IMC_Default', path: '/Game/Input/IMC_Default' } });
  fake.on('add_mapping',            { status: 'success', result: { context_path: '/Game/Input/IMC_Default', action_path: '/Game/Input/Actions/IA_Move', key: 'W', mapping_count: 1 } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const checks = [
    ['create_input_action',    { name: 'IA_Move',    value_type: 'Axis2D' }],
    ['create_mapping_context', { name: 'IMC_Default' }],
    ['add_mapping',            { context_path: '/Game/Input/IMC_Default', action_path: '/Game/Input/Actions/IA_Move', key: 'W' }],
  ];

  for (const [tool, args] of checks) {
    await executeM5InputPieTool(tool, args, cm);
    const call = fake.lastCall(tool);
    t.assert(call !== undefined, `${tool} reaches wire`);
    t.assert(call.port === 55558, `${tool} routed to TCP:55558 — got ${call.port}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Group 3: Identity wire-type routing
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 3: Identity Wire-type Routing ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_input_action', { status: 'success', result: { name: 'IA_Look', path: '/Game/Input/Actions/IA_Look', value_type: 'Axis2D' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeM5InputPieTool('create_input_action', { name: 'IA_Look', value_type: 'Axis2D' }, cm);
  t.assert(fake.lastCall('create_input_action') !== undefined,
    'create_input_action uses identity wire-type (tools.yaml has no wire_type override)');
}

// ═══════════════════════════════════════════════════════════════
// Group 4: Param pass-through
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 4: Param Pass-through ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_input_action',    { status: 'success', result: { name: 'IA_Move', path: '/Game/MyInput/IA_Move', value_type: 'Axis2D' } });
  fake.on('create_mapping_context', { status: 'success', result: { name: 'IMC_Foo', path: '/Game/MyInput/IMC_Foo' } });
  fake.on('add_mapping',            { status: 'success', result: { context_path: 'C', action_path: 'A', key: 'Gamepad_LeftThumbstick_X', mapping_count: 3 } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Custom path is forwarded
  await executeM5InputPieTool('create_input_action',
    { name: 'IA_Move', value_type: 'Axis2D', path: '/Game/MyInput' }, cm);
  let call = fake.lastCall('create_input_action');
  t.assert(call.params.name === 'IA_Move',     'create_input_action: name passes through');
  t.assert(call.params.value_type === 'Axis2D','create_input_action: value_type passes through');
  t.assert(call.params.path === '/Game/MyInput','create_input_action: optional path passes through');

  // Optional path defaults to undefined when omitted
  await executeM5InputPieTool('create_mapping_context', { name: 'IMC_Foo' }, cm);
  call = fake.lastCall('create_mapping_context');
  t.assert(call.params.name === 'IMC_Foo', 'create_mapping_context: name passes through');
  t.assert(call.params.path === undefined, 'create_mapping_context: optional path stays undefined when omitted');

  await executeM5InputPieTool('add_mapping',
    { context_path: '/Game/Input/IMC_Default', action_path: '/Game/Input/Actions/IA_Move', key: 'Gamepad_LeftThumbstick_X' }, cm);
  call = fake.lastCall('add_mapping');
  t.assert(call.params.context_path === '/Game/Input/IMC_Default', 'add_mapping: context_path passes through');
  t.assert(call.params.action_path  === '/Game/Input/Actions/IA_Move', 'add_mapping: action_path passes through');
  t.assert(call.params.key === 'Gamepad_LeftThumbstick_X', 'add_mapping: gamepad key string passes through unchanged');
}

// ═══════════════════════════════════════════════════════════════
// Group 5: P0-9 — required-param validation rejects pre-wire
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 5: P0-9 Required-Param Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeM5InputPieTool('create_input_action', { value_type: 'Axis2D' }, cm),
    /name/i,
    'create_input_action rejects when name is missing',
  );
  t.assert(fake.lastCall('create_input_action') === undefined,
    'create_input_action: invalid request never reached the wire');

  await t.assertRejects(
    () => executeM5InputPieTool('create_input_action', { name: 'IA_X' }, cm),
    /value_type/i,
    'create_input_action rejects when value_type is missing',
  );

  await t.assertRejects(
    () => executeM5InputPieTool('add_mapping', { action_path: '/A', key: 'W' }, cm),
    /context_path/i,
    'add_mapping rejects when context_path is missing',
  );

  await t.assertRejects(
    () => executeM5InputPieTool('add_mapping', { context_path: '/C', action_path: '/A' }, cm),
    /key/i,
    'add_mapping rejects when key is missing',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 6: value_type enum gate
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 6: value_type Enum Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_input_action', { status: 'success', result: { name: 'IA_X', path: '/Game/Input/Actions/IA_X', value_type: 'Boolean' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Accepted tokens (matches plugin's ParseValueType)
  for (const vt of ['Bool', 'Boolean', 'Axis1D', 'Float', 'Axis2D', 'Vector2D', 'Axis3D', 'Vector']) {
    await executeM5InputPieTool('create_input_action', { name: 'IA_X', value_type: vt }, cm);
    const call = fake.lastCall('create_input_action');
    t.assert(call.params.value_type === vt, `value_type "${vt}" accepted`);
  }

  // Reject made-up token
  await t.assertRejects(
    () => executeM5InputPieTool('create_input_action', { name: 'IA_X', value_type: 'Quaternion' }, cm),
    /value_type/i,
    'value_type rejects unknown token "Quaternion"',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 7: Caching policy — every Enhanced Input creator is a write
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 7: Write-op skipCache ──');

{
  let calls = 0;
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_input_action', () => {
    calls++;
    return { status: 'success', result: { name: 'IA_X', path: '/Game/Input/Actions/IA_X', value_type: 'Boolean' } };
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  calls = 0;
  await executeM5InputPieTool('create_input_action', { name: 'IA_X', value_type: 'Boolean' }, cm);
  await executeM5InputPieTool('create_input_action', { name: 'IA_X', value_type: 'Boolean' }, cm);
  t.assert(calls === 2, 'create_input_action (write) bypasses cache — both calls hit wire');
}

// ═══════════════════════════════════════════════════════════════
// Group 8: Error envelope propagation (P0-1)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 8: Error Envelope Propagation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_input_action',    { status: 'error', error: "InputAction already exists at '/Game/Input/Actions/IA_X'", code: 'ASSET_EXISTS' });
  fake.on('add_mapping',            { status: 'error', error: 'InputMappingContext not found: /Game/Bogus', code: 'CONTEXT_NOT_FOUND' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeM5InputPieTool('create_input_action', { name: 'IA_X', value_type: 'Boolean' }, cm),
    /already exists/i,
    'ASSET_EXISTS error propagates with message',
  );

  await t.assertRejects(
    () => executeM5InputPieTool('add_mapping',
      { context_path: '/Game/Bogus', action_path: '/Game/Input/Actions/IA_Move', key: 'W' }, cm),
    /not found/i,
    'CONTEXT_NOT_FOUND error propagates with message',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 9: Transport errors propagate
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 9: Transport Errors ──');

{
  const errTimeout = new ErrorTcpResponder('timeout');
  const config = {
    projectRoot: 'D:/FakeProject',
    tcpPortExisting: 55557,
    tcpPortCustom:   55558,
    tcpTimeoutMs:    5000,
    tcpCommandFn:    errTimeout.handler(),
  };
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeM5InputPieTool('create_input_action', { name: 'IA_X', value_type: 'Boolean' }, cm),
    'timeout',
    'TCP:55558 timeout propagates through executeM5InputPieTool',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 10: Unknown tool name rejection
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 10: Unknown Tool Rejection ──');

{
  const { config } = createTestConfig('D:/FakeProject');
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeM5InputPieTool('not_a_real_input_tool', {}, cm),
    /unknown tool/,
    'executeM5InputPieTool rejects unknown tool name with explicit error',
  );
}

const exitCode = t.summary();
process.exit(exitCode);
