// test-native-runner.mjs — pure-helper tests for the native automation report
// parser plus the runner CLI's pure helpers (buildEditorCommand,
// resolveEngineRootForProject, parseRunnerArgs).
// Run: node test-native-runner.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner } from './test-helpers.mjs';
import { parseAutomationReport, summarizeReport, reportExitCode } from './native-test-report.mjs';
import { buildEditorCommand, resolveEngineRootForProject, parseRunnerArgs } from './run-native-tests.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = name => JSON.parse(readFileSync(join(here, 'fixtures', 'native-tests', name), 'utf8'));
const t = new TestRunner('native-test-runner');

const ok = parseAutomationReport(fixture('index.sample.json'));
t.assert(ok.total === 16, 'sample report has 16 tests', `got ${ok.total}`);
t.assert(ok.tests.every(x => x.path.startsWith('UEMCP.')), 'every test path is prefixed UEMCP.');
t.assert(reportExitCode(ok) === (ok.failed === 0 && ok.notRun === 0 ? 0 : 1), 'exit code follows the sample outcome');

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

process.exit(t.summary() === 0 ? 0 : 1);
