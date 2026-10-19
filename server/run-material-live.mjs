import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BoundedStdioClientTransport } from './deployment/bounded-stdio-transport.mjs';
import { createProcessRunner, terminateProcessTree } from './deployment/process-runner.mjs';
import { runMaterialLifecycle } from './run-material-lifecycle.mjs';
import { prepareOwnedHostRuntime, validateFixtureHost } from './prepare-fixture-host.mjs';
import { listEditorProcesses } from './editor-processes.mjs';
import { assertNoOwnedAuthoringConflicts } from './owned-authoring-conflicts.mjs';
import { exerciseMaterialLiveFlow, hostControl } from './material-live-flow.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}
export function materialLiveEditorArgs({ project, runtime, port, tcpPort, log }) {
  return [project, '-UEMCPMaterialLive', `-UEMCPTcpPort=${tcpPort}`, '-RCWebControlEnable', '-RenderOffscreen', '-nosound', '-unattended', '-nosplash', '-NoLiveCoding',
    ...runtime.args, '-ini:Engine:[HTTPServer.Listeners]:DefaultBindAddress=127.0.0.1',
    `-ini:RemoteControl:[/Script/RemoteControlCommon.RemoteControlSettings]:RemoteControlHttpServerPort=${port},bAutoStartWebSocketServer=False,bAllowAnyRemoteFunctionCall=False`,
    `-abslog=${log}`];
}
export function readMcpJson(response) {
  if (response.isError) throw new Error(response.content?.[0]?.text ?? 'MCP tool rejected call');
  if (response.structuredContent) return response.structuredContent;
  return JSON.parse(response.content?.find(row => row.type === 'text')?.text);
}
export function verifyLiveIdentity(identity, project, pid) {
  if (!identity || identity.pid !== pid || resolve(identity.project ?? '').toLowerCase() !== resolve(project).toLowerCase()) throw new Error('Live editor identity mismatch');
  if (identity.allowAny !== false || identity.pythonEnabled !== false) throw new Error('Live editor permissions mismatch');
}
export function materialMcpEnvelope(name, args, descriptor) {
  if (descriptor?.ok !== true || descriptor.tool !== name || !['call_tool', 'call_mutating_tool'].includes(descriptor.dispatcher)) throw new Error('Invalid MCP tool description');
  return { name: descriptor.dispatcher, arguments: { tool: name, arguments: args } };
}
export async function runMaterialLive({ repoRoot = resolve(import.meta.dirname, '..'), outputRoot, engineRoot }) {
  if (!outputRoot || !engineRoot) throw new Error('Explicit fresh stage and engine required');
  // Reuse the owned build, fixture authoring, native baseline and reload gate.
  await runMaterialLifecycle({ repoRoot, outputRoot, engineRoot });
  const project = join(outputRoot, 'host/UEMCPFixture.uproject');
  const validation = { repoRoot, outputRoot, materialLifecycleAssets: 'required' };
  const assets = ['M_Parameters', 'MI_Parameters'].map(name => join(outputRoot, `host/Content/MaterialVerification/${name}.uasset`));
  const hashes = () => assets.map(path => createHash('sha256').update(readFileSync(path)).digest('hex'));
  const records = [];
  try {
    for (const phase of ['write', 'reload']) {
      await validateFixtureHost(validation);
      assertNoOwnedAuthoringConflicts(listEditorProcesses({ strict: true }), { repoRoot, outputRoot });
      const before = phase === 'reload' ? hashes() : null;
      const runtime = prepareOwnedHostRuntime({ outputRoot, engineRoot });
      const port = await freePort();
      let tcpPort = await freePort();
      while (tcpPort === port) tcpPort = await freePort();
      const args = materialLiveEditorArgs({ project, runtime, port, tcpPort, log: join(outputRoot, `live-${phase}.log`) });
      let exited = false;
      const editorExe = join(engineRoot, 'Engine/Binaries/Win64/UnrealEditor.exe');
      let editorChild;
      const runner = createProcessRunner({ defaultOutputLimitBytes: 16 * 1024 * 1024, spawnImpl: (...args) => {
        const child = spawn(...args);
        if (args[0] === editorExe) editorChild = child;
        return child;
      } });
      const execution = runner.run(editorExe, args,
        { cwd: join(outputRoot, 'host'), env: runtime.env, timeoutMs: 600000 }).then(result => { exited = true; return result; });
      const env = { ...process.env, UNREAL_AUTO_DETECT: 'false', UNREAL_RC_PORT: String(port), UNREAL_TCP_PORT_CUSTOM: String(tcpPort) };
      delete env.UNREAL_PROJECT_ROOT; delete env.UEMCP_PROJECT_ATTACH_MODE;
      const transport = new BoundedStdioClientTransport({ command: process.execPath, args: [join(repoRoot, 'server/server.mjs')], cwd: repoRoot, env });
      let stderr = ''; transport.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-1000000); });
      const client = new Client({ name: 'uemcp-owned-material-verifier', version: '1.0.0' }, { capabilities: {} });
      const transcript = [];
      const descriptions = new Map();
      const call = async (name, args) => {
        let request = { name, arguments: args };
        if (['rc_call_function', 'list_material_parameters', 'set_material_parameter'].includes(name)) {
          if (!descriptions.has(name)) {
            const response = await client.callTool({ name: 'describe_tool', arguments: { tool: name } });
            transcript.push({ name: 'describe_tool', args: { tool: name }, response });
            descriptions.set(name, readMcpJson(response));
          }
          request = materialMcpEnvelope(name, args, descriptions.get(name));
        }
        const response = await client.callTool(request, undefined, { timeout: 15000 });
        transcript.push({ name, args, request, response });
        return readMcpJson(response);
      };
      let owned = false, failure;
      try {
        await client.connect(transport, { timeout: 15000 });
        await call('attach_project', { uproject_path: project });
        let identity, lastStartupError;
        const deadline = Date.now() + 480000;
        while (Date.now() < deadline && !exited) {
          try {
            const readiness = await call('connection_info', { force_reconnect: true });
            if (readiness.projectContext?.transportOwnershipState !== 'verified') throw new Error('Owned transport handshake not ready');
            identity = await hostControl(call, 'identity'); break;
          }
          catch (error) { lastStartupError = error.message; await sleep(500); }
        }
        if (!identity) throw new Error(`Live editor startup timeout: ${lastStartupError ?? 'no identity'}`);
        verifyLiveIdentity(identity, project, editorChild?.pid);
        const editor = listEditorProcesses({ strict: true }).find(row => row.pid === identity.pid);
        if (!editor || resolve(editor.uprojectPath ?? '').toLowerCase() !== resolve(project).toLowerCase()) throw new Error('Live editor process ownership mismatch');
        owned = true;
        await hostControl(call, 'load');
        const evidence = await exerciseMaterialLiveFlow({ call, phase });
        records.push({ ...evidence, identity, port, tcpPort });
      } catch (error) { failure = error; }
      finally {
        if (owned) try { await hostControl(call, 'quit'); } catch (error) { failure ??= error; }
        try { await client.close(); } catch (error) { failure ??= error; }
        try { await transport.close(); } catch (error) { failure ??= error; }
        if (failure && !exited && editorChild) await terminateProcessTree(editorChild);
        // Await bounded process-tree cleanup even when connection or assertions fail.
        const result = await execution;
        writeFileSync(join(outputRoot, `live-${phase}-execution.json`), JSON.stringify({ ...result, args }, null, 2));
        writeFileSync(join(outputRoot, `live-${phase}-mcp.json`), JSON.stringify(transcript, null, 2));
        writeFileSync(join(outputRoot, `live-${phase}-server.log`), stderr);
        if (result.status !== 'exited' || result.exitCode !== 0) failure ??= new Error(`Live editor failed: ${result.status}/${result.exitCode}`);
      }
      if (failure) throw failure;
      await validateFixtureHost(validation);
      if (before && JSON.stringify(before) !== JSON.stringify(hashes())) throw new Error('Live reload changed saved assets');
      records.at(-1).assetHashes = hashes();
    }
    writeFileSync(join(outputRoot, 'live-material-evidence.json'), JSON.stringify({ passed: true, records }, null, 2));
    return records;
  } catch (error) {
    writeFileSync(join(outputRoot, 'live-material-evidence.json'), JSON.stringify({ passed: false, error: error.message, records }, null, 2));
    throw error;
  }
}
