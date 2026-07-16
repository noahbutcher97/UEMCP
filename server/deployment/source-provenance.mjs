import * as defaultFs from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 } from 'node:path';

import { canonicalJson, sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { fingerprintPath } from './fingerprints.mjs';
import { createProcessRunner } from './process-runner.mjs';
import { inspectAuthenticode } from './windows-native.mjs';

const PROVENANCE_FILE = '.uemcp-source-provenance.json';
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256 = /^[0-9a-f]{64}$/;

export class SourceProvenanceError extends Error {
  constructor(message, code = 'SOURCE_PROVENANCE_UNKNOWN', details = {}) {
    super(message);
    this.name = 'SourceProvenanceError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, details) {
  throw new SourceProvenanceError(message, 'SOURCE_PROVENANCE_UNKNOWN', details);
}

function exactKeys(value, expected, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} has an unexpected schema`);
}

function slash(value) {
  return value.split(sep).join('/');
}

function isSafePayloadPath(value) {
  return typeof value === 'string'
    && value.length > 0
    && !value.includes('\\')
    && !value.startsWith('/')
    && !/^[A-Za-z]:/.test(value)
    && !value.split('/').some(segment => segment === '' || segment === '.' || segment === '..');
}

async function pathExists(fsImpl, path) {
  try {
    return await fsImpl.lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function normalizeRepository(remote) {
  if (typeof remote !== 'string') return 'local-checkout';
  const value = remote.trim().replace(/[\u0000-\u001f\u007f]/g, '');
  if (value === '') return 'local-checkout';
  let host;
  let pathname;
  const scp = value.includes('://') ? null : /^(?:[^@/:]+@)?([^/:]+):(.+)$/.exec(value);
  if (scp && !/^[A-Za-z]:[\\/]/.test(value)) {
    host = scp[1].toLowerCase();
    pathname = scp[2];
  } else {
    try {
      const parsed = new URL(value);
      if (!['https:', 'http:', 'ssh:', 'git:'].includes(parsed.protocol)) return 'local-checkout';
      host = parsed.hostname.toLowerCase();
      pathname = parsed.pathname;
    } catch {
      return 'local-checkout';
    }
  }
  const segments = pathname.replace(/^\/+/, '').replace(/\.git\/?$/i, '').split('/').filter(Boolean);
  if (!host || segments.length < 2 || !segments.every(segment => /^[A-Za-z0-9._-]+$/.test(segment))) return 'local-checkout';
  const project = segments.slice(-2).join('/');
  return host === 'github.com' ? project : `${host}/${project}`;
}

function gitCandidatePaths(environment) {
  const candidates = [];
  for (const root of [environment.ProgramFiles, environment['ProgramFiles(x86)']]) {
    if (!root) continue;
    candidates.push(join(root, 'Git', 'cmd', 'git.exe'));
    candidates.push(join(root, 'Git', 'bin', 'git.exe'));
  }
  if (environment.LOCALAPPDATA) candidates.push(join(environment.LOCALAPPDATA, 'Programs', 'Git', 'cmd', 'git.exe'));
  return [...new Set(candidates.map(candidate => resolve(candidate)))];
}

async function selectGitExecutable({ gitExecutable, fsImpl, runner, authenticodeInspector, environment }) {
  const candidates = gitExecutable ? [resolve(gitExecutable)] : gitCandidatePaths(environment);
  for (const candidate of candidates) {
    try {
      const fingerprint = await fingerprintPath(candidate, { allowedRoots: [dirname(candidate)], fsImpl });
      if (!fingerprint.exists || fingerprint.kind !== 'file' || fingerprint.link_kind !== 'none') continue;
      const signature = await authenticodeInspector(candidate, {
        runner,
        systemRoot: environment.SystemRoot || environment.WINDIR,
        allowedRoots: [dirname(candidate)],
        fsImpl,
      });
      if (signature.status !== 'valid') continue;
      const version = await runner.run(candidate, ['--version'], {
        env: {},
        timeoutMs: 10_000,
        outputLimitBytes: 8 * 1024,
      });
      if (version.status === 'exited' && version.exitCode === 0 && /^git version \d+\.\d+\.\d+/i.test(version.stdout.trim())) {
        return candidate;
      }
    } catch {
      // Try the next fixed candidate.
    }
  }
  fail('no attributable Git executable is available');
}

async function runGit(runner, executable, args, repoRoot, { allowFailure = false } = {}) {
  const result = await runner.run(executable, args, {
    cwd: repoRoot,
    env: {},
    timeoutMs: 15_000,
    outputLimitBytes: 1024 * 1024,
  });
  if (result.status !== 'exited' || (!allowFailure && result.exitCode !== 0) || result.stderr !== '') {
    if (allowFailure && result.status === 'exited') return null;
    fail('Git provenance command failed', { command: args[0] });
  }
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function inspectCheckout({ repoRoot, fsImpl, runner, gitExecutable, authenticodeInspector, environment }) {
  const gitPath = await selectGitExecutable({ gitExecutable, fsImpl, runner, authenticodeInspector, environment });
  const topLevel = resolve(await runGit(runner, gitPath, ['rev-parse', '--show-toplevel'], repoRoot));
  const expectedRoot = process.platform === 'win32' ? resolve(repoRoot).toLowerCase() : resolve(repoRoot);
  const observedRoot = process.platform === 'win32' ? topLevel.toLowerCase() : topLevel;
  if (expectedRoot !== observedRoot) fail('Git top-level does not match the requested repository root');
  const remote = await runGit(runner, gitPath, ['config', '--get', 'remote.origin.url'], repoRoot, { allowFailure: true });
  const gitCommit = await runGit(runner, gitPath, ['rev-parse', 'HEAD'], repoRoot);
  if (!GIT_OBJECT_ID.test(gitCommit)) fail('Git returned a non-canonical object ID');
  const status = await runGit(runner, gitPath, ['status', '--porcelain=v1', '--untracked-files=all'], repoRoot);
  return {
    kind: 'git_checkout',
    repository: normalizeRepository(remote),
    repo_root: resolve(repoRoot),
    git_commit: gitCommit,
    dirty: status.length > 0,
    archive: null,
  };
}

async function readArchiveDocument(path, fsImpl) {
  let parsed;
  try {
    const stat = await fsImpl.lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('archive provenance file must be a regular single-link file');
    parsed = JSON.parse(await fsImpl.readFile(path, 'utf8'));
  } catch (error) {
    if (error instanceof SourceProvenanceError) throw error;
    fail('archive provenance file is missing or malformed');
  }
  exactKeys(parsed, new Set([
    'schema_version',
    'kind',
    'repository',
    'requested_ref',
    'git_commit',
    'archive_sha256',
    'bundle_manifest_sha256',
    'payload_entries',
    'payload_manifest_sha256',
    'downloaded_at',
    'provenance_sha256',
  ]), 'archive provenance');
  if (parsed.schema_version !== '1.0' || parsed.kind !== 'pinned_github_archive') fail('archive provenance kind/schema is unsupported');
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(parsed.repository)) fail('archive repository identity is invalid');
  if (typeof parsed.requested_ref !== 'string' || parsed.requested_ref.trim() === '') fail('archive requested ref is invalid');
  if (!GIT_OBJECT_ID.test(parsed.git_commit)) fail('archive Git object ID is invalid');
  for (const key of ['archive_sha256', 'bundle_manifest_sha256', 'payload_manifest_sha256', 'provenance_sha256']) {
    if (!SHA256.test(parsed[key])) fail(`archive ${key} is invalid`);
  }
  if (!Number.isFinite(Date.parse(parsed.downloaded_at)) || new Date(parsed.downloaded_at).toISOString() !== parsed.downloaded_at) {
    fail('archive download timestamp is invalid');
  }
  if (!Array.isArray(parsed.payload_entries)) fail('archive payload entries must be an array');
  let previous = null;
  for (const entry of parsed.payload_entries) {
    exactKeys(entry, new Set(['path', 'size', 'sha256']), 'archive payload entry');
    if (!isSafePayloadPath(entry.path) || !Number.isSafeInteger(entry.size) || entry.size < 0 || !SHA256.test(entry.sha256)) {
      fail('archive payload entry is invalid');
    }
    if (previous !== null && previous >= entry.path) {
      fail('archive payload entries must be unique and ordinal sorted');
    }
    previous = entry.path;
  }
  if (sha256Canonical(parsed.payload_entries) !== parsed.payload_manifest_sha256) fail('archive payload manifest hash is invalid');
  const withoutSelfHash = { ...parsed };
  delete withoutSelfHash.provenance_sha256;
  if (sha256Canonical(withoutSelfHash) !== parsed.provenance_sha256) fail('archive provenance self-hash is invalid');
  return parsed;
}

function ignoredArchivePath(path, bundleRelative) {
  return path === PROVENANCE_FILE
    || path === '.uemcp-targets.json'
    || path === '.uemcp-targets.txt'
    || path === bundleRelative
    || path === 'server/node_modules'
    || path.startsWith('server/node_modules/');
}

async function collectArchiveFiles(repoRoot, fsImpl) {
  const files = [];
  async function visit(directory) {
    const entries = await fsImpl.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(directory, entry.name);
      const rel = slash(relative(repoRoot, path));
      const stat = await fsImpl.lstat(path);
      if (stat.isSymbolicLink()) fail('archive contains a linked path', { path: rel });
      if (stat.isDirectory()) await visit(path);
      else if (stat.isFile()) files.push(rel);
      else fail('archive contains an unsupported path type', { path: rel });
    }
  }
  await visit(repoRoot);
  return files;
}

async function inspectArchive({ repoRoot, bundleManifestPath, fsImpl }) {
  if (!bundleManifestPath) fail('archive provenance requires a bundle manifest path');
  const document = await readArchiveDocument(join(repoRoot, PROVENANCE_FILE), fsImpl);
  let bundlePath;
  try {
    const requestedBundlePath = resolve(bundleManifestPath);
    const stat = await fsImpl.lstat(requestedBundlePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('bundle manifest must be a regular single-link file');
    bundlePath = resolve(await fsImpl.realpath(requestedBundlePath));
  } catch (error) {
    if (error instanceof SourceProvenanceError) throw error;
    fail('bundle manifest is missing');
  }
  const bundleRelative = slash(relative(repoRoot, bundlePath));
  if (bundleRelative.startsWith('../') || isAbsolute(bundleRelative)) fail('bundle manifest escapes the archive root');
  let bundleBytes;
  try {
    bundleBytes = await fsImpl.readFile(bundlePath);
  } catch {
    fail('bundle manifest is missing');
  }
  if (sha256Bytes(bundleBytes) !== document.bundle_manifest_sha256) fail('bundle manifest hash does not match archive provenance');

  const expectedPaths = new Set(document.payload_entries.map(entry => entry.path));
  const currentEntries = [];
  for (const entry of document.payload_entries) {
    const path = resolve(repoRoot, ...entry.path.split('/'));
    try {
      const stat = await fsImpl.lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail('archive payload path changed identity', { path: entry.path });
      const bytes = await fsImpl.readFile(path);
      currentEntries.push({ path: entry.path, size: bytes.byteLength, sha256: sha256Bytes(bytes) });
    } catch (error) {
      if (error instanceof SourceProvenanceError) throw error;
      if (error?.code !== 'ENOENT') throw error;
      currentEntries.push({ path: entry.path, size: null, sha256: null });
    }
  }
  const allFiles = await collectArchiveFiles(repoRoot, fsImpl);
  const extras = allFiles.filter(path => !expectedPaths.has(path) && !ignoredArchivePath(path, bundleRelative));
  if (extras.length > 0) fail('archive contains files outside its attributable payload', { count: extras.length });
  const currentManifest = sha256Canonical(currentEntries);
  return {
    kind: 'pinned_archive',
    repository: document.repository,
    repo_root: resolve(repoRoot),
    git_commit: document.git_commit,
    dirty: currentManifest !== document.payload_manifest_sha256,
    archive: {
      archive_sha256: document.archive_sha256,
      baseline_manifest_sha256: document.payload_manifest_sha256,
      current_manifest_sha256: currentManifest,
      provenance_sha256: document.provenance_sha256,
    },
  };
}

export async function inspectSourceProvenance({
  repoRoot,
  bundleManifestPath = null,
  runner = createProcessRunner(),
  fsImpl = defaultFs,
  gitExecutable = null,
  authenticodeInspector = inspectAuthenticode,
  environment = process.env,
} = {}) {
  if (typeof repoRoot !== 'string' || !(isAbsolute(repoRoot) || win32.isAbsolute(repoRoot) || posix.isAbsolute(repoRoot))) {
    fail('repository root must be absolute');
  }
  let canonicalRoot;
  try {
    canonicalRoot = resolve(await fsImpl.realpath(resolve(repoRoot)));
  } catch {
    fail('repository root is unavailable');
  }
  const gitMarker = await pathExists(fsImpl, join(canonicalRoot, '.git'));
  if (gitMarker) {
    if (gitMarker.isSymbolicLink() || (!gitMarker.isDirectory() && !gitMarker.isFile())) fail('Git marker has an unsafe path type');
    return inspectCheckout({
      repoRoot: canonicalRoot,
      fsImpl,
      runner,
      gitExecutable,
      authenticodeInspector,
      environment,
    });
  }
  const archiveMarker = await pathExists(fsImpl, join(canonicalRoot, PROVENANCE_FILE));
  if (archiveMarker) return inspectArchive({ repoRoot: canonicalRoot, bundleManifestPath, fsImpl });
  fail('source has neither an attributable checkout nor pinned archive provenance');
}

export const SOURCE_PROVENANCE_FILE = PROVENANCE_FILE;
