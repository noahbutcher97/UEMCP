const DEFAULT_CONFIG_BYTE_LIMIT = 16 * 1024 * 1024;
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

export class ConfigFormatError extends Error {
  constructor(message, code = 'MALFORMED_CONFIG', details = {}) {
    super(message);
    this.name = 'ConfigFormatError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code = 'MALFORMED_CONFIG', details = {}) {
  throw new ConfigFormatError(message, code, details);
}

export function decodeConfigBytes(bytes, {
  pathLabel = 'client config',
  maxBytes = DEFAULT_CONFIG_BYTE_LIMIT,
} = {}) {
  if (!Buffer.isBuffer(bytes)) fail(`${pathLabel} must be provided as bytes`);
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) fail(`${pathLabel} byte limit is invalid`);
  if (bytes.byteLength > maxBytes) {
    fail(`${pathLabel} exceeds its inspection byte limit`, 'INSPECTION_LIMIT_EXCEEDED', {
      maximum_bytes: maxBytes,
      observed_bytes: bytes.byteLength,
    });
  }

  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    fail(`${pathLabel} must be UTF-8, not UTF-16`);
  }
  const hadUtf8Bom = bytes.length >= UTF8_BOM.length && bytes.subarray(0, UTF8_BOM.length).equals(UTF8_BOM);
  const content = hadUtf8Bom ? bytes.subarray(UTF8_BOM.length) : bytes;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    fail(`${pathLabel} contains invalid UTF-8`);
  }
  if (text.includes('\0')) fail(`${pathLabel} contains an embedded NUL`);
  return Object.freeze({ text, had_utf8_bom: hadUtf8Bom });
}

export const CONFIG_BYTE_LIMIT = DEFAULT_CONFIG_BYTE_LIMIT;
export const UTF8_BOM_BYTES = UTF8_BOM;
