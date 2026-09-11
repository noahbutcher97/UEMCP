// client-transaction.mjs — staged, fingerprinted, rollback-capable writes
// shared by every client adapter. Composes the pins, stage and snapshot
// clusters over one shared state.
// Depends on: transaction-{pins,stage,snapshot}.mjs, transaction-common.mjs,
// client-contract.mjs, process-runner.mjs.
import { randomBytes } from 'node:crypto';
import * as defaultFs from 'node:fs/promises';

import { CLIENT_IDS } from './client-contract.mjs';
import { createProcessRunner } from './process-runner.mjs';
import {
  ACTION_STATUSES,
  DEFAULT_WINDOWS_NATIVE,
  READY_STATUSES,
  adapterMap,
  fail,
  operationDigest,
  pathKey,
  transactionResultBase,
  validatePlanDigest,
} from './transaction-common.mjs';
import { createTransactionPins } from './transaction-pins.mjs';
import { createTransactionSnapshot } from './transaction-snapshot.mjs';
import { createTransactionStage } from './transaction-stage.mjs';

export { ClientTransactionError, captureClientPathFingerprint } from './transaction-common.mjs';

// Factory boundary. Closes over one mutable `state` and the three cluster
// factories built over it (pins, stage, snapshot), plus the frozen
// `transactionCapability` object handed to every adapter. Invariants
// enforced here: apply requires `snapshotted`, moves to `applying` then
// `complete`; rollback requires `snapshotted` or `applying`, moves through
// `rolling_back` to `complete`; a failed apply always rolls back before the
// lease is released. Injected dependencies exist for tests only.
export function createClientTransaction({
  localState,
  fsImpl = defaultFs,
  clock = Date.now,
  windowsNative = DEFAULT_WINDOWS_NATIVE,
  processRunner = createProcessRunner(),
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
  externalLease = null,
} = {}) {
  if (!localState?.paths || typeof localState.acquireApplyLease !== 'function'
    || typeof localState.createSnapshot !== 'function'
    || typeof localState.deleteSnapshot !== 'function') {
    fail('transaction requires the core local-state contract', 'INVALID_LOCAL_STATE');
  }
  if (!windowsNative?.fingerprintWindowsFileMetadata
    || !windowsNative?.deleteTreeNoFollow
    || !windowsNative?.replaceFilePreservingMetadata
    || !windowsNative?.withPinnedAncestry
    || !windowsNative?.withPinnedFiles) {
    fail('transaction requires the Windows metadata contract', 'INVALID_WINDOWS_NATIVE');
  }
  if (externalLease !== null
    && (typeof externalLease !== 'object'
      || !/^[0-9a-f]{48}$/.test(externalLease.ownerToken ?? '')
      || typeof externalLease.release !== 'function'
      || typeof localState.validateApplyLease !== 'function')) {
    fail('external apply lease capability is invalid', 'INVALID_APPLY_LEASE');
  }

  const state = {
    phase: 'new',
    lease: null,
    ownsLease: false,
    planDigest: null,
    operationDigest: null,
    adapters: new Map(),
    operations: [],
    records: new Map(),
    readOnly: [],
    changedOrder: [],
    createdDirectories: [],
    clientResults: [],
    deferredDeletes: new Map(),
    currentClient: null,
    transactionId: randomBytes(12).toString('hex'),
  };

  const pins = createTransactionPins({ state, fsImpl, windowsNative, processRunner, systemRoot });
  const { releaseLease } = pins;

  const stage = createTransactionStage({ state, fsImpl, windowsNative, localState, clock, pins, processRunner, systemRoot });
  const { writeFile, runStagedWrite, ownershipLedger } = stage;

  const snap = createTransactionSnapshot({ state, fsImpl, windowsNative, localState, pins, stage, systemRoot, externalLease });
  const {
    deleteSnapshot,
    deleteFileAfterVerify,
    snapshot,
    recheckBeforeApply,
    recheckAfterVerify,
    withPinnedTransactionEvidence,
    commitDeferredDeletes,
    cleanupCreatedDirectories,
    restoreRecord,
  } = snap;

  const transactionCapability = Object.freeze({ writeFile, runStagedWrite, deleteFileAfterVerify, ownershipLedger });

  async function rollbackInternal({ reason = 'apply_failed', adapters = state.adapters } = {}) {
    state.phase = 'rolling_back';
    let hookFailed = false;
    const hookErrors = [];
    for (const clientId of [...CLIENT_IDS].reverse()) {
      const adapter = adapters.get(clientId);
      if (!adapter || typeof adapter.rollback !== 'function') continue;
      const records = [...state.records.values()].filter(record => record.changed && record.changedBy === clientId);
      if (records.length === 0) continue;
      try {
        await adapter.rollback({ transaction: transactionCapability }, records.map(record => ({ path: record.path })));
      } catch (error) {
        hookFailed = true;
        hookErrors.push({ client_id: clientId, code: error?.code ?? 'ROLLBACK_HOOK_FAILED' });
      }
    }

    const restoration = [];
    for (const key of [...state.changedOrder].reverse()) {
      const record = state.records.get(key);
      try {
        restoration.push(await restoreRecord(record));
      } catch (error) {
        restoration.push({ status: 'failed', path: record.path, code: error?.code ?? 'ROLLBACK_FAILED' });
      }
    }
    const directoryCleanupFailures = await cleanupCreatedDirectories();
    if (directoryCleanupFailures.length > 0) {
      hookFailed = true;
      hookErrors.push(...directoryCleanupFailures.map(row => ({
        client_id: 'transaction',
        code: row.code,
      })));
    }

    const retained = [];
    for (const record of state.records.values()) {
      const outcome = restoration.find(row => pathKey(row.path) === record.key);
      if (outcome?.status === 'conflict' || outcome?.status === 'failed') {
        retained.push({
          path: record.path,
          retained_until: record.snapshot.metadata.retained_until,
        });
      } else {
        try {
          await deleteSnapshot(record);
        } catch (error) {
          hookFailed = true;
          hookErrors.push({ client_id: 'transaction', code: error?.code ?? 'SNAPSHOT_DELETE_FAILED' });
          retained.push({
            path: record.path,
            retained_until: record.snapshot.metadata.retained_until,
          });
        }
      }
    }
    const hasConflict = restoration.some(row => row.status === 'conflict');
    const hasFailure = restoration.some(row => row.status === 'failed') || hookFailed;
    const status = hasConflict ? 'ROLLBACK_CONFLICT' : hasFailure ? 'ROLLBACK_FAILED' : 'ROLLED_BACK';
    state.phase = 'complete';
    await releaseLease();
    return {
      status,
      ...transactionResultBase(state),
      rollback: {
        reason_code: typeof reason === 'string' && /^[A-Z0-9_]+$/.test(reason) ? reason : 'APPLY_FAILED',
        paths: restoration,
        hook_errors: hookErrors,
      },
      retained_snapshots: retained,
    };
  }

  async function apply({ planDigest, adapters, operations, context = {} } = {}) {
    if (state.phase !== 'snapshotted') fail('transaction must be snapshotted before apply', 'TRANSACTION_STATE_INVALID');
    let suppliedAdapters;
    try {
      if (externalLease) await localState.validateApplyLease(externalLease);
      validatePlanDigest(planDigest);
      suppliedAdapters = adapterMap(adapters);
      if (planDigest !== state.planDigest
        || operationDigest(operations) !== state.operationDigest
        || JSON.stringify([...suppliedAdapters.keys()].sort()) !== JSON.stringify([...state.adapters.keys()].sort())) {
        fail('apply differs from the reviewed transaction plan', 'UNAPPROVED_OPERATION_SET');
      }
    } catch (error) {
      await rollbackInternal({ reason: error?.code ?? 'UNAPPROVED_OPERATION_SET' });
      throw error;
    }

    try {
      await recheckBeforeApply();
      state.phase = 'applying';
      const outerBeforeActiveClientLaunch = context.beforeActiveClientLaunch;
      const outerWithActiveClientLaunch = context.withActiveClientLaunch;
      const adapterContext = Object.freeze({
        ...context,
        beforeActiveClientLaunch: async evidence => {
          await recheckAfterVerify();
          return outerBeforeActiveClientLaunch?.(evidence);
        },
        withActiveClientLaunch: async (evidence, callback) => {
          if (typeof callback !== 'function') fail('active launch callback is invalid', 'INVALID_CLIENT_LAUNCH');
          return withPinnedTransactionEvidence(async transactionGuard => {
            if (typeof outerWithActiveClientLaunch === 'function') {
              return outerWithActiveClientLaunch(evidence, async (outerGuard, launch) => {
                const guard = Object.freeze({
                  assertPinned() {
                    transactionGuard?.assertPinned?.();
                    outerGuard?.assertPinned?.();
                  },
                });
                guard.assertPinned();
                return callback(guard, launch);
              });
            }
            await outerBeforeActiveClientLaunch?.(evidence);
            transactionGuard?.assertPinned?.();
            return callback(transactionGuard, context.launch ?? null);
          });
        },
        transaction: transactionCapability,
      });
      let actionRequired = false;
      for (const clientId of CLIENT_IDS) {
        const adapter = state.adapters.get(clientId);
        if (!adapter) continue;
        const clientOperations = operations.filter(operation => operation.client_id === clientId);
        state.currentClient = clientId;
        let applyResult;
        try {
          applyResult = await adapter.apply(adapterContext, clientOperations);
          const verified = await adapter.verify(adapterContext, clientOperations);
          const status = verified?.status ?? applyResult?.status ?? 'READY';
          if (ACTION_STATUSES.has(status)) actionRequired = true;
          else if (!READY_STATUSES.has(status)) fail('adapter verification did not reach a committable state', 'ADAPTER_VERIFY_FAILED', { client_id: clientId });
          await recheckAfterVerify();
          state.clientResults.push({ client_id: clientId, status });
        } catch (error) {
          state.clientResults.push({ client_id: clientId, status: 'FAILED', error_code: error?.code ?? 'CLIENT_APPLY_FAILED' });
          throw error;
        } finally {
          state.currentClient = null;
        }
      }

      const deferredDeleteFailures = await commitDeferredDeletes();
      const cleanupFailures = [];
      for (const record of state.records.values()) {
        try {
          await deleteSnapshot(record);
        } catch (error) {
          cleanupFailures.push({
            path: record.path,
            code: error?.code ?? 'SNAPSHOT_DELETE_FAILED',
            retained_until: record.snapshot.metadata.retained_until,
          });
        }
      }
      state.phase = 'complete';
      await releaseLease();
      return {
        status: actionRequired || cleanupFailures.length > 0 || deferredDeleteFailures.length > 0 ? 'ACTION_REQUIRED' : 'APPLIED',
        ...transactionResultBase(state),
        rollback: null,
        retained_snapshots: cleanupFailures.map(row => ({ path: row.path, retained_until: row.retained_until })),
        cleanup_actions: [
          ...cleanupFailures.map(row => ({ path: row.path, code: row.code })),
          ...deferredDeleteFailures,
        ],
      };
    } catch (error) {
      return rollbackInternal({ reason: error?.code ?? 'APPLY_FAILED' });
    }
  }

  async function rollback({ reason = 'ROLLBACK_REQUESTED' } = {}) {
    if (!['snapshotted', 'applying'].includes(state.phase)) fail('transaction cannot roll back in its current state', 'TRANSACTION_STATE_INVALID');
    return rollbackInternal({ reason });
  }

  return Object.freeze({ snapshot, apply, rollback });
}
