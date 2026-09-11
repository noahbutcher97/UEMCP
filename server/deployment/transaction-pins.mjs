// transaction-pins.mjs — the pinning cluster of the client transaction:
// fingerprint capture, lease release, pinned directories and records, parent
// revalidation and creation, metadata-preserving replacement, plus the two
// bookkeeping helpers (markChanged, currentOperation) the stage cluster needs.
// Closes over the transaction's shared `state`; owns no state of its own.

import { dirname } from 'node:path';

import {
  captureClientPathFingerprint,
  directoryIdentity,
  fail,
  fingerprintsEqual,
  identityEqual,
  inspectExistingDirectoryAncestry,
  isMissing,
  pathKey,
  statIdentity,
} from './transaction-common.mjs';

export function createTransactionPins({ state, fsImpl, windowsNative, processRunner, systemRoot }) {
  const capture = (path, roots, writable = true) => captureClientPathFingerprint(path, {
    allowedRoots: roots,
    fsImpl,
    windowsNative,
    processRunner,
    systemRoot,
    writable,
  });

  async function releaseLease() {
    if (!state.lease) return;
    const lease = state.lease;
    const ownsLease = state.ownsLease;
    state.lease = null;
    state.ownsLease = false;
    if (ownsLease) await lease.release();
  }

  async function withPinnedDirectory(directory, callback) {
    const directories = await inspectExistingDirectoryAncestry(directory, fsImpl);
    return windowsNative.withPinnedAncestry({
      directories,
      callback,
      systemRoot,
    });
  }

  async function revalidateRecordParents(record) {
    let nearest;
    try {
      nearest = await directoryIdentity(record.parentPlan.nearest_existing, fsImpl);
    } catch (error) {
      if (isMissing(error)) fail('nearest existing parent disappeared', 'TRANSACTION_PRECONDITION_CHANGED');
      throw error;
    }
    if (!identityEqual(nearest, record.parentPlan.nearest_identity)) {
      fail('nearest existing parent changed identity', 'TRANSACTION_PRECONDITION_CHANGED');
    }
    for (const created of record.createdDirectories) {
      let current;
      try {
        current = await directoryIdentity(created.path, fsImpl);
      } catch (error) {
        if (isMissing(error)) fail('transaction-created parent disappeared', 'TRANSACTION_PRECONDITION_CHANGED');
        throw error;
      }
      if (!identityEqual(current, created.identity)) {
        fail('transaction-created parent changed identity', 'TRANSACTION_PRECONDITION_CHANGED');
      }
    }
  }

  async function withPinnedRecord(record, expectedFingerprint, callback) {
    return withPinnedDirectory(dirname(record.path), async guard => {
      guard?.assertPinned?.();
      await revalidateRecordParents(record);
      const current = await capture(record.path, [record.allowedRoot], true);
      if (!fingerprintsEqual(current, expectedFingerprint)) {
        fail('writable path changed before pinned mutation', 'TRANSACTION_PRECONDITION_CHANGED');
      }
      guard?.assertPinned?.();
      return callback({
        current,
        assertPinned: () => guard?.assertPinned?.(),
      });
    });
  }

  async function createMissingParents(record) {
    if (record.parentPlan.missing_parents.length === 0) return;
    for (const path of record.parentPlan.missing_parents) {
      try {
        const existing = await fsImpl.lstat(path);
        if (!existing.isDirectory() || existing.isSymbolicLink()) fail('planned parent became unsafe', 'TRANSACTION_PRECONDITION_CHANGED');
        const created = record.createdDirectories.find(row => pathKey(row.path) === pathKey(path));
        if (!created || !identityEqual(statIdentity(existing), created.identity)) {
          fail('planned-missing parent was created outside this transaction', 'TRANSACTION_PRECONDITION_CHANGED');
        }
      } catch (error) {
        if (!isMissing(error)) throw error;
        await withPinnedDirectory(dirname(path), async guard => {
          guard?.assertPinned?.();
          await revalidateRecordParents(record);
          try {
            await fsImpl.lstat(path);
            fail('planned-missing parent was created outside this transaction', 'TRANSACTION_PRECONDITION_CHANGED');
          } catch (inspectionError) {
            if (!isMissing(inspectionError)) throw inspectionError;
          }
          guard?.assertPinned?.();
          await fsImpl.mkdir(path);
          guard?.assertPinned?.();
          const created = { path, identity: await directoryIdentity(path, fsImpl) };
          record.createdDirectories.push(created);
          state.createdDirectories.push(created);
        });
      }
    }
  }

  async function replaceExisting(replacementPath, destinationPath) {
    return windowsNative.replaceFilePreservingMetadata({
      replacementPath,
      destinationPath,
      runner: processRunner,
      systemRoot,
      fsImpl,
    });
  }

  function markChanged(record, fingerprint) {
    record.appliedFingerprint = fingerprint;
    record.currentFingerprint = fingerprint;
    if (!record.changed) {
      record.changed = true;
      record.changedBy = state.currentClient;
      state.changedOrder.push(record.key);
    }
  }

  function currentOperation(path) {
    const key = pathKey(path);
    return state.operations.find(operation => operation.client_id === state.currentClient
      && pathKey(operation.path) === key);
  }

  return Object.freeze({
    capture,
    releaseLease,
    withPinnedDirectory,
    revalidateRecordParents,
    withPinnedRecord,
    createMissingParents,
    replaceExisting,
    markChanged,
    currentOperation,
  });
}
