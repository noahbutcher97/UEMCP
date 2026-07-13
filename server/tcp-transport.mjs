import { isUtf8 } from 'node:buffer';

export const TCP_MAX_HEADER_BYTES = 512;
export const TCP_MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;

const FRAMING_PREFIX = Buffer.from('content-length:', 'ascii');
const HEADER_TERMINATOR = Buffer.from('\r\n\r\n', 'ascii');
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const SAFE_DETAIL_FIELDS = Object.freeze([
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

function isSafeDetailValue(value) {
  return value === null
    || typeof value === 'string'
    || typeof value === 'boolean'
    || (typeof value === 'number' && Number.isFinite(value));
}

function safeDetails(details) {
  const result = {};
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    for (const field of SAFE_DETAIL_FIELDS) {
      if (Object.hasOwn(details, field) && isSafeDetailValue(details[field])) {
        result[field] = details[field];
      }
    }
  }
  return Object.freeze(result);
}

export class TcpTransportError extends Error {
  constructor(code, port, details = {}) {
    super(`TCP:${port} ${code}`);
    this.name = 'TcpTransportError';
    this.code = code;
    this.details = safeDetails(details);
  }
}

export function encodeTcpRequest(
  type,
  params,
  { port, maxBodyBytes = TCP_MAX_REQUEST_BODY_BYTES } = {},
) {
  const body = Buffer.from(JSON.stringify({ type, params }), 'utf8');
  const bodyBytes = body.length;
  if (bodyBytes > maxBodyBytes) {
    throw new TcpTransportError('REQUEST_TOO_LARGE', port, {
      direction: 'request',
      bodyBytes,
      maxBodyBytes,
    });
  }

  const header = Buffer.from(`Content-Length: ${bodyBytes}\r\n\r\n`, 'ascii');
  const frame = Buffer.concat([header, body]);
  return { body, frame, bodyBytes };
}

function isJsonWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;
}

function asciiLower(byte) {
  return byte >= 0x41 && byte <= 0x5a ? byte + 0x20 : byte;
}

function hasHeaderTerminator(buffer, length) {
  if (length < HEADER_TERMINATOR.length) return false;
  const start = length - HEADER_TERMINATOR.length;
  for (let index = 0; index < HEADER_TERMINATOR.length; index++) {
    if (buffer[start + index] !== HEADER_TERMINATOR[index]) return false;
  }
  return true;
}

function trimAsciiSpaceTab(value) {
  let start = 0;
  let end = value.length;
  while (start < end && (value.charCodeAt(start) === 0x20 || value.charCodeAt(start) === 0x09)) {
    start++;
  }
  while (end > start && (value.charCodeAt(end - 1) === 0x20 || value.charCodeAt(end - 1) === 0x09)) {
    end--;
  }
  return value.substring(start, end);
}

function checkedDecimal(value) {
  if (value.length === 0) return { reasonCode: 'invalid_content_length' };
  let result = 0;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < 0x30 || code > 0x39) return { reasonCode: 'invalid_content_length' };
    const digit = code - 0x30;
    if (result > Math.floor((Number.MAX_SAFE_INTEGER - digit) / 10)) {
      return { reasonCode: 'content_length_overflow' };
    }
    result = result * 10 + digit;
  }
  return { value: result };
}

function parseHeader(buffer, length) {
  const contentLengthName = 'content-length';
  const blockLength = length - HEADER_TERMINATOR.length;
  for (let index = 0; index < blockLength; index++) {
    if (buffer[index] > 0x7f) return { reasonCode: 'invalid_header' };
  }

  const lines = buffer.subarray(0, blockLength).toString('ascii').split('\r\n');
  if (lines.length === 0) return { reasonCode: 'invalid_header' };

  const firstColon = lines[0].indexOf(':');
  if (firstColon <= 0
    || lines[0].substring(0, firstColon).toLowerCase() !== contentLengthName) {
    return { reasonCode: 'invalid_header' };
  }

  const parsedLength = checkedDecimal(trimAsciiSpaceTab(lines[0].substring(firstColon + 1)));
  if (parsedLength.reasonCode) return parsedLength;

  for (let index = 1; index < lines.length; index++) {
    const line = lines[index];
    const colon = line.indexOf(':');
    if (colon <= 0) return { reasonCode: 'invalid_header' };
    const name = line.substring(0, colon);
    if (!/^[A-Za-z0-9-]+$/.test(name)) return { reasonCode: 'invalid_header' };
    if (name.toLowerCase() === contentLengthName) return { reasonCode: 'invalid_header' };
    for (let valueIndex = colon + 1; valueIndex < line.length; valueIndex++) {
      const code = line.charCodeAt(valueIndex);
      if (code !== 0x09 && (code < 0x20 || code > 0x7e)) {
        return { reasonCode: 'invalid_header' };
      }
    }
  }

  return { value: parsedLength.value };
}

function immutableSnapshot(status, framing, bytesReceived, declaredBodyLength, terminal = {}) {
  return Object.freeze({
    status,
    framing,
    bytesReceived,
    declaredBodyLength,
    ...terminal,
  });
}

function isJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || seen.has(value)) return false;

  const isArray = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (!isArray && prototype !== Object.prototype && prototype !== null) return false;

  seen.add(value);
  if (isArray) {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.at(-1) !== 'length') return false;
    for (let index = 0; index < value.length; index++) {
      if (keys[index] !== String(index) || !isJsonValue(value[index], seen)) return false;
    }
    return true;
  }

  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return false;
    if (!isJsonValue(descriptor.value, seen)) return false;
  }
  return true;
}

function freezeJsonValue(value) {
  if (value === null || typeof value !== 'object') return;
  for (const child of Object.values(value)) freezeJsonValue(child);
  Object.freeze(value);
}

function isPartialBom(prefix, bodyBytes) {
  return (bodyBytes === 1 && prefix[0] === UTF8_BOM[0])
    || (bodyBytes === 2 && prefix[0] === UTF8_BOM[0] && prefix[1] === UTF8_BOM[1]);
}

function hasTruncatedUtf8Tail(tail) {
  if (tail.length === 0) return false;
  let continuationCount = 0;
  let index = tail.length - 1;
  while (index >= 0 && tail[index] >= 0x80 && tail[index] <= 0xbf) {
    continuationCount++;
    index--;
  }
  if (index < 0) return false;

  const lead = tail[index];
  let expectedContinuations = 0;
  if (lead >= 0xc2 && lead <= 0xdf) expectedContinuations = 1;
  else if (lead >= 0xe0 && lead <= 0xef) expectedContinuations = 2;
  else if (lead >= 0xf0 && lead <= 0xf4) expectedContinuations = 3;
  return expectedContinuations > continuationCount;
}

export class TcpResponseDecoder {
  constructor({ maxHeaderBytes = TCP_MAX_HEADER_BYTES, parseJson = JSON.parse } = {}) {
    if (!Number.isInteger(maxHeaderBytes)
      || maxHeaderBytes <= 0
      || maxHeaderBytes > TCP_MAX_HEADER_BYTES) {
      throw new RangeError(`maxHeaderBytes must be between 1 and ${TCP_MAX_HEADER_BYTES}`);
    }
    if (typeof parseJson !== 'function') throw new TypeError('parseJson must be a function');

    this._maxHeaderBytes = maxHeaderBytes;
    this._parseJson = parseJson;
    this._headerScratch = Buffer.alloc(TCP_MAX_HEADER_BYTES);
    this._headerBytes = 0;
    this._prefixBytesMatched = 0;
    this._headerComplete = false;
    this._framing = 'undecided';
    this._bytesReceived = 0;
    this._declaredBodyLength = null;
    this._bodySegments = [];
    this._bodyBytes = 0;
    this._bodyPrefix = [];
    this._utf8Tail = [];

    this._legacyBomProgress = 0;
    this._legacyBomSeen = false;
    this._legacyBeforeRoot = true;
    this._legacyRootComplete = false;
    this._legacyDelimiters = [];
    this._legacyInString = false;
    this._legacyEscaped = false;

    this._stats = {
      legacyBytesScanned: 0,
      bodyAssemblyCount: 0,
      jsonParseCount: 0,
    };
    this._snapshot = immutableSnapshot('pending', 'undecided', 0, null);
  }

  consume(chunk) {
    if (this._snapshot.status !== 'pending') {
      throw new Error('TCP response decoder is already terminal');
    }
    if (!Buffer.isBuffer(chunk) && !(chunk instanceof Uint8Array)) {
      throw new TypeError('TCP response chunks must be Buffer or Uint8Array');
    }

    const bytes = Buffer.isBuffer(chunk)
      ? chunk
      : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    this._bytesReceived += bytes.length;

    if (bytes.length > 0) {
      if (this._framing === 'undecided') this._consumeUndecided(bytes);
      else if (this._framing === 'framed') this._consumeFramed(bytes, 0);
      else this._consumeLegacy(bytes);
    }

    if (this._snapshot.status === 'pending') this._refreshPendingSnapshot();
    return this._snapshot;
  }

  finish() {
    if (this._snapshot.status !== 'pending') return this._snapshot;

    let reasonCode;
    if (this._bytesReceived === 0) {
      reasonCode = 'no_response';
    } else if (this._framing === 'undecided') {
      reasonCode = 'incomplete_prefix';
    } else if (this._framing === 'framed' && !this._headerComplete) {
      reasonCode = 'incomplete_header';
    } else if (this._framing === 'legacy' && this._legacyBomProgress > 0) {
      reasonCode = 'partial_bom';
    } else if (isPartialBom(this._bodyPrefix, this._bodyBytes)) {
      reasonCode = 'partial_bom';
    } else if (hasTruncatedUtf8Tail(this._utf8Tail)) {
      reasonCode = 'truncated_utf8';
    } else if (this._framing === 'framed') {
      reasonCode = 'incomplete_body';
    } else {
      reasonCode = 'incomplete_legacy';
    }

    this._setMalformed(reasonCode);
    return this._snapshot;
  }

  snapshot() {
    return this._snapshot;
  }

  debugStatsForTests() {
    return { ...this._stats };
  }

  _refreshPendingSnapshot() {
    this._snapshot = immutableSnapshot(
      'pending',
      this._framing,
      this._bytesReceived,
      this._declaredBodyLength,
    );
  }

  _setMalformed(reasonCode) {
    this._snapshot = immutableSnapshot(
      'malformed',
      this._framing,
      this._bytesReceived,
      this._declaredBodyLength,
      { reasonCode },
    );
  }

  _setComplete(value) {
    this._snapshot = immutableSnapshot(
      'complete',
      this._framing,
      this._bytesReceived,
      this._declaredBodyLength,
      { value },
    );
  }

  _consumeUndecided(bytes) {
    for (let index = 0; index < bytes.length; index++) {
      const byte = bytes[index];
      this._headerScratch[this._headerBytes++] = byte;
      if (asciiLower(byte) !== FRAMING_PREFIX[this._prefixBytesMatched]) {
        this._framing = 'legacy';
        this._consumeLegacy(this._headerScratch.subarray(0, this._headerBytes));
        if (this._snapshot.status === 'pending' && index + 1 < bytes.length) {
          this._consumeLegacy(bytes.subarray(index + 1));
        }
        return;
      }

      this._prefixBytesMatched++;
      if (this._prefixBytesMatched === FRAMING_PREFIX.length) {
        this._framing = 'framed';
        if (index + 1 < bytes.length) this._consumeFramed(bytes, index + 1);
        return;
      }

      if (this._headerBytes === this._maxHeaderBytes) {
        this._framing = 'framed';
        this._setMalformed('header_too_large');
        return;
      }
    }
  }

  _consumeFramed(bytes, startIndex) {
    if (this._headerComplete) {
      this._consumeFramedBody(bytes.subarray(startIndex));
      return;
    }

    for (let index = startIndex; index < bytes.length; index++) {
      this._headerScratch[this._headerBytes++] = bytes[index];
      if (hasHeaderTerminator(this._headerScratch, this._headerBytes)) {
        const parsed = parseHeader(this._headerScratch, this._headerBytes);
        if (parsed.reasonCode) {
          this._setMalformed(parsed.reasonCode);
          return;
        }

        this._headerComplete = true;
        this._declaredBodyLength = parsed.value;
        const bodyStart = index + 1;
        const bufferedBodyBytes = bytes.length - bodyStart;
        if (bufferedBodyBytes > this._declaredBodyLength) {
          this._setMalformed('trailing_bytes');
          return;
        }
        if (bufferedBodyBytes > 0) this._appendBody(bytes.subarray(bodyStart));
        if (this._bodyBytes === this._declaredBodyLength) this._finalizeBody();
        return;
      }

      if (this._headerBytes === this._maxHeaderBytes) {
        this._setMalformed('header_too_large');
        return;
      }
    }
  }

  _consumeFramedBody(bytes) {
    const remaining = this._declaredBodyLength - this._bodyBytes;
    if (bytes.length > remaining) {
      this._setMalformed('trailing_bytes');
      return;
    }
    if (bytes.length > 0) this._appendBody(bytes);
    if (this._bodyBytes === this._declaredBodyLength) this._finalizeBody();
  }

  _appendBody(bytes) {
    const retained = Buffer.from(bytes);
    this._bodySegments.push(retained);
    for (const byte of retained) this._noteBodyByte(byte);
    this._bodyBytes += retained.length;
  }

  _noteBodyByte(byte) {
    if (this._bodyPrefix.length < UTF8_BOM.length) this._bodyPrefix.push(byte);
    this._utf8Tail.push(byte);
    if (this._utf8Tail.length > 4) this._utf8Tail.shift();
  }

  _consumeLegacy(bytes) {
    const retained = Buffer.from(bytes);
    this._bodySegments.push(retained);

    for (const byte of retained) {
      if (this._snapshot.status !== 'pending') return;
      this._stats.legacyBytesScanned++;
      this._noteBodyByte(byte);
      this._bodyBytes++;
      this._scanLegacyByte(byte, this._stats.legacyBytesScanned - 1);
    }

    if (this._snapshot.status === 'pending' && this._legacyRootComplete) {
      this._finalizeBody();
    }
  }

  _scanLegacyByte(byte, position) {
    if (this._legacyBeforeRoot) {
      this._scanLegacyBeforeRoot(byte, position);
      return;
    }

    if (this._legacyRootComplete) {
      if (!isJsonWhitespace(byte)) this._setMalformed('trailing_bytes');
      return;
    }

    if (this._legacyInString) {
      if (this._legacyEscaped) {
        this._legacyEscaped = false;
      } else if (byte === 0x5c) {
        this._legacyEscaped = true;
      } else if (byte === 0x22) {
        this._legacyInString = false;
      }
      return;
    }

    if (byte === 0x22) {
      this._legacyInString = true;
      return;
    }
    if (byte === 0x7b || byte === 0x5b) {
      this._legacyDelimiters.push(byte);
      return;
    }
    if (byte !== 0x7d && byte !== 0x5d) return;

    const expectedOpen = byte === 0x7d ? 0x7b : 0x5b;
    if (this._legacyDelimiters.at(-1) !== expectedOpen) {
      this._setMalformed('mismatched_delimiter');
      return;
    }
    this._legacyDelimiters.pop();
    if (this._legacyDelimiters.length === 0) this._legacyRootComplete = true;
  }

  _scanLegacyBeforeRoot(byte, position) {
    if (this._legacyBomProgress === 1) {
      if (byte !== UTF8_BOM[1]) {
        this._setMalformed('invalid_bom');
      } else {
        this._legacyBomProgress = 2;
      }
      return;
    }
    if (this._legacyBomProgress === 2) {
      if (byte !== UTF8_BOM[2]) {
        this._setMalformed('invalid_bom');
      } else {
        this._legacyBomProgress = 0;
        this._legacyBomSeen = true;
      }
      return;
    }

    if (byte === UTF8_BOM[0]) {
      if (position !== 0 || this._legacyBomSeen) this._setMalformed('invalid_bom');
      else this._legacyBomProgress = 1;
      return;
    }
    if (isJsonWhitespace(byte)) return;
    if (byte !== 0x7b) {
      this._setMalformed('root_not_object');
      return;
    }

    this._legacyBeforeRoot = false;
    this._legacyDelimiters.push(byte);
  }

  _finalizeBody() {
    this._stats.bodyAssemblyCount++;
    const body = Buffer.concat(this._bodySegments, this._bodyBytes);
    let bodyOffset = 0;

    if (isPartialBom(this._bodyPrefix, this._bodyBytes)) {
      this._setMalformed('invalid_bom');
      return;
    }
    if (body.length >= UTF8_BOM.length && body.subarray(0, UTF8_BOM.length).equals(UTF8_BOM)) {
      bodyOffset = UTF8_BOM.length;
    }

    let rootOffset = bodyOffset;
    while (rootOffset < body.length && isJsonWhitespace(body[rootOffset])) rootOffset++;
    if (rootOffset + UTF8_BOM.length <= body.length
      && body.subarray(rootOffset, rootOffset + UTF8_BOM.length).equals(UTF8_BOM)) {
      this._setMalformed('invalid_bom');
      return;
    }
    if (!isUtf8(body)) {
      this._setMalformed('invalid_utf8');
      return;
    }

    let value;
    this._stats.jsonParseCount++;
    try {
      value = this._parseJson(body.subarray(bodyOffset).toString('utf8'));
    } catch {
      this._setMalformed('invalid_json');
      return;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      this._setMalformed('root_not_object');
      return;
    }
    if (!isJsonValue(value)) {
      this._setMalformed('invalid_json');
      return;
    }
    freezeJsonValue(value);
    this._setComplete(value);
  }
}
