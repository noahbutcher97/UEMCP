import * as defaultFs from 'node:fs/promises';
import { posix, resolve, win32 } from 'node:path';

import { sha256Canonical } from './canonical-json.mjs';
import {
  CLIENT_IDS,
  expectedClientLaunchOverlay,
  mergeWindowsEnvironmentOverlay,
  validateClientLaunchContract,
} from './client-contract.mjs';
import { captureClientPathFingerprint } from './client-transaction.mjs';
import { discoverClients, selectClients } from './client-discovery.mjs';
import {
  ACTION_CODES,
  CLIENT_STATE_VALUES,
  STAGE_STATUSES,
  createStageResult,
} from './contracts.mjs';
import { smokeDescriptor } from './protocol-smoke.mjs';

const DOMAIN_NAME = 'clients';
const DOMAIN_ORDER = 30;
const REVIEW_ACTIONS = new Set(['CUSTOM_ENV_REVIEW_REQUIRED', 'CUSTOM_LAUNCH_REVIEW_REQUIRED']);
const READY_REGISTRATION = new Set(['CONFIGURED', 'ALREADY_CONFIGURED', 'MATCHING_EFFECTIVE', 'MATCHING_SHADOWED']);
const BLOCKED_INSPECTION_STATUSES = new Set(['MALFORMED_CONFIG', 'INSPECTION_LIMIT_EXCEEDED', 'UNSAFE_CONFIG_PATH']);
const ROLLBACK_TERMINAL_STATUSES = new Set(['ROLLED_BACK', 'ROLLBACK_CONFLICT', 'ROLLBACK_FAILED']);
const TRANSACTION_RESULT_STATUSES = new Set(['APPLIED', 'ACTION_REQUIRED', ...ROLLBACK_TERMINAL_STATUSES]);
const TRANSACTION_READY_CLIENT_STATUSES = new Set(['APPLIED', 'MATCHING', 'NO_OP', 'READY']);
const TRANSACTION_ACTION_CLIENT_STATUSES = new Set([
  'ACTION_REQUIRED',
  'CLIENT_ENABLEMENT_REQUIRED',
  'DISABLED',
  'PENDING_APPROVAL',
  'PENDING_RESTART',
  'PENDING_TRUST',
  'POLICY_UNKNOWN',
  'RESTART_REQUIRED',
]);
const ROLLBACK_PATH_STATUSES = new Set(['restored', 'conflict', 'failed']);
const DISCOVERY_ENVIRONMENT_NAMES = new Set([
  'APPDATA',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'COMSPEC',
  'GEMINI_CLI_HOME',
  'GEMINI_CLI_TRUSTED_FOLDERS_PATH',
  'GEMINI_CLI_TRUST_WORKSPACE',
  'HOME',
  'LOCALAPPDATA',
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'PATHEXT',
  'PROGRAMDATA',
  'PROGRAMFILES',
  'SYSTEMROOT',
  'USERPROFILE',
  'WINDIR',
]);
const ACTION_ALIASES = Object.freeze({
  DISABLED: 'CLIENT_ENABLEMENT_REQUIRED',
  PENDING_RESTART: 'RESTART_REQUIRED',
  REJECTED: 'CLIENT_ENABLEMENT_REQUIRED',
  OWNERSHIP_LEDGER_INVALID: 'CONFLICT',
  READ_ONLY_TARGET: 'CONFLICT',
  UNSAFE_CONFIG_PATH: 'MALFORMED_CONFIG',
  UNSAFE_WRITABLE_PATH: 'CONFLICT',
  METADATA_INSPECTION_FAILED: 'CONFLICT',
  SHADOWED: null,
  READY: null,
  NO_OP: null,
  APPLIED: null,
  PRESENT: null,
  CONNECTED: null,
});

const ACTION_MESSAGES = Object.freeze({
  CLIENT_ENABLEMENT_REQUIRED: 'Enable the UEMCP registration in the client before relying on it.',
  CLIENT_ENABLEMENT_REVIEW_REQUIRED: 'Review client enablement before relying on the registration.',
  CLIENT_APPLY_ACTION_REQUIRED: 'Complete the retained client apply or cleanup action before treating the transaction as healthy.',
  CONFLICT: 'Review the existing client registration before replacing owned fields.',
  CUSTOM_ENV_REVIEW_REQUIRED: 'Review the custom protocol environment names and hashes before launch.',
  CUSTOM_LAUNCH_REVIEW_REQUIRED: 'Review the custom protocol working directory before launch.',
  INITIALIZE_FAILED: 'The effective client launch did not complete MCP initialize.',
  INSPECTION_LIMIT_EXCEEDED: 'Client configuration inspection exceeded its bounded limit.',
  MALFORMED_CONFIG: 'Repair the malformed client configuration before continuing.',
  NOT_INSTALLED: 'Install a supported client release or exclude this client.',
  PENDING_APPROVAL: 'Approve the UEMCP registration in the client.',
  PENDING_TRUST: 'Trust the workspace or registration in the client.',
  POLICY_BLOCKED: 'Client policy blocks UEMCP enablement.',
  POLICY_UNKNOWN: 'Review client policy because enablement could not be proven.',
  RESTART_REQUIRED: 'Restart the client to load the reviewed registration.',
  ROLLBACK_CONFLICT: 'Resolve the client configuration conflict retained after rollback.',
  ROLLBACK_FAILED: 'Recover the client configuration from the retained rollback evidence.',
  SYNC_FAILED: 'Inspect the committed client configuration and retry with a new plan.',
  TOOLS_LIST_FAILED: 'The effective client launch initialized but did not complete tools/list.',
  UNSUPPORTED_VERSION: 'The installed client release is outside the exact write gate and remains inspect-only.',
});

export class ClientDomainError extends Error {
  constructor(message, code = 'CLIENT_DOMAIN_FAILED', details = {}) {
    super(message);
    this.name = 'ClientDomainError';
    this.code = code;
    this.details = details;
  }
}

function fail(message, code = 'CLIENT_DOMAIN_FAILED', details = {}) {
  throw new ClientDomainError(message, code, details);
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unique(values) {
  return [...new Set(values)];
}

function pathKey(path) {
  if (typeof path !== 'string') return null;
  if (win32.isAbsolute(path)) return `win:${win32.normalize(path).toLowerCase()}`;
  if (posix.isAbsolute(path)) return `posix:${posix.normalize(path)}`;
  return null;
}

function hasOnlyKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every(key => allowed.has(key));
}

function actionCode(value) {
  const candidate = typeof value === 'string' ? value : value?.code;
  if (Object.hasOwn(ACTION_CODES, candidate)) return candidate;
  if (Object.hasOwn(ACTION_ALIASES, candidate)) return ACTION_ALIASES[candidate];
  fail('client adapter emitted an unmapped action', 'INVALID_CLIENT_ACTION');
}

function normalizeAction(value) {
  const code = actionCode(value);
  if (!code) return null;
  const command = plainObject(value) && value.code === code && value.command !== undefined
    ? value.command
    : null;
  return Object.freeze({
    code,
    message: ACTION_MESSAGES[code] ?? 'Review the client state before continuing.',
    command: command ?? null,
  });
}

function normalizeActions(values) {
  const mapped = values.map(normalizeAction).filter(Boolean);
  const byDigest = new Map(mapped.map(action => [sha256Canonical(action), action]));
  return Object.freeze([...byDigest.values()]);
}

function adapterMap(adapters) {
  if (!Array.isArray(adapters)) fail('client adapters must be an array');
  const map = new Map();
  for (const adapter of adapters) {
    if (!adapter || !CLIENT_IDS.includes(adapter.id) || map.has(adapter.id)
      || ['detect', 'inspect', 'plan', 'snapshot', 'apply', 'verify'].some(name => typeof adapter[name] !== 'function')) {
      fail('client adapter set is invalid');
    }
    map.set(adapter.id, adapter);
  }
  if (CLIENT_IDS.some(clientId => !map.has(clientId))) fail('client adapter set is incomplete');
  return map;
}

function selectionInput(context) {
  const input = context.clientSelection ?? context.client_selection ?? {};
  return {
    include: input.include ?? [],
    exclude: input.exclude ?? [],
    vscodeProfile: input.vscodeProfile ?? input.vscode_profile ?? null,
  };
}

function profileFromPlan(plan) {
  const stage = plan?.stages?.find(candidate => candidate.name === DOMAIN_NAME);
  return stage?.evidence?.vscode_profile ?? null;
}

function clientStageFromPlan(plan) {
  return plan?.stages?.find(candidate => candidate.name === DOMAIN_NAME) ?? null;
}

function discoveryContextDigest(context, requestedProfile) {
  const environment = Object.entries(context.env ?? process.env)
    .filter(([name, value]) => {
      const normalized = name.toUpperCase();
      return value !== undefined && value !== null
        && (DISCOVERY_ENVIRONMENT_NAMES.has(normalized)
          || normalized.startsWith('UEMCP_')
          || normalized.startsWith('UNREAL_'));
    })
    .map(([name, value]) => Object.freeze({ name: name.toUpperCase(), value: String(value) }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.value.localeCompare(right.value));
  return sha256Canonical({
    active_directory: context.activeDirectory ?? null,
    client_decisions: context.request?.client_decisions ?? null,
    environment,
    known_folders: {
      program_data: context.knownFolders?.programData ?? null,
      program_files: context.knownFolders?.programFiles ?? null,
    },
    project_root: context.projectRoot ?? null,
    repo_root: context.repoRoot ?? null,
    requested_profile: requestedProfile,
    state_root: context.stateRoot ?? null,
    vscode_user_data_root: context.vscodeUserDataRoot ?? null,
    workspace_root: context.workspaceRoot ?? context.repoRoot ?? null,
  });
}

function publicLaunchContract(launch) {
  if (launch === null) return null;
  const { env_overlay: ignoredOverlay, fingerprint, ...publicLaunch } = launch;
  const { env_overlay_sha256: ignoredOverlayHash, ...publicFingerprint } = fingerprint ?? {};
  return Object.freeze({
    ...publicLaunch,
    fingerprint: Object.freeze(publicFingerprint),
  });
}

function restoreLaunchContract(clientId, publicLaunch) {
  if (publicLaunch === null) return null;
  const overlay = expectedClientLaunchOverlay(clientId);
  return Object.freeze({
    ...publicLaunch,
    env_overlay: overlay,
    fingerprint: Object.freeze({
      ...publicLaunch.fingerprint,
      env_overlay_sha256: sha256Canonical(overlay),
    }),
  });
}

function discoveryFromPlan(plan) {
  const stage = clientStageFromPlan(plan);
  const plannedClients = new Map((plan?.clients ?? []).map(row => [row.adapter, row]));
  const evidence = new Map((stage?.evidence?.clients ?? []).map(row => [row.adapter, row]));
  return Object.freeze(CLIENT_IDS.map(clientId => {
    const client = plannedClients.get(clientId);
    const clientEvidence = evidence.get(clientId);
    if (!client || !clientEvidence) fail('saved plan is missing client discovery evidence', 'INVALID_PLAN');
    const launch = restoreLaunchContract(clientId, clientEvidence.launch_contract ?? null);
    if (launch !== null && (!plainObject(launch)
      || launch.client_id !== clientId
      || launch.version !== client.version
      || launch.compatibility !== client.compatibility
      || launch.write_supported !== client.write_supported)) {
      fail('saved client launch evidence is inconsistent', 'INVALID_PLAN');
    }
    if (launch === null && client.version !== null) fail('saved plan is missing a detected client launch', 'INVALID_PLAN');
    if (launch !== null) {
      try {
        validateClientLaunchContract(launch);
      } catch {
        fail('saved client launch contract is invalid', 'INVALID_PLAN');
      }
    }
    return Object.freeze({
      client_id: clientId,
      version: client.version,
      compatibility: client.compatibility,
      write_supported: client.write_supported,
      launch,
      discovery_status: clientEvidence.discovery_status,
    });
  }));
}

function selectionFromPlan(discovered, plan) {
  const planned = new Map((plan?.clients ?? []).map(row => [row.adapter, row]));
  const stage = plan?.stages?.find(candidate => candidate.name === DOMAIN_NAME);
  const selectionReasons = new Map((stage?.evidence?.clients ?? []).map(row => [row.adapter, row.selection]));
  return Object.freeze(discovered.map(row => {
    const saved = planned.get(row.client_id);
    if (!saved) fail('saved plan is missing a client row', 'INVALID_PLAN');
    if (saved.version !== row.version || saved.compatibility !== row.compatibility || saved.write_supported !== row.write_supported) {
      fail('client release evidence changed after planning', 'PLAN_STALE', { client_id: row.client_id });
    }
    if (row.compatibility === 'not_installed') {
      const notSelected = saved.status === 'NOT_SELECTED';
      return Object.freeze({
        ...row,
        selected: false,
        status: notSelected ? 'NOT_SELECTED' : 'NOT_INSTALLED',
        enablement: notSelected ? 'NOT_SELECTED' : 'NOT_INSTALLED',
        activation: notSelected ? 'NOT_SELECTED' : 'NOT_INSTALLED',
        selection_reason: selectionReasons.get(row.client_id) ?? (notSelected ? 'saved_not_selected' : 'not_installed'),
      });
    }
    if (!saved.selected && saved.status === 'NOT_SELECTED') {
      return Object.freeze({ ...row, selected: false, status: 'NOT_SELECTED', enablement: 'NOT_SELECTED', activation: 'NOT_SELECTED', selection_reason: 'saved_not_selected' });
    }
    return Object.freeze({ ...row, selected: saved.selected, status: 'UNKNOWN', enablement: 'UNKNOWN', activation: 'UNKNOWN', selection_reason: saved.selected ? 'saved_selected' : 'inspect_only' });
  }));
}

function safeClientStatus(status) {
  if (CLIENT_STATE_VALUES.status.includes(status)) return status;
  if (status === 'UNSAFE_CONFIG_PATH') return 'MALFORMED_CONFIG';
  if (status === 'OWNERSHIP_LEDGER_INVALID') return 'CONFLICT';
  return 'UNKNOWN';
}

function safeEnablement(value) {
  return CLIENT_STATE_VALUES.enablement.includes(value) ? value : 'UNKNOWN';
}

function safeActivation(value) {
  return CLIENT_STATE_VALUES.activation.includes(value) ? value : 'UNKNOWN';
}

function defaultScope(clientId, requestedProfile) {
  if (clientId === 'vscode') return requestedProfile ? `profile:${requestedProfile}` : 'user';
  return 'user';
}

function environmentRows(inspection) {
  const rows = [];
  for (const occurrence of inspection?.occurrences ?? []) {
    const keys = occurrence?.environment?.keys ?? [];
    const hashes = occurrence?.environment?.value_hashes ?? {};
    for (const name of keys) {
      const valueSha256 = hashes[name];
      if (typeof name === 'string' && /^[0-9a-f]{64}$/.test(valueSha256 ?? '')) {
        rows.push(Object.freeze({ name, value_sha256: valueSha256 }));
      }
    }
  }
  const byDigest = new Map(rows.map(row => [sha256Canonical(row), row]));
  return Object.freeze([...byDigest.values()].sort((left, right) => left.name.localeCompare(right.name) || left.value_sha256.localeCompare(right.value_sha256)));
}

function ownedDiffRows(inspection) {
  const rows = [];
  for (const occurrence of inspection?.occurrences ?? []) {
    for (const diff of occurrence?.ownership?.owned_diff ?? []) {
      if (!plainObject(diff) || typeof diff.path !== 'string') continue;
      rows.push(Object.freeze({
        path: diff.path,
        current_present: diff.current_present === true,
        desired_present: diff.desired_present === true,
        ...(typeof diff.current_sha256 === 'string' ? { current_sha256: diff.current_sha256 } : {}),
        ...(typeof diff.desired_sha256 === 'string' ? { desired_sha256: diff.desired_sha256 } : {}),
      }));
    }
  }
  return Object.freeze(rows);
}

function reviewCodes(inspection) {
  return new Set((inspection?.actions ?? []).map(actionCode).filter(code => REVIEW_ACTIONS.has(code)));
}

function approvedReviewCodes(plan, clientId) {
  if (!plan) return new Set();
  const client = plan.clients?.find(row => row.adapter === clientId);
  return new Set([
    ...(client?.actions ?? []),
    ...(plan.actions ?? []),
  ].map(actionCode).filter(code => REVIEW_ACTIONS.has(code)));
}

function canLaunchProtocol(inspection, approvedPlan, clientId) {
  if (BLOCKED_INSPECTION_STATUSES.has(inspection?.registration)) return false;
  const required = reviewCodes(inspection);
  if (required.size === 0) return true;
  const approved = approvedReviewCodes(approvedPlan, clientId);
  return [...required].every(code => approved.has(code));
}

function smokeEvidence(smoke) {
  return {
    protocol_status: smoke?.status ?? 'UNKNOWN',
    instruction_bytes: Number.isSafeInteger(smoke?.instruction_bytes) ? smoke.instruction_bytes : 0,
    tool_count: Number.isSafeInteger(smoke?.tool_count) ? smoke.tool_count : 0,
    initial_tool_names: Array.isArray(smoke?.initial_tool_names) ? [...smoke.initial_tool_names] : [],
    duration_ms: Number.isFinite(smoke?.duration_ms) ? smoke.duration_ms : 0,
  };
}

function publicClient(row, inspection, planResult, requestedProfile, smoke, includeAbsenceAction = false) {
  if (row.status === 'NOT_SELECTED') {
    return Object.freeze({
      adapter: row.client_id,
      version: row.version,
      compatibility: row.compatibility,
      write_supported: row.write_supported,
      selected: false,
      scope: defaultScope(row.client_id, requestedProfile),
      status: 'NOT_SELECTED',
      enablement: 'NOT_SELECTED',
      activation: 'NOT_SELECTED',
      actions: Object.freeze([]),
    });
  }
  if (row.compatibility === 'not_installed') {
    return Object.freeze({
      adapter: row.client_id,
      version: null,
      compatibility: 'not_installed',
      write_supported: false,
      selected: false,
      scope: defaultScope(row.client_id, requestedProfile),
      status: 'NOT_INSTALLED',
      enablement: 'NOT_INSTALLED',
      activation: 'NOT_INSTALLED',
      actions: normalizeActions(includeAbsenceAction ? ['NOT_INSTALLED'] : []),
    });
  }
  if (row.launch === null && row.discovery_status !== 'NOT_INSTALLED') {
    const action = row.discovery_status === 'VERSION_PROBE_FAILED' ? 'UNSUPPORTED_VERSION' : 'CONFLICT';
    return Object.freeze({
      adapter: row.client_id,
      version: null,
      compatibility: 'known_unsupported',
      write_supported: false,
      selected: row.selected === true,
      scope: defaultScope(row.client_id, requestedProfile),
      status: 'UNKNOWN',
      enablement: 'UNKNOWN',
      activation: 'UNKNOWN',
      actions: normalizeActions([action]),
    });
  }
  const actionValues = [
    ...(inspection?.actions ?? []),
    ...(inspection?.remediation_actions ?? []),
    ...(planResult?.actions ?? []),
    ...(row.compatibility === 'release_gated' ? [] : ['UNSUPPORTED_VERSION']),
    ...(['INITIALIZE_FAILED', 'TOOLS_LIST_FAILED'].includes(smoke?.status) ? [smoke.status] : []),
  ];
  const status = safeClientStatus(inspection?.registration ?? 'UNKNOWN');
  return Object.freeze({
    adapter: row.client_id,
    version: row.version,
    compatibility: row.compatibility,
    write_supported: row.write_supported,
    selected: row.selected === true,
    scope: inspection?.effective?.scope ?? planResult?.operations?.[0]?.scope_kind ?? defaultScope(row.client_id, requestedProfile),
    status,
    enablement: safeEnablement(inspection?.enablement),
    activation: safeActivation(inspection?.activation),
    actions: normalizeActions(actionValues),
  });
}

function clientEvidence(row, inspection, planResult, client, smoke) {
  return Object.freeze({
    adapter: row.client_id,
    selected: client.selected,
    selection: row.selection_reason,
    discovery_status: row.discovery_status ?? 'DETECTED',
    launch_contract: publicLaunchContract(row.launch),
    current_scopes: Object.freeze(unique((inspection?.occurrences ?? []).map(occurrence => occurrence.scope).filter(value => typeof value === 'string'))),
    effective_scope: inspection?.effective?.scope ?? null,
    operation: planResult?.status ?? 'INSPECT_ONLY',
    touched_paths: Object.freeze(unique((planResult?.operations ?? []).map(operation => operation.path).filter(value => typeof value === 'string'))),
    owned_diffs: ownedDiffRows(inspection),
    environment: environmentRows(inspection),
    custom_working_directory: (inspection?.occurrences ?? []).some(occurrence => occurrence.custom_launch === true),
    structural_status: client.status,
    native_status: typeof inspection?.native?.status === 'string' ? inspection.native.status : 'UNKNOWN',
    ...smokeEvidence(smoke),
    enablement: client.enablement,
    activation: client.activation,
  });
}

function terminalClientView(record, status, actionCode) {
  const client = Object.freeze({
    ...record.client,
    status,
    enablement: 'UNKNOWN',
    activation: 'UNKNOWN',
    actions: normalizeActions([...record.client.actions, actionCode]),
  });
  const evidence = Object.freeze({
    ...record.evidence,
    structural_status: status,
    native_status: 'UNKNOWN',
    protocol_status: 'UNKNOWN',
    enablement: 'UNKNOWN',
    activation: 'UNKNOWN',
  });
  return Object.freeze({ client, evidence });
}

function stageState(clients, evidenceRows) {
  const selected = clients.filter(client => client.selected);
  const considered = selected.length > 0 ? selected : clients.filter(client => client.status !== 'NOT_SELECTED');
  const evidence = new Map(evidenceRows.map(row => [row.adapter, row]));
  const actionCodes = new Set(considered.flatMap(client => client.actions.map(action => action.code)));
  const first = values => values.find(value => value !== undefined && value !== null);
  const activation = first(considered.map(client => ['PENDING_TRUST', 'PENDING_APPROVAL', 'REJECTED', 'RESTART_REQUIRED'].includes(client.activation) ? client.activation : null));
  const enablement = first(considered.map(client => ['POLICY_BLOCKED', 'DISABLED', 'POLICY_UNKNOWN'].includes(client.enablement) ? client.enablement : null));
  const protocol = first(considered.map(client => {
    const value = evidence.get(client.adapter)?.protocol_status;
    return ['INITIALIZE_FAILED', 'TOOLS_LIST_FAILED'].includes(value) ? value : null;
  }));
  const structural = first(considered.map(client => ['CONFLICT', 'MALFORMED_CONFIG', 'INSPECTION_LIMIT_EXCEEDED'].includes(client.status) ? client.status : null));
  let status = protocol ?? activation ?? enablement ?? structural;
  if (!status && actionCodes.has('UNSUPPORTED_VERSION')) status = 'UNSUPPORTED_VERSION';
  if (!status && [...actionCodes].some(code => REVIEW_ACTIONS.has(code))) status = 'UNKNOWN';
  if (!status && selected.length === 0 && clients.some(client => client.status === 'NOT_SELECTED') && actionCodes.size === 0) status = 'NOT_SELECTED';
  if (!status && considered.every(client => client.status === 'NOT_INSTALLED')) status = 'NOT_INSTALLED';
  if (!status && selected.length === 0) status = considered.length === 0 ? 'NOT_INSTALLED' : 'UNKNOWN';
  if (!status) {
    const healthy = selected.every(client => READY_REGISTRATION.has(client.status)
      && client.enablement === 'ENABLED'
      && client.activation === 'CONNECTED'
      && evidence.get(client.adapter)?.protocol_status === 'HEALTHY');
    status = healthy ? 'HEALTHY' : selected.find(client => client.status === 'ABSENT')?.status ?? 'UNKNOWN';
  }
  if (!Object.hasOwn(STAGE_STATUSES, status)) status = 'UNKNOWN';
  return {
    status,
    result: ['HEALTHY', 'NOT_SELECTED'].includes(status) ? 'ready' : 'action_required',
  };
}

function stableClientFingerprint(fingerprint) {
  const { atime_ms: ignoredAccessTime, ...stable } = fingerprint;
  return Object.freeze(stable);
}

function planPreconditions(records, operations, ownershipFingerprint, ownershipPath, ownershipRoot) {
  const rows = [];
  const seen = new Set();
  const add = ({ path, allowed_root: allowedRoot, fingerprint, writable }) => {
    if (typeof path !== 'string' || typeof allowedRoot !== 'string' || !plainObject(fingerprint)) return;
    const key = path.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(Object.freeze({
      kind: 'client_path',
      label: `clients:path:${rows.length + 1}`,
      canonical_path: path,
      allowed_root: allowedRoot,
      writable,
      fingerprint: stableClientFingerprint(fingerprint),
    }));
  };
  for (const operation of operations) {
    add({ ...operation, writable: operation.ledger_only !== true });
    for (const row of operation.read_only_paths ?? []) add({ ...row, writable: false });
  }
  const writablePaths = new Set(operations
    .filter(operation => operation.ledger_only !== true)
    .map(operation => operation.path.toLowerCase()));
  for (const record of records) {
    for (const file of record.inspection?.files ?? []) {
      add({ ...file, writable: writablePaths.has(file.path.toLowerCase()) });
    }
  }
  if (operations.length > 0) {
    add({ path: ownershipPath, allowed_root: ownershipRoot, fingerprint: ownershipFingerprint, writable: true });
  }
  return Object.freeze(rows);
}

function stableErrorCode(value, fallback = 'UNKNOWN') {
  return typeof value === 'string' && /^[A-Z0-9_]+$/.test(value) ? value : fallback;
}

function publicTransactionEvidence(result) {
  if (!plainObject(result) || typeof result.status !== 'string') return null;
  const rollback = plainObject(result.rollback)
    ? Object.freeze({
        reason_code: stableErrorCode(result.rollback.reason_code, 'APPLY_FAILED'),
        paths: Object.freeze((result.rollback.paths ?? []).filter(plainObject).map(row => Object.freeze({
          status: typeof row.status === 'string' ? row.status : 'unknown',
          path: typeof row.path === 'string' ? row.path : '<unknown>',
          code: stableErrorCode(row.code),
        }))),
        hook_errors: Object.freeze((result.rollback.hook_errors ?? []).filter(plainObject).map(row => Object.freeze({
          client_id: typeof row.client_id === 'string' ? row.client_id : 'transaction',
          code: stableErrorCode(row.code),
        }))),
      })
    : null;
  return Object.freeze({
    status: stableErrorCode(result.status),
    clients: Object.freeze((result.clients ?? []).filter(plainObject).map(row => Object.freeze({
      client_id: CLIENT_IDS.includes(row.client_id) ? row.client_id : 'unknown',
      status: stableErrorCode(row.status),
      ...(row.error_code ? { error_code: stableErrorCode(row.error_code) } : {}),
    }))),
    touched_files: Object.freeze((result.touched_files ?? []).filter(plainObject).map(row => Object.freeze({
      path: typeof row.path === 'string' ? row.path : '<unknown>',
      applied_sha256: typeof row.applied_sha256 === 'string' && /^[0-9a-f]{64}$/.test(row.applied_sha256)
        ? row.applied_sha256
        : null,
    }))),
    rollback,
    retained_snapshots: Object.freeze((result.retained_snapshots ?? []).filter(plainObject).map(row => Object.freeze({
      path: typeof row.path === 'string' ? row.path : '<unknown>',
      retained_until: typeof row.retained_until === 'string' ? row.retained_until : null,
    }))),
    cleanup_actions: Object.freeze((result.cleanup_actions ?? []).filter(plainObject).map(row => Object.freeze({
      path: typeof row.path === 'string' ? row.path : '<unknown>',
      code: stableErrorCode(row.code),
    }))),
  });
}

function validTransactionResult(result, operations, writablePreconditions) {
  const resultKeys = new Set(['status', 'clients', 'touched_files', 'rollback', 'retained_snapshots', 'cleanup_actions']);
  if (!hasOnlyKeys(result, resultKeys) || !TRANSACTION_RESULT_STATUSES.has(result.status)
    || !Array.isArray(result.clients)
    || !Array.isArray(result.touched_files)
    || !Array.isArray(result.retained_snapshots)
    || (result.cleanup_actions !== undefined && !Array.isArray(result.cleanup_actions))) {
    return false;
  }
  const allowedPaths = new Set(writablePreconditions.map(row => pathKey(row.canonical_path)).filter(Boolean));
  const operationClients = new Set(operations.map(operation => operation.client_id));
  const operationPaths = new Map(operations.map(operation => [pathKey(operation.path), operation]));
  const requiredWritePaths = new Set(operations
    .filter(operation => operation.ledger_only !== true)
    .map(operation => pathKey(operation.path))
    .filter(Boolean));
  const clientIds = result.clients.map(row => row?.client_id);
  if (new Set(clientIds).size !== clientIds.length
    || result.clients.some(row => !hasOnlyKeys(row, new Set(['client_id', 'status', 'error_code']))
      || !operationClients.has(row.client_id)
      || !TRANSACTION_READY_CLIENT_STATUSES.has(row.status)
        && !TRANSACTION_ACTION_CLIENT_STATUSES.has(row.status)
        && row.status !== 'FAILED'
      || (row.status === 'FAILED'
        ? stableErrorCode(row.error_code, null) === null
        : row.error_code !== undefined))) {
    return false;
  }
  const success = result.status === 'APPLIED' || result.status === 'ACTION_REQUIRED';
  if (success && (clientIds.length !== operationClients.size
    || [...operationClients].some(clientId => !clientIds.includes(clientId))
    || result.clients.some(row => row.status === 'FAILED'))) return false;
  if (result.status === 'APPLIED' && result.clients.some(row => !TRANSACTION_READY_CLIENT_STATUSES.has(row.status))) return false;

  const touchedKeys = [];
  for (const row of result.touched_files) {
    const key = pathKey(row?.path);
    const operation = operationPaths.get(key);
    if (!hasOnlyKeys(row, new Set(['path', 'applied_sha256']))
      || !key
      || !allowedPaths.has(key)
      || (row.applied_sha256 !== null && !/^[0-9a-f]{64}$/.test(row.applied_sha256 ?? ''))
      || (row.applied_sha256 === null && operation?.delete_after_verify !== true)) {
      return false;
    }
    touchedKeys.push(key);
  }
  if (new Set(touchedKeys).size !== touchedKeys.length
    || (success && operations.length > 0 && touchedKeys.length === 0)
    || (success && [...requiredWritePaths].some(key => !touchedKeys.includes(key)))) {
    return false;
  }

  const retainedKeys = [];
  for (const row of result.retained_snapshots) {
    const key = pathKey(row?.path);
    if (!hasOnlyKeys(row, new Set(['path', 'retained_until']))
      || !key
      || !allowedPaths.has(key)
      || (row.retained_until !== null && (typeof row.retained_until !== 'string' || !Number.isFinite(Date.parse(row.retained_until))))) {
      return false;
    }
    retainedKeys.push(key);
  }
  if (new Set(retainedKeys).size !== retainedKeys.length) return false;

  const cleanupActions = result.cleanup_actions ?? [];
  const cleanupKeys = [];
  for (const row of cleanupActions) {
    const key = pathKey(row?.path);
    if (!hasOnlyKeys(row, new Set(['path', 'code']))
      || !key
      || !allowedPaths.has(key)
      || stableErrorCode(row.code, null) === null) return false;
    cleanupKeys.push(`${key}:${row.code}`);
  }
  if (new Set(cleanupKeys).size !== cleanupKeys.length) return false;

  if (success) {
    if (result.rollback !== null) return false;
    const hasFollowUp = result.clients.some(row => TRANSACTION_ACTION_CLIENT_STATUSES.has(row.status))
      || result.retained_snapshots.length > 0
      || cleanupActions.length > 0;
    return result.status === 'ACTION_REQUIRED' ? hasFollowUp : !hasFollowUp;
  }
  if (!hasOnlyKeys(result.rollback, new Set(['reason_code', 'paths', 'hook_errors']))
    || stableErrorCode(result.rollback.reason_code, null) === null
    || !Array.isArray(result.rollback.paths)
    || !Array.isArray(result.rollback.hook_errors)) return false;
  const rollbackKeys = [];
  for (const row of result.rollback.paths) {
    const key = pathKey(row?.path);
    if (!hasOnlyKeys(row, new Set(['status', 'path', 'code']))
      || !ROLLBACK_PATH_STATUSES.has(row.status)
      || !key
      || !allowedPaths.has(key)
      || (row.status === 'restored' ? row.code !== undefined : stableErrorCode(row.code, null) === null)) return false;
    rollbackKeys.push(key);
  }
  if (new Set(rollbackKeys).size !== rollbackKeys.length) return false;
  for (const row of result.rollback.hook_errors) {
    if (!hasOnlyKeys(row, new Set(['client_id', 'code']))
      || ![...CLIENT_IDS, 'transaction'].includes(row.client_id)
      || stableErrorCode(row.code, null) === null) return false;
  }
  const hasConflict = result.rollback.paths.some(row => row.status === 'conflict');
  const hasFailure = result.rollback.paths.some(row => row.status === 'failed') || result.rollback.hook_errors.length > 0;
  if (result.status === 'ROLLED_BACK') return !hasConflict && !hasFailure && result.retained_snapshots.length === 0;
  if (result.status === 'ROLLBACK_CONFLICT') return hasConflict;
  return result.status === 'ROLLBACK_FAILED' && !hasConflict && hasFailure;
}

function ownershipLedger(fsImpl, localState, now) {
  if (!localState?.paths) {
    return Object.freeze({ read: async () => null, now: () => now.toISOString() });
  }
  const path = localState.paths().ownership;
  return Object.freeze({
    async read() {
      try {
        return JSON.parse(await fsImpl.readFile(path, 'utf8'));
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return null;
        throw error;
      }
    },
    now: () => now.toISOString(),
  });
}

export function createClientDomain({
  adapters,
  transaction,
  discovery = discoverClients,
  protocolSmoke = smokeDescriptor,
  captureFingerprint = captureClientPathFingerprint,
  fsImpl = defaultFs,
} = {}) {
  const mappedAdapters = adapterMap(adapters);
  if (typeof transaction !== 'function' && (!transaction || typeof transaction.snapshot !== 'function' || typeof transaction.apply !== 'function')) {
    fail('client domain requires a transaction factory or transaction');
  }
  if (typeof discovery !== 'function' || typeof protocolSmoke !== 'function' || typeof captureFingerprint !== 'function') {
    fail('client domain dependencies are invalid');
  }

  async function discover(context, approvedPlan = null) {
    const selection = selectionInput(context);
    const requestedProfile = approvedPlan ? profileFromPlan(approvedPlan) : selection.vscodeProfile;
    const contextSha256 = discoveryContextDigest(context, requestedProfile);
    let rows;
    if (approvedPlan) {
      const plannedSha256 = clientStageFromPlan(approvedPlan)?.evidence?.discovery_context_sha256;
      if (typeof plannedSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(plannedSha256)) {
        fail('saved plan is missing client discovery context', 'INVALID_PLAN');
      }
      if (plannedSha256 !== contextSha256) fail('client discovery context changed after planning', 'PLAN_STALE');
      rows = discoveryFromPlan(approvedPlan);
    } else {
      rows = await discovery({
        env: context.env ?? process.env,
        workspaceRoot: context.workspaceRoot ?? context.repoRoot,
        requestedProfile,
        fsImpl: context.fsImpl ?? fsImpl,
        runner: context.processRunner,
      });
    }
    return {
      requestedProfile,
      contextSha256,
      rows: approvedPlan
        ? selectionFromPlan(rows, approvedPlan)
        : selectClients(rows, { include: selection.include, exclude: selection.exclude }),
    };
  }

  function adapterContext(context, row, requestedProfile, planDigest, ledger) {
    return Object.freeze({
      ...context,
      launch: row.launch,
      planDigest,
      ownershipLedger: ledger,
      vscodeProfile: requestedProfile,
    });
  }

  async function inspectRows(context, selectedRows, requestedProfile, planDigest, { plan = false, approvedPlan = null } = {}) {
    const ledger = ownershipLedger(context.fsImpl ?? fsImpl, context.localState, context.now instanceof Date ? context.now : new Date(context.now ?? Date.now()));
    const records = [];
    const hasSelected = selectedRows.some(row => row.selected);
    const hasNotSelected = selectedRows.some(row => row.status === 'NOT_SELECTED');
    for (const row of selectedRows) {
      if (row.compatibility === 'not_installed' || row.status === 'NOT_SELECTED' || row.launch === null) {
        const includeAbsenceAction = row.selection_reason === 'included_not_installed'
          || (!hasSelected && !hasNotSelected);
        const client = publicClient(row, null, null, requestedProfile, null, includeAbsenceAction);
        records.push({ row, adapter: mappedAdapters.get(row.client_id), context: null, detection: null, inspection: null, planResult: null, smoke: null, client, evidence: clientEvidence(row, null, null, client, null) });
        continue;
      }
      const adapter = mappedAdapters.get(row.client_id);
      const currentContext = adapterContext(context, row, requestedProfile, planDigest, ledger);
      const detection = await adapter.detect(currentContext);
      const inspection = await settleInspection(currentContext, adapter, detection);
      const planResult = plan && row.selected
        ? await adapter.plan(currentContext, inspection, context.descriptor)
        : null;
      let smoke = { status: 'UNKNOWN' };
      if (canLaunchProtocol(inspection, approvedPlan, row.client_id)) {
        const launch = typeof adapter.protocolLaunch === 'function'
          ? await adapter.protocolLaunch(currentContext, inspection)
          : { env_overlay: {}, cwd: null };
        if (!plainObject(launch?.env_overlay) || Object.values(launch.env_overlay).some(value => typeof value !== 'string')) {
          fail('adapter private protocol environment is invalid', 'INVALID_CLIENT_LAUNCH');
        }
        const effectiveEnvironment = mergeWindowsEnvironmentOverlay(context.env ?? process.env, launch.env_overlay);
        await recheckInspectionPreconditions(currentContext, inspection);
        await currentContext.beforeActiveClientLaunch?.({ client_id: row.client_id, kind: 'protocol' });
        smoke = await protocolSmoke(context.descriptor, {
          effectiveEnvironment,
          effectiveCwd: launch.cwd ?? null,
        });
      }
      const client = publicClient(row, inspection, planResult, requestedProfile, smoke);
      records.push({
        row,
        adapter,
        context: currentContext,
        detection,
        inspection,
        planResult,
        smoke,
        client,
        evidence: clientEvidence(row, inspection, planResult, client, smoke),
      });
    }
    return records;
  }

  function aggregate(records, requestedProfile, {
    changed = false,
    transactionResult = null,
    contextSha256 = null,
    affectedClientIds = [],
  } = {}) {
    const transactionStatus = transactionResult?.status ?? null;
    const affected = new Set(affectedClientIds);
    const terminalStatus = ['ROLLBACK_CONFLICT', 'ROLLBACK_FAILED'].includes(transactionStatus)
      ? transactionStatus
      : null;
    const views = records.map(record => terminalStatus && affected.has(record.row.client_id)
      ? terminalClientView(record, terminalStatus, terminalStatus)
      : record);
    const clients = Object.freeze(views.map(record => record.client));
    const evidenceRows = Object.freeze(views.map(record => record.evidence));
    const transactionActions = transactionStatus === 'ACTION_REQUIRED'
      ? ['CLIENT_APPLY_ACTION_REQUIRED']
      : ['ROLLBACK_CONFLICT', 'ROLLBACK_FAILED'].includes(transactionStatus)
        ? [transactionStatus]
        : [];
    const actions = normalizeActions([...clients.flatMap(client => client.actions), ...transactionActions]);
    let state = stageState(clients, evidenceRows);
    if (transactionStatus === 'ROLLED_BACK' || transactionStatus === 'ROLLBACK_CONFLICT') {
      state = { status: transactionStatus, result: 'rolled_back' };
    } else if (transactionStatus === 'ROLLBACK_FAILED') {
      state = { status: transactionStatus, result: 'failed' };
    } else if (transactionStatus === 'ACTION_REQUIRED') {
      state = { status: 'CLIENT_APPLY_ACTION_REQUIRED', result: 'action_required' };
    }
    const stage = createStageResult({
      name: DOMAIN_NAME,
      status: state.status,
      changed,
      result: state.result,
      evidence: {
        vscode_profile: requestedProfile,
        discovery_context_sha256: contextSha256,
        clients: evidenceRows,
        ...(transactionStatus ? { transaction_status: transactionStatus } : {}),
        ...(transactionResult ? { transaction: publicTransactionEvidence(transactionResult) } : {}),
      },
      actions,
    });
    return Object.freeze({ stage, clients, actions });
  }

  function committedInspectionFailure(records, requestedProfile, transactionResult, contextSha256, error, affectedClientIds) {
    const affected = new Set(affectedClientIds);
    const views = records.map(record => affected.has(record.row.client_id)
      ? terminalClientView(record, 'UNKNOWN', 'SYNC_FAILED')
      : record);
    const clients = Object.freeze(views.map(record => record.client));
    const evidenceRows = Object.freeze(views.map(record => record.evidence));
    const actions = normalizeActions([...clients.flatMap(client => client.actions), 'SYNC_FAILED']);
    const stage = createStageResult({
      name: DOMAIN_NAME,
      status: 'SYNC_FAILED',
      changed: true,
      result: 'failed',
      progress: 'committed',
      evidence: {
        vscode_profile: requestedProfile,
        discovery_context_sha256: contextSha256,
        clients: evidenceRows,
        transaction_status: transactionResult.status,
        transaction: publicTransactionEvidence(transactionResult),
        error_code: error?.code === 'INVALID_CLIENT_TRANSACTION_RESULT'
          ? 'INVALID_CLIENT_TRANSACTION_RESULT'
          : 'CLIENT_POST_COMMIT_INSPECTION_FAILED',
      },
      actions,
    });
    return Object.freeze({ stage, clients, actions });
  }

  async function plan(context) {
    if (!context.descriptor) fail('client planning context is incomplete');
    const { rows, requestedProfile, contextSha256 } = await discover(context);
    const planDigest = sha256Canonical({
      source: context.source,
      request: context.request,
      descriptor: context.descriptor,
      client_selection: selectionInput(context),
      now: context.now instanceof Date ? context.now.toISOString() : context.now,
    });
    const records = await inspectRows(context, rows, requestedProfile, planDigest, { plan: true });
    const blocked = records.filter(record => record.row.selected
      && BLOCKED_INSPECTION_STATUSES.has(record.inspection?.registration));
    if (blocked.length > 0) {
      fail('selected client inspection cannot bind a complete apply plan', 'CLIENT_INSPECTION_UNBOUND', {
        clients: blocked.map(record => ({
          client_id: record.row.client_id,
          status: record.inspection.registration,
        })),
      });
    }
    const operations = Object.freeze(records
      .filter(record => record.row.selected)
      .flatMap(record => record.planResult?.operations ?? [])
      .map(operation => Object.freeze({
        ...operation,
        domain: DOMAIN_NAME,
        domain_order: DOMAIN_ORDER,
        kind: 'CLIENT_CONFIG_WRITE',
      })));
    let ownershipFingerprint = null;
    if (operations.length > 0 && !context.localState?.paths) fail('client write planning requires local state');
    const ownershipPath = context.localState?.paths().ownership ?? null;
    const ownershipRoot = context.localState?.paths().state ?? null;
    if (operations.length > 0) {
      ownershipFingerprint = await captureFingerprint(ownershipPath, {
        allowedRoots: [ownershipRoot],
        fsImpl: context.fsImpl ?? fsImpl,
        writable: true,
      });
    }
    const preconditions = planPreconditions(records, operations, ownershipFingerprint, ownershipPath, ownershipRoot);
    const normalized = aggregate(records, requestedProfile, { contextSha256 });
    return Object.freeze({
      stages: Object.freeze([normalized.stage]),
      operations,
      preconditions,
      clients: normalized.clients,
      actions: normalized.actions,
    });
  }

  function boundAdapters(records, operations) {
    const byClient = new Map(records.map(record => [record.row.client_id, record]));
    const operationClients = new Set(operations.map(operation => operation.client_id));
    return CLIENT_IDS.filter(clientId => operationClients.has(clientId)).map(clientId => {
      const adapter = mappedAdapters.get(clientId);
      const record = byClient.get(clientId);
      const withContext = context => ({ ...context, ...(record?.context ?? {}) });
      return Object.freeze({
        id: clientId,
        snapshot: (context, operations) => adapter.snapshot(withContext(context), operations),
        apply: (context, operations) => adapter.apply(withContext(context), operations),
        verify: (context, operations) => adapter.verify(withContext(context), operations),
        rollback: typeof adapter.rollback === 'function'
          ? (context, rows) => adapter.rollback(withContext(context), rows)
          : undefined,
      });
    });
  }

  function assertAuthorizedClientOperations(records, operations) {
    const byClient = new Map(records.map(record => [record.row.client_id, record]));
    const failures = [];
    for (const operation of operations) {
      const record = byClient.get(operation.client_id);
      if (!record
        || record.row.selected !== true
        || record.row.compatibility !== 'release_gated'
        || record.row.write_supported !== true
        || record.row.launch === null
        || !record.inspection
        || BLOCKED_INSPECTION_STATUSES.has(record.inspection.registration)) {
        failures.push({ client_id: operation.client_id ?? 'unknown' });
      }
    }
    if (failures.length > 0) {
      fail('approved client operations no longer have complete selected-client evidence', 'CLIENT_INSPECTION_UNBOUND', { clients: failures });
    }
  }

  async function inspectionPreconditionFailures(context, inspection) {
    const failures = [];
    for (const [index, file] of (inspection?.files ?? []).entries()) {
      if (!plainObject(file) || typeof file.path !== 'string' || typeof file.allowed_root !== 'string' || !plainObject(file.fingerprint)) {
        failures.push({ reason: 'INSPECTION_FINGERPRINT_MISSING' });
        continue;
      }
      try {
        const observed = stableClientFingerprint(await captureFingerprint(file.path, {
          allowedRoots: [file.allowed_root],
          fsImpl: context.fsImpl ?? fsImpl,
          writable: file.writable === true,
        }));
        const expected = stableClientFingerprint(file.fingerprint);
        if (sha256Canonical(observed) !== sha256Canonical(expected)) {
          const changedFields = unique([...Object.keys(expected), ...Object.keys(observed)])
            .filter(key => sha256Canonical(expected[key] ?? null) !== sha256Canonical(observed[key] ?? null));
          failures.push({ reason: 'INSPECTION_FINGERPRINT_CHANGED', evidence_index: index, changed_fields: changedFields });
        }
      } catch (error) {
        failures.push({ reason: stableErrorCode(error?.code, 'FINGERPRINT_FAILED') });
      }
    }
    return failures;
  }

  function throwInspectionPreconditionFailures(failures) {
    if (failures.length > 0) fail('client evidence changed after inspection', 'PLAN_STALE', { failures });
  }

  async function recheckInspectionPreconditions(context, inspection) {
    throwInspectionPreconditionFailures(await inspectionPreconditionFailures(context, inspection));
  }

  async function settleInspection(context, adapter, detection) {
    let inspection = await adapter.inspect(context, detection);
    const failures = await inspectionPreconditionFailures(context, inspection);
    if (failures.length === 0) return inspection;
    if (failures.some(row => row.reason !== 'INSPECTION_FINGERPRINT_CHANGED')) {
      throwInspectionPreconditionFailures(failures);
    }
    inspection = await adapter.inspect(context, detection);
    await recheckInspectionPreconditions(context, inspection);
    return inspection;
  }

  async function recheckActiveLaunchPreconditions(context, approvedPlan, {
    transactionOwnsWrites = false,
    committedTouchedHashes = new Map(),
  } = {}) {
    if (context.applyLease && typeof context.localState?.validateApplyLease === 'function') {
      await context.localState.validateApplyLease(context.applyLease);
    }
    const failures = [];
    for (const precondition of approvedPlan.preconditions.filter(row => row.kind === 'client_path')) {
      if (transactionOwnsWrites && precondition.writable === true) continue;
      let observed;
      try {
        observed = stableClientFingerprint(await captureFingerprint(precondition.canonical_path, {
          allowedRoots: [precondition.allowed_root],
          fsImpl: context.fsImpl ?? fsImpl,
          writable: precondition.writable === true,
        }));
      } catch (error) {
        failures.push({ label: precondition.label, reason: stableErrorCode(error?.code, 'FINGERPRINT_FAILED') });
        continue;
      }
      const committedHash = precondition.writable === true
        ? committedTouchedHashes.get(pathKey(precondition.canonical_path))
        : undefined;
      const committedMismatch = committedHash !== undefined
        && (observed.content_sha256 !== committedHash || observed.exists !== (committedHash !== null));
      const plannedMismatch = committedHash === undefined
        && sha256Canonical(observed) !== sha256Canonical(precondition.fingerprint);
      if (committedMismatch || plannedMismatch) {
        failures.push({ label: precondition.label, reason: 'FINGERPRINT_CHANGED' });
      }
    }
    if (failures.length > 0) fail('client evidence changed before active verification', 'PLAN_STALE', { failures });
  }

  async function apply(context, operations = []) {
    const approvedPlan = context.approvedPlan;
    if (!approvedPlan || !/^[0-9a-f]{64}$/.test(approvedPlan.digest ?? '')) fail('client apply requires the approved saved plan', 'INVALID_PLAN');
    const approvedOperations = approvedPlan.operations.filter(operation => operation.domain === DOMAIN_NAME);
    if (sha256Canonical(operations) !== sha256Canonical(approvedOperations)) {
      fail('client apply operation set differs from the approved plan', 'UNAPPROVED_OPERATION_SET');
    }
    const affectedClientIds = unique(operations.map(operation => operation.client_id).filter(clientId => CLIENT_IDS.includes(clientId)));
    let transactionOwnsWrites = false;
    const committedTouchedHashes = new Map();
    const applyContext = {
      ...context,
      beforeActiveClientLaunch: async evidence => {
        if (!plainObject(evidence) || !CLIENT_IDS.includes(evidence.client_id)
          || !['native', 'protocol'].includes(evidence.kind)) {
          fail('adapter active-launch guard evidence is invalid', 'INVALID_CLIENT_LAUNCH');
        }
        await recheckActiveLaunchPreconditions(context, approvedPlan, { transactionOwnsWrites, committedTouchedHashes });
      },
    };
    const { rows, requestedProfile, contextSha256 } = await discover(applyContext, approvedPlan);
    const before = await inspectRows(applyContext, rows, requestedProfile, approvedPlan.digest, { approvedPlan });
    assertAuthorizedClientOperations(before, operations);
    let transactionResult = null;
    if (operations.length > 0) {
      const ownership = approvedPlan.preconditions.find(precondition => precondition.kind === 'client_path'
        && precondition.canonical_path === applyContext.localState.paths().ownership);
      if (!ownership?.fingerprint) fail('approved client plan lacks the ownership precondition', 'INVALID_PLAN');
      const activeTransaction = typeof transaction === 'function'
        ? transaction({ externalLease: applyContext.applyLease, context: applyContext })
        : transaction;
      const transactionAdapters = boundAdapters(before, operations);
      await activeTransaction.snapshot({
        planDigest: approvedPlan.digest,
        adapters: transactionAdapters,
        operations,
        context: applyContext,
        ownershipFingerprint: ownership.fingerprint,
      });
      transactionOwnsWrites = true;
      transactionResult = await activeTransaction.apply({
        planDigest: approvedPlan.digest,
        adapters: transactionAdapters,
        operations,
        context: applyContext,
      });
      transactionOwnsWrites = false;
      const writablePreconditions = approvedPlan.preconditions.filter(precondition => precondition.kind === 'client_path' && precondition.writable === true);
      if (!validTransactionResult(transactionResult, operations, writablePreconditions)) {
        const invalidResult = Object.freeze({
          status: 'UNKNOWN',
          clients: Object.freeze(unique(operations.map(operation => operation.client_id).filter(clientId => CLIENT_IDS.includes(clientId)))
            .map(clientId => Object.freeze({ client_id: clientId, status: 'UNKNOWN' }))),
          touched_files: Object.freeze(unique(operations.map(operation => operation.path).filter(path => typeof path === 'string'))
            .map(path => Object.freeze({ path, applied_sha256: null }))),
          rollback: null,
          retained_snapshots: Object.freeze([]),
        });
        return committedInspectionFailure(
          before,
          requestedProfile,
          invalidResult,
          contextSha256,
          Object.assign(new Error('client transaction result is invalid'), { code: 'INVALID_CLIENT_TRANSACTION_RESULT' }),
          affectedClientIds,
        );
      }
      for (const row of transactionResult.touched_files) {
        committedTouchedHashes.set(pathKey(row.path), row.applied_sha256);
      }
      if (['APPLIED', 'ACTION_REQUIRED'].includes(transactionResult.status)) {
        try {
          await recheckActiveLaunchPreconditions(context, approvedPlan, { committedTouchedHashes });
        } catch (error) {
          return committedInspectionFailure(before, requestedProfile, transactionResult, contextSha256, error, affectedClientIds);
        }
      }
    }
    const changed = (transactionResult?.touched_files?.length ?? 0) > 0;
    if (ROLLBACK_TERMINAL_STATUSES.has(transactionResult?.status)) {
      return aggregate(before, requestedProfile, { changed, transactionResult, contextSha256, affectedClientIds });
    }
    let after;
    try {
      const afterDiscovery = await discover(applyContext, approvedPlan);
      after = await inspectRows(applyContext, afterDiscovery.rows, requestedProfile, approvedPlan.digest, { approvedPlan });
    } catch (error) {
      if (['APPLIED', 'ACTION_REQUIRED'].includes(transactionResult?.status)) {
        return committedInspectionFailure(before, requestedProfile, transactionResult, contextSha256, error, affectedClientIds);
      }
      throw error;
    }
    return aggregate(after, requestedProfile, {
      changed,
      transactionResult,
      contextSha256,
    });
  }

  async function verify(context) {
    if (!context.descriptor) fail('client verification context is incomplete');
    const { rows, requestedProfile, contextSha256 } = await discover(context);
    const records = await inspectRows(context, rows, requestedProfile, '0'.repeat(64));
    return aggregate(records, requestedProfile, { contextSha256 });
  }

  function canFingerprintPrecondition(precondition) {
    return precondition?.kind === 'client_path';
  }

  async function fingerprintPrecondition(precondition, context) {
    return stableClientFingerprint(await captureFingerprint(precondition.canonical_path, {
      allowedRoots: [precondition.allowed_root],
      fsImpl: context.fsImpl ?? fsImpl,
      writable: precondition.writable === true,
    }));
  }

  return Object.freeze({
    name: DOMAIN_NAME,
    order: DOMAIN_ORDER,
    plan,
    apply,
    verify,
    canFingerprintPrecondition,
    fingerprintPrecondition,
  });
}
