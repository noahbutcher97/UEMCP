// test-verify-deploy.mjs — unit tests for verify-deploy.mjs pure helpers.
// Run: node test-verify-deploy.mjs
//
// Covers the comparison + classification logic that drives the deploy-state
// verdict. Pure functions, no fs/network. Intentionally light — the bat
// wrappers + Node entry point are exercised via live-fire (§6 of handoff).

import {
  parseTargetsFile,
  classifyDeployState,
  formatAge,
  normalizePath,
  extractUprojectFromCommandLine,
} from './verify-deploy.mjs';

let passed = 0, failed = 0;
const eq = (actual, expected, label) => {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { passed++; }
  else { failed++; console.error(`FAIL [${label}]: expected ${e}, got ${a}`); }
};

// ─── parseTargetsFile ───────────────────────────────────────────────
eq(parseTargetsFile(''), [], 'empty file');
eq(parseTargetsFile('# comment only\n'), [], 'comment-only');
eq(parseTargetsFile('  \n\n# c\n  \n'), [], 'whitespace + comments');
eq(
  parseTargetsFile('D:/A/A.uproject\nD:/B/B.uproject\n'),
  ['D:/A/A.uproject', 'D:/B/B.uproject'],
  'two targets',
);
eq(
  parseTargetsFile('# header\nD:/A/A.uproject  # inline comment\n\nD:/B/B.uproject\n'),
  ['D:/A/A.uproject', 'D:/B/B.uproject'],
  'inline comments stripped',
);
eq(
  parseTargetsFile('D:/A/A.uproject\r\nD:/B/B.uproject\r\n'),
  ['D:/A/A.uproject', 'D:/B/B.uproject'],
  'CRLF line endings',
);

// ─── classifyDeployState ────────────────────────────────────────────
const repoSrc = 1000000;
const newer = repoSrc + 100, older = repoSrc - 100;

eq(
  classifyDeployState({ pluginDirExists: false, deployedSrcMtime: 0, deployedSrcFileCount: 0, dllExists: false, dllMtime: 0, repoSrcMtime: repoSrc }).verdict,
  'MISSING',
  'plugin dir absent',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: 0, deployedSrcFileCount: 0, dllExists: false, dllMtime: 0, repoSrcMtime: repoSrc }).verdict,
  'MISSING-PARTIAL',
  'plugin dir empty source',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: newer, deployedSrcFileCount: 5, dllExists: false, dllMtime: 0, repoSrcMtime: repoSrc }).verdict,
  'NEEDS-BUILD',
  'source synced, DLL missing',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: older, deployedSrcFileCount: 5, dllExists: false, dllMtime: 0, repoSrcMtime: repoSrc }).verdict,
  'NEEDS-DEPLOY',
  'source stale + DLL missing',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: older, deployedSrcFileCount: 5, dllExists: true, dllMtime: older, repoSrcMtime: repoSrc }).verdict,
  'NEEDS-DEPLOY',
  'both stale (D135 failure mode)',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: older, deployedSrcFileCount: 5, dllExists: true, dllMtime: newer, repoSrcMtime: repoSrc }).verdict,
  'NEEDS-SYNC',
  'source stale, DLL fresh (rare; user built without sync)',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: newer, deployedSrcFileCount: 5, dllExists: true, dllMtime: older, repoSrcMtime: repoSrc }).verdict,
  'NEEDS-BUILD',
  'source synced but DLL behind source — Build needed (sync ran, build did not)',
);
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: newer, deployedSrcFileCount: 5, dllExists: true, dllMtime: newer, repoSrcMtime: repoSrc }).verdict,
  'SYNC',
  'all fresh',
);
// Slop tolerance: deployedSrc 4 sec older than repoSrc should still be SYNC (within MTIME_SLOP_SEC=5)
eq(
  classifyDeployState({ pluginDirExists: true, deployedSrcMtime: repoSrc - 4, deployedSrcFileCount: 5, dllExists: true, dllMtime: repoSrc - 4, repoSrcMtime: repoSrc }).verdict,
  'SYNC',
  'within mtime slop tolerance',
);

// ─── formatAge ──────────────────────────────────────────────────────
eq(formatAge(0), '0s', 'zero seconds');
eq(formatAge(45), '45s', 'sub-minute');
eq(formatAge(125), '2m 5s', 'minutes');
eq(formatAge(3700), '1h 1m', 'hours');
eq(formatAge(90000), '1d 1h', 'days');
eq(formatAge(-30), '(30s ahead)', 'negative (DLL ahead of source)');

// ─── normalizePath (case-insensitive Windows path equality) ────────
eq(
  normalizePath('D:\\Foo\\Bar.uproject'),
  normalizePath('d:/foo/bar.uproject'),
  'backslash + case + slash equivalence',
);
eq(
  normalizePath('D:/Foo/Bar/'),
  normalizePath('D:/Foo/Bar'),
  'trailing slash stripped',
);

// ─── extractUprojectFromCommandLine ─────────────────────────────────
eq(
  extractUprojectFromCommandLine('"C:\\Program Files\\Epic Games\\UE_5.6\\Engine\\Binaries\\Win64\\UnrealEditor.exe" "D:\\Projects\\Foo\\Foo.uproject"'),
  'D:\\Projects\\Foo\\Foo.uproject',
  'quoted CommandLine',
);
eq(
  extractUprojectFromCommandLine('UnrealEditor.exe D:\\Projects\\Foo\\Foo.uproject -skipcompile'),
  'D:\\Projects\\Foo\\Foo.uproject',
  'unquoted CommandLine',
);
eq(
  extractUprojectFromCommandLine('UnrealEditor.exe -nothing-here'),
  null,
  'no .uproject token',
);
eq(extractUprojectFromCommandLine(null), null, 'null input');
eq(extractUprojectFromCommandLine(''), null, 'empty input');

// run-rotation.mjs primary format — each on its own line so it can be parsed
// from stdout per the regex at run-rotation.mjs:93-95.
console.log('');
console.log(`Passed: ${passed}`);
console.log(`Failed: ${failed}`);
console.log(`Total: ${passed + failed}`);
process.exit(failed === 0 ? 0 : 1);
