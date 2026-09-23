// D202 generic dispatcher: describe_tool / call_tool / call_mutating_tool.
//
// Some MCP clients snapshot tools/list once and never act on
// notifications/tools/list_changed. For them a dynamically enabled tool is
// discoverable through find_tools but never callable. These cases emulate that
// client — tools/list is read exactly once, before attachment — and prove every
// dynamic tool stays callable through the always-visible dispatchers, with the
// same validation, project guard, mutation tracking and executor as the native
// registration.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { z } from 'zod';

import { createUemcpServer } from './create-uemcp-server.mjs';
import { ToolDispatchRegistry } from './tool-dispatch.mjs';
import { FakeMcpTransport } from './test-mcp-fake-transport.mjs';
import { TestRunner } from './test-helpers.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const ANIM_BP = '/Game/Characters/ABP_Dispatch';

const t = new TestRunner('Tool Dispatcher Tests (D202)');

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'uemcp-dispatch-wire-'));
}

function cleanup(dir) {
  const norm = dir.replace(/\\/g, '/');
  const tmp = tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm.startsWith(`${tmp}/uemcp-dispatch-wire-`)) {
    throw new Error(`refusing to clean unexpected scratch path: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function writeProject(root, name) {
  mkdirSync(join(root, 'Content'), { recursive: true });
  const uprojectPath = join(root, `${name}.uproject`);
  writeFileSync(uprojectPath, '{"FileVersion":3}\n', 'utf8');
  return { projectRoot: root, uprojectPath, name };
}

async function runCase(name, fn) {
  console.log(`\n-- ${name} --`);
  try {
    await fn();
  } catch (err) {
    t.assert(false, name, err.stack || err.message);
  }
}

// An editor stub that verifies the attached project and records every command.
function makeEditor(project, tcpCalls) {
  return async (port, type, params) => {
    tcpCalls.push({ type, params });
    if (type === 'get_editor_state') {
      return {
        status: 'success',
        result: {
          project_root: project.projectRoot,
          uproject_path: project.uprojectPath,
          project_name: project.name,
          deploy_marker_present: false,
        },
      };
    }
    return { status: 'success', result: { echoedType: type, graphs: [{ name: 'AnimGraph' }] } };
  };
}

async function createWireApp({ root, project, tcpCalls, env = {} }) {
  const app = await createUemcpServer({
    env,
    cwd: root,
    workspaceRoots: [],
    processInspector: () => [],
    tcpCommandFn: project ? makeEditor(project, tcpCalls) : undefined,
    httpCommandFn: async () => ({ status: 'success', result: {} }),
    // Never register scratch fixtures as codenames in the per-checkout token list.
    writeProjectCodenames: false,
    stderr: { write() {} },
  });
  const transport = new FakeMcpTransport();
  await app.start(transport);
  await transport.sendClientRequest('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'uemcp-snapshot-once-client', version: '1.0.0' },
  });
  return { app, transport };
}

function callTool(transport, name, args = {}) {
  return transport.sendClientRequest('tools/call', { name, arguments: args });
}

function dispatch(transport, tool, args, dispatcher = 'call_tool') {
  return callTool(transport, dispatcher, args === undefined ? { tool } : { tool, arguments: args });
}

function text(response) {
  return response.result?.content?.[0]?.text ?? '';
}

async function attachAndVerify(transport, project) {
  await callTool(transport, 'attach_project', { uproject_path: project.uprojectPath });
  const info = await callTool(transport, 'connection_info', { force_reconnect: true });
  const payload = info.result.structuredContent;
  if (payload.readiness.editorIdentity !== 'verified') {
    throw new Error(`editor identity not verified (got ${payload.readiness.editorIdentity})`);
  }
}

await runCase('snapshot-once client can call get_anim_graph through call_tool', async () => {
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'DispatchCase'), 'DispatchCase');
    const tcpCalls = [];
    const { app, transport } = await createWireApp({ root, project, tcpCalls });

    // The only tools/list this client will ever read.
    const snapshot = (await transport.sendClientRequest('tools/list', {})).result.tools.map(tool => tool.name);
    for (const name of ['describe_tool', 'call_tool', 'call_mutating_tool']) {
      t.assert(snapshot.includes(name), `initial snapshot includes ${name}`);
    }
    t.assert(!snapshot.includes('get_anim_graph'), 'get_anim_graph itself is absent from the snapshot');

    await attachAndVerify(transport, project);
    transport.drainNotifications('notifications/tools/list_changed');

    const response = await dispatch(transport, 'get_anim_graph', { asset_path: ANIM_BP });
    t.assert(!response.result.isError, 'call_tool(get_anim_graph) succeeds', text(response));
    const animCall = tcpCalls.find(call => call.params?.asset_path === ANIM_BP);
    t.assert(!!animCall, 'the editor received the AnimGraph read with the caller asset_path');
    t.assert(JSON.parse(text(response)).result?.graphs?.[0]?.name === 'AnimGraph', 'executor result is returned verbatim', text(response));

    const enabled = app.toolsetManager.getEnabledNames();
    t.assert(!enabled.includes('animation'), 'dispatch does not enable the parent toolset');
    await new Promise(resolve => setImmediate(resolve));
    t.assert(transport.drainNotifications('notifications/tools/list_changed').length === 0,
      'dispatch emits no tools/list_changed');

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('dispatched and native calls return identical results', async () => {
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'ParityCase'), 'ParityCase');
    const { app, transport } = await createWireApp({ root, project, tcpCalls: [] });
    await attachAndVerify(transport, project);
    await callTool(transport, 'enable_toolset', { toolsets: ['animation'] });

    const native = await callTool(transport, 'get_anim_graph', { asset_path: ANIM_BP });
    const viaDispatch = await dispatch(transport, 'get_anim_graph', { asset_path: ANIM_BP });
    t.assert(JSON.stringify(native.result) === JSON.stringify(viaDispatch.result),
      'success result is byte-identical');

    const nativeBad = await callTool(transport, 'get_anim_graph', {});
    const dispatchBad = await dispatch(transport, 'get_anim_graph', {});
    t.assert(nativeBad.result.isError === true && dispatchBad.result.isError === true, 'bad args are an error both ways');
    t.assert(text(nativeBad) === text(dispatchBad),
      'validation error text is identical', `native=${text(nativeBad)} | dispatch=${text(dispatchBad)}`);

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('describe_tool matches the native tools/list entry', async () => {
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'DescribeCase'), 'DescribeCase');
    const { app, transport } = await createWireApp({ root, project, tcpCalls: [] });
    await attachAndVerify(transport, project);

    const described = (await callTool(transport, 'describe_tool', { tool: 'get_anim_graph' })).result.structuredContent;
    await callTool(transport, 'enable_toolset', { toolsets: ['animation'] });
    const listed = (await transport.sendClientRequest('tools/list', {})).result.tools
      .find(tool => tool.name === 'get_anim_graph');

    t.assert(described.ok === true, 'describe_tool ok');
    t.assert(JSON.stringify(described.inputSchema) === JSON.stringify(listed.inputSchema), 'inputSchema identical to tools/list');
    t.assert(described.description === listed.description, 'description identical to tools/list');
    t.assert(JSON.stringify(described.annotations) === JSON.stringify(listed.annotations), 'annotations identical to tools/list');
    t.assert(described.toolset === 'animation', 'reports parent toolset');
    t.assert(described.dispatcher === 'call_tool', 'read tool names call_tool as its dispatcher');

    const mutating = (await callTool(transport, 'describe_tool', { tool: 'create_montage' })).result.structuredContent;
    t.assert(mutating.dispatcher === 'call_mutating_tool', 'mutation tool names call_mutating_tool as its dispatcher');

    const unknown = (await callTool(transport, 'describe_tool', { tool: 'no_such_tool' })).result.structuredContent;
    t.assert(unknown.ok === false && unknown.code === 'TOOL_NOT_FOUND', 'unknown tool is TOOL_NOT_FOUND');

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('each dispatcher runs only its own requirement class', async () => {
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'ClassCase'), 'ClassCase');
    const tcpCalls = [];
    const { app, transport } = await createWireApp({ root, project, tcpCalls });
    await attachAndVerify(transport, project);
    const before = tcpCalls.length;

    const writeViaRead = await dispatch(transport, 'create_montage', { name: 'AM_X', anim_sequence: '/Game/A' });
    t.assert(writeViaRead.result.isError === true, 'call_tool refuses a mutation tool');
    t.assert(text(writeViaRead).includes('call_mutating_tool'), 'refusal names call_mutating_tool');

    const readViaWrite = await dispatch(transport, 'get_anim_graph', { asset_path: ANIM_BP }, 'call_mutating_tool');
    t.assert(readViaWrite.result.isError === true, 'call_mutating_tool refuses a read tool');
    t.assert(text(readViaWrite).includes('call_tool'), 'refusal names call_tool');

    t.assert(tcpCalls.length === before, 'refused dispatches never reach the editor');

    for (const [name, label] of [
      ['attach_project', 'management tool'],
      ['create_gameplay_effect', 'planned tool'],
      ['no_such_tool', 'unknown tool'],
    ]) {
      const response = await dispatch(transport, name, {});
      t.assert(response.result.isError === true && text(response).includes('TOOL_NOT_FOUND'),
        `${label} ${name} is not dispatchable`, text(response));
    }

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('call_mutating_tool tracks the mutation like the native path', async () => {
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'MutateCase'), 'MutateCase');
    const tcpCalls = [];
    const { app, transport } = await createWireApp({ root, project, tcpCalls });
    await attachAndVerify(transport, project);

    const begun = [];
    const ended = [];
    const beginMutation = app.projectContext.beginMutation.bind(app.projectContext);
    const endMutation = app.projectContext.endMutation.bind(app.projectContext);
    app.projectContext.beginMutation = info => {
      const id = beginMutation(info);
      begun.push({ id, toolName: info.toolName });
      return id;
    };
    app.projectContext.endMutation = id => {
      ended.push(id);
      return endMutation(id);
    };

    const response = await dispatch(transport, 'create_montage',
      { name: 'AM_Dispatch', anim_sequence: '/Game/Anim/A_Seq' }, 'call_mutating_tool');
    t.assert(!response.result.isError, 'call_mutating_tool(create_montage) succeeds', text(response));
    t.assert(begun.length === 1 && begun[0].toolName === 'create_montage', 'beginMutation observed once for create_montage');
    t.assert(ended.length === 1 && ended[0] === begun[0].id, 'endMutation closes the same mutation');
    t.assert(tcpCalls.some(call => call.params?.name === 'AM_Dispatch'), 'the editor received the montage write');

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('project guard and python gate survive dispatch', async () => {
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'GuardCase'), 'GuardCase');
    const tcpCalls = [];
    const { app, transport } = await createWireApp({ root, project, tcpCalls });

    const unattached = await dispatch(transport, 'get_anim_graph', { asset_path: ANIM_BP });
    t.assert(text(unattached).includes('PROJECT_NOT_ATTACHED'), 'unattached dispatch returns PROJECT_NOT_ATTACHED', text(unattached));
    t.assert(!tcpCalls.some(call => call.params?.asset_path === ANIM_BP), 'unattached dispatch never reaches the editor');

    await attachAndVerify(transport, project);
    const python = await dispatch(transport, 'run_python_command', { command: 'print(1)' }, 'call_mutating_tool');
    t.assert(text(python).includes('PYTHON_EXEC_DISABLED'), 'run_python_command stays gated without the flag', text(python));
    t.assert(!tcpCalls.some(call => call.params?.command === 'print(1)'), 'gated python never reaches the editor');

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('dispatch never reads the SDK handle callback field', async () => {
  // The SDK has renamed the registered-tool callback field before (callback ->
  // handler). The registry must run its own recorded closure, so a handle that
  // exposes neither field still dispatches.
  const registry = new ToolDispatchRegistry();
  const handle = { inputSchema: z.object({ asset_path: z.string() }), description: 'stub', annotations: { readOnlyHint: true } };
  const calls = [];
  registry.add('stub_read', {
    handle,
    invoke: async (args, extra) => { calls.push({ args, extra }); return { content: [{ type: 'text', text: 'ran' }] }; },
    toolsetName: 'animation',
    requirement: 'live_read',
  });
  const result = await registry.call('call_tool', 'stub_read', { asset_path: '/Game/X' }, { requestId: 7 });
  t.assert(result.content[0].text === 'ran', 'recorded invoke closure ran without handle.handler or handle.callback');
  t.assert(calls.length === 1 && calls[0].args.asset_path === '/Game/X' && calls[0].extra.requestId === 7,
    'parsed args and request extra reach the closure');

  let refused = null;
  try {
    registry.add('no_invoke', { handle, toolsetName: 'animation', requirement: 'live_read' });
  } catch (err) {
    refused = err;
  }
  t.assert(/no invoke closure/.test(refused?.message || ''), 'registry refuses an entry without an invoke closure');
});

process.exit(t.summary());
