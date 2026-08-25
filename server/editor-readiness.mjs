// editor-readiness.mjs — classify editor readiness and wait for it explicitly.
//
// Design: docs/superpowers/specs/2026-08-25-editor-readiness-wait-design.md

import { canonicalEditorProjectPath } from './editor-processes.mjs';
import { normalizeComparisonPath } from './project-identity.mjs';

/**
 * Classify readiness from process state alone.
 *
 * @param {{processes: object[], attachedUproject: string|null}} input
 * @returns {'no_editor_process'|'wrong_project'|'process_present'}
 */
export function classifyProcessPhase({ processes, attachedUproject }) {
  if (!processes || processes.length === 0) return 'no_editor_process';
  if (!attachedUproject) return 'process_present';
  const target = normalizeComparisonPath(attachedUproject);
  const matches = processes.some((proc) => {
    const path = canonicalEditorProjectPath(proc);
    // A process whose command line is unavailable cannot be ruled out, so it
    // counts as ours rather than triggering a false wrong_project verdict.
    if (!path) return true;
    return path === target;
  });
  return matches ? 'process_present' : 'wrong_project';
}

// Phases where waiting can never succeed. Returning immediately is the point:
// spending the budget to report "you never launched it" is the obvious
// failure of a naive implementation.
const FUTILE_PHASES = new Set(['no_editor_process', 'wrong_project']);

// Backoff is policy, not preference: exposing it as a knob invites hammering
// an editor that is already working as fast as it can.
export const INITIAL_BACKOFF_MS = 500;
export const MAX_BACKOFF_MS = 2000;

// Per-call ceiling. The upper bound keeps a single call under the MCP client's
// own timeout, which UEMCP cannot inspect: a call killed mid-wait would surface
// as a transport failure, i.e. the very confusion this tool exists to remove.
export const DEFAULT_WAIT_MS = 30_000;
export const MIN_WAIT_MS = 1_000;
export const MAX_WAIT_MS = 55_000;

/**
 * Clamp a requested per-call ceiling into the supported range.
 * Out-of-range input is clamped rather than rejected; the caller is told the
 * effective value instead of having the call fail over a tuning parameter.
 *
 * @param {unknown} requested
 * @returns {number}
 */
export function clampWaitTimeout(requested) {
  const n = Number(requested);
  if (!Number.isFinite(n)) return DEFAULT_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, Math.trunc(n)));
}

/**
 * Wait, bounded, for the editor transport to become usable.
 *
 * @param {object} input
 * @param {() => object[]} input.listProcesses
 * @param {string|null} input.attachedUproject
 * @param {() => Promise<{ok: boolean}>} input.probe
 * @param {number} input.timeoutMs per-call ceiling
 * @param {(ms: number) => Promise<void>} input.sleep injected for tests
 */
export async function waitForEditorReady({
  listProcesses,
  attachedUproject,
  probe,
  timeoutMs,
  sleep,
  now = () => Date.now(),
}) {
  const started = now();
  const processPhase = classifyProcessPhase({ processes: listProcesses(), attachedUproject });
  if (FUTILE_PHASES.has(processPhase)) {
    return { ready: false, phase: processPhase, elapsed_ms: 0, attempts: 0, editor: null, last_error: null };
  }

  let attempts = 0;
  let phase = processPhase;
  let lastError = null;
  let delay = INITIAL_BACKOFF_MS;

  // Deadline check happens before each probe, so a call never overruns its
  // ceiling waiting on one more round-trip.
  while (now() - started < timeoutMs) {
    attempts++;
    const result = await probe();
    if (result?.ok) {
      return {
        ready: true,
        phase: 'ready',
        elapsed_ms: now() - started,
        attempts,
        editor: result.editor ?? null,
        last_error: null,
      };
    }
    phase = result?.phase || 'initializing';
    lastError = result?.error ?? null;
    if (now() - started >= timeoutMs) break;
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_BACKOFF_MS);
  }

  return { ready: false, phase, elapsed_ms: now() - started, attempts, editor: null, last_error: lastError };
}

/**
 * Build the readiness probe.
 *
 * Takes the transport function directly rather than a ConnectionManager. That
 * is deliberate: ConnectionManager.send() serializes through a per-layer queue
 * that chains promises, so a bounded wait running inside it would block every
 * other call on that layer for the whole budget — freezing the layer this tool
 * exists to make usable. Depending only on tcpFn makes that mistake impossible
 * to introduce here.
 *
 * Readiness is get_editor_state, not ping: a successful round-trip confirms the
 * listener AND world context, where ping proves only that the socket is bound.
 *
 * @param {{tcpFn: Function, port: number, timeoutMs?: number}} deps
 * @returns {() => Promise<{ok: boolean, phase?: string, editor?: object, error?: object}>}
 */
export function createEditorProbe({ tcpFn, port, timeoutMs = 3000 }) {
  // Fail loudly at construction. A missing transport otherwise throws inside
  // the probe, gets absorbed by the not-ready path, and reports "initializing"
  // indefinitely — a wiring bug wearing the costume of a slow editor.
  if (typeof tcpFn !== 'function') {
    throw new Error('createEditorProbe requires a tcpFn transport function');
  }
  if (!Number.isFinite(Number(port))) {
    throw new Error(`createEditorProbe requires a numeric port (got ${port})`);
  }
  return async function probeEditor() {
    try {
      const state = await tcpFn(port, 'get_editor_state', {}, timeoutMs);
      const result = state?.result ?? null;
      if (result) {
        return {
          ok: true,
          phase: 'ready',
          editor: { project_name: result.project_name ?? null, world_path: result.world_path ?? null },
        };
      }
      return { ok: false, phase: 'transport_ready', error: null };
    } catch (stateError) {
      // get_editor_state failed. Ping separates "listener not up yet" from
      // "listener up, world still resolving" so the caller can see progress.
      try {
        await tcpFn(port, 'ping', {}, timeoutMs);
        return { ok: false, phase: 'transport_ready', error: errorShape(stateError) };
      } catch (pingError) {
        return { ok: false, phase: 'initializing', error: errorShape(pingError) };
      }
    }
  };
}

function errorShape(err) {
  if (!err) return null;
  return {
    code: err.code || err.name || null,
    nativeCode: err.code || err.nativeCode || null,
    message: String(err.message || err).slice(0, 200),
  };
}

/**
 * The next action for a caller, phrased per phase.
 *
 * Futile phases deliberately do NOT suggest calling again: inviting a re-poll
 * of a wait that can never succeed is how a helpful tool becomes a loop.
 *
 * @param {{ready: boolean, phase: string}} outcome
 * @returns {string}
 */
export function readinessHint({ ready, phase }) {
  if (ready) return 'Editor is ready; live tools can be used.';
  switch (phase) {
    case 'no_editor_process':
      return 'No Unreal editor is running. Launch the project, then call wait_for_editor.';
    case 'wrong_project':
      return 'An editor is running, but for a different project than the attached one. Waiting cannot succeed — launch this project, or attach the one already open.';
    case 'transport_ready':
      return 'Listener is up but the world is still loading. Call wait_for_editor again to continue waiting.';
    default:
      return 'Editor is initializing. Call wait_for_editor again to continue waiting.';
  }
}
