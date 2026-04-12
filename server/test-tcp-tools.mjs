// Tests for Phase 2 TCP tools — actors toolset
//
// Exercises:
//   1. Name translation (tools.yaml → C++ type string)
//   2. Param pass-through and stripping (class_filter on get_actors)
//   3. Error normalization (all 3 formats: Bridge, CommonUtils, UMG ad-hoc)
//   4. Read-op caching vs write-op skip-cache
//   5. Tool registration completeness
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-tcp-tools.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, ErrorTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import { executeActorsTool, getActorsToolDefs, ACTORS_SCHEMAS } from './tcp-tools.mjs';

const t = new TestRunner('Phase 2 — Actors TCP Tools');

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

for (const name of expectedTools) {
  t.assert(defs[name] !== undefined, `Tool "${name}" is defined`);
  t.assert(typeof defs[name].description === 'string' && defs[name].description.length > 0,
    `Tool "${name}" has a non-empty description`);
  t.assert(typeof defs[name].schema === 'object', `Tool "${name}" has a schema object`);
  t.assert(typeof defs[name].isReadOp === 'boolean', `Tool "${name}" has isReadOp flag`);
}

// Verify read/write classification
t.assert(defs.get_actors.isReadOp === true, 'get_actors is a read op');
t.assert(defs.find_actors.isReadOp === true, 'find_actors is a read op');
t.assert(defs.get_actor_properties.isReadOp === true, 'get_actor_properties is a read op');
t.assert(defs.spawn_actor.isReadOp === false, 'spawn_actor is a write op');
t.assert(defs.delete_actor.isReadOp === false, 'delete_actor is a write op');
t.assert(defs.set_actor_transform.isReadOp === false, 'set_actor_transform is a write op');
t.assert(defs.set_actor_property.isReadOp === false, 'set_actor_property is a write op');

// ═══════════════════════════════════════════════════════════════
// Group 2: Name translation
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 2: Name Translation ──');

{
  const fake = new FakeTcpResponder();
  // Register responses for the C++ type strings (what arrives on the wire)
  fake.on('ping', { status: 'success' });
  fake.on('get_actors_in_level', {
    status: 'success',
    result: { actors: [{ name: 'Cube', class: 'StaticMeshActor', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }] }
  });
  fake.on('find_actors_by_name', {
    status: 'success',
    result: { actors: [] }
  });
  fake.on('spawn_actor', {
    status: 'success',
    result: { name: 'MyLight', class: 'PointLight', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }
  });
  fake.on('delete_actor', {
    status: 'success',
    result: { deleted_actor: { name: 'Cube', class: 'StaticMeshActor', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] } }
  });
  fake.on('set_actor_transform', {
    status: 'success',
    result: { name: 'Cube', class: 'StaticMeshActor', location: [100,200,0], rotation: [0,0,0], scale: [1,1,1] }
  });
  fake.on('get_actor_properties', {
    status: 'success',
    result: { name: 'Cube', class: 'StaticMeshActor', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }
  });
  fake.on('set_actor_property', {
    status: 'success',
    result: { actor: 'Cube', property: 'bHidden', success: true }
  });
  fake.on('spawn_blueprint_actor', {
    status: 'success',
    result: { name: 'BP_Player_1', class: 'BP_Player_C', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }
  });
  fake.on('focus_viewport', {
    status: 'success',
    result: { success: true }
  });
  fake.on('take_screenshot', {
    status: 'success',
    result: { filepath: 'C:/Screenshots/test.png' }
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // get_actors → get_actors_in_level
  await executeActorsTool('get_actors', {}, cm);
  t.assert(fake.lastCall('get_actors_in_level') !== undefined,
    'get_actors translates to get_actors_in_level');

  // find_actors → find_actors_by_name
  await executeActorsTool('find_actors', { pattern: 'Cube' }, cm);
  t.assert(fake.lastCall('find_actors_by_name') !== undefined,
    'find_actors translates to find_actors_by_name');
  t.assert(fake.lastCall('find_actors_by_name').params.pattern === 'Cube',
    'find_actors passes pattern param through');

  // Direct-name tools should NOT be translated
  await executeActorsTool('spawn_actor', { type: 'PointLight', name: 'MyLight' }, cm);
  t.assert(fake.lastCall('spawn_actor') !== undefined,
    'spawn_actor is identity-mapped (no translation)');

  await executeActorsTool('delete_actor', { name: 'Cube' }, cm);
  t.assert(fake.lastCall('delete_actor') !== undefined,
    'delete_actor is identity-mapped');

  await executeActorsTool('set_actor_transform', { name: 'Cube', location: [100,200,0] }, cm);
  t.assert(fake.lastCall('set_actor_transform') !== undefined,
    'set_actor_transform is identity-mapped');

  await executeActorsTool('get_actor_properties', { name: 'Cube' }, cm);
  t.assert(fake.lastCall('get_actor_properties') !== undefined,
    'get_actor_properties is identity-mapped');

  await executeActorsTool('set_actor_property', { name: 'Cube', property_name: 'bHidden', property_value: true }, cm);
  t.assert(fake.lastCall('set_actor_property') !== undefined,
    'set_actor_property is identity-mapped');

  await executeActorsTool('spawn_blueprint_actor', { blueprint_name: 'BP_Player', actor_name: 'BP_Player_1' }, cm);
  t.assert(fake.lastCall('spawn_blueprint_actor') !== undefined,
    'spawn_blueprint_actor is identity-mapped');

  await executeActorsTool('focus_viewport', { target: 'Cube', distance: 500 }, cm);
  t.assert(fake.lastCall('focus_viewport') !== undefined,
    'focus_viewport is identity-mapped');

  await executeActorsTool('take_screenshot', { filepath: 'C:/Screenshots/test.png' }, cm);
  t.assert(fake.lastCall('take_screenshot') !== undefined,
    'take_screenshot is identity-mapped');
}

// ═══════════════════════════════════════════════════════════════
// Group 3: Param stripping — get_actors class_filter
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 3: Param Stripping ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_actors_in_level', {
    status: 'success',
    result: { actors: [] }
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // class_filter should be stripped before sending to C++
  await executeActorsTool('get_actors', { class_filter: 'StaticMeshActor' }, cm);
  const call = fake.lastCall('get_actors_in_level');
  t.assert(call !== undefined, 'get_actors sent to wire');
  t.assert(call.params.class_filter === undefined,
    'class_filter stripped from wire params (C++ handler does not support it)');
}

// ═══════════════════════════════════════════════════════════════
// Group 4: Error normalization — Format 1 (Bridge envelope)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 4: Error Format 1 — Bridge Envelope ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('delete_actor', { status: 'error', error: 'Actor not found: Ghost' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeActorsTool('delete_actor', { name: 'Ghost' }, cm),
    'Actor not found: Ghost',
    'Bridge error format throws with correct message'
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 5: Error normalization — Format 2 (CommonUtils)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 5: Error Format 2 — CommonUtils ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('set_actor_property', { success: false, error: 'Property not found: bGhost' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeActorsTool('set_actor_property', { name: 'Cube', property_name: 'bGhost', property_value: true }, cm),
    'Property not found: bGhost',
    'CommonUtils error format throws with correct message'
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 6: Error normalization — Format 2 with "message" field
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 6: Error Format 2 — "message" variant ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('spawn_actor', { success: false, message: 'Name collision: Cube already exists' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeActorsTool('spawn_actor', { type: 'StaticMeshActor', name: 'Cube' }, cm),
    'Name collision',
    'CommonUtils error with "message" field throws correctly'
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 7: Error normalization — Format 3 (UMG ad-hoc)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 7: Error Format 3 — UMG Ad-hoc ──');

{
  // This format comes from UMG commands, but we test it in ConnectionManager
  // because the normalization happens there, not in tcp-tools.mjs.
  // The ad-hoc response { error: "msg" } gets wrapped by Bridge as:
  // { status: "success", result: { error: "msg" } }

  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('some_umg_command', {
    status: 'success',
    result: { error: 'Widget not found: MyButton' }
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => cm.send('tcp-55557', 'some_umg_command', {}, { skipCache: true }),
    'Widget not found: MyButton',
    'UMG ad-hoc error (wrapped by Bridge) detected and thrown'
  );
}

{
  // Ensure a success response WITH an error field but also other data
  // is NOT treated as an error (false positive guard)
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('set_pawn_properties', {
    status: 'success',
    result: {
      blueprint: 'MyBP',
      success: true,
      results: {
        bUseControllerRotationYaw: { success: true },
        bCanBeDamaged: { success: false, error: 'Property not found' },
      },
    }
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // This should NOT throw — it's a partial success, not an error
  const result = await cm.send('tcp-55557', 'set_pawn_properties', {}, { skipCache: true });
  t.assert(result.status === 'success',
    'Partial success with nested error field is NOT treated as ad-hoc error');
}

// ═══════════════════════════════════════════════════════════════
// Group 8: TCP transport errors
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 8: Transport Errors ──');

{
  const errTimeout = new ErrorTcpResponder('timeout');
  const config1 = {
    projectRoot: 'D:/FakeProject',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    tcpTimeoutMs: 5000,
    tcpCommandFn: errTimeout.handler(),
  };
  const cm1 = new ConnectionManager(config1);

  await t.assertRejects(
    () => executeActorsTool('get_actors', {}, cm1),
    'timeout',
    'Timeout error propagates through executeActorsTool'
  );
}

{
  const errRefused = new ErrorTcpResponder('connection_refused');
  const config2 = {
    projectRoot: 'D:/FakeProject',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    tcpTimeoutMs: 5000,
    tcpCommandFn: errRefused.handler(),
  };
  const cm2 = new ConnectionManager(config2);

  await t.assertRejects(
    () => executeActorsTool('spawn_actor', { type: 'PointLight', name: 'L1' }, cm2),
    'ECONNREFUSED',
    'Connection refused error propagates through executeActorsTool'
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 9: Caching behavior
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 9: Caching ──');

{
  let callCount = 0;
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_actors_in_level', () => {
    callCount++;
    return {
      status: 'success',
      result: { actors: [{ name: 'Cube', class: 'StaticMeshActor', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }] }
    };
  });
  fake.on('spawn_actor', () => {
    callCount++;
    return {
      status: 'success',
      result: { name: 'Light', class: 'PointLight', location: [0,0,0], rotation: [0,0,0], scale: [1,1,1] }
    };
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Read op: first call hits TCP, second should use cache
  callCount = 0;
  await executeActorsTool('get_actors', {}, cm);
  await executeActorsTool('get_actors', {}, cm);
  t.assert(callCount === 1, 'Read op (get_actors) is cached — second call does not hit TCP');

  // Write op: every call hits TCP
  callCount = 0;
  await executeActorsTool('spawn_actor', { type: 'PointLight', name: 'L1' }, cm);
  await executeActorsTool('spawn_actor', { type: 'PointLight', name: 'L1' }, cm);
  t.assert(callCount === 2, 'Write op (spawn_actor) skips cache — both calls hit TCP');
}

// ═══════════════════════════════════════════════════════════════
// Group 10: Result pass-through
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 10: Result Pass-through ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_actors_in_level', {
    status: 'success',
    result: {
      actors: [
        { name: 'Cube', class: 'StaticMeshActor', location: [10, 20, 30], rotation: [0, 45, 0], scale: [2, 2, 2] },
        { name: 'Light', class: 'PointLight', location: [100, 0, 200], rotation: [0, 0, 0], scale: [1, 1, 1] },
      ]
    }
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const result = await executeActorsTool('get_actors', {}, cm);
  // ConnectionManager returns the full Bridge response — result.result has the actual data
  t.assert(result.status === 'success', 'Result has status: success');
  t.assert(result.result.actors.length === 2, 'Result passes through actor array');
  t.assert(result.result.actors[0].name === 'Cube', 'First actor name preserved');
  t.assert(result.result.actors[0].location[2] === 30, 'Vector data preserved in result');
}

// ═══════════════════════════════════════════════════════════════
// Group 11: Port routing
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 11: Port Routing ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_actors_in_level', {
    status: 'success',
    result: { actors: [] }
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeActorsTool('get_actors', {}, cm);
  const call = fake.lastCall('get_actors_in_level');
  t.assert(call.port === 55557,
    'Actors tools route to port 55557 (existing UnrealMCP plugin)');
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

const exitCode = t.summary();
process.exit(exitCode);
