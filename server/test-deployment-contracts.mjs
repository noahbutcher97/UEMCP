// Deployment machine contract and primitive tests.
//
// Run: cd server && node test-deployment-contracts.mjs

import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as asyncFs from 'node:fs/promises';
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

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
  shouldRecordPlanDigest,
  validateMachineResult,
} from './deployment/contracts.mjs';
import { canonicalJson, sha256Bytes, sha256Canonical } from './deployment/canonical-json.mjs';
import { fingerprintDirectory, fingerprintPath } from './deployment/fingerprints.mjs';
import { assertNoSecretCanaries, redactSecrets } from './deployment/redaction.mjs';
import { createProcessRunner } from './deployment/process-runner.mjs';
import {
  WINDOWS_NATIVE_SCRIPTS,
  fingerprintWindowsFileMetadata,
  inspectAuthenticode,
  replaceFilePreservingMetadata,
} from './deployment/windows-native.mjs';
import { createLocalState, inspectLeaseOwnerProcess } from './deployment/local-state.mjs';
import { inspectSourceProvenance } from './deployment/source-provenance.mjs';

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
  const optionalSkipped = createStageResult({ name: 'seven', status: 'NOT_CHECKED', mandatory: false, result: 'skipped' });

  t.assert(reduceOutcome([ready, unusualReady]) === 'HEALTHY', 'status names do not determine a healthy outcome');
  t.assert(reduceOutcome([ready, restart]) === 'ACTION_REQUIRED', 'human-only action reduces to ACTION_REQUIRED');
  t.assert(reduceOutcome([failed]) === 'FAILED', 'mandatory failure without useful progress reduces to FAILED');
  t.assert(reduceOutcome([committed, failed]) === 'PARTIAL', 'committed progress plus mandatory failure reduces to PARTIAL');
  t.assert(reduceOutcome([rolledBack]) === 'FAILED', 'fully rolled-back mandatory transaction reduces to FAILED');
  t.assert(reduceOutcome([ready, createStageResult({ name: 'optional', status: 'INSTALL_FAILED', mandatory: false, result: 'failed' })]) === 'ACTION_REQUIRED', 'optional failure remains visible as ACTION_REQUIRED');
  t.assert(reduceOutcome([ready, optionalSkipped]) === 'HEALTHY', 'optional skipped work does not make a healthy result actionable');
  t.assert(shouldRecordPlanDigest([committed]) === true, 'committed apply progress consumes the approved plan');
  t.assert(shouldRecordPlanDigest([rolledBack]) === true, 'fully rolled-back apply progress consumes the approved plan');
  t.assert(shouldRecordPlanDigest([failed, restart]) === false, 'failure or action without apply progress remains retryable');
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

function makePrimitiveRoot(label = 'uemcp-deployment-primitives-') {
  const root = join(tmpdir(), `${label}${randomUUID()}`);
  mkdirSync(root);
  return root;
}

function cleanupPrimitiveRoot(root, label = 'uemcp-') {
  const normalized = resolve(root).replace(/\\/g, '/').toLowerCase();
  const expected = resolve(tmpdir()).replace(/\\/g, '/').toLowerCase();
  if (!normalized.startsWith(`${expected}/${label}`)) throw new Error(`refusing to clean unexpected path: ${root}`);
  rmSync(root, { recursive: true, force: true });
}

async function rejectsCode(fn, code) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
}

// Canonical JSON and hashing preserve exact machine-review bytes.
{
  t.assert(canonicalJson({ z: 1, a: { d: 4, b: 2 }, list: [3, 1] }) === '{"a":{"b":2,"d":4},"list":[3,1],"z":1}', 'canonical JSON recursively sorts object keys and preserves arrays');
  t.assert(canonicalJson({ path: 'D:/\u30c4\u30fc\u30eb/Project' }) === '{"path":"D:/\u30c4\u30fc\u30eb/Project"}', 'canonical JSON preserves Unicode strings');
  t.assert(canonicalJson(-0) === '0', 'canonical JSON normalizes negative zero');
  t.assert(throwsCode(() => canonicalJson(Number.NaN), 'INVALID_CANONICAL_JSON'), 'canonical JSON rejects NaN');
  t.assert(throwsCode(() => canonicalJson({ missing: undefined }), 'INVALID_CANONICAL_JSON'), 'canonical JSON rejects undefined');
  const cycle = {};
  cycle.self = cycle;
  t.assert(throwsCode(() => canonicalJson(cycle), 'INVALID_CANONICAL_JSON'), 'canonical JSON rejects cycles');
  const raw = Buffer.from([0, 255, 1, 254]);
  const expectedRawHash = createHash('sha256').update(raw).digest('hex');
  t.assert(sha256Bytes(raw) === expectedRawHash && /^[0-9a-f]{64}$/.test(sha256Bytes(raw)), 'raw-byte SHA-256 is lowercase and exact');
  t.assert(sha256Canonical({ b: 2, a: 1 }) === sha256Canonical({ a: 1, b: 2 }), 'canonical hash ignores object insertion order');
}

// File and directory fingerprints bind bytes, path identity, and link metadata.
{
  const root = makePrimitiveRoot();
  try {
    const payload = join(root, 'payload.bin');
    const hardLink = join(root, 'payload-hardlink.bin');
    const tree = join(root, 'tree');
    mkdirSync(tree);
    writeFileSync(payload, Buffer.from([0, 255, 10, 13]));
    linkSync(payload, hardLink);
    writeFileSync(join(tree, 'b.txt'), 'b', 'utf8');
    writeFileSync(join(tree, 'a.txt'), 'a', 'utf8');

    const file = await fingerprintPath(payload, { allowedRoots: [root] });
    t.assert(file.exists && file.kind === 'file' && file.sha256 === sha256Bytes(Buffer.from([0, 255, 10, 13])), 'file fingerprint hashes exact bytes');
    t.assert(file.link_count >= 2, 'file fingerprint records hard-link count');
    let boundedReads = 0;
    const boundedFs = {
      ...asyncFs,
      async readFile(...args) {
        boundedReads += 1;
        return asyncFs.readFile(...args);
      },
    };
    t.assert(await rejectsCode(() => fingerprintPath(payload, { allowedRoots: [root], fsImpl: boundedFs, maxBytes: 3 }), 'FINGERPRINT_BYTE_LIMIT'), 'file fingerprint rejects an oversized file before hashing');
    t.assert(boundedReads === 0, 'oversized fingerprint rejection performs no file read');
    const growthFs = {
      ...asyncFs,
      async lstat(...args) {
        const stat = await asyncFs.lstat(...args);
        return new Proxy(stat, {
          get(target, property) {
            return property === 'size' ? 1 : Reflect.get(target, property, target);
          },
        });
      },
    };
    t.assert(await rejectsCode(() => fingerprintPath(payload, { allowedRoots: [root], fsImpl: growthFs, maxBytes: 3 }), 'FINGERPRINT_BYTE_LIMIT'), 'file growth after the initial stat remains bounded by the fingerprint read');
    const missing = await fingerprintPath(join(root, 'missing.txt'), { allowedRoots: [root] });
    t.assert(!missing.exists && missing.kind === 'missing' && missing.sha256 === null, 'missing path has an explicit fingerprint');
    const directory = await fingerprintDirectory(tree, { allowedRoots: [root] });
    t.assert(directory.entries.map(entry => entry.path).join(',') === 'a.txt,b.txt', 'directory manifest paths are slash-normalized and ordinal sorted');
    t.assert(directory.manifest_sha256 === sha256Canonical(directory.entries), 'directory manifest hash covers exact entry rows');
    t.assert(await rejectsCode(() => fingerprintPath(payload, { allowedRoots: ['relative-root'] }), 'INVALID_ALLOWED_ROOT'), 'relative allowed roots are rejected');

    const outside = makePrimitiveRoot('uemcp-outside-');
    try {
      const outsideDir = join(outside, 'outside');
      mkdirSync(outsideDir);
      writeFileSync(join(outsideDir, 'secret.txt'), 'outside', 'utf8');
      const junction = join(root, 'escaped');
      symlinkSync(outsideDir, junction, 'junction');
      t.assert(await rejectsCode(() => fingerprintPath(join(junction, 'secret.txt'), { allowedRoots: [root] }), 'PATH_OUTSIDE_ALLOWED_ROOT'), 'real-path escape through a junction is rejected');
    } finally {
      cleanupPrimitiveRoot(outside, 'uemcp-outside-');
    }
  } finally {
    cleanupPrimitiveRoot(root);
  }
}

// Recursive redaction preserves shape without preserving secret values.
{
  const redacted = redactSecrets({
    token: 'token-canary',
    nested: { api_key: 'key-canary', public_value: 'visible' },
    env: { PATH: 'path-canary' },
  });
  t.assert(redacted.token === '<redacted>' && redacted.nested.api_key === '<redacted>', 'known secret keys are redacted recursively');
  t.assert(redacted.nested.public_value === 'visible', 'non-secret values remain available');
  t.assert(redacted.env === '<redacted>', 'environment blocks are redacted by default');
  t.assert(throwsCode(() => assertNoSecretCanaries(redacted, ['visible']), 'SECRET_CANARY'), 'canary assertion finds a surviving canary');
  t.assert(assertNoSecretCanaries(redacted, ['token-canary', 'key-canary', 'path-canary']) === true, 'redacted secret canaries do not survive');
}

// The process runner never invokes a shell and bounds time/output.
{
  const runner = createProcessRunner({ defaultTimeoutMs: 2_000, defaultOutputLimitBytes: 1_024 });
  const argument = 'value with spaces & metacharacters | $(ignored)';
  const exact = await runner.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', argument]);
  t.assert(exact.status === 'exited' && exact.exitCode === 0 && exact.stdout === argument, 'process arguments remain one exact argument without shell interpretation');
  const nonzero = await runner.run(process.execPath, ['-e', 'process.stderr.write("failure"); process.exit(7)']);
  t.assert(nonzero.status === 'exited' && nonzero.exitCode === 7 && nonzero.stderr === 'failure', 'negative child exit remains distinct and bounded');
  const overflow = await runner.run(process.execPath, ['-e', 'process.stdout.write("x".repeat(4096))'], { outputLimitBytes: 128 });
  t.assert(overflow.status === 'output_limit' && overflow.stdout.length <= 128 && overflow.stdoutDiscardedBytes > 0, 'stdout overflow is classified and counted');
  const stderrOverflow = await runner.run(process.execPath, ['-e', 'process.stderr.write("y".repeat(4096))'], { outputLimitBytes: 128 });
  t.assert(stderrOverflow.status === 'output_limit' && stderrOverflow.stderr.length <= 128 && stderrOverflow.stderrDiscardedBytes > 0, 'stderr overflow is classified and counted');

  let killed = 0;
  const timeoutRunner = createProcessRunner({
    defaultTimeoutMs: 50,
    killTree: async child => {
      killed += 1;
      child.kill('SIGKILL');
    },
  });
  const timedOut = await timeoutRunner.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
  t.assert(timedOut.status === 'timed_out' && killed === 1, 'timeout invokes process-tree termination exactly once');

  let spawnOptions = null;
  const probeRunner = createProcessRunner({
    spawnImpl(executable, args, options) {
      spawnOptions = options;
      return spawn(executable, args, options);
    },
  });
  t.assert(spawnOptions === null, 'injected spawn is not invoked during runner construction');
  const probed = await probeRunner.run(process.execPath, ['-e', '']);
  t.assert(probed.status === 'exited' && spawnOptions.shell === false && spawnOptions.windowsHide === true, 'real spawn is forced to shell:false with a hidden Windows child');
}

// Windows-native helpers use fixed stdin programs and dedicated environment values.
{
  const root = makePrimitiveRoot();
  try {
    const target = join(root, 'tool with & metachar.exe');
    const replacement = join(root, 'replacement.tmp');
    const destination = join(root, 'destination.json');
    writeFileSync(target, 'tool', 'utf8');
    writeFileSync(replacement, 'new', 'utf8');
    writeFileSync(destination, 'old', 'utf8');
    const calls = [];
    const fakeRunner = {
      async run(executable, args, options) {
        calls.push({ executable, args, options });
        if (options.env.UEMCP_AUTHENTICODE_TARGET) {
          return { status: 'exited', exitCode: 0, stdout: '{"status":"Valid","signer_name":"Trusted Signer","thumbprint":"ABC123"}\r\n', stderr: '' };
        }
        if (options.env.UEMCP_METADATA_TARGET) {
          return { status: 'exited', exitCode: 0, stdout: `{"metadata_sha256":"${'a'.repeat(64)}","stream_count":1,"stream_bytes":12}`, stderr: '' };
        }
        return { status: 'exited', exitCode: 0, stdout: '{"status":"replaced"}', stderr: '' };
      },
    };

    const signature = await inspectAuthenticode(target, {
      runner: fakeRunner,
      systemRoot: 'C:\\Windows',
      expectedSignerNames: ['Trusted Signer'],
      allowedRoots: [root],
    });
    t.assert(signature.status === 'valid' && signature.signer_name === 'Trusted Signer', 'bounded Authenticode evidence accepts an expected signer');
    const authCall = calls[0];
    t.assert(WINDOWS_NATIVE_SCRIPTS.authenticode.includes('Import-Module -Name $module') && !WINDOWS_NATIVE_SCRIPTS.authenticode.includes('Import-Module -LiteralPath'), 'Authenticode helper uses the Windows PowerShell 5.1 module parameter');
    t.assert(!authCall.args.join(' ').includes(target) && !authCall.options.stdin.includes(target), 'Authenticode target is not interpolated into arguments or PowerShell source');
    t.assert(authCall.options.env.UEMCP_AUTHENTICODE_TARGET === resolve(target), 'Authenticode target crosses only a dedicated environment key');

    const mismatchRunner = {
      async run() {
        return { status: 'exited', exitCode: 0, stdout: '{"status":"Valid","signer_name":"Other","thumbprint":"ABC123"}', stderr: '' };
      },
    };
    const mismatch = await inspectAuthenticode(target, { runner: mismatchRunner, systemRoot: 'C:\\Windows', expectedSignerNames: ['Trusted Signer'], allowedRoots: [root] });
    t.assert(mismatch.status === 'invalid', 'unexpected Authenticode signer is invalid');
    const malformedRunner = {
      async run() {
        return { status: 'exited', exitCode: 0, stdout: '{}\n{}', stderr: '' };
      },
    };
    const malformed = await inspectAuthenticode(target, { runner: malformedRunner, systemRoot: 'C:\\Windows', allowedRoots: [root] });
    t.assert(malformed.status === 'unavailable', 'malformed or extra Authenticode output fails closed');

    const metadata = await fingerprintWindowsFileMetadata(target, { runner: fakeRunner, systemRoot: 'C:\\Windows', allowedRoots: [root] });
    t.assert(metadata.metadata_sha256 === 'a'.repeat(64) && metadata.stream_count === 1, 'metadata helper returns only aggregate evidence');
    const metadataCall = calls.find(call => call.options.env.UEMCP_METADATA_TARGET);
    t.assert(!metadataCall.options.stdin.includes(target) && !JSON.stringify(metadata).includes('tool with'), 'metadata helper does not expose paths or stream details');

    const replaced = await replaceFilePreservingMetadata({ replacementPath: replacement, destinationPath: destination, runner: fakeRunner, systemRoot: 'C:\\Windows' });
    t.assert(replaced.status === 'replaced', 'replacement helper accepts a normalized success response');
    const replaceCall = calls.find(call => call.options.env.UEMCP_REPLACEMENT_PATH);
    t.assert(!replaceCall.options.stdin.includes(replacement) && !replaceCall.args.join(' ').includes(destination), 'replacement paths are not interpolated into source or arguments');
    t.assert(calls.every(call => call.options.stdin.endsWith('\n\n')), 'multiline Windows PowerShell helpers use an executable blank-line terminator');
  } finally {
    cleanupPrimitiveRoot(root);
  }
}

// Windows lease inspection distinguishes a live owner from PID reuse without interpolating input.
{
  const calls = [];
  const outputs = [
    { state: 'alive', process_start: 10_000 },
    { state: 'alive', process_start: 30_000 },
    { state: 'dead' },
    { state: 'unexpected' },
  ];
  const runner = {
    async run(executable, args, options) {
      calls.push({ executable, args, options });
      return { status: 'exited', exitCode: 0, stderr: '', stdout: JSON.stringify(outputs.shift()) };
    },
  };
  t.assert(await inspectLeaseOwnerProcess({ pid: 4242, process_start: 10_100 }, { runner, platform: 'win32', systemRoot: 'C:\\Windows' }) === 'alive', 'Windows lease probe accepts a matching process start');
  t.assert(await inspectLeaseOwnerProcess({ pid: 4242, process_start: 10_000 }, { runner, platform: 'win32', systemRoot: 'C:\\Windows' }) === 'dead', 'Windows lease probe treats a reused PID as a dead prior owner');
  t.assert(await inspectLeaseOwnerProcess({ pid: 4242, process_start: 10_000 }, { runner, platform: 'win32', systemRoot: 'C:\\Windows' }) === 'dead', 'Windows lease probe recognizes a missing process');
  t.assert(await inspectLeaseOwnerProcess({ pid: 4242, process_start: 10_000 }, { runner, platform: 'win32', systemRoot: 'C:\\Windows' }) === 'unknown', 'Windows lease probe fails closed on malformed evidence');
  t.assert(calls.every(call => call.options.env.UEMCP_LEASE_PID === '4242' && !call.options.stdin.includes('4242') && call.options.stdin.endsWith('\n\n')), 'lease PID is passed only through a bounded helper environment');
}

// Local state is injectable, atomic, replay-aware, and lease protected.
{
  const root = makePrimitiveRoot('uemcp-local-state-');
  const aclCalls = [];
  let nowMs = Date.parse('2026-07-15T12:00:00.000Z');
  const processStates = new Map();
  const localState = createLocalState({
    root,
    aclRestrictor: async path => aclCalls.push(path),
    processInspector: async ({ pid, process_start }) => processStates.get(`${pid}:${process_start}`) ?? 'unknown',
    clock: () => nowMs,
    sleep: async ms => {
      nowMs += ms;
    },
  });
  try {
    const paths = localState.paths();
    t.assert(paths.root === resolve(root) && paths.lock.endsWith('deployment-apply-v1.lock'), 'local-state paths are rooted only in the injected test directory');
    const stateFile = join(paths.state, 'sample.json');
    await localState.writeJsonAtomic(stateFile, { b: 2, a: 1 });
    t.assert((await localState.readJson(stateFile)).a === 1, 'atomic local-state JSON round trips');
    t.assert(aclCalls.length > 0, 'local-state creation invokes the ACL restrictor');
    t.assert(!readFileSync(stateFile, 'utf8').includes('.tmp'), 'atomic write leaves no scratch filename in content');

    const target = join(root, 'target.bin');
    writeFileSync(target, Buffer.from([0, 1, 255]));
    chmodSync(target, 0o640);
    const stamp = new Date('2026-07-14T10:00:00.000Z');
    utimesSync(target, stamp, stamp);
    const snapshot = await localState.createSnapshot(target, { transactionId: 'tx-one' });
    writeFileSync(target, 'applied', 'utf8');
    t.assert(await rejectsCode(() => localState.restoreSnapshot(snapshot, { expectedCurrentHash: '0'.repeat(64) }), 'ROLLBACK_CONFLICT'), 'snapshot restore rejects concurrent content drift');
    await localState.restoreSnapshot(snapshot, { expectedCurrentHash: sha256Bytes(Buffer.from('applied')) });
    t.assert(readFileSync(target).equals(Buffer.from([0, 1, 255])), 'snapshot restores exact original bytes');
    t.assert(await rejectsCode(() => localState.createSnapshot(target, { transactionId: '.' }), 'LOCAL_STATE_UNAVAILABLE'), 'snapshot transaction rejects the current-directory segment');
    t.assert(await rejectsCode(() => localState.createSnapshot(target, { transactionId: '..' }), 'LOCAL_STATE_UNAVAILABLE'), 'snapshot transaction rejects the parent-directory segment');
    const linkedSnapshotTarget = join(root, 'linked-snapshot.bin');
    const linkedSnapshotAlias = join(root, 'linked-snapshot-alias.bin');
    writeFileSync(linkedSnapshotTarget, 'linked', 'utf8');
    linkSync(linkedSnapshotTarget, linkedSnapshotAlias);
    t.assert(await rejectsCode(() => localState.createSnapshot(linkedSnapshotTarget, { transactionId: 'tx-linked' }), 'UNSAFE_SNAPSHOT_TARGET'), 'snapshot creation rejects multiply linked targets');
    const snapshotOutside = makePrimitiveRoot('uemcp-snapshot-outside-');
    writeFileSync(join(snapshotOutside, 'redirected.bin'), 'outside', 'utf8');
    symlinkSync(snapshotOutside, join(root, 'snapshot-junction'), 'junction');
    t.assert(await rejectsCode(() => localState.createSnapshot(join(root, 'snapshot-junction', 'redirected.bin'), { transactionId: 'tx-junction' }), 'UNSAFE_SNAPSHOT_TARGET'), 'snapshot creation rejects a junction in the target ancestry');
    cleanupPrimitiveRoot(snapshotOutside, 'uemcp-snapshot-outside-');
    const rollbackTarget = join(root, 'rollback-link.bin');
    const rollbackAlias = join(root, 'rollback-link-alias.bin');
    writeFileSync(rollbackTarget, 'before', 'utf8');
    const rollbackSnapshot = await localState.createSnapshot(rollbackTarget, { transactionId: 'tx-rollback-link' });
    writeFileSync(rollbackTarget, 'applied', 'utf8');
    linkSync(rollbackTarget, rollbackAlias);
    t.assert(await rejectsCode(() => localState.restoreSnapshot(rollbackSnapshot, { expectedCurrentHash: sha256Bytes(Buffer.from('applied')) }), 'ROLLBACK_CONFLICT'), 'snapshot rollback rejects a target that gained another hard link');
    const absentTarget = join(root, 'created-during-apply.bin');
    const absentSnapshot = await localState.createSnapshot(absentTarget, { transactionId: 'tx-absent' });
    writeFileSync(absentTarget, 'created', 'utf8');
    await localState.restoreSnapshot(absentSnapshot, { expectedCurrentHash: sha256Bytes(Buffer.from('created')) });
    t.assert(!existsSync(absentTarget), 'snapshot restores an originally absent file to absence');

    const digest = '9'.repeat(64);
    t.assert(!(await localState.wasDigestApplied(digest)), 'fresh digest is not replayed');
    await localState.markDigestApplied(digest, { receipt_sha256: '8'.repeat(64) });
    t.assert(await localState.wasDigestApplied(digest), 'applied digest is persisted for replay protection');

    processStates.set('123:1000', 'alive');
    const lease = await localState.acquireApplyLease({ pid: 123, processStart: 1000, waitMs: 0 });
    t.assert(typeof lease.ownerToken === 'string' && lease.ownerToken.length >= 16, 'apply lease has an unguessable owner token');
    t.assert(await rejectsCode(() => localState.acquireApplyLease({ pid: 456, processStart: 2000, waitMs: 25, pollMs: 5 }), 'APPLY_IN_PROGRESS'), 'second live lease owner is bounded and rejected');
    t.assert(await rejectsCode(() => lease.release('wrong-token'), 'LEASE_OWNER_MISMATCH'), 'only the matching lease owner may release');
    await lease.release();

    writeFileSync(paths.lock, '{}', 'utf8');
    t.assert(await rejectsCode(() => localState.acquireApplyLease({ pid: 456, processStart: 2000, waitMs: 0 }), 'APPLY_IN_PROGRESS'), 'malformed lease residue is never broken automatically');
    rmSync(paths.lock, { force: true });

    const deadLease = { owner_token: 'dead-owner-token', pid: 321, process_start: 3000, acquired_at: new Date(nowMs - 60_000).toISOString() };
    mkdirSync(dirname(paths.lock), { recursive: true });
    writeFileSync(paths.lock, canonicalJson(deadLease), 'utf8');
    processStates.set('321:3000', 'dead');
    nowMs += 10_000;
    const reclaimed = await localState.acquireApplyLease({ pid: 654, processStart: 4000, waitMs: 100, pollMs: 5, staleGraceMs: 5_000 });
    t.assert(reclaimed.ownerToken !== deadLease.owner_token, 'proven-dead lease is reclaimed after the grace period');
    await reclaimed.release();
  } finally {
    cleanupPrimitiveRoot(root, 'uemcp-local-state-');
  }
}

// Local-state containment rejects junction traversal before any escaped write.
{
  const root = makePrimitiveRoot('uemcp-local-link-');
  const outside = makePrimitiveRoot('uemcp-local-outside-');
  try {
    symlinkSync(outside, join(root, 'state'), 'junction');
    const localState = createLocalState({ root, aclRestrictor: async () => {} });
    const escaped = join(root, 'state', 'escaped.json');
    t.assert(await rejectsCode(() => localState.writeJsonAtomic(escaped, { value: true }), 'LOCAL_STATE_PATH_ESCAPE'), 'local-state junction escape is rejected');
    t.assert(!existsSync(join(outside, 'escaped.json')), 'rejected local-state junction causes no outside write');

    rmSync(join(root, 'state'), { force: true });
    mkdirSync(join(root, 'plans'), { recursive: true });
    const outsideLedger = join(outside, 'ledger.json');
    writeFileSync(outsideLedger, '{"schema_version":"1.0","applied":{}}\n', 'utf8');
    linkSync(outsideLedger, join(root, 'plans', 'applied-v1.json'));
    t.assert(await rejectsCode(() => localState.wasDigestApplied('7'.repeat(64)), 'LOCAL_STATE_PATH_ESCAPE'), 'hard-linked replay ledger is rejected');
  } finally {
    cleanupPrimitiveRoot(root, 'uemcp-local-link-');
    cleanupPrimitiveRoot(outside, 'uemcp-local-outside-');
  }
}

// Source provenance accepts attributable checkouts and pinned archive baselines only.
{
  const sandbox = makePrimitiveRoot('uemcp-provenance-');
  const root = join(sandbox, 'archive');
  const aliasRoot = join(sandbox, 'archive-alias');
  try {
    mkdirSync(root);
    symlinkSync(root, aliasRoot, 'junction');
    const bundleManifest = join(root, 'deploy-uemcp.manifest.json');
    const aliasedBundleManifest = join(aliasRoot, 'deploy-uemcp.manifest.json');
    const payload = join(root, 'server', 'server.mjs');
    mkdirSync(dirname(payload), { recursive: true });
    writeFileSync(bundleManifest, '{"schema_version":"1.0"}\n', 'utf8');
    writeFileSync(payload, 'export const value = 1;\n', 'utf8');
    const payloadEntries = [{ path: 'server/server.mjs', size: readFileSync(payload).byteLength, sha256: sha256Bytes(readFileSync(payload)) }];
    const provenance = {
      schema_version: '1.0',
      kind: 'pinned_github_archive',
      repository: 'owner/UEMCP',
      requested_ref: 'v1.0.0',
      git_commit: 'a'.repeat(40),
      archive_sha256: 'b'.repeat(64),
      bundle_manifest_sha256: sha256Bytes(readFileSync(bundleManifest)),
      payload_entries: payloadEntries,
      payload_manifest_sha256: sha256Canonical(payloadEntries),
      downloaded_at: '2026-07-15T10:00:00.000Z',
    };
    provenance.provenance_sha256 = sha256Canonical(provenance);
    writeFileSync(join(root, '.uemcp-source-provenance.json'), `${canonicalJson(provenance)}\n`, 'utf8');

    const pinned = await inspectSourceProvenance({ repoRoot: aliasRoot, bundleManifestPath: aliasedBundleManifest });
    t.assert(pinned.kind === 'pinned_archive' && pinned.dirty === false, 'verified pinned archive is attributable and clean');
    t.assert(!JSON.stringify(pinned).includes('payload_entries'), 'pinned source result never exposes payload entries');
    writeFileSync(payload, 'export const value = 2;\n', 'utf8');
    const changed = await inspectSourceProvenance({ repoRoot: aliasRoot, bundleManifestPath: aliasedBundleManifest });
    t.assert(changed.dirty === true && changed.archive.current_manifest_sha256 !== changed.archive.baseline_manifest_sha256, 'changed archive payload is attributable but dirty');
    writeFileSync(join(root, 'unexpected.txt'), 'extra', 'utf8');
    t.assert(await rejectsCode(() => inspectSourceProvenance({ repoRoot: aliasRoot, bundleManifestPath: aliasedBundleManifest }), 'SOURCE_PROVENANCE_UNKNOWN'), 'unrecognized archive extras fail provenance closed');
  } finally {
    cleanupPrimitiveRoot(sandbox, 'uemcp-provenance-');
  }
}

{
  const sandbox = makePrimitiveRoot('uemcp-checkout-');
  const root = join(sandbox, 'checkout');
  const aliasRoot = join(sandbox, 'checkout-alias');
  try {
    mkdirSync(root);
    symlinkSync(root, aliasRoot, 'junction');
    mkdirSync(join(root, '.git'));
    const gitExecutable = join(aliasRoot, 'trusted-git.exe');
    writeFileSync(gitExecutable, 'sample-binary', 'utf8');
    const calls = [];
    const runner = {
      async run(executable, args) {
        calls.push({ executable, args });
        const command = args.join(' ');
        if (command === '--version') return { status: 'exited', exitCode: 0, stdout: 'git version 2.50.1.windows.1\n', stderr: '' };
        if (command === 'rev-parse --show-toplevel') return { status: 'exited', exitCode: 0, stdout: `${aliasRoot}\n`, stderr: '' };
        if (command === 'config --get remote.origin.url') return { status: 'exited', exitCode: 0, stdout: 'https://user:credential-canary@github.com/owner/UEMCP.git?token=secret#fragment\n', stderr: '' };
        if (command === 'rev-parse HEAD') return { status: 'exited', exitCode: 0, stdout: `${'c'.repeat(40)}\n`, stderr: '' };
        if (command === 'status --porcelain=v1 --untracked-files=all') return { status: 'exited', exitCode: 0, stdout: '?? local.txt\n', stderr: '' };
        throw new Error(`unexpected git command: ${command}`);
      },
    };
    const checkout = await inspectSourceProvenance({
      repoRoot: aliasRoot,
      runner,
      gitExecutable,
      authenticodeInspector: async () => ({ status: 'valid', signer_name: 'Git for Windows', thumbprint: 'ABC' }),
    });
    t.assert(checkout.kind === 'git_checkout' && checkout.dirty === true, 'checkout provenance uses exact Git evidence including untracked files');
    t.assert(checkout.repository === 'owner/UEMCP', 'GitHub remote normalizes to owner/repository identity');
    t.assert(!JSON.stringify(checkout).includes('credential-canary') && !JSON.stringify(checkout).includes('secret'), 'remote credentials, query, and fragment never survive');
    t.assert(calls.every(call => call.executable === resolve(gitExecutable)), 'checkout probes only the selected absolute Git executable');
  } finally {
    cleanupPrimitiveRoot(sandbox, 'uemcp-checkout-');
  }
}

{
  const root = makePrimitiveRoot('uemcp-git-discovery-');
  try {
    mkdirSync(join(root, '.git'));
    const programFiles = join(root, 'Programs');
    const discoveredGit = join(programFiles, 'Git', 'cmd', 'git.exe');
    mkdirSync(dirname(discoveredGit), { recursive: true });
    writeFileSync(discoveredGit, 'sample-binary', 'utf8');
    const runner = {
      async run(executable, args) {
        t.assert(executable === resolve(discoveredGit), 'default discovery invokes only the absolute candidate');
        const command = args.join(' ');
        if (command === '--version') return { status: 'exited', exitCode: 0, stdout: 'git version 2.50.1.windows.1\n', stderr: '' };
        if (command === 'rev-parse --show-toplevel') return { status: 'exited', exitCode: 0, stdout: `${root}\n`, stderr: '' };
        if (command === 'config --get remote.origin.url') return { status: 'exited', exitCode: 0, stdout: 'https://github.com/owner/UEMCP.git\n', stderr: '' };
        if (command === 'rev-parse HEAD') return { status: 'exited', exitCode: 0, stdout: `${'d'.repeat(40)}\n`, stderr: '' };
        if (command === 'status --porcelain=v1 --untracked-files=all') return { status: 'exited', exitCode: 0, stdout: '', stderr: '' };
        throw new Error(`unexpected git command: ${command}`);
      },
    };
    const checkout = await inspectSourceProvenance({
      repoRoot: root,
      runner,
      environment: { ProgramFiles: programFiles },
      authenticodeInspector: async executable => ({
        status: executable === resolve(discoveredGit) ? 'valid' : 'invalid',
        signer_name: 'Git for Windows',
        thumbprint: 'DEF',
      }),
    });
    t.assert(checkout.kind === 'git_checkout' && checkout.dirty === false, 'default Git discovery accepts a verified fixed-install candidate');
  } finally {
    cleanupPrimitiveRoot(root, 'uemcp-git-discovery-');
  }
}

const failed = t.summary();
process.exit(failed ? 1 : 0);
