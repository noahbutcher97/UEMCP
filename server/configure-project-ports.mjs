import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { createProjectIdentity, canonicalizePath, isInsidePath } from './project-identity.mjs';
import { registerProjectTargetProfile } from './project-targets.mjs';
import { RC_SECTION, TRANSPORT_FILES, readProjectTransport } from './project-transport.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const validPort = port => Number.isInteger(port) && port > 0 && port <= 65535;

export function setIniPort(text, sectionName, keyName, value) {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : '';
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  let section = '', inserted = false, foundSection = false;
  const out = [];
  for (const line of lines) {
    const heading = line.trim().match(/^\[([^\]]+)\]$/);
    if (heading) {
      if (section === sectionName.toLowerCase() && !inserted) { out.push(`${keyName}=${value}`); inserted = true; }
      section = heading[1].toLowerCase();
      if (section === sectionName.toLowerCase()) foundSection = true;
    }
    const entry = line.trim().match(/^([^=;#]+)=(.*)$/);
    if (section === sectionName.toLowerCase() && entry?.[1].trim().toLowerCase() === keyName.toLowerCase()) {
      if (!inserted) { out.push(`${keyName}=${value}`); inserted = true; }
    } else out.push(line);
  }
  if (!inserted) {
    if (!foundSection) out.push(`[${sectionName}]`);
    out.push(`${keyName}=${value}`);
  }
  return bom + out.join(newline).replace(/(?:\r?\n)*$/, newline);
}

function safeFile(path, projectRoot) {
  if (!isInsidePath(canonicalizePath(dirname(path)), canonicalizePath(projectRoot))) throw new Error('Port config directory escapes the selected project');
  if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error('Port config must be an ordinary file');
}
function atomicWrite(path, bytes) {
  const tmp = `${path}.uemcp-ports-${randomUUID()}.tmp`;
  writeFileSync(tmp, bytes, { flag: 'wx' });
  try { renameSync(tmp, path); } catch (error) { unlinkSync(tmp); throw error; }
}

export async function configureProjectPorts({ uprojectPath, targetsPath, tcpPort, httpPort }, { register = registerProjectTargetProfile } = {}) {
  if (!targetsPath) throw new Error('Explicit target registry required');
  const explicit = tcpPort !== undefined || httpPort !== undefined;
  if (explicit && (!validPort(tcpPort) || !validPort(httpPort) || tcpPort === httpPort)) throw new Error('Invalid explicit transport port pair');
  const identity = createProjectIdentity({ uprojectPath });
  const projectRoot = identity.projectRoot;
  targetsPath = resolve(targetsPath);
  mkdirSync(dirname(targetsPath), { recursive: true });
  const lock = targetsPath + '.ports.lock', token = randomUUID();
  let locked = false;
  for (let i = 0; i < 100; i++) {
    try { mkdirSync(lock); locked = true; break; } catch (error) { if (error.code !== 'EEXIST') throw error; await sleep(100); }
  }
  if (!locked) throw new Error('Port allocation lock is busy; no settings changed');
  writeFileSync(join(lock, 'owner.json'), JSON.stringify({ token, pid: process.pid }), { flag: 'wx' });
  const reserved = [], changed = [];
  try {
    const registryBefore = existsSync(targetsPath) ? readFileSync(targetsPath) : null;
    const registry = registryBefore ? JSON.parse(registryBefore) : { targets: {} };
    const claimed = new Set([55558, 30010]), assigned = new Set();
    for (const def of Object.values(registry.targets ?? {})) {
      const path = typeof def === 'string' ? def : def.uproject;
      if (!path || !existsSync(path) || canonicalizePath(path) === identity.canonicalUprojectPath) continue;
      const other = readProjectTransport(dirname(path));
      for (const port of Object.values(other.ports)) { claimed.add(port); assigned.add(port); }
    }
    const previous = readProjectTransport(projectRoot);
    const complete = previous.configured.tcp !== null && previous.configured.http !== null;
    const retain = complete && !assigned.has(previous.ports.tcpPortCustom) && !assigned.has(previous.ports.rcPort);
    let ports = explicit ? { tcpPortCustom: tcpPort, rcPort: httpPort } : retain ? previous.ports : null;
    const reserve = async requested => {
      const server = net.createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(requested ?? 0, '127.0.0.1', resolve); });
      reserved.push(server);
      return server.address().port;
    };
    if (explicit && Object.values(ports).some(port => assigned.has(port))) throw new Error('Explicit transport port is already assigned to another project');
    if (!ports) {
      const choose = async () => {
        for (let i = 0; i < 100; i++) { const port = await reserve(); if (!claimed.has(port)) { claimed.add(port); return port; } }
        throw new Error('No unassigned transport port available');
      };
      ports = { tcpPortCustom: await choose(), rcPort: await choose() };
    } else if (explicit && (!complete || ports.tcpPortCustom !== previous.ports.tcpPortCustom || ports.rcPort !== previous.ports.rcPort)) {
      await reserve(ports.tcpPortCustom); await reserve(ports.rcPort);
    }
    mkdirSync(join(projectRoot, 'Config'), { recursive: true });
    const edits = [
      [join(projectRoot, TRANSPORT_FILES[0]), 'UEMCP', 'TcpPort', ports.tcpPortCustom],
      [join(projectRoot, TRANSPORT_FILES[1]), RC_SECTION, 'RemoteControlHttpServerPort', ports.rcPort],
    ];
    const saved = join(projectRoot, 'Saved/Config/WindowsEditor/RemoteControl.ini');
    if (existsSync(saved)) edits.push([saved, RC_SECTION, 'RemoteControlHttpServerPort', ports.rcPort]);
    for (const [path, section, key, value] of edits) {
      safeFile(path, projectRoot);
      const before = existsSync(path) ? readFileSync(path) : null;
      const after = Buffer.from(setIniPort(before?.toString('utf8') ?? '', section, key, value));
      if (before?.equals(after)) continue;
      atomicWrite(path, after); changed.push({ path, before, after });
    }
    if (registryBefore && !readFileSync(targetsPath).equals(registryBefore)) throw new Error('Target registry changed during port allocation');
    const registration = register({ configPath: targetsPath, uprojectPath: identity.uprojectPath });
    return { status: changed.length ? 'configured' : 'unchanged', ports, projectRoot, alias: registration.alias };
  } catch (error) {
    for (const edit of changed.reverse()) {
      if (!existsSync(edit.path) || !readFileSync(edit.path).equals(edit.after)) throw new AggregateError([error], 'Port setup failed; concurrent config edit preserved');
      if (edit.before) atomicWrite(edit.path, edit.before); else unlinkSync(edit.path);
    }
    throw error;
  } finally {
    await Promise.all(reserved.map(server => new Promise(resolve => server.close(resolve))));
    if (JSON.parse(readFileSync(join(lock, 'owner.json'))).token !== token) throw new Error('Port allocation lock ownership changed; retained');
    unlinkSync(join(lock, 'owner.json')); rmdirSync(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), options = {};
  const keys = { '--project': 'uprojectPath', '--targets': 'targetsPath', '--tcp-port': 'tcpPort', '--http-port': 'httpPort' };
  for (let i = 0; i < args.length; i += 2) {
    if (!keys[args[i]] || !args[i + 1]) throw new Error('Usage: --project FILE --targets FILE [--tcp-port N --http-port N]');
    options[keys[args[i]]] = args[i].endsWith('-port') ? Number(args[i + 1]) : args[i + 1];
  }
  configureProjectPorts(options).then(result => console.log(JSON.stringify(result)), error => { console.error(error.message); process.exitCode = 1; });
}
