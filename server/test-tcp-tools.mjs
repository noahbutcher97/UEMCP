// Tests for Phase 2 TCP tools — actors, blueprints-write, widgets
//
// Exercises:
//   1. Name translation via wire_type (tools.yaml → C++ type string)
//   2. Param pass-through and stripping (class_filter on get_actors)
//   3. Error normalization (all 3 formats: Bridge, CommonUtils, UMG ad-hoc)
//   4. Read-op caching vs write-op skip-cache
//   5. Tool registration completeness (all 3 toolsets)
//   6. Port routing (all tools → tcp-55557)
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-tcp-tools.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, ErrorTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import {
  initTcpTools,
  executeActorsTool, getActorsToolDefs, ACTORS_SCHEMAS,
  executeBlueprintsWriteTool, getBlueprintsWriteToolDefs, BLUEPRINTS_WRITE_SCHEMAS,
  executeWidgetsTool, getWidgetsToolDefs, WIDGETS_SCHEMAS,
} from './tcp-tools.mjs';

// ── Initialize wire_type maps from fake YAML structure ──────────
// Must be called before any execute*Tool() that relies on wire_type translation.
const fakeToolsYaml = {
  toolsets: {
    actors: {
      tools: {
        get_actors: { wire_type: 'get_actors_in_level' },
        find_actors: { wire_type: 'find_actors_by_name' },
        spawn_actor: {}, delete_actor: {}, set_actor_transform: {},
        get_actor_properties: {}, set_actor_property: {},
        spawn_blueprint_actor: {}, focus_viewport: {}, take_screenshot: {},
      }
    },
    'blueprints-write': {
      tools: {
        create_blueprint: {},
        add_component: { wire_type: 'add_component_to_blueprint' },
        set_component_property: {}, compile_blueprint: {}, set_blueprint_property: {},
        set_static_mesh_props: { wire_type: 'set_static_mesh_properties' },
        set_physics_props: { wire_type: 'set_physics_properties' },
        set_pawn_props: { wire_type: 'set_pawn_properties' },
        add_event_node: { wire_type: 'add_blueprint_event_node' },
        add_function_node: { wire_type: 'add_blueprint_function_node' },
        add_variable: { wire_type: 'add_blueprint_variable' },
        add_self_reference: { wire_type: 'add_blueprint_self_reference' },
        add_component_reference: { wire_type: 'add_blueprint_get_self_component_reference' },
        connect_nodes: { wire_type: 'connect_blueprint_nodes' },
        find_nodes: { wire_type: 'find_blueprint_nodes' },
      }
    },
    widgets: {
      tools: {
        create_widget: { wire_type: 'create_umg_widget_blueprint' },
        add_text_block: { wire_type: 'add_text_block_to_widget' },
        add_button: { wire_type: 'add_button_to_widget' },
        bind_widget_event: {}, set_text_block_binding: {}, add_widget_to_viewport: {},
        add_input_action_node: { wire_type: 'add_blueprint_input_action_node' },
      }
    },
  }
};
initTcpTools(fakeToolsYaml);

const t = new TestRunner('Phase 2 — TCP Tools (actors + blueprints-write + widgets)');

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
// Group 12: Blueprints-write — tool definitions
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 12: Blueprints-write Tool Definitions ──');

{
  const defs = getBlueprintsWriteToolDefs();
  const expectedBpTools = [
    'create_blueprint', 'add_component', 'set_component_property',
    'compile_blueprint', 'set_blueprint_property', 'set_static_mesh_props',
    'set_physics_props', 'set_pawn_props', 'add_event_node',
    'add_function_node', 'add_variable', 'add_self_reference',
    'add_component_reference', 'connect_nodes', 'find_nodes',
  ];

  t.assert(Object.keys(defs).length === 15, '15 blueprints-write tools defined');

  for (const name of expectedBpTools) {
    t.assert(defs[name] !== undefined, `BP tool "${name}" is defined`);
    t.assert(typeof defs[name].description === 'string' && defs[name].description.length > 0,
      `BP tool "${name}" has a non-empty description`);
    t.assert(typeof defs[name].schema === 'object', `BP tool "${name}" has a schema object`);
    t.assert(typeof defs[name].isReadOp === 'boolean', `BP tool "${name}" has isReadOp flag`);
  }

  // Read/write classification — only find_nodes is a read op
  t.assert(defs.find_nodes.isReadOp === true, 'find_nodes is a read op');
  t.assert(defs.create_blueprint.isReadOp === false, 'create_blueprint is a write op');
  t.assert(defs.add_component.isReadOp === false, 'add_component is a write op');
  t.assert(defs.compile_blueprint.isReadOp === false, 'compile_blueprint is a write op');
  t.assert(defs.connect_nodes.isReadOp === false, 'connect_nodes is a write op');
  t.assert(defs.add_variable.isReadOp === false, 'add_variable is a write op');
}

// ═══════════════════════════════════════════════════════════════
// Group 13: Blueprints-write — name translation
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 13: Blueprints-write Name Translation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const wireNames = {
    'add_component_to_blueprint': { status: 'success', result: { success: true } },
    'set_static_mesh_properties': { status: 'success', result: { success: true } },
    'set_physics_properties': { status: 'success', result: { success: true } },
    'set_pawn_properties': { status: 'success', result: { success: true } },
    'add_blueprint_event_node': { status: 'success', result: { node_id: 'abc-123' } },
    'add_blueprint_function_node': { status: 'success', result: { node_id: 'def-456' } },
    'add_blueprint_variable': { status: 'success', result: { success: true } },
    'add_blueprint_self_reference': { status: 'success', result: { node_id: 'ghi-789' } },
    'add_blueprint_get_self_component_reference': { status: 'success', result: { node_id: 'jkl-012' } },
    'connect_blueprint_nodes': { status: 'success', result: { success: true } },
    'find_blueprint_nodes': { status: 'success', result: { nodes: [] } },
    'create_blueprint': { status: 'success', result: { path: '/Game/Blueprints/MyBP' } },
    'set_component_property': { status: 'success', result: { success: true } },
    'compile_blueprint': { status: 'success', result: { success: true } },
    'set_blueprint_property': { status: 'success', result: { success: true } },
  };

  for (const [name, resp] of Object.entries(wireNames)) {
    fake.on(name, resp);
  }

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeBlueprintsWriteTool('add_component', { blueprint_name: 'BP', component_type: 'StaticMesh', component_name: 'Mesh' }, cm);
  t.assert(fake.lastCall('add_component_to_blueprint') !== undefined, 'add_component -> add_component_to_blueprint');

  await executeBlueprintsWriteTool('set_static_mesh_props', { blueprint_name: 'BP', component_name: 'Mesh' }, cm);
  t.assert(fake.lastCall('set_static_mesh_properties') !== undefined, 'set_static_mesh_props -> set_static_mesh_properties');

  await executeBlueprintsWriteTool('set_physics_props', { blueprint_name: 'BP', component_name: 'Mesh' }, cm);
  t.assert(fake.lastCall('set_physics_properties') !== undefined, 'set_physics_props -> set_physics_properties');

  await executeBlueprintsWriteTool('set_pawn_props', { blueprint_name: 'BP' }, cm);
  t.assert(fake.lastCall('set_pawn_properties') !== undefined, 'set_pawn_props -> set_pawn_properties');

  await executeBlueprintsWriteTool('add_event_node', { blueprint_name: 'BP', event_name: 'ReceiveBeginPlay' }, cm);
  t.assert(fake.lastCall('add_blueprint_event_node') !== undefined, 'add_event_node -> add_blueprint_event_node');

  await executeBlueprintsWriteTool('add_function_node', { blueprint_name: 'BP', function_name: 'PrintString' }, cm);
  t.assert(fake.lastCall('add_blueprint_function_node') !== undefined, 'add_function_node -> add_blueprint_function_node');

  await executeBlueprintsWriteTool('add_variable', { blueprint_name: 'BP', variable_name: 'Speed', variable_type: 'Float' }, cm);
  t.assert(fake.lastCall('add_blueprint_variable') !== undefined, 'add_variable -> add_blueprint_variable');

  await executeBlueprintsWriteTool('add_self_reference', { blueprint_name: 'BP' }, cm);
  t.assert(fake.lastCall('add_blueprint_self_reference') !== undefined, 'add_self_reference -> add_blueprint_self_reference');

  await executeBlueprintsWriteTool('add_component_reference', { blueprint_name: 'BP', component_name: 'Mesh' }, cm);
  t.assert(fake.lastCall('add_blueprint_get_self_component_reference') !== undefined, 'add_component_reference -> add_blueprint_get_self_component_reference');

  await executeBlueprintsWriteTool('connect_nodes', { blueprint_name: 'BP', source_node_id: 'a', target_node_id: 'b', source_pin: 'then', target_pin: 'execute' }, cm);
  t.assert(fake.lastCall('connect_blueprint_nodes') !== undefined, 'connect_nodes -> connect_blueprint_nodes');

  await executeBlueprintsWriteTool('find_nodes', { blueprint_name: 'BP', node_type: 'Event' }, cm);
  t.assert(fake.lastCall('find_blueprint_nodes') !== undefined, 'find_nodes -> find_blueprint_nodes');

  await executeBlueprintsWriteTool('create_blueprint', { name: 'MyBP' }, cm);
  t.assert(fake.lastCall('create_blueprint') !== undefined, 'create_blueprint is identity-mapped');

  await executeBlueprintsWriteTool('set_component_property', { blueprint_name: 'BP', component_name: 'Mesh', property_name: 'Mobility', property_value: 'Movable' }, cm);
  t.assert(fake.lastCall('set_component_property') !== undefined, 'set_component_property is identity-mapped');

  await executeBlueprintsWriteTool('compile_blueprint', { blueprint_name: 'BP' }, cm);
  t.assert(fake.lastCall('compile_blueprint') !== undefined, 'compile_blueprint is identity-mapped');

  await executeBlueprintsWriteTool('set_blueprint_property', { blueprint_name: 'BP', property_name: 'bCanBeDamaged', property_value: false }, cm);
  t.assert(fake.lastCall('set_blueprint_property') !== undefined, 'set_blueprint_property is identity-mapped');
}

// ═══════════════════════════════════════════════════════════════
// Group 14: Blueprints-write — param pass-through
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 14: Blueprints-write Param Pass-through ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_component_to_blueprint', { status: 'success', result: { success: true } });
  fake.on('add_blueprint_function_node', { status: 'success', result: { node_id: 'n1' } });
  fake.on('connect_blueprint_nodes', { status: 'success', result: { success: true } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeBlueprintsWriteTool('add_component', {
    blueprint_name: 'BP_Car', component_type: 'StaticMeshComponent',
    component_name: 'Body', location: [0, 0, 50], scale: [2, 2, 2],
  }, cm);
  const addCompCall = fake.lastCall('add_component_to_blueprint');
  t.assert(addCompCall.params.blueprint_name === 'BP_Car', 'add_component: blueprint_name passed');
  t.assert(addCompCall.params.component_type === 'StaticMeshComponent', 'add_component: component_type passed');
  t.assert(addCompCall.params.component_name === 'Body', 'add_component: component_name passed');
  t.assert(JSON.stringify(addCompCall.params.location) === '[0,0,50]', 'add_component: location vector passed');
  t.assert(JSON.stringify(addCompCall.params.scale) === '[2,2,2]', 'add_component: scale vector passed');

  await executeBlueprintsWriteTool('add_function_node', {
    blueprint_name: 'BP_Test', function_name: 'PrintString',
    target: 'KismetSystemLibrary', params: { InString: 'Hello' },
  }, cm);
  const fnCall = fake.lastCall('add_blueprint_function_node');
  t.assert(fnCall.params.target === 'KismetSystemLibrary', 'add_function_node: target passed');
  t.assert(fnCall.params.params.InString === 'Hello', 'add_function_node: nested params object passed');

  await executeBlueprintsWriteTool('connect_nodes', {
    blueprint_name: 'BP_Test', source_node_id: 'guid-1', target_node_id: 'guid-2',
    source_pin: 'then', target_pin: 'execute',
  }, cm);
  const connCall = fake.lastCall('connect_blueprint_nodes');
  t.assert(connCall.params.source_node_id === 'guid-1', 'connect_nodes: source_node_id passed');
  t.assert(connCall.params.target_pin === 'execute', 'connect_nodes: target_pin passed');
}

// ═══════════════════════════════════════════════════════════════
// Group 15: Blueprints-write — caching (find_nodes = read, others = write)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 15: Blueprints-write Caching ──');

{
  let callCount = 0;
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('find_blueprint_nodes', () => { callCount++; return { status: 'success', result: { nodes: [] } }; });
  fake.on('create_blueprint', () => { callCount++; return { status: 'success', result: { path: '/Game/Blueprints/BP' } }; });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  callCount = 0;
  await executeBlueprintsWriteTool('find_nodes', { blueprint_name: 'BP', node_type: 'Event' }, cm);
  await executeBlueprintsWriteTool('find_nodes', { blueprint_name: 'BP', node_type: 'Event' }, cm);
  t.assert(callCount === 1, 'find_nodes (read op) is cached — second call skips TCP');

  callCount = 0;
  await executeBlueprintsWriteTool('create_blueprint', { name: 'BP1' }, cm);
  await executeBlueprintsWriteTool('create_blueprint', { name: 'BP1' }, cm);
  t.assert(callCount === 2, 'create_blueprint (write op) skips cache — both calls hit TCP');
}

// ═══════════════════════════════════════════════════════════════
// Group 16: Blueprints-write — port routing
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 16: Blueprints-write Port Routing ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_component_to_blueprint', { status: 'success', result: { success: true } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeBlueprintsWriteTool('add_component', { blueprint_name: 'BP', component_type: 'SM', component_name: 'M' }, cm);
  const call = fake.lastCall('add_component_to_blueprint');
  t.assert(call.port === 55557, 'Blueprints-write tools route to port 55557');
}

// ═══════════════════════════════════════════════════════════════
// Group 17: Widgets — tool definitions
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 17: Widgets Tool Definitions ──');

{
  const defs = getWidgetsToolDefs();
  const expectedWidgetTools = [
    'create_widget', 'add_text_block', 'add_button',
    'bind_widget_event', 'set_text_block_binding',
    'add_widget_to_viewport', 'add_input_action_node',
  ];

  t.assert(Object.keys(defs).length === 7, '7 widgets tools defined');

  for (const name of expectedWidgetTools) {
    t.assert(defs[name] !== undefined, `Widget tool "${name}" is defined`);
    t.assert(typeof defs[name].description === 'string' && defs[name].description.length > 0,
      `Widget tool "${name}" has a non-empty description`);
    t.assert(typeof defs[name].schema === 'object', `Widget tool "${name}" has a schema object`);
    t.assert(typeof defs[name].isReadOp === 'boolean', `Widget tool "${name}" has isReadOp flag`);
  }

  for (const name of expectedWidgetTools) {
    t.assert(defs[name].isReadOp === false, `Widget tool "${name}" is a write op`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Group 18: Widgets — name translation
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 18: Widgets Name Translation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const wireNames = {
    'create_umg_widget_blueprint': { status: 'success', result: { path: '/Game/Widgets/MyWidget' } },
    'add_text_block_to_widget': { status: 'success', result: { success: true } },
    'add_button_to_widget': { status: 'success', result: { success: true } },
    'add_blueprint_input_action_node': { status: 'success', result: { node_id: 'n1' } },
    'bind_widget_event': { status: 'success', result: { success: true } },
    'set_text_block_binding': { status: 'success', result: { success: true } },
    'add_widget_to_viewport': { status: 'success', result: { class_path: '/Game/Widgets/MyWidget.MyWidget_C' } },
  };

  for (const [name, resp] of Object.entries(wireNames)) {
    fake.on(name, resp);
  }

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeWidgetsTool('create_widget', { name: 'MyWidget' }, cm);
  t.assert(fake.lastCall('create_umg_widget_blueprint') !== undefined, 'create_widget -> create_umg_widget_blueprint');

  await executeWidgetsTool('add_text_block', { blueprint_name: 'W', widget_name: 'Title', text: 'Hello' }, cm);
  t.assert(fake.lastCall('add_text_block_to_widget') !== undefined, 'add_text_block -> add_text_block_to_widget');

  await executeWidgetsTool('add_button', { blueprint_name: 'W', widget_name: 'Btn', text: 'Click' }, cm);
  t.assert(fake.lastCall('add_button_to_widget') !== undefined, 'add_button -> add_button_to_widget');

  await executeWidgetsTool('add_input_action_node', { blueprint_name: 'W', action_name: 'Jump' }, cm);
  t.assert(fake.lastCall('add_blueprint_input_action_node') !== undefined, 'add_input_action_node -> add_blueprint_input_action_node');

  await executeWidgetsTool('bind_widget_event', { blueprint_name: 'W', widget_name: 'Btn', event_name: 'OnClicked' }, cm);
  t.assert(fake.lastCall('bind_widget_event') !== undefined, 'bind_widget_event is identity-mapped');

  await executeWidgetsTool('set_text_block_binding', { blueprint_name: 'W', widget_name: 'Title', binding_name: 'ScoreText' }, cm);
  t.assert(fake.lastCall('set_text_block_binding') !== undefined, 'set_text_block_binding is identity-mapped');

  await executeWidgetsTool('add_widget_to_viewport', { blueprint_name: 'W' }, cm);
  t.assert(fake.lastCall('add_widget_to_viewport') !== undefined, 'add_widget_to_viewport is identity-mapped');
}

// ═══════════════════════════════════════════════════════════════
// Group 19: Widgets — param pass-through
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 19: Widgets Param Pass-through ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_button_to_widget', { status: 'success', result: { success: true } });
  fake.on('add_widget_to_viewport', { status: 'success', result: { class_path: '/Game/Widgets/W.W_C' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeWidgetsTool('add_button', {
    blueprint_name: 'HUD', widget_name: 'StartBtn', text: 'Start Game', position: [100, 200],
  }, cm);
  const btnCall = fake.lastCall('add_button_to_widget');
  t.assert(btnCall.params.blueprint_name === 'HUD', 'add_button: blueprint_name passed');
  t.assert(btnCall.params.text === 'Start Game', 'add_button: text passed');
  t.assert(JSON.stringify(btnCall.params.position) === '[100,200]', 'add_button: position vector passed');

  await executeWidgetsTool('add_widget_to_viewport', { blueprint_name: 'HUD', z_order: 5 }, cm);
  const vpCall = fake.lastCall('add_widget_to_viewport');
  t.assert(vpCall.params.z_order === 5, 'add_widget_to_viewport: z_order passed');
}

// ═══════════════════════════════════════════════════════════════
// Group 20: Widgets — port routing
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 20: Widgets Port Routing ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_umg_widget_blueprint', { status: 'success', result: { path: '/Game/Widgets/W' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeWidgetsTool('create_widget', { name: 'W' }, cm);
  const call = fake.lastCall('create_umg_widget_blueprint');
  t.assert(call.port === 55557, 'Widgets tools route to port 55557');
}

// ═══════════════════════════════════════════════════════════════
// Group 21: initTcpTools — wire_type map building
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 21: initTcpTools Wire Map Building ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_component', { status: 'success', result: { success: true } });

  initTcpTools({ toolsets: {} });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeBlueprintsWriteTool('add_component', { blueprint_name: 'BP', component_type: 'SM', component_name: 'M' }, cm);
  t.assert(fake.lastCall('add_component') !== undefined,
    'With empty wire map, tool name is used as-is (identity fallback)');

  initTcpTools(fakeToolsYaml);
}

// ═══════════════════════════════════════════════════════════════
// Group 22: P0-1 expanded — additional wire-error shapes
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 22: P0-1 Expanded Error Coverage ──');

{
  // Format 1 using "message" (not "error") field
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('delete_actor', { status: 'error', message: 'Level not loaded' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeActorsTool('delete_actor', { name: 'Ghost' }, cm),
    'Level not loaded',
    'Format 1 (status:error) with message field throws correctly'
  );
}

{
  // Raw ad-hoc single-key escape — {error:"msg"} with no envelope flags
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('some_umg_command', { error: 'Raw ad-hoc escape' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => cm.send('tcp-55557', 'some_umg_command', {}, { skipCache: true }),
    'Raw ad-hoc escape',
    'Raw single-key {error} (no envelope) detected as wire error'
  );
}

{
  // Sibling error on success envelope — {status:"success", error:"msg"}
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('some_cmd', { status: 'success', error: 'Sibling-error leak' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => cm.send('tcp-55557', 'some_cmd', {}, { skipCache: true }),
    'Sibling-error leak',
    'Success envelope with sibling error field detected as wire error'
  );
}

{
  // False-positive guard: {result:{error:"msg", ...more fields}} is NOT an error
  // (only single-key {error:"..."} inside result triggers ad-hoc detection)
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('some_cmd', {
    status: 'success',
    result: { error: 'validation note', widget: 'OK', ok: true }
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const r = await cm.send('tcp-55557', 'some_cmd', {}, { skipCache: true });
  t.assert(r.status === 'success',
    'Multi-key result with error field is not treated as ad-hoc error');
}

// ═══════════════════════════════════════════════════════════════
// Group 23: P0-7 — widget path suffix normalization
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 23: P0-7 Widget Path Suffix Strip ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_umg_widget_blueprint', { status: 'success', result: { success: true } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeWidgetsTool('create_widget', { name: 'MyHUD.MyHUD' }, cm);
  const call = fake.lastCall('create_umg_widget_blueprint');
  t.assert(call.params.name === 'MyHUD',
    'create_widget strips "Name.Name" self-doubled suffix on name param');
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_text_block_to_widget', { status: 'success', result: { success: true } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeWidgetsTool('add_text_block',
    { blueprint_name: 'MyHUD.MyHUD', widget_name: 'TitleText' }, cm);
  const call = fake.lastCall('add_text_block_to_widget');
  t.assert(call.params.blueprint_name === 'MyHUD',
    'add_text_block strips "Name.Name" on blueprint_name');
  t.assert(call.params.widget_name === 'TitleText',
    'add_text_block leaves widget_name untouched');
}

{
  // No-op: plain name unchanged
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_umg_widget_blueprint', { status: 'success', result: { success: true } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeWidgetsTool('create_widget', { name: 'MyHUD' }, cm);
  const call = fake.lastCall('create_umg_widget_blueprint');
  t.assert(call.params.name === 'MyHUD',
    'Plain name (no dot) is unchanged by suffix stripper');
}

{
  // No-op: Name.Other (different halves) unchanged
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_text_block_to_widget', { status: 'success', result: { success: true } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeWidgetsTool('add_text_block',
    { blueprint_name: 'MyHUD.Other', widget_name: 'T' }, cm);
  const call = fake.lastCall('add_text_block_to_widget');
  t.assert(call.params.blueprint_name === 'MyHUD.Other',
    'Non-self-doubled dot pattern (Name.Other) is unchanged');
}

// ═══════════════════════════════════════════════════════════════
// Group 24: P0-9 — required-param rejection at Zod layer
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 24: P0-9 Required Param Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // spawn_actor requires both `type` and `name` — omit `name`
  await t.assertRejects(
    () => executeActorsTool('spawn_actor', { type: 'PointLight' }, cm),
    /name/i,
    'spawn_actor rejects when required `name` is missing (before wire)'
  );

  t.assert(fake.lastCall('spawn_actor') === undefined,
    'Invalid request never reached the wire (no spawn_actor call made)');
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // add_text_block requires blueprint_name + widget_name
  await t.assertRejects(
    () => executeWidgetsTool('add_text_block', { blueprint_name: 'HUD' }, cm),
    /widget_name/i,
    'add_text_block rejects when required `widget_name` is missing'
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 25: P0-10 — vector/rotator shape validation
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 25: P0-10 Vector Shape Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Vec3 must be length 3 — length 2 should reject
  await t.assertRejects(
    () => executeActorsTool('spawn_actor',
      { type: 'StaticMeshActor', name: 'Cube', location: [1, 2] }, cm),
    /array/i,
    'spawn_actor rejects 2-element location (Vec3 requires length 3)'
  );

  t.assert(fake.lastCall('spawn_actor') === undefined,
    'Malformed vector never reached the wire');
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Vec3 length 4 should also reject
  await t.assertRejects(
    () => executeActorsTool('set_actor_transform',
      { name: 'Cube', rotation: [1, 2, 3, 4] }, cm),
    /array/i,
    'set_actor_transform rejects 4-element rotation vector'
  );
}

{
  // Happy path: valid Vec3 passes through
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('set_actor_transform', { status: 'success', result: { success: true } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeActorsTool('set_actor_transform',
    { name: 'Cube', location: [1, 2, 3], rotation: [0, 90, 0] }, cm);
  const call = fake.lastCall('set_actor_transform');
  t.assert(Array.isArray(call.params.location) && call.params.location.length === 3,
    'Valid Vec3 passes through to wire unmodified');
}

// ═══════════════════════════════════════════════════════════════
// M-enhance CP4 — FULL-TCP subset (10 tools against CP3 plugin handlers)
// ═══════════════════════════════════════════════════════════════

{
  console.log('\n═══ M-enhance CP4: TCP dispatch (FULL-TCP subset) ═══\n');

  const { readFileSync } = await import('node:fs');
  const yaml = (await import('js-yaml')).default;
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const __dirname = dirname(fileURLToPath(import.meta.url));
  const toolsData = yaml.load(readFileSync(join(__dirname, '..', 'tools.yaml'), 'utf-8'));

  const {
    initMenhanceTools,
    executeMenhanceTool,
    MENHANCE_SCHEMAS,
  } = await import('./menhance-tcp-tools.mjs');

  initMenhanceTools(toolsData);

  // ── Schema surface matches the 10 tools we intend to ship ─────
  const expected = [
    'bp_compile_and_report',
    'get_blueprint_event_dispatchers',
    'get_widget_blueprint',
    'get_material_graph',
    'get_editor_state',
    'start_pie', 'stop_pie', 'is_pie_running',
    'execute_console_command',
    'get_asset_references',
  ];
  for (const name of expected) {
    t.assert(MENHANCE_SCHEMAS[name] !== undefined, `MENHANCE_SCHEMAS has ${name}`);
  }

  // ── Dispatch: verify each tool hits tcp-55558 with correct wire type ──
  {
    const fake = new FakeTcpResponder();
    fake.on('ping',                     { status: 'success' });
    fake.on('bp_compile_and_report',    { status: 'success', result: { compiled_ok: true, num_errors: 0 } });
    fake.on('get_event_dispatchers',    { status: 'success', result: { dispatchers: [] } });
    fake.on('get_widget_blueprint',     { status: 'success', result: { asset_path: '/Game/X' } });
    fake.on('get_material_graph',       { status: 'success', result: { nodes: [] } });
    fake.on('get_editor_state',         { status: 'success', result: { pie_running: false } });
    fake.on('start_pie',                { status: 'success', result: { requested: true } });
    fake.on('stop_pie',                 { status: 'success', result: { was_running: false } });
    fake.on('is_pie_running',           { status: 'success', result: { running: false } });
    fake.on('execute_console_command',  { status: 'success', result: { executed: true } });
    fake.on('get_asset_references',     { status: 'success', result: { num_referencers: 0 } });

    const { config } = createTestConfig('D:/FakeProject', fake);
    const cm = new ConnectionManager(config);

    // bp_compile_and_report
    await executeMenhanceTool('bp_compile_and_report', { asset_path: '/Game/X' }, cm);
    {
      const call = fake.lastCall('bp_compile_and_report');
      t.assert(call && call.port === 55558, 'bp_compile_and_report routed to tcp-55558');
      t.assert(call.params.asset_path === '/Game/X', 'bp_compile_and_report forwards asset_path');
    }

    // get_blueprint_event_dispatchers → wire_type get_event_dispatchers
    await executeMenhanceTool('get_blueprint_event_dispatchers', { asset_path: '/Game/X' }, cm);
    {
      const call = fake.lastCall('get_event_dispatchers');
      t.assert(call && call.port === 55558,
        'get_blueprint_event_dispatchers translates to wire_type get_event_dispatchers');
      t.assert(fake.lastCall('get_blueprint_event_dispatchers') === undefined,
        'original tool name NOT used as wire type');
    }

    // Simple round-trip for the rest (dispatch + response shape)
    for (const [tool, params] of [
      ['get_widget_blueprint',    { asset_path: '/Game/X' }],
      ['get_material_graph',      { asset_path: '/Game/X' }],
      ['get_editor_state',        {}],
      ['start_pie',               { mode: 'viewport' }],
      ['stop_pie',                {}],
      ['is_pie_running',          {}],
      ['execute_console_command', { command: 'stat fps' }],
      ['get_asset_references',    { asset_path: '/Game/X' }],
    ]) {
      const r = await executeMenhanceTool(tool, params, cm);
      t.assert(r && typeof r === 'object', `${tool} returns object`);
    }
  }

  // ── isReadOp → skipCache contract ─────────────────────────────
  {
    const fake = new FakeTcpResponder();
    fake.on('ping', { status: 'success' });
    fake.on('get_asset_references', { status: 'success', result: { num_referencers: 1 } });
    fake.on('bp_compile_and_report', { status: 'success', result: { compiled_ok: true } });

    const { config } = createTestConfig('D:/FakeProject', fake);
    const cm = new ConnectionManager(config);

    // get_asset_references is a read — second call hits cache
    await executeMenhanceTool('get_asset_references', { asset_path: '/Game/X' }, cm);
    await executeMenhanceTool('get_asset_references', { asset_path: '/Game/X' }, cm);
    t.assert(fake.callsFor('get_asset_references').length === 1,
      'get_asset_references (read) caches — second call served from cache');

    // bp_compile_and_report is write — both calls hit wire
    await executeMenhanceTool('bp_compile_and_report', { asset_path: '/Game/X' }, cm);
    await executeMenhanceTool('bp_compile_and_report', { asset_path: '/Game/X' }, cm);
    t.assert(fake.callsFor('bp_compile_and_report').length === 2,
      'bp_compile_and_report (write) bypasses cache');
  }

  // ── Zod validation + unknown-tool rejection ───────────────────
  {
    const { config } = createTestConfig('D:/FakeProject');
    const cm = new ConnectionManager(config);

    await t.assertRejects(
      () => executeMenhanceTool('bp_compile_and_report', {}, cm),
      /asset_path/,
      'bp_compile_and_report rejects missing asset_path'
    );

    await t.assertRejects(
      () => executeMenhanceTool('execute_console_command', {}, cm),
      /command/,
      'execute_console_command rejects missing command'
    );

    await t.assertRejects(
      () => executeMenhanceTool('unknown_tool', {}, cm),
      /unknown tool/,
      'executeMenhanceTool rejects unknown tool name'
    );
  }

  // ── Wire-type map identity fallback ───────────────────────────
  {
    const fake = new FakeTcpResponder();
    fake.on('ping', { status: 'success' });
    fake.on('get_material_graph', { status: 'success', result: { nodes: [] } });

    const { config } = createTestConfig('D:/FakeProject', fake);
    const cm = new ConnectionManager(config);

    // get_material_graph has no wire_type override → identity
    await executeMenhanceTool('get_material_graph', { asset_path: '/Game/M' }, cm);
    const call = fake.lastCall('get_material_graph');
    t.assert(call && call.port === 55558,
      'get_material_graph falls back to identity wire type when no override');
  }

  // ── PARTIAL-RC schema completeness ────────────────────────────
  {
    const expectedPartial = [
      'get_blueprint_info', 'get_blueprint_variables', 'get_blueprint_functions',
      'get_blueprint_components', 'get_niagara_system_info',
      'get_montage_full', 'get_anim_sequence_info', 'get_blend_space',
      'get_anim_curve_data', 'get_struct_definition',
      'get_datatable_contents', 'get_string_table', 'list_data_asset_types',
    ];
    for (const name of expectedPartial) {
      t.assert(MENHANCE_SCHEMAS[name] !== undefined, `MENHANCE_SCHEMAS has ${name}`);
      t.assert(MENHANCE_SCHEMAS[name].partialRc !== undefined,
        `${name} declares partialRc dispatch config`);
    }
  }

  // ── PARTIAL-RC: reflection_walk-backed tools dispatch correctly ──
  {
    const fakeReflectionResponse = {
      status: 'success',
      result: {
        name: 'BP_Player_C',
        path: '/Game/Blueprints/BP_Player.BP_Player_C',
        super_class: '/Script/Engine.Character',
        interfaces: ['/Script/Engine.IHittable'],
        class_flags: ['Blueprintable'],
        properties: [
          { name: 'Health', cpp_type: 'float', class: 'FloatProperty',
            flags: ['BlueprintReadWrite', 'Replicated'], metadata: { Category: 'Stats' } },
          { name: 'MeshComp', cpp_type: 'UStaticMeshComponent*', class: 'ObjectProperty',
            property_class: '/Script/Engine.StaticMeshComponent', flags: [], metadata: {} },
          { name: 'InventoryVar_GEN_VARIABLE', cpp_type: 'UObject*', class: 'ObjectProperty',
            flags: [], metadata: {} },
        ],
        functions: [
          { name: 'Jump', flags: ['BlueprintCallable'], parameters: [] },
          { name: 'TakeDamage', flags: ['BlueprintCallable'], parameters: [] },
        ],
      },
    };

    const fake = new FakeTcpResponder();
    fake.on('ping', { status: 'success' });
    fake.on('reflection_walk', fakeReflectionResponse);

    const { config } = createTestConfig('D:/FakeProject', fake);
    const cm = new ConnectionManager(config);

    // get_blueprint_info — summary transform
    const info = await executeMenhanceTool('get_blueprint_info', { asset_path: '/Game/BP' }, cm);
    t.assert(info.name === 'BP_Player_C', 'blueprint_info transform extracts name');
    t.assert(info.super_class === '/Script/Engine.Character', 'blueprint_info emits super_class');
    t.assert(info.property_count === 3, `blueprint_info counts properties (got ${info.property_count})`);
    t.assert(info.function_count === 2, 'blueprint_info counts functions');
    t.assert(Array.isArray(info.interfaces), 'blueprint_info includes interfaces');

    // Wire check — went to reflection_walk, not to get_blueprint_info
    t.assert(fake.lastCall('reflection_walk') !== undefined,
      'get_blueprint_info dispatches to reflection_walk wire type');
    t.assert(fake.lastCall('get_blueprint_info') === undefined,
      'get_blueprint_info does NOT use identity wire type');

    // get_blueprint_variables — extract properties[]
    fake.resetCalls();
    const vars = await executeMenhanceTool('get_blueprint_variables', { asset_path: '/Game/BP' }, cm);
    // Cache is shared: reflection_walk was just called above, same args → cached.
    // Use unique arg to bypass cache.
    // Actually above used same asset_path; second call will cache-hit. Accept that.
    t.assert(Array.isArray(vars.variables), 'blueprint_variables returns array');
    t.assert(vars.count === 3, 'blueprint_variables counts correctly');
    t.assert(vars.variables[0].name === 'Health', 'blueprint_variables preserves property shape');

    // get_blueprint_functions — extract functions[]
    const fns = await executeMenhanceTool('get_blueprint_functions', { asset_path: '/Game/BP' }, cm);
    t.assert(fns.count === 2, 'blueprint_functions counts correctly');
    t.assert(fns.functions[0].name === 'Jump', 'blueprint_functions preserves function shape');

    // get_blueprint_components — filter for component-like properties
    const comps = await executeMenhanceTool('get_blueprint_components', { asset_path: '/Game/BP' }, cm);
    t.assert(comps.count === 2,
      `blueprint_components filters correctly (MeshComp + _GEN_VARIABLE, got ${comps.count})`);
    t.assert(comps.components.some(c => c.name === 'MeshComp'),
      'blueprint_components identifies MeshComp via property_class');
    t.assert(comps.components.some(c => c.name === 'InventoryVar_GEN_VARIABLE'),
      'blueprint_components catches SCS _GEN_VARIABLE suffix');
    t.assert(!comps.components.some(c => c.name === 'Health'),
      'blueprint_components excludes non-component Health');
  }

  // ── PARTIAL-RC: identity transforms pass through plugin response ──
  {
    const fake = new FakeTcpResponder();
    fake.on('ping', { status: 'success' });
    fake.on('reflection_walk', {
      status: 'success',
      result: { name: 'UNiagaraSystem', properties: [], functions: [] },
    });
    fake.on('get_struct_reflection', {
      status: 'success',
      result: { name: 'FMyStruct', properties: [{ name: 'Field1' }] },
    });
    fake.on('get_datatable_contents', {
      status: 'success',
      result: { asset_path: '/Game/DT', num_rows: 5, csv: 'a,b\n1,2' },
    });
    fake.on('get_string_table_contents', {
      status: 'success',
      result: { namespace: 'UI', entries: [{ key: 'hello', source: 'Hello' }] },
    });
    fake.on('list_data_asset_types', {
      status: 'success',
      result: { num_classes: 42, classes: [] },
    });

    const { config } = createTestConfig('D:/FakeProject', fake);
    const cm = new ConnectionManager(config);

    // Niagara — identity pass-through
    const niagara = await executeMenhanceTool('get_niagara_system_info', { asset_path: '/Game/N' }, cm);
    t.assert(niagara.name === 'UNiagaraSystem', 'get_niagara_system_info pass-through');

    // Struct — dispatches to get_struct_reflection
    const struct = await executeMenhanceTool('get_struct_definition', { asset_path: '/Game/S' }, cm);
    t.assert(struct.name === 'FMyStruct', 'get_struct_definition pass-through');
    t.assert(fake.lastCall('get_struct_reflection'),
      'get_struct_definition dispatches to get_struct_reflection wire type');

    // DataTable — dedicated wire type
    const dt = await executeMenhanceTool('get_datatable_contents', { asset_path: '/Game/DT' }, cm);
    t.assert(dt.num_rows === 5, 'get_datatable_contents pass-through');
    t.assert(dt.csv.includes('a,b'), 'CSV content preserved');

    // StringTable — dedicated wire type (note: tool name is get_string_table but wire is get_string_table_contents)
    const st = await executeMenhanceTool('get_string_table', { asset_path: '/Game/ST' }, cm);
    t.assert(st.namespace === 'UI', 'get_string_table pass-through');
    t.assert(fake.lastCall('get_string_table_contents'),
      'get_string_table translates to get_string_table_contents');

    // list_data_asset_types — no params
    const types = await executeMenhanceTool('list_data_asset_types', {}, cm);
    t.assert(types.num_classes === 42, 'list_data_asset_types pass-through');

    // Animation tools — each hits reflection_walk with identity transform
    fake.resetCalls();
    for (const tool of ['get_montage_full', 'get_anim_sequence_info', 'get_blend_space', 'get_anim_curve_data']) {
      await executeMenhanceTool(tool, { asset_path: '/Game/Anim/Uniq' + tool }, cm);
    }
    const reflectionCalls = fake.callsFor('reflection_walk');
    t.assert(reflectionCalls.length >= 4,
      `4 animation tools each dispatch to reflection_walk (got ${reflectionCalls.length})`);
  }

  // ── S4: get_asset_preview_render dispatches to tcp-55558 ─────
  {
    const fakePng = 'iVBORw0KGgoAAAANSUhEUgAA...';  // truncated base64
    const fake = new FakeTcpResponder();
    fake.on('ping', { status: 'success' });
    fake.on('get_asset_preview_render', {
      status: 'success',
      result: {
        asset_path: '/Game/Meshes/SM_Cube.SM_Cube',
        asset_class: 'StaticMesh',
        width: 256, height: 256,
        mime: 'image/png',
        byte_length: 4096,
        base64: fakePng,
      },
    });

    const { config } = createTestConfig('D:/FakeProject', fake);
    const cm = new ConnectionManager(config);

    const res = await executeMenhanceTool('get_asset_preview_render',
      { asset_path: '/Game/Meshes/SM_Cube.SM_Cube' }, cm);
    t.assert(res && res.result && res.result.base64 === fakePng,
      'get_asset_preview_render returns inline base64 PNG');
    t.assert(res.result.width === 256 && res.result.height === 256,
      'dimensions round-trip through wire');
    t.assert(res.result.mime === 'image/png',
      'MIME type preserved');

    const call = fake.lastCall('get_asset_preview_render');
    t.assert(call && call.port === 55558,
      'get_asset_preview_render routed to tcp-55558');

    // Width/height/return_base64 passthrough
    fake.resetCalls();
    await executeMenhanceTool('get_asset_preview_render',
      { asset_path: '/Game/X', width: 512, height: 512, return_base64: false }, cm);
    const call2 = fake.lastCall('get_asset_preview_render');
    t.assert(call2.params.width === 512 && call2.params.height === 512,
      'width/height forwarded to wire');
    t.assert(call2.params.return_base64 === false,
      'return_base64 flag forwarded');

    // Zod validation
    await t.assertRejects(
      () => executeMenhanceTool('get_asset_preview_render', {}, cm),
      /asset_path/,
      'get_asset_preview_render rejects missing asset_path'
    );
  }

  // ── CP5: regenerate_sidecar dispatches to tcp-55558 as mutation ──
  {
    const fake = new FakeTcpResponder();
    fake.on('ping', { status: 'success' });
    fake.on('regenerate_sidecar', {
      status: 'success',
      result: {
        written: true,
        asset_path: '/Game/BP/BP_X',
        sidecar_path: 'D:/Proj/Saved/UEMCP/Game/BP/BP_X.sidecar.json',
      },
    });

    const { config } = createTestConfig('D:/FakeProject', fake);
    const cm = new ConnectionManager(config);

    // First call — hits wire. FULL-TCP path returns the raw envelope
    // ({status, result}); partialRc transforms unwrap but FULL-TCP does not.
    const res = await executeMenhanceTool('regenerate_sidecar', { asset_path: '/Game/BP/BP_X' }, cm);
    t.assert(res && res.result && res.result.written === true, 'regenerate_sidecar returns {written: true}');
    t.assert(res.result.sidecar_path.includes('Saved/UEMCP'), 'response includes sidecar_path under Saved/UEMCP');

    const call = fake.lastCall('regenerate_sidecar');
    t.assert(call && call.port === 55558, 'regenerate_sidecar routed to tcp-55558');
    t.assert(call.params.asset_path === '/Game/BP/BP_X', 'asset_path forwarded');

    // Second call with same args — writes should NOT cache (isReadOp: false)
    await executeMenhanceTool('regenerate_sidecar', { asset_path: '/Game/BP/BP_X' }, cm);
    t.assert(fake.callsFor('regenerate_sidecar').length === 2,
      'regenerate_sidecar (mutation) bypasses cache — both calls hit wire');

    // Missing asset_path → Zod rejects
    await t.assertRejects(
      () => executeMenhanceTool('regenerate_sidecar', {}, cm),
      /asset_path/,
      'regenerate_sidecar rejects missing asset_path'
    );
  }

  // ── PARTIAL-RC: Zod validation still bites ───────────────────
  {
    const { config } = createTestConfig('D:/FakeProject');
    const cm = new ConnectionManager(config);

    await t.assertRejects(
      () => executeMenhanceTool('get_blueprint_variables', {}, cm),
      /asset_path/,
      'get_blueprint_variables rejects missing asset_path'
    );
    await t.assertRejects(
      () => executeMenhanceTool('get_struct_definition', {}, cm),
      /asset_path/,
      'get_struct_definition rejects missing asset_path'
    );
  }
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

const exitCode = t.summary();
process.exit(exitCode);
