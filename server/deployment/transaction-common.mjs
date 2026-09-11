// transaction-common.mjs — constants, the error type, fingerprint comparison,
// ancestry inspection and validation helpers shared by every part of the client
// transaction (pins, stage, snapshot, apply). Pure functions and frozen data;
// no transaction state lives here.

import { constants } from 'node:fs';
import * as defaultFs from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { sha256Canonical } from './canonical-json.mjs';
import { CLIENT_IDS } from './client-contract.mjs';
import { CONFIG_BYTE_LIMIT } from './config-bytes.mjs';
import { fingerprintPath } from './fingerprints.mjs';
import { createProcessRunner } from './process-runner.mjs';
import {
  deleteWindowsTreeNoFollow,
  fingerprintWindowsFileMetadata,
  replaceFilePreservingMetadata,
  withPinnedWindowsAncestry,
  withPinnedWindowsFiles,
} from './windows-native.mjs';

export const MAX_CONFIG_BYTES = CONFIG_BYTE_LIMIT;
export const MAX_STAGE_ENTRIES = 16;
export const STAGE_QUARANTINE_PATTERN = /^\.native-staging-[0-9a-f]{24}\.stale$/;
export const STAGED_WRITE_TOKEN = Symbol('staged-write');
export const WRITABLE_SCOPES = new Set(['user', 'project', 'profile', 'local_state']);
export const ACTION_STATUSES = new Set([
  'ACTION_REQUIRED',
  'CLIENT_ENABLEMENT_REQUIRED',
  'DISABLED',
  'PENDING_APPROVAL',
  'PENDING_RESTART',
  'PENDING_TRUST',
  'POLICY_UNKNOWN',
  'RESTART_REQUIRED',
]);
export const READY_STATUSES = new Set(['APPLIED', 'MATCHING', 'NO_OP', 'READY']);

export const DEFAULT_WINDOWS_NATIVE = Object.freeze({
  deleteTreeNoFollow: deleteWindowsTreeNoFollow,
  fingerprintWindowsFileMetadata,
  replaceFilePreservingMetadata,
  withPinnedAncestry: withPinnedWindowsAncestry,
  withPinnedFiles: withPinnedWindowsFiles,
});

export class ClientTransactionError extends Error {
  constructor(message, code = 'CLIENT_TRANSACTION_FAILED', details = {}) {
    super(message);
    this.name = 'ClientTransactionError';
    this.code = code;
    this.details = details;
  }
}

export function fail(message, code = 'CLIENT_TRANSACTION_FAILED', details = {}) {
  throw new ClientTransactionError(message, code, details);
}

export function pathKey(path) {
  const absolute = resolve(path);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

export function contained(root, candidate) {
  const rel = relative(pathKey(root), pathKey(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

export function safeAbsolutePath(path) {
  return typeof path === 'string'
    && isAbsolute(path)
    && !/^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(path);
}

export function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

export async function assertWritableAncestry(path, allowedRoot, fsImpl) {
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

export function statIdentity(stat) {
  return {
    dev: Number(stat.dev),
    ino: Number(stat.ino),
    birthtime_ms: Number(stat.birthtimeMs),
  };
}

export async function metadataFingerprint(path, {
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

export function comparableFingerprint(fingerprint, { includeIdentity = true, includeMutable = true } = {}) {
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

export function fingerprintsEqual(left, right, options) {
  return sha256Canonical(comparableFingerprint(left, options)) === sha256Canonical(comparableFingerprint(right, options));
}

export function snapshotMatchesFingerprint(snapshot, fingerprint) {
  const metadata = snapshot?.metadata;
  if (!metadata || metadata.exists !== fingerprint.exists) return false;
  if (!fingerprint.exists) {
    return metadata.original_sha256 === null
      && metadata.size === null
      && metadata.identity === null;
  }
  return metadata.original_sha256 === fingerprint.content_sha256
    && metadata.size === fingerprint.size
    && sha256Canonical(metadata.identity) === sha256Canonical(fingerprint.identity);
}

export function validatePlanDigest(planDigest) {
  if (!/^[0-9a-f]{64}$/.test(planDigest ?? '')) fail('transaction plan digest is invalid', 'INVALID_PLAN_DIGEST');
}

export function adapterMap(adapters) {
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

export function validateOperations(operations, adapters) {
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

export function operationDigest(operations) {
  return sha256Canonical(operations);
}

export function pointerOverlap(left, right) {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

export function validateSharedRows(rows) {
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

export async function directoryIdentity(path, fsImpl) {
  const stat = await fsImpl.lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('transaction parent directory changed identity', 'UNSAFE_WRITABLE_PATH');
  return statIdentity(stat);
}

export function identityEqual(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino && left?.birthtime_ms === right?.birthtime_ms;
}

export async function inspectParentPlan(targetPath, allowedRoot, fsImpl) {
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

export async function inspectExistingDirectoryAncestry(directory, fsImpl) {
  const absolute = resolve(directory);
  const volumeRoot = parse(absolute).root;
  const segments = relative(volumeRoot, absolute).split(sep).filter(Boolean);
  const directories = [volumeRoot];
  let current = volumeRoot;
  for (const segment of segments) {
    current = join(current, segment);
    directories.push(current);
  }
  for (const path of directories) {
    let stat;
    try {
      stat = await fsImpl.lstat(path);
    } catch (error) {
      if (isMissing(error)) fail('pinned ancestry entry disappeared', 'TRANSACTION_PRECONDITION_CHANGED');
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail('pinned ancestry contains an unsafe directory', 'UNSAFE_WRITABLE_PATH');
    }
  }
  return directories;
}

export function transactionResultBase(state) {
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
