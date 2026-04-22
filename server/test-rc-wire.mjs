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

// ── Done ───────────────────────────────────────────────────────
process.exit(t.summary());
