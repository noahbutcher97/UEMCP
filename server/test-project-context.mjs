// ProjectContext core state-machine tests.
//
// Run: cd server && node test-project-context.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TestRunner } from './test-helpers.mjs';
import { ProjectContext } from './project-context.mjs';

const t = new TestRunner('ProjectContext Tests');

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'uemcp-project-context-'));
}

function cleanup(dir) {
  const norm = dir.replace(/\\/g, '/');
  const tmp = tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm.startsWith(`${tmp}/uemcp-project-context-`)) {
    throw new Error(`refusing to clean unexpected temp path: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function writeProject(root, name, extraDirs = ['Content']) {
  mkdirSync(root, { recursive: true });
  for (const dir of extraDirs) mkdirSync(join(root, dir), { recursive: true });
  const uprojectPath = join(root, `${name}.uproject`);
  writeFileSync(uprojectPath, '{"FileVersion":3}\n', 'utf8');
  return { projectRoot: root, uprojectPath };
}

async function expectRejectCode(fn, code, label) {
  try {
    await fn();
    t.assert(false, label, `expected ${code}`);
  } catch (err) {
    t.assert(err.code === code, `${label} (got ${err.code})`);
  }
}

// Default workspace mode records env as legacy metadata, not attachment authority.
{
  const root = makeTempRoot();
  const envRoot = makeTempRoot();
  try {
    const envProject = writeProject(join(envRoot, 'EnvProject'), 'EnvProject');
    const ctx = new ProjectContext({
      cwd: root,
      repoRoot: root,
      env: {
        UNREAL_PROJECT_ROOT: envProject.projectRoot,
        UNREAL_PROJECT_NAME: 'EnvProject',
      },
    });

    await ctx.initializeFromProcessHints();
    const snap = ctx.snapshot();
    t.assert(snap.attachMode === 'workspace', `default attach mode is workspace (got ${snap.attachMode})`);
    t.assert(snap.attachmentState === 'unresolved', `default env does not attach (got ${snap.attachmentState})`);
    t.assert(snap.legacyEnvCandidate.projectName === 'EnvProject', 'legacy env candidate is recorded');
    t.assert(snap.identity === null, 'identity remains null in default env mode');
    t.assert(snap.generation === 0, `metadata-only init does not increment generation (got ${snap.generation})`);
  } finally {
    cleanup(root);
    cleanup(envRoot);
  }
}

// Explicit env mode attaches after validation.
{
  const root = makeTempRoot();
  try {
    const envProject = writeProject(join(root, 'EnvProject'), 'EnvProject');
    const observedGenerations = [];
    const ctx = new ProjectContext({
      cwd: root,
      repoRoot: root,
      env: {
        UEMCP_PROJECT_ATTACH_MODE: 'env',
        UNREAL_PROJECT_ROOT: envProject.projectRoot,
      },
    });
    ctx.onReset(({ generation }) => observedGenerations.push(generation));

    await ctx.initializeFromProcessHints();
    const snap = ctx.snapshot();
    t.assert(snap.attachmentState === 'attached', `env mode attaches (got ${snap.attachmentState})`);
    t.assert(snap.identity.projectName === 'EnvProject', 'env mode identity is EnvProject');
    t.assert(snap.generation === 1, `env mode attach increments generation once (got ${snap.generation})`);
    t.assert(observedGenerations.length === 1 && observedGenerations[0] === 1, `reset observer sees generation 1 (${observedGenerations.join(',')})`);
  } finally {
    cleanup(root);
  }
}

// Invalid attach mode warns and falls back to workspace.
{
  const root = makeTempRoot();
  try {
    const ctx = new ProjectContext({
      cwd: root,
      repoRoot: root,
      env: { UEMCP_PROJECT_ATTACH_MODE: 'invalid-mode' },
    });
    await ctx.initializeFromProcessHints();
    const snap = ctx.snapshot();
    t.assert(snap.attachMode === 'workspace', `invalid attach mode falls back to workspace (got ${snap.attachMode})`);
    t.assert(snap.warnings.some(w => w.code === 'PROJECT_ATTACH_MODE_INVALID'), 'invalid attach mode warning is reported');
  } finally {
    cleanup(root);
  }
}

// Workspace auto-attach wins over conflicting legacy env, but reports the conflict.
{
  const root = makeTempRoot();
  try {
    const workspaceProject = writeProject(join(root, 'WorkspaceProject'), 'WorkspaceProject');
    const envProject = writeProject(join(root, 'EnvProject'), 'EnvProject');
    const ctx = new ProjectContext({
      cwd: root,
      repoRoot: root,
      workspaceRoots: [workspaceProject.projectRoot],
      env: { UNREAL_PROJECT_ROOT: envProject.projectRoot },
    });

    await ctx.initializeFromProcessHints();
    const snap = ctx.snapshot();
    t.assert(snap.attachmentState === 'auto_attached', `workspace topology auto-attaches (got ${snap.attachmentState})`);
    t.assert(snap.identity.projectName === 'WorkspaceProject', 'workspace project wins over legacy env');
    t.assert(snap.warnings.some(w => w.code === 'LEGACY_ENV_CONFLICT'), 'legacy env conflict warning is reported');
  } finally {
    cleanup(root);
  }
}

// Manual attach enforces exactly-one-source and outside-root policy.
{
  const root = makeTempRoot();
  try {
    const workspaceProject = writeProject(join(root, 'WorkspaceProject'), 'WorkspaceProject');
    const outsideProject = writeProject(join(root, 'OutsideContainer', 'OutsideProject'), 'OutsideProject');
    const ctx = new ProjectContext({
      cwd: root,
      repoRoot: root,
      workspaceRoots: [workspaceProject.projectRoot],
      env: {},
    });
    await ctx.initializeFromProcessHints();

    await expectRejectCode(
      () => ctx.attachProject({ project_root: workspaceProject.projectRoot, uproject_path: workspaceProject.uprojectPath }),
      'PROJECT_AMBIGUOUS',
      'attach_project rejects multiple input sources',
    );

    await expectRejectCode(
      () => ctx.attachProject({ uproject_path: outsideProject.uprojectPath }),
      'PROJECT_OUTSIDE_CLIENT_ROOT',
      'attach_project rejects outside-root path by default',
    );

    await ctx.attachProject({
      uproject_path: outsideProject.uprojectPath,
      allow_outside_client_roots: true,
    });
    const snap = ctx.snapshot();
    t.assert(snap.attachmentState === 'attached', `explicit outside attach succeeds with override (got ${snap.attachmentState})`);
    t.assert(snap.identity.projectName === 'OutsideProject', 'outside override attaches requested project');
    t.assert(snap.warnings.some(w => w.code === 'PROJECT_OUTSIDE_CLIENT_ROOT'), 'outside-root override warning is retained');
  } finally {
    cleanup(root);
  }
}

// Target aliases reject duplicate bare stems.
{
  const root = makeTempRoot();
  try {
    const one = writeProject(join(root, 'Alpha', 'Game'), 'Game');
    const two = writeProject(join(root, 'Beta', 'Game'), 'Game');
    writeFileSync(join(root, '.uemcp-targets.txt'), `${one.uprojectPath}\n${two.uprojectPath}\n`, 'utf8');
    const ctx = new ProjectContext({ cwd: root, repoRoot: root, workspaceRoots: [root], env: {} });
    await ctx.initializeFromProcessHints();

    await expectRejectCode(
      () => ctx.attachProject({ target: 'Game' }),
      'TARGET_ALIAS_AMBIGUOUS',
      'duplicate bare target alias rejects',
    );
  } finally {
    cleanup(root);
  }
}

// Structured target profiles can scope target alias attachment.
{
  const root = makeTempRoot();
  try {
    const primary = writeProject(join(root, 'PrimaryProject'), 'PrimaryProject');
    const secondary = writeProject(join(root, 'SecondaryProject'), 'SecondaryProject');
    writeFileSync(join(root, '.uemcp-targets.json'), `${JSON.stringify({
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

    const ctx = new ProjectContext({ cwd: root, repoRoot: root, workspaceRoots: [root], env: {} });
    await ctx.initializeFromProcessHints();
    await ctx.attachProject({ target: 'secondary', target_profile: 'smoke' });

    const snap = ctx.snapshot();
    t.assert(snap.attachmentState === 'attached', `profile target attach succeeds (got ${snap.attachmentState})`);
    t.assert(snap.identity.projectName === 'SecondaryProject', `profile target attached secondary project (got ${snap.identity?.projectName})`);
  } finally {
    cleanup(root);
  }
}

// Detach clears manual attachment and reruns workspace auto-resolution.
{
  const root = makeTempRoot();
  try {
    const workspaceProject = writeProject(join(root, 'WorkspaceProject'), 'WorkspaceProject');
    const outsideProject = writeProject(join(root, 'OutsideProject'), 'OutsideProject');
    const observed = [];
    const ctx = new ProjectContext({
      cwd: root,
      repoRoot: root,
      workspaceRoots: [workspaceProject.projectRoot],
      env: {},
    });
    ctx.onReset(({ generation, reason }) => observed.push({ generation, reason }));

    await ctx.initializeFromProcessHints();
    t.assert(ctx.snapshot().attachmentState === 'auto_attached', 'initial workspace auto-attach succeeds');

    await ctx.attachProject({
      uproject_path: outsideProject.uprojectPath,
      allow_outside_client_roots: true,
    });
    t.assert(ctx.snapshot().identity.projectName === 'OutsideProject', 'manual attach overrides workspace auto-attach');

    await ctx.detachProject();
    const snap = ctx.snapshot();
    t.assert(snap.attachmentState === 'auto_attached', `detach reruns workspace resolution (got ${snap.attachmentState})`);
    t.assert(snap.identity.projectName === 'WorkspaceProject', 'workspace auto-attachment restored after detach');
    t.assert(observed.length === 3, `three reset events observed (init auto, manual attach, detach auto) got ${observed.length}`);
    t.assert(observed.map(e => e.generation).join(',') === '1,2,3', `reset observers see exact generations (${observed.map(e => e.generation).join(',')})`);
  } finally {
    cleanup(root);
  }
}

const failed = t.summary();
process.exit(failed ? 1 : 0);
