// Real SDK validation catches closed output schemas that raw tools/call misses.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createUemcpServer } from './create-uemcp-server.mjs';
import { cleanupCanonicalScratchRoot, createCanonicalScratchRoot, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Management Output Official Client Tests');
const prefix = 'uemcp-management-output-';
const scratch = createCanonicalScratchRoot(prefix);
const workspace = join(scratch, 'empty');
const projectRoot = join(scratch, 'fixture');
mkdirSync(workspace);
mkdirSync(projectRoot);
const uproject = join(projectRoot, 'SchemaFixture.uproject');
writeFileSync(uproject, '{"FileVersion":3}\n');
let processes = [];
let probeMode = 'ready';
let inspectorFailure = false;
let lastWaitPayload;
const app = await createUemcpServer({
  env: {}, cwd: workspace, repoRoot: workspace, workspaceRoots: [workspace],
  stderr: { write() {} }, writeProjectCodenames: false,
  processInspector: () => {
    if (inspectorFailure) throw new Error('Synthetic process inspection failure');
    return processes;
  },
  tcpCommandFn: async (_port, type) => {
    if (probeMode === 'initializing' || (probeMode === 'transport_ready' && type === 'get_editor_state')) {
      throw Object.assign(new Error('Synthetic transport unavailable'), { code: 'SOCKET_ERROR' });
    }
    return { status: 'success', result: type === 'get_editor_state' ? {
      uproject_path: probeMode === 'mismatch' ? join(scratch, 'Foreign.uproject') : uproject,
      project_name: 'SchemaFixture', world_path: '/Game/TestMap',
    } : {} };
  },
  httpCommandFn: async () => ({ status: 'success', result: {} }),
});
const client = new Client({ name: 'management-output-regression', version: '1.0.0' });

async function runCase(label, callback) {
  try {
    await callback();
    t.assert(true, label);
  } catch (error) {
    t.assert(false, label, error.stack);
  }
}

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  assert.deepEqual(JSON.parse(result.content[0].text), result.structuredContent);
  assert.equal(client.getToolOutputValidator(name)(result.structuredContent).valid, true);
  return result;
}

async function attachError(args, code, detail) {
  const generation = app.projectContext.generation;
  const result = await call('attach_project', args);
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent.ok, false);
  assert.equal(result.structuredContent.code, code);
  assert.ok(Object.hasOwn(result.structuredContent, detail));
  assert.equal(app.projectContext.generation, generation);
}

try {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await app.start(serverTransport);
  await client.connect(clientTransport);
  // Required: listTools populates the official client's output validators.
  const listed = await client.listTools();
  for (const name of ['attach_project', 'wait_for_editor']) {
    assert.equal(listed.tools.find(tool => tool.name === name).outputSchema.type, 'object');
  }
  await runCase('attach missing source error retains sources', () =>
    attachError({}, 'PROJECT_PATH_INVALID', 'sources'));
  await runCase('attach conflicting sources error retains sources', () =>
    attachError({ project_root: projectRoot, uproject_path: uproject }, 'PROJECT_AMBIGUOUS', 'sources'));
  await runCase('attach missing file error retains path', () =>
    attachError({ uproject_path: join(scratch, 'Missing.uproject') }, 'PROJECT_PATH_INVALID', 'path'));
  await runCase('attach empty root error retains directUprojects', () =>
    attachError({ project_root: workspace }, 'PROJECT_PATH_INVALID', 'directUprojects'));
  await runCase('attach outside-root error retains workspaceRoots', () =>
    attachError({ uproject_path: uproject }, 'PROJECT_OUTSIDE_CLIENT_ROOT', 'workspaceRoots'));
  await runCase('attach unknown target error retains target diagnostics', () =>
    attachError({ target: 'missing' }, 'PROJECT_PATH_INVALID', 'target'));
  await runCase('attach colliding target error retains candidate paths', async () => {
    const otherRoot = join(scratch, 'other');
    mkdirSync(otherRoot);
    const otherProject = join(otherRoot, 'SchemaFixture.uproject');
    writeFileSync(otherProject, '{"FileVersion":3}\n');
    writeFileSync(join(workspace, '.uemcp-targets.txt'), `${uproject}\n${otherProject}\n`);
    await attachError({ target: 'SchemaFixture' }, 'TARGET_ALIAS_AMBIGUOUS', 'collisions');
  });
  await runCase('attach unavailable prompt error retains guidance', () =>
    attachError({ prompt: true }, 'ELICITATION_UNAVAILABLE', 'next'));
  await runCase('attach succeeds with complete project context', async () => {
    const result = await call('attach_project', { uproject_path: uproject, allow_outside_client_roots: true });
    assert.ok(!result.isError);
    assert.equal(result.structuredContent.projectContext.identity.projectName, 'SchemaFixture');
  });
  await runCase('attach blocked mutation error retains count', async () => {
    const token = app.projectContext.beginMutation();
    try {
      await attachError({ uproject_path: uproject }, 'IN_FLIGHT_MUTATION_BLOCKED', 'inFlightMutations');
    } finally {
      app.projectContext.endMutation(token);
    }
  });
  await runCase('disable_toolset retains disabled and wasNotEnabled arrays', async () => {
    const first = await call('disable_toolset', { toolsets: ['offline'] });
    assert.deepEqual(first.structuredContent.disabled, ['offline']);
    const second = await call('disable_toolset', { toolsets: ['offline'] });
    assert.deepEqual(second.structuredContent.wasNotEnabled, ['offline']);
  });
  await runCase('find_tools retains workflow bundle and activation tips', async () => {
    const result = await call('find_tools', { query: 'inspect blueprint graph' });
    assert.equal(result.structuredContent.selectedBundle.name, 'blueprint-static-audit');
    assert.ok(result.structuredContent.directToolsets.includes('offline'));
    assert.ok(result.structuredContent.bundleToolsets.includes('offline'));
    assert.ok(result.structuredContent.tips.length > 0);
  });

  for (const phase of ['no_editor_process', 'wrong_project', 'ready', 'identity_mismatch', 'initializing', 'transport_ready']) {
    await runCase(`wait_for_editor ${phase} preserves diagnostics`, async () => {
      processes = phase === 'no_editor_process' ? [] : [{
        pid: 1234, uprojectPath: phase === 'wrong_project' ? join(scratch, 'Foreign.uproject') : uproject,
      }];
      probeMode = phase === 'identity_mismatch' ? 'mismatch' : phase;
      const result = await call('wait_for_editor', { timeout_ms: 1000 });
      const payload = result.structuredContent;
      lastWaitPayload = payload;
      assert.ok(!result.isError, 'not-ready is a normal result');
      assert.equal(payload.ok, true);
      assert.equal(payload.ready, phase === 'ready');
      assert.equal(payload.phase, phase);
      assert.equal(payload.effective_timeout_ms, 1000);
      assert.ok(payload.elapsed_ms >= 0);
      assert.ok(payload.attempts >= 0);
      assert.equal(typeof payload.hint, 'string');
      if (phase === 'ready') assert.equal(payload.editor.world_path, '/Game/TestMap');
      if (phase === 'identity_mismatch') {
        assert.equal(payload.code, 'EDITOR_PROJECT_MISMATCH');
        assert.equal(payload.mismatch.attached_uproject, uproject.replaceAll('\\', '/'));
      }
      if (['initializing', 'transport_ready'].includes(phase)) {
        assert.equal(payload.last_error.code, 'SOCKET_ERROR');
      }
    });
  }
  await runCase('wait_for_editor unexpected failure remains a protocol error result', async () => {
    inspectorFailure = true;
    try {
      const result = await client.callTool({ name: 'wait_for_editor', arguments: {} });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
      assert.match(result.content[0].text, /Synthetic process inspection failure/);
    } finally {
      inspectorFailure = false;
    }
  });
  await runCase('output validation remains strict', async () => {
    const validator = client.getToolOutputValidator('wait_for_editor');
    assert.equal(validator({ ...lastWaitPayload, ready: 'yes' }).valid, false);
    assert.equal(validator({ ...lastWaitPayload, undeclared: true }).valid, false);
    const attachValidator = client.getToolOutputValidator('attach_project');
    assert.equal(attachValidator({ ok: false, sources: 42 }).valid, false);
    assert.equal(attachValidator({ ok: true, undeclared: true }).valid, false);
  });
} finally {
  await client.close();
  await app.server.close();
  cleanupCanonicalScratchRoot(scratch, prefix);
}

process.exit(t.summary());
