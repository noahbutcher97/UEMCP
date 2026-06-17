// test-sync-plugin-bat-safety.mjs — static guard for sync-plugin.bat destructive ordering.
//
// Run: cd server && node test-sync-plugin-bat-safety.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('sync-plugin.bat Safety Tests');

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptText = readFileSync(join(repoRoot, 'sync-plugin.bat'), 'utf8');

const writeProbeIdx = scriptText.indexOf('set "WRITE_PROBE=');
const deleteSourceIdx = scriptText.indexOf('rmdir /s /q "!PLUGIN_DEST!\\Source"');
const deleteUpluginIdx = scriptText.indexOf('del /q "!PLUGIN_DEST!\\UEMCP.uplugin"');
const xcopyIdx = scriptText.indexOf('xcopy /E /I /Y /Q /EXCLUDE:!EXCLUDE_FILE!');

t.assert(writeProbeIdx !== -1, 'script preflights target write access');
t.assert(deleteSourceIdx !== -1, 'script still has explicit Source delete step');
t.assert(deleteUpluginIdx !== -1, 'script still has explicit uplugin delete step');
t.assert(xcopyIdx !== -1, 'script still has xcopy copy step');

if (writeProbeIdx !== -1 && deleteSourceIdx !== -1 && deleteUpluginIdx !== -1) {
  t.assert(writeProbeIdx < deleteSourceIdx, 'write preflight occurs before deleting Source');
  t.assert(writeProbeIdx < deleteUpluginIdx, 'write preflight occurs before deleting UEMCP.uplugin');
}

if (deleteSourceIdx !== -1 && xcopyIdx !== -1) {
  t.assert(deleteSourceIdx < xcopyIdx, 'existing deployed source is removed only immediately before copy');
}

process.exit(t.summary());
