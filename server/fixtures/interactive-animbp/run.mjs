import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { BoundedStdioClientTransport } from '../../deployment/bounded-stdio-transport.mjs';
import { createProcessRunner, terminateProcessTree } from '../../deployment/process-runner.mjs';
import { readMcpJson, materialMcpEnvelope } from '../../run-material-live.mjs';
import { prepareOwnedHostRuntime } from '../../prepare-fixture-host.mjs';
import { qualifyMontageSlot } from './slot.mjs';
import { classifyEditorEnsures } from './editor-diagnostics.mjs';
import { listEditorProcesses } from '../../editor-processes.mjs';

const [stage, engine, receiptDir, assetLabel, mode] = process.argv.slice(2);
assert.ok(stage && engine && receiptDir && assetLabel && /^[a-zA-Z0-9_]+$/.test(assetLabel),
  'Expected owned stage, engine root, receipt directory and unique asset label');
assert.ok(mode === undefined || ['reload', 'slot', 'slot-reload', 'states', 'states-reload', 'cache', 'cache-reload', 'disconnect', 'disconnect-reload'].includes(mode));
const slotRun = mode === 'slot' || mode === 'slot-reload';
if (slotRun) assert.equal(process.env.UEMCP_SLOT_FIXTURE_PYTHON, '1', 'Slot fixture requires explicit fixture Python opt-in');
const output = resolve(receiptDir);
const family = mode?.split('-')[0];
const reload = mode === 'reload' || mode?.endsWith('-reload') === true;
const label = reload ? assetLabel + '_reload' : assetLabel;
mkdirSync(output, { recursive: true });
const repo = resolve(import.meta.dirname, '../../..');
const project = resolve(stage, 'host/UEMCPFixture.uproject');
const out = (name) => join(output, label + '-' + name);
const save = (name, value) => writeFileSync(out(name), JSON.stringify(value, null, 2));
const records = [];
const phases = [];
const descriptors = new Map();
assert.ok(!existsSync(out('launch.json')), 'Choose a fresh receipt label');
const runtime = prepareOwnedHostRuntime({ outputRoot: stage, engineRoot: engine });
assert.equal(listEditorProcesses({ strict: true }).length, 0);
async function freePort() {
  const s = createServer();
  await new Promise((res, rej) => s.once('error', rej).listen(0, '127.0.0.1', res));
  const port = s.address().port;
  await new Promise((res) => s.close(res));
  return port;
}
const port = await freePort();
let tcpPort;
do {
  tcpPort = await freePort();
} while (tcpPort === port);
const editorArgs = [
  project,
  '/Engine/Maps/Entry',
  '-UEMCPTcpPort=' + tcpPort,
  '-RenderOffscreen',
  '-nosound',
  '-unattended',
  '-nosplash',
  '-NoLiveCoding',
  ...runtime.args,
  '-abslog=' + out('editor.log'),
];

editorArgs.push('-ExecCmds=py ' + join(import.meta.dirname, 'fixture.py').replaceAll('\\', '/'));
const editorExe = join(engine, 'Engine/Binaries/Win64/UnrealEditor.exe');
let child,
  exited = false,
  owned = false,
  failure;
const runner = createProcessRunner({
  defaultOutputLimitBytes: 16 * 1024 * 1024,
  killTree: terminateProcessTree,
  spawnImpl: (...args) => {
    child = spawn(...args);
    return child;
  },
});
const quitFile = resolve(runtime.runtimeRoot, 'quit-request');
const env = {
  ...process.env,
  UNREAL_AUTO_DETECT: 'false',
  UNREAL_RC_PORT: String(port),
  UNREAL_TCP_PORT_CUSTOM: String(tcpPort),
};
delete env.UNREAL_PROJECT_ROOT;
delete env.UEMCP_PROJECT_ATTACH_MODE;
const transport = new BoundedStdioClientTransport({
  command: process.execPath,
  args: [join(repo, 'server/fixtures/stdio-test-server.mjs'), '--enable-python-exec'],
  cwd: repo,
  env,
});
let stderr = '';
transport.stderr.on('data', (c) => {
  stderr = (stderr + c).slice(-200000);
});
const client = new Client({ name: 'uemcp-interactive-blend', version: '1' }, { capabilities: {} });
async function request(wire, name) {
  const row = { name, wire, time: new Date().toISOString(), sent: performance.now() };
  records.push(row);
  try {
    const response = await client.callTool(wire, undefined, { timeout: 15000 });
    row.received = performance.now();
    row.response = response;
    return readMcpJson(response);
  } catch (err) {
    row.error = err.message;
    throw err;
  }
}
async function call(name, args = {}) {
  if (['connection_info', 'attach_project'].includes(name)) return request({ name, arguments: args }, name);
  if (!descriptors.has(name))
    descriptors.set(
      name,
      await request({ name: 'describe_tool', arguments: { tool: name } }, 'describe_tool'),
    );
  const payload = await request(materialMcpEnvelope(name, args, descriptors.get(name)), name);
  if (payload.status === 'error') throw new Error(name + ': ' + JSON.stringify(payload));
  return payload.status === 'success' && Object.hasOwn(payload, 'result') ? payload.result : payload;
}
const execution = runner
  .run(editorExe, editorArgs, {
    cwd: resolve(stage, 'host'),
    env: {
      ...runtime.env,
      UEMCP_OWNED_QUIT_FILE: quitFile,
      U5_PREFIX: join(output, label),
      U5_ASSET_LABEL: assetLabel,
      U5_RELOAD: reload ? '1' : '0',
      U5_SLOT_RUN: slotRun ? '1' : '0',
      U5_FORMAT_ARGUMENT: family === 'disconnect' ? '1' : '0',
    },
    timeoutMs: 1200000,
  })
  .then((r) => {
    exited = true;
    return r;
  });
try {
  assert.ok(child?.pid, 'Failed to launch ' + editorExe);
  save('launch.json', { pid: child.pid, project, port, tcpPort, editorArgs, launchedAt: new Date().toISOString() });
  await client.connect(transport, { timeout: 15000 });
  await call('attach_project', { uproject_path: project });
  let identity, last;
  for (const deadline = Date.now() + 1000000; Date.now() < deadline && !exited; ) {
    try {
      const ready = await call('connection_info', { force_reconnect: true });
      assert.equal(ready.projectContext.transportOwnershipState, 'verified');
      identity = await call('get_editor_state');
      break;
    } catch (err) {
      last = err.message;
      await delay(1200);
    }
  }
  assert.ok(identity, 'No handshake: ' + last);
  assert.equal(identity.process_id, child.pid);
  assert.equal(resolve(identity.uproject_path), project);
  assert.ok(
    listEditorProcesses({ strict: true }).some(
      (p) => p.pid === child.pid && resolve(p.uprojectPath).toLowerCase() === project.toLowerCase(),
    ),
  );
  owned = true;
  const waitFile = async (path) => {
    for (let i = 0; i < 900 && !exited; i++) {
      if (existsSync(out('setup-error.json'))) throw Error(readFileSync(out('setup-error.json'), 'utf8'));
      if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
      await delay(200);
    }
    throw Error('Timed out waiting for ' + path);
  };
  const ready = await waitFile(out('ready.json'));
  const asset = ready.asset;
  const bp = { blueprint_name: asset };
  const graph = { ...bp, graph_name: 'AnimGraph' };
  const read = () =>
    call('get_anim_graph', {
      asset_path: asset,
      include_actions: true,
      include_node_properties: true,
      include_pin_topology: true,
      include_pin_defaults: true,
    });
  async function fixture(op, label) {
    writeFileSync(out('request.tmp'), JSON.stringify({ op, label }));
    renameSync(out('request.tmp'), out('request'));
    return waitFile(out(label + '.json'));
  }
  async function probeValue(expression, label) {
    const command = 'import unreal, json; print("UEMCP_PROBE " + json.dumps(' + expression + '))';
    const reply = await call('run_python_command', { command });
    assert.equal(reply.success, true);
    const line = reply.log_output.find((entry) => entry.output.startsWith('UEMCP_PROBE '));
    assert.ok(line, 'Missing probe result for ' + label);
    const value = JSON.parse(line.output.slice('UEMCP_PROBE '.length));
    save(label + '.json', value);
    return value;
  }
  const history = (op, label) =>
    probeValue('unreal.AnimBlendProbe.history(' + (op === 'redo' ? 'True' : 'False') + ')', label);
  async function verify(label) {
    const state = await read();
    const rows = await fixture('snapshot', label + '-oracle');
    save(label + '-read.json', state);
    assert.equal(state.pin_topology.complete, true);
    assert.equal(rows.length, state.pin_topology.pin_count);
    for (const p of rows) {
      const g = Object.values(state.pin_topology.graphs).find((x) => x.graph_guid === p.graphId);
      const n = g.nodes[p.node];
      const pin = n.pins[p.pin];
      assert.deepEqual(
        [n.class_name, n.x, n.y, pin.name, pin.pin_category, pin.defaults.default_value],
        [p.class, p.x, p.y, p.name, p.category, p.value],
      );
      assert.deepEqual(pin.linked_to.map((e) => e.pin_id).sort(), [...p.links].sort());
    }
    phases.push(label);
    return rows;
  }
  function contentHashes() {
    const root = resolve(stage, 'host/Content');
    return Object.fromEntries(
      readdirSync(root, { recursive: true, withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => {
          const path = join(f.parentPath, f.name);
          return [
            relative(root, path).split(sep).join('/'),
            createHash('sha256').update(readFileSync(path)).digest('hex'),
          ];
        }),
    );
  }
  const initialFiles = contentHashes();
  save('content-before.json', initialFiles);
  const select = (rows, cls, name, test = () => true) => {
    const result = rows.filter((p) => p.class === cls && p.name === name && test(p));
    assert.equal(result.length, 1, cls + ' ' + name);
    return result[0];
  };
  const same = (a, b) =>
    assert.deepEqual(
      [...a].sort((x, y) => x.pin.localeCompare(y.pin)),
      [...b].sort((x, y) => x.pin.localeCompare(y.pin)),
    );
  const changes = (rows, remove, add) =>
    rows.map((p) => ({
      ...p,
      links: [
        ...p.links.filter(
          (id) => !remove.some(([x, y]) => (p.pin === x && id === y) || (p.pin === y && id === x)),
        ),
        ...add.flatMap(([x, y]) => (p.pin === x ? [y] : p.pin === y ? [x] : [])),
      ],
    }));
  async function checkMotion(label, disconnectedAlpha = null) {
    const bpArg = 'unreal.load_asset(' + JSON.stringify(asset) + ')';
    const meshArg = 'unreal.load_asset(' + JSON.stringify(ready.mesh) + ')';
    const rows = await probeValue(
      '[json.loads(unreal.AnimBlendProbe.sample(' + bpArg + ', ' + meshArg + ', a)) for a in (0.0, 0.5, 1.0)]',
      label,
    );
    assert.equal(rows.length, 3);
    const expected = [10, 30, 50];
    for (const [i, p] of rows.entries()) {
      assert.equal(p.drive, i / 2);
      assert.equal(p.alpha, i / 2);
      assert.equal(p.space, 'parent-local');
      assert.ok(p.class.includes(asset + '.ABP_Blend_C'));
      assert.ok(Math.abs(p.y - 3) < 0.01 && Math.abs(p.z - 7) < 0.01);
      assert.equal(p.ticks, 3);
      assert.equal(p.dt, 1 / 30);
      const expectedX = disconnectedAlpha === null ? expected[i] : 10 + disconnectedAlpha * 40;
      assert.ok(Math.abs(p.x - expectedX) < 0.01, JSON.stringify(p));
    }
    if (disconnectedAlpha !== null) {
      assert.ok(Math.max(...rows.map((p) => p.x)) - Math.min(...rows.map((p) => p.x)) < 0.01);
      assert.ok(rows.some((p, i) => Math.abs(p.x - expected[i]) > 1));
    }
  }
  const compile = async () => {
    const result = await call('compile_blueprint', bp);
    assert.equal(result.compiled_ok, true, JSON.stringify(result));
    assert.equal(result.num_errors, 0);
  };
  const initialDirty = await fixture('dirty', 'dirty-before');
  assert.ok(!initialDirty.some((p) => p.startsWith('/Game/InteractiveBlend/')));
  const base = await verify('baseline');
  if (['states', 'cache', 'disconnect'].includes(family)) {
    const getSaved = (name) => JSON.parse(readFileSync(join(output, assetLabel + '-' + name + '.json')));
    if (reload) same(base, getSaved(family + '-saved-oracle'));
    const suites = {
      states: async () => (await import('./states.mjs')).qualifyStates,
      cache: async () => (await import('./cache.mjs')).qualifyCachedPose,
      disconnect: async () => (await import('./disconnect.mjs')).qualifyDisconnect,
    };
    const qualify = await suites[family]();
    await qualify({ asset, mesh: ready.mesh, reload, call, read, verify, select, fixture, history, same, compile, probeValue, contentHashes, getSaved });
  } else if (reload) {
    same(base, JSON.parse(readFileSync(join(output, assetLabel + (slotRun ? '-slot-saved-oracle.json' : '-persisted-oracle.json')))));
    await checkMotion('reloaded-motion');
    assert.deepEqual(
      await fixture('members', 'reloaded-members'),
      JSON.parse(readFileSync(join(output, assetLabel + '-LeanAlpha-added.json'))),
    );
  } else {
    for (const name of ['Drive', 'LeanAlpha']) {
      const before = await fixture('members', name + '-before');
      await call('add_variable', { ...bp, variable_name: name, variable_type: 'Float' });
      const added = await fixture('members', name + '-added');
      assert.equal(added.length, before.length + 1);
      assert.equal(added.at(-1).name, name);
      assert.equal(await history('undo', name + '-undo'), true);
      assert.deepEqual(await fixture('members', name + '-restored'), before);
      assert.equal(await history('redo', name + '-redo'), true);
      assert.deepEqual(await fixture('members', name + '-reapplied'), added);
    }
    const beforeEvent = await verify('before-event');
    const event = await call('add_event_node', {
      ...bp,
      event_name: 'BlueprintUpdateAnimation',
      graph_name: 'EventGraph',
    });
    const eventState = await verify('before-group');
    assert.equal(await history('undo', 'undo-event'), true);
    same(await verify('event-undone'), beforeEvent);
    assert.equal(await history('redo', 'redo-event'), true);
    same(await verify('event-redone'), eventState);
    await assert.rejects(
      call('add_variable_assignment', {
        ...bp,
        target_variable: 'LeanAlpha',
        assignment: { kind: 'variable', source_variable: 'Drive' },
        exec_from: { node_id: event.node_id, pin: 'DeltaTimeX' },
        compile: false,
      }),
      /not compatible with Exec/i,
    );
    same(await verify('failed-group'), eventState);
    const assignment = await call('add_variable_assignment', {
      ...bp,
      target_variable: 'LeanAlpha',
      assignment: { kind: 'variable', source_variable: 'Drive' },
      exec_from: { node_id: event.node_id, pin: 'then' },
      compile: false,
    });
    assert.equal(assignment.compiled, false);
    const assigned = await verify('assigned');
    assert.equal(await history('undo', 'undo-assignment'), true);
    same(await verify('assignment-undone'), eventState);
    assert.equal(await history('redo', 'redo-assignment'), true);
    same(await verify('assignment-redone'), assigned);
    const setValue = select(assigned, 'K2Node_VariableSet', 'LeanAlpha');
    const drive = select(assigned, 'K2Node_VariableGet', 'Drive');
    const k2Link = {
      ...bp,
      source_node_id: drive.node,
      source_pin: drive.name,
      target_node_id: setValue.node,
      target_pin: setValue.name,
    };
    await call('disconnect_pin', {
      ...bp,
      node_id: setValue.node,
      pin: setValue.name,
      direction: 'input',
      target_node_id: drive.node,
      target_pin: drive.name,
    });
    assert.equal((await call('connect_nodes', k2Link)).changed, true);
    assert.equal((await call('connect_nodes', k2Link)).changed, false);
    same(await verify('k2-control'), assigned);
    await call('add_variable_get', { ...graph, variable_name: 'LeanAlpha' });
    const getterState = await verify('getter');
    assert.equal(await history('undo', 'undo-getter'), true);
    same(await verify('getter-undone'), assigned);
    assert.equal(await history('redo', 'redo-getter'), true);
    same(await verify('getter-redone'), getterState);
    await compile();
    const before = await verify('event');
    const descriptor = (await read()).graphs.find((g) => g.name === 'AnimGraph');
    assert.equal(descriptor.actions.length, 1);
    const node = await call('place_anim_graph_node', {
      asset_path: asset,
      graph_guid: descriptor.graph_guid,
      action: descriptor.actions[0],
      alpha: 0.25,
      node_position: [-280, 0],
    });
    assert.equal(node.compiled, false);
    assert.equal(Number(node.pins.find((p) => p.name === 'Alpha').default), 0.25);
    let placed = await verify('placed');
    assert.equal(await history('undo', 'undo-place'), true);
    same(await verify('before-place'), before);
    assert.equal(await history('redo', 'redo-place'), true);
    same(await verify('redo-placed'), placed);
    const oldAlpha = select(placed, 'AnimGraphNode_TwoWayBlend', 'Alpha');
    assert.equal(await fixture('reconstruct', 'reconstructed-alpha'), true);
    placed = await verify('reconstructed');
    const blend = (name) => select(placed, 'AnimGraphNode_TwoWayBlend', name, (p) => p.node === node.node_id);
    const seq = (suffix) =>
      select(placed, 'AnimGraphNode_SequencePlayer', 'Pose', (p) => p.sequence.endsWith(suffix));
    const a = seq('.PoseA'),
      b = seq('.PoseB'),
      root = select(placed, 'AnimGraphNode_Root', 'Result');
    const getter = select(placed, 'K2Node_VariableGet', 'LeanAlpha', (p) => p.graph === 'AnimGraph');
    const args = (s, t) => ({
      ...graph,
      source_node_id: s.node,
      source_pin: s.name,
      source_pin_id: s.pin,
      target_node_id: t.node,
      target_pin: t.name,
      target_pin_id: t.pin,
    });
    const connect = (s, t, extra = {}) => call('connect_nodes', { ...args(s, t), ...extra });
    assert.notEqual(blend('Alpha').pin, oldAlpha.pin);
    await assert.rejects(connect(getter, oldAlpha), /current source and target pin IDs/i);
    await assert.rejects(connect(getter, root), /not compatible|incompatible/i);
    await assert.rejects(connect(blend('Pose'), root), /explicit approval/i);
    same(await verify('refused'), placed);
    const revision = async () =>
      Object.values((await read()).pin_topology.graphs).find((g) => g.name === 'AnimGraph').topology_revision;
    const approve = { expected_revision: await revision(), replace_source_pin_id: a.pin };
    await assert.rejects(
      connect(blend('Pose'), root, { ...approve, expected_revision: 'stale' }),
      /current graph topology revision/i,
    );
    await assert.rejects(
      connect(blend('Pose'), root, { ...approve, replace_source_pin_id: b.pin }),
      /named edge is no longer current/i,
    );
    const replaced = await connect(blend('Pose'), root, approve);
    assert.equal(replaced.removed_source_pin_id, a.pin);
    const intended = changes(placed, [[a.pin, root.pin]], [[blend('Pose').pin, root.pin]]);
    same(await verify('replaced'), intended);
    assert.equal(await history('undo', 'undo-replacement'), true);
    same(await verify('restored'), placed);
    assert.equal(await history('redo', 'redo-replacement'), true);
    same(await verify('reapplied'), intended);
    await connect(a, blend('A'));
    await connect(b, blend('B'));
    const alphaLink = await connect(getter, blend('Alpha'));
    assert.equal(Number(alphaLink.previous_target_pin.default), 0.25);
    // Different engine versions preserve or reset the default when a data link is made.
    // The independent graph snapshot below checks the effective value the writer returned.
    await compile();
    const wired = await verify('wired');
    const expectedWired = changes(
      intended,
      [],
      [
        [a.pin, blend('A').pin],
        [b.pin, blend('B').pin],
        [getter.pin, blend('Alpha').pin],
      ],
    );
    expectedWired.find((p) => p.pin === blend('Alpha').pin).value = alphaLink.target_pin.default;
    same(wired, expectedWired);
    await checkMotion('motion');
    const disconnect = {
      ...graph,
      expected_revision: await revision(),
      pin_id: blend('Alpha').pin,
      target_pin_id: getter.pin,
      node_id: node.node_id,
      pin: 'Alpha',
      direction: 'input',
      target_node_id: getter.node,
      target_pin: getter.name,
      compile: false,
    };
    await assert.rejects(call('disconnect_pin', { ...disconnect, expected_revision: 'stale' }), /current graph topology revision/i);
    await assert.rejects(call('disconnect_pin', { ...disconnect, pin_id: getter.pin }), /current pin IDs/i);
    same(await verify('stale-disconnect-refused'), wired);
    await call('disconnect_pin', disconnect);
    const disconnected = await verify('alpha-disconnected');
    assert.equal(await history('undo', 'undo-disconnect'), true);
    same(await verify('disconnect-undone'), wired);
    assert.equal(await history('redo', 'redo-disconnect'), true);
    same(await verify('disconnect-redone'), disconnected);
    await compile();
    await checkMotion('negative', Number(select(disconnected, 'AnimGraphNode_TwoWayBlend', 'Alpha').value));
    await connect(getter, blend('Alpha'));
    await compile();
    const fault = await fixture('compile-error', 'fault-id');
    assert.ok(fault);
    const broken = await verify('before-compile-error');
    const failedCompile = await call('compile_blueprint', bp);
    assert.equal(failedCompile.compiled_ok, false);
    assert.ok(
      failedCompile.num_errors > 0 &&
        JSON.stringify(failedCompile.errors).includes('UEMCPMissingFixtureFunction'),
    );
    same(await verify('after-compile-error'), broken);
    await call('delete_nodes', { ...bp, graph_name: 'EventGraph', node_ids: [fault], compile: false });
    await compile();
    const dirty = await fixture('dirty', 'dirty-edited');
    assert.deepEqual(
      dirty.filter((p) => !initialDirty.includes(p)),
      [asset],
    );
    await call('save_asset', { asset_path: asset });
    same(await verify('persisted'), wired);
  }
  if (slotRun) {
    await qualifyMontageSlot({
      asset, mesh: ready.mesh, reload, call, probeValue, select, verify, read, fixture, history, same, compile, contentHashes,
      savedSlots: reload ? JSON.parse(readFileSync(join(output, assetLabel + '-slot-skeleton-before.json'))) : null,
    });
  }
  const finalFiles = contentHashes();
  save('content-after.json', finalFiles);
  const changedFiles = Object.keys({ ...initialFiles, ...finalFiles }).filter(
    (name) => initialFiles[name] !== finalFiles[name],
  );
  assert.deepEqual(changedFiles, reload ? [] : ['InteractiveBlend/' + assetLabel + '/ABP_Blend.uasset']);
  assert.deepEqual(await fixture('dirty', 'dirty-final'), initialDirty);
} catch (err) {
  failure = err;
  console.error(err.stack);
} finally {
  let quitError;
  if (owned && !exited) {
    try {
      writeFileSync(quitFile, 'quit');
    } catch (err) {
      quitError = err.message;
      failure ??= err;
    }
  }
  await client.close().catch(() => {});
  await transport.close().catch(() => {});
  if (owned && !quitError && !exited) await Promise.race([execution, delay(12000, undefined, { ref: false })]);
  if (!exited && child) await terminateProcessTree(child);
  const result = await execution;
  if (result.status !== 'exited' || result.exitCode !== 0)
    failure ??= new Error('Editor exit ' + result.status + '/' + result.exitCode);
  let editorDiagnostics;
  try {
    const engineVersion = JSON.parse(readFileSync(join(engine, 'Engine/Build/Build.version'), 'utf8'));
    const editorLog = readFileSync(out('editor.log'));
    editorDiagnostics = {
      logPath: out('editor.log'),
      logSha256: createHash('sha256').update(editorLog).digest('hex'),
      ...classifyEditorEnsures(editorLog.toString('utf8'), engineVersion),
    };
    save('editor-diagnostics.json', editorDiagnostics);
    if (!editorDiagnostics.passed) failure ??= new Error('Unexpected editor ensure; see editor-diagnostics.json');
  } catch (err) {
    failure ??= new Error('Editor diagnostics unavailable: ' + err.message);
  }
  save('results.json', {
    error: failure?.message ?? null,
    quitError,
    phases,
    status: result.status,
    exitCode: result.exitCode,
    editorDiagnostics,
  });
  save('mcp.json', records);
  writeFileSync(out('server.log'), stderr);
  console.error(JSON.stringify({ failure: failure?.message, phases, exitCode: result.exitCode }));
}
process.exitCode = failure ? 1 : 0;
