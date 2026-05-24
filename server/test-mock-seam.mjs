// Mock Seam Verification Tests
// Validates that ConnectionManager's tcpCommandFn injection works correctly
// with FakeTcpResponder and ErrorTcpResponder from test-helpers.mjs.
//
// Run: cd D:\DevTools\UEMCP\server && node test-mock-seam.mjs

import {
  ConnectionManager,
  MetricsAggregator,
  _FRAMED_PORTS,
  _detectResponseFraming,
} from './connection-manager.mjs';
import {
  FakeTcpResponder,
  ErrorTcpResponder,
  TestRunner,
  createTestConfig,
} from './test-helpers.mjs';

const t = new TestRunner('Mock Seam Verification');

// ── Test 1: FakeTcpResponder basic wiring ───────────────────
console.log('\n── Test 1: FakeTcpResponder basic wiring ──');

{
  const { config, fake } = createTestConfig('/fake/project');
  // createTestConfig already registers 'ping'
  const conn = new ConnectionManager(config);

  const available = await conn.isLayerAvailable('tcp-55557', true);
  t.assert(available === true, 'tcp-55557 reports available via fake ping');
  t.assert(fake.calls.length === 1, `ping recorded (got ${fake.calls.length} calls)`);
  t.assert(fake.calls[0].type === 'ping', `call type is "ping" (got "${fake.calls[0].type}")`);
  t.assert(fake.calls[0].port === 55557, `call port is 55557 (got ${fake.calls[0].port})`);
}

// ── Test 2: send() routes through fake and caches ───────────
console.log('\n── Test 2: send() routes through fake and caches ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('list_actors', { status: 'success', actors: ['Cube', 'Light', 'Camera'] });

  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: fake.handler(),
  };
  const conn = new ConnectionManager(config);

  // First call — should go through fake
  const result1 = await conn.send('tcp-55557', 'list_actors', {});
  t.assert(result1.actors.length === 3, `list_actors returns 3 actors (got ${result1.actors?.length})`);
  t.assert(fake.callsFor('list_actors').length === 1, 'list_actors called once');

  // Second call — should hit cache (same type+params)
  const result2 = await conn.send('tcp-55557', 'list_actors', {});
  t.assert(result2.actors.length === 3, 'cached result still has 3 actors');
  t.assert(fake.callsFor('list_actors').length === 1, 'still 1 call (cache hit)');

  // Third call with skipCache — should bypass cache
  const result3 = await conn.send('tcp-55557', 'list_actors', {}, { skipCache: true });
  t.assert(result3.actors.length === 3, 'skipCache result still has 3 actors');
  t.assert(fake.callsFor('list_actors').length === 2, '2 calls now (cache bypassed)');
}

// ── Test 3: tcp-55558 routes to custom port ─────────────────
console.log('\n── Test 3: tcp-55558 routes to custom port ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_gas_state', { status: 'success', tags: ['State.IsSprinting'] });

  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: fake.handler(),
  };
  const conn = new ConnectionManager(config);

  const result = await conn.send('tcp-55558', 'get_gas_state', { actorName: 'Player1' });
  t.assert(result.tags[0] === 'State.IsSprinting', 'tcp-55558 returns correct data');

  const call = fake.lastCall('get_gas_state');
  t.assert(call.port === 55558, `routed to port 55558 (got ${call.port})`);
  t.assert(call.params.actorName === 'Player1', 'params passed through');
}

// ── Test 4: Factory function responses ──────────────────────
console.log('\n── Test 4: Factory function responses ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  let callCount = 0;
  fake.on('get_counter', (port, type, params) => {
    callCount++;
    return { status: 'success', count: callCount, echo: params.msg };
  });

  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: fake.handler(),
  };
  const conn = new ConnectionManager(config);

  const r1 = await conn.send('tcp-55557', 'get_counter', { msg: 'hello' }, { skipCache: true });
  t.assert(r1.count === 1, `first call count=1 (got ${r1.count})`);
  t.assert(r1.echo === 'hello', 'factory receives params');

  const r2 = await conn.send('tcp-55557', 'get_counter', { msg: 'world' }, { skipCache: true });
  t.assert(r2.count === 2, `second call count=2 (got ${r2.count})`);
}

// ── Test 5: Deep copy prevents state sharing ────────────────
console.log('\n── Test 5: Deep copy prevents state sharing ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('get_data', { status: 'success', items: ['a', 'b'] });

  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: fake.handler(),
  };
  const conn = new ConnectionManager(config);

  // skipCache both times so we get two separate deep copies from FakeTcpResponder
  const r1 = await conn.send('tcp-55557', 'get_data', {}, { skipCache: true });
  r1.items.push('MUTATED');

  const r2 = await conn.send('tcp-55557', 'get_data', {}, { skipCache: true });
  t.assert(r2.items.length === 2, `mutation didn't leak (got ${r2.items.length} items)`);
}

// ── Test 6: Error normalization — status: "error" ───────────
console.log('\n── Test 6: Error normalization — status: "error" ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('bad_cmd', { status: 'error', error: 'Actor not found' });

  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: fake.handler(),
  };
  const conn = new ConnectionManager(config);

  await t.assertRejects(
    () => conn.send('tcp-55557', 'bad_cmd', {}, { skipCache: true }),
    'Actor not found',
    'status:"error" normalized to thrown Error'
  );
}

// ── Test 7: Error normalization — success: false ────────────
console.log('\n── Test 7: Error normalization — success: false ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('bad_cmd2', { success: false, message: 'Permission denied' });

  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: fake.handler(),
  };
  const conn = new ConnectionManager(config);

  await t.assertRejects(
    () => conn.send('tcp-55557', 'bad_cmd2', {}, { skipCache: true }),
    'Permission denied',
    'success:false normalized to thrown Error'
  );
}

// ── Test 8: ErrorTcpResponder — timeout ─────────────────────
console.log('\n── Test 8: ErrorTcpResponder modes ──');

{
  const errResp = new ErrorTcpResponder('timeout');
  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: errResp.handler(),
  };
  const conn = new ConnectionManager(config);

  await t.assertRejects(
    () => conn.send('tcp-55557', 'list_actors', {}, { skipCache: true }),
    /timeout/i,
    'timeout mode throws timeout error'
  );
}

{
  const errResp = new ErrorTcpResponder('connection_refused');
  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: errResp.handler(),
  };
  const conn = new ConnectionManager(config);

  await t.assertRejects(
    () => conn.send('tcp-55557', 'ping', {}, { skipCache: true }),
    /ECONNREFUSED/i,
    'connection_refused mode throws ECONNREFUSED'
  );
}

{
  const errResp = new ErrorTcpResponder('invalid_json');
  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: errResp.handler(),
  };
  const conn = new ConnectionManager(config);

  await t.assertRejects(
    () => conn.send('tcp-55557', 'ping', {}, { skipCache: true }),
    /invalid JSON/i,
    'invalid_json mode throws parse error'
  );
}

// ── Test 9: ErrorTcpResponder — error response formats ──────
console.log('\n── Test 9: ErrorTcpResponder — error response formats ──');

{
  // error_status returns { status: "error" } — ConnectionManager normalizes to thrown error
  const errResp = new ErrorTcpResponder('error_status');
  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: errResp.handler(),
  };
  const conn = new ConnectionManager(config);

  await t.assertRejects(
    () => conn.send('tcp-55557', 'any_cmd', {}, { skipCache: true }),
    /simulated error/i,
    'error_status mode → ConnectionManager normalizes to error'
  );
}

{
  // error_success_false returns { success: false } — ConnectionManager normalizes to thrown error
  const errResp = new ErrorTcpResponder('error_success_false');
  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: errResp.handler(),
  };
  const conn = new ConnectionManager(config);

  await t.assertRejects(
    () => conn.send('tcp-55557', 'any_cmd', {}, { skipCache: true }),
    /simulated failure/i,
    'error_success_false mode → ConnectionManager normalizes to error'
  );
}

// ── Test 10: Health check caching ───────────────────────────
console.log('\n── Test 10: Health check caching ──');

{
  const { config, fake } = createTestConfig('/fake/project');
  const conn = new ConnectionManager(config);

  // First probe — fresh
  await conn.isLayerAvailable('tcp-55557', true);
  t.assert(fake.callsFor('ping').length === 1, 'first probe sends ping');

  // Second probe without force — should use cached status
  await conn.isLayerAvailable('tcp-55557', false);
  t.assert(fake.callsFor('ping').length === 1, 'cached probe skips ping');

  // Third probe with force — bypasses cache
  await conn.isLayerAvailable('tcp-55557', true);
  t.assert(fake.callsFor('ping').length === 2, 'forced probe sends ping again');
}

// ── Test 11: Layer status tracking ──────────────────────────
console.log('\n── Test 11: Layer status tracking ──');

{
  const { config, fake } = createTestConfig('/fake/project');
  const conn = new ConnectionManager(config);

  // Before any probe
  const statusBefore = conn.getStatus();
  t.assert(statusBefore['tcp-55557'].status === 'unknown', 'initial status is unknown');

  // After successful probe
  await conn.isLayerAvailable('tcp-55557', true);
  const statusAfter = conn.getStatus();
  t.assert(statusAfter['tcp-55557'].status === 'available', 'status is available after ping');

  // After failed probe
  const errResp = new ErrorTcpResponder('timeout');
  const config2 = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: errResp.handler(),
  };
  const conn2 = new ConnectionManager(config2);
  await conn2.isLayerAvailable('tcp-55557', true);
  const statusFail = conn2.getStatus();
  t.assert(statusFail['tcp-55557'].status === 'unavailable', 'status is unavailable after timeout');
  t.assert(statusFail['tcp-55557'].error !== null, 'error message preserved');
}

// ── Test 12: Command queue serialization ────────────────────
console.log('\n── Test 12: Command queue serialization ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  let order = [];
  fake.on('slow_cmd', async (port, type, params) => {
    order.push(`start-${params.id}`);
    // Simulate async work — but since we're in the same event loop tick
    // the queue should still serialize them
    await new Promise(r => setTimeout(r, 10));
    order.push(`end-${params.id}`);
    return { status: 'success', id: params.id };
  });

  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: fake.handler(),
  };
  const conn = new ConnectionManager(config);

  // Fire two commands on the same layer — should serialize
  const [r1, r2] = await Promise.all([
    conn.send('tcp-55557', 'slow_cmd', { id: 1 }, { skipCache: true }),
    conn.send('tcp-55557', 'slow_cmd', { id: 2 }, { skipCache: true }),
  ]);

  t.assert(r1.id === 1 && r2.id === 2, 'both commands completed');
  t.assert(
    order[0] === 'start-1' && order[1] === 'end-1' &&
    order[2] === 'start-2' && order[3] === 'end-2',
    `serialized on same layer: [${order.join(', ')}]`
  );
}

// ── Test 13: Unregistered command throws ────────────────────
console.log('\n── Test 13: Unregistered command throws ──');

{
  const fake = new FakeTcpResponder();
  // Only register ping, not 'unknown_cmd'
  fake.on('ping', { status: 'success' });

  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: fake.handler(),
  };
  const conn = new ConnectionManager(config);

  await t.assertRejects(
    () => conn.send('tcp-55557', 'unknown_cmd', {}, { skipCache: true }),
    'no response registered',
    'unregistered command throws descriptive error'
  );
}

// ── Test 14: FakeTcpResponder utility methods ───────────────
console.log('\n── Test 14: FakeTcpResponder utility methods ──');

{
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('list_actors', { status: 'success', actors: [] });

  const handler = fake.handler();
  await handler(55557, 'ping', {}, 5000);
  await handler(55557, 'list_actors', { filter: 'a' }, 5000);
  await handler(55557, 'ping', {}, 5000);
  await handler(55558, 'list_actors', { filter: 'b' }, 5000);

  t.assert(fake.calls.length === 4, `4 total calls (got ${fake.calls.length})`);
  t.assert(fake.callsFor('ping').length === 2, `2 ping calls (got ${fake.callsFor('ping').length})`);
  t.assert(fake.callsFor('list_actors').length === 2, `2 list_actors calls`);

  const last = fake.lastCall('list_actors');
  t.assert(last.port === 55558, `lastCall returns most recent (port ${last.port})`);
  t.assert(last.params.filter === 'b', `lastCall has correct params`);

  fake.resetCalls();
  t.assert(fake.calls.length === 0, 'resetCalls clears calls');
  // Responses should still work
  const r = await handler(55557, 'ping', {}, 5000);
  t.assert(r.status === 'success', 'responses survive resetCalls');

  fake.reset();
  t.assert(fake.calls.length === 0, 'reset clears calls');
  try {
    await handler(55557, 'ping', {}, 5000);
    t.assert(false, 'reset should clear responses too');
  } catch (e) {
    t.assert(e.message.includes('no response'), 'reset clears responses');
  }
}

// ── Test 15: onDefault fallback ─────────────────────────────
console.log('\n── Test 15: onDefault fallback ──');

{
  const fake = new FakeTcpResponder();
  fake.onDefault({ status: 'success', fallback: true });

  const handler = fake.handler();
  const r = await handler(55557, 'anything', {}, 5000);
  t.assert(r.fallback === true, 'onDefault provides fallback for unregistered commands');

  // Explicit registration takes priority
  fake.on('specific', { status: 'success', fallback: false, specific: true });
  const r2 = await handler(55557, 'specific', {}, 5000);
  t.assert(r2.specific === true, 'explicit registration overrides default');
}

// ── Test 16: ECONNREFUSED retry-on-next-command (D131 / NEW-9 W1) ─
// Post-W1 the TCP plugin defers Listen() until OnFEngineLoopInitComplete.
// Pre-init MCP commands receive ECONNREFUSED at the OS layer; the
// connect-per-command pattern means send() must NOT poison the layer
// state on the rejection path — the next command opens a fresh socket
// and succeeds once the editor finishes init.
console.log('\n── Test 16: ECONNREFUSED retry-on-next-command (D131) ──');

{
  // Hot-swappable handler — flips from connection_refused to healthy mid-flight,
  // simulating editor finishing OnFEngineLoopInitComplete between commands.
  const errResp = new ErrorTcpResponder('connection_refused');
  const goodResp = new FakeTcpResponder();
  goodResp.on('ping', { status: 'success' });
  goodResp.on('get_editor_state', {
    status: 'success',
    result: { world_path: '/Game/Maps/Default', world_name: 'Default' },
  });

  let usePreInit = true;
  const flippableHandler = async (port, type, params, timeoutMs) => {
    if (usePreInit) {
      return errResp.handler()(port, type, params, timeoutMs);
    }
    return goodResp.handler()(port, type, params, timeoutMs);
  };

  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 5000,
    tcpCommandFn: flippableHandler,
  };
  const conn = new ConnectionManager(config);

  // Pre-init: ECONNREFUSED expected
  await t.assertRejects(
    () => conn.send('tcp-55558', 'get_editor_state', {}, { skipCache: true }),
    /ECONNREFUSED/i,
    'pre-init send rejects with ECONNREFUSED'
  );

  // Layer status must NOT be poisoned to UNAVAILABLE — send() does not
  // mutate LayerStatus on the rejection path, so the next command can succeed.
  const statusPostFail = conn.getStatus()['tcp-55558'].status;
  t.assert(
    statusPostFail !== 'unavailable',
    `tcp-55558 status not poisoned after ECONNREFUSED (got "${statusPostFail}")`
  );

  // Editor init completes — flip to healthy responder
  usePreInit = false;

  // Next command should succeed without manual intervention (no reconnect call,
  // no isLayerAvailable force-probe — just a fresh send())
  const result = await conn.send('tcp-55558', 'get_editor_state', {}, { skipCache: true });
  t.assert(
    result?.result?.world_path === '/Game/Maps/Default',
    'post-init send succeeds on next command without retry orchestration'
  );

  // Layer status should be AVAILABLE after successful command
  const statusPostSuccess = conn.getStatus()['tcp-55558'].status;
  t.assert(
    statusPostSuccess === 'available',
    `tcp-55558 status flipped to AVAILABLE after success (got "${statusPostSuccess}")`
  );
}

// ── Test 17: E-1 §1 length-framing detection ────────────────
console.log('\n── Test 17: E-1 §1 length-framing detection ──');

{
  // Pure helper coverage — no socket, no mock seam.
  // Framed: full header + body.
  {
    const buf = Buffer.from('Content-Length: 11\r\n\r\n{"x":"abc"}', 'utf-8');
    const r = _detectResponseFraming(buf);
    t.assert(r.framed === true, 'framed prefix detected');
    t.assert(r.bodyLen === 11, `bodyLen=11 (got ${r.bodyLen})`);
    t.assert(r.headerLen === buf.indexOf('\r\n\r\n') + 4, 'headerLen points past terminator');
  }

  // Legacy: no framing prefix → unframed.
  {
    const buf = Buffer.from('{"status":"success"}', 'utf-8');
    const r = _detectResponseFraming(buf);
    t.assert(r.framed === false, 'unframed JSON detected as legacy path');
  }

  // Pending: too few bytes to decide.
  {
    const buf = Buffer.from('Cont', 'utf-8');
    const r = _detectResponseFraming(buf);
    t.assert(r.framed === 'pending', 'short prefix returns pending');
  }

  // Pending: header started but no terminator yet.
  {
    const buf = Buffer.from('Content-Length: 100\r\n', 'utf-8');
    const r = _detectResponseFraming(buf);
    t.assert(r.framed === 'pending', 'partial header (no terminator) is pending');
  }

  // Case insensitivity.
  {
    const buf = Buffer.from('content-LENGTH: 5\r\n\r\nhello', 'utf-8');
    const r = _detectResponseFraming(buf);
    t.assert(r.framed === true, 'case-insensitive framing prefix detected');
    t.assert(r.bodyLen === 5, 'case-insensitive bodyLen parsed');
  }

  // FRAMED_PORTS set: oracle 55557 NOT framed; UEMCP 55558 framed.
  t.assert(!_FRAMED_PORTS.has(55557), 'tcp-55557 (frozen oracle) does NOT receive framed requests');
  t.assert(_FRAMED_PORTS.has(55558), 'tcp-55558 (UEMCP custom) DOES receive framed requests');

  // Defense: a legacy JSON payload that contains "Content-Length:" mid-body must NOT
  // false-positive — sniff inspects only byte 0.
  {
    const buf = Buffer.from('{"note":"Content-Length: 42 inside JSON"}', 'utf-8');
    const r = _detectResponseFraming(buf);
    t.assert(r.framed === false, 'mid-body Content-Length string does not false-positive');
  }
}

// ── Test 18: E-1 §5 timeout default reconciliation ──────────
console.log('\n── Test 18: E-1 §5 timeout default reconciliation ──');

{
  // The config baseline raised 5000 → 10000ms. Verify ConnectionManager passes
  // the configured timeout through to tcpFn (the mock seam captures timeoutMs).
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('slow_op', { status: 'success' });

  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 10000,  // E-1 §5 baseline
    tcpCommandFn: fake.handler(),
  };
  const conn = new ConnectionManager(config);

  await conn.send('tcp-55558', 'slow_op', {}, { skipCache: true });
  const call = fake.lastCall('slow_op');
  t.assert(call.timeoutMs === 10000, `default timeout 10s applied (got ${call.timeoutMs}ms)`);

  // Per-call override still wins (D118 behavior preserved).
  await conn.send('tcp-55558', 'slow_op', { id: 2 }, { skipCache: true, timeoutMs: 15000 });
  const call2 = fake.lastCall('slow_op');
  t.assert(call2.timeoutMs === 15000, `per-call override 15s applied (got ${call2.timeoutMs}ms)`);
}

// ── Test 19: E-1 §6 EN-23 metrics aggregator — disabled ────
console.log('\n── Test 19: E-1 §6 metrics — default-OFF ──');

{
  // Default: no env vars → emitEveryN=0, logPath='' → aggregator inactive.
  const agg = new MetricsAggregator();
  t.assert(agg.isEnabled() === false, 'default aggregator is disabled');

  // record() is a cheap no-op when disabled — does not increment counters.
  agg.record({ port: 55558, type: 'ping', ok: true, total_ms: 5 });
  agg.recordCacheHit();
  agg.recordCacheMiss();
  // No publicly observable state beyond _enabled — assert flush() does not emit.
  const summary = agg.flush();
  t.assert(summary === null, 'flush() returns null when disabled');
}

// ── Test 20: E-1 §6 EN-23 metrics aggregator — enabled shape ─
console.log('\n── Test 20: E-1 §6 metrics — enabled shape ──');

{
  const agg = new MetricsAggregator({ emitEveryN: 100, logPath: '' });
  t.assert(agg.isEnabled() === true, 'aggregator enabled when emitEveryN > 0');

  agg.recordCacheHit();
  agg.recordCacheHit();
  agg.recordCacheMiss();

  agg.record({ port: 55558, type: 'ping', ok: true, framed: true, total_ms: 5, connect_ms: 0.5, send_ms: 0.05, first_byte_ms: 4, response_ms: 0.1 });
  agg.record({ port: 55558, type: 'ping', ok: true, framed: true, total_ms: 6, connect_ms: 0.5, send_ms: 0.05, first_byte_ms: 5, response_ms: 0.1 });
  agg.record({ port: 55557, type: 'list_actors', ok: false, err: 'timeout', framed: false, total_ms: 5000 });

  const summary = agg._computeSummary();
  t.assert(summary.window_n === 3, `window_n=3 (got ${summary.window_n})`);
  t.assert(summary.total_n === 3, `total_n=3 (got ${summary.total_n})`);
  t.assert(summary.cache_hits === 2, `cache_hits=2 (got ${summary.cache_hits})`);
  t.assert(summary.cache_misses === 1, `cache_misses=1 (got ${summary.cache_misses})`);
  t.assert(summary.framed_count === 2, `framed_count=2 (got ${summary.framed_count})`);
  t.assert(summary.error_count === 1, `error_count=1 (got ${summary.error_count})`);
  t.assert(summary.by_type.ping.n === 2, `by_type.ping.n=2 (got ${summary.by_type.ping.n})`);
  t.assert(summary.by_type.list_actors.errors === 1, 'by_type.list_actors records error');
  t.assert(summary.avg_total_ms != null, 'avg_total_ms computed');
  t.assert(summary.p50_total_ms != null, 'p50_total_ms computed');
  t.assert(summary.max_total_ms === 5000, `max_total_ms=5000 (got ${summary.max_total_ms})`);
}

// ── Test 21: E-1 §6 ConnectionManager wires metrics ─────────
console.log('\n── Test 21: E-1 §6 ConnectionManager wires metrics ──');

{
  // When metrics are enabled, ConnectionManager records cache hits/misses via the aggregator.
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  fake.on('list_actors', { status: 'success', actors: ['a'] });

  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 10000,
    tcpCommandFn: fake.handler(),
    metricsEmitEveryN: 100,  // enable
  };
  const conn = new ConnectionManager(config);
  const m = conn.getMetrics();
  t.assert(m.isEnabled() === true, 'ConnectionManager exposes enabled metrics aggregator');

  // First call: cache miss recorded.
  await conn.send('tcp-55557', 'list_actors', {});
  // Second call: cache hit recorded.
  await conn.send('tcp-55557', 'list_actors', {});

  const summary = m._computeSummary();
  t.assert(summary.cache_hits >= 1, `cache_hits >= 1 (got ${summary.cache_hits})`);
  t.assert(summary.cache_misses >= 1, `cache_misses >= 1 (got ${summary.cache_misses})`);
}

// ── Test 22b: E-1 §1 real-socket framed roundtrip ──────────
// Validates the production tcpCommand path (no mock seam) end-to-end against
// a real net.Server. Confirms outgoing requests are framed on tcp-55558,
// incoming framed responses parse correctly, and (separately) unframed
// responses still work via the legacy parse-loop fallback.
console.log('\n── Test 22b: E-1 §1 real-socket framed roundtrip ──');

{
  const net = await import('node:net');

  // Helper: spin up a server on a free port that accumulates bytes until a
  // request can be parsed (framed or unframed), then dispatches the handler.
  // This avoids races on multi-chunk delivery (the JS framing path emits two
  // writes for header + body; TCP may deliver them as separate data events).
  const startEchoServer = (expectFramed, handler) => new Promise((resolve) => {
    const server = net.createServer((sock) => {
      const chunks = [];
      let dispatched = false;
      sock.on('data', (c) => {
        if (dispatched) return;
        chunks.push(c);
        const buf = Buffer.concat(chunks);

        if (expectFramed) {
          const r = _detectResponseFraming(buf);
          if (r.framed === true && buf.length >= r.headerLen + r.bodyLen) {
            dispatched = true;
            handler(buf, sock);
          }
          return;
        }
        // Unframed: parse-loop until JSON valid.
        try {
          JSON.parse(buf.toString('utf-8'));
          dispatched = true;
          handler(buf, sock);
        } catch { /* keep reading */ }
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });

  // Round-trip 1: framed request from JS → parse on server side → framed response back.
  // We mimic the new plugin: emit Content-Length-framed reply.
  {
    const captured = { req: null, framedReply: false };
    const { server, port } = await startEchoServer(true, (reqBuf, sock) => {
      captured.req = reqBuf.toString('utf-8');
      const body = JSON.stringify({ status: 'success', echoed: true });
      const reply = `Content-Length: ${Buffer.byteLength(body, 'utf-8')}\r\n\r\n${body}`;
      captured.framedReply = true;
      sock.end(reply);
    });

    // Inject this port into FRAMED_PORTS so the JS side frames the request.
    _FRAMED_PORTS.add(port);
    try {
      const config = {
        projectRoot: '/fake/project',
        tcpPortExisting: 55557,
        tcpPortCustom: port,
        httpPort: 30010,
        tcpTimeoutMs: 5000,
      };
      const conn = new ConnectionManager(config);

      const result = await conn.send('tcp-55558', 'roundtrip', { x: 1 }, { skipCache: true });
      t.assert(result && result.echoed === true, 'framed roundtrip parses framed reply');
      t.assert(captured.req != null, 'server received bytes');
      t.assert(captured.req.startsWith('Content-Length:'), 'request was length-framed (per FRAMED_PORTS)');
      // The body after the header terminator must be the JSON payload.
      const splitIdx = captured.req.indexOf('\r\n\r\n');
      const body = captured.req.slice(splitIdx + 4);
      t.assert(body.includes('"type":"roundtrip"'), 'framed body contains type field');
      t.assert(body.includes('"x":1'), 'framed body contains params');
    } finally {
      _FRAMED_PORTS.delete(port);
      server.close();
    }
  }

  // Round-trip 2: legacy port (NOT in FRAMED_PORTS) → unframed request → unframed response.
  // Confirms backwards-compat shim works on both directions.
  {
    const captured = { req: null };
    const { server, port } = await startEchoServer(false, (reqBuf, sock) => {
      captured.req = reqBuf.toString('utf-8');
      // Legacy unframed reply — just JSON, no Content-Length header.
      sock.end(JSON.stringify({ status: 'success', legacy: true }));
    });

    try {
      const config = {
        projectRoot: '/fake/project',
        tcpPortExisting: port,  // alias the legacy oracle to this port
        tcpPortCustom: 55558,
        httpPort: 30010,
        tcpTimeoutMs: 5000,
      };
      const conn = new ConnectionManager(config);

      const result = await conn.send('tcp-55557', 'oracle_call', {}, { skipCache: true });
      t.assert(result.legacy === true, 'legacy roundtrip parses unframed reply');
      t.assert(captured.req != null, 'oracle server received bytes');
      t.assert(!captured.req.startsWith('Content-Length:'), 'oracle request was NOT framed (D23 preserved)');
      t.assert(captured.req.startsWith('{'), 'oracle request is raw JSON (legacy shape)');
    } finally {
      server.close();
    }
  }
}

// ── Test 22: E-1 §6 metrics off — getMetrics still works ────
console.log('\n── Test 22: E-1 §6 metrics getter always present ──');

{
  // Even with metrics disabled, getMetrics() must return an aggregator handle.
  const fake = new FakeTcpResponder();
  fake.on('ping', { status: 'success' });
  const config = {
    projectRoot: '/fake/project',
    tcpPortExisting: 55557,
    tcpPortCustom: 55558,
    httpPort: 30010,
    tcpTimeoutMs: 10000,
    tcpCommandFn: fake.handler(),
    // No metrics flags set → disabled.
  };
  const conn = new ConnectionManager(config);
  const m = conn.getMetrics();
  t.assert(m instanceof MetricsAggregator, 'getMetrics returns MetricsAggregator instance');
  t.assert(m.isEnabled() === false, 'aggregator is disabled when no flags set');
}

// ── Test 23: resolveProjectRoot() — env wins; fixture is the fallback ──
console.log('\n── Test 23: resolveProjectRoot() env/fixture fallback ──');

{
  const { resolveProjectRoot } = await import('./test-helpers.mjs');
  const saved = process.env.UNREAL_PROJECT_ROOT;
  process.env.UNREAL_PROJECT_ROOT = '';
  t.assert(resolveProjectRoot().endsWith('uemcp-fixture'), 'resolveProjectRoot falls back to fixture when unset');
  process.env.UNREAL_PROJECT_ROOT = '/some/real/proj';
  t.assert(resolveProjectRoot() === '/some/real/proj', 'resolveProjectRoot returns env when set');
  if (saved === undefined) delete process.env.UNREAL_PROJECT_ROOT; else process.env.UNREAL_PROJECT_ROOT = saved;
}

// ── Test 24: W6 — a successful write-op clears the read cache (D165) ──
console.log('\n── Test 24: W6 write-op clears read cache ──');

{
  const { config } = createTestConfig('/fake/project');
  let calls = 0;
  config.tcpCommandFn = async (_port, type) => { calls++; return { status: 'success', echo: type }; };
  const conn = new ConnectionManager(config);

  // Read-op caches; the repeat is served from cache (no new wire call).
  await conn.send('tcp-55558', 'read_x', {}, { skipCache: false });
  await conn.send('tcp-55558', 'read_x', {}, { skipCache: false });
  t.assert(calls === 1, `W6: repeated read-op served from cache (got ${calls} wire calls, want 1)`);

  // A write-op (skipCache:true) dispatches and busts the read cache.
  await conn.send('tcp-55558', 'write_y', {}, { skipCache: true });
  t.assert(calls === 2, `W6: write-op dispatched (got ${calls}, want 2)`);

  // The same read now re-fetches — proves the write cleared the stale entry.
  await conn.send('tcp-55558', 'read_x', {}, { skipCache: false });
  t.assert(calls === 3, `W6: read after write re-fetches, not stale (got ${calls}, want 3)`);
}

// ── Summary ─────────────────────────────────────────────────
const failures = t.summary();
process.exit(failures > 0 ? 1 : 0);
