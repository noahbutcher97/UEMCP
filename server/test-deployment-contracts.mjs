// Deployment machine contract and primitive tests.
//
// Run: cd server && node test-deployment-contracts.mjs

import { TestRunner } from './test-helpers.mjs';
import {
  ACTION_CODES,
  CLIENT_COMPATIBILITY,
  CLIENT_STATE_VALUES,
  DEPLOYMENT_SCHEMA_VERSION,
  EXIT_CODES,
  OUTCOMES,
  PLAN_TTL_MS,
  STAGE_STATUSES,
  createMachineResult,
  createStageResult,
  exitCodeForOutcome,
  reduceOutcome,
  validateMachineResult,
} from './deployment/contracts.mjs';

const t = new TestRunner('Deployment Contract Tests');

const EXPECTED_STATUSES = `
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

const EXPECTED_ACTIONS = `
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

function values(value) {
  return Object.values(value);
}

function sameValues(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function throwsCode(fn, code) {
  try {
    fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
}

function validAction(overrides = {}) {
  return {
    code: 'RESTART_REQUIRED',
    message: 'Restart the host to activate the configured server.',
    command: null,
    ...overrides,
  };
}

function validSource(overrides = {}) {
  return {
    kind: 'git_checkout',
    repository: 'owner/UEMCP',
    repo_root: 'D:\\DevTools\\UEMCP',
    git_commit: 'a'.repeat(40),
    dirty: false,
    archive: null,
    orchestrator_version: '1.0.0',
    ...overrides,
  };
}

function validDescriptor(overrides = {}) {
  return {
    name: 'uemcp',
    transport: 'stdio',
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['D:\\DevTools\\UEMCP\\server\\server.mjs'],
    env: {},
    cwd: null,
    ...overrides,
  };
}

function validRequest(overrides = {}) {
  return {
    requested_project: null,
    requested_profile: null,
    selected_clients: [],
    ...overrides,
  };
}

function validClient(overrides = {}) {
  return {
    adapter: 'codex',
    version: '0.144.4',
    compatibility: 'release_gated',
    write_supported: true,
    selected: true,
    scope: 'user',
    status: 'CONFIGURED',
    enablement: 'ENABLED',
    activation: 'CONNECTED',
    actions: [],
    ...overrides,
  };
}

function validMachineInput(overrides = {}) {
  return {
    operation: 'verify',
    source: validSource(),
    request: validRequest(),
    descriptor: validDescriptor(),
    plan: null,
    stages: [createStageResult({ name: 'prerequisites', status: 'READY' })],
    clients: [],
    receipts: [],
    actions: [],
    now: new Date('2026-07-15T12:00:00.000Z'),
    ...overrides,
  };
}

// Constants are closed, exact, and immutable.
{
  t.assert(DEPLOYMENT_SCHEMA_VERSION === '1.0', 'schema version is locked to 1.0');
  t.assert(PLAN_TTL_MS === 30 * 60 * 1000, 'plan TTL is exactly 30 minutes');
  t.assert(Object.isFrozen(OUTCOMES), 'outcomes registry is frozen');
  t.assert(Object.isFrozen(EXIT_CODES), 'exit-code registry is frozen');
  t.assert(Object.isFrozen(STAGE_STATUSES), 'stage-status registry is frozen');
  t.assert(Object.isFrozen(ACTION_CODES), 'action-code registry is frozen');
  t.assert(Object.isFrozen(CLIENT_COMPATIBILITY), 'client compatibility registry is frozen');
  t.assert(Object.isFrozen(CLIENT_STATE_VALUES), 'client state registry is frozen');
  t.assert(Object.values(CLIENT_STATE_VALUES).every(Object.isFrozen), 'client state subsets are frozen');
  t.assert(sameValues(values(STAGE_STATUSES), EXPECTED_STATUSES), 'stage statuses match the locked ordered registry');
  t.assert(sameValues(values(ACTION_CODES), EXPECTED_ACTIONS), 'action codes match the locked ordered registry');
  t.assert(new Set(values(STAGE_STATUSES)).size === EXPECTED_STATUSES.length, 'stage statuses have no duplicates');
  t.assert(new Set(values(ACTION_CODES)).size === EXPECTED_ACTIONS.length, 'action codes have no duplicates');
  t.assert(
    Object.values(CLIENT_STATE_VALUES).flat().every(value => EXPECTED_STATUSES.includes(value)),
    'every client state belongs to the stage registry',
  );
}

// Stage and action construction is strict and secret-resistant.
{
  const stage = createStageResult({
    name: 'clients',
    status: 'RESTART_REQUIRED',
    result: 'action_required',
    evidence: { client_count: 1 },
    actions: [validAction()],
  });
  t.assert(stage.name === 'clients' && stage.status === 'RESTART_REQUIRED', 'stage constructor preserves validated fields');
  t.assert(!Object.hasOwn(stage, 'result') && !Object.hasOwn(stage, 'progress'), 'internal reduction facts are not serialized');
  t.assert(throwsCode(() => createStageResult({ name: '', status: 'READY' }), 'INVALID_CONTRACT'), 'empty stage name is rejected');
  t.assert(throwsCode(() => createStageResult({ name: 'x', status: '' }), 'INVALID_CONTRACT'), 'empty stage status is rejected');
  t.assert(throwsCode(() => createStageResult({ name: 'x', status: 'NOT_A_STATUS' }), 'INVALID_CONTRACT'), 'unknown stage status is rejected');
  t.assert(throwsCode(() => createStageResult({ name: 'x', status: 'READY', extra: true }), 'INVALID_CONTRACT'), 'unknown stage fields are rejected');
  t.assert(throwsCode(() => createStageResult({ name: 'x', status: 'READY', evidence: { api_token: 'canary' } }), 'INVALID_CONTRACT'), 'secret-bearing evidence keys are rejected');
  t.assert(throwsCode(() => createStageResult({ name: 'x', status: 'READY', actions: {} }), 'INVALID_CONTRACT'), 'non-array actions are rejected');
  t.assert(throwsCode(() => createStageResult({ name: 'x', status: 'READY', actions: [validAction({ code: 'NOPE' })] }), 'INVALID_CONTRACT'), 'unknown action codes are rejected');
  t.assert(throwsCode(() => createStageResult({ name: 'x', status: 'READY', actions: [{ ...validAction(), extra: true }] }), 'INVALID_CONTRACT'), 'extra action keys are rejected');
  t.assert(throwsCode(() => createStageResult({ name: 'x', status: 'READY', actions: [validAction({ command: 'node test.mjs' })] }), 'INVALID_CONTRACT'), 'string action commands are rejected');
  t.assert(throwsCode(() => createStageResult({ name: 'x', status: 'READY', actions: [validAction({ command: { executable: 'node', args: [] } })] }), 'INVALID_CONTRACT'), 'relative action executables are rejected');
  t.assert(throwsCode(() => createStageResult({ name: 'x', status: 'READY', actions: [validAction({ command: { executable: 'C:\\node.exe', args: [], env: {} } })] }), 'INVALID_CONTRACT'), 'action environment fields are rejected');
  t.assert(throwsCode(() => createStageResult({ name: 'x', status: 'READY', actions: [validAction({ command: { executable: 'C:\\node.exe', args: 'bad' } })] }), 'INVALID_CONTRACT'), 'non-array action arguments are rejected');
}

// Outcome reduction uses explicit facts, not status spelling.
{
  const ready = createStageResult({ name: 'one', status: 'READY', result: 'ready' });
  const unusualReady = createStageResult({ name: 'two', status: 'INSTALL_FAILED', result: 'ready' });
  const restart = createStageResult({ name: 'three', status: 'RESTART_REQUIRED', result: 'action_required' });
  const failed = createStageResult({ name: 'four', status: 'INSTALL_FAILED', result: 'failed' });
  const committed = createStageResult({ name: 'five', status: 'CURRENT', result: 'ready', progress: 'committed', changed: true });
  const rolledBack = createStageResult({ name: 'six', status: 'ROLLED_BACK', result: 'rolled_back' });

  t.assert(reduceOutcome([ready, unusualReady]) === 'HEALTHY', 'status names do not determine a healthy outcome');
  t.assert(reduceOutcome([ready, restart]) === 'ACTION_REQUIRED', 'human-only action reduces to ACTION_REQUIRED');
  t.assert(reduceOutcome([failed]) === 'FAILED', 'mandatory failure without useful progress reduces to FAILED');
  t.assert(reduceOutcome([committed, failed]) === 'PARTIAL', 'committed progress plus mandatory failure reduces to PARTIAL');
  t.assert(reduceOutcome([rolledBack]) === 'FAILED', 'fully rolled-back mandatory transaction reduces to FAILED');
  t.assert(reduceOutcome([ready, createStageResult({ name: 'optional', status: 'INSTALL_FAILED', mandatory: false, result: 'failed' })]) === 'ACTION_REQUIRED', 'optional failure remains visible as ACTION_REQUIRED');
}

// Exit codes preserve nonzero machine outcomes.
{
  t.assert(exitCodeForOutcome('HEALTHY') === 0, 'HEALTHY exits 0');
  t.assert(exitCodeForOutcome('ACTION_REQUIRED') === 10, 'ACTION_REQUIRED exits 10');
  t.assert(exitCodeForOutcome('PARTIAL') === 20, 'PARTIAL exits 20');
  t.assert(exitCodeForOutcome('FAILED') === 30, 'FAILED exits 30');
  t.assert(throwsCode(() => exitCodeForOutcome('UNKNOWN'), 'INVALID_CONTRACT'), 'unknown outcomes do not acquire a success code');
}

// Machine results and tagged source/client unions are exact.
{
  const result = createMachineResult(validMachineInput());
  t.assert(result.kind === 'uemcp.deployment.result' && result.outcome === 'HEALTHY', 'machine result is constructed with reduced outcome');
  t.assert(result.timestamp === '2026-07-15T12:00:00.000Z', 'machine result uses the injected timestamp');
  t.assert(validateMachineResult(result) === true, 'machine result validates against schema 1.0');
  t.assert(!Object.hasOwn(result.stages[0], 'result'), 'serialized machine stages omit internal reduction facts');

  const archived = createMachineResult(validMachineInput({
    source: validSource({
      kind: 'pinned_archive',
      git_commit: 'b'.repeat(64),
      archive: {
        archive_sha256: 'c'.repeat(64),
        baseline_manifest_sha256: 'd'.repeat(64),
        current_manifest_sha256: 'e'.repeat(64),
        provenance_sha256: 'f'.repeat(64),
      },
    }),
  }));
  t.assert(archived.source.kind === 'pinned_archive', 'valid pinned archive source is accepted');

  t.assert(throwsCode(() => createMachineResult(validMachineInput({ source: validSource({ kind: 'other' }) })), 'INVALID_CONTRACT'), 'unknown source kind is rejected');
  t.assert(throwsCode(() => createMachineResult(validMachineInput({ source: validSource({ git_commit: 'a'.repeat(39) }) })), 'INVALID_CONTRACT'), 'short Git commit is rejected');
  t.assert(throwsCode(() => createMachineResult(validMachineInput({ source: validSource({ git_commit: 'A'.repeat(40) }) })), 'INVALID_CONTRACT'), 'uppercase Git commit is rejected');
  t.assert(throwsCode(() => createMachineResult(validMachineInput({ source: validSource({ archive: { archive_sha256: 'a'.repeat(64) } }) })), 'INVALID_CONTRACT'), 'checkout archive must be null');
  t.assert(throwsCode(() => createMachineResult(validMachineInput({ source: validSource({ kind: 'pinned_archive', archive: null }) })), 'INVALID_CONTRACT'), 'pinned archive requires all archive hashes');

  const withClient = createMachineResult(validMachineInput({ clients: [validClient()] }));
  t.assert(withClient.clients[0].status === 'CONFIGURED', 'field-specific valid client states are accepted');
  t.assert(throwsCode(() => createMachineResult(validMachineInput({ clients: [validClient({ compatibility: 'unknown_newer', write_supported: true })] })), 'INVALID_CONTRACT'), 'unknown newer clients cannot be write-supported');
  t.assert(throwsCode(() => createMachineResult(validMachineInput({ clients: [validClient({ compatibility: 'release_gated', write_supported: false })] })), 'INVALID_CONTRACT'), 'release-gated clients must be write-supported');
  t.assert(throwsCode(() => createMachineResult(validMachineInput({ clients: [validClient({ status: 'READY' })] })), 'INVALID_CONTRACT'), 'client structural status uses its field-specific subset');
  t.assert(throwsCode(() => createMachineResult(validMachineInput({ clients: [validClient({ enablement: 'CONNECTED' })] })), 'INVALID_CONTRACT'), 'client enablement uses its field-specific subset');
  t.assert(throwsCode(() => createMachineResult(validMachineInput({ clients: [validClient({ activation: 'ENABLED' })] })), 'INVALID_CONTRACT'), 'client activation uses its field-specific subset');

  const apply = createMachineResult(validMachineInput({
    operation: 'apply',
    plan: {
      digest: '1'.repeat(64),
      created_at: '2026-07-15T11:55:00.000Z',
      expires_at: '2026-07-15T12:25:00.000Z',
      preconditions_valid: true,
    },
  }));
  t.assert(apply.plan.digest === '1'.repeat(64), 'apply requires and preserves a consumed-plan summary');
  t.assert(throwsCode(() => createMachineResult(validMachineInput({ operation: 'apply', plan: null })), 'INVALID_CONTRACT'), 'apply without a consumed plan is rejected');
  t.assert(throwsCode(() => createMachineResult(validMachineInput({ operation: 'verify', plan: apply.plan })), 'INVALID_CONTRACT'), 'verify cannot fabricate a current plan');

  const drifted = { ...result, schema_version: '2.0' };
  t.assert(throwsCode(() => validateMachineResult(drifted), 'INVALID_CONTRACT'), 'schema-version drift is rejected');
  t.assert(throwsCode(() => validateMachineResult({ ...result, extra: true }), 'INVALID_CONTRACT'), 'unknown top-level fields are rejected');
}

const failed = t.summary();
process.exit(failed ? 1 : 0);
