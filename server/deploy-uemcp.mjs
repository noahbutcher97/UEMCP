#!/usr/bin/env node

import * as fsPromises from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { exitCodeForOutcome } from './deployment/contracts.mjs';
import { createClaudeAdapter } from './deployment/adapters/claude.mjs';
import { createCodexAdapter } from './deployment/adapters/codex.mjs';
import { createGeminiAdapter } from './deployment/adapters/gemini.mjs';
import { createVsCodeAdapter } from './deployment/adapters/vscode.mjs';
import { verifyDeploymentBundleFreshness } from './deployment/bundle-freshness.mjs';
import { CLIENT_IDS } from './deployment/client-contract.mjs';
import { createClientDomain } from './deployment/client-domain.mjs';
import { captureClientPathFingerprint, createClientTransaction } from './deployment/client-transaction.mjs';
import { createCanonicalDescriptor } from './deployment/descriptor.mjs';
import { createLocalState } from './deployment/local-state.mjs';
import { createDeploymentOrchestrator } from './deployment/orchestrator.mjs';
import { createPrerequisiteDomain } from './deployment/prerequisites.mjs';
import { createProcessRunner } from './deployment/process-runner.mjs';
import { inspectSourceProvenance } from './deployment/source-provenance.mjs';
import { createTargetDomain } from './deployment/target-domain.mjs';

const HELP = `UEMCP deployment machine interface

Usage:
  deploy-uemcp.mjs plan --operation <setup|sync> [--project <path.uproject>] [--profile <name>] [--include-client <id>] [--exclude-client <id>] [--vscode-profile <name>] [--targets-file <absolute.json>] [--json]
  deploy-uemcp.mjs apply --plan-file <path.json> --approve-digest <sha256> --non-interactive [--json]
  deploy-uemcp.mjs verify [--project <path.uproject>] [--profile <name>] [--include-client <id>] [--exclude-client <id>] [--vscode-profile <name>] [--targets-file <absolute.json>] [--json]
  deploy-uemcp.mjs doctor [--project <path.uproject>] [--profile <name>] [--include-client <id>] [--exclude-client <id>] [--vscode-profile <name>] [--targets-file <absolute.json>] [--json]
  deploy-uemcp.mjs repair [--project <path.uproject>] [--profile <name>] [--include-client <id>] [--exclude-client <id>] [--vscode-profile <name>] [--targets-file <absolute.json>] [--json]
`;
const INTERFACE_ERROR_CODES = new Set(['CLI_USAGE', 'INVALID_CONTRACT', 'INVALID_PLAN', 'UNSUPPORTED_INTERFACE']);
const SAFE_DIAGNOSTICS = Object.freeze({
  APPLY_IN_PROGRESS: 'another deployment apply is in progress',
  BUNDLE_FRESHNESS_FAILED: 'deployment bundle freshness verification failed',
  CLIENT_INSPECTION_UNBOUND: 'selected client inspection could not produce complete apply evidence',
  DEPENDENCY_POLICY_BLOCKED: 'dependency policy blocked deployment',
  INSTALL_FAILED: 'dependency installation failed',
  INVALID_CONTRACT: 'machine contract validation failed',
  INVALID_PLAN: 'plan schema validation failed',
  INVALID_REQUEST: 'deployment request validation failed',
  INVALID_TARGET: 'project target validation failed',
  LOCAL_STATE_UNAVAILABLE: 'machine-local deployment state is unavailable',
  LOCK_DRIFT: 'package lock evidence changed',
  NODE_MISSING: 'a supported Node runtime is required',
  NODE_UNSUPPORTED: 'the selected Node runtime is unsupported',
  ORCHESTRATOR_FAILED: 'deployment orchestration failed',
  PLAN_DIGEST_MISMATCH: 'plan digest validation failed',
  PLAN_EXPIRED: 'the reviewed plan expired',
  PLAN_REPLAYED: 'the reviewed plan was already consumed',
  PLAN_STALE: 'one or more reviewed preconditions changed',
  ROLLBACK_CONFLICT: 'deployment rollback could not safely restore prior state',
  SOURCE_PROVENANCE_UNKNOWN: 'source provenance could not be established',
  UNSUPPORTED_INTERFACE: 'deployment interface is unsupported',
});

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = 'CLI_USAGE';
  }
}

function takeValue(argv, index, flag) {
  const value = argv[index + 1];
  if (value === undefined || value.startsWith('--')) throw new UsageError(`${flag} requires a value`);
  return value;
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || argv.length === 0 || argv[0] === '--help' || argv[0] === 'help') return { command: 'help' };
  const command = argv[0];
  if (!['plan', 'apply', 'verify', 'doctor', 'repair'].includes(command)) throw new UsageError('unknown command');
  const parsed = {
    command,
    json: false,
    operation: null,
    project: null,
    profile: null,
    targetsFile: null,
    planFile: null,
    approveDigest: null,
    nonInteractive: false,
    includeClients: [],
    excludeClients: [],
    vscodeProfile: null,
  };
  const seen = new Set();
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    const repeatable = flag === '--include-client' || flag === '--exclude-client';
    if (!repeatable && seen.has(flag)) throw new UsageError('duplicate flag');
    if (!repeatable) seen.add(flag);
    if (flag === '--json') parsed.json = true;
    else if (flag === '--non-interactive') parsed.nonInteractive = true;
    else if (flag === '--operation') { parsed.operation = takeValue(argv, index, flag); index += 1; }
    else if (flag === '--project') { parsed.project = takeValue(argv, index, flag); index += 1; }
    else if (flag === '--profile') { parsed.profile = takeValue(argv, index, flag); index += 1; }
    else if (flag === '--targets-file') { parsed.targetsFile = takeValue(argv, index, flag); index += 1; }
    else if (flag === '--plan-file') { parsed.planFile = takeValue(argv, index, flag); index += 1; }
    else if (flag === '--approve-digest') { parsed.approveDigest = takeValue(argv, index, flag); index += 1; }
    else if (flag === '--include-client' || flag === '--exclude-client') {
      const value = takeValue(argv, index, flag);
      if (!CLIENT_IDS.includes(value)) throw new UsageError('unknown client ID');
      const target = flag === '--include-client' ? parsed.includeClients : parsed.excludeClients;
      if (target.includes(value)) throw new UsageError('duplicate client selection');
      target.push(value);
      index += 1;
    }
    else if (flag === '--vscode-profile') { parsed.vscodeProfile = takeValue(argv, index, flag); index += 1; }
    else throw new UsageError('unknown flag');
  }
  const clientFlags = parsed.includeClients.length > 0 || parsed.excludeClients.length > 0 || parsed.vscodeProfile !== null;
  const requestFlags = parsed.project !== null || parsed.profile !== null || parsed.targetsFile !== null || clientFlags;
  if (command === 'plan') {
    if (!['setup', 'sync'].includes(parsed.operation)) throw new UsageError('plan requires --operation setup or sync');
    if (parsed.planFile || parsed.approveDigest || parsed.nonInteractive) throw new UsageError('plan does not accept apply flags');
  } else if (command === 'apply') {
    if (!parsed.planFile || !isAbsolute(parsed.planFile) || !parsed.approveDigest || !/^[0-9a-f]{64}$/.test(parsed.approveDigest) || !parsed.nonInteractive) {
      throw new UsageError('apply requires an absolute --plan-file, a lowercase --approve-digest, and --non-interactive');
    }
    if (requestFlags || parsed.operation !== null) throw new UsageError('apply request overrides are forbidden');
  } else {
    if (parsed.operation !== null || parsed.planFile || parsed.approveDigest || parsed.nonInteractive) {
      throw new UsageError(`${command} does not accept plan/apply flags`);
    }
  }
  if (parsed.targetsFile !== null && (!isAbsolute(parsed.targetsFile) || !parsed.targetsFile.toLowerCase().endsWith('.json'))) {
    throw new UsageError('--targets-file must be an absolute .json path');
  }
  if (parsed.project !== null && (!isAbsolute(parsed.project) || extname(parsed.project).toLowerCase() !== '.uproject')) {
    throw new UsageError('--project must be an absolute .uproject path');
  }
  if (parsed.profile !== null && parsed.profile.trim() === '') throw new UsageError('--profile must be non-empty');
  if (parsed.vscodeProfile !== null && parsed.vscodeProfile.trim() === '') throw new UsageError('--vscode-profile must be non-empty');
  if (parsed.project !== null && parsed.profile !== null) throw new UsageError('--project and --profile are mutually exclusive');
  if (parsed.includeClients.some(clientId => parsed.excludeClients.includes(clientId))) {
    throw new UsageError('client include and exclude selections overlap');
  }
  return parsed;
}

function locateRepository() {
  const moduleDirectory = dirname(fileURLToPath(import.meta.url));
  let candidate = moduleDirectory;
  for (let depth = 0; depth < 8; depth += 1) {
    const serverRoot = join(candidate, 'server');
    if (existsSync(join(serverRoot, 'server.mjs')) && existsSync(join(serverRoot, 'package-lock.json'))) {
      return { repoRoot: candidate, serverRoot };
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  if (basename(moduleDirectory).toLowerCase() === 'server' && existsSync(join(moduleDirectory, 'server.mjs'))) {
    return { repoRoot: dirname(moduleDirectory), serverRoot: moduleDirectory };
  }
  throw new UsageError('deployment entry is not inside a UEMCP repository');
}

export function createDefaultOrchestrator({ targetsFile = null, workspaceRoot = process.cwd() } = {}) {
  const { repoRoot, serverRoot } = locateRepository();
  const activeEntryPath = fileURLToPath(import.meta.url);
  const processRunner = createProcessRunner();
  const localState = createLocalState();
  const stateRoot = localState.paths().state;
  const domains = [
    createPrerequisiteDomain({
      serverRoot,
      runner: processRunner,
      localState,
      fsImpl: fsPromises,
      nodeExecutable: process.execPath,
    }),
    createTargetDomain({
      repoRoot,
      stateRoot,
      targetsPath: targetsFile,
      processRunner,
    }),
    createClientDomain({
      adapters: [
        createClaudeAdapter({ fsImpl: fsPromises, runner: processRunner }),
        createCodexAdapter({ fsImpl: fsPromises, runner: processRunner, captureFingerprint: captureClientPathFingerprint }),
        createGeminiAdapter({ fsImpl: fsPromises, runner: processRunner }),
        createVsCodeAdapter({ fsImpl: fsPromises }),
      ],
      transaction: ({ externalLease }) => createClientTransaction({
        localState,
        fsImpl: fsPromises,
        processRunner,
        externalLease,
      }),
      fsImpl: fsPromises,
    }),
  ];
  const manifestPath = join(repoRoot, 'dist', 'deploy-uemcp.manifest.json');
  return createDeploymentOrchestrator({
    repoRoot,
    workspaceRoot,
    stateRoot,
    fsImpl: fsPromises,
    processRunner,
    localState,
    domains,
    sourceProvider: async () => {
      await verifyDeploymentBundleFreshness({ repoRoot, activeEntryPath, fsImpl: fsPromises });
      return {
        ...await inspectSourceProvenance({
        repoRoot,
        bundleManifestPath: existsSync(manifestPath) ? manifestPath : null,
        runner: processRunner,
        fsImpl: fsPromises,
        }),
        orchestrator_version: '1.0.0',
      };
    },
    descriptorProvider: () => createCanonicalDescriptor({
      nodeExecutable: process.execPath,
      serverEntry: join(serverRoot, 'server.mjs'),
      allowedRoots: [dirname(process.execPath), serverRoot],
      fsImpl: fsPromises,
    }),
  });
}

function requestFrom(parsed) {
  return {
    ...(parsed.operation ? { operation: parsed.operation } : {}),
    requested_project: parsed.project,
    requested_profile: parsed.profile,
    selected_clients: parsed.includeClients,
    client_selection: {
      include: parsed.includeClients,
      exclude: parsed.excludeClients,
      vscode_profile: parsed.vscodeProfile,
    },
  };
}

function writeMachineValue(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function writeHumanValue(stream, value) {
  stream.write(`${value.operation ?? value.kind}: ${value.outcome ?? 'ready'}\n`);
  if (value.digest) stream.write(`digest: ${value.digest}\n`);
  for (const action of value.actions ?? []) stream.write(`action: ${action.code} - ${action.message}\n`);
}

export async function runCli(argv, {
  orchestrator = null,
  orchestratorFactory = createDefaultOrchestrator,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let parsed;
  try {
    parsed = parseArgs(argv);
    if (parsed.command === 'help') {
      stdout.write(HELP);
      return 0;
    }
    const activeOrchestrator = orchestrator ?? orchestratorFactory({ targetsFile: parsed.targetsFile });
    let value;
    if (parsed.command === 'plan') value = await activeOrchestrator.plan(requestFrom(parsed));
    else if (parsed.command === 'repair') value = await activeOrchestrator.repair(requestFrom(parsed));
    else if (parsed.command === 'verify') value = await activeOrchestrator.verify(requestFrom(parsed));
    else if (parsed.command === 'doctor') value = await activeOrchestrator.doctor(requestFrom(parsed));
    else {
      let plan;
      try {
        plan = JSON.parse(await fsPromises.readFile(resolve(parsed.planFile), 'utf8'));
      } catch {
        throw new UsageError('apply plan file is missing or malformed');
      }
      value = await activeOrchestrator.apply({ plan, approvedDigest: parsed.approveDigest });
    }
    if (parsed.json) writeMachineValue(stdout, value);
    else writeHumanValue(stdout, value);
    return exitCodeForOutcome(value.outcome);
  } catch (error) {
    const usage = error instanceof UsageError;
    const errorCode = usage ? 'CLI_USAGE' : Object.hasOwn(SAFE_DIAGNOSTICS, error?.code) ? error.code : 'FAILED';
    const exitCode = usage || INTERFACE_ERROR_CODES.has(errorCode) ? 64 : 30;
    const message = usage ? error.message : SAFE_DIAGNOSTICS[errorCode] ?? 'deployment command failed';
    stderr.write(`${errorCode}: ${message}\n`);
    return exitCode;
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await runCli(process.argv.slice(2));
}

export { HELP as DEPLOYMENT_CLI_HELP, parseArgs as parseDeploymentCliArgs };
