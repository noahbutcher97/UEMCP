import net from 'node:net';
import {
  appendFile,
  mkdtemp,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isDeepStrictEqual, types } from 'node:util';
import { ConnectionManager } from './connection-manager.mjs';
import { discoverLiveSmokeScripts } from './run-live-smoke.mjs';
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
const connectionManagerUrl = new URL('./connection-manager.mjs', import.meta.url);
const claudeDocUrl = new URL('../CLAUDE.md', import.meta.url);
const architectureDocUrl = new URL('../docs/specs/architecture.md', import.meta.url);
const nativePolicySourceUrl = new URL(
  '../plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.cpp',
  import.meta.url,
);
const nativePolicyHeaderUrl = new URL(
  '../plugin/UEMCP/Source/UEMCP/Private/MCPServerTransportPolicy.h',
  import.meta.url,
);
const nativeRunnableSourceUrl = new URL(
  '../plugin/UEMCP/Source/UEMCP/Private/MCPServerRunnable.cpp',
  import.meta.url,
);
const liveTcpSmokeUrl = new URL('./live-smoke-tcp-transport.mjs', import.meta.url);
const liveAnimationSmokeUrl = new URL('./live-smoke-animation-readback.mjs', import.meta.url);
const runner = new TestRunner('TCP transport contract and Node decoder');

function extractUniqueMarkdownSection(source, headingText, headingLevel) {
  const lines = source.split(/\r?\n/);
  const exactHeading = `${'#'.repeat(headingLevel)} ${headingText}`;
  const headingIndexes = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index] === exactHeading) {
      headingIndexes.push(index);
    }
  }
  if (headingIndexes.length !== 1) {
    return { count: headingIndexes.length, section: '' };
  }

  const startIndex = headingIndexes[0];
  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const headingMatch = /^(#{1,6})\s+/.exec(lines[index]);
    if (headingMatch && headingMatch[1].length <= headingLevel) {
      endIndex = index;
      break;
    }
  }
  return {
    count: 1,
    section: lines.slice(startIndex, endIndex).join('\n'),
  };
}

function markdownBullet(section, label) {
  return section.split('\n').find((line) => line.startsWith(`- **${label}** —`)) ?? '';
}

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

function isRecursivelyFrozenJson(value) {
  const pending = [value];
  const visited = new Set();
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === null || typeof current !== 'object' || visited.has(current)) continue;
    visited.add(current);
    if (!Object.isFrozen(current)) return false;
    for (const child of Object.values(current)) pending.push(child);
  }
  return true;
}

function caughtError(fn) {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return null;
}

async function caughtAsync(fn) {
  try {
    await fn();
  } catch (error) {
    return error;
  }
  return null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bounded(promise, timeoutMs, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function startTcpServer(onConnection) {
  const sockets = new Set();
  const handlerErrors = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    Promise.resolve()
      .then(() => onConnection(socket))
      .catch((error) => {
        handlerErrors.push(error);
        socket.destroy();
      });
  });
  await bounded(new Promise((resolve, reject) => {
    const onListenError = (error) => reject(error);
    server.once('error', onListenError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onListenError);
      resolve();
    });
  }), 1000, 'server listen');

  return {
    server,
    port: server.address().port,
    handlerErrors,
    async close() {
      for (const socket of sockets) socket.destroy();
      await bounded(new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      }), 1000, 'server close');
    },
  };
}

async function writeChunks(socket, chunks, { delayMs = 0, end = true } = {}) {
  for (const chunk of chunks) {
    if (socket.destroyed) return;
    if (!socket.write(chunk)) {
      await bounded(new Promise((resolve, reject) => {
        const cleanup = () => {
          socket.off('drain', onDrain);
          socket.off('close', onClose);
          socket.off('error', onError);
        };
        const onDrain = () => { cleanup(); resolve(); };
        const onClose = () => { cleanup(); resolve(); };
        const onError = (error) => { cleanup(); reject(error); };
        socket.once('drain', onDrain);
        socket.once('close', onClose);
        socket.once('error', onError);
      }), 1000, 'socket drain');
    }
    if (delayMs > 0) await delay(delayMs);
  }
  if (end && !socket.destroyed) socket.end();
}

function connectionManagerFor(port, timeoutMs = 500, metricsEmitEveryN = 0) {
  return new ConnectionManager({
    projectRoot: '/generic/test/project',
    tcpPortCustom: port,
    httpPort: 30010,
    tcpTimeoutMs: timeoutMs,
    metricsEmitEveryN,
  });
}

async function exchangeResponse(chunks, {
  delayMs = 0,
  timeoutMs = 500,
  type = 'lifecycle_probe',
  metricsEmitEveryN = 0,
} = {}) {
  const fixture = await startTcpServer((socket) => {
    socket.once('data', () => writeChunks(socket, chunks, { delayMs }));
  });
  const manager = connectionManagerFor(fixture.port, timeoutMs, metricsEmitEveryN);
  try {
    const result = await bounded(
      manager.send('tcp-55558', type, {}, { skipCache: true }),
      Math.max(1500, timeoutMs * 5),
      `${type} exchange`,
    );
    return { result, error: null, manager, handlerErrors: fixture.handlerErrors };
  } catch (error) {
    return { result: null, error, manager, handlerErrors: fixture.handlerErrors };
  } finally {
    await fixture.close();
  }
}

function frameForBody(body) {
  const bodyBuffer = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');
  return Buffer.concat([
    Buffer.from(`Content-Length: ${bodyBuffer.length}\r\n\r\n`, 'ascii'),
    bodyBuffer,
  ]);
}

async function withClientSocketIntercept(port, configureSocket, run) {
  const originalCreateConnection = net.createConnection;
  let clientSocket = null;
  net.createConnection = function interceptedCreateConnection(options, ...args) {
    const socket = originalCreateConnection.call(this, options, ...args);
    if (options?.port === port && options?.host === '127.0.0.1') {
      clientSocket = socket;
      configureSocket(socket);
    }
    return socket;
  };
  try {
    return await run(() => clientSocket);
  } finally {
    net.createConnection = originalCreateConnection;
  }
}

function deferSocketDestroy(socket, delayMs) {
  const originalDestroy = socket.destroy.bind(socket);
  let deferredDestroyPromise = null;
  socket.destroy = function deferredSocketDestroy(...args) {
    if (deferredDestroyPromise === null) {
      deferredDestroyPromise = new Promise((resolve) => {
        setTimeout(() => {
          originalDestroy(...args);
          resolve();
        }, delayMs);
      });
    }
    return socket;
  };
  return () => deferredDestroyPromise ?? Promise.resolve();
}

function commandMetrics(manager, type) {
  return manager.getMetrics()._window.filter((entry) => entry.type === type);
}

function captureContainerStates(containers) {
  return containers.map((container) => ({
    container,
    frozen: Object.isFrozen(container),
    extensible: Object.isExtensible(container),
  }));
}

function containerStatesUnchanged(states) {
  return states.every(({ container, frozen, extensible }) => {
    return Object.isFrozen(container) === frozen
      && Object.isExtensible(container) === extensible;
  });
}

const deepJsonDepth = 5000;

function deepJsonText(depth) {
  return `{"deep":${'['.repeat(depth)}0${']'.repeat(depth)}}`;
}

function inspectDeepJsonValue(value, depth) {
  let current = value;
  let visitedContainerCount = 0;
  let frozenContainerCount = 0;
  let plainContainerCount = 0;
  for (let level = 0; level <= depth; level++) {
    visitedContainerCount++;
    if (Object.isFrozen(current)) {
      frozenContainerCount++;
    }
    if (level === 0
      ? !Array.isArray(current) && Object.getPrototypeOf(current) === Object.prototype
      : Array.isArray(current) && Object.getPrototypeOf(current) === Array.prototype) {
      plainContainerCount++;
    }
    current = level === 0 ? current.deep : current[0];
  }
  return {
    visitedContainerCount,
    frozenContainerCount,
    plainContainerCount,
    leaf: current,
  };
}

function assertInjectedParserGraphRejected(description, marker, graph) {
  const decoder = new TcpResponseDecoder({
    parseJson() {
      return graph.parsedValue;
    },
  });
  let snapshot;
  const consumeError = caughtError(() => {
    snapshot = decoder.consume(Buffer.from('{}', 'ascii'));
  });
  const snapshotText = JSON.stringify(snapshot ?? null);
  runner.assert(consumeError === null
    && snapshot?.status === 'malformed'
    && snapshot.reasonCode === 'invalid_json'
    && !snapshotText.includes(marker)
    && graph.unchanged()
    && sameJson(decoder.debugStatsForTests(), {
      legacyBytesScanned: 2,
      bodyAssemblyCount: 1,
      jsonParseCount: 1,
    }), description);
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
    runner.assert(directParseError === null
      && directInspection?.leaf === 0
      && directInspection.visitedContainerCount === deepJsonDepth + 1
      && directInspection.frozenContainerCount === 0
      && directInspection.plainContainerCount === deepJsonDepth + 1,
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
      && inspection.visitedContainerCount === deepJsonDepth + 1
      && inspection.frozenContainerCount === deepJsonDepth + 1
      && inspection.plainContainerCount === deepJsonDepth + 1
      && repeatedInspection?.leaf === 0
      && repeatedInspection.visitedContainerCount === deepJsonDepth + 1
      && repeatedInspection.frozenContainerCount === deepJsonDepth + 1
      && repeatedInspection.plainContainerCount === deepJsonDepth + 1
      && repeated === complete
      && repeated.value === complete.value
      && sameJson(decoder.debugStatsForTests(), {
        legacyBytesScanned: framing === 'legacy' ? body.length : 0,
        bodyAssemblyCount: 1,
        jsonParseCount: 1,
      }), `${framing} depth-5000 result visits and freezes exactly 5,001 plain containers`);
  }
}

{
  const parserLeaf = Object.create(null);
  parserLeaf.value = 1;
  const parserItems = [parserLeaf];
  const parserProtoValue = { inherited: false };
  const parserRoot = { nested: parserItems };
  Object.defineProperty(parserRoot, '__proto__', {
    value: parserProtoValue,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  const parserStates = captureContainerStates([
    parserRoot,
    parserItems,
    parserLeaf,
    parserProtoValue,
  ]);
  const decoder = new TcpResponseDecoder({
    parseJson() {
      return parserRoot;
    },
  });
  const complete = decoder.consume(Buffer.from('{}', 'ascii'));
  const publishedProtoDescriptor = complete.status === 'complete'
    ? Object.getOwnPropertyDescriptor(complete.value, '__proto__')
    : null;
  const publishedContainers = complete.status === 'complete'
    ? [
      complete.value,
      complete.value.nested,
      complete.value.nested[0],
      publishedProtoDescriptor?.value,
    ]
    : [];
  runner.assert(complete.status === 'complete'
    && complete.value !== parserRoot
    && complete.value.nested !== parserItems
    && complete.value.nested[0] !== parserLeaf
    && publishedProtoDescriptor?.value !== parserProtoValue
    && publishedProtoDescriptor?.enumerable === true
    && publishedProtoDescriptor.value.inherited === false
    && Object.getPrototypeOf(complete.value) === Object.prototype
    && Object.getPrototypeOf(complete.value.nested) === Array.prototype
    && Object.getPrototypeOf(complete.value.nested[0]) === Object.prototype
    && publishedContainers.every((container) => Object.isFrozen(container))
    && containerStatesUnchanged(parserStates)
    && decoder.snapshot() === complete
    && decoder.snapshot().value === complete.value
    && sameJson(decoder.debugStatsForTests(), {
      legacyBytesScanned: 2,
      bodyAssemblyCount: 1,
      jsonParseCount: 1,
    }), 'injected JSON-safe output publishes a fresh deeply frozen ordinary clone');
}

{
  const marker = 'UEMCP_PROTOTYPE_RESET_MAP_MARKER';
  const candidate = new Map([['entry', marker]]);
  candidate.visible = 'safe';
  Object.setPrototypeOf(candidate, Object.prototype);
  const root = { bad: candidate };
  const states = captureContainerStates([root, candidate]);
  assertInjectedParserGraphRejected(
    'prototype-reset Map is rejected without mutating parser-owned containers',
    marker,
    {
      parsedValue: root,
      unchanged: () => containerStatesUnchanged(states)
        && root.bad === candidate
        && candidate.visible === 'safe',
    },
  );
}

{
  const marker = 'UEMCP_PROTOTYPE_RESET_DATE_MARKER';
  const candidate = new Date(0);
  candidate.visible = marker;
  Object.setPrototypeOf(candidate, Object.prototype);
  const root = { bad: candidate };
  const states = captureContainerStates([root, candidate]);
  assertInjectedParserGraphRejected(
    'prototype-reset Date is rejected without mutating parser-owned containers',
    marker,
    {
      parsedValue: root,
      unchanged: () => containerStatesUnchanged(states)
        && root.bad === candidate
        && candidate.visible === marker,
    },
  );
}

{
  const marker = 'UEMCP_PROTOTYPE_RESET_TYPED_ARRAY_MARKER';
  const bad = new Uint8Array([1, 2]);
  bad.visible = marker;
  Object.setPrototypeOf(bad, Object.prototype);
  const good = { value: 'unchanged' };
  const root = { bad, good };
  const states = captureContainerStates([root, bad, good]);
  assertInjectedParserGraphRejected(
    'nonempty prototype-reset typed array rejects the whole bad-good graph without partial freezing',
    marker,
    {
      parsedValue: root,
      unchanged: () => containerStatesUnchanged(states)
        && root.bad === bad
        && root.good === good
        && good.value === 'unchanged'
        && bad[0] === 1
        && bad[1] === 2
        && bad.visible === marker,
    },
  );
}

{
  const marker = 'UEMCP_PRIVATE_STATE_MARKER';
  class PrivateStateCarrier {
    #hidden;

    constructor(hidden) {
      this.#hidden = hidden;
      this.visible = 'safe';
    }

    reveal() {
      return this.#hidden;
    }
  }

  const candidate = new PrivateStateCarrier(marker);
  Object.setPrototypeOf(candidate, Object.prototype);
  const root = { candidate };
  const states = captureContainerStates([root, candidate]);
  const decoder = new TcpResponseDecoder({
    parseJson() {
      return root;
    },
  });
  const complete = decoder.consume(Buffer.from('{}', 'ascii'));
  const hiddenStateRead = complete.status === 'complete'
    ? caughtError(() => PrivateStateCarrier.prototype.reveal.call(complete.value.candidate))
    : null;
  runner.assert(complete.status === 'complete'
    && complete.value !== root
    && complete.value.candidate !== candidate
    && Object.getPrototypeOf(complete.value) === Object.prototype
    && Object.getPrototypeOf(complete.value.candidate) === Object.prototype
    && Reflect.ownKeys(complete.value.candidate).length === 1
    && complete.value.candidate.visible === 'safe'
    && Object.isFrozen(complete.value)
    && Object.isFrozen(complete.value.candidate)
    && hiddenStateRead instanceof TypeError
    && PrivateStateCarrier.prototype.reveal.call(candidate) === marker
    && !JSON.stringify(complete).includes(marker)
    && containerStatesUnchanged(states)
    && decoder.snapshot() === complete
    && sameJson(decoder.debugStatsForTests(), {
      legacyBytesScanned: 2,
      bodyAssemblyCount: 1,
      jsonParseCount: 1,
    }), 'prototype-reset private-state instance publishes only a fresh plain JSON clone');
}

{
  const rejectedShapeCases = [
    {
      name: 'enumerable accessor',
      build(marker) {
        let getterCalls = 0;
        const root = {};
        Object.defineProperty(root, 'bad', {
          enumerable: true,
          get() {
            getterCalls++;
            return marker;
          },
        });
        const states = captureContainerStates([root]);
        return {
          parsedValue: root,
          unchanged: () => getterCalls === 0 && containerStatesUnchanged(states),
        };
      },
    },
    {
      name: 'symbol-keyed property',
      build(marker) {
        const key = Symbol(marker);
        const root = { visible: 'safe' };
        root[key] = marker;
        const states = captureContainerStates([root]);
        return {
          parsedValue: root,
          unchanged: () => root[key] === marker && containerStatesUnchanged(states),
        };
      },
    },
    {
      name: 'non-enumerable data property',
      build(marker) {
        const root = {};
        Object.defineProperty(root, 'bad', { value: marker });
        const states = captureContainerStates([root]);
        return {
          parsedValue: root,
          unchanged: () => root.bad === marker && containerStatesUnchanged(states),
        };
      },
    },
    {
      name: 'sparse array',
      build(marker) {
        const child = { value: marker };
        const sparse = new Array(2);
        sparse[1] = child;
        const root = { sparse };
        const states = captureContainerStates([root, sparse, child]);
        return {
          parsedValue: root,
          unchanged: () => !(0 in sparse)
            && sparse[1] === child
            && child.value === marker
            && containerStatesUnchanged(states),
        };
      },
    },
  ];

  for (const { name, build } of rejectedShapeCases) {
    const marker = `UEMCP_${name.replaceAll(/[^A-Za-z]/g, '_')}_MARKER`;
    assertInjectedParserGraphRejected(
      `injected ${name} is rejected without access or parser-graph mutation`,
      marker,
      build(marker),
    );
  }

  const rejectedPrimitiveCases = [
    ['NaN', Number.NaN],
    ['positive infinity', Number.POSITIVE_INFINITY],
    ['undefined', undefined],
    ['function', function invalidJsonFunction() {}],
    ['bigint', 1n],
  ];
  for (const [name, bad] of rejectedPrimitiveCases) {
    const marker = `UEMCP_${name.replaceAll(/[^A-Za-z]/g, '_')}_MARKER`;
    const root = { marker, bad };
    const states = captureContainerStates([root]);
    assertInjectedParserGraphRejected(
      `injected ${name} value is rejected without parser-graph mutation`,
      marker,
      {
        parsedValue: root,
        unchanged: () => root.marker === marker
          && Object.is(root.bad, bad)
          && containerStatesUnchanged(states),
      },
    );
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
  const proxyCases = [
    {
      name: 'ownKeys-throwing proxy',
      build(marker) {
        const child = { value: marker };
        const target = { child };
        let trapCalls = 0;
        const candidate = new Proxy(target, {
          ownKeys() {
            trapCalls++;
            throw new Error(`ownKeys trap: ${marker}`);
          },
        });
        const root = { candidate };
        return {
          parsedValue: root,
          unchanged: () => trapCalls === 0
            && root.candidate === candidate
            && target.child === child
            && child.value === marker
            && !Object.isFrozen(root)
            && !Object.isFrozen(target)
            && !Object.isFrozen(child),
        };
      },
    },
    {
      name: 'getPrototypeOf-throwing proxy',
      build(marker) {
        const child = { value: marker };
        const target = { child };
        let trapCalls = 0;
        const candidate = new Proxy(target, {
          getPrototypeOf() {
            trapCalls++;
            throw new Error(`getPrototypeOf trap: ${marker}`);
          },
        });
        const root = { candidate };
        return {
          parsedValue: root,
          unchanged: () => trapCalls === 0
            && target.child === child
            && child.value === marker
            && !Object.isFrozen(root)
            && !Object.isFrozen(target)
            && !Object.isFrozen(child),
        };
      },
    },
    {
      name: 'descriptor-throwing proxy',
      build(marker) {
        const child = { value: marker };
        const target = { child };
        let trapCalls = 0;
        const candidate = new Proxy(target, {
          getOwnPropertyDescriptor() {
            trapCalls++;
            throw new Error(`descriptor trap: ${marker}`);
          },
        });
        const root = { candidate };
        return {
          parsedValue: root,
          unchanged: () => trapCalls === 0
            && target.child === child
            && child.value === marker
            && !Object.isFrozen(root)
            && !Object.isFrozen(target)
            && !Object.isFrozen(child),
        };
      },
    },
    {
      name: 'freeze-throwing proxy',
      build(marker) {
        const child = { value: marker };
        const sibling = { value: 'unchanged' };
        const target = { child };
        let trapCalls = 0;
        const candidate = new Proxy(target, {
          preventExtensions() {
            trapCalls++;
            throw new Error(`freeze trap: ${marker}`);
          },
        });
        const root = { candidate, sibling };
        return {
          parsedValue: root,
          unchanged: () => trapCalls === 0
            && target.child === child
            && child.value === marker
            && sibling.value === 'unchanged'
            && !Object.isFrozen(root)
            && !Object.isFrozen(target)
            && !Object.isFrozen(child)
            && !Object.isFrozen(sibling),
        };
      },
    },
    {
      name: 'revoked array proxy',
      build(marker) {
        const child = { value: marker };
        const target = [child];
        const revocable = Proxy.revocable(target, {});
        revocable.revoke();
        return {
          parsedValue: revocable.proxy,
          proxyDetectedAfterRevocation: types.isProxy(revocable.proxy),
          unchanged: () => target[0] === child
            && child.value === marker
            && !Object.isFrozen(target)
            && !Object.isFrozen(child),
        };
      },
    },
  ];

  for (const caseData of proxyCases) {
    const marker = `UEMCP_${caseData.name.replaceAll(/[^A-Za-z]/g, '_')}_SECRET`;
    const graph = caseData.build(marker);
    if (Object.hasOwn(graph, 'proxyDetectedAfterRevocation')) {
      runner.assert(graph.proxyDetectedAfterRevocation,
        'node:util types.isProxy identifies a revoked proxy without invoking its traps');
    }
    assertInjectedParserGraphRejected(
      `injected ${caseData.name} returns marker-free invalid_json without traps or mutation`,
      marker,
      graph,
    );
  }
}

{
  class JsonArraySubclass extends Array {}
  const marker = 'UEMCP_ARRAY_SUBCLASS_SECRET';
  const child = { value: marker };
  const candidate = new JsonArraySubclass(child);
  const root = { candidate };
  assertInjectedParserGraphRejected(
    'injected array subclass is rejected without freezing or exposing parser-owned data',
    marker,
    {
      parsedValue: root,
      unchanged: () => root.candidate === candidate
        && candidate[0] === child
        && child.value === marker
        && !Object.isFrozen(root)
        && !Object.isFrozen(candidate)
        && !Object.isFrozen(child),
    },
  );
}

{
  const marker = 'UEMCP_CUSTOM_ARRAY_PROTOTYPE_SECRET';
  const child = { value: marker };
  const candidate = [child];
  const customPrototype = Object.create(Array.prototype);
  Object.setPrototypeOf(candidate, customPrototype);
  const root = { candidate };
  assertInjectedParserGraphRejected(
    'injected array with a custom prototype is rejected without freezing parser-owned data',
    marker,
    {
      parsedValue: root,
      unchanged: () => Object.getPrototypeOf(candidate) === customPrototype
        && candidate[0] === child
        && child.value === marker
        && !Object.isFrozen(root)
        && !Object.isFrozen(candidate)
        && !Object.isFrozen(child),
    },
  );
}

{
  const marker = 'UEMCP_SHARED_CHILD_SECRET';
  const sharedChild = { value: marker };
  const root = { left: sharedChild, right: sharedChild };
  assertInjectedParserGraphRejected(
    'injected acyclic shared reference is rejected without freezing parser-owned data',
    marker,
    {
      parsedValue: root,
      unchanged: () => root.left === sharedChild
        && root.right === sharedChild
        && sharedChild.value === marker
        && !Object.isFrozen(root)
        && !Object.isFrozen(sharedChild),
    },
  );
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
    legacyBytesScanned: 9, bodyAssemblyCount: 1, jsonParseCount: 1,
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
  const snapshot = decoder.consume(Buffer.from('Content-Length: 9\r\n\r\n{"x":tru}', 'ascii'));
  runner.assert(snapshot.reasonCode === 'invalid_json' && injectedParseCount === 1
    && sameJson(decoder.debugStatsForTests(), {
      legacyBytesScanned: 0, bodyAssemblyCount: 1, jsonParseCount: 1,
  }), 'invalid framed JSON candidate assembles and parses exactly once');
}

{
  let injectedParseCount = 0;
  const decoder = new TcpResponseDecoder({
    parseJson(text) {
      injectedParseCount++;
      return JSON.parse(text);
    },
  });
  const snapshot = decoder.consume(Buffer.concat([
    Buffer.from('Content-Length: 2\r\n\r\n1', 'ascii'),
    Buffer.from([0]),
  ]));
  runner.assert(snapshot.reasonCode === 'invalid_json' && injectedParseCount === 1
    && sameJson(decoder.debugStatsForTests(), {
      legacyBytesScanned: 0, bodyAssemblyCount: 1, jsonParseCount: 1,
    }), 'framed scalar-like raw NUL is invalid JSON and parses once');
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

{
  const allowedFields = [
    'direction',
    'framing',
    'bytesReceived',
    'declaredBodyLength',
    'bodyBytes',
    'maxBodyBytes',
    'timeoutMs',
    'timeoutKind',
    'parserCategory',
    'nativeCode',
  ];
  const suppliedDetails = {
    direction: 'response',
    framing: 'framed',
    bytesReceived: 12,
    declaredBodyLength: 20,
    bodyBytes: 8,
    maxBodyBytes: 32,
    timeoutMs: 10000,
    timeoutKind: 'absolute',
    parserCategory: 'invalid_json',
    nativeCode: 'ECONNRESET',
  };
  const descriptorReads = [];
  const originalGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  let error;
  let constructionError;
  try {
    Object.getOwnPropertyDescriptor = function instrumentedDescriptor(target, key) {
      if (target === suppliedDetails) {
        descriptorReads.push(key);
      }
      return originalGetOwnPropertyDescriptor(target, key);
    };
    constructionError = caughtError(() => {
      error = new TcpTransportError('SOCKET_ERROR', 55558, suppliedDetails);
    });
  } finally {
    Object.getOwnPropertyDescriptor = originalGetOwnPropertyDescriptor;
  }
  runner.assert(constructionError === null
    && sameJson(descriptorReads, allowedFields)
    && sameJson(error.details, suppliedDetails),
  'typed transport details inspect each allowlisted own descriptor exactly once');
}

{
  const marker = 'UEMCP_THROWING_DETAIL_GETTER_MARKER';
  let getterCalls = 0;
  const suppliedDetails = {};
  Object.defineProperty(suppliedDetails, 'nativeCode', {
    enumerable: true,
    get() {
      getterCalls++;
      throw new Error(marker);
    },
  });
  let error;
  const constructionError = caughtError(() => {
    error = new TcpTransportError('SOCKET_ERROR', 55558, suppliedDetails);
  });
  runner.assert(constructionError === null
    && getterCalls === 0
    && sameJson(error.details, {})
    && !error.message.includes(marker)
    && !JSON.stringify(error.details).includes(marker),
  'typed transport details skip throwing accessors without invoking or retaining them');
}

{
  const marker = 'UEMCP_STATEFUL_DETAIL_GETTER_MARKER';
  const mutableInjection = { marker };
  let getterCalls = 0;
  const suppliedDetails = {};
  Object.defineProperty(suppliedDetails, 'nativeCode', {
    enumerable: true,
    get() {
      getterCalls++;
      return getterCalls === 1 ? 'ECONNRESET' : mutableInjection;
    },
  });
  const error = new TcpTransportError('SOCKET_ERROR', 55558, suppliedDetails);
  runner.assert(getterCalls === 0
    && sameJson(error.details, {})
    && Object.isExtensible(mutableInjection)
    && !Object.isFrozen(mutableInjection)
    && !error.message.includes(marker)
    && !JSON.stringify(error.details).includes(marker),
  'typed transport details cannot admit mutable data through a stateful accessor');
}

{
  const marker = 'UEMCP_UNSAFE_DETAIL_DATA_MARKER';
  const mutableValue = { marker };
  const suppliedDetails = {
    nativeCode: mutableValue,
    bytesReceived: Number.NaN,
    declaredBodyLength: Number.POSITIVE_INFINITY,
    timeoutMs: 1n,
  };
  const error = new TcpTransportError('SOCKET_ERROR', 55558, suppliedDetails);
  runner.assert(sameJson(error.details, {})
    && Object.isExtensible(mutableValue)
    && !Object.isFrozen(mutableValue)
    && !error.message.includes(marker)
    && !JSON.stringify(error.details).includes(marker),
  'typed transport details reject unsafe allowlisted data values without retaining references');
}

{
  const marker = 'UEMCP_DETAIL_PROXY_MARKER';
  let trapCalls = 0;
  const target = { nativeCode: marker };
  const suppliedDetails = new Proxy(target, {
    getOwnPropertyDescriptor() {
      trapCalls++;
      throw new Error(marker);
    },
  });
  let error;
  const constructionError = caughtError(() => {
    error = new TcpTransportError('SOCKET_ERROR', 55558, suppliedDetails);
  });
  runner.assert(constructionError === null
    && trapCalls === 0
    && sameJson(error.details, {})
    && target.nativeCode === marker
    && Object.isExtensible(target)
    && !error.message.includes(marker),
  'typed transport details reject proxies before invoking descriptor traps');
}

{
  const marker = 'UEMCP_REVOKED_DETAIL_PROXY_MARKER';
  const target = { nativeCode: marker };
  const revocable = Proxy.revocable(target, {});
  revocable.revoke();
  let error;
  const constructionError = caughtError(() => {
    error = new TcpTransportError('SOCKET_ERROR', 55558, revocable.proxy);
  });
  runner.assert(types.isProxy(revocable.proxy)
    && constructionError === null
    && sameJson(error.details, {})
    && target.nativeCode === marker
    && Object.isExtensible(target)
    && !error.message.includes(marker),
  'typed transport details reject revoked proxies without throwing or retaining marker text');
}

const lifecycleFailures = [];

{
  const type = 'sized';
  const limit = TCP_MAX_REQUEST_BODY_BYTES;
  const baseBytes = Buffer.byteLength(JSON.stringify({ type, params: { padding: '' } }));
  const exactPadding = 'x'.repeat(limit - baseBytes);
  let connectionCount = 0;
  let boundedBodyAssemblyCount = 0;
  let declaredBodyLength = null;
  let receivedBodyLength = 0;
  let requestBody = null;
  const fixture = await startTcpServer((socket) => {
    connectionCount++;
    const headerScratch = Buffer.alloc(TCP_MAX_HEADER_BYTES);
    const terminator = Buffer.from('\r\n\r\n', 'ascii');
    let headerBytes = 0;
    let terminatorBytes = 0;
    let bodyBuffer = null;
    let responseSent = false;
    socket.on('data', (chunk) => {
      let offset = 0;
      if (bodyBuffer === null) {
        while (offset < chunk.length && bodyBuffer === null) {
          if (headerBytes === headerScratch.length) {
            socket.destroy();
            return;
          }
          const byte = chunk[offset];
          offset++;
          headerScratch[headerBytes] = byte;
          headerBytes++;
          if (byte === terminator[terminatorBytes]) {
            terminatorBytes++;
          } else {
            terminatorBytes = byte === terminator[0] ? 1 : 0;
          }
          if (terminatorBytes !== terminator.length) continue;

          const header = headerScratch.subarray(0, headerBytes - terminator.length).toString('ascii');
          const match = /^Content-Length: ([0-9]+)$/.exec(header);
          if (!match) {
            socket.destroy();
            return;
          }
          declaredBodyLength = Number(match[1]);
          if (!Number.isSafeInteger(declaredBodyLength)
            || declaredBodyLength < 0
            || declaredBodyLength > TCP_MAX_REQUEST_BODY_BYTES) {
            socket.destroy();
            return;
          }
          bodyBuffer = Buffer.allocUnsafe(declaredBodyLength);
          boundedBodyAssemblyCount++;
        }
      }
      if (bodyBuffer === null) return;

      const remaining = declaredBodyLength - receivedBodyLength;
      const bytesToCopy = Math.min(remaining, chunk.length - offset);
      chunk.copy(bodyBuffer, receivedBodyLength, offset, offset + bytesToCopy);
      receivedBodyLength += bytesToCopy;
      if (offset + bytesToCopy !== chunk.length) {
        socket.destroy();
        return;
      }
      if (!responseSent && receivedBodyLength === declaredBodyLength) {
        responseSent = true;
        requestBody = bodyBuffer;
        socket.end(frameForBody('{"status":"success","accepted":true}'));
      }
    });
  });
  try {
    const manager = connectionManagerFor(fixture.port, 3000);
    const result = await bounded(manager.send(
      'tcp-55558',
      type,
      { padding: exactPadding },
      { skipCache: true },
    ), 5000, 'exact-limit request');
    runner.assert(result?.accepted === true,
      'exact 8 MiB request resolves through the production TCP path');
    runner.assert(connectionCount === 1
      && declaredBodyLength === limit
      && receivedBodyLength === limit
      && requestBody?.length === limit,
    'exact 8 MiB request connects and writes one complete declared body');
    runner.assert(requestBody?.subarray(0, 32).toString('ascii').startsWith('{"type":"sized"')
      && requestBody?.subarray(-4).toString('ascii') === 'x"}}',
    'exact-limit wire body retains the expected generic serialized envelope');
    runner.assert(boundedBodyAssemblyCount === 1,
      'exact-limit fixture uses one bounded body assembly for all data events');
  } finally {
    await fixture.close();
  }

  let overLimitConnections = 0;
  const overLimitFixture = await startTcpServer((socket) => {
    overLimitConnections++;
    socket.destroy();
  });
  let overLimitError;
  try {
    const manager = connectionManagerFor(overLimitFixture.port, 250);
    overLimitError = await caughtAsync(() => bounded(manager.send(
      'tcp-55558',
      type,
      { padding: 'x'.repeat(limit + 1 - baseBytes) },
      { skipCache: true },
    ), 1000, 'over-limit request'));
    await delay(50);
  } finally {
    await overLimitFixture.close();
  }
  lifecycleFailures.push(['over-limit request', 'REQUEST_TOO_LARGE', overLimitError]);
  runner.assert(overLimitError?.code === 'REQUEST_TOO_LARGE'
    && overLimitError.details?.bodyBytes === limit + 1,
  '8 MiB plus one maps to REQUEST_TOO_LARGE with exact byte metadata');
  runner.assert(overLimitConnections === 0,
    'over-limit preflight creates zero TCP connections');
}

{
  const framedBody = JSON.stringify({ status: 'success', value: '\ud83d\ude00', nested: { ok: true } });
  const framedBytes = frameForBody(framedBody);
  const framed = await exchangeResponse(
    [...framedBytes].map((byte) => Buffer.from([byte])),
    { delayMs: 1, timeoutMs: 3000, type: 'fragmented_framed' },
  );
  runner.assert(framed.error === null
    && framed.result?.value === '\ud83d\ude00'
    && framed.handlerErrors.length === 0,
  'fragmented framed response completes across prefix, header, UTF-8, and body splits');

  const legacyBody = Buffer.from('{"status":"success","text":"}\\\"{","items":[{"ok":true}]}', 'utf8');
  const legacy = await exchangeResponse(
    [...legacyBody].map((byte) => Buffer.from([byte])),
    { delayMs: 1, timeoutMs: 3000, type: 'fragmented_legacy' },
  );
  runner.assert(legacy.error === null
    && legacy.result?.items?.[0]?.ok === true
    && legacy.handlerErrors.length === 0,
  'fragmented legacy response completes across delimiter, string, and escape splits');
}

{
  const noResponse = await exchangeResponse([], { type: 'no_response' });
  lifecycleFailures.push(['empty close', 'NO_RESPONSE', noResponse.error]);
  runner.assert(noResponse.error?.code === 'NO_RESPONSE'
    && noResponse.error.details?.bytesReceived === 0,
  'clean close with zero response bytes maps to NO_RESPONSE');

  const incompleteCases = [
    ['prefix', Buffer.from('Cont', 'ascii'), 'undecided'],
    ['header', Buffer.from('Content-Length: 20\r\n', 'ascii'), 'framed'],
    ['framed body', Buffer.from('Content-Length: 20\r\n\r\n{"status":', 'ascii'), 'framed'],
    ['legacy object', Buffer.from('{"status":', 'ascii'), 'legacy'],
    ['partial BOM', Buffer.from([0xef, 0xbb]), 'legacy'],
    ['legacy UTF-8', Buffer.concat([Buffer.from('{"value":"', 'ascii'), Buffer.from([0xe2])]), 'legacy'],
    ['framed UTF-8', Buffer.concat([
      Buffer.from('Content-Length: 20\r\n\r\n{"value":"', 'ascii'),
      Buffer.from([0xe2]),
    ]), 'framed'],
  ];
  for (const [name, bytes, framing] of incompleteCases) {
    const exchange = await exchangeResponse([bytes], { type: `incomplete_${name.replace(' ', '_')}` });
    lifecycleFailures.push([`incomplete ${name}`, 'INCOMPLETE_RESPONSE', exchange.error]);
    runner.assert(exchange.error?.code === 'INCOMPLETE_RESPONSE'
      && exchange.error.details?.framing === framing
      && exchange.error.details?.bytesReceived === bytes.length,
    `close during ${name} maps to INCOMPLETE_RESPONSE with progress`);
  }
}

{
  const malformedCases = [
    ['header', Buffer.from('Content-Length: +2\r\n\r\n{}', 'ascii'), 'invalid_content_length'],
    ['UTF-8', frameForBody(Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0xc0, 0xaf, 0x7d])), 'invalid_utf8'],
    ['JSON', Buffer.from('{"status":"UEMCP_SECRET_PAYLOAD_SENTINEL",}', 'ascii'), 'invalid_json'],
    ['root array', Buffer.from('[1,2,3]', 'ascii'), 'root_not_object'],
    ['root scalar', Buffer.from('true', 'ascii'), 'root_not_object'],
    ['trailing bytes', Buffer.from('Content-Length: 2\r\n\r\n{}x', 'ascii'), 'trailing_bytes'],
  ];
  for (const [name, bytes, parserCategory] of malformedCases) {
    const exchange = await exchangeResponse([bytes], { type: `malformed_${name.replace(' ', '_')}` });
    lifecycleFailures.push([`malformed ${name}`, 'MALFORMED_RESPONSE', exchange.error]);
    runner.assert(exchange.error?.code === 'MALFORMED_RESPONSE'
      && exchange.error.details?.parserCategory === parserCategory,
    `malformed ${name} maps to MALFORMED_RESPONSE/${parserCategory}`);
  }
}

{
  const resetFixture = await startTcpServer((socket) => {
    socket.once('data', () => {
      if (typeof socket.resetAndDestroy === 'function') socket.resetAndDestroy();
      else socket.destroy();
    });
  });
  let resetError;
  try {
    resetError = await caughtAsync(() => bounded(
      connectionManagerFor(resetFixture.port, 500).send(
        'tcp-55558', 'reset_probe', {}, { skipCache: true },
      ),
      1500,
      'reset response',
    ));
  } finally {
    await resetFixture.close();
  }
  lifecycleFailures.push(['reset', 'SOCKET_ERROR', resetError]);
  runner.assert(resetError?.code === 'SOCKET_ERROR'
    && resetError.details?.nativeCode === 'ECONNRESET',
  'peer reset maps to SOCKET_ERROR and preserves ECONNRESET');

  const refusedReservation = await startTcpServer(() => {});
  const refusedPort = refusedReservation.port;
  await refusedReservation.close();
  const refusedError = await caughtAsync(() => bounded(
    connectionManagerFor(refusedPort, 500).send(
      'tcp-55558', 'refusal_probe', {}, { skipCache: true },
    ),
    1500,
    'connection refusal',
  ));
  lifecycleFailures.push(['refusal', 'SOCKET_ERROR', refusedError]);
  runner.assert(refusedError?.code === 'SOCKET_ERROR'
    && refusedError.details?.nativeCode === 'ECONNREFUSED'
    && !refusedError.message.includes('ECONNREFUSED'),
  'connection refusal keeps ECONNREFUSED only in sanitized details');

  const writeFixture = await startTcpServer(() => {});
  const originalWrite = net.Socket.prototype.write;
  let writeError;
  try {
    net.Socket.prototype.write = function injectedWriteFailure(chunk, ...args) {
      if (this.remotePort === writeFixture.port && Buffer.isBuffer(chunk)) {
        const callback = args.find((arg) => typeof arg === 'function');
        const error = new Error('UEMCP_SECRET_WRITE_FAILURE');
        error.code = 'EPIPE';
        if (callback) queueMicrotask(() => callback(error));
        return true;
      }
      return originalWrite.call(this, chunk, ...args);
    };
    writeError = await caughtAsync(() => bounded(
      connectionManagerFor(writeFixture.port, 150).send(
        'tcp-55558', 'write_failure_probe', {}, { skipCache: true },
      ),
      1000,
      'request write failure',
    ));
  } finally {
    net.Socket.prototype.write = originalWrite;
    await writeFixture.close();
  }
  lifecycleFailures.push(['write failure', 'SOCKET_ERROR', writeError]);
  runner.assert(writeError?.code === 'SOCKET_ERROR'
    && writeError.details?.nativeCode === 'EPIPE'
    && !writeError.message.includes('EPIPE')
    && !writeError.message.includes('UEMCP_SECRET_WRITE_FAILURE'),
  'request-write failure maps to SOCKET_ERROR with native code only in details');
}

{
  const timeoutMs = 120;
  const fixture = await startTcpServer((socket) => {
    socket.once('data', () => {
      socket.write('{');
      const interval = setInterval(() => {
        if (!socket.destroyed) socket.write(' ');
      }, 25);
      const stop = setTimeout(() => {
        clearInterval(interval);
        if (!socket.destroyed) socket.end();
      }, 400);
      socket.once('close', () => {
        clearInterval(interval);
        clearTimeout(stop);
      });
    });
  });
  const startedAt = Date.now();
  let timeoutError;
  try {
    timeoutError = await caughtAsync(() => bounded(
      connectionManagerFor(fixture.port, timeoutMs).send(
        'tcp-55558', 'trickle_probe', {}, { skipCache: true },
      ),
      1000,
      'absolute response deadline',
    ));
  } finally {
    await fixture.close();
  }
  const elapsedMs = Date.now() - startedAt;
  lifecycleFailures.push(['trickle timeout', 'RESPONSE_TIMEOUT', timeoutError]);
  runner.assert(timeoutError?.code === 'RESPONSE_TIMEOUT'
    && timeoutError.details?.timeoutMs === timeoutMs
    && timeoutError.details?.timeoutKind === 'absolute',
  'one-byte trickle maps to absolute RESPONSE_TIMEOUT');
  runner.assert(elapsedMs >= timeoutMs - 25 && elapsedMs < 300,
    'trickle cannot extend the absolute caller deadline', `elapsed ${elapsedMs}ms`);
}

{
  const type = 'inactivity_timeout_race';
  const fixture = await startTcpServer((socket) => {
    socket.once('data', () => {});
  });
  let clientSocket = null;
  let manager;
  let timeoutError;
  try {
    await withClientSocketIntercept(fixture.port, (socket) => {
      clientSocket = socket;
      const originalSetTimeout = socket.setTimeout.bind(socket);
      socket.setTimeout = function injectedInactivityTimeout(timeout, ...args) {
        return originalSetTimeout(timeout > 0 ? 15 : timeout, ...args);
      };
    }, async () => {
      manager = connectionManagerFor(fixture.port, 250, 100);
      timeoutError = await caughtAsync(() => bounded(manager.send(
        'tcp-55558', type, {}, { skipCache: true },
      ), 1000, 'inactivity timeout race'));
    });
    await delay(30);
  } finally {
    await fixture.close();
  }
  lifecycleFailures.push(['inactivity timeout', 'RESPONSE_TIMEOUT', timeoutError]);
  runner.assert(timeoutError?.code === 'RESPONSE_TIMEOUT'
    && timeoutError.details?.timeoutKind === 'inactivity',
  'socket inactivity event maps to RESPONSE_TIMEOUT/inactivity');
  runner.assert(clientSocket?.destroyed === true
    && commandMetrics(manager, type).length === 1,
  'inactivity timeout settles once, destroys its socket, and records one metric');
}

{
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on('warning', onWarning);
  try {
    for (let iteration = 0; iteration < 3; iteration++) {
      const timeoutMs = 60;
      const type = `absolute_terminal_race_${iteration}`;
      let serverSocket = null;
      let trickleInterval = null;
      const fixture = await startTcpServer((socket) => {
        serverSocket = socket;
        socket.once('data', () => {
          socket.write('{');
          trickleInterval = setInterval(() => {
            if (!socket.destroyed) socket.write(' ');
          }, 8);
          socket.once('close', () => {
            clearInterval(trickleInterval);
          });
        });
      });
      let clientSocket = null;
      let clientClosePromise = null;
      let waitForDeferredDestroy = () => Promise.resolve();
      let manager;
      let timeoutError;
      try {
        await withClientSocketIntercept(fixture.port, (socket) => {
          clientSocket = socket;
          clientClosePromise = new Promise((resolve) => socket.once('close', resolve));
          waitForDeferredDestroy = deferSocketDestroy(socket, 45);
        }, async () => {
          manager = connectionManagerFor(fixture.port, timeoutMs, 100);
          timeoutError = await caughtAsync(() => bounded(manager.send(
            'tcp-55558', type, {}, { skipCache: true },
          ), 1000, `absolute terminal race ${iteration}`));
        });
        clearInterval(trickleInterval);
        if (serverSocket && !serverSocket.destroyed) {
          if (typeof serverSocket.resetAndDestroy === 'function') serverSocket.resetAndDestroy();
          else serverSocket.destroy();
        }
        await bounded(Promise.all([
          clientClosePromise,
          waitForDeferredDestroy(),
        ]), 500, `absolute race cleanup ${iteration}`);
      } finally {
        clearInterval(trickleInterval);
        await fixture.close();
      }
      lifecycleFailures.push([type, 'RESPONSE_TIMEOUT', timeoutError]);
      runner.assert(timeoutError?.code === 'RESPONSE_TIMEOUT'
        && timeoutError.details?.timeoutKind === 'absolute'
        && commandMetrics(manager, type).length === 1,
      `absolute timeout wins trickle/reset race exactly once [${iteration}]`);
      runner.assert(clientSocket?.destroyed === true
        && clientSocket.listenerCount('timeout') === 0
        && clientSocket.listenerCount('error') === 0,
      `absolute timeout race cleans client listeners [${iteration}]`);
    }
  } finally {
    process.off('warning', onWarning);
  }
  runner.assert(warnings.length === 0,
    'repeated absolute timeout races emit no process warnings');
}

{
  const scenarios = [
    {
      name: 'malformed',
      response: frameForBody('{"status":}'),
      expectedCode: 'MALFORMED_RESPONSE',
    },
    {
      name: 'complete',
      response: frameForBody('{"status":"success","winner":{"deep":true}}'),
      expectedCode: null,
    },
  ];
  for (const scenario of scenarios) {
    for (let iteration = 0; iteration < 3; iteration++) {
      const type = `${scenario.name}_decoder_race_${iteration}`;
      let serverSocket = null;
      const fixture = await startTcpServer((socket) => {
        serverSocket = socket;
        socket.once('data', () => {
          socket.write(scenario.response);
        });
      });
      let manager;
      let clientClosePromise = null;
      let waitForDeferredDestroy = () => Promise.resolve();
      let result = null;
      let commandError = null;
      try {
        await withClientSocketIntercept(fixture.port, (socket) => {
          clientClosePromise = new Promise((resolve) => socket.once('close', resolve));
          waitForDeferredDestroy = deferSocketDestroy(socket, 40);
        }, async () => {
          manager = connectionManagerFor(fixture.port, 300, 100);
          try {
            result = await bounded(manager.send(
              'tcp-55558', type, {}, { skipCache: true },
            ), 1000, `${scenario.name} decoder race ${iteration}`);
          } catch (error) {
            commandError = error;
          }
        });
        if (serverSocket && !serverSocket.destroyed) {
          if (typeof serverSocket.resetAndDestroy === 'function') serverSocket.resetAndDestroy();
          else serverSocket.destroy();
        }
        await bounded(Promise.all([
          clientClosePromise,
          waitForDeferredDestroy(),
        ]), 500, `${scenario.name} race cleanup ${iteration}`);
      } finally {
        await fixture.close();
      }
      const metrics = commandMetrics(manager, type);
      if (scenario.expectedCode) {
        lifecycleFailures.push([type, scenario.expectedCode, commandError]);
        runner.assert(commandError?.code === scenario.expectedCode
          && metrics.length === 1 && metrics[0].ok === false,
        `malformed decoder result survives later reset/close [${iteration}]`);
      } else {
        runner.assert(commandError === null
          && result?.winner?.deep === true
          && isRecursivelyFrozenJson(result)
          && metrics.length === 1 && metrics[0].ok === true,
        `complete decoder result survives later reset/close [${iteration}]`);
      }
    }
  }
}

{
  const type = 'late_error_after_timeout_cleanup';
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  const fixture = await startTcpServer((socket) => {
    socket.once('data', () => {});
  });
  process.on('warning', onWarning);
  let clientSocket = null;
  let clientClosePromise = null;
  let waitForDeferredDestroy = () => Promise.resolve();
  let manager;
  let timeoutError;
  let lateEmitError = null;
  try {
    await withClientSocketIntercept(fixture.port, (socket) => {
      clientSocket = socket;
      clientClosePromise = new Promise((resolve) => socket.once('close', resolve));
      waitForDeferredDestroy = deferSocketDestroy(socket, 50);
    }, async () => {
      manager = connectionManagerFor(fixture.port, 35, 100);
      timeoutError = await caughtAsync(() => bounded(manager.send(
        'tcp-55558', type, {}, { skipCache: true },
      ), 1000, 'late socket error cleanup'));
      const lateError = new Error('UEMCP_SECRET_LATE_SOCKET_ERROR');
      lateError.code = 'ECONNRESET';
      lateEmitError = caughtError(() => clientSocket.emit('error', lateError));
    });
    await bounded(Promise.all([
      clientClosePromise,
      waitForDeferredDestroy(),
    ]), 500, 'late error cleanup');
  } finally {
    process.off('warning', onWarning);
    await fixture.close();
  }
  lifecycleFailures.push(['late socket error timeout', 'RESPONSE_TIMEOUT', timeoutError]);
  const activeHandles = typeof process._getActiveHandles === 'function'
    ? process._getActiveHandles()
    : [];
  runner.assert(timeoutError?.code === 'RESPONSE_TIMEOUT'
    && timeoutError.details?.timeoutKind === 'absolute'
    && lateEmitError === null
    && warnings.length === 0,
  'late socket error after timeout cleanup is absorbed without warning or throw');
  runner.assert(commandMetrics(manager, type).length === 1
    && clientSocket?.destroyed === true
    && clientSocket.timeout === 0
    && clientSocket.listenerCount('connect') === 0
    && clientSocket.listenerCount('data') === 0
    && clientSocket.listenerCount('timeout') === 0
    && clientSocket.listenerCount('error') === 0
    && clientSocket.listenerCount('close') === 0
    && !activeHandles.includes(clientSocket),
  'timeout cleanup leaves one metric and no client timer, listener, or active handle');
}

{
  const base64Shape = 'A'.repeat(4 * 1024 * 1024);
  const expectedResult = {
    status: 'success',
    topology: { nodes: [{ id: 1, pins: ['In', 'Out'] }] },
    capture: { mime: 'image/png', base64: base64Shape },
  };
  const largeBody = Buffer.from(JSON.stringify(expectedResult), 'utf8');
  const largeFrame = frameForBody(largeBody);
  const chunks = [];
  for (let offset = 0; offset < largeFrame.length; offset += 4096) {
    chunks.push(largeFrame.subarray(offset, Math.min(offset + 4096, largeFrame.length)));
  }
  const originalParse = JSON.parse;
  let parseCount = 0;
  let exchange;
  JSON.parse = function countedLargeResponseParse(...args) {
    parseCount++;
    return originalParse(...args);
  };
  try {
    exchange = await exchangeResponse(chunks, {
      timeoutMs: 5000,
      type: 'large_topology_response',
    });
  } finally {
    JSON.parse = originalParse;
  }
  runner.assert(exchange.error === null
    && sameJson(exchange.result, expectedResult),
  '4 MiB topology/base64-shaped framed response remains uncapped');
  runner.assert(parseCount === 1,
    '4 MiB response command invokes its authoritative JSON parser exactly once',
    `got ${parseCount}`);
  runner.assert(isRecursivelyFrozenJson(exchange.result),
    '4 MiB response publishes one recursively frozen deep result');
  runner.assert(chunks.length > 1000 && chunks.slice(0, -1).every((chunk) => chunk.length === 4096),
    'large response fixture writes 4096-byte fragments');
}

{
  const delayed = await startTcpServer((socket) => {
    socket.once('data', async () => {
      await delay(35);
      await writeChunks(socket, [frameForBody('{"status":"success","timed":true}')]);
    });
  });
  let successManager;
  try {
    successManager = connectionManagerFor(delayed.port, 500, 100);
    await bounded(successManager.send(
      'tcp-55558', 'delayed_metrics', {}, { skipCache: true },
    ), 1500, 'delayed metrics success');
  } finally {
    await delayed.close();
  }
  const successMetric = successManager.getMetrics()._window.at(-1);
  runner.assert(successMetric?.ok === true
    && Number.isFinite(successMetric.total_ms)
    && successMetric.total_ms >= 20
    && Number.isFinite(successMetric.response_ms),
  'delayed success preserves finite elapsed timing metrics');

  const marker = 'UEMCP_SECRET_METRIC_PAYLOAD';
  const malformed = await exchangeResponse(
    [Buffer.from(`{"status":"${marker}",}`, 'ascii')],
    { type: 'malformed_metrics', metricsEmitEveryN: 100 },
  );
  const failureMetric = malformed.manager.getMetrics()._window.at(-1);
  lifecycleFailures.push(['metric malformed', 'MALFORMED_RESPONSE', malformed.error]);
  runner.assert(failureMetric?.ok === false
    && Number.isFinite(failureMetric.total_ms)
    && failureMetric.err === malformed.error?.message
    && !JSON.stringify(failureMetric).includes(marker),
  'failure metrics retain accounting and only the sanitized transport error');
}

{
  const type = 'preflight_metrics_clock';
  const fixture = await startTcpServer((socket) => {
    socket.once('data', () => {
      socket.end(frameForBody('{"status":"success","timed":true}'));
    });
  });
  const originalNow = process.hrtime.bigint;
  const samples = [100, 107, 120, 125, 130, 135, 140]
    .map((milliseconds) => BigInt(milliseconds) * 1_000_000n);
  let sampleIndex = 0;
  let manager;
  let result;
  try {
    process.hrtime.bigint = function deterministicTransportClock() {
      const sample = samples[sampleIndex];
      sampleIndex++;
      if (sample === undefined) throw new Error('transport clock sampled too often');
      return sample;
    };
    manager = connectionManagerFor(fixture.port, 500, 100);
    result = await bounded(manager.send(
      'tcp-55558', type, { generic: true }, { skipCache: true },
    ), 1500, 'preflight metrics clock');
  } finally {
    process.hrtime.bigint = originalNow;
    await fixture.close();
  }
  const [metric] = commandMetrics(manager, type);
  runner.assert(result?.timed === true && sampleIndex === samples.length,
    'transport timing samples preflight, wire phases, parse, and settlement exactly once');
  runner.assert(sameJson({
    connect_ms: metric?.connect_ms,
    send_ms: metric?.send_ms,
    first_byte_ms: metric?.first_byte_ms,
    response_ms: metric?.response_ms,
    total_ms: metric?.total_ms,
  }, {
    connect_ms: 13,
    send_ms: 12,
    first_byte_ms: 5,
    response_ms: 5,
    total_ms: 40,
  }), 'timing metrics include 7 ms preflight cost in send_ms and total_ms');
}

{
  const allowedDetailKeys = new Set([
    'direction',
    'framing',
    'bytesReceived',
    'declaredBodyLength',
    'bodyBytes',
    'maxBodyBytes',
    'timeoutMs',
    'timeoutKind',
    'parserCategory',
    'nativeCode',
  ]);
  for (const [name, expectedCode, error] of lifecycleFailures) {
    const serialized = JSON.stringify(error?.details ?? {});
    runner.assert(error instanceof Error
      && error.code === expectedCode
      && /^TCP:\d+ /.test(error.message)
      && !error.message.includes('UEMCP_SECRET')
      && !serialized.includes('UEMCP_SECRET')
      && Object.keys(error.details ?? {}).every((key) => allowedDetailKeys.has(key)),
    `${name} preserves Error identity, exact code, port context, and payload-free details`,
    error ? `${error.name}/${error.code}: ${error.message}` : 'no error');
  }
}

const transportSource = await readFile(transportUrl, 'utf8');
const connectionManagerSource = await readFile(connectionManagerUrl, 'utf8');
const nativePolicySource = await readFile(nativePolicySourceUrl, 'utf8');
const nativePolicyHeader = await readFile(nativePolicyHeaderUrl, 'utf8');
const nativeRunnableSource = await readFile(nativeRunnableSourceUrl, 'utf8');
const currentTransportDocs = [
  {
    docName: 'CLAUDE.md',
    source: await readFile(claudeDocUrl, 'utf8'),
    headingText: 'TCP Wire Protocol — Current Contract',
    headingLevel: 2,
    requestLabel: 'Requests',
    responseLabel: 'Responses',
  },
  {
    docName: 'docs/specs/architecture.md',
    source: await readFile(architectureDocUrl, 'utf8'),
    headingText: 'Current TCP:55558 Contract',
    headingLevel: 3,
    requestLabel: 'Request path',
    responseLabel: 'Response path',
  },
];
const requiredCurrentTransportContract = [
  '512-byte header',
  '8 MiB request limit',
  '2-second idle',
  '10-second total',
  'absolute Node deadline',
  'no response cap',
  'Win64-only runtime proof',
];
for (const {
  docName,
  source,
  headingText,
  headingLevel,
  requestLabel,
  responseLabel,
} of currentTransportDocs) {
  const extracted = extractUniqueMarkdownSection(source, headingText, headingLevel);
  runner.assert(extracted.count === 1,
    `${docName} contains exactly one ${'#'.repeat(headingLevel)} ${headingText} section`,
    `found ${extracted.count}`);
  for (const contractText of requiredCurrentTransportContract) {
    runner.assert(extracted.section.includes(contractText),
      `${docName} current TCP contract names ${contractText}`);
  }
  const requestLine = markdownBullet(extracted.section, requestLabel);
  const responseLine = markdownBullet(extracted.section, responseLabel);
  runner.assert(requestLine.includes('strict UTF-8'),
    `${docName} current TCP request line requires strict UTF-8`);
  runner.assert(responseLine.includes('strict UTF-8'),
    `${docName} current TCP response line requires strict UTF-8`);
  runner.assert(requestLine.includes('legacy compatibility'),
    `${docName} current TCP request line names legacy compatibility`);
}

const outsideOnlyContract = requiredCurrentTransportContract
  .concat(['strict UTF-8', 'legacy compatibility'])
  .join(' | ');
const scopedContractFixture = [
  outsideOnlyContract,
  '## TCP Wire Protocol — Current Contract',
  '- **Requests** — current request text only.',
  '- **Responses** — current response text only.',
  '### Nested detail',
  'nested-marker',
  '## Later section',
  outsideOnlyContract,
].join('\n');
const scopedContractFixtureResult = extractUniqueMarkdownSection(
  scopedContractFixture,
  'TCP Wire Protocol — Current Contract',
  2,
);
runner.assert(scopedContractFixtureResult.count === 1
  && scopedContractFixtureResult.section.includes('nested-marker')
  && requiredCurrentTransportContract.every(
    (contractText) => !scopedContractFixtureResult.section.includes(contractText),
  )
  && !markdownBullet(scopedContractFixtureResult.section, 'Requests').includes('strict UTF-8')
  && !markdownBullet(scopedContractFixtureResult.section, 'Requests').includes('legacy compatibility')
  && !markdownBullet(scopedContractFixtureResult.section, 'Responses').includes('strict UTF-8'),
'current-contract extractor includes nested content but excludes matching phrases outside its bounds');
runner.assert(extractUniqueMarkdownSection(
  `${scopedContractFixture}\n## TCP Wire Protocol — Current Contract\nduplicate`,
  'TCP Wire Protocol — Current Contract',
  2,
).count === 2,
'current-contract extractor rejects duplicate exact headings');

const claudeSource = currentTransportDocs[0].source;
const e1Section = extractUniqueMarkdownSection(
  claudeSource,
  'E-1 connection-layer hygiene + EN-23 metrics (D140)',
  3,
);
runner.assert(e1Section.count === 1,
  'CLAUDE.md contains exactly one E-1 connection-layer hygiene section',
  `found ${e1Section.count}`);
const e1TimeoutLine = e1Section.section.split('\n')
  .find((line) => line.startsWith('- **§5 Timeout reconciliation')) ?? '';
runner.assert(e1TimeoutLine.includes('PerConnectionTimeoutSec')
  && e1TimeoutLine.includes('historical')
  && e1TimeoutLine.includes('superseded'),
'CLAUDE.md E-1 timeout statement marks PerConnectionTimeoutSec historical and superseded');
runner.assert(e1TimeoutLine.includes('independent 2-second idle')
  && e1TimeoutLine.includes('10-second total request-intake')
  && e1TimeoutLine.includes('distinct 10-second response-send deadline'),
'CLAUDE.md E-1 timeout statement names independent intake deadlines and distinct send deadline');
const outsideOnlyE1Fixture = [
  'historical superseded independent 2-second idle 10-second total request-intake',
  'distinct 10-second response-send deadline',
  '### E-1 connection-layer hygiene + EN-23 metrics (D140)',
  '- **§5 Timeout reconciliation** — plugin `PerConnectionTimeoutSec` 5.0 → 10.0',
  '### Later history',
  'historical superseded independent 2-second idle 10-second total request-intake',
  'distinct 10-second response-send deadline',
].join('\n');
const outsideOnlyE1Section = extractUniqueMarkdownSection(
  outsideOnlyE1Fixture,
  'E-1 connection-layer hygiene + EN-23 metrics (D140)',
  3,
).section;
const outsideOnlyE1TimeoutLine = outsideOnlyE1Section.split('\n')
  .find((line) => line.startsWith('- **§5 Timeout reconciliation')) ?? '';
runner.assert(!outsideOnlyE1TimeoutLine.includes('historical')
  && !outsideOnlyE1TimeoutLine.includes('superseded')
  && !outsideOnlyE1TimeoutLine.includes('independent 2-second idle')
  && !outsideOnlyE1TimeoutLine.includes('10-second total request-intake')
  && !outsideOnlyE1TimeoutLine.includes('distinct 10-second response-send deadline'),
'E-1 extractor prevents deadline and supersession phrases outside its section from satisfying the guard');
const tcpCommandSource = connectionManagerSource.slice(
  connectionManagerSource.indexOf('function tcpCommand('),
  connectionManagerSource.indexOf('// ── HTTP Client'),
);
const dataHandlerMatch = /const onData = \(chunk\) => \{([\s\S]*?)\n\s*\};/.exec(tcpCommandSource);
runner.assert(dataHandlerMatch?.[1]?.includes('decoder.consume(chunk)'),
  'source guard: production data handler delegates each chunk to one decoder');
runner.assert(dataHandlerMatch !== null
  && !/Buffer\.concat|JSON\.parse/.test(dataHandlerMatch[1]),
'source guard: production data handler does no whole-body concat or parse work');
runner.assert(!connectionManagerSource.includes('_detectResponseFraming'),
  'source guard: duplicate response framing parser export/use is retired');
const preflightIndex = tcpCommandSource.indexOf('encodeTcpRequest(');
const metricsStartIndex = tcpCommandSource.indexOf('const t0 =');
const promiseIndex = tcpCommandSource.indexOf('new Promise(');
const createConnectionIndex = tcpCommandSource.indexOf('net.createConnection(');
runner.assert(preflightIndex >= 0
  && preflightIndex < promiseIndex
  && promiseIndex < createConnectionIndex,
'source guard: request preflight precedes Promise and socket construction');
runner.assert(metricsStartIndex >= 0 && metricsStartIndex < preflightIndex,
  'source guard: metrics timing starts before request preflight');
runner.assert(tcpCommandSource.includes('new TcpResponseDecoder(')
  && tcpCommandSource.includes('socket.setTimeout(timeoutMs)'),
'source guard: one incremental decoder and inactivity backstop are wired');
const focusedTestSource = await readFile(new URL(import.meta.url), 'utf8');
const exactLimitFixtureStart = focusedTestSource.indexOf('const lifecycleFailures = [];');
const exactLimitFixtureEnd = focusedTestSource.indexOf('const framedBody =', exactLimitFixtureStart);
const exactLimitFixtureSource = focusedTestSource.slice(
  exactLimitFixtureStart,
  exactLimitFixtureEnd,
);
runner.assert(exactLimitFixtureStart >= 0
  && exactLimitFixtureEnd > exactLimitFixtureStart
  && !exactLimitFixtureSource.includes('Buffer.concat(chunks)'),
'source guard: exact-limit server fixture does no per-chunk whole-buffer reconstruction');
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

runner.assert(nativePolicySource.includes('#if PLATFORM_WINDOWS')
  && (nativePolicySource.match(/#elif PLATFORM_UNIX \|\| PLATFORM_MAC/g) ?? []).length === 2
  && nativePolicySource.includes('#include "Windows/AllowWindowsPlatformTypes.h"')
  && nativePolicySource.includes('THIRD_PARTY_INCLUDES_START')
  && nativePolicySource.includes('#include "WinSock2.h"')
  && nativePolicySource.includes('THIRD_PARTY_INCLUDES_END')
  && nativePolicySource.includes('#include "Windows/HideWindowsPlatformTypes.h"')
  && nativePolicySource.includes('#include <cerrno>'),
'source guard: native receive error capture has guarded Windows and Unix/Mac includes');
runner.assert(nativePolicySource.includes('#include "Misc/EngineVersionComparison.h"')
  && nativePolicySource.includes('UE_VERSION_OLDER_THAN(5, 4, 0)')
  && nativePolicySource.includes('PopWithoutShrinking('),
'source guard: native decoder preserves non-shrinking stack pops across UE 5.3 and newer');
runner.assert((nativePolicySource.match(/\.Pop\(EAllowShrinking::No\)/g) ?? []).length === 1,
  'source guard: post-5.3 EAllowShrinking is isolated to the guarded compatibility helper');
runner.assert(nativePolicySource.includes('WSASetLastError(0)')
  && (nativePolicySource.match(/WSAGetLastError\(\)/g) ?? []).length === 1
  && nativePolicySource.includes('errno = 0')
  && nativePolicySource.includes('const int32 NativeErrorCode = errno')
  && nativePolicySource.includes('SocketSubsystem->TranslateErrorCode(NativeErrorCode)'),
'source guard: native receive errors are cleared, captured, and translated');
const receiveFunctionStart = nativePolicySource.indexOf(
  'FMCPReceiveAttempt ReceiveWithCapturedError(',
);
const windowsReceiveStart = nativePolicySource.indexOf(
  '#if PLATFORM_WINDOWS', receiveFunctionStart,
);
const posixReceiveStart = nativePolicySource.indexOf(
  '#elif PLATFORM_UNIX || PLATFORM_MAC', windowsReceiveStart,
);
const fallbackReceiveStart = nativePolicySource.indexOf('#else', posixReceiveStart);
const receiveBranchesEnd = nativePolicySource.indexOf('#endif', fallbackReceiveStart);
const windowsReceiveSource = nativePolicySource.slice(windowsReceiveStart, posixReceiveStart);
const posixReceiveSource = nativePolicySource.slice(posixReceiveStart, fallbackReceiveStart);
const fallbackReceiveSource = nativePolicySource.slice(fallbackReceiveStart, receiveBranchesEnd);
function hasClearRecvCaptureOrdering(source, clearToken, captureToken) {
  const receiveMatches = findDirectRecvMemberCalls(source);
  const clearPositions = findExactCodePositions(receiveMatches.code, clearToken);
  const capturePositions = findExactCodePositions(receiveMatches.code, captureToken);
  return clearPositions.length === 1
    && receiveMatches.count === 1
    && capturePositions.length === 1
    && clearPositions[0] < receiveMatches.positions[0]
    && receiveMatches.positions[0] < capturePositions[0];
}

runner.assert(receiveFunctionStart >= 0
  && windowsReceiveStart > receiveFunctionStart
  && posixReceiveStart > windowsReceiveStart
  && fallbackReceiveStart > posixReceiveStart
  && receiveBranchesEnd > fallbackReceiveStart
  && countDirectRecvMemberCalls(windowsReceiveSource) === 1
  && countDirectRecvMemberCalls(posixReceiveSource) === 1
  && countDirectRecvMemberCalls(fallbackReceiveSource) === 1
  && !fallbackReceiveSource.includes('errno'),
'source guard: Unix and Mac share errno capture without generic fallback');
runner.assert(hasClearRecvCaptureOrdering(
  windowsReceiveSource,
  'WSASetLastError(0)',
  'WSAGetLastError()',
) && hasClearRecvCaptureOrdering(
  posixReceiveSource,
  'errno = 0',
  'const int32 NativeErrorCode = errno',
),
'source guard: native error clear, receive, and capture ordering is explicit');
runner.assert(!nativePolicySource.includes('GetConnectionState'),
  'source guard: receive classification never uses GetConnectionState');

const finalizationStart = nativePolicySource.indexOf('\n\tvoid FinalizeBody()');
const finalizationEnd = nativePolicySource.indexOf('\n\tFMCPDecoderPolicy Policy;', finalizationStart);
const finalizationSource = nativePolicySource.slice(finalizationStart, finalizationEnd);
const missingRootIndex = finalizationSource.indexOf(
  'const bool bMissingRoot = RootOffset >= Body.Num();',
);
const rootTokenIndex = finalizationSource.indexOf(
  'const uint8 RootToken = bMissingRoot ? 0 : Body[RootOffset];',
);
const scalarCandidateIndex = finalizationSource.indexOf(
  "const bool bScalarCandidate = !bMissingRoot && RootToken != '{' && RootToken != '[';",
);
const scalarWrapperIndex = finalizationSource.indexOf(
  'FString ScalarWrapper;',
);
const scalarWrapperReserveIndex = finalizationSource.indexOf('ScalarWrapper.Reserve(JsonText.Len() + 2);');
const scalarWrapperAppendIndex = finalizationSource.indexOf('ScalarWrapper.Append(JsonText);');
const parserStreamIndex = finalizationSource.indexOf('FMemoryReader JsonStream(JsonTextBytes);');
const deserializeIndex = finalizationSource.indexOf('FJsonSerializer::Deserialize');
const parserStreamEndIndex = finalizationSource.indexOf('JsonStream.AtEnd()', deserializeIndex);
const scalarClassificationIndex = finalizationSource.indexOf('if (bScalarCandidate)', deserializeIndex);
const retiredStrictJsonSymbols = [
  'ValidateStrictJsonDocument',
  'EStrictJsonRootKind',
  'EStrictJsonState',
  'FStrictJsonFrame',
  'SkipJsonWhitespace',
  'IsHexDigit',
  'ConsumeStrictJsonString',
  'ConsumeStrictJsonLiteral',
  'ConsumeStrictJsonNumber',
  'ConsumeStrictJsonValue',
];
runner.assert(finalizationStart >= 0
  && finalizationEnd > finalizationStart
  && (finalizationSource.match(/FJsonSerializer::Deserialize/g) ?? []).length === 1
  && (finalizationSource.match(/\+\+JsonParseCount/g) ?? []).length === 1
  && missingRootIndex >= 0
  && rootTokenIndex > missingRootIndex
  && scalarCandidateIndex > rootTokenIndex
  && scalarWrapperIndex > scalarCandidateIndex
  && scalarWrapperReserveIndex > scalarWrapperIndex
  && scalarWrapperAppendIndex > scalarWrapperReserveIndex
  && parserStreamIndex > scalarWrapperAppendIndex
  && deserializeIndex > parserStreamIndex
  && parserStreamEndIndex > deserializeIndex
  && scalarClassificationIndex > deserializeIndex
  && !finalizationSource.includes('FString::Printf(TEXT("[%s]"), *JsonText)')
  && retiredStrictJsonSymbols.every((symbol) => !nativePolicySource.includes(symbol)),
'source guard: finalization has one authoritative Unreal parse with length-aware scalar wrapper classification');

const retiredRunnableSymbols = [
  'TryParseAccumulated',
  'DetectFraming',
  'FCString::Atoi',
  'bFramed',
  'bFramingDecided',
  'bRequestComplete',
  'bPeerClosed',
  'FramingBodyOffset',
  'FramingBodyLen',
];
runner.assert(retiredRunnableSymbols.every((symbol) => !nativeRunnableSource.includes(symbol)),
  'source guard: runnable retires accumulator parser helpers and coordination flags');

function isCppIdentifierChar(char) {
  return typeof char === 'string' && /^[A-Za-z0-9_]$/.test(char);
}

function isCppDecimalDigit(char) {
  return typeof char === 'string' && /^[0-9]$/.test(char);
}

function cppPhase2SpliceLength(source, startIndex) {
  if (source[startIndex] !== '\\') return 0;
  if (source[startIndex + 1] === '\r' && source[startIndex + 2] === '\n') return 3;
  if (source[startIndex + 1] === '\n' || source[startIndex + 1] === '\r') return 2;
  return 0;
}

function cppLogicalEntry(source, startIndex) {
  let originalIndex = startIndex;
  while (originalIndex < source.length) {
    const spliceLength = cppPhase2SpliceLength(source, originalIndex);
    if (spliceLength > 0) {
      originalIndex += spliceLength;
      continue;
    }

    if (source[originalIndex] === '\r') {
      return {
        char: '\n',
        originalIndex,
        nextOriginalIndex: originalIndex + (source[originalIndex + 1] === '\n' ? 2 : 1),
      };
    }
    if (source[originalIndex] === '\n') {
      return { char: '\n', originalIndex, nextOriginalIndex: originalIndex + 1 };
    }
    return {
      char: source[originalIndex],
      originalIndex,
      nextOriginalIndex: originalIndex + 1,
    };
  }
  return null;
}

function cppRawLiteralOpening(source, startIndex, previousLogicalChar) {
  if (isCppIdentifierChar(previousLogicalChar)) return null;

  const entries = [];
  let cursor = startIndex;
  const read = () => {
    const entry = cppLogicalEntry(source, cursor);
    if (entry) {
      entries.push(entry);
      cursor = entry.nextOriginalIndex;
    }
    return entry;
  };

  const first = read();
  if (!first) return null;
  if (first.char === 'u') {
    const second = read();
    if (!second) return null;
    if (second.char === '8') {
      const third = read();
      if (!third || third.char !== 'R') return null;
    } else if (second.char !== 'R') {
      return null;
    }
  } else if (first.char === 'U' || first.char === 'L') {
    const second = read();
    if (!second || second.char !== 'R') return null;
  } else if (first.char !== 'R') {
    return null;
  }

  const quote = read();
  if (!quote || quote.char !== '"') return null;
  let delimiter = '';
  while (delimiter.length <= 16) {
    const entry = read();
    if (!entry) return null;
    if (entry.char === '(') {
      const closingToken = `)${delimiter}"`;
      const closingIndex = source.indexOf(closingToken, entry.nextOriginalIndex);
      return {
        entries,
        contentStart: entry.nextOriginalIndex,
        endOriginalIndex: closingIndex >= 0
          ? closingIndex + closingToken.length
          : source.length,
      };
    }
    if (/[\s()\\]/.test(entry.char)) return null;
    delimiter += entry.char;
  }
  return null;
}

function cppQuotedLiteralOpening(source, startIndex, previousLogicalChar) {
  const entries = [];
  let cursor = startIndex;
  const read = () => {
    const entry = cppLogicalEntry(source, cursor);
    if (entry) {
      entries.push(entry);
      cursor = entry.nextOriginalIndex;
    }
    return entry;
  };

  const first = read();
  if (!first) return null;
  if (first.char === '"' || first.char === "'") {
    return { entries, quote: first.char, endOriginalIndex: cursor };
  }
  if (isCppIdentifierChar(previousLogicalChar)) return null;

  let quote = null;
  if (first.char === 'u') {
    const second = read();
    if (!second) return null;
    quote = second;
    if (second.char === '8') quote = read();
  } else if (first.char === 'U' || first.char === 'L') {
    quote = read();
  } else {
    return null;
  }

  if (!quote || (quote.char !== '"' && quote.char !== "'")) return null;
  return { entries, quote: quote.char, endOriginalIndex: cursor };
}

function cppNumberToken(source, startIndex) {
  const first = cppLogicalEntry(source, startIndex);
  if (!first) return null;
  const second = cppLogicalEntry(source, first.nextOriginalIndex);
  const startsWithDigit = isCppDecimalDigit(first.char);
  const startsWithDecimalPoint = first.char === '.'
    && second
    && isCppDecimalDigit(second.char);
  if (!startsWithDigit && !startsWithDecimalPoint) return null;

  const entries = [first];
  let cursor = first.nextOriginalIndex;
  while (cursor < source.length) {
    const entry = cppLogicalEntry(source, cursor);
    if (!entry) {
      cursor = source.length;
      break;
    }
    const previousChar = entries[entries.length - 1].char;
    const afterEntry = cppLogicalEntry(source, entry.nextOriginalIndex);
    const continuesNumber = isCppIdentifierChar(entry.char)
      || entry.char === '.'
      || (entry.char === "'" && afterEntry && isCppIdentifierChar(afterEntry.char))
      || ((entry.char === '+' || entry.char === '-') && /[eEpP]/.test(previousChar));
    if (!continuesNumber) break;
    entries.push(entry);
    cursor = entry.nextOriginalIndex;
  }
  return { entries, endOriginalIndex: cursor };
}

function cppCodeView(source) {
  const codeChars = [];
  const normalizedToOriginal = [];
  const emit = (char, originalIndex) => {
    codeChars.push(char);
    normalizedToOriginal.push(originalIndex);
  };
  const emitMasked = (entry) => {
    emit(entry.char === '\n' ? '\n' : ' ', entry.originalIndex);
  };
  const emitRawMaskedRange = (startIndex, endIndex) => {
    let index = startIndex;
    while (index < endIndex) {
      if (source[index] === '\r') {
        emit('\n', index);
        index += source[index + 1] === '\n' ? 2 : 1;
      } else if (source[index] === '\n') {
        emit('\n', index);
        index += 1;
      } else {
        emit(' ', index);
        index += 1;
      }
    }
  };

  let cursor = 0;
  let state = 'code';
  let quote = '';
  let escaped = false;
  while (cursor < source.length) {
    const entry = cppLogicalEntry(source, cursor);
    if (!entry) break;

    if (state === 'line-comment') {
      if (entry.char === '\n') {
        emit('\n', entry.originalIndex);
        state = 'code';
      } else {
        emitMasked(entry);
      }
      cursor = entry.nextOriginalIndex;
      continue;
    }

    if (state === 'block-comment') {
      const next = entry.char === '*'
        ? cppLogicalEntry(source, entry.nextOriginalIndex)
        : null;
      if (next && next.char === '/') {
        emitMasked(entry);
        emitMasked(next);
        cursor = next.nextOriginalIndex;
        state = 'code';
      } else {
        emitMasked(entry);
        cursor = entry.nextOriginalIndex;
      }
      continue;
    }

    if (state === 'quoted-literal') {
      if (entry.char === '\n') {
        emit('\n', entry.originalIndex);
        state = 'code';
        escaped = false;
      } else {
        emitMasked(entry);
        if (escaped) {
          escaped = false;
        } else if (entry.char === '\\') {
          escaped = true;
        } else if (entry.char === quote) {
          state = 'code';
        }
      }
      cursor = entry.nextOriginalIndex;
      continue;
    }

    const next = entry.char === '/'
      ? cppLogicalEntry(source, entry.nextOriginalIndex)
      : null;
    if (next && (next.char === '/' || next.char === '*')) {
      emitMasked(entry);
      emitMasked(next);
      cursor = next.nextOriginalIndex;
      state = next.char === '/' ? 'line-comment' : 'block-comment';
      continue;
    }

    const previousLogicalChar = codeChars.length > 0
      ? codeChars[codeChars.length - 1]
      : '';
    const rawLiteral = cppRawLiteralOpening(source, cursor, previousLogicalChar);
    if (rawLiteral) {
      rawLiteral.entries.forEach(emitMasked);
      emitRawMaskedRange(rawLiteral.contentStart, rawLiteral.endOriginalIndex);
      cursor = rawLiteral.endOriginalIndex;
      continue;
    }

    const number = cppNumberToken(source, cursor);
    if (number) {
      number.entries.forEach((numberEntry) => emit(
        numberEntry.char,
        numberEntry.originalIndex,
      ));
      cursor = number.endOriginalIndex;
      continue;
    }

    const quotedLiteral = cppQuotedLiteralOpening(source, cursor, previousLogicalChar);
    if (quotedLiteral) {
      quotedLiteral.entries.forEach(emitMasked);
      cursor = quotedLiteral.endOriginalIndex;
      state = 'quoted-literal';
      quote = quotedLiteral.quote;
      escaped = false;
      continue;
    }

    emit(entry.char, entry.originalIndex);
    cursor = entry.nextOriginalIndex;
  }

  return { code: codeChars.join(''), normalizedToOriginal };
}

const cppLexerFixture = [
  'VisibleBefore(); // HiddenLineToken',
  '/* HiddenBlockToken */',
  'const TCHAR* Text = TEXT("HiddenStringToken");',
  'const TCHAR* Raw = TEXT(R"mask(HiddenRawToken)mask");',
  "const int GroupedNumber = 1'000;",
  'VisibleAfterNumber();',
  "const int Character = 'HiddenCharacterToken';",
  'VisibleAfter();',
].join('\n');
const cppLexerCodeView = cppCodeView(cppLexerFixture);
const cppFixtureCode = cppLexerCodeView.code;
runner.assert(cppFixtureCode.length === cppLexerFixture.length
  && cppFixtureCode.length === cppLexerCodeView.normalizedToOriginal.length
  && cppLexerCodeView.normalizedToOriginal.every((originalIndex, logicalIndex, mapping) => (
    logicalIndex === 0 || originalIndex > mapping[logicalIndex - 1]
  ))
  && cppFixtureCode.indexOf('VisibleBefore') === cppLexerFixture.indexOf('VisibleBefore')
  && cppFixtureCode.indexOf('VisibleAfterNumber')
    === cppLexerFixture.indexOf('VisibleAfterNumber')
  && cppFixtureCode.indexOf('VisibleAfter') === cppLexerFixture.indexOf('VisibleAfter')
  && [
    'HiddenLineToken',
    'HiddenBlockToken',
    'HiddenStringToken',
    'HiddenRawToken',
    'HiddenCharacterToken',
  ].every((token) => !cppFixtureCode.includes(token)),
'source guard scanner: mapped code view preserves source order and removes comments/literals');

function findDirectRecvMemberCalls(source) {
  const codeView = cppCodeView(source);
  const directMemberCall = /(?:->|\.)\s*(?:(?:[A-Za-z_][A-Za-z0-9_]*)\s*::\s*)*Recv\s*\(/g;
  const positions = [...codeView.code.matchAll(directMemberCall)].map((match) => (
    match.index + match[0].lastIndexOf('Recv')
  ));
  return {
    code: codeView.code,
    count: positions.length,
    positions,
  };
}

function findExactCodePositions(code, token) {
  const positions = [];
  let searchIndex = 0;
  while (searchIndex <= code.length - token.length) {
    const position = code.indexOf(token, searchIndex);
    if (position < 0) break;
    positions.push(position);
    searchIndex = position + Math.max(1, token.length);
  }
  return positions;
}

function countDirectRecvMemberCalls(source) {
  return findDirectRecvMemberCalls(source).count;
}

function hasDirectRecvMemberCall(source) {
  return countDirectRecvMemberCalls(source) > 0;
}

const cppPhase2Splice = (lineEnding) => `\\${lineEnding}`;

runner.assert(countDirectRecvMemberCalls(nativeRunnableSource) === 0,
  'source guard: MCPServerRunnable normalized code contains no direct qualified/unqualified arrow/dot Recv call');
runner.assert(hasDirectRecvMemberCall('ClientSocket -> Recv(Buffer, BufferSize, BytesRead);'),
  'source guard mutation: direct arrow Recv member call is detected');
runner.assert(hasDirectRecvMemberCall('(*ClientSocket) . Recv(Buffer, BufferSize, BytesRead);'),
  'source guard mutation: direct dot Recv member call is detected');
runner.assert(hasDirectRecvMemberCall(
  'ClientSocket -> FSocket::Recv(Buffer, BufferSize, BytesRead);',
), 'source guard mutation: qualified direct arrow Recv member call is detected');
const recvSpliceFixtures = ['\n', '\r\n', '\r'].map((lineEnding) => (
  `ClientSocket->Re\\${lineEnding}cv(Buffer, BufferSize, BytesRead);`
));
runner.assert(recvSpliceFixtures.every(hasDirectRecvMemberCall),
  'source guard mutation: LF/CRLF/CR-spliced direct Recv member calls are detected');
runner.assert(!hasDirectRecvMemberCall(`
  // ClientSocket->Recv(Buffer, BufferSize, BytesRead);
  /* (*ClientSocket).Recv(Buffer, BufferSize, BytesRead); */
`), 'source guard mutation: comment-only Recv examples are ignored');
runner.assert(!hasDirectRecvMemberCall(`
  const TCHAR* ArrowExample = TEXT("ClientSocket->Recv(Buffer, BufferSize, BytesRead)");
  const TCHAR* DotExample = TEXT(R"tag((*ClientSocket).Recv(Buffer, BufferSize, BytesRead))tag");
  const int MultiCharacterExample = '->Recv(';
`), 'source guard mutation: literal-only Recv examples are ignored');
const twoReceiveCallFixture = `
  Socket->Recv(Buffer, BufferSize, BytesRead);
  (*Socket).Recv(Buffer, BufferSize, BytesRead);
`;
runner.assert(countDirectRecvMemberCalls(twoReceiveCallFixture) === 2,
  'source guard mutation: Task 4 receive matcher counts arrow plus dot calls as two');
const nonCodeReceiveFixture = `
  // Socket->Recv(Buffer, BufferSize, BytesRead);
  const TCHAR* Example = TEXT("Socket->Recv(Buffer, BufferSize, BytesRead)");
`;
runner.assert(countDirectRecvMemberCalls(nonCodeReceiveFixture) === 0,
  'source guard mutation: Task 4 receive matcher counts comment/literal calls as zero');
const spliceFormedCommentFixture = [
  '/\\',
  '/ Socket->Recv(Buffer, BufferSize, BytesRead);',
].join('\n');
runner.assert(!hasDirectRecvMemberCall(spliceFormedCommentFixture),
  'source guard mutation: splice-formed comments hide direct Recv text');
const spliceFormedRawReceiveFixture = (
  `R${cppPhase2Splice('\n')}"tag(" harmless)tag"; Socket->Recv(Buffer, BufferSize, BytesRead);`
);
runner.assert(countDirectRecvMemberCalls(spliceFormedRawReceiveFixture) === 1,
  'source guard mutation: splice-formed raw literal hides harmless text before one real Recv');
const commentSpoofedReceiveOrderingFixture = [
  'WSASetLastError(0);',
  '// Socket->Recv(Buffer, BufferSize, BytesRead);',
  'const int32 NativeErrorCode = WSAGetLastError();',
  'Attempt.bSucceeded = Socket->FSocket::Recv(Buffer, BufferSize, BytesRead);',
].join('\n');
runner.assert(!hasClearRecvCaptureOrdering(
  commentSpoofedReceiveOrderingFixture,
  'WSASetLastError(0)',
  'WSAGetLastError()',
), 'source guard mutation: comment-spoofed Recv cannot hide actual receive after capture');
const qualifiedSplicedOrderingFixtures = ['\n', '\r\n', '\r'].map((lineEnding) => ([
  'errno = 0;',
  `Attempt.bSucceeded = Socket->FSocket::Re${cppPhase2Splice(lineEnding)}cv(Buffer, BufferSize, BytesRead);`,
  'const int32 NativeErrorCode = errno;',
].join(lineEnding)));
runner.assert(qualifiedSplicedOrderingFixtures.every((source) => (
  hasClearRecvCaptureOrdering(source, 'errno = 0', 'const int32 NativeErrorCode = errno')
)), 'source guard mutation: qualified LF/CRLF/CR-spliced Recv orders between clear and capture');
runner.assert(!nativeRunnableSource.includes('failed to send response'),
  'source guard: caller-level generic response-send warning is retired');
runner.assert((nativeRunnableSource.match(/\bReadOneRequest\s*\(/g) ?? []).length === 1
  && nativeRunnableSource.includes('ReadOneRequest(ClientSocket, AcceptedAtSeconds'),
  'source guard: runnable delegates intake to exactly one typed read call');

const readOneRequestStart = nativePolicySource.indexOf('FMCPRequestReadResult ReadOneRequest(');
const decoderImplementationStart = nativePolicySource.indexOf(
  'struct FMCPRequestDecoder::FImpl', readOneRequestStart,
);
const readOneRequestSource = nativePolicySource.slice(
  readOneRequestStart,
  decoderImplementationStart,
);
const precedenceStart = readOneRequestSource.indexOf('auto ApplyPrecedence =');
const stopPrecedenceIndex = readOneRequestSource.indexOf('if (!IsServerRunning())', precedenceStart);
const decoderTerminalMappingIndex = readOneRequestSource.indexOf(
  'switch (Snapshot.Status)', precedenceStart,
);
runner.assert(readOneRequestStart >= 0
  && decoderImplementationStart > readOneRequestStart
  && precedenceStart >= 0
  && stopPrecedenceIndex > precedenceStart
  && decoderTerminalMappingIndex > stopPrecedenceIndex,
'source guard: read precedence checks server stop before decoder terminal mapping');

const serverStoppingCaseStart = nativeRunnableSource.indexOf(
  'case EMCPRequestReadOutcome::ServerStopping:',
);
const serverStoppingCaseEnd = nativeRunnableSource.indexOf('\n\t}', serverStoppingCaseStart);
const serverStoppingCaseSource = nativeRunnableSource.slice(
  serverStoppingCaseStart,
  serverStoppingCaseEnd,
);
runner.assert(serverStoppingCaseStart >= 0
  && serverStoppingCaseEnd > serverStoppingCaseStart
  && /\breturn\s*;/.test(serverStoppingCaseSource)
  && !/UEMCP_(?:LOG|WARN|ERROR|VERBOSE)|BuildErrorResponse|SendAll/.test(serverStoppingCaseSource),
'source guard: runnable ServerStopping case returns without logging or response work');

const readResultBuilderStart = nativePolicySource.indexOf(
  'FMCPRequestReadResult BuildRequestReadResult(',
);
const readResultBuilderEnd = nativePolicySource.indexOf(
  'FMCPRequestReadResult ReadOneRequest(', readResultBuilderStart,
);
const readResultBuilderSource = nativePolicySource.slice(
  readResultBuilderStart,
  readResultBuilderEnd,
);
runner.assert(nativePolicyHeader.includes('FMCPRequestReadResult BuildRequestReadResult(')
  && readResultBuilderStart >= 0
  && readResultBuilderEnd > readResultBuilderStart
  && readResultBuilderSource.includes('Outcome == EMCPRequestReadOutcome::Complete')
  && readResultBuilderSource.includes('Result.Object = Snapshot.Object')
  && readResultBuilderSource.includes('Result.Object.Reset()'),
'source guard: pure read-result builder copies Object only for Complete and resets it otherwise');
runner.assert(readOneRequestSource.includes('Result = BuildRequestReadResult(')
  && !readOneRequestSource.includes('Result.Object = Snapshot.Object'),
  'source guard: production read path delegates result mapping to the invariant-owning builder');

runner.assert(nativeRunnableSource.includes('constexpr double ResponseSendTimeoutSec = 10.0;')
  && nativeRunnableSource.includes('SendAll(ClientSocket, Framed, ResponseSendTimeoutSec)')
  && !nativeRunnableSource.includes('PerConnectionTimeoutSec'),
  'source guard: response sending owns a distinct 10-second timeout constant');
runner.assert(nativePolicyHeader.includes('inline constexpr int32 MaxHeaderBytes = 512;')
  && nativePolicyHeader.includes('inline constexpr int64 MaxRequestBodyBytes = 8ll * 1024ll * 1024ll;')
  && nativePolicySource.includes('FMCPRequestDecoder Decoder({MaxHeaderBytes, MaxRequestBodyBytes});')
  && nativePolicySource.includes('ReceiveIdleTimeoutSec')
  && nativePolicySource.includes('ReceiveTotalTimeoutSec'),
  'source guard: typed read path owns production decoder limits and receive deadlines');
runner.assert(nativeRunnableSource.includes('SocketSubsystem->GetSocketError(Error)')
  && (nativeRunnableSource.match(/event=tcp_send_failure/g) ?? []).length === 1,
  'source guard: SendAll translates and solely owns one detailed send-failure event');
const requiredIntakeEvents = [
  'event=tcp_intake_malformed',
  'event=tcp_intake_too_large',
  'event=tcp_intake_idle_timeout',
  'event=tcp_intake_total_timeout',
  'event=tcp_peer_closed_empty',
  'event=tcp_peer_closed_partial',
  'event=tcp_intake_socket_error',
];
runner.assert(requiredIntakeEvents.every((event) => (
  nativeRunnableSource.match(new RegExp(event, 'g')) ?? []
).length === 1),
'source guard: each centralized intake outcome owns exactly one event token');

function isDirectLogMacroDefinition(code, macroStart) {
  let logicalLineStart = macroStart;
  while (logicalLineStart > 0
    && code[logicalLineStart - 1] !== '\n'
    && code[logicalLineStart - 1] !== '\r') {
    logicalLineStart -= 1;
  }
  const beforeMacroName = code.slice(logicalLineStart, macroStart);
  return /^\s*#\s*define\s+$/.test(beforeMacroName);
}

function extractBalancedLogInvocations(source) {
  const codeView = cppCodeView(source);
  const codeOnly = codeView.code;
  const invocations = [];
  const starts = [...codeOnly.matchAll(/\bUEMCP_(?:LOG|WARN|ERROR|VERBOSE)\s*\(/g)];
  for (const start of starts) {
    if (isDirectLogMacroDefinition(codeOnly, start.index)) continue;
    const openIndex = codeOnly.indexOf('(', start.index);
    let depth = 0;
    let endIndex = -1;
    for (let index = openIndex; index < codeOnly.length; index += 1) {
      if (codeOnly[index] === '(') {
        depth += 1;
      } else if (codeOnly[index] === ')') {
        depth -= 1;
        if (depth === 0) {
          endIndex = index + 1;
          break;
        }
      }
    }
    const complete = endIndex > openIndex;
    const originalStart = codeView.normalizedToOriginal[start.index];
    const originalEnd = complete
      ? codeView.normalizedToOriginal[endIndex - 1] + 1
      : originalStart;
    invocations.push({
      complete,
      code: complete ? codeOnly.slice(start.index, endIndex) : '',
      source: complete ? source.slice(originalStart, originalEnd) : '',
    });
  }
  return invocations;
}

const transportLogInvocations = extractBalancedLogInvocations(nativeRunnableSource);
const directPayloadLogIdentifier = /\b(?:RequestJson|ResponseJson|SerializedResponse|BodyUtf8|Framed|Bytes|CommandType|Params|Request|Response|RequestObject|ResponseObject)\b/;
const directPayloadPreviewExpression = /\b(?:ToString|ToJson|Preview)\s*\(|\b(?:Payload|Request|Response|Body|Framed)?Preview\b/;

function invocationDirectlyReferencesPayload(invocation) {
  if (!invocation.complete) return false;
  const openIndex = invocation.code.indexOf('(');
  const argumentCode = invocation.code.slice(openIndex + 1, -1);
  const withoutSafeFramingMetadata = argumentCode.replace(
    /\bFramed\s*\.\s*(?:Num|Len)\s*\(\s*\)/g,
    (match) => ' '.repeat(match.length),
  );
  return directPayloadLogIdentifier.test(withoutSafeFramingMetadata)
    || directPayloadPreviewExpression.test(withoutSafeFramingMetadata);
}

const cppLineEndings = ['\n', '\r\n', '\r'];
const spliceFormedBlockCloseFixtures = cppLineEndings.map((lineEnding) => ([
  '/* Socket->Recv(HiddenBuffer, HiddenSize, HiddenBytes);',
  'UEMCP_WARN("hidden=%s", *SerializedResponse);',
  `*${cppPhase2Splice(lineEnding)}/`,
  'Socket->Recv(Buffer, BufferSize, BytesRead);',
  'UEMCP_WARN("payload=%s", *SerializedResponse);',
].join(lineEnding)));
runner.assert(spliceFormedBlockCloseFixtures.every((source) => {
  const invocations = extractBalancedLogInvocations(source);
  return countDirectRecvMemberCalls(source) === 1
    && invocations.length === 1
    && invocationDirectlyReferencesPayload(invocations[0]);
}), 'source guard scanner: LF/CRLF/CR-spliced block closes expose following receive and payload log');

const spliceFormedLineCommentFixtures = cppLineEndings.map((lineEnding) => ([
  `/${cppPhase2Splice(lineEnding)}/ misleading R"tag( " UEMCP_WARN("hidden=%s", *SerializedResponse)`,
  'Socket->Recv(Buffer, BufferSize, BytesRead);',
  'UEMCP_WARN("payload=%s", *SerializedResponse);',
].join(lineEnding)));
runner.assert(spliceFormedLineCommentFixtures.every((source) => {
  const invocations = extractBalancedLogInvocations(source);
  return countDirectRecvMemberCalls(source) === 1
    && invocations.length === 1
    && invocationDirectlyReferencesPayload(invocations[0]);
}), 'source guard scanner: LF/CRLF/CR-spliced line comments ignore misleading literals and end at a logical newline');

const spliceFormedBlockCommentFixtures = cppLineEndings.map((lineEnding) => ([
  `/${cppPhase2Splice(lineEnding)}* misleading u8R"broken( "unterminated`,
  'Socket->Recv(HiddenBuffer, HiddenSize, HiddenBytes);',
  'UEMCP_WARN("hidden=%s", *SerializedResponse);',
  `*${cppPhase2Splice(lineEnding)}/`,
  'Socket->Recv(Buffer, BufferSize, BytesRead);',
  'UEMCP_WARN("payload=%s", *SerializedResponse);',
].join('\n')));
runner.assert(spliceFormedBlockCommentFixtures.every((source) => {
  const invocations = extractBalancedLogInvocations(source);
  return countDirectRecvMemberCalls(source) === 1
    && invocations.length === 1
    && invocationDirectlyReferencesPayload(invocations[0]);
}), 'source guard scanner: LF/CRLF/CR-spliced block delimiters hide misleading literal prefixes');

const rawInternalSpliceFixtures = cppLineEndings.map((lineEnding) => (
  `R"tag(raw )ta${cppPhase2Splice(lineEnding)}g" Socket->Recv(HiddenBuffer, HiddenSize, HiddenBytes); `
    + 'UEMCP_WARN("hidden=%s", *SerializedResponse); )tag"; '
    + 'Socket->Recv(Buffer, BufferSize, BytesRead); '
    + 'UEMCP_WARN("payload=%s", *SerializedResponse);'
));
runner.assert(rawInternalSpliceFixtures.every((source) => {
  const invocations = extractBalancedLogInvocations(source);
  return countDirectRecvMemberCalls(source) === 1
    && invocations.length === 1
    && invocationDirectlyReferencesPayload(invocations[0]);
}), 'source guard scanner: raw literal contents retain LF/CRLF/CR backslash-newlines and hide pseudo calls');

runner.assert(transportLogInvocations.length > 0
  && transportLogInvocations.every((invocation) => invocation.complete)
  && transportLogInvocations.every((invocation) => (
    !invocationDirectlyReferencesPayload(invocation)
  )),
  'source guard: code-discovered balanced UEMCP log calls exclude direct payload identifiers and preview expressions');

const pseudoLogInvocations = extractBalancedLogInvocations(`
  // UEMCP_WARN("%s", *SerializedResponse);
  const TCHAR* Example = TEXT("UEMCP_LOG(\"%s\", *BodyUtf8)");
  const TCHAR* RawExample = TEXT(R"tag(UEMCP_VERBOSE("%s", *Framed))tag");
  const int MultiCharacterExample = 'UEMCP_WARN(';
`);
runner.assert(pseudoLogInvocations.length === 0,
  'source guard mutation: comment/literal pseudo-log macros are ignored');

const spliceFormedRawLogFixture = (
  `R${cppPhase2Splice('\n')}"tag(" UEMCP_WARN("%s", *SerializedResponse))tag";`
);
runner.assert(extractBalancedLogInvocations(spliceFormedRawLogFixture).length === 0,
  'source guard mutation: splice-formed raw literal hides payload-shaped log text');

const encodedSpliceRawLiteralFixtures = [
  `u${cppPhase2Splice('\n')}8R${cppPhase2Splice('\r')}"tag(" Socket->Recv(Buffer, BufferSize, BytesRead); UEMCP_WARN("%s", *SerializedResponse))tag";`,
  `u${cppPhase2Splice('\r\n')}R"tag(" Socket->Recv(Buffer, BufferSize, BytesRead); UEMCP_WARN("%s", *SerializedResponse))tag";`,
  `U${cppPhase2Splice('\r')}R"tag(" Socket->Recv(Buffer, BufferSize, BytesRead); UEMCP_WARN("%s", *SerializedResponse))tag";`,
  `L${cppPhase2Splice('\n')}R"tag(" Socket->Recv(Buffer, BufferSize, BytesRead); UEMCP_WARN("%s", *SerializedResponse))tag";`,
];
runner.assert(encodedSpliceRawLiteralFixtures.every((source) => (
  countDirectRecvMemberCalls(source) === 0
  && extractBalancedLogInvocations(source).length === 0
)), 'source guard mutation: spliced u8R/uR/UR/LR raw prefixes keep contents non-code');

const splicedPayloadLogFixtures = ['\n', '\r\n', '\r'].map((lineEnding) => (
  `UEMCP_\\${lineEnding}WARN("payload=%s", *SerializedResponse);`
));
const splicedPayloadLogInvocations = splicedPayloadLogFixtures.flatMap(
  extractBalancedLogInvocations,
);
runner.assert(splicedPayloadLogInvocations.length === 3
  && splicedPayloadLogInvocations.every(invocationDirectlyReferencesPayload)
  && splicedPayloadLogInvocations.every((invocation, index) => (
    invocation.source === splicedPayloadLogFixtures[index].slice(0, -1)
  )),
'source guard mutation: spliced payload logs are discovered and map to original source');

const directLogMacroDefinitionFixtures = [
  '#define UEMCP_WARN(Format, ...) UE_LOG(LogUEMCP, Warning, Format, ##__VA_ARGS__)',
  '#define UEMCP_LOG(Format, ...) UE_LOG(LogUEMCP, Log, Format, ##__VA_ARGS__)',
  ...['\n', '\r\n', '\r'].map((lineEnding) => (
    `#define UEMCP_\\${lineEnding}VERBOSE(Format, ...) UE_LOG(LogUEMCP, Verbose, Format)`
  )),
];
const directLogMacroDefinitions = directLogMacroDefinitionFixtures.flatMap(
  extractBalancedLogInvocations,
);
runner.assert(directLogMacroDefinitions.length === 0,
  'source guard mutation: direct logical-line UEMCP log macro definition names are ignored');

const replacementBodyLogInvocations = [
  '#define FORWARD_PAYLOAD() UEMCP_WARN("payload=%s", *SerializedResponse)',
  '#define UEMCP_LOG(...) UEMCP_WARN("payload=%s", *SerializedResponse)',
].flatMap(extractBalancedLogInvocations);
runner.assert(replacementBodyLogInvocations.length === 2
  && replacementBodyLogInvocations.every(invocationDirectlyReferencesPayload),
'source guard mutation: UEMCP log calls in another macro replacement body are inspected');

const directPayloadLogInvocations = [
  '*SerializedResponse',
  '*BodyUtf8',
  'Framed.GetData()',
  '*RequestJson',
  '*ResponseJson',
].flatMap((expression) => extractBalancedLogInvocations(
  `UEMCP_WARN("payload=%s", ${expression});`,
));
runner.assert(directPayloadLogInvocations.length === 5
  && directPayloadLogInvocations.every(invocationDirectlyReferencesPayload),
'source guard mutation: direct known payload log arguments are rejected');

const directPreviewLogInvocations = [
  ...extractBalancedLogInvocations('UEMCP_LOG("preview=%s", *SomeAlias.ToString());'),
  ...extractBalancedLogInvocations('UEMCP_WARN("preview=%s", *ResponsePreview);'),
];
runner.assert(directPreviewLogInvocations.length === 2
  && directPreviewLogInvocations.every(invocationDirectlyReferencesPayload),
'source guard mutation: direct ToString and named preview log arguments are rejected');

const safeFramingMetadataInvocations = extractBalancedLogInvocations(
  'UEMCP_VERBOSE("response_bytes=%d len=%d sent=%d body=%d", Framed.Num(), Framed.Len(), ResponseBytes, BodyLength);',
);
runner.assert(safeFramingMetadataInvocations.length === 1
  && !invocationDirectlyReferencesPayload(safeFramingMetadataInvocations[0]),
'source guard mutation: Framed Num/Len and byte-count metadata arguments are accepted');

const expectedLiveFaultProbeContracts = [
  { id: '01-framed-ping', expectedEvents: [], warningCount: 0 },
  { id: '02-legacy-ping', expectedEvents: [], warningCount: 0 },
  {
    id: '03-empty-close',
    expectedEvents: [],
    optionalEvents: ['event=tcp_peer_closed_empty'],
    warningCount: 0,
  },
  {
    id: '04-partial-framed-close',
    expectedEvents: ['event=tcp_peer_closed_partial'],
    warningCount: 1,
  },
  {
    id: '05-partial-reset',
    expectedEvents: ['event=tcp_intake_socket_error'],
    warningCount: 1,
    requiredFragments: ['socketError=SE_ECONNRESET', 'socketCode=26'],
  },
  {
    id: '06-empty-close-after-reset',
    expectedEvents: [],
    optionalEvents: ['event=tcp_peer_closed_empty'],
    warningCount: 0,
    forbiddenEvents: ['event=tcp_intake_socket_error'],
    forbiddenFragments: ['SE_ECONNRESET', 'socketCode=26'],
  },
  { id: '07-framed-ping-after-reset', expectedEvents: [], warningCount: 0 },
  {
    id: '08-invalid-json-sentinel',
    expectedEvents: ['event=tcp_intake_malformed'],
    warningCount: 1,
  },
  {
    id: '09-invalid-utf8',
    expectedEvents: ['event=tcp_intake_malformed'],
    warningCount: 1,
  },
  {
    id: '10-duplicate-content-length',
    expectedEvents: ['event=tcp_intake_malformed'],
    warningCount: 1,
  },
  {
    id: '11-oversized-declaration',
    expectedEvents: ['event=tcp_intake_too_large'],
    warningCount: 1,
  },
  {
    id: '12-idle-timeout',
    expectedEvents: ['event=tcp_intake_idle_timeout'],
    warningCount: 1,
  },
  {
    id: '13-total-timeout-trickle',
    expectedEvents: ['event=tcp_intake_total_timeout'],
    warningCount: 1,
  },
  {
    id: '14-animgraph-response-reset',
    expectedEvents: ['event=tcp_send_failure'],
    warningCount: 1,
  },
  { id: '15-final-framed-ping', expectedEvents: [], warningCount: 0 },
];
const expectedLiveFaultProbeIds = expectedLiveFaultProbeContracts.map((probe) => probe.id);

function probeContractsEqual(actual, expected) {
  return isDeepStrictEqual(actual, expected);
}

async function replaceFileContentsInPlace(filePath, bytes) {
  const fileHandle = await open(filePath, 'r+');
  try {
    await fileHandle.truncate(0);
    let bytesWritten = 0;
    while (bytesWritten < bytes.length) {
      const result = await fileHandle.write(
        bytes, bytesWritten, bytes.length - bytesWritten, bytesWritten,
      );
      if (result.bytesWritten === 0) throw new Error('temporary log replacement made no progress');
      bytesWritten += result.bytesWritten;
    }
    await fileHandle.sync();
  } finally {
    await fileHandle.close();
  }
}

let liveTcpSmokeSource = '';
let liveTcpSmokeModule = null;
let liveTcpSmokeLoadError = null;
try {
  liveTcpSmokeSource = await readFile(liveTcpSmokeUrl, 'utf8');
  liveTcpSmokeModule = await import(liveTcpSmokeUrl.href);
} catch (error) {
  liveTcpSmokeLoadError = error;
}

runner.assert(discoverLiveSmokeScripts().includes('live-smoke-tcp-transport.mjs'),
  'live fault smoke is discovered by run-live-smoke');
runner.assert(liveTcpSmokeLoadError === null && liveTcpSmokeModule !== null,
  'live fault smoke is safe to import for pure helper tests', liveTcpSmokeLoadError?.message);
runner.assert(liveTcpSmokeSource.includes("from './live-smoke-harness.mjs'")
  && liveTcpSmokeSource.includes('prepareLiveSmoke({')
  && /if\s*\(isMain\(\)\)/.test(liveTcpSmokeSource),
'live fault smoke uses prepareLiveSmoke only from an explicit main path');
runner.assert(liveTcpSmokeSource.includes("from 'node:net'")
  && liveTcpSmokeSource.includes('TcpResponseDecoder')
  && liveTcpSmokeSource.includes("const TCP_HOST = '127.0.0.1'")
  && liveTcpSmokeSource.includes('smoke.cm.config.tcpPortCustom')
  && !liveTcpSmokeSource.includes('UNREAL_TCP_PORT_CUSTOM'),
'live fault smoke raw sockets bind only to 127.0.0.1 and the selected connection-manager port');
runner.assert(liveTcpSmokeSource.includes("readdir(projectRoot, { withFileTypes: true })")
  && liveTcpSmokeSource.includes("extname(entry.name).toLowerCase() === '.uproject'")
  && liveTcpSmokeSource.includes('basename(uprojectPath, extname(uprojectPath))')
  && liveTcpSmokeSource.includes("join(projectRoot, 'Saved', 'Logs', projectName + '.log')")
  && /exactly one top-level \.uproject/i.test(liveTcpSmokeSource),
'live fault smoke requires exactly one top-level uproject and derives its active log path');
runner.assert(liveTcpSmokeSource.includes('fileHandle.read(')
  && liveTcpSmokeSource.includes('cursor.offset')
  && liveTcpSmokeSource.includes('mtimeMs')
  && liveTcpSmokeSource.includes('birthtimeMs')
  && /rotat|identity/i.test(liveTcpSmokeSource)
  && /truncat/i.test(liveTcpSmokeSource),
'live fault smoke reads appended log bytes by byte offset and rejects rotation or truncation');
const createLogCursorSourceStart = liveTcpSmokeSource.indexOf('async function createLogCursor(');
const createLogCursorSourceEnd = liveTcpSmokeSource.indexOf(
  '\nasync function assertLogAnchorUnchanged(', createLogCursorSourceStart,
);
const createLogCursorSource = liveTcpSmokeSource.slice(
  createLogCursorSourceStart, createLogCursorSourceEnd,
);
runner.assert(createLogCursorSourceStart >= 0
  && createLogCursorSourceEnd > createLogCursorSourceStart
  && createLogCursorSource.includes('async function createLogCursor(logPath)')
  && createLogCursorSource.includes('const initialStat = await fileHandle.stat()')
  && createLogCursorSource.includes('const afterAnchorStat = await fileHandle.stat()')
  && createLogCursorSource.includes('observeLogHighWater(cursor, afterAnchorStat)')
  && createLogCursorSource.includes('observeLogHighWater(cursor, afterPathStat)')
  && liveTcpSmokeSource.includes('const cursor = await createLogCursor(logPath);'),
'live fault smoke records offset, anchor, and observed high-water from one opened log handle');
runner.assert(expectedLiveFaultProbeIds.every((probeId) => liveTcpSmokeSource.includes(probeId)),
  'live fault smoke defines all fifteen deterministic probe IDs');
runner.assert(requiredIntakeEvents.concat('event=tcp_send_failure').every(
  (event) => liveTcpSmokeSource.includes(event),
), 'live fault smoke attributes exact Task 6 event tokens');
runner.assert(liveTcpSmokeSource.includes('beforeSegment')
  && liveTcpSmokeSource.includes('afterSegment')
  && liveTcpSmokeSource.includes('waitForStableAppendedSegment')
  && liveTcpSmokeSource.includes('extractTcpEventLines'),
'live fault smoke separates stabilized before/after probe log segments');
runner.assert(liveTcpSmokeSource.includes('assertNoDelayedTcpEvents(beforeSegment, probe.id)')
  && liveTcpSmokeSource.includes('assertNoPayloadLeak([beforeSegment])')
  && liveTcpSmokeSource.includes('assertNoPayloadLeak([afterSegment])')
  && liveTcpSmokeSource.includes('assertNoPayloadLeak([finalSegment])')
  && liveTcpSmokeSource.includes('assertNoTokenlessTransportWarnings(beforeSegment')
  && liveTcpSmokeSource.includes('assertNoTokenlessTransportWarnings(afterSegment'),
'live fault smoke immediately leak-checks every committed probe and final-tail segment');
runner.assert(liveTcpSmokeSource.includes("assertNoDelayedTcpEvents(finalSegment, 'final tail')")
  && liveTcpSmokeSource.includes("assertNoTokenlessTransportWarnings(finalSegment, 'final tail')"),
'live fault smoke rejects delayed exact events and tokenless transport warnings in the final tail');
const stableSegmentSourceStart = liveTcpSmokeSource.indexOf(
  'export async function waitForStableAppendedSegment(',
);
const stableSegmentSourceEnd = liveTcpSmokeSource.indexOf(
  '\nfunction frameBody(', stableSegmentSourceStart,
);
const stableSegmentSource = liveTcpSmokeSource.slice(
  stableSegmentSourceStart, stableSegmentSourceEnd,
);
runner.assert(stableSegmentSourceStart >= 0
  && stableSegmentSourceEnd > stableSegmentSourceStart
  && stableSegmentSource.includes('await ingestAppendedLogBytes(logPath, cursor, currentStat)')
  && stableSegmentSource.includes('transportEvidenceFingerprint(cursor.pendingText)')
  && stableSegmentSource.includes('commitPendingLogSegment(logPath, cursor)')
  && !stableSegmentSource.includes('previewCursor')
  && !stableSegmentSource.includes('previousSize')
  && !stableSegmentSource.includes('previousMtimeMs'),
'live fault smoke persists high-water and pending evidence while stabilizing without suffix rereads');
runner.assert(liveTcpSmokeSource.includes("new TextDecoder('utf-8', { fatal: true })")
  && liveTcpSmokeSource.includes('const LOG_READ_CHUNK_BYTES = 64 * 1024;')
  && liveTcpSmokeSource.includes('const LOG_SEGMENT_MAX_BYTES = 4 * 1024 * 1024;')
  && liveTcpSmokeSource.includes('Buffer.allocUnsafe(LOG_READ_CHUNK_BYTES)')
  && liveTcpSmokeSource.includes('appendDecodedLogBytes(cursor,')
  && !liveTcpSmokeSource.includes('Buffer.alloc(byteCount)')
  && liveTcpSmokeSource.includes('const afterReadStat = await stat(logPath)')
  && liveTcpSmokeSource.includes('validateLogContinuation(cursor, afterReadStat)'),
'live fault smoke incrementally consumes bounded chunks with strict UTF-8 and post-read identity checks');
const digestLogRangeSourceStart = liveTcpSmokeSource.indexOf('async function digestLogRange(');
const digestLogRangeSourceEnd = liveTcpSmokeSource.indexOf(
  '\nexport async function createLogCursor(', digestLogRangeSourceStart,
);
const digestLogRangeSource = liveTcpSmokeSource.slice(
  digestLogRangeSourceStart, digestLogRangeSourceEnd,
);
runner.assert(!liveTcpSmokeSource.includes(
  'if (targetOffset === cursor.readOffset) return cursor.pendingText;',
)
  && digestLogRangeSourceStart >= 0
  && digestLogRangeSourceEnd > digestLogRangeSourceStart
  && digestLogRangeSource.includes('Buffer.allocUnsafe(LOG_READ_CHUNK_BYTES)')
  && digestLogRangeSource.includes('while (bytesRead < byteCount)')
  && digestLogRangeSource.includes('Math.min(LOG_READ_CHUNK_BYTES, byteCount - bytesRead)')
  && !digestLogRangeSource.includes('Buffer.alloc(byteCount)')
  && liveTcpSmokeSource.includes('assertMatchingPendingDigest('),
'live fault orchestration checks unchanged-size anchors and chunk-digests pending evidence');
runner.assert(liveTcpSmokeSource.includes('UEMCP_SECRET_PAYLOAD_SENTINEL')
  && liveTcpSmokeSource.includes('assertNoPayloadLeak')
  && liveTcpSmokeSource.includes('for (const segment of segments)'),
'live fault smoke checks every appended segment for sentinel and raw previews');
runner.assert(liveTcpSmokeSource.includes('function scanJsonCompositeCandidates(')
  && liveTcpSmokeSource.includes('const delimiterStack = [];')
  && liveTcpSmokeSource.includes('for (const candidate of scanJsonCompositeCandidates(message))')
  && !liveTcpSmokeSource.includes('function scanJsonObjectCandidates(')
  && !liveTcpSmokeSource.includes('function parseJsonObjectCandidate(')
  && !liveTcpSmokeSource.includes("const start = message.indexOf('{');"),
'live fault payload classifier preserves assignment context across balanced JSON composites');
runner.assert((liveTcpSmokeSource.match(/resetAndDestroy\(\)/g) ?? []).length >= 2,
  'live fault smoke resets the partial request and first AnimGraph response chunk');
const closePeerSourceStart = liveTcpSmokeSource.indexOf('function closePeer(');
const closePeerSourceEnd = liveTcpSmokeSource.indexOf('\nfunction assertNoResponse(', closePeerSourceStart);
const closePeerSource = liveTcpSmokeSource.slice(closePeerSourceStart, closePeerSourceEnd);
runner.assert(closePeerSourceStart >= 0
  && closePeerSourceEnd > closePeerSourceStart
  && closePeerSource.includes('socket.setNoDelay(true)')
  && closePeerSource.includes('await sleep(PARTIAL_WRITE_DELAY_MS)'),
'partial prefix/header/body close disables Nagle coalescing and spaces each raw write');
runner.assert(liveTcpSmokeSource.includes('TCP_MAX_REQUEST_BODY_BYTES + 1')
  && !/Buffer\.alloc(?:Unsafe)?\s*\(\s*(?:TCP_MAX_REQUEST_BODY_BYTES|OVERSIZED)/.test(liveTcpSmokeSource),
'oversized declaration probe sends only its header without allocating the declared body');
runner.assert(liveTcpSmokeSource.includes('const IDLE_HOLD_MS = 2250;')
  && liveTcpSmokeSource.includes('const TRICKLE_INTERVAL_MS = 1500;')
  && liveTcpSmokeSource.includes("assertErrorCode(response, 'MALFORMED_REQUEST'")
  && liveTcpSmokeSource.includes("assertErrorCode(response, 'REQUEST_TOO_LARGE'")
  && liveTcpSmokeSource.includes("assertErrorCode(response, 'REQUEST_TIMEOUT'")
  && liveTcpSmokeSource.includes('assertNoResponse'),
'live fault smoke enforces the approved idle/trickle timing and typed response/no-response contracts');
runner.assert(liveTcpSmokeSource.includes('socketError=SE_ECONNRESET')
  && liveTcpSmokeSource.includes('socketCode=26')
  && !liveTcpSmokeSource.includes('assertNoInheritedReset(afterSegment)')
  && liveTcpSmokeSource.includes('assertWarningCount'),
'live fault smoke scopes translated reset attribution to exact event metadata and warning ownership');
runner.assert(liveTcpSmokeSource.includes("String(process.env.UEMCP_LIVE_ANIM_BLUEPRINT || '').trim()")
  && liveTcpSmokeSource.includes("asset_path: animBlueprintPath")
  && liveTcpSmokeSource.includes('include_transitions: true')
  && liveTcpSmokeSource.includes('include_node_properties: true')
  && liveTcpSmokeSource.includes('include_pin_topology: true')
  && liveTcpSmokeSource.includes('include_pin_defaults: true'),
'large AnimGraph reset probe uses the required environment asset and exact full-read request');
const liveTcpAssetGate = liveTcpSmokeSource.indexOf(
  "const animBlueprintPath = String(process.env.UEMCP_LIVE_ANIM_BLUEPRINT || '').trim();",
);
runner.assert(liveTcpAssetGate >= 0
  && liveTcpAssetGate < liveTcpSmokeSource.indexOf(
    "const smoke = await prepareLiveSmoke({ name: 'live-smoke-tcp-transport' });",
  ), 'live fault smoke skips a missing AnimGraph env before any harness probe');
runner.assert(!/\b(?:save_asset|compile_blueprint|delete_asset|rename_asset|duplicate_asset|run_python_command)\b/i
  .test(liveTcpSmokeSource)
  && !/\bpython\b/i.test(liveTcpSmokeSource),
'live fault smoke contains no asset mutation or Python route');

const requiredLiveSmokeHelpers = [
  'TCP_FAULT_PROBES',
  'resolveProjectLogPath',
  'validateLogContinuation',
  'extractTcpEventLines',
  'assertProbeEventContract',
  'assertNoDelayedTcpEvents',
  'assertNoTokenlessTransportWarnings',
  'assertNoPayloadLeak',
  'transportEvidenceFingerprint',
  'deriveSocketProbeTimeoutMs',
  'assertMatchingLogAnchor',
  'decodeCompleteUtf8Prefix',
  'buildOversizedDeclarationProbeBytes',
  'assertIncompleteFirstResponseChunk',
  'observeLogHighWater',
  'appendDecodedLogBytes',
  'commitLogEvidence',
  'createLogCursor',
  'ingestAppendedLogBytes',
  'commitPendingLogSegment',
];
runner.assert(liveTcpSmokeModule !== null && requiredLiveSmokeHelpers.every(
  (name) => liveTcpSmokeModule[name] !== undefined,
), 'live fault smoke exports pure log/path/attribution helper contracts');

if (liveTcpSmokeModule !== null) {
  const {
    TCP_FAULT_PROBES,
    resolveProjectLogPath,
    validateLogContinuation,
    extractTcpEventLines,
    assertProbeEventContract,
    assertNoDelayedTcpEvents,
    assertNoTokenlessTransportWarnings,
    assertNoPayloadLeak,
    transportEvidenceFingerprint,
    deriveSocketProbeTimeoutMs,
    assertMatchingLogAnchor,
    decodeCompleteUtf8Prefix,
    buildOversizedDeclarationProbeBytes,
    assertIncompleteFirstResponseChunk,
    observeLogHighWater,
    appendDecodedLogBytes,
    commitLogEvidence,
    createLogCursor,
    ingestAppendedLogBytes,
    commitPendingLogSegment,
  } = liveTcpSmokeModule;

  runner.assert(probeContractsEqual(TCP_FAULT_PROBES, expectedLiveFaultProbeContracts),
    'live fault helper independently pins probe order, event ownership, warning counts, and reset metadata');
  const reorderedProbeContracts = expectedLiveFaultProbeContracts.map((probe) => (
    Object.fromEntries(Object.entries(probe).reverse())
  ));
  runner.assert(probeContractsEqual(TCP_FAULT_PROBES, reorderedProbeContracts),
    'live fault probe contract comparison ignores object property insertion order');

  const derivedLogPath = resolveProjectLogPath('D:/GenericProject', ['GenericProject.uproject']);
  runner.assert(derivedLogPath.replaceAll('\\', '/').endsWith('/Saved/Logs/GenericProject.log'),
    'live fault path helper derives Saved/Logs/<project>.log');
  const uppercaseDerivedLogPath = resolveProjectLogPath(
    'D:/GenericProject', ['GenericProject.UPROJECT'],
  );
  runner.assert(uppercaseDerivedLogPath.replaceAll('\\', '/').endsWith('/Saved/Logs/GenericProject.log'),
    'live fault path helper derives the active log for a case-insensitive uproject extension');
  await runner.assertRejects(
    () => Promise.resolve().then(() => resolveProjectLogPath('D:/GenericProject', [])),
    /exactly one top-level \.uproject/i,
    'live fault path helper rejects a missing top-level uproject',
  );
  await runner.assertRejects(
    () => Promise.resolve().then(() => resolveProjectLogPath(
      'D:/GenericProject', ['One.uproject', 'Two.uproject'],
    )),
    /exactly one top-level \.uproject/i,
    'live fault path helper rejects multiple top-level uprojects',
  );

  const logCursor = {
    dev: 7,
    ino: 11,
    birthtimeMs: 100,
    mtimeMs: 200,
    offset: 16,
  };
  runner.assert(validateLogContinuation(logCursor, {
    dev: 7,
    ino: 11,
    birthtimeMs: 100,
    mtimeMs: 201,
    size: 32,
  }).size === 32, 'live fault log helper accepts an append on the same file identity');
  await runner.assertRejects(
    () => Promise.resolve().then(() => validateLogContinuation(logCursor, {
      dev: 7, ino: 12, birthtimeMs: 101, mtimeMs: 201, size: 32,
    })),
    /rotat|identity/i,
    'live fault log helper rejects file rotation',
  );
  await runner.assertRejects(
    () => Promise.resolve().then(() => validateLogContinuation(logCursor, {
      dev: 7, ino: 11, birthtimeMs: 100, mtimeMs: 201, size: 15,
    })),
    /truncat/i,
    'live fault log helper rejects truncation below the byte cursor',
  );
  await runner.assertRejects(
    () => Promise.resolve().then(() => validateLogContinuation({
      ...logCursor,
      observedSize: 40,
    }, {
      dev: 7, ino: 11, birthtimeMs: 100, mtimeMs: 201, size: 32,
    })),
    /truncat|size|regress/i,
    'live fault log helper rejects size regression below its observed high-water mark',
  );
  const persistentObservationCursor = {
    dev: 7,
    ino: 11,
    birthtimeMs: 100,
    mtimeMs: 200,
    offset: 16,
    readOffset: 16,
    observedSize: 16,
  };
  runner.assert(observeLogHighWater?.(persistentObservationCursor, {
    dev: 7, ino: 11, birthtimeMs: 100, mtimeMs: 201, size: 48,
  }) === persistentObservationCursor && persistentObservationCursor.observedSize === 48,
  'live fault preview observation persists the file-size high-water on the shared cursor');
  await runner.assertRejects(
    () => Promise.resolve().then(() => observeLogHighWater?.(persistentObservationCursor, {
      dev: 7, ino: 11, birthtimeMs: 100, mtimeMs: 202, size: 32,
    })),
    /high-water|regress|truncat/i,
    'live fault persistent preview high-water rejects later truncate and regrow below 48 bytes',
  );
  const stableAnchor = Buffer.from('stable original log tail', 'utf8');
  runner.assert(assertMatchingLogAnchor?.(stableAnchor, Buffer.from(stableAnchor)) === true,
    'live fault log helper accepts an unchanged original-tail byte anchor');
  await runner.assertRejects(
    () => Promise.resolve().then(() => assertMatchingLogAnchor?.(
      stableAnchor, Buffer.from('replacement log tail', 'utf8'),
    )),
    /truncat|rotat|anchor|replaced/i,
    'live fault log helper rejects same-file truncation and regrowth that replaces prior bytes',
  );

  const partialUtf8 = decodeCompleteUtf8Prefix?.(
    Buffer.from([0x61, 0x62, 0x63, 0xe2, 0x82]),
  );
  runner.assert(partialUtf8?.text === 'abc' && partialUtf8?.bytesConsumed === 3,
    'live fault log decoder retains a trailing partial UTF-8 code point for the next append');
  const completedUtf8 = decodeCompleteUtf8Prefix?.(Buffer.from([0xe2, 0x82, 0xac, 0x0a]));
  runner.assert(completedUtf8?.text === '€\n' && completedUtf8?.bytesConsumed === 4,
    'live fault log decoder consumes a complete appended UTF-8 code point');
  await runner.assertRejects(
    () => Promise.resolve().then(() => decodeCompleteUtf8Prefix?.(
      Buffer.from([0x61, 0xc0, 0xaf]),
    )),
    /encoded data|utf-?8|decode/i,
    'live fault log decoder rejects malformed UTF-8 instead of hiding it as an incomplete tail',
  );

  const streamingCursor = {
    offset: 100,
    readOffset: 100,
    pendingByteCount: 0,
    pendingText: '',
    pendingUtf8: Buffer.alloc(0),
  };
  const utf8LinePrefix = Buffer.concat([
    Buffer.from('LogUEMCP: Display: value=', 'ascii'),
    Buffer.from([0xe2, 0x82]),
  ]);
  runner.assert(appendDecodedLogBytes?.(streamingCursor, utf8LinePrefix, {
    maxSegmentBytes: 128,
  }) === streamingCursor
    && streamingCursor.readOffset === 100 + utf8LinePrefix.length
    && streamingCursor.pendingByteCount === utf8LinePrefix.length
    && streamingCursor.pendingUtf8.equals(Buffer.from([0xe2, 0x82]))
    && streamingCursor.pendingText === 'LogUEMCP: Display: value=',
  'live fault bounded intake retains a split UTF-8 suffix without skipping read bytes');
  const utf8LineSuffix = Buffer.from([0xac, 0x0a]);
  runner.assert(appendDecodedLogBytes?.(streamingCursor, utf8LineSuffix, {
    maxSegmentBytes: 128,
  }) === streamingCursor
    && streamingCursor.pendingUtf8.length === 0
    && streamingCursor.pendingText.endsWith('value=€\n')
    && streamingCursor.pendingByteCount === utf8LinePrefix.length + utf8LineSuffix.length,
  'live fault bounded intake completes strict UTF-8 across chunks and retains the full line');

  const boundedCursor = {
    offset: 0,
    readOffset: 0,
    pendingByteCount: 0,
    pendingText: '',
    pendingUtf8: Buffer.alloc(0),
  };
  appendDecodedLogBytes?.(boundedCursor, Buffer.from('1234', 'ascii'), { maxSegmentBytes: 4 });
  await runner.assertRejects(
    () => Promise.resolve().then(() => appendDecodedLogBytes?.(
      boundedCursor, Buffer.from('5', 'ascii'), { maxSegmentBytes: 4 },
    )),
    /bounded|limit|maximum|segment/i,
    'live fault bounded intake fails explicitly before an appended segment exceeds its byte cap',
  );
  runner.assert(boundedCursor.readOffset === 4 && boundedCursor.pendingByteCount === 4,
    'live fault bounded intake does not advance or skip the rejected overflow byte');

  const malformedStreamingCursor = {
    offset: 0,
    readOffset: 0,
    pendingByteCount: 0,
    pendingText: '',
    pendingUtf8: Buffer.alloc(0),
  };
  appendDecodedLogBytes?.(malformedStreamingCursor, Buffer.from([0xe2]), {
    maxSegmentBytes: 8,
  });
  await runner.assertRejects(
    () => Promise.resolve().then(() => appendDecodedLogBytes?.(
      malformedStreamingCursor, Buffer.from('x', 'ascii'), { maxSegmentBytes: 8 },
    )),
    /encoding|utf-8|invalid/i,
    'live fault bounded intake rejects malformed UTF-8 across a chunk boundary',
  );
  runner.assert(malformedStreamingCursor.readOffset === 1
    && malformedStreamingCursor.pendingByteCount === 1
    && malformedStreamingCursor.pendingText === ''
    && malformedStreamingCursor.pendingUtf8.equals(Buffer.from([0xe2])),
  'live fault malformed UTF-8 rejection preserves the uncommitted cursor without skipping bytes');

  const committedBoundary = streamingCursor.readOffset;
  const committedAnchor = Buffer.alloc(Math.min(256, committedBoundary), 0x61);
  const committedText = commitLogEvidence?.(streamingCursor, {
    boundaryOffset: committedBoundary,
    mtimeMs: 205,
    anchorOffset: committedBoundary - committedAnchor.length,
    anchorBytes: committedAnchor,
  });
  runner.assert(committedText?.endsWith('value=€\n')
    && streamingCursor.offset === committedBoundary
    && streamingCursor.readOffset === committedBoundary
    && streamingCursor.anchorOffset === committedBoundary - committedAnchor.length
    && streamingCursor.anchorBytes.equals(committedAnchor)
    && streamingCursor.pendingByteCount === 0
    && streamingCursor.pendingText === ''
    && streamingCursor.pendingUtf8.length === 0,
  'live fault commit rolls the integrity anchor to the committed cursor boundary and clears evidence');

  const observedTailCursor = {
    offset: 0,
    readOffset: 5,
    observedSize: 8,
    pendingByteCount: 5,
    pendingText: 'line\n',
    pendingUtf8: Buffer.alloc(0),
  };
  await runner.assertRejects(
    () => Promise.resolve().then(() => commitLogEvidence?.(observedTailCursor, {
      boundaryOffset: 5,
      mtimeMs: 1,
      anchorOffset: 0,
      anchorBytes: Buffer.alloc(5),
    })),
    /high-water|observed|uninspected/i,
    'live fault commit rejects a boundary that would leave observed log bytes uninspected',
  );
  runner.assert(observedTailCursor.offset === 0
    && observedTailCursor.readOffset === 5
    && observedTailCursor.pendingByteCount === 5
    && observedTailCursor.pendingText === 'line\n',
  'live fault rejected commit preserves all pending evidence for the next bounded intake');

  const incompleteLineCursor = {
    offset: 0,
    readOffset: 7,
    pendingByteCount: 7,
    pendingText: 'partial',
    pendingUtf8: Buffer.alloc(0),
  };
  await runner.assertRejects(
    () => Promise.resolve().then(() => commitLogEvidence?.(incompleteLineCursor, {
      boundaryOffset: 7,
      mtimeMs: 1,
      anchorOffset: 0,
      anchorBytes: Buffer.alloc(7),
    })),
    /complete log line|newline|incomplete/i,
    'live fault commit fails explicitly instead of splitting an uninspected log line',
  );

  if (typeof createLogCursor === 'function'
    && typeof ingestAppendedLogBytes === 'function'
    && typeof commitPendingLogSegment === 'function') {
    const tempLogRoot = await mkdtemp(join(tmpdir(), 'uemcp-tcp-log-evidence-'));
    try {
      const emptyPath = join(tempLogRoot, 'empty-path.log');
      const emptyOriginal = Buffer.alloc(512, 0x41);
      const emptyReplacement = Buffer.alloc(512, 0x42);
      await writeFile(emptyPath, emptyOriginal);
      const emptyCursor = await createLogCursor(emptyPath);
      await replaceFileContentsInPlace(emptyPath, emptyReplacement);
      await runner.assertRejects(
        async () => ingestAppendedLogBytes(emptyPath, emptyCursor, await stat(emptyPath)),
        /anchor|changed|replaced|rotat|truncat/i,
        'live fault empty intake detects same-size truncate and regrow through the committed anchor',
      );

      const pendingPath = join(tempLogRoot, 'pending-path.log');
      const committedPrefix = Buffer.alloc(512, 0x43);
      const pendingPrefix = 'LogUEMCP: Display: pending=';
      const pendingBody = 'a'.repeat((64 * 1024 * 2) + 17);
      const pendingOriginal = Buffer.from(`${pendingPrefix}${pendingBody}\n`, 'utf8');
      const pendingReplacement = Buffer.from(
        `${pendingPrefix}${pendingBody.slice(0, -1)}b\n`, 'utf8',
      );
      runner.assert(pendingOriginal.length === pendingReplacement.length
        && pendingOriginal.length > 64 * 1024,
      'live fault pending orchestration fixture is same-size and spans multiple bounded chunks');
      await writeFile(pendingPath, committedPrefix);
      const pendingCursor = await createLogCursor(pendingPath);
      await appendFile(pendingPath, pendingOriginal);
      await ingestAppendedLogBytes(pendingPath, pendingCursor, await stat(pendingPath));
      runner.assert(pendingCursor.pendingByteCount === pendingOriginal.length
        && pendingCursor.pendingText.endsWith('\n'),
      'live fault pending orchestration ingests the complete multi-chunk evidence range');
      await replaceFileContentsInPlace(
        pendingPath, Buffer.concat([committedPrefix, pendingReplacement]),
      );
      await runner.assertRejects(
        () => commitPendingLogSegment(pendingPath, pendingCursor),
        /digest|evidence|changed|replaced|rotat|truncat/i,
        'live fault pending commit detects same-size replacement across bounded digest chunks',
      );
    } finally {
      await rm(tempLogRoot, { recursive: true, force: true });
    }
  } else {
    runner.assert(false,
      'live fault exports actual cursor, intake, and commit orchestration for temp-file tests');
  }

  const eventLines = extractTcpEventLines([
    'background editor output',
    'LogUEMCP: Warning: event=tcp_intake_malformed framing=framed',
    'LogUEMCP: display without a transport event',
  ].join('\r\n'));
  runner.assert(eventLines.length === 1
    && eventLines[0].includes('event=tcp_intake_malformed'),
  'live fault attribution ignores background non-event lines');
  runner.assert(assertProbeEventContract({
    id: 'test-probe',
    expectedEvents: ['event=tcp_intake_malformed'],
    forbiddenEvents: ['event=tcp_intake_socket_error'],
  }, eventLines) === true, 'live fault attribution accepts exactly owned event tokens');
  await runner.assertRejects(
    () => Promise.resolve().then(() => assertProbeEventContract({
      id: 'duplicate-optional-event',
      expectedEvents: [],
      optionalEvents: ['event=tcp_peer_closed_empty'],
    }, [
      'LogUEMCP: Verbose: event=tcp_peer_closed_empty bytes=0',
      'LogUEMCP: Verbose: event=tcp_peer_closed_empty bytes=0',
    ])),
    /optional event|exactly one/i,
    'live fault attribution rejects duplicate optional lifecycle events',
  );

  const unrelatedWarningSegment = [
    'LogUEMCP: Warning: background asset compiler warning',
    'LogTemp: Warning: recv failed: socket error 0',
    'LogUEMCP: Display: failed to send response',
  ].join('\n');
  runner.assert(assertNoTokenlessTransportWarnings?.(
    unrelatedWarningSegment, 'background-only segment',
  ) === true, 'live fault attribution ignores unrelated background warnings');

  const tokenlessTransportWarnings = [
    'LogUEMCP: Warning: recv failed: socket error 0',
    'LogUEMCP: Warning: request incomplete before parse (bytes=8)',
    'LogUEMCP: Warning: send failed after 12/100 bytes: socket error 26',
    'LogUEMCP: Warning: failed to send response',
  ];
  for (const [index, warning] of tokenlessTransportWarnings.entries()) {
    let rejection = null;
    try {
      assertNoTokenlessTransportWarnings?.(warning, `tokenless-warning-${index}`);
    } catch (error) {
      rejection = error;
    }
    runner.assert(rejection instanceof Error
      && /tokenless transport warning/i.test(rejection.message),
    `live fault attribution rejects tokenless transport warning ${index + 1}`);
  }
  const structuralTransportWarnings = [
    'LogUEMCP: Warning: response write error: socket error 26',
    'LogUEMCP: Warning: socket error 26 while writing response',
    'LogUEMCP: Warning: request read failure: socket error 26',
    'LogUEMCP: Warning: socket failure during request intake',
    'LogUEMCP: Warning: peer closed after socket error 26',
    'LogUEMCP: Warning: socket failure while receiving request bytes',
    'LogUEMCP: Warning: socket failure while sending response bytes',
  ];
  for (const [index, warning] of structuralTransportWarnings.entries()) {
    let rejection = null;
    try {
      assertNoTokenlessTransportWarnings?.(warning, `structural-warning-${index}`);
    } catch (error) {
      rejection = error;
    }
    runner.assert(rejection instanceof Error
      && /tokenless transport warning/i.test(rejection.message),
    `live fault attribution rejects structural transport warning ${index + 1}`);
  }
  runner.assert(assertNoTokenlessTransportWarnings?.([
    'LogUEMCP: Warning: response cache write error: socket error 26',
    'LogUEMCP: Warning: request asset read failure: socket error 26',
    'LogUEMCP: Warning: response write validation failed',
    'LogUEMCP: Warning: socket failure while saving response metrics',
  ].join('\n'), 'unrelated structural warnings') === true,
  'live fault attribution ignores UEMCP warnings without both lifecycle and socket-failure context');
  runner.assert(assertNoTokenlessTransportWarnings?.(
    'LogUEMCP: Warning: event=tcp_send_failure sentBytes=12 totalBytes=100',
    'exact-token segment',
  ) === true, 'live fault attribution leaves exact-token warnings to event ownership');

  const benignStructuredBackgroundSegment = [
    'LogBlueprint: Display: cached request {"type":"preview","params":{"node":"Idle"}}',
    'LogHttp: Display: Content-Length: 128',
    'LogTemp: Warning: prior socket details SE_ECONNRESET socketCode=26',
    'LogUEMCP: Verbose: event=tcp_peer_closed_empty bytes=0',
  ].join('\n');
  const cleanCloseProbe = TCP_FAULT_PROBES.find(
    (probe) => probe.id === '06-empty-close-after-reset',
  );
  const benignStructuredEventLines = extractTcpEventLines(benignStructuredBackgroundSegment);
  let benignStructuredAcceptance = null;
  try {
    benignStructuredAcceptance = assertNoPayloadLeak?.([benignStructuredBackgroundSegment]) === true
      && assertNoTokenlessTransportWarnings?.(
        benignStructuredBackgroundSegment, 'benign structured background segment',
      ) === true
      && assertProbeEventContract?.(cleanCloseProbe, benignStructuredEventLines) === true;
  } catch (error) {
    benignStructuredAcceptance = error;
  }
  runner.assert(benignStructuredAcceptance === true,
    'live fault attribution accepts benign background reset, JSON, and framing text',
    benignStructuredAcceptance?.message);
  await runner.assertRejects(
    () => Promise.resolve().then(() => assertProbeEventContract?.(
      cleanCloseProbe,
      extractTcpEventLines(
        'LogUEMCP: Verbose: event=tcp_peer_closed_empty socketError=SE_ECONNRESET socketCode=26',
      ),
    )),
    /forbidden log metadata|SE_ECONNRESET|socketCode/i,
    'live fault attribution rejects reset metadata on the exact owned clean-close event',
  );

  const backgroundFingerprint = transportEvidenceFingerprint?.(unrelatedWarningSegment);
  const continuedBackgroundFingerprint = transportEvidenceFingerprint?.([
    unrelatedWarningSegment,
    'LogBlueprint: Display: continuous unrelated editor output',
  ].join('\n'));
  const exactEventFingerprint = transportEvidenceFingerprint?.([
    unrelatedWarningSegment,
    'LogUEMCP: Warning: event=tcp_intake_malformed framing=framed',
  ].join('\n'));
  const tokenlessWarningFingerprint = transportEvidenceFingerprint?.([
    unrelatedWarningSegment,
    'LogUEMCP: Warning: recv failed: socket error 0',
  ].join('\n'));
  const structuralWarningFingerprint = transportEvidenceFingerprint?.([
    unrelatedWarningSegment,
    'LogUEMCP: Warning: response write error: socket error 26',
  ].join('\n'));
  runner.assert(typeof backgroundFingerprint === 'string'
    && backgroundFingerprint === continuedBackgroundFingerprint
    && exactEventFingerprint !== backgroundFingerprint
    && tokenlessWarningFingerprint !== backgroundFingerprint
    && structuralWarningFingerprint !== backgroundFingerprint,
  'live fault transport evidence fingerprint ignores background growth but tracks transport evidence');

  runner.assert(assertNoDelayedTcpEvents?.('background editor output', 'pure-clean') === true,
    'live fault delayed-event helper accepts a segment without exact transport events');
  let delayedEventRejection = null;
  try {
    assertNoDelayedTcpEvents?.(
      'LogUEMCP: Warning: event=tcp_intake_malformed framing=framed', 'pure-delayed',
    );
  } catch (error) {
    delayedEventRejection = error;
  }
  runner.assert(delayedEventRejection instanceof Error
    && /delayed prior transport event/i.test(delayedEventRejection.message),
  'live fault delayed-event helper rejects an exact transport event');

  runner.assert(assertNoPayloadLeak(['first appended segment', 'second appended segment']) === true,
    'live fault leak helper accepts clean appended segments');
  runner.assert(assertNoPayloadLeak([
    'LogUEMCP: Display: response_bytes=1024 response_status=success response_code=OK '
      + 'body_bytes=100 payload_bytes=100',
  ]) === true, 'live fault leak helper permits response byte, status, and code metadata');
  let nestedMetricsAcceptance = null;
  const escapedBraceMetrics = JSON.stringify({
    type: 'counter',
    note: 'quoted "{not an object}" and escaped \\ path',
  });
  const escapedCompositeMetrics = JSON.stringify([
    { type: 'counter', note: 'quoted "] }" and "{ [" with escaped \\ path' },
    { status: 'healthy', value: 1 },
  ]);
  try {
    nestedMetricsAcceptance = assertNoPayloadLeak([
      'LogUEMCP: Display: metrics={"status":"ready","queue_depth":0}',
      'LogUEMCP: Display: metrics={"type":"counter","value":1}',
      'LogUEMCP: Display: health={"status":"healthy","message":"ok"}',
      'LogUEMCP: Display: health={"status":"error","error_count":2,"message_count":0}',
      'LogUEMCP: Display: metrics={"status":"success","result_count":4}',
      `LogUEMCP: Display: metrics=${escapedBraceMetrics}`,
      'LogUEMCP: Display: metrics=[{"type":"counter"},{"status":"healthy"}]',
      'LogUEMCP: Display: metrics={"groups":[[{"type":"counter"}],'
        + '{"health":{"status":"healthy","value":1}}]}',
      `LogUEMCP: Display: metrics=${escapedCompositeMetrics}`,
      'LogUEMCP: Display: metrics=[{"type":"counter"}] '
        + 'health={"status":"healthy"} counters=[{"type":"counter"}]',
      'LogUEMCP: Display: raw=[{"kind":"metadata"}] metrics=[{"type":"counter"}]',
    ]);
  } catch (error) {
    nestedMetricsAcceptance = error;
  }
  runner.assert(nestedMetricsAcceptance === true,
    'live fault leak helper permits structured non-payload UEMCP metrics',
    nestedMetricsAcceptance?.message);
  let uemcpFramingMetadataAcceptance = null;
  try {
    uemcpFramingMetadataAcceptance = assertNoPayloadLeak([
      'LogUEMCP: Display: Content-Length: 128',
    ]);
  } catch (error) {
    uemcpFramingMetadataAcceptance = error;
  }
  runner.assert(uemcpFramingMetadataAcceptance === true,
    'live fault leak helper permits unrelated UEMCP framing metadata without a body value',
    uemcpFramingMetadataAcceptance?.message);
  let unrelatedLeakAcceptance = null;
  try {
    unrelatedLeakAcceptance = assertNoPayloadLeak([
      'LogHttp: Display: Content-Length: 128',
      'LogBlueprint: Display: response={"status":"success"}',
      'LogTemp: Display: request_preview={"type":"ping"}',
      'LogHttp: Warning: {"type":"ping"}',
      'LogBlueprint: Warning: {"status":"error","message":"bad"}',
    ]);
  } catch (error) {
    unrelatedLeakAcceptance = error;
  }
  runner.assert(unrelatedLeakAcceptance === true,
    'live fault leak helper ignores framing and JSON diagnostics outside LogUEMCP',
    unrelatedLeakAcceptance?.message);
  await runner.assertRejects(
    () => Promise.resolve().then(() => assertNoPayloadLeak([
      'first appended segment',
      'second UEMCP_SECRET_PAYLOAD_SENTINEL segment',
    ])),
    /sentinel/i,
    'live fault leak helper inspects every segment for the secret sentinel',
  );
  await runner.assertRejects(
    () => Promise.resolve().then(() => assertNoPayloadLeak([
      'first appended segment',
      'LogUEMCP: Warning: second request_preview={raw} segment',
    ])),
    /preview/i,
    'live fault leak helper inspects every segment for raw request/body previews',
  );
  const rawResponseLeakFields = [
    'LogUEMCP: Warning: response_preview={raw}',
    'LogUEMCP: Warning: raw_response={raw}',
    'LogUEMCP: Warning: response_body={raw}',
    'LogUEMCP: Warning: response-payload-preview={raw}',
    'LogUEMCP: Warning: preview_response={raw}',
  ];
  for (const [index, leakField] of rawResponseLeakFields.entries()) {
    let rejection = null;
    try {
      assertNoPayloadLeak([leakField]);
    } catch (error) {
      rejection = error;
    }
    runner.assert(rejection instanceof Error
      && /raw|preview|content/i.test(rejection.message),
    `live fault leak helper rejects raw response diagnostic ${index + 1}`);
  }
  await runner.assertRejects(
    () => Promise.resolve().then(() => assertNoPayloadLeak?.([
      'LogUEMCP: Warning: request_payload={"type":"ping"}',
    ])),
    /raw|preview|content/i,
    'live fault leak helper rejects a payload-specific request field',
  );

  const directRawLeakFields = [
    'LogUEMCP: Warning: response={"status":"error"}',
    'LogUEMCP: Warning: request={"type":"ping"}',
    'LogUEMCP: Warning: body=[1,2,3]',
    'LogUEMCP: Warning: payload="secret text"',
    'LogUEMCP: Warning: response=Content-Length: 12',
  ];
  for (const [index, leakField] of directRawLeakFields.entries()) {
    let rejection = null;
    try {
      assertNoPayloadLeak?.([leakField]);
    } catch (error) {
      rejection = error;
    }
    runner.assert(rejection instanceof Error
      && /raw|preview|content|payload/i.test(rejection.message),
    `live fault leak helper rejects direct raw field value ${index + 1}`);
  }
  const plainTextRawLeaks = [
    'LogUEMCP: Warning: request=ping',
    'LogUEMCP: Warning: raw request: ping',
    'LogUEMCP: Warning: body=/Game/Generic/Secret',
    'LogUEMCP: Warning: payload: plain secret text',
  ];
  for (const [index, leakLine] of plainTextRawLeaks.entries()) {
    let rejection = null;
    try {
      assertNoPayloadLeak?.([leakLine]);
    } catch (error) {
      rejection = error;
    }
    runner.assert(rejection instanceof Error
      && /raw|preview|content|payload/i.test(rejection.message),
    `live fault leak helper rejects plaintext raw payload diagnostic ${index + 1}`);
  }
  for (const [index, leakLine] of [
    'LogUEMCP: Warning: rejected envelope {"type":"ping","params":{}}',
    'LogUEMCP: Warning: {"type":"ping"}',
    'LogUEMCP: Warning: {"status":"error","code":"MALFORMED_REQUEST"}',
    'LogUEMCP: Warning: {"status":"error","message":"bad"}',
    'LogUEMCP: Warning: {"status":"error","error":"bad"}',
    'LogUEMCP: Warning: Content-Length: 15 {"type":"ping"}',
    'LogUEMCP: Warning: Content-Length: 15 metrics={"type":"counter"}',
    'LogUEMCP: Warning: diagnostics envelope {"type":"ping"}',
    'LogUEMCP: Warning: request metadata={"type":"ping"}',
    'LogUEMCP: Warning: raw={"type":"counter"}',
    'LogUEMCP: Warning: data={"status":"healthy","message":"wire body"}',
    'LogUEMCP: Warning: content={"type":"counter"}',
    'LogUEMCP: Warning: metrics={"type":"ping"}',
    'LogUEMCP: Warning: metrics={"type":"get_anim_graph"}',
    'LogUEMCP: Warning: metrics={"type":"counter","params":{}}',
    `LogUEMCP: Warning: metrics=${escapedBraceMetrics} next={"type":"ping"}`,
    'LogUEMCP: Warning: metrics={"type":"counter"} data={"status":"healthy","message":"wire body"}',
    'LogUEMCP: Warning: response_json={"status":"success","result":{"graph_count":1}}',
  ].entries()) {
    let rejection = null;
    try {
      assertNoPayloadLeak?.([leakLine]);
    } catch (error) {
      rejection = error;
    }
    runner.assert(rejection instanceof Error
      && /raw|preview|content|payload/i.test(rejection.message),
    `live fault leak helper rejects UEMCP framing or JSON envelope ${index + 1}`);
  }

  const inheritedPayloadCompositeLeaks = [
    'LogUEMCP: Warning: raw=[{"kind":"metadata"},{"type":"counter"}]',
    'LogUEMCP: Warning: data=[{"kind":"metadata"},{"type":"counter"}]',
    'LogUEMCP: Warning: request=[{"kind":"metadata"},{"type":"counter"}]',
    'LogUEMCP: Warning: response=[{"kind":"metadata"},{"type":"counter"}]',
    'LogUEMCP: Warning: body=[{"kind":"metadata"},{"type":"counter"}]',
    'LogUEMCP: Warning: payload=[{"kind":"metadata"},{"type":"counter"}]',
    'LogUEMCP: Warning: content=[{"kind":"metadata"},{"type":"counter"}]',
    'LogUEMCP: Warning: preview=[{"kind":"metadata"},{"type":"counter"}]',
    'LogUEMCP: Warning: raw=[[{"kind":"metadata"}],'
      + '[{"nested":{"type":"counter"}}]]',
    'LogUEMCP: Warning: data=[{"metadata":{"kind":"diagnostic"}},'
      + '{"nested":{"status":"healthy","message":"wire body"}}]',
    'LogUEMCP: Warning: metrics=[{"type":"counter"},{"type":"ping"}]',
    'LogUEMCP: Warning: metrics=[{"type":"counter"},'
      + '{"status":"error","error":"bad"}]',
    `LogUEMCP: Warning: raw=${JSON.stringify([
      { kind: 'metadata', note: 'quoted "] }" and "{ [" with escaped \\ path' },
      { type: 'counter' },
    ])}`,
    'LogUEMCP: Warning: metrics=[{"type":"counter"},{"status":"healthy"}] '
      + 'raw=[{"kind":"metadata"},{"type":"counter"}]',
    'LogUEMCP: Warning: health=[{"status":"healthy"}] '
      + 'metrics=[{"type":"counter"},{"status":"error","message":"bad"}]',
  ];
  for (const [index, leakLine] of inheritedPayloadCompositeLeaks.entries()) {
    let rejection = null;
    try {
      assertNoPayloadLeak?.([leakLine]);
    } catch (error) {
      rejection = error;
    }
    runner.assert(rejection instanceof Error
      && /raw|preview|content|payload/i.test(rejection.message),
    `live fault leak helper preserves inherited composite context ${index + 1}`);
  }

  const oversizedProbeBytes = buildOversizedDeclarationProbeBytes?.();
  const expectedOversizedHeader = Buffer.from(
    `Content-Length: ${TCP_MAX_REQUEST_BODY_BYTES + 1}\r\n\r\n`, 'ascii',
  );
  runner.assert(Buffer.isBuffer(oversizedProbeBytes)
    && oversizedProbeBytes.equals(expectedOversizedHeader)
    && oversizedProbeBytes.length < 64,
  'oversized declaration helper returns only the exact 8 MiB+1 header bytes');

  runner.assert(assertIncompleteFirstResponseChunk?.({ status: 'pending' }) === true,
    'AnimGraph reset accepts only a decoder-confirmed partial first response chunk');
  for (const status of ['complete', 'malformed']) {
    await runner.assertRejects(
      () => Promise.resolve().then(() => assertIncompleteFirstResponseChunk?.({ status })),
      /first response chunk|incomplete|outstanding/i,
      `AnimGraph reset rejects a ${status} first response chunk before reset attribution`,
    );
  }

  runner.assert(deriveSocketProbeTimeoutMs?.(1) === 15000
    && deriveSocketProbeTimeoutMs?.(14750) === 15000,
  'live fault timeout budget retains the 15000ms minimum through the headroom boundary');
  runner.assert(deriveSocketProbeTimeoutMs?.(14751) === 15001
    && deriveSocketProbeTimeoutMs?.(15000) === 15250,
  'live fault timeout budget adds deterministic settlement headroom above the minimum');
  const commonCallerBudgetMs = deriveSocketProbeTimeoutMs?.(30000);
  runner.assert(commonCallerBudgetMs === 30250 && Number.isFinite(commonCallerBudgetMs),
    'live fault timeout budget gives a finite 30000ms caller 250ms of settlement headroom');
  for (const [index, invalidTimeout] of [0, -1, Number.NaN, Number.POSITIVE_INFINITY].entries()) {
    await runner.assertRejects(
      () => Promise.resolve().then(() => deriveSocketProbeTimeoutMs?.(invalidTimeout)),
      /positive finite|finite positive/i,
      `live fault timeout budget rejects invalid selected caller timeout ${index + 1}`,
    );
  }
}

const executeProbeSourceStart = liveTcpSmokeSource.indexOf('async function executeProbe(');
const executeProbeSourceEnd = liveTcpSmokeSource.indexOf(
  '\nasync function captureProbeLog(', executeProbeSourceStart,
);
const executeProbeSource = liveTcpSmokeSource.slice(executeProbeSourceStart, executeProbeSourceEnd);
const animGraphProbeSourceStart = executeProbeSource.indexOf("case '14-animgraph-response-reset':");
const animGraphProbeSourceEnd = executeProbeSource.indexOf(
  "case '15-final-framed-ping':", animGraphProbeSourceStart,
);
const animGraphProbeSource = executeProbeSource.slice(
  animGraphProbeSourceStart, animGraphProbeSourceEnd,
);
runner.assert(executeProbeSourceStart >= 0
  && executeProbeSourceEnd > executeProbeSourceStart
  && animGraphProbeSourceStart >= 0
  && animGraphProbeSourceEnd > animGraphProbeSourceStart
  && liveTcpSmokeSource.includes('const callerTimeoutMs = smoke.cm.config.tcpTimeoutMs;')
  && liveTcpSmokeSource.includes('callerTimeoutMs })')
  && (executeProbeSource.match(/\btimeoutMs\s*:/g) ?? []).length === 1
  && animGraphProbeSource.includes(
    'timeoutMs: deriveSocketProbeTimeoutMs(callerTimeoutMs)',
  )
  && animGraphProbeSource.includes('resetOnFirstResponseChunk: true')
  && liveTcpSmokeSource.includes('assertIncompleteFirstResponseChunk(snapshot)'),
'large AnimGraph reset probe alone uses the derived connection-manager caller timeout budget');

const liveAnimationSmokeSource = await readFile(liveAnimationSmokeUrl, 'utf8');
const liveAnimationAssetGate = liveAnimationSmokeSource.indexOf(
  "const assetPath = String(process.env.UEMCP_LIVE_ANIM_BLUEPRINT || '').trim();",
);
const liveAnimationPrepare = liveAnimationSmokeSource.indexOf(
  "const smoke = await prepareLiveSmoke({ name: 'live-smoke-animation-readback' });",
);
runner.assert(liveAnimationAssetGate >= 0
  && liveAnimationPrepare >= 0
  && liveAnimationAssetGate < liveAnimationPrepare,
'live AnimGraph readback skips a missing asset env before any harness probe');
runner.assert(liveAnimationSmokeSource.includes('include_transitions: true')
  && liveAnimationSmokeSource.includes('include_node_properties: true')
  && liveAnimationSmokeSource.includes('include_pin_topology: true')
  && liveAnimationSmokeSource.includes('include_pin_defaults: true'),
'live AnimGraph readback requests all four full-read flags including pin defaults');
runner.assert(liveAnimationSmokeSource.includes('requireComplete: true')
  && liveAnimationSmokeSource.includes('expectedIncludesPinDefaults: true'),
'live AnimGraph readback requires complete topology with pin defaults');
runner.assert(liveAnimationSmokeSource.includes("Buffer.byteLength(JSON.stringify(result), 'utf8')")
  && (liveAnimationSmokeSource.match(/performance\.now\(\)/g) ?? []).length >= 2,
'live AnimGraph readback measures full serialized UTF-8 response bytes and monotonic wall time');
runner.assert(liveAnimationSmokeSource.includes('smoke.cm.config.tcpTimeoutMs')
  && /elapsedMs\s*>=\s*callerTimeoutMs/.test(liveAnimationSmokeSource)
  && !/executeMenhanceTool\([\s\S]*?timeoutMs\s*:/.test(liveAnimationSmokeSource),
'live AnimGraph readback compares elapsed time to the unchanged caller timeout without an override');
runner.assert(!liveAnimationSmokeSource.includes('asset_path: result.asset_path')
  && liveAnimationSmokeSource.includes('response_bytes')
  && liveAnimationSmokeSource.includes('elapsed_ms'),
'live AnimGraph readback output is limited to counts, bytes, and elapsed milliseconds');

process.exit(runner.summary());
