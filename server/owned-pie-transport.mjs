import { TOOL_REQUIREMENT_KINDS } from './tool-requirements.mjs';

export class PieLifecycleError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'PieLifecycleError';
    this.code = code;
    this.details = details;
  }
}

export function remainingMs(deadlineAt) {
  if (!Number.isFinite(deadlineAt)) throw new PieLifecycleError('INVALID_DEADLINE', 'A finite absolute deadline is required.');
  const remaining = Math.floor(deadlineAt - Date.now());
  if (remaining <= 0) throw new PieLifecycleError('PIE_DEADLINE_EXCEEDED', 'PIE operation deadline expired.');
  return remaining;
}

// Expiry bounds the local wait. It does NOT cancel a dispatched Unreal command.
export async function withinDeadline(operation, deadlineAt) {
  const timeoutMs = remainingMs(deadlineAt);
  const controller = new AbortController();
  let timer;
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => operation({ deadlineAt, timeoutMs, signal: controller.signal })),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new PieLifecycleError('PIE_DEADLINE_EXCEEDED', 'PIE operation deadline expired.'));
        }, timeoutMs);
      }),
    ]);
    // Synchronous callbacks can block the event loop beyond the timer budget.
    remainingMs(deadlineAt);
    return result;
  } catch (error) {
    if (error.code === 'PIE_DEADLINE_EXCEEDED') controller.abort();
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

const COMMANDS = new Set(['start_pie', 'stop_pie', 'get_pie_session_state', 'get_pie_actor_state']);
const MUTATIONS = new Set(['start_pie', 'stop_pie']);
const REJECTED_WITHOUT_MUTATION = {
  start_pie: new Set(['NO_EDITOR', 'ALREADY_RUNNING', 'INVALID_PIE_MODE']),
  stop_pie: new Set(['NO_EDITOR']),
};

// A dedicated adapter/ConnectionManager belongs to one owned-host qualification.
// Reconciliation is out of band: it must drain late commands before confirming stopped.
export function createOwnedPieTransport({ projectContext, connectionManager, verifyOwnedHost, reconcile }) {
  if (!projectContext || !connectionManager || typeof verifyOwnedHost !== 'function' || typeof reconcile !== 'function') {
    throw new TypeError('ProjectContext, ConnectionManager, verifyOwnedHost and reconcile are required.');
  }
  const generation = projectContext.generation;
  const identity = projectContext.identity?.canonicalUprojectPath;
  let state = 'open';
  let busy = false;
  let retainedMutation;
  let ambiguity;
  let reconciliationAttempted = false;

  function ready() {
    if (state !== 'open') throw new PieLifecycleError('PIE_ADAPTER_LOCKED', `PIE adapter is ${state}.`, { ambiguity });
    if (projectContext.generation !== generation || projectContext.identity?.canonicalUprojectPath !== identity) {
      throw new PieLifecycleError('PROJECT_CONTEXT_CHANGED', 'PIE adapter project binding changed.');
    }
    const readiness = projectContext.evaluateToolReadiness({ requirement: TOOL_REQUIREMENT_KINDS.LIVE_MUTATION });
    if (!readiness.ok) throw new PieLifecycleError(readiness.error.code, readiness.error.message, readiness.error);
  }

  function lock(reason) {
    state = 'locked';
    ambiguity = reason;
  }

  return {
    get state() { return state; },
    async verifyOwnedHost(oracle, deadlineAt) {
      ready();
      if (busy) throw new PieLifecycleError('PIE_ADAPTER_BUSY', 'PIE adapter already has an operation in flight.');
      busy = true;
      try {
        const proof = await withinDeadline(options => verifyOwnedHost({ ...options, oracle, identity, generation }), deadlineAt);
        ready();
        if (proof?.owned !== true || proof.mapPath !== oracle.mapPath || proof.missingActorAbsent !== true || proof.standalone !== true) {
          throw new PieLifecycleError('OWNED_HOST_UNVERIFIED', 'Owned map, absent probe and standalone settings must be verified.');
        }
        return proof;
      } finally { busy = false; }
    },
    async call(command, params = {}, { deadlineAt } = {}) {
      ready();
      if (!COMMANDS.has(command)) throw new PieLifecycleError('PIE_COMMAND_UNSUPPORTED', `Unsupported command: ${command}`);
      remainingMs(deadlineAt);
      if (busy) throw new PieLifecycleError('PIE_ADAPTER_BUSY', 'PIE adapter already has an operation in flight.');
      busy = true;
      let dispatched = false;
      let mutation;
      try {
        const response = await withinDeadline(() => connectionManager.send('tcp-55558', command, params, {
          skipCache: true,
          deadlineAt,
          timeoutMs: remainingMs(deadlineAt),
          beforeDispatch: () => {
            ready();
            remainingMs(deadlineAt);
            dispatched = true;
            if (MUTATIONS.has(command)) mutation = projectContext.beginMutation({ command, deadlineAt });
          },
        }), deadlineAt);
        ready();
        remainingMs(deadlineAt);
        if (response?.status !== 'success' || !response.result || typeof response.result !== 'object' || Array.isArray(response.result)) {
          throw new PieLifecycleError('PIE_INVALID_ENVELOPE', 'Expected a bridge success/result object.');
        }
        if ((command === 'start_pie' && (response.result.requested !== true || response.result.mode !== 'viewport'))
          || (command === 'stop_pie' && !(response.result.was_running === false
            || (response.result.was_running === true && response.result.requested_stop === true)))) {
          throw new PieLifecycleError('PIE_INVALID_ENVELOPE', 'Lifecycle mutation acknowledgement is incomplete.');
        }
        return response.result;
      } catch (error) {
        // Only source-verified pre-mutation handler errors confirm rejection.
        // Unknown wire, transport and timeout failures may follow a remote mutation.
        const confirmedRejection = error.wireError && REJECTED_WITHOUT_MUTATION[command]?.has(error.code);
        if (dispatched && MUTATIONS.has(command) && !confirmedRejection) {
          lock({ command, code: error.code || 'TRANSPORT_ERROR' });
          retainedMutation = mutation;
          mutation = undefined;
        }
        // Preserve the original transport error, even if readiness also changed.
        throw error;
      } finally {
        if (mutation !== undefined) projectContext.endMutation(mutation);
        busy = false;
      }
    },
    async reconcile(reason, deadlineAt) {
      if (state === 'closed') throw new PieLifecycleError('PIE_ADAPTER_LOCKED', 'PIE adapter is closed.');
      if (busy) throw new PieLifecycleError('PIE_ADAPTER_BUSY', 'PIE adapter already has an operation in flight.');
      if (reconciliationAttempted) throw new PieLifecycleError('PIE_ADAPTER_LOCKED', 'Reconciliation was already attempted; the owner must handle any pending callback out of band.');
      reconciliationAttempted = true;
      lock(ambiguity || { code: reason?.code || 'LIFECYCLE_FAILED' });
      busy = true;
      try {
        const proof = await withinDeadline(options => reconcile({ ...options, identity, generation, reason, ambiguity }), deadlineAt);
        if (proof?.owned !== true || proof.stopped !== true || proof.pendingOperationsDrained !== true) {
          throw new PieLifecycleError('PIE_RECONCILIATION_UNVERIFIED', 'Reconciliation must prove ownership, drained operations and stopped PIE.');
        }
        if (retainedMutation !== undefined) projectContext.endMutation(retainedMutation);
        retainedMutation = undefined;
        state = 'closed';
        return proof;
      } finally { busy = false; }
    },
  };
}
