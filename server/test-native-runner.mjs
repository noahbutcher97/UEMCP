// test-native-runner.mjs — pure-helper tests for the native automation report
// parser plus the runner CLI's pure helpers (buildEditorCommand,
// resolveEngineRootForProject, parseRunnerArgs).
// Run: node test-native-runner.mjs
import { readFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner } from './test-helpers.mjs';
import { parseAutomationReport, summarizeReport, reportExitCode } from './native-test-report.mjs';
import { buildEditorCommand, resolveEngineRootForProject, parseRunnerArgs, stripBom, loadReport } from './run-native-tests.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = name => JSON.parse(readFileSync(join(here, 'fixtures', 'native-tests', name), 'utf8'));
const t = new TestRunner('native-test-runner');

const ok = parseAutomationReport(fixture('index.sample.json'));
t.assert(ok.total === 16, 'sample report has 16 tests', `got ${ok.total}`);
t.assert(ok.tests.every(x => x.path.startsWith('UEMCP.')), 'every test path is prefixed UEMCP.');
t.assert(reportExitCode(ok) === 0, 'exit code follows the sample outcome', 'sample report is all-pass so the exit code is 0');

const bad = parseAutomationReport(fixture('index.failing.json'));
t.assert(bad.failed === 1 && bad.passed === 1, 'failing fixture counts one pass and one fail');
t.assert(bad.tests.find(x => x.state === 'Fail').errors.length === 1, 'failing test carries its error message');
t.assert(reportExitCode(bad) === 1, 'any failure exits 1');
t.assert(summarizeReport(bad).some(l => l.startsWith('FAIL UEMCP.')), 'summary marks the failing test');

const empty = parseAutomationReport(fixture('index.empty.json'));
t.assert(empty.total === 0 && reportExitCode(empty) === 4, 'zero tests exits 4, never 0');

let threw = null;
try { parseAutomationReport({ nope: true }); } catch (e) { threw = e; }
t.assert(threw && threw.code === 'REPORT_SCHEMA_UNKNOWN', 'unknown schema throws REPORT_SCHEMA_UNKNOWN');

const cmd = buildEditorCommand({ engineRoot: 'C:/UE', uprojectPath: 'D:/P/P.uproject', filter: 'UEMCP', reportDir: 'C:/tmp/r', extraArgs: [] });
t.assert(cmd.file.endsWith('Engine/Binaries/Win64/UnrealEditor-Cmd.exe'), 'command targets UnrealEditor-Cmd.exe');
t.assert(cmd.args[0] === 'D:/P/P.uproject', 'first arg is the uproject');
t.assert(cmd.args.includes('-ExecCmds=Automation RunTests UEMCP;Quit'), 'exec command runs the filter and quits');
t.assert(cmd.args.includes('-ReportExportPath=C:/tmp/r') && cmd.args.includes('-unattended') && cmd.args.includes('-nullrhi'), 'headless flags present');

t.assert(resolveEngineRootForProject({ engineAssociation: '5.6', env: {}, existsImpl: p => p.endsWith('UE_5.6') }) === 'C:/Program Files/Epic Games/UE_5.6', 'EngineAssociation resolves to the matching install');
t.assert(resolveEngineRootForProject({ engineAssociation: '5.6', env: { UE_ENGINE_ROOT: 'X:/UE' }, existsImpl: () => true }) === 'X:/UE', 'UE_ENGINE_ROOT overrides EngineAssociation');
t.assert(resolveEngineRootForProject({ engineAssociation: '5.6', env: {}, existsImpl: () => false }) === null, 'no install found returns null');

const args = parseRunnerArgs(['--profile', 'smoke', '--target', 'alpha', '--timeout-ms', '60000', '--dry-run']);
t.assert(args.profile === 'smoke' && args.target === 'alpha' && args.timeoutMs === 60000 && args.dryRun === true, 'runner args parse');

t.assert(JSON.parse(stripBom('﻿{"a":1}')).a === 1 && stripBom('{"b":2}') === '{"b":2}', 'stripBom removes a leading BOM and leaves plain text alone');

// loadReport (Item 3/7): a report left over from an earlier run, or one that
// never got written, or one the editor left half-written must never be
// scored as this run's result — each gets its own NativeReportError code.
const scratchDir = mkdtempSync(join(tmpdir(), 'uemcp-native-test-'));
try {
  let missingErr = null;
  try { loadReport(join(scratchDir, 'missing.json'), Date.now()); } catch (e) { missingErr = e; }
  t.assert(missingErr?.code === 'REPORT_MISSING', 'loadReport on an absent file throws REPORT_MISSING');

  const stalePath = join(scratchDir, 'stale.json');
  writeFileSync(stalePath, '{}');
  const past = new Date(Date.now() - 60_000);
  utimesSync(stalePath, past, past);
  let staleErr = null;
  try { loadReport(stalePath, Date.now()); } catch (e) { staleErr = e; }
  t.assert(staleErr?.code === 'REPORT_STALE', 'loadReport on a report older than startedAt throws REPORT_STALE');

  const badPath = join(scratchDir, 'bad.json');
  writeFileSync(badPath, '{not json');
  let badErr = null;
  try { loadReport(badPath, Date.now()); } catch (e) { badErr = e; }
  t.assert(badErr?.code === 'REPORT_UNREADABLE', 'loadReport on invalid JSON throws REPORT_UNREADABLE');
} finally {
  rmSync(scratchDir, { recursive: true, force: true });
}

process.exit(t.summary() === 0 ? 0 : 1);
