// Focused tests for W-BP-PIE runtime observation tools.
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-pie-runtime-tools.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import {
  executeMenhanceTool,
  getMenhanceToolDefs,
  initMenhanceTools,
  MENHANCE_SCHEMAS,
} from './menhance-tcp-tools.mjs';

const t = new TestRunner('W-BP-PIE — runtime observation tools');

initMenhanceTools({
  toolsets: {
    'input-and-pie': {
      tools: {
        get_pie_session_state: {},
        get_pie_actor_state: {},
      },
    },
  },
});

console.log('\n── W-BP-PIE Schema Surface ──');

{
  const defs = getMenhanceToolDefs();
  t.assert(MENHANCE_SCHEMAS.get_pie_session_state !== undefined,
    'get_pie_session_state schema exists');
  t.assert(MENHANCE_SCHEMAS.get_pie_actor_state !== undefined,
    'get_pie_actor_state schema exists');
  t.assert(defs.get_pie_session_state?.isReadOp === false,
    'get_pie_session_state bypasses cache because PIE state is volatile');
  t.assert(defs.get_pie_actor_state?.isReadOp === false,
    'get_pie_actor_state bypasses cache because PIE actor state is volatile');
}

console.log('\n── W-BP-PIE Routing and Params ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_pie_session_state', {
    status: 'success',
    result: { pie_running: true, active_context_count: 1, contexts: [] },
  });
  fake.on('get_pie_actor_state', {
    status: 'success',
    result: {
      world: { pie_instance: 0, world_name: 'UEDPIE_0_TestMap' },
      resolved: { matched_by: 'name', name: 'BP_RuntimeActor_C_0' },
      transform: { location: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeMenhanceTool('get_pie_session_state', {}, cm);
  const sessionCall = fake.lastCall('get_pie_session_state');
  t.assert(sessionCall && sessionCall.port === 55558,
    'get_pie_session_state routes to tcp-55558');
  t.assert(Object.keys(sessionCall.params).length === 0,
    'get_pie_session_state forwards empty params');

  await executeMenhanceTool('get_pie_actor_state', {
    pie_instance: 0,
    actor_ref: { name: 'BP_RuntimeActor_C_0', level_name: 'TestMap' },
    include_components: true,
    component_filter: ['VisualMesh'],
    properties: ['Speed', 'Direction'],
  }, cm);
  const actorCall = fake.lastCall('get_pie_actor_state');
  t.assert(actorCall && actorCall.port === 55558,
    'get_pie_actor_state routes to tcp-55558');
  t.assert(actorCall.params.pie_instance === 0,
    'get_pie_actor_state forwards pie_instance');
  t.assert(actorCall.params.actor_ref.name === 'BP_RuntimeActor_C_0',
    'get_pie_actor_state forwards actor_ref.name');
  t.assert(actorCall.params.include_components === true,
    'get_pie_actor_state forwards include_components');
  t.assert(actorCall.params.component_filter[0] === 'VisualMesh',
    'get_pie_actor_state forwards component_filter');
  t.assert(actorCall.params.properties[1] === 'Direction',
    'get_pie_actor_state forwards properties');
}

console.log('\n── W-BP-PIE Typed Error Propagation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_pie_session_state', {
    status: 'success',
    result: { pie_running: false, active_context_count: 0, contexts: [] },
  });
  fake.on('get_pie_actor_state', {
    status: 'error',
    code: 'PIE_NOT_RUNNING',
    error: 'PIE is not running; start PIE before reading runtime actor state',
    detail: { pie_running: false, contexts: [] },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const session = await executeMenhanceTool('get_pie_session_state', {}, cm);
  t.assert(session.result.pie_running === false,
    'get_pie_session_state can report PIE stopped state');

  await t.assertRejects(
    () => executeMenhanceTool('get_pie_actor_state', {
      actor_ref: { name: 'MissingRuntimeActor' },
    }, cm),
    /PIE is not running/,
    'get_pie_actor_state surfaces PIE_NOT_RUNNING from the bridge'
  );
}

console.log('\n── W-BP-PIE Cache Bypass ──');

{
  let calls = 0;
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_pie_actor_state', () => {
    calls++;
    return {
      status: 'success',
      result: {
        world: { pie_instance: 0 },
        resolved: { matched_by: 'name', name: 'MovingActor' },
        transform: { location: [calls, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    };
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);
  const args = { actor_ref: { name: 'MovingActor' } };

  await executeMenhanceTool('get_pie_actor_state', args, cm);
  await executeMenhanceTool('get_pie_actor_state', args, cm);
  t.assert(fake.callsFor('get_pie_actor_state').length === 2,
    'get_pie_actor_state bypasses cache on repeated identical calls');
}

console.log('\n── W-BP-PIE Validation ──');

{
  const { config } = createTestConfig('D:/FakeProject');
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeMenhanceTool('get_pie_actor_state', {}, cm),
    /actor_ref/,
    'get_pie_actor_state requires actor_ref'
  );

  await t.assertRejects(
    () => executeMenhanceTool('get_pie_actor_state', { actor_ref: {} }, cm),
    /actor_ref/,
    'get_pie_actor_state requires at least one actor_ref identity field'
  );
}

const exitCode = t.summary();
process.exit(exitCode);
