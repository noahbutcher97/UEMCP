import * as defaultFs from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { canonicalJson, sha256Canonical } from './canonical-json.mjs';
import { redactSecrets } from './redaction.mjs';

const SHA256 = /^[0-9a-f]{64}$/;

export class ReceiptError extends Error {
  constructor(message, code = 'RECEIPT_INTEGRITY_FAILED', details = {}) {
    super(message);
    this.name = 'ReceiptError';
    this.code = code;
    this.details = details;
  }
}

function safeTimestamp(timestamp) {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) throw new ReceiptError('result timestamp is invalid');
  return date.toISOString().replace(/[-:.]/g, '');
}

function actionCodes(result) {
  const values = [];
  for (const action of result.actions ?? []) values.push(action.code);
  for (const stage of result.stages ?? []) for (const action of stage.actions ?? []) values.push(action.code);
  for (const client of result.clients ?? []) for (const action of client.actions ?? []) values.push(action.code);
  return [...new Set(values)].sort();
}

function sanitizeStage(stage) {
  return {
    name: stage.name,
    status: stage.status,
    mandatory: stage.mandatory,
    changed: stage.changed,
    evidence: redactSecrets(stage.evidence ?? {}),
    action_codes: [...new Set((stage.actions ?? []).map(action => action.code))].sort(),
  };
}

function sanitizeClient(client) {
  return {
    adapter: client.adapter,
    version: client.version,
    compatibility: client.compatibility,
    write_supported: client.write_supported,
    selected: client.selected,
    scope: client.scope,
    status: client.status,
    enablement: client.enablement,
    activation: client.activation,
    action_codes: [...new Set((client.actions ?? []).map(action => action.code))].sort(),
  };
}

function receiptBody({ result, plan, pathLabel }) {
  return {
    schema_version: '1.0',
    kind: 'uemcp.deployment.receipt',
    path_label: pathLabel,
    operation: result.operation,
    timestamp: result.timestamp,
    outcome: result.outcome,
    source: redactSecrets(result.source),
    request: redactSecrets(result.request),
    descriptor: {
      name: result.descriptor.name,
      transport: result.descriptor.transport,
      command: result.descriptor.command,
      args: [...result.descriptor.args],
      env: {},
      cwd: result.descriptor.cwd,
    },
    plan: {
      digest: plan.digest,
      created_at: plan.created_at,
      expires_at: plan.expires_at,
    },
    stages: (result.stages ?? []).map(sanitizeStage),
    clients: (result.clients ?? []).map(sanitizeClient),
    action_codes: actionCodes(result),
  };
}

export async function writeReceipt({ localState, result, plan }) {
  if (!localState?.paths || !localState?.writeJsonAtomic) throw new ReceiptError('local state is required to write a receipt');
  if (!SHA256.test(plan?.digest ?? '')) throw new ReceiptError('receipt requires a valid plan digest');
  const fileName = `${safeTimestamp(result.timestamp)}-${result.operation}-${plan.digest}.json`;
  const pathLabel = `receipts/${fileName}`;
  const path = join(localState.paths().receipts, fileName);
  const body = receiptBody({ result, plan, pathLabel });
  const receipt = { ...body, receipt_sha256: sha256Canonical(body) };
  await localState.writeJsonAtomic(path, receipt);
  return {
    kind: 'deployment',
    path_label: pathLabel,
    path,
    sha256: receipt.receipt_sha256,
  };
}

export async function readAndVerifyReceipt(path, { fsImpl = defaultFs } = {}) {
  let receipt;
  try {
    receipt = JSON.parse(await fsImpl.readFile(resolve(path), 'utf8'));
  } catch {
    throw new ReceiptError('receipt is missing or malformed');
  }
  if (receipt === null || typeof receipt !== 'object' || Array.isArray(receipt)) throw new ReceiptError('receipt must be an object');
  if (receipt.schema_version !== '1.0' || receipt.kind !== 'uemcp.deployment.receipt' || !SHA256.test(receipt.receipt_sha256 ?? '')) {
    throw new ReceiptError('receipt schema or hash is invalid');
  }
  if (receipt.path_label !== `receipts/${basename(resolve(path))}`) throw new ReceiptError('receipt path label does not match its file');
  const body = { ...receipt };
  delete body.receipt_sha256;
  if (sha256Canonical(body) !== receipt.receipt_sha256) throw new ReceiptError('receipt self-hash does not match its canonical bytes');
  canonicalJson(receipt);
  return receipt;
}
