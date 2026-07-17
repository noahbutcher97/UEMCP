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

  const removed = removeTomlTable(parseTomlDocument(changed.after_bytes, { pathLabel: 'changed.toml' }), ['mcp_servers', 'uemcp']);
  t.assert(removed.changed && getTomlTable(parseTomlDocument(removed.after_bytes, { pathLabel: 'removed.toml' }), ['mcp_servers', 'uemcp']) === undefined, 'TOML removes the targeted table');
  t.assert(text(removed.after_bytes).includes('[mcp_servers.other]') && text(removed.after_bytes).includes('[profiles."quoted.name"]'), 'TOML removal preserves neighboring tables');
  const absentRemove = removeTomlTable(parseTomlDocument(removed.after_bytes, { pathLabel: 'removed.toml' }), ['mcp_servers', 'absent']);
  t.assert(!absentRemove.changed && absentRemove.after_bytes === removed.after_bytes, 'TOML missing removal is a byte-identical no-op');

  const quoted = parseTomlDocument(sampleBytes('toml-quoted-keys.toml'), { pathLabel: 'quoted.toml' });
  t.assert(getTomlTable(quoted, ['mcp_servers', 'uemcp']).args.length === 1, 'TOML resolves quoted and dotted table keys');
  const tomlCrlfBom = Buffer.concat([
    Buffer.from([0xef, 0xbb, 0xbf]),
    Buffer.from('[mcp_servers.uemcp]\r\ncommand = "node.exe"\r\n', 'utf8'),
  ]);
  const tomlCrlfChanged = patchTomlTable(parseTomlDocument(tomlCrlfBom, { pathLabel: 'crlf.toml' }), ['mcp_servers', 'uemcp'], { args: ['server.mjs'] });
  t.assert(tomlCrlfChanged.after_bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), 'TOML edit preserves UTF-8 BOM bytes');
  t.assert(!/(?<!\r)\n/.test(text(tomlCrlfChanged.after_bytes.subarray(3))), 'TOML edit preserves dominant CRLF newlines');
  const boundedToml = parseTomlDocument(Buffer.from('model = "x"\n'), { pathLabel: 'bounded.toml', maxBytes: 64 });
  t.assert(rejectsCode(() => patchTomlTable(boundedToml, ['mcp_servers', 'uemcp'], { command: 'x'.repeat(80) }), 'INSPECTION_LIMIT_EXCEEDED'), 'TOML edit cannot grow beyond the configured byte limit');
  t.assert(rejectsCode(() => parseTomlDocument(Buffer.from('[a]\nx=1\n[a]\ny=2\n'), { pathLabel: 'duplicate-table.toml' }), 'MALFORMED_CONFIG'), 'TOML rejects duplicate tables');
  t.assert(rejectsCode(() => parseTomlDocument(Buffer.from('[a]\nx=1\nx=2\n'), { pathLabel: 'duplicate-key.toml' }), 'MALFORMED_CONFIG'), 'TOML rejects duplicate keys');
  t.assert(rejectsCode(() => parseTomlDocument(Buffer.from('[a\nx=1\n'), { pathLabel: 'malformed.toml' }), 'MALFORMED_CONFIG'), 'TOML rejects malformed syntax');
  t.assert(rejectsCode(() => patchTomlTable(document, ['mcp_servers', 'uemcp'], { nested: { unsupported: true } }), 'MALFORMED_CONFIG'), 'TOML rejects unsupported owned value shapes');
}

process.exitCode = t.summary();
