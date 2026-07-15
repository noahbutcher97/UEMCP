import { createHash } from 'node:crypto';

export class CanonicalJsonError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'CanonicalJsonError';
    this.code = 'INVALID_CANONICAL_JSON';
    this.details = details;
  }
}

function fail(message, details) {
  throw new CanonicalJsonError(message, details);
}

function encode(value, path, stack) {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('canonical JSON does not support non-finite numbers', { path });
    return Object.is(value, -0) ? '0' : JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    fail('canonical JSON contains an unsupported value', { path, type: typeof value });
  }
  if (stack.has(value)) fail('canonical JSON contains a cycle', { path });
  stack.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((entry, index) => encode(entry, `${path}[${index}]`, stack)).join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('canonical JSON supports only plain objects', { path });
    }
    const entries = Object.keys(value)
      .sort()
      .map(key => `${JSON.stringify(key)}:${encode(value[key], `${path}.${key}`, stack)}`);
    return `{${entries.join(',')}}`;
  } finally {
    stack.delete(value);
  }
}

export function canonicalJson(value) {
  return encode(value, '$', new Set());
}

export function sha256Bytes(bytes) {
  if (typeof bytes === 'string') bytes = Buffer.from(bytes, 'utf8');
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fail('sha256Bytes requires a string, Buffer, or Uint8Array');
  }
  return createHash('sha256').update(bytes).digest('hex');
}

export function sha256Canonical(value) {
  return sha256Bytes(Buffer.from(canonicalJson(value), 'utf8'));
}
