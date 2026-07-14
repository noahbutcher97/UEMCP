import { TestRunner } from './test-helpers.mjs';
import { extractAssertionFailureDetails } from './rotation-failure-details.mjs';

const runner = new TestRunner('Rotation Assertion Failure Details');

const failureMark = '\u2717';

const details = extractAssertionFailureDetails(
  [
    'ordinary stdout chatter',
    '  Failures:',
    `  ${failureMark} matrix helper holds its output lease`,
    `  ${failureMark} fallback-only assertion`,
  ].join('\n'),
  [
    'ordinary stderr chatter',
    `  ${failureMark} matrix helper holds its output lease`,
  ].join('\n'),
);

runner.assert(
  JSON.stringify(details) === JSON.stringify([
    'matrix helper holds its output lease',
    'fallback-only assertion',
  ]),
  'failure detail extraction ignores chatter and deduplicates stderr/stdout reports',
  JSON.stringify(details),
);

const bounded = extractAssertionFailureDetails(
  '',
  [
    `  ${failureMark} first failure`,
    `  ${failureMark} second failure`,
    `  ${failureMark} third failure`,
  ].join('\n'),
  { maxDetails: 2 },
);
runner.assert(
  JSON.stringify(bounded) === JSON.stringify(['first failure', 'second failure']),
  'failure detail extraction bounds the number of reported assertions',
  JSON.stringify(bounded),
);

const truncated = extractAssertionFailureDetails(
  '',
  `  ${failureMark} assertion detail 0123456789`,
  { maxDetailChars: 20 },
);
runner.assert(
  truncated.length === 1
    && truncated[0].length === 20
    && truncated[0].endsWith('...'),
  'failure detail extraction bounds individual assertion text',
  JSON.stringify(truncated),
);

process.exit(runner.summary());
