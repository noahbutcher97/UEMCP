import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { validateDescriptorContract } from './contracts.mjs';

class SmokeDeadlineError extends Error {
  constructor(phase) {
    super(`${phase} deadline exceeded`);
    this.name = 'SmokeDeadlineError';
    this.code = 'SMOKE_DEADLINE';
  }
}

function nowMs() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function withDeadline(promise, timeoutMs, phase) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolvePromise, rejectPromise) => {
      timer = setTimeout(() => rejectPromise(new SmokeDeadlineError(phase)), timeoutMs);
      timer.unref?.();
    }),
  ]).finally(() => clearTimeout(timer));
}

function exactChildEnvironment(descriptorEnvironment) {
  return { PATH: '', ...descriptorEnvironment };
}

function baseEvidence(status, started) {
  return {
    status,
    initialize: null,
    instruction_bytes: 0,
    tool_count: 0,
    initial_tool_names: [],
    duration_ms: Math.max(0, nowMs() - started),
  };
}

export async function smokeDescriptor(descriptor, {
  clientInfo = { name: 'uemcp-deployment-smoke', version: '1.0.0' },
  timeoutMs = 15_000,
  expectedServerName = 'uemcp',
  transportFactory = parameters => new StdioClientTransport(parameters),
  effectiveEnvironment = null,
  effectiveCwd = null,
} = {}) {
  const validatedDescriptor = validateDescriptorContract(descriptor);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('timeoutMs must be a positive integer');
  if (typeof transportFactory !== 'function') throw new Error('transportFactory must be a function');
  if (effectiveEnvironment !== null
    && (!effectiveEnvironment || typeof effectiveEnvironment !== 'object' || Array.isArray(effectiveEnvironment)
      || Object.values(effectiveEnvironment).some(value => typeof value !== 'string'))) {
    throw new Error('effectiveEnvironment must be a string map or null');
  }
  if (effectiveCwd !== null && (typeof effectiveCwd !== 'string' || effectiveCwd.trim() === '')) {
    throw new Error('effectiveCwd must be a non-empty string or null');
  }
  const started = nowMs();
  const parameters = {
    command: validatedDescriptor.command,
    args: [...validatedDescriptor.args],
    env: effectiveEnvironment === null
      ? exactChildEnvironment(validatedDescriptor.env)
      : { ...effectiveEnvironment },
    stderr: 'pipe',
  };
  const launchCwd = effectiveCwd ?? validatedDescriptor.cwd;
  if (launchCwd !== null) parameters.cwd = launchCwd;
  const transport = transportFactory(parameters);
  const client = new Client(clientInfo, { capabilities: {} });
  let stderrBytes = 0;
  transport.stderr?.on?.('data', chunk => {
    stderrBytes = Math.min(8 * 1024, stderrBytes + Buffer.byteLength(chunk));
  });

  try {
    try {
      await withDeadline(client.connect(transport, { timeout: timeoutMs }), timeoutMs, 'initialize');
      const serverInfo = client.getServerVersion();
      if (!serverInfo || serverInfo.name !== expectedServerName) return baseEvidence('INITIALIZE_FAILED', started);
    } catch {
      return baseEvidence('INITIALIZE_FAILED', started);
    }

    const serverInfo = client.getServerVersion();
    const instructions = client.getInstructions() ?? '';
    let tools;
    try {
      tools = await withDeadline(client.listTools({}, { timeout: timeoutMs }), timeoutMs, 'tools/list');
    } catch {
      return {
        ...baseEvidence('TOOLS_LIST_FAILED', started),
        initialize: {
          server_name: serverInfo.name,
          server_version: serverInfo.version,
        },
        instruction_bytes: Buffer.byteLength(instructions, 'utf8'),
      };
    }
    const names = tools.tools.map(tool => tool.name).sort();
    return {
      status: 'HEALTHY',
      initialize: {
        server_name: serverInfo.name,
        server_version: serverInfo.version,
      },
      instruction_bytes: Buffer.byteLength(instructions, 'utf8'),
      tool_count: names.length,
      initial_tool_names: names,
      duration_ms: Math.max(0, nowMs() - started),
    };
  } finally {
    await withDeadline(client.close(), Math.min(5_000, Math.max(1_000, timeoutMs)), 'close').catch(() => {});
  }
}

export function createGenericClientResult({ descriptor, smoke }) {
  validateDescriptorContract(descriptor);
  if (!smoke || !['HEALTHY', 'INITIALIZE_FAILED', 'TOOLS_LIST_FAILED'].includes(smoke.status)) {
    throw new Error('generic client result requires protocol-smoke evidence');
  }
  return {
    adapter: 'generic-mcp-host',
    version: null,
    compatibility: 'known_unsupported',
    write_supported: false,
    selected: true,
    scope: 'manual',
    status: 'MANUAL_REGISTRATION_REQUIRED',
    enablement: 'UNKNOWN',
    activation: 'UNKNOWN',
    actions: [{
      code: 'MANUAL_REGISTRATION_REQUIRED',
      message: 'Register the canonical stdio descriptor manually; host configuration, enablement, trust, and restart remain host-owned.',
      command: null,
    }],
  };
}
