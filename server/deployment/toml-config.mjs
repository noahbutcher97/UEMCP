import { isDeepStrictEqual } from 'node:util';

import { getStaticTOMLValue, parseTOML } from 'toml-eslint-parser';

import {
  ConfigFormatError,
  decodeConfigBytes,
  UTF8_BOM_BYTES,
} from './config-bytes.mjs';

function fail(message, details = {}) {
  throw new ConfigFormatError(message, 'MALFORMED_CONFIG', details);
}

function validatePath(path) {
  if (!Array.isArray(path) || path.length === 0 || path.some(segment => typeof segment !== 'string' || segment === '')) {
    fail('TOML table path is invalid');
  }
  return path;
}

function keySegments(key) {
  return (key?.keys ?? []).map(segment => segment.name ?? segment.value).filter(value => typeof value === 'string');
}

function samePath(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function startsWithPath(path, prefix) {
  return path.length >= prefix.length && prefix.every((value, index) => path[index] === value);
}

function allTables(ast) {
  const rows = [];
  function visit(node) {
    if (node?.type === 'TOMLTable' || node?.type === 'TOMLTopLevelTable') rows.push(node);
    for (const child of node?.body ?? []) visit(child);
  }
  visit(ast);
  return rows;
}

function tableNode(document, path) {
  return document.tables.find(node => node.type === 'TOMLTable' && samePath(node.resolvedKey ?? keySegments(node.key), path));
}

function tableValue(document, path) {
  let current = document.parsed_value;
  for (const segment of path) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function dominantNewline(text) {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return crlf > lf ? '\r\n' : '\n';
}

function addBom(text, hadBom) {
  const content = Buffer.from(text, 'utf8');
  return hadBom ? Buffer.concat([UTF8_BOM_BYTES, content]) : content;
}

function bareOrQuoted(value) {
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

function serializeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (Array.isArray(value) && value.every(item => ['string', 'boolean', 'number'].includes(typeof item)
    && (typeof item !== 'number' || Number.isFinite(item)))) {
    return `[${value.map(serializeValue).join(', ')}]`;
  }
  fail('TOML owned value shape is unsupported');
}

function ownedEntries(ownedValues) {
  if (!ownedValues || Array.isArray(ownedValues) || typeof ownedValues !== 'object') fail('TOML owned values must be an object');
  return Object.entries(ownedValues).map(([key, value]) => {
    if (!/^[A-Za-z0-9_-]+$/.test(key)) fail('TOML owned key is unsafe');
    return [key, value, serializeValue(value)];
  });
}

function validateEdits(edits, textLength) {
  const sorted = [...edits].sort((left, right) => right.offset - left.offset || right.length - left.length);
  let lowerBound = textLength;
  for (const edit of sorted) {
    if (!Number.isSafeInteger(edit.offset) || !Number.isSafeInteger(edit.length)
      || edit.offset < 0 || edit.length < 0 || edit.offset + edit.length > textLength) {
      fail('TOML parser produced an invalid edit range');
    }
    if (edit.offset + edit.length > lowerBound) fail('TOML edits overlap');
    lowerBound = edit.offset;
  }
  return sorted;
}

function applyRangeEdits(text, edits) {
  let output = text;
  for (const edit of validateEdits(edits, text.length)) {
    output = `${output.slice(0, edit.offset)}${edit.content}${output.slice(edit.offset + edit.length)}`;
  }
  return output;
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

function changedResult(document, afterText, edits) {
  const afterBytes = addBom(afterText, document.had_utf8_bom);
  const parsed = parseTomlDocument(afterBytes, {
    pathLabel: document.path_label,
    maxBytes: document.max_bytes,
  });
  return Object.freeze({
    before_bytes: document.bytes,
    after_bytes: afterBytes,
    changed: true,
    parsed_value: parsed.parsed_value,
    edits: Object.freeze(edits.map(edit => Object.freeze({ ...edit }))),
  });
}

function containerPath(node) {
  if (node?.type === 'TOMLTopLevelTable') return [];
  if (node?.type === 'TOMLTable') {
    const path = node.resolvedKey ?? keySegments(node.key);
    return path.every(segment => typeof segment === 'string') ? path : null;
  }
  if (node?.type === 'TOMLInlineTable' && node.parent?.type === 'TOMLKeyValue') return keyValuePath(node.parent);
  return null;
}

function keyValuePath(node) {
  const parent = containerPath(node?.parent);
  const segments = keySegments(node?.key);
  return parent && segments.length > 0 ? [...parent, ...segments] : null;
}

function visitKeyValues(node, visitor) {
  for (const child of node?.body ?? []) {
    if (child.type === 'TOMLTable') {
      visitKeyValues(child, visitor);
      continue;
    }
    if (child.type !== 'TOMLKeyValue') continue;
    const path = keyValuePath(child);
    if (path) visitor(child, path);
    visitTomlValue(child.value, visitor);
  }
}

function visitTomlValue(node, visitor) {
  if (node?.type === 'TOMLInlineTable') visitKeyValues(node, visitor);
  if (node?.type === 'TOMLArray') {
    for (const element of node.elements) visitTomlValue(element, visitor);
  }
}

function tableRepresentation(document, path) {
  const properties = new Map();
  const dotted = [];
  const inlineAncestors = new Map();
  let inline = null;
  visitKeyValues(document.ast.body[0], (node, absolutePath) => {
    if (samePath(absolutePath, path) && node.value.type === 'TOMLInlineTable') inline = node.value;
    if (absolutePath.length === path.length + 1 && startsWithPath(absolutePath, path)) {
      properties.set(absolutePath.at(-1), node);
    }
    const parent = containerPath(node.parent);
    if (absolutePath.length > path.length
      && startsWithPath(absolutePath, path)
      && parent
      && startsWithPath(path, parent)) {
      if (node.parent.type === 'TOMLInlineTable') {
        inlineAncestors.set(`${node.parent.range[0]}:${node.parent.range[1]}`, { node: node.parent, parent });
      } else {
        dotted.push({ node, parent });
      }
    }
  });
  return { properties, dotted, inline, inlineAncestors: [...inlineAncestors.values()] };
}

function dottedInsertionEdit(document, path, candidates, missing) {
  const depth = Math.max(...candidates.map(candidate => candidate.parent.length));
  const candidate = candidates
    .filter(row => row.parent.length === depth)
    .sort((left, right) => right.node.range[1] - left.node.range[1])[0];
  const relativePath = path.slice(candidate.parent.length);
  if (relativePath.length === 0) fail('TOML dotted table insertion path is invalid');
  const lines = missing.map(([key, , serialized]) => `${[...relativePath, key].map(bareOrQuoted).join('.')} = ${serialized}`);
  return {
    offset: physicalLineEnd(document.text, candidate.node.range[1]),
    length: 0,
    content: `${document.newline}${lines.join(document.newline)}`,
  };
}

function inlineInsertionEdit(node, missing, prefix = []) {
  const content = missing
    .map(([key, , serialized]) => `${[...prefix, key].map(bareOrQuoted).join('.')} = ${serialized}`)
    .join(', ');
  if (node.body.length === 0) {
    return { offset: node.range[1] - 1, length: 0, content };
  }
  return { offset: node.body.at(-1).range[1], length: 0, content: `, ${content}` };
}

function appendSeparator(text, eol) {
  if (text.length === 0) return '';
  if (text.endsWith(`${eol}${eol}`)) return '';
  if (text.endsWith(eol)) return eol;
  return `${eol}${eol}`;
}

export function parseTomlDocument(bytes, {
  pathLabel = 'client TOML config',
  maxBytes = 16 * 1024 * 1024,
} = {}) {
  const decoded = decodeConfigBytes(bytes, { pathLabel, maxBytes });
  let ast;
  try {
    ast = parseTOML(decoded.text);
  } catch (error) {
    fail(`${pathLabel} contains malformed TOML`, {
      line: error?.lineNumber ?? null,
      column: error?.column ?? null,
    });
  }
  let parsedValue;
  try {
    parsedValue = getStaticTOMLValue(ast);
  } catch {
    fail(`${pathLabel} could not be evaluated safely`);
  }
  if (!parsedValue || Array.isArray(parsedValue) || typeof parsedValue !== 'object') parsedValue = {};
  return Object.freeze({
    kind: 'toml_document',
    path_label: pathLabel,
    max_bytes: maxBytes,
    bytes,
    text: decoded.text,
    had_utf8_bom: decoded.had_utf8_bom,
    newline: dominantNewline(decoded.text),
    ast,
    tables: Object.freeze(allTables(ast)),
    parsed_value: parsedValue,
  });
}

export function getTomlTable(document, dottedPath) {
  if (document?.kind !== 'toml_document') fail('TOML document is invalid');
  validatePath(dottedPath);
  const value = tableValue(document, dottedPath);
  return value && !Array.isArray(value) && typeof value === 'object' ? value : undefined;
}

function physicalLineEnd(text, offset) {
  const match = /\r\n|\r|\n/.exec(text.slice(offset));
  return match ? offset + match.index : text.length;
}

export function patchTomlTable(document, dottedPath, ownedValues) {
  if (document?.kind !== 'toml_document') fail('TOML document is invalid');
  validatePath(dottedPath);
  const requested = ownedEntries(ownedValues);
  if (requested.length === 0) return noChange(document);
  const node = tableNode(document, dottedPath);
  const currentTable = getTomlTable(document, dottedPath);
  const edits = [];

  if (!node && currentTable === undefined) {
    const lines = [
      `[${dottedPath.map(bareOrQuoted).join('.')}]`,
      ...requested.map(([key, , serialized]) => `${key} = ${serialized}`),
      '',
    ];
    edits.push({
      offset: document.text.length,
      length: 0,
      content: `${appendSeparator(document.text, document.newline)}${lines.join(document.newline)}`,
    });
  } else {
    const representation = tableRepresentation(document, dottedPath);
    const currentValues = currentTable ?? {};
    const missing = [];
    for (const [key, value, serialized] of requested) {
      if (Object.hasOwn(currentValues, key) && isDeepStrictEqual(currentValues[key], value)) continue;
      const currentNode = representation.properties.get(key);
      if (currentNode) {
        edits.push({
          offset: currentNode.value.range[0],
          length: currentNode.value.range[1] - currentNode.value.range[0],
          content: serialized,
        });
      } else {
        missing.push([key, value, serialized]);
      }
    }
    if (missing.length > 0) {
      if (node) {
        const nodeEnd = node.body.length > 0 ? node.body.at(-1).range[1] : node.range[1];
        const offset = physicalLineEnd(document.text, nodeEnd);
        edits.push({
          offset,
          length: 0,
          content: `${document.newline}${missing.map(([key, , serialized]) => `${key} = ${serialized}`).join(document.newline)}`,
        });
      } else if (representation.inline) {
        edits.push(inlineInsertionEdit(representation.inline, missing));
      } else if (representation.inlineAncestors.length > 0) {
        const depth = Math.max(...representation.inlineAncestors.map(candidate => candidate.parent.length));
        const candidate = representation.inlineAncestors.find(row => row.parent.length === depth);
        edits.push(inlineInsertionEdit(candidate.node, missing, dottedPath.slice(candidate.parent.length)));
      } else if (representation.dotted.length > 0) {
        edits.push(dottedInsertionEdit(document, dottedPath, representation.dotted, missing));
      } else {
        fail('TOML table representation cannot be updated safely');
      }
    }
  }

  if (edits.length === 0) return noChange(document);
  const safeEdits = validateEdits(edits, document.text.length);
  return changedResult(document, applyRangeEdits(document.text, safeEdits), safeEdits);
}

export function removeTomlTable(document, dottedPath) {
  if (document?.kind !== 'toml_document') fail('TOML document is invalid');
  validatePath(dottedPath);
  const node = tableNode(document, dottedPath);
  if (!node) return noChange(document);
  const start = node.range[0];
  let end = node.range[1];
  if (document.text.slice(end, end + document.newline.length) === document.newline) end += document.newline.length;
  const edits = [{ offset: start, length: end - start, content: '' }];
  return changedResult(document, applyRangeEdits(document.text, edits), edits);
}
