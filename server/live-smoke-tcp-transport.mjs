// Opt-in raw TCP fault/recovery proof for the selected live UEMCP target.

import net from 'node:net';
import { createHash } from 'node:crypto';
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
const RESET_REQUEST_PREFIX_SETTLE_MS = 100;
const RESET_AFTER_FINAL_BYTE_MS = 0;
const MIN_LARGE_RESPONSE_BYTES = (64 * 1024) + 1;
const LOG_FLUSH_MS = 150;
const LOG_POLL_MS = 50;
const LOG_EVENT_WAIT_MS = 12500;
const LOG_ANCHOR_BYTES = 256;
const LOG_READ_CHUNK_BYTES = 64 * 1024;
const LOG_SEGMENT_MAX_BYTES = 4 * 1024 * 1024;
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
    requiredFragments: [
      'bytesSent=0',
      'reason=send_error',
      'socketError=SE_ECONNRESET',
      'socketCode=26',
    ],
    minimumTotalBytes: MIN_LARGE_RESPONSE_BYTES,
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
  const projectName = basename(uprojectPath, extname(uprojectPath));
  return join(projectRoot, 'Saved', 'Logs', projectName + '.log');
}

export function validateLogContinuation(cursor, current) {
  if (Number.isFinite(cursor.observedSize) && current.size < cursor.observedSize) {
    fail(`log size regressed below observed high-water mark ${cursor.observedSize}`);
  }
  if (Number.isFinite(cursor.readOffset) && current.size < cursor.readOffset) {
    fail(`log truncated below ingested byte offset ${cursor.readOffset}`);
  }
  if (current.size < cursor.offset) {
    fail(`log truncated below byte offset ${cursor.offset}`);
  }
  if (current.dev !== cursor.dev
    || current.ino !== cursor.ino
    || current.birthtimeMs !== cursor.birthtimeMs) {
    fail('log rotated or file identity changed');
  }
  const observedMtimeMs = Number.isFinite(cursor.observedMtimeMs)
    ? cursor.observedMtimeMs
    : cursor.mtimeMs;
  if (current.mtimeMs < observedMtimeMs) {
    fail('log timestamp moved backwards; log truncated or rotated');
  }
  return current;
}

export function observeLogHighWater(cursor, current) {
  validateLogContinuation(cursor, current);
  cursor.observedSize = Math.max(cursor.observedSize ?? cursor.offset, current.size);
  cursor.observedMtimeMs = Math.max(
    cursor.observedMtimeMs ?? cursor.mtimeMs,
    current.mtimeMs,
  );
  return cursor;
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
  if (Number.isInteger(probe.minimumTotalBytes)) {
    const totalByteValues = eventLines.flatMap((line) => (
      [...line.matchAll(/(?:^|\s)totalBytes=(\d+)(?=\s|$)/g)]
        .map((match) => Number.parseInt(match[1], 10))
    ));
    if (totalByteValues.length !== 1) {
      fail(`${probe.id} expected exactly one totalBytes value, got ${totalByteValues.length}`);
    }
    if (totalByteValues[0] < probe.minimumTotalBytes) {
      fail(`${probe.id} expected totalBytes minimum ${probe.minimumTotalBytes}, got ${totalByteValues[0]}`);
    }
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

function scanJsonCompositeCandidates(message) {
  const candidates = [];
  let candidateStart = -1;
  let contextStart = 0;
  const delimiterStack = [];
  let inString = false;
  let escaped = false;
  for (let index = 0; index < message.length; index += 1) {
    const char = message[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      if (delimiterStack.length === 0) candidateStart = index;
      delimiterStack.push(char);
    } else if ((char === '}' || char === ']') && delimiterStack.length > 0) {
      const expectedOpening = char === '}' ? '{' : '[';
      if (delimiterStack.at(-1) !== expectedOpening) {
        delimiterStack.length = 0;
        candidateStart = -1;
        contextStart = index + 1;
        continue;
      }
      delimiterStack.pop();
      if (delimiterStack.length === 0 && candidateStart >= 0) {
        const source = message.slice(candidateStart, index + 1);
        let value = null;
        try {
          value = JSON.parse(source);
        } catch {
          value = null;
        }
        candidates.push({
          prefix: message.slice(contextStart, candidateStart),
          value,
        });
        contextStart = index + 1;
        candidateStart = -1;
      }
    }
  }
  return candidates;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function isJsonObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function anyJsonObject(value, predicate) {
  if (Array.isArray(value)) return value.some((entry) => anyJsonObject(entry, predicate));
  if (!isJsonObject(value)) return false;
  if (predicate(value)) return true;
  return Object.values(value).some((entry) => anyJsonObject(entry, predicate));
}

function isLiveRequestShape(value) {
  if (hasOwn(value, 'params')) return true;
  if (typeof value.type !== 'string') return false;
  const requestType = value.type.toLowerCase();
  return requestType === 'ping' || requestType === 'get_anim_graph';
}

function isCanonicalResponseShape(value) {
  if (typeof value.status !== 'string') return false;
  const status = value.status.toLowerCase();
  return (status === 'success' || status === 'error')
    && ['code', 'error', 'message', 'result'].some((key) => hasOwn(value, key));
}

function isTransportShaped(value) {
  return ['code', 'error', 'message', 'params', 'result', 'status', 'type'].some(
    (key) => hasOwn(value, key),
  );
}

function hasExplicitPayloadContext(prefix) {
  const normalized = prefix.replace(/[_-]+/g, ' ');
  return /\b(?:body|content|data|envelope|frame|framed|framing|json|payload|preview|raw|request|response|wire)\b/i.test(normalized)
    || /\bContent-Length\s*:/i.test(prefix);
}

function hasRawEnvelopeCandidate(message) {
  for (const candidate of scanJsonCompositeCandidates(message)) {
    if (!isJsonObject(candidate.value) && !Array.isArray(candidate.value)) continue;
    if (anyJsonObject(candidate.value, isLiveRequestShape)) return true;
    if (anyJsonObject(candidate.value, isCanonicalResponseShape)) return true;
    if (hasExplicitPayloadContext(candidate.prefix)
      && anyJsonObject(candidate.value, isTransportShaped)) return true;
  }
  return false;
}

export function assertNoPayloadLeak(segments) {
  for (const segment of segments) {
    const segmentText = String(segment || '');
    if (segmentText.includes(SECRET_SENTINEL)) fail('secret sentinel leaked into the appended log');
    for (const line of segmentText.split(/\r?\n/)) {
      if (!/\bLogUEMCP:/i.test(line)) continue;
      const message = line.slice(line.search(/\bLogUEMCP:/i) + 'LogUEMCP:'.length)
        .replace(/^\s*(?:Error|Warning|Display|Log|Verbose|VeryVerbose):\s*/i, '');
      if (/\b(?:(?:raw|preview)[\s_-]*(?:request|response|body|payload)|(?:request|response|body|payload)[\s_-]*(?:raw|preview|body|payload|json|text|content|data|value))(?:[\s_-]*(?:raw|preview|body|payload|json|text|content|data|value))*\s*[:=]/i.test(message)) {
        fail('raw request/response/body preview appeared in the appended log');
      }
      if (/\b(?:request|response|body|payload)\s*[:=]\s*\S/i.test(message)
        || hasRawEnvelopeCandidate(message)) {
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

export function assertMatchingLogAnchor(expected, observed) {
  if (!Buffer.isBuffer(expected) || !Buffer.isBuffer(observed)
    || expected.length !== observed.length || !expected.equals(observed)) {
    fail('log anchor changed; log was truncated, rotated, or replaced');
  }
  return true;
}

function completeUtf8PrefixLength(buffer) {
  if (buffer.length === 0 || buffer[buffer.length - 1] <= 0x7f) return buffer.length;

  let leadIndex = buffer.length - 1;
  while (leadIndex >= 0 && (buffer[leadIndex] & 0xc0) === 0x80) leadIndex -= 1;
  if (leadIndex < 0) return buffer.length;

  const lead = buffer[leadIndex];
  let expectedBytes = 0;
  if (lead >= 0xc2 && lead <= 0xdf) expectedBytes = 2;
  else if (lead >= 0xe0 && lead <= 0xef) expectedBytes = 3;
  else if (lead >= 0xf0 && lead <= 0xf4) expectedBytes = 4;
  else return buffer.length;

  return buffer.length - leadIndex < expectedBytes ? leadIndex : buffer.length;
}

export function decodeCompleteUtf8Prefix(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('appended log bytes must be a Buffer');
  const bytesConsumed = completeUtf8PrefixLength(buffer);
  const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytesConsumed));
  return { text, bytesConsumed };
}

function createPendingDigest() {
  return createHash('sha256');
}

function snapshotPendingDigest(cursor) {
  if (cursor.pendingDigest === undefined && (cursor.pendingByteCount ?? 0) === 0) {
    return createPendingDigest().digest();
  }
  if (cursor.pendingDigest === null || typeof cursor.pendingDigest?.copy !== 'function') {
    fail('pending log evidence digest state is unavailable');
  }
  return cursor.pendingDigest.copy().digest();
}

function assertMatchingPendingDigest(expected, observed) {
  if (!Buffer.isBuffer(expected) || !Buffer.isBuffer(observed)
    || expected.length !== observed.length || !expected.equals(observed)) {
    fail('pending log evidence digest changed; log was truncated, regrown, or replaced');
  }
  return true;
}

export function appendDecodedLogBytes(cursor, chunk, {
  maxSegmentBytes = LOG_SEGMENT_MAX_BYTES,
} = {}) {
  if (!Buffer.isBuffer(chunk)) fail('appended log chunk must be a Buffer');
  if (!Number.isInteger(maxSegmentBytes) || maxSegmentBytes <= 0) {
    fail('bounded appended log segment maximum must be a positive integer');
  }
  const pendingByteCount = cursor.pendingByteCount ?? 0;
  if (pendingByteCount + chunk.length > maxSegmentBytes) {
    fail(`appended log segment exceeds bounded maximum of ${maxSegmentBytes} bytes`);
  }

  const pendingUtf8 = cursor.pendingUtf8 ?? Buffer.alloc(0);
  if (!Buffer.isBuffer(pendingUtf8)) fail('pending UTF-8 suffix must be a Buffer');
  const combined = pendingUtf8.length > 0
    ? Buffer.concat([pendingUtf8, chunk], pendingUtf8.length + chunk.length)
    : chunk;
  const decoded = decodeCompleteUtf8Prefix(combined);
  const trailingUtf8 = Buffer.from(combined.subarray(decoded.bytesConsumed));
  if (trailingUtf8.length > 3) fail('incomplete UTF-8 suffix exceeded three bytes');

  const pendingDigest = cursor.pendingDigest ?? createPendingDigest();
  if (typeof pendingDigest.update !== 'function' || typeof pendingDigest.copy !== 'function') {
    fail('pending log evidence digest state is invalid');
  }
  pendingDigest.update(chunk);

  cursor.pendingText = (cursor.pendingText ?? '') + decoded.text;
  cursor.pendingUtf8 = trailingUtf8;
  cursor.pendingByteCount = pendingByteCount + chunk.length;
  cursor.pendingDigest = pendingDigest;
  cursor.readOffset = (cursor.readOffset ?? cursor.offset) + chunk.length;
  return cursor;
}

export function commitLogEvidence(cursor, {
  boundaryOffset,
  mtimeMs,
  anchorOffset,
  anchorBytes,
}) {
  if (!Buffer.isBuffer(cursor.pendingUtf8) || cursor.pendingUtf8.length !== 0) {
    fail('cannot commit an incomplete UTF-8 log suffix');
  }
  const pendingText = String(cursor.pendingText ?? '');
  if (pendingText.length > 0 && !pendingText.endsWith('\n')) {
    fail('cannot commit an incomplete log line without a newline');
  }
  if (!Number.isInteger(boundaryOffset) || boundaryOffset !== cursor.readOffset) {
    fail('log evidence boundary does not match the ingested byte cursor');
  }
  const pendingByteCount = cursor.pendingByteCount ?? 0;
  if (boundaryOffset - cursor.offset !== pendingByteCount) {
    fail('log evidence byte accounting does not match the committed cursor');
  }
  if (Number.isFinite(cursor.observedSize) && boundaryOffset < cursor.observedSize) {
    fail('cannot commit below the observed high-water with uninspected log bytes');
  }
  if (!Buffer.isBuffer(anchorBytes)) fail('committed log anchor must be a Buffer');
  const expectedAnchorLength = Math.min(LOG_ANCHOR_BYTES, boundaryOffset);
  const expectedAnchorOffset = boundaryOffset - expectedAnchorLength;
  if (anchorOffset !== expectedAnchorOffset || anchorBytes.length !== expectedAnchorLength) {
    fail('committed log anchor does not end at the committed cursor boundary');
  }

  cursor.offset = boundaryOffset;
  cursor.readOffset = boundaryOffset;
  cursor.mtimeMs = Math.max(cursor.mtimeMs ?? mtimeMs, mtimeMs);
  cursor.observedMtimeMs = Math.max(cursor.observedMtimeMs ?? mtimeMs, mtimeMs);
  cursor.observedSize = Math.max(cursor.observedSize ?? boundaryOffset, boundaryOffset);
  cursor.anchorOffset = anchorOffset;
  cursor.anchorBytes = Buffer.from(anchorBytes);
  cursor.pendingByteCount = 0;
  cursor.pendingText = '';
  cursor.pendingUtf8 = Buffer.alloc(0);
  cursor.pendingDigest = createPendingDigest();
  return pendingText;
}

async function readBoundedRange(fileHandle, position, byteCount, label) {
  if (!Number.isInteger(byteCount) || byteCount < 0 || byteCount > LOG_ANCHOR_BYTES) {
    fail(`${label} read exceeds the bounded ${LOG_ANCHOR_BYTES}-byte anchor limit`);
  }
  if (byteCount === 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(byteCount);
  let bytesRead = 0;
  while (bytesRead < byteCount) {
    const result = await fileHandle.read(buffer, bytesRead, byteCount - bytesRead, position + bytesRead);
    if (result.bytesRead === 0) fail(`short ${label} read: expected ${byteCount}, got ${bytesRead}`);
    bytesRead += result.bytesRead;
  }
  return buffer;
}

async function digestLogRange(fileHandle, position, byteCount, label) {
  if (!Number.isSafeInteger(position) || position < 0
    || !Number.isSafeInteger(byteCount) || byteCount < 0
    || byteCount > LOG_SEGMENT_MAX_BYTES) {
    fail(`${label} digest range exceeds the bounded appended log segment`);
  }
  const digest = createPendingDigest();
  if (byteCount === 0) return digest.digest();

  const buffer = Buffer.allocUnsafe(LOG_READ_CHUNK_BYTES);
  let bytesRead = 0;
  while (bytesRead < byteCount) {
    const readLength = Math.min(LOG_READ_CHUNK_BYTES, byteCount - bytesRead);
    const result = await fileHandle.read(buffer, 0, readLength, position + bytesRead);
    if (result.bytesRead === 0) {
      fail(`short ${label} digest read: expected ${byteCount}, got ${bytesRead}`);
    }
    digest.update(buffer.subarray(0, result.bytesRead));
    bytesRead += result.bytesRead;
  }
  return digest.digest();
}

export async function createLogCursor(logPath) {
  let cursor = null;
  const fileHandle = await open(logPath, 'r');
  try {
    const initialStat = await fileHandle.stat();
    const anchorLength = Math.min(LOG_ANCHOR_BYTES, initialStat.size);
    cursor = {
      dev: initialStat.dev,
      ino: initialStat.ino,
      birthtimeMs: initialStat.birthtimeMs,
      mtimeMs: initialStat.mtimeMs,
      observedMtimeMs: initialStat.mtimeMs,
      offset: initialStat.size,
      readOffset: initialStat.size,
      observedSize: initialStat.size,
      anchorOffset: initialStat.size - anchorLength,
      anchorBytes: Buffer.alloc(0),
      pendingByteCount: 0,
      pendingText: '',
      pendingUtf8: Buffer.alloc(0),
      pendingDigest: createPendingDigest(),
    };
    cursor.anchorBytes = await readBoundedRange(
      fileHandle, cursor.anchorOffset, anchorLength, 'initial log anchor',
    );
    const afterAnchorStat = await fileHandle.stat();
    validateLogContinuation(cursor, afterAnchorStat);
    if (afterAnchorStat.size !== initialStat.size
      || afterAnchorStat.mtimeMs !== initialStat.mtimeMs) {
      fail('log changed while recording the initial offset and anchor');
    }
    await assertLogAnchorUnchanged(fileHandle, cursor);
    observeLogHighWater(cursor, afterAnchorStat);
  } finally {
    await fileHandle.close();
  }
  const afterPathStat = await stat(logPath);
  observeLogHighWater(cursor, afterPathStat);
  return cursor;
}

async function assertLogAnchorUnchanged(fileHandle, cursor) {
  const observed = await readBoundedRange(
    fileHandle, cursor.anchorOffset, cursor.anchorBytes.length, 'log anchor',
  );
  assertMatchingLogAnchor(cursor.anchorBytes, observed);
}

export async function ingestAppendedLogBytes(logPath, cursor, currentStat) {
  observeLogHighWater(cursor, currentStat);
  const targetOffset = currentStat.size;
  if (targetOffset - cursor.offset > LOG_SEGMENT_MAX_BYTES) {
    fail(`appended log segment exceeds bounded maximum of ${LOG_SEGMENT_MAX_BYTES} bytes`);
  }

  const fileHandle = await open(logPath, 'r');
  try {
    const openStat = await fileHandle.stat();
    observeLogHighWater(cursor, openStat);
    if (openStat.size < targetOffset) fail('log truncated or rotated during appended read');
    await assertLogAnchorUnchanged(fileHandle, cursor);

    if (cursor.readOffset < targetOffset) {
      const readBuffer = Buffer.allocUnsafe(LOG_READ_CHUNK_BYTES);
      while (cursor.readOffset < targetOffset) {
        const readLength = Math.min(LOG_READ_CHUNK_BYTES, targetOffset - cursor.readOffset);
        const result = await fileHandle.read(readBuffer, 0, readLength, cursor.readOffset);
        if (result.bytesRead === 0) {
          fail(`short appended log read before byte offset ${targetOffset}`);
        }
        appendDecodedLogBytes(cursor, readBuffer.subarray(0, result.bytesRead));
      }
    }

    await assertLogAnchorUnchanged(fileHandle, cursor);
    const afterHandleStat = await fileHandle.stat();
    observeLogHighWater(cursor, afterHandleStat);
    if (afterHandleStat.size < targetOffset) fail('log truncated during appended read');
  } finally {
    await fileHandle.close();
  }

  const afterReadStat = await stat(logPath);
  validateLogContinuation(cursor, afterReadStat);
  observeLogHighWater(cursor, afterReadStat);
  if (afterReadStat.size < targetOffset) fail('log truncated during appended read');
  return cursor.pendingText;
}

export async function commitPendingLogSegment(logPath, cursor) {
  if (cursor.observedSize > cursor.readOffset) return null;
  const pendingByteCount = cursor.pendingByteCount ?? 0;
  if (pendingByteCount > 0) {
    if (cursor.pendingUtf8.length !== 0) fail('cannot commit an incomplete UTF-8 log suffix');
    if (!cursor.pendingText.endsWith('\n')) fail('cannot commit an incomplete log line without a newline');
  }

  const boundaryOffset = cursor.readOffset;
  const expectedPendingDigest = snapshotPendingDigest(cursor);
  const anchorLength = Math.min(LOG_ANCHOR_BYTES, boundaryOffset);
  const anchorOffset = boundaryOffset - anchorLength;
  let anchorBytes = null;
  let committedMtimeMs = cursor.mtimeMs;
  const fileHandle = await open(logPath, 'r');
  try {
    const openStat = await fileHandle.stat();
    observeLogHighWater(cursor, openStat);
    if (cursor.observedSize > boundaryOffset) return null;
    if (openStat.size < boundaryOffset) fail('log truncated before evidence commit');
    await assertLogAnchorUnchanged(fileHandle, cursor);
    const observedPendingDigest = await digestLogRange(
      fileHandle, cursor.offset, pendingByteCount, 'pending log evidence',
    );
    assertMatchingPendingDigest(expectedPendingDigest, observedPendingDigest);
    const afterDigestStat = await fileHandle.stat();
    observeLogHighWater(cursor, afterDigestStat);
    if (cursor.observedSize > boundaryOffset) return null;
    if (afterDigestStat.size < boundaryOffset) fail('log truncated during evidence digest');
    if (afterDigestStat.mtimeMs !== openStat.mtimeMs) {
      fail('log changed at the same size during pending evidence verification');
    }
    anchorBytes = await readBoundedRange(
      fileHandle, anchorOffset, anchorLength, 'committed log anchor',
    );
    await assertLogAnchorUnchanged(fileHandle, cursor);
    const afterAnchorStat = await fileHandle.stat();
    observeLogHighWater(cursor, afterAnchorStat);
    if (cursor.observedSize > boundaryOffset) return null;
    if (afterAnchorStat.size < boundaryOffset) fail('log truncated during evidence commit');
    if (afterAnchorStat.mtimeMs !== afterDigestStat.mtimeMs) {
      fail('log changed at the same size during evidence anchor verification');
    }
    committedMtimeMs = afterAnchorStat.mtimeMs;
  } finally {
    await fileHandle.close();
  }

  const afterCommitStat = await stat(logPath);
  observeLogHighWater(cursor, afterCommitStat);
  if (cursor.observedSize > boundaryOffset) return null;
  if (afterCommitStat.size < boundaryOffset) fail('log truncated after evidence commit');
  if (afterCommitStat.mtimeMs !== committedMtimeMs) {
    fail('log changed at the same size after evidence verification');
  }

  return commitLogEvidence(cursor, {
    boundaryOffset,
    mtimeMs: committedMtimeMs,
    anchorOffset,
    anchorBytes,
  });
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
    await ingestAppendedLogBytes(logPath, cursor, currentStat);
    const eventCount = extractTcpEventLines(cursor.pendingText).length;
    const evidenceFingerprint = transportEvidenceFingerprint(cursor.pendingText);
    const hasCompleteUtf8 = cursor.pendingUtf8.length === 0;
    const hasCompleteLines = cursor.pendingText.length === 0 || cursor.pendingText.endsWith('\n');

    if (evidenceFingerprint === previousEvidenceFingerprint) {
      stableObservations += 1;
    } else {
      stableObservations = 0;
    }
    if (stableObservations >= 1 && eventCount >= expectedEventCount
      && hasCompleteUtf8 && hasCompleteLines) {
      const committedSegment = await commitPendingLogSegment(logPath, cursor);
      if (committedSegment !== null) return committedSegment;
    }

    previousEvidenceFingerprint = evidenceFingerprint;
    await sleep(LOG_POLL_MS);
  }
  if (cursor.pendingUtf8.length > 0) fail('timed out with an incomplete UTF-8 log suffix');
  if (cursor.pendingText.length > 0 && !cursor.pendingText.endsWith('\n')) {
    fail('timed out with an incomplete log line without a newline');
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

export function buildOversizedDeclarationProbeBytes() {
  const oversizedLength = TCP_MAX_REQUEST_BODY_BYTES + 1;
  return Buffer.from(`Content-Length: ${oversizedLength}\r\n\r\n`, 'ascii');
}

export function splitRequestForResetBarrier(requestBytes) {
  if (!Buffer.isBuffer(requestBytes)) fail('reset barrier request bytes must be a Buffer');
  if (requestBytes.length < 2) fail('reset barrier request must contain at least two bytes');
  return {
    prefix: requestBytes.subarray(0, -1),
    finalByte: requestBytes.subarray(-1),
  };
}

function receiveDecodedResponse(selectedPort, {
  requestBytes = null,
  start = null,
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

export function resetPeerAfterFinalRequestByte(selectedPort, requestBytes, {
  timeoutMs = SOCKET_PROBE_TIMEOUT_MS,
  connect = (options) => net.createConnection(options),
  wait = sleep,
} = {}) {
  // Let the server settle on an incomplete frame, then complete and reset it before dispatch can reply.
  const { prefix, finalByte } = splitRequestForResetBarrier(requestBytes);
  return new Promise((resolve, reject) => {
    const socket = connect({ host: TCP_HOST, port: selectedPort });
    let settled = false;
    let timer = null;

    const finish = (error, observation = null) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      if (!socket.destroyed) socket.destroy();
      if (error) reject(error);
      else resolve(observation);
    };
    const writeBytes = (bytes) => new Promise((writeResolve, writeReject) => {
      socket.write(bytes, (error) => (error ? writeReject(error) : writeResolve()));
    });
    timer = setTimeout(() => finish(new Error('response-reset probe timed out')), timeoutMs);

    socket.setNoDelay(true);
    socket.on('connect', async () => {
      try {
        await writeBytes(prefix);
        if (settled) return;
        await wait(RESET_REQUEST_PREFIX_SETTLE_MS);
        if (settled) return;
        await writeBytes(finalByte);
        if (settled) return;
        await wait(RESET_AFTER_FINAL_BYTE_MS);
        if (settled) return;
        socket.resetAndDestroy();
        finish(null, {
          response: null,
          receivedBytes: 0,
          requestBytes: requestBytes.length,
        });
      } catch (error) {
        finish(error);
      }
    });
    socket.on('data', (chunk) => {
      finish(new Error(`response began before reset barrier completed (${chunk.length} bytes)`));
    });
    socket.on('end', () => finish(new Error('peer ended before reset barrier completed')));
    socket.on('close', () => {
      if (!settled) finish(new Error('peer closed before reset barrier completed'));
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
    const { response } = await receiveDecodedResponse(selectedPort, {
      requestBytes: buildOversizedDeclarationProbeBytes(),
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
    const observation = await resetPeerAfterFinalRequestByte(selectedPort, requestBytes, {
      timeoutMs: deriveSocketProbeTimeoutMs(callerTimeoutMs),
    });
    assertNoResponse(observation, probeId);
    return `request_bytes=${observation.requestBytes} response_bytes=0`;
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

async function captureProbeLog(probe, run, logPath, cursor) {
  const beforeSegment = await waitForStableAppendedSegment(logPath, cursor);
  assertNoPayloadLeak([beforeSegment]);
  assertNoTokenlessTransportWarnings(beforeSegment, `${probe.id} before segment`);
  assertNoDelayedTcpEvents(beforeSegment, probe.id);

  const summary = await run();
  const afterSegment = await waitForStableAppendedSegment(logPath, cursor, {
    expectedEventCount: probe.expectedEvents.length,
  });
  assertNoPayloadLeak([afterSegment]);
  assertNoTokenlessTransportWarnings(afterSegment, `${probe.id} after segment`);
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
  const cursor = await createLogCursor(logPath);
  const startLogOffset = cursor.offset;
  const startLogTimestampMs = cursor.mtimeMs;

  const selectedPort = smoke.cm.config.tcpPortCustom;
  if (!Number.isInteger(selectedPort) || selectedPort < 1 || selectedPort > 65535) {
    fail('selected TCP port is invalid');
  }
  const callerTimeoutMs = smoke.cm.config.tcpTimeoutMs;
  for (const probe of TCP_FAULT_PROBES) {
    const result = await captureProbeLog(
      probe,
      () => executeProbe(probe.id, { selectedPort, animBlueprintPath, callerTimeoutMs }),
      logPath,
      cursor,
    );
    console.log(`PASS ${probe.id}: ${result.summary} events=${result.eventCount}`);
  }

  const finalSegment = await waitForStableAppendedSegment(logPath, cursor);
  assertNoPayloadLeak([finalSegment]);
  assertNoDelayedTcpEvents(finalSegment, 'final tail');
  assertNoTokenlessTransportWarnings(finalSegment, 'final tail');
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
