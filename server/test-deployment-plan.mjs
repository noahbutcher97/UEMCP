// Canonical descriptor, target domain, plan, and receipt tests.
//
// Run: cd server && node test-deployment-plan.mjs

import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { TestRunner } from './test-helpers.mjs';
import { canonicalJson, sha256Bytes } from './deployment/canonical-json.mjs';
import { createMachineResult, createStageResult } from './deployment/contracts.mjs';
import { createCanonicalDescriptor, descriptorsEqual } from './deployment/descriptor.mjs';
import { fingerprintPath } from './deployment/fingerprints.mjs';
import { createDeploymentOrchestrator } from './deployment/orchestrator.mjs';
import {
  computePlanDigest,
  createPlanDocument,
  validatePlanForApply,
} from './deployment/plan-document.mjs';
import { readAndVerifyReceipt, writeReceipt } from './deployment/receipts.mjs';
import { createTargetDomain } from './deployment/target-domain.mjs';
import { runCli } from './deploy-uemcp.mjs';
import {
  parseTargetProfilesFile,
  readProjectTargets,
  registerProjectTargetProfile,
  resolveDefaultTargetsPath,
} from './project-targets.mjs';

const t = new TestRunner('Deployment Plan Tests');

function makeRoot(label = 'uemcp-plan-') {
  const root = join(tmpdir(), `${label}${randomUUID()}`);
  mkdirSync(root);
  return root;
}

function cleanup(root, label = 'uemcp-plan-') {
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

function writeProject(root, name = 'SampleProject') {
  mkdirSync(join(root, 'Content'), { recursive: true });
  const path = join(root, `${name}.uproject`);
  writeFileSync(path, '{"FileVersion":3}\n', 'utf8');
  return path;
}

// The descriptor is exact, project-neutral, and path canonical.
{
  const root = makeRoot();
  try {
    const runtimeRoot = join(root, 'Runtime With Spaces');
    const serverRoot = join(root, '\u30b5\u30fc\u30d0\u30fc');
    mkdirSync(runtimeRoot, { recursive: true });
    mkdirSync(serverRoot, { recursive: true });
    const nodeExecutable = join(runtimeRoot, 'node.exe');
    const serverEntry = join(serverRoot, 'server.mjs');
    writeFileSync(nodeExecutable, 'node-sample', 'utf8');
    writeFileSync(serverEntry, 'export {};\n', 'utf8');
    const descriptor = await createCanonicalDescriptor({
      nodeExecutable,
      serverEntry,
      allowedRoots: [runtimeRoot, serverRoot],
    });
    t.assert(descriptor.command === resolve(nodeExecutable) && descriptor.args[0] === resolve(serverEntry), 'descriptor preserves exact absolute paths with spaces and Unicode');
    t.assert(descriptor.name === 'uemcp' && descriptor.transport === 'stdio', 'descriptor uses the canonical name and stdio transport');
    t.assert(Object.isFrozen(descriptor) && Object.isFrozen(descriptor.args) && Object.isFrozen(descriptor.env), 'descriptor and nested values are frozen');
    t.assert(JSON.stringify(descriptor.env) === '{}' && descriptor.cwd === null, 'descriptor has an empty environment and no working directory');
    t.assert(!/UNREAL_PROJECT|UEMCP_PROJECT_ATTACH_MODE|UEMCP_ENABLE_PYTHON_EXEC/.test(JSON.stringify(descriptor)), 'descriptor contains no project or Python execution pin');
    t.assert(descriptorsEqual(descriptor, structuredClone(descriptor)), 'descriptor equals an exact semantic copy');
    t.assert(!descriptorsEqual(descriptor, { ...structuredClone(descriptor), env: { EXTRA: '1' } }), 'descriptor equality does not ignore extra environment');
    t.assert(!descriptorsEqual(descriptor, { ...structuredClone(descriptor), args: [...descriptor.args, '--extra'] }), 'descriptor equality does not ignore extra arguments');
  } finally {
    cleanup(root);
  }
}

// Default target paths follow source provenance and keep archive state stable.
{
  const root = makeRoot();
  try {
    const checkout = join(root, 'checkout');
    const archiveA = join(root, 'cache', 'commit-a');
    const archiveB = join(root, 'cache', 'commit-b');
    const state = join(root, 'state');
    mkdirSync(join(checkout, '.git'), { recursive: true });
    mkdirSync(archiveA, { recursive: true });
    mkdirSync(archiveB, { recursive: true });
    mkdirSync(state, { recursive: true });
    writeFileSync(join(archiveA, '.uemcp-source-provenance.json'), '{}', 'utf8');
    writeFileSync(join(archiveB, '.uemcp-source-provenance.json'), '{}', 'utf8');

    const checkoutPath = resolveDefaultTargetsPath({ repoRoot: checkout, stateRoot: state });
    const archivePathA = resolveDefaultTargetsPath({ repoRoot: archiveA, stateRoot: state });
    const archivePathB = resolveDefaultTargetsPath({ repoRoot: archiveB, stateRoot: state });
    t.assert(checkoutPath === join(resolve(checkout), '.uemcp-targets.json'), 'checkout defaults to its repository target file');
    t.assert(archivePathA === join(resolve(state), '.uemcp-targets.json') && archivePathA === archivePathB, 'archive cache revisions share one stable state target file');

    mkdirSync(join(archiveA, '.git'));
    t.assert(resolveDefaultTargetsPath({ repoRoot: archiveA, stateRoot: state }) === join(resolve(archiveA), '.uemcp-targets.json'), 'checkout marker wins when both source markers exist');
    const explicit = join(root, 'selected', 'targets.json');
    t.assert(resolveDefaultTargetsPath({ repoRoot: checkout, stateRoot: state, explicitTargetsPath: explicit }) === resolve(explicit), 'explicit target file has highest precedence');
    t.assert(await rejectsCode(() => Promise.resolve(resolveDefaultTargetsPath({ repoRoot: checkout, stateRoot: state, explicitTargetsPath: 'relative.json' })), 'INVALID_TARGET'), 'relative explicit target file is rejected');
    t.assert(await rejectsCode(() => Promise.resolve(resolveDefaultTargetsPath({ repoRoot: archiveB, sourceKind: 'pinned_archive' })), 'LOCAL_STATE_UNAVAILABLE'), 'archive mode without stable state fails closed');
  } finally {
    cleanup(root);
  }
}

// Registration dry runs preserve unknown fields and never write.
{
  const root = makeRoot();
  try {
    const project = writeProject(join(root, 'Project'));
    const config = join(root, '.uemcp-targets.json');
    const original = {
      version: 1,
      owner_note: { keep: true },
      profiles: { default: [] },
      targets: {
        existing: { uproject: join(root, 'Elsewhere', 'Other.uproject'), custom: { keep: true } },
      },
    };
    writeFileSync(config, `${JSON.stringify(original, null, 2)}\n`, 'utf8');
    const before = readFileSync(config, 'utf8');
    const planned = registerProjectTargetProfile({ configPath: config, uprojectPath: project, dryRun: true });
    t.assert(readFileSync(config, 'utf8') === before, 'dry-run registration performs no write');
    t.assert(planned.status === 'added' && planned.document.owner_note.keep === true, 'dry-run document preserves unknown top-level fields');
    t.assert(planned.document.targets.existing.custom.keep === true, 'dry-run document preserves unknown target fields');
    t.assert(planned.serialized.endsWith('\n') && parseTargetProfilesFile(planned.serialized).targets[planned.alias].uproject === project, 'dry-run returns the complete proposed structured document');
  } finally {
    cleanup(root);
  }
}

// The target domain binds reviewed bytes to apply and becomes idempotent.
{
  const root = makeRoot();
  try {
    const repoRoot = join(root, 'repo');
    const stateRoot = join(root, 'state');
    mkdirSync(join(repoRoot, '.git'), { recursive: true });
    mkdirSync(stateRoot, { recursive: true });
    const project = writeProject(join(root, 'Game'));
    const config = join(repoRoot, '.uemcp-targets.json');
    writeFileSync(config, '{"version":1,"profiles":{},"targets":{},"keep":"value"}\n', 'utf8');
    const replacements = [];
    const windowsNative = {
      async replaceFilePreservingMetadata({ replacementPath, destinationPath }) {
        replacements.push({ replacementPath, destinationPath });
        renameSync(replacementPath, destinationPath);
        return { status: 'replaced' };
      },
    };
    const domain = createTargetDomain({ repoRoot, stateRoot, sourceKind: 'git_checkout', windowsNative });
    const explicitDomain = createTargetDomain({ repoRoot, stateRoot, sourceKind: 'git_checkout', targetsPath: config, windowsNative });
    const explicitOnly = await explicitDomain.plan({ request: { requested_project: null, requested_profile: 'smoke' } });
    t.assert(explicitOnly.operations.length === 0 && explicitOnly.preconditions.length === 1 && explicitOnly.preconditions[0].canonical_path === resolve(config), 'explicit target registry is fingerprint-bound even without direct project registration');
    const context = { request: { requested_project: project, requested_profile: null } };
    const planned = await domain.plan(context);
    t.assert(domain.name === 'target' && domain.order === 20, 'target domain has the locked identity and order');
    t.assert(planned.operations.length === 1 && planned.operations[0].kind === 'REGISTER_PROJECT_TARGET', 'unregistered project plans one structured target operation');
    t.assert(planned.preconditions.length === 1 && planned.operations[0].proposed_sha256 === planned.preconditions[0].proposed_sha256, 'planned target bytes are digest-bound to their precondition');
    const applied = await domain.apply(context, planned.operations);
    t.assert(applied.status === 'REGISTERED' && replacements.length === 1, 'existing target file uses one metadata-preserving replacement');
    const parsed = JSON.parse(readFileSync(config, 'utf8'));
    t.assert(parsed.keep === 'value', 'target apply preserves unrelated top-level settings');
    const verified = await domain.verify(context);
    t.assert(verified.status === 'ALREADY_REGISTERED', 'target verify observes the registered project');
    const rerun = await domain.plan(context);
    t.assert(rerun.operations.length === 0 && rerun.stages[0].status === 'ALREADY_REGISTERED', 'healthy target rerun is a no-op');

    const firstWriteConfig = join(repoRoot, 'first-write.json');
    const firstWriteDomain = createTargetDomain({
      repoRoot,
      stateRoot,
      sourceKind: 'git_checkout',
      targetsPath: firstWriteConfig,
      windowsNative,
    });
    const firstWritePlan = await firstWriteDomain.plan(context);
    const firstWrite = await firstWriteDomain.apply(context, firstWritePlan.operations);
    t.assert(firstWrite.status === 'REGISTERED' && existsSync(firstWriteConfig) && replacements.length === 1, 'absent target registry uses guarded first creation without replacement');

    const externalConfig = join(root, 'explicit', 'targets.json');
    mkdirSync(join(root, 'explicit'), { recursive: true });
    writeFileSync(externalConfig, '{"version":1,"profiles":{},"targets":{}}\n', 'utf8');
    const explicitPlanner = createTargetDomain({
      repoRoot,
      stateRoot,
      sourceKind: 'git_checkout',
      targetsPath: externalConfig,
      windowsNative,
    });
    const explicitPlan = await explicitPlanner.plan(context);
    const freshDefaultDomain = createTargetDomain({ repoRoot, stateRoot, sourceKind: 'git_checkout', windowsNative });
    const explicitApply = await freshDefaultDomain.apply(context, explicitPlan.operations);
    const reviewedAlias = explicitPlan.operations[0].alias;
    t.assert(explicitApply.status === 'REGISTERED' && JSON.parse(readFileSync(externalConfig, 'utf8')).targets[reviewedAlias], 'fresh apply consumes the explicit registry path sealed into the reviewed operation');

    const verificationConfig = join(repoRoot, 'verification-failure.json');
    writeFileSync(verificationConfig, '{"version":1,"profiles":{},"targets":{}}\n', 'utf8');
    const corruptingDomain = createTargetDomain({
      repoRoot,
      stateRoot,
      sourceKind: 'git_checkout',
      targetsPath: verificationConfig,
      windowsNative: {
        async replaceFilePreservingMetadata({ replacementPath, destinationPath }) {
          renameSync(replacementPath, destinationPath);
          writeFileSync(destinationPath, 'corrupt-after-write', 'utf8');
          return { status: 'replaced' };
        },
      },
    });
    const verificationPlan = await corruptingDomain.plan(context);
    const verificationFailure = await corruptingDomain.apply(context, verificationPlan.operations);
    t.assert(verificationFailure.status === 'SYNC_FAILED' && verificationFailure.changed, 'post-write target verification failure returns committed failure evidence instead of escaping unreceipted');

    const secondProject = writeProject(join(root, 'SecondGame'), 'SecondGame');
    const stalePlan = await domain.plan({ request: { requested_project: secondProject, requested_profile: null } });
    writeFileSync(config, `${readFileSync(config, 'utf8').trim()} \n`, 'utf8');
    t.assert(await rejectsCode(() => domain.apply({ request: { requested_project: secondProject, requested_profile: null } }, stalePlan.operations), 'PLAN_STALE'), 'concurrent target-file byte drift prevents every write');

    const linkedConfig = join(repoRoot, 'linked-targets.json');
    linkSync(config, linkedConfig);
    const linkedDomain = createTargetDomain({ repoRoot, stateRoot, sourceKind: 'git_checkout', targetsPath: linkedConfig, windowsNative });
    t.assert(await rejectsCode(() => linkedDomain.plan(context), 'INVALID_TARGET'), 'multiply linked target registry is rejected before planning');
  } finally {
    cleanup(root);
  }
}

// Pinned-source reads inherit the stable default without client configuration side effects.
{
  const root = makeRoot();
  try {
    const repoRoot = join(root, 'archive');
    const stateRoot = join(root, 'state');
    mkdirSync(repoRoot, { recursive: true });
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(join(repoRoot, '.uemcp-source-provenance.json'), '{}', 'utf8');
    const project = writeProject(join(root, 'Project'));
    writeFileSync(join(stateRoot, '.uemcp-targets.json'), `${JSON.stringify({ version: 1, profiles: { default: ['project'] }, targets: { project: { uproject: project } } }, null, 2)}\n`, 'utf8');
    const read = readProjectTargets({ repoRoot, stateRoot, sourceKind: 'pinned_archive', clientRoots: [root] });
    t.assert(read.targetsPath === join(resolve(stateRoot), '.uemcp-targets.json') && read.candidates.length === 1, 'normal target reader uses stable archive state by default');
    t.assert(!existsSync(join(resolve(repoRoot), '.uemcp-targets.json')), 'archive target read does not create a cache-local file');
    rmSync(join(stateRoot, '.uemcp-targets.json'));
    const absent = readProjectTargets({ repoRoot, stateRoot, sourceKind: 'pinned_archive', clientRoots: [root] });
    t.assert(absent.status === 'absent' && absent.targetsPath === join(resolve(stateRoot), '.uemcp-targets.json'), 'absent archive registry still reports the stable state path');
  } finally {
    cleanup(root);
  }
}

function sampleSource(root, overrides = {}) {
  return {
    kind: 'git_checkout',
    repository: 'owner/UEMCP',
    repo_root: resolve(root),
    git_commit: 'a'.repeat(40),
    dirty: false,
    archive: null,
    orchestrator_version: '1.0.0',
    ...overrides,
  };
}

function sampleDescriptor(root) {
  return {
    name: 'uemcp',
    transport: 'stdio',
    command: join(resolve(root), 'node.exe'),
    args: [join(resolve(root), 'server.mjs')],
    env: {},
    cwd: null,
  };
}

function sampleRequest(overrides = {}) {
  return {
    requested_project: null,
    requested_profile: null,
    selected_clients: [],
    ...overrides,
  };
}

function createReviewedPlan({ root, reviewed, now = new Date('2026-07-15T12:00:00.000Z'), overrides = {} }) {
  return createPlanDocument({
    operation: 'setup',
    outcome: 'ACTION_REQUIRED',
    source: sampleSource(root),
    request: sampleRequest(),
    descriptor: sampleDescriptor(root),
    stages: [createStageResult({ name: 'target', status: 'REGISTERED', result: 'action_required' })],
    preconditions: [{
      kind: 'file',
      label: 'target-config',
      canonical_path: reviewed.canonical_path,
      fingerprint: reviewed,
    }],
    operations: [{
      operation_id: 'target:register:sample',
      domain: 'target',
      domain_order: 20,
      kind: 'REGISTER_PROJECT_TARGET',
      config_path: reviewed.canonical_path,
    }],
    clients: [],
    actions: [],
    now,
    ...overrides,
  });
}

// Plans are canonical, complete previews whose digest binds every authorization input.
{
  const root = makeRoot();
  try {
    const config = join(root, 'targets.json');
    writeFileSync(config, '{"version":1}\n', 'utf8');
    const reviewed = await fingerprintPath(config, { allowedRoots: [root] });
    const plan = createReviewedPlan({ root, reviewed });
    t.assert(plan.kind === 'uemcp.deployment.plan' && plan.schema_version === '1.0', 'saved plan uses the versioned public kind');
    t.assert(plan.created_at === '2026-07-15T12:00:00.000Z' && plan.expires_at === '2026-07-15T12:30:00.000Z', 'saved plan expires exactly 30 minutes after creation');
    t.assert(plan.digest === computePlanDigest({ ...plan, digest: undefined }), 'stored digest covers the canonical plan body');
    t.assert(!Object.hasOwn(plan.stages[0], 'result') && !Object.hasOwn(plan.stages[0], 'progress'), 'saved plan stages keep the locked public schema');

    const reorderedSource = {
      orchestrator_version: '1.0.0',
      archive: null,
      dirty: false,
      git_commit: 'a'.repeat(40),
      repo_root: resolve(root),
      repository: 'owner/UEMCP',
      kind: 'git_checkout',
    };
    const reordered = createReviewedPlan({ root, reviewed, overrides: { source: reorderedSource } });
    t.assert(reordered.digest === plan.digest, 'object insertion order cannot change the canonical plan digest');
    const sourceChanged = createReviewedPlan({ root, reviewed, overrides: { source: sampleSource(root, { git_commit: 'b'.repeat(40) }) } });
    t.assert(sourceChanged.digest !== plan.digest, 'source commit changes the plan digest');
    const operationChanged = createReviewedPlan({
      root,
      reviewed,
      overrides: {
        operations: [{ operation_id: 'target:register:changed', domain: 'target', domain_order: 20, kind: 'REGISTER_PROJECT_TARGET', config_path: reviewed.canonical_path }],
      },
    });
    t.assert(operationChanged.digest !== plan.digest, 'operation identity changes the plan digest');
    const expiryChanged = createReviewedPlan({ root, reviewed, overrides: { ttlMs: 60_000 } });
    t.assert(expiryChanged.digest !== plan.digest, 'expiry changes the plan digest');

    const valid = await validatePlanForApply({
      plan,
      approvedDigest: plan.digest,
      now: new Date('2026-07-15T12:29:59.999Z'),
      fingerprint: async () => fingerprintPath(config, { allowedRoots: [root] }),
      localState: { wasDigestApplied: async () => false },
    });
    t.assert(valid.ok === true && valid.plan.digest === plan.digest, 'unchanged approved plan validates before apply');

    const tampered = structuredClone(plan);
    tampered.operations[0].kind = 'OTHER_OPERATION';
    t.assert(await rejectsCode(() => validatePlanForApply({ plan: tampered, approvedDigest: plan.digest, now: new Date('2026-07-15T12:10:00.000Z') }), 'PLAN_DIGEST_MISMATCH'), 'tampered stored plan is rejected');
    const domainTampered = structuredClone(plan);
    domainTampered.operations[0].domain = 'unknown-domain';
    t.assert(await rejectsCode(() => validatePlanForApply({ plan: domainTampered, approvedDigest: plan.digest, now: new Date('2026-07-15T12:10:00.000Z') }), 'PLAN_DIGEST_MISMATCH'), 'digest validation precedes semantic interpretation of tampered operations');
    t.assert(await rejectsCode(() => validatePlanForApply({ plan, approvedDigest: 'f'.repeat(64), now: new Date('2026-07-15T12:10:00.000Z') }), 'PLAN_DIGEST_MISMATCH'), 'wrong approved digest is rejected');
    t.assert(await rejectsCode(() => validatePlanForApply({ plan, approvedDigest: plan.digest, now: new Date('2026-07-15T12:30:00.000Z') }), 'PLAN_EXPIRED'), 'plan expires at the exact boundary');
    t.assert(await rejectsCode(() => validatePlanForApply({ plan, approvedDigest: plan.digest, now: new Date('2026-07-15T12:10:00.000Z'), localState: { wasDigestApplied: async () => true } }), 'PLAN_REPLAYED'), 'applied digest cannot be replayed');

    writeFileSync(config, '{"version":2}\n', 'utf8');
    let mutationCalls = 0;
    t.assert(await rejectsCode(() => validatePlanForApply({
      plan,
      approvedDigest: plan.digest,
      now: new Date('2026-07-15T12:10:00.000Z'),
      fingerprint: async () => fingerprintPath(config, { allowedRoots: [root] }),
      localState: {
        wasDigestApplied: async () => false,
        createSnapshot: async () => { mutationCalls += 1; },
        writeJsonAtomic: async () => { mutationCalls += 1; },
      },
    }), 'PLAN_STALE'), 'precondition drift rejects the complete plan');
    t.assert(mutationCalls === 0, 'every plan rejection occurs before snapshots or writes');
  } finally {
    cleanup(root);
  }
}

// Receipt hashes bind redacted evidence to its machine-local path label.
{
  const root = makeRoot();
  try {
    const receiptsRoot = join(root, 'receipts');
    mkdirSync(receiptsRoot);
    const config = join(root, 'targets.json');
    writeFileSync(config, '{}\n', 'utf8');
    const reviewed = await fingerprintPath(config, { allowedRoots: [root] });
    const plan = createReviewedPlan({ root, reviewed });
    const result = createMachineResult({
      operation: 'verify',
      source: sampleSource(root),
      request: sampleRequest(),
      descriptor: sampleDescriptor(root),
      plan: null,
      stages: [createStageResult({ name: 'target', status: 'VERIFIED' })],
      clients: [],
      receipts: [],
      actions: [],
      now: new Date('2026-07-15T12:05:00.000Z'),
    });
    result.stages[0].evidence = {
      token: 'receipt-token-canary',
      nested: { password: 'receipt-password-canary', safe_hash: 'a'.repeat(64) },
    };
    const localState = {
      paths: () => ({ receipts: receiptsRoot }),
      async writeJsonAtomic(path, value) {
        writeFileSync(path, `${canonicalJson(value)}\n`, 'utf8');
      },
    };
    const reference = await writeReceipt({ localState, result, plan });
    t.assert(reference.kind === 'deployment' && /^[0-9a-f]{64}$/.test(reference.sha256), 'receipt writer returns a stable hashed reference');
    const bytes = readFileSync(reference.path, 'utf8');
    t.assert(!bytes.includes('receipt-token-canary') && !bytes.includes('receipt-password-canary'), 'receipt JSON contains no secret canaries');
    const verified = await readAndVerifyReceipt(reference.path);
    t.assert(verified.receipt_sha256 === reference.sha256 && verified.plan.digest === plan.digest, 'receipt self-hash and plan digest verify');

    const copied = join(receiptsRoot, 'copied-receipt.json');
    copyFileSync(reference.path, copied);
    t.assert(await rejectsCode(() => readAndVerifyReceipt(copied), 'RECEIPT_INTEGRITY_FAILED'), 'copy-moved receipt cannot establish current state');
    const parsed = JSON.parse(bytes);
    parsed.outcome = 'FAILED';
    writeFileSync(reference.path, `${canonicalJson(parsed)}\n`, 'utf8');
    t.assert(await rejectsCode(() => readAndVerifyReceipt(reference.path), 'RECEIPT_INTEGRITY_FAILED'), 'tampered receipt fails its canonical self-hash');
  } finally {
    cleanup(root);
  }
}

// Orchestration composes deterministic domains and never replans during apply.
{
  const root = makeRoot();
  try {
    const calls = [];
    let planCalls = 0;
    let leaseHeld = false;
    let replayMarked = false;
    let applying = false;
    const makeDomain = ({ name, order, applyStage }) => ({
      name,
      order,
      async plan() {
        planCalls += 1;
        calls.push(`plan:${name}`);
        const actions = name === 'prerequisites'
          ? [{ code: 'DEPENDENCIES_INSTALL_REQUIRED', message: 'Install reviewed dependencies.', command: null }]
          : [];
        return {
          stages: [createStageResult({ name, status: 'STALE', result: 'action_required', actions })],
          operations: [{
            operation_id: `${name}:operation`,
            domain: name,
            domain_order: order,
            kind: `${name.toUpperCase()}_OPERATION`,
          }],
          preconditions: [],
          clients: [],
          actions,
        };
      },
      async apply(context, operations) {
        calls.push(`apply:${name}:${operations.map(row => row.operation_id).join(',')}`);
        t.assert(leaseHeld, `${name} apply runs while the lease is held`);
        return applyStage();
      },
      async verify() {
        calls.push(`verify:${name}`);
        return createStageResult({ name, status: 'VERIFIED' });
      },
    });
    const prerequisite = makeDomain({
      name: 'prerequisites',
      order: 10,
      applyStage: () => createStageResult({ name: 'prerequisites', status: 'READY', changed: true, progress: 'committed' }),
    });
    const target = makeDomain({
      name: 'target',
      order: 20,
      applyStage: () => createStageResult({ name: 'target', status: 'INVALID_TARGET', result: 'failed' }),
    });
    const localState = {
      async acquireApplyLease() {
        leaseHeld = true;
        calls.push('lease:acquired');
        return {
          async release() {
            calls.push('lease:released');
            leaseHeld = false;
          },
        };
      },
      async wasDigestApplied() {
        calls.push('replay:checked');
        return replayMarked;
      },
      async markDigestApplied() {
        calls.push('replay:marked');
        replayMarked = true;
      },
    };
    const orchestrator = createDeploymentOrchestrator({
      repoRoot: root,
      stateRoot: join(root, 'state'),
      domains: [target, prerequisite],
      localState,
      sourceProvider: async () => {
        if (applying) calls.push('source:checked');
        return sampleSource(root);
      },
      descriptorProvider: async () => sampleDescriptor(root),
      receiptWriter: async () => ({ kind: 'deployment', path_label: 'receipts/sample.json', sha256: 'd'.repeat(64) }),
      includeGenericClient: false,
      clock: () => new Date('2026-07-15T12:00:00.000Z'),
    });
    const request = { operation: 'setup', requested_project: null, requested_profile: null, selected_clients: [] };
    const plan = await orchestrator.plan(request);
    t.assert(calls.slice(0, 2).join(',') === 'plan:prerequisites,plan:target', 'domain planning is sorted by locked numeric order');
    t.assert(plan.operations.map(row => row.domain).join(',') === 'prerequisites,target', 'plan operations preserve deterministic domain order');
    const unsupportedPlan = structuredClone(plan);
    unsupportedPlan.operations.push({ operation_id: 'clients:unsupported', domain: 'clients', domain_order: 30, kind: 'CLIENT_WRITE' });
    unsupportedPlan.digest = computePlanDigest(unsupportedPlan);
    t.assert(await rejectsCode(() => orchestrator.apply({ plan: unsupportedPlan, approvedDigest: unsupportedPlan.digest }), 'UNSUPPORTED_INTERFACE'), 'apply rejects operations whose domain is unavailable in this orchestrator');
    t.assert(!calls.includes('lease:acquired'), 'unsupported operation domain is rejected before lease acquisition');
    const planCallsBeforeApply = planCalls;
    applying = true;
    const result = await orchestrator.apply({ plan, approvedDigest: plan.digest });
    t.assert(planCalls === planCallsBeforeApply, 'apply consumes saved operations without replanning');
    t.assert(calls.includes('apply:prerequisites:prerequisites:operation') && calls.includes('apply:target:target:operation'), 'each domain receives only its own operations');
    t.assert(result.outcome === 'PARTIAL' && result.plan.digest === plan.digest, 'committed success plus mandatory failure produces a digest-linked PARTIAL result');
    t.assert(!result.actions.some(action => action.code === 'DEPENDENCIES_INSTALL_REQUIRED'), 'apply omits remediation that the current stages resolved');
    t.assert(result.receipts.length === 1 && replayMarked, 'terminal apply writes receipt evidence and marks replay before release');
    t.assert(calls.indexOf('replay:checked') < calls.indexOf('source:checked'), 'replay rejection precedes fresh source and executable inspection');
    t.assert(calls.indexOf('replay:marked') < calls.indexOf('lease:released'), 'replay bookkeeping completes while the apply lease is held');

    const verified = await orchestrator.verify(request);
    t.assert(verified.operation === 'verify' && verified.plan === null, 'standalone verify never fabricates a consumed plan');
    const repaired = await orchestrator.repair(request);
    t.assert(repaired.kind === 'uemcp.deployment.plan' && repaired.operation === 'repair', 'repair is a digest-bound planning operation only');
  } finally {
    cleanup(root);
  }
}

// Domain planners cannot emit operations owned by another domain.
{
  const root = makeRoot();
  try {
    const orchestrator = createDeploymentOrchestrator({
      repoRoot: root,
      stateRoot: join(root, 'state'),
      domains: [{
        name: 'prerequisites',
        order: 10,
        async plan() {
          return {
            stages: [createStageResult({ name: 'prerequisites', status: 'STALE', result: 'action_required' })],
            operations: [{ operation_id: 'target:cross-owned', domain: 'target', domain_order: 20, kind: 'CROSS_DOMAIN_WRITE' }],
            preconditions: [],
          };
        },
        async apply() { return createStageResult({ name: 'prerequisites', status: 'READY' }); },
        async verify() { return createStageResult({ name: 'prerequisites', status: 'READY' }); },
      }],
      localState: { wasDigestApplied: async () => false },
      sourceProvider: async () => sampleSource(root),
      descriptorProvider: async () => sampleDescriptor(root),
      includeGenericClient: false,
      clock: () => new Date('2026-07-15T12:00:00.000Z'),
    });
    t.assert(await rejectsCode(() => orchestrator.plan({ operation: 'setup', requested_project: null, requested_profile: null, selected_clients: [] }), 'ORCHESTRATOR_FAILED'), 'planner rejects cross-domain operation ownership');
  } finally {
    cleanup(root);
  }
}

// Unresolved prerequisites cannot authorize downstream plans or writes.
{
  const root = makeRoot();
  try {
    let targetPlanCalls = 0;
    const prerequisite = {
      name: 'prerequisites',
      order: 10,
      async plan() {
        return {
          stages: [createStageResult({ name: 'prerequisites', status: 'NODE_MISSING', result: 'action_required' })],
          operations: [],
          preconditions: [],
        };
      },
      async apply() { return createStageResult({ name: 'prerequisites', status: 'NODE_MISSING', result: 'action_required' }); },
      async verify() { return createStageResult({ name: 'prerequisites', status: 'NODE_MISSING', result: 'action_required' }); },
    };
    const target = {
      name: 'target',
      order: 20,
      async plan() {
        targetPlanCalls += 1;
        return {
          stages: [createStageResult({ name: 'target', status: 'REGISTERED', result: 'action_required' })],
          operations: [{ operation_id: 'target:write', domain: 'target', domain_order: 20, kind: 'TARGET_WRITE' }],
          preconditions: [],
        };
      },
      async apply() { return createStageResult({ name: 'target', status: 'REGISTERED', changed: true }); },
      async verify() { return createStageResult({ name: 'target', status: 'NOT_CHECKED', mandatory: false, result: 'skipped' }); },
    };
    const orchestrator = createDeploymentOrchestrator({
      repoRoot: root,
      stateRoot: join(root, 'state'),
      domains: [prerequisite, target],
      localState: { wasDigestApplied: async () => false },
      sourceProvider: async () => sampleSource(root),
      descriptorProvider: async () => sampleDescriptor(root),
      includeGenericClient: false,
      clock: () => new Date('2026-07-15T12:00:00.000Z'),
    });
    const plan = await orchestrator.plan({ operation: 'setup', requested_project: null, requested_profile: null, selected_clients: [] });
    t.assert(targetPlanCalls === 0 && plan.operations.length === 0, 'unresolved prerequisite planning blocks every downstream domain operation');
  } finally {
    cleanup(root);
  }
}

// Prerequisite failure stops apply, while later races after committed progress become terminal evidence.
{
  const root = makeRoot();
  try {
    function makeOrchestrator({ prerequisiteApply, targetApply, counters }) {
      const prerequisite = {
        name: 'prerequisites',
        order: 10,
        async plan() {
          return {
            stages: [createStageResult({ name: 'prerequisites', status: 'STALE', result: 'action_required' })],
            operations: [{ operation_id: 'prerequisites:install', domain: 'prerequisites', domain_order: 10, kind: 'INSTALL_DEPENDENCIES' }],
            preconditions: [],
          };
        },
        async apply() { counters.prerequisite += 1; return prerequisiteApply(); },
        async verify() { return createStageResult({ name: 'prerequisites', status: 'READY' }); },
      };
      const target = {
        name: 'target',
        order: 20,
        async plan() {
          return {
            stages: [createStageResult({ name: 'target', status: 'REGISTERED', result: 'action_required' })],
            operations: [{ operation_id: 'target:write', domain: 'target', domain_order: 20, kind: 'TARGET_WRITE' }],
            preconditions: [],
          };
        },
        async apply() { counters.target += 1; return targetApply(); },
        async verify() { return createStageResult({ name: 'target', status: 'ALREADY_REGISTERED' }); },
      };
      const localState = {
        async acquireApplyLease() { return { async release() {} }; },
        async wasDigestApplied() { return false; },
        async markDigestApplied() { counters.replay += 1; },
      };
      return createDeploymentOrchestrator({
        repoRoot: root,
        stateRoot: join(root, 'state'),
        domains: [prerequisite, target],
        localState,
        sourceProvider: async () => sampleSource(root),
        descriptorProvider: async () => sampleDescriptor(root),
        receiptWriter: async () => {
          counters.receipt += 1;
          return { kind: 'deployment', path_label: 'receipts/gate.json', sha256: '3'.repeat(64) };
        },
        includeGenericClient: false,
        clock: () => new Date('2026-07-15T12:00:00.000Z'),
      });
    }

    const failedCounters = { prerequisite: 0, target: 0, receipt: 0, replay: 0 };
    const failedOrchestrator = makeOrchestrator({
      counters: failedCounters,
      prerequisiteApply: () => createStageResult({ name: 'prerequisites', status: 'INSTALL_FAILED', result: 'failed' }),
      targetApply: () => createStageResult({ name: 'target', status: 'REGISTERED', changed: true }),
    });
    const request = { operation: 'setup', requested_project: null, requested_profile: null, selected_clients: [] };
    const failedPlan = await failedOrchestrator.plan(request);
    const failedResult = await failedOrchestrator.apply({ plan: failedPlan, approvedDigest: failedPlan.digest });
    t.assert(failedResult.outcome === 'FAILED' && failedCounters.target === 0, 'failed prerequisite apply blocks every downstream domain write');

    const partialCounters = { prerequisite: 0, target: 0, receipt: 0, replay: 0 };
    const partialOrchestrator = makeOrchestrator({
      counters: partialCounters,
      prerequisiteApply: () => createStageResult({ name: 'prerequisites', status: 'READY', changed: true }),
      targetApply: () => {
        const error = new Error('race detail must not escape');
        error.code = 'PLAN_STALE';
        throw error;
      },
    });
    const partialPlan = await partialOrchestrator.plan(request);
    const partialResult = await partialOrchestrator.apply({ plan: partialPlan, approvedDigest: partialPlan.digest });
    t.assert(partialResult.outcome === 'PARTIAL' && partialResult.stages.at(-1).status === 'SYNC_FAILED', 'post-commit domain exception becomes a terminal partial stage');
    t.assert(partialCounters.receipt === 1 && partialCounters.replay === 1, 'post-commit domain exception writes a receipt and consumes the approved plan');
  } finally {
    cleanup(root);
  }
}

// Failed applies with no committed or rolled-back progress remain retryable.
{
  const root = makeRoot();
  try {
    let replayMarks = 0;
    const domain = {
      name: 'prerequisites',
      order: 10,
      async plan() {
        return {
          stages: [createStageResult({ name: 'prerequisites', status: 'STALE', result: 'action_required' })],
          operations: [{ operation_id: 'prerequisites:fail', domain: 'prerequisites', domain_order: 10, kind: 'FAIL_WITHOUT_PROGRESS' }],
          preconditions: [],
          clients: [],
          actions: [],
        };
      },
      async apply() { return createStageResult({ name: 'prerequisites', status: 'INSTALL_FAILED', result: 'failed' }); },
      async verify() { return createStageResult({ name: 'prerequisites', status: 'STALE', result: 'action_required' }); },
    };
    const localState = {
      async acquireApplyLease() { return { async release() {} }; },
      async wasDigestApplied() { return false; },
      async markDigestApplied() { replayMarks += 1; },
    };
    const orchestrator = createDeploymentOrchestrator({
      repoRoot: root,
      stateRoot: join(root, 'state'),
      domains: [domain],
      localState,
      sourceProvider: async () => sampleSource(root),
      descriptorProvider: async () => sampleDescriptor(root),
      receiptWriter: async () => ({ kind: 'deployment', path_label: 'receipts/failed.json', sha256: 'e'.repeat(64) }),
      includeGenericClient: false,
      clock: () => new Date('2026-07-15T12:00:00.000Z'),
    });
    const plan = await orchestrator.plan({ operation: 'setup', requested_project: null, requested_profile: null, selected_clients: [] });
    const result = await orchestrator.apply({ plan, approvedDigest: plan.digest });
    t.assert(result.outcome === 'FAILED' && result.receipts.length === 1, 'no-progress failure still produces terminal receipt evidence');
    t.assert(replayMarks === 0, 'no-progress failure does not consume the approved plan digest');
  } finally {
    cleanup(root);
  }
}

// Concurrent apply attempts serialize and the waiter rechecks replay before fingerprints or writes.
{
  const root = makeRoot();
  try {
    let leaseHeld = false;
    const leaseWaiters = [];
    let replayMarked = false;
    let fingerprintCalls = 0;
    let applyCalls = 0;
    let releaseFirstApply;
    let signalFirstApply;
    const firstApplyEntered = new Promise(resolvePromise => { signalFirstApply = resolvePromise; });
    const domain = {
      name: 'prerequisites',
      order: 10,
      async plan() {
        return {
          stages: [createStageResult({ name: 'prerequisites', status: 'STALE', result: 'action_required' })],
          operations: [{ operation_id: 'prerequisites:concurrent', domain: 'prerequisites', domain_order: 10, kind: 'CONCURRENT_WRITE' }],
          preconditions: [{ kind: 'file', label: 'concurrent-input', canonical_path: join(root, 'input.json'), fingerprint: { exists: false } }],
          clients: [],
          actions: [],
        };
      },
      async apply() {
        applyCalls += 1;
        signalFirstApply();
        await new Promise(resolvePromise => { releaseFirstApply = resolvePromise; });
        return createStageResult({ name: 'prerequisites', status: 'READY', changed: true, progress: 'committed' });
      },
      async verify() { return createStageResult({ name: 'prerequisites', status: 'READY' }); },
    };
    const localState = {
      async acquireApplyLease() {
        if (leaseHeld) await new Promise(resolvePromise => leaseWaiters.push(resolvePromise));
        leaseHeld = true;
        return {
          async release() {
            leaseHeld = false;
            leaseWaiters.shift()?.();
          },
        };
      },
      async wasDigestApplied() { return replayMarked; },
      async markDigestApplied() { replayMarked = true; },
    };
    const orchestrator = createDeploymentOrchestrator({
      repoRoot: root,
      stateRoot: join(root, 'state'),
      domains: [domain],
      localState,
      sourceProvider: async () => sampleSource(root),
      descriptorProvider: async () => sampleDescriptor(root),
      fingerprint: async () => {
        fingerprintCalls += 1;
        return { exists: false };
      },
      receiptWriter: async () => ({ kind: 'deployment', path_label: 'receipts/concurrent.json', sha256: 'f'.repeat(64) }),
      includeGenericClient: false,
      clock: () => new Date('2026-07-15T12:00:00.000Z'),
    });
    const plan = await orchestrator.plan({ operation: 'setup', requested_project: null, requested_profile: null, selected_clients: [] });
    const first = orchestrator.apply({ plan, approvedDigest: plan.digest });
    await firstApplyEntered;
    const second = orchestrator.apply({ plan, approvedDigest: plan.digest });
    await new Promise(resolvePromise => setTimeout(resolvePromise, 10));
    t.assert(applyCalls === 1 && fingerprintCalls === 1, 'only the active lease owner reaches precondition fingerprinting and domain apply');
    releaseFirstApply();
    const firstResult = await first;
    const secondResult = await second.then(value => ({ value }), error => ({ error }));
    t.assert(firstResult.outcome === 'HEALTHY' && replayMarked, 'first concurrent owner commits and records replay while leased');
    t.assert(secondResult.error?.code === 'PLAN_REPLAYED', 'waiting owner revalidates and rejects the consumed digest after lease acquisition');
    t.assert(applyCalls === 1 && fingerprintCalls === 1, 'replay waiter performs no fingerprint or domain write after acquisition');
  } finally {
    cleanup(root);
  }
}

// A healthy operation-free plan verifies domains without invoking their apply paths.
{
  const root = makeRoot();
  try {
    let applyCalls = 0;
    let verifyCalls = 0;
    let replayMarks = 0;
    const domain = {
      name: 'prerequisites',
      order: 10,
      async plan() { return { stages: [createStageResult({ name: 'prerequisites', status: 'READY' })], operations: [], preconditions: [], clients: [], actions: [] }; },
      async apply() { applyCalls += 1; return createStageResult({ name: 'prerequisites', status: 'READY', changed: true }); },
      async verify() { verifyCalls += 1; return createStageResult({ name: 'prerequisites', status: 'READY' }); },
    };
    const orchestrator = createDeploymentOrchestrator({
      repoRoot: root,
      stateRoot: join(root, 'state'),
      domains: [domain],
      localState: {
        async acquireApplyLease() { return { async release() {} }; },
        async wasDigestApplied() { return false; },
        async markDigestApplied() { replayMarks += 1; },
      },
      sourceProvider: async () => sampleSource(root),
      descriptorProvider: async () => sampleDescriptor(root),
      receiptWriter: async () => ({ kind: 'deployment', path_label: 'receipts/no-op.json', sha256: '1'.repeat(64) }),
      includeGenericClient: false,
      clock: () => new Date('2026-07-15T12:00:00.000Z'),
    });
    const plan = await orchestrator.plan({ operation: 'setup', requested_project: null, requested_profile: null, selected_clients: [] });
    const result = await orchestrator.apply({ plan, approvedDigest: plan.digest });
    t.assert(result.outcome === 'HEALTHY' && applyCalls === 0 && verifyCalls === 1, 'healthy no-op uses domain verification and performs no domain write');
    t.assert(replayMarks === 0, 'healthy no-op does not consume a plan that made no progress');
  } finally {
    cleanup(root);
  }
}

// Generic support remains explicit when no automatic client adapter is registered.
{
  const root = makeRoot();
  try {
    let smokeCalls = 0;
    const orchestrator = createDeploymentOrchestrator({
      repoRoot: root,
      stateRoot: join(root, 'state'),
      domains: [{
        name: 'prerequisites',
        order: 10,
        async plan() { return { stages: [createStageResult({ name: 'prerequisites', status: 'READY' })], operations: [], preconditions: [], clients: [], actions: [] }; },
        async apply() { return createStageResult({ name: 'prerequisites', status: 'READY' }); },
        async verify() { return createStageResult({ name: 'prerequisites', status: 'READY' }); },
      }],
      localState: {
        async acquireApplyLease() { return { async release() {} }; },
        async wasDigestApplied() { return false; },
      },
      sourceProvider: async () => sampleSource(root),
      descriptorProvider: async () => sampleDescriptor(root),
      protocolSmoke: async () => {
        smokeCalls += 1;
        return { status: 'HEALTHY', initialize: { server_name: 'uemcp', server_version: '1.0.0' }, instruction_bytes: 10, tool_count: 1, initial_tool_names: ['one'], duration_ms: 1 };
      },
      receiptWriter: async () => ({ kind: 'deployment', path_label: 'receipts/generic.json', sha256: '2'.repeat(64) }),
      clock: () => new Date('2026-07-15T12:00:00.000Z'),
    });
    const plan = await orchestrator.plan({ operation: 'setup', requested_project: null, requested_profile: null, selected_clients: [] });
    t.assert(plan.clients.length === 1 && plan.clients[0].status === 'MANUAL_REGISTRATION_REQUIRED', 'plan reports generic manual support instead of silently omitting clients');
    t.assert(plan.outcome === 'ACTION_REQUIRED', 'manual client registration keeps the plan actionable and nonzero');
    const applied = await orchestrator.apply({ plan, approvedDigest: plan.digest });
    t.assert(applied.outcome === 'ACTION_REQUIRED' && applied.clients[0].status === 'MANUAL_REGISTRATION_REQUIRED', 'apply preserves unresolved generic client work in its aggregate outcome');
    t.assert(applied.stages.some(stage => stage.name === 'protocol' && stage.status === 'HEALTHY') && smokeCalls === 2, 'apply reruns generic protocol verification instead of copying stale plan evidence');
  } finally {
    cleanup(root);
  }
}

// CLI parsing renders only machine JSON on stdout and preserves outcome exits.
{
  const root = makeRoot();
  try {
    const reviewed = await fingerprintPath(join(root, 'missing.json'), { allowedRoots: [root] });
    const plan = createReviewedPlan({ root, reviewed });
    const result = createMachineResult({
      operation: 'verify',
      source: sampleSource(root),
      request: sampleRequest(),
      descriptor: sampleDescriptor(root),
      plan: null,
      stages: [createStageResult({ name: 'prerequisites', status: 'READY' })],
      now: new Date('2026-07-15T12:00:00.000Z'),
    });
    const cliOrchestrator = {
      async plan() { return plan; },
      async repair() { return { ...plan, operation: 'repair', digest: computePlanDigest({ ...plan, operation: 'repair' }) }; },
      async verify() { return result; },
      async doctor() { return { ...result, operation: 'doctor' }; },
      async apply() { return { ...result, operation: 'apply', plan: { digest: plan.digest, created_at: plan.created_at, expires_at: plan.expires_at, preconditions_valid: true } }; },
    };
    let stdout = '';
    let stderr = '';
    const streams = {
      stdout: { write: value => { stdout += value; } },
      stderr: { write: value => { stderr += value; } },
    };
    const planExit = await runCli(['plan', '--operation', 'setup', '--json'], { orchestrator: cliOrchestrator, ...streams });
    t.assert(planExit === 10 && JSON.parse(stdout).kind === 'uemcp.deployment.plan' && stderr === '', 'plan JSON is stdout-only and exits for its embedded ACTION_REQUIRED outcome');
    stdout = '';
    stderr = '';
    const verifyExit = await runCli(['verify', '--json'], { orchestrator: cliOrchestrator, ...streams });
    t.assert(verifyExit === 0 && JSON.parse(stdout).operation === 'verify' && stderr === '', 'healthy verify emits JSON-only stdout and exits zero');
    stdout = '';
    stderr = '';
    const usageExit = await runCli(['apply', '--plan-file', join(root, 'plan.json'), '--approve-digest', plan.digest, '--json'], { orchestrator: cliOrchestrator, ...streams });
    t.assert(usageExit === 64 && stdout === '' && stderr.length > 0, 'apply without --non-interactive is a usage error on stderr');
    stdout = '';
    stderr = '';
    const relativeProjectExit = await runCli(['plan', '--operation', 'setup', '--project', 'Game.uproject', '--json'], { orchestrator: cliOrchestrator, ...streams });
    t.assert(relativeProjectExit === 64 && stdout === '', 'direct project input must be an absolute uproject path');
    stdout = '';
    stderr = '';
    const conflictingTargetExit = await runCli(['plan', '--operation', 'setup', '--project', join(root, 'Game.uproject'), '--profile', 'smoke', '--json'], { orchestrator: cliOrchestrator, ...streams });
    t.assert(conflictingTargetExit === 64 && stdout === '', 'direct project and profile selectors are mutually exclusive');
    stdout = '';
    stderr = '';
    const planPath = join(root, 'reviewed-plan.json');
    writeFileSync(planPath, JSON.stringify(plan), 'utf8');
    const invalidPlanOrchestrator = {
      ...cliOrchestrator,
      async apply() {
        const error = new Error('schema mismatch');
        error.code = 'INVALID_PLAN';
        throw error;
      },
    };
    const schemaExit = await runCli(['apply', '--plan-file', planPath, '--approve-digest', plan.digest, '--non-interactive', '--json'], { orchestrator: invalidPlanOrchestrator, ...streams });
    t.assert(schemaExit === 64 && stdout === '' && stderr.startsWith('INVALID_PLAN:'), 'plan schema failures use the locked usage-interface exit');
    stdout = '';
    stderr = '';
    const diagnosticCanary = 'stderr-secret-canary';
    const failingOrchestrator = {
      ...cliOrchestrator,
      async verify() {
        const error = new Error(`provider included ${diagnosticCanary}`);
        error.code = `FAILED_${diagnosticCanary}`;
        throw error;
      },
    };
    const failedExit = await runCli(['verify', '--json'], { orchestrator: failingOrchestrator, ...streams });
    t.assert(failedExit === 30 && stdout === '' && !stderr.includes(diagnosticCanary) && stderr.startsWith('FAILED:'), 'runtime diagnostics cannot expose arbitrary error messages or codes');
    stdout = '';
    stderr = '';
    const unknownFlagExit = await runCli(['verify', `--token=${diagnosticCanary}`, '--json'], { orchestrator: cliOrchestrator, ...streams });
    t.assert(unknownFlagExit === 64 && stdout === '' && !stderr.includes(diagnosticCanary), 'usage diagnostics do not echo unknown user input');
    stdout = '';
    stderr = '';
    const repairExit = await runCli(['repair', '--yes', '--json'], { orchestrator: cliOrchestrator, ...streams });
    t.assert(repairExit === 64 && stdout === '', 'repair rejects direct-apply flags');
  } finally {
    cleanup(root);
  }
}

const failed = t.summary();
process.exit(failed ? 1 : 0);
