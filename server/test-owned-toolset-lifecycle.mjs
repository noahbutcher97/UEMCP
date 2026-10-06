// Owned plumbing witnesses for phase1 P1-P4. Existing consumer tests stay intact.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionManager } from './connection-manager.mjs';
import { ProjectContext } from './project-context.mjs';
import { ToolIndex } from './tool-index.mjs';
import { ToolsetManager } from './toolset-manager.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const t = new TestRunner('Owned offline toolset lifecycle');
const prefix = 'uemcp-owned-toolset-';
const display = value => value.replace(/\\/g, '/');
const emptyEnable = { enabled: [], alreadyEnabled: [], unavailable: [], unknown: [], blocked: [] };
const offlineSentinels = ['project_info', 'list_gameplay_tags', 'list_plugins'];

async function withFixture(run) {
  const scratch = createCanonicalScratchRoot(prefix);
  try {
    const workspace = join(scratch, 'empty-workspace');
    const root = join(scratch, 'owned');
    const descriptor = join(root, 'OwnedToolsetLifecycle.uproject');
    mkdirSync(workspace);
    mkdirSync(join(root, 'Content'), { recursive: true });
    // Authored input: a project descriptor and Content directory are sufficient
    // for this lifecycle. No installed project, native asset or env root is read.
    const probes = [];
    const down = layer => async (...args) => {
      probes.push({ layer, args });
      throw Object.assign(new Error('Owned test transport is unavailable'), { code: 'ECONNREFUSED' });
    };
    const cm = new ConnectionManager({ projectRoot: '', tcpPortCustom: 55558, rcPort: 30010,
      tcpTimeoutMs: 50, httpTimeoutMs: 50, tcpCommandFn: down('tcp'), httpCommandFn: down('http') });
    const context = new ProjectContext({ cwd: workspace, repoRoot: workspace, env: {}, workspaceRoots: [scratch] });
    const index = new ToolIndex();
    let notifications = 0;
    const manager = new ToolsetManager(cm, index, { sendToolListChanged: () => { notifications++; } });
    await manager.load();
    const handles = new Map();
    for (const toolset of index.getToolsetNames()) {
      for (const { toolName } of index.getToolsetTools(toolset)) {
        const handle = { enabled: false, enable() { this.enabled = true; }, disable() { this.enabled = false; } };
        handles.set(toolName, { toolset, handle });
        manager.registerToolHandle(toolName, handle);
      }
    }
    let applied;
    // The explicit manager synchronization exercised here matches the production
    // reset callback. Actual server/MCP attachment is retained in project-wire.
    context.onReset(async () => {
      cm.setAttachedProject(context.identity);
      cm.resetProjectScopedState({ generation: context.generation });
      if (context.identity) await cm.checkOfflineAvailable(context.identity.projectRoot);
      applied = await manager.applyProjectContext(context.snapshot());
    });
    await context.initializeFromProcessHints();
    // Author only after unresolved initialization, so admitted client roots do
    // not auto-attach this project before the explicit attach witness.
    writeFileSync(descriptor, '{"FileVersion":3,"EngineAssociation":"5.6","Modules":[],"Plugins":[]}\n');
    const f = { scratch, workspace, root, descriptor, context, cm, manager, handles, probes,
      get notifications() { return notifications; }, get applied() { return applied; },
      attach: () => context.attachProject({ uproject_path: descriptor }),
      view: () => ({ snapshot: context.snapshot(), root: cm.getAttachedProjectRoot(),
        enabled: manager.getEnabledNames().sort(), visible: [...handles].filter(([, row]) => row.handle.enabled).map(([name]) => name).sort() }),
    };
    await run(f);
  } finally {
    cleanupCanonicalScratchRoot(scratch, prefix);
  }
}

function assertAttached(view, f, enabled, generation = 1) {
  assert.equal(view.snapshot.attachmentState, 'attached');
  assert.equal(view.snapshot.generation, generation);
  assert.equal(view.snapshot.identity.projectName, 'OwnedToolsetLifecycle');
  assert.equal(view.snapshot.identity.uprojectPath, display(f.descriptor));
  assert.equal(view.snapshot.identity.canonicalUprojectPath, display(f.descriptor).toLowerCase());
  assert.equal(view.snapshot.identity.projectRoot, display(f.root));
  assert.equal(display(view.root), display(f.root));
  assert.deepEqual(view.enabled, enabled ? ['offline'] : []);
  // Pin authored sentinels so an empty/drifted index cannot make visibility
  // assertions vacuously pass; also inspect every registered offline handle.
  for (const name of offlineSentinels) assert.equal(f.handles.get(name)?.toolset, 'offline');
  const expectedVisible = enabled ? [...f.handles].filter(([, row]) => row.toolset === 'offline').map(([name]) => name).sort() : [];
  assert.deepEqual(view.visible, expectedVisible);
}
async function check(name, run) {
  try { await withFixture(run); t.assert(true, `owned toolset: ${name}`); }
  catch (error) { t.assert(false, `owned toolset: ${name}`, error.stack); }
}

await check('load stays unresolved and manual offline enable is rejected', async f => {
  assert.equal(f.context.identity, null); assert.equal(f.context.generation, 0);
  assert.deepEqual(f.view().enabled, []); assert.deepEqual(f.view().visible, []);
  const result = await f.manager.enable(['offline']);
  assert.deepEqual(result, { ...emptyEnable, unavailable: ['offline'], blocked: [{ toolset: 'offline', code: 'PROJECT_NOT_ATTACHED', message: 'No Unreal project is attached for this UEMCP session.' }] });
  assert.equal(f.notifications, 0); assert.equal(f.probes.length, 0);
});
await check('available configured root cannot bypass unresolved attachment', async f => {
  assert.equal(await f.cm.checkOfflineAvailable(f.root), true);
  const result = await f.manager.enable(['offline']);
  assert.equal(result.blocked[0].code, 'PROJECT_NOT_ATTACHED');
  assert.deepEqual(result.enabled, []); assert.equal(f.context.identity, null);
  assert.deepEqual(f.view().visible, []);
});
await check('owned attachment enables offline handles with exact identity and generation', async f => {
  await f.attach(); assertAttached(f.view(), f, true);
  assert.deepEqual(f.applied.enabled, ['offline']); assert.deepEqual(f.applied.unavailable, []);
  assert.equal(f.notifications, 1);
});
await check('disable hides offline while preserving attached identity and generation', async f => {
  await f.attach(); const before = f.context.snapshot();
  assert.deepEqual(f.manager.disable(['offline']), { disabled: ['offline'], wasNotEnabled: [], unknown: [] });
  assertAttached(f.view(), f, false); assert.deepEqual(f.context.snapshot(), before);
  assert.equal(await f.cm.isLayerAvailable('offline'), true); assert.equal(f.notifications, 2);
});
await check('re-enable restores offline while preserving attached identity and generation', async f => {
  await f.attach(); f.manager.disable(['offline']); const before = f.context.snapshot();
  assert.deepEqual(await f.manager.enable(['offline']), { ...emptyEnable, enabled: ['offline'] });
  assertAttached(f.view(), f, true); assert.deepEqual(f.context.snapshot(), before); assert.equal(f.notifications, 3);
});
await check('complete unresolved attach disable re-enable cycle ends with only offline enabled', async f => {
  assert.equal((await f.manager.enable(['offline'])).blocked[0].code, 'PROJECT_NOT_ATTACHED');
  await f.attach(); assertAttached(f.view(), f, true);
  f.manager.disable(['offline']); assertAttached(f.view(), f, false);
  await f.manager.enable(['offline']); assertAttached(f.view(), f, true);
  assert.deepEqual(f.manager.getEnabledNames(), ['offline']); assert.equal(f.notifications, 3);
});
await check('repeated enable and disable are idempotent without extra notifications', async f => {
  await f.attach();
  assert.deepEqual(await f.manager.enable(['offline']), { ...emptyEnable, alreadyEnabled: ['offline'] });
  assert.equal(f.notifications, 1);
  f.manager.disable(['offline']);
  assert.deepEqual(f.manager.disable(['offline']), { disabled: [], wasNotEnabled: ['offline'], unknown: [] });
  assert.equal(f.notifications, 2); assertAttached(f.view(), f, false);
});
await check('live toolsets remain unavailable with explicit TCP and HTTP down stubs', async f => {
  await f.attach();
  const result = await f.manager.enable(['actors', 'gas']);
  assert.deepEqual(result, { ...emptyEnable, unavailable: ['actors', 'gas'] });
  assert.equal(await f.cm.isLayerAvailable('http-30010', true), false);
  assert.ok(f.probes.some(p => p.layer === 'tcp')); assert.ok(f.probes.some(p => p.layer === 'http'));
  assertAttached(f.view(), f, true);
});
for (const kind of ['missing path', 'directory without descriptor']) {
  await check(`${kind} stays unavailable and cannot attach`, async f => {
    const root = join(f.scratch, 'invalid');
    if (kind === 'directory without descriptor') mkdirSync(root);
    await assert.rejects(f.context.attachProject({ project_root: root }), { code: 'PROJECT_PATH_INVALID' });
    assert.equal(await f.cm.checkOfflineAvailable(root), false);
    const result = await f.manager.enable(['offline']);
    assert.deepEqual(result.enabled, []); assert.equal(result.blocked[0].code, 'PROJECT_NOT_ATTACHED');
    assert.equal(f.context.identity, null); assert.equal(f.context.generation, 0);
    assert.deepEqual(f.view().visible, []);
  });
}
await check('fresh availability check rejects a removed descriptor on re-enable', async f => {
  await f.attach(); f.manager.disable(['offline']); unlinkSync(f.descriptor);
  assert.equal(await f.cm.checkOfflineAvailable(f.root), false);
  assert.deepEqual(await f.manager.enable(['offline']), { ...emptyEnable, unavailable: ['offline'] });
  assertAttached(f.view(), f, false);
});
await check('invalid replacement attach preserves the valid enabled project', async f => {
  await f.attach(); const before = f.context.snapshot();
  await assert.rejects(f.context.attachProject({ project_root: join(f.scratch, 'absent') }), { code: 'PROJECT_PATH_INVALID' });
  assertAttached(f.view(), f, true); assert.deepEqual(f.context.snapshot(), before); assert.equal(f.notifications, 1);
});
await check('unresolved context application hides enabled tools and blocks re-enable', async f => {
  await f.attach();
  // Refresh to a known empty workspace; manual detach otherwise auto-resolves
  // the owned project beneath the admitted scratch client root.
  await f.context.refreshFromClientRoots({ roots: [f.workspace] });
  assert.equal(f.context.identity, null); assert.equal(f.context.generation, 2);
  assert.deepEqual(f.manager.getEnabledNames(), []); assert.deepEqual(f.view().visible, []);
  assert.equal(f.cm.getAttachedProjectRoot(), '');
  assert.equal((await f.manager.enable(['offline'])).blocked[0].code, 'PROJECT_NOT_ATTACHED');
});
for (const [name, corrupt] of [
  ['wrong identity', view => { view.snapshot.identity.projectName = 'OtherProject'; }],
  ['generation drift', view => { view.snapshot.generation++; }],
  ['missing enabled set', view => { view.enabled = []; }],
  ['hidden offline sentinel', view => { view.visible = view.visible.filter(name => name !== 'project_info'); }],
  ['wrong connection root', view => { view.root += '/other'; }],
]) {
  await check(`oracle rejects ${name}`, async f => {
    await f.attach(); const view = structuredClone(f.view()); assertAttached(view, f, true); corrupt(view);
    assert.throws(() => assertAttached(view, f, true), { name: 'AssertionError' });
  });
}
process.exitCode = t.summary();
