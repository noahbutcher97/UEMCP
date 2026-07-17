import * as defaultFs from 'node:fs/promises';
import {
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';

import { sha256Bytes, sha256Canonical } from '../canonical-json.mjs';
import { readBoundedConfigFile } from '../bounded-config-file.mjs';
import { approvedOwnedReplacement } from '../client-decisions.mjs';
import {
  adoptExactEntry,
  inspectOwnership,
  ownedPathsForClient,
  ownershipKey,
  recordOwnedWrite,
} from '../ownership-ledger.mjs';
import {
  clientProcessEnvironment,
  isSensitiveClientEnvironmentName,
  readWindowsEnvironmentValue,
  validateClientLaunchContract,
} from '../client-contract.mjs';
import { CONFIG_BYTE_LIMIT } from '../config-bytes.mjs';
import { getTomlTable, parseTomlDocument, patchTomlTable } from '../toml-config.mjs';

const DEFAULT_LIMITS = Object.freeze({
  fileBytes: CONFIG_BYTE_LIMIT,
  aggregateBytes: 64 * 1024 * 1024,
  projectLayers: 64,
});
const TABLE_PATH = Object.freeze(['mcp_servers', 'uemcp']);
const LEDGER_FAILURES = new Set([
  'ledger_storage_invalid',
  'ledger_read_failed',
  'ledger_parse_failed',
  'ledger_schema_invalid',
  'ledger_self_hash_mismatch',
  'ledger_record_invalid',
]);
const PRIVATE_PROTOCOL_LAUNCH = new WeakMap();

export const CODEX_NATIVE_MUTATION_CHARACTERIZATION = Object.freeze({
  version: '0.144.4',
  fresh_add_exit_code: 0,
  same_name_add_exit_code: 0,
  same_name_replaces_existing_table: true,
  native_add_existing_allowed: false,
  existing_file_add_preserved_exact_bytes: false,
  existing_file_add_normalized_crlf: true,
  isolated_home_files_after_fresh_add: Object.freeze(['config.toml']),
});

export class CodexAdapterError extends Error {
  constructor(message, code = 'CODEX_ADAPTER_FAILED', details = {}) {
    super(message);
    this.name = 'CodexAdapterError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code = 'CODEX_ADAPTER_FAILED', details = {}) {
  throw new CodexAdapterError(message, code, details);
}

function plainObject(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function absolutePath(value) {
  return typeof value === 'string'
    && value.trim() !== ''
    && (isAbsolute(value) || win32.isAbsolute(value))
    && !/^(?:\\\\[?.]\\|\\\\GLOBALROOT\\)/i.test(value);
}

function pathIdentity(path) {
  const normalized = win32.normalize(resolve(path));
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function contained(root, candidate) {
  const rel = relative(pathIdentity(root), pathIdentity(candidate));
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function location(path, allowedRoot, scope, writable = false, extras = {}) {
  return Object.freeze({
    path: resolve(path),
    allowed_root: resolve(allowedRoot),
    scope,
    writable,
    ...extras,
  });
}

export function resolveCodexLocations(context = {}, { projectLayers = DEFAULT_LIMITS.projectLayers } = {}) {
  const env = context.env ?? process.env;
  const userProfile = readWindowsEnvironmentValue(env, 'USERPROFILE');
  if (!absolutePath(userProfile)) fail('Codex inspection requires an absolute USERPROFILE', 'INVALID_CLIENT_LOCATION');
  const configuredHome = readWindowsEnvironmentValue(env, 'CODEX_HOME');
  if (configuredHome !== undefined && configuredHome !== '' && !absolutePath(configuredHome)) {
    fail('CODEX_HOME must be an absolute non-device path', 'INVALID_CLIENT_LOCATION');
  }
  const codexHome = resolve(configuredHome || join(userProfile, '.codex'));
  const projectRoot = context.projectRoot ?? context.workspaceRoot;
  const activeDirectory = context.activeDirectory ?? context.workspaceRoot;
  if (!absolutePath(projectRoot) || !absolutePath(activeDirectory) || !contained(projectRoot, activeDirectory)) {
    fail('Codex project scope is invalid', 'INVALID_CLIENT_LOCATION');
  }
  const root = resolve(projectRoot);
  const active = resolve(activeDirectory);
  const segments = relative(root, active).split(sep).filter(Boolean);
  const directories = [root];
  for (const segment of segments) directories.push(join(directories.at(-1), segment));
  if (!Number.isSafeInteger(projectLayers) || projectLayers <= 0) fail('Codex project layer limit is invalid', 'INVALID_INSPECTION_LIMIT');
  if (directories.length > projectLayers) fail('Codex project layer count exceeds its limit', 'INSPECTION_LIMIT_EXCEEDED');

  const knownProgramData = context.knownFolders?.programData ?? 'C:\\ProgramData';
  if (!absolutePath(knownProgramData)) fail('Codex requirements root is invalid', 'INVALID_CLIENT_LOCATION');
  const programData = resolve(knownProgramData);
  const requirementsRoot = join(programData, 'OpenAI', 'Codex');
  return Object.freeze({
    user: location(join(codexHome, 'config.toml'), codexHome, 'user', true),
    project_layers: Object.freeze(directories.map((directory, index) => location(
      join(directory, '.codex', 'config.toml'),
      root,
      `project:${index}`,
      false,
      { directory: resolve(directory), precedence: index },
    ))),
    system_requirements: location(join(requirementsRoot, 'requirements.toml'), requirementsRoot, 'system_requirements'),
  });
}

export function physicalCodexEntry(descriptor) {
  if (!descriptor || descriptor.name !== 'uemcp' || descriptor.transport !== 'stdio'
    || !absolutePath(descriptor.command)
    || !Array.isArray(descriptor.args)
    || !descriptor.args.every(value => typeof value === 'string')) {
    fail('Codex desired descriptor is invalid', 'INVALID_DESCRIPTOR');
  }
  return Object.freeze({
    command: resolve(descriptor.command),
    args: Object.freeze([...descriptor.args]),
  });
}

function outputHash(result) {
  return sha256Bytes(Buffer.from(`${result?.stdout ?? ''}\0${result?.stderr ?? ''}`, 'utf8'));
}

function nativeIdentity(row, desired) {
  const transport = row?.transport;
  if (!plainObject(transport)
    || transport.type !== 'stdio'
    || typeof transport.command !== 'string'
    || !Array.isArray(transport.args)
    || !transport.args.every(value => typeof value === 'string')) {
    return { status: 'UNKNOWN', evidence: null };
  }
  const evidence = Object.freeze({
    command_sha256: sha256Canonical(transport.command),
    args_count: transport.args.length,
    args_sha256: sha256Canonical(transport.args),
  });
  if (!desired) return { status: 'UNKNOWN', evidence };
  return {
    status: transport.command === desired.command && JSON.stringify(transport.args) === JSON.stringify(desired.args)
      ? 'MATCHING'
      : 'CONFLICT',
    evidence,
  };
}

function nativeEnablement(row) {
  const reason = typeof row?.disabled_reason === 'string' ? row.disabled_reason : '';
  if (row?.enabled === false && /(?:requirement|policy|not allowed|allowlist)/i.test(reason)) return 'POLICY_BLOCKED';
  if (row?.enabled === false) return 'DISABLED';
  if (row?.enabled === true) return 'ENABLED';
  return 'UNKNOWN';
}

export function classifyCodexNativeStatus(result, { desired = null, mode = 'get' } = {}) {
  const base = { exit_code: result?.exitCode ?? null, output_sha256: outputHash(result) };
  if (result?.status === 'timed_out') return Object.freeze({ ...base, status: 'TIMEOUT', identity: 'UNKNOWN', enablement: 'UNKNOWN' });
  if (result?.status !== 'exited') return Object.freeze({ ...base, status: 'UNKNOWN', identity: 'UNKNOWN', enablement: 'UNKNOWN' });
  if (result.exitCode !== 0) {
    const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    return Object.freeze({
      ...base,
      status: /(?:not found|no mcp server)/i.test(text) ? 'ABSENT' : 'FAILED',
      identity: 'UNKNOWN',
      enablement: 'UNKNOWN',
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? '').trim());
  } catch {
    return Object.freeze({ ...base, status: 'UNKNOWN', identity: 'UNKNOWN', enablement: 'UNKNOWN' });
  }
  let row;
  if (mode === 'list') {
    if (!Array.isArray(parsed)) return Object.freeze({ ...base, status: 'UNKNOWN', identity: 'UNKNOWN', enablement: 'UNKNOWN' });
    const matches = parsed.filter(candidate => plainObject(candidate) && candidate.name === 'uemcp');
    if (matches.length > 1) return Object.freeze({ ...base, status: 'AMBIGUOUS', identity: 'UNKNOWN', enablement: 'UNKNOWN' });
    [row] = matches;
  } else {
    row = plainObject(parsed) && parsed.name === 'uemcp' ? parsed : null;
  }
  if (!row) return Object.freeze({ ...base, status: 'ABSENT', identity: 'UNKNOWN', enablement: 'UNKNOWN' });
  const identity = nativeIdentity(row, desired);
  const disabledReason = typeof row.disabled_reason === 'string' && row.disabled_reason !== ''
    ? sha256Canonical(row.disabled_reason)
    : null;
  return Object.freeze({
    ...base,
    status: 'PRESENT',
    identity: identity.status,
    enablement: nativeEnablement(row),
    disabled_reason_sha256: disabledReason,
    physical_entry: identity.evidence,
  });
}

function mergeNativeStatus(list, get) {
  const queryEvidence = {
    list_status: list.status,
    get_status: get.status,
    list_identity: list.identity,
    get_identity: get.identity,
    list_enablement: list.enablement,
    get_enablement: get.enablement,
    list_output_sha256: list.output_sha256,
    get_output_sha256: get.output_sha256,
  };
  if (list.status === 'AMBIGUOUS' || get.status === 'AMBIGUOUS') {
    return Object.freeze({
      ...list,
      status: 'AMBIGUOUS',
      identity: 'UNKNOWN',
      enablement: 'UNKNOWN',
      physical_entry: null,
      ...queryEvidence,
    });
  }
  if ((list.status === 'PRESENT') !== (get.status === 'PRESENT')) {
    const selected = get.status === 'PRESENT' ? get : list;
    return Object.freeze({
      ...selected,
      status: 'INCONSISTENT',
      identity: 'UNKNOWN',
      enablement: 'UNKNOWN',
      physical_entry: null,
      ...queryEvidence,
    });
  }
  if (list.status === 'PRESENT' && get.status === 'PRESENT') {
    const identityConflict = list.identity !== 'UNKNOWN' && get.identity !== 'UNKNOWN' && list.identity !== get.identity;
    const enablementConflict = list.enablement !== 'UNKNOWN' && get.enablement !== 'UNKNOWN' && list.enablement !== get.enablement;
    if (identityConflict || enablementConflict) {
      return Object.freeze({
        ...get,
        status: 'INCONSISTENT',
        identity: 'UNKNOWN',
        enablement: 'UNKNOWN',
        physical_entry: null,
        ...queryEvidence,
      });
    }
    const selected = get.identity !== 'UNKNOWN' ? get : list;
    return Object.freeze({
      ...selected,
      identity: get.identity !== 'UNKNOWN' ? get.identity : list.identity,
      enablement: get.enablement !== 'UNKNOWN' ? get.enablement : list.enablement,
      ...queryEvidence,
    });
  }
  const selected = get.status === 'PRESENT'
    ? get
    : list.status === 'PRESENT'
      ? list
      : get.status === 'ABSENT' && list.status === 'ABSENT'
        ? get
        : get.status !== 'ABSENT'
          ? get
          : list;
  return Object.freeze({
    ...selected,
    ...queryEvidence,
  });
}

function environmentForLaunch(context, launch) {
  return clientProcessEnvironment(context.env ?? process.env, launch.env_overlay ?? {});
}

async function runNativeQuery(runner, context, detection, tail) {
  const valid = (tail.length === 3 && tail[0] === 'mcp' && tail[1] === 'list' && tail[2] === '--json')
    || (tail.length === 4 && tail[0] === 'mcp' && tail[1] === 'get' && tail[2] === 'uemcp' && tail[3] === '--json');
  if (!valid) fail('Codex native MCP query is not read-only', 'MUTATING_NATIVE_COMMAND');
  return runner.run(detection.launch.command, [...detection.launch.args_prefix, ...tail], {
    cwd: context.activeDirectory ?? context.workspaceRoot,
    env: environmentForLaunch(context, detection.launch),
    shell: false,
    timeoutMs: 10_000,
    outputLimitBytes: 64 * 1024,
  });
}

async function inspectNative(runner, context, detection, desired) {
  if (context.launch?.compatibility !== 'release_gated') {
    const unknown = classifyCodexNativeStatus(null, { desired });
    return mergeNativeStatus(unknown, unknown);
  }
  const safe = async tail => {
    await context.beforeActiveClientLaunch?.({ client_id: 'codex', kind: 'native' });
    try {
      return await runNativeQuery(runner, context, detection, tail);
    } catch (error) {
      if (error?.code === 'MUTATING_NATIVE_COMMAND') throw error;
      return { status: 'launch_failed', exitCode: null, stdout: '', stderr: '', errorCode: error?.code ?? 'PROCESS_LAUNCH_FAILED' };
    }
  };
  const listResult = await safe(['mcp', 'list', '--json']);
  const getResult = await safe(['mcp', 'get', 'uemcp', '--json']);
  return mergeNativeStatus(
    classifyCodexNativeStatus(listResult, { desired, mode: 'list' }),
    classifyCodexNativeStatus(getResult, { desired, mode: 'get' }),
  );
}

function normalizedLimits(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (!Number.isSafeInteger(limits.fileBytes) || limits.fileBytes <= 0
    || !Number.isSafeInteger(limits.aggregateBytes) || limits.aggregateBytes < limits.fileBytes
    || !Number.isSafeInteger(limits.projectLayers) || limits.projectLayers <= 0) {
    fail('Codex inspection limits are invalid', 'INVALID_INSPECTION_LIMIT');
  }
  return Object.freeze(limits);
}

function missing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

async function readConfigFile(fsImpl, captureFingerprint, entry, tracker, limits, { parse = true } = {}) {
  return readBoundedConfigFile({
    fsImpl,
    captureFingerprint,
    entry,
    tracker,
    limits,
    parse,
    parseBytes: bytes => parseTomlDocument(bytes, { pathLabel: `Codex ${entry.scope}`, maxBytes: limits.fileBytes }),
  });
}

function physicalMatches(current, desired) {
  return plainObject(current)
    && current.command === desired.command
    && Array.isArray(current.args)
    && JSON.stringify(current.args) === JSON.stringify(desired.args);
}

function environmentEvidence(entry) {
  if (!plainObject(entry?.env)) return { keys: [], value_hashes: {} };
  const keys = Object.keys(entry.env).sort();
  return {
    keys,
    value_hashes: Object.fromEntries(keys.map(key => [key, sha256Canonical(entry.env[key])])),
  };
}

function physicalEvidence(entry) {
  if (!plainObject(entry)) return null;
  return Object.freeze({
    ...(Object.hasOwn(entry, 'command') ? { command_sha256: sha256Canonical(entry.command) } : {}),
    ...(Object.hasOwn(entry, 'args') ? {
      args_count: Array.isArray(entry.args) ? entry.args.length : null,
      args_sha256: sha256Canonical(entry.args),
    } : {}),
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

function reviewActions(entry) {
  const actions = [];
  if (plainObject(entry?.env) && Object.keys(entry.env).some(isSensitiveClientEnvironmentName)) actions.push('CUSTOM_ENV_REVIEW_REQUIRED');
  if (entry?.cwd !== undefined && entry.cwd !== null) actions.push('CUSTOM_LAUNCH_REVIEW_REQUIRED');
  return actions;
}

function workspaceTrustFromUser(user, projectRoot) {
  if (!user.exists) return Object.freeze({ trusted: false, source: 'user_config', project_key: null });
  const projects = getTomlTable(user.document, ['projects']);
  if (projects === undefined) return Object.freeze({ trusted: false, source: 'user_config', project_key: null });
  if (!plainObject(projects)) fail('Codex projects trust table must be an object', 'MALFORMED_CONFIG');
  const wanted = pathIdentity(projectRoot);
  const matches = Object.keys(projects).filter(key => absolutePath(key) && pathIdentity(key) === wanted);
  if (matches.length > 1) fail('Codex projects trust table contains ambiguous path aliases', 'MALFORMED_CONFIG');
  const projectKey = matches[0] ?? null;
  if (projectKey === null) return Object.freeze({ trusted: false, source: 'user_config', project_key: null });
  const project = projects[projectKey];
  if (!plainObject(project) || !['trusted', 'untrusted'].includes(project.trust_level)) {
    fail('Codex project trust_level must be trusted or untrusted', 'MALFORMED_CONFIG');
  }
  return Object.freeze({ trusted: project.trust_level === 'trusted', source: 'user_config', project_key: projectKey });
}

async function makeOccurrence({ source, scope, desired, ledger, ownershipScope = null }) {
  if (!source.exists) return null;
  const entry = getTomlTable(source.document, TABLE_PATH);
  if (entry === undefined) return null;
  if (!plainObject(entry)) fail('Codex MCP entry must be a table', 'MALFORMED_CONFIG');
  if (Object.hasOwn(entry, 'enabled') && typeof entry.enabled !== 'boolean') fail('Codex enabled field must be boolean', 'MALFORMED_CONFIG');
  if (Object.hasOwn(entry, 'cwd') && entry.cwd !== null && (typeof entry.cwd !== 'string' || entry.cwd.trim() === '')) {
    fail('Codex cwd field must be a non-empty string or null', 'MALFORMED_CONFIG');
  }
  if (Object.hasOwn(entry, 'env') && (!plainObject(entry.env) || Object.values(entry.env).some(value => typeof value !== 'string'))) {
    fail('Codex environment field must contain string values', 'MALFORMED_CONFIG');
  }
  const ownership = ownershipScope
    ? await inspectOwnership({
      ledger,
      currentEntry: entry,
      desiredEntry: desired,
      location: { clientId: 'codex', configPath: source.path, scope: ownershipScope, entryName: 'uemcp' },
    })
    : null;
  const result = Object.freeze({
    scope,
    path: source.path,
    allowed_root: source.allowed_root,
    matching: physicalMatches(entry, desired),
    enabled: entry.enabled !== false,
    enabled_explicit: Object.hasOwn(entry, 'enabled'),
    physical_entry: physicalEvidence(entry),
    entry_sha256: sha256Canonical(entry),
    config_sha256: sha256Bytes(source.bytes),
    environment: Object.freeze(environmentEvidence(entry)),
    custom_launch: entry.cwd !== undefined && entry.cwd !== null,
    review_actions: Object.freeze(reviewActions(entry)),
    ownership: safeOwnershipEvidence(ownership),
  });
  PRIVATE_PROTOCOL_LAUNCH.set(result, Object.freeze({
    env_overlay: Object.freeze({ ...(plainObject(entry.env) ? entry.env : {}) }),
    cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
  }));
  return result;
}

function matchArgumentRule(rule, argument) {
  if (!plainObject(rule) || typeof rule.match !== 'string' || typeof rule.value !== 'string') return null;
  if (rule.match === 'exact') return argument === rule.value;
  if (rule.match === 'prefix') return argument.startsWith(rule.value);
  return null;
}

function matchRequirementsIdentity(identity, desired) {
  if (!plainObject(identity) || !Object.hasOwn(identity, 'command')) return null;
  if (typeof identity.command === 'string') return identity.command === desired.command;
  if (!plainObject(identity.command)
    || typeof identity.command.executable !== 'string'
    || !Array.isArray(identity.command.args)
    || identity.command.args.length !== desired.args.length) return null;
  if (identity.command.executable !== desired.command) return false;
  let unknown = false;
  for (let index = 0; index < desired.args.length; index += 1) {
    const matched = matchArgumentRule(identity.command.args[index], desired.args[index]);
    if (matched === false) return false;
    if (matched === null) unknown = true;
  }
  return unknown ? null : true;
}

function classifyRequirements(file, desired, policyKnown) {
  if (!file.exists) return policyKnown ? 'ALLOWED' : 'POLICY_UNKNOWN';
  const root = file.document.parsed_value;
  if (!Object.hasOwn(root, 'mcp_servers')) return policyKnown ? 'ALLOWED' : 'POLICY_UNKNOWN';
  if (!plainObject(root.mcp_servers)) fail('Codex requirements mcp_servers must be a table', 'MALFORMED_CONFIG');
  const rule = root.mcp_servers.uemcp;
  if (rule === undefined) return 'POLICY_BLOCKED';
  if (!plainObject(rule) || !plainObject(rule.identity)) fail('Codex requirements uemcp identity is invalid', 'MALFORMED_CONFIG');
  const matched = matchRequirementsIdentity(rule.identity, desired);
  if (matched === true) return policyKnown ? 'ALLOWED' : 'POLICY_UNKNOWN';
  if (matched === false) return 'POLICY_BLOCKED';
  return 'POLICY_UNKNOWN';
}

function statusFromError(error) {
  if (error?.code === 'INSPECTION_LIMIT_EXCEEDED') return 'INSPECTION_LIMIT_EXCEEDED';
  if (error?.code === 'MALFORMED_CONFIG' || error?.name === 'ConfigFormatError') return 'MALFORMED_CONFIG';
  if (error?.code === 'UNSAFE_CONFIG_PATH') return 'UNSAFE_CONFIG_PATH';
  throw error;
}

function unique(values) {
  return [...new Set(values)];
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
      fail('Codex launch evidence is no longer a regular file', 'CLIENT_LAUNCH_EVIDENCE_INVALID');
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

function operationCommon({ id, type, current, source, context, readOnly, desired }) {
  return {
    operation_id: id,
    client_id: 'codex',
    selected: true,
    write_supported: true,
    type,
    path: source.path,
    allowed_root: source.allowed_root,
    scope_kind: 'user',
    fingerprint: source.fingerprint,
    current_config_sha256: source.config_sha256 ?? null,
    current_entry_sha256: current?.entry_sha256 ?? null,
    owned_paths: ['/command', '/args'],
    shared_resource_id: null,
    plan_digest: context.planDigest,
    read_only_paths: readOnly,
    desired_entry: desired,
    toml_path: TABLE_PATH,
  };
}

async function readCurrentDocument(fsImpl, path, label) {
  try {
    const bytes = await fsImpl.readFile(path);
    return { bytes, document: parseTomlDocument(bytes, { pathLabel: label }) };
  } catch (error) {
    if (!missing(error)) throw error;
    const bytes = Buffer.alloc(0);
    return { bytes, document: parseTomlDocument(bytes, { pathLabel: label }) };
  }
}

function assertOperationPrecondition(operation, bytes, entry) {
  const configHash = bytes.length === 0 && operation.current_config_sha256 === null ? null : sha256Bytes(bytes);
  if (configHash !== operation.current_config_sha256) fail('Codex config changed after planning', 'TRANSACTION_PRECONDITION_CHANGED');
  const entryHash = entry === undefined ? null : sha256Canonical(entry);
  if (entryHash !== operation.current_entry_sha256) fail('Codex entry changed after planning', 'TRANSACTION_PRECONDITION_CHANGED');
}

function ownershipLedgerStatus(ownership) {
  if (ownership?.stale_reason && LEDGER_FAILURES.has(ownership.stale_reason)) return Object.freeze({ status: 'INVALID', reason: ownership.stale_reason });
  return Object.freeze({ status: 'VALID', reason: null });
}

export function createCodexAdapter({
  fsImpl = defaultFs,
  runner,
  captureFingerprint,
  limits: limitOverrides = {},
} = {}) {
  if (!runner?.run || typeof captureFingerprint !== 'function') fail('Codex adapter dependencies are invalid', 'INVALID_ADAPTER_DEPENDENCY');
  const limits = normalizedLimits(limitOverrides);

  async function detect(context) {
    validateClientLaunchContract(context.launch);
    if (context.launch.client_id !== 'codex') fail('Codex launch evidence is invalid', 'INVALID_CLIENT_LAUNCH');
    return Object.freeze({
      client_id: 'codex',
      launch: context.launch,
      locations: resolveCodexLocations(context, { projectLayers: limits.projectLayers }),
    });
  }

  async function inspect(context, detection) {
    const desired = physicalCodexEntry(context.descriptor);
    try {
      const tracker = { total: 0 };
      const user = await readConfigFile(fsImpl, captureFingerprint, detection.locations.user, tracker, limits);
      const workspaceTrust = workspaceTrustFromUser(user, context.projectRoot ?? context.workspaceRoot);
      const projectFiles = [];
      for (const layer of detection.locations.project_layers) {
        projectFiles.push(await readConfigFile(fsImpl, captureFingerprint, layer, tracker, limits, {
          parse: workspaceTrust.trusted,
        }));
      }
      const requirements = await readConfigFile(fsImpl, captureFingerprint, detection.locations.system_requirements, tracker, limits);
      const launchEvidence = await captureLaunchEvidence(captureFingerprint, context, detection);
      const native = await inspectNative(runner, context, detection, desired);

      const occurrences = [];
      const userOccurrence = await makeOccurrence({
        source: user,
        scope: 'user',
        desired,
        ledger: context.ownershipLedger,
        ownershipScope: 'user',
      });
      if (userOccurrence) occurrences.push(userOccurrence);
      if (workspaceTrust.trusted) {
        for (const project of projectFiles) {
          const row = await makeOccurrence({ source: project, scope: project.scope, desired, ledger: context.ownershipLedger });
          if (row) occurrences.push(row);
        }
      }
      const ignoredProjectLayers = workspaceTrust.trusted
        ? []
        : projectFiles.filter(file => file.exists).map(file => Object.freeze({ path: file.path, scope: file.scope, reason: 'UNTRUSTED_PROJECT' }));
      const effective = occurrences.at(-1) ?? null;
      let policy = classifyRequirements(requirements, desired, false);
      if (native.enablement === 'POLICY_BLOCKED') policy = 'POLICY_BLOCKED';
      let registration = effective ? (effective.matching ? 'CONFIGURED' : 'CONFLICT') : 'ABSENT';
      const nativeProvesAbsence = native.list_status === 'ABSENT' && native.get_status === 'ABSENT';
      const nativeOnly = !effective && native.status === 'PRESENT' && native.identity === 'MATCHING';
      const nativeWriteBlocked = !effective && !nativeProvesAbsence;
      if (!effective && native.status === 'PRESENT') registration = native.identity === 'MATCHING' ? 'CONFIGURED' : 'CONFLICT';
      if (effective?.matching && policy === 'POLICY_BLOCKED') registration = 'POLICY_BLOCKED';
      let enablement = effective ? (effective.enabled ? 'ENABLED' : 'DISABLED') : nativeOnly ? native.enablement : 'UNKNOWN';
      if (policy === 'POLICY_BLOCKED') enablement = 'POLICY_BLOCKED';
      const disagrees = (effective?.matching && native.identity === 'CONFLICT')
        || (effective && ['ABSENT', 'AMBIGUOUS', 'INCONSISTENT'].includes(native.status));
      const actions = occurrences.flatMap(row => row.review_actions);
      if (enablement === 'DISABLED' || enablement === 'POLICY_BLOCKED') actions.push('CLIENT_ENABLEMENT_REQUIRED');
      if (policy === 'POLICY_UNKNOWN') actions.push('POLICY_UNKNOWN');
      if (nativeWriteBlocked && !nativeOnly) actions.push('POLICY_UNKNOWN');
      if (registration === 'CONFLICT') actions.push('CONFLICT');
      if (disagrees) actions.push('CONFLICT');

      let ownershipProbe = userOccurrence?.ownership ?? null;
      if (!ownershipProbe) {
        ownershipProbe = safeOwnershipEvidence(await inspectOwnership({
          ledger: context.ownershipLedger,
          currentEntry: desired,
          desiredEntry: desired,
          location: { clientId: 'codex', configPath: user.path, scope: 'user', entryName: 'uemcp' },
        }));
      }
      const sourceFiles = [user, ...projectFiles, requirements];
      return Object.freeze({
        client_id: 'codex',
        registration,
        enablement,
        activation: 'UNKNOWN',
        policy,
        actions: Object.freeze(unique(actions)),
        occurrences: Object.freeze(occurrences),
        ignored_project_layers: Object.freeze(ignoredProjectLayers),
        effective: effective ? Object.freeze({
          scope: effective.scope,
          path: effective.path,
          matching: effective.matching,
          enabled: effective.enabled,
        }) : null,
        native: Object.freeze({ ...native, disagrees_with_config: disagrees }),
        workspace_trust: workspaceTrust,
        native_only: nativeOnly,
        native_write_blocked: nativeWriteBlocked,
        files: Object.freeze([...sourceFiles.map(publicFileEvidence), ...launchEvidence]),
        ownership_ledger: ownershipLedgerStatus(ownershipProbe),
        desired,
      });
    } catch (error) {
      const status = statusFromError(error);
      return Object.freeze({
        client_id: 'codex',
        registration: status,
        enablement: 'UNKNOWN',
        activation: 'UNKNOWN',
        policy: 'POLICY_UNKNOWN',
        actions: Object.freeze([status]),
        occurrences: Object.freeze([]),
        ignored_project_layers: Object.freeze([]),
        effective: null,
        native: Object.freeze({ status: 'NOT_CHECKED', identity: 'UNKNOWN', enablement: 'UNKNOWN', disagrees_with_config: false }),
        workspace_trust: Object.freeze({ trusted: false, source: 'unknown', project_key: null }),
        native_only: false,
        native_write_blocked: true,
        files: Object.freeze([]),
        ownership_ledger: Object.freeze({ status: 'UNKNOWN', reason: null }),
        desired,
      });
    }
  }

  async function plan(context, inspection, descriptor) {
    if (inspection?.client_id !== 'codex') fail('Codex inspection is invalid', 'INVALID_CLIENT_INSPECTION');
    if (typeof context.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(context.planDigest)) fail('Codex plan digest is invalid', 'INVALID_PLAN_DIGEST');
    const desired = physicalCodexEntry(descriptor);
    if (['MALFORMED_CONFIG', 'INSPECTION_LIMIT_EXCEEDED', 'UNSAFE_CONFIG_PATH'].includes(inspection.registration)) {
      return Object.freeze({ client_id: 'codex', status: inspection.registration, operations: Object.freeze([]), actions: inspection.actions });
    }
    if (!context.launch.write_supported) {
      return Object.freeze({ client_id: 'codex', status: 'UNSUPPORTED_VERSION', operations: Object.freeze([]), actions: Object.freeze(['UNSUPPORTED_VERSION']) });
    }
    if (inspection.policy === 'POLICY_BLOCKED') {
      return Object.freeze({ client_id: 'codex', status: 'POLICY_BLOCKED', operations: Object.freeze([]), actions: inspection.actions });
    }
    if (inspection.ownership_ledger?.status === 'INVALID') {
      return Object.freeze({ client_id: 'codex', status: 'OWNERSHIP_LEDGER_INVALID', operations: Object.freeze([]), actions: Object.freeze(unique([...inspection.actions, 'OWNERSHIP_LEDGER_INVALID'])) });
    }
    if (inspection.native_write_blocked === true) {
      const status = inspection.native_only === true && inspection.registration === 'CONFIGURED'
        ? 'NO_OP'
        : inspection.registration === 'CONFLICT'
          ? 'CONFLICT'
          : 'POLICY_UNKNOWN';
      return Object.freeze({ client_id: 'codex', status, operations: Object.freeze([]), actions: inspection.actions });
    }

    const projectEffective = inspection.effective?.scope?.startsWith('project:');
    if (projectEffective) {
      return Object.freeze({
        client_id: 'codex',
        status: inspection.effective.matching ? 'NO_OP' : 'CONFLICT',
        operations: Object.freeze([]),
        actions: Object.freeze(unique([...inspection.actions, inspection.effective.matching ? 'SHADOWED' : 'CONFLICT'])),
      });
    }

    const files = Object.fromEntries(inspection.files.map(file => [file.scope, file]));
    const userFile = files.user;
    const user = inspection.occurrences.find(row => row.scope === 'user');
    let type;
    if (!user) type = 'CREATE_ENTRY';
    else if (user.matching && user.ownership?.recommended_action === 'ADOPT_EXACT_ENTRY') type = 'ADOPT_EXACT_ENTRY';
    else if (user.matching) return Object.freeze({ client_id: 'codex', status: 'NO_OP', operations: Object.freeze([]), actions: inspection.actions });
    else if (user.ownership?.state === 'owned_matching' || approvedOwnedReplacement(context, user.ownership)) type = 'UPDATE_OWNED_FIELDS';
    else return Object.freeze({ client_id: 'codex', status: 'CONFLICT', operations: Object.freeze([]), actions: Object.freeze(unique([...inspection.actions, 'CONFLICT'])) });

    const requiresProviderWrite = type !== 'ADOPT_EXACT_ENTRY';
    let source = userFile;
    try {
      if (requiresProviderWrite) source = await writableFileEvidence(captureFingerprint, userFile);
    } catch (error) {
      const status = planningFailure(error);
      return Object.freeze({ client_id: 'codex', status, operations: Object.freeze([]), actions: Object.freeze(unique([...inspection.actions, status])) });
    }
    const readOnly = readOnlyRows(inspection.files, requiresProviderWrite ? source.path : null);
    const common = operationCommon({
      id: type === 'CREATE_ENTRY' ? 'codex-create-user-uemcp' : type === 'ADOPT_EXACT_ENTRY' ? 'codex-adopt-user-uemcp' : 'codex-update-user-uemcp',
      type,
      current: user,
      source,
      context,
      readOnly,
      desired,
    });
    let operation;
    if (type === 'CREATE_ENTRY') {
      operation = Object.freeze({
        ...common,
        external_write: source.exists !== true,
        verification_status: inspection.policy === 'POLICY_UNKNOWN' ? 'POLICY_UNKNOWN' : null,
        requires_restart: true,
      });
    } else if (type === 'ADOPT_EXACT_ENTRY') {
      operation = Object.freeze({
        ...common,
        ledger_only: true,
        external_write: false,
        adoption: Object.freeze({
          operation_id: common.operation_id,
          type: 'ADOPT_EXACT_ENTRY',
          ownership_key: ownershipKey({ clientId: 'codex', configPath: source.path, scope: 'user', entryName: 'uemcp' }),
          current_entry_sha256: user.entry_sha256,
          current_config_sha256: user.config_sha256,
          plan_digest: context.planDigest,
        }),
        requires_restart: false,
      });
    } else {
      operation = Object.freeze({
        ...common,
        external_write: false,
        explicit_owned_replacement: approvedOwnedReplacement(context, user.ownership),
        requires_restart: true,
      });
    }
    const status = type === 'CREATE_ENTRY' ? 'CREATE' : type === 'ADOPT_EXACT_ENTRY' ? 'ADOPT' : 'UPDATE';
    return Object.freeze({ client_id: 'codex', status, operations: Object.freeze([operation]), actions: inspection.actions });
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
        if (!writable.some(candidate => pathIdentity(candidate.path) === pathIdentity(row.path))) readOnly.set(pathIdentity(row.path), row);
      }
    }
    return Object.freeze({ writable_paths: writable, read_only_paths: [...readOnly.values()] });
  }

  async function runNativeAdd(context, operation, stagedHome) {
    if (context.launch.version !== CODEX_NATIVE_MUTATION_CHARACTERIZATION.version || operation.external_write !== true) {
      fail('Codex native add is outside its release-gated contract', 'UNSUPPORTED_NATIVE_MUTATION');
    }
    if (!absolutePath(stagedHome) || pathIdentity(stagedHome) === pathIdentity(operation.allowed_root)) {
      fail('Codex native add requires an isolated home', 'UNAPPROVED_EXTERNAL_WRITE');
    }
    await context.beforeActiveClientLaunch?.({ client_id: 'codex', kind: 'native' });
    const result = await runner.run(context.launch.command, [
      ...context.launch.args_prefix,
      'mcp',
      'add',
      'uemcp',
      '--',
      operation.desired_entry.command,
      ...operation.desired_entry.args,
    ], {
      cwd: stagedHome,
      env: { ...environmentForLaunch(context, context.launch), CODEX_HOME: stagedHome },
      shell: false,
      timeoutMs: 10_000,
      outputLimitBytes: 64 * 1024,
    });
    if (result?.status !== 'exited' || result.exitCode !== 0) fail('Codex native add failed', 'NATIVE_WRITE_FAILED', { output_sha256: outputHash(result) });
    return Object.freeze({ status: 'ADDED', output_sha256: outputHash(result) });
  }

  async function apply(context, operations) {
    if (!context.transaction?.writeFile || !context.transaction?.ownershipLedger) fail('Codex apply requires the transaction capability', 'INVALID_TRANSACTION_CAPABILITY');
    for (const operation of operations) {
      if (operation.client_id !== 'codex' || operation.write_supported !== true || operation.selected !== true) {
        fail('Codex apply received an unapproved operation', 'UNAPPROVED_OPERATION_SET');
      }
      const current = await readCurrentDocument(fsImpl, operation.path, 'Codex user config');
      const entry = getTomlTable(current.document, TABLE_PATH);
      assertOperationPrecondition(operation, current.bytes, entry);
      if (operation.type === 'ADOPT_EXACT_ENTRY') {
        await adoptExactEntry({
          ledger: context.transaction.ownershipLedger,
          location: { clientId: 'codex', configPath: operation.path, scope: 'user', entryName: 'uemcp' },
          currentEntry: entry,
          desiredEntry: operation.desired_entry,
          approvedOperationId: operation.adoption,
        });
        continue;
      }
      if (!['CREATE_ENTRY', 'UPDATE_OWNED_FIELDS'].includes(operation.type)) fail('Codex operation type is unsupported', 'UNAPPROVED_OPERATION_SET');

      let written;
      let afterEntry;
      if (operation.external_write === true) {
        if (operation.type !== 'CREATE_ENTRY' || typeof context.transaction.runStagedWrite !== 'function' || entry !== undefined) {
          fail('Codex native create requires a staged transaction capability', 'INVALID_TRANSACTION_CAPABILITY');
        }
        written = await context.transaction.runStagedWrite(operation.path, async (target, stage) => {
          const expectedTarget = resolve(stage.root, stage.relative_path);
          if (pathIdentity(target) !== pathIdentity(expectedTarget) || pathIdentity(target) === pathIdentity(operation.path)) {
            fail('Codex native stage target changed', 'UNAPPROVED_EXTERNAL_WRITE');
          }
          await runNativeAdd(context, operation, stage.root);
        }, {
          seed_bytes: current.bytes,
          stage_relative_path: 'config.toml',
          parse: bytes => parseTomlDocument(bytes, { pathLabel: 'Codex native-created user config' }),
        });
        const after = await readCurrentDocument(fsImpl, operation.path, 'Codex native-created user config');
        afterEntry = getTomlTable(after.document, TABLE_PATH);
      } else {
        const edit = patchTomlTable(current.document, TABLE_PATH, operation.desired_entry);
        if (!edit.changed) fail('Codex targeted edit produced no change', 'TRANSACTION_PRECONDITION_CHANGED');
        const parsed = parseTomlDocument(edit.after_bytes, { pathLabel: 'Codex updated user config' });
        afterEntry = getTomlTable(parsed, TABLE_PATH);
        written = await context.transaction.writeFile(operation.path, edit.after_bytes, {
          parse: bytes => parseTomlDocument(bytes, { pathLabel: 'Codex updated user config' }),
        });
      }
      if (!physicalMatches(afterEntry, operation.desired_entry)) fail('Codex write did not produce the canonical owned projection', 'STRUCTURAL_VERIFY_FAILED');
      await recordOwnedWrite({
        ledger: context.transaction.ownershipLedger,
        location: { clientId: 'codex', configPath: operation.path, scope: 'user', entryName: 'uemcp' },
        beforeEntry: entry ?? null,
        afterEntry,
        ownedPaths: ownedPathsForClient('codex', afterEntry),
        appliedConfigHash: written.content_sha256,
        planDigest: operation.plan_digest,
      });
    }
    return Object.freeze({ status: operations.length === 0 ? 'NO_OP' : 'APPLIED' });
  }

  async function verify(context, operations) {
    let disabled = false;
    let structuralChange = false;
    for (const operation of operations) {
      const current = await readCurrentDocument(fsImpl, operation.path, 'Codex verification config');
      const entry = getTomlTable(current.document, TABLE_PATH);
      if (!physicalMatches(entry, operation.desired_entry)) fail('Codex user entry does not match the canonical descriptor', 'STRUCTURAL_VERIFY_FAILED');
      if (entry.enabled === false) disabled = true;
      if (operation.requires_restart === true) structuralChange = true;
    }
    const detection = await detect(context);
    const native = await inspectNative(runner, context, detection, physicalCodexEntry(context.descriptor));
    if (disabled || native.enablement === 'DISABLED' || native.enablement === 'POLICY_BLOCKED') {
      return Object.freeze({ status: 'CLIENT_ENABLEMENT_REQUIRED', restart_required: structuralChange, native });
    }
    if (structuralChange) return Object.freeze({ status: 'RESTART_REQUIRED', restart_required: true, native });
    const operationStatus = operations.find(row => row.verification_status)?.verification_status ?? null;
    if (operationStatus) return Object.freeze({ status: operationStatus, restart_required: false, native });
    if (native.status !== 'PRESENT' || native.identity === 'CONFLICT') return Object.freeze({ status: 'POLICY_UNKNOWN', restart_required: false, native });
    return Object.freeze({ status: 'READY', restart_required: false, native });
  }

  function protocolLaunch(context, inspection) {
    const effective = inspection?.occurrences?.find(row => row.scope === inspection.effective?.scope
      && row.path === inspection.effective?.path);
    return PRIVATE_PROTOCOL_LAUNCH.get(effective) ?? Object.freeze({ env_overlay: Object.freeze({}), cwd: null });
  }

  async function rollback(context, records) {
    return Object.freeze({ status: 'delegated', count: records.length });
  }

  return Object.freeze({ id: 'codex', detect, inspect, plan, snapshot, apply, verify, protocolLaunch, rollback });
}
