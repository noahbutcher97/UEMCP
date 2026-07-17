// Project hygiene tests.
//
// Run: cd server && node test-project-hygiene.mjs

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

function runProcess(command, args, { cwd, input } = {}) {
  return spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    windowsHide: true,
  });
}

function runGit(cwd, args) {
  const result = runProcess('git', args, { cwd });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
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
    const repoRoot = join(root, 'repo');
    const genericRoots = [
      join(root, 'server', 'fixtures', 'uemcp-fixture'),
      join(root, 'Fixture', 'UEMCPFixture'),
    ];
    const registered = genericRoots.flatMap(projectRoot => registerProjectCodenames({
      projectRoot,
      repoRoot,
      stderr: { write() {} },
    }).registered);
    t.assert(registered.length === 0, `fixture project names are skipped (got ${registered.join(',')})`);
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
    t.assert(
      source.includes("'fixture','fixtures','uemcpfixture','uemcp-fixture'"),
      `${name} rejects generic fixture project names`
    );
  }
  t.assert(resolveGitInfoPath(repoRoot, 'info/known-test-targets.txt').replace(/\\/g, '/').includes('/.git/info/known-test-targets.txt'),
    'project hygiene resolves known-test-targets through git info path');
  const dotGitPath = join(repoRoot, '.git');
  if (statSync(dotGitPath).isFile() && /^gitdir:/i.test(readFileSync(dotGitPath, 'utf8'))) {
    const resolved = resolveGitInfoPath(repoRoot, 'info/known-test-targets.txt').replace(/\\/g, '/');
    const literalWorktreePath = join(repoRoot, '.git', 'info', 'known-test-targets.txt').replace(/\\/g, '/');
    t.assert(resolved !== literalWorktreePath, 'project hygiene does not write known-test-targets under a linked-worktree .git file');
  }
  t.assert(
    preCommit.includes('known_targets="$(resolve_git_info_file "info/known-test-targets.txt")"'),
    'pre-commit resolves known-test-targets through the same git info helper'
  );
}

{
  const root = makeTempRoot();
  try {
    const remoteRoot = join(root, 'origin.git');
    const privateRemoteRoot = join(root, 'private.git');
    const testRepo = join(root, 'repo');
    const token = 'ZXQGateToken7';

    runGit(root, ['init', '--bare', remoteRoot]);
    runGit(root, ['init', '--bare', privateRemoteRoot]);
    mkdirSync(testRepo);
    runGit(testRepo, ['init']);
    runGit(testRepo, ['config', 'user.name', 'UEMCP Hygiene Test']);
    runGit(testRepo, ['config', 'user.email', 'uemcp-hygiene@example.invalid']);
    writeFileSync(join(testRepo, 'published.txt'), `${token}\n`, 'utf8');
    runGit(testRepo, ['add', 'published.txt']);
    runGit(testRepo, ['commit', '-m', 'Published baseline']);
    runGit(testRepo, ['branch', '-M', 'main']);
    runGit(testRepo, ['remote', 'add', 'origin', remoteRoot]);
    runGit(testRepo, ['push', '-u', 'origin', 'main']);

    runGit(testRepo, ['checkout', '-b', 'range-check']);
    writeFileSync(join(testRepo, 'clean.txt'), 'clean branch content\n', 'utf8');
    runGit(testRepo, ['add', 'clean.txt']);
    runGit(testRepo, ['commit', '-m', 'Clean branch commit']);
    runGit(testRepo, ['push', 'origin', 'HEAD:refs/heads/range-check']);

    mkdirSync(join(testRepo, '.githooks'), { recursive: true });
    writeFileSync(
      join(testRepo, '.githooks', 'pre-push'),
      readFileSync(join(repoRoot, '.githooks', 'pre-push'), 'utf8'),
      'utf8'
    );
    chmodSync(join(testRepo, '.githooks', 'pre-push'), 0o755);
    writeFileSync(join(testRepo, '.git', 'info', 'forbidden-tokens'), `${token}\n`, 'utf8');

    const hookConfig = ['-c', 'core.hooksPath=.githooks'];
    const cleanResult = runProcess('git', [
      ...hookConfig,
      'push',
      '--dry-run',
      'origin',
      'HEAD:refs/heads/range-check-new',
    ], { cwd: testRepo });
    t.assert(
      cleanResult.status === 0,
      'pre-push ignores forbidden content already reachable from the destination remote',
      cleanResult.stderr || cleanResult.stdout
    );

    writeFileSync(join(testRepo, 'outgoing.txt'), `${token}\n`, 'utf8');
    runGit(testRepo, ['add', 'outgoing.txt']);
    runGit(testRepo, ['commit', '-m', 'Outgoing forbidden content']);
    runGit(testRepo, ['remote', 'add', 'private', privateRemoteRoot]);
    runGit(testRepo, ['push', 'private', 'range-check']);
    runGit(testRepo, ['fetch', 'private']);
    const forbiddenNewBranchResult = runProcess('git', [
      ...hookConfig,
      'push',
      '--dry-run',
      'origin',
      'HEAD:refs/heads/range-check-new',
    ], { cwd: testRepo });
    t.assert(
      forbiddenNewBranchResult.status === 1 && /Push blocked/.test(forbiddenNewBranchResult.stderr),
      'pre-push still blocks forbidden content absent from the destination remote',
      forbiddenNewBranchResult.stderr || forbiddenNewBranchResult.stdout
    );

    const forbiddenExistingBranchResult = runProcess('git', [
      ...hookConfig,
      'push',
      '--dry-run',
      'origin',
      'HEAD:refs/heads/range-check',
    ], { cwd: testRepo });
    t.assert(
      forbiddenExistingBranchResult.status === 1 && /Push blocked/.test(forbiddenExistingBranchResult.stderr),
      'pre-push retains existing-branch range enforcement',
      forbiddenExistingBranchResult.stderr || forbiddenExistingBranchResult.stdout
    );
  } finally {
    cleanup(root);
  }
}

process.exit(t.summary());
