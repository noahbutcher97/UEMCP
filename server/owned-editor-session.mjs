// A normal-setup editor and stdio MCP session, owned by one fixture stage.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BoundedStdioClientTransport } from './deployment/bounded-stdio-transport.mjs';
import { createProcessRunner, terminateProcessTree } from './deployment/process-runner.mjs';
import { prepareOwnedHostRuntime, validateFixtureHost } from './prepare-fixture-host.mjs';
import { listEditorProcesses } from './editor-processes.mjs';
import { canonicalizePath } from './project-identity.mjs';
import { assertNoOwnedAuthoringConflicts } from './owned-authoring-conflicts.mjs';
import { materialLiveEditorArgs, readMcpJson, verifyLiveIdentity } from './run-material-live.mjs';
import { hostControl } from './material-live-flow.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export function normalEditorArgs(options) {
  return materialLiveEditorArgs(options).filter(arg => !arg.startsWith('-UEMCPTcpPort='))
    .map(arg => arg.replace(`RemoteControlHttpServerPort=${options.port},`, ''));
}
export async function openOwnedEditorSession({ repoRoot, outputRoot, engineRoot, ports, label, peers = [] }) {
  const validation = { repoRoot, outputRoot, materialLifecycleAssets: 'required', projectPorts: ports };
  await validateFixtureHost(validation);
  const editors = listEditorProcesses({ strict: true });
  const allowed = new Set();
  for (const peer of peers) {
    await peer.validate();
    if (!peer.matchesProcess(editors.find(row => row.pid === peer.pid))) throw new Error('Owned peer editor identity changed');
    allowed.add(peer.pid);
  }
  assertNoOwnedAuthoringConflicts(editors.filter(row => !allowed.has(row.pid)), { repoRoot, outputRoot });
  const project = join(outputRoot, 'host/UEMCPFixture.uproject');
  const runtime = prepareOwnedHostRuntime({ outputRoot, engineRoot });
  const args = normalEditorArgs({ project, runtime, tcpPort: ports.tcpPortCustom, port: ports.rcPort, log: join(outputRoot, `${label}.log`) });
  const editorExe = join(engineRoot, 'Engine/Binaries/Win64/UnrealEditor.exe');
  let child, exited = false, owned = false, closed;
  const runner = createProcessRunner({ defaultOutputLimitBytes: 16 * 1024 * 1024, spawnImpl: (...params) => {
    const spawned = spawn(...params); if (params[0] === editorExe) child = spawned; return spawned;
  } });
  const env = { ...process.env, UNREAL_AUTO_DETECT: 'false' };
  for (const key of ['UNREAL_PROJECT_ROOT', 'UEMCP_PROJECT_ATTACH_MODE', 'UNREAL_TCP_PORT_CUSTOM', 'UNREAL_RC_PORT']) delete env[key];
  const transport = new BoundedStdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'server/server.mjs')], cwd: join(outputRoot, 'host'), env });
  let stderr = ''; transport.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000000); });
  const client = new Client({ name: `owned-isolation-${label}`, version: '1' }, { capabilities: {} });
  const execution = runner.run(editorExe, args, { cwd: join(outputRoot, 'host'), env: runtime.env, timeoutMs: 1200000 })
    .then(result => { exited = true; return result; });
  const transcript = [];
  const call = async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 15000 });
    transcript.push({ name, args, response }); return readMcpJson(response);
  };
  const activate = async () => {
    const readiness = await call('connection_info', { force_reconnect: true });
    if (readiness.projectContext?.transportOwnershipState !== 'verified') throw new Error('Owned TCP transport not ready');
    if (readiness.transportConfiguration?.source !== 'project' || JSON.stringify(readiness.transportConfiguration.ports) !== JSON.stringify(ports)) throw new Error('Normal setup project ports were not selected');
    const enabled = await call('enable_toolset', { toolsets: ['materials', 'remote-control'] });
    const names = [...enabled.enabled, ...enabled.alreadyEnabled];
    if (!['materials', 'remote-control'].every(name => names.includes(name))) throw new Error('Normal material tool activation failed');
    const listed = await client.listTools();
    if (!['list_material_parameters', 'set_material_parameter', 'rc_call_function'].every(name => listed.tools.some(row => row.name === name))) throw new Error('Direct material tools missing from tools/list');
    return readiness;
  };
  const close = error => {
    if (closed) return closed;
    closed = (async () => {
      let failure = error;
      if (owned && !exited) try { await hostControl(call, 'quit'); } catch (err) { failure ??= err; }
      try { await client.close(); await transport.close(); } catch (err) { failure ??= err; }
      if (!exited && !failure) await Promise.race([execution, sleep(15000)]);
      if (!exited && child) { failure ??= new Error('Owned editor required bounded process-tree cleanup'); await terminateProcessTree(child); }
      const result = await execution;
      writeFileSync(join(outputRoot, `${label}-execution.json`), JSON.stringify({ ...result, args }, null, 2));
      writeFileSync(join(outputRoot, `${label}-mcp.json`), JSON.stringify(transcript, null, 2));
      writeFileSync(join(outputRoot, `${label}-server.log`), stderr);
      if (result.status !== 'exited' || result.exitCode !== 0) failure ??= new Error(`Owned editor exit ${result.status}/${result.exitCode}`);
      if (failure) throw failure;
      return result;
    })(); return closed;
  };
  try {
    await client.connect(transport, { timeout: 15000 });
    let ready = false, lastError;
    const deadline = Date.now() + 480000;
    while (!exited && Date.now() < deadline) {
      try { await activate(); ready = true; break; } catch (err) { lastError = err.message; await sleep(2000); }
    }
    if (!ready) throw new Error(`Owned editor normal startup failed: ${lastError}`);
    const identity = await hostControl(call, 'identity'); verifyLiveIdentity(identity, project, child?.pid); owned = true;
    await hostControl(call, 'load');
    return { call, activate, close, identity, pid: child.pid, project, ports, validate: () => validateFixtureHost(validation),
      matchesProcess: row => !exited && row?.pid === child.pid && row.commandLineAvailable === true && canonicalizePath(row.uprojectPath ?? '') === canonicalizePath(project) };
  } catch (error) { try { await close(error); } catch { /* Original startup error retained in process receipts. */ } throw error; }
}
