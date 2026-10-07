import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { PieLifecycleError, remainingMs } from './owned-pie-transport.mjs';

function requireValue(condition, message) {
  if (!condition) throw new PieLifecycleError('PIE_ORACLE_MISMATCH', message);
}

export function validatePieOracle(oracle) {
  requireValue(oracle && typeof oracle.mapPath === 'string' && /^\/Game\/[\w/]+$/.test(oracle.mapPath), 'Owned map package path required.');
  for (const key of ['name', 'class', 'missingActorName']) requireValue(typeof oracle[key] === 'string' && oracle[key].length > 0, `Oracle ${key} required.`);
  requireValue(oracle.name !== oracle.missingActorName, 'Missing actor must differ from the known actor.');
  for (const key of ['location', 'rotation', 'scale']) {
    requireValue(Array.isArray(oracle[key]) && oracle[key].length === 3 && oracle[key].every(Number.isFinite), `Oracle ${key} must be a finite triple.`);
  }
  requireValue(Number.isFinite(oracle.CustomTimeDilation), 'Oracle CustomTimeDilation required.');
}

export function assertPieActor(actual, oracle, world) {
  requireValue(actual?.resolved?.matched_by === 'name', 'Actor must resolve by exact name.');
  for (const key of ['name', 'class']) requireValue(actual.resolved[key] === oracle[key], `Actor ${key} differs.`);
  requireValue(isDeepStrictEqual(actual.world, world), 'Actor belongs to a different runtime world.');
  for (const key of ['location', 'rotation', 'scale']) requireValue(isDeepStrictEqual(actual.transform?.[key], oracle[key]), `Actor ${key} differs.`);
  requireValue(actual.properties?.CustomTimeDilation === oracle.CustomTimeDilation, 'CustomTimeDilation differs.');
}

function stopped(session) {
  return session?.pie_running === false && session.active_context_count === 0
    && session.default_pie_instance === -1 && Array.isArray(session.contexts) && session.contexts.length === 0;
}

function runtimeWorld(session, oracle) {
  requireValue(session?.pie_running === true && session.active_context_count === 1 && session.contexts?.length === 1, 'Expected one running runtime world.');
  const world = session.contexts[0];
  requireValue(Number.isInteger(world.pie_instance) && world.pie_instance >= 0 && session.default_pie_instance === world.pie_instance && world.is_default === true, 'Invalid default PIE instance.');
  requireValue(world.net_mode === 'Standalone', 'Expected standalone runtime net mode.');
  const mapName = oracle.mapPath.split('/').at(-1);
  const prefix = oracle.mapPath.slice(0, -mapName.length);
  const runtimeName = `UEDPIE_${world.pie_instance}_${mapName}`;
  // UE World.cpp DuplicateWorldForPIE keeps InWorld->GetFName(); PlayLevel.cpp
  // ConvertToPIEPackageName prefixes the package, not the UWorld object name.
  requireValue(world.world_name === mapName && world.world_path === `${prefix}${runtimeName}.${mapName}`, 'Runtime map identity differs.');
  return world;
}

async function expectCode(operation, code) {
  try { await operation(); }
  catch (error) {
    if (error.code === code && error.wireError) return;
    throw error;
  }
  throw new PieLifecycleError('PIE_EXPECTED_ERROR_MISSING', `Expected typed ${code}.`);
}

// No CLI, host launch, map load or fixture authoring. The native coordinator
// supplies an already-owned host and an independently authored actor oracle.
export async function runOwnedPieLifecycle({ adapter, oracle, timeoutMs = 30000, cleanupTimeoutMs = 10000, pollMs = 25 }) {
  validatePieOracle(oracle);
  for (const value of [timeoutMs, cleanupTimeoutMs, pollMs]) {
    if (!Number.isFinite(value) || value <= 0 || value > 300000) throw new PieLifecycleError('INVALID_DEADLINE', 'Budgets must be positive and at most 300000ms.');
  }
  const deadlineAt = Date.now() + timeoutMs;
  const events = [];
  let needsCleanup = false;
  let observedRunning = false;
  const call = (command, params = {}, deadline = deadlineAt) => adapter.call(command, params, { deadlineAt: deadline });
  const actorParams = { actor_ref: { name: oracle.name }, properties: ['CustomTimeDilation'] };
  async function poll(running, deadline = deadlineAt) {
    while (true) {
      remainingMs(deadline);
      const session = await call('get_pie_session_state', {}, deadline);
      if (running && session.pie_running === true && session.active_context_count > 0) return runtimeWorld(session, oracle);
      if (!running && stopped(session)) return session;
      await delay(Math.min(pollMs, remainingMs(deadline)));
    }
  }
  try {
    await adapter.verifyOwnedHost(oracle, deadlineAt);
    requireValue(stopped(await call('get_pie_session_state')), 'PIE must initially be stopped.');
    for (let cycle = 1; cycle <= 2; cycle++) {
      await expectCode(() => call('get_pie_actor_state', actorParams), 'PIE_NOT_RUNNING');
      needsCleanup = true;
      observedRunning = false;
      const start = await call('start_pie', { mode: 'viewport' });
      requireValue(start.requested === true && start.mode === 'viewport', 'Start request was not acknowledged.');
      const world = await poll(true);
      observedRunning = true;
      await expectCode(() => call('start_pie', { mode: 'viewport' }), 'ALREADY_RUNNING');
      const params = { ...actorParams, pie_instance: world.pie_instance };
      const actor = await call('get_pie_actor_state', params);
      assertPieActor(actor, oracle, world);
      await expectCode(() => call('get_pie_actor_state', { pie_instance: world.pie_instance, actor_ref: { name: oracle.missingActorName } }), 'ACTOR_NOT_FOUND');
      const stop = await call('stop_pie');
      requireValue(stop.was_running === true && stop.requested_stop === true, 'Stop request was not acknowledged.');
      await poll(false);
      needsCleanup = false;
      await expectCode(() => call('get_pie_actor_state', actorParams), 'PIE_NOT_RUNNING');
      events.push({ cycle, world, actor, stopped: true });
    }
    return { status: 'passed', cycles: events, nativeQualification: 'caller-supplied-host' };
  } catch (error) {
    if (needsCleanup || adapter.state === 'locked') {
      const cleanupDeadline = Date.now() + cleanupTimeoutMs;
      let reconciliationAttempted = false;
      try {
        if (adapter.state === 'open' && observedRunning) {
          await call('stop_pie', {}, cleanupDeadline);
          await poll(false, cleanupDeadline);
        } else {
          reconciliationAttempted = true;
          await adapter.reconcile(error, cleanupDeadline);
        }
        error.cleanup = { stopped: true };
      } catch (cleanupError) {
        // Never overlap reconciliation callbacks: timeout does not cancel them.
        if (reconciliationAttempted) {
          error.cleanup = { stopped: false, reconciliationCode: cleanupError.code };
          error.events = events;
          throw error;
        }
        try {
          await adapter.reconcile(error, Date.now() + cleanupTimeoutMs);
          error.cleanup = { stopped: true, reconciled: true };
        } catch (reconcileError) {
          error.cleanup = { stopped: false, code: cleanupError.code, reconciliationCode: reconcileError.code };
        }
      }
    }
    error.events = events;
    throw error;
  }
}
