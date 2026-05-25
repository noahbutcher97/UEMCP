// test-class-resolution-audit.mjs — class-resolution consolidation guard.
//
// Enforces that all UClass resolution in live-editor handlers routes through the
// single shared UEMCP::ResolveClass (HandlerCommon.cpp). Flags raw UClass-resolution
// primitives in plugin/UEMCP/Source/UEMCP/Private/*.cpp — both find-only AND load
// variants — so the asset-blind "needs the asset loaded this session" quirk can't
// reappear and the load-but-narrow sites can't drift back.
//
// Excludes HandlerCommon.cpp (home of the resolver). Scans only top-level
// `Private/*.cpp` (single-level `readdirSync`), so `Commandlets/` and any future
// subdir are not scanned.
// An `// uemcp-allow-class-resolution: <reason>` line directly above a flagged line
// whitelists that line. Reuses stripCommentsAndStrings so primitives inside comments
// or string literals are not flagged.

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { stripCommentsAndStrings } from './test-anon-namespace-audit.mjs';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PRIVATE_DIR = resolve(SERVER_DIR, '..', 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private');
const EXCLUDED_BASENAMES = new Set(['HandlerCommon.cpp']);
const ALLOW_MARKER = 'uemcp-allow-class-resolution:';

// Raw UClass-resolution primitives. LoadObject<UBlueprint> / LoadObject<UAnimSequence>
// etc. are asset loads (not UClass) and are intentionally NOT matched.
const VIOLATION_PATTERNS = [
  /\bFindObject\s*<\s*UClass\b/,
  /\bFindFirstObject(?:Safe)?\s*<\s*UClass\b/,
  /\bStaticFind(?:First)?Object\w*\s*\(\s*UClass::StaticClass\(\)/,
  /\bLoadClass\s*</,
  /\bLoadObject\s*<\s*UClass\b/,
  /\bStaticLoadObject\s*\(\s*UClass::StaticClass\(\)/,
  /\bTObjectIterator\s*<\s*UClass\b/,
];

/** Scan one file's source → array of { line, text } violations (1-based line nums). */
export function scanSource(src) {
  const stripped = stripCommentsAndStrings(src);
  const strippedLines = stripped.split('\n');
  const rawLines = src.split('\n');
  const out = [];
  for (let i = 0; i < strippedLines.length; i++) {
    const line = strippedLines[i];
    if (!VIOLATION_PATTERNS.some(re => re.test(line))) continue;
    const prev = i > 0 ? rawLines[i - 1] : '';
    if (prev.includes(ALLOW_MARKER)) continue; // whitelisted
    out.push({ line: i + 1, text: rawLines[i].trim() });
  }
  return out;
}

/** Audit the Private dir → Map<basename, [{line,text}]> of violations. */
export function auditClassResolution(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith('.cpp')).sort();
  const violations = new Map();
  for (const f of files) {
    if (EXCLUDED_BASENAMES.has(f)) continue;
    const hits = scanSource(readFileSync(join(dir, f), 'utf8'));
    if (hits.length > 0) violations.set(f, hits);
  }
  return violations;
}

const isMain = (() => {
  try {
    const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
    return import.meta.url === argvUrl;
  } catch { return false; }
})();

if (isMain) {
  let passed = 0, failed = 0;
  const eq = (actual, expected, label) => {
    const a = JSON.stringify(actual), e = JSON.stringify(expected);
    if (a === e) { passed++; console.log(`  ✓ ${label}`); }
    else { failed++; console.error(`  ✗ ${label}: expected ${e}, got ${a}`); }
  };
  const ok = (cond, label) => {
    if (cond) { passed++; console.log(`  ✓ ${label}`); }
    else { failed++; console.error(`  ✗ ${label}`); }
  };

  // ── self-tests: prove the detector flags violations and ignores safe code ──
  eq(scanSource('UClass* C = FindObject<UClass>(nullptr, *N);').length, 1, 'flags FindObject<UClass>');
  eq(scanSource('UClass* C = LoadClass<AActor>(nullptr, *P);').length, 1, 'flags LoadClass<>');
  eq(scanSource('UClass* C = FindFirstObjectSafe<UClass>(*N, O);').length, 1, 'flags FindFirstObjectSafe<UClass>');
  eq(scanSource('for (TObjectIterator<UClass> It; It; ++It) {').length, 1, 'flags TObjectIterator<UClass>');
  eq(scanSource('auto* BP = LoadObject<UBlueprint>(nullptr, *P);').length, 0, 'asset load LoadObject<UBlueprint> NOT flagged');
  eq(scanSource('// FindObject<UClass>(nullptr, *N);').length, 0, 'commented-out primitive NOT flagged');
  eq(scanSource('// uemcp-allow-class-resolution: native enum\nUClass* C = FindObject<UClass>(nullptr, *N);').length, 0, 'allow-marker whitelists next line');
  eq(scanSource('C = UEMCP::ResolveClass(N);').length, 0, 'shared resolver call NOT flagged');

  // ── live scan: post-consolidation invariant (0 violations outside the resolver) ──
  if (existsSync(PRIVATE_DIR)) {
    const violations = auditClassResolution(PRIVATE_DIR);
    if (violations.size > 0) {
      console.error('  Raw UClass-resolution primitives found outside UEMCP::ResolveClass:');
      for (const [f, hits] of violations.entries()) {
        for (const h of hits) console.error(`    ${f}:${h.line}  ${h.text}`);
      }
      console.error('  Fix: route through UEMCP::ResolveClass (HandlerCommon.h), or add');
      console.error('  `// uemcp-allow-class-resolution: <reason>` above a vetted exception.');
    }
    eq(violations.size, 0, 'no raw UClass-resolution primitives outside the shared resolver');
  } else {
    console.log(`  ⊘ skipped (Private/ dir absent): ${PRIVATE_DIR}`);
  }

  console.log('');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);
  process.exit(failed === 0 ? 0 : 1);
}
