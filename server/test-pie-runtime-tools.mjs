// Focused tests for W-BP-PIE runtime observation tools.
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-pie-runtime-tools.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import { readFileSync } from 'node:fs';
import { load } from 'js-yaml';
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
        sample_pie_actor_state: {},
        wait_for_pie_actor_stable: {},
      },
    },
  },
});

console.log('\n── W-BP-PIE Schema Surface ──');

{
  const defs = getMenhanceToolDefs();
  const toolsYaml = load(readFileSync('../tools.yaml', 'utf-8'));
  const inputPieTools = toolsYaml.toolsets?.['input-and-pie']?.tools || {};

  t.assert(inputPieTools.get_pie_session_state !== undefined,
    'get_pie_session_state is published in tools.yaml input-and-pie');
  t.assert(inputPieTools.get_pie_actor_state !== undefined,
    'get_pie_actor_state is published in tools.yaml input-and-pie');
  t.assert(inputPieTools.sample_pie_actor_state !== undefined,
    'sample_pie_actor_state is published in tools.yaml input-and-pie');
  t.assert(inputPieTools.wait_for_pie_actor_stable !== undefined,
    'wait_for_pie_actor_stable is published in tools.yaml input-and-pie');
  t.assert(MENHANCE_SCHEMAS.get_pie_session_state !== undefined,
    'get_pie_session_state schema exists');
  t.assert(MENHANCE_SCHEMAS.get_pie_actor_state !== undefined,
    'get_pie_actor_state schema exists');
  t.assert(MENHANCE_SCHEMAS.sample_pie_actor_state !== undefined,
    'sample_pie_actor_state schema exists');
  t.assert(MENHANCE_SCHEMAS.wait_for_pie_actor_stable !== undefined,
    'wait_for_pie_actor_stable schema exists');
  t.assert(defs.get_pie_session_state?.isReadOp === false,
    'get_pie_session_state bypasses cache because PIE state is volatile');
  t.assert(defs.get_pie_actor_state?.isReadOp === false,
    'get_pie_actor_state bypasses cache because PIE actor state is volatile');
  t.assert(defs.sample_pie_actor_state?.isReadOp === false,
    'sample_pie_actor_state bypasses cache because PIE state is volatile');
  t.assert(defs.wait_for_pie_actor_stable?.isReadOp === false,
    'wait_for_pie_actor_stable bypasses cache because PIE state is volatile');
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

console.log('\n── W-BP-PIE Sampling Composite ──');

{
  let calls = 0;
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_pie_actor_state', () => {
    calls++;
    return {
      status: 'success',
      result: {
        world: { pie_instance: 0, world_name: 'UEDPIE_0_TestMap' },
        resolved: { matched_by: 'name', name: 'MovingActor' },
        transform: { location: [calls * 10, 2, 3], rotation: [0, calls, 0], scale: [1, 1, 1] },
        properties: { Speed: 300 },
      },
    };
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const sample = await executeMenhanceTool('sample_pie_actor_state', {
    pie_instance: 0,
    actor_ref: { name: 'MovingActor', level_name: 'TestMap' },
    include_components: true,
    component_filter: ['VisualMesh'],
    properties: ['Speed'],
    duration_ms: 2,
    interval_ms: 1,
    max_samples: 3,
  }, cm);

  t.assert(fake.callsFor('sample_pie_actor_state').length === 0,
    'sample_pie_actor_state is Node-composed, not a C++ wire command');
  t.assert(fake.callsFor('get_pie_actor_state').length === 3,
    'sample_pie_actor_state performs bounded repeated get_pie_actor_state reads');
  t.assert(sample.sample_count === 3,
    'sample_pie_actor_state returns the sample count');
  t.assert(sample.samples.length === 3,
    'sample_pie_actor_state returns each sample');
  t.assert(sample.samples[0].t_ms === 0,
    'sample_pie_actor_state first sample is timestamped at zero');
  t.assert(sample.first.result.transform.location[0] === 10,
    'sample_pie_actor_state exposes first sample');
  t.assert(sample.last.result.transform.location[0] === 30,
    'sample_pie_actor_state exposes last sample');
  t.assert(sample.delta.location[0] === 20,
    'sample_pie_actor_state computes location delta');
  const firstCall = fake.callsFor('get_pie_actor_state')[0];
  t.assert(firstCall.port === 55558,
    'sample_pie_actor_state routes underlying reads to tcp-55558');
  t.assert(firstCall.params.actor_ref.name === 'MovingActor',
    'sample_pie_actor_state forwards actor_ref to underlying reads');
  t.assert(firstCall.params.include_components === true,
    'sample_pie_actor_state forwards include_components to underlying reads');
}

console.log('\n── W-BP-PIE Stable Wait Composite ──');

{
  let calls = 0;
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_pie_actor_state', () => {
    calls++;
    const z = calls < 2 ? 0 : 120;
    return {
      status: 'success',
      result: {
        world: { pie_instance: 0, world_name: 'UEDPIE_0_TestMap' },
        resolved: { matched_by: 'name', name: 'Mover' },
        transform: { location: [0, 0, z], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    };
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const stable = await executeMenhanceTool('wait_for_pie_actor_stable', {
    actor_ref: { name: 'Mover' },
    interval_ms: 1,
    stable_samples: 2,
    tolerance: 0.01,
    timeout_ms: 200,
  }, cm);
  t.assert(stable.stable === true,
    'wait_for_pie_actor_stable reports stable:true');
  t.assert(stable.final.result.transform.location[2] === 120,
    'wait_for_pie_actor_stable returns final stable state');
  t.assert(fake.callsFor('wait_for_pie_actor_stable').length === 0,
    'wait_for_pie_actor_stable is Node-composed, not a C++ wire command');
  t.assert(fake.callsFor('get_pie_actor_state').length === 3,
    'wait_for_pie_actor_stable waits for consecutive stable samples');
  t.assert(fake.lastCall('get_pie_actor_state').params.actor_ref.name === 'Mover',
    'wait_for_pie_actor_stable forwards actor_ref to underlying reads');
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_pie_actor_state', {
    status: 'success',
    result: {
      resolved: { matched_by: 'name', name: 'AlreadyStable' },
      transform: { location: [10, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const stable = await executeMenhanceTool('wait_for_pie_actor_stable', {
    actor_ref: { name: 'AlreadyStable' },
    interval_ms: 1,
    stable_samples: 2,
    tolerance: 0.01,
    timeout_ms: 200,
  }, cm);

  t.assert(stable.sample_count === 2,
    'wait_for_pie_actor_stable succeeds after requested consecutive stable samples');
  t.assert(fake.callsFor('get_pie_actor_state').every(call => call.timeoutMs > 0 && call.timeoutMs <= 200),
    'wait_for_pie_actor_stable gives each underlying read a remaining timeout budget');
}

{
  let calls = 0;
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_pie_actor_state', () => {
    calls++;
    return {
      status: 'success',
      result: {
        resolved: { matched_by: 'name', name: 'MovingActor' },
        transform: { location: [calls, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    };
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  try {
    await executeMenhanceTool('wait_for_pie_actor_stable', {
      actor_ref: { name: 'MovingActor' },
      interval_ms: 1,
      stable_samples: 2,
      tolerance: 0.01,
      timeout_ms: 4,
    }, cm);
    t.assert(false, 'wait_for_pie_actor_stable rejects when the actor never stabilizes');
  } catch (e) {
    t.assert(e.code === 'PIE_ACTOR_NOT_STABLE',
      'wait_for_pie_actor_stable timeout uses PIE_ACTOR_NOT_STABLE code',
      `got: ${e.code || e.message}`);
    t.assert(e.detail?.sample_count > 0,
      'wait_for_pie_actor_stable timeout includes sample detail');
    t.assert(e.detail?.last?.result?.transform?.location?.[0] > 0,
      'wait_for_pie_actor_stable timeout includes last observed response');
  }
}

{
  let calls = 0;
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_pie_actor_state', () => {
    calls++;
    return {
      status: 'success',
      result: {
        resolved: { matched_by: 'name', name: 'SlowActor' },
        transform: { location: [calls, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
      },
    };
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  try {
    await executeMenhanceTool('wait_for_pie_actor_stable', {
      actor_ref: { name: 'SlowActor' },
      interval_ms: 20,
      stable_samples: 2,
      tolerance: 0.01,
      timeout_ms: 5,
    }, cm);
    t.assert(false, 'wait_for_pie_actor_stable rejects before sleeping past timeout');
  } catch (e) {
    t.assert(e.code === 'PIE_ACTOR_NOT_STABLE',
      'wait_for_pie_actor_stable interval>timeout uses PIE_ACTOR_NOT_STABLE code');
    t.assert(fake.callsFor('get_pie_actor_state').length === 1,
      'wait_for_pie_actor_stable does not issue a second read after timeout deadline');
  }
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

  await t.assertRejects(
    () => executeMenhanceTool('sample_pie_actor_state', {}, cm),
    /actor_ref/,
    'sample_pie_actor_state requires actor_ref'
  );

  await t.assertRejects(
    () => executeMenhanceTool('sample_pie_actor_state', {
      actor_ref: { name: 'MovingActor' },
      interval_ms: 0,
    }, cm),
    /interval_ms/,
    'sample_pie_actor_state rejects nonpositive interval_ms'
  );

  await t.assertRejects(
    () => executeMenhanceTool('sample_pie_actor_state', {
      actor_ref: { name: 'MovingActor' },
      duration_ms: -1,
    }, cm),
    /duration_ms/,
    'sample_pie_actor_state rejects negative duration_ms'
  );

  await t.assertRejects(
    () => executeMenhanceTool('wait_for_pie_actor_stable', {}, cm),
    /actor_ref/,
    'wait_for_pie_actor_stable requires actor_ref'
  );

  await t.assertRejects(
    () => executeMenhanceTool('wait_for_pie_actor_stable', {
      actor_ref: { name: 'MovingActor' },
      stable_samples: 0,
    }, cm),
    /stable_samples/,
    'wait_for_pie_actor_stable rejects nonpositive stable_samples'
  );
}

const exitCode = t.summary();
process.exit(exitCode);
