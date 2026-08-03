// Exact-preservation JSONC and TOML editor tests.
//
// Run: cd server && node test-client-config-formats.mjs

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { TestRunner } from './test-helpers.mjs';
import { decodeConfigBytes } from './deployment/config-bytes.mjs';
import {
  getJsoncValue,
  parseJsoncDocument,
  removeJsoncValue,
  setJsoncValue,
  setJsoncValues,
} from './deployment/jsonc-config.mjs';
import {
  getTomlTable,
  parseTomlDocument,
  patchTomlTable,
  removeTomlTable,
} from './deployment/toml-config.mjs';

const t = new TestRunner('Client Config Format Tests');
const fixtures = join(import.meta.dirname, 'fixtures', 'client-config');

function sampleBytes(name) {
  return readFileSync(join(fixtures, name));
}

function rejectsCode(fn, code) {
  try {
    fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
}

function attempt(fn) {
  try {
    return { result: fn(), error: null };
  } catch (error) {
    return { result: null, error };
  }
}

function text(value) {
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function count(source, needle) {
  return text(source).split(needle).length - 1;
}

// Bounded fatal UTF-8 decoding happens before parsing.
{
  const ascii = Buffer.from('{"ok":true}\n', 'utf8');
  const decoded = decodeConfigBytes(ascii, { pathLabel: 'ascii.json', maxBytes: ascii.length });
  t.assert(decoded.text === '{"ok":true}\n' && decoded.had_utf8_bom === false, 'decode accepts a file exactly at the byte limit');
  t.assert(rejectsCode(() => decodeConfigBytes(ascii, { pathLabel: 'ascii.json', maxBytes: ascii.length - 1 }), 'INSPECTION_LIMIT_EXCEEDED'), 'decode rejects oversize input before parsing');

  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"path":"D:\\\\R\\u00e9sum\\u00e9"}', 'utf8')]);
  const bomDecoded = decodeConfigBytes(bom, { pathLabel: 'bom.json', maxBytes: 1024 });
  t.assert(bomDecoded.had_utf8_bom && bomDecoded.text.startsWith('{'), 'decode strips and reports a UTF-8 BOM');
  t.assert(rejectsCode(() => decodeConfigBytes(Buffer.from([0xff, 0xfe, 0x7b, 0x00]), { pathLabel: 'utf16.json', maxBytes: 1024 }), 'MALFORMED_CONFIG'), 'decode rejects UTF-16 LE');
  t.assert(rejectsCode(() => decodeConfigBytes(Buffer.from([0xfe, 0xff, 0x00, 0x7b]), { pathLabel: 'utf16.json', maxBytes: 1024 }), 'MALFORMED_CONFIG'), 'decode rejects UTF-16 BE');
  t.assert(rejectsCode(() => decodeConfigBytes(Buffer.from([0xc3, 0x28]), { pathLabel: 'invalid.json', maxBytes: 1024 }), 'MALFORMED_CONFIG'), 'decode rejects invalid UTF-8');
  t.assert(rejectsCode(() => decodeConfigBytes(Buffer.from([0xc0, 0xaf]), { pathLabel: 'overlong.json', maxBytes: 1024 }), 'MALFORMED_CONFIG'), 'decode rejects overlong UTF-8');
  t.assert(rejectsCode(() => decodeConfigBytes(Buffer.from('before\0after'), { pathLabel: 'nul.json', maxBytes: 1024 }), 'MALFORMED_CONFIG'), 'decode rejects embedded NUL');
  t.assert(rejectsCode(() => decodeConfigBytes('not-bytes', { pathLabel: 'bad.json', maxBytes: 1024 }), 'MALFORMED_CONFIG'), 'decode requires a byte buffer');
  t.assert(decodeConfigBytes(Buffer.from('{"label":"R\u00e9sum\u00e9"}'), { pathLabel: 'unicode.json', maxBytes: 1024 }).text.includes('R\u00e9sum\u00e9'), 'decode preserves non-ASCII UTF-8 text');
}

// JSONC parsing and range edits preserve unrelated bytes and formatting.
{
  const original = sampleBytes('jsonc-preservation.jsonc');
  const document = parseJsoncDocument(original, { pathLabel: 'user.jsonc' });
  t.assert(getJsoncValue(document, ['mcpServers', 'uemcp', 'command']) === 'old-node.exe', 'JSONC reads a nested value through its parse tree');
  t.assert(getJsoncValue(document, ['missing']) === undefined, 'JSONC returns undefined for a missing path');

  const changed = setJsoncValue(document, ['mcpServers', 'uemcp', 'command'], 'C:\\Program Files\\nodejs\\node.exe');
  t.assert(changed.changed && changed.before_bytes === original, 'JSONC edit reports change and retains original buffer identity');
  t.assert(getJsoncValue(parseJsoncDocument(changed.after_bytes, { pathLabel: 'changed.jsonc' }), ['mcpServers', 'uemcp', 'command']) === 'C:\\Program Files\\nodejs\\node.exe', 'JSONC edit reparses to the requested semantic value');
  t.assert(text(changed.after_bytes).includes('// Keep this comment') && text(changed.after_bytes).includes('secret-canary'), 'JSONC edit preserves comments and unrelated secrets');
  t.assert(count(changed.after_bytes, '"enabled": false') === 1 && count(changed.after_bytes, '"inputs"') === 1, 'JSONC edit preserves client-owned and top-level fields');

  const noChangeDocument = parseJsoncDocument(changed.after_bytes, { pathLabel: 'changed.jsonc' });
  const noChange = setJsoncValue(noChangeDocument, ['mcpServers', 'uemcp', 'command'], 'C:\\Program Files\\nodejs\\node.exe');
  t.assert(!noChange.changed && noChange.after_bytes === changed.after_bytes && noChange.edits.length === 0, 'JSONC deep-equal update returns the original buffer instance');

  const removed = removeJsoncValue(noChangeDocument, ['mcpServers', 'uemcp', 'args']);
  const removedDocument = parseJsoncDocument(removed.after_bytes, { pathLabel: 'removed.jsonc' });
  t.assert(removed.changed && getJsoncValue(removedDocument, ['mcpServers', 'uemcp', 'args']) === undefined, 'JSONC removes only the targeted value');
  t.assert(text(removed.after_bytes).includes('"enabled": false') && text(removed.after_bytes).includes('secret-canary'), 'JSONC removal preserves adjacent and unrelated values');
  const absentRemove = removeJsoncValue(removedDocument, ['mcpServers', 'uemcp', 'absent']);
  t.assert(!absentRemove.changed && absentRemove.after_bytes === removed.after_bytes, 'JSONC missing removal is a byte-identical no-op');

  const empty = parseJsoncDocument(Buffer.alloc(0), { pathLabel: 'empty.jsonc' });
  const created = setJsoncValue(empty, ['mcpServers', 'uemcp'], { command: 'node.exe', args: ['server.mjs'] });
  t.assert(getJsoncValue(parseJsoncDocument(created.after_bytes, { pathLabel: 'created.jsonc' }), ['mcpServers', 'uemcp', 'args', 0]) === 'server.mjs', 'JSONC creates missing parent objects in an empty file');

  const crlfBom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from(text(original).replace(/\n/g, '\r\n'), 'utf8'),
  ]);
  const crlfChanged = setJsoncValue(parseJsoncDocument(crlfBom, { pathLabel: 'crlf.jsonc' }), ['mcpServers', 'uemcp', 'args'], ['new-server.mjs']);
  const crlfText = text(crlfChanged.after_bytes.subarray(3));
  t.assert(crlfChanged.after_bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'JSONC edit preserves UTF-8 BOM bytes');
  t.assert(!/(?<!\r)\n/.test(crlfText), 'JSONC edit preserves dominant CRLF newlines');

  const tabs = sampleBytes('jsonc-tabs.jsonc');
  const tabsChanged = setJsoncValue(parseJsoncDocument(tabs, { pathLabel: 'tabs.jsonc' }), ['servers', 'uemcp'], { type: 'stdio' });
  t.assert(text(tabsChanged.after_bytes).includes('\n\t\t"uemcp"'), 'JSONC insertion preserves tab indentation');

  const boundedJsonc = parseJsoncDocument(Buffer.from('{}'), { pathLabel: 'bounded.jsonc', maxBytes: 32 });
  t.assert(rejectsCode(() => setJsoncValue(boundedJsonc, ['value'], 'x'.repeat(64)), 'INSPECTION_LIMIT_EXCEEDED'), 'JSONC edit cannot grow beyond the configured byte limit');
  t.assert(rejectsCode(() => setJsoncValue(document, ['mcpServers', 'uemcp', 'command'], undefined), 'MALFORMED_CONFIG'), 'JSONC set rejects undefined instead of treating it as removal');
  t.assert(rejectsCode(() => setJsoncValue(document, ['mcpServers', 'uemcp', 'command'], Number.NaN), 'MALFORMED_CONFIG'), 'JSONC set rejects non-finite values');
  t.assert(rejectsCode(() => parseJsoncDocument(Buffer.from('{"a":1,"a":2}'), { pathLabel: 'duplicate.jsonc' }), 'MALFORMED_CONFIG'), 'JSONC rejects duplicate keys');
  t.assert(rejectsCode(() => parseJsoncDocument(Buffer.from('{"a":}'), { pathLabel: 'malformed.jsonc' }), 'MALFORMED_CONFIG'), 'JSONC rejects malformed syntax');
  t.assert(rejectsCode(() => parseJsoncDocument(Buffer.from('{"a":1,}'), {
    pathLabel: 'json-with-comments-no-trailing-comma.json',
    allowTrailingComma: false,
  }), 'MALFORMED_CONFIG'), 'JSONC can enforce a provider subset that rejects trailing commas');
  t.assert(parseJsoncDocument(Buffer.from('{/* comment */"a":1}'), {
    pathLabel: 'json-with-comments.json',
    allowTrailingComma: false,
  }).parsed_value.a === 1, 'provider subset can retain comments while rejecting trailing commas');

  const partialDriftBytes = Buffer.from('{"owned":{"first":"old","last":"same"},"keep":true}\n');
  const partialDrift = setJsoncValues(parseJsoncDocument(partialDriftBytes, { pathLabel: 'partial-drift.jsonc' }), [
    { path: ['owned', 'first'], value: 'new' },
    { path: ['owned', 'last'], value: 'same' },
  ]);
  const partialDriftDocument = parseJsoncDocument(partialDrift.after_bytes, { pathLabel: 'partial-drift-updated.jsonc' });
  t.assert(partialDrift.changed && partialDrift.before_bytes === partialDriftBytes, 'JSONC multi-edit reports cumulative change when a later field is already equal');
  t.assert(getJsoncValue(partialDriftDocument, ['owned', 'first']) === 'new' && getJsoncValue(partialDriftDocument, ['owned', 'last']) === 'same', 'JSONC multi-edit retains earlier edits across later no-op fields');
}

// TOML parsing and AST range edits preserve comments, tables, and client-owned keys.
{
  const original = sampleBytes('toml-preservation.toml');
  const document = parseTomlDocument(original, { pathLabel: 'config.toml' });
  const table = getTomlTable(document, ['mcp_servers', 'uemcp']);
  t.assert(table.command === 'old-node.exe' && table.enabled === false && table.startup_timeout_sec === 30, 'TOML resolves a table through parsed keys');
  t.assert(getTomlTable(document, ['missing']) === undefined, 'TOML returns undefined for a missing table');

  const changed = patchTomlTable(document, ['mcp_servers', 'uemcp'], {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['D:\\DevTools\\UEMCP\\server\\server.mjs'],
  });
  const changedText = text(changed.after_bytes);
  const changedTable = getTomlTable(parseTomlDocument(changed.after_bytes, { pathLabel: 'changed.toml' }), ['mcp_servers', 'uemcp']);
  t.assert(changed.changed && changed.before_bytes === original, 'TOML patch reports change and retains original buffer identity');
  t.assert(changedTable.command === 'C:\\Program Files\\nodejs\\node.exe' && changedTable.args[0].endsWith('server.mjs'), 'TOML patch reparses to requested values');
  t.assert(changedText.includes('# Keep this table comment.') && changedText.includes('enabled = false') && changedText.includes('secret-canary'), 'TOML patch preserves comments, client-owned keys, and unrelated secrets');
  t.assert(changedText.includes('description = """A multiline\nvalue that must survive."""'), 'TOML patch preserves multiline strings byte-for-byte');

  const noChangeDocument = parseTomlDocument(changed.after_bytes, { pathLabel: 'changed.toml' });
  const noChange = patchTomlTable(noChangeDocument, ['mcp_servers', 'uemcp'], {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['D:\\DevTools\\UEMCP\\server\\server.mjs'],
  });
  t.assert(!noChange.changed && noChange.after_bytes === changed.after_bytes && noChange.edits.length === 0, 'TOML deep-equal patch returns the original buffer instance');

  const missingTableSource = Buffer.from('model = "gpt-5"\n', 'utf8');
  const appended = patchTomlTable(parseTomlDocument(missingTableSource, { pathLabel: 'missing.toml' }), ['mcp_servers', 'uemcp'], {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['D:\\DevTools\\UEMCP\\server\\server.mjs'],
  });
  const appendedText = text(appended.after_bytes);
  t.assert(appendedText.includes('\n\n[mcp_servers.uemcp]\n'), 'TOML appends a missing table with one separating blank line');
  t.assert(appendedText.includes('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"'), 'TOML serializes Windows paths deterministically');

  const missingKeySource = Buffer.from('[mcp_servers.uemcp]\ncommand = "node.exe"\n\n[other]\nvalue = true\n');
  const inserted = patchTomlTable(parseTomlDocument(missingKeySource, { pathLabel: 'missing-key.toml' }), ['mcp_servers', 'uemcp'], { args: ['server.mjs'] });
  t.assert(text(inserted.after_bytes).indexOf('args = ["server.mjs"]') < text(inserted.after_bytes).indexOf('[other]'), 'TOML inserts a missing key before the next table');
  const inlineCommentSource = Buffer.from('[mcp_servers.uemcp]\ncommand = "node.exe" # command note\n\n[other]\nvalue = true\n');
  const inlineCommentInserted = patchTomlTable(parseTomlDocument(inlineCommentSource, { pathLabel: 'inline-comment.toml' }), ['mcp_servers', 'uemcp'], { args: ['server.mjs'] });
  const inlineCommentText = text(inlineCommentInserted.after_bytes);
  t.assert(inlineCommentText.includes('command = "node.exe" # command note\nargs = ["server.mjs"]'), 'TOML inserts a missing key after the preceding inline comment');
  t.assert(!inlineCommentText.includes('args = ["server.mjs"] # command note'), 'TOML never reattaches an existing inline comment to a new key');
  const eofCommentSource = Buffer.from('[mcp_servers.uemcp]\ncommand = "node.exe" # eof note');
  const eofCommentInserted = patchTomlTable(parseTomlDocument(eofCommentSource, { pathLabel: 'eof-comment.toml' }), ['mcp_servers', 'uemcp'], { args: ['server.mjs'] });
  t.assert(text(eofCommentInserted.after_bytes).endsWith('command = "node.exe" # eof note\nargs = ["server.mjs"]'), 'TOML preserves an inline comment when the table ends at EOF');

  const dottedSource = Buffer.from([
    'mcp_servers.uemcp.command = "old.exe" # launch note',
    'mcp_servers.uemcp.args = ["old.mjs"]',
    'mcp_servers.uemcp.cwd = "C:\\\\Keep"',
    '',
  ].join('\n'));
  const dottedAttempt = attempt(() => patchTomlTable(parseTomlDocument(dottedSource, { pathLabel: 'dotted-entry.toml' }), ['mcp_servers', 'uemcp'], {
    command: 'node.exe',
    args: ['server.mjs'],
  }));
  t.assert(dottedAttempt.error === null, 'TOML updates an existing dotted-key table without creating a duplicate definition', dottedAttempt.error?.code);
  if (dottedAttempt.result) {
    const dottedText = text(dottedAttempt.result.after_bytes);
    const dottedTable = getTomlTable(parseTomlDocument(dottedAttempt.result.after_bytes), ['mcp_servers', 'uemcp']);
    t.assert(dottedTable.command === 'node.exe' && JSON.stringify(dottedTable.args) === JSON.stringify(['server.mjs']), 'TOML dotted-key updates reparse to the requested owned values');
    t.assert(dottedTable.cwd === 'C:\\Keep' && dottedText.includes('# launch note') && !dottedText.includes('[mcp_servers.uemcp]'), 'TOML dotted-key updates preserve comments, client-owned values, and representation');
    const dottedNoOp = patchTomlTable(parseTomlDocument(dottedAttempt.result.after_bytes), ['mcp_servers', 'uemcp'], { command: 'node.exe', args: ['server.mjs'] });
    t.assert(dottedNoOp.after_bytes === dottedAttempt.result.after_bytes, 'TOML dotted-key deep-equal patch returns the original buffer instance');
  }

  const parentDottedSource = Buffer.from('[mcp_servers]\nuemcp.command = "node.exe" # command note\nuemcp.cwd = "C:\\\\Keep"\n\n[other]\nvalue = true\n');
  const parentDottedAttempt = attempt(() => patchTomlTable(parseTomlDocument(parentDottedSource, { pathLabel: 'parent-dotted-entry.toml' }), ['mcp_servers', 'uemcp'], { args: ['server.mjs'] }));
  t.assert(parentDottedAttempt.error === null, 'TOML inserts a missing owned key into an existing parent-table dotted representation', parentDottedAttempt.error?.code);
  if (parentDottedAttempt.result) {
    const parentDottedText = text(parentDottedAttempt.result.after_bytes);
    t.assert(parentDottedText.includes('uemcp.command = "node.exe" # command note') && parentDottedText.includes('uemcp.args = ["server.mjs"]') && !parentDottedText.includes('[mcp_servers.uemcp]'), 'TOML parent-table dotted insertion uses the existing relative key representation');
    t.assert(parentDottedText.indexOf('uemcp.args = ["server.mjs"]') < parentDottedText.indexOf('[other]'), 'TOML parent-table dotted insertion remains inside its physical table');
  }

  const inlineSource = Buffer.from('mcp_servers.uemcp = { command = "old.exe", cwd = "C:\\\\Keep", enabled = false } # entry note\n');
  const inlineAttempt = attempt(() => patchTomlTable(parseTomlDocument(inlineSource, { pathLabel: 'inline-entry.toml' }), ['mcp_servers', 'uemcp'], {
    command: 'node.exe',
    args: ['server.mjs'],
  }));
  t.assert(inlineAttempt.error === null, 'TOML updates and extends an existing inline table in place', inlineAttempt.error?.code);
  if (inlineAttempt.result) {
    const inlineText = text(inlineAttempt.result.after_bytes);
    const inlineTable = getTomlTable(parseTomlDocument(inlineAttempt.result.after_bytes), ['mcp_servers', 'uemcp']);
    t.assert(inlineTable.command === 'node.exe' && JSON.stringify(inlineTable.args) === JSON.stringify(['server.mjs']), 'TOML inline-table edits reparse to the requested owned values');
    t.assert(inlineTable.cwd === 'C:\\Keep' && inlineTable.enabled === false && inlineText.includes('# entry note') && !inlineText.includes('[mcp_servers.uemcp]'), 'TOML inline-table edits preserve comments, client-owned values, and representation');
    const inlineNoOp = patchTomlTable(parseTomlDocument(inlineAttempt.result.after_bytes), ['mcp_servers', 'uemcp'], { command: 'node.exe', args: ['server.mjs'] });
    t.assert(inlineNoOp.after_bytes === inlineAttempt.result.after_bytes, 'TOML inline-table deep-equal patch returns the original buffer instance');
  }

  const nestedInlineSource = Buffer.from('mcp_servers = { uemcp = { command = "old.exe", args = ["old.mjs"], enabled = true }, keep = "yes" }\n');
  const nestedInlineAttempt = attempt(() => patchTomlTable(parseTomlDocument(nestedInlineSource, { pathLabel: 'nested-inline-entry.toml' }), ['mcp_servers', 'uemcp'], {
    command: 'node.exe',
    args: ['server.mjs'],
  }));
  t.assert(nestedInlineAttempt.error === null, 'TOML locates an existing nested inline table by semantic path', nestedInlineAttempt.error?.code);
  if (nestedInlineAttempt.result) {
    const nestedDocument = parseTomlDocument(nestedInlineAttempt.result.after_bytes);
    const nestedTable = getTomlTable(nestedDocument, ['mcp_servers', 'uemcp']);
    t.assert(nestedTable.command === 'node.exe' && nestedTable.enabled === true && nestedDocument.parsed_value.mcp_servers.keep === 'yes', 'TOML nested inline edit preserves surrounding and client-owned values');
  }

  const inlineDottedSource = Buffer.from('mcp_servers = { uemcp.command = "node.exe", uemcp.enabled = false, keep = "yes" }\n');
  const inlineDottedAttempt = attempt(() => patchTomlTable(parseTomlDocument(inlineDottedSource, { pathLabel: 'inline-dotted-entry.toml' }), ['mcp_servers', 'uemcp'], { args: ['server.mjs'] }));
  t.assert(inlineDottedAttempt.error === null, 'TOML inserts a missing dotted target key inside its ancestor inline table', inlineDottedAttempt.error?.code);
  if (inlineDottedAttempt.result) {
    const inlineDottedDocument = parseTomlDocument(inlineDottedAttempt.result.after_bytes);
    const inlineDottedTable = getTomlTable(inlineDottedDocument, ['mcp_servers', 'uemcp']);
    t.assert(JSON.stringify(inlineDottedTable.args) === JSON.stringify(['server.mjs']) && inlineDottedTable.enabled === false && inlineDottedDocument.parsed_value.mcp_servers.keep === 'yes', 'TOML inline dotted insertion preserves surrounding and client-owned values');
    t.assert(!text(inlineDottedAttempt.result.after_bytes).includes('[mcp_servers.uemcp]'), 'TOML inline dotted insertion preserves the ancestor inline representation');
  }

  const emptyInline = patchTomlTable(parseTomlDocument(Buffer.from('mcp_servers.uemcp = {}\n'), { pathLabel: 'empty-inline-entry.toml' }), ['mcp_servers', 'uemcp'], {
    command: 'node.exe',
    args: ['server.mjs'],
  });
  const emptyInlineTable = getTomlTable(parseTomlDocument(emptyInline.after_bytes), ['mcp_servers', 'uemcp']);
  t.assert(emptyInlineTable.command === 'node.exe' && JSON.stringify(emptyInlineTable.args) === JSON.stringify(['server.mjs']), 'TOML empty inline table accepts missing owned fields in place');

  const removed = removeTomlTable(parseTomlDocument(changed.after_bytes, { pathLabel: 'changed.toml' }), ['mcp_servers', 'uemcp']);
  t.assert(removed.changed && getTomlTable(parseTomlDocument(removed.after_bytes, { pathLabel: 'removed.toml' }), ['mcp_servers', 'uemcp']) === undefined, 'TOML removes the targeted table');
  t.assert(text(removed.after_bytes).includes('[mcp_servers.other]') && text(removed.after_bytes).includes('[profiles."quoted.name"]'), 'TOML removal preserves neighboring tables');
  const absentRemove = removeTomlTable(parseTomlDocument(removed.after_bytes, { pathLabel: 'removed.toml' }), ['mcp_servers', 'absent']);
  t.assert(!absentRemove.changed && absentRemove.after_bytes === removed.after_bytes, 'TOML missing removal is a byte-identical no-op');

  const quoted = parseTomlDocument(sampleBytes('toml-quoted-keys.toml'), { pathLabel: 'quoted.toml' });
  t.assert(getTomlTable(quoted, ['mcp_servers', 'uemcp']).args.length === 1, 'TOML resolves quoted and dotted table keys');
  const tomlCrlfBom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('[mcp_servers.uemcp]\r\ncommand = "node.exe" # command note\r\n', 'utf8'),
  ]);
  const tomlCrlfChanged = patchTomlTable(parseTomlDocument(tomlCrlfBom, { pathLabel: 'crlf.toml' }), ['mcp_servers', 'uemcp'], { args: ['server.mjs'] });
  t.assert(tomlCrlfChanged.after_bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'TOML edit preserves UTF-8 BOM bytes');
  t.assert(!/(?<!\r)\n/.test(text(tomlCrlfChanged.after_bytes.subarray(3))), 'TOML edit preserves dominant CRLF newlines');
  t.assert(text(tomlCrlfChanged.after_bytes).includes('command = "node.exe" # command note\r\nargs = ["server.mjs"]'), 'TOML preserves inline comments with CRLF and a UTF-8 BOM');
  const boundedToml = parseTomlDocument(Buffer.from('model = "x"\n'), { pathLabel: 'bounded.toml', maxBytes: 64 });
  t.assert(rejectsCode(() => patchTomlTable(boundedToml, ['mcp_servers', 'uemcp'], { command: 'x'.repeat(80) }), 'INSPECTION_LIMIT_EXCEEDED'), 'TOML edit cannot grow beyond the configured byte limit');
  t.assert(rejectsCode(() => parseTomlDocument(Buffer.from('[a]\nx=1\n[a]\ny=2\n'), { pathLabel: 'duplicate-table.toml' }), 'MALFORMED_CONFIG'), 'TOML rejects duplicate tables');
  t.assert(rejectsCode(() => parseTomlDocument(Buffer.from('[a]\nx=1\nx=2\n'), { pathLabel: 'duplicate-key.toml' }), 'MALFORMED_CONFIG'), 'TOML rejects duplicate keys');
  t.assert(rejectsCode(() => parseTomlDocument(Buffer.from('[a\nx=1\n'), { pathLabel: 'malformed.toml' }), 'MALFORMED_CONFIG'), 'TOML rejects malformed syntax');
  t.assert(rejectsCode(() => patchTomlTable(document, ['mcp_servers', 'uemcp'], { nested: { unsupported: true } }), 'MALFORMED_CONFIG'), 'TOML rejects unsupported owned value shapes');
}

process.exitCode = t.summary();
