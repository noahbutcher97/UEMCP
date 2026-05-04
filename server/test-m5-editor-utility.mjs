// Tests for M5-editor-utility — 6 security-sensitive editor-utility tools on TCP:55558.
//
// Companion to docs/handoffs/m5-editor-utility.md (D101 (iv) security model).
// Mirrors test-m3-actors.mjs structure plus security-path coverage:
//   - Layer 1 PYTHON_EXEC_DISABLED gate (server-side, fires before wire dispatch)
//   - Layer 2 PYTHON_EXEC_DENY_LIST (plugin-side; tested via wire-mock returning the typed error)
//   - delete_asset_safe decision matrix (5 rows including BAD_PARAMS for permanent w/o force)
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-m5-editor-utility.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import {
  initM5EditorUtilityTools,
  executeM5EditorUtilityTool,
  getM5EditorUtilityToolDefs,
  M5_EDITOR_UTILITY_SCHEMAS,
  _isPythonExecEnabledForTests,
} from './m5-editor-utility-tools.mjs';

// ── Initialize wire-type map from a fake YAML structure ──────────
// Identity wire types — yaml editor-utility section currently declares
// no wire_type overrides.
const fakeToolsYaml = {
  toolsets: {
    'editor-utility': {
      tools: {
        run_python_command:           {},
        get_editor_utility_blueprint: {},
        run_editor_utility:           {},
        duplicate_asset:              {},
        rename_asset:                 {},
        delete_asset_safe:            {},
      },
    },
  },
};

const t = new TestRunner('M5-editor-utility — TCP:55558 security-sensitive toolset');

// ═══════════════════════════════════════════════════════════════
// Group 1: Tool definition completeness
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 1: Tool Definitions ──');

initM5EditorUtilityTools(fakeToolsYaml, { pythonExecEnabled: false });

const defs = getM5EditorUtilityToolDefs();
const expectedTools = [
  'run_python_command',
  'get_editor_utility_blueprint',
  'run_editor_utility',
  'duplicate_asset',
  'rename_asset',
  'delete_asset_safe',
];

t.assert(Object.keys(defs).length === 6, '6 editor-utility tools defined');
t.assert(defs === M5_EDITOR_UTILITY_SCHEMAS, 'getM5EditorUtilityToolDefs returns M5_EDITOR_UTILITY_SCHEMAS');

for (const name of expectedTools) {
  t.assert(defs[name] !== undefined, `Tool "${name}" is defined`);
  t.assert(typeof defs[name].description === 'string' && defs[name].description.length > 0,
    `Tool "${name}" has a non-empty description`);
  t.assert(typeof defs[name].schema === 'object', `Tool "${name}" has a schema object`);
  t.assert(typeof defs[name].isReadOp === 'boolean', `Tool "${name}" has isReadOp flag`);
}

// Read/write classification — 1 read, 5 writes
t.assert(defs.get_editor_utility_blueprint.isReadOp === true, 'get_editor_utility_blueprint is a read op');
t.assert(defs.run_python_command.isReadOp === false, 'run_python_command is a write op (could mutate via Python)');
t.assert(defs.run_editor_utility.isReadOp === false, 'run_editor_utility is a write op (Run() side effects)');
t.assert(defs.duplicate_asset.isReadOp === false, 'duplicate_asset is a write op');
t.assert(defs.rename_asset.isReadOp === false, 'rename_asset is a write op');
t.assert(defs.delete_asset_safe.isReadOp === false, 'delete_asset_safe is a write op');

// Description carries the security signal — caller-visible without reading code.
t.assert(defs.run_python_command.description.includes('SECURITY-SENSITIVE'),
  'run_python_command description flags SECURITY-SENSITIVE');
t.assert(defs.run_python_command.description.includes('--enable-python-exec'),
  'run_python_command description names the flag');
t.assert(defs.delete_asset_safe.description.includes('SECURITY-SENSITIVE'),
  'delete_asset_safe description flags SECURITY-SENSITIVE');

// ═══════════════════════════════════════════════════════════════
// Group 2: Layer 1 gate — PYTHON_EXEC_DISABLED (server-side, no wire dispatch)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 2: Layer 1 Gate — PYTHON_EXEC_DISABLED ──');

// Default: gate is OFF.
{
  initM5EditorUtilityTools(fakeToolsYaml);  // No options arg → defaults to disabled
  t.assert(_isPythonExecEnabledForTests() === false,
    'Default state: pythonExecEnabled=false (no opt-in)');
}

{
  initM5EditorUtilityTools(fakeToolsYaml, { pythonExecEnabled: false });
  t.assert(_isPythonExecEnabledForTests() === false,
    'Explicit pythonExecEnabled:false → gate stays off');

  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  // Register a wire response so we can confirm it's NEVER called.
  fake.on('run_python_command', { status: 'success', result: { success: true } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const result = await executeM5EditorUtilityTool('run_python_command',
    { command: 'print("hello")' }, cm);

  t.assert(result.code === 'PYTHON_EXEC_DISABLED',
    'Returns code=PYTHON_EXEC_DISABLED when gate is off');
  t.assert(result.status === 'error',
    'Returns status=error');
  t.assert(typeof result.error === 'string' && result.error.includes('--enable-python-exec'),
    'Error message names the --enable-python-exec flag');
  t.assert(fake.lastCall('run_python_command') === undefined,
    'PYTHON_EXEC_DISABLED short-circuits BEFORE wire dispatch — no plugin call');
  t.assert(fake.calls.length === 0,
    'Zero wire calls made (gate fires pre-flight)');
}

// Gate ON → call reaches the wire.
{
  initM5EditorUtilityTools(fakeToolsYaml, { pythonExecEnabled: true });
  t.assert(_isPythonExecEnabledForTests() === true,
    'pythonExecEnabled:true → gate opens');

  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('run_python_command', {
    status: 'success',
    result: { success: true, output: '', script_hash: 'abcdef0123456789' },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const result = await executeM5EditorUtilityTool('run_python_command',
    { command: 'print("hello")' }, cm);

  t.assert(result.status === 'success',
    'Gate ON + safe script + plugin success → status=success');
  t.assert(result.result.success === true, 'Plugin success field propagates');
  t.assert(fake.lastCall('run_python_command') !== undefined,
    'Wire dispatch occurred');
  t.assert(fake.lastCall('run_python_command').port === 55558,
    'Routed to TCP:55558');
}

// ═══════════════════════════════════════════════════════════════
// Group 3: Layer 2 — PYTHON_EXEC_DENY_LIST plugin-side responses
// ═══════════════════════════════════════════════════════════════
//
// The deny-list scan happens in EditorUtilityHandlers.cpp (plugin C++);
// the wire-mock returns the typed error so we verify the JS executor
// propagates the response correctly. We test all 6 deny-list patterns
// to lock down the contract surface.

console.log('\n── Group 3: Layer 2 — PYTHON_EXEC_DENY_LIST propagation ──');

const denyPatterns = [
  ['import os',         'import os; print(\'pwned\')'],
  ['import subprocess', 'import subprocess; subprocess.run([\'ls\'])'],
  ['__import__',        '__import__(\'os\').system(\'ls\')'],
  ['eval(',             'eval(\'__import__("os").system("ls")\')'],
  ['exec(',             'exec(\'import os\')'],
  ['open(',             'open(\'/etc/passwd\').read()'],
];

{
  initM5EditorUtilityTools(fakeToolsYaml, { pythonExecEnabled: true });

  for (const [pattern, script] of denyPatterns) {
    const fake = new FakeTcpResponder().on('ping', { status: 'success' });
    // ConnectionManager.send wraps Bridge-format errors into thrown Errors;
    // the matched_pattern detail is consumable by callers via err.message.
    fake.on('run_python_command', {
      status: 'error',
      error: `Script matches deny-list pattern "${pattern}" — refusing to execute`,
      code: 'PYTHON_EXEC_DENY_LIST',
      detail: { matched_pattern: pattern, script_hash: 'deadbeef01234567' },
    });

    const { config } = createTestConfig('D:/FakeProject', fake);
    const cm = new ConnectionManager(config);

    await t.assertRejects(
      () => executeM5EditorUtilityTool('run_python_command', { command: script }, cm),
      `deny-list pattern "${pattern}"`,
      `Pattern "${pattern}" surfaces deny-list rejection through JS executor`,
    );
    // Confirm the request DID reach the wire (Layer 1 was open; Layer 2 fires plugin-side).
    t.assert(fake.lastCall('run_python_command') !== undefined,
      `Pattern "${pattern}" reached wire (Layer 1 passed, Layer 2 fired)`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Group 4: Port routing — every tool dispatches to TCP:55558
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 4: Port Routing → 55558 ──');

{
  initM5EditorUtilityTools(fakeToolsYaml, { pythonExecEnabled: true });
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('run_python_command',
    { status: 'success', result: { success: true, output: '', script_hash: 'h' } });
  fake.on('get_editor_utility_blueprint',
    { status: 'success', result: { asset_path: '/Game/EUW', bp_type: 'EditorUtilityWidget', run_method: { present: true } } });
  fake.on('run_editor_utility',
    { status: 'success', result: { invoked: true, function: 'Run' } });
  fake.on('duplicate_asset',
    { status: 'success', result: { new_path: '/Game/Copy', class: 'StaticMesh' } });
  fake.on('rename_asset',
    { status: 'success', result: { renamed: true, dest_path: '/Game/Renamed' } });
  fake.on('delete_asset_safe',
    { status: 'success', result: { mode: 'soft', trash_path: '/Game/_Deleted/X', deleted: true, num_referencers: 0, warnings: [] } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const checks = [
    ['run_python_command',           { command: 'pass' }],
    ['get_editor_utility_blueprint', { asset_path: '/Game/EUW' }],
    ['run_editor_utility',           { asset_path: '/Game/EUW' }],
    ['duplicate_asset',              { source_path: '/Game/A', dest_path: '/Game/B' }],
    ['rename_asset',                 { asset_path: '/Game/A', new_name: 'B' }],
    ['delete_asset_safe',            { asset_path: '/Game/A' }],
  ];

  for (const [tool, args] of checks) {
    await executeM5EditorUtilityTool(tool, args, cm);
    const call = fake.lastCall(tool);
    t.assert(call !== undefined, `${tool} reaches wire`);
    t.assert(call.port === 55558, `${tool} routed to TCP:55558 — got ${call.port}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Group 5: Wire-type translation — identity fallback (no overrides in yaml)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 5: Wire-type Translation (Identity) ──');

{
  // Empty wire-map → identity for all tools.
  initM5EditorUtilityTools({ toolsets: {} }, { pythonExecEnabled: true });

  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('duplicate_asset',
    { status: 'success', result: { new_path: '/Game/B', class: 'StaticMesh' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeM5EditorUtilityTool('duplicate_asset',
    { source_path: '/Game/A', dest_path: '/Game/B' }, cm);
  t.assert(fake.lastCall('duplicate_asset') !== undefined,
    'Identity wire-type fallback used when no wire_type in yaml');

  initM5EditorUtilityTools(fakeToolsYaml, { pythonExecEnabled: true });
}

// ═══════════════════════════════════════════════════════════════
// Group 6: delete_asset_safe — decision matrix (5 rows)
// ═══════════════════════════════════════════════════════════════
//
// Matrix (locked in EditorUtilityHandlers.cpp comment):
//   Row 1: force=F, perm=F, mtt=T, deps>0  → ASSET_HAS_DEPENDENCIES
//   Row 2: force=F, perm=F, mtt=T, deps=0  → soft delete
//   Row 3: force=T, perm=F, mtt=T          → soft delete + warning
//   Row 4: force=T, perm=T                 → hard delete + warning
//   Row 5: force=F, perm=T                 → BAD_PARAMS

console.log('\n── Group 6: delete_asset_safe Decision Matrix ──');

initM5EditorUtilityTools(fakeToolsYaml, { pythonExecEnabled: true });

// Row 1: dependencies present, force:false → ASSET_HAS_DEPENDENCIES
{
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('delete_asset_safe', {
    status: 'error',
    error: 'Asset has 3 referencer(s); pass force:true to delete anyway',
    code: 'ASSET_HAS_DEPENDENCIES',
    detail: {
      referencers: ['/Game/User1', '/Game/User2', '/Game/User3'],
      num_referencers: 3,
    },
  });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);
  // ConnectionManager surfaces the wire `error` text (not the `code` field) in
  // the thrown Error. Match on the message phrasing — callers branching on the
  // code field can read it from the response when status:'error' is returned
  // without throw, but ConnectionManager throws on Bridge-format errors.
  await t.assertRejects(
    () => executeM5EditorUtilityTool('delete_asset_safe',
      { asset_path: '/Game/Shared' }, cm),
    'has 3 referencer',
    'Row 1: deps>0 + force:false → ASSET_HAS_DEPENDENCIES surfaces',
  );
  // Verify the request reached the wire with default soft-delete params.
  const call = fake.lastCall('delete_asset_safe');
  t.assert(call.params.asset_path === '/Game/Shared', 'asset_path passed through');
  t.assert(call.params.force === false, 'force defaults to false');
  t.assert(call.params.permanent === false, 'permanent defaults to false');
  t.assert(call.params.move_to_trash === true, 'move_to_trash defaults to true');
}

// Row 2: no dependencies, default soft-delete → success path
{
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('delete_asset_safe', {
    status: 'success',
    result: {
      asset_path:      '/Game/Orphan',
      mode:            'soft',
      trash_path:      '/Game/_Deleted/Orphan_abcdef01',
      deleted:         true,
      num_referencers: 0,
      warnings:        [],
    },
  });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);
  const r = await executeM5EditorUtilityTool('delete_asset_safe',
    { asset_path: '/Game/Orphan' }, cm);
  t.assert(r.status === 'success', 'Row 2: deps=0 default → success');
  t.assert(r.result.mode === 'soft', 'Soft-delete mode reported');
  t.assert(r.result.trash_path.startsWith('/Game/_Deleted/'),
    'trash_path lives under /Game/_Deleted/');
  t.assert(r.result.warnings.length === 0,
    'No warnings on clean soft-delete (no deps, no permanent)');
}

// Row 3: force:true with dependencies → soft delete + warning
{
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('delete_asset_safe', {
    status: 'success',
    result: {
      asset_path:      '/Game/Shared',
      mode:            'soft',
      trash_path:      '/Game/_Deleted/Shared_aabbccdd',
      deleted:         true,
      num_referencers: 2,
      warnings: [
        'Force-deleted with 2 referencer(s); references will become broken',
      ],
    },
  });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);
  const r = await executeM5EditorUtilityTool('delete_asset_safe',
    { asset_path: '/Game/Shared', force: true }, cm);
  t.assert(r.status === 'success', 'Row 3: force:true with deps → success');
  t.assert(r.result.mode === 'soft', 'Soft-delete still default mode');
  t.assert(r.result.warnings.length === 1, 'Warning emitted for forced delete');
  t.assert(r.result.warnings[0].includes('Force-deleted'),
    'Warning text mentions Force-deleted');
}

// Row 4: permanent:true + force:true → hard delete + warning
{
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('delete_asset_safe', {
    status: 'success',
    result: {
      asset_path:      '/Game/Garbage',
      mode:            'permanent',
      deleted:         true,
      num_referencers: 0,
      warnings: ['Permanent delete — asset cannot be recovered from /Game/_Deleted/'],
    },
  });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);
  const r = await executeM5EditorUtilityTool('delete_asset_safe',
    { asset_path: '/Game/Garbage', force: true, permanent: true }, cm);
  t.assert(r.status === 'success', 'Row 4: force+permanent → success');
  t.assert(r.result.mode === 'permanent', 'Hard-delete mode reported');
  t.assert(r.result.warnings.some(w => w.includes('Permanent')),
    'Warning text mentions Permanent delete');
}

// Row 5: permanent:true + force:false → BAD_PARAMS (server-side schema OR plugin-side enforcement)
{
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('delete_asset_safe', {
    status: 'error',
    error: 'permanent:true delete requires force:true acknowledgement',
    code: 'BAD_PARAMS',
  });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);
  await t.assertRejects(
    () => executeM5EditorUtilityTool('delete_asset_safe',
      { asset_path: '/Game/Anything', permanent: true }, cm),
    'permanent:true delete requires force:true',
    'Row 5: permanent without force → BAD_PARAMS surfaces from plugin',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 7: Schema validation — required-field enforcement
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 7: Schema Validation ──');

{
  initM5EditorUtilityTools(fakeToolsYaml, { pythonExecEnabled: true });
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('duplicate_asset', { status: 'success', result: { new_path: '/Game/B' } });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Missing required dest_path
  await t.assertRejects(
    () => executeM5EditorUtilityTool('duplicate_asset', { source_path: '/Game/A' }, cm),
    /dest_path|Required/,
    'duplicate_asset missing dest_path → Zod rejects',
  );

  // Wrong type (boolean for source_path)
  await t.assertRejects(
    () => executeM5EditorUtilityTool('duplicate_asset',
      { source_path: true, dest_path: '/Game/B' }, cm),
    /Expected string|source_path/,
    'duplicate_asset source_path:boolean → Zod rejects',
  );
}

// PYTHON_EXEC_DISABLED short-circuits BEFORE Zod — security signal preferred.
{
  initM5EditorUtilityTools(fakeToolsYaml, { pythonExecEnabled: false });
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Pass a malformed request (missing required `command`) — would normally
  // throw a Zod error. With gate off, we get PYTHON_EXEC_DISABLED instead
  // (caller sees the security signal, not the schema noise).
  const r = await executeM5EditorUtilityTool('run_python_command', {}, cm);
  t.assert(r.code === 'PYTHON_EXEC_DISABLED',
    'PYTHON_EXEC_DISABLED takes precedence over Zod schema errors');
}

// ═══════════════════════════════════════════════════════════════
// Group 8: Caching — write ops bypass ResultCache
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 8: Cache Semantics ──');

{
  initM5EditorUtilityTools(fakeToolsYaml, { pythonExecEnabled: true });

  // get_editor_utility_blueprint is the only read op — should cache repeat calls.
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('get_editor_utility_blueprint',
    { status: 'success', result: { asset_path: '/Game/EUW', bp_type: 'EditorUtilityWidget' } });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeM5EditorUtilityTool('get_editor_utility_blueprint',
    { asset_path: '/Game/EUW' }, cm);
  await executeM5EditorUtilityTool('get_editor_utility_blueprint',
    { asset_path: '/Game/EUW' }, cm);
  t.assert(fake.callsFor('get_editor_utility_blueprint').length === 1,
    'Read op cached: 2 calls → 1 wire dispatch');
}

{
  initM5EditorUtilityTools(fakeToolsYaml, { pythonExecEnabled: true });

  // delete_asset_safe is a write op — should NEVER cache.
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('delete_asset_safe', {
    status: 'success',
    result: { mode: 'soft', deleted: true, num_referencers: 0, warnings: [] },
  });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeM5EditorUtilityTool('delete_asset_safe', { asset_path: '/Game/A' }, cm);
  await executeM5EditorUtilityTool('delete_asset_safe', { asset_path: '/Game/A' }, cm);
  t.assert(fake.callsFor('delete_asset_safe').length === 2,
    'Write op never caches: 2 calls → 2 wire dispatches');
}

// ═══════════════════════════════════════════════════════════════
// Group 9: Per-tool TCP timeout overrides (D125 / NEW-7)
// ═══════════════════════════════════════════════════════════════
//
// Asset-management ops (rename / delete / duplicate) exceed the 5s default
// (D125: rename 5238-6474ms, delete 2654-5489ms, duplicate 3641-3814ms).
// They get a 15s override applied via sendOpts.timeoutMs. FakeTcpResponder
// records the per-call timeoutMs in `calls[i].timeoutMs`, so we can assert
// the override propagated to the wire. Other tools must NOT carry the
// override — verifies the table is keyed and that the override doesn't
// leak across calls within the same ConnectionManager.

console.log('\n── Group 9: Per-tool TCP timeout overrides (NEW-7) ──');

{
  initM5EditorUtilityTools(fakeToolsYaml, { pythonExecEnabled: true });
  const fake = new FakeTcpResponder().on('ping', { status: 'success' });
  fake.on('duplicate_asset',
    { status: 'success', result: { new_path: '/Game/B', class: 'StaticMesh' } });
  fake.on('rename_asset',
    { status: 'success', result: { renamed: true, dest_path: '/Game/Renamed' } });
  fake.on('delete_asset_safe',
    { status: 'success', result: { mode: 'soft', deleted: true, num_referencers: 0, warnings: [] } });
  fake.on('get_editor_utility_blueprint',
    { status: 'success', result: { asset_path: '/Game/EUW', bp_type: 'EditorUtilityWidget' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Each asset-mgmt tool carries the 15s override.
  await executeM5EditorUtilityTool('duplicate_asset',
    { source_path: '/Game/A', dest_path: '/Game/B' }, cm);
  t.assert(fake.lastCall('duplicate_asset').timeoutMs === 15_000,
    'duplicate_asset wire call carries timeoutMs=15000 override');

  await executeM5EditorUtilityTool('rename_asset',
    { asset_path: '/Game/A', new_name: 'B' }, cm);
  t.assert(fake.lastCall('rename_asset').timeoutMs === 15_000,
    'rename_asset wire call carries timeoutMs=15000 override');

  await executeM5EditorUtilityTool('delete_asset_safe',
    { asset_path: '/Game/A' }, cm);
  t.assert(fake.lastCall('delete_asset_safe').timeoutMs === 15_000,
    'delete_asset_safe wire call carries timeoutMs=15000 override');

  // Non-asset-mgmt tool → falls back to config.tcpTimeoutMs (5000ms default).
  await executeM5EditorUtilityTool('get_editor_utility_blueprint',
    { asset_path: '/Game/EUW' }, cm);
  t.assert(fake.lastCall('get_editor_utility_blueprint').timeoutMs === 5000,
    'get_editor_utility_blueprint uses default 5s timeout (no override)');

  // Regression: override does not leak across calls. Run an asset-mgmt op,
  // then a non-overridden op — the second call must see the default again.
  await executeM5EditorUtilityTool('rename_asset',
    { asset_path: '/Game/C', new_name: 'D' }, cm);
  await executeM5EditorUtilityTool('get_editor_utility_blueprint',
    { asset_path: '/Game/EUW2' }, cm);
  t.assert(fake.lastCall('rename_asset').timeoutMs === 15_000,
    'Regression: rename_asset retained 15s override on second call');
  t.assert(fake.lastCall('get_editor_utility_blueprint').timeoutMs === 5000,
    'Regression: subsequent get_editor_utility_blueprint reverts to 5s default — override does not leak');
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

const failed = t.summary();
process.exit(failed > 0 ? 1 : 0);
