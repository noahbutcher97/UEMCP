// Verify the local deployment advisory and its JSON input. The end-to-end Git
// push and confidentiality regressions live in test-project-hygiene.mjs.
// Run: cd server && node test-pre-push-gate.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { TestRunner } from './test-helpers.mjs';
import { resolveTestBash } from './shell-test-support.mjs';

const t = new TestRunner('Pre-push deployment advisory tests');

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const hookPath = join(repoRoot, '.githooks', 'pre-push');
const hookText = readFileSync(hookPath, 'utf8');
const lines = hookText.split('\n');

t.assert(hookText.includes('UEMCP_SKIP_COMPILE_GATE'), 'hook supports skipping the local deployment lookup');
t.assert(hookText.includes('UEMCP_PUSH_GATE_PROFILE'), 'hook names the UEMCP_PUSH_GATE_PROFILE override');

const verifyDeployLine = lines.find((line) => line.includes('verify-deploy.mjs'));
t.assert(!!verifyDeployLine, 'hook contains a line invoking verify-deploy.mjs');
t.assert(!!verifyDeployLine && verifyDeployLine.includes('--json'), 'verify-deploy invocation passes --json');
t.assert(!!verifyDeployLine && verifyDeployLine.includes('< /dev/null'), 'verify-deploy invocation redirects stdin from /dev/null');

// The trigger must cover everything the content digest covers: Source/, the
// shared native fixtures under Resources/, and the descriptor. A range that
// changes only a fixture would otherwise publish without the gate looking.
const triggerLine = lines.find((line) => line.includes('grep -qE') && line.includes('plugin/UEMCP/'));
t.assert(
  !!triggerLine && ['Source/', 'Resources/', 'UEMCP\\.uplugin'].every((part) => triggerLine.includes(part)),
  'gate trigger names Source/, Resources/, and the .uplugin',
);

// The advisory consumes machine-readable verdicts.
t.assert(!hookText.includes('Verdict: (NEEDS-SYNC'), 'hook no longer greps the human Verdict prefix');
t.assert(
  !hookText.includes('DLL missing') && !hookText.includes('not built'),
  'hook no longer greps the never-built reason substrings',
);

const parserMatch = hookText.match(/^deploy_parser='([^']*)'$/m);
t.assert(!!parserMatch, 'hook defines the deployment report parser');
const parser = parserMatch ? parserMatch[1] : '';

const bash = resolveTestBash();
const bashCheck = bash ? spawnSync(bash, ['-n', hookPath], { encoding: 'utf8', windowsHide: true }) : null;
if (!bashCheck) {
  t.assert(false, 'Git Bash is required for the Windows hook syntax check');
} else if (bashCheck.error && bashCheck.error.code === 'ENOENT') {
  t.assert(true, 'bash -n .githooks/pre-push — SKIPPED (bash not on PATH on this machine)');
} else {
  t.assert(bashCheck.status === 0, 'bash -n .githooks/pre-push exits 0', bashCheck.stderr);
}

// ─── The reader actually runs ───────────────────────────────────────
const runParser = (doc) => spawnSync(process.execPath, ['-e', parser], { input: doc, encoding: 'utf8' });

const allSync = JSON.stringify({
  version: 1, profile: 'smoke', exitCode: 0,
  targets: [{ uprojectPath: 'path/to/YourProject.uproject', alias: 'primary', verdict: 'SYNC', reason: 'content-identical to repo; DLL built after the last sync', contentIdentical: true, dllExists: true, editors: [], mcpPointsHere: false }],
});
const synced = runParser(allSync);
t.assert(synced.status === 0 && !synced.stdout, 'reader stays quiet for an all-SYNC document');

const stale = JSON.stringify({
  version: 1, profile: 'smoke', exitCode: 1,
  targets: [{ uprojectPath: 'path/to/YourProject.uproject', alias: 'primary', verdict: 'NEEDS-BUILD', reason: 'content-identical to repo; DLL predates the last sync', contentIdentical: true, dllExists: true, editors: [], mcpPointsHere: false }],
});
const staleRun = runParser(stale);
t.assert(
  staleRun.status === 0 && staleRun.stdout.includes('primary') && staleRun.stdout.includes('NEEDS-BUILD'),
  'reader names the stale local target and succeeds',
  staleRun.stdout,
);

const neverBuilt = JSON.stringify({
  version: 1, profile: 'smoke', exitCode: 1,
  targets: [{ uprojectPath: 'path/to/SecondProject.uproject', alias: 'second', verdict: 'NEEDS-BUILD', reason: 'Source synced but DLL not built', contentIdentical: null, dllExists: false, editors: [], mcpPointsHere: false }],
});
const unbuilt = runParser(neverBuilt);
t.assert(unbuilt.status === 0 && !unbuilt.stdout, 'reader omits a never-built target (dllExists false)');

t.assert(
  runParser(JSON.stringify({ version: 1, error: 'Profile not found: nope', exitCode: 2 })).status === 2,
  'reader exits 2 for an error document',
);
t.assert(runParser('not json at all').status === 2, 'reader exits 2 for unparseable input');

// A malformed row (null instead of an object) must never surface as an
// uncaught exception that could look like a block — it routes to the
// could-not-evaluate exit like any other unusable document (Minor 5).
const nullRow = JSON.stringify({
  version: 1, profile: 'smoke', exitCode: 1,
  targets: [null],
});
t.assert(runParser(nullRow).status === 2, 'reader exits 2 rather than crashing on a null row');

process.exit(t.summary());
