// RC Wire-Mock Tests — exercises Layer 4 (HTTP:30010) without a running editor.
//
// Covers:
//   - CP1: ConnectionManager.sendHttp round-trip + cache + error normalization
//   - CP1: rc-url-translator.mjs shape verification for each RC endpoint helper
//   - CP2: FULL-RC tools (exercised once those handlers ship)
//
// Run:
//   cd D:\DevTools\UEMCP\server
//   node test-rc-wire.mjs

import { ConnectionManager } from './connection-manager.mjs';
import {
  FakeHttpResponder,
  TestRunner,
} from './test-helpers.mjs';
import * as rc from './rc-url-translator.mjs';

const t = new TestRunner('RC Wire Mock');

const baseConfig = {
  projectRoot: '/fake/project',
  tcpPortExisting: 55557,
  tcpPortCustom: 55558,
  httpPort: 30010,
  rcPort: 30010,
  tcpTimeoutMs: 5000,
  httpTimeoutMs: 5000,
};

// ── Test 1: sendHttp round-trip through the mock seam ──────────
console.log('\n── Test 1: sendHttp round-trips via httpCommandFn ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('GET /remote/presets', { Presets: [{ Name: 'Foo', Path: '/Game/Foo.Foo' }] });

  const conn = new ConnectionManager({ ...baseConfig, httpCommandFn: rcMock.handler() });

  const res = await conn.sendHttp('GET', '/remote/presets', null);
  t.assert(Array.isArray(res.Presets), 'sendHttp returns decoded body');
  t.assert(res.Presets[0].Name === 'Foo', 'response field preserved');
  t.assert(rcMock.calls.length === 1, 'mock saw exactly one call');
  t.assert(rcMock.calls[0].port === 30010, 'mock received configured rcPort');
  t.assert(rcMock.calls[0].method === 'GET', 'mock received GET');
  t.assert(rcMock.calls[0].path === '/remote/presets', 'mock received correct path');
}

// ── Test 2: http-30010 layer health check ──────────────────────
console.log('\n── Test 2: http-30010 layer health check via GET /remote/presets ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('GET /remote/presets', { Presets: [] });
  const conn = new ConnectionManager({ ...baseConfig, httpCommandFn: rcMock.handler() });

  const ok = await conn.isLayerAvailable('http-30010', true);
  t.assert(ok === true, 'layer reports available');
  t.assert(conn.getStatus()['http-30010'].status === 'available', 'status set to available');

  // Simulate RC returning empty body string — httpCommand normalizes to {success:true}.
  // Verify health check still treats that as available.
  const rcEmpty = new FakeHttpResponder();
  rcEmpty.on('GET /remote/presets', { success: true });
  const conn2 = new ConnectionManager({ ...baseConfig, httpCommandFn: rcEmpty.handler() });
  const ok2 = await conn2.isLayerAvailable('http-30010', true);
  t.assert(ok2 === true, 'empty-body success envelope → available');
}

// ── Test 3: error normalization on 4xx/5xx ─────────────────────
console.log('\n── Test 3: sendHttp rejects with normalized error envelope ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/property', {
    success: false,
    message: 'No property named "DoesNotExist"',
    _httpStatus: 400,
  });
  const conn = new ConnectionManager({ ...baseConfig, httpCommandFn: rcMock.handler() });

  await t.assertRejects(
    async () => conn.sendHttp('PUT', '/remote/object/property', { objectPath: 'x', propertyName: 'y' }),
    /No property named/,
    'sendHttp throws with the RC error message'
  );
}

// ── Test 4: cache round-trip ───────────────────────────────────
console.log('\n── Test 4: sendHttp caches by (method, path, body) ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/property', { Health: 100 });
  const conn = new ConnectionManager({ ...baseConfig, httpCommandFn: rcMock.handler() });

  const body = { objectPath: '/Game/BP.Actor', propertyName: 'Health', access: 'READ_ACCESS' };
  await conn.sendHttp('PUT', '/remote/object/property', body);
  await conn.sendHttp('PUT', '/remote/object/property', body);
  t.assert(rcMock.calls.length === 1, 'second call served from cache');

  // Different body → new cache key → new call
  await conn.sendHttp('PUT', '/remote/object/property', { ...body, propertyName: 'Stamina' });
  t.assert(rcMock.calls.length === 2, 'different body bypasses cache');

  // skipCache forces fresh call
  await conn.sendHttp('PUT', '/remote/object/property', body, { skipCache: true });
  t.assert(rcMock.calls.length === 3, 'skipCache bypasses cache');
}

// ── Test 5: CommandQueue serializes HTTP calls ─────────────────
console.log('\n── Test 5: HTTP layer serializes overlapping requests ──');
{
  let concurrent = 0;
  let maxConcurrent = 0;
  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/call', async () => {
    concurrent++;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    await new Promise(r => setTimeout(r, 15));
    concurrent--;
    return { ReturnValue: true };
  });
  const conn = new ConnectionManager({ ...baseConfig, httpCommandFn: rcMock.handler() });

  await Promise.all([
    conn.sendHttp('PUT', '/remote/object/call', { i: 1 }, { skipCache: true }),
    conn.sendHttp('PUT', '/remote/object/call', { i: 2 }, { skipCache: true }),
    conn.sendHttp('PUT', '/remote/object/call', { i: 3 }, { skipCache: true }),
  ]);
  t.assert(maxConcurrent === 1, `HTTP queue serializes (maxConcurrent=${maxConcurrent})`);
  t.assert(rcMock.calls.length === 3, 'all 3 requests executed');
}

// ── Test 6: rc-url-translator shape contracts ──────────────────
console.log('\n── Test 6: rc-url-translator emits RC endpoint shapes ──');
{
  const getP = rc.rcGetProperty({ objectPath: '/Game/X.Y', propertyName: 'Health' });
  t.assert(getP.method === 'PUT' && getP.path === '/remote/object/property',
    'rcGetProperty uses PUT /remote/object/property');
  t.assert(getP.body.access === 'READ_ACCESS',
    'rcGetProperty defaults to READ_ACCESS');

  const setP = rc.rcSetProperty({ objectPath: '/Game/X.Y', propertyName: 'Health', propertyValue: 50 });
  t.assert(setP.body.propertyValue.Health === 50,
    'rcSetProperty wraps value in propertyName-keyed object');
  t.assert(setP.body.access === 'WRITE_TRANSACTION_ACCESS',
    'rcSetProperty defaults to WRITE_TRANSACTION_ACCESS');
  t.assert(setP.body.generateTransaction === true,
    'rcSetProperty defaults generateTransaction=true');

  const callF = rc.rcCallFunction({ objectPath: '/Game/X.Y', functionName: 'TakeDamage', parameters: { Amount: 25 } });
  t.assert(callF.method === 'PUT' && callF.path === '/remote/object/call',
    'rcCallFunction uses PUT /remote/object/call');
  t.assert(callF.body.parameters.Amount === 25,
    'rcCallFunction preserves parameters');
  t.assert(callF.body.generateTransaction === false,
    'rcCallFunction defaults generateTransaction=false');

  const desc = rc.rcDescribeObject({ objectPath: '/Game/X.Y' });
  t.assert(desc.path === '/remote/object/describe', 'rcDescribeObject uses /remote/object/describe');

  const pres = rc.rcGetPresets();
  t.assert(pres.method === 'GET' && pres.path === '/remote/presets' && pres.body === null,
    'rcGetPresets is GET /remote/presets with null body');

  const one = rc.rcGetPreset({ preset: 'My Preset' });
  t.assert(one.path === '/remote/preset/My%20Preset',
    `rcGetPreset url-encodes preset name (got ${one.path})`);

  const list = rc.rcListObjects({ className: 'AActor', recursive: true });
  t.assert(list.body.Class === 'AActor' && list.body.Recursive === true,
    'rcListObjects emits {Class, Recursive} body');

  const pass = rc.rcPassthrough({ method: 'POST', path: '/remote/batch', body: { X: 1 } });
  t.assert(pass.method === 'POST' && pass.body.X === 1,
    'rcPassthrough preserves method/body');

  t.assertRejects = t.assertRejects.bind(t);
  try {
    rc.rcPassthrough({ method: 'GET', path: '/internal/thing' });
    t.assert(false, 'rcPassthrough should reject non-/remote/ paths');
  } catch (e) {
    t.assert(/path must begin with \/remote\//.test(e.message),
      'rcPassthrough rejects non-/remote/ paths');
  }

  const batch = rc.rcBatch([
    { method: 'PUT', path: '/remote/object/property', body: { objectPath: 'a' } },
    { method: 'PUT', path: '/remote/object/call', body: { functionName: 'f' } },
  ]);
  t.assert(batch.method === 'PUT' && batch.path === '/remote/batch',
    'rcBatch uses PUT /remote/batch');
  t.assert(batch.body.Requests.length === 2,
    'rcBatch packs Requests array');
  t.assert(batch.body.Requests[0].Verb === 'PUT' && batch.body.Requests[0].URL === '/remote/object/property',
    'rcBatch entry has {RequestId, URL, Verb, Body}');
}

// ── Test 7: toCdoPath helper ───────────────────────────────────
console.log('\n── Test 7: toCdoPath resolves CDO suffix ──');
{
  const resolved = rc.toCdoPath('/Game/Blueprints/Character/BP_OSPlayerR.BP_OSPlayerR_C');
  t.assert(resolved === '/Game/Blueprints/Character/BP_OSPlayerR.BP_OSPlayerR_C:Default__BP_OSPlayerR_C',
    'toCdoPath appends :Default__ClassName suffix');

  const already = rc.toCdoPath('/Game/X.X_C:Default__X_C');
  t.assert(already === '/Game/X.X_C:Default__X_C',
    'toCdoPath is idempotent when already resolved');

  const noDot = rc.toCdoPath('');
  t.assert(noDot === '', 'toCdoPath preserves empty input');
}

// ── Test 8: executeRcTool — rc_* primitives ───────────────────
console.log('\n── Test 8: executeRcTool dispatches each rc_* primitive ──');
{
  const { executeRcTool, RC_SCHEMAS } = await import('./rc-tools.mjs');

  // Verify all 11 tools present in schema map
  const expected = [
    'rc_get_property', 'rc_set_property', 'rc_call_function',
    'rc_list_objects', 'rc_describe_object', 'rc_batch',
    'rc_get_presets', 'rc_passthrough',
    'list_material_parameters', 'get_curve_asset', 'get_mesh_info',
  ];
  for (const name of expected) {
    t.assert(RC_SCHEMAS[name] !== undefined, `RC_SCHEMAS has ${name}`);
  }

  // Per-tool round-trip assertions
  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/property', { Health: 100 });
  rcMock.on('PUT /remote/object/call', { ReturnValue: 42 });
  rcMock.on('PUT /remote/object/describe', { Properties: [] });
  rcMock.on('PUT /remote/object/list', { Objects: [] });
  rcMock.on('PUT /remote/batch', { Responses: [] });
  rcMock.on('GET /remote/presets', { Presets: [] });
  rcMock.on('GET /remote/preset/MyPreset', { Name: 'MyPreset', Properties: [] });
  rcMock.on('POST /remote/custom', { ok: true });

  const conn = new ConnectionManager({ ...baseConfig, httpCommandFn: rcMock.handler() });

  // rc_get_property → PUT /remote/object/property
  await executeRcTool('rc_get_property', {
    object_path: '/Game/X.Y', property_name: 'Health',
  }, conn);
  const c1 = rcMock.lastCall('PUT /remote/object/property');
  t.assert(c1 && c1.body.propertyName === 'Health', 'rc_get_property sends propertyName');
  t.assert(c1.body.access === 'READ_ACCESS', 'rc_get_property defaults READ_ACCESS');

  // rc_set_property → same endpoint, WRITE_TRANSACTION_ACCESS, skipCache
  rcMock.resetCalls();
  await executeRcTool('rc_set_property', {
    object_path: '/Game/X.Y', property_name: 'Health', value: 50,
  }, conn);
  const c2 = rcMock.lastCall('PUT /remote/object/property');
  t.assert(c2.body.access === 'WRITE_TRANSACTION_ACCESS', 'rc_set_property uses WRITE_TRANSACTION_ACCESS');
  t.assert(c2.body.propertyValue.Health === 50, 'rc_set_property wraps value');
  t.assert(c2.body.generateTransaction === true, 'rc_set_property default transaction=true');

  // rc_call_function → PUT /remote/object/call
  rcMock.resetCalls();
  await executeRcTool('rc_call_function', {
    object_path: '/Game/X.Y', function_name: 'Jump', args: { Force: 500 },
  }, conn);
  const c3 = rcMock.lastCall('PUT /remote/object/call');
  t.assert(c3 && c3.body.functionName === 'Jump', 'rc_call_function sends functionName');
  t.assert(c3.body.parameters.Force === 500, 'rc_call_function forwards args→parameters');
  t.assert(c3.body.generateTransaction === false, 'rc_call_function default transaction=false');

  // rc_list_objects → PUT /remote/object/list
  rcMock.resetCalls();
  await executeRcTool('rc_list_objects', { class_pattern: 'AActor', recursive: true }, conn);
  const c4 = rcMock.lastCall('PUT /remote/object/list');
  t.assert(c4 && c4.body.Class === 'AActor' && c4.body.Recursive === true,
    'rc_list_objects emits Class + Recursive');

  // rc_describe_object → PUT /remote/object/describe
  rcMock.resetCalls();
  await executeRcTool('rc_describe_object', { object_path: '/Game/X.Y' }, conn);
  const c5 = rcMock.lastCall('PUT /remote/object/describe');
  t.assert(c5 && c5.body.objectPath === '/Game/X.Y', 'rc_describe_object sends objectPath');

  // rc_batch → PUT /remote/batch with {Requests: []}
  rcMock.resetCalls();
  await executeRcTool('rc_batch', {
    operations: [
      { method: 'PUT', path: '/remote/object/property', body: { objectPath: 'a', propertyName: 'b' } },
    ],
  }, conn);
  const c6 = rcMock.lastCall('PUT /remote/batch');
  t.assert(c6 && Array.isArray(c6.body.Requests) && c6.body.Requests.length === 1,
    'rc_batch packs Requests array');

  // rc_get_presets (no args) → GET /remote/presets
  rcMock.resetCalls();
  await executeRcTool('rc_get_presets', {}, conn);
  const c7 = rcMock.lastCall('GET /remote/presets');
  t.assert(c7 && c7.body === null, 'rc_get_presets uses GET with null body');

  // rc_get_presets (with name) → GET /remote/preset/<name>
  rcMock.resetCalls();
  await executeRcTool('rc_get_presets', { preset: 'MyPreset' }, conn);
  const c8 = rcMock.lastCall('GET /remote/preset/MyPreset');
  t.assert(c8, 'rc_get_presets with name hits /remote/preset/<name>');

  // rc_passthrough → user-supplied method/endpoint
  rcMock.resetCalls();
  await executeRcTool('rc_passthrough', {
    method: 'POST', endpoint: '/remote/custom', body: { key: 'value' },
  }, conn);
  const c9 = rcMock.lastCall('POST /remote/custom');
  t.assert(c9 && c9.body.key === 'value', 'rc_passthrough forwards method/path/body');

  // rc_passthrough rejects non-/remote/ paths
  await t.assertRejects(
    async () => executeRcTool('rc_passthrough', { method: 'GET', endpoint: '/internal/X' }, conn),
    /path must begin with/,
    'rc_passthrough rejects non-/remote/ paths'
  );
}

// ── Test 9: executeRcTool — semantic delegates ────────────────
console.log('\n── Test 9: semantic delegates ride RC internally ──');
{
  const { executeRcTool } = await import('./rc-tools.mjs');

  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/call', { ReturnValue: 7 });
  rcMock.on('PUT /remote/object/property', { FloatCurves: [] });
  const conn = new ConnectionManager({ ...baseConfig, httpCommandFn: rcMock.handler() });

  // list_material_parameters → rcCallFunction on CDO with GetAllScalarParameterInfo
  rcMock.resetCalls();
  await executeRcTool('list_material_parameters', {
    asset_path: '/Game/Materials/M_Base.M_Base_C',
  }, conn);
  const m = rcMock.lastCall('PUT /remote/object/call');
  t.assert(m && m.body.functionName === 'GetAllScalarParameterInfo',
    'list_material_parameters calls GetAllScalarParameterInfo');
  t.assert(m.body.objectPath.includes(':Default__'),
    `list_material_parameters resolves CDO path (got ${m.body.objectPath})`);

  // get_curve_asset → rcGetProperty FloatCurves
  rcMock.resetCalls();
  await executeRcTool('get_curve_asset', {
    asset_path: '/Game/Curves/C_Damage.C_Damage',
  }, conn);
  const g = rcMock.lastCall('PUT /remote/object/property');
  t.assert(g && g.body.propertyName === 'FloatCurves',
    'get_curve_asset reads FloatCurves');
  t.assert(g.body.access === 'READ_ACCESS',
    'get_curve_asset uses READ_ACCESS');

  // get_mesh_info → rcCallFunction GetNumVertices
  rcMock.resetCalls();
  await executeRcTool('get_mesh_info', {
    asset_path: '/Game/Meshes/SM_Cube.SM_Cube',
  }, conn);
  const mi = rcMock.lastCall('PUT /remote/object/call');
  t.assert(mi && mi.body.functionName === 'GetNumVertices',
    'get_mesh_info calls GetNumVertices');

  // get_mesh_info requires one of asset_path / target
  await t.assertRejects(
    async () => executeRcTool('get_mesh_info', {}, conn),
    /asset_path or target required/,
    'get_mesh_info rejects empty args'
  );
}

// ── Test 10: isReadOp → cache discipline ─────────────────────
console.log('\n── Test 10: reads cache, writes skip cache ──');
{
  const { executeRcTool } = await import('./rc-tools.mjs');

  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/property', { Health: 100 });
  const conn = new ConnectionManager({ ...baseConfig, httpCommandFn: rcMock.handler() });

  // Two identical reads — second hits cache
  rcMock.resetCalls();
  await executeRcTool('rc_get_property', { object_path: '/Game/X.Y', property_name: 'Health' }, conn);
  await executeRcTool('rc_get_property', { object_path: '/Game/X.Y', property_name: 'Health' }, conn);
  t.assert(rcMock.calls.length === 1, 'second rc_get_property served from cache');

  // Two identical writes — both hit wire (skipCache)
  rcMock.resetCalls();
  await executeRcTool('rc_set_property', { object_path: '/Game/X.Y', property_name: 'Health', value: 50 }, conn);
  await executeRcTool('rc_set_property', { object_path: '/Game/X.Y', property_name: 'Health', value: 50 }, conn);
  t.assert(rcMock.calls.length === 2, 'rc_set_property bypasses cache (both calls hit wire)');
}

// ── Test 11: Zod validation bites ─────────────────────────────
console.log('\n── Test 11: Zod rejects missing required fields ──');
{
  const { executeRcTool } = await import('./rc-tools.mjs');
  const rcMock = new FakeHttpResponder();
  const conn = new ConnectionManager({ ...baseConfig, httpCommandFn: rcMock.handler() });

  await t.assertRejects(
    async () => executeRcTool('rc_get_property', { object_path: '/Game/X.Y' /* missing property_name */ }, conn),
    /property_name/,
    'rc_get_property rejects missing property_name'
  );

  await t.assertRejects(
    async () => executeRcTool('rc_call_function', { object_path: '/Game/X.Y' /* missing function_name */ }, conn),
    /function_name/,
    'rc_call_function rejects missing function_name'
  );

  await t.assertRejects(
    async () => executeRcTool('unknown_tool', {}, conn),
    /unknown tool/,
    'executeRcTool rejects unknown tool name'
  );
}

// ── Done ───────────────────────────────────────────────────────
process.exit(t.summary());
