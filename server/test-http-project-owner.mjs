import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { ConnectionManager } from './connection-manager.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('HTTP editor ownership');
const project = resolve('owned/A/A.uproject');
async function check(name, run) { try { await run(); t.assert(true, name); } catch (e) { t.assert(false, name, e.stack); } }
function fixture({ httpProject = project, httpPid = 42 } = {}) {
  let operations = 0, probes = 0;
  const remote = { ProjectFile: httpProject, ProcessId: httpPid, TcpPort: 56001 };
  const cm = new ConnectionManager({ tcpPortCustom: 56001, rcPort: 31001,
    tcpCommandFn: async () => ({ status: 'success', result: { uproject_path: project, process_id: 42 } }),
    httpCommandFn: async (_port, _method, _path, body) => {
      if (body?.objectPath === '/Script/UEMCP.Default__UEMCPEditorIdentity') { probes++; return { Identity: { ...remote } }; }
      operations++; return { value: 1 };
    },
  });
  cm.setAttachedProject({ projectRoot: dirname(project), uprojectPath: project });
  return { cm, remote, counts: () => ({ operations, probes }) };
}
await check('cross-wired HTTP project refuses mutation before the operation reaches wire', async () => {
  const f = fixture({ httpProject: resolve('owned/B/B.uproject') });
  await assert.rejects(f.cm.sendHttp('PUT', '/remote/object/call', { functionName: 'Write' }, { skipCache: true }), /owner|identity|mismatch/i);
  assert.equal(f.counts().operations, 0);
});
await check('same project with a different editor PID is refused', async () => {
  const f = fixture({ httpPid: 43 });
  await assert.rejects(f.cm.sendHttp('PUT', '/remote/object/call', {}, { skipCache: true }), /owner|identity|mismatch/i);
  assert.equal(f.counts().operations, 0);
});
await check('matching fresh TCP and HTTP identity permits the operation', async () => {
  const f = fixture(); await f.cm.sendHttp('PUT', '/remote/object/call', {}, { skipCache: true });
  assert.deepEqual(f.counts(), { operations: 1, probes: 1 });
});
await check('cached reads cannot conceal a listener that changed owner', async () => {
  const f = fixture(); await f.cm.sendHttp('GET', '/remote/read'); f.remote.ProcessId = 43;
  await assert.rejects(f.cm.sendHttp('GET', '/remote/read'), /owner|identity|mismatch/i);
  assert.equal(f.counts().operations, 1);
});
await check('reattachment during HTTP identity lookup cancels the operation', async () => {
  const f = fixture(); const original = f.cm._httpCommandFn;
  f.cm._httpCommandFn = async (...args) => {
    const result = await original(...args);
    f.cm.setAttachedProject({ projectRoot: dirname(project), uprojectPath: project });
    return result;
  };
  await assert.rejects(f.cm.sendHttp('PUT', '/remote/object/call', {}, { skipCache: true }), /context changed/);
  assert.equal(f.counts().operations, 0);
});
process.exit(t.summary());
