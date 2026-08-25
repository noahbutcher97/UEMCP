// test-editor-readiness.mjs — editor readiness classification + bounded wait.
//
// Design: docs/superpowers/specs/2026-08-25-editor-readiness-wait-design.md

import { classifyProcessPhase, clampWaitTimeout, createEditorProbe, readinessHint, waitForEditorReady } from './editor-readiness.mjs';
import { TestRunner } from './test-helpers.mjs';
import { ConnectionManager } from './connection-manager.mjs';

const t = new TestRunner('editor readiness');

// ── classifyProcessPhase ─────────────────────────────────────────
// Waiting is futile when nothing is running: the caller has not launched the
// editor, and no amount of polling changes that.
{
  const phase = classifyProcessPhase({ processes: [], attachedUproject: 'D:/Proj/Proj.uproject' });
  t.assert(phase === 'no_editor_process', `empty process list classifies as no_editor_process (got ${phase})`);
}

// An editor running a DIFFERENT project can never become ready for this one,
// so waiting on it is futile in a way worth naming (the D136 drift class).
{
  const processes = [{ pid: 1, cmdLine: 'UnrealEditor.exe D:/Other/Other.uproject', commandLineAvailable: true, uprojectPath: 'D:/Other/Other.uproject' }];
  const phase = classifyProcessPhase({ processes, attachedUproject: 'D:/Proj/Proj.uproject' });
  t.assert(phase === 'wrong_project', `editor for another project classifies as wrong_project (got ${phase})`);
}

// ── waitForEditorReady ───────────────────────────────────────────
// The naive version burns the whole budget to tell a caller they never
// launched the editor. A futile phase must cost nothing.
{
  let slept = 0;
  let probes = 0;
  const res = await waitForEditorReady({
    listProcesses: () => [],
    attachedUproject: 'D:/Proj/Proj.uproject',
    probe: async () => { probes++; return { ok: false }; },
    timeoutMs: 30000,
    sleep: async (ms) => { slept += ms; },
  });
  t.assert(res.ready === false, 'no editor process is not ready');
  t.assert(res.phase === 'no_editor_process', `phase surfaces the reason (got ${res.phase})`);
  t.assert(slept === 0, `futile phase sleeps zero ms (slept ${slept})`);
  t.assert(probes === 0, `futile phase issues no transport probe (probed ${probes})`);
}

// The real case: our editor is up but still initializing, so the probe
// refuses until it does not.
{
  const processes = [{ pid: 7, cmdLine: 'x', commandLineAvailable: true, uprojectPath: 'D:/Proj/Proj.uproject' }];
  let probes = 0;
  const res = await waitForEditorReady({
    listProcesses: () => processes,
    attachedUproject: 'D:/Proj/Proj.uproject',
    probe: async () => {
      probes++;
      if (probes < 3) return { ok: false, error: { nativeCode: 'ECONNREFUSED' } };
      return { ok: true, editor: { project_name: 'Proj', world_path: '/Game/Maps/M' } };
    },
    timeoutMs: 30000,
    sleep: async () => {},
  });
  t.assert(res.ready === true, `becomes ready once the probe answers (ready=${res.ready})`);
  t.assert(res.phase === 'ready', `terminal phase is ready (got ${res.phase})`);
  t.assert(res.attempts === 3, `reports how many probes it took (got ${res.attempts})`);
  t.assert(res.editor?.world_path === '/Game/Maps/M', 'carries editor identity from the successful probe');
}

// Exhausting the budget is a normal outcome, not an error: the caller simply
// calls again. It must terminate, and it must report enough for the caller to
// see progress across calls.
{
  const processes = [{ pid: 7, cmdLine: 'x', commandLineAvailable: true, uprojectPath: 'D:/Proj/Proj.uproject' }];
  let clock = 0;
  const res = await waitForEditorReady({
    listProcesses: () => processes,
    attachedUproject: 'D:/Proj/Proj.uproject',
    probe: async () => ({ ok: false, error: { nativeCode: 'ECONNREFUSED' } }),
    timeoutMs: 5000,
    sleep: async (ms) => { clock += ms; },
    now: () => clock,
  });
  t.assert(res.ready === false, 'budget exhaustion reports not-ready');
  t.assert(res.attempts > 1, `retried while the budget lasted (attempts ${res.attempts})`);
  t.assert(res.elapsed_ms >= 5000, `stopped at or after the ceiling (elapsed ${res.elapsed_ms})`);
  t.assert(res.last_error?.nativeCode === 'ECONNREFUSED', 'surfaces the last transport error');
}

// Backoff must actually grow, or a long wait becomes a probe flood.
{
  const processes = [{ pid: 7, cmdLine: 'x', commandLineAvailable: true, uprojectPath: 'D:/Proj/Proj.uproject' }];
  const sleeps = [];
  let clock = 0;
  await waitForEditorReady({
    listProcesses: () => processes,
    attachedUproject: 'D:/Proj/Proj.uproject',
    probe: async () => ({ ok: false }),
    timeoutMs: 10000,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
  });
  t.assert(sleeps.length >= 3, `slept between probes (${sleeps.length} sleeps)`);
  t.assert(sleeps[1] > sleeps[0], `backoff grows (${sleeps[0]} -> ${sleeps[1]})`);
  t.assert(Math.max(...sleeps) <= 2000, `backoff is capped (max ${Math.max(...sleeps)})`);
}

// ── clampWaitTimeout ─────────────────────────────────────────────
// The ceiling exists to stay under MCP client timeouts we cannot inspect, so
// an over-large request is clamped rather than honoured or rejected.
{
  t.assert(clampWaitTimeout(undefined) === 30000, `default is the safe ceiling (got ${clampWaitTimeout(undefined)})`);
  t.assert(clampWaitTimeout(600000) === 55000, `over-large clamps down (got ${clampWaitTimeout(600000)})`);
  t.assert(clampWaitTimeout(10) === 1000, `too-small clamps up (got ${clampWaitTimeout(10)})`);
  t.assert(clampWaitTimeout(12000) === 12000, `in-range passes through (got ${clampWaitTimeout(12000)})`);
  t.assert(clampWaitTimeout('nonsense') === 30000, 'non-numeric falls back to the default');
}

// ── createEditorProbe ────────────────────────────────────────────
// Takes a transport function directly rather than a ConnectionManager, so it
// structurally cannot enqueue: a wait serialized behind the per-layer queue
// would freeze the layer it exists to make usable.
{
  const probe = createEditorProbe({
    tcpFn: async (_port, type) => (type === 'get_editor_state'
      ? { status: 'success', result: { project_name: 'Proj', world_path: '/Game/Maps/M' } }
      : { status: 'success' }),
    port: 55558,
  });
  const res = await probe();
  t.assert(res.ok === true, `full readiness reports ok (got ${res.ok})`);
  t.assert(res.editor?.project_name === 'Proj', 'carries project identity');
  t.assert(res.editor?.world_path === '/Game/Maps/M', 'carries world context');
}

// Listener bound but the world not resolved yet is its own phase, so a caller
// is not told 'ready' while the map is still loading.
{
  const probe = createEditorProbe({
    tcpFn: async (_port, type) => { if (type === 'ping') return { status: 'success' }; throw new Error('not ready'); },
    port: 55558,
  });
  const res = await probe();
  t.assert(res.ok === false, 'ping alone is not readiness');
  t.assert(res.phase === 'transport_ready', `names the intermediate phase (got ${res.phase})`);
}

// Nothing listening at all is the ordinary pre-init case.
{
  const probe = createEditorProbe({ tcpFn: async () => { const e = new Error('refused'); e.code = 'ECONNREFUSED'; throw e; }, port: 55558 });
  const res = await probe();
  t.assert(res.ok === false, 'refused connection is not ready');
  t.assert(res.phase === 'initializing', `classifies as initializing (got ${res.phase})`);
  t.assert(res.error?.nativeCode === 'ECONNREFUSED', 'surfaces the native cause');
}
// ── ConnectionManager.getTcpTransport ────────────────────────────
// The probe needs the effective transport without going through send().
// It must honour the mock seam, or readiness becomes untestable offline.
{
  let sawPort = null;
  const fake = async (port) => { sawPort = port; return { status: 'success' }; };
  const cm = new ConnectionManager({ tcpPortCustom: 55558, tcpTimeoutMs: 5000, tcpCommandFn: fake });
  const transport = cm.getTcpTransport();
  t.assert(typeof transport === 'function', 'exposes a transport function');
  await transport(1234, 'ping', {}, 100);
  t.assert(sawPort === 1234, `returns the injected mock when configured (sawPort=${sawPort})`);

  const real = new ConnectionManager({ tcpPortCustom: 55558, tcpTimeoutMs: 5000 });
  t.assert(typeof real.getTcpTransport() === 'function', 'falls back to the real transport with no mock');
  t.assert(real.getTcpTransport() !== transport, "fallback is not the mock");
}

// ── readinessHint ────────────────────────────────────────────────
// The hint is what stops a caller re-polling a futile phase forever, so each
// phase must say something different and actionable.
{
  const launch = readinessHint({ ready: false, phase: 'no_editor_process' });
  t.assert(/launch/i.test(launch), `no_editor_process tells the caller to launch (got: ${launch})`);

  const drift = readinessHint({ ready: false, phase: 'wrong_project' });
  t.assert(/different project|another project/i.test(drift), `wrong_project names the drift (got: ${drift})`);
  t.assert(!/call .*again/i.test(drift), 'wrong_project does NOT invite re-polling a futile wait');

  const again = readinessHint({ ready: false, phase: 'initializing' });
  t.assert(/again/i.test(again), `initializing invites another call (got: ${again})`);

  const done = readinessHint({ ready: true, phase: 'ready' });
  t.assert(/ready/i.test(done) && !/again/i.test(done), `ready does not ask for another call (got: ${done})`);
}

// A missing transport is a wiring bug, not a slow editor. Without this it
// throws inside the probe, gets swallowed by the not-ready path, and reports
// phase=initializing forever — indistinguishable from a real cold start.
// Observed live: a bad call site produced 3 minutes of "initializing".
{
  let threw = null;
  try { createEditorProbe({ tcpFn: undefined, port: 55558 }); }
  catch (e) { threw = e; }
  t.assert(threw !== null, 'constructing a probe without a transport throws');
  t.assert(/transport|tcpFn/i.test(String(threw?.message)), `error names the missing dependency (got: ${threw?.message})`);
}

{
  let threw = null;
  try { createEditorProbe({ tcpFn: async () => ({}), port: undefined }); }
  catch (e) { threw = e; }
  t.assert(threw !== null, 'constructing a probe without a port throws');
  t.assert(/port/i.test(String(threw?.message)), `error names the missing port (got: ${threw?.message})`);
}

// Observed live: get_editor_state answers before any map is loaded, so
// world_path can be null on a genuinely ready editor. Requiring a world would
// mean never becoming ready for asset-only work with no map open. Readiness is
// therefore "the editor answers", and the null world is reported rather than
// hidden.
{
  const probe = createEditorProbe({
    tcpFn: async () => ({ status: 'success', result: { project_name: 'P', world_path: null } }),
    port: 55558,
  });
  const res = await probe();
  t.assert(res.ok === true, 'an editor with no map loaded is still ready');
  t.assert(res.editor.world_path === null, 'the absent world is reported, not concealed');
}

process.exit(t.summary());
