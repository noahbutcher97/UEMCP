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
import { join, resolve } from 'node:path';

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

async function createWireApp({ root, project, tcpCalls, env = {}, tcpCommandFn }) {
  const app = await createUemcpServer({
    env,
    cwd: root,
    workspaceRoots: [],
    processInspector: () => [],
    tcpCommandFn: tcpCommandFn ?? (project ? makeEditor(project, tcpCalls) : undefined),
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

    const compile = (await callTool(transport, 'describe_tool', { tool: 'bp_compile_and_report' })).result.structuredContent;
    t.assert(compile.toolset === 'blueprint-read' && compile.dispatcher === 'call_mutating_tool'
      && compile.annotations.readOnlyHint === false, 'diagnostic compile in blueprint-read is classified as a mutation');
    const found = (await callTool(transport, 'find_tools', { query: 'bp_compile_and_report', max_results: 5 })).result.structuredContent;
    t.assert(found.results.find(row => row.tool === 'bp_compile_and_report')?.dispatcher === 'call_mutating_tool',
      'search exposes the mutation dispatcher beside the diagnostic compile');
    const refused = await dispatch(transport, 'bp_compile_and_report', { asset_path: ANIM_BP });
    t.assert(refused.result.isError && text(refused).includes('WRONG_DISPATCHER'),
      'read dispatcher refuses diagnostic compile even after discovery enables its toolset');

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

await runCase('add_variable advertises and dispatches a tracked Blueprint mutation', async () => {
  const root = makeTempRoot();
  let app;
  try {
    const project = writeProject(join(root, 'VariableCase'), 'VariableCase');
    const tcpCalls = [];
    const wireApp = await createWireApp({ root, project, tcpCalls });
    app = wireApp.app;
    const { transport } = wireApp;
    await attachAndVerify(transport, project);

    const described = (await callTool(transport, 'describe_tool', { tool: 'add_variable' })).result.structuredContent;
    t.assert(described.annotations?.readOnlyHint === false,
      'describe_tool marks add_variable as mutating');
    t.assert(described.dispatcher === 'call_mutating_tool',
      'describe_tool routes add_variable through call_mutating_tool');

    const args = { blueprint_name: 'BP_Variable', variable_name: 'Speed', variable_type: 'Float' };
    const before = tcpCalls.length;
    const refused = await dispatch(transport, 'add_variable', args);
    t.assert(refused.result?.isError === true && text(refused).includes('call_mutating_tool'),
      'call_tool refuses add_variable with mutation dispatcher guidance', text(refused));
    t.assert(tcpCalls.length === before, 'refused add_variable never reaches the editor');

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

    const dispatched = await dispatch(transport, 'add_variable', args, 'call_mutating_tool');
    t.assert(!dispatched.result?.isError, 'call_mutating_tool accepts add_variable', text(dispatched));
    await callTool(transport, 'enable_toolset', { toolsets: ['blueprints-write'] });
    const direct = await callTool(transport, 'add_variable', args);
    t.assert(!direct.result?.isError, 'direct add_variable accepts the same arguments', text(direct));
    t.assert(begun.length === 2 && begun.every(item => item.toolName === 'add_variable'),
      'both direct and dispatched add_variable begin a tracked mutation');
    t.assert(ended.length === 2 && ended.every((id, index) => id === begun[index]?.id),
      'both add_variable mutation scopes close');
    t.assert(tcpCalls.filter(call => call.type === 'add_blueprint_variable').length === 2,
      'only the accepted add_variable calls reach the editor stub');
  } finally {
    await app?.server.close();
    cleanup(root);
  }
});

await runCase('graph action tools share scoped dispatch, retry diagnostics and fresh reads', async () => {
  const root = makeTempRoot();
  let app;
  try {
    const project = writeProject(join(root, 'ActionCase'), 'ActionCase');
    const calls = [];
    const editor = makeEditor(project, calls);
    let discoveredScope;
    let pluginAvailable = true;
    let losePlacementReply = false;
    const actions = [
      { action_id: 'selected', source_asset_path: '/Game/Walk.Walk' },
      { action_id: 'empty', source_asset_path: '' },
    ];
    const placedPlayers = [];
    const wire = await createWireApp({ root, project, tcpCommandFn: async (port, type, params) => {
      const reply = await editor(port, type, params);
      if (type === 'find_graph_actions') {
        if (!pluginAvailable) return { status: 'error', code: 'UNKNOWN_COMMAND', error: 'Unknown command' };
        discoveredScope = params.attachment_id;
        const exact = params.source_asset_path;
        return { status: 'success', result: {
          graph_guid: 'graph-1',
          actions: exact === undefined ? actions : actions.filter(row => row.source_asset_path === exact),
          placed_nodes: placedPlayers.filter(node => node.source_asset_path === exact),
        } };
      }
      if (type === 'place_graph_action' && params.attachment_id !== discoveredScope) {
        return { status: 'error', code: 'STALE_GRAPH_ACTION', error: 'Selection expired', detail: { candidates: ['node-a'] } };
      }
      if (type === 'place_graph_action' && losePlacementReply) {
        losePlacementReply = false;
        placedPlayers.push({ node_guid: `placed-${params.action_id}`,
          source_asset_path: actions.find(row => row.action_id === params.action_id)?.source_asset_path });
        throw new Error('Connection closed without a reply');
      }
      if (type === 'place_graph_action' && params.expected_revision === 'previous') {
        return { status: 'error', code: 'STALE_GRAPH_REVISION', error: 'Refresh the graph', detail: { source_asset_path: '/Game/Walk.Walk' } };
      }
      if (type === 'place_graph_action') {
        const input = params.action_id === 'selected-input';
        return { status: 'success', result: {
          node_class: input ? '/Script/InputBlueprintNodes.K2Node_EnhancedInputAction' : '/Script/AnimGraph.AnimGraphNode_SequencePlayer',
          pins: input ? [{ name: 'Completed', pin_id: 'completed-output' }] : [],
        } };
      }
      return reply;
    } });
    app = wire.app;
    const { transport } = wire;
    const query = { asset_path: ANIM_BP, graph_name: 'AnimGraph', source_asset_path: '/Game/Walk' };
    const place = { asset_path: ANIM_BP, graph_guid: 'graph-1', expected_revision: 'rev', action_id: 'selected', node_position: [10, 20] };
    const unattached = await dispatch(transport, 'find_graph_actions', query);
    t.assert(text(unattached).includes('PROJECT_NOT_ATTACHED'), 'graph discovery requires a project');
    await attachAndVerify(transport, project);
    await callTool(transport, 'enable_toolset', { toolsets: ['blueprint-read', 'blueprints-write'] });
    const beforeRefusals = calls.length;
    const missingGraph = await dispatch(transport, 'find_graph_actions', { asset_path: ANIM_BP });
    const refused = await dispatch(transport, 'place_graph_action', place);
    const badLimit = await dispatch(transport, 'find_graph_actions', { ...query, limit: 101 });
    const shortName = await dispatch(transport, 'place_graph_action', { ...place, asset_path: 'BP_Player' }, 'call_mutating_tool');
    t.assert(text(missingGraph).includes('graph_name or graph_guid'), 'discovery requires an explicit graph selector');
    t.assert(text(refused).includes('WRONG_DISPATCHER'), 'read-only graph catalog cannot place a node');
    t.assert(badLimit.result?.isError === true || !!badLimit.error, 'discovery rejects oversized result limit');
    t.assert(shortName.result?.isError === true || !!shortName.error, 'placement requires the full target asset path');
    t.assert(calls.length === beforeRefusals, 'invalid selectors, limits and read-only edits never reached the editor');
    for (const [name, args, dispatcher] of [
      ['find_graph_actions', query, 'call_tool'], ['place_graph_action', place, 'call_mutating_tool'],
    ]) {
      const described = (await callTool(transport, 'describe_tool', { tool: name })).result.structuredContent;
      t.assert(described.dispatcher === dispatcher, `${name} advertises correct dispatcher`);
      const direct = await callTool(transport, name, args);
      const viaDispatcher = await dispatch(transport, name, args, dispatcher);
      if (name === 'place_graph_action') {
        t.assert(/Started.*Completed.*Canceled/.test(described.description), 'placement help names all three repeating Hold branches');
        t.assert(!Object.hasOwn(JSON.parse(text(direct)).result, 'hold_trigger_wiring'), 'Sequence Player results omit input-event guidance');
      }
      t.assert(direct.result && viaDispatcher.result && !direct.result.isError && !viaDispatcher.result.isError && text(direct) === text(viaDispatcher),
        `${name} has direct and dispatcher result parity`);
      const pair = calls.filter(call => call.type === name);
      t.assert(pair.length === 2 && JSON.stringify(pair[0].params) === JSON.stringify(pair[1].params),
        `${name} always reaches the plugin, with identical scoped payloads`);
      t.assert(typeof discoveredScope === 'string' && discoveredScope.length > 0 && pair.every(call =>
        resolve(call.params.expected_project_file) === resolve(project.uprojectPath) && call.params.attachment_id === discoveredScope),
        `${name} supplies the attached project file and shared MCP session scope`);
    }
    const pawn = '/Game/Pawns/BP_Player';
    await dispatch(transport, 'find_graph_actions', { asset_path: pawn, graph_name: 'EventGraph', source_asset_path: '/Game/Input/IA_Interact' });
    const inputArgs = { ...place, asset_path: pawn, graph_guid: 'pawn-event-graph', action_id: 'selected-input' };
    for (const response of [
      await callTool(transport, 'place_graph_action', inputArgs),
      await dispatch(transport, 'place_graph_action', inputArgs, 'call_mutating_tool'),
    ]) {
      const result = JSON.parse(text(response)).result;
      t.assert(/repeating Hold.*Started \(press\).*both Completed \(release after the hold triggers\) and Canceled \(early release\)/.test(result.hold_trigger_wiring)
        && result.pins[0].pin_id === 'completed-output', 'event placement explains both release pins alongside actual engine pin IDs');
    }
    await dispatch(transport, 'find_graph_actions', { asset_path: ANIM_BP, graph_name: 'AnimGraph', query: 'player' });
    for (const { action_id, source_asset_path } of actions) {
      losePlacementReply = true;
      const writes = calls.filter(call => call.type === 'place_graph_action').length;
      const lost = await dispatch(transport, 'place_graph_action', { ...place, action_id }, 'call_mutating_tool');
      const recovery = lost.result?.structuredContent?.rediscover;
      t.assert(lost.result?.isError && lost.result.structuredContent.code === 'PLACEMENT_OUTCOME_UNCONFIRMED'
        && recovery?.arguments?.source_asset_path === source_asset_path && recovery.instruction.includes('pre-edit node GUIDs'),
        `lost ${action_id} placement returns an executable exact-source read`);
      const inspected = await dispatch(transport, recovery.tool, recovery.arguments);
      t.assert(JSON.parse(text(inspected)).result.placed_nodes.some(node => node.node_guid === `placed-${action_id}`)
        && calls.filter(call => call.type === 'place_graph_action').length === writes + 1,
        `recovery finds the placed ${action_id} player without issuing a second placement`);
    }
    const revision = await dispatch(transport, 'place_graph_action', { ...place, expected_revision: 'previous' }, 'call_mutating_tool');
    t.assert(revision.result?.isError && revision.result.structuredContent?.rediscover?.arguments?.source_asset_path === '/Game/Walk.Walk',
      'an expired revision returns the original exact-source query for inspecting placed_nodes');
    await callTool(transport, 'detach_project');
    await attachAndVerify(transport, project);
    const stale = await dispatch(transport, 'place_graph_action', place, 'call_mutating_tool');
    const failure = stale.result?.structuredContent;
    t.assert(stale.result?.isError && failure?.code === 'STALE_GRAPH_ACTION', 'reattachment changes scope even when attaching the same project');
    t.assert(failure?.detail?.candidates[0] === 'node-a' && !failure.rediscover.arguments
      && failure.rediscover.known_arguments?.graph_guid === place.graph_guid
      && failure.rediscover.required_arguments?.includes('source_asset_path'),
      'expired attachment requires the selected source before providing a runnable read');
    pluginAvailable = false;
    const legacy = await dispatch(transport, 'find_graph_actions', query);
    t.assert(legacy.result?.isError && legacy.result.structuredContent?.code === 'UNKNOWN_COMMAND' && /rebuild.*restart/i.test(text(legacy)),
      'an older plugin gives a sync, rebuild and restart diagnostic');
  } finally {
    await app?.server.close();
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

await runCase('a setter cannot silently discard the requested value or graph', async () => {
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'SetterInputs'), 'SetterInputs');
    const tcpCalls = [];
    const { app, transport } = await createWireApp({ root, project, tcpCalls });
    await attachAndVerify(transport, project);
    await callTool(transport, 'enable_toolset', { toolsets: ['blueprints-write'] });
    const endpoint = 'add_variable_set';
    const fields = { blueprint_name: '/Game/BP_Player', variable_name: 'Interacting' };
    for (const send of [
      args => callTool(transport, endpoint, args),
      args => dispatch(transport, endpoint, args, 'call_mutating_tool'),
    ]) {
      const before = tcpCalls.length;
      const bad = await send({ ...fields, target_graph: 'OtherGraph', value: 'true' });
      t.assert(bad.result?.isError && /graph_name/.test(text(bad)) && /params/.test(text(bad)), 'reject with the correct graph and literal fields');
      t.assert(tcpCalls.length === before, 'invalid setter never reaches the editor');
      const good = await send({ ...fields, graph_name: 'OtherGraph', params: { Interacting: true } });
      t.assert(!good.result?.isError && tcpCalls.at(-1)?.params?.params?.Interacting === true, 'canonical Boolean true reaches the editor');
      await send(fields);
      t.assert(tcpCalls.at(-1)?.params?.variable_name === 'Interacting' && !Object.hasOwn(tcpCalls.at(-1).params, 'params'), 'a setter with an intentionally omitted default still works');
    }
    const assignment = { blueprint_name: '/Game/BP_Player', target_variable: 'Interacting', assignment: { kind: 'literal', value: true } };
    for (const send of [
      args => callTool(transport, 'add_variable_assignment', args),
      args => dispatch(transport, 'add_variable_assignment', args, 'call_mutating_tool'),
    ]) {
      const before = tcpCalls.length;
      const bad = await send({ ...assignment, target_graph: 'OtherGraph' });
      t.assert(bad.result?.isError && /graph_name/.test(text(bad)), 'assignment gives the correct graph argument');
      t.assert(tcpCalls.length === before, 'mistyped assignment graph never reaches the editor');
      await send({ ...assignment, graph_name: 'OtherGraph' });
      t.assert(tcpCalls.at(-1)?.params?.graph_name === 'OtherGraph', 'assignment reaches the exact requested graph');
    }
    await app.server.close();
  } finally { cleanup(root); }
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
