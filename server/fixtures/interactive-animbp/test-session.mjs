// node --experimental-test-module-mocks --test server/fixtures/interactive-animbp/test-session.mjs
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { mock, test } from 'node:test';
import { cleanupCanonicalScratchRoot, createCanonicalScratchRoot } from '../../test-helpers.mjs';

// Run the fixture driver and its real bounded process runner. The two process
// handles are distinct so a termination helper cannot stand in for the editor.
const editorPid = 30123;
let scenario, root, editor, closed, calls;
function spawn(exe, args) {
  if (basename(exe).toLowerCase() === 'taskkill.exe') {
    assert.deepEqual(args, ['/PID', String(editorPid), '/T', '/F']);
    const killer = Object.assign(new EventEmitter(), { pid: editorPid + 1 });
    setImmediate(() => { editor.kill(); killer.emit('close', 0); });
    return killer;
  }
  assert.equal(basename(exe), 'UnrealEditor.exe');
  editor = Object.assign(new EventEmitter(), {
    pid: editorPid, stdout: new EventEmitter(),
    kill() { closed = true; editor.emit('close', 1); },
  });
  if (scenario === 'launch-write') mkdirSync(join(root, 'case-launch.json'));
  if (scenario === 'output-limit') setImmediate(() => editor.stdout.emit('data', Buffer.alloc(16 * 1024 * 1024 + 1)));
  return editor;
}
mock.module('node:child_process', { namedExports: { spawn } });
mock.module('../../prepare-fixture-host.mjs', {
  namedExports: { prepareOwnedHostRuntime: () => ({ runtimeRoot: root, args: [], env: {} }) },
});
mock.module('../../editor-processes.mjs', { namedExports: { listEditorProcesses: () =>
  editor ? [{ pid: editor.pid, uprojectPath: join(root, 'host/UEMCPFixture.uproject') }] : [] } });
mock.module('../../deployment/bounded-stdio-transport.mjs', { namedExports: {
  BoundedStdioClientTransport: class {
    stderr = new EventEmitter();
    async close() {
      calls.push('transport.close');
      if (scenario === 'graceful' && readFileSync(join(root, 'quit-request'), 'utf8') === 'quit') {
        closed = true;
        editor.emit('close', 0);
      }
    }
  },
} });
mock.module('@modelcontextprotocol/sdk/client/index.js', { namedExports: {
  Client: class {
    async connect() { if (scenario === 'output-limit') await new Promise(resolve => editor.once('close', resolve)); }
    async close() { calls.push('client.close'); }
    async callTool({ name }) {
      if (name === 'attach_project') return {};
      if (name === 'connection_info') return { projectContext: { transportOwnershipState: 'verified' } };
      if (name === 'describe_tool') return {};
      assert.equal(name, 'get_editor_state');
      return { process_id: editorPid, uproject_path: join(root, 'host/UEMCPFixture.uproject') };
    }
  },
} });
mock.module('../../run-material-live.mjs', { namedExports: {
  readMcpJson: reply => reply, materialMcpEnvelope: name => ({ name }),
} });

for (const fault of ['launch-write', 'quit-write', 'output-limit', 'graceful']) {
  test(fault, async t => {
    scenario = fault;
    editor = undefined;
    closed = false;
    calls = [];
    root = createCanonicalScratchRoot('uemcp-session-');
    const argv = process.argv, exitCode = process.exitCode;
    t.after(() => {
      editor?.kill();
      process.argv = argv;
      process.exitCode = exitCode;
      cleanupCanonicalScratchRoot(root, 'uemcp-session-');
    });
    mkdirSync(join(root, 'Engine/Build'), { recursive: true });
    writeFileSync(join(root, 'Engine/Build/Build.version'), '{"MajorVersion":5,"MinorVersion":6}');
    writeFileSync(join(root, 'case-editor.log'),
      'Log file open, fixture\nLogLoad: (Engine Initialization) Total time: 1\nLogExit: Exiting.\nLog file closed, fixture');
    // A successful handshake, followed by a deliberate primary fixture error.
    if (fault === 'quit-write' || fault === 'graceful') {
      if (fault === 'quit-write') mkdirSync(join(root, 'quit-request'));
      writeFileSync(join(root, 'case-setup-error.json'), '"fixture stopped"');
    }
    process.argv = [process.execPath, 'run.mjs', root, root, root, 'case'];
    await import('./run.mjs?' + fault);
    assert.equal(process.exitCode, 1);
    assert.equal(closed, true, 'spawned editor was terminated');
    assert.deepEqual(calls, ['client.close', 'transport.close']);
    const read = name => JSON.parse(readFileSync(join(root, 'case-' + name), 'utf8'));
    const results = read('results.json');
    assert.ok(read('editor-diagnostics.json').passed);
    assert.ok(Array.isArray(read('mcp.json')));
    assert.ok(existsSync(join(root, 'case-server.log')));
    if (fault === 'launch-write') {
      assert.match(results.error, /launch\.json/);
      assert.equal(results.status, 'exited');
      assert.equal(existsSync(join(root, 'quit-request')), false);
    } else {
      assert.equal(read('launch.json').pid, editorPid);
      if (fault === 'output-limit') assert.equal(results.status, 'output_limit');
      else {
        assert.match(results.error, /fixture stopped/);
        if (fault === 'quit-write') assert.match(results.quitError, /quit-request/);
        else {
          assert.equal(results.quitError, undefined);
          assert.equal(results.exitCode, 0);
        }
      }
    }
  });
}
