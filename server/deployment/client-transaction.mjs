// client-transaction.mjs — staged, fingerprinted, rollback-capable writes
// shared by every client adapter.
// Why: every adapter needs to write client config the same safe way —
// snapshot, verify, write atomically, and roll every touched file back
// together if a later write in the same apply fails.
// Depends on: the local-state lease/snapshot contract (injected), windows-native, fingerprints.
import { randomBytes } from 'node:crypto';
import * as defaultFs from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { sha256Bytes } from './canonical-json.mjs';
import { CLIENT_IDS } from './client-contract.mjs';
import { createProcessRunner } from './process-runner.mjs';
import {
  ACTION_STATUSES,
  DEFAULT_WINDOWS_NATIVE,
  READY_STATUSES,
  WRITABLE_SCOPES,
  adapterMap,
  assertWritableAncestry,
  directoryIdentity,
  fail,
  fingerprintsEqual,
  identityEqual,
  inspectParentPlan,
  isMissing,
  operationDigest,
  pathKey,
  safeAbsolutePath,
  snapshotMatchesFingerprint,
  transactionResultBase,
  validateOperations,
  validatePlanDigest,
  validateSharedRows,
} from './transaction-common.mjs';
import { createTransactionPins } from './transaction-pins.mjs';
import { createTransactionStage } from './transaction-stage.mjs';

export { ClientTransactionError, captureClientPathFingerprint } from './transaction-common.mjs';

// Factory boundary. Everything below closes over one mutable `state` (phase,
// lease, plan and operation digests, per-path records, changed order, created
// directories, deferred deletes, current client). Invariants: `phase` only
// advances forward — new -> preflight -> snapshotted -> applying -> complete,
// diverting to failed (from preflight) or rolling_back -> complete (from
// snapshotted/applying) — never backward; every record written is
// fingerprinted before and after; a failed apply always rolls back before the
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
  const {
    capture,
    releaseLease,
    withPinnedDirectory,
    revalidateRecordParents,
    withPinnedRecord,
    replaceExisting,
    markChanged,
  } = pins;

  const stage = createTransactionStage({ state, fsImpl, windowsNative, localState, clock, pins, processRunner, systemRoot });
  const { writeFile, runStagedWrite, cleanupAbandonedStages, ownershipLedger } = stage;
  const ownershipPath = resolve(localState.paths().ownership);

  async function deleteSnapshot(record) {
    if (!record.snapshot) return;
    await localState.deleteSnapshot(record.snapshot);
    record.snapshot = null;
  }

  async function deleteFileAfterVerify(path) {
    if (state.phase !== 'applying') fail('deferred deletes are available only during apply', 'TRANSACTION_NOT_APPLYING');
    const key = pathKey(path);
    const record = state.records.get(key);
    const operation = state.operations.find(candidate => candidate.client_id === state.currentClient
      && pathKey(candidate.path) === key
      && candidate.delete_after_verify === true);
    if (!record || !operation || !record.changed || record.changedBy !== state.currentClient) {
      fail('adapter attempted an unapproved deferred delete', 'UNAPPROVED_DEFERRED_DELETE');
    }
    if (record.clients.some(clientId => clientId !== state.currentClient)) {
      fail('shared client config cannot be deleted', 'SHARED_WRITE_CONFLICT');
    }
    state.deferredDeletes.set(key, { key, client_id: state.currentClient });
    return { path: record.path, status: 'DEFERRED' };
  }

  const transactionCapability = Object.freeze({ writeFile, runStagedWrite, deleteFileAfterVerify, ownershipLedger });

  async function snapshot({ planDigest, adapters, operations, context = {}, ownershipFingerprint } = {}) {
    if (state.phase !== 'new') fail('transaction snapshot can run only once', 'TRANSACTION_STATE_INVALID');
    validatePlanDigest(planDigest);
    const mappedAdapters = adapterMap(adapters);
    validateOperations(operations, mappedAdapters);
    if (externalLease) {
      await localState.validateApplyLease(externalLease);
      state.lease = externalLease;
      state.ownsLease = false;
    } else {
      state.lease = await localState.acquireApplyLease({
        pid: process.pid,
        processStart: Math.round(Date.now() - process.uptime() * 1000),
        waitMs: 0,
      });
      state.ownsLease = true;
    }
    state.phase = 'preflight';
    try {
      await cleanupAbandonedStages();
      const writableRows = [];
      const readOnlyRows = [];
      for (const clientId of CLIENT_IDS) {
        const adapter = mappedAdapters.get(clientId);
        if (!adapter) continue;
        const clientOperations = operations.filter(operation => operation.client_id === clientId);
        const declared = await adapter.snapshot(context, clientOperations);
        if (!declared || !Array.isArray(declared.writable_paths) || !Array.isArray(declared.read_only_paths)) {
          fail('adapter snapshot declaration is invalid', 'INVALID_ADAPTER_SNAPSHOT');
        }
        for (const row of declared.writable_paths) {
          const operation = clientOperations.find(candidate => pathKey(candidate.path) === pathKey(row.path));
          if (!operation) fail('adapter declared an unapproved writable path', 'UNAPPROVED_OPERATION_SET');
          writableRows.push({
            client_id: clientId,
            path: row.path,
            allowed_root: row.allowed_root,
            scope_kind: row.scope_kind,
            fingerprint: row.fingerprint,
            owned_paths: row.owned_paths,
            shared_resource_id: row.shared_resource_id,
          });
        }
        for (const row of declared.read_only_paths) readOnlyRows.push({ ...row, client_id: clientId });
      }

      const operationPaths = new Set(writableRows.map(row => `${row.client_id}:${pathKey(row.path)}`));
      const readOnlyOperationPaths = new Set(readOnlyRows.map(row => `${row.client_id}:${pathKey(row.path)}`));
      for (const operation of operations) {
        const declaredPaths = operation.ledger_only === true ? readOnlyOperationPaths : operationPaths;
        if (!declaredPaths.has(`${operation.client_id}:${pathKey(operation.path)}`)) {
          fail('planned operation lacks an adapter writable declaration', 'INVALID_ADAPTER_SNAPSHOT');
        }
      }
      if (!ownershipFingerprint || typeof ownershipFingerprint !== 'object') fail('ownership ledger precondition is missing', 'INVALID_OPERATION_SET');
      writableRows.push({
        client_id: 'ownership',
        path: ownershipPath,
        allowed_root: localState.paths().state,
        scope_kind: 'local_state',
        fingerprint: ownershipFingerprint,
        owned_paths: ['/records'],
        shared_resource_id: 'uemcp-ownership-ledger',
      });

      for (const row of writableRows) {
        if (!WRITABLE_SCOPES.has(row.scope_kind)) fail('adapter attempted to write a read-only scope', 'READ_ONLY_SCOPE');
        await assertWritableAncestry(row.path, row.allowed_root, fsImpl);
        const current = await capture(row.path, [row.allowed_root], true);
        if (!fingerprintsEqual(current, row.fingerprint)) fail('writable path precondition changed', 'TRANSACTION_PRECONDITION_CHANGED');
        row.current = current;
      }
      for (const row of readOnlyRows) {
        if (!row?.fingerprint || !safeAbsolutePath(row.path) || !safeAbsolutePath(row.allowed_root)) {
          fail('read-only evidence declaration is invalid', 'INVALID_ADAPTER_SNAPSHOT');
        }
        const current = await capture(row.path, [row.allowed_root], false);
        if (!fingerprintsEqual(current, row.fingerprint)) fail('read-only evidence precondition changed', 'TRANSACTION_PRECONDITION_CHANGED');
        row.current = current;
      }

      const grouped = new Map();
      for (const row of writableRows) {
        const key = pathKey(row.path);
        if (!grouped.has(key)) grouped.set(key, []);
        grouped.get(key).push(row);
      }
      for (const rows of grouped.values()) validateSharedRows(rows);
      if (grouped.has(pathKey(ownershipPath)) && grouped.get(pathKey(ownershipPath)).length !== 1) {
        fail('client config collides with the ownership ledger', 'SHARED_WRITE_CONFLICT');
      }

      const ordered = [...grouped.entries()].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
      for (const [key, rows] of ordered) {
        const row = rows[0];
        const parentPlan = await inspectParentPlan(row.path, row.allowed_root, fsImpl);
        state.records.set(key, {
          key,
          path: resolve(row.path),
          allowedRoot: resolve(row.allowed_root),
          originalFingerprint: row.current,
          currentFingerprint: row.current,
          appliedFingerprint: null,
          changed: false,
          changedBy: null,
          parentPlan,
          createdDirectories: [],
          clients: [...new Set(rows.map(candidate => candidate.client_id))],
          snapshot: null,
          externalWriteUsed: false,
        });
      }
      state.readOnly = readOnlyRows;
      for (const record of state.records.values()) {
        record.snapshot = await localState.createSnapshot(record.path, {
          transactionId: state.transactionId,
          retainOnConflict: true,
        });
        if (!snapshotMatchesFingerprint(record.snapshot, record.currentFingerprint)) {
          fail('snapshot differs from the approved writable fingerprint', 'TRANSACTION_PRECONDITION_CHANGED');
        }
      }
      state.planDigest = planDigest;
      state.operationDigest = operationDigest(operations);
      state.adapters = mappedAdapters;
      state.operations = structuredClone(operations);
      state.phase = 'snapshotted';
      return {
        transaction_id: state.transactionId,
        writable_paths: [...state.records.values()].map(record => record.path),
        read_only_paths: readOnlyRows.map(row => resolve(row.path)),
      };
    } catch (error) {
      for (const record of state.records.values()) await deleteSnapshot(record).catch(() => {});
      state.phase = 'failed';
      await releaseLease().catch(() => {});
      throw error;
    }
  }

  async function recheckBeforeApply() {
    for (const record of state.records.values()) {
      const current = await capture(record.path, [record.allowedRoot], true);
      if (!fingerprintsEqual(current, record.currentFingerprint)) fail('writable path changed after snapshot', 'TRANSACTION_PRECONDITION_CHANGED');
    }
    for (const row of state.readOnly) {
      const current = await capture(row.path, [row.allowed_root], false);
      if (!fingerprintsEqual(current, row.current)) fail('read-only evidence changed after snapshot', 'TRANSACTION_PRECONDITION_CHANGED');
    }
  }

  async function recheckAfterVerify() {
    for (const record of state.records.values()) {
      const expected = record.changed ? record.appliedFingerprint : record.currentFingerprint;
      const current = await capture(record.path, [record.allowedRoot], true);
      if (!fingerprintsEqual(current, expected)) {
        fail('client config evidence changed during apply', 'TRANSACTION_POSTWRITE_CHANGED');
      }
    }
    for (const row of state.readOnly) {
      const current = await capture(row.path, [row.allowed_root], false);
      if (!fingerprintsEqual(current, row.current)) fail('read-only evidence changed during apply', 'TRANSACTION_POSTWRITE_CHANGED');
    }
  }

  async function withPinnedTransactionEvidence(callback) {
    await recheckAfterVerify();
    const presentByPath = new Map();
    const absentByPath = new Map();
    const addEvidencePath = (path, exists) => {
      const key = pathKey(path);
      const target = exists ? presentByPath : absentByPath;
      target.set(key, resolve(path));
    };
    for (const record of state.records.values()) {
      const expected = record.changed ? record.appliedFingerprint : record.currentFingerprint;
      addEvidencePath(record.path, expected?.exists === true);
    }
    for (const row of state.readOnly) {
      addEvidencePath(row.path, row.current?.exists === true);
    }
    for (const key of presentByPath.keys()) absentByPath.delete(key);
    const paths = [...presentByPath.values()].sort((left, right) => pathKey(left).localeCompare(pathKey(right)));
    const absentPaths = [...absentByPath.values()].sort((left, right) => pathKey(left).localeCompare(pathKey(right)));
    const invoke = async guard => {
      guard?.assertPinned?.();
      await recheckAfterVerify();
      guard?.assertPinned?.();
      const value = await callback(guard);
      guard?.assertPinned?.();
      await recheckAfterVerify();
      guard?.assertPinned?.();
      return value;
    };
    return windowsNative.withPinnedFiles({ paths, absentPaths, callback: invoke, systemRoot });
  }

  async function commitDeferredDeletes() {
    const failures = [];
    const ordered = [...state.deferredDeletes.values()].sort((left, right) => left.key.localeCompare(right.key));
    for (const deferred of ordered) {
      const record = state.records.get(deferred.key);
      try {
        await withPinnedRecord(record, record.appliedFingerprint, async ({ assertPinned }) => {
          assertPinned();
          await fsImpl.rm(record.path);
          assertPinned();
          const after = await capture(record.path, [record.allowedRoot], true);
          if (after.exists) fail('deferred delete did not produce absence', 'DEFERRED_DELETE_CONFLICT');
          assertPinned();
          markChanged(record, after);
        });
      } catch (error) {
        const conflictCodes = new Set(['TRANSACTION_PRECONDITION_CHANGED', 'UNSAFE_WRITABLE_PATH', 'DEFERRED_DELETE_CONFLICT']);
        failures.push({
          path: record.path,
          code: conflictCodes.has(error?.code) ? 'DEFERRED_DELETE_CONFLICT' : error?.code ?? 'DEFERRED_DELETE_FAILED',
        });
      }
    }
    return failures;
  }

  async function cleanupCreatedDirectories() {
    const seen = new Set();
    const failures = [];
    for (const created of [...state.createdDirectories].reverse()) {
      const key = pathKey(created.path);
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        await withPinnedDirectory(dirname(created.path), async guard => {
          guard?.assertPinned?.();
          const current = await directoryIdentity(created.path, fsImpl);
          if (!identityEqual(current, created.identity)) {
            failures.push({ path: created.path, code: 'CREATED_DIRECTORY_IDENTITY_CHANGED' });
            return;
          }
          if ((await fsImpl.readdir(created.path)).length !== 0) {
            failures.push({ path: created.path, code: 'CREATED_DIRECTORY_NOT_EMPTY' });
            return;
          }
          guard?.assertPinned?.();
          await fsImpl.rmdir(created.path);
          guard?.assertPinned?.();
        });
      } catch (error) {
        if (!isMissing(error)) {
          failures.push({ path: created.path, code: 'CREATED_DIRECTORY_CLEANUP_FAILED' });
        }
      }
    }
    return failures;
  }

  async function restoreRecord(record) {
    try {
      return await withPinnedDirectory(dirname(record.path), async guard => {
        guard?.assertPinned?.();
        await revalidateRecordParents(record);
        let current;
        try {
          current = await capture(record.path, [record.allowedRoot], true);
        } catch (error) {
          if (['UNSAFE_WRITABLE_PATH', 'METADATA_INSPECTION_FAILED', 'READ_ONLY_TARGET'].includes(error?.code)) {
            return { status: 'conflict', path: record.path, code: 'ROLLBACK_CONFLICT' };
          }
          throw error;
        }
        if (!fingerprintsEqual(current, record.appliedFingerprint)) {
          return { status: 'conflict', path: record.path, code: 'ROLLBACK_CONFLICT' };
        }
        guard?.assertPinned?.();
        const metadata = record.snapshot.metadata;
        if (!metadata.exists) {
          await fsImpl.rm(record.path, { force: true });
          guard?.assertPinned?.();
          const absent = await capture(record.path, [record.allowedRoot], true);
          if (absent.exists) return { status: 'failed', path: record.path, code: 'ROLLBACK_VERIFY_FAILED' };
          return { status: 'restored', path: record.path };
        }

        const payloadPath = join(record.snapshot.directory, 'payload.bin');
        const payload = await fsImpl.readFile(payloadPath);
        if (sha256Bytes(payload) !== metadata.original_sha256) return { status: 'failed', path: record.path, code: 'INVALID_SNAPSHOT' };
        const scratch = join(dirname(record.path), `.${randomBytes(16).toString('hex')}.uemcp-rollback`);
        let handle = null;
        try {
          guard?.assertPinned?.();
          handle = await fsImpl.open(scratch, 'wx', metadata.mode ?? 0o600);
          await handle.writeFile(payload);
          await handle.sync();
          await handle.close();
          handle = null;
          guard?.assertPinned?.();
          await replaceExisting(scratch, record.path);
          guard?.assertPinned?.();
          if (metadata.mode !== null) await fsImpl.chmod(record.path, metadata.mode);
          if (metadata.atime_ms !== null && metadata.mtime_ms !== null) {
            await fsImpl.utimes(record.path, metadata.atime_ms / 1000, metadata.mtime_ms / 1000);
          }
          const restored = await capture(record.path, [record.allowedRoot], true);
          if (!fingerprintsEqual(restored, record.originalFingerprint, { includeIdentity: false, includeMutable: false })) {
            return { status: 'failed', path: record.path, code: 'ROLLBACK_VERIFY_FAILED' };
          }
          if (metadata.atime_ms !== null && metadata.mtime_ms !== null) {
            await fsImpl.utimes(record.path, metadata.atime_ms / 1000, metadata.mtime_ms / 1000);
          }
          const finalStat = await fsImpl.lstat(record.path);
          guard?.assertPinned?.();
          if ((metadata.mode !== null && Number(finalStat.mode) !== Number(metadata.mode))
            || (metadata.atime_ms !== null && Math.abs(Number(finalStat.atimeMs) - Number(metadata.atime_ms)) > 2)
            || (metadata.mtime_ms !== null && Math.abs(Number(finalStat.mtimeMs) - Number(metadata.mtime_ms)) > 2)) {
            return { status: 'failed', path: record.path, code: 'ROLLBACK_METADATA_VERIFY_FAILED' };
          }
          return { status: 'restored', path: record.path };
        } finally {
          if (handle) await handle.close().catch(() => {});
          try {
            guard?.assertPinned?.();
            await fsImpl.rm(scratch, { force: true });
            guard?.assertPinned?.();
          } catch {
            // A consumed scratch path or lost pin is safer to leave untouched.
          }
        }
      });
    } catch (error) {
      if (['UNSAFE_WRITABLE_PATH', 'METADATA_INSPECTION_FAILED', 'READ_ONLY_TARGET', 'TRANSACTION_PRECONDITION_CHANGED'].includes(error?.code)) {
        return { status: 'conflict', path: record.path, code: 'ROLLBACK_CONFLICT' };
      }
      throw error;
    }
  }

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
