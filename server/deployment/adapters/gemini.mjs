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
import { captureClientPathFingerprint } from '../client-transaction.mjs';
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
import { createProcessRunner } from '../process-runner.mjs';
import {
  readWindowsEnvironmentValue,
  validateClientLaunchContract,
} from '../client-contract.mjs';

const DEFAULT_LIMITS = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  aggregateBytes: 64 * 1024 * 1024,
  extensionRecords: 512,
  extensionRuleBytes: 32 * 1024,
});
const ENTRY_PATH = Object.freeze(['mcpServers', 'uemcp']);
const LEDGER_FAILURES = new Set([
  'ledger_storage_invalid',
  'ledger_read_failed',
  'ledger_parse_failed',
  'ledger_schema_invalid',
  'ledger_self_hash_mismatch',
  'ledger_record_invalid',
]);
const SENSITIVE_ENVIRONMENT_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PATHEXT',
  'COMSPEC',
  'HOME',
  'USERPROFILE',
  'APPDATA',
  'LOCALAPPDATA',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
  'GEMINI_CLI_HOME',
]);

export const GEMINI_NATIVE_MUTATION_CHARACTERIZATION = Object.freeze({
  version: '0.41.2',
  default_scope: 'project',
  first_add_exit_code: 0,
  same_name_add_exit_code: 0,
  same_name_replaced: true,
  unrelated_settings_preserved: false,
  comments_preserved: true,
  crlf_preserved: false,
  mutating_subcommands_allowed: false,
});

export class GeminiAdapterError extends Error {
  constructor(message, code = 'GEMINI_ADAPTER_FAILED', details = {}) {
    super(message);
    this.name = 'GeminiAdapterError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code = 'GEMINI_ADAPTER_FAILED', details = {}) {
  throw new GeminiAdapterError(message, code, details);
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

function location(path, allowedRoot, scope, writable = false) {
  return Object.freeze({
    path: resolve(path),
    allowed_root: resolve(allowedRoot),
    scope,
    writable,
  });
}

export function resolveGeminiLocations(context = {}) {
  const env = context.env ?? process.env;
  const workspaceRoot = context.workspaceRoot;
  if (!absolutePath(workspaceRoot)) fail('Gemini inspection requires an absolute workspace root', 'INVALID_CLIENT_LOCATION');
  const userProfile = readWindowsEnvironmentValue(env, 'USERPROFILE');
  if (!absolutePath(userProfile)) fail('Gemini inspection requires an absolute USERPROFILE', 'INVALID_CLIENT_LOCATION');
  const configuredHome = readWindowsEnvironmentValue(env, 'GEMINI_CLI_HOME');
  if (configuredHome !== undefined && configuredHome !== '' && !absolutePath(configuredHome)) {
    fail('GEMINI_CLI_HOME must be an absolute non-device path', 'INVALID_CLIENT_LOCATION');
  }
  const homeRoot = resolve(configuredHome || userProfile);
  const globalDir = join(homeRoot, '.gemini');
  const extensionsRoot = join(globalDir, 'extensions');
  const knownProgramData = context.knownFolders?.programData ?? 'C:\\ProgramData';
  if (!absolutePath(knownProgramData)) fail('Gemini system policy root is invalid', 'INVALID_CLIENT_LOCATION');
  const systemRoot = join(resolve(knownProgramData), 'gemini-cli');
  return Object.freeze({
    home_root: resolve(homeRoot),
    global_dir: resolve(globalDir),
    custom_home: configuredHome !== undefined && configuredHome !== '',
    user: location(join(globalDir, 'settings.json'), globalDir, 'user', true),
    enablement: location(join(globalDir, 'mcp-server-enablement.json'), globalDir, 'enablement'),
    extensions_root: location(extensionsRoot, globalDir, 'extensions_root'),
    extensions_enablement: location(join(extensionsRoot, 'extension-enablement.json'), extensionsRoot, 'extensions_enablement'),
    project: location(join(workspaceRoot, '.gemini', 'settings.json'), workspaceRoot, 'project'),
    system_defaults: location(join(systemRoot, 'system-defaults.json'), systemRoot, 'system_defaults'),
    system_override: location(join(systemRoot, 'settings.json'), systemRoot, 'system_override'),
  });
}

export function physicalGeminiEntry(descriptor) {
  if (!descriptor || descriptor.name !== 'uemcp' || descriptor.transport !== 'stdio'
    || !absolutePath(descriptor.command)
    || !Array.isArray(descriptor.args)
    || !descriptor.args.every(value => typeof value === 'string')) {
    fail('Gemini desired descriptor is invalid', 'INVALID_DESCRIPTOR');
  }
  return Object.freeze({
    command: resolve(descriptor.command),
    args: Object.freeze([...descriptor.args]),
  });
}

function outputHash(result) {
  return sha256Bytes(Buffer.from(`${result?.stdout ?? ''}\0${result?.stderr ?? ''}`, 'utf8'));
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

export function classifyGeminiNativeStatus(result) {
  const base = {
    exit_code: result?.exitCode ?? null,
    output_sha256: outputHash(result),
    activation: 'UNKNOWN',
    enablement: 'UNKNOWN',
  };
  if (result?.status === 'timed_out') return Object.freeze({ ...base, status: 'TIMEOUT' });
  if (result?.status !== 'exited') return Object.freeze({ ...base, status: 'UNKNOWN' });
  if (result.exitCode !== 0) return Object.freeze({ ...base, status: 'FAILED' });
  const text = stripAnsi(`${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  const rows = text.split(/\r?\n/).map(line => line.trim()).filter(line => (
    /^[✓✗○⛔…]\s+uemcp(?::|\s+\(from\s+[^\r\n()]+\):)/i.test(line)
    && /\s-\s(?:Connected|Disconnected|Disabled|Blocked|Connecting)$/.test(line)
  ));
  if (rows.length > 1) return Object.freeze({ ...base, status: 'AMBIGUOUS' });
  if (rows.length === 0) {
    return Object.freeze({
      ...base,
      status: /No MCP servers configured\./i.test(text) ? 'ABSENT' : 'UNKNOWN',
    });
  }
  const match = rows[0].match(/\s-\s(Connected|Disconnected|Disabled|Blocked|Connecting)$/);
  if (!match) return Object.freeze({ ...base, status: 'UNKNOWN' });
  const status = match[1].toUpperCase();
  if (status === 'CONNECTED') return Object.freeze({ ...base, status, activation: 'CONNECTED', enablement: 'ENABLED' });
  if (status === 'DISABLED') return Object.freeze({ ...base, status, enablement: 'DISABLED' });
  if (status === 'BLOCKED') return Object.freeze({ ...base, status, enablement: 'POLICY_BLOCKED' });
  return Object.freeze({ ...base, status });
}

function environmentForLaunch(context, launch) {
  return { ...(context.env ?? process.env), ...(launch.env_overlay ?? {}) };
}

async function inspectNative(runner, context, detection) {
  try {
    const result = await runner.run(detection.launch.command, [
      ...detection.launch.args_prefix,
      'mcp',
      'list',
    ], {
      cwd: context.workspaceRoot,
      env: environmentForLaunch(context, detection.launch),
      shell: false,
      timeoutMs: 10_000,
      outputLimitBytes: 64 * 1024,
    });
    return classifyGeminiNativeStatus(result);
  } catch (error) {
    if (error?.code === 'MUTATING_NATIVE_COMMAND') throw error;
    return Object.freeze({
      status: 'UNKNOWN',
      exit_code: null,
      output_sha256: null,
      activation: 'UNKNOWN',
      enablement: 'UNKNOWN',
      error_code: error?.code ?? 'PROCESS_LAUNCH_FAILED',
    });
  }
}

function normalizedLimits(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (!Number.isSafeInteger(limits.fileBytes) || limits.fileBytes <= 0
    || !Number.isSafeInteger(limits.aggregateBytes) || limits.aggregateBytes < limits.fileBytes
    || !Number.isSafeInteger(limits.extensionRecords) || limits.extensionRecords <= 0
    || !Number.isSafeInteger(limits.extensionRuleBytes) || limits.extensionRuleBytes <= 0) {
    fail('Gemini inspection limits are invalid', 'INVALID_INSPECTION_LIMIT');
  }
  return Object.freeze(limits);
}

function strictJsonDocument(bytes, { pathLabel, maxBytes }) {
  const document = parseJsoncDocument(bytes, { pathLabel, maxBytes, allowTrailingComma: false });
  let parsed;
  try {
    parsed = JSON.parse(document.text);
  } catch {
    fail(`${pathLabel} must contain strict JSON`, 'MALFORMED_CONFIG');
  }
  if (!plainObject(parsed)) fail(`${pathLabel} must contain a top-level object`, 'MALFORMED_CONFIG');
  return Object.freeze({ ...document, parsed_value: parsed, strict_json: true });
}

async function readConfigFile(fsImpl, captureFingerprint, entry, tracker, limits, {
  strict = false,
  singleLink = false,
} = {}) {
  const file = await readBoundedConfigFile({
    fsImpl,
    captureFingerprint,
    entry,
    tracker,
    limits,
    parseBytes: bytes => strict
      ? strictJsonDocument(bytes, { pathLabel: `Gemini ${entry.scope}`, maxBytes: limits.fileBytes })
      : parseJsoncDocument(bytes, {
        pathLabel: `Gemini ${entry.scope}`,
        maxBytes: limits.fileBytes,
        allowTrailingComma: false,
      }),
  });
  if (singleLink && file.exists && (file.fingerprint.link_kind !== 'none' || file.fingerprint.link_count !== 1)) {
    fail('Gemini host-owned evidence is linked', 'UNSAFE_CONFIG_PATH', { scope: entry.scope });
  }
  return file;
}

function validateEntry(entry, label, { absoluteCommand = false } = {}) {
  if (!plainObject(entry)) fail(`${label} must be an object`, 'MALFORMED_CONFIG');
  if (Object.hasOwn(entry, 'command') && (typeof entry.command !== 'string' || (absoluteCommand && !absolutePath(entry.command)))) {
    fail(`${label} command is invalid`, 'MALFORMED_CONFIG');
  }
  if (Object.hasOwn(entry, 'args') && (!Array.isArray(entry.args) || !entry.args.every(value => typeof value === 'string'))) {
    fail(`${label} args are invalid`, 'MALFORMED_CONFIG');
  }
  if (Object.hasOwn(entry, 'trust') && typeof entry.trust !== 'boolean') fail(`${label} trust is invalid`, 'MALFORMED_CONFIG');
  if (Object.hasOwn(entry, 'cwd') && entry.cwd !== null && typeof entry.cwd !== 'string') fail(`${label} cwd is invalid`, 'MALFORMED_CONFIG');
  if (Object.hasOwn(entry, 'env')) {
    if (!plainObject(entry.env) || !Object.values(entry.env).every(value => typeof value === 'string')) {
      fail(`${label} environment is invalid`, 'MALFORMED_CONFIG');
    }
  }
  return entry;
}

function validateSettings(file) {
  if (!file.exists) return {};
  const settings = file.document.parsed_value;
  if (!plainObject(settings)) fail(`Gemini ${file.scope} settings must be an object`, 'MALFORMED_CONFIG');
  if (Object.hasOwn(settings, 'mcpServers')) {
    if (!plainObject(settings.mcpServers)) fail(`Gemini ${file.scope} mcpServers must be an object`, 'MALFORMED_CONFIG');
    for (const [name, entry] of Object.entries(settings.mcpServers)) validateEntry(entry, `Gemini ${file.scope} server ${name}`);
  }
  if (Object.hasOwn(settings, 'mcp')) {
    if (!plainObject(settings.mcp)) fail(`Gemini ${file.scope} mcp policy must be an object`, 'MALFORMED_CONFIG');
    for (const key of ['allowed', 'excluded']) {
      if (Object.hasOwn(settings.mcp, key)
        && (!Array.isArray(settings.mcp[key]) || !settings.mcp[key].every(value => typeof value === 'string'))) {
        fail(`Gemini ${file.scope} mcp.${key} must be an array of strings`, 'MALFORMED_CONFIG');
      }
    }
  }
  if (Object.hasOwn(settings, 'admin')) {
    if (!plainObject(settings.admin)) fail(`Gemini ${file.scope} admin policy must be an object`, 'MALFORMED_CONFIG');
    if (Object.hasOwn(settings.admin, 'mcp')) {
      const policy = settings.admin.mcp;
      if (!plainObject(policy)) fail(`Gemini ${file.scope} admin.mcp must be an object`, 'MALFORMED_CONFIG');
      if (Object.hasOwn(policy, 'enabled') && typeof policy.enabled !== 'boolean') fail(`Gemini ${file.scope} admin.mcp.enabled is invalid`, 'MALFORMED_CONFIG');
      for (const key of ['config', 'requiredConfig']) {
        if (Object.hasOwn(policy, key) && !plainObject(policy[key])) fail(`Gemini ${file.scope} admin.mcp.${key} is invalid`, 'MALFORMED_CONFIG');
      }
    }
    if (Object.hasOwn(settings.admin, 'extensions')) {
      const policy = settings.admin.extensions;
      if (!plainObject(policy)) fail(`Gemini ${file.scope} admin.extensions must be an object`, 'MALFORMED_CONFIG');
      if (Object.hasOwn(policy, 'enabled') && typeof policy.enabled !== 'boolean') {
        fail(`Gemini ${file.scope} admin.extensions.enabled is invalid`, 'MALFORMED_CONFIG');
      }
    }
  }
  return settings;
}

function cloneValue(value) {
  if (Array.isArray(value)) return value.map(cloneValue);
  if (plainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneValue(item)]));
  return value;
}

function mergeSettings(target, source, path = []) {
  if (!plainObject(source)) return target;
  for (const [key, value] of Object.entries(source)) {
    const nextPath = [...path, key];
    if (nextPath.join('/') === 'admin/mcp') {
      target[key] = cloneValue(value);
    } else if (plainObject(value) && plainObject(target[key])) {
      mergeSettings(target[key], value, nextPath);
    } else {
      target[key] = cloneValue(value);
    }
  }
  return target;
}

function physicalMatches(current, desired) {
  return plainObject(current)
    && current.command === desired.command
    && Array.isArray(current.args)
    && JSON.stringify(current.args) === JSON.stringify(desired.args);
}

function logicalTargetKeys(servers) {
  if (!plainObject(servers)) return [];
  return Object.keys(servers).filter(key => key.trim().toLowerCase() === 'uemcp');
}

function physicalEvidence(entry) {
  if (!plainObject(entry)) return null;
  return Object.freeze({
    command_sha256: Object.hasOwn(entry, 'command') ? sha256Canonical(entry.command) : null,
    args_count: Array.isArray(entry.args) ? entry.args.length : null,
    args_sha256: Object.hasOwn(entry, 'args') ? sha256Canonical(entry.args) : null,
  });
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
  if (keys.some(key => {
    const normalized = key.toUpperCase();
    return normalized.startsWith('UEMCP_') || normalized.startsWith('UNREAL_') || SENSITIVE_ENVIRONMENT_KEYS.has(normalized);
  })) actions.push('CUSTOM_ENV_REVIEW_REQUIRED');
  if (entry?.cwd !== undefined && entry.cwd !== null) actions.push('CUSTOM_LAUNCH_REVIEW_REQUIRED');
  return actions;
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

async function settingsOccurrence({ source, desired, ledger, ownership = false }) {
  if (!source.exists) return null;
  const servers = getJsoncValue(source.document, ['mcpServers']);
  const targetKeys = logicalTargetKeys(servers);
  if (targetKeys.length === 0) return null;
  const entryName = targetKeys.includes('uemcp') ? 'uemcp' : targetKeys[0];
  const entry = servers[entryName];
  const logicalNameConflict = targetKeys.length !== 1 || entryName !== 'uemcp';
  validateEntry(entry, `Gemini ${source.scope} ${entryName}`);
  const owned = ownership && !logicalNameConflict ? await inspectOwnership({
    ledger,
    currentEntry: entry,
    desiredEntry: desired,
    location: { clientId: 'gemini', configPath: source.path, scope: 'user', entryName: 'uemcp' },
  }) : null;
  return Object.freeze({
    scope: source.scope,
    path: source.path,
    allowed_root: source.allowed_root,
    entry_name: entryName,
    logical_name_conflict: logicalNameConflict,
    matching: !logicalNameConflict && physicalMatches(entry, desired),
    physical_entry: physicalEvidence(entry),
    entry_sha256: sha256Canonical(entry),
    config_sha256: sha256Bytes(source.bytes),
    environment: environmentEvidence(entry),
    custom_launch: entry.cwd !== undefined && entry.cwd !== null,
    review_actions: Object.freeze(reviewActions(entry)),
    ownership: safeOwnershipEvidence(owned),
  });
}

function ensureSlashPath(path) {
  let result = path.replace(/\\/g, '/');
  if (!result.startsWith('/')) result = `/${result}`;
  if (!result.endsWith('/')) result = `${result}/`;
  return result;
}

function extensionRuleMatches(rule, workspaceRoot) {
  const disabled = rule.startsWith('!');
  let source = disabled ? rule.slice(1) : rule;
  const firstWildcard = source.indexOf('*');
  if (firstWildcard !== -1 && (firstWildcard !== source.length - 1 || source.indexOf('*', firstWildcard + 1) !== -1)) {
    fail('Gemini extension enablement rule is unsupported', 'MALFORMED_CONFIG');
  }
  const includeSubdirs = source.endsWith('*');
  if (includeSubdirs) source = source.slice(0, -1);
  const base = ensureSlashPath(source);
  const workspace = ensureSlashPath(workspaceRoot);
  return { matched: includeSubdirs ? workspace.startsWith(base) : workspace === base, disabled };
}

function addExtensionRecords(tracker, count, limit) {
  tracker.total += count;
  if (tracker.total > limit) fail('Gemini extension record count exceeds its limit', 'INSPECTION_LIMIT_EXCEEDED');
}

function extensionEnabled(enablement, name, workspaceRoot, recordTracker, limits) {
  const state = enablement[name];
  if (state === undefined) return true;
  if (!plainObject(state) || !Array.isArray(state.overrides) || !state.overrides.every(value => typeof value === 'string')) {
    fail('Gemini extension enablement is malformed', 'MALFORMED_CONFIG');
  }
  addExtensionRecords(recordTracker, state.overrides.length, limits.extensionRecords);
  let enabled = true;
  for (const rule of state.overrides) {
    if (Buffer.byteLength(rule, 'utf8') > limits.extensionRuleBytes) {
      fail('Gemini extension enablement rule exceeds its limit', 'INSPECTION_LIMIT_EXCEEDED');
    }
    const result = extensionRuleMatches(rule, workspaceRoot);
    if (result.matched) enabled = !result.disabled;
  }
  return enabled;
}

async function inspectExtensions({ fsImpl, captureFingerprint, locations, workspaceRoot, tracker, limits, desired, extensionsEnabled }) {
  if (!extensionsEnabled) {
    return { rows: [], files: [], evidence_status: 'READY', extensions_enabled: false };
  }
  let enablementFile;
  let enablement = {};
  let evidenceStatus = 'READY';
  const recordTracker = { total: 0 };
  try {
    enablementFile = await readConfigFile(fsImpl, captureFingerprint, locations.extensions_enablement, tracker, limits, {
      strict: true,
      singleLink: true,
    });
    if (enablementFile.exists) {
      enablement = enablementFile.document.parsed_value;
      if (!plainObject(enablement)) fail('Gemini extension enablement must be an object', 'MALFORMED_CONFIG');
      addExtensionRecords(recordTracker, Object.keys(enablement).length, limits.extensionRecords);
    }
  } catch (error) {
    if (error?.code !== 'MALFORMED_CONFIG') throw error;
    evidenceStatus = 'UNKNOWN';
    enablementFile = null;
  }

  let entries;
  try {
    const rootStat = await fsImpl.lstat(locations.extensions_root.path);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail('Gemini extensions root is unsafe', 'UNSAFE_CONFIG_PATH');
    const realGlobal = await fsImpl.realpath(locations.global_dir);
    const realRoot = await fsImpl.realpath(locations.extensions_root.path);
    if (!contained(realGlobal, realRoot)) fail('Gemini extensions root escapes the global directory', 'UNSAFE_CONFIG_PATH');
    entries = await fsImpl.readdir(locations.extensions_root.path, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return { rows: [], files: enablementFile ? [enablementFile] : [], evidence_status: evidenceStatus, extensions_enabled: true };
    }
    throw error;
  }
  addExtensionRecords(recordTracker, entries.length, limits.extensionRecords);

  const rows = [];
  const files = enablementFile ? [enablementFile] : [];
  const seenExtensionNames = new Set();
  for (const directory of [...entries].sort((left, right) => left.name.localeCompare(right.name))) {
    if (directory.name === 'extension-enablement.json' || (!directory.isDirectory() && !directory.isSymbolicLink())) continue;
    if (directory.isSymbolicLink()) fail('Gemini extension directory is linked', 'UNSAFE_CONFIG_PATH');
    const directoryPath = resolve(locations.extensions_root.path, directory.name);
    const realRoot = await fsImpl.realpath(locations.extensions_root.path);
    const realDirectory = await fsImpl.realpath(directoryPath);
    if (!contained(realRoot, realDirectory)) fail('Gemini extension directory escapes its root', 'UNSAFE_CONFIG_PATH');
    const manifestLocation = location(join(directoryPath, 'gemini-extension.json'), locations.extensions_root.path, `extension:${directory.name}`);
    try {
      const manifest = await readConfigFile(fsImpl, captureFingerprint, manifestLocation, tracker, limits, {
        strict: true,
        singleLink: true,
      });
      files.push(manifest);
      if (!manifest.exists) fail('Gemini extension manifest is missing', 'MALFORMED_CONFIG');
      const root = manifest.document.parsed_value;
      if (!plainObject(root)) fail('Gemini extension manifest must be an object', 'MALFORMED_CONFIG');
      if (typeof root.name !== 'string' || root.name.trim() === '') fail('Gemini extension name is invalid', 'MALFORMED_CONFIG');
      if (root.mcpServers !== undefined && !plainObject(root.mcpServers)) fail('Gemini extension mcpServers is invalid', 'MALFORMED_CONFIG');
      if (seenExtensionNames.has(root.name)) evidenceStatus = 'UNKNOWN';
      seenExtensionNames.add(root.name);
      for (const [name, server] of Object.entries(root.mcpServers ?? {})) {
        validateEntry(server, `Gemini extension ${root.name} ${name}`);
      }
      const targetKeys = logicalTargetKeys(root.mcpServers);
      const entryName = targetKeys.includes('uemcp') ? 'uemcp' : targetKeys[0];
      const entry = entryName === undefined ? undefined : root.mcpServers[entryName];
      const logicalNameConflict = targetKeys.length !== 0 && (targetKeys.length !== 1 || entryName !== 'uemcp');
      let enabled = null;
      try {
        enabled = evidenceStatus === 'READY'
          ? extensionEnabled(enablement, root.name, workspaceRoot, recordTracker, limits)
          : null;
      } catch (error) {
        if (error?.code !== 'MALFORMED_CONFIG') throw error;
        evidenceStatus = 'UNKNOWN';
      }
      rows.push(Object.freeze({
        name: root.name,
        path: manifest.path,
        enabled,
        declares_uemcp: targetKeys.length > 0,
        entry_name: entryName ?? null,
        logical_name_conflict: logicalNameConflict,
        matching: entry === undefined ? null : !logicalNameConflict && physicalMatches(entry, desired),
        physical_entry: entry === undefined ? null : physicalEvidence(entry),
        entry_sha256: entry === undefined ? null : sha256Canonical(entry),
      }));
    } catch (error) {
      if (error?.code !== 'MALFORMED_CONFIG') throw error;
      evidenceStatus = 'UNKNOWN';
      rows.push(Object.freeze({
        name: directory.name,
        path: manifestLocation.path,
        enabled: null,
        declares_uemcp: null,
        entry_name: null,
        logical_name_conflict: null,
        matching: null,
        physical_entry: null,
        entry_sha256: null,
      }));
    }
  }
  return { rows, files, evidence_status: evidenceStatus, extensions_enabled: true };
}

function validateEnablement(file) {
  if (!file.exists) return Object.freeze({ status: 'READY', enabled: true, explicit: false });
  const root = file.document.parsed_value;
  for (const [key, value] of Object.entries(root)) {
    if (key !== key.toLowerCase().trim() || !plainObject(value)
      || !Object.hasOwn(value, 'enabled') || typeof value.enabled !== 'boolean') {
      return Object.freeze({ status: 'UNKNOWN', enabled: null, explicit: false });
    }
  }
  const state = root.uemcp;
  return Object.freeze({
    status: 'READY',
    enabled: state?.enabled ?? true,
    explicit: state !== undefined,
  });
}

function classifyPolicy(settings, policyKnown) {
  const normalize = value => value.toLowerCase().trim();
  const admin = settings.admin?.mcp;
  if (admin?.enabled === false) return 'POLICY_BLOCKED';
  if (plainObject(admin?.config) && Object.keys(admin.config).length > 0) {
    return 'POLICY_BLOCKED';
  }
  if (plainObject(admin?.requiredConfig) && Object.hasOwn(admin.requiredConfig, 'uemcp')) return 'POLICY_BLOCKED';
  const allowed = settings.mcp?.allowed;
  const excluded = settings.mcp?.excluded;
  if (Array.isArray(allowed) && allowed.length > 0 && !allowed.map(normalize).includes('uemcp')) return 'POLICY_BLOCKED';
  if (Array.isArray(excluded) && excluded.map(normalize).includes('uemcp')) return 'POLICY_BLOCKED';
  return policyKnown ? 'ALLOWED' : 'POLICY_UNKNOWN';
}

function statusFromError(error) {
  if (error?.code === 'INSPECTION_LIMIT_EXCEEDED') return 'INSPECTION_LIMIT_EXCEEDED';
  if (error?.code === 'MALFORMED_CONFIG' || error?.name === 'ConfigFormatError') return 'MALFORMED_CONFIG';
  if (['UNSAFE_CONFIG_PATH', 'UNSAFE_EVIDENCE_PATH', 'PATH_OUTSIDE_WRITABLE_ROOT'].includes(error?.code)) return 'UNSAFE_CONFIG_PATH';
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
      fail('Gemini launch evidence is no longer a regular file', 'CLIENT_LAUNCH_EVIDENCE_INVALID');
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

function ownershipLedgerStatus(ownership) {
  if (ownership?.stale_reason && LEDGER_FAILURES.has(ownership.stale_reason)) return Object.freeze({ status: 'INVALID', reason: ownership.stale_reason });
  return Object.freeze({ status: 'VALID', reason: null });
}

function remediationActions({ enablement, policy, enablementEvidence, detection }) {
  if (enablement !== 'DISABLED' && policy !== 'POLICY_BLOCKED') return Object.freeze([]);
  const canEnable = enablement === 'DISABLED'
    && enablementEvidence.status === 'READY'
    && enablementEvidence.enabled === false
    && detection.custom_home === false;
  return Object.freeze([Object.freeze({
    code: 'CLIENT_ENABLEMENT_REQUIRED',
    message: policy === 'POLICY_BLOCKED'
      ? 'Gemini policy blocks the UEMCP server; review the effective MCP policy.'
      : 'Gemini has the UEMCP server disabled; enable it in the active client context.',
    command: canEnable ? Object.freeze({
      executable: detection.launch.command,
      args: Object.freeze([...detection.launch.args_prefix, 'mcp', 'enable', 'uemcp']),
    }) : null,
  })]);
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

function operationCommon({ id, type, current, source, context, readOnly, desired, inspection }) {
  return {
    operation_id: id,
    client_id: 'gemini',
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
    json_path: ENTRY_PATH,
    external_write: false,
    verification_status: inspection.enablement === 'DISABLED' ? 'CLIENT_ENABLEMENT_REQUIRED' : null,
  };
}

function missing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

async function readCurrentDocument(fsImpl, path, label) {
  try {
    const bytes = await fsImpl.readFile(path);
    return { bytes, document: parseJsoncDocument(bytes, { pathLabel: label, allowTrailingComma: false }) };
  } catch (error) {
    if (!missing(error)) throw error;
    const bytes = Buffer.alloc(0);
    return { bytes, document: parseJsoncDocument(bytes, { pathLabel: label, allowTrailingComma: false }) };
  }
}

function assertOperationPrecondition(operation, bytes, entry) {
  const configHash = bytes.length === 0 && operation.current_config_sha256 === null ? null : sha256Bytes(bytes);
  if (configHash !== operation.current_config_sha256) fail('Gemini config changed after planning', 'TRANSACTION_PRECONDITION_CHANGED');
  const entryHash = entry === undefined ? null : sha256Canonical(entry);
  if (entryHash !== operation.current_entry_sha256) fail('Gemini entry changed after planning', 'TRANSACTION_PRECONDITION_CHANGED');
}

function applyOwnedFields(document, desired, replaceWhole) {
  if (replaceWhole) return setJsoncValue(document, ENTRY_PATH, desired);
  return setJsoncValues(document, ['command', 'args'].map(key => ({
    path: [...ENTRY_PATH, key],
    value: desired[key],
  })));
}

export function createGeminiAdapter({
  fsImpl = defaultFs,
  runner = createProcessRunner(),
  captureFingerprint = captureClientPathFingerprint,
  limits: limitOverrides = {},
} = {}) {
  const limits = normalizedLimits(limitOverrides);

  async function detect(context) {
    if (context?.launch?.client_id !== 'gemini') fail('Gemini launch evidence is missing', 'INVALID_CLIENT_LAUNCH');
    validateClientLaunchContract(context.launch);
    const locations = resolveGeminiLocations(context);
    return Object.freeze({
      client_id: 'gemini',
      version: context.launch.version,
      write_supported: context.launch.write_supported === true,
      compatibility: context.launch.compatibility,
      launch: context.launch,
      custom_home: locations.custom_home,
      locations,
    });
  }

  async function inspect(context, detection) {
    if (detection?.client_id !== 'gemini') fail('Gemini detection is invalid', 'INVALID_CLIENT_DETECTION');
    const desired = physicalGeminiEntry(context.descriptor);
    try {
      const tracker = { total: 0 };
      const systemDefaults = await readConfigFile(fsImpl, captureFingerprint, detection.locations.system_defaults, tracker, limits);
      const user = await readConfigFile(fsImpl, captureFingerprint, detection.locations.user, tracker, limits);
      const project = await readConfigFile(fsImpl, captureFingerprint, detection.locations.project, tracker, limits);
      const systemOverride = await readConfigFile(fsImpl, captureFingerprint, detection.locations.system_override, tracker, limits);
      const enablementFile = await readConfigFile(fsImpl, captureFingerprint, detection.locations.enablement, tracker, limits, {
        strict: true,
        singleLink: true,
      });
      const settingsFiles = [systemDefaults, user, project, systemOverride];
      const values = Object.fromEntries(settingsFiles.map(file => [file.scope, validateSettings(file)]));
      const merged = {};
      mergeSettings(merged, values.system_defaults);
      mergeSettings(merged, values.user);
      if (context.workspaceTrusted === true) mergeSettings(merged, values.project);
      mergeSettings(merged, values.system_override);

      const extensionInspection = await inspectExtensions({
        fsImpl,
        captureFingerprint,
        locations: detection.locations,
        workspaceRoot: context.workspaceRoot,
        tracker,
        limits,
        desired,
        extensionsEnabled: merged.admin?.extensions?.enabled !== false,
      });
      const launchEvidence = await captureLaunchEvidence(captureFingerprint, context, detection);
      const occurrences = [];
      for (const source of settingsFiles) {
        if (source.scope === 'project' && context.workspaceTrusted !== true) continue;
        const row = await settingsOccurrence({
          source,
          desired,
          ledger: context.ownershipLedger,
          ownership: source.scope === 'user',
        });
        if (row) occurrences.push(row);
      }
      for (const extension of extensionInspection.rows) {
        if (extension.declares_uemcp !== true || extension.enabled !== true) continue;
        occurrences.push(Object.freeze({
          scope: 'extension',
          path: extension.path,
          matching: extension.matching,
          extension_name: extension.name,
          physical_entry: extension.physical_entry,
          entry_sha256: extension.entry_sha256,
          entry_name: extension.entry_name,
          logical_name_conflict: extension.logical_name_conflict,
          review_actions: Object.freeze([]),
          ownership: null,
        }));
      }

      const activeSettingsEntry = merged.mcpServers?.uemcp;
      if (activeSettingsEntry !== undefined) validateEntry(activeSettingsEntry, 'Gemini effective uemcp', { absoluteCommand: true });
      const activeExtensions = extensionInspection.rows.filter(row => row.enabled === true && row.declares_uemcp === true);
      const highestSettingsOccurrence = [...occurrences].reverse().find(row => row.scope !== 'extension') ?? null;
      const logicalNameConflict = occurrences.some(row => row.logical_name_conflict === true);
      let effective = null;
      let registration;
      if (logicalNameConflict) {
        const conflict = [...occurrences].reverse().find(row => row.logical_name_conflict === true);
        effective = Object.freeze({ scope: conflict?.scope ?? 'settings', path: conflict?.path ?? null, matching: false });
        registration = 'CONFLICT';
      } else if (activeSettingsEntry !== undefined) {
        effective = Object.freeze({
          scope: highestSettingsOccurrence?.scope ?? 'settings',
          path: highestSettingsOccurrence?.path ?? null,
          matching: physicalMatches(activeSettingsEntry, desired),
        });
        registration = effective.matching ? 'CONFIGURED' : 'CONFLICT';
      } else if (extensionInspection.evidence_status !== 'READY') {
        registration = 'UNKNOWN';
      } else if (activeExtensions.length === 0) {
        registration = 'ABSENT';
      } else if (activeExtensions.length === 1) {
        effective = Object.freeze({
          scope: 'extension',
          path: activeExtensions[0].path,
          matching: activeExtensions[0].matching,
        });
        registration = effective.matching ? 'CONFIGURED' : 'CONFLICT';
      } else {
        effective = Object.freeze({ scope: 'extension', path: null, matching: false });
        registration = 'CONFLICT';
      }

      const policy = extensionInspection.evidence_status === 'READY'
        ? classifyPolicy(merged, context.invocationPolicyKnown === true)
        : 'POLICY_UNKNOWN';
      const enablementEvidence = validateEnablement(enablementFile);
      let enablement = registration === 'CONFIGURED' ? 'ENABLED' : 'UNKNOWN';
      if (policy === 'POLICY_BLOCKED') enablement = 'POLICY_BLOCKED';
      else if (policy === 'POLICY_UNKNOWN' || enablementEvidence.status !== 'READY') enablement = 'UNKNOWN';
      else if (registration === 'CONFIGURED' && enablementEvidence.enabled === false) enablement = 'DISABLED';

      const native = await inspectNative(runner, context, detection);
      let activation = native.activation;
      if (native.status === 'DISABLED') enablement = 'DISABLED';
      if (native.status === 'BLOCKED') enablement = 'POLICY_BLOCKED';
      if (native.status === 'DISCONNECTED' && context.workspaceTrusted !== true && registration === 'CONFIGURED') activation = 'PENDING_TRUST';
      const actions = occurrences.flatMap(row => row.review_actions ?? []);
      if (enablement === 'DISABLED' || enablement === 'POLICY_BLOCKED') actions.push('CLIENT_ENABLEMENT_REQUIRED');
      if (activation === 'PENDING_TRUST') actions.push('PENDING_TRUST');
      if (policy === 'POLICY_UNKNOWN' || enablementEvidence.status !== 'READY') actions.push('POLICY_UNKNOWN');
      if (registration === 'CONFLICT') actions.push('CONFLICT');

      let ownership = occurrences.find(row => row.scope === 'user')?.ownership ?? null;
      if (!ownership) {
        ownership = safeOwnershipEvidence(await inspectOwnership({
          ledger: context.ownershipLedger,
          currentEntry: desired,
          desiredEntry: desired,
          location: { clientId: 'gemini', configPath: user.path, scope: 'user', entryName: 'uemcp' },
        }));
      }
      const sourceFiles = [
        ...settingsFiles,
        enablementFile,
        ...extensionInspection.files,
      ];
      return Object.freeze({
        client_id: 'gemini',
        registration,
        enablement,
        activation,
        policy,
        actions: Object.freeze(unique(actions)),
        remediation_actions: remediationActions({ enablement, policy, enablementEvidence, detection }),
        occurrences: Object.freeze(occurrences),
        extensions: Object.freeze(extensionInspection.rows),
        extensions_enabled: extensionInspection.extensions_enabled,
        logical_name_conflict: logicalNameConflict,
        extension_evidence: extensionInspection.evidence_status,
        enablement_evidence: enablementEvidence,
        ignored_project: context.workspaceTrusted !== true && project.exists
          ? Object.freeze({ path: project.path, reason: 'UNTRUSTED_PROJECT' })
          : null,
        effective,
        native,
        files: Object.freeze([...sourceFiles.map(publicFileEvidence), ...launchEvidence]),
        ownership_ledger: ownershipLedgerStatus(ownership),
        desired,
      });
    } catch (error) {
      const status = statusFromError(error);
      return Object.freeze({
        client_id: 'gemini',
        registration: status,
        enablement: 'UNKNOWN',
        activation: 'UNKNOWN',
        policy: 'POLICY_UNKNOWN',
        actions: Object.freeze([status]),
        remediation_actions: Object.freeze([]),
        occurrences: Object.freeze([]),
        extensions: Object.freeze([]),
        extensions_enabled: null,
        logical_name_conflict: false,
        extension_evidence: 'UNKNOWN',
        enablement_evidence: Object.freeze({ status: 'UNKNOWN', enabled: null, explicit: false }),
        ignored_project: null,
        effective: null,
        native: Object.freeze({ status: 'NOT_CHECKED', activation: 'UNKNOWN', enablement: 'UNKNOWN' }),
        files: Object.freeze([]),
        ownership_ledger: Object.freeze({ status: 'UNKNOWN', reason: null }),
        desired,
      });
    }
  }

  async function plan(context, inspection, descriptor) {
    if (inspection?.client_id !== 'gemini') fail('Gemini inspection is invalid', 'INVALID_CLIENT_INSPECTION');
    if (typeof context.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(context.planDigest)) fail('Gemini plan digest is invalid', 'INVALID_PLAN_DIGEST');
    const desired = physicalGeminiEntry(descriptor);
    if (['MALFORMED_CONFIG', 'INSPECTION_LIMIT_EXCEEDED', 'UNSAFE_CONFIG_PATH'].includes(inspection.registration)) {
      return Object.freeze({ client_id: 'gemini', status: inspection.registration, operations: Object.freeze([]), actions: inspection.actions });
    }
    if (!context.launch.write_supported) {
      return Object.freeze({ client_id: 'gemini', status: 'UNSUPPORTED_VERSION', operations: Object.freeze([]), actions: Object.freeze(['UNSUPPORTED_VERSION']) });
    }
    if (inspection.extension_evidence !== 'READY' || inspection.enablement_evidence.status !== 'READY') {
      return Object.freeze({ client_id: 'gemini', status: 'POLICY_UNKNOWN', operations: Object.freeze([]), actions: inspection.actions });
    }
    if (inspection.policy === 'POLICY_BLOCKED') {
      return Object.freeze({ client_id: 'gemini', status: 'POLICY_BLOCKED', operations: Object.freeze([]), actions: inspection.actions });
    }
    if (inspection.ownership_ledger?.status === 'INVALID') {
      return Object.freeze({ client_id: 'gemini', status: 'OWNERSHIP_LEDGER_INVALID', operations: Object.freeze([]), actions: Object.freeze(unique([...inspection.actions, 'OWNERSHIP_LEDGER_INVALID'])) });
    }
    if (inspection.logical_name_conflict === true) {
      return Object.freeze({ client_id: 'gemini', status: 'CONFLICT', operations: Object.freeze([]), actions: Object.freeze(unique([...inspection.actions, 'CONFLICT'])) });
    }

    const effectiveScope = inspection.effective?.scope;
    if (['project', 'system_override'].includes(effectiveScope)) {
      return Object.freeze({
        client_id: 'gemini',
        status: inspection.effective.matching ? 'NO_OP' : 'CONFLICT',
        operations: Object.freeze([]),
        actions: Object.freeze(unique([...inspection.actions, inspection.effective.matching ? 'SHADOWED' : 'CONFLICT'])),
      });
    }
    if (effectiveScope === 'extension' && inspection.registration === 'CONFIGURED') {
      return Object.freeze({ client_id: 'gemini', status: 'NO_OP', operations: Object.freeze([]), actions: inspection.actions });
    }
    const extensionConflict = effectiveScope === 'extension' && inspection.registration === 'CONFLICT';
    if (extensionConflict && context.approvedExtensionShadow !== true) {
      return Object.freeze({ client_id: 'gemini', status: 'CONFLICT', operations: Object.freeze([]), actions: inspection.actions });
    }

    const files = Object.fromEntries(inspection.files.map(file => [file.scope, file]));
    const userFile = files.user;
    const user = inspection.occurrences.find(row => row.scope === 'user');
    let type;
    if (!user) {
      if (inspection.registration === 'CONFIGURED' && effectiveScope === 'system_defaults') {
        return Object.freeze({ client_id: 'gemini', status: 'NO_OP', operations: Object.freeze([]), actions: inspection.actions });
      }
      type = 'CREATE_ENTRY';
    } else if (user.matching && user.ownership?.recommended_action === 'ADOPT_EXACT_ENTRY') type = 'ADOPT_EXACT_ENTRY';
    else if (user.matching) return Object.freeze({ client_id: 'gemini', status: 'NO_OP', operations: Object.freeze([]), actions: inspection.actions });
    else if (user.ownership?.state === 'owned_matching' || context.approvedOwnedReplacement === true) type = 'UPDATE_OWNED_FIELDS';
    else return Object.freeze({ client_id: 'gemini', status: 'CONFLICT', operations: Object.freeze([]), actions: Object.freeze(unique([...inspection.actions, 'CONFLICT'])) });

    const providerWrite = type !== 'ADOPT_EXACT_ENTRY';
    let source = userFile;
    try {
      if (providerWrite) source = await writableFileEvidence(captureFingerprint, userFile);
    } catch (error) {
      const status = planningFailure(error);
      return Object.freeze({ client_id: 'gemini', status, operations: Object.freeze([]), actions: Object.freeze(unique([...inspection.actions, status])) });
    }
    const readOnly = readOnlyRows(inspection.files, providerWrite ? source.path : null);
    const common = operationCommon({
      id: type === 'CREATE_ENTRY' ? 'gemini-create-user-uemcp' : type === 'ADOPT_EXACT_ENTRY' ? 'gemini-adopt-user-uemcp' : 'gemini-update-user-uemcp',
      type,
      current: user,
      source,
      context,
      readOnly,
      desired,
      inspection,
    });
    let operation = common;
    if (type === 'ADOPT_EXACT_ENTRY') {
      operation = Object.freeze({
        ...common,
        ledger_only: true,
        adoption: Object.freeze({
          operation_id: common.operation_id,
          type: 'ADOPT_EXACT_ENTRY',
          ownership_key: ownershipKey({ clientId: 'gemini', configPath: source.path, scope: 'user', entryName: 'uemcp' }),
          current_entry_sha256: user.entry_sha256,
          current_config_sha256: user.config_sha256,
          plan_digest: context.planDigest,
        }),
      });
    } else {
      operation = Object.freeze({
        ...common,
        explicit_owned_replacement: type === 'UPDATE_OWNED_FIELDS' && context.approvedOwnedReplacement === true,
        shadows_extension: extensionConflict,
      });
    }
    const status = type === 'CREATE_ENTRY' ? 'CREATE' : type === 'ADOPT_EXACT_ENTRY' ? 'ADOPT' : 'UPDATE';
    return Object.freeze({ client_id: 'gemini', status, operations: Object.freeze([operation]), actions: inspection.actions });
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

  async function apply(context, operations) {
    if (!context.transaction?.writeFile || !context.transaction?.ownershipLedger) fail('Gemini apply requires the transaction capability', 'INVALID_TRANSACTION_CAPABILITY');
    for (const operation of operations) {
      if (operation.client_id !== 'gemini' || operation.write_supported !== true || operation.selected !== true) {
        fail('Gemini apply received an unapproved operation', 'UNAPPROVED_OPERATION_SET');
      }
      const current = await readCurrentDocument(fsImpl, operation.path, 'Gemini user config');
      const entry = getJsoncValue(current.document, ENTRY_PATH);
      assertOperationPrecondition(operation, current.bytes, entry);
      if (operation.type === 'ADOPT_EXACT_ENTRY') {
        await adoptExactEntry({
          ledger: context.transaction.ownershipLedger,
          location: { clientId: 'gemini', configPath: operation.path, scope: 'user', entryName: 'uemcp' },
          currentEntry: entry,
          desiredEntry: operation.desired_entry,
          approvedOperationId: operation.adoption,
        });
        continue;
      }
      if (!['CREATE_ENTRY', 'UPDATE_OWNED_FIELDS'].includes(operation.type)) fail('Gemini operation type is unsupported', 'UNAPPROVED_OPERATION_SET');
      const edit = applyOwnedFields(current.document, operation.desired_entry, operation.type === 'CREATE_ENTRY');
      if (!edit?.changed) fail('Gemini targeted edit produced no change', 'TRANSACTION_PRECONDITION_CHANGED');
      const parsed = parseJsoncDocument(edit.after_bytes, { pathLabel: 'Gemini updated user config', allowTrailingComma: false });
      const afterEntry = getJsoncValue(parsed, ENTRY_PATH);
      if (!physicalMatches(afterEntry, operation.desired_entry)) fail('Gemini write did not produce the canonical owned projection', 'STRUCTURAL_VERIFY_FAILED');
      const written = await context.transaction.writeFile(operation.path, edit.after_bytes, {
        parse: bytes => parseJsoncDocument(bytes, { pathLabel: 'Gemini updated user config', allowTrailingComma: false }),
      });
      await recordOwnedWrite({
        ledger: context.transaction.ownershipLedger,
        location: { clientId: 'gemini', configPath: operation.path, scope: 'user', entryName: 'uemcp' },
        beforeEntry: entry ?? null,
        afterEntry,
        ownedPaths: ownedPathsForClient('gemini', afterEntry),
        appliedConfigHash: written.content_sha256,
        planDigest: operation.plan_digest,
      });
    }
    return Object.freeze({ status: operations.length === 0 ? 'NO_OP' : 'APPLIED' });
  }

  async function verify(context, operations) {
    for (const operation of operations) {
      const current = await readCurrentDocument(fsImpl, operation.path, 'Gemini verification config');
      const entry = getJsoncValue(current.document, ENTRY_PATH);
      if (!physicalMatches(entry, operation.desired_entry)) fail('Gemini user entry does not match the canonical descriptor', 'STRUCTURAL_VERIFY_FAILED');
    }
    const native = await inspectNative(runner, context, await detect(context));
    const operationStatus = operations.find(row => row.verification_status)?.verification_status ?? null;
    if (operationStatus) return Object.freeze({ status: operationStatus, native });
    if (native.status === 'CONNECTED') return Object.freeze({ status: 'READY', native });
    if (native.status === 'DISABLED' || native.status === 'BLOCKED') return Object.freeze({ status: 'CLIENT_ENABLEMENT_REQUIRED', native });
    if (native.status === 'DISCONNECTED' && context.workspaceTrusted !== true) return Object.freeze({ status: 'PENDING_TRUST', native });
    return Object.freeze({ status: 'POLICY_UNKNOWN', native });
  }

  async function rollback(context, records) {
    return Object.freeze({ status: 'delegated', count: records.length });
  }

  return Object.freeze({ id: 'gemini', detect, inspect, plan, snapshot, apply, verify, rollback });
}
