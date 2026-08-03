import * as defaultFs from 'node:fs/promises';

import { sha256Bytes } from './canonical-json.mjs';

export class BoundedConfigFileError extends Error {
  constructor(message, code = 'CONFIG_INSPECTION_FAILED', details = {}) {
    super(message);
    this.name = 'BoundedConfigFileError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details = {}) {
  throw new BoundedConfigFileError(message, code, details);
}

function missing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function assertInputs({ captureFingerprint, entry, tracker, limits, parse, parseBytes }) {
  if (typeof captureFingerprint !== 'function'
    || !entry || typeof entry.path !== 'string' || typeof entry.allowed_root !== 'string'
    || !tracker || !Number.isSafeInteger(tracker.total) || tracker.total < 0
    || !limits || !Number.isSafeInteger(limits.fileBytes) || limits.fileBytes <= 0
    || !Number.isSafeInteger(limits.aggregateBytes) || limits.aggregateBytes < limits.fileBytes
    || (parse && typeof parseBytes !== 'function')) {
    fail('bounded config inspection inputs are invalid', 'INVALID_INSPECTION_LIMIT');
  }
}

function assertWithinLimits(size, tracker, limits, scope) {
  if (!Number.isSafeInteger(size) || size < 0 || size > limits.fileBytes
    || tracker.total + size > limits.aggregateBytes) {
    fail('client config exceeds its inspection byte limit', 'INSPECTION_LIMIT_EXCEEDED', {
      scope,
      maximum_file_bytes: limits.fileBytes,
      maximum_aggregate_bytes: limits.aggregateBytes,
    });
  }
}

export async function readFileWithinLimit(path, {
  fsImpl = defaultFs,
  maxBytes,
  scope = 'client_config',
} = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail('bounded file read limit is invalid', 'INVALID_INSPECTION_LIMIT');
  let handle;
  try {
    handle = await fsImpl.open(path, 'r');
    const stat = await handle.stat();
    if (!stat.isFile() || Number(stat.size) > maxBytes) {
      fail('client config exceeds its inspection byte limit', 'INSPECTION_LIMIT_EXCEEDED', {
        scope,
        maximum_file_bytes: maxBytes,
        observed_bytes: Number(stat.size),
      });
    }
    const chunks = [];
    let total = 0;
    while (total <= maxBytes) {
      const remaining = maxBytes + 1 - total;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) {
      fail('client config exceeds its inspection byte limit', 'INSPECTION_LIMIT_EXCEEDED', {
        scope,
        maximum_file_bytes: maxBytes,
        observed_bytes: total,
      });
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

export async function readBoundedConfigFile({
  fsImpl = defaultFs,
  captureFingerprint,
  entry,
  tracker,
  limits,
  parse = true,
  parseBytes,
} = {}) {
  assertInputs({ captureFingerprint, entry, tracker, limits, parse, parseBytes });
  let stat;
  try {
    stat = await fsImpl.lstat(entry.path);
  } catch (error) {
    if (!missing(error)) throw error;
    const fingerprint = await captureFingerprint(entry.path, {
      allowedRoots: [entry.allowed_root],
      writable: false,
      maxBytes: limits.fileBytes,
    });
    if (fingerprint.exists) fail('client config appeared during inspection', 'UNSAFE_CONFIG_PATH', { scope: entry.scope });
    return { ...entry, fingerprint, exists: false, bytes: null, document: null };
  }

  if (!stat.isFile() || stat.isSymbolicLink()) {
    fail('client config path is not a safe regular file', 'UNSAFE_CONFIG_PATH', { scope: entry.scope });
  }
  assertWithinLimits(Number(stat.size), tracker, limits, entry.scope);
  const fingerprint = await captureFingerprint(entry.path, {
    allowedRoots: [entry.allowed_root],
    writable: false,
    maxBytes: limits.fileBytes,
  });
  if (!fingerprint.exists || fingerprint.kind !== 'file' || fingerprint.link_kind !== 'none') {
    fail('client config identity changed during inspection', 'UNSAFE_CONFIG_PATH', { scope: entry.scope });
  }
  assertWithinLimits(Number(fingerprint.size), tracker, limits, entry.scope);

  if (!parse) {
    tracker.total += Number(fingerprint.size);
    return { ...entry, fingerprint, exists: true, bytes: null, document: null };
  }
  let bytes;
  try {
    bytes = await readFileWithinLimit(entry.path, { fsImpl, maxBytes: limits.fileBytes, scope: entry.scope });
  } catch (error) {
    if (missing(error)) fail('client config disappeared during inspection', 'UNSAFE_CONFIG_PATH', { scope: entry.scope });
    throw error;
  }
  assertWithinLimits(bytes.length, tracker, limits, entry.scope);
  if (bytes.length !== Number(fingerprint.size) || sha256Bytes(bytes) !== fingerprint.content_sha256) {
    fail('client config changed between fingerprint and parse', 'UNSAFE_CONFIG_PATH', { scope: entry.scope });
  }
  tracker.total += bytes.length;
  let document;
  try {
    document = parseBytes(bytes);
  } catch (error) {
    const code = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code)
      ? error.code
      : 'CONFIG_INSPECTION_FAILED';
    throw new BoundedConfigFileError('client config parse failed', code, {
      scope: entry.scope,
      inspected_file: {
        ...entry,
        fingerprint,
        exists: true,
        bytes: null,
        document: null,
      },
    });
  }
  return {
    ...entry,
    fingerprint,
    exists: true,
    bytes,
    document,
  };
}
