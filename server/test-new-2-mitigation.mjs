// NEW-2 Mitigation Tests — wire-mock coverage of the three additive opt-in
// flags introduced for the WebRemoteControl sustained-traffic ceiling
// (D118 / D122). All flags default OFF; this suite exercises each
// individually, in combination, and verifies the no-flags baseline is
// observationally identical to pre-mitigation behavior.
//
// Flags under test:
//   UEMCP_RC_RECYCLE_AFTER_N        → connection-manager.mjs _recycleRcAgent
//   UEMCP_RC_RATE_CAP               → connection-manager.mjs _rcConsumeToken
//   UEMCP_RC_RELAUNCH_HINT_AFTER_N  → stderr warning fires once per session
//
// Run:
//   cd D:\DevTools\UEMCP\server
//   node test-new-2-mitigation.mjs

import { ConnectionManager } from './connection-manager.mjs';
import { FakeHttpResponder, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('NEW-2 Mitigation');

const baseConfig = {
  projectRoot: '/fake/project',
  tcpPortExisting: 55557,
  tcpPortCustom: 55558,
  rcPort: 30010,
  tcpTimeoutMs: 5000,
  httpTimeoutMs: 5000,
};

// Helper: capture stderr.write output for the duration of `fn`.
async function captureStderr(fn) {
  const original = process.stderr.write.bind(process.stderr);
  const captured = [];
  process.stderr.write = (chunk, ...rest) => {
    captured.push(typeof chunk === 'string' ? chunk : chunk.toString('utf-8'));
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return captured.join('');
}

// ── Test 1: default-OFF baseline is regression-free ──────────────
console.log('\n── Test 1: no env flags set → behavior identical to pre-mitigation ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('GET /remote/presets', { Presets: [] });
  const conn = new ConnectionManager({ ...baseConfig, httpCommandFn: rcMock.handler() });

  const stderrText = await captureStderr(async () => {
    for (let i = 0; i < 25; i++) {
      // skipCache so each call actually dispatches (cache would otherwise
      // serve calls 2..25 from the first response and bypass the counter).
      await conn.sendHttp('GET', '/remote/presets', null, { skipCache: true });
    }
  });

  t.assert(rcMock.calls.length === 25, '25 calls dispatched to mock');
  t.assert(conn.getRcRecycleCount() === 0, 'no recycles fired (flag disabled)');
  t.assert(conn.getRcCallCount() === 25, 'cumulative call counter still tracks');
  t.assert(stderrText === '', 'no stderr warnings emitted (relaunch-hint disabled)');
  // Mock saw all calls without an agent argument (we know because the mock
  // signature ignores the 6th arg; no assertion needed here, just record).
}

// ── Test 2: cached reads do NOT count toward NEW-2 counters ──────
console.log('\n── Test 2: cached responses do not increment any counter ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('GET /remote/presets', { Presets: [] });
  const conn = new ConnectionManager({
    ...baseConfig,
    httpCommandFn: rcMock.handler(),
    rcRecycleAfterN: 2,
    rcRelaunchHintAfterN: 2,
  });

  // First call: dispatches + counts.
  await conn.sendHttp('GET', '/remote/presets', null);
  t.assert(rcMock.calls.length === 1, 'first call dispatches');
  t.assert(conn.getRcCallCount() === 1, 'first call counted');

  // Subsequent identical calls: served from cache, do NOT dispatch.
  for (let i = 0; i < 10; i++) {
    await conn.sendHttp('GET', '/remote/presets', null);
  }
  t.assert(rcMock.calls.length === 1, 'cached calls did not dispatch');
  t.assert(conn.getRcCallCount() === 1, 'cached calls did not increment counter');
  t.assert(conn.getRcRecycleCount() === 1, 'lazy-create on first dispatched call only');
}

// ── Test 3: UEMCP_RC_RECYCLE_AFTER_N=3 — recycles fire on schedule ──
console.log('\n── Test 3: recycle agent every N un-cached calls ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/property', { success: true });
  const conn = new ConnectionManager({
    ...baseConfig,
    httpCommandFn: rcMock.handler(),
    rcRecycleAfterN: 3,
  });

  const body = (i) => ({ objectPath: `/Game/X${i}.X${i}`, propertyName: 'V' });

  // Call 1: lazy-create agent → recycleCount = 1.
  await conn.sendHttp('PUT', '/remote/object/property', body(1));
  t.assert(conn.getRcRecycleCount() === 1, 'call 1: lazy-create fires first recycle');

  // Calls 2 + 3: same agent, no further recycle.
  await conn.sendHttp('PUT', '/remote/object/property', body(2));
  await conn.sendHttp('PUT', '/remote/object/property', body(3));
  t.assert(conn.getRcRecycleCount() === 1, 'calls 2+3 reuse the existing agent');

  // Call 4: callsSinceRecycle (3) >= N (3) → recycle fires before dispatch.
  await conn.sendHttp('PUT', '/remote/object/property', body(4));
  t.assert(conn.getRcRecycleCount() === 2, 'call 4: second recycle fires');

  // Calls 5, 6: still on the second agent.
  await conn.sendHttp('PUT', '/remote/object/property', body(5));
  await conn.sendHttp('PUT', '/remote/object/property', body(6));
  t.assert(conn.getRcRecycleCount() === 2, 'calls 5+6 reuse second agent');

  // Call 7: third recycle.
  await conn.sendHttp('PUT', '/remote/object/property', body(7));
  t.assert(conn.getRcRecycleCount() === 3, 'call 7: third recycle fires');

  t.assert(rcMock.calls.length === 7, 'all 7 calls reached the wire');
  t.assert(conn.getRcCallCount() === 7, 'cumulative counter at 7');
}

// ── Test 4: UEMCP_RC_RATE_CAP=2/sec — 5 rapid calls observe wait on call 5 ──
console.log('\n── Test 4: token-bucket rate-cap enforces ≥1500ms by call 5 at 2/sec ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/property', { success: true });
  const conn = new ConnectionManager({
    ...baseConfig,
    httpCommandFn: rcMock.handler(),
    rcRateCap: 2, // 2 calls per second; capacity = 2
  });

  const body = (i) => ({ objectPath: `/Game/Y${i}.Y${i}`, propertyName: 'V' });
  const t0 = Date.now();

  // Issue 5 calls back-to-back. With cap=2/sec and capacity=2:
  //   call 1: drains 2 → 1 token, no wait
  //   call 2: drains 1 → 0 tokens, no wait
  //   call 3: bucket empty, wait ~500ms for refill
  //   call 4: wait another ~500ms
  //   call 5: wait another ~500ms — total elapsed by call 5 ≥ ~1500ms
  for (let i = 1; i <= 5; i++) {
    await conn.sendHttp('PUT', '/remote/object/property', body(i));
  }
  const elapsedMs = Date.now() - t0;

  t.assert(rcMock.calls.length === 5, 'all 5 calls dispatched');
  // Allow some setTimeout jitter but assert the floor is well above 1000ms.
  // Theoretical floor is 1500ms; allow a 50ms slop for setTimeout coarseness.
  t.assert(
    elapsedMs >= 1450,
    `5 calls @ 2/sec take ≥ ~1500ms (got ${elapsedMs}ms; floor=1450ms with slop)`
  );
  // Sanity upper bound — should not be wildly slow either.
  t.assert(elapsedMs < 5000, `5 calls @ 2/sec finish well before 5s ceiling (got ${elapsedMs}ms)`);
}

// ── Test 5: rate-cap permits a free first burst up to capacity ──
console.log('\n── Test 5: rate-cap allows up to `rate` calls instantly (capacity = rate) ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/call', { ReturnValue: true });
  const conn = new ConnectionManager({
    ...baseConfig,
    httpCommandFn: rcMock.handler(),
    rcRateCap: 4, // capacity = 4
  });

  const body = (i) => ({ objectPath: `/Game/Z${i}.Z${i}`, functionName: 'F' });
  const t0 = Date.now();
  for (let i = 1; i <= 4; i++) {
    // skipCache because identical bodies would otherwise short-circuit
    // — though here each call has a unique objectPath, so skipCache is belt-and-braces.
    await conn.sendHttp('PUT', '/remote/object/call', body(i), { skipCache: true });
  }
  const elapsedMs = Date.now() - t0;

  t.assert(rcMock.calls.length === 4, 'first 4 calls dispatched');
  t.assert(elapsedMs < 200, `first 4 calls fit within capacity, no wait (got ${elapsedMs}ms)`);
}

// ── Test 6: UEMCP_RC_RELAUNCH_HINT_AFTER_N=3 — fires once on call 3 ──
console.log('\n── Test 6: relaunch-hint fires exactly once at threshold ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/property', { success: true });
  const conn = new ConnectionManager({
    ...baseConfig,
    httpCommandFn: rcMock.handler(),
    rcRelaunchHintAfterN: 3,
  });

  const body = (i) => ({ objectPath: `/Game/W${i}.W${i}`, propertyName: 'V' });
  const stderrText = await captureStderr(async () => {
    // Calls 1+2: no warning.
    await conn.sendHttp('PUT', '/remote/object/property', body(1));
    await conn.sendHttp('PUT', '/remote/object/property', body(2));
    // Call 3: warning fires.
    await conn.sendHttp('PUT', '/remote/object/property', body(3));
    // Call 4+5: warning already fired, no further output.
    await conn.sendHttp('PUT', '/remote/object/property', body(4));
    await conn.sendHttp('PUT', '/remote/object/property', body(5));
  });

  t.assert(rcMock.calls.length === 5, 'all 5 calls dispatched');
  t.assert(
    stderrText.includes('NEW-2 ceiling approaching'),
    'warning text references NEW-2 ceiling'
  );
  t.assert(
    stderrText.includes('CLAUDE.md §Operational Limits'),
    'warning references CLAUDE.md §Operational Limits'
  );
  t.assert(
    stderrText.includes('[uemcp] WARNING:'),
    'warning has standard [uemcp] WARNING: prefix'
  );
  // Idempotence — the prefix appears exactly once across calls 3-5.
  const occurrences = (stderrText.match(/\[uemcp\] WARNING:/g) || []).length;
  t.assert(occurrences === 1, `warning fires once across calls 3-5 (saw ${occurrences})`);
}

// ── Test 7: relaunch-hint counts cumulative dispatched calls only ──
console.log('\n── Test 7: relaunch-hint ignores cached calls (cumulative counter only) ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('GET /remote/presets', { Presets: [] });
  const conn = new ConnectionManager({
    ...baseConfig,
    httpCommandFn: rcMock.handler(),
    rcRelaunchHintAfterN: 3,
  });

  const stderrText = await captureStderr(async () => {
    // First dispatched call.
    await conn.sendHttp('GET', '/remote/presets', null);
    // 20 cached calls — must not move the counter.
    for (let i = 0; i < 20; i++) {
      await conn.sendHttp('GET', '/remote/presets', null);
    }
    // Two more dispatched calls via skipCache → cumulative = 3 → warning fires on 3rd.
    await conn.sendHttp('GET', '/remote/presets', null, { skipCache: true });
    await conn.sendHttp('GET', '/remote/presets', null, { skipCache: true });
  });
  // Cache absorbed calls 2..21, then the two skipCache calls dispatched.
  t.assert(rcMock.calls.length === 3, 'cache absorbed calls 2-21; skipCache dispatched the rest');

  t.assert(stderrText.includes('[uemcp] WARNING:'), 'warning fires on 3rd dispatched');
  const occurrences = (stderrText.match(/\[uemcp\] WARNING:/g) || []).length;
  t.assert(occurrences === 1, 'warning fires exactly once');
}

// ── Test 8: all three flags enabled together — no interaction faults ──
console.log('\n── Test 8: all three mitigations enabled simultaneously ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/property', { success: true });
  const conn = new ConnectionManager({
    ...baseConfig,
    httpCommandFn: rcMock.handler(),
    rcRecycleAfterN: 2,
    rcRateCap: 10, // 10/sec — 5 calls won't trip rate-cap
    rcRelaunchHintAfterN: 4,
  });

  const body = (i) => ({ objectPath: `/Game/Q${i}.Q${i}`, propertyName: 'V' });
  const t0 = Date.now();
  const stderrText = await captureStderr(async () => {
    for (let i = 1; i <= 5; i++) {
      await conn.sendHttp('PUT', '/remote/object/property', body(i));
    }
  });
  const elapsedMs = Date.now() - t0;

  t.assert(rcMock.calls.length === 5, 'all 5 calls dispatched');
  // Recycle: lazy on call 1, then every 2 calls → calls 1, 3, 5 trigger recycle.
  t.assert(
    conn.getRcRecycleCount() === 3,
    `recycles at calls 1, 3, 5 (got ${conn.getRcRecycleCount()})`
  );
  t.assert(conn.getRcCallCount() === 5, 'cumulative counter at 5');
  // Rate at 10/sec → 5 calls should not need to wait significantly.
  t.assert(elapsedMs < 800, `rate-cap=10 not throttling (got ${elapsedMs}ms)`);
  // Relaunch-hint at 4 → fires once.
  const occurrences = (stderrText.match(/\[uemcp\] WARNING:/g) || []).length;
  t.assert(occurrences === 1, 'relaunch-hint fires exactly once');
}

// ── Test 9: getter parity — recycle count stays 0 with flag off ──
console.log('\n── Test 9: getRcRecycleCount() stays 0 with recycle flag off ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/property', { success: true });
  const conn = new ConnectionManager({
    ...baseConfig,
    httpCommandFn: rcMock.handler(),
    // No rcRecycleAfterN set.
  });

  for (let i = 1; i <= 10; i++) {
    await conn.sendHttp('PUT', '/remote/object/property', { objectPath: `/Game/A${i}.A${i}`, propertyName: 'V' });
  }
  t.assert(conn.getRcRecycleCount() === 0, 'recycle counter never increments');
  t.assert(conn.getRcCallCount() === 10, 'call counter still increments (always-on)');
}

// ── Test 10: rate-cap=0 (default) — no rate-cap wait introduced ───
console.log('\n── Test 10: rate-cap default (0) does not introduce any wait ──');
{
  const rcMock = new FakeHttpResponder();
  rcMock.on('PUT /remote/object/property', { success: true });
  const conn = new ConnectionManager({
    ...baseConfig,
    httpCommandFn: rcMock.handler(),
    // No rcRateCap set.
  });

  const body = (i) => ({ objectPath: `/Game/B${i}.B${i}`, propertyName: 'V' });
  const t0 = Date.now();
  for (let i = 1; i <= 50; i++) {
    await conn.sendHttp('PUT', '/remote/object/property', body(i));
  }
  const elapsedMs = Date.now() - t0;
  t.assert(rcMock.calls.length === 50, '50 calls dispatched');
  t.assert(elapsedMs < 500, `no rate-cap wait at default OFF (got ${elapsedMs}ms)`);
}

// ── Summary ──────────────────────────────────────────────────────
process.exit(t.summary());
