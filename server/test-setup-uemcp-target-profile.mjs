// setup-uemcp.bat target profile registration guard.
//
// Run: cd server && node test-setup-uemcp-target-profile.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TestRunner } from './test-helpers.mjs';

const t = new TestRunner('setup-uemcp target profile registration');

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptText = readFileSync(join(repoRoot, 'setup-uemcp.bat'), 'utf8');

t.assert(scriptText.includes('.uemcp-targets.json'), 'setup writes structured .uemcp-targets.json');
t.assert(scriptText.includes('"default"') || scriptText.includes("'default'"), 'setup seeds default profile');
t.assert(scriptText.includes('"smoke"') || scriptText.includes("'smoke'"), 'setup seeds smoke profile');
t.assert(scriptText.includes('"release-gate"') || scriptText.includes("'release-gate'"), 'setup seeds release-gate profile');
t.assert(scriptText.includes('.uemcp-targets.txt'), 'setup keeps legacy txt compatibility reference');

process.exit(t.summary());
