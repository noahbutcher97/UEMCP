import { isAbsolute, posix, win32 } from 'node:path';

import { canonicalJson, sha256Canonical } from './canonical-json.mjs';
import { CLIENT_DISCOVERY_FAILURE_CODES } from './client-contract.mjs';
import {
  DEPLOYMENT_SCHEMA_VERSION,
  OUTCOMES,
  PLAN_TTL_MS,
  validateActionContract,
  validateClientContract,
  validateDescriptorContract,
  validateRequestContract,
  validateSourceContract,
  validateStageContract,
} from './contracts.mjs';
import { assertNoSecretMaterial } from './redaction.mjs';

const PLAN_KEYS = new Set([
  'schema_version',
  'kind',
  'operation',
  'outcome',
  'created_at',
  'expires_at',
  'source',
  'request',
  'descriptor',
  'stages',
  'clients',
  'operations',
  'preconditions',
  'actions',
  'digest',
]);
const DOMAIN_ORDERS = Object.freeze({ prerequisites: 10, target: 20, clients: 30, plugin: 40 });
const SHA256 = /^[0-9a-f]{64}$/;

export class DeploymentPlanError extends Error {
  constructor(message, code = 'INVALID_PLAN', details = {}) {
    super(message);
    this.name = 'DeploymentPlanError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code, details) {
  throw new DeploymentPlanError(message, code, details);
}

function absolutePath(value) {
  return typeof value === 'string' && (isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value));
}

function cloneCanonical(value) {
  return JSON.parse(canonicalJson(value));
}

function isoTime(value, label) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) fail(`${label} is invalid`, 'INVALID_PLAN');
  return date.toISOString();
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`, 'INVALID_PLAN');
  const actual = Object.keys(value);
  const missing = [...keys].filter(key => !Object.hasOwn(value, key));
  const unknown = actual.filter(key => !keys.has(key));
  if (missing.length || unknown.length) fail(`${label} has invalid keys`, 'INVALID_PLAN', { missing, unknown });
}

function validateOperation(operation) {
  if (operation === null || typeof operation !== 'object' || Array.isArray(operation)) fail('plan operation must be an object', 'INVALID_PLAN');
  if (typeof operation.operation_id !== 'string' || operation.operation_id.trim() === '') fail('plan operation ID is invalid', 'INVALID_PLAN');
  if (!Object.hasOwn(DOMAIN_ORDERS, operation.domain) || operation.domain_order !== DOMAIN_ORDERS[operation.domain]) {
    fail('plan operation domain/order is invalid', 'INVALID_PLAN');
  }
  if (typeof operation.kind !== 'string' || operation.kind.trim() === '') fail('plan operation kind is invalid', 'INVALID_PLAN');
  assertNoSecretMaterial(operation);
  return cloneCanonical(operation);
}

function validatePrecondition(precondition) {
  if (precondition === null || typeof precondition !== 'object' || Array.isArray(precondition)) {
    fail('plan precondition must be an object', 'INVALID_PLAN');
  }
  if (typeof precondition.kind !== 'string' || precondition.kind.trim() === '') fail('plan precondition kind is invalid', 'INVALID_PLAN');
  if (typeof precondition.label !== 'string' || precondition.label.trim() === '') fail('plan precondition label is invalid', 'INVALID_PLAN');
  if (!absolutePath(precondition.canonical_path)) fail('plan precondition path must be absolute', 'INVALID_PLAN');
  assertNoSecretMaterial(precondition);
  return cloneCanonical(precondition);
}

function sortOperations(operations) {
  return operations.map(validateOperation).sort((left, right) =>
    left.domain_order - right.domain_order
      || (left.operation_id < right.operation_id ? -1 : left.operation_id > right.operation_id ? 1 : 0));
}

function sortPreconditions(preconditions) {
  return preconditions.map(validatePrecondition).sort((left, right) => {
    for (const key of ['kind', 'canonical_path', 'label']) {
      if (left[key] < right[key]) return -1;
      if (left[key] > right[key]) return 1;
    }
    return 0;
  });
}

function validatePlanDocument(plan) {
  exactKeys(plan, PLAN_KEYS, 'plan');
  if (plan.schema_version !== DEPLOYMENT_SCHEMA_VERSION || plan.kind !== 'uemcp.deployment.plan') {
    fail('plan interface is unsupported', 'UNSUPPORTED_INTERFACE');
  }
  if (!['setup', 'sync', 'repair'].includes(plan.operation)) fail('plan operation is invalid', 'INVALID_PLAN');
  if (!Object.values(OUTCOMES).includes(plan.outcome)) fail('plan outcome is invalid', 'INVALID_PLAN');
  const created = isoTime(plan.created_at, 'plan.created_at');
  const expires = isoTime(plan.expires_at, 'plan.expires_at');
  if (Date.parse(expires) <= Date.parse(created)) fail('plan expiry must be after creation', 'INVALID_PLAN');
  validateSourceContract(plan.source);
  const request = validateRequestContract(plan.request);
  validateDescriptorContract(plan.descriptor);
  if (!Array.isArray(plan.stages) || plan.stages.length === 0) fail('plan stages must be non-empty', 'INVALID_PLAN');
  plan.stages.forEach(validateStageContract);
  if (!Array.isArray(plan.clients)) fail('plan clients must be an array', 'INVALID_PLAN');
  const clients = plan.clients.map(validateClientContract);
  if (!Array.isArray(plan.operations) || !Array.isArray(plan.preconditions) || !Array.isArray(plan.actions)) {
    fail('plan operations, preconditions, and actions must be arrays', 'INVALID_PLAN');
  }
  const operations = plan.operations.map(validateOperation);
  const preconditions = plan.preconditions.map(validatePrecondition);
  plan.actions.forEach(validateActionContract);
  if (!SHA256.test(plan.digest)) fail('plan digest must be lowercase SHA-256', 'INVALID_PLAN');
  if (new Set(operations.map(row => row.operation_id)).size !== operations.length) fail('plan operation IDs must be unique', 'INVALID_PLAN');
  if (new Set(preconditions.map(row => row.label)).size !== preconditions.length) fail('plan precondition labels must be unique', 'INVALID_PLAN');
  const clientByAdapter = new Map(clients.map(client => [client.adapter, client]));
  const clientStage = plan.stages.find(stage => stage.name === 'clients');
  const rawClientEvidence = clientStage?.evidence?.clients ?? [];
  if (!Array.isArray(rawClientEvidence)) fail('plan client evidence must be an array', 'INVALID_PLAN');
  if (rawClientEvidence.some(row => row === null
    || typeof row !== 'object'
    || Array.isArray(row)
    || typeof row.adapter !== 'string'
    || !Array.isArray(row.touched_paths))) {
    fail('plan client evidence rows are malformed', 'INVALID_PLAN');
  }
  const clientEvidenceRows = rawClientEvidence;
  const clientEvidence = new Map(clientEvidenceRows.map(row => [row.adapter, row]));
  if (clientByAdapter.size !== clients.length || clientEvidence.size !== clientEvidenceRows.length) {
    fail('plan client rows and evidence must use unique adapter IDs', 'INVALID_PLAN');
  }
  const probeFailureCodes = new Set(CLIENT_DISCOVERY_FAILURE_CODES);
  for (const adapter of request.selected_clients) {
    const client = clientByAdapter.get(adapter);
    const evidence = clientEvidence.get(adapter);
    const detectedSelection = client?.selected === true
      && typeof client.version === 'string'
      && client.version.trim() !== '';
    const requestedAbsence = client?.selected === false
      && client.version === null
      && client.compatibility === 'not_installed'
      && client.status === 'NOT_INSTALLED'
      && evidence?.discovery_status === 'NOT_INSTALLED'
      && evidence?.selection === 'included_not_installed'
      && evidence?.launch_contract === null;
    const requestedProbeFailure = client?.selected === true
      && client.version === null
      && client.compatibility === 'known_unsupported'
      && client.status === 'UNKNOWN'
      && probeFailureCodes.has(evidence?.discovery_status)
      && evidence?.selection === 'included'
      && evidence?.launch_contract === null;
    if (!client || client.scope.trim() === '' || (!detectedSelection && !requestedAbsence && !requestedProbeFailure)) {
      fail('requested client lacks valid detection or absence evidence', 'INVALID_PLAN', { adapter });
    }
  }
  const clientOperations = operations.filter(operation => operation.domain === 'clients');
  const operationPaths = new Map();
  for (const operation of clientOperations) {
    const client = clientByAdapter.get(operation.client_id);
    const evidence = clientEvidence.get(operation.client_id);
    if (operation.kind !== 'CLIENT_CONFIG_WRITE'
      || operation.selected !== true
      || operation.write_supported !== true
      || !client
      || client.selected !== true
      || client.compatibility !== 'release_gated'
      || client.write_supported !== true
      || typeof client.version !== 'string'
      || !evidence
      || evidence.selected !== true
      || evidence.launch_contract === null
      || ['MALFORMED_CONFIG', 'INSPECTION_LIMIT_EXCEEDED', 'UNSAFE_CONFIG_PATH'].includes(evidence.structural_status)
      || !absolutePath(operation.path)) {
      fail('client operation lacks a selected release-gated authorization row', 'INVALID_PLAN', { client_id: operation.client_id ?? null });
    }
    const paths = operationPaths.get(operation.client_id) ?? [];
    paths.push(operation.path);
    operationPaths.set(operation.client_id, paths);
  }
  for (const [adapter, evidence] of clientEvidence) {
    const plannedPaths = [...new Set(operationPaths.get(adapter) ?? [])].sort();
    const evidencePaths = Array.isArray(evidence.touched_paths)
      ? [...new Set(evidence.touched_paths.filter(absolutePath))].sort()
      : [];
    if (plannedPaths.length !== (operationPaths.get(adapter) ?? []).length
      || evidencePaths.length !== (evidence.touched_paths ?? []).length
      || canonicalJson(plannedPaths) !== canonicalJson(evidencePaths)) {
      fail('client operations do not match their reviewed touched-path evidence', 'INVALID_PLAN', { adapter });
    }
    if (plannedPaths.length > 0 && ['INSPECT_ONLY', 'NO_OP'].includes(evidence.operation)) {
      fail('client write operation is inconsistent with inspect-only evidence', 'INVALID_PLAN', { adapter });
    }
  }
  assertNoSecretMaterial(plan);
  return true;
}

function validatePlanStructure(plan) {
  exactKeys(plan, PLAN_KEYS, 'plan');
  if (plan.schema_version !== DEPLOYMENT_SCHEMA_VERSION || plan.kind !== 'uemcp.deployment.plan') {
    fail('plan interface is unsupported', 'UNSUPPORTED_INTERFACE');
  }
  if (!SHA256.test(plan.digest ?? '')) fail('plan digest must be lowercase SHA-256', 'INVALID_PLAN');
  canonicalJson(plan);
}

export function computePlanDigest(planWithoutDigest) {
  if (planWithoutDigest === null || typeof planWithoutDigest !== 'object' || Array.isArray(planWithoutDigest)) {
    fail('plan digest input must be an object', 'INVALID_PLAN');
  }
  const body = { ...planWithoutDigest };
  delete body.digest;
  return sha256Canonical(body);
}

export function createPlanDocument({
  operation,
  outcome,
  source,
  request,
  descriptor,
  stages,
  preconditions,
  operations,
  clients = [],
  actions = [],
  now = new Date(),
  ttlMs = PLAN_TTL_MS,
}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) fail('plan TTL must be a positive integer', 'INVALID_PLAN');
  const createdAt = isoTime(now, 'plan creation time');
  const expiresAt = new Date(Date.parse(createdAt) + ttlMs).toISOString();
  const body = {
    schema_version: DEPLOYMENT_SCHEMA_VERSION,
    kind: 'uemcp.deployment.plan',
    operation,
    outcome,
    created_at: createdAt,
    expires_at: expiresAt,
    source: validateSourceContract(source),
    request: validateRequestContract(request),
    descriptor: validateDescriptorContract(descriptor),
    stages: stages.map(validateStageContract),
    clients: clients.map(validateClientContract),
    operations: sortOperations(operations),
    preconditions: sortPreconditions(preconditions),
    actions: actions.map(validateActionContract),
  };
  assertNoSecretMaterial(body);
  const plan = { ...body, digest: computePlanDigest(body) };
  validatePlanDocument(plan);
  return plan;
}

export function validatePlanEnvelope({ plan, approvedDigest, now = new Date() }) {
  validatePlanStructure(plan);
  const computed = computePlanDigest(plan);
  if (computed !== plan.digest || !SHA256.test(approvedDigest) || approvedDigest !== plan.digest) {
    fail('plan digest does not match stored and approved bytes', 'PLAN_DIGEST_MISMATCH');
  }
  const observedNow = Date.parse(isoTime(now, 'validation time'));
  if (observedNow >= Date.parse(plan.expires_at)) fail('plan has expired', 'PLAN_EXPIRED');
  validatePlanDocument(plan);
  return true;
}

export async function validatePlanForApply({
  plan,
  approvedDigest,
  now = new Date(),
  fingerprint = null,
  localState = null,
}) {
  validatePlanEnvelope({ plan, approvedDigest, now });
  if (localState?.wasDigestApplied && await localState.wasDigestApplied(plan.digest)) {
    fail('plan digest was already applied', 'PLAN_REPLAYED');
  }
  const failures = [];
  for (const precondition of plan.preconditions) {
    if (typeof fingerprint !== 'function') {
      failures.push({ label: precondition.label, reason: 'fingerprint_unavailable' });
      continue;
    }
    let observed;
    try {
      observed = await fingerprint(precondition);
    } catch (error) {
      failures.push({ label: precondition.label, reason: error?.code ?? 'fingerprint_failed' });
      continue;
    }
    if (precondition.fingerprint && sha256Canonical(observed?.fingerprint ?? observed) !== sha256Canonical(precondition.fingerprint)) {
      failures.push({ label: precondition.label, reason: 'fingerprint_changed' });
      continue;
    }
    if (precondition.sha256 && observed?.sha256 !== precondition.sha256) {
      failures.push({ label: precondition.label, reason: 'content_changed' });
      continue;
    }
    if (precondition.version && observed?.version !== precondition.version) {
      failures.push({ label: precondition.label, reason: 'version_changed' });
    }
  }
  if (failures.length > 0) fail('one or more plan preconditions changed', 'PLAN_STALE', { failures });
  return { ok: true, plan: cloneCanonical(plan) };
}

export function validatePlanDocumentContract(plan) {
  return validatePlanDocument(plan);
}
