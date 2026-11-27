import { realpathSync } from 'node:fs';
import { dirname } from 'node:path';
import { runWorkloadCommandlet, savedInput } from './workload-commandlet.mjs';

const packagePath = /^\/Game\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+$/;
export function validateSpacingInputs({ config, map, seed }) {
  for (const value of [config, map]) {
    if (typeof value !== 'string' || value.length > 512 || !packagePath.test(value)) throw new Error('Supply a saved /Game package path without an object suffix.');
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) throw new Error('Seed must be an integer between 0 and 2147483647.');
}

export async function runSpacingEvaluation({ project, config, map, seed, output, env = process.env, signal, onChild }) {
  validateSpacingInputs({ config, map, seed });
  const root = dirname(realpathSync(project));
  const hashes = async () => ({ config: await savedInput(root, config, '.uasset'), map: await savedInput(root, map, '.umap') });
  const before = await hashes();
  const { report, duration_ms } = await runWorkloadCommandlet({
    project, output, env, signal, onChild, commandlet: 'UEMCPEvaluate',
    parameters: ['-EvaluationConfig=' + config, '-EvaluationMap=' + map, '-EvaluationSeed=' + seed],
  });
  if (report.evaluation !== 'player_start_spacing' || report.config !== config || report.map !== map || report.seed !== seed ||
      !Array.isArray(report.starts) || report.starts.length < 2 ||
      !report.starts.every(row => Number.isFinite(row.nearest_metres) && typeof row.meets_minimum === 'boolean') ||
      report.passed !== report.starts.filter(row => row.meets_minimum).length) throw new Error('Evaluation result identity or measurements failed validation.');
  const after = await hashes();
  if (before.config !== after.config || before.map !== after.map || report.config_sha256 !== before.config || report.map_sha256 !== before.map) throw new Error('Saved inputs changed during evaluation.');
  return { ...report, input_sha256: before, mode: 'commandlet', duration_ms };
}
