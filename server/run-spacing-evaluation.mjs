import { mkdirSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { executeRegistered, loadWorkloads, workloadRequest } from './evaluation-workloads.mjs';
export { runSpacingEvaluation, validateSpacingInputs } from './spacing-evaluation.mjs';

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [project, config, map, seed, output] = process.argv.slice(2);
  if (!project || !output) { console.error('Usage: node run-spacing-evaluation.mjs PROJECT.uproject CONFIG MAP SEED NEW_OUTPUT_DIRECTORY'); process.exitCode = 2; }
  else {
    try {
      const catalog = loadWorkloads(project, 'player_start_spacing');
      const args = workloadRequest({ request_id: 'synchronous', config, map, seed: Number(seed) }, catalog);
      mkdirSync(output);
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      process.once('SIGTERM', () => controller.abort());
      const { evaluation } = await executeRegistered(catalog.get(args.kind), args.inputs, {
        project: realpathSync(project), output: resolve(output), signal: controller.signal,
        checkCancellation() { controller.signal.throwIfAborted(); },
      });
      console.log(JSON.stringify(evaluation));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
