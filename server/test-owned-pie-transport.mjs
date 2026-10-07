import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { TestRunner } from './test-helpers.mjs';
import { TcpTransportError } from './tcp-transport.mjs';
import { fixture, oracle, success, wireError, stopped, deferred, nextTurn } from './owned-pie-test-fixture.mjs';

const t = new TestRunner('Owned PIE transport offline');
async function check(name, fn) {
  try { await fn(); t.assert(true, `owned PIE transport: ${name}`); }
  catch (error) { t.assert(false, `owned PIE transport: ${name}`, error.stack); }
}
const call = (f, command = 'get_pie_session_state', budget = 1000) => f.adapter.call(command, {}, { deadlineAt: Date.now() + budget });

await check('real context handshake and manager send remain uncached', async () => {
  const f = await fixture();
  assert.equal(f.context.transportOwnershipState, 'verified');
  await call(f); await call(f);
  assert.equal(f.fake.callsFor('get_pie_session_state').length, 2);
  assert.deepEqual(await call(f), stopped);
  assert.equal(f.fake.lastCall('get_pie_session_state').port, 55558);
});
await check('absolute deadline reaches the fake transport', async () => {
  const f = await fixture();
  const deadlineAt = Date.now() + 321;
  await f.adapter.call('get_pie_session_state', {}, { deadlineAt });
  const sent = f.fake.lastCall('get_pie_session_state');
  assert.ok(sent.timeoutMs > 0 && sent.timeoutMs <= 321);
  assert.ok(sent.ts + sent.timeoutMs <= deadlineAt + 1);
});
for (const deadlineAt of [undefined, NaN, Infinity, 0]) {
  await check(`invalid or expired deadline ${String(deadlineAt)} never dispatches`, async () => {
    const f = await fixture();
    await assert.rejects(f.adapter.call('start_pie', {}, { deadlineAt }), { code: deadlineAt === 0 ? 'PIE_DEADLINE_EXCEEDED' : 'INVALID_DEADLINE' });
    assert.equal(f.fake.calls.length, 0);
  });
}
for (const [state, code, change] of [
  ['detached', 'PROJECT_CONTEXT_CHANGED', f => f.context.detachProject()],
  ['editor unknown', 'EDITOR_IDENTITY_UNKNOWN', f => f.context.refreshEditorProcesses([])],
  ['owner unknown', 'TRANSPORT_OWNER_UNKNOWN', f => { f.context.transportOwnershipState = 'unverified'; }],
  ['stale deploy', 'DEPLOY_STALE', f => f.context.setDeployReadiness({ state: 'stale' })],
]) {
  await check(`${state} prevents dispatch`, async () => {
    const f = await fixture(); await change(f);
    await assert.rejects(call(f, 'start_pie'), { code });
    assert.equal(f.fake.calls.length, 0);
  });
}
for (const envelope of [
  wireError('PIE_NOT_RUNNING'),
  { success: false, error: 'stopped', code: 'PIE_NOT_RUNNING' },
  { status: 'success', result: { error: 'stopped', code: 'PIE_NOT_RUNNING' } },
]) {
  await check(`typed error envelope ${JSON.stringify(envelope)}`, async () => {
    const f = await fixture(); f.fake.on('get_pie_actor_state', envelope);
    await assert.rejects(call(f, 'get_pie_actor_state'), error => error.code === 'PIE_NOT_RUNNING' && !!error.wireResponse && !!error.wireError);
  });
}
await check('wire detail and response survive normalization', async () => {
  const f = await fixture();
  await assert.rejects(call(f, 'get_pie_actor_state'), error => {
    assert.deepEqual(error.detail, { witness: true });
    assert.deepEqual(error.wireResponse, wireError('PIE_NOT_RUNNING')); return true;
  });
});
for (const response of [null, {}, { status: 'success' }, { status: 'success', result: [] }]) {
  await check(`invalid success envelope ${JSON.stringify(response)}`, async () => {
    const f = await fixture(); f.fake.on('get_pie_session_state', () => response);
    await assert.rejects(call(f), { code: 'PIE_INVALID_ENVELOPE' });
  });
}
for (const command of ['start_pie', 'stop_pie']) {
  await check(`${command} timeout locks calls and retains mutation despite late reply`, async () => {
    const f = await fixture(); const pending = deferred(); f.fake.on(command, () => pending.promise);
    await assert.rejects(call(f, command, 30), { code: 'PIE_DEADLINE_EXCEEDED' });
    assert.equal(f.adapter.state, 'locked'); assert.equal(f.context.getInFlightMutationCount(), 1);
    await assert.rejects(f.context.detachProject(), { code: 'IN_FLIGHT_MUTATION_BLOCKED' });
    pending.resolve(success({ requested: true })); await nextTurn();
    await assert.rejects(call(f), { code: 'PIE_ADAPTER_LOCKED' });
    assert.equal(f.context.getInFlightMutationCount(), 1);
    await f.adapter.reconcile(new Error('timeout'), Date.now() + 1000);
    assert.equal(f.adapter.state, 'closed'); assert.equal(f.context.getInFlightMutationCount(), 0);
    await assert.rejects(call(f), { code: 'PIE_ADAPTER_LOCKED' });
  });
  await check(`${command} preserves transport timeout when readiness also disappears`, async () => {
    const f = await fixture(); const original = new TcpTransportError('RESPONSE_TIMEOUT', 55558, { timeoutMs: 1 });
    f.fake.on(command, () => { f.context.refreshEditorProcesses([]); throw original; });
    await assert.rejects(call(f, command), error => error === original);
    assert.equal(f.adapter.state, 'locked');
  });
  await check(`${command} readiness loss after successful dispatch is ambiguous`, async () => {
    const f = await fixture(); f.fake.on(command, () => { f.context.setDeployReadiness({ state: 'stale' }); return success({ requested: true }); });
    await assert.rejects(call(f, command), { code: 'DEPLOY_STALE' });
    assert.equal(f.adapter.state, 'locked');
  });
  await check(`${command} malformed acknowledgement is ambiguous`, async () => {
    const f = await fixture(); f.fake.on(command, {});
    await assert.rejects(call(f, command), { code: 'PIE_INVALID_ENVELOPE' });
    assert.equal(f.adapter.state, 'locked');
  });
}
await check('readiness loss after a read cannot return stale success', async () => {
  const f = await fixture(); f.fake.on('get_pie_session_state', () => { f.context.refreshEditorProcesses([]); return success(stopped); });
  await assert.rejects(call(f), { code: 'EDITOR_IDENTITY_UNKNOWN' });
});
await check('typed rejected start releases mutation without ambiguity', async () => {
  const f = await fixture(); f.fake.on('start_pie', wireError('ALREADY_RUNNING'));
  await assert.rejects(call(f, 'start_pie'), { code: 'ALREADY_RUNNING' });
  assert.equal(f.context.getInFlightMutationCount(), 0); assert.equal(f.adapter.state, 'open');
});
await check('concurrent adapter calls are rejected before dispatch', async () => {
  const f = await fixture(); const gate = deferred(); f.fake.on('start_pie', () => gate.promise);
  const pending = call(f, 'start_pie'); await nextTurn();
  await assert.rejects(call(f, 'stop_pie'), { code: 'PIE_ADAPTER_BUSY' });
  gate.resolve(success({ requested: true, mode: 'viewport' })); await pending;
  assert.equal(f.fake.calls.length, 1);
});
await check('queue expiry prevents a late start dispatch', async () => {
  const f = await fixture(); const gate = deferred(); f.fake.on('block', () => gate.promise);
  const blocker = f.cm.send('tcp-55558', 'block', {}, { skipCache: true });
  await assert.rejects(call(f, 'start_pie', 30), { code: 'PIE_DEADLINE_EXCEEDED' });
  gate.resolve(success({})); await blocker; await nextTurn();
  assert.equal(f.fake.callsFor('start_pie').length, 0); assert.equal(f.context.getInFlightMutationCount(), 0);
});
await check('queue readiness loss prevents dispatch', async () => {
  const f = await fixture(); const gate = deferred(); f.fake.on('block', () => gate.promise);
  const blocker = f.cm.send('tcp-55558', 'block', {}, { skipCache: true });
  const pending = call(f, 'start_pie'); await nextTurn(); f.context.setDeployReadiness({ state: 'stale' });
  gate.resolve(success({})); await blocker;
  await assert.rejects(pending, { code: 'DEPLOY_STALE' });
  assert.equal(f.fake.callsFor('start_pie').length, 0);
});
await check('queue time reduces the actual wire timeout', async () => {
  const f = await fixture(); const gate = deferred(); f.fake.on('block', () => gate.promise);
  const blocker = f.cm.send('tcp-55558', 'block', {}, { skipCache: true });
  const deadlineAt = Date.now() + 1000;
  const pending = f.adapter.call('get_pie_session_state', {}, { deadlineAt });
  await delay(25); gate.resolve(success({})); await blocker; await pending;
  const sent = f.fake.lastCall('get_pie_session_state');
  assert.ok(sent.timeoutMs < 990 && sent.timeoutMs > 0); assert.ok(sent.ts + sent.timeoutMs <= deadlineAt + 1);
});
await check('ownership callback is bounded and receives identity deadline and signal', async () => {
  const gate = deferred(); const f = await fixture({ verifyOwnedHost: () => gate.promise });
  const deadlineAt = Date.now() + 30;
  await assert.rejects(f.adapter.verifyOwnedHost(oracle, deadlineAt), { code: 'PIE_DEADLINE_EXCEEDED' });
  const args = f.callbacks.verify[0];
  assert.equal(args.deadlineAt, deadlineAt); assert.equal(args.identity, f.context.identity.canonicalUprojectPath); assert.equal(args.signal.aborted, true);
  gate.resolve({}); assert.equal(f.fake.calls.length, 0);
});
for (const field of ['owned', 'stopped', 'pendingOperationsDrained']) {
  await check(`reconciliation requires ${field}`, async () => {
    const f = await fixture({ reconcile: () => ({ owned: true, stopped: true, pendingOperationsDrained: true, [field]: false }) });
    await assert.rejects(f.adapter.reconcile(new Error('failure'), Date.now() + 1000), { code: 'PIE_RECONCILIATION_UNVERIFIED' });
    await assert.rejects(call(f), { code: 'PIE_ADAPTER_LOCKED' });
  });
}
await check('late reconciliation reply never unlocks or closes timed-out adapter', async () => {
  const gate = deferred(); const f = await fixture({ reconcile: () => gate.promise });
  await assert.rejects(f.adapter.reconcile(new Error('failure'), Date.now() + 30), { code: 'PIE_DEADLINE_EXCEEDED' });
  gate.resolve({ owned: true, stopped: true, pendingOperationsDrained: true }); await nextTurn();
  assert.equal(f.adapter.state, 'locked'); await assert.rejects(call(f), { code: 'PIE_ADAPTER_LOCKED' });
  await assert.rejects(f.adapter.reconcile(new Error('retry'), Date.now() + 1000), { code: 'PIE_ADAPTER_LOCKED' });
  assert.equal(f.callbacks.reconcile.length, 1);
});
for (const command of ['start_pie', 'stop_pie']) {
  await check(`${command} unknown typed server error still locks the adapter`, async () => {
    const f = await fixture(); f.fake.on(command, wireError('GAME_THREAD_TIMEOUT'));
    await assert.rejects(call(f, command), { code: 'GAME_THREAD_TIMEOUT' });
    assert.equal(f.adapter.state, 'locked');
  });
  await check(`${command} empty result object is an ambiguous acknowledgement`, async () => {
    const f = await fixture(); f.fake.on(command, success({}));
    await assert.rejects(call(f, command), { code: 'PIE_INVALID_ENVELOPE' });
    assert.equal(f.adapter.state, 'locked');
  });
}
await check('forced project change during start locks the original adapter', async () => {
  const f = await fixture(); f.fake.on('start_pie', async () => {
    await f.context.detachProject({ force_generation_change: true });
    return success({ requested: true, mode: 'viewport' });
  });
  await assert.rejects(call(f, 'start_pie'), { code: 'PROJECT_CONTEXT_CHANGED' });
  assert.equal(f.adapter.state, 'locked');
});
for (const operation of ['verify', 'reconcile']) {
  await check(`${operation} rejects a synchronous callback that overruns its deadline`, async () => {
    const blockingProof = () => {
      const finishAt = Date.now() + 25;
      while (Date.now() < finishAt) { /* exercise timer starvation */ }
      return { owned: true, mapPath: oracle.mapPath, missingActorAbsent: true, standalone: true, stopped: true, pendingOperationsDrained: true };
    };
    const f = await fixture({ verifyOwnedHost: blockingProof, reconcile: blockingProof });
    const deadlineAt = Date.now() + 10;
    await assert.rejects(operation === 'verify' ? f.adapter.verifyOwnedHost(oracle, deadlineAt) : f.adapter.reconcile(new Error('test'), deadlineAt), { code: 'PIE_DEADLINE_EXCEEDED' });
    assert.equal(f.callbacks[operation][0].signal.aborted, true);
    if (operation === 'reconcile') assert.equal(f.adapter.state, 'locked');
  });
}
process.exitCode = t.summary();
