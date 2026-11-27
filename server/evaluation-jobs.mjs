import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync,
  readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { canonicalJson, executeRegistered, loadWorkloads, workloadRequest } from './evaluation-workloads.mjs';

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
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > 1024 * 1024) throw new Error('Job record exceeds 1 MiB: ' + name);
    const fd = openSync(tmp, 'wx');
    try { writeFileSync(fd, encoded); fsyncSync(fd); } finally { closeSync(fd); }
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
  const result = { job_id: id, request_id: req.input.request_id, kind: req.input.kind, version: req.input.version ?? 1, state,
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
  if (name === 'list_evaluation_workloads') {
    return { workloads: Array.from(loadWorkloads(project).values(), spec => spec.metadata) };
  }
  if (name === 'start_evaluation_job') {
    const catalog = loadWorkloads(project, args.kind ?? 'player_start_spacing');
    const params = workloadRequest(args, catalog);
    const definition = catalog.get(params.kind);
    const store = storage(project, true), id = hash(params.request_id);
    const dir = directory(store, id, true);
    const created = record(dir, 'request', { input: params, registration: definition.fingerprint, registered: Date.now() });
    if (!created) {
      const original = doc(dir, 'request');
      const prior = original.input.version === undefined
        ? workloadRequest({ ...original.input, version: 1 }, catalog) : original.input;
      if (canonicalJson(prior) !== canonicalJson(params) || (original.registration && original.registration !== definition.fingerprint))
        throw new Error('REQUEST_CONFLICT: this request_id is bound to different inputs or registration.');
    }
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
  if (!record(dir, 'claim', { pid: process.pid, owner, started: Date.now() })) return;
  const controller = new AbortController();
  const check = () => { if (doc(dir, 'decision')?.state === 'cancelled') controller.abort(); };
  const interval = setInterval(check, 100);
  try {
    const catalog = loadWorkloads(project, request.input.kind);
    const args = workloadRequest({ ...request.input, version: request.input.version ?? 1 }, catalog);
    const definition = catalog.get(args.kind);
    if (request.registration && request.registration !== definition.fingerprint)
      throw new Error('The registered workload definition changed since submission. Restore its version or submit a new request.');
    const progress = value => record(dir, 'progress', value, true);
    progress({ phase: 'evaluating' });
    const result = await executeRegistered(definition, args.inputs, {
      project, output: dir, signal: controller.signal, progress, onChild: pid => record(dir, 'child', { pid }),
      checkCancellation() { check(); if (controller.signal.aborted) throw new Error('Evaluation cancelled.'); },
    });
    record(dir, 'decision', { state: 'succeeded', result });
  } catch (error) {
    record(dir, 'decision', { state: 'failed', error: String(error.message).slice(0, 8192) });
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
