import { isAbsolute, posix, win32 } from 'node:path';

import { canonicalJson, sha256Canonical } from './canonical-json.mjs';
import {
  CLIENT_DISCOVERY_FAILURE_CODES,
  CLIENT_IDS,
  validatePublicClientLaunchContract,
} from './client-contract.mjs';
import {
  CLIENT_STATE_VALUES,
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
const CLIENT_STAGE_EVIDENCE_KEYS = new Set(['vscode_profile', 'discovery_context_sha256', 'clients']);
const CLIENT_EVIDENCE_KEYS = new Set([
  'adapter',
  'selected',
  'selection',
  'discovery_status',
  'launch_contract',
  'current_scopes',
  'effective_scope',
  'operation',
  'touched_paths',
  'owned_diffs',
  'environment',
  'custom_working_directory',
  'structural_status',
  'native_status',
  'protocol_status',
  'instruction_bytes',
  'tool_count',
  'initial_tool_names',
  'duration_ms',
  'enablement',
  'activation',
]);
const CLIENT_SELECTION_VALUES = new Set([
  'included',
  'default',
  'inspect_only',
  'excluded',
  'not_included',
  'included_not_installed',
  'not_installed',
]);
const CLIENT_SELECTED_SELECTION_VALUES = new Set(['included', 'default']);
const CLIENT_NOT_INSTALLED_SELECTION_VALUES = new Set([
  'included_not_installed',
  'not_installed',
  'excluded',
  'not_included',
]);
const CLIENT_DISCOVERY_STATUS_VALUES = new Set([
  'DETECTED',
  'NOT_INSTALLED',
  ...CLIENT_DISCOVERY_FAILURE_CODES,
]);
const CLIENT_OPERATION_VALUES = new Set([
  'INSPECT_ONLY',
  'MALFORMED_CONFIG',
  'INSPECTION_LIMIT_EXCEEDED',
  'UNSAFE_CONFIG_PATH',
  'UNSUPPORTED_VERSION',
  'OWNERSHIP_LEDGER_INVALID',
  'POLICY_UNKNOWN',
  'POLICY_BLOCKED',
  'CONFLICT',
  'READ_ONLY_TARGET',
  'UNSAFE_WRITABLE_PATH',
  'PATH_OUTSIDE_WRITABLE_ROOT',
  'METADATA_INSPECTION_FAILED',
  'ADOPT',
  'NO_OP',
  'CREATE',
  'UPDATE',
  'MIGRATE',
]);
const CLIENT_NATIVE_STATUS_VALUES = new Set([
  'UNKNOWN',
  'NOT_CHECKED',
  'ABSENT',
  'TIMEOUT',
  'FAILED',
  'REJECTED',
  'PENDING_APPROVAL',
  'CONNECTED',
  'PRESENT',
  'AMBIGUOUS',
  'INCONSISTENT',
  'DISCONNECTED',
  'DISABLED',
  'BLOCKED',
]);
const CLIENT_PROTOCOL_STATUS_VALUES = new Set(['UNKNOWN', 'HEALTHY', 'INITIALIZE_FAILED', 'TOOLS_LIST_FAILED']);

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

function pathIdentity(value) {
  return /^(?:[a-z]:[\\/]|\\\\)/i.test(value)
    ? win32.resolve(value).toLowerCase()
    : posix.resolve(value);
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

function exactOptionalKeys(value, required, optional, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`, 'INVALID_PLAN');
  const allowed = new Set([...required, ...optional]);
  const missing = [...required].filter(key => !Object.hasOwn(value, key));
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (missing.length || unknown.length) fail(`${label} has invalid keys`, 'INVALID_PLAN', { missing, unknown });
}

function uniqueStrings(values, label, { absolute = false } = {}) {
  if (!Array.isArray(values)
    || values.some(value => typeof value !== 'string' || value.trim() === '' || (absolute && !absolutePath(value)))
    || new Set(values).size !== values.length) {
    fail(`${label} must contain unique valid strings`, 'INVALID_PLAN');
  }
}

function validateOwnedDiffRows(rows, label) {
  if (!Array.isArray(rows)) fail(`${label} must be an array`, 'INVALID_PLAN');
  for (const [index, row] of rows.entries()) {
    const rowLabel = `${label}[${index}]`;
    exactOptionalKeys(
      row,
      new Set(['path', 'current_present', 'desired_present']),
      new Set(['current_sha256', 'desired_sha256']),
      rowLabel,
    );
    if (typeof row.path !== 'string' || row.path.trim() === ''
      || typeof row.current_present !== 'boolean'
      || typeof row.desired_present !== 'boolean'
      || Object.hasOwn(row, 'current_sha256') !== row.current_present
      || Object.hasOwn(row, 'desired_sha256') !== row.desired_present
      || ['current_sha256', 'desired_sha256'].some(key => Object.hasOwn(row, key) && !SHA256.test(row[key]))) {
      fail(`${rowLabel} is invalid`, 'INVALID_PLAN');
    }
  }
}

function validateEnvironmentRows(rows, label) {
  if (!Array.isArray(rows)) fail(`${label} must be an array`, 'INVALID_PLAN');
  const identities = new Set();
  for (const [index, row] of rows.entries()) {
    exactKeys(row, new Set(['name', 'value_sha256']), `${label}[${index}]`);
    if (typeof row.name !== 'string' || row.name.trim() === '' || !SHA256.test(row.value_sha256)) {
      fail(`${label}[${index}] is invalid`, 'INVALID_PLAN');
    }
    const identity = `${row.name}\0${row.value_sha256}`;
    if (identities.has(identity)) fail(`${label} contains duplicate rows`, 'INVALID_PLAN');
    identities.add(identity);
  }
}

function validateClientEvidenceRow(row, client, label) {
  exactKeys(row, CLIENT_EVIDENCE_KEYS, label);
  if (!CLIENT_IDS.includes(row.adapter)
    || typeof row.selected !== 'boolean'
    || !CLIENT_SELECTION_VALUES.has(row.selection)
    || !CLIENT_DISCOVERY_STATUS_VALUES.has(row.discovery_status)
    || !CLIENT_OPERATION_VALUES.has(row.operation)
    || typeof row.custom_working_directory !== 'boolean'
    || !CLIENT_STATE_VALUES.status.includes(row.structural_status)
    || !CLIENT_NATIVE_STATUS_VALUES.has(row.native_status)
    || !CLIENT_PROTOCOL_STATUS_VALUES.has(row.protocol_status)
    || !Number.isSafeInteger(row.instruction_bytes)
    || row.instruction_bytes < 0
    || !Number.isSafeInteger(row.tool_count)
    || row.tool_count < 0
    || !Number.isFinite(row.duration_ms)
    || row.duration_ms < 0
    || !CLIENT_STATE_VALUES.enablement.includes(row.enablement)
    || !CLIENT_STATE_VALUES.activation.includes(row.activation)) {
    fail(`${label} has invalid values`, 'INVALID_PLAN');
  }
  if (row.selected !== CLIENT_SELECTED_SELECTION_VALUES.has(row.selection)
    || (row.launch_contract === null && row.discovery_status === 'DETECTED')
    || (row.launch_contract !== null && row.discovery_status !== 'DETECTED')
    || (row.discovery_status === 'NOT_INSTALLED') !== CLIENT_NOT_INSTALLED_SELECTION_VALUES.has(row.selection)) {
    fail(`${label} has contradictory selection or discovery evidence`, 'INVALID_PLAN');
  }
  uniqueStrings(row.current_scopes, `${label}.current_scopes`);
  uniqueStrings(row.touched_paths, `${label}.touched_paths`, { absolute: true });
  uniqueStrings(row.initial_tool_names, `${label}.initial_tool_names`);
  if (row.effective_scope !== null && (typeof row.effective_scope !== 'string' || row.effective_scope.trim() === '')) {
    fail(`${label}.effective_scope is invalid`, 'INVALID_PLAN');
  }
  validateOwnedDiffRows(row.owned_diffs, `${label}.owned_diffs`);
  validateEnvironmentRows(row.environment, `${label}.environment`);
  if (row.launch_contract !== null) {
    try {
      validatePublicClientLaunchContract(row.launch_contract);
    } catch {
      fail(`${label}.launch_contract is invalid`, 'INVALID_PLAN');
    }
  }
  if (!client
    || row.selected !== client.selected
    || row.structural_status !== client.status
    || row.enablement !== client.enablement
    || row.activation !== client.activation
    || (row.launch_contract === null) !== (client.version === null)
    || (row.launch_contract !== null && (row.launch_contract.client_id !== row.adapter
      || row.launch_contract.version !== client.version
      || row.launch_contract.compatibility !== client.compatibility
      || row.launch_contract.write_supported !== client.write_supported))) {
    fail(`${label} is inconsistent with its public client row`, 'INVALID_PLAN');
  }
  return row;
}

function validateClientStageEvidence(stage, clients) {
  exactKeys(stage.evidence, CLIENT_STAGE_EVIDENCE_KEYS, 'plan client stage evidence');
  if (stage.evidence.vscode_profile !== null
    && (typeof stage.evidence.vscode_profile !== 'string' || stage.evidence.vscode_profile.trim() === '')) {
    fail('plan client profile evidence is invalid', 'INVALID_PLAN');
  }
  if (!SHA256.test(stage.evidence.discovery_context_sha256 ?? '') || !Array.isArray(stage.evidence.clients)) {
    fail('plan client stage evidence is invalid', 'INVALID_PLAN');
  }
  const clientByAdapter = new Map(clients.map(client => [client.adapter, client]));
  const evidenceByAdapter = new Map();
  for (const [index, row] of stage.evidence.clients.entries()) {
    validateClientEvidenceRow(row, clientByAdapter.get(row?.adapter), `plan client evidence[${index}]`);
    if (evidenceByAdapter.has(row.adapter)) fail('plan client evidence adapter IDs must be unique', 'INVALID_PLAN');
    evidenceByAdapter.set(row.adapter, row);
  }
  if (clientByAdapter.size !== CLIENT_IDS.length
    || evidenceByAdapter.size !== CLIENT_IDS.length
    || CLIENT_IDS.some(clientId => !clientByAdapter.has(clientId) || !evidenceByAdapter.has(clientId))) {
    fail('plan client stage must cover the closed client set', 'INVALID_PLAN');
  }
  return stage.evidence.clients;
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
  const clientStages = plan.stages.filter(stage => stage.name === 'clients');
  if (clientStages.length > 1) fail('plan contains duplicate client stages', 'INVALID_PLAN');
  const [clientStage] = clientStages;
  const hasClientOperations = operations.some(operation => operation.domain === 'clients');
  if (!clientStage && (hasClientOperations || request.selected_clients.length > 0)) {
    fail('plan is missing the client stage', 'INVALID_PLAN');
  }
  let clientEvidenceRows = [];
  if (clientStage) {
    const hasStructuredEvidence = Object.keys(clientStage.evidence).length > 0;
    if (hasStructuredEvidence || hasClientOperations) {
      clientEvidenceRows = validateClientStageEvidence(clientStage, clients);
    } else {
      exactKeys(clientStage.evidence, new Set(), 'empty plan client stage evidence');
    }
  }
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
  const clientPathPreconditions = preconditions.filter(precondition => precondition.kind === 'client_path');
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
    const matchingPreconditions = clientPathPreconditions.filter(precondition => pathIdentity(precondition.canonical_path) === pathIdentity(operation.path));
    const [operationPrecondition] = matchingPreconditions;
    const { atime_ms: ignoredAccessTime, ...stableOperationFingerprint } = operation.fingerprint ?? {};
    if (matchingPreconditions.length !== 1
      || operationPrecondition.writable !== (operation.ledger_only !== true)
      || typeof operation.allowed_root !== 'string'
      || typeof operationPrecondition.allowed_root !== 'string'
      || pathIdentity(operationPrecondition.allowed_root) !== pathIdentity(operation.allowed_root)
      || canonicalJson(operationPrecondition.fingerprint) !== canonicalJson(stableOperationFingerprint)) {
      fail('client operation is not bound to one exact path precondition', 'INVALID_PLAN', { client_id: operation.client_id ?? null });
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
