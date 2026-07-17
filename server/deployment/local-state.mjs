import { randomBytes } from 'node:crypto';
import * as defaultFs from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { canonicalJson, sha256Bytes } from './canonical-json.mjs';
import { createProcessRunner } from './process-runner.mjs';

const SNAPSHOT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
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
  clock = Date.now,
  sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)),
} = {}) {
  const selectedRoot = root ?? (process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'UEMCP') : null);
  if (!selectedRoot) throw new LocalStateError('LOCALAPPDATA is unavailable and no local-state root was injected');
  const absoluteRoot = resolve(selectedRoot);
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
    let stat = null;
    let bytes = null;
    try {
      stat = await fsImpl.lstat(absoluteTarget);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new LocalStateError('snapshot target must be a regular single-link file', 'UNSAFE_SNAPSHOT_TARGET');
      bytes = await fsImpl.readFile(absoluteTarget);
      await writeBytesAtomic(join(directory, 'payload.bin'), bytes);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const metadata = {
      schema_version: '1.0',
      snapshot_id: `${id}/${directory.split(/[\\/]/).at(-1)}`,
      target_path: absoluteTarget,
      exists: stat !== null,
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
      const currentStat = await fsImpl.lstat(metadata.target_path);
      if (!currentStat.isFile() || currentStat.isSymbolicLink() || currentStat.nlink !== 1) throw new LocalStateError('rollback target changed identity', 'ROLLBACK_CONFLICT');
      currentHash = sha256Bytes(await fsImpl.readFile(metadata.target_path));
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
    const payload = await fsImpl.readFile(join(snapshot.directory, 'payload.bin'));
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
    await fsImpl.rm(snapshot.directory, { recursive: true, force: true });
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
          await fsImpl.rm(directory, { recursive: true, force: true });
          deleted += 1;
        }
      }
    }
    return { deleted };
  }

  async function readReplayLedger() {
    return await readJson(pathSet.replayLedger) ?? { schema_version: '1.0', applied: {} };
  }

  async function wasDigestApplied(digest) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new LocalStateError('digest must be lowercase SHA-256', 'INVALID_DIGEST');
    const ledger = await readReplayLedger();
    return Object.hasOwn(ledger.applied ?? {}, digest);
  }

  async function markDigestApplied(digest, evidence = {}) {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new LocalStateError('digest must be lowercase SHA-256', 'INVALID_DIGEST');
    const ledger = await readReplayLedger();
    ledger.schema_version = '1.0';
    ledger.applied ??= {};
    ledger.applied[digest] = { applied_at: new Date(Number(clock())).toISOString(), ...evidence };
    await writeJsonAtomic(pathSet.replayLedger, ledger);
  }

  async function inspectLease() {
    try {
      await assertNoLinkedLocalPath(pathSet.lock);
      const stat = await fsImpl.lstat(pathSet.lock);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return { state: 'unsafe' };
      const record = JSON.parse(await fsImpl.readFile(pathSet.lock, 'utf8'));
      if (typeof record.owner_token !== 'string'
        || !Number.isSafeInteger(record.pid)
        || !Number.isFinite(record.process_start)
        || typeof record.acquired_at !== 'string') return { state: 'malformed' };
      return { state: 'valid', record };
    } catch (error) {
      if (error?.code === 'ENOENT') return { state: 'absent' };
      if (error instanceof SyntaxError) return { state: 'malformed' };
      throw error;
    }
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
      await assertNoLinkedLocalPath(pathSet.lock);
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
      let handle;
      try {
        handle = await fsImpl.open(pathSet.lock, 'wx', 0o600);
        await handle.writeFile(`${canonicalJson(record)}\n`, 'utf8');
        await handle.sync();
        await handle.close();
        handle = null;
        let released = false;
        activeLeaseTokens.add(ownerToken);
        return Object.freeze({
          ownerToken,
          async release(providedToken = ownerToken) {
            if (released) return;
            if (providedToken !== ownerToken) throw new LocalStateError('apply lease owner token does not match', 'LEASE_OWNER_MISMATCH');
            const current = await inspectLease();
            if (current.state !== 'valid' || current.record.owner_token !== ownerToken) {
              activeLeaseTokens.delete(ownerToken);
              throw new LocalStateError('apply lease ownership changed', 'LEASE_OWNER_MISMATCH');
            }
            await assertNoLinkedLocalPath(pathSet.lock);
            await fsImpl.unlink(pathSet.lock);
            activeLeaseTokens.delete(ownerToken);
            released = true;
          },
        });
      } catch (error) {
        if (handle) await handle.close().catch(() => {});
        if (error?.code !== 'EEXIST') throw error;
      }

      const observed = await inspectLease();
      if (observed.state === 'valid') {
        const ownerState = await processInspector(observed.record);
        const age = Number(clock()) - Date.parse(observed.record.acquired_at);
        if (ownerState === 'dead' && age >= staleGraceMs) {
          const quarantine = `${pathSet.lock}.${randomBytes(12).toString('hex')}.stale`;
          try {
            await assertNoLinkedLocalPath(pathSet.lock);
            await fsImpl.rename(pathSet.lock, quarantine);
            await fsImpl.rm(quarantine, { force: true });
            continue;
          } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'EEXIST') continue;
            throw error;
          }
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
    if (!/^[0-9a-f]{48}$/.test(ownerToken ?? '') || !activeLeaseTokens.has(ownerToken)) {
      throw new LocalStateError('apply lease capability is not active', 'LEASE_OWNER_MISMATCH');
    }
    const current = await inspectLease();
    if (current.state !== 'valid' || current.record.owner_token !== ownerToken) {
      activeLeaseTokens.delete(ownerToken);
      throw new LocalStateError('apply lease ownership changed', 'LEASE_OWNER_MISMATCH');
    }
    return true;
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
    markDigestApplied,
    wasDigestApplied,
  });
}
