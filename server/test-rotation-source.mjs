// Rotation source contract tests.
// Run from server/: node test-rotation-source.mjs

import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';

import { TestRunner } from './test-helpers.mjs';

const runner = new TestRunner('Rotation Source Contract Tests');

const rotationSource = await readFile('run-rotation.mjs', 'utf-8');
const toolSurfaceHelperSource = await readFile('test-tool-surface-helpers.mjs', 'utf-8');
const excludedBlock = rotationSource.match(/const EXCLUDED = new Set\(\[([\s\S]*?)\]\);/)?.[1] || '';

runner.assert(
  excludedBlock.includes("'test-tool-surface-helpers.mjs'"),
  'rotation excludes tool-surface helper library from test-file discovery',
);

runner.assert(
  !/new TestRunner\('Tool Surface Helpers'\)/.test(toolSurfaceHelperSource),
  'tool-surface helper remains a library and does not emit a 0/0 direct-run summary',
);

runner.assert(
  rotationSource.includes("from './rotation-failure-details.mjs'")
    && rotationSource.includes('extractAssertionFailureDetails(stdout, stderr)')
    && rotationSource.includes('for (const detail of r.failureDetails)'),
  'rotation reports bounded assertion details through the shared extractor',
);

const skipEnvironment = { ...process.env };
delete skipEnvironment.UEMCP_INSTALLED_CLIENT_CONTRACT;
delete skipEnvironment.UEMCP_INSTALLED_CLIENT_CONTRACT_WORKER;
delete skipEnvironment.UEMCP_INSTALLED_CLIENT_ROOT;
const installedSkip = spawnSync(process.execPath, ['test-installed-client-contracts.mjs'], {
  cwd: process.cwd(),
  env: skipEnvironment,
  encoding: 'utf8',
  timeout: 10_000,
});
runner.assert(
  installedSkip.status === 0
    && /⊘\s+skipped:/.test(installedSkip.stdout)
    && !/^\s*Passed:/m.test(installedSkip.stdout),
  'installed-client contracts declare a rotation-recognized skip without contributing assertions',
);

process.exit(runner.summary());
