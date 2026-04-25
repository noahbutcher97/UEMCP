// test-leak-scan.mjs — runs the full-tree forbidden-token scan as part of
// the standard test rotation. Catches any sensitive content that slipped
// past the pre-commit hook (e.g. via --no-verify or pre-hook commits).
//
// Skips gracefully if bash is unavailable (Windows without Git for Windows
// or stripped CI image), since the scan needs the bash hook script.

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TestRunner } from './test-helpers.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');
const scanScript = join(repoRoot, 'scripts', 'check-leaks.sh');
const tokenList = join(repoRoot, '.git', 'info', 'forbidden-tokens');

const runner = new TestRunner('full-tree forbidden-token scan');

// ── Discovery: bash + scan-script + token-list all present? ──
const bashCheck = spawnSync('bash', ['--version'], { encoding: 'utf-8' });
const bashAvailable = bashCheck.status === 0;

if (!bashAvailable) {
  console.log('  · bash not on PATH — skipping leak scan (CI without Git Bash?).');
  console.log('  · Run scripts/check-leaks.bat manually on Windows to verify.');
  runner.summary();
  process.exit(0);
}

if (!existsSync(scanScript)) {
  runner.fail('scripts/check-leaks.sh present', `not found at ${scanScript}`);
  runner.summary();
  process.exit(1);
}

if (!existsSync(tokenList)) {
  console.log('  · .git/info/forbidden-tokens absent — hooks not installed.');
  console.log('  · Run scripts/install-hooks.bat (or .sh) once per checkout.');
  console.log('  · Skipping scan (cannot verify without a token list).');
  runner.summary();
  process.exit(0);
}

// ── Run the scan ──
const result = spawnSync('bash', [scanScript], {
  cwd: repoRoot,
  encoding: 'utf-8',
});

const stdoutOk = result.stdout && result.stdout.trim().length > 0;
runner.assert(result.status === 0,
  `check-leaks.sh exits 0 (clean tree) — got ${result.status}`,
  `stderr: ${(result.stderr || '').slice(0, 600)}`);

runner.assert(stdoutOk && result.stdout.includes('OK'),
  'scan stdout reports OK',
  `stdout: ${(result.stdout || '').slice(0, 200)}`);

runner.summary();
process.exit(runner.failed > 0 ? 1 : 0);
