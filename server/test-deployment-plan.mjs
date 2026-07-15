// Canonical descriptor, target domain, plan, and receipt tests.
//
// Run: cd server && node test-deployment-plan.mjs

import { randomUUID } from 'node:crypto';
import {
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
import { createCanonicalDescriptor, descriptorsEqual } from './deployment/descriptor.mjs';
import { createTargetDomain } from './deployment/target-domain.mjs';
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

const failed = t.summary();
process.exit(failed ? 1 : 0);
