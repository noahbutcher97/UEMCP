import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanupCanonicalScratchRoot, createCanonicalScratchRoot, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('interactive AnimBP fixture harness');
const root = createCanonicalScratchRoot('uemcp-replay-');
const fixture = join(import.meta.dirname, 'fixtures/interactive-animbp');
const replay = join(fixture, 'test-editor-diagnostics.mjs');
function run(args) {
  const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 30_000, windowsHide: true });
  if (result.error) throw result.error;
  return { status: result.status, log: result.stdout + result.stderr };
}
try {
  const session = run(['--experimental-test-module-mocks', '--test', '--test-reporter=tap', join(fixture, 'test-session.mjs')]);
  t.assert(session.status === 0 && /^# pass 4$/m.test(session.log),
    'graceful shutdown, receipt failures and output cap preserve ownership and cleanup', session.log);

  const empty = join(root, 'empty');
  mkdirSync(empty);
  const synthetic = run([replay]);
  t.assert(synthetic.status === 0 && synthetic.log.includes('replayed 0 primary logs'), 'synthetic-only replay', synthetic.log);
  writeFileSync(join(root, 'qualified56-editor.log'),
    'Log file open, fixture\nLogLoad: (Engine Initialization) Total time: 1\nLogExit: Exiting.\nLog file closed, fixture');
  const valid = run([replay, root]);
  t.assert(valid.status === 0 && valid.log.includes('replayed 1 primary logs'), 'replay matches an editor log', valid.log);
  const incomplete = run([replay, root, empty]);
  t.assert(incomplete.status === 1 && incomplete.log.includes('No matching primary editor logs in ' + empty),
    'each supplied replay directory must match a log', incomplete.log);
} finally {
  cleanupCanonicalScratchRoot(root, 'uemcp-replay-');
}
process.exitCode = t.summary() ? 1 : 0;
