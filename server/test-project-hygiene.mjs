// Project hygiene tests.
//
// Run: cd server && node test-project-hygiene.mjs

import { spawnSync } from 'node:child_process';
import { canonicalJson, sha256Bytes, sha256Canonical } from './deployment/canonical-json.mjs';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerProjectCodenames, resolveGitInfoPath } from './project-hygiene.mjs';
import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Project Hygiene Tests');

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const rotationWorkflow = readFileSync(join(repoRoot, '.github', 'workflows', 'rotation.yml'), 'utf8');

t.assert(/^permissions:\r?\n  contents: read$/m.test(rotationWorkflow),
  'rotation workflow grants the GitHub token read-only repository contents access');
t.assert(rotationWorkflow.includes('actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0')
  && rotationWorkflow.includes('actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0')
  && !/uses:\s+actions\/(?:checkout|setup-node)@v\d+/i.test(rotationWorkflow),
  'rotation workflow pins current GitHub actions to immutable release commits');
t.assert(/^\s+persist-credentials: false$/m.test(rotationWorkflow),
  'rotation checkout does not persist repository credentials');
t.assert(/^\s+timeout-minutes: 30$/m.test(rotationWorkflow),
  'rotation job has a bounded ceiling above its reviewed per-file budgets');

const hooksConfig = 'core.hooksPath=' + join(repoRoot, '.githooks');

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

    writeFileSync(join(testRepo, '.git', 'info', 'forbidden-tokens'), `# CRLF token file\r\n\r\n${token}\r\n`, 'utf8');

    const hookConfig = ['-c', hooksConfig];
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

{
  const root = makeTempRoot();
  try {
    const result = registerProjectCodenames({ projectRoot: 'X:\\ZXQDriveFixture7', repoRoot: join(root, 'repo'), stderr: { write() {} } });
    t.assert(result.registered.includes('ZXQDriveFixture7') && !result.registered.includes('X:'), 'drive designators are not project codenames');
    const shortName = registerProjectCodenames({ projectRoot: 'X:/A', repoRoot: join(root, 'repo'), stderr: { write() {} } });
    t.assert(shortName.registered.includes('A'), 'real short project names remain protected; test isolation is not a name bypass');
  } finally { cleanup(root); }
}

{
  const root = makeTempRoot();
  try {
    runGit(root, ['init']);
    const token = 'ZXQGateToken7';
    writeFileSync(join(root, '.git', 'info', 'forbidden-tokens'), `# Windows line endings\r\n\r\n${token}\r\n`);
    writeFileSync(join(root, 'clean.txt'), 'ordinary text\n');
    runGit(root, ['add', 'clean.txt']);
    const args = ['-c', hooksConfig, '-c', 'user.name=Hygiene Test', '-c', 'user.email=test@example.invalid', 'commit', '-m', 'Test'];
    const clean = runProcess('git', args, { cwd: root });
    t.assert(clean.status === 0, 'CRLF token file permits clean commits', clean.stderr);
    writeFileSync(join(root, 'private.txt'), `${token}\n`);
    runGit(root, ['add', 'private.txt']);
    const blocked = runProcess('git', args, { cwd: root });
    t.assert(blocked.status !== 0 && /Commit blocked/.test(blocked.stderr), 'CRLF token file still blocks protected names', blocked.stderr);
  } finally { cleanup(root); }
}

{
  const root = makeTempRoot();
  try {
    const repo = join(root, 'work');
    const remote = join(root, 'public.git');
    const token = 'ZXQPrivateLabel';
    runGit(root, ['init', '--bare', remote]);
    runGit(root, ['init', '-b', 'main', repo]);
    runGit(repo, ['config', 'user.name', 'Hook Test']);
    runGit(repo, ['config', 'user.email', 'hook@example.invalid']);
    runGit(repo, ['remote', 'add', 'origin', remote]);
    mkdirSync(join(repo, 'dist'));
    mkdirSync(join(repo, 'server'));
    const path = 'dist/deploy-uemcp.manifest.json';
    const lock = 'server/package-lock.json';
    const entry = 'dist/deploy-uemcp.mjs';
    const notices = 'dist/THIRD_PARTY_NOTICES.txt';
    for (const file of [lock, entry, notices]) writeFileSync(join(repo, file), 'one\n');
    const digest = sha256Bytes('one\n');
    const nextDigest = sha256Bytes('two\n');
    const doc = {
      schema_version: '1.0', entry, esbuild_version: '0.28.1', node_minimum: '22.0.0',
      source_inputs: [{ path: 'server/' + token + '.mjs', sha256: digest }],
      package_lock_sha256: digest, bundle_sha256: digest, notices_sha256: digest,
      bundled_packages: [{ name: 'example', license: 'MIT', version: '1.0' }],
    };
    writeFileSync(join(repo, doc.source_inputs[0].path), 'one\n');
    const writeManifest = () => {
      const { source_inputs, package_lock_sha256, bundled_packages, notices_sha256 } = doc;
      doc.input_manifest_sha256 = sha256Canonical({ source_inputs, package_lock_sha256, bundled_packages, notices_sha256 });
      writeFileSync(join(repo, path), canonicalJson(doc) + '\n');
    };
    const commit = (...args) => runProcess('git', ['-c', hooksConfig, 'commit', ...args], { cwd: repo });
    const push = () => runProcess('git', ['-c', hooksConfig, 'push', 'origin', 'main'], { cwd: repo });
    writeManifest();
    runGit(repo, ['add', '.']);
    runGit(repo, ['commit', '-m', 'Public baseline']);
    runGit(repo, ['push', 'origin', 'main']);
    writeFileSync(join(repo, '.git/info/forbidden-tokens'), [token, nextDigest.slice(0, 7), 'regex:ZZQ[0-9]+', ''].join('\n'));
    writeFileSync(join(repo, lock), 'two\n');
    doc.package_lock_sha256 = nextDigest;
    writeManifest();
    runGit(repo, ['add', lock, path]);
    writeFileSync(join(repo, lock), 'uncommitted bytes\n');
    const refreshed = commit('-m', 'Update dependency checksums');
    t.assert(refreshed.status === 0, 'checksum refresh uses the index and permits the existing public path', refreshed.stderr);
    const sent = push();
    t.assert(sent.status === 0 && runGit(remote, ['rev-parse', 'main']) === runGit(repo, ['rev-parse', 'HEAD']),
      'a real push of the checksum refresh reaches the bare destination', sent.stderr);

    doc.bundled_packages[0].name = token;
    writeManifest();
    runGit(repo, ['add', path]);
    const named = commit('-m', 'Edit package metadata');
    t.assert(named.status === 1 && /Commit blocked/.test(named.stderr), 'a newly protected package name is blocked');
    doc.bundled_packages[0].name = 'example';
    doc.package_lock_sha256 = nextDigest.slice(0, 7) + '0'.repeat(57);
    writeManifest();
    runGit(repo, ['add', path]);
    const mismatched = commit('-m', 'Change digest');
    t.assert(mismatched.status === 1 && /Commit blocked/.test(mismatched.stderr), 'an unverified digest receives the full text scan');

    runGit(repo, ['reset', '--quiet', 'HEAD', '--', path, lock]);
    runGit(repo, ['restore', path, lock]);
    writeFileSync(join(repo, token + '.txt'), 'plain\n');
    runGit(repo, ['add', token + '.txt']);
    const filename = commit('-m', 'Add file');
    t.assert(filename.status === 1 && /Commit blocked/.test(filename.stderr), 'a protected filename blocks a clean body');
    runGit(repo, ['rm', '-f', token + '.txt']);
    runGit(repo, ['checkout', '-b', 'integration-check']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'Side branch']);
    runGit(repo, ['checkout', 'main']);
    runGit(repo, ['merge', '--no-ff', '--no-commit', 'integration-check']);
    writeFileSync(join(repo, 'integration.txt'), token + '\n');
    runGit(repo, ['add', 'integration.txt']);
    runGit(repo, ['commit', '-m', 'Integration edit']);
    const merged = push();
    t.assert(merged.status === 1 && /Push blocked/.test(merged.stderr), 'the push checks content first introduced by a merge');
    runGit(repo, ['checkout', '-B', 'main', 'origin/main']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'ZZQ123']);
    runGit(repo, ['commit', '--allow-empty', '-m', 'Clean tip']);
    const message = push();
    t.assert(message.status === 1 && /Push blocked/.test(message.stderr), 'an intermediate commit message matching a regex blocks publication');
  } finally { cleanup(root); }
}

process.exit(t.summary());
