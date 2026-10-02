// native-test-report.mjs — pure parsing of a UE automation report (index.json
// written by -ReportExportPath) into counts, per-test states and error text.
// No I/O; the runner reads the file and the rotation test feeds fixtures.

export class NativeReportError extends Error {
  constructor(message, code) { super(message); this.name = 'NativeReportError'; this.code = code; }
}

const STATES = new Set(['Success', 'Fail', 'NotRun', 'InProcess']);

export function parseAutomationReport(json) {
  if (!json || !Array.isArray(json.tests)) {
    throw new NativeReportError('automation report has no tests array', 'REPORT_SCHEMA_UNKNOWN');
  }
  const tests = json.tests.map(entry => {
    const path = entry.fullTestPath ?? entry.testDisplayName;
    const state = entry.state;
    if (typeof path !== 'string' || !STATES.has(state)) {
      throw new NativeReportError(`test entry lacks a name or known state: ${JSON.stringify(entry).slice(0, 200)}`, 'REPORT_SCHEMA_UNKNOWN');
    }
    const errors = (entry.entries ?? [])
      .filter(e => e?.event?.type === 'Error')
      .map(e => e.event.message);
    const skips = (entry.entries ?? [])
      .map(e => e?.event?.message)
      .filter(m => typeof m === 'string' && /^\s*skipped:/i.test(m));
    return { hasFullPath: typeof entry.fullTestPath === 'string' && entry.fullTestPath.length > 0, name: entry.testDisplayName ?? path, path, state, errors, skips };
  });
  const passed = tests.filter(x => x.state === 'Success').length;
  const failed = tests.filter(x => x.state === 'Fail').length;
  const notRun = tests.length - passed - failed;
  return { total: tests.length, passed, failed, notRun, tests };
}

export function summarizeReport(parsed) {
  const lines = [];
  let skipCount = 0;
  for (const test of parsed.tests) {
    const skips = test.skips ?? [];
    skipCount += skips.length;
    const skipSuffix = skips.map(message => ` (skip: ${message})`).join('');
    lines.push(`${test.state === 'Success' && !test.errors.length ? 'PASS' : 'FAIL'} ${test.path}${skipSuffix}`);
    for (const message of test.errors) lines.push(`    ${message}`);
  }
  lines.push(`Native tests: ${parsed.passed} passed, ${parsed.failed} failed, ${parsed.notRun} not run`);
  if (skipCount > 0) lines.push(`Labelled skips: ${skipCount}`);
  return lines;
}

// Required profiles compare complete paths, never display-name aliases.
export function reportProblems(parsed, { expectedNames = null, editorResult = null } = {}) {
  const problems = [];
  if (editorResult && (editorResult.status !== 'exited' || editorResult.exitCode !== 0)) {
    problems.push(`editor did not exit successfully (${editorResult.status}, ${editorResult.exitCode})`);
  }
  const seen = new Set();
  for (const test of parsed.tests) {
    if (expectedNames && !test.hasFullPath) problems.push(`missing fullTestPath: ${test.path}`);
    if (expectedNames && seen.has(test.path)) problems.push(`duplicate test: ${test.path}`);
    seen.add(test.path);
    if (test.state !== 'Success') problems.push(`${test.path}: ${test.state}`);
    if (test.errors.length) problems.push(`${test.path}: Error events`);
    if (expectedNames && test.skips.length) problems.push(`${test.path}: labelled skip`);
    if (expectedNames && !expectedNames.includes(test.path)) problems.push(`unexpected test: ${test.path}`);
  }
  if (expectedNames) {
    for (const name of expectedNames) if (!seen.has(name)) problems.push(`missing required test: ${name}`);
  }
  return problems;
}

export function reportExitCode(parsed, options = {}) {
  if (parsed.total === 0) return 4;
  return reportProblems(parsed, options).length === 0 ? 0 : 1;
}
