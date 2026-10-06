// Execute the retained harness itself: ambient isolation, explicit consumers and cleanup.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const t = new TestRunner('Retained MCP wire harness regression');
const cwd = fileURLToPath(new URL('.', import.meta.url));
const scratch = createCanonicalScratchRoot('uemcp-wire-harness-');
const missing = join(scratch, 'absent-project');
const probe = join(scratch, 'transport-probe.mjs');
// Observe real transport lifetimes and inject responses only in child processes.
writeFileSync(probe, `
import { FakeMcpTransport } from ${JSON.stringify(new URL('./test-mcp-fake-transport.mjs', import.meta.url).href)};
const open = new Set();
let started = 0, injected = false;
const start = FakeMcpTransport.prototype.start;
const close = FakeMcpTransport.prototype.close;
const send = FakeMcpTransport.prototype.send;
FakeMcpTransport.prototype.start = async function () {
  await start.call(this); open.add(this); started++;
};
FakeMcpTransport.prototype.close = async function () {
  try { await close.call(this); } finally { open.delete(this); }
};
FakeMcpTransport.prototype.send = async function (message) {
  const first = message.result?.content?.[0];
  if (!injected && process.env.UEMCP_WIRE_FAULT && first?.type === 'text'
      && first.text.includes('"projectName"')) {
    injected = true;
    if (process.env.UEMCP_WIRE_FAULT === 'error') {
      message.result.isError = true; first.text = 'Error in project_info: injected read failure';
    } else if (process.env.UEMCP_WIRE_FAULT === 'non-text') {
      first.type = 'image';
    } else if (process.env.UEMCP_WIRE_FAULT === 'json') {
      first.text = '{malformed JSON';
    }
  }
  return send.call(this, message);
};
process.on('exit', () => console.log('WIRE_TRANSPORTS ' + JSON.stringify({ started, open: open.size, injected })));
`);
const casesFrom = output => output.split(/\r?\n/).filter(line => line.startsWith('UEMCP_CASE '))
  .map(line => JSON.parse(line.slice('UEMCP_CASE '.length)));
function run({ invalid = false, mode = false, project, fault } = {}) {
  const env = { ...process.env, UEMCP_CASE_EVIDENCE: '1' };
  delete env.UNREAL_PROJECT_ROOT; delete env.UEMCP_PROJECT_ATTACH_MODE; delete env.UEMCP_WIRE_FAULT;
  if (invalid) env.UNREAL_PROJECT_ROOT = missing;
  if (mode) env.UEMCP_PROJECT_ATTACH_MODE = 'env';
  if (fault) env.UEMCP_WIRE_FAULT = fault;
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(probe).href,
    'test-mcp-wire.mjs', ...(project ? ['--project', project] : [])], {
    cwd, env, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(result.error, undefined);
  const output = result.stdout + result.stderr;
  const summary = result.stdout.match(/Passed:\s*(\d+)\s*\r?\n\s*Failed:\s*(\d+)\s*\r?\n\s*Total:\s*(\d+)/);
  assert.ok(summary, `harness must reach its summary: ${output.slice(-1800)}`);
  const lifecycle = JSON.parse(result.stdout.match(/^WIRE_TRANSPORTS (.+)$/m)?.[1] ?? 'null');
  assert.ok(lifecycle && lifecycle.started >= 9, 'later sections must execute');
  assert.equal(lifecycle.open, 0, 'all started transports closed, including failing sections');
  return { status: result.status, output, cases: casesFrom(result.stdout), lifecycle,
    passed: Number(summary[1]), failed: Number(summary[2]), total: Number(summary[3]) };
}
function assertPass(result) {
  assert.equal(result.status, 0, result.output.slice(-1200));
  assert.equal(result.failed, 0);
  assert.equal(result.passed, 64, 'all original 64 assertions retained');
  assert.equal(result.cases.length, 64);
  assert.ok(result.cases.every(row => row.state === 'passed'));
}
function assertFailAndContinue(result) {
  assert.notEqual(result.status, 0);
  assert.ok(result.failed > 0);
  assert.ok(result.cases.some(row => row.name === 'missing required param produces isError:true' && row.state === 'passed'));
  assert.ok(result.cases.some(row => row.name === 're-enabled tool reappears in tools/list' && row.state === 'passed'));
  assert.ok(result.cases.some(row => row.name.startsWith('max_bytes arrives as number 1024') && row.state === 'passed'));
  assert.doesNotMatch(result.output, /SyntaxError:/, 'no uncaught JSON parser crash');
}
async function check(name, fn) {
  try { await fn(); t.assert(true, `wire harness: ${name}`); }
  catch (error) { t.assert(false, `wire harness: ${name}`, error.stack); }
}
try {
  let baseline;
  await check('cleared context executes all retained assertions and closes every transport', () => {
    baseline = run(); assertPass(baseline);
  });
  for (const mode of [false, true]) {
    await check(`invalid ambient root with env mode ${mode} preserves all retained cases`, () => {
      const result = run({ invalid: true, mode }); assertPass(result);
      assert.deepEqual(result.cases, baseline.cases);
    });
  }
  await check('explicit owned consumer root still runs the retained real-handler assertions', () => {
    const project = join(scratch, 'consumer');
    mkdirSync(join(project, 'Config'), { recursive: true });
    mkdirSync(join(project, 'Content', 'Blueprints'), { recursive: true });
    writeFileSync(join(project, 'WireConsumer.uproject'), '{"FileVersion":3}');
    writeFileSync(join(project, 'Config', 'DefaultGameplayTags.ini'),
      '[/Script/GameplayTags.GameplayTagsSettings]\n+GameplayTagList=(Tag="Owned.Consumer.Tag",DevComment="owned")\n');
    const result = run({ project, invalid: true, mode: true }); assertPass(result);
    assert.ok(result.output.includes(project), 'explicit selected root is reported');
  });
  await check('explicit missing consumer root fails usefully and completes later sections', () => {
    const result = run({ project: missing }); assertFailAndContinue(result);
    assert.match(result.output, /project_info.*expected successful MCP text result/);
    assert.match(result.output, /ENOENT/);
  });
  for (const fault of ['error', 'non-text', 'json']) {
    await check(`${fault} reply fault reports failure and closes transports without aborting later tests`, () => {
      const result = run({ fault }); assertFailAndContinue(result);
      assert.equal(result.lifecycle.injected, true);
      assert.match(result.output, fault === 'json' ? /project_info: malformed JSON text/ : /project_info: expected successful MCP text result/);
    });
  }
} finally { cleanupCanonicalScratchRoot(scratch, 'uemcp-wire-harness-'); }
process.exitCode = t.summary() > 0 ? 1 : 0;
