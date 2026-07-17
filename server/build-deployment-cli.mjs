#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import * as fsPromises from 'node:fs/promises';
import { builtinModules } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { build, version as esbuildVersion } from 'esbuild';

import { canonicalJson, sha256Bytes, sha256Canonical } from './deployment/canonical-json.mjs';

const ARTIFACT_NAMES = Object.freeze([
  'deploy-uemcp.mjs',
  'deploy-uemcp.manifest.json',
  'THIRD_PARTY_NOTICES.txt',
]);
const ALLOWED_LICENSES = new Set([
  '0BSD',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  'MIT',
  'Python-2.0',
]);
const BARE_BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, '')));

export class DeploymentBuildError extends Error {
  constructor(message, code = 'DEPLOYMENT_BUILD_FAILED', details = {}) {
    super(message);
    this.name = 'DeploymentBuildError';
    this.code = code;
    this.details = details;
  }
}

function slashPath(value) {
  return value.split(sep).join('/');
}

function ordinalCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function repositoryPath(repoRoot, inputPath) {
  const absolute = resolve(repoRoot, inputPath);
  const rel = relative(repoRoot, absolute);
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new DeploymentBuildError('esbuild input escaped the repository root', 'UNSAFE_BUILD_INPUT', { input: inputPath });
  }
  return { absolute, relative: slashPath(rel) };
}

function packageLocation(repoRoot, inputPath) {
  const normalized = slashPath(inputPath);
  const marker = '/node_modules/';
  const markerIndex = normalized.lastIndexOf(marker);
  if (markerIndex < 0) return null;
  const remainder = normalized.slice(markerIndex + marker.length);
  const segments = remainder.split('/');
  const packageSegments = segments[0].startsWith('@') ? segments.slice(0, 2) : segments.slice(0, 1);
  if (packageSegments.length === 0 || packageSegments.some(segment => !segment)) {
    throw new DeploymentBuildError('esbuild reported an invalid package input', 'INVALID_PACKAGE_INPUT', { input: inputPath });
  }
  const packageRelative = `${normalized.slice(0, markerIndex + marker.length)}${packageSegments.join('/')}`;
  return resolve(repoRoot, ...packageRelative.split('/'));
}

async function readPackageIdentity(packageRoot) {
  let metadata;
  try {
    metadata = JSON.parse(await fsPromises.readFile(join(packageRoot, 'package.json'), 'utf8'));
  } catch {
    throw new DeploymentBuildError('bundled package metadata is unavailable', 'PACKAGE_METADATA_UNAVAILABLE');
  }
  if (typeof metadata.name !== 'string' || !metadata.name || typeof metadata.version !== 'string' || !metadata.version) {
    throw new DeploymentBuildError('bundled package identity is incomplete', 'PACKAGE_METADATA_INVALID');
  }
  if (typeof metadata.license !== 'string' || !ALLOWED_LICENSES.has(metadata.license)) {
    throw new DeploymentBuildError('bundled package license is missing or not allowlisted', 'PACKAGE_LICENSE_BLOCKED', {
      package: metadata.name,
      license: metadata.license ?? null,
    });
  }
  const entries = await fsPromises.readdir(packageRoot, { withFileTypes: true });
  const licenseNames = entries
    .filter(entry => entry.isFile() && /^(?:licen[cs]e|copying)(?:\..+)?$/i.test(entry.name))
    .map(entry => entry.name)
    .sort(ordinalCompare);
  if (licenseNames.length === 0) {
    throw new DeploymentBuildError('bundled package license text is unavailable', 'PACKAGE_LICENSE_TEXT_UNAVAILABLE', { package: metadata.name });
  }
  const licenseText = (await fsPromises.readFile(join(packageRoot, licenseNames[0]), 'utf8'))
    .replace(/\r\n?/g, '\n')
    .trim();
  if (!licenseText) throw new DeploymentBuildError('bundled package license text is empty', 'PACKAGE_LICENSE_TEXT_UNAVAILABLE', { package: metadata.name });
  return {
    identity: { name: metadata.name, version: metadata.version, license: metadata.license },
    licenseText,
  };
}

function noticeBytes(packages) {
  const sections = [
    'UEMCP Deployment CLI Third-Party Notices',
    '',
    'This file lists licenses for third-party packages included in the standalone deployment bundle.',
  ];
  for (const row of packages) {
    sections.push(
      '',
      '='.repeat(79),
      `${row.identity.name} ${row.identity.version}`,
      `License: ${row.identity.license}`,
      '-'.repeat(79),
      row.licenseText,
    );
  }
  return Buffer.from(`${sections.join('\n')}\n`, 'utf8');
}

async function writeArtifactsAtomically(outputDirectory, artifacts) {
  await fsPromises.mkdir(outputDirectory, { recursive: true });
  const pending = [];
  try {
    for (const [name, content] of artifacts) {
      const scratchPath = join(outputDirectory, `.${name}.scratch-${process.pid}-${randomUUID()}`);
      await fsPromises.writeFile(scratchPath, content, { flag: 'wx' });
      pending.push({ scratchPath, finalPath: join(outputDirectory, name) });
    }
    for (const row of pending) await fsPromises.rename(row.scratchPath, row.finalPath);
  } finally {
    await Promise.all(pending.map(row => fsPromises.rm(row.scratchPath, { force: true }).catch(() => {})));
  }
}

export async function buildDeploymentCli({
  repoRoot = dirname(dirname(fileURLToPath(import.meta.url))),
  outputDirectory = null,
} = {}) {
  const canonicalRepoRoot = resolve(repoRoot);
  const canonicalOutput = resolve(outputDirectory ?? join(canonicalRepoRoot, 'dist'));
  const entry = join(canonicalRepoRoot, 'server', 'deploy-uemcp.mjs');
  const normalizeBuiltins = {
    name: 'normalize-node-builtins',
    setup(buildContext) {
      buildContext.onResolve({ filter: /^[A-Za-z][A-Za-z0-9_./-]*$/ }, args => {
        const bare = args.path.replace(/^node:/, '');
        return BARE_BUILTINS.has(bare) ? { path: `node:${bare}`, external: true } : null;
      });
    },
  };
  const buildResult = await build({
    absWorkingDir: canonicalRepoRoot,
    entryPoints: [entry],
    outfile: join(canonicalOutput, 'deploy-uemcp.mjs'),
    bundle: true,
    platform: 'node',
    format: 'esm',
    mainFields: ['module', 'main'],
    target: ['node22'],
    packages: 'bundle',
    external: ['node:*'],
    plugins: [normalizeBuiltins],
    banner: { js: 'import { createRequire as __uemcpCreateRequire } from "node:module"; const require = __uemcpCreateRequire(import.meta.url);' },
    charset: 'utf8',
    legalComments: 'none',
    sourcemap: false,
    metafile: true,
    write: false,
    logLevel: 'silent',
  });
  if (esbuildVersion !== '0.28.1') {
    throw new DeploymentBuildError('unexpected esbuild version', 'BUILDER_VERSION_MISMATCH', { version: esbuildVersion });
  }
  if (buildResult.outputFiles.length !== 1) throw new DeploymentBuildError('esbuild emitted an unexpected output set');
  const outputMetadata = Object.values(buildResult.metafile.outputs);
  if (outputMetadata.length !== 1) throw new DeploymentBuildError('esbuild metafile has an unexpected output set');
  const includedInputs = Object.entries(outputMetadata[0].inputs)
    .filter(([, value]) => value.bytesInOutput > 0)
    .map(([path]) => path)
    .sort(ordinalCompare);

  const sourceInputs = [];
  const packageRoots = new Set();
  for (const inputPath of includedInputs) {
    const packageRoot = packageLocation(canonicalRepoRoot, inputPath);
    if (packageRoot) {
      packageRoots.add(packageRoot);
      continue;
    }
    const path = repositoryPath(canonicalRepoRoot, inputPath);
    sourceInputs.push({ path: path.relative, sha256: sha256Bytes(await fsPromises.readFile(path.absolute)) });
  }
  sourceInputs.sort((left, right) => ordinalCompare(left.path, right.path));

  const packageRows = [];
  for (const packageRoot of [...packageRoots].sort(ordinalCompare)) {
    packageRows.push(await readPackageIdentity(packageRoot));
  }
  packageRows.sort((left, right) => ordinalCompare(left.identity.name, right.identity.name)
    || ordinalCompare(left.identity.version, right.identity.version));
  const bundledPackages = packageRows.map(row => row.identity);
  const packageLockSha256 = sha256Bytes(await fsPromises.readFile(join(canonicalRepoRoot, 'server', 'package-lock.json')));
  const bundle = Buffer.from(buildResult.outputFiles[0].text.replace(/\r\n?/g, '\n'), 'utf8');
  const manifest = {
    schema_version: '1.0',
    entry: 'dist/deploy-uemcp.mjs',
    node_minimum: '22.0.0',
    esbuild_version: esbuildVersion,
    source_inputs: sourceInputs,
    package_lock_sha256: packageLockSha256,
    bundled_packages: bundledPackages,
    input_manifest_sha256: sha256Canonical({
      source_inputs: sourceInputs,
      package_lock_sha256: packageLockSha256,
      bundled_packages: bundledPackages,
    }),
    bundle_sha256: sha256Bytes(bundle),
  };
  const artifacts = new Map([
    ['deploy-uemcp.mjs', bundle],
    ['deploy-uemcp.manifest.json', Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8')],
    ['THIRD_PARTY_NOTICES.txt', noticeBytes(packageRows)],
  ]);
  await writeArtifactsAtomically(canonicalOutput, artifacts);
  return Object.freeze({
    outputDirectory: canonicalOutput,
    artifacts: Object.freeze(ARTIFACT_NAMES.map(name => join(canonicalOutput, name))),
    manifest: Object.freeze(manifest),
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  const result = await buildDeploymentCli();
  process.stdout.write(`Built ${result.artifacts.length} deployment artifacts.\n`);
}
