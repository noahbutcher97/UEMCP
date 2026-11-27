import { readFileSync, writeFileSync, mkdirSync, realpathSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { executeEvaluationJob } from './evaluation-jobs.mjs';
import { executeRegistered, loadWorkloads, workloadRequest } from './evaluation-workloads.mjs';
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
  const spec = {
    kind: 'project_measurement', version: 2, description: 'Measure an owned value', mode: 'commandlet',
    handler: '/Script/WorkloadSample.ProjectMeasurement',
    input_schema: { type: 'object', properties: { label: { type: 'string', default: 'probe' }, length: { type: 'number' } },
      required: ['length'], additionalProperties: false },
    result_schema: { type: 'object', properties: { square: { type: 'number' } }, required: ['square'], additionalProperties: false },
  };
  const manifest = project + '.uemcp-workloads.json';
  const install = (...workloads) => writeFileSync(manifest, JSON.stringify({ schema_version: 1, workloads }));
  install(spec);
  const catalog = loadWorkloads(project);
  t.assert(catalog.has(spec.kind) && !loadWorkloads(adjacent).has(spec.kind), 'discovery binds installed providers to the exact project');
  const custom = { request_id: 'extension', kind: spec.kind, inputs: { length: 2 } };
  t.assert(workloadRequest(custom, catalog).inputs.label === 'probe', 'a registered workload accepts its own shape and applies declared defaults');
  const item = await invoke('start_evaluation_job', custom);
  const retry = await invoke('start_evaluation_job', { ...custom, version: 2, inputs: { label: 'probe', length: 2 } });
  t.assert(item.job_id === retry.job_id && item.version === 2, 'semantically equivalent registered inputs preserve job identity');
  await t.assertRejects(() => invoke('start_evaluation_job', { ...custom, inputs: { lenght: 2 } }), /Invalid .* inputs/, 'misspelled workload argument is rejected');
  await t.assertRejects(() => invoke('start_evaluation_job', { ...custom, version: 3 }), /version unavailable/, 'unknown version is refused before launch');
  await t.assertRejects(() => invoke('start_evaluation_job', { ...custom, inputs: { length: 2, label: 'x'.repeat(65536) } }), /exceeds 60 KiB/, 'oversized canonical input cannot publish an unreadable durable record');
  const fakeDefinition = { execute: () => ({ text: 'x'.repeat(800 * 1024) }), checkResult: () => true };
  await t.assertRejects(() => executeRegistered(fakeDefinition, {}, { checkCancellation() {} }), /result exceeds/, 'oversized result is rejected before a terminal decision is published');
  install(spec, spec);
  await t.assertRejects(async () => loadWorkloads(project), /Duplicate workload/, 'colliding registrations cannot overwrite one another');
  writeFileSync(manifest, 'broken');
  t.assert((await invoke('start_evaluation_job', args)).job_id === a.job_id, 'broken extension manifest does not prevent a builtin retry');
  install(spec);
  const digest = text => createHash('sha256').update(text).digest('hex');
  const canonicalProject = realpathSync(project);
  const store = join(root, 'Saved', 'UEMCP', 'EvaluationJobs', digest(process.platform === 'win32' ? canonicalProject.toLowerCase() : canonicalProject));
  for (const state of ['queued', 'succeeded']) {
    const request_id = 'before_upgrade_' + state, id = digest(request_id), dir = join(store, id);
    mkdirSync(dir);
    const legacy = { request_id, kind: 'player_start_spacing', config: args.config, map: args.map, seed: args.seed };
    writeFileSync(join(dir, 'request.json'), JSON.stringify({ input: legacy, registered: 1 }));
    if (state === 'succeeded') writeFileSync(join(dir, 'decision.json'), JSON.stringify({ state, result: { original: true } }));
    const replay = await invoke('start_evaluation_job', { request_id, kind: legacy.kind, version: 1,
      inputs: { seed: args.seed, map: args.map, config: args.config } });
    t.assert(replay.job_id === id && replay.state === state && !existsSync(join(dir, 'claim.json')),
      'pre-upgrade ' + state + ' record retains identity on semantically identical resubmission');
    await t.assertRejects(() => invoke('start_evaluation_job', { ...legacy, seed: 18 }), /REQUEST_CONFLICT/, 'pre-upgrade ' + state + ' record rejects materially changed input');
    t.assert(JSON.parse(readFileSync(join(dir, 'request.json'))).registered === 1, 'legacy record is retained: ' + state);
  }
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
