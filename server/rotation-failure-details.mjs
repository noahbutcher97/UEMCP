const FAILURE_LINE_RE = /^\s*\u2717\s+(.+?)\s*$/;

export function extractAssertionFailureDetails(
  stdout,
  stderr,
  { maxDetails = 10, maxDetailChars = 1000 } = {},
) {
  const details = [];
  const seen = new Set();

  for (const output of [stderr, stdout]) {
    for (const line of String(output || '').split(/\r?\n/)) {
      const match = line.match(FAILURE_LINE_RE);
      if (!match) continue;

      const fullDetail = match[1].trim();
      if (!fullDetail || seen.has(fullDetail)) continue;
      seen.add(fullDetail);

      const detail = fullDetail.length > maxDetailChars
        ? `${fullDetail.slice(0, Math.max(0, maxDetailChars - 3))}...`
        : fullDetail;
      details.push(detail);
      if (details.length >= maxDetails) return details;
    }
  }

  return details;
}
