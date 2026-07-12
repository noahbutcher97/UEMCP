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
import { readFileSync } from 'node:fs';
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

// ═══════════════════════════════════════════════════════════════
// Group 9: D183 source guard — live read handlers load animation
// asset instances instead of sending montage/sequence reads through
// reflection_walk's class resolver.
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 9: D183 Montage/Sequence Read Handler Source Guard ──');

{
  const source = readFileSync(
    new URL('../plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp', import.meta.url),
    'utf8'
  );

  const sliceBetween = (startNeedle, endNeedle) => {
    const start = source.indexOf(startNeedle);
    if (start < 0) {
      return '';
    }
    const end = source.indexOf(endNeedle, start + startNeedle.length);
    return end >= 0 ? source.slice(start, end) : source.slice(start);
  };

  const montageBlock = sliceBetween('void HandleGetMontageFull', 'void HandleGetAnimSequenceInfo');
  const sequenceBlock = sliceBetween('void HandleGetAnimSequenceInfo', '} // anonymous namespace');

  t.assert(montageBlock.includes('LoadObject<UAnimMontage>'),
    'get_montage_full handler loads a UAnimMontage asset instance');
  t.assert(montageBlock.includes('CompositeSections'),
    'get_montage_full handler reads montage sections');
  t.assert(montageBlock.includes('SlotAnimTracks'),
    'get_montage_full handler reads montage slot tracks');
  t.assert(montageBlock.includes('Notifies'),
    'get_montage_full handler reads montage notifies');
  t.assert(!/ResolveClass|reflection_walk/.test(montageBlock),
    'get_montage_full handler does not use class-resolution/reflection_walk path');

  t.assert(sequenceBlock.includes('LoadObject<UAnimSequence>'),
    'get_anim_sequence_info handler loads a UAnimSequence asset instance');
  t.assert(sequenceBlock.includes('GetSkeleton'),
    'get_anim_sequence_info handler reports skeleton');
  t.assert(sequenceBlock.includes('GetPlayLength'),
    'get_anim_sequence_info handler reports duration');
  t.assert(sequenceBlock.includes('GetNumberOfSampledKeys'),
    'get_anim_sequence_info handler reports sampled key/frame count from sequence API');
  t.assert(sequenceBlock.includes('Notifies'),
    'get_anim_sequence_info handler reads sequence notifies');
  t.assert(!/ResolveClass|reflection_walk/.test(sequenceBlock),
    'get_anim_sequence_info handler does not use class-resolution/reflection_walk path');

  t.assert(/Registry\.Register\(TEXT\("get_montage_full"\),\s*&HandleGetMontageFull\)/.test(source),
    'get_montage_full is registered on the live TCP command registry');
  t.assert(/Registry\.Register\(TEXT\("get_anim_sequence_info"\),\s*&HandleGetAnimSequenceInfo\)/.test(source),
    'get_anim_sequence_info is registered on the live TCP command registry');
}

// ═══════════════════════════════════════════════════════════════
// Group 10: D187 AnimGraph readback source guard
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 10: D187 AnimGraph Readback Source Guard ──');

{
  const source = readFileSync(
    new URL('../plugin/UEMCP/Source/UEMCP/Private/AnimationHandlers.cpp', import.meta.url),
    'utf8'
  );
  const buildSource = readFileSync(
    new URL('../plugin/UEMCP/Source/UEMCP/UEMCP.Build.cs', import.meta.url),
    'utf8'
  );

  const start = source.indexOf('void HandleGetAnimGraph');
  const end = source.indexOf('void RegisterAnimationHandlers', start);
  const graphBlock = start >= 0 && end > start ? source.slice(start, end) : '';

  t.assert(source.includes('#include "Animation/AnimBlueprint.h"'),
    'get_anim_graph includes UAnimBlueprint header');
  t.assert(source.includes('#include "AnimGraphNode_StateMachineBase.h"'),
    'get_anim_graph includes state machine graph node header');
  t.assert(source.includes('#include "AnimStateNode.h"'),
    'get_anim_graph includes state node header');
  t.assert(source.includes('#include "AnimStateTransitionNode.h"'),
    'get_anim_graph includes transition node header');
  t.assert(source.includes('#include "AnimGraphNode_Slot.h"'),
    'get_anim_graph includes slot node header');
  t.assert(source.includes('#include "AnimGraphNode_LayeredBoneBlend.h"'),
    'get_anim_graph includes layered bone blend node header');

  t.assert(buildSource.includes('"AnimGraph"'), 'Build.cs depends on AnimGraph');
  t.assert(buildSource.includes('"AnimGraphRuntime"'), 'Build.cs depends on AnimGraphRuntime');

  t.assert(graphBlock.includes('LoadObject<UObject>'),
    'get_anim_graph loads the asset instance from disk');
  t.assert(graphBlock.includes('Cast<UAnimBlueprint>'),
    'get_anim_graph validates UAnimBlueprint class');
  t.assert(graphBlock.includes('GetAllGraphs'),
    'get_anim_graph walks Blueprint-owned graphs');
  t.assert(graphBlock.includes('SetStringField(TEXT("graph_type")'),
    'get_anim_graph reports graph_type for every returned graph');
  t.assert(!source.includes('ClassifyGraphName('),
    'get_anim_graph does not call offline-only graph classifier helpers from C++');
  t.assert(graphBlock.includes('UAnimGraphNode_StateMachineBase'),
    'get_anim_graph inspects state machine graph nodes');
  t.assert(source.includes('SerializeAnimState') && source.includes('UAnimStateNode'),
    'get_anim_graph serializes states');
  t.assert(source.includes('SerializeAnimTransition') && source.includes('UAnimStateTransitionNode'),
    'get_anim_graph serializes transitions');
  t.assert(source.includes('Out->SetNumberField(TEXT("transition_count"), TransitionNodes.Num())'),
    'get_anim_graph transition_count is independent of include_transitions serialization');
  t.assert(graphBlock.includes('UAnimGraphNode_Slot'),
    'get_anim_graph serializes slot nodes');
  t.assert(graphBlock.includes('UAnimGraphNode_LayeredBoneBlend'),
    'get_anim_graph serializes layered bone blend nodes');
  t.assert(graphBlock.includes('unsupported_runtime_fields'),
    'get_anim_graph explicitly marks runtime-only data unsupported');
  t.assert(!/run_python_command|IPythonScriptPlugin|FPythonCommand/i.test(graphBlock),
    'get_anim_graph does not use Python execution');

  t.assert(source.includes('#include "EdGraph/EdGraphPin.h"'),
    'get_anim_graph includes UEdGraphPin header for pin topology');
  t.assert(source.includes('#include "EdGraph/EdGraphSchema.h"'),
    'get_anim_graph includes UEdGraphSchema header for schema metadata');
  t.assert(source.includes('SerializeAnimGraphPinTopology'),
    'get_anim_graph has a dedicated pin topology serializer');
  t.assert(source.includes('SerializeAnimGraphTopologyNode'),
    'get_anim_graph serializes topology nodes separately from summary nodes');
  t.assert(source.includes('SerializeAnimGraphPin('),
    'get_anim_graph serializes UEdGraphPin fields');
  t.assert(source.includes('BuildAnimGraphTopologyIndex'),
    'get_anim_graph builds a graph-key index before link serialization');
  t.assert(source.includes('CollectAnimGraphTopologyGraphs') &&
    source.includes('TEXT("get_all_graphs")') &&
    source.includes('TEXT("referenced_graph")'),
  'pin topology preserves GetAllGraphs provenance and cross-checks referenced graphs');
  t.assert(source.includes('EditorStateMachineGraph') &&
    source.includes('State->GetBoundGraph()') &&
    source.includes('Transition->GetBoundGraph()') &&
    source.includes('Transition->GetCustomTransitionGraph()'),
  'pin topology cross-checks state machine, state, transition, and custom transition graph references');
  t.assert(graphBlock.includes('include_pin_topology'),
    'get_anim_graph reads include_pin_topology');
  t.assert(graphBlock.includes('include_pin_defaults'),
    'get_anim_graph reads include_pin_defaults');
  t.assert(graphBlock.includes('PIN_DEFAULTS_REQUIRE_TOPOLOGY'),
    'get_anim_graph rejects pin defaults without topology at C++ layer');
  t.assert(graphBlock.includes('SetObjectField(TEXT("pin_topology")'),
    'get_anim_graph attaches pin_topology only when requested');
  t.assert(source.includes('EGuidFormats::Digits'),
    'pin topology uses explicit digits GUID format');
  t.assert(source.includes('SetBoolField(TEXT("truncated"), false)'),
    'pin topology explicitly reports non-truncated payloads');
  t.assert(source.includes('dangling_link_count'),
    'pin topology reports dangling link count');
  t.assert(source.includes('duplicate_graph_key_count'),
    'pin topology reports duplicate graph-key count');
  t.assert(source.includes('null_node_count') && source.includes('null_pin_count'),
    'pin topology reports omitted null nodes and pins');
  t.assert(source.includes('invalid_node_guid_count') && source.includes('invalid_pin_guid_count'),
    'pin topology reports invalid node and pin GUIDs');
  t.assert(source.includes('duplicate_node_key_count') && source.includes('duplicate_pin_key_count'),
    'pin topology reports node and pin key collisions');
  t.assert(source.includes('null_referenced_graph_count') &&
    source.includes('null_linked_pin_count') &&
    source.includes('null_linked_owner_count'),
  'pin topology reports null referenced graphs, linked pins, and linked owners');
  t.assert(source.includes('HasAnimGraphTopologyLosses') &&
    source.includes('Root->SetBoolField(TEXT("complete"), !HasAnimGraphTopologyLosses(Index));'),
  'pin topology marks complete false for every recorded topology loss');

  const topologyStart = source.indexOf('struct FAnimGraphTopologyIndex');
  const topologyEnd = source.indexOf('TSharedPtr<FJsonObject> SerializeEditorGraphNode', topologyStart);
  t.assert(topologyStart >= 0 && topologyEnd > topologyStart,
    'pin topology serializer guard boundaries are valid');
  const topologyBlock = topologyStart >= 0 && topologyEnd > topologyStart
    ? source.slice(topologyStart, topologyEnd)
    : '';
  t.assert(topologyBlock.includes('BuildAnimGraphTopologyEntryIndex') &&
    topologyBlock.includes('Index.NodeKeys.Find(LinkedNode)') &&
    topologyBlock.includes('Index.PinKeys.Find(LinkedPin)'),
  'pin topology validates linked node and pin membership before emitting endpoints');
  t.assert(topologyBlock.includes('!LinkedNodeKey || !LinkedPinKey') &&
    topologyBlock.includes('++Index.DanglingLinkCount'),
  'unserialized link endpoints are counted as dangling');
  t.assert(topologyBlock.includes('Index.PinNodes.Find(LinkedPin)') &&
    topologyBlock.includes('Index.NodeGraphs.Find(LinkedNode)') &&
    topologyBlock.includes('Index.GraphKeys.Find(LinkedGraph)'),
  'pin topology validates link endpoint graph and node membership');
  t.assert(topologyBlock.includes('IndexAnimGraphPinRecursive') &&
    topologyBlock.includes('SerializeAnimGraphPinRecursive') &&
    topologyBlock.includes('Pin->SubPins'),
  'pin topology recursively indexes and serializes split pins');
  t.assert(topologyBlock.includes('SetBoolField(TEXT("is_subpin")') &&
    topologyBlock.includes('SetArrayField(TEXT("subpin_ids")'),
  'pin topology emits documented split-pin fields');
  t.assert(topologyBlock.includes('SetStringField(TEXT("name")') &&
    topologyBlock.includes('SetStringField(TEXT("class_name")') &&
    topologyBlock.includes('SetStringField(TEXT("schema_class")'),
  'pin topology graph entries emit documented identity and schema fields');
  t.assert(!topologyBlock.includes('GetOwningNodeUnchecked'),
    'pin topology resolves pin owners exclusively through indexed membership');
  t.assert(!/Modify\s*\(|AllocateDefaultPins|MarkPackageDirty|SavePackage|CompileBlueprint|MakeLinkTo|BreakLinkTo|BreakAllPinLinks/.test(topologyBlock),
    'pin topology serializer remains read-only and does not normalize or mutate graph state');

  const pinTopologyAttachments = [
    ...graphBlock.matchAll(/Result->SetObjectField\(TEXT\("pin_topology"\),\s*SerializeAnimGraphPinTopology\(AnimBlueprint,\s*bIncludePinDefaults\)\);/g)
  ];
  t.assert(pinTopologyAttachments.length === 1 &&
    /if\s*\(\s*bIncludePinTopology\s*\)\s*\{\s*Result->SetObjectField\(TEXT\("pin_topology"\),\s*SerializeAnimGraphPinTopology\(AnimBlueprint,\s*bIncludePinDefaults\)\);\s*\}/s.test(graphBlock),
  'get_anim_graph attaches pin_topology exactly once inside the include_pin_topology gate');

  t.assert(/Registry\.Register\(TEXT\("get_anim_graph"\),\s*&HandleGetAnimGraph\)/.test(source),
    'get_anim_graph is registered on the live TCP command registry');
}

// ── Done ───────────────────────────────────────────────────────
process.exit(t.summary());
