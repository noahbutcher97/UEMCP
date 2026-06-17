// Shared scaffold for opt-in live-editor smoke scripts.
//
// The harness keeps live smokes safe to invoke from automation: no live opt-in
// means a clean skip, an opted-in run requires an explicit project source, and
// a down editor is reported as a skip rather than as a feature failure.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import yaml from 'js-yaml';
import { ConnectionManager } from './connection-manager.mjs';
import { initActorsTools } from './actors-tcp-tools.mjs';
import { initBlueprintsWriteTools } from './blueprints-write-tcp-tools.mjs';
import { initMenhanceTools } from './menhance-tcp-tools.mjs';
import { initM5EditorUtilityTools } from './m5-editor-utility-tools.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOOLS_YAML = join(SERVER_DIR, '..', 'tools.yaml');
const DEFAULT_CLEANUP_DELAYS_MS = [500, 1500, 5000, 15000];

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseEnvInt(env, key, fallback) {
  const value = Number.parseInt(env[key] || String(fallback), 10);
  return Number.isFinite(value) ? value : fallback;
}

export function evaluateLiveSmokeGate(env = process.env) {
  if (env.UEMCP_LIVE_SMOKE !== '1') {
    return {
      shouldRun: false,
      skipped: true,
      exitCode: 0,
      reason: 'set UEMCP_LIVE_SMOKE=1 to allow live editor mutations',
    };
  }

  const explicitSmokeRoot = (env.UEMCP_LIVE_PROJECT_ROOT || '').trim();
  const explicitEnvRoot = env.UEMCP_PROJECT_ATTACH_MODE === 'env'
    ? (env.UNREAL_PROJECT_ROOT || '').trim()
    : '';
  const projectRoot = explicitSmokeRoot || explicitEnvRoot;
  if (!projectRoot) {
    return {
      shouldRun: false,
      skipped: false,
      exitCode: 2,
      code: 'BLOCKED_CONFIG',
      reason: 'An explicit project is required when UEMCP_LIVE_SMOKE=1; pass --project, select a target, or set UEMCP_PROJECT_ATTACH_MODE=env with UNREAL_PROJECT_ROOT.',
    };
  }

  return {
    shouldRun: true,
    skipped: false,
    exitCode: 0,
    projectRoot,
  };
}

export function loadLiveSmokeTools({
  toolsYamlPath = DEFAULT_TOOLS_YAML,
  pythonExecEnabled = false,
} = {}) {
  const toolsData = yaml.load(readFileSync(toolsYamlPath, 'utf8'));
  initBlueprintsWriteTools(toolsData);
  initActorsTools(toolsData);
  initMenhanceTools(toolsData);
  initM5EditorUtilityTools(toolsData, { pythonExecEnabled });
  return toolsData;
}

export function createLiveSmokeConnectionManager(projectRoot, env = process.env, overrides = {}) {
  return new ConnectionManager({
    projectRoot,
    projectName: env.UNREAL_PROJECT_NAME || '',
    tcpPortExisting: parseEnvInt(env, 'UNREAL_TCP_PORT_EXISTING', 55557),
    tcpPortCustom: parseEnvInt(env, 'UNREAL_TCP_PORT_CUSTOM', 55558),
    tcpTimeoutMs: parseEnvInt(env, 'UNREAL_TCP_TIMEOUT_MS', 30000),
    rcPort: parseEnvInt(env, 'UNREAL_RC_PORT', 30010),
    autoDetect: true,
    ...overrides,
  });
}

export async function probeEditor(connectionManager) {
  try {
    const reachable = await connectionManager.isLayerAvailable('tcp-55558', true);
    const status = connectionManager.getStatus()?.['tcp-55558'];
    return {
      reachable,
      status,
      reason: reachable ? '' : `tcp-55558 unavailable: ${JSON.stringify(status)}`,
    };
  } catch (err) {
    return {
      reachable: false,
      status: null,
      reason: err?.message || String(err),
    };
  }
}

export function formatLiveSmokeSkip(name, reason) {
  return `⊘ skipped ${name}: ${reason}`;
}

export async function prepareLiveSmoke({
  name = 'live-smoke',
  env = process.env,
  log = console.log,
  errorLog = console.error,
  probe = true,
  connectionManagerOverrides = {},
} = {}) {
  const gate = evaluateLiveSmokeGate(env);
  if (!gate.shouldRun) {
    const line = gate.skipped
      ? formatLiveSmokeSkip(name, gate.reason)
      : `${name}: ${gate.reason}`;
    (gate.skipped ? log : errorLog)(line);
    return {
      ready: false,
      skipped: gate.skipped,
      exitCode: gate.exitCode,
      reason: gate.reason,
    };
  }

  loadLiveSmokeTools();
  const cm = createLiveSmokeConnectionManager(gate.projectRoot, env, connectionManagerOverrides);

  if (probe) {
    const probeResult = await probeEditor(cm);
    if (!probeResult.reachable) {
      log(formatLiveSmokeSkip(name, probeResult.reason));
      return {
        ready: false,
        skipped: true,
        exitCode: 0,
        reason: probeResult.reason,
        cm,
      };
    }
    log(`PASS tcp-55558 layer: ${JSON.stringify(probeResult.status)}`);
  }

  return {
    ready: true,
    skipped: false,
    exitCode: 0,
    projectRoot: gate.projectRoot,
    cm,
  };
}

export function unwrapLiveSmokeResponse(label, response) {
  if (label === 'sample_pie_actor_state' && typeof response?.sample_count === 'number') {
    return response;
  }
  if ((label === 'wait_for_pie_actor_stable' || label === 'actor_readiness') && typeof response?.stable === 'boolean') {
    return response;
  }
  if (label === 'get_pie_actor_state' && response?.transform) {
    return response;
  }
  if (!response || response.status !== 'success') {
    throw new Error(`${label} failed: ${JSON.stringify(response)}`);
  }
  return response.result ?? response;
}

export function pieSelectorFromSessionState(session) {
  const defaultPIEInstance = session?.default_pie_instance;
  if (Number.isInteger(defaultPIEInstance) && defaultPIEInstance >= 0) {
    return { pie_instance: defaultPIEInstance };
  }

  const firstContext = Array.isArray(session?.contexts)
    ? session.contexts.find((context) => Number.isInteger(context?.pie_instance) && context.pie_instance >= 0)
    : null;
  return firstContext ? { pie_instance: firstContext.pie_instance } : {};
}

export function createLiveSmokeCall({
  summarize = (_label, result) => result,
  log = console.log,
  unwrap = unwrapLiveSmokeResponse,
} = {}) {
  return async function call(label, fn) {
    const result = unwrap(label, await fn());
    log(`PASS ${label}: ${JSON.stringify(summarize(label, result))}`);
    return result;
  };
}

export async function cleanupWithBackoff(label, fn, {
  delaysMs = DEFAULT_CLEANUP_DELAYS_MS,
  log = console.log,
} = {}) {
  let lastError = null;
  for (const delay of delaysMs) {
    await sleep(delay);
    try {
      const response = await fn();
      log(`CLEAN ${label}: ${JSON.stringify(response)}`);
      return response;
    } catch (err) {
      lastError = err;
      log(`CLEAN ${label} retry after ${delay}ms failed: ${err.message}`);
    }
  }
  throw lastError;
}

export async function stopPIEAndWaitForStopped({
  stop,
  getState,
  delaysMs = DEFAULT_CLEANUP_DELAYS_MS,
  unwrap = unwrapLiveSmokeResponse,
  log = console.log,
} = {}) {
  if (typeof stop !== 'function') {
    throw new TypeError('stopPIEAndWaitForStopped requires a stop function');
  }
  if (typeof getState !== 'function') {
    throw new TypeError('stopPIEAndWaitForStopped requires a getState function');
  }

  let lastError = null;
  let lastStopResponse = null;
  for (const delay of delaysMs) {
    try {
      lastStopResponse = await stop();
    } catch (err) {
      lastError = err;
      log(`CLEAN stop_pie retry before ${delay}ms wait failed: ${err.message}`);
    }

    await sleep(delay);

    try {
      const stateResponse = await getState();
      const state = unwrap('final_pie_state', stateResponse);
      if (!state.pie_running) {
        return { stop: lastStopResponse, state, stateResponse };
      }
      lastError = new Error(`PIE still running: ${JSON.stringify(state)}`);
      log(`CLEAN final_pie_state retry after ${delay}ms failed: ${lastError.message}`);
    } catch (err) {
      lastError = err;
      log(`CLEAN final_pie_state retry after ${delay}ms failed: ${err.message}`);
    }
  }

  throw lastError || new Error('PIE stop did not produce a session state');
}

export function isNotFoundCleanupError(err) {
  return /not found|does not exist|missing asset|missing actor|asset_not_found|actor_not_found|not_found/i.test(err?.message || '');
}

export function isNonMutatingNameConflict(err) {
  return /already exists|exists already|duplicate|blueprint_exists|actor_exists|name conflict|name.*exists|object.*exists/i.test(err?.message || '');
}

export function isTransientPIEActorLookupError(err) {
  const code = err?.code || err?.wireError?.code;
  if (code === 'ACTOR_NOT_FOUND' || code === 'PIE_WORLD_NOT_FOUND') {
    return true;
  }
  return /Actor was not found in the selected PIE world|PIE world instance \d+ was not found/i.test(err?.message || '');
}

export async function runCleanup(label, fn, errors, {
  tolerateNotFound = false,
  delaysMs = DEFAULT_CLEANUP_DELAYS_MS,
  log = console.log,
  errorLog = console.error,
} = {}) {
  try {
    await cleanupWithBackoff(label, fn, { delaysMs, log });
  } catch (err) {
    if (tolerateNotFound && isNotFoundCleanupError(err)) {
      log(`CLEAN ${label}: tolerated not-found cleanup result: ${err.message}`);
      return;
    }
    errors.push(new Error(`${label}: ${err.message}`));
    errorLog(`CLEAN ${label} failed permanently: ${err.stack || err.message}`);
  }
}
