import { win32 } from 'node:path';

import { CLIENT_IDS } from './client-contract.mjs';
import { sha256Canonical } from './canonical-json.mjs';

const LEDGER_SCHEMA_VERSION = '1.0';
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const CLIENT_PATHS = Object.freeze({
  claude: Object.freeze(['/type', '/command', '/args']),
  codex: Object.freeze(['/command', '/args']),
  gemini: Object.freeze(['/command', '/args']),
  vscode: Object.freeze(['/type', '/command', '/args']),
});

export class OwnershipLedgerError extends Error {
  constructor(message, code = 'OWNERSHIP_LEDGER_INVALID', details = {}) {
    super(message);
    this.name = 'OwnershipLedgerError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code = 'OWNERSHIP_LEDGER_INVALID', details = {}) {
  throw new OwnershipLedgerError(message, code, details);
}

function exactKeys(value, expected) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function normalizeLocation(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('ownership location is invalid', 'INVALID_OWNERSHIP_LOCATION');
  const clientId = input.clientId ?? input.client_id;
  const configPath = input.configPath ?? input.canonical_config_path;
  const scope = input.scope;
  const entryName = input.entryName ?? input.entry_name ?? 'uemcp';
  if (!CLIENT_IDS.includes(clientId)
    || typeof configPath !== 'string'
    || !win32.isAbsolute(configPath)
    || /^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(configPath)
    || typeof scope !== 'string'
    || scope.trim() === ''
    || typeof entryName !== 'string'
    || entryName.trim() === '') {
    fail('ownership location fields are invalid', 'INVALID_OWNERSHIP_LOCATION');
  }
  const canonicalPath = win32.normalize(configPath);
  return {
    client_id: clientId,
    canonical_config_path: canonicalPath,
    canonical_key_path: canonicalPath.toLowerCase(),
    scope,
    entry_name: entryName,
  };
}

export function ownershipKey(input) {
  const location = normalizeLocation(input);
  return sha256Canonical({
    client_id: location.client_id,
    canonical_config_path: location.canonical_key_path,
    scope: location.scope,
    entry_name: location.entry_name,
  });
}

function pointerParts(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path === '/') fail('owned path is invalid', 'INVALID_OWNED_PATHS');
  return path.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
}

function pointerValue(value, path) {
  let current = value;
  for (const part of pointerParts(path)) {
    if (current === null || typeof current !== 'object' || Array.isArray(current) || !Object.hasOwn(current, part)) {
      return { present: false, value: null };
    }
    current = current[part];
  }
  return { present: true, value: current };
}

function pointerHash(value, path) {
  return sha256Canonical(pointerValue(value, path));
}

function plainEntry(value, label) {
  if (!value || Array.isArray(value) || typeof value !== 'object') fail(`${label} must be a plain entry object`, 'INVALID_OWNERSHIP_ENTRY');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(`${label} must be a plain entry object`, 'INVALID_OWNERSHIP_ENTRY');
  return value;
}

export function ownedPathsForClient(clientId, physicalEntry) {
  if (!CLIENT_IDS.includes(clientId)) fail('client ID is unsupported', 'INVALID_OWNED_PATHS');
  plainEntry(physicalEntry, 'physical entry');
  const paths = CLIENT_PATHS[clientId];
  for (const path of paths) {
    const current = pointerValue(physicalEntry, path);
    if (!current.present || current.value === null || current.value === undefined) {
      fail(`required physical field is absent: ${path}`, 'INVALID_OWNED_PATHS');
    }
  }
  if (typeof physicalEntry.command !== 'string'
    || physicalEntry.command.trim() === ''
    || !win32.isAbsolute(physicalEntry.command)
    || !Array.isArray(physicalEntry.args)
    || !physicalEntry.args.every(value => typeof value === 'string')) {
    fail('physical command or args are invalid', 'INVALID_OWNED_PATHS');
  }
  if ((clientId === 'claude' || clientId === 'vscode') && physicalEntry.type !== 'stdio') {
    fail('physical transport type is invalid', 'INVALID_OWNED_PATHS');
  }
  return [...paths];
}

function normalizeOwnedPaths(clientId, afterEntry, ownedPaths) {
  const expected = ownedPathsForClient(clientId, afterEntry);
  if (!Array.isArray(ownedPaths)
    || new Set(ownedPaths).size !== ownedPaths.length
    || JSON.stringify(ownedPaths) !== JSON.stringify(expected)) {
    fail('owned paths differ from the adapter physical projection', 'INVALID_OWNED_PATHS');
  }
  return expected;
}

function environmentEvidence(entry) {
  const env = entry?.env;
  if (!env || Array.isArray(env) || typeof env !== 'object') return { keys: [], value_hashes: {} };
  const keys = Object.keys(env).sort();
  return {
    keys,
    value_hashes: Object.fromEntries(keys.map(key => [key, sha256Canonical(env[key])])),
  };
}

function ownedDiff(currentEntry, desiredEntry, ownedPaths) {
  const result = [];
  for (const path of ownedPaths) {
    const current = pointerValue(currentEntry, path);
    const desired = pointerValue(desiredEntry, path);
    if (sha256Canonical(current) === sha256Canonical(desired)) continue;
    result.push({
      path,
      current_present: current.present,
      desired_present: desired.present,
      ...(current.present ? { current_value: current.value } : {}),
      ...(desired.present ? { desired_value: desired.value } : {}),
    });
  }
  return result;
}

function escapedPointerPart(value) {
  return value.replace(/~/g, '~0').replace(/\//g, '~1');
}

function clientDiff(currentEntry, desiredEntry, ownedPaths) {
  const ownedRoots = new Set(ownedPaths.map(path => pointerParts(path)[0]));
  const result = [];
  const keys = [...new Set([...Object.keys(currentEntry), ...Object.keys(desiredEntry)])].sort();
  for (const key of keys) {
    if (ownedRoots.has(key)) continue;
    if (key === 'env'
      && (!currentEntry.env || (!Array.isArray(currentEntry.env) && typeof currentEntry.env === 'object'))
      && (!desiredEntry.env || (!Array.isArray(desiredEntry.env) && typeof desiredEntry.env === 'object'))) {
      const currentEnv = currentEntry.env ?? {};
      const desiredEnv = desiredEntry.env ?? {};
      const envKeys = [...new Set([...Object.keys(currentEnv), ...Object.keys(desiredEnv)])].sort();
      for (const envKey of envKeys) {
        const currentPresent = Object.hasOwn(currentEnv, envKey);
        const desiredPresent = Object.hasOwn(desiredEnv, envKey);
        const before = { present: currentPresent, value: currentPresent ? currentEnv[envKey] : null };
        const after = { present: desiredPresent, value: desiredPresent ? desiredEnv[envKey] : null };
        const beforeHash = sha256Canonical(before);
        const afterHash = sha256Canonical(after);
        if (beforeHash !== afterHash) {
          result.push({ path: `/env/${escapedPointerPart(envKey)}`, current_sha256: beforeHash, desired_sha256: afterHash });
        }
      }
      continue;
    }
    const before = { present: Object.hasOwn(currentEntry, key), value: currentEntry[key] ?? null };
    const after = { present: Object.hasOwn(desiredEntry, key), value: desiredEntry[key] ?? null };
    const beforeHash = sha256Canonical(before);
    const afterHash = sha256Canonical(after);
    if (beforeHash !== afterHash) result.push({ path: `/${escapedPointerPart(key)}`, current_sha256: beforeHash, desired_sha256: afterHash });
  }
  return result;
}

function ledgerPayload(records) {
  return { schema_version: LEDGER_SCHEMA_VERSION, records };
}

function ledgerDocument(records) {
  const payload = ledgerPayload(records);
  return { ...payload, self_hash: sha256Canonical(payload) };
}

function validRecord(record) {
  if (!exactKeys(record, [
    'client_id',
    'canonical_config_path',
    'scope',
    'entry_name',
    'owned_paths',
    'value_hashes',
    'applied_config_sha256',
    'plan_digest',
    'written_at',
  ])) return false;
  if (!CLIENT_IDS.includes(record.client_id)
    || typeof record.canonical_config_path !== 'string'
    || !win32.isAbsolute(record.canonical_config_path)
    || typeof record.scope !== 'string'
    || record.scope === ''
    || typeof record.entry_name !== 'string'
    || record.entry_name === ''
    || !Array.isArray(record.owned_paths)
    || new Set(record.owned_paths).size !== record.owned_paths.length
    || !exactKeys(record.value_hashes, record.owned_paths)
    || !record.owned_paths.every(path => typeof path === 'string' && SHA256_PATTERN.test(record.value_hashes[path]))
    || !SHA256_PATTERN.test(record.applied_config_sha256)
    || !SHA256_PATTERN.test(record.plan_digest)
    || typeof record.written_at !== 'string'
    || !Number.isFinite(Date.parse(record.written_at))) return false;
  return true;
}

function parseLedger(raw) {
  if (raw === null || raw === undefined) return { status: 'absent', document: ledgerDocument({}) };
  let document = raw;
  try {
    if (Buffer.isBuffer(document) || document instanceof Uint8Array) document = new TextDecoder('utf-8', { fatal: true }).decode(document);
    if (typeof document === 'string') document = JSON.parse(document);
  } catch {
    return { status: 'invalid', reason: 'ledger_parse_failed' };
  }
  if (!exactKeys(document, ['schema_version', 'records', 'self_hash'])
    || document.schema_version !== LEDGER_SCHEMA_VERSION
    || !document.records
    || Array.isArray(document.records)
    || typeof document.records !== 'object'
    || !SHA256_PATTERN.test(document.self_hash)) {
    return { status: 'invalid', reason: 'ledger_schema_invalid' };
  }
  const payload = ledgerPayload(document.records);
  if (sha256Canonical(payload) !== document.self_hash) return { status: 'invalid', reason: 'ledger_self_hash_mismatch' };
  for (const [key, record] of Object.entries(document.records)) {
    if (!SHA256_PATTERN.test(key) || !validRecord(record)) return { status: 'invalid', reason: 'ledger_record_invalid' };
  }
  return { status: 'valid', document };
}

async function readLedger(ledger) {
  if (!ledger || typeof ledger.read !== 'function') return { status: 'invalid', reason: 'ledger_storage_invalid' };
  try {
    return parseLedger(await ledger.read());
  } catch {
    return { status: 'invalid', reason: 'ledger_read_failed' };
  }
}

function recordMatchesLocation(record, location, key, ownedPaths) {
  return record.client_id === location.client_id
    && record.canonical_config_path.toLowerCase() === location.canonical_key_path
    && record.scope === location.scope
    && record.entry_name === location.entry_name
    && ownershipKey(location) === key
    && JSON.stringify(record.owned_paths) === JSON.stringify(ownedPaths);
}

function actionFor(state, differences) {
  if (state === 'owned_matching') return differences.length === 0 ? 'NO_OP' : 'UPDATE_OWNED_FIELDS';
  return differences.length === 0 ? 'ADOPT_EXACT_ENTRY' : 'CONFLICT';
}

export async function inspectOwnership({ ledger, currentEntry, desiredEntry, location: inputLocation }) {
  plainEntry(currentEntry, 'current entry');
  plainEntry(desiredEntry, 'desired entry');
  const location = normalizeLocation(inputLocation);
  const key = ownershipKey(location);
  const paths = ownedPathsForClient(location.client_id, desiredEntry);
  const differences = ownedDiff(currentEntry, desiredEntry, paths);
  const common = {
    ownership_key: key,
    owned_paths: paths,
    owned_diff: differences,
    client_diff: clientDiff(currentEntry, desiredEntry, paths),
    environment: environmentEvidence(currentEntry),
  };
  const loaded = await readLedger(ledger);
  if (loaded.status === 'invalid') {
    return { ...common, state: 'stale_record', recommended_action: actionFor('stale_record', differences), stale_reason: loaded.reason };
  }
  const record = loaded.document.records[key];
  if (!record) return { ...common, state: 'unowned', recommended_action: actionFor('unowned', differences) };
  if (!recordMatchesLocation(record, location, key, paths)) {
    return { ...common, state: 'stale_record', recommended_action: actionFor('stale_record', differences), stale_reason: 'record_identity_mismatch' };
  }
  const currentHashes = Object.fromEntries(paths.map(path => [path, pointerHash(currentEntry, path)]));
  const currentMatchesRecord = paths.every(path => currentHashes[path] === record.value_hashes[path]);
  const state = currentMatchesRecord ? 'owned_matching' : 'owned_user_modified';
  return { ...common, state, recommended_action: actionFor(state, differences) };
}

function writtenAt(ledger) {
  const value = typeof ledger?.now === 'function' ? ledger.now() : Date.now();
  const parsed = typeof value === 'string' ? Date.parse(value) : Number(value);
  if (!Number.isFinite(parsed)) fail('ownership ledger clock is invalid');
  return new Date(parsed).toISOString();
}

export async function recordOwnedWrite({
  ledger,
  location: inputLocation,
  beforeEntry,
  afterEntry,
  ownedPaths,
  appliedConfigHash,
  planDigest,
}) {
  if (beforeEntry !== null && beforeEntry !== undefined) plainEntry(beforeEntry, 'before entry');
  plainEntry(afterEntry, 'after entry');
  const location = normalizeLocation(inputLocation);
  const paths = normalizeOwnedPaths(location.client_id, afterEntry, ownedPaths);
  if (!SHA256_PATTERN.test(appliedConfigHash) || !SHA256_PATTERN.test(planDigest)) fail('ownership write hashes are invalid', 'INVALID_OWNERSHIP_EVIDENCE');
  const loaded = await readLedger(ledger);
  if (loaded.status === 'invalid') fail('ownership ledger is invalid and cannot be overwritten');
  if (typeof ledger.write !== 'function') fail('ownership ledger storage is not writable');
  const key = ownershipKey(location);
  const record = {
    client_id: location.client_id,
    canonical_config_path: location.canonical_config_path,
    scope: location.scope,
    entry_name: location.entry_name,
    owned_paths: paths,
    value_hashes: Object.fromEntries(paths.map(path => [path, pointerHash(afterEntry, path)])),
    applied_config_sha256: appliedConfigHash,
    plan_digest: planDigest,
    written_at: writtenAt(ledger),
  };
  const records = { ...loaded.document.records, [key]: record };
  await ledger.write(ledgerDocument(records));
  return { ownership_key: key, record, environment: environmentEvidence(afterEntry) };
}

export async function adoptExactEntry({
  ledger,
  location,
  currentEntry,
  desiredEntry,
  approvedOperationId,
}) {
  plainEntry(currentEntry, 'current entry');
  plainEntry(desiredEntry, 'desired entry');
  const normalized = normalizeLocation(location);
  const operation = approvedOperationId;
  const paths = ownedPathsForClient(normalized.client_id, desiredEntry);
  const differences = ownedDiff(currentEntry, desiredEntry, paths);
  if (!operation
    || typeof operation !== 'object'
    || Array.isArray(operation)
    || !exactKeys(operation, [
      'operation_id',
      'type',
      'ownership_key',
      'current_entry_sha256',
      'current_config_sha256',
      'plan_digest',
    ])
    || typeof operation.operation_id !== 'string'
    || operation.operation_id.trim() === ''
    || operation.type !== 'ADOPT_EXACT_ENTRY'
    || operation.ownership_key !== ownershipKey(normalized)
    || operation.current_entry_sha256 !== sha256Canonical(currentEntry)
    || !SHA256_PATTERN.test(operation.current_config_sha256)
    || !SHA256_PATTERN.test(operation.plan_digest)
    || differences.length !== 0) {
    fail('adoption approval or current-entry precondition failed', 'ADOPTION_PRECONDITION_FAILED');
  }
  const recorded = await recordOwnedWrite({
    ledger,
    location: normalized,
    beforeEntry: currentEntry,
    afterEntry: currentEntry,
    ownedPaths: paths,
    appliedConfigHash: operation.current_config_sha256,
    planDigest: operation.plan_digest,
  });
  return {
    status: 'adopted',
    operation_id: operation.operation_id,
    operation_type: operation.type,
    ownership_key: recorded.ownership_key,
    current_entry_sha256: operation.current_entry_sha256,
    plan_digest: operation.plan_digest,
    provider_config_written: false,
    environment: recorded.environment,
  };
}

export function deduplicateOwnershipLocations(locations) {
  if (!Array.isArray(locations)) fail('ownership locations must be an array', 'INVALID_OWNERSHIP_LOCATION');
  const rows = new Map();
  for (const input of locations) {
    const location = normalizeLocation(input);
    const key = ownershipKey(location);
    const requested = input.requestedContexts ?? input.requested_contexts ?? [];
    if (!Array.isArray(requested) || !requested.every(value => typeof value === 'string' && value.trim() !== '')) {
      fail('requested ownership contexts are invalid', 'INVALID_OWNERSHIP_LOCATION');
    }
    if (!rows.has(key)) {
      rows.set(key, {
        ownership_key: key,
        client_id: location.client_id,
        canonical_config_path: location.canonical_config_path,
        scope: location.scope,
        entry_name: location.entry_name,
        requested_contexts: [],
      });
    }
    const row = rows.get(key);
    row.requested_contexts = [...new Set([...row.requested_contexts, ...requested])].sort();
  }
  return [...rows.values()];
}
