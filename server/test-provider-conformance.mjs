// Provider-neutral MCP conformance coverage.
//
// Exercises the public JSON-RPC wire path with the real UEMCP server and
// FakeMcpTransport. Client identity is intentionally a matrix input, never a
// branch condition: each named client must match unknown-mcp-host after the
// negotiated capability profile is held constant.
//
// Run: cd server && node test-provider-conformance.mjs

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createUemcpServer } from './create-uemcp-server.mjs';
import { FakeMcpTransport } from './test-mcp-fake-transport.mjs';
import { TestRunner } from './test-helpers.mjs';

const PROTOCOL_VERSION = '2024-11-05';
const LIST_CHANGED_METHOD = 'notifications/tools/list_changed';
const SCRATCH_PREFIX = 'uemcp-provider-conformance-';
const CLIENTS = Object.freeze([
  { name: 'claude-code', version: '2.1.210' },
  { name: 'codex', version: '0.144.4' },
  { name: 'gemini-cli', version: '0.41.2' },
  { name: 'visual-studio-code', version: '1.128.1' },
  { name: 'unknown-mcp-host', version: '9.9.9' },
]);
const UNKNOWN_HOST = CLIENTS.at(-1);
const PROFILES = Object.freeze([
  { name: 'no-capabilities', capabilities: {} },
  {
    name: 'roots-and-form-elicitation',
    capabilities: { roots: { listChanged: true }, elicitation: { form: {} } },
  },
]);
const MANAGEMENT_NAMES = Object.freeze([
  'attach_project',
  'connection_info',
  'detect_project',
  'detach_project',
  'disable_toolset',
  'enable_toolset',
  'find_tools',
  'list_project_targets',
  'list_toolsets',
  'refresh_project_context',
]);

const t = new TestRunner('Provider-Neutral MCP Conformance');
const generatedScratchRoots = new Set();

function scratchParent() {
  return process.env['T' + 'EMP'] || process.env['T' + 'MP'] || homedir();
}

function listScratchInventory() {
  return readdirSync(scratchParent(), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(SCRATCH_PREFIX))
    .map(entry => entry.name)
    .sort();
}

function makeScratchRoot() {
  const parent = scratchParent();
  for (let sequence = 0; sequence < 10; sequence += 1) {
    const root = join(parent, `${SCRATCH_PREFIX}${randomUUID()}`);
    try {
      mkdirSync(root);
      generatedScratchRoots.add(root);
      return root;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Unable to allocate a conformance scratch directory.');
}

function cleanup(dir) {
  const normalized = dir.replace(/\\/g, '/');
  const parent = scratchParent()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!normalized.startsWith(`${parent}/${SCRATCH_PREFIX}`)) {
    throw new Error(`Refusing to remove unexpected path: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

async function settleEventLoop(turns = 5) {
  for (let index = 0; index < turns; index += 1) {
    await new Promise(resolve => setImmediate(resolve));
  }
}

async function closeAndVerifyCleanup(app, root, label) {
  if (app) await app.server.close();
  cleanup(root);
  await settleEventLoop();
  await new Promise(resolve => setTimeout(resolve, 25));
  t.assert(!existsSync(root), `${label}: generated scratch root remains absent after cleanup`);
}

async function waitForCondition(label, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

function writeProject(root, name = 'ConformanceProject') {
  mkdirSync(join(root, 'Content'), { recursive: true });
  const uprojectPath = join(root, `${name}.uproject`);
  writeFileSync(uprojectPath, '{"FileVersion":3}\n', 'utf8');
  return { name, projectRoot: root, uprojectPath };
}

async function createWireApp({ cwd, workspaceRoots = [] } = {}) {
  const app = await createUemcpServer({
    cwd,
    repoRoot: cwd,
    workspaceRoots,
    env: {},
    processInspector: () => [],
    tcpCommandFn: async () => ({ status: 'success', result: {} }),
    httpCommandFn: async () => ({ status: 'success', result: {} }),
    writeProjectCodenames: false,
    stderr: { write() {} },
  });
  const transport = new FakeMcpTransport();
  await app.start(transport);
  return { app, transport };
}

async function initialize(transport, client, capabilities) {
  return transport.sendClientRequest('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities,
    clientInfo: client,
  });
}

async function toolsList(transport) {
  return transport.sendClientRequest('tools/list', {});
}

async function callTool(transport, name, args = {}) {
  return transport.sendClientRequest('tools/call', { name, arguments: args });
}

function parseToolResult(response) {
  const text = response.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

function toolNames(response) {
  return response.result.tools.map(tool => tool.name).sort();
}

function managementRows(response) {
  const rows = response.result.tools
    .filter(tool => MANAGEMENT_NAMES.includes(tool.name))
    .map(tool => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      outputSchema: tool.outputSchema,
      annotations: tool.annotations,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  if (rows.length !== MANAGEMENT_NAMES.length) {
    throw new Error(`Expected ${MANAGEMENT_NAMES.length} management rows, got ${rows.length}`);
  }
  return rows;
}

async function waitForNotifications(transport, method, { timeoutMs = 3000, settleTicks = 5 } = {}) {
  const collected = [];
  const deadline = Date.now() + timeoutMs;
  while (collected.length === 0) {
    collected.push(...transport.drainNotifications(method));
    if (collected.length > 0) break;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${method}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  for (let index = 0; index < settleTicks; index += 1) {
    await settleEventLoop(1);
    collected.push(...transport.drainNotifications(method));
  }
  return collected;
}

async function drainSettledNotifications(transport, method, settleTicks = 5) {
  const collected = [];
  for (let index = 0; index < settleTicks; index += 1) {
    await settleEventLoop(1);
    collected.push(...transport.drainNotifications(method));
  }
  return collected;
}

async function assertNotificationQueueEmpty(transport, label) {
  const queued = await drainSettledNotifications(transport, LIST_CHANGED_METHOD);
  t.assert(
    queued.length === 0,
    `${label}: settled list-changed queue is empty before action`,
    `got ${queued.length}`,
  );
}

async function collectOneListChanged(transport, label) {
  const notifications = await waitForNotifications(transport, LIST_CHANGED_METHOD);
  t.assert(
    notifications.length === 1,
    `${label}: action emits exactly one list-changed notification`,
    `got ${notifications.length}`,
  );
  return notifications;
}

async function waitForProjectState(transport, {
  attachmentState,
  projectName = null,
  projectInfoVisible,
  minimumGeneration = 1,
}, label) {
  let observed = null;
  await waitForCondition(label, async () => {
    observed = parseToolResult(await callTool(transport, 'connection_info'));
    const names = toolNames(await toolsList(transport));
    return observed?.projectContext?.generation >= minimumGeneration &&
      observed.projectContext.attachmentState === attachmentState &&
      (projectName === null || observed.projectContext.identity?.projectName === projectName) &&
      names.includes('project_info') === projectInfoVisible;
  });
  return observed;
}

function normalizeSnapshot(value, scratchPaths) {
  if (Array.isArray(value)) return value.map(item => normalizeSnapshot(item, scratchPaths));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => {
      if (key === 'requestId' || key === 'request_id') return [key, '<REQUEST_ID>'];
      if (key === 'timestamp' || key.endsWith('At')) return [key, '<TIMESTAMP>'];
      return [key, normalizeSnapshot(nested, scratchPaths)];
    }));
  }
  if (typeof value !== 'string') return value;

  let normalized = value;
  for (const [path, label] of scratchPaths) {
    const slashPath = path.replace(/\\/g, '/');
    normalized = normalized.replaceAll(path, label).replaceAll(slashPath, label);
  }
  return normalized;
}

function assertDeepEqual(actual, expected, label) {
  const actualJson = JSON.stringify(actual);
  const expectedJson = JSON.stringify(expected);
  t.assert(actualJson === expectedJson, label, `expected=${expectedJson}\nactual=${actualJson}`);
}

async function captureProfile(client, profile) {
  const workspace = makeScratchRoot();
  const project = writeProject(join(workspace, 'ConformanceProject'));
  const scratchPaths = new Map([
    [workspace, '<SCRATCH_WORKSPACE>'],
    [project.projectRoot, '<SCRATCH_PROJECT>'],
    [project.uprojectPath, '<SCRATCH_UPROJECT>'],
  ]);
  let app;
  try {
    const wire = await createWireApp({ cwd: workspace });
    app = wire.app;
    const { transport } = wire;
    const initialized = await initialize(transport, client, profile.capabilities);
    const initialTools = await toolsList(transport);
    const unattachedConnectionInfo = parseToolResult(await callTool(transport, 'connection_info'));
    const unattachedFindTools = parseToolResult(await callTool(transport, 'find_tools', {
      query: 'project information',
      max_results: 3,
    }));

    const profileLabel = `${profile.name}/${client.name}`;
    await assertNotificationQueueEmpty(transport, `${profileLabel}/attach`);
    const attach = await callTool(transport, 'attach_project', { uproject_path: project.uprojectPath });
    if (attach.result?.isError) throw new Error(`attach_project failed: ${JSON.stringify(attach.result.structuredContent)}`);
    const postAttachNames = toolNames(await toolsList(transport));
    const attachNotifications = await collectOneListChanged(transport, `${profileLabel}/attach`);

    await assertNotificationQueueEmpty(transport, `${profileLabel}/enable`);
    const enable = await callTool(transport, 'enable_toolset', { toolsets: ['actors'] });
    if (enable.result?.isError) throw new Error(`enable_toolset failed: ${JSON.stringify(enable.result.structuredContent)}`);
    const postEnableNames = toolNames(await toolsList(transport));
    const enableNotifications = await collectOneListChanged(transport, `${profileLabel}/enable`);

    return normalizeSnapshot({
      initialize: {
        serverInfo: initialized.result?.serverInfo,
        capabilities: initialized.result?.capabilities,
        instructions: initialized.result?.instructions,
      },
      initialManagementTools: managementRows(initialTools),
      unattached: {
        connectionInfo: unattachedConnectionInfo,
        findTools: unattachedFindTools,
      },
      postAttachNames,
      postEnableNames,
      notifications: { attach: attachNotifications, enable: enableNotifications },
    }, scratchPaths);
  } finally {
    await closeAndVerifyCleanup(app, workspace, `${profile.name}/${client.name}`);
  }
}

async function resolveInheritedWorkspace(client) {
  const workspace = makeScratchRoot();
  const project = writeProject(join(workspace, 'InheritedProject'), 'InheritedProject');
  let app;
  try {
    const wire = await createWireApp({
      cwd: workspace,
      workspaceRoots: [project.projectRoot],
    });
    app = wire.app;
    const { transport } = wire;
    await initialize(transport, client, PROFILES[0].capabilities);
    await assertNotificationQueueEmpty(transport, `no-roots/${client.name}/initialized`);
    await transport.sendClientNotification('notifications/initialized');
    await settleEventLoop();
    const rootRequests = transport.drainServerRequests('roots/list');
    t.assert(
      rootRequests.length === 0,
      `${client.name}: no-roots client receives no roots/list request`,
      `got ${rootRequests.length}`,
    );
    const info = await waitForProjectState(transport, {
      attachmentState: 'auto_attached',
      projectName: project.name,
      projectInfoVisible: true,
    }, `${client.name}: inherited workspace auto-attachment`);
    await collectOneListChanged(transport, `no-roots/${client.name}/initialized`);
    return info;
  } finally {
    await closeAndVerifyCleanup(app, workspace, `no-roots/${client.name}`);
  }
}

async function resolveRoots(client, { rejected = false } = {}) {
  const workspace = makeScratchRoot();
  const projectName = rejected ? 'FallbackProject' : 'RootsProject';
  const project = writeProject(join(workspace, projectName), projectName);
  let app;
  try {
    const wire = await createWireApp({
      cwd: workspace,
      workspaceRoots: rejected ? [project.projectRoot] : [],
    });
    app = wire.app;
    const { transport } = wire;
    await initialize(transport, client, PROFILES[1].capabilities);
    const label = `${rejected ? 'rejected-roots' : 'roots'}/${client.name}`;
    await assertNotificationQueueEmpty(transport, `${label}/initialized`);
    await transport.sendClientNotification('notifications/initialized');
    if (rejected) {
      await transport.rejectServerRequest('roots/list', -32001, 'roots disabled');
    } else {
      await transport.respondToServerRequest('roots/list', {
        roots: [{ uri: pathToFileURL(project.projectRoot).href, name: project.name }],
      });
    }
    const info = await waitForProjectState(transport, {
      attachmentState: 'auto_attached',
      projectName: project.name,
      projectInfoVisible: true,
    }, `${client.name}: ${rejected ? 'rejected roots fallback' : 'roots resolution'}`);
    await collectOneListChanged(transport, `${label}/initialized`);
    return info;
  } finally {
    await closeAndVerifyCleanup(app, workspace, `${rejected ? 'rejected-roots' : 'roots'}/${client.name}`);
  }
}

async function assertFormElicitation(client) {
  const workspace = makeScratchRoot();
  let app;
  try {
    const wire = await createWireApp({ cwd: workspace });
    app = wire.app;
    const { transport } = wire;
    await initialize(transport, client, PROFILES[1].capabilities);
    await transport.sendClientNotification('notifications/initialized');
    await transport.respondToServerRequest('roots/list', { roots: [] });
    await waitForProjectState(transport, {
      attachmentState: 'unresolved',
      projectInfoVisible: false,
    }, `${client.name}: empty roots resolution`);
    await assertNotificationQueueEmpty(transport, `form/${client.name}/attach`);

    const project = writeProject(join(workspace, 'PromptProject'), 'PromptProject');
    const callPromise = callTool(transport, 'attach_project', { prompt: true });
    const request = await transport.respondToServerRequest('elicitation/create', {
      action: 'accept',
      content: { project_path: project.uprojectPath },
    });
    t.assert(request.params.mode === 'form', `${client.name}: negotiated elicitation requests form mode`);
    t.assert(
      request.params.requestedSchema.properties.project_path.type === 'string',
      `${client.name}: form requests a project path`,
    );

    const response = await callPromise;
    t.assert(response.result?.isError !== true, `${client.name}: form-capable prompt attaches successfully`);
    t.assert(
      response.result?.structuredContent?.projectContext?.identity?.projectName === project.name,
      `${client.name}: elicited attachment reports PromptProject`,
    );
    const info = await waitForProjectState(transport, {
      attachmentState: 'attached',
      projectName: project.name,
      projectInfoVisible: true,
      minimumGeneration: 2,
    }, `${client.name}: elicited project attachment`);
    await collectOneListChanged(transport, `form/${client.name}/attach`);
    t.assert(
      info.projectContext.identity?.projectName === project.name,
      `${client.name}: connection_info reports elicited project identity`,
    );
  } finally {
    await closeAndVerifyCleanup(app, workspace, `form/${client.name}`);
  }
}

async function assertNoFormElicitation(client) {
  const workspace = makeScratchRoot();
  let app;
  try {
    const wire = await createWireApp({ cwd: workspace });
    app = wire.app;
    const { transport } = wire;
    await initialize(transport, client, PROFILES[0].capabilities);
    const response = await callTool(transport, 'attach_project', { prompt: true });
    t.assert(response.result?.isError === true, `${client.name}: no-form prompt is an error`);
    t.assert(
      response.result?.structuredContent?.code === 'ELICITATION_UNAVAILABLE',
      `${client.name}: no-form prompt uses ELICITATION_UNAVAILABLE`,
      `got ${response.result?.structuredContent?.code}`,
    );
  } finally {
    await closeAndVerifyCleanup(app, workspace, `no-form/${client.name}`);
  }
}

const scratchInventoryBefore = listScratchInventory();
console.log(`\nScratch inventory before: ${scratchInventoryBefore.length}`);

for (const profile of PROFILES) {
  console.log(`\n-- ${profile.name}: unknown-host baseline --`);
  const baseline = await captureProfile(UNKNOWN_HOST, profile);

  for (const client of CLIENTS) {
    console.log(`\n-- ${profile.name}: ${client.name} --`);
    const actual = client.name === UNKNOWN_HOST.name ? baseline : await captureProfile(client, profile);
    assertDeepEqual(actual, baseline, `${profile.name}: ${client.name} matches unknown-mcp-host`);
  }
}

for (const client of CLIENTS) {
  console.log(`\n-- capability probes: ${client.name} --`);
  const inherited = await resolveInheritedWorkspace(client);
  t.assert(
    inherited.projectContext.attachmentState === 'auto_attached',
    `${client.name}: no-roots inherited workspace auto-attaches deterministically`,
  );
  t.assert(
    inherited.projectContext.identity?.projectName === 'InheritedProject',
    `${client.name}: no-roots fallback resolves InheritedProject`,
  );

  const roots = await resolveRoots(client);
  t.assert(roots.projectContext.attachmentState === 'auto_attached', `${client.name}: roots capability auto-attaches one project`);
  t.assert(roots.projectContext.identity?.projectName === 'RootsProject', `${client.name}: roots capability resolves RootsProject`);

  const fallback = await resolveRoots(client, { rejected: true });
  t.assert(fallback.projectContext.attachmentState === 'auto_attached', `${client.name}: rejected roots falls back to inherited workspace roots`);
  t.assert(fallback.projectContext.identity?.projectName === 'FallbackProject', `${client.name}: fallback resolves FallbackProject`);
  t.assert(
    fallback.projectContext.warnings.some(warning => warning.code === 'ROOTS_UNSUPPORTED'),
    `${client.name}: fallback records ROOTS_UNSUPPORTED`,
  );

  await assertFormElicitation(client);
  await assertNoFormElicitation(client);
}

for (const root of generatedScratchRoots) {
  t.assert(!existsSync(root), `generated scratch root is absent at suite end: ${root}`);
}

const scratchInventoryAfter = listScratchInventory();
console.log(`Scratch inventory after: ${scratchInventoryAfter.length}`);
assertDeepEqual(
  scratchInventoryAfter,
  scratchInventoryBefore,
  'scratch inventory is unchanged after all conformance probes',
);

process.exit(t.summary());
