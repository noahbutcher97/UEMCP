import * as defaultFs from 'node:fs/promises';
import { isAbsolute, posix, resolve, win32 } from 'node:path';

import { fingerprintPath } from './fingerprints.mjs';

const DESCRIPTOR_KEYS = ['name', 'transport', 'command', 'args', 'env', 'cwd'];

export class DescriptorError extends Error {
  constructor(message, code = 'INVALID_DESCRIPTOR', details = {}) {
    super(message);
    this.name = 'DescriptorError';
    this.code = code;
    this.details = details;
  }
}

function normalizePath(value) {
  const normalized = resolve(value).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function absolutePath(value) {
  return typeof value === 'string' && (isAbsolute(value) || win32.isAbsolute(value) || posix.isAbsolute(value));
}

function exactDescriptorShape(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...DESCRIPTOR_KEYS].sort());
}

export async function createCanonicalDescriptor({ nodeExecutable, serverEntry, allowedRoots, fsImpl = defaultFs } = {}) {
  if (!absolutePath(nodeExecutable) || !absolutePath(serverEntry)) {
    throw new DescriptorError('descriptor paths must be absolute');
  }
  const node = await fingerprintPath(nodeExecutable, { allowedRoots, fsImpl });
  const server = await fingerprintPath(serverEntry, { allowedRoots, fsImpl });
  for (const [label, fingerprint] of [['Node executable', node], ['server entry', server]]) {
    if (!fingerprint.exists || fingerprint.kind !== 'file' || fingerprint.link_kind !== 'none') {
      throw new DescriptorError(`${label} must be a regular non-linked file`);
    }
  }
  return Object.freeze({
    name: 'uemcp',
    transport: 'stdio',
    command: node.real_path,
    args: Object.freeze([server.real_path]),
    env: Object.freeze({}),
    cwd: null,
  });
}

export function descriptorsEqual(actual, expected) {
  if (!exactDescriptorShape(actual) || !exactDescriptorShape(expected)) return false;
  if (actual.name !== expected.name || actual.transport !== expected.transport || actual.cwd !== expected.cwd) return false;
  if (!absolutePath(actual.command) || !absolutePath(expected.command) || normalizePath(actual.command) !== normalizePath(expected.command)) return false;
  if (!Array.isArray(actual.args) || !Array.isArray(expected.args) || actual.args.length !== expected.args.length) return false;
  for (let index = 0; index < actual.args.length; index += 1) {
    const left = actual.args[index];
    const right = expected.args[index];
    if (typeof left !== 'string' || typeof right !== 'string') return false;
    if (absolutePath(left) && absolutePath(right)) {
      if (normalizePath(left) !== normalizePath(right)) return false;
    } else if (left !== right) return false;
  }
  if (actual.env === null || expected.env === null || typeof actual.env !== 'object' || typeof expected.env !== 'object') return false;
  if (JSON.stringify(Object.fromEntries(Object.entries(actual.env).sort())) !== JSON.stringify(Object.fromEntries(Object.entries(expected.env).sort()))) return false;
  return true;
}
