// Opt-in live smoke for the D147/D149 Blueprint + PIE stabilization path.
//
// Preconditions:
//   - Unreal Editor is open with UEMCP loaded.
//   - Set UEMCP_LIVE_SMOKE=1 to acknowledge this creates/deletes a temp asset.
//   - Provide an explicit project via smoke-live.bat --project or UEMCP_LIVE_PROJECT_ROOT.
//
// Run:
//   $env:UEMCP_LIVE_SMOKE='1'
//   ..\smoke-live.bat --project "D:\Path\To\Project\Project.uproject"

import { executeBlueprintsWriteTool } from './blueprints-write-tcp-tools.mjs';
import { executeActorsTool } from './actors-tcp-tools.mjs';
import { executeMenhanceTool } from './menhance-tcp-tools.mjs';
import { executeM5EditorUtilityTool } from './m5-editor-utility-tools.mjs';
import {
  cleanupWithBackoff as sharedCleanupWithBackoff,
  createLiveSmokeCall,
  isTransientPIEActorLookupError,
  pieSelectorFromSessionState,
  prepareLiveSmoke,
  sleep,
  stopPIEAndWaitForStopped,
  unwrapLiveSmokeResponse,
} from './live-smoke-harness.mjs';

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
const bpName = `BP_UEMCP_LiveSmoke_${stamp}`;
const actorName = `UEMCP_LiveSmoke_${stamp}`;
const bpPath = `/Game/UEMCP/${bpName}`;

const smoke = await prepareLiveSmoke({ name: 'live-smoke-d147-blueprint-pie' });
if (!smoke.ready) process.exit(smoke.exitCode);
const { cm } = smoke;
const unwrap = unwrapLiveSmokeResponse;

function summary(label, result) {
  if (label === 'compile_blueprint') {
    return {
      name: result.name,
      succeeded: result.succeeded,
      compiled_ok: result.compiled_ok,
      num_errors: result.num_errors,
      num_warnings: result.num_warnings,
      generated_class_status: result.generated_class_status,
    };
  }
  if (label === 'get_asset_references') {
    return {
      package_name: result.package_name,
      num_referencers: result.num_referencers,
      num_dependencies: result.num_dependencies,
    };
  }
  if (label === 'add_variable_assignment') {
    return {
      graph_name: result.graph_name,
      target_variable: result.target_variable,
      assignment_kind: result.assignment_kind,
      requires_compile: result.requires_compile,
      node_id: result.node_id,
      pin_count: Array.isArray(result.pins) ? result.pins.length : undefined,
    };
  }
  if (label === 'get_pie_session_state') {
    return {
      pie_running: result.pie_running,
      active_context_count: result.active_context_count,
      contexts: Array.isArray(result.contexts)
        ? result.contexts.map((c) => ({
            pie_instance: c.pie_instance,
            world_name: c.world_name,
            world_path: c.world_path,
          }))
        : [],
    };
  }
  if (label === 'get_pie_actor_state') {
    return {
      matched_by: result.resolved?.matched_by,
      name: result.resolved?.name,
      label: result.resolved?.label,
      world: result.world?.world_name,
      location: result.transform?.location,
      root_component: result.root_component?.name,
      component_count: Array.isArray(result.components) ? result.components.length : undefined,
      properties: result.properties,
    };
  }
  if (label === 'sample_pie_actor_state') {
    return {
      sample_count: result.sample_count,
      elapsed_ms: result.elapsed_ms,
      capped: result.capped,
      first_location: result.first?.result?.transform?.location,
      last_location: result.last?.result?.transform?.location,
      delta: result.delta,
    };
  }
  return result;
}

const call = createLiveSmokeCall({ summarize: summary });

async function cleanupWithBackoff(label, fn) {
  return sharedCleanupWithBackoff(label, fn, { delaysMs: [1000, 3000, 10000, 30000] });
}

async function readPIEActorStateWithBackoff(params) {
  let lastError = null;
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      return await executeMenhanceTool('get_pie_actor_state', params, cm);
    } catch (err) {
      if (!isTransientPIEActorLookupError(err)) {
        throw err;
      }
      lastError = err;
      await sleep(100);
    }
  }
  throw lastError || new Error('get_pie_actor_state did not produce a response');
}

let assetCreated = false;
let actorCreated = false;
let pieStarted = false;

try {
  await executeMenhanceTool('stop_pie', {}, cm).catch(() => null);

  await call('create_blueprint', () => executeBlueprintsWriteTool('create_blueprint', {
    name: bpName,
    parent_class: 'Actor',
    path: '/Game/UEMCP',
  }, cm));
  assetCreated = true;

  await call('add_variable', () => executeBlueprintsWriteTool('add_variable', {
    blueprint_name: bpPath,
    variable_name: 'SmokeSpeed',
    variable_type: 'Float',
    is_exposed: true,
  }, cm));

  await call('add_variable_assignment', () => executeBlueprintsWriteTool('add_variable_assignment', {
    blueprint_name: bpPath,
    target_variable: 'SmokeSpeed',
    graph_name: 'EventGraph',
    node_position: [360, 0],
    assignment: { kind: 'literal', value: 123.5 },
    compile: false,
  }, cm));

  const compileResult = await call('compile_blueprint', () => executeBlueprintsWriteTool('compile_blueprint', {
    blueprint_name: bpPath,
  }, cm));
  if (compileResult.compiled_ok !== true || compileResult.num_errors !== 0) {
    throw new Error(`compile_blueprint diagnostics were not clean: ${JSON.stringify(compileResult)}`);
  }

  await call('get_asset_references', () => executeMenhanceTool('get_asset_references', {
    asset_path: bpPath,
  }, cm));

  await call('spawn_blueprint_actor', () => executeActorsTool('spawn_blueprint_actor', {
    blueprint_name: bpPath,
    name: actorName,
    location: [0, 0, 120],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
  }, cm));
  actorCreated = true;

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
  console.log(`PASS get_pie_session_state: ${JSON.stringify(summary('get_pie_session_state', session))}`);
  if (!session.pie_running || !Array.isArray(session.contexts) || session.contexts.length === 0) {
    throw new Error(`PIE did not report an active runtime world: ${JSON.stringify(session)}`);
  }
  const pieSelector = pieSelectorFromSessionState(session);

  await call('get_pie_actor_state', () => readPIEActorStateWithBackoff({
    ...pieSelector,
    actor_ref: { label: actorName, name: actorName },
    include_components: true,
    properties: ['CustomTimeDilation'],
  }, cm));

  await call('sample_pie_actor_state', () => executeMenhanceTool('sample_pie_actor_state', {
    ...pieSelector,
    actor_ref: { label: actorName, name: actorName },
    include_components: true,
    properties: ['CustomTimeDilation'],
    duration_ms: 250,
    interval_ms: 125,
    max_samples: 3,
  }, cm));
} finally {
  if (pieStarted) {
    await cleanupWithBackoff('stop_pie_and_wait', () => stopPIEAndWaitForStopped({
      stop: () => executeMenhanceTool('stop_pie', {}, cm),
      getState: () => executeMenhanceTool('get_pie_session_state', {}, cm),
      delaysMs: [500, 1500, 3000, 5000, 10000],
    }));
  }
  if (actorCreated) {
    await cleanupWithBackoff('delete_actor', () => executeActorsTool('delete_actor', { name: actorName }, cm));
  }
  if (assetCreated) {
    await cleanupWithBackoff('delete_asset_safe', () => executeM5EditorUtilityTool('delete_asset_safe', {
      asset_path: bpPath,
      force: true,
      permanent: true,
    }, cm));
  }
}
