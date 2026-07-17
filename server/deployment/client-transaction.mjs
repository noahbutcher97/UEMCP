import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import * as defaultFs from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from 'node:path';

import { canonicalJson, sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { CLIENT_IDS } from './client-contract.mjs';
import { fingerprintPath } from './fingerprints.mjs';
import { createProcessRunner } from './process-runner.mjs';
import {
  fingerprintWindowsFileMetadata,
  replaceFilePreservingMetadata,
} from './windows-native.mjs';

const MAX_CONFIG_BYTES = 8 * 1024 * 1024;
const MAX_STAGE_ENTRIES = 16;
const STAGE_QUARANTINE_PATTERN = /^\.native-staging-[0-9a-f]{24}\.stale$/;
const STAGED_WRITE_TOKEN = Symbol('staged-write');
const WRITABLE_SCOPES = new Set(['user', 'project', 'profile', 'local_state']);
const ACTION_STATUSES = new Set([
  'ACTION_REQUIRED',
  'CLIENT_ENABLEMENT_REQUIRED',
  'DISABLED',
  'PENDING_APPROVAL',
  'PENDING_RESTART',
  'PENDING_TRUST',
  'POLICY_UNKNOWN',
  'RESTART_REQUIRED',
]);
const READY_STATUSES = new Set(['APPLIED', 'MATCHING', 'NO_OP', 'READY']);

const DEFAULT_WINDOWS_NATIVE = Object.freeze({
  fingerprintWindowsFileMetadata,
  replaceFilePreservingMetadata,
});

export class ClientTransactionError extends Error {
  constructor(message, code = 'CLIENT_TRANSACTION_FAILED', details = {}) {
    super(message);
    this.name = 'ClientTransactionError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code = 'CLIENT_TRANSACTION_FAILED', details = {}) {
  throw new ClientTransactionError(message, code, details);
}

function pathKey(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function contained(root, candidate) {
  const rel = relative(pathKey(root), pathKey(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function safeAbsolutePath(path) {
  return typeof path === 'string'
    && isAbsolute(path)
    && !/^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(path);
}

function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

async function assertWritableAncestry(path, allowedRoot, fsImpl) {
  if (!safeAbsolutePath(path)) fail('transaction path must be an absolute non-device path', 'UNSAFE_TRANSACTION_PATH');
  if (!safeAbsolutePath(allowedRoot)) fail('writable root must be an absolute non-device path', 'UNSAFE_TRANSACTION_PATH');
  const absolutePath = resolve(path);
  const absoluteRoot = resolve(allowedRoot);
  if (!contained(absoluteRoot, absolutePath)) fail('transaction path is outside its writable root', 'PATH_OUTSIDE_WRITABLE_ROOT');

  const volumeRoot = parse(absolutePath).root;
  const segments = relative(volumeRoot, absolutePath).split(sep).filter(Boolean);
  let current = volumeRoot;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = await fsImpl.lstat(current);
      if (stat.isSymbolicLink()) fail('writable path contains a symbolic link or junction', 'UNSAFE_WRITABLE_PATH');
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return { absolutePath, absoluteRoot };
}

function statIdentity(stat) {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    birthtime_ms: Number(stat.birthtimeMs),
  };
}

async function metadataFingerprint(path, {
  allowedRoots,
  fsImpl,
  windowsNative,
  processRunner,
  systemRoot,
}) {
  try {
    return await windowsNative.fingerprintWindowsFileMetadata(path, {
      runner: processRunner,
      systemRoot,
      allowedRoots,
      fsImpl,
    });
  } catch (error) {
    fail('Windows metadata inspection failed', 'METADATA_INSPECTION_FAILED', { cause_code: error?.code ?? 'UNKNOWN' });
  }
}

export async function captureClientPathFingerprint(path, {
  allowedRoots,
  fsImpl = defaultFs,
  maxBytes = null,
  windowsNative = DEFAULT_WINDOWS_NATIVE,
  processRunner = createProcessRunner(),
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  writable = true,
} = {}) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) fail('path fingerprint requires an allowed root', 'INVALID_TRANSACTION_ROOT');
  if (writable) await assertWritableAncestry(path, allowedRoots[0], fsImpl);
  else if (!safeAbsolutePath(path)) fail('transaction evidence path is unsafe', 'UNSAFE_TRANSACTION_PATH');

  let core;
  try {
    core = await fingerprintPath(path, { allowedRoots, fsImpl, maxBytes });
  } catch (error) {
    if (error?.code === 'PATH_OUTSIDE_ALLOWED_ROOT') fail('transaction path is outside its writable root', 'PATH_OUTSIDE_WRITABLE_ROOT');
    if (error?.code === 'FINGERPRINT_BYTE_LIMIT') fail('transaction evidence exceeds its byte limit', 'INSPECTION_LIMIT_EXCEEDED', error.details);
    throw error;
  }
  if (core.exists && core.kind !== 'file') fail('transaction path must be a regular file or absent', writable ? 'UNSAFE_WRITABLE_PATH' : 'UNSAFE_EVIDENCE_PATH');
  if (writable && core.exists && (core.link_kind !== 'none' || core.link_count !== 1)) {
    fail('writable path must be a regular single-link file', 'UNSAFE_WRITABLE_PATH');
  }

  let stat = null;
  let metadata = null;
  if (core.exists) {
    stat = await fsImpl.lstat(core.canonical_path);
    if (writable) {
      if ((stat.mode & 0o222) === 0) fail('writable path is read-only', 'READ_ONLY_TARGET');
      try {
        await fsImpl.access(core.canonical_path, constants.W_OK);
      } catch {
        fail('writable path is not writable', 'READ_ONLY_TARGET');
      }
    }
    metadata = await metadataFingerprint(core.canonical_path, {
      allowedRoots,
      fsImpl,
      windowsNative,
      processRunner,
      systemRoot,
    });
  }

  return {
    canonical_path: resolve(core.canonical_path),
    real_path: resolve(core.real_path),
    exists: core.exists,
    kind: core.kind,
    link_kind: core.link_kind,
    link_count: core.link_count,
    size: core.size,
    content_sha256: core.sha256,
    metadata_sha256: metadata?.metadata_sha256 ?? null,
    stream_count: metadata?.stream_count ?? 0,
    stream_bytes: metadata?.stream_bytes ?? 0,
    mode: stat === null ? null : Number(stat.mode),
    atime_ms: stat === null ? null : Number(stat.atimeMs),
    mtime_ms: stat === null ? null : Number(stat.mtimeMs),
    identity: stat === null ? null : statIdentity(stat),
  };
}

function comparableFingerprint(fingerprint, { includeIdentity = true, includeMutable = true } = {}) {
  const result = {
    canonical_path: pathKey(fingerprint.canonical_path),
    real_path: pathKey(fingerprint.real_path),
    exists: fingerprint.exists,
    kind: fingerprint.kind,
    link_kind: fingerprint.link_kind,
    link_count: fingerprint.link_count,
    size: fingerprint.size,
    content_sha256: fingerprint.content_sha256,
    metadata_sha256: fingerprint.metadata_sha256,
    stream_count: fingerprint.stream_count,
    stream_bytes: fingerprint.stream_bytes,
  };
  if (includeMutable) {
    result.mode = fingerprint.mode;
    result.mtime_ms = fingerprint.mtime_ms;
  }
  if (includeIdentity) result.identity = fingerprint.identity;
  return result;
}

function fingerprintsEqual(left, right, options) {
  return sha256Canonical(comparableFingerprint(left, options)) === sha256Canonical(comparableFingerprint(right, options));
}

function validatePlanDigest(planDigest) {
  if (!/^[0-9a-f]{64}$/.test(planDigest ?? '')) fail('transaction plan digest is invalid', 'INVALID_PLAN_DIGEST');
}

function adapterMap(adapters) {
  if (!Array.isArray(adapters)) fail('transaction adapters must be an array', 'INVALID_ADAPTER_SET');
  const map = new Map();
  for (const adapter of adapters) {
    if (!adapter || !CLIENT_IDS.includes(adapter.id) || map.has(adapter.id)
      || typeof adapter.snapshot !== 'function'
      || typeof adapter.apply !== 'function'
      || typeof adapter.verify !== 'function') {
      fail('transaction adapter contract is invalid', 'INVALID_ADAPTER_SET');
    }
    map.set(adapter.id, adapter);
  }
  return map;
}

function validateOperations(operations, adapters) {
  if (!Array.isArray(operations)) fail('transaction operations must be an array', 'INVALID_OPERATION_SET');
  const ids = new Set();
  for (const operation of operations) {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)
      || typeof operation.operation_id !== 'string' || operation.operation_id.trim() === ''
      || ids.has(operation.operation_id)
      || !adapters.has(operation.client_id)) {
      fail('transaction operation is invalid', 'INVALID_OPERATION_SET');
    }
    ids.add(operation.operation_id);
    if (operation.selected !== true) fail('unselected client cannot write config', 'UNAPPROVED_CLIENT_WRITE');
    if (operation.write_supported !== true) fail('unsupported client version cannot write config', 'UNSUPPORTED_CLIENT_WRITE');
    if (!WRITABLE_SCOPES.has(operation.scope_kind)) fail('managed, system, and host-state scopes are read-only', 'READ_ONLY_SCOPE');
    if (!safeAbsolutePath(operation.path)) fail('transaction path is unsafe', 'UNSAFE_TRANSACTION_PATH');
    if (!safeAbsolutePath(operation.allowed_root)) fail('transaction writable root is unsafe', 'UNSAFE_TRANSACTION_PATH');
    if (!contained(operation.allowed_root, operation.path)) fail('transaction path is outside its writable root', 'PATH_OUTSIDE_WRITABLE_ROOT');
    if (!operation.fingerprint || typeof operation.fingerprint !== 'object') fail('transaction operation lacks a path precondition', 'INVALID_OPERATION_SET');
    if (operation.ledger_only !== undefined && typeof operation.ledger_only !== 'boolean') {
      fail('ledger-only approval must be boolean', 'INVALID_OPERATION_SET');
    }
    if (operation.external_write !== undefined && typeof operation.external_write !== 'boolean') {
      fail('external-write approval must be boolean', 'INVALID_OPERATION_SET');
    }
    if (operation.external_write === true && (operation.ledger_only === true || operation.delete_after_verify === true)) {
      fail('external-write approval must be a create-only provider operation', 'INVALID_OPERATION_SET');
    }
    if (operation.ledger_only === true && operation.delete_after_verify === true) {
      fail('ledger-only operation cannot delete provider config', 'INVALID_OPERATION_SET');
    }
    if (operation.delete_after_verify !== undefined && typeof operation.delete_after_verify !== 'boolean') {
      fail('deferred-delete approval must be boolean', 'INVALID_OPERATION_SET');
    }
  }
}

function operationDigest(operations) {
  return sha256Canonical(operations);
}

function pointerOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function validateSharedRows(rows) {
  const clients = new Set(rows.map(row => row.client_id));
  if (clients.size <= 1) return;
  const sharedId = rows[0].shared_resource_id;
  if (typeof sharedId !== 'string' || sharedId.trim() === '' || rows.some(row => row.shared_resource_id !== sharedId)) {
    fail('multiple adapters target one config without an explicit shared resource', 'SHARED_WRITE_CONFLICT');
  }
  for (const row of rows) {
    if (!Array.isArray(row.owned_paths) || row.owned_paths.length === 0 || !row.owned_paths.every(path => typeof path === 'string' && path.startsWith('/'))) {
      fail('shared config write lacks an owned-field partition', 'SHARED_WRITE_CONFLICT');
    }
  }
  for (let left = 0; left < rows.length; left += 1) {
    for (let right = left + 1; right < rows.length; right += 1) {
      if (rows[left].client_id === rows[right].client_id) continue;
      if (rows[left].owned_paths.some(a => rows[right].owned_paths.some(b => pointerOverlap(a, b)))) {
        fail('shared config owned-field partitions overlap', 'SHARED_WRITE_CONFLICT');
      }
    }
  }
}

async function directoryIdentity(path, fsImpl) {
  const stat = await fsImpl.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('transaction parent directory changed identity', 'UNSAFE_WRITABLE_PATH');
  return statIdentity(stat);
}

function identityEqual(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino && left?.birthtime_ms === right?.birthtime_ms;
}

async function inspectParentPlan(targetPath, allowedRoot, fsImpl) {
  const root = resolve(allowedRoot);
  const missing = [];
  let current = dirname(resolve(targetPath));
  while (true) {
    if (!contained(root, current)) fail('transaction parent escapes its writable root', 'PATH_OUTSIDE_WRITABLE_ROOT');
    try {
      const identity = await directoryIdentity(current, fsImpl);
      return { nearest_existing: current, nearest_identity: identity, missing_parents: missing.reverse() };
    } catch (error) {
      if (!isMissing(error)) throw error;
      if (pathKey(current) === pathKey(root)) fail('writable root is absent', 'INVALID_TRANSACTION_ROOT');
      missing.push(current);
      const parent = dirname(current);
      if (parent === current) fail('could not resolve a writable parent', 'INVALID_TRANSACTION_ROOT');
      current = parent;
    }
  }
}

function transactionResultBase(state) {
  return {
    clients: [...state.clientResults],
    touched_files: [...state.changedOrder].map(key => {
      const record = state.records.get(key);
      return {
        path: record.path,
        applied_sha256: record.appliedFingerprint?.content_sha256 ?? null,
      };
    }),
  };
}

export function createClientTransaction({
  localState,
  fsImpl = defaultFs,
  clock = Date.now,
  windowsNative = DEFAULT_WINDOWS_NATIVE,
  processRunner = createProcessRunner(),
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  externalLease = null,
} = {}) {
  if (!localState?.paths || typeof localState.acquireApplyLease !== 'function'
    || typeof localState.createSnapshot !== 'function'
    || typeof localState.deleteSnapshot !== 'function') {
    fail('transaction requires the core local-state contract', 'INVALID_LOCAL_STATE');
  }
  if (!windowsNative?.fingerprintWindowsFileMetadata || !windowsNative?.replaceFilePreservingMetadata) {
    fail('transaction requires the Windows metadata contract', 'INVALID_WINDOWS_NATIVE');
  }
  if (externalLease !== null
    && (typeof externalLease !== 'object'
      || !/^[0-9a-f]{48}$/.test(externalLease.ownerToken ?? '')
      || typeof externalLease.release !== 'function'
      || typeof localState.validateApplyLease !== 'function')) {
    fail('external apply lease capability is invalid', 'INVALID_APPLY_LEASE');
  }

  const state = {
    phase: 'new',
    lease: null,
    ownsLease: false,
    planDigest: null,
    operationDigest: null,
    adapters: new Map(),
    operations: [],
    records: new Map(),
    readOnly: [],
    changedOrder: [],
    createdDirectories: [],
    clientResults: [],
    deferredDeletes: new Map(),
    currentClient: null,
    transactionId: randomBytes(12).toString('hex'),
  };

  const capture = (path, roots, writable = true) => captureClientPathFingerprint(path, {
    allowedRoots: roots,
    fsImpl,
    windowsNative,
    processRunner,
    systemRoot,
    writable,
  });

  async function releaseLease() {
    if (!state.lease) return;
    const lease = state.lease;
    const ownsLease = state.ownsLease;
    state.lease = null;
    state.ownsLease = false;
    if (ownsLease) await lease.release();
  }

  async function deleteSnapshot(record) {
    if (!record.snapshot) return;
    await localState.deleteSnapshot(record.snapshot);
    record.snapshot = null;
  }

  async function createMissingParents(record) {
    if (record.parentPlan.missing_parents.length === 0) return;
    const nearest = await directoryIdentity(record.parentPlan.nearest_existing, fsImpl);
    if (!identityEqual(nearest, record.parentPlan.nearest_identity)) {
      fail('nearest existing parent changed before directory creation', 'TRANSACTION_PRECONDITION_CHANGED');
    }
    for (const path of record.parentPlan.missing_parents) {
      try {
        const existing = await fsImpl.lstat(path);
        if (!existing.isDirectory() || existing.isSymbolicLink()) fail('planned parent became unsafe', 'TRANSACTION_PRECONDITION_CHANGED');
        const created = record.createdDirectories.find(row => pathKey(row.path) === pathKey(path));
        if (!created || !identityEqual(statIdentity(existing), created.identity)) {
          fail('planned-missing parent was created outside this transaction', 'TRANSACTION_PRECONDITION_CHANGED');
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        await fsImpl.mkdir(path);
        const created = { path, identity: await directoryIdentity(path, fsImpl) };
        record.createdDirectories.push(created);
        state.createdDirectories.push(created);
      }
    }
  }

  async function replaceExisting(replacementPath, destinationPath) {
    return windowsNative.replaceFilePreservingMetadata({
      replacementPath,
      destinationPath,
      runner: processRunner,
      systemRoot,
      fsImpl,
    });
  }

  function markChanged(record, fingerprint) {
    record.appliedFingerprint = fingerprint;
    record.currentFingerprint = fingerprint;
    if (!record.changed) {
      record.changed = true;
      record.changedBy = state.currentClient;
      state.changedOrder.push(record.key);
    }
  }

  function currentOperation(path) {
    const key = pathKey(path);
    return state.operations.find(operation => operation.client_id === state.currentClient
      && pathKey(operation.path) === key);
  }

  async function writeFile(path, bytes, { parse: parseResult, [STAGED_WRITE_TOKEN]: stagedWrite = false } = {}) {
    if (state.phase !== 'applying') fail('transaction writes are available only during apply', 'TRANSACTION_NOT_APPLYING');
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail('transaction write requires bytes', 'INVALID_TRANSACTION_BYTES');
    const content = Buffer.from(bytes);
    if (content.length > MAX_CONFIG_BYTES) fail('transaction config exceeds its byte limit', 'CONFIG_BYTE_LIMIT');
    const key = pathKey(path);
    const record = state.records.get(key);
    if (!record || pathKey(record.path) !== key) fail('adapter attempted an unplanned write', 'UNAPPROVED_OPERATION_SET');
    if (currentOperation(path)?.external_write === true && stagedWrite !== true) {
      fail('reviewed external write must use the native-write capability', 'EXTERNAL_WRITE_REQUIRED');
    }

    const before = await capture(record.path, [record.allowedRoot], true);
    if (!fingerprintsEqual(before, record.currentFingerprint)) fail('writable path changed before replacement', 'TRANSACTION_PRECONDITION_CHANGED');
    await createMissingParents(record);
    const afterParents = await capture(record.path, [record.allowedRoot], true);
    if (!fingerprintsEqual(afterParents, before)) fail('writable path changed during parent creation', 'TRANSACTION_PRECONDITION_CHANGED');

    const scratch = join(dirname(record.path), `.${randomBytes(16).toString('hex')}.uemcp-write`);
    let handle = null;
    try {
      handle = await fsImpl.open(scratch, 'wx', record.snapshot.metadata.mode ?? 0o600);
      await handle.writeFile(content);
      await handle.sync();
      await handle.close();
      handle = null;

      try {
        if (before.exists) {
          await replaceExisting(scratch, record.path);
        } else {
          const stillAbsent = await capture(record.path, [record.allowedRoot], true);
          if (!fingerprintsEqual(stillAbsent, before)) fail('missing target changed before create', 'TRANSACTION_PRECONDITION_CHANGED');
          await fsImpl.rename(scratch, record.path);
        }
      } catch (error) {
        const observed = await capture(record.path, [record.allowedRoot], true).catch(() => null);
        if (observed && !fingerprintsEqual(observed, before)) markChanged(record, observed);
        throw error;
      }

      const diskBytes = await fsImpl.readFile(record.path);
      const applied = await capture(record.path, [record.allowedRoot], true);
      markChanged(record, applied);
      if (!diskBytes.equals(content) || applied.content_sha256 !== sha256Bytes(content)) {
        fail('client config changed during transaction replacement', 'TRANSACTION_POSTWRITE_CHANGED');
      }
      if (before.exists && applied.metadata_sha256 !== before.metadata_sha256) {
        fail('existing-file security metadata changed during replacement', 'METADATA_PRESERVATION_FAILED');
      }
      if (typeof parseResult === 'function') await parseResult(diskBytes);
      return {
        path: record.path,
        content_sha256: applied.content_sha256,
        metadata_sha256: applied.metadata_sha256,
      };
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fsImpl.rm(scratch, { force: true }).catch(() => {});
    }
  }

  function safeStageRelativePath(value) {
    if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) return false;
    const parts = value.replace(/\\/g, '/').split('/');
    return parts.every(part => part !== '' && part !== '.' && part !== '..');
  }

  function nativeStagePaths() {
    const stateRoot = resolve(localState.paths().state);
    const stageParent = resolve(join(stateRoot, 'native-staging'));
    if (pathKey(dirname(stageParent)) !== pathKey(stateRoot)) {
      fail('native stage parent is outside local state', 'UNSAFE_WRITABLE_PATH');
    }
    return { stateRoot, stageParent };
  }

  async function removeTreeWithoutFollowingLinks(path) {
    let stat;
    try {
      stat = await fsImpl.lstat(path);
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      await fsImpl.rm(path, { force: true });
      return;
    }
    for (const name of await fsImpl.readdir(path)) {
      await removeTreeWithoutFollowingLinks(join(path, name));
    }
    await fsImpl.rmdir(path);
  }

  async function removeDetachedStage(path, stateRoot, { expectedChildName = null } = {}) {
    if (pathKey(dirname(path)) !== pathKey(stateRoot)) fail('detached native stage path is unsafe', 'STAGED_CLEANUP_FAILED');
    let unsafe = false;
    let contaminated = false;
    try {
      const stat = await fsImpl.lstat(path);
      unsafe = stat.isSymbolicLink() || !stat.isDirectory();
      if (!unsafe && expectedChildName !== null) {
        const names = await fsImpl.readdir(path);
        contaminated = names.length !== 1 || names[0] !== expectedChildName;
      }
      await removeTreeWithoutFollowingLinks(path);
      const remains = await fsImpl.lstat(path).then(() => true, error => {
        if (isMissing(error)) return false;
        throw error;
      });
      if (remains) fail('native stage cleanup could not be verified', 'STAGED_CLEANUP_FAILED');
      return { removed: true, unsafe, contaminated };
    } catch (error) {
      if (error?.code === 'STAGED_CLEANUP_FAILED') throw error;
      fail('native stage cleanup failed', 'STAGED_CLEANUP_FAILED', { cause_code: error?.code ?? 'UNKNOWN' });
    }
  }

  async function detachAndRemoveStageParent(stageParent, stateRoot, options = {}) {
    if (pathKey(dirname(stageParent)) !== pathKey(stateRoot)) {
      fail('native stage cleanup path is unsafe', 'STAGED_CLEANUP_FAILED');
    }
    await assertWritableAncestry(stateRoot, stateRoot, fsImpl);
    const quarantine = resolve(join(stateRoot, `.native-staging-${randomBytes(12).toString('hex')}.stale`));
    if (pathKey(dirname(quarantine)) !== pathKey(stateRoot)) {
      fail('native stage quarantine path is unsafe', 'STAGED_CLEANUP_FAILED');
    }
    try {
      await fsImpl.rename(stageParent, quarantine);
    } catch (error) {
      if (isMissing(error)) return { removed: false, unsafe: false, contaminated: false };
      fail('native stage could not be detached for cleanup', 'STAGED_CLEANUP_FAILED', { cause_code: error?.code ?? 'UNKNOWN' });
    }
    return removeDetachedStage(quarantine, stateRoot, options);
  }

  async function cleanupAbandonedStages() {
    const { stateRoot, stageParent } = nativeStagePaths();
    await assertWritableAncestry(stateRoot, stateRoot, fsImpl);
    let unsafe = false;
    for (const name of await fsImpl.readdir(stateRoot)) {
      if (!STAGE_QUARANTINE_PATTERN.test(name)) continue;
      const cleanup = await removeDetachedStage(resolve(join(stateRoot, name)), stateRoot);
      unsafe ||= cleanup.unsafe;
    }
    let stat;
    try {
      stat = await fsImpl.lstat(stageParent);
    } catch (error) {
      if (isMissing(error)) {
        if (unsafe) fail('abandoned native stage is unsafe', 'UNSAFE_WRITABLE_PATH');
        return;
      }
      throw error;
    }
    unsafe ||= stat.isSymbolicLink() || !stat.isDirectory();
    const cleanup = await detachAndRemoveStageParent(stageParent, stateRoot);
    if (unsafe || cleanup.unsafe) fail('native stage parent is unsafe', 'UNSAFE_WRITABLE_PATH');
  }

  async function inspectStage(stageRoot, relativePath) {
    const expectedParts = relativePath.replace(/\\/g, '/').split('/');
    const expected = new Set();
    for (let index = 0; index < expectedParts.length; index += 1) {
      expected.add(expectedParts.slice(0, index + 1).join('/'));
    }
    const observed = [];
    async function visit(directory, prefix = '') {
      const names = await fsImpl.readdir(directory);
      for (const name of names.sort()) {
        const relativeName = prefix ? `${prefix}/${name}` : name;
        observed.push(relativeName);
        if (observed.length > MAX_STAGE_ENTRIES) fail('native stage exceeds its entry limit', 'UNEXPECTED_STAGED_OUTPUT');
        const path = join(directory, name);
        const stat = await fsImpl.lstat(path);
        if (stat.isSymbolicLink()) fail('native stage contains a linked entry', 'UNEXPECTED_STAGED_OUTPUT');
        if (stat.isDirectory()) await visit(path, relativeName);
        else if (!stat.isFile() || Number(stat.nlink) !== 1) fail('native stage contains an unsafe entry', 'UNEXPECTED_STAGED_OUTPUT');
      }
    }
    await visit(stageRoot);
    if (observed.length !== expected.size || observed.some(entry => !expected.has(entry))) {
      fail('native stage contains unexpected output', 'UNEXPECTED_STAGED_OUTPUT');
    }
  }

  async function removeStage(stageRoot, stageParent, stateRoot) {
    if (pathKey(dirname(stageRoot)) !== pathKey(stageParent)) {
      fail('native stage cleanup path is unsafe', 'STAGED_CLEANUP_FAILED');
    }
    const expectedChildName = relative(stageParent, stageRoot);
    if (!expectedChildName || expectedChildName.includes(sep)) fail('native stage child name is unsafe', 'STAGED_CLEANUP_FAILED');
    const cleanup = await detachAndRemoveStageParent(stageParent, stateRoot, { expectedChildName });
    if (!cleanup.removed || cleanup.unsafe) fail('native stage cleanup identity changed', 'STAGED_CLEANUP_FAILED');
    if (cleanup.contaminated) fail('native stage contains undeclared sibling output', 'UNEXPECTED_STAGED_OUTPUT');
  }

  async function runStagedWrite(path, mutate, {
    seed_bytes: seedBytes = Buffer.alloc(0),
    stage_relative_path: relativePath,
    parse: parseResult,
  } = {}) {
    if (state.phase !== 'applying') fail('staged writes are available only during apply', 'TRANSACTION_NOT_APPLYING');
    if (typeof mutate !== 'function' || !safeStageRelativePath(relativePath)) fail('staged write contract is invalid', 'INVALID_EXTERNAL_WRITE');
    if (!Buffer.isBuffer(seedBytes) && !(seedBytes instanceof Uint8Array)) fail('staged write seed requires bytes', 'INVALID_TRANSACTION_BYTES');
    const seed = Buffer.from(seedBytes);
    if (seed.length > MAX_CONFIG_BYTES) fail('staged write seed exceeds its byte limit', 'CONFIG_BYTE_LIMIT');
    const key = pathKey(path);
    const record = state.records.get(key);
    const operation = currentOperation(path);
    if (!record || !operation || operation.external_write !== true || pathKey(record.path) !== key) {
      fail('adapter attempted an unapproved external write', 'UNAPPROVED_EXTERNAL_WRITE');
    }
    if (record.clients.some(clientId => clientId !== state.currentClient)) {
      fail('shared client config cannot use an external writer', 'SHARED_WRITE_CONFLICT');
    }
    if (record.externalWriteUsed === true) fail('staged write capability is one-shot', 'EXTERNAL_WRITE_ALREADY_USED');

    const before = await capture(record.path, [record.allowedRoot], true);
    if (!fingerprintsEqual(before, record.currentFingerprint)) fail('writable path changed before staging', 'TRANSACTION_PRECONDITION_CHANGED');
    const currentBytes = before.exists ? await fsImpl.readFile(record.path) : Buffer.alloc(0);
    if (!currentBytes.equals(seed)) fail('staged seed differs from reviewed provider config', 'INVALID_STAGED_SEED');
    record.externalWriteUsed = true;
    const { stateRoot, stageParent } = nativeStagePaths();
    await assertWritableAncestry(stageParent, stateRoot, fsImpl);
    await fsImpl.mkdir(stageParent, { mode: 0o700 }).catch(error => {
      if (error?.code !== 'EEXIST') throw error;
    });
    await assertWritableAncestry(stageParent, stateRoot, fsImpl);
    const parentStat = await fsImpl.lstat(stageParent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('native stage parent is unsafe', 'UNSAFE_WRITABLE_PATH');
    const stageRoot = await fsImpl.mkdtemp(join(stageParent, `${state.transactionId}-`));
    await fsImpl.chmod(stageRoot, 0o700);
    const stageStat = await fsImpl.lstat(stageRoot);
    if (pathKey(dirname(stageRoot)) !== pathKey(stageParent) || !stageStat.isDirectory() || stageStat.isSymbolicLink()) {
      fail('native stage root is unsafe', 'UNSAFE_WRITABLE_PATH');
    }
    const stagedPath = resolve(stageRoot, relativePath);
    if (!contained(stageRoot, stagedPath)) fail('native stage target escapes its root', 'INVALID_EXTERNAL_WRITE');
    await fsImpl.mkdir(dirname(stagedPath), { recursive: true, mode: 0o700 });
    let handle = null;
    let stagedBytes = null;
    let pendingError = null;
    try {
      handle = await fsImpl.open(stagedPath, 'wx', 0o600);
      await handle.writeFile(seed);
      await handle.sync();
      await handle.close();
      handle = null;
      await mutate(stagedPath, Object.freeze({ root: stageRoot, relative_path: relativePath }));
      await inspectStage(stageRoot, relativePath.replace(/\\/g, '/'));
      const stagedFingerprint = await capture(stagedPath, [stageRoot], true);
      if (!stagedFingerprint.exists || stagedFingerprint.kind !== 'file' || stagedFingerprint.link_kind !== 'none') {
        fail('native stage did not produce a safe config file', 'UNEXPECTED_STAGED_OUTPUT');
      }
      stagedBytes = await fsImpl.readFile(stagedPath);
      if (stagedBytes.length > MAX_CONFIG_BYTES) fail('staged config exceeds its byte limit', 'CONFIG_BYTE_LIMIT');
      if (stagedBytes.equals(seed)) fail('native stage did not change the reviewed config', 'EXTERNAL_WRITE_NO_CHANGE');
      if (typeof parseResult === 'function') await parseResult(stagedBytes);
    } catch (error) {
      pendingError = error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    try {
      await removeStage(stageRoot, stageParent, stateRoot);
    } catch (error) {
      throw error;
    }
    if (pendingError) throw pendingError;
    return writeFile(record.path, stagedBytes, { parse: parseResult, [STAGED_WRITE_TOKEN]: true });
  }

  async function deleteFileAfterVerify(path) {
    if (state.phase !== 'applying') fail('deferred deletes are available only during apply', 'TRANSACTION_NOT_APPLYING');
    const key = pathKey(path);
    const record = state.records.get(key);
    const operation = state.operations.find(candidate => candidate.client_id === state.currentClient
      && pathKey(candidate.path) === key
      && candidate.delete_after_verify === true);
    if (!record || !operation || !record.changed || record.changedBy !== state.currentClient) {
      fail('adapter attempted an unapproved deferred delete', 'UNAPPROVED_DEFERRED_DELETE');
    }
    if (record.clients.some(clientId => clientId !== state.currentClient)) {
      fail('shared client config cannot be deleted', 'SHARED_WRITE_CONFLICT');
    }
    state.deferredDeletes.set(key, { key, client_id: state.currentClient });
    return { path: record.path, status: 'DEFERRED' };
  }

  const ownershipPath = resolve(localState.paths().ownership);
  const ownershipLedger = Object.freeze({
    async read() {
      try {
        return JSON.parse(await fsImpl.readFile(ownershipPath, 'utf8'));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async write(value) {
      return writeFile(ownershipPath, Buffer.from(`${canonicalJson(value)}\n`, 'utf8'), {
        parse: bytes => JSON.parse(bytes.toString('utf8')),
      });
    },
    now: () => new Date(Number(clock())).toISOString(),
  });

  const transactionCapability = Object.freeze({ writeFile, runStagedWrite, deleteFileAfterVerify, ownershipLedger });

  async function snapshot({ planDigest, adapters, operations, context = {}, ownershipFingerprint } = {}) {
    if (state.phase !== 'new') fail('transaction snapshot can run only once', 'TRANSACTION_STATE_INVALID');
    validatePlanDigest(planDigest);
    const mappedAdapters = adapterMap(adapters);
    validateOperations(operations, mappedAdapters);
    if (externalLease) {
      await localState.validateApplyLease(externalLease);
      state.lease = externalLease;
      state.ownsLease = false;
    } else {
      state.lease = await localState.acquireApplyLease({
        pid: process.pid,
        processStart: Math.round(Date.now() - process.uptime() * 1000),
        waitMs: 0,
      });
      state.ownsLease = true;
    }
    state.phase = 'preflight';
    try {
      await cleanupAbandonedStages();
      const writableRows = [];
      const readOnlyRows = [];
      for (const clientId of CLIENT_IDS) {
        const adapter = mappedAdapters.get(clientId);
        if (!adapter) continue;
        const clientOperations = operations.filter(operation => operation.client_id === clientId);
        const declared = await adapter.snapshot(context, clientOperations);
        if (!declared || !Array.isArray(declared.writable_paths) || !Array.isArray(declared.read_only_paths)) {
          fail('adapter snapshot declaration is invalid', 'INVALID_ADAPTER_SNAPSHOT');
        }
        for (const row of declared.writable_paths) {
          const operation = clientOperations.find(candidate => pathKey(candidate.path) === pathKey(row.path));
          if (!operation) fail('adapter declared an unapproved writable path', 'UNAPPROVED_OPERATION_SET');
          writableRows.push({
            client_id: clientId,
            path: row.path,
            allowed_root: row.allowed_root,
            scope_kind: row.scope_kind,
            fingerprint: row.fingerprint,
            owned_paths: row.owned_paths,
            shared_resource_id: row.shared_resource_id,
          });
        }
        for (const row of declared.read_only_paths) readOnlyRows.push({ ...row, client_id: clientId });
      }

      const operationPaths = new Set(writableRows.map(row => `${row.client_id}:${pathKey(row.path)}`));
      const readOnlyOperationPaths = new Set(readOnlyRows.map(row => `${row.client_id}:${pathKey(row.path)}`));
      for (const operation of operations) {
        const declaredPaths = operation.ledger_only === true ? readOnlyOperationPaths : operationPaths;
        if (!declaredPaths.has(`${operation.client_id}:${pathKey(operation.path)}`)) {
          fail('planned operation lacks an adapter writable declaration', 'INVALID_ADAPTER_SNAPSHOT');
        }
      }
      if (!ownershipFingerprint || typeof ownershipFingerprint !== 'object') fail('ownership ledger precondition is missing', 'INVALID_OPERATION_SET');
      writableRows.push({
        client_id: 'ownership',
        path: ownershipPath,
        allowed_root: localState.paths().state,
        scope_kind: 'local_state',
        fingerprint: ownershipFingerprint,
        owned_paths: ['/records'],
        shared_resource_id: 'uemcp-ownership-ledger',
      });

      for (const row of writableRows) {
        if (!WRITABLE_SCOPES.has(row.scope_kind)) fail('adapter attempted to write a read-only scope', 'READ_ONLY_SCOPE');
        await assertWritableAncestry(row.path, row.allowed_root, fsImpl);
        const current = await capture(row.path, [row.allowed_root], true);
        if (!fingerprintsEqual(current, row.fingerprint)) fail('writable path precondition changed', 'TRANSACTION_PRECONDITION_CHANGED');
        row.current = current;
      }
      for (const row of readOnlyRows) {
        if (!row?.fingerprint || !safeAbsolutePath(row.path) || !safeAbsolutePath(row.allowed_root)) {
          fail('read-only evidence declaration is invalid', 'INVALID_ADAPTER_SNAPSHOT');
        }
        const current = await capture(row.path, [row.allowed_root], false);
        if (!fingerprintsEqual(current, row.fingerprint)) fail('read-only evidence precondition changed', 'TRANSACTION_PRECONDITION_CHANGED');
        row.current = current;
      }

      const grouped = new Map();
      for (const row of writableRows) {
        const key = pathKey(row.path);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
      }
      for (const rows of grouped.values()) validateSharedRows(rows);
      if (grouped.has(pathKey(ownershipPath)) && grouped.get(pathKey(ownershipPath)).length !== 1) {
        fail('client config collides with the ownership ledger', 'SHARED_WRITE_CONFLICT');
      }

      const ordered = [...grouped.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      for (const [key, rows] of ordered) {
        const row = rows[0];
        const parentPlan = await inspectParentPlan(row.path, row.allowed_root, fsImpl);
        state.records.set(key, {
          key,
          path: resolve(row.path),
          allowedRoot: resolve(row.allowed_root),
          originalFingerprint: row.current,
          currentFingerprint: row.current,
          appliedFingerprint: null,
          changed: false,
          changedBy: null,
          parentPlan,
          createdDirectories: [],
          clients: [...new Set(rows.map(candidate => candidate.client_id))],
          snapshot: null,
          externalWriteUsed: false,
        });
      }
      state.readOnly = readOnlyRows;
      for (const record of state.records.values()) {
        record.snapshot = await localState.createSnapshot(record.path, {
          transactionId: state.transactionId,
          retainOnConflict: true,
        });
      }
      state.planDigest = planDigest;
      state.operationDigest = operationDigest(operations);
      state.adapters = mappedAdapters;
      state.operations = structuredClone(operations);
      state.phase = 'snapshotted';
      return {
        transaction_id: state.transactionId,
        writable_paths: [...state.records.values()].map(record => record.path),
        read_only_paths: readOnlyRows.map(row => resolve(row.path)),
      };
    } catch (error) {
      for (const record of state.records.values()) await deleteSnapshot(record).catch(() => {});
      state.phase = 'failed';
      await releaseLease().catch(() => {});
      throw error;
    }
  }

  async function recheckBeforeApply() {
    for (const record of state.records.values()) {
      const current = await capture(record.path, [record.allowedRoot], true);
      if (!fingerprintsEqual(current, record.currentFingerprint)) fail('writable path changed after snapshot', 'TRANSACTION_PRECONDITION_CHANGED');
    }
    for (const row of state.readOnly) {
      const current = await capture(row.path, [row.allowed_root], false);
      if (!fingerprintsEqual(current, row.current)) fail('read-only evidence changed after snapshot', 'TRANSACTION_PRECONDITION_CHANGED');
    }
  }

  async function recheckAfterVerify() {
    for (const record of state.records.values()) {
      if (!record.changed) continue;
      const current = await capture(record.path, [record.allowedRoot], true);
      if (!fingerprintsEqual(current, record.appliedFingerprint)) {
        fail('client config changed after the transaction write', 'TRANSACTION_POSTWRITE_CHANGED');
      }
    }
    for (const row of state.readOnly) {
      const current = await capture(row.path, [row.allowed_root], false);
      if (!fingerprintsEqual(current, row.current)) fail('read-only evidence changed during apply', 'TRANSACTION_POSTWRITE_CHANGED');
    }
  }

  async function commitDeferredDeletes() {
    const failures = [];
    const ordered = [...state.deferredDeletes.values()].sort((left, right) => left.key.localeCompare(right.key));
    for (const deferred of ordered) {
      const record = state.records.get(deferred.key);
      let current;
      try {
        current = await capture(record.path, [record.allowedRoot], true);
      } catch (error) {
        failures.push({ path: record.path, code: error?.code ?? 'DEFERRED_DELETE_INSPECTION_FAILED' });
        continue;
      }
      if (!fingerprintsEqual(current, record.appliedFingerprint)) {
        failures.push({ path: record.path, code: 'DEFERRED_DELETE_CONFLICT' });
        continue;
      }
      try {
        await fsImpl.rm(record.path);
      } catch (error) {
        failures.push({ path: record.path, code: error?.code ?? 'DEFERRED_DELETE_FAILED' });
        continue;
      }
      try {
        const after = await capture(record.path, [record.allowedRoot], true);
        if (after.exists) {
          failures.push({ path: record.path, code: 'DEFERRED_DELETE_CONFLICT' });
          continue;
        }
        markChanged(record, after);
      } catch (error) {
        failures.push({ path: record.path, code: error?.code ?? 'DEFERRED_DELETE_VERIFY_FAILED' });
      }
    }
    return failures;
  }

  async function cleanupCreatedDirectories() {
    const seen = new Set();
    for (const created of [...state.createdDirectories].reverse()) {
      const key = pathKey(created.path);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const current = await directoryIdentity(created.path, fsImpl);
        if (!identityEqual(current, created.identity)) continue;
        if ((await fsImpl.readdir(created.path)).length === 0) await fsImpl.rmdir(created.path);
      } catch (error) {
        if (!isMissing(error)) continue;
      }
    }
  }

  async function restoreRecord(record) {
    let current;
    try {
      current = await capture(record.path, [record.allowedRoot], true);
    } catch (error) {
      if (['UNSAFE_WRITABLE_PATH', 'METADATA_INSPECTION_FAILED', 'READ_ONLY_TARGET'].includes(error?.code)) {
        return { status: 'conflict', path: record.path, code: 'ROLLBACK_CONFLICT' };
      }
      throw error;
    }
    if (!fingerprintsEqual(current, record.appliedFingerprint)) {
      return { status: 'conflict', path: record.path, code: 'ROLLBACK_CONFLICT' };
    }
    const metadata = record.snapshot.metadata;
    if (!metadata.exists) {
      await fsImpl.rm(record.path, { force: true });
      const absent = await capture(record.path, [record.allowedRoot], true);
      if (absent.exists) return { status: 'failed', path: record.path, code: 'ROLLBACK_VERIFY_FAILED' };
      return { status: 'restored', path: record.path };
    }

    const payloadPath = join(record.snapshot.directory, 'payload.bin');
    const payload = await fsImpl.readFile(payloadPath);
    if (sha256Bytes(payload) !== metadata.original_sha256) return { status: 'failed', path: record.path, code: 'INVALID_SNAPSHOT' };
    const scratch = join(dirname(record.path), `.${randomBytes(16).toString('hex')}.uemcp-rollback`);
    let handle = null;
    try {
      handle = await fsImpl.open(scratch, 'wx', metadata.mode ?? 0o600);
      await handle.writeFile(payload);
      await handle.sync();
      await handle.close();
      handle = null;
      await replaceExisting(scratch, record.path);
      if (metadata.mode !== null) await fsImpl.chmod(record.path, metadata.mode);
      if (metadata.atime_ms !== null && metadata.mtime_ms !== null) {
        await fsImpl.utimes(record.path, metadata.atime_ms / 1000, metadata.mtime_ms / 1000);
      }
      const restored = await capture(record.path, [record.allowedRoot], true);
      if (!fingerprintsEqual(restored, record.originalFingerprint, { includeIdentity: false, includeMutable: false })) {
        return { status: 'failed', path: record.path, code: 'ROLLBACK_VERIFY_FAILED' };
      }
      if (metadata.atime_ms !== null && metadata.mtime_ms !== null) {
        await fsImpl.utimes(record.path, metadata.atime_ms / 1000, metadata.mtime_ms / 1000);
      }
      const finalStat = await fsImpl.lstat(record.path);
      if ((metadata.mode !== null && Number(finalStat.mode) !== Number(metadata.mode))
        || (metadata.atime_ms !== null && Math.abs(Number(finalStat.atimeMs) - Number(metadata.atime_ms)) > 2)
        || (metadata.mtime_ms !== null && Math.abs(Number(finalStat.mtimeMs) - Number(metadata.mtime_ms)) > 2)) {
        return { status: 'failed', path: record.path, code: 'ROLLBACK_METADATA_VERIFY_FAILED' };
      }
      return { status: 'restored', path: record.path };
    } finally {
      if (handle) await handle.close().catch(() => {});
      await fsImpl.rm(scratch, { force: true }).catch(() => {});
    }
  }

  async function rollbackInternal({ reason = 'apply_failed', adapters = state.adapters } = {}) {
    state.phase = 'rolling_back';
    let hookFailed = false;
    const hookErrors = [];
    for (const clientId of [...CLIENT_IDS].reverse()) {
      const adapter = adapters.get(clientId);
      if (!adapter || typeof adapter.rollback !== 'function') continue;
      const records = [...state.records.values()].filter(record => record.changed && record.changedBy === clientId);
      if (records.length === 0) continue;
      try {
        await adapter.rollback({ transaction: transactionCapability }, records.map(record => ({ path: record.path })));
      } catch (error) {
        hookFailed = true;
        hookErrors.push({ client_id: clientId, code: error?.code ?? 'ROLLBACK_HOOK_FAILED' });
      }
    }

    const restoration = [];
    for (const key of [...state.changedOrder].reverse()) {
      const record = state.records.get(key);
      try {
        restoration.push(await restoreRecord(record));
      } catch (error) {
        restoration.push({ status: 'failed', path: record.path, code: error?.code ?? 'ROLLBACK_FAILED' });
      }
    }
    await cleanupCreatedDirectories();

    const retained = [];
    for (const record of state.records.values()) {
      const outcome = restoration.find(row => pathKey(row.path) === record.key);
      if (outcome?.status === 'conflict' || outcome?.status === 'failed') {
        retained.push({
          path: record.path,
          retained_until: record.snapshot.metadata.retained_until,
        });
      } else {
        try {
          await deleteSnapshot(record);
        } catch (error) {
          hookFailed = true;
          hookErrors.push({ client_id: 'transaction', code: error?.code ?? 'SNAPSHOT_DELETE_FAILED' });
          retained.push({
            path: record.path,
            retained_until: record.snapshot.metadata.retained_until,
          });
        }
      }
    }
    const hasConflict = restoration.some(row => row.status === 'conflict');
    const hasFailure = restoration.some(row => row.status === 'failed') || hookFailed;
    const status = hasConflict ? 'ROLLBACK_CONFLICT' : hasFailure ? 'ROLLBACK_FAILED' : 'ROLLED_BACK';
    state.phase = 'complete';
    await releaseLease();
    return {
      status,
      ...transactionResultBase(state),
      rollback: {
        reason_code: typeof reason === 'string' && /^[A-Z0-9_]+$/.test(reason) ? reason : 'APPLY_FAILED',
        paths: restoration,
        hook_errors: hookErrors,
      },
      retained_snapshots: retained,
    };
  }

  async function apply({ planDigest, adapters, operations, context = {} } = {}) {
    if (state.phase !== 'snapshotted') fail('transaction must be snapshotted before apply', 'TRANSACTION_STATE_INVALID');
    let suppliedAdapters;
    try {
      if (externalLease) await localState.validateApplyLease(externalLease);
      validatePlanDigest(planDigest);
      suppliedAdapters = adapterMap(adapters);
      if (planDigest !== state.planDigest
        || operationDigest(operations) !== state.operationDigest
        || JSON.stringify([...suppliedAdapters.keys()].sort()) !== JSON.stringify([...state.adapters.keys()].sort())) {
        fail('apply differs from the reviewed transaction plan', 'UNAPPROVED_OPERATION_SET');
      }
    } catch (error) {
      await rollbackInternal({ reason: error?.code ?? 'UNAPPROVED_OPERATION_SET' });
      throw error;
    }

    try {
      await recheckBeforeApply();
      state.phase = 'applying';
      const outerBeforeActiveClientLaunch = context.beforeActiveClientLaunch;
      const adapterContext = Object.freeze({
        ...context,
        beforeActiveClientLaunch: async evidence => {
          await recheckAfterVerify();
          return outerBeforeActiveClientLaunch?.(evidence);
        },
        transaction: transactionCapability,
      });
      let actionRequired = false;
      for (const clientId of CLIENT_IDS) {
        const adapter = state.adapters.get(clientId);
        if (!adapter) continue;
        const clientOperations = operations.filter(operation => operation.client_id === clientId);
        state.currentClient = clientId;
        let applyResult;
        try {
          applyResult = await adapter.apply(adapterContext, clientOperations);
          const verified = await adapter.verify(adapterContext, clientOperations);
          const status = verified?.status ?? applyResult?.status ?? 'READY';
          if (ACTION_STATUSES.has(status)) actionRequired = true;
          else if (!READY_STATUSES.has(status)) fail('adapter verification did not reach a committable state', 'ADAPTER_VERIFY_FAILED', { client_id: clientId });
          await recheckAfterVerify();
          state.clientResults.push({ client_id: clientId, status });
        } catch (error) {
          state.clientResults.push({ client_id: clientId, status: 'FAILED', error_code: error?.code ?? 'CLIENT_APPLY_FAILED' });
          throw error;
        } finally {
          state.currentClient = null;
        }
      }

      const deferredDeleteFailures = await commitDeferredDeletes();
      const cleanupFailures = [];
      for (const record of state.records.values()) {
        try {
          await deleteSnapshot(record);
        } catch (error) {
          cleanupFailures.push({
            path: record.path,
            code: error?.code ?? 'SNAPSHOT_DELETE_FAILED',
            retained_until: record.snapshot.metadata.retained_until,
          });
        }
      }
      state.phase = 'complete';
      await releaseLease();
      return {
        status: actionRequired || cleanupFailures.length > 0 || deferredDeleteFailures.length > 0 ? 'ACTION_REQUIRED' : 'APPLIED',
        ...transactionResultBase(state),
        rollback: null,
        retained_snapshots: cleanupFailures.map(row => ({ path: row.path, retained_until: row.retained_until })),
        cleanup_actions: [
          ...cleanupFailures.map(row => ({ path: row.path, code: row.code })),
          ...deferredDeleteFailures,
        ],
      };
    } catch (error) {
      return rollbackInternal({ reason: error?.code ?? 'APPLY_FAILED' });
    }
  }

  async function rollback({ reason = 'ROLLBACK_REQUESTED' } = {}) {
    if (!['snapshotted', 'applying'].includes(state.phase)) fail('transaction cannot roll back in its current state', 'TRANSACTION_STATE_INVALID');
    return rollbackInternal({ reason });
  }

  return Object.freeze({ snapshot, apply, rollback });
}
