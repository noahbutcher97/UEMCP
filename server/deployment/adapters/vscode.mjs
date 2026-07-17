import * as defaultFs from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  resolve,
  win32,
} from 'node:path';

import { readBoundedConfigFile } from '../bounded-config-file.mjs';
import { sha256Bytes, sha256Canonical } from '../canonical-json.mjs';
import { captureClientPathFingerprint } from '../client-transaction.mjs';
import {
  isSensitiveClientEnvironmentName,
  readWindowsEnvironmentValue,
  validateClientLaunchContract,
} from '../client-contract.mjs';
import {
  getJsoncValue,
  parseJsoncDocument,
  setJsoncValue,
  setJsoncValues,
} from '../jsonc-config.mjs';
import {
  adoptExactEntry,
  inspectOwnership,
  ownedPathsForClient,
  ownershipKey,
  recordOwnedWrite,
} from '../ownership-ledger.mjs';

const DEFAULT_LIMITS = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  aggregateBytes: 64 * 1024 * 1024,
  metadataBytes: 4 * 1024 * 1024,
  profileRecords: 256,
});
const ENTRY_PATH = Object.freeze(['servers', 'uemcp']);
const STATIC_ACTIONS = Object.freeze(['RESTART_REQUIRED', 'CLIENT_ENABLEMENT_REVIEW_REQUIRED']);
const LEDGER_FAILURES = new Set([
  'ledger_storage_invalid',
  'ledger_read_failed',
  'ledger_parse_failed',
  'ledger_schema_invalid',
  'ledger_self_hash_mismatch',
  'ledger_record_invalid',
]);
const PRIVATE_PROTOCOL_LAUNCH = new WeakMap();

export const VSCODE_NATIVE_MUTATION_CHARACTERIZATION = Object.freeze({
  version: '1.128.1',
  profile_can_create_missing: true,
  add_mcp_profile_writes_default: true,
  same_name_replaces_full_object: true,
  mutating_cli_allowed: false,
});

export class VsCodeAdapterError extends Error {
  constructor(message, code = 'VSCODE_ADAPTER_FAILED', details = {}) {
    super(message);
    this.name = 'VsCodeAdapterError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code = 'VSCODE_ADAPTER_FAILED', details = {}) {
  throw new VsCodeAdapterError(message, code, details);
}

function absolutePath(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && (isAbsolute(value) || win32.isAbsolute(value))
    && !/^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(value);
}

function plainObject(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function unique(values) {
  return [...new Set(values)];
}

function normalizedLimits(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (!Number.isSafeInteger(limits.fileBytes) || limits.fileBytes <= 0
    || !Number.isSafeInteger(limits.aggregateBytes) || limits.aggregateBytes < limits.fileBytes
    || !Number.isSafeInteger(limits.metadataBytes) || limits.metadataBytes <= 0 || limits.metadataBytes > limits.fileBytes
    || !Number.isSafeInteger(limits.profileRecords) || limits.profileRecords <= 0) {
    fail('VS Code inspection limits are invalid', 'INVALID_INSPECTION_LIMIT');
  }
  return Object.freeze(limits);
}

function location(path, allowedRoot, scope, writable = false) {
  return Object.freeze({
    path: resolve(path),
    allowed_root: resolve(allowedRoot),
    scope,
    writable,
  });
}

export function resolveVsCodeLocations(context = {}) {
  if (!absolutePath(context.workspaceRoot)) fail('VS Code inspection requires an absolute workspace root', 'INVALID_CLIENT_LOCATION');
  const env = context.env ?? process.env;
  const appData = readWindowsEnvironmentValue(env, 'APPDATA');
  const configuredRoot = context.vscodeUserDataRoot;
  if (configuredRoot !== undefined && configuredRoot !== null && configuredRoot !== '' && !absolutePath(configuredRoot)) {
    fail('VS Code user-data root must be an absolute non-device path', 'INVALID_CLIENT_LOCATION');
  }
  if (!configuredRoot && !absolutePath(appData)) fail('VS Code inspection requires an absolute APPDATA', 'INVALID_CLIENT_LOCATION');
  const userDataRoot = resolve(configuredRoot || join(appData, 'Code'));
  const userRoot = join(userDataRoot, 'User');
  const profilesRoot = join(userRoot, 'profiles');
  return Object.freeze({
    user_data_root: userDataRoot,
    user_root: resolve(userRoot),
    profiles_root: resolve(profilesRoot),
    default_user: location(join(userRoot, 'mcp.json'), userRoot, 'user:default', true),
    profile_metadata: location(join(userRoot, 'globalStorage', 'storage.json'), userRoot, 'profile_metadata'),
    workspace: location(join(context.workspaceRoot, '.vscode', 'mcp.json'), context.workspaceRoot, 'workspace'),
  });
}

export function physicalVsCodeEntry(descriptor) {
  if (!descriptor || descriptor.name !== 'uemcp' || descriptor.transport !== 'stdio'
    || !absolutePath(descriptor.command)
    || !Array.isArray(descriptor.args)
    || !descriptor.args.every(value => typeof value === 'string')) {
    fail('VS Code desired descriptor is invalid', 'INVALID_DESCRIPTOR');
  }
  return Object.freeze({
    type: 'stdio',
    command: resolve(descriptor.command),
    args: Object.freeze([...descriptor.args]),
  });
}

function strictMetadataDocument(bytes, { pathLabel, maxBytes }) {
  const document = parseJsoncDocument(bytes, { pathLabel, maxBytes, allowTrailingComma: false });
  let value;
  try {
    value = JSON.parse(document.text);
  } catch {
    fail('VS Code profile metadata must contain strict JSON', 'MALFORMED_CONFIG');
  }
  if (!plainObject(value)) fail('VS Code profile metadata must contain an object', 'MALFORMED_CONFIG');
  return Object.freeze({ ...document, parsed_value: value, strict_json: true });
}

async function readConfigFile(fsImpl, captureFingerprint, entry, tracker, limits, { metadata = false } = {}) {
  const maxBytes = metadata ? limits.metadataBytes : limits.fileBytes;
  return readBoundedConfigFile({
    fsImpl,
    captureFingerprint,
    entry,
    tracker,
    limits: { ...limits, fileBytes: maxBytes },
    parseBytes: bytes => metadata
      ? strictMetadataDocument(bytes, { pathLabel: 'VS Code profile metadata', maxBytes })
      : parseJsoncDocument(bytes, { pathLabel: `VS Code ${entry.scope}`, maxBytes }),
  });
}

function validateEntry(entry, label) {
  if (!plainObject(entry)) fail(`${label} must be an object`, 'MALFORMED_CONFIG');
  if (Object.hasOwn(entry, 'type') && typeof entry.type !== 'string') fail(`${label} type is invalid`, 'MALFORMED_CONFIG');
  if (Object.hasOwn(entry, 'command') && typeof entry.command !== 'string') fail(`${label} command is invalid`, 'MALFORMED_CONFIG');
  if (Object.hasOwn(entry, 'args') && (!Array.isArray(entry.args) || !entry.args.every(value => typeof value === 'string'))) {
    fail(`${label} args are invalid`, 'MALFORMED_CONFIG');
  }
  if (Object.hasOwn(entry, 'env') && (!plainObject(entry.env) || !Object.values(entry.env).every(value => typeof value === 'string'))) {
    fail(`${label} environment is invalid`, 'MALFORMED_CONFIG');
  }
  if (Object.hasOwn(entry, 'cwd') && entry.cwd !== null && typeof entry.cwd !== 'string') fail(`${label} cwd is invalid`, 'MALFORMED_CONFIG');
}

function validateConfig(file) {
  if (!file.exists) return;
  const root = file.document.parsed_value;
  if (!plainObject(root)) fail(`VS Code ${file.scope} config must be an object`, 'MALFORMED_CONFIG');
  if (root.servers !== undefined && !plainObject(root.servers)) fail(`VS Code ${file.scope} servers must be an object`, 'MALFORMED_CONFIG');
  for (const [name, entry] of Object.entries(root.servers ?? {})) validateEntry(entry, `VS Code ${file.scope} server ${name}`);
}

function physicalMatches(current, desired) {
  return plainObject(current)
    && current.type === desired.type
    && current.command === desired.command
    && Array.isArray(current.args)
    && JSON.stringify(current.args) === JSON.stringify(desired.args);
}

function environmentEvidence(entry) {
  if (!plainObject(entry?.env)) return Object.freeze({ keys: Object.freeze([]), value_hashes: Object.freeze({}) });
  const keys = Object.keys(entry.env).sort();
  return Object.freeze({
    keys: Object.freeze(keys),
    value_hashes: Object.freeze(Object.fromEntries(keys.map(key => [key, sha256Canonical(entry.env[key])]))),
  });
}

function reviewActions(entry) {
  const actions = [];
  const keys = Object.keys(plainObject(entry?.env) ? entry.env : {});
  if (keys.some(isSensitiveClientEnvironmentName)) actions.push('CUSTOM_ENV_REVIEW_REQUIRED');
  if (entry?.cwd !== undefined && entry.cwd !== null) actions.push('CUSTOM_LAUNCH_REVIEW_REQUIRED');
  return actions;
}

function physicalEvidence(entry) {
  if (!plainObject(entry)) return null;
  return Object.freeze({
    type: Object.hasOwn(entry, 'type') ? entry.type : null,
    command_sha256: Object.hasOwn(entry, 'command') ? sha256Canonical(entry.command) : null,
    args_count: Array.isArray(entry.args) ? entry.args.length : null,
    args_sha256: Object.hasOwn(entry, 'args') ? sha256Canonical(entry.args) : null,
  });
}

function safeOwnershipEvidence(value) {
  if (!value) return null;
  return Object.freeze({
    ownership_key: value.ownership_key,
    owned_paths: value.owned_paths,
    owned_diff: Object.freeze(value.owned_diff.map(diff => Object.freeze({
      path: diff.path,
      current_present: diff.current_present,
      desired_present: diff.desired_present,
      ...(diff.current_present ? { current_sha256: sha256Canonical(diff.current_value) } : {}),
      ...(diff.desired_present ? { desired_sha256: sha256Canonical(diff.desired_value) } : {}),
    }))),
    client_diff: value.client_diff,
    environment: value.environment,
    state: value.state,
    recommended_action: value.recommended_action,
    ...(value.stale_reason ? { stale_reason: value.stale_reason } : {}),
  });
}

function ownershipLedgerStatus(ownership) {
  if (ownership?.stale_reason && LEDGER_FAILURES.has(ownership.stale_reason)) {
    return Object.freeze({ status: 'INVALID', reason: ownership.stale_reason });
  }
  return Object.freeze({ status: 'VALID', reason: null });
}

async function occurrence(source, desired, {
  active = true,
  profileName = null,
  requestedContexts = [],
  ownership = false,
  ledger = null,
} = {}) {
  if (!source.exists) return null;
  const entry = getJsoncValue(source.document, ENTRY_PATH);
  if (entry === undefined) return null;
  validateEntry(entry, `VS Code ${source.scope} uemcp`);
  const owned = ownership ? await inspectOwnership({
    ledger,
    currentEntry: entry,
    desiredEntry: desired,
    location: { clientId: 'vscode', configPath: source.path, scope: source.scope, entryName: 'uemcp' },
  }) : null;
  const result = Object.freeze({
    scope: source.scope,
    path: source.path,
    allowed_root: source.allowed_root,
    active,
    profile_name: profileName,
    requested_contexts: Object.freeze([...requestedContexts]),
    matching: physicalMatches(entry, desired),
    physical_entry: physicalEvidence(entry),
    entry_sha256: sha256Canonical(entry),
    config_sha256: sha256Bytes(source.bytes),
    environment: environmentEvidence(entry),
    custom_launch: entry.cwd !== undefined && entry.cwd !== null,
    review_actions: Object.freeze(reviewActions(entry)),
    ownership: safeOwnershipEvidence(owned),
  });
  PRIVATE_PROTOCOL_LAUNCH.set(result, Object.freeze({
    env_overlay: Object.freeze({ ...(plainObject(entry.env) ? entry.env : {}) }),
    cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
  }));
  return result;
}

function publicFileEvidence(file) {
  return Object.freeze({
    path: file.path,
    allowed_root: file.allowed_root,
    scope: file.scope,
    writable: file.writable,
    exists: file.exists,
    config_sha256: file.exists && file.bytes ? sha256Bytes(file.bytes) : file.fingerprint?.content_sha256 ?? null,
    fingerprint: file.fingerprint,
  });
}

function statusFromError(error) {
  if (error?.code === 'INSPECTION_LIMIT_EXCEEDED') return 'INSPECTION_LIMIT_EXCEEDED';
  if (error?.code === 'MALFORMED_CONFIG' || error?.name === 'ConfigFormatError') return 'MALFORMED_CONFIG';
  if (['UNSAFE_CONFIG_PATH', 'UNSAFE_EVIDENCE_PATH', 'PATH_OUTSIDE_WRITABLE_ROOT'].includes(error?.code)) return 'UNSAFE_CONFIG_PATH';
  throw error;
}

function safeProfileLocation(value) {
  if (typeof value !== 'string' || value === '' || value !== value.trim()
    || value === '.' || value === '..'
    || /[<>:"/\\|?*\x00-\x1f]/.test(value)
    || /[. ]$/.test(value)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(value)
    || value.toLowerCase() === 'agents'
    || isAbsolute(value) || win32.isAbsolute(value)
    || /^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(value)) {
    fail('VS Code profile location is unsafe', 'UNSAFE_CONFIG_PATH');
  }
  return value;
}

function parseProfiles(metadata, locations, limits) {
  if (!metadata.exists) return Object.freeze([]);
  const root = metadata.document.parsed_value;
  const stored = root.userDataProfiles;
  if (stored === undefined) return Object.freeze([]);
  if (!Array.isArray(stored)) fail('VS Code userDataProfiles must be an array', 'MALFORMED_CONFIG');
  if (stored.length > limits.profileRecords) fail('VS Code profile record count exceeds its limit', 'INSPECTION_LIMIT_EXCEEDED');
  const names = new Set();
  const profileLocations = new Set();
  const rows = [];
  for (const record of stored) {
    if (!plainObject(record) || typeof record.name !== 'string' || record.name.trim() === '' || record.name !== record.name.trim()) {
      fail('VS Code profile record name is invalid', 'MALFORMED_CONFIG');
    }
    const profileLocation = safeProfileLocation(record.location);
    const nameKey = record.name.toLowerCase();
    const locationKey = profileLocation.toLowerCase();
    if (names.has(nameKey) || profileLocations.has(locationKey)) {
      fail('VS Code profile metadata is ambiguous', 'MALFORMED_CONFIG');
    }
    names.add(nameKey);
    profileLocations.add(locationKey);
    const flags = record.useDefaultFlags;
    if (flags !== undefined && (!plainObject(flags) || !Object.values(flags).every(value => typeof value === 'boolean'))) {
      fail('VS Code profile useDefaultFlags is invalid', 'MALFORMED_CONFIG');
    }
    const inheritedDefault = flags?.mcp === true;
    const profileRoot = join(locations.profiles_root, profileLocation);
    const resource = inheritedDefault
      ? locations.default_user
      : location(join(profileRoot, 'mcp.json'), locations.profiles_root, `user:profile:${profileLocation}`, true);
    rows.push(Object.freeze({
      name: record.name,
      location: profileLocation,
      inherited_default: inheritedDefault,
      resource,
    }));
  }
  return Object.freeze(rows);
}

function selectedProfileResource(context, locations, profiles) {
  const requested = context.vscodeProfile;
  if (requested === null || requested === undefined) {
    return Object.freeze({
      profile: null,
      resource: locations.default_user,
      inherited_default: false,
    });
  }
  if (typeof requested !== 'string' || requested.trim() === '' || requested !== requested.trim()) {
    fail('VS Code requested profile is invalid', 'VSCODE_PROFILE_NOT_FOUND');
  }
  const matches = profiles.filter(row => row.name === requested);
  if (matches.length !== 1) fail('VS Code requested profile was not found', 'VSCODE_PROFILE_NOT_FOUND');
  return Object.freeze({
    profile: matches[0],
    resource: matches[0].resource,
    inherited_default: matches[0].inherited_default,
  });
}

function pathIdentity(path) {
  return win32.normalize(resolve(path)).toLowerCase();
}

async function captureLaunchEvidence(captureFingerprint, context, detection) {
  const candidates = [
    ['client_launch_command', detection.launch.command],
    ...detection.launch.args_prefix.map((path, index) => [`client_launch_arg_${index}`, path]),
    ['server_launch_command', context.descriptor.command],
    ...context.descriptor.args.filter(absolutePath).map((path, index) => [`server_launch_arg_${index}`, path]),
  ];
  const seen = new Set();
  const rows = [];
  for (const [scope, path] of candidates) {
    const key = pathIdentity(path);
    if (seen.has(key)) continue;
    seen.add(key);
    const fingerprint = await captureFingerprint(path, { allowedRoots: [dirname(path)], writable: false });
    if (!fingerprint.exists || fingerprint.kind !== 'file' || fingerprint.link_kind !== 'none') {
      fail('VS Code launch evidence is no longer a regular file', 'CLIENT_LAUNCH_EVIDENCE_INVALID');
    }
    rows.push(Object.freeze({
      path: resolve(path),
      allowed_root: resolve(dirname(path)),
      scope,
      writable: false,
      exists: true,
      config_sha256: fingerprint.content_sha256,
      fingerprint,
    }));
  }
  return rows;
}

function readOnlyRows(files, writablePath = null) {
  const writableKey = writablePath ? pathIdentity(writablePath) : null;
  return files
    .filter(file => pathIdentity(file.path) !== writableKey)
    .map(file => ({ path: file.path, allowed_root: file.allowed_root, fingerprint: file.fingerprint }));
}

async function writableFileEvidence(captureFingerprint, file) {
  const fingerprint = await captureFingerprint(file.path, { allowedRoots: [file.allowed_root], writable: true });
  return { ...file, fingerprint };
}

function planningFailure(error) {
  if (['READ_ONLY_TARGET', 'UNSAFE_WRITABLE_PATH', 'PATH_OUTSIDE_WRITABLE_ROOT', 'METADATA_INSPECTION_FAILED'].includes(error?.code)) return error.code;
  throw error;
}

function missing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

async function readCurrentDocument(fsImpl, path, label) {
  try {
    const bytes = await fsImpl.readFile(path);
    return { bytes, document: parseJsoncDocument(bytes, { pathLabel: label }) };
  } catch (error) {
    if (!missing(error)) throw error;
    const bytes = Buffer.alloc(0);
    return { bytes, document: parseJsoncDocument(bytes, { pathLabel: label }) };
  }
}

function assertOperationPrecondition(operation, bytes, entry) {
  const configHash = bytes.length === 0 && operation.current_config_sha256 === null ? null : sha256Bytes(bytes);
  if (configHash !== operation.current_config_sha256) fail('VS Code config changed after planning', 'TRANSACTION_PRECONDITION_CHANGED');
  const entryHash = entry === undefined ? null : sha256Canonical(entry);
  if (entryHash !== operation.current_entry_sha256) fail('VS Code entry changed after planning', 'TRANSACTION_PRECONDITION_CHANGED');
}

function applyOwnedFields(document, desired, replaceWhole) {
  if (replaceWhole) return setJsoncValue(document, ENTRY_PATH, desired);
  return setJsoncValues(document, ['type', 'command', 'args'].map(key => ({
    path: [...ENTRY_PATH, key],
    value: desired[key],
  })));
}

export function createVsCodeAdapter({
  fsImpl = defaultFs,
  captureFingerprint = captureClientPathFingerprint,
  limits: limitOverrides = {},
} = {}) {
  const limits = normalizedLimits(limitOverrides);
  async function detect(context) {
    validateClientLaunchContract(context?.launch);
    if (context.launch.client_id !== 'vscode') fail('VS Code launch evidence is invalid', 'INVALID_CLIENT_LAUNCH');
    return Object.freeze({
      client_id: 'vscode',
      version: context.launch.version,
      compatibility: context.launch.compatibility,
      write_supported: context.launch.write_supported === true,
      launch: context.launch,
      locations: resolveVsCodeLocations(context),
    });
  }

  async function inspect(context, detection) {
    if (detection?.client_id !== 'vscode') fail('VS Code detection is invalid', 'INVALID_CLIENT_DETECTION');
    const desired = physicalVsCodeEntry(context.descriptor);
    try {
      const tracker = { total: 0 };
      const metadata = await readConfigFile(fsImpl, captureFingerprint, detection.locations.profile_metadata, tracker, limits, { metadata: true });
      const profiles = parseProfiles(metadata, detection.locations, limits);
      const selection = selectedProfileResource(context, detection.locations, profiles);
      const resourceLocations = new Map([[pathIdentity(detection.locations.default_user.path), detection.locations.default_user]]);
      const resourceContexts = new Map([[pathIdentity(detection.locations.default_user.path), ['default']]]);
      for (const profile of profiles) resourceLocations.set(pathIdentity(profile.resource.path), profile.resource);
      for (const profile of profiles) {
        const key = pathIdentity(profile.resource.path);
        const contexts = resourceContexts.get(key) ?? [];
        contexts.push(`profile:${profile.name}${profile.inherited_default ? ' (useDefaultFlags.mcp)' : ''}`);
        resourceContexts.set(key, contexts);
      }
      const resourceFiles = new Map();
      for (const [key, resource] of resourceLocations) {
        resourceFiles.set(key, await readConfigFile(fsImpl, captureFingerprint, resource, tracker, limits));
      }
      const selected = resourceFiles.get(pathIdentity(selection.resource.path));
      const workspace = await readConfigFile(fsImpl, captureFingerprint, detection.locations.workspace, tracker, limits);
      for (const file of resourceFiles.values()) validateConfig(file);
      validateConfig(workspace);
      const selectedOccurrence = await occurrence(selected, desired, {
        profileName: selection.profile?.name ?? null,
        requestedContexts: resourceContexts.get(pathIdentity(selection.resource.path)) ?? [],
        ownership: true,
        ledger: context.ownershipLedger,
      });
      const workspaceOccurrence = await occurrence(workspace, desired);
      const otherOccurrences = [];
      for (const [key, file] of resourceFiles) {
        if (key === pathIdentity(selection.resource.path)) continue;
        const profileNames = profiles.filter(profile => pathIdentity(profile.resource.path) === key).map(profile => profile.name);
        const row = await occurrence(file, desired, {
          active: false,
          profileName: profileNames[0] ?? null,
          requestedContexts: resourceContexts.get(key) ?? [],
        });
        if (row) otherOccurrences.push(row);
      }
      const occurrences = [selectedOccurrence, ...otherOccurrences, workspaceOccurrence].filter(Boolean);
      const effective = workspaceOccurrence ?? selectedOccurrence;
      const registration = effective ? (effective.matching ? 'CONFIGURED' : 'CONFLICT') : 'ABSENT';
      const actions = [
        ...STATIC_ACTIONS,
        ...occurrences.flatMap(row => row.review_actions),
        ...(otherOccurrences.length > 0 ? ['SHADOWED'] : []),
        ...(workspaceOccurrence ? [workspaceOccurrence.matching ? 'SHADOWED' : 'CONFLICT'] : []),
        ...(registration === 'CONFLICT' ? ['CONFLICT'] : []),
      ];
      let ownership = selectedOccurrence?.ownership ?? null;
      if (!ownership) {
        ownership = safeOwnershipEvidence(await inspectOwnership({
          ledger: context.ownershipLedger,
          currentEntry: desired,
          desiredEntry: desired,
          location: {
            clientId: 'vscode',
            configPath: selected.path,
            scope: selected.scope,
            entryName: 'uemcp',
          },
        }));
      }
      const launchEvidence = await captureLaunchEvidence(captureFingerprint, context, detection);
      return Object.freeze({
        client_id: 'vscode',
        registration,
        enablement: 'UNKNOWN',
        activation: 'UNKNOWN',
        actions: Object.freeze(unique(actions)),
        selected_resource: Object.freeze({
          scope: selected.scope,
          path: selected.path,
          allowed_root: selected.allowed_root,
          writable: true,
          inherited_default: selection.inherited_default,
          requested_profile: selection.profile?.name ?? null,
        }),
        effective: effective ? Object.freeze({ scope: effective.scope, path: effective.path, matching: effective.matching }) : null,
        occurrences: Object.freeze(occurrences),
        profiles: Object.freeze(profiles.map(profile => Object.freeze({
          name: profile.name,
          location: profile.location,
          inherited_default: profile.inherited_default,
          resource_path: profile.resource.path,
        }))),
        files: Object.freeze([
          ...[metadata, ...resourceFiles.values(), workspace].map(publicFileEvidence),
          ...launchEvidence,
        ]),
        ownership_ledger: ownershipLedgerStatus(ownership),
        desired,
      });
    } catch (error) {
      const status = statusFromError(error);
      return Object.freeze({
        client_id: 'vscode',
        registration: status,
        enablement: 'UNKNOWN',
        activation: 'UNKNOWN',
        actions: Object.freeze(unique([...STATIC_ACTIONS, status])),
        selected_resource: null,
        effective: null,
        occurrences: Object.freeze([]),
        profiles: Object.freeze([]),
        files: Object.freeze([]),
        ownership_ledger: Object.freeze({ status: 'UNKNOWN', reason: null }),
        desired,
      });
    }
  }

  async function plan(context, inspection, descriptor) {
    if (inspection?.client_id !== 'vscode') fail('VS Code inspection is invalid', 'INVALID_CLIENT_INSPECTION');
    if (typeof context.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(context.planDigest)) fail('VS Code plan digest is invalid', 'INVALID_PLAN_DIGEST');
    const desired = physicalVsCodeEntry(descriptor);
    if (['MALFORMED_CONFIG', 'INSPECTION_LIMIT_EXCEEDED', 'UNSAFE_CONFIG_PATH'].includes(inspection.registration)) {
      return Object.freeze({ client_id: 'vscode', status: inspection.registration, operations: Object.freeze([]), actions: inspection.actions });
    }
    if (!context.launch.write_supported) {
      return Object.freeze({ client_id: 'vscode', status: 'UNSUPPORTED_VERSION', operations: Object.freeze([]), actions: Object.freeze(['UNSUPPORTED_VERSION']) });
    }
    if (inspection.ownership_ledger?.status === 'INVALID') {
      return Object.freeze({
        client_id: 'vscode',
        status: 'OWNERSHIP_LEDGER_INVALID',
        operations: Object.freeze([]),
        actions: Object.freeze(unique([...inspection.actions, 'OWNERSHIP_LEDGER_INVALID'])),
      });
    }
    if (inspection.effective?.scope === 'workspace') {
      return Object.freeze({
        client_id: 'vscode',
        status: inspection.effective.matching ? 'NO_OP' : 'CONFLICT',
        operations: Object.freeze([]),
        actions: Object.freeze(unique([...inspection.actions, inspection.effective.matching ? 'SHADOWED' : 'CONFLICT'])),
      });
    }
    const current = inspection.occurrences.find(row => row.active === true && pathIdentity(row.path) === pathIdentity(inspection.selected_resource.path));
    if (current?.matching && current.ownership?.recommended_action === 'ADOPT_EXACT_ENTRY') {
      const source = inspection.files.find(file => pathIdentity(file.path) === pathIdentity(inspection.selected_resource.path));
      const operation = Object.freeze({
        operation_id: 'vscode-adopt-selected-uemcp',
        client_id: 'vscode',
        selected: true,
        write_supported: true,
        type: 'ADOPT_EXACT_ENTRY',
        path: source.path,
        allowed_root: source.allowed_root,
        scope_kind: inspection.selected_resource.scope.startsWith('user:profile:') ? 'profile' : 'user',
        ownership_scope: source.scope,
        fingerprint: source.fingerprint,
        current_config_sha256: current.config_sha256,
        current_entry_sha256: current.entry_sha256,
        owned_paths: Object.freeze(['/type', '/command', '/args']),
        shared_resource_id: null,
        plan_digest: context.planDigest,
        read_only_paths: Object.freeze(readOnlyRows(inspection.files)),
        desired_entry: desired,
        json_path: ENTRY_PATH,
        external_write: false,
        verification_status: 'RESTART_REQUIRED',
        ledger_only: true,
        adoption: Object.freeze({
          operation_id: 'vscode-adopt-selected-uemcp',
          type: 'ADOPT_EXACT_ENTRY',
          ownership_key: ownershipKey({ clientId: 'vscode', configPath: source.path, scope: source.scope, entryName: 'uemcp' }),
          current_entry_sha256: current.entry_sha256,
          current_config_sha256: current.config_sha256,
          plan_digest: context.planDigest,
        }),
      });
      return Object.freeze({ client_id: 'vscode', status: 'ADOPT', operations: Object.freeze([operation]), actions: inspection.actions });
    }
    if (current?.matching) {
      return Object.freeze({ client_id: 'vscode', status: 'NO_OP', operations: Object.freeze([]), actions: inspection.actions });
    }
    if (current && current.ownership?.state !== 'owned_matching' && context.approvedOwnedReplacement !== true) {
      return Object.freeze({ client_id: 'vscode', status: 'CONFLICT', operations: Object.freeze([]), actions: Object.freeze(unique([...inspection.actions, 'CONFLICT'])) });
    }
    let source = inspection.files.find(file => pathIdentity(file.path) === pathIdentity(inspection.selected_resource.path));
    try {
      source = await writableFileEvidence(captureFingerprint, source);
    } catch (error) {
      const status = planningFailure(error);
      return Object.freeze({ client_id: 'vscode', status, operations: Object.freeze([]), actions: Object.freeze(unique([...inspection.actions, status])) });
    }
    const operationType = current ? 'UPDATE_OWNED_FIELDS' : 'CREATE_ENTRY';
    const operation = Object.freeze({
      operation_id: current ? 'vscode-update-selected-uemcp' : 'vscode-create-selected-uemcp',
      client_id: 'vscode',
      selected: true,
      write_supported: true,
      type: operationType,
      path: source.path,
      allowed_root: source.allowed_root,
      scope_kind: inspection.selected_resource.scope.startsWith('user:profile:') ? 'profile' : 'user',
      ownership_scope: source.scope,
      fingerprint: source.fingerprint,
      current_config_sha256: source.config_sha256 ?? null,
      current_entry_sha256: current?.entry_sha256 ?? null,
      owned_paths: Object.freeze(['/type', '/command', '/args']),
      shared_resource_id: null,
      plan_digest: context.planDigest,
      read_only_paths: Object.freeze(readOnlyRows(inspection.files, source.path)),
      desired_entry: desired,
      json_path: ENTRY_PATH,
      external_write: false,
      verification_status: 'RESTART_REQUIRED',
      explicit_owned_replacement: current !== undefined && context.approvedOwnedReplacement === true,
    });
    return Object.freeze({ client_id: 'vscode', status: current ? 'UPDATE' : 'CREATE', operations: Object.freeze([operation]), actions: inspection.actions });
  }

  async function snapshot(context, operations) {
    const writable = [];
    const readOnly = new Map();
    for (const operation of operations) {
      if (operation.ledger_only !== true) {
        writable.push({
          path: operation.path,
          allowed_root: operation.allowed_root,
          scope_kind: operation.scope_kind,
          fingerprint: operation.fingerprint,
          owned_paths: operation.owned_paths,
          shared_resource_id: operation.shared_resource_id,
        });
      } else {
        readOnly.set(pathIdentity(operation.path), {
          path: operation.path,
          allowed_root: operation.allowed_root,
          fingerprint: operation.fingerprint,
        });
      }
      for (const row of operation.read_only_paths ?? []) {
        if (!writable.some(candidate => pathIdentity(candidate.path) === pathIdentity(row.path))) {
          readOnly.set(pathIdentity(row.path), row);
        }
      }
    }
    return Object.freeze({ writable_paths: writable, read_only_paths: [...readOnly.values()] });
  }

  async function apply(context, operations) {
    if (!context.transaction?.ownershipLedger) fail('VS Code apply requires the transaction ownership capability', 'INVALID_TRANSACTION_CAPABILITY');
    for (const operation of operations) {
      if (operation.client_id !== 'vscode' || operation.write_supported !== true || operation.selected !== true) {
        fail('VS Code apply received an unapproved operation', 'UNAPPROVED_OPERATION_SET');
      }
      const current = await readCurrentDocument(fsImpl, operation.path, 'VS Code selected config');
      const entry = getJsoncValue(current.document, ENTRY_PATH);
      assertOperationPrecondition(operation, current.bytes, entry);
      const ownershipLocation = {
        clientId: 'vscode',
        configPath: operation.path,
        scope: operation.ownership_scope,
        entryName: 'uemcp',
      };
      if (operation.type === 'ADOPT_EXACT_ENTRY') {
        await adoptExactEntry({
          ledger: context.transaction.ownershipLedger,
          location: ownershipLocation,
          currentEntry: entry,
          desiredEntry: operation.desired_entry,
          approvedOperationId: operation.adoption,
        });
        continue;
      }
      if (!context.transaction.writeFile || !['CREATE_ENTRY', 'UPDATE_OWNED_FIELDS'].includes(operation.type)) {
        fail('VS Code operation type is unsupported', 'UNAPPROVED_OPERATION_SET');
      }
      const edit = applyOwnedFields(current.document, operation.desired_entry, operation.type === 'CREATE_ENTRY');
      if (!edit.changed) fail('VS Code targeted edit produced no change', 'TRANSACTION_PRECONDITION_CHANGED');
      const parsed = parseJsoncDocument(edit.after_bytes, { pathLabel: 'VS Code updated selected config' });
      const afterEntry = getJsoncValue(parsed, ENTRY_PATH);
      if (!physicalMatches(afterEntry, operation.desired_entry)) fail('VS Code write did not produce the canonical owned projection', 'STRUCTURAL_VERIFY_FAILED');
      const written = await context.transaction.writeFile(operation.path, edit.after_bytes, {
        parse: bytes => parseJsoncDocument(bytes, { pathLabel: 'VS Code updated selected config' }),
      });
      await recordOwnedWrite({
        ledger: context.transaction.ownershipLedger,
        location: ownershipLocation,
        beforeEntry: entry ?? null,
        afterEntry,
        ownedPaths: ownedPathsForClient('vscode', afterEntry),
        appliedConfigHash: written.content_sha256,
        planDigest: operation.plan_digest,
      });
    }
    return Object.freeze({ status: operations.length === 0 ? 'NO_OP' : 'APPLIED' });
  }

  async function verify(context, operations) {
    for (const operation of operations) {
      const current = await readCurrentDocument(fsImpl, operation.path, 'VS Code verification config');
      const entry = getJsoncValue(current.document, ENTRY_PATH);
      if (!physicalMatches(entry, operation.desired_entry)) fail('VS Code selected entry does not match the canonical descriptor', 'STRUCTURAL_VERIFY_FAILED');
    }
    return Object.freeze({
      status: 'RESTART_REQUIRED',
      registration: 'CONFIGURED',
      enablement: 'UNKNOWN',
      activation: 'UNKNOWN',
      actions: STATIC_ACTIONS,
    });
  }

  async function rollback(context, records) {
    return Object.freeze({ status: 'delegated', count: records.length });
  }

  function protocolLaunch(context, inspection) {
    const effective = inspection?.effective;
    const occurrence = inspection?.occurrences?.find(row => row.scope === effective?.scope && row.path === effective?.path);
    return PRIVATE_PROTOCOL_LAUNCH.get(occurrence) ?? Object.freeze({ env_overlay: Object.freeze({}), cwd: null });
  }

  return Object.freeze({
    id: 'vscode',
    detect,
    inspect,
    plan,
    snapshot,
    apply,
    verify,
    protocolLaunch,
    rollback,
  });
}
