import { isDeepStrictEqual } from 'node:util';

import {
  applyEdits,
  findNodeAtLocation,
  getNodeValue,
  modify,
  parseTree,
} from 'jsonc-parser';

import {
  ConfigFormatError,
  decodeConfigBytes,
  UTF8_BOM_BYTES,
} from './config-bytes.mjs';

function fail(message, details = {}) {
  throw new ConfigFormatError(message, 'MALFORMED_CONFIG', details);
}

function validatePath(path) {
  if (!Array.isArray(path) || path.length === 0 || path.some(segment => !(
    (typeof segment === 'string' && segment !== '')
    || (Number.isSafeInteger(segment) && segment >= 0)
  ))) {
    fail('JSONC path is invalid');
  }
  return path;
}

function validateJsonValue(value, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('JSONC value contains a non-finite number');
    return;
  }
  if (typeof value !== 'object') fail('JSONC value is not representable');
  if (seen.has(value)) fail('JSONC value contains a cycle');
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) validateJsonValue(item, seen);
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail('JSONC value must use plain objects');
    for (const [key, item] of Object.entries(value)) {
      if (key.includes('\0')) fail('JSONC object key contains an embedded NUL');
      validateJsonValue(item, seen);
    }
  }
  seen.delete(value);
}

function assertUniqueObjectKeys(node) {
  if (!node) return;
  if (node.type === 'object') {
    const keys = new Set();
    for (const property of node.children ?? []) {
      const key = property.children?.[0]?.value;
      if (typeof key !== 'string' || keys.has(key)) fail('JSONC contains duplicate or invalid object keys');
      keys.add(key);
    }
  }
  for (const child of node.children ?? []) assertUniqueObjectKeys(child);
}

function dominantNewline(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? '\r\n' : '\n';
}

function indentation(text) {
  const matches = [...text.matchAll(/^(\s+)(?="(?:[^"\\]|\\.)*"\s*:)/gm)]
    .map(match => match[1].replace(/[\r\n]/g, ''))
    .filter(Boolean);
  if (matches.some(value => value.includes('\t'))) return { insertSpaces: false, tabSize: 1 };
  const widths = matches.map(value => value.length).filter(value => value > 0);
  return { insertSpaces: true, tabSize: widths.length > 0 ? Math.min(...widths) : 2 };
}

function addBom(text, hadBom) {
  const content = Buffer.from(text, 'utf8');
  return hadBom ? Buffer.concat([UTF8_BOM_BYTES, content]) : content;
}

function validateEdits(edits, textLength) {
  const sorted = [...edits].sort((left, right) => right.offset - left.offset || right.length - left.length);
  let lowerBound = textLength;
  for (const edit of sorted) {
    if (!Number.isSafeInteger(edit.offset) || !Number.isSafeInteger(edit.length)
      || edit.offset < 0 || edit.length < 0 || edit.offset + edit.length > textLength) {
      fail('JSONC parser returned an invalid edit range');
    }
    if (edit.offset + edit.length > lowerBound) fail('JSONC parser returned overlapping edit ranges');
    lowerBound = edit.offset;
  }
  return sorted;
}

function result(document, afterText, edits) {
  const afterBytes = addBom(afterText, document.had_utf8_bom);
  const parsed = parseJsoncDocument(afterBytes, {
    pathLabel: document.path_label,
    maxBytes: document.max_bytes,
    allowTrailingComma: document.allow_trailing_comma,
  });
  return Object.freeze({
    before_bytes: document.bytes,
    after_bytes: afterBytes,
    changed: true,
    parsed_value: parsed.parsed_value,
    edits: Object.freeze(edits.map(edit => Object.freeze({ ...edit }))),
  });
}

function noChange(document) {
  return Object.freeze({
    before_bytes: document.bytes,
    after_bytes: document.bytes,
    changed: false,
    parsed_value: document.parsed_value,
    edits: Object.freeze([]),
  });
}

export function parseJsoncDocument(bytes, {
  pathLabel = 'client JSONC config',
  maxBytes = 16 * 1024 * 1024,
  allowTrailingComma = true,
} = {}) {
  const decoded = decodeConfigBytes(bytes, { pathLabel, maxBytes });
  const errors = [];
  const root = parseTree(decoded.text, errors, {
    allowTrailingComma,
    allowEmptyContent: true,
    disallowComments: false,
  });
  if (errors.length > 0) fail(`${pathLabel} contains malformed JSONC`, { error_count: errors.length });
  assertUniqueObjectKeys(root);
  const parsedValue = root ? getNodeValue(root) : {};
  if (parsedValue === null || Array.isArray(parsedValue) || typeof parsedValue !== 'object') {
    fail(`${pathLabel} must contain a top-level object`);
  }
  const newline = dominantNewline(decoded.text);
  return Object.freeze({
    kind: 'jsonc_document',
    path_label: pathLabel,
    max_bytes: maxBytes,
    allow_trailing_comma: allowTrailingComma,
    bytes,
    text: decoded.text,
    had_utf8_bom: decoded.had_utf8_bom,
    root,
    parsed_value: parsedValue,
    formatting: Object.freeze({ ...indentation(decoded.text), eol: newline }),
  });
}

export function getJsoncValue(document, jsonPath) {
  if (document?.kind !== 'jsonc_document') fail('JSONC document is invalid');
  validatePath(jsonPath);
  if (!document.root) return undefined;
  const node = findNodeAtLocation(document.root, jsonPath);
  return node ? getNodeValue(node) : undefined;
}

export function setJsoncValue(document, jsonPath, value) {
  if (document?.kind !== 'jsonc_document') fail('JSONC document is invalid');
  validatePath(jsonPath);
  validateJsonValue(value);
  const current = getJsoncValue(document, jsonPath);
  if (current !== undefined && isDeepStrictEqual(current, value)) return noChange(document);
  let edits;
  try {
    edits = modify(document.text, jsonPath, value, { formattingOptions: document.formatting });
  } catch {
    fail('JSONC value cannot be represented safely');
  }
  const safeEdits = validateEdits(edits, document.text.length);
  if (safeEdits.length === 0) return noChange(document);
  let afterText;
  try {
    afterText = applyEdits(document.text, safeEdits);
  } catch {
    fail('JSONC edits could not be applied safely');
  }
  return result(document, afterText, safeEdits);
}

export function setJsoncValues(document, changes) {
  if (document?.kind !== 'jsonc_document') fail('JSONC document is invalid');
  if (!Array.isArray(changes) || changes.some(change => (
    !change || Array.isArray(change) || typeof change !== 'object'
    || !Object.hasOwn(change, 'path') || !Object.hasOwn(change, 'value')
  ))) fail('JSONC multi-edit list is invalid');
  let current = document;
  const steps = [];
  for (const change of changes) {
    const edit = setJsoncValue(current, change.path, change.value);
    if (!edit.changed) continue;
    steps.push(Object.freeze({
      path: Object.freeze([...change.path]),
      edits: edit.edits,
    }));
    current = parseJsoncDocument(edit.after_bytes, {
      pathLabel: document.path_label,
      maxBytes: document.max_bytes,
      allowTrailingComma: document.allow_trailing_comma,
    });
  }
  if (steps.length === 0) return noChange(document);
  return Object.freeze({
    before_bytes: document.bytes,
    after_bytes: current.bytes,
    changed: true,
    parsed_value: current.parsed_value,
    edit_steps: Object.freeze(steps),
  });
}

export function removeJsoncValue(document, jsonPath) {
  if (document?.kind !== 'jsonc_document') fail('JSONC document is invalid');
  validatePath(jsonPath);
  if (getJsoncValue(document, jsonPath) === undefined) return noChange(document);
  const edits = validateEdits(modify(document.text, jsonPath, undefined, {
    formattingOptions: document.formatting,
  }), document.text.length);
  if (edits.length === 0) return noChange(document);
  return result(document, applyEdits(document.text, edits), edits);
}
