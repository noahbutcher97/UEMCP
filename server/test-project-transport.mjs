import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionManager } from './connection-manager.mjs';
import { createLiveSmokeConnectionManager, probeEditor } from './live-smoke-harness.mjs';
import { readProjectTransport } from './project-transport.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const t = new TestRunner('Project transport configuration');
const prefix = 'uemcp-ports-';
const root = createCanonicalScratchRoot(prefix);
const defaults = { tcpPortCustom: 55558, rcPort: 30010 };
function project(name, tcp, http) {
  const dir = join(root, name); mkdirSync(join(dir, 'Config'), { recursive: true });
  writeFileSync(join(dir, name + '.uproject'), '{}');
  if (tcp !== undefined) writeFileSync(join(dir, 'Config/DefaultUEMCP.ini'), `[UEMCP]\nTcpPort=${tcp}\n`);
  if (http !== undefined) writeFileSync(join(dir, 'Config/DefaultRemoteControl.ini'), `[/Script/RemoteControlCommon.RemoteControlSettings]\nRemoteControlHttpServerPort=${http}\n`);
  return { projectRoot: dir, uprojectPath: join(dir, name + '.uproject') };
}
async function check(name, run) { try { await run(); t.assert(true, name); } catch (e) { t.assert(false, name, e.stack); } }
try {
  const a = project('A', 56001, 31001), b = project('B', 56002, 31002), legacy = project('Legacy');
  await check('project ports override template environment defaults', () => {
    assert.deepEqual(readProjectTransport(a.projectRoot, defaults).ports, { tcpPortCustom: 56001, rcPort: 31001 });
  });
  await check('legacy projects retain session fallback ports', () => {
    assert.deepEqual(readProjectTransport(legacy.projectRoot, defaults).ports, defaults);
  });
  await check('offline health checks do not cancel an unchanged editor write', async () => {
    let started, finish;
    const ready = new Promise(r => { started = r; });
    const cm = new ConnectionManager({ ...defaults, tcpCommandFn: async () => {
      started(); await new Promise(r => { finish = r; }); return { success: true };
    } });
    cm.setAttachedProject(a);
    const write = cm.send('tcp-55558', 'mutate', {}, { skipCache: true });
    await ready;
    assert.equal(await cm.checkOfflineAvailable(), true);
    finish(); assert.equal((await write).success, true);
  });
  await check('reattachment discards in-flight TCP replies and cancels queued writes', async () => {
    const calls = [];
    let unblock, started;
    const ready = new Promise(r => { started = r; });
    const cm = new ConnectionManager({ ...defaults, tcpCommandFn: async (port, type) => {
      calls.push([port, type]); started(); await new Promise(r => { unblock = r; }); return {};
    } });
    cm.setAttachedProject(a);
    const read = cm.send('tcp-55558', 'read');
    await ready;
    const write = cm.send('tcp-55558', 'mutate', {}, { skipCache: true });
    cm.setAttachedProject(b); unblock();
    await Promise.all([assert.rejects(read, /context changed/), assert.rejects(write, /context changed/)]);
    assert.deepEqual(calls, [[56001, 'read']]);
  });
  await check('live smoke probes the selected project ports and rejects foreign TCP identity', async () => {
    const calls = []; let path = a.uprojectPath;
    const cm = createLiveSmokeConnectionManager(a.projectRoot, {}, { tcpCommandFn: async (port, type) => {
      calls.push(port); return type === 'ping' ? {} : { result: { uproject_path: path } };
    } });
    assert.equal((await probeEditor(cm)).reachable, true);
    path = b.uprojectPath;
    await assert.rejects(probeEditor(cm), /does not match/);
    assert.deepEqual([...new Set(calls)], [56001]); assert.equal(cm.config.rcPort, 31001);
  });
  await check('separate managers and reattachments never inherit another project ports', () => {
    const shared = { ...defaults };
    const x = new ConnectionManager(shared), y = new ConnectionManager(shared);
    x.setAttachedProject(a); y.setAttachedProject(b);
    assert.equal(x.config.rcPort, 31001); assert.equal(y.config.rcPort, 31002);
    x.setAttachedProject(b); assert.equal(x.config.tcpPortCustom, 56002);
    x.setAttachedProject(legacy); assert.equal(x.config.rcPort, 30010);
    x.setAttachedProject(null); assert.equal(x.config.tcpPortCustom, 55558);
    assert.equal(y.config.rcPort, 31002);
    assert.equal(shared.rcPort, 30010);
  });
  await check('malformed project ports block live requests without falling back', async () => {
    const bad = project('Invalid', 'garbage', 31003); let wire = 0;
    const cm = new ConnectionManager({ ...defaults, httpCommandFn: async () => { wire++; return {}; } });
    cm.setAttachedProject(bad);
    await assert.rejects(cm.sendHttp('PUT', '/remote/object/call', {}, { skipCache: true }), /transport.*config|port/i);
    assert.equal(wire, 0);
  });
  await check('duplicate and overlapping configured ports are rejected', () => {
    const same = project('Same', 56003, 56003);
    assert.throws(() => readProjectTransport(same.projectRoot, defaults), /distinct|same|overlap/i);
    writeFileSync(join(same.projectRoot, 'Config/DefaultUEMCP.ini'), '[UEMCP]\nTcpPort=56003\nTcpPort=56004\n');
    assert.throws(() => readProjectTransport(same.projectRoot, defaults), /duplicate/i);
  });
} finally { cleanupCanonicalScratchRoot(root, prefix); }
process.exit(t.summary());
