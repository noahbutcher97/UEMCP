// transaction-snapshot.mjs — the snapshot cluster of the client transaction:
// taking the pre-apply snapshot (and acquiring the lease), pre and post
// rechecks against captured fingerprints, evidence pinning, deferred deletes,
// restoring records and removing created directories on rollback. Depends on
// pins for capture and pinning and on stage for abandoned-stage cleanup and
// the ownership ledger path.

import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';

import { sha256Bytes } from './canonical-json.mjs';
import { CLIENT_IDS } from './client-contract.mjs';
import {
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
  validateOperations,
  validatePlanDigest,
  validateSharedRows,
} from './transaction-common.mjs';

// Factory boundary. Closes over `state`, the pins/stage clusters, the
// required `localState` collaborator, and the injected `fsImpl`,
// `windowsNative`, `systemRoot` test seams, plus an optional caller-supplied
// `externalLease` (validated via `localState.validateApplyLease` instead of
// acquired here). Owns this half of the phase graph: new -> preflight ->
// snapshotted | failed — `snapshot()` runs only once from `new`, and a
// preflight failure deletes every taken snapshot and releases the lease
// before leaving `failed`.
export function createTransactionSnapshot({ state, fsImpl, windowsNative, localState, pins, stage, systemRoot, externalLease }) {
  const {
    capture,
    releaseLease,
    withPinnedDirectory,
    revalidateRecordParents,
    withPinnedRecord,
    replaceExisting,
    markChanged,
  } = pins;
  const { cleanupAbandonedStages, ownershipPath } = stage;

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

  return Object.freeze({
    deleteSnapshot,
    deleteFileAfterVerify,
    snapshot,
    recheckBeforeApply,
    recheckAfterVerify,
    withPinnedTransactionEvidence,
    commitDeferredDeletes,
    cleanupCreatedDirectories,
    restoreRecord,
  });
}
