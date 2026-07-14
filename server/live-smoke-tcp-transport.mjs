// Opt-in raw TCP fault/recovery proof for the selected live UEMCP target.

import net from 'node:net';
import { open, readdir, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareLiveSmoke, sleep } from './live-smoke-harness.mjs';
import {
  TCP_MAX_REQUEST_BODY_BYTES,
  TcpResponseDecoder,
} from './tcp-transport.mjs';

const TCP_HOST = '127.0.0.1';
const IDLE_HOLD_MS = 2250;
const TRICKLE_INTERVAL_MS = 1500;
const PARTIAL_WRITE_DELAY_MS = 25;
const LOG_FLUSH_MS = 150;
const LOG_POLL_MS = 50;
const LOG_EVENT_WAIT_MS = 12500;
const SOCKET_PROBE_TIMEOUT_MS = 15000;
const SOCKET_PROBE_SETTLEMENT_HEADROOM_MS = 250;
const SECRET_SENTINEL = 'UEMCP_SECRET_PAYLOAD_SENTINEL';

const TCP_EVENT_TOKENS = Object.freeze([
  'event=tcp_intake_malformed',
  'event=tcp_intake_too_large',
  'event=tcp_intake_idle_timeout',
  'event=tcp_intake_total_timeout',
  'event=tcp_peer_closed_empty',
  'event=tcp_peer_closed_partial',
  'event=tcp_intake_socket_error',
  'event=tcp_send_failure',
]);

const TOKENLESS_TRANSPORT_WARNING_PATTERNS = Object.freeze([
  /\b(?:recv|receive)\s+failed\b[^\r\n]*\bsocket error\b/i,
  /\b(?:request incomplete(?: before parse)?|incomplete request)\b/i,
  /\b(?:send failed(?: after\b)?|failed to send (?:the )?response|response send fail(?:ed|ure))\b/i,
]);

const TOKENLESS_TRANSPORT_OPERATION_PATTERNS = Object.freeze([
  /\b(?:recv|receive|received|receiving)\b/i,
  /\b(?:send|sent|sending)\b/i,
  /\brequest[\s_-]+(?:read|intake)\b/i,
  /\b(?:read|intake)[\s_-]+request\b/i,
  /\bpeer[\s_-]+clos(?:e|ed|ing)\b/i,
  /\bclos(?:e|ed|ing)[\s_-]+peer\b/i,
  /\bresponse[\s_-]+(?:write|writing|written)\b/i,
  /\b(?:write|writing|written)[\s_-]+response\b/i,
]);

const SOCKET_FAILURE_CONTEXT_PATTERN = /(?:\bsocket\b[^\r\n]{0,40}\b(?:error|fail(?:ed|ure)?)\b|\b(?:error|fail(?:ed|ure)?)\b[^\r\n]{0,40}\bsocket\b)/i;

export const TCP_FAULT_PROBES = Object.freeze([
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
]);

const PARTIAL_REQUEST_CHUNKS = Object.freeze([
  Buffer.from('Cont', 'ascii'),
  Buffer.from('ent-Length: 32\r\n', 'ascii'),
  Buffer.from('\r\n{"type":"ping"', 'ascii'),
]);

function fail(message) {
  throw new Error(`live-smoke-tcp-transport: ${message}`);
}

function entryName(entry) {
  return typeof entry === 'string' ? entry : entry?.name;
}

export function resolveProjectLogPath(projectRoot, uprojectEntries) {
  if (!Array.isArray(uprojectEntries) || uprojectEntries.length !== 1) {
    fail(`expected exactly one top-level .uproject, found ${uprojectEntries?.length ?? 0}`);
  }
  const uprojectPath = join(projectRoot, entryName(uprojectEntries[0]));
  const projectName = basename(uprojectPath, '.uproject');
  return join(projectRoot, 'Saved', 'Logs', projectName + '.log');
}

export function validateLogContinuation(cursor, current) {
  if (current.size < cursor.offset) {
    fail(`log truncated below byte offset ${cursor.offset}`);
  }
  if (current.dev !== cursor.dev
    || current.ino !== cursor.ino
    || current.birthtimeMs !== cursor.birthtimeMs) {
    fail('log rotated or file identity changed');
  }
  if (current.mtimeMs < cursor.mtimeMs) {
    fail('log timestamp moved backwards; log truncated or rotated');
  }
  return current;
}

export function extractTcpEventLines(segment) {
  return String(segment || '')
    .split(/\r?\n/)
    .filter((line) => TCP_EVENT_TOKENS.some((token) => line.includes(token)));
}

function isTokenlessTransportWarningLine(line) {
  return /LogUEMCP:\s*Warning:/i.test(line)
    && !TCP_EVENT_TOKENS.some((token) => line.includes(token))
    && (TOKENLESS_TRANSPORT_WARNING_PATTERNS.some((pattern) => pattern.test(line))
      || (TOKENLESS_TRANSPORT_OPERATION_PATTERNS.some((pattern) => pattern.test(line))
        && SOCKET_FAILURE_CONTEXT_PATTERN.test(line)));
}

function tokenlessTransportWarningLines(segment) {
  return String(segment || '')
    .split(/\r?\n/)
    .filter(isTokenlessTransportWarningLine);
}

export function transportEvidenceFingerprint(segment) {
  return String(segment || '')
    .split(/\r?\n/)
    .filter((line) => (
      TCP_EVENT_TOKENS.some((token) => line.includes(token))
      || isTokenlessTransportWarningLine(line)
    ))
    .join('\n');
}

export function assertNoTokenlessTransportWarnings(segment, segmentId) {
  const warnings = tokenlessTransportWarningLines(segment);
  if (warnings.length > 0) {
    fail(`${segmentId} found ${warnings.length} tokenless transport warning(s)`);
  }
  return true;
}

function eventTokens(eventLines) {
  return eventLines.flatMap((line) => TCP_EVENT_TOKENS.filter((token) => line.includes(token)));
}

function assertWarningCount(probe, eventLines) {
  if (!Number.isInteger(probe.warningCount)) return true;
  const warningCount = eventLines.filter((line) => /LogUEMCP:\s*Warning:/i.test(line)).length;
  if (warningCount !== probe.warningCount) {
    fail(`${probe.id} expected ${probe.warningCount} warning event(s), got ${warningCount}`);
  }
  return true;
}

export function assertProbeEventContract(probe, eventLines) {
  const expectedEvents = probe.expectedEvents || [];
  const optionalEvents = probe.optionalEvents || [];
  const allowedEvents = new Set([...expectedEvents, ...optionalEvents]);
  const observedEvents = eventTokens(eventLines);

  for (const expected of expectedEvents) {
    const count = observedEvents.filter((event) => event === expected).length;
    if (count !== 1) fail(`${probe.id} expected exactly one ${expected}, got ${count}`);
  }
  for (const optional of optionalEvents) {
    const count = observedEvents.filter((event) => event === optional).length;
    if (count > 1) fail(`${probe.id} expected at most one optional event ${optional}, got ${count}`);
  }
  for (const observed of observedEvents) {
    if (!allowedEvents.has(observed)) fail(`${probe.id} observed unowned event ${observed}`);
  }
  for (const forbidden of probe.forbiddenEvents || []) {
    if (observedEvents.includes(forbidden)) fail(`${probe.id} observed forbidden event ${forbidden}`);
  }

  const joined = eventLines.join('\n');
  for (const required of probe.requiredFragments || []) {
    if (!joined.includes(required)) fail(`${probe.id} missing required log metadata ${required}`);
  }
  for (const forbidden of probe.forbiddenFragments || []) {
    if (joined.includes(forbidden)) fail(`${probe.id} inherited forbidden log metadata ${forbidden}`);
  }
  assertWarningCount(probe, eventLines);
  return true;
}

function assertNoInheritedReset(segment) {
  if (segment.includes('event=tcp_intake_socket_error')
    || segment.includes('SE_ECONNRESET')
    || segment.includes('socketCode=26')) {
    fail('clean close after reset inherited reset warning metadata');
  }
}

export function assertNoDelayedTcpEvents(segment, probeId) {
  const delayedEvents = extractTcpEventLines(segment);
  if (delayedEvents.length > 0) {
    fail(`${probeId} found ${delayedEvents.length} delayed prior transport event(s)`);
  }
  return true;
}

export function assertNoPayloadLeak(segments) {
  for (const segment of segments) {
    const segmentText = String(segment || '');
    if (segmentText.includes(SECRET_SENTINEL)) fail('secret sentinel leaked into the appended log');
    for (const line of segmentText.split(/\r?\n/)) {
      if (!/\bLogUEMCP:/i.test(line)) continue;
      if (/\b(?:(?:raw|preview)[_-]?(?:request|response|body|payload)|(?:request|response|body|payload)[_-]?(?:raw|preview|body|payload))(?:[_-]?(?:raw|preview|body|payload))*\s*=/i.test(line)) {
        fail('raw request/response/body preview appeared in the appended log');
      }
      if (/\b(?:request|response|body|payload)\s*=\s*(?:[\[{"']|Content-Length\s*:)/i.test(line)
        || /Content-Length\s*:/i.test(line)
        || /"(?:type|params)"\s*:/.test(line)) {
        fail('raw request/response/body/payload content appeared in the appended log');
      }
    }
  }
  return true;
}

export function deriveSocketProbeTimeoutMs(callerTimeoutMs) {
  if (!Number.isFinite(callerTimeoutMs) || callerTimeoutMs <= 0) {
    fail('selected caller timeout is not a positive finite value');
  }
  const timeoutMs = callerTimeoutMs + SOCKET_PROBE_SETTLEMENT_HEADROOM_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= callerTimeoutMs) {
    fail('selected caller timeout cannot produce a finite settlement budget');
  }
  return Math.max(SOCKET_PROBE_TIMEOUT_MS, timeoutMs);
}

async function readAppendedSegment(logPath, cursor, currentStat) {
  validateLogContinuation(cursor, currentStat);
  const byteCount = currentStat.size - cursor.offset;
  if (byteCount === 0) {
    cursor.mtimeMs = currentStat.mtimeMs;
    return '';
  }

  const buffer = Buffer.alloc(byteCount);
  const fileHandle = await open(logPath, 'r');
  try {
    const openStat = await fileHandle.stat();
    validateLogContinuation(cursor, openStat);
    if (openStat.size < currentStat.size) fail('log truncated or rotated during appended read');
    let bytesRead = 0;
    while (bytesRead < byteCount) {
      const readResult = await fileHandle.read(
        buffer,
        bytesRead,
        byteCount - bytesRead,
        cursor.offset + bytesRead,
      );
      if (readResult.bytesRead === 0) {
        fail(`short appended log read: expected ${byteCount}, got ${bytesRead}`);
      }
      bytesRead += readResult.bytesRead;
    }
  } finally {
    await fileHandle.close();
  }

  const afterReadStat = await stat(logPath);
  validateLogContinuation(cursor, afterReadStat);
  if (afterReadStat.size < currentStat.size) fail('log truncated during appended read');

  cursor.offset = currentStat.size;
  cursor.mtimeMs = currentStat.mtimeMs;
  return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
}

export async function waitForStableAppendedSegment(logPath, cursor, {
  expectedEventCount = 0,
  timeoutMs = LOG_EVENT_WAIT_MS,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let previousEvidenceFingerprint = null;
  let stableObservations = 0;
  await sleep(LOG_FLUSH_MS);

  while (Date.now() <= deadline) {
    const currentStat = await stat(logPath);
    validateLogContinuation(cursor, currentStat);
    const previewCursor = { ...cursor };
    const preview = await readAppendedSegment(logPath, previewCursor, currentStat);
    const eventCount = extractTcpEventLines(preview).length;
    const evidenceFingerprint = transportEvidenceFingerprint(preview);

    if (evidenceFingerprint === previousEvidenceFingerprint) {
      stableObservations += 1;
    } else {
      stableObservations = 0;
    }
    if (stableObservations >= 1 && eventCount >= expectedEventCount) {
      return readAppendedSegment(logPath, cursor, currentStat);
    }

    previousEvidenceFingerprint = evidenceFingerprint;
    await sleep(LOG_POLL_MS);
  }
  fail(`timed out waiting for ${expectedEventCount} appended transport event(s)`);
}

function frameBody(body) {
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii');
  return Buffer.concat([header, body]);
}

function frameRequest(type, params = {}) {
  return frameBody(Buffer.from(JSON.stringify({ type, params }), 'utf8'));
}

function receiveDecodedResponse(selectedPort, {
  requestBytes = null,
  start = null,
  resetOnFirstResponseChunk = false,
  timeoutMs = SOCKET_PROBE_TIMEOUT_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    const decoder = new TcpResponseDecoder();
    const socket = net.createConnection({ host: TCP_HOST, port: selectedPort });
    let settled = false;
    let receivedBytes = 0;
    let startCleanup = null;

    const timer = setTimeout(() => {
      finish(new Error('socket probe timed out'));
    }, timeoutMs);

    const finish = (error, response = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      startCleanup?.();
      if (!socket.destroyed) socket.destroy();
      if (error) reject(error);
      else resolve({ response, receivedBytes });
    };

    socket.setNoDelay(true);
    socket.on('connect', () => {
      try {
        if (requestBytes !== null) socket.write(requestBytes);
        startCleanup = start?.(socket) || null;
      } catch (error) {
        finish(error);
      }
    });
    socket.on('data', (chunk) => {
      receivedBytes += chunk.length;
      if (resetOnFirstResponseChunk) {
        socket.resetAndDestroy();
        finish(null, null);
        return;
      }
      try {
        const snapshot = decoder.consume(chunk);
        if (snapshot.status === 'malformed') {
          finish(new Error(`response decoder rejected ${snapshot.reasonCode}`));
        } else if (snapshot.status === 'complete') {
          finish(null, snapshot.value);
        }
      } catch (error) {
        finish(error);
      }
    });
    socket.on('end', () => {
      if (settled) return;
      const snapshot = decoder.finish();
      finish(new Error(`response ended before completion: ${snapshot.reasonCode}`));
    });
    socket.on('close', () => {
      if (settled) return;
      const snapshot = decoder.finish();
      finish(new Error(`response closed before completion: ${snapshot.reasonCode}`));
    });
    socket.on('error', (error) => finish(error));
  });
}

function closePeer(selectedPort, chunks, { reset = false } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: TCP_HOST, port: selectedPort });
    let receivedBytes = 0;
    let settled = false;
    const timer = setTimeout(() => finish(new Error('peer-close probe timed out')), 5000);

    socket.setNoDelay(true);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!socket.destroyed) socket.destroy();
      if (error) reject(error);
      else resolve({ response: null, receivedBytes });
    };

    socket.on('data', (chunk) => {
      receivedBytes += chunk.length;
    });
    socket.on('connect', async () => {
      try {
        for (const chunk of chunks) {
          await new Promise((writeResolve, writeReject) => {
            socket.write(chunk, (error) => (error ? writeReject(error) : writeResolve()));
          });
          await sleep(PARTIAL_WRITE_DELAY_MS);
        }
        if (reset) socket.resetAndDestroy();
        else socket.end();
      } catch (error) {
        finish(error);
      }
    });
    socket.on('close', () => finish(null));
    socket.on('error', (error) => {
      if (reset && (error.code === 'ECONNRESET' || error.code === 'ECONNABORTED')) return;
      finish(error);
    });
  });
}

function assertNoResponse(observation, probeId) {
  if (observation.response !== null || observation.receivedBytes !== 0) {
    fail(`${probeId} expected no response bytes`);
  }
}

function assertSuccess(response, probeId) {
  if (response?.status !== 'success') fail(`${probeId} expected a success response`);
}

function assertErrorCode(response, expectedCode, probeId) {
  if (response?.status !== 'error' || response?.code !== expectedCode) {
    fail(`${probeId} expected error code ${expectedCode}`);
  }
}

function startIdleHold(socket) {
  socket.pause();
  const resumeTimer = setTimeout(() => socket.resume(), IDLE_HOLD_MS);
  return () => clearTimeout(resumeTimer);
}

function startOneByteTrickle(socket) {
  const bytes = Buffer.from('Content-Length: 64\r\n\r\n', 'ascii');
  let index = 0;
  socket.write(bytes.subarray(index, ++index));
  const interval = setInterval(() => {
    if (!socket.destroyed && socket.writable) {
      const byteIndex = index % bytes.length;
      socket.write(bytes.subarray(byteIndex, byteIndex + 1));
      index += 1;
    }
  }, TRICKLE_INTERVAL_MS);
  return () => clearInterval(interval);
}

async function executeProbe(probeId, { selectedPort, animBlueprintPath, callerTimeoutMs }) {
  switch (probeId) {
  case '01-framed-ping': {
    const { response } = await receiveDecodedResponse(selectedPort, {
      requestBytes: frameRequest('ping'),
    });
    assertSuccess(response, probeId);
    return 'response=success';
  }
  case '02-legacy-ping': {
    const { response } = await receiveDecodedResponse(selectedPort, {
      requestBytes: Buffer.from(JSON.stringify({ type: 'ping', params: {} }), 'utf8'),
    });
    assertSuccess(response, probeId);
    return 'response=success';
  }
  case '03-empty-close': {
    const observation = await closePeer(selectedPort, []);
    assertNoResponse(observation, probeId);
    return 'response_bytes=0';
  }
  case '04-partial-framed-close': {
    const observation = await closePeer(selectedPort, PARTIAL_REQUEST_CHUNKS);
    assertNoResponse(observation, probeId);
    return 'response_bytes=0';
  }
  case '05-partial-reset': {
    const observation = await closePeer(selectedPort, [
      Buffer.from('Content-Length: 32\r\n\r\n{"type":"', 'ascii'),
    ], { reset: true });
    assertNoResponse(observation, probeId);
    return 'response_bytes=0';
  }
  case '06-empty-close-after-reset': {
    const observation = await closePeer(selectedPort, []);
    assertNoResponse(observation, probeId);
    return 'response_bytes=0';
  }
  case '07-framed-ping-after-reset': {
    const { response } = await receiveDecodedResponse(selectedPort, {
      requestBytes: frameRequest('ping'),
    });
    assertSuccess(response, probeId);
    return 'response=success';
  }
  case '08-invalid-json-sentinel': {
    const invalidJson = Buffer.from(
      `{"type":"ping","params":{"marker":"${SECRET_SENTINEL}"},"broken":}`,
      'utf8',
    );
    const { response } = await receiveDecodedResponse(selectedPort, {
      requestBytes: frameBody(invalidJson),
    });
    assertErrorCode(response, 'MALFORMED_REQUEST', probeId);
    return 'code=MALFORMED_REQUEST';
  }
  case '09-invalid-utf8': {
    const invalidUtf8 = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d]);
    const { response } = await receiveDecodedResponse(selectedPort, {
      requestBytes: frameBody(invalidUtf8),
    });
    assertErrorCode(response, 'MALFORMED_REQUEST', probeId);
    return 'code=MALFORMED_REQUEST';
  }
  case '10-duplicate-content-length': {
    const body = Buffer.from('{"type":"ping","params":{}}', 'ascii');
    const header = Buffer.from(
      `Content-Length: ${body.length}\r\nContent-Length: ${body.length}\r\n\r\n`,
      'ascii',
    );
    const { response } = await receiveDecodedResponse(selectedPort, {
      requestBytes: Buffer.concat([header, body]),
    });
    assertErrorCode(response, 'MALFORMED_REQUEST', probeId);
    return 'code=MALFORMED_REQUEST';
  }
  case '11-oversized-declaration': {
    const oversizedLength = TCP_MAX_REQUEST_BODY_BYTES + 1;
    const { response } = await receiveDecodedResponse(selectedPort, {
      requestBytes: Buffer.from(`Content-Length: ${oversizedLength}\r\n\r\n`, 'ascii'),
    });
    assertErrorCode(response, 'REQUEST_TOO_LARGE', probeId);
    return 'code=REQUEST_TOO_LARGE';
  }
  case '12-idle-timeout': {
    const { response } = await receiveDecodedResponse(selectedPort, { start: startIdleHold });
    assertErrorCode(response, 'REQUEST_TIMEOUT', probeId);
    return 'code=REQUEST_TIMEOUT';
  }
  case '13-total-timeout-trickle': {
    const { response } = await receiveDecodedResponse(selectedPort, {
      start: startOneByteTrickle,
    });
    assertErrorCode(response, 'REQUEST_TIMEOUT', probeId);
    return 'code=REQUEST_TIMEOUT';
  }
  case '14-animgraph-response-reset': {
    const requestBytes = frameRequest('get_anim_graph', {
      asset_path: animBlueprintPath,
      include_transitions: true,
      include_node_properties: true,
      include_pin_topology: true,
      include_pin_defaults: true,
    });
    const observation = await receiveDecodedResponse(selectedPort, {
      requestBytes,
      resetOnFirstResponseChunk: true,
      timeoutMs: deriveSocketProbeTimeoutMs(callerTimeoutMs),
    });
    if (observation.receivedBytes <= 0) fail(`${probeId} received no response chunk before reset`);
    return `response_chunks=1 received_bytes=${observation.receivedBytes}`;
  }
  case '15-final-framed-ping': {
    const { response } = await receiveDecodedResponse(selectedPort, {
      requestBytes: frameRequest('ping'),
    });
    assertSuccess(response, probeId);
    return 'response=success';
  }
  default:
    fail(`unknown probe ${probeId}`);
  }
}

async function captureProbeLog(probe, run, logPath, cursor, segments) {
  const beforeSegment = await waitForStableAppendedSegment(logPath, cursor);
  segments.push(beforeSegment);
  assertNoTokenlessTransportWarnings(beforeSegment, `${probe.id} before segment`);
  assertNoDelayedTcpEvents(beforeSegment, probe.id);

  const summary = await run();
  const afterSegment = await waitForStableAppendedSegment(logPath, cursor, {
    expectedEventCount: probe.expectedEvents.length,
  });
  segments.push(afterSegment);
  assertNoTokenlessTransportWarnings(afterSegment, `${probe.id} after segment`);
  assertNoPayloadLeak([beforeSegment, afterSegment]);
  const eventLines = extractTcpEventLines(afterSegment);
  assertProbeEventContract(probe, eventLines);
  if (probe.id === '06-empty-close-after-reset') assertNoInheritedReset(eventLines.join('\n'));
  return { summary, eventCount: eventLines.length };
}

export async function runLiveTcpTransportSmoke() {
  const animBlueprintPath = String(process.env.UEMCP_LIVE_ANIM_BLUEPRINT || '').trim();
  if (!animBlueprintPath) {
    console.log('⊘ skipped live-smoke-tcp-transport: set UEMCP_LIVE_ANIM_BLUEPRINT=/Game/... for probe 14');
    return 0;
  }

  const smoke = await prepareLiveSmoke({ name: 'live-smoke-tcp-transport' });
  if (!smoke.ready) return smoke.exitCode;

  const projectRoot = smoke.projectRoot;
  const entries = await readdir(projectRoot, { withFileTypes: true });
  const uprojectEntries = entries.filter((entry) => (
    entry.isFile() && extname(entry.name).toLowerCase() === '.uproject'
  ));
  const logPath = resolveProjectLogPath(projectRoot, uprojectEntries);
  const startLogStat = await stat(logPath);
  const startLogOffset = startLogStat.size;
  const startLogTimestampMs = startLogStat.mtimeMs;
  const cursor = {
    dev: startLogStat.dev,
    ino: startLogStat.ino,
    birthtimeMs: startLogStat.birthtimeMs,
    mtimeMs: startLogTimestampMs,
    offset: startLogOffset,
  };

  const selectedPort = smoke.cm.config.tcpPortCustom;
  if (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535) {
    fail('selected TCP port is invalid');
  }
  const callerTimeoutMs = smoke.cm.config.tcpTimeoutMs;
  const segments = [];
  for (const probe of TCP_FAULT_PROBES) {
    const result = await captureProbeLog(
      probe,
      () => executeProbe(probe.id, { selectedPort, animBlueprintPath, callerTimeoutMs }),
      logPath,
      cursor,
      segments,
    );
    console.log(`PASS ${probe.id}: ${result.summary} events=${result.eventCount}`);
  }

  const finalSegment = await waitForStableAppendedSegment(logPath, cursor);
  segments.push(finalSegment);
  assertNoDelayedTcpEvents(finalSegment, 'final tail');
  assertNoTokenlessTransportWarnings(finalSegment, 'final tail');
  assertNoPayloadLeak(segments);
  if (cursor.offset < startLogOffset || cursor.mtimeMs < startLogTimestampMs) {
    fail('log truncated or rotated across the smoke window');
  }
  console.log(
    `PASS live-smoke-tcp-transport: probes=${TCP_FAULT_PROBES.length} appended_log_bytes=${cursor.offset - startLogOffset}`,
  );
  return 0;
}

function isMain() {
  return basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url));
}

if (isMain()) {
  try {
    process.exitCode = await runLiveTcpTransportSmoke();
  } catch (error) {
    console.error(`FAIL live-smoke-tcp-transport: ${error.message}`);
    process.exitCode = 1;
  }
}
