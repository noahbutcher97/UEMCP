// Current-config-bound ownership, adoption, and physical-location tests.
//
// Run: cd server && node test-client-transaction.mjs

import { randomUUID } from 'node:crypto';
import * as asyncFs from 'node:fs/promises';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { TestRunner } from './test-helpers.mjs';
import { canonicalJson, sha256Bytes, sha256Canonical } from './deployment/canonical-json.mjs';
import {
  captureClientPathFingerprint,
  createClientTransaction,
} from './deployment/client-transaction.mjs';
import { createLocalState } from './deployment/local-state.mjs';
import { createProcessRunner } from './deployment/process-runner.mjs';
import {
  adoptExactEntry,
  deduplicateOwnershipLocations,
  inspectOwnership,
  ownedPathsForClient,
  ownershipKey,
  recordOwnedWrite,
} from './deployment/ownership-ledger.mjs';

const t = new TestRunner('Client Transaction Tests');
const PLAN_DIGEST = 'a'.repeat(64);
const CONFIG_HASH = 'b'.repeat(64);
const WRITTEN_AT = '2026-07-16T12:00:00.000Z';

function location(clientId = 'claude', {
  configPath = `C:\\Users\\Example\\.${clientId}\\config.json`,
  scope = 'user:default',
  entryName = 'uemcp',
  requestedContexts = [],
} = {}) {
  return { clientId, configPath, scope, entryName, requestedContexts };
}

function physicalEntry(clientId = 'claude', overrides = {}) {
  const base = {
    command: 'C:\\Program Files\\nodejs\\node.exe',
    args: ['D:\\DevTools\\UEMCP\\server\\server.mjs'],
  };
  if (clientId === 'claude' || clientId === 'vscode') base.type = 'stdio';
  return { ...base, ...overrides };
}

function memoryLedger(initial = null) {
  let value = initial;
  let writes = 0;
  return {
    async read() {
      return value === null || typeof value === 'string' ? value : structuredClone(value);
    },
    async write(next) {
      value = structuredClone(next);
      writes += 1;
    },
    now: () => WRITTEN_AT,
    snapshot: () => (value === null || typeof value === 'string' ? value : structuredClone(value)),
    writeCount: () => writes,
  };
}

function makeTransactionRoot() {
  const root = join(tmpdir(), `uemcp-client-transaction-${randomUUID()}`);
  mkdirSync(root);
  return root;
}

function cleanupTransactionRoot(root) {
  const normalized = resolve(root).replace(/\\/g, '/').toLowerCase();
  const expected = resolve(tmpdir()).replace(/\\/g, '/').toLowerCase();
  if (!normalized.startsWith(`${expected}/uemcp-client-transaction-`)) throw new Error(`refusing to clean unexpected path: ${root}`);
  rmSync(root, { recursive: true, force: true });
}

function writeBytes(path, bytes) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
  return path;
}

function virtualWindowsMetadata() {
  const metadata = new Map();
  const calls = [];
  let failReplace = false;
  let failMetadata = false;
  const key = path => resolve(path).toLowerCase();
  const stateFor = path => metadata.get(key(path)) ?? { dacl: 'owner-only', attributes: 32, streams: {} };
  return {
    calls,
    set(path, value) {
      metadata.set(key(path), structuredClone(value));
    },
    mutate(path, mutate) {
      const next = structuredClone(stateFor(path));
      mutate(next);
      metadata.set(key(path), next);
    },
    failNextReplace() {
      failReplace = true;
    },
    failNextMetadata() {
      failMetadata = true;
    },
    async fingerprintWindowsFileMetadata(path) {
      if (failMetadata) {
        failMetadata = false;
        const error = new Error('metadata stream limit exceeded');
        error.code = 'WINDOWS_NATIVE_FAILED';
        throw error;
      }
      const state = stateFor(path);
      const streamValues = Object.values(state.streams ?? {});
      return {
        metadata_sha256: sha256Canonical(state),
        stream_count: streamValues.length,
        stream_bytes: streamValues.reduce((total, value) => total + Buffer.byteLength(value), 0),
      };
    },
    async replaceFilePreservingMetadata({ replacementPath, destinationPath }) {
      calls.push({ replacementPath: resolve(replacementPath), destinationPath: resolve(destinationPath) });
      if (failReplace) {
        failReplace = false;
        const error = new Error('replacement failed');
        error.code = 'WINDOWS_NATIVE_FAILED';
        throw error;
      }
      const bytes = await asyncFs.readFile(replacementPath);
      await asyncFs.writeFile(destinationPath, bytes);
      await asyncFs.rm(replacementPath, { force: true });
      return { status: 'replaced' };
    },
  };
}

function createTestLocalState(root, calls = []) {
  const base = createLocalState({
    root: join(root, 'local-state'),
    aclRestrictor: async () => {},
    processInspector: async () => 'alive',
  });
  return Object.freeze({
    ...base,
    async acquireApplyLease(options) {
      calls.push({ type: 'lease' });
      const lease = await base.acquireApplyLease(options);
      return {
        ...lease,
        async release() {
          calls.push({ type: 'lease-release' });
          return lease.release();
        },
      };
    },
    async createSnapshot(path, options) {
      calls.push({ type: 'snapshot', path: resolve(path) });
      return base.createSnapshot(path, options);
    },
    async deleteSnapshot(snapshot) {
      calls.push({ type: 'snapshot-delete', path: snapshot.metadata.target_path });
      return base.deleteSnapshot(snapshot);
    },
  });
}

function fakeAdapter(id, behavior = {}) {
  return {
    id,
    async snapshot(context, operations) {
      return {
        writable_paths: operations.filter(operation => operation.ledger_only !== true).map(operation => ({
          path: operation.path,
          allowed_root: operation.allowed_root,
          scope_kind: operation.scope_kind,
          fingerprint: operation.fingerprint,
          owned_paths: operation.owned_paths,
          shared_resource_id: operation.shared_resource_id,
        })),
        read_only_paths: [
          ...(context.read_only_paths?.filter(row => row.client_id === id) ?? []),
          ...operations.filter(operation => operation.ledger_only === true).map(operation => ({
            path: operation.path,
            allowed_root: operation.allowed_root,
            fingerprint: operation.fingerprint,
          })),
        ],
      };
    },
    async apply(context, operations) {
      if (behavior.failBeforeWrite) throw Object.assign(new Error(`${id} pre-write failure`), { code: 'INJECTED_FAILURE' });
      for (const operation of operations) {
        if (operation.ledger_only === true) continue;
        const parse = bytes => {
          if (behavior.failStructuralRead) throw Object.assign(new Error('structured reread failed'), { code: 'STRUCTURAL_VERIFY_FAILED' });
          return JSON.parse(bytes.toString('utf8'));
        };
        if (operation.external_write === true || behavior.useExternalWrite) {
          const target = behavior.externalPath ?? operation.path;
          const seed = operation.seed_text === undefined
            ? await asyncFs.readFile(operation.path).catch(error => {
              if (error.code === 'ENOENT') return Buffer.alloc(0);
              throw error;
            })
            : Buffer.from(operation.seed_text);
          await context.transaction.runStagedWrite(target, async (path, stage) => {
            if (behavior.externalMutate) return behavior.externalMutate(path, operation, stage);
            await asyncFs.writeFile(path, Buffer.from(operation.desired_text));
            if (behavior.extraStageFile) await asyncFs.writeFile(join(stage.root, 'unexpected.json'), Buffer.from('{}\n'));
          }, {
            seed_bytes: seed,
            stage_relative_path: 'config.json',
            parse,
          });
        } else {
          await context.transaction.writeFile(operation.path, Buffer.from(operation.desired_text), { parse });
        }
        if (behavior.deferDelete) await context.transaction.deleteFileAfterVerify(operation.path);
      }
      if (behavior.ledgerValue) await context.transaction.ownershipLedger.write(behavior.ledgerValue);
      if (behavior.afterWrite) await behavior.afterWrite(context, operations);
      if (behavior.failAfterWrite) throw Object.assign(new Error(`${id} post-write failure`), { code: 'INJECTED_FAILURE' });
      return { status: behavior.applyStatus ?? 'APPLIED' };
    },
    async verify(context, expected) {
      if (behavior.beforeVerify) await behavior.beforeVerify(context, expected);
      if (behavior.failVerify) throw Object.assign(new Error(`${id} native verify failure`), { code: 'NATIVE_VERIFY_FAILED' });
      return { status: behavior.verifyStatus ?? 'READY' };
    },
    async rollback(context, records) {
      if (behavior.failRollback) throw Object.assign(new Error(`${id} rollback hook failure`), { code: 'ROLLBACK_HOOK_FAILED' });
      return { status: 'delegated', count: records.length };
    },
  };
}

async function transactionOperation(clientId, path, root, windowsNative, overrides = {}) {
  const fingerprint = Object.hasOwn(overrides, 'fingerprint')
    ? overrides.fingerprint
    : await captureClientPathFingerprint(path, {
      allowedRoots: [root],
      fsImpl: asyncFs,
      windowsNative,
    });
  return {
    operation_id: `${clientId}-write`,
    client_id: clientId,
    selected: true,
    write_supported: true,
    path,
    allowed_root: root,
    scope_kind: 'user',
    desired_text: `${JSON.stringify({ client: clientId, applied: true })}\n`,
    fingerprint,
    ...overrides,
  };
}

async function setExplicitTestDacl(path) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR;
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:UEMCP_DACL_TARGET
$acl.SetAccessRuleProtection($true, $false)
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow')
$acl.SetAccessRule($rule)
Set-Acl -LiteralPath $env:UEMCP_DACL_TARGET -AclObject $acl
`.trim();
  const result = await createProcessRunner().run(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '-'], {
    env: {
      SystemRoot: resolve(systemRoot),
      WINDIR: resolve(systemRoot),
      UEMCP_DACL_TARGET: resolve(path),
    },
    stdin: `${script}\n\n`,
    timeoutMs: 15_000,
    outputLimitBytes: 8 * 1024,
  });
  if (result.status !== 'exited' || result.exitCode !== 0 || result.stderr !== '') throw new Error('could not establish explicit test DACL');
}

async function rejectsCode(fn, code) {
  try {
    await fn();
    return false;
  } catch (error) {
    return error?.code === code;
  }
}

async function seededLedger(clientId = 'claude', options = {}) {
  const ledger = memoryLedger();
  const target = options.location ?? location(clientId);
  const entry = options.entry ?? physicalEntry(clientId);
  await recordOwnedWrite({
    ledger,
    location: target,
    beforeEntry: null,
    afterEntry: entry,
    ownedPaths: ownedPathsForClient(clientId, entry),
    appliedConfigHash: CONFIG_HASH,
    planDigest: PLAN_DIGEST,
  });
  return { ledger, target, entry };
}

function adoptionOperation(target, currentEntry, overrides = {}) {
  return {
    operation_id: 'adopt-uemcp-entry',
    type: 'ADOPT_EXACT_ENTRY',
    ownership_key: ownershipKey(target),
    current_entry_sha256: sha256Canonical(currentEntry),
    current_config_sha256: CONFIG_HASH,
    plan_digest: PLAN_DIGEST,
    ...overrides,
  };
}

// Keys bind ownership to client, canonical physical path, scope, and entry name.
{
  const base = location('claude');
  t.assert(ownershipKey(base) === ownershipKey({ ...base, configPath: 'c:\\users\\example\\.claude\\config.json' }), 'ownership key canonicalizes Windows path case');
  t.assert(ownershipKey(base) !== ownershipKey({ ...base, configPath: 'C:\\Users\\Other\\.claude\\config.json' }), 'ownership key changes when home/config path moves');
  t.assert(ownershipKey(base) !== ownershipKey({ ...base, scope: 'project:default' }), 'ownership key changes across physical scopes');
  t.assert(ownershipKey(base) !== ownershipKey({ ...base, entryName: 'other' }), 'ownership key changes across entry names');
  t.assert(ownershipKey(base) !== ownershipKey({ ...base, clientId: 'vscode' }), 'ownership key changes across clients');
  t.assert(await rejectsCode(() => ownershipKey({ ...base, configPath: '\\\\?\\C:\\unsafe\\config.json' }), 'INVALID_OWNERSHIP_LOCATION'), 'device-namespace config path cannot enter an ownership key');
}

// Physical projections are adapter-specific and never own env or semantic cwd omission.
{
  t.assert(JSON.stringify(ownedPathsForClient('claude', physicalEntry('claude'))) === JSON.stringify(['/type', '/command', '/args']), 'Claude owns type, command, and args');
  t.assert(JSON.stringify(ownedPathsForClient('vscode', physicalEntry('vscode'))) === JSON.stringify(['/type', '/command', '/args']), 'VS Code owns type, command, and args');
  t.assert(JSON.stringify(ownedPathsForClient('codex', physicalEntry('codex'))) === JSON.stringify(['/command', '/args']), 'Codex owns command and args only');
  t.assert(JSON.stringify(ownedPathsForClient('gemini', physicalEntry('gemini'))) === JSON.stringify(['/command', '/args']), 'Gemini owns command and args only');
  const semanticNull = physicalEntry('claude', { cwd: null, env: {} });
  t.assert(!ownedPathsForClient('claude', semanticNull).some(path => path === '/cwd' || path.startsWith('/env')), 'cwd null and env never become owned paths');
}

// Exact unowned projections are adoptable regardless of absent, empty, or custom env.
{
  const desired = physicalEntry('claude');
  const variants = [
    { label: 'absent environment', entry: { ...desired } },
    { label: 'empty environment', entry: { ...desired, env: {} } },
    { label: 'custom environment', entry: { ...desired, env: { TOKEN: 'secret-value', MODE: 'custom' } } },
  ];
  for (const variant of variants) {
    const result = await inspectOwnership({
      ledger: memoryLedger(),
      currentEntry: variant.entry,
      desiredEntry: desired,
      location: location('claude'),
    });
    t.assert(result.state === 'unowned' && result.recommended_action === 'ADOPT_EXACT_ENTRY', `${variant.label} exact projection requires visible adoption`);
    t.assert(result.owned_diff.length === 0, `${variant.label} does not create an owned-field diff`);
    t.assert(!JSON.stringify(result).includes('secret-value') && !JSON.stringify(result).includes('custom'), `${variant.label} evidence never exposes environment values`);
  }
}

// An unowned differing projection is always a conflict, never implicit adoption.
{
  const desired = physicalEntry('claude');
  const current = { ...desired, command: 'C:\\Other\\node.exe' };
  const result = await inspectOwnership({ ledger: memoryLedger(), currentEntry: current, desiredEntry: desired, location: location('claude') });
  t.assert(result.state === 'unowned', 'differing entry without a ledger remains unowned');
  t.assert(result.recommended_action === 'CONFLICT' && result.owned_diff.some(diff => diff.path === '/command'), 'differing unowned projection stays CONFLICT');
}

// A valid record binds the current owned projection and permits managed updates.
{
  const { ledger, target, entry } = await seededLedger('claude');
  const matching = await inspectOwnership({ ledger, currentEntry: entry, desiredEntry: entry, location: target });
  t.assert(matching.state === 'owned_matching' && matching.recommended_action === 'NO_OP', 'matching current projection and record are owned no-op');

  const upgraded = { ...entry, args: ['D:\\DevTools\\UEMCP\\server\\next-server.mjs'] };
  const update = await inspectOwnership({ ledger, currentEntry: entry, desiredEntry: upgraded, location: target });
  t.assert(update.state === 'owned_matching' && update.recommended_action === 'UPDATE_OWNED_FIELDS', 'record matching current config allows a planned owned-field update');

  const document = ledger.snapshot();
  const record = document.records[ownershipKey(target)];
  t.assert(document.schema_version === '1.0' && /^[0-9a-f]{64}$/.test(document.self_hash), 'ledger document is versioned and self-hashed');
  t.assert(JSON.stringify(record.owned_paths) === JSON.stringify(['/type', '/command', '/args']), 'record stores the exact owned path set');
  t.assert(Object.values(record.value_hashes).every(value => /^[0-9a-f]{64}$/.test(value)), 'record stores hashes rather than owned values');
  t.assert(record.applied_config_sha256 === CONFIG_HASH && record.plan_digest === PLAN_DIGEST && record.written_at === WRITTEN_AT, 'record stores applied config, plan, and time evidence');
  t.assert(!JSON.stringify(document).includes('node.exe') && !JSON.stringify(document).includes('server.mjs'), 'ledger never stores owned field values');
}

// Changes to client-owned fields and environment values do not invalidate ownership.
{
  const { ledger, target, entry } = await seededLedger('codex');
  const current = {
    ...entry,
    enabled: false,
    approval_policy: 'untrusted',
    env: { API_TOKEN: 'alpha\r\nbeta', KEEP: 'byte-for-byte' },
  };
  const result = await inspectOwnership({ ledger, currentEntry: current, desiredEntry: entry, location: target });
  const serialized = JSON.stringify(result);
  t.assert(result.state === 'owned_matching' && result.recommended_action === 'NO_OP', 'client-owned changes preserve matching ownership');
  t.assert(result.client_diff.some(diff => diff.path === '/enabled') && result.environment.keys.includes('API_TOKEN'), 'client-owned changes are reported as hash-only evidence');
  t.assert(!serialized.includes('alpha') && !serialized.includes('beta') && !serialized.includes('byte-for-byte') && !serialized.includes('untrusted'), 'client-owned evidence contains no raw values');
}

// A current owned-field change or omission invalidates automatic ownership authority.
{
  for (const testCase of [
    { label: 'changed owned path', mutate: entry => ({ ...entry, command: 'C:\\Changed\\node.exe' }) },
    { label: 'missing owned path', mutate: entry => { const next = { ...entry }; delete next.args; return next; } },
  ]) {
    const { ledger, target, entry } = await seededLedger('gemini');
    const result = await inspectOwnership({ ledger, currentEntry: testCase.mutate(entry), desiredEntry: entry, location: target });
    t.assert(result.state === 'owned_user_modified' && result.recommended_action === 'CONFLICT', `${testCase.label} requires conflict resolution`);
  }
}

// A stale value hash requires visible readoption even when the current projection is desired.
{
  const original = physicalEntry('codex');
  const { ledger, target } = await seededLedger('codex', { entry: original });
  const current = { ...original, command: 'C:\\Updated\\node.exe' };
  const result = await inspectOwnership({ ledger, currentEntry: current, desiredEntry: current, location: target });
  t.assert(result.state === 'owned_user_modified', 'stale value hash is detected against the current owned projection');
  t.assert(result.recommended_action === 'ADOPT_EXACT_ENTRY', 'exact current projection with stale ownership still requires visible readoption');
}

// Corrupt or tampered ledger evidence is stale and cannot authorize a write.
{
  const seeded = await seededLedger('claude');
  const tampered = seeded.ledger.snapshot();
  tampered.records[ownershipKey(seeded.target)].value_hashes['/command'] = '0'.repeat(64);
  const tamperedResult = await inspectOwnership({
    ledger: memoryLedger(tampered),
    currentEntry: seeded.entry,
    desiredEntry: seeded.entry,
    location: seeded.target,
  });
  t.assert(tamperedResult.state === 'stale_record' && tamperedResult.recommended_action === 'ADOPT_EXACT_ENTRY', 'tampered value hash loses authority and requires explicit readoption');

  const malformedResult = await inspectOwnership({
    ledger: memoryLedger('{not-json'),
    currentEntry: seeded.entry,
    desiredEntry: seeded.entry,
    location: seeded.target,
  });
  t.assert(malformedResult.state === 'stale_record', 'malformed ledger JSON is stale evidence');
  t.assert(await rejectsCode(() => recordOwnedWrite({
    ledger: memoryLedger(tampered),
    location: seeded.target,
    beforeEntry: seeded.entry,
    afterEntry: seeded.entry,
    ownedPaths: ownedPathsForClient('claude', seeded.entry),
    appliedConfigHash: CONFIG_HASH,
    planDigest: PLAN_DIGEST,
  }), 'OWNERSHIP_LEDGER_INVALID'), 'a write never overwrites a tampered ledger');
}

// Copied or relocated config content does not carry ownership to another location.
{
  const seeded = await seededLedger('claude');
  for (const [label, target] of [
    ['copied config path', location('claude', { configPath: 'C:\\Copied\\.claude\\config.json' })],
    ['moved home', location('claude', { configPath: 'D:\\NewHome\\.claude\\config.json' })],
    ['different physical scope', location('claude', { scope: 'project:default' })],
    ['name-only match', location('claude', { entryName: 'uemcp-copy' })],
  ]) {
    const result = await inspectOwnership({ ledger: seeded.ledger, currentEntry: seeded.entry, desiredEntry: seeded.entry, location: target });
    t.assert(result.state === 'unowned' && result.recommended_action === 'ADOPT_EXACT_ENTRY', `${label} does not inherit another location's record`);
  }
}

// Logical profile aliases deduplicate to one physical ownership operation while retaining evidence.
{
  const defaultPath = 'C:\\Users\\Example\\AppData\\Roaming\\Code\\User\\mcp.json';
  const inherited = deduplicateOwnershipLocations([
    location('vscode', { configPath: defaultPath, scope: 'user:default', requestedContexts: ['default'] }),
    location('vscode', { configPath: defaultPath, scope: 'user:default', requestedContexts: ['profile:work (useDefaultFlags.mcp)'] }),
  ]);
  t.assert(inherited.length === 1, 'VS Code inherited profile and default resource produce one physical operation');
  t.assert(inherited[0].requested_contexts.length === 2 && inherited[0].requested_contexts.includes('profile:work (useDefaultFlags.mcp)'), 'deduplicated physical location retains requested profile evidence');

  const profileSpecific = deduplicateOwnershipLocations([
    ...inherited.map(row => ({
      clientId: row.client_id,
      configPath: row.canonical_config_path,
      scope: row.scope,
      entryName: row.entry_name,
      requestedContexts: row.requested_contexts,
    })),
    location('vscode', {
      configPath: 'C:\\Users\\Example\\AppData\\Roaming\\Code\\User\\profiles\\abc\\mcp.json',
      scope: 'user:profile:abc',
      requestedContexts: ['profile:abc'],
    }),
  ]);
  t.assert(profileSpecific.length === 2, 'profile-specific VS Code resource remains a distinct physical operation');
}

// Adoption is a distinct approved ledger-only operation with a fresh exact-entry precondition.
{
  const ledger = memoryLedger();
  const target = location('claude');
  const current = physicalEntry('claude', { env: { TOKEN: 'alpha\r\nbeta', KEEP: 'byte-for-byte' } });
  const desired = physicalEntry('claude');
  const before = JSON.stringify(current);
  const operation = adoptionOperation(target, current);
  const receipt = await adoptExactEntry({
    ledger,
    location: target,
    currentEntry: current,
    desiredEntry: desired,
    approvedOperationId: operation,
  });
  const serialized = JSON.stringify(receipt);
  t.assert(receipt.status === 'adopted' && receipt.operation_id === operation.operation_id && receipt.provider_config_written === false, 'adoption records one visible ledger-only operation');
  t.assert(ledger.writeCount() === 1 && JSON.stringify(current) === before, 'adoption does not mutate or write provider config values');
  t.assert(receipt.environment.keys.includes('TOKEN') && !serialized.includes('alpha') && !serialized.includes('beta') && !serialized.includes('byte-for-byte'), 'adoption receipt exposes only environment names and hashes');
  const owned = await inspectOwnership({ ledger, currentEntry: current, desiredEntry: desired, location: target });
  t.assert(owned.state === 'owned_matching', 'successful adoption binds the current owned projection');
}

// Adoption fails closed when approval or current-entry evidence changes.
{
  const target = location('claude');
  const current = physicalEntry('claude');
  const desired = physicalEntry('claude');
  const cases = [
    { label: 'wrong operation type', operation: adoptionOperation(target, current, { type: 'WRITE_CONFIG' }), desired },
    { label: 'wrong ownership key', operation: adoptionOperation(target, current, { ownership_key: '0'.repeat(64) }), desired },
    { label: 'stale current entry hash', operation: adoptionOperation(target, current, { current_entry_sha256: '0'.repeat(64) }), desired },
    { label: 'invalid plan digest', operation: adoptionOperation(target, current, { plan_digest: 'not-a-digest' }), desired },
    { label: 'unreviewed extra operation field', operation: adoptionOperation(target, current, { environment_values: { TOKEN: 'secret' } }), desired },
    { label: 'differing owned projection', operation: adoptionOperation(target, current), desired: { ...desired, command: 'C:\\Other\\node.exe' } },
  ];
  for (const testCase of cases) {
    const ledger = memoryLedger();
    t.assert(await rejectsCode(() => adoptExactEntry({
      ledger,
      location: target,
      currentEntry: current,
      desiredEntry: testCase.desired,
      approvedOperationId: testCase.operation,
    }), 'ADOPTION_PRECONDITION_FAILED'), `${testCase.label} blocks adoption`);
    t.assert(ledger.writeCount() === 0, `${testCase.label} leaves the ledger untouched`);
  }
}


// Invalid physical value types cannot be recorded as an adapter-owned projection.
{
  for (const [label, entry] of [
    ['non-string command', physicalEntry('codex', { command: { path: 'node.exe' } })],
    ['non-array args', physicalEntry('codex', { args: 'server.mjs' })],
    ['non-string arg', physicalEntry('codex', { args: [42] })],
    ['non-stdio type', physicalEntry('claude', { type: 'http' })],
  ]) {
    t.assert(await rejectsCode(() => recordOwnedWrite({
      ledger: memoryLedger(),
      location: location(label === 'non-stdio type' ? 'claude' : 'codex'),
      beforeEntry: null,
      afterEntry: entry,
      ownedPaths: label === 'non-stdio type' ? ['/type', '/command', '/args'] : ['/command', '/args'],
      appliedConfigHash: CONFIG_HASH,
      planDigest: PLAN_DIGEST,
    }), 'INVALID_OWNED_PATHS'), `${label} cannot become an owned projection`);
  }
}

// Callers cannot expand ownership into environment or absent optional fields.
{
  const ledger = memoryLedger();
  const target = location('claude');
  const entry = physicalEntry('claude', { env: { TOKEN: 'secret' }, cwd: null });
  for (const forbiddenPath of ['/env/TOKEN', '/cwd']) {
    t.assert(await rejectsCode(() => recordOwnedWrite({
      ledger,
      location: target,
      beforeEntry: null,
      afterEntry: entry,
      ownedPaths: [...ownedPathsForClient('claude', entry), forbiddenPath],
      appliedConfigHash: CONFIG_HASH,
      planDigest: PLAN_DIGEST,
    }), 'INVALID_OWNED_PATHS'), `${forbiddenPath} cannot become installer-owned`);
  }
}

// A successful transaction leases first, snapshots every writable path once, and applies in fixed client order.
{
  const root = makeTransactionRoot();
  try {
    const calls = [];
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root, calls);
    const adapters = ['vscode', 'gemini', 'claude', 'codex'].map(id => fakeAdapter(id, {
      afterWrite: async () => calls.push({ type: 'applied', id }),
    }));
    const operations = [];
    for (const id of ['claude', 'codex', 'gemini', 'vscode']) {
      const path = writeBytes(join(home, `${id}.json`), Buffer.from(`${JSON.stringify({ client: id, applied: false })}\n`));
      windowsNative.set(path, { dacl: `${id}-owner`, attributes: 32, streams: { canary: `${id}-stream` } });
      operations.push(await transactionOperation(id, path, home, windowsNative));
    }
    const policyPath = writeBytes(join(home, 'policy.json'), Buffer.from('{"managed":true}\n'));
    const readOnlyFingerprint = await captureClientPathFingerprint(policyPath, {
      allowedRoots: [home],
      fsImpl: asyncFs,
      windowsNative,
      writable: false,
    });
    const ownershipPath = localState.paths().ownership;
    const ownershipFingerprint = await captureClientPathFingerprint(ownershipPath, {
      allowedRoots: [localState.paths().state],
      fsImpl: asyncFs,
      windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    const context = {
      read_only_paths: [{
        client_id: 'claude',
        path: policyPath,
        allowed_root: home,
        fingerprint: readOnlyFingerprint,
        scope_kind: 'managed',
      }],
    };
    const planned = { planDigest: PLAN_DIGEST, adapters, operations, context, ownershipFingerprint };
    const snapshot = await transaction.snapshot(planned);
    t.assert(calls[0]?.type === 'lease', 'transaction acquires the core apply lease before preflight');
    t.assert(snapshot.writable_paths.length === 5, 'all four configs plus ownership ledger are snapshotted before apply');
    t.assert(calls.filter(call => call.type === 'snapshot').length === 5, 'each writable physical path receives one exact-byte snapshot');
    t.assert(!calls.some(call => call.type === 'snapshot' && call.path === resolve(policyPath)), 'managed read-only evidence is never snapshotted as writable state');

    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations, context });
    t.assert(result.status === 'APPLIED' && result.clients.every(client => client.status === 'READY'), 'successful structural and native verification commits APPLIED');
    t.assert(JSON.stringify(calls.filter(call => call.type === 'applied').map(call => call.id)) === JSON.stringify(['claude', 'codex', 'gemini', 'vscode']), 'adapters apply in locked deterministic order');
    t.assert(result.touched_files.length === 4 && result.touched_files.every(file => /^[0-9a-f]{64}$/.test(file.applied_sha256)), 'result records one applied content hash per changed config');
    t.assert(calls.filter(call => call.type === 'snapshot-delete').length === 5 && calls.at(-1)?.type === 'lease-release', 'successful apply deletes all snapshots before releasing the lease');
    t.assert(result.retained_snapshots.length === 0, 'successful apply retains no recovery snapshots');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Failure before the first write and after each adapter write restores every original byte sequence.
{
  const failures = [
    { label: 'before first write', clientId: 'claude', behavior: { failBeforeWrite: true } },
    ...['claude', 'codex', 'gemini', 'vscode'].map(clientId => ({ label: `after ${clientId} write`, clientId, behavior: { failAfterWrite: true } })),
  ];
  for (const failure of failures) {
    const root = makeTransactionRoot();
    try {
      const home = join(root, 'client-home');
      const windowsNative = virtualWindowsMetadata();
      const localState = createTestLocalState(root);
      const originals = new Map();
      const operations = [];
      const adapters = [];
      for (const id of ['claude', 'codex', 'gemini', 'vscode']) {
        const bytes = Buffer.from(`${JSON.stringify({ client: id, marker: `original-${id}` })}\r\n`);
        const path = writeBytes(join(home, `${id}.json`), bytes);
        originals.set(path, bytes);
        operations.push(await transactionOperation(id, path, home, windowsNative));
        adapters.push(fakeAdapter(id, id === failure.clientId ? failure.behavior : {}));
      }
      const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
        allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
      });
      const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
      await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations, context: {}, ownershipFingerprint });
      const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations, context: {} });
      t.assert(result.status === 'ROLLED_BACK', `${failure.label} returns verified ROLLED_BACK`);
      let exact = true;
      for (const [path, bytes] of originals) exact &&= (await asyncFs.readFile(path)).equals(bytes);
      t.assert(exact, `${failure.label} restores exact original bytes for every potentially changed config`);
      t.assert(result.retained_snapshots.length === 0, `${failure.label} deletes snapshots after verified restoration`);
    } finally {
      cleanupTransactionRoot(root);
    }
  }
}

// Structured reread and native verification failures trigger the same guarded rollback.
{
  for (const [label, behavior] of [
    ['structural reread failure', { failStructuralRead: true }],
    ['native verify failure', { failVerify: true }],
  ]) {
    const root = makeTransactionRoot();
    try {
      const home = join(root, 'client-home');
      const windowsNative = virtualWindowsMetadata();
      const localState = createTestLocalState(root);
      const original = Buffer.from('{"state":"original"}\n');
      const path = writeBytes(join(home, 'claude.json'), original);
      const operation = await transactionOperation('claude', path, home, windowsNative);
      const adapters = [fakeAdapter('claude', behavior)];
      const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
        allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
      });
      const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
      await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
      const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
      t.assert(result.status === 'ROLLED_BACK' && (await asyncFs.readFile(path)).equals(original), `${label} restores exact bytes`);
    } finally {
      cleanupTransactionRoot(root);
    }
  }
}

// Provider config and ownership ledger bytes participate in one rollback boundary.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const configOriginal = Buffer.from('{"state":"original"}\r\n');
    const ledgerOriginal = Buffer.from('{"legacy":"preserve-exactly"}\r\n');
    const path = writeBytes(join(home, 'claude.json'), configOriginal);
    writeBytes(localState.paths().ownership, ledgerOriginal);
    const operation = await transactionOperation('claude', path, home, windowsNative);
    const adapters = [fakeAdapter('claude', {
      ledgerValue: { schema_version: '1.0', records: {}, self_hash: '0'.repeat(64) },
      failAfterWrite: true,
    })];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    const snapshot = await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
    t.assert(snapshot.writable_paths.includes(resolve(localState.paths().ownership)), 'ownership ledger is included in the same transaction snapshot set');
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK', 'provider plus ownership write failure rolls back as one unit');
    t.assert((await asyncFs.readFile(path)).equals(configOriginal), 'provider config exact bytes are restored with ownership failure');
    t.assert((await asyncFs.readFile(localState.paths().ownership)).equals(ledgerOriginal), 'ownership ledger exact bytes are restored with provider config');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Trust, enablement, or restart work remains ACTION_REQUIRED without rolling back a valid write.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = writeBytes(join(home, 'gemini.json'), Buffer.from('{"state":"original"}\n'));
    const operation = await transactionOperation('gemini', path, home, windowsNative);
    const adapters = [fakeAdapter('gemini', { verifyStatus: 'PENDING_TRUST' })];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
    t.assert(result.status === 'ACTION_REQUIRED' && result.clients[0].status === 'PENDING_TRUST', 'host-owned trust action commits structurally valid config as ACTION_REQUIRED');
    t.assert((await asyncFs.readFile(path, 'utf8')) === operation.desired_text, 'ACTION_REQUIRED does not roll back a valid registration');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Successful commit cleanup failures retain bounded recovery evidence and the production error code.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const baseLocalState = createTestLocalState(root);
    const path = writeBytes(join(home, 'claude.json'), Buffer.from('{"state":"original"}\n'));
    const localState = Object.freeze({
      ...baseLocalState,
      async deleteSnapshot(snapshot) {
        if (resolve(snapshot.metadata.target_path) === resolve(path)) {
          throw Object.assign(new Error('injected successful-commit cleanup failure'), { code: 'SNAPSHOT_DELETE_FAILED' });
        }
        return baseLocalState.deleteSnapshot(snapshot);
      },
    });
    const operation = await transactionOperation('claude', path, home, windowsNative);
    const adapter = fakeAdapter('claude');
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    const retained = result.retained_snapshots.find(row => resolve(row.path) === resolve(path));
    const cleanup = result.cleanup_actions.find(row => resolve(row.path) === resolve(path));
    t.assert(result.status === 'ACTION_REQUIRED', 'successful commit cleanup failure remains an actionable committed result');
    t.assert(cleanup?.code === 'SNAPSHOT_DELETE_FAILED', 'successful commit cleanup failure exposes its stable production error code');
    t.assert(typeof retained?.retained_until === 'string' && Number.isFinite(Date.parse(retained.retained_until)), 'successful commit cleanup failure retains a bounded recovery deadline');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Concurrent content, DACL, attribute, or stream edits survive rollback and retain bounded recovery evidence.
{
  const mutations = [
    {
      label: 'default stream',
      mutate: async (path) => asyncFs.writeFile(path, Buffer.from('{"external":true}\n')),
      verify: async path => (await asyncFs.readFile(path, 'utf8')).includes('external'),
    },
    {
      label: 'DACL',
      mutate: async (path, native) => native.mutate(path, state => { state.dacl = 'external-owner'; }),
      verify: async () => true,
    },
    {
      label: 'attribute',
      mutate: async (path, native) => native.mutate(path, state => { state.attributes = 1; }),
      verify: async () => true,
    },
    {
      label: 'alternate stream',
      mutate: async (path, native) => native.mutate(path, state => { state.streams['canary-secret-stream'] = 'external-stream-value'; }),
      verify: async () => true,
    },
  ];
  for (const mutation of mutations) {
    const root = makeTransactionRoot();
    try {
      const home = join(root, 'client-home');
      const windowsNative = virtualWindowsMetadata();
      const localState = createTestLocalState(root);
      const path = writeBytes(join(home, 'claude.json'), Buffer.from('{"state":"original"}\n'));
      windowsNative.set(path, { dacl: 'original-owner', attributes: 32, streams: { canary: 'original-stream' } });
      const operation = await transactionOperation('claude', path, home, windowsNative);
      const adapters = [fakeAdapter('claude', {
        afterWrite: async () => mutation.mutate(path, windowsNative),
        failAfterWrite: true,
      })];
      const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
        allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
      });
      const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
      await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
      const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
      const serialized = JSON.stringify(result);
      t.assert(result.status === 'ROLLBACK_CONFLICT', `concurrent ${mutation.label} edit returns ROLLBACK_CONFLICT`);
      t.assert(await mutation.verify(path), `concurrent ${mutation.label} edit survives rollback`);
      t.assert(result.retained_snapshots.length === 1 && Number.isFinite(Date.parse(result.retained_snapshots[0].retained_until)), `concurrent ${mutation.label} edit retains seven-day recovery evidence`);
      t.assert(!serialized.includes('original-stream') && !serialized.includes('canary-secret-stream') && !serialized.includes('external-stream-value') && !serialized.includes('owner-only'), `concurrent ${mutation.label} result contains path-only remediation`);
    } finally {
      cleanupTransactionRoot(root);
    }
  }
}

// A rollback hook failure is visible but cannot stop central restoration of safe paths.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const original = Buffer.from('{"state":"original"}\n');
    const path = writeBytes(join(home, 'codex.json'), original);
    const operation = await transactionOperation('codex', path, home, windowsNative);
    const adapters = [fakeAdapter('codex', { failAfterWrite: true, failRollback: true })];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
    t.assert(result.status === 'ROLLBACK_FAILED' && (await asyncFs.readFile(path)).equals(original), 'rollback hook failure remains visible after central exact-byte restoration');
    t.assert(result.retained_snapshots.length === 0, 'verified central restoration does not retain unnecessary snapshots');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Replacement failure leaves original bytes and metadata untouched without rename fallback.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const original = Buffer.from('{"state":"original"}\n');
    const path = writeBytes(join(home, 'vscode.json'), original);
    windowsNative.set(path, { dacl: 'original-owner', attributes: 32, streams: { canary: 'original-stream' } });
    const operation = await transactionOperation('vscode', path, home, windowsNative);
    const adapters = [fakeAdapter('vscode')];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
    windowsNative.failNextReplace();
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK' && (await asyncFs.readFile(path)).equals(original), 'metadata-preserving apply failure leaves original bytes unchanged');
    t.assert(windowsNative.calls.length === 1, 'metadata-preserving apply failure never falls back to rename-overwrite');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Missing originals are removed on rollback, including only transaction-created empty parents.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = join(home, 'created', 'nested', 'claude.json');
    const operation = await transactionOperation('claude', path, home, windowsNative);
    const adapters = [fakeAdapter('claude', { failAfterWrite: true })];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK' && await asyncFs.stat(path).then(() => false, error => error.code === 'ENOENT'), 'rollback removes a transaction-created config');
    t.assert(await asyncFs.stat(join(home, 'created')).then(() => false, error => error.code === 'ENOENT'), 'rollback removes only now-empty parent directories created by the transaction');
    t.assert((await asyncFs.stat(home)).isDirectory(), 'rollback preserves the pre-existing writable root');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Unsafe path, authority, and precondition cases fail before any snapshot is created.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const calls = [];
    const localState = createTestLocalState(root, calls);
    const safePath = writeBytes(join(home, 'claude.json'), Buffer.from('{}\n'));
    const safe = await transactionOperation('claude', safePath, home, windowsNative);
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const cases = [
      { label: 'unselected adapter', operation: { ...safe, selected: false }, code: 'UNAPPROVED_CLIENT_WRITE' },
      { label: 'unknown-version write', operation: { ...safe, write_supported: false }, code: 'UNSUPPORTED_CLIENT_WRITE' },
      { label: 'managed-scope write', operation: { ...safe, scope_kind: 'managed' }, code: 'READ_ONLY_SCOPE' },
      { label: 'path outside writable root', operation: { ...safe, path: join(root, 'outside.json') }, code: 'PATH_OUTSIDE_WRITABLE_ROOT' },
      { label: 'relative traversal', operation: { ...safe, path: '..\\outside.json' }, code: 'UNSAFE_TRANSACTION_PATH' },
      { label: 'Windows device path', operation: { ...safe, path: '\\\\?\\C:\\unsafe.json' }, code: 'UNSAFE_TRANSACTION_PATH' },
    ];
    for (const testCase of cases) {
      calls.length = 0;
      const adapters = [fakeAdapter('claude')];
      const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
      t.assert(await rejectsCode(() => transaction.snapshot({
        planDigest: PLAN_DIGEST,
        adapters,
        operations: [testCase.operation],
        context: {},
        ownershipFingerprint,
      }), testCase.code), `${testCase.label} is rejected during preflight`);
      t.assert(!calls.some(call => call.type === 'snapshot'), `${testCase.label} fails before snapshot creation`);
    }
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Link identity, linked ancestors, and fingerprint drift fail closed before snapshots.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const outside = join(root, 'outside');
    mkdirSync(home, { recursive: true });
    mkdirSync(outside, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const calls = [];
    const localState = createTestLocalState(root, calls);
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });

    const hardLinked = writeBytes(join(home, 'hard-linked.json'), Buffer.from('{}\n'));
    await asyncFs.link(hardLinked, join(home, 'second-link.json'));
    const hardFingerprint = await captureClientPathFingerprint(hardLinked, {
      allowedRoots: [home], fsImpl: asyncFs, windowsNative, writable: false,
    });
    const hardOperation = {
      ...(await transactionOperation('claude', hardLinked, home, windowsNative, { fingerprint: hardFingerprint })),
    };
    const linkedParent = join(home, 'linked-parent');
    await asyncFs.symlink(outside, linkedParent, 'junction');
    const linkedPath = join(linkedParent, 'missing.json');
    const linkedFingerprint = await captureClientPathFingerprint(linkedPath, {
      allowedRoots: [outside], fsImpl: asyncFs, windowsNative, writable: false,
    });
    const linkedOperation = {
      ...(await transactionOperation('claude', linkedPath, home, windowsNative, { fingerprint: linkedFingerprint })),
    };

    const driftPath = writeBytes(join(home, 'drift.json'), Buffer.from('{}\n'));
    const driftOperation = await transactionOperation('claude', driftPath, home, windowsNative);
    await asyncFs.writeFile(driftPath, Buffer.from('{"changed":true}\n'));
    for (const [label, operation, code] of [
      ['multiply linked writable file', hardOperation, 'UNSAFE_WRITABLE_PATH'],
      ['missing config below linked ancestor', linkedOperation, 'UNSAFE_WRITABLE_PATH'],
      ['content fingerprint drift', driftOperation, 'TRANSACTION_PRECONDITION_CHANGED'],
    ]) {
      calls.length = 0;
      const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
      t.assert(await rejectsCode(() => transaction.snapshot({
        planDigest: PLAN_DIGEST,
        adapters: [fakeAdapter('claude')],
        operations: [operation],
        context: {},
        ownershipFingerprint,
      }), code), `${label} is rejected`);
      t.assert(!calls.some(call => call.type === 'snapshot'), `${label} fails before snapshots`);
    }
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Shared physical paths require explicit non-overlapping ownership; aliases snapshot once.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const sharedPath = writeBytes(join(home, 'shared.json'), Buffer.from('{}\n'));
    const claude = await transactionOperation('claude', sharedPath, home, windowsNative);
    const vscode = await transactionOperation('vscode', sharedPath.toUpperCase(), home.toUpperCase(), windowsNative, {
      operation_id: 'vscode-shared-write',
    });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    t.assert(await rejectsCode(() => transaction.snapshot({
      planDigest: PLAN_DIGEST,
      adapters: [fakeAdapter('claude'), fakeAdapter('vscode')],
      operations: [claude, vscode],
      context: {},
      ownershipFingerprint,
    }), 'SHARED_WRITE_CONFLICT'), 'same config path across adapters conflicts without explicit field partitioning');

    const calls = [];
    const partitionedState = createTestLocalState(join(root, 'partitioned'), calls);
    const partitionedOwnership = await captureClientPathFingerprint(partitionedState.paths().ownership, {
      allowedRoots: [partitionedState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const partitioned = createClientTransaction({ localState: partitionedState, fsImpl: asyncFs, windowsNative });
    const sharedOperations = [
      { ...claude, shared_resource_id: 'shared-user-config', owned_paths: ['/servers/uemcp'] },
      { ...vscode, shared_resource_id: 'shared-user-config', owned_paths: ['/inputs'] },
    ];
    const snapshot = await partitioned.snapshot({
      planDigest: PLAN_DIGEST,
      adapters: [fakeAdapter('claude'), fakeAdapter('vscode')],
      operations: sharedOperations,
      context: {},
      ownershipFingerprint: partitionedOwnership,
    });
    t.assert(snapshot.writable_paths.filter(path => path.toLowerCase() === resolve(sharedPath).toLowerCase()).length === 1, 'case aliases with non-overlapping declared fields produce one physical snapshot');
    await partitioned.rollback({ reason: 'test cleanup' });
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Apply revalidates the exact approved operation set and lease contention remains bounded.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = writeBytes(join(home, 'codex.json'), Buffer.from('{}\n'));
    const operation = await transactionOperation('codex', path, home, windowsNative);
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('codex');
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    t.assert(await rejectsCode(() => transaction.apply({
      planDigest: PLAN_DIGEST,
      adapters: [adapter],
      operations: [{ ...operation, desired_text: '{"expanded":true}\n' }],
      context: {},
    }), 'UNAPPROVED_OPERATION_SET'), 'apply cannot expand or alter the reviewed operation set');
    const releasedAfterRejection = await localState.acquireApplyLease({
      pid: process.pid,
      processStart: Math.round(Date.now() - process.uptime() * 1000),
      waitMs: 0,
    });
    t.assert(Boolean(releasedAfterRejection), 'rejected apply operation set releases its lease and snapshots automatically');
    await releasedAfterRejection.release();

    const firstLease = await localState.acquireApplyLease({ pid: process.pid, processStart: Math.round(Date.now() - process.uptime() * 1000), waitMs: 0 });
    const second = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    t.assert(await rejectsCode(() => second.snapshot({
      planDigest: PLAN_DIGEST,
      adapters: [adapter],
      operations: [operation],
      context: {},
      ownershipFingerprint,
    }), 'APPLY_IN_PROGRESS'), 'concurrent second UEMCP transaction is rejected by the core lease');
    await firstLease.release();
  } finally {
    cleanupTransactionRoot(root);
  }
}

// A concurrent edit during native verification is detected before commit and never overwritten.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = writeBytes(join(home, 'claude.json'), Buffer.from('{"state":"original"}\n'));
    const operation = await transactionOperation('claude', path, home, windowsNative);
    const adapters = [fakeAdapter('claude', {
      beforeVerify: async () => asyncFs.writeFile(path, Buffer.from('{"external":"during-verify"}\n')),
    })];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
    t.assert(result.status === 'ROLLBACK_CONFLICT', 'edit during native verification prevents a false successful commit');
    t.assert((await asyncFs.readFile(path, 'utf8')).includes('during-verify'), 'edit during native verification survives guarded rollback');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Bytes changed between replacement and post-write capture are never adopted as the transaction baseline.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const baseWindowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const original = Buffer.from('{"state":"original"}\n');
    const hostile = Buffer.from('{"external":"between-replace-and-capture"}\n');
    const path = writeBytes(join(home, 'claude.json'), original);
    const operation = await transactionOperation('claude', path, home, baseWindowsNative);
    let injectSubstitution = true;
    const windowsNative = {
      ...baseWindowsNative,
      async replaceFilePreservingMetadata(options) {
        const replaced = await baseWindowsNative.replaceFilePreservingMetadata(options);
        if (injectSubstitution) {
          injectSubstitution = false;
          await asyncFs.writeFile(options.destinationPath, hostile);
        }
        return replaced;
      },
    };
    const adapters = [fakeAdapter('claude')];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK', 'unexpected post-replacement bytes fail before becoming an accepted baseline');
    t.assert(result.clients[0]?.error_code === 'TRANSACTION_POSTWRITE_CHANGED', 'post-replacement byte substitution has a stable error code');
    t.assert((await asyncFs.readFile(path)).equals(original), 'post-replacement substitution rolls back to the exact original bytes');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Writable drift is rechecked before an adapter can launch active native verification.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = writeBytes(join(home, 'claude.json'), Buffer.from('{"state":"original"}\n'));
    const operation = await transactionOperation('claude', path, home, windowsNative);
    let outerLaunches = 0;
    const adapters = [fakeAdapter('claude', {
      beforeVerify: async context => {
        await asyncFs.writeFile(path, Buffer.from('{"external":"before-launch"}\n'));
        await context.beforeActiveClientLaunch({ client_id: 'claude', kind: 'native' });
      },
    })];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({
      planDigest: PLAN_DIGEST,
      adapters,
      operations: [operation],
      context: {
        beforeActiveClientLaunch: async () => {
          outerLaunches += 1;
        },
      },
    });
    t.assert(result.status === 'ROLLBACK_CONFLICT', 'prelaunch writable drift prevents commit');
    t.assert(result.clients[0]?.error_code === 'TRANSACTION_POSTWRITE_CHANGED', 'prelaunch writable drift has a stable error code');
    t.assert(outerLaunches === 0, 'transaction-owned writable drift is rejected before the outer launch guard delegates');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Post-write hard-link drift is a rollback conflict, not authority to replace the linked file.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = writeBytes(join(home, 'codex.json'), Buffer.from('{"state":"original"}\n'));
    const secondLink = join(home, 'external-hard-link.json');
    const operation = await transactionOperation('codex', path, home, windowsNative);
    const adapters = [fakeAdapter('codex', {
      afterWrite: async () => asyncFs.link(path, secondLink),
      failAfterWrite: true,
    })];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
    t.assert(result.status === 'ROLLBACK_CONFLICT', 'post-write link-count drift is classified as ROLLBACK_CONFLICT');
    t.assert((await asyncFs.stat(path)).nlink === 2 && (await asyncFs.stat(secondLink)).nlink === 2, 'post-write hard-link state is preserved');
    t.assert(result.retained_snapshots.length === 1, 'post-write hard-link drift retains restricted recovery evidence');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// A parent planned as absent cannot be adopted if another process creates it before apply.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const externalParent = join(home, 'externally-created');
    const path = join(externalParent, 'claude.json');
    const operation = await transactionOperation('claude', path, home, windowsNative);
    const adapters = [fakeAdapter('claude')];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
    await asyncFs.mkdir(externalParent);
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK' && result.rollback.reason_code === 'TRANSACTION_PRECONDITION_CHANGED', 'externally created planned parent invalidates apply');
    t.assert(await asyncFs.stat(path).then(() => false, error => error.code === 'ENOENT'), 'parent race produces no config write');
    t.assert((await asyncFs.stat(externalParent)).isDirectory(), 'parent race never removes the externally created directory');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// A directory-creation failure removes only parents already created by this transaction.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const firstParent = join(home, 'created');
    const deniedParent = join(firstParent, 'denied');
    const path = join(deniedParent, 'claude.json');
    const operation = await transactionOperation('claude', path, home, windowsNative);
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const deniedFs = {
      ...asyncFs,
      async mkdir(target, options) {
        if (resolve(target).toLowerCase() === resolve(deniedParent).toLowerCase()) {
          const error = new Error('directory creation denied');
          error.code = 'EACCES';
          throw error;
        }
        return asyncFs.mkdir(target, options);
      },
    };
    const transaction = createClientTransaction({ localState, fsImpl: deniedFs, windowsNative });
    const adapter = fakeAdapter('claude');
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK', 'directory-creation failure terminates through verified rollback');
    t.assert(await asyncFs.stat(path).then(() => false, error => error.code === 'ENOENT'), 'directory-creation failure produces no config file');
    t.assert(await asyncFs.stat(firstParent).then(() => false, error => error.code === 'ENOENT'), 'directory-creation failure removes the parent already created by this transaction');
    t.assert((await asyncFs.stat(home)).isDirectory(), 'directory-creation failure preserves the original writable root');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Read-only access and metadata inspection failures stop before snapshot creation.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const path = writeBytes(join(home, 'claude.json'), Buffer.from('{}\n'));
    const windowsNative = virtualWindowsMetadata();
    const deniedFs = {
      ...asyncFs,
      async access() {
        const error = new Error('denied');
        error.code = 'EACCES';
        throw error;
      },
    };
    t.assert(await rejectsCode(() => captureClientPathFingerprint(path, {
      allowedRoots: [home], fsImpl: deniedFs, windowsNative,
    }), 'READ_ONLY_TARGET'), 'read-only target is rejected before planning a write');

    const localState = createTestLocalState(root);
    const operation = await transactionOperation('claude', path, home, windowsNative);
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    windowsNative.failNextMetadata();
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    t.assert(await rejectsCode(() => transaction.snapshot({
      planDigest: PLAN_DIGEST,
      adapters: [fakeAdapter('claude')],
      operations: [operation],
      context: {},
      ownershipFingerprint,
    }), 'METADATA_INSPECTION_FAILED'), 'metadata inspection failure aborts preflight with a stable code');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Rollback replacement failure retains the original snapshot and reports an incomplete recovery.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const original = Buffer.from('{"state":"original"}\n');
    const path = writeBytes(join(home, 'vscode.json'), original);
    const operation = await transactionOperation('vscode', path, home, windowsNative);
    const adapters = [fakeAdapter('vscode', {
      afterWrite: async () => windowsNative.failNextReplace(),
      failAfterWrite: true,
    })];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
    t.assert(result.status === 'ROLLBACK_FAILED', 'rollback replacement failure is visible as ROLLBACK_FAILED');
    t.assert(!(await asyncFs.readFile(path)).equals(original), 'failed rollback does not claim original bytes were restored');
    t.assert(result.retained_snapshots.length === 1, 'failed rollback retains bounded recovery evidence');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Snapshot cleanup failure after verified restoration still reports the surviving recovery artifact.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const original = Buffer.from('{"state":"original"}\n');
    const path = writeBytes(join(home, 'vscode.json'), original);
    const baseLocalState = createTestLocalState(root);
    let rejectedSnapshotDelete = false;
    const localState = Object.freeze({
      ...baseLocalState,
      async deleteSnapshot(snapshot) {
        if (!rejectedSnapshotDelete && snapshot.metadata.target_path === path) {
          rejectedSnapshotDelete = true;
          throw Object.assign(new Error('injected snapshot cleanup failure'), { code: 'SNAPSHOT_DELETE_FAILED' });
        }
        return baseLocalState.deleteSnapshot(snapshot);
      },
    });
    const operation = await transactionOperation('vscode', path, home, windowsNative);
    const adapters = [fakeAdapter('vscode', { failAfterWrite: true })];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations: [operation], context: {} });
    t.assert(result.status === 'ROLLBACK_FAILED', 'restored snapshot cleanup failure is visible as ROLLBACK_FAILED');
    t.assert((await asyncFs.readFile(path)).equals(original), 'snapshot cleanup failure does not obscure verified byte restoration');
    t.assert(
      result.retained_snapshots.length === 1
        && result.retained_snapshots[0].path === path
        && Number.isFinite(Date.parse(result.retained_snapshots[0].retained_until)),
      'restored snapshot cleanup failure reports bounded retained recovery evidence',
    );
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Planned config deletion is deferred until every adapter has verified successfully.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = writeBytes(join(home, 'project', '.mcp.json'), Buffer.from('{"mcpServers":{"uemcp":{}}}\n'));
    const operation = await transactionOperation('claude', path, home, windowsNative, {
      desired_text: '{"mcpServers":{}}\n',
      delete_after_verify: true,
    });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('claude', {
      deferDelete: true,
      beforeVerify: async () => {
        t.assert((await asyncFs.readFile(path, 'utf8')) === '{"mcpServers":{}}\n', 'deferred client config remains present through structural verification');
      },
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    t.assert(result.status === 'APPLIED', 'approved deferred client-config deletion commits with the transaction');
    t.assert(await asyncFs.stat(path).then(() => false, error => error.code === 'ENOENT'), 'approved empty client config is deleted only after verification');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Exact-entry adoption treats provider config as read-only and snapshots only the ownership ledger.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const calls = [];
    const localState = createTestLocalState(root, calls);
    const original = Buffer.from('{"mcpServers":{"uemcp":{"type":"stdio"}}}\n');
    const path = writeBytes(join(home, 'claude.json'), original);
    const fingerprint = await captureClientPathFingerprint(path, {
      allowedRoots: [home], fsImpl: asyncFs, windowsNative, writable: false,
    });
    const operation = await transactionOperation('claude', path, home, windowsNative, {
      operation_id: 'claude-adopt',
      ledger_only: true,
      fingerprint,
    });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('claude', { ledgerValue: { adopted: true } });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const snapshotPaths = calls.filter(call => call.type === 'snapshot').map(call => call.path);
    t.assert(snapshotPaths.length === 1 && snapshotPaths[0] === resolve(localState.paths().ownership), 'ledger-only adoption snapshots no provider config');
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    t.assert(result.status === 'APPLIED' && (await asyncFs.readFile(path)).equals(original), 'ledger-only adoption commits without provider config write access');
    t.assert(result.touched_files.length === 1 && result.touched_files[0].path === resolve(localState.paths().ownership), 'ledger-only adoption reports only ownership state as touched');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// A later adapter failure restores a queued-delete config because commit deletion has not started.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const original = Buffer.from('{"mcpServers":{"uemcp":{}}}\n');
    const claudePath = writeBytes(join(home, 'project', '.mcp.json'), original);
    const codexPath = writeBytes(join(home, 'codex', 'config.toml'), Buffer.from('[mcp_servers.uemcp]\n'));
    const operations = [
      await transactionOperation('claude', claudePath, home, windowsNative, {
        desired_text: '{"mcpServers":{}}\n',
        delete_after_verify: true,
      }),
      await transactionOperation('codex', codexPath, home, windowsNative),
    ];
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapters = [fakeAdapter('claude', { deferDelete: true }), fakeAdapter('codex', { failVerify: true })];
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters, operations, context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters, operations, context: {} });
    t.assert(result.status === 'ROLLED_BACK', 'later adapter failure rolls back before queued deletion');
    t.assert((await asyncFs.readFile(claudePath)).equals(original), 'rollback restores exact queued-delete config bytes');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// An adapter cannot queue deletion unless the reviewed operation declares it.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const original = Buffer.from('{"mcpServers":{"uemcp":{}}}\n');
    const path = writeBytes(join(home, '.mcp.json'), original);
    const operation = await transactionOperation('claude', path, home, windowsNative, {
      desired_text: '{"mcpServers":{}}\n',
    });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('claude', { deferDelete: true });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK' && result.clients[0].error_code === 'UNAPPROVED_DEFERRED_DELETE', 'unplanned deferred deletion is rejected and rolled back');
    t.assert((await asyncFs.readFile(path)).equals(original), 'unplanned deferred deletion preserves original config');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// A newly acquired apply lease clears stages abandoned by an earlier process before snapshotting secrets again.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const stageParent = join(localState.paths().state, 'native-staging');
    const staleStage = join(stageParent, 'abandoned-stage');
    const staleQuarantine = join(localState.paths().state, `.native-staging-${'a'.repeat(24)}.stale`);
    const unrelated = join(localState.paths().state, '.native-staging-not-ours.stale');
    writeBytes(join(staleStage, 'config.json'), Buffer.from('{"secret":"stale"}\n'));
    writeBytes(join(staleQuarantine, 'config.json'), Buffer.from('{"secret":"quarantined"}\n'));
    const unrelatedCanary = writeBytes(join(unrelated, 'keep.txt'), Buffer.from('keep'));
    const path = join(home, 'config.json');
    const operation = await transactionOperation('codex', path, home, windowsNative);
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('codex');
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    t.assert(await asyncFs.stat(stageParent).then(() => false, error => error.code === 'ENOENT'), 'exclusive snapshot cleanup removes every abandoned native stage');
    t.assert(await asyncFs.stat(staleQuarantine).then(() => false, error => error.code === 'ENOENT'), 'exclusive snapshot cleanup removes a quarantine abandoned during prior cleanup');
    t.assert((await asyncFs.readFile(unrelatedCanary, 'utf8')) === 'keep', 'abandoned-stage cleanup preserves similarly named unrelated local state');
    await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
  } finally {
    cleanupTransactionRoot(root);
  }
}

// A linked stale-stage parent is rejected without traversing or deleting its target.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const outside = join(root, 'outside-stage-target');
    const canary = writeBytes(join(outside, 'canary.txt'), Buffer.from('keep'));
    mkdirSync(localState.paths().state, { recursive: true });
    await asyncFs.symlink(outside, join(localState.paths().state, 'native-staging'), 'junction');
    const path = join(home, 'config.json');
    const operation = await transactionOperation('codex', path, home, windowsNative);
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('codex');
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    let code = null;
    try {
      await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
      await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    } catch (error) {
      code = error.code;
    }
    t.assert(code === 'UNSAFE_WRITABLE_PATH', 'linked stale-stage parent fails closed before transaction snapshots');
    t.assert((await asyncFs.readFile(canary, 'utf8')) === 'keep', 'linked stale-stage cleanup never traverses the link target');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// A reviewed staged native write participates in the same touched-file and verification contract.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = join(home, 'config.json');
    const operation = await transactionOperation('codex', path, home, windowsNative, {
      external_write: true,
      desired_text: '{"native":"created"}\n',
    });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('codex');
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    t.assert(result.status === 'APPLIED', 'approved staged native write commits through the client transaction');
    t.assert((await asyncFs.readFile(path, 'utf8')) === operation.desired_text, 'approved staged native write commits the parsed stage bytes');
    t.assert(result.touched_files.some(row => row.path === resolve(path)), 'approved staged native write reports the provider config as touched');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// A native writer that changes its stage and then fails never reaches provider config.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = join(home, 'config.json');
    const operation = await transactionOperation('codex', path, home, windowsNative, {
      external_write: true,
      desired_text: '{"native":"partial"}\n',
    });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('codex', {
      externalMutate: async target => {
        await asyncFs.writeFile(target, Buffer.from(operation.desired_text));
        throw Object.assign(new Error('native process failed after write'), { code: 'NATIVE_WRITE_FAILED' });
      },
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK' && result.rollback.reason_code === 'NATIVE_WRITE_FAILED', 'write-then-fail staged mutation enters verified rollback');
    t.assert(await asyncFs.stat(path).then(() => false, error => error.code === 'ENOENT'), 'write-then-fail staged mutation leaves provider config absent');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// External mutation requires an explicit reviewed operation flag.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = join(home, 'config.json');
    const operation = await transactionOperation('codex', path, home, windowsNative);
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('codex', { useExternalWrite: true });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK' && result.clients[0].error_code === 'UNAPPROVED_EXTERNAL_WRITE', 'unapproved external mutation is rejected with a stable code');
    t.assert(await asyncFs.stat(path).then(() => false, error => error.code === 'ENOENT'), 'unapproved external mutation never invokes the native writer');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// An approved native operation cannot redirect its write capability to another path.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = join(home, 'config.json');
    const otherPath = join(home, 'other.json');
    const operation = await transactionOperation('codex', path, home, windowsNative, { external_write: true });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('codex', { externalPath: otherPath });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK' && result.clients[0].error_code === 'UNAPPROVED_EXTERNAL_WRITE', 'external mutation cannot target an unplanned path');
    t.assert(await asyncFs.stat(otherPath).then(() => false, error => error.code === 'ENOENT'), 'wrong-path rejection happens before invoking the native writer');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Structural failure after a successful staged write leaves provider config untouched.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = join(home, 'config.json');
    const operation = await transactionOperation('codex', path, home, windowsNative, {
      external_write: true,
      desired_text: '{"native":"untrusted-until-parsed"}\n',
    });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('codex', { failStructuralRead: true });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK' && result.rollback.reason_code === 'STRUCTURAL_VERIFY_FAILED', 'staged write is not trusted until parser-backed reread succeeds');
    t.assert(await asyncFs.stat(path).then(() => false, error => error.code === 'ENOENT'), 'failed staged structural reread leaves provider config absent');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Staged native writes can update an existing file only through metadata-preserving replacement.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const original = Buffer.from('{"native":"existing"}\n');
    const path = writeBytes(join(home, 'config.json'), original);
    const operation = await transactionOperation('codex', path, home, windowsNative, { external_write: true });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('codex');
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    t.assert(result.status === 'APPLIED', 'staged native write can commit to an existing reviewed target');
    t.assert((await asyncFs.readFile(path, 'utf8')) === operation.desired_text, 'existing target receives only the parsed staged bytes');
    t.assert(windowsNative.calls.some(call => call.destinationPath === resolve(path)), 'existing staged write uses metadata-preserving replacement');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Any unexpected staged side effect is rejected before provider config can change.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const path = join(home, 'config.json');
    const operation = await transactionOperation('codex', path, home, windowsNative, { external_write: true });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('codex', { extraStageFile: true });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK' && result.clients[0].error_code === 'UNEXPECTED_STAGED_OUTPUT', 'unexpected staged output is rejected with a stable code');
    t.assert(await asyncFs.stat(path).then(() => false, error => error.code === 'ENOENT'), 'unexpected staged output never reaches provider config');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// A native writer cannot hide an undeclared side effect beside its assigned stage root.
{
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    mkdirSync(home, { recursive: true });
    const windowsNative = virtualWindowsMetadata();
    const localState = createTestLocalState(root);
    const stageParent = join(localState.paths().state, 'native-staging');
    const path = join(home, 'config.json');
    const operation = await transactionOperation('codex', path, home, windowsNative, {
      external_write: true,
      desired_text: '{"native":"sibling-output"}\n',
    });
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs, windowsNative,
    });
    const adapter = fakeAdapter('codex', {
      externalMutate: async (target, current, stage) => {
        await asyncFs.writeFile(target, Buffer.from(current.desired_text));
        await asyncFs.writeFile(join(dirname(stage.root), 'undeclared.json'), Buffer.from('{}\n'));
      },
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs, windowsNative });
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const result = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    t.assert(result.status === 'ROLLED_BACK' && result.clients[0].error_code === 'UNEXPECTED_STAGED_OUTPUT', 'sibling staged output is rejected with a stable code');
    t.assert(await asyncFs.stat(path).then(() => false, error => error.code === 'ENOENT'), 'sibling staged output never reaches provider config');
    t.assert(await asyncFs.stat(stageParent).then(() => false, error => error.code === 'ENOENT'), 'sibling staged output is removed with the rejected stage');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// Real Windows replacement preserves an explicit DACL and alternate data stream on apply and rollback.
if (process.platform === 'win32') {
  const root = makeTransactionRoot();
  try {
    const home = join(root, 'client-home');
    const localState = createTestLocalState(root);
    const path = writeBytes(join(home, 'claude.json'), Buffer.from('{"state":"original"}\r\n'));
    const streamPath = `${path}:uemcp-canary`;
    await asyncFs.writeFile(streamPath, Buffer.from('canary-value'));
    await setExplicitTestDacl(path);

    const before = await captureClientPathFingerprint(path, { allowedRoots: [home], fsImpl: asyncFs });
    const operation = await transactionOperation('claude', path, home, undefined);
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs,
    });
    const transaction = createClientTransaction({ localState, fsImpl: asyncFs });
    const adapter = fakeAdapter('claude');
    await transaction.snapshot({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {}, ownershipFingerprint });
    const applied = await transaction.apply({ planDigest: PLAN_DIGEST, adapters: [adapter], operations: [operation], context: {} });
    const afterApply = await captureClientPathFingerprint(path, { allowedRoots: [home], fsImpl: asyncFs });
    t.assert(applied.status === 'APPLIED', `real Windows metadata-preserving apply succeeds (got ${applied.status}, rollback ${applied.rollback?.reason_code ?? 'none'})`);
    t.assert(afterApply.metadata_sha256 === before.metadata_sha256 && (await asyncFs.readFile(streamPath, 'utf8')) === 'canary-value', 'real apply preserves explicit DACL and canary alternate stream');
    t.assert(!(await asyncFs.readdir(home)).some(name => name.endsWith('.uemcp-backup') || name.endsWith('.uemcp-write')), 'real apply leaves no replacement or backup artifact');

    const appliedBytes = await asyncFs.readFile(path);
    const appliedStat = await asyncFs.lstat(path);
    const rollbackOperation = await transactionOperation('claude', path, home, undefined, {
      operation_id: 'claude-rollback-write',
      desired_text: '{"state":"second-write"}\n',
    });
    const rollbackOwnership = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state], fsImpl: asyncFs,
    });
    const rollbackTransaction = createClientTransaction({ localState, fsImpl: asyncFs });
    const failingAdapter = fakeAdapter('claude', { failAfterWrite: true });
    await rollbackTransaction.snapshot({
      planDigest: PLAN_DIGEST,
      adapters: [failingAdapter],
      operations: [rollbackOperation],
      context: {},
      ownershipFingerprint: rollbackOwnership,
    });
    const rolledBack = await rollbackTransaction.apply({
      planDigest: PLAN_DIGEST,
      adapters: [failingAdapter],
      operations: [rollbackOperation],
      context: {},
    });
    const afterRollback = await captureClientPathFingerprint(path, { allowedRoots: [home], fsImpl: asyncFs });
    t.assert(rolledBack.status === 'ROLLED_BACK' && (await asyncFs.readFile(path)).equals(appliedBytes), 'real Windows rollback restores exact prior default-stream bytes');
    t.assert(afterRollback.metadata_sha256 === before.metadata_sha256 && (await asyncFs.readFile(streamPath, 'utf8')) === 'canary-value', 'real rollback preserves explicit DACL and canary alternate stream');
    const restoredStat = await asyncFs.lstat(path);
    t.assert(Math.abs(restoredStat.mtimeMs - appliedStat.mtimeMs) <= 2 && restoredStat.mode === appliedStat.mode, 'real rollback restores prior mutable timestamp and mode');
    t.assert(!(await asyncFs.readdir(home)).some(name => name.endsWith('.uemcp-backup') || name.endsWith('.uemcp-rollback')), 'real rollback leaves no replacement or backup artifact');
  } finally {
    cleanupTransactionRoot(root);
  }
}

// External lease reuse is a live local-state capability, not a shape-only bypass.
for (const leaseCase of ['fabricated', 'released']) {
  const root = makeTransactionRoot();
  try {
    const calls = [];
    const home = join(root, 'client-home');
    const localState = createTestLocalState(root, calls);
    const path = writeBytes(join(home, 'claude.json'), Buffer.from('{"state":"original"}\n'));
    const windowsNative = virtualWindowsMetadata();
    const operation = await transactionOperation('claude', path, home, windowsNative);
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state],
      fsImpl: asyncFs,
      windowsNative,
    });
    let externalLease;
    if (leaseCase === 'fabricated') {
      externalLease = { ownerToken: 'f'.repeat(48), async release() {} };
    } else {
      externalLease = await localState.acquireApplyLease({ waitMs: 0 });
      await externalLease.release();
    }
    const transaction = createClientTransaction({
      localState,
      fsImpl: asyncFs,
      windowsNative,
      externalLease,
    });
    const adapter = fakeAdapter('claude');
    t.assert(await rejectsCode(() => transaction.snapshot({
      planDigest: PLAN_DIGEST,
      adapters: [adapter],
      operations: [operation],
      context: {},
      ownershipFingerprint,
    }), 'LEASE_OWNER_MISMATCH'), `${leaseCase} external lease cannot bypass local apply serialization`);
    t.assert(calls.filter(call => call.type === 'snapshot').length === 0, `${leaseCase} external lease is rejected before snapshots`);
  } finally {
    cleanupTransactionRoot(root);
  }
}

// A transaction nested under the orchestrator's lease must not reacquire or release that lease.
{
  const root = makeTransactionRoot();
  try {
    const calls = [];
    const home = join(root, 'client-home');
    const localState = createTestLocalState(root, calls);
    const path = writeBytes(join(home, 'claude.json'), Buffer.from('{"state":"original"}\n'));
    const windowsNative = virtualWindowsMetadata();
    const operation = await transactionOperation('claude', path, home, windowsNative);
    const ownershipFingerprint = await captureClientPathFingerprint(localState.paths().ownership, {
      allowedRoots: [localState.paths().state],
      fsImpl: asyncFs,
      windowsNative,
    });
    const outerLease = await localState.acquireApplyLease({ waitMs: 0 });
    const transaction = createClientTransaction({
      localState,
      fsImpl: asyncFs,
      windowsNative,
      externalLease: outerLease,
    });
    const adapter = fakeAdapter('claude');
    await transaction.snapshot({
      planDigest: PLAN_DIGEST,
      adapters: [adapter],
      operations: [operation],
      context: {},
      ownershipFingerprint,
    });
    const result = await transaction.apply({
      planDigest: PLAN_DIGEST,
      adapters: [adapter],
      operations: [operation],
      context: {},
    });
    t.assert(result.status === 'APPLIED', 'externally leased transaction applies successfully');
    t.assert(calls.filter(call => call.type === 'lease').length === 1, 'externally leased transaction does not reacquire the apply lease');
    t.assert(calls.filter(call => call.type === 'lease-release').length === 0, 'transaction cleanup does not release the orchestrator lease');
    await outerLease.release();
    t.assert(calls.filter(call => call.type === 'lease-release').length === 1, 'outer lease owner remains responsible for release');
  } finally {
    cleanupTransactionRoot(root);
  }
}

process.exitCode = t.summary();
