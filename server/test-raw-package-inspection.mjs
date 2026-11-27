import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { executeOfflineTool } from './offline-tools.mjs';
import { createCanonicalScratchRoot, cleanupCanonicalScratchRoot, TestRunner } from './test-helpers.mjs';

const t = new TestRunner('Direct package inspection');
const prefix = 'uemcp-direct-inspection-';
const project = createCanonicalScratchRoot(prefix);
const fixture = fileURLToPath(new URL('./fixtures/serialization/ue5.9-chooser-v1/Content', import.meta.url));
const args = { kind: 'chooser', asset_path: '/Game/ChooserFixture/CT_Selection' };
const read = (params = args, check) => executeOfflineTool('read_package_inspection', params, project, undefined, check);
try {
  cpSync(fixture, join(project, 'Content'), { recursive: true });
  const asset = join(project, 'Content', 'ChooserFixture', 'CT_Selection.uasset');
  const digest = createHash('sha256').update(readFileSync(asset)).digest('hex');
  const result = await read();
  t.assert(result.origin === 'raw_package' && result.source_sha256 === digest && result.complete &&
    result.rows.length === 3 && !existsSync(join(project, 'Saved')), 'first-time raw read identifies saved bytes and creates no editor artifacts');
  await t.assertRejects(() => executeOfflineTool('read_saved_asset_inspection', args, project), /No saved inspection/,
    'the explicit snapshot tool retains its original contract');
  await t.assertRejects(() => read({ ...args, asset_path: '/Game/../CT_Selection' }), /exact/, 'require a project package path');
  await t.assertRejects(() => read({ ...args, max_pins: 4 }), /rigvm/, 'Chooser refuses the RigVM-only budget');
  let calls = 0;
  await assert.rejects(() => read(args, () => {
    if (++calls === 2) throw new Error('attachment changed');
  }), /attachment changed/);
  t.assert(calls === 2, 'verify attachment after decoding before returning the result');
  writeFileSync(asset.replace(/\.uasset$/, '.uexp'), Buffer.alloc(0));
  await t.assertRejects(() => read(), /Split export/, 'monolithic reader identifies split packages');
} finally {
  cleanupCanonicalScratchRoot(project, prefix);
}
process.exitCode = t.summary() === 0 ? 0 : 1;
