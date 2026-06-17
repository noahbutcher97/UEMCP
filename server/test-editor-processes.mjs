// Editor process inspection tests.
//
// Run: cd server && node test-editor-processes.mjs

import { TestRunner } from './test-helpers.mjs';
import { parseEditorProcessLines, listEditorProcesses } from './editor-processes.mjs';

const t = new TestRunner('Editor Process Tests');

const parsed = parseEditorProcessLines('1234|UnrealEditor.exe D:\\Projects\\Foo\\Foo.uproject -skipcompile\n');
t.assert(parsed.length === 1, `one editor process parsed (got ${parsed.length})`);
t.assert(parsed[0].pid === 1234, `pid parsed (got ${parsed[0]?.pid})`);
t.assert(parsed[0].commandLineAvailable === true, 'command line marked available');
t.assert(parsed[0].uprojectPath === 'D:\\Projects\\Foo\\Foo.uproject', `uproject extracted (got ${parsed[0]?.uprojectPath})`);

const fallbackParsed = parseEditorProcessLines('5678|\n');
t.assert(fallbackParsed.length === 1, `fallback process parsed (got ${fallbackParsed.length})`);
t.assert(fallbackParsed[0].commandLineAvailable === false, 'fallback command line unavailable');
t.assert(fallbackParsed[0].uprojectPath === null, 'fallback uproject path is null');

const malformed = parseEditorProcessLines('not-a-pid|\n');
t.assert(malformed.length === 0, `malformed pid ignored (got ${malformed.length})`);

{
  const calls = [];
  const editors = listEditorProcesses({
    spawnSyncImpl(command, args) {
      calls.push({ command, args });
      return {
        status: 0,
        stdout: '4321|UnrealEditor.exe "D:\\Projects\\Bar\\Bar.uproject"\n',
      };
    },
  });
  t.assert(editors.length === 1, `CIM success returns one editor (got ${editors.length})`);
  t.assert(editors[0].uprojectPath === 'D:\\Projects\\Bar\\Bar.uproject', `CIM uproject extracted (got ${editors[0]?.uprojectPath})`);
  t.assert(calls.length === 1, `fallback not called after CIM success (got ${calls.length})`);
}

{
  const calls = [];
  const editors = listEditorProcesses({
    spawnSyncImpl(command, args) {
      calls.push({ command, args });
      if (calls.length === 1) {
        return { status: 1, stdout: '', stderr: 'access denied' };
      }
      return { status: 0, stdout: '8765|\n' };
    },
  });
  t.assert(editors.length === 1, `fallback success returns one editor (got ${editors.length})`);
  t.assert(editors[0].pid === 8765, `fallback pid preserved (got ${editors[0]?.pid})`);
  t.assert(editors[0].commandLineAvailable === false, 'fallback editor has unknown command line');
  t.assert(calls.length === 2, `fallback command was called after CIM failure (got ${calls.length})`);
}

{
  const editors = listEditorProcesses({
    spawnSyncImpl() {
      return { status: 1, stdout: '', stderr: 'denied' };
    },
  });
  t.assert(editors.length === 0, `both probes failing returns empty list (got ${editors.length})`);
}

process.exit(t.summary());
