// _bench-transport-spike.mjs — TCP wire-latency benchmark for E-1 verification.
//
// Direct-TCP probe at 127.0.0.1:55558 (UEMCP custom plugin) using `net.createConnection`
// + `process.hrtime.bigint()` per-phase timing. Bypasses MCP-SDK + ConnectionManager
// entirely so the numbers reflect the wire floor — what UEMCP latency CAN be when
// the server's ready and the client is well-behaved.
//
// Underscore-prefix marks this file as test-only; it is NOT loaded by server.mjs
// (the run-rotation runner only picks up `test-*.mjs`). Run on demand for
// pre/post-A+ comparison and for EN-23 baseline reproducibility.
//
// Pre-conditions:
//   - Editor must be running with the UEMCP plugin loaded and `OnFEngineLoopInitComplete`
//     fired (i.e., world loaded, AR populated). The post-D131/W1 listener is gated
//     until init completes; ECONNREFUSED before that.
//   - Bench measures pure TCP. MCP wrapping adds ~0.3 ms per call which is invisible
//     against the ~50ms accept-poll floor in pre-A+ baselines.
//
// Audit 6 §1 baseline (n=210, pre-A+):
//   firstByte median 51.0–52.0 ms across all workload classes (dominated by 50ms accept-poll)
//
// Post-A+ projection (Audit 6 §2):
//   firstByte median ~1.5–8 ms (5–25× speedup; range covers kernel scheduling jitter)
//
// Run:
//   node server/_bench-transport-spike.mjs                      # default 50 pings
//   node server/_bench-transport-spike.mjs --workload=mixed     # 30-call mixed burst
//   node server/_bench-transport-spike.mjs --workload=ping --n=200

import net from 'node:net';

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const m = a.match(/^--([^=]+)(?:=(.+))?$/);
    return m ? [m[1], m[2] ?? true] : [a, true];
  }),
);
const PORT = parseInt(args.port || '55558', 10);
const N = parseInt(args.n || '50', 10);
const WORKLOAD = args.workload || 'ping';

/**
 * Per-call wire phases (matching Audit 6 §1 instrumentation):
 *   t0          — net.createConnection() returns
 *   tConnected  — 'connect' event fires
 *   tSent       — socket.write() returns
 *   tFirstByte  — first 'data' chunk arrives
 *   tParsed     — JSON.parse succeeds
 *   tClosed     — socket.destroy() called
 */
async function probe(type, params) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    let tConnected = 0n, tSent = 0n, tFirstByte = 0n, tParsed = 0n;
    const sock = net.createConnection({ port: PORT, host: '127.0.0.1' });
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (err, payloadBytes) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      const tClosed = process.hrtime.bigint();
      if (err) return reject(err);
      const ns = (a, b) => Number(b - a) / 1e6;
      resolve({
        connect_ms: ns(t0, tConnected),
        send_ms: ns(tConnected, tSent),
        first_byte_ms: ns(tSent, tFirstByte),
        response_ms: ns(tFirstByte, tParsed),
        close_ms: ns(tParsed, tClosed),
        total_ms: ns(t0, tClosed),
        bytes: payloadBytes,
      });
    };

    sock.setTimeout(5000);
    sock.on('connect', () => {
      tConnected = process.hrtime.bigint();
      const body = JSON.stringify({ type, params: params || {} });
      const bodyBuf = Buffer.from(body, 'utf-8');
      // E-1 §1: framed request to the UEMCP plugin (FRAMED_PORTS includes 55558).
      const headerBuf = Buffer.from(`Content-Length: ${bodyBuf.length}\r\n\r\n`, 'utf-8');
      sock.write(Buffer.concat([headerBuf, bodyBuf]));
      tSent = process.hrtime.bigint();
    });
    sock.on('data', (chunk) => {
      if (tFirstByte === 0n) tFirstByte = process.hrtime.bigint();
      chunks.push(chunk);
      totalBytes += chunk.length;
      // Try detect framing + parse body.
      const buf = Buffer.concat(chunks);
      const text = buf.slice(0, Math.min(buf.length, 512)).toString('utf-8');
      if (text.toLowerCase().startsWith('content-length:')) {
        const term = text.indexOf('\r\n\r\n');
        if (term === -1) return;
        const headerLen = term + 4;
        const bodyLen = parseInt(text.slice(text.indexOf(':') + 1, term).trim(), 10);
        if (buf.length < headerLen + bodyLen) return;
        try {
          JSON.parse(buf.slice(headerLen, headerLen + bodyLen).toString('utf-8'));
          tParsed = process.hrtime.bigint();
          finish(null, totalBytes);
        } catch (e) { finish(e); }
        return;
      }
      // Legacy unframed.
      try { JSON.parse(buf.toString('utf-8')); tParsed = process.hrtime.bigint(); finish(null, totalBytes); }
      catch { /* keep reading */ }
    });
    sock.on('timeout', () => finish(new Error('timeout')));
    sock.on('error', (e) => finish(e));
  });
}

function pct(xs, p) {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
function summarize(label, results) {
  const totals = results.map((r) => r.total_ms);
  const fbs = results.map((r) => r.first_byte_ms);
  console.log(`\n--- ${label} (n=${results.length}) ---`);
  console.log(`  total_ms      median=${pct(totals, 0.5).toFixed(2)}  p95=${pct(totals, 0.95).toFixed(2)}  max=${Math.max(...totals).toFixed(2)}  min=${Math.min(...totals).toFixed(2)}`);
  console.log(`  first_byte_ms median=${pct(fbs, 0.5).toFixed(2)}  p95=${pct(fbs, 0.95).toFixed(2)}  max=${Math.max(...fbs).toFixed(2)}  min=${Math.min(...fbs).toFixed(2)}`);
  const r0 = results[0];
  console.log(`  per-phase median: connect=${pct(results.map((r) => r.connect_ms), 0.5).toFixed(2)}ms  send=${pct(results.map((r) => r.send_ms), 0.5).toFixed(3)}ms  response=${pct(results.map((r) => r.response_ms), 0.5).toFixed(3)}ms`);
  console.log(`  payload bytes: ~${r0.bytes}`);
}

async function runWorkload() {
  console.log(`\nUEMCP transport bench — port ${PORT}, workload=${WORKLOAD}, n=${N}`);
  console.log('Pre-conditions: editor running, plugin loaded, OnFEngineLoopInitComplete fired.\n');

  // 200ms idle to settle the accept thread into its baseline polling state.
  await new Promise((r) => setTimeout(r, 200));

  const results = [];
  const errors = [];
  for (let i = 0; i < N; i++) {
    try {
      let r;
      if (WORKLOAD === 'ping') {
        r = await probe('ping', {});
      } else if (WORKLOAD === 'list_actors') {
        r = await probe('get_actors_in_level', {});
      } else if (WORKLOAD === 'editor_state') {
        r = await probe('get_editor_state', {});
      } else if (WORKLOAD === 'mixed') {
        const types = ['ping', 'get_editor_state', 'get_editor_state'];
        r = await probe(types[i % types.length], {});
      } else {
        r = await probe(WORKLOAD, {});
      }
      results.push(r);
    } catch (e) {
      errors.push({ i, err: e.message });
    }
  }
  if (errors.length > 0) {
    console.error(`\n[bench] ${errors.length} errors (first 3):`);
    errors.slice(0, 3).forEach((e) => console.error(`  call #${e.i}: ${e.err}`));
  }
  if (results.length > 0) {
    summarize(`Workload: ${WORKLOAD}`, results);
    console.log(`\nReference baselines (Audit 6 §1, pre-A+, n=210):`);
    console.log(`  pre-A+:  firstByte median 51-52 ms  total median ~52 ms  (50ms accept-poll floor dominant)`);
    console.log(`  post-A+: firstByte projected ~1.5-8 ms  total projected ~3-10 ms  (5-25× speedup)`);
  }
}

runWorkload().catch((e) => {
  console.error('bench failed:', e);
  process.exit(1);
});
