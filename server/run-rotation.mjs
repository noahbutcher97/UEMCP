// run-rotation.mjs — UEMCP test rotation runner with FAIL-LOUD on import errors.
//
// Closes the D104 silent-zero meta-finding: when a test file errors on import
// (parse error, missing module, deleted barrel), the previous per-file rotation
// tooling treated the file as 0/0 — passing-or-N/A all looked green and 234
// assertions vanished from rotation for 5 days (D97 → D102) before the drift
// surfaced. This runner detects import-time failures explicitly and exits
// non-zero with the file name + error excerpt, alongside a single authoritative
// aggregate count.
//
// Usage:
//   cd D:\DevTools\UEMCP\server
//   node run-rotation.mjs              # standard rotation
//   node run-rotation.mjs --json       # machine-readable result
//   node run-rotation.mjs --snapshot   # write .test-rotation-snapshot.json
//   node run-rotation.mjs --include-live-gated   # also include test-m1-ping
//   npm test                           # via package.json scripts.test
//
// Exit codes:
//   0  — every test green and no import errors
//   1  — at least one import error, assertion failure, or pre-summary crash
//   2  — runner-level usage error (no test files found, etc.)
//
// Excluded from default rotation:
//   - test-helpers.mjs / test-fixtures.mjs (libraries; no own assertions)
//   - test-m1-ping.mjs (live-editor-gated per D57; CLAUDE.md §Testing notes it is
//     "live-editor-gated and excluded from rotation count")

import { spawnSync } from 'node:child_process';
import { readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));

const EXCLUDED = new Set([
  'test-helpers.mjs',
  'test-fixtures.mjs',
  'test-m1-ping.mjs',
]);

// Patterns that identify an import-time failure vs a runtime assertion failure.
// We check stderr because Node writes ERR_MODULE_NOT_FOUND / SyntaxError there
// before the test body ever executes. Without these matches, a broken-import
// crash would just look like "exit 1, no summary" which is the silent-zero shape.
const IMPORT_ERROR_PATTERNS = [
  /ERR_MODULE_NOT_FOUND/,
  /Cannot find module ['"]([^'"]+)['"]/,
  /Cannot find package ['"]([^'"]+)['"]/,
  /does not provide an export named ['"]([^'"]+)['"]/,
  /^SyntaxError\b.*$/m,
  /^\s*SyntaxError\b.*$/m,
  /Unexpected token/,
  /Unexpected (?:identifier|end of input|reserved word)/,
];

const args = new Set(process.argv.slice(2));
const FLAG_JSON = args.has('--json');
const FLAG_SNAPSHOT = args.has('--snapshot');
const FLAG_INCLUDE_LIVE_GATED = args.has('--include-live-gated');
const FLAG_HELP = args.has('--help') || args.has('-h');

if (FLAG_HELP) {
  console.log('Usage: node run-rotation.mjs [--json] [--snapshot] [--include-live-gated]');
  console.log('  --json                Machine-readable JSON output');
  console.log('  --snapshot            Write .test-rotation-snapshot.json with per-file counts');
  console.log('  --include-live-gated  Include test-m1-ping.mjs (requires editor on TCP:55558)');
  process.exit(0);
}

if (FLAG_INCLUDE_LIVE_GATED) EXCLUDED.delete('test-m1-ping.mjs');

function discoverTestFiles() {
  return readdirSync(SERVER_DIR)
    .filter(f => /^test-.+\.mjs$/.test(f))
    .filter(f => !EXCLUDED.has(f))
    .sort();
}

function detectImportError(stderr) {
  for (const pat of IMPORT_ERROR_PATTERNS) {
    const m = stderr.match(pat);
    if (m) return m[0].trim();
  }
  return null;
}

function parseCounts(stdout, stderr) {
  // Primary format (TestRunner.summary in test-helpers.mjs):
  //   Passed: N
  //   Failed: N
  //   Total:  N
  const passed = stdout.match(/^\s*Passed:\s*(\d+)\s*$/m);
  const failed = stdout.match(/^\s*Failed:\s*(\d+)\s*$/m);
  const total = stdout.match(/^\s*Total:\s*(\d+)\s*$/m);
  if (passed && failed && total) {
    return { passed: +passed[1], failed: +failed[1], total: +total[1], skipped: false };
  }

  // Secondary format (test-m1-ping.mjs tail): "N passed, N failed"
  const alt = stdout.match(/^(\d+)\s+passed,\s+(\d+)\s+failed/m);
  if (alt) {
    return { passed: +alt[1], failed: +alt[2], total: +alt[1] + +alt[2], skipped: false };
  }

  // Skipped marker (test-m1-ping when editor not running)
  if (/⊘\s+skipped:/.test(stdout)) {
    return { passed: 0, failed: 0, total: 0, skipped: true, skipReason: 'live-editor-gated' };
  }

  // Env-fixture skip — fixture-dependent tests print this when UNREAL_PROJECT_ROOT
  // is unset. Distinct from a silent-zero hazard: the test EXPLICITLY declared why
  // it's not contributing assertions, so we treat it as ENV_SKIP not NO_SUMMARY.
  // (Some tests of this shape exit 0, others exit 1 — both intent the same thing.
  // Most route through console.error so we check stderr too.)
  const haystack = `${stdout}\n${stderr || ''}`;
  const envSkipMatch = haystack.match(/UNREAL_PROJECT_ROOT not set[^\n]*/);
  if (envSkipMatch) {
    return { passed: 0, failed: 0, total: 0, skipped: true, skipReason: envSkipMatch[0].trim() };
  }

  return null;
}

function classify(exitCode, counts, importError) {
  // Import error means we couldn't import the file. By definition that means the
  // test body never ran, so no Pass/Fail/Total summary should exist. If counts WERE
  // parsed, the file imported fine and any SyntaxError / "Cannot find" string in
  // stderr is a RUNTIME issue (e.g. JSON.parse on bad input) — not an import error.
  // This guards against false-positives that would otherwise mask real assertion
  // failures behind the IMPORT_ERROR banner.
  if (importError && !counts) return 'IMPORT_ERROR';
  // ENV_SKIP / live-gate SKIPPED takes precedence over exit code — env-skip tests
  // are inconsistent on whether they exit 0 or 1, but both intent the same thing.
  if (counts && counts.skipped) return 'SKIPPED';
  if (exitCode === 0 && counts) return 'PASS';
  if (exitCode !== 0 && counts && counts.failed > 0) return 'ASSERTION_FAILED';
  if (exitCode !== 0 && !counts) return 'CRASHED_NO_SUMMARY';
  if (exitCode === 0 && !counts) return 'NO_SUMMARY_PARSED';
  return 'UNKNOWN';
}

function runOne(file) {
  const start = Date.now();
  const result = spawnSync('node', [file], {
    cwd: SERVER_DIR,
    encoding: 'utf8',
    env: process.env,
    timeout: 5 * 60 * 1000,
    maxBuffer: 64 * 1024 * 1024,
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  const exitCode = result.status === null ? -1 : result.status;
  const counts = parseCounts(stdout, stderr);
  const importError = detectImportError(stderr);
  const kind = classify(exitCode, counts, importError);

  return { file, exitCode, kind, counts, importError, elapsedMs: Date.now() - start, stdout, stderr };
}

function tail(s, n = 5) {
  return s.split('\n').filter(l => l.trim()).slice(-n).join('\n        ');
}

function main() {
  const files = discoverTestFiles();
  if (files.length === 0) {
    console.error(`No test-*.mjs files found in ${SERVER_DIR}`);
    process.exit(2);
  }

  if (!FLAG_JSON) {
    console.log(`UEMCP test rotation — ${files.length} files in ${SERVER_DIR}`);
    console.log(`Excluded (library/live-gated): ${[...EXCLUDED].sort().join(', ') || '(none)'}`);
    console.log('');
  }

  const results = [];
  let aggPassed = 0;
  let aggFailed = 0;
  const importErrors = [];
  const assertionFailures = [];
  const crashes = [];
  const noSummary = [];
  const skipped = [];

  for (const file of files) {
    if (!FLAG_JSON) process.stdout.write(`  ${file.padEnd(40)} `);
    const r = runOne(file);
    results.push(r);

    if (r.counts && !r.counts.skipped) {
      aggPassed += r.counts.passed;
      aggFailed += r.counts.failed;
    }

    if (!FLAG_JSON) {
      switch (r.kind) {
        case 'PASS':
          console.log(`✓ ${r.counts.passed}/${r.counts.total} (${r.elapsedMs}ms)`);
          break;
        case 'SKIPPED': {
          const reason = r.counts?.skipReason ? ` — ${r.counts.skipReason}` : '';
          console.log(`⊘ skipped${reason} (${r.elapsedMs}ms)`);
          break;
        }
        case 'IMPORT_ERROR':
          console.log(`✗ IMPORT_ERROR (${r.elapsedMs}ms)`);
          break;
        case 'ASSERTION_FAILED':
          console.log(`✗ ${r.counts.passed}/${r.counts.total} — ${r.counts.failed} FAILED (${r.elapsedMs}ms)`);
          break;
        case 'CRASHED_NO_SUMMARY':
          console.log(`✗ CRASHED_NO_SUMMARY exit=${r.exitCode} (${r.elapsedMs}ms)`);
          break;
        case 'NO_SUMMARY_PARSED':
          console.log(`✗ NO_SUMMARY_PARSED exit=0 but no Pass/Fail/Total found (${r.elapsedMs}ms)`);
          break;
        default:
          console.log(`✗ ${r.kind} exit=${r.exitCode} (${r.elapsedMs}ms)`);
      }
    }

    if (r.kind === 'IMPORT_ERROR') importErrors.push(r);
    else if (r.kind === 'ASSERTION_FAILED') assertionFailures.push(r);
    else if (r.kind === 'CRASHED_NO_SUMMARY') crashes.push(r);
    else if (r.kind === 'NO_SUMMARY_PARSED' || r.kind === 'UNKNOWN') noSummary.push(r);
    else if (r.kind === 'SKIPPED') skipped.push(r);
  }

  const aggregate = { passed: aggPassed, failed: aggFailed, total: aggPassed + aggFailed };

  if (FLAG_JSON) {
    console.log(JSON.stringify({
      files: results.map(r => ({
        file: r.file, kind: r.kind, exitCode: r.exitCode,
        counts: r.counts, importError: r.importError, elapsedMs: r.elapsedMs,
      })),
      aggregate,
      importErrorCount: importErrors.length,
      assertionFailureCount: assertionFailures.length,
      crashCount: crashes.length,
      noSummaryCount: noSummary.length,
    }, null, 2));
  } else {
    console.log('');
    console.log('═══ UEMCP rotation summary ═══');
    console.log(`  Files run:    ${results.length}`);
    console.log(`  Aggregate:    ${aggregate.passed} passed / ${aggregate.failed} failed / ${aggregate.total} total`);
    if (skipped.length > 0) {
      console.log(`  Skipped:      ${skipped.length} (env/live-gate — assertions not contributing)`);
    }

    if (importErrors.length > 0) {
      console.log('');
      console.log('  ╔═══════════════════════════════════════════════════════════════╗');
      console.log('  ║  IMPORT ERRORS — silent-zero hazard per D104                  ║');
      console.log('  ║  Broken imports are NOT 0/0 — they are CATASTROPHIC FAILURE.  ║');
      console.log('  ║  Likely causes: deleted/renamed barrel file, missing export,  ║');
      console.log('  ║  syntax error, missing dependency.                            ║');
      console.log('  ╚═══════════════════════════════════════════════════════════════╝');
      for (const r of importErrors) {
        console.log(`    ✗ ${r.file}`);
        console.log(`        ${r.importError}`);
        const tailErr = tail(r.stderr, 3);
        if (tailErr) console.log(`        ${tailErr}`);
      }
    }
    if (crashes.length > 0) {
      console.log('');
      console.log('  Pre-summary crashes (exit ≠ 0, no Pass/Fail/Total parsed — top-level throw?):');
      for (const r of crashes) {
        console.log(`    ✗ ${r.file} (exit ${r.exitCode})`);
        const tailErr = tail(r.stderr, 5);
        if (tailErr) console.log(`        ${tailErr}`);
      }
    }
    if (noSummary.length > 0) {
      console.log('');
      console.log('  Files with exit 0 but no parseable summary (silent-zero shape — investigate):');
      for (const r of noSummary) console.log(`    ? ${r.file}`);
    }
    if (assertionFailures.length > 0) {
      console.log('');
      console.log('  Files with assertion failures:');
      for (const r of assertionFailures) {
        console.log(`    ✗ ${r.file}: ${r.counts.failed} failed of ${r.counts.total}`);
      }
    }
    console.log('');
  }

  if (FLAG_SNAPSHOT) {
    const snapshotPath = join(SERVER_DIR, '.test-rotation-snapshot.json');
    writeFileSync(snapshotPath, JSON.stringify({
      timestamp: new Date().toISOString(),
      aggregate,
      files: results.map(r => ({
        file: r.file, kind: r.kind,
        passed: r.counts?.passed ?? 0,
        failed: r.counts?.failed ?? 0,
        total: r.counts?.total ?? 0,
      })),
    }, null, 2));
    if (!FLAG_JSON) console.log(`Snapshot written to ${snapshotPath}\n`);
  }

  const hadFailure = importErrors.length + assertionFailures.length + crashes.length + noSummary.length > 0;
  process.exit(hadFailure ? 1 : 0);
}

main();
