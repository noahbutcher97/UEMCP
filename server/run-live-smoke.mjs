// Unified runner for opt-in live-editor smoke scripts.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, extname } from 'node:path';
import { evaluateLiveSmokeGate } from './live-smoke-harness.mjs';
import { readProjectTargets } from './project-targets.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const EXCLUDED = new Set(['live-smoke-harness.mjs']);

export function discoverLiveSmokeScripts({ dir = SERVER_DIR } = {}) {
  return readdirSync(dir)
    .filter((file) => /^live-smoke-.+\.mjs$/.test(file))
    .filter((file) => !EXCLUDED.has(file))
    .sort();
}

export function shouldSkipLiveSmokeSuite(env = process.env) {
  if (env.UEMCP_LIVE_SMOKE !== '1') {
    return {
      skip: true,
      reason: 'set UEMCP_LIVE_SMOKE=1 to allow live editor mutations',
    };
  }
  return { skip: false, reason: '' };
}

function parseRunnerArgs(argv = []) {
  const parsed = {
    project: '',
    target: '',
    targetsFirst: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--project') {
      parsed.project = argv[++i] || '';
    } else if (arg === '--target') {
      parsed.target = argv[++i] || '';
    } else if (arg === '--targets-first') {
      parsed.targetsFirst = true;
    }
  }
  return parsed;
}

function projectRootFromProjectArg(projectArg) {
  const text = String(projectArg || '').trim();
  if (!text) return '';
  return extname(text).toLowerCase() === '.uproject' ? dirname(text) : text;
}

function resolveTargetProjectRoot({ target, repoRoot = dirname(SERVER_DIR) } = {}) {
  const targets = readProjectTargets({ repoRoot });
  if (target) {
    const canonical = targets.aliases?.[target];
    const candidate = targets.candidates?.find(entry => entry.canonicalUprojectPath === canonical);
    return candidate?.projectRoot || '';
  }
  return targets.candidates?.[0]?.projectRoot || '';
}

export function resolveLiveSmokeRunnerConfig({
  env = process.env,
  argv = process.argv.slice(2),
  repoRoot = dirname(SERVER_DIR),
} = {}) {
  const childEnv = { ...env };
  const args = parseRunnerArgs(argv);

  let explicitProjectRoot = projectRootFromProjectArg(args.project);
  if (!explicitProjectRoot && args.target) {
    explicitProjectRoot = resolveTargetProjectRoot({ target: args.target, repoRoot });
  }
  if (!explicitProjectRoot && args.targetsFirst) {
    explicitProjectRoot = resolveTargetProjectRoot({ repoRoot });
  }
  if (explicitProjectRoot) {
    childEnv.UNREAL_PROJECT_ROOT = explicitProjectRoot;
    childEnv.UEMCP_LIVE_PROJECT_ROOT = explicitProjectRoot;
  }

  const gate = evaluateLiveSmokeGate(childEnv);
  return {
    exitCode: gate.exitCode,
    skipped: gate.skipped,
    shouldRun: gate.shouldRun,
    code: gate.code,
    reason: gate.reason,
    env: childEnv,
    projectRoot: gate.projectRoot || explicitProjectRoot || '',
  };
}

function compactDetail(stdout = '', stderr = '') {
  const lines = `${stderr}\n${stdout}`
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.slice(-8).join('\n');
}

export function classifySmokeProcessResult(result) {
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const exitCode = result.status === null || result.status === undefined ? -1 : result.status;

  if (exitCode === 0 && /⊘\s+skipped/i.test(`${stdout}\n${stderr}`)) {
    return { kind: 'SKIPPED', exitCode, detail: compactDetail(stdout, stderr) };
  }
  if (exitCode === 0) {
    return { kind: 'PASS', exitCode, detail: compactDetail(stdout, stderr) };
  }
  return { kind: 'FAIL', exitCode, detail: compactDetail(stdout, stderr) };
}

export function runSmokeScript(file, {
  dir = SERVER_DIR,
  env = process.env,
  timeoutMs = 15 * 60 * 1000,
  spawn = spawnSync,
} = {}) {
  const result = spawn(process.execPath, [file], {
    cwd: dir,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
  });
  return {
    file,
    ...classifySmokeProcessResult(result),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

export function runLiveSmokeSuite({
  dir = SERVER_DIR,
  env = process.env,
  argv = process.argv.slice(2),
  log = console.log,
  spawn = spawnSync,
} = {}) {
  const config = resolveLiveSmokeRunnerConfig({ env, argv, repoRoot: dirname(dir) });
  if (config.skipped) {
    log(`⊘ skipped live-smoke suite: ${config.reason}`);
    return { exitCode: 0, skipped: true, results: [] };
  }
  if (!config.shouldRun) {
    log(`${config.code || 'BLOCKED_CONFIG'} live-smoke suite: ${config.reason}`);
    return { exitCode: config.exitCode || 2, skipped: false, results: [], code: config.code || 'BLOCKED_CONFIG' };
  }

  const files = discoverLiveSmokeScripts({ dir });
  if (files.length === 0) {
    log(`No live-smoke-*.mjs scripts found in ${dir}`);
    return { exitCode: 2, skipped: false, results: [] };
  }

  log(`UEMCP live-smoke runner — ${files.length} files in ${dir}`);
  const results = files.map((file) => {
    log(`  ${file.padEnd(38)} ...`);
    const result = runSmokeScript(file, { dir, env: config.env, spawn });
    if (result.kind === 'PASS') {
      log(`  ${file.padEnd(38)} PASS`);
    } else if (result.kind === 'SKIPPED') {
      log(`  ${file.padEnd(38)} SKIPPED`);
      if (result.detail) log(`    ${result.detail}`);
    } else {
      log(`  ${file.padEnd(38)} FAIL exit=${result.exitCode}`);
      if (result.detail) log(`    ${result.detail}`);
    }
    return result;
  });

  const failed = results.filter((result) => result.kind === 'FAIL').length;
  const passed = results.filter((result) => result.kind === 'PASS').length;
  const skipped = results.filter((result) => result.kind === 'SKIPPED').length;
  log('');
  log('═══ UEMCP live-smoke summary ═══');
  log(`  Passed:  ${passed}`);
  log(`  Skipped: ${skipped}`);
  log(`  Failed:  ${failed}`);

  return { exitCode: failed > 0 ? 1 : 0, skipped: false, results };
}

function isMain() {
  return basename(process.argv[1] || '') === basename(fileURLToPath(import.meta.url));
}

if (isMain()) {
  const result = runLiveSmokeSuite();
  process.exit(result.exitCode);
}
