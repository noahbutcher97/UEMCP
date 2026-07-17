import { win32 } from 'node:path';

const frozenVersions = versions => Object.freeze([...versions]);

export const CLIENT_IDS = Object.freeze(['claude', 'codex', 'gemini', 'vscode']);

export const NPM_RUNTIME_LIMITS = Object.freeze({
  max_entries: 32_768,
  max_files: 16_384,
  max_bytes: 1024 * 1024 * 1024,
});

export const RELEASE_GATES = Object.freeze({
  claude: Object.freeze({ versions: frozenVersions(['2.1.209', '2.1.210']) }),
  codex: Object.freeze({ versions: frozenVersions(['0.144.4']) }),
  gemini: Object.freeze({ versions: frozenVersions(['0.41.2']) }),
  vscode: Object.freeze({ versions: frozenVersions(['1.128.1']) }),
});

const PACKAGE_IDS = Object.freeze({
  claude: '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  gemini: '@google/gemini-cli',
  vscode: null,
});
const VSCODE_LAUNCH_OVERLAY = Object.freeze({ ELECTRON_RUN_AS_NODE: '1', VSCODE_DEV: '' });
const SENSITIVE_CLIENT_ENVIRONMENT_NAMES = new Set([
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
  'GEMINI_CLI_TRUSTED_FOLDERS_PATH',
  'GEMINI_CLI_TRUST_WORKSPACE',
]);

export function isSensitiveClientEnvironmentName(name) {
  if (typeof name !== 'string') return false;
  const normalized = name.toUpperCase();
  return normalized.startsWith('UEMCP_')
    || normalized.startsWith('UNREAL_')
    || SENSITIVE_CLIENT_ENVIRONMENT_NAMES.has(normalized);
}

export function expectedClientLaunchOverlay(clientId) {
  if (!CLIENT_IDS.includes(clientId)) invalid('client launch overlay requires a known client ID');
  return clientId === 'vscode'
    ? Object.freeze({ ...VSCODE_LAUNCH_OVERLAY })
    : Object.freeze({});
}

export class ClientContractError extends Error {
  constructor(message, code = 'INVALID_CLIENT_LAUNCH') {
    super(message);
    this.name = 'ClientContractError';
    this.code = code;
  }
}

function invalid(message) {
  throw new ClientContractError(message);
}

export function readWindowsEnvironmentValue(env, name) {
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || typeof name !== 'string' || name.trim() === '') {
    throw new ClientContractError('Windows environment lookup input is invalid', 'INVALID_CLIENT_ENVIRONMENT');
  }
  const normalizedName = name.toUpperCase();
  const matches = Object.entries(env).filter(([key, value]) => (
    key.toUpperCase() === normalizedName && value !== undefined && value !== null
  ));
  if (matches.length > 1) {
    throw new ClientContractError(`${normalizedName} has ambiguous case-variant definitions`, 'AMBIGUOUS_CLIENT_ENVIRONMENT');
  }
  return matches[0]?.[1];
}

export function mergeWindowsEnvironmentOverlay(env, overlay) {
  if (!env || typeof env !== 'object' || Array.isArray(env)
    || !overlay || typeof overlay !== 'object' || Array.isArray(overlay)) {
    throw new ClientContractError('Windows environment overlay input is invalid', 'INVALID_CLIENT_ENVIRONMENT');
  }
  const overlayNames = new Set();
  for (const key of Object.keys(overlay)) {
    const normalized = key.toUpperCase();
    if (overlayNames.has(normalized)) {
      throw new ClientContractError(`${normalized} has ambiguous overlay definitions`, 'AMBIGUOUS_CLIENT_ENVIRONMENT');
    }
    overlayNames.add(normalized);
  }
  return Object.fromEntries([
    ...Object.entries(env).filter(([key]) => !overlayNames.has(key.toUpperCase())),
    ...Object.entries(overlay),
  ]);
}

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value ?? '');
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

function compareVersions(left, right) {
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function classifySupportedVersion(clientId, version) {
  const gate = RELEASE_GATES[clientId];
  if (!gate) return 'known_unsupported';
  if (gate.versions.includes(version)) return 'release_gated';
  const parsed = parseVersion(version);
  if (!parsed) return 'known_unsupported';
  const newest = parseVersion(gate.versions.at(-1));
  return compareVersions(parsed, newest) > 0 ? 'unknown_newer' : 'known_unsupported';
}

function exactObject(value, expected) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const actualKeys = Object.keys(value).sort();
  const expectedKeys = Object.keys(expected).sort();
  return JSON.stringify(actualKeys) === JSON.stringify(expectedKeys)
    && expectedKeys.every(key => value[key] === expected[key]);
}

function isVsCodeCliTuple(command, cli) {
  const installRoot = win32.dirname(command);
  const relativeCli = win32.relative(installRoot, cli);
  const parts = relativeCli.split(win32.sep);
  return parts.length === 5
    && parts[0] !== ''
    && parts[0] !== '.'
    && parts[0] !== '..'
    && parts.slice(1).map(value => value.toLowerCase()).join('/') === 'resources/app/out/cli.js';
}

function validNpmRuntimeFingerprint(runtime, launch) {
  if (!runtime || Array.isArray(runtime) || typeof runtime !== 'object') return false;
  if (JSON.stringify(Object.keys(runtime).sort()) !== JSON.stringify([
    'entry_count',
    'file_count',
    'manifest_sha256',
    'max_bytes',
    'max_entries',
    'max_files',
    'root',
    'total_bytes',
  ])) return false;
  if (!win32.isAbsolute(runtime.root)
    || !/^[0-9a-f]{64}$/.test(runtime.manifest_sha256 ?? '')
    || runtime.max_entries !== NPM_RUNTIME_LIMITS.max_entries
    || runtime.max_files !== NPM_RUNTIME_LIMITS.max_files
    || runtime.max_bytes !== NPM_RUNTIME_LIMITS.max_bytes
    || !Number.isSafeInteger(runtime.entry_count)
    || !Number.isSafeInteger(runtime.file_count)
    || !Number.isSafeInteger(runtime.total_bytes)
    || runtime.entry_count < runtime.file_count
    || runtime.file_count < 1
    || runtime.total_bytes < 1
    || runtime.entry_count > runtime.max_entries
    || runtime.file_count > runtime.max_files
    || runtime.total_bytes > runtime.max_bytes) return false;
  const relativeEntry = win32.relative(runtime.root, launch.args_prefix[0]);
  return relativeEntry !== ''
    && relativeEntry !== '..'
    && !relativeEntry.startsWith(`..${win32.sep}`)
    && !win32.isAbsolute(relativeEntry);
}

export function validateClientLaunchContract(launch) {
  if (!launch || !CLIENT_IDS.includes(launch.client_id)) invalid('client launch ID is invalid');
  if (typeof launch.command !== 'string' || !win32.isAbsolute(launch.command) || !/\.exe$/i.test(launch.command)) {
    invalid('client launch command must be an absolute Windows executable');
  }
  if (!Array.isArray(launch.args_prefix) || launch.args_prefix.some(path => typeof path !== 'string' || !win32.isAbsolute(path))) {
    invalid('client launch argument prefix must contain absolute paths');
  }
  if (!['native', 'npm_package'].includes(launch.source)) invalid('client launch source is invalid');
  if (launch.source === 'npm_package') {
    if (launch.package_id !== PACKAGE_IDS[launch.client_id] || launch.args_prefix.length !== 1 || win32.basename(launch.command).toLowerCase() !== 'node.exe') {
      invalid('npm client launch tuple is invalid');
    }
    if (!validNpmRuntimeFingerprint(launch.fingerprint?.runtime_tree, launch)) {
      invalid('npm client runtime fingerprint is invalid');
    }
  } else if (launch.package_id !== null) {
    invalid('native client launch cannot declare an npm package');
  } else if (launch.fingerprint?.runtime_tree !== undefined) {
    invalid('native client launch cannot declare an npm runtime tree');
  }
  if (typeof launch.version !== 'string' || classifySupportedVersion(launch.client_id, launch.version) !== launch.compatibility) {
    invalid('client launch version classification is invalid');
  }
  if (launch.write_supported !== (launch.compatibility === 'release_gated')) invalid('client write support disagrees with its version gate');
  if (!launch.fingerprint || typeof launch.fingerprint !== 'object') invalid('client launch fingerprint is missing');

  if (launch.client_id === 'vscode') {
    if (launch.source !== 'native' || !/Code\.exe$/i.test(launch.command)
      || launch.args_prefix.length !== 1 || !/cli\.js$/i.test(launch.args_prefix[0])
      || !isVsCodeCliTuple(launch.command, launch.args_prefix[0])
      || !exactObject(launch.env_overlay, expectedClientLaunchOverlay('vscode'))) {
      invalid('VS Code launch tuple is invalid');
    }
  } else if (!exactObject(launch.env_overlay, {})) {
    invalid('non-VS Code client launch cannot alter the environment');
  }
  return launch;
}
