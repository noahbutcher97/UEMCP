// test-pre-push-gate.mjs — structural and behavioural guard for the compile
// gate in .githooks/pre-push. The rotation cannot perform a push, so this
// pins two things instead: the shape of the hook (bypass vars, the --json
// invocation, the branches on the reader's exit codes) and the behaviour of
// the reader itself — the gate_parser program is extracted from the hook and
// executed against canned documents, because bash -n checks shell syntax and
// would not notice a typo inside that single-quoted JavaScript.
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
const lines = hookText.split('\n');

t.assert(hookText.includes('UEMCP_SKIP_COMPILE_GATE'), 'hook names the UEMCP_SKIP_COMPILE_GATE bypass');
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

// The prose contract is retired: a reword of verify-deploy's printer must no
// longer be able to change what the gate decides.
t.assert(!hookText.includes('Verdict: (NEEDS-SYNC'), 'hook no longer greps the human Verdict prefix');
t.assert(
  !hookText.includes('DLL missing') && !hookText.includes('not built'),
  'hook no longer greps the never-built reason substrings',
);

const parserMatch = hookText.match(/^gate_parser='(.*)'$/m);
t.assert(!!parserMatch, 'hook defines gate_parser on one single-quoted line');
const parser = parserMatch ? parserMatch[1] : '';
t.assert(
  ['NEEDS-SYNC', 'NEEDS-BUILD', 'NEEDS-DEPLOY'].every((v) => parser.includes(v)),
  'gate_parser names all three blocking verdicts',
);
t.assert(parser.includes('t.dllExists===true'), 'gate_parser blocks only on targets whose DLL exists');
t.assert(hookText.includes('"$gate_parse_rc" == "1"'), 'hook blocks the push on reader exit 1');
t.assert(hookText.includes('"$gate_parse_rc" != "0"'), 'hook warns without blocking on any other reader exit');
t.assert(hookText.includes('compile gate could not evaluate'), 'hook contains the could-not-evaluate warning phrase');

const bashCheck = spawnSync('bash', ['-n', hookPath], { encoding: 'utf8' });
if (bashCheck.error && bashCheck.error.code === 'ENOENT') {
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
t.assert(runParser(allSync).status === 0, 'reader exits 0 for an all-SYNC document');

const blocking = JSON.stringify({
  version: 1, profile: 'smoke', exitCode: 1,
  targets: [{ uprojectPath: 'path/to/YourProject.uproject', alias: 'primary', verdict: 'NEEDS-BUILD', reason: 'content-identical to repo; DLL predates the last sync', contentIdentical: true, dllExists: true, editors: [], mcpPointsHere: false }],
});
const blockingRun = runParser(blocking);
t.assert(
  blockingRun.status === 1 && blockingRun.stdout.includes('primary') && blockingRun.stdout.includes('NEEDS-BUILD'),
  'reader exits 1 and names the blocking target',
  blockingRun.stdout,
);

const neverBuilt = JSON.stringify({
  version: 1, profile: 'smoke', exitCode: 1,
  targets: [{ uprojectPath: 'path/to/SecondProject.uproject', alias: 'second', verdict: 'NEEDS-BUILD', reason: 'Source synced but DLL not built', contentIdentical: null, dllExists: false, editors: [], mcpPointsHere: false }],
});
t.assert(runParser(neverBuilt).status === 0, 'reader ignores a never-built target (dllExists false)');

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
