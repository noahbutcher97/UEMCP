import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createProcessRunner, terminateProcessTree } from './deployment/process-runner.mjs';
import { prepareOwnedHostRuntime } from './prepare-fixture-host.mjs';

const packagePath = /^\/Game\/(?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+$/;
export function validateSpacingInputs({ config, map, seed }) {
  for (const value of [config, map]) {
    if (typeof value !== 'string' || value.length > 512 || !packagePath.test(value)) throw new Error('Supply a saved /Game package path without an object suffix.');
  }
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) throw new Error('Seed must be an integer between 0 and 2147483647.');
}

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function savedInput(projectRoot, pkg, ext) {
  const content = realpathSync(join(projectRoot, 'Content'));
  const file = realpathSync(join(content, pkg.slice(6) + ext));
  const rel = relative(content, file);
  if (rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Saved input resolves outside Content.');
  for (const sidecar of ['.uexp', '.ubulk', '.uptnl']) {
    if (existsSync(file.slice(0, -ext.length) + sidecar)) throw new Error('This evaluation requires monolithic editor packages.');
  }
  return digest(file);
}

export async function runSpacingEvaluation({ project, config, map, seed, output, env = process.env, signal, onChild }) {
  validateSpacingInputs({ config, map, seed });
  project = realpathSync(project);
  const root = dirname(project);
  const association = JSON.parse(readFileSync(project, 'utf8').replace(/^\uFEFF/, '')).EngineAssociation;
  const engine = env.UE_ENGINE_ROOT || (/^5\.\d+$/.test(association) && join('C:/Program Files/Epic Games', 'UE_' + association));
  if (!engine || !isAbsolute(engine)) throw new Error('Set UE_ENGINE_ROOT to the engine that built this project.');
  const owned = existsSync(join(dirname(root), 'host-manifest.json')) && resolve(dirname(root), 'host') === resolve(root);
  const build = JSON.parse(readFileSync(join(engine, 'Engine/Build/Build.version'), 'utf8'));
  if (!owned && /^5\.\d+$/.test(association) && association !== build.MajorVersion + '.' + build.MinorVersion) throw new Error('Installed engine does not match the project association.');
  const expectedBuild = [build.MajorVersion, build.MinorVersion, build.PatchVersion].join('.') + '-' + build.Changelist + '+';
  const binary = realpathSync(join(engine, 'Engine/Binaries/Win64/UnrealEditor-Cmd.exe'));
  const hashes = async () => ({ config: await savedInput(root, config, '.uasset'), map: await savedInput(root, map, '.umap') });
  const before = await hashes();
  if (signal?.aborted) throw new Error('Evaluation cancelled.');
  mkdirSync(output, { recursive: true });
  const hostParent = dirname(root);
  const runtime = owned
    ? prepareOwnedHostRuntime({ outputRoot: hostParent, engineRoot: engine, env })
    : { env, args: ['-UserDir=' + join(output, 'User')] };
  const args = [project, '-run=UEMCPEvaluate', '-EvaluationConfig=' + config, '-EvaluationMap=' + map,
    '-EvaluationSeed=' + seed, '-EvaluationOwner=' + process.pid, '-unattended', '-nullrhi', '-nosound', '-nop4',
    '-NoShaderCompile', '-NoLiveCoding', '-stdout', '-FullStdOutLogOutput', '-abslog=' + join(output, 'evaluation.log'), ...runtime.args];
  let child;
  let cleanup, ownerError;
  const abort = () => { if (child && !cleanup) cleanup = terminateProcessTree(child); };
  const runner = createProcessRunner({ spawnImpl(...params) {
    child = spawn(...params);
    if (child.pid && onChild) {
      try { onChild(child.pid); } catch (error) { ownerError = error; abort(); }
    }
    if (signal?.aborted) abort();
    return child;
  } });
  signal?.addEventListener('abort', abort, { once: true });
  let execution;
  try { execution = await runner.run(binary, args, { cwd: root, env: runtime.env, timeoutMs: 180000, outputLimitBytes: 8 * 1024 * 1024 }); }
  finally { signal?.removeEventListener('abort', abort); if (cleanup) await cleanup; }
  if (ownerError) throw ownerError;
  if (signal?.aborted) throw new Error('Evaluation cancelled.');
  const lines = execution.stdout.split(/\r?\n/);
  if (execution.exitCode !== 0 || execution.status !== 'exited') {
    const diagnostic = lines.find(line => line.includes('UEMCP_EVALUATION_ERROR '))?.split('UEMCP_EVALUATION_ERROR ')[1];
    throw new Error(diagnostic || 'Evaluation commandlet ' + execution.status + ', exit ' + execution.exitCode + '. Inspect evaluation.log.');
  }
  const marker = 'UEMCP_EVALUATION_RESULT ';
  const reports = lines.filter(line => line.includes(marker));
  if (reports.length !== 1) throw new Error('Expected one terminal evaluation result.');
  const report = JSON.parse(reports[0].split(marker)[1]);
  if (report.evaluation !== 'player_start_spacing' || report.config !== config || report.map !== map || report.seed !== seed ||
      !report.engine_build?.startsWith(expectedBuild) || !Array.isArray(report.starts) || report.starts.length < 2 ||
      !report.starts.every(row => Number.isFinite(row.nearest_metres) && typeof row.meets_minimum === 'boolean') ||
      report.passed !== report.starts.filter(row => row.meets_minimum).length) throw new Error('Evaluation result identity or measurements failed validation.');
  const after = await hashes();
  if (before.config !== after.config || before.map !== after.map || report.config_sha256 !== before.config || report.map_sha256 !== before.map) throw new Error('Saved inputs changed during evaluation.');
  return { ...report, input_sha256: before, mode: 'commandlet', duration_ms: execution.durationMs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [project, config, map, seed, output] = process.argv.slice(2);
  if (!project || !output) { console.error('Usage: node run-spacing-evaluation.mjs PROJECT.uproject CONFIG MAP SEED NEW_OUTPUT_DIRECTORY'); process.exitCode = 2; }
  else {
    try {
      mkdirSync(output);
      const controller = new AbortController();
      process.once('SIGINT', () => controller.abort());
      process.once('SIGTERM', () => controller.abort());
      console.log(JSON.stringify(await runSpacingEvaluation({ project, config, map, seed: Number(seed), output: resolve(output), signal: controller.signal })));
    } catch (error) { console.error(error.message); process.exitCode = 1; }
  }
}
