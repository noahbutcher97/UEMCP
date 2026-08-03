// Rotation timeout policy tests.
// Run from server/: node test-rotation-timeouts.mjs

import {
  DEFAULT_ROTATION_FILE_TIMEOUT_MS,
  ROTATION_FILE_TIMEOUT_OVERRIDES_MS,
  rotationFileTimeoutMs,
} from './rotation-timeouts.mjs';
import { TestRunner } from './test-helpers.mjs';

const runner = new TestRunner('Rotation Timeout Policy Tests');
const extendedFiles = [
  'test-client-transaction.mjs',
  'test-deployment-contracts.mjs',
];

runner.assert(
  DEFAULT_ROTATION_FILE_TIMEOUT_MS === 5 * 60 * 1000,
  'ordinary rotation files retain the five-minute fail-loud budget',
);

runner.assert(
  Object.isFrozen(ROTATION_FILE_TIMEOUT_OVERRIDES_MS)
    && JSON.stringify(Object.keys(ROTATION_FILE_TIMEOUT_OVERRIDES_MS).sort()) === JSON.stringify(extendedFiles),
  'only the two Windows integration-heavy suites receive extended budgets',
);

for (const file of extendedFiles) {
  runner.assert(
    rotationFileTimeoutMs(file) === 8 * 60 * 1000,
    `${file} receives the bounded eight-minute integration budget`,
  );
}

runner.assert(
  rotationFileTimeoutMs('test-client-adapters.mjs') === DEFAULT_ROTATION_FILE_TIMEOUT_MS,
  'fixture-isolated adapter tests retain the default budget',
);

runner.assert(
  rotationFileTimeoutMs('test-phase1.mjs') === DEFAULT_ROTATION_FILE_TIMEOUT_MS,
  'other unlisted test files use the default budget',
);

runner.assert(
  (() => {
    try {
      rotationFileTimeoutMs('../test-client-adapters.mjs');
      return false;
    } catch (error) {
      return error instanceof TypeError;
    }
  })(),
  'timeout policy rejects non-basename file identifiers',
);

process.exit(runner.summary());
