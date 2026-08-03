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
import { approvedOwnedReplacement, clientDecision } from '../client-decisions.mjs';
import { captureClientPathFingerprint } from '../client-transaction.mjs';
import {
  getJsoncValue,
  parseJsoncDocument,
  removeJsoncValue,
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
  clientProcessEnvironment,
  isSensitiveClientEnvironmentName,
  readWindowsEnvironmentValue,
  runActiveClientLaunch,
  validateClientLaunchContract,
} from '../client-contract.mjs';

const DEFAULT_LIMITS = Object.freeze({
  fileBytes: 16 * 1024 * 1024,
  aggregateBytes: 64 * 1024 * 1024,
  pluginRecords: 512,
});
const MUTATING_MCP_SUBCOMMANDS = new Set(['add', 'add-json', 'remove', 'reset-project-choices']);
const PRIVATE_PROTOCOL_LAUNCH = new WeakMap();

export const CLAUDE_NATIVE_MUTATION_CHARACTERIZATION = Object.freeze({
  version: '2.1.210',
  creates_unplanned_backup: true,
  duplicate_same_name_exit_code: 1,
  duplicate_preserves_existing_config: true,
  mutating_subcommands_allowed: false,
});

export class ClaudeAdapterError extends Error {
  constructor(message, code = 'CLAUDE_ADAPTER_FAILED', details = {}) {
    super(message);
    this.name = 'ClaudeAdapterError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code = 'CLAUDE_ADAPTER_FAILED', details = {}) {
  throw new ClaudeAdapterError(message, code, details);
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

export function resolveClaudeLocations(context = {}) {
  const env = context.env ?? process.env;
  const workspaceRoot = context.workspaceRoot;
  if (!absolutePath(workspaceRoot)) fail('Claude inspection requires an absolute workspace root', 'INVALID_CLIENT_LOCATION');
  const userProfile = readWindowsEnvironmentValue(env, 'USERPROFILE');
  if (!absolutePath(userProfile)) fail('Claude inspection requires an absolute USERPROFILE', 'INVALID_CLIENT_LOCATION');
  const isolatedHome = readWindowsEnvironmentValue(env, 'CLAUDE_CONFIG_DIR');
  if (isolatedHome !== undefined && isolatedHome !== '' && !absolutePath(isolatedHome)) {
    fail('CLAUDE_CONFIG_DIR must be an absolute non-device path', 'INVALID_CLIENT_LOCATION');
  }
  const stateRoot = resolve(isolatedHome || userProfile);
  const stateWriteRoot = isolatedHome ? dirname(stateRoot) : stateRoot;
  const configRoot = resolve(isolatedHome || join(userProfile, '.claude'));
  const statePath = join(stateRoot, '.claude.json');
  const settingsPath = isolatedHome
    ? join(stateRoot, 'settings.json')
    : join(userProfile, '.claude', 'settings.json');
  const knownProgramFiles = context.knownFolders?.programFiles ?? 'C:\\Program Files';
  if (!absolutePath(knownProgramFiles)) fail('Claude managed policy root is invalid', 'INVALID_CLIENT_LOCATION');
  const programFiles = resolve(knownProgramFiles);
  const managedRoot = join(programFiles, 'ClaudeCode');
  const projectRoot = resolve(workspaceRoot);
  const pluginsRoot = join(configRoot, 'plugins');
  const pluginsCache = join(pluginsRoot, 'cache');
  return Object.freeze({
    state: location(statePath, stateWriteRoot, 'user', true),
    user_settings: location(settingsPath, stateRoot, 'user_settings'),
    project_config: location(join(projectRoot, '.mcp.json'), projectRoot, 'project', true),
    project_settings: location(join(projectRoot, '.claude', 'settings.json'), projectRoot, 'project_settings'),
    local_settings: location(join(projectRoot, '.claude', 'settings.local.json'), projectRoot, 'local_settings'),
    managed_config: location(join(managedRoot, 'managed-mcp.json'), managedRoot, 'managed'),
    managed_settings: location(join(managedRoot, 'managed-settings.json'), managedRoot, 'managed_settings'),
    plugins_registry: location(join(pluginsRoot, 'installed_plugins.json'), pluginsRoot, 'plugins_registry'),
    plugins_cache: location(pluginsCache, pluginsRoot, 'plugins_cache'),
  });
}

export function physicalClaudeEntry(descriptor) {
  if (!descriptor || descriptor.name !== 'uemcp' || descriptor.transport !== 'stdio'
    || !absolutePath(descriptor.command)
    || !Array.isArray(descriptor.args)
    || !descriptor.args.every(value => typeof value === 'string')) {
    fail('Claude desired descriptor is invalid', 'INVALID_DESCRIPTOR');
  }
  return Object.freeze({
    type: 'stdio',
    command: resolve(descriptor.command),
    args: Object.freeze([...descriptor.args]),
  });
}

function outputHash(result) {
  return sha256Bytes(Buffer.from(`${result?.stdout ?? ''}\0${result?.stderr ?? ''}`, 'utf8'));
}

export function classifyClaudeNativeStatus(result) {
  if (result?.status === 'timed_out') return Object.freeze({ status: 'TIMEOUT', exit_code: null, output_sha256: outputHash(result) });
  if (result?.status !== 'exited') return Object.freeze({ status: 'UNKNOWN', exit_code: result?.exitCode ?? null, output_sha256: outputHash(result) });
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.toLowerCase();
  const mentionsTarget = /(?:^|\s|:)uemcp(?:\s|:|$)/m.test(text) || text.includes('name uemcp');
  let status = 'UNKNOWN';
  if (text.includes('no mcp server found') || text.includes('not found') || (!mentionsTarget && result.exitCode === 0)) status = 'ABSENT';
  else if (mentionsTarget && (text.includes('rejected') || text.includes('disabledmcpjsonservers'))) status = 'REJECTED';
  else if (mentionsTarget && text.includes('pending approval')) status = 'PENDING_APPROVAL';
  else if (mentionsTarget && text.includes('connected')) status = 'CONNECTED';
  else if (mentionsTarget && (text.includes('failed to connect') || text.includes('disconnected') || text.includes('connection failed'))) status = 'FAILED';
  else if (result.exitCode !== 0) status = 'ABSENT';
  return Object.freeze({ status, exit_code: result.exitCode, output_sha256: outputHash(result) });
}

function mergeNativeStatus(listStatus, getStatus) {
  if (getStatus.status !== 'ABSENT' && getStatus.status !== 'UNKNOWN') return getStatus;
  if (listStatus.status !== 'ABSENT' && listStatus.status !== 'UNKNOWN') return listStatus;
  if (getStatus.status === 'ABSENT' || listStatus.status === 'ABSENT') return { ...getStatus, status: 'ABSENT' };
  return getStatus;
}

function environmentForLaunch(context, launch) {
  return clientProcessEnvironment(context.env ?? process.env, launch.env_overlay ?? {});
}

async function runNativeQuery(runner, context, detection, tail) {
  if (!Array.isArray(tail) || tail.length < 2 || tail[0] !== 'mcp'
    || MUTATING_MCP_SUBCOMMANDS.has(tail[1])
    || !(
      (tail.length === 2 && tail[1] === 'list')
      || (tail.length === 3 && tail[1] === 'get' && tail[2] === 'uemcp')
  )) {
    fail('Claude native MCP query is not read-only', 'MUTATING_NATIVE_COMMAND');
  }
  return runner.run(detection.launch.command, [...detection.launch.args_prefix, ...tail], {
    cwd: context.workspaceRoot,
    env: environmentForLaunch(context, detection.launch),
    shell: false,
    timeoutMs: 10_000,
    outputLimitBytes: 64 * 1024,
  });
}

async function inspectNative(runner, context, detection) {
  if (context.launch?.compatibility !== 'release_gated') {
    const unknown = classifyClaudeNativeStatus(null);
    return Object.freeze({
      ...unknown,
      list_status: 'UNKNOWN',
      get_status: 'UNKNOWN',
      list_output_sha256: unknown.output_sha256,
      get_output_sha256: unknown.output_sha256,
    });
  }
  const safeQuery = async tail => {
    return runActiveClientLaunch(context, { client_id: 'claude', kind: 'native' }, async (guard, pinnedLaunch) => {
      try {
        return await runNativeQuery(runner, context, { ...detection, launch: pinnedLaunch }, tail);
      } catch (error) {
        if (error?.code === 'MUTATING_NATIVE_COMMAND') throw error;
        return { status: 'launch_failed', exitCode: null, stdout: '', stderr: '', errorCode: error?.code ?? 'PROCESS_LAUNCH_FAILED' };
      }
    });
  };
  const listResult = await safeQuery(['mcp', 'list']);
  const getResult = await safeQuery(['mcp', 'get', 'uemcp']);
  const list = classifyClaudeNativeStatus(listResult);
  const get = classifyClaudeNativeStatus(getResult);
  return Object.freeze({
    ...mergeNativeStatus(list, get),
    list_status: list.status,
    get_status: get.status,
    list_output_sha256: list.output_sha256,
    get_output_sha256: get.output_sha256,
  });
}

function normalizedLimits(input = {}) {
  const limits = { ...DEFAULT_LIMITS, ...input };
  if (!Number.isSafeInteger(limits.fileBytes) || limits.fileBytes <= 0
    || !Number.isSafeInteger(limits.aggregateBytes) || limits.aggregateBytes < limits.fileBytes
    || !Number.isSafeInteger(limits.pluginRecords) || limits.pluginRecords <= 0) {
    fail('Claude inspection limits are invalid', 'INVALID_INSPECTION_LIMIT');
  }
  return Object.freeze(limits);
}

function missing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

async function readConfigFile(fsImpl, captureFingerprint, entry, tracker, limits) {
  return readBoundedConfigFile({
    fsImpl,
    captureFingerprint,
    entry,
    tracker,
    limits,
    parseBytes: bytes => parseJsoncDocument(bytes, { pathLabel: `${entry.scope} Claude config`, maxBytes: limits.fileBytes }),
  });
}

function physicalEvidence(entry) {
  if (!plainObject(entry)) return null;
  return {
    ...(Object.hasOwn(entry, 'type') ? { type: entry.type } : {}),
    ...(Object.hasOwn(entry, 'command') ? { command_sha256: sha256Canonical(entry.command) } : {}),
    ...(Object.hasOwn(entry, 'args') ? {
      args_count: Array.isArray(entry.args) ? entry.args.length : null,
      args_sha256: sha256Canonical(entry.args),
    } : {}),
  };
}

function physicalMatches(current, desired) {
  return plainObject(current)
    && current.type === desired.type
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

function reviewActions(entry) {
  const actions = [];
  const keys = Object.keys(plainObject(entry?.env) ? entry.env : {});
  if (keys.some(isSensitiveClientEnvironmentName)) actions.push('CUSTOM_ENV_REVIEW_REQUIRED');
  if (entry?.cwd !== undefined && entry.cwd !== null) actions.push('CUSTOM_LAUNCH_REVIEW_REQUIRED');
  return actions;
}

function actualProjectKey(projects, workspaceRoot) {
  if (!plainObject(projects)) return null;
  const wanted = pathIdentity(workspaceRoot);
  const matches = Object.keys(projects).filter(key => absolutePath(key) && pathIdentity(key) === wanted);
  if (matches.length > 1) fail('Claude local state contains ambiguous project path aliases', 'MALFORMED_CONFIG');
  return matches[0] ?? null;
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

async function occurrence({ scope, source, entry, jsonPath, desired, ledger, pluginId = null, deletableAfterMigration = false }) {
  if (entry === undefined) return null;
  if (!plainObject(entry)) fail('Claude MCP entry must be an object', 'MALFORMED_CONFIG');
  if (Object.hasOwn(entry, 'cwd') && entry.cwd !== null && (typeof entry.cwd !== 'string' || entry.cwd.trim() === '')) {
    fail('Claude cwd field must be a non-empty string or null', 'MALFORMED_CONFIG');
  }
  if (Object.hasOwn(entry, 'env') && (!plainObject(entry.env) || Object.values(entry.env).some(value => typeof value !== 'string'))) {
    fail('Claude environment field must contain string values', 'MALFORMED_CONFIG');
  }
  const locationInput = { clientId: 'claude', configPath: source.path, scope, entryName: 'uemcp' };
  const ownership = ['user', 'local', 'project'].includes(scope)
    ? await inspectOwnership({ ledger, currentEntry: entry, desiredEntry: desired, location: locationInput })
    : null;
  const result = Object.freeze({
    scope,
    path_label: source.scope,
    path: source.path,
    allowed_root: source.allowed_root,
    json_path: Object.freeze([...jsonPath]),
    matching: physicalMatches(entry, desired),
    physical_entry: Object.freeze(physicalEvidence(entry) ?? {}),
    entry_sha256: sha256Canonical(entry),
    config_sha256: sha256Bytes(source.bytes),
    environment: Object.freeze(environmentEvidence(entry)),
    custom_launch: entry.cwd !== undefined && entry.cwd !== null,
    review_actions: Object.freeze(reviewActions(entry)),
    ownership: safeOwnershipEvidence(ownership),
    plugin_id: pluginId,
    deletable_after_migration: deletableAfterMigration,
  });
  PRIVATE_PROTOCOL_LAUNCH.set(result, Object.freeze({
    env_overlay: Object.freeze({ ...(plainObject(entry.env) ? entry.env : {}) }),
    cwd: typeof entry.cwd === 'string' ? entry.cwd : null,
  }));
  return result;
}

function validateSettingsFile(file) {
  if (!file.exists) return;
  for (const key of ['enableAllProjectMcpServers', 'allowManagedMcpServersOnly']) {
    const value = settingValue(file, key);
    if (value !== undefined && typeof value !== 'boolean') fail(`Claude setting ${key} must be boolean`, 'MALFORMED_CONFIG');
  }
  for (const key of ['enabledMcpjsonServers', 'disabledMcpjsonServers']) {
    const value = settingValue(file, key);
    if (value !== undefined && (!Array.isArray(value) || !value.every(item => typeof item === 'string'))) {
      fail(`Claude setting ${key} must be a string array`, 'MALFORMED_CONFIG');
    }
  }
  for (const key of ['allowedMcpServers', 'deniedMcpServers']) {
    const value = settingValue(file, key);
    if (value === undefined) continue;
    if (!Array.isArray(value) || !value.every(item => {
      if (!plainObject(item) || Object.keys(item).length !== 1) return false;
      if (Object.hasOwn(item, 'serverName')) return typeof item.serverName === 'string' && item.serverName !== '';
      if (Object.hasOwn(item, 'serverUrl')) return typeof item.serverUrl === 'string' && item.serverUrl !== '';
      if (Object.hasOwn(item, 'serverCommand')) {
        return Array.isArray(item.serverCommand)
          && item.serverCommand.length > 0
          && item.serverCommand.every(part => typeof part === 'string');
      }
      return false;
    })) fail(`Claude setting ${key} has an invalid filter`, 'MALFORMED_CONFIG');
  }
  const enabledPlugins = settingValue(file, 'enabledPlugins');
  if (enabledPlugins !== undefined
    && (!plainObject(enabledPlugins) || Object.values(enabledPlugins).some(value => typeof value !== 'boolean'))) {
    fail('Claude enabledPlugins setting must be a boolean map', 'MALFORMED_CONFIG');
  }
}

function settingValue(file, key) {
  return file.exists ? getJsoncValue(file.document, [key]) : undefined;
}

function includesName(value, name = 'uemcp') {
  return Array.isArray(value) && value.some(item => item === name);
}

function validWorkspaceSetting(workspaceTrusted, file) {
  if (file.scope === 'user_settings' || file.scope === 'managed_settings') return true;
  if (!workspaceTrusted) return false;
  return file.scope === 'project_settings' || file.scope === 'local_settings';
}

function filterEntryMatches(filter, desired) {
  if (!plainObject(filter) || Object.keys(filter).length !== 1) return false;
  if (filter.serverName !== undefined) return filter.serverName === 'uemcp';
  if (filter.serverCommand !== undefined) {
    return Array.isArray(filter.serverCommand)
      && JSON.stringify(filter.serverCommand) === JSON.stringify([desired.command, ...desired.args]);
  }
  return false;
}

function classifyPolicy(workspaceTrusted, settings, desired) {
  const valid = settings.filter(file => file.exists && validWorkspaceSetting(workspaceTrusted, file));
  const managed = settings.find(file => file.scope === 'managed_settings');
  const managedOnly = managed?.exists && settingValue(managed, 'allowManagedMcpServersOnly') === true;
  const denied = valid.flatMap(file => settingValue(file, 'deniedMcpServers') ?? []);
  if (denied.some(filter => filterEntryMatches(filter, desired))) return { status: 'POLICY_BLOCKED', reason: 'DENIED' };

  const allowSources = managedOnly ? valid.filter(file => file.scope === 'managed_settings') : valid;
  const allowDeclarations = allowSources.filter(file => settingValue(file, 'allowedMcpServers') !== undefined);
  if (allowDeclarations.length === 0) return { status: 'ALLOWED', reason: null };
  const allowed = allowDeclarations.flatMap(file => settingValue(file, 'allowedMcpServers'));
  const commandRules = allowed.filter(filter => plainObject(filter) && Object.hasOwn(filter, 'serverCommand'));
  const candidates = commandRules.length > 0
    ? commandRules
    : allowed.filter(filter => plainObject(filter) && Object.hasOwn(filter, 'serverName'));
  return candidates.some(filter => filterEntryMatches(filter, desired))
    ? { status: 'ALLOWED', reason: null }
    : { status: 'POLICY_BLOCKED', reason: 'NOT_ALLOWED' };
}

function classifyApproval(workspaceTrusted, settings) {
  const disabled = settings.some(file => file.exists && includesName(settingValue(file, 'disabledMcpjsonServers')));
  const projectApprovalPresent = settings.some(file => file.exists
    && ['project_settings', 'local_settings'].includes(file.scope)
    && (settingValue(file, 'enableAllProjectMcpServers') === true || includesName(settingValue(file, 'enabledMcpjsonServers'))));
  const approved = settings.some(file => file.exists
    && validWorkspaceSetting(workspaceTrusted, file)
    && (settingValue(file, 'enableAllProjectMcpServers') === true || includesName(settingValue(file, 'enabledMcpjsonServers'))));
  return { disabled, approved, projectApprovalPresent };
}

function workspaceTrustFromState(state, workspaceRoot) {
  if (!state.exists) return Object.freeze({ trusted: false, source: 'user_state', project_key: null });
  const projects = getJsoncValue(state.document, ['projects']);
  if (projects !== undefined && !plainObject(projects)) fail('Claude projects state must be an object', 'MALFORMED_CONFIG');
  const projectKey = actualProjectKey(projects, workspaceRoot);
  if (projectKey === null) return Object.freeze({ trusted: false, source: 'user_state', project_key: null });
  const project = projects[projectKey];
  if (!plainObject(project)) fail('Claude project state must be an object', 'MALFORMED_CONFIG');
  const accepted = project.hasTrustDialogAccepted;
  if (accepted !== undefined && typeof accepted !== 'boolean') {
    fail('Claude project trust state must be boolean', 'MALFORMED_CONFIG');
  }
  return Object.freeze({ trusted: accepted === true, source: 'user_state', project_key: projectKey });
}

function pluginEnabled(settings, workspaceTrusted, pluginId, defaultEnabled) {
  let enabled = defaultEnabled;
  for (const file of settings) {
    if (!file.exists || !validWorkspaceSetting(workspaceTrusted, file)) continue;
    const configured = settingValue(file, 'enabledPlugins');
    if (plainObject(configured) && Object.hasOwn(configured, pluginId)) enabled = configured[pluginId];
  }
  return enabled;
}

function replacePluginRoot(value, pluginRoot) {
  return typeof value === 'string' ? value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot) : value;
}

function resolvePluginEntry(entry, pluginRoot) {
  if (!plainObject(entry)) return entry;
  return Object.fromEntries(Object.entries(entry).map(([key, value]) => {
    if (typeof value === 'string') return [key, replacePluginRoot(value, pluginRoot)];
    if (Array.isArray(value)) return [key, value.map(item => replacePluginRoot(item, pluginRoot))];
    if (key === 'env' && plainObject(value)) {
      return [key, Object.fromEntries(Object.entries(value).map(([name, item]) => [name, replacePluginRoot(item, pluginRoot)]))];
    }
    return [key, value];
  }));
}

function pluginServers(document, label) {
  const root = document.parsed_value;
  if (!plainObject(root)) fail(`${label} must contain an object`, 'MALFORMED_CONFIG');
  const servers = Object.hasOwn(root, 'mcpServers') ? root.mcpServers : root;
  if (!plainObject(servers)) fail(`${label} MCP declaration must be an object`, 'MALFORMED_CONFIG');
  return servers;
}

async function inspectInstalledPlugins({ fsImpl, captureFingerprint, locations, registry, settings, workspaceTrusted, tracker, limits }) {
  if (!registry.exists) return { rows: [], files: [] };
  const root = registry.document.parsed_value;
  if (!plainObject(root) || root.version !== 2 || !plainObject(root.plugins)) {
    fail('Claude installed plugin registry is invalid', 'MALFORMED_CONFIG');
  }
  const records = Object.entries(root.plugins).flatMap(([pluginId, value]) => {
    if (typeof pluginId !== 'string' || pluginId === '' || !Array.isArray(value)) {
      fail('Claude installed plugin records are invalid', 'MALFORMED_CONFIG');
    }
    return value.map(record => ({ pluginId, record }));
  });
  if (records.length > limits.pluginRecords) fail('Claude plugin evidence exceeds its record limit', 'INSPECTION_LIMIT_EXCEEDED');

  const files = [];
  const rows = [];
  for (const { pluginId, record } of records) {
    if (!plainObject(record) || !absolutePath(record.installPath)) fail('Claude plugin install record is invalid', 'MALFORMED_CONFIG');
    const pluginRoot = resolve(record.installPath);
    if (!contained(locations.plugins_cache.path, pluginRoot)) fail('Claude plugin install path escapes its cache', 'UNSAFE_CONFIG_PATH');
    const rootDeclaration = await readConfigFile(fsImpl, captureFingerprint,
      location(join(pluginRoot, '.mcp.json'), pluginRoot, `plugin_mcp:${pluginId}`), tracker, limits);
    const manifest = await readConfigFile(fsImpl, captureFingerprint,
      location(join(pluginRoot, '.claude-plugin', 'plugin.json'), pluginRoot, `plugin_manifest:${pluginId}`), tracker, limits);
    files.push(rootDeclaration, manifest);

    let defaultEnabled = true;
    let manifestDeclaration = null;
    if (manifest.exists) {
      const manifestRoot = manifest.document.parsed_value;
      if (!plainObject(manifestRoot)) fail('Claude plugin manifest must contain an object', 'MALFORMED_CONFIG');
      if (Object.hasOwn(manifestRoot, 'defaultEnabled')) {
        if (typeof manifestRoot.defaultEnabled !== 'boolean') fail('Claude plugin defaultEnabled must be boolean', 'MALFORMED_CONFIG');
        defaultEnabled = manifestRoot.defaultEnabled;
      }
      if (Object.hasOwn(manifestRoot, 'mcpServers')) {
        if (typeof manifestRoot.mcpServers === 'string') {
          if (manifestRoot.mcpServers.trim() === '' || isAbsolute(manifestRoot.mcpServers) || win32.isAbsolute(manifestRoot.mcpServers)) {
            fail('Claude plugin MCP path must be relative', 'MALFORMED_CONFIG');
          }
          const declarationPath = resolve(pluginRoot, manifestRoot.mcpServers);
          if (!contained(pluginRoot, declarationPath)) fail('Claude plugin MCP path escapes its root', 'UNSAFE_CONFIG_PATH');
          const referenced = await readConfigFile(fsImpl, captureFingerprint,
            location(declarationPath, pluginRoot, `plugin_mcp_reference:${pluginId}`), tracker, limits);
          files.push(referenced);
          if (!referenced.exists) fail('Claude plugin MCP declaration is missing', 'MALFORMED_CONFIG');
          manifestDeclaration = { source: referenced, servers: pluginServers(referenced.document, 'Claude plugin MCP file') };
        } else if (plainObject(manifestRoot.mcpServers)) {
          manifestDeclaration = { source: manifest, servers: manifestRoot.mcpServers };
        } else {
          fail('Claude plugin mcpServers declaration is invalid', 'MALFORMED_CONFIG');
        }
      }
    }
    if (rootDeclaration.exists && manifestDeclaration) fail('Claude plugin has ambiguous MCP declarations', 'MALFORMED_CONFIG');
    const declaration = rootDeclaration.exists
      ? { source: rootDeclaration, servers: pluginServers(rootDeclaration.document, 'Claude plugin .mcp.json') }
      : manifestDeclaration;
    if (!declaration || !pluginEnabled(settings, workspaceTrusted, pluginId, defaultEnabled)) continue;
    if (Object.hasOwn(declaration.servers, 'uemcp')) {
      rows.push({
        plugin_id: pluginId,
        source: declaration.source,
        entry: resolvePluginEntry(declaration.servers.uemcp, pluginRoot),
      });
    }
  }
  return { rows, files };
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

function readOnlyRows(files, writablePaths = new Set()) {
  return files
    .filter(file => !writablePaths.has(pathIdentity(file.path)))
    .map(file => ({ path: file.path, allowed_root: file.allowed_root, fingerprint: file.fingerprint }));
}

function publicFileEvidence(file) {
  return Object.freeze({
    path: file.path,
    allowed_root: file.allowed_root,
    scope: file.scope,
    writable: file.writable,
    exists: file.exists,
    config_sha256: file.config_sha256 ?? (file.exists && file.bytes ? sha256Bytes(file.bytes) : null),
    fingerprint: file.fingerprint,
  });
}

async function captureLaunchEvidence(captureFingerprint, context, detection) {
  const candidates = [
    ['client_launch_command', detection.launch.command],
    ...detection.launch.args_prefix.map((path, index) => [`client_launch_arg_${index}`, path]),
    ['server_launch_command', context.descriptor.command],
    ...context.descriptor.args
      .filter(absolutePath)
      .map((path, index) => [`server_launch_arg_${index}`, path]),
  ];
  const seen = new Set();
  const rows = [];
  for (const [scope, path] of candidates) {
    const key = pathIdentity(path);
    if (seen.has(key)) continue;
    seen.add(key);
    const fingerprint = await captureFingerprint(path, { allowedRoots: [dirname(path)], writable: false });
    if (!fingerprint.exists || fingerprint.kind !== 'file' || fingerprint.link_kind !== 'none') {
      fail('Claude launch evidence is no longer a regular file', 'CLIENT_LAUNCH_EVIDENCE_INVALID');
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

function operationCommon({ id, type, occurrence: current, source, context, readOnly, ownedPaths }) {
  return {
    operation_id: id,
    client_id: 'claude',
    selected: true,
    write_supported: true,
    type,
    path: source.path,
    allowed_root: source.allowed_root,
    scope_kind: source.scope === 'project' ? 'project' : 'user',
    fingerprint: source.fingerprint,
    current_config_sha256: source.config_sha256,
    current_entry_sha256: current?.entry_sha256 ?? null,
    owned_paths: ownedPaths,
    shared_resource_id: null,
    plan_digest: context.planDigest,
    read_only_paths: readOnly,
  };
}

async function writableFileEvidence(captureFingerprint, file) {
  const fingerprint = await captureFingerprint(file.path, {
    allowedRoots: [file.allowed_root],
    writable: true,
  });
  return { ...file, fingerprint };
}

function planningFailure(error) {
  if (['READ_ONLY_TARGET', 'UNSAFE_WRITABLE_PATH', 'PATH_OUTSIDE_WRITABLE_ROOT', 'METADATA_INSPECTION_FAILED'].includes(error?.code)) {
    return error.code;
  }
  throw error;
}

function semanticallyEmptyProject(document) {
  const root = document.parsed_value;
  if (!plainObject(root)) return false;
  return Object.entries(root).every(([key, value]) => key === 'mcpServers' && plainObject(value) && Object.keys(value).length === 0);
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
  if (configHash !== operation.current_config_sha256) fail('Claude config changed after planning', 'TRANSACTION_PRECONDITION_CHANGED');
  const entryHash = entry === undefined ? null : sha256Canonical(entry);
  if (entryHash !== operation.current_entry_sha256) fail('Claude entry changed after planning', 'TRANSACTION_PRECONDITION_CHANGED');
}

function applyOwnedFields(document, jsonPath, desired, replaceWhole) {
  if (replaceWhole) return setJsoncValue(document, jsonPath, desired);
  return setJsoncValues(document, ['type', 'command', 'args'].map(key => ({
    path: [...jsonPath, key],
    value: desired[key],
  })));
}

function resultStatus(native, operationStatus) {
  if (native.status === 'CONNECTED') return operationStatus === 'CLIENT_ENABLEMENT_REQUIRED' ? 'CLIENT_ENABLEMENT_REQUIRED' : 'READY';
  if (native.status === 'PENDING_APPROVAL') return 'PENDING_APPROVAL';
  if (native.status === 'REJECTED') return 'CLIENT_ENABLEMENT_REQUIRED';
  if (['TIMEOUT', 'FAILED', 'UNKNOWN', 'ABSENT'].includes(native.status)) return 'POLICY_UNKNOWN';
  return operationStatus ?? 'READY';
}

export function createClaudeAdapter({
  fsImpl = defaultFs,
  runner = createProcessRunner(),
  captureFingerprint = captureClientPathFingerprint,
  limits: limitOverrides = {},
} = {}) {
  const limits = normalizedLimits(limitOverrides);

  async function detect(context) {
    if (context?.launch?.client_id !== 'claude') fail('Claude launch evidence is missing', 'INVALID_CLIENT_LAUNCH');
    validateClientLaunchContract(context.launch);
    return Object.freeze({
      client_id: 'claude',
      version: context.launch.version,
      write_supported: context.launch.write_supported === true,
      compatibility: context.launch.compatibility,
      launch: context.launch,
      locations: resolveClaudeLocations(context),
    });
  }

  async function inspect(context, detection) {
    if (detection?.client_id !== 'claude') fail('Claude detection is invalid', 'INVALID_CLIENT_DETECTION');
    const desired = physicalClaudeEntry(context.descriptor);
    const tracker = { total: 0 };
    const sourceFiles = [];
    try {
      for (const key of ['state', 'project_config', 'user_settings', 'project_settings', 'local_settings', 'managed_config', 'managed_settings', 'plugins_registry']) {
        sourceFiles.push(await readConfigFile(fsImpl, captureFingerprint, detection.locations[key], tracker, limits));
      }
      const launchEvidence = await captureLaunchEvidence(captureFingerprint, context, detection);
      const byScope = Object.fromEntries(sourceFiles.map(file => [file.scope, file]));
      const state = byScope.user;
      const project = byScope.project;
      const managed = byScope.managed;
      const pluginsRegistry = byScope.plugins_registry;
      const settings = sourceFiles.filter(file => file.scope.endsWith('settings'));
      for (const settingsFile of settings) validateSettingsFile(settingsFile);
      const workspaceTrust = workspaceTrustFromState(state, context.workspaceRoot);
      const ledgerProbe = await inspectOwnership({
        ledger: context.ownershipLedger,
        currentEntry: desired,
        desiredEntry: desired,
        location: { clientId: 'claude', configPath: state.path, scope: 'user', entryName: 'uemcp' },
      });
      const ownershipLedger = ledgerProbe.state === 'stale_record' && ledgerProbe.stale_reason !== 'record_identity_mismatch'
        ? Object.freeze({ status: 'INVALID', reason: ledgerProbe.stale_reason })
        : Object.freeze({ status: 'READY', reason: null });
      const occurrences = [];
      const projectKey = workspaceTrust.project_key;
      if (projectKey !== null) {
        const current = await occurrence({
          scope: 'local',
          source: state,
          entry: getJsoncValue(state.document, ['projects', projectKey, 'mcpServers', 'uemcp']),
          jsonPath: ['projects', projectKey, 'mcpServers', 'uemcp'],
          desired,
          ledger: context.ownershipLedger,
        });
        if (current) occurrences.push(current);
      }
      if (project.exists) {
        const projectEntry = getJsoncValue(project.document, ['mcpServers', 'uemcp']);
        let deletableAfterMigration = false;
        if (projectEntry !== undefined) {
          const removed = removeJsoncValue(project.document, ['mcpServers', 'uemcp']);
          deletableAfterMigration = removed.changed
            && semanticallyEmptyProject(parseJsoncDocument(removed.after_bytes, { pathLabel: 'Claude project migration preview' }));
        }
        const current = await occurrence({
          scope: 'project',
          source: project,
          entry: projectEntry,
          jsonPath: ['mcpServers', 'uemcp'],
          desired,
          ledger: context.ownershipLedger,
          deletableAfterMigration,
        });
        if (current) occurrences.push(current);
      }
      if (state.exists) {
        const current = await occurrence({
          scope: 'user',
          source: state,
          entry: getJsoncValue(state.document, ['mcpServers', 'uemcp']),
          jsonPath: ['mcpServers', 'uemcp'],
          desired,
          ledger: context.ownershipLedger,
        });
        if (current) occurrences.push(current);
      }

      const plugins = await inspectInstalledPlugins({
        fsImpl,
        captureFingerprint,
        locations: detection.locations,
        registry: pluginsRegistry,
        settings,
        workspaceTrusted: workspaceTrust.trusted,
        tracker,
        limits,
      });
      sourceFiles.push(...plugins.files);
      for (const plugin of plugins.rows) {
        const current = await occurrence({
          scope: 'plugin',
          source: plugin.source,
          entry: plugin.entry,
          jsonPath: ['mcpServers', 'uemcp'],
          desired,
          ledger: context.ownershipLedger,
          pluginId: plugin.plugin_id,
        });
        occurrences.push(current);
      }

      let managedOccurrence = null;
      if (managed.exists) {
        managedOccurrence = await occurrence({
          scope: 'managed',
          source: managed,
          entry: getJsoncValue(managed.document, ['mcpServers', 'uemcp']),
          jsonPath: ['mcpServers', 'uemcp'],
          desired,
          ledger: context.ownershipLedger,
        });
        if (managedOccurrence) occurrences.unshift(managedOccurrence);
      }

      const effective = managed.exists ? managedOccurrence : occurrences.find(row => row.scope !== 'managed') ?? null;
      const policy = classifyPolicy(workspaceTrust.trusted, settings, desired);
      const approval = classifyApproval(workspaceTrust.trusted, settings);
      let registration;
      if (managed.exists && !managedOccurrence) registration = 'POLICY_BLOCKED';
      else if (!effective) registration = 'ABSENT';
      else registration = effective.matching ? 'CONFIGURED' : 'CONFLICT';

      let enablement = 'UNKNOWN';
      let activation = 'UNKNOWN';
      if (managed.exists && !managedOccurrence) enablement = 'POLICY_BLOCKED';
      else if (policy.status === 'POLICY_BLOCKED') enablement = 'POLICY_BLOCKED';
      else if (effective?.scope === 'project') {
        if (approval.disabled) enablement = 'DISABLED';
        else if (approval.approved) enablement = 'ENABLED';
        else {
          enablement = 'UNKNOWN';
          activation = !workspaceTrust.trusted && approval.projectApprovalPresent ? 'PENDING_TRUST' : 'PENDING_APPROVAL';
        }
      } else if (effective) enablement = policy.status === 'POLICY_UNKNOWN' ? 'POLICY_UNKNOWN' : 'ENABLED';

      const native = await inspectNative(runner, context, detection);
      if (native.status === 'CONNECTED') activation = 'CONNECTED';
      else if (native.status === 'PENDING_APPROVAL') activation = 'PENDING_APPROVAL';
      else if (native.status === 'REJECTED') activation = 'REJECTED';
      const disagrees = (native.status === 'CONNECTED' && enablement !== 'ENABLED')
        || (native.status === 'REJECTED' && enablement === 'ENABLED')
        || (native.status === 'PENDING_APPROVAL' && enablement === 'ENABLED')
        || (native.status === 'ABSENT' && registration === 'CONFIGURED');
      const actions = occurrences.flatMap(row => row.review_actions);
      if (['DISABLED', 'POLICY_BLOCKED'].includes(enablement)) actions.push('CLIENT_ENABLEMENT_REQUIRED');
      if (native.status === 'REJECTED') actions.push('CLIENT_ENABLEMENT_REQUIRED');
      if (activation === 'PENDING_TRUST') actions.push('PENDING_TRUST');
      if (activation === 'PENDING_APPROVAL') actions.push('PENDING_APPROVAL');
      if (policy.status === 'POLICY_UNKNOWN') actions.push('POLICY_UNKNOWN');
      if (registration === 'CONFLICT') actions.push('CONFLICT');
      const safeEffective = effective ? Object.freeze({
        scope: effective.scope,
        path_label: effective.path_label,
        path: effective.path,
        matching: effective.matching,
      }) : null;
      return Object.freeze({
        client_id: 'claude',
        registration,
        enablement,
        activation,
        policy: policy.status,
        actions: Object.freeze(unique(actions)),
        occurrences: Object.freeze(occurrences),
        effective: safeEffective,
        native: Object.freeze({ ...native, disagrees_with_structural_policy: disagrees }),
        workspace_trust: workspaceTrust,
        files: Object.freeze([...sourceFiles.map(publicFileEvidence), ...launchEvidence]),
        ownership_ledger: ownershipLedger,
        desired,
      });
    } catch (error) {
      const status = statusFromError(error);
      return Object.freeze({
        client_id: 'claude',
        registration: status,
        enablement: 'UNKNOWN',
        activation: 'UNKNOWN',
        policy: 'POLICY_UNKNOWN',
        actions: Object.freeze([status]),
        occurrences: Object.freeze([]),
        effective: null,
        native: Object.freeze({ status: 'NOT_CHECKED', disagrees_with_structural_policy: false }),
        workspace_trust: Object.freeze({ trusted: false, source: 'unknown', project_key: null }),
        files: Object.freeze([]),
        ownership_ledger: Object.freeze({ status: 'UNKNOWN', reason: null }),
        desired,
      });
    }
  }

  async function plan(context, inspection, descriptor) {
    if (inspection?.client_id !== 'claude') fail('Claude inspection is invalid', 'INVALID_CLIENT_INSPECTION');
    if (typeof context.planDigest !== 'string' || !/^[0-9a-f]{64}$/.test(context.planDigest)) fail('Claude plan digest is invalid', 'INVALID_PLAN_DIGEST');
    const desired = physicalClaudeEntry(descriptor);
    if (['MALFORMED_CONFIG', 'INSPECTION_LIMIT_EXCEEDED', 'UNSAFE_CONFIG_PATH'].includes(inspection.registration)) {
      return Object.freeze({ client_id: 'claude', status: inspection.registration, operations: Object.freeze([]), actions: inspection.actions });
    }
    if (!context.launch.write_supported) {
      return Object.freeze({ client_id: 'claude', status: 'UNSUPPORTED_VERSION', operations: Object.freeze([]), actions: Object.freeze(['UNSUPPORTED_VERSION']) });
    }
    const files = Object.fromEntries(inspection.files.map(file => [file.scope, file]));
    const managedPresent = files.managed?.exists === true;
    if (managedPresent) {
      return Object.freeze({
        client_id: 'claude',
        status: inspection.registration === 'POLICY_BLOCKED' ? 'POLICY_BLOCKED' : 'NO_OP',
        operations: Object.freeze([]),
        actions: inspection.actions,
      });
    }

    const local = inspection.occurrences.find(row => row.scope === 'local');
    const project = inspection.occurrences.find(row => row.scope === 'project');
    const user = inspection.occurrences.find(row => row.scope === 'user');
    const plugin = inspection.occurrences.find(row => row.scope === 'plugin');
    const migrate = clientDecision(context, 'migrate_legacy_claude_project') && project && !local;
    if (inspection.ownership_ledger?.status === 'INVALID') {
      return Object.freeze({
        client_id: 'claude',
        status: 'OWNERSHIP_LEDGER_INVALID',
        operations: Object.freeze([]),
        actions: Object.freeze(unique([...inspection.actions, 'OWNERSHIP_LEDGER_INVALID'])),
      });
    }
    if (local) {
      return Object.freeze({
        client_id: 'claude',
        status: local.matching ? 'NO_OP' : 'CONFLICT',
        operations: Object.freeze([]),
        actions: Object.freeze(unique([...inspection.actions, local.matching ? 'SHADOWED' : 'CONFLICT'])),
      });
    }
    if (project && !migrate) {
      return Object.freeze({
        client_id: 'claude',
        status: project.matching ? 'NO_OP' : 'CONFLICT',
        operations: Object.freeze([]),
        actions: Object.freeze(unique([...inspection.actions, project.matching ? 'SHADOWED' : 'CONFLICT'])),
      });
    }
    if (!project && plugin) {
      return Object.freeze({
        client_id: 'claude',
        status: plugin.matching ? 'NO_OP' : 'CONFLICT',
        operations: Object.freeze([]),
        actions: Object.freeze(unique([...inspection.actions, plugin.matching ? 'SHADOWED' : 'CONFLICT'])),
      });
    }

    let userOperationType = null;
    if (!user) userOperationType = 'CREATE_ENTRY';
    else if (user.matching && user.ownership?.recommended_action === 'ADOPT_EXACT_ENTRY') userOperationType = 'ADOPT_EXACT_ENTRY';
    else if (!user.matching && (user.ownership?.state === 'owned_matching' || approvedOwnedReplacement(context, user.ownership))) userOperationType = 'UPDATE_OWNED_FIELDS';
    else if (!user.matching) {
      return Object.freeze({ client_id: 'claude', status: 'CONFLICT', operations: Object.freeze([]), actions: Object.freeze(unique([...inspection.actions, 'CONFLICT'])) });
    }

    const prospectiveWritable = new Set();
    if (migrate) prospectiveWritable.add(pathIdentity(files.project.path));
    if (['CREATE_ENTRY', 'UPDATE_OWNED_FIELDS'].includes(userOperationType)) prospectiveWritable.add(pathIdentity(files.user.path));
    const readOnly = readOnlyRows(inspection.files, prospectiveWritable);
    const writableFiles = { ...files };
    try {
      if (migrate) writableFiles.project = await writableFileEvidence(captureFingerprint, files.project);
      if (['CREATE_ENTRY', 'UPDATE_OWNED_FIELDS'].includes(userOperationType)) {
        writableFiles.user = await writableFileEvidence(captureFingerprint, files.user);
      }
    } catch (error) {
      const status = planningFailure(error);
      return Object.freeze({ client_id: 'claude', status, operations: Object.freeze([]), actions: Object.freeze(unique([...inspection.actions, status])) });
    }
    const operations = [];
    if (migrate) {
      const deleteAfterVerify = false;
      operations.push(Object.freeze({
        ...operationCommon({
          id: 'claude-migrate-project-uemcp',
          type: 'MIGRATE_PROJECT_ENTRY',
          occurrence: project,
          source: writableFiles.project,
          context,
          readOnly,
          ownedPaths: ['/mcpServers/uemcp'],
        }),
        json_path: project.json_path,
        installer_created_file: false,
        delete_after_verify: deleteAfterVerify,
      }));
    }

    if (userOperationType === 'CREATE_ENTRY') {
      operations.push(Object.freeze({
        ...operationCommon({
          id: 'claude-create-user-uemcp',
          type: 'CREATE_ENTRY',
          occurrence: null,
          source: writableFiles.user,
          context,
          readOnly,
          ownedPaths: ['/type', '/command', '/args'],
        }),
        json_path: ['mcpServers', 'uemcp'],
        desired_entry: desired,
        verification_status: inspection.actions.includes('POLICY_UNKNOWN') ? 'POLICY_UNKNOWN' : null,
      }));
    } else if (userOperationType === 'ADOPT_EXACT_ENTRY') {
        const locationInput = { clientId: 'claude', configPath: user.path, scope: 'user', entryName: 'uemcp' };
        operations.push(Object.freeze({
          ...operationCommon({
            id: 'claude-adopt-user-uemcp',
            type: 'ADOPT_EXACT_ENTRY',
            occurrence: user,
            source: files.user,
            context,
            readOnly,
            ownedPaths: ['/type', '/command', '/args'],
          }),
          ledger_only: true,
          json_path: user.json_path,
          desired_entry: desired,
          adoption: Object.freeze({
            operation_id: 'claude-adopt-user-uemcp',
            type: 'ADOPT_EXACT_ENTRY',
            ownership_key: ownershipKey(locationInput),
            current_entry_sha256: user.entry_sha256,
            current_config_sha256: user.config_sha256,
            plan_digest: context.planDigest,
          }),
        }));
    } else if (userOperationType === 'UPDATE_OWNED_FIELDS') {
      operations.push(Object.freeze({
        ...operationCommon({
          id: 'claude-update-user-uemcp',
          type: 'UPDATE_OWNED_FIELDS',
          occurrence: user,
          source: writableFiles.user,
          context,
          readOnly,
          ownedPaths: ['/type', '/command', '/args'],
        }),
        json_path: user.json_path,
        desired_entry: desired,
        explicit_owned_replacement: approvedOwnedReplacement(context, user.ownership),
      }));
    }

    let status = 'NO_OP';
    if (migrate) status = 'MIGRATE';
    else if (operations.some(row => row.type === 'CREATE_ENTRY')) status = 'CREATE';
    else if (operations.some(row => row.type === 'ADOPT_EXACT_ENTRY')) status = 'ADOPT';
    else if (operations.some(row => row.type === 'UPDATE_OWNED_FIELDS')) status = 'UPDATE';
    return Object.freeze({ client_id: 'claude', status, operations: Object.freeze(operations), actions: inspection.actions });
  }

  async function snapshot(context, operations) {
    const writable = new Map();
    const readOnly = new Map();
    for (const operation of operations) {
      const key = pathIdentity(operation.path);
      if (operation.ledger_only !== true && !writable.has(key)) {
        writable.set(key, {
          path: operation.path,
          allowed_root: operation.allowed_root,
          scope_kind: operation.scope_kind,
          fingerprint: operation.fingerprint,
          owned_paths: operation.owned_paths,
          shared_resource_id: operation.shared_resource_id,
        });
      }
      if (operation.ledger_only === true) {
        readOnly.set(key, {
          path: operation.path,
          allowed_root: operation.allowed_root,
          fingerprint: operation.fingerprint,
        });
      }
      for (const row of operation.read_only_paths ?? []) {
        const rowKey = pathIdentity(row.path);
        if (!writable.has(rowKey)) readOnly.set(rowKey, row);
      }
    }
    return Object.freeze({ writable_paths: [...writable.values()], read_only_paths: [...readOnly.values()] });
  }

  async function apply(context, operations) {
    if (!context.transaction?.writeFile || !context.transaction?.ownershipLedger) fail('Claude apply requires the transaction capability', 'INVALID_TRANSACTION_CAPABILITY');
    const ordered = [...operations].sort((left, right) => {
      const rank = type => type === 'MIGRATE_PROJECT_ENTRY' ? 0 : type === 'ADOPT_EXACT_ENTRY' ? 1 : 2;
      return rank(left.type) - rank(right.type) || left.operation_id.localeCompare(right.operation_id);
    });
    for (const operation of ordered) {
      if (operation.client_id !== 'claude' || operation.write_supported !== true || operation.selected !== true) {
        fail('Claude apply received an unapproved operation', 'UNAPPROVED_OPERATION_SET');
      }
      if (operation.type === 'MIGRATE_PROJECT_ENTRY') {
        const current = await readCurrentDocument(fsImpl, operation.path, 'Claude project migration config');
        const entry = getJsoncValue(current.document, operation.json_path);
        assertOperationPrecondition(operation, current.bytes, entry);
        const edit = removeJsoncValue(current.document, operation.json_path);
        if (!edit.changed) fail('Claude migration target disappeared', 'TRANSACTION_PRECONDITION_CHANGED');
        const parsed = parseJsoncDocument(edit.after_bytes, { pathLabel: 'Claude migrated project config' });
        await context.transaction.writeFile(operation.path, edit.after_bytes, {
          parse: bytes => parseJsoncDocument(bytes, { pathLabel: 'Claude migrated project config' }),
        });
        if (operation.delete_after_verify && operation.installer_created_file && semanticallyEmptyProject(parsed)) {
          if (typeof context.transaction.deleteFileAfterVerify !== 'function') fail('Claude migration deletion requires a deferred transaction delete', 'INVALID_TRANSACTION_CAPABILITY');
          await context.transaction.deleteFileAfterVerify(operation.path);
        }
        continue;
      }

      const current = await readCurrentDocument(fsImpl, operation.path, 'Claude user config');
      const entry = getJsoncValue(current.document, operation.json_path);
      assertOperationPrecondition(operation, current.bytes, entry);
      if (operation.type === 'ADOPT_EXACT_ENTRY') {
        await adoptExactEntry({
          ledger: context.transaction.ownershipLedger,
          location: { clientId: 'claude', configPath: operation.path, scope: 'user', entryName: 'uemcp' },
          currentEntry: entry,
          desiredEntry: operation.desired_entry,
          approvedOperationId: operation.adoption,
          planDigest: context.planDigest,
        });
        continue;
      }
      if (!['CREATE_ENTRY', 'UPDATE_OWNED_FIELDS'].includes(operation.type)) fail('Claude operation type is unsupported', 'UNAPPROVED_OPERATION_SET');
      const edit = applyOwnedFields(current.document, operation.json_path, operation.desired_entry, operation.type === 'CREATE_ENTRY');
      const parsed = parseJsoncDocument(edit.after_bytes, { pathLabel: 'Claude updated user config' });
      const afterEntry = getJsoncValue(parsed, operation.json_path);
      const written = await context.transaction.writeFile(operation.path, edit.after_bytes, {
        parse: bytes => parseJsoncDocument(bytes, { pathLabel: 'Claude updated user config' }),
      });
      await recordOwnedWrite({
        ledger: context.transaction.ownershipLedger,
        location: { clientId: 'claude', configPath: operation.path, scope: 'user', entryName: 'uemcp' },
        beforeEntry: entry ?? null,
        afterEntry,
        ownedPaths: ownedPathsForClient('claude', afterEntry),
        appliedConfigHash: written.content_sha256,
        planDigest: context.planDigest,
      });
    }
    return Object.freeze({ status: operations.length === 0 ? 'NO_OP' : 'APPLIED' });
  }

  async function verify(context, operations) {
    for (const operation of operations) {
      const current = await readCurrentDocument(fsImpl, operation.path, 'Claude verification config');
      if (operation.type === 'MIGRATE_PROJECT_ENTRY') {
        if (getJsoncValue(current.document, operation.json_path) !== undefined) fail('Claude migration did not remove the project entry', 'STRUCTURAL_VERIFY_FAILED');
        continue;
      }
      const entry = getJsoncValue(current.document, operation.json_path);
      if (!physicalMatches(entry, operation.desired_entry)) fail('Claude user entry does not match the canonical descriptor', 'STRUCTURAL_VERIFY_FAILED');
    }
    const detection = await detect(context);
    const native = await inspectNative(runner, context, detection);
    const operationStatus = operations.find(row => row.verification_status)?.verification_status ?? null;
    return Object.freeze({ status: resultStatus(native, operationStatus), native });
  }

  function protocolLaunch(context, inspection) {
    const effective = inspection?.occurrences?.find(row => row.scope === inspection.effective?.scope
      && row.path === inspection.effective?.path);
    return PRIVATE_PROTOCOL_LAUNCH.get(effective) ?? Object.freeze({ env_overlay: Object.freeze({}), cwd: null });
  }

  async function rollback(context, records) {
    return Object.freeze({ status: 'delegated', count: records.length });
  }

  return Object.freeze({ id: 'claude', detect, inspect, plan, snapshot, apply, verify, protocolLaunch, rollback });
}
