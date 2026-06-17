// Project hygiene tests.
//
// Run: cd server && node test-project-hygiene.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { registerProjectCodenames } from './project-hygiene.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Project Hygiene Tests');

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'uemcp-project-hygiene-'));
}

function cleanup(dir) {
  const norm = dir.replace(/\\/g, '/');
  const tmp = tmpdir().replace(/\\/g, '/').replace(/\/+$/, '');
  if (!norm.startsWith(`${tmp}/uemcp-project-hygiene-`)) {
    throw new Error(`refusing to clean unexpected temp path: ${dir}`);
  }
  rmSync(dir, { recursive: true, force: true });
}

{
  const root = makeTempRoot();
  try {
    const repoRoot = join(root, 'repo');
    const projectRoot = join(root, 'WorkspaceName', 'SecretProject');
    const messages = [];
    const result = registerProjectCodenames({
      projectRoot,
      repoRoot,
      stderr: { write: message => messages.push(message) },
    });
    const targetsPath = join(repoRoot, '.git', 'info', 'known-test-targets.txt');
    const text = readFileSync(targetsPath, 'utf8');
    t.assert(result.registered.includes('SecretProject'), 'project stem registered');
    t.assert(result.registered.includes('WorkspaceName'), 'parent workspace stem registered');
    t.assert(text.match(/SecretProject/g).length === 1, 'project stem written once');
    t.assert(messages.some(message => /Registered project codename SecretProject/.test(message)), 'registration message emitted');

    registerProjectCodenames({ projectRoot, repoRoot, stderr: { write() {} } });
    const after = readFileSync(targetsPath, 'utf8');
    t.assert(after.match(/SecretProject/g).length === 1, 'second registration is idempotent');
  } finally {
    cleanup(root);
  }
}

{
  const root = makeTempRoot();
  try {
    const repoRoot = join(root, 'repo');
    const projectRoot = join(root, 'UnrealProjects', '5.6');
    const result = registerProjectCodenames({
      projectRoot,
      repoRoot,
      stderr: { write() {} },
    });
    t.assert(result.registered.length === 0, `generic/version names are skipped (got ${result.registered.join(',')})`);
  } finally {
    cleanup(root);
  }
}

{
  const root = makeTempRoot();
  try {
    const repoRoot = join(root, 'repo-file');
    writeFileSync(repoRoot, 'not a directory', 'utf8');
    const result = registerProjectCodenames({
      projectRoot: join(root, 'WorkspaceName', 'SecretProject'),
      repoRoot,
      stderr: { write() {} },
    });
    t.assert(result.warnings.length > 0, 'write failure is reported as warning');
  } finally {
    cleanup(root);
  }
}

process.exit(t.summary());
