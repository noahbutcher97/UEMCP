#!/usr/bin/env node
// run-native-tests.mjs — runs the plugin's UE automation tests headless on one
// target and exits non-zero on any failure. Resolves the target from
// .uemcp-targets.json (like verify-deploy), the engine from UE_ENGINE_ROOT or
// the .uproject's EngineAssociation, spawns UnrealEditor-Cmd through the
// bounded process runner, and parses the exported report.
// Exit: 0 pass · 1 failures/not-run · 2 preflight/config · 3 timeout · 4 no tests

import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createProcessRunner } from './deployment/process-runner.mjs';
import { listEditorProcesses } from './editor-processes.mjs';
import { resolveEngineRoot } from './engine-fixtures.mjs';
import { parseAutomationReport, reportExitCode, summarizeReport, NativeReportError } from './native-test-report.mjs';
import { readProjectTargets } from './project-targets.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;

export function parseRunnerArgs(argv) {
  const out = { profile: null, target: null, uproject: null, engineRoot: null, filter: 'UEMCP', timeoutMs: DEFAULT_TIMEOUT_MS, reportDir: null, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') out.profile = argv[++i];
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--uproject') out.uproject = argv[++i];
    else if (a === '--engine-root') out.engineRoot = argv[++i];
    else if (a === '--filter') out.filter = argv[++i];
    else if (a === '--timeout-ms') out.timeoutMs = parseInt(argv[++i], 10);
    else if (a === '--report-dir') out.reportDir = argv[++i];
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

export function resolveEngineRootForProject({ engineAssociation, env = process.env, existsImpl }) {
  if (env.UE_ENGINE_ROOT && existsImpl(env.UE_ENGINE_ROOT)) return env.UE_ENGINE_ROOT;
  const version = /^\d+\.\d+$/.test(engineAssociation ?? '') ? engineAssociation : null;
  return resolveEngineRoot({ env: {}, preferVersion: version, existsImpl });
}

export function buildEditorCommand({ engineRoot, uprojectPath, filter, reportDir, extraArgs = [] }) {
  return {
    // Forward-slash join, not node:path's join(): engineRoot and uprojectPath
    // are repo-convention forward-slash paths (see project-identity.mjs
    // displayPath()), and join() would emit backslashes on Windows here.
    // Windows accepts forward-slash paths for spawned executables fine.
    file: `${engineRoot.replace(/[\\/]+$/, '')}/Engine/Binaries/Win64/UnrealEditor-Cmd.exe`,
    args: [
      uprojectPath,
      `-ExecCmds=Automation RunTests ${filter};Quit`,
      '-TestExit=Automation Test Queue Empty',
      `-ReportExportPath=${reportDir}`,
      '-unattended', '-nopause', '-nosplash', '-nullrhi', '-NoSound', '-nop4', '-log', '-stdout', '-FullStdOutLogOutput',
      ...extraArgs,
    ],
  };
}

function pickTarget(args) {
  if (args.uproject) return { uprojectPath: resolve(args.uproject), targetAlias: null };
  const targets = readProjectTargets({ repoRoot: REPO_ROOT, profile: args.profile ?? undefined });
  const candidates = targets.candidates ?? [];
  if (candidates.length === 0) throw Object.assign(new Error(`no targets resolved (status ${targets.status}); pass --uproject or add .uemcp-targets.json`), { exitCode: 2 });
  if (args.target) {
    const hit = candidates.find(c => c.targetAlias === args.target);
    if (!hit) throw Object.assign(new Error(`target alias not found: ${args.target}`), { exitCode: 2 });
    return hit;
  }
  return candidates[0];
}

export async function main(argv, { runner = createProcessRunner({ defaultOutputLimitBytes: 8 * 1024 * 1024 }), env = process.env } = {}) {
  const args = parseRunnerArgs(argv);
  if (args.help) {
    console.log('Usage: run-native-tests.bat [--profile <name>] [--target <alias>] [--uproject <path>] [--engine-root <path>] [--filter <prefix>] [--timeout-ms <n>] [--report-dir <dir>] [--dry-run]');
    return 0;
  }
  const target = pickTarget(args);
  const uprojectPath = target.uprojectPath;
  if (!existsSync(uprojectPath)) { console.error(`[ERROR] uproject not found: ${uprojectPath}`); return 2; }
  const uproject = JSON.parse(readFileSync(uprojectPath, 'utf8'));
  const engineRoot = args.engineRoot ?? resolveEngineRootForProject({ engineAssociation: uproject.EngineAssociation, env, existsImpl: existsSync });
  if (!engineRoot) { console.error(`[ERROR] no engine root: set UE_ENGINE_ROOT or pass --engine-root (EngineAssociation=${uproject.EngineAssociation})`); return 2; }
  const dll = join(dirname(uprojectPath), 'Plugins', 'UEMCP', 'Binaries', 'Win64', 'UnrealEditor-UEMCP.dll');
  if (!existsSync(dll)) { console.error(`[ERROR] plugin DLL not built: ${dll} (run Build.bat; verify-deploy.bat reports NEEDS-BUILD)`); return 2; }
  const editors = listEditorProcesses();
  if (editors.length > 0) {
    console.warn(`[WARN] ${editors.length} UnrealEditor process(es) running; the headless instance will share port 55558 with them.`);
  }
  const reportDir = args.reportDir ? resolve(args.reportDir) : mkdtempSync(join(tmpdir(), 'uemcp-native-'));
  const command = buildEditorCommand({ engineRoot, uprojectPath, filter: args.filter, reportDir });
  console.log(`Target : ${uprojectPath}${target.targetAlias ? ` (${target.targetAlias})` : ''}`);
  console.log(`Engine : ${engineRoot}`);
  console.log(`Filter : ${args.filter}`);
  console.log(`Report : ${reportDir}`);
  if (args.dryRun) { console.log(`Command: "${command.file}" ${command.args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`); return 0; }

  const started = Date.now();
  // process-runner: run(executable, args, { cwd, env, timeoutMs, outputLimitBytes, stdin })
  // resolves { status: 'exited' | 'timed_out' | 'spawn_failed' | ..., exitCode, signal, stdout, stderr }.
  // executable and cwd must be absolute paths.
  const result = await runner.run(command.file, command.args, { timeoutMs: args.timeoutMs, cwd: dirname(uprojectPath) });
  console.log(`Editor ${result.status}, exit ${result.exitCode ?? 'null'}, after ${Math.round((Date.now() - started) / 1000)}s`);
  if (result.status === 'timed_out') { console.error(`[ERROR] timed out after ${args.timeoutMs}ms; process tree killed`); return 3; }
  if (result.status === 'spawn_failed') { console.error(`[ERROR] could not start ${command.file}: ${result.stderr}`); return 2; }

  const indexPath = join(reportDir, 'index.json');
  if (!existsSync(indexPath)) { console.error(`[ERROR] no report at ${indexPath}; last stderr:\n${(result.stderr ?? '').slice(-2000)}`); return 4; }
  // UnrealEditor's -ReportExportPath writer emits index.json with a UTF-8 BOM
  // (verified against a live report: bytes EF BB BF before the opening brace);
  // JSON.parse does not strip it, so read it off before parsing. Not covered
  // by the committed fixture (index.sample.json has no BOM) or the rotation —
  // only this live run has exercised this line.
  let reportText = readFileSync(indexPath, 'utf8');
  if (reportText.charCodeAt(0) === 0xfeff) reportText = reportText.slice(1);
  let parsed;
  try { parsed = parseAutomationReport(JSON.parse(reportText)); }
  catch (e) { if (e instanceof NativeReportError) { console.error(`[ERROR] ${e.code}: ${e.message}`); return 4; } throw e; }
  for (const line of summarizeReport(parsed)) console.log(line);
  if (!args.reportDir && parsed.failed === 0) rmSync(reportDir, { recursive: true, force: true });
  return reportExitCode(parsed);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => { console.error(`[ERROR] ${err.message}`); process.exit(err.exitCode ?? 2); });
}
