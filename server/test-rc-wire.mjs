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
  t.assert(list.path === '/remote/search/assets',
    'rcListObjects targets /remote/search/assets (UE 5.6 endpoint)');
  t.assert(list.method === 'PUT',
    'rcListObjects uses PUT');
  t.assert(Array.isArray(list.body.Filter.ClassNames) && list.body.Filter.ClassNames[0] === 'Actor',
    'rcListObjects strips A/U prefix into Filter.ClassNames (AActor → Actor)');
  t.assert(list.body.Filter.RecursiveClasses === true,
    'rcListObjects forwards recursive flag onto Filter.RecursiveClasses');

  const listOuter = rc.rcListObjects({ className: 'UWorld', outer: '/Game/Maps', recursive: true });
  t.assert(listOuter.body.Filter.ClassNames[0] === 'World',
    'rcListObjects strips U prefix on UWorld → World');
  t.assert(listOuter.body.Filter.PackagePaths[0] === '/Game/Maps' && listOuter.body.Filter.RecursivePaths === true,
    'rcListObjects maps outer → Filter.PackagePaths with RecursivePaths flag');

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
    'toCdoPath appends :Default__ClassName suffix for BP class paths');

  const already = rc.toCdoPath('/Game/X.X_C:Default__X_C');
  t.assert(already === '/Game/X.X_C:Default__X_C',
    'toCdoPath is idempotent when already resolved');

  const noDot = rc.toCdoPath('');
  t.assert(noDot === '', 'toCdoPath preserves empty input');

  // F-7 fix — non-BP asset paths don't have CDOs and must pass through.
  const material = rc.toCdoPath('/Game/Materials/M_Brick.M_Brick');
  t.assert(material === '/Game/Materials/M_Brick.M_Brick',
    'toCdoPath passes UMaterial paths through (no _C, no CDO)');

  const curve = rc.toCdoPath('/Game/Curves/C_Damage.C_Damage');
  t.assert(curve === '/Game/Curves/C_Damage.C_Damage',
    'toCdoPath passes UCurveFloat paths through');

  const mesh = rc.toCdoPath('/Game/Meshes/SM_Cube.SM_Cube');
  t.assert(mesh === '/Game/Meshes/SM_Cube.SM_Cube',
    'toCdoPath passes UStaticMesh paths through');

  const anim = rc.toCdoPath('/Game/Anims/A_Walk.A_Walk');
  t.assert(anim === '/Game/Anims/A_Walk.A_Walk',
    'toCdoPath passes UAnimSequence paths through');

  // Subclass of UBlueprint — widget/anim BPs also generate _C classes.
  const widget = rc.toCdoPath('/Game/UI/W_HUD.W_HUD_C');
  t.assert(widget === '/Game/UI/W_HUD.W_HUD_C:Default__W_HUD_C',
    'toCdoPath resolves UWidgetBlueprint class paths (any _C suffix)');
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
  rcMock.on('PUT /remote/search/assets', { Assets: [] });
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

  // rc_list_objects → PUT /remote/search/assets (UE 5.6 — replaced /remote/object/list)
  rcMock.resetCalls();
  await executeRcTool('rc_list_objects', { class_pattern: 'AActor', recursive: true }, conn);
  const c4 = rcMock.lastCall('PUT /remote/search/assets');
  t.assert(c4 && c4.body.Filter.ClassNames[0] === 'Actor' && c4.body.Filter.RecursiveClasses === true,
    'rc_list_objects emits Filter.ClassNames (prefix-stripped) + RecursiveClasses');

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

  // ── list_material_parameters (F-6) — batches 3 Info UFUNCTIONs via rc_batch ──
  {
    const rcMock = new FakeHttpResponder();
    rcMock.on('PUT /remote/batch', {
      Responses: [
        { ResponseCode: 200, ResponseBody: { OutInfo: [{ Name: 'Opacity' }] } },
        { ResponseCode: 200, ResponseBody: { OutInfo: [{ Name: 'BaseColor' }, { Name: 'Tint' }] } },
        { ResponseCode: 200, ResponseBody: { OutInfo: [{ Name: 'Diffuse' }] } },
      ],
    });
    const conn = new ConnectionManager({ ...baseConfig, httpCommandFn: rcMock.handler() });

    const result = await executeRcTool('list_material_parameters', {
      asset_path: '/Game/Materials/M_Brick.M_Brick',
    }, conn);

    const bcall = rcMock.lastCall('PUT /remote/batch');
    t.assert(bcall, 'list_material_parameters dispatches via /remote/batch');
    t.assert(Array.isArray(bcall.body.Requests) && bcall.body.Requests.length === 3,
      'list_material_parameters batches 3 requests');
    const fnNames = bcall.body.Requests.map(r => r.Body.functionName);
    t.assert(fnNames.includes('GetAllScalarParameterInfo'), 'batch includes GetAllScalarParameterInfo');
    t.assert(fnNames.includes('GetAllVectorParameterInfo'), 'batch includes GetAllVectorParameterInfo');
    t.assert(fnNames.includes('GetAllTextureParameterInfo'), 'batch includes GetAllTextureParameterInfo');

    // F-7 interaction — non-BP material path must NOT get CDO suffix.
    const targetPath = bcall.body.Requests[0].Body.objectPath;
    t.assert(targetPath === '/Game/Materials/M_Brick.M_Brick',
      `list_material_parameters preserves non-BP asset path (got ${targetPath})`);

    // Aggregated response shape.
    t.assert(result.scalar.length === 1 && result.scalar[0].Name === 'Opacity',
      'list_material_parameters returns scalar params');
    t.assert(result.vector.length === 2,
      'list_material_parameters returns vector params');
    t.assert(result.texture.length === 1 && result.texture[0].Name === 'Diffuse',
      'list_material_parameters returns texture params');

    // F-7 regression guard — BP-class material path (unusual but valid) still gets CDO.
    rcMock.resetCalls();
    await executeRcTool('list_material_parameters', {
      asset_path: '/Game/Materials/M_Base.M_Base_C',
    }, conn);
    const bpcall = rcMock.lastCall('PUT /remote/batch');
    const bpPath = bpcall.body.Requests[0].Body.objectPath;
    t.assert(bpPath === '/Game/Materials/M_Base.M_Base_C:Default__M_Base_C',
      `list_material_parameters resolves CDO for _C class paths (got ${bpPath})`);
  }

  // ── get_curve_asset (F-4) — describe-probe then subclass-specific property read ──
  {
    // UCurveFloat path: describe returns CurveFloat class → reads `FloatCurve` (singular).
    const floatMock = new FakeHttpResponder();
    floatMock.on('PUT /remote/object/describe', { Class: '/Script/Engine.CurveFloat', Properties: [] });
    floatMock.on('PUT /remote/object/property', { FloatCurve: { Keys: [] } });
    const floatConn = new ConnectionManager({ ...baseConfig, httpCommandFn: floatMock.handler() });

    const floatRes = await executeRcTool('get_curve_asset', {
      asset_path: '/Game/Curves/C_Damage.C_Damage',
    }, floatConn);

    const describeCall = floatMock.lastCall('PUT /remote/object/describe');
    t.assert(describeCall, 'get_curve_asset probes class via /remote/object/describe');
    t.assert(describeCall.body.objectPath === '/Game/Curves/C_Damage.C_Damage',
      'describe targets the supplied asset_path');

    const propCall = floatMock.lastCall('PUT /remote/object/property');
    t.assert(propCall.body.propertyName === 'FloatCurve',
      'UCurveFloat → reads singular FloatCurve property');
    t.assert(propCall.body.access === 'READ_ACCESS',
      'get_curve_asset uses READ_ACCESS');
    t.assert(floatRes.class === 'CurveFloat' && floatRes.property === 'FloatCurve',
      'response surfaces resolved class + property');

    // UCurveVector path: describe returns CurveVector → reads `FloatCurves` (array).
    const vecMock = new FakeHttpResponder();
    vecMock.on('PUT /remote/object/describe', { Class: '/Script/Engine.CurveVector', Properties: [] });
    vecMock.on('PUT /remote/object/property', { FloatCurves: [{}, {}, {}] });
    const vecConn = new ConnectionManager({ ...baseConfig, httpCommandFn: vecMock.handler() });

    await executeRcTool('get_curve_asset', {
      asset_path: '/Game/Curves/CV_Path.CV_Path',
    }, vecConn);
    const vecProp = vecMock.lastCall('PUT /remote/object/property');
    t.assert(vecProp.body.propertyName === 'FloatCurves',
      'UCurveVector → reads FloatCurves array');

    // UCurveLinearColor: same FloatCurves array property.
    const colMock = new FakeHttpResponder();
    colMock.on('PUT /remote/object/describe', { Class: '/Script/Engine.CurveLinearColor', Properties: [] });
    colMock.on('PUT /remote/object/property', { FloatCurves: [{}, {}, {}, {}] });
    const colConn = new ConnectionManager({ ...baseConfig, httpCommandFn: colMock.handler() });
    await executeRcTool('get_curve_asset', {
      asset_path: '/Game/Curves/CLC_Tint.CLC_Tint',
    }, colConn);
    const colProp = colMock.lastCall('PUT /remote/object/property');
    t.assert(colProp.body.propertyName === 'FloatCurves',
      'UCurveLinearColor → reads FloatCurves array');

    // curve_class hint skips the describe probe.
    const hintMock = new FakeHttpResponder();
    hintMock.on('PUT /remote/object/property', { FloatCurve: {} });
    const hintConn = new ConnectionManager({ ...baseConfig, httpCommandFn: hintMock.handler() });
    await executeRcTool('get_curve_asset', {
      asset_path:  '/Game/Curves/C_Damage.C_Damage',
      curve_class: 'CurveFloat',
    }, hintConn);
    t.assert(!hintMock.lastCall('PUT /remote/object/describe'),
      'curve_class hint skips describe probe');
    t.assert(hintMock.lastCall('PUT /remote/object/property'),
      'curve_class hint still issues property read');
  }

  // ── get_mesh_info (F-5) — batches 5 UFUNCTIONs via rc_batch ──
  {
    const rcMock = new FakeHttpResponder();
    rcMock.on('PUT /remote/batch', {
      Responses: [
        { ResponseCode: 200, ResponseBody: { ReturnValue: 1024 } },  // GetNumVertices
        { ResponseCode: 200, ResponseBody: { ReturnValue: 2048 } },  // GetNumTriangles
        { ResponseCode: 200, ResponseBody: { ReturnValue: 4 } },     // GetNumLODs
        { ResponseCode: 200, ResponseBody: { ReturnValue: { Origin: [0,0,0], BoxExtent: [50,50,50] } } }, // GetBounds
        { ResponseCode: 200, ResponseBody: { ReturnValue: [{ MaterialSlotName: 'Default' }] } },         // GetStaticMaterials
      ],
    });
    const conn = new ConnectionManager({ ...baseConfig, httpCommandFn: rcMock.handler() });

    const result = await executeRcTool('get_mesh_info', {
      asset_path: '/Game/Meshes/SM_Cube.SM_Cube',
    }, conn);

    const bcall = rcMock.lastCall('PUT /remote/batch');
    t.assert(bcall, 'get_mesh_info dispatches via /remote/batch');
    t.assert(bcall.body.Requests.length === 5, 'get_mesh_info batches 5 requests');
    const fnNames = bcall.body.Requests.map(r => r.Body.functionName);
    t.assert(fnNames.includes('GetNumVertices'),    'batch includes GetNumVertices');
    t.assert(fnNames.includes('GetNumTriangles'),   'batch includes GetNumTriangles');
    t.assert(fnNames.includes('GetNumLODs'),        'batch includes GetNumLODs');
    t.assert(fnNames.includes('GetBounds'),         'batch includes GetBounds');
    t.assert(fnNames.includes('GetStaticMaterials'),'batch includes GetStaticMaterials');

    t.assert(result.vertices === 1024,  'get_mesh_info returns vertex count');
    t.assert(result.triangles === 2048, 'get_mesh_info returns triangle count');
    t.assert(result.lods === 4,         'get_mesh_info returns LOD count');
    t.assert(result.bounds && Array.isArray(result.bounds.BoxExtent),
      'get_mesh_info returns bounds struct');
    t.assert(Array.isArray(result.material_slots) && result.material_slots.length === 1,
      'get_mesh_info returns material slots');

    // Empty-args rejection.
    await t.assertRejects(
      async () => executeRcTool('get_mesh_info', {}, conn),
      /asset_path or target required/,
      'get_mesh_info rejects empty args'
    );

    // Accepts `target` (live actor name) as alternative to asset_path.
    rcMock.resetCalls();
    await executeRcTool('get_mesh_info', { target: 'BP_MyMesh_2' }, conn);
    const tcall = rcMock.lastCall('PUT /remote/batch');
    t.assert(tcall && tcall.body.Requests[0].Body.objectPath === 'BP_MyMesh_2',
      'get_mesh_info honors target param');
  }

  // ── Error sub-responses in a batch don't leak into the aggregate ──
  {
    const errMock = new FakeHttpResponder();
    errMock.on('PUT /remote/batch', {
      Responses: [
        { ResponseCode: 200, ResponseBody: { ReturnValue: 100 } },  // GetNumVertices ok
        { ResponseCode: 500, ResponseBody: { ErrorCode: 'SomeError', Message: 'bad' } },  // GetNumTriangles failed
        { ResponseCode: 200, ResponseBody: { ReturnValue: 1 } },    // GetNumLODs
        { ResponseCode: 404, ResponseBody: { ErrorCode: 'NoFn' } }, // GetBounds failed
        { ResponseCode: 200, ResponseBody: { ReturnValue: [] } },   // GetStaticMaterials
      ],
    });
    const errConn = new ConnectionManager({ ...baseConfig, httpCommandFn: errMock.handler() });
    const errRes = await executeRcTool('get_mesh_info', { asset_path: '/Game/Meshes/SM_Partial.SM_Partial' }, errConn);
    t.assert(errRes.vertices === 100, 'successful sub-responses decode normally');
    t.assert(errRes.triangles === null, 'non-2xx sub-response → null (no error-body leak)');
    t.assert(errRes.bounds === null, 'non-2xx sub-response → null for bounds');

    const partialMock = new FakeHttpResponder();
    partialMock.on('PUT /remote/batch', {
      Responses: [
        { ResponseCode: 200, ResponseBody: { OutInfo: [{ Name: 'Opacity' }] } },
        { ResponseCode: 500, ResponseBody: { ErrorCode: 'X' } },
        { ResponseCode: 200, ResponseBody: { OutInfo: [{ Name: 'Diffuse' }] } },
      ],
    });
    const pConn = new ConnectionManager({ ...baseConfig, httpCommandFn: partialMock.handler() });
    const pRes = await executeRcTool('list_material_parameters', {
      asset_path: '/Game/Materials/M_Partial.M_Partial',
    }, pConn);
    t.assert(pRes.scalar.length === 1, 'partial batch: scalar still populates');
    t.assert(Array.isArray(pRes.vector) && pRes.vector.length === 0, 'failed vector sub-response → empty array');
    t.assert(pRes.texture.length === 1, 'partial batch: texture still populates');
  }
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
