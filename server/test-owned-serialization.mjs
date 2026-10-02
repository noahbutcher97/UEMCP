import { cpSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureVersions, sha256, verifyOwnedFixture } from './owned-serialization.mjs';
import { TestRunner, createCanonicalScratchRoot, cleanupCanonicalScratchRoot } from './test-helpers.mjs';
const t = new TestRunner('Owned serialization corpus');
const corpus = fileURLToPath(new URL('./fixtures/serialization/', import.meta.url));
for (const version of fixtureVersions) {
  const source = join(corpus, version);
  try {
    await verifyOwnedFixture(source, version);
    t.assert(true, `${version}: independent UE oracle agrees with saved topology`);
  } catch (error) {
    t.assert(false, `${version}: independent UE oracle agrees with saved topology`, error.message);
  }
  for (const mutation of ['missing', 'hash', 'oracle']) {
    const prefix = 'uemcp-owned-serialization-';
    const scratchRoot = createCanonicalScratchRoot(prefix);
    try {
      // Establish the unmodified fixture first, so absent baseline data cannot
      // satisfy a negative control by accident.
      await verifyOwnedFixture(source, version);
      cpSync(source, scratchRoot, { recursive: true });
      const oraclePath = join(scratchRoot, 'oracle.json');
      if (mutation === 'missing') unlinkSync(oraclePath);
      if (mutation === 'hash') writeFileSync(oraclePath, readFileSync(oraclePath, 'utf8') + ' ');
      if (mutation === 'oracle') {
        const oracle = JSON.parse(readFileSync(oraclePath, 'utf8').replace(/^\uFEFF/, ''));
        const pins = oracle.graphs.OwnedGraph.nodes['00000001ABCDEF1280000000FFFFFFFF'].pins;
        Object.values(pins).find(pin => pin.name === 'then').linked_to = [];
        const bytes = Buffer.from(JSON.stringify(oracle));
        writeFileSync(oraclePath, bytes);
        const manifestPath = join(scratchRoot, 'manifest.json');
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
        manifest.files['oracle.json'] = { size: bytes.length, sha256: sha256(bytes) };
        writeFileSync(manifestPath, JSON.stringify(manifest));
      }
      let rejected = false;
      try { await verifyOwnedFixture(scratchRoot, version); } catch { rejected = true; }
      t.assert(rejected, `${version}: rejects ${mutation} corruption`);
    } catch (error) {
      t.assert(false, `${version}: rejects ${mutation} corruption`, `baseline or setup failure: ${error.message}`);
    } finally {
      cleanupCanonicalScratchRoot(scratchRoot, prefix);
    }
  }
}
process.exit(t.summary());
