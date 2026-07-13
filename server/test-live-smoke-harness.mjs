import { TestRunner } from './test-helpers.mjs';
import {
  createLiveSmokeCall,
  evaluateLiveSmokeGate,
  isNonMutatingNameConflict,
  isNotFoundCleanupError,
  isTransientPIEActorLookupError,
  pieSelectorFromSessionState,
  stopPIEAndWaitForStopped,
  unwrapLiveSmokeResponse,
} from './live-smoke-harness.mjs';

const runner = new TestRunner('live-smoke harness');

const skippedGate = evaluateLiveSmokeGate({});
runner.assert(skippedGate.shouldRun === false, 'missing UEMCP_LIVE_SMOKE does not run');
runner.assert(skippedGate.skipped === true, 'missing UEMCP_LIVE_SMOKE is a skip');
runner.assert(/UEMCP_LIVE_SMOKE/.test(skippedGate.reason), 'missing UEMCP_LIVE_SMOKE explains skip');
runner.assert(/live editor access/i.test(skippedGate.reason) && !/mutations/i.test(skippedGate.reason),
  'live opt-in describes editor access without claiming every smoke mutates');

const missingProjectRoot = evaluateLiveSmokeGate({ UEMCP_LIVE_SMOKE: '1' });
runner.assert(missingProjectRoot.shouldRun === false, 'live gate requires project root');
runner.assert(missingProjectRoot.exitCode === 2, 'missing project root is usage error');
runner.assert(missingProjectRoot.code === 'BLOCKED_CONFIG', 'missing explicit project reports BLOCKED_CONFIG');
runner.assert(/explicit project/.test(missingProjectRoot.reason), 'missing project explains explicit project requirement');

const ambientEnvRoot = evaluateLiveSmokeGate({
  UEMCP_LIVE_SMOKE: '1',
  UNREAL_PROJECT_ROOT: 'D:/Example/Project',
});
runner.assert(ambientEnvRoot.shouldRun === false, 'ambient UNREAL_PROJECT_ROOT is not enough for live smoke');
runner.assert(ambientEnvRoot.code === 'BLOCKED_CONFIG', 'ambient UNREAL_PROJECT_ROOT reports BLOCKED_CONFIG');

const readyGate = evaluateLiveSmokeGate({
  UEMCP_LIVE_SMOKE: '1',
  UEMCP_PROJECT_ATTACH_MODE: 'env',
  UNREAL_PROJECT_ROOT: 'D:/Example/Project',
});
runner.assert(readyGate.shouldRun === true, 'live gate runs with explicit env attach mode');

const explicitProjectGate = evaluateLiveSmokeGate({
  UEMCP_LIVE_SMOKE: '1',
  UEMCP_LIVE_PROJECT_ROOT: 'D:/Example/Project',
});
runner.assert(explicitProjectGate.shouldRun === true, 'live gate runs with explicit smoke project root');

const unwrapped = unwrapLiveSmokeResponse('compile_blueprint', {
  status: 'success',
  result: { compiled_ok: true },
});
runner.assert(unwrapped.compiled_ok === true, 'unwrap returns success result');

const directSample = unwrapLiveSmokeResponse('sample_pie_actor_state', {
  sample_count: 2,
  samples: [],
});
runner.assert(directSample.sample_count === 2, 'unwrap accepts local sample_pie_actor_state result');

await runner.assertRejects(
  () => Promise.resolve(unwrapLiveSmokeResponse('bad_tool', { status: 'error', error: 'bad' })),
  /bad_tool failed/,
  'unwrap throws on error envelope',
);

const logLines = [];
const call = createLiveSmokeCall({
  summarize: (label, result) => ({ label, id: result.id }),
  log: (line) => logLines.push(line),
});
const callResult = await call('create_blueprint', async () => ({
  status: 'success',
  result: { id: 'BP_Test' },
}));
runner.assert(callResult.id === 'BP_Test', 'call returns unwrapped result');
runner.assert(logLines.some((line) => /PASS create_blueprint/.test(line)), 'call logs PASS line');
runner.assert(logLines.some((line) => /"id":"BP_Test"/.test(line)), 'call logs summarized result');

runner.assert(isNotFoundCleanupError(new Error('asset_not_found: missing asset')), 'not-found cleanup classifier detects asset_not_found');
runner.assert(isNotFoundCleanupError(new Error('Actor does not exist')), 'not-found cleanup classifier detects does-not-exist');
runner.assert(!isNotFoundCleanupError(new Error('permission denied')), 'not-found cleanup classifier rejects unrelated error');

runner.assert(isNonMutatingNameConflict(new Error('blueprint_exists already exists')), 'name-conflict classifier detects existing Blueprint');
runner.assert(isNonMutatingNameConflict(new Error('name conflict: actor exists')), 'name-conflict classifier detects actor conflict');
runner.assert(!isNonMutatingNameConflict(new Error('compile failed')), 'name-conflict classifier rejects unrelated error');

runner.assert(
  isTransientPIEActorLookupError(new Error('tcp-55558: Actor was not found in the selected PIE world')),
  'PIE transient classifier detects actor-not-found during startup',
);
runner.assert(
  isTransientPIEActorLookupError(new Error('tcp-55558: PIE world instance 0 was not found')),
  'PIE transient classifier detects missing PIE instance during startup',
);
{
  const actorNotFound = new Error('tcp-55558: structured actor lookup failure');
  actorNotFound.code = 'ACTOR_NOT_FOUND';
  runner.assert(
    isTransientPIEActorLookupError(actorNotFound),
    'PIE transient classifier detects structured ACTOR_NOT_FOUND code',
  );
}
{
  const worldNotFound = new Error('tcp-55558: structured PIE world lookup failure');
  worldNotFound.wireError = { code: 'PIE_WORLD_NOT_FOUND' };
  runner.assert(
    isTransientPIEActorLookupError(worldNotFound),
    'PIE transient classifier detects structured wireError PIE_WORLD_NOT_FOUND code',
  );
}
runner.assert(
  !isTransientPIEActorLookupError(new Error('tcp-55558: compile failed')),
  'PIE transient classifier rejects unrelated errors',
);

{
  let stopCalls = 0;
  let stateCalls = 0;
  const result = await stopPIEAndWaitForStopped({
    stop: async () => {
      stopCalls++;
      return { status: 'success', result: { was_running: true, call: stopCalls } };
    },
    getState: async () => {
      stateCalls++;
      return {
        status: 'success',
        result: stateCalls < 2
          ? { pie_running: true, active_context_count: 2 }
          : { pie_running: false, active_context_count: 0 },
      };
    },
    delaysMs: [0, 0, 0],
    log: () => {},
  });
  runner.assert(stopCalls === 2, `stopPIEAndWaitForStopped reissues stop while PIE is running (got ${stopCalls})`);
  runner.assert(result.state.pie_running === false, 'stopPIEAndWaitForStopped returns stopped PIE state');
}

const explicitDefaultPIE = pieSelectorFromSessionState({
  pie_running: true,
  active_context_count: 2,
  default_pie_instance: 0,
  contexts: [
    { pie_instance: 0, world_name: 'UEDPIE_0_TestMap', net_mode: 'ListenServer' },
    { pie_instance: 1, world_name: 'Untitled', net_mode: 'Client' },
  ],
});
runner.assert(explicitDefaultPIE.pie_instance === 0, 'PIE selector uses explicit default_pie_instance for multi-PIE');

const firstContextPIE = pieSelectorFromSessionState({
  pie_running: true,
  active_context_count: 1,
  contexts: [
    { pie_instance: 4, world_name: 'UEDPIE_4_TestMap' },
  ],
});
runner.assert(firstContextPIE.pie_instance === 4, 'PIE selector falls back to first context pie_instance');

const noPIESelector = pieSelectorFromSessionState({
  pie_running: false,
  active_context_count: 0,
  default_pie_instance: -1,
  contexts: [],
});
runner.assert(Object.keys(noPIESelector).length === 0, 'PIE selector is empty without an active context');

process.exit(runner.summary());
