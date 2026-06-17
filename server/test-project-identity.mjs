// Project identity and workspace-resolution tests.
//
// Run: cd server && node test-project-identity.mjs

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TestRunner } from './test-helpers.mjs';
import {
  decodeFileUriToLocalPath,
  findDirectUprojects,
  scanWorkspaceRoot,
  isInsidePath,
  createProjectIdentity,
} from './project-identity.mjs';

const t = new TestRunner('Project Identity Tests');

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'uemcp-project-identity-'));
}

function cleanup(dir) {
  const norm = dir.replace(/\\/g, '/');
  const tmp = tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm.startsWith(`${tmp}/uemcp-project-identity-`)) {
    throw new Error(`refusing to clean unexpected temp path: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

function writeProject(root, name, extraDirs = ['Content']) {
  mkdirSync(root, { recursive: true });
  for (const dir of extraDirs) mkdirSync(join(root, dir), { recursive: true });
  const uprojectPath = join(root, `${name}.uproject`);
  writeFileSync(uprojectPath, '{"FileVersion":3}\n', 'utf8');
  return uprojectPath;
}

// file:// roots decode percent escapes and reject non-local authorities.
{
  const decoded = decodeFileUriToLocalPath('file:///D:/Path%20With%20Space/Project.uproject').replace(/\\/g, '/');
  t.assert(decoded.endsWith('D:/Path With Space/Project.uproject'), 'file URI percent escapes decode to local path');

  try {
    decodeFileUriToLocalPath('file://server/share/Project.uproject');
    t.assert(false, 'non-local file URI authority is rejected');
  } catch (err) {
    t.assert(err.code === 'PROJECT_PATH_UNSUPPORTED', `non-local authority code is PROJECT_PATH_UNSUPPORTED (got ${err.code})`);
  }
}

// Direct .uproject scan is case-insensitive and direct-only.
{
  const root = makeTempRoot();
  try {
    writeProject(root, 'DirectA');
    writeFileSync(join(root, 'DirectB.UPROJECT'), '{"FileVersion":3}\n', 'utf8');
    mkdirSync(join(root, 'Nested'), { recursive: true });
    writeFileSync(join(root, 'Nested', 'Ignored.uproject'), '{}\n', 'utf8');

    const direct = findDirectUprojects(root).map(p => p.replace(/\\/g, '/').split('/').pop()).sort();
    t.assert(direct.length === 2, `direct scan finds two direct uprojects (got ${direct.length})`);
    t.assert(direct.includes('DirectA.uproject'), 'direct scan includes lowercase extension');
    t.assert(direct.includes('DirectB.UPROJECT'), 'direct scan includes uppercase extension');
    t.assert(!direct.includes('Ignored.uproject'), 'direct scan does not recurse');
  } finally {
    cleanup(root);
  }
}

// Workspace auto-resolution accepts one direct project and rejects multiple direct projects.
{
  const root = makeTempRoot();
  try {
    writeProject(root, 'OnlyProject');
    const resolved = scanWorkspaceRoot(root);
    t.assert(resolved.status === 'resolved', `single direct project resolves (got ${resolved.status})`);
    t.assert(resolved.candidates[0].projectName === 'OnlyProject', 'resolved project name is display-only stem');

    writeFileSync(join(root, 'SecondProject.uproject'), '{"FileVersion":3}\n', 'utf8');
    const ambiguous = scanWorkspaceRoot(root);
    t.assert(ambiguous.status === 'ambiguous', `multiple direct projects are ambiguous (got ${ambiguous.status})`);
    t.assert(ambiguous.reason === 'MULTIPLE_DIRECT_UPROJECTS', `direct ambiguity reason is stable (got ${ambiguous.reason})`);
  } finally {
    cleanup(root);
  }
}

// Workspace auto-resolution scans one child level only.
{
  const root = makeTempRoot();
  try {
    const child = join(root, 'ChildProject');
    writeProject(child, 'ChildProject');

    const resolved = scanWorkspaceRoot(root);
    t.assert(resolved.status === 'resolved', `single child project resolves (got ${resolved.status})`);
    t.assert(resolved.candidates[0].projectName === 'ChildProject', 'child project candidate is returned');

    const second = join(root, 'SecondChild');
    writeProject(second, 'SecondChild');
    const ambiguous = scanWorkspaceRoot(root);
    t.assert(ambiguous.status === 'ambiguous', `multiple child projects are ambiguous (got ${ambiguous.status})`);
    t.assert(ambiguous.reason === 'MULTIPLE_CHILD_PROJECTS', `child ambiguity reason is stable (got ${ambiguous.reason})`);

    const deepOnly = makeTempRoot();
    try {
      mkdirSync(join(deepOnly, 'A', 'B'), { recursive: true });
      writeProject(join(deepOnly, 'A', 'B'), 'TooDeep');
      const unresolved = scanWorkspaceRoot(deepOnly);
      t.assert(unresolved.status === 'unresolved', `deep projects do not auto-resolve (got ${unresolved.status})`);
    } finally {
      cleanup(deepOnly);
    }
  } finally {
    cleanup(root);
  }
}

// UEMCP repository guard does not auto-attach nested fixture projects.
{
  const root = makeTempRoot();
  try {
    mkdirSync(join(root, 'server', 'fixtures', 'uemcp-fixture'), { recursive: true });
    mkdirSync(join(root, 'plugin', 'UEMCP'), { recursive: true });
    writeFileSync(join(root, 'tools.yaml'), 'management: {}\n', 'utf8');
    writeFileSync(join(root, 'server', 'server.mjs'), '// sentinel\n', 'utf8');
    writeFileSync(join(root, 'plugin', 'UEMCP', 'UEMCP.uplugin'), '{}\n', 'utf8');
    writeProject(join(root, 'server', 'fixtures', 'uemcp-fixture'), 'FixtureProject');

    const guarded = scanWorkspaceRoot(root);
    t.assert(guarded.status === 'unresolved', `UEMCP repo guard stays unresolved (got ${guarded.status})`);
    t.assert(guarded.reason === 'UEMCP_REPO_GUARD', `UEMCP repo guard reason is stable (got ${guarded.reason})`);
    t.assert(guarded.candidates.length === 0, `UEMCP repo guard exposes no auto candidates (got ${guarded.candidates.length})`);
  } finally {
    cleanup(root);
  }
}

// Segment-aware containment and identity shape.
{
  const root = makeTempRoot();
  try {
    const projectRoot = join(root, 'Project');
    const uprojectPath = writeProject(projectRoot, 'Project');
    const siblingPrefix = join(root, 'Project2', 'Content', 'Asset.uasset');

    t.assert(isInsidePath(join(projectRoot, 'Content', 'Asset.uasset'), projectRoot), 'path inside project root is accepted');
    t.assert(!isInsidePath(siblingPrefix, projectRoot), 'raw prefix sibling path is rejected');

    const identity = createProjectIdentity({
      uprojectPath,
      source: 'test',
      clientRoots: [root],
    });
    t.assert(identity.projectRoot.replace(/\\/g, '/') === projectRoot.replace(/\\/g, '/'), 'identity projectRoot is containing directory');
    t.assert(identity.uprojectPath.replace(/\\/g, '/') === uprojectPath.replace(/\\/g, '/'), 'identity uprojectPath is preserved for display');
    t.assert(identity.projectName === 'Project', `identity projectName is stem (got ${identity.projectName})`);
    t.assert(identity.insideClientRoot === true, 'identity records inside client root');
    t.assert(identity.outsideClientRoot === false, 'identity records not outside client root');
    t.assert(identity.canonicalUprojectPath.length > 0, 'identity has canonical uproject comparison path');
  } finally {
    cleanup(root);
  }
}

const failed = t.summary();
process.exit(failed ? 1 : 0);
