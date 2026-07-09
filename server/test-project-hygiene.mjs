// Project hygiene tests.
//
// Run: cd server && node test-project-hygiene.mjs

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerProjectCodenames, resolveGitInfoPath } from './project-hygiene.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Project Hygiene Tests');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

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

{
  const preCommit = readFileSync(join(repoRoot, '.githooks', 'pre-commit'), 'utf8');
  const prePush = readFileSync(join(repoRoot, '.githooks', 'pre-push'), 'utf8');
  const setupBat = readFileSync(join(repoRoot, 'setup-uemcp.bat'), 'utf8');
  const syncBat = readFileSync(join(repoRoot, 'sync-plugin.bat'), 'utf8');
  for (const [name, source] of [['pre-commit', preCommit], ['pre-push', prePush]]) {
    t.assert(source.includes('git rev-parse --git-path "$rel"'), `${name} resolves hook info files through git-path`);
    t.assert(source.includes('git rev-parse --git-common-dir'), `${name} falls back to the common git dir for linked worktrees`);
    t.assert(!source.includes('tokens=".git/info/forbidden-tokens"'), `${name} does not hard-code forbidden-tokens under literal .git`);
  }
  for (const [name, source] of [['setup-uemcp.bat', setupBat], ['sync-plugin.bat', syncBat]]) {
    t.assert(source.includes('rev-parse --git-path info/forbidden-tokens'), `${name} resolves forbidden-tokens through git-path`);
    t.assert(source.includes('if not defined TOKENS_PATH set "TOKENS_PATH=%UEMCP_PATH%\\.git\\info\\forbidden-tokens"'), `${name} keeps a non-git fallback for forbidden-tokens`);
  }
  t.assert(resolveGitInfoPath(repoRoot, 'info/known-test-targets.txt').replace(/\\/g, '/').includes('/.git/info/known-test-targets.txt'),
    'project hygiene resolves known-test-targets through git info path');
  if (/^gitdir:/i.test(readFileSync(join(repoRoot, '.git'), 'utf8'))) {
    const resolved = resolveGitInfoPath(repoRoot, 'info/known-test-targets.txt').replace(/\\/g, '/');
    const literalWorktreePath = join(repoRoot, '.git', 'info', 'known-test-targets.txt').replace(/\\/g, '/');
    t.assert(resolved !== literalWorktreePath, 'project hygiene does not write known-test-targets under a linked-worktree .git file');
  }
  t.assert(
    preCommit.includes('known_targets="$(resolve_git_info_file "info/known-test-targets.txt")"'),
    'pre-commit resolves known-test-targets through the same git info helper'
  );
}

process.exit(t.summary());
