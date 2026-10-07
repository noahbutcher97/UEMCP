import assert from 'node:assert/strict';
import { TestRunner } from './test-helpers.mjs';
import { runOwnedPieLifecycle } from './owned-pie-lifecycle.mjs';
import { fixture, oracle, actor, running, stopped, success, wireError, deferred, nextTurn } from './owned-pie-test-fixture.mjs';

const t = new TestRunner('Owned PIE lifecycle offline');
async function check(name, fn) {
  try { await fn(); t.assert(true, `owned PIE lifecycle: ${name}`); }
  catch (error) { t.assert(false, `owned PIE lifecycle: ${name}`, error.stack); }
}
const run = (f, options = {}) => runOwnedPieLifecycle({ adapter: f.adapter, oracle, timeoutMs: 1000, cleanupTimeoutMs: 100, pollMs: 1, ...options });

await check('two complete start runtime stop cycles with exact actor and typed probes', async () => {
  const f = await fixture(); const result = await run(f);
  assert.equal(result.status, 'passed'); assert.equal(result.cycles.length, 2);
  assert.deepEqual(result.cycles.map(c => c.actor), [actor, actor]);
  assert.equal(f.fake.callsFor('start_pie').length, 4); // includes two ALREADY_RUNNING probes
  assert.equal(f.fake.callsFor('stop_pie').length, 2);
  assert.equal(f.fake.callsFor('get_pie_actor_state').length, 8);
  assert.equal(f.callbacks.reconcile.length, 0);
  assert.ok(f.fake.calls.every(c => c.timeoutMs > 0 && c.timeoutMs <= 1000));
  assert.equal(f.context.getInFlightMutationCount(), 0);
});
await check('asynchronous start and stop are polled until observed', async () => {
  const f = await fixture(); let reads = 0;
  f.fake.on('get_pie_session_state', () => {
    reads++;
    // initial stop, two pending starts, running, one pending stop, stopped; repeat.
    return success([1, 2, 3, 6, 7, 8, 11].includes(reads) ? stopped : running);
  });
  const result = await run(f);
  assert.equal(result.cycles.length, 2); assert.equal(reads, 11);
});
for (const [field, mutate] of [
  ['name', a => { a.resolved.name = 'Wrong'; }],
  ['class', a => { a.resolved.class = '/Script/Engine.Actor'; }],
  ['matched_by', a => { a.resolved.matched_by = 'label'; }],
  ['location', a => { a.transform.location[0]++; }],
  ['rotation', a => { a.transform.rotation[1]++; }],
  ['scale', a => { a.transform.scale[2]++; }],
  ['CustomTimeDilation', a => { a.properties.CustomTimeDilation = 1; }],
  ['missing property', a => { delete a.properties; }],
  ['actor world', a => { a.world.pie_instance = 9; }],
]) {
  await check(`wrong ${field} fails and cleans up the owned session`, async () => {
    const f = await fixture(); const wrong = structuredClone(actor); mutate(wrong);
    const original = f.fake._responses.get('get_pie_actor_state');
    f.fake.on('get_pie_actor_state', (...args) => {
      const result = original(...args);
      return result.status === 'success' ? success(wrong) : result;
    });
    await assert.rejects(run(f), error => error.code === 'PIE_ORACLE_MISMATCH' && error.cleanup?.stopped === true);
    assert.equal(f.fake.callsFor('stop_pie').length, 1);
    assert.equal(f.callbacks.reconcile.length, 0);
  });
}
for (const [field, mutate] of [
  ['count', s => { s.active_context_count = 2; }],
  ['extra world', s => { s.contexts.push(s.contexts[0]); }],
  ['net mode', s => { s.contexts[0].net_mode = 'Client'; }],
  ['map name', s => { s.contexts[0].world_name = 'UEDPIE_0_Other'; }],
  ['map path', s => { s.contexts[0].world_path = '/Game/Other'; }],
  ['prefixed world object', s => { s.contexts[0].world_name = 'UEDPIE_0_Lifecycle'; s.contexts[0].world_path = '/Game/OwnedPIE/UEDPIE_0_Lifecycle.UEDPIE_0_Lifecycle'; }],
  ['default instance', s => { s.default_pie_instance = 7; }],
  ['default flag', s => { s.contexts[0].is_default = false; }],
]) {
  await check(`wrong runtime ${field} is rejected`, async () => {
    const f = await fixture(); const wrong = structuredClone(running); mutate(wrong);
    let reads = 0; f.fake.on('get_pie_session_state', () => success(++reads === 2 ? wrong : stopped));
    await assert.rejects(run(f), { code: 'PIE_ORACLE_MISMATCH' });
    assert.equal(f.fake.callsFor('stop_pie').length, 0);
    assert.equal(f.callbacks.reconcile.length, 1);
  });
}
await check('initial running PIE fails without stopping an existing session', async () => {
  const f = await fixture(); f.fake.on('get_pie_session_state', success(running));
  await assert.rejects(run(f), { code: 'PIE_ORACLE_MISMATCH' });
  assert.equal(f.fake.callsFor('start_pie').length, 0); assert.equal(f.fake.callsFor('stop_pie').length, 0);
});
for (const field of ['name', 'class', 'location', 'rotation', 'scale', 'CustomTimeDilation', 'missingActorName', 'mapPath']) {
  await check(`incomplete oracle ${field} fails before host verification`, async () => {
    const f = await fixture(); const invalid = { ...oracle }; delete invalid[field];
    await assert.rejects(run(f, { oracle: invalid }), { code: 'PIE_ORACLE_MISMATCH' });
    assert.equal(f.callbacks.verify.length, 0); assert.equal(f.fake.calls.length, 0);
  });
}
for (const field of ['owned', 'mapPath', 'missingActorAbsent', 'standalone']) {
  await check(`host proof requires ${field}`, async () => {
    const f = await fixture({ verifyOwnedHost: () => ({ owned: true, mapPath: oracle.mapPath, missingActorAbsent: true, standalone: true, [field]: false }) });
    await assert.rejects(run(f), { code: 'OWNED_HOST_UNVERIFIED' });
    assert.equal(f.fake.calls.length, 0);
  });
}
await check('missing actor probe must produce the exact typed error', async () => {
  const f = await fixture(); const original = f.fake._responses.get('get_pie_actor_state');
  f.fake.on('get_pie_actor_state', (...args) => args[2].actor_ref.name === oracle.missingActorName ? wireError('SOME_OTHER_ERROR') : original(...args));
  await assert.rejects(run(f), error => error.code === 'SOME_OTHER_ERROR' && error.cleanup.stopped);
});
await check('success-shaped missing actor cannot pass the negative probe', async () => {
  const f = await fixture(); const original = f.fake._responses.get('get_pie_actor_state');
  f.fake.on('get_pie_actor_state', (...args) => args[2].actor_ref.name === oracle.missingActorName ? success(actor) : original(...args));
  await assert.rejects(run(f), { code: 'PIE_EXPECTED_ERROR_MISSING' });
});
await check('start polling deadline reconciles a pending request instead of trusting a stopped snapshot', async () => {
  const f = await fixture(); f.fake.on('get_pie_session_state', success(stopped));
  await assert.rejects(run(f, { timeoutMs: 40 }), error => error.code === 'PIE_DEADLINE_EXCEEDED' && error.cleanup.stopped);
  assert.equal(f.fake.callsFor('stop_pie').length, 0);
  assert.equal(f.callbacks.reconcile.length, 1); assert.equal(f.adapter.state, 'closed');
});
await check('ambiguous start invokes bounded reconciliation without sending stop', async () => {
  const gate = deferred(); const f = await fixture(); f.fake.on('start_pie', () => gate.promise);
  await assert.rejects(run(f, { timeoutMs: 40 }), error => error.code === 'PIE_DEADLINE_EXCEEDED' && error.cleanup.stopped);
  assert.equal(f.fake.callsFor('stop_pie').length, 0); assert.equal(f.callbacks.reconcile.length, 1);
  assert.equal(f.adapter.state, 'closed'); gate.resolve(success({ requested: true })); await nextTurn();
  assert.equal(f.adapter.state, 'closed');
});
await check('ambiguous stop never retries stop and reconciles once', async () => {
  const gate = deferred(); const f = await fixture(); f.fake.on('stop_pie', () => gate.promise);
  await assert.rejects(run(f, { timeoutMs: 40 }), error => error.code === 'PIE_DEADLINE_EXCEEDED' && error.cleanup.stopped);
  assert.equal(f.fake.callsFor('stop_pie').length, 1); assert.equal(f.callbacks.reconcile.length, 1);
  gate.resolve(success({ was_running: true, requested_stop: true })); await nextTurn();
});
await check('failed cleanup retains original error and reports reconciliation failure', async () => {
  const f = await fixture({ reconcile: () => { throw Object.assign(new Error('owner lost'), { code: 'OWNER_LOST' }); } });
  const original = f.fake._responses.get('get_pie_actor_state');
  f.fake.on('get_pie_actor_state', (...args) => {
    const value = original(...args); return value.status === 'success' ? success({}) : value;
  });
  f.fake.on('stop_pie', () => { throw Object.assign(new Error('socket lost'), { code: 'SOCKET_ERROR' }); });
  await assert.rejects(run(f), error => error.code === 'PIE_ORACLE_MISMATCH' && error.cleanup.stopped === false && error.cleanup.reconciliationCode === 'OWNER_LOST');
  assert.equal(f.adapter.state, 'locked');
});
await check('deadline parameters are validated before any host call', async () => {
  const f = await fixture();
  for (const timeoutMs of [0, -1, NaN, Infinity, 300001]) await assert.rejects(run(f, { timeoutMs }), { code: 'INVALID_DEADLINE' });
  assert.equal(f.callbacks.verify.length, 0);
});
await check('timed-out reconciliation runs once and leaves an actionable locked adapter', async () => {
  const pendingStart = deferred(); const pendingReconcile = deferred();
  const f = await fixture({ reconcile: () => pendingReconcile.promise });
  f.fake.on('start_pie', () => pendingStart.promise);
  await assert.rejects(run(f, { timeoutMs: 30, cleanupTimeoutMs: 30 }), error => error.code === 'PIE_DEADLINE_EXCEEDED' && error.cleanup.stopped === false);
  assert.equal(f.callbacks.reconcile.length, 1); assert.equal(f.adapter.state, 'locked');
  pendingStart.resolve(success({ requested: true, mode: 'viewport' }));
  pendingReconcile.resolve({ owned: true, stopped: true, pendingOperationsDrained: true });
  await nextTurn(); assert.equal(f.adapter.state, 'locked');
});
process.exitCode = t.summary();
