// Tests for M3-widgets — 7 widgets-toolset tools live on TCP:55558.
//
// Companion to docs/handoffs/m3-widgets-rebuild.md. Mirrors the
// test-tcp-tools.mjs widgets-section coverage (which got removed when M3
// flipped the layer) plus adds:
//   - Port routing → 55558 (oracle retirement, D23)
//   - Conformance shape parity vs canned oracle TCP:55557 fixtures
//   - Regression coverage for the 2 previously-broken handlers — wire-shape
//     assertions that match the FIXED behavior, not the oracle's bug
//   - P0-9 / P0-10 defense-in-depth Zod validation
//   - P0-7 stripDoubledAssetSuffix preserved (defensive normalization)
//
// Run: cd /d D:\DevTools\UEMCP\server && node test-m3-widgets.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeTcpResponder, ErrorTcpResponder, TestRunner, createTestConfig } from './test-helpers.mjs';
import {
  initWidgetsTools,
  executeWidgetsTool,
  getWidgetsToolDefs,
  WIDGETS_SCHEMAS,
} from './widgets-tcp-tools.mjs';

// ── Initialize wire_type maps from a fake YAML structure ──────────
const fakeToolsYaml = {
  toolsets: {
    widgets: {
      tools: {
        create_widget:          { wire_type: 'create_umg_widget_blueprint' },
        add_text_block:         { wire_type: 'add_text_block_to_widget' },
        add_button:             { wire_type: 'add_button_to_widget' },
        bind_widget_event:      {},
        set_text_block_binding: {},
        add_widget_to_viewport: {},
        add_input_action_node:  { wire_type: 'add_blueprint_input_action_node' },
      },
    },
  },
};
initWidgetsTools(fakeToolsYaml);

const t = new TestRunner('M3-widgets — TCP:55558 widgets toolset');

// ═══════════════════════════════════════════════════════════════
// Group 1: Tool definition completeness
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 1: Tool Definitions ──');

const defs = getWidgetsToolDefs();
const expectedTools = [
  'create_widget', 'add_text_block', 'add_button',
  'bind_widget_event', 'set_text_block_binding',
  'add_widget_to_viewport', 'add_input_action_node',
];

t.assert(Object.keys(defs).length === 7, '7 widgets tools defined');
t.assert(defs === WIDGETS_SCHEMAS, 'getWidgetsToolDefs returns WIDGETS_SCHEMAS');

for (const name of expectedTools) {
  t.assert(defs[name] !== undefined, `Tool "${name}" is defined`);
  t.assert(typeof defs[name].description === 'string' && defs[name].description.length > 0,
    `Tool "${name}" has a non-empty description`);
  t.assert(typeof defs[name].schema === 'object', `Tool "${name}" has a schema object`);
  t.assert(typeof defs[name].isReadOp === 'boolean', `Tool "${name}" has isReadOp flag`);
}

// All widgets tools are write ops (mutate UMG asset state).
for (const name of expectedTools) {
  t.assert(defs[name].isReadOp === false, `Tool "${name}" is a write op`);
}

// Regression: KNOWN-ISSUE wording from oracle-era descriptions must be gone.
t.assert(!defs.set_text_block_binding.description.match(/BROKEN/i),
  'set_text_block_binding description no longer flags BROKEN (fix shipped)');
t.assert(!defs.add_widget_to_viewport.description.match(/NO-OP/i),
  'add_widget_to_viewport description no longer flags NO-OP (fix shipped)');

// ═══════════════════════════════════════════════════════════════
// Group 2: Port routing — every tool dispatches to TCP:55558
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 2: Port Routing → 55558 ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  // Wire-type names match the conformance oracle (no rename — D23 parity goal).
  fake.on('create_umg_widget_blueprint',     { status: 'success', result: { name: 'W', path: '/Game/Widgets/W' } });
  fake.on('add_text_block_to_widget',        { status: 'success', result: { widget_name: 'T', text: 'hi' } });
  fake.on('add_button_to_widget',            { status: 'success', result: { success: true, widget_name: 'B' } });
  fake.on('bind_widget_event',               { status: 'success', result: { success: true, event_name: 'OnClicked' } });
  fake.on('set_text_block_binding',          { status: 'success', result: { success: true, binding_name: 'Score', function_name: 'GetScore' } });
  fake.on('add_widget_to_viewport',          { status: 'success', result: { blueprint_name: 'W', class_path: '/Game/Widgets/W.W_C', z_order: 0, added_to_viewport: true } });
  fake.on('add_blueprint_input_action_node', { status: 'success', result: { node_id: 'guid-x' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const checks = [
    ['create_widget',          { name: 'W' },                                                               'create_umg_widget_blueprint'],
    ['add_text_block',         { blueprint_name: 'W', widget_name: 'T', text: 'hi' },                       'add_text_block_to_widget'],
    ['add_button',             { blueprint_name: 'W', widget_name: 'B', text: 'Click' },                    'add_button_to_widget'],
    ['bind_widget_event',      { blueprint_name: 'W', widget_name: 'B', event_name: 'OnClicked' },          'bind_widget_event'],
    ['set_text_block_binding', { blueprint_name: 'W', widget_name: 'T', binding_name: 'Score' },            'set_text_block_binding'],
    ['add_widget_to_viewport', { blueprint_name: 'W' },                                                     'add_widget_to_viewport'],
    ['add_input_action_node',  { blueprint_name: 'BP', action_name: 'Jump' },                               'add_blueprint_input_action_node'],
  ];

  for (const [tool, args, wireType] of checks) {
    await executeWidgetsTool(tool, args, cm);
    const call = fake.lastCall(wireType);
    t.assert(call !== undefined, `${tool} reaches wire (type=${wireType})`);
    t.assert(call.port === 55558, `${tool} routed to TCP:55558 (M3 D23) — got ${call.port}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// Group 3: Wire-type translation (tools.yaml name → oracle type string)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 3: Wire-type Translation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_umg_widget_blueprint', { status: 'success', result: { name: 'W', path: '/Game/Widgets/W' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeWidgetsTool('create_widget', { name: 'W' }, cm);
  t.assert(fake.lastCall('create_umg_widget_blueprint') !== undefined,
    'create_widget → create_umg_widget_blueprint (wire_type translation applied)');
  t.assert(fake.lastCall('create_widget') === undefined,
    'tools.yaml name NOT used as wire type when wire_type is set');
}

// Identity fallback when wire_type is absent (bind_widget_event has no wire_type).
{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('bind_widget_event', { status: 'success', result: { success: true, event_name: 'OnClicked' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await executeWidgetsTool('bind_widget_event', { blueprint_name: 'W', widget_name: 'B', event_name: 'OnClicked' }, cm);
  t.assert(fake.lastCall('bind_widget_event') !== undefined,
    'bind_widget_event uses identity wire type (no override in tools.yaml)');
}

// Empty wire map → identity for all
{
  initWidgetsTools({ toolsets: {} });
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_widget', { status: 'success', result: { name: 'W', path: '/Game/Widgets/W' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);
  await executeWidgetsTool('create_widget', { name: 'W' }, cm);
  t.assert(fake.lastCall('create_widget') !== undefined,
    'Empty wire map: tool name used as-is (identity)');

  initWidgetsTools(fakeToolsYaml); // restore for subsequent groups
}

// ═══════════════════════════════════════════════════════════════
// Group 4: P0-7 — stripDoubledAssetSuffix normalization
// ═══════════════════════════════════════════════════════════════
//
// Defensive normalization preserved from the legacy widgets handler. Callers
// who pre-double the path (e.g. "MyWidget.MyWidget") get it folded back to
// the short form so the plugin's WidgetAssetPath helper builds the right
// /Game/Widgets/<name> path.

console.log('\n── Group 4: P0-7 Path Normalization ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_umg_widget_blueprint', { status: 'success', result: { name: 'MyWidget', path: '/Game/Widgets/MyWidget' } });
  fake.on('add_text_block_to_widget',    { status: 'success', result: { widget_name: 'T', text: 'hi' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // create_widget: name field is normalized
  await executeWidgetsTool('create_widget', { name: 'MyWidget.MyWidget' }, cm);
  let call = fake.lastCall('create_umg_widget_blueprint');
  t.assert(call.params.name === 'MyWidget',
    'create_widget: doubled "Name.Name" suffix stripped from name param');

  // Other tools: blueprint_name is normalized
  await executeWidgetsTool('add_text_block',
    { blueprint_name: 'HUD.HUD', widget_name: 'Title', text: 'hi' }, cm);
  call = fake.lastCall('add_text_block_to_widget');
  t.assert(call.params.blueprint_name === 'HUD',
    'add_text_block: doubled "Name.Name" suffix stripped from blueprint_name param');

  // Single-name passes through unchanged
  await executeWidgetsTool('add_text_block',
    { blueprint_name: 'HUD', widget_name: 'Title2', text: 'hi' }, cm);
  call = fake.lastCall('add_text_block_to_widget');
  t.assert(call.params.blueprint_name === 'HUD',
    'add_text_block: single name passes through unmodified');
}

// ═══════════════════════════════════════════════════════════════
// Group 5: Conformance shape parity — oracle TCP:55557 fixtures
// ═══════════════════════════════════════════════════════════════
//
// The fixtures here represent canned oracle responses. The TCP:55558
// implementation produces wire-equivalent responses for the 5 working
// handlers; the 2 previously-broken handlers diverge from oracle (that's
// the bug-fix) — see Group 6 for the divergent shapes.

console.log('\n── Group 5: Conformance Shape Parity (5 working handlers) ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  // create_umg_widget_blueprint: {name, path}
  fake.on('create_umg_widget_blueprint', {
    status: 'success', result: { name: 'HUD', path: '/Game/Widgets/HUD' },
  });
  // add_text_block_to_widget: {widget_name, text}
  fake.on('add_text_block_to_widget', {
    status: 'success', result: { widget_name: 'Title', text: 'Hello' },
  });
  // add_button_to_widget: {success, widget_name}
  fake.on('add_button_to_widget', {
    status: 'success', result: { success: true, widget_name: 'StartBtn' },
  });
  // bind_widget_event: {success, event_name}
  fake.on('bind_widget_event', {
    status: 'success', result: { success: true, event_name: 'OnClicked' },
  });
  // add_blueprint_input_action_node: {node_id}
  fake.on('add_blueprint_input_action_node', {
    status: 'success', result: { node_id: '11112222-3333-4444-5555-666677778888' },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const r1 = await executeWidgetsTool('create_widget', { name: 'HUD' }, cm);
  t.assert(r1.result.name === 'HUD' && r1.result.path === '/Game/Widgets/HUD',
    'create_widget result shape: {name, path}');

  const r2 = await executeWidgetsTool('add_text_block',
    { blueprint_name: 'HUD', widget_name: 'Title', text: 'Hello' }, cm);
  t.assert(r2.result.widget_name === 'Title' && r2.result.text === 'Hello',
    'add_text_block result shape: {widget_name, text}');

  const r3 = await executeWidgetsTool('add_button',
    { blueprint_name: 'HUD', widget_name: 'StartBtn', text: 'Start' }, cm);
  t.assert(r3.result.success === true && r3.result.widget_name === 'StartBtn',
    'add_button result shape: {success, widget_name}');

  const r4 = await executeWidgetsTool('bind_widget_event',
    { blueprint_name: 'HUD', widget_name: 'StartBtn', event_name: 'OnClicked' }, cm);
  t.assert(r4.result.success === true && r4.result.event_name === 'OnClicked',
    'bind_widget_event result shape: {success, event_name}');

  const r5 = await executeWidgetsTool('add_input_action_node',
    { blueprint_name: 'BP_Player', action_name: 'Jump', node_position: [100, 50] }, cm);
  t.assert(typeof r5.result.node_id === 'string' && r5.result.node_id.length > 10,
    'add_input_action_node result shape: {node_id} (GUID string)');
}

// ═══════════════════════════════════════════════════════════════
// Group 6: Bug-fix regression coverage — DIVERGENCE FROM ORACLE IS THE FIX
// ═══════════════════════════════════════════════════════════════
//
// The 2 previously-broken handlers ship corrected behavior on TCP:55558.
// These tests assert the NEW shape that callers should expect (not the
// oracle's broken shape). Live-fire smoke (Noah's deployment cycle) will
// confirm the in-editor binding/viewport behavior.

console.log('\n── Group 6: Bug-fix Regression (2 previously-broken handlers) ──');

// Bug 1: set_text_block_binding — fixed handler now creates a pure FText
// getter and registers FDelegateEditorBinding. Wire response gains a
// function_name field documenting the getter name (additive vs oracle's
// {success, binding_name} so callers can introspect the binding).
{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('set_text_block_binding', {
    status: 'success',
    result: { success: true, binding_name: 'ScoreText', function_name: 'GetScoreText' },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const r = await executeWidgetsTool('set_text_block_binding',
    { blueprint_name: 'HUD', widget_name: 'Score', binding_name: 'ScoreText' }, cm);

  t.assert(r.result.success === true,
    'set_text_block_binding result: success=true (fix shipped)');
  t.assert(r.result.binding_name === 'ScoreText',
    'set_text_block_binding result: binding_name preserved from oracle parity');
  t.assert(r.result.function_name === 'GetScoreText',
    'set_text_block_binding result: function_name field added (introspection — additive vs oracle)');
}

// Bug 2: add_widget_to_viewport — fixed handler now CreateWidget +
// AddToViewport against PIE world. Wire response gains an added_to_viewport
// boolean (additive vs oracle's misleading "note: use Blueprint nodes").
// When PIE is not running, returns NOT_IN_PIE typed error.
{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  // Happy path: PIE running, widget added.
  fake.on('add_widget_to_viewport', {
    status: 'success',
    result: {
      blueprint_name: 'HUD',
      class_path: '/Game/Widgets/HUD.HUD_C',
      z_order: 5,
      added_to_viewport: true,
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const r = await executeWidgetsTool('add_widget_to_viewport',
    { blueprint_name: 'HUD', z_order: 5 }, cm);

  t.assert(r.result.added_to_viewport === true,
    'add_widget_to_viewport result: added_to_viewport=true (fix shipped — actual viewport addition)');
  t.assert(r.result.class_path === '/Game/Widgets/HUD.HUD_C',
    'add_widget_to_viewport result: class_path preserved (oracle parity)');
  t.assert(r.result.z_order === 5,
    'add_widget_to_viewport result: z_order echoed back');
  t.assert(!('note' in r.result),
    'add_widget_to_viewport result: oracle "note: use Blueprint nodes" field GONE (no longer a no-op)');
}

// NOT_IN_PIE error path: assert the typed error code surfaces through the wire.
{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_widget_to_viewport', {
    status: 'error',
    error: 'Cannot add widget to viewport: PIE is not running. Start PIE first (input-and-pie.start_pie).',
    code: 'NOT_IN_PIE',
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeWidgetsTool('add_widget_to_viewport', { blueprint_name: 'HUD' }, cm),
    /PIE is not running/i,
    'add_widget_to_viewport returns NOT_IN_PIE when PIE is offline (fix surface)',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 7: P0-1 — typed error code surface (code field present)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 7: Error Propagation (P0-1) ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  // Plugin P0-1 envelope (with code field — additive vs oracle).
  fake.on('create_umg_widget_blueprint',
    { status: 'error', error: "Widget Blueprint 'HUD' already exists", code: 'ASSET_EXISTS' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeWidgetsTool('create_widget', { name: 'HUD' }, cm),
    /already exists/i,
    'create_widget propagates ASSET_EXISTS error',
  );
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_text_block_to_widget',
    { status: 'error', error: 'Root widget is not a Canvas Panel', code: 'ROOT_NOT_CANVAS' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeWidgetsTool('add_text_block',
      { blueprint_name: 'HUD', widget_name: 'T', text: 'hi' }, cm),
    /Canvas Panel/,
    'add_text_block propagates ROOT_NOT_CANVAS structured error',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 8: P0-9 — required-param Zod rejection (before wire)
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 8: P0-9 Required-Param Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // create_widget requires `name`
  await t.assertRejects(
    () => executeWidgetsTool('create_widget', {}, cm),
    /name/i,
    'create_widget rejects when required `name` is missing (Zod, before wire)',
  );
  t.assert(fake.lastCall('create_umg_widget_blueprint') === undefined,
    'Invalid create_widget never reached the wire');

  // add_button requires text
  await t.assertRejects(
    () => executeWidgetsTool('add_button', { blueprint_name: 'W', widget_name: 'B' }, cm),
    /text/i,
    'add_button rejects when required `text` is missing',
  );

  // bind_widget_event requires event_name
  await t.assertRejects(
    () => executeWidgetsTool('bind_widget_event', { blueprint_name: 'W', widget_name: 'B' }, cm),
    /event_name/i,
    'bind_widget_event rejects when event_name is missing',
  );

  // set_text_block_binding requires binding_name
  await t.assertRejects(
    () => executeWidgetsTool('set_text_block_binding', { blueprint_name: 'W', widget_name: 'T' }, cm),
    /binding_name/i,
    'set_text_block_binding rejects when binding_name is missing',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 9: P0-10 — vector shape Zod rejection
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 9: P0-10 Vector Shape Validation ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_text_block_to_widget',
    { status: 'success', result: { widget_name: 'T', text: 'hi' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // 3-element position should reject (Vec2 needs length 2)
  await t.assertRejects(
    () => executeWidgetsTool('add_text_block',
      { blueprint_name: 'W', widget_name: 'T', text: 'hi', position: [1, 2, 3] }, cm),
    /array/i,
    'add_text_block rejects 3-element position (Vec2 expected)',
  );

  // 1-element position rejects
  await t.assertRejects(
    () => executeWidgetsTool('add_button',
      { blueprint_name: 'W', widget_name: 'B', text: 'C', position: [10] }, cm),
    /array/i,
    'add_button rejects 1-element position',
  );

  // Happy path: valid Vec2 passes through
  await executeWidgetsTool('add_text_block',
    { blueprint_name: 'W', widget_name: 'T', text: 'hi', position: [100, 200] }, cm);
  const call = fake.lastCall('add_text_block_to_widget');
  t.assert(Array.isArray(call.params.position) && call.params.position.length === 2,
    'Valid Vec2 passes through to wire unmodified');
  t.assert(call.params.position[0] === 100 && call.params.position[1] === 200,
    'Vec2 ordering [x, y] preserved');
}

// ═══════════════════════════════════════════════════════════════
// Group 10: Caching — all widgets are write ops, so all skip cache
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 10: Write-op Cache Bypass ──');

{
  let calls = 0;
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_umg_widget_blueprint', () => {
    calls++;
    return { status: 'success', result: { name: 'W', path: '/Game/Widgets/W' } };
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  calls = 0;
  await executeWidgetsTool('create_widget', { name: 'W' }, cm);
  await executeWidgetsTool('create_widget', { name: 'W' }, cm);
  t.assert(calls === 2, 'create_widget (write) bypasses cache — both calls hit wire');
}

// ═══════════════════════════════════════════════════════════════
// Group 11: Transport errors propagate
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 11: Transport Errors ──');

{
  const errTimeout = new ErrorTcpResponder('timeout');
  const config1 = {
    projectRoot: 'D:/FakeProject',
    tcpPortExisting: 55557,
    tcpPortCustom:   55558,
    tcpTimeoutMs:    5000,
    tcpCommandFn:    errTimeout.handler(),
  };
  const cm1 = new ConnectionManager(config1);

  await t.assertRejects(
    () => executeWidgetsTool('create_widget', { name: 'W' }, cm1),
    'timeout',
    'TCP:55558 timeout propagates through executeWidgetsTool',
  );
}

{
  const errRefused = new ErrorTcpResponder('connection_refused');
  const config2 = {
    projectRoot: 'D:/FakeProject',
    tcpPortExisting: 55557,
    tcpPortCustom:   55558,
    tcpTimeoutMs:    5000,
    tcpCommandFn:    errRefused.handler(),
  };
  const cm2 = new ConnectionManager(config2);

  await t.assertRejects(
    () => executeWidgetsTool('create_widget', { name: 'W' }, cm2),
    'ECONNREFUSED',
    'TCP:55558 connection refused propagates through executeWidgetsTool',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 12: Unknown tool name rejection
// ═══════════════════════════════════════════════════════════════

console.log('\n── Group 12: Unknown Tool Rejection ──');

{
  const { config } = createTestConfig('D:/FakeProject');
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeWidgetsTool('not_a_real_tool', {}, cm),
    /unknown tool/,
    'executeWidgetsTool rejects unknown tool name with explicit error',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 13: CLEANUP-M3-FIXES — D99 finding #3 + #4 response shapes
// ═══════════════════════════════════════════════════════════════
//
// D99 #3 (PIE-time widget lookup) — LoadWidgetBlueprintByName now
// uses LoadObject<UWidgetBlueprint> with the canonical doubled
// object-path form (/Game/Widgets/<name>.<name>) before falling
// back to the package-path form via UEditorAssetLibrary. The
// canonical form survives PIE-active state where UEditorAssetLibrary
// can fail to resolve. Wire-mock here documents that the same
// type/param contract is unchanged across PIE state — the C++
// resolution path is what differs and is verified live.
//
// D99 #4 (bind_widget_event post-add_button) — handler now resolves
// the FObjectProperty for the named widget on GeneratedClass before
// calling CreateNewBoundEventForClass (UE 5.6's implementation
// returns null silently when ComponentProperty is null), recompiles
// if the property isn't yet reified, matches by ComponentBoundEvent's
// canonical fields (DelegatePropertyName + ComponentPropertyName,
// not CustomFunctionName), and emits node_id + widget_name.

console.log('\n── Group 13: CLEANUP-M3-FIXES regression (D99 #3 + #4) ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  // §3 — PIE-on add_widget_to_viewport happy path. Wire contract is
  // unchanged; the C++ resolution path differs (LoadObject canonical form).
  fake.on('add_widget_to_viewport', {
    status: 'success',
    result: {
      blueprint_name: 'WBP_M3Smoke',
      class_path: '/Game/Widgets/WBP_M3Smoke.WBP_M3Smoke_C',
      z_order: 0,
      added_to_viewport: true,
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const r = await executeWidgetsTool('add_widget_to_viewport', { blueprint_name: 'WBP_M3Smoke' }, cm);
  t.assert(r.result.added_to_viewport === true,
    'add_widget_to_viewport HAPPY response shape preserved post-PIE-lookup fix (D99 #3)');
  t.assert(r.result.class_path && r.result.class_path.includes('WBP_M3Smoke'),
    'class_path returned (PIE-on lookup landed)');
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  // §4 bind_widget_event — new response carries node_id + widget_name
  fake.on('bind_widget_event', {
    status: 'success',
    result: {
      success: true,
      event_name: 'OnClicked',
      widget_name: 'SmokeBtn',
      node_id: 'A1B2C3D4E5F6789012345678ABCDEF01',
    },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  const r = await executeWidgetsTool('bind_widget_event',
    { blueprint_name: 'WBP_M3Smoke', widget_name: 'SmokeBtn', event_name: 'OnClicked' }, cm);
  t.assert(r.result.event_name === 'OnClicked', 'bind_widget_event preserves event_name');
  t.assert(r.result.widget_name === 'SmokeBtn',
    'bind_widget_event response carries widget_name (D99 #4 — additive transparency)');
  t.assert(typeof r.result.node_id === 'string' && r.result.node_id.length > 0,
    'bind_widget_event response carries node_id (NodeGuid as string)');

  const call = fake.lastCall('bind_widget_event');
  t.assert(call.params.blueprint_name === 'WBP_M3Smoke',
    'blueprint_name passes through to wire');
  t.assert(call.params.widget_name === 'SmokeBtn',
    'widget_name passes through to wire');
  t.assert(call.params.event_name === 'OnClicked',
    'event_name passes through to wire');
}

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });

  // §4 — typed WIDGET_PROPERTY_MISSING when generated class lacks the FObjectProperty
  fake.on('bind_widget_event', {
    status: 'error',
    error: "Widget 'SmokeBtn' has no FObjectProperty on generated class — recompile blueprint and retry",
    code: 'WIDGET_PROPERTY_MISSING',
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeWidgetsTool('bind_widget_event',
      { blueprint_name: 'WBP_M3Smoke', widget_name: 'SmokeBtn', event_name: 'OnClicked' }, cm),
    /no FObjectProperty/,
    'WIDGET_PROPERTY_MISSING typed error propagates (replaces silent null-return failure)',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 14: D109 — add_input_action_node project-layout-aware resolution
// ═══════════════════════════════════════════════════════════════
//
// D109: add_input_action_node operates on a regular UBlueprint (NOT a widget BP),
// so its blueprint_name now routes through ResolveBlueprintAssetPath — accepting
// fully-qualified /Game/... paths or bare names with /Game/Blueprints/ + AR fallback.
// Wire-shape impact: blueprint_name passes through unchanged; BLUEPRINT_AMBIGUOUS
// is a new typed error surface here.
//
// Note: the 6 widget-BP handlers (create_widget, add_text_block, add_button,
// bind_widget_event, set_text_block_binding, add_widget_to_viewport) operate on
// widget blueprints under /Game/Widgets/ and are NOT affected by D109.

console.log('\n── Group 14: D109 — add_input_action_node resolution surface ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_blueprint_input_action_node', {
    status: 'success', result: { node_id: 'D109-GUID-AAAA' },
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Case 1: fully-qualified /Game/... path passes through to wire unchanged
  await executeWidgetsTool('add_input_action_node',
    { blueprint_name: '/Game/Custom/Char/BP_PlayerR', action_name: 'Jump' }, cm);
  let call = fake.lastCall('add_blueprint_input_action_node');
  t.assert(call.params.blueprint_name === '/Game/Custom/Char/BP_PlayerR',
    'D109: add_input_action_node full /Game/... path passes through unmodified (Case 1)');

  // Case 2/3: bare name passes through unchanged (plugin resolves)
  fake.resetCalls();
  await executeWidgetsTool('add_input_action_node',
    { blueprint_name: 'BP_PlayerR', action_name: 'Jump' }, cm);
  call = fake.lastCall('add_blueprint_input_action_node');
  t.assert(call.params.blueprint_name === 'BP_PlayerR',
    'D109: add_input_action_node bare name passes through unmodified (plugin resolves)');
}

{
  // BLUEPRINT_AMBIGUOUS — typed error propagates through executeWidgetsTool
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('add_blueprint_input_action_node', {
    status: 'error',
    error: "Ambiguous Blueprint name 'BP_PlayerR' (2 matches: /Game/Blueprints/Char/BP_PlayerR, /Game/Custom/Char/BP_PlayerR) — pass a fully-qualified /Game/... path to disambiguate",
    code: 'BLUEPRINT_AMBIGUOUS',
  });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await t.assertRejects(
    () => executeWidgetsTool('add_input_action_node',
      { blueprint_name: 'BP_PlayerR', action_name: 'Jump' }, cm),
    /Ambiguous Blueprint name/,
    'D109: BLUEPRINT_AMBIGUOUS propagates through add_input_action_node',
  );
}

// ═══════════════════════════════════════════════════════════════
// Group 15: WIDGETS-PERF — caller-pattern contract documented
// ═══════════════════════════════════════════════════════════════
//
// WIDGETS-PERF defers FKismetEditorUtilities::CompileBlueprint +
// UEditorAssetLibrary::SaveAsset out of the pure-mutation handlers
// (add_text_block_to_widget, add_button_to_widget) so callers can batch
// mutations cheaply and compile once. The contract is documented in the
// tool descriptions; these assertions guard against silent regression of
// the contract wording (e.g., a future refactor that re-adds an auto-
// compile would also need to update the description, or this test fails).
//
// Per the WIDGETS-PERF investigation report: D83 hitch log evidence shows
// cold add_text_block_to_widget = 2027.1ms / warm = 872.2ms / add_button =
// 4155.5ms, all dominated by CompileBlueprint + SaveAsset. The per-call
// cost post-fix will be re-measured against the same D83 instrumentation.
// We DO NOT assert specific ms thresholds here — wire-mock returns
// instantly so timing assertions would be uninformative; the live-editor
// hitch grep IS the perf verification mechanism.
//
// Note: schema descriptions are loaded from tools.yaml at startup via the
// fakeToolsYaml stub at the top of this file — so to test the YAML
// description text directly, we read from disk. This is a structural
// regression test, not a wire-protocol test.

console.log('\n── Group 15: WIDGETS-PERF — caller-pattern contract ──');

{
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const yamlPath = path.join(here, '..', 'tools.yaml');
  const yamlText = await fs.readFile(yamlPath, 'utf8');

  // Mutation handlers — must signal "no auto-compile" so callers know to
  // invoke compile_blueprint after a batch.
  const mutationContractPatterns = [
    { tool: 'add_text_block', pattern: /does not auto-compile/i },
    { tool: 'add_button',     pattern: /does not auto-compile or save/i },
    { tool: 'add_input_action_node', pattern: /only marks bp modified/i },
  ];
  for (const { tool, pattern } of mutationContractPatterns) {
    t.assert(yamlText.match(pattern),
      `WIDGETS-PERF: ${tool} description signals deferred-compile contract (${pattern})`);
  }

  // Mutation handlers must reference the follow-on compile path so callers
  // know what to invoke after batch mutations.
  const mutationCompileRefs = ['add_text_block', 'add_button', 'add_input_action_node'];
  for (const tool of mutationCompileRefs) {
    // Find the tool's full block in YAML and check its description references compile_blueprint.
    const blockMatch = yamlText.match(new RegExp(`^      ${tool}:[\\s\\S]*?(?=^      \\w+:|^  \\w+:)`, 'm'));
    t.assert(blockMatch && /compile_blueprint/.test(blockMatch[0]),
      `WIDGETS-PERF: ${tool} description points callers at compile_blueprint`);
  }

  // Property-resolving handlers (bind_widget_event, set_text_block_binding)
  // must signal that they self-compile — callers can chain through them
  // without manually invoking compile_blueprint afterwards.
  const completionContractPatterns = [
    { tool: 'bind_widget_event',      pattern: /self-compiles \+ saves on completion/i },
    { tool: 'set_text_block_binding', pattern: /self-compiles \+ saves on completion/i },
  ];
  for (const { tool, pattern } of completionContractPatterns) {
    t.assert(yamlText.match(pattern),
      `WIDGETS-PERF: ${tool} description signals self-compile contract (${pattern})`);
  }

  // Toolset-level description must mention the batch-then-compile pattern
  // and point at the D83 hitch instrumentation as the verification mechanism.
  t.assert(/d83 hitch instrumentation/i.test(yamlText),
    'WIDGETS-PERF: widgets toolset description references D83 hitch instrumentation as verification mechanism');
  t.assert(/batch of mutations/i.test(yamlText),
    'WIDGETS-PERF: widgets toolset description signals batch-mutation pattern');
}

{
  // Defense-in-depth: the C++ source-of-truth for the deferred compile
  // (WidgetHandlers.cpp) must NOT contain `FKismetEditorUtilities::CompileBlueprint`
  // inside HandleAddTextBlockToWidget or HandleAddButtonToWidget. Because the
  // function bodies are anonymous-namespaced in a single .cpp file, a literal
  // grep for the WIDGETS-PERF-tagged comment block adjacent to MarkBlueprintAsModified
  // is the simplest structural check.
  const fs = await import('node:fs/promises');
  const path = await import('node:path');
  const url = await import('node:url');
  const here = path.dirname(url.fileURLToPath(import.meta.url));
  const cppPath = path.join(here, '..', 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private', 'WidgetHandlers.cpp');
  const cppText = await fs.readFile(cppPath, 'utf8');

  // Both pure-mutation handlers carry the WIDGETS-PERF tag in their tail-comment,
  // and the tail must call MarkBlueprintAsModified, NOT CompileBlueprint.
  const widgetsPerfMatches = cppText.match(/WIDGETS-PERF/g) || [];
  t.assert(widgetsPerfMatches.length >= 2,
    `WIDGETS-PERF: C++ source carries the WIDGETS-PERF tag on the deferred-compile sites (got ${widgetsPerfMatches.length} matches, expected >=2)`);

  // Block-level structural check: HandleAddTextBlockToWidget body must NOT
  // contain CompileBlueprint(WidgetBlueprint) directly anymore.
  const handleAddTextBlock = cppText.match(/HandleAddTextBlockToWidget[\s\S]*?^\t\t\}/m);
  t.assert(handleAddTextBlock && !/FKismetEditorUtilities::CompileBlueprint\(WidgetBlueprint\)/.test(handleAddTextBlock[0]),
    'WIDGETS-PERF: HandleAddTextBlockToWidget no longer calls CompileBlueprint inline');

  const handleAddButton = cppText.match(/HandleAddButtonToWidget[\s\S]*?^\t\t\}/m);
  t.assert(handleAddButton && !/FKismetEditorUtilities::CompileBlueprint\(WidgetBlueprint\)/.test(handleAddButton[0]),
    'WIDGETS-PERF: HandleAddButtonToWidget no longer calls CompileBlueprint inline');
  t.assert(handleAddButton && !/SaveAsset\(WidgetAssetPath/.test(handleAddButton[0]),
    'WIDGETS-PERF: HandleAddButtonToWidget no longer calls SaveAsset inline (asymmetry with add_text_block fixed)');

  // Property-resolving handlers MUST still compile internally — that's the
  // load-bearing semantic; removing it would break the binding-materialization
  // contract. Guard against an over-eager refactor.
  const handleBindWidgetEvent = cppText.match(/HandleBindWidgetEvent[\s\S]*?^\t\t\}/m);
  t.assert(handleBindWidgetEvent && /FKismetEditorUtilities::CompileBlueprint/.test(handleBindWidgetEvent[0]),
    'WIDGETS-PERF: HandleBindWidgetEvent still self-compiles (load-bearing — needs FObjectProperty on GeneratedClass)');

  const handleSetTextBlockBinding = cppText.match(/HandleSetTextBlockBinding[\s\S]*?^\t\t\}/m);
  t.assert(handleSetTextBlockBinding && /FKismetEditorUtilities::CompileBlueprint/.test(handleSetTextBlockBinding[0]),
    'WIDGETS-PERF: HandleSetTextBlockBinding still self-compiles (load-bearing — needs new function graph translated to UFunction)');
}

// ═══════════════════════════════════════════════════════════════
// Group 16: D118 sharpening #1 — per-tool wire timeout override
// ═══════════════════════════════════════════════════════════════
//
// Property-resolving widget handlers (bind_widget_event +
// set_text_block_binding) self-compile (D114 — load-bearing for
// FObjectProperty / function-graph materialization). Live-fire smoke
// 2026-04-28 measured 5633ms for bind_widget_event under PIE,
// exceeding the default 5s wire timeout. The widgets toolset now
// applies a 10s override on these two handlers; pure-mutation widget
// tools and the rest of the surface keep the default.

console.log('\n── Group 16: D118 — Per-tool Wire Timeout Override ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('create_umg_widget_blueprint', { status: 'success', result: { name: 'W', path: '/Game/Widgets/W' } });
  fake.on('add_text_block_to_widget',    { status: 'success', result: { widget_name: 'T', text: 'hi' } });
  fake.on('add_button_to_widget',        { status: 'success', result: { success: true, widget_name: 'B' } });
  fake.on('bind_widget_event',           { status: 'success', result: { success: true, event_name: 'OnClicked' } });
  fake.on('set_text_block_binding',      { status: 'success', result: { success: true, binding_name: 'V', function_name: 'GetV' } });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  // Default 5s applies to non-binding handlers.
  await executeWidgetsTool('create_widget', { name: 'W' }, cm);
  t.assert(fake.lastCall('create_umg_widget_blueprint').timeoutMs === 5000,
    'create_widget uses default 5s wire timeout (config.tcpTimeoutMs)');

  await executeWidgetsTool('add_text_block', { blueprint_name: 'W', widget_name: 'T', text: 'hi' }, cm);
  t.assert(fake.lastCall('add_text_block_to_widget').timeoutMs === 5000,
    'add_text_block uses default 5s wire timeout (pure-mutation, no override)');

  await executeWidgetsTool('add_button', { blueprint_name: 'W', widget_name: 'B', text: 'C' }, cm);
  t.assert(fake.lastCall('add_button_to_widget').timeoutMs === 5000,
    'add_button uses default 5s wire timeout (pure-mutation, no override)');

  // Property-resolving binding handlers get the 10s override.
  await executeWidgetsTool('bind_widget_event',
    { blueprint_name: 'W', widget_name: 'B', event_name: 'OnClicked' }, cm);
  t.assert(fake.lastCall('bind_widget_event').timeoutMs === 10000,
    'bind_widget_event applies 10s wire timeout override (D118 sharpening #1 — handles ~5.6s under PIE)');

  await executeWidgetsTool('set_text_block_binding',
    { blueprint_name: 'W', widget_name: 'T', binding_name: 'V' }, cm);
  t.assert(fake.lastCall('set_text_block_binding').timeoutMs === 10000,
    'set_text_block_binding applies 10s wire timeout override (D118 sharpening #1 — self-compile under PIE)');
}

// ConnectionManager-level: opts.timeoutMs threads through send() to wire fn.
{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('any_tool', { status: 'success', result: {} });

  const { config } = createTestConfig('D:/FakeProject', fake);
  const cm = new ConnectionManager(config);

  await cm.send('tcp-55558', 'any_tool', {}, { skipCache: true, timeoutMs: 12345 });
  t.assert(fake.lastCall('any_tool').timeoutMs === 12345,
    'ConnectionManager.send forwards opts.timeoutMs to wire fn (per-call override mechanism)');

  await cm.send('tcp-55558', 'any_tool', { x: 1 }, { skipCache: true });
  t.assert(fake.lastCall('any_tool').timeoutMs === 5000,
    'ConnectionManager.send falls back to config.tcpTimeoutMs when opts.timeoutMs is omitted');
}

// ═══════════════════════════════════════════════════════════════
// Summary
// ═══════════════════════════════════════════════════════════════

const exitCode = t.summary();
process.exit(exitCode);
