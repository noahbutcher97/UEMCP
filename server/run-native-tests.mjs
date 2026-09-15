#!/usr/bin/env node
// run-native-tests.mjs — runs the plugin's UE automation tests headless on one
// target and exits non-zero on any failure. Resolves the target from
// .uemcp-targets.json (like verify-deploy), the engine from UE_ENGINE_ROOT or
// the .uproject's EngineAssociation, spawns UnrealEditor-Cmd through the
// bounded process runner, and parses the exported report.
// Exit: 0 pass · 1 failures/not-run · 2 preflight/config · 3 timeout · 4 no tests

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
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
  const out = { profile: null, target: null, uproject: null, engineRoot: null, filter: 'UEMCP', timeoutMs: DEFAULT_TIMEOUT_MS, reportDir: null, dryRun: false, help: false, extraArgs: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--profile') out.profile = argv[++i];
    else if (a === '--target') out.target = argv[++i];
    else if (a === '--uproject') out.uproject = argv[++i];
    else if (a === '--engine-root') out.engineRoot = argv[++i];
    else if (a === '--filter') out.filter = argv[++i];
    else if (a === '--timeout-ms') out.timeoutMs = parseInt(argv[++i], 10);
    else if (a === '--report-dir') out.reportDir = argv[++i];
    else if (a === '--extra-arg') {
      if (i + 1 >= argv.length) throw new Error('--extra-arg needs a value (an argument for UnrealEditor-Cmd)');
      out.extraArgs.push(argv[++i]);
    }
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else throw new Error(`Unknown arg: ${a}`);
  }
  return out;
}

// UnrealEditor's -ReportExportPath writer emits index.json with a UTF-8 BOM
// (verified against a live report: bytes EF BB BF before the opening brace);
// JSON.parse does not strip it, so read it off before parsing.
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// 2s slack for coarse filesystem timestamp resolution (some filesystems round
// mtime to whole seconds), so a report written just before `startedAt` isn't
// misclassified as stale.
const REPORT_STALE_SLACK_MS = 2000;

/**
 * Read and parse the automation report at `reportPath`, refusing a report
 * left over from an earlier run instead of silently scoring this run against
 * it. Throws NativeReportError with code REPORT_MISSING (file absent),
 * REPORT_STALE (mtime predates `startedAt` — the editor died before writing
 * a fresh one), or REPORT_UNREADABLE (not valid JSON); otherwise returns
 * parseAutomationReport's result (which still throws REPORT_SCHEMA_UNKNOWN
 * on an unrecognized shape).
 */
export function loadReport(reportPath, startedAt) {
  if (!existsSync(reportPath)) {
    throw new NativeReportError(`no report at ${reportPath}`, 'REPORT_MISSING');
  }
  if (statSync(reportPath).mtimeMs < startedAt - REPORT_STALE_SLACK_MS) {
    throw new NativeReportError(`report at ${reportPath} predates this run — left over from an earlier invocation`, 'REPORT_STALE');
  }
  let json;
  try {
    json = JSON.parse(stripBom(readFileSync(reportPath, 'utf8')));
  } catch (e) {
    throw new NativeReportError(`could not parse ${reportPath}: ${e.message}`, 'REPORT_UNREADABLE');
  }
  return parseAutomationReport(json);
}

export function resolveEngineRootForProject({ engineAssociation, env = process.env, existsImpl }) {
  if (env.UE_ENGINE_ROOT && existsImpl(env.UE_ENGINE_ROOT)) return env.UE_ENGINE_ROOT;
  const version = /^\d+\.\d+$/.test(engineAssociation ?? '') ? engineAssociation : null;
  return resolveEngineRoot({ env: {}, preferVersion: version, existsImpl });
}

/**
 * Merges caller-supplied editor arguments into the standard list. Unreal's
 * FParse::Value takes the FIRST -Name= occurrence, so an extra that shares a
 * -Name= prefix with a standard argument replaces it in place (case-insensitive,
 * never the uproject at index 0); every other extra appends in the order given.
 */
export function applyExtraArgs(standardArgs, extraArgs) {
  const args = [...standardArgs];
  for (const extra of extraArgs) {
    const eq = extra.indexOf('=');
    const prefix = extra.startsWith('-') && eq > 0 ? extra.slice(0, eq + 1).toLowerCase() : null;
    const at = prefix ? args.findIndex((a, i) => i > 0 && a.toLowerCase().startsWith(prefix)) : -1;
    if (at >= 0) args[at] = extra;
    else args.push(extra);
  }
  return args;
}

export function buildEditorCommand({ engineRoot, uprojectPath, filter, reportDir, extraArgs = [] }) {
  return {
    // Forward-slash join, not node:path's join(): engineRoot and uprojectPath
    // are repo-convention forward-slash paths (see project-identity.mjs
    // displayPath()), and join() would emit backslashes on Windows here.
    // Windows accepts forward-slash paths for spawned executables fine.
    file: `${engineRoot.replace(/[\\/]+$/, '')}/Engine/Binaries/Win64/UnrealEditor-Cmd.exe`,
    args: applyExtraArgs([
      uprojectPath,
      `-ExecCmds=Automation RunTests ${filter};Quit`,
      '-TestExit=Automation Test Queue Empty',
      `-ReportExportPath=${reportDir}`,
      '-unattended', '-nopause', '-nosplash', '-nullrhi', '-NoSound', '-nop4', '-log', '-stdout', '-FullStdOutLogOutput',
    ], extraArgs),
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
    console.log('Usage: run-native-tests.bat [--profile <name>] [--target <alias>] [--uproject <path>] [--engine-root <path>] [--filter <prefix>] [--timeout-ms <n>] [--report-dir <dir>] [--dry-run] [--extra-arg <value>]...');
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
  const reportDir = args.reportDir ? resolve(args.reportDir) : mkdtempSync(join(tmpdir(), 'uemcp-native-'));
  const command = buildEditorCommand({ engineRoot, uprojectPath, filter: args.filter, reportDir, extraArgs: args.extraArgs });
  console.log(`Target : ${uprojectPath}${target.targetAlias ? ` (${target.targetAlias})` : ''}`);
  console.log(`Engine : ${engineRoot}`);
  console.log(`Filter : ${args.filter}`);
  console.log(`Report : ${reportDir}`);
  if (args.dryRun) { console.log(`Command: "${command.file}" ${command.args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ')}`); return 0; }

  const editors = listEditorProcesses();
  if (editors.length > 0) console.warn(`[WARN] ${editors.length} UnrealEditor process(es) running; the headless instance will share port 55558 with them.`);
  const started = Date.now();
  // process-runner: run(executable, args, { cwd, env, timeoutMs, outputLimitBytes, stdin })
  // resolves { status: 'exited' | 'timed_out' | 'spawn_failed' | ..., exitCode, signal, stdout, stderr }.
  // executable and cwd must be absolute paths.
  const result = await runner.run(command.file, command.args, { timeoutMs: args.timeoutMs, cwd: dirname(uprojectPath) });
  console.log(`Editor ${result.status}, exit ${result.exitCode ?? 'null'}, after ${Math.round((Date.now() - started) / 1000)}s`);
  if (result.status === 'timed_out') { console.error(`[ERROR] timed out after ${args.timeoutMs}ms; process tree killed`); return 3; }
  if (result.status === 'spawn_failed') { console.error(`[ERROR] could not start ${command.file}: ${result.stderr}`); return 2; }

  const indexPath = join(reportDir, 'index.json');
  let parsed;
  try { parsed = loadReport(indexPath, started); }
  catch (e) {
    if (!(e instanceof NativeReportError)) throw e;
    const stderrDetail = e.code === 'REPORT_MISSING' ? `\nlast stderr:\n${(result.stderr ?? '').slice(-2000)}` : '';
    console.error(`[ERROR] ${e.code}: ${e.message}${stderrDetail}`);
    return 4;
  }
  for (const line of summarizeReport(parsed)) console.log(line);
  const exitCode = reportExitCode(parsed);
  if (!args.reportDir && exitCode === 0) rmSync(reportDir, { recursive: true, force: true });
  return exitCode;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code), err => { console.error(`[ERROR] ${err.message}`); process.exit(err.exitCode ?? 2); });
}
