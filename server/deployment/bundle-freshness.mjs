import * as defaultFs from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { sha256Canonical } from './canonical-json.mjs';
import { fingerprintPath } from './fingerprints.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const MANIFEST_KEYS = new Set([
  'schema_version',
  'entry',
  'node_minimum',
  'esbuild_version',
  'source_inputs',
  'package_lock_sha256',
  'bundled_packages',
  'input_manifest_sha256',
  'bundle_sha256',
]);

export class BundleFreshnessError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BundleFreshnessError';
    this.code = 'BUNDLE_FRESHNESS_FAILED';
    this.details = details;
  }
}

function fail(message, details) {
  throw new BundleFreshnessError(message, details);
}

function plainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!plainObject(value)) fail(`${label} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) fail(`${label} has an unexpected schema`);
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validateRelativeSourcePath(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || isAbsolute(value)) return false;
  const segments = value.split('/');
  return segments.every(segment => segment !== '' && segment !== '.' && segment !== '..');
}

function validateManifest(value) {
  exactKeys(value, MANIFEST_KEYS, 'bundle manifest');
  if (value.schema_version !== '1.0' || value.entry !== 'dist/deploy-uemcp.mjs') fail('bundle manifest interface is unsupported');
  if (value.node_minimum !== '22.0.0' || value.esbuild_version !== '0.28.1') fail('bundle manifest toolchain identity is unsupported');
  for (const key of ['package_lock_sha256', 'input_manifest_sha256', 'bundle_sha256']) {
    if (!SHA256.test(value[key] ?? '')) fail(`bundle manifest ${key} is invalid`);
  }
  if (!Array.isArray(value.source_inputs) || value.source_inputs.length === 0) fail('bundle manifest source inputs are empty');
  const sourcePaths = [];
  for (const row of value.source_inputs) {
    exactKeys(row, new Set(['path', 'sha256']), 'bundle source input');
    if (!validateRelativeSourcePath(row.path) || !SHA256.test(row.sha256 ?? '')) fail('bundle source input is invalid');
    sourcePaths.push(row.path);
  }
  if (new Set(sourcePaths).size !== sourcePaths.length || JSON.stringify(sourcePaths) !== JSON.stringify([...sourcePaths].sort(ordinalCompare))) {
    fail('bundle source inputs are duplicated or unsorted');
  }
  if (!Array.isArray(value.bundled_packages) || value.bundled_packages.length === 0) fail('bundle package identities are empty');
  const packageKeys = [];
  for (const row of value.bundled_packages) {
    exactKeys(row, new Set(['name', 'version', 'license']), 'bundled package');
    if (![row.name, row.version, row.license].every(field => typeof field === 'string' && field !== '')) fail('bundled package identity is invalid');
    packageKeys.push(`${row.name}\0${row.version}`);
  }
  if (new Set(packageKeys).size !== packageKeys.length || JSON.stringify(packageKeys) !== JSON.stringify([...packageKeys].sort(ordinalCompare))) {
    fail('bundled package identities are duplicated or unsorted');
  }
  const aggregate = sha256Canonical({
    source_inputs: value.source_inputs,
    package_lock_sha256: value.package_lock_sha256,
    bundled_packages: value.bundled_packages,
  });
  if (aggregate !== value.input_manifest_sha256) fail('bundle aggregate input hash changed');
  return value;
}

function contained(root, path) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function exactFile(path, { repoRoot, fsImpl, label, maximumBytes = null }) {
  if (!contained(repoRoot, path)) fail(`${label} escaped the repository root`);
  const fingerprint = await fingerprintPath(path, { allowedRoots: [repoRoot], fsImpl });
  if (!fingerprint.exists || fingerprint.kind !== 'file' || fingerprint.link_kind !== 'none' || fingerprint.link_count !== 1) {
    fail(`${label} is missing or not a regular single-link file`);
  }
  if (maximumBytes !== null && fingerprint.size > maximumBytes) fail(`${label} exceeds its size limit`);
  return fingerprint;
}

export async function verifyDeploymentBundleFreshness({
  repoRoot,
  activeEntryPath,
  manifestPath = null,
  fsImpl = defaultFs,
} = {}) {
  if (!isAbsolute(repoRoot ?? '') || !isAbsolute(activeEntryPath ?? '')) fail('bundle freshness requires absolute repository and entry paths');
  const canonicalRepo = resolve(repoRoot);
  const canonicalManifest = resolve(manifestPath ?? join(canonicalRepo, 'dist', 'deploy-uemcp.manifest.json'));
  await exactFile(canonicalManifest, { repoRoot: canonicalRepo, fsImpl, label: 'bundle manifest', maximumBytes: 1024 * 1024 });
  let manifest;
  try {
    manifest = validateManifest(JSON.parse(await fsImpl.readFile(canonicalManifest, 'utf8')));
  } catch (error) {
    if (error instanceof BundleFreshnessError) throw error;
    fail('bundle manifest is not valid JSON');
  }

  const sourceEntry = resolve(canonicalRepo, 'server', 'deploy-uemcp.mjs');
  const candidateEntry = resolve(activeEntryPath) === sourceEntry
    ? resolve(canonicalRepo, ...manifest.entry.split('/'))
    : resolve(activeEntryPath);
  const bundle = await exactFile(candidateEntry, { repoRoot: canonicalRepo, fsImpl, label: 'deployment bundle' });
  if (bundle.sha256 !== manifest.bundle_sha256) fail('deployment bundle hash changed');

  const lock = await exactFile(join(canonicalRepo, 'server', 'package-lock.json'), { repoRoot: canonicalRepo, fsImpl, label: 'package lock' });
  if (lock.sha256 !== manifest.package_lock_sha256) fail('package lock hash changed');
  for (const row of manifest.source_inputs) {
    const sourcePath = resolve(canonicalRepo, ...row.path.split('/'));
    const source = await exactFile(sourcePath, { repoRoot: canonicalRepo, fsImpl, label: `source input ${row.path}` });
    if (source.sha256 !== row.sha256) fail('first-party bundle input changed', { path: row.path });
  }
  await exactFile(join(dirname(canonicalManifest), 'THIRD_PARTY_NOTICES.txt'), {
    repoRoot: canonicalRepo,
    fsImpl,
    label: 'third-party notices',
    maximumBytes: 4 * 1024 * 1024,
  });

  return Object.freeze({
    schema_version: manifest.schema_version,
    bundle_sha256: manifest.bundle_sha256,
    input_manifest_sha256: manifest.input_manifest_sha256,
    source_input_count: manifest.source_inputs.length,
    bundled_package_count: manifest.bundled_packages.length,
  });
}
