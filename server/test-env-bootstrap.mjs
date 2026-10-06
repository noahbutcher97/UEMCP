// Startup must prepare env attachment without sending notifications before connect.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUemcpServer } from './create-uemcp-server.mjs';
import { FakeMcpTransport } from './test-mcp-fake-transport.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const t = new TestRunner('Env bootstrap notification lifecycle');
const scratch = createCanonicalScratchRoot('uemcp-env-bootstrap-');
const fixture = fileURLToPath(new URL('./fixtures/uemcp-fixture', import.meta.url));
const missing = join(scratch, 'missing-project');
const cwd = join(scratch, 'empty-workspace');
mkdirSync(cwd);
const notification = 'notifications/tools/list_changed';
const envMode = { UEMCP_PROJECT_ATTACH_MODE: 'env' };
const definitions = [
  { name: 'valid env fixture', env: { ...envMode, UNREAL_PROJECT_ROOT: fixture }, roots: [fixture], before: 'attached', after: 'auto_attached', changes: 0 },
  { name: 'invalid env with fixture fallback', env: { ...envMode, UNREAL_PROJECT_ROOT: missing }, roots: [fixture], before: 'auto_attached', after: 'auto_attached', changes: 0, warning: true },
  { name: 'invalid env without fallback', env: { ...envMode, UNREAL_PROJECT_ROOT: missing }, roots: [], before: 'unresolved', after: 'unresolved', changes: 0, warning: true },
  { name: 'workspace fixture', env: {}, roots: [fixture], before: 'unresolved', after: 'auto_attached', changes: 1 },
];
async function check(name, run) {
  try { await run(); t.assert(true, name); }
  catch (error) { t.assert(false, name, error.stack); }
}
async function createApp(env, roots) {
  return createUemcpServer({
    env, cwd, workspaceRoots: roots, writeProjectCodenames: false,
    tcpCommandFn: async () => ({ status: 'success' }),
    httpCommandFn: async () => ({ Presets: [] }),
    stderr: { write() {} },
  });
}
async function initialize(app, transport) {
  const result = await transport.sendClientRequest('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'env-bootstrap-test', version: '1.0' },
  });
  assert.ok(result.result?.capabilities.tools);
  assert.deepEqual(transport.drainNotifications(notification), [], 'no notification during initialize request');
  const original = app.server.server.oninitialized;
  let resolve, reject;
  const done = new Promise((yes, no) => { resolve = yes; reject = no; });
  // Observe completion of the real handler; do not replace its behavior with a mock.
  app.server.server.oninitialized = async () => {
    try { await original(); resolve(); }
    catch (error) { reject(error); }
  };
  let timer;
  const deadline = new Promise((_, no) => { timer = setTimeout(() => no(new Error('initialization did not settle')), 3000); });
  try {
    await transport.sendClientNotification('notifications/initialized');
    await Promise.race([done, deadline]);
  } finally { clearTimeout(timer); }
}
const names = async transport => (await transport.sendClientRequest('tools/list', {})).result.tools.map(tool => tool.name);
try {
  for (const test of definitions) {
    await check(`bootstrap: ${test.name} prepares silently and exposes correct initialized tools`, async () => {
      const app = await createApp(test.env, test.roots);
      const transport = new FakeMcpTransport();
      try {
        await app.start(transport);
        assert.equal(app.projectContext.snapshot().attachmentState, test.before);
        assert.deepEqual(transport.drainNotifications(notification), [], 'no pre-initialize startup notification');
        await initialize(app, transport);
        assert.equal(transport.drainNotifications(notification).length, test.changes, 'only actual post-connect visibility changes notify');
        const snapshot = app.projectContext.snapshot();
        assert.equal(snapshot.attachmentState, test.after);
        const tools = await names(transport);
        assert.ok(tools.includes('attach_project'));
        assert.equal(tools.includes('project_info'), test.after !== 'unresolved');
        if (test.warning) assert.ok(snapshot.warnings.some(warning => warning.code === 'PROJECT_PATH_INVALID'));
        if (test.after !== 'unresolved') {
          assert.equal(snapshot.identity.projectName, 'UEMCPFixture');
          const info = await transport.sendClientRequest('tools/call', { name: 'project_info', arguments: {} });
          assert.notEqual(info.result?.isError, true);
          assert.equal(JSON.parse(info.result.content[0].text).projectName, 'UEMCPFixture');
          // Connected batching still emits exactly one change for a multi-tool toggle.
          const disabled = await transport.sendClientRequest('tools/call', { name: 'disable_toolset', arguments: { toolsets: ['offline'] } });
          assert.notEqual(disabled.result?.isError, true);
          assert.equal(transport.drainNotifications(notification).length, 1);
          assert.equal((await names(transport)).includes('project_info'), false);
        } else {
          const blocked = await transport.sendClientRequest('tools/call', { name: 'enable_toolset', arguments: { toolsets: ['offline'] } });
          assert.equal(blocked.result.structuredContent.code, 'PROJECT_NOT_ATTACHED');
          assert.deepEqual(transport.drainNotifications(notification), []);
        }
      } finally { await app.server.close(); }
    });
  }
  await check('bootstrap: connected direct notifications retain delivery and transport errors', async () => {
    const app = await createApp({}, []);
    const transport = new FakeMcpTransport();
    try {
      await app.start(transport);
      await initialize(app, transport);
      await app.server.server.sendToolListChanged();
      assert.equal(transport.drainNotifications(notification).length, 1);
      const failure = new Error('owned notification send failure');
      transport.send = async () => { throw failure; };
      await assert.rejects(() => app.server.server.sendToolListChanged(), error => error === failure);
    } finally { await app.server.close(); }
  });
} finally { cleanupCanonicalScratchRoot(scratch, 'uemcp-env-bootstrap-'); }
process.exitCode = t.summary() > 0 ? 1 : 0;
