// Exercise the real CLI with tiny child suites; never run the full rotation
// recursively. Only relative imports are relocated to the source checkout.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';

const t = new TestRunner('Rotation failed-count regression');
const runnerUrl = new URL('./run-rotation.mjs', import.meta.url);
const original = readFileSync(runnerUrl, 'utf8');
const counts = (passed, failed) => `Passed: ${passed}\nFailed: ${failed}\nTotal: ${passed + failed}\n`;
const failure = { stdout: '\u2717 counted failure\n' + counts(1, 1), exit: 0 };
const healthy = { stdout: counts(3, 0), exit: 0 };

function run(suites, { json = true, classifierFault = false } = {}) {
  const scratch = createCanonicalScratchRoot('uemcp-rotation-count-');
  try {
    let source = original.replace(/from '(\.\/[^']+\.mjs)'/g,
      (_, specifier) => `from '${new URL(specifier, runnerUrl).href}'`);
    if (classifierFault) {
      // Fault injection: isolate aggregate failure enforcement from per-file
      // classification, so the exit-status guard cannot regress unnoticed.
      const signature = 'function classify(exitCode, counts, importError, timedOut) {';
      assert.ok(source.includes(signature));
      source = source.replace(signature, `${signature}\n  if (counts && !counts.skipped) return 'PASS';`);
    }
    const runnerPath = join(scratch, 'run-rotation.mjs');
    writeFileSync(runnerPath, source);
    for (const [index, suite] of suites.entries()) {
      writeFileSync(join(scratch, `test-child-${index}.mjs`),
        `process.stdout.write(${JSON.stringify(suite.stdout || '')});\n` +
        `process.stderr.write(${JSON.stringify(suite.stderr || '')});\n` +
        `process.exit(${suite.exit ?? 0});\n`);
    }
    const child = spawnSync(process.execPath, [runnerPath, ...(json ? ['--json'] : [])], {
      cwd: scratch, encoding: 'utf8', windowsHide: true, timeout: 15000,
    });
    assert.equal(child.error, undefined, child.error?.message);
    return { ...child, report: json ? JSON.parse(child.stdout) : undefined };
  } finally { cleanupCanonicalScratchRoot(scratch, 'uemcp-rotation-count-'); }
}
function check(name, fn) {
  try { fn(); t.assert(true, name); }
  catch (error) { t.assert(false, name, error.stack); }
}

check('rotation CLI accepts a genuinely passing zero-exit suite', () => {
  const { status, report } = run([healthy]);
  assert.equal(status, 0);
  assert.equal(report.files[0].kind, 'PASS');
  assert.deepEqual(report.aggregate, { passed: 3, failed: 0, total: 3 });
});
check('rotation CLI rejects failed assertions even when the child exits zero', () => {
  const { status, report } = run([failure]);
  assert.equal(status, 1);
  assert.equal(report.files[0].exitCode, 0);
  assert.equal(report.files[0].kind, 'ASSERTION_FAILED');
  assert.equal(report.assertionFailureCount, 1);
  assert.deepEqual(report.files[0].failureDetails, ['counted failure']);
  assert.deepEqual(report.aggregate, { passed: 1, failed: 1, total: 2 });
});
check('human rotation output labels a zero-exit counted failure and reports its detail', () => {
  const { status, stdout } = run([failure], { json: false });
  assert.equal(status, 1);
  assert.match(stdout, /1\/2[^\r\n]*1 FAILED/);
  assert.match(stdout, /Files with assertion failures:/);
  assert.match(stdout, /counted failure/);
});
check('nonzero-exit assertion failures retain their classification', () => {
  const { status, report } = run([{ ...failure, exit: 7 }]);
  assert.equal(status, 1);
  assert.equal(report.files[0].exitCode, 7);
  assert.equal(report.files[0].kind, 'ASSERTION_FAILED');
});
check('multiple child suites propagate their exact failed counts into aggregate failure', () => {
  const { status, report } = run([healthy, failure, { stdout: counts(2, 3), exit: 0 }]);
  assert.equal(status, 1);
  assert.equal(report.assertionFailureCount, 2);
  assert.deepEqual(report.aggregate, { passed: 6, failed: 4, total: 10 });
});
check('aggregate failed count independently forces failure if classification reports PASS', () => {
  assert.equal(run([healthy], { classifierFault: true }).status, 0);
  const { status, report } = run([failure], { classifierFault: true });
  assert.equal(report.files[0].kind, 'PASS', 'fault injected into classification only');
  assert.equal(report.assertionFailureCount, 0);
  assert.equal(report.aggregate.failed, 1);
  assert.equal(status, 1, 'aggregate guard must not depend on the classification list');
});
check('summaryless crashes remain fatal rather than contributing zero passing assertions', () => {
  const { status, report } = run([{ stderr: 'Error: child crashed\n', exit: 2 }]);
  assert.equal(status, 1);
  assert.equal(report.files[0].kind, 'CRASHED_NO_SUMMARY');
  assert.equal(report.crashCount, 1);
  assert.deepEqual(report.aggregate, { passed: 0, failed: 0, total: 0 });
});
check('import failures remain distinct from assertion counts', () => {
  const { status, report } = run([{ stderr: 'SyntaxError: broken import\n', exit: 1 }]);
  assert.equal(status, 1);
  assert.equal(report.files[0].kind, 'IMPORT_ERROR');
  assert.equal(report.importErrorCount, 1);
});
check('zero-exit suites without a summary remain fatal', () => {
  const { status, report } = run([{ stdout: 'no tests executed\n', exit: 0 }]);
  assert.equal(status, 1);
  assert.equal(report.files[0].kind, 'NO_SUMMARY_PARSED');
  assert.equal(report.noSummaryCount, 1);
});
check('explicit environment skips retain zero-count skipped semantics', () => {
  const { status, report } = run([{ stdout: 'UNREAL_PROJECT_ROOT not set - skipping\n', exit: 1 }]);
  assert.equal(status, 0);
  assert.equal(report.files[0].kind, 'SKIPPED');
  assert.deepEqual(report.aggregate, { passed: 0, failed: 0, total: 0 });
});
process.exit(t.summary());
