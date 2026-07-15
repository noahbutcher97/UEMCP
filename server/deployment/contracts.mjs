import { isAbsolute, posix, win32 } from 'node:path';

export const DEPLOYMENT_SCHEMA_VERSION = '1.0';
export const PLAN_TTL_MS = 30 * 60 * 1000;

export const OUTCOMES = Object.freeze({
  HEALTHY: 'HEALTHY',
  ACTION_REQUIRED: 'ACTION_REQUIRED',
  PARTIAL: 'PARTIAL',
  FAILED: 'FAILED',
});

export const EXIT_CODES = Object.freeze({
  HEALTHY: 0,
  ACTION_REQUIRED: 10,
  PARTIAL: 20,
  FAILED: 30,
  USAGE: 64,
});

const STAGE_STATUS_VALUES = `
READY NODE_MISSING NODE_UNSUPPORTED LOCK_DRIFT DEPENDENCY_POLICY_BLOCKED INSTALL_FAILED APPLY_IN_PROGRESS
REGISTERED ALREADY_REGISTERED INVALID_TARGET LOCAL_STATE_UNAVAILABLE SOURCE_PROVENANCE_UNKNOWN
CURRENT STALE NOT_DEPLOYED DEPLOYED_STALE DEPLOYED_SOURCE_CURRENT SYNC_FAILED
UNCLASSIFIED_PLUGIN_CONTENT UNCLASSIFIED_TARGET_CONTENT
DEPLOYED_BUILD_REQUIRED DEPLOYED_BUILD_CURRENT BUILD_REQUIRED BUILD_FAILED UNKNOWN_TOOLCHAIN
EDITOR_RESTART_REQUIRED EDITOR_LOCKED
ABSENT CONFIGURED ALREADY_CONFIGURED MATCHING_EFFECTIVE MATCHING_SHADOWED
CONFLICT_EFFECTIVE SHADOWED CONFLICT MALFORMED_CONFIG INSPECTION_LIMIT_EXCEEDED MALFORMED_PROJECT_PLUGIN_LIST
ROLLED_BACK ROLLBACK_CONFLICT UNSUPPORTED_VERSION
ENABLED DISABLED CONNECTED PENDING_TRUST RESTART_REQUIRED POLICY_BLOCKED POLICY_UNKNOWN
NOT_SELECTED NOT_INSTALLED MANUAL_REGISTRATION_REQUIRED UNKNOWN
HEALTHY INITIALIZE_FAILED TOOLS_LIST_FAILED
VERIFIED EDITOR_CLOSED PLUGIN_NOT_LOADED PROJECT_MISMATCH NOT_CHECKED
`.trim().split(/\s+/);

const ACTION_CODE_VALUES = `
NODE_INSTALL_REQUIRED DEPENDENCIES_INSTALL_REQUIRED DEPENDENCY_POLICY_BLOCKED SOURCE_PROVENANCE_UNKNOWN LOCAL_STATE_UNAVAILABLE APPLY_IN_PROGRESS
INSTALL_FAILED SYNC_FAILED BUILD_REQUIRED BUILD_FAILED UNKNOWN_TOOLCHAIN
EDITOR_RESTART_REQUIRED EDITOR_LOCKED EDITOR_CLOSED PLUGIN_NOT_LOADED PROJECT_MISMATCH
PENDING_TRUST RESTART_REQUIRED CLIENT_ENABLEMENT_REQUIRED CLIENT_ENABLEMENT_REVIEW_REQUIRED
CONFLICT MALFORMED_CONFIG INSPECTION_LIMIT_EXCEEDED MALFORMED_PROJECT_PLUGIN_LIST
POLICY_BLOCKED POLICY_UNKNOWN CUSTOM_ENV_REVIEW_REQUIRED CUSTOM_LAUNCH_REVIEW_REQUIRED
UNSUPPORTED_VERSION NOT_INSTALLED MANUAL_REGISTRATION_REQUIRED
UNCLASSIFIED_PLUGIN_CONTENT UNCLASSIFIED_TARGET_CONTENT INITIALIZE_FAILED TOOLS_LIST_FAILED
PLAN_STALE PLAN_DIGEST_MISMATCH PLAN_EXPIRED PLAN_REPLAYED ROLLBACK_CONFLICT
UNSUPPORTED_INTERFACE ELICITATION_UNAVAILABLE
`.trim().split(/\s+/);

function createIdentityRegistry(values) {
  return Object.freeze(Object.fromEntries(values.map(value => [value, value])));
}

export const STAGE_STATUSES = createIdentityRegistry(STAGE_STATUS_VALUES);
export const ACTION_CODES = createIdentityRegistry(ACTION_CODE_VALUES);
export const CLIENT_COMPATIBILITY = Object.freeze([
  'release_gated',
  'known_unsupported',
  'unknown_newer',
  'not_installed',
]);
export const CLIENT_STATE_VALUES = Object.freeze({
  status: Object.freeze(`
ABSENT CONFIGURED ALREADY_CONFIGURED MATCHING_EFFECTIVE MATCHING_SHADOWED
CONFLICT_EFFECTIVE SHADOWED CONFLICT MALFORMED_CONFIG INSPECTION_LIMIT_EXCEEDED ROLLED_BACK
ROLLBACK_CONFLICT NOT_SELECTED NOT_INSTALLED MANUAL_REGISTRATION_REQUIRED UNKNOWN
  `.trim().split(/\s+/)),
  enablement: Object.freeze('ENABLED DISABLED POLICY_BLOCKED POLICY_UNKNOWN NOT_SELECTED NOT_INSTALLED UNKNOWN'.split(' ')),
  activation: Object.freeze('CONNECTED PENDING_TRUST RESTART_REQUIRED NOT_SELECTED NOT_INSTALLED UNKNOWN'.split(' ')),
});

const STAGE_RESULTS = new Set(['ready', 'action_required', 'failed', 'rolled_back', 'skipped']);
const STAGE_PROGRESS = new Set(['none', 'committed']);
const stageFacts = new WeakMap();
const SECRET_KEY = /(?:^|[_-])(token|secret|password|passphrase|authorization|cookie|api[_-]?key)(?:$|[_-])/i;
const HEX_64 = /^[0-9a-f]{64}$/;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

export class DeploymentContractError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'DeploymentContractError';
    this.code = 'INVALID_CONTRACT';
    this.details = details;
  }
}

function fail(message, details) {
  throw new DeploymentContractError(message, details);
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value);
  const unknown = actual.filter(key => !allowed.has(key));
  const missing = [...allowed].filter(key => !Object.hasOwn(value, key));
  if (unknown.length || missing.length) {
    fail(`${label} has invalid keys`, { unknown, missing });
  }
}

function assertInputKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  const unknown = Object.keys(value).filter(key => !allowed.has(key));
  if (unknown.length) fail(`${label} has unknown keys`, { unknown });
}

function assertNonEmptyString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') fail(`${label} must be a non-empty string`);
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') fail(`${label} must be a boolean`);
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value));
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail(`${label} must be an ISO-8601 UTC timestamp`);
  }
}

function cloneJsonValue(value, label = 'value', seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return value;
  }
  if (typeof value !== 'object') fail(`${label} contains an unsupported value`);
  if (seen.has(value)) fail(`${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((entry, index) => cloneJsonValue(entry, `${label}[${index}]`, seen));
    if (!isPlainObject(value)) fail(`${label} contains a non-plain object`);
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneJsonValue(entry, `${label}.${key}`, seen)]));
  } finally {
    seen.delete(value);
  }
}

function assertNoSecretKeys(value, label = 'value', seen = new Set()) {
  if (value === null || typeof value !== 'object') return;
  if (seen.has(value)) fail(`${label} contains a cycle`);
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => assertNoSecretKeys(entry, `${label}[${index}]`, seen));
      return;
    }
    for (const [key, entry] of Object.entries(value)) {
      if (SECRET_KEY.test(key)) fail(`${label} contains a secret-bearing key`, { key });
      assertNoSecretKeys(entry, `${label}.${key}`, seen);
    }
  } finally {
    seen.delete(value);
  }
}

function validateAction(action) {
  assertExactKeys(action, new Set(['code', 'message', 'command']), 'action');
  if (!ACTION_CODE_VALUES.includes(action.code)) fail('action.code is unknown', { code: action.code });
  assertNonEmptyString(action.message, 'action.message');
  if (action.command !== null) {
    assertExactKeys(action.command, new Set(['executable', 'args']), 'action.command');
    if (!isAbsolutePath(action.command.executable)) fail('action.command.executable must be absolute');
    if (!Array.isArray(action.command.args) || !action.command.args.every(arg => typeof arg === 'string')) {
      fail('action.command.args must be an array of strings');
    }
  }
  return cloneJsonValue(action, 'action');
}

function validateActions(actions, label = 'actions') {
  if (!Array.isArray(actions)) fail(`${label} must be an array`);
  return actions.map(validateAction);
}

function validatePublicStage(stage) {
  assertExactKeys(stage, new Set(['name', 'status', 'mandatory', 'changed', 'evidence', 'actions']), 'stage');
  assertNonEmptyString(stage.name, 'stage.name');
  if (!STAGE_STATUS_VALUES.includes(stage.status)) fail('stage.status is unknown', { status: stage.status });
  assertBoolean(stage.mandatory, 'stage.mandatory');
  assertBoolean(stage.changed, 'stage.changed');
  if (!isPlainObject(stage.evidence)) fail('stage.evidence must be an object');
  assertNoSecretKeys(stage.evidence, 'stage.evidence');
  const evidence = cloneJsonValue(stage.evidence, 'stage.evidence');
  const actions = validateActions(stage.actions, 'stage.actions');
  return { name: stage.name, status: stage.status, mandatory: stage.mandatory, changed: stage.changed, evidence, actions };
}

export function createStageResult(input) {
  assertInputKeys(
    input,
    new Set(['name', 'status', 'mandatory', 'changed', 'evidence', 'actions', 'result', 'progress']),
    'stage',
  );
  const {
    name,
    status,
    mandatory = true,
    changed = false,
    evidence = {},
    actions = [],
    result = 'ready',
    progress = changed ? 'committed' : 'none',
  } = input;
  if (!STAGE_RESULTS.has(result)) fail('stage.result is unknown', { result });
  if (!STAGE_PROGRESS.has(progress)) fail('stage.progress is unknown', { progress });
  if (progress === 'committed' && !changed) fail('committed stage progress requires changed=true');
  const publicStage = Object.freeze(validatePublicStage({ name, status, mandatory, changed, evidence, actions }));
  stageFacts.set(publicStage, Object.freeze({ result, progress }));
  return publicStage;
}

function readStageFacts(stage) {
  const facts = stageFacts.get(stage);
  if (!facts) fail('stage was not created by createStageResult');
  return facts;
}

export function reduceOutcome(stages) {
  if (!Array.isArray(stages) || stages.length === 0) fail('stages must be a non-empty array');
  const rows = stages.map(stage => ({ stage: validatePublicStage(stage), facts: readStageFacts(stage) }));
  const mandatoryTerminalFailure = rows.some(({ stage, facts }) =>
    stage.mandatory && (facts.result === 'failed' || facts.result === 'rolled_back'));
  const committedProgress = rows.some(({ facts }) => facts.progress === 'committed' && facts.result !== 'rolled_back');

  if (mandatoryTerminalFailure) return committedProgress ? OUTCOMES.PARTIAL : OUTCOMES.FAILED;
  if (rows.some(({ facts }) => facts.result !== 'ready')) return OUTCOMES.ACTION_REQUIRED;
  return OUTCOMES.HEALTHY;
}

function validateSource(source) {
  assertExactKeys(
    source,
    new Set(['kind', 'repository', 'repo_root', 'git_commit', 'dirty', 'archive', 'orchestrator_version']),
    'source',
  );
  if (!['git_checkout', 'pinned_archive'].includes(source.kind)) fail('source.kind is unknown');
  assertNonEmptyString(source.repository, 'source.repository');
  if (!isAbsolutePath(source.repo_root)) fail('source.repo_root must be absolute');
  if (!GIT_OBJECT_ID.test(source.git_commit)) fail('source.git_commit must be a full lowercase object ID');
  assertBoolean(source.dirty, 'source.dirty');
  assertNonEmptyString(source.orchestrator_version, 'source.orchestrator_version');

  if (source.kind === 'git_checkout') {
    if (source.archive !== null) fail('git_checkout source.archive must be null');
  } else {
    assertExactKeys(
      source.archive,
      new Set(['archive_sha256', 'baseline_manifest_sha256', 'current_manifest_sha256', 'provenance_sha256']),
      'source.archive',
    );
    for (const [key, value] of Object.entries(source.archive)) {
      if (!HEX_64.test(value)) fail(`source.archive.${key} must be lowercase SHA-256`);
    }
  }
  return cloneJsonValue(source, 'source');
}

function validateRequest(request) {
  assertExactKeys(request, new Set(['requested_project', 'requested_profile', 'selected_clients']), 'request');
  for (const key of ['requested_project', 'requested_profile']) {
    if (request[key] !== null && typeof request[key] !== 'string') fail(`request.${key} must be a string or null`);
  }
  if (!Array.isArray(request.selected_clients) || !request.selected_clients.every(value => typeof value === 'string')) {
    fail('request.selected_clients must be an array of strings');
  }
  if (new Set(request.selected_clients).size !== request.selected_clients.length) {
    fail('request.selected_clients must not contain duplicates');
  }
  return cloneJsonValue(request, 'request');
}

function validateDescriptor(descriptor) {
  assertExactKeys(descriptor, new Set(['name', 'transport', 'command', 'args', 'env', 'cwd']), 'descriptor');
  assertNonEmptyString(descriptor.name, 'descriptor.name');
  if (descriptor.transport !== 'stdio') fail('descriptor.transport must be stdio');
  if (!isAbsolutePath(descriptor.command)) fail('descriptor.command must be absolute');
  if (!Array.isArray(descriptor.args) || !descriptor.args.every(arg => typeof arg === 'string')) {
    fail('descriptor.args must be an array of strings');
  }
  if (!isPlainObject(descriptor.env) || Object.keys(descriptor.env).length !== 0) fail('descriptor.env must be empty');
  if (descriptor.cwd !== null) fail('descriptor.cwd must be null');
  return cloneJsonValue(descriptor, 'descriptor');
}

function validatePlanSummary(plan) {
  assertExactKeys(plan, new Set(['digest', 'created_at', 'expires_at', 'preconditions_valid']), 'plan');
  if (!HEX_64.test(plan.digest)) fail('plan.digest must be lowercase SHA-256');
  assertIsoTimestamp(plan.created_at, 'plan.created_at');
  assertIsoTimestamp(plan.expires_at, 'plan.expires_at');
  assertBoolean(plan.preconditions_valid, 'plan.preconditions_valid');
  return cloneJsonValue(plan, 'plan');
}

function validateClient(client) {
  assertExactKeys(
    client,
    new Set(['adapter', 'version', 'compatibility', 'write_supported', 'selected', 'scope', 'status', 'enablement', 'activation', 'actions']),
    'client',
  );
  assertNonEmptyString(client.adapter, 'client.adapter');
  if (client.version !== null && (typeof client.version !== 'string' || client.version.trim() === '')) {
    fail('client.version must be a non-empty string or null');
  }
  if (!CLIENT_COMPATIBILITY.includes(client.compatibility)) fail('client.compatibility is unknown');
  assertBoolean(client.write_supported, 'client.write_supported');
  assertBoolean(client.selected, 'client.selected');
  assertNonEmptyString(client.scope, 'client.scope');
  if (!CLIENT_STATE_VALUES.status.includes(client.status)) fail('client.status is invalid');
  if (!CLIENT_STATE_VALUES.enablement.includes(client.enablement)) fail('client.enablement is invalid');
  if (!CLIENT_STATE_VALUES.activation.includes(client.activation)) fail('client.activation is invalid');
  if (client.write_supported !== (client.compatibility === 'release_gated')) {
    fail('client compatibility and write support are inconsistent');
  }
  if (client.status === 'NOT_SELECTED' && (client.enablement !== 'NOT_SELECTED' || client.activation !== 'NOT_SELECTED')) {
    fail('NOT_SELECTED client state must be consistent');
  }
  if (client.compatibility === 'not_installed') {
    if (client.version !== null || client.status !== 'NOT_INSTALLED' || client.enablement !== 'NOT_INSTALLED' || client.activation !== 'NOT_INSTALLED') {
      fail('not-installed client state must be consistent');
    }
  }
  return { ...cloneJsonValue(client, 'client'), actions: validateActions(client.actions, 'client.actions') };
}

function validateReceipt(receipt) {
  assertExactKeys(receipt, new Set(['kind', 'path_label', 'sha256']), 'receipt');
  assertNonEmptyString(receipt.kind, 'receipt.kind');
  assertNonEmptyString(receipt.path_label, 'receipt.path_label');
  if (!HEX_64.test(receipt.sha256)) fail('receipt.sha256 must be lowercase SHA-256');
  return cloneJsonValue(receipt, 'receipt');
}

function validateMachineResultInternal(value) {
  assertExactKeys(
    value,
    new Set(['schema_version', 'kind', 'operation', 'outcome', 'timestamp', 'source', 'request', 'descriptor', 'plan', 'stages', 'clients', 'receipts', 'actions']),
    'machine result',
  );
  if (value.schema_version !== DEPLOYMENT_SCHEMA_VERSION) fail('machine result schema version is unsupported');
  if (value.kind !== 'uemcp.deployment.result') fail('machine result kind is invalid');
  if (!['apply', 'verify', 'doctor'].includes(value.operation)) fail('machine result operation is invalid');
  if (!Object.values(OUTCOMES).includes(value.outcome)) fail('machine result outcome is invalid');
  assertIsoTimestamp(value.timestamp, 'machine result timestamp');
  validateSource(value.source);
  validateRequest(value.request);
  validateDescriptor(value.descriptor);
  if (value.operation === 'apply') {
    if (value.plan === null) fail('apply result requires a consumed plan');
    validatePlanSummary(value.plan);
  } else if (value.plan !== null) {
    fail('standalone verify/doctor result must have plan=null');
  }
  if (!Array.isArray(value.stages) || value.stages.length === 0) fail('machine result stages must be non-empty');
  value.stages.forEach(validatePublicStage);
  if (!Array.isArray(value.clients)) fail('machine result clients must be an array');
  value.clients.forEach(validateClient);
  if (!Array.isArray(value.receipts)) fail('machine result receipts must be an array');
  value.receipts.forEach(validateReceipt);
  validateActions(value.actions);
}

export function createMachineResult({
  operation,
  source,
  request,
  descriptor,
  plan = null,
  stages,
  clients = [],
  receipts = [],
  actions = [],
  now = new Date(),
}) {
  const outcome = reduceOutcome(stages);
  const timestamp = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const value = {
    schema_version: DEPLOYMENT_SCHEMA_VERSION,
    kind: 'uemcp.deployment.result',
    operation,
    outcome,
    timestamp,
    source: validateSource(source),
    request: validateRequest(request),
    descriptor: validateDescriptor(descriptor),
    plan: plan === null ? null : validatePlanSummary(plan),
    stages: stages.map(validatePublicStage),
    clients: clients.map(validateClient),
    receipts: receipts.map(validateReceipt),
    actions: validateActions(actions),
  };
  validateMachineResultInternal(value);
  return value;
}

export function validateMachineResult(value) {
  validateMachineResultInternal(value);
  return true;
}

export function exitCodeForOutcome(outcome) {
  if (!Object.values(OUTCOMES).includes(outcome)) fail('unknown deployment outcome', { outcome });
  return EXIT_CODES[outcome];
}
