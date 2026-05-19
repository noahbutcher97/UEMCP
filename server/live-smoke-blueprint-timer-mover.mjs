// Opt-in live smoke for Blueprint timer mover authoring.
//
// Preconditions:
//   - Unreal Editor is open with UEMCP loaded.
//   - UNREAL_PROJECT_ROOT points at the target project.
//   - Set UEMCP_LIVE_SMOKE=1 to acknowledge this creates/deletes temp content.
//
// Run:
//   cd server
//   $env:UNREAL_PROJECT_ROOT='D:\Path\To\Project'
//   $env:UEMCP_LIVE_SMOKE='1'
//   node live-smoke-blueprint-timer-mover.mjs

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import yaml from 'js-yaml';
import { ConnectionManager } from './connection-manager.mjs';
import { initBlueprintsWriteTools, executeBlueprintsWriteTool } from './blueprints-write-tcp-tools.mjs';
import { initActorsTools, executeActorsTool } from './actors-tcp-tools.mjs';
import { initMenhanceTools, executeMenhanceTool } from './menhance-tcp-tools.mjs';
import { initM5EditorUtilityTools, executeM5EditorUtilityTool } from './m5-editor-utility-tools.mjs';

if (process.env.UEMCP_LIVE_SMOKE !== '1') {
  console.error('Refusing to run: set UEMCP_LIVE_SMOKE=1 to allow live editor mutations.');
  process.exit(2);
}

const projectRoot = process.env.UNREAL_PROJECT_ROOT;
if (!projectRoot) {
  console.error('Refusing to run: UNREAL_PROJECT_ROOT is required.');
  process.exit(2);
}

const toolsData = yaml.load(readFileSync('../tools.yaml', 'utf8'));
initBlueprintsWriteTools(toolsData);
initActorsTools(toolsData);
initMenhanceTools(toolsData);
initM5EditorUtilityTools(toolsData, { pythonExecEnabled: false });

const cm = new ConnectionManager({
  projectRoot,
  projectName: process.env.UNREAL_PROJECT_NAME || '',
  tcpPortExisting: Number.parseInt(process.env.UNREAL_TCP_PORT_EXISTING || '55557', 10),
  tcpPortCustom: Number.parseInt(process.env.UNREAL_TCP_PORT_CUSTOM || '55558', 10),
  tcpTimeoutMs: Number.parseInt(process.env.UNREAL_TCP_TIMEOUT_MS || '30000', 10),
  rcPort: Number.parseInt(process.env.UNREAL_RC_PORT || '30010', 10),
  autoDetect: true,
});

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
const ownerToken = randomUUID().replace(/-/g, '').slice(0, 8);
const bpName = `BP_UEMCP_TimerMover_${stamp}_${ownerToken}`;
const actorName = `UEMCP_TimerMover_${stamp}_${ownerToken}`;
const bpPath = `/Game/UEMCP/${bpName}`;
const callbackFunction = 'MoveStep';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function unwrap(label, response) {
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

function summarize(label, result) {
  if (label === 'compile_and_save_blueprint') {
    return {
      compiled_ok: result.compiled_ok,
      saved: result.saved,
      num_errors: result.compile?.num_errors,
      num_warnings: result.compile?.num_warnings,
      package_path: result.save?.package_path,
    };
  }
  if (label === 'sample_pie_actor_state') {
    return {
      sample_count: result.sample_count,
      first_location: result.first?.result?.transform?.location,
      last_location: result.last?.result?.transform?.location,
      delta: result.delta,
    };
  }
  if (label === 'wait_for_pie_actor_stable' || (label === 'actor_readiness' && typeof result.stable === 'boolean')) {
    return {
      stable: result.stable,
      sample_count: result.sample_count,
      final_location: result.final?.result?.transform?.location,
    };
  }
  if (label === 'get_pie_session_state') {
    return {
      pie_running: result.pie_running,
      active_context_count: result.active_context_count,
    };
  }
  if (label === 'get_pie_actor_state' || label === 'actor_readiness') {
    return {
      actor: result.actor?.name || result.name,
      location: result.transform?.location,
      rotation: result.transform?.rotation,
      scale: result.transform?.scale,
    };
  }
  return result;
}

async function call(label, fn) {
  const result = unwrap(label, await fn());
  console.log(`PASS ${label}: ${JSON.stringify(summarize(label, result))}`);
  return result;
}

async function cleanupWithBackoff(label, fn) {
  let lastError = null;
  for (const delay of [500, 1500, 5000, 15000]) {
    await sleep(delay);
    try {
      const response = await fn();
      console.log(`CLEAN ${label}: ${JSON.stringify(response)}`);
      return response;
    } catch (err) {
      lastError = err;
      console.log(`CLEAN ${label} retry after ${delay}ms failed: ${err.message}`);
    }
  }
  throw lastError;
}

function isNotFoundCleanupError(err) {
  return /not found|does not exist|missing asset|missing actor|asset_not_found|actor_not_found|not_found/i.test(err?.message || '');
}

function isNonMutatingNameConflict(err) {
  return /already exists|exists already|duplicate|blueprint_exists|actor_exists|name conflict|name.*exists|object.*exists/i.test(err?.message || '');
}

async function runCleanup(label, fn, errors, options = {}) {
  try {
    await cleanupWithBackoff(label, fn);
  } catch (err) {
    if (options.tolerateNotFound && isNotFoundCleanupError(err)) {
      console.log(`CLEAN ${label}: tolerated not-found cleanup result: ${err.message}`);
      return;
    }
    errors.push(new Error(`${label}: ${err.message}`));
    console.error(`CLEAN ${label} failed permanently: ${err.stack || err.message}`);
  }
}

function pins(node, direction) {
  return Array.isArray(node?.pins)
    ? node.pins.filter((pin) => !direction || pin.direction === direction)
    : [];
}

function findPin(node, direction, names) {
  const wanted = names.map((name) => name.toLowerCase());
  const found = pins(node, direction).find((pin) => wanted.includes(String(pin.name).toLowerCase()));
  if (!found) {
    throw new Error(`Missing expected ${direction || 'any'} pin ${names.join('/')} on ${node?.node_class || node?.node_id}: ${JSON.stringify(node?.pins || [])}`);
  }
  return found.name;
}

function maybePin(node, direction, names) {
  try {
    return findPin(node, direction, names);
  } catch {
    return null;
  }
}

function firstExecOut(node) {
  const pin = pins(node, 'output').find((candidate) => candidate.category === 'exec')
    || pins(node, 'output').find((candidate) => ['then', 'execute'].includes(String(candidate.name).toLowerCase()));
  if (!pin) throw new Error(`Missing exec output on ${node?.node_class || node?.node_id}: ${JSON.stringify(node?.pins || [])}`);
  return pin.name;
}

function firstExecIn(node) {
  const pin = pins(node, 'input').find((candidate) => candidate.category === 'exec')
    || pins(node, 'input').find((candidate) => ['execute'].includes(String(candidate.name).toLowerCase()));
  if (!pin) throw new Error(`Missing exec input on ${node?.node_class || node?.node_id}: ${JSON.stringify(node?.pins || [])}`);
  return pin.name;
}

function firstNonExecOut(node) {
  const pin = pins(node, 'output').find((candidate) => candidate.category !== 'exec');
  if (!pin) throw new Error(`Missing non-exec output on ${node?.node_class || node?.node_id}: ${JSON.stringify(node?.pins || [])}`);
  return pin.name;
}

async function connect(source, sourcePin, target, targetPin, graphName = callbackFunction) {
  return call('connect_nodes', () => executeBlueprintsWriteTool('connect_nodes', {
    blueprint_name: bpPath,
    graph_name: graphName,
    source_node_id: source.node_id,
    source_pin: sourcePin,
    target_node_id: target.node_id,
    target_pin: targetPin,
  }, cm));
}

async function addFunctionNode(function_name, target, node_position, params = {}, graphName = callbackFunction) {
  try {
    return await call(`add_function_node:${function_name}`, () => executeBlueprintsWriteTool('add_function_node', {
      blueprint_name: bpPath,
      graph_name: graphName,
      function_name,
      target,
      node_position,
      params,
    }, cm));
  } catch (err) {
    throw new Error(`MISSING_K2_SUPPORT add_function_node ${target || '<blueprint>'}.${function_name}: ${err.message}`);
  }
}

async function addMathNode(operation, value_type, node_position, params = {}, graphName = callbackFunction) {
  try {
    return await call(`add_math_node:${operation}:${value_type}`, () => executeBlueprintsWriteTool('add_math_node', {
      blueprint_name: bpPath,
      graph_name: graphName,
      operation,
      value_type,
      node_position,
      params,
    }, cm));
  } catch (err) {
    throw new Error(`MISSING_K2_SUPPORT add_math_node ${operation}/${value_type}: ${err.message}`);
  }
}

async function waitForActorReadiness() {
  let last = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    last = unwrap('get_pie_actor_state', await executeMenhanceTool('get_pie_actor_state', {
      actor_ref: { label: actorName, name: actorName },
    }, cm));
    const location = last.transform?.location;
    if (Array.isArray(location) && Math.abs(location[2] - 120) <= 1) {
      console.log(`PASS actor_readiness: ${JSON.stringify(summarize('actor_readiness', last))}`);
      return last;
    }
    await sleep(100);
  }
  throw new Error(`PIE actor did not reach expected spawn height before sampling: ${JSON.stringify(summarize('actor_readiness', last || {}))}`);
}

async function authorBeginPlayInitialization(timerResult) {
  const timerNode = timerResult.nodes?.find((node) => node.role === 'timer');
  if (!timerNode?.node_id) {
    throw new Error(`MISSING_K2_SUPPORT add_timer did not return timer node metadata: ${JSON.stringify(timerResult)}`);
  }

  const beginPlay = await call('add_event_node:ReceiveBeginPlay', () => executeBlueprintsWriteTool('add_event_node', {
    blueprint_name: bpPath,
    graph_name: 'EventGraph',
    event_name: 'ReceiveBeginPlay',
    node_position: [-520, 0],
  }, cm));
  const self = await call('add_self_reference:EventGraph', () => executeBlueprintsWriteTool('add_self_reference', {
    blueprint_name: bpPath,
    graph_name: 'EventGraph',
    node_position: [-520, 140],
  }, cm));
  const getLocation = await addFunctionNode('K2_GetActorLocation', 'Actor', [-260, 120], {}, 'EventGraph');
  const setStartLocation = await call('add_variable_set:StartLocation:init', () => executeBlueprintsWriteTool('add_variable_set', {
    blueprint_name: bpPath,
    graph_name: 'EventGraph',
    variable_name: 'StartLocation',
    node_position: [40, 0],
  }, cm));
  const setDirection = await call('add_variable_set:Direction:init', () => executeBlueprintsWriteTool('add_variable_set', {
    blueprint_name: bpPath,
    graph_name: 'EventGraph',
    variable_name: 'Direction',
    node_position: [300, 0],
    params: { Direction: 1 },
  }, cm));

  const selfOut = firstNonExecOut(self);
  const getLocationTarget = maybePin(getLocation, 'input', ['self', 'Target']);
  if (getLocationTarget) {
    await connect(self, selfOut, getLocation, getLocationTarget, 'EventGraph');
  }

  await connect(beginPlay, firstExecOut(beginPlay), setStartLocation, firstExecIn(setStartLocation), 'EventGraph');
  await connect(getLocation, firstNonExecOut(getLocation), setStartLocation, findPin(setStartLocation, 'input', ['StartLocation']), 'EventGraph');
  await connect(setStartLocation, firstExecOut(setStartLocation), setDirection, firstExecIn(setDirection), 'EventGraph');
  await connect(setDirection, firstExecOut(setDirection), timerNode, firstExecIn(timerNode), 'EventGraph');
}

async function authorMovementGraph(timerResult) {
  const entry = timerResult.nodes?.find((node) => node.role === 'callback_entry');
  if (!entry?.node_id) {
    throw new Error(`MISSING_K2_SUPPORT add_timer did not return callback_entry metadata: ${JSON.stringify(timerResult)}`);
  }

  const self = await call('add_self_reference', () => executeBlueprintsWriteTool('add_self_reference', {
    blueprint_name: bpPath,
    graph_name: callbackFunction,
    node_position: [0, 120],
  }, cm));
  const getLocation = await addFunctionNode('K2_GetActorLocation', 'Actor', [260, 0]);
  const setLocationForward = await addFunctionNode('K2_SetActorLocation', 'Actor', [1280, 80], {
    bSweep: false,
    bTeleport: false,
  });
  const setLocationReverse = await addFunctionNode('K2_SetActorLocation', 'Actor', [1280, -160], {
    bSweep: false,
    bTeleport: false,
  });
  const branch = await call('add_control_node:Branch', () => executeBlueprintsWriteTool('add_control_node', {
    blueprint_name: bpPath,
    graph_name: callbackFunction,
    node_kind: 'Branch',
    node_position: [930, -180],
  }, cm));
  const axis = await call('add_variable_get:MoveAxis', () => executeBlueprintsWriteTool('add_variable_get', {
    blueprint_name: bpPath,
    graph_name: callbackFunction,
    variable_name: 'MoveAxis',
    node_position: [240, 240],
  }, cm));
  const speed = await call('add_variable_get:MoveSpeed', () => executeBlueprintsWriteTool('add_variable_get', {
    blueprint_name: bpPath,
    graph_name: callbackFunction,
    variable_name: 'MoveSpeed',
    node_position: [240, 420],
  }, cm));
  const moveDistance = await call('add_variable_get:MoveDistance', () => executeBlueprintsWriteTool('add_variable_get', {
    blueprint_name: bpPath,
    graph_name: callbackFunction,
    variable_name: 'MoveDistance',
    node_position: [520, -260],
  }, cm));
  const startLocation = await call('add_variable_get:StartLocation', () => executeBlueprintsWriteTool('add_variable_get', {
    blueprint_name: bpPath,
    graph_name: callbackFunction,
    variable_name: 'StartLocation',
    node_position: [240, -220],
  }, cm));
  const direction = await call('add_variable_get:Direction', () => executeBlueprintsWriteTool('add_variable_get', {
    blueprint_name: bpPath,
    graph_name: callbackFunction,
    variable_name: 'Direction',
    node_position: [240, 540],
  }, cm));
  const setDirection = await call('add_variable_set:Direction:reverse', () => executeBlueprintsWriteTool('add_variable_set', {
    blueprint_name: bpPath,
    graph_name: callbackFunction,
    variable_name: 'Direction',
    node_position: [1080, -180],
  }, cm));
  const distanceFromStart = await addMathNode('Distance', 'Vector', [520, -80]);
  const pastDistance = await addMathNode('GreaterEqual', 'Float', [740, -160]);
  const reverseDirection = await addMathNode('Multiply', 'Float', [760, 520], {
    B: -1,
  });
  const speedTimesDirection = await addMathNode('Multiply', 'Float', [520, 440]);
  const movementDelta = await addMathNode('ScaleVector', 'Vector', [740, 260]);
  const targetLocation = await addMathNode('Add', 'Vector', [930, 80]);

  const selfOut = firstNonExecOut(self);
  for (const node of [getLocation, setLocationForward, setLocationReverse]) {
    const targetPin = maybePin(node, 'input', ['self', 'Target']);
    if (targetPin) {
      await connect(self, selfOut, node, targetPin);
    }
  }

  await connect(entry, firstExecOut(entry), branch, firstExecIn(branch));
  await connect(getLocation, firstNonExecOut(getLocation), distanceFromStart, findPin(distanceFromStart, 'input', ['V1', 'A']));
  await connect(startLocation, firstNonExecOut(startLocation), distanceFromStart, findPin(distanceFromStart, 'input', ['V2', 'B']));
  await connect(distanceFromStart, firstNonExecOut(distanceFromStart), pastDistance, findPin(pastDistance, 'input', ['A']));
  await connect(moveDistance, firstNonExecOut(moveDistance), pastDistance, findPin(pastDistance, 'input', ['B']));
  await connect(pastDistance, firstNonExecOut(pastDistance), branch, findPin(branch, 'input', ['Condition']));
  await connect(branch, findPin(branch, 'output', ['then', 'true']), setDirection, firstExecIn(setDirection));
  await connect(setDirection, firstExecOut(setDirection), setLocationReverse, firstExecIn(setLocationReverse));
  await connect(branch, findPin(branch, 'output', ['else', 'false']), setLocationForward, firstExecIn(setLocationForward));
  await connect(direction, firstNonExecOut(direction), reverseDirection, findPin(reverseDirection, 'input', ['A']));
  await connect(reverseDirection, firstNonExecOut(reverseDirection), setDirection, findPin(setDirection, 'input', ['Direction']));
  await connect(speed, firstNonExecOut(speed), speedTimesDirection, findPin(speedTimesDirection, 'input', ['A']));
  await connect(direction, firstNonExecOut(direction), speedTimesDirection, findPin(speedTimesDirection, 'input', ['B']));
  await connect(axis, firstNonExecOut(axis), movementDelta, findPin(movementDelta, 'input', ['A', 'Vector']));
  await connect(speedTimesDirection, firstNonExecOut(speedTimesDirection), movementDelta, findPin(movementDelta, 'input', ['B', 'Scale']));
  await connect(getLocation, firstNonExecOut(getLocation), targetLocation, findPin(targetLocation, 'input', ['A']));
  await connect(movementDelta, firstNonExecOut(movementDelta), targetLocation, findPin(targetLocation, 'input', ['B']));
  await connect(targetLocation, firstNonExecOut(targetLocation), setLocationForward, findPin(setLocationForward, 'input', ['NewLocation']));
  await connect(targetLocation, firstNonExecOut(targetLocation), setLocationReverse, findPin(setLocationReverse, 'input', ['NewLocation']));
}

let assetCreated = false;
let actorCreated = false;
let pieStarted = false;
let assetCleanupCandidate = false;
let actorCleanupCandidate = false;
let pieCleanupCandidate = false;

try {
  if (!await cm.isLayerAvailable('tcp-55558', true)) {
    throw new Error(`tcp-55558 unavailable: ${JSON.stringify(cm.getStatus()['tcp-55558'])}`);
  }
  console.log(`PASS tcp-55558 layer: ${JSON.stringify(cm.getStatus()['tcp-55558'])}`);

  await executeMenhanceTool('stop_pie', {}, cm).catch(() => null);

  assetCleanupCandidate = true;
  try {
    await call('create_blueprint', () => executeBlueprintsWriteTool('create_blueprint', {
      name: bpName,
      parent_class: 'Actor',
      path: '/Game/UEMCP',
    }, cm));
  } catch (err) {
    if (isNonMutatingNameConflict(err)) {
      assetCleanupCandidate = false;
    }
    throw err;
  }
  assetCreated = true;

  await call('add_component:VisualMesh', () => executeBlueprintsWriteTool('add_component', {
    blueprint_name: bpPath,
    component_type: 'StaticMesh',
    component_name: 'VisualMesh',
    scale: [0.5, 0.5, 0.5],
  }, cm));
  await call('set_static_mesh_props:VisualMesh', () => executeBlueprintsWriteTool('set_static_mesh_props', {
    blueprint_name: bpPath,
    component_name: 'VisualMesh',
    static_mesh: '/Engine/BasicShapes/Cube.Cube',
  }, cm));

  for (const [variable_name, variable_type, value, is_exposed] of [
    ['MoveAxis', 'Vector', [1, 0, 0], true],
    ['MoveSpeed', 'Float', 5, true],
    ['MoveDistance', 'Float', 40, true],
    ['StartLocation', 'Vector', [0, 0, 0], false],
    ['Direction', 'Float', 1, false],
  ]) {
    await call(`add_variable:${variable_name}`, () => executeBlueprintsWriteTool('add_variable', {
      blueprint_name: bpPath,
      variable_name,
      variable_type,
      is_exposed,
    }, cm));
    await call(`set_variable_default:${variable_name}`, () => executeBlueprintsWriteTool('set_variable_default', {
      blueprint_name: bpPath,
      variable_name,
      value,
      compile: false,
    }, cm));
  }

  const timer = await call('add_timer', () => executeBlueprintsWriteTool('add_timer', {
    blueprint_name: bpPath,
    callback_function: callbackFunction,
    interval: 0.05,
    looping: true,
    create_callback_graph: true,
    insert_on_begin_play: false,
    compile: false,
  }, cm));

  await authorBeginPlayInitialization(timer);
  await authorMovementGraph(timer);

  const compiled = await call('compile_and_save_blueprint', () => executeBlueprintsWriteTool('compile_and_save_blueprint', {
    blueprint_name: bpPath,
    fail_on_compile_error: true,
  }, cm));
  if (compiled.compiled_ok !== true || compiled.saved !== true) {
    throw new Error(`compile_and_save_blueprint did not compile/save cleanly: ${JSON.stringify(compiled)}`);
  }

  actorCleanupCandidate = true;
  try {
    await call('spawn_blueprint_actor', () => executeActorsTool('spawn_blueprint_actor', {
      blueprint_name: bpPath,
      name: actorName,
      location: [0, 0, 120],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    }, cm));
  } catch (err) {
    if (isNonMutatingNameConflict(err)) {
      actorCleanupCandidate = false;
    }
    throw err;
  }
  actorCreated = true;

  pieCleanupCandidate = true;
  await call('start_pie', () => executeMenhanceTool('start_pie', { mode: 'viewport' }, cm));
  pieStarted = true;

  let session = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    session = unwrap('get_pie_session_state', await executeMenhanceTool('get_pie_session_state', {}, cm));
    if (session.pie_running && Array.isArray(session.contexts) && session.contexts.length > 0) {
      break;
    }
    await sleep(250);
  }
  console.log(`PASS get_pie_session_state: ${JSON.stringify(summarize('get_pie_session_state', session))}`);
  if (!session?.pie_running || !Array.isArray(session.contexts) || session.contexts.length === 0) {
    throw new Error(`PIE did not report an active runtime world: ${JSON.stringify(session)}`);
  }

  await waitForActorReadiness();

  const sample = await call('sample_pie_actor_state', () => executeMenhanceTool('sample_pie_actor_state', {
    actor_ref: { label: actorName, name: actorName },
    duration_ms: 1800,
    interval_ms: 100,
    max_samples: 20,
  }, cm));
  const locations = sample.samples
    ?.map((entry) => entry.response?.result?.transform?.location)
    ?.filter((location) => Array.isArray(location)) || [];
  const xPositions = locations.map((location) => location[0]);
  const xSteps = xPositions.slice(1).map((x, index) => x - xPositions[index]);
  const hasPositiveStep = xSteps.some((step) => step > 1);
  const hasNegativeStep = xSteps.some((step) => step < -1);
  const maxAbsX = Math.max(...xPositions.map((x) => Math.abs(x)));
  const maxAbsY = Math.max(...locations.map((location) => Math.abs(location[1])));
  const maxAbsZDelta = Math.max(...locations.map((location) => Math.abs(location[2] - 120)));
  if (locations.length < 4) {
    throw new Error(`Expected at least 4 runtime samples, got ${locations.length}: ${JSON.stringify(sample)}`);
  }
  if (!hasPositiveStep || !hasNegativeStep) {
    throw new Error(`Expected X-axis reversal, got x positions ${JSON.stringify(xPositions)}`);
  }
  if (maxAbsX > 60) {
    throw new Error(`Expected X movement bounded by MoveDistance with small overshoot, got x positions ${JSON.stringify(xPositions)}`);
  }
  if (maxAbsY > 1 || maxAbsZDelta > 1) {
    throw new Error(`Expected minimal Y/Z movement, got locations ${JSON.stringify(locations)}`);
  }
  console.log(`PASS bounded_oscillation_assertion: ${JSON.stringify({ x_positions: xPositions, x_steps: xSteps, max_abs_x: maxAbsX })}`);
} finally {
  const cleanupErrors = [];
  if (pieCleanupCandidate || pieStarted) {
    await runCleanup('stop_pie', () => executeMenhanceTool('stop_pie', {}, cm), cleanupErrors);
    await runCleanup('final_pie_state', async () => {
      const response = await executeMenhanceTool('get_pie_session_state', {}, cm);
      const state = unwrap('final_pie_state', response);
      if (state.pie_running) {
        throw new Error(`PIE still running: ${JSON.stringify(state)}`);
      }
      return response;
    }, cleanupErrors);
  }
  if (actorCleanupCandidate || actorCreated) {
    await runCleanup('delete_actor', () => executeActorsTool('delete_actor', { name: actorName }, cm), cleanupErrors, { tolerateNotFound: true });
  }
  if (assetCleanupCandidate || assetCreated) {
    await runCleanup('delete_asset_safe', () => executeM5EditorUtilityTool('delete_asset_safe', {
      asset_path: bpPath,
      force: true,
      permanent: true,
    }, cm), cleanupErrors, { tolerateNotFound: true });
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'One or more live-smoke cleanup steps failed');
  }
}
