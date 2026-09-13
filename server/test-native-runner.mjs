// test-native-runner.mjs — pure-helper tests for the native automation report
// parser. Runner-CLI assertions (buildEditorCommand, resolveEngineRootForProject,
// parseRunnerArgs) land in Task 2, appended to this same file once
// run-native-tests.mjs exists.
// Run: node test-native-runner.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TestRunner } from './test-helpers.mjs';
import { parseAutomationReport, summarizeReport, reportExitCode } from './native-test-report.mjs';

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

process.exit(t.summary() === 0 ? 0 : 1);
