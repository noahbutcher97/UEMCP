// transaction-stage.mjs — the staged-write cluster of the client transaction:
// fingerprinted whole-file writes, native staging directories with quarantine
// and cleanup, and the ownership ledger that records what UEMCP wrote. Depends
// on the pins cluster for record pinning and change bookkeeping.

import { randomBytes } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

import { canonicalJson, sha256Bytes } from './canonical-json.mjs';
import {
  MAX_CONFIG_BYTES,
  MAX_STAGE_ENTRIES,
  STAGED_WRITE_TOKEN,
  STAGE_QUARANTINE_PATTERN,
  assertWritableAncestry,
  contained,
  fail,
  fingerprintsEqual,
  isMissing,
  pathKey,
} from './transaction-common.mjs';

// Factory boundary. Closes over `state`, the pins cluster, the required
// `localState` collaborator, and the injected `fsImpl`, `windowsNative`,
// `clock`, `processRunner`, `systemRoot` test seams. Invariants enforced
// here: `writeFile`/`runStagedWrite` run only while `state.phase ===
// 'applying'` and only against a path already in `state.records`;
// `runStagedWrite` is one-shot per record (`record.externalWriteUsed`) and
// stages under `localState.paths().state`/`native-staging`, refusing output
// that escapes that root or doesn't match the declared relative path.
export function createTransactionStage({ state, fsImpl, windowsNative, localState, clock, pins, processRunner, systemRoot }) {
  const {
    capture,
    createMissingParents,
    currentOperation,
    markChanged,
    replaceExisting,
    withPinnedDirectory,
    withPinnedRecord,
  } = pins;

  async function writeFile(path, bytes, { parse: parseResult, [STAGED_WRITE_TOKEN]: stagedWrite = false } = {}) {
    if (state.phase !== 'applying') fail('transaction writes are available only during apply', 'TRANSACTION_NOT_APPLYING');
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) fail('transaction write requires bytes', 'INVALID_TRANSACTION_BYTES');
    const content = Buffer.from(bytes);
    if (content.length > MAX_CONFIG_BYTES) fail('transaction config exceeds its byte limit', 'CONFIG_BYTE_LIMIT');
    const key = pathKey(path);
    const record = state.records.get(key);
    if (!record || pathKey(record.path) !== key) fail('adapter attempted an unplanned write', 'UNAPPROVED_OPERATION_SET');
    if (currentOperation(path)?.external_write === true && stagedWrite !== true) {
      fail('reviewed external write must use the native-write capability', 'EXTERNAL_WRITE_REQUIRED');
    }

    const before = await capture(record.path, [record.allowedRoot], true);
    if (!fingerprintsEqual(before, record.currentFingerprint)) fail('writable path changed before replacement', 'TRANSACTION_PRECONDITION_CHANGED');
    await createMissingParents(record);
    const afterParents = await capture(record.path, [record.allowedRoot], true);
    if (!fingerprintsEqual(afterParents, before)) fail('writable path changed during parent creation', 'TRANSACTION_PRECONDITION_CHANGED');

    return withPinnedRecord(record, before, async ({ current, assertPinned }) => {
      const scratch = join(dirname(record.path), `.${randomBytes(16).toString('hex')}.uemcp-write`);
      let handle = null;
      try {
        assertPinned();
        handle = await fsImpl.open(scratch, 'wx', record.snapshot.metadata.mode ?? 0o600);
        await handle.writeFile(content);
        await handle.sync();
        await handle.close();
        handle = null;
        assertPinned();

        try {
          if (current.exists) {
            await replaceExisting(scratch, record.path);
          } else {
            const stillAbsent = await capture(record.path, [record.allowedRoot], true);
            if (!fingerprintsEqual(stillAbsent, current)) fail('missing target changed before create', 'TRANSACTION_PRECONDITION_CHANGED');
            assertPinned();
            await fsImpl.rename(scratch, record.path);
          }
          assertPinned();
        } catch (error) {
          const observed = await capture(record.path, [record.allowedRoot], true).catch(() => null);
          if (observed && !fingerprintsEqual(observed, current)) markChanged(record, observed);
          throw error;
        }

        const diskBytes = await fsImpl.readFile(record.path);
        const applied = await capture(record.path, [record.allowedRoot], true);
        assertPinned();
        markChanged(record, applied);
        if (!diskBytes.equals(content) || applied.content_sha256 !== sha256Bytes(content)) {
          fail('client config changed during transaction replacement', 'TRANSACTION_POSTWRITE_CHANGED');
        }
        if (current.exists && applied.metadata_sha256 !== current.metadata_sha256) {
          fail('existing-file security metadata changed during replacement', 'METADATA_PRESERVATION_FAILED');
        }
        if (typeof parseResult === 'function') await parseResult(diskBytes);
        return {
          path: record.path,
          content_sha256: applied.content_sha256,
          metadata_sha256: applied.metadata_sha256,
        };
      } finally {
        if (handle) await handle.close().catch(() => {});
        try {
          assertPinned();
          await fsImpl.rm(scratch, { force: true });
          assertPinned();
        } catch {
          // A consumed scratch path or lost pin is safer to leave untouched.
        }
      }
    });
  }

  function safeStageRelativePath(value) {
    if (typeof value !== 'string' || value.trim() === '' || isAbsolute(value)) return false;
    const parts = value.replace(/\\/g, '/').split('/');
    return parts.every(part => part !== '' && part !== '.' && part !== '..');
  }

  function nativeStagePaths() {
    const stateRoot = resolve(localState.paths().state);
    const stageParent = resolve(join(stateRoot, 'native-staging'));
    if (pathKey(dirname(stageParent)) !== pathKey(stateRoot)) {
      fail('native stage parent is outside local state', 'UNSAFE_WRITABLE_PATH');
    }
    return { stateRoot, stageParent };
  }

  async function removeDetachedStage(path, stateRoot, { expectedChildName = null } = {}) {
    if (pathKey(dirname(path)) !== pathKey(stateRoot)) fail('detached native stage path is unsafe', 'STAGED_CLEANUP_FAILED');
    let unsafe = false;
    let contaminated = false;
    try {
      const stat = await fsImpl.lstat(path);
      unsafe = stat.isSymbolicLink() || !stat.isDirectory();
      if (!unsafe && expectedChildName !== null) {
        const names = await fsImpl.readdir(path);
        contaminated = names.length !== 1 || names[0] !== expectedChildName;
      }
      await windowsNative.deleteTreeNoFollow({
        targetPath: path,
        allowedRoot: stateRoot,
        runner: processRunner,
        systemRoot,
        fsImpl,
      });
      const remains = await fsImpl.lstat(path).then(() => true, error => {
        if (isMissing(error)) return false;
        throw error;
      });
      if (remains) fail('native stage cleanup could not be verified', 'STAGED_CLEANUP_FAILED');
      return { removed: true, unsafe, contaminated };
    } catch (error) {
      if (error?.code === 'STAGED_CLEANUP_FAILED') throw error;
      fail('native stage cleanup failed', 'STAGED_CLEANUP_FAILED', { cause_code: error?.code ?? 'UNKNOWN' });
    }
  }

  async function detachAndRemoveStageParent(stageParent, stateRoot, options = {}) {
    if (pathKey(dirname(stageParent)) !== pathKey(stateRoot)) {
      fail('native stage cleanup path is unsafe', 'STAGED_CLEANUP_FAILED');
    }
    await assertWritableAncestry(stateRoot, stateRoot, fsImpl);
    const quarantine = resolve(join(stateRoot, `.native-staging-${randomBytes(12).toString('hex')}.stale`));
    if (pathKey(dirname(quarantine)) !== pathKey(stateRoot)) {
      fail('native stage quarantine path is unsafe', 'STAGED_CLEANUP_FAILED');
    }
    return withPinnedDirectory(stateRoot, async guard => {
      try {
        guard?.assertPinned?.();
        await fsImpl.rename(stageParent, quarantine);
        guard?.assertPinned?.();
      } catch (error) {
        if (isMissing(error)) return { removed: false, unsafe: false, contaminated: false };
        fail('native stage could not be detached for cleanup', 'STAGED_CLEANUP_FAILED', { cause_code: error?.code ?? 'UNKNOWN' });
      }
      return removeDetachedStage(quarantine, stateRoot, options);
    });
  }

  async function cleanupAbandonedStages() {
    const { stateRoot, stageParent } = nativeStagePaths();
    await assertWritableAncestry(stateRoot, stateRoot, fsImpl);
    let unsafe = false;
    for (const name of await fsImpl.readdir(stateRoot)) {
      if (!STAGE_QUARANTINE_PATTERN.test(name)) continue;
      const cleanup = await removeDetachedStage(resolve(join(stateRoot, name)), stateRoot);
      unsafe ||= cleanup.unsafe;
    }
    let stat;
    try {
      stat = await fsImpl.lstat(stageParent);
    } catch (error) {
      if (isMissing(error)) {
        if (unsafe) fail('abandoned native stage is unsafe', 'UNSAFE_WRITABLE_PATH');
        return;
      }
      throw error;
    }
    unsafe ||= stat.isSymbolicLink() || !stat.isDirectory();
    const cleanup = await detachAndRemoveStageParent(stageParent, stateRoot);
    if (unsafe || cleanup.unsafe) fail('native stage parent is unsafe', 'UNSAFE_WRITABLE_PATH');
  }

  async function inspectStage(stageRoot, relativePath) {
    const expectedParts = relativePath.replace(/\\/g, '/').split('/');
    const expected = new Set();
    for (let index = 0; index < expectedParts.length; index += 1) {
      expected.add(expectedParts.slice(0, index + 1).join('/'));
    }
    const observed = [];
    async function visit(directory, prefix = '') {
      const names = await fsImpl.readdir(directory);
      for (const name of names.sort()) {
        const relativeName = prefix ? `${prefix}/${name}` : name;
        observed.push(relativeName);
        if (observed.length > MAX_STAGE_ENTRIES) fail('native stage exceeds its entry limit', 'UNEXPECTED_STAGED_OUTPUT');
        const path = join(directory, name);
        const stat = await fsImpl.lstat(path);
        if (stat.isSymbolicLink()) fail('native stage contains a linked entry', 'UNEXPECTED_STAGED_OUTPUT');
        if (stat.isDirectory()) await visit(path, relativeName);
        else if (!stat.isFile() || Number(stat.nlink) !== 1) fail('native stage contains an unsafe entry', 'UNEXPECTED_STAGED_OUTPUT');
      }
    }
    await visit(stageRoot);
    if (observed.length !== expected.size || observed.some(entry => !expected.has(entry))) {
      fail('native stage contains unexpected output', 'UNEXPECTED_STAGED_OUTPUT');
    }
  }

  async function removeStage(stageRoot, stageParent, stateRoot) {
    if (pathKey(dirname(stageRoot)) !== pathKey(stageParent)) {
      fail('native stage cleanup path is unsafe', 'STAGED_CLEANUP_FAILED');
    }
    const expectedChildName = relative(stageParent, stageRoot);
    if (!expectedChildName || expectedChildName.includes(sep)) fail('native stage child name is unsafe', 'STAGED_CLEANUP_FAILED');
    const cleanup = await detachAndRemoveStageParent(stageParent, stateRoot, { expectedChildName });
    if (!cleanup.removed || cleanup.unsafe) fail('native stage cleanup identity changed', 'STAGED_CLEANUP_FAILED');
    if (cleanup.contaminated) fail('native stage contains undeclared sibling output', 'UNEXPECTED_STAGED_OUTPUT');
  }

  async function runStagedWrite(path, mutate, {
    seed_bytes: seedBytes = Buffer.alloc(0),
    stage_relative_path: relativePath,
    parse: parseResult,
  } = {}) {
    if (state.phase !== 'applying') fail('staged writes are available only during apply', 'TRANSACTION_NOT_APPLYING');
    if (typeof mutate !== 'function' || !safeStageRelativePath(relativePath)) fail('staged write contract is invalid', 'INVALID_EXTERNAL_WRITE');
    if (!Buffer.isBuffer(seedBytes) && !(seedBytes instanceof Uint8Array)) fail('staged write seed requires bytes', 'INVALID_TRANSACTION_BYTES');
    const seed = Buffer.from(seedBytes);
    if (seed.length > MAX_CONFIG_BYTES) fail('staged write seed exceeds its byte limit', 'CONFIG_BYTE_LIMIT');
    const key = pathKey(path);
    const record = state.records.get(key);
    const operation = currentOperation(path);
    if (!record || !operation || operation.external_write !== true || pathKey(record.path) !== key) {
      fail('adapter attempted an unapproved external write', 'UNAPPROVED_EXTERNAL_WRITE');
    }
    if (record.clients.some(clientId => clientId !== state.currentClient)) {
      fail('shared client config cannot use an external writer', 'SHARED_WRITE_CONFLICT');
    }
    if (record.externalWriteUsed === true) fail('staged write capability is one-shot', 'EXTERNAL_WRITE_ALREADY_USED');

    const before = await capture(record.path, [record.allowedRoot], true);
    if (!fingerprintsEqual(before, record.currentFingerprint)) fail('writable path changed before staging', 'TRANSACTION_PRECONDITION_CHANGED');
    const currentBytes = before.exists ? await fsImpl.readFile(record.path) : Buffer.alloc(0);
    if (!currentBytes.equals(seed)) fail('staged seed differs from reviewed provider config', 'INVALID_STAGED_SEED');
    record.externalWriteUsed = true;
    const { stateRoot, stageParent } = nativeStagePaths();
    await assertWritableAncestry(stageParent, stateRoot, fsImpl);
    await fsImpl.mkdir(stageParent, { mode: 0o700 }).catch(error => {
      if (error?.code !== 'EEXIST') throw error;
    });
    await assertWritableAncestry(stageParent, stateRoot, fsImpl);
    const parentStat = await fsImpl.lstat(stageParent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) fail('native stage parent is unsafe', 'UNSAFE_WRITABLE_PATH');
    const stageRoot = await fsImpl.mkdtemp(join(stageParent, `${state.transactionId}-`));
    await fsImpl.chmod(stageRoot, 0o700);
    const stageStat = await fsImpl.lstat(stageRoot);
    if (pathKey(dirname(stageRoot)) !== pathKey(stageParent) || !stageStat.isDirectory() || stageStat.isSymbolicLink()) {
      fail('native stage root is unsafe', 'UNSAFE_WRITABLE_PATH');
    }
    const stagedPath = resolve(stageRoot, relativePath);
    if (!contained(stageRoot, stagedPath)) fail('native stage target escapes its root', 'INVALID_EXTERNAL_WRITE');
    await fsImpl.mkdir(dirname(stagedPath), { recursive: true, mode: 0o700 });
    let handle = null;
    let stagedBytes = null;
    let pendingError = null;
    try {
      handle = await fsImpl.open(stagedPath, 'wx', 0o600);
      await handle.writeFile(seed);
      await handle.sync();
      await handle.close();
      handle = null;
      await mutate(stagedPath, Object.freeze({ root: stageRoot, relative_path: relativePath }));
      await inspectStage(stageRoot, relativePath.replace(/\\/g, '/'));
      const stagedFingerprint = await capture(stagedPath, [stageRoot], true);
      if (!stagedFingerprint.exists || stagedFingerprint.kind !== 'file' || stagedFingerprint.link_kind !== 'none') {
        fail('native stage did not produce a safe config file', 'UNEXPECTED_STAGED_OUTPUT');
      }
      stagedBytes = await fsImpl.readFile(stagedPath);
      if (stagedBytes.length > MAX_CONFIG_BYTES) fail('staged config exceeds its byte limit', 'CONFIG_BYTE_LIMIT');
      if (stagedBytes.equals(seed)) fail('native stage did not change the reviewed config', 'EXTERNAL_WRITE_NO_CHANGE');
      if (typeof parseResult === 'function') await parseResult(stagedBytes);
    } catch (error) {
      pendingError = error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
    try {
      await removeStage(stageRoot, stageParent, stateRoot);
    } catch (error) {
      throw error;
    }
    if (pendingError) throw pendingError;
    return writeFile(record.path, stagedBytes, { parse: parseResult, [STAGED_WRITE_TOKEN]: true });
  }

  const ownershipPath = resolve(localState.paths().ownership);
  const ownershipLedger = Object.freeze({
    async read() {
      try {
        return JSON.parse(await fsImpl.readFile(ownershipPath, 'utf8'));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
    async write(value) {
      return writeFile(ownershipPath, Buffer.from(`${canonicalJson(value)}\n`, 'utf8'), {
        parse: bytes => JSON.parse(bytes.toString('utf8')),
      });
    },
    now: () => new Date(Number(clock())).toISOString(),
  });

  return Object.freeze({ writeFile, runStagedWrite, cleanupAbandonedStages, ownershipLedger, ownershipPath });
}
