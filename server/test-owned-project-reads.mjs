// Authored text-fixture witnesses; broader consumer and protocol suites stay retained.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createUemcpServer } from './create-uemcp-server.mjs';
import { executeOfflineTool } from './offline-tools.mjs';
import { FakeMcpTransport } from './test-mcp-fake-transport.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const t = new TestRunner('Owned project reads and MCP wire');
const root = fileURLToPath(new URL('./fixtures/uemcp-fixture/', import.meta.url));
const hashes = {
  'UEMCPFixture.uproject': '167fdbaa823a966f23c697f2a0efffb43578bf834ca5eae94a6e8d39e4d17481',
  'Config/DefaultGameplayTags.ini': '11eac0c3272b752e18dbb41de20f0e6a6bb24ce8da50a1ddfd88b899c05c7a89',
  'Config/DefaultEngine.ini': '7c651ad2491cd42d99b6152c15a90917c9477eaedfd2e6ce591f75d6c29c0195',
};
// Literal expectations come from the committed authoring inputs, never another query.
const plugins = [
  { name: 'AndroidFileServer', enabled: false },
  { name: 'UEMCP', enabled: true },
  { name: 'RemoteControl', enabled: true },
  { name: 'PythonScriptPlugin', enabled: true },
];
const project = {
  projectName: 'UEMCPFixture', engineAssociation: '5.6', category: '',
  description: 'Generic NDA-safe fixture project for UEMCP offline-tool tests.',
  modules: [{ name: 'UEMCPFixture', type: 'Runtime', loadingPhase: 'Default' }],
  plugins, targetPlatforms: [],
};
const tagNames = ['Fixture.Combat.Block', 'Fixture.Combat.Parry', 'Fixture.State.Stunned', 'Audio.SFX.Footstep'];
const tagRows = names => names.map(tag => ({ tag, comment: 'synthetic fixture tag' }));
const leaf = () => ({ _children: {}, _comment: 'synthetic fixture tag' });
const tags = {
  totalTags: 4, tags: tagRows(tagNames),
  hierarchy: {
    Fixture: { _children: {
      Combat: { _children: { Block: leaf(), Parry: leaf() } },
      State: { _children: { Stunned: leaf() } },
    } },
    Audio: { _children: { SFX: { _children: { Footstep: leaf() } } } },
  },
};
const patterns = [
  ['**', tagNames], ['Fixture.**', tagNames.slice(0, 3)], ['Audio.**', ['Audio.SFX.Footstep']],
  ['Fixture.*', []], ['fixture.combat.*', ['Fixture.Combat.Block', 'Fixture.Combat.Parry']],
  ['MissingOwnedTag.**', []],
];
function verifyInputs() {
  for (const [path, expected] of Object.entries(hashes)) {
    const text = readFileSync(join(root, path), 'utf8').replace(/\r\n/g, '\n');
    assert.equal(createHash('sha256').update(text).digest('hex'), expected, path);
  }
}
const direct = (name, params = {}, projectRoot = root) => executeOfflineTool(name, params, projectRoot);
const assertProject = value => assert.deepEqual(value, project);
const assertTags = value => assert.deepEqual(value, tags);
const assertSearch = (value, pattern, names) => assert.deepEqual(value, {
  pattern, matches: tagRows(names), matchCount: names.length,
});
function textContent(response) {
  assert.equal(response.error, undefined, 'tool result, not JSON-RPC protocol failure');
  assert.ok(response.result && Array.isArray(response.result.content));
  assert.equal(response.result.content.length, 1);
  assert.equal(response.result.content[0].type, 'text');
  assert.equal(typeof response.result.content[0].text, 'string');
  return response.result.content[0].text;
}
function success(response) {
  const text = textContent(response);
  assert.notEqual(response.result.isError, true, 'success envelope required before JSON parsing');
  return JSON.parse(text);
}
function failure(response, diagnostic) {
  const text = textContent(response);
  assert.equal(response.result.isError, true);
  assert.match(text, diagnostic);
  return text; // Error text is deliberately never parsed as JSON.
}
async function check(name, run) {
  try { await run(); t.assert(true, `owned reads: ${name}`); }
  catch (error) { t.assert(false, `owned reads: ${name}`, error.stack); }
}
async function withWire(projectRoot, run) {
  const cwd = createCanonicalScratchRoot('uemcp-owned-reads-cwd-');
  let app;
  try {
    app = await createUemcpServer({
      env: {}, cwd, workspaceRoots: [], writeProjectCodenames: false,
      tcpCommandFn: async () => ({ status: 'success' }),
      httpCommandFn: async () => ({ Presets: [] }), stderr: { write() {} },
    });
    const transport = new FakeMcpTransport();
    await app.start(transport);
    const initialized = await transport.sendClientRequest('initialize', {
      protocolVersion: '2024-11-05', capabilities: {},
      clientInfo: { name: 'owned-project-reads', version: '1.0' },
    });
    assert.ok(initialized.result?.capabilities.tools);
    // Await the real initialized handler rather than timing an unobserved callback.
    const original = app.server.server.oninitialized;
    let resolve, reject;
    const done = new Promise((yes, no) => { resolve = yes; reject = no; });
    app.server.server.oninitialized = async () => {
      try { await original(); resolve(); } catch (error) { reject(error); }
    };
    let timer;
    const deadline = new Promise((_, no) => { timer = setTimeout(() => no(new Error('initialization did not settle')), 3000); });
    try {
      await transport.sendClientNotification('notifications/initialized');
      await Promise.race([done, deadline]);
    } finally { clearTimeout(timer); }
    const call = (name, args = {}) => transport.sendClientRequest('tools/call', { name, arguments: args });
    success(await call('attach_project', { uproject_path: join(projectRoot, 'UEMCPFixture.uproject') }));
    assert.equal(app.projectContext.snapshot().identity.projectName, 'UEMCPFixture');
    const listed = await transport.sendClientRequest('tools/list', {});
    for (const name of ['project_info', 'list_gameplay_tags', 'search_gameplay_tags', 'list_config_values']) {
      assert.ok(listed.result.tools.some(tool => tool.name === name), `${name} visible`);
    }
    await run(call);
  } finally {
    try { if (app) await app.server.close(); }
    finally { cleanupCanonicalScratchRoot(cwd, 'uemcp-owned-reads-cwd-'); }
  }
}

await check('authored text inputs match pinned normalized hashes', verifyInputs);
await check('direct project identity modules and declared plugins are exact', async () => assertProject(await direct('project_info')));
await check('direct tag count comments and hierarchy are exact', async () => assertTags(await direct('list_gameplay_tags')));
for (const [pattern, expected] of patterns) {
  await check(`direct glob ${pattern} has exact membership`, async () => assertSearch(await direct('search_gameplay_tags', { pattern }), pattern, expected));
}
await check('direct declared plugin enablement is distinct from local installation', async () => {
  assert.deepEqual(await direct('list_plugins'), { projectPlugins: plugins, localPlugins: [] });
});
await check('direct config section and selected values match authored inputs', async () => {
  const config_file = 'DefaultEngine.ini';
  const section = '/Script/EngineSettings.GeneralProjectSettings';
  assert.deepEqual(await direct('list_config_values', { config_file, section }), {
    section, keys: { ProjectName: ['UEMCPFixture'], ProjectVersion: ['1.0.0'] },
  });
  for (const [s, key, value] of [[section, 'ProjectName', 'UEMCPFixture'], ['/Script/Engine.Engine', 'bSmoothFrameRate', 'true'], ['Zen', 'AutoLaunch', 'false']]) {
    assert.deepEqual(await direct('list_config_values', { config_file, section: s, key }), { section: s, key, values: [value] });
  }
});
await check('direct absent config key returns an empty value array', async () => {
  const params = { config_file: 'DefaultEngine.ini', section: 'Zen', key: 'MissingOwnedKey' };
  assert.deepEqual(await direct('list_config_values', params), { section: 'Zen', key: params.key, values: [] });
});
await check('direct missing config file rejects rather than returning an empty success', async () => {
  await assert.rejects(() => direct('list_config_values', { config_file: 'MissingOwnedConfig.ini' }), { code: 'ENOENT' });
});
await check('direct missing root rejects project and tag reads', async () => {
  const absent = createCanonicalScratchRoot('uemcp-owned-reads-missing-');
  cleanupCanonicalScratchRoot(absent, 'uemcp-owned-reads-missing-');
  await assert.rejects(() => direct('project_info', {}, absent), { code: 'ENOENT' });
  await assert.rejects(() => direct('list_gameplay_tags', {}, absent), /Cannot read gameplay tags:/);
});
await check('wire real project handler returns the exact owned payload', () => withWire(root, async call => {
  assertProject(success(await call('project_info')));
}));
await check('wire real tag handler returns the exact owned hierarchy', () => withWire(root, async call => {
  assertTags(success(await call('list_gameplay_tags')));
}));
await check('wire real glob handler returns authored descendants and no-match control', () => withWire(root, async call => {
  for (const [pattern, expected] of patterns) assertSearch(success(await call('search_gameplay_tags', { pattern })), pattern, expected);
}));
await check('wire missing config produces an error envelope and the next request succeeds', () => withWire(root, async call => {
  failure(await call('list_config_values', { config_file: 'MissingOwnedConfig.ini' }), /^Error in list_config_values:.*ENOENT/);
  assertProject(success(await call('project_info')));
}));
await check('wire removed owned root produces project and tag error envelopes without a parse crash', async () => {
  const disposable = createCanonicalScratchRoot('uemcp-owned-reads-project-');
  try {
    copyFileSync(join(root, 'UEMCPFixture.uproject'), join(disposable, 'UEMCPFixture.uproject'));
    mkdirSync(join(disposable, 'Content'));
    await withWire(disposable, async call => {
      assertProject(success(await call('project_info')));
      cleanupCanonicalScratchRoot(disposable, 'uemcp-owned-reads-project-');
      failure(await call('project_info'), /^Error in project_info:.*ENOENT/);
      failure(await call('list_gameplay_tags'), /^Error in list_gameplay_tags: Cannot read gameplay tags:/);
      // Reattach the committed fixture to prove the transport still serves real reads.
      success(await call('attach_project', { uproject_path: join(root, 'UEMCPFixture.uproject') }));
      assertProject(success(await call('project_info')));
    });
  } finally { cleanupCanonicalScratchRoot(disposable, 'uemcp-owned-reads-project-'); }
});
await check('comparators reject wrong identity missing tags and incorrect glob membership', () => {
  const wrongProject = structuredClone(project); wrongProject.modules[0].name = 'ForeignModule';
  assert.throws(() => assertProject(wrongProject), assert.AssertionError);
  const wrongTags = structuredClone(tags); wrongTags.tags.pop();
  assert.throws(() => assertTags(wrongTags), assert.AssertionError);
  assert.throws(() => assertSearch({ pattern: 'Fixture.**', matches: tagRows(tagNames), matchCount: 4 }, 'Fixture.**', tagNames.slice(0, 3)), assert.AssertionError);
});
await check('wire success decoder rejects error and non-text envelopes before parsing', () => {
  assert.throws(() => success({ result: { isError: true, content: [{ type: 'text', text: 'Error in project_info: missing root' }] } }), assert.AssertionError);
  assert.throws(() => success({ result: { content: [{ type: 'image', text: '{}' }] } }), assert.AssertionError);
});
await check('authored text inputs remain unchanged after direct and wire reads', verifyInputs);
process.exitCode = t.summary() > 0 ? 1 : 0;
