import { CLIENT_IDS } from './client-contract.mjs';
import { resolveClientLaunch } from './client-process.mjs';

export class ClientDiscoveryError extends Error {
  constructor(message, code = 'CLIENT_DISCOVERY_FAILED', details = {}) {
    super(message);
    this.name = 'ClientDiscoveryError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code = 'CLIENT_DISCOVERY_FAILED', details = {}) {
  throw new ClientDiscoveryError(message, code, details);
}

function safeErrorCode(error) {
  const code = error?.code;
  return typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'CLIENT_DISCOVERY_FAILED';
}

function absentRow(clientId, errorCode = 'NOT_INSTALLED') {
  return Object.freeze({
    client_id: clientId,
    version: null,
    compatibility: 'not_installed',
    write_supported: false,
    launch: null,
    discovery_status: errorCode,
  });
}

function failedRow(clientId, errorCode) {
  return Object.freeze({
    client_id: clientId,
    version: null,
    compatibility: 'known_unsupported',
    write_supported: false,
    launch: null,
    discovery_status: errorCode,
  });
}

function normalizeResolved(clientId, launch) {
  if (!launch || launch.client_id !== clientId
    || typeof launch.version !== 'string' || launch.version.trim() === ''
    || !['release_gated', 'known_unsupported', 'unknown_newer'].includes(launch.compatibility)
    || typeof launch.write_supported !== 'boolean'
    || launch.write_supported !== (launch.compatibility === 'release_gated')) {
    fail('client resolver returned an invalid launch row');
  }
  return Object.freeze({
    client_id: clientId,
    version: launch.version,
    compatibility: launch.compatibility,
    write_supported: launch.write_supported,
    launch,
    discovery_status: 'DETECTED',
  });
}

function resolverFor(clientId, resolvers) {
  if (resolvers === null || resolvers === undefined) {
    return options => resolveClientLaunch(clientId, options);
  }
  if (!resolvers || typeof resolvers !== 'object' || Array.isArray(resolvers)) {
    fail('client resolvers must be an object');
  }
  const resolver = resolvers[clientId];
  if (typeof resolver !== 'function') fail('client resolver set is incomplete');
  return resolver;
}

export async function discoverClients({
  env = process.env,
  workspaceRoot,
  requestedProfile = null,
  resolvers = null,
  fsImpl,
  runner,
} = {}) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) fail('client discovery environment is invalid');
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') fail('client discovery workspace is invalid');
  if (requestedProfile !== null && (typeof requestedProfile !== 'string' || requestedProfile.trim() === '')) {
    fail('requested client profile is invalid');
  }
  const rows = [];
  for (const clientId of CLIENT_IDS) {
    let launch;
    try {
      launch = await resolverFor(clientId, resolvers)({
        clientId,
        env,
        workspaceRoot,
        requestedProfile,
        ...(fsImpl ? { fsImpl } : {}),
        ...(runner ? { runner } : {}),
      });
    } catch (error) {
      const hasStableCode = typeof error?.code === 'string' && /^[A-Z0-9_]+$/.test(error.code);
      if (!hasStableCode) {
        fail('client resolver failed unexpectedly', 'CLIENT_DISCOVERY_FAILED', { client_id: clientId });
      }
      const code = safeErrorCode(error);
      if (code === 'NOT_INSTALLED') rows.push(absentRow(clientId));
      else if (['VERSION_PROBE_FAILED', 'CLIENT_DISCOVERY_FAILED', 'AMBIGUOUS_CLIENT_ENVIRONMENT', 'INSPECTION_LIMIT_EXCEEDED'].includes(code)) {
        rows.push(failedRow(clientId, code));
      } else {
        fail('client resolver returned an unsupported failure', 'CLIENT_DISCOVERY_FAILED', { client_id: clientId, resolver_code: code });
      }
      continue;
    }
    rows.push(normalizeResolved(clientId, launch));
  }
  return Object.freeze(rows);
}

function normalizeSelectionIds(values, label) {
  if (!Array.isArray(values)) fail(`${label} must be an array`, 'INVALID_CLIENT_SELECTION');
  if (new Set(values).size !== values.length
    || values.some(value => typeof value !== 'string' || !CLIENT_IDS.includes(value))) {
    fail(`${label} contains an invalid client ID`, 'INVALID_CLIENT_SELECTION');
  }
  return values;
}

function normalizeDiscovered(discovered) {
  if (!Array.isArray(discovered)) fail('discovered clients must be an array', 'INVALID_CLIENT_SELECTION');
  const known = new Map();
  for (const row of discovered) {
    if (!row || typeof row !== 'object' || !CLIENT_IDS.includes(row.client_id)) continue;
    if (known.has(row.client_id)) fail('discovered client IDs must be unique', 'INVALID_CLIENT_SELECTION');
    known.set(row.client_id, row);
  }
  return CLIENT_IDS.map(clientId => known.get(clientId) ?? absentRow(clientId));
}

export function selectClients(discovered, { include = [], exclude = [] } = {}) {
  const includeIds = normalizeSelectionIds(include, 'include');
  const excludeIds = normalizeSelectionIds(exclude, 'exclude');
  const excluded = new Set(excludeIds);
  if (includeIds.some(clientId => excluded.has(clientId))) {
    fail('include and exclude client IDs overlap', 'INVALID_CLIENT_SELECTION');
  }
  const included = new Set(includeIds);
  const exactInclude = includeIds.length > 0;
  return Object.freeze(normalizeDiscovered(discovered).map(row => {
    const installed = row.compatibility !== 'not_installed';
    const explicitlyExcluded = excluded.has(row.client_id) || (exactInclude && !included.has(row.client_id));
    const selected = installed && !explicitlyExcluded
      && (included.has(row.client_id) || (!exactInclude && row.compatibility === 'release_gated'));
    let status = 'UNKNOWN';
    let enablement = 'UNKNOWN';
    let activation = 'UNKNOWN';
    let selectionReason = selected ? (included.has(row.client_id) ? 'included' : 'default') : 'inspect_only';
    if (!installed && explicitlyExcluded) {
      status = 'NOT_SELECTED';
      enablement = 'NOT_SELECTED';
      activation = 'NOT_SELECTED';
      selectionReason = excluded.has(row.client_id) ? 'excluded' : 'not_included';
    } else if (!installed) {
      status = 'NOT_INSTALLED';
      enablement = 'NOT_INSTALLED';
      activation = 'NOT_INSTALLED';
      selectionReason = included.has(row.client_id) ? 'included_not_installed' : 'not_installed';
    } else if (explicitlyExcluded) {
      status = 'NOT_SELECTED';
      enablement = 'NOT_SELECTED';
      activation = 'NOT_SELECTED';
      selectionReason = excluded.has(row.client_id) ? 'excluded' : 'not_included';
    }
    return Object.freeze({
      ...row,
      selected,
      status,
      enablement,
      activation,
      selection_reason: selectionReason,
    });
  }));
}
