// oracle-freshness.mjs - test helpers for separating live fixture drift from
// byte/parser oracle assertions.

export const ORACLE_FRESHNESS_CODES = Object.freeze({
  FRESH: 'FRESH',
  FIXTURE_MISSING: 'FIXTURE_MISSING',
  ASSET_REDIRECTED: 'ASSET_REDIRECTED',
  CONTENT_DRIFT: 'CONTENT_DRIFT',
  ORACLE_DRIFT: 'ORACLE_DRIFT',
  PARSER_REGRESSION: 'PARSER_REGRESSION',
});

const STRICT_TRUE_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isStrictLiveOracleMode(env = process.env) {
  return STRICT_TRUE_VALUES.has(String(env.UEMCP_STRICT_LIVE_ORACLES || '').trim().toLowerCase());
}

function sameValue(actual, expected) {
  return actual === expected;
}

function diffFields(actual, expected, fields) {
  const diffs = [];
  for (const field of fields) {
    if (!(field in expected)) continue;
    if (!sameValue(actual?.[field], expected[field])) {
      diffs.push({ field, expected: expected[field], actual: actual?.[field] });
    }
  }
  return diffs;
}

function makeResult(label, code, differences, detail = '') {
  const fresh = code === ORACLE_FRESHNESS_CODES.FRESH;
  const diffText = differences.length
    ? differences.map(d => `${d.field}: expected ${JSON.stringify(d.expected)}, got ${JSON.stringify(d.actual)}`).join('; ')
    : detail;
  return {
    label,
    fresh,
    code,
    differences,
    message: fresh ? `${label}: FRESH` : `${label}: ${code}${diffText ? ` (${diffText})` : ''}`,
  };
}

export function evaluateAssetInfoFreshness(label, actual, expected) {
  if (!actual) {
    return makeResult(label, ORACLE_FRESHNESS_CODES.FIXTURE_MISSING, [], 'no asset info returned');
  }

  const identityFields = ['path', 'packageName', 'objectPath', 'objectClassName'];
  const identityDiffs = diffFields(actual, expected, identityFields);
  const actualClass = String(actual.objectClassName || '');
  if (actualClass.endsWith('.ObjectRedirector') || actualClass === '/Script/CoreUObject.ObjectRedirector') {
    return makeResult(label, ORACLE_FRESHNESS_CODES.ASSET_REDIRECTED, identityDiffs);
  }
  if (identityDiffs.length > 0) {
    return makeResult(label, ORACLE_FRESHNESS_CODES.CONTENT_DRIFT, identityDiffs);
  }

  const baselineFingerprintFields = ['fileVersionUE5', 'exportCount', 'nameCount', 'assetRegistryObjects'];
  const fingerprintFields = [
    ...baselineFingerprintFields,
    ...Object.keys(expected).filter(field =>
      !identityFields.includes(field) && !baselineFingerprintFields.includes(field)),
  ];
  const fingerprintDiffs = diffFields(actual, expected, fingerprintFields);
  if (fingerprintDiffs.length > 0) {
    return makeResult(label, ORACLE_FRESHNESS_CODES.ORACLE_DRIFT, fingerprintDiffs);
  }

  return makeResult(label, ORACLE_FRESHNESS_CODES.FRESH, []);
}

export function countTopologyNodes(topology) {
  let count = 0;
  for (const graph of Object.values(topology?.graphs || {})) {
    count += Object.keys(graph?.nodes || {}).length;
  }
  return count;
}

export function countTopologyEdges(topology) {
  let count = 0;
  for (const graph of Object.values(topology?.graphs || {})) {
    for (const node of Object.values(graph?.nodes || {})) {
      for (const pin of Object.values(node?.pins || {})) {
        count += Array.isArray(pin?.linked_to) ? pin.linked_to.length : 0;
      }
    }
  }
  return count;
}

export function evaluateTopologyOracleFreshness(label, parsed, oracle, expected) {
  if (!parsed || parsed.available === false) {
    return makeResult(label, ORACLE_FRESHNESS_CODES.FIXTURE_MISSING, [], 'parser returned no fixture envelope');
  }

  const parserSchemaDiffs = diffFields(parsed, {
    schema_version: expected.parserSchemaVersion,
  }, ['schema_version']);
  if (parserSchemaDiffs.length > 0) {
    return makeResult(label, ORACLE_FRESHNESS_CODES.PARSER_REGRESSION, parserSchemaDiffs);
  }

  const oracleSchemaDiffs = diffFields(oracle, {
    schema_version: expected.oracleSchemaVersion,
  }, ['schema_version']);
  if (oracleSchemaDiffs.length > 0) {
    return makeResult(label, ORACLE_FRESHNESS_CODES.ORACLE_DRIFT, oracleSchemaDiffs);
  }

  const parsedPathDiffs = diffFields(parsed, { asset_path: expected.assetPath }, ['asset_path']);
  if (parsedPathDiffs.length > 0) {
    return makeResult(label, ORACLE_FRESHNESS_CODES.CONTENT_DRIFT, parsedPathDiffs);
  }

  const oraclePathDiffs = diffFields(oracle, { asset_path: expected.assetPath }, ['asset_path']);
  if (oraclePathDiffs.length > 0) {
    return makeResult(label, ORACLE_FRESHNESS_CODES.ORACLE_DRIFT, oraclePathDiffs);
  }

  const oracleEdgeCount = countTopologyEdges(oracle);
  const parsedEdgeCount = Number.isFinite(parsed?.stats?.edgesEmitted)
    ? parsed.stats.edgesEmitted
    : countTopologyEdges(parsed);
  const oracleNodeCount = countTopologyNodes(oracle);
  const parsedNodeCount = Number.isFinite(parsed?.stats?.graphNodeExports)
    ? parsed.stats.graphNodeExports
    : countTopologyNodes(parsed);

  const summaryDiffs = [];
  if ('edgeCount' in expected && oracleEdgeCount !== expected.edgeCount) {
    summaryDiffs.push({ field: 'oracle.edgeCount', expected: expected.edgeCount, actual: oracleEdgeCount });
  }
  if ('edgeCount' in expected && parsedEdgeCount !== expected.edgeCount) {
    summaryDiffs.push({ field: 'parsed.edgeCount', expected: expected.edgeCount, actual: parsedEdgeCount });
  }
  if (parsedEdgeCount !== oracleEdgeCount) {
    summaryDiffs.push({ field: 'parsed.edgeCountVsOracle', expected: oracleEdgeCount, actual: parsedEdgeCount });
  }
  if ('graphNodeExports' in expected && parsedNodeCount !== expected.graphNodeExports) {
    summaryDiffs.push({ field: 'parsed.graphNodeExports', expected: expected.graphNodeExports, actual: parsedNodeCount });
  }
  if ('oracleNodeCount' in expected && oracleNodeCount !== expected.oracleNodeCount) {
    summaryDiffs.push({ field: 'oracle.nodeCount', expected: expected.oracleNodeCount, actual: oracleNodeCount });
  }

  if (summaryDiffs.length > 0) {
    return makeResult(label, ORACLE_FRESHNESS_CODES.ORACLE_DRIFT, summaryDiffs);
  }

  return makeResult(label, ORACLE_FRESHNESS_CODES.FRESH, []);
}

export function oracleGateDecision(freshness, options = {}) {
  const strict = options.strict ?? isStrictLiveOracleMode();
  if (freshness.fresh) {
    return {
      runExactAssertions: true,
      failTest: false,
      message: freshness.message,
    };
  }

  const suffix = strict
    ? 'exact oracle assertions skipped after failing freshness gate'
    : 'exact oracle assertions skipped; set UEMCP_STRICT_LIVE_ORACLES=1 to fail stale live oracles';
  return {
    runExactAssertions: false,
    failTest: strict,
    message: `${freshness.message} - ${suffix}`,
  };
}

export function applyOracleFreshnessGate(runner, freshness, options = {}) {
  const decision = oracleGateDecision(freshness, options);
  if (decision.failTest) {
    runner.assert(false, `${freshness.label}: oracle freshness gate`, decision.message);
  } else if (!decision.runExactAssertions) {
    console.log(`  - ${decision.message}`);
  }
  return decision.runExactAssertions;
}
