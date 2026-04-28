// Tests for M3-actors — 10 actors-toolset tools live on TCP:55558.
//
// Companion to docs/handoffs/m3-actors-rebuild.md. Mirrors the
// test-tcp-tools.mjs actors-section coverage (which got removed when M3
// flipped the layer) plus adds:
//   - Port routing → 55558 (oracle retirement, D23)
//   - Conformance shape parity vs canned oracle TCP:55557 fixtures
//   - P0-9 / P0-10 defense-in-depth Zod validation
//   - Identity wire-type fallback on tools without explicit translation
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-m3-actors.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, ErrorTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import {
  initActorsTools,
  executeActorsTool,
  getActorsToolDefs,
  ACTORS_SCHEMAS,
} from './actors-tcp-tools.mjs';

// ── Initialize wire_type maps from a fake YAML structure ──────────
// initActorsTools must run before executeActorsTool() relies on translation.
const fakeToolsYaml = {
  toolsets: {
    actors: {
      tools: {
        get_actors:  { wire_type: 'get_actors_in_level' },
        find_actors: { wire_type: 'find_actors_by_name' },
        spawn_actor: {}, delete_actor: {}, set_actor_transform: {},
        get_actor_properties: {}, set_actor_property: {},
        spawn_blueprint_actor: {}, focus_viewport: {}, take_screenshot: {},
      },
    },
  },
};
initActorsTools(fakeToolsYaml);

const t = new TestRunner('M3-actors — TCP:55558 actors toolset');

// ═══════════════════════════════════════════════════════════════
// Group 1: Tool definition completeness
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 1: Tool Definitions ──');

const defs = getActorsToolDefs();
const expectedTools = [
  'get_actors', 'find_actors', 'spawn_actor', 'delete_actor',
  'set_actor_transform', 'get_actor_properties', 'set_actor_property',
  'spawn_blueprint_actor', 'focus_viewport', 'take_screenshot',
];

t.assert(Object.keys(defs).length === 10, '10 actors tools defined');
t.assert(defs === ACTORS_SCHEMAS, 'getActorsToolDefs returns ACTORS_SCHEMAS');

for (const name of expectedTools) {
  t.assert(defs[name] !== undefined, `Tool "${name}" is defined`);
  t.assert(typeof defs[name].description === 'string' && defs[name].description.length > 0,
    `Tool "${name}" has a non-empty description`);
  t.assert(typeof defs[name].schema === 'object', `Tool "${name}" has a schema object`);
  t.assert(typeof defs[name].isReadOp === 'boolean', `Tool "${name}" has isReadOp flag`);
}

// Read/write classification — 3 reads, 7 writes
t.assert(defs.get_actors.isReadOp === true, 'get_actors is a read op');
t.assert(defs.find_actors.isReadOp === true, 'find_actors is a read op');
t.assert(defs.get_actor_properties.isReadOp === true, 'get_actor_properties is a read op');
t.assert(defs.spawn_actor.isReadOp === false, 'spawn_actor is a write op');
t.assert(defs.delete_actor.isReadOp === false, 'delete_actor is a write op');
t.assert(defs.set_actor_transform.isReadOp === false, 'set_actor_transform is a write op');
t.assert(defs.set_actor_property.isReadOp === false, 'set_actor_property is a write op');
t.assert(defs.spawn_blueprint_actor.isReadOp === false, 'spawn_blueprint_actor is a write op');
t.assert(defs.focus_viewport.isReadOp === false, 'focus_viewport is a write op');
t.assert(defs.take_screenshot.isReadOp === false, 'take_screenshot is a write op');

// ═══════════════════════════════════════════════════════════════
// Group 2: Port routing — every tool dispatches to TCP:55558
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 2: Port Routing → 55558 ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  // Wire-type names match the conformance oracle (no rename — D23 parity goal).
  fake.on('get_actors_in_level',  { status: 'success', result: { actors: [] } });
  fake.on('find_actors_by_name',  { status: 'success', result: { actors: [] } });
  fake.on('spawn_actor',          { status: 'success', result: { name: 'L1', class: 'PointLight', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] } });
  fake.on('delete_actor',         { status: 'success', result: { deleted_actor: { name: 'X', class: 'StaticMeshActor', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] } } });
  fake.on('set_actor_transform',  { status: 'success', result: { name: 'X', class: 'StaticMeshActor', location: [1,2,3], rotation: [0,0,0], scale: [1,1,1] } });
  fake.on('get_actor_properties', { status: 'success', result: { name: 'X', class: 'StaticMeshActor', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] } });
  fake.on('set_actor_property',   { status: 'success', result: { actor: 'X', property: 'bHidden', success: true, actor_details: {} } });
  fake.on('spawn_blueprint_actor',{ status: 'success', result: { name: 'BP_Player_1', class: 'BP_Player_C', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] } });
  fake.on('focus_viewport',       { status: 'success', result: { success: true } });
  fake.on('take_screenshot',      { status: 'success', result: { filepath: 'D:/Saved/x.png' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const checks = [
    ['get_actors',          {},                                       'get_actors_in_level'],
    ['find_actors',         { pattern: 'X' },                         'find_actors_by_name'],
    ['spawn_actor',         { type: 'PointLight', name: 'L1' },       'spawn_actor'],
    ['delete_actor',        { name: 'X' },                            'delete_actor'],
    ['set_actor_transform', { name: 'X', location: [1,2,3] },         'set_actor_transform'],
    ['get_actor_properties',{ name: 'X' },                            'get_actor_properties'],
    ['set_actor_property',  { name: 'X', property_name: 'bHidden', property_value: true }, 'set_actor_property'],
    ['spawn_blueprint_actor',{ blueprint_name: 'BP_Player', actor_name: 'BP_Player_1' }, 'spawn_blueprint_actor'],
    ['focus_viewport',      { target: 'X' },                          'focus_viewport'],
    ['take_screenshot',     { filepath: 'D:/Saved/x.png' },           'take_screenshot'],
  ];

  for (const [tool, args, wireType] of checks) {
    await executeActorsTool(tool, args, cm);
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
  fake.on('get_actors_in_level', { status: 'success', result: { actors: [] } });
  fake.on('find_actors_by_name', { status: 'success', result: { actors: [] } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeActorsTool('get_actors', {}, cm);
  t.assert(fake.lastCall('get_actors_in_level') !== undefined,
    'get_actors → get_actors_in_level (wire_type translation applied)');
  t.assert(fake.lastCall('get_actors') === undefined,
    'tools.yaml name NOT used as wire type when wire_type is set');

  await executeActorsTool('find_actors', { pattern: 'Cube' }, cm);
  t.assert(fake.lastCall('find_actors_by_name').params.pattern === 'Cube',
    'find_actors passes pattern param through');
}

// Identity fallback when wire_type is absent
{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('spawn_actor', { status: 'success', result: { name: 'L', class: 'PointLight', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeActorsTool('spawn_actor', { type: 'PointLight', name: 'L' }, cm);
  t.assert(fake.lastCall('spawn_actor') !== undefined,
    'spawn_actor uses identity wire type (no override in tools.yaml)');
}

// Empty wire map → identity for all
{
  initActorsTools({ toolsets: {} });
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_actors', { status: 'success', result: { actors: [] } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);
  await executeActorsTool('get_actors', {}, cm);
  t.assert(fake.lastCall('get_actors') !== undefined,
    'Empty wire map: tool name used as-is (identity)');

  initActorsTools(fakeToolsYaml); // restore for subsequent groups
}

// ═══════════════════════════════════════════════════════════════
// Group 4: Param stripping — get_actors class_filter
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 4: Param Stripping ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_actors_in_level', { status: 'success', result: { actors: [] } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeActorsTool('get_actors', { class_filter: 'StaticMeshActor' }, cm);
  const call = fake.lastCall('get_actors_in_level');
  t.assert(call !== undefined, 'get_actors sent to wire');
  t.assert(call.params.class_filter === undefined,
    'class_filter stripped from wire params (Phase 3 aspirational, plugin ignores)');
}

// ═══════════════════════════════════════════════════════════════
// Group 5: Conformance shape parity — oracle TCP:55557 fixtures
// ═══════════════════════════════════════════════════════════════
//
// The fixtures here represent canned oracle responses from TCP:55557.
// The TCP:55558 implementation must produce wire-equivalent responses
// modulo the P0-1 envelope (which adds `code` to error responses).

console.log('\n── Group 5: Conformance Shape Parity ──');

{
  const oracleActorJson = {
    name: 'StaticMeshActor_1',
    class: 'StaticMeshActor',
    location: [100.0, 200.0, 0.0],
    rotation: [0.0, 45.0, 0.0],
    scale: [1.0, 1.0, 1.0],
  };

  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  // get_actors_in_level: {actors: [actorJson, ...]}
  fake.on('get_actors_in_level', {
    status: 'success',
    result: { actors: [oracleActorJson] },
  });
  // delete_actor: {deleted_actor: actorJson}
  fake.on('delete_actor', {
    status: 'success',
    result: { deleted_actor: oracleActorJson },
  });
  // set_actor_property: {actor, property, success, actor_details}
  fake.on('set_actor_property', {
    status: 'success',
    result: { actor: 'X', property: 'bHidden', success: true, actor_details: oracleActorJson },
  });
  // focus_viewport: {success: true}
  fake.on('focus_viewport', { status: 'success', result: { success: true } });
  // take_screenshot: {filepath}
  fake.on('take_screenshot', { status: 'success', result: { filepath: 'D:/Saved/cap.png' } });
  // spawn_actor / set_actor_transform / get_actor_properties / spawn_blueprint_actor: actorJson directly
  fake.on('spawn_actor',          { status: 'success', result: oracleActorJson });
  fake.on('set_actor_transform',  { status: 'success', result: oracleActorJson });
  fake.on('get_actor_properties', { status: 'success', result: oracleActorJson });
  fake.on('spawn_blueprint_actor',{ status: 'success', result: oracleActorJson });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Oracle field-set: name, class, location, rotation, scale — exactly 5 keys
  const expectedKeys = new Set(['name', 'class', 'location', 'rotation', 'scale']);

  const r1 = await executeActorsTool('get_actors', {}, cm);
  t.assert(Array.isArray(r1.result.actors), 'get_actors result has actors array');
  const a = r1.result.actors[0];
  t.assert(Object.keys(a).every(k => expectedKeys.has(k)),
    'get_actors actor entry shape: name/class/location/rotation/scale only');
  t.assert(a.location[0] === 100 && a.location[1] === 200 && a.location[2] === 0,
    'Oracle vector ordering preserved [x,y,z]');
  t.assert(a.rotation[1] === 45,
    'Oracle rotator ordering preserved [pitch,yaw,roll] — yaw=45 in slot 1');

  const r2 = await executeActorsTool('delete_actor', { name: 'X' }, cm);
  t.assert(r2.result.deleted_actor !== undefined,
    'delete_actor result wraps actor as deleted_actor field (oracle parity)');

  const r3 = await executeActorsTool('set_actor_property',
    { name: 'X', property_name: 'bHidden', property_value: true }, cm);
  t.assert(r3.result.actor === 'X', 'set_actor_property result has actor field');
  t.assert(r3.result.property === 'bHidden', 'set_actor_property result has property field');
  t.assert(r3.result.success === true, 'set_actor_property result has success=true');
  t.assert(r3.result.actor_details !== undefined, 'set_actor_property result has actor_details (oracle parity)');

  const r4 = await executeActorsTool('focus_viewport', { target: 'X' }, cm);
  t.assert(r4.result.success === true, 'focus_viewport result has success=true');

  const r5 = await executeActorsTool('take_screenshot', { filepath: 'D:/Saved/cap.png' }, cm);
  t.assert(r5.result.filepath === 'D:/Saved/cap.png', 'take_screenshot returns filepath field (oracle parity)');

  // Direct actor-JSON results
  const r6 = await executeActorsTool('spawn_actor', { type: 'StaticMeshActor', name: 'X' }, cm);
  t.assert(r6.result.name === 'StaticMeshActor_1', 'spawn_actor result is actor JSON directly');

  const r7 = await executeActorsTool('get_actor_properties', { name: 'X' }, cm);
  t.assert(r7.result.class === 'StaticMeshActor', 'get_actor_properties returns actor JSON');
}

// ═══════════════════════════════════════════════════════════════
// Group 6: P0-1 — typed error code surface (code field present)
// ═══════════════════════════════════════════════════════════════
//
// The plugin's BuildErrorResponse always emits `code`. The P0-1 envelope
// upgrade vs oracle is that error responses now carry structured codes for
// caller branching. We verify the JS handler propagates errors through
// ConnectionManager and the message survives — code-field plumbing is a
// plugin-side concern verified by the smoke harness post-deployment.

console.log('\n── Group 6: Error Propagation (P0-1) ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  // Oracle/legacy Bridge error envelope
  fake.on('delete_actor', { status: 'error', error: 'Actor not found: Ghost' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeActorsTool('delete_actor', { name: 'Ghost' }, cm),
    'Actor not found: Ghost',
    'Bridge {status:error, error:msg} propagates through executeActorsTool',
  );
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  // Plugin P0-1 envelope (with code field — additive vs oracle)
  fake.on('spawn_actor', { status: 'error', error: 'Unknown actor type: Bogus', code: 'UNKNOWN_TYPE' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeActorsTool('spawn_actor', { type: 'Bogus', name: 'X' }, cm),
    'Unknown actor type',
    'P0-1 envelope ({status, error, code}) propagates error message',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 7: Caching — read ops cached, write ops skipCache
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 7: Caching ──');

{
  let calls = 0;
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_actors_in_level', () => {
    calls++;
    return { status: 'success', result: { actors: [] } };
  });
  fake.on('spawn_actor', () => {
    calls++;
    return { status: 'success', result: { name: 'L', class: 'PointLight', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] } };
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Read op: cached
  calls = 0;
  await executeActorsTool('get_actors', {}, cm);
  await executeActorsTool('get_actors', {}, cm);
  t.assert(calls === 1, 'get_actors (read) caches — second call served from cache');

  // Write op: every call hits wire
  calls = 0;
  await executeActorsTool('spawn_actor', { type: 'PointLight', name: 'L1' }, cm);
  await executeActorsTool('spawn_actor', { type: 'PointLight', name: 'L1' }, cm);
  t.assert(calls === 2, 'spawn_actor (write) bypasses cache — both calls hit wire');
}

// ═══════════════════════════════════════════════════════════════
// Group 8: P0-9 — required-param Zod rejection (before wire)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 8: P0-9 Required-Param Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // spawn_actor requires both `type` and `name` — omit `name`
  await t.assertRejects(
    () => executeActorsTool('spawn_actor', { type: 'PointLight' }, cm),
    /name/i,
    'spawn_actor rejects when required `name` is missing (Zod, before wire)',
  );
  t.assert(fake.lastCall('spawn_actor') === undefined,
    'Invalid request never reached the wire');

  await t.assertRejects(
    () => executeActorsTool('find_actors', {}, cm),
    /pattern/i,
    'find_actors rejects when required `pattern` is missing',
  );

  await t.assertRejects(
    () => executeActorsTool('set_actor_property', { name: 'X' }, cm),
    /property_name/i,
    'set_actor_property rejects when property_name is missing',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 9: P0-10 — vector shape Zod rejection
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 9: P0-10 Vector Shape Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // 2-element vector should reject (Vec3 needs length 3)
  await t.assertRejects(
    () => executeActorsTool('spawn_actor',
      { type: 'StaticMeshActor', name: 'X', location: [1, 2] }, cm),
    /array/i,
    'spawn_actor rejects 2-element location',
  );
  t.assert(fake.lastCall('spawn_actor') === undefined,
    'Malformed vector never reached the wire');

  // 4-element vector also rejects
  await t.assertRejects(
    () => executeActorsTool('set_actor_transform',
      { name: 'X', rotation: [1, 2, 3, 4] }, cm),
    /array/i,
    'set_actor_transform rejects 4-element rotation',
  );

  // Happy path: valid Vec3 passes through
  fake.on('set_actor_transform', { status: 'success', result: { name: 'X', class: 'StaticMeshActor', location: [1,2,3], rotation: [0,90,0], scale: [1,1,1] } });
  await executeActorsTool('set_actor_transform',
    { name: 'X', location: [1, 2, 3], rotation: [0, 90, 0] }, cm);
  const call = fake.lastCall('set_actor_transform');
  t.assert(Array.isArray(call.params.location) && call.params.location.length === 3,
    'Valid Vec3 passes through to wire unmodified');
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
    () => executeActorsTool('get_actors', {}, cm1),
    'timeout',
    'TCP:55558 timeout propagates through executeActorsTool',
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
    () => executeActorsTool('spawn_actor', { type: 'PointLight', name: 'L1' }, cm2),
    'ECONNREFUSED',
    'TCP:55558 connection refused propagates through executeActorsTool',
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
    () => executeActorsTool('not_a_real_tool', {}, cm),
    /unknown tool/,
    'executeActorsTool rejects unknown tool name with explicit error',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 12: CLEANUP-M3-FIXES — D99 finding #1 + #2 response shapes
// ═══════════════════════════════════════════════════════════════
//
// D99 #1 (set_actor_property Mobility) — handler now walks
//   actor → root component → named subobject components
// and returns a `set_on` field indicating where the write actually
// landed: "actor", "root_component", or "component:<Name>". The
// wire-mock here documents the new response contract; C++ traversal
// itself is verified live during smoke (D87 deployment-gap pattern).
//
// D99 #2 (take_screenshot silent file-write) — handler now resolves
// relative paths under FPaths::ProjectDir() and returns the resolved
// absolute path + byte_length. CompressImageArray (deprecated 5.0,
// hard error 5.7) migrated to CompressImage(FImageView).

console.log('\n── Group 12: CLEANUP-M3-FIXES regression (D99 #1 + #2) ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  // §1 set_actor_property Mobility — write lands on root component
  fake.on('set_actor_property', {
    status: 'success',
    result: {
      actor: 'StaticMeshActor_0',
      property: 'Mobility',
      set_on: 'root_component',
      success: true,
      actor_details: { name: 'StaticMeshActor_0', class: 'StaticMeshActor', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const r = await executeActorsTool('set_actor_property',
    { name: 'StaticMeshActor_0', property_name: 'Mobility', property_value: 'Movable' }, cm);
  t.assert(r.result.set_on === 'root_component',
    'set_actor_property response carries set_on indicating root-component traversal (D99 #1)');
  t.assert(r.result.property === 'Mobility', 'property field preserved');
  t.assert(r.result.success === true, 'success field preserved');

  // Wire mock: param pass-through verified
  const call = fake.lastCall('set_actor_property');
  t.assert(call.params.property_name === 'Mobility',
    'property_name passes through to wire (Mobility)');
  t.assert(call.params.property_value === 'Movable',
    'property_value passes through to wire (Movable)');
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  // §1 set_actor_property — write found on named subobject component
  fake.on('set_actor_property', {
    status: 'success',
    result: {
      actor: 'TestActor',
      property: 'Intensity',
      set_on: 'component:LightComponent',
      success: true,
      actor_details: { name: 'TestActor', class: 'PointLight', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const r = await executeActorsTool('set_actor_property',
    { name: 'TestActor', property_name: 'Intensity', property_value: 5000 }, cm);
  t.assert(typeof r.result.set_on === 'string' && r.result.set_on.startsWith('component:'),
    'set_on identifies named subobject component when property lives there');
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  // §1 — typed PROPERTY_NOT_FOUND when no chain target has the property
  fake.on('set_actor_property', {
    status: 'error',
    error: 'Property not found: NotARealProperty (checked actor, root component, and all named components)',
    code: 'PROPERTY_NOT_FOUND',
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeActorsTool('set_actor_property',
      { name: 'X', property_name: 'NotARealProperty', property_value: 1 }, cm),
    /Property not found/,
    'PROPERTY_NOT_FOUND propagates with chain-walked diagnostic message',
  );
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  // §2 take_screenshot — response now carries resolved absolute path + byte_length
  fake.on('take_screenshot', {
    status: 'success',
    result: {
      filepath: 'D:/UnrealProjects/MyProject/Saved/cap.png',  // absolute, ProjectDir-resolved
      byte_length: 142336,
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const r = await executeActorsTool('take_screenshot', { filepath: 'Saved/cap.png' }, cm);
  t.assert(typeof r.result.byte_length === 'number' && r.result.byte_length > 0,
    'take_screenshot response carries byte_length (D99 #2 — silent-fail diagnostic)');
  t.assert(r.result.filepath.endsWith('.png'),
    'take_screenshot filepath preserved (.png)');
  t.assert(r.result.filepath.startsWith('D:/'),
    'take_screenshot returns absolute resolved path (FPaths::ProjectDir resolution)');
}

// ═══════════════════════════════════════════════════════════════
// Group 13: D109 — spawn_blueprint_actor project-layout-aware resolution
// ═══════════════════════════════════════════════════════════════
//
// D109: Plugin's ResolveBlueprintAssetPath helper accepts a fully-qualified
// /Game/... path OR a bare asset name (legacy /Game/Blueprints/<Name> probe
// + AssetRegistry fallback). Wire-shape impact for the JS tool layer is:
//   - blueprint_name passes through to the wire unchanged in both forms
//   - BLUEPRINT_AMBIGUOUS is a new typed error code (Case 3 multiple matches)
//   - BLUEPRINT_NOT_FOUND error message now references "AssetRegistry"
//
// The C++ resolution chain itself is verified live during smoke (D87
// deployment-gap pattern); these wire-mock assertions document the JS-layer
// contract and the new error-code surface.

console.log('\n── Group 13: D109 — spawn_blueprint_actor resolution surface ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('spawn_blueprint_actor', {
    status: 'success',
    result: { name: 'BP_X_1', class: 'BP_X_C', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Case 1: fully-qualified path passes through to the wire unchanged
  await executeActorsTool('spawn_blueprint_actor',
    { blueprint_name: '/Game/Custom/Path/BP_X', actor_name: 'BP_X_1' }, cm);
  let call = fake.lastCall('spawn_blueprint_actor');
  t.assert(call.params.blueprint_name === '/Game/Custom/Path/BP_X',
    'D109: fully-qualified /Game/... path passes through to wire unmodified (Case 1)');

  // Case 2/3: bare asset name passes through to the wire unchanged (plugin resolves)
  fake.resetCalls();
  await executeActorsTool('spawn_blueprint_actor',
    { blueprint_name: 'BP_X', actor_name: 'BP_X_2' }, cm);
  call = fake.lastCall('spawn_blueprint_actor');
  t.assert(call.params.blueprint_name === 'BP_X',
    'D109: bare asset name passes through to wire unmodified (plugin resolves Case 2/3)');
}

{
  // BLUEPRINT_AMBIGUOUS — typed error code propagates through executeActorsTool
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('spawn_blueprint_actor', {
    status: 'error',
    error: "Ambiguous Blueprint name 'BP_X' (2 matches: /Game/Blueprints/BP_X, /Game/Other/BP_X) — pass a fully-qualified /Game/... path to disambiguate",
    code: 'BLUEPRINT_AMBIGUOUS',
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeActorsTool('spawn_blueprint_actor',
      { blueprint_name: 'BP_X', actor_name: 'X1' }, cm),
    /Ambiguous Blueprint name/,
    'D109: BLUEPRINT_AMBIGUOUS error message propagates with full diagnostic',
  );
}

{
  // BLUEPRINT_NOT_FOUND — diagnostic now references AssetRegistry, not just /Game/Blueprints/
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('spawn_blueprint_actor', {
    status: 'error',
    error: "Blueprint 'BP_DoesNotExist' not found (checked /Game/Blueprints/BP_DoesNotExist, then AssetRegistry project-wide)",
    code: 'BLUEPRINT_NOT_FOUND',
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeActorsTool('spawn_blueprint_actor',
      { blueprint_name: 'BP_DoesNotExist', actor_name: 'X' }, cm),
    /AssetRegistry/,
    'D109: BLUEPRINT_NOT_FOUND diagnostic mentions AssetRegistry fallback (not /Game/Blueprints/-only)',
  );
}

// Schema-text regression: blueprint_name describe no longer claims /Game/Blueprints/-only
{
  const desc = ACTORS_SCHEMAS.spawn_blueprint_actor.schema.blueprint_name._def.description;
  t.assert(typeof desc === 'string' && desc.length > 0,
    'spawn_blueprint_actor.blueprint_name has a description');
  t.assert(!/looked up under \/Game\/Blueprints\/\)/.test(desc),
    'D109: spawn_blueprint_actor.blueprint_name no longer claims /Game/Blueprints/ exclusively');
  t.assert(/\/Game\/\.\.\.|AssetRegistry/i.test(desc),
    'D109: spawn_blueprint_actor.blueprint_name describes new resolution chain (full path or AssetRegistry)');
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

const exitCode = t.summary();
process.exit(exitCode);
