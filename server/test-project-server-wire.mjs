// Project attachment MCP lifecycle wire tests.
//
// Run: cd server && node test-project-server-wire.mjs

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createUemcpServer } from './create-uemcp-server.mjs';
import { FakeMcpTransport } from './test-mcp-fake-transport.mjs';
import { TestRunner } from './test-helpers.mjs';

const PROTOCOL_VERSION = '2024-11-05';

const t = new TestRunner('Project Server Wire Tests');

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'uemcp-project-wire-'));
}

function cleanup(dir) {
  const norm = dir.replace(/\\/g, '/');
  const tmp = tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm.startsWith(`${tmp}/uemcp-project-wire-`)) {
    throw new Error(`refusing to clean unexpected temp path: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function writeProject(root, name) {
  mkdirSync(root, { recursive: true });
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

async function createWireApp(options = {}) {
  const app = await createUemcpServer({
    env: options.env || {},
    cwd: options.cwd,
    repoRoot: options.repoRoot,
    workspaceRoots: options.workspaceRoots || [],
    processInspector: options.processInspector,
    deployInspector: options.deployInspector,
    tcpCommandFn: options.tcpCommandFn,
    httpCommandFn: options.httpCommandFn,
    writeProjectCodenames: options.writeProjectCodenames === true,
    stderr: { write() {} },
  });
  const transport = new FakeMcpTransport();
  await app.start(transport);
  return { app, transport };
}

async function initialize(transport, capabilities = {}) {
  return transport.sendClientRequest('initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities,
    clientInfo: { name: 'uemcp-project-wire-test', version: '1.0.0' },
  });
}

async function toolsList(transport) {
  return transport.sendClientRequest('tools/list', {});
}

async function callTool(transport, name, args = {}) {
  return transport.sendClientRequest('tools/call', {
    name,
    arguments: args,
  });
}

function toolNames(listResponse) {
  return listResponse.result.tools.map(tool => tool.name).sort();
}

function parseTextResult(response) {
  const text = response.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : null;
}

function assertManagementOnly(names, label) {
  t.assert(names.includes('connection_info'), `${label}: connection_info visible`);
  t.assert(names.includes('attach_project'), `${label}: attach_project visible`);
  t.assert(!names.includes('project_info'), `${label}: project_info hidden`);
}

async function waitForCondition(label, predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

await runCase('empty capabilities never request roots or elicitation', async () => {
  const root = makeTempRoot();
  try {
    const { app, transport } = await createWireApp({ cwd: root });
    await initialize(transport, {});
    await transport.sendClientNotification('notifications/initialized');
    await new Promise(resolve => setImmediate(resolve));

    t.assert(transport.drainServerRequests('roots/list').length === 0, 'roots/list was not requested');
    t.assert(transport.drainServerRequests('elicitation/create').length === 0, 'elicitation/create was not requested');

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('roots are requested after initialized, not during initialize', async () => {
  const root = makeTempRoot();
  try {
    const { app, transport } = await createWireApp({ cwd: root });
    await initialize(transport, { roots: { listChanged: true } });

    t.assert(transport.drainServerRequests('roots/list').length === 0, 'roots/list not requested during initialize');
    assertManagementOnly(toolNames(await toolsList(transport)), 'initial tools/list');

    await transport.sendClientNotification('notifications/initialized');
    const request = await transport.respondToServerRequest('roots/list', { roots: [] });
    t.assert(request.method === 'roots/list', 'roots/list requested after initialized');

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('one direct project root auto-attaches and emits one tool-list notification', async () => {
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'AutoProject'), 'AutoProject');
    const { app, transport } = await createWireApp({ cwd: root });
    await initialize(transport, { roots: { listChanged: true } });
    transport.drainNotifications('notifications/tools/list_changed');

    await transport.sendClientNotification('notifications/initialized');
    await transport.respondToServerRequest('roots/list', {
      roots: [{ uri: pathToFileURL(project.projectRoot).href, name: 'AutoProject' }],
    });
    await waitForCondition(
      'offline tools to become visible',
      async () => toolNames(await toolsList(transport)).includes('project_info')
    );

    const notifications = transport.drainNotifications('notifications/tools/list_changed');
    t.assert(notifications.length === 1, `one tools/list_changed notification on auto-attach (got ${notifications.length})`);

    const names = toolNames(await toolsList(transport));
    t.assert(names.includes('project_info'), 'offline project_info visible after auto-attach');

    const info = parseTextResult(await callTool(transport, 'connection_info', {}));
    t.assert(info.projectContext.attachmentState === 'auto_attached', `attachmentState auto_attached (got ${info.projectContext.attachmentState})`);
    t.assert(info.projectContext.identity.projectName === 'AutoProject', 'connection_info reports AutoProject');

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('multiple root candidates remain unresolved', async () => {
  const root = makeTempRoot();
  try {
    const one = writeProject(join(root, 'One'), 'One');
    const two = writeProject(join(root, 'Two'), 'Two');
    const { app, transport } = await createWireApp({ cwd: root });
    await initialize(transport, { roots: { listChanged: true } });

    await transport.sendClientNotification('notifications/initialized');
    await transport.respondToServerRequest('roots/list', {
      roots: [
        { uri: pathToFileURL(one.projectRoot).href, name: 'One' },
        { uri: pathToFileURL(two.projectRoot).href, name: 'Two' },
      ],
    });
    await new Promise(resolve => setImmediate(resolve));

    assertManagementOnly(toolNames(await toolsList(transport)), 'ambiguous tools/list');
    const info = parseTextResult(await callTool(transport, 'connection_info', {}));
    t.assert(info.projectContext.attachmentState === 'unresolved', `ambiguous roots unresolved (got ${info.projectContext.attachmentState})`);
    t.assert(info.projectContext.candidates.length === 2, `two candidates reported (got ${info.projectContext.candidates.length})`);

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('rejected roots/list records ROOTS_UNSUPPORTED and uses fallback roots', async () => {
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'FallbackProject'), 'FallbackProject');
    const { app, transport } = await createWireApp({
      cwd: root,
      workspaceRoots: [project.projectRoot],
    });
    await initialize(transport, { roots: { listChanged: true } });

    await transport.sendClientNotification('notifications/initialized');
    await transport.rejectServerRequest('roots/list', -32001, 'roots disabled');
    await new Promise(resolve => setImmediate(resolve));

    const info = parseTextResult(await callTool(transport, 'connection_info', {}));
    t.assert(info.projectContext.attachmentState === 'auto_attached', `fallback root auto-attaches (got ${info.projectContext.attachmentState})`);
    t.assert(info.projectContext.identity.projectName === 'FallbackProject', 'fallback identity is used');
    t.assert(
      info.projectContext.warnings.some(warning => warning.code === 'ROOTS_UNSUPPORTED'),
      'ROOTS_UNSUPPORTED warning is reported'
    );

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('roots/list_changed re-resolves and increments generation once', async () => {
  const root = makeTempRoot();
  try {
    const one = writeProject(join(root, 'One'), 'One');
    const two = writeProject(join(root, 'Two'), 'Two');
    const { app, transport } = await createWireApp({ cwd: root });
    await initialize(transport, { roots: { listChanged: true } });

    await transport.sendClientNotification('notifications/initialized');
    await transport.respondToServerRequest('roots/list', {
      roots: [{ uri: pathToFileURL(one.projectRoot).href, name: 'One' }],
    });
    await new Promise(resolve => setImmediate(resolve));
    const first = parseTextResult(await callTool(transport, 'connection_info', {})).projectContext;

    await transport.sendClientNotification('notifications/roots/list_changed');
    await transport.respondToServerRequest('roots/list', {
      roots: [{ uri: pathToFileURL(two.projectRoot).href, name: 'Two' }],
    });
    await new Promise(resolve => setImmediate(resolve));
    const second = parseTextResult(await callTool(transport, 'connection_info', {})).projectContext;

    t.assert(first.generation === 1, `initial generation is 1 (got ${first.generation})`);
    t.assert(second.generation === 2, `roots change increments once to 2 (got ${second.generation})`);
    t.assert(second.identity.projectName === 'Two', 'roots change re-attaches Two');

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('attach_project prompt accepts elicited project path', async () => {
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'PromptProject'), 'PromptProject');
    const { app, transport } = await createWireApp({ cwd: root, workspaceRoots: [root] });
    await initialize(transport, { elicitation: { form: {} } });
    await transport.sendClientNotification('notifications/initialized');
    await new Promise(resolve => setImmediate(resolve));

    const callPromise = callTool(transport, 'attach_project', { prompt: true });
    const request = await transport.respondToServerRequest('elicitation/create', {
      action: 'accept',
      content: { project_path: project.uprojectPath },
    });
    t.assert(request.params.requestedSchema.properties.project_path.type === 'string', 'elicitation schema includes project_path string');
    t.assert(!('candidates' in request.params.requestedSchema.properties), 'elicitation schema does not include nested candidates');

    const response = await callPromise;
    t.assert(!response.result.isError, `attach_project prompt accepted (got isError=${response.result.isError})`);
    t.assert(response.result.structuredContent.projectContext.identity.projectName === 'PromptProject', 'elicited project attaches');

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('attach_project prompt without elicitation support returns structured guidance', async () => {
  const root = makeTempRoot();
  try {
    const { app, transport } = await createWireApp({ cwd: root });
    await initialize(transport, {});

    const response = await callTool(transport, 'attach_project', { prompt: true });
    t.assert(response.result.isError === true, 'unsupported elicitation returns isError');
    t.assert(response.result.structuredContent.code === 'ELICITATION_UNAVAILABLE', `stable code ELICITATION_UNAVAILABLE (got ${response.result.structuredContent.code})`);
    t.assert(response.result.structuredContent.next.tool === 'attach_project', 'next guidance points to attach_project');

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('attach_project prompt decline and cancel do not attach', async () => {
  const root = makeTempRoot();
  try {
    const { app, transport } = await createWireApp({ cwd: root });
    await initialize(transport, { elicitation: { form: {} } });

    const declinePromise = callTool(transport, 'attach_project', { prompt: true });
    await transport.respondToServerRequest('elicitation/create', { action: 'decline' });
    const decline = await declinePromise;
    t.assert(decline.result.isError === true, 'declined elicitation returns isError');
    t.assert(decline.result.structuredContent.code === 'ELICITATION_UNAVAILABLE', `decline code stable (got ${decline.result.structuredContent.code})`);

    const cancelPromise = callTool(transport, 'attach_project', { prompt: true });
    await transport.respondToServerRequest('elicitation/create', { action: 'cancel' });
    const cancel = await cancelPromise;
    t.assert(cancel.result.isError === true, 'cancelled elicitation returns isError');
    t.assert(cancel.result.structuredContent.code === 'PROJECT_NOT_ATTACHED', `cancel code PROJECT_NOT_ATTACHED (got ${cancel.result.structuredContent.code})`);

    const info = parseTextResult(await callTool(transport, 'connection_info', {}));
    t.assert(info.projectContext.attachmentState === 'unresolved', `session remains unresolved (got ${info.projectContext.attachmentState})`);

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('management tools expose output schemas', async () => {
  const root = makeTempRoot();
  try {
    const { app, transport } = await createWireApp({ cwd: root });
    await initialize(transport, {});
    const tools = (await toolsList(transport)).result.tools;
    for (const name of ['connection_info', 'attach_project', 'detach_project', 'refresh_project_context']) {
      const tool = tools.find(entry => entry.name === name);
      t.assert(tool?.outputSchema?.type === 'object', `${name} exposes object outputSchema`);
    }
    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('default env hints do not auto-enable offline tools', async () => {
  const root = makeTempRoot();
  const envRoot = makeTempRoot();
  try {
    const project = writeProject(join(envRoot, 'EnvHintProject'), 'EnvHintProject');
    const { app, transport } = await createWireApp({
      cwd: root,
      env: { UNREAL_PROJECT_ROOT: project.projectRoot, UNREAL_PROJECT_NAME: 'EnvHintProject' },
    });
    await initialize(transport, {});
    await transport.sendClientNotification('notifications/initialized');

    assertManagementOnly(toolNames(await toolsList(transport)), 'default env hint tools/list');
    const info = parseTextResult(await callTool(transport, 'connection_info', {}));
    t.assert(info.projectContext.attachmentState === 'unresolved', `env hint remains unresolved (got ${info.projectContext.attachmentState})`);

    await app.server.close();
  } finally {
    cleanup(root);
    cleanup(envRoot);
  }
});

await runCase('find_tools returns blocked project matches while unresolved', async () => {
  const root = makeTempRoot();
  try {
    const { app, transport } = await createWireApp({ cwd: root });
    await initialize(transport, {});

    const response = await callTool(transport, 'find_tools', { query: 'gameplay tags', max_results: 5 });
    const payload = response.result.structuredContent;
    t.assert(payload.autoEnabled.length === 0, `unresolved find_tools autoEnabled empty (got ${payload.autoEnabled.join(',')})`);
    t.assert(payload.unavailable.includes('offline'), `unresolved find_tools marks offline unavailable (got ${payload.unavailable?.join(',')})`);
    t.assert(payload.results.some(result => result.blocked === 'PROJECT_NOT_ATTACHED'), 'unresolved find_tools marks results blocked');
    assertManagementOnly(toolNames(await toolsList(transport)), 'post-find_tools unresolved tools/list');

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('find_tools returns workflow tips after enabling related toolsets', async () => {
  const root = makeTempRoot();
  const projectContainer = makeTempRoot();
  try {
    const project = writeProject(join(projectContainer, 'TipsProject'), 'TipsProject');
    const { app, transport } = await createWireApp({
      cwd: root,
      tcpCommandFn: async () => ({ status: 'success' }),
    });
    await initialize(transport, {});

    await callTool(transport, 'attach_project', { uproject_path: project.uprojectPath });
    const response = await callTool(transport, 'find_tools', {
      query: 'spawn blueprint actor create blueprint',
      max_results: 10,
    });
    const payload = response.result.structuredContent;
    t.assert(payload.autoEnabled.includes('actors'), 'find_tools enables actors toolset');
    t.assert(payload.autoEnabled.includes('blueprints-write'), 'find_tools enables blueprints-write toolset');
    t.assert(
      payload.tips?.some(tip => /Typical actor workflow/.test(tip)),
      'find_tools returns cross-toolset actor workflow tip',
    );

    await app.server.close();
  } finally {
    cleanup(root);
    cleanup(projectContainer);
  }
});

await runCase('enable_toolset blocks project-scoped toolsets while unresolved', async () => {
  const root = makeTempRoot();
  try {
    const { app, transport } = await createWireApp({ cwd: root });
    await initialize(transport, {});

    const response = await callTool(transport, 'enable_toolset', { toolsets: ['offline'] });
    const payload = response.result.structuredContent;
    t.assert(payload.code === 'PROJECT_NOT_ATTACHED', `enable_toolset block code PROJECT_NOT_ATTACHED (got ${payload.code})`);
    t.assert(payload.unavailable.includes('offline'), 'offline is reported unavailable while unresolved');
    assertManagementOnly(toolNames(await toolsList(transport)), 'post-enable unresolved tools/list');

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('manual attach and detach toggle project-scoped visibility with one notification each', async () => {
  const root = makeTempRoot();
  const projectContainer = makeTempRoot();
  try {
    const project = writeProject(join(projectContainer, 'ManualProject'), 'ManualProject');
    const { app, transport } = await createWireApp({
      cwd: root,
      tcpCommandFn: async () => ({ status: 'success' }),
    });
    await initialize(transport, {});
    transport.drainNotifications('notifications/tools/list_changed');

    const attachResponse = await callTool(transport, 'attach_project', { uproject_path: project.uprojectPath });
    t.assert(!attachResponse.result.isError, `manual attach succeeds (got isError=${attachResponse.result.isError})`);
    const attachNotifications = transport.drainNotifications('notifications/tools/list_changed');
    t.assert(attachNotifications.length === 1, `manual attach emits one notification (got ${attachNotifications.length})`);
    const attachedNames = toolNames(await toolsList(transport));
    t.assert(attachedNames.includes('project_info'), 'manual attach exposes project_info');
    t.assert(attachedNames.includes('get_datatable_contents'), 'manual attach exposes initially-visible get_datatable_contents');
    t.assert(attachedNames.includes('get_montage_full'), 'manual attach exposes initially-visible get_montage_full');
    t.assert(!attachedNames.includes('create_montage'), 'manual attach does not expose whole animation toolset');

    const detachResponse = await callTool(transport, 'detach_project', {});
    t.assert(!detachResponse.result.isError, `detach succeeds (got isError=${detachResponse.result.isError})`);
    await waitForCondition(
      'project-scoped tools to become hidden after detach',
      async () => {
        const names = toolNames(await toolsList(transport));
        return !names.includes('project_info') &&
          !names.includes('get_datatable_contents') &&
          !names.includes('get_montage_full');
      }
    );
    const detachNotifications = transport.drainNotifications('notifications/tools/list_changed');
    t.assert(detachNotifications.length === 1, `detach emits one notification (got ${detachNotifications.length})`);

    await app.server.close();
  } finally {
    cleanup(root);
    cleanup(projectContainer);
  }
});

await runCase('metadata-only refresh emits no tool-list notification', async () => {
  const root = makeTempRoot();
  try {
    const { app, transport } = await createWireApp({ cwd: root });
    await initialize(transport, {});
    transport.drainNotifications('notifications/tools/list_changed');

    const response = await callTool(transport, 'refresh_project_context', {});
    t.assert(!response.result.isError, `refresh_project_context succeeds (got isError=${response.result.isError})`);
    const notifications = transport.drainNotifications('notifications/tools/list_changed');
    t.assert(notifications.length === 0, `metadata-only refresh emits no notifications (got ${notifications.length})`);

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('stale visible offline callback returns PROJECT_NOT_ATTACHED while unresolved', async () => {
  const root = makeTempRoot();
  const projectContainer = makeTempRoot();
  try {
    const project = writeProject(join(projectContainer, 'StaleProject'), 'StaleProject');
    const { app, transport } = await createWireApp({ cwd: root });
    await initialize(transport, {});

    await callTool(transport, 'attach_project', { uproject_path: project.uprojectPath });
    await callTool(transport, 'detach_project', {});

    app.toolsetManager.setToolsetVisibilityBatch(['offline'], true);
    const response = await callTool(transport, 'project_info', {});
    t.assert(response.result.isError === true, 'stale offline callback returns isError');
    t.assert(
      response.result.structuredContent?.code === 'PROJECT_NOT_ATTACHED',
      `stale offline callback code PROJECT_NOT_ATTACHED (got ${response.result.structuredContent?.code})`
    );

    await app.server.close();
  } finally {
    cleanup(root);
    cleanup(projectContainer);
  }
});

await runCase('attach_project returns structured stable error codes', async () => {
  const root = makeTempRoot();
  const outsideRoot = makeTempRoot();
  try {
    const workspaceProject = writeProject(join(root, 'WorkspaceProject'), 'WorkspaceProject');
    const outsideProject = writeProject(join(outsideRoot, 'OutsideProject'), 'OutsideProject');
    const { app, transport } = await createWireApp({ cwd: root, workspaceRoots: [workspaceProject.projectRoot] });
    await initialize(transport, {});

    const ambiguous = await callTool(transport, 'attach_project', {
      project_root: workspaceProject.projectRoot,
      uproject_path: workspaceProject.uprojectPath,
    });
    t.assert(ambiguous.result.isError === true, 'ambiguous attach returns isError');
    t.assert(ambiguous.result.structuredContent.code === 'PROJECT_AMBIGUOUS', `ambiguous attach code stable (got ${ambiguous.result.structuredContent.code})`);

    const invalid = await callTool(transport, 'attach_project', {
      uproject_path: join(root, 'Missing', 'Missing.uproject'),
    });
    t.assert(invalid.result.isError === true, 'invalid attach returns isError');
    t.assert(invalid.result.structuredContent.code === 'PROJECT_PATH_INVALID', `invalid attach code stable (got ${invalid.result.structuredContent.code})`);

    const outside = await callTool(transport, 'attach_project', {
      uproject_path: outsideProject.uprojectPath,
    });
    t.assert(outside.result.isError === true, 'outside-root attach returns isError');
    t.assert(outside.result.structuredContent.code === 'PROJECT_OUTSIDE_CLIENT_ROOT', `outside attach code stable (got ${outside.result.structuredContent.code})`);

    await app.server.close();
  } finally {
    cleanup(root);
    cleanup(outsideRoot);
  }
});

await runCase('list_project_targets reports absent empty valid and partially_invalid', async () => {
  const cwd = makeTempRoot();
  const repoAbsent = makeTempRoot();
  const repoEmpty = makeTempRoot();
  const repoValid = makeTempRoot();
  const repoPartial = makeTempRoot();
  try {
    const validProject = writeProject(join(repoValid, 'ValidProject'), 'ValidProject');
    const partialProject = writeProject(join(repoPartial, 'PartialProject'), 'PartialProject');
    writeFileSync(join(repoEmpty, '.uemcp-targets.txt'), '\n# empty\n', 'utf8');
    writeFileSync(join(repoValid, '.uemcp-targets.txt'), `${validProject.uprojectPath}\n`, 'utf8');
    writeFileSync(join(repoPartial, '.uemcp-targets.txt'), `${partialProject.uprojectPath}\n${join(repoPartial, 'Missing.uproject')}\n`, 'utf8');

    for (const [repoRoot, expected] of [
      [repoAbsent, 'absent'],
      [repoEmpty, 'empty'],
      [repoValid, 'valid'],
      [repoPartial, 'partially_invalid'],
    ]) {
      const { app, transport } = await createWireApp({ cwd, repoRoot });
      await initialize(transport, {});
      const response = await callTool(transport, 'list_project_targets', {});
      const targets = response.result.structuredContent.targets;
      t.assert(targets.status === expected, `targets status ${expected} (got ${targets.status})`);
      if (expected === 'partially_invalid') {
        t.assert(
          targets.invalidEntries.some(entry => entry.code === 'TARGET_ENTRY_INVALID'),
          'partially_invalid reports TARGET_ENTRY_INVALID'
        );
      }
      await app.server.close();
    }
  } finally {
    cleanup(cwd);
    cleanup(repoAbsent);
    cleanup(repoEmpty);
    cleanup(repoValid);
    cleanup(repoPartial);
  }
});

await runCase('list_project_targets selects structured profile', async () => {
  const cwd = makeTempRoot();
  const repoRoot = makeTempRoot();
  try {
    const primary = writeProject(join(repoRoot, 'PrimaryProject'), 'PrimaryProject');
    const secondary = writeProject(join(repoRoot, 'SecondaryProject'), 'SecondaryProject');
    writeFileSync(join(repoRoot, '.uemcp-targets.json'), `${JSON.stringify({
      version: 1,
      profiles: {
        default: ['primary'],
        smoke: ['secondary'],
      },
      targets: {
        primary: { uproject: primary.uprojectPath },
        secondary: { uproject: secondary.uprojectPath },
      },
    }, null, 2)}\n`, 'utf8');

    const { app, transport } = await createWireApp({ cwd, repoRoot });
    await initialize(transport, {});
    const response = await callTool(transport, 'list_project_targets', { profile: 'smoke' });
    const targets = response.result.structuredContent.targets;
    t.assert(targets.status === 'valid', `profile targets valid (got ${targets.status})`);
    t.assert(targets.profile.name === 'smoke', `profile name smoke (got ${targets.profile.name})`);
    t.assert(targets.candidates.length === 1, `profile selected one target (got ${targets.candidates.length})`);
    t.assert(targets.candidates[0].projectName === 'SecondaryProject', `profile selected secondary project (got ${targets.candidates[0]?.projectName})`);
    t.assert(!targets.entries.includes(primary.uprojectPath), 'profile selection excludes default-only target');
    await app.server.close();
  } finally {
    cleanup(cwd);
    cleanup(repoRoot);
  }
});

await runCase('attach_project target_profile is visible in connection_info', async () => {
  const cwd = makeTempRoot();
  const repoRoot = makeTempRoot();
  try {
    const primary = writeProject(join(repoRoot, 'PrimaryProject'), 'PrimaryProject');
    const secondary = writeProject(join(repoRoot, 'SecondaryProject'), 'SecondaryProject');
    writeFileSync(join(repoRoot, '.uemcp-targets.json'), `${JSON.stringify({
      version: 1,
      profiles: {
        default: ['primary'],
        smoke: ['secondary'],
      },
      targets: {
        primary: { uproject: primary.uprojectPath },
        secondary: { uproject: secondary.uprojectPath },
      },
    }, null, 2)}\n`, 'utf8');

    const { app, transport } = await createWireApp({ cwd, repoRoot });
    await initialize(transport, {});
    const attach = await callTool(transport, 'attach_project', { target: 'secondary', target_profile: 'smoke' });
    t.assert(!attach.result.isError, `profile target attach succeeds (got isError=${attach.result.isError})`);

    const info = parseTextResult(await callTool(transport, 'connection_info', {}));
    t.assert(info.targetAttachment.profile === 'smoke', `connection_info target profile is smoke (got ${info.targetAttachment?.profile})`);
    t.assert(info.targetAttachment.alias === 'secondary', `connection_info target alias is secondary (got ${info.targetAttachment?.alias})`);
    t.assert(info.targetAttachment.requestedTarget === 'secondary', `connection_info requested target is secondary (got ${info.targetAttachment?.requestedTarget})`);
    t.assert(info.targetAttachment.sourceType === 'json', `connection_info target source type is json (got ${info.targetAttachment?.sourceType})`);
    t.assert(info.targetAttachment.targetsPath.endsWith('.uemcp-targets.json'), `connection_info target config path points to json (got ${info.targetAttachment?.targetsPath})`);
    t.assert(
      info.projectContext.identity.targetAttachment.profile === 'smoke',
      `project context identity carries target profile (got ${info.projectContext.identity.targetAttachment?.profile})`,
    );
    await app.server.close();
  } finally {
    cleanup(cwd);
    cleanup(repoRoot);
  }
});

await runCase('project hygiene does not write for unresolved candidate listing', async () => {
  const root = makeTempRoot();
  const repoRoot = makeTempRoot();
  try {
    const one = writeProject(join(root, 'One'), 'One');
    const two = writeProject(join(root, 'Two'), 'Two');
    const { app, transport } = await createWireApp({ cwd: root, repoRoot, writeProjectCodenames: true });
    await initialize(transport, { roots: { listChanged: true } });
    await transport.sendClientNotification('notifications/initialized');
    await transport.respondToServerRequest('roots/list', {
      roots: [
        { uri: pathToFileURL(one.projectRoot).href, name: 'One' },
        { uri: pathToFileURL(two.projectRoot).href, name: 'Two' },
      ],
    });
    await new Promise(resolve => setImmediate(resolve));

    const targetsPath = join(repoRoot, '.git', 'info', 'known-test-targets.txt');
    t.assert(!existsSync(targetsPath), 'ambiguous candidate listing does not write known-test-targets');

    await app.server.close();
  } finally {
    cleanup(root);
    cleanup(repoRoot);
  }
});

await runCase('project hygiene writes after successful attachment', async () => {
  const root = makeTempRoot();
  const repoRoot = makeTempRoot();
  try {
    const project = writeProject(join(root, 'HygieneProject'), 'HygieneProject');
    const { app, transport } = await createWireApp({ cwd: root, repoRoot, writeProjectCodenames: true });
    await initialize(transport, {});
    await callTool(transport, 'attach_project', { uproject_path: project.uprojectPath });

    const targetsPath = join(repoRoot, '.git', 'info', 'known-test-targets.txt');
    const text = readFileSync(targetsPath, 'utf8');
    t.assert(/HygieneProject/.test(text), 'successful attachment writes project codename');

    await app.server.close();
  } finally {
    cleanup(root);
    cleanup(repoRoot);
  }
});

await runCase('detect_project reports no editor as EDITOR_UNAVAILABLE without attaching', async () => {
  const root = makeTempRoot();
  try {
    const { app, transport } = await createWireApp({
      cwd: root,
      processInspector: () => [],
    });
    await initialize(transport, {});

    const response = await callTool(transport, 'detect_project', {});
    const payload = response.result.structuredContent;
    t.assert(payload.editor.code === 'EDITOR_UNAVAILABLE', `no-editor code EDITOR_UNAVAILABLE (got ${payload.editor.code})`);
    t.assert(payload.projectContext.attachmentState === 'unresolved', `detect_project does not attach (got ${payload.projectContext.attachmentState})`);
    t.assert(payload.projectContext.editorIdentityState === 'unavailable', `editor state unavailable (got ${payload.projectContext.editorIdentityState})`);

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('detect_project reports command-line denied as EDITOR_IDENTITY_UNKNOWN', async () => {
  const root = makeTempRoot();
  try {
    const { app, transport } = await createWireApp({
      cwd: root,
      processInspector: () => [{ pid: 2468, cmdLine: '', commandLineAvailable: false, uprojectPath: null }],
    });
    await initialize(transport, {});

    const response = await callTool(transport, 'detect_project', {});
    const payload = response.result.structuredContent;
    t.assert(payload.editor.code === 'EDITOR_IDENTITY_UNKNOWN', `unknown editor code stable (got ${payload.editor.code})`);
    t.assert(payload.editor.candidates[0].pid === 2468, 'unknown editor candidate pid is reported');
    t.assert(payload.projectContext.editorIdentityState === 'unknown', `projectContext editor state unknown (got ${payload.projectContext.editorIdentityState})`);

    await app.server.close();
  } finally {
    cleanup(root);
  }
});

await runCase('detect_project reports multiple same-name editors as distinct candidates', async () => {
  const root = makeTempRoot();
  const firstRoot = makeTempRoot();
  const secondRoot = makeTempRoot();
  try {
    const first = writeProject(join(firstRoot, 'SharedName'), 'SharedName');
    const second = writeProject(join(secondRoot, 'SharedName'), 'SharedName');
    const { app, transport } = await createWireApp({
      cwd: root,
      processInspector: () => [
        { pid: 1111, cmdLine: `UnrealEditor.exe "${first.uprojectPath}"`, commandLineAvailable: true, uprojectPath: first.uprojectPath },
        { pid: 2222, cmdLine: `UnrealEditor.exe "${second.uprojectPath}"`, commandLineAvailable: true, uprojectPath: second.uprojectPath },
      ],
    });
    await initialize(transport, {});

    const response = await callTool(transport, 'detect_project', {});
    const payload = response.result.structuredContent;
    t.assert(payload.editor.candidates.length === 2, `two editor candidates reported (got ${payload.editor.candidates.length})`);
    t.assert(payload.editor.candidates[0].canonicalUprojectPath !== payload.editor.candidates[1].canonicalUprojectPath, 'same-name editor projects remain path-distinct');
    t.assert(!payload.editor.project, `detect_project does not select first editor project (got ${payload.editor.project})`);
    t.assert(payload.projectContext.attachmentState === 'unresolved', 'detect_project remains candidate-only');

    await app.server.close();
  } finally {
    cleanup(root);
    cleanup(firstRoot);
    cleanup(secondRoot);
  }
});

await runCase('connection_info force_reconnect verifies attached editor by full uproject path', async () => {
  const root = makeTempRoot();
  const projectRoot = makeTempRoot();
  try {
    const project = writeProject(join(projectRoot, 'ReadyProject'), 'ReadyProject');
    const { app, transport } = await createWireApp({
      cwd: root,
      processInspector: () => [
        { pid: 3333, cmdLine: `UnrealEditor.exe "${project.uprojectPath}"`, commandLineAvailable: true, uprojectPath: project.uprojectPath },
      ],
      tcpCommandFn: async () => ({ status: 'success', result: {} }),
      httpCommandFn: async () => ({ status: 'success', result: {} }),
    });
    await initialize(transport, {});
    await callTool(transport, 'attach_project', { uproject_path: project.uprojectPath });

    const response = await callTool(transport, 'connection_info', { force_reconnect: true });
    const payload = response.result.structuredContent;
    t.assert(payload.editor.state === 'verified', `editor state verified (got ${payload.editor.state})`);
    t.assert(payload.readiness.editorIdentity === 'verified', `readiness editorIdentity verified (got ${payload.readiness.editorIdentity})`);
    t.assert(payload.projectContext.editorIdentityState === 'verified', `projectContext editor state verified (got ${payload.projectContext.editorIdentityState})`);

    await app.server.close();
  } finally {
    cleanup(root);
    cleanup(projectRoot);
  }
});

await runCase('connection_info plugin handshake identity wins over process inspection', async () => {
  const root = makeTempRoot();
  const attachedRoot = makeTempRoot();
  const otherRoot = makeTempRoot();
  try {
    const attached = writeProject(join(attachedRoot, 'HandshakeProject'), 'HandshakeProject');
    const other = writeProject(join(otherRoot, 'HandshakeProject'), 'HandshakeProject');
    const tcpCalls = [];
    const { app, transport } = await createWireApp({
      cwd: root,
      processInspector: () => [
        { pid: 4444, cmdLine: `UnrealEditor.exe "${other.uprojectPath}"`, commandLineAvailable: true, uprojectPath: other.uprojectPath },
      ],
      tcpCommandFn: async (port, type) => {
        tcpCalls.push(type);
        if (type === 'get_editor_state') {
          return {
            status: 'success',
            result: {
              project_root: attached.projectRoot,
              uproject_path: attached.uprojectPath,
              project_name: attached.name,
              plugin_version: 2,
              plugin_version_name: '0.1.0',
              deploy_marker_present: false,
            },
          };
        }
        return { status: 'success', result: {} };
      },
      httpCommandFn: async () => ({ status: 'success', result: {} }),
    });
    await initialize(transport, {});
    await callTool(transport, 'attach_project', { uproject_path: attached.uprojectPath });

    const response = await callTool(transport, 'connection_info', { force_reconnect: true });
    const payload = response.result.structuredContent;
    t.assert(tcpCalls.includes('get_editor_state'), 'connection_info queried plugin get_editor_state');
    t.assert(payload.editor.source === 'plugin_handshake', `editor source plugin_handshake (got ${payload.editor.source})`);
    t.assert(payload.editor.state === 'verified', `plugin handshake verifies attached project (got ${payload.editor.state})`);
    t.assert(payload.readiness.transportOwnership === 'verified', `transport ownership verified (got ${payload.readiness.transportOwnership})`);

    await app.server.close();
  } finally {
    cleanup(root);
    cleanup(attachedRoot);
    cleanup(otherRoot);
  }
});

await runCase('connection_info force_reconnect reports stale deploy freshness', async () => {
  const root = makeTempRoot();
  const projectRoot = makeTempRoot();
  try {
    const project = writeProject(join(projectRoot, 'DeployStaleProject'), 'DeployStaleProject');
    const { app, transport } = await createWireApp({
      cwd: root,
      deployInspector: () => ({
        state: 'stale',
        code: 'DEPLOY_STALE',
        message: 'Plugin deploy marker does not match the attached repository build.',
      }),
      tcpCommandFn: async (port, type) => {
        if (type === 'get_editor_state') {
          return {
            status: 'success',
            result: {
              project_root: project.projectRoot,
              uproject_path: project.uprojectPath,
              project_name: project.name,
              deploy_marker_present: true,
            },
          };
        }
        return { status: 'success', result: {} };
      },
      httpCommandFn: async () => ({ status: 'success', result: {} }),
    });
    await initialize(transport, {});
    await callTool(transport, 'attach_project', { uproject_path: project.uprojectPath });

    const response = await callTool(transport, 'connection_info', { force_reconnect: true });
    const payload = response.result.structuredContent;
    t.assert(payload.deploy.code === 'DEPLOY_STALE', `deploy diagnostic code DEPLOY_STALE (got ${payload.deploy.code})`);
    t.assert(payload.readiness.deployFreshness === 'stale', `readiness deployFreshness stale (got ${payload.readiness.deployFreshness})`);
    t.assert(payload.projectContext.deployFreshnessState === 'stale', `projectContext deployFreshnessState stale (got ${payload.projectContext.deployFreshnessState})`);

    await app.server.close();
  } finally {
    cleanup(root);
    cleanup(projectRoot);
  }
});

process.exit(t.summary());
