// Tests for M5-animation — 3 montage-mutation tools live on TCP:55558.
//
// Companion to docs/handoffs/m5-animation-materials.md. Mirrors the
// test-m3-actors.mjs shape. Coverage:
//   - Tool definition completeness (3 tools — get_audio_asset_info SUPERSEDED)
//   - Port routing → 55558
//   - Wire-type identity (no wire_type: in tools.yaml for these)
//   - P0-9 / P0-10 defense-in-depth Zod validation
//   - isReadOp = false for all 3 (writes skip cache)
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-m5-animation.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import {
  initM5AnimationTools,
  executeM5AnimationTool,
  getM5AnimationToolDefs,
  M5_ANIMATION_SCHEMAS,
} from './m5-animation-tools.mjs';

// ── Initialize wire_type maps from a fake YAML structure ──────────
// All 3 tools use identity wire-types (no wire_type: field in tools.yaml).
const fakeToolsYaml = {
  toolsets: {
    animation: {
      tools: {
        create_montage:      {},
        add_montage_section: {},
        add_montage_notify:  {},
      },
    },
  },
};
initM5AnimationTools(fakeToolsYaml);

const t = new TestRunner('M5-animation — TCP:55558 montage mutations');

// ═══════════════════════════════════════════════════════════════
// Group 1: Tool definition completeness
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 1: Tool Definitions ──');

const defs = getM5AnimationToolDefs();
const expectedTools = ['create_montage', 'add_montage_section', 'add_montage_notify'];

t.assert(Object.keys(defs).length === 3,
  `3 animation mutation tools defined (got ${Object.keys(defs).length})`);
t.assert(defs === M5_ANIMATION_SCHEMAS, 'getM5AnimationToolDefs returns M5_ANIMATION_SCHEMAS');

// SUPERSEDED disposition for get_audio_asset_info — not a registered tool
t.assert(defs.get_audio_asset_info === undefined,
  'get_audio_asset_info NOT shipped (SUPERSEDED-as-offline per D101 (v))');

for (const name of expectedTools) {
  t.assert(defs[name] !== undefined, `Tool "${name}" is defined`);
  t.assert(typeof defs[name].description === 'string' && defs[name].description.length > 0,
    `Tool "${name}" has non-empty description`);
  t.assert(typeof defs[name].schema === 'object', `Tool "${name}" has schema object`);
  t.assert(typeof defs[name].isReadOp === 'boolean', `Tool "${name}" has isReadOp flag`);
  t.assert(defs[name].isReadOp === false, `Tool "${name}" is a write op`);
}

// ═══════════════════════════════════════════════════════════════
// Group 2: Port routing — every tool dispatches to TCP:55558
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 2: Port Routing → 55558 ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_montage', {
    status: 'success',
    result: {
      name: 'AM_Test', path: '/Game/Animations/AM_Test',
      anim_sequence: '/Game/Anims/A_Test.A_Test',
      skeleton: '/Game/Skel/SK_Hero.SK_Hero', length: 1.5,
    },
  });
  fake.on('add_montage_section', {
    status: 'success',
    result: { asset_path: '/Game/Animations/AM_Test', section_name: 'Hit', time: 0.5, section_count: 2 },
  });
  fake.on('add_montage_notify', {
    status: 'success',
    result: { asset_path: '/Game/Animations/AM_Test', notify_class: 'AnimNotify_PlaySound', time: 0.25, is_stateful: false, notify_count: 1 },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const checks = [
    ['create_montage',      { name: 'AM_Test', anim_sequence: '/Game/Anims/A_Test' }, 'create_montage'],
    ['add_montage_section', { asset_path: '/Game/Animations/AM_Test', section_name: 'Hit', time: 0.5 }, 'add_montage_section'],
    ['add_montage_notify',  { asset_path: '/Game/Animations/AM_Test', notify_class: 'AnimNotify_PlaySound', time: 0.25 }, 'add_montage_notify'],
  ];

  for (const [tool, args, wireType] of checks) {
    await executeM5AnimationTool(tool, args, cm);
    const call = fake.lastCall(wireType);
    t.assert(call !== undefined, `${tool} reaches wire (type=${wireType})`);
    t.assert(call.port === 55558, `${tool} routed to TCP:55558 — got ${call.port}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Group 3: Param pass-through (identity wire types)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 3: Params Pass Through Unchanged ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_montage', { status: 'success', result: {} });
  fake.on('add_montage_section', { status: 'success', result: {} });
  fake.on('add_montage_notify', { status: 'success', result: {} });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // create_montage with optional path
  await executeM5AnimationTool('create_montage', {
    name: 'AM_Combo', anim_sequence: '/Game/Anims/A_Combo.A_Combo', path: '/Game/Combat',
  }, cm);
  let call = fake.lastCall('create_montage');
  t.assert(call.params.name === 'AM_Combo', 'create_montage forwards name');
  t.assert(call.params.anim_sequence === '/Game/Anims/A_Combo.A_Combo',
    'create_montage forwards anim_sequence');
  t.assert(call.params.path === '/Game/Combat', 'create_montage forwards optional path');

  // add_montage_section with float time
  await executeM5AnimationTool('add_montage_section', {
    asset_path: '/Game/Animations/AM_Combo', section_name: 'Recover', time: 1.25,
  }, cm);
  call = fake.lastCall('add_montage_section');
  t.assert(call.params.section_name === 'Recover', 'add_montage_section forwards section_name');
  t.assert(call.params.time === 1.25, 'add_montage_section forwards floating time');

  // add_montage_notify with notify_class
  await executeM5AnimationTool('add_montage_notify', {
    asset_path: '/Game/Animations/AM_Combo', notify_class: 'AnimNotifyState_Trail', time: 0.0,
  }, cm);
  call = fake.lastCall('add_montage_notify');
  t.assert(call.params.notify_class === 'AnimNotifyState_Trail',
    'add_montage_notify forwards notify_class');
  t.assert(call.params.time === 0.0, 'add_montage_notify forwards time=0');
}

// ═══════════════════════════════════════════════════════════════
// Group 4: Zod validation rejects malformed args
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 4: Zod Validation Bites ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    async () => executeM5AnimationTool('create_montage', { name: 'AM_X' /* missing anim_sequence */ }, cm),
    /anim_sequence/i,
    'create_montage rejects missing anim_sequence'
  );

  await t.assertRejects(
    async () => executeM5AnimationTool('add_montage_section', {
      asset_path: '/Game/X', section_name: 'S' /* missing time */,
    }, cm),
    /time|required|invalid_type/i,
    'add_montage_section rejects missing time'
  );

  await t.assertRejects(
    async () => executeM5AnimationTool('add_montage_notify', {
      asset_path: '/Game/X', time: 0.5 /* missing notify_class */,
    }, cm),
    /notify_class|required|invalid_type/i,
    'add_montage_notify rejects missing notify_class'
  );

  await t.assertRejects(
    async () => executeM5AnimationTool('add_montage_section', {
      asset_path: '/Game/X', section_name: 'S', time: 'not-a-number',
    }, cm),
    /number|invalid_type/i,
    'add_montage_section rejects string time'
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 5: Unknown tool → typed error envelope
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 5: Unknown Tool Returns not_implemented Envelope ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // get_audio_asset_info was SUPERSEDED — calling through M5 dispatch
  // returns the not_implemented stub envelope (not a Zod throw).
  const res = await executeM5AnimationTool('get_audio_asset_info', { asset_path: '/Game/X' }, cm);
  t.assert(res.status === 'error', 'SUPERSEDED tool returns error envelope');
  t.assert(res.code === 'not_implemented', 'envelope code = not_implemented');
  t.assert(/not yet shipped/i.test(res.error), 'envelope error message identifies stub');
}

// ═══════════════════════════════════════════════════════════════
// Group 6: Write-op skipCache discipline
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 6: Write Ops Skip Cache ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_montage', { status: 'success', result: { name: 'AM_X' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Two identical write calls — both must hit wire (no caching)
  await executeM5AnimationTool('create_montage', {
    name: 'AM_X', anim_sequence: '/Game/Anims/A.A',
  }, cm);
  await executeM5AnimationTool('create_montage', {
    name: 'AM_X', anim_sequence: '/Game/Anims/A.A',
  }, cm);
  const calls = fake.callsFor('create_montage');
  t.assert(calls.length === 2, `create_montage skipCache=true (both calls reached wire, got ${calls.length})`);
}

// ═══════════════════════════════════════════════════════════════
// Group 7: Wire-type-map empty → identity fallback
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 7: Empty Wire Map → Identity Fallback ──');

{
  initM5AnimationTools({ toolsets: {} });

  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_montage', { status: 'success', result: {} });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeM5AnimationTool('create_montage', {
    name: 'AM_Y', anim_sequence: '/Game/Anims/B.B',
  }, cm);
  t.assert(fake.lastCall('create_montage') !== undefined,
    'Empty wire map: tool name used as-is (identity)');

  initM5AnimationTools(fakeToolsYaml);  // restore for any further tests
}

// ═══════════════════════════════════════════════════════════════
// Group 8: NEW-1 regression — create_montage response carries
// slot_count and the JS layer round-trips it. Wire-mock validates
// the contract at the JS boundary; the actual assertion that the
// editor-built UAnimMontage has SlotAnimTracks.Num() == 1 is
// covered LIVE-FIRE-only in docs/handoffs/post-m5-deployment-smoke.md
// §2.1 (single-DefaultSlot smoke step). Cf. D118 NEW-1.
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 8: NEW-1 Slot-Count Contract ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_montage', {
    status: 'success',
    result: {
      name: 'AM_Slot1', path: '/Game/Animations/AM_Slot1',
      anim_sequence: '/Game/Anims/A.A',
      skeleton: '/Game/Skel/SK.SK', length: 1.0,
      slot_count: 1,
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const res = await executeM5AnimationTool('create_montage', {
    name: 'AM_Slot1', anim_sequence: '/Game/Anims/A.A',
  }, cm);

  t.assert(res.status === 'success', 'create_montage success envelope round-trips');
  t.assert(res.result?.slot_count === 1,
    `create_montage response carries slot_count=1 (NEW-1 regression contract); got ${res.result?.slot_count}`);
  t.assert(!('duplicate_slots' in (res.result || {})),
    'create_montage response shape excludes any duplicate-slot indicator');
}

// ── Done ───────────────────────────────────────────────────────
process.exit(t.summary());
