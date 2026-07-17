// Opt-in contracts against locally installed client releases.
//
// Run: cd server && $env:UEMCP_INSTALLED_CLIENT_CONTRACT='1'; node test-installed-client-contracts.mjs

import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createClaudeAdapter,
  physicalClaudeEntry,
  resolveClaudeLocations,
} from './deployment/adapters/claude.mjs';
import {
  createCodexAdapter,
  physicalCodexEntry,
  resolveCodexLocations,
} from './deployment/adapters/codex.mjs';
import {
  createGeminiAdapter,
  physicalGeminiEntry,
  resolveGeminiLocations,
} from './deployment/adapters/gemini.mjs';
import {
  createVsCodeAdapter,
  physicalVsCodeEntry,
  resolveVsCodeLocations,
  VSCODE_NATIVE_MUTATION_CHARACTERIZATION,
} from './deployment/adapters/vscode.mjs';
import { createClientDomain } from './deployment/client-domain.mjs';
import { discoverClients } from './deployment/client-discovery.mjs';
import {
  CLIENT_IDS,
  clientProcessEnvironment,
  RELEASE_GATES,
} from './deployment/client-contract.mjs';
import { resolveClientLaunch } from './deployment/client-process.mjs';
import { captureClientPathFingerprint, createClientTransaction } from './deployment/client-transaction.mjs';
import { getJsoncValue, parseJsoncDocument } from './deployment/jsonc-config.mjs';
import { createLocalState } from './deployment/local-state.mjs';
import { createPlanDocument } from './deployment/plan-document.mjs';
import { createProcessRunner } from './deployment/process-runner.mjs';
import { parseTomlDocument, patchTomlTable } from './deployment/toml-config.mjs';
import { TestRunner } from './test-helpers.mjs';

const enabled = process.env.UEMCP_INSTALLED_CLIENT_CONTRACT === '1';
const worker = process.env.UEMCP_INSTALLED_CLIENT_CONTRACT_WORKER === '1';
// Four provider contracts run sequentially; each nested process keeps its narrower deadline.
const WORKER_TIMEOUT_MS = 900_000;

if (!enabled) {
  console.log('  ⊘ skipped: UEMCP_INSTALLED_CLIENT_CONTRACT=1 is required for installed client contracts');
  process.exit(0);
}

const t = new TestRunner('Installed Client Contract Tests');

function write(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
  return path;
}

function writeJson(path, value) {
  return write(path, `${JSON.stringify(value, null, 2)}\n`);
}

function safeCleanup(root) {
  const normalized = resolve(root).replaceAll('\\', '/').toLowerCase();
  const expected = resolve(tmpdir()).replaceAll('\\', '/').toLowerCase();
  if (!normalized.startsWith(`${expected}/uemcp-installed-contract-`)) throw new Error('refusing to remove an unexpected path');
  rmSync(root, { recursive: true, force: true });
}

async function pathDigest(path) {
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink()) return `link:${await fs.readlink(path)}`;
    if (stat.isFile()) {
      const bytes = await fs.readFile(path);
      return `file:${createHash('sha256').update(bytes).digest('hex')}`;
    }
    if (!stat.isDirectory()) return `other:${stat.mode}`;
    const rows = [];
    for (const entry of (await fs.readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      rows.push([entry.name, await pathDigest(join(path, entry.name))]);
    }
    return `directory:${createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'absent';
    throw error;
  }
}

async function geminiExtensionStateDigest(path) {
  try {
    const root = await fs.lstat(path);
    if (root.isSymbolicLink()) return `link:${await fs.readlink(path)}`;
    if (!root.isDirectory()) return pathDigest(path);
    const rows = [];
    for (const entry of (await fs.readdir(path, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      const kind = entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other';
      const entryPath = join(path, entry.name);
      rows.push([entry.name, kind]);
      if (entry.isDirectory()) rows.push([`${entry.name}/gemini-extension.json`, await pathDigest(join(entryPath, 'gemini-extension.json'))]);
      if (entry.isFile() && entry.name === 'extension-enablement.json') rows.push([entry.name, await pathDigest(entryPath)]);
    }
    return `extension-state:${createHash('sha256').update(JSON.stringify(rows)).digest('hex')}`;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return 'absent';
    throw error;
  }
}

function realGuardPaths() {
  const home = process.env.USERPROFILE;
  const appData = process.env.APPDATA;
  const trustedFolders = process.env.GEMINI_CLI_TRUSTED_FOLDERS_PATH || join(home, '.gemini', 'trustedFolders.json');
  return [
    join(home, '.claude.json'),
    join(home, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.local.json'),
    join(home, '.claude', 'plugins', 'installed_plugins.json'),
    join(home, '.codex', 'config.toml'),
    join(home, '.gemini', 'settings.json'),
    join(home, '.gemini', 'mcp-server-enablement.json'),
    trustedFolders,
    { path: join(home, '.gemini', 'extensions'), kind: 'gemini_extension_state' },
    join(home, '.gemini', 'extension-enablement.json'),
    join(appData, 'Code', 'User', 'mcp.json'),
    join(appData, 'Code', 'User', 'globalStorage', 'storage.json'),
    join(appData, 'Code', 'User', 'profiles'),
    join(home, '.vscode', 'extensions', 'extensions.json'),
  ].map(row => typeof row === 'string'
    ? Object.freeze({ path: resolve(row), kind: 'path' })
    : Object.freeze({ ...row, path: resolve(row.path) }));
}

async function guardSnapshot(paths) {
  const started = Date.now();
  let timeoutTimer;
  let rows;
  try {
    rows = await Promise.race([
      Promise.all(paths.map(async row => [
        row.path,
        row.kind === 'gemini_extension_state' ? await geminiExtensionStateDigest(row.path) : await pathDigest(row.path),
      ])),
      new Promise((resolvePromise, rejectPromise) => {
        timeoutTimer = setTimeout(() => rejectPromise(new Error('real config hash guard exceeded 20 seconds')), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timeoutTimer);
  }
  if (Date.now() - started > 20_000) throw new Error('real config hash guard exceeded 20 seconds');
  return Object.fromEntries(rows);
}

function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function guardPathLabel(path) {
  for (const [label, root] of [['<home>', process.env.USERPROFILE], ['<appdata>', process.env.APPDATA]]) {
    const remainder = relative(resolve(root), path);
    if (remainder !== '' && !remainder.startsWith('..') && !resolve(remainder).startsWith('\\')) {
      return `${label}/${remainder.replaceAll('\\', '/')}`;
    }
  }
  return '<outside-known-roots>';
}

function changedSnapshotLabels(left, right) {
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter(path => left[path] !== right[path])
    .map(guardPathLabel)
    .sort();
}

function sourceContract(root) {
  return {
    kind: 'git_checkout',
    repository: 'https://example.invalid/uemcp.git',
    repo_root: resolve(root),
    git_commit: 'a'.repeat(40),
    dirty: false,
    archive: null,
    orchestrator_version: '1.0.0',
  };
}

function descriptorContract() {
  return {
    name: 'uemcp',
    transport: 'stdio',
    command: resolve(process.execPath),
    args: [resolve(join(import.meta.dirname, 'server.mjs'))],
    env: {},
    cwd: null,
  };
}

function contextFor(root, isolated, clientId, approvedPlan = null, applyLease = null) {
  const workspaceRoot = resolve(join(root, 'workspace'));
  mkdirSync(workspaceRoot, { recursive: true });
  return {
    repoRoot: resolve(dirname(import.meta.dirname)),
    stateRoot: isolated.localState.paths().state,
    fsImpl: fs,
    processRunner: isolated.runner,
    localState: isolated.localState,
    source: sourceContract(root),
    descriptor: descriptorContract(),
    operation: approvedPlan ? 'apply' : 'setup',
    request: {
      requested_project: null,
      requested_profile: null,
      selected_clients: [clientId],
      client_decisions: {
        replace_owned_fields: false,
        shadow_gemini_extension: false,
        migrate_legacy_claude_project: false,
      },
    },
    clientSelection: { include: [clientId], exclude: [], vscodeProfile: 'Contract Profile' },
    env: isolated.env,
    workspaceRoot,
    projectRoot: workspaceRoot,
    activeDirectory: workspaceRoot,
    workspaceTrusted: true,
    invocationPolicyKnown: true,
    knownFolders: {
      programData: resolve(join(root, 'program-data')),
      programFiles: resolve(join(root, 'program-files')),
    },
    vscodeUserDataRoot: isolated.vscodeData,
    vscodeProfile: 'Contract Profile',
    approvedPlan,
    applyLease,
    now: new Date(),
  };
}

async function createApprovedPlan(domain, context) {
  const planned = await domain.plan(context);
  return createPlanDocument({
    operation: 'setup',
    outcome: planned.stages[0].status === 'HEALTHY' ? 'HEALTHY' : 'ACTION_REQUIRED',
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

async function runIsolatedApply(domain, context, plan) {
  const lease = await context.localState.acquireApplyLease({ waitMs: 0, expiresAt: plan.expires_at });
  try {
    return await domain.apply({ ...contextFor(context.source.repo_root, {
      env: context.env,
      localState: context.localState,
      runner: context.processRunner,
      vscodeData: context.vscodeUserDataRoot,
    }, context.request.selected_clients[0], plan, lease), source: context.source }, plan.operations.filter(operation => operation.domain === 'clients'));
  } finally {
    await lease.release();
  }
}

async function characterizeVsCodeProfileMutation({ root, row, runner, descriptor }) {
  const userDataRoot = resolve(join(root, 'vscode-characterization'));
  const profileName = 'Mutation Characterization';
  const profileLocation = 'mutation-characterization';
  const defaultPath = join(userDataRoot, 'User', 'mcp.json');
  const profilePath = join(userDataRoot, 'User', 'profiles', profileLocation, 'mcp.json');
  writeJson(join(userDataRoot, 'User', 'globalStorage', 'storage.json'), {
    userDataProfiles: [{ name: profileName, location: profileLocation }],
  });
  writeJson(profilePath, { servers: { unrelated: { type: 'http', url: 'https://example.invalid/profile' } } });
  const profileBefore = await pathDigest(profilePath);
  const name = 'uemcp-characterization';
  const definition = JSON.stringify({ name, command: descriptor.command, args: descriptor.args });
  const result = await runner.run(row.launch.command, [
    ...row.launch.args_prefix,
    '--user-data-dir', userDataRoot,
    '--profile', profileName,
    '--add-mcp', definition,
  ], {
    cwd: root,
    env: clientProcessEnvironment(process.env, row.launch.env_overlay),
    shell: false,
    timeoutMs: 20_000,
    outputLimitBytes: 64 * 1024,
  });
  t.assert(result.status === 'exited' && result.exitCode === 0, 'VS Code exact release bounds add-mcp characterization to an isolated user-data root');
  const defaultDocument = parseJsoncDocument(await fs.readFile(defaultPath), { pathLabel: 'isolated VS Code default MCP resource' });
  t.assert(getJsoncValue(defaultDocument, ['servers', name])?.command === descriptor.command, 'VS Code exact release confirms --add-mcp --profile targets the default resource');
  t.assert(await pathDigest(profilePath) === profileBefore, 'VS Code exact release characterization leaves the named profile resource unchanged');
}

if (!worker) {
  const root = join(tmpdir(), `uemcp-installed-contract-${randomUUID()}`);
  mkdirSync(root);
  let result;
  try {
    result = await createProcessRunner().run(process.execPath, [fileURLToPath(import.meta.url)], {
      cwd: import.meta.dirname,
      env: clientProcessEnvironment(process.env, {
        UEMCP_INSTALLED_CLIENT_CONTRACT_WORKER: '1',
        UEMCP_INSTALLED_CLIENT_ROOT: root,
      }),
      timeoutMs: WORKER_TIMEOUT_MS,
      outputLimitBytes: 2 * 1024 * 1024,
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    t.assert(result.status === 'exited' && result.exitCode === 0,
      'installed contract worker exits within its bounded process-tree deadline',
      `status=${result.status} exit=${result.exitCode ?? 'null'} duration_ms=${result.durationMs}`);
  } finally {
    safeCleanup(root);
  }
  t.assert(!existsSync(root), 'installed contract parent removes the isolated root after every worker outcome');
} else {
  const root = resolve(process.env.UEMCP_INSTALLED_CLIENT_ROOT ?? '');
  const expectedRoot = resolve(tmpdir()).replaceAll('\\', '/').toLowerCase();
  if (!root.replaceAll('\\', '/').toLowerCase().startsWith(`${expectedRoot}/uemcp-installed-contract-`)) {
    throw new Error('installed contract worker root is invalid');
  }
  mkdirSync(root, { recursive: true });
  const baseRunner = createProcessRunner();
  const runnerCalls = [];
  const runner = Object.freeze({
    async run(command, args, options) {
      runnerCalls.push(Object.freeze({
        command,
        args: Object.freeze([...(args ?? [])]),
        cwd: options?.cwd ?? null,
        codex_home: options?.env?.CODEX_HOME ?? null,
      }));
      return await baseRunner.run(command, args, options);
    },
  });
  const vscodeData = resolve(join(root, 'vscode-data'));
  const isolated = {
    runner,
    vscodeData,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: resolve(join(root, 'claude')),
      CODEX_HOME: resolve(join(root, 'codex')),
      GEMINI_CLI_HOME: resolve(join(root, 'gemini-home')),
      GEMINI_CLI_TRUSTED_FOLDERS_PATH: resolve(join(root, 'gemini-trusted-folders.json')),
    },
    localState: createLocalState({
      root: resolve(join(root, 'state')),
      aclRestrictor: async () => {},
      processInspector: async () => 'alive',
    }),
  };
  writeJson(join(vscodeData, 'User', 'globalStorage', 'storage.json'), {
    userDataProfiles: [{ name: 'Contract Profile', location: 'contract-profile' }],
    unrelated: { keep: true },
  });
  writeJson(join(vscodeData, 'User', 'profiles', 'contract-profile', 'mcp.json'), {
    servers: { unrelated: { type: 'http', url: 'https://example.invalid/mcp' } },
    unrelated: { keep: true },
  });

  const guards = realGuardPaths();
  const suiteBefore = await guardSnapshot(guards);
  try {
    const discovered = await discoverClients({
      env: isolated.env,
      workspaceRoot: resolve(join(root, 'workspace')),
      requestedProfile: 'Contract Profile',
      resolvers: Object.fromEntries(CLIENT_IDS.map(clientId => [clientId, () => resolveClientLaunch(clientId, {
        env: isolated.env,
        fsImpl: fs,
        runner,
      })])),
    });
    const adapters = [
      createClaudeAdapter({ fsImpl: fs, runner }),
      createCodexAdapter({ fsImpl: fs, runner, captureFingerprint: captureClientPathFingerprint }),
      createGeminiAdapter({ fsImpl: fs, runner }),
      createVsCodeAdapter({ fsImpl: fs, runner }),
    ];
    const domain = createClientDomain({
      adapters,
      discovery: async () => discovered,
      transaction: ({ externalLease }) => createClientTransaction({
        localState: isolated.localState,
        fsImpl: fs,
        externalLease,
      }),
    });

    for (const clientId of CLIENT_IDS) {
      const before = await guardSnapshot(guards);
      const row = discovered.find(candidate => candidate.client_id === clientId);
      console.log(`  installed-contract ${clientId}: version=${row.version ?? 'not-installed'} compatibility=${row.compatibility}`);
      const context = contextFor(root, isolated, clientId);
      if (row.compatibility !== 'release_gated') {
        const plan = await createApprovedPlan(domain, context);
        const selected = plan.clients.find(client => client.adapter === clientId);
        t.assert(plan.operations.every(operation => operation.client_id !== clientId), `${clientId} mismatched release is inspect-only`);
        t.assert(selected.write_supported === false, `${clientId} mismatched release cannot write`);
        console.log(`  installed-contract ${clientId}: skip=exact gate requires ${RELEASE_GATES[clientId].versions.join(',')}`);
      } else if (clientId === 'claude') {
        const locations = resolveClaudeLocations(context);
        const desired = physicalClaudeEntry(context.descriptor);
        writeJson(locations.state.path, {
          mcpServers: {
            unrelated: { type: 'stdio', command: process.execPath, args: ['--version'] },
            uemcp: {
              ...desired,
              env: { UEMCP_INSTALLED_CONTRACT: 'isolated-value' },
              cwd: context.workspaceRoot,
              startup_timeout_sec: 45,
            },
          },
          unrelated: { keep: true },
        });
        const configBefore = await pathDigest(locations.state.path);
        const plan = await createApprovedPlan(domain, context);
        t.assert(plan.operations.some(operation => operation.client_id === 'claude' && operation.type === 'ADOPT_EXACT_ENTRY'), 'Claude exact release plans isolated ownership adoption');
        const applied = await runIsolatedApply(domain, context, plan);
        const appliedClient = applied.clients.find(client => client.adapter === 'claude');
        const appliedEvidence = applied.stage.evidence.clients.find(client => client.adapter === 'claude');
        t.assert(appliedClient.status === 'CONFIGURED', 'Claude isolated apply verifies the user registration structurally');
        t.assert(appliedClient.activation === 'CONNECTED' && appliedEvidence.native_status === 'CONNECTED', 'Claude exact release reaches native connected status in the isolated user home');
        t.assert(await pathDigest(locations.state.path) === configBefore, 'Claude adoption preserves unrelated and client-owned state bytes');
        const noOp = await createApprovedPlan(domain, context);
        t.assert(noOp.operations.every(operation => operation.client_id !== 'claude'), 'Claude second plan is a no-op');

        writeJson(locations.state.path, {
          mcpServers: { unrelated: { type: 'stdio', command: process.execPath, args: ['--version'] } },
          unrelated: { keep: true },
        });
        writeJson(locations.project_config.path, {
          mcpServers: { uemcp: desired },
          unrelated: { keep: true },
        });
        const adapter = adapters.find(candidate => candidate.id === 'claude');
        const projectContext = {
          ...context,
          launch: row.launch,
          ownershipLedger: { async read() { return null; }, now: () => context.now.toISOString() },
        };
        const projectInspection = await adapter.inspect(projectContext, await adapter.detect(projectContext));
        t.assert(projectInspection.effective?.scope === 'project' && projectInspection.activation === 'PENDING_APPROVAL', 'Claude isolated project registration remains pending approval');
      } else if (clientId === 'codex') {
        const locations = resolveCodexLocations(context);
        const desired = physicalCodexEntry(context.descriptor);
        const seed = parseTomlDocument(Buffer.from('[mcp_servers.unrelated]\ncommand = "keep"\n\n', 'utf8'), { pathLabel: 'isolated Codex config' });
        const edit = patchTomlTable(seed, ['mcp_servers', 'uemcp'], {
          ...desired,
          enabled: true,
          startup_timeout_sec: 17,
        });
        write(locations.user.path, edit.after_bytes);
        const configBefore = await pathDigest(locations.user.path);
        const plan = await createApprovedPlan(domain, context);
        t.assert(plan.operations.some(operation => operation.client_id === 'codex'), 'Codex exact release plans isolated ownership adoption');
        const applied = await runIsolatedApply(domain, context, plan);
        t.assert(applied.clients.find(client => client.adapter === 'codex').status !== 'CONFLICT', 'Codex isolated apply verifies native status');
        t.assert(applied.stage.evidence.clients.find(client => client.adapter === 'codex').native_status === 'PRESENT', 'Codex exact release reports the isolated registration through native read commands');
        t.assert(await pathDigest(locations.user.path) === configBefore, 'Codex adoption preserves unrelated and same-table policy bytes');
        const noOp = await createApprovedPlan(domain, context);
        t.assert(noOp.operations.every(operation => operation.client_id !== 'codex'), 'Codex second plan is a no-op');

        const nativeRoot = resolve(join(root, 'codex-native-create'));
        const nativeIsolated = {
          ...isolated,
          env: { ...isolated.env, CODEX_HOME: resolve(join(nativeRoot, 'codex')) },
          localState: createLocalState({
            root: resolve(join(nativeRoot, 'state')),
            aclRestrictor: async () => {},
            processInspector: async () => 'alive',
          }),
        };
        const nativeDomain = createClientDomain({
          adapters,
          discovery: async () => discovered,
          transaction: ({ externalLease }) => createClientTransaction({
            localState: nativeIsolated.localState,
            fsImpl: fs,
            externalLease,
          }),
        });
        const nativeContext = contextFor(nativeRoot, nativeIsolated, 'codex');
        const nativeLocations = resolveCodexLocations(nativeContext);
        mkdirSync(nativeIsolated.env.CODEX_HOME, { recursive: true });
        t.assert(!existsSync(nativeLocations.user.path), 'Codex native-create scenario starts with an absent isolated user config');
        const nativePlan = await createApprovedPlan(nativeDomain, nativeContext);
        const nativeOperation = nativePlan.operations.find(operation => operation.client_id === 'codex');
        const nativeClient = nativePlan.clients.find(client => client.adapter === 'codex');
        t.assert(nativeOperation?.type === 'CREATE_ENTRY' && nativeOperation.external_write === true, `Codex exact release plans its native create capability only for the absent isolated file (status=${nativeClient?.status ?? 'missing'})`);
        const callsBeforeNativeApply = runnerCalls.length;
        const nativeApplied = nativeOperation
          ? await runIsolatedApply(nativeDomain, nativeContext, nativePlan)
          : null;
        const nativeCalls = runnerCalls.slice(callsBeforeNativeApply);
        const addCalls = nativeCalls.filter(call => call.args.includes('mcp') && call.args.includes('add') && call.args.includes('uemcp'));
        t.assert(addCalls.length === 1, 'Codex exact release executes one real native mcp add for isolated creation');
        t.assert(addCalls.length === 1
          && resolve(addCalls[0].cwd) === resolve(addCalls[0].codex_home)
          && resolve(addCalls[0].cwd) !== resolve(nativeOperation.allowed_root), 'Codex native add receives only the transaction-owned staging home');
        const nativeDocument = existsSync(nativeLocations.user.path)
          ? parseTomlDocument(await fs.readFile(nativeLocations.user.path), { pathLabel: 'installed Codex native-created config' })
          : null;
        const nativeEntry = nativeDocument?.parsed_value?.mcp_servers?.uemcp;
        t.assert(nativeEntry?.command === nativeContext.descriptor.command
          && JSON.stringify(nativeEntry?.args) === JSON.stringify(nativeContext.descriptor.args), 'Codex native-created final config contains the canonical owned launch identity');
        t.assert(nativeApplied?.stage.evidence.transaction.touched_files.some(file => resolve(file.path) === resolve(nativeLocations.user.path)), 'Codex native create reports the final provider config as transaction-touched');
        const nativeNoOp = nativeApplied ? await createApprovedPlan(nativeDomain, nativeContext) : null;
        t.assert(nativeNoOp?.operations.every(operation => operation.client_id !== 'codex'), 'Codex native-created registration is idempotent on the second plan');
      } else if (clientId === 'gemini') {
        const locations = resolveGeminiLocations(context);
        const desired = physicalGeminiEntry(context.descriptor);
        const extensionPath = join(locations.extensions_root.path, 'isolated-extension', 'gemini-extension.json');
        writeJson(extensionPath, { name: 'isolated-extension', version: '1.0.0', mcpServers: { uemcp: desired } });
        const adapter = adapters.find(candidate => candidate.id === 'gemini');
        let inspection = await adapter.inspect({ ...context, launch: row.launch, ownershipLedger: { async read() { return null; }, now: () => context.now.toISOString() } }, await adapter.detect({ ...context, launch: row.launch }));
        t.assert(inspection.effective.scope === 'extension', 'Gemini exact release proves extension-only precedence in the isolated home');
        writeJson(locations.user.path, {
          mcpServers: {
            unrelated: { command: 'keep', args: [] },
            uemcp: { ...desired, trust: true, timeout: 6200 },
          },
          unrelated: { keep: true },
        });
        const configBefore = await pathDigest(locations.user.path);
        inspection = await adapter.inspect({ ...context, launch: row.launch, ownershipLedger: { async read() { return null; }, now: () => context.now.toISOString() } }, await adapter.detect({ ...context, launch: row.launch }));
        t.assert(inspection.effective.scope === 'user' && inspection.occurrences.some(occurrence => occurrence.scope === 'extension'), 'Gemini user same-name entry wins while extension evidence remains visible');
        writeJson(locations.enablement.path, { uemcp: { enabled: false }, unrelated: { enabled: false } });
        const disabled = await adapter.inspect({ ...context, launch: row.launch, ownershipLedger: { async read() { return null; }, now: () => context.now.toISOString() } }, await adapter.detect({ ...context, launch: row.launch }));
        t.assert(disabled.enablement === 'DISABLED' && disabled.enablement_evidence.enabled === false, 'Gemini persistent disable remains explicit config evidence');
        t.assert(disabled.native.status === 'DISABLED' && disabled.activation !== 'PENDING_TRUST', 'Gemini native session disable remains separate from pending trust');
        rmSync(locations.enablement.path, { force: true });
        const plan = await createApprovedPlan(domain, context);
        t.assert(plan.operations.some(operation => operation.client_id === 'gemini'), 'Gemini exact release plans isolated ownership adoption');
        const applied = await runIsolatedApply(domain, context, plan);
        t.assert(applied.clients.find(client => client.adapter === 'gemini').status !== 'CONFLICT', 'Gemini isolated apply verifies native status');
        t.assert(['CONNECTED', 'DISCONNECTED'].includes(applied.stage.evidence.clients.find(client => client.adapter === 'gemini').native_status), 'Gemini exact release reports isolated native session state');
        t.assert(await pathDigest(locations.user.path) === configBefore, 'Gemini adoption preserves unrelated and client-owned settings bytes');
        const noOp = await createApprovedPlan(domain, context);
        t.assert(noOp.operations.every(operation => operation.client_id !== 'gemini'), 'Gemini second plan is a no-op');

        const disconnectedServer = write(join(root, 'disconnected-gemini-server.mjs'), 'process.exit(1);\n');
        const pendingDescriptor = { ...context.descriptor, args: [disconnectedServer] };
        writeJson(locations.user.path, { mcpServers: { uemcp: physicalGeminiEntry(pendingDescriptor) } });
        const pendingContext = {
          ...context,
          descriptor: pendingDescriptor,
          launch: row.launch,
          workspaceTrusted: false,
          ownershipLedger: { async read() { return null; }, now: () => context.now.toISOString() },
        };
        const pending = await adapter.inspect(pendingContext, await adapter.detect(pendingContext));
        t.assert(pending.native.status === 'DISCONNECTED' && pending.activation === 'PENDING_TRUST', 'Gemini disconnected untrusted session remains pending trust rather than persistently disabled');
      } else if (clientId === 'vscode') {
        const locations = resolveVsCodeLocations(context);
        const profilePath = join(locations.profiles_root, 'contract-profile', 'mcp.json');
        const desired = physicalVsCodeEntry(context.descriptor);
        writeJson(profilePath, {
          servers: {
            unrelated: { type: 'http', url: 'https://example.invalid/mcp' },
            uemcp: {
              ...desired,
              env: { UEMCP_INSTALLED_CONTRACT: 'isolated-value' },
              cwd: context.workspaceRoot,
              sandbox: { network: 'host' },
            },
          },
          inputs: [{ id: 'preserve-input', type: 'promptString' }],
          unrelated: { keep: true },
        });
        const profileBefore = await pathDigest(profilePath);
        const metadataBefore = await pathDigest(locations.profile_metadata.path);
        t.assert(row.launch.args_prefix.length === 1
          && row.launch.args_prefix[0].toLowerCase().endsWith('cli.js')
          && row.launch.command.toLowerCase().endsWith('code.exe')
          && JSON.stringify(row.launch.env_overlay) === JSON.stringify({ ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' }), 'VS Code exact release uses only the validated Code.exe plus cli.js launch tuple');
        const plan = await createApprovedPlan(domain, context);
        t.assert(plan.operations.some(operation => operation.client_id === 'vscode' && operation.type === 'ADOPT_EXACT_ENTRY'), 'VS Code exact release plans isolated profile ownership adoption');
        const applied = await runIsolatedApply(domain, context, plan);
        const appliedClient = applied.clients.find(client => client.adapter === 'vscode');
        t.assert(appliedClient.status === 'CONFIGURED' && appliedClient.enablement === 'UNKNOWN' && appliedClient.activation === 'UNKNOWN', 'VS Code isolated apply proves structure without inventing enablement or activation');
        t.assert(appliedClient.actions.some(action => action.code === 'RESTART_REQUIRED')
          && appliedClient.actions.some(action => action.code === 'CLIENT_ENABLEMENT_REVIEW_REQUIRED'), 'VS Code isolated apply retains restart and enablement review actions');
        t.assert(await pathDigest(profilePath) === profileBefore, 'VS Code adoption preserves the targeted profile resource byte-for-byte');
        t.assert(await pathDigest(locations.profile_metadata.path) === metadataBefore, 'VS Code adoption preserves profile metadata byte-for-byte');
        const noOp = await createApprovedPlan(domain, context);
        t.assert(noOp.operations.every(operation => operation.client_id !== 'vscode'), 'VS Code second plan is a no-op');
        t.assert(VSCODE_NATIVE_MUTATION_CHARACTERIZATION.version === row.version
          && VSCODE_NATIVE_MUTATION_CHARACTERIZATION.mutating_cli_allowed === false, 'VS Code mutation characterization remains exact-release-bound and production-disabled');
        await characterizeVsCodeProfileMutation({ root, row, runner, descriptor: context.descriptor });
      } else {
        const plan = await createApprovedPlan(domain, context);
        t.assert(plan.clients.find(client => client.adapter === clientId).write_supported, `${clientId} exact release remains writable inside its isolated root`);
      }
      const after = await guardSnapshot(guards);
      const changed = changedSnapshotLabels(before, after);
      t.assert(sameSnapshot(before, after), `${clientId} leaves every real default config hash unchanged${changed.length > 0 ? `: ${changed.join(', ')}` : ''}`);
    }
    const suiteAfter = await guardSnapshot(guards);
    const changed = changedSnapshotLabels(suiteBefore, suiteAfter);
    t.assert(sameSnapshot(suiteBefore, suiteAfter), `installed suite leaves all real config/profile/extension hashes unchanged${changed.length > 0 ? `: ${changed.join(', ')}` : ''}`);
  } finally {
    safeCleanup(root);
  }
}

process.exitCode = t.summary();
