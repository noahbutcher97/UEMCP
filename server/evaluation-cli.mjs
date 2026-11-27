import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { executeEvaluationJob } from './evaluation-jobs.mjs';
import { executeRegistered, loadWorkloads, workloadRequest } from './evaluation-workloads.mjs';

const usage = `node evaluation-cli.mjs list PROJECT.uproject
node evaluation-cli.mjs start PROJECT.uproject REQUEST_ID KIND INPUTS_JSON [VERSION]
node evaluation-cli.mjs status|result|cancel PROJECT.uproject JOB_ID
node evaluation-cli.mjs run PROJECT.uproject KIND INPUTS_JSON NEW_OUTPUT_DIRECTORY [VERSION]
Use list to discover the installed kinds and their argument schemas.`;

async function main([action, file, ...rest]) {
  if (!action || action === '--help') { process.stdout.write(`${usage}\n`); return; }
  if (!file) throw new Error(usage);
  const project = realpathSync(file);
  let result;
  if (action === 'list' && !rest.length) result = await executeEvaluationJob('list_evaluation_workloads', {}, project);
  else if (['status', 'result', 'cancel'].includes(action) && rest.length === 1) {
    const tool = { status: 'get_evaluation_job', result: 'get_evaluation_result', cancel: 'cancel_evaluation_job' }[action];
    result = await executeEvaluationJob(tool, { job_id: rest[0] }, project);
  } else if (['run', 'start'].includes(action) && (rest.length === 3 || rest.length === 4)) {
    const [request_id, kind, json] = action === 'start' ? rest : ['synchronous', rest[0], rest[1]];
    const args = { request_id, kind, inputs: JSON.parse(json), version: rest[3] === undefined ? undefined : Number(rest[3]) };
    if (action === 'start') result = await executeEvaluationJob('start_evaluation_job', args, project);
    else {
      const catalog = loadWorkloads(project, kind), normalized = workloadRequest(args, catalog);
      const definition = catalog.get(kind);
      const output = resolve(rest[2]);
      mkdirSync(output);
      const controller = new AbortController();
      const abort = () => controller.abort();
      process.once('SIGINT', abort);
      process.once('SIGTERM', abort);
      let progress;
      try {
        const value = await executeRegistered(definition, normalized.inputs, {
          project, output, signal: controller.signal, progress(value) { progress = value; },
          checkCancellation() { controller.signal.throwIfAborted(); },
        });
        result = { kind, version: normalized.version, result: value, ...(progress && { progress }) };
      } finally {
        process.removeListener('SIGINT', abort);
        process.removeListener('SIGTERM', abort);
      }
    }
  } else throw new Error(usage);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

try { await main(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exitCode = 1; }
