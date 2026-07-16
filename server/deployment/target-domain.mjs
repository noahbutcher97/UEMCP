import { randomBytes } from 'node:crypto';
import * as syncFs from 'node:fs';
import * as defaultAsyncFs from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, parse, posix, relative, resolve, sep, win32 } from 'node:path';

import { sha256Bytes, sha256Canonical } from './canonical-json.mjs';
import { createStageResult } from './contracts.mjs';
import { fingerprintPath } from './fingerprints.mjs';
import { replaceFilePreservingMetadata } from './windows-native.mjs';
import {
  registerProjectTargetProfile,
  resolveDefaultTargetsPath,
} from '../project-targets.mjs';

export class TargetDomainError extends Error {
  constructor(message, code = 'INVALID_TARGET', details = {}) {
    super(message);
    this.name = 'TargetDomainError';
    this.code = code;
    this.details = details;
  }
}

function absolutePath(value) {
  return typeof value === 'string' && (isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value));
}

function pathKey(value) {
  const normalized = resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function contained(root, candidate) {
  const rel = relative(pathKey(root), pathKey(candidate));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function devicePath(value) {
  return /^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(value);
}

async function assertNoLinkedAncestors(path, asyncFs) {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const segments = relative(root, absolute).split(sep).filter(Boolean);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const stat = await asyncFs.lstat(current);
      if (stat.isSymbolicLink()) throw new TargetDomainError('path contains a symbolic link or junction', 'INVALID_TARGET');
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
}

async function validateProjectPath(projectPath, asyncFs) {
  if (!absolutePath(projectPath) || extname(projectPath).toLowerCase() !== '.uproject' || devicePath(projectPath)) {
    throw new TargetDomainError('requested project must be an absolute non-device .uproject path');
  }
  await assertNoLinkedAncestors(projectPath, asyncFs);
  const fingerprint = await fingerprintPath(projectPath, { allowedRoots: [dirname(projectPath)], fsImpl: asyncFs });
  if (!fingerprint.exists || fingerprint.kind !== 'file' || fingerprint.link_kind !== 'none' || fingerprint.link_count !== 1) {
    throw new TargetDomainError('requested project must be a regular single-link file');
  }
  return fingerprint.real_path;
}

async function validateConfigPath(configPath, { generatedRoot, asyncFs }) {
  if (!absolutePath(configPath) || extname(configPath).toLowerCase() !== '.json' || devicePath(configPath)) {
    throw new TargetDomainError('target registry must be an absolute non-device .json path');
  }
  const absolute = resolve(configPath);
  if (generatedRoot && !contained(generatedRoot, absolute)) {
    throw new TargetDomainError('generated target registry escaped its source/state root');
  }
  await assertNoLinkedAncestors(absolute, asyncFs);
  return absolute;
}

async function compositeFingerprint(path, { asyncFs, windowsNative, processRunner, systemRoot }) {
  const base = await fingerprintPath(path, { allowedRoots: [dirname(path)], fsImpl: asyncFs });
  if (base.exists && (base.kind !== 'file' || base.link_kind !== 'none' || base.link_count !== 1)) {
    throw new TargetDomainError('target registry must be a regular single-link file');
  }
  let metadata = null;
  if (base.exists && typeof windowsNative?.fingerprintWindowsFileMetadata === 'function' && processRunner) {
    metadata = await windowsNative.fingerprintWindowsFileMetadata(path, {
      runner: processRunner,
      systemRoot,
      allowedRoots: [dirname(path)],
      fsImpl: asyncFs,
    });
  } else if (base.exists) {
    const stat = await asyncFs.lstat(path);
    metadata = {
      mode: stat.mode,
      mtime_ms: stat.mtimeMs,
      birthtime_ms: stat.birthtimeMs,
    };
  }
  const value = { ...base, metadata };
  return { ...value, composite_sha256: sha256Canonical(value) };
}

function sameComposite(left, right) {
  return left?.composite_sha256 === right?.composite_sha256;
}

function committedSyncFailure() {
  return createStageResult({
    name: 'target',
    status: 'SYNC_FAILED',
    result: 'failed',
    changed: true,
    progress: 'committed',
    actions: [{ code: 'SYNC_FAILED', message: 'The project target registry changed during apply but did not verify cleanly.', command: null }],
  });
}

function configSyncView(asyncPath, fsImpl) {
  return {
    ...fsImpl,
    existsSync: path => fsImpl.existsSync(path),
    readFileSync: (path, encoding) => fsImpl.readFileSync(path, encoding),
    writeFileSync: (...args) => fsImpl.writeFileSync(...args),
    mkdirSync: (...args) => fsImpl.mkdirSync(...args),
    configPath: asyncPath,
  };
}

export function createTargetDomain({
  repoRoot,
  stateRoot = null,
  sourceKind = null,
  targetsPath = null,
  fsImpl = syncFs,
  asyncFs = defaultAsyncFs,
  windowsNative = { replaceFilePreservingMetadata },
  processRunner = null,
  systemRoot = process.env.SystemRoot || process.env.WINDIR,
} = {}) {
  if (!absolutePath(repoRoot)) throw new TargetDomainError('target domain requires an absolute repository root');
  const explicit = targetsPath !== null;
  const inferredSourceKind = sourceKind
    ?? (fsImpl.existsSync(join(resolve(repoRoot), '.git'))
      ? 'git_checkout'
      : fsImpl.existsSync(join(resolve(repoRoot), '.uemcp-source-provenance.json'))
        ? 'pinned_archive'
        : 'git_checkout');
  const configPath = resolveDefaultTargetsPath({
    repoRoot,
    stateRoot,
    sourceKind: inferredSourceKind,
    explicitTargetsPath: targetsPath,
    fsImpl,
  });
  const generatedRoot = explicit ? null : (inferredSourceKind === 'pinned_archive' ? stateRoot : repoRoot);
  const syncView = configSyncView(configPath, fsImpl);

  async function inspectContext(context) {
    const requestedProject = context?.request?.requested_project ?? null;
    if (requestedProject === null) {
      if (!explicit) return { requestedProject: null, configPath: resolve(configPath), fingerprint: null };
      const validatedConfigPath = await validateConfigPath(configPath, { generatedRoot, asyncFs });
      const fingerprint = await compositeFingerprint(validatedConfigPath, {
        asyncFs,
        windowsNative,
        processRunner: context?.processRunner ?? processRunner,
        systemRoot,
      });
      return { requestedProject: null, configPath: validatedConfigPath, fingerprint };
    }
    const projectPath = await validateProjectPath(requestedProject, asyncFs);
    const validatedConfigPath = await validateConfigPath(configPath, { generatedRoot, asyncFs });
    const fingerprint = await compositeFingerprint(validatedConfigPath, {
      asyncFs,
      windowsNative,
      processRunner: context?.processRunner ?? processRunner,
      systemRoot,
    });
    let registration;
    try {
      registration = registerProjectTargetProfile({
        configPath: validatedConfigPath,
        uprojectPath: projectPath,
        dryRun: true,
        fsImpl: syncView,
      });
    } catch (error) {
      throw new TargetDomainError(`target registry could not be parsed: ${error.message}`, 'MALFORMED_CONFIG');
    }
    return { requestedProject: projectPath, configPath: validatedConfigPath, fingerprint, registration };
  }

  async function inspectReviewedOperation(context, operation) {
    const requestedProject = context?.request?.requested_project ?? null;
    if (requestedProject === null) throw new TargetDomainError('reviewed target operation requires a project', 'PLAN_STALE');
    const projectPath = await validateProjectPath(requestedProject, asyncFs);
    const reviewedConfigPath = await validateConfigPath(operation.config_path, { generatedRoot: null, asyncFs });
    const fingerprint = await compositeFingerprint(reviewedConfigPath, {
      asyncFs,
      windowsNative,
      processRunner: context?.processRunner ?? processRunner,
      systemRoot,
    });
    return { requestedProject: projectPath, configPath: reviewedConfigPath, fingerprint };
  }

  return Object.freeze({
    name: 'target',
    order: 20,

    async plan(context) {
      const inspected = await inspectContext(context);
      if (inspected.requestedProject === null) {
        return {
          stages: [createStageResult({ name: 'target', status: 'NOT_CHECKED', mandatory: false, result: 'skipped' })],
          operations: [],
          preconditions: inspected.fingerprint === null ? [] : [{
            kind: 'file',
            label: 'project-target-registry',
            canonical_path: inspected.configPath,
            fingerprint: inspected.fingerprint,
          }],
        };
      }
      if (inspected.registration.status === 'unchanged') {
        return {
          stages: [createStageResult({ name: 'target', status: 'ALREADY_REGISTERED' })],
          operations: [],
          preconditions: [],
        };
      }
      const proposedBytes = Buffer.from(inspected.registration.serialized, 'utf8');
      const proposedSha256 = sha256Bytes(proposedBytes);
      const operation = {
        operation_id: `target:register:${inspected.registration.alias}`,
        domain: 'target',
        domain_order: 20,
        kind: 'REGISTER_PROJECT_TARGET',
        config_path: inspected.configPath,
        project_path: inspected.requestedProject,
        alias: inspected.registration.alias,
        expected_fingerprint: inspected.fingerprint,
        proposed_document: inspected.registration.document,
        proposed_serialized: inspected.registration.serialized,
        proposed_sha256: proposedSha256,
      };
      return {
        stages: [createStageResult({ name: 'target', status: 'REGISTERED', result: 'action_required' })],
        operations: [operation],
        preconditions: [{
          kind: 'file',
          label: 'project-target-registry',
          canonical_path: inspected.configPath,
          fingerprint: inspected.fingerprint,
          proposed_sha256: proposedSha256,
        }],
      };
    },

    async apply(context, operations) {
      if (!Array.isArray(operations)) throw new TargetDomainError('target operations must be an array');
      if (operations.length === 0) return createStageResult({ name: 'target', status: 'ALREADY_REGISTERED' });
      if (operations.length !== 1 || operations[0].kind !== 'REGISTER_PROJECT_TARGET') {
        throw new TargetDomainError('target domain accepts exactly one registration operation');
      }
      const operation = operations[0];
      const inspected = await inspectReviewedOperation(context, operation);
      if (inspected.requestedProject !== operation.project_path || inspected.configPath !== operation.config_path) {
        throw new TargetDomainError('target request differs from the reviewed operation', 'PLAN_STALE');
      }
      if (!sameComposite(inspected.fingerprint, operation.expected_fingerprint)) {
        throw new TargetDomainError('target registry changed after planning', 'PLAN_STALE');
      }
      const bytes = Buffer.from(operation.proposed_serialized, 'utf8');
      if (sha256Bytes(bytes) !== operation.proposed_sha256) {
        throw new TargetDomainError('proposed target registry bytes do not match the plan', 'PLAN_STALE');
      }
      await asyncFs.mkdir(dirname(operation.config_path), { recursive: true });
      const scratchPath = join(dirname(operation.config_path), `.${randomBytes(16).toString('hex')}.scratch`);
      let handle;
      let committed = false;
      try {
        handle = await asyncFs.open(scratchPath, 'wx', 0o600);
        await handle.writeFile(bytes);
        await handle.sync();
        await handle.close();
        handle = null;
        const beforeWrite = await compositeFingerprint(operation.config_path, {
          asyncFs,
          windowsNative,
          processRunner: context?.processRunner ?? processRunner,
          systemRoot,
        });
        if (!sameComposite(beforeWrite, operation.expected_fingerprint)) {
          throw new TargetDomainError('target registry changed immediately before write', 'PLAN_STALE');
        }
        if (operation.expected_fingerprint.exists) {
          if (typeof windowsNative?.replaceFilePreservingMetadata !== 'function') {
            throw new TargetDomainError('metadata-preserving replacement is unavailable', 'LOCAL_STATE_UNAVAILABLE');
          }
          await windowsNative.replaceFilePreservingMetadata({
            replacementPath: scratchPath,
            destinationPath: operation.config_path,
            runner: context?.processRunner ?? processRunner,
            systemRoot,
            fsImpl: asyncFs,
          });
          committed = true;
        } else {
          try {
            await asyncFs.link(scratchPath, operation.config_path);
            committed = true;
          } catch (error) {
            if (error?.code === 'EEXIST') throw new TargetDomainError('target registry was created concurrently', 'PLAN_STALE');
            throw error;
          }
        }
      } catch (error) {
        if (!committed) {
          const observed = await compositeFingerprint(operation.config_path, {
            asyncFs,
            windowsNative,
            processRunner: context?.processRunner ?? processRunner,
            systemRoot,
          }).catch(() => null);
          committed = observed !== null && !sameComposite(observed, operation.expected_fingerprint);
        }
        if (!committed) throw error;
        return committedSyncFailure();
      } finally {
        if (handle) await handle.close().catch(() => {});
        await asyncFs.rm(scratchPath, { force: true }).catch(() => {});
      }
      const after = await fingerprintPath(operation.config_path, { allowedRoots: [dirname(operation.config_path)], fsImpl: asyncFs });
      if (after.sha256 !== operation.proposed_sha256) return committedSyncFailure();
      return createStageResult({ name: 'target', status: 'REGISTERED', changed: true, progress: 'committed' });
    },

    async verify(context) {
      const inspected = await inspectContext(context);
      if (inspected.requestedProject === null) {
        return createStageResult({ name: 'target', status: 'NOT_CHECKED', mandatory: false, result: 'skipped' });
      }
      if (inspected.registration.status === 'unchanged') {
        return createStageResult({ name: 'target', status: 'ALREADY_REGISTERED' });
      }
      return createStageResult({ name: 'target', status: 'INVALID_TARGET', result: 'action_required' });
    },
    canFingerprintPrecondition(precondition) {
      return precondition.label === 'project-target-registry';
    },
    async fingerprintPrecondition(precondition, context) {
      return {
        fingerprint: await compositeFingerprint(precondition.canonical_path, {
          asyncFs,
          windowsNative,
          processRunner: context?.processRunner ?? processRunner,
          systemRoot,
        }),
      };
    },
  });
}
