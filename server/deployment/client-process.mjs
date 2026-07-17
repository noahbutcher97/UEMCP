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

import { sha256Canonical } from './canonical-json.mjs';
import {
  classifySupportedVersion,
  CLIENT_IDS,
  mergeWindowsEnvironmentOverlay,
  readWindowsEnvironmentValue,
  validateClientLaunchContract,
} from './client-contract.mjs';
import { fingerprintPath } from './fingerprints.mjs';
import { inspectAuthenticode } from './windows-native.mjs';

const CLIENTS = Object.freeze({
  claude: Object.freeze({
    command_name: 'claude',
    package_id: '@anthropic-ai/claude-code',
    bin_name: 'claude',
    signer: 'Anthropic, PBC',
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
    signer: 'Microsoft Corporation',
  }),
});

const VSCODE_OVERLAY = Object.freeze({ ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' });
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const MAX_VSCODE_WRAPPER_BYTES = 64 * 1024;
const MAX_CLIENT_CANDIDATES = 64;

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

function absoluteSafePath(path) {
  return typeof path === 'string' && isAbsolute(path) && !/^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(path);
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
  if (!allowedRoots.some(root => contained(root, canonical))) fail('client launch candidate escapes its allowlisted root');
  const fingerprint = await fingerprintPath(canonical, { allowedRoots, fsImpl });
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
  if (!allowedRoots.some(root => contained(root, canonical))) fail('client package directory escapes its allowlisted root');
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
  let bytes;
  try {
    bytes = await fsImpl.readFile(path);
  } catch {
    fail('client package manifest is missing');
  }
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length > MAX_PACKAGE_JSON_BYTES) fail('client package manifest exceeds its byte limit');
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    fail('client package manifest is malformed');
  }
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

async function resolveNpmCandidate(clientId, candidate, { env, fsImpl, candidates }) {
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
    const wrapperTuple = parseVsCodeWrapper(wrapperContent, dirname(discoveryClue.path), installRoot);
    commandCandidate = wrapperTuple.command;
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
    env_overlay: { ...VSCODE_OVERLAY },
    package_id: null,
    source: 'native',
    fingerprint: {
      command: command.fingerprint,
      args_prefix: [cli.fingerprint],
      authenticode: signature,
      env_overlay_sha256: sha256Canonical(VSCODE_OVERLAY),
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

async function probeVersion(launch, { env, runner }) {
  const childEnv = mergeWindowsEnvironmentOverlay(env, launch.env_overlay);
  const result = await runner.run(launch.command, [...launch.args_prefix, '--version'], {
    env: childEnv,
    shell: false,
    timeoutMs: 10_000,
    outputLimitBytes: 64 * 1024,
  });
  if (result.status !== 'exited' || result.exitCode !== 0) fail('client version probe failed', 'VERSION_PROBE_FAILED');
  const version = parseVersionOutput(result.stdout);
  if (!version) fail('client version output is unsupported', 'VERSION_PROBE_FAILED');
  return version;
}

export async function resolveClientLaunch(clientId, {
  env = process.env,
  fsImpl = defaultFs,
  runner,
  candidates = null,
  authenticodeInspector = inspectAuthenticode,
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
  for (const candidate of unique) {
    try {
      valid.push(await resolveCandidate(clientId, candidate, {
        env,
        fsImpl,
        runner,
        candidates,
        authenticodeInspector,
      }));
    } catch (error) {
      if (!(error instanceof ClientProcessError)) throw error;
    }
  }
  if (valid.length === 0) fail('no safe client launch candidate was found');

  let lastProbeError = null;
  for (const launch of valid) {
    try {
      const version = await probeVersion(launch, { env, runner });
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
      return Object.freeze(result);
    } catch (error) {
      if (error?.code !== 'VERSION_PROBE_FAILED') throw error;
      lastProbeError = error;
    }
  }
  throw lastProbeError ?? new ClientProcessError('client version probe failed', 'VERSION_PROBE_FAILED');
}
