import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TestRunner } from './test-helpers.mjs';
import { fixture, oracle, actor, success, deferred, nextTurn } from './owned-pie-test-fixture.mjs';
import { createOwnedPieOwner } from './owned-pie-owner.mjs';
import { runOwnedPieLifecycle } from './owned-pie-lifecycle.mjs';
import { ProjectContext } from './project-context.mjs';
import { TOOL_REQUIREMENT_KINDS } from './tool-requirements.mjs';
const t = new TestRunner('Owned PIE owner offline');
async function check(name, fn) {
  try { await fn(); t.assert(true, `owned PIE owner: ${name}`); }
  catch (error) { t.assert(false, `owned PIE owner: ${name}`, error.stack); }
}
const nonce = '00112233-4455-6677-8899-aabbccddeeff';
async function owned(options = {}) {
  const f = await fixture();
  if (options.unready) {
    const projectRoot = f.context.identity.projectRoot;
    f.context = new ProjectContext({ cwd: projectRoot, repoRoot: projectRoot });
    await f.context.attachProject({ project_root: projectRoot });
  }
  const proof = {
    owned: true, nonce, process_id: 1234, project_path: f.context.identity.canonicalUprojectPath, map_path: oracle.mapPath,
    accounting: { sealed: false, accepted: 0, completed: 0, outstanding: 0 },
    flags: { queued_start: false, session_active: false, play_world: false, pie_contexts: 0, queued_end: false, simulating: false },
    tick: 4, seal_tick: 0, drained_tick: 0, drained: false,
    actor: Object.fromEntries(['name', 'class', 'location', 'rotation', 'scale', 'InputPriority', 'AutoReceiveInput', 'has_input_component'].map(key => [key, oracle[key]])),
    missing_actor_absent: true, standalone: true, online_disabled: true,
  };
  f.fake.on('owned_pie_verify', () => success(proof));
  f.fake.on('owned_pie_fence', () => { proof.accounting.sealed = true; proof.seal_tick = proof.tick; return success(proof); });
  f.fake.on('owned_pie_reconcile', () => { proof.tick++; proof.drained_tick = proof.tick; proof.drained = true; return success(proof); });
  const guardCalls = [];
  const guard = { owned: true, exclusive: true, sourceVerified: true, nonce, processId: 1234, projectPath: proof.project_path };
  const owner = createOwnedPieOwner({ projectContext: f.context, connectionManager: f.cm, nonce, processId: 1234, pollMs: 1,
    assertOwnership: async args => { guardCalls.push(args); return options.guard ? options.guard(args) : guard; },
  });
  return { ...f, ...owner, adapter: owner.adapter, owner, proof, guard, guardCalls };
}
const verify = f => f.adapter.verifyOwnedHost(oracle, Date.now() + 1000);
const reconcile = (f, budget = 1000) => f.adapter.reconcile(new Error('qualification complete'), Date.now() + budget);
await check('fresh attached context bootstraps through exactly one guarded native verification', async () => {
  const f = await owned({ unready: true });
  assert.equal(f.context.evaluateToolReadiness({ requirement: TOOL_REQUIREMENT_KINDS.LIVE_MUTATION }).ok, false);
  let nativeCalls = 0;
  f.fake.on('owned_pie_verify', () => { assert.equal(++nativeCalls, 1); return success(f.proof); });
  const result = await runOwnedPieLifecycle({ adapter: f.adapter, oracle });
  assert.equal(result.cycles.length, 2); assert.equal(nativeCalls, 1);
  assert.equal(f.context.transportOwnershipState, 'verified');
  await reconcile(f);
});
await check('fresh context rejects lifecycle commands before bootstrap and guard failure sends nothing', async () => {
  const f = await owned({ unready: true });
  await assert.rejects(f.adapter.call('start_pie', {}, { deadlineAt: Date.now() + 100 }));
  f.guard.exclusive = false; await assert.rejects(verify(f), { code: 'OWNED_PIE_PROOF_INVALID' });
  assert.equal(f.fake.calls.length, 0); assert.equal(f.context.transportOwnershipState, 'not_checked');
});
await check('mismatched native bootstrap proof cannot establish readiness', async () => {
  const f = await owned({ unready: true });f.proof.process_id++;
  await assert.rejects(verify(f), { code: 'OWNED_PIE_PROOF_INVALID' });
  assert.equal(f.context.transportOwnershipState, 'not_checked');assert.equal(f.fake.callsFor('start_pie').length, 0);
});
await check('late native verification cannot establish readiness or unlock lifecycle commands', async () => {
  const f = await owned({ unready: true });const pending = deferred();
  f.fake.on('owned_pie_verify', () => pending.promise);
  await assert.rejects(f.adapter.verifyOwnedHost(oracle, Date.now() + 20), { code: 'PIE_DEADLINE_EXCEEDED' });
  pending.resolve(success(f.proof));await nextTurn();
  assert.equal(f.context.transportOwnershipState, 'not_checked');assert.equal(f.adapter.state, 'locked');
  await assert.rejects(f.adapter.call('start_pie', {}, { deadlineAt: Date.now() + 100 }), { code: 'PIE_ADAPTER_LOCKED' });
});
await check('project generation change during native bootstrap cannot publish readiness', async () => {
  const f = await owned({ unready: true });
  f.fake.on('owned_pie_verify', async () => { await f.context.attachProject({ project_root: f.context.identity.projectRoot });return success(f.proof); });
  await assert.rejects(verify(f), { code: 'OWNED_PIE_PROOF_INVALID' });
  assert.equal(f.context.transportOwnershipState, 'not_checked');assert.equal(f.fake.callsFor('start_pie').length, 0);
});
await check('owned native readiness reports truthful provenance and rejects invalid binding', async () => {
  const f = await owned({ unready: true });
  assert.throws(()=>f.context.refreshOwnedPieVerification(f.proof, { generation: f.context.generation, nonce, processId: 42 }), { code: 'OWNED_PIE_PROOF_INVALID' });
  const result = f.context.refreshOwnedPieVerification(f.proof, { generation: f.context.generation, nonce, processId: 1234 });
  assert.equal(result.source, 'owned_pie_verification');assert.equal(result.nativeIdentity.processId,1234);
  for (const candidate of [result.matchedEditor, f.context.editorCandidates[0]]) {
    assert.equal(candidate.pid, 1234);assert.equal(candidate.cmdLine, '');
    assert.equal(candidate.commandLineAvailable, false);assert.equal(candidate.transportIdentitySource, 'owned_pie_verification');
  }
});
await check('two cycles use actual context manager and nonce then seal permanently', async () => {
  const f = await owned();
  const result = await runOwnedPieLifecycle({ adapter: f.adapter, oracle });
  assert.equal(result.cycles.length, 2);
  for (const call of f.fake.calls) assert.equal(call.params.owned_pie_nonce, nonce);
  assert.equal(f.fake.callsFor('get_pie_session_state').length, 5);
  const proof = await reconcile(f);
  assert.equal(proof.pendingOperationsDrained, true);
  assert.equal(f.adapter.state, 'closed');
  await assert.rejects(f.adapter.call('start_pie', {}, { deadlineAt: Date.now() + 100 }), { code: 'PIE_ADAPTER_LOCKED' });
  assert.deepEqual(f.owner.transcript.map(x => x.command), ['owned_pie_verify', 'owned_pie_fence', 'owned_pie_reconcile']);
});
await check('lifecycle dispatch requires native verification', async () => {
  const f = await owned();
  await assert.rejects(f.adapter.call('start_pie', {}, { deadlineAt: Date.now() + 100 }), { code: 'OWNED_PIE_PROOF_INVALID' });
  assert.equal(f.fake.calls.length, 0);
});
for (const key of ['owned', 'exclusive', 'sourceVerified']) {
  await check(`coordinator guard requires ${key}`, async () => {
    const f = await owned(); f.guard[key] = false;
    await assert.rejects(verify(f), { code: 'OWNED_PIE_PROOF_INVALID' });
    assert.equal(f.fake.calls.length, 0);
  });
}
for (const [key, value] of [['nonce', 'different'], ['process_id', 42], ['project_path', 'D:/wrong.uproject'], ['map_path', '/Game/Wrong']]) {
  await check(`native identity rejects ${key} mismatch`, async () => {
    const f = await owned(); f.proof[key] = value;
    await assert.rejects(verify(f), { code: 'OWNED_PIE_PROOF_INVALID' });
  });
}
for (const key of ['name', 'class', 'location', 'rotation', 'scale', 'InputPriority', 'AutoReceiveInput', 'has_input_component']) {
  await check(`editor oracle rejects ${key} mismatch`, async () => {
    const f = await owned(); f.proof.actor[key] = null;
    await assert.rejects(verify(f), { code: 'OWNED_PIE_PROOF_INVALID' });
  });
}
for (const value of [0, 174, 173.5, '173', true, null, undefined]) {
  await check(`editor witness rejects ${String(value)}`, async () => {
    const f = await owned(); f.proof.actor.InputPriority = value;
    await assert.rejects(verify(f), { code: 'OWNED_PIE_PROOF_INVALID' });
  });
}
for (const [key, value] of [['AutoReceiveInput', 1], ['AutoReceiveInput', '0'], ['has_input_component', true], ['has_input_component', 0]]) {
  await check(`editor input safety rejects ${key}:${String(value)}`, async () => {
    const f = await owned(); f.proof.actor[key] = value;
    await assert.rejects(verify(f), { code: 'OWNED_PIE_PROOF_INVALID' });
  });
}
for (const key of ['missing_actor_absent', 'standalone', 'online_disabled']) {
  await check(`verification requires ${key}`, async () => {
    const f = await owned(); f.proof[key] = false;
    await assert.rejects(verify(f), { code: 'OWNED_PIE_PROOF_INVALID' });
  });
}
await check('initial queued start rejects stopped-looking fixture', async () => {
  const f = await owned(); f.proof.flags.queued_start = true;
  await assert.rejects(verify(f), { code: 'OWNED_PIE_PROOF_INVALID' });
});
await check('initial ledger must be unused', async () => {
  const f = await owned(); f.proof.accounting.accepted = f.proof.accounting.completed = 1;
  await assert.rejects(verify(f), { code: 'OWNED_PIE_PROOF_INVALID' });
});
for (const alteration of ['outstanding', 'queued_start', 'session_active', 'play_world', 'pie_contexts', 'queued_end', 'simulating', 'tick', 'ledger', 'seal']) {
  await check(`drain proof rejects ${alteration}`, async () => {
    const f = await owned(); await verify(f);
    f.fake.on('owned_pie_reconcile', () => {
      f.proof.tick++;
      f.proof.drained = true; f.proof.drained_tick = f.proof.tick;
      if (alteration === 'outstanding') { f.proof.accounting.accepted = 1; f.proof.accounting.outstanding = 1; }
      else if (alteration === 'tick') f.proof.drained_tick = f.proof.seal_tick;
      else if (alteration === 'ledger') f.proof.accounting.completed = 7;
      else if (alteration === 'seal') f.proof.accounting.sealed = false;
      else f.proof.flags[alteration] = alteration === 'pie_contexts' ? 1 : true;
      return success(f.proof);
    });
    await assert.rejects(reconcile(f), { code: 'OWNED_PIE_PROOF_INVALID' });
    assert.equal(f.adapter.state, 'locked');
  });
}
await check('pending operations poll uncached until completion with one deadline', async () => {
  const f = await owned(); await verify(f);
  f.proof.accounting.accepted = 1; f.proof.accounting.outstanding = 1;
  let polls = 0;
  f.fake.on('owned_pie_reconcile', () => {
    f.proof.tick++;
    if (++polls === 3) {
      f.proof.accounting.completed = 1; f.proof.accounting.outstanding = 0;
      f.proof.drained = true; f.proof.drained_tick = f.proof.tick;
    }
    return success(f.proof);
  });
  const deadlineAt = Date.now() + 500;
  await f.adapter.reconcile(new Error('test'), deadlineAt);
  assert.equal(polls, 3);
  for (const call of f.fake.callsFor('owned_pie_reconcile')) assert.ok(call.ts + call.timeoutMs <= deadlineAt + 1);
});
await check('timeout leaves late operation locked and cannot repeat reconciliation', async () => {
  const f = await owned(); await verify(f);
  const pending = deferred(); f.fake.on('owned_pie_reconcile', () => pending.promise);
  await assert.rejects(reconcile(f, 25), { code: 'PIE_DEADLINE_EXCEEDED' });
  f.proof.tick++; f.proof.drained_tick = f.proof.tick; f.proof.drained = true;
  pending.resolve(success(f.proof)); await nextTurn();
  assert.equal(f.adapter.state, 'locked');
  await assert.rejects(reconcile(f), { code: 'PIE_ADAPTER_LOCKED' });
  assert.equal(f.fake.callsFor('owned_pie_fence').length, 1);
});
await check('ownership callback bounded before any native command', async () => {
  const f = await owned({ guard: () => new Promise(() => {}) });
  await assert.rejects(f.adapter.verifyOwnedHost(oracle, Date.now() + 20), { code: 'PIE_DEADLINE_EXCEEDED' });
  assert.equal(f.fake.calls.length, 0);
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(f.guardCalls[0].signal.aborted, true);
});
await check('ownership loss after drain cannot release mutation guard', async () => {
  const f = await owned(); await verify(f);
  const pending = deferred(); f.fake.on('start_pie', () => pending.promise);
  await assert.rejects(f.adapter.call('start_pie', {}, { deadlineAt: Date.now() + 20 }), { code: 'PIE_DEADLINE_EXCEEDED' });
  pending.resolve(success({ requested: true, mode: 'viewport' })); await nextTurn();
  f.fake.on('owned_pie_reconcile', () => {
    f.proof.tick++; f.proof.drained_tick = f.proof.tick; f.proof.drained = true;
    f.guard.exclusive = false;
    return success(f.proof);
  });
  await assert.rejects(reconcile(f), { code: 'OWNED_PIE_PROOF_INVALID' });
  assert.equal(f.adapter.state, 'locked');
  assert.equal(f.context.getInFlightMutationCount(), 1);
});
await check('committed oracle agrees with independently fixed commandlet constants', async () => {
  const spec = JSON.parse(readFileSync(new URL('./fixtures/owned-pie/oracle.json', import.meta.url)));
  for (const [key, value] of Object.entries(oracle)) assert.deepEqual(spec[key], key === 'rotation' ? [0, 0, 0] : value);
  const source = readFileSync(new URL('./fixtures/uemcp-fixture/Source/UEMCPFixture/OwnedPIEFixtureCommandlet.cpp', import.meta.url), 'utf8');
  for (const value of [oracle.mapPath, oracle.name, oracle.missingActorName, 'UEMCP owned disposable PIE fixture v1', 'nativePIEQualified']) assert.ok(source.includes(value), value);
  assert.equal(spec.simulatePhysics, false); assert.equal(spec.actorTick, false);
});
await check('ownership is rechecked before a later lifecycle mutation', async () => {
  const f = await owned(); await verify(f); f.guard.exclusive = false;
  await assert.rejects(f.adapter.call('start_pie', {}, { deadlineAt: Date.now() + 100 }), { code: 'OWNED_PIE_PROOF_INVALID' });
  assert.equal(f.fake.callsFor('start_pie').length, 0);
});
await check('signed zero canonicalizes without changing the accepted lifecycle runner', async () => {
  const f = await owned(); f.proof.actor.rotation = [-0, 90, -0];
  await verify(f);
  f.fake.on('get_pie_actor_state', () => success({ ...actor, transform: { ...actor.transform, rotation: [-0, 90, -0] } }));
  const actual = await f.adapter.call('get_pie_actor_state', {}, { deadlineAt: Date.now() + 1000 });
  assert.deepEqual(actual.transform.rotation, [0, 90, 0]);
});
await check('nonzero transform differences remain exact failures', async () => {
  const f = await owned(); f.proof.actor.rotation = [0, 90 + 1e-10, 0];
  await assert.rejects(verify(f), { code: 'OWNED_PIE_PROOF_INVALID' });
});
await check('new native oracle verifies zero rotation independently of historical fake oracle', async () => {
  const f = await owned();
  const spec = JSON.parse(readFileSync(new URL('./fixtures/owned-pie/oracle.json', import.meta.url)));
  f.proof.actor.rotation = [0, 0, -0];
  await f.adapter.verifyOwnedHost(spec, Date.now() + 1000);
});
process.exitCode = t.summary();
