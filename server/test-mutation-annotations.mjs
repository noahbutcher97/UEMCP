// Literal effect inventory from the handler audit; expectations must not be
// derived from the same YAML/override policy whose omissions this gate detects.
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import yaml from 'js-yaml';
import { createUemcpServer } from './create-uemcp-server.mjs';
import { getToolRequirement } from './tool-requirements.mjs';
import { getToolAnnotations } from './tool-annotations.mjs';
import { FakeMcpTransport } from './test-mcp-fake-transport.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const MUTATIONS = [
  'set_static_mesh_props', 'set_physics_props', 'set_pawn_props',
  'add_event_node', 'add_function_node', 'add_function_graph',
  'add_variable_get', 'add_variable_set', 'add_control_node', 'add_cast_node',
  'add_parent_function_call', 'override_parent_member', 'add_math_node',
  'add_self_reference', 'add_component_reference', 'connect_nodes',
  'add_input_action_node', 'bp_compile_and_report',
  'spawn_actor', 'delete_actor', 'set_actor_transform', 'set_actor_property',
  'spawn_blueprint_actor', 'create_procedural_mesh', 'mesh_boolean', 'generate_uvs',
  'add_widget_to_viewport', 'run_editor_utility',
  'focus_viewport', 'details_panel_expand_all', 'details_panel_scroll',
  'regenerate_sidecar', 'take_screenshot', 'get_asset_preview_render',
  'get_viewport_screenshot', 'capture_asset_editor', 'capture_pie_viewport',
];
const READS = [
  ['get_editor_state', {}],
  ['is_pie_running', {}],
  ['get_pie_session_state', {}],
  ['get_pie_actor_state', { actor_ref: { name: 'FixtureActor' } }],
  ['sample_pie_actor_state', { actor_ref: { name: 'FixtureActor' }, duration_ms: 0 }],
  ['wait_for_pie_actor_stable', { actor_ref: { name: 'FixtureActor' }, stable_samples: 1, interval_ms: 1, timeout_ms: 1000 }],
  ['list_asset_editor_tabs', { asset_path: '/Game/BP_Fixture' }],
];
const MUTATION_HINTS = { readOnlyHint: false, destructiveHint: true };
const READ_HINTS = { readOnlyHint: true };
const REPRESENTATIVES = [
  ['Blueprint graph', 'add_variable_get', { blueprint_name: 'BP_Fixture', variable_name: 'Health' }],
  ['world', 'spawn_actor', { type: 'PointLight', name: 'FixtureActor' }],
  ['disk', 'regenerate_sidecar', { asset_path: '/Game/BP_Fixture' }],
  ['UI', 'focus_viewport', { target: 'FixtureActor' }],
  ['runtime', 'add_widget_to_viewport', { blueprint_name: 'WBP_Fixture' }],
  ['utility', 'run_editor_utility', { asset_path: '/Game/EUB_Fixture' }],
  ['preview inline', 'get_asset_preview_render', { asset_path: '/Game/BP_Fixture', return_base64: true }],
  ['preview disk', 'get_asset_preview_render', { asset_path: '/Game/BP_Fixture', output_path: 'Saved/fixture.jpg' }],
];

const t = new TestRunner('Mutation Annotation Policy Tests');
const toolsData = yaml.load(readFileSync(new URL('../tools.yaml', import.meta.url), 'utf8'));
const definitions = new Map(Object.entries(toolsData.toolsets).flatMap(([toolset, group]) =>
  Object.entries(group.tools).map(([name, def]) => [name, { toolset, def }])));
const scratch = createCanonicalScratchRoot('uemcp-mutation-policy-');
const projectRoot = join(scratch, 'Fixture');
mkdirSync(join(projectRoot, 'Content'), { recursive: true });
const uproject = join(projectRoot, 'Fixture.uproject');
writeFileSync(uproject, '{"FileVersion":3}\n');
const calls = [];
const begun = [];
const ended = [];
let backendFailure = false;
let previewInvocation = 0;
let app;
const transport = new FakeMcpTransport();

async function check(label, callback) {
  try {
    await callback();
    t.assert(true, label);
  } catch (error) {
    t.assert(false, label, error.stack);
  }
}
function call(name, args = {}) {
  return transport.sendClientRequest('tools/call', { name, arguments: args });
}
function dispatch(name, args = {}, dispatcher = 'call_mutating_tool') {
  return call(dispatcher, { tool: name, arguments: args });
}
function payload(response) {
  return response.result?.structuredContent || JSON.parse(response.result.content[0].text);
}
function assertSuccess(response) {
  assert.equal(response.error, undefined);
  assert.ok(!response.result.isError, response.result.content[0].text);
}
function assertBalanced(started, finished, name) {
  assert.equal(begun.length, started + 1);
  assert.equal(ended.length, finished + 1);
  assert.equal(begun.at(-1).name, name);
  assert.equal(ended.at(-1), begun.at(-1).id);
  assert.equal(app.projectContext.getInFlightMutationCount(), 0);
}
function freshExecutorArgs(name, args) {
  // Preview retains its existing read cache policy. Distinct synthetic assets
  // isolate executor lifecycle cases without claiming cache semantics changed.
  return name === 'get_asset_preview_render'
    ? { ...args, asset_path: `${args.asset_path}_${++previewInvocation}` }
    : args;
}

try {
  assert.equal(MUTATIONS.length, 37);
  assert.equal(new Set(MUTATIONS).size, 37);
  app = await createUemcpServer({
    env: {}, cwd: scratch, workspaceRoots: [], writeProjectCodenames: false,
    processInspector: () => [], stderr: { write() {} },
    tcpCommandFn: async (_port, type, params) => {
      calls.push({ type, params, active: app.projectContext.getInFlightMutationCount() });
      if (backendFailure && type !== 'ping') throw new Error('Synthetic executor failure');
      return { status: 'success', result: type === 'get_editor_state' ? {
        project_root: projectRoot, uproject_path: uproject, project_name: 'Fixture',
      } : {
        echoedType: type,
        actor: { transform: { location: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } },
      } };
    },
    httpCommandFn: async () => ({ status: 'success', result: {} }),
  });
  await app.start(transport);
  await transport.sendClientRequest('initialize', {
    protocolVersion: '2024-11-05', capabilities: {},
    clientInfo: { name: 'mutation-policy-regression', version: '1.0.0' },
  });

  for (const name of MUTATIONS) {
    await check(`${name}: literal mutation requirement and hints`, () => {
      const { toolset, def } = definitions.get(name);
      const requirement = getToolRequirement(name, toolset, def);
      assert.equal(requirement, 'live_mutation');
      assert.deepEqual(getToolAnnotations(name, requirement), MUTATION_HINTS);
    });
    await check(`${name}: describe names mutating dispatcher`, async () => {
      const described = payload(await call('describe_tool', { tool: name }));
      assert.equal(described.requirement, 'live_mutation');
      assert.equal(described.dispatcher, 'call_mutating_tool');
      assert.deepEqual(described.annotations, MUTATION_HINTS);
    });
    await check(`${name}: read dispatcher refuses before validation or backend`, async () => {
      const before = calls.length;
      const refused = await dispatch(name, {}, 'call_tool');
      assert.equal(refused.result.isError, true);
      assert.equal(payload(refused).code, 'WRONG_DISPATCHER');
      assert.equal(calls.length, before);
    });
  }

  assertSuccess(await call('attach_project', { uproject_path: uproject }));
  assertSuccess(await call('connection_info', { force_reconnect: true }));
  assert.equal(app.projectContext.editorIdentityState, 'verified');
  assert.equal(app.projectContext.transportOwnershipState, 'verified');
  const toolsets = [...new Set([...MUTATIONS, ...READS.map(([name]) => name)].map(name => definitions.get(name).toolset))];
  assertSuccess(await call('enable_toolset', { toolsets }));
  const listed = (await transport.sendClientRequest('tools/list', {})).result.tools;
  for (const name of MUTATIONS) {
    await check(`${name}: tools/list advertises literal mutation hints`, () =>
      assert.deepEqual(listed.find(tool => tool.name === name)?.annotations, MUTATION_HINTS));
  }

  const beginMutation = app.projectContext.beginMutation.bind(app.projectContext);
  const endMutation = app.projectContext.endMutation.bind(app.projectContext);
  app.projectContext.beginMutation = metadata => {
    const id = beginMutation(metadata);
    begun.push({ id, name: metadata.toolName });
    return id;
  };
  app.projectContext.endMutation = id => { ended.push(id); return endMutation(id); };

  for (const [category, name, args] of REPRESENTATIVES) {
    for (const native of [false, true]) {
      await check(`${category}: ${native ? 'direct' : 'dispatcher'} success tracks mutation`, async () => {
        const before = calls.length;
        const started = begun.length;
        const finished = ended.length;
        const invocationArgs = freshExecutorArgs(name, args);
        const response = native ? await call(name, invocationArgs) : await dispatch(name, invocationArgs);
        assertSuccess(response);
        assert.ok(calls.length > before, 'operation reaches synthetic transport');
        assert.ok(calls.slice(before).some(item => item.active === 1), 'mutation active during transport');
        assertBalanced(started, finished, name);
      });
    }
    await check(`${category}: executor failure closes mutation`, async () => {
      const started = begun.length;
      const finished = ended.length;
      backendFailure = true;
      try {
        const response = await dispatch(name, freshExecutorArgs(name, args));
        assert.equal(response.result.isError, true);
        assert.match(response.result.content[0].text, /Synthetic executor failure/);
        assertBalanced(started, finished, name);
      } finally {
        backendFailure = false;
      }
    });
    for (const [guard, expected] of [['ownership', 'TRANSPORT_OWNER_UNKNOWN'], ['stale', 'DEPLOY_STALE']]) {
      await check(`${category}: ${guard} guard refuses before mutation or backend`, async () => {
        const before = calls.length;
        const started = begun.length;
        app.projectContext.transportOwnershipState = guard === 'ownership' ? 'unverified' : 'verified';
        app.projectContext.setDeployReadiness({ state: guard === 'stale' ? 'stale' : 'fresh' });
        try {
          const result = await dispatch(name, args);
          assert.equal(result.result.isError, true);
          assert.equal(payload(result).code, expected);
          assert.equal(calls.length, before);
          assert.equal(begun.length, started);
          assert.equal(app.projectContext.getInFlightMutationCount(), 0);
        } finally {
          app.projectContext.transportOwnershipState = 'verified';
          app.projectContext.setDeployReadiness({ state: 'fresh' });
        }
      });
    }
  }

  // These volatile observations deliberately skip transport caching. They must
  // remain callable as reads even when mutation-only guards would block a write.
  app.projectContext.transportOwnershipState = 'unverified';
  app.projectContext.setDeployReadiness({ state: 'stale' });
  for (const [name, args] of READS) {
    await check(`${name}: uncached observation retains read policy and dispatch`, async () => {
      const { toolset, def } = definitions.get(name);
      assert.equal(getToolRequirement(name, toolset, def), 'live_read');
      const described = payload(await call('describe_tool', { tool: name }));
      assert.deepEqual(described.annotations, READ_HINTS);
      assert.equal(described.dispatcher, 'call_tool');
      assert.deepEqual(listed.find(tool => tool.name === name)?.annotations, READ_HINTS);
      const started = begun.length;
      for (let i = 0; i < 2; i++) {
        const before = calls.length;
        assertSuccess(await dispatch(name, args, 'call_tool'));
        assert.ok(calls.length > before, 'volatile read is not served from cache');
        assert.ok(calls.slice(before).every(item => item.active === 0));
      }
      assert.equal(begun.length, started);
      assert.equal(app.projectContext.getInFlightMutationCount(), 0);
    });
  }
} finally {
  await app?.server.close();
  cleanupCanonicalScratchRoot(scratch, 'uemcp-mutation-policy-');
}

process.exit(t.summary());
