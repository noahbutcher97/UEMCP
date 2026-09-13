// test-pre-push-gate.mjs — structural guard for .githooks/pre-push's compile
// gate. The rotation cannot invoke a git hook directly (no push happens in
// CI), so this pins the shape that the manual hook probes validated: the
// bypass env vars exist, the verify-deploy invocation carries the flags the
// gate depends on, the verdict grep names all three blocking verdicts, the
// exclusion names both never-built reasons, and the couldn't-evaluate
// message text is present. A `bash -n` syntax check backstops all of it.
//
// Modelled on test-sync-plugin-bat-safety.mjs.
// Run: cd server && node test-pre-push-gate.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('pre-push compile gate Tests');

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hookPath = join(repoRoot, '.githooks', 'pre-push');
const hookText = readFileSync(hookPath, 'utf8');

t.assert(hookText.includes('UEMCP_SKIP_COMPILE_GATE'), 'hook names the UEMCP_SKIP_COMPILE_GATE bypass');
t.assert(hookText.includes('UEMCP_PUSH_GATE_PROFILE'), 'hook names the UEMCP_PUSH_GATE_PROFILE override');

const verifyDeployLine = hookText.split('\n').find((line) => line.includes('verify-deploy.mjs'));
t.assert(!!verifyDeployLine, 'hook contains a line invoking verify-deploy.mjs');
if (verifyDeployLine) {
  t.assert(verifyDeployLine.includes('--no-color'), 'verify-deploy invocation passes --no-color');
  t.assert(verifyDeployLine.includes('< /dev/null'), 'verify-deploy invocation redirects stdin from /dev/null');
}

const verdictGrepLine = hookText.split('\n').find((line) => line.includes('Verdict: (NEEDS-SYNC'));
t.assert(!!verdictGrepLine, 'hook contains the verdict grep line');
if (verdictGrepLine) {
  t.assert(
    ['NEEDS-SYNC', 'NEEDS-BUILD', 'NEEDS-DEPLOY'].every((v) => verdictGrepLine.includes(v)),
    'verdict grep names all three blocking verdicts',
  );
}

const exclusionLine = hookText.split('\n').find((line) => line.includes('grep -v') && line.includes('DLL missing'));
t.assert(!!exclusionLine, 'hook contains the never-built exclusion grep line');
if (exclusionLine) {
  t.assert(exclusionLine.includes('DLL missing') && exclusionLine.includes('not built'), 'exclusion names both never-built reasons');
}

t.assert(hookText.includes('compile gate could not evaluate'), 'hook contains the could-not-evaluate warning phrase');

const bashCheck = spawnSync('bash', ['-n', hookPath], { encoding: 'utf8' });
if (bashCheck.error && bashCheck.error.code === 'ENOENT') {
  t.assert(true, 'bash -n .githooks/pre-push — SKIPPED (bash not on PATH on this machine)');
} else {
  t.assert(bashCheck.status === 0, 'bash -n .githooks/pre-push exits 0', bashCheck.stderr);
}

process.exit(t.summary());
