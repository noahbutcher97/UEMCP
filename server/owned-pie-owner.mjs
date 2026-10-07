import { isDeepStrictEqual } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { createOwnedPieTransport, PieLifecycleError, remainingMs, withinDeadline } from './owned-pie-transport.mjs';
import { validatePieOracle } from './owned-pie-lifecycle.mjs';

const pathKey = value => typeof value === 'string' ? value.replaceAll('\\', '/').toLowerCase() : null;
function requireProof(condition, message) {
  if (!condition) throw new PieLifecycleError('OWNED_PIE_PROOF_INVALID', message);
}
// IEEE signed zero is the same actor coordinate; preserve every nonzero bit.
const canonicalTriple = values => Array.isArray(values) ? values.map(value => Object.is(value, -0) ? 0 : value) : values;
function quiet(proof) {
  return proof.flags && ['queued_start', 'session_active', 'play_world', 'queued_end', 'simulating'].every(key => proof.flags[key] === false)
    && proof.flags.pie_contexts === 0;
}

// The coordinator supplies its EXISTING exclusive ownership/source guard. This
// module does not acquire a host, launch Unreal, or replace that guard.
export function createOwnedPieOwner({ projectContext, connectionManager, nonce, processId, assertOwnership, pollMs = 25 }) {
  requireProof(/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(nonce), 'Canonical GUID nonce required.');
  requireProof(Number.isSafeInteger(processId) && processId > 0, 'Owned process ID required.');
  requireProof(typeof assertOwnership === 'function', 'Coordinator ownership guard required.');
  requireProof(Number.isFinite(pollMs) && pollMs > 0 && pollMs <= 1000, 'Bounded polling interval required.');
  const identity = projectContext.identity?.canonicalUprojectPath;
  const generation = projectContext.generation;
  requireProof(typeof identity === 'string', 'Attached project identity required.');
  let sealed = false;
  let verified = false;
  let boundOracle;
  const transcript = [];
  function binding() {
    requireProof(projectContext.generation === generation && projectContext.identity?.canonicalUprojectPath === identity, 'Project context changed.');
  }
  async function ownership(deadlineAt) {
    binding();
    const proof = await withinDeadline(options => assertOwnership({ ...options, identity, generation, nonce, processId }), deadlineAt);
    binding();
    requireProof(proof?.owned === true && proof.exclusive === true && proof.sourceVerified === true
      && proof.processId === processId && proof.nonce === nonce && pathKey(proof.projectPath) === pathKey(identity), 'Coordinator ownership/source proof differs.');
  }
  function validate(proof) {
    binding();
    requireProof(proof?.owned === true && proof.nonce === nonce && proof.process_id === processId
      && pathKey(proof.project_path) === pathKey(identity) && proof.map_path === boundOracle.mapPath, 'Native host identity differs.');
    const a = proof.accounting;
    requireProof(a && typeof a.sealed === 'boolean' && ['accepted', 'completed', 'outstanding'].every(key => Number.isSafeInteger(a[key]) && a[key] >= 0)
      && a.accepted - a.completed === a.outstanding, 'Invalid native operation accounting.');
    requireProof(Number.isSafeInteger(proof.tick) && proof.tick >= 0, 'Invalid post-editor tick counter.');
    requireProof(proof.flags && ['queued_start', 'session_active', 'play_world', 'queued_end', 'simulating'].every(key => typeof proof.flags[key] === 'boolean')
      && Number.isSafeInteger(proof.flags.pie_contexts) && proof.flags.pie_contexts >= 0, 'Invalid native lifecycle flags.');
    return proof;
  }
  async function control(command, params, deadlineAt) {
    binding();
    const envelope = await withinDeadline(() => connectionManager.send('tcp-55558', command, { ...params, owned_pie_nonce: nonce }, {
      skipCache: true, deadlineAt, timeoutMs: remainingMs(deadlineAt), beforeDispatch: () => { binding(); remainingMs(deadlineAt); },
    }), deadlineAt);
    requireProof(envelope?.status === 'success', 'Invalid native control envelope.');
    const proof = validate(envelope.result);
    transcript.push({ command, proof: structuredClone(proof) });
    return proof;
  }
  const adapter = createOwnedPieTransport({ projectContext,
    bootstrapVerification: true,
    connectionManager: { async send(channel, command, params, options) {
      requireProof(verified && !sealed, 'Owner must be verified and unsealed before lifecycle dispatch.');
      await ownership(options.deadlineAt);
      const response = await connectionManager.send(channel, command, { ...params, owned_pie_nonce: nonce }, {
        ...options, beforeDispatch: () => {
          requireProof(verified && !sealed, 'Owner was sealed before queued dispatch.');
          options.beforeDispatch();
        },
      });
      if (command === 'get_pie_actor_state' && response?.result?.transform) {
        const copy = structuredClone(response);
        for (const key of ['location', 'rotation', 'scale']) copy.result.transform[key] = canonicalTriple(copy.result.transform[key]);
        return copy;
      }
      return response;
    } },
    async verifyOwnedHost({ oracle, deadlineAt }) {
      requireProof(!sealed && !verified, 'Owner verification is single-use.');
      validatePieOracle(oracle);
      boundOracle = structuredClone(oracle);
      await ownership(deadlineAt);
      const proof = await control('owned_pie_verify', { map_path: oracle.mapPath, actor_name: oracle.name, missing_actor_name: oracle.missingActorName }, deadlineAt);
      requireProof(!proof.accounting.sealed && proof.accounting.accepted === 0 && quiet(proof), 'Fixture must begin stopped with an empty ledger.');
      requireProof(proof.missing_actor_absent === true && proof.standalone === true && proof.online_disabled === true, 'Standalone/no-online settings or absent actor unverified.');
      for (const key of ['name', 'class', 'location', 'rotation', 'scale', 'InputPriority', 'AutoReceiveInput', 'has_input_component']) {
        requireProof(isDeepStrictEqual(canonicalTriple(proof.actor?.[key]), canonicalTriple(oracle[key])), `Editor oracle ${key} differs.`);
      }
      await ownership(deadlineAt);
      remainingMs(deadlineAt);
      requireProof(!sealed, 'Owner was sealed before native verification settlement.');
      const readiness = projectContext.refreshOwnedPieVerification(proof, { generation, nonce, processId });
      requireProof(readiness.state === 'verified' && readiness.source === 'owned_pie_verification', 'Native verification did not establish transport ownership.');
      verified = true;
      return { owned: true, mapPath: oracle.mapPath, missingActorAbsent: true, standalone: true };
    },
    async reconcile({ deadlineAt }) {
      // Local sealing happens even if ownership verification or TCP later fails.
      sealed = true;
      requireProof(boundOracle, 'No bound fixture oracle.');
      await ownership(deadlineAt);
      const fence = await control('owned_pie_fence', {}, deadlineAt);
      requireProof(fence.accounting.sealed && Number.isSafeInteger(fence.seal_tick) && fence.seal_tick >= 0, 'Native fence was not acknowledged.');
      let completed = fence.accounting.completed;
      while (true) {
        const proof = await control('owned_pie_reconcile', {}, deadlineAt);
        requireProof(proof.accounting.sealed && proof.seal_tick === fence.seal_tick && proof.accounting.accepted === fence.accounting.accepted
          && proof.accounting.completed >= completed && proof.tick >= fence.tick, 'Native fence or operation ledger changed.');
        completed = proof.accounting.completed;
        if (proof.drained === true) {
          requireProof(proof.accounting.outstanding === 0 && quiet(proof)
            && Number.isSafeInteger(proof.drained_tick) && proof.drained_tick > fence.seal_tick
            && proof.tick >= proof.drained_tick, 'Stopped snapshot does not prove post-fence drainage.');
          await ownership(deadlineAt);
          return { owned: true, stopped: true, pendingOperationsDrained: true, nativeProof: proof };
        }
        await delay(Math.min(pollMs, remainingMs(deadlineAt)));
      }
    },
  });
  return { adapter, get transcript() { return structuredClone(transcript); } };
}
