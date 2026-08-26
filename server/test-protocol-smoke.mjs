// Exact-descriptor MCP initialize and initial tools/list tests.
//
// Run: cd server && node test-protocol-smoke.mjs

import { copyFileSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  cleanupCanonicalScratchRoot,
  createCanonicalScratchRoot,
  TestRunner,
} from './test-helpers.mjs';
import {
  createGenericClientResult,
  smokeDescriptor,
  withPinnedDescriptorLaunch,
} from './deployment/protocol-smoke.mjs';

const t = new TestRunner('Deployment Protocol Smoke Tests');
const here = dirname(fileURLToPath(import.meta.url));
const sampleServer = join(here, 'fixtures', 'deployment', 'fake-mcp-server.mjs');
const expectedManagementTools = Object.freeze([
  'attach_project',
  'connection_info',
  'detach_project',
  'detect_project',
  'disable_toolset',
  'enable_toolset',
  'find_tools',
  'list_project_targets',
  'list_toolsets',
  'refresh_project_context',
  'wait_for_editor',
]);

function makeRoot() {
  return createCanonicalScratchRoot('uemcp protocol smoke ');
}

function cleanup(root) {
  cleanupCanonicalScratchRoot(root, 'uemcp protocol smoke ');
}

function descriptor(script, mode = 'normal') {
  return {
    name: 'uemcp',
    transport: 'stdio',
    command: process.execPath,
    args: [script, mode],
    env: {},
    cwd: null,
  };
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Every descriptor process holds its exact executable and absolute script paths through completion.
{
  let pinDepth = 0;
  const mutableDescriptor = descriptor(sampleServer);
  const value = await withPinnedDescriptorLaunch(mutableDescriptor, {
    launchFilePinner: async ({ paths, callback }) => {
      t.assert(paths.includes(resolve(process.execPath)) && paths.includes(resolve(sampleServer)), 'descriptor launch pin receives the executable and absolute script paths');
      mutableDescriptor.command = join(dirname(process.execPath), 'replaced-node.exe');
      pinDepth += 1;
      try {
        return await callback(Object.freeze({
          assertPinned() {
            if (pinDepth !== 1) throw new Error('descriptor launch pin was lost');
          },
        }));
      } finally {
        pinDepth -= 1;
      }
    },
    callback: async (guard, pinnedDescriptor) => {
      guard.assertPinned();
      t.assert(pinDepth === 1, 'descriptor launch callback runs while exact files remain pinned');
      t.assert(pinnedDescriptor?.command === resolve(process.execPath)
        && pinnedDescriptor.args[0] === resolve(sampleServer)
        && Object.isFrozen(pinnedDescriptor)
        && Object.isFrozen(pinnedDescriptor.args), 'descriptor launch callback receives the frozen tuple whose files were pinned');
      return 'pinned';
    },
  });
  t.assert(value === 'pinned' && pinDepth === 0, 'descriptor launch pin returns callback results and releases afterward');
}

// Budget for the OS to reap a terminated process tree.
//
// Two seconds is deliberate and sufficient. Measured directly: a descendant is
// reaped in 0-1 ms when teardown works, and is STILL ALIVE at 60 s when it does
// not — the outcome is bimodal, with nothing in between. So a failure here is
// never "slow", it is a descendant that was never killed. Raising this budget
// only delays the report of a real leak; see
// docs/superpowers/specs/2026-08-25-descendant-teardown-leak.md.
async function waitForProcessExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid)) return true;
    await new Promise(resolvePromise => setTimeout(resolvePromise, 25));
  }
  return !processIsAlive(pid);
}

// A path with spaces launches without PATH, cwd, or project environment assistance.
{
  const root = makeRoot();
  try {
    const copiedServer = join(root, 'sample server.mjs');
    copyFileSync(sampleServer, copiedServer);
    const smoke = await smokeDescriptor(descriptor(copiedServer), {
      expectedServerName: 'sample-mcp',
      timeoutMs: 2_000,
    });
    t.assert(smoke.status === 'HEALTHY', 'exact descriptor initializes and lists tools');
    t.assert(smoke.initialize?.server_name === 'sample-mcp' && smoke.initialize?.server_version === '1.0.0-no-path', 'child receives no usable inherited PATH');
    t.assert(smoke.tool_count === 1 && smoke.initial_tool_names[0] === 'sample_tool', 'initial tools/list evidence is deterministic');
    t.assert(smoke.instruction_bytes > 0 && smoke.duration_ms >= 0, 'smoke records bounded instruction and duration evidence');

    const generic = createGenericClientResult({ descriptor: descriptor(copiedServer), smoke });
    t.assert(generic.status === 'MANUAL_REGISTRATION_REQUIRED' && generic.write_supported === false, 'unknown host remains manual and write-disabled');
    t.assert(generic.actions[0].code === 'MANUAL_REGISTRATION_REQUIRED' && generic.actions[0].command === null, 'manual guidance never authorizes an implicit command');
  } finally {
    cleanup(root);
  }
}

// Private launch overrides do not weaken the serialized canonical descriptor.
{
  const root = makeRoot();
  try {
    const canonical = descriptor(sampleServer, 'report-launch');
    const smoke = await smokeDescriptor(canonical, {
      expectedServerName: 'sample-mcp',
      timeoutMs: 2_000,
      effectiveEnvironment: { PATH: '', SMOKE_ENV_PROBE: 'private-value' },
      effectiveCwd: root,
    });
    t.assert(smoke.status === 'HEALTHY' && smoke.initialize?.server_version === `private-value|${resolve(root)}`, 'protocol smoke uses the exact private environment and cwd');
    t.assert(JSON.stringify(canonical) === JSON.stringify(descriptor(sampleServer, 'report-launch')), 'private launch overrides do not mutate the canonical descriptor');
  } finally {
    cleanup(root);
  }
}

// Initialize and list failures remain bounded and separately classified.
for (const [mode, expectedStatus] of [
  ['hang-initialize', 'INITIALIZE_FAILED'],
  ['fail-initialize', 'INITIALIZE_FAILED'],
  ['invalid-initialize', 'INITIALIZE_FAILED'],
  ['exit-early', 'INITIALIZE_FAILED'],
  ['hang-tools', 'TOOLS_LIST_FAILED'],
  ['fail-tools', 'TOOLS_LIST_FAILED'],
  ['invalid-tools', 'TOOLS_LIST_FAILED'],
]) {
  const smoke = await smokeDescriptor(descriptor(sampleServer, mode), {
    expectedServerName: 'sample-mcp',
    timeoutMs: 250,
  });
  t.assert(smoke.status === expectedStatus, `${mode} is bounded as ${expectedStatus}`);
}

// Protocol deadline for the output-bound cases, and the budget the byte bound
// must beat. Kept proportional so a slow/loaded machine does not read as a
// bound failure.
const PROTOCOL_DEADLINE_MS = 15_000;
const OUTPUT_BOUND_BUDGET_MS = 10_000;

// Oversized unterminated stdout and excessive stderr terminate before the protocol deadline.
// The assertion is deliberately RELATIVE: what matters is that the byte bound
// fires before the deadline, not that it fires within some absolute wall-clock
// budget. A fixed threshold made this flaky under full-rotation contention,
// where 72 concurrent subprocesses can stretch spawn+IO well past a tight bound.
for (const [mode, limitOption] of [
  ['flood-stdout', { stdoutLimitBytes: 16 * 1024 }],
  ['flood-stderr', { stderrLimitBytes: 16 * 1024 }],
]) {
  const smoke = await smokeDescriptor(descriptor(sampleServer, mode), {
    expectedServerName: 'sample-mcp',
    timeoutMs: PROTOCOL_DEADLINE_MS,
    ...limitOption,
  });
  t.assert(smoke.status === 'INITIALIZE_FAILED' && smoke.duration_ms < OUTPUT_BOUND_BUDGET_MS, `${mode} is output-bounded before the protocol deadline` + ` (${smoke.duration_ms}ms of ${PROTOCOL_DEADLINE_MS}ms)`);
}

// Protocol deadline cleanup terminates descendants, including when the direct peer exits on EOF.
for (const [mode, label] of [
  ['spawn-descendant-hang', 'hanging parent'],
  ['spawn-descendant-exit-on-eof', 'EOF-exiting parent'],
]) {
  const root = makeRoot();
  let descendantPid = null;
  try {
    const pidFile = join(root, 'descendant.pid');
    const smoke = await smokeDescriptor(descriptor(sampleServer, mode), {
      expectedServerName: 'sample-mcp',
      timeoutMs: 250,
      effectiveEnvironment: { PATH: '', UEMCP_DESCENDANT_PID_FILE: pidFile },
    });
    descendantPid = Number(readFileSync(pidFile, 'utf8'));
    t.assert(smoke.status === 'INITIALIZE_FAILED' && Number.isSafeInteger(descendantPid), `${label} deadline scenario starts one recorded descendant process`);
    t.assert(await waitForProcessExit(descendantPid), `${label} protocol close terminates the complete stdio process tree`);
  } finally {
    if (descendantPid !== null && processIsAlive(descendantPid)) {
      try {
        process.kill(descendantPid, 'SIGKILL');
      } catch {
        // The descendant may have exited during cleanup.
      }
    }
    cleanup(root);
  }
}

// The real no-project UEMCP server proves the same descriptor contract.
{
  const smoke = await smokeDescriptor({
    name: 'uemcp',
    transport: 'stdio',
    command: process.execPath,
    args: [join(here, 'server.mjs')],
    env: {},
    cwd: null,
  }, {
    expectedServerName: 'uemcp',
    timeoutMs: 15_000,
  });
  t.assert(smoke.status === 'HEALTHY', 'real no-project UEMCP descriptor initializes and lists tools');
  t.assert(smoke.instruction_bytes > 0 && smoke.instruction_bytes <= 2_048, 'real server instructions remain within the deployment contract');
  t.assert(smoke.tool_count === 11, `real no-project server exposes eleven management tools (got ${smoke.tool_count})`);
  t.assert(JSON.stringify(smoke.initial_tool_names) === JSON.stringify(expectedManagementTools), 'real initial tool names match the provider-neutral management surface');
}

const failed = t.summary();
process.exit(failed ? 1 : 0);
