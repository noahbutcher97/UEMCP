// Runtime and dependency readiness tests.
//
// Run: cd server && node test-deployment-prerequisites.mjs

import {
  mkdirSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  cleanupCanonicalScratchRoot,
  createCanonicalScratchRoot,
  TestRunner,
} from './test-helpers.mjs';
import {
  applyDependencyOperation,
  createPrerequisiteDomain,
  inspectDependencies,
  inspectNodeRuntime,
  parseNodeVersion,
  planPrerequisiteOperations,
} from './deployment/prerequisites.mjs';

const t = new TestRunner('Deployment Prerequisite Tests');

function makeRoot(label = 'uemcp-prerequisite-') {
  return createCanonicalScratchRoot(label);
}

function cleanup(root, label = 'uemcp-prerequisite-') {
  cleanupCanonicalScratchRoot(root, label);
}

function sameFileIdentity(left, right) {
  const leftStat = statSync(left, { bigint: true });
  const rightStat = statSync(right, { bigint: true });
  return leftStat.dev === rightStat.dev && leftStat.ino !== 0n && leftStat.ino === rightStat.ino;
}

async function rejectsCode(fn, code) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
}

function writeJson(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createRuntimeLayout(root) {
  mkdirSync(root, { recursive: true });
  const nodeExecutable = join(root, 'node.exe');
  const npmRoot = join(root, 'node_modules', 'npm');
  const npmCli = join(npmRoot, 'bin', 'npm-cli.js');
  writeFileSync(nodeExecutable, 'sample-node-binary', 'utf8');
  mkdirSync(join(npmRoot, 'bin'), { recursive: true });
  writeJson(join(npmRoot, 'package.json'), {
    name: 'npm',
    version: '11.6.4',
    bin: { npm: 'bin/npm-cli.js' },
  });
  writeFileSync(npmCli, 'export {};\n', 'utf8');
  return { nodeExecutable, npmCli };
}

function productionLock({ installScript = false } = {}) {
  return {
    name: 'sample-server',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'sample-server',
        version: '1.0.0',
        dependencies: { 'prod-package': '^1.0.0' },
        devDependencies: { 'dev-package': '^1.0.0' },
      },
      'node_modules/prod-package': {
        version: '1.0.1',
        hasInstallScript: installScript || undefined,
        dependencies: { 'nested-package': '^2.0.0' },
      },
      'node_modules/nested-package': { version: '2.0.3' },
      'node_modules/dev-package': { version: '1.0.2', dev: true, hasInstallScript: true },
    },
  };
}

function createMemoryState(root) {
  const values = new Map();
  return {
    paths() {
      return { dependencyStamp: join(root, 'state', 'dependency-stamp-v1.json') };
    },
    async readJson(path) {
      return values.get(path) ?? null;
    },
    async writeJsonAtomic(path, value) {
      values.set(path, structuredClone(value));
    },
    values,
  };
}

function createRunner({ nodeVersion = 'v22.13.1', npmVersion = '11.6.4', listExit = 0, installExit = 0 } = {}) {
  const calls = [];
  const runner = {
    calls,
    async run(executable, args, options = {}) {
      calls.push({ executable, args: [...args], options: structuredClone(options) });
      if (args.length === 1 && args[0] === '--version') {
        return { status: 'exited', exitCode: 0, stdout: `${nodeVersion}\n`, stderr: '' };
      }
      if (args.at(-1) === '--version') {
        return { status: 'exited', exitCode: 0, stdout: `${npmVersion}\n`, stderr: '' };
      }
      if (args.includes('ls')) {
        return { status: 'exited', exitCode: listExit, stdout: '{"name":"sample-server"}', stderr: '' };
      }
      if (args.includes('ci')) {
        return { status: 'exited', exitCode: installExit, stdout: '', stderr: '' };
      }
      throw new Error(`unexpected process call: ${executable} ${args.join(' ')}`);
    },
  };
  return runner;
}

// Node versions are parsed semantically, not lexically.
{
  t.assert(JSON.stringify(parseNodeVersion('v22.0.0')) === JSON.stringify({ major: 22, minor: 0, patch: 0, raw: 'v22.0.0' }), 'Node 22.0.0 parses numerically');
  t.assert(parseNodeVersion('24.2.0').major === 24, 'Node 24 parses without a v prefix');
  t.assert(parseNodeVersion('v20.19.4').major === 20, 'Node 20 parses for an explicit unsupported result');
  t.assert(parseNodeVersion('v22.0.0-rc.1') === null, 'prerelease Node output is rejected');
  t.assert(parseNodeVersion('node v22.0.0') === null, 'decorated Node output is rejected');
}

// Runtime inspection uses the exact selected executable and refuses fallback.
{
  const root = makeRoot();
  try {
    const { nodeExecutable } = createRuntimeLayout(root);
    const readyRunner = createRunner({ nodeVersion: 'v22.13.1' });
    const ready = await inspectNodeRuntime({ executable: nodeExecutable, runner: readyRunner, allowedRoots: [root] });
    t.assert(ready.status === 'READY' && ready.version.major === 22, 'Node 22+ runtime is READY');
    t.assert(readyRunner.calls.length === 1 && readyRunner.calls[0].executable === ready.executable && sameFileIdentity(ready.executable, nodeExecutable), 'runtime probe executes only the selected absolute path');

    const old = await inspectNodeRuntime({ executable: nodeExecutable, runner: createRunner({ nodeVersion: 'v20.19.4' }), allowedRoots: [root] });
    t.assert(old.status === 'NODE_UNSUPPORTED' && old.version.major === 20, 'Node 20 is explicitly unsupported');
    const newer = await inspectNodeRuntime({ executable: nodeExecutable, runner: createRunner({ nodeVersion: 'v24.2.0' }), allowedRoots: [root] });
    t.assert(newer.status === 'READY' && newer.version.major === 24, 'newer supported Node majors compare numerically');
    const malformed = await inspectNodeRuntime({ executable: nodeExecutable, runner: createRunner({ nodeVersion: 'garbage' }), allowedRoots: [root] });
    t.assert(malformed.status === 'NODE_UNSUPPORTED' && malformed.version === null, 'malformed runtime output fails closed');
    const missingRunner = createRunner();
    const missing = await inspectNodeRuntime({ executable: join(root, 'missing-node.exe'), runner: missingRunner, allowedRoots: [root] });
    t.assert(missing.status === 'NODE_MISSING' && missingRunner.calls.length === 0, 'missing runtime does not trigger fallback or another process');
  } finally {
    cleanup(root);
  }
}

// Dependency readiness follows only the production lock closure.
{
  const root = makeRoot();
  try {
    const runtimeRoot = join(root, 'runtime');
    const serverRoot = join(root, 'server');
    mkdirSync(serverRoot, { recursive: true });
    const { nodeExecutable, npmCli } = createRuntimeLayout(runtimeRoot);
    writeJson(join(serverRoot, 'package-lock.json'), productionLock());
    const localState = createMemoryState(root);
    const runner = createRunner();
    const node = await inspectNodeRuntime({ executable: nodeExecutable, runner, allowedRoots: [runtimeRoot] });

    const stale = await inspectDependencies({ serverRoot, nodeRuntime: node, runner, localState });
    t.assert(stale.status === 'STALE' && stale.install_required === true, 'missing dependency stamp requires a deterministic install plan');
    t.assert(sameFileIdentity(stale.npm_cli, npmCli), 'paired npm CLI is resolved beneath the selected Node installation');

    const planned = planPrerequisiteOperations({ node, dependencies: stale });
    t.assert(planned.operations.length === 1 && planned.operations[0].kind === 'INSTALL_DEPENDENCIES', 'stale dependencies produce one explicit install operation');
    const applied = await applyDependencyOperation(planned.operations[0], { serverRoot, nodeRuntime: node, runner, localState });
    t.assert(applied.status === 'READY', 'successful deterministic install and validation returns READY');
    const installCall = runner.calls.find(call => call.args.includes('ci'));
    t.assert(
      installCall.executable === node.executable
        && JSON.stringify(installCall.args) === JSON.stringify([stale.npm_cli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'])
        && sameFileIdentity(installCall.options.cwd, serverRoot),
      'dependency install uses exact node/npm paths and locked no-script flags',
    );
    t.assert(!runner.calls.some(call => /\.(?:cmd|bat)$/i.test(call.executable)), 'dependency readiness never executes a command-shell launcher');

    const healthy = await inspectDependencies({ serverRoot, nodeRuntime: node, runner, localState });
    t.assert(healthy.status === 'READY' && healthy.install_required === false, 'matching stamp still validates and returns READY');
    t.assert(runner.calls.filter(call => call.args.includes('ls')).length >= 2, 'matching stamp never bypasses bounded npm ls validation');
    const stampPath = localState.paths().dependencyStamp;
    localState.values.set(stampPath, { ...localState.values.get(stampPath), node_major: 99 });
    const tampered = await inspectDependencies({ serverRoot, nodeRuntime: node, runner, localState });
    t.assert(tampered.status === 'STALE', 'tampered dependency stamp cannot authorize readiness');

    writeJson(join(serverRoot, 'package-lock.json'), productionLock({ installScript: true }));
    const beforeBlocked = runner.calls.length;
    const blocked = await inspectDependencies({ serverRoot, nodeRuntime: node, runner, localState });
    t.assert(blocked.status === 'DEPENDENCY_POLICY_BLOCKED' && blocked.blocked_packages[0].name === 'prod-package', 'production lifecycle script blocks before mutation');
    t.assert(!blocked.blocked_packages.some(row => row.name === 'dev-package'), 'dev-only lifecycle scripts are outside the production closure');
    t.assert(runner.calls.length === beforeBlocked, 'blocked production closure executes no npm command');
  } finally {
    cleanup(root);
  }
}

// Runtime identity remains stable when Windows expands an ancestor path alias.
{
  const root = makeRoot();
  try {
    const physicalRuntimeRoot = join(root, 'physical-runtime');
    const aliasRuntimeRoot = join(root, 'runtime-alias');
    const serverRoot = join(root, 'server');
    const { nodeExecutable: physicalNodeExecutable } = createRuntimeLayout(physicalRuntimeRoot);
    symlinkSync(physicalRuntimeRoot, aliasRuntimeRoot, 'junction');
    mkdirSync(serverRoot);
    writeJson(join(serverRoot, 'package-lock.json'), productionLock());
    const nodeExecutable = join(aliasRuntimeRoot, 'node.exe');
    const localState = createMemoryState(root);
    const runner = createRunner();
    const node = await inspectNodeRuntime({ executable: nodeExecutable, runner, allowedRoots: [aliasRuntimeRoot] });
    const dependencies = await inspectDependencies({ serverRoot, nodeRuntime: node, runner, localState });
    const planned = planPrerequisiteOperations({ node, dependencies });
    const applied = await applyDependencyOperation(planned.operations[0], { serverRoot, runner, localState });
    t.assert(sameFileIdentity(node.executable, physicalNodeExecutable), 'runtime inspection selects the expanded real executable path');
    t.assert(applied.status === 'READY', 'expanded runtime identity remains stable from plan through apply');
  } finally {
    cleanup(root);
  }
}

// Validation failure and runtime drift cannot be authorized by a stamp or plan.
{
  const root = makeRoot();
  try {
    const runtimeRoot = join(root, 'runtime');
    const serverRoot = join(root, 'server');
    mkdirSync(serverRoot, { recursive: true });
    const { nodeExecutable } = createRuntimeLayout(runtimeRoot);
    writeJson(join(serverRoot, 'package-lock.json'), productionLock());
    const localState = createMemoryState(root);
    const runner = createRunner({ listExit: 1 });
    const node = await inspectNodeRuntime({ executable: nodeExecutable, runner, allowedRoots: [runtimeRoot] });
    const stale = await inspectDependencies({ serverRoot, nodeRuntime: node, runner, localState });
    t.assert(stale.status === 'STALE', 'failed npm ls remains stale even when dependencies exist');

    const planned = planPrerequisiteOperations({ node, dependencies: stale });
    writeFileSync(nodeExecutable, 'changed-node-binary', 'utf8');
    t.assert(await rejectsCode(() => applyDependencyOperation(planned.operations[0], { serverRoot, nodeRuntime: node, runner, localState }), 'LOCK_DRIFT'), 'runtime byte drift invalidates the reviewed dependency operation');
  } finally {
    cleanup(root);
  }
}

// A fresh apply process consumes the saved operation without invoking the planner.
{
  const root = makeRoot();
  try {
    const runtimeRoot = join(root, 'runtime');
    const serverRoot = join(root, 'server');
    mkdirSync(serverRoot, { recursive: true });
    const { nodeExecutable } = createRuntimeLayout(runtimeRoot);
    writeJson(join(serverRoot, 'package-lock.json'), productionLock());
    const localState = createMemoryState(root);
    const runner = createRunner();
    const node = await inspectNodeRuntime({ executable: nodeExecutable, runner, allowedRoots: [runtimeRoot] });
    const dependencies = await inspectDependencies({ serverRoot, nodeRuntime: node, runner, localState });
    const planned = planPrerequisiteOperations({ node, dependencies });
    runner.calls.length = 0;
    const domain = createPrerequisiteDomain({ serverRoot, runner, localState, nodeExecutable });
    const extraOperation = { ...planned.operations[0], operation_id: 'prerequisites:unexpected-second' };
    t.assert(await rejectsCode(() => domain.apply({}, [planned.operations[0], extraOperation]), 'INVALID_PREREQUISITE_OPERATION'), 'prerequisite domain rejects operation widening before apply');
    t.assert(runner.calls.length === 0, 'widened prerequisite operation list causes no process or write');
    const applied = await domain.apply({}, planned.operations);
    const installIndex = runner.calls.findIndex(call => call.args.includes('ci'));
    const inspectionIndex = runner.calls.findIndex(call => call.args.includes('ls'));
    t.assert(applied.status === 'READY' && installIndex >= 0, 'fresh prerequisite domain applies the reviewed dependency operation');
    t.assert(inspectionIndex > installIndex, 'fresh prerequisite apply does not run planner dependency inspection before the reviewed install');
  } finally {
    cleanup(root);
  }
}

// Failures discovered after npm mutates dependencies return terminal committed evidence.
{
  const root = makeRoot();
  try {
    const runtimeRoot = join(root, 'runtime');
    const serverRoot = join(root, 'server');
    mkdirSync(serverRoot, { recursive: true });
    const { nodeExecutable } = createRuntimeLayout(runtimeRoot);
    writeJson(join(serverRoot, 'package-lock.json'), productionLock());
    const localState = createMemoryState(root);
    const runner = createRunner();
    const baseRun = runner.run.bind(runner);
    runner.run = async (executable, args, options) => {
      const result = await baseRun(executable, args, options);
      if (args.includes('ci')) writeFileSync(nodeExecutable, 'runtime-drift-after-install', 'utf8');
      return result;
    };
    const node = await inspectNodeRuntime({ executable: nodeExecutable, runner, allowedRoots: [runtimeRoot] });
    const dependencies = await inspectDependencies({ serverRoot, nodeRuntime: node, runner, localState });
    const planned = planPrerequisiteOperations({ node, dependencies });
    const domain = createPrerequisiteDomain({ serverRoot, runner, localState, nodeExecutable });
    const applied = await domain.apply({}, planned.operations);
    t.assert(applied.status === 'INSTALL_FAILED' && applied.changed, 'post-install runtime drift returns committed failure evidence instead of escaping unreceipted');
  } finally {
    cleanup(root);
  }
}

// Missing/unsupported Node can propose only the explicit bootstrap action.
{
  const missing = {
    status: 'NODE_MISSING',
    executable: 'C:\\Program Files\\nodejs\\node.exe',
    version: null,
    fingerprint: null,
  };
  const planned = planPrerequisiteOperations({ node: missing, dependencies: null });
  t.assert(planned.operations.length === 0, 'missing Node cannot plan dependencies or downstream writes');
  t.assert(planned.actions.length === 1 && planned.actions[0].code === 'NODE_INSTALL_REQUIRED', 'missing Node proposes only the reviewed bootstrap action');
}

const failed = t.summary();
process.exit(failed ? 1 : 0);
