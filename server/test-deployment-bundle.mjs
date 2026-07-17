// Deterministic standalone deployment bundle tests.
//
// Run: cd server && node test-deployment-bundle.mjs

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { buildDeploymentCli } from './build-deployment-cli.mjs';
import { canonicalJson, sha256Bytes, sha256Canonical } from './deployment/canonical-json.mjs';
import { verifyDeploymentBundleFreshness } from './deployment/bundle-freshness.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Deployment Bundle Tests');
const serverRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = dirname(serverRoot);
const trackedRoot = join(repoRoot, 'dist');
const artifactNames = ['deploy-uemcp.mjs', 'deploy-uemcp.manifest.json', 'THIRD_PARTY_NOTICES.txt'];
const scratchRoot = mkdtempSync(join(repoRoot, '.deployment-bundle-scratch-'));
const launchRoot = mkdtempSync(join(tmpdir(), 'uemcp-bundle-launch-'));

function bytes(path) {
  return readFileSync(path);
}

function runNode(entry, args) {
  return spawnSync(process.execPath, [entry, ...args], {
    cwd: launchRoot,
    env: { ...process.env, NODE_PATH: '' },
    encoding: 'utf8',
    windowsHide: true,
  });
}

async function runInjectedPlan(runCli, plan) {
  let stdout = '';
  let stderr = '';
  const status = await runCli(['plan', '--operation', 'setup', '--json'], {
    orchestrator: { async plan() { return structuredClone(plan); } },
    stdout: { write(value) { stdout += value; } },
    stderr: { write(value) { stderr += value; } },
  });
  return { status, stdout, stderr };
}

async function rejectsCode(callback, code) {
  try {
    await callback();
    return false;
  } catch (error) {
    return error?.code === code;
  }
}

try {
  const firstRoot = join(scratchRoot, 'first');
  const secondRoot = join(scratchRoot, 'second');
  await buildDeploymentCli({ repoRoot, outputDirectory: firstRoot });
  await buildDeploymentCli({ repoRoot, outputDirectory: secondRoot });

  for (const name of artifactNames) {
    t.assert(bytes(join(firstRoot, name)).equals(bytes(join(secondRoot, name))), `${name} is byte-identical across clean rebuilds`);
    t.assert(bytes(join(firstRoot, name)).equals(bytes(join(trackedRoot, name))), `${name} matches the tracked release artifact`);
  }

  const bundlePath = join(firstRoot, 'deploy-uemcp.mjs');
  const manifest = JSON.parse(readFileSync(join(firstRoot, 'deploy-uemcp.manifest.json'), 'utf8'));
  const expectedManifestKeys = [
    'bundle_sha256',
    'bundled_packages',
    'entry',
    'esbuild_version',
    'input_manifest_sha256',
    'node_minimum',
    'notices_sha256',
    'package_lock_sha256',
    'schema_version',
    'source_inputs',
  ].sort();
  t.assert(JSON.stringify(Object.keys(manifest).sort()) === JSON.stringify(expectedManifestKeys), 'bundle manifest has the exact public schema');
  t.assert(manifest.schema_version === '1.0' && manifest.node_minimum === '22.0.0' && manifest.esbuild_version === '0.28.1', 'bundle manifest locks schema, Node floor, and builder version');
  t.assert(manifest.bundle_sha256 === sha256Bytes(bytes(bundlePath)), 'bundle hash recomputes from exact tracked bytes');
  t.assert(manifest.notices_sha256 === sha256Bytes(bytes(join(firstRoot, 'THIRD_PARTY_NOTICES.txt'))), 'notices hash recomputes from exact tracked bytes');
  t.assert(manifest.package_lock_sha256 === sha256Bytes(bytes(join(serverRoot, 'package-lock.json'))), 'package-lock hash recomputes from exact bytes');
  t.assert(manifest.source_inputs.length > 0 && manifest.source_inputs.every(row => !isAbsolute(row.path) && row.path.includes('/')), 'source input paths are non-empty, relative, and slash normalized');
  t.assert(manifest.source_inputs.every(row => row.sha256 === sha256Bytes(bytes(join(repoRoot, row.path)))), 'every first-party source hash recomputes');
  t.assert(manifest.bundled_packages.length > 0 && manifest.bundled_packages.every(row => row.name && row.version && row.license), 'every bundled package has a name, version, and license');
  t.assert(manifest.input_manifest_sha256 === sha256Canonical({
    source_inputs: manifest.source_inputs,
    package_lock_sha256: manifest.package_lock_sha256,
    bundled_packages: manifest.bundled_packages,
    notices_sha256: manifest.notices_sha256,
  }), 'aggregate input-manifest hash recomputes canonically');
  const freshness = await verifyDeploymentBundleFreshness({ repoRoot, activeEntryPath: bundlePath, manifestPath: join(firstRoot, 'deploy-uemcp.manifest.json') });
  t.assert(freshness.bundle_sha256 === manifest.bundle_sha256 && freshness.source_input_count === manifest.source_inputs.length, 'runtime freshness verifies bundle, lock, and every first-party input');

  const changedNoticesRoot = join(scratchRoot, 'changed-notices');
  mkdirSync(changedNoticesRoot, { recursive: true });
  for (const name of artifactNames) copyFileSync(join(firstRoot, name), join(changedNoticesRoot, name));
  appendFileSync(join(changedNoticesRoot, 'THIRD_PARTY_NOTICES.txt'), '\nstale notice text\n', 'utf8');
  t.assert(await rejectsCode(() => verifyDeploymentBundleFreshness({
    repoRoot,
    activeEntryPath: join(changedNoticesRoot, 'deploy-uemcp.mjs'),
    manifestPath: join(changedNoticesRoot, 'deploy-uemcp.manifest.json'),
  }), 'BUNDLE_FRESHNESS_FAILED'), 'runtime freshness rejects changed notices bytes');

  const changedBundle = join(scratchRoot, 'changed-deploy-uemcp.mjs');
  copyFileSync(bundlePath, changedBundle);
  appendFileSync(changedBundle, '\n// changed\n', 'utf8');
  t.assert(await rejectsCode(() => verifyDeploymentBundleFreshness({ repoRoot, activeEntryPath: changedBundle, manifestPath: join(firstRoot, 'deploy-uemcp.manifest.json') }), 'BUNDLE_FRESHNESS_FAILED'), 'runtime freshness rejects changed bundle bytes');
  const changedManifestPath = join(scratchRoot, 'changed-manifest.json');
  const changedLockManifest = { ...manifest, package_lock_sha256: '0'.repeat(64) };
  changedLockManifest.input_manifest_sha256 = sha256Canonical({
    source_inputs: changedLockManifest.source_inputs,
    package_lock_sha256: changedLockManifest.package_lock_sha256,
    bundled_packages: changedLockManifest.bundled_packages,
    notices_sha256: changedLockManifest.notices_sha256,
  });
  writeFileSync(changedManifestPath, `${canonicalJson(changedLockManifest)}\n`, 'utf8');
  t.assert(await rejectsCode(() => verifyDeploymentBundleFreshness({ repoRoot, activeEntryPath: bundlePath, manifestPath: changedManifestPath }), 'BUNDLE_FRESHNESS_FAILED'), 'runtime freshness rejects a self-consistent false package-lock hash');
  const changedSourceManifestPath = join(scratchRoot, 'changed-source-manifest.json');
  const changedSourceManifest = structuredClone(manifest);
  changedSourceManifest.source_inputs[0].sha256 = '0'.repeat(64);
  changedSourceManifest.input_manifest_sha256 = sha256Canonical({
    source_inputs: changedSourceManifest.source_inputs,
    package_lock_sha256: changedSourceManifest.package_lock_sha256,
    bundled_packages: changedSourceManifest.bundled_packages,
    notices_sha256: changedSourceManifest.notices_sha256,
  });
  writeFileSync(changedSourceManifestPath, `${canonicalJson(changedSourceManifest)}\n`, 'utf8');
  t.assert(await rejectsCode(() => verifyDeploymentBundleFreshness({ repoRoot, activeEntryPath: bundlePath, manifestPath: changedSourceManifestPath }), 'BUNDLE_FRESHNESS_FAILED'), 'runtime freshness rejects a self-consistent false source-input hash');

  const bundleText = readFileSync(bundlePath, 'utf8');
  const absoluteForms = [resolve(repoRoot), resolve(repoRoot).replace(/\\/g, '/')];
  t.assert(absoluteForms.every(value => !bundleText.includes(value)), 'bundle contains no absolute repository source path');
  t.assert(!bundleText.includes('sourceMappingURL='), 'bundle contains no source map reference');
  const importSpecifiers = [...bundleText.matchAll(/^import .*? from (["'])([^"']+)\1;$/gm)].map(match => match[2]);
  importSpecifiers.push(...[...bundleText.matchAll(/__require\w*\((["'])([^"']+)\1\)/g)].map(match => match[2]));
  t.assert(importSpecifiers.every(specifier => specifier.startsWith('node:')), 'bundle externalizes no non-node module');
  const serverMarker = 'UEMCP stdio entrypoint.';
  t.assert(!bundleText.includes(serverMarker) && bundleText.includes('server.mjs'), 'bundle references but does not embed the MCP server entry');

  mkdirSync(join(launchRoot, 'empty'), { recursive: true });
  const sourceEntry = join(serverRoot, 'deploy-uemcp.mjs');
  const sourceHelp = runNode(sourceEntry, ['--help']);
  const bundleHelp = runNode(bundlePath, ['--help']);
  t.assert(sourceHelp.status === 0 && bundleHelp.status === 0 && bundleHelp.stdout === sourceHelp.stdout, 'standalone bundle help matches the source CLI without cwd dependencies');
  t.assert(bundleHelp.stderr === '', 'standalone help writes no diagnostics');

  const sourceUsage = runNode(sourceEntry, ['apply', '--json']);
  const bundleUsage = runNode(bundlePath, ['apply', '--json']);
  t.assert(sourceUsage.status === 64 && bundleUsage.status === 64 && bundleUsage.stdout === '', 'standalone bundle preserves usage exit 64 and JSON stdout purity');

  const deterministicPlan = {
    schema_version: '1.0',
    kind: 'uemcp.deployment.plan',
    operation: 'setup',
    outcome: 'ACTION_REQUIRED',
    descriptor: { name: 'uemcp', transport: 'stdio', command: 'C:\\Program Files\\nodejs\\node.exe', args: ['C:\\UEMCP\\server\\server.mjs'], env: {}, cwd: null },
    stages: [
      { name: 'prerequisites', status: 'READY' },
      { name: 'clients', status: 'MANUAL_REGISTRATION_REQUIRED' },
    ],
  };
  const {
    parseDeploymentCliArgs: parseSourceArgs,
    runCli: runSourceCli,
  } = await import(pathToFileURL(sourceEntry).href);
  const {
    parseDeploymentCliArgs: parseBundleArgs,
    runCli: runBundleCli,
  } = await import(pathToFileURL(bundlePath).href);
  const sourcePlanRun = await runInjectedPlan(runSourceCli, deterministicPlan);
  const bundlePlanRun = await runInjectedPlan(runBundleCli, deterministicPlan);
  const sourcePlan = JSON.parse(sourcePlanRun.stdout);
  const bundlePlan = JSON.parse(bundlePlanRun.stdout);
  t.assert(sourcePlanRun.status === 10 && bundlePlanRun.status === 10 && sourcePlanRun.stderr === '' && bundlePlanRun.stderr === '', 'source and bundle preserve the actionable plan exit without host prerequisites');
  t.assert(bundlePlan.schema_version === sourcePlan.schema_version && bundlePlan.kind === sourcePlan.kind && bundlePlan.operation === sourcePlan.operation && bundlePlan.outcome === sourcePlan.outcome, 'source and bundle agree on plan schema and outcome');
  t.assert(JSON.stringify(bundlePlan.descriptor) === JSON.stringify(sourcePlan.descriptor), 'source and bundle preserve the same injected canonical descriptor');
  t.assert(JSON.stringify(bundlePlan.stages.map(row => [row.name, row.status])) === JSON.stringify(sourcePlan.stages.map(row => [row.name, row.status])), 'source and bundle preserve the same injected no-write stages');

  for (const [label, parseArgs] of [['source', parseSourceArgs], ['bundle', parseBundleArgs]]) {
    const selected = parseArgs([
      'plan', '--operation', 'setup',
      '--include-client', 'claude',
      '--include-client', 'codex',
      '--exclude-client', 'gemini',
      '--vscode-profile', 'Work Profile',
      '--replace-owned-client-fields',
      '--shadow-gemini-extension',
      '--migrate-legacy-claude-project',
      '--output-plan', 'C:\\isolated\\reviewed-plan.json',
    ]);
    t.assert(JSON.stringify(selected.includeClients) === JSON.stringify(['claude', 'codex'])
      && JSON.stringify(selected.excludeClients) === JSON.stringify(['gemini'])
      && selected.vscodeProfile === 'Work Profile'
      && selected.replaceOwnedClientFields === true
      && selected.shadowGeminiExtension === true
      && selected.migrateLegacyClaudeProject === true
      && selected.outputPlan === 'C:\\isolated\\reviewed-plan.json', `${label} CLI preserves client selection, repair decisions, and plan output authority`);
    t.assert(await rejectsCode(() => parseArgs(['verify', '--include-client', 'unknown-client']), 'CLI_USAGE'), `${label} CLI rejects an unknown include client`);
    t.assert(await rejectsCode(() => parseArgs(['doctor', '--include-client', 'claude', '--exclude-client', 'claude']), 'CLI_USAGE'), `${label} CLI rejects include/exclude overlap`);
    t.assert(await rejectsCode(() => parseArgs(['apply', '--plan-file', 'C:\\isolated\\plan.json', '--approve-digest', 'a'.repeat(64), '--non-interactive', '--include-client', 'claude']), 'CLI_USAGE'), `${label} apply rejects selection overrides`);
    t.assert(await rejectsCode(() => parseArgs(['apply', '--plan-file', 'C:\\isolated\\plan.json', '--approve-digest', 'a'.repeat(64), '--non-interactive', '--vscode-profile', 'Work']), 'CLI_USAGE'), `${label} apply rejects profile overrides`);
    t.assert(await rejectsCode(() => parseArgs(['apply', '--plan-file', 'C:\\isolated\\plan.json', '--approve-digest', 'a'.repeat(64), '--non-interactive', '--replace-owned-client-fields']), 'CLI_USAGE'), `${label} apply rejects repair-decision overrides`);
    t.assert(await rejectsCode(() => parseArgs(['doctor', '--shadow-gemini-extension']), 'CLI_USAGE'), `${label} standalone inspection rejects repair decisions`);
    t.assert(await rejectsCode(() => parseArgs(['verify', '--output-plan', 'C:\\isolated\\reviewed-plan.json']), 'CLI_USAGE'), `${label} standalone inspection rejects plan output authority`);
  }

  let forwardedRequest = null;
  let cliStdout = '';
  let cliStderr = '';
  const verifyExit = await runSourceCli([
    'verify', '--include-client', 'claude', '--exclude-client', 'gemini', '--vscode-profile', 'Work', '--json',
  ], {
    orchestrator: {
      async verify(request) {
        forwardedRequest = structuredClone(request);
        return { operation: 'verify', outcome: 'HEALTHY', actions: [] };
      },
    },
    stdout: { write(value) { cliStdout += value; } },
    stderr: { write(value) { cliStderr += value; } },
  });
  t.assert(verifyExit === 0 && cliStderr === '' && cliStdout !== '', 'CLI dispatch accepts client selection on standalone inspection');
  t.assert(JSON.stringify(forwardedRequest.client_selection) === JSON.stringify({
    include: ['claude'],
    exclude: ['gemini'],
    vscode_profile: 'Work',
  }) && JSON.stringify(forwardedRequest.selected_clients) === JSON.stringify(['claude']), 'CLI forwards selection as public request evidence and private orchestration input');

  const trackable = artifactNames.every(name => spawnSync('git', ['check-ignore', '-q', `dist/${name}`], { cwd: repoRoot, windowsHide: true }).status === 1);
  const ignoredScratch = spawnSync('git', ['check-ignore', '-q', 'dist/scratch.txt'], { cwd: repoRoot, windowsHide: true }).status === 0;
  t.assert(trackable, 'the three release artifacts are explicitly trackable');
  t.assert(ignoredScratch, 'arbitrary dist output remains ignored');
  const checkoutStablePaths = [
    ...manifest.source_inputs.map(row => row.path),
    'server/package.json',
    'server/package-lock.json',
    ...artifactNames.map(name => `dist/${name}`),
  ];
  const checkoutStableLineEndings = checkoutStablePaths.every(path => {
    const attribute = spawnSync('git', ['check-attr', 'eol', '--', path], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
    return attribute.status === 0 && /: eol: (?:lf|crlf)$/.test(attribute.stdout.trim());
  });
  t.assert(checkoutStableLineEndings, 'every hashed source and release artifact has an explicit checkout-stable line ending');
} finally {
  rmSync(scratchRoot, { recursive: true, force: true });
  rmSync(launchRoot, { recursive: true, force: true });
}

const failed = t.summary();
process.exit(failed ? 1 : 0);
