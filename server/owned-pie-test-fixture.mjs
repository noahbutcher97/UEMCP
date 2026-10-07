// Engine-free responder model, not a saved/native fixture or qualification claim.
import { fileURLToPath } from 'node:url';
import { ConnectionManager } from './connection-manager.mjs';
import { ProjectContext } from './project-context.mjs';
import { FakeTcpResponder, createTestConfig } from './test-helpers.mjs';
import { createOwnedPieTransport } from './owned-pie-transport.mjs';

export const oracle = Object.freeze({
  mapPath: '/Game/OwnedPIE/Lifecycle', name: 'OwnedLifecycleActor',
  class: '/Script/Engine.StaticMeshActor', missingActorName: 'DefinitelyAbsentOwnedProbe',
  location: [120, -240, 360], rotation: [0, 90, 0], scale: [1, 2, 1], InputPriority: 173, AutoReceiveInput: 0, has_input_component: false,
});
export const world = Object.freeze({
  pie_instance: 0, world_name: 'Lifecycle',
  world_path: '/Game/OwnedPIE/UEDPIE_0_Lifecycle.Lifecycle', net_mode: 'Standalone', is_default: true,
});
export const stopped = { pie_running: false, active_context_count: 0, default_pie_instance: -1, contexts: [] };
export const running = { pie_running: true, active_context_count: 1, default_pie_instance: 0, contexts: [world] };
export const actor = {
  world, resolved: { matched_by: 'name', name: oracle.name, class: oracle.class },
  transform: { location: oracle.location, rotation: oracle.rotation, scale: oracle.scale },
  properties: { InputPriority: oracle.InputPriority, AutoReceiveInput: 0 }, has_input_component: false,
};
export const success = result => ({ status: 'success', result: structuredClone(result) });
export const wireError = code => ({ status: 'error', code, error: `Typed ${code}`, detail: { witness: true } });
export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
export const nextTurn = () => new Promise(resolve => setImmediate(resolve));

export async function fixture(options = {}) {
  const projectRoot = fileURLToPath(new URL('./fixtures/uemcp-fixture/', import.meta.url));
  const context = new ProjectContext({ cwd: projectRoot, repoRoot: projectRoot });
  await context.attachProject({ project_root: projectRoot });
  context.refreshEditorHandshake({ uproject_path: context.identity.uprojectPath });
  context.setDeployReadiness({ state: 'fresh' });
  const fake = new FakeTcpResponder();
  let active = false;
  fake.on('get_pie_session_state', () => success(active ? running : stopped));
  fake.on('start_pie', () => {
    if (active) return wireError('ALREADY_RUNNING');
    active = true;
    return success({ requested: true, mode: 'viewport' });
  });
  fake.on('stop_pie', () => {
    const was_running = active;
    active = false;
    return success({ was_running, ...(was_running ? { requested_stop: true } : {}) });
  });
  fake.on('get_pie_actor_state', (_port, _type, params) => {
    if (!active) return wireError('PIE_NOT_RUNNING');
    return params.actor_ref.name === oracle.name ? success(actor) : wireError('ACTOR_NOT_FOUND');
  });
  const { config } = createTestConfig(projectRoot, fake);
  const cm = new ConnectionManager(config);
  const callbacks = { verify: [], reconcile: [] };
  const adapter = createOwnedPieTransport({ projectContext: context, connectionManager: cm,
    verifyOwnedHost: async args => {
      callbacks.verify.push(args);
      if (options.verifyOwnedHost) return options.verifyOwnedHost(args);
      return { owned: true, mapPath: oracle.mapPath, missingActorAbsent: true, standalone: true };
    },
    reconcile: async args => {
      callbacks.reconcile.push(args);
      if (options.reconcile) return options.reconcile(args);
      active = false;
      return { owned: true, stopped: true, pendingOperationsDrained: true };
    },
  });
  return { adapter, context, cm, fake, callbacks };
}
