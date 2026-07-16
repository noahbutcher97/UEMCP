// Release-gated client launch resolution and adapter contract tests.
//
// Run: cd server && node test-client-adapters.mjs

import { randomUUID } from 'node:crypto';
import * as asyncFs from 'node:fs/promises';
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { TestRunner } from './test-helpers.mjs';
import {
  CLAUDE_NATIVE_MUTATION_CHARACTERIZATION,
  classifyClaudeNativeStatus,
  createClaudeAdapter,
  physicalClaudeEntry,
  resolveClaudeLocations,
} from './deployment/adapters/claude.mjs';
import {
  CODEX_NATIVE_MUTATION_CHARACTERIZATION,
  classifyCodexNativeStatus,
  createCodexAdapter,
  physicalCodexEntry,
  resolveCodexLocations,
} from './deployment/adapters/codex.mjs';
import { sha256Bytes } from './deployment/canonical-json.mjs';
import {
  CLIENT_IDS,
  RELEASE_GATES,
  classifySupportedVersion,
  validateClientLaunchContract,
} from './deployment/client-contract.mjs';
import { resolveClientLaunch } from './deployment/client-process.mjs';
import { captureClientPathFingerprint, createClientTransaction } from './deployment/client-transaction.mjs';
import { createLocalState } from './deployment/local-state.mjs';
import { ownedPathsForClient, recordOwnedWrite } from './deployment/ownership-ledger.mjs';
import { getTomlTable, parseTomlDocument, patchTomlTable } from './deployment/toml-config.mjs';

const t = new TestRunner('Client Adapter Tests');
const clientConfigSamples = join(import.meta.dirname, 'fixtures', 'client-config');
const TEST_PLAN_DIGEST = 'a'.repeat(64);

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

function sample(name, replacements = {}) {
  let value = readFileSync(join(clientConfigSamples, name), 'utf8');
  for (const [token, replacement] of Object.entries(replacements)) {
    value = value.replaceAll(`__${token}__`, JSON.stringify(replacement).slice(1, -1));
  }
  return value;
}

function memoryOwnershipLedger() {
  let value = null;
  const writes = [];
  return {
    writes,
    async read() {
      return value === null ? null : structuredClone(value);
    },
    async write(next) {
      value = structuredClone(next);
      writes.push(structuredClone(next));
    },
    now: () => '2026-07-16T12:00:00.000Z',
  };
}

function simpleFingerprint(path) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    return {
      canonical_path: absolute,
      real_path: absolute,
      exists: false,
      kind: 'absent',
      link_kind: 'none',
      link_count: 0,
      size: 0,
      content_sha256: null,
      metadata_sha256: null,
      stream_count: 0,
      stream_bytes: 0,
      mode: null,
      atime_ms: null,
      mtime_ms: null,
      identity: null,
    };
  }
  const stat = statSync(absolute);
  const bytes = readFileSync(absolute);
  return {
    canonical_path: absolute,
    real_path: absolute,
    exists: true,
    kind: 'file',
    link_kind: 'none',
    link_count: Number(stat.nlink),
    size: bytes.length,
    content_sha256: sha256Bytes(bytes),
    metadata_sha256: 'b'.repeat(64),
    stream_count: 0,
    stream_bytes: 0,
    mode: Number(stat.mode),
    atime_ms: Number(stat.atimeMs),
    mtime_ms: Number(stat.mtimeMs),
    identity: { dev: Number(stat.dev), ino: Number(stat.ino), birthtime_ms: Number(stat.birthtimeMs) },
  };
}

function claudeLaunch(root, { version = '2.1.210', writeSupported = version === '2.1.210' } = {}) {
  const node = write(join(root, 'runtime', 'node.exe'), 'node');
  const entry = write(join(root, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.mjs'), 'export {};\n');
  return {
    client_id: 'claude',
    command: resolve(node),
    args_prefix: [resolve(entry)],
    env_overlay: {},
    package_id: '@anthropic-ai/claude-code',
    source: 'npm_package',
    version,
    compatibility: writeSupported ? 'release_gated' : 'unknown_newer',
    write_supported: writeSupported,
    fingerprint: { command: { sha256: 'c'.repeat(64) }, args_prefix: [{ sha256: 'd'.repeat(64) }] },
  };
}

function canonicalDesired(root) {
  return {
    name: 'uemcp',
    transport: 'stdio',
    command: resolve(write(join(root, 'server-runtime', 'node.exe'), 'node')),
    args: [resolve(write(join(root, 'server-runtime', 'server.mjs'), 'export {};\n'))],
    env: {},
    cwd: null,
  };
}

function claudeNativeRunner(outputs = {}) {
  const calls = [];
  return {
    calls,
    async run(executable, args, options = {}) {
      calls.push({ executable, args: [...args], options: { ...options, env: { ...options.env } } });
      if (args.includes('add') || args.includes('add-json') || args.includes('remove')) {
        throw Object.assign(new Error('mutating Claude MCP command was attempted'), { code: 'MUTATING_NATIVE_COMMAND' });
      }
      if (args.at(-1) === 'list') return outputs.list ?? { status: 'exited', exitCode: 0, stdout: '', stderr: '' };
      if (args.at(-2) === 'get' && args.at(-1) === 'uemcp') {
        return outputs.get ?? { status: 'exited', exitCode: 1, stdout: '', stderr: 'No MCP server found with name uemcp' };
      }
      throw Object.assign(new Error('unexpected Claude MCP query'), { code: 'UNEXPECTED_NATIVE_QUERY' });
    },
  };
}

function claudeContext(root, overrides = {}) {
  const env = { ...environment(root), ...overrides.env };
  const workspaceRoot = resolve(overrides.workspaceRoot ?? join(root, 'workspace'));
  mkdirSync(workspaceRoot, { recursive: true });
  const descriptor = overrides.descriptor ?? canonicalDesired(root);
  const knownFolders = overrides.knownFolders ?? { programFiles: env.ProgramFiles };
  return {
    env,
    workspaceRoot,
    workspaceTrusted: overrides.workspaceTrusted ?? false,
    invocationPolicyKnown: overrides.invocationPolicyKnown ?? true,
    planDigest: overrides.planDigest ?? TEST_PLAN_DIGEST,
    launch: overrides.launch ?? claudeLaunch(root),
    descriptor,
    ownershipLedger: overrides.ownershipLedger ?? memoryOwnershipLedger(),
    pluginMcpEntries: overrides.pluginMcpEntries ?? [],
    settingsTracking: overrides.settingsTracking ?? {},
    knownFolders,
    ...overrides,
    env,
    workspaceRoot,
    descriptor,
    knownFolders,
  };
}

function codexLaunch(root, { version = '0.144.4', writeSupported = version === '0.144.4' } = {}) {
  const node = write(join(root, 'runtime', 'node.exe'), 'node');
  const entry = write(join(root, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), 'export {};\n');
  return {
    client_id: 'codex',
    command: resolve(node),
    args_prefix: [resolve(entry)],
    env_overlay: {},
    package_id: '@openai/codex',
    source: 'npm_package',
    version,
    compatibility: writeSupported ? 'release_gated' : 'unknown_newer',
    write_supported: writeSupported,
    fingerprint: { command: { sha256: 'c'.repeat(64) }, args_prefix: [{ sha256: 'd'.repeat(64) }] },
  };
}

function codexNativeJson(descriptor, overrides = {}) {
  return JSON.stringify({
    name: 'uemcp',
    enabled: true,
    disabled_reason: null,
    transport: {
      type: 'stdio',
      command: descriptor.command,
      args: descriptor.args,
      env: null,
      env_vars: [],
      cwd: null,
    },
    startup_timeout_sec: null,
    tool_timeout_sec: null,
    ...overrides,
  });
}

function codexNativeRunner(root, outputs = {}) {
  const calls = [];
  return {
    calls,
    async run(executable, args, options = {}) {
      calls.push({ executable, args: [...args], options: { ...options, env: { ...options.env } } });
      const mcpIndex = args.indexOf('mcp');
      if (mcpIndex < 0) throw Object.assign(new Error('unexpected Codex command'), { code: 'UNEXPECTED_NATIVE_QUERY' });
      const tail = args.slice(mcpIndex + 1);
      if (tail[0] === 'list' && tail[1] === '--json') {
        return typeof outputs.list === 'function'
          ? outputs.list({ executable, args, options, tail })
          : outputs.list ?? { status: 'exited', exitCode: 0, stdout: '[]\n', stderr: '' };
      }
      if (tail[0] === 'get' && tail[1] === 'uemcp' && tail[2] === '--json') {
        return typeof outputs.get === 'function'
          ? outputs.get({ executable, args, options, tail })
          : outputs.get ?? { status: 'exited', exitCode: 1, stdout: '', stderr: "MCP server 'uemcp' not found" };
      }
      if (tail[0] === 'add' && tail[1] === 'uemcp' && tail[2] === '--') {
        if (outputs.rejectMutation) throw Object.assign(new Error('mutating Codex MCP command was attempted'), { code: 'MUTATING_NATIVE_COMMAND' });
        if (outputs.add) return outputs.add({ executable, args, options, tail });
        const command = tail[3];
        const launchArgs = tail.slice(4);
        const home = options.env.CODEX_HOME;
        const configPath = join(home, 'config.toml');
        const before = existsSync(configPath) ? readFileSync(configPath) : Buffer.alloc(0);
        const document = parseTomlDocument(before, { pathLabel: 'Codex native test config' });
        const edit = patchTomlTable(document, ['mcp_servers', 'uemcp'], { command, args: launchArgs });
        write(configPath, edit.after_bytes);
        return { status: 'exited', exitCode: 0, stdout: "Added global MCP server 'uemcp'.\n", stderr: '' };
      }
      throw Object.assign(new Error('unexpected Codex MCP query'), { code: 'UNEXPECTED_NATIVE_QUERY' });
    },
  };
}

function codexContext(root, overrides = {}) {
  const baseEnv = environment(root);
  const env = { ...baseEnv, CODEX_HOME: resolve(join(root, 'codex-home')), ...overrides.env };
  const projectRoot = resolve(overrides.projectRoot ?? join(root, 'workspace'));
  const activeDirectory = resolve(overrides.activeDirectory ?? projectRoot);
  mkdirSync(activeDirectory, { recursive: true });
  const descriptor = overrides.descriptor ?? canonicalDesired(root);
  const knownFolders = overrides.knownFolders ?? { programData: resolve(join(root, 'ProgramData')) };
  return {
    env,
    workspaceRoot: projectRoot,
    projectRoot,
    activeDirectory,
    workspaceTrusted: overrides.workspaceTrusted ?? false,
    invocationPolicyKnown: overrides.invocationPolicyKnown ?? true,
    planDigest: overrides.planDigest ?? TEST_PLAN_DIGEST,
    launch: overrides.launch ?? codexLaunch(root),
    descriptor,
    ownershipLedger: overrides.ownershipLedger ?? memoryOwnershipLedger(),
    knownFolders,
    ...overrides,
    env,
    workspaceRoot: projectRoot,
    projectRoot,
    activeDirectory,
    descriptor,
    knownFolders,
  };
}

function adapterTransaction(ledger) {
  const writes = [];
  const deletes = [];
  return {
    writes,
    deletes,
    ownershipLedger: {
      ...ledger,
      async write(value) {
        writes.push({ path: '<ownership-ledger>', value: structuredClone(value) });
        return ledger.write(value);
      },
    },
    async writeFile(path, bytes, options = {}) {
      writes.push({ path: resolve(path), bytes: Buffer.from(bytes) });
      write(path, Buffer.from(bytes));
      if (options.parse) await options.parse(Buffer.from(bytes));
      return { path: resolve(path), content_sha256: sha256Bytes(Buffer.from(bytes)), metadata_sha256: 'e'.repeat(64) };
    },
    async runStagedWrite(path, mutate, options = {}) {
      const stageRoot = join(tmpdir(), `uemcp-client-adapter-stage-${randomUUID()}`);
      const stagedPath = resolve(join(stageRoot, options.stage_relative_path));
      mkdirSync(dirname(stagedPath), { recursive: true });
      writeFileSync(stagedPath, Buffer.from(options.seed_bytes ?? Buffer.alloc(0)));
      try {
        await mutate(stagedPath, Object.freeze({ root: resolve(stageRoot), relative_path: options.stage_relative_path }));
        const bytes = readFileSync(stagedPath);
        if (options.parse) await options.parse(bytes);
        writes.push({ path: resolve(path), bytes: Buffer.from(bytes), external: true });
        write(path, bytes);
        return { path: resolve(path), content_sha256: sha256Bytes(bytes), metadata_sha256: 'e'.repeat(64) };
      } finally {
        rmSync(stageRoot, { recursive: true, force: true });
      }
    },
    async deleteFileAfterVerify(path) {
      deletes.push(resolve(path));
    },
  };
}

function transactionWindowsNative() {
  return {
    async fingerprintWindowsFileMetadata(path) {
      const stat = await asyncFs.lstat(path);
      return {
        metadata_sha256: sha256Bytes(Buffer.from(`${stat.mode}:${stat.birthtimeMs}`, 'utf8')),
        stream_count: 0,
        stream_bytes: 0,
      };
    },
    async replaceFilePreservingMetadata({ replacementPath, destinationPath }) {
      const bytes = await asyncFs.readFile(replacementPath);
      await asyncFs.writeFile(destinationPath, bytes);
      await asyncFs.rm(replacementPath, { force: true });
      return { status: 'replaced' };
    },
  };
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

// Claude locations honor an isolated config home without changing project or managed roots.
{
  const root = makeRoot();
  try {
    const context = claudeContext(root, { env: { CLAUDE_CONFIG_DIR: resolve(join(root, 'isolated-claude')) } });
    const locations = resolveClaudeLocations(context);
    t.assert(locations.state.path === resolve(join(root, 'isolated-claude', '.claude.json')), 'Claude isolated state file is beneath CLAUDE_CONFIG_DIR');
    t.assert(locations.user_settings.path === resolve(join(root, 'isolated-claude', 'settings.json')), 'Claude isolated settings file is beneath CLAUDE_CONFIG_DIR');
    t.assert(locations.project_config.path === resolve(join(context.workspaceRoot, '.mcp.json')), 'Claude project config remains rooted in the active workspace');
    t.assert(locations.managed_config.path === resolve(join(context.env.ProgramFiles, 'ClaudeCode', 'managed-mcp.json')), 'Claude managed MCP path uses the fixed Program Files policy root');
    t.assert(locations.project_settings.path.endsWith(join('.claude', 'settings.json')) && locations.local_settings.path.endsWith(join('.claude', 'settings.local.json')), 'Claude project approval paths are both enumerated');
  } finally {
    cleanup(root);
  }
}

// Absent Claude state plans one private user registration, while unknown versions remain inspect-only.
{
  const root = makeRoot();
  try {
    const runner = claudeNativeRunner();
    const adapter = createClaudeAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root);
    const detection = await adapter.detect(context);
    const inspection = await adapter.inspect(context, detection);
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.registration === 'ABSENT' && inspection.occurrences.length === 0, 'Claude inspection distinguishes an absent registration');
    t.assert(inspection.native.status === 'ABSENT', 'Claude native omission remains separate absent evidence');
    t.assert(plan.status === 'CREATE' && plan.operations.length === 1 && plan.operations[0].type === 'CREATE_ENTRY', 'Claude absent state plans one user create');
    t.assert(plan.operations[0].scope_kind === 'user' && plan.operations[0].path === detection.locations.state.path, 'Claude create targets private user state');
    t.assert(JSON.stringify(plan.operations[0].desired_entry) === JSON.stringify(physicalClaudeEntry(context.descriptor)), 'Claude create contains only the physical canonical entry');
    t.assert(!JSON.stringify(plan).includes('UNREAL_PROJECT_ROOT') && !JSON.stringify(plan).includes('env'), 'Claude default plan does not author environment state');
    t.assert(plan.operations[0].read_only_paths.some(row => row.path === detection.locations.user_settings.path), 'Claude plan binds read-only approval evidence');
    const boundPaths = new Set(plan.operations[0].read_only_paths.map(row => row.path));
    t.assert([context.launch.command, ...context.launch.args_prefix, context.descriptor.command, ...context.descriptor.args].every(path => boundPaths.has(resolve(path))), 'Claude plan binds client-launch and server-descriptor files as read-only evidence');

    const unsupportedContext = claudeContext(root, { launch: claudeLaunch(root, { version: '2.2.0', writeSupported: false }) });
    const unsupportedDetection = await adapter.detect(unsupportedContext);
    const unsupportedInspection = await adapter.inspect(unsupportedContext, unsupportedDetection);
    const unsupportedPlan = await adapter.plan(unsupportedContext, unsupportedInspection, unsupportedContext.descriptor);
    t.assert(unsupportedPlan.status === 'UNSUPPORTED_VERSION' && unsupportedPlan.operations.length === 0, 'unknown Claude version cannot plan a write');
  } finally {
    cleanup(root);
  }
}

// Exact unowned Claude entries are adopted visibly without leaking or rewriting custom launch state.
{
  const root = makeRoot();
  try {
    const ledger = memoryOwnershipLedger();
    const runner = claudeNativeRunner({
      list: { status: 'exited', exitCode: 0, stdout: sample('claude-native-connected.txt'), stderr: '' },
      get: { status: 'exited', exitCode: 0, stdout: sample('claude-native-connected.txt'), stderr: '' },
    });
    const adapter = createClaudeAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root, { ownershipLedger: ledger });
    const locations = resolveClaudeLocations(context);
    write(locations.state.path, sample('claude-user-exact.jsonc', {
      NODE: context.descriptor.command,
      SERVER: context.descriptor.args[0],
    }));
    const before = readFileSync(locations.state.path);
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const serialized = JSON.stringify(inspection);
    t.assert(inspection.registration === 'CONFIGURED' && inspection.effective.scope === 'user', 'Claude exact user entry is structurally configured');
    t.assert(inspection.actions.includes('CUSTOM_ENV_REVIEW_REQUIRED') && inspection.actions.includes('CUSTOM_LAUNCH_REVIEW_REQUIRED'), 'Claude reports custom environment and working-directory review separately');
    t.assert(!serialized.includes('do-not-serialize') && !serialized.includes('preserve-me'), 'Claude inspection redacts environment values');
    t.assert(serialized.includes('UEMCP_PRIVATE_TOKEN') && serialized.includes('HARMLESS'), 'Claude inspection retains environment key names as review evidence');
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'ADOPT' && plan.operations.length === 1 && plan.operations[0].type === 'ADOPT_EXACT_ENTRY', 'Claude exact unowned entry requires visible adoption');
    const transaction = adapterTransaction(ledger);
    const applied = await adapter.apply({ ...context, transaction }, plan.operations);
    t.assert(applied.status === 'APPLIED' && transaction.writes.length === 1 && transaction.writes[0].path === '<ownership-ledger>', 'Claude adoption writes only the ownership ledger');
    t.assert(readFileSync(locations.state.path).equals(before), 'Claude adoption preserves provider config byte-for-byte');
    const ownedInspection = await adapter.inspect(context, await adapter.detect(context));
    const ownedPlan = await adapter.plan(context, ownedInspection, context.descriptor);
    t.assert(ownedPlan.status === 'NO_OP' && ownedPlan.operations.length === 0, 'owned exact Claude entry becomes an idempotent no-op');
  } finally {
    cleanup(root);
  }
}

// Claude precedence is local, project, user, plugin; managed configuration is exclusive.
{
  const root = makeRoot();
  try {
    const adapter = createClaudeAdapter({ runner: claudeNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root, {
      pluginMcpEntries: [{
        plugin_id: 'sample-plugin',
        enabled: true,
        mcp_servers: { uemcp: physicalClaudeEntry(canonicalDesired(root)) },
      }],
    });
    const locations = resolveClaudeLocations(context);
    const desired = physicalClaudeEntry(context.descriptor);
    writeJson(locations.state.path, {
      mcpServers: { uemcp: desired },
      projects: { [context.workspaceRoot]: { mcpServers: { uemcp: desired } } },
    });
    write(locations.project_config.path, sample('claude-project-conflict.json'));
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.effective.scope === 'local' && inspection.registration === 'CONFIGURED', 'Claude local scope wins over project and user entries');
    t.assert(inspection.occurrences.map(row => row.scope).join(',') === 'local,project,user,plugin', 'Claude reports all same-name occurrences in precedence order');

    const state = JSON.parse(readFileSync(locations.state.path, 'utf8'));
    delete state.projects;
    writeJson(locations.state.path, state);
    inspection = await adapter.inspect(context, await adapter.detect(context));
    const shadowPlan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.effective.scope === 'project' && inspection.registration === 'CONFLICT', 'Claude project conflict shadows an exact user entry');
    t.assert(shadowPlan.status === 'CONFLICT' && shadowPlan.operations.length === 0, 'Claude shadow conflict cannot be replaced implicitly');

    write(locations.managed_config.path, sample('claude-managed-exact.json', {
      NODE: context.descriptor.command,
      SERVER: context.descriptor.args[0],
    }));
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.effective.scope === 'managed' && inspection.registration === 'CONFIGURED', 'Claude managed entry becomes the exclusive effective definition');
    t.assert((await adapter.plan(context, inspection, context.descriptor)).operations.length === 0, 'Claude never authors user config under exclusive managed MCP control');

    writeJson(locations.managed_config.path, { mcpServers: {} });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.enablement === 'POLICY_BLOCKED' && inspection.registration === 'POLICY_BLOCKED', 'empty managed MCP policy blocks all user and plugin servers');
  } finally {
    cleanup(root);
  }
}

// Project approval, workspace trust, disablement, and native activation remain independent evidence.
{
  const cases = [
    { label: 'user approval before trust', settings: 'user', trusted: false, expectedEnablement: 'ENABLED', expectedActivation: 'UNKNOWN' },
    { label: 'tracked project approval before trust', settings: 'project', trusted: false, expectedEnablement: 'UNKNOWN', expectedActivation: 'PENDING_TRUST' },
    { label: 'untracked local approval before trust', settings: 'local', trusted: false, expectedEnablement: 'UNKNOWN', expectedActivation: 'PENDING_TRUST' },
    { label: 'project approval after trust', settings: 'project', trusted: true, expectedEnablement: 'ENABLED', expectedActivation: 'UNKNOWN' },
  ];
  for (const testCase of cases) {
    const root = makeRoot();
    try {
      const adapter = createClaudeAdapter({ runner: claudeNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
      const context = claudeContext(root, { workspaceTrusted: testCase.trusted });
      const locations = resolveClaudeLocations(context);
      writeJson(locations.project_config.path, { mcpServers: { uemcp: physicalClaudeEntry(context.descriptor) } });
      const settingsPath = testCase.settings === 'user'
        ? locations.user_settings.path
        : testCase.settings === 'project'
          ? locations.project_settings.path
          : locations.local_settings.path;
      const settingsSample = testCase.settings === 'user'
        ? 'claude-settings-user.json'
        : testCase.settings === 'project'
          ? 'claude-settings-project.json'
          : 'claude-settings-local.json';
      write(settingsPath, sample(settingsSample, {
        NODE: context.descriptor.command,
        SERVER: context.descriptor.args[0],
      }));
      const inspection = await adapter.inspect(context, await adapter.detect(context));
      t.assert(inspection.enablement === testCase.expectedEnablement && inspection.activation === testCase.expectedActivation, `Claude ${testCase.label} follows trust-aware approval semantics`);
    } finally {
      cleanup(root);
    }
  }
}

// Deny policy remains blocked even when native status says connected, and the disagreement is explicit.
{
  const root = makeRoot();
  try {
    const connected = sample('claude-native-connected.txt');
    const runner = claudeNativeRunner({
      list: { status: 'exited', exitCode: 0, stdout: connected, stderr: '' },
      get: { status: 'exited', exitCode: 0, stdout: connected, stderr: '' },
    });
    const adapter = createClaudeAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root, { workspaceTrusted: true });
    const locations = resolveClaudeLocations(context);
    writeJson(locations.project_config.path, { mcpServers: { uemcp: physicalClaudeEntry(context.descriptor) } });
    write(locations.managed_settings.path, sample('claude-settings-managed-deny.json', {
      NODE: context.descriptor.command,
      SERVER: context.descriptor.args[0],
    }));
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.enablement === 'POLICY_BLOCKED' && inspection.activation === 'CONNECTED', 'Claude native connected status wins only the activation field');
    t.assert(inspection.native.disagrees_with_structural_policy === true && inspection.actions.includes('CLIENT_ENABLEMENT_REQUIRED'), 'Claude native-policy disagreement remains explicit');
  } finally {
    cleanup(root);
  }
}

// Malformed and over-limit Claude evidence fails closed before planning writes.
{
  for (const testCase of [
    { label: 'malformed user state', target: 'state', content: '{ broken' },
    { label: 'malformed project config', target: 'project_config', content: '{ broken' },
    { label: 'malformed approval settings', target: 'user_settings', content: '{ broken' },
  ]) {
    const root = makeRoot();
    try {
      const adapter = createClaudeAdapter({ runner: claudeNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
      const context = claudeContext(root);
      const locations = resolveClaudeLocations(context);
      write(locations[testCase.target].path, testCase.content);
      const inspection = await adapter.inspect(context, await adapter.detect(context));
      const plan = await adapter.plan(context, inspection, context.descriptor);
      t.assert(inspection.registration === 'MALFORMED_CONFIG' && plan.operations.length === 0, `Claude ${testCase.label} blocks writes`);
    } finally {
      cleanup(root);
    }
  }

  const root = makeRoot();
  try {
    let oversizedCaptured = false;
    const context = claudeContext(root);
    const oversizedPath = resolveClaudeLocations(context).state.path;
    const adapter = createClaudeAdapter({
      runner: claudeNativeRunner(),
      captureFingerprint: async path => {
        if (resolve(path) === oversizedPath) oversizedCaptured = true;
        return simpleFingerprint(path);
      },
      limits: { fileBytes: 32, aggregateBytes: 64, pluginRecords: 4 },
    });
    write(oversizedPath, JSON.stringify({ padding: 'x'.repeat(64) }));
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'INSPECTION_LIMIT_EXCEEDED' && (await adapter.plan(context, inspection, context.descriptor)).operations.length === 0, 'Claude byte-limit failure never becomes absence or a partial plan');
    t.assert(oversizedCaptured === false, 'Claude rejects an oversized config before asking the fingerprint layer to hash it');
  } finally {
    cleanup(root);
  }

  const racingRoot = makeRoot();
  try {
    const context = claudeContext(racingRoot);
    const locations = resolveClaudeLocations(context);
    write(locations.state.path, '{"mcpServers":{}}\n');
    let mutated = false;
    const adapter = createClaudeAdapter({
      runner: claudeNativeRunner(),
      captureFingerprint: async path => {
        const fingerprint = simpleFingerprint(path);
        if (!mutated && resolve(path) === locations.state.path) {
          mutated = true;
          write(locations.state.path, '{"mcpServers":{"other":{"command":"changed"}}}\n');
        }
        return fingerprint;
      },
    });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.registration === 'UNSAFE_CONFIG_PATH' && plan.operations.length === 0, 'config mutation between fingerprint and parse fails closed without a partial plan');
  } finally {
    cleanup(racingRoot);
  }
}

// Native output classification is bounded, read-only, and independent from structural config.
{
  t.assert(classifyClaudeNativeStatus({ status: 'exited', exitCode: 0, stdout: sample('claude-native-connected.txt'), stderr: '' }).status === 'CONNECTED', 'Claude native parser recognizes connected status');
  t.assert(classifyClaudeNativeStatus({ status: 'exited', exitCode: 0, stdout: sample('claude-native-pending.txt'), stderr: '' }).status === 'PENDING_APPROVAL', 'Claude native parser recognizes pending approval');
  t.assert(classifyClaudeNativeStatus({ status: 'exited', exitCode: 0, stdout: sample('claude-native-rejected.txt'), stderr: '' }).status === 'REJECTED', 'Claude native parser recognizes rejected status');
  t.assert(classifyClaudeNativeStatus({ status: 'exited', exitCode: 1, stdout: '', stderr: 'No MCP server found with name uemcp' }).status === 'ABSENT', 'Claude native parser recognizes absent target');
  t.assert(classifyClaudeNativeStatus({ status: 'timed_out', exitCode: null, stdout: '', stderr: '' }).status === 'TIMEOUT', 'Claude native parser preserves timeout distinctly');
  t.assert(classifyClaudeNativeStatus({ status: 'exited', exitCode: 0, stdout: sample('claude-native-unrelated.txt'), stderr: '' }).status === 'ABSENT', 'Claude native parser ignores unrelated servers');

  const root = makeRoot();
  try {
    const runner = claudeNativeRunner();
    const adapter = createClaudeAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root);
    await adapter.inspect(context, await adapter.detect(context));
    t.assert(runner.calls.length === 2, 'Claude inspection performs list and named get read-only queries');
    t.assert(runner.calls.every(call => call.options.shell === false && call.options.timeoutMs <= 10_000 && call.options.outputLimitBytes <= 64 * 1024), 'Claude native inspection is shell-free and bounded');
    t.assert(runner.calls.every(call => call.args.includes('mcp') && (call.args.at(-1) === 'list' || (call.args.at(-2) === 'get' && call.args.at(-1) === 'uemcp'))), 'Claude production inspection never invokes a mutating MCP subcommand');
  } finally {
    cleanup(root);
  }
}

// Owned Claude updates patch only type, command, and args while preserving custom fields.
{
  const root = makeRoot();
  try {
    const ledger = memoryOwnershipLedger();
    const adapter = createClaudeAdapter({ runner: claudeNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root, { ownershipLedger: ledger });
    const locations = resolveClaudeLocations(context);
    const oldEntry = {
      type: 'stdio',
      command: resolve(write(join(root, 'old', 'node.exe'), 'node')),
      args: [resolve(write(join(root, 'old', 'server.mjs'), 'export {};\n'))],
      cwd: resolve(join(root, 'pinned-workspace')),
      env: { UEMCP_PRIVATE_TOKEN: 'secret-value', HARMLESS: 'keep-value' },
      startup_timeout_sec: 45,
    };
    writeJson(locations.state.path, { unrelated: { keep: true }, mcpServers: { other: { type: 'http', url: 'https://example.invalid' }, uemcp: oldEntry } });
    const beforeBytes = readFileSync(locations.state.path);
    await recordOwnedWrite({
      ledger,
      location: { clientId: 'claude', configPath: locations.state.path, scope: 'user', entryName: 'uemcp' },
      beforeEntry: null,
      afterEntry: oldEntry,
      ownedPaths: ownedPathsForClient('claude', oldEntry),
      appliedConfigHash: sha256Bytes(beforeBytes),
      planDigest: TEST_PLAN_DIGEST,
    });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'UPDATE' && plan.operations.length === 1 && plan.operations[0].type === 'UPDATE_OWNED_FIELDS', 'Claude owned stale descriptor plans a targeted update');
    const transaction = adapterTransaction(ledger);
    await adapter.apply({ ...context, transaction }, plan.operations);
    const after = JSON.parse(readFileSync(locations.state.path, 'utf8'));
    t.assert(after.mcpServers.uemcp.command === context.descriptor.command && JSON.stringify(after.mcpServers.uemcp.args) === JSON.stringify(context.descriptor.args), 'Claude update writes canonical command and args');
    t.assert(after.mcpServers.uemcp.type === 'stdio' && after.mcpServers.uemcp.cwd === oldEntry.cwd && after.mcpServers.uemcp.startup_timeout_sec === 45, 'Claude update preserves custom launch and timeout fields');
    t.assert(JSON.stringify(after.mcpServers.uemcp.env) === JSON.stringify(oldEntry.env) && after.mcpServers.other.url === 'https://example.invalid' && after.unrelated.keep, 'Claude update preserves environment, unrelated servers, and top-level state');
    t.assert(transaction.writes.map(row => row.path).sort().join('|') === ['<ownership-ledger>', locations.state.path].sort().join('|'), 'Claude apply writes only the planned config and ownership ledger');
  } finally {
    cleanup(root);
  }
}

// Legacy project migration is explicit, paired with user registration, and deletes only proven installer-created empty files.
{
  const root = makeRoot();
  try {
    const ledger = memoryOwnershipLedger();
    const adapter = createClaudeAdapter({ runner: claudeNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root, {
      ownershipLedger: ledger,
      migrateLegacyProject: true,
      legacyProjectInstallerCreated: true,
    });
    const locations = resolveClaudeLocations(context);
    write(locations.project_config.path, sample('claude-old-setup.json', {
      NODE: context.descriptor.command,
      SERVER: context.descriptor.args[0],
    }));
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'MIGRATE' && plan.operations.map(row => row.type).join(',') === 'MIGRATE_PROJECT_ENTRY,CREATE_ENTRY', 'Claude legacy migration and user registration share one reviewed plan');
    const transaction = adapterTransaction(ledger);
    await adapter.apply({ ...context, transaction }, plan.operations);
    const projectAfter = JSON.parse(readFileSync(locations.project_config.path, 'utf8'));
    t.assert(projectAfter.mcpServers.uemcp === undefined && transaction.deletes.length === 1 && transaction.deletes[0] === locations.project_config.path, 'Claude migration removes only uemcp and defers deletion of a proven installer-created empty file');
    t.assert(JSON.parse(readFileSync(locations.state.path, 'utf8')).mcpServers.uemcp.type === 'stdio', 'Claude migration creates the canonical private user entry');
  } finally {
    cleanup(root);
  }
}

{
  const root = makeRoot();
  try {
    const ledger = memoryOwnershipLedger();
    const adapter = createClaudeAdapter({ runner: claudeNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root, {
      ownershipLedger: ledger,
      migrateLegacyProject: true,
      legacyProjectInstallerCreated: true,
    });
    const locations = resolveClaudeLocations(context);
    writeJson(locations.project_config.path, {
      mcpServers: {
        uemcp: physicalClaudeEntry(context.descriptor),
        other: { type: 'http', url: 'https://example.invalid' },
      },
      teamMetadata: true,
    });
    const plan = await adapter.plan(context, await adapter.inspect(context, await adapter.detect(context)), context.descriptor);
    const transaction = adapterTransaction(ledger);
    await adapter.apply({ ...context, transaction }, plan.operations);
    const projectAfter = JSON.parse(readFileSync(locations.project_config.path, 'utf8'));
    t.assert(projectAfter.mcpServers.uemcp === undefined && projectAfter.mcpServers.other.url === 'https://example.invalid' && projectAfter.teamMetadata, 'Claude migration preserves every unrelated project field');
    t.assert(transaction.deletes.length === 0, 'Claude migration never deletes a nonempty project config');
  } finally {
    cleanup(root);
  }
}

// The installed 2.1.210 observation permanently forbids native mutation in production apply.
{
  const observed = JSON.parse(sample('claude-2.1.210-add-json-observation.json'));
  t.assert(observed.version === CLAUDE_NATIVE_MUTATION_CHARACTERIZATION.version, 'Claude native mutation characterization is version-bound');
  t.assert(observed.duplicate_same_name_exit_code === 1 && observed.duplicate_preserved_existing_config_sha256, 'Claude duplicate add-json behavior remains locked');
  t.assert(observed.isolated_config_outputs.some(path => path.startsWith('backups/')) && CLAUDE_NATIVE_MUTATION_CHARACTERIZATION.mutating_subcommands_allowed === false, 'Claude backup side effect keeps all native mutation disabled');
}

// Conflict inspection exposes hashes and field names, never raw command arguments or environment values.
{
  const root = makeRoot();
  try {
    const adapter = createClaudeAdapter({ runner: claudeNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root);
    const locations = resolveClaudeLocations(context);
    writeJson(locations.state.path, {
      mcpServers: {
        uemcp: {
          type: 'stdio',
          command: resolve(join(root, 'foreign', 'node.exe')),
          args: ['--token', 'SECRET_ARGUMENT_CANARY'],
          env: { API_TOKEN: 'SECRET_ENV_CANARY' },
        },
      },
    });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const serialized = JSON.stringify(inspection);
    t.assert(inspection.registration === 'CONFLICT', 'Claude hostile same-name entry remains a conflict');
    t.assert(!serialized.includes('SECRET_ARGUMENT_CANARY') && !serialized.includes('SECRET_ENV_CANARY') && !serialized.includes('--token'), 'Claude conflict evidence contains no raw argument or environment secret');
    t.assert(serialized.includes('args_sha256') && serialized.includes('API_TOKEN'), 'Claude conflict evidence retains hash and environment-key diagnostics');
  } finally {
    cleanup(root);
  }
}

// Known Claude settings keys with invalid shapes fail closed as malformed policy evidence.
{
  const invalidSettings = [
    { enableAllProjectMcpServers: 'yes' },
    { enabledMcpjsonServers: 'uemcp' },
    { disabledMcpjsonServers: [42] },
    { allowManagedMcpServersOnly: 'true' },
    { allowedMcpServers: [{ serverCommand: 'node server.mjs' }] },
    { deniedMcpServers: [{ serverName: 'uemcp', extra: true }] },
  ];
  for (const [index, settings] of invalidSettings.entries()) {
    const root = makeRoot();
    try {
      const adapter = createClaudeAdapter({ runner: claudeNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
      const context = claudeContext(root);
      writeJson(resolveClaudeLocations(context).user_settings.path, settings);
      const inspection = await adapter.inspect(context, await adapter.detect(context));
      t.assert(inspection.registration === 'MALFORMED_CONFIG', `Claude invalid known settings shape ${index + 1} blocks planning`);
    } finally {
      cleanup(root);
    }
  }
}

// Invalid ownership storage cannot produce an adoption operation that is guaranteed to fail during apply.
{
  const root = makeRoot();
  try {
    const ledger = {
      async read() { return '{broken'; },
      async write() { throw new Error('must not write invalid ownership storage'); },
      now: () => '2026-07-16T12:00:00.000Z',
    };
    const adapter = createClaudeAdapter({ runner: claudeNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root, { ownershipLedger: ledger });
    const locations = resolveClaudeLocations(context);
    writeJson(locations.state.path, { mcpServers: { uemcp: physicalClaudeEntry(context.descriptor) } });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'OWNERSHIP_LEDGER_INVALID' && plan.operations.length === 0, 'Claude invalid ownership storage blocks adoption before transaction apply');
  } finally {
    cleanup(root);
  }
}

// Inspection is read-only; only an explicit migration plan escalates the selected project path to a writable fingerprint.
{
  const root = makeRoot();
  try {
    const calls = [];
    const capture = async (path, options) => {
      calls.push({ path: resolve(path), writable: options.writable });
      return simpleFingerprint(path);
    };
    const adapter = createClaudeAdapter({ runner: claudeNativeRunner(), captureFingerprint: capture });
    const context = claudeContext(root, { migrateLegacyProject: true, legacyProjectInstallerCreated: true });
    const locations = resolveClaudeLocations(context);
    writeJson(locations.project_config.path, { mcpServers: { uemcp: physicalClaudeEntry(context.descriptor) } });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(calls.filter(call => call.path === locations.project_config.path).every(call => call.writable === false), 'Claude discovery never requires project write access');
    await adapter.plan(context, inspection, context.descriptor);
    t.assert(calls.some(call => call.path === locations.project_config.path && call.writable === true), 'Claude explicit migration planning validates project write access');
  } finally {
    cleanup(root);
  }
}

// Delete authority is present only when removing uemcp leaves a proven installer-created empty document.
{
  const root = makeRoot();
  try {
    const adapter = createClaudeAdapter({ runner: claudeNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root, { migrateLegacyProject: true, legacyProjectInstallerCreated: true });
    const locations = resolveClaudeLocations(context);
    writeJson(locations.project_config.path, {
      mcpServers: {
        uemcp: physicalClaudeEntry(context.descriptor),
        other: { type: 'http', url: 'https://example.invalid' },
      },
    });
    const plan = await adapter.plan(context, await adapter.inspect(context, await adapter.detect(context)), context.descriptor);
    const migration = plan.operations.find(operation => operation.type === 'MIGRATE_PROJECT_ENTRY');
    t.assert(migration.delete_after_verify === false && migration.installer_created_file === true, 'Claude nonempty project migration carries no file-delete authority');
  } finally {
    cleanup(root);
  }
}

// Native process-launch failures become bounded unknown evidence instead of aborting structural inspection.
{
  const root = makeRoot();
  try {
    const runner = {
      async run() {
        throw Object.assign(new Error('spawn failed'), { code: 'PROCESS_LAUNCH_FAILED' });
      },
    };
    const adapter = createClaudeAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root);
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'ABSENT' && inspection.native.status === 'UNKNOWN', 'Claude native launch failure preserves structural inspection with unknown activation');
  } finally {
    cleanup(root);
  }
}

// The real Claude adapter completes one central create transaction with structural and native verification.
{
  const root = makeRoot();
  try {
    const claudeHome = resolve(join(root, 'claude-home'));
    mkdirSync(claudeHome, { recursive: true });
    const context = claudeContext(root, { env: { CLAUDE_CONFIG_DIR: claudeHome } });
    const statePath = resolveClaudeLocations(context).state.path;
    const runner = {
      async run(executable, args, options) {
        const present = existsSync(statePath);
        const output = present ? sample('claude-native-connected.txt') : '';
        return args.at(-1) === 'list'
          ? { status: 'exited', exitCode: 0, stdout: output, stderr: '' }
          : present
            ? { status: 'exited', exitCode: 0, stdout: output, stderr: '' }
            : { status: 'exited', exitCode: 1, stdout: '', stderr: 'No MCP server found with name uemcp' };
      },
    };
    const windowsNative = transactionWindowsNative();
    const capture = (path, options) => captureClientPathFingerprint(path, {
      ...options,
      fsImpl: asyncFs,
      windowsNative,
    });
    const adapter = createClaudeAdapter({ runner, captureFingerprint: capture });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    const localState = createLocalState({
      root: join(root, 'local-state'),
      aclRestrictor: async () => {},
      processInspector: async () => 'alive',
    });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state],
      fsImpl: asyncFs,
      windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({
      planDigest: TEST_PLAN_DIGEST,
      adapters: [adapter],
      operations: plan.operations,
      context,
      ownershipFingerprint,
    });
    const result = await transaction.apply({
      planDigest: TEST_PLAN_DIGEST,
      adapters: [adapter],
      operations: plan.operations,
      context,
    });
    const config = JSON.parse(readFileSync(statePath, 'utf8'));
    t.assert(result.status === 'APPLIED' && result.clients[0].status === 'READY', 'Claude adapter transaction reaches structurally and natively verified apply');
    t.assert(config.mcpServers.uemcp.type === 'stdio' && config.mcpServers.uemcp.command === context.descriptor.command, 'Claude adapter transaction writes the canonical private user entry');
    t.assert(!Object.hasOwn(config.mcpServers.uemcp, 'env') && !Object.hasOwn(config.mcpServers.uemcp, 'cwd'), 'Claude adapter transaction omits default environment and working directory');
    t.assert(result.touched_files.map(row => row.path).sort().join('|') === [statePath, localState.paths().ownership].map(path => resolve(path)).sort().join('|'), 'Claude adapter transaction touches only provider config and ownership state');
  } finally {
    cleanup(root);
  }
}

// Managed policy discovery uses a trusted known-folder root, not a spoofable process environment value.
{
  const root = makeRoot();
  try {
    const trusted = resolve(join(root, 'trusted-program-files'));
    const spoofed = resolve(join(root, 'spoofed-program-files'));
    const context = claudeContext(root, {
      env: { ProgramFiles: spoofed },
      knownFolders: { programFiles: trusted },
    });
    const locations = resolveClaudeLocations(context);
    t.assert(locations.managed_config.path === resolve(join(trusted, 'ClaudeCode', 'managed-mcp.json')), 'Claude managed policy ignores spoofed ProgramFiles environment input');
  } finally {
    cleanup(root);
  }
}

// Native rejection overrides activation while preserving contradictory structural enablement evidence.
{
  const root = makeRoot();
  try {
    const rejected = sample('claude-native-rejected.txt');
    const runner = claudeNativeRunner({
      list: { status: 'exited', exitCode: 0, stdout: rejected, stderr: '' },
      get: { status: 'exited', exitCode: 0, stdout: rejected, stderr: '' },
    });
    const adapter = createClaudeAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const context = claudeContext(root);
    const locations = resolveClaudeLocations(context);
    writeJson(locations.state.path, { mcpServers: { uemcp: physicalClaudeEntry(context.descriptor) } });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.enablement === 'ENABLED' && inspection.activation === 'REJECTED', 'Claude native rejection wins activation without rewriting structural enablement');
    t.assert(inspection.native.disagrees_with_structural_policy === true, 'Claude rejected-versus-enabled disagreement remains explicit');
  } finally {
    cleanup(root);
  }
}

// Codex locations honor CODEX_HOME, enumerate trusted project layers, and use a trusted policy root.
{
  const root = makeRoot();
  try {
    const projectRoot = resolve(join(root, 'workspace'));
    const activeDirectory = resolve(join(projectRoot, 'Source', 'Nested'));
    const trustedProgramData = resolve(join(root, 'TrustedProgramData'));
    const context = codexContext(root, {
      projectRoot,
      activeDirectory,
      env: { ProgramData: resolve(join(root, 'SpoofedProgramData')) },
      knownFolders: { programData: trustedProgramData },
    });
    const locations = resolveCodexLocations(context);
    t.assert(locations.user.path === resolve(join(context.env.CODEX_HOME, 'config.toml')), 'Codex user config is rooted in CODEX_HOME');
    t.assert(locations.project_layers.map(row => row.path).join('|') === [
      join(projectRoot, '.codex', 'config.toml'),
      join(projectRoot, 'Source', '.codex', 'config.toml'),
      join(activeDirectory, '.codex', 'config.toml'),
    ].map(path => resolve(path)).join('|'), 'Codex project configs are enumerated root-to-active-directory');
    t.assert(locations.system_requirements.path === resolve(join(trustedProgramData, 'OpenAI', 'Codex', 'requirements.toml')), 'Codex requirements use the trusted ProgramData known folder');
    t.assert(await rejectsCode(() => Promise.resolve(resolveCodexLocations(codexContext(root, {
      projectRoot,
      activeDirectory: resolve(join(root, 'outside')),
    }))), 'INVALID_CLIENT_LOCATION'), 'Codex rejects an active directory outside the project root');
    const limitedAdapter = createCodexAdapter({
      runner: codexNativeRunner(root),
      captureFingerprint: async path => simpleFingerprint(path),
      limits: { projectLayers: 2 },
    });
    t.assert(await rejectsCode(() => limitedAdapter.detect(context), 'INSPECTION_LIMIT_EXCEEDED'), 'Codex detection honors the configured project-layer limit');
  } finally {
    cleanup(root);
  }
}

// Absent Codex config plans one native user create, while unknown versions remain inspect-only.
{
  const root = makeRoot();
  try {
    const runner = codexNativeRunner(root);
    const adapter = createCodexAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const context = codexContext(root);
    const detection = await adapter.detect(context);
    const inspection = await adapter.inspect(context, detection);
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.registration === 'ABSENT' && inspection.activation === 'UNKNOWN', 'Codex inspection distinguishes absent config from unproven activation');
    t.assert(plan.status === 'CREATE' && plan.operations.length === 1 && plan.operations[0].type === 'CREATE_ENTRY', 'Codex absence plans one user create');
    t.assert(plan.operations[0].external_write === true && plan.operations[0].path === detection.locations.user.path, 'Codex fresh create is explicitly bound to the native external-write capability');
    t.assert(JSON.stringify(plan.operations[0].desired_entry) === JSON.stringify(physicalCodexEntry(context.descriptor)), 'Codex create owns only command and args');
    const bound = new Set(plan.operations[0].read_only_paths.map(row => row.path));
    t.assert([context.launch.command, ...context.launch.args_prefix, context.descriptor.command, ...context.descriptor.args].every(path => bound.has(resolve(path))), 'Codex plan binds launch and descriptor evidence');
    t.assert(bound.has(detection.locations.system_requirements.path), 'Codex plan binds system requirements as read-only evidence');

    const unsupportedContext = codexContext(root, { launch: codexLaunch(root, { version: '0.145.0', writeSupported: false }) });
    const unsupportedInspection = await adapter.inspect(unsupportedContext, await adapter.detect(unsupportedContext));
    const unsupportedPlan = await adapter.plan(unsupportedContext, unsupportedInspection, unsupportedContext.descriptor);
    t.assert(unsupportedPlan.status === 'UNSUPPORTED_VERSION' && unsupportedPlan.operations.length === 0, 'unknown Codex version cannot plan a write');
  } finally {
    cleanup(root);
  }
}

// A missing table in an existing Codex file uses a targeted parser edit because native add reformats existing bytes.
{
  const root = makeRoot();
  try {
    const ledger = memoryOwnershipLedger();
    const context = codexContext(root, { ownershipLedger: ledger });
    const locations = resolveCodexLocations(context);
    const original = [
      '# Preserve existing Codex settings.',
      'model = "gpt-5.4"',
      '',
      '[mcp_servers.other]',
      'url = "https://example.invalid/mcp"',
      '',
    ].join('\n');
    write(locations.user.path, original);
    const runner = codexNativeRunner(root, { rejectMutation: true });
    const adapter = createCodexAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'CREATE' && plan.operations[0].external_write === false, 'Codex existing-file table creation uses the metadata-preserving parser path');
    await adapter.apply({ ...context, transaction: adapterTransaction(ledger) }, plan.operations);
    const after = readFileSync(locations.user.path);
    const parsed = parseTomlDocument(after);
    t.assert(after.toString('utf8').startsWith(original), 'Codex table creation preserves every existing byte as a prefix');
    t.assert(getTomlTable(parsed, ['mcp_servers', 'other']).url === 'https://example.invalid/mcp', 'Codex table creation preserves unrelated servers');
    t.assert(getTomlTable(parsed, ['mcp_servers', 'uemcp']).command === context.descriptor.command, 'Codex table creation appends the canonical owned projection');
    t.assert(!runner.calls.some(call => call.args.includes('add')), 'Codex existing-file table creation never invokes the reformatting native add path');
  } finally {
    cleanup(root);
  }
}

// Exact disabled Codex entries are adoptable without rewriting client-owned launch policy.
{
  const root = makeRoot();
  try {
    const ledger = memoryOwnershipLedger();
    const context = codexContext(root, { ownershipLedger: ledger });
    const locations = resolveCodexLocations(context);
    write(locations.user.path, sample('codex-user-exact.toml', {
      NODE: context.descriptor.command,
      SERVER: context.descriptor.args[0],
    }));
    const native = codexNativeJson(context.descriptor, { enabled: false, disabled_reason: 'disabled by configuration' });
    const runner = codexNativeRunner(root, {
      list: { status: 'exited', exitCode: 0, stdout: `[${native}]`, stderr: '' },
      get: { status: 'exited', exitCode: 0, stdout: native, stderr: '' },
      rejectMutation: true,
    });
    const adapter = createCodexAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const before = readFileSync(locations.user.path);
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    const serialized = JSON.stringify(inspection);
    t.assert(inspection.registration === 'CONFIGURED' && inspection.enablement === 'DISABLED' && inspection.activation === 'UNKNOWN', 'Codex enabled=false is configured but disabled with unknown activation');
    t.assert(inspection.actions.includes('CLIENT_ENABLEMENT_REQUIRED') && inspection.actions.includes('CUSTOM_LAUNCH_REVIEW_REQUIRED'), 'Codex disabled and custom cwd actions remain explicit');
    t.assert(!serialized.includes('do-not-serialize') && !serialized.includes('preserve-me'), 'Codex inspection never serializes environment values');
    t.assert(serialized.includes('API_TOKEN') && serialized.includes('HARMLESS'), 'Codex inspection retains secret-safe environment key evidence');
    let plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'ADOPT' && plan.operations[0].ledger_only === true, 'exact unowned Codex entry requires visible adoption');
    const transaction = adapterTransaction(ledger);
    await adapter.apply({ ...context, transaction }, plan.operations);
    t.assert(readFileSync(locations.user.path).equals(before), 'Codex adoption preserves config bytes exactly');
    t.assert(transaction.writes.length === 1 && transaction.writes[0].path === '<ownership-ledger>', 'Codex adoption writes only ownership state');
    inspection = await adapter.inspect(context, await adapter.detect(context));
    plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'NO_OP' && plan.operations.length === 0, 'owned exact Codex entry is idempotent');
    t.assert(!runner.calls.some(call => call.args.includes('add')), 'Codex never invokes native add for an existing table');
  } finally {
    cleanup(root);
  }
}

// Trusted nested project config wins root-to-leaf; untrusted project files are ignored without parsing.
{
  const root = makeRoot();
  try {
    const projectRoot = resolve(join(root, 'workspace'));
    const activeDirectory = resolve(join(projectRoot, 'Source'));
    const trustedContext = codexContext(root, { projectRoot, activeDirectory, workspaceTrusted: true });
    const locations = resolveCodexLocations(trustedContext);
    write(locations.user.path, [
      '[mcp_servers.uemcp]',
      `command = ${JSON.stringify(trustedContext.descriptor.command)}`,
      `args = [${JSON.stringify(trustedContext.descriptor.args[0])}]`,
      '',
    ].join('\n'));
    write(locations.project_layers[0].path, sample('codex-user-conflict.toml'));
    write(locations.project_layers[1].path, [
      '[mcp_servers.uemcp]',
      `command = ${JSON.stringify(trustedContext.descriptor.command)}`,
      `args = [${JSON.stringify(trustedContext.descriptor.args[0])}]`,
      '',
    ].join('\n'));
    const adapter = createCodexAdapter({ runner: codexNativeRunner(root), captureFingerprint: async path => simpleFingerprint(path) });
    let inspection = await adapter.inspect(trustedContext, await adapter.detect(trustedContext));
    t.assert(inspection.effective.path === locations.project_layers[1].path && inspection.registration === 'CONFIGURED', 'deepest trusted Codex project layer is effective');
    t.assert(inspection.occurrences.map(row => row.path).join('|') === [locations.user.path, ...locations.project_layers.map(row => row.path)].join('|'), 'Codex occurrences retain user then root-to-leaf precedence evidence');
    t.assert((await adapter.plan(trustedContext, inspection, trustedContext.descriptor)).operations.length === 0, 'effective project definition is never rewritten through the user scope');

    write(locations.project_layers[0].path, '[mcp_servers.uemcp\nmalformed = true\n');
    const untrustedContext = codexContext(root, { projectRoot, activeDirectory, workspaceTrusted: false });
    inspection = await adapter.inspect(untrustedContext, await adapter.detect(untrustedContext));
    t.assert(inspection.effective.path === locations.user.path && inspection.registration === 'CONFIGURED', 'untrusted Codex project layers do not shadow user config');
    t.assert(inspection.ignored_project_layers.length === 2 && inspection.occurrences.length === 1, 'untrusted Codex project layers are reported separately and not parsed as active config');
  } finally {
    cleanup(root);
  }
}

// System requirements enforce both the uemcp name and its canonical stdio identity.
{
  const cases = [
    { label: 'absent', content: null, expected: 'ALLOWED', writable: true },
    { label: 'allow', content: 'codex-requirements-allow.toml', expected: 'ALLOWED', writable: true },
    { label: 'missing-name deny', content: 'codex-requirements-deny.toml', expected: 'POLICY_BLOCKED', writable: false },
    { label: 'identity mismatch', content: 'codex-requirements-mismatch.toml', expected: 'POLICY_BLOCKED', writable: false },
  ];
  for (const testCase of cases) {
    const root = makeRoot();
    try {
      const calls = [];
      const capture = async (path, options = {}) => {
        calls.push({ path: resolve(path), writable: options.writable === true });
        return simpleFingerprint(path);
      };
      const context = codexContext(root);
      const locations = resolveCodexLocations(context);
      if (testCase.content) {
        write(locations.system_requirements.path, sample(testCase.content, {
          NODE: context.descriptor.command,
          SERVER: context.descriptor.args[0],
        }));
      }
      const adapter = createCodexAdapter({ runner: codexNativeRunner(root), captureFingerprint: capture });
      const inspection = await adapter.inspect(context, await adapter.detect(context));
      const plan = await adapter.plan(context, inspection, context.descriptor);
      t.assert(inspection.policy === testCase.expected, `Codex requirements ${testCase.label} is classified conservatively`);
      t.assert((plan.operations.length > 0) === testCase.writable, `Codex requirements ${testCase.label} controls write planning`);
      t.assert(calls.filter(call => call.path === locations.system_requirements.path).every(call => call.writable === false), `Codex requirements ${testCase.label} remains read-only`);
    } finally {
      cleanup(root);
    }
  }

  const root = makeRoot();
  try {
    const context = codexContext(root, { invocationPolicyKnown: false });
    const adapter = createCodexAdapter({ runner: codexNativeRunner(root), captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.policy === 'POLICY_UNKNOWN' && plan.operations[0].verification_status === 'POLICY_UNKNOWN', 'opaque cloud policy remains unknown and visible on a planned create');
  } finally {
    cleanup(root);
  }

  const regexRoot = makeRoot();
  try {
    const context = codexContext(regexRoot);
    const locations = resolveCodexLocations(context);
    write(locations.system_requirements.path, [
      '[mcp_servers.uemcp.identity]',
      `command = { executable = ${JSON.stringify(context.descriptor.command)}, args = [{ match = "regex", value = ".*" }] }`,
      '',
    ].join('\n'));
    const adapter = createCodexAdapter({ runner: codexNativeRunner(regexRoot), captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.policy === 'POLICY_UNKNOWN' && plan.operations[0].verification_status === 'POLICY_UNKNOWN', 'regex requirements remain host-evaluated policy instead of executing locally');
  } finally {
    cleanup(regexRoot);
  }
}

// Codex native JSON is structural evidence with explicit missing-field and refusal semantics.
{
  const root = makeRoot();
  try {
    const descriptor = canonicalDesired(root);
    const exact = codexNativeJson(descriptor);
    const matching = classifyCodexNativeStatus({ status: 'exited', exitCode: 0, stdout: exact, stderr: '' }, { desired: physicalCodexEntry(descriptor), mode: 'get' });
    const missingTransport = classifyCodexNativeStatus({ status: 'exited', exitCode: 0, stdout: JSON.stringify({ name: 'uemcp', enabled: true }), stderr: '' }, { desired: physicalCodexEntry(descriptor), mode: 'get' });
    const blocked = classifyCodexNativeStatus({ status: 'exited', exitCode: 0, stdout: codexNativeJson(descriptor, { enabled: false, disabled_reason: 'not allowed by requirements' }), stderr: '' }, { desired: physicalCodexEntry(descriptor), mode: 'get' });
    const duplicateList = classifyCodexNativeStatus({ status: 'exited', exitCode: 0, stdout: `[${exact},${exact}]`, stderr: '' }, { desired: physicalCodexEntry(descriptor), mode: 'list' });
    t.assert(matching.status === 'PRESENT' && matching.identity === 'MATCHING' && matching.enablement === 'ENABLED', 'Codex native parser recognizes matching enabled config');
    t.assert(missingTransport.status === 'PRESENT' && missingTransport.identity === 'UNKNOWN', 'Codex native parser never invents omitted client-owned fields');
    t.assert(blocked.status === 'PRESENT' && blocked.enablement === 'POLICY_BLOCKED', 'Codex native parser recognizes host policy refusal');
    t.assert(duplicateList.status === 'AMBIGUOUS' && duplicateList.identity === 'UNKNOWN', 'Codex native parser rejects duplicate same-name list rows as ambiguous');
    t.assert(classifyCodexNativeStatus({ status: 'exited', exitCode: 1, stdout: '', stderr: "MCP server 'uemcp' not found" }, { mode: 'get' }).status === 'ABSENT', 'Codex native parser recognizes absent named config');
    t.assert(classifyCodexNativeStatus({ status: 'timed_out', exitCode: null, stdout: '', stderr: '' }, { mode: 'get' }).status === 'TIMEOUT', 'Codex native parser preserves timeout distinctly');

    const runner = codexNativeRunner(root);
    const context = codexContext(root);
    const adapter = createCodexAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    await adapter.inspect(context, await adapter.detect(context));
    t.assert(runner.calls.length === 2 && runner.calls.every(call => call.args.includes('--json')), 'Codex inspection performs only list/get JSON queries');
    t.assert(runner.calls.every(call => !call.args.includes('add') && call.options.shell === false && call.options.timeoutMs <= 10_000 && call.options.outputLimitBytes <= 64 * 1024), 'Codex native inspection is read-only, shell-free, and bounded');
  } finally {
    cleanup(root);
  }
}

// Native host evidence can block or satisfy registration without authoring an unseen user shadow.
{
  const exactRoot = makeRoot();
  try {
    const context = codexContext(exactRoot);
    const native = codexNativeJson(context.descriptor);
    const runner = codexNativeRunner(exactRoot, {
      list: { status: 'exited', exitCode: 0, stdout: `[${native}]`, stderr: '' },
      get: { status: 'exited', exitCode: 0, stdout: native, stderr: '' },
      rejectMutation: true,
    });
    const adapter = createCodexAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.registration === 'CONFIGURED' && inspection.native_only === true, 'matching host-only Codex registration is configured without inventing a local source');
    t.assert(plan.status === 'NO_OP' && plan.operations.length === 0, 'matching host-only Codex registration never creates a user shadow');
  } finally {
    cleanup(exactRoot);
  }

  const inconsistentRoot = makeRoot();
  try {
    const context = codexContext(inconsistentRoot);
    const native = codexNativeJson(context.descriptor);
    const runner = codexNativeRunner(inconsistentRoot, {
      list: { status: 'exited', exitCode: 0, stdout: `[${native}]`, stderr: '' },
      get: { status: 'exited', exitCode: 1, stdout: '', stderr: "MCP server 'uemcp' not found" },
      rejectMutation: true,
    });
    const adapter = createCodexAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.native.status === 'INCONSISTENT' && inspection.native_write_blocked === true, 'disagreeing Codex list/get evidence remains explicitly inconsistent');
    t.assert(plan.status === 'POLICY_UNKNOWN' && plan.operations.length === 0, 'inconsistent native evidence blocks an unproven user create');
  } finally {
    cleanup(inconsistentRoot);
  }

  const failedRoot = makeRoot();
  try {
    const context = codexContext(failedRoot);
    const timedOut = { status: 'timed_out', exitCode: null, stdout: '', stderr: '' };
    const runner = codexNativeRunner(failedRoot, { list: timedOut, get: timedOut, rejectMutation: true });
    const adapter = createCodexAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.native_write_blocked === true && plan.status === 'POLICY_UNKNOWN' && plan.operations.length === 0, 'failed native absence proof blocks Codex user creation');
  } finally {
    cleanup(failedRoot);
  }
}

// Owned Codex updates patch only command and args while preserving comments and client-owned fields.
{
  const root = makeRoot();
  try {
    const ledger = memoryOwnershipLedger();
    const context = codexContext(root, { ownershipLedger: ledger, approvedOwnedReplacement: true });
    const locations = resolveCodexLocations(context);
    const oldEntry = {
      command: resolve(write(join(root, 'old-runtime', 'node.exe'), 'node')),
      args: [resolve(write(join(root, 'old-runtime', 'server.mjs'), 'export {};\n'))],
    };
    write(locations.user.path, sample('codex-user-owned-old.toml', {
      OLD_NODE: oldEntry.command,
      OLD_SERVER: oldEntry.args[0],
    }));
    const before = readFileSync(locations.user.path);
    await recordOwnedWrite({
      ledger,
      location: { clientId: 'codex', configPath: locations.user.path, scope: 'user', entryName: 'uemcp' },
      beforeEntry: null,
      afterEntry: oldEntry,
      ownedPaths: ownedPathsForClient('codex', oldEntry),
      appliedConfigHash: sha256Bytes(before),
      planDigest: TEST_PLAN_DIGEST,
    });
    const native = codexNativeJson(context.descriptor);
    const runner = codexNativeRunner(root, {
      list: { status: 'exited', exitCode: 0, stdout: `[${native}]`, stderr: '' },
      get: { status: 'exited', exitCode: 0, stdout: native, stderr: '' },
      rejectMutation: true,
    });
    const adapter = createCodexAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'UPDATE' && plan.operations[0].type === 'UPDATE_OWNED_FIELDS', 'owned stale Codex launch plans a targeted update');
    const transaction = adapterTransaction(ledger);
    await adapter.apply({ ...context, transaction }, plan.operations);
    const afterBytes = readFileSync(locations.user.path);
    const table = getTomlTable(parseTomlDocument(afterBytes), ['mcp_servers', 'uemcp']);
    const text = afterBytes.toString('utf8');
    t.assert(table.command === context.descriptor.command && JSON.stringify(table.args) === JSON.stringify(context.descriptor.args), 'Codex update writes canonical owned fields');
    t.assert(table.enabled === false && table.required === true && table.startup_timeout_sec === 45 && table.tool_timeout_sec === 90, 'Codex update preserves enablement, required, and timeout policy');
    t.assert(table.cwd === 'C:\\CustomWorkspace' && table.env.API_TOKEN === 'do-not-serialize' && table.default_tools_approval_mode === 'writes', 'Codex update preserves cwd, environment, and approval policy');
    t.assert(text.includes('# Preserve the command comment') && text.includes('[mcp_servers.other]') && text.includes('[mcp_servers.uemcp.tools.get_editor_state]'), 'Codex update preserves comments, unrelated servers, and per-tool policy');
    t.assert(!runner.calls.some(call => call.args.includes('add')), 'Codex existing-table update never invokes native add');
    const verified = await adapter.verify(context, plan.operations);
    t.assert(verified.status === 'CLIENT_ENABLEMENT_REQUIRED' && verified.restart_required === true, 'Codex disabled structural update retains both enablement and restart requirements');
  } finally {
    cleanup(root);
  }
}

// Hostile same-name Codex entries stay conflicts and version-bound native replacement remains disabled.
{
  const root = makeRoot();
  try {
    const context = codexContext(root);
    const locations = resolveCodexLocations(context);
    write(locations.user.path, sample('codex-user-conflict.toml'));
    const runner = codexNativeRunner(root, { rejectMutation: true });
    const adapter = createCodexAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const serialized = JSON.stringify(inspection);
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.registration === 'CONFLICT' && plan.status === 'CONFLICT' && plan.operations.length === 0, 'unowned conflicting Codex table cannot be replaced implicitly');
    t.assert(!serialized.includes('SECRET_ARGUMENT_CANARY') && !serialized.includes('SECRET_ENV_CANARY') && !serialized.includes('--token'), 'Codex conflict evidence does not expose argument or environment secrets');
    t.assert(serialized.includes('args_sha256') && serialized.includes('API_TOKEN'), 'Codex conflict evidence retains hash and environment-key diagnostics');
    t.assert(!runner.calls.some(call => call.args.includes('add')), 'Codex conflict inspection never invokes the dangerous native replacement path');

    const observed = JSON.parse(sample('codex-0.144.4-mcp-observation.json'));
    t.assert(observed.version === CODEX_NATIVE_MUTATION_CHARACTERIZATION.version, 'Codex native mutation characterization is version-bound');
    t.assert(observed.same_name_add_exit_code === 0 && observed.same_name_replaced_existing_table, 'Codex same-name add replacement hazard remains locked');
    t.assert(JSON.stringify(observed.isolated_home_files_after_fresh_add) === JSON.stringify(['config.toml']) && CODEX_NATIVE_MUTATION_CHARACTERIZATION.native_add_existing_allowed === false, 'Codex fresh-add containment permits no existing-table native mutation');
    t.assert(observed.existing_file_add_preserved_exact_bytes === false && observed.existing_file_add_normalized_crlf === true, 'Codex existing-file add reformatting remains locked as a parser-path guard');
  } finally {
    cleanup(root);
  }
}

// Malformed Codex TOML fails closed, including duplicate target tables.
{
  const root = makeRoot();
  try {
    const context = codexContext(root);
    const locations = resolveCodexLocations(context);
    const adapter = createCodexAdapter({ runner: codexNativeRunner(root), captureFingerprint: async path => simpleFingerprint(path) });
    for (const content of [
      '[mcp_servers.uemcp\ncommand = "broken"\n',
      '[mcp_servers.uemcp]\ncommand = "C:\\\\one.exe"\n[mcp_servers.uemcp]\nargs = []\n',
    ]) {
      write(locations.user.path, content);
      const inspection = await adapter.inspect(context, await adapter.detect(context));
      const plan = await adapter.plan(context, inspection, context.descriptor);
      t.assert(inspection.registration === 'MALFORMED_CONFIG' && plan.operations.length === 0, 'malformed or duplicate Codex target table blocks writes');
    }
  } finally {
    cleanup(root);
  }
}

// Oversized Codex config is rejected before content fingerprinting can read it.
{
  const root = makeRoot();
  try {
    const context = codexContext(root);
    const locations = resolveCodexLocations(context);
    write(locations.user.path, `padding = ${JSON.stringify('x'.repeat(64))}\n`);
    let oversizedCaptured = false;
    const adapter = createCodexAdapter({
      runner: codexNativeRunner(root),
      captureFingerprint: async path => {
        if (resolve(path) === locations.user.path) oversizedCaptured = true;
        return simpleFingerprint(path);
      },
      limits: { fileBytes: 32, aggregateBytes: 64, projectLayers: 64 },
    });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.registration === 'INSPECTION_LIMIT_EXCEEDED' && plan.operations.length === 0, 'Codex byte-limit failure never becomes absence or a partial plan');
    t.assert(oversizedCaptured === false, 'Codex rejects an oversized config before asking the fingerprint layer to hash it');
  } finally {
    cleanup(root);
  }
}

// The real Codex adapter completes one central native-create transaction and leaves restart explicit.
{
  const root = makeRoot();
  try {
    const context = codexContext(root);
    mkdirSync(context.env.CODEX_HOME, { recursive: true });
    const configPath = resolveCodexLocations(context).user.path;
    const runner = codexNativeRunner(root, {
      list: () => existsSync(configPath)
        ? { status: 'exited', exitCode: 0, stdout: `[${codexNativeJson(context.descriptor)}]`, stderr: '' }
        : { status: 'exited', exitCode: 0, stdout: '[]', stderr: '' },
      get: () => existsSync(configPath)
        ? { status: 'exited', exitCode: 0, stdout: codexNativeJson(context.descriptor), stderr: '' }
        : { status: 'exited', exitCode: 1, stdout: '', stderr: "MCP server 'uemcp' not found" },
    });
    const windowsNative = transactionWindowsNative();
    const capture = (path, options) => captureClientPathFingerprint(path, { ...options, fsImpl: asyncFs, windowsNative });
    const adapter = createCodexAdapter({ runner, captureFingerprint: capture });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    const localState = createLocalState({
      root: join(root, 'local-state'),
      aclRestrictor: async () => {},
      processInspector: async () => 'alive',
    });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: TEST_PLAN_DIGEST, adapters: [adapter], operations: plan.operations, context, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: TEST_PLAN_DIGEST, adapters: [adapter], operations: plan.operations, context });
    const table = getTomlTable(parseTomlDocument(readFileSync(configPath)), ['mcp_servers', 'uemcp']);
    t.assert(result.status === 'ACTION_REQUIRED' && result.clients[0].status === 'RESTART_REQUIRED', 'Codex native create commits structurally while preserving restart as required');
    t.assert(table.command === context.descriptor.command && JSON.stringify(table.args) === JSON.stringify(context.descriptor.args), 'Codex native create writes the canonical launch identity');
    t.assert(result.touched_files.map(row => row.path).sort().join('|') === [configPath, localState.paths().ownership].map(path => resolve(path)).sort().join('|'), 'Codex central transaction touches only provider config and ownership state');
    const nativeAdds = runner.calls.filter(call => call.args.includes('add'));
    t.assert(nativeAdds.length === 1, 'Codex central transaction invokes native add exactly once for an absent file');
    t.assert(resolve(nativeAdds[0].options.env.CODEX_HOME) !== resolve(context.env.CODEX_HOME), 'Codex fresh native add receives only an isolated home');
    t.assert(resolve(nativeAdds[0].options.cwd) === resolve(nativeAdds[0].options.env.CODEX_HOME), 'Codex fresh native add uses the isolated home as its working directory');
    const persistedLedger = {
      async read() {
        try {
          return await asyncFs.readFile(localState.paths().ownership, 'utf8');
        } catch (error) {
          if (error.code === 'ENOENT') return null;
          throw error;
        }
      },
      now: () => '2026-07-16T12:00:00.000Z',
    };
    const persistedContext = { ...context, ownershipLedger: persistedLedger };
    const nextInspection = await adapter.inspect(persistedContext, await adapter.detect(persistedContext));
    const nextPlan = await adapter.plan(persistedContext, nextInspection, persistedContext.descriptor);
    t.assert(nextPlan.status === 'NO_OP' && nextPlan.operations.length === 0, 'Codex native create becomes an owned idempotent no-op');
  } finally {
    cleanup(root);
  }
}

process.exitCode = t.summary();
