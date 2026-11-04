import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { configureProjectPorts, setIniPort } from './configure-project-ports.mjs';
import { readProjectTransport, iniPort } from './project-transport.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';
const t = new TestRunner('Project port setup');
const prefix = 'uemcp-port-setup-'; const scratch = createCanonicalScratchRoot(prefix);
let seq = 0;
function fixture() {
  const root = join(scratch, String(seq++)); mkdirSync(root);
  const targetsPath = join(root, '.uemcp-targets.json');
  writeFileSync(targetsPath, JSON.stringify({ version: 1, profiles: { curated: [] }, targets: {}, retained: true }));
  const projects = ['A', 'B'].map(name => {
    const projectRoot = join(root, name); mkdirSync(join(projectRoot, 'Config'), { recursive: true });
    const uprojectPath = join(projectRoot, `${name}.uproject`); writeFileSync(uprojectPath, '{}');
    writeFileSync(join(projectRoot, 'Config/DefaultRemoteControl.ini'), '; retain this comment\r\n[Other]\r\nValue=keep\r\n');
    return { uprojectPath, projectRoot };
  });
  return { root, targetsPath, projects };
}
async function check(name, fn) { try { await fn(); t.assert(true, name); } catch (e) { t.assert(false, name, e.stack); } }
try {
  await check('BOM config updates replace the existing key and preserve other sections', () => {
    const result = setIniPort('\uFEFF[UEMCP]\r\nTcpPort=12345\r\n[Other]\r\nValue=keep\r\n', 'UEMCP', 'TcpPort', 12346);
    assert.equal(iniPort(result, 'UEMCP', 'TcpPort'), 12346);
    assert(result.startsWith('\uFEFF')); assert(result.includes('Value=keep'));
  });
  await check('normal setup assigns persistent distinct ports and preserves unrelated config', async () => {
    const f = fixture(); const a = f.projects[0];
    const result = await configureProjectPorts({ uprojectPath: a.uprojectPath, targetsPath: f.targetsPath });
    assert.deepEqual(readProjectTransport(a.projectRoot).ports, result.ports);
    assert.notEqual(result.ports.tcpPortCustom, result.ports.rcPort);
    assert.match(readFileSync(join(a.projectRoot, 'Config/DefaultRemoteControl.ini'), 'utf8'), /Value=keep/);
    const registry = JSON.parse(readFileSync(f.targetsPath)); assert.equal(registry.retained, true); assert.deepEqual(registry.profiles.curated, []);
  });
  await check('repeated setup preserves ports and file bytes', async () => {
    const f = fixture(), a = f.projects[0]; const opts = { uprojectPath: a.uprojectPath, targetsPath: f.targetsPath };
    const first = await configureProjectPorts(opts); const bytes = readFileSync(join(a.projectRoot, 'Config/DefaultRemoteControl.ini'));
    const second = await configureProjectPorts(opts); assert.deepEqual(first.ports, second.ports);
    assert.deepEqual(bytes, readFileSync(join(a.projectRoot, 'Config/DefaultRemoteControl.ini')));
  });
  await check('concurrent setup serializes allocation and retains both registrations', async () => {
    const f = fixture(); const results = await Promise.all(f.projects.map(p => configureProjectPorts({ uprojectPath: p.uprojectPath, targetsPath: f.targetsPath })));
    assert.equal(new Set(results.flatMap(r => Object.values(r.ports))).size, 4);
    assert.equal(Object.keys(JSON.parse(readFileSync(f.targetsPath)).targets).length, 2);
  });
  await check('registration failure rolls back only the setup config changes', async () => {
    const f = fixture(), a = f.projects[0]; const path = join(a.projectRoot, 'Config/DefaultRemoteControl.ini'); const original = readFileSync(path);
    await assert.rejects(configureProjectPorts({ uprojectPath: a.uprojectPath, targetsPath: f.targetsPath }, { register: () => { throw new Error('registration failed'); } }), /registration failed/);
    assert.deepEqual(readFileSync(path), original); assert.equal(existsSync(join(a.projectRoot, 'Config/DefaultUEMCP.ini')), false);
  });
  await check('invalid explicit port pairs are rejected without writes', async () => {
    const f = fixture(), a = f.projects[0];
    await assert.rejects(configureProjectPorts({ uprojectPath: a.uprojectPath, targetsPath: f.targetsPath, tcpPort: 0, httpPort: 0 }), /Invalid explicit transport port pair/);
    assert.equal(existsSync(join(a.projectRoot, 'Config/DefaultUEMCP.ini')), false);
  });
  await check('copied config receives a new pair and explicit managed collisions fail closed', async () => {
    const f = fixture(), [a, b] = f.projects;
    const first = await configureProjectPorts({ uprojectPath: a.uprojectPath, targetsPath: f.targetsPath });
    for (const name of ['DefaultUEMCP.ini', 'DefaultRemoteControl.ini']) writeFileSync(join(b.projectRoot, 'Config', name), readFileSync(join(a.projectRoot, 'Config', name)));
    await assert.rejects(configureProjectPorts({ uprojectPath: b.uprojectPath, targetsPath: f.targetsPath,
      tcpPort: first.ports.tcpPortCustom, httpPort: first.ports.rcPort }), /already assigned/);
    const second = await configureProjectPorts({ uprojectPath: b.uprojectPath, targetsPath: f.targetsPath });
    assert.equal(new Set([...Object.values(first.ports), ...Object.values(second.ports)]).size, 4);
  });
  await check('saved HTTP override follows persistent setup settings', async () => {
    const f = fixture(), a = f.projects[0];
    mkdirSync(join(a.projectRoot, 'Saved/Config/WindowsEditor'), { recursive: true });
    const path = join(a.projectRoot, 'Saved/Config/WindowsEditor/RemoteControl.ini');
    writeFileSync(path, '[/Script/RemoteControlCommon.RemoteControlSettings]\nRemoteControlHttpServerPort=30010\n');
    const result = await configureProjectPorts({ uprojectPath: a.uprojectPath, targetsPath: f.targetsPath });
    assert.deepEqual(readProjectTransport(a.projectRoot).ports, result.ports);
    assert(readFileSync(path, 'utf8').includes(`RemoteControlHttpServerPort=${result.ports.rcPort}`));
  });
  await check('saved config junction escape is rejected and outside bytes are preserved', async () => {
    const f = fixture(), [a, b] = f.projects;
    mkdirSync(join(a.projectRoot, 'Saved/Config'), { recursive: true });
    symlinkSync(join(b.projectRoot, 'Config'), join(a.projectRoot, 'Saved/Config/WindowsEditor'), process.platform === 'win32' ? 'junction' : 'dir');
    const path = join(b.projectRoot, 'Config/RemoteControl.ini');
    writeFileSync(path, '[Other]\nValue=keep\n'); const original = readFileSync(path);
    await assert.rejects(configureProjectPorts({ uprojectPath: a.uprojectPath, targetsPath: f.targetsPath }), /escapes/);
    assert.deepEqual(readFileSync(path), original);
    assert.equal(existsSync(join(a.projectRoot, 'Config/DefaultUEMCP.ini')), false);
  });
} finally { cleanupCanonicalScratchRoot(scratch, prefix); }
process.exit(t.summary());
