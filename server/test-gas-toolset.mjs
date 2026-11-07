// Planned-only toolsets remain visible as unavailable, never as callable tools.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createUemcpServer } from './create-uemcp-server.mjs';
import { ToolsetManager } from './toolset-manager.mjs';
import { ToolIndex } from './tool-index.mjs';
import { createCanonicalScratchRoot, cleanupCanonicalScratchRoot, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Planned GAS Toolset Official Client Tests');
// Definition fixtures use the real loader, then replace only in-memory data.
// Empty configuration/defaults must not be mistaken for nonempty planned GAS.
for (const fixture of [{}, { toolsets: {} }]) {
  const index = new ToolIndex();
  const manager = new ToolsetManager({ isLayerAvailable: async () => true }, index);
  await manager.load();
  const data = manager.getToolsData();
  for (const key of Object.keys(data)) delete data[key];
  Object.assign(data, fixture);
  index.build(data);
  t.assert((await manager.listToolsets()).length === 0, `empty definitions ${JSON.stringify(fixture)} list no unavailable phantom toolsets`);
  const enabled = await manager.enable([]);
  t.assert(enabled.enabled.length === 0 && enabled.blocked.length === 0, `empty definitions ${JSON.stringify(fixture)} accept an empty enable request`);
}
for (const emptyTools of [undefined, {}]) {
  const index = new ToolIndex();
  const manager = new ToolsetManager({ isLayerAvailable: async () => true }, index);
  await manager.load();
  const data = manager.getToolsData();
  data.toolsets.actors = { layer: 'tcp-55558', ...(emptyTools && { tools: emptyTools }) };
  index.build(data);
  const enabled = await manager.enable(['actors'], { source: 'project_context' });
  t.assert(enabled.enabled.includes('actors') && enabled.blocked.length === 0, `empty tool definitions ${JSON.stringify(emptyTools) || 'omitted'} preserve successful enabling`);
  const row = (await manager.listToolsets()).find(toolset => toolset.name === 'actors');
  t.assert(row.toolCount === 0 && row.available && row.enabled, `empty tool definitions ${JSON.stringify(emptyTools) || 'omitted'} remain valid on an available layer`);
}
const prefix = 'uemcp-gas-toolset-';
const scratch = createCanonicalScratchRoot(prefix);
const workspace = join(scratch, 'empty');
const root = join(scratch, 'project');
mkdirSync(workspace);
mkdirSync(root);
const uprojectPath = join(root, 'GasFixture.uproject');
writeFileSync(uprojectPath, '{"FileVersion":3}\n');
const gasTools = ['create_gameplay_effect', 'create_gameplay_ability', 'modify_gameplay_effect', 'create_attribute_set'];
const calls = [];
const app = await createUemcpServer({
  env: {}, cwd: workspace, workspaceRoots: [], writeProjectCodenames: false,
  stderr: { write() {} }, processInspector: () => [],
  tcpCommandFn: async (_port, type) => {
    calls.push(type);
    return { status: 'success', result: type === 'get_editor_state'
      ? { project_root: root, uproject_path: uprojectPath, project_name: 'GasFixture', deploy_marker_present: false }
      : {} };
  },
  httpCommandFn: async () => ({ status: 'success', result: {} }),
});
const client = new Client({ name: 'gas-toolset-regression', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const call = (name, args = {}) => client.callTool({ name, arguments: args });
try {
  await app.start(serverTransport);
  await client.connect(clientTransport);
  // Official listTools loads output validators before any callTool invocation.
  const initialTools = await client.listTools();
  t.assert(gasTools.every(name => !initialTools.tools.some(tool => tool.name === name)), 'planned GAS tools are absent from initial tools/list');
  const initial = (await call('list_toolsets')).structuredContent;
  const initialGas = initial.toolsets.find(row => row.name === 'gas');
  t.assert(initialGas?.toolCount === 0 && initialGas.available === false && initialGas.enabled === false, 'configured GAS is listed with zero callable tools and unavailable');
  t.assert(/planned|not implemented/i.test(initialGas?.reason || ''), 'unattached listing explains implementation status');
  await call('attach_project', { uproject_path: uprojectPath, allow_outside_client_roots: true });
  const attached = (await call('list_toolsets')).structuredContent;
  const offline = attached.toolsets.find(row => row.name === 'offline');
  t.assert(offline?.enabled && offline.available && offline.toolCount > 0, 'empty runtime configuration preserves automatic offline defaults after attachment');
  const noOpEnable = (await call('enable_toolset', { toolsets: [] })).structuredContent;
  t.assert(noOpEnable.enabled.length === 0 && noOpEnable.unavailable.length === 0 && noOpEnable.blocked.length === 0, 'empty toolset enable request stays a successful no-op');
  await call('connection_info', { force_reconnect: true });
  const result = (await call('enable_toolset', { toolsets: ['gas', 'actors'] })).structuredContent;
  t.assert(result.enabled.includes('actors') && !result.enabled.includes('gas') && result.unavailable.includes('gas'), 'healthy transport enables implemented actors but cannot enable empty GAS');
  t.assert(result.blocked.some(row => row.toolset === 'gas' && row.code === 'TOOLSET_NOT_IMPLEMENTED'), 'enable explains planned-only GAS rather than editor connectivity');
  const listed = (await call('list_toolsets')).structuredContent;
  const gas = listed.toolsets.find(row => row.name === 'gas');
  t.assert(gas?.available === false && gas.enabled === false && gas.toolCount === 0, 'GAS stays unavailable with healthy transport');
  const tools = await client.listTools();
  t.assert(gasTools.every(name => !tools.tools.some(tool => tool.name === name)), 'enable does not publish unimplemented tools');
  const search = (await call('find_tools', { query: 'create_gameplay_effect' })).structuredContent;
  t.assert(Array.isArray(search.results) && search.results.every(row => row.toolset !== 'gas'), 'planned GAS tools stay excluded from search');
  for (const name of gasTools) {
    const described = await call('describe_tool', { tool: name });
    t.assert(described.isError === true, `${name} has no callable dispatcher entry`);
    const dispatched = await call('call_mutating_tool', { tool: name, arguments: { name: 'Unimplemented' } });
    t.assert(dispatched.isError === true, `${name} cannot be invoked through the mutation dispatcher`);
  }
  t.assert(!calls.some(type => gasTools.includes(type)), 'no planned GAS command reaches the transport');
} catch (error) {
  t.assert(false, 'official SDK GAS lifecycle', error.stack);
} finally {
  await client.close();
  await app.server.close();
  cleanupCanonicalScratchRoot(scratch, prefix);
}
t.summary();
process.exit(t.failed > 0 ? 1 : 0);
