import * as defaultFs from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, resolve, win32 } from 'node:path';

import { createStageResult } from './contracts.mjs';
import { sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { fingerprintPath } from './fingerprints.mjs';

const INSTALL_MODE = 'production-no-scripts';
const VALIDATION_COMMAND = 'npm ls --omit=dev --all --json';

export class PrerequisiteError extends Error {
  constructor(message, code = 'PREREQUISITE_FAILED', details = {}) {
    super(message);
    this.name = 'PrerequisiteError';
    this.code = code;
    this.details = details;
  }
}

function absolutePath(value) {
  return typeof value === 'string' && (isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value));
}

function fail(message, code, details) {
  throw new PrerequisiteError(message, code, details);
}

export function parseNodeVersion(text) {
  if (typeof text !== 'string') return null;
  const raw = text.trim();
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(raw);
  if (!match) return null;
  const values = match.slice(1).map(Number);
  if (!values.every(Number.isSafeInteger)) return null;
  return { major: values[0], minor: values[1], patch: values[2], raw };
}

function fingerprintIdentity(fingerprint) {
  if (!fingerprint) return null;
  return {
    canonical_path: fingerprint.canonical_path,
    real_path: fingerprint.real_path,
    exists: fingerprint.exists,
    kind: fingerprint.kind,
    link_kind: fingerprint.link_kind,
    link_count: fingerprint.link_count,
    size: fingerprint.size,
    sha256: fingerprint.sha256,
  };
}

function sameFingerprint(left, right) {
  return JSON.stringify(fingerprintIdentity(left)) === JSON.stringify(fingerprintIdentity(right));
}

export async function inspectNodeRuntime({
  executable = process.execPath,
  runner,
  allowedRoots = [dirname(resolve(executable))],
  fsImpl = defaultFs,
} = {}) {
  if (!runner?.run) fail('runtime inspection requires a bounded process runner', 'INVALID_PREREQUISITE_INPUT');
  if (!absolutePath(executable)) fail('Node executable must be absolute', 'INVALID_PREREQUISITE_INPUT');
  let requestedFingerprint;
  try {
    requestedFingerprint = await fingerprintPath(executable, { allowedRoots, fsImpl });
  } catch (error) {
    if (error?.code === 'ENOENT') return { status: 'NODE_MISSING', executable: resolve(executable), version: null, fingerprint: null };
    throw error;
  }
  if (!requestedFingerprint.exists) {
    return { status: 'NODE_MISSING', executable: resolve(executable), version: null, fingerprint: requestedFingerprint };
  }
  if (requestedFingerprint.kind !== 'file') {
    return { status: 'NODE_UNSUPPORTED', executable: requestedFingerprint.real_path, version: null, fingerprint: requestedFingerprint };
  }
  const canonicalExecutable = requestedFingerprint.real_path;
  const fingerprint = requestedFingerprint.link_kind === 'none'
    ? requestedFingerprint
    : await fingerprintPath(canonicalExecutable, { allowedRoots, fsImpl });
  const result = await runner.run(canonicalExecutable, ['--version'], {
    env: {},
    timeoutMs: 10_000,
    outputLimitBytes: 8 * 1024,
  });
  const version = result.status === 'exited' && result.exitCode === 0 && result.stderr === ''
    ? parseNodeVersion(result.stdout)
    : null;
  return {
    status: version !== null && version.major >= 22 ? 'READY' : 'NODE_UNSUPPORTED',
    executable: canonicalExecutable,
    version,
    fingerprint,
  };
}

function packageNameForKey(key) {
  const marker = 'node_modules/';
  const index = key.lastIndexOf(marker);
  return index === -1 ? null : key.slice(index + marker.length);
}

function dependencyCandidates(fromKey, name) {
  const candidates = [];
  let current = fromKey;
  while (current) {
    candidates.push(`${current}/node_modules/${name}`);
    const marker = current.lastIndexOf('/node_modules/');
    if (marker === -1) break;
    current = current.slice(0, marker);
  }
  candidates.push(`node_modules/${name}`);
  return [...new Set(candidates)];
}

function productionClosure(lock) {
  if (lock === null || typeof lock !== 'object' || Array.isArray(lock) || lock.lockfileVersion !== 3) {
    fail('package-lock.json must use lockfileVersion 3', 'LOCK_DRIFT');
  }
  const packages = lock.packages;
  if (packages === null || typeof packages !== 'object' || Array.isArray(packages) || !packages['']) {
    fail('package-lock.json has no root package', 'LOCK_DRIFT');
  }
  const queue = [];
  const enqueueDependencies = (entry, fromKey) => {
    const names = new Set([
      ...Object.keys(entry.dependencies ?? {}),
      ...Object.keys(entry.optionalDependencies ?? {}),
    ]);
    for (const name of [...names].sort()) queue.push({ name, fromKey });
  };
  enqueueDependencies(packages[''], '');
  const visited = new Set();
  const rows = [];
  while (queue.length > 0) {
    const request = queue.shift();
    const key = dependencyCandidates(request.fromKey, request.name).find(candidate => packages[candidate]);
    if (!key) fail('production dependency is missing from package-lock.json', 'LOCK_DRIFT', { package: request.name });
    if (visited.has(key)) continue;
    visited.add(key);
    const entry = packages[key];
    if (entry.dev === true && entry.optional !== true) {
      fail('production dependency resolves only to a dev package', 'LOCK_DRIFT', { package: request.name });
    }
    const name = packageNameForKey(key) ?? request.name;
    rows.push({ key, name, version: entry.version ?? null, hasInstallScript: entry.hasInstallScript === true });
    enqueueDependencies(entry, key);
  }
  rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return rows;
}

async function resolveNpmCli(nodeRuntime, { runner, fsImpl }) {
  const npmRoot = join(dirname(nodeRuntime.executable), 'node_modules', 'npm');
  const packagePath = join(npmRoot, 'package.json');
  const packageFingerprint = await fingerprintPath(packagePath, { allowedRoots: [npmRoot], fsImpl });
  if (!packageFingerprint.exists || packageFingerprint.kind !== 'file' || packageFingerprint.link_kind !== 'none') {
    fail('the selected Node runtime has no attributable npm package', 'LOCK_DRIFT');
  }
  let packageJson;
  try {
    packageJson = JSON.parse(await fsImpl.readFile(packagePath, 'utf8'));
  } catch {
    fail('the selected npm package metadata is malformed', 'LOCK_DRIFT');
  }
  const bin = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.npm;
  if (packageJson.name !== 'npm' || typeof packageJson.version !== 'string' || typeof bin !== 'string') {
    fail('the selected npm package metadata is incomplete', 'LOCK_DRIFT');
  }
  const npmCli = resolve(npmRoot, bin);
  const cliFingerprint = await fingerprintPath(npmCli, { allowedRoots: [npmRoot], fsImpl });
  if (!cliFingerprint.exists || cliFingerprint.kind !== 'file' || cliFingerprint.link_kind !== 'none') {
    fail('the selected npm CLI is unavailable', 'LOCK_DRIFT');
  }
  const versionResult = await runner.run(nodeRuntime.executable, [npmCli, '--version'], {
    env: {},
    timeoutMs: 10_000,
    outputLimitBytes: 8 * 1024,
  });
  const observedVersion = versionResult.status === 'exited' && versionResult.exitCode === 0 && versionResult.stderr === ''
    ? versionResult.stdout.trim()
    : null;
  if (observedVersion !== packageJson.version) fail('npm package and executable versions disagree', 'LOCK_DRIFT');
  return { npmRoot, npmCli, version: observedVersion, cliFingerprint };
}

function expectedStamp({ lockSha256, nodeRuntime, npm }) {
  return {
    schema_version: '1.0',
    lock_sha256: lockSha256,
    node_major: nodeRuntime.version.major,
    package_manager: {
      node_executable: nodeRuntime.executable,
      npm_cli: npm.npmCli,
      version: npm.version,
    },
    install_mode: INSTALL_MODE,
    validation: { command: VALIDATION_COMMAND, exit_code: 0 },
  };
}

function stampMatches(actual, expected) {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false;
  const comparable = { ...actual };
  delete comparable.validated_at;
  return sha256Canonical(comparable) === sha256Canonical(expected);
}

async function readLock(serverRoot, fsImpl) {
  const lockPath = join(resolve(serverRoot), 'package-lock.json');
  let bytes;
  let lock;
  try {
    bytes = await fsImpl.readFile(lockPath);
    lock = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('package-lock.json is missing or malformed', 'LOCK_DRIFT');
  }
  return { lockPath, bytes, lock, sha256: sha256Bytes(bytes), closure: productionClosure(lock) };
}

export async function inspectDependencies({
  serverRoot,
  nodeRuntime,
  runner,
  localState,
  fsImpl = defaultFs,
} = {}) {
  if (nodeRuntime?.status !== 'READY' || !nodeRuntime.version) fail('dependencies cannot be inspected before Node is ready', 'NODE_UNSUPPORTED');
  if (!runner?.run || !localState?.readJson || !localState?.paths) fail('dependency inspection inputs are incomplete', 'INVALID_PREREQUISITE_INPUT');
  const root = resolve(serverRoot);
  const lock = await readLock(root, fsImpl);
  const blockedPackages = lock.closure
    .filter(row => row.hasInstallScript)
    .map(row => ({ name: row.name, version: row.version }));
  if (blockedPackages.length > 0) {
    return {
      status: 'DEPENDENCY_POLICY_BLOCKED',
      install_required: false,
      lock_sha256: lock.sha256,
      blocked_packages: blockedPackages,
    };
  }
  const npm = await resolveNpmCli(nodeRuntime, { runner, fsImpl });
  const validation = await runner.run(nodeRuntime.executable, [npm.npmCli, 'ls', '--omit=dev', '--all', '--json'], {
    cwd: root,
    env: {},
    timeoutMs: 30_000,
    outputLimitBytes: 1024 * 1024,
  });
  const stamp = expectedStamp({ lockSha256: lock.sha256, nodeRuntime, npm });
  const storedStamp = await localState.readJson(localState.paths().dependencyStamp);
  const valid = validation.status === 'exited'
    && validation.exitCode === 0
    && validation.stderr === ''
    && stampMatches(storedStamp, stamp);
  return {
    status: valid ? 'READY' : 'STALE',
    install_required: !valid,
    lock_sha256: lock.sha256,
    lock_path: lock.lockPath,
    npm_cli: npm.npmCli,
    npm_version: npm.version,
    npm_fingerprint: npm.cliFingerprint,
    expected_stamp: stamp,
    validation_exit_code: validation.exitCode,
    blocked_packages: [],
  };
}

function action(code, message) {
  return { code, message, command: null };
}

export function planPrerequisiteOperations({ node, dependencies }) {
  if (!node || !['READY', 'NODE_MISSING', 'NODE_UNSUPPORTED'].includes(node.status)) {
    fail('Node readiness result is invalid', 'INVALID_PREREQUISITE_INPUT');
  }
  if (node.status !== 'READY') {
    const actions = [action('NODE_INSTALL_REQUIRED', 'Install a supported Node.js 22 or newer runtime before deployment can continue.')];
    return {
      stages: [createStageResult({ name: 'prerequisites', status: node.status, result: 'action_required', actions })],
      operations: [],
      preconditions: [],
      actions,
    };
  }
  if (!dependencies) fail('dependency readiness result is required when Node is ready', 'INVALID_PREREQUISITE_INPUT');
  if (dependencies.status === 'DEPENDENCY_POLICY_BLOCKED') {
    const actions = [action('DEPENDENCY_POLICY_BLOCKED', 'A production dependency requires lifecycle scripts and needs a reviewed policy change.')];
    return {
      stages: [createStageResult({ name: 'prerequisites', status: dependencies.status, result: 'action_required', evidence: { blocked_packages: dependencies.blocked_packages }, actions })],
      operations: [],
      preconditions: [],
      actions,
    };
  }
  if (dependencies.status === 'READY') {
    return {
      stages: [createStageResult({ name: 'prerequisites', status: 'READY' })],
      operations: [],
      preconditions: [],
      actions: [],
    };
  }
  if (dependencies.status !== 'STALE') fail('dependency readiness status is invalid', 'INVALID_PREREQUISITE_INPUT');
  const actions = [action('DEPENDENCIES_INSTALL_REQUIRED', 'Install and validate the locked production dependency closure.')];
  const operation = {
    operation_id: 'prerequisites:install-dependencies',
    domain: 'prerequisites',
    domain_order: 10,
    kind: 'INSTALL_DEPENDENCIES',
    server_root: dirname(dependencies.lock_path),
    node_executable: node.executable,
    node_version: node.version.raw,
    node_fingerprint: fingerprintIdentity(node.fingerprint),
    npm_cli: dependencies.npm_cli,
    npm_version: dependencies.npm_version,
    npm_fingerprint: fingerprintIdentity(dependencies.npm_fingerprint),
    lock_sha256: dependencies.lock_sha256,
  };
  return {
    stages: [createStageResult({ name: 'prerequisites', status: 'STALE', result: 'action_required', actions })],
    operations: [operation],
    preconditions: [
      { kind: 'executable', label: 'node-runtime', canonical_path: node.executable, fingerprint: operation.node_fingerprint, version: node.version.raw },
      { kind: 'file', label: 'package-lock', canonical_path: dependencies.lock_path, sha256: dependencies.lock_sha256 },
      { kind: 'file', label: 'npm-cli', canonical_path: dependencies.npm_cli, fingerprint: operation.npm_fingerprint, version: dependencies.npm_version },
    ],
    actions,
  };
}

export async function applyDependencyOperation(operation, {
  serverRoot,
  nodeRuntime,
  runner,
  localState,
  fsImpl = defaultFs,
  clock = Date.now,
} = {}) {
  if (operation?.kind !== 'INSTALL_DEPENDENCIES') fail('unsupported prerequisite operation', 'INVALID_PREREQUISITE_OPERATION');
  if (resolve(serverRoot) !== resolve(operation.server_root)) fail('server root differs from the reviewed operation', 'LOCK_DRIFT');
  const currentNode = await inspectNodeRuntime({
    executable: operation.node_executable,
    runner,
    allowedRoots: [dirname(operation.node_executable)],
    fsImpl,
  });
  if (currentNode.status !== 'READY'
    || currentNode.version.raw !== operation.node_version
    || !sameFingerprint(currentNode.fingerprint, operation.node_fingerprint)) {
    fail('Node runtime changed after planning', 'LOCK_DRIFT');
  }
  const beforeLock = await readLock(serverRoot, fsImpl);
  if (beforeLock.sha256 !== operation.lock_sha256) fail('package lock changed after planning', 'LOCK_DRIFT');
  const npmFingerprint = await fingerprintPath(operation.npm_cli, { allowedRoots: [dirname(dirname(operation.npm_cli))], fsImpl });
  if (!sameFingerprint(npmFingerprint, operation.npm_fingerprint)) fail('npm CLI changed after planning', 'LOCK_DRIFT');

  const install = await runner.run(operation.node_executable, [
    operation.npm_cli,
    'ci',
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
  ], {
    cwd: resolve(serverRoot),
    env: {},
    timeoutMs: 10 * 60 * 1000,
    outputLimitBytes: 1024 * 1024,
  });
  if (install.status !== 'exited' || install.exitCode !== 0) {
    return { status: 'INSTALL_FAILED', changed: false };
  }
  const validation = await runner.run(operation.node_executable, [
    operation.npm_cli,
    'ls',
    '--omit=dev',
    '--all',
    '--json',
  ], {
    cwd: resolve(serverRoot),
    env: {},
    timeoutMs: 30_000,
    outputLimitBytes: 1024 * 1024,
  });
  if (validation.status !== 'exited' || validation.exitCode !== 0 || validation.stderr !== '') {
    return { status: 'INSTALL_FAILED', changed: true };
  }

  const afterNode = await inspectNodeRuntime({
    executable: operation.node_executable,
    runner,
    allowedRoots: [dirname(operation.node_executable)],
    fsImpl,
  });
  const afterLock = await readLock(serverRoot, fsImpl);
  const afterNpm = await fingerprintPath(operation.npm_cli, { allowedRoots: [dirname(dirname(operation.npm_cli))], fsImpl });
  if (afterNode.status !== 'READY'
    || afterNode.version.raw !== operation.node_version
    || !sameFingerprint(afterNode.fingerprint, operation.node_fingerprint)
    || afterLock.sha256 !== operation.lock_sha256
    || !sameFingerprint(afterNpm, operation.npm_fingerprint)) {
    fail('runtime or lock identity changed during dependency installation', 'LOCK_DRIFT');
  }
  const stamp = {
    ...expectedStamp({
      lockSha256: operation.lock_sha256,
      nodeRuntime: currentNode,
      npm: { npmCli: operation.npm_cli, version: operation.npm_version },
    }),
    validated_at: new Date(Number(clock())).toISOString(),
  };
  await localState.writeJsonAtomic(localState.paths().dependencyStamp, stamp);
  return { status: 'READY', changed: true, stamp };
}

export const DEPENDENCY_INSTALL_MODE = INSTALL_MODE;
export const DEPENDENCY_VALIDATION_COMMAND = VALIDATION_COMMAND;
