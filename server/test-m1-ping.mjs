// Integration test — round-trip the `ping` command through the UEMCP C++ plugin on TCP:55558.
//
// Unlike the unit test suites (mock-seam driven), this test hits the REAL TCP port on localhost
// and requires:
//   1. The plugin compiled into the target UE project.
//   2. The editor running with UEMCP enabled (non-commandlet — D57 gate is active in commandlets).
//
// If the connection is refused (editor not running, plugin disabled, port blocked), the test
// exits 0 with a "skipped" log line — this is intentional so CI that doesn't spin up an editor
// doesn't register a spurious failure. Exit code 0 = pass or skip; exit code 1 = actual failure.
//
// Run:  node test-m1-ping.mjs
//       (or with env UEMCP_PING_HOST/UEMCP_PING_PORT to target a non-localhost editor)

import net from 'node:net';
import { ConnectionManager } from './connection-manager.mjs';

const HOST = process.env.UEMCP_PING_HOST || '127.0.0.1';
const PORT = Number(process.env.UEMCP_PING_PORT || 55558);
const CONNECT_TIMEOUT_MS = 2000;
const READ_TIMEOUT_MS = 5000;

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, msg) {
  if (cond) {
    passed++;
  } else {
    failed++;
    failures.push(msg);
    console.error(`  ✗ ${msg}`);
  }
}

/**
 * Send one JSON command over a fresh TCP connection, accumulate the response until it parses,
 * then close. Mirrors the ConnectionManager's connect-per-command behavior.
 *
 * @param {object} request
 * @returns {Promise<object | {_skipped: true, reason: string}>}
 */
function sendOne(request) {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    let accumulated = Buffer.alloc(0);
    let resolved = false;

    const connectTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      resolve({ _skipped: true, reason: `connect timeout after ${CONNECT_TIMEOUT_MS}ms` });
    }, CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(connectTimer);
      socket.write(JSON.stringify(request), 'utf8');  // no newline terminator — matches wire protocol
    });

    const readTimer = setTimeout(() => {
      if (resolved) return;
      resolved = true;
      socket.destroy();
      reject(new Error(`read timeout after ${READ_TIMEOUT_MS}ms (accumulated ${accumulated.length} bytes)`));
    }, READ_TIMEOUT_MS);

    socket.on('data', (chunk) => {
      accumulated = Buffer.concat([accumulated, chunk]);
      try {
        const parsed = JSON.parse(accumulated.toString('utf8'));
        if (!resolved) {
          resolved = true;
          clearTimeout(readTimer);
          socket.end();
          resolve(parsed);
        }
      } catch {
        // Incomplete — keep accumulating.
      }
    });

    socket.on('error', (err) => {
      if (resolved) return;
      resolved = true;
      clearTimeout(connectTimer);
      clearTimeout(readTimer);
      if (err.code === 'ECONNREFUSED' || err.code === 'EHOSTUNREACH') {
        resolve({ _skipped: true, reason: `${err.code} — editor/plugin not running on ${HOST}:${PORT}` });
      } else {
        reject(err);
      }
    });

    socket.on('close', () => {
      if (resolved) return;
      // Connection closed with no data — could be plugin error or mid-send drop.
      if (accumulated.length === 0) {
        resolved = true;
        clearTimeout(connectTimer);
        clearTimeout(readTimer);
        reject(new Error('connection closed with no response body'));
      }
    });

    socket.connect(PORT, HOST);
  });
}

async function main() {
  console.log(`UEMCP M1 integration: ping roundtrip against ${HOST}:${PORT}`);

  // --- Probe first: can we reach the port at all? ---
  let pingResp;
  try {
    pingResp = await sendOne({ type: 'ping', params: {} });
  } catch (e) {
    console.error(`  ✗ unexpected error during ping: ${e.message}`);
    process.exit(1);
  }

  if (pingResp._skipped) {
    console.log(`  ⊘ skipped: ${pingResp.reason}`);
    console.log('  (This is not a failure — the test is gated on the editor being up.)');
    process.exit(0);
  }

  // --- Assertions on ping response shape (P0-1 envelope + ping handler contract) ---
  assert(pingResp.status === 'success', `ping status should be "success", got ${JSON.stringify(pingResp.status)}`);
  assert(pingResp.result && typeof pingResp.result === 'object', 'ping response has result object');
  if (pingResp.result) {
    assert(pingResp.result.message === 'pong', `result.message should be "pong", got ${JSON.stringify(pingResp.result.message)}`);
    assert(pingResp.result.server === 'uemcp', `result.server should be "uemcp", got ${JSON.stringify(pingResp.result.server)}`);
    assert(pingResp.result.port === 55558, `result.port should be 55558, got ${JSON.stringify(pingResp.result.port)}`);
    assert(typeof pingResp.result.version === 'string', `result.version should be string, got ${typeof pingResp.result.version}`);
  }

  // --- Unknown command returns UNKNOWN_COMMAND error envelope (P0-1 error format) ---
  let unknownResp;
  try {
    unknownResp = await sendOne({ type: '__m1_probe_unknown_command__', params: {} });
  } catch (e) {
    assert(false, `unexpected error during unknown-command probe: ${e.message}`);
    unknownResp = null;
  }

  if (unknownResp && !unknownResp._skipped) {
    assert(unknownResp.status === 'error', `unknown-command status should be "error", got ${JSON.stringify(unknownResp.status)}`);
    assert(unknownResp.code === 'UNKNOWN_COMMAND', `unknown-command code should be UNKNOWN_COMMAND, got ${JSON.stringify(unknownResp.code)}`);
    assert(typeof unknownResp.error === 'string' && unknownResp.error.length > 0, 'unknown-command error message present');
  }

  // --- Malformed request (missing `type`) -> MALFORMED_REQUEST (P0-9 protocol-layer null-safety) ---
  let malformedResp;
  try {
    malformedResp = await sendOne({ params: {} });  // no `type`
  } catch (e) {
    assert(false, `unexpected error during malformed probe: ${e.message}`);
    malformedResp = null;
  }

  if (malformedResp && !malformedResp._skipped) {
    assert(malformedResp.status === 'error', `malformed status should be "error", got ${JSON.stringify(malformedResp.status)}`);
    assert(malformedResp.code === 'MALFORMED_REQUEST', `malformed code should be MALFORMED_REQUEST, got ${JSON.stringify(malformedResp.code)}`);
  }

  // --- Roundtrip through the MCP server's ConnectionManager (success criterion #3) ---
  // Raw-socket coverage above tests the wire; this pass verifies the cache/queue/extractWireError
  // layer too. Bypassed if the first probe skipped, since the editor isn't up.
  try {
    const cm = new ConnectionManager({
      projectRoot: process.env.UNREAL_PROJECT_ROOT || '',
      tcpPortCustom: PORT,
      tcpPortExisting: 55557,
      tcpTimeoutMs: READ_TIMEOUT_MS,
    });
    const cmResp = await cm.send('tcp-55558', 'ping', {}, { skipCache: true });
    assert(cmResp && cmResp.status === 'success',
      `ConnectionManager ping status should be "success", got ${JSON.stringify(cmResp && cmResp.status)}`);
    assert(cmResp && cmResp.result && cmResp.result.message === 'pong',
      `ConnectionManager ping result.message should be "pong", got ${JSON.stringify(cmResp && cmResp.result)}`);
  } catch (e) {
    assert(false, `ConnectionManager ping threw: ${e.message}`);
  }

  // --- Report ---
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.error('Failures:');
    failures.forEach((f) => console.error(`  - ${f}`));
    process.exit(1);
  }
  console.log('All M1 ping roundtrip assertions passed.');
  process.exit(0);
}

main().catch((e) => {
  console.error(`Fatal: ${e.stack || e.message}`);
  process.exit(1);
});
