// Release-gated client launch resolution and adapter contract tests.
//
// Run: cd server && node test-client-adapters.mjs

import { randomUUID } from 'node:crypto';
import {
  linkSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { TestRunner } from './test-helpers.mjs';
import {
  CLIENT_IDS,
  RELEASE_GATES,
  classifySupportedVersion,
  validateClientLaunchContract,
} from './deployment/client-contract.mjs';
import { resolveClientLaunch } from './deployment/client-process.mjs';

const t = new TestRunner('Client Adapter Tests');

function makeRoot() {
  const root = join(tmpdir(), `uemcp-client-adapter-${randomUUID()}`);
  mkdirSync(root);
  return root;
}

function cleanup(root) {
  const normalized = resolve(root).replace(/\\/g, '/').toLowerCase();
  const expected = resolve(tmpdir()).replace(/\\/g, '/').toLowerCase();
  if (!normalized.startsWith(`${expected}/uemcp-client-adapter-`)) throw new Error(`refusing to clean unexpected path: ${root}`);
  rmSync(root, { recursive: true, force: true });
}

function write(path, content = 'sample') {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
  return path;
}

function writeJson(path, value) {
  return write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function vscodeWrapper(installRoot, content = null, versionDirectory = '5264f2156c') {
  return write(join(installRoot, 'bin', 'code.cmd'), content ?? [
    '@echo off',
    'setlocal',
    'set VSCODE_DEV=',
    'set ELECTRON_RUN_AS_NODE=1',
    `"%~dp0..\\Code.exe" "%~dp0..\\${versionDirectory}\\resources\\app\\out\\cli.js" %*`,
    'endlocal',
    '',
  ].join('\r\n'));
}

function environment(root) {
  return {
    SystemRoot: join(root, 'windows'),
    WINDIR: join(root, 'windows'),
    USERPROFILE: join(root, 'user'),
    APPDATA: join(root, 'user', 'AppData', 'Roaming'),
    LOCALAPPDATA: join(root, 'user', 'AppData', 'Local'),
    ProgramFiles: join(root, 'Program Files'),
    PATH: 'untrusted-parent-path',
    SECRET_CANARY: 'never-serialize-this',
  };
}

function runnerFor(version = '0.144.4', overrides = {}) {
  const calls = [];
  return {
    calls,
    async run(executable, args, options = {}) {
      calls.push({ executable, args: [...args], options: { ...options, env: { ...options.env } } });
      if (overrides.run) return overrides.run(executable, args, options);
      return { status: 'exited', exitCode: 0, stdout: `${version}\n`, stderr: '' };
    },
  };
}

function signer(status = 'valid', simpleName = null) {
  const calls = [];
  const inspect = async (path, options) => {
    calls.push({ path, options });
    return {
      status,
      signer_name: simpleName ?? options.expectedSignerNames[0],
      thumbprint: 'AA11',
    };
  };
  inspect.calls = calls;
  return inspect;
}

function npmInstall(root, clientId, {
  packageName,
  binName = clientId,
  bin = `bin/${clientId}.mjs`,
  packageBin = null,
  packageId = packageName,
} = {}) {
  const env = environment(root);
  const prefix = join(env.APPDATA, 'npm');
  const shim = write(join(prefix, `${clientId}.cmd`), '@echo off\n');
  const packageRoot = join(prefix, 'node_modules', ...packageName.split('/'));
  writeJson(join(packageRoot, 'package.json'), {
    name: packageId,
    version: '1.0.0',
    bin: packageBin ?? { [binName]: bin },
  });
  const entry = resolve(packageRoot, bin);
  if (entry.toLowerCase().startsWith(`${resolve(packageRoot).toLowerCase()}\\`)) write(entry, 'export {};\n');
  const nodeExecutable = write(join(root, 'runtime', 'node.exe'), 'node-binary');
  return { env, prefix, shim, packageRoot, entry, nodeExecutable };
}

async function rejectsCode(fn, code) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
}

// Closed client IDs and exact release gates.
{
  t.assert(Object.isFrozen(CLIENT_IDS) && JSON.stringify(CLIENT_IDS) === JSON.stringify(['claude', 'codex', 'gemini', 'vscode']), 'client IDs are closed, ordered, and frozen');
  t.assert(Object.isFrozen(RELEASE_GATES) && Object.values(RELEASE_GATES).every(Object.isFrozen), 'release gates are deeply frozen');
  t.assert(JSON.stringify(RELEASE_GATES.claude.versions) === JSON.stringify(['2.1.209', '2.1.210']), 'Claude release gate is exact');
  t.assert(JSON.stringify(RELEASE_GATES.codex.versions) === JSON.stringify(['0.144.4']), 'Codex release gate is exact');
  t.assert(JSON.stringify(RELEASE_GATES.gemini.versions) === JSON.stringify(['0.41.2']), 'Gemini release gate is exact');
  t.assert(JSON.stringify(RELEASE_GATES.vscode.versions) === JSON.stringify(['1.128.1']), 'VS Code release gate is exact');
  t.assert(classifySupportedVersion('claude', '2.1.210') === 'release_gated', 'exact gated version allows writes');
  t.assert(classifySupportedVersion('codex', '0.143.0') === 'known_unsupported', 'older version is known unsupported');
  t.assert(classifySupportedVersion('codex', '0.145.0') === 'unknown_newer', 'newer version is inspect-only');
  t.assert(classifySupportedVersion('codex', 'not-a-version') === 'known_unsupported', 'malformed version never widens write support');
}

// Allowlisted npm package resolution never executes shell wrappers.
{
  const root = makeRoot();
  try {
    const layout = npmInstall(root, 'codex', { packageName: '@openai/codex' });
    const runner = runnerFor('0.144.4');
    const result = await resolveClientLaunch('codex', {
      env: layout.env,
      runner,
      candidates: { codex: [layout.shim], nodeExecutable: layout.nodeExecutable },
    });
    t.assert(result.command === resolve(layout.nodeExecutable) && JSON.stringify(result.args_prefix) === JSON.stringify([resolve(layout.entry)]), 'npm client resolves to absolute node.exe plus package bin entry');
    t.assert(result.package_id === '@openai/codex' && result.source === 'npm_package', 'npm client reports allowlisted package provenance');
    t.assert(result.version === '0.144.4' && result.compatibility === 'release_gated' && result.write_supported, 'supported npm client is release gated for writes');
    t.assert(runner.calls.length === 1 && runner.calls[0].executable.endsWith('node.exe') && runner.calls[0].args.at(-1) === '--version', 'npm wrapper is never executed during version probing');
    t.assert(runner.calls[0].options.shell === false && runner.calls[0].options.timeoutMs <= 10_000 && runner.calls[0].options.outputLimitBytes <= 64 * 1024, 'version probe is bounded and shell-free');
    t.assert(result.fingerprint.command.sha256 && result.fingerprint.args_prefix[0].sha256, 'launch result fingerprints executable and package entry');
    t.assert(await rejectsCode(() => validateClientLaunchContract({ ...result, command: 'node.exe' }), 'INVALID_CLIENT_LAUNCH'), 'client contract rejects a relative executable');
  } finally {
    cleanup(root);
  }
}

// Candidate paths must already be absolute and discovery work is explicitly bounded.
{
  const root = makeRoot();
  try {
    const layout = npmInstall(root, 'codex', { packageName: '@openai/codex' });
    const originalCwd = process.cwd();
    const relativeRunner = runnerFor('0.144.4');
    try {
      process.chdir(layout.prefix);
      t.assert(await rejectsCode(() => resolveClientLaunch('codex', {
        env: layout.env,
        runner: relativeRunner,
        candidates: { codex: ['codex.cmd'], nodeExecutable: layout.nodeExecutable },
      }), 'NOT_INSTALLED'), 'relative client candidate is rejected');
      t.assert(relativeRunner.calls.length === 0, 'relative client candidate is never process-probed');
    } finally {
      process.chdir(originalCwd);
    }

    const tooMany = Array.from({ length: 65 }, (_, index) => join(root, 'missing', `${index}.cmd`));
    tooMany.push(layout.shim);
    const oversizedRunner = runnerFor('0.144.4');
    t.assert(await rejectsCode(() => resolveClientLaunch('codex', {
      env: layout.env,
      runner: oversizedRunner,
      candidates: { codex: tooMany, nodeExecutable: layout.nodeExecutable },
    }), 'CLIENT_DISCOVERY_FAILED'), 'oversized client candidate set is rejected before validation');
    t.assert(oversizedRunner.calls.length === 0, 'oversized client candidate set never reaches process probing');
  } finally {
    cleanup(root);
  }
}

// Package bin string form, extra version output, and unknown-newer gating.
{
  const root = makeRoot();
  try {
    const layout = npmInstall(root, 'gemini', {
      packageName: '@google/gemini-cli',
      bin: 'dist/index.js',
      packageBin: 'dist/index.js',
    });
    const runner = runnerFor('0.42.0', {
      run: async () => ({ status: 'exited', exitCode: 0, stdout: 'Gemini CLI\n0.42.0\ncommit abc\n', stderr: '' }),
    });
    const result = await resolveClientLaunch('gemini', {
      env: layout.env,
      runner,
      candidates: { gemini: [layout.shim], nodeExecutable: layout.nodeExecutable },
    });
    t.assert(result.version === '0.42.0' && result.compatibility === 'unknown_newer' && !result.write_supported, 'first semantic version line gates unknown newer client inspect-only');
  } finally {
    cleanup(root);
  }
}

// PowerShell npm shims are discovery clues only and never become the launch command.
{
  const root = makeRoot();
  try {
    const layout = npmInstall(root, 'gemini', { packageName: '@google/gemini-cli' });
    const powershellShim = write(join(layout.prefix, 'gemini.ps1'), '# npm shim\n');
    const runner = runnerFor('0.41.2');
    const result = await resolveClientLaunch('gemini', {
      env: layout.env,
      runner,
      candidates: { gemini: [powershellShim], nodeExecutable: layout.nodeExecutable },
    });
    t.assert(result.command === resolve(layout.nodeExecutable), 'PowerShell npm shim resolves through node.exe');
    t.assert(runner.calls.length === 1 && runner.calls[0].executable !== resolve(powershellShim), 'PowerShell npm shim is never executed');
  } finally {
    cleanup(root);
  }
}

// Hostile candidates are rejected before spawn while a later valid package can win.
{
  const root = makeRoot();
  try {
    const layout = npmInstall(root, 'codex', { packageName: '@openai/codex' });
    const hostile = write(join(root, 'hostile', 'codex.exe'), 'hostile');
    const runner = runnerFor('0.144.4');
    const result = await resolveClientLaunch('codex', {
      env: layout.env,
      runner,
      candidates: { codex: [hostile, layout.shim, layout.shim], nodeExecutable: layout.nodeExecutable },
    });
    t.assert(result.source === 'npm_package' && runner.calls.length === 1, 'hostile and duplicate candidates are rejected or deduplicated before spawn');
    t.assert(runner.calls.every(call => call.executable !== hostile), 'rejected same-name executable is never launched');
  } finally {
    cleanup(root);
  }
}

// Broken or escaped npm package metadata fails closed without probing.
{
  const cases = [
    { label: 'package ID mismatch', options: { packageId: '@evil/codex' } },
    { label: 'package bin escape', options: { bin: '../../outside.mjs' } },
  ];
  for (const testCase of cases) {
    const root = makeRoot();
    try {
      const layout = npmInstall(root, 'codex', { packageName: '@openai/codex', ...testCase.options });
      const runner = runnerFor('0.144.4');
      const rejected = await rejectsCode(() => resolveClientLaunch('codex', {
        env: layout.env,
        runner,
        candidates: { codex: [layout.shim], nodeExecutable: layout.nodeExecutable },
      }), 'NOT_INSTALLED');
      t.assert(rejected && runner.calls.length === 0, `${testCase.label} is rejected before process launch`);
    } finally {
      cleanup(root);
    }
  }
}

// Linked package entries and missing manifests cannot become launch authority.
{
  const root = makeRoot();
  try {
    const layout = npmInstall(root, 'codex', { packageName: '@openai/codex' });
    rmSync(layout.entry);
    const outside = write(join(root, 'outside.mjs'), 'export {};\n');
    symlinkSync(outside, layout.entry, 'file');
    const runner = runnerFor('0.144.4');
    t.assert(await rejectsCode(() => resolveClientLaunch('codex', {
      env: layout.env,
      runner,
      candidates: { codex: [layout.shim], nodeExecutable: layout.nodeExecutable },
    }), 'NOT_INSTALLED'), 'linked package entry is rejected');
    t.assert(runner.calls.length === 0, 'linked package entry is never launched');
  } finally {
    cleanup(root);
  }
}

{
  const root = makeRoot();
  try {
    const layout = npmInstall(root, 'codex', { packageName: '@openai/codex' });
    rmSync(join(layout.packageRoot, 'package.json'));
    const runner = runnerFor('0.144.4');
    t.assert(await rejectsCode(() => resolveClientLaunch('codex', {
      env: layout.env,
      runner,
      candidates: { codex: [layout.shim], nodeExecutable: layout.nodeExecutable },
    }), 'NOT_INSTALLED'), 'missing package manifest is rejected');
    t.assert(runner.calls.length === 0, 'missing package manifest is never version probed');
  } finally {
    cleanup(root);
  }
}

// Native Claude is accepted only at the standard path with valid signer evidence.
{
  const root = makeRoot();
  try {
    const env = environment(root);
    const claude = write(join(env.USERPROFILE, '.local', 'bin', 'claude.exe'), 'claude-binary');
    const runner = runnerFor('2.1.210');
    const inspector = signer();
    const result = await resolveClientLaunch('claude', {
      env,
      runner,
      candidates: { claude: [claude] },
      authenticodeInspector: inspector,
    });
    t.assert(result.command === resolve(claude) && result.source === 'native', 'standard native Claude path resolves');
    t.assert(inspector.calls[0].options.expectedSignerNames[0] === 'Anthropic, PBC', 'native Claude requires exact signer identity');
    t.assert(result.version === '2.1.210' && result.write_supported, 'signed native Claude version is release gated');

    const outside = write(join(root, 'outside', 'claude.exe'), 'claude-binary');
    const outsideRunner = runnerFor('2.1.210');
    t.assert(await rejectsCode(() => resolveClientLaunch('claude', {
      env,
      runner: outsideRunner,
      candidates: { claude: [outside] },
      authenticodeInspector: signer(),
    }), 'NOT_INSTALLED'), 'native Claude outside its allowlisted root is rejected');
    t.assert(outsideRunner.calls.length === 0, 'nonstandard native Claude is never version probed');

    const badSignerRunner = runnerFor('2.1.210');
    t.assert(await rejectsCode(() => resolveClientLaunch('claude', {
      env,
      runner: badSignerRunner,
      candidates: { claude: [claude] },
      authenticodeInspector: signer('NotSigned', 'Unknown'),
    }), 'NOT_INSTALLED'), 'invalid native Claude signature is rejected');
    t.assert(badSignerRunner.calls.length === 0, 'invalidly signed Claude is never version probed');
  } finally {
    cleanup(root);
  }
}

// VS Code resolves the native CLI tuple with an exact fixed environment overlay.
{
  const root = makeRoot();
  try {
    const env = environment(root);
    const installRoot = join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code');
    const code = write(join(installRoot, 'Code.exe'), 'code-binary');
    const cli = write(join(installRoot, '5264f2156c', 'resources', 'app', 'out', 'cli.js'), 'export {};\n');
    const runner = runnerFor('1.128.1');
    const parentEnv = { ...env };
    const result = await resolveClientLaunch('vscode', {
      env,
      runner,
      candidates: { vscode: [code] },
      authenticodeInspector: signer(),
    });
    t.assert(result.command === resolve(code) && JSON.stringify(result.args_prefix) === JSON.stringify([resolve(cli)]), 'VS Code resolves Code.exe plus same-root cli.js');
    t.assert(JSON.stringify(result.env_overlay) === JSON.stringify({ ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }), 'VS Code launch overlay is exact');
    t.assert(runner.calls[0].args[0] === resolve(cli) && runner.calls[0].args.at(-1) === '--version', 'VS Code version probe uses CLI script rather than direct GUI invocation');
    t.assert(runner.calls[0].options.env.ELECTRON_RUN_AS_NODE === '1' && runner.calls[0].options.env.VSCODE_DEV === '', 'fixed VS Code overlay wins in child environment');
    t.assert(JSON.stringify(env) === JSON.stringify(parentEnv), 'version probe never mutates parent environment');
    t.assert(result.fingerprint.env_overlay_sha256 && result.fingerprint.args_prefix[0].sha256, 'VS Code fingerprint includes overlay and cli.js');
    t.assert(result.version === '1.128.1' && result.write_supported, 'supported VS Code tuple is release gated');
    t.assert(validateClientLaunchContract(result) === result, 'valid VS Code launch tuple satisfies the client contract');
    for (const [label, envOverlay] of [
      ['missing ELECTRON_RUN_AS_NODE', { VSCODE_DEV: '' }],
      ['altered ELECTRON_RUN_AS_NODE', { ELECTRON_RUN_AS_NODE: '0', VSCODE_DEV: '' }],
      ['missing VSCODE_DEV', { ELECTRON_RUN_AS_NODE: '1' }],
      ['extra overlay key', { ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '', EXTRA: '1' }],
    ]) {
      t.assert(await rejectsCode(() => validateClientLaunchContract({ ...result, env_overlay: envOverlay }), 'INVALID_CLIENT_LAUNCH'), `VS Code contract rejects ${label}`);
    }
    t.assert(await rejectsCode(() => validateClientLaunchContract({ ...result, args_prefix: [] }), 'INVALID_CLIENT_LAUNCH'), 'VS Code contract rejects direct GUI invocation');
    t.assert(await rejectsCode(() => validateClientLaunchContract({
      ...result,
      args_prefix: [join(root, 'outside', 'resources', 'app', 'out', 'cli.js')],
    }), 'INVALID_CLIENT_LAUNCH'), 'VS Code contract rejects a mismatched CLI install root');
  } finally {
    cleanup(root);
  }
}

// The official VS Code wrapper is parsed as a bounded clue and never executed.
{
  const root = makeRoot();
  try {
    const env = environment(root);
    const installRoot = join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code');
    const code = write(join(installRoot, 'Code.exe'), 'code-binary');
    const cli = write(join(installRoot, '5264f2156c', 'resources', 'app', 'out', 'cli.js'), 'export {};\n');
    const wrapper = vscodeWrapper(installRoot);
    const runner = runnerFor('1.128.1');
    const result = await resolveClientLaunch('vscode', {
      env,
      runner,
      candidates: { vscode: [wrapper] },
      authenticodeInspector: signer(),
    });
    t.assert(result.command === resolve(code) && result.args_prefix[0] === resolve(cli), 'official VS Code wrapper resolves one same-root CLI tuple');
    t.assert(runner.calls.length === 1 && runner.calls[0].executable === resolve(code), 'VS Code wrapper is never executed');
    t.assert(result.fingerprint.discovery_clue?.sha256, 'VS Code wrapper fingerprint is retained as discovery evidence');
  } finally {
    cleanup(root);
  }
}

// Altered VS Code wrappers cannot redirect or introduce ambiguous CLI references.
{
  const cases = [
    {
      label: 'wrapper path escape',
      content: '"%~dp0..\\Code.exe" "%~dp0..\\..\\outside\\cli.js" %*\r\n',
    },
    {
      label: 'multiple CLI references',
      content: '"%~dp0..\\Code.exe" "%~dp0..\\5264f2156c\\resources\\app\\out\\cli.js" "%~dp0..\\other\\resources\\app\\out\\cli.js" %*\r\n',
    },
    {
      label: 'mismatched executable root',
      content: '"%~dp0..\\..\\outside\\Code.exe" "%~dp0..\\5264f2156c\\resources\\app\\out\\cli.js" %*\r\n',
    },
  ];
  for (const testCase of cases) {
    const root = makeRoot();
    try {
      const env = environment(root);
      const installRoot = join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code');
      write(join(installRoot, 'Code.exe'), 'code-binary');
      write(join(installRoot, '5264f2156c', 'resources', 'app', 'out', 'cli.js'), 'export {};\n');
      const wrapper = vscodeWrapper(installRoot, testCase.content);
      const runner = runnerFor('1.128.1');
      t.assert(await rejectsCode(() => resolveClientLaunch('vscode', {
        env,
        runner,
        candidates: { vscode: [wrapper] },
        authenticodeInspector: signer(),
      }), 'NOT_INSTALLED'), `${testCase.label} is rejected`);
      t.assert(runner.calls.length === 0, `${testCase.label} is never process-probed`);
    } finally {
      cleanup(root);
    }
  }
}

// Direct VS Code discovery must prove exactly one versioned CLI candidate.
{
  const root = makeRoot();
  try {
    const env = environment(root);
    const installRoot = join(env.LOCALAPPDATA, 'Programs', 'Microsoft VS Code');
    const code = write(join(installRoot, 'Code.exe'), 'code-binary');
    write(join(installRoot, 'version-a', 'resources', 'app', 'out', 'cli.js'), 'export {};\n');
    write(join(installRoot, 'version-b', 'resources', 'app', 'out', 'cli.js'), 'export {};\n');
    const runner = runnerFor('1.128.1');
    t.assert(await rejectsCode(() => resolveClientLaunch('vscode', {
      env,
      runner,
      candidates: { vscode: [code] },
      authenticodeInspector: signer(),
    }), 'NOT_INSTALLED'), 'multiple versioned VS Code CLI candidates are rejected');
    t.assert(runner.calls.length === 0, 'ambiguous VS Code CLI candidates never launch the GUI');
  } finally {
    cleanup(root);
  }
}

// Missing VS Code CLI and failed/timeout version probes fail closed.
{
  const root = makeRoot();
  try {
    const env = environment(root);
    const code = write(join(env.ProgramFiles, 'Microsoft VS Code', 'Code.exe'), 'code-binary');
    const noCliRunner = runnerFor('1.128.1');
    t.assert(await rejectsCode(() => resolveClientLaunch('vscode', {
      env,
      runner: noCliRunner,
      candidates: { vscode: [code] },
      authenticodeInspector: signer(),
    }), 'NOT_INSTALLED'), 'VS Code without same-root cli.js is rejected');
    t.assert(noCliRunner.calls.length === 0, 'VS Code GUI is never launched when cli.js is missing');

    write(join(dirname(code), '5264f2156c', 'resources', 'app', 'out', 'cli.js'), 'export {};\n');
    const timeoutRunner = runnerFor('1.128.1', {
      run: async () => ({ status: 'timed_out', exitCode: null, stdout: '', stderr: '' }),
    });
    t.assert(await rejectsCode(() => resolveClientLaunch('vscode', {
      env,
      runner: timeoutRunner,
      candidates: { vscode: [code] },
      authenticodeInspector: signer(),
    }), 'VERSION_PROBE_FAILED'), 'version timeout fails closed');
  } finally {
    cleanup(root);
  }
}


// VS Code requires the exact Microsoft signer before the native tuple is probed.
{
  const root = makeRoot();
  try {
    const env = environment(root);
    const installRoot = join(env.ProgramFiles, 'Microsoft VS Code');
    const code = write(join(installRoot, 'Code.exe'), 'code-binary');
    write(join(installRoot, '5264f2156c', 'resources', 'app', 'out', 'cli.js'), 'export {};\n');
    const runner = runnerFor('1.128.1');
    t.assert(await rejectsCode(() => resolveClientLaunch('vscode', {
      env,
      runner,
      candidates: { vscode: [code] },
      authenticodeInspector: signer('valid', 'Unexpected Publisher'),
    }), 'NOT_INSTALLED'), 'wrong-signer VS Code is rejected');
    t.assert(runner.calls.length === 0, 'wrong-signer VS Code is never version probed');
  } finally {
    cleanup(root);
  }
}

// PATH discovery uses only absolute System32 where.exe as a read-only clue.
{
  const root = makeRoot();
  try {
    const layout = npmInstall(root, 'codex', { packageName: '@openai/codex' });
    const where = write(join(layout.env.SystemRoot, 'System32', 'where.exe'), 'where-binary');
    linkSync(where, join(dirname(where), 'where-hardlink.exe'));
    layout.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    const runner = runnerFor('0.144.4', {
      run: async (executable) => executable === resolve(where)
        ? { status: 'exited', exitCode: 0, stdout: `${layout.shim}\n`, stderr: '' }
        : { status: 'exited', exitCode: 0, stdout: '0.144.4\n', stderr: '' },
    });
    const result = await resolveClientLaunch('codex', {
      env: layout.env,
      runner,
      candidates: { nodeExecutable: layout.nodeExecutable },
    });
    t.assert(result.write_supported && runner.calls.length === 2, 'where discovery resolves and probes one safe npm client');
    t.assert(runner.calls[0].executable === resolve(where), 'normal multiply linked System32 where.exe remains usable');
    t.assert(runner.calls[0].executable === resolve(where) && runner.calls[0].args[0] === 'codex', 'discovery invokes absolute System32 where.exe only');
    t.assert(runner.calls[0].options.shell === false && runner.calls[0].options.timeoutMs <= 5_000, 'where discovery is bounded and shell-free');
    t.assert(runner.calls[0].options.env.PATH === layout.env.PATH && runner.calls[0].options.env.PATHEXT === layout.env.PATHEXT, 'where discovery receives the selected PATH and PATHEXT');
    t.assert(JSON.stringify(Object.keys(runner.calls[0].options.env).sort()) === JSON.stringify(['PATH', 'PATHEXT', 'SystemRoot', 'WINDIR']), 'where discovery environment is minimal');
  } finally {
    cleanup(root);
  }
}

// Safe launch resolution does not tolerate malformed or unsuccessful version output.
{
  for (const testCase of [
    { label: 'missing semantic version', result: { status: 'exited', exitCode: 0, stdout: 'Codex unknown\n', stderr: '' } },
    { label: 'nonzero version command', result: { status: 'exited', exitCode: 1, stdout: '0.144.4\n', stderr: 'failed' } },
  ]) {
    const root = makeRoot();
    try {
      const layout = npmInstall(root, 'codex', { packageName: '@openai/codex' });
      const runner = runnerFor('0.144.4', { run: async () => testCase.result });
      t.assert(await rejectsCode(() => resolveClientLaunch('codex', {
        env: layout.env,
        runner,
        candidates: { codex: [layout.shim], nodeExecutable: layout.nodeExecutable },
      }), 'VERSION_PROBE_FAILED'), `${testCase.label} fails the bounded version probe`);
      t.assert(runner.calls.length === 1 && runner.calls[0].executable.endsWith('node.exe'), `${testCase.label} probes only the validated launch tuple`);
    } finally {
      cleanup(root);
    }
  }
}

// Hard-linked launch files and absent clients are not accepted.
{
  const root = makeRoot();
  try {
    const layout = npmInstall(root, 'codex', { packageName: '@openai/codex' });
    linkSync(layout.entry, join(dirname(layout.entry), 'second-link.mjs'));
    const runner = runnerFor('0.144.4');
    t.assert(await rejectsCode(() => resolveClientLaunch('codex', {
      env: layout.env,
      runner,
      candidates: { codex: [layout.shim], nodeExecutable: layout.nodeExecutable },
    }), 'NOT_INSTALLED'), 'multiply linked package entry is rejected');
    t.assert(await rejectsCode(() => resolveClientLaunch('gemini', {
      env: layout.env,
      runner,
      candidates: { gemini: [], nodeExecutable: layout.nodeExecutable },
    }), 'NOT_INSTALLED'), 'missing client returns NOT_INSTALLED');
    t.assert(await rejectsCode(() => resolveClientLaunch('unknown', {
      env: layout.env,
      runner,
      candidates: {},
    }), 'UNSUPPORTED_CLIENT'), 'unknown client ID returns UNSUPPORTED_CLIENT');
  } finally {
    cleanup(root);
  }
}

process.exitCode = t.summary();
