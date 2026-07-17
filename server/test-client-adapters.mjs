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
import {
  GEMINI_NATIVE_MUTATION_CHARACTERIZATION,
  classifyGeminiNativeStatus,
  createGeminiAdapter,
  physicalGeminiEntry,
  resolveGeminiLocations,
} from './deployment/adapters/gemini.mjs';
import {
  VSCODE_NATIVE_MUTATION_CHARACTERIZATION,
  createVsCodeAdapter,
  physicalVsCodeEntry,
  resolveVsCodeLocations,
} from './deployment/adapters/vscode.mjs';
import { sha256Bytes, sha256Canonical } from './deployment/canonical-json.mjs';
import {
  ACTION_CODES,
  reduceOutcome,
  shouldRecordPlanDigest,
  validateClientContract,
  validateStageContract,
} from './deployment/contracts.mjs';
import {
  CLIENT_IDS,
  RELEASE_GATES,
  classifySupportedVersion,
  isSensitiveClientEnvironmentName,
  readWindowsEnvironmentValue,
  validateClientLaunchContract,
} from './deployment/client-contract.mjs';
import { createClientDomain } from './deployment/client-domain.mjs';
import { discoverClients, selectClients } from './deployment/client-discovery.mjs';
import { resolveClientLaunch } from './deployment/client-process.mjs';
import { captureClientPathFingerprint, createClientTransaction } from './deployment/client-transaction.mjs';
import { getJsoncValue, parseJsoncDocument } from './deployment/jsonc-config.mjs';
import { createLocalState } from './deployment/local-state.mjs';
import { ownedPathsForClient, recordOwnedWrite } from './deployment/ownership-ledger.mjs';
import { createPlanDocument } from './deployment/plan-document.mjs';
import { getTomlTable, parseTomlDocument, patchTomlTable } from './deployment/toml-config.mjs';

const t = new TestRunner('Client Adapter Tests');
const clientConfigSamples = join(import.meta.dirname, 'fixtures', 'client-config');
const TEST_PLAN_DIGEST = 'a'.repeat(64);

function hasOnlyContractActions(actions) {
  return actions.every(code => Object.hasOwn(ACTION_CODES, code));
}

function throwsCode(fn, code) {
  try {
    fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
}

// Windows environment lookup is case-insensitive and rejects ambiguous plain-object aliases.
{
  t.assert(readWindowsEnvironmentValue({ Path: 'one' }, 'PATH') === 'one', 'shared client environment lookup accepts a case variant');
  t.assert(readWindowsEnvironmentValue({ PATH: undefined, Path: 'one' }, 'PATH') === 'one', 'undefined environment aliases do not create false ambiguity');
  t.assert(throwsCode(() => readWindowsEnvironmentValue({ PATH: 'one', Path: 'two' }, 'PATH'), 'AMBIGUOUS_CLIENT_ENVIRONMENT'), 'shared client environment lookup rejects duplicate case variants');
}

// Active-launch review uses one case-insensitive sensitive-name policy across every adapter.
{
  const exactNames = [
    'NODE_OPTIONS',
    'NODE_PATH',
    'PATH',
    'PATHEXT',
    'COMSPEC',
    'HOME',
    'USERPROFILE',
    'APPDATA',
    'LOCALAPPDATA',
    'CODEX_HOME',
    'CLAUDE_CONFIG_DIR',
    'GEMINI_CLI_HOME',
  ];
  const prefixedNames = ['UEMCP_PROJECT_ROOT', 'UNREAL_PROJECT_ROOT'];
  for (const name of [...exactNames, ...prefixedNames]) {
    t.assert(isSensitiveClientEnvironmentName(name), `${name} is a sensitive client environment name`);
    t.assert(isSensitiveClientEnvironmentName(name.toLowerCase()), `${name} remains sensitive in lowercase`);
    const mixed = [...name].map((character, index) => index % 2 === 0 ? character.toLowerCase() : character.toUpperCase()).join('');
    t.assert(isSensitiveClientEnvironmentName(mixed), `${name} remains sensitive with mixed casing`);
  }
  t.assert(!isSensitiveClientEnvironmentName('HARMLESS_SETTING'), 'unrelated client environment names do not require sensitive-launch review');
  t.assert(!isSensitiveClientEnvironmentName('UEMC_PROJECT_ROOT'), 'near-miss client environment prefixes do not create false positives');
}

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

function geminiLaunch(root, { version = '0.41.2', writeSupported = version === '0.41.2' } = {}) {
  const node = write(join(root, 'runtime', 'node.exe'), 'node');
  const entry = write(join(root, 'npm', 'node_modules', '@google', 'gemini-cli', 'bundle', 'gemini.js'), 'export {};\n');
  return {
    client_id: 'gemini',
    command: resolve(node),
    args_prefix: [resolve(entry)],
    env_overlay: {},
    package_id: '@google/gemini-cli',
    source: 'npm_package',
    version,
    compatibility: writeSupported ? 'release_gated' : 'unknown_newer',
    write_supported: writeSupported,
    fingerprint: { command: { sha256: 'c'.repeat(64) }, args_prefix: [{ sha256: 'd'.repeat(64) }] },
  };
}

function geminiNativeRunner(output = { status: 'exited', exitCode: 0, stdout: 'No MCP servers configured.\n', stderr: '' }) {
  const calls = [];
  return {
    calls,
    async run(executable, args, options = {}) {
      calls.push({ executable, args: [...args], options: { ...options, env: { ...options.env } } });
      const mcpIndex = args.indexOf('mcp');
      if (mcpIndex < 0 || args.slice(mcpIndex).join(' ') !== 'mcp list') {
        throw Object.assign(new Error('mutating Gemini MCP command was attempted'), { code: 'MUTATING_NATIVE_COMMAND' });
      }
      return typeof output === 'function' ? output({ executable, args, options }) : output;
    },
  };
}

function geminiContext(root, overrides = {}) {
  const baseEnv = environment(root);
  const env = {
    ...baseEnv,
    GEMINI_CLI_HOME: resolve(join(root, 'gemini-home')),
    ...overrides.env,
  };
  const workspaceRoot = resolve(overrides.workspaceRoot ?? join(root, 'workspace'));
  mkdirSync(workspaceRoot, { recursive: true });
  const descriptor = overrides.descriptor ?? canonicalDesired(root);
  const knownFolders = overrides.knownFolders ?? { programData: resolve(join(root, 'ProgramData')) };
  return {
    env,
    workspaceRoot,
    workspaceTrusted: overrides.workspaceTrusted ?? false,
    invocationPolicyKnown: overrides.invocationPolicyKnown ?? true,
    planDigest: overrides.planDigest ?? TEST_PLAN_DIGEST,
    launch: overrides.launch ?? geminiLaunch(root),
    descriptor,
    ownershipLedger: overrides.ownershipLedger ?? memoryOwnershipLedger(),
    knownFolders,
    ...overrides,
    env,
    workspaceRoot,
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

function vscodeLaunch(root, { version = '1.128.1', writeSupported = version === '1.128.1' } = {}) {
  const installRoot = resolve(join(root, 'vscode-install'));
  const command = write(join(installRoot, 'Code.exe'), 'code');
  const cli = write(join(installRoot, '5264f2156c', 'resources', 'app', 'out', 'cli.js'), 'export {};\n');
  return {
    client_id: 'vscode',
    command: resolve(command),
    args_prefix: [resolve(cli)],
    env_overlay: { ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' },
    package_id: null,
    source: 'native',
    version,
    compatibility: writeSupported ? 'release_gated' : 'unknown_newer',
    write_supported: writeSupported,
    fingerprint: { command: { sha256: 'c'.repeat(64) }, args_prefix: [{ sha256: 'd'.repeat(64) }] },
  };
}

function vscodeContext(root, overrides = {}) {
  const env = { ...environment(root), ...overrides.env };
  const workspaceRoot = resolve(overrides.workspaceRoot ?? join(root, 'workspace'));
  mkdirSync(workspaceRoot, { recursive: true });
  const descriptor = overrides.descriptor ?? canonicalDesired(root);
  return {
    env,
    workspaceRoot,
    vscodeUserDataRoot: overrides.vscodeUserDataRoot,
    vscodeProfile: overrides.vscodeProfile ?? null,
    planDigest: overrides.planDigest ?? TEST_PLAN_DIGEST,
    launch: overrides.launch ?? vscodeLaunch(root),
    descriptor,
    ownershipLedger: overrides.ownershipLedger ?? memoryOwnershipLedger(),
    approvedOwnedReplacement: overrides.approvedOwnedReplacement ?? false,
  };
}

// VS Code defaults to the stable user-data and workspace MCP resources.
{
  const root = makeRoot();
  try {
    const context = vscodeContext(root);
    const locations = resolveVsCodeLocations(context);
    const userDataRoot = resolve(join(context.env.APPDATA, 'Code'));
    t.assert(locations.default_user.path === resolve(join(userDataRoot, 'User', 'mcp.json')), 'VS Code default MCP resource is rooted in APPDATA');
    t.assert(locations.profile_metadata.path === resolve(join(userDataRoot, 'User', 'globalStorage', 'storage.json')), 'VS Code profile metadata is read from globalStorage');
    t.assert(locations.workspace.path === resolve(join(context.workspaceRoot, '.vscode', 'mcp.json')), 'VS Code workspace MCP resource remains workspace scoped');
    t.assert(JSON.stringify(physicalVsCodeEntry(context.descriptor)) === JSON.stringify({
      type: 'stdio',
      command: context.descriptor.command,
      args: context.descriptor.args,
    }), 'VS Code canonical projection owns only type, command, and args');
    const customRoot = resolve(join(root, 'isolated-vscode-data'));
    t.assert(resolveVsCodeLocations(vscodeContext(root, { vscodeUserDataRoot: customRoot })).default_user.path === resolve(join(customRoot, 'User', 'mcp.json')), 'VS Code explicit isolated user-data root is honored');
    const lowerAppData = resolve(join(root, 'lower-appdata'));
    t.assert(resolveVsCodeLocations(vscodeContext(root, { env: { APPDATA: undefined, appdata: lowerAppData } })).default_user.path === resolve(join(lowerAppData, 'Code', 'User', 'mcp.json')), 'VS Code APPDATA lookup is case-insensitive');
    t.assert(throwsCode(() => resolveVsCodeLocations(vscodeContext(root, {
      env: { APPDATA: lowerAppData, appdata: resolve(join(root, 'other-appdata')) },
    })), 'AMBIGUOUS_CLIENT_ENVIRONMENT'), 'VS Code rejects duplicate case-variant APPDATA definitions');
  } finally {
    cleanup(root);
  }
}

// VS Code adapter detection validates the complete native launch tuple.
{
  const root = makeRoot();
  try {
    const context = vscodeContext(root);
    const adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
    const detection = await adapter.detect(context);
    t.assert(detection.client_id === 'vscode' && detection.locations.default_user.path === resolve(join(context.env.APPDATA, 'Code', 'User', 'mcp.json')), 'VS Code detection retains validated launch and config locations');
    t.assert(await rejectsCode(() => adapter.detect(vscodeContext(root, {
      launch: { ...vscodeLaunch(root), args_prefix: [] },
    })), 'INVALID_CLIENT_LAUNCH'), 'VS Code detection rejects direct GUI launch evidence');
  } finally {
    cleanup(root);
  }
}

// VS Code default-profile inspection keeps structural, enablement, and activation evidence separate.
{
  const root = makeRoot();
  try {
    const context = vscodeContext(root);
    const adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'ABSENT', 'VS Code inspection distinguishes an absent registration');
    t.assert(inspection.enablement === 'UNKNOWN' && inspection.activation === 'UNKNOWN', 'VS Code file absence does not infer host enablement or activation');
    t.assert(inspection.selected_resource.scope === 'user:default', 'VS Code default context selects the default user resource');
    t.assert(inspection.actions.includes('RESTART_REQUIRED') && inspection.actions.includes('CLIENT_ENABLEMENT_REVIEW_REQUIRED'), 'VS Code static inspection requires restart and client enablement review');
  } finally {
    cleanup(root);
  }
}

// VS Code resolves one explicit existing profile and honors mcpResource inheritance.
{
  const root = makeRoot();
  try {
    const workContext = vscodeContext(root, { vscodeProfile: 'Work' });
    const locations = resolveVsCodeLocations(workContext);
    write(locations.profile_metadata.path, sample('vscode-profile-storage.json'));
    writeJson(join(locations.profiles_root, 'work-profile-id', 'mcp.json'), {
      servers: { uemcp: physicalVsCodeEntry(workContext.descriptor) },
    });
    const adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
    let workInspection = await adapter.inspect(workContext, await adapter.detect(workContext));
    t.assert(workInspection?.selected_resource.path === resolve(join(locations.profiles_root, 'work-profile-id', 'mcp.json')), 'VS Code selected profile resolves its validated profile mcpResource');
    t.assert(workInspection?.registration === 'CONFIGURED' && workInspection.profiles.length === 2, 'VS Code selected profile inspection retains bounded profile metadata evidence');

    const sharedContext = vscodeContext(root, { vscodeProfile: 'Shared' });
    writeJson(locations.default_user.path, { servers: { uemcp: physicalVsCodeEntry(sharedContext.descriptor) } });
    const sharedInspection = await adapter.inspect(sharedContext, await adapter.detect(sharedContext));
    t.assert(sharedInspection?.selected_resource.path === locations.default_user.path && sharedInspection.selected_resource.inherited_default === true, 'VS Code useDefaultFlags.mcp profile reuses the default physical resource');
    t.assert(sharedInspection?.selected_resource.scope === 'user:default', 'VS Code inherited profile retains the default ownership scope');

    workInspection = await adapter.inspect(workContext, await adapter.detect(workContext));
    const defaultOccurrences = workInspection.occurrences.filter(row => row.path === locations.default_user.path);
    t.assert(defaultOccurrences.length === 1, 'VS Code default and inherited profile contexts deduplicate to one physical occurrence');
    t.assert(defaultOccurrences[0]?.requested_contexts?.includes('default') && defaultOccurrences[0]?.requested_contexts?.includes('profile:Shared (useDefaultFlags.mcp)'), 'VS Code deduplicated resource retains every requested profile context');

    const unknownContext = vscodeContext(root, { vscodeProfile: 'Missing' });
    t.assert(await rejectsCode(async () => adapter.inspect(unknownContext, await adapter.detect(unknownContext)), 'VSCODE_PROFILE_NOT_FOUND'), 'VS Code rejects an unknown requested profile without launching it');
    const emptyContext = vscodeContext(root, { vscodeProfile: '' });
    t.assert(await rejectsCode(async () => adapter.inspect(emptyContext, await adapter.detect(emptyContext)), 'VSCODE_PROFILE_NOT_FOUND'), 'VS Code rejects an explicitly empty profile name instead of selecting default');
  } finally {
    cleanup(root);
  }
}

// VS Code profile metadata is structurally bounded and rejects ambiguous identities.
{
  const malformedCases = [
    { label: 'non-array profile list', value: { userDataProfiles: {} } },
    { label: 'duplicate profile names', value: { userDataProfiles: [{ name: 'Work', location: 'one' }, { name: 'work', location: 'two' }] } },
    { label: 'duplicate profile locations', value: { userDataProfiles: [{ name: 'One', location: 'Same' }, { name: 'Two', location: 'same' }] } },
    { label: 'invalid default flags', value: { userDataProfiles: [{ name: 'Work', location: 'one', useDefaultFlags: { mcp: 'yes' } }] } },
    { label: 'missing profile name', value: { userDataProfiles: [{ location: 'one' }] } },
  ];
  for (const testCase of malformedCases) {
    const root = makeRoot();
    try {
      const context = vscodeContext(root);
      const locations = resolveVsCodeLocations(context);
      writeJson(locations.profile_metadata.path, testCase.value);
      const adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
      const inspection = await adapter.inspect(context, await adapter.detect(context));
      t.assert(inspection.registration === 'MALFORMED_CONFIG', `VS Code ${testCase.label} blocks configuration writes`);
    } finally {
      cleanup(root);
    }
  }

  for (const profileLocation of ['..', 'nested/path', 'nested\\path', 'C:\\absolute', '\\\\?\\C:\\device', 'NUL', 'trailing.']) {
    const root = makeRoot();
    try {
      const context = vscodeContext(root);
      const locations = resolveVsCodeLocations(context);
      writeJson(locations.profile_metadata.path, { userDataProfiles: [{ name: 'Unsafe', location: profileLocation }] });
      const adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
      const inspection = await adapter.inspect(context, await adapter.detect(context));
      t.assert(inspection.registration === 'UNSAFE_CONFIG_PATH', `VS Code rejects unsafe profile location ${profileLocation}`);
    } finally {
      cleanup(root);
    }
  }

  const root = makeRoot();
  try {
    const context = vscodeContext(root, { vscodeProfile: 'Internal' });
    const locations = resolveVsCodeLocations(context);
    writeJson(locations.profile_metadata.path, { userDataProfiles: [{ name: 'Internal', location: 'agents' }] });
    const adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'UNSAFE_CONFIG_PATH', 'VS Code reserved internal agents profile cannot become a writable user target');
  } finally {
    cleanup(root);
  }
}

// VS Code rejects missing, oversized, over-count, and linked profile evidence.
{
  const root = makeRoot();
  try {
    const missingContext = vscodeContext(root, { vscodeProfile: 'Missing' });
    let adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
    t.assert(await rejectsCode(async () => adapter.inspect(missingContext, await adapter.detect(missingContext)), 'VSCODE_PROFILE_NOT_FOUND'), 'VS Code named profile selection requires existing metadata');

    const context = vscodeContext(root);
    const locations = resolveVsCodeLocations(context);
    writeJson(locations.profile_metadata.path, { userDataProfiles: [{ name: 'One', location: 'one' }, { name: 'Two', location: 'two' }] });
    adapter = createVsCodeAdapter({
      captureFingerprint: async path => simpleFingerprint(path),
      limits: { fileBytes: 1024, aggregateBytes: 8192, metadataBytes: 1024, profileRecords: 1 },
    });
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'INSPECTION_LIMIT_EXCEEDED', 'VS Code profile count overflow fails closed');

    write(locations.profile_metadata.path, JSON.stringify({ padding: 'x'.repeat(256) }));
    adapter = createVsCodeAdapter({
      captureFingerprint: async path => simpleFingerprint(path),
      limits: { fileBytes: 1024, aggregateBytes: 8192, metadataBytes: 64, profileRecords: 8 },
    });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'INSPECTION_LIMIT_EXCEEDED', 'VS Code profile metadata byte overflow fails closed');

    writeJson(locations.profile_metadata.path, { userDataProfiles: [] });
    adapter = createVsCodeAdapter({ captureFingerprint: async path => {
      const fingerprint = simpleFingerprint(path);
      return resolve(path) === locations.profile_metadata.path && fingerprint.exists
        ? { ...fingerprint, link_kind: 'hardlink', link_count: 2 }
        : fingerprint;
    } });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'UNSAFE_CONFIG_PATH', 'VS Code linked profile metadata cannot authorize a target');
  } finally {
    cleanup(root);
  }
}

// VS Code absence plans one parser-backed selected-resource create and unknown versions stay inspect-only.
{
  const root = makeRoot();
  try {
    const context = vscodeContext(root, { approvedOwnedReplacement: true });
    const adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'CREATE' && plan.operations.length === 1 && plan.operations[0].type === 'CREATE_ENTRY', 'VS Code absence plans one selected-resource create');
    t.assert(plan.operations[0].path === resolveVsCodeLocations(context).default_user.path && JSON.stringify(plan.operations[0].owned_paths) === JSON.stringify(['/type', '/command', '/args']), 'VS Code create targets only the selected physical resource and owned fields');
    t.assert(plan.operations[0].external_write === false && plan.operations[0].verification_status === 'RESTART_REQUIRED', 'VS Code create remains parser-backed with static restart verification');
    t.assert(plan.operations[0].explicit_owned_replacement === false, 'VS Code fresh create never carries replacement authority');
    const bound = new Set(plan.operations[0].read_only_paths.map(row => row.path));
    t.assert([context.launch.command, ...context.launch.args_prefix, context.descriptor.command, ...context.descriptor.args].every(path => bound.has(resolve(path))), 'VS Code plan binds client and server launch evidence');

    const unsupportedContext = vscodeContext(root, { launch: vscodeLaunch(root, { version: '1.129.0', writeSupported: false }) });
    const unsupportedInspection = await adapter.inspect(unsupportedContext, await adapter.detect(unsupportedContext));
    const unsupportedPlan = await adapter.plan(unsupportedContext, unsupportedInspection, unsupportedContext.descriptor);
    t.assert(unsupportedPlan.status === 'UNSUPPORTED_VERSION' && unsupportedPlan.operations.length === 0, 'unknown VS Code versions cannot plan writes');
  } finally {
    cleanup(root);
  }
}

// VS Code workspace precedence blocks user shadowing, while inactive profiles remain evidence only.
{
  const root = makeRoot();
  try {
    const context = vscodeContext(root);
    const locations = resolveVsCodeLocations(context);
    const adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
    writeJson(locations.workspace.path, { servers: { uemcp: physicalVsCodeEntry(context.descriptor) } });
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    let plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.effective.scope === 'workspace' && inspection.registration === 'CONFIGURED', 'VS Code workspace entry is the effective definition');
    t.assert(plan.status === 'NO_OP' && plan.operations.length === 0 && plan.actions.includes('SHADOWED'), 'matching VS Code workspace entry is never redundantly shadowed in user scope');

    writeJson(locations.workspace.path, { servers: { uemcp: { type: 'stdio', command: 'C:\\Other\\node.exe', args: [] } } });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.registration === 'CONFLICT' && plan.status === 'CONFLICT' && plan.operations.length === 0, 'conflicting VS Code workspace entry blocks user writes');

    rmSync(locations.workspace.path);
    writeJson(locations.profile_metadata.path, { userDataProfiles: [{ name: 'Other', location: 'other-profile' }] });
    writeJson(join(locations.profiles_root, 'other-profile', 'mcp.json'), {
      servers: { uemcp: { type: 'stdio', command: 'C:\\Other\\node.exe', args: [] } },
    });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.occurrences.some(row => row.profile_name === 'Other' && row.active === false), 'VS Code reports same-name entries in non-selected profiles');
    t.assert(plan.status === 'CREATE' && plan.operations[0].path === locations.default_user.path, 'inactive VS Code profile conflicts do not block the selected default resource');
  } finally {
    cleanup(root);
  }
}

// An unowned conflicting selected VS Code entry cannot be replaced by name alone.
{
  const root = makeRoot();
  try {
    const context = vscodeContext(root);
    const locations = resolveVsCodeLocations(context);
    writeJson(locations.default_user.path, {
      servers: { uemcp: { type: 'stdio', command: 'C:\\User\\custom.exe', args: ['--keep'] } },
    });
    const adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.registration === 'CONFLICT' && plan.status === 'CONFLICT' && plan.operations.length === 0, 'VS Code unowned selected-resource conflict requires explicit resolution');
  } finally {
    cleanup(root);
  }
}

// Exact VS Code entries require visible ownership adoption before becoming idempotent.
{
  const root = makeRoot();
  try {
    const ledger = memoryOwnershipLedger();
    const context = vscodeContext(root, { ownershipLedger: ledger });
    const locations = resolveVsCodeLocations(context);
    writeJson(locations.default_user.path, {
      servers: {
        uemcp: {
          ...physicalVsCodeEntry(context.descriptor),
          env: { SECRET_TOKEN: 'never-serialize' },
          sandbox: { enabled: false },
        },
      },
    });
    const adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    let plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'ADOPT' && plan.operations[0].type === 'ADOPT_EXACT_ENTRY' && plan.operations[0].ledger_only === true, 'VS Code exact unowned entry requires visible adoption');
    t.assert(!JSON.stringify(plan).includes('never-serialize'), 'VS Code adoption plan never serializes environment values');
    const before = readFileSync(locations.default_user.path);
    await adapter.apply({ ...context, transaction: adapterTransaction(ledger) }, plan.operations);
    t.assert(readFileSync(locations.default_user.path).equals(before), 'VS Code adoption preserves provider config bytes exactly');
    inspection = await adapter.inspect(context, await adapter.detect(context));
    plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'NO_OP' && plan.operations.length === 0, 'owned exact VS Code entry becomes an idempotent no-op');
  } finally {
    cleanup(root);
  }
}

// VS Code create applies through the central transaction and records current-config-bound ownership.
{
  const root = makeRoot();
  try {
    const ledger = memoryOwnershipLedger();
    const context = vscodeContext(root, { ownershipLedger: ledger });
    const locations = resolveVsCodeLocations(context);
    const runner = {
      calls: [],
      async run(executable, args) {
        this.calls.push({ executable, args: [...args] });
        throw new Error('VS Code adapter must not invoke native mutation');
      },
    };
    const adapter = createVsCodeAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    let plan = await adapter.plan(context, inspection, context.descriptor);
    const createPlan = plan;
    const snapshot = await adapter.snapshot(context, createPlan.operations);
    t.assert(snapshot.writable_paths.length === 1 && snapshot.writable_paths[0].path === locations.default_user.path, 'VS Code snapshot includes only the selected resource as writable');
    t.assert(snapshot.read_only_paths.some(row => row.path === locations.profile_metadata.path), 'VS Code snapshot binds profile metadata as read-only evidence');
    await adapter.apply({ ...context, transaction: adapterTransaction(ledger) }, plan.operations);
    const written = JSON.parse(readFileSync(locations.default_user.path, 'utf8'));
    t.assert(JSON.stringify(written.servers.uemcp) === JSON.stringify(physicalVsCodeEntry(context.descriptor)), 'VS Code create writes the canonical selected-resource projection');
    const verified = await adapter.verify(context, createPlan.operations);
    t.assert(verified.registration === 'CONFIGURED' && verified.status === 'RESTART_REQUIRED', 'VS Code static verification proves configuration while requiring restart');
    t.assert(verified.enablement === 'UNKNOWN' && verified.activation === 'UNKNOWN' && verified.actions.includes('CLIENT_ENABLEMENT_REVIEW_REQUIRED'), 'VS Code static verification never infers enablement or activation');
    inspection = await adapter.inspect(context, await adapter.detect(context));
    plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'NO_OP' && plan.operations.length === 0, 'VS Code created entry becomes an owned idempotent no-op');
    t.assert(runner.calls.length === 0, 'VS Code create, apply, and verify never invoke profile or add-mcp mutation');
  } finally {
    cleanup(root);
  }
}

// Owned VS Code updates patch only installer-owned fields and preserve all client-owned JSONC bytes semantically.
{
  const root = makeRoot();
  try {
    const ledger = memoryOwnershipLedger();
    const context = vscodeContext(root, { ownershipLedger: ledger });
    const locations = resolveVsCodeLocations(context);
    const oldCommand = resolve(write(join(root, 'old-runtime', 'node.exe'), 'node'));
    const oldArg = context.descriptor.args[0];
    write(locations.default_user.path, sample('vscode-user-preservation.jsonc', {
      OLD_COMMAND: oldCommand,
      OLD_ARG: oldArg,
    }));
    const before = readFileSync(locations.default_user.path);
    const beforeDocument = parseJsoncDocument(before, { pathLabel: 'VS Code update sample' });
    const oldEntry = getJsoncValue(beforeDocument, ['servers', 'uemcp']);
    await recordOwnedWrite({
      ledger,
      location: { clientId: 'vscode', configPath: locations.default_user.path, scope: 'user:default', entryName: 'uemcp' },
      beforeEntry: null,
      afterEntry: oldEntry,
      ownedPaths: ownedPathsForClient('vscode', oldEntry),
      appliedConfigHash: sha256Bytes(before),
      planDigest: TEST_PLAN_DIGEST,
    });
    const adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'UPDATE' && plan.operations[0].type === 'UPDATE_OWNED_FIELDS', 'VS Code owned stale projection plans a targeted update');
    t.assert(inspection.actions.includes('CUSTOM_ENV_REVIEW_REQUIRED') && inspection.actions.includes('CUSTOM_LAUNCH_REVIEW_REQUIRED'), 'VS Code custom environment and cwd remain explicit review actions');
    t.assert(!JSON.stringify(inspection).includes('keep-this-value'), 'VS Code inspection never serializes environment values');
    await adapter.apply({ ...context, transaction: adapterTransaction(ledger) }, plan.operations);
    const afterBytes = readFileSync(locations.default_user.path);
    const afterDocument = parseJsoncDocument(afterBytes, { pathLabel: 'VS Code updated sample' });
    const after = afterDocument.parsed_value;
    const entry = after.servers.uemcp;
    t.assert(entry.type === 'stdio' && entry.command === context.descriptor.command && JSON.stringify(entry.args) === JSON.stringify(context.descriptor.args), 'VS Code update writes the canonical owned projection');
    t.assert(entry.env.UEMCP_SECRET_TOKEN === 'keep-this-value' && entry.cwd === 'C:\\Preserve\\Workspace' && entry.sandbox.network === 'host', 'VS Code update preserves environment, cwd, and sandbox policy');
    t.assert(entry.unknownProviderField === 'preserve' && after.inputs[0].id === 'project-token' && after.servers.other.url && after.unknownTopLevel.preserve, 'VS Code update preserves unknown fields, inputs, unrelated servers, and top-level state');
    t.assert(afterDocument.text.includes('// Inputs belong to VS Code'), 'VS Code targeted update preserves JSONC comments');
  } finally {
    cleanup(root);
  }
}

// VS Code malformed, linked, and read-only selected resources fail closed before apply.
{
  const root = makeRoot();
  try {
    const context = vscodeContext(root);
    const locations = resolveVsCodeLocations(context);
    write(locations.default_user.path, '{ malformed');
    let adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    let plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.registration === 'MALFORMED_CONFIG' && plan.operations.length === 0, 'VS Code malformed selected config blocks writes');

    writeJson(locations.default_user.path, { servers: {} });
    adapter = createVsCodeAdapter({ captureFingerprint: async (path, options = {}) => {
      if (options.writable === true && resolve(path) === locations.default_user.path) {
        throw Object.assign(new Error('read only'), { code: 'READ_ONLY_TARGET' });
      }
      return simpleFingerprint(path);
    } });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'READ_ONLY_TARGET' && plan.operations.length === 0, 'VS Code read-only selected resource blocks planning');

    adapter = createVsCodeAdapter({ captureFingerprint: async path => {
      const fingerprint = simpleFingerprint(path);
      return resolve(path) === locations.default_user.path && fingerprint.exists
        ? { ...fingerprint, link_kind: 'symbolic' }
        : fingerprint;
    } });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'UNSAFE_CONFIG_PATH', 'VS Code linked selected resource cannot authorize a write');
  } finally {
    cleanup(root);
  }
}

// Invalid ownership storage cannot yield a VS Code operation that is guaranteed to fail at apply.
{
  const root = makeRoot();
  try {
    const ledger = {
      async read() { return '{broken'; },
      async write() { throw new Error('must not write invalid ownership storage'); },
      now: () => '2026-07-16T12:00:00.000Z',
    };
    const context = vscodeContext(root, { ownershipLedger: ledger });
    const locations = resolveVsCodeLocations(context);
    writeJson(locations.default_user.path, { servers: { uemcp: physicalVsCodeEntry(context.descriptor) } });
    const adapter = createVsCodeAdapter({ captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'OWNERSHIP_LEDGER_INVALID' && plan.operations.length === 0, 'VS Code invalid ownership storage blocks adoption before apply');
  } finally {
    cleanup(root);
  }
}

// Installed VS Code 1.128.1 behavior permanently forbids production CLI mutation.
{
  t.assert(VSCODE_NATIVE_MUTATION_CHARACTERIZATION.version === '1.128.1', 'VS Code mutation characterization is release-bound');
  t.assert(VSCODE_NATIVE_MUTATION_CHARACTERIZATION.profile_can_create_missing === true, 'VS Code profile launch can create a missing profile');
  t.assert(VSCODE_NATIVE_MUTATION_CHARACTERIZATION.add_mcp_profile_writes_default === true, 'VS Code add-mcp profile targeting hazard remains locked');
  t.assert(VSCODE_NATIVE_MUTATION_CHARACTERIZATION.same_name_replaces_full_object === true, 'VS Code same-name add replacement hazard remains locked');
  t.assert(VSCODE_NATIVE_MUTATION_CHARACTERIZATION.mutating_cli_allowed === false, 'VS Code adapter contract forbids native mutation');
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
    const env = {
      ...environment(root),
      electron_run_as_node: 'hostile-parent-value',
      vscode_dev: 'hostile-parent-value',
    };
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
    t.assert(!Object.keys(runner.calls[0].options.env).some(key => key === 'electron_run_as_node' || key === 'vscode_dev'), 'fixed VS Code overlay removes case-colliding parent aliases');
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

// Client discovery applies Windows environment semantics after process.env is copied to a plain object.
{
  const root = makeRoot();
  try {
    const layout = npmInstall(root, 'codex', { packageName: '@openai/codex' });
    const where = write(join(layout.env.SystemRoot, 'System32', 'where.exe'), 'where-binary');
    const env = {
      ...layout.env,
      SystemRoot: undefined,
      WINDIR: undefined,
      systemroot: layout.env.SystemRoot,
      APPDATA: undefined,
      appdata: layout.env.APPDATA,
      PATH: undefined,
      Path: layout.env.PATH,
      PATHEXT: undefined,
      Pathext: '.COM;.EXE;.BAT;.CMD',
    };
    const runner = runnerFor('0.144.4', {
      run: async executable => executable === resolve(where)
        ? { status: 'exited', exitCode: 0, stdout: `${layout.shim}\n`, stderr: '' }
        : { status: 'exited', exitCode: 0, stdout: '0.144.4\n', stderr: '' },
    });
    const result = await resolveClientLaunch('codex', {
      env,
      runner,
      candidates: { nodeExecutable: layout.nodeExecutable },
    });
    t.assert(result.write_supported && runner.calls[0].options.env.PATH === layout.env.PATH, 'client discovery honors case-variant Windows environment keys');

    const ambiguousEnv = { ...env, PATH: 'first', Path: 'second' };
    const ambiguousRunner = runnerFor('0.144.4');
    t.assert(await rejectsCode(() => resolveClientLaunch('codex', {
      env: ambiguousEnv,
      runner: ambiguousRunner,
      candidates: { nodeExecutable: layout.nodeExecutable },
    }), 'AMBIGUOUS_CLIENT_ENVIRONMENT'), 'client discovery rejects duplicate case-variant environment keys');
    t.assert(ambiguousRunner.calls.length === 0, 'ambiguous client discovery environment is rejected before process launch');
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
    const lowerHome = resolve(join(root, 'lower-claude-home'));
    const lowerContext = claudeContext(root, { env: { CLAUDE_CONFIG_DIR: undefined, claude_config_dir: lowerHome } });
    t.assert(resolveClaudeLocations(lowerContext).state.path === resolve(join(lowerHome, '.claude.json')), 'Claude config home lookup is case-insensitive');
    t.assert(throwsCode(() => resolveClaudeLocations(claudeContext(root, {
      env: { CLAUDE_CONFIG_DIR: lowerHome, claude_config_dir: resolve(join(root, 'other-claude-home')) },
    })), 'AMBIGUOUS_CLIENT_ENVIRONMENT'), 'Claude rejects duplicate case-variant config homes');
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
      args: [...context.descriptor.args],
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
    t.assert(hasOnlyContractActions(inspection.actions), 'Claude inspection emits only deployment-contract action codes');
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
    const lowerHome = resolve(join(root, 'lower-codex-home'));
    const lowerContext = codexContext(root, { env: { CODEX_HOME: undefined, codex_home: lowerHome } });
    t.assert(resolveCodexLocations(lowerContext).user.path === resolve(join(lowerHome, 'config.toml')), 'Codex home lookup is case-insensitive');
    t.assert(throwsCode(() => resolveCodexLocations(codexContext(root, {
      env: { CODEX_HOME: lowerHome, codex_home: resolve(join(root, 'other-codex-home')) },
    })), 'AMBIGUOUS_CLIENT_ENVIRONMENT'), 'Codex rejects duplicate case-variant homes');
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
    const adapter = createCodexAdapter({
      runner: codexNativeRunner(root),
      captureFingerprint: async path => simpleFingerprint(path),
    });
    const invalidLaunch = { ...codexLaunch(root), command: 'codex.exe' };
    t.assert(await rejectsCode(() => adapter.detect(codexContext(root, { launch: invalidLaunch })), 'INVALID_CLIENT_LAUNCH'), 'Codex detection validates the complete launch contract');
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

  const structuralDisagreementRoot = makeRoot();
  try {
    const context = codexContext(structuralDisagreementRoot);
    const locations = resolveCodexLocations(context);
    write(locations.user.path, `[mcp_servers.uemcp]\ncommand = ${JSON.stringify(context.descriptor.command)}\nargs = [${context.descriptor.args.map(value => JSON.stringify(value)).join(', ')}]\n`);
    const absent = { status: 'exited', exitCode: 1, stdout: '', stderr: "MCP server 'uemcp' not found" };
    const runner = codexNativeRunner(structuralDisagreementRoot, { list: absent, get: absent, rejectMutation: true });
    const adapter = createCodexAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'CONFIGURED' && inspection.native.status === 'ABSENT', 'Codex preserves structural registration when native evidence is absent');
    t.assert(inspection.actions.includes('CONFLICT') && hasOnlyContractActions(inspection.actions), 'Codex native disagreement uses the shared conflict action vocabulary');
  } finally {
    cleanup(structuralDisagreementRoot);
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
      args: [...context.descriptor.args],
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

// Gemini locations honor the home-root override, retain the nested .gemini directory, and pin system policy to a trusted root.
{
  const root = makeRoot();
  try {
    const context = geminiContext(root);
    const locations = resolveGeminiLocations(context);
    t.assert(locations.user.path === resolve(join(context.env.GEMINI_CLI_HOME, '.gemini', 'settings.json')), 'Gemini custom home resolves beneath a nested .gemini directory');
    t.assert(locations.enablement.path === resolve(join(context.env.GEMINI_CLI_HOME, '.gemini', 'mcp-server-enablement.json')), 'Gemini persistent enablement shares the nested global config directory');
    t.assert(locations.extensions_root.path === resolve(join(context.env.GEMINI_CLI_HOME, '.gemini', 'extensions')), 'Gemini extensions share the nested global config directory');
    t.assert(locations.project.path === resolve(join(context.workspaceRoot, '.gemini', 'settings.json')), 'Gemini project settings remain workspace scoped');
    t.assert(locations.system_defaults.path === resolve(join(context.knownFolders.programData, 'gemini-cli', 'system-defaults.json')), 'Gemini system defaults use trusted ProgramData evidence');
    t.assert(locations.system_override.path === resolve(join(context.knownFolders.programData, 'gemini-cli', 'settings.json')), 'Gemini system override uses trusted ProgramData evidence');
    const lowerCaseHome = resolve(join(root, 'lower-case-gemini-home'));
    const lowerCaseContext = geminiContext(root, {
      env: { GEMINI_CLI_HOME: undefined, gemini_cli_home: lowerCaseHome },
    });
    const lowerCaseLocations = resolveGeminiLocations(lowerCaseContext);
    t.assert(lowerCaseLocations.user.path === resolve(join(lowerCaseHome, '.gemini', 'settings.json')), 'Gemini resolves Windows environment names case-insensitively');
    const adapter = createGeminiAdapter({ runner: geminiNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    t.assert((await adapter.detect(lowerCaseContext)).custom_home === true, 'Gemini case-variant home remains a custom-home safety boundary');
    t.assert(await rejectsCode(() => adapter.detect(geminiContext(root, {
      env: {
        GEMINI_CLI_HOME: resolve(join(root, 'first-home')),
        gemini_cli_home: resolve(join(root, 'second-home')),
      },
    })), 'AMBIGUOUS_CLIENT_ENVIRONMENT'), 'Gemini rejects duplicate case-variant home keys before inspection and native launch diverge');
    t.assert(await rejectsCode(() => Promise.resolve(resolveGeminiLocations(geminiContext(root, {
      env: { GEMINI_CLI_HOME: '..\\relative' },
    }))), 'INVALID_CLIENT_LOCATION'), 'Gemini rejects a relative home override');
  } finally {
    cleanup(root);
  }
}

// Gemini absence plans one targeted user create, and unknown releases remain inspect-only.
{
  const root = makeRoot();
  try {
    const runner = geminiNativeRunner();
    const context = geminiContext(root);
    const adapter = createGeminiAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    const detection = await adapter.detect(context);
    const inspection = await adapter.inspect(context, detection);
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.registration === 'ABSENT' && inspection.enablement === 'UNKNOWN', 'Gemini distinguishes absent registration from unproven enablement');
    t.assert(plan.status === 'CREATE' && plan.operations.length === 1 && plan.operations[0].type === 'CREATE_ENTRY', 'Gemini absence plans one user create');
    t.assert(plan.operations[0].path === detection.locations.user.path && plan.operations[0].external_write === false, 'Gemini create uses the parser-backed private user path');
    t.assert(JSON.stringify(plan.operations[0].desired_entry) === JSON.stringify(physicalGeminiEntry(context.descriptor)), 'Gemini create owns only command and args');
    t.assert(runner.calls.length === 1 && runner.calls[0].args.slice(-2).join(' ') === 'mcp list', 'Gemini inspection invokes only the read-only native list command');
    t.assert(runner.calls[0].options.shell === false && runner.calls[0].options.timeoutMs <= 10_000 && runner.calls[0].options.outputLimitBytes <= 64 * 1024, 'Gemini native inspection is shell-free and bounded');

    const unsupportedContext = geminiContext(root, { launch: geminiLaunch(root, { version: '0.42.0', writeSupported: false }) });
    const unsupportedInspection = await adapter.inspect(unsupportedContext, await adapter.detect(unsupportedContext));
    const unsupportedPlan = await adapter.plan(unsupportedContext, unsupportedInspection, unsupportedContext.descriptor);
    t.assert(unsupportedPlan.status === 'UNSUPPORTED_VERSION' && unsupportedPlan.operations.length === 0, 'unknown Gemini versions cannot plan writes');
  } finally {
    cleanup(root);
  }
}

// Exact Gemini entries are adoptable without rewriting comments, trust, launch policy, or environment state.
{
  const root = makeRoot();
  try {
    const ledger = memoryOwnershipLedger();
    const context = geminiContext(root, { ownershipLedger: ledger, workspaceTrusted: true });
    const locations = resolveGeminiLocations(context);
    write(locations.user.path, sample('gemini-user-preservation.jsonc', {
      COMMAND: context.descriptor.command,
      SERVER: context.descriptor.args[0],
    }));
    const before = readFileSync(locations.user.path);
    const adapter = createGeminiAdapter({
      runner: geminiNativeRunner({ status: 'exited', exitCode: 0, stdout: sample('gemini-native-disconnected.txt'), stderr: '' }),
      captureFingerprint: async path => simpleFingerprint(path),
    });
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    const serialized = JSON.stringify(inspection);
    t.assert(inspection.registration === 'CONFIGURED' && inspection.effective.scope === 'user', 'Gemini recognizes an exact user registration');
    t.assert(inspection.actions.includes('CUSTOM_ENV_REVIEW_REQUIRED') && inspection.actions.includes('CUSTOM_LAUNCH_REVIEW_REQUIRED'), 'Gemini reports custom environment and cwd review');
    t.assert(!serialized.includes('do-not-serialize') && !serialized.includes('preserve-me'), 'Gemini inspection never emits environment values');
    t.assert(serialized.includes('UEMCP_PRIVATE_TOKEN') && serialized.includes('HARMLESS'), 'Gemini retains environment key names as safe evidence');
    let plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'ADOPT' && plan.operations[0].type === 'ADOPT_EXACT_ENTRY', 'Gemini exact unowned entry requires visible adoption');
    const transaction = adapterTransaction(ledger);
    await adapter.apply({ ...context, transaction }, plan.operations);
    t.assert(readFileSync(locations.user.path).equals(before), 'Gemini adoption preserves provider bytes exactly');
    t.assert(transaction.writes.length === 1 && transaction.writes[0].path === '<ownership-ledger>', 'Gemini adoption writes only ownership state');
    inspection = await adapter.inspect(context, await adapter.detect(context));
    plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'NO_OP' && plan.operations.length === 0, 'owned exact Gemini entry becomes an idempotent no-op');
  } finally {
    cleanup(root);
  }
}

// Gemini scope precedence reports every occurrence and never writes beneath an effective project or system override.
{
  const root = makeRoot();
  try {
    const context = geminiContext(root, { workspaceTrusted: true });
    const locations = resolveGeminiLocations(context);
    const desired = physicalGeminiEntry(context.descriptor);
    writeJson(locations.system_defaults.path, { mcpServers: { uemcp: { command: 'C:\\Defaults\\node.exe', args: [] } } });
    writeJson(locations.user.path, { mcpServers: { uemcp: desired } });
    writeJson(locations.project.path, { mcpServers: { uemcp: { command: 'C:\\Project\\node.exe', args: [] } } });
    const adapter = createGeminiAdapter({ runner: geminiNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.effective.scope === 'project' && inspection.registration === 'CONFLICT', 'trusted Gemini project settings shadow the user entry');
    t.assert(inspection.occurrences.map(row => row.scope).join(',') === 'system_defaults,user,project', 'Gemini reports settings occurrences in precedence order');
    t.assert((await adapter.plan(context, inspection, context.descriptor)).operations.length === 0, 'Gemini never rewrites user settings beneath a project conflict');

    const untrusted = geminiContext(root, { workspaceTrusted: false, ownershipLedger: context.ownershipLedger });
    inspection = await adapter.inspect(untrusted, await adapter.detect(untrusted));
    t.assert(inspection.effective.scope === 'user' && inspection.registration === 'CONFIGURED', 'untrusted Gemini project settings do not shadow user settings');
    t.assert(inspection.ignored_project?.reason === 'UNTRUSTED_PROJECT', 'ignored Gemini project evidence remains visible');

    writeJson(locations.system_override.path, { mcpServers: { uemcp: { command: 'C:\\Policy\\node.exe', args: [] } } });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.effective.scope === 'system_override' && inspection.registration === 'CONFLICT', 'Gemini system override has final precedence');
    t.assert((await adapter.plan(context, inspection, context.descriptor)).status === 'CONFLICT', 'Gemini system override conflicts cannot be replaced through user scope');
  } finally {
    cleanup(root);
  }
}

// Gemini protocol smoke uses the fully merged effective settings entry, not one physical occurrence.
{
  const root = makeRoot();
  try {
    const context = geminiContext(root, { workspaceTrusted: true });
    const locations = resolveGeminiLocations(context);
    const desired = physicalGeminiEntry(context.descriptor);
    writeJson(locations.system_defaults.path, {
      mcpServers: {
        uemcp: {
          ...desired,
          cwd: 'C:\\Defaults',
          env: { BASE: 'defaults', SHARED: 'defaults' },
        },
      },
    });
    writeJson(locations.user.path, {
      mcpServers: { uemcp: { env: { USER_ONLY: 'user', SHARED: 'user' } } },
    });
    writeJson(locations.project.path, {
      mcpServers: { uemcp: { cwd: 'C:\\Project', env: { PROJECT_ONLY: 'project', SHARED: 'project' } } },
    });
    writeJson(locations.system_override.path, {
      mcpServers: { uemcp: { env: { OVERRIDE_ONLY: 'override', SHARED: 'override' } } },
    });
    const adapter = createGeminiAdapter({ runner: geminiNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const launch = adapter.protocolLaunch(context, inspection);
    t.assert(inspection.registration === 'CONFIGURED' && inspection.effective.scope === 'system_override', 'Gemini merged settings retain final precedence and canonical owned fields');
    t.assert(JSON.stringify(launch.env_overlay) === JSON.stringify({
      BASE: 'defaults',
      SHARED: 'override',
      USER_ONLY: 'user',
      PROJECT_ONLY: 'project',
      OVERRIDE_ONLY: 'override',
    }), 'Gemini protocol launch contains the deep-merged effective environment');
    t.assert(launch.cwd === 'C:\\Project', 'Gemini protocol launch retains the effective inherited working directory');
  } finally {
    cleanup(root);
  }
}

// Gemini treats case-colliding logical server IDs as conflicts instead of creating a duplicate canonical name.
{
  const root = makeRoot();
  try {
    const context = geminiContext(root, { workspaceTrusted: true, approvedExtensionShadow: true });
    const locations = resolveGeminiLocations(context);
    const desired = physicalGeminiEntry(context.descriptor);
    writeJson(locations.user.path, { mcpServers: { UEMCP: desired } });
    const adapter = createGeminiAdapter({ runner: geminiNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    let plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.registration === 'CONFLICT' && inspection.logical_name_conflict === true, 'Gemini detects a case-colliding user server ID');
    t.assert(plan.status === 'CONFLICT' && plan.operations.length === 0, 'Gemini never adds a duplicate canonical ID beside a case-colliding user entry');

    rmSync(locations.user.path);
    writeJson(join(locations.extensions_root.path, 'case-collision', 'gemini-extension.json'), {
      name: 'case-collision',
      version: '1.0.0',
      mcpServers: { UEMCP: desired },
    });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.registration === 'CONFLICT' && inspection.logical_name_conflict === true, 'Gemini detects a case-colliding extension server ID');
    t.assert(plan.status === 'CONFLICT' && plan.operations.length === 0, 'extension-shadow approval cannot hide a differently cased logical server ID');
  } finally {
    cleanup(root);
  }
}

// Gemini policy, persistent enablement, and native session state remain separate evidence.
{
  const cases = [
    { label: 'allowlist omission', settings: { mcp: { allowed: ['other'] } }, expected: 'POLICY_BLOCKED' },
    { label: 'explicit exclusion', settings: { mcp: { excluded: ['UEMCP'] } }, expected: 'POLICY_BLOCKED' },
    { label: 'administrator disable', settings: { admin: { mcp: { enabled: false } } }, expected: 'POLICY_BLOCKED' },
    { label: 'administrator remote allowlist replacement', settings: desired => ({ admin: { mcp: { config: { uemcp: desired } } } }), expected: 'POLICY_BLOCKED' },
    { label: 'administrator required remote replacement', settings: desired => ({ admin: { mcp: { requiredConfig: { uemcp: desired } } } }), expected: 'POLICY_BLOCKED' },
  ];
  for (const testCase of cases) {
    const root = makeRoot();
    try {
      const context = geminiContext(root, { workspaceTrusted: true });
      const locations = resolveGeminiLocations(context);
      const desired = physicalGeminiEntry(context.descriptor);
      const settings = typeof testCase.settings === 'function' ? testCase.settings(desired) : testCase.settings;
      writeJson(locations.user.path, {
        ...settings,
        mcpServers: { uemcp: desired },
      });
      const adapter = createGeminiAdapter({ runner: geminiNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
      const inspection = await adapter.inspect(context, await adapter.detect(context));
      t.assert(inspection.policy === testCase.expected && inspection.enablement === 'POLICY_BLOCKED', `Gemini ${testCase.label} blocks enablement`);
      t.assert(inspection.actions.includes('CLIENT_ENABLEMENT_REQUIRED'), `Gemini ${testCase.label} emits a client action without changing policy`);
    } finally {
      cleanup(root);
    }
  }

  const root = makeRoot();
  try {
    const context = geminiContext(root, { workspaceTrusted: true });
    const locations = resolveGeminiLocations(context);
    writeJson(locations.user.path, { mcpServers: { uemcp: physicalGeminiEntry(context.descriptor) } });
    writeJson(locations.enablement.path, { uemcp: { enabled: false }, unrelated: { enabled: false } });
    const adapter = createGeminiAdapter({
      runner: geminiNativeRunner({ status: 'exited', exitCode: 0, stdout: sample('gemini-native-disabled.txt'), stderr: '' }),
      captureFingerprint: async path => simpleFingerprint(path),
    });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'CONFIGURED' && inspection.enablement === 'DISABLED' && inspection.enablement_evidence.status === 'READY', 'Gemini normalized persistent disable remains separate from registration');
    t.assert(inspection.native.status === 'DISABLED' && inspection.actions.includes('CLIENT_ENABLEMENT_REQUIRED'), 'Gemini native disabled evidence cannot be promoted to connected');
    t.assert(inspection.remediation_actions[0].command === null, 'Gemini custom-home enablement action cannot target the wrong home');
    t.assert(readFileSync(locations.enablement.path, 'utf8').includes('unrelated'), 'Gemini adapter never writes persistent enablement state');

    const defaultContext = geminiContext(root, { env: { GEMINI_CLI_HOME: undefined }, workspaceTrusted: true });
    const defaultLocations = resolveGeminiLocations(defaultContext);
    writeJson(defaultLocations.user.path, { mcpServers: { uemcp: physicalGeminiEntry(defaultContext.descriptor) } });
    writeJson(defaultLocations.enablement.path, { uemcp: { enabled: false } });
    const defaultInspection = await adapter.inspect(defaultContext, await adapter.detect(defaultContext));
    const command = defaultInspection.remediation_actions[0].command;
    t.assert(command.executable === defaultContext.launch.command && command.args.slice(-3).join(' ') === 'mcp enable uemcp', 'Gemini default-home enablement action is an exact structured command');
  } finally {
    cleanup(root);
  }
}

// Gemini extension declarations are bounded, path-sensitive, non-hydrated, and explicitly shadowed only with approval.
{
  const root = makeRoot();
  try {
    const context = geminiContext(root, { workspaceTrusted: true });
    const locations = resolveGeminiLocations(context);
    const desired = physicalGeminiEntry(context.descriptor);
    const extensionDir = join(locations.extensions_root.path, 'exact-extension');
    writeJson(join(extensionDir, 'gemini-extension.json'), {
      name: 'exact-extension',
      version: '1.0.0',
      mcpServers: { uemcp: desired },
    });
    const adapter = createGeminiAdapter({ runner: geminiNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'CONFIGURED' && inspection.effective.scope === 'extension', 'enabled extension-only Gemini registration can be effective');
    t.assert(inspection.extensions.length === 1 && inspection.extensions[0].enabled === true, 'Gemini reports enabled extension provenance');
    t.assert((await adapter.plan(context, inspection, context.descriptor)).status === 'NO_OP', 'exact extension registration is not redundantly shadowed');

    writeJson(locations.extensions_enablement.path, {
      'exact-extension': { overrides: [`!${context.workspaceRoot.replaceAll('\\', '/')}/`] },
    });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'ABSENT' && inspection.extensions[0].enabled === false, 'path-disabled Gemini extension does not supply an effective server');
    t.assert((await adapter.plan(context, inspection, context.descriptor)).status === 'CREATE', 'disabled extension does not block a canonical user registration');

    writeJson(locations.extensions_enablement.path, {});
    writeJson(join(extensionDir, 'gemini-extension.json'), {
      name: 'exact-extension',
      version: '1.0.0',
      mcpServers: { uemcp: { command: 'C:\\Extension\\node.exe', args: ['${SECRET_EXTENSION_VALUE}'] } },
    });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    const serialized = JSON.stringify(inspection);
    t.assert(inspection.registration === 'CONFLICT' && !serialized.includes('SECRET_EXTENSION_VALUE'), 'Gemini variable-bearing extension conflict is never hydrated or exposed');
    t.assert((await adapter.plan(context, inspection, context.descriptor)).operations.length === 0, 'Gemini extension shadowing requires explicit approval');
    const approved = geminiContext(root, { workspaceTrusted: true, approvedExtensionShadow: true, ownershipLedger: context.ownershipLedger });
    const approvedPlan = await adapter.plan(approved, inspection, approved.descriptor);
    t.assert(approvedPlan.status === 'CREATE' && approvedPlan.operations[0].shadows_extension === true, 'approved Gemini extension shadow is explicit in the operation');

    writeJson(locations.user.path, { mcpServers: { uemcp: desired } });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.effective.scope === 'user' && inspection.occurrences.some(row => row.scope === 'extension'), 'Gemini user registration wins while retaining extension occurrence evidence');

    writeJson(join(locations.extensions_root.path, 'second-extension', 'gemini-extension.json'), {
      name: 'second-extension',
      version: '1.0.0',
      mcpServers: { uemcp: desired },
    });
    rmSync(locations.user.path);
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'CONFLICT' && inspection.actions.includes('CONFLICT'), 'multiple Gemini extension declarations fail closed');
    t.assert(hasOnlyContractActions(inspection.actions), 'Gemini extension ambiguity uses only deployment-contract action codes');
  } finally {
    cleanup(root);
  }
}

// Administrator-disabled Gemini extensions cannot shadow settings or block a safe user registration.
{
  const root = makeRoot();
  try {
    const context = geminiContext(root, { workspaceTrusted: true });
    const locations = resolveGeminiLocations(context);
    writeJson(locations.user.path, { admin: { extensions: { enabled: false } } });
    writeJson(join(locations.extensions_root.path, 'disabled-by-admin', 'gemini-extension.json'), {
      name: 'disabled-by-admin',
      version: '1.0.0',
      mcpServers: { uemcp: { command: 'C:\\Extension\\node.exe', args: [] } },
    });
    write(locations.extensions_enablement.path, '{ malformed but irrelevant while extensions are disabled');
    const adapter = createGeminiAdapter({ runner: geminiNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.extensions_enabled === false && inspection.registration === 'ABSENT', 'Gemini admin extension disable removes extension declarations from effective state');
    t.assert(inspection.extension_evidence === 'READY' && plan.status === 'CREATE', 'irrelevant disabled-extension state cannot block a canonical user registration');
  } finally {
    cleanup(root);
  }
}

// Duplicate Gemini extension names make host extension loading ambiguous even when only one declares UEMCP.
{
  const root = makeRoot();
  try {
    const context = geminiContext(root, { workspaceTrusted: true });
    const locations = resolveGeminiLocations(context);
    writeJson(join(locations.extensions_root.path, 'first', 'gemini-extension.json'), {
      name: 'duplicate-name',
      version: '1.0.0',
      mcpServers: { uemcp: physicalGeminiEntry(context.descriptor) },
    });
    writeJson(join(locations.extensions_root.path, 'second', 'gemini-extension.json'), {
      name: 'duplicate-name',
      version: '1.0.0',
      mcpServers: {},
    });
    const adapter = createGeminiAdapter({ runner: geminiNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(inspection.extension_evidence === 'UNKNOWN' && inspection.registration === 'UNKNOWN', 'duplicate Gemini extension names invalidate effective extension evidence');
    t.assert(plan.status === 'POLICY_UNKNOWN' && plan.operations.length === 0, 'duplicate Gemini extension identities block writes instead of guessing precedence');
  } finally {
    cleanup(root);
  }
}

// Gemini rejects malformed provider syntax, linked host state, and extension/aggregate inspection overflow.
{
  const root = makeRoot();
  try {
    const context = geminiContext(root);
    const locations = resolveGeminiLocations(context);
    write(locations.user.path, '{\n  // comments are valid\n  "mcpServers": {},\n}\n');
    let adapter = createGeminiAdapter({ runner: geminiNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'MALFORMED_CONFIG', 'Gemini rejects trailing commas exactly as release 0.41.2 does');

    writeJson(locations.user.path, { mcpServers: { uemcp: physicalGeminiEntry(context.descriptor) } });
    const source = write(join(root, 'linked-enablement.json'), '{"uemcp":{"enabled":false}}');
    mkdirSync(dirname(locations.enablement.path), { recursive: true });
    linkSync(source, locations.enablement.path);
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'UNSAFE_CONFIG_PATH' && inspection.enablement === 'UNKNOWN', 'Gemini linked enablement evidence cannot authorize a write or enabled state');

    rmSync(locations.enablement.path);
    for (const name of ['one', 'two']) {
      writeJson(join(locations.extensions_root.path, name, 'gemini-extension.json'), {
        name,
        version: '1.0.0',
        mcpServers: {},
      });
    }
    adapter = createGeminiAdapter({
      runner: geminiNativeRunner(),
      captureFingerprint: async path => simpleFingerprint(path),
      limits: { fileBytes: 1024, aggregateBytes: 8192, extensionRecords: 1 },
    });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'INSPECTION_LIMIT_EXCEEDED', 'Gemini extension record overflow fails closed');

    write(locations.user.path, '{}\n');
    adapter = createGeminiAdapter({
      runner: geminiNativeRunner(),
      captureFingerprint: async path => simpleFingerprint(path),
      limits: { fileBytes: 64, aggregateBytes: 100, extensionRecords: 8 },
    });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'INSPECTION_LIMIT_EXCEEDED', 'Gemini aggregate config bytes are bounded across settings and extensions');
  } finally {
    cleanup(root);
  }
}

// Gemini extension enablement records and individual path rules have independent CPU/memory ceilings.
{
  const root = makeRoot();
  try {
    const context = geminiContext(root, { workspaceTrusted: true });
    const locations = resolveGeminiLocations(context);
    writeJson(join(locations.extensions_root.path, 'bounded-extension', 'gemini-extension.json'), {
      name: 'bounded-extension',
      version: '1.0.0',
      mcpServers: {},
    });
    writeJson(locations.extensions_enablement.path, {
      'bounded-extension': { overrides: ['/one/', '/two/', '/three/'] },
    });
    let adapter = createGeminiAdapter({
      runner: geminiNativeRunner(),
      captureFingerprint: async path => simpleFingerprint(path),
      limits: { extensionRecords: 4 },
    });
    let inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'INSPECTION_LIMIT_EXCEEDED', 'Gemini counts enablement keys and overrides in the aggregate extension-record ceiling');

    writeJson(locations.extensions_enablement.path, {
      'bounded-extension': { overrides: [`/${'x'.repeat(64)}/`] },
    });
    adapter = createGeminiAdapter({
      runner: geminiNativeRunner(),
      captureFingerprint: async path => simpleFingerprint(path),
      limits: { extensionRecords: 8, extensionRuleBytes: 16 },
    });
    inspection = await adapter.inspect(context, await adapter.detect(context));
    t.assert(inspection.registration === 'INSPECTION_LIMIT_EXCEEDED', 'Gemini bounds each extension path rule before matching');
  } finally {
    cleanup(root);
  }
}

// Gemini native output parsing is target-specific, ambiguity-resistant, and keeps activation separate from enablement.
{
  const connected = classifyGeminiNativeStatus({ status: 'exited', exitCode: 0, stdout: sample('gemini-native-connected.txt'), stderr: '' });
  const disconnected = classifyGeminiNativeStatus({ status: 'exited', exitCode: 0, stdout: sample('gemini-native-disconnected.txt'), stderr: '' });
  const disabled = classifyGeminiNativeStatus({ status: 'exited', exitCode: 0, stdout: sample('gemini-native-disabled.txt'), stderr: '' });
  const blocked = classifyGeminiNativeStatus({ status: 'exited', exitCode: 0, stdout: sample('gemini-native-blocked.txt'), stderr: '' });
  t.assert(connected.status === 'CONNECTED' && connected.enablement === 'ENABLED', 'Gemini native parser recognizes connected target status');
  t.assert(disconnected.status === 'DISCONNECTED' && disconnected.activation === 'UNKNOWN', 'Gemini native parser keeps disconnected activation unproven');
  t.assert(disabled.status === 'DISABLED' && disabled.enablement === 'DISABLED', 'Gemini native parser recognizes disabled target status');
  t.assert(blocked.status === 'BLOCKED' && blocked.enablement === 'POLICY_BLOCKED', 'Gemini native parser recognizes policy-blocked target status');
  t.assert(classifyGeminiNativeStatus({ status: 'timed_out', exitCode: null, stdout: '', stderr: '' }).status === 'TIMEOUT', 'Gemini native parser preserves timeout distinctly');
  t.assert(classifyGeminiNativeStatus({ status: 'exited', exitCode: 0, stdout: 'No MCP servers configured.\n', stderr: '' }).status === 'ABSENT', 'Gemini native parser recognizes explicit absence');
  const spoofed = `${sample('gemini-native-disconnected.txt')}\n${sample('gemini-native-connected.txt')}`;
  t.assert(classifyGeminiNativeStatus({ status: 'exited', exitCode: 0, stdout: spoofed, stderr: '' }).status === 'AMBIGUOUS', 'Gemini native parser rejects duplicate target lines instead of accepting injected status');
}

// Owned Gemini updates patch command and args only while preserving every client-owned field.
{
  const root = makeRoot();
  try {
    const ledger = memoryOwnershipLedger();
    const context = geminiContext(root, { ownershipLedger: ledger, workspaceTrusted: true });
    const locations = resolveGeminiLocations(context);
    const oldEntry = {
      command: resolve(write(join(root, 'old-runtime', 'node.exe'), 'node')),
      args: [...context.descriptor.args],
      trust: false,
      cwd: 'C:\\Preserve\\Workspace',
      env: { API_TOKEN: 'secret', HARMLESS: 'keep' },
      timeout: 6200,
    };
    writeJson(locations.user.path, {
      mcpServers: { other: { httpUrl: 'https://example.invalid' }, uemcp: oldEntry },
      unrelated: { keep: true },
    });
    await recordOwnedWrite({
      ledger,
      location: { clientId: 'gemini', configPath: locations.user.path, scope: 'user', entryName: 'uemcp' },
      beforeEntry: null,
      afterEntry: oldEntry,
      ownedPaths: ownedPathsForClient('gemini', oldEntry),
      appliedConfigHash: sha256Bytes(readFileSync(locations.user.path)),
      planDigest: TEST_PLAN_DIGEST,
    });
    const adapter = createGeminiAdapter({ runner: geminiNativeRunner(), captureFingerprint: async path => simpleFingerprint(path) });
    const inspection = await adapter.inspect(context, await adapter.detect(context));
    const plan = await adapter.plan(context, inspection, context.descriptor);
    t.assert(plan.status === 'UPDATE' && plan.operations[0].type === 'UPDATE_OWNED_FIELDS', 'Gemini owned stale identity plans a targeted update');
    const transaction = adapterTransaction(ledger);
    await adapter.apply({ ...context, transaction }, plan.operations);
    const after = JSON.parse(readFileSync(locations.user.path, 'utf8'));
    t.assert(after.mcpServers.uemcp.command === context.descriptor.command && JSON.stringify(after.mcpServers.uemcp.args) === JSON.stringify(context.descriptor.args), 'Gemini update writes canonical command and args');
    t.assert(after.mcpServers.uemcp.trust === false && after.mcpServers.uemcp.cwd === oldEntry.cwd && after.mcpServers.uemcp.timeout === 6200, 'Gemini update preserves trust, cwd, and timeout');
    t.assert(JSON.stringify(after.mcpServers.uemcp.env) === JSON.stringify(oldEntry.env) && after.mcpServers.other.httpUrl && after.unrelated.keep, 'Gemini update preserves environment, unrelated servers, and top-level state');
  } finally {
    cleanup(root);
  }
}

// Native Gemini mutation remains forbidden because release 0.41.2 defaults to project scope and replaces same-name/unrelated settings.
{
  t.assert(GEMINI_NATIVE_MUTATION_CHARACTERIZATION.version === '0.41.2', 'Gemini mutation characterization is release-bound');
  t.assert(GEMINI_NATIVE_MUTATION_CHARACTERIZATION.default_scope === 'project', 'Gemini native add defaults to project scope');
  t.assert(GEMINI_NATIVE_MUTATION_CHARACTERIZATION.same_name_replaced === true, 'Gemini native add replaces a same-name server');
  t.assert(GEMINI_NATIVE_MUTATION_CHARACTERIZATION.unrelated_settings_preserved === false, 'Gemini native add is forbidden because it can discard unrelated settings');
  t.assert(GEMINI_NATIVE_MUTATION_CHARACTERIZATION.mutating_subcommands_allowed === false, 'Gemini adapter contract forbids native mutation');
}

// Every adapter-native query invokes the apply-time guard immediately before process launch.
for (const clientId of ['claude', 'codex', 'gemini']) {
  const root = makeRoot();
  try {
    let guards = 0;
    let launches = 0;
    let ordered = true;
    const baseRunner = clientId === 'claude'
      ? claudeNativeRunner()
      : clientId === 'codex'
        ? codexNativeRunner(root)
        : geminiNativeRunner();
    const runner = {
      async run(...args) {
        if (guards !== launches + 1) ordered = false;
        launches += 1;
        return baseRunner.run(...args);
      },
    };
    const beforeActiveClientLaunch = async evidence => {
      if (evidence?.client_id !== clientId || evidence?.kind !== 'native') ordered = false;
      guards += 1;
    };
    const context = clientId === 'claude'
      ? claudeContext(root, { beforeActiveClientLaunch })
      : clientId === 'codex'
        ? codexContext(root, { beforeActiveClientLaunch })
        : geminiContext(root, { beforeActiveClientLaunch });
    const adapter = clientId === 'claude'
      ? createClaudeAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) })
      : clientId === 'codex'
        ? createCodexAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) })
        : createGeminiAdapter({ runner, captureFingerprint: async path => simpleFingerprint(path) });
    await adapter.inspect(context, await adapter.detect(context));
    t.assert(launches > 0 && guards === launches && ordered, `${clientId} native queries are guarded immediately before every process launch`);
  } finally {
    cleanup(root);
  }
}

function aggregateLaunch(clientId, overrides = {}) {
  const vscode = clientId === 'vscode';
  return Object.freeze({
    client_id: clientId,
    command: vscode ? 'C:\\Program Files\\Microsoft VS Code\\Code.exe' : 'C:\\Program Files\\nodejs\\node.exe',
    args_prefix: Object.freeze([vscode
      ? 'C:\\Program Files\\Microsoft VS Code\\resources\\app\\out\\cli.js'
      : `C:\\isolated\\${clientId}.mjs`]),
    env_overlay: Object.freeze(vscode ? { ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' } : {}),
    package_id: vscode ? null : {
      claude: '@anthropic-ai/claude-code',
      codex: '@openai/codex',
      gemini: '@google/gemini-cli',
    }[clientId],
    source: vscode ? 'native' : 'npm_package',
    version: RELEASE_GATES[clientId].versions.at(-1),
    compatibility: 'release_gated',
    write_supported: true,
    fingerprint: Object.freeze({ command: Object.freeze({ content_sha256: 'a'.repeat(64) }) }),
    ...overrides,
  });
}

function absentClient(clientId) {
  return Object.freeze({
    client_id: clientId,
    version: null,
    compatibility: 'not_installed',
    write_supported: false,
    launch: null,
    discovery_status: 'NOT_INSTALLED',
  });
}

function aggregateAdapter(clientId, scenario = {}) {
  return Object.freeze({
    id: clientId,
    async detect(context) {
      return Object.freeze({ client_id: clientId, launch: context.launch });
    },
    async inspect() {
      const environment = scenario.environment ?? [];
      return Object.freeze({
        client_id: clientId,
        registration: scenario.registration ?? 'CONFIGURED',
        enablement: scenario.enablement ?? 'ENABLED',
        activation: scenario.activation ?? 'CONNECTED',
        actions: Object.freeze([...(scenario.actions ?? [])]),
        occurrences: Object.freeze([Object.freeze({
          scope: scenario.scope ?? 'user',
          path: `C:\\isolated\\${clientId}.json`,
          matching: true,
          environment: Object.freeze({
            keys: Object.freeze(environment.map(row => row.name)),
            value_hashes: Object.freeze(Object.fromEntries(environment.map(row => [row.name, row.value_sha256]))),
          }),
          custom_launch: scenario.cwd !== null && scenario.cwd !== undefined,
          ownership: scenario.ownedDiff ? Object.freeze({ owned_diff: scenario.ownedDiff }) : null,
        })]),
        effective: Object.freeze({
          scope: scenario.scope ?? 'user',
          path: `C:\\isolated\\${clientId}.json`,
          matching: true,
        }),
        native: Object.freeze({ status: scenario.nativeStatus ?? 'PRESENT' }),
        files: Object.freeze([...(scenario.files ?? [])]),
      });
    },
    async plan() {
      return Object.freeze({
        client_id: clientId,
        status: scenario.operation ?? 'NO_OP',
        operations: Object.freeze([]),
        actions: Object.freeze([...(scenario.actions ?? [])]),
      });
    },
    async snapshot() {
      return Object.freeze({ writable_paths: Object.freeze([]), read_only_paths: Object.freeze([]) });
    },
    async apply() {
      return Object.freeze({ status: 'NO_OP' });
    },
    async verify() {
      return Object.freeze({ status: scenario.verifyStatus ?? 'READY', native: Object.freeze({ status: scenario.nativeStatus ?? 'PRESENT' }) });
    },
    async rollback() {
      return Object.freeze({ status: 'delegated', count: 0 });
    },
    protocolLaunch() {
      return Object.freeze({
        env_overlay: Object.freeze({ ...(scenario.privateEnvironment ?? {}) }),
        cwd: scenario.cwd ?? null,
      });
    },
  });
}

function aggregateContext(root, overrides = {}) {
  return {
    operation: overrides.operation ?? 'verify',
    request: {
      requested_project: null,
      requested_profile: null,
      selected_clients: overrides.selectedClients ?? [],
    },
    clientSelection: {
      include: overrides.include ?? [],
      exclude: overrides.exclude ?? [],
      vscodeProfile: overrides.vscodeProfile ?? null,
    },
    descriptor: canonicalDesired(root),
    env: overrides.env ?? environment(root),
    workspaceRoot: resolve(join(root, 'workspace')),
    now: new Date('2026-07-16T12:00:00.000Z'),
    source: {
      kind: 'git_checkout',
      repository: 'https://example.invalid/uemcp.git',
      repo_root: resolve(root),
      git_commit: 'a'.repeat(40),
      dirty: false,
      archive: null,
      orchestrator_version: '1.0.0',
    },
    ...overrides,
  };
}

function aggregateClientOperation(root, clientId = 'claude') {
  const path = write(join(root, 'aggregate-client', `${clientId}.json`), '{"before":true}\n');
  const fingerprint = simpleFingerprint(path);
  return Object.freeze({
    operation_id: `${clientId}-aggregate-write`,
    client_id: clientId,
    selected: true,
    write_supported: true,
    type: 'UPDATE_OWNED_FIELDS',
    path: resolve(path),
    allowed_root: resolve(root),
    scope_kind: 'user',
    fingerprint,
    current_config_sha256: fingerprint.content_sha256,
    current_entry_sha256: null,
    owned_paths: Object.freeze(['/command', '/args']),
    shared_resource_id: null,
    plan_digest: TEST_PLAN_DIGEST,
    read_only_paths: Object.freeze([]),
    desired_entry: Object.freeze({ command: 'C:\\runtime\\node.exe', args: Object.freeze(['C:\\server\\server.mjs']) }),
  });
}

function aggregatePlanDocument(context, planned, outcome = 'ACTION_REQUIRED') {
  return createPlanDocument({
    operation: 'setup',
    outcome,
    source: context.source,
    request: context.request,
    descriptor: context.descriptor,
    stages: planned.stages,
    clients: planned.clients,
    operations: planned.operations,
    preconditions: planned.preconditions,
    actions: planned.actions,
    now: context.now,
  });
}

// Discovery always returns the closed client set; selection is exact and release-gated by default.
{
  const resolvers = Object.fromEntries(CLIENT_IDS.map(clientId => [clientId, async () => aggregateLaunch(clientId)]));
  const discovered = await discoverClients({ env: {}, workspaceRoot: 'C:\\isolated', requestedProfile: null, resolvers });
  t.assert(JSON.stringify(discovered.map(row => row.client_id)) === JSON.stringify(CLIENT_IDS), 'aggregate discovery returns every closed client ID in order');
  t.assert(selectClients(discovered, {}).every(row => row.selected), 'all detected release-gated clients default selected');
  t.assert(selectClients(discovered, { include: ['codex'] }).filter(row => row.selected).map(row => row.client_id).join(',') === 'codex', 'exact include selects only the requested client');
  const excluded = selectClients(discovered, { exclude: ['gemini'] });
  t.assert(excluded.find(row => row.client_id === 'gemini').status === 'NOT_SELECTED', 'exact exclude retains an explicit NOT_SELECTED row');
  t.assert(throwsCode(() => selectClients(discovered, { include: ['unknown-client'] }), 'INVALID_CLIENT_SELECTION'), 'unknown include IDs fail closed');
  t.assert(throwsCode(() => selectClients(discovered, { include: ['claude'], exclude: ['claude'] }), 'INVALID_CLIENT_SELECTION'), 'overlapping include and exclude IDs fail closed');

  const one = selectClients(CLIENT_IDS.map(clientId => clientId === 'codex'
    ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
    : absentClient(clientId)), {});
  t.assert(one.filter(row => row.selected).map(row => row.client_id).join(',') === 'codex', 'one installed client produces one default selection');
  t.assert(selectClients(CLIENT_IDS.map(absentClient), {}).every(row => !row.selected && row.status === 'NOT_INSTALLED'), 'no installed clients remain visible and unselected');

  const unsupported = CLIENT_IDS.map(clientId => clientId === 'claude'
    ? { ...aggregateLaunch(clientId, { version: '99.0.0', compatibility: 'unknown_newer', write_supported: false }), launch: aggregateLaunch(clientId, { version: '99.0.0', compatibility: 'unknown_newer', write_supported: false }) }
    : absentClient(clientId));
  t.assert(selectClients(unsupported, {}).every(row => !row.selected), 'unsupported versions do not default into the write selection');
  const explicitlyInspected = selectClients(unsupported, { include: ['claude'] }).find(row => row.client_id === 'claude');
  t.assert(explicitlyInspected.selected && explicitlyInspected.write_supported === false && explicitlyInspected.compatibility === 'unknown_newer', 'explicit unsupported selection remains inspectable but cannot write');

  const missingResolvers = Object.fromEntries(CLIENT_IDS.map(clientId => [clientId, async () => {
    throw Object.assign(new Error('not installed'), { code: 'NOT_INSTALLED' });
  }]));
  missingResolvers.unrecognized = async () => ({ client_id: 'unrecognized' });
  const unknownOnly = await discoverClients({ env: {}, workspaceRoot: 'C:\\isolated', requestedProfile: null, resolvers: missingResolvers });
  t.assert(unknownOnly.length === CLIENT_IDS.length && unknownOnly.every(row => row.compatibility === 'not_installed'), 'an unknown client does not displace closed NOT_INSTALLED rows');

  const failedProbeResolvers = { ...missingResolvers };
  failedProbeResolvers.codex = async () => {
    throw Object.assign(new Error('installed client version probe failed'), { code: 'VERSION_PROBE_FAILED' });
  };
  const failedProbe = await discoverClients({ env: {}, workspaceRoot: 'C:\\isolated', requestedProfile: null, resolvers: failedProbeResolvers });
  const failedProbeRow = failedProbe.find(row => row.client_id === 'codex');
  t.assert(failedProbeRow.compatibility === 'known_unsupported' && failedProbeRow.version === null && failedProbeRow.discovery_status === 'VERSION_PROBE_FAILED', 'version-probe failure remains inspect-only discovery evidence instead of false absence');

  const crashedResolvers = { ...missingResolvers };
  crashedResolvers.claude = async () => { throw new Error('unexpected resolver fault'); };
  t.assert(await rejectsCode(() => discoverClients({ env: {}, workspaceRoot: 'C:\\isolated', requestedProfile: null, resolvers: crashedResolvers }), 'CLIENT_DISCOVERY_FAILED'), 'unexpected resolver faults fail aggregate discovery closed');
}

// Expected discovery failures remain visible without invoking an adapter or protocol launch.
{
  const root = makeRoot();
  try {
    const rows = CLIENT_IDS.map(clientId => clientId === 'codex'
      ? Object.freeze({
          client_id: clientId,
          version: null,
          compatibility: 'known_unsupported',
          write_supported: false,
          launch: null,
          discovery_status: 'VERSION_PROBE_FAILED',
        })
      : absentClient(clientId));
    let detectCalls = 0;
    let smokeCalls = 0;
    const adapters = CLIENT_IDS.map(clientId => {
      const adapter = aggregateAdapter(clientId);
      return Object.freeze({
        ...adapter,
        async detect(context) {
          detectCalls += 1;
          return adapter.detect(context);
        },
      });
    });
    const domain = createClientDomain({
      adapters,
      discovery: async () => rows,
      transaction: () => { throw new Error('transaction is not expected'); },
      protocolSmoke: async () => { smokeCalls += 1; return { status: 'HEALTHY' }; },
    });
    const result = await domain.verify(aggregateContext(root, { include: ['codex'] }));
    const client = result.clients.find(row => row.adapter === 'codex');
    const evidence = result.stage.evidence.clients.find(row => row.adapter === 'codex');
    t.assert(client.status === 'UNKNOWN' && client.actions.some(action => action.code === 'UNSUPPORTED_VERSION'), 'version-probe failure reports unknown inspect-only client state with remediation');
    t.assert(evidence.discovery_status === 'VERSION_PROBE_FAILED', 'aggregate evidence retains the stable discovery failure code');
    t.assert(detectCalls === 0 && smokeCalls === 0, 'failed discovery never invokes adapter inspection or protocol launch');

    const failedProbeContext = aggregateContext(root, { operation: 'setup', include: ['codex'], selectedClients: ['codex'] });
    let failedProbePlan = null;
    let failedProbePlanError = null;
    try {
      const planned = await domain.plan(failedProbeContext);
      failedProbePlan = aggregatePlanDocument(failedProbeContext, planned);
    } catch (error) {
      failedProbePlanError = error;
    }
    const failedProbeClient = failedProbePlan?.clients.find(row => row.adapter === 'codex');
    t.assert(failedProbePlanError === null && failedProbeClient?.selected === true
      && failedProbeClient.version === null && failedProbeClient.compatibility === 'known_unsupported', `an explicit failed version probe produces a valid inspect-only remediation plan (${failedProbePlanError?.code ?? 'no error'}: ${failedProbePlanError?.message ?? 'none'})`);
  } finally {
    cleanup(root);
  }
}

// Optional absent providers are informational unless no gated host exists or the user requested one explicitly.
{
  const root = makeRoot();
  try {
    const oneInstalled = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    const domain = createClientDomain({
      adapters: CLIENT_IDS.map(aggregateAdapter),
      discovery: async () => oneInstalled,
      transaction: () => { throw new Error('transaction is not expected'); },
      protocolSmoke: async () => ({ status: 'HEALTHY', instruction_bytes: 0, tool_count: 1, initial_tool_names: ['connection_info'], duration_ms: 1 }),
    });
    const healthy = await domain.verify(aggregateContext(root));
    t.assert(healthy.stage.status === 'HEALTHY' && !healthy.actions.some(action => action.code === 'NOT_INSTALLED'), 'one healthy selected host is not polluted by optional provider install actions');
    t.assert(healthy.clients.filter(client => client.status === 'NOT_INSTALLED').every(client => client.actions.length === 0), 'optional absent client rows remain informational');

    const excluded = await domain.verify(aggregateContext(root, { exclude: ['claude'] }));
    t.assert(excluded.stage.status === 'NOT_SELECTED' && excluded.actions.length === 0, 'explicitly excluding every detected gated host is a clean no-client selection');

    const allAbsent = CLIENT_IDS.map(absentClient);
    const missingDomain = createClientDomain({
      adapters: CLIENT_IDS.map(aggregateAdapter),
      discovery: async () => allAbsent,
      transaction: () => { throw new Error('transaction is not expected'); },
      protocolSmoke: async () => { throw new Error('protocol launch is not expected'); },
    });
    const requestedMissing = await missingDomain.verify(aggregateContext(root, { include: ['codex'] }));
    const missingCodex = requestedMissing.clients.find(client => client.adapter === 'codex');
    t.assert(requestedMissing.stage.status === 'NOT_INSTALLED' && missingCodex.actions.some(action => action.code === 'NOT_INSTALLED'), 'an explicitly requested missing host keeps install remediation');
    t.assert(requestedMissing.clients.filter(client => client.adapter !== 'codex').every(client => client.actions.length === 0), 'unrequested absent hosts do not duplicate missing-client remediation');

    const missingContext = aggregateContext(root, { operation: 'setup', include: ['codex'], selectedClients: ['codex'] });
    let missingPlan = null;
    let missingPlanError = null;
    try {
      const plannedMissing = await missingDomain.plan(missingContext);
      missingPlan = aggregatePlanDocument(missingContext, plannedMissing);
    } catch (error) {
      missingPlanError = error;
    }
    const plannedMissingCodex = missingPlan?.clients.find(client => client.adapter === 'codex');
    t.assert(missingPlanError === null && plannedMissingCodex?.status === 'NOT_INSTALLED'
      && plannedMissingCodex.selected === false, `an explicit missing-client request produces a valid targeted remediation plan (${missingPlanError?.code ?? 'no error'}: ${missingPlanError?.message ?? 'none'})`);
    const forgedMissing = structuredClone(missingPlan);
    forgedMissing.stages.find(stage => stage.name === 'clients').evidence.clients
      .find(client => client.adapter === 'codex').discovery_status = 'DETECTED';
    t.assert(throwsCode(() => createPlanDocument({
      operation: forgedMissing.operation,
      outcome: forgedMissing.outcome,
      source: forgedMissing.source,
      request: forgedMissing.request,
      descriptor: forgedMissing.descriptor,
      stages: forgedMissing.stages,
      clients: forgedMissing.clients,
      operations: forgedMissing.operations,
      preconditions: forgedMissing.preconditions,
      actions: forgedMissing.actions,
      now: new Date(forgedMissing.created_at),
    }), 'INVALID_PLAN'), 'requested missing-client relaxation requires matching discovery evidence');
    const unavailableOperation = {
      ...aggregateClientOperation(root, 'codex'),
      domain: 'clients',
      domain_order: 30,
      kind: 'CLIENT_CONFIG_WRITE',
    };
    t.assert(throwsCode(() => createPlanDocument({
      operation: missingPlan.operation,
      outcome: missingPlan.outcome,
      source: missingPlan.source,
      request: missingPlan.request,
      descriptor: missingPlan.descriptor,
      stages: missingPlan.stages,
      clients: missingPlan.clients,
      operations: [unavailableOperation],
      preconditions: missingPlan.preconditions,
      actions: missingPlan.actions,
      now: new Date(missingPlan.created_at),
    }), 'INVALID_PLAN'), 'a requested unavailable client cannot authorize an injected write operation');
  } finally {
    cleanup(root);
  }
}

// Aggregate action normalization fails closed when an adapter adds an unmapped action.
{
  const root = makeRoot();
  try {
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    const domain = createClientDomain({
      adapters: [aggregateAdapter('claude', { actions: ['FUTURE_UNMAPPED_ACTION'] }), ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
      discovery: async () => rows,
      transaction: () => { throw new Error('transaction is not expected'); },
      protocolSmoke: async () => ({ status: 'HEALTHY' }),
    });
    t.assert(await rejectsCode(() => domain.verify(aggregateContext(root)), 'INVALID_CLIENT_ACTION'), 'unmapped adapter actions cannot disappear from aggregate output');
  } finally {
    cleanup(root);
  }
}

// No-op client plans still bind every inspected path before apply can execute native queries.
{
  const root = makeRoot();
  try {
    const evidencePath = write(join(root, 'client-state.json'), '{"keep":true}\n');
    const evidenceFingerprint = simpleFingerprint(evidencePath);
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    const domain = createClientDomain({
      adapters: [
        aggregateAdapter('claude', {
          files: [{
            path: resolve(evidencePath),
            allowed_root: resolve(root),
            scope: 'user',
            writable: true,
            exists: true,
            fingerprint: evidenceFingerprint,
          }],
        }),
        ...CLIENT_IDS.slice(1).map(aggregateAdapter),
      ],
      discovery: async () => rows,
      transaction: () => { throw new Error('transaction is not expected'); },
      protocolSmoke: async () => ({ status: 'HEALTHY' }),
      captureFingerprint: async () => ({ ...evidenceFingerprint, atime_ms: evidenceFingerprint.atime_ms + 10_000 }),
    });
    const planned = await domain.plan(aggregateContext(root, { operation: 'setup' }));
    t.assert(planned.operations.length === 0 && planned.preconditions.length === 1, 'a configured no-op client still emits its inspected path precondition');
    t.assert(planned.preconditions[0].canonical_path === resolve(evidencePath)
      && planned.preconditions[0].writable === false, 'no-op evidence is digest-bound without granting write authority');
    const observed = await domain.fingerprintPrecondition(planned.preconditions[0], aggregateContext(root));
    t.assert(sha256Canonical(observed) === sha256Canonical(planned.preconditions[0].fingerprint), 'client plan preconditions ignore read-induced atime drift while retaining stable identity evidence');
  } finally {
    cleanup(root);
  }
}

// A selected client whose inspection cannot bind complete evidence cannot emit an applicable plan.
{
  const root = makeRoot();
  try {
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    for (const registration of ['MALFORMED_CONFIG', 'INSPECTION_LIMIT_EXCEEDED', 'UNSAFE_CONFIG_PATH']) {
      const domain = createClientDomain({
        adapters: [aggregateAdapter('claude', { registration, actions: [registration] }), ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
        discovery: async () => rows,
        transaction: () => { throw new Error('transaction is not expected'); },
        protocolSmoke: async () => { throw new Error('blocked inspection must not launch protocol smoke'); },
      });
      t.assert(await rejectsCode(
        () => domain.plan(aggregateContext(root, { operation: 'setup' })),
        'CLIENT_INSPECTION_UNBOUND',
      ), `${registration} fails plan construction instead of emitting unbound client evidence`);
    }
  } finally {
    cleanup(root);
  }
}

// A client that becomes inspection-blocked during apply cannot reach the transaction.
{
  const root = makeRoot();
  try {
    const localState = createLocalState({
      root: join(root, 'local-state'),
      aclRestrictor: async () => {},
      processInspector: async () => 'alive',
    });
    const operation = aggregateClientOperation(root);
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    const base = aggregateAdapter('claude', {
      files: [{
        path: operation.path,
        allowed_root: operation.allowed_root,
        scope: 'user',
        writable: true,
        exists: true,
        fingerprint: operation.fingerprint,
      }],
    });
    let inspections = 0;
    let snapshots = 0;
    const adapter = Object.freeze({
      ...base,
      async inspect(context, detection) {
        inspections += 1;
        const inspected = await base.inspect(context, detection);
        return inspections === 1
          ? inspected
          : Object.freeze({ ...inspected, registration: 'MALFORMED_CONFIG', actions: Object.freeze(['MALFORMED_CONFIG']) });
      },
      async plan() {
        return Object.freeze({ client_id: 'claude', status: 'UPDATE', operations: Object.freeze([operation]), actions: Object.freeze([]) });
      },
    });
    const domain = createClientDomain({
      adapters: [adapter, ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
      discovery: async () => rows,
      transaction: {
        async snapshot() { snapshots += 1; },
        async apply() { throw new Error('blocked apply must not reach transaction apply'); },
      },
      protocolSmoke: async () => ({ status: 'HEALTHY' }),
      captureFingerprint: async path => simpleFingerprint(path),
    });
    const context = aggregateContext(root, { operation: 'setup', localState });
    const planned = await domain.plan(context);
    const plan = aggregatePlanDocument(context, planned);
    t.assert(await rejectsCode(
      () => domain.apply({ ...context, approvedPlan: plan }, plan.operations),
      'CLIENT_INSPECTION_UNBOUND',
    ), 'apply independently rejects a newly blocked selected-client inspection');
    t.assert(snapshots === 0, 'newly blocked apply evidence is rejected before transaction snapshot');
  } finally {
    cleanup(root);
  }
}

// Apply reuses the reviewed launch tuple and rejects discovery-context drift before any new probe.
{
  const root = makeRoot();
  try {
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    let discoveryCalls = 0;
    const domain = createClientDomain({
      adapters: CLIENT_IDS.map(aggregateAdapter),
      discovery: async () => { discoveryCalls += 1; return rows; },
      transaction: () => { throw new Error('transaction is not expected'); },
      protocolSmoke: async () => ({ status: 'HEALTHY', instruction_bytes: 0, tool_count: 1, initial_tool_names: ['connection_info'], duration_ms: 1 }),
    });
    const context = aggregateContext(root, { operation: 'setup' });
    const planned = await domain.plan(context);
    const plan = createPlanDocument({
      operation: 'setup',
      outcome: 'HEALTHY',
      source: context.source,
      request: context.request,
      descriptor: context.descriptor,
      stages: planned.stages,
      clients: planned.clients,
      operations: planned.operations,
      preconditions: planned.preconditions,
      actions: planned.actions,
      now: context.now,
    });
    await domain.apply({ ...context, approvedPlan: plan }, []);
    t.assert(discoveryCalls === 1, 'client apply reuses the saved launch tuple without another executable discovery probe');
    const forged = structuredClone(plan);
    forged.stages.find(stage => stage.name === 'clients').evidence.clients
      .find(client => client.adapter === 'claude').launch_contract.command = 'relative-client.exe';
    t.assert(await rejectsCode(() => domain.apply({ ...context, approvedPlan: forged }, []), 'INVALID_PLAN'), 'saved launch tuples are revalidated before they can become executable authority');
    t.assert(await rejectsCode(() => domain.apply({
      ...context,
      env: { ...context.env, PATH: resolve(join(root, 'changed-path')) },
      approvedPlan: plan,
    }, []), 'PLAN_STALE'), 'client apply rejects changed discovery context before executing a replacement launch candidate');
    t.assert(await rejectsCode(() => domain.apply({
      ...context,
      env: { ...context.env, UEMCP_PROJECT_ROOT: resolve(join(root, 'changed-project')) },
      approvedPlan: plan,
    }, []), 'PLAN_STALE'), 'client apply binds ambient UEMCP and Unreal attachment inputs without serializing them');
    t.assert(discoveryCalls === 1, 'discovery-context drift fails before a child version probe');
  } finally {
    cleanup(root);
  }
}

// Aggregate evidence uses safe fixed keys, preserves key names/hashes, and never serializes raw values.
{
  const root = makeRoot();
  try {
    const rawValue = 'RAW_ENV_CANARY_DO_NOT_SERIALIZE';
    const valueHash = sha256Bytes(Buffer.from(rawValue));
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    const scenario = {
      actions: ['CUSTOM_ENV_REVIEW_REQUIRED'],
      environment: [{ name: 'API_TOKEN', value_sha256: valueHash }],
      privateEnvironment: { API_TOKEN: rawValue },
      activation: 'UNKNOWN',
    };
    let smokeCalls = 0;
    const domain = createClientDomain({
      adapters: [aggregateAdapter('claude', scenario), ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
      discovery: async () => rows,
      transaction: () => { throw new Error('transaction must not run during planning'); },
      protocolSmoke: async () => { smokeCalls += 1; return { status: 'HEALTHY' }; },
    });
    const context = aggregateContext(root, { operation: 'setup' });
    const planned = await domain.plan(context);
    planned.clients.forEach(validateClientContract);
    planned.stages.forEach(validateStageContract);
    const serialized = JSON.stringify(planned);
    t.assert(serialized.includes('"environment":[{"name":"API_TOKEN","value_sha256"'), 'aggregate environment evidence is an array with fixed safe keys');
    t.assert(!serialized.includes(rawValue) && !serialized.includes('"value_hashes"'), 'aggregate output excludes raw values and custom-name object keys');
    t.assert(smokeCalls === 0, 'planning does not launch a descriptor with sensitive environment review pending');
    const plan = createPlanDocument({
      operation: 'setup',
      outcome: 'ACTION_REQUIRED',
      source: context.source,
      request: context.request,
      descriptor: context.descriptor,
      stages: planned.stages,
      clients: planned.clients,
      operations: planned.operations,
      preconditions: planned.preconditions,
      actions: planned.actions,
      now: context.now,
    });
    t.assert(plan.kind === 'uemcp.deployment.plan' && !JSON.stringify(plan).includes(rawValue), 'sensitive-name aggregate evidence passes plan validation without leaking its value');
  } finally {
    cleanup(root);
  }
}

// Apply rechecks reviewed no-op evidence immediately before native and protocol execution.
{
  const root = makeRoot();
  try {
    for (const mode of ['native', 'protocol']) {
      const caseRoot = resolve(join(root, mode));
      mkdirSync(caseRoot, { recursive: true });
      const evidencePath = write(join(caseRoot, 'client-state.json'), '{"reviewed":true}\n');
      const evidence = {
        path: resolve(evidencePath),
        allowed_root: caseRoot,
        scope: 'user',
        writable: false,
        exists: true,
        fingerprint: simpleFingerprint(evidencePath),
      };
      const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
        ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
        : absentClient(clientId));
      const base = aggregateAdapter('claude', { files: [evidence] });
      let mutated = false;
      const adapter = Object.freeze({
        ...base,
        async inspect(context, detection) {
          if (mode === 'native' && context.approvedPlan && !mutated) {
            write(evidencePath, '{"changed-before-native":true}\n');
            mutated = true;
          }
          if (mode === 'native') await context.beforeActiveClientLaunch?.({ client_id: 'claude', kind: 'native' });
          return base.inspect(context, detection);
        },
        protocolLaunch(context, inspection) {
          if (mode === 'protocol' && context.approvedPlan && !mutated) {
            write(evidencePath, '{"changed-before-protocol":true}\n');
            mutated = true;
          }
          return base.protocolLaunch(context, inspection);
        },
      });
      let smokeCalls = 0;
      const domain = createClientDomain({
        adapters: [adapter, ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
        discovery: async () => rows,
        transaction: () => { throw new Error('transaction is not expected'); },
        protocolSmoke: async () => { smokeCalls += 1; return { status: 'HEALTHY' }; },
        captureFingerprint: async path => simpleFingerprint(path),
      });
      const context = aggregateContext(caseRoot, { operation: 'setup' });
      const planned = await domain.plan(context);
      const plan = aggregatePlanDocument(context, planned, 'HEALTHY');
      const smokeCallsBeforeApply = smokeCalls;
      t.assert(await rejectsCode(
        () => domain.apply({ ...context, approvedPlan: plan }, []),
        'PLAN_STALE',
      ), `${mode} launch rejects evidence changed after global plan validation`);
      t.assert(smokeCalls === smokeCallsBeforeApply, `${mode} launch drift is rejected before executing protocol smoke`);
    }
  } finally {
    cleanup(root);
  }
}

// A provider may create one-time state during a read-only native query; inspection must settle and then remain stable.
{
  const root = makeRoot();
  try {
    const evidencePath = resolve(join(root, 'provider-created-state.json'));
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    const base = aggregateAdapter('claude');
    let inspections = 0;
    const adapter = Object.freeze({
      ...base,
      async inspect() {
        inspections += 1;
        const fingerprint = simpleFingerprint(evidencePath);
        if (inspections === 1) write(evidencePath, '{"created_by":"native-query"}\n');
        return Object.freeze({
          client_id: 'claude',
          registration: 'ABSENT',
          enablement: 'UNKNOWN',
          activation: 'UNKNOWN',
          actions: Object.freeze([]),
          occurrences: Object.freeze([]),
          effective: null,
          native: Object.freeze({ status: 'ABSENT' }),
          files: Object.freeze([Object.freeze({
            path: evidencePath,
            allowed_root: root,
            writable: false,
            fingerprint,
          })]),
        });
      },
    });
    let smokeCalls = 0;
    const domain = createClientDomain({
      adapters: [adapter, ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
      discovery: async () => rows,
      transaction: () => { throw new Error('transaction is not expected'); },
      protocolSmoke: async () => { smokeCalls += 1; return { status: 'HEALTHY' }; },
      captureFingerprint: async path => simpleFingerprint(path),
    });
    const context = aggregateContext(root, { operation: 'setup' });
    const planned = await domain.plan(context);
    const plan = aggregatePlanDocument(context, planned);
    t.assert(plan.operations.length === 0 && inspections === 2, 'one-time provider state creation triggers exactly one full inspection retry');
    t.assert(smokeCalls === 1, 'protocol smoke runs only after the retried inspection is stable');
  } finally {
    cleanup(root);
  }
}

// Post-transaction protocol smoke is bound to both committed bytes and the exact inspection that produced its launch.
{
  const root = makeRoot();
  try {
    const localState = createLocalState({
      root: join(root, 'local-state'),
      aclRestrictor: async () => {},
      processInspector: async () => 'alive',
    });
    const operation = aggregateClientOperation(root);
    const approvedBytes = Buffer.from('{"env":{"PATH":"approved"}}\n');
    const hostileBytes = Buffer.from('{"env":{"NODE_OPTIONS":"--require=C:\\\\untrusted\\\\bootstrap.js"}}\n');
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    const privateLaunches = new WeakMap();
    let inspections = 0;
    const base = aggregateAdapter('claude');
    const adapter = Object.freeze({
      ...base,
      async inspect(context, detection) {
        inspections += 1;
        if (inspections === 3) writeFileSync(operation.path, hostileBytes);
        const bytes = readFileSync(operation.path);
        const hostile = bytes.equals(hostileBytes);
        const name = hostile ? 'NODE_OPTIONS' : 'PATH';
        const value = hostile ? '--require=C:\\untrusted\\bootstrap.js' : 'approved';
        const inspected = Object.freeze({
          client_id: 'claude',
          registration: 'CONFIGURED',
          enablement: 'ENABLED',
          activation: 'CONNECTED',
          actions: Object.freeze(['CUSTOM_ENV_REVIEW_REQUIRED']),
          occurrences: Object.freeze([Object.freeze({
            scope: 'user',
            path: operation.path,
            matching: true,
            environment: Object.freeze({
              keys: Object.freeze([name]),
              value_hashes: Object.freeze({ [name]: sha256Bytes(Buffer.from(value)) }),
            }),
            custom_launch: false,
            ownership: null,
          })]),
          effective: Object.freeze({ scope: 'user', path: operation.path, matching: true }),
          native: Object.freeze({ status: 'PRESENT' }),
          files: Object.freeze([Object.freeze({
            path: operation.path,
            allowed_root: operation.allowed_root,
            scope: 'user',
            writable: true,
            exists: true,
            fingerprint: simpleFingerprint(operation.path),
          })]),
        });
        privateLaunches.set(inspected, Object.freeze({ env_overlay: Object.freeze({ [name]: value }), cwd: null }));
        return inspected;
      },
      async plan() {
        return Object.freeze({ client_id: 'claude', status: 'UPDATE', operations: Object.freeze([operation]), actions: Object.freeze(['CUSTOM_ENV_REVIEW_REQUIRED']) });
      },
      protocolLaunch(context, inspection) {
        return privateLaunches.get(inspection);
      },
    });
    let smokeCalls = 0;
    const transaction = {
      async snapshot() {},
      async apply() {
        writeFileSync(operation.path, approvedBytes);
        return Object.freeze({
          status: 'APPLIED',
          clients: Object.freeze([Object.freeze({ client_id: 'claude', status: 'READY' })]),
          touched_files: Object.freeze([Object.freeze({ path: operation.path, applied_sha256: sha256Bytes(approvedBytes) })]),
          rollback: null,
          retained_snapshots: Object.freeze([]),
        });
      },
    };
    const domain = createClientDomain({
      adapters: [adapter, ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
      discovery: async () => rows,
      transaction,
      protocolSmoke: async () => { smokeCalls += 1; return { status: 'HEALTHY' }; },
      captureFingerprint: async path => simpleFingerprint(path),
    });
    const context = aggregateContext(root, { operation: 'setup', localState });
    const planned = await domain.plan(context);
    const plan = aggregatePlanDocument(context, planned);
    const recreatePlan = candidate => createPlanDocument({
      operation: candidate.operation,
      outcome: candidate.outcome,
      source: candidate.source,
      request: candidate.request,
      descriptor: candidate.descriptor,
      stages: candidate.stages,
      clients: candidate.clients,
      operations: candidate.operations,
      preconditions: candidate.preconditions,
      actions: candidate.actions,
      now: new Date(candidate.created_at),
    });
    const unsafePlan = structuredClone(plan);
    unsafePlan.stages.find(stage => stage.name === 'clients').evidence.clients
      .find(client => client.adapter === 'claude').structural_status = 'UNSAFE_CONFIG_PATH';
    t.assert(throwsCode(() => recreatePlan(unsafePlan), 'INVALID_PLAN'), 'unsafe client inspection evidence cannot authorize a write operation');
    const malformedEvidencePlan = structuredClone(plan);
    malformedEvidencePlan.stages.find(stage => stage.name === 'clients').evidence.clients.push(null);
    t.assert(throwsCode(() => recreatePlan(malformedEvidencePlan), 'INVALID_PLAN'), 'malformed extra client evidence cannot be silently discarded');
    const raceResult = await domain.apply({ ...context, approvedPlan: plan }, plan.operations);
    t.assert(raceResult.stage.status === 'SYNC_FAILED'
      && raceResult.stage.evidence.error_code === 'CLIENT_POST_COMMIT_INSPECTION_FAILED'
      && reduceOutcome([raceResult.stage]) === 'PARTIAL', 'post-transaction protocol launch rejects config bytes that differ from the committed transaction result');
    t.assert(smokeCalls === 1, 'post-transaction drift is rejected before a second protocol process launch');
  } finally {
    cleanup(root);
  }
}

// Client transaction terminal states cannot be recomputed into healthy aggregate output.
{
  const root = makeRoot();
  try {
    const localState = createLocalState({
      root: join(root, 'local-state'),
      aclRestrictor: async () => {},
      processInspector: async () => 'alive',
    });
    const operation = aggregateClientOperation(root);
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    const base = aggregateAdapter('claude', {
      files: [{
        path: operation.path,
        allowed_root: operation.allowed_root,
        scope: 'user',
        writable: true,
        exists: true,
        fingerprint: operation.fingerprint,
      }],
    });
    const adapter = Object.freeze({
      ...base,
      async plan() {
        return Object.freeze({ client_id: 'claude', status: 'UPDATE', operations: Object.freeze([operation]), actions: Object.freeze([]) });
      },
    });
    const rollbackPath = operation.path;
    const transaction = {
      async snapshot() {},
      async apply() {
        return Object.freeze({
          status: 'ROLLBACK_FAILED',
          clients: Object.freeze([Object.freeze({ client_id: 'claude', status: 'FAILED', error_code: 'STRUCTURAL_VERIFY_FAILED' })]),
          touched_files: Object.freeze([Object.freeze({ path: rollbackPath, applied_sha256: 'd'.repeat(64) })]),
          rollback: Object.freeze({
            reason_code: 'STRUCTURAL_VERIFY_FAILED',
            paths: Object.freeze([Object.freeze({ status: 'failed', path: rollbackPath, code: 'ROLLBACK_VERIFY_FAILED' })]),
            hook_errors: Object.freeze([]),
          }),
          retained_snapshots: Object.freeze([Object.freeze({ path: rollbackPath, retained_until: '2026-07-23T12:00:00.000Z' })]),
        });
      },
    };
    const domain = createClientDomain({
      adapters: [adapter, ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
      discovery: async () => rows,
      transaction,
      protocolSmoke: async () => ({ status: 'HEALTHY' }),
      captureFingerprint: async path => simpleFingerprint(path),
    });
    const context = aggregateContext(root, { operation: 'setup', localState });
    const planned = await domain.plan(context);
    const plan = aggregatePlanDocument(context, planned);
    const applied = await domain.apply({ ...context, approvedPlan: plan }, plan.operations);
    t.assert(applied.stage.status === 'ROLLBACK_FAILED' && applied.stage.changed === true, 'ROLLBACK_FAILED remains a committed terminal client stage');
    t.assert(applied.actions.some(action => action.code === 'ROLLBACK_FAILED'), 'failed rollback emits explicit remediation instead of healthy output');
    t.assert(applied.clients.find(client => client.adapter === 'claude')?.status === 'ROLLBACK_FAILED', 'affected rollback-failed client cannot retain stale healthy structural state');
    t.assert(applied.stage.evidence.transaction?.rollback?.paths?.[0]?.code === 'ROLLBACK_VERIFY_FAILED'
      && applied.stage.evidence.transaction?.retained_snapshots?.[0]?.path === rollbackPath, 'failed rollback preserves path-only recovery and error evidence');
    t.assert(reduceOutcome([applied.stage]) === 'PARTIAL' && shouldRecordPlanDigest([applied.stage]), 'failed rollback consumes the plan through durable partial-progress semantics');
  } finally {
    cleanup(root);
  }
}

// Committed transaction follow-up cannot collapse into a healthy aggregate.
{
  const root = makeRoot();
  try {
    const localState = createLocalState({
      root: join(root, 'local-state'),
      aclRestrictor: async () => {},
      processInspector: async () => 'alive',
    });
    const operation = aggregateClientOperation(root);
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    const base = aggregateAdapter('claude', {
      files: [{
        path: operation.path,
        allowed_root: operation.allowed_root,
        scope: 'user',
        writable: true,
        exists: true,
        fingerprint: operation.fingerprint,
      }],
    });
    const adapter = Object.freeze({
      ...base,
      async plan() {
        return Object.freeze({ client_id: 'claude', status: 'UPDATE', operations: Object.freeze([operation]), actions: Object.freeze([]) });
      },
    });
    const cleanupPath = operation.path;
    const transaction = {
      async snapshot() {},
      async apply() {
        return Object.freeze({
          status: 'ACTION_REQUIRED',
          clients: Object.freeze([Object.freeze({ client_id: 'claude', status: 'READY' })]),
          touched_files: Object.freeze([Object.freeze({ path: operation.path, applied_sha256: operation.fingerprint.content_sha256 })]),
          rollback: null,
          retained_snapshots: Object.freeze([Object.freeze({ path: operation.path, retained_until: null })]),
          cleanup_actions: Object.freeze([Object.freeze({ path: cleanupPath, code: 'SNAPSHOT_DELETE_FAILED' })]),
        });
      },
    };
    const domain = createClientDomain({
      adapters: [adapter, ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
      discovery: async () => rows,
      transaction,
      protocolSmoke: async () => ({ status: 'HEALTHY' }),
      captureFingerprint: async path => simpleFingerprint(path),
    });
    const context = aggregateContext(root, { operation: 'setup', localState });
    const planned = await domain.plan(context);
    const plan = aggregatePlanDocument(context, planned);
    const applied = await domain.apply({ ...context, approvedPlan: plan }, plan.operations);
    t.assert(applied.stage.status === 'CLIENT_APPLY_ACTION_REQUIRED'
      && reduceOutcome([applied.stage]) === 'ACTION_REQUIRED', 'transaction ACTION_REQUIRED remains an actionable committed stage');
    t.assert(applied.stage.changed === true && shouldRecordPlanDigest([applied.stage]), 'transaction ACTION_REQUIRED consumes the approved plan');
    t.assert(applied.actions.some(action => action.code === 'CLIENT_APPLY_ACTION_REQUIRED'), 'transaction follow-up emits explicit remediation');
    t.assert(applied.stage.evidence.transaction?.cleanup_actions?.[0]?.code === 'SNAPSHOT_DELETE_FAILED', 'transaction follow-up exposes safe cleanup evidence');
  } finally {
    cleanup(root);
  }
}

// Inspection failure after a committed client transaction returns a receiptable terminal stage.
{
  const root = makeRoot();
  try {
    const localState = createLocalState({
      root: join(root, 'local-state'),
      aclRestrictor: async () => {},
      processInspector: async () => 'alive',
    });
    const operation = aggregateClientOperation(root);
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    const base = aggregateAdapter('claude', {
      files: [{
        path: operation.path,
        allowed_root: operation.allowed_root,
        scope: 'user',
        writable: true,
        exists: true,
        fingerprint: operation.fingerprint,
      }],
    });
    let inspections = 0;
    const adapter = Object.freeze({
      ...base,
      async inspect(context, detection) {
        inspections += 1;
        if (inspections === 3) throw Object.assign(new Error('post-commit inspection failed'), { code: 'POST_COMMIT_INSPECTION_FAILED' });
        return base.inspect(context, detection);
      },
      async plan() {
        return Object.freeze({ client_id: 'claude', status: 'UPDATE', operations: Object.freeze([operation]), actions: Object.freeze([]) });
      },
    });
    const transaction = {
      async snapshot() {},
      async apply() {
        return Object.freeze({
          status: 'APPLIED',
          clients: Object.freeze([Object.freeze({ client_id: 'claude', status: 'READY' })]),
          touched_files: Object.freeze([Object.freeze({ path: operation.path, applied_sha256: 'e'.repeat(64) })]),
          rollback: null,
          retained_snapshots: Object.freeze([]),
        });
      },
    };
    const domain = createClientDomain({
      adapters: [adapter, ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
      discovery: async () => rows,
      transaction,
      protocolSmoke: async () => ({ status: 'HEALTHY' }),
      captureFingerprint: async path => simpleFingerprint(path),
    });
    const context = aggregateContext(root, { operation: 'setup', localState });
    const planned = await domain.plan(context);
    const plan = aggregatePlanDocument(context, planned);
    let applied = null;
    let applyError = null;
    try {
      applied = await domain.apply({ ...context, approvedPlan: plan }, plan.operations);
    } catch (error) {
      applyError = error;
    }
    t.assert(applyError === null && applied?.stage.status === 'SYNC_FAILED' && applied.stage.changed === true, 'post-commit inspection failure becomes a committed terminal client stage');
    t.assert(applied?.clients.find(client => client.adapter === 'claude')?.status === 'UNKNOWN'
      && applied?.clients.find(client => client.adapter === 'claude')?.actions.some(action => action.code === 'SYNC_FAILED'), 'post-commit inspection failure invalidates stale affected-client state');
    t.assert(applied?.stage.evidence.error_code === 'CLIENT_POST_COMMIT_INSPECTION_FAILED'
      && applied?.stage.evidence.transaction_status === 'APPLIED', 'post-commit terminal evidence retains stable failure and transaction codes');
    t.assert(applied && reduceOutcome([applied.stage]) === 'PARTIAL' && shouldRecordPlanDigest([applied.stage]), 'post-commit inspection failure remains receiptable and consumes the plan');
  } finally {
    cleanup(root);
  }
}

// Malformed or evidence-free transaction success cannot fall through to a healthy, replayable result.
{
  const root = makeRoot();
  try {
    const cases = [
      {
        label: 'unknown transaction status',
        result: operation => ({
          status: 'FUTURE_SUCCESS',
          clients: [{ client_id: 'claude', status: 'READY' }],
          touched_files: [{ path: operation.path, applied_sha256: 'f'.repeat(64) }],
          rollback: null,
          retained_snapshots: [],
        }),
      },
      {
        label: 'applied result without touched evidence',
        result: () => ({
          status: 'APPLIED',
          clients: [{ client_id: 'claude', status: 'READY' }],
          touched_files: [],
          rollback: null,
          retained_snapshots: [],
        }),
      },
      {
        label: 'rollback result with malformed path evidence',
        result: operation => ({
          status: 'ROLLBACK_FAILED',
          clients: [{ client_id: 'claude', status: 'FAILED', error_code: 'APPLY_FAILED' }],
          touched_files: [{ path: operation.path, applied_sha256: 'f'.repeat(64) }],
          rollback: { reason_code: 'APPLY_FAILED', paths: {}, hook_errors: [] },
          retained_snapshots: [],
        }),
      },
      {
        label: 'applied result with unrelated touched path',
        result: (operation, caseRoot) => ({
          status: 'APPLIED',
          clients: [{ client_id: 'claude', status: 'READY' }],
          touched_files: [{ path: resolve(join(caseRoot, 'unapproved.json')), applied_sha256: 'f'.repeat(64) }],
          rollback: null,
          retained_snapshots: [],
        }),
      },
      {
        label: 'applied result with null write hash',
        result: operation => ({
          status: 'APPLIED',
          clients: [{ client_id: 'claude', status: 'READY' }],
          touched_files: [{ path: operation.path, applied_sha256: null }],
          rollback: null,
          retained_snapshots: [],
        }),
      },
      {
        label: 'applied result with malformed retained snapshot',
        result: operation => ({
          status: 'APPLIED',
          clients: [{ client_id: 'claude', status: 'READY' }],
          touched_files: [{ path: operation.path, applied_sha256: 'f'.repeat(64) }],
          rollback: null,
          retained_snapshots: [42],
        }),
      },
    ];
    for (const testCase of cases) {
      const caseRoot = resolve(join(root, testCase.label.replaceAll(' ', '-')));
      mkdirSync(caseRoot, { recursive: true });
      const localState = createLocalState({
        root: join(caseRoot, 'local-state'),
        aclRestrictor: async () => {},
        processInspector: async () => 'alive',
      });
      const operation = aggregateClientOperation(caseRoot);
      const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
        ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
        : absentClient(clientId));
      const base = aggregateAdapter('claude', {
        files: [{
          path: operation.path,
          allowed_root: operation.allowed_root,
          scope: 'user',
          writable: true,
          exists: true,
          fingerprint: operation.fingerprint,
        }],
      });
      const adapter = Object.freeze({
        ...base,
        async plan() {
          return Object.freeze({ client_id: 'claude', status: 'UPDATE', operations: Object.freeze([operation]), actions: Object.freeze([]) });
        },
      });
      const transaction = {
        async snapshot() {},
        async apply() {
          return structuredClone(testCase.result(operation, caseRoot));
        },
      };
      const domain = createClientDomain({
        adapters: [adapter, ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
        discovery: async () => rows,
        transaction,
        protocolSmoke: async () => ({ status: 'HEALTHY' }),
        captureFingerprint: async path => simpleFingerprint(path),
      });
      const context = aggregateContext(caseRoot, { operation: 'setup', localState });
      const planned = await domain.plan(context);
      const plan = aggregatePlanDocument(context, planned);
      let applied = null;
      let applyError = null;
      try {
        applied = await domain.apply({ ...context, approvedPlan: plan }, plan.operations);
      } catch (error) {
        applyError = error;
      }
      t.assert(applyError === null && applied?.stage.status === 'SYNC_FAILED' && applied.stage.changed === true
        && applied.stage.evidence.error_code === 'INVALID_CLIENT_TRANSACTION_RESULT', `${testCase.label} becomes a committed terminal failure`);
      t.assert(applied && reduceOutcome([applied.stage]) === 'PARTIAL' && shouldRecordPlanDigest([applied.stage]), `${testCase.label} cannot leave the approved plan replayable`);
    }
  } finally {
    cleanup(root);
  }
}

// Private protocol launch data is merged case-insensitively in memory and custom launch controls require approval.
{
  const root = makeRoot();
  try {
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    const smokeOptions = [];
    const harmless = aggregateAdapter('claude', {
      environment: [{ name: 'PATH', value_sha256: 'b'.repeat(64) }],
      privateEnvironment: { PATH: 'overlay-path', HARMLESS: 'overlay-value' },
    });
    const domain = createClientDomain({
      adapters: [harmless, ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
      discovery: async () => rows,
      transaction: () => { throw new Error('transaction is not expected'); },
      protocolSmoke: async (descriptor, options) => {
        smokeOptions.push({ descriptor, options });
        return { status: 'HEALTHY', instruction_bytes: 0, tool_count: 1, initial_tool_names: ['connection_info'], duration_ms: 1 };
      },
    });
    const result = await domain.verify(aggregateContext(root, {
      env: { Path: 'parent-path', harmless: 'parent-value', KEEP: 'parent-keep' },
    }));
    const effective = smokeOptions[0].options.effectiveEnvironment;
    t.assert(smokeOptions.length === 1 && effective.PATH === 'overlay-path' && effective.HARMLESS === 'overlay-value', 'protocol smoke receives exact private environment overlay values in memory');
    t.assert(!Object.hasOwn(effective, 'Path') && !Object.hasOwn(effective, 'harmless') && effective.KEEP === 'parent-keep', 'protocol environment merge removes case-colliding parent aliases');
    t.assert(result.clients[0].status === 'CONFIGURED' && result.clients[0].activation === 'CONNECTED', 'harmless custom environment preserves independent structural and activation facts');

    const hostileValue = '--require=C:\\untrusted\\bootstrap.js';
    const hostileCalls = [];
    const hostileDomain = createClientDomain({
      adapters: [aggregateAdapter('claude', {
        actions: ['CUSTOM_ENV_REVIEW_REQUIRED'],
        environment: [{ name: 'nOdE_oPtIoNs', value_sha256: sha256Bytes(Buffer.from(hostileValue)) }],
        privateEnvironment: { nOdE_oPtIoNs: hostileValue },
        activation: 'UNKNOWN',
      }), ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
      discovery: async () => rows,
      transaction: () => { throw new Error('transaction is not expected'); },
      protocolSmoke: async (descriptor, options) => { hostileCalls.push(options); return { status: 'HEALTHY' }; },
    });
    const standalone = await hostileDomain.verify(aggregateContext(root));
    t.assert(hostileCalls.length === 0, 'standalone inspection never passes hostile NODE_OPTIONS to protocol smoke');
    t.assert(standalone.stage.status !== 'HEALTHY' && standalone.stage.evidence.clients[0].protocol_status === 'UNKNOWN', 'standalone custom launch review leaves protocol health unproven');
  } finally {
    cleanup(root);
  }
}

// Native, protocol, enablement, and activation facts cannot promote one another.
{
  const root = makeRoot();
  try {
    const rows = CLIENT_IDS.map(clientId => clientId === 'claude'
      ? { ...aggregateLaunch(clientId), launch: aggregateLaunch(clientId) }
      : absentClient(clientId));
    const failedProtocol = createClientDomain({
      adapters: [aggregateAdapter('claude', { nativeStatus: 'PRESENT', activation: 'UNKNOWN' }), ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
      discovery: async () => rows,
      transaction: () => { throw new Error('transaction is not expected'); },
      protocolSmoke: async () => ({ status: 'INITIALIZE_FAILED', instruction_bytes: 0, tool_count: 0, initial_tool_names: [], duration_ms: 1 }),
    });
    const nativeOnly = await failedProtocol.verify(aggregateContext(root));
    t.assert(nativeOnly.stage.status === 'INITIALIZE_FAILED' && nativeOnly.clients[0].status === 'CONFIGURED', 'native presence and structural config do not mask protocol initialize failure');

    const pendingActivation = createClientDomain({
      adapters: [aggregateAdapter('claude', { activation: 'PENDING_TRUST' }), ...CLIENT_IDS.slice(1).map(aggregateAdapter)],
      discovery: async () => rows,
      transaction: () => { throw new Error('transaction is not expected'); },
      protocolSmoke: async () => ({ status: 'HEALTHY', instruction_bytes: 0, tool_count: 1, initial_tool_names: ['connection_info'], duration_ms: 1 }),
    });
    const protocolOnly = await pendingActivation.verify(aggregateContext(root));
    t.assert(protocolOnly.stage.status === 'PENDING_TRUST' && protocolOnly.clients[0].activation === 'PENDING_TRUST', 'healthy protocol smoke does not promote pending host trust to healthy');
  } finally {
    cleanup(root);
  }
}

process.exitCode = t.summary();
