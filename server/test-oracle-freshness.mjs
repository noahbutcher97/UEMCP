// test-oracle-freshness.mjs - test-only live fixture oracle freshness helpers.
//
// Run: cd server && node test-oracle-freshness.mjs

import {
  ORACLE_FRESHNESS_CODES,
  countTopologyEdges,
  countTopologyNodes,
  evaluateAssetInfoFreshness,
  evaluateTopologyOracleFreshness,
  oracleGateDecision,
} from './oracle-freshness.mjs';
import { TestRunner } from './test-helpers.mjs';

const runner = new TestRunner('oracle freshness helpers');

function testAssetInfoFreshness() {
  const expected = {
    path: '/Game/Animations/AN_OSAnimNotify_Footstep',
    packageName: '/Game/Animations/AN_OSAnimNotify_Footstep',
    objectPath: 'AN_OSAnimNotify_Footstep',
    objectClassName: '/Script/Engine.Blueprint',
    exportCount: 3,
    nameCount: 33,
    assetRegistryObjects: 2,
    fileVersionUE5: 1017,
  };

  const fresh = evaluateAssetInfoFreshness('Footstep', { ...expected }, expected);
  runner.assert(fresh.fresh === true, 'asset info: exact fixture is fresh');
  runner.assert(fresh.code === ORACLE_FRESHNESS_CODES.FRESH,
    'asset info: exact fixture code is FRESH');

  const redirected = evaluateAssetInfoFreshness('Footstep', {
    ...expected,
    objectPath: 'AN_OSAnimNotify_Footstep_Redirect',
    objectClassName: '/Script/CoreUObject.ObjectRedirector',
    exportCount: 1,
    assetRegistryObjects: 1,
  }, expected);
  runner.assert(redirected.fresh === false,
    'asset info: redirected fixture is stale');
  runner.assert(redirected.code === ORACLE_FRESHNESS_CODES.ASSET_REDIRECTED,
    'asset info: ObjectRedirector wins over numeric drift');
  runner.assert(redirected.differences.some(d => d.field === 'objectClassName'),
    'asset info: redirected result includes class difference');

  const numericDrift = evaluateAssetInfoFreshness('Footstep', {
    ...expected,
    nameCount: 34,
  }, expected);
  runner.assert(numericDrift.code === ORACLE_FRESHNESS_CODES.ORACLE_DRIFT,
    'asset info: count mismatch is ORACLE_DRIFT');
  runner.assert(numericDrift.differences[0]?.field === 'nameCount',
    'asset info: count mismatch reports exact field');

  const decodedDrift = evaluateAssetInfoFreshness('BPGA_Block', {
    ...expected,
    propertyCount: 8,
    bytesConsumed: 675,
    hasDrainPerSecond: false,
  }, {
    ...expected,
    propertyCount: 9,
    bytesConsumed: 765,
    hasDrainPerSecond: true,
  });
  runner.assert(decodedDrift.code === ORACLE_FRESHNESS_CODES.ORACLE_DRIFT,
    'asset info: custom decoded-field mismatch is ORACLE_DRIFT');
  runner.assert(decodedDrift.differences.some(d => d.field === 'propertyCount'),
    'asset info: custom decoded-field mismatch reports propertyCount');
}

function makeTopology(edgeCount) {
  const pins = {};
  for (let i = 0; i < edgeCount; i++) {
    pins[`src-${i}`] = {
      name: `src_${i}`,
      direction: 'EGPD_Output',
      linked_to: [{ node_guid: 'DstNode', pin_id: `dst-${i}` }],
    };
    pins[`dst-${i}`] = {
      name: `dst_${i}`,
      direction: 'EGPD_Input',
      linked_to: [],
    };
  }
  return {
    schema_version: 'oracle-a-v2',
    asset_path: '/Game/Test/BP_Test',
    graphs: {
      EventGraph: {
        nodes: {
          SrcNode: { class_name: 'K2Node_CallFunction', pins },
          DstNode: { class_name: 'K2Node_CallFunction', pins: {} },
        },
      },
    },
  };
}

function testTopologyFreshness() {
  const oracle = makeTopology(2);
  const parsed = {
    ...makeTopology(2),
    schema_version: 'sb-base-v1',
    stats: { graphNodeExports: 2, edgesEmitted: 2 },
  };
  const expected = {
    assetPath: '/Game/Test/BP_Test',
    parserSchemaVersion: 'sb-base-v1',
    oracleSchemaVersion: 'oracle-a-v2',
    edgeCount: 2,
    graphNodeExports: 2,
  };

  runner.assert(countTopologyEdges(oracle) === 2,
    'topology: edge counter counts LinkedTo rows');
  runner.assert(countTopologyNodes(oracle) === 2,
    'topology: node counter counts graph nodes');

  const fresh = evaluateTopologyOracleFreshness('BP_Test', parsed, oracle, expected);
  runner.assert(fresh.fresh === true,
    'topology: matching parser/oracle summary is fresh');

  const staleParsed = {
    ...parsed,
    stats: { graphNodeExports: 2, edgesEmitted: 3 },
  };
  const drift = evaluateTopologyOracleFreshness('BP_Test', staleParsed, oracle, expected);
  runner.assert(drift.fresh === false,
    'topology: parser summary mismatch is stale');
  runner.assert(drift.code === ORACLE_FRESHNESS_CODES.ORACLE_DRIFT,
    'topology: parser/oracle summary mismatch is ORACLE_DRIFT');

  const parserRegression = evaluateTopologyOracleFreshness('BP_Test', {
    ...parsed,
    schema_version: 'unexpected-schema',
  }, oracle, expected);
  runner.assert(parserRegression.code === ORACLE_FRESHNESS_CODES.PARSER_REGRESSION,
    'topology: parser schema mismatch is PARSER_REGRESSION');
}

function testGateDecision() {
  const stale = {
    label: 'Footstep',
    fresh: false,
    code: ORACLE_FRESHNESS_CODES.ASSET_REDIRECTED,
    message: 'Footstep: ASSET_REDIRECTED',
    differences: [],
  };

  const nonStrict = oracleGateDecision(stale, { strict: false });
  runner.assert(nonStrict.runExactAssertions === false,
    'gate: non-strict stale oracle skips exact assertions');
  runner.assert(nonStrict.failTest === false,
    'gate: non-strict stale oracle does not fail');

  const strict = oracleGateDecision(stale, { strict: true });
  runner.assert(strict.runExactAssertions === false,
    'gate: strict stale oracle skips exact assertions');
  runner.assert(strict.failTest === true,
    'gate: strict stale oracle fails freshness gate');
  runner.assert(strict.message.includes('ASSET_REDIRECTED'),
    'gate: strict failure message includes freshness code');
}

testAssetInfoFreshness();
testTopologyFreshness();
testGateDecision();
process.exit(runner.summary());
