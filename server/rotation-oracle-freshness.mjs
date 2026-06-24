// rotation-oracle-freshness.mjs - extracts non-strict stale-oracle markers
// from child test output so run-rotation can surface canary drift.

const ORACLE_FRESHNESS_RE =
  /^\s*-\s+(.+?):\s+(FIXTURE_MISSING|ASSET_REDIRECTED|CONTENT_DRIFT|ORACLE_DRIFT|PARSER_REGRESSION)\b(.*exact oracle assertions skipped; set UEMCP_STRICT_LIVE_ORACLES=1.*)$/;

export function detectOracleFreshnessMarkers(stdout) {
  const markers = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const match = line.match(ORACLE_FRESHNESS_RE);
    if (!match) continue;
    markers.push({
      label: match[1].trim(),
      code: match[2],
      message: `${match[1].trim()}: ${match[2]}${match[3]}`.trim(),
      line: line.trim(),
    });
  }
  return markers;
}

export function collectOracleFreshness(results) {
  const entries = [];
  for (const result of results) {
    for (const marker of result.oracleFreshness || []) {
      entries.push({
        file: result.file,
        label: marker.label,
        code: marker.code,
        message: marker.message,
      });
    }
  }
  return {
    count: entries.length,
    entries,
  };
}
