import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeEvaluationJob } from './evaluation-jobs.mjs';
import { trainSpacingPolicy } from './spacing-policy.mjs';
import { validateSpacingInputs } from './run-spacing-evaluation.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const t = new TestRunner('Project evaluation registration and bounded PPO');
const root = createCanonicalScratchRoot('uemcp-jobs-');
try {
  const project = join(root, 'One.uproject'), adjacent = join(root, 'Two.uproject');
  for (const p of [project, adjacent]) writeFileSync(p, '{}');
  const args = { request_id: 'same', config: '/Game/DA_Config', map: '/Game/Map', seed: 17 };
  const invoke = (name, params, p = project) => executeEvaluationJob(name, params, p, {}, async () => {});
  const [a,b] = await Promise.all([invoke('start_evaluation_job', args), invoke('start_evaluation_job', args)]);
  t.assert(a.job_id === b.job_id && a.state === 'queued', 'duplicate concurrent registrations bind the same durable request');
  await t.assertRejects(() => invoke('start_evaluation_job', { ...args, seed: 18 }), /REQUEST_CONFLICT/, 'same ID cannot change inputs');
  const ref = { job_id: a.job_id };
  let wakes = 0;
  const queued = await executeEvaluationJob('get_evaluation_job', ref, project, {}, async () => { wakes++; });
  t.assert(wakes === 1 && queued.state === 'queued', 'poll recovers a committed registration after loss of its submitting server');
  await t.assertRejects(() => invoke('get_evaluation_result', ref, adjacent), /Unknown evaluation job/, 'adjacent projects do not share results');
  await t.assertRejects(() => invoke('cancel_evaluation_job', ref, adjacent), /Unknown evaluation job/, 'adjacent projects cannot cancel the request');
  await invoke('cancel_evaluation_job', ref);
  t.assert((await invoke('start_evaluation_job', args)).state === 'cancelled', 'a retry cannot revive a cancelled request');
  await t.assertRejects(async () => validateSpacingInputs({ ...args, map: '/Game/../Engine' }), /package path/, 'paths must be ordinary saved project packages');
  await t.assertRejects(async () => validateSpacingInputs({ ...args, seed: 2.5 }), /Seed/, 'fractional seeds are invalid');
  const evaluation = { seed: 17, threshold_metres: 0.25, starts: [
    { nearest_metres: 0.1, meets_minimum: false }, { nearest_metres: 0.4, meets_minimum: true },
  ] };
  const policy = trainSpacingPolicy(evaluation, 2048);
  t.assert(policy.steps === 2048 && policy.weights[1] > 0 && policy.mean_reward > 0.5, 'training performs the specified number of steps and learns the clearance decision');
  t.assert(JSON.stringify(policy) === JSON.stringify(trainSpacingPolicy(evaluation, 2048)), 'the saved seed reproduces all policy parameters');
  await t.assertRejects(async () => trainSpacingPolicy(evaluation, 8193), /32–8192/, 'training enforces its step budget');
} finally {
  cleanupCanonicalScratchRoot(root, 'uemcp-jobs-');
}
process.exitCode = t.summary() === 0 ? 0 : 1;
