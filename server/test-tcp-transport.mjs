import { readFile } from 'node:fs/promises';
import { TestRunner } from './test-helpers.mjs';

const fixtureUrl = new URL('../plugin/UEMCP/Resources/Tests/tcp-transport-cases.json', import.meta.url);
const runner = new TestRunner('TCP transport contract fixture schema');

const requiredCaseIds = [
  'framed-basic',
  'framed-case-insensitive',
  'framed-extra-header',
  'framed-colon-in-extra-value',
  'framed-bom-multibyte',
  'legacy-bom-multibyte',
  'legacy-basic',
  'legacy-leading-trailing-whitespace',
  'legacy-nested-escaped',
  'partial-prefix',
  'partial-header',
  'partial-framed-body',
  'partial-legacy-object',
  'header-empty-length',
  'header-signed-length',
  'header-suffixed-length',
  'header-embedded-space',
  'header-duplicate-length',
  'header-bad-extra-name',
  'header-missing-extra-colon',
  'header-folded-line',
  'header-control-value',
  'header-non-ascii',
  'header-integer-overflow',
  'request-huge-length',
  'header-cap-no-terminator',
  'framed-exact-small-limit',
  'framed-over-small-limit',
  'legacy-exact-small-limit',
  'legacy-over-small-limit',
  'framed-trailing-byte',
  'legacy-trailing-byte',
  'legacy-mismatched-close',
  'json-root-array',
  'json-root-scalar',
  'json-invalid-object',
  'utf8-overlong',
  'utf8-surrogate',
  'utf8-above-max',
  'utf8-forbidden-lead',
  'utf8-lone-continuation',
  'utf8-malformed-continuation',
  'utf8-truncated-framed',
  'bom-duplicate',
  'bom-after-whitespace',
  'bom-partial-framed',
];

const allowedTargets = new Set(['request', 'response']);
const allowedStatuses = new Set(['pending', 'complete', 'malformed', 'too_large']);
const allowedFraming = new Set(['undecided', 'legacy', 'framed']);
const allowedReasonCodes = new Set([
  'invalid_header',
  'header_too_large',
  'invalid_content_length',
  'content_length_overflow',
  'body_too_large',
  'trailing_bytes',
  'invalid_utf8',
  'invalid_bom',
  'root_not_object',
  'invalid_json',
  'mismatched_delimiter',
]);

function decodedBytes(caseData) {
  const hasAscii = Object.hasOwn(caseData, 'data_ascii');
  const hasBase64 = Object.hasOwn(caseData, 'data_base64');
  runner.assert(hasAscii !== hasBase64, `${caseData.id}: exactly one encoding is present`);
  if (hasAscii === hasBase64) return null;

  const bytes = hasAscii
    ? Buffer.from(caseData.data_ascii, 'ascii')
    : Buffer.from(caseData.data_base64, 'base64');
  runner.assert(bytes.length > 0, `${caseData.id}: decoded bytes are non-empty`);
  return bytes;
}

function validateChunkPlans(caseData, bytes) {
  runner.assert(Array.isArray(caseData.chunk_plans) && caseData.chunk_plans.length > 0,
    `${caseData.id}: chunk_plans is a non-empty array`);
  if (!Array.isArray(caseData.chunk_plans)) return;
  for (const [planIndex, plan] of caseData.chunk_plans.entries()) {
    const validLengths = Array.isArray(plan)
      && plan.every((length) => Number.isInteger(length) && length > 0);
    runner.assert(validLengths, `${caseData.id}: chunk plan ${planIndex} has positive integer lengths`);
    if (validLengths) {
      const total = plan.reduce((sum, length) => sum + length, 0);
      runner.assert(total === bytes.length,
        `${caseData.id}: chunk plan ${planIndex} totals decoded input length`,
        `expected ${bytes.length}, got ${total}`);
    }
  }
}

const fixtureText = await readFile(fixtureUrl, 'utf8');
let fixture;
try {
  fixture = JSON.parse(fixtureText);
  runner.assert(true, 'fixture is valid JSON');
} catch (error) {
  runner.assert(false, 'fixture is valid JSON', error.message);
}

runner.assert(fixture?.version === 1, 'schema version is exactly 1', `got ${fixture?.version}`);
const cases = Array.isArray(fixture?.cases) ? fixture.cases : [];
runner.assert(Array.isArray(fixture?.cases), 'cases is an array');
const ids = cases.map((caseData) => caseData?.id);
runner.assert(new Set(ids).size === ids.length, 'case IDs are unique');

for (const caseData of cases) {
  runner.assert(typeof caseData?.id === 'string' && caseData.id.length > 0,
    `${caseData?.id ?? '<missing>'}: id is non-empty`);
  const bytes = decodedBytes(caseData);
  validateChunkPlans(caseData, bytes ?? Buffer.alloc(0));

  const targetsValid = Array.isArray(caseData.targets)
    && caseData.targets.length > 0
    && caseData.targets.every((target) => allowedTargets.has(target));
  runner.assert(targetsValid, `${caseData.id}: targets are non-empty request/response values`);

  const expected = caseData.expected ?? {};
  runner.assert(allowedStatuses.has(expected.status), `${caseData.id}: status is allowed`);
  runner.assert(allowedFraming.has(expected.framing), `${caseData.id}: framing is allowed`);
  if (Object.hasOwn(expected, 'declared_body_length')) {
    runner.assert(Number.isSafeInteger(expected.declared_body_length) && expected.declared_body_length >= 0,
      `${caseData.id}: declared_body_length is a non-negative safe integer`);
  }
  if (Object.hasOwn(caseData, 'all_split_points')) {
    runner.assert(typeof caseData.all_split_points === 'boolean',
      `${caseData.id}: all_split_points is boolean when present`);
  }
  if (Object.hasOwn(caseData, 'policy')) {
    const policy = caseData.policy;
    const validPolicy = policy !== null
      && typeof policy === 'object'
      && Object.keys(policy).every((key) => key === 'max_header_bytes' || key === 'max_body_bytes')
      && Object.values(policy).every((value) => Number.isSafeInteger(value) && value > 0);
    runner.assert(validPolicy, `${caseData.id}: policy contains positive supported limits`);
  }
  if (Object.hasOwn(expected, 'reason_code')) {
    runner.assert(allowedReasonCodes.has(expected.reason_code), `${caseData.id}: reason_code is allowed`);
  }
  if (expected.status === 'pending' || expected.status === 'complete') {
    runner.assert(!Object.hasOwn(expected, 'reason_code'),
      `${caseData.id}: pending/complete cases omit reason_code`);
  } else {
    runner.assert(Object.hasOwn(expected, 'reason_code'),
      `${caseData.id}: terminal case includes reason_code`);
  }
}

const actualIds = new Set(ids);
for (const id of requiredCaseIds) {
  runner.assert(actualIds.has(id), `required case exists: ${id}`);
}

process.exit(runner.summary());
