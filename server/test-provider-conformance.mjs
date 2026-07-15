// Provider-neutral MCP conformance coverage.
//
// Exercises the public JSON-RPC wire path with the real UEMCP server and
// FakeMcpTransport. Client identity is intentionally a matrix input, never a
// branch condition: each named client must match unknown-mcp-host after the
// negotiated capability profile is held constant.
//
// Run: cd server && node test-provider-conformance.mjs

import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createUemcpServer } from './create-uemcp-server.mjs';
import { FakeMcpTransport } from './test-mcp-fake-transport.mjs';
import { TestRunner } from './test-helpers.mjs';

const PROTOCOL_VERSION = '2024-11-05';
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

function makeScratchRoot() {
  const parent = process.env['T' + 'EMP'] || process.env['T' + 'MP'] || homedir();
  for (let sequence = 0; sequence < 10; sequence += 1) {
    const root = join(parent, `uemcp-provider-conformance-${randomUUID()}`);
    try {
      mkdirSync(root);
      return root;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
  }
  throw new Error('Unable to allocate a conformance scratch directory.');
}

function cleanup(dir) {
  const normalized = dir.replace(/\\/g, '/');
  const parent = (process.env['T' + 'EMP'] || process.env['T' + 'MP'] || homedir())
    .replace(/\\/g, '/')
    .replace(/\/+$/, '');
  if (!normalized.startsWith(`${parent}/uemcp-provider-conformance-`)) {
    throw new Error(`Refusing to remove unexpected path: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
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
    await new Promise(resolve => setImmediate(resolve));
    collected.push(...transport.drainNotifications(method));
  }
  return collected;
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

    transport.drainNotifications('notifications/tools/list_changed');
    const attach = await callTool(transport, 'attach_project', { uproject_path: project.uprojectPath });
    if (attach.result?.isError) throw new Error(`attach_project failed: ${JSON.stringify(attach.result.structuredContent)}`);
    const postAttachNames = toolNames(await toolsList(transport));
    const attachNotifications = await waitForNotifications(transport, 'notifications/tools/list_changed');
    if (attachNotifications.length !== 1) {
      throw new Error(`Expected one attach notification, got ${attachNotifications.length}`);
    }

    transport.drainNotifications('notifications/tools/list_changed');
    const enable = await callTool(transport, 'enable_toolset', { toolsets: ['actors'] });
    if (enable.result?.isError) throw new Error(`enable_toolset failed: ${JSON.stringify(enable.result.structuredContent)}`);
    const postEnableNames = toolNames(await toolsList(transport));
    const enableNotifications = await waitForNotifications(transport, 'notifications/tools/list_changed');
    if (enableNotifications.length !== 1) {
      throw new Error(`Expected one enable notification, got ${enableNotifications.length}`);
    }

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
    if (app) await app.server.close();
    cleanup(workspace);
  }
}

async function resolveRoots(client, { fallback = false } = {}) {
  const workspace = makeScratchRoot();
  const project = writeProject(join(workspace, fallback ? 'FallbackProject' : 'RootsProject'), fallback ? 'FallbackProject' : 'RootsProject');
  let app;
  try {
    const wire = await createWireApp({
      cwd: workspace,
      workspaceRoots: fallback ? [project.projectRoot] : [],
    });
    app = wire.app;
    const { transport } = wire;
    await initialize(transport, client, PROFILES[1].capabilities);
    await transport.sendClientNotification('notifications/initialized');
    if (fallback) {
      await transport.rejectServerRequest('roots/list', -32001, 'roots disabled');
    } else {
      await transport.respondToServerRequest('roots/list', {
        roots: [{ uri: pathToFileURL(project.projectRoot).href, name: project.name }],
      });
    }
    await new Promise(resolve => setImmediate(resolve));
    return parseToolResult(await callTool(transport, 'connection_info'));
  } finally {
    if (app) await app.server.close();
    cleanup(workspace);
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
    if (app) await app.server.close();
    cleanup(workspace);
  }
}

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
  const roots = await resolveRoots(client);
  t.assert(roots.projectContext.attachmentState === 'auto_attached', `${client.name}: roots capability auto-attaches one project`);
  t.assert(roots.projectContext.identity?.projectName === 'RootsProject', `${client.name}: roots capability resolves RootsProject`);

  const fallback = await resolveRoots(client, { fallback: true });
  t.assert(fallback.projectContext.attachmentState === 'auto_attached', `${client.name}: rejected roots falls back to inherited workspace roots`);
  t.assert(fallback.projectContext.identity?.projectName === 'FallbackProject', `${client.name}: fallback resolves FallbackProject`);
  t.assert(
    fallback.projectContext.warnings.some(warning => warning.code === 'ROOTS_UNSUPPORTED'),
    `${client.name}: fallback records ROOTS_UNSUPPORTED`,
  );

  await assertNoFormElicitation(client);
}

process.exit(t.summary());
