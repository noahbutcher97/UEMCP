// test-anon-namespace-audit.mjs — W-K (D139) Layer 3 of W-F-COMPREHENSIVE.
//
// Structural enforcement that prevents future contributors from re-introducing
// anonymous-namespace duplicate-symbol collisions across
// plugin/UEMCP/Source/UEMCP/Private/*.cpp files. D137 closed 4 known + 0 latent
// collisions by extracting shared helpers to Public/HandlerCommon.h. This audit
// catches NEW duplicates two ways:
//
//   1. **Test-rotation guard** (default mode) — `node test-anon-namespace-audit.mjs`
//      runs the audit + unit tests; landed in run-rotation.mjs.
//   2. **Pre-commit hook guard** (--hook-mode flag) — `.githooks/pre-commit`
//      spawns this file with --hook-mode when staged diff includes
//      Private/*.cpp files; non-zero exit + clear error blocks the commit.
//
// Heuristic-based scan (full C++ parsing is overkill for structural enforcement):
//   - Strip comments + string contents to a same-length sanitized buffer.
//   - Find each `namespace { ... }` (anonymous; not `namespace UEMCP { ... }`).
//   - Inside each block, walk depth-tracked and identify function definitions
//     at the block's TOP LEVEL (depth=0). At depth=0 a `{` preceded by `)` +
//     optional cv-qualifiers is a function definition; the identifier just
//     before `(` is the function name.
//   - Aggregate {funcName: [files]}; any name with len > 1 is a violation.
//
// False-positive guards:
//   - Local variables (`FVector V(1, 2, 3);`) — `;` follows `)`, not `{`.
//   - Lambdas (`auto x = [](){};`) — `]` precedes `(`, not an identifier.
//   - Struct/class definitions (`struct Foo { ... };`) — no `)` precedes `{`.
//   - Reserved keywords (if/while/for/switch/...) — explicit reject list.
//
// On collision: error message points users at Public/HandlerCommon.h as the
// architectural pattern for shared helpers (D137 worked example).

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, sep, basename } from 'node:path';

const SERVER_DIR = dirname(fileURLToPath(import.meta.url));
const PRIVATE_DIR = resolve(SERVER_DIR, '..', 'plugin', 'UEMCP', 'Source', 'UEMCP', 'Private');

// ── audit logic (exported for unit tests + reuse) ────────────────────────────

/**
 * Strip `// ...` line comments, `/* ... *​/` block comments, and the interior
 * of "..." / '...' string literals from C++ source. Output is the same length
 * as input (positions stay stable) and preserves newlines so that re-running
 * the result through line counters still matches the original file.
 *
 * Quote characters are retained; only the interior bytes are replaced with
 * spaces. This means downstream regex won't accidentally match keywords
 * inside string literals (e.g., a string containing the text "namespace").
 */
export function stripCommentsAndStrings(src) {
  const out = src.split('');
  let i = 0;
  while (i < out.length) {
    const ch = out[i];
    if (ch === '/' && out[i + 1] === '/') {
      while (i < out.length && out[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (ch === '/' && out[i + 1] === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < out.length - 1 && !(out[i] === '*' && out[i + 1] === '/')) {
        if (out[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < out.length) { out[i] = ' '; i++; }
      if (i < out.length) { out[i] = ' '; i++; }
      continue;
    }
    if (ch === '"' || ch === '\'') {
      const quote = ch;
      i++; // keep opening quote
      while (i < out.length && out[i] !== quote) {
        if (out[i] === '\\' && i + 1 < out.length) {
          out[i] = ' ';
          i++;
          if (out[i] !== '\n') out[i] = ' ';
          i++;
          continue;
        }
        if (out[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < out.length) i++; // consume closing quote
      continue;
    }
    i++;
  }
  return out.join('');
}

/**
 * Find anonymous-namespace blocks in source. Returns array of `[openIdx, closeIdx]`
 * pairs where `openIdx` is the position of the `{` and `closeIdx` is the position
 * of the matching `}`.
 *
 * Matches `\bnamespace\b` (word-bounded) followed by whitespace/newlines and
 * directly `{`. Excludes `namespace UEMCP {` (named), `using namespace ...`,
 * and `inline namespace Foo { }` (named-inline). Includes `inline namespace
 * { }` (anonymous-inline; rare but valid C++).
 *
 * Operates on the comment+string-sanitized buffer so a string literal like
 * `"namespace foo"` can't be mistaken for a real namespace declaration.
 */
export function findAnonNamespaceBlocks(src) {
  const stripped = stripCommentsAndStrings(src);
  const blocks = [];
  const re = /\bnamespace\b/g;
  let m;
  while ((m = re.exec(stripped)) !== null) {
    let j = m.index + 'namespace'.length;
    while (j < stripped.length && /\s/.test(stripped[j])) j++;
    if (stripped[j] !== '{') continue; // named namespace — skip
    const closeIdx = findMatchingBrace(stripped, j);
    if (closeIdx < 0) continue; // unbalanced — skip
    blocks.push([j, closeIdx]);
  }
  return blocks;
}

/** Walk forward from `openIdx` (must point at `{`) to find matching `}`. */
function findMatchingBrace(src, openIdx) {
  let depth = 1;
  let i = openIdx + 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

const ALLOWED_TRAILING_KEYWORDS = ['const', 'noexcept', 'override', 'final', 'mutable'];

const RESERVED_NAMES = new Set([
  'if', 'while', 'for', 'switch', 'do', 'return', 'throw', 'new', 'delete',
  'sizeof', 'typeid', 'alignof', 'alignas', 'constexpr', 'consteval',
  'true', 'false', 'nullptr', 'this',
  'class', 'struct', 'union', 'enum', 'namespace', 'using', 'typedef',
  'template', 'typename', 'operator',
  'try', 'catch', 'static_assert', 'static_cast', 'const_cast', 'dynamic_cast',
  'reinterpret_cast',
]);

/**
 * Within an anon-namespace block (positions `start` inclusive, `end` exclusive
 * — both relative to the original `src` string), find function definitions at
 * the block's top level (depth=0).
 *
 * Walks `src.substring(start, end)` after re-stripping comments/strings (cheap;
 * keeps the exported helper independent of caller's pre-stripping). On each
 * `{` at depth=0, calls `identifyFunctionFromOpenBrace` to look behind for a
 * function signature.
 */
export function findFunctionsInBlock(src, start, end) {
  const stripped = stripCommentsAndStrings(src.substring(start, end));
  const out = [];
  let depth = 0;
  for (let i = 0; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') {
      if (depth === 0) {
        const name = identifyFunctionFromOpenBrace(stripped, i);
        if (name) out.push(name);
      }
      depth++;
    } else if (ch === '}') {
      depth--;
    }
  }
  return out;
}

/**
 * Walk back from position `bracePos` (which points at `{`) to determine if it
 * opens a function body. Function-body opening shape:
 *
 *   `<return-type> <name>(<params>) [const|noexcept|override|final|mutable|&|&&|->Type]* {`
 *
 * Algorithm:
 *   1. Skip whitespace + trailing cv-qualifiers, ref-qualifiers, trailing
 *      return types — anything between `)` and `{`.
 *   2. Expect `)`. If not found, this `{` opens something else (struct/class
 *      definition, initializer list, lambda, etc.) — return null.
 *   3. Walk back paren-balanced to the matching `(`.
 *   4. The identifier just before `(` is the function name.
 *   5. Reject reserved keywords (if/while/for/switch/...) and empty names.
 */
function identifyFunctionFromOpenBrace(src, bracePos) {
  let i = bracePos - 1;
  while (i >= 0 && /\s/.test(src[i])) i--;
  // Strip trailing cv-qualifiers / ref-qualifiers / trailing return type.
  // Loop until we either reach ')' or detect we can't make progress.
  while (i >= 0 && src[i] !== ')') {
    // Try identifier-keyword (const, noexcept, override, final, mutable)
    let kEnd = i + 1;
    let kStart = i;
    while (kStart > 0 && /[A-Za-z_]/.test(src[kStart - 1])) kStart--;
    const word = src.substring(kStart, kEnd);
    if (ALLOWED_TRAILING_KEYWORDS.includes(word)) {
      i = kStart - 1;
      while (i >= 0 && /\s/.test(src[i])) i--;
      continue;
    }
    // Try ref-qualifier `&` / `&&`
    if (src[i] === '&') {
      i--;
      if (i >= 0 && src[i] === '&') i--;
      while (i >= 0 && /\s/.test(src[i])) i--;
      continue;
    }
    // Try simple trailing return type `-> SomeType` (no template chars)
    if (/[A-Za-z0-9_:*&]/.test(src[i])) {
      let typeStart = i;
      while (typeStart > 0 && /[A-Za-z0-9_:*&]/.test(src[typeStart - 1])) typeStart--;
      let p = typeStart - 1;
      while (p >= 0 && /\s/.test(src[p])) p--;
      if (p >= 1 && src[p - 1] === '-' && src[p] === '>') {
        i = p - 2;
        while (i >= 0 && /\s/.test(src[i])) i--;
        continue;
      }
    }
    return null; // Unrecognized — bail
  }
  if (i < 0 || src[i] !== ')') return null;
  // Walk back to matching '('
  let depth = 1;
  i--;
  while (i >= 0 && depth > 0) {
    if (src[i] === ')') depth++;
    else if (src[i] === '(') { depth--; if (depth === 0) break; }
    i--;
  }
  if (depth !== 0) return null;
  // i is at '('; walk back to find identifier
  i--;
  while (i >= 0 && /\s/.test(src[i])) i--;
  if (i < 0) return null;
  // Reject lambdas: '(' immediately preceded by ']' (or `]\s*` ws-stripped above)
  if (src[i] === ']') return null;
  let nameEnd = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(src[i])) i--;
  let nameStart = i + 1;
  if (nameStart >= nameEnd) return null;
  const name = src.substring(nameStart, nameEnd);
  if (RESERVED_NAMES.has(name)) return null;
  return name;
}

/**
 * Audit a directory of Private/*.cpp files. Returns:
 *   {
 *     files:           string[],                     absolute paths, sorted
 *     functionsByFile: Map<string, string[]>,        per-file unique function names
 *     collisions:      Map<string, string[]>,        funcName → sorted basenames
 *   }
 *
 * Reads files synchronously; suitable for both rotation runner and pre-commit
 * hook latency budgets (audit completes in <100ms across the current 27-file
 * Private/ surface — heuristic regex is fast).
 */
export function auditPrivateDir(dir) {
  const files = readdirSync(dir)
    .filter(f => f.endsWith('.cpp'))
    .map(f => join(dir, f))
    .sort();
  const functionsByFile = new Map();
  const nameToFiles = new Map();
  for (const file of files) {
    const src = readFileSync(file, 'utf8');
    const blocks = findAnonNamespaceBlocks(src);
    const allFuncs = [];
    for (const [open, close] of blocks) {
      // findFunctionsInBlock takes positions relative to the original src;
      // open+1 skips past the '{'; close is the position of the matching '}'.
      allFuncs.push(...findFunctionsInBlock(src, open + 1, close));
    }
    const unique = Array.from(new Set(allFuncs)); // dedupe within file
    functionsByFile.set(file, unique);
    for (const fn of unique) {
      if (!nameToFiles.has(fn)) nameToFiles.set(fn, []);
      nameToFiles.get(fn).push(file);
    }
  }
  const collisions = new Map();
  for (const [name, fs] of nameToFiles.entries()) {
    if (fs.length > 1) {
      collisions.set(name, fs.map(f => basename(f)).sort());
    }
  }
  return { files, functionsByFile, collisions };
}

// ── --hook-mode CLI: invoked by .githooks/pre-commit ─────────────────────────

function runHookMode() {
  if (!existsSync(PRIVATE_DIR)) {
    // Defensive: someone running the hook from outside a checkout that has
    // the plugin tree (or while restructuring). Skip rather than block.
    process.exit(0);
  }
  const { collisions } = auditPrivateDir(PRIVATE_DIR);
  if (collisions.size === 0) {
    process.exit(0);
  }
  console.error('');
  console.error('✗ Commit blocked: anonymous-namespace duplicate-symbol collision');
  console.error('');
  for (const [name, fileList] of collisions.entries()) {
    console.error(`  Function "${name}" defined in:`);
    for (const f of fileList) console.error(`    - plugin/UEMCP/Source/UEMCP/Private/${f}`);
  }
  console.error('');
  console.error('  This re-triggers the W-F class (D133/D137): Unity-mode bundling');
  console.error('  fails with multiple-definition linker errors when the same name');
  console.error('  appears in anonymous namespaces across multiple translation units.');
  console.error('');
  console.error('  Fix: extract the shared helper to Public/HandlerCommon.h (or a');
  console.error('  new Public/<feature>.h for larger surface areas), call it via');
  console.error('  UEMCP:: prefix from each consumer file. See D137 worked example.');
  console.error('');
  console.error('  Bypass (rare, intentional): git commit --no-verify');
  console.error('');
  process.exit(1);
}

// Only run the CLI / test block when this file is the main entry point.
// Importing it from another module (e.g., the pre-commit hook spawning a
// shim, or a synthetic-injection harness) must NOT trigger side effects.
const isMain = (() => {
  try {
    const argvUrl = new URL(`file://${process.argv[1].replace(/\\/g, '/')}`).href;
    return import.meta.url === argvUrl;
  } catch {
    return false;
  }
})();

if (isMain && process.argv.includes('--hook-mode')) {
  runHookMode();
}

// ── unit tests (default mode — included in run-rotation.mjs) ─────────────────

if (isMain && !process.argv.includes('--hook-mode')) {
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

  // ── stripCommentsAndStrings: length-preserving sanitization ────────────────
  eq(stripCommentsAndStrings('a // b\nc').length, 'a // b\nc'.length, 'strip preserves length (line comment)');
  eq(stripCommentsAndStrings('a /* b */ c').length, 'a /* b */ c'.length, 'strip preserves length (block comment)');
  eq(stripCommentsAndStrings('"namespace"').includes('namespace'), false, 'strip removes string literal contents');
  ok(stripCommentsAndStrings('// namespace { foo() {} }').indexOf('namespace') === -1, 'line comment hides namespace keyword');

  // ── findAnonNamespaceBlocks: correctly identifies anonymous vs named ───────
  eq(findAnonNamespaceBlocks('namespace { void foo() {} }').length, 1, 'finds one anonymous namespace');
  eq(findAnonNamespaceBlocks('namespace UEMCP { void foo() {} }').length, 0, 'skips named namespace UEMCP');
  eq(findAnonNamespaceBlocks('using namespace std;').length, 0, 'skips using namespace');
  eq(findAnonNamespaceBlocks('namespace UEMCP { namespace { void foo() {} } }').length, 1, 'finds nested anon inside named');
  eq(findAnonNamespaceBlocks('namespace { void a() {} } namespace { void b() {} }').length, 2, 'finds two separate anon blocks');

  // ── findFunctionsInBlock: positive shapes that MUST be detected ────────────
  {
    const src = 'namespace { void Foo() {} TArray<int> Bar(int x) {} }';
    const blocks = findAnonNamespaceBlocks(src);
    const funcs = findFunctionsInBlock(src, blocks[0][0] + 1, blocks[0][1]);
    eq(funcs.sort(), ['Bar', 'Foo'], 'detects two simple function defs');
  }
  {
    const src = 'namespace UEMCP { namespace { void HandleFoo(const TSharedPtr<FJsonObject>& P, TSharedPtr<FJsonObject>& R) { return; } } }';
    const blocks = findAnonNamespaceBlocks(src);
    const funcs = findFunctionsInBlock(src, blocks[0][0] + 1, blocks[0][1]);
    eq(funcs, ['HandleFoo'], 'detects multi-arg function with template params');
  }
  {
    const src = 'namespace { int Foo() const noexcept { return 1; } }';
    const blocks = findAnonNamespaceBlocks(src);
    const funcs = findFunctionsInBlock(src, blocks[0][0] + 1, blocks[0][1]);
    eq(funcs, ['Foo'], 'detects function with trailing cv-qualifiers');
  }

  // ── False-positive guards: shapes that MUST NOT be flagged as functions ────
  {
    // Variable construction at namespace scope: FVector V(1, 2, 3); — has '(' but ';' follows ')'
    const src = 'namespace { FVector V(1, 2, 3); }';
    const blocks = findAnonNamespaceBlocks(src);
    const funcs = findFunctionsInBlock(src, blocks[0][0] + 1, blocks[0][1]);
    eq(funcs, [], 'variable construction NOT flagged');
  }
  {
    // Local var inside function body — function name flagged once, but local "V" must NOT be:
    const src = 'namespace { void Outer() { FVector V(1, 2, 3); FRotator Rot(4, 5, 6); } }';
    const blocks = findAnonNamespaceBlocks(src);
    const funcs = findFunctionsInBlock(src, blocks[0][0] + 1, blocks[0][1]);
    eq(funcs, ['Outer'], 'local-scope variable constructions NOT flagged (Location/Member/Rot/Scale class)');
  }
  {
    // Lambda at namespace scope: auto x = [](){};
    const src = 'namespace { auto Cb = [](){ return 0; }; }';
    const blocks = findAnonNamespaceBlocks(src);
    const funcs = findFunctionsInBlock(src, blocks[0][0] + 1, blocks[0][1]);
    eq(funcs, [], 'lambda NOT flagged as function (preceded by ])');
  }
  {
    // Struct definition inside anon namespace
    const src = 'namespace { struct Foo { int x; }; }';
    const blocks = findAnonNamespaceBlocks(src);
    const funcs = findFunctionsInBlock(src, blocks[0][0] + 1, blocks[0][1]);
    eq(funcs, [], 'struct definition NOT flagged');
  }
  {
    // 'if (cond) {' at function-body scope (depth=1) must not affect depth=0 detection
    const src = 'namespace { void Outer() { if (1) { return; } } }';
    const blocks = findAnonNamespaceBlocks(src);
    const funcs = findFunctionsInBlock(src, blocks[0][0] + 1, blocks[0][1]);
    eq(funcs, ['Outer'], 'if-statement inside function body not affecting top-level detection');
  }

  // ── Synthetic-duplicate detection (the load-bearing assertion) ─────────────
  {
    // Simulate D137-class collision: same function name in two different files'
    // anon namespaces. The audit's caller (auditPrivateDir) builds the collision
    // map across files; we replicate that aggregation here without disk I/O.
    const fileA = 'namespace UEMCP { namespace { void Helper() {} } }';
    const fileB = 'namespace { int Helper(int x) { return x; } }';
    const aBlocks = findAnonNamespaceBlocks(fileA);
    const bBlocks = findAnonNamespaceBlocks(fileB);
    const aFuncs = findFunctionsInBlock(fileA, aBlocks[0][0] + 1, aBlocks[0][1]);
    const bFuncs = findFunctionsInBlock(fileB, bBlocks[0][0] + 1, bBlocks[0][1]);
    const map = new Map();
    for (const f of aFuncs) map.set(f, [...(map.get(f) || []), 'A.cpp']);
    for (const f of bFuncs) map.set(f, [...(map.get(f) || []), 'B.cpp']);
    const collisions = [...map.entries()].filter(([, fs]) => fs.length > 1);
    eq(collisions, [['Helper', ['A.cpp', 'B.cpp']]], 'synthetic duplicate Helper across two files detected');
  }

  // ── Live audit against current HEAD: load-bearing 0-collision invariant ────
  // D137 closed 4 known + 0 latent. If this assertion ever fires, either a
  // NEW collision was introduced post-D137 (W-F regression — investigate the
  // commit) or the heuristic produced a false positive (refine the regex).
  // This test SKIPs gracefully if Private/ is absent (e.g., partial checkout).
  if (existsSync(PRIVATE_DIR)) {
    const { files, collisions } = auditPrivateDir(PRIVATE_DIR);
    ok(files.length >= 20, `Private/ scan found ${files.length} .cpp files (sanity: expected ≥20)`);
    if (collisions.size > 0) {
      console.error('  Collisions detected:');
      for (const [name, fs] of collisions.entries()) {
        console.error(`    ${name}: ${fs.join(', ')}`);
      }
    }
    eq(collisions.size, 0, 'current HEAD has 0 anonymous-namespace collisions (D137 invariant)');
  } else {
    console.log(`  ⊘ skipped (Private/ dir absent): ${PRIVATE_DIR}`);
  }

  // run-rotation.mjs primary format — each on its own line.
  console.log('');
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total: ${passed + failed}`);
  process.exit(failed === 0 ? 0 : 1);
}
