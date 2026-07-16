// Current-config-bound ownership, adoption, and physical-location tests.
//
// Run: cd server && node test-client-transaction.mjs

import { TestRunner } from './test-helpers.mjs';
import { sha256Canonical } from './deployment/canonical-json.mjs';
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

process.exitCode = t.summary();
