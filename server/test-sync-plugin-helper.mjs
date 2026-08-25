// test-sync-plugin-helper.mjs — unit tests for sync-plugin-helper.mjs pure helpers.
// Run: node test-sync-plugin-helper.mjs
//
// Covers the deploy-marker comparison logic + atomic write/read round-trip
// + computeIncomingState repo-state extraction. Pure functions, no editor.
// CLI subcommands + checkPerWorkspaceLock are exercised via the live-fire
// verification path in the W-L handoff (process scan needs running editors).

import {
  readDeployMarker,
  writeDeployMarker,
  compareDeployMarker,
  computeIncomingState,
  MARKER_FILENAME,
  MARKER_SCHEMA_VERSION,
} from './sync-plugin-helper.mjs';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..');

let passed = 0, failed = 0;
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`FAIL [${label}]: expected ${e}, got ${a}`); }
};
const assertTrue = (cond, label) => {
  if (cond) { passed++; }
  else { failed++; console.error(`FAIL [${label}]: expected truthy, got falsy`); }
};

// ─── compareDeployMarker — all branches ──────────────────────────────

const incomingV1 = {
  manifestVersion: '1.0.1',
  upluginVersion: 2,
  upluginVersionName: '1.0.1',
};
const incomingV2 = {
  manifestVersion: '1.0.2',
  upluginVersion: 3,
  upluginVersionName: '1.0.2',
};

eq(
  compareDeployMarker(null, incomingV1),
  { nukeRecommended: false, reason: 'no-prior-marker' },
  'null prior → no nuke (first-sync semantics)'
);

eq(
  compareDeployMarker(undefined, incomingV1),
  { nukeRecommended: false, reason: 'no-prior-marker' },
  'undefined prior → no nuke'
);

const matchingPrior = {
  schemaVersion: MARKER_SCHEMA_VERSION,
  manifestVersion: '1.0.1',
  upluginVersion: 2,
  upluginVersionName: '1.0.1',
};
eq(
  compareDeployMarker(matchingPrior, incomingV1),
  { nukeRecommended: false, reason: 'version-match' },
  'version-match → no nuke'
);

const manifestChangedPrior = {
  schemaVersion: MARKER_SCHEMA_VERSION,
  manifestVersion: '1.0.0',
  upluginVersion: 2,
  upluginVersionName: '1.0.1',
};
const manifestVerdict = compareDeployMarker(manifestChangedPrior, incomingV1);
eq(manifestVerdict.nukeRecommended, true, 'manifest changed → nuke');
eq(manifestVerdict.reason, 'version-changed', 'manifest changed → reason');
assertTrue(manifestVerdict.detail && manifestVerdict.detail.prior, 'manifest changed → detail.prior present');
assertTrue(manifestVerdict.detail && manifestVerdict.detail.incoming, 'manifest changed → detail.incoming present');

const upluginChangedPrior = {
  schemaVersion: MARKER_SCHEMA_VERSION,
  manifestVersion: '1.0.1',
  upluginVersion: 1,
  upluginVersionName: '0.1.0',
};
const upluginVerdict = compareDeployMarker(upluginChangedPrior, incomingV1);
eq(upluginVerdict.nukeRecommended, true, 'uplugin changed → nuke');
eq(upluginVerdict.reason, 'version-changed', 'uplugin changed → reason');

const bothChangedPrior = {
  schemaVersion: MARKER_SCHEMA_VERSION,
  manifestVersion: '1.0.0',
  upluginVersion: 1,
  upluginVersionName: '0.1.0',
};
eq(
  compareDeployMarker(bothChangedPrior, incomingV2).nukeRecommended,
  true,
  'both changed → nuke'
);

// Schema-version mismatch escape hatch — future-proofs the contract.
const oldSchemaPrior = {
  schemaVersion: '0.9',  // some hypothetical older schema
  manifestVersion: '1.0.1',
  upluginVersion: 2,
  upluginVersionName: '1.0.1',
};
const schemaVerdict = compareDeployMarker(oldSchemaPrior, incomingV1);
eq(schemaVerdict.nukeRecommended, true, 'schema-version mismatch → nuke');
eq(schemaVerdict.reason, 'schema-version-changed', 'schema-version mismatch → reason');

// ─── readDeployMarker / writeDeployMarker — fs round-trip ────────────

const tmpRoot = mkdtempSync(join(tmpdir(), 'uemcp-sync-helper-test-'));
try {
  // Missing file → null
  eq(readDeployMarker(tmpRoot), null, 'missing marker → null');

  // Round-trip: write then read produces a marker carrying our fields
  const fields = {
    manifestVersion: '1.0.1',
    upluginVersion: 2,
    upluginVersionName: '1.0.1',
    sourceCommitSha: 'abc1234',
    headPluginCommitSha: 'def5678',
  };
  const written = writeDeployMarker(tmpRoot, fields);
  eq(written.manifestVersion, '1.0.1', 'written marker manifestVersion');
  eq(written.upluginVersion, 2, 'written marker upluginVersion');
  eq(written.schemaVersion, MARKER_SCHEMA_VERSION, 'written marker schemaVersion default');
  eq(written.syncedBy, 'sync-plugin.bat', 'written marker syncedBy default');

  // Onboarding and sync both write markers. The writer label must be
  // overridable so a marker doesn't misattribute itself when diagnosing
  // deploy state.
  const writtenBySetup = writeDeployMarker(tmpRoot, { ...fields, syncedBy: 'setup-uemcp.bat' });
  eq(writtenBySetup.syncedBy, 'setup-uemcp.bat', 'syncedBy is overridable by the caller');
  eq(writtenBySetup.manifestVersion, '1.0.1', 'override preserves the other marker fields');
  eq(readDeployMarker(tmpRoot).syncedBy, 'setup-uemcp.bat', 'overridden syncedBy round-trips through disk');
  assertTrue(typeof written.syncTime === 'string' && written.syncTime.length > 0, 'syncTime stamped');

  const readBack = readDeployMarker(tmpRoot);
  assertTrue(readBack !== null, 'read-back marker not null');
  eq(readBack.manifestVersion, '1.0.1', 'read-back manifestVersion');
  eq(readBack.upluginVersion, 2, 'read-back upluginVersion');
  eq(readBack.sourceCommitSha, 'abc1234', 'read-back sourceCommitSha');

  // Marker file path discoverable via the exported constant
  assertTrue(existsSync(join(tmpRoot, MARKER_FILENAME)), 'marker file lives at expected path');

  // Malformed JSON → null (treat as no-marker; don't brick future syncs)
  const tmpRoot2 = mkdtempSync(join(tmpdir(), 'uemcp-sync-helper-test2-'));
  try {
    writeFileSync(join(tmpRoot2, MARKER_FILENAME), '{not valid json', 'utf8');
    eq(readDeployMarker(tmpRoot2), null, 'malformed marker → null');
  } finally {
    rmSync(tmpRoot2, { recursive: true, force: true });
  }

  // writeDeployMarker creates parent dir if missing — important for fresh deploys
  const tmpRoot3 = join(tmpdir(), `uemcp-sync-helper-fresh-${process.pid}-${Date.now()}`);
  try {
    assertTrue(!existsSync(tmpRoot3), 'fresh dir starts absent');
    const written3 = writeDeployMarker(tmpRoot3, fields);
    assertTrue(existsSync(join(tmpRoot3, MARKER_FILENAME)), 'fresh dir created + marker written');
    eq(written3.manifestVersion, '1.0.1', 'fresh-dir write produces correct fields');
  } finally {
    rmSync(tmpRoot3, { recursive: true, force: true });
  }
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

// ─── computeIncomingState — reads our actual repo ───────────────────

// Repo-relative read: this test runs from server/, so REPO_ROOT is the
// UEMCP repo root. manifest.json + plugin/UEMCP/UEMCP.uplugin must exist.
const incoming = computeIncomingState(REPO_ROOT);
assertTrue(typeof incoming.manifestVersion === 'string' && incoming.manifestVersion.length > 0,
  'computeIncomingState manifestVersion populated');
assertTrue(typeof incoming.upluginVersion === 'number' && incoming.upluginVersion > 0,
  'computeIncomingState upluginVersion populated');
assertTrue(typeof incoming.upluginVersionName === 'string' && incoming.upluginVersionName.length > 0,
  'computeIncomingState upluginVersionName populated');
assertTrue(typeof incoming.sourceCommitSha === 'string', 'sourceCommitSha is string');
assertTrue(typeof incoming.headPluginCommitSha === 'string', 'headPluginCommitSha is string');

// computeIncomingState throws on missing manifest.json — defensive contract
let threw = false;
try {
  computeIncomingState(tmpdir());  // no manifest.json there
} catch {
  threw = true;
}
assertTrue(threw, 'computeIncomingState throws on missing manifest.json');

// run-rotation.mjs primary format — each on its own line so it can be parsed
// from stdout per the regex at run-rotation.mjs:93-95.
console.log('');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
