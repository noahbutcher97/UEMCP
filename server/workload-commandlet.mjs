import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { createProcessRunner, terminateProcessTree } from './deployment/process-runner.mjs';
import { prepareOwnedHostRuntime } from './prepare-fixture-host.mjs';

async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

export async function savedInput(projectRoot, pkg, ext) {
  const content = realpathSync(join(projectRoot, 'Content'));
  const file = realpathSync(join(content, pkg.slice(6) + ext));
  const rel = relative(content, file);
  if (rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('Saved input resolves outside Content.');
  for (const sidecar of ['.uexp', '.ubulk', '.uptnl']) {
    if (existsSync(file.slice(0, -ext.length) + sidecar)) throw new Error('This evaluation requires monolithic editor packages.');
  }
  return digest(file);
}

export async function runWorkloadCommandlet({ project, output, env = process.env, signal, onChild, commandlet, parameters }) {
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
  if (signal?.aborted) throw new Error('Evaluation cancelled.');
  mkdirSync(output, { recursive: true });
  const hostParent = dirname(root);
  const runtime = owned
    ? prepareOwnedHostRuntime({ outputRoot: hostParent, engineRoot: engine, env })
    : { env, args: ['-UserDir=' + join(output, 'User')] };
  const args = [project, '-run=' + commandlet, ...parameters, '-EvaluationOwner=' + process.pid,
    '-unattended', '-nullrhi', '-nosound', '-nop4', '-NoShaderCompile', '-NoLiveCoding', '-stdout',
    '-FullStdOutLogOutput', '-abslog=' + join(output, 'evaluation.log'), ...runtime.args];
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
  if (!report.engine_build?.startsWith(expectedBuild)) throw new Error('Evaluation result identity or measurements failed validation.');
  return { report, duration_ms: execution.durationMs };
}
