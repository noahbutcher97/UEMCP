import { spawn as defaultSpawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import * as defaultFs from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { canonicalJson, sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { createProcessRunner } from './process-runner.mjs';
import { deleteWindowsTreeNoFollow } from './windows-native.mjs';

const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const SHA256 = /^[0-9a-f]{64}$/;
const LEASE_OWNER_TOKEN = /^[0-9a-f]{48}$/;
const LEASE_COORDINATOR_OUTPUT_LIMIT = 8 * 1024;
const LEASE_COORDINATOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$mutex = $null
$acquired = $false
try {
  $mutex = [System.Threading.Mutex]::new($false, $env:UEMCP_LEASE_MUTEX_NAME)
  try {
    $acquired = $mutex.WaitOne([int]$env:UEMCP_LEASE_MUTEX_WAIT_MS)
  } catch [System.Threading.AbandonedMutexException] {
    $acquired = $true
  }
  if (-not $acquired) {
    [Console]::Error.Write('mutex timeout')
    exit 73
  }
  [Console]::Out.WriteLine('READY')
  [Console]::Out.Flush()
  if ([Console]::In.ReadLine() -ne 'RELEASE') {
    throw 'invalid mutex release signal'
  }
} catch {
  [Console]::Error.Write($_.Exception.GetType().FullName)
  exit 74
} finally {
  if ($acquired -and $null -ne $mutex) {
    $mutex.ReleaseMutex()
  }
  if ($null -ne $mutex) {
    $mutex.Dispose()
  }
}
`;
const LEASE_PROCESS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $pidValue = [int]$env:UEMCP_LEASE_PID
  $processValue = Get-Process -Id $pidValue -ErrorAction Stop
  $start = [DateTimeOffset]$processValue.StartTime.ToUniversalTime()
  [Console]::Out.Write((@{ state = 'alive'; process_start = $start.ToUnixTimeMilliseconds() } | ConvertTo-Json -Compress))
} catch [Microsoft.PowerShell.Commands.ProcessCommandException] {
  [Console]::Out.Write('{"state":"dead"}')
} catch {
  [Console]::Out.Write('{"state":"unknown"}')
}
`;
const inProcessLeaseQueues = new Map();

export class LocalStateError extends Error {
  constructor(message, code = 'LOCAL_STATE_UNAVAILABLE', details = {}) {
    super(message);
    this.name = 'LocalStateError';
    this.code = code;
    this.details = details;
  }
}

function contained(root, candidate) {
  const normalizedRoot = process.platform === 'win32' ? resolve(root).toLowerCase() : resolve(root);
  const normalizedCandidate = process.platform === 'win32' ? resolve(candidate).toLowerCase() : resolve(candidate);
  const rel = relative(normalizedRoot, normalizedCandidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function safeSegment(value, label) {
  if (typeof value !== 'string' || value === '.' || value === '..' || !/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new LocalStateError(`${label} contains unsafe characters`);
  }
  return value;
}

function scratchName(path) {
  return join(dirname(path), `.${randomBytes(16).toString('hex')}.tmp`);
}

function leasePathKey(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function createInProcessLeaseCoordinator(root) {
  const key = leasePathKey(root);
  return async callback => {
    if (typeof callback !== 'function') throw new LocalStateError('lease coordinator callback is invalid', 'LEASE_COORDINATOR_UNAVAILABLE');
    const previous = inProcessLeaseQueues.get(key) ?? Promise.resolve();
    let release;
    const current = new Promise(resolvePromise => {
      release = resolvePromise;
    });
    inProcessLeaseQueues.set(key, current);
    await previous;
    try {
      return await callback();
    } finally {
      release();
      if (inProcessLeaseQueues.get(key) === current) inProcessLeaseQueues.delete(key);
    }
  };
}

function encodedPowerShell(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

export function createApplyLeaseCoordinator({
  root,
  platform = process.platform,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  spawnImpl = defaultSpawn,
  waitMs = 15_000,
} = {}) {
  if (typeof root !== 'string' || !isAbsolute(root)) {
    throw new LocalStateError('lease coordinator root must be absolute', 'LEASE_COORDINATOR_UNAVAILABLE');
  }
  if (typeof spawnImpl !== 'function' || !Number.isSafeInteger(waitMs) || waitMs <= 0) {
    throw new LocalStateError('lease coordinator options are invalid', 'LEASE_COORDINATOR_UNAVAILABLE');
  }
  if (platform !== 'win32') return createInProcessLeaseCoordinator(root);
  if (typeof systemRoot !== 'string' || !isAbsolute(systemRoot)) {
    throw new LocalStateError('SystemRoot is required for the apply-lease coordinator', 'LEASE_COORDINATOR_UNAVAILABLE');
  }

  const powershell = resolve(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  const mutexName = `Local\\UEMCP.DeploymentApply.${sha256Bytes(Buffer.from(leasePathKey(root), 'utf8'))}`;
  const script = encodedPowerShell(LEASE_COORDINATOR_SCRIPT);

  return async callback => {
    if (typeof callback !== 'function') throw new LocalStateError('lease coordinator callback is invalid', 'LEASE_COORDINATOR_UNAVAILABLE');
    let child;
    try {
      child = spawnImpl(powershell, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-EncodedCommand',
        script,
      ], {
        env: {
          SystemRoot: resolve(systemRoot),
          WINDIR: resolve(systemRoot),
          UEMCP_LEASE_MUTEX_NAME: mutexName,
          UEMCP_LEASE_MUTEX_WAIT_MS: String(waitMs),
        },
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      throw new LocalStateError('apply-lease coordinator could not start', 'LEASE_COORDINATOR_UNAVAILABLE');
    }

    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let closed = false;
    let closeCode = null;
    let closeSignal = null;
    let ready = false;
    let settleReady;
    let rejectReady;
    const readyPromise = new Promise((resolvePromise, rejectPromise) => {
      settleReady = resolvePromise;
      rejectReady = rejectPromise;
    });
    const closePromise = new Promise(resolvePromise => {
      child.once('close', (code, signal) => {
        closed = true;
        closeCode = code;
        closeSignal = signal;
        if (!ready) rejectReady(new LocalStateError('apply-lease coordinator exited before acquisition', 'LEASE_COORDINATOR_UNAVAILABLE'));
        resolvePromise();
      });
    });
    const failCoordinator = message => {
      if (!ready) rejectReady(new LocalStateError(message, 'LEASE_COORDINATOR_UNAVAILABLE'));
      try {
        child.kill('SIGKILL');
      } catch {
        // The coordinator may already have exited.
      }
    };
    const capture = (chunk, stream) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > LEASE_COORDINATOR_OUTPUT_LIMIT) {
        failCoordinator('apply-lease coordinator exceeded its output limit');
        return;
      }
      if (stream === 'stdout') {
        stdout += bytes.toString('utf8');
        const newline = stdout.indexOf('\n');
        if (!ready && newline >= 0) {
          const line = stdout.slice(0, newline).replace(/\r$/, '');
          if (line !== 'READY') {
            failCoordinator('apply-lease coordinator returned an invalid handshake');
            return;
          }
          ready = true;
          settleReady();
        }
      } else {
        stderr += bytes.toString('utf8');
      }
    };
    child.stdout?.on('data', chunk => capture(chunk, 'stdout'));
    child.stderr?.on('data', chunk => capture(chunk, 'stderr'));
    child.stdin?.once('error', () => {});
    child.once('error', () => failCoordinator('apply-lease coordinator failed to start'));

    const acquisitionTimer = setTimeout(() => failCoordinator('apply-lease coordinator timed out'), waitMs + 5_000);
    try {
      await readyPromise;
    } finally {
      clearTimeout(acquisitionTimer);
    }

    let value;
    let callbackError = null;
    try {
      value = await callback();
    } catch (error) {
      callbackError = error;
    }

    if (!closed && child.stdin) {
      child.stdin.end('RELEASE\n');
    }
    if (!closed) {
      let releaseTimer;
      const releaseTimeout = new Promise(resolvePromise => {
        releaseTimer = setTimeout(resolvePromise, 5_000);
      });
      await Promise.race([closePromise, releaseTimeout]);
      clearTimeout(releaseTimer);
    }
    if (!closed) {
      try {
        child.kill('SIGKILL');
      } catch {
        // The coordinator may have exited between the timeout and the kill.
      }
      await Promise.race([closePromise, new Promise(resolvePromise => setTimeout(resolvePromise, 250))]);
    }
    if (callbackError) throw callbackError;
    if (!closed || closeCode !== 0 || closeSignal !== null || stderr !== '') {
      throw new LocalStateError('apply-lease coordinator did not release cleanly', 'LEASE_COORDINATOR_UNAVAILABLE');
    }
    return value;
  };
}

async function exists(fsImpl, path) {
  try {
    await fsImpl.lstat(path);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function assertNoLinkedTargetPath(path, { fsImpl, code }) {
  if (typeof path !== 'string' || !isAbsolute(path) || /^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(path)) {
    throw new LocalStateError('snapshot target path is unsafe', code);
  }
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = await fsImpl.lstat(current);
      if (stat.isSymbolicLink()) throw new LocalStateError('snapshot target path contains a symbolic link or junction', code);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return absolute;
}

function stableFileIdentity(stat) {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    birthtime_ms: Number(stat.birthtimeMs),
  };
}

function sameStableFile(left, right) {
  return left.isFile()
    && right.isFile()
    && !left.isSymbolicLink()
    && !right.isSymbolicLink()
    && Number(left.nlink) === 1
    && Number(right.nlink) === 1
    && Number(left.dev) === Number(right.dev)
    && Number(left.ino) === Number(right.ino)
    && Number(left.birthtimeMs) === Number(right.birthtimeMs)
    && Number(left.size) === Number(right.size)
    && Number(left.mtimeMs) === Number(right.mtimeMs)
    && Number(left.ctimeMs) === Number(right.ctimeMs);
}

async function readStableSingleLinkFile(path, { fsImpl, code, missingAllowed = true }) {
  let pathBefore;
  try {
    pathBefore = await fsImpl.lstat(path);
  } catch (error) {
    if (error?.code !== 'ENOENT' || !missingAllowed) throw error;
    try {
      await fsImpl.lstat(path);
    } catch (secondError) {
      if (secondError?.code === 'ENOENT') return { exists: false, bytes: null, stat: null };
      throw secondError;
    }
    throw new LocalStateError('snapshot target appeared during inspection', code);
  }
  if (!pathBefore.isFile() || pathBefore.isSymbolicLink() || Number(pathBefore.nlink) !== 1) {
    throw new LocalStateError('snapshot target must be a regular single-link file', code);
  }

  let handle;
  try {
    handle = await fsImpl.open(path, 'r');
    const handleBefore = await handle.stat();
    if (!sameStableFile(pathBefore, handleBefore)) {
      throw new LocalStateError('snapshot target changed before its read handle was secured', code);
    }
    const bytes = await handle.readFile();
    const handleAfter = await handle.stat();
    const pathAfter = await fsImpl.lstat(path);
    if (!sameStableFile(handleBefore, handleAfter)
      || !sameStableFile(handleAfter, pathAfter)
      || bytes.byteLength !== Number(handleAfter.size)) {
      throw new LocalStateError('snapshot target changed while it was read', code);
    }
    return { exists: true, bytes, stat: pathBefore };
  } catch (error) {
    if (error?.code === 'ENOENT' && missingAllowed) {
      throw new LocalStateError('snapshot target disappeared during inspection', code);
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

export async function inspectLeaseOwnerProcess({ pid, process_start: expectedStart } = {}, {
  runner = createProcessRunner(),
  platform = process.platform,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
} = {}) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  if (!Number.isFinite(expectedStart)) return 'unknown';
  if (pid === process.pid) {
    const observedStart = Math.round(Date.now() - process.uptime() * 1000);
    return Math.abs(observedStart - Number(expectedStart)) < 5_000 ? 'alive' : 'dead';
  }
  if (platform === 'win32') {
    if (!systemRoot || !runner?.run) return 'unknown';
    const powershell = resolve(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    let result;
    try {
      result = await runner.run(powershell, [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-ExecutionPolicy',
        'Bypass',
        '-Command',
        '-',
      ], {
        env: {
          SystemRoot: resolve(systemRoot),
          WINDIR: resolve(systemRoot),
          UEMCP_LEASE_PID: String(pid),
        },
        stdin: `${LEASE_PROCESS_SCRIPT}\n\n`,
        timeoutMs: 10_000,
        outputLimitBytes: 8 * 1024,
      });
    } catch {
      return 'unknown';
    }
    if (result.status !== 'exited' || result.exitCode !== 0 || result.stderr !== '') return 'unknown';
    try {
      const parsed = JSON.parse(result.stdout);
      const keys = Object.keys(parsed).sort().join(',');
      if (keys === 'state' && parsed.state === 'dead') return 'dead';
      if (keys === 'process_start,state'
        && parsed.state === 'alive'
        && Number.isSafeInteger(parsed.process_start)) {
        return Math.abs(parsed.process_start - Number(expectedStart)) < 5_000 ? 'alive' : 'dead';
      }
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }
  try {
    process.kill(pid, 0);
    return 'unknown';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'dead' : 'unknown';
  }
}

function parseWhoamiCsv(text) {
  const match = /^"(?:[^"]|"")*","(S-\d(?:-\d+)+)"\s*$/i.exec(text.trim());
  return match?.[1] ?? null;
}

async function defaultAclRestrictor(path) {
  if (process.platform !== 'win32') return;
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  if (!systemRoot) throw new LocalStateError('SystemRoot is required to restrict local state ACLs');
  const runner = createProcessRunner();
  const whoami = resolve(join(systemRoot, 'System32', 'whoami.exe'));
  const icacls = resolve(join(systemRoot, 'System32', 'icacls.exe'));
  const identity = await runner.run(whoami, ['/user', '/fo', 'csv', '/nh'], {
    env: { SystemRoot: resolve(systemRoot), WINDIR: resolve(systemRoot) },
    timeoutMs: 10_000,
    outputLimitBytes: 8 * 1024,
  });
  const sid = identity.status === 'exited' && identity.exitCode === 0 && identity.stderr === ''
    ? parseWhoamiCsv(identity.stdout)
    : null;
  if (!sid) throw new LocalStateError('could not resolve the current user SID');
  const restricted = await runner.run(icacls, [
    resolve(path),
    '/inheritance:r',
    '/grant:r',
    `*${sid}:(OI)(CI)F`,
    '*S-1-5-18:(OI)(CI)F',
  ], {
    env: { SystemRoot: resolve(systemRoot), WINDIR: resolve(systemRoot) },
    timeoutMs: 15_000,
    outputLimitBytes: 16 * 1024,
  });
  if (restricted.status !== 'exited' || restricted.exitCode !== 0) {
    throw new LocalStateError('could not restrict local state ACLs');
  }
}

export function createLocalState({
  root,
  fsImpl = defaultFs,
  aclRestrictor = defaultAclRestrictor,
  processInspector = inspectLeaseOwnerProcess,
  leaseCoordinator,
  treeRemover,
  clock = Date.now,
  sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)),
} = {}) {
  const selectedRoot = root ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'UEMCP') : null);
  if (!selectedRoot) throw new LocalStateError('LOCALAPPDATA is unavailable and no local-state root was injected');
  const absoluteRoot = resolve(selectedRoot);
  const coordinateLease = leaseCoordinator ?? createApplyLeaseCoordinator({ root: absoluteRoot });
  if (treeRemover !== undefined && typeof treeRemover !== 'function') {
    throw new LocalStateError('local-state tree remover is invalid');
  }
  const treeDeleteRunner = treeRemover === undefined ? createProcessRunner() : null;
  const removeTree = treeRemover ?? (options => deleteWindowsTreeNoFollow({
    ...options,
    runner: treeDeleteRunner,
    fsImpl,
  }));
  if (typeof coordinateLease !== 'function') {
    throw new LocalStateError('lease coordinator is invalid', 'LEASE_COORDINATOR_UNAVAILABLE');
  }
  const pathSet = Object.freeze({
    root: absoluteRoot,
    state: join(absoluteRoot, 'state'),
    plans: join(absoluteRoot, 'plans'),
    receipts: join(absoluteRoot, 'receipts'),
    snapshots: join(absoluteRoot, 'snapshots'),
    ownership: join(absoluteRoot, 'state', 'ownership-v1.json'),
    dependencyStamp: join(absoluteRoot, 'state', 'dependency-stamp-v1.json'),
    targets: join(absoluteRoot, 'state', '.uemcp-targets.json'),
    lock: join(absoluteRoot, 'state', 'deployment-apply-v1.lock'),
    replayLedger: join(absoluteRoot, 'plans', 'applied-v1.json'),
    applyJournals: join(absoluteRoot, 'plans', 'apply-journal-v1'),
  });
  const restrictedDirectories = new Set();
  const activeLeaseTokens = new Set();

  function assertLocalPath(path) {
    const absolute = resolve(path);
    if (!contained(absoluteRoot, absolute)) throw new LocalStateError('path escapes the local-state root', 'LOCAL_STATE_PATH_ESCAPE');
    return absolute;
  }

  async function assertNoLinkedLocalPath(path) {
    const absolute = assertLocalPath(path);
    const segments = relative(absoluteRoot, absolute).split(sep).filter(Boolean);
    let current = absoluteRoot;
    const pathSegments = [null, ...segments];
    for (const [index, segment] of pathSegments.entries()) {
      if (segment !== null) current = join(current, segment);
      try {
        const stat = await fsImpl.lstat(current);
        if (stat.isSymbolicLink()) throw new LocalStateError('local-state path contains a symbolic link or junction', 'LOCAL_STATE_PATH_ESCAPE');
        if (index === pathSegments.length - 1 && stat.isFile() && stat.nlink !== 1) {
          throw new LocalStateError('local-state file has multiple hard links', 'LOCAL_STATE_PATH_ESCAPE');
        }
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    return absolute;
  }

  async function ensureDirectory(path) {
    const absolute = await assertNoLinkedLocalPath(path);
    await fsImpl.mkdir(absolute, { recursive: true });
    await assertNoLinkedLocalPath(absolute);
    const key = process.platform === 'win32' ? absolute.toLowerCase() : absolute;
    if (!restrictedDirectories.has(key)) {
      await aclRestrictor(absolute);
      restrictedDirectories.add(key);
    }
    return absolute;
  }

  async function writeBytesAtomic(path, bytes) {
    const absolute = assertLocalPath(path);
    await ensureDirectory(dirname(absolute));
    await assertNoLinkedLocalPath(absolute);
    const scratch = scratchName(absolute);
    let handle;
    try {
      handle = await fsImpl.open(scratch, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.sync();
      await handle.close();
      handle = null;
      await fsImpl.rename(scratch, absolute);
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fsImpl.rm(scratch, { force: true }).catch(() => {});
    }
  }

  async function readJson(path) {
    const absolute = await assertNoLinkedLocalPath(path);
    try {
      return JSON.parse(await fsImpl.readFile(absolute, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      if (error instanceof SyntaxError) throw new LocalStateError('local-state JSON is malformed', 'MALFORMED_LOCAL_STATE');
      throw error;
    }
  }

  async function writeJsonAtomic(path, value) {
    await writeBytesAtomic(path, Buffer.from(`${canonicalJson(value)}\n`, 'utf8'));
  }

  async function createSnapshot(targetPath, { transactionId = randomBytes(12).toString('hex'), retainOnConflict = false } = {}) {
    const id = safeSegment(transactionId, 'transactionId');
    const directory = join(pathSet.snapshots, id, randomBytes(8).toString('hex'));
    if (!contained(pathSet.snapshots, directory)) throw new LocalStateError('snapshot transaction escapes the snapshot root');
    await ensureDirectory(directory);
    const absoluteTarget = await assertNoLinkedTargetPath(targetPath, { fsImpl, code: 'UNSAFE_SNAPSHOT_TARGET' });
    const captured = await readStableSingleLinkFile(absoluteTarget, {
      fsImpl,
      code: 'UNSAFE_SNAPSHOT_TARGET',
    });
    const { bytes, stat } = captured;
    if (captured.exists) {
      await writeBytesAtomic(join(directory, 'payload.bin'), bytes);
    }
    const metadata = {
      schema_version: '1.0',
      snapshot_id: `${id}/${directory.split(/[\\/]/).at(-1)}`,
      target_path: absoluteTarget,
      exists: captured.exists,
      size: stat === null ? null : Number(stat.size),
      identity: stat === null ? null : stableFileIdentity(stat),
      mode: stat === null ? null : stat.mode,
      atime_ms: stat === null ? null : stat.atimeMs,
      mtime_ms: stat === null ? null : stat.mtimeMs,
      original_sha256: bytes === null ? null : sha256Bytes(bytes),
      retained_until: retainOnConflict ? new Date(Number(clock()) + SNAPSHOT_RETENTION_MS).toISOString() : null,
    };
    await writeJsonAtomic(join(directory, 'metadata.json'), metadata);
    return Object.freeze({
      id: metadata.snapshot_id,
      path_label: `snapshots/${metadata.snapshot_id}`,
      directory,
      metadata,
    });
  }

  async function restoreSnapshot(snapshot, { expectedCurrentHash } = {}) {
    if (!snapshot?.directory || !contained(pathSet.snapshots, snapshot.directory)) {
      throw new LocalStateError('snapshot is outside the local-state root', 'INVALID_SNAPSHOT');
    }
    const metadata = await readJson(join(snapshot.directory, 'metadata.json'));
    if (!metadata) throw new LocalStateError('snapshot metadata is missing', 'INVALID_SNAPSHOT');
    await assertNoLinkedTargetPath(metadata.target_path, { fsImpl, code: 'ROLLBACK_CONFLICT' });
    if (expectedCurrentHash !== null && !/^[0-9a-f]{64}$/.test(expectedCurrentHash ?? '')) {
      throw new LocalStateError('rollback requires an exact expected current hash or null', 'INVALID_ROLLBACK_PRECONDITION');
    }
    let currentHash = null;
    try {
      const current = await readStableSingleLinkFile(metadata.target_path, {
        fsImpl,
        code: 'ROLLBACK_CONFLICT',
      });
      currentHash = current.exists ? sha256Bytes(current.bytes) : null;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (currentHash !== expectedCurrentHash) {
      throw new LocalStateError('rollback target no longer matches applied bytes', 'ROLLBACK_CONFLICT');
    }
    if (!metadata.exists) {
      await fsImpl.rm(metadata.target_path, { force: true });
      return { status: 'restored_absent' };
    }
    const payloadResult = await readStableSingleLinkFile(join(snapshot.directory, 'payload.bin'), {
      fsImpl,
      code: 'INVALID_SNAPSHOT',
      missingAllowed: false,
    });
    const payload = payloadResult.bytes;
    if (sha256Bytes(payload) !== metadata.original_sha256) {
      throw new LocalStateError('snapshot payload hash is invalid', 'INVALID_SNAPSHOT');
    }
    const targetScratch = scratchName(metadata.target_path);
    let handle;
    try {
      handle = await fsImpl.open(targetScratch, 'wx', metadata.mode ?? 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = null;
      await fsImpl.rename(targetScratch, metadata.target_path);
      if (metadata.mode !== null) await fsImpl.chmod(metadata.target_path, metadata.mode);
      if (metadata.atime_ms !== null && metadata.mtime_ms !== null) {
        await fsImpl.utimes(metadata.target_path, metadata.atime_ms / 1000, metadata.mtime_ms / 1000);
      }
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fsImpl.rm(targetScratch, { force: true }).catch(() => {});
    }
    return { status: 'restored' };
  }

  async function deleteSnapshot(snapshot) {
    if (!snapshot?.directory || !contained(pathSet.snapshots, snapshot.directory)) {
      throw new LocalStateError('snapshot is outside the local-state root', 'INVALID_SNAPSHOT');
    }
    await assertNoLinkedLocalPath(snapshot.directory);
    await removeTree({ targetPath: snapshot.directory, allowedRoot: pathSet.snapshots });
    if (await exists(fsImpl, snapshot.directory)) {
      throw new LocalStateError('snapshot cleanup could not be verified', 'SNAPSHOT_DELETE_FAILED');
    }
  }

  async function cleanupExpired() {
    await assertNoLinkedLocalPath(pathSet.snapshots);
    if (!(await exists(fsImpl, pathSet.snapshots))) return { deleted: 0 };
    let deleted = 0;
    const transactions = await fsImpl.readdir(pathSet.snapshots, { withFileTypes: true });
    for (const transaction of transactions) {
      if (!transaction.isDirectory()) continue;
      const transactionPath = join(pathSet.snapshots, transaction.name);
      for (const entry of await fsImpl.readdir(transactionPath, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const directory = join(transactionPath, entry.name);
        const metadata = await readJson(join(directory, 'metadata.json')).catch(() => null);
        if (metadata?.retained_until && Date.parse(metadata.retained_until) <= Number(clock())) {
          await removeTree({ targetPath: directory, allowedRoot: pathSet.snapshots });
          if (await exists(fsImpl, directory)) {
            throw new LocalStateError('expired snapshot cleanup could not be verified', 'SNAPSHOT_DELETE_FAILED');
          }
          deleted += 1;
        }
      }
    }
    return { deleted };
  }

  async function readReplayLedger() {
    const ledger = await readJson(pathSet.replayLedger);
    if (ledger === null) return { schema_version: '1.0', applied: {} };
    if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)
      || Object.keys(ledger).sort().join(',') !== 'applied,schema_version'
      || ledger.schema_version !== '1.0'
      || !ledger.applied || typeof ledger.applied !== 'object' || Array.isArray(ledger.applied)) {
      throw new LocalStateError('replay ledger is malformed', 'MALFORMED_LOCAL_STATE');
    }
    for (const [digest, record] of Object.entries(ledger.applied)) {
      const keys = record && typeof record === 'object' && !Array.isArray(record)
        ? Object.keys(record).sort().join(',')
        : '';
      if (!SHA256.test(digest)
        || (keys !== 'applied_at' && keys !== 'applied_at,receipt_sha256')
        || typeof record.applied_at !== 'string'
        || !Number.isFinite(Date.parse(record.applied_at))
        || (record.receipt_sha256 !== undefined && !SHA256.test(record.receipt_sha256))) {
        throw new LocalStateError('replay ledger applied record is malformed', 'MALFORMED_LOCAL_STATE');
      }
    }
    return ledger;
  }

  function validateDigest(digest) {
    if (!SHA256.test(digest ?? '')) throw new LocalStateError('digest must be lowercase SHA-256', 'INVALID_DIGEST');
    return digest;
  }

  function applyJournalPath(digest) {
    return join(pathSet.applyJournals, `${validateDigest(digest)}.json`);
  }

  function validateJournalReceipt(receipt) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || receipt.kind !== 'deployment'
      || typeof receipt.path_label !== 'string'
      || !/^receipts\/[A-Za-z0-9._-]+\.json$/.test(receipt.path_label)
      || !SHA256.test(receipt.sha256 ?? '')
      || !receipt.document
      || typeof receipt.document !== 'object'
      || Array.isArray(receipt.document)
      || receipt.document.path_label !== receipt.path_label
      || receipt.document.receipt_sha256 !== receipt.sha256) {
      throw new LocalStateError('apply journal receipt is invalid', 'MALFORMED_LOCAL_STATE');
    }
    const body = { ...receipt.document };
    delete body.receipt_sha256;
    if (sha256Canonical(body) !== receipt.sha256) {
      throw new LocalStateError('apply journal receipt hash is invalid', 'MALFORMED_LOCAL_STATE');
    }
    return receipt;
  }

  function journalReceiptFromPrepared(preparedReceipt) {
    const reference = preparedReceipt?.reference;
    if (!reference || !preparedReceipt?.document) {
      throw new LocalStateError('prepared recovery receipt is required', 'MALFORMED_LOCAL_STATE');
    }
    if (reference.path !== join(pathSet.receipts, basename(reference.path_label ?? ''))) {
      throw new LocalStateError('prepared receipt path is outside the receipt root', 'LOCAL_STATE_PATH_ESCAPE');
    }
    return validateJournalReceipt({
      kind: reference.kind,
      path_label: reference.path_label,
      sha256: reference.sha256,
      document: preparedReceipt.document,
    });
  }

  function validateApplyJournal(record, digest) {
    if (!record || typeof record !== 'object' || Array.isArray(record)
      || record.schema_version !== '1.0'
      || record.kind !== 'uemcp.deployment.apply-journal'
      || record.plan_digest !== digest
      || !['applying', 'receipt_pending', 'committed'].includes(record.state)
      || typeof record.started_at !== 'string'
      || !Number.isFinite(Date.parse(record.started_at))) {
      throw new LocalStateError('apply journal is malformed', 'MALFORMED_LOCAL_STATE');
    }
    const expectedKeys = ['schema_version', 'kind', 'plan_digest', 'state', 'started_at', 'receipt'];
    if (Object.keys(record).sort().join(',') !== expectedKeys.sort().join(',')) {
      throw new LocalStateError('apply journal has unknown fields', 'MALFORMED_LOCAL_STATE');
    }
    if (record.state === 'applying') {
      if (record.receipt !== null) validateJournalReceipt(record.receipt);
    } else {
      validateJournalReceipt(record.receipt);
    }
    return record;
  }

  async function readApplyJournal(digest) {
    const normalized = validateDigest(digest);
    const record = await readJson(applyJournalPath(normalized));
    return record === null ? null : validateApplyJournal(record, normalized);
  }

  async function beginApplyJournal(digest, preparedReceipt) {
    const normalized = validateDigest(digest);
    if (await readApplyJournal(normalized)) throw new LocalStateError('plan digest already has an apply journal', 'PLAN_REPLAYED');
    const ledger = await readReplayLedger();
    if (Object.hasOwn(ledger.applied ?? {}, normalized)) throw new LocalStateError('plan digest was already applied', 'PLAN_REPLAYED');
    const receipt = journalReceiptFromPrepared(preparedReceipt);
    await writeJsonAtomic(applyJournalPath(normalized), {
      schema_version: '1.0',
      kind: 'uemcp.deployment.apply-journal',
      plan_digest: normalized,
      state: 'applying',
      started_at: new Date(Number(clock())).toISOString(),
      receipt,
    });
  }

  async function stageApplyJournal(digest, preparedReceipt) {
    const normalized = validateDigest(digest);
    const current = await readApplyJournal(normalized);
    if (current?.state !== 'applying') throw new LocalStateError('apply journal is not ready for terminal receipt staging', 'MALFORMED_LOCAL_STATE');
    const receipt = journalReceiptFromPrepared(preparedReceipt);
    await writeJsonAtomic(applyJournalPath(normalized), { ...current, state: 'receipt_pending', receipt });
  }

  async function ensureJournalReceipt(record) {
    const receipt = validateJournalReceipt(record.receipt);
    const fileName = basename(receipt.path_label);
    const path = join(pathSet.receipts, fileName);
    if (receipt.path_label !== `receipts/${fileName}`) {
      throw new LocalStateError('apply journal receipt path is unsafe', 'LOCAL_STATE_PATH_ESCAPE');
    }
    const existing = await readJson(path);
    if (existing === null) {
      await writeJsonAtomic(path, receipt.document);
    } else if (canonicalJson(existing) !== canonicalJson(receipt.document)) {
      throw new LocalStateError('existing receipt differs from the apply journal', 'RECEIPT_INTEGRITY_FAILED');
    }
    return { kind: receipt.kind, path_label: receipt.path_label, path, sha256: receipt.sha256 };
  }

  async function completeApplyJournal(digest, reference = null) {
    const normalized = validateDigest(digest);
    const current = await readApplyJournal(normalized);
    if (!current || !['applying', 'receipt_pending', 'committed'].includes(current.state)
      || (current.state === 'applying' && current.receipt === null)) {
      throw new LocalStateError('apply journal has no terminal receipt', 'MALFORMED_LOCAL_STATE');
    }
    const expected = current.receipt;
    if (reference && (reference.kind !== expected.kind
      || reference.path_label !== expected.path_label
      || reference.sha256 !== expected.sha256)) {
      throw new LocalStateError('written receipt does not match the apply journal', 'RECEIPT_INTEGRITY_FAILED');
    }
    const resolvedReference = await ensureJournalReceipt(current);
    if (current.state !== 'committed') {
      await writeJsonAtomic(applyJournalPath(normalized), { ...current, state: 'committed' });
    }
    return resolvedReference;
  }

  async function clearApplyJournal(digest) {
    const normalized = validateDigest(digest);
    const current = await readApplyJournal(normalized);
    if (current === null) return;
    if (current.state !== 'applying') throw new LocalStateError('terminal apply journal cannot be cleared', 'PLAN_REPLAYED');
    const path = applyJournalPath(normalized);
    await assertNoLinkedLocalPath(path);
    await fsImpl.rm(path, { force: true });
  }

  async function wasDigestApplied(digest) {
    validateDigest(digest);
    const journal = await readApplyJournal(digest);
    if (journal) {
      if (journal.state === 'applying' && journal.receipt === null) {
        throw new LocalStateError('interrupted apply journal lacks recovery evidence', 'MALFORMED_LOCAL_STATE');
      }
      if (journal.state !== 'committed') await completeApplyJournal(digest);
      return true;
    }
    const ledger = await readReplayLedger();
    return Object.hasOwn(ledger.applied ?? {}, digest);
  }

  async function markDigestApplied(digest, evidence = {}) {
    validateDigest(digest);
    if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || Object.keys(evidence).some(key => key !== 'receipt_sha256')
      || (evidence.receipt_sha256 !== undefined && !SHA256.test(evidence.receipt_sha256))) {
      throw new LocalStateError('replay evidence is invalid', 'INVALID_REPLAY_EVIDENCE');
    }
    const ledger = await readReplayLedger();
    ledger.schema_version = '1.0';
    ledger.applied ??= {};
    ledger.applied[digest] = { applied_at: new Date(Number(clock())).toISOString(), ...evidence };
    await writeJsonAtomic(pathSet.replayLedger, ledger);
  }

  function validLeaseRecord(record) {
    return record !== null
      && typeof record === 'object'
      && !Array.isArray(record)
      && Object.keys(record).sort().join(',') === 'acquired_at,owner_token,pid,process_start'
      && LEASE_OWNER_TOKEN.test(record.owner_token ?? '')
      && Number.isSafeInteger(record.pid)
      && record.pid > 0
      && Number.isSafeInteger(record.process_start)
      && Number.isFinite(Date.parse(record.acquired_at));
  }

  function leasePublishPath(ownerToken) {
    return `${pathSet.lock}.${ownerToken}.publishing`;
  }

  function sameFileIdentity(left, right) {
    return left.dev === right.dev && left.ino === right.ino;
  }

  async function inspectLease() {
    try {
      await assertNoLinkedLocalPath(pathSet.state);
      const stat = await fsImpl.lstat(pathSet.lock);
      if (!stat.isFile() || stat.isSymbolicLink() || !Number.isSafeInteger(stat.nlink) || stat.nlink < 1) return { state: 'unsafe' };
      const record = JSON.parse(await fsImpl.readFile(pathSet.lock, 'utf8'));
      if (!validLeaseRecord(record)) return { state: 'malformed' };
      if (stat.nlink === 2) {
        const publishPath = leasePublishPath(record.owner_token);
        let publishStat;
        try {
          publishStat = await fsImpl.lstat(publishPath);
        } catch (error) {
          if (error?.code === 'ENOENT') return { state: 'unsafe' };
          throw error;
        }
        if (!publishStat.isFile()
          || publishStat.isSymbolicLink()
          || publishStat.nlink !== 2
          || !sameFileIdentity(stat, publishStat)) return { state: 'unsafe' };
        await fsImpl.unlink(publishPath);
        const healed = await fsImpl.lstat(pathSet.lock);
        if (!healed.isFile() || healed.isSymbolicLink() || healed.nlink !== 1 || !sameFileIdentity(stat, healed)) {
          return { state: 'unsafe' };
        }
      } else if (stat.nlink !== 1) {
        return { state: 'unsafe' };
      }
      return { state: 'valid', record };
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'absent' };
      if (error instanceof SyntaxError) return { state: 'malformed' };
      throw error;
    }
  }

  async function publishLease(record) {
    const scratch = leasePublishPath(record.owner_token);
    let handle;
    let published = false;
    try {
      handle = await fsImpl.open(scratch, 'wx', 0o600);
      await handle.writeFile(`${canonicalJson(record)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      try {
        await fsImpl.link(scratch, pathSet.lock);
        published = true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
      return published;
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fsImpl.rm(scratch, { force: true }).catch(() => {});
    }
  }

  function createLeaseCapability(ownerToken) {
    let released = false;
    let releasePromise = null;
    activeLeaseTokens.add(ownerToken);
    return Object.freeze({
      ownerToken,
      async release(providedToken = ownerToken) {
        if (released) return;
        if (providedToken !== ownerToken) throw new LocalStateError('apply lease owner token does not match', 'LEASE_OWNER_MISMATCH');
        releasePromise ??= coordinateLease(async () => {
          const current = await inspectLease();
          if (current.state !== 'valid' || current.record.owner_token !== ownerToken) {
            activeLeaseTokens.delete(ownerToken);
            throw new LocalStateError('apply lease ownership changed', 'LEASE_OWNER_MISMATCH');
          }
          await fsImpl.unlink(pathSet.lock);
          activeLeaseTokens.delete(ownerToken);
          released = true;
        });
        return releasePromise;
      },
    });
  }

  async function acquireApplyLease({
    pid = process.pid,
    processStart = Math.round(Date.now() - process.uptime() * 1000),
    waitMs = 0,
    pollMs = 50,
    staleGraceMs = 5_000,
    expiresAt = null,
  } = {}) {
    await ensureDirectory(pathSet.state);
    const startedWaiting = Number(clock());
    while (true) {
      if (expiresAt !== null && Number(clock()) >= Date.parse(expiresAt)) {
        throw new LocalStateError('plan expired while waiting for the apply lease', 'PLAN_EXPIRED');
      }
      const ownerToken = randomBytes(24).toString('hex');
      const record = {
        owner_token: ownerToken,
        pid,
        process_start: processStart,
        acquired_at: new Date(Number(clock())).toISOString(),
      };
      const attempted = await coordinateLease(async () => {
        if (expiresAt !== null && Number(clock()) >= Date.parse(expiresAt)) {
          throw new LocalStateError('plan expired while waiting for the apply lease', 'PLAN_EXPIRED');
        }
        let observed = await inspectLease();
        if (observed.state !== 'absent') return { acquired: false, observed };
        if (await publishLease(record)) return { acquired: true, observed: null };
        observed = await inspectLease();
        return { acquired: false, observed };
      });
      if (attempted.acquired) return createLeaseCapability(ownerToken);

      const observed = attempted.observed;
      if (observed.state === 'valid') {
        const ownerState = await processInspector(observed.record);
        const age = Number(clock()) - Date.parse(observed.record.acquired_at);
        if (ownerState === 'dead' && age >= staleGraceMs) {
          const observedBytes = canonicalJson(observed.record);
          const reclaimed = await coordinateLease(async () => {
            const current = await inspectLease();
            if (current.state !== 'valid' || canonicalJson(current.record) !== observedBytes) return false;
            await fsImpl.unlink(pathSet.lock);
            return true;
          });
          if (reclaimed) continue;
        }
      }

      if (Number(clock()) - startedWaiting >= waitMs) {
        throw new LocalStateError('another deployment apply owns the local lease', 'APPLY_IN_PROGRESS');
      }
      await sleep(Math.min(pollMs, Math.max(1, waitMs - (Number(clock()) - startedWaiting))));
    }
  }

  async function validateApplyLease(lease) {
    const ownerToken = lease?.ownerToken;
    if (!LEASE_OWNER_TOKEN.test(ownerToken ?? '') || !activeLeaseTokens.has(ownerToken)) {
      throw new LocalStateError('apply lease capability is not active', 'LEASE_OWNER_MISMATCH');
    }
    return coordinateLease(async () => {
      const current = await inspectLease();
      if (current.state !== 'valid' || current.record.owner_token !== ownerToken) {
        activeLeaseTokens.delete(ownerToken);
        throw new LocalStateError('apply lease ownership changed', 'LEASE_OWNER_MISMATCH');
      }
      return true;
    });
  }

  return Object.freeze({
    paths: () => pathSet,
    readJson,
    writeJsonAtomic,
    acquireApplyLease,
    validateApplyLease,
    createSnapshot,
    restoreSnapshot,
    deleteSnapshot,
    cleanupExpired,
    beginApplyJournal,
    stageApplyJournal,
    completeApplyJournal,
    clearApplyJournal,
    readApplyJournal,
    markDigestApplied,
    wasDigestApplied,
  });
}
