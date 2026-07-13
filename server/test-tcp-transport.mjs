import { readFile } from 'node:fs/promises';
import { TestRunner } from './test-helpers.mjs';
import {
  TCP_MAX_HEADER_BYTES,
  TCP_MAX_REQUEST_BODY_BYTES,
  TcpResponseDecoder,
  TcpTransportError,
  encodeTcpRequest,
} from './tcp-transport.mjs';

const fixtureUrl = new URL('../plugin/UEMCP/Resources/Tests/tcp-transport-cases.json', import.meta.url);
const transportUrl = new URL('./tcp-transport.mjs', import.meta.url);
const runner = new TestRunner('TCP transport contract and Node decoder');

const requiredCaseIds = [
  'framed-basic',
  'framed-case-insensitive',
  'framed-extra-header',
  'framed-colon-in-extra-value',
  'framed-bom-multibyte',
  'legacy-bom-multibyte',
  'bom-valid-object',
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
const requiredAllSplitPointIds = new Set([
  'framed-basic',
  'framed-bom-multibyte',
  'legacy-nested-escaped',
  'legacy-bom-multibyte',
]);

const canonicalBase64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function isAsciiString(value) {
  if (typeof value !== 'string') return false;
  for (let index = 0; index < value.length; index++) {
    if (value.charCodeAt(index) > 0x7f) return false;
  }
  return true;
}

function decodeCanonicalBase64(value) {
  if (typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !canonicalBase64Pattern.test(value)) {
    return null;
  }

  const bytes = Buffer.from(value, 'base64');
  return bytes.toString('base64') === value ? bytes : null;
}

function isValidPolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) return false;
  const keys = Object.keys(policy);
  return keys.length > 0
    && keys.every((key) => key === 'max_header_bytes' || key === 'max_body_bytes')
    && Object.values(policy).every((value) => Number.isSafeInteger(value) && value > 0);
}

function decodedBytes(caseData) {
  const hasAscii = Object.hasOwn(caseData, 'data_ascii');
  const hasBase64 = Object.hasOwn(caseData, 'data_base64');
  runner.assert(hasAscii !== hasBase64, `${caseData.id}: exactly one encoding is present`);
  if (hasAscii === hasBase64) return null;

  let bytes;
  if (hasAscii) {
    const validAscii = isAsciiString(caseData.data_ascii);
    runner.assert(validAscii, `${caseData.id}: data_ascii is an ASCII string`);
    if (!validAscii) return null;
    bytes = Buffer.from(caseData.data_ascii, 'ascii');
  } else {
    bytes = decodeCanonicalBase64(caseData.data_base64);
    runner.assert(bytes !== null, `${caseData.id}: data_base64 is canonical valid base64`);
    if (bytes === null) return null;
  }

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

runner.assert(!isAsciiString('non-ASCII: \u0080'),
  'ASCII validator rejects non-ASCII code units');
runner.assert(decodeCanonicalBase64('A===') === null,
  'base64 validator rejects malformed syntax and padding');
runner.assert(decodeCanonicalBase64('ZE==') === null,
  'base64 validator rejects noncanonical pad bits');
runner.assert(!isValidPolicy({}),
  'policy validator rejects an empty policy object');

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
const caseBytesById = new Map();

for (const caseData of cases) {
  runner.assert(typeof caseData?.id === 'string' && caseData.id.length > 0,
    `${caseData?.id ?? '<missing>'}: id is non-empty`);
  const bytes = decodedBytes(caseData);
  if (bytes !== null) caseBytesById.set(caseData.id, bytes);
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
  if (requiredAllSplitPointIds.has(caseData.id)) {
    runner.assert(caseData.all_split_points === true,
      `${caseData.id}: all_split_points is true for the mandated exhaustive-split fixture`);
  }
  if (Object.hasOwn(caseData, 'policy')) {
    runner.assert(isValidPolicy(caseData.policy),
      `${caseData.id}: policy contains at least one positive supported limit`);
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

const casesById = new Map(cases.map((caseData) => [caseData.id, caseData]));
const requestHugeLength = casesById.get('request-huge-length');
runner.assert(requestHugeLength?.data_ascii === 'Content-Length: 8388609\r\n\r\n',
  'request-huge-length declares the default 8 MiB limit plus one byte');
runner.assert(JSON.stringify(requestHugeLength?.targets) === JSON.stringify(['request']),
  'request-huge-length targets requests only');
runner.assert(JSON.stringify(requestHugeLength?.chunk_plans) === JSON.stringify([[27]]),
  'request-huge-length consumes the exact declaration in one chunk');
runner.assert(requestHugeLength?.expected?.declared_body_length === 8388609,
  'request-huge-length expected declaration is 8388609');
runner.assert(requestHugeLength?.expected?.status === 'too_large'
  && requestHugeLength.expected.framing === 'framed'
  && requestHugeLength.expected.reason_code === 'body_too_large',
  'request-huge-length has the exact terminal contract');
runner.assert(!Object.hasOwn(requestHugeLength ?? {}, 'policy'),
  'request-huge-length uses the production default body limit');

const headerCapNoTerminator = casesById.get('header-cap-no-terminator');
const headerCapBytes = typeof headerCapNoTerminator?.data_ascii === 'string'
  ? Buffer.from(headerCapNoTerminator.data_ascii, 'ascii')
  : Buffer.alloc(0);
runner.assert(headerCapBytes.length === 512,
  'header-cap-no-terminator is exactly the default 512-byte header cap');
runner.assert(!headerCapBytes.includes(Buffer.from('\r\n\r\n', 'ascii')),
  'header-cap-no-terminator omits the header terminator');
runner.assert(JSON.stringify(headerCapNoTerminator?.targets) === JSON.stringify(['request', 'response']),
  'header-cap-no-terminator targets requests and responses');
runner.assert(JSON.stringify(headerCapNoTerminator?.chunk_plans) === JSON.stringify([[512]]),
  'header-cap-no-terminator consumes the exact cap in one chunk');
runner.assert(headerCapNoTerminator?.expected?.status === 'malformed'
  && headerCapNoTerminator.expected.framing === 'framed'
  && headerCapNoTerminator.expected.reason_code === 'header_too_large',
  'header-cap-no-terminator has the exact terminal contract');
runner.assert(!Object.hasOwn(headerCapNoTerminator ?? {}, 'policy'),
  'header-cap-no-terminator uses the production default header cap');

const bomValidObject = casesById.get('bom-valid-object');
runner.assert(bomValidObject?.data_base64 === '77u/e30=',
  'bom-valid-object uses the exact leading-BOM object vector');
runner.assert(Array.isArray(bomValidObject?.targets)
  && bomValidObject.targets.length === 2
  && bomValidObject.targets[0] === 'request'
  && bomValidObject.targets[1] === 'response',
  'bom-valid-object targets request and response');
const bomValidJson = bomValidObject?.expected?.json;
runner.assert(bomValidObject?.expected?.status === 'complete'
  && bomValidObject.expected.framing === 'legacy'
  && bomValidJson !== null
  && typeof bomValidJson === 'object'
  && !Array.isArray(bomValidJson)
  && Object.keys(bomValidJson).length === 0,
  'bom-valid-object completes as a legacy object');

function sameJson(actual, expected) {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function caughtError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

const deepJsonDepth = 5000;

function deepJsonText(depth) {
  return `{"deep":${'['.repeat(depth)}0${']'.repeat(depth)}}`;
}

function inspectDeepJsonValue(value, depth) {
  let current = value.deep;
  const inspectedContainers = [value, current];
  for (let level = 0; level < depth; level++) {
    if (level === Math.floor(depth / 2) || level === depth - 1) {
      inspectedContainers.push(current);
    }
    current = current[0];
  }
  return {
    inspectedContainersFrozen: inspectedContainers.every((container) => Object.isFrozen(container)),
    leaf: current,
  };
}

const byteAtATimeFixtureIds = new Set(['framed-basic']);

function responsePlans(caseData, bytes) {
  const plans = [{ category: 'whole', name: 'whole-buffer', lengths: [bytes.length] }];
  for (const [index, lengths] of caseData.chunk_plans.entries()) {
    plans.push({ category: 'explicit', name: `explicit-${index}`, lengths });
  }
  if (caseData.all_split_points) {
    for (let split = 1; split < bytes.length; split++) {
      plans.push({
        category: 'generatedSplit',
        name: `split-${split}`,
        lengths: [split, bytes.length - split],
      });
    }
  }
  if (byteAtATimeFixtureIds.has(caseData.id)) {
    plans.push({
      category: 'byteAtATime',
      name: 'byte-at-a-time',
      lengths: Array.from({ length: bytes.length }, () => 1),
    });
  }
  return plans;
}

function expectedResponseSnapshot(caseData, bytes) {
  const expected = caseData.expected;
  return {
    status: expected.status,
    framing: expected.framing,
    bytesReceived: bytes.length,
    declaredBodyLength: expected.declared_body_length ?? null,
    ...(expected.status === 'complete' ? { value: expected.json } : {}),
    ...(expected.status === 'malformed' ? { reasonCode: expected.reason_code } : {}),
  };
}

function consumePlan(decoder, bytes, lengths, label) {
  let offset = 0;
  let snapshot = decoder.snapshot();
  for (const [index, length] of lengths.entries()) {
    snapshot = decoder.consume(bytes.subarray(offset, offset + length));
    offset += length;
    if (index < lengths.length - 1) {
      runner.assert(snapshot.status === 'pending', `${label}: chunk ${index} remains pending`);
    }
  }
  return snapshot;
}

runner.assert(TCP_MAX_HEADER_BYTES === 512,
  'production response header cap is exactly 512 bytes');
runner.assert(TCP_MAX_REQUEST_BODY_BYTES === 8 * 1024 * 1024,
  'production request body cap is exactly 8 MiB');

const responseCases = cases.filter((entry) => entry.targets.includes('response'));
const expectedResponsePlanCounts = {
  whole: responseCases.length,
  explicit: responseCases.reduce((count, entry) => count + entry.chunk_plans.length, 0),
  generatedSplit: responseCases.reduce((count, entry) => {
    const bytes = caseBytesById.get(entry.id);
    return count + (entry.all_split_points ? bytes.length - 1 : 0);
  }, 0),
  byteAtATime: responseCases.filter((entry) => byteAtATimeFixtureIds.has(entry.id)).length,
};
const actualResponsePlanCounts = {
  whole: 0,
  explicit: 0,
  generatedSplit: 0,
  byteAtATime: 0,
};

for (const caseData of responseCases) {
  const bytes = caseBytesById.get(caseData.id);
  for (const plan of responsePlans(caseData, bytes)) {
    const decoder = new TcpResponseDecoder({
      maxHeaderBytes: caseData.policy?.max_header_bytes ?? TCP_MAX_HEADER_BYTES,
    });
    const label = `${caseData.id} [${plan.name}]`;
    const snapshot = consumePlan(decoder, bytes, plan.lengths, label);
    const expected = expectedResponseSnapshot(caseData, bytes);
    runner.assert(sameJson(snapshot, expected), `${label}: snapshot matches fixture`,
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(snapshot)}`);
    runner.assert(Object.isFrozen(snapshot), `${label}: snapshot is immutable`);
    runner.assert(!Object.hasOwn(snapshot, 'body') && !Object.hasOwn(snapshot, 'bodyText'),
      `${label}: snapshot contains no body text`);
    actualResponsePlanCounts[plan.category]++;
  }
}
for (const category of Object.keys(expectedResponsePlanCounts)) {
  runner.assert(actualResponsePlanCounts[category] === expectedResponsePlanCounts[category],
    `response fixtures execute the exact derived ${category} plan count`,
    `expected ${expectedResponsePlanCounts[category]}, got ${actualResponsePlanCounts[category]}`);
}
runner.assert(sameJson(actualResponsePlanCounts, {
  whole: 42,
  explicit: 42,
  generatedSplit: 145,
  byteAtATime: 1,
}), 'response fixture execution categories remain independently counted');
runner.assert(responsePlans(
  casesById.get('framed-basic'),
  caseBytesById.get('framed-basic'),
).some((plan) => plan.category === 'byteAtATime'
  && plan.lengths.length === caseBytesById.get('framed-basic').length
  && plan.lengths.every((length) => length === 1)),
'framed-basic persistently covers prefix, terminator, and body one byte at a time');

{
  const decoder = new TcpResponseDecoder();
  const initial = decoder.snapshot();
  runner.assert(sameJson(initial, {
    status: 'pending', framing: 'undecided', bytesReceived: 0, declaredBodyLength: null,
  }), 'initial decoder snapshot exposes only pending metadata');
  runner.assert(Object.isFrozen(initial), 'initial decoder snapshot is immutable');
  runner.assert(decoder.consume(Buffer.alloc(0)).bytesReceived === 0,
    'decoder accepts an empty Buffer chunk');
  runner.assert(decoder.consume(new Uint8Array(0)).bytesReceived === 0,
    'decoder accepts an empty Uint8Array chunk');

  const uint8Decoder = new TcpResponseDecoder();
  const uint8Bytes = new Uint8Array(Buffer.from('{}', 'ascii'));
  runner.assert(uint8Decoder.consume(uint8Bytes).status === 'complete',
    'decoder consumes non-empty Uint8Array bytes');

  for (const invalidChunk of ['{}', new ArrayBuffer(0), new Uint16Array(0), null]) {
    const error = caughtError(() => decoder.consume(invalidChunk));
    runner.assert(error instanceof TypeError,
      `decoder rejects chunk type ${invalidChunk?.constructor?.name ?? 'null'}`);
  }
}

{
  const decoder = new TcpResponseDecoder();
  const complete = decoder.consume(Buffer.from('{"ok":true}', 'ascii'));
  runner.assert(complete.status === 'complete', 'terminal-state test reaches completion');
  runner.assert(decoder.snapshot() === complete, 'snapshot returns the immutable terminal snapshot');
  runner.assert(caughtError(() => decoder.consume(Buffer.from(' ', 'ascii'))) instanceof Error,
    'decoder rejects consume after complete terminal state');
  runner.assert(decoder.finish() === complete, 'finish preserves a complete terminal snapshot');
  runner.assert(sameJson(decoder.debugStatsForTests(), {
    legacyBytesScanned: 11, bodyAssemblyCount: 1, jsonParseCount: 1,
  }), 'complete legacy candidate scans, assembles, and parses exactly once');
}

{
  const decoder = new TcpResponseDecoder();
  const complete = decoder.consume(Buffer.from(
    '{"nested":{"items":[{"value":1},2]}}',
    'ascii',
  ));
  const assignmentError = caughtError(() => {
    complete.value.nested.items[0].value = 99;
  });
  const arrayError = caughtError(() => {
    complete.value.nested.items.push(3);
  });
  const observedAgain = decoder.snapshot();
  const observedThird = decoder.snapshot();
  runner.assert(Object.isFrozen(complete.value)
    && Object.isFrozen(complete.value.nested)
    && Object.isFrozen(complete.value.nested.items)
    && Object.isFrozen(complete.value.nested.items[0])
    && assignmentError instanceof TypeError
    && arrayError instanceof TypeError
    && observedAgain.value.nested.items.length === 2
    && observedAgain.value.nested.items[0].value === 1
    && observedThird.value === observedAgain.value
    && sameJson(observedAgain.value, {
      nested: { items: [{ value: 1 }, 2] },
    })
    && sameJson(observedThird.value, {
      nested: { items: [{ value: 1 }, 2] },
    }), 'complete snapshots recursively freeze JSON values across repeated observations');
}

{
  const text = deepJsonText(deepJsonDepth);
  const body = Buffer.from(text, 'ascii');
  const framed = Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'),
    body,
  ]);

  for (const [framing, bytes] of [['framed', framed], ['legacy', body]]) {
    let directValue;
    const directParseError = caughtError(() => {
      directValue = JSON.parse(text);
    });
    const directInspection = directParseError === null
      ? inspectDeepJsonValue(directValue, deepJsonDepth)
      : null;
    runner.assert(directParseError === null && directInspection?.leaf === 0,
      `${framing} depth-5000 control succeeds with direct JSON.parse`);

    const decoder = new TcpResponseDecoder();
    let complete;
    const decoderError = caughtError(() => {
      complete = decoder.consume(bytes);
    });
    runner.assert(decoderError === null && complete?.status === 'complete',
      `${framing} depth-5000 decoder completes without recursive stack overflow`);

    const repeated = decoder.snapshot();
    const inspection = complete?.status === 'complete'
      ? inspectDeepJsonValue(complete.value, deepJsonDepth)
      : null;
    const repeatedInspection = repeated.status === 'complete'
      ? inspectDeepJsonValue(repeated.value, deepJsonDepth)
      : null;
    runner.assert(inspection?.leaf === 0
      && inspection.inspectedContainersFrozen
      && repeatedInspection?.leaf === 0
      && repeatedInspection.inspectedContainersFrozen
      && repeated === complete
      && repeated.value === complete.value
      && sameJson(decoder.debugStatsForTests(), {
        legacyBytesScanned: framing === 'legacy' ? body.length : 0,
        bodyAssemblyCount: 1,
        jsonParseCount: 1,
      }), `${framing} depth-5000 result is deeply frozen, stable, assembled once, and parsed once`);
  }
}

{
  const cyclicValue = {};
  cyclicValue.self = cyclicValue;
  const decoder = new TcpResponseDecoder({
    parseJson() {
      return cyclicValue;
    },
  });
  let snapshot;
  const consumeError = caughtError(() => {
    snapshot = decoder.consume(Buffer.from('{}', 'ascii'));
  });
  runner.assert(consumeError === null
    && snapshot.status === 'malformed'
    && snapshot.reasonCode === 'invalid_json'
    && decoder.snapshot() === snapshot
    && !Object.isFrozen(cyclicValue)
    && sameJson(decoder.debugStatsForTests(), {
      legacyBytesScanned: 2,
      bodyAssemblyCount: 1,
      jsonParseCount: 1,
    }), 'cyclic injected parser output terminates as invalid_json without freezing parser-owned objects');
}

{
  const decoder = new TcpResponseDecoder();
  const malformed = decoder.consume(Buffer.from('{"x":1]X', 'ascii'));
  runner.assert(malformed.status === 'malformed', 'terminal-state test reaches malformed state');
  runner.assert(caughtError(() => decoder.consume(Buffer.alloc(0))) instanceof Error,
    'decoder rejects consume after malformed terminal state');
}

{
  const bytes = caseBytesById.get('legacy-nested-escaped');
  const decoder = new TcpResponseDecoder();
  for (let index = 0; index < bytes.length; index++) {
    const snapshot = decoder.consume(bytes.subarray(index, index + 1));
    const stats = decoder.debugStatsForTests();
    runner.assert(stats.legacyBytesScanned === index + 1,
      `legacy scanner visits byte ${index + 1} exactly once`);
    if (snapshot.status === 'pending') {
      runner.assert(stats.bodyAssemblyCount === 0 && stats.jsonParseCount === 0,
        `legacy byte ${index + 1}: pending state does not assemble or parse`);
    }
  }
  runner.assert(sameJson(decoder.debugStatsForTests(), {
    legacyBytesScanned: bytes.length, bodyAssemblyCount: 1, jsonParseCount: 1,
  }), 'fragmented legacy candidate has linear scan and one finalization');
  const copy = decoder.debugStatsForTests();
  copy.legacyBytesScanned = -1;
  runner.assert(decoder.debugStatsForTests().legacyBytesScanned === bytes.length,
    'debug stats are returned as a copy');
}

{
  const decoder = new TcpResponseDecoder();
  decoder.consume(Buffer.from('Content-Length: 11\r\n\r\n{"ok"', 'ascii'));
  runner.assert(sameJson(decoder.debugStatsForTests(), {
    legacyBytesScanned: 0, bodyAssemblyCount: 0, jsonParseCount: 0,
  }), 'pending framed body has zero scanner, assembly, and parse work');
}

{
  const headerPrefix = 'Content-Length: 2\r\nX-Pad: ';
  const headerSuffix = '\r\n\r\n';
  const paddingBytes = TCP_MAX_HEADER_BYTES
    - Buffer.byteLength(headerPrefix + headerSuffix, 'ascii');
  const header = Buffer.from(headerPrefix + 'a'.repeat(paddingBytes) + headerSuffix, 'ascii');
  const decoder = new TcpResponseDecoder();
  runner.assert(header.length === TCP_MAX_HEADER_BYTES,
    'generated terminated header is exactly the 512-byte cap');
  let terminatedPendingThrough511 = true;
  let headerComplete;
  for (let index = 0; index < header.length; index++) {
    const snapshot = decoder.consume(header.subarray(index, index + 1));
    if (index < header.length - 1 && snapshot.status !== 'pending') {
      terminatedPendingThrough511 = false;
    }
    if (index === header.length - 1) headerComplete = snapshot;
  }
  runner.assert(terminatedPendingThrough511,
    'terminated header remains pending through byte 511 when consumed byte at a time');
  runner.assert(headerComplete.status === 'pending'
    && headerComplete.framing === 'framed'
    && headerComplete.declaredBodyLength === 2,
  'terminated header byte 512 is accepted without header_too_large');
  runner.assert(decoder.consume(Buffer.from('{', 'ascii')).status === 'pending'
    && decoder.consume(Buffer.from('}', 'ascii')).status === 'complete',
  'body completes byte at a time after an exactly-at-cap framed header');

  const unterminatedDecoder = new TcpResponseDecoder();
  let unterminatedPendingThrough511 = true;
  let unterminatedTerminal;
  for (let index = 0; index < headerCapBytes.length; index++) {
    const snapshot = unterminatedDecoder.consume(headerCapBytes.subarray(index, index + 1));
    if (index < headerCapBytes.length - 1 && snapshot.status !== 'pending') {
      unterminatedPendingThrough511 = false;
    }
    if (index === headerCapBytes.length - 1) unterminatedTerminal = snapshot;
  }
  runner.assert(unterminatedPendingThrough511,
    'unterminated header remains pending through byte 511 when consumed byte at a time');
  runner.assert(unterminatedTerminal.status === 'malformed'
    && unterminatedTerminal.framing === 'framed'
    && unterminatedTerminal.reasonCode === 'header_too_large'
    && unterminatedTerminal.bytesReceived === TCP_MAX_HEADER_BYTES,
  'unterminated header becomes header_too_large exactly at byte 512');
}

{
  let injectedParseCount = 0;
  const decoder = new TcpResponseDecoder({
    parseJson(text) {
      injectedParseCount++;
      return JSON.parse(text);
    },
  });
  const bytes = caseBytesById.get('framed-basic');
  decoder.consume(bytes.subarray(0, bytes.length - 1));
  runner.assert(sameJson(decoder.debugStatsForTests(), {
    legacyBytesScanned: 0, bodyAssemblyCount: 0, jsonParseCount: 0,
  }), 'fragmented framed candidate does no finalization while pending');
  const snapshot = decoder.consume(bytes.subarray(bytes.length - 1));
  runner.assert(snapshot.status === 'complete' && injectedParseCount === 1
    && sameJson(decoder.debugStatsForTests(), {
      legacyBytesScanned: 0, bodyAssemblyCount: 1, jsonParseCount: 1,
    }), 'complete framed candidate assembles and parses exactly once');
}

{
  let injectedParseCount = 0;
  const decoder = new TcpResponseDecoder({
    parseJson(text) {
      injectedParseCount++;
      return JSON.parse(text);
    },
  });
  const snapshot = decoder.consume(caseBytesById.get('json-invalid-object'));
  runner.assert(snapshot.reasonCode === 'invalid_json',
    'completed invalid JSON candidate is classified accurately');
  runner.assert(injectedParseCount === 1 && sameJson(decoder.debugStatsForTests(), {
    legacyBytesScanned: 6, bodyAssemblyCount: 1, jsonParseCount: 1,
  }), 'completed invalid JSON candidate assembles and parses exactly once');
}

{
  let injectedParseCount = 0;
  const decoder = new TcpResponseDecoder({
    parseJson(text) {
      injectedParseCount++;
      return JSON.parse(text);
    },
  });
  const snapshot = decoder.consume(Buffer.from('Content-Length: 6\r\n\r\n{"x":}', 'ascii'));
  runner.assert(snapshot.reasonCode === 'invalid_json' && injectedParseCount === 1
    && sameJson(decoder.debugStatsForTests(), {
      legacyBytesScanned: 0, bodyAssemblyCount: 1, jsonParseCount: 1,
    }), 'invalid framed JSON candidate assembles and parses exactly once');
}

{
  const secretMarker = 'UEMCP_SECRET_PAYLOAD_SENTINEL';
  let snapshot;
  const consumeError = caughtError(() => {
    const decoder = new TcpResponseDecoder({
      parseJson() {
        throw new Error(`injected parser failure: ${secretMarker}`);
      },
    });
    snapshot = decoder.consume(Buffer.from('{"safe":true}', 'ascii'));
  });
  runner.assert(consumeError === null
    && snapshot.status === 'malformed'
    && snapshot.reasonCode === 'invalid_json'
    && !JSON.stringify(snapshot).includes(secretMarker),
  'injected parser error text is consumed into a marker-free invalid_json snapshot');

  const malformedDecoder = new TcpResponseDecoder();
  let malformedSnapshot;
  const malformedConsumeError = caughtError(() => {
    malformedSnapshot = malformedDecoder.consume(Buffer.from(
      `{"secret":"${secretMarker}",}`,
      'ascii',
    ));
  });
  const postTerminalError = caughtError(() => malformedDecoder.consume(Buffer.alloc(0)));
  runner.assert(malformedConsumeError === null
    && malformedSnapshot.status === 'malformed'
    && malformedSnapshot.reasonCode === 'invalid_json'
    && !JSON.stringify(malformedSnapshot).includes(secretMarker)
    && postTerminalError instanceof Error
    && !postTerminalError.message.includes(secretMarker),
  'malformed payload diagnostics and terminal errors retain no secret marker');
}

{
  const nonJsonValue = new Date(0);
  const decoder = new TcpResponseDecoder({
    parseJson() {
      return { nested: nonJsonValue };
    },
  });
  const snapshot = decoder.consume(Buffer.from('{}', 'ascii'));
  runner.assert(snapshot.status === 'malformed'
    && snapshot.reasonCode === 'invalid_json'
    && !Object.isFrozen(nonJsonValue),
  'injected non-JSON objects are rejected without freezing arbitrary instances');
}

{
  let injectedParseCount = 0;
  const decoder = new TcpResponseDecoder({ parseJson() { injectedParseCount++; } });
  const snapshot = decoder.consume(caseBytesById.get('utf8-overlong'));
  runner.assert(snapshot.reasonCode === 'invalid_utf8',
    'invalid UTF-8 is terminal before JSON parsing');
  runner.assert(injectedParseCount === 0 && sameJson(decoder.debugStatsForTests(), {
    legacyBytesScanned: 10, bodyAssemblyCount: 1, jsonParseCount: 0,
  }), 'invalid UTF-8 assembles once and never reaches the parser');
}

{
  const declaration = Buffer.from(
    `Content-Length: ${Number.MAX_SAFE_INTEGER}\r\n\r\n`,
    'ascii',
  );
  const originalAlloc = Buffer.alloc;
  const originalAllocUnsafe = Buffer.allocUnsafe;
  const directAllocations = [];
  let allocationError = null;
  let decoder;
  let snapshot;
  try {
    Buffer.alloc = function instrumentedAlloc(size, ...args) {
      directAllocations.push({ method: 'alloc', size });
      if (size > TCP_MAX_HEADER_BYTES) throw new Error(`unexpected direct allocation: ${size}`);
      return Reflect.apply(originalAlloc, Buffer, [size, ...args]);
    };
    Buffer.allocUnsafe = function instrumentedAllocUnsafe(size, ...args) {
      directAllocations.push({ method: 'allocUnsafe', size });
      if (size > TCP_MAX_HEADER_BYTES) throw new Error(`unexpected direct allocation: ${size}`);
      return Reflect.apply(originalAllocUnsafe, Buffer, [size, ...args]);
    };
    decoder = new TcpResponseDecoder();
    snapshot = decoder.consume(declaration);
  } catch (error) {
    allocationError = error;
  } finally {
    Buffer.alloc = originalAlloc;
    Buffer.allocUnsafe = originalAllocUnsafe;
  }
  runner.assert(allocationError === null
    && sameJson(directAllocations, [{ method: 'alloc', size: TCP_MAX_HEADER_BYTES }]),
  'max-safe declaration directly requests only the fixed 512-byte scratch allocation');
  runner.assert(snapshot?.status === 'pending'
    && snapshot.declaredBodyLength === Number.MAX_SAFE_INTEGER,
  'safe response declarations remain uncapped and pending without body bytes');
  runner.assert(sameJson(decoder.debugStatsForTests(), {
    legacyBytesScanned: 0, bodyAssemblyCount: 0, jsonParseCount: 0,
  }), 'safe large response declaration performs no allocation, assembly, or parse');
}

{
  const decoder = new TcpResponseDecoder();
  const snapshot = decoder.consume(caseBytesById.get('header-integer-overflow'));
  runner.assert(snapshot.reasonCode === 'content_length_overflow'
    && snapshot.declaredBodyLength === null,
  'unsafe response length is malformed without a declared allocation length');
  runner.assert(sameJson(decoder.debugStatsForTests(), {
    legacyBytesScanned: 0, bodyAssemblyCount: 0, jsonParseCount: 0,
  }), 'unsafe response length performs no body assembly or parse');
}

{
  const decoder = new TcpResponseDecoder();
  const snapshot = decoder.consume(caseBytesById.get('framed-trailing-byte'));
  runner.assert(snapshot.reasonCode === 'trailing_bytes' && snapshot.bytesReceived === 29,
    'already-buffered bytes beyond a framed body are malformed');
  runner.assert(sameJson(decoder.debugStatsForTests(), {
    legacyBytesScanned: 0, bodyAssemblyCount: 0, jsonParseCount: 0,
  }), 'framed trailing bytes are rejected before body assembly or parse');
}

const eofCases = [
  { name: 'zero bytes', bytes: Buffer.alloc(0), reasonCode: 'no_response', framing: 'undecided' },
  { name: 'incomplete prefix', bytes: Buffer.from('Content-Le', 'ascii'), reasonCode: 'incomplete_prefix', framing: 'undecided' },
  { name: 'incomplete header', bytes: Buffer.from('Content-Length: 2\r\n', 'ascii'), reasonCode: 'incomplete_header', framing: 'framed' },
  { name: 'incomplete framed body', bytes: Buffer.from('Content-Length: 7\r\n\r\n{"x"', 'ascii'), reasonCode: 'incomplete_body', framing: 'framed', declaredBodyLength: 7 },
  { name: 'incomplete legacy object', bytes: Buffer.from('{"x":', 'ascii'), reasonCode: 'incomplete_legacy', framing: 'legacy' },
  { name: 'partial BOM', bytes: Buffer.from([0xef, 0xbb]), reasonCode: 'partial_bom', framing: 'legacy' },
  { name: 'truncated UTF-8', bytes: Buffer.concat([Buffer.from('{"x":"', 'ascii'), Buffer.from([0xe2, 0x82])]), reasonCode: 'truncated_utf8', framing: 'legacy' },
  { name: 'truncated framed UTF-8', bytes: Buffer.concat([Buffer.from('Content-Length: 10\r\n\r\n{"x":"', 'ascii'), Buffer.from([0xe2, 0x82])]), reasonCode: 'truncated_utf8', framing: 'framed', declaredBodyLength: 10 },
];

for (const eofCase of eofCases) {
  const decoder = new TcpResponseDecoder();
  if (eofCase.bytes.length > 0) {
    const pending = decoder.consume(eofCase.bytes);
    runner.assert(pending.status === 'pending', `${eofCase.name}: decoder is pending before EOF`);
  }
  const statsBefore = decoder.debugStatsForTests();
  const snapshot = decoder.finish();
  runner.assert(snapshot.status === 'malformed'
    && snapshot.framing === eofCase.framing
    && snapshot.bytesReceived === eofCase.bytes.length
    && snapshot.declaredBodyLength === (eofCase.declaredBodyLength ?? null)
    && snapshot.reasonCode === eofCase.reasonCode,
  `${eofCase.name}: finish returns metadata-only terminal diagnostics`,
  `got ${JSON.stringify(snapshot)}`);
  runner.assert(!Object.hasOwn(snapshot, 'value') && !Object.hasOwn(snapshot, 'body'),
    `${eofCase.name}: EOF diagnostics contain no body data`);
  runner.assert(sameJson(decoder.debugStatsForTests(), statsBefore),
    `${eofCase.name}: finish does not assemble or reparse`);
}

{
  const simple = encodeTcpRequest('ping', { value: 'ok' }, { port: 55558 });
  const expectedBody = Buffer.from(JSON.stringify({ type: 'ping', params: { value: 'ok' } }), 'utf8');
  const expectedHeader = Buffer.from(`Content-Length: ${expectedBody.length}\r\n\r\n`, 'ascii');
  runner.assert(Buffer.isBuffer(simple.body) && simple.body.equals(expectedBody),
    'request encoder returns the serialized UTF-8 body Buffer');
  runner.assert(simple.bodyBytes === expectedBody.length,
    'request encoder reports UTF-8 byte length');
  runner.assert(Buffer.isBuffer(simple.frame)
    && simple.frame.equals(Buffer.concat([expectedHeader, expectedBody])),
  'request encoder creates one exact Content-Length frame');

  const unicode = encodeTcpRequest('unicode', { text: '\u00e9' }, { port: 55558 });
  runner.assert(unicode.bodyBytes === Buffer.byteLength(JSON.stringify({
    type: 'unicode', params: { text: '\u00e9' },
  }), 'utf8'), 'request encoder measures bytes rather than JavaScript characters');
}

{
  const type = 'sized';
  const maxBodyBytes = TCP_MAX_REQUEST_BODY_BYTES;
  const baseBytes = Buffer.byteLength(JSON.stringify({ type, params: { padding: '' } }), 'utf8');
  const exact = encodeTcpRequest(type, { padding: 'x'.repeat(maxBodyBytes - baseBytes) }, {
    port: 55558,
    maxBodyBytes,
  });
  runner.assert(exact.bodyBytes === maxBodyBytes,
    'request encoder accepts exactly 8 MiB');

  const tooLarge = caughtError(() => encodeTcpRequest(
    type,
    { padding: 'x'.repeat(maxBodyBytes + 1 - baseBytes) },
    { port: 55558, maxBodyBytes },
  ));
  runner.assert(tooLarge instanceof TcpTransportError && tooLarge instanceof Error,
    'request encoder rejects 8 MiB plus one with TcpTransportError');
  runner.assert(tooLarge?.code === 'REQUEST_TOO_LARGE'
    && tooLarge.message.startsWith('TCP:55558')
    && sameJson(tooLarge.details, {
      direction: 'request', bodyBytes: maxBodyBytes + 1, maxBodyBytes,
    }), 'request encoder reports stable payload-free over-limit details');
}

{
  const suppliedDetails = {
    direction: 'response',
    framing: 'framed',
    bytesReceived: 12,
    declaredBodyLength: 20,
    timeoutMs: 10000,
    timeoutKind: 'absolute',
    parserCategory: 'invalid_json',
    nativeCode: 'ECONNRESET',
    payload: 'UEMCP_SECRET_PAYLOAD_SENTINEL',
    params: { secret: true },
    request: { secret: true },
    error: new Error('secret'),
    message: 'secret',
  };
  const error = new TcpTransportError('SOCKET_ERROR', 55558, suppliedDetails);
  suppliedDetails.nativeCode = 'CHANGED';
  runner.assert(error instanceof Error && error.name === 'TcpTransportError'
    && error.code === 'SOCKET_ERROR' && error.message.startsWith('TCP:55558'),
  'typed transport error preserves Error identity, stable code, and port prefix');
  runner.assert(Object.isFrozen(error.details), 'typed transport error details are frozen');
  runner.assert(sameJson(error.details, {
    direction: 'response',
    framing: 'framed',
    bytesReceived: 12,
    declaredBodyLength: 20,
    timeoutMs: 10000,
    timeoutKind: 'absolute',
    parserCategory: 'invalid_json',
    nativeCode: 'ECONNRESET',
  }), 'typed transport error copies only explicitly allowed safe details');
  runner.assert(!error.message.includes('UEMCP_SECRET_PAYLOAD_SENTINEL')
    && !JSON.stringify(error.details).includes('UEMCP_SECRET_PAYLOAD_SENTINEL'),
  'typed transport errors never retain arbitrary payload details');
}

const transportSource = await readFile(transportUrl, 'utf8');
const fixedHeaderAllocations = transportSource.match(/Buffer\.alloc\(TCP_MAX_HEADER_BYTES\)/g) ?? [];
runner.assert(fixedHeaderAllocations.length === 1,
  'source contains exactly one direct fixed-header Buffer.alloc expression');
const directDeclaredLengthAllocations = [...transportSource.matchAll(
  /Buffer\.(?:alloc|allocUnsafe)\(([^)]*)\)/g,
)].filter((match) => /declaredBodyLength/.test(match[1]));
runner.assert(directDeclaredLengthAllocations.length === 0,
  'source has no direct Buffer.alloc call whose argument names declaredBodyLength');
const sameLineDiagnosticPreviews = transportSource.split('\n').filter((line) => {
  return /throw|super\(/.test(line)
    && (/(?:body|chunk|params|request)\.(?:slice|subarray)\(/.test(line)
      || /\$\{[^}]*(?:body|chunk|params|request)[^}]*\}/.test(line));
});
runner.assert(sameLineDiagnosticPreviews.length === 0,
  'single-line throw/super expressions contain no direct payload preview expression');
runner.assert(!/\bconsole\.(?:log|warn|error)|process\.stderr\.write/.test(transportSource),
  'source contains no direct console warning/error or process.stderr.write call');

process.exit(runner.summary());
