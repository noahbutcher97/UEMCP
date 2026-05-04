// Tests for M3-blueprints-write — 15 BP-write tools live on TCP:55558.
//
// Companion to docs/handoffs/m3-blueprints-write-rebuild.md. Mirrors the
// test-m3-actors.mjs structure (Groups 1-11) adapted to the BP-write surface:
//   - Port routing → 55558 (oracle retirement, D23)
//   - Wire-type translation (11 of 15 tools have rename mappings)
//   - Conformance shape parity vs canned oracle TCP:55557 fixtures
//   - P0-1 error propagation (with code field)
//   - P0-9 / P0-10 defense-in-depth Zod validation
//   - Caching: read ops cached (find_nodes only), write ops skipCache
//   - Identity wire-type fallback on tools without explicit translation
//
// Per conformance-oracle-contracts.md §8.1, the toolset already absorbed the
// 6 BlueprintNodeCommands "orphans" — total 15 endpoints, NOT 21 as the
// handoff prose suggested. Tests cover all 15.
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-m3-blueprints-write.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, ErrorTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import {
  initBlueprintsWriteTools,
  executeBlueprintsWriteTool,
  getBlueprintsWriteToolDefs,
  BLUEPRINTS_WRITE_SCHEMAS,
} from './blueprints-write-tcp-tools.mjs';

// ── Initialize wire_type maps from a fake YAML structure ──────────
// initBlueprintsWriteTools must run before executeBlueprintsWriteTool() relies on translation.
// Mirrors tools.yaml `blueprints-write:` wire_type fields exactly.
const fakeToolsYaml = {
  toolsets: {
    'blueprints-write': {
      tools: {
        create_blueprint:        {},  // identity
        add_component:           { wire_type: 'add_component_to_blueprint' },
        set_component_property:  {},  // identity
        compile_blueprint:       {},  // identity
        set_blueprint_property:  {},  // identity
        set_static_mesh_props:   { wire_type: 'set_static_mesh_properties' },
        set_physics_props:       { wire_type: 'set_physics_properties' },
        set_pawn_props:          { wire_type: 'set_pawn_properties' },
        add_event_node:          { wire_type: 'add_blueprint_event_node' },
        add_function_node:       { wire_type: 'add_blueprint_function_node' },
        add_variable:            { wire_type: 'add_blueprint_variable' },
        add_self_reference:      { wire_type: 'add_blueprint_self_reference' },
        add_component_reference: { wire_type: 'add_blueprint_get_self_component_reference' },
        connect_nodes:           { wire_type: 'connect_blueprint_nodes' },
        find_nodes:              { wire_type: 'find_blueprint_nodes' },
      },
    },
  },
};
initBlueprintsWriteTools(fakeToolsYaml);

const t = new TestRunner('M3-blueprints-write — TCP:55558 blueprints-write toolset');

// ═══════════════════════════════════════════════════════════════
// Group 1: Tool definition completeness
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 1: Tool Definitions ──');

const defs = getBlueprintsWriteToolDefs();
const expectedTools = [
  'create_blueprint', 'add_component', 'set_component_property',
  'compile_blueprint', 'set_blueprint_property',
  'set_static_mesh_props', 'set_physics_props', 'set_pawn_props',
  'add_event_node', 'add_function_node', 'add_variable',
  'add_self_reference', 'add_component_reference',
  'connect_nodes', 'find_nodes',
];

t.assert(Object.keys(defs).length === 15, '15 blueprints-write tools defined');
t.assert(defs === BLUEPRINTS_WRITE_SCHEMAS, 'getBlueprintsWriteToolDefs returns BLUEPRINTS_WRITE_SCHEMAS');

for (const name of expectedTools) {
  t.assert(defs[name] !== undefined, `Tool "${name}" is defined`);
  t.assert(typeof defs[name].description === 'string' && defs[name].description.length > 0,
    `Tool "${name}" has a non-empty description`);
  t.assert(typeof defs[name].schema === 'object', `Tool "${name}" has a schema object`);
  t.assert(typeof defs[name].isReadOp === 'boolean', `Tool "${name}" has isReadOp flag`);
}

// Read/write classification — find_nodes is the only read op (oracle parity).
t.assert(defs.find_nodes.isReadOp === true, 'find_nodes is a read op');
const writeOps = expectedTools.filter(n => n !== 'find_nodes');
for (const name of writeOps) {
  t.assert(defs[name].isReadOp === false, `${name} is a write op`);
}

// ═══════════════════════════════════════════════════════════════
// Group 2: Port routing — every tool dispatches to TCP:55558
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 2: Port Routing → 55558 ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  // Wire-type names match the conformance oracle (no rename — D23 parity goal).
  fake.on('create_blueprint',                              { status: 'success', result: { name: 'BP_X', path: '/Game/Blueprints/BP_X' } });
  fake.on('add_component_to_blueprint',                    { status: 'success', result: { component_name: 'Mesh', component_type: 'StaticMesh' } });
  fake.on('set_component_property',                        { status: 'success', result: { component: 'Mesh', property: 'Mobility', success: true } });
  fake.on('compile_blueprint',                             { status: 'success', result: { name: 'BP_X', compiled: true } });
  fake.on('set_blueprint_property',                        { status: 'success', result: { property: 'bHidden', success: true } });
  fake.on('set_static_mesh_properties',                    { status: 'success', result: { component: 'Mesh' } });
  fake.on('set_physics_properties',                        { status: 'success', result: { component: 'Mesh' } });
  fake.on('set_pawn_properties',                           { status: 'success', result: { blueprint: 'BP_X', success: true, results: {} } });
  fake.on('add_blueprint_event_node',                      { status: 'success', result: { node_id: 'GUID-EV' } });
  fake.on('add_blueprint_function_node',                   { status: 'success', result: { node_id: 'GUID-FN' } });
  fake.on('add_blueprint_variable',                        { status: 'success', result: { variable_name: 'V', variable_type: 'Boolean' } });
  fake.on('add_blueprint_self_reference',                  { status: 'success', result: { node_id: 'GUID-SF' } });
  fake.on('add_blueprint_get_self_component_reference',    { status: 'success', result: { node_id: 'GUID-CR' } });
  fake.on('connect_blueprint_nodes',                       { status: 'success', result: { source_node_id: 'A', target_node_id: 'B' } });
  fake.on('find_blueprint_nodes',                          { status: 'success', result: { node_guids: [] } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const checks = [
    ['create_blueprint',        { name: 'BP_X' },                                                                      'create_blueprint'],
    ['add_component',           { blueprint_name: 'BP_X', component_type: 'StaticMesh', component_name: 'Mesh' },      'add_component_to_blueprint'],
    ['set_component_property',  { blueprint_name: 'BP_X', component_name: 'Mesh', property_name: 'Mobility', property_value: 'Movable' }, 'set_component_property'],
    ['compile_blueprint',       { blueprint_name: 'BP_X' },                                                            'compile_blueprint'],
    ['set_blueprint_property',  { blueprint_name: 'BP_X', property_name: 'bHidden', property_value: true },            'set_blueprint_property'],
    ['set_static_mesh_props',   { blueprint_name: 'BP_X', component_name: 'Mesh', static_mesh: '/Game/Meshes/Cube' },  'set_static_mesh_properties'],
    ['set_physics_props',       { blueprint_name: 'BP_X', component_name: 'Mesh', simulate_physics: true },            'set_physics_properties'],
    ['set_pawn_props',          { blueprint_name: 'BP_X', auto_possess_player: 'Player0' },                            'set_pawn_properties'],
    ['add_event_node',          { blueprint_name: 'BP_X', event_name: 'ReceiveBeginPlay' },                            'add_blueprint_event_node'],
    ['add_function_node',       { blueprint_name: 'BP_X', function_name: 'PrintString', target: 'KismetSystemLibrary' }, 'add_blueprint_function_node'],
    ['add_variable',            { blueprint_name: 'BP_X', variable_name: 'V', variable_type: 'Boolean' },              'add_blueprint_variable'],
    ['add_self_reference',      { blueprint_name: 'BP_X' },                                                            'add_blueprint_self_reference'],
    ['add_component_reference', { blueprint_name: 'BP_X', component_name: 'Mesh' },                                    'add_blueprint_get_self_component_reference'],
    ['connect_nodes',           { blueprint_name: 'BP_X', source_node_id: 'A', target_node_id: 'B', source_pin: 'Then', target_pin: 'Exec' }, 'connect_blueprint_nodes'],
    ['find_nodes',              { blueprint_name: 'BP_X', node_type: 'Event', event_name: 'ReceiveBeginPlay' },         'find_blueprint_nodes'],
  ];

  for (const [tool, args, wireType] of checks) {
    await executeBlueprintsWriteTool(tool, args, cm);
    const call = fake.lastCall(wireType);
    t.assert(call !== undefined, `${tool} reaches wire (type=${wireType})`);
    t.assert(call.port === 55558, `${tool} routed to TCP:55558 (M3 D23) — got ${call.port}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Group 3: Wire-type translation
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 3: Wire-type Translation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_component_to_blueprint',  { status: 'success', result: { component_name: 'Mesh', component_type: 'StaticMesh' } });
  fake.on('add_blueprint_event_node',    { status: 'success', result: { node_id: 'X' } });
  fake.on('add_blueprint_function_node', { status: 'success', result: { node_id: 'Y' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeBlueprintsWriteTool('add_component', { blueprint_name: 'BP', component_type: 'StaticMesh', component_name: 'Mesh' }, cm);
  t.assert(fake.lastCall('add_component_to_blueprint') !== undefined,
    'add_component → add_component_to_blueprint (wire_type translation applied)');
  t.assert(fake.lastCall('add_component') === undefined,
    'tools.yaml name NOT used as wire type when wire_type is set');

  await executeBlueprintsWriteTool('add_event_node', { blueprint_name: 'BP', event_name: 'ReceiveBeginPlay' }, cm);
  t.assert(fake.lastCall('add_blueprint_event_node') !== undefined,
    'add_event_node → add_blueprint_event_node');

  await executeBlueprintsWriteTool('add_function_node', { blueprint_name: 'BP', function_name: 'PrintString' }, cm);
  const call = fake.lastCall('add_blueprint_function_node');
  t.assert(call !== undefined, 'add_function_node → add_blueprint_function_node');
  t.assert(call.params.function_name === 'PrintString', 'function_name passes through to wire');
}

// Identity fallback when wire_type is absent (4 of 15 tools)
{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_blueprint',       { status: 'success', result: { name: 'X', path: '/Game/Blueprints/X' } });
  fake.on('compile_blueprint',      { status: 'success', result: { name: 'X', compiled: true } });
  fake.on('set_component_property', { status: 'success', result: { component: 'C', property: 'P', success: true } });
  fake.on('set_blueprint_property', { status: 'success', result: { property: 'P', success: true } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeBlueprintsWriteTool('create_blueprint', { name: 'X' }, cm);
  t.assert(fake.lastCall('create_blueprint') !== undefined,
    'create_blueprint uses identity wire type (no override in tools.yaml)');

  await executeBlueprintsWriteTool('compile_blueprint', { blueprint_name: 'X' }, cm);
  t.assert(fake.lastCall('compile_blueprint') !== undefined,
    'compile_blueprint uses identity wire type');
}

// Empty wire map → identity for all
{
  initBlueprintsWriteTools({ toolsets: {} });
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_component', { status: 'success', result: { component_name: 'M', component_type: 'X' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);
  await executeBlueprintsWriteTool('add_component',
    { blueprint_name: 'BP', component_type: 'X', component_name: 'M' }, cm);
  t.assert(fake.lastCall('add_component') !== undefined,
    'Empty wire map: tool name used as-is (identity)');

  initBlueprintsWriteTools(fakeToolsYaml); // restore for subsequent groups
}

// ═══════════════════════════════════════════════════════════════
// Group 4: Conformance shape parity — oracle TCP:55557 fixtures
// ═══════════════════════════════════════════════════════════════
//
// The fixtures here represent canned oracle responses from TCP:55557.
// The TCP:55558 implementation must produce wire-equivalent responses
// modulo the P0-1 envelope (which adds `code` to error responses).

console.log('\n── Group 4: Conformance Shape Parity ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  // create_blueprint: {name, path}
  fake.on('create_blueprint', {
    status: 'success',
    result: { name: 'BP_Player', path: '/Game/Blueprints/BP_Player' },
  });
  // add_component_to_blueprint: {component_name, component_type}
  fake.on('add_component_to_blueprint', {
    status: 'success',
    result: { component_name: 'Mesh', component_type: 'StaticMesh' },
  });
  // set_component_property: {component, property, success}
  fake.on('set_component_property', {
    status: 'success',
    result: { component: 'Mesh', property: 'Mobility', success: true },
  });
  // compile_blueprint: {name, compiled}
  fake.on('compile_blueprint', {
    status: 'success',
    result: { name: 'BP_Player', compiled: true },
  });
  // set_blueprint_property: {property, success}
  fake.on('set_blueprint_property', {
    status: 'success',
    result: { property: 'bHidden', success: true },
  });
  // set_static_mesh_properties / set_physics_properties: {component}
  fake.on('set_static_mesh_properties', { status: 'success', result: { component: 'Mesh' } });
  fake.on('set_physics_properties',     { status: 'success', result: { component: 'Mesh' } });
  // set_pawn_properties: {blueprint, success, results}
  fake.on('set_pawn_properties', {
    status: 'success',
    result: { blueprint: 'BP_Player', success: true, results: { AutoPossessPlayer: { success: true } } },
  });
  // *_node tools: {node_id} — all 5 node-creation tools share this shape
  fake.on('add_blueprint_event_node',                   { status: 'success', result: { node_id: 'GUID-EV' } });
  fake.on('add_blueprint_function_node',                { status: 'success', result: { node_id: 'GUID-FN' } });
  fake.on('add_blueprint_self_reference',               { status: 'success', result: { node_id: 'GUID-SF' } });
  fake.on('add_blueprint_get_self_component_reference', { status: 'success', result: { node_id: 'GUID-CR' } });
  // add_blueprint_variable: {variable_name, variable_type}
  fake.on('add_blueprint_variable', {
    status: 'success',
    result: { variable_name: 'Health', variable_type: 'Float' },
  });
  // connect_blueprint_nodes: {source_node_id, target_node_id}
  fake.on('connect_blueprint_nodes', {
    status: 'success',
    result: { source_node_id: 'A', target_node_id: 'B' },
  });
  // find_blueprint_nodes: {node_guids: [...]}
  fake.on('find_blueprint_nodes', {
    status: 'success',
    result: { node_guids: ['GUID-1', 'GUID-2'] },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const r1 = await executeBlueprintsWriteTool('create_blueprint', { name: 'BP_Player' }, cm);
  t.assert(r1.result.name === 'BP_Player' && r1.result.path === '/Game/Blueprints/BP_Player',
    'create_blueprint result has {name, path} (oracle parity)');

  const r2 = await executeBlueprintsWriteTool('add_component',
    { blueprint_name: 'BP_Player', component_type: 'StaticMesh', component_name: 'Mesh' }, cm);
  t.assert(r2.result.component_name === 'Mesh' && r2.result.component_type === 'StaticMesh',
    'add_component result has {component_name, component_type} (oracle parity)');

  const r3 = await executeBlueprintsWriteTool('set_component_property',
    { blueprint_name: 'BP_Player', component_name: 'Mesh', property_name: 'Mobility', property_value: 'Movable' }, cm);
  t.assert(r3.result.component === 'Mesh' && r3.result.property === 'Mobility' && r3.result.success === true,
    'set_component_property result has {component, property, success} (oracle parity)');

  const r4 = await executeBlueprintsWriteTool('compile_blueprint', { blueprint_name: 'BP_Player' }, cm);
  t.assert(r4.result.name === 'BP_Player' && r4.result.compiled === true,
    'compile_blueprint result has {name, compiled:true} (oracle parity)');

  const r5 = await executeBlueprintsWriteTool('set_blueprint_property',
    { blueprint_name: 'BP_Player', property_name: 'bHidden', property_value: true }, cm);
  t.assert(r5.result.property === 'bHidden' && r5.result.success === true,
    'set_blueprint_property result has {property, success} (oracle parity)');

  const r6 = await executeBlueprintsWriteTool('set_pawn_props',
    { blueprint_name: 'BP_Player', auto_possess_player: 'Player0' }, cm);
  t.assert(r6.result.blueprint === 'BP_Player', 'set_pawn_props result has blueprint field');
  t.assert(r6.result.success === true, 'set_pawn_props result has success field');
  t.assert(r6.result.results !== undefined, 'set_pawn_props result has per-property results object (oracle parity)');

  // Node-creation tools — all return {node_id}
  const nodeTools = [
    ['add_event_node',          { blueprint_name: 'BP', event_name: 'ReceiveBeginPlay' },                           'GUID-EV'],
    ['add_function_node',       { blueprint_name: 'BP', function_name: 'PrintString' },                             'GUID-FN'],
    ['add_self_reference',      { blueprint_name: 'BP' },                                                           'GUID-SF'],
    ['add_component_reference', { blueprint_name: 'BP', component_name: 'Mesh' },                                   'GUID-CR'],
  ];
  for (const [tool, args, expectedGuid] of nodeTools) {
    const r = await executeBlueprintsWriteTool(tool, args, cm);
    t.assert(typeof r.result.node_id === 'string', `${tool} result has node_id field (oracle parity)`);
    t.assert(r.result.node_id === expectedGuid, `${tool} returns the GUID from the wire`);
  }

  const r7 = await executeBlueprintsWriteTool('add_variable',
    { blueprint_name: 'BP', variable_name: 'Health', variable_type: 'Float' }, cm);
  t.assert(r7.result.variable_name === 'Health' && r7.result.variable_type === 'Float',
    'add_variable result has {variable_name, variable_type} (oracle parity)');

  const r8 = await executeBlueprintsWriteTool('connect_nodes',
    { blueprint_name: 'BP', source_node_id: 'A', target_node_id: 'B', source_pin: 'Then', target_pin: 'Exec' }, cm);
  t.assert(r8.result.source_node_id === 'A' && r8.result.target_node_id === 'B',
    'connect_nodes result has {source_node_id, target_node_id} (oracle parity)');

  const r9 = await executeBlueprintsWriteTool('find_nodes',
    { blueprint_name: 'BP', node_type: 'Event', event_name: 'ReceiveBeginPlay' }, cm);
  t.assert(Array.isArray(r9.result.node_guids), 'find_nodes result has node_guids array');
  t.assert(r9.result.node_guids.length === 2, 'find_nodes returns the array contents from the wire');
}

// ═══════════════════════════════════════════════════════════════
// Group 5: P0-1 — typed error code surface (code field present)
// ═══════════════════════════════════════════════════════════════
//
// The plugin's BuildErrorResponse always emits `code`. The P0-1 envelope
// upgrade vs oracle is that error responses now carry structured codes for
// caller branching. We verify the JS handler propagates errors through
// ConnectionManager and the message survives — code-field plumbing is a
// plugin-side concern verified by the smoke harness post-deployment.

console.log('\n── Group 5: Error Propagation (P0-1) ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  // Oracle/legacy Bridge error envelope
  fake.on('create_blueprint', { status: 'error', error: 'Blueprint already exists: BP_X' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeBlueprintsWriteTool('create_blueprint', { name: 'BP_X' }, cm),
    'Blueprint already exists',
    'Bridge {status:error, error:msg} propagates through executeBlueprintsWriteTool',
  );
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  // Plugin P0-1 envelope (with code field — additive vs oracle)
  fake.on('compile_blueprint', { status: 'error', error: 'Blueprint not found: Ghost', code: 'BLUEPRINT_NOT_FOUND' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeBlueprintsWriteTool('compile_blueprint', { blueprint_name: 'Ghost' }, cm),
    'Blueprint not found',
    'P0-1 envelope ({status, error, code}) propagates error message',
  );
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_blueprint_function_node', {
    status: 'error',
    error: 'Function not found: NoSuchFn in target Blueprint',
    code: 'FUNCTION_NOT_FOUND',
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeBlueprintsWriteTool('add_function_node', { blueprint_name: 'BP', function_name: 'NoSuchFn' }, cm),
    'Function not found',
    'add_function_node propagates FUNCTION_NOT_FOUND error',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 6: Caching — read ops cached, write ops skipCache
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 6: Caching ──');

{
  let calls = 0;
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('find_blueprint_nodes', () => {
    calls++;
    return { status: 'success', result: { node_guids: [] } };
  });
  fake.on('compile_blueprint', () => {
    calls++;
    return { status: 'success', result: { name: 'BP', compiled: true } };
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Read op: cached
  calls = 0;
  await executeBlueprintsWriteTool('find_nodes',
    { blueprint_name: 'BP', node_type: 'Event', event_name: 'ReceiveBeginPlay' }, cm);
  await executeBlueprintsWriteTool('find_nodes',
    { blueprint_name: 'BP', node_type: 'Event', event_name: 'ReceiveBeginPlay' }, cm);
  t.assert(calls === 1, 'find_nodes (read) caches — second call served from cache');

  // Write op: every call hits wire
  calls = 0;
  await executeBlueprintsWriteTool('compile_blueprint', { blueprint_name: 'BP' }, cm);
  await executeBlueprintsWriteTool('compile_blueprint', { blueprint_name: 'BP' }, cm);
  t.assert(calls === 2, 'compile_blueprint (write) bypasses cache — both calls hit wire');
}

// ═══════════════════════════════════════════════════════════════
// Group 7: P0-9 — required-param Zod rejection (before wire)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 7: P0-9 Required-Param Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // create_blueprint requires `name`
  await t.assertRejects(
    () => executeBlueprintsWriteTool('create_blueprint', {}, cm),
    /name/i,
    'create_blueprint rejects when required `name` is missing (Zod, before wire)',
  );
  t.assert(fake.lastCall('create_blueprint') === undefined,
    'Invalid request never reached the wire');

  // add_component requires blueprint_name + component_type + component_name
  await t.assertRejects(
    () => executeBlueprintsWriteTool('add_component', { blueprint_name: 'BP' }, cm),
    /component_type/i,
    'add_component rejects when component_type is missing',
  );

  await t.assertRejects(
    () => executeBlueprintsWriteTool('compile_blueprint', {}, cm),
    /blueprint_name/i,
    'compile_blueprint rejects when blueprint_name is missing',
  );

  await t.assertRejects(
    () => executeBlueprintsWriteTool('connect_nodes', { blueprint_name: 'BP', source_node_id: 'A' }, cm),
    /target_node_id/i,
    'connect_nodes rejects when target_node_id is missing',
  );

  await t.assertRejects(
    () => executeBlueprintsWriteTool('add_variable', { blueprint_name: 'BP', variable_name: 'V' }, cm),
    /variable_type/i,
    'add_variable rejects when variable_type is missing',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 8: P0-10 — vector shape Zod rejection
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 8: P0-10 Vector Shape Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // 2-element vector should reject (Vec3 needs length 3) — add_component location
  await t.assertRejects(
    () => executeBlueprintsWriteTool('add_component',
      { blueprint_name: 'BP', component_type: 'StaticMesh', component_name: 'Mesh', location: [1, 2] }, cm),
    /array/i,
    'add_component rejects 2-element location',
  );
  t.assert(fake.lastCall('add_component_to_blueprint') === undefined,
    'Malformed vector never reached the wire');

  // 4-element rotation also rejects
  await t.assertRejects(
    () => executeBlueprintsWriteTool('add_component',
      { blueprint_name: 'BP', component_type: 'StaticMesh', component_name: 'Mesh', rotation: [1, 2, 3, 4] }, cm),
    /array/i,
    'add_component rejects 4-element rotation',
  );

  // Vec2 node_position — 1-element should reject
  await t.assertRejects(
    () => executeBlueprintsWriteTool('add_event_node',
      { blueprint_name: 'BP', event_name: 'ReceiveBeginPlay', node_position: [5] }, cm),
    /array/i,
    'add_event_node rejects 1-element node_position (Vec2 requires length 2)',
  );

  // Happy path: valid Vec3 + Vec2 pass through
  fake.on('add_component_to_blueprint', { status: 'success', result: { component_name: 'M', component_type: 'StaticMesh' } });
  await executeBlueprintsWriteTool('add_component',
    { blueprint_name: 'BP', component_type: 'StaticMesh', component_name: 'M', location: [1, 2, 3] }, cm);
  const call = fake.lastCall('add_component_to_blueprint');
  t.assert(Array.isArray(call.params.location) && call.params.location.length === 3,
    'Valid Vec3 passes through to wire unmodified');
}

// ═══════════════════════════════════════════════════════════════
// Group 9: Param pass-through — selected complex tools
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 9: Param Pass-Through ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_blueprint_function_node', { status: 'success', result: { node_id: 'X' } });
  fake.on('set_pawn_properties',         { status: 'success', result: { blueprint: 'BP', success: true, results: {} } });
  fake.on('set_physics_properties',      { status: 'success', result: { component: 'M' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // add_function_node — pin defaults dict pass-through
  await executeBlueprintsWriteTool('add_function_node',
    {
      blueprint_name: 'BP',
      function_name: 'GetActorOfClass',
      target: 'GameplayStatics',
      params: { ActorClass: 'ACameraActor' },
    }, cm);
  const fnCall = fake.lastCall('add_blueprint_function_node');
  t.assert(fnCall.params.target === 'GameplayStatics', 'add_function_node target passes through');
  t.assert(fnCall.params.params && fnCall.params.params.ActorClass === 'ACameraActor',
    'add_function_node nested params object passes through unmodified');

  // set_pawn_props — multi-field pass-through
  await executeBlueprintsWriteTool('set_pawn_props',
    {
      blueprint_name: 'BP',
      auto_possess_player: 'Player0',
      use_controller_rotation_yaw: true,
      can_be_damaged: false,
    }, cm);
  const pawnCall = fake.lastCall('set_pawn_properties');
  t.assert(pawnCall.params.auto_possess_player === 'Player0', 'set_pawn_props auto_possess_player pass-through');
  t.assert(pawnCall.params.use_controller_rotation_yaw === true, 'set_pawn_props yaw flag pass-through');
  t.assert(pawnCall.params.can_be_damaged === false, 'set_pawn_props can_be_damaged false pass-through');

  // set_physics_props — only-some-fields-provided
  await executeBlueprintsWriteTool('set_physics_props',
    {
      blueprint_name: 'BP',
      component_name: 'M',
      mass: 50.5,
      // Other fields omitted — should not appear in wire params
    }, cm);
  const physCall = fake.lastCall('set_physics_properties');
  t.assert(physCall.params.mass === 50.5, 'set_physics_props mass pass-through');
  t.assert(physCall.params.simulate_physics === undefined, 'set_physics_props omitted simulate_physics absent on wire');
  t.assert(physCall.params.linear_damping === undefined, 'set_physics_props omitted linear_damping absent on wire');
}

// ═══════════════════════════════════════════════════════════════
// Group 10: Transport errors propagate (timeout, connection refused)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 10: Transport Errors ──');

{
  const errTimeout = new ErrorTcpResponder('timeout');
  const config1 = {
    projectRoot: 'D:/FakeProject',
    tcpPortExisting: 55557,
    tcpPortCustom:   55558,
    tcpTimeoutMs:    5000,
    tcpCommandFn:    errTimeout.handler(),
  };
  const cm1 = new ConnectionManager(config1);

  await t.assertRejects(
    () => executeBlueprintsWriteTool('compile_blueprint', { blueprint_name: 'BP' }, cm1),
    'timeout',
    'TCP:55558 timeout propagates through executeBlueprintsWriteTool',
  );
}

{
  const errRefused = new ErrorTcpResponder('connection_refused');
  const config2 = {
    projectRoot: 'D:/FakeProject',
    tcpPortExisting: 55557,
    tcpPortCustom:   55558,
    tcpTimeoutMs:    5000,
    tcpCommandFn:    errRefused.handler(),
  };
  const cm2 = new ConnectionManager(config2);

  await t.assertRejects(
    () => executeBlueprintsWriteTool('create_blueprint', { name: 'BP_X' }, cm2),
    'ECONNREFUSED',
    'TCP:55558 connection refused propagates through executeBlueprintsWriteTool',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 11: Unknown tool name rejection
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 11: Unknown Tool Rejection ──');

{
  const { config } = createTestConfig('D:/FakeProject');
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeBlueprintsWriteTool('not_a_real_tool', {}, cm),
    /unknown tool/,
    'executeBlueprintsWriteTool rejects unknown tool name with explicit error',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 12: D109 — blueprints-write project-layout-aware resolution
// ═══════════════════════════════════════════════════════════════
//
// D109: Plugin's ResolveBlueprintAssetPath helper accepts a fully-qualified
// /Game/... path OR a bare asset name. All BP-write tools route through
// ResolveBlueprint() which delegates to the helper, so blueprint_name is
// passed to the wire unchanged in either form. New typed BLUEPRINT_AMBIGUOUS
// error surfaces when Case 3 (AR fallback) returns multiple matches.
//
// Sample tools (compile_blueprint + add_event_node) cover both read and
// write surfaces. C++ resolution path is verified live during smoke.

console.log('\n── Group 12: D109 — blueprints-write resolution surface ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('compile_blueprint', { status: 'success', result: { name: 'BP', compiled: true } });
  fake.on('add_blueprint_event_node', { status: 'success', result: { node_id: 'GUID-EV' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Case 1: fully-qualified /Game/... path passes through to wire unchanged
  await executeBlueprintsWriteTool('compile_blueprint',
    { blueprint_name: '/Game/Custom/Path/BP_Player' }, cm);
  let call = fake.lastCall('compile_blueprint');
  t.assert(call.params.blueprint_name === '/Game/Custom/Path/BP_Player',
    'D109: compile_blueprint full /Game/... path passes through unmodified (Case 1)');

  // Case 2/3: bare asset name passes through to wire unchanged (plugin resolves)
  fake.resetCalls();
  await executeBlueprintsWriteTool('add_event_node',
    { blueprint_name: 'BP_Player', event_name: 'ReceiveBeginPlay' }, cm);
  call = fake.lastCall('add_blueprint_event_node');
  t.assert(call.params.blueprint_name === 'BP_Player',
    'D109: add_event_node bare name passes through unmodified (plugin resolves Case 2/3)');
}

{
  // BLUEPRINT_AMBIGUOUS — typed error code propagates through executeBlueprintsWriteTool
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('compile_blueprint', {
    status: 'error',
    error: "Ambiguous Blueprint name 'BP_Player' (2 matches: /Game/Blueprints/BP_Player, /Game/Custom/BP_Player) — pass a fully-qualified /Game/... path to disambiguate",
    code: 'BLUEPRINT_AMBIGUOUS',
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeBlueprintsWriteTool('compile_blueprint',
      { blueprint_name: 'BP_Player' }, cm),
    /Ambiguous Blueprint name/,
    'D109: BLUEPRINT_AMBIGUOUS propagates from any blueprints-write tool',
  );
}

// create_blueprint description regression: still says "/Game/Blueprints/" (it's the
// creation root, NOT a lookup site — kept per handoff §Scope-out) but ALSO
// documents the new cross-tool convention for blueprint_name on other tools.
{
  const desc = BLUEPRINTS_WRITE_SCHEMAS.create_blueprint.description;
  t.assert(typeof desc === 'string' && desc.length > 0,
    'create_blueprint has a description');
  t.assert(/\/Game\/Blueprints\//.test(desc),
    'D109: create_blueprint description still names /Game/Blueprints/ as creation root (kept per §Scope-out)');
  t.assert(/fully-qualified|\/Game\/\.\.\./i.test(desc),
    'D109: create_blueprint description acknowledges full /Game/... paths on other tools in toolset');
}

// ═══════════════════════════════════════════════════════════════
// Group N: §4 — create_blueprint optional `path` override
// ═══════════════════════════════════════════════════════════════
//
// Pre-§4: create_blueprint always landed at /Game/Blueprints/<name>. Post-§4
// it accepts an optional `path` param mirroring create_montage / create_material.
// Backwards-compat: omitting `path` → wire param `path` absent → C++ defaults
// to /Game/Blueprints/.

console.log('\n── Group N: §4 create_blueprint optional path override ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_blueprint',
    { status: 'success', result: { name: 'BP_X', path: '/Game/Blueprints/BP_X' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // No `path` → wire-param `path` absent (C++ falls back to /Game/Blueprints/)
  await executeBlueprintsWriteTool('create_blueprint', { name: 'BP_X' }, cm);
  let call = fake.lastCall('create_blueprint');
  t.assert(call.params.path === undefined,
    '§4: create_blueprint without `path` does not send `path` to wire (C++ default kicks in)');

  // With `path` → wire-param propagates
  fake.resetCalls();
  await executeBlueprintsWriteTool('create_blueprint',
    { name: 'BP_X', path: '/Game/Custom/Logic' }, cm);
  call = fake.lastCall('create_blueprint');
  t.assert(call.params.path === '/Game/Custom/Logic',
    '§4: create_blueprint `path` override propagates to wire unmodified');

  // Schema rejects non-string path
  await t.assertRejects(
    () => executeBlueprintsWriteTool('create_blueprint', { name: 'BP_X', path: 42 }, cm),
    /Expected string|invalid_type/i,
    '§4: create_blueprint rejects non-string `path` at Zod layer',
  );
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

const exitCode = t.summary();
process.exit(exitCode);
