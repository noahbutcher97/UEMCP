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
    return { name: entry.testDisplayName ?? path, path, state, errors };
  });
  const passed = tests.filter(x => x.state === 'Success').length;
  const failed = tests.filter(x => x.state === 'Fail').length;
  const notRun = tests.length - passed - failed;
  return { total: tests.length, passed, failed, notRun, tests };
}

export function summarizeReport(parsed) {
  const lines = [];
  for (const test of parsed.tests) {
    lines.push(`${test.state === 'Success' ? 'PASS' : 'FAIL'} ${test.path}`);
    for (const message of test.errors) lines.push(`    ${message}`);
  }
  lines.push(`Native tests: ${parsed.passed} passed, ${parsed.failed} failed, ${parsed.notRun} not run`);
  return lines;
}

export function reportExitCode(parsed) {
  if (parsed.total === 0) return 4;
  return parsed.failed === 0 && parsed.notRun === 0 ? 0 : 1;
}
