// Local execution evidence, deliberately separate from normalized deployment hashes.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DEFAULT_MANIFEST = new URL('./fixtures/test-profiles.json', import.meta.url);
export const CASE_MARKER = 'UEMCP_CASE ';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const digest = value => sha256(JSON.stringify(value));

function safeFile(root, path) {
  const absolute = resolve(root, path);
  const rel = relative(resolve(root), absolute);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error(`Unsafe input path: ${path}`);
  let current = absolute;
  while (current !== resolve(root)) {
    if (lstatSync(current).isSymbolicLink()) throw new Error(`Symlink input: ${path}`);
    current = dirname(current);
  }
  if (!lstatSync(absolute).isFile()) throw new Error(`Not a regular file: ${path}`);
  return absolute;
}

export function collectFixtureIdentity(repoRoot, paths = []) {
  if (new Set(paths).size !== paths.length) throw new Error('Duplicate fixture path');
  const files = [...paths].sort().map(path => ({ path, sha256: sha256(readFileSync(safeFile(repoRoot, path))) }));
  return { files, digest: digest(files) };
}

export function collectSourceState(repoRoot) {
  const git = (...args) => execFileSync('git', ['-C', repoRoot, ...args], { maxBuffer: 128 * 1024 * 1024 });
  const head = git('rev-parse', 'HEAD').toString().trim();
  const paths = [...new Set(git('ls-files', '-z', '--cached', '--others', '--exclude-standard').toString().split('\0').filter(Boolean))].sort();
  const files = paths.map(path => {
    try { return { path, sha256: sha256(readFileSync(safeFile(repoRoot, path))) }; }
    catch (error) { if (error.code === 'ENOENT') return { path, sha256: null }; throw error; }
  });
  const patchSha256 = sha256(git('diff', '--binary', 'HEAD', '--'));
  const dirty = git('status', '--porcelain', '--untracked-files=all').length > 0;
  const state = { schemaVersion: 1, head, dirty, patchSha256, files };
  return { ...state, digest: digest(state) };
}

export function loadTestProfile(name, { manifestPath = DEFAULT_MANIFEST } = {}) {
  const raw = readFileSync(manifestPath);
  const manifest = JSON.parse(raw);
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported test manifest version');
  const profile = manifest.profiles?.[name];
  if (!profile || !['node', 'native'].includes(profile.runner)) throw new Error(`Unknown or invalid test profile: ${name}`);
  // Capability labels describe this bounded profile; they are not proof that
  // an engine, renderer or platform was actually exercised.
  if (profile.capabilities !== undefined && (!Array.isArray(profile.capabilities) || profile.capabilities.some(value => typeof value !== 'string' || !/^[a-z][a-z0-9-]*$/.test(value)) || new Set(profile.capabilities).size !== profile.capabilities.length)) throw new Error('Invalid profile capabilities');
  if (!Array.isArray(profile.suites) || !profile.suites.length) throw new Error('Profile must require suites');
  const names = profile.suites.map(suite => suite.name);
  if (new Set(names).size !== names.length) throw new Error('Duplicate profile suite');
  for (const suite of profile.suites) {
    if (typeof suite.name !== 'string' || !suite.name || (profile.runner === 'node' && !/^test-[\w-]+\.mjs$/.test(suite.name))) throw new Error('Invalid suite name');
    if (!Array.isArray(suite.cases) || !suite.cases.length || suite.cases.some(name => typeof name !== 'string' || !name) || new Set(suite.cases).size !== suite.cases.length) throw new Error('Profile must require unique named cases');
  }
  if (!Array.isArray(profile.fixturePaths)) throw new Error('Profile fixturePaths required');
  return { ...profile, name, manifestDigest: sha256(raw) };
}

export function parseCaseEvidence(stdout) {
  return stdout.split(/\r?\n/).filter(line => line.startsWith(CASE_MARKER)).map(line => JSON.parse(line.slice(CASE_MARKER.length)));
}

export function validateExecution(evidence, profile, expectedSourceState) {
  const errors = [];
  if (evidence.schemaVersion !== 1) errors.push('Unsupported evidence version');
  if (evidence.profile !== profile.name || evidence.manifestDigest !== profile.manifestDigest) errors.push('Wrong profile or manifest digest');
  const source = evidence.sourceState;
  if (!source?.head || !Array.isArray(source.files) || !source.patchSha256 || source.digest !== digest(Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'digest')))) errors.push('Invalid source identity');
  if (expectedSourceState && source?.digest !== expectedSourceState.digest) errors.push('Wrong source state');
  const fixture = evidence.fixtureIdentity;
  if (!Array.isArray(fixture?.files) || fixture.files.some(file => !file || typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) || fixture.digest !== digest(fixture.files) || JSON.stringify(fixture.files.map(file => file.path).sort()) !== JSON.stringify([...profile.fixturePaths].sort())) errors.push('Wrong fixture identity');
  // A self-consistent fixture envelope must still describe the exact bytes in
  // the source inventory bound above, not a separately substituted corpus.
  for (const file of Array.isArray(fixture?.files) ? fixture.files : []) {
    const matches = Array.isArray(source?.files) ? source.files.filter(input => input?.path === file?.path) : [];
    if (matches.length !== 1 || matches[0].sha256 !== file?.sha256) errors.push(`Fixture does not match source identity: ${file?.path}`);
  }
  const suites = Array.isArray(evidence.suites) ? evidence.suites : [];
  const expected = new Set(profile.suites.map(suite => suite.name));
  for (const suite of suites) if (!expected.has(suite?.name)) errors.push(`Unexpected suite: ${suite?.name}`);
  for (const required of profile.suites) {
    const matches = suites.filter(suite => suite?.name === required.name);
    if (matches.length !== 1) { errors.push(`Missing or duplicate suite: ${required.name}`); continue; }
    const suite = matches[0];
    if (suite.state !== 'passed') errors.push(`Unsuccessful suite: ${required.name}`);
    const cases = Array.isArray(suite.cases) ? suite.cases : [];
    if (cases.length !== required.cases.length) errors.push(`Wrong case count: ${required.name}`);
    for (const name of required.cases) {
      const found = cases.filter(item => item?.name === name);
      if (found.length !== 1 || found[0].state !== 'passed') errors.push(`Missing, duplicate or unsuccessful case: ${required.name}/${name}`);
    }
  }
  return errors;
}

export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
