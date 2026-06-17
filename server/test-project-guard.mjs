// ProjectContext guard and generation policy tests.
//
// Run: cd server && node test-project-guard.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectContext, withProjectContextGuard } from './project-context.mjs';
import { TOOL_REQUIREMENT_KINDS } from './tool-requirements.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Project Guard Tests');

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'uemcp-project-guard-'));
}

function cleanup(dir) {
  const norm = dir.replace(/\\/g, '/');
  const tmp = tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm.startsWith(`${tmp}/uemcp-project-guard-`)) {
    throw new Error(`refusing to clean unexpected temp path: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function writeProject(root, name) {
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, 'Content'), { recursive: true });
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

// Unresolved project-scoped reads return structured PROJECT_NOT_ATTACHED.
{
  const root = makeTempRoot();
  try {
    const ctx = new ProjectContext({ cwd: root, repoRoot: root, env: {} });
    const result = await withProjectContextGuard(
      ctx,
      { requirement: TOOL_REQUIREMENT_KINDS.OFFLINE_READ, toolName: 'project_info' },
      async () => ({ content: [{ type: 'text', text: 'should not run' }] })
    );
    t.assert(result.isError === true, 'unresolved guard returns isError');
    t.assert(result.structuredContent.code === 'PROJECT_NOT_ATTACHED', `unresolved guard code PROJECT_NOT_ATTACHED (got ${result.structuredContent.code})`);
  } finally {
    cleanup(root);
  }
}

// Attached offline reads receive stable generation and identity.
{
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'GuardProject'), 'GuardProject');
    const ctx = new ProjectContext({ cwd: root, repoRoot: root, workspaceRoots: [project.projectRoot], env: {} });
    await ctx.initializeFromProcessHints();

    const result = await withProjectContextGuard(
      ctx,
      { requirement: TOOL_REQUIREMENT_KINDS.OFFLINE_READ, toolName: 'project_info' },
      async ({ generation, identity }) => ({
        content: [{ type: 'text', text: JSON.stringify({ generation, projectName: identity.projectName }) }],
      })
    );
    const payload = JSON.parse(result.content[0].text);
    t.assert(payload.generation === ctx.generation, `guard passes current generation (got ${payload.generation})`);
    t.assert(payload.projectName === 'GuardProject', 'guard passes attached identity');
  } finally {
    cleanup(root);
  }
}

// Generation changes during a guarded read return PROJECT_CONTEXT_CHANGED.
{
  const root = makeTempRoot();
  try {
    const one = writeProject(join(root, 'One'), 'One');
    const two = writeProject(join(root, 'Two'), 'Two');
    const ctx = new ProjectContext({ cwd: root, repoRoot: root, workspaceRoots: [one.projectRoot], env: {} });
    await ctx.initializeFromProcessHints();

    const result = await withProjectContextGuard(
      ctx,
      { requirement: TOOL_REQUIREMENT_KINDS.OFFLINE_READ, toolName: 'project_info' },
      async () => {
        await ctx.attachProject({ uproject_path: two.uprojectPath, allow_outside_client_roots: true });
        return { content: [{ type: 'text', text: 'stale' }] };
      }
    );
    t.assert(result.isError === true, 'stale generation returns isError');
    t.assert(result.structuredContent.code === 'PROJECT_CONTEXT_CHANGED', `stale generation code PROJECT_CONTEXT_CHANGED (got ${result.structuredContent.code})`);
    t.assert(result.structuredContent.detailCode === 'GENERATION_STALE', 'stale generation detail code is GENERATION_STALE');
  } finally {
    cleanup(root);
  }
}

// Live reads are blocked until editor identity is verified.
{
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'LiveProject'), 'LiveProject');
    const ctx = new ProjectContext({ cwd: root, repoRoot: root, workspaceRoots: [project.projectRoot], env: {} });
    await ctx.initializeFromProcessHints();

    const result = await withProjectContextGuard(
      ctx,
      { requirement: TOOL_REQUIREMENT_KINDS.LIVE_READ, toolName: 'get_editor_state' },
      async () => ({ content: [{ type: 'text', text: 'should not run' }] })
    );
    t.assert(result.isError === true, 'live read without editor identity returns isError');
    t.assert(result.structuredContent.code === 'EDITOR_IDENTITY_UNKNOWN', `live read code EDITOR_IDENTITY_UNKNOWN (got ${result.structuredContent.code})`);
  } finally {
    cleanup(root);
  }
}

// Known-stale deploy state blocks live mutations even after editor ownership is verified.
{
  const root = makeTempRoot();
  try {
    const project = writeProject(join(root, 'StaleDeployProject'), 'StaleDeployProject');
    const ctx = new ProjectContext({ cwd: root, repoRoot: root, workspaceRoots: [project.projectRoot], env: {} });
    await ctx.initializeFromProcessHints();
    ctx.refreshEditorHandshake({
      result: {
        project_root: project.projectRoot,
        uproject_path: project.uprojectPath,
        project_name: 'StaleDeployProject',
      },
    });
    ctx.setDeployReadiness({
      state: 'stale',
      code: 'DEPLOY_STALE',
      message: 'Plugin deploy marker does not match the attached repository build.',
    });

    const result = await withProjectContextGuard(
      ctx,
      { requirement: TOOL_REQUIREMENT_KINDS.LIVE_MUTATION, toolName: 'spawn_actor' },
      async () => ({ content: [{ type: 'text', text: 'should not run' }] })
    );
    t.assert(result.isError === true, 'stale deploy blocks live mutation');
    t.assert(result.structuredContent.code === 'DEPLOY_STALE', `stale deploy code DEPLOY_STALE (got ${result.structuredContent.code})`);
  } finally {
    cleanup(root);
  }
}

// Changing the attached project invalidates editor ownership and deploy freshness.
{
  const root = makeTempRoot();
  try {
    const first = writeProject(join(root, 'FirstProject'), 'FirstProject');
    const second = writeProject(join(root, 'SecondProject'), 'SecondProject');
    const ctx = new ProjectContext({ cwd: root, repoRoot: root, workspaceRoots: [first.projectRoot], env: {} });
    await ctx.initializeFromProcessHints();
    ctx.refreshEditorHandshake({
      result: {
        project_root: first.projectRoot,
        uproject_path: first.uprojectPath,
        project_name: 'FirstProject',
      },
    });
    ctx.setDeployReadiness({ state: 'fresh' });

    await ctx.attachProject({
      uproject_path: second.uprojectPath,
      allow_outside_client_roots: true,
    });

    const snap = ctx.snapshot();
    t.assert(snap.editorIdentityState === 'not_checked', `editor identity reset on project change (got ${snap.editorIdentityState})`);
    t.assert(snap.transportOwnershipState === 'not_checked', `transport ownership reset on project change (got ${snap.transportOwnershipState})`);
    t.assert(snap.deployFreshnessState === 'not_checked', `deploy freshness reset on project change (got ${snap.deployFreshnessState})`);
  } finally {
    cleanup(root);
  }
}

// In-flight mutation blocks attach/detach unless force_generation_change is set.
{
  const root = makeTempRoot();
  try {
    const one = writeProject(join(root, 'One'), 'One');
    const two = writeProject(join(root, 'Two'), 'Two');
    const ctx = new ProjectContext({ cwd: root, repoRoot: root, workspaceRoots: [one.projectRoot], env: {} });
    await ctx.initializeFromProcessHints();

    const mutationId = ctx.beginMutation({ toolName: 'fake_mutator' });
    await expectRejectCode(
      () => ctx.attachProject({ uproject_path: two.uprojectPath, allow_outside_client_roots: true }),
      'IN_FLIGHT_MUTATION_BLOCKED',
      'attach blocks with mutation in flight',
    );
    await expectRejectCode(
      () => ctx.detachProject(),
      'IN_FLIGHT_MUTATION_BLOCKED',
      'detach blocks with mutation in flight',
    );

    await ctx.attachProject({
      uproject_path: two.uprojectPath,
      allow_outside_client_roots: true,
      force_generation_change: true,
    });
    t.assert(ctx.snapshot().warnings.some(w => w.code === 'IN_FLIGHT_MUTATION_BLOCKED'), 'forced attach records mutation warning');

    await ctx.detachProject({ force_generation_change: true });
    const forcedDetachWarnings = ctx.snapshot().warnings.filter(w => w.code === 'IN_FLIGHT_MUTATION_BLOCKED');
    t.assert(forcedDetachWarnings.length >= 2, 'forced detach records mutation warning');

    ctx.endMutation(mutationId);
    t.assert(ctx.getInFlightMutationCount() === 0, 'mutation count returns to zero');
  } finally {
    cleanup(root);
  }
}

process.exit(t.summary());
