// test-rotation-oracle-freshness.mjs - run-rotation oracle freshness reporting.
//
// Run: cd server && node test-rotation-oracle-freshness.mjs

import {
  collectOracleFreshness,
  detectOracleFreshnessMarkers,
} from './rotation-oracle-freshness.mjs';
import { TestRunner } from './test-helpers.mjs';

const runner = new TestRunner('rotation oracle freshness reporting');

function testDetectOracleFreshnessMarkers() {
  const stdout = [
    '  PASS BP_OSPlayerR: schema_version = sb-base-v1',
    '  - BP_OSPlayerR: ORACLE_DRIFT (parsed.edgeCount: expected 596, got 600; parsed.edgeCountVsOracle: expected 596, got 600) - exact oracle assertions skipped; set UEMCP_STRICT_LIVE_ORACLES=1 to fail stale live oracles',
    '  - BPGA_Block L1 property oracle: ORACLE_DRIFT (propertyCount: expected 9, got 8) - exact oracle assertions skipped; set UEMCP_STRICT_LIVE_ORACLES=1 to fail stale live oracles',
    '',
    '=== S-B-base differential (Oracle-A-v2) ===',
  ].join('\n');

  const markers = detectOracleFreshnessMarkers(stdout);
  runner.assert(markers.length === 2,
    'detect: extracts two non-strict oracle freshness markers',
    `got ${markers.length}`);
  runner.assert(markers[0].label === 'BP_OSPlayerR',
    'detect: preserves marker label');
  runner.assert(markers[0].code === 'ORACLE_DRIFT',
    'detect: preserves marker code');
  runner.assert(markers[0].message.includes('parsed.edgeCount'),
    'detect: preserves marker detail');
}

function testIgnoresStrictFailureSummary() {
  const stdout = [
    '  Failures:',
    '  FAIL BP_OSPlayerR: oracle freshness gate: BP_OSPlayerR: ORACLE_DRIFT (parsed.edgeCount: expected 596, got 600) - exact oracle assertions skipped after failing freshness gate',
  ].join('\n');

  const markers = detectOracleFreshnessMarkers(stdout);
  runner.assert(markers.length === 0,
    'detect: ignores strict failure summary lines');
}

function testCollectOracleFreshness() {
  const markers = detectOracleFreshnessMarkers(
    '  - BP_OSPlayerR: ORACLE_DRIFT (parsed.edgeCount: expected 596, got 600) - exact oracle assertions skipped; set UEMCP_STRICT_LIVE_ORACLES=1 to fail stale live oracles',
  );
  const summary = collectOracleFreshness([
    { file: 'test-s-b-base-differential.mjs', oracleFreshness: markers },
    { file: 'test-uasset-parser.mjs', oracleFreshness: [] },
  ]);

  runner.assert(summary.count === 1,
    'collect: counts freshness markers across files',
    `got ${summary.count}`);
  runner.assert(summary.entries[0]?.file === 'test-s-b-base-differential.mjs',
    'collect: attaches file name to marker');
  runner.assert(summary.entries[0]?.code === 'ORACLE_DRIFT',
    'collect: carries marker code into aggregate entries');
}

testDetectOracleFreshnessMarkers();
testIgnoresStrictFailureSummary();
testCollectOracleFreshness();
process.exit(runner.summary());
