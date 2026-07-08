// Rotation source contract tests.
// Run from server/: node test-rotation-source.mjs

import { readFile } from 'node:fs/promises';

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

process.exit(runner.summary());
