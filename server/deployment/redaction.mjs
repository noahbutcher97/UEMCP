export const DEFAULT_SECRET_KEYS = Object.freeze([
  'token',
  'secret',
  'password',
  'passphrase',
  'authorization',
  'cookie',
  'api_key',
  'apikey',
  'env',
]);

const REDACTED = '<redacted>';

export class RedactionError extends Error {
  constructor(message, code = 'REDACTION_FAILED', details = {}) {
    super(message);
    this.name = 'RedactionError';
    this.code = code;
    this.details = details;
  }
}

function normalizedKey(value) {
  return value.toLowerCase().replace(/[-\s]+/g, '_');
}

function isSecretKey(key, secretKeys) {
  const normalized = normalizedKey(key);
  return secretKeys.some(secret => {
    const expected = normalizedKey(secret);
    return normalized === expected
      || normalized.startsWith(`${expected}_`)
      || normalized.endsWith(`_${expected}`)
      || normalized.includes(`_${expected}_`);
  });
}

function redact(value, secretKeys, stack) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new RedactionError('cannot redact non-finite numbers');
    return value;
  }
  if (typeof value !== 'object') throw new RedactionError('cannot redact unsupported values');
  if (stack.has(value)) throw new RedactionError('cannot redact cyclic values');
  stack.add(value);
  try {
    if (Array.isArray(value)) return value.map(entry => redact(entry, secretKeys, stack));
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new RedactionError('cannot redact non-plain objects');
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      isSecretKey(key, secretKeys) ? REDACTED : redact(entry, secretKeys, stack),
    ]));
  } finally {
    stack.delete(value);
  }
}

export function redactSecrets(value, { secretKeys = DEFAULT_SECRET_KEYS } = {}) {
  if (!Array.isArray(secretKeys) || !secretKeys.every(key => typeof key === 'string' && key.length > 0)) {
    throw new RedactionError('secretKeys must be an array of non-empty strings');
  }
  return redact(value, secretKeys, new Set());
}

export function assertNoSecretCanaries(value, canaries) {
  if (!Array.isArray(canaries)) throw new RedactionError('canaries must be an array');
  const serialized = JSON.stringify(value);
  for (const canary of canaries) {
    if (typeof canary !== 'string' || canary.length === 0) continue;
    if (serialized.includes(canary)) {
      throw new RedactionError('secret canary survived redaction', 'SECRET_CANARY', { canary_index: canaries.indexOf(canary) });
    }
  }
  return true;
}

export function assertNoSecretMaterial(value, { secretKeys = DEFAULT_SECRET_KEYS } = {}) {
  const seen = new Set();
  function inspect(entry, path) {
    if (entry === null || typeof entry !== 'object') return;
    if (seen.has(entry)) throw new RedactionError('secret scan encountered a cycle');
    seen.add(entry);
    try {
      if (Array.isArray(entry)) {
        entry.forEach((item, index) => inspect(item, `${path}[${index}]`));
        return;
      }
      for (const [key, child] of Object.entries(entry)) {
        if (isSecretKey(key, secretKeys)) {
          const emptyPublicEnvironment = normalizedKey(key) === 'env'
            && child !== null
            && typeof child === 'object'
            && !Array.isArray(child)
            && Object.keys(child).length === 0;
          if (!emptyPublicEnvironment) {
            throw new RedactionError('secret-bearing material is not allowed', 'SECRET_MATERIAL', { path: `${path}.${key}` });
          }
        }
        inspect(child, `${path}.${key}`);
      }
    } finally {
      seen.delete(entry);
    }
  }
  inspect(value, '$');
  return true;
}
