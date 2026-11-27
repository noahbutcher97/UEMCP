import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { runSpacingEvaluation, validateSpacingInputs } from './run-spacing-evaluation.mjs';
import { trainSpacingPolicy } from './spacing-policy.mjs';

const workerFile = fileURLToPath(import.meta.url);
const idPattern = /^[a-f0-9]{64}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const doc = (dir, name) => {
  const path = join(dir, name + '.json');
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('Invalid job record ' + name);
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) { if (err.code === 'ENOENT') return null; throw err; }
};

// Publish a fully written record. A hard link selects precisely one winner for
// request identity, execution claim and terminal outcome, even across MCP processes.
function record(dir, name, value, replace = false) {
  const path = join(dir, name + '.json'), tmp = join(dir, randomUUID() + '.pending');
  try {
    const fd = openSync(tmp, 'wx');
    try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
    if (replace) renameSync(tmp, path);
    else linkSync(tmp, path);
    return true;
  } catch (err) { if (!replace && err.code === 'EEXIST') return false; throw err; }
  finally { if (existsSync(tmp)) unlinkSync(tmp); }
}

function directory(parent, name, create) {
  const path = join(parent, name);
  if (create) { try { mkdirSync(path); } catch (err) { if (err.code !== 'EEXIST') throw err; } }
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Job storage requires ordinary project directories.');
  return path;
}

function storage(project, create) {
  let dir = dirname(realpathSync(project));
  for (const name of ['Saved', 'UEMCP', 'EvaluationJobs']) dir = directory(dir, name, create);
  const canonical = realpathSync(project);
  const projectKey = hash(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
  return directory(dir, projectKey, create);
}

function input(args) {
  const { request_id, config, map, seed, kind = 'player_start_spacing', steps } = args;
  if (typeof request_id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(request_id)) throw new Error('Supply a stable request_id of 1–80 letters, digits, underscores or hyphens.');
  validateSpacingInputs({ config, map, seed });
  if (!['player_start_spacing', 'train_spacing_policy'].includes(kind)) throw new Error('Unknown job kind.');
  if (kind === 'train_spacing_policy' && (!Number.isInteger(steps) || steps < 32 || steps > 8192)) throw new Error('Training requires 32–8192 steps.');
  if (kind !== 'train_spacing_policy' && steps !== undefined) throw new Error('Only training accepts steps.');
  return { request_id, kind, config, map, seed, ...(steps === undefined ? {} : { steps }) };
}

function endpointFor(store) {
  const key = hash(process.platform === 'win32' ? store.toLowerCase() : store).slice(0, 32);
  return process.platform === 'win32' ? '\\\\.\\pipe\\uemcp-eval-' + key : join(tmpdir(), 'uemcp-eval-' + key + '.sock');
}

async function ownerOf(store) {
  return new Promise(done => {
    const socket = createConnection(endpointFor(store));
    let message = '';
    const finish = value => { socket.destroy(); done(value); };
    socket.setTimeout(500, () => finish(undefined));
    socket.on('data', chunk => { message += chunk; if (message.length > 100) finish(null); });
    socket.once('end', () => finish(message));
    socket.once('error', err => finish(['ENOENT', 'ECONNREFUSED'].includes(err.code) ? null : undefined));
  });
}

function describe(dir, id, owner, includeResult = false) {
  const req = doc(dir, 'request');
  if (!req) throw new Error('Unknown evaluation job.');
  const decision = doc(dir, 'decision'), claim = doc(dir, 'claim');
  const running = claim && claim.owner === owner;
  let state = decision?.state ?? (claim ? (running ? 'running' : 'recovering') : 'queued');
  if (state === 'cancelled' && claim && !doc(dir, 'finished')) state = 'cancelling';
  const result = { job_id: id, request_id: req.input.request_id, kind: req.input.kind, state,
    progress: doc(dir, 'progress') ?? { phase: state }, artifacts: [] };
  if (decision && ['failed', 'cancelled', 'succeeded'].includes(state)) result.progress = { ...result.progress, phase: state };
  if (existsSync(join(dir, 'evaluation.log'))) result.artifacts.push('evaluation.log');
  if (state === 'succeeded') {
    result.artifacts.push('decision.json');
    if (includeResult) result.result = decision.result;
  }
  if (state === 'failed') result.error = decision?.error ?? 'Evaluation worker exited before recording completion.';
  return result;
}

async function wake(project, env) {
  const windows = process.platform === 'win32';
  const executable = windows ? join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe') : process.execPath;
  const args = windows ? ['-NoProfile', '-NonInteractive', '-File', join(dirname(workerFile), 'evaluation-owner.ps1'), '-Node', process.execPath, '-Project', project, '-Launch', ...(env.UE_ENGINE_ROOT ? ['-EngineRoot', env.UE_ENGINE_ROOT] : [])] : [workerFile, '--drain', project];
  const fd = openSync(join(storage(project, false), 'launcher.log'), 'a');
  let proc;
  try { proc = spawn(executable, args, { env, detached: !windows, windowsHide: true, stdio: ['ignore', fd, fd] }); }
  finally { closeSync(fd); }
  if (windows) {
    const timeout = setTimeout(() => proc.kill(), 4500);
    try {
      const [code] = await once(proc, 'close');
      if (code !== 0) throw new Error('Evaluation launcher failed. Retry the same request_id and inspect launcher.log in the project job directory.');
    } finally { clearTimeout(timeout); }
  } else {
    await once(proc, 'spawn');
    proc.unref();
  }
}

export async function executeEvaluationJob(name, args, project, env = process.env, launchWorker = wake) {
  if (!project) throw new Error('Attach a project first.');
  project = realpathSync(project);
  if (name === 'start_evaluation_job') {
    const params = input(args), store = storage(project, true), id = hash(params.request_id);
    const dir = directory(store, id, true);
    const created = record(dir, 'request', { input: params, registered: Date.now() });
    if (!created && JSON.stringify(doc(dir, 'request')?.input) !== JSON.stringify(params)) throw new Error('REQUEST_CONFLICT: this request_id is bound to different inputs.');
    const owner = await ownerOf(store);
    const status = describe(dir, id, owner);
    if (['queued', 'recovering', 'cancelling'].includes(status.state) && owner === null) await launchWorker(project, env);
    return status;
  }
  const id = args.job_id;
  if (!idPattern.test(id ?? '')) throw new Error('Invalid job_id.');
  let dir;
  try { dir = directory(storage(project, false), id, false); }
  catch (err) { if (err.code === 'ENOENT') throw new Error('Unknown evaluation job in the attached project.'); throw err; }
  const owner = await ownerOf(dirname(dir));
  if (name === 'cancel_evaluation_job') {
    if (!doc(dir, 'request')) throw new Error('Unknown evaluation job.');
    const state = describe(dir, id, owner).state;
    if (!['failed','cancelled','succeeded'].includes(state)) record(dir, 'decision', { state: 'cancelled' });
  }
  const status = describe(dir, id, owner, name === 'get_evaluation_result');
  if (owner === null && ['queued', 'recovering', 'cancelling'].includes(status.state)) await launchWorker(project, env);
  return status;
}

async function executeOne(project, dir, request, owner) {
  if (doc(dir, 'decision')) return;
  const args = input(request.input);
  if (!record(dir, 'claim', { pid: process.pid, owner, started: Date.now() })) return;
  const controller = new AbortController();
  const check = () => { if (doc(dir, 'decision')?.state === 'cancelled') controller.abort(); };
  const interval = setInterval(check, 100);
  try {
    check();
    record(dir, 'progress', { phase: 'evaluating' }, true);
    const evaluation = await runSpacingEvaluation({ ...args, project, output: dir, signal: controller.signal,
      onChild: pid => record(dir, 'child', { pid }) });
    let policy;
    if (args.kind === 'train_spacing_policy') {
      policy = trainSpacingPolicy(evaluation, args.steps, steps => {
        if (doc(dir, 'decision')?.state === 'cancelled') throw new Error('Training cancelled.');
        if (steps % 512 === 0 || steps === args.steps) record(dir, 'progress', { phase: 'training', steps }, true);
      });
    }
    record(dir, 'decision', { state: 'succeeded', result: { evaluation, ...(policy ? { policy } : {}) } });
  } catch (error) {
    record(dir, 'decision', { state: 'failed', error: error.message });
  } finally {
    clearInterval(interval);
    record(dir, 'finished', { time: Date.now() });
  }
}

function pending(store) {
  return readdirSync(store, { withFileTypes: true }).filter(entry => entry.isDirectory() && idPattern.test(entry.name)).map(entry => {
    const dir = directory(store, entry.name, false);
    const decision = doc(dir, 'decision');
    if (decision && !(decision.state === 'cancelled' && doc(dir, 'claim') && !doc(dir, 'finished'))) return null;
    const request = doc(dir, 'request');
    return request && { dir, request };
  }).filter(Boolean).sort((a,b) => a.request.registered - b.request.registered);
}

async function drain(project) {
  const store = storage(project, false);
  const endpoint = endpointFor(store), owner = randomUUID();
  const lock = createServer(socket => { socket.on('error', () => {}); socket.end(owner); });
  try { await new Promise((ok, fail) => { lock.once('error', fail); lock.listen(endpoint, ok); }); }
  catch (err) { if (err.code === 'EADDRINUSE') return; throw err; }
  try {
    for (;;) {
      const next = pending(store)[0];
      if (!next) break;
      const claim = doc(next.dir, 'claim');
      if (claim) {
        // The previous owner's OS lease is gone. Its Windows job object
        // terminates the process tree when its supervising process exits.
        record(next.dir, 'decision', { state: 'failed', error: 'Evaluation worker was interrupted.' });
        record(next.dir, 'finished', { time: Date.now() });
      } else await executeOne(project, next.dir, next.request, owner);
    }
  } finally { await new Promise(done => lock.close(done)); }
  // A concurrent registrar may have observed the previous lock just before release.
  if (pending(store).length) await wake(project, process.env);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv[2] !== '--drain' || !process.argv[3]) process.exitCode = 2;
  else await drain(realpathSync(process.argv[3]));
}
