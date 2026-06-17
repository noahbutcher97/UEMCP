import { TestRunner } from './test-helpers.mjs';
import {
  classifySmokeProcessResult,
  discoverLiveSmokeScripts,
  resolveLiveSmokeRunnerConfig,
  shouldSkipLiveSmokeSuite,
} from './run-live-smoke.mjs';

const runner = new TestRunner('run-live-smoke');

const discovered = discoverLiveSmokeScripts();
runner.assert(discovered.includes('live-smoke-blueprint-timer-mover.mjs'), 'discovers timer-mover smoke');
runner.assert(discovered.includes('live-smoke-d147-blueprint-pie.mjs'), 'discovers D147 smoke');
runner.assert(!discovered.includes('live-smoke-harness.mjs'), 'does not discover harness as smoke');
runner.assert(!discovered.includes('run-live-smoke.mjs'), 'does not discover runner as smoke');

const skipDecision = shouldSkipLiveSmokeSuite({});
runner.assert(skipDecision.skip === true, 'suite skips without live opt-in');
runner.assert(/UEMCP_LIVE_SMOKE/.test(skipDecision.reason), 'suite skip explains missing opt-in');

const runDecision = shouldSkipLiveSmokeSuite({ UEMCP_LIVE_SMOKE: '1' });
runner.assert(runDecision.skip === false, 'suite runs with live opt-in');

const blockedConfig = resolveLiveSmokeRunnerConfig({
  env: { UEMCP_LIVE_SMOKE: '1' },
  argv: [],
});
runner.assert(blockedConfig.exitCode === 2, 'live opt-in without explicit project blocks before spawning scripts');
runner.assert(blockedConfig.code === 'BLOCKED_CONFIG', 'runner missing project reports BLOCKED_CONFIG');

const explicitProject = resolveLiveSmokeRunnerConfig({
  env: { UEMCP_LIVE_SMOKE: '1' },
  argv: ['--project', 'D:/Example/Project'],
});
runner.assert(explicitProject.exitCode === 0, 'runner accepts --project');
runner.assert(explicitProject.env.UNREAL_PROJECT_ROOT === 'D:/Example/Project', 'runner maps --project into child env project root');
runner.assert(explicitProject.env.UEMCP_LIVE_PROJECT_ROOT === 'D:/Example/Project', 'runner records explicit smoke project root');

runner.assert(classifySmokeProcessResult({
  status: 0,
  stdout: '  ⊘ skipped live-smoke: editor unavailable\n',
  stderr: '',
}).kind === 'SKIPPED', 'classifies skip marker as SKIPPED');

runner.assert(classifySmokeProcessResult({
  status: 0,
  stdout: 'PASS smoke\n',
  stderr: '',
}).kind === 'PASS', 'classifies clean zero exit as PASS');

const failed = classifySmokeProcessResult({
  status: 1,
  stdout: 'PASS setup\n',
  stderr: 'Error: failed\n',
});
runner.assert(failed.kind === 'FAIL', 'classifies nonzero exit as FAIL');
runner.assert(/Error: failed/.test(failed.detail), 'failure detail includes stderr');

process.exit(runner.summary());
