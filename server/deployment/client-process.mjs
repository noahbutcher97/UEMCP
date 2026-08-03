import * as defaultFs from 'node:fs/promises';
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';

import { sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import {
  classifySupportedVersion,
  CLIENT_IDS,
  CLIENT_NATIVE_IDENTITIES,
  clientProcessEnvironment,
  expectedClientLaunchOverlay,
  NPM_RUNTIME_LIMITS,
  readWindowsEnvironmentValue,
  validateClientLaunchContract,
} from './client-contract.mjs';
import { fingerprintDirectory, fingerprintPath } from './fingerprints.mjs';
import {
  inspectAuthenticode,
  withPinnedWindowsFiles,
  withPinnedWindowsTrees,
} from './windows-native.mjs';

const CLIENTS = Object.freeze({
  claude: Object.freeze({
    command_name: 'claude',
    package_id: '@anthropic-ai/claude-code',
    bin_name: 'claude',
    signer: CLIENT_NATIVE_IDENTITIES.claude.signer_name,
  }),
  codex: Object.freeze({
    command_name: 'codex',
    package_id: '@openai/codex',
    bin_name: 'codex',
  }),
  gemini: Object.freeze({
    command_name: 'gemini',
    package_id: '@google/gemini-cli',
    bin_name: 'gemini',
  }),
  vscode: Object.freeze({
    command_name: 'code',
    signer: CLIENT_NATIVE_IDENTITIES.vscode.signer_name,
  }),
});

const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_VSCODE_WRAPPER_BYTES = 64 * 1024;
const MAX_CLIENT_CANDIDATES = 64;
const PACKAGE_ID = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/i;
const RUNTIME_FINGERPRINT_FIELDS = Object.freeze([
  'entry_count',
  'file_count',
  'manifest_sha256',
  'max_bytes',
  'max_entries',
  'max_files',
  'max_packages',
  'package_count',
  'package_id',
  'resolution_root',
  'root',
  'total_bytes',
]);

function runtimeFingerprintMismatchDetails(observed, expected) {
  return {
    reason: 'RUNTIME_FINGERPRINT_MISMATCH',
    changed_fields: RUNTIME_FINGERPRINT_FIELDS.filter(field => observed?.[field] !== expected?.[field]),
  };
}

export class ClientProcessError extends Error {
  constructor(message, code = 'NOT_INSTALLED', details = {}) {
    super(message);
    this.name = 'ClientProcessError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code = 'NOT_INSTALLED', details = {}) {
  throw new ClientProcessError(message, code, details);
}

function pathKey(path) {
  const value = resolve(path);
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function contained(root, candidate) {
  const rel = relative(pathKey(root), pathKey(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function runtimeFingerprint({
  packageRoot,
  resolutionRoot,
  packageId,
  packageCount,
  entryCount,
  fileCount,
  totalBytes,
  manifestSha256,
}) {
  return Object.freeze({
    root: resolve(packageRoot),
    resolution_root: resolve(resolutionRoot),
    package_id: packageId,
    package_count: packageCount,
    entry_count: entryCount,
    file_count: fileCount,
    total_bytes: totalBytes,
    manifest_sha256: manifestSha256,
    ...NPM_RUNTIME_LIMITS,
  });
}

function packageParts(packageId) {
  if (typeof packageId !== 'string' || !PACKAGE_ID.test(packageId)) {
    fail('client package dependency name is invalid');
  }
  return packageId.split('/');
}

function dependencyRows(manifest) {
  const dependencies = new Map();
  const add = (value, required, label) => {
    if (value === undefined) return;
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      fail(`client package ${label} must be an object`);
    }
    const rows = Object.entries(value);
    if (rows.length > NPM_RUNTIME_LIMITS.max_packages) fail('client package dependency list exceeds its limit');
    for (const [name, version] of rows) {
      packageParts(name);
      if (typeof version !== 'string' || version.trim() === '') fail(`client package ${label} version is invalid`);
      dependencies.set(name, required);
    }
  };
  add(manifest.dependencies, true, 'dependencies');
  add(manifest.optionalDependencies, false, 'optionalDependencies');

  const peerMeta = manifest.peerDependenciesMeta;
  if (peerMeta !== undefined && (!peerMeta || Array.isArray(peerMeta) || typeof peerMeta !== 'object')) {
    fail('client package peerDependenciesMeta must be an object');
  }
  if (peerMeta && Object.keys(peerMeta).length > NPM_RUNTIME_LIMITS.max_packages) {
    fail('client package peer dependency metadata exceeds its limit');
  }
  if (peerMeta) {
    for (const [name, value] of Object.entries(peerMeta)) {
      packageParts(name);
      if (!value || Array.isArray(value) || typeof value !== 'object'
        || (value.optional !== undefined && typeof value.optional !== 'boolean')) {
        fail('client package peer dependency metadata is invalid');
      }
    }
  }
  if (manifest.peerDependencies !== undefined) {
    const peers = manifest.peerDependencies;
    if (!peers || Array.isArray(peers) || typeof peers !== 'object') fail('client package peerDependencies must be an object');
    if (Object.keys(peers).length > NPM_RUNTIME_LIMITS.max_packages) fail('client package peer dependency list exceeds its limit');
    for (const [name, version] of Object.entries(peers)) {
      packageParts(name);
      if (typeof version !== 'string' || version.trim() === '') fail('client package peer dependency version is invalid');
      if (!dependencies.has(name)) dependencies.set(name, peerMeta?.[name]?.optional !== true);
    }
  }
  return [...dependencies].map(([name, required]) => ({ name, required }));
}

async function packageDocument(path, fsImpl) {
  let bytes;
  try {
    bytes = await fsImpl.readFile(path);
  } catch {
    fail('client package manifest is missing');
  }
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > MAX_PACKAGE_JSON_BYTES) fail('client package manifest exceeds its byte limit');
  try {
    return {
      bytes,
      value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
    };
  } catch {
    fail('client package manifest is malformed');
  }
}

async function resolveDependencyRoot(packageRoot, dependencyName, resolutionRoot, fsImpl) {
  const boundary = dirname(resolutionRoot);
  const parts = packageParts(dependencyName);
  let current = packageRoot;
  while (true) {
    if (basename(current).toLowerCase() !== 'node_modules') {
      const candidate = join(current, 'node_modules', ...parts);
      if (contained(resolutionRoot, candidate)) {
        try {
          await fsImpl.lstat(candidate);
          return await canonicalDirectory(candidate, { fsImpl, allowedRoots: [resolutionRoot] });
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error;
        }
      }
    }
    if (pathKey(current) === pathKey(boundary)) break;
    const parent = dirname(current);
    if (parent === current || !contained(boundary, parent)) break;
    current = parent;
  }
  return null;
}

async function captureNpmRuntime(packageRoot, resolutionRoot, packageId, fsImpl, runtimeTreePinner) {
  const canonicalResolutionRoot = await canonicalDirectory(resolutionRoot, {
    fsImpl,
    allowedRoots: [resolutionRoot],
  });
  const canonicalPackageRoot = await canonicalDirectory(packageRoot, {
    fsImpl,
    allowedRoots: [canonicalResolutionRoot],
  });
  if (!contained(canonicalResolutionRoot, canonicalPackageRoot)) fail('client package root escapes its resolution root');

  const packages = new Map();
  const queue = [{ root: canonicalPackageRoot, expectedName: packageId }];
  const manifestProofs = [];
  while (queue.length > 0) {
    const current = queue.shift();
    const key = pathKey(current.root);
    if (packages.has(key)) continue;
    if (packages.size >= NPM_RUNTIME_LIMITS.max_packages) fail('client package runtime exceeds its package limit');
    const manifestPath = join(current.root, 'package.json');
    const document = await packageDocument(manifestPath, fsImpl);
    if (!document.value || Array.isArray(document.value) || typeof document.value !== 'object'
      || typeof document.value.name !== 'string' || document.value.name.trim() === '') {
      fail('client package manifest identity is invalid');
    }
    if (current.expectedName !== null && document.value.name !== current.expectedName) {
      fail('client package identity changed during runtime inspection');
    }
    packages.set(key, current.root);
    manifestProofs.push({ path: manifestPath, sha256: sha256Bytes(document.bytes) });

    for (const dependency of dependencyRows(document.value)) {
      const dependencyRoot = await resolveDependencyRoot(current.root, dependency.name, canonicalResolutionRoot, fsImpl);
      if (dependencyRoot === null) {
        if (dependency.required) fail('required client package dependency is missing');
        continue;
      }
      queue.push({ root: dependencyRoot, expectedName: null });
    }
  }

  const packageRoots = [...packages.values()].sort((left, right) => left.length - right.length
    || (left < right ? -1 : left > right ? 1 : 0));
  const disjointRoots = [];
  for (const root of packageRoots) {
    if (!disjointRoots.some(parent => contained(parent, root))) disjointRoots.push(root);
  }

  return runtimeTreePinner({
    roots: disjointRoots,
    maxEntries: NPM_RUNTIME_LIMITS.max_entries,
    maxFiles: NPM_RUNTIME_LIMITS.max_files,
    maxBytes: NPM_RUNTIME_LIMITS.max_bytes,
    callback: async guard => {
      guard?.assertPinned?.();
      let entryCount = 0;
      let fileCount = 0;
      let totalBytes = 0;
      const entries = [];
      for (const root of disjointRoots) {
        const tree = await fingerprintDirectory(root, {
          allowedRoots: [canonicalResolutionRoot],
          fsImpl,
          maxEntries: NPM_RUNTIME_LIMITS.max_entries - entryCount,
          maxFiles: NPM_RUNTIME_LIMITS.max_files - fileCount,
          maxBytes: NPM_RUNTIME_LIMITS.max_bytes - totalBytes,
        });
        guard?.assertPinned?.();
        const prefix = relative(canonicalResolutionRoot, root).replace(/\\/g, '/');
        if (prefix === '..' || prefix.startsWith('../') || isAbsolute(prefix)) fail('client package tree escapes its resolution root');
        entryCount += tree.entry_count;
        fileCount += tree.file_count;
        totalBytes += tree.total_bytes;
        for (const entry of tree.entries) {
          entries.push({ ...entry, path: prefix === '' ? entry.path : `${prefix}/${entry.path}` });
        }
      }
      entries.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
      const entryByPath = new Map(entries.map(entry => [entry.path, entry]));
      for (const proof of manifestProofs) {
        const path = relative(canonicalResolutionRoot, proof.path).replace(/\\/g, '/');
        if (entryByPath.get(path)?.sha256 !== proof.sha256) fail('client package manifest changed during runtime inspection');
      }
      guard?.assertPinned?.();
      return runtimeFingerprint({
        packageRoot: canonicalPackageRoot,
        resolutionRoot: canonicalResolutionRoot,
        packageId,
        packageCount: packages.size,
        entryCount,
        fileCount,
        totalBytes,
        manifestSha256: sha256Canonical(entries),
      });
    },
  });
}

export async function captureClientRuntimeFingerprint(packageRoot, {
  resolutionRoot = packageRoot,
  packageId,
  fsImpl = defaultFs,
  runtimeTreePinner = withPinnedWindowsTrees,
} = {}) {
  if (typeof runtimeTreePinner !== 'function') fail('client runtime tree pinner is invalid');
  return captureNpmRuntime(packageRoot, resolutionRoot, packageId, fsImpl, runtimeTreePinner);
}

export async function revalidateClientLaunchRuntime(launch, {
  fsImpl = defaultFs,
  runtimeTreePinner = withPinnedWindowsTrees,
} = {}) {
  if (launch?.source !== 'npm_package') return true;
  let observed;
  try {
    observed = await captureClientRuntimeFingerprint(launch.fingerprint?.runtime_tree?.root, {
      resolutionRoot: launch.fingerprint?.runtime_tree?.resolution_root,
      packageId: launch.package_id,
      fsImpl,
      runtimeTreePinner,
    });
  } catch (error) {
    fail('client npm runtime tree is no longer safe', 'CLIENT_RUNTIME_CHANGED', {
      reason: 'RUNTIME_CAPTURE_FAILED',
      cause_code: error?.code ?? 'UNKNOWN',
    });
  }
  if (sha256Canonical(observed) !== sha256Canonical(launch.fingerprint.runtime_tree)) {
    fail(
      'client npm runtime tree changed after discovery',
      'CLIENT_RUNTIME_CHANGED',
      runtimeFingerprintMismatchDetails(observed, launch.fingerprint.runtime_tree),
    );
  }
  return true;
}

function launchFileEvidence(launch) {
  const paths = [launch.command];
  const fingerprints = [launch.fingerprint?.command];
  for (let index = 0; index < launch.args_prefix.length; index += 1) {
    const value = launch.args_prefix[index];
    if (!isAbsolute(value)) continue;
    paths.push(value);
    fingerprints.push(launch.fingerprint?.args_prefix?.[index]);
  }
  return { paths, fingerprints };
}

function frozenLaunchCopy(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(frozenLaunchCopy));
  if (value !== null && typeof value === 'object') {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, frozenLaunchCopy(child)]),
    ));
  }
  return value;
}

export async function withPinnedClientLaunch(launch, {
  callback,
  env = process.env,
  runner = null,
  authenticodeInspector = inspectAuthenticode,
  fsImpl = defaultFs,
  runtimeTreePinner = withPinnedWindowsTrees,
  launchFilePinner = withPinnedWindowsFiles,
} = {}) {
  if (typeof callback !== 'function'
    || typeof runtimeTreePinner !== 'function'
    || typeof launchFilePinner !== 'function') {
    fail('client launch pin contract is invalid', 'INVALID_CLIENT_LAUNCH');
  }
  if (!launch
    || !absoluteSafePath(launch.command)
    || !Array.isArray(launch.args_prefix)
    || launch.args_prefix.some(path => !absoluteSafePath(path))
    || !launch.fingerprint?.command
    || !Array.isArray(launch.fingerprint.args_prefix)
    || launch.fingerprint.args_prefix.length !== launch.args_prefix.length
    || !['native', 'npm_package'].includes(launch.source)) {
    fail('client launch pin evidence is invalid', 'INVALID_CLIENT_LAUNCH');
  }
  const pinnedLaunch = frozenLaunchCopy(launch);
  const evidence = launchFileEvidence(pinnedLaunch);
  const runWithFilesPinned = treeGuard => launchFilePinner({
    paths: evidence.paths,
    callback: async fileGuard => {
      treeGuard?.assertPinned?.();
      fileGuard?.assertPinned?.();
      const changedFields = new Set();
      for (let index = 0; index < evidence.paths.length; index += 1) {
        const path = evidence.paths[index];
        const observed = await fingerprintPath(path, { allowedRoots: [dirname(path)], fsImpl });
        if (sha256Canonical(observed) !== sha256Canonical(evidence.fingerprints[index])) {
          changedFields.add(index === 0 ? 'command' : 'args_prefix');
        }
      }
      if (changedFields.size > 0) {
        fail('client launch file changed after discovery', 'CLIENT_RUNTIME_CHANGED', {
          reason: 'RUNTIME_FINGERPRINT_MISMATCH',
          changed_fields: [...changedFields],
        });
      }
      if (pinnedLaunch.source === 'native' && CLIENT_NATIVE_IDENTITIES[pinnedLaunch.client_id]) {
        await revalidatePinnedNativeAuthority(pinnedLaunch, {
          env,
          runner,
          fsImpl,
          authenticodeInspector,
        });
      }
      treeGuard?.assertPinned?.();
      fileGuard?.assertPinned?.();
      return callback(Object.freeze({
        assertPinned() {
          treeGuard?.assertPinned?.();
          fileGuard?.assertPinned?.();
        },
      }), pinnedLaunch);
    },
  });

  if (pinnedLaunch.source !== 'npm_package') return runWithFilesPinned(null);
  const expectedRuntime = pinnedLaunch.fingerprint?.runtime_tree;
  return captureNpmRuntime(
    expectedRuntime?.root,
    expectedRuntime?.resolution_root,
    pinnedLaunch.package_id,
    fsImpl,
    pinOptions => runtimeTreePinner({
      ...pinOptions,
      callback: async treeGuard => {
        const observed = await pinOptions.callback(treeGuard);
        if (sha256Canonical(observed) !== sha256Canonical(expectedRuntime)) {
          fail(
            'client npm runtime tree changed after discovery',
            'CLIENT_RUNTIME_CHANGED',
            runtimeFingerprintMismatchDetails(observed, expectedRuntime),
          );
        }
        treeGuard?.assertPinned?.();
        return runWithFilesPinned(treeGuard);
      },
    }),
  );
}

async function revalidatePinnedNativeAuthority(launch, {
  env,
  runner,
  fsImpl,
  authenticodeInspector,
}) {
  if (!env || typeof env !== 'object' || !runner?.run || typeof authenticodeInspector !== 'function') {
    fail('native client authority dependencies are unavailable', 'CLIENT_RUNTIME_CHANGED', {
      reason: 'NATIVE_AUTHORITY_CHANGED',
    });
  }
  let canonicalAllowedPaths;
  try {
    canonicalAllowedPaths = (await Promise.all(expectedNativePaths(launch.client_id, env).map(async path => {
      try {
        return resolve(await fsImpl.realpath(resolve(path)));
      } catch {
        return null;
      }
    }))).filter(Boolean);
  } catch {
    canonicalAllowedPaths = [];
  }
  if (!canonicalAllowedPaths.some(path => pathKey(path) === pathKey(launch.command))) {
    fail('native client path is no longer authorized', 'CLIENT_RUNTIME_CHANGED', {
      reason: 'NATIVE_AUTHORITY_CHANGED',
      changed_fields: ['command'],
    });
  }
  let observed = null;
  try {
    observed = await validAuthenticode(launch.command, launch.client_id, {
      env,
      runner,
      fsImpl,
      authenticodeInspector,
    });
  } catch {
    observed = null;
  }
  if (observed === null
    || sha256Canonical(observed) !== sha256Canonical(launch.fingerprint.authenticode)) {
    fail('native client signature changed after discovery', 'CLIENT_RUNTIME_CHANGED', {
      reason: 'NATIVE_AUTHORITY_CHANGED',
      changed_fields: ['authenticode'],
    });
  }
}

function absoluteSafePath(path) {
  return typeof path === 'string' && isAbsolute(path) && !/^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(path);
}

async function canonicalAllowlistedRoots(allowedRoots, fsImpl) {
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    fail('client launch allowlisted roots are invalid');
  }
  const canonical = [];
  try {
    for (const root of allowedRoots) canonical.push(resolve(await fsImpl.realpath(resolve(root))));
  } catch {
    fail('client launch allowlisted root is unavailable');
  }
  return canonical;
}

async function canonicalFile(path, {
  fsImpl,
  allowedRoots,
  basenameRequired = null,
  allowHardLinks = false,
} = {}) {
  if (!absoluteSafePath(path)) fail('client launch candidate path is unsafe');
  const requested = resolve(path);
  let requestedStat;
  let canonical;
  let stat;
  try {
    requestedStat = await fsImpl.lstat(requested);
    if (requestedStat.isSymbolicLink()) fail('client launch candidate is linked');
    canonical = resolve(await fsImpl.realpath(requested));
    stat = await fsImpl.lstat(canonical);
  } catch (error) {
    if (error instanceof ClientProcessError) throw error;
    fail('client launch candidate is missing');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1 || (!allowHardLinks && stat.nlink !== 1)) {
    fail(`client launch candidate must be a regular ${allowHardLinks ? 'non-symbolic' : 'single-link'} file`);
  }
  if (basenameRequired && basename(canonical).toLowerCase() !== basenameRequired.toLowerCase()) fail('client launch candidate basename is invalid');
  const canonicalRoots = await canonicalAllowlistedRoots(allowedRoots, fsImpl);
  if (!canonicalRoots.some(root => contained(root, canonical))) fail('client launch candidate escapes its allowlisted root');
  const fingerprint = await fingerprintPath(canonical, { allowedRoots: canonicalRoots, fsImpl });
  if (!fingerprint.exists || fingerprint.kind !== 'file' || fingerprint.link_kind !== 'none'
    || fingerprint.link_count < 1 || (!allowHardLinks && fingerprint.link_count !== 1)) {
    fail('client launch candidate fingerprint is unsafe');
  }
  return { path: canonical, fingerprint };
}

async function canonicalDirectory(path, { fsImpl, allowedRoots }) {
  if (!absoluteSafePath(path)) fail('client package directory is unsafe');
  const requested = resolve(path);
  let requestedStat;
  let canonical;
  let stat;
  try {
    requestedStat = await fsImpl.lstat(requested);
    if (requestedStat.isSymbolicLink()) fail('client package directory is linked');
    canonical = resolve(await fsImpl.realpath(requested));
    stat = await fsImpl.lstat(canonical);
  } catch (error) {
    if (error instanceof ClientProcessError) throw error;
    fail('client package directory is missing');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('client package path is not a directory');
  const canonicalRoots = await canonicalAllowlistedRoots(allowedRoots, fsImpl);
  if (!canonicalRoots.some(root => contained(root, canonical))) fail('client package directory escapes its allowlisted root');
  return canonical;
}

function candidateRows(clientId, candidates) {
  if (Array.isArray(candidates)) return candidates;
  if (candidates && Object.hasOwn(candidates, clientId)) return candidates[clientId];
  return null;
}

function npmPrefixes(env, candidates) {
  const rows = [];
  const appData = readWindowsEnvironmentValue(env, 'APPDATA');
  const npmConfigPrefix = readWindowsEnvironmentValue(env, 'NPM_CONFIG_PREFIX');
  if (appData) rows.push(join(appData, 'npm'));
  if (npmConfigPrefix) rows.push(resolve(npmConfigPrefix));
  for (const path of candidates?.npmPrefixes ?? []) rows.push(resolve(path));
  return [...new Map(rows.map(path => [pathKey(path), resolve(path)])).values()];
}

function expectedNativePaths(clientId, env) {
  if (clientId === 'claude') {
    const userProfile = readWindowsEnvironmentValue(env, 'USERPROFILE');
    return userProfile ? [join(userProfile, '.local', 'bin', 'claude.exe')] : [];
  }
  if (clientId === 'vscode') {
    const localAppData = readWindowsEnvironmentValue(env, 'LOCALAPPDATA');
    const programFiles = readWindowsEnvironmentValue(env, 'PROGRAMFILES');
    return [
      localAppData ? join(localAppData, 'Programs', 'Microsoft VS Code', 'Code.exe') : null,
      programFiles ? join(programFiles, 'Microsoft VS Code', 'Code.exe') : null,
    ].filter(Boolean);
  }
  return [];
}

async function discoverWithWhere(clientId, { env, runner, fsImpl }) {
  const systemRoot = readWindowsEnvironmentValue(env, 'SYSTEMROOT')
    || readWindowsEnvironmentValue(env, 'WINDIR');
  if (!systemRoot) return [];
  const wherePath = join(systemRoot, 'System32', 'where.exe');
  let where;
  try {
    where = await canonicalFile(wherePath, {
      fsImpl,
      allowedRoots: [join(systemRoot, 'System32')],
      basenameRequired: 'where.exe',
      allowHardLinks: true,
    });
  } catch {
    return [];
  }
  const path = readWindowsEnvironmentValue(env, 'PATH');
  const pathExt = readWindowsEnvironmentValue(env, 'PATHEXT');
  const discoveryEnv = {
    SystemRoot: resolve(systemRoot),
    WINDIR: resolve(systemRoot),
    ...(typeof path === 'string' ? { PATH: path } : {}),
    ...(typeof pathExt === 'string' ? { PATHEXT: pathExt } : {}),
  };
  const result = await runner.run(where.path, [CLIENTS[clientId].command_name], {
    env: discoveryEnv,
    shell: false,
    timeoutMs: 5_000,
    outputLimitBytes: 64 * 1024,
  });
  if (result.status !== 'exited' || ![0, 1].includes(result.exitCode)) return [];
  return result.exitCode === 0 ? result.stdout.split(/\r?\n/).map(value => value.trim()).filter(Boolean) : [];
}

async function readPackageJson(path, fsImpl) {
  return (await packageDocument(path, fsImpl)).value;
}

async function readUtf8(path, fsImpl, byteLimit, label) {
  let bytes;
  try {
    bytes = await fsImpl.readFile(path);
  } catch {
    fail(`${label} is unreadable`);
  }
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > byteLimit) fail(`${label} exceeds its byte limit`);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(`${label} is not valid UTF-8`);
  }
}

function parseVsCodeWrapper(content, wrapperDir, installRoot) {
  const references = [...content.matchAll(/"%~dp0([^"\r\n]+)"/gi)]
    .map(match => resolve(wrapperDir, match[1].replace(/[\\/]/g, sep)));
  const expectedCommand = join(installRoot, 'Code.exe');
  if (references.length !== 2
    || references.some(path => !contained(installRoot, path))
    || pathKey(references[0]) !== pathKey(expectedCommand)
    || !isVersionedVsCodeCli(installRoot, references[1])) {
    fail('VS Code wrapper does not describe one canonical same-root CLI tuple');
  }
  return { command: expectedCommand, cli: references[1] };
}

function isVersionedVsCodeCli(installRoot, cliPath) {
  const rel = relative(installRoot, cliPath);
  const parts = rel.split(sep);
  return parts.length === 5
    && parts[0] !== ''
    && parts[0] !== '.'
    && parts[0] !== '..'
    && parts.slice(1).map(value => value.toLowerCase()).join('/') === 'resources/app/out/cli.js';
}

async function discoverVersionedVsCodeCli(installRoot, fsImpl) {
  let entries;
  try {
    entries = await fsImpl.readdir(installRoot, { withFileTypes: true });
  } catch {
    fail('VS Code install root is unreadable');
  }
  if (entries.length > MAX_CLIENT_CANDIDATES) fail('VS Code install root exceeds its bounded candidate limit');
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const versionRoot = join(installRoot, entry.name);
    let canonicalRoot;
    try {
      canonicalRoot = await canonicalDirectory(versionRoot, { fsImpl, allowedRoots: [installRoot] });
      if (pathKey(dirname(canonicalRoot)) !== pathKey(installRoot)) continue;
      const cli = await canonicalFile(join(canonicalRoot, 'resources', 'app', 'out', 'cli.js'), {
        fsImpl,
        allowedRoots: [canonicalRoot],
        basenameRequired: 'cli.js',
      });
      if (isVersionedVsCodeCli(installRoot, cli.path)) candidates.push(cli.path);
    } catch (error) {
      if (!(error instanceof ClientProcessError)) throw error;
    }
  }
  if (candidates.length !== 1) fail('VS Code install must expose exactly one versioned CLI candidate');
  return candidates[0];
}

async function resolveNodeExecutable(candidates, fsImpl) {
  const nodePath = candidates?.nodeExecutable ?? process.execPath;
  return canonicalFile(resolve(nodePath), {
    fsImpl,
    allowedRoots: [dirname(resolve(nodePath))],
    basenameRequired: process.platform === 'win32' ? 'node.exe' : basename(process.execPath),
  });
}

async function resolveNpmCandidate(clientId, candidate, {
  env,
  fsImpl,
  candidates,
  runtimeTreePinner,
}) {
  const config = CLIENTS[clientId];
  if (!config.package_id) fail('client does not support npm package resolution');
  const prefixes = npmPrefixes(env, candidates);
  const matchingPrefix = prefixes.find(prefix => pathKey(dirname(resolve(candidate))) === pathKey(prefix));
  if (!matchingPrefix) fail('npm shim is outside an allowlisted prefix');
  const expectedNames = [config.bin_name, `${config.bin_name}.cmd`, `${config.bin_name}.ps1`];
  if (!expectedNames.includes(basename(candidate).toLowerCase())) fail('npm shim basename is invalid');
  await canonicalFile(resolve(candidate), { fsImpl, allowedRoots: [matchingPrefix] });

  const modulesRoot = await canonicalDirectory(join(matchingPrefix, 'node_modules'), {
    fsImpl,
    allowedRoots: [matchingPrefix],
  });
  const requestedPackageRoot = join(modulesRoot, ...config.package_id.split('/'));
  const packageRoot = await canonicalDirectory(requestedPackageRoot, {
    fsImpl,
    allowedRoots: [modulesRoot],
  });
  const manifestFile = await canonicalFile(join(packageRoot, 'package.json'), {
    fsImpl,
    allowedRoots: [packageRoot],
    basenameRequired: 'package.json',
  });
  const manifest = await readPackageJson(manifestFile.path, fsImpl);
  if (manifest.name !== config.package_id || typeof manifest.version !== 'string') fail('client package identity is invalid');
  const binPath = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[config.bin_name];
  if (typeof binPath !== 'string' || binPath.trim() === '') fail('client package bin entry is missing');
  const requestedEntry = resolve(packageRoot, binPath);
  if (!contained(packageRoot, requestedEntry)) fail('client package bin entry escapes its package root');
  const entry = await canonicalFile(requestedEntry, { fsImpl, allowedRoots: [packageRoot] });
  const node = await resolveNodeExecutable(candidates, fsImpl);
  let runtimeTree;
  try {
    runtimeTree = await captureClientRuntimeFingerprint(packageRoot, {
      resolutionRoot: modulesRoot,
      packageId: config.package_id,
      fsImpl,
      runtimeTreePinner,
    });
  } catch (error) {
    fail('client npm runtime tree is unsafe or exceeds its inspection limits', 'NOT_INSTALLED', {
      cause_code: error?.code ?? 'UNKNOWN',
      cause_reason: error instanceof ClientProcessError ? error.message : null,
    });
  }
  return {
    command: node.path,
    args_prefix: [entry.path],
    env_overlay: {},
    package_id: config.package_id,
    source: 'npm_package',
    fingerprint: {
      command: node.fingerprint,
      args_prefix: [entry.fingerprint],
      package_manifest: manifestFile.fingerprint,
      runtime_tree: runtimeTree,
      env_overlay_sha256: sha256Canonical({}),
    },
  };
}

async function validAuthenticode(path, clientId, { env, runner, fsImpl, authenticodeInspector }) {
  const expected = CLIENTS[clientId].signer;
  const result = await authenticodeInspector(path, {
    runner,
    systemRoot: readWindowsEnvironmentValue(env, 'SYSTEMROOT')
      || readWindowsEnvironmentValue(env, 'WINDIR'),
    expectedSignerNames: [expected],
    allowedRoots: [dirname(path)],
    fsImpl,
  });
  return result?.status === 'valid' && result.signer_name === expected ? result : null;
}

async function resolveNativeCandidate(clientId, candidate, context) {
  const allowedPaths = expectedNativePaths(clientId, context.env).map(path => resolve(path));
  let commandCandidate = resolve(candidate);
  let cliCandidate = null;
  let discoveryClue = null;
  if (clientId === 'vscode' && basename(commandCandidate).toLowerCase() === 'code.cmd') {
    const installRoot = dirname(dirname(commandCandidate));
    const expectedCommand = allowedPaths.find(path => pathKey(dirname(path)) === pathKey(installRoot));
    if (!expectedCommand || pathKey(dirname(commandCandidate)) !== pathKey(join(installRoot, 'bin'))) {
      fail('VS Code wrapper is outside its standard install root');
    }
    discoveryClue = await canonicalFile(commandCandidate, {
      fsImpl: context.fsImpl,
      allowedRoots: [installRoot],
      basenameRequired: 'code.cmd',
    });
    const wrapperContent = await readUtf8(discoveryClue.path, context.fsImpl, MAX_VSCODE_WRAPPER_BYTES, 'VS Code wrapper');
    const canonicalInstallRoot = dirname(dirname(discoveryClue.path));
    const wrapperTuple = parseVsCodeWrapper(wrapperContent, dirname(discoveryClue.path), canonicalInstallRoot);
    commandCandidate = expectedCommand;
    cliCandidate = wrapperTuple.cli;
  }
  const expected = allowedPaths.find(path => pathKey(path) === pathKey(commandCandidate));
  if (!expected) fail('native client path is outside its allowlist');
  const command = await canonicalFile(commandCandidate, {
    fsImpl: context.fsImpl,
    allowedRoots: [dirname(expected)],
    basenameRequired: clientId === 'vscode' ? 'Code.exe' : 'claude.exe',
  });
  const signature = await validAuthenticode(command.path, clientId, context);
  if (!signature) fail('native client signature is invalid');

  if (clientId === 'claude') {
    return {
      command: command.path,
      args_prefix: [],
      env_overlay: {},
      package_id: null,
      source: 'native',
      fingerprint: {
        command: command.fingerprint,
        args_prefix: [],
        authenticode: signature,
        env_overlay_sha256: sha256Canonical({}),
      },
    };
  }

  const installRoot = dirname(command.path);
  const selectedCli = cliCandidate ?? await discoverVersionedVsCodeCli(installRoot, context.fsImpl);
  const cli = await canonicalFile(selectedCli, {
    fsImpl: context.fsImpl,
    allowedRoots: [installRoot],
    basenameRequired: 'cli.js',
  });
  return {
    command: command.path,
    args_prefix: [cli.path],
    env_overlay: expectedClientLaunchOverlay('vscode'),
    package_id: null,
    source: 'native',
    fingerprint: {
      command: command.fingerprint,
      args_prefix: [cli.fingerprint],
      authenticode: signature,
      env_overlay_sha256: sha256Canonical(expectedClientLaunchOverlay('vscode')),
      ...(discoveryClue ? { discovery_clue: discoveryClue.fingerprint } : {}),
    },
  };
}

async function resolveCandidate(clientId, candidate, context) {
  const extension = extname(candidate).toLowerCase();
  if (clientId === 'vscode' || (clientId === 'claude' && extension === '.exe')) {
    return resolveNativeCandidate(clientId, candidate, context);
  }
  if (extension === '.cmd' || extension === '.ps1' || extension === '') {
    return resolveNpmCandidate(clientId, candidate, context);
  }
  fail('client candidate type is unsupported');
}

function parseVersionOutput(stdout) {
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const match = /(?:^|\s)v?(\d+\.\d+\.\d+)(?:\s|$)/.exec(line.trim());
    if (match) return match[1];
  }
  return null;
}

async function probeVersion(launch, {
  env,
  runner,
  fsImpl,
  authenticodeInspector,
  runtimeTreePinner,
  launchFilePinner,
}) {
  const childEnv = clientProcessEnvironment(env, launch.env_overlay);
  const result = await withPinnedClientLaunch(launch, {
    env,
    runner,
    authenticodeInspector,
    fsImpl,
    runtimeTreePinner,
    launchFilePinner,
    callback: (guard, pinnedLaunch) => runner.run(pinnedLaunch.command, [...pinnedLaunch.args_prefix, '--version'], {
      env: childEnv,
      shell: false,
      timeoutMs: 10_000,
      outputLimitBytes: 64 * 1024,
    }),
  });
  if (result.status !== 'exited' || result.exitCode !== 0) fail('client version probe failed', 'VERSION_PROBE_FAILED');
  const version = parseVersionOutput(result.stdout);
  if (!version) fail('client version output is unsupported', 'VERSION_PROBE_FAILED');
  return version;
}

function launchIdentity(launch) {
  return sha256Canonical({
    command: pathKey(launch.command),
    args_prefix: launch.args_prefix.map(value => absoluteSafePath(value) ? pathKey(value) : value),
    env_overlay: launch.env_overlay,
    package_id: launch.package_id,
    source: launch.source,
  });
}

export async function resolveClientLaunch(clientId, {
  env = process.env,
  fsImpl = defaultFs,
  runner,
  candidates = null,
  authenticodeInspector = inspectAuthenticode,
  runtimeTreePinner = withPinnedWindowsTrees,
  launchFilePinner = withPinnedWindowsFiles,
} = {}) {
  if (!CLIENT_IDS.includes(clientId)) fail('client ID is unsupported', 'UNSUPPORTED_CLIENT');
  if (!runner?.run) fail('client resolution requires a bounded process runner', 'CLIENT_DISCOVERY_FAILED');
  const explicitRows = candidateRows(clientId, candidates);
  const discovered = explicitRows === null
    ? await discoverWithWhere(clientId, { env, runner, fsImpl })
    : explicitRows;
  if (!Array.isArray(discovered)) fail('client candidate list is invalid', 'CLIENT_DISCOVERY_FAILED');
  if (discovered.length > MAX_CLIENT_CANDIDATES) fail('client candidate list exceeds its bounded limit', 'CLIENT_DISCOVERY_FAILED');
  const unique = [...new Map(discovered
    .filter(path => typeof path === 'string' && path.trim() !== '' && absoluteSafePath(path))
    .map(path => [pathKey(path), resolve(path)])).values()];
  if (unique.length === 0) fail('client is not installed');

  const valid = [];
  const rejected = [];
  for (const candidate of unique) {
    try {
      valid.push(await resolveCandidate(clientId, candidate, {
        env,
        fsImpl,
        runner,
        candidates,
        authenticodeInspector,
        runtimeTreePinner,
      }));
    } catch (error) {
      if (!(error instanceof ClientProcessError)) throw error;
      rejected.push({
        code: error.details?.cause_code ?? error.code,
        reason: error.details?.cause_reason ?? error.message,
      });
    }
  }
  if (valid.length === 0) {
    fail('no safe client launch candidate was found', 'NOT_INSTALLED', {
      candidate_count: unique.length,
      rejection_codes: [...new Set(rejected.map(row => row.code))].sort(),
      rejection_reasons: [...new Set(rejected.map(row => row.reason))].sort(),
    });
  }

  const uniqueLaunches = [...new Map(valid.map(launch => [launchIdentity(launch), launch])).values()];

  let lastProbeError = null;
  const viable = [];
  for (const launch of uniqueLaunches) {
    try {
      const version = await probeVersion(launch, {
        env,
        runner,
        fsImpl,
        authenticodeInspector,
        runtimeTreePinner,
        launchFilePinner,
      });
      const compatibility = classifySupportedVersion(clientId, version);
      const result = {
        client_id: clientId,
        command: launch.command,
        args_prefix: Object.freeze([...launch.args_prefix]),
        env_overlay: Object.freeze({ ...launch.env_overlay }),
        package_id: launch.package_id,
        source: launch.source,
        version,
        compatibility,
        fingerprint: Object.freeze(launch.fingerprint),
        write_supported: compatibility === 'release_gated',
      };
      validateClientLaunchContract(result);
      viable.push(Object.freeze(result));
    } catch (error) {
      if (error?.code !== 'VERSION_PROBE_FAILED') throw error;
      lastProbeError = error;
    }
  }
  if (viable.length > 1) {
    fail('multiple distinct client installations are viable', 'AMBIGUOUS_CLIENT_INSTALLATION', {
      candidate_count: viable.length,
    });
  }
  if (viable.length === 1) return viable[0];
  throw lastProbeError ?? new ClientProcessError('client version probe failed', 'VERSION_PROBE_FAILED');
}
