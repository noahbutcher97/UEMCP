// Standing breadth smoke for a representative slice of the live tool surface.
//
// Preconditions:
//   - Unreal Editor is open with UEMCP loaded.
//   - Set UEMCP_LIVE_SMOKE=1 to acknowledge this creates/deletes scratch content.
//   - Provide an explicit project via smoke-live.bat --project or UEMCP_LIVE_PROJECT_ROOT.

import { randomUUID } from 'node:crypto';
import { executeActorsTool } from './actors-tcp-tools.mjs';
import { executeBlueprintsWriteTool } from './blueprints-write-tcp-tools.mjs';
import { executeMenhanceTool } from './menhance-tcp-tools.mjs';
import { executeM5EditorUtilityTool } from './m5-editor-utility-tools.mjs';
import {
  createLiveSmokeCall,
  isNonMutatingNameConflict,
  prepareLiveSmoke,
  runCleanup,
} from './live-smoke-harness.mjs';

const smoke = await prepareLiveSmoke({ name: 'live-smoke-surface' });
if (!smoke.ready) process.exit(smoke.exitCode);
const { cm } = smoke;

const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 17);
const ownerToken = randomUUID().replace(/-/g, '').slice(0, 8);
const actorName = `UEMCPSmoke_Actor_${stamp}_${ownerToken}`;
const bpName = `UEMCPSmoke_BP_${stamp}_${ownerToken}`;
const bpPath = `/Game/UEMCPSmoke/${bpName}`;

function summarize(label, result) {
  if (label === 'spawn_actor' || label === 'get_actor_properties') {
    return {
      name: result.name,
      class: result.class,
      location: result.location,
      rotation: result.rotation,
      scale: result.scale,
    };
  }
  if (label === 'bp_compile_and_report') {
    return {
      name: result.name,
      compiled_ok: result.compiled_ok,
      num_errors: result.num_errors,
      num_warnings: result.num_warnings,
      generated_class_status: result.generated_class_status,
    };
  }
  if (label === 'get_editor_state') {
    return {
      world_path: result.world_path,
      level: result.level,
      pie_running: result.pie_running,
      selected_actor_count: Array.isArray(result.selected_actors) ? result.selected_actors.length : undefined,
    };
  }
  return result;
}

function assertVector(label, actual, expected) {
  if (!Array.isArray(actual) || actual.length < expected.length) {
    throw new Error(`${label}: expected vector ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
  for (let i = 0; i < expected.length; i++) {
    if (Math.abs(actual[i] - expected[i]) > 0.01) {
      throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  }
}

const call = createLiveSmokeCall({ summarize });
let actorCleanupCandidate = false;
let assetCleanupCandidate = false;

try {
  const editorState = await call('get_editor_state', () => executeMenhanceTool('get_editor_state', {}, cm));
  if (!editorState || typeof editorState !== 'object' || !Object.hasOwn(editorState, 'pie_running')) {
    throw new Error(`get_editor_state did not return the expected state object: ${JSON.stringify(editorState)}`);
  }

  actorCleanupCandidate = true;
  let spawned = null;
  try {
    spawned = await call('spawn_actor', () => executeActorsTool('spawn_actor', {
      type: 'StaticMeshActor',
      name: actorName,
      location: [100, 200, 300],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    }, cm));
  } catch (err) {
    if (isNonMutatingNameConflict(err)) {
      actorCleanupCandidate = false;
    }
    throw err;
  }
  assertVector('spawn_actor.location', spawned.location, [100, 200, 300]);

  const actorProps = await call('get_actor_properties', () => executeActorsTool('get_actor_properties', {
    name: actorName,
  }, cm));
  assertVector('get_actor_properties.location', actorProps.location, [100, 200, 300]);

  assetCleanupCandidate = true;
  try {
    await call('create_blueprint', () => executeBlueprintsWriteTool('create_blueprint', {
      name: bpName,
      parent_class: 'Actor',
      path: '/Game/UEMCPSmoke',
    }, cm));
  } catch (err) {
    if (isNonMutatingNameConflict(err)) {
      assetCleanupCandidate = false;
    }
    throw err;
  }

  const compileResult = await call('bp_compile_and_report', () => executeMenhanceTool('bp_compile_and_report', {
    asset_path: bpPath,
  }, cm));
  if (compileResult.compiled_ok !== true || compileResult.num_errors !== 0) {
    throw new Error(`bp_compile_and_report did not compile cleanly: ${JSON.stringify(compileResult)}`);
  }
} finally {
  const cleanupErrors = [];
  if (actorCleanupCandidate) {
    await runCleanup('delete_actor', () => executeActorsTool('delete_actor', { name: actorName }, cm), cleanupErrors, { tolerateNotFound: true });
  }
  if (assetCleanupCandidate) {
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
