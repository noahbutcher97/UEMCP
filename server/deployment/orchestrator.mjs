import { dirname } from 'node:path';

import {
  ACTION_CODES,
  createMachineResult,
  createStageResult,
  reduceOutcome,
  shouldRecordPlanDigest,
  validateRequestContract,
} from './contracts.mjs';
import { sha256Canonical } from './canonical-json.mjs';
import { descriptorsEqual } from './descriptor.mjs';
import { fingerprintPath } from './fingerprints.mjs';
import { createGenericClientResult, smokeDescriptor } from './protocol-smoke.mjs';
import {
  createPlanDocument,
  validatePlanEnvelope,
  validatePlanForApply,
} from './plan-document.mjs';
import { writeReceipt } from './receipts.mjs';

const DOMAIN_ORDERS = Object.freeze({ prerequisites: 10, target: 20, clients: 30, plugin: 40 });

export class OrchestratorError extends Error {
  constructor(message, code = 'ORCHESTRATOR_FAILED', details = {}) {
    super(message);
    this.name = 'OrchestratorError';
    this.code = code;
    this.details = details;
  }
}

function normalizeClock(clock) {
  const value = clock();
  return value instanceof Date ? value : new Date(value);
}

function normalizeRequest(input, forcedOperation = null) {
  const operation = forcedOperation ?? input?.operation;
  if (!['setup', 'sync', 'repair', 'verify', 'doctor'].includes(operation)) throw new OrchestratorError('request operation is invalid', 'INVALID_REQUEST');
  const request = validateRequestContract({
    requested_project: input?.requested_project ?? null,
    requested_profile: input?.requested_profile ?? null,
    selected_clients: input?.selected_clients ?? [],
  });
  return { operation, request };
}

function validateDomains(domains) {
  if (!Array.isArray(domains)) throw new OrchestratorError('domains must be an array');
  const seen = new Set();
  const rows = [...domains].sort((left, right) => left.order - right.order);
  for (const domain of rows) {
    if (!domain || !Object.hasOwn(DOMAIN_ORDERS, domain.name) || domain.order !== DOMAIN_ORDERS[domain.name]) {
      throw new OrchestratorError('domain name/order is invalid');
    }
    if (seen.has(domain.name)) throw new OrchestratorError('domain names must be unique');
    if (typeof domain.plan !== 'function' || typeof domain.apply !== 'function' || typeof domain.verify !== 'function') {
      throw new OrchestratorError('domain interface is incomplete');
    }
    seen.add(domain.name);
  }
  return rows;
}

function normalizeDomainPlan(value, domain) {
  if (!value || !Array.isArray(value.stages) || !Array.isArray(value.operations) || !Array.isArray(value.preconditions)) {
    throw new OrchestratorError('domain plan result is incomplete');
  }
  if (value.operations.some(operation => operation?.domain !== domain.name || operation?.domain_order !== domain.order)) {
    throw new OrchestratorError('domain planner emitted an operation it does not own');
  }
  return {
    stages: value.stages,
    operations: value.operations,
    preconditions: value.preconditions,
    clients: value.clients ?? [],
    actions: value.actions ?? [],
  };
}

function actionForSmoke(smoke) {
  if (smoke.status === 'INITIALIZE_FAILED') {
    return { code: 'INITIALIZE_FAILED', message: 'The canonical descriptor did not complete MCP initialize.', command: null };
  }
  if (smoke.status === 'TOOLS_LIST_FAILED') {
    return { code: 'TOOLS_LIST_FAILED', message: 'The canonical descriptor initialized but did not complete the initial tools/list request.', command: null };
  }
  return null;
}

function receiptContractReference(reference) {
  return { kind: reference.kind, path_label: reference.path_label, sha256: reference.sha256 };
}

function currentActions(stages, clients) {
  const unique = new Map();
  const actions = [
    ...stages.flatMap(stage => stage.actions),
    ...clients.flatMap(client => client.actions),
  ];
  for (const action of actions) unique.set(sha256Canonical(action), action);
  return [...unique.values()];
}

function terminalDomainException(domain, error) {
  const actionCode = Object.hasOwn(ACTION_CODES, error?.code) ? error.code : 'SYNC_FAILED';
  return createStageResult({
    name: domain.name,
    status: 'SYNC_FAILED',
    result: 'failed',
    actions: [{
      code: actionCode,
      message: 'A deployment domain failed after earlier progress was committed.',
      command: null,
    }],
  });
}

export function createDeploymentOrchestrator({
  repoRoot,
  stateRoot,
  fsImpl,
  processRunner,
  clock = Date.now,
  domains = [],
  localState,
  sourceProvider,
  descriptorProvider,
  fingerprint = null,
  receiptWriter = writeReceipt,
  protocolSmoke = smokeDescriptor,
  includeGenericClient = true,
  applyWaitMs = 30_000,
} = {}) {
  if (!repoRoot || !stateRoot) throw new OrchestratorError('repoRoot and stateRoot are required');
  if (!localState) throw new OrchestratorError('localState is required');
  if (typeof sourceProvider !== 'function' || typeof descriptorProvider !== 'function') {
    throw new OrchestratorError('source and descriptor providers are required');
  }
  const orderedDomains = validateDomains(domains);

  async function buildContext(normalized, overrides = {}) {
    const source = overrides.source ?? await sourceProvider({ repoRoot, processRunner, fsImpl });
    const descriptor = overrides.descriptor ?? await descriptorProvider({ repoRoot, processRunner, fsImpl });
    return {
      repoRoot,
      stateRoot,
      fsImpl,
      processRunner,
      localState,
      operation: normalized.operation,
      request: normalized.request,
      source,
      descriptor,
      now: normalizeClock(clock),
    };
  }

  async function appendGenericSupport(context, aggregate) {
    if (!includeGenericClient || aggregate.clients.length > 0) return;
    const smoke = await protocolSmoke(context.descriptor);
    const client = createGenericClientResult({ descriptor: context.descriptor, smoke });
    aggregate.clients.push(client);
    aggregate.actions.push(...client.actions);
    aggregate.stages.push(createStageResult({
      name: 'clients',
      status: 'MANUAL_REGISTRATION_REQUIRED',
      result: 'action_required',
      actions: client.actions,
    }));
    const smokeAction = actionForSmoke(smoke);
    aggregate.stages.push(createStageResult({
      name: 'protocol',
      status: smoke.status,
      result: smoke.status === 'HEALTHY' ? 'ready' : 'action_required',
      evidence: {
        instruction_bytes: smoke.instruction_bytes,
        tool_count: smoke.tool_count,
        initial_tool_names: smoke.initial_tool_names,
        duration_ms: smoke.duration_ms,
      },
      actions: smokeAction ? [smokeAction] : [],
    }));
    if (smokeAction) aggregate.actions.push(smokeAction);
  }

  async function createPlan(input, forcedOperation = null) {
    const normalized = normalizeRequest(input, forcedOperation);
    if (!['setup', 'sync', 'repair'].includes(normalized.operation)) {
      throw new OrchestratorError('plan operation is invalid', 'INVALID_REQUEST');
    }
    const context = await buildContext(normalized);
    const aggregate = { stages: [], operations: [], preconditions: [], clients: [], actions: [] };
    for (const domain of orderedDomains) {
      const planned = normalizeDomainPlan(await domain.plan(context), domain);
      aggregate.stages.push(...planned.stages);
      aggregate.operations.push(...planned.operations);
      aggregate.preconditions.push(...planned.preconditions);
      aggregate.clients.push(...planned.clients);
      aggregate.actions.push(...planned.actions);
      if (domain.name === 'prerequisites' && planned.operations.length === 0 && reduceOutcome(planned.stages) !== 'HEALTHY') {
        break;
      }
    }
    await appendGenericSupport(context, aggregate);
    if (aggregate.stages.length === 0) {
      aggregate.stages.push(createStageResult({ name: 'prerequisites', status: 'NOT_CHECKED', result: 'action_required' }));
    }
    return createPlanDocument({
      operation: normalized.operation,
      outcome: reduceOutcome(aggregate.stages),
      source: context.source,
      request: normalized.request,
      descriptor: context.descriptor,
      stages: aggregate.stages,
      clients: aggregate.clients,
      operations: aggregate.operations,
      preconditions: aggregate.preconditions,
      actions: aggregate.actions,
      now: context.now,
    });
  }

  async function preconditionFingerprint(precondition, context) {
    if (typeof fingerprint === 'function') return fingerprint(precondition, context);
    const domain = orderedDomains.find(candidate => typeof candidate.fingerprintPrecondition === 'function'
      && candidate.canFingerprintPrecondition?.(precondition) !== false);
    if (domain) return domain.fingerprintPrecondition(precondition, context);
    return fingerprintPath(precondition.canonical_path, {
      allowedRoots: [dirname(precondition.canonical_path)],
      fsImpl,
    });
  }

  async function apply({ plan, approvedDigest }) {
    validatePlanEnvelope({ plan, approvedDigest, now: normalizeClock(clock) });
    const registeredDomains = new Set(orderedDomains.map(domain => domain.name));
    if (plan.operations.some(operation => !registeredDomains.has(operation.domain))) {
      throw new OrchestratorError('plan requires a deployment domain that is unavailable', 'UNSUPPORTED_INTERFACE');
    }
    const lease = await localState.acquireApplyLease({
      waitMs: applyWaitMs,
      expiresAt: plan.expires_at,
    });
    try {
      const normalized = normalizeRequest({ operation: plan.operation, ...plan.request });
      const context = await buildContext(normalized, { source: plan.source, descriptor: plan.descriptor });
      await validatePlanForApply({
        plan,
        approvedDigest,
        now: context.now,
        fingerprint: precondition => preconditionFingerprint(precondition, context),
        localState,
      });
      const currentSource = await sourceProvider({ repoRoot, processRunner, fsImpl });
      const currentDescriptor = await descriptorProvider({ repoRoot, processRunner, fsImpl });
      if (sha256Canonical(currentSource) !== sha256Canonical(plan.source) || !descriptorsEqual(currentDescriptor, plan.descriptor)) {
        throw new OrchestratorError('source or descriptor changed after planning', 'PLAN_STALE');
      }

      const stages = [];
      for (const domain of orderedDomains) {
        const operations = plan.operations.filter(operation => operation.domain === domain.name);
        let stage;
        let stageOutcome;
        try {
          stage = operations.length > 0
            ? await domain.apply(context, operations)
            : await domain.verify(context);
          stageOutcome = reduceOutcome([stage]);
        } catch (error) {
          if (!shouldRecordPlanDigest(stages)) throw error;
          stages.push(terminalDomainException(domain, error));
          break;
        }
        stages.push(stage);
        if (domain.name === 'prerequisites' && stageOutcome !== 'HEALTHY') break;
      }
      if (stages.length === 0) stages.push(createStageResult({ name: 'prerequisites', status: 'NOT_CHECKED', result: 'action_required' }));
      let clients = plan.clients;
      if (includeGenericClient && plan.clients.some(client => client.adapter === 'generic-mcp-host')) {
        const generic = { stages: [], clients: [], actions: [] };
        await appendGenericSupport(context, generic);
        stages.push(...generic.stages);
        clients = generic.clients;
      }
      const actions = currentActions(stages, clients);
      const planSummary = {
        digest: plan.digest,
        created_at: plan.created_at,
        expires_at: plan.expires_at,
        preconditions_valid: true,
      };
      const initial = createMachineResult({
        operation: 'apply',
        source: plan.source,
        request: plan.request,
        descriptor: plan.descriptor,
        plan: planSummary,
        stages,
        clients,
        receipts: [],
        actions,
        now: context.now,
      });
      const receipt = await receiptWriter({ localState, result: initial, plan });
      const result = createMachineResult({
        operation: 'apply',
        source: plan.source,
        request: plan.request,
        descriptor: plan.descriptor,
        plan: planSummary,
        stages,
        clients,
        receipts: [receiptContractReference(receipt)],
        actions,
        now: context.now,
      });
      if (shouldRecordPlanDigest(stages)) {
        await localState.markDigestApplied(plan.digest, { receipt_sha256: receipt.sha256 });
      }
      return result;
    } finally {
      await lease.release();
    }
  }

  async function inspect(input, operation) {
    const normalized = normalizeRequest({ ...input, operation });
    const context = await buildContext(normalized);
    const aggregate = { stages: [], clients: [], actions: [] };
    for (const domain of orderedDomains) {
      const stage = await domain.verify(context);
      aggregate.stages.push(stage);
      aggregate.actions.push(...stage.actions);
    }
    await appendGenericSupport(context, aggregate);
    if (aggregate.stages.length === 0) aggregate.stages.push(createStageResult({ name: 'prerequisites', status: 'NOT_CHECKED', result: 'action_required' }));
    return createMachineResult({
      operation,
      source: context.source,
      request: normalized.request,
      descriptor: context.descriptor,
      plan: null,
      stages: aggregate.stages,
      clients: aggregate.clients,
      receipts: [],
      actions: aggregate.actions,
      now: context.now,
    });
  }

  return Object.freeze({
    plan: input => createPlan(input),
    apply,
    verify: input => inspect(input, 'verify'),
    doctor: input => inspect(input, 'doctor'),
    repair: input => createPlan(input, 'repair'),
  });
}
